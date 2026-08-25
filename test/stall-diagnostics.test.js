'use strict'
/**
 * stall-diagnostics 的单元测试。
 * Windows 相关的采样逻辑在非 Windows 平台跳过（仓库面向 Windows）。
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const {
  sampleProcess,
  formatFrames,
  extractDebuggerWsUrl,
  captureInspectorStack,
  captureStallDiagnostics,
} = require('../src/stall-diagnostics.js')

/** 起一个持续吃 CPU 的临时 node 子进程，用完必须 kill。 */
function spawnBusyNode() {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 0)'], { stdio: 'ignore' })
}

/** 起一个挂在 JS Promise 上的临时 node 子进程（事件循环仍有定时器，可被暂停）。 */
function spawnHangingNode() {
  return spawn(process.execPath, ['-e', 'function hang(){ return new Promise(() => {}) } hang(); setInterval(() => {}, 1000)'], { stdio: 'ignore' })
}

/**
 * 起一个带 --inspect=127.0.0.1:0 的挂起子进程（模拟 dsh 子进程的启动方式），
 * 返回 { child, wsUrlPromise }，wsUrlPromise 解析出 stderr 里的直连地址。
 */
function spawnInspectedHangingNode() {
  const child = spawn(process.execPath,
    ['--inspect=127.0.0.1:0', '-e', 'function hang(){ return new Promise(() => {}) } hang(); setInterval(() => {}, 1000)'],
    { stdio: ['ignore', 'ignore', 'pipe'] })
  const wsUrlPromise = new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => reject(new Error('子进程未打印 Debugger listening 行')), 8000)
    child.stderr.on('data', (d) => {
      buf += String(d)
      const m = buf.match(/Debugger listening on (ws:\/\/\S+)/)
      if (m) {
        clearTimeout(timer)
        resolve(m[1])
      }
    })
    child.on('close', () => {
      clearTimeout(timer)
      reject(new Error('子进程提前退出'))
    })
  })
  return { child, wsUrlPromise }
}

test('sampleProcess：不存在的 PID 返回 null', () => {
  assert.equal(sampleProcess(2 ** 30 + 7), null)
})

test('sampleProcess：能读到真实进程的内存与 CPU 时间（Windows）', { skip: process.platform !== 'win32' }, async (t) => {
  const child = spawnBusyNode()
  t.after(() => { try { child.kill() } catch {} })
  await new Promise((resolve) => setTimeout(resolve, 300))
  const sample = sampleProcess(child.pid)
  assert.ok(sample, '应能读到存活进程的快照')
  assert.ok(sample.memKB !== null && sample.memKB > 0, '内存应大于 0')
  assert.ok(sample.cpuSeconds !== null && sample.cpuSeconds >= 0, 'CPU 时间应为非负数')
})

test('formatFrames：格式化为可读栈文本', () => {
  const frames = [
    { functionName: 'hang', url: 'file:///C:/x/hang.js', lineNumber: 1, columnNumber: 22 },
    { url: '', lineNumber: 0, columnNumber: 0 },
  ]
  const text = formatFrames(frames)
  assert.match(text, /#0 hang @ file:\/\/\/C:\/x\/hang\.js:1:22/)
  assert.match(text, /#1 \(anonymous\) @ \(native\)/)
})

test('formatFrames：空栈返回占位文本', () => {
  assert.equal(formatFrames([]), '（无栈帧）')
})

test('extractDebuggerWsUrl：提取 / 拒绝异常输入', () => {
  assert.equal(extractDebuggerWsUrl('Debugger listening on ws://127.0.0.1:12345/abc-123'), 'ws://127.0.0.1:12345/abc-123')
  assert.equal(extractDebuggerWsUrl('普通输出，无调试器'), null)
  assert.equal(extractDebuggerWsUrl(null), null)
  assert.equal(extractDebuggerWsUrl(''), null)
})

test('captureInspectorStack：直连 ws 地址能抓到栈帧（确定性路径）', { skip: process.platform !== 'win32' }, async (t) => {
  const { child, wsUrlPromise } = spawnInspectedHangingNode()
  t.after(() => { try { child.kill() } catch {} })
  const wsUrl = await wsUrlPromise
  const frames = await captureInspectorStack(child.pid, { wsUrl })
  assert.ok(Array.isArray(frames) && frames.length > 0, '应抓到栈帧')
})

test('captureStallDiagnostics：直连 ws 时输出包含栈帧', { skip: process.platform !== 'win32' }, async (t) => {
  const { child, wsUrlPromise } = spawnInspectedHangingNode()
  t.after(() => { try { child.kill() } catch {} })
  const wsUrl = await wsUrlPromise
  const text = await captureStallDiagnostics(child.pid, { cpuSampleGapMs: 300, wsUrl })
  assert.match(text, /内存占用约 \d+ MB/)
  assert.match(text, /CPU 采样：/)
  assert.match(text, /疑似/)
  assert.match(text, /调用栈（尽力而为）：/)
  assert.match(text, /#\d/, '应包含抓到的栈帧')
})

test('captureInspectorStack：兜底 _debugProcess 路径（尽力而为）', { skip: process.platform !== 'win32' }, async (t) => {
  const child = spawnHangingNode()
  t.after(() => { try { child.kill() } catch {} })
  await new Promise((resolve) => setTimeout(resolve, 300))
  try {
    const frames = await captureInspectorStack(child.pid)
    assert.ok(Array.isArray(frames), '应返回栈帧数组')
  } catch (err) {
    // 环境不允许时（如 9229 被占用、_debugProcess 失效）允许失败，但必须带可读原因
    assert.ok(err instanceof Error && err.message.length > 0, '失败应带原因')
  }
})

test('captureStallDiagnostics：进程已退出时给出明确提示', { skip: process.platform !== 'win32' }, async (t) => {
  const child = spawnBusyNode()
  child.kill()
  await new Promise((resolve) => child.on('close', resolve))
  const text = await captureStallDiagnostics(child.pid, { cpuSampleGapMs: 100 })
  assert.match(text, /已退出或无法读取/)
})
