'use strict'
/**
 * 运行时管理：把 `@deepseek-ai/dsh` 装进 `~/.dshdesktop/runtime`，
 * 提供「安装 / 查最新 / 更新 / 运行时完整性 / Node 可用性检查」能力。
 *
 * 不依赖 Electron，可用纯 Node 单独单测。
 *
 * 关键约定：桌面程序以 npm registry（官方发布源）为默认源；官方源不可达或
 * 超时时自动回退到 npmmirror 镜像源，避免国内网络下安装/查版本无限卡死。
 * 与本地的 git clone 无关——「跟随最新版」就是向 npm 服务器查版本、下载包。
 */
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const https = require('node:https')
const { spawn, spawnSync } = require('node:child_process')
const semver = require('semver')

/** 桌面程序自己的运行时/数据根目录。 */
const BASE_DIR = path.join(os.homedir(), '.dshdesktop')
/** 旧版本（DSH-Desktop 时期）使用的数据根目录，仅用于一次性迁移。 */
const LEGACY_BASE_DIR = path.join(os.homedir(), '.dsh-desktop')
/** @deepseek-ai/dsh 的安装目录（npm 的 cwd）。 */
const RUNTIME_DIR = path.join(BASE_DIR, 'runtime')
/** 记录已装版本的元数据文件。 */
const VERSION_FILE = path.join(BASE_DIR, 'version.json')
/** npm 上的官方发布包。 */
const PKG_NAME = '@deepseek-ai/dsh'
/** 官方源不可达或超时后回退的镜像源（国内网络通常更快）。 */
const REGISTRY_MIRROR = 'https://registry.npmmirror.com/'
/** 第二备用镜像源（腾讯云）。 */
const REGISTRY_MIRROR_ALT = 'https://mirrors.cloud.tencent.com/npm/'
/** 单次 npm 安装尝试的硬超时：网络卡死时不再无限等待（有实时进度时足够宽裕）。 */
const NPM_INSTALL_TIMEOUT_MS = 600000
/** 单次 npm view 查询的硬超时（元数据请求应很快完成）。 */
const NPM_VIEW_TIMEOUT_MS = 60000
/** npm view 的每次网络请求超时：慢而可达的源不应让检查卡满硬超时。 */
const NPM_VIEW_FETCH_TIMEOUT_MS = 20000
/** npm view 的网络重试次数：直接失败换下一个源更划算。 */
const NPM_VIEW_FETCH_RETRIES = 0
/** npm 超时后等待进程树彻底退出的最长时间。 */
const PROCESS_EXIT_TIMEOUT_MS = 10000

/**
 * 一次性迁移旧数据目录（更名前为 `~/.dsh-desktop`）到当前 BASE_DIR：
 * 让既有用户保留本地运行时、偏好与日志，而不是重新下载。
 * 任何失败（句柄占用/权限等）都不抛出，调用方降级为全新目录即可。
 * 返回：'moved' | 'already-moved' | 'no-legacy' | 'failed'
 */
function migrateLegacyBaseDir({ targetDir = BASE_DIR, legacyDir = LEGACY_BASE_DIR } = {}) {
  try {
    if (fs.existsSync(targetDir)) return 'already-moved'
    if (!fs.existsSync(legacyDir)) return 'no-legacy'
    fs.renameSync(legacyDir, targetDir)
    return 'moved'
  } catch {
    return 'failed'
  }
}
/** npm 命令名：Windows 下由 run() 用 cmd.exe /c 解析 PATHEXT，这里统一用 `npm`。 */
function npmCommand() {
  return 'npm'
}

let cachedNpmCliPath

/**
 * Windows 的 npm 是 .cmd，不能作为普通可执行文件直接 spawn。这里定位它背后的
 * npm-cli.js，再交给系统 Node 执行，从根源上避免 cmd.exe 重新解析参数。
 */
function npmCliPath(override) {
  if (override) return override
  if (cachedNpmCliPath !== undefined) return cachedNpmCliPath
  const candidates = []
  if (process.env.npm_execpath) candidates.push(process.env.npm_execpath)
  candidates.push(path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  if (process.platform === 'win32') {
    try {
      const found = spawnSync('where.exe', ['npm.cmd'], { encoding: 'utf8', windowsHide: true })
      if (found.status === 0) {
        for (const commandPath of String(found.stdout || '').split(/\r?\n/).filter(Boolean)) {
          candidates.push(path.join(path.dirname(commandPath.trim()), 'node_modules', 'npm', 'bin', 'npm-cli.js'))
        }
      }
    } catch {}
  }
  cachedNpmCliPath = candidates.find((candidate) => {
    try { return fs.statSync(candidate).isFile() } catch { return false }
  }) ?? null
  return cachedNpmCliPath
}

/**
 * 跑一条命令，返回 `{ ok, code, out, err, error }`。
 * 用 spawn 管道拼接而非 exec，避免 npm install 输出超过默认 maxBuffer。
 * Windows 下把 npm-cli.js 交给系统 Node 执行，所有参数仍通过 argv 数组传递，
 * peer range 中的 `||`、`^` 等字符不会被 cmd.exe 当成控制符。
 */
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let child
    let timer = null
    let terminationTimer = null
    let settled = false
    let timedOut = false
    try {
      let executable = cmd
      let executableArgs = args
      if (opts.npmCliPath || (process.platform === 'win32' && cmd === npmCommand())) {
        const cliPath = npmCliPath(opts.npmCliPath)
        if (!cliPath) return resolve({ ok: false, error: new Error('找不到 npm-cli.js，请确认系统 PATH 中的 npm 安装完整') })
        executable = 'node'
        executableArgs = [cliPath, ...args]
      }
      child = spawn(executable, executableArgs, {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (e) {
      return resolve({ ok: false, error: e })
    }
    activeChildren.add(child.pid)
    child.once('close', () => activeChildren.delete(child.pid))
    child.once('error', () => activeChildren.delete(child.pid))
    const settle = (result) => {
      if (settled) return
      settled = true
      if (timer) { clearTimeout(timer); timer = null }
      if (terminationTimer) { clearTimeout(terminationTimer); terminationTimer = null }
      resolve(result)
    }
    const timeoutResult = (terminationUnconfirmed = false) => ({
      ok: false,
      code: null,
      out,
      err: `${err}\n[超时] 命令超过 ${opts.timeoutMs}ms 未完成，已终止${terminationUnconfirmed ? '（未确认进程完全退出）' : ''}`.trim(),
      error: new Error(`命令超时（${opts.timeoutMs}ms）`),
      timedOut: true,
      terminationUnconfirmed,
    })
    if (opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timer = null
        timedOut = true
        killTree(child.pid).catch(() => false)
        // 正常路径由 child close 确认退出；超过兜底时间仍无 close 时明确标记，
        // 调用方必须停止切源，避免两个 npm 同时写同一个 runtime。
        terminationTimer = setTimeout(() => settle(timeoutResult(true)), PROCESS_EXIT_TIMEOUT_MS)
      }, opts.timeoutMs)
    }
    const onData = typeof opts.onData === 'function' ? opts.onData : null
    child.stdout.on('data', (d) => { const s = String(d); out += s; if (onData) onData(s) })
    child.stderr.on('data', (d) => { const s = String(d); err += s; if (onData) onData(s) })
    child.on('error', (e) => settle(timedOut ? timeoutResult() : { ok: false, error: e }))
    child.on('close', (code) => settle(timedOut ? timeoutResult() : { ok: code === 0, code, out, err }))
  })
}

/** 终止命令及其子进程树（Windows 用 taskkill /T，避免孤儿 node 进程继续跑）。 */
function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(false)
  if (process.platform !== 'win32') {
    try { process.kill(pid, 'SIGTERM') } catch { return Promise.resolve(false) }
    setTimeout(() => { try { process.kill(pid, 'SIGKILL') } catch {} }, 2000).unref()
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    let killer
    try {
      killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
    } catch {
      resolve(false)
      return
    }
    killer.once('error', () => resolve(false))
    killer.once('close', (code) => resolve(code === 0))
  })
}

/** 仍在运行的子进程 PID（应用退出时用于清理，避免孤儿 npm 继续写 node_modules）。 */
const activeChildren = new Set()

/** 终止所有仍在运行的子进程树（应用退出前调用）。 */
function killActiveChildren() {
  for (const pid of Array.from(activeChildren)) killTree(pid).catch(() => false)
  activeChildren.clear()
}

/** 源的可读名称，用于日志与错误提示。 */
function sourceName(attempt) {
  return attempt.registry ? attempt.registry : 'npm 配置源'
}

/** 去掉 registry URL 尾部斜杠，供探测与去重比较统一使用。 */
function stripTrailingSlash(url) {
  return url.replace(/\/+$/, '')
}

/**
 * 快速探测一个 registry 是否可达：GET <registry>/-/ping，默认 5 秒超时。
 * 任何 HTTP 响应（含 404）都视为可达；网络错误/超时视为不可达。
 * 按 URL 协议选择 http/https：内网私有 registry 常用 http://（无 TLS），
 * 不能用 https.get 请求 http URL，否则会被误判为不可达。
 */
function probeRegistry(registryUrl, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let finished = false
    const finish = (ok) => { if (!finished) { finished = true; resolve(ok) } }
    let req
    try {
      let protocol = 'https:'
      try { protocol = new URL(registryUrl).protocol } catch {}
      if (protocol !== 'https:' && protocol !== 'http:') return finish(false)
      const mod = protocol === 'http:' ? http : https
      req = mod.get(`${stripTrailingSlash(registryUrl)}/-/ping`, { timeout: timeoutMs }, (res) => {
        res.resume() // 读空响应体，释放连接
        finish(true)
      })
    } catch {
      return finish(false)
    }
    req.on('timeout', () => { req.destroy(); finish(false) })
    req.on('error', () => finish(false))
  })
}

/** 把一个 run 结果转成可读的错误信息。 */
function errMsg(res) {
  if (res.error) return res.error.message ?? String(res.error)
  if (res.err && res.err.trim()) return res.err.trim().slice(-2000)
  return `命令退出码 ${res.code}`
}

/**
 * 判断 npm 失败是否为「元数据里找不到目标版本」（ETARGET / notarget / 404 no match，
 * 或 ERESOLVE 树中节点版本为 @undefined——后者是包元数据里没有匹配版本的典型形态，
 * 真实版本冲突会报告具体版本号，如 Found: react@18.3.1）。
 * 这类错误未必代表版本真的不存在：本地缓存或 registry CDN 边缘可能存着旧
 * packument（例如上次安装 0.1.0-rc.8 时缓存的依赖树），会把刚发布的新版本误报为
 * notarget。调用方应强制重新校验元数据后再判断。
 */
function isNotFoundError(res) {
  if (!res || res.ok) return false
  const text = `${res.err ?? ''}\n${res.error?.message ?? ''}`
  if (/notarget|no matching version found|no match found for version/i.test(text)) return true
  return /unable to resolve dependency tree/i.test(text) && /@undefined/i.test(text)
}

/** 旧 npm 进程未确认退出时，停止切换安装源以保护运行时目录。 */
function stopForUnconfirmedExit(lastErr) {
  return { ok: false, err: `${lastErr}\n未确认旧 npm 进程已退出，已停止切换安装源以保护运行时目录。` }
}

/** 确保运行时目录存在（npm install 的 cwd）。 */
function ensureRuntimeDir(runtimeDir = RUNTIME_DIR) {
  fs.mkdirSync(runtimeDir, { recursive: true })
}

/**
 * runtime 是桌面端独占管理目录，根依赖只保留当前精确版本 DSH。
 * peer 修复统一使用 --no-save，避免旧 peer 约束污染下一次升级。
 */
function writeManagedRuntimeManifest(runtimeDir, version) {
  fs.writeFileSync(path.join(runtimeDir, 'package.json'), JSON.stringify({
    private: true,
    type: 'module',
    description: 'DSH Desktop 管理的运行时，请勿手动修改',
    dependencies: {
      [PKG_NAME]: version,
    },
  }, null, 2) + '\n')
}

/** 当前已安装的 @deepseek-ai/dsh 版本，未安装返回 null。 */
function installedVersion(runtimeDir = RUNTIME_DIR) {
  try {
    const p = path.join(runtimeDir, 'node_modules', ...PKG_NAME.split('/'), 'package.json')
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    return typeof j.version === 'string' ? j.version : null
  } catch {
    return null
  }
}

/** 当前安装的 dsh 入口 bin 路径。 */
function binPath(runtimeDir = RUNTIME_DIR) {
  return path.join(runtimeDir, 'node_modules', ...PKG_NAME.split('/'), 'lib', 'bin.js')
}

/** 枚举 node_modules 中的包目录，同时覆盖包内嵌套的 node_modules。 */
function packageDirs(nodeModulesDir) {
  const result = []
  let entries
  try { entries = fs.readdirSync(nodeModulesDir, { withFileTypes: true }) } catch { return result }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const entryPath = path.join(nodeModulesDir, entry.name)
    if (entry.name.startsWith('@')) {
      let scopedEntries
      try { scopedEntries = fs.readdirSync(entryPath, { withFileTypes: true }) } catch { continue }
      for (const scopedEntry of scopedEntries) {
        if (!scopedEntry.isDirectory()) continue
        const packageDir = path.join(entryPath, scopedEntry.name)
        result.push(packageDir, ...packageDirs(path.join(packageDir, 'node_modules')))
      }
      continue
    }
    result.push(entryPath, ...packageDirs(path.join(entryPath, 'node_modules')))
  }
  return result
}

/** 按 Node 的向上查找规则读取声明包可见的 peer package 版本。 */
function peerPackageVersion(packageName, packageDir, runtimeDir) {
  const packageParts = packageName.split('/')
  const boundary = path.resolve(runtimeDir)
  let current = path.resolve(packageDir)
  while (true) {
    const relative = path.relative(boundary, current)
    if (relative.startsWith('..') || path.isAbsolute(relative)) break
    try {
      const manifestPath = path.join(current, 'node_modules', ...packageParts, 'package.json')
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      return typeof manifest.version === 'string' ? manifest.version : null
    } catch {}
    if (current === boundary) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

const SEMVER_OPTIONS = { includePrerelease: true }

/** 把同一个 peer 的多个 SemVer 范围合并成 npm 可接受的交集；无交集返回 null。 */
function combinedPeerRange(ranges) {
  const unique = Array.from(new Set(ranges))
  if (unique.length === 0) return null
  try {
    for (const range of unique) new semver.Range(range, SEMVER_OPTIONS)
  } catch {
    return null
  }
  if (unique.length === 1) return unique[0]

  let clauses = ['']
  for (const range of unique) {
    const parsed = new semver.Range(range, SEMVER_OPTIONS)
    const next = new Set()
    for (const existing of clauses) {
      for (const comparatorSet of parsed.set) {
        const appended = comparatorSet.map((comparator) => comparator.value).filter(Boolean).join(' ')
        const combined = `${existing} ${appended}`.trim() || '*'
        if (semver.minVersion(combined, SEMVER_OPTIONS)) {
          next.add(new semver.Range(combined, SEMVER_OPTIONS).range || '*')
        }
        // 防止异常 manifest 制造巨大的 OR 笛卡尔积，冲突会作为安装错误呈现。
        if (next.size >= 128) break
      }
      if (next.size >= 128) break
    }
    clauses = Array.from(next)
    if (clauses.length === 0) return null
  }
  return clauses.join(' || ')
}

/**
 * 纯前端/打包期的 peer 名单：这些包只在浏览器里渲染，或在打包时被烧进前端
 * bundle，Node 后端进程不会 require 它们。第一阶段 --legacy-peer-deps 已跳过
 * 整棵依赖树，第二阶段若再去严格补装这些 peer，反而会撞上它们之间不一致的
 * peer 范围（如 use-sync-external-store 尚未声明 react 19 支持，把 react 限制
 * 在 <19，而 @tanstack/react-virtual 又允许 react-dom 到 19，npm 无法同时满足）。
 *
 * zustand 虽然也声明 react peer，但它把 react/@types/react/immer 都标成 optional，
 * 不会进入必需 peer 补装，故无需列入。
 */
const FRONTEND_ONLY_PEERS = new Set(['react', 'react-dom'])

/** 判断 peer 是否属于纯前端/打包期（含 @types/* 类型包），后端运行时无需安装。 */
function isFrontendOnlyPeer(name) {
  if (FRONTEND_ONLY_PEERS.has(name)) return true
  if (name.startsWith('@types/')) return true
  return false
}

/**
 * 找出缺失、版本不满足或范围冲突的必需 peer dependency。
 * `--legacy-peer-deps` 会跳过所有 peer，必须在安装后显式补齐并验证；optional peer 不处理。
 */
function missingRequiredPeers(runtimeDir = RUNTIME_DIR) {
  const requirements = new Map()
  for (const packageDir of packageDirs(path.join(runtimeDir, 'node_modules'))) {
    let manifest
    try { manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')) } catch { continue }
    for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
      if (manifest.peerDependenciesMeta?.[name]?.optional === true) continue
      if (isFrontendOnlyPeer(name)) continue
      const normalizedRange = typeof range === 'string' && range.trim() ? range.trim() : '*'
      const list = requirements.get(name) ?? []
      list.push({
        range: normalizedRange,
        requiredBy: typeof manifest.name === 'string' ? manifest.name : path.basename(packageDir),
        packageDir,
      })
      requirements.set(name, list)
    }
  }

  const missing = []
  for (const [name, peers] of requirements) {
    const unsatisfied = peers.filter((peer) => {
      const version = peerPackageVersion(name, peer.packageDir, runtimeDir)
      try {
        return !semver.valid(version) || !semver.satisfies(version, peer.range, SEMVER_OPTIONS)
      } catch {
        return true
      }
    })
    if (unsatisfied.length === 0) continue
    const range = combinedPeerRange(peers.map((peer) => peer.range))
    const hasInvalidRange = peers.some((peer) => !semver.validRange(peer.range, SEMVER_OPTIONS))
    const entry = {
      name,
      range,
      requiredBy: Array.from(new Set(peers.map((peer) => peer.requiredBy))).join('、'),
    }
    if (hasInvalidRange) entry.invalidRange = true
    else if (!range) {
      // 让 npm 在补装阶段尝试联合解析整个 peer 图；完成后仍会再次严格校验。
      entry.conflict = true
      entry.installRange = peers[0].range
    }
    missing.push(entry)
  }
  return missing.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 检查运行时是否完整可用。仅有 package.json 不足以证明安装成功，
 * 入口文件或必需 peer dependency 缺失时必须重新安装，避免启动重试一直
 * 命中同一个损坏目录。
 */
function runtimeStatus(runtimeDir = RUNTIME_DIR) {
  const version = installedVersion(runtimeDir)
  let hasBin = false
  try { hasBin = fs.statSync(binPath(runtimeDir)).isFile() } catch { hasBin = false }
  const missingPeers = hasBin ? missingRequiredPeers(runtimeDir) : []
  return {
    version,
    usable: Boolean(parseVersion(version) && hasBin && missingPeers.length === 0),
    hasBin,
    missingPeers,
  }
}

function writeVersionFile(data, versionFile = VERSION_FILE) {
  fs.mkdirSync(path.dirname(versionFile), { recursive: true })
  fs.writeFileSync(versionFile, JSON.stringify(data, null, 2) + '\n')
}

/** 把显式传入的 registry 列表映射成尝试项；未传时返回空数组。 */
function registryAttempts(options = {}) {
  return (options.registries ?? []).map((r) => ({ registry: r || null }))
}

/**
 * 决定按序尝试的 npm 源：先用 `npm config get registry` 解析用户配置的源，
 * 再补上镜像源，然后并行快速探测可达性，只保留可达源并保持优先级顺序。
 * 全部不可达（离线）时保留原列表，让 npm 给出真实错误；避免在不可达的
 * 官方源上白白等满超时。options 可注入 runner/probe 便于纯 Node 测试。
 */
async function pickRegistries(options = {}) {
  const runner = options.runner ?? run
  const probe = options.probe ?? probeRegistry
  let attempts = registryAttempts(options)
  if (attempts.length === 0) {
    const cfg = await runner(npmCommand(), ['config', 'get', 'registry'], { timeoutMs: 10000 })
    const userRegistry = cfg.ok ? String(cfg.out || '').trim() : null
    if (userRegistry && ![REGISTRY_MIRROR, REGISTRY_MIRROR_ALT].some((m) => stripTrailingSlash(userRegistry) === stripTrailingSlash(m))) {
      attempts.push({ registry: userRegistry })
    }
    attempts.push({ registry: REGISTRY_MIRROR }, { registry: REGISTRY_MIRROR_ALT })
  }
  if (options.noProbe === true) return attempts
  const probed = await Promise.all(attempts.map(async (a) => ({
    registry: a.registry,
    alive: a.registry ? await probe(a.registry) : true,
  })))
  const alive = probed.filter((p) => p.alive).map(({ registry }) => ({ registry }))
  if (alive.length === 0) return attempts // 全部探测失败：保持原顺序，让 npm 报错
  return alive
}

/**
 * peer 补装阶段：循环补齐当前缺失的必需 peer，直至全部满足或无法再推进。
 * 返回 `{ ok, status, err, terminal, unconfirmedExit }`：
 * - ok=true：missingPeers 已清零，status 即最终状态；
 * - unconfirmedExit=true：npm 未确认退出，调用方必须停止切源保护运行时目录；
 * - terminal=true：与 registry 无关的确定性错误（版本范围无效），换源重试没有意义；
 * - 其余 { ok:false, err }：瞬时性错误（npm 失败或换源仍缺），调用方可换源仅重试 peer 补装。
 * attemptedPeers 每次调用独立：换源后允许对同一 peer 重新尝试。
 */
async function fixMissingPeers(initialStatus, { runtimeDir, log, onProgress, registry, commonArgs, runInstallAttempt }) {
  let status = initialStatus
  const attemptedPeers = new Set()
  while (status.missingPeers.length > 0) {
    const pendingPeers = status.missingPeers.filter((peer) => !attemptedPeers.has(peer.name))
    if (pendingPeers.length === 0) {
      // 补装命令本身成功了，但校验仍说缺失：多为镜像版本集滞后导致范围不满足，换源可解
      const err = `npm 已完成，但仍缺少必需依赖：${status.missingPeers.map((peer) => peer.name).join('、')}`
      log(`[install] peer dependency 修复失败：${err}`)
      return { ok: false, status, err }
    }
    const invalidPeers = pendingPeers.filter((peer) => peer.invalidRange || (!peer.range && !peer.installRange))
    if (invalidPeers.length > 0) {
      const err = `必需 peer dependency 的版本范围无效：${invalidPeers.map((peer) => `${peer.name}（${peer.requiredBy}）`).join('、')}`
      log(`[install] peer dependency 范围校验失败：${err}`)
      return { ok: false, status, err, terminal: true }
    }
    for (const peer of pendingPeers) attemptedPeers.add(peer.name)
    const peerSpecs = pendingPeers.map((peer) => `${peer.name}@${peer.range ?? peer.installRange}`)
    log(`[install] 正在补装 ${pendingPeers.length} 个必需 peer dependency：${pendingPeers.map((peer) => peer.name).join('、')}`)
    // peer 阶段不使用 legacy，让 npm 在较小的显式集合内选择互相兼容的版本；
    // --no-save 避免把临时修复包固化为根依赖，影响后续更新。
    const peerArgs = ['install', ...peerSpecs, ...commonArgs, '--no-save']
    if (registry) peerArgs.push('--registry', registry)
    const peerResult = await runInstallAttempt(peerArgs, {
      cwd: runtimeDir,
      timeoutMs: NPM_INSTALL_TIMEOUT_MS,
      onData: onProgress,
    })
    if (!peerResult.ok) {
      const err = errMsg(peerResult)
      log(`[install] peer dependency 补装失败：${err}`)
      return {
        ok: false,
        status,
        err,
        unconfirmedExit: peerResult.terminationUnconfirmed === true,
      }
    }
    status = runtimeStatus(runtimeDir)
  }
  return { ok: true, status, err: '' }
}

/**
 * 安装指定版本（缺省 latest）。先探测可达源并按序尝试，每个源一次
 * npm install 尝试、带硬超时；全部失败返回最后一个错误。
 * 成功后记录已装版本。options 仅用于纯 Node 测试注入临时目录/版本文件/runner。
 */
async function installVersion(version, options = {}) {
  const runtimeDir = options.runtimeDir ?? RUNTIME_DIR
  const versionFile = options.versionFile ?? VERSION_FILE
  const runner = options.runner ?? run
  const log = typeof options.log === 'function' ? options.log : () => {}
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null
  ensureRuntimeDir(runtimeDir)
  const target = version || 'latest'
  if (target !== 'latest' && !parseVersion(target)) return { ok: false, err: `无效的 DSH 版本：${target}` }
  // 先清理旧版 peer 修复可能保存到根 manifest 的依赖；若本次安装失败，仍保留
  // 当前已安装 DSH 的精确版本，离线启动不会被目标版本污染。
  const currentVersion = installedVersion(runtimeDir)
  writeManagedRuntimeManifest(runtimeDir, parseVersion(currentVersion) ? currentVersion : target)
  if (options.force === true) {
    // 修复模式：npm 对「包目录在但其中文件缺失」的损坏会报 up to date 而不恢复文件
    //（实测：npm install <pkg>@同版本 --force 不重新解包），必须先删掉目标包目录，
    // 强制 npm 重新解包后再走完整性校验与 peer 补齐。
    try {
      fs.rmSync(path.join(runtimeDir, 'node_modules', ...PKG_NAME.split('/')), { recursive: true, force: true })
      log('[install] 修复模式：已清理损坏的 DSH 包目录，准备重新解包')
    } catch (err) {
      log(`[install] 修复模式：清理损坏包目录失败（继续安装）：${err.message}`)
    }
  }
  const spec = `${PKG_NAME}@${target}`
  const attempts = await pickRegistries(options)
  log(`[install] 目标 ${spec}，将按序尝试：${attempts.map(sourceName).join(' → ')}`)
  let lastErr = ''
  const commonArgs = [
    '--no-audit', '--no-fund', '--prefer-offline', '--loglevel=http',
    // 网络黑洞（大文件传输卡死）时快速失败并换下一个源，而不是无限等
    '--fetch-timeout=90000', '--fetch-retries=1',
  ]
  /**
   * 跑一次 npm install 并处理「版本不存在」：`--prefer-offline` 会绕过元数据
   * 新鲜度校验，本地缓存若存着旧 packument（上次安装 0.1.0-rc.8 时缓存的
   * 依赖树），会把刚发布的新版本误报为 notarget。命中此类错误时改用
   * `--prefer-online` 强制向同一源重新校验元数据再试一次；缓存导致的问题
   * 会在这一跳自愈，真正不存在的版本才会进入下一个源的尝试。
   */
  const runInstallAttempt = async (args, runOpts) => {
    const first = await runner(npmCommand(), args, runOpts)
    if (first.ok || !isNotFoundError(first)) return first
    log('[install] 元数据缓存过期导致"版本不存在"，强制重新校验后重试…')
    return runner(npmCommand(), args.map((a) => (a === '--prefer-offline' ? '--prefer-online' : a)), runOpts)
  }
  // 主包安装成功后不再因 peer 补装失败而换源重装主包：
  // 确定性错误（范围无效）立即返回，瞬时错误仅由后续源重试 peer 补装。
  let mainInstalled = false
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i]
    let status
    if (!mainInstalled) {
      const args = [
        'install', spec,
        ...commonArgs,
        // 主包的大依赖树必须跳过 peer 自动解析，避免 npm 11 卡在 idealTree；
        // 缺失 peer 会在下一阶段用一个规模更小的正常解析单独补齐。
        '--legacy-peer-deps',
      ]
      if (options.force === true) args.push('--force')
      if (attempt.registry) args.push('--registry', attempt.registry)
      log(`[install] 正在从 ${sourceName(attempt)} 安装…`)
      const res = await runInstallAttempt(args, {
        cwd: runtimeDir,
        timeoutMs: NPM_INSTALL_TIMEOUT_MS,
        onData: onProgress,
      })
      if (!res.ok) {
        lastErr = errMsg(res)
        log(`[install] 源 ${sourceName(attempt)} 失败：${lastErr}`)
        if (res.terminationUnconfirmed) {
          return stopForUnconfirmedExit(lastErr)
        }
        continue
      }
      status = runtimeStatus(runtimeDir)
      if (!parseVersion(status.version) || !status.hasBin) {
        log('[install] 完整性校验失败')
        return { ok: false, err: `npm 安装完成，但 DSH 运行时完整性校验失败：${binPath(runtimeDir)}` }
      }
      writeManagedRuntimeManifest(runtimeDir, status.version)
      mainInstalled = true
    } else {
      // 上一源主包已装好，只是 peer 补装瞬时失败：换源后只补 peer，不再重装主包
      status = runtimeStatus(runtimeDir)
    }
    const fix = await fixMissingPeers(status, {
      runtimeDir,
      log,
      onProgress,
      registry: attempt.registry,
      commonArgs,
      runInstallAttempt,
    })
    if (!fix.ok) {
      lastErr = fix.err
      if (fix.unconfirmedExit) return stopForUnconfirmedExit(lastErr)
      if (fix.terminal) {
        // 版本范围无效等与源无关的确定性错误：换源重试没有意义，立即返回真实原因
        return { ok: false, err: lastErr }
      }
      if (i === attempts.length - 1) break
      log(`[install] 源 ${sourceName(attempt)} peer 补装失败，下一源仅重试 peer 补装`)
      continue
    }
    if (!fix.status.usable) {
      lastErr = `npm 已完成，但运行时仍不可用：${fix.status.missingPeers.map((peer) => peer.name).join('、')}`
      return { ok: false, err: lastErr }
    }
    const newVer = fix.status.version
    if (newVer) {
      writeVersionFile({ installed: newVer }, versionFile)
    }
    log(`[install] 从 ${sourceName(attempt)} 安装成功：${newVer}`)
    return { ok: true, version: newVer }
  }
  log('[install] 所有源均失败')
  const names = attempts.map(sourceName).join('、')
  return { ok: false, err: `安装失败（已尝试 ${attempts.length} 个源：${names}）。${lastErr}` }
}

/**
 * 确保运行时可用：完整安装直接复用；入口缺失时修复当前精确版本；
 * 无法识别已装版本时安装 latest。options 仅用于纯 Node 测试注入临时目录与安装器。
 */
async function ensureRuntime(options = {}) {
  const runtimeDir = options.runtimeDir ?? RUNTIME_DIR
  const installer = options.installer ?? installVersion
  const status = runtimeStatus(runtimeDir)
  if (status.usable) return { ok: true, version: status.version, repaired: false }
  const target = parseVersion(status.version) ? status.version : 'latest'
  // 必须把 runtimeDir/versionFile/log 透传给 installer：否则纯 Node 测试注入的
  // 临时目录会被忽略（修复会打到真实运行时目录），真实安装日志也会丢失。
  const result = await installer(target, {
    force: target !== 'latest',
    runtimeDir,
    versionFile: options.versionFile,
    log: options.log,
  })
  return { ...result, repaired: target !== 'latest' }
}

/**
 * 向 npm registry 查 @deepseek-ai/dsh 的最新可用版本；所有源都失败（离线等）
 * 返回 null。先探测可达源，官方源超时/失败时自动回退镜像源。
 *
 * 官方把预发布版挂在 `next` 标签（如 0.1.0-rc.8），而 `latest` 标签可能停留在
 * 更旧的版本，只看 `latest` 会漏掉新预发布版；这里同时读取两个标签取较大者，
 * 与「跟随预览版最新」的意图一致。
 */
async function latestVersion(options = {}) {
  const runner = options.runner ?? run
  const log = typeof options.log === 'function' ? options.log : () => {}
  const attempts = await pickRegistries(options)
  for (const attempt of attempts) {
    log(`[view] 正在从 ${sourceName(attempt)} 查询最新版本…`)
    const args = [
      'view', PKG_NAME, 'dist-tags', '--json',
      // 与 install 一致地限制网络行为：慢而可达的源最多等这次超时，直接换下一个源
      `--fetch-timeout=${NPM_VIEW_FETCH_TIMEOUT_MS}`, `--fetch-retries=${NPM_VIEW_FETCH_RETRIES}`,
    ]
    if (attempt.registry) args.push('--registry', attempt.registry)
    const res = await runner(npmCommand(), args, { timeoutMs: NPM_VIEW_TIMEOUT_MS })
    if (res.ok) {
      const v = bestOfTags(parseDistTags(res.out))
      if (v) {
        log(`[view] 源 ${sourceName(attempt)} 返回最新版本 ${v}`)
        return v
      }
    }
  }
  log('[view] 所有源查询失败')
  return null
}

/** 从 npm view --json 的 stdout 中解析 dist-tags 对象；失败返回 null。 */
function parseDistTags(out) {
  if (typeof out !== 'string') return null
  const start = out.indexOf('{')
  const end = out.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const j = JSON.parse(out.slice(start, end + 1))
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null
  } catch {
    return null
  }
}

/** 从 dist-tags 中取 SemVer 最大的版本（优先 latest 与 next）；无有效版本返回 null。 */
function bestOfTags(tags) {
  if (!tags || typeof tags !== 'object') return null
  let best = null
  for (const tag of ['latest', 'next']) {
    const v = tags[tag]
    if (typeof v !== 'string' || !parseVersion(v)) continue
    if (!best || compareVersions(v, best) > 0) best = v
  }
  return best
}

/** 解析完整的 SemVer（构建元数据不参与比较），无法解析返回 null。 */
function parseVersion(v) {
  if (typeof v !== 'string') return null
  const identifier = '[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*'
  const m = v.trim().match(new RegExp(`^(\\d+)\\.(\\d+)\\.(\\d+)(?:-(${identifier}))?(?:\\+${identifier})?$`))
  if (!m) return null
  return {
    major: parseInt(m[1], 10),
    minor: parseInt(m[2], 10),
    patch: parseInt(m[3], 10),
    pre: m[4] ? m[4].split('.') : [],
  }
}

/**
 * 语义化版本比较：a>b 返回 1，a<b 返回 -1，相等或无法解析返回 0。
 * 复用 semver 的 prerelease 比较，仅保留「无法解析返回 0」的宽容行为。
 */
function compareVersions(a, b) {
  if (!parseVersion(a) || !parseVersion(b)) return 0
  return semver.compare(a, b)
}

/** 读取系统 node 版本字符串（去 v 前缀）；取不到返回 null。 */
function nodeVersion() {
  try {
    const r = spawnSync('node', ['--version'], { encoding: 'utf8' })
    if (r.status === 0 && r.stdout) return r.stdout.trim().replace(/^v/, '')
  } catch {}
  return null
}

/** 只判断系统是否提供了可执行的 Node，不对版本设置硬门槛。 */
function nodeIsAvailable(version) {
  return typeof version === 'string' && version.trim().length > 0
}

module.exports = {
  BASE_DIR,
  RUNTIME_DIR,
  VERSION_FILE,
  migrateLegacyBaseDir,
  REGISTRY_MIRROR,
  REGISTRY_MIRROR_ALT,
  npmCommand,
  run,
  killActiveChildren,
  ensureRuntime,
  installVersion,
  installedVersion,
  latestVersion,
  binPath,
  runtimeStatus,
  missingRequiredPeers,
  isFrontendOnlyPeer,
  compareVersions,
  parseVersion,
  parseDistTags,
  bestOfTags,
  isNotFoundError,
  registryAttempts,
  pickRegistries,
  probeRegistry,
  nodeVersion,
  nodeIsAvailable,
}
