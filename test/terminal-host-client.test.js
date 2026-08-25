'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { TerminalHostClient } = require('../terminal-host-client.js')
const runtime = require('../runtime-manager.js')

const HOST_PATH = path.join(__dirname, '..', 'pty-host.js')
const MODULE_DIR = path.join(runtime.BASE_DIR, 'pty-host', 'node_modules')
const hostAvailable = () => fs.existsSync(path.join(MODULE_DIR, 'node-pty'))

/** 给 Promise 加超时，超时抛错。 */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`等待${label}超时（${ms}ms）`)), ms)
    }),
  ])
}

test('真实宿主：spawn → 回显 → kill → shutdown 全链路', { skip: hostAvailable() ? false : 'node-pty 未安装，跳过（先跑 scripts/smoke-pty-host.js 的安装步骤）' }, async () => {
  const client = new TerminalHostClient({ hostPath: HOST_PATH, moduleDir: MODULE_DIR })
  await client.start()
  try {
    const spawnRes = await client.request('spawn', { sessionId: 'client-test-1', shell: 'powershell.exe', cols: 80, rows: 24 })
    assert.equal(spawnRes.ok, true)

    let echoed = ''
    client.onData = ({ sessionId, data }) => {
      if (sessionId === 'client-test-1') echoed += data
    }
    const echoedPromise = withTimeout(new Promise((resolve) => {
      const check = () => {
        if (echoed.includes('ClientEchoOk')) resolve()
        else setTimeout(check, 50)
      }
      check()
    }), 20_000, '输出回显')
    await client.write('client-test-1', "Write-Output 'ClientEchoOk'\r")
    await echoedPromise
    assert.ok(echoed.includes('ClientEchoOk'), '应收到命令输出回显')

    await client.killSession('client-test-1')
    const result = await client.shutdown(5_000)
    assert.equal(result.exitCode, 0)
  } finally {
    if (client.alive) client.killTree()
  }
})

test('假宿主：非法协议帧被容忍且请求仍能配对', async () => {
  const fakeHost = String.raw`process.stdout.write('not-json\n');const rl=require('readline').createInterface({input:process.stdin});rl.on('line',l=>{const j=JSON.parse(l);process.stdout.write(JSON.stringify({id:j.id,ok:true})+'\n')})`
  const client = new TerminalHostClient({ executable: process.execPath, hostArgs: ['-e', fakeHost] })
  await client.start()
  try {
    const res = await client.request('ping')
    assert.equal(res.ok, true)
  } finally {
    await client.shutdown(3_000)
  }
})

test('假宿主：无响应时请求按超时失败', async () => {
  const client = new TerminalHostClient({ executable: process.execPath, hostArgs: ['-e', 'setInterval(()=>{},1000)'] })
  await client.start()
  try {
    await assert.rejects(() => client.request('ping', {}, 300), /超时/)
  } finally {
    client.killTree()
  }
})

test('假宿主：宿主退出后触发 onClosed 且请求报错', async () => {
  const client = new TerminalHostClient({ executable: process.execPath, hostArgs: ['-e', 'process.exit(3)'] })
  await client.start()
  const closed = withTimeout(new Promise((resolve) => {
    client.onClosed = (code) => resolve(code)
  }), 5_000, 'onClosed')
  assert.equal(await closed, 3)
  await assert.rejects(() => client.request('ping', {}, 500), /未运行|已退出/)
})

test('假宿主：stdin 流 EPIPE 拒绝在途请求且不向外传播为未捕获异常', async () => {
  // 宿主进程死亡瞬间（Node 的 exit/close 事件尚未派发，alive 仍为 true），
  // 主进程继续 write 时 stdin 会以异步 EPIPE 报错；如果没有流 error 监听器，
  // 该错误会沿 EventEmitter 'error' 传播成进程级未捕获异常（用户实测：主进程
  // 弹「Uncaught Exception: write EPIPE」错误框）。这里直接 emit error 事件
  // 模拟管道断开：无监听器时 emit 本身同步抛出（测试失败），有监听器时
  // 在途请求应被拒绝、错误不得传播。
  const client = new TerminalHostClient({ executable: process.execPath, hostArgs: ['-e', 'setInterval(() => {}, 1000)'] })
  let uncaught = 0
  const onUncaught = () => { uncaught += 1 }
  process.on('uncaughtException', onUncaught)
  try {
    await client.start()
    const pendingReject = client.request('ping', {}, 10_000).then(
      () => new Error('请求不应成功'),
      (err) => err,
    )
    // 模拟宿主 stdin 管道断开（真实 EPIPE 也走这条 error 事件路径）
    client.child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    const err = await withTimeout(pendingReject, 5_000, '在途请求拒绝')
    assert.match(err.message, /EPIPE/)
    assert.equal(uncaught, 0, '流错误不得升级为进程级未捕获异常')
    // 宿主随后真退出（killTree 触发真实 close）：后续请求应被拒绝，onClosed 正常触发
    const closed = withTimeout(new Promise((resolve) => { client.onClosed = (code) => resolve(code) }), 5_000, 'onClosed')
    client.killTree()
    assert.equal(await closed, 1)
    const err2 = await withTimeout(
      client.request('ping', {}, 500).then(
        () => new Error('请求不应成功'),
        (e2) => e2,
      ),
      2_000,
      '后续请求拒绝',
    )
    assert.match(err2.message, /未运行|已退出/)
  } finally {
    process.removeListener('uncaughtException', onUncaught)
    if (client.alive) client.killTree()
  }
})

test('假宿主：data/exit 事件按 sessionId 分发并解码 base64', async () => {
  const fakeHost = String.raw`const rl=require('readline').createInterface({input:process.stdin});rl.on('line',l=>{const j=JSON.parse(l);if(j.type==='spawn'){process.stdout.write(JSON.stringify({id:j.id,ok:true})+'\n');process.stdout.write(JSON.stringify({type:'data',sessionId:j.sessionId,data:Buffer.from('你好世界','utf8').toString('base64')})+'\n');process.stdout.write(JSON.stringify({type:'exit',sessionId:j.sessionId,code:0})+'\n')}else{process.stdout.write(JSON.stringify({id:j.id,ok:true})+'\n')}})`
  const client = new TerminalHostClient({ executable: process.execPath, hostArgs: ['-e', fakeHost] })
  await client.start()
  try {
    const events = []
    client.onData = (e) => events.push(['data', e])
    client.onExit = (e) => events.push(['exit', e])
    const spawnRes = await client.request('spawn', { sessionId: 'evt-1' })
    assert.equal(spawnRes.ok, true)
    await withTimeout(new Promise((resolve) => {
      const check = () => {
        if (events.length >= 2) resolve()
        else setTimeout(check, 20)
      }
      check()
    }), 5_000, '事件')
    assert.deepEqual(events[0], ['data', { sessionId: 'evt-1', data: '你好世界' }])
    assert.deepEqual(events[1], ['exit', { sessionId: 'evt-1', code: 0 }])
  } finally {
    await client.shutdown(3_000)
  }
})
