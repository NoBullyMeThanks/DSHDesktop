'use strict'
/**
 * pty-host 冒烟驱动：spawn 宿主进程，按协议走一遍完整链路
 * （spawn → write → resize → 自然退出 → 再 spawn → kill → shutdown），
 * 全部通过时打印 PASS 汇总并以 0 退出；任一失败立即中止并置失败退出码。
 *
 * 用法：node scripts/smoke-pty-host.js [--module-dir <dir>]
 */
const { spawn } = require('node:child_process')
const readline = require('node:readline')
const path = require('node:path')

const HOST_PATH = path.join(__dirname, '..', 'src', 'terminal', 'pty-host.js')
const SHELL = 'powershell.exe'
const OVERALL_TIMEOUT_MS = 120_000
const STEP_TIMEOUT_MS = 25_000

const args = process.argv.slice(2)
const moduleDirArgIndex = args.indexOf('--module-dir')
const moduleDir = moduleDirArgIndex !== -1 && args[moduleDirArgIndex + 1] ? args[moduleDirArgIndex + 1] : null

let child = null
let nextId = 1
const pending = new Map() // id -> { resolve, timer }
const eventWaiters = [] // { type, predicate, resolve, timer }
const sessionBuffers = new Map() // sessionId -> 已解码的输出累积
let failures = 0

function fail(message) {
  failures += 1
  console.error(`[FAIL] ${message}`)
}

function pass(message) {
  console.log(`[PASS] ${message}`)
}

function decode(base64) {
  return Buffer.from(String(base64), 'base64').toString('utf8')
}

/** 剥掉 CSI/OSC 控制序列与响铃符，便于对纯文本做断言（PSReadLine 会按语法着色输入）。 */
function stripAnsi(text) {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
    .replace(/\x07/g, '')
}

function waitEvent(type, predicate, timeoutMs = STEP_TIMEOUT_MS, label) {
  return new Promise((resolve, reject) => {
    const waiter = {
      type,
      predicate,
      resolve,
      timer: setTimeout(() => {
        const index = eventWaiters.indexOf(waiter)
        if (index !== -1) eventWaiters.splice(index, 1)
        reject(new Error(`等待事件 ${type}${label ? `（${label}）` : ''}超时`))
      }, timeoutMs),
    }
    eventWaiters.push(waiter)
  })
}

function request(type, payload = {}, timeoutMs = STEP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const id = nextId++
    const entry = {
      resolve,
      timer: setTimeout(() => {
        pending.delete(id)
        reject(new Error(`请求 ${type}（id ${id}）超时`))
      }, timeoutMs),
    }
    pending.set(id, entry)
    child.stdin.write(JSON.stringify({ id, type, ...payload }) + '\n')
  })
}

function handleFrame(frame) {
  if (frame && Number.isInteger(frame.id)) {
    const entry = pending.get(frame.id)
    if (!entry) return
    pending.delete(frame.id)
    clearTimeout(entry.timer)
    entry.resolve(frame)
    return
  }
  if (frame && typeof frame.type === 'string') {
    if (frame.type === 'data') {
      const buffer = sessionBuffers.get(frame.sessionId) ?? ''
      sessionBuffers.set(frame.sessionId, buffer + decode(frame.data))
    }
    for (let i = eventWaiters.length - 1; i >= 0; i--) {
      const waiter = eventWaiters[i]
      if (waiter.type === frame.type && waiter.predicate(frame)) {
        eventWaiters.splice(i, 1)
        clearTimeout(waiter.timer)
        waiter.resolve(frame)
      }
    }
  }
}

async function run() {
  console.log(`[smoke] 启动宿主：node ${HOST_PATH}${moduleDir ? `（module-dir=${moduleDir}）` : ''}`)
  child = spawn(process.execPath, [HOST_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...(moduleDir ? { PTY_HOST_MODULE_DIR: moduleDir } : {}) },
  })
  child.stderr.on('data', (d) => {
    process.stderr.write('[host] ' + String(d))
  })
  child.on('error', (err) => fail(`宿主进程启动失败：${err.message}`))
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', (line) => {
    try {
      handleFrame(JSON.parse(line))
    } catch (err) {
      fail(`宿主输出了非法协议帧：${line.slice(0, 120)}`)
    }
  })

  // 步骤 1：spawn 会话 smoke-1
  let res = await request('spawn', { sessionId: 'smoke-1', shell: SHELL, cols: 120, rows: 30 })
  if (!res.ok) throw new Error(`spawn smoke-1 失败：${res.error}`)
  pass(`spawn smoke-1（pid=${res.pid}, 120x30）`)

  // 步骤 2：执行命令并等待输出回显
  res = await request('write', { sessionId: 'smoke-1', data: Buffer.from("Write-Output 'DshPtySmokeOk123'\r", 'utf8').toString('base64') })
  if (!res.ok) throw new Error(`write 失败：${res.error}`)
  await waitEvent('data', (f) => f.sessionId === 'smoke-1' && (sessionBuffers.get('smoke-1') ?? '').includes('DshPtySmokeOk123'), STEP_TIMEOUT_MS, 'smoke-1 输出')
  pass('write 后收到输出回显 DshPtySmokeOk123')

  // 步骤 3：resize 后再次输出，验证尺寸链路不破坏会话
  res = await request('resize', { sessionId: 'smoke-1', cols: 100, rows: 24 })
  if (!res.ok) throw new Error(`resize 失败：${res.error}`)
  res = await request('write', { sessionId: 'smoke-1', data: Buffer.from('1+1\r', 'utf8').toString('base64') })
  if (!res.ok) throw new Error(`write 2 失败：${res.error}`)
  await waitEvent('data', (f) => {
    if (f.sessionId !== 'smoke-1') return false
    const plain = stripAnsi(sessionBuffers.get('smoke-1') ?? '')
    const markerIndex = plain.lastIndexOf('1+1')
    if (markerIndex === -1) return false
    return /(?:^|\r?\n)2(\r?\n|$)/.test(plain.slice(markerIndex))
  }, STEP_TIMEOUT_MS, '算术结果')
  pass('resize 100x24 后会话仍正常，1+1 输出 2')

  // 步骤 4：shell 自然退出 → 收到 exit 事件
  res = await request('write', { sessionId: 'smoke-1', data: Buffer.from('exit\r', 'utf8').toString('base64') })
  if (!res.ok) throw new Error(`write exit 失败：${res.error}`)
  const exitEvent = await waitEvent('exit', (f) => f.sessionId === 'smoke-1', STEP_TIMEOUT_MS, 'smoke-1 退出')
  if (exitEvent.code !== 0) throw new Error(`smoke-1 退出码异常：${exitEvent.code}`)
  pass(`smoke-1 自然退出（code=${exitEvent.code}）`)

  // 步骤 5：宿主存活，再开一个会话（验证多会话与退出后复用）
  res = await request('spawn', { sessionId: 'smoke-2', shell: SHELL, cols: 80, rows: 20 })
  if (!res.ok) throw new Error(`spawn smoke-2 失败：${res.error}`)
  pass(`spawn smoke-2（pid=${res.pid}, 80x20）`)
  res = await request('write', { sessionId: 'smoke-2', data: Buffer.from("Write-Output 'DshPtySmokeSecond'\r", 'utf8').toString('base64') })
  if (!res.ok) throw new Error(`write smoke-2 失败：${res.error}`)
  await waitEvent('data', (f) => f.sessionId === 'smoke-2' && (sessionBuffers.get('smoke-2') ?? '').includes('DshPtySmokeSecond'), STEP_TIMEOUT_MS, 'smoke-2 输出')
  pass('smoke-2 输出正常')

  // 步骤 6：kill smoke-2 → 收到 exit 事件
  res = await request('kill', { sessionId: 'smoke-2' })
  if (!res.ok) throw new Error(`kill smoke-2 失败：${res.error}`)
  await waitEvent('exit', (f) => f.sessionId === 'smoke-2', STEP_TIMEOUT_MS, 'smoke-2 退出')
  pass('kill smoke-2 后收到 exit 事件')

  // 步骤 7：shutdown → 宿主以 0 退出
  res = await request('shutdown', {}, 10_000)
  if (!res.ok) throw new Error(`shutdown 失败：${res.error}`)
  const exitCode = await new Promise((resolve) => {
    child.once('close', (code) => resolve(code))
    setTimeout(() => resolve('timeout'), 10_000)
  })
  if (exitCode !== 0) throw new Error(`宿主退出码异常：${exitCode}`)
  pass('shutdown 后宿主以退出码 0 结束')
}

async function main() {
  const overallTimer = setTimeout(() => {
    fail(`整体超时（${OVERALL_TIMEOUT_MS / 1000}s）`)
    try { child && child.kill() } catch {}
  }, OVERALL_TIMEOUT_MS)

  try {
    await run()
  } catch (err) {
    fail(err.message)
    for (const [sessionId, buffer] of sessionBuffers) {
      console.error(`[debug] 会话 ${sessionId} 缓冲区尾部（${buffer.length} 字符）：\n${JSON.stringify(buffer.slice(-600))}`)
    }
  } finally {
    clearTimeout(overallTimer)
    if (child && child.exitCode === null) {
      try { child.kill() } catch {}
    }
  }

  if (failures === 0) {
    console.log('[smoke] 全部通过 ✓')
    process.exitCode = 0
  } else {
    console.error(`[smoke] 失败 ${failures} 项 ✗`)
    process.exitCode = 1
  }
}

main()
