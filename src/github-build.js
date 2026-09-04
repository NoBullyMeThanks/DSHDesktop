'use strict'
/**
 * GitHub release 版本的构建与装载。
 *
 * 官方仓库 deepseek-ai/deepseek-harness 的 npm 发布是手动 workflow_dispatch
 * （release-publish.yml），与 GitHub release 存在时间差。本模块在 npm 尚未
 * 同步某 release 版本时，复现官方发布流程把该版本装进 runtime：
 *
 *   pnpm install --frozen-lockfile
 *     → pnpm run release:verify --family dsh        （不设 RELEASE_PUBLISH，不依赖 git tag）
 *     → pnpm run build:official                      （产出 client build record）
 *     → 按官方家族规则逐成员 pnpm pack（dsh / vendor / landlock entry）
 *     → 把全部 tarballs 作为 file: 依赖一次性 npm install 进 runtime
 *
 * 最后一步与官方 verify-packed-install 完全同构：每个 tarball 都是精确依赖，
 * 只有外部依赖走 registry——得到的运行时与官方发布包逐字节同源。
 *
 * 与官方 CI 的两点差异（均为 Windows 桌面环境的有意适配）：
 * - pnpm 用 npm registry 上的官方 JS 包（`node <pnpm.cjs> …` 派发），不下载
 *   GitHub 独立二进制：官方 release assets 重定向到 objects.githubusercontent.com，
 *   在国内网络常见不可达，而 npm registry（npmmirror 回退）与运行时安装同一条路；
 * - release:pack 内部以无 shell 的 `spawn('pnpm', …)` 派发命令，Windows 下仅能
 *   解析真正的可执行文件，无法用 .cmd shim 满足（实测 ENOENT），故 pack 步骤
 *   按 families.ts 的家族规则（packages/!(experimental)/* + apps/* | vendor/*）
 *   自行枚举成员并逐个 `pnpm --dir <成员> pack`，与官方打包逐参数一致。
 *
 * 所有子命令经 runtime-manager.run() 派发（超时/取消/退出清理统一生效）；
 * runner/probe/downloadFile 均可注入，纯 Node 单测。不依赖 Electron。
 */
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const semver = require('semver')
const tar = require('tar')
const runtime = require('./runtime-manager.js')
const github = require('./github-release.js')

const BUILD_ROOT = path.join(runtime.BASE_DIR, 'build')
const PNPM_STORE_DIR = path.join(BUILD_ROOT, 'pnpm-store')
const TOOLCHAIN_BIN = path.join(BUILD_ROOT, 'toolchain', 'bin')
const DSH_PACKAGE = '@deepseek-ai/dsh'
const PNPM_CLI_REL = path.join('node_modules', 'pnpm', 'bin', 'pnpm.cjs')

/** 官方仓库根 package.json 的 engines（构建链需要，运行时也是同一 node）。 */
const NODE_ENGINES = '^22.19.0 || >=24.0.0'
/** 预估构建下限（依赖树 + 构建产物），不足时前置报错而不是中途耗尽。 */
const MIN_DISK_FREE_BYTES = 6 * 1024 ** 3
const SOURCE_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000
const PNPM_INSTALL_TIMEOUT_MS = 15 * 60 * 1000
const INSTALL_DEPS_TIMEOUT_MS = 45 * 60 * 1000
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000
const BUILD_TIMEOUT_MS = 60 * 60 * 1000
const PACK_TIMEOUT_MS = 20 * 60 * 1000
const ASSEMBLE_TIMEOUT_MS = 30 * 60 * 1000

/** 构建产物 tarballs 相对目录（dsh 家族 / vendor 家族 / landlock entry）。 */
const TARBALL_SUBDIRS = ['dsh', 'vendor', 'landlock']

let aborted = false

/** 正在构建的版本根目录（source、tarballs 缓存都放这里，成功后才清理 source）。 */
function buildDirFor(version, buildRoot = BUILD_ROOT) {
  return path.join(buildRoot, String(version))
}

/** 前置检查：Node 版本（满足官方 engines）与磁盘空间。 */
function checkPrereqs(options = {}) {
  const errors = []
  let nodeVersion = options.nodeVersion
  if (nodeVersion == null) nodeVersion = runtime.nodeVersion()
  if (nodeVersion == null || !semver.satisfies(String(nodeVersion).replace(/^v/, ''), NODE_ENGINES, { includePrerelease: true })) {
    errors.push({ key: 'githubPrereqNode', required: NODE_ENGINES, current: nodeVersion ?? null })
  }
  const getDiskFree = options.getDiskFree
  if (getDiskFree) {
    let free = null
    try { free = getDiskFree() } catch {}
    if (free == null || free < MIN_DISK_FREE_BYTES) {
      errors.push({ key: 'githubPrereqDisk', required: MIN_DISK_FREE_BYTES, current: free })
    }
  }
  return { ok: errors.length === 0, errors }
}

/** 从源码根的 package.json 读取 pnpm 版本（官方锁定在 packageManager 字段）。 */
function pnpmVersionFromManifest(sourceDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(sourceDir, 'package.json'), 'utf8'))
    const m = typeof pkg.packageManager === 'string' ? pkg.packageManager.match(/^pnpm@(\S+)$/) : null
    return m ? m[1] : null
  } catch {
    return null
  }
}

/** 构建步骤的公共环境：固定依赖 store、关闭遥测与发布判定。
 *  extra.commit：官方 build:official 会调 `git rev-parse HEAD` 取提交号，
 *  源码 tarball 没有 .git，官方支持用 DSH_CLIENT_COMMIT_HASH 显式提供。 */
function buildEnv(extra = {}) {
  const env = {
    ...process.env,
    DSH_TELEMETRY_DISABLED: '1',
    PNPM_CONFIG_STORE_DIR: PNPM_STORE_DIR,
  }
  if (typeof extra.commit === 'string' && /^[0-9a-f]{7,40}$/i.test(extra.commit)) {
    env.DSH_CLIENT_COMMIT_HASH = extra.commit
  }
  // 从不设 RELEASE_PUBLISH/GITHUB_REF：release:verify 会因此要求 dsh-v* tag 才会走发布分支，
  // 用户环境里若有这些变量需要显式摘掉，否则会把「源码构建」误判为官方发布上下文。
  delete env.RELEASE_PUBLISH
  delete env.GITHUB_REF
  return env
}

/**
 * 准备 pnpm CLI（npm registry 上的官方 JS 包，`node pnpm.cjs` 直接执行）。
 * 不下载 GitHub 独立二进制：官方独立包走 objects.githubusercontent.com，国内常不可达；
 * npm registry 有 npmmirror 回退，与运行时安装同一路径，最稳。
 */
async function provisionPnpm(options = {}) {
  const log = options.log ?? (() => {})
  const runner = options.runner ?? runtime.run
  const pnpmVersion = options.pnpmVersion
  if (!pnpmVersion) return { ok: false, error: '无法从源码 packageManager 字段解析 pnpm 版本' }
  const toolchainDir = options.toolchainDir ?? path.dirname(TOOLCHAIN_BIN)
  const pnpmCli = path.join(toolchainDir, PNPM_CLI_REL)
  const marker = path.join(toolchainDir, 'pnpm.version')
  try {
    if (fs.existsSync(pnpmCli) && fs.readFileSync(marker, 'utf8').trim() === pnpmVersion) {
      return { ok: true, pnpmCli, cached: true }
    }
  } catch {}
  fs.mkdirSync(toolchainDir, { recursive: true })
  fs.rmSync(path.join(toolchainDir, 'node_modules', 'pnpm'), { recursive: true, force: true })

  const attempts = await runtime.pickRegistries({ runner, probe: options.probe })
  let lastErr = ''
  for (const attempt of attempts) {
    const args = ['install', '--prefix', toolchainDir, `pnpm@${pnpmVersion}`, '--no-audit', '--no-fund', '--prefer-offline', '--fetch-timeout=90000', '--fetch-retries=1']
    if (attempt.registry) args.push('--registry', attempt.registry)
    log(`[pnpm] 从 ${attempt.registry ?? 'npm 配置源'} 安装 pnpm@${pnpmVersion}`)
    const res = await runner('npm', args, { timeoutMs: PNPM_INSTALL_TIMEOUT_MS, onData: options.onProgress })
    if (!res.ok) {
      lastErr = (res.err || '').slice(-1200)
      log(`[pnpm] 安装失败：${lastErr}`)
      continue
    }
    if (!fs.existsSync(pnpmCli)) {
      lastErr = 'npm 安装完成但 pnpm.cjs 不存在'
      continue
    }
    fs.writeFileSync(marker, pnpmVersion)
    return { ok: true, pnpmCli }
  }
  return { ok: false, error: `无法安装 pnpm（${attempts.map((a) => a.registry ?? 'npm 配置源').join('、')} 均失败）。${lastErr}` }
}

/** 下载并解压 release 源码；已完成的缓存（marker + 版本校验）直接复用。 */
async function acquireSource(options = {}) {
  const buildDir = options.buildDir
  const version = options.version
  const log = options.log ?? (() => {})
  const sourceDir = path.join(buildDir, 'src')
  const marker = path.join(sourceDir, '.dshdesktop-source-ok')
  if (fs.existsSync(marker) && readAppCliVersion(sourceDir) === version) {
    return { ok: true, sourceDir, cached: true }
  }
  const downloadFile = options.downloadFile ?? ((url, dest, opts) => github.downloadFile(url, dest, opts))
  const downloadSourceTarball = options.downloadSourceTarball ?? ((tag, destFile, opts) => github.downloadSourceTarball(tag, destFile, opts))
  const tag = options.tag || `dsh-v${version}`
  const tarballFile = path.join(buildDir, `source-${tag}.tar.gz`)
  fs.mkdirSync(buildDir, { recursive: true })
  fs.rmSync(sourceDir, { recursive: true, force: true })
  fs.rmSync(tarballFile, { force: true })
  options.onStatus?.('githubBuildPhaseDownload')
  const res = await downloadSourceTarball(tag, tarballFile, {
    timeoutMs: SOURCE_DOWNLOAD_TIMEOUT_MS,
    isAborted: options.isAborted,
  })
  if (res.cancelled) return { ok: false, cancelled: true, error: '已取消' }
  if (!res.ok) return { ok: false, error: `源码下载失败：${res.error}` }
  options.onStatus?.('githubBuildPhaseExtract')
  fs.mkdirSync(sourceDir, { recursive: true })
  try {
    // GitHub 源码 tarball 顶层是一个 <repo>-<ref> 目录，strip 1 去掉
    await tar.x({ file: tarballFile, cwd: sourceDir, strip: 1 })
  } catch (err) {
    return { ok: false, error: `源码解压失败：${err && err.message ? err.message : err}` }
  } finally {
    fs.rmSync(tarballFile, { force: true })
  }
  if (readAppCliVersion(sourceDir) !== version) {
    return { ok: false, error: `源码版本校验失败：apps/cli/package.json 不是 ${version}` }
  }
  fs.writeFileSync(marker, `${tag}\n`)
  log(`[github-build] 源码就绪：${sourceDir}`)
  return { ok: true, sourceDir, cached: false }
}

function readAppCliVersion(sourceDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(sourceDir, 'apps', 'cli', 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

/** 依序执行一个 pnpm 子命令（经 run() 以 `node pnpm.cjs …` 派发）。 */
async function runPnpmStep(pnpmCli, args, step, options = {}) {
  const runner = options.runner ?? runtime.run
  const res = await runner('node', [pnpmCli, ...args], {
    cwd: options.cwd,
    env: options.env ?? buildEnv(),
    timeoutMs: options.timeoutMs,
    onData: options.onData,
  })
  if (!res.ok) {
    const text = (res.err || '').trim()
    return { ok: false, step, err: text ? text.slice(-3000) : `pnpm 退出码 ${res.code}`, timedOut: res.timedOut === true }
  }
  return { ok: true }
}

/**
 * 按官方 families.ts 的家族规则枚举成员（对照 patterns：
 * dsh = packages（排除 experimental）下两层目录的 package.json + apps 下一层的
 * package.json；vendor = vendor 下一层的 package.json）。
 * 只接受含 name+version 的有效清单。
 */
function collectFamilyMembers(sourceDir, family) {
  const members = []
  const addFrom = (dir, skipNames = new Set(), nested = false) => {
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (!entry.isDirectory() || skipNames.has(entry.name)) continue
      const candidateDir = path.join(dir, entry.name)
      if (nested) {
        // packages/<分类>/<包>/package.json（分类层本身不是包）
        addFrom(candidateDir)
        continue
      }
      const manifestPath = path.join(candidateDir, 'package.json')
      let manifest = null
      try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) } catch { continue }
      if (!manifest || typeof manifest.name !== 'string' || typeof manifest.version !== 'string') continue
      members.push({ dir: candidateDir, manifest })
    }
  }
  if (family === 'dsh') {
    addFrom(path.join(sourceDir, 'packages'), new Set(['experimental']), true)
    addFrom(path.join(sourceDir, 'apps'))
  } else if (family === 'vendor') {
    addFrom(path.join(sourceDir, 'vendor'))
  }
  return members.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))
}

/**
 * 按官方 release:pack 的语义打包一个家族：每个成员 `pnpm --dir <成员> pack
 * --pack-destination <out>`（与官方 pack.ts 逐参数一致，pnpm pack 会在打包时
 * 把 workspace:^ 改写为实际版本）。dsh 家族要求所有成员版本一致。
 */
async function packFamily(options = {}) {
  const { sourceDir, family, outDir, pnpmCli, runner = runtime.run, env = buildEnv(), log = () => {}, onData, timeoutMs = PACK_TIMEOUT_MS } = options
  const members = collectFamilyMembers(sourceDir, family)
  if (members.length === 0) return { ok: false, err: `${family} 家族没有找到可打包成员` }
  if (family === 'dsh') {
    const versions = new Set(members.map((member) => member.manifest.version))
    if (versions.size !== 1) return { ok: false, err: `dsh 家族成员版本不一致（${[...versions].join(', ')}）` }
  }
  fs.mkdirSync(outDir, { recursive: true })
  for (const member of members) {
    const res = await runner('node', [pnpmCli, '--dir', member.dir, 'pack', '--pack-destination', outDir], {
      cwd: sourceDir,
      env,
      timeoutMs,
      onData,
    })
    if (!res.ok) {
      const text = (res.err || '').trim()
      return { ok: false, err: `${member.manifest.name}@${member.manifest.version} 打包失败：${text ? text.slice(-2000) : `pnpm 退出码 ${res.code}`}` }
    }
    log(`[github-build] pack：${member.manifest.name}@${member.manifest.version}`)
  }
  return { ok: true, count: members.length }
}

/**
 * 读取一个 npm tarball 的 package.json（tarball 内成员路径为 package/package.json）。
 * 失败返回 null。
 */
function readTarballManifest(file) {
  return new Promise((resolve) => {
    let manifest = null
    tar.t({
      file,
      onentry: (entry) => {
        if (entry.path !== 'package/package.json') {
          entry.resume()
          return
        }
        const chunks = []
        entry.on('data', (chunk) => chunks.push(chunk))
        entry.on('end', () => {
          try { manifest = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { manifest = null }
        })
      },
    }).then(() => resolve(manifest)).catch(() => resolve(null))
  })
}

/** 收集若干目录下的全部 .tgz，返回按包名索引的 { name, version, file, url }。 */
async function collectTarballs(dirs) {
  const result = new Map()
  for (const dir of dirs) {
    let files = []
    try { files = fs.readdirSync(dir).filter((name) => name.endsWith('.tgz')).sort() } catch { continue }
    for (const name of files) {
      const file = path.join(dir, name)
      const manifest = await readTarballManifest(file)
      if (!manifest || typeof manifest.name !== 'string' || typeof manifest.version !== 'string') continue
      result.set(manifest.name, {
        name: manifest.name,
        version: manifest.version,
        file,
        url: pathToFileURL(file).href,
      })
    }
  }
  return result
}

/**
 * 把全部 tarballs 作为精确 file: 依赖装进 runtime（官方 verify-packed-install 同构）。
 * 安装前备份 runtime 的 package.json/package-lock.json，失败恢复。
 * 返回 { ok, version?, err?, cancelled? }。
 */
async function assembleRuntime(options = {}) {
  const runtimeDir = options.runtimeDir ?? runtime.RUNTIME_DIR
  const versionFile = options.versionFile ?? runtime.VERSION_FILE
  const runner = options.runner ?? runtime.run
  const log = options.log ?? (() => {})
  const onProgress = options.onProgress
  const tarballDirs = options.tarballDirs ?? []
  const isAborted = options.isAborted ?? (() => false)
  const tarballs = await collectTarballs(tarballDirs)
  if (tarballs.size === 0) return { ok: false, err: '没有找到可用的发布 tarball' }
  const entry = tarballs.get(DSH_PACKAGE)
  if (!entry) return { ok: false, err: `tarball 集合缺少 ${DSH_PACKAGE}` }
  if (options.version && entry.version !== options.version) {
    return { ok: false, err: `${DSH_PACKAGE} tarball 版本 ${entry.version} 与期望 ${options.version} 不一致` }
  }

  fs.mkdirSync(runtimeDir, { recursive: true })
  const manifestPath = path.join(runtimeDir, 'package.json')
  const lockPath = path.join(runtimeDir, 'package-lock.json')
  const backup = {
    manifest: fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, 'utf8') : null,
    lock: fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8') : null,
  }
  const restore = () => {
    try {
      if (backup.manifest !== null) fs.writeFileSync(manifestPath, backup.manifest)
      else fs.rmSync(manifestPath, { force: true })
      if (backup.lock !== null) fs.writeFileSync(lockPath, backup.lock)
      else fs.rmSync(lockPath, { force: true })
    } catch (err) {
      log(`[assemble] 恢复运行时备份失败：${err.message}`)
    }
  }

  const dependencies = {}
  for (const [name, tarball] of tarballs) dependencies[name] = tarball.url
  fs.writeFileSync(manifestPath, JSON.stringify({
    private: true,
    type: 'module',
    description: 'DSH Desktop 管理的运行时（GitHub release 构建产物，请勿手动修改）',
    dependencies,
  }, null, 2) + '\n')

  const commonArgs = ['install', '--no-audit', '--no-fund', '--prefer-offline', '--fetch-timeout=90000', '--fetch-retries=1']
  const attempts = await runtime.pickRegistries({ runner, probe: options.probe })
  let lastErr = ''
  for (const attempt of attempts) {
    const args = [...commonArgs]
    if (attempt.registry) args.push('--registry', attempt.registry)
    let res = await runner('npm', args, { cwd: runtimeDir, timeoutMs: ASSEMBLE_TIMEOUT_MS, onData: onProgress })
    if (isAborted()) {
      restore()
      return { ok: false, cancelled: true, err: '已取消' }
    }
    if (!res.ok) {
      // 官方验证用普通解析即通过；失败时回退 legacy-peer-deps 再补 peer（与主包安装一致的策略）
      log(`[assemble] npm install 失败（${attempt.registry ?? 'npm 配置源'}），回退 --legacy-peer-deps 重试：${(res.err || '').slice(-1200)}`)
      res = await runner('npm', [...args, '--legacy-peer-deps'], { cwd: runtimeDir, timeoutMs: ASSEMBLE_TIMEOUT_MS, onData: onProgress })
      if (!res.ok) {
        lastErr = (res.err || '').slice(-2000)
        continue
      }
    }
    const status = runtime.runtimeStatus(runtimeDir)
    if (!status.usable || !runtime.parseVersion(status.version)) {
      lastErr = `装载后运行时校验失败：${status.missingPeers.map((peer) => peer.name).join('、') || '未知原因'}`
      continue
    }
    if (status.version !== entry.version) {
      lastErr = `装载后的版本 ${status.version} 与 tarball 版本 ${entry.version} 不一致`
      continue
    }
    const meta = { installed: status.version, source: 'github' }
    if (options.tag || options.commit) meta.github = { tag: options.tag ?? null, commit: options.commit ?? null }
    runtime.writeVersionFile(meta, versionFile)
    log(`[assemble] 装载成功：${meta.installed}（${tarballs.size} 个 tarball）`)
    return { ok: true, version: meta.installed }
  }
  restore()
  return { ok: false, err: `tarball 安装失败：${lastErr || '所有源均失败'}` }
}

/**
 * 把内部函数返回的 `{ ok:false, error }` 归一化为调用方约定的 `{ ok:false, err }`，
 * 避免主进程进度弹窗把缺 err 的结果显示成「unknown error」。
 */
function withErr(result) {
  if (!result || result.ok !== false) return result
  if (typeof result.err === 'string') return result
  return { ...result, err: typeof result.error === 'string' ? result.error : '未知错误' }
}

/**
 * 从 GitHub release 构建并安装指定版本（npm 尚未同步时走这条路）。
 * options：{ runner, downloadSourceTarball, runtimeDir, versionFile,
 *            log, onStatus(phaseKey), onProgress(line), tag, commit, nodeVersion,
 *            getDiskFree, isAborted, probe }。
 * 返回 { ok, version?, err?, cancelled?, step?, prereq? }。
 */
async function installGithubRelease(version, options = {}) {
  const log = options.log ?? (() => {})
  const onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => {}
  const onProgress = options.onProgress
  const runner = options.runner ?? runtime.run
  const runtimeDir = options.runtimeDir ?? runtime.RUNTIME_DIR
  const versionFile = options.versionFile ?? runtime.VERSION_FILE
  const tag = options.tag || `dsh-v${version}`
  const commit = options.commit ?? null

  const isAborted = options.isAborted ?? (() => aborted)
  const cancelledResult = () => ({ ok: false, cancelled: true, err: '已取消' })

  // 提交号用于官方 build:official 的客户端构建元数据（DSH_CLIENT_COMMIT_HASH 注入，
  // 替代 tarball 源码里不存在的 `git rev-parse HEAD`）；注入解析器可被测试替身。
  let resolvedCommit = commit
  if (!resolvedCommit && typeof options.resolveCommit === 'function') {
    try { resolvedCommit = await options.resolveCommit(tag) } catch { resolvedCommit = null }
    if (resolvedCommit) log(`[github-build] commit：${resolvedCommit}`)
  }

  const prereq = checkPrereqs({ nodeVersion: options.nodeVersion, getDiskFree: options.getDiskFree })
  if (!prereq.ok) return { ok: false, err: '前置检查未通过', prereq: prereq.errors }

  const buildDir = buildDirFor(version, options.buildRoot)
  log(`[github-build] 开始构建 ${tag}（buildDir: ${buildDir}）`)

  // 1. 源码（走缓存时跳过下载/解压）
  onStatus('githubBuildPhaseDownload')
  const source = await acquireSource({ ...options, buildDir, version, tag, log })
  if (source.cancelled) return cancelledResult()
  if (!source.ok) return withErr(source)
  const sourceDir = source.sourceDir
  if (isAborted()) return cancelledResult()

  // 2. pnpm（版本取官方锁定的 packageManager）
  const pnpm = await provisionPnpm({ ...options, pnpmVersion: pnpmVersionFromManifest(sourceDir), log })
  if (pnpm.cancelled) return cancelledResult()
  if (!pnpm.ok) return withErr(pnpm)
  const pnpmCli = pnpm.pnpmCli
  log(`[github-build] pnpm CLI：${pnpmVersionFromManifest(sourceDir)}（${pnpm.cached ? '缓存' : '新安装'}）`)
  if (isAborted()) return cancelledResult()

  const env = buildEnv({ commit: resolvedCommit })
  const stepOptions = { runner, env, onData: onProgress }

  // 3. 官方 release-publish.yml 同序：install → verify → build → pack ×3
  onStatus('githubBuildPhaseDeps')
  let step = await runPnpmStep(pnpmCli, ['install', '--frozen-lockfile'], 'deps', { ...stepOptions, cwd: sourceDir, timeoutMs: INSTALL_DEPS_TIMEOUT_MS })
  if (!step.ok) return isAborted() ? cancelledResult() : { ok: false, step: 'deps', err: step.err }

  onStatus('githubBuildPhaseVerify')
  step = await runPnpmStep(pnpmCli, ['run', 'release:verify', '--family', 'dsh'], 'verify', { ...stepOptions, cwd: sourceDir, timeoutMs: VERIFY_TIMEOUT_MS })
  if (!step.ok) return isAborted() ? cancelledResult() : { ok: false, step: 'verify', err: step.err }

  onStatus('githubBuildPhaseBuild')
  step = await runPnpmStep(pnpmCli, ['run', 'build:official'], 'build', { ...stepOptions, cwd: sourceDir, timeoutMs: BUILD_TIMEOUT_MS })
  if (!step.ok) return isAborted() ? cancelledResult() : { ok: false, step: 'build', err: step.err }

  // 4. 打包（输出直接进缓存的 tarballs 目录）
  const tarballRoot = path.join(buildDir, 'tarballs')
  onStatus('githubBuildPhasePack')
  step = await packFamily({ sourceDir, family: 'dsh', outDir: path.join(tarballRoot, 'dsh'), pnpmCli, ...stepOptions })
  if (!step.ok) return isAborted() ? cancelledResult() : { ok: false, step: 'pack-dsh', err: step.err }
  step = await packFamily({ sourceDir, family: 'vendor', outDir: path.join(tarballRoot, 'vendor'), pnpmCli, ...stepOptions })
  if (!step.ok) return isAborted() ? cancelledResult() : { ok: false, step: 'pack-vendor', err: step.err }
  step = await runPnpmStep(pnpmCli, ['--dir', 'native/landlock-run', 'run', 'build:ts'], 'landlock-build', { ...stepOptions, cwd: sourceDir, timeoutMs: PACK_TIMEOUT_MS })
  if (!step.ok) return isAborted() ? cancelledResult() : { ok: false, step: 'landlock-build', err: step.err }
  step = await runPnpmStep(pnpmCli, ['--dir', 'native/landlock-run/packages/entry', 'pack', '--pack-destination', path.join(tarballRoot, 'landlock')], 'landlock-pack', { ...stepOptions, cwd: sourceDir, timeoutMs: PACK_TIMEOUT_MS })
  if (!step.ok) return isAborted() ? cancelledResult() : { ok: false, step: 'landlock-pack', err: step.err }

  // 5. 装载运行时
  onStatus('githubBuildPhaseAssemble')
  const assembled = await assembleRuntime({
    runtimeDir,
    versionFile,
    runner,
    log,
    onProgress,
    probe: options.probe,
    version,
    tag,
    commit: resolvedCommit,
    isAborted,
    tarballDirs: TARBALL_SUBDIRS.map((name) => path.join(tarballRoot, name)),
  })
  if (assembled.cancelled) {
    log('[github-build] 已取消（运行时已恢复到安装前状态）')
    return cancelledResult()
  }
  if (!assembled.ok) return assembled

  // 6. 成功后清理源码目录（保留 tarballs 缓存供修复复用）
  try { fs.rmSync(sourceDir, { recursive: true, force: true }) } catch (err) {
    log(`[github-build] 清理源码目录失败（不影响结果）：${err.message}`)
  }
  log(`[github-build] 完成：${assembled.version}`)
  return { ok: true, version: assembled.version }
}

/** 用已缓存的 tarballs 重新装载（修复损坏/重置 runtime 时无需重建）。 */
async function reinstallFromCache(version, options = {}) {
  const buildDir = buildDirFor(version, options.buildRoot)
  const tarballDirs = TARBALL_SUBDIRS
    .map((name) => path.join(buildDir, 'tarballs', name))
    .filter((dir) => { try { return fs.readdirSync(dir).some((name) => name.endsWith('.tgz')) } catch { return false } })
  if (tarballDirs.length === 0) return { ok: false, missing: true, err: 'GitHub 构建缓存缺失，无法从缓存修复' }
  const meta = runtime.readVersionFile(options.versionFile ?? runtime.VERSION_FILE)
  return assembleRuntime({
    ...options,
    version,
    tag: meta?.github?.tag ?? `dsh-v${version}`,
    commit: meta?.github?.commit ?? null,
    isAborted: options.isAborted ?? (() => false),
    tarballDirs,
  })
}

/**
 * 删除一个目录树（仅限启动时、确认无并发构建时调用；失败不阻塞）。
 *
 * 快速路径用 Node rmSync；但 pnpm 在 Windows 上创建的 node_modules 含大量
 * junction（指向 pnpm-store）,rmSync(recursive) 删除此类目录树会在中途失败
 * （Node 已知问题,报"系统无法识别文件名"并放弃）。失败时改用 robocopy 空目录
 * 镜像法：对长路径与重解析点均友好,只删链接本身不跟随,最后再删空目录。
 * 返回 true 表示目标目录已不存在。
 */
async function removeDirectoryTree(dir, log, options = {}) {
  const removeTree = options.removeTree ?? ((p) => fs.rmSync(p, { recursive: true, force: true }))
  try {
    removeTree(dir)
    return true
  } catch (err) {
    log(`[switch-to-npm] 直接删除失败（${err.message}），改用 robocopy 空目录镜像…`)
  }
  return removeDirectoryViaRobocopy(dir, log, options)
}

/** robocopy 空目录镜像法：<空目录> 镜像到目标，内容全清后再删除空目录本身。 */
async function removeDirectoryViaRobocopy(dir, log, options = {}) {
  const runner = options.runner ?? runtime.run
  // 空源目录放在同父目录下（确保与目标同卷，避免跨卷复制语义差异）
  const emptyDir = path.join(path.dirname(dir), `.empty-${process.pid}-${Date.now()}`)
  let ok = false
  try {
    fs.mkdirSync(emptyDir, { recursive: true })
    // robocopy 退出码 0-7 均为成功（0 无变化、1 有复制、2 删除了目标多余文件 [/mir]、3=1+2、4=不匹配、5/6/7=组合），
    // >=8 才是错误。注意不能用通用 run() 的「退出码 0 才算成功」判定（run 会把 2 标记为失败）。
    const res = await runner('robocopy', [emptyDir, dir, '/mir', '/nfl', '/ndl', '/njh', '/njs', '/r:1', '/w:1'], {
      timeoutMs: 20 * 60 * 1000,
    })
    const codeOk = Number.isInteger(res?.code) && res.code >= 0 && res.code < 8
    const runFailed = !res || res.error || res.timedOut === true
    ok = codeOk && !runFailed
    if (!ok) {
      const reason = res?.timedOut
        ? '（超时）'
        : res?.error
          ? `（${res.error}）`
          : Number.isInteger(res?.code)
            ? `（退出码 ${res.code}）`
            : '（未知原因）'
      log(`[switch-to-npm] robocopy 镜像失败${reason}`)
    }
  } catch (err) {
    log(`[switch-to-npm] robocopy 镜像异常：${err.message}`)
  } finally {
    try { fs.rmSync(emptyDir, { recursive: true, force: true }) } catch {}
  }
  if (!ok) return false
  // robocopy 只清空内容，最后删除已成为空目录的目标（此时已无 junction，rmSync 可靠）
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (err) {
    log(`[switch-to-npm] 镜像后删除目录仍失败：${err.message}`)
  }
  return !fs.existsSync(dir)
}

/** 删除整个构建产物根目录（仅限启动时、确认无并发构建时调用；失败不阻塞）。 */
async function cleanupBuildRoot(buildRoot, log, options = {}) {
  if (!fs.existsSync(buildRoot)) {
    log('[switch-to-npm] 构建产物目录不存在，无需清理')
    return true
  }
  return removeDirectoryTree(buildRoot, log, options)
}

/**
 * 删除 build 根下「非当前版本」的历史版本目录（GitHub 长期领先 npm 时,
 * 每次源码构建都会留下 build/<版本>/,历史版本的 tarballs 无任何代码路径再使用）。
 * 只处理形如版本号的目录,保留共享的 pnpm-store/toolchain 与未知内容；
 * 仅限启动时、确认无并发构建时调用;失败不阻塞。
 */
async function pruneStaleBuildVersions(buildRoot, currentVersion, log, options = {}) {
  let entries
  try { entries = fs.readdirSync(buildRoot, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === currentVersion) continue
    if (!runtime.parseVersion(entry.name)) continue // 只清版本目录,共享目录与未知内容不动
    const removed = await removeDirectoryTree(path.join(buildRoot, entry.name), log, options)
    log(removed
      ? `[switch-to-npm] 已清理历史版本构建产物：${entry.name}`
      : `[switch-to-npm] 清理历史版本失败（${entry.name}），保留待下次启动重试`)
  }
}

/**
 * GitHub 来源校正：当前运行时若来自 GitHub 源码构建（装它的那刻 npm 尚未同步），
 * 而 npm 现已发布同一精确版本，则改用 npm 重新安装该版本（默认跟随官方源），
 * 并删除全部 GitHub 构建产物，让运行时回到纯 npm 托管状态。
 *
 * 适用时机：应用启动时（ensureRuntime 之后、startDsh 之前）调用一次，切换过程
 * 只显示启动状态文案、无需用户确认；切源后仅需一次启动（DSH 进程尚未拉起）。
 * 调用方必须确保同时没有其他运行时操作（main.js 以 runtimeOperationLock 保护），
 * 否则可能误删正在写入的构建产物。
 *
 * 判定与执行：
 * - 运行时不是有效的 GitHub 构建（无 version.json / source 缺失 / 版本无效）→
 *   此时 build 目录若有内容都是历史残留（如曾构建过、后经 npm 更新已不在用），
 *   直接整体清理，不做任何切换；
 * - 运行时是有效的 GitHub 构建 → 先清理 build 下其他历史版本目录（仅保留当前
 *   版本与共享的 pnpm-store/toolchain），随后按 npm 同步情况继续：
 * - npmHasVersion 失败/未发布 → 保持 GitHub 构建继续用，下次启动再试（可用性优先）；
 * - npm 安装成功 → version.json 写回 { installed }（source 清空，回滚项自动禁用），
 *   并删除整个 BUILD_ROOT 构建产物（源码/tarballs/pnpm-store/toolchain 均为死文件）；
 * - npm 安装失败 → 用缓存 tarballs 恢复 GitHub 状态（reinstallFromCache），
 *   本次照常启动、不阻塞、不弹窗，下次启动再试。
 *
 * 返回 { switched, version?, kept, reason?, err?, restored? }：
 * - switched=true：已切到 npm 并完成清理；
 * - switched=false 且 kept=true：保持 GitHub 构建（npm 未同步或安装失败后已恢复）；
 * - switched=false 且 kept=false：运行时并非 GitHub 构建，仅完成残留清理，未执行切换。
 * options 仅用于纯 Node 测试注入 runtimeDir/versionFile/runner/probe/buildRoot 等。
 */
async function switchToNpmWhenSynced(options = {}) {
  const runtimeDir = options.runtimeDir ?? runtime.RUNTIME_DIR
  const versionFile = options.versionFile ?? runtime.VERSION_FILE
  const buildRoot = options.buildRoot ?? BUILD_ROOT
  const log = typeof options.log === 'function' ? options.log : () => {}
  const onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => {}

  const meta = runtime.readVersionFile(versionFile)
  if (!meta || meta.source !== 'github' || !runtime.parseVersion(meta?.installed)) {
    // 运行时由 npm 托管（或从未有 GitHub 构建记录）：build 目录中若有内容都是
    // 历史残留（构建过但已被 npm 更新替换、或构建中途退出的部分产物），直接清理。
    log('[switch-to-npm] 运行时并非 GitHub 构建，检查并清理历史构建残留…')
    await cleanupBuildRoot(buildRoot, log, options)
    return { switched: false, kept: false, reason: 'not-github-build' }
  }
  const version = meta.installed

  // 有效 GitHub 构建：先清掉历史版本目录（仅保留当前版本 + 共享 pnpm-store/toolchain）。
  // GitHub 长期领先 npm 时,每次源码构建都会留下 build/<版本>/,历史 tarballs 无任何
  // 代码路径再使用;切源成功时下面的整体清理会覆盖全部,这里兜住「npm 尚未同步」的窗口期。
  await pruneStaleBuildVersions(buildRoot, version, log, options)

  log(`[switch-to-npm] 当前运行时来自 GitHub 构建（${version}），检查 npm 是否已同步…`)
  const onNpm = await runtime.npmHasVersion(version, { log, runner: options.runner, probe: options.probe })
  if (!onNpm) {
    log('[switch-to-npm] npm 尚未同步该版本，继续使用 GitHub 构建的运行时')
    return { switched: false, kept: true, version, reason: 'npm-not-synced' }
  }

  log(`[switch-to-npm] npm 已同步 ${version}，改用 npm 安装…`)
  onStatus('startupSwitchToNpm')
  const installed = await runtime.installVersion(version, {
    runtimeDir,
    versionFile,
    log,
    runner: options.runner,
    probe: options.probe,
    onProgress: options.onProgress,
  })
  if (!installed.ok) {
    const err = installed.err ?? '未知错误'
    log(`[switch-to-npm] npm 安装失败：${err}`)
    // 安装失败时根 manifest 可能已被 installVersion 改写为 npm 精确依赖，
    // 用构建缓存的 tarballs 恢复 GitHub 状态，保证运行时可继续使用。
    const restored = await reinstallFromCache(version, {
      runtimeDir,
      versionFile,
      log,
      runner: options.runner,
      probe: options.probe,
      buildRoot, // 必须透传：测试/调用方注入临时目录时保持一致，避免误读真实 BUILD_ROOT
    })
    log(`[switch-to-npm] 恢复 GitHub 构建运行时：${restored.ok ? '成功' : `失败（${restored.err ?? '未知错误'}）`}`)
    return { switched: false, kept: true, version, reason: 'install-failed', err, restored: restored.ok }
  }

  // 切源成功：运行时已完全由 npm 托管，全部 GitHub 构建产物（源码/tarballs/
  // pnpm-store/toolchain）均为死文件，整体删除释放空间。
  await cleanupBuildRoot(buildRoot, log, options)
  return { switched: true, version }
}

/** 取消正在进行的构建（幂等；由主进程在用户点击取消时调用）。 */
function abortBuild() {
  aborted = true
  runtime.killActiveChildren()
}

module.exports = {
  BUILD_ROOT,
  PNPM_STORE_DIR,
  TOOLCHAIN_BIN,
  NODE_ENGINES,
  MIN_DISK_FREE_BYTES,
  buildDirFor,
  checkPrereqs,
  pnpmVersionFromManifest,
  buildEnv,
  provisionPnpm,
  acquireSource,
  collectFamilyMembers,
  packFamily,
  collectTarballs,
  readTarballManifest,
  assembleRuntime,
  installGithubRelease,
  reinstallFromCache,
  switchToNpmWhenSynced,
  removeDirectoryTree,
  abortBuild,
}
