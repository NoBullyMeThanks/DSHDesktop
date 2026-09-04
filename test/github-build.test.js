'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const tar = require('tar')
const build = require('../src/github-build.js')

const VERSION = '0.1.2-alpha.1'
const TAG = `dsh-v${VERSION}`

function tmpDir(t, prefix = 'dshdesktop-build-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 生成一个含 package/ 结构与清单文件的 tarball。 */
async function packFixture(target, entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshdesktop-pack-'))
  for (const [rel, content] of Object.entries(entries)) {
    const full = path.join(root, 'package', rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n')
  }
  fs.rmSync(target, { force: true })
  await tar.c({ gzip: true, file: target, cwd: root, portable: true }, ['package'])
  fs.rmSync(root, { recursive: true, force: true })
  return target
}

/** 官方 release 源码 fixture：根 manifest（含 packageManager）+ apps/cli + vendor/cosmokit。 */
async function makeSourceTgz(target, cliVersion = VERSION) {
  return packFixture(target, {
    'package.json': {
      name: '@deepseek-ai/dsh-root',
      version: cliVersion,
      private: true,
      packageManager: 'pnpm@11.7.0',
      scripts: { build: 'echo ok', 'build:official': 'echo ok', 'release:verify': 'echo ok' },
    },
    'apps/cli/package.json': { name: '@deepseek-ai/dsh', version: cliVersion, bin: { dsh: 'lib/bin.js' } },
    'vendor/cosmokit/package.json': { name: '@deepseek-ai/cosmokit', version: '4.1.0' },
    'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
  })
}

/** 释放源码下载 mock：把 fixture tgz 复制到目标文件。 */
function sourceDownloadMock(fixture) {
  return async (tag, destFile) => {
    if (fixture) fs.copyFileSync(fixture, destFile)
    else fs.writeFileSync(destFile, '')
    return { ok: true, bytes: fs.existsSync(destFile) ? fs.statSync(destFile).size : 0 }
  }
}

/** 预置一个「已装好」的 runtime 目录（模拟 npm install 后的状态）。 */
function seedRuntime(runtimeDir, version = VERSION) {
  const dshDir = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh')
  fs.mkdirSync(path.join(dshDir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(dshDir, 'package.json'), JSON.stringify({ version, name: '@deepseek-ai/dsh' }))
  fs.writeFileSync(path.join(dshDir, 'lib', 'bin.js'), '')
}

/** 生成完整 tarball 集合（dsh 家族 + vendor + landlock entry）。 */
async function makeTarballSet(dir, version = VERSION) {
  const root = path.join(dir, 'tarballs')
  fs.mkdirSync(path.join(root, 'dsh'), { recursive: true })
  fs.mkdirSync(path.join(root, 'vendor'), { recursive: true })
  fs.mkdirSync(path.join(root, 'landlock'), { recursive: true })
  await packFixture(path.join(root, 'dsh', `deepseek-ai-dsh-${version}.tgz`), {
    'package.json': { name: '@deepseek-ai/dsh', version, bin: { dsh: 'lib/bin.js' } },
  })
  await packFixture(path.join(root, 'vendor', 'deepseek-ai-cosmokit-4.1.0.tgz'), {
    'package.json': { name: '@deepseek-ai/cosmokit', version: '4.1.0' },
  })
  await packFixture(path.join(root, 'landlock', 'deepseek-ai-node-addon-landlock-run-0.1.1.tgz'), {
    'package.json': { name: '@deepseek-ai/node-addon-landlock-run', version: '0.1.1' },
  })
  return root
}

/** 对话式 runner：npm config 返回配置；npm install(--prefix pnpm) 时可选创建 pnpm.cjs；
 *  以 node pnpm.cjs 派发的 pack 命令模拟输出对应家族的 tarball。 */
function makeRunner(calls, { installFailCount = 0, provisionPnpm = true, packInto = null } = {}) {
  let failLeft = installFailCount
  return async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, opts })
    if (cmd === 'npm' && args[0] === 'config') return { ok: true, code: 0, out: 'https://registry.npmjs.org/\n' }
    if (cmd === 'npm' && args[0] === 'install') {
      if (failLeft > 0 && !args.includes('--legacy-peer-deps') && !args.includes('--prefix')) {
        failLeft -= 1
        return { ok: false, code: 1, err: 'npm error code E404' }
      }
      // pnpm JS 包的安装：创建 pnpm.cjs 让 provisionPnpm 的校验通过
      if (provisionPnpm && args.includes('--prefix')) {
        const prefixIndex = args.indexOf('--prefix')
        const pnpmCli = path.join(args[prefixIndex + 1], 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
        fs.mkdirSync(path.dirname(pnpmCli), { recursive: true })
        fs.writeFileSync(pnpmCli, '#!/usr/bin/env node\n')
      }
      return { ok: true, code: 0 }
    }
    if (cmd === 'node' && args.some((a) => String(a).endsWith('pnpm.cjs')) && args.includes('--pack-destination')) {
      const destIndex = args.indexOf('--pack-destination')
      const destDir = args[destIndex + 1]
      const family = path.basename(destDir)
      fs.mkdirSync(destDir, { recursive: true })
      if (family === 'dsh') {
        await packFixture(path.join(destDir, `deepseek-ai-dsh-${VERSION}.tgz`), {
          'package.json': { name: '@deepseek-ai/dsh', version: VERSION, bin: { dsh: 'lib/bin.js' } },
        })
      } else if (family === 'vendor') {
        await packFixture(path.join(destDir, 'deepseek-ai-cosmokit-4.1.0.tgz'), {
          'package.json': { name: '@deepseek-ai/cosmokit', version: '4.1.0' },
        })
      } else if (family === 'landlock') {
        await packFixture(path.join(destDir, 'deepseek-ai-node-addon-landlock-run-0.1.1.tgz'), {
          'package.json': { name: '@deepseek-ai/node-addon-landlock-run', version: '0.1.1' },
        })
      } else {
        return { ok: false, code: 1, err: `unexpected pack dest ${destDir}` }
      }
      return { ok: true, code: 0 }
    }
    return { ok: true, code: 0 }
  }
}

// ── 前置检查 ──────────────────────────────────────────────────────────────────

test('checkPrereqs 按官方 engines 校验 Node 版本', () => {
  assert.equal(build.checkPrereqs({ nodeVersion: '24.0.0' }).ok, true)
  assert.equal(build.checkPrereqs({ nodeVersion: 'v24.1.0' }).ok, true)
  assert.equal(build.checkPrereqs({ nodeVersion: '22.19.0' }).ok, true)
  assert.equal(build.checkPrereqs({ nodeVersion: '22.18.0' }).ok, false)
  assert.equal(build.checkPrereqs({ nodeVersion: 'garbage' }).ok, false)
  const err = build.checkPrereqs({ nodeVersion: '20.11.0' })
  assert.equal(err.errors[0].key, 'githubPrereqNode')
  assert.equal(err.errors[0].required, build.NODE_ENGINES)
})

test('checkPrereqs 磁盘不足时报错；不提供磁盘探测时跳过磁盘检查', () => {
  assert.equal(build.checkPrereqs({ nodeVersion: '24.0.0', getDiskFree: () => 5 * 1024 ** 3 }).ok, false)
  assert.equal(build.checkPrereqs({ nodeVersion: '24.0.0', getDiskFree: () => 7 * 1024 ** 3 }).ok, true)
  assert.equal(build.checkPrereqs({ nodeVersion: '24.0.0', getDiskFree: () => { throw new Error('boom') } }).ok, false)
})

// ── pnpm 版本解析与构建环境 ───────────────────────────────────────────────────

test('pnpmVersionFromManifest 读取官方 packageManager 字段', (t) => {
  const dir = tmpDir(t)
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ packageManager: 'pnpm@11.7.0' }))
  assert.equal(build.pnpmVersionFromManifest(dir), '11.7.0')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({}))
  assert.equal(build.pnpmVersionFromManifest(dir), null)
  assert.equal(build.pnpmVersionFromManifest(path.join(dir, 'missing')), null)
})

test('buildEnv 固定 store、关闭遥测并摘除发布上下文变量', () => {
  process.env.RELEASE_PUBLISH = 'true'
  process.env.GITHUB_REF = 'refs/tags/dsh-v0.1.2-alpha.1'
  try {
    const env = build.buildEnv()
    assert.equal(env.DSH_TELEMETRY_DISABLED, '1')
    assert.equal(env.PNPM_CONFIG_STORE_DIR, build.PNPM_STORE_DIR)
    assert.ok(!Object.hasOwn(env, 'RELEASE_PUBLISH'))
    assert.ok(!Object.hasOwn(env, 'GITHUB_REF'))
    assert.ok(!Object.hasOwn(env, 'DSH_CLIENT_COMMIT_HASH'))
    const withCommit = build.buildEnv({ commit: 'cd5ef8148158c3a752a658978873241fdf8e2bbc' })
    assert.equal(withCommit.DSH_CLIENT_COMMIT_HASH, 'cd5ef8148158c3a752a658978873241fdf8e2bbc')
    const invalid = build.buildEnv({ commit: 'not-a-hash' })
    assert.ok(!Object.hasOwn(invalid, 'DSH_CLIENT_COMMIT_HASH'))
  } finally {
    delete process.env.RELEASE_PUBLISH
    delete process.env.GITHUB_REF
  }
})

// ── pnpm CLI 安装（npm registry 官方 JS 包） ──────────────────────────────────

test('provisionPnpm 经 npm registry 安装 pnpm JS 包，缓存命中不再安装', async (t) => {
  const toolchainDir = tmpDir(t)
  const calls = []
  const runner = makeRunner(calls, { provisionPnpm: true })
  const first = await build.provisionPnpm({ pnpmVersion: '11.7.0', toolchainDir, runner, probe: async () => true, log: () => {} })
  assert.equal(first.ok, true)
  assert.ok(first.pnpmCli.endsWith(path.join('node_modules', 'pnpm', 'bin', 'pnpm.cjs')))
  assert.ok(fs.existsSync(first.pnpmCli))
  assert.ok(fs.existsSync(path.join(toolchainDir, 'pnpm.version')))
  const installs = calls.filter((c) => c.cmd === 'npm' && c.args.includes('--prefix'))
  assert.equal(installs.length, 1)
  assert.equal(installs[0].args.includes(`pnpm@11.7.0`), true)
  const second = await build.provisionPnpm({ pnpmVersion: '11.7.0', toolchainDir, runner, probe: async () => true, log: () => {} })
  assert.equal(second.cached, true)
  assert.equal(calls.filter((c) => c.cmd === 'npm' && c.args.includes('--prefix')).length, 1)
})

test('provisionPnpm 全部 registry 源失败时返回错误', async (t) => {
  const toolchainDir = tmpDir(t)
  const runner = async (cmd, args) => {
    if (cmd === 'npm' && args[0] === 'config') return { ok: true, code: 0, out: 'https://registry.npmjs.org/\n' }
    return { ok: false, code: 1, err: 'npm error code E404' }
  }
  const res = await build.provisionPnpm({ pnpmVersion: '11.7.0', toolchainDir, runner, probe: async () => false, log: () => {} })
  assert.equal(res.ok, false)
  assert.match(res.error, /无法安装 pnpm/)
})

test('provisionPnpm 安装完成但 pnpm.cjs 缺失时报错', async (t) => {
  const toolchainDir = tmpDir(t)
  const runner = async (cmd, args) => {
    if (cmd === 'npm' && args[0] === 'config') return { ok: true, code: 0, out: 'https://registry.npmjs.org/\n' }
    return { ok: true, code: 0 } // 不创建 pnpm.cjs
  }
  const res = await build.provisionPnpm({ pnpmVersion: '11.7.0', toolchainDir, runner, probe: async () => true, log: () => {} })
  assert.equal(res.ok, false)
})

// ── 源码获取 ──────────────────────────────────────────────────────────────────

test('acquireSource 下载解压并校验 apps/cli 版本；完成后缓存复用', async (t) => {
  const buildDir = tmpDir(t)
  const fixture = await makeSourceTgz(path.join(buildDir, 'fixture.tgz'))
  let downloads = 0
  const downloadSourceTarball = async (tag, destFile) => {
    downloads += 1
    fs.copyFileSync(fixture, destFile)
    return { ok: true, bytes: 1 }
  }
  const first = await build.acquireSource({
    buildDir, version: VERSION, tag: TAG, downloadSourceTarball, log: () => {},
  })
  assert.equal(first.ok, true)
  assert.equal(first.cached, false)
  assert.equal(downloads, 1)
  assert.equal(JSON.parse(fs.readFileSync(path.join(first.sourceDir, 'apps', 'cli', 'package.json'), 'utf8')).version, VERSION)
  const second = await build.acquireSource({
    buildDir, version: VERSION, tag: TAG, downloadSourceTarball, log: () => {},
  })
  assert.equal(second.cached, true)
  assert.equal(downloads, 1)
})

test('acquireSource 版本不匹配时失败', async (t) => {
  const buildDir = tmpDir(t)
  const fixture = await makeSourceTgz(path.join(buildDir, 'fixture.tgz'), '0.1.2-alpha.2')
  const res = await build.acquireSource({
    buildDir, version: VERSION, tag: TAG,
    downloadSourceTarball: async (tag, dest) => { fs.copyFileSync(fixture, dest); return { ok: true, bytes: 1 } },
    log: () => {},
  })
  assert.equal(res.ok, false)
  assert.match(res.error, /版本校验失败/)
})

// ── 家族成员枚举与打包 ────────────────────────────────────────────────────────

test('collectFamilyMembers 按官方家族规则枚举（dsh 排除 experimental）', (t) => {
  const sourceDir = tmpDir(t)
  const mk = (rel, name, version) => {
    const dir = path.join(sourceDir, rel)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }))
  }
  mk('apps/cli', '@deepseek-ai/dsh', VERSION)
  mk('apps/support', '@deepseek-ai/dsh-test-support', VERSION)
  mk('packages/boot/app-boot', '@deepseek-ai/dsh-app-boot', VERSION)
  mk('packages/experimental/misc', '@deepseek-ai/dsh-x', VERSION)
  mk('vendor/cosmokit', '@deepseek-ai/cosmokit', '4.1.0')
  const dsh = build.collectFamilyMembers(sourceDir, 'dsh')
  assert.deepEqual(dsh.map((m) => m.manifest.name), ['@deepseek-ai/dsh', '@deepseek-ai/dsh-app-boot', '@deepseek-ai/dsh-test-support'])
  const vendor = build.collectFamilyMembers(sourceDir, 'vendor')
  assert.deepEqual(vendor.map((m) => m.manifest.name), ['@deepseek-ai/cosmokit'])
})

test('packFamily 逐成员 pnpm pack 到 outDir；dsh 家族版本不一致时报错', async (t) => {
  const sourceDir = tmpDir(t)
  const outDir = path.join(tmpDir(t), 'out')
  const pnpmCli = path.join(tmpDir(t), 'pnpm.cjs')
  fs.writeFileSync(pnpmCli, '#!/usr/bin/env node\n')
  const mk = (rel, name, version) => {
    const dir = path.join(sourceDir, rel)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }))
  }
  mk('apps/cli', '@deepseek-ai/dsh', VERSION)
  mk('vendor/cosmokit', '@deepseek-ai/cosmokit', '4.1.0')
  const calls = []
  const runner = async (cmd, args) => { calls.push({ cmd, args }); return { ok: true, code: 0 } }
  const dsh = await build.packFamily({ sourceDir, family: 'dsh', outDir, pnpmCli, runner, log: () => {} })
  assert.equal(dsh.ok, true)
  assert.equal(dsh.count, 1)
  assert.deepEqual(calls[0].args.slice(0, 3), [pnpmCli, '--dir', path.join(sourceDir, 'apps', 'cli')])
  assert.ok(calls[0].args.includes('--pack-destination'))
  const vendor = await build.packFamily({ sourceDir, family: 'vendor', outDir, pnpmCli, runner, log: () => {} })
  assert.equal(vendor.ok, true)
  // 版本不一致
  mk('packages/boot/app-boot', '@deepseek-ai/dsh-app-boot', '9.9.9')
  const conflict = await build.packFamily({ sourceDir, family: 'dsh', outDir, pnpmCli, runner, log: () => {} })
  assert.equal(conflict.ok, false)
  assert.match(conflict.err, /版本不一致/)
})

// ── tarball 集合 ─────────────────────────────────────────────────────────────

test('collectTarballs 枚举 tarball 并解析包名版本', async (t) => {
  const dir = tmpDir(t)
  await makeTarballSet(dir)
  const tarballs = await build.collectTarballs([
    path.join(dir, 'tarballs', 'dsh'),
    path.join(dir, 'tarballs', 'vendor'),
    path.join(dir, 'tarballs', 'landlock'),
  ])
  assert.equal(tarballs.size, 3)
  assert.equal(tarballs.get('@deepseek-ai/dsh').version, VERSION)
  assert.ok(tarballs.get('@deepseek-ai/dsh').url.startsWith('file:'))
})

// ── 装载运行时 ────────────────────────────────────────────────────────────────

test('assembleRuntime 写 file: 依赖清单并装载成功，version.json 记录来源', async (t) => {
  const runtimeDir = tmpDir(t)
  const versionFile = path.join(runtimeDir, 'version.json')
  seedRuntime(runtimeDir)
  const tarballsDir = await makeTarballSet(tmpDir(t))
  const calls = []
  const runner = makeRunner(calls)
  const res = await build.assembleRuntime({
    runtimeDir, versionFile, runner, probe: async () => true,
    version: VERSION, tag: TAG, commit: 'abc123',
    tarballDirs: ['dsh', 'vendor', 'landlock'].map((name) => path.join(tarballsDir, name)),
    log: () => {},
  })
  assert.equal(res.ok, true)
  assert.equal(res.version, VERSION)
  const manifest = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'package.json'), 'utf8'))
  assert.ok(manifest.dependencies['@deepseek-ai/dsh'].startsWith('file:'))
  assert.ok(Object.hasOwn(manifest.dependencies, '@deepseek-ai/cosmokit'))
  const meta = JSON.parse(fs.readFileSync(versionFile, 'utf8'))
  assert.equal(meta.source, 'github')
  assert.equal(meta.github.tag, TAG)
  assert.equal(meta.github.commit, 'abc123')
  const install = calls.find((c) => c.cmd === 'npm' && c.args[0] === 'install')
  assert.ok(install)
  assert.ok(!install.args.includes('--legacy-peer-deps'))
})

test('assembleRuntime 普通解析失败时回退 --legacy-peer-deps 重试', async (t) => {
  const runtimeDir = tmpDir(t)
  const versionFile = path.join(runtimeDir, 'version.json')
  seedRuntime(runtimeDir)
  const tarballsDir = await makeTarballSet(tmpDir(t))
  const calls = []
  const runner = makeRunner(calls, { installFailCount: 1 })
  const res = await build.assembleRuntime({
    runtimeDir, versionFile, runner, probe: async () => true,
    version: VERSION,
    tarballDirs: ['dsh', 'vendor', 'landlock'].map((name) => path.join(tarballsDir, name)),
    log: () => {},
  })
  assert.equal(res.ok, true)
  const installs = calls.filter((c) => c.cmd === 'npm' && c.args[0] === 'install')
  assert.equal(installs.length, 2)
  assert.ok(installs[1].args.includes('--legacy-peer-deps'))
})

test('assembleRuntime 全部失败时恢复原 runtime manifest', async (t) => {
  const runtimeDir = tmpDir(t)
  const original = JSON.stringify({ private: true, dependencies: { '@deepseek-ai/dsh': '0.0.1' } })
  fs.writeFileSync(path.join(runtimeDir, 'package.json'), original)
  const tarballsDir = await makeTarballSet(tmpDir(t))
  const runner = async (cmd, args) => {
    if (cmd === 'npm' && args[0] === 'config') return { ok: true, code: 0, out: 'https://registry.npmjs.org/\n' }
    return { ok: false, code: 1, err: 'npm error code E404' }
  }
  const res = await build.assembleRuntime({
    runtimeDir, versionFile: path.join(runtimeDir, 'version.json'), runner, probe: async () => true,
    version: VERSION,
    tarballDirs: ['dsh', 'vendor', 'landlock'].map((name) => path.join(tarballsDir, name)),
    log: () => {},
  })
  assert.equal(res.ok, false)
  assert.equal(fs.readFileSync(path.join(runtimeDir, 'package.json'), 'utf8'), original)
})

test('assembleRuntime 缺少 @deepseek-ai/dsh tarball 时报错', async (t) => {
  const runtimeDir = tmpDir(t)
  const dir = tmpDir(t)
  fs.mkdirSync(path.join(dir, 'vendor'), { recursive: true })
  await packFixture(path.join(dir, 'vendor', 'a-1.0.0.tgz'), { 'package.json': { name: 'a', version: '1.0.0' } })
  const res = await build.assembleRuntime({ runtimeDir, probe: async () => true, version: VERSION, tarballDirs: [path.join(dir, 'vendor')], log: () => {} })
  assert.equal(res.ok, false)
  assert.match(res.err, /缺少 @deepseek-ai\/dsh/)
})

// ── 完整构建编排 ──────────────────────────────────────────────────────────────

test('installGithubRelease 依官方顺序执行全部步骤并装载，成功后清理源码', async (t) => {
  const work = tmpDir(t)
  const buildRoot = path.join(work, 'build')
  const runtimeDir = path.join(work, 'runtime')
  const versionFile = path.join(runtimeDir, 'version.json')
  const toolchainDir = path.join(buildRoot, 'toolchain')
  seedRuntime(runtimeDir)
  const sourceFixture = await makeSourceTgz(path.join(work, 'source.tgz'))
  const calls = []
  const runner = makeRunner(calls)
  const statuses = []
  const res = await build.installGithubRelease(VERSION, {
    buildRoot,
    toolchainDir,
    runtimeDir,
    versionFile,
    runner,
    probe: async () => true,
    nodeVersion: '24.0.0',
    tag: TAG,
    commit: 'abcdef1',
    log: () => {},
    onStatus: (key) => statuses.push(key),
    downloadSourceTarball: sourceDownloadMock(sourceFixture),
    // 模拟从 GitHub API 解析 commit（options.commit 优先于该结果）
    resolveCommit: async () => 'def9876cafe',
  })
  assert.equal(res.ok, true)
  assert.equal(res.version, VERSION)
  // 构建步骤环境注入 DSH_CLIENT_COMMIT_HASH（来自 options.commit）
  assert.ok(calls.some((c) => c.opts?.env?.DSH_CLIENT_COMMIT_HASH === 'abcdef1'))
  const commands = calls.map((c) => `${c.cmd} ${c.args.join(' ')}`)
  assert.ok(commands.some((c) => c.includes('npm install --prefix') && c.includes('pnpm@11.7.0')))
  assert.ok(commands.some((c) => c.includes('install --frozen-lockfile')))
  assert.ok(commands.some((c) => c.includes('release:verify') && c.includes('--family dsh')))
  assert.ok(commands.some((c) => c.includes('run build:official')))
  assert.ok(commands.some((c) => /pack --pack-destination/.test(c) && c.includes('apps\\cli')))
  assert.ok(commands.some((c) => /pack --pack-destination/.test(c) && c.includes('vendor\\cosmokit')))
  assert.ok(commands.some((c) => c.includes('--dir native/landlock-run run build:ts')))
  assert.ok(commands.some((c) => /pack --pack-destination/.test(c) && c.includes('landlock-run')))
  assert.ok(commands.some((c) => c.startsWith('npm install --no-audit')))
  // 官方步骤顺序
  const order = calls.map((c) => c.args.join(' '))
  const find = (sub) => order.findIndex((line) => line.includes(sub))
  assert.ok(find('install --frozen-lockfile') < find('release:verify --family dsh'))
  assert.ok(find('release:verify --family dsh') < find('run build:official'))
  const packDsh = order.findIndex((line) => /--pack-destination.*tarballs[\\/]dsh/.test(line))
  const packVendor = order.findIndex((line) => /--pack-destination.*tarballs[\\/]vendor/.test(line))
  assert.ok(packDsh !== -1 && packVendor !== -1 && packDsh < packVendor)
  // 阶段状态与清理
  assert.ok(statuses.includes('githubBuildPhaseDeps'))
  assert.ok(statuses.includes('githubBuildPhaseAssemble'))
  assert.ok(!fs.existsSync(path.join(buildRoot, VERSION, 'src')))
  assert.ok(fs.existsSync(path.join(buildRoot, VERSION, 'tarballs', 'dsh')))
  assert.equal(JSON.parse(fs.readFileSync(versionFile, 'utf8')).source, 'github')
})

test('installGithubRelease 前置检查失败时不触碰构建目录', async (t) => {
  const work = tmpDir(t)
  const res = await build.installGithubRelease(VERSION, {
    buildRoot: path.join(work, 'build'),
    nodeVersion: '20.11.0',
    log: () => {},
  })
  assert.equal(res.ok, false)
  assert.equal(res.prereq.length, 1)
  assert.equal(fs.existsSync(path.join(work, 'build')), false)
})

test('installGithubRelease 被取消时返回 cancelled', async (t) => {
  const work = tmpDir(t)
  const sourceFixture = await makeSourceTgz(path.join(work, 'source.tgz'))
  const res = await build.installGithubRelease(VERSION, {
    buildRoot: path.join(work, 'build'),
    runtimeDir: path.join(work, 'runtime'),
    toolchainDir: path.join(work, 'toolchain'),
    runner: makeRunner([]),
    probe: async () => true,
    nodeVersion: '24.0.0',
    isAborted: () => true,
    log: () => {},
    downloadSourceTarball: sourceDownloadMock(sourceFixture),
  })
  assert.equal(res.ok, false)
  assert.equal(res.cancelled, true)
})

test('installGithubRelease 把内部 error 字段归一化为 err（进度弹窗不再显示 unknown error）', async (t) => {
  const work = tmpDir(t)
  const res = await build.installGithubRelease(VERSION, {
    buildRoot: path.join(work, 'build'),
    runtimeDir: path.join(work, 'runtime'),
    toolchainDir: path.join(work, 'toolchain'),
    runner: makeRunner([]),
    probe: async () => true,
    nodeVersion: '24.0.0',
    tag: TAG,
    log: () => {},
    downloadSourceTarball: async () => ({ ok: false, error: 'HTTP 403' }),
  })
  assert.equal(res.ok, false)
  assert.equal(typeof res.err, 'string')
  assert.match(res.err, /源码下载失败/)
})

// ── 缓存修复 ──────────────────────────────────────────────────────────────────

test('reinstallFromCache 缓存缺失返回 missing', async (t) => {
  const runtimeDir = tmpDir(t)
  const res = await build.reinstallFromCache(VERSION, {
    buildRoot: path.join(tmpDir(t), 'build'),
    runtimeDir,
    versionFile: path.join(runtimeDir, 'version.json'),
    probe: async () => true,
    log: () => {},
  })
  assert.equal(res.ok, false)
  assert.equal(res.missing, true)
})

test('reinstallFromCache 有缓存时直接装载且不触发 pnpm', async (t) => {
  const work = tmpDir(t)
  const runtimeDir = path.join(work, 'runtime')
  const versionFile = path.join(runtimeDir, 'version.json')
  seedRuntime(runtimeDir)
  await makeTarballSet(path.join(work, 'build', VERSION))
  fs.writeFileSync(versionFile, JSON.stringify({ installed: VERSION, source: 'github', github: { tag: TAG } }))
  const calls = []
  const runner = makeRunner(calls)
  const res = await build.reinstallFromCache(VERSION, {
    buildRoot: path.join(work, 'build'),
    runtimeDir,
    versionFile,
    runner,
    probe: async () => true,
    log: () => {},
  })
  assert.equal(res.ok, true)
  assert.equal(calls.some((c) => c.cmd === 'pnpm'), false)
})

// ── 取消入口 ──────────────────────────────────────────────────────────────────

test('abortBuild 幂等：无活动子进程时调用不抛错', () => {
  build.abortBuild()
  build.abortBuild()
})

// ── GitHub 来源校正（npm 同步后切回 npm 并清理构建产物） ─────────────────────

/**
 * 切换场景 runner：config 返回官方源；view 按 synced 模拟 npm 是否已发布；
 * install 前 failInstallAttempts 次失败（覆盖 installVersion 的多源循环），
 * 之后的调用成功——供 reinstallFromCache 的恢复路径使用。
 */
function makeSwitchRunner(calls, { synced = true, failInstallAttempts = 0 } = {}) {
  let installCount = 0
  return async (cmd, args) => {
    calls.push({ cmd, args })
    if (cmd === 'npm' && args[0] === 'config') return { ok: true, code: 0, out: 'https://registry.npmjs.org/\n' }
    if (cmd === 'npm' && args[0] === 'view') {
      if (!synced) return { ok: false, code: 1, err: 'npm error code E404' }
      return { ok: true, code: 0, out: JSON.stringify(VERSION) }
    }
    if (cmd === 'npm' && args[0] === 'install') {
      installCount += 1
      return installCount <= failInstallAttempts
        ? { ok: false, code: 1, err: 'npm error code E404' }
        : { ok: true, code: 0 }
    }
    return { ok: true, code: 0 }
  }
}

/** 预置「GitHub 构建」状态：已装 runtime + version.json(source=github) + 构建产物目录。 */
function seedGithubBuildRuntime(t) {
  const work = tmpDir(t)
  const runtimeDir = path.join(work, 'runtime')
  const versionFile = path.join(runtimeDir, 'version.json')
  const buildRoot = path.join(work, 'build')
  const buildDir = path.join(buildRoot, VERSION)
  seedRuntime(runtimeDir, VERSION)
  fs.writeFileSync(versionFile, JSON.stringify({
    installed: VERSION,
    source: 'github',
    github: { tag: TAG, commit: null },
  }))
  return { work, runtimeDir, versionFile, buildRoot, buildDir }
}

test('switchToNpmWhenSynced：非 GitHub 来源时不切换,但清理历史构建残留', async (t) => {
  const work = tmpDir(t)
  const versionFile = path.join(work, 'version.json')
  const buildRoot = path.join(work, 'build')
  fs.mkdirSync(buildRoot, { recursive: true })
  fs.writeFileSync(path.join(buildRoot, 'sentinel'), 'keep')

  fs.writeFileSync(versionFile, JSON.stringify({ installed: VERSION })) // 无 source 字段
  let res = await build.switchToNpmWhenSynced({ versionFile, buildRoot, log: () => {} })
  assert.equal(res.switched, false)
  assert.equal(res.kept, false)
  assert.equal(fs.existsSync(path.join(buildRoot, 'sentinel')), false) // 残留已清理

  // 版本记录缺失：同样清理残留
  fs.mkdirSync(buildRoot, { recursive: true })
  fs.writeFileSync(path.join(buildRoot, 'sentinel'), 'keep')
  res = await build.switchToNpmWhenSynced({ versionFile: path.join(work, 'missing.json'), buildRoot, log: () => {} })
  assert.equal(res.switched, false)
  assert.equal(fs.existsSync(buildRoot), false)

  // 版本无效：同样清理残留
  fs.mkdirSync(buildRoot, { recursive: true })
  fs.writeFileSync(path.join(buildRoot, 'sentinel'), 'keep')
  fs.writeFileSync(versionFile, JSON.stringify({ installed: 'not-a-version', source: 'github' }))
  res = await build.switchToNpmWhenSynced({ versionFile, buildRoot, log: () => {} })
  assert.equal(res.switched, false)
  assert.equal(fs.existsSync(buildRoot), false)
})

test('switchToNpmWhenSynced：npm 未同步时保持 GitHub 构建,并清理历史版本目录', async (t) => {
  const { runtimeDir, versionFile, buildRoot, buildDir } = seedGithubBuildRuntime(t)
  await makeTarballSet(buildDir)
  // 历史版本目录(模拟 GitHub 领先 npm 多版本时的累积)+ 共享目录
  const historyDir = path.join(buildRoot, '0.1.1-rc.2')
  fs.mkdirSync(path.join(historyDir, 'tarballs'), { recursive: true })
  fs.writeFileSync(path.join(historyDir, 'tarballs', 'stale.tgz'), 'stale')
  fs.mkdirSync(path.join(buildRoot, 'pnpm-store'), { recursive: true })
  fs.mkdirSync(path.join(buildRoot, 'toolchain'), { recursive: true })

  const res = await build.switchToNpmWhenSynced({
    runtimeDir,
    versionFile,
    buildRoot,
    runner: makeSwitchRunner([], { synced: false }),
    probe: async () => true,
    log: () => {},
  })
  assert.equal(res.switched, false)
  assert.equal(res.kept, true)
  assert.equal(res.reason, 'npm-not-synced')
  assert.equal(fs.existsSync(buildDir), true) // 当前版本目录保留（修复兜底）
  assert.equal(fs.existsSync(historyDir), false) // 历史版本目录已清理
  assert.equal(fs.existsSync(path.join(buildRoot, 'pnpm-store')), true) // 共享目录保留
  assert.equal(fs.existsSync(path.join(buildRoot, 'toolchain')), true)
})

test('switchToNpmWhenSynced：npm 已同步时切 npm 并删除全部构建产物', async (t) => {
  const { runtimeDir, versionFile, buildRoot, buildDir } = seedGithubBuildRuntime(t)
  await makeTarballSet(buildDir)
  const calls = []
  const statuses = []
  const res = await build.switchToNpmWhenSynced({
    runtimeDir,
    versionFile,
    buildRoot,
    runner: makeSwitchRunner(calls, { synced: true }),
    probe: async () => true,
    log: () => {},
    onStatus: (key) => statuses.push(key),
  })
  assert.equal(res.switched, true)
  assert.equal(res.version, VERSION)
  assert.equal(fs.existsSync(buildRoot), false) // 整个 build 目录已删除
  assert.ok(statuses.includes('startupSwitchToNpm'))
  const meta = JSON.parse(fs.readFileSync(versionFile, 'utf8'))
  assert.equal(meta.installed, VERSION)
  assert.ok(!Object.hasOwn(meta, 'source')) // source 清空 → 回滚项自动禁用
  // 走 npm view + npm install,不触发 pnpm
  assert.ok(calls.some((c) => c.cmd === 'npm' && c.args[0] === 'view'))
  assert.ok(calls.some((c) => c.cmd === 'npm' && c.args[0] === 'install'))
  assert.ok(!calls.some((c) => c.cmd === 'node' && String(c.args[0] ?? '').endsWith('pnpm.cjs')))
})

test('switchToNpmWhenSynced：npm 安装失败时用缓存 tarballs 恢复并保留构建产物', async (t) => {
  const { runtimeDir, versionFile, buildRoot, buildDir } = seedGithubBuildRuntime(t)
  await makeTarballSet(buildDir)
  const res = await build.switchToNpmWhenSynced({
    runtimeDir,
    versionFile,
    buildRoot,
    // installVersion 的 3 个源全部失败,reinstallFromCache 的第 4 次安装成功
    runner: makeSwitchRunner([], { synced: true, failInstallAttempts: 3 }),
    probe: async () => true,
    log: () => {},
  })
  assert.equal(res.switched, false)
  assert.equal(res.kept, true)
  assert.equal(res.reason, 'install-failed')
  assert.equal(res.restored, true)
  const meta = JSON.parse(fs.readFileSync(versionFile, 'utf8'))
  assert.equal(meta.installed, VERSION)
  assert.equal(meta.source, 'github') // 来源元数据已恢复
  assert.equal(fs.existsSync(buildDir), true) // 构建产物未被删除
})

// ── 目录树删除(rmSync 失败 → robocopy 兜底) ───────────────────────────────────

test('removeDirectoryTree：rmSync 直接成功时不调用 robocopy', async (t) => {
  const dir = tmpDir(t)
  fs.writeFileSync(path.join(dir, 'a.tgz'), 'x')
  const calls = []
  const res = await build.removeDirectoryTree(dir, () => {}, {
    runner: async (cmd, args) => { calls.push({ cmd, args }); return { ok: true, code: 0 } },
  })
  assert.equal(res, true)
  assert.equal(calls.length, 0) // 未走 robocopy
  assert.equal(fs.existsSync(dir), false)
})

test('removeDirectoryTree：rmSync 失败时走 robocopy 空目录镜像兜底', async (t) => {
  const dir = tmpDir(t)
  fs.writeFileSync(path.join(dir, 'dangling.tgz'), 'x')
  const calls = []
  const res = await build.removeDirectoryTree(dir, () => {}, {
    // 模拟 Windows 上含大量 junction 的目录树：rmSync 中途失败
    removeTree: () => { throw new Error('系统无法识别文件名') },
    runner: async (cmd, args) => {
      calls.push({ cmd, args })
      fs.rmSync(dir, { recursive: true, force: true }) // 模拟 robocopy 镜像的删除效果
      return { ok: true, code: 1 }
    },
  })
  assert.equal(res, true)
  assert.equal(fs.existsSync(dir), false)
  const robocopyCall = calls.find((c) => c.cmd === 'robocopy')
  assert.ok(robocopyCall)
  assert.ok(robocopyCall.args.includes('/mir'))
  assert.ok(robocopyCall.args.includes('/nfl'))
})

test('removeDirectoryTree：robocopy 镜像失败时返回 false 且保留目录待重试', async (t) => {
  const dir = tmpDir(t)
  fs.writeFileSync(path.join(dir, 'a.tgz'), 'x')
  const res = await build.removeDirectoryTree(dir, () => {}, {
    removeTree: () => { throw new Error('boom') },
    runner: async () => ({ ok: false, code: 8, err: 'robocopy failed' }),
  })
  assert.equal(res, false)
  assert.equal(fs.existsSync(dir), true) // 目录保留,下次启动再试;失败不阻塞启动
})

test('removeDirectoryTree：robocopy 退出码 2（镜像删除）不依赖 run 的 ok 判定,仍算成功', async (t) => {
  const dir = tmpDir(t)
  fs.writeFileSync(path.join(dir, 'a.tgz'), 'x')
  const res = await build.removeDirectoryTree(dir, () => {}, {
    removeTree: () => { throw new Error('系统无法识别文件名') },
    // 模拟 runtime.run() 的通用语义:非 0 退出码一律 ok:false（robocopy 的 2 会被误标失败）
    runner: async (cmd, args) => {
      fs.rmSync(dir, { recursive: true, force: true }) // 模拟 robocopy 镜像删除效果
      return { ok: false, code: 2, out: '', err: '' }
    },
  })
  assert.equal(res, true)
  assert.equal(fs.existsSync(dir), false) // 空目录也被删除,而不是留下目录壳
})
