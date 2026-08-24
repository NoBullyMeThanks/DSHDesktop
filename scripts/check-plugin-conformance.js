'use strict'
/**
 * DSH 插件规范静态检查器。
 *
 * 对照 docs/plugin-dev-conventions.md 逐项校验一个插件包：
 *  - package.json 的 bundle 声明（dsh.bundle.patch / exports / files）
 *  - cordis.patch.yml 的 patch 方言（insert 行、id/name、组目标、重复 id）
 *  - 插件入口的 cordis 插件契约（默认导出 / Config / inject / Service）
 *  - （可选 --dump-config <profile>）运行时组合验证：调用 dsh 打印叠加后的配置树
 *
 * 用法：
 *   node scripts/check-plugin-conformance.js [插件目录] [--strict]
 *   node scripts/check-plugin-conformance.js <插件目录> --dump-config <测试profile>
 *
 * 退出码：0 = 通过（无 error）；1 = 有 error；--strict 下 warn 也算 error。
 */
const { spawnSync } = require('node:child_process')
const { existsSync, readFileSync, mkdtempSync, openSync, closeSync, unlinkSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { createRequire } = require('node:module')
const os = require('node:os')

const RUNTIME_DIR = process.env.DSH_RUNTIME_DIR || join(os.homedir(), '.dshdesktop', 'runtime')
const STRICT = process.argv.includes('--strict')
const args = process.argv.slice(2).filter((arg) => !['--strict'].includes(arg))
const dumpIndex = args.indexOf('--dump-config')
const dumpProfile = dumpIndex >= 0 ? args[dumpIndex + 1] : undefined
if (dumpIndex >= 0) args.splice(dumpIndex, 2)
const pkgDir = resolve(args[0] || '.')
const results = []

/** 记录一条检查结果：level = 'ok' | 'warn' | 'fail' */
function record(level, id, message) {
  results.push({ level, id, message })
}
const ok = (id, message) => record('ok', id, message)
const warn = (id, message) => record('warn', id, message)
const fail = (id, message) => record('fail', id, message)

/** 输出统一前缀，便于在日志中过滤 */
const PREFIX = '[plugin-check]'

/** 从本机运行时解析 js-yaml（launcher 本身不依赖 YAML） */
function loadYaml() {
  try {
    return require('js-yaml')
  } catch {
    try {
      const req = createRequire(join(RUNTIME_DIR, 'package.json'))
      return req('js-yaml')
    } catch {
      return null
    }
  }
}

/**
 * 官方 patch 文件使用 JSON_SCHEMA 扩展的 `!!js` 标量（条目激活时才求值）。
 * 与 dsh-app-boot 的 entryListSchema 保持一致，否则含 `!!js` 的 patch 会解析失败。
 */
function loadPatchDocument(yaml, file) {
  const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: (data) => typeof data === 'string',
    construct: (data) => ({ __jsExpr: data }),
  })
  const schema = yaml.JSON_SCHEMA.extend(JsExpr)
  return yaml.load(readFileSync(file, 'utf8'), { schema })
}

/** 把文本写到临时文件后做语法检查（扩展名决定模块类型，避开 stdin 管道） */
function syntaxCheck(source, isModule) {
  const tmpDir = mkdtempSync(join(os.tmpdir(), 'plugin-check-'))
  const tmpFile = join(tmpDir, isModule ? 'entry.mjs' : 'entry.cjs')
  require('node:fs').writeFileSync(tmpFile, source)
  const outFd = openSync(join(tmpDir, 'out.txt'), 'w')
  const errFd = openSync(join(tmpDir, 'err.txt'), 'w')
  const result = spawnSync(process.execPath, ['--check', tmpFile], {
    stdio: ['ignore', outFd, errFd],
  })
  closeSync(outFd)
  closeSync(errFd)
  const stderr = readFileSync(join(tmpDir, 'err.txt'), 'utf8')
  unlinkSync(tmpFile)
  unlinkSync(join(tmpDir, 'out.txt'))
  unlinkSync(join(tmpDir, 'err.txt'))
  require('node:fs').rmdirSync(tmpDir)
  return { ok: result.status === 0, stderr }
}

/** 包清单判断：dsh.bundle.patch 使包成为 profile 层（bundle） */
function checkPackageJson(pkg) {
  const name = pkg.name ? String(pkg.name) : '(未命名)'
  ok('pkg.read', `${PREFIX} package.json 可解析`)
  if (!pkg.name || !pkg.version) fail('pkg.ident', `${PREFIX} 缺少 name/version`)
  else ok('pkg.ident', `${PREFIX} ${name}@${pkg.version}`)

  if (pkg.type === 'module') ok('pkg.esm', `${PREFIX} type: module（ESM）`)
  else warn('pkg.esm', `${PREFIX} type 不是 module（官方发布包均为 ESM，CJS 虽可加载但不符合官方样式）`)

  const main = pkg.main || (pkg.exports && pkg.exports['.'] && typeof pkg.exports['.'] === 'object' ? pkg.exports['.'].default : undefined) || 'lib/index.js'
  const entryPath = join(pkgDir, main)
  if (!existsSync(entryPath)) fail('pkg.entry', `${PREFIX} 主入口 ${main} 不存在`)
  else ok('pkg.entry', `${PREFIX} 主入口存在：${main}`)

  if (pkg.types && !existsSync(join(pkgDir, pkg.types))) warn('pkg.types', `${PREFIX} types 字段指向的文件不存在：${pkg.types}`)

  const bundlePatch = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch
  if (!bundlePatch) {
    warn('pkg.bundle', `${PREFIX} 未声明 dsh.bundle.patch —— 将作为普通依赖安装，不会进入 profile 层`)
  } else if (typeof bundlePatch !== 'string') {
    fail('pkg.bundle', `${PREFIX} dsh.bundle.patch 必须是相对包根的字符串路径`)
  } else {
    const patchPath = join(pkgDir, bundlePatch)
    if (!existsSync(patchPath)) fail('pkg.bundle', `${PREFIX} dsh.bundle.patch 指向的文件不存在：${bundlePatch}`)
    else ok('pkg.bundle', `${PREFIX} dsh.bundle.patch -> ${bundlePatch}`)
    const exportEntry = pkg.exports && pkg.exports['./cordis.patch.yml']
    if (!exportEntry) warn('pkg.export-patch', `${PREFIX} exports 未导出 ./cordis.patch.yml（loader 按模块标识符导入，发布后 patch 将不可达）`)
    else ok('pkg.export-patch', `${PREFIX} exports[./cordis.patch.yml] 已配置`)
  }

  const files = Array.isArray(pkg.files) ? pkg.files : []
  for (const required of ['cordis.patch.yml']) {
    if (bundlePatch && !files.includes(required)) {
      warn('pkg.files', `${PREFIX} files 未包含 ${required}（npm 不会自动附带 patch 文件）`)
    }
  }
  if (!files.some((f) => f === 'lib' || f.startsWith('lib/'))) warn('pkg.files', `${PREFIX} files 未包含 lib/ 产物`)
  if (!existsSync(join(pkgDir, 'README.md')) && !existsSync(join(pkgDir, 'README.zh.md'))) warn('pkg.readme', `${PREFIX} 缺少 README（npm 自动附带，但官方包均提供双语 README）`)
  if (!existsSync(join(pkgDir, 'LICENSE'))) warn('pkg.license-file', `${PREFIX} 缺少 LICENSE 文件`)
  if (pkg.license !== 'MIT') warn('pkg.license', `${PREFIX} license 不是 MIT（官方约定）`)
  if (!pkg.repository) warn('pkg.repository', `${PREFIX} 缺少 repository 字段（官方包均带 type/url/directory）`)
  if (pkg.name && pkg.name.startsWith('@') && !(pkg.publishConfig && pkg.publishConfig.access === 'public')) {
    warn('pkg.publish', `${PREFIX} 带 scope 的包需要 publishConfig.access: public 才能发布`)
  }
  return { name, main }
}

/** cordis.patch.yml 方言检查（与 dsh-app-boot applyEntryPatches 行为对齐） */
function checkPatch(pkg) {
  const patchSpec = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch
  if (!patchSpec) return
  const yaml = loadYaml()
  if (!yaml) {
    fail('patch.yaml', `${PREFIX} 无法解析 cordis.patch.yml：未找到 js-yaml（可用 DSH_RUNTIME_DIR 指向本机运行时）`)
    return
  }
  let rows
  try {
    rows = loadPatchDocument(yaml, join(pkgDir, patchSpec))
  } catch (error) {
    fail('patch.parse', `${PREFIX} cordis.patch.yml 解析失败：${error.message}`)
    return
  }
  if (rows == null) rows = []
  if (!Array.isArray(rows)) {
    fail('patch.shape', `${PREFIX} cordis.patch.yml 顶层必须是条目列表`)
    return
  }
  const ids = new Map() // id -> 是否 group
  const collectIds = (entries) => {
    for (const entry of entries || []) {
      if (!entry || typeof entry !== 'object') continue
      if (typeof entry.id === 'string') {
        if (ids.has(entry.id)) warn('patch.dup-id', `${PREFIX} 重复的条目 id：${entry.id}（后者覆盖前者，patch 目标不确定）`)
        ids.set(entry.id, Boolean(entry.group))
      }
      if (entry.group && Array.isArray(entry.config)) collectIds(entry.config)
    }
  }
  collectIds(rows)

  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      fail('patch.row', `${PREFIX} 存在非对象的条目行`)
      continue
    }
    if (row.insert !== undefined) {
      const allowed = new Set(['id', 'insert', 'config', 'group', 'disabled', 'inject'])
      for (const key of Object.keys(row)) {
        if (!allowed.has(key)) warn('patch.row-key', `${PREFIX} insert 行存在不生效的键：${key}`)
      }
      if (typeof row.id === 'string') {
        if (!ids.has(row.id)) warn('patch.insert-target', `${PREFIX} patch insert: entry ${row.id} not found（loader 会警告并跳过）`)
        else if (!ids.get(row.id)) warn('patch.insert-target', `${PREFIX} patch insert: entry ${row.id} is not a group（loader 会警告并跳过）`)
      }
      if (!Array.isArray(row.insert)) {
        fail('patch.insert', `${PREFIX} insert 的值必须是条目数组`)
        continue
      }
      for (const entry of row.insert) {
        if (!entry || typeof entry !== 'object') {
          fail('patch.entry', `${PREFIX} insert 内含非对象条目`)
          continue
        }
        if (typeof entry.id !== 'string' || !entry.id) {
          warn('patch.entry-id', `${PREFIX} insert 条目缺少 id（官方均为稳定 id，便于后续 patch 精确覆盖）`)
        }
        if (typeof entry.name !== 'string' || !entry.name) {
          fail('patch.entry-name', `${PREFIX} insert 条目缺少 name（loader 按它导入插件模块）`)
        } else if (/\s/.test(entry.name)) {
          warn('patch.entry-name', `${PREFIX} 条目 name 含空白，不是有效的模块标识符：${entry.name}`)
        }
        if (entry.config !== undefined && (entry.config === null || typeof entry.config !== 'object' || Array.isArray(entry.config))) {
          if (!entry.group) fail('patch.entry-config', `${PREFIX} 条目 ${entry.id || entry.name} 的 config 必须是对象（行内 config 整体替换）`)
        }
        if (entry.group !== undefined && typeof entry.group !== 'boolean') warn('patch.entry-group', `${PREFIX} 条目 ${entry.id || entry.name} 的 group 应为布尔值`)
      }
    } else {
      // 覆盖/更新行：loader 要求必有 id
      if (typeof row.id !== 'string' || !row.id) fail('patch.row-id', `${PREFIX} 非 insert 的 patch 行缺少 id（loader 会报 id is required 并跳过）`)
      else if (!ids.has(row.id)) warn('patch.row-target', `${PREFIX} patch: entry ${row.id} not found（loader 会警告并跳过）`)
    }
  }
  ok('patch', `${PREFIX} cordis.patch.yml 语法与条目形态检查完成（共 ${rows.length} 行）`)
}

/** 插件入口的 cordis 契约（静态启发式；最终以运行时为准） */
function checkPluginEntry(pkg, main) {
  const entryPath = join(pkgDir, main)
  if (!existsSync(entryPath)) return
  const source = readFileSync(entryPath, 'utf8')
  const check = syntaxCheck(source, pkg.type === 'module')
  if (!check.ok) {
    fail('entry.syntax', `${PREFIX} 入口语法检查失败：${check.stderr.split('\n').filter(Boolean).slice(0, 3).join(' | ')}`)
  } else {
    ok('entry.syntax', `${PREFIX} ${main} 语法检查通过`)
  }
  if (!/export\s+default|as\s+default|module\.exports/.test(source)) {
    warn('entry.export', `${PREFIX} 未发现默认导出（cordis 插件须默认导出函数/类/{apply} 对象）`)
    return
  }
  ok('entry.export', `${PREFIX} 检测到默认导出`)
  // Config schema：官方发布包均为 `export const Config = z.object(...)`（不限于类 static/行首），
  // 识别任意位置的 `Config = z.` 形态。
  if (!/static\s+Config\s*=|Config\s*[:=]\s*z\./.test(source)) {
    warn('entry.config-schema', `${PREFIX} 未发现 Config schema（schemastery z）—— 插件配置将不做校验`)
  }
  if (!/static\s+inject\s*=|@Inject|inject\s*[:=]/.test(source)) {
    warn('entry.inject', `${PREFIX} 未发现 inject 声明 —— 插件将在无依赖等待语义下直接加载`)
  }
  if (/extends\s+Service|super\s*\(\s*ctx\s*,\s*['"]/.test(source)) {
    ok('entry.service', `${PREFIX} 检测到 Service 形态（向 ctx 提供服务）`)
  }
  // 可逆性：cordis v4 没有 'dispose' 事件（官方插件均用 ctx.effect 做 fiber 级清理），
  // 识别两种形态：旧式 on('dispose') 与 v4 的 ctx.effect(...) 作用域清理。
  if (/on\s*\(\s*['"]dispose/.test(source) || /\.effect\s*\(/.test(source)) {
    ok('entry.dispose', `${PREFIX} 检测到可逆清理（on('dispose') 或 ctx.effect 作用域清理）`)
  } else {
    warn('entry.dispose', `${PREFIX} 未发现 dispose 清理 —— HMR 反复挂载时可能泄漏副作用`)
  }
}

/** 可选：调用 dsh --dump-config 验证组合（输出重定向到文件，避免管道限制） */
function checkDumpConfig(pkg, profile) {
  const bin = join(RUNTIME_DIR, 'node_modules', '.bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
  if (!existsSync(bin)) {
    warn('dump.bin', `${PREFIX} 未找到 dsh CLI：${bin}（可设置 DSH_RUNTIME_DIR）`)
    return
  }
  const tmpDir = mkdtempSync(join(os.tmpdir(), 'plugin-dump-'))
  const outFile = join(tmpDir, 'out.txt')
  const errFile = join(tmpDir, 'err.txt')
  const outFd = openSync(outFile, 'w')
  const errFd = openSync(errFile, 'w')
  try {
    const result = spawnSync(bin, ['--profile', profile, '--dump-config'], {
      stdio: ['ignore', outFd, errFd],
      shell: process.platform === 'win32',
      env: process.env,
    })
    const stdout = readFileSync(outFile, 'utf8')
    const stderr = readFileSync(errFile, 'utf8')
    if (result.status !== 0) {
      const detail = stderr.split('\n').filter(Boolean).slice(0, 4).join(' | ')
      fail('dump.exit', `${PREFIX} dsh --profile ${profile} --dump-config 退出码 ${result.status}${detail ? `：${detail}` : ''}`)
    } else {
      ok('dump.exit', `${PREFIX} dsh --dump-config 执行成功`)
      if (/not found|skipping|id is required|name mismatch/i.test(stderr)) {
        warn('dump.patch-warn', `${PREFIX} dump 输出含 patch 告警：${stderr.split('\n').filter(Boolean).slice(0, 3).join(' | ')}`)
      }
      if (pkg.name && !stdout.includes(String(pkg.name))) {
        warn('dump.layer', `${PREFIX} dump 中未找到包名 ${pkg.name} —— bundle 层可能未生效`)
      }
    }
  } finally {
    closeSync(outFd)
    closeSync(errFd)
    unlinkSync(outFile)
    unlinkSync(errFile)
    require('node:fs').rmdirSync(tmpDir)
  }
}

if (!existsSync(join(pkgDir, 'package.json'))) {
  console.error(`${PREFIX} 目录中没有 package.json：${pkgDir}`)
  process.exit(1)
}

// 容忍 BOM（如 PowerShell 写出）与 JSON 解析失败，保证检查器输出可控而不是崩溃
let pkg
try {
  pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8').replace(/^\uFEFF/, ''))
} catch (error) {
  console.error(`${PREFIX} package.json 解析失败：${error.message}`)
  process.exit(1)
}
console.log(`${PREFIX} 检查目录：${pkgDir}`)
console.log(`${PREFIX} 运行时基准：@deepseek-ai/dsh（本机 ${RUNTIME_DIR}）\n`)

const { name, main } = checkPackageJson(pkg)
checkPatch(pkg)
checkPluginEntry(pkg, main)
if (dumpProfile) checkDumpConfig(pkg, dumpProfile)

const errors = results.filter((r) => r.level === 'fail')
const warns = results.filter((r) => r.level === 'warn')
for (const r of results) {
  const tag = r.level === 'fail' ? 'FAIL' : r.level === 'warn' ? 'WARN' : 'OK  '
  console.log(`[${tag}] ${r.message}`)
}
console.log(`\n${PREFIX} 汇总：${results.length} 项检查，${warns.length} 个警告，${errors.length} 个错误`)
process.exit(errors.length > 0 || (STRICT && warns.length > 0) ? 1 : 0)
