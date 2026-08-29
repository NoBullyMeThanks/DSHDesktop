'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const runtime = require('../src/runtime-manager.js')

function createRuntime(t, version = '1.2.3', withBin = true) {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshdesktop-runtime-'))
  const packageDir = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh')
  fs.mkdirSync(path.join(packageDir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ version }))
  if (withBin) fs.writeFileSync(path.join(packageDir, 'lib', 'bin.js'), '')
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }))
  return runtimeDir
}

test('compareVersions 遵循 SemVer 预发布优先级', () => {
  assert.equal(runtime.compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1)
  assert.equal(runtime.compareVersions('1.0.0-rc.7', '1.0.0-rc.8'), -1)
  assert.equal(runtime.compareVersions('1.0.0-1', '1.0.0-alpha'), -1)
  assert.equal(runtime.compareVersions('1.0.0-rc.1', '1.0.0'), -1)
  assert.equal(runtime.compareVersions('1.0.0+build.1', '1.0.0+build.2'), 0)
  assert.equal(runtime.parseVersion('1.2.3garbage'), null)
})

test('Node 可用性不设置版本门槛', () => {
  assert.equal(runtime.nodeIsAvailable('0.0.1'), true)
  assert.equal(runtime.nodeIsAvailable('23.0.0'), true)
  assert.equal(runtime.nodeIsAvailable(''), false)
  assert.equal(runtime.nodeIsAvailable(null), false)
})

test('parseDistTags 解析 npm view --json 的 dist-tags 输出', () => {
  const tags = runtime.parseDistTags('{\n  "latest": "0.1.0-rc.7",\n  "next": "0.1.0-rc.8"\n}\n')
  assert.deepEqual(tags, { latest: '0.1.0-rc.7', next: '0.1.0-rc.8' })
  assert.equal(runtime.parseDistTags('not json'), null)
  assert.equal(runtime.parseDistTags('{ broken'), null)
  assert.equal(runtime.parseDistTags(null), null)
})

test('bestOfTags 取 latest 与 next 中 SemVer 较大者', () => {
  // 官方把 rc.8 挂在 next 而 latest 还停在 rc.7 的场景
  assert.equal(runtime.bestOfTags({ latest: '0.1.0-rc.7', next: '0.1.0-rc.8' }), '0.1.0-rc.8')
  // 只有 latest 时正常返回
  assert.equal(runtime.bestOfTags({ latest: '1.0.0' }), '1.0.0')
  // 正式版大于同主版本号的预发布版
  assert.equal(runtime.bestOfTags({ latest: '1.0.0', next: '1.0.0-rc.1' }), '1.0.0')
  // next 高于 latest 的主/次版本号时取 next
  assert.equal(runtime.bestOfTags({ latest: '0.1.0', next: '0.2.0-rc.1' }), '0.2.0-rc.1')
  // 无效版本被跳过
  assert.equal(runtime.bestOfTags({ latest: 'garbage', next: '0.1.0-rc.8' }), '0.1.0-rc.8')
  assert.equal(runtime.bestOfTags({}), null)
  assert.equal(runtime.bestOfTags(null), null)
})

test('完整运行时直接复用', async (t) => {
  const runtimeDir = createRuntime(t)
  let installs = 0
  const result = await runtime.ensureRuntime({
    runtimeDir,
    installer: async () => { installs += 1; return { ok: true, version: 'unexpected' } },
  })
  assert.deepEqual(result, { ok: true, version: '1.2.3', repaired: false })
  assert.equal(installs, 0)
  assert.equal(runtime.runtimeStatus(runtimeDir).usable, true)
})

test('必需 peer dependency 缺失时运行时不可用，optional peer 不影响', (t) => {
  const runtimeDir = createRuntime(t)
  const packageDir = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-app-boot')
  fs.mkdirSync(packageDir, { recursive: true })
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-app-boot',
    version: '1.2.3',
    peerDependencies: {
      '@deepseek-ai/cordis-plugin-group': '^1.0.1',
      '@deepseek-ai/optional-plugin': '^1.0.0',
    },
    peerDependenciesMeta: {
      '@deepseek-ai/optional-plugin': { optional: true },
    },
  }))
  const status = runtime.runtimeStatus(runtimeDir)
  assert.equal(status.usable, false)
  assert.deepEqual(status.missingPeers, [{
    name: '@deepseek-ai/cordis-plugin-group',
    range: '^1.0.1',
    requiredBy: '@deepseek-ai/dsh-app-boot',
  }])
})

test('peer dependency 已存在但版本不满足范围时运行时不可用', (t) => {
  const runtimeDir = createRuntime(t)
  const consumerDir = path.join(runtimeDir, 'node_modules', 'consumer')
  const peerDir = path.join(runtimeDir, 'node_modules', 'peer-package')
  fs.mkdirSync(consumerDir, { recursive: true })
  fs.mkdirSync(peerDir, { recursive: true })
  fs.writeFileSync(path.join(consumerDir, 'package.json'), JSON.stringify({
    name: 'consumer',
    version: '1.0.0',
    peerDependencies: { 'peer-package': '^2.0.0' },
  }))
  fs.writeFileSync(path.join(peerDir, 'package.json'), JSON.stringify({
    name: 'peer-package',
    version: '1.5.0',
  }))
  const status = runtime.runtimeStatus(runtimeDir)
  assert.equal(status.usable, false)
  assert.deepEqual(status.missingPeers, [{
    name: 'peer-package',
    range: '^2.0.0',
    requiredBy: 'consumer',
  }])
})

test('同名 peer dependency 的版本范围冲突时报告冲突', (t) => {
  const runtimeDir = createRuntime(t)
  for (const [name, range] of [['consumer-a', '^1.0.0'], ['consumer-b', '^2.0.0']]) {
    const consumerDir = path.join(runtimeDir, 'node_modules', name)
    fs.mkdirSync(consumerDir, { recursive: true })
    fs.writeFileSync(path.join(consumerDir, 'package.json'), JSON.stringify({
      name,
      version: '1.0.0',
      peerDependencies: { 'peer-package': range },
    }))
  }
  const status = runtime.runtimeStatus(runtimeDir)
  assert.equal(status.usable, false)
  assert.deepEqual(status.missingPeers, [{
    name: 'peer-package',
    range: null,
    requiredBy: 'consumer-a、consumer-b',
    conflict: true,
    installRange: '^1.0.0',
  }])
})

test('同名 peer dependency 的兼容范围会合并为交集', (t) => {
  const runtimeDir = createRuntime(t)
  for (const [name, range] of [['consumer-a', '^1.0.0'], ['consumer-b', '>=1.5.0 <2.0.0']]) {
    const consumerDir = path.join(runtimeDir, 'node_modules', name)
    fs.mkdirSync(consumerDir, { recursive: true })
    fs.writeFileSync(path.join(consumerDir, 'package.json'), JSON.stringify({
      name,
      version: '1.0.0',
      peerDependencies: { 'peer-package': range },
    }))
  }
  const status = runtime.runtimeStatus(runtimeDir)
  assert.equal(status.usable, false)
  assert.equal(status.missingPeers.length, 1)
  assert.equal(status.missingPeers[0].name, 'peer-package')
  assert.equal(status.missingPeers[0].conflict, undefined)
  assert.match(status.missingPeers[0].range, />=1\.5\.0/)
})

test('isFrontendOnlyPeer 识别纯前端/打包期与 @types 类型包', () => {
  assert.equal(runtime.isFrontendOnlyPeer('react'), true)
  assert.equal(runtime.isFrontendOnlyPeer('react-dom'), true)
  assert.equal(runtime.isFrontendOnlyPeer('@types/react'), true)
  assert.equal(runtime.isFrontendOnlyPeer('@types/node'), true)
  assert.equal(runtime.isFrontendOnlyPeer('@deepseek-ai/cordis'), false)
  assert.equal(runtime.isFrontendOnlyPeer('zod'), false)
  assert.equal(runtime.isFrontendOnlyPeer('ajv'), false)
})

test('纯前端 peer（react/react-dom）不进入缺失报告，其余必需 peer 照常', (t) => {
  const runtimeDir = createRuntime(t)
  for (const [name, peers] of [
    ['use-sync-external-store', { react: '^16.8.0 || ^17.0.0 || ^18.0.0' }],
    ['react-virtual', { react: '^16.8.0 || ^17.0.0 || ^18.0.0 || ^19.0.0', 'react-dom': '^16.8.0 || ^17.0.0 || ^18.0.0 || ^19.0.0' }],
    ['app-boot', { '@deepseek-ai/cordis-plugin-group': '^1.0.1' }],
  ]) {
    const dir = path.join(runtimeDir, 'node_modules', name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', peerDependencies: peers }))
  }
  const status = runtime.runtimeStatus(runtimeDir)
  assert.equal(status.usable, false)
  assert.deepEqual(status.missingPeers, [{
    name: '@deepseek-ai/cordis-plugin-group',
    range: '^1.0.1',
    requiredBy: 'app-boot',
  }])
})

test('只有纯前端 peer 缺失时运行时仍视为可用', (t) => {
  const runtimeDir = createRuntime(t)
  const dir = path.join(runtimeDir, 'node_modules', 'use-sync-external-store')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'use-sync-external-store',
    version: '1.0.0',
    peerDependencies: { react: '^16.8.0 || ^17.0.0 || ^18.0.0' },
  }))
  assert.equal(runtime.runtimeStatus(runtimeDir).usable, true)
})

test('入口缺失时重装当前精确版本', async (t) => {
  const runtimeDir = createRuntime(t, '1.2.3', false)
  let target = null
  let installOptions = null
  const result = await runtime.ensureRuntime({
    runtimeDir,
    installer: async (version, options) => { target = version; installOptions = options; return { ok: true, version } },
  })
  assert.equal(target, '1.2.3')
  assert.equal(installOptions.force, true)
  assert.equal(installOptions.runtimeDir, runtimeDir)
  assert.equal(result.repaired, true)
})

test('无法识别版本时安装 latest', async (t) => {
  const runtimeDir = createRuntime(t, 'not-semver', false)
  let target = null
  const result = await runtime.ensureRuntime({
    runtimeDir,
    installer: async (version, options) => {
      target = version
      assert.equal(options.force, false)
      assert.equal(options.runtimeDir, runtimeDir)
      return { ok: true, version: '2.0.0' }
    },
  })
  assert.equal(target, 'latest')
  assert.equal(result.repaired, false)
})

test('registryAttempts 把显式源列表映射为尝试项', () => {
  assert.deepEqual(runtime.registryAttempts({ registries: ['https://a/', 'https://b/'] }), [
    { registry: 'https://a/' },
    { registry: 'https://b/' },
  ])
})

test('pickRegistries 解析用户配置并按可达性排序', async () => {
  const runner = async (cmd, args) =>
    args[0] === 'config' ? { ok: true, code: 0, out: 'https://registry.npmjs.org/\n' } : { ok: true, code: 0 }
  // 官方不可达、npmmirror 可达、腾讯云不可达 → 只保留 npmmirror
  const probe = async (url) => url.includes('npmmirror')
  const list = await runtime.pickRegistries({ runner, probe })
  assert.deepEqual(list, [{ registry: runtime.REGISTRY_MIRROR }])
})

test('pickRegistries 全部不可达时保留原顺序让 npm 报错', async () => {
  const runner = async (cmd, args) => ({ ok: true, code: 0, out: 'https://registry.npmjs.org/\n' })
  const list = await runtime.pickRegistries({ runner, probe: async () => false })
  assert.equal(list.length, 3)
  assert.equal(list[0].registry, 'https://registry.npmjs.org/')
  assert.equal(list[1].registry, runtime.REGISTRY_MIRROR)
  assert.equal(list[2].registry, runtime.REGISTRY_MIRROR_ALT)
})

test('installVersion 全部源失败时返回含源列表的错误', async (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshdesktop-runtime-'))
  const versionFile = path.join(runtimeDir, 'version.json')
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }))
  const calls = []
  const runner = async (cmd, args, opts) => {
    calls.push({ args, cwd: opts.cwd })
    if (args[0] === 'config') return { ok: true, code: 0, out: 'https://registry.npmjs.org/\n' }
    return { ok: false, code: 1, out: '', err: '模拟安装失败' }
  }
  const result = await runtime.installVersion('0.1.0-rc.8', { runtimeDir, versionFile, runner, probe: async () => false })
  assert.equal(result.ok, false)
  assert.match(result.err, /已尝试 3 个源/)
  assert.equal(calls.length, 4) // config + 3 个源各一次
  assert.deepEqual(calls[1].args.slice(0, 2), ['install', '@deepseek-ai/dsh@0.1.0-rc.8'])
  assert.ok(calls[1].args.includes('--no-audit'))
  assert.ok(calls[1].args.includes('--prefer-offline'))
  assert.ok(calls[1].args.includes('--loglevel=http'))
  assert.ok(calls[1].args.includes('--legacy-peer-deps'))
  assert.ok(calls[1].args.includes('--registry'))
  assert.ok(calls[1].args.includes('https://registry.npmjs.org/'))
  assert.ok(calls[2].args.includes(runtime.REGISTRY_MIRROR))
  assert.ok(calls[3].args.includes(runtime.REGISTRY_MIRROR_ALT))
  assert.equal(calls[1].cwd, runtimeDir)
})

test('isNotFoundError 只识别"版本不存在"类错误', () => {
  const notarget = { ok: false, err: 'npm error code ETARGET\nnpm error notarget No matching version found for @deepseek-ai/dsh-agent-instructions@^0.1.1-rc.2.' }
  const view404 = { ok: false, err: 'npm error 404 No match found for version 0.1.1-rc.2' }
  const eresolveUndefined = { ok: false, err: 'npm error code ERESOLVE\nnpm error ERESOLVE unable to resolve dependency tree\nnpm error Found: @deepseek-ai/dsh-invariants@undefined' }
  const eresolveConflict = { ok: false, err: 'npm error code ERESOLVE\nnpm error ERESOLVE unable to resolve dependency tree\nnpm error Found: react@18.3.1' }
  const other = { ok: false, err: 'npm error code ECONNREFUSED\n模拟网络失败' }
  assert.equal(runtime.isNotFoundError(notarget), true)
  assert.equal(runtime.isNotFoundError(view404), true)
  assert.equal(runtime.isNotFoundError(eresolveUndefined), true)
  assert.equal(runtime.isNotFoundError(eresolveConflict), false)
  assert.equal(runtime.isNotFoundError(other), false)
  assert.equal(runtime.isNotFoundError({ ok: true }), false)
  assert.equal(runtime.isNotFoundError(null), false)
})

test('installVersion 命中"版本不存在"时用 prefer-online 在同一源重试成功', async (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshdesktop-runtime-'))
  const versionFile = path.join(runtimeDir, 'version.json')
  const packageDir = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh')
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }))
  const calls = []
  const runner = async (cmd, args) => {
    calls.push(args)
    if (args[0] === 'config') return { ok: true, code: 0, out: 'https://registry.npmjs.org/\n' }
    if (args.includes('--prefer-online')) {
      // 强制重新校验后模拟装好了运行时（本地缓存过期问题的自愈路径）
      fs.mkdirSync(path.join(packageDir, 'lib'), { recursive: true })
      fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ version: '0.1.1-rc.2' }))
      fs.writeFileSync(path.join(packageDir, 'lib', 'bin.js'), '')
    }
    return args.includes('--prefer-online')
      ? { ok: true, code: 0 }
      : { ok: false, code: 1, err: 'npm error code ETARGET\nnpm error notarget No matching version found for @deepseek-ai/dsh-agent-instructions@^0.1.1-rc.2.' }
  }
  const result = await runtime.installVersion('0.1.1-rc.2', {
    runtimeDir,
    versionFile,
    runner,
    probe: async () => true,
  })
  assert.equal(result.ok, true)
  assert.equal(result.version, '0.1.1-rc.2')
  // config + 第一个源（prefer-offline） + 同源重试（prefer-online）；成功即不再换源
  assert.equal(calls.length, 3)
  assert.ok(calls[1].includes('--prefer-offline'))
  assert.ok(calls[2].includes('--prefer-online'))
  assert.ok(calls[2].includes('https://registry.npmjs.org/'))
  assert.equal(calls[2].includes('--prefer-offline'), false)
})

test('installVersion 所有源均报"版本不存在"时返回错误且每个源都重试一次', async (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshdesktop-runtime-'))
  const versionFile = path.join(runtimeDir, 'version.json')
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }))
  const calls = []
  const runner = async (cmd, args) => {
    calls.push(args)
    if (args[0] === 'config') return { ok: true, code: 0, out: 'https://registry.npmjs.org/\n' }
    return { ok: false, code: 1, err: 'npm error code ETARGET\nnpm error notarget No matching version found for @deepseek-ai/dsh@0.1.1-rc.2.' }
  }
  const result = await runtime.installVersion('0.1.1-rc.2', {
    runtimeDir,
    versionFile,
    runner,
    probe: async () => false,
  })
  assert.equal(result.ok, false)
  assert.match(result.err, /已尝试 3 个源/)
  // config + 3 个源 × (prefer-offline + prefer-online)
  assert.equal(calls.length, 7)
  for (const arg of calls.slice(1)) {
    assert.ok(arg.includes('--prefer-offline') || arg.includes('--prefer-online'))
  }
})

test('installVersion 未确认超时进程退出时不再切换安装源', async (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshdesktop-runtime-'))
  const versionFile = path.join(runtimeDir, 'version.json')
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }))
  const calls = []
  const runner = async (cmd, args) => {
    calls.push(args)
    if (args[0] === 'config') return { ok: true, code: 0, out: 'https://registry.npmjs.org/\n' }
    return {
      ok: false,
      timedOut: true,
      terminationUnconfirmed: true,
      error: new Error('模拟终止未确认'),
    }
  }
  const result = await runtime.installVersion('1.2.3', {
    runtimeDir,
    versionFile,
    runner,
    probe: async () => false,
  })
  assert.equal(result.ok, false)
  assert.match(result.err, /停止切换安装源/)
  assert.equal(calls.length, 2) // config + 第一个源；不得启动第二个 npm
})

test('installVersion 把 npm 输出透传给 onProgress', async (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshdesktop-runtime-'))
  const versionFile = path.join(runtimeDir, 'version.json')
  const packageDir = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh')
  fs.mkdirSync(path.join(packageDir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ version: '1.2.3' }))
  fs.writeFileSync(path.join(packageDir, 'lib', 'bin.js'), '')
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }))
  const chunks = []
  const runner = async (cmd, args, opts) => {
    if (args[0] === 'config') return { ok: true, code: 0, out: 'https://registry.npmjs.org/\n' }
    if (typeof opts.onData === 'function') opts.onData('npm http fetch GET 200 ...tgz 42%')
    return { ok: true, code: 0 }
  }
  const result = await runtime.installVersion('1.2.3', {
    runtimeDir,
    versionFile,
    runner,
    probe: async () => true,
    onProgress: (text) => chunks.push(text),
  })
  assert.equal(result.ok, true)
  assert.equal(result.version, '1.2.3')
  assert.deepEqual(chunks, ['npm http fetch GET 200 ...tgz 42%'])
})

test('installVersion 在 legacy 安装后显式补齐必需 peer dependency', async (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshdesktop-runtime-'))
  const versionFile = path.join(runtimeDir, 'version.json')
  const dshDir = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh')
  const bootDir = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-app-boot')
  fs.mkdirSync(path.join(dshDir, 'lib'), { recursive: true })
  fs.mkdirSync(bootDir, { recursive: true })
  fs.writeFileSync(path.join(runtimeDir, 'package.json'), JSON.stringify({
    private: true,
    dependencies: {
      '@deepseek-ai/dsh': '^1.2.3',
      react: '^16.8.0',
      'react-dom': '^19.0.0',
    },
  }))
  fs.writeFileSync(path.join(dshDir, 'package.json'), JSON.stringify({ version: '1.2.3' }))
  fs.writeFileSync(path.join(dshDir, 'lib', 'bin.js'), '')
  fs.writeFileSync(path.join(bootDir, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-app-boot',
    version: '1.2.3',
    peerDependencies: { '@deepseek-ai/cordis-plugin-group': '^1.0.1' },
  }))
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }))
  const installCalls = []
  const runner = async (cmd, args) => {
    if (args[0] === 'config') return { ok: true, code: 0, out: 'https://registry.npmjs.org/\n' }
    installCalls.push(args)
    if (args.some((arg) => arg.startsWith('@deepseek-ai/cordis-plugin-group@'))) {
      const peerDir = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'cordis-plugin-group')
      fs.mkdirSync(peerDir, { recursive: true })
      fs.writeFileSync(path.join(peerDir, 'package.json'), JSON.stringify({
        name: '@deepseek-ai/cordis-plugin-group',
        version: '1.0.1',
      }))
    }
    return { ok: true, code: 0 }
  }
  const result = await runtime.installVersion('1.2.3', {
    runtimeDir,
    versionFile,
    runner,
    probe: async () => true,
  })
  assert.equal(result.ok, true)
  assert.equal(installCalls.length, 2)
  assert.ok(installCalls[0].includes('--legacy-peer-deps'))
  assert.ok(installCalls[1].includes('@deepseek-ai/cordis-plugin-group@^1.0.1'))
  assert.equal(installCalls[1].includes('--legacy-peer-deps'), false)
  assert.ok(installCalls[1].includes('--no-save'))
  assert.equal(runtime.runtimeStatus(runtimeDir).usable, true)
  const managedManifest = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'package.json'), 'utf8'))
  assert.deepEqual(managedManifest.dependencies, { '@deepseek-ai/dsh': '1.2.3' })
})

test('installVersion 官方源不可达时直达镜像源', async (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshdesktop-runtime-'))
  const versionFile = path.join(runtimeDir, 'version.json')
  const packageDir = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh')
  fs.mkdirSync(path.join(packageDir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ version: '1.2.3' }))
  fs.writeFileSync(path.join(packageDir, 'lib', 'bin.js'), '')
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }))
  const calls = []
  const runner = async (cmd, args) => {
    calls.push(args)
    if (args[0] === 'config') return { ok: true, code: 0, out: 'https://registry.npmjs.org/\n' }
    return { ok: true, code: 0 }
  }
  const probe = async (url) => url.includes('npmmirror')
  const result = await runtime.installVersion('1.2.3', { runtimeDir, versionFile, runner, probe })
  assert.equal(result.ok, true)
  assert.equal(result.version, '1.2.3')
  assert.equal(calls.length, 2) // config + 1 次安装（直达镜像，不再试官方源）
  assert.ok(calls[1].includes('--registry'))
  assert.ok(calls[1].includes(runtime.REGISTRY_MIRROR))
  const vf = JSON.parse(fs.readFileSync(versionFile, 'utf8'))
  assert.equal(vf.installed, '1.2.3')
})


test('installVersion 修复模式先删除损坏包目录，让 npm 真正重新解包', async (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshdesktop-runtime-'))
  const versionFile = path.join(runtimeDir, 'version.json')
  const packageDir = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh')
  // 包目录在（package.json 完好）但 bin.js 缺失：npm install 同版本 --force 不会恢复文件，
  // 修复模式必须先删掉包目录强制重新解包
  fs.mkdirSync(path.join(packageDir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ version: '1.2.3' }))
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }))
  let dirSeenRemoved = null
  const runner = async (cmd, args) => {
    if (args[0] === 'config') return { ok: true, code: 0, out: 'https://registry.npmjs.org/\n' }
    // 断言：npm 安装开始时损坏包目录已被前置清理；随后模拟 npm 重新解包成功
    dirSeenRemoved = !fs.existsSync(packageDir)
    fs.mkdirSync(path.join(packageDir, 'lib'), { recursive: true })
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ version: '1.2.3' }))
    fs.writeFileSync(path.join(packageDir, 'lib', 'bin.js'), '')
    return { ok: true, code: 0 }
  }
  const result = await runtime.installVersion('1.2.3', {
    runtimeDir,
    versionFile,
    runner,
    probe: async () => true,
    force: true,
  })
  assert.equal(result.ok, true)
  assert.equal(result.version, '1.2.3')
  assert.equal(dirSeenRemoved, true)
  assert.equal(runtime.runtimeStatus(runtimeDir).usable, true)
})

test('peer 补装瞬时失败时换源仅重试 peer，不重装主包', async (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshdesktop-runtime-'))
  const versionFile = path.join(runtimeDir, 'version.json')
  const dshDir = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh')
  const bootDir = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-app-boot')
  fs.mkdirSync(path.join(dshDir, 'lib'), { recursive: true })
  fs.mkdirSync(bootDir, { recursive: true })
  fs.writeFileSync(path.join(dshDir, 'package.json'), JSON.stringify({ version: '1.2.3' }))
  fs.writeFileSync(path.join(dshDir, 'lib', 'bin.js'), '')
  fs.writeFileSync(path.join(bootDir, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-app-boot',
    version: '1.2.3',
    peerDependencies: { '@deepseek-ai/cordis-plugin-group': '^1.0.1' },
  }))
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }))
  const calls = []
  const runner = async (cmd, args) => {
    if (args[0] === 'config') return { ok: true, code: 0, out: 'https://registry.npmjs.org/\n' }
    calls.push(args)
    if (args.some((arg) => arg.startsWith('@deepseek-ai/cordis-plugin-group@'))) {
      // 官方源 peer 补装瞬时失败；镜像源成功（模拟镜像版本集滞后/网络抖动场景）
      if (args.includes('https://registry.npmjs.org/')) {
        return { ok: false, code: 1, err: 'npm error code ECONNREFUSED 模拟 peer 瞬时失败' }
      }
      const peerDir = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'cordis-plugin-group')
      fs.mkdirSync(peerDir, { recursive: true })
      fs.writeFileSync(path.join(peerDir, 'package.json'), JSON.stringify({
        name: '@deepseek-ai/cordis-plugin-group',
        version: '1.0.1',
      }))
      return { ok: true, code: 0 }
    }
    return { ok: true, code: 0 } // 主包安装
  }
  const result = await runtime.installVersion('1.2.3', { runtimeDir, versionFile, runner, probe: async () => true })
  assert.equal(result.ok, true)
  assert.equal(result.version, '1.2.3')
  const mainCalls = calls.filter((args) => args[1] === '@deepseek-ai/dsh@1.2.3')
  const peerCalls = calls.filter((args) => args.some((arg) => arg.startsWith('@deepseek-ai/cordis-plugin-group@')))
  assert.equal(mainCalls.length, 1) // 主包只装一次，不再随 peer 失败重装
  assert.equal(peerCalls.length, 2) // 官方源失败 1 次 + 镜像源成功 1 次
  assert.equal(runtime.runtimeStatus(runtimeDir).usable, true)
})

test('peer 版本范围无效时立即失败，不再换源重装主包', async (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshdesktop-runtime-'))
  const versionFile = path.join(runtimeDir, 'version.json')
  const dshDir = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh')
  const consumerDir = path.join(runtimeDir, 'node_modules', 'consumer')
  fs.mkdirSync(path.join(dshDir, 'lib'), { recursive: true })
  fs.mkdirSync(consumerDir, { recursive: true })
  fs.writeFileSync(path.join(dshDir, 'package.json'), JSON.stringify({ version: '1.2.3' }))
  fs.writeFileSync(path.join(dshDir, 'lib', 'bin.js'), '')
  fs.writeFileSync(path.join(consumerDir, 'package.json'), JSON.stringify({
    name: 'consumer',
    version: '1.0.0',
    peerDependencies: { 'peer-package': 'not-a-range@@' },
  }))
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }))
  const calls = []
  const runner = async (cmd, args) => {
    if (args[0] === 'config') return { ok: true, code: 0, out: 'https://registry.npmjs.org/\n' }
    calls.push(args)
    return { ok: true, code: 0 }
  }
  const result = await runtime.installVersion('1.2.3', { runtimeDir, versionFile, runner, probe: async () => true })
  assert.equal(result.ok, false)
  assert.match(result.err, /范围无效/)
  assert.equal(calls.length, 1) // 只尝试官方源一次（config 未计入 calls），不进入下一源
})

test('所有源 peer 补装失败时报具体原因且主包只装一次', async (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshdesktop-runtime-'))
  const versionFile = path.join(runtimeDir, 'version.json')
  const dshDir = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh')
  const bootDir = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-app-boot')
  fs.mkdirSync(path.join(dshDir, 'lib'), { recursive: true })
  fs.mkdirSync(bootDir, { recursive: true })
  fs.writeFileSync(path.join(dshDir, 'package.json'), JSON.stringify({ version: '1.2.3' }))
  fs.writeFileSync(path.join(dshDir, 'lib', 'bin.js'), '')
  fs.writeFileSync(path.join(bootDir, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-app-boot',
    version: '1.2.3',
    peerDependencies: { '@deepseek-ai/cordis-plugin-group': '^1.0.1' },
  }))
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }))
  const calls = []
  const runner = async (cmd, args) => {
    if (args[0] === 'config') return { ok: true, code: 0, out: 'https://registry.npmjs.org/\n' }
    calls.push(args)
    if (args.some((arg) => arg.startsWith('@deepseek-ai/cordis-plugin-group@'))) {
      return { ok: false, code: 1, err: 'npm error code ETARGET peer 版本不存在(模拟镜像未同步)' }
    }
    return { ok: true, code: 0 }
  }
  const result = await runtime.installVersion('1.2.3', { runtimeDir, versionFile, runner, probe: async () => true })
  assert.equal(result.ok, false)
  assert.match(result.err, /peer 版本不存在/)
  const mainCalls = calls.filter((args) => args[1] === '@deepseek-ai/dsh@1.2.3')
  const peerCalls = calls.filter((args) => args.some((arg) => arg.startsWith('@deepseek-ai/cordis-plugin-group@')))
  assert.equal(mainCalls.length, 1) // 主包只装一次，不再随 peer 失败重装
  assert.equal(peerCalls.length, 3) // 三个源各补一次
})

test('probeRegistry 支持 http 协议并拒绝其他协议', async () => {
  const server = http.createServer((req, res) => res.end('ok'))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const port = server.address().port
    assert.equal(await runtime.probeRegistry('http://127.0.0.1:' + port + '/', 3000), true)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
  assert.equal(await runtime.probeRegistry('ftp://127.0.0.1/'), false)
  assert.equal(await runtime.probeRegistry('not-a-url'), false)
  assert.equal(await runtime.probeRegistry('https://127.0.0.1:1/'), false)
})

test('latestVersion 官方源不可达时直达镜像源', async () => {
  const calls = []
  const runner = async (cmd, args) => {
    calls.push(args)
    if (args[0] === 'config') return { ok: true, code: 0, out: 'https://registry.npmjs.org/\n' }
    return { ok: true, code: 0, out: JSON.stringify({ latest: '0.1.0-rc.7', next: '0.1.0-rc.8' }) }
  }
  const probe = async (url) => url.includes('npmmirror')
  assert.equal(await runtime.latestVersion({ runner, probe }), '0.1.0-rc.8')
  assert.equal(calls.length, 2) // config + 1 次 view（直达镜像）
  assert.ok(calls[1].includes(runtime.REGISTRY_MIRROR))
})

test('latestVersion 全部源失败返回 null', async () => {
  const calls = []
  const runner = async (cmd, args) => {
    calls.push(args)
    if (args[0] === 'config') return { ok: true, code: 0, out: 'https://registry.npmjs.org/\n' }
    return { ok: false, code: 1, out: '', err: '模拟失败' }
  }
  assert.equal(await runtime.latestVersion({ runner, probe: async () => false }), null)
  assert.equal(calls.length, 4) // config + 3 个源
})

test('run 支持硬超时并终止进程树', async () => {
  const cmd = process.platform === 'win32' ? 'ping' : 'node'
  const args = process.platform === 'win32'
    ? ['127.0.0.1', '-n', '15']
    : ['-e', 'setTimeout(function(){}, 60000)']
  const res = await runtime.run(cmd, args, { timeoutMs: 800 })
  assert.equal(res.ok, false)
  assert.equal(res.timedOut, true)
  assert.equal(res.terminationUnconfirmed, false)
  assert.match(res.err, /超时/)
})

test('run 调用 npm-cli.js 时完整保留 shell 特殊字符参数', async (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshdesktop-npm-cli-'))
  const fixturePath = path.join(fixtureDir, 'npm-cli.js')
  fs.writeFileSync(fixturePath, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n')
  t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }))
  const args = [
    'install',
    'react@^16.8.0 || ^17.0.0 || ^18.0.0',
    'peer-package@>=1 <3',
    '--legacy-peer-deps',
  ]
  const res = await runtime.run('npm', args, { npmCliPath: fixturePath })
  assert.equal(res.ok, true)
  assert.deepEqual(JSON.parse(res.out), args)
})

test('migrateLegacyBaseDir 把旧目录整体搬到新目录', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshdesktop-migrate-'))
  const legacyDir = path.join(root, 'legacy')
  const targetDir = path.join(root, 'target')
  fs.mkdirSync(path.join(legacyDir, 'runtime'), { recursive: true })
  fs.writeFileSync(path.join(legacyDir, 'runtime', 'marker.txt'), 'ok')
  fs.writeFileSync(path.join(legacyDir, 'version.json'), '{"installed":"1.2.3"}')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  assert.equal(runtime.migrateLegacyBaseDir({ targetDir, legacyDir }), 'moved')
  assert.equal(fs.existsSync(legacyDir), false)
  assert.equal(fs.readFileSync(path.join(targetDir, 'runtime', 'marker.txt'), 'utf8'), 'ok')
  // 目标已存在时不再动旧目录（不合并、不覆盖）
  fs.mkdirSync(legacyDir, { recursive: true })
  fs.writeFileSync(path.join(legacyDir, 'extra.txt'), 'leftover')
  assert.equal(runtime.migrateLegacyBaseDir({ targetDir, legacyDir }), 'already-moved')
  assert.equal(fs.existsSync(path.join(legacyDir, 'extra.txt')), true)
})

test('migrateLegacyBaseDir 旧目录不存在时返回 no-legacy', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshdesktop-migrate-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  assert.equal(runtime.migrateLegacyBaseDir({
    targetDir: path.join(root, 'target'),
    legacyDir: path.join(root, 'missing'),
  }), 'no-legacy')
})

test('migrateLegacyBaseDir 迁移失败时返回 failed 且不抛异常', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshdesktop-migrate-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  // 目标路径的父级是文件 → rename 必然失败；旧目录应原样保留
  const legacyDir = path.join(root, 'legacy')
  fs.mkdirSync(legacyDir)
  fs.writeFileSync(path.join(legacyDir, 'marker.txt'), 'ok')
  const blocker = path.join(root, 'blocker')
  fs.writeFileSync(blocker, 'i am a file')
  assert.equal(runtime.migrateLegacyBaseDir({
    targetDir: path.join(blocker, 'target'),
    legacyDir,
  }), 'failed')
  assert.equal(fs.existsSync(legacyDir), true)
})
