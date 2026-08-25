'use strict'
/**
 * 卡住诊断：dsh 子进程迟迟不打印就绪行时，给子进程拍快照，
 * 区分「死循环/重计算」与「等待（锁、I/O、事件）」两类卡点，
 * 并尽力抓取调用栈，全部写进日志作为定位证据。
 *
 * 本模块只采集证据，绝不干预：不杀进程、不重启、暂停抓栈后立即恢复。
 * 仅依赖 Node 内置模块，可用纯 Node 单测。
 */
const { spawn, spawnSync } = require('node:child_process')

/** CPU 两次采样之间的间隔（毫秒），用于估算占用率。 */
const CPU_SAMPLE_GAP_MS = 3000
/** 附加 inspector 后，等待调试器目标出现的总时长（毫秒）。 */
const INSPECTOR_WAIT_MS = 5000
/** CDP 一轮抓栈的总超时（毫秒）。 */
const CDP_TIMEOUT_MS = 8000
/** 日志里保留的栈帧数量。 */
const MAX_FRAMES = 12
/** inspector 默认端口（_debugProcess 等价 SIGUSR1，使用 --inspect 默认端口）。 */
const INSPECTOR_PORT = 9229

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 通过 PowerShell Get-Process 读一次进程快照：{ memKB, cpuSeconds }。
 * 进程已退出、读取失败或平台不支持时返回 null。
 *
 * 为什么不用 tasklist：本机（Windows 11 中文版）tasklist 的 CSV 输出
 * 没有 CPU Time 列（实测忙碌进程也只有 5 列），无法估算 CPU 占用率；
 * Get-Process 直接给出 CPU 总秒数与工作集内存，一次调用即可。
 */
function sampleProcess(pid) {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || process.platform !== 'win32') return null
  try {
    const script = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($null -eq $p) { 'ERR:NO_PROCESS' } else { '{0} {1}' -f [int64]$p.WorkingSet64, [double]$p.CPU }`
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
    })
    if (r.status !== 0 || !r.stdout) return null
    const line = r.stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0 && !l.startsWith('ERR:'))
    if (!line) return null
    const parts = line.split(/\s+/)
    const memBytes = Number(parts[0])
    const cpuSeconds = parts[1] ? Number(parts[1]) : null
    if (!Number.isFinite(memBytes) || memBytes <= 0) return null
    return {
      memKB: memBytes / 1024,
      cpuSeconds: Number.isFinite(cpuSeconds) ? cpuSeconds : null,
    }
  } catch {
    return null
  }
}

/**
 * 轮询 http://127.0.0.1:9229/json/list，找到 pid 对应的 inspector 目标。
 * 按目标 id（node/<pid>）或标题匹配，避免误挂到别的进程；找不到返回 null。
 */
async function waitForInspectorTarget(pid, timeoutMs = INSPECTOR_WAIT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${INSPECTOR_PORT}/json/list`)
      if (res.ok) {
        const list = await res.json()
        const match = list.find((t) => t.id === `node/${pid}` || String(t.title).includes(String(pid)))
        if (match) return match
      }
    } catch {}
    await sleep(300)
  }
  return null
}

/**
 * 连接 CDP：暂停目标进程、抓当前调用栈、立即恢复。
 * @returns {Promise<Array>} CDP callFrames 数组（可能为空）。
 */
async function captureFramesViaCdp(wsUrl) {
  if (typeof WebSocket === 'undefined') throw new Error('当前 Node 无全局 WebSocket，无法抓栈')
  return new Promise((resolve, reject) => {
    let ws
    let timer = null
    let nextId = 1
    let pausedFrames = null
    let settled = false
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      try { ws?.close() } catch {}
    }
    const finish = (err, frames) => {
      if (settled) return
      settled = true
      cleanup()
      if (err) reject(err)
      else resolve(frames)
    }
    const send = (method) => {
      const id = nextId++
      try { ws.send(JSON.stringify({ id, method })) } catch {}
    }
    try {
      ws = new WebSocket(wsUrl)
    } catch (err) {
      finish(err)
      return
    }
    timer = setTimeout(() => finish(new Error('CDP 超时（进程可能阻塞在原生代码中，无法暂停）')), CDP_TIMEOUT_MS)
    ws.onopen = () => {
      send('Debugger.enable')
      send('Debugger.pause')
    }
    ws.onerror = () => finish(new Error('CDP 连接错误'))
    ws.onmessage = (ev) => {
      let msg
      try { msg = JSON.parse(String(ev.data)) } catch { return }
      if (msg.method === 'Debugger.paused') {
        pausedFrames = Array.isArray(msg.params && msg.params.callFrames) ? msg.params.callFrames : []
        send('Debugger.resume')
      } else if (msg.method === 'Debugger.resumed' && pausedFrames) {
        finish(null, pausedFrames)
      }
    }
  })
}

/** 把 CDP 栈帧格式化成可读文本。 */
function formatFrames(frames, max = MAX_FRAMES) {
  if (!Array.isArray(frames) || frames.length === 0) return '（无栈帧）'
  return frames.slice(0, max).map((f, i) => {
    const loc = f.url ? `${f.url}:${f.lineNumber}:${f.columnNumber}` : '(native)'
    const fn = f.functionName || '(anonymous)'
    const short = loc.length > 240 ? `${loc.slice(0, 237)}…` : loc
    return `  #${i} ${fn} @ ${short}`
  }).join('\n')
}

/**
 * 从进程 stderr 文本中提取 Node inspector 的 ws 直连地址；
 * 找不到返回 null（子进程启动时带 --inspect=127.0.0.1:0 会打印该行）。
 */
function extractDebuggerWsUrl(stderrText) {
  if (typeof stderrText !== 'string') return null
  const m = stderrText.match(/Debugger listening on (ws:\/\/\S+)/)
  return m ? m[1] : null
}

/**
 * 抓取目标进程的调用栈（尽力而为）。
 * 优先直连调用方解析好的 ws 地址（子进程启动时带 --inspect=127.0.0.1:0，
 * stderr 会打印 `Debugger listening on ws://...`，最可靠）；
 * 无 ws 地址时退回 _debugProcess 附加 + /json/list 发现（可能因端口占用或
 * 进程阻塞在原生调用中而失败）。
 * @param {number} pid - 目标进程 PID（仅兜底路径需要）。
 * @param {object} [options] - { wsUrl } 直连地址。
 * @returns {Promise<Array>} CDP callFrames 数组（可能为空）。
 */
async function captureInspectorStack(pid, options = {}) {
  if (options.wsUrl) {
    return captureFramesViaCdp(options.wsUrl)
  }
  await new Promise((resolve) => {
    let p = null
    try {
      p = spawn('node', ['-e', `process._debugProcess(${Number(pid)})`], { stdio: 'ignore', windowsHide: true })
    } catch { resolve(); return }
    p.on('error', () => resolve())
    p.on('close', () => resolve())
  })
  const target = await waitForInspectorTarget(pid)
  if (!target || !target.webSocketDebuggerUrl) {
    throw new Error(`inspector 目标未出现（端口 ${INSPECTOR_PORT} 无响应：进程可能阻塞在原生调用中，或 9229 被占用，或进程已退出）`)
  }
  return captureFramesViaCdp(target.webSocketDebuggerUrl)
}

/**
 * 卡住诊断主入口：CPU/内存两次采样 + 尽力抓调用栈。
 * @param {number} pid - 目标子进程 PID。
 * @param {object} [options] - 可注入 { cpuSampleGapMs, wsUrl }（wsUrl 为子进程
 *   inspector 的直连地址，来自其 stderr 的 `Debugger listening on ws://...`）。
 * @returns {Promise<string>} 多行诊断文本，由调用方写入日志。
 */
async function captureStallDiagnostics(pid, options = {}) {
  const gapMs = options.cpuSampleGapMs ?? CPU_SAMPLE_GAP_MS
  const lines = []
  const s1 = sampleProcess(pid)
  await sleep(gapMs)
  const s2 = sampleProcess(pid)
  if (!s1 && !s2) {
    lines.push(`进程 ${pid} 已退出或无法读取进程快照`)
  } else {
    const latest = s2 || s1
    if (latest.memKB !== null) lines.push(`内存占用约 ${Math.round(latest.memKB / 1024)} MB`)
    if (s1 && s2 && s1.cpuSeconds !== null && s2.cpuSeconds !== null) {
      const wallSeconds = gapMs / 1000
      const delta = Math.max(0, s2.cpuSeconds - s1.cpuSeconds)
      const pct = Math.round((delta / wallSeconds) * 100)
      const verdict = pct >= 80
        ? '疑似死循环/重计算'
        : pct <= 10
          ? '疑似等待（锁/I/O/事件/外部资源）'
          : '疑似 I/O 密集或间歇性等待（非持续满载）'
      lines.push(`CPU 采样：${gapMs / 1000}s 内增长 ${delta.toFixed(1)}s（约 ${pct}% 单核占用）→ ${verdict}`)
    } else if (latest.cpuSeconds !== null) {
      lines.push(`CPU 累计 ${latest.cpuSeconds}s（仅单次采样，无法估算占用率）`)
    }
  }
  lines.push('调用栈（尽力而为）：')
  try {
    const frames = await captureInspectorStack(pid, { wsUrl: options.wsUrl })
    lines.push(formatFrames(frames))
  } catch (err) {
    lines.push(`  （抓栈失败：${err.message}）`)
  }
  return lines.join('\n')
}

module.exports = {
  CPU_SAMPLE_GAP_MS,
  sampleProcess,
  formatFrames,
  extractDebuggerWsUrl,
  captureInspectorStack,
  captureStallDiagnostics,
}
