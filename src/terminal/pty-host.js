'use strict'
/**
 * DSH Desktop 终端宿主（PTY Host）。
 *
 * 运行在系统 Node（>= 22.19）上，持有 node-pty 会话；与 Electron 主进程通过
 * JSON Lines over stdio 通信：
 *   stdin  逐行 JSON 请求：{id, type, ...}（type: spawn/write/resize/kill/shutdown）
 *   stdout 逐行 JSON 响应/事件：{id, ok, ...} 与 {type: 'data'|'exit', ...}
 *   stderr 仅宿主自身日志（主进程转写进 dsh.log），绝不可混入 stdout 协议流。
 *
 * 数据帧的 data 一律 base64：PTY 输出是任意字节序列，JSON 字符串里裸换行会
 * 破坏按行分帧。
 *
 * node-pty 模块目录解析优先级：--module-dir 参数 > PTY_HOST_MODULE_DIR 环境变量
 * > ~/.dshdesktop/pty-host/node_modules（与 runtime-manager 的 BASE_DIR 同根）。
 */
const os = require('node:os')
const path = require('node:path')
const readline = require('node:readline')
const { spawnSync } = require('node:child_process')

/** 锁定的 node-pty 版本（npm latest 正式版，Windows 上默认 ConPTY）。 */
const PTY_PACKAGE_VERSION = '1.1.0'
/** 单帧最大长度（base64 后）。超出直接丢弃并记录，防止异常帧撑爆内存。 */
const MAX_FRAME_LENGTH = 8 * 1024 * 1024
/** 单次 write 解码后的最大字节数。 */
const MAX_WRITE_LENGTH = 4 * 1024 * 1024
/** 终端尺寸的合理取值区间（ConPTY 对越界值行为不定，统一收敛）。 */
const MIN_SIZE = 1
const MAX_SIZE = 1000
/** kill 后等待 onExit 的兜底时长；超时强制清理会话并补发 exit 事件。 */
const KILL_EXIT_TIMEOUT_MS = 1500
/** sessionId 只允许短横线/下划线/字母数字，杜绝路径类注入。 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

const sessions = new Map()
let shuttingDown = false

// ── 日志与模块加载 ────────────────────────────────────────────────────────────

function logLine(message) {
  process.stderr.write(`[pty-host] ${new Date().toISOString()} ${message}\n`)
}

function resolveModuleDir(argv) {
  const argIndex = argv.indexOf('--module-dir')
  if (argIndex !== -1 && argv[argIndex + 1]) return argv[argIndex + 1]
  if (process.env.PTY_HOST_MODULE_DIR) return process.env.PTY_HOST_MODULE_DIR
  return path.join(os.homedir(), '.dshdesktop', 'pty-host', 'node_modules')
}

const moduleDir = resolveModuleDir(process.argv.slice(2))
let nodePty
try {
  nodePty = require(path.join(moduleDir, 'node-pty'))
} catch (err) {
  logLine(`node-pty 不可用：${err.message}`)
  logLine(`请先安装：npm install --prefix "${path.join(os.homedir(), '.dshdesktop', 'pty-host')}" node-pty@${PTY_PACKAGE_VERSION}`)
  process.exit(2)
}

// ── 协议帧 ────────────────────────────────────────────────────────────────────

/** stdout 只允许协议帧；宿主日志一律走 stderr。 */
function sendFrame(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

/** PTY 输出（utf8 字符串）编码成 base64 再入帧。 */
function encodeData(text) {
  return Buffer.from(text, 'utf8').toString('base64')
}

/** 入站 base64 解码回字符串；非法输入返回空串。 */
function decodeData(base64) {
  try {
    return Buffer.from(String(base64), 'base64').toString('utf8')
  } catch {
    return ''
  }
}

function sendEvent(type, extra) {
  sendFrame({ type, ...extra })
}

// ── 会话 ──────────────────────────────────────────────────────────────────────

function validSessionId(value) {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value)
}

function clampSize(value, fallback) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) return fallback
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, parsed))
}

/** 整树杀：Windows 用 taskkill /T /F（PowerShell 可能拉起子进程），其余发信号。 */
function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch (err) {
      logLine(`taskkill ${pid} 失败：${err.message}`)
    }
  } else {
    try { process.kill(pid, 'SIGTERM') } catch {}
  }
}

function forgetSession(sessionId) {
  const session = sessions.get(sessionId)
  if (!session) return
  if (session.killTimer) {
    clearTimeout(session.killTimer)
    session.killTimer = null
  }
  sessions.delete(sessionId)
}

function createSession(sessionId, shell, cwd, cols, rows, extraEnv) {
  const options = {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: { ...process.env, ...extraEnv },
  }
  // Windows 上显式开启 ConPTY（node-pty 1.1.0 默认已开启，这里写死行为）；
  // 非 Windows（开发机）不传该选项，避免未知键在不同实现下报错。
  if (process.platform === 'win32') options.useConpty = true

  const pty = nodePty.spawn(shell, [], options)
  const session = { sessionId, pty, killTimer: null }
  sessions.set(sessionId, session)

  pty.onData((data) => {
    sendEvent('data', { sessionId, data: encodeData(String(data)) })
  })
  pty.onExit(({ exitCode }) => {
    forgetSession(sessionId)
    sendEvent('exit', { sessionId, code: Number.isInteger(exitCode) ? exitCode : null })
  })
  logLine(`会话 ${sessionId} 启动（shell=${shell}, pid=${pty.pid}, ${cols}x${rows}, cwd=${cwd}）`)
  return pty
}

// ── 请求处理 ──────────────────────────────────────────────────────────────────

function handleSpawn(payload, respond) {
  const sessionId = payload.sessionId
  if (!validSessionId(sessionId)) return respond({ ok: false, error: 'sessionId 非法' })
  if (sessions.has(sessionId)) return respond({ ok: false, error: '会话已存在' })

  const shell = typeof payload.shell === 'string' && payload.shell.trim()
    ? payload.shell.trim()
    : (process.platform === 'win32' ? 'powershell.exe' : 'bash')
  const cwd = typeof payload.cwd === 'string' && payload.cwd.trim() ? payload.cwd : os.homedir()
  const cols = clampSize(payload.cols, 80)
  const rows = clampSize(payload.rows, 24)
  const extraEnv = payload.env && typeof payload.env === 'object' && !Array.isArray(payload.env)
    ? payload.env
    : {}

  try {
    const pty = createSession(sessionId, shell, cwd, cols, rows, extraEnv)
    respond({ ok: true, pid: pty.pid })
  } catch (err) {
    sessions.delete(sessionId)
    respond({ ok: false, error: `无法启动 ${shell}：${err.message}` })
  }
}

function handleWrite(payload, respond) {
  const session = sessions.get(payload.sessionId)
  if (!session) return respond({ ok: false, error: '会话不存在' })
  const text = decodeData(payload.data)
  if (text.length > MAX_WRITE_LENGTH) return respond({ ok: false, error: '写入内容过大' })
  try {
    session.pty.write(text)
    respond({ ok: true })
  } catch (err) {
    respond({ ok: false, error: `写入失败：${err.message}` })
  }
}

function handleResize(payload, respond) {
  const session = sessions.get(payload.sessionId)
  if (!session) return respond({ ok: false, error: '会话不存在' })
  const cols = clampSize(payload.cols, 80)
  const rows = clampSize(payload.rows, 24)
  try {
    session.pty.resize(cols, rows)
    respond({ ok: true })
  } catch (err) {
    respond({ ok: false, error: `调整尺寸失败：${err.message}` })
  }
}

function handleKill(payload, respond) {
  const session = sessions.get(payload.sessionId)
  if (!session) return respond({ ok: false, error: '会话不存在' })
  try { session.pty.kill() } catch {}
  killTree(session.pty.pid)
  respond({ ok: true })
  // taskkill /F 后个别场景 onExit 不触发，兜底强制清理并补发 exit 事件。
  session.killTimer = setTimeout(() => {
    if (sessions.get(payload.sessionId) !== session) return
    forgetSession(payload.sessionId)
    sendEvent('exit', { sessionId: payload.sessionId, code: null })
  }, KILL_EXIT_TIMEOUT_MS)
}

function shutdownAll() {
  if (shuttingDown) return
  shuttingDown = true
  logLine(`正在关闭全部 ${sessions.size} 个会话`)
  for (const session of Array.from(sessions.values())) {
    try { session.pty.kill() } catch {}
    killTree(session.pty.pid)
  }
  sessions.clear()
}

function handleShutdown(respond) {
  respond({ ok: true })
  shutdownAll()
  // 稍等 stdout 排空再退出，避免把响应截断在管道里。
  setTimeout(() => process.exit(0), 100)
}

function handleRequest(line) {
  if (line.length > MAX_FRAME_LENGTH) {
    logLine('请求帧超过上限，已丢弃')
    return
  }
  let request
  try {
    request = JSON.parse(line)
  } catch (err) {
    logLine(`无法解析请求帧：${err.message}`)
    return
  }
  if (!request || typeof request !== 'object' || !Number.isInteger(request.id) || typeof request.type !== 'string') {
    logLine('请求帧缺少 id 或 type，已忽略')
    return
  }
  const id = request.id
  const respond = (extra) => sendFrame({ id, ...extra })
  switch (request.type) {
    case 'spawn': handleSpawn(request, respond); break
    case 'write': handleWrite(request, respond); break
    case 'resize': handleResize(request, respond); break
    case 'kill': handleKill(request, respond); break
    case 'shutdown': handleShutdown(respond); break
    default: respond({ ok: false, error: `未知请求类型：${request.type}` })
  }
}

// ── 入口 ──────────────────────────────────────────────────────────────────────

// 宿主自身异常只记录不退出：单个会话的问题不应拖垮整个终端服务。
process.on('uncaughtException', (err) => {
  logLine(`[uncaughtException] ${err && err.stack ? err.stack : err}`)
})
process.on('unhandledRejection', (reason) => {
  logLine(`[unhandledRejection] ${reason && reason.stack ? reason.stack : reason}`)
})

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', handleRequest)
// 主进程关闭 stdin 或直接发信号：优雅收尾，不留孤儿 shell。
rl.on('close', () => {
  shutdownAll()
  process.exit(0)
})
process.on('SIGTERM', () => {
  shutdownAll()
  process.exit(0)
})
process.on('SIGINT', () => {
  shutdownAll()
  process.exit(0)
})

logLine(`pty-host 就绪（node-pty ${PTY_PACKAGE_VERSION}，模块目录：${moduleDir}）`)
