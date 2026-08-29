'use strict'
/**
 * DSH Desktop 主进程。
 *
 * 双击启动后：
 *   1. 校验系统 Node（dsh 要求 >= 22.19.0）；
 *   2. 确保运行时：把 @deepseek-ai/dsh 装进 ~/.dshdesktop/runtime（首次）；
 *   3. 拉起 `node <dsh>/lib/bin.js web --port 0` 子进程；
 *   4. 解析 stdout 就绪行 `dsh web: http://127.0.0.1:PORT` → 原生窗口加载该 URL。
 *
 * 窗口隐藏系统标题栏：DSH 内容铺满整个窗口，右上角窗口按钮由隔离的 preload UI 绘制。
 * 快捷键走隐藏菜单，Ctrl+滚轮由内容页直接处理。
 * 关窗隐藏到托盘，托盘「退出」才真退。
 */
const { app, BrowserWindow, ipcMain, Menu, dialog, shell, nativeTheme } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { spawn, spawnSync } = require('node:child_process')
const runtime = require('./runtime-manager.js')
const { createTray } = require('./tray.js')
const settingsReader = require('./settings-reader.js')
const { t } = require('./i18n.js')
const { createOperationLock } = require('./runtime-operation-lock.js')
const { DEFAULT_UPDATE_PREFERENCES, normalizeUpdatePreferences } = require('./update-preferences.js')
const { captureStallDiagnostics, extractDebuggerWsUrl } = require('./stall-diagnostics.js')
const { centeredSplashBounds, normalizeSplashMode, splashLayoutForContent } = require('./startup/layout.js')
const { createTerminalManager } = require('./terminal/manager.js')

/** 等待 dsh 打印就绪 URL 的超时（首启要初始化 profile，放宽到 120s）。 */
const READY_TIMEOUT_MS = 120_000
/** 就绪行迟迟不出现时，触发「卡住诊断」快照的阈值（只记录证据，不干预）。
 *  实测：正常热启动 1.4~4.4s；卡顿最短 21.5s（8/20 实测热启动也会卡），
 *  长卡顿 28~59s。10s 避开一切正常启动，60s 再补一枪覆盖长卡顿。 */
const STALL_DIAGNOSTIC_DELAY_MS = 10_000
const STALL_DIAGNOSTIC_SECOND_PASS_MS = 60_000
/** 每次缩放半级，约等于 9.5%，沿用原有手感。 */
const ZOOM_STEP = 0.5
const APP_ID = 'com.deepseek.dshdesktop'
const APP_ICON = path.join(__dirname, '..', 'assets', 'icon.ico')

const LOG_FILE = path.join(runtime.BASE_DIR, 'dsh.log')
const PREFERENCES_FILE = path.join(runtime.BASE_DIR, 'preferences.json')

let mainWindow = null
let splash = null
let dshChild = null
let currentUrl = null
let logStream = null
let tray = null
let isQuitting = false
let locale = 'zh'
let lastWheelZoomAt = 0
let splashState = null
let splashReady = false
let splashRevealTimer = null
let startupAttempt = 0
let startupInProgress = false
let activeAppDialog = null
let appDialogSequence = 0
let updateCheckPromise = null
let pendingUpdatePrompting = false
let startupUpdateChecked = false
let handlingUnexpectedDshExit = false
const expectedDshExits = new WeakSet()
let updatePreferences = { ...DEFAULT_UPDATE_PREFERENCES }
let terminalManager = null
const runtimeOperationLock = createOperationLock(() => refreshTrayRuntimeBusy())

function refreshTrayRuntimeBusy() {
  tray?.setRuntimeBusy(Boolean(runtimeOperationLock.activeOperation()) || handlingUnexpectedDshExit)
}

// ── 主进程级错误兜底：任何未捕获异常/拒绝都写进日志，便于定位 ──────────────
process.on('uncaughtException', (err) => {
  try { fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} [uncaughtException] ${err && err.stack ? err.stack : err}\n`) } catch {}
})
process.on('unhandledRejection', (reason) => {
  try { fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} [unhandledRejection] ${reason && reason.stack ? reason.stack : reason}\n`) } catch {}
})

// ── 日志 ─────────────────────────────────────────────────────────────────────

function initLog() {
  // 更名后的数据目录与旧版不同：在新目录的任何读写之前做一次性迁移，
  // 让老用户保留已装运行时、偏好与日志。失败不阻塞启动，降级为全新目录。
  const migration = runtime.migrateLegacyBaseDir()
  if (migration === 'failed') console.error('[data-dir] 旧数据目录迁移失败，按全新目录继续')
  fs.mkdirSync(runtime.BASE_DIR, { recursive: true })
  logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' })
  logStream.on('error', () => {})
  appendLog('=== DSH Desktop 启动 ===')
}

function appendLog(line) {
  if (!logStream || logStream.destroyed || logStream.writableEnded) return
  try { logStream.write(`${new Date().toISOString()} ${line}\n`) } catch {}
}

// ── 桌面端偏好 ───────────────────────────────────────────────────────────────

function loadUpdatePreferences() {
  try {
    const data = JSON.parse(fs.readFileSync(PREFERENCES_FILE, 'utf8'))
    const normalized = normalizeUpdatePreferences(data)
    updatePreferences = normalized.preferences
    if (normalized.needsMigration) saveUpdatePreferences()
  } catch {
    updatePreferences = { ...DEFAULT_UPDATE_PREFERENCES }
  }
}

function saveUpdatePreferences() {
  try {
    fs.mkdirSync(runtime.BASE_DIR, { recursive: true })
    fs.writeFileSync(PREFERENCES_FILE, JSON.stringify(updatePreferences, null, 2) + '\n')
  } catch (err) {
    appendLog(`[update] 保存更新偏好失败：${err.message}`)
  }
}

function startupUpdateCheckEnabled() {
  return updatePreferences.checkUpdatesOnStartup
}

function setStartupUpdateCheckEnabled(enabled) {
  updatePreferences.checkUpdatesOnStartup = enabled === true
  saveUpdatePreferences()
  appendLog(`[update] startup check -> ${updatePreferences.checkUpdatesOnStartup}`)
  if (updatePreferences.checkUpdatesOnStartup) maybeCheckForUpdates()
}

function setPendingUpdateVersion(version) {
  const normalized = typeof version === 'string' && version.length <= 64 ? version : null
  if (updatePreferences.pendingUpdateVersion === normalized) return
  updatePreferences.pendingUpdateVersion = normalized
  saveUpdatePreferences()
}

// ── 外观同步：深浅色 + 语言 跟随 dsh 的 settings.yaml ──────────────────────

function applySettings(settings) {
  const theme = settings.theme ?? 'system'
  if (nativeTheme.themeSource !== theme) {
    nativeTheme.themeSource = theme
    appendLog(`[settings] theme -> ${theme}`)
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#151517' : '#ffffff')
  }
  const loc = settings.locale ?? 'zh'
  if (loc !== locale) {
    locale = loc
    if (tray) tray.setLocale(locale)
    appendLog(`[settings] locale -> ${locale}`)
    sendWindowControlsState()
    if (terminalManager) terminalManager.refreshAppearance()
  }
  refreshSplashAppearance()
}

// ── 启动画面 ─────────────────────────────────────────────────────────────────

function createSplash() {
  if (splash && !splash.isDestroyed()) return
  splashReady = false
  const initialLayout = splashLayoutForContent('loading')
  splash = new BrowserWindow({
    width: initialLayout.width,
    height: initialLayout.height,
    show: false,
    icon: APP_ICON,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    // 启动画面是启动期唯一可见的应用窗口（主窗口 reveal 前 show:false），
    // 不需要系统级置顶：alwaysOnTop 会让它盖住其他所有应用窗口、无法被遮挡。
    center: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'startup', 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
  const win = splash
  win.webContents.once('did-finish-load', () => {
    markSplashReady(win)
  })
  win.webContents.once('did-fail-load', (_event, code, description) => {
    appendLog(`[splash] did-fail-load (${code}) ${description}`)
    if (splash === win) {
      dialog.showErrorBox('DSH Desktop', `启动界面无法加载：${description}`)
      quitApp()
    }
  })
  win.on('closed', () => {
    if (splash === win) {
      clearSplashRevealTimer()
      splash = null
      splashReady = false
    }
  })
  win.loadFile(path.join(__dirname, 'startup', 'index.html')).catch((err) => {
    appendLog(`[splash] loadFile failed: ${err.message}`)
    if (splash === win && !win.isDestroyed()) {
      dialog.showErrorBox('DSH Desktop', `启动界面无法加载：${err.message}`)
      quitApp()
    }
  })
}

function clearSplashRevealTimer() {
  if (!splashRevealTimer) return
  clearTimeout(splashRevealTimer)
  splashRevealTimer = null
}

function revealSplash(win) {
  if (win.isDestroyed() || splash !== win) return
  clearSplashRevealTimer()
  if (!win.isVisible()) win.show()
}

function markSplashReady(win) {
  if (win.isDestroyed() || splash !== win || splashReady) return
  splashReady = true
  sendSplashState()
  if (!splashState) return
  splashRevealTimer = setTimeout(() => revealSplash(win), 250)
}

function resizeSplash(layout) {
  if (!splash || splash.isDestroyed()) return
  const currentBounds = splash.getBounds()
  if (currentBounds.width === layout.width && currentBounds.height === layout.height) return
  splash.setBounds(centeredSplashBounds(currentBounds, layout))
}

function destroySplash() {
  clearSplashRevealTimer()
  if (splash && !splash.isDestroyed()) splash.destroy()
  splash = null
  splashReady = false
  splashState = null
}

function currentTheme() {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

function sendSplashState() {
  if (!splashReady || !splashState || !splash || splash.isDestroyed()) return
  const mode = normalizeSplashMode(splashState.mode)
  const currentBounds = splash.getBounds()
  const expectedWidth = splashLayoutForContent(mode).width
  if (currentBounds.width !== expectedWidth) {
    resizeSplash({ width: expectedWidth, height: currentBounds.height })
  }
  splash.webContents.send('splash:state', {
    ...splashState,
    locale,
    theme: currentTheme(),
  })
}

function setSplashLoading(stageKey) {
  splashState = {
    id: `startup-${startupAttempt}`,
    mode: 'loading',
    title: t(locale, 'splashTitle'),
    message: t(locale, 'splashMessage'),
    stage: t(locale, stageKey),
  }
  sendSplashState()
}

function setSplashError(titleKey, messageKey, detail, actions) {
  splashState = {
    id: `startup-${startupAttempt}`,
    mode: 'error',
    title: t(locale, titleKey),
    message: t(locale, messageKey),
    detail: String(detail ?? '').slice(-4000),
    actions,
  }
  sendSplashState()
}

function refreshSplashAppearance() {
  if (!splashState) return
  sendSplashState()
}

// ── 主窗口（隐藏系统标题栏 + preload 自绘窗口按钮） ───────────────────────────

function sendWindowControlsState() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const wc = mainWindow.webContents
  if (wc.isDestroyed()) return
  wc.send('dsh:window-controls-state', {
    maximized: mainWindow.isMaximized(),
    terminalOpen: Boolean(terminalManager && terminalManager.isPanelVisible()),
    labels: {
      minimize: t(locale, 'windowMinimize'),
      maximize: t(locale, 'windowMaximize'),
      restore: t(locale, 'windowRestore'),
      close: t(locale, 'windowClose'),
      terminal: t(locale, 'toggleTerminal'),
    },
  })
}

function createMainWindow(url) {
  currentUrl = url
  // 先建主窗口、再销毁启动画面：保证任何时刻都至少有一个窗口存活，避免 0 窗口瞬间触发退出。
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    icon: APP_ICON,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hidden',
    roundedCorners: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#151517' : '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })

  const win = mainWindow
  const wc = win.webContents
  let revealed = false
  let revealFallback = null

  /** 显示主窗口并关闭启动画面；多个就绪信号竞争时只执行一次。 */
  function revealMainWindow(reason) {
    if (revealed || win.isDestroyed()) return
    revealed = true
    if (revealFallback) clearTimeout(revealFallback)
    appendLog(`[window] reveal main (${reason})`)
    win.show()
    win.focus()
    destroySplash()
    setTimeout(() => maybeShowPendingUpdate(), 250)
  }

  win.once('ready-to-show', () => {
    appendLog('[window] ready-to-show')
    revealMainWindow('ready-to-show')
  })
  wc.once('dom-ready', () => appendLog('[window] dom-ready'))
  // Chromium 按来源记忆缩放；仅新建应用窗口时清零，托盘隐藏/恢复不触发。
  wc.setZoomLevel(0)
  wc.once('did-finish-load', () => {
    appendLog('[window] did-finish-load')
    resetZoomContent()
    sendWindowControlsState()
    setTimeout(() => revealMainWindow('did-finish-load fallback'), 150)
  })
  wc.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    appendLog(`[window] did-fail-load (${errorCode}) ${errorDescription}: ${validatedURL}`)
    if (isMainFrame) revealMainWindow('did-fail-load')
  })
  setupContentMouseZoom()
  revealFallback = setTimeout(() => revealMainWindow('8s timeout fallback'), 8000)
  wc.loadURL(url).catch((err) => {
    appendLog(`[window] loadURL failed: ${err.message}`)
    revealMainWindow('loadURL failed')
  })

  // 关窗 ≠ 退出：拦截为「隐藏到托盘」，托盘「退出」才真正关闭。
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      mainWindow.hide()
    }
  })
  mainWindow.on('maximize', sendWindowControlsState)
  mainWindow.on('unmaximize', sendWindowControlsState)
  mainWindow.on('closed', () => {
    if (revealFallback) clearTimeout(revealFallback)
    mainWindow = null
  })
}

function showMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    setTimeout(() => maybeShowPendingUpdate(), 100)
    return true
  }
  return false
}

// ── DSH 内容页 → 桌面窗口操作 ─────────────────────────────────────────────────

function setupIpc() {
  ipcMain.on('dsh:window-controls-ready', (event) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return
    sendWindowControlsState()
  })

  ipcMain.on('dsh:window-control', (event, action) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return
    if (action === 'minimize') {
      mainWindow.minimize()
    } else if (action === 'toggle-maximize') {
      if (mainWindow.isMaximized()) mainWindow.unmaximize()
      else mainWindow.maximize()
    } else if (action === 'close') {
      mainWindow.close()
    } else if (action === 'terminal') {
      // 状态刷新由 terminal/manager 的 onPanelVisibleChange 回调统一负责
      terminalManager?.togglePanel()
    }
  })

  ipcMain.on('dsh:dialog-action', (event, payload) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return
    if (!activeAppDialog || !payload || payload.id !== activeAppDialog.id || typeof payload.action !== 'string') return

    const button = activeAppDialog.state.buttons.find((item) => item.id === payload.action)
    const isCancel = activeAppDialog.state.cancelable && payload.action === activeAppDialog.state.cancelAction
    if (!button && !isCancel) return

    if (button?.keepOpen && payload.action === 'open-log') {
      openLog()
      activeAppDialog.send()
      return
    }
    activeAppDialog.finish(payload.action)
  })

  ipcMain.on('splash:ready', (event) => {
    if (!splash || splash.isDestroyed() || event.sender !== splash.webContents) return
    markSplashReady(splash)
  })

  ipcMain.on('splash:layout', (event, payload) => {
    if (!splash || splash.isDestroyed() || event.sender !== splash.webContents) return
    if (!splashState || !payload || payload.id !== splashState.id) return
    if (payload.mode !== normalizeSplashMode(splashState.mode) || !Number.isFinite(payload.height)) return

    resizeSplash(splashLayoutForContent(payload.mode, payload.height))
    revealSplash(splash)
  })

  ipcMain.on('splash:action', (event, payload) => {
    if (!splash || splash.isDestroyed() || event.sender !== splash.webContents) return
    if (!splashState || !payload || payload.id !== splashState.id || typeof payload.action !== 'string') return

    if (payload.action === 'retry') {
      runStartupAttempt()
    } else if (payload.action === 'open-log') {
      openLog()
      sendSplashState()
    } else if (payload.action === 'download-node') {
      shell.openExternal('https://nodejs.org/en/download').catch(() => {})
      sendSplashState()
    } else if (payload.action === 'exit') {
      quitApp()
    }
  })
}

// ── DSH 内容页模态框 ─────────────────────────────────────────────────────────

function createAppDialog(state) {
  const wc = contentWebContents()
  if (!wc) {
    return {
      id: null,
      result: Promise.resolve('unavailable'),
      update: () => {},
      close: () => {},
    }
  }

  if (activeAppDialog) activeAppDialog.finish('replaced')
  const id = `dialog-${Date.now()}-${++appDialogSequence}`
  let resolveResult
  const result = new Promise((resolve) => { resolveResult = resolve })
  const controller = {
    id,
    state: { ...state, buttons: Array.isArray(state.buttons) ? state.buttons : [], id },
    result,
    settled: false,
    send() {
      const target = contentWebContents()
      if (!target || controller.settled) return
      target.send('dsh:dialog-state', controller.state)
    },
    update(patch) {
      if (controller.settled) return
      controller.state = { ...controller.state, ...patch, id }
      if (!Array.isArray(controller.state.buttons)) controller.state.buttons = []
      controller.send()
    },
    close(action = 'closed') {
      controller.finish(action)
    },
    finish(action) {
      if (controller.settled) return
      controller.settled = true
      const target = contentWebContents()
      if (target) target.send('dsh:dialog-state', { id, mode: 'close' })
      if (activeAppDialog === controller) activeAppDialog = null
      resolveResult(action)
    },
  }
  activeAppDialog = controller

  if (wc.isLoadingMainFrame()) {
    wc.once('did-finish-load', () => {
      if (activeAppDialog === controller) controller.send()
    })
  } else {
    controller.send()
  }
  return controller
}

async function showAppDialog(state) {
  return createAppDialog(state).result
}

function dialogButton(id, labelKey, kind = 'secondary', extra = {}) {
  return { id, label: t(locale, labelKey), kind, ...extra }
}

// ── 快捷键（隐藏菜单 accelerator，作用于 dsh 内容） ─────────────────────────

function contentWebContents() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return null
  return mainWindow.webContents
}

function reloadContent() { contentWebContents()?.reload() }
function forceReloadContent() { contentWebContents()?.reloadIgnoringCache() }
function zoomContent(delta) {
  const wc = contentWebContents()
  if (!wc) return
  wc.setZoomLevel(wc.getZoomLevel() + delta)
}
function resetZoomContent() {
  contentWebContents()?.setZoomLevel(0)
}

function setupContentMouseZoom() {
  const wc = contentWebContents()
  if (!wc) return
  wc.on('before-mouse-event', (event, input) => {
    if (input.type !== 'mouseWheel') return
    const modifiers = input.modifiers ?? []
    const withControl = modifiers.includes('control')
      || modifiers.includes('ctrl')
      || modifiers.includes('command')
      || modifiers.includes('cmd')
    if (!withControl) return

    event.preventDefault()
    const vertical = Number(input.wheelTicksY ?? input.deltaY ?? 0)
    if (!vertical) return
    const now = Date.now()
    if (now - lastWheelZoomAt < 60) return
    lastWheelZoomAt = now
    zoomContent(vertical > 0 ? ZOOM_STEP : -ZOOM_STEP)
  })
}

function setupShortcuts() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '刷新', accelerator: 'F5', click: () => reloadContent() },
    { label: '强制刷新', accelerator: 'Ctrl+F5', click: () => forceReloadContent() },
    { label: '放大', accelerator: 'CmdOrCtrl+=', click: () => zoomContent(ZOOM_STEP) },
    { label: '放大（数字键盘）', accelerator: 'CmdOrCtrl+Plus', click: () => zoomContent(ZOOM_STEP) },
    { label: '缩小', accelerator: 'CmdOrCtrl+-', click: () => zoomContent(-ZOOM_STEP) },
    { label: '重置缩放', accelerator: 'CmdOrCtrl+0', click: () => resetZoomContent() },
    { label: t(locale, 'toggleTerminal'), accelerator: 'CmdOrCtrl+`', click: () => terminalManager?.togglePanel() },
    { label: '全屏', accelerator: 'F11', click: () => toggleFullscreen() },
    { label: '开发者工具', accelerator: 'F12', click: () => toggleDevtools() },
  ]))
}

// ── dsh 子进程生命周期 ───────────────────────────────────────────────────────

/** 拉起 dsh web 子进程，等待其打印就绪 URL。 */
function startDsh() {
  return new Promise((resolve) => {
    const bin = runtime.binPath()
    if (!fs.existsSync(bin)) {
      resolve({ ok: false, error: `找不到 dsh 入口：\n${bin}` })
      return
    }
    let child
    try {
      // --inspect=127.0.0.1:0：子进程启动即带本地调试端口（随机空闲端口），
      // 卡住诊断直接连 stderr 里打印的 ws 地址抓栈，避免事后附加不可靠。
      // --no-open：dsh web 默认会用系统浏览器打开 Web UI，这里关掉，改由桌面窗口加载就绪 URL。
      child = spawn('node', ['--inspect=127.0.0.1:0', bin, 'web', '--port', '0', '--no-open'], {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (e) {
      resolve({ ok: false, error: `无法启动 node 进程：${e.message}` })
      return
    }
    dshChild = child
    let stdoutBuf = ''
    let stderrBuf = ''
    let settled = false
    let readyTimer = null
    let diagTimer = null
    let diagTimer2 = null
    let childDebugWsUrl = null

    const finish = (result) => {
      if (settled) return
      settled = true
      if (readyTimer) clearTimeout(readyTimer)
      if (diagTimer) clearTimeout(diagTimer)
      if (diagTimer2) clearTimeout(diagTimer2)
      resolve(result)
    }

    child.stdout.on('data', (d) => {
      const s = String(d)
      stdoutBuf += s
      appendLog('[dsh] ' + s)
      const m = stdoutBuf.match(/dsh web:\s+(http:\/\/[^\s]+)/)
      if (m) finish({ ok: true, url: m[1], child })
    })
    child.stderr.on('data', (d) => {
      stderrBuf += String(d)
      appendLog('[dsh] ' + String(d))
      // 解析 Node inspector 的 ws 地址；在累计缓冲上匹配，防跨 chunk 截断。
      if (!childDebugWsUrl) childDebugWsUrl = extractDebuggerWsUrl(stderrBuf)
    })
    child.on('error', (e) => finish({ ok: false, error: `无法启动 node：${e.message}` }))
    child.on('close', (code) => {
      const wasCurrent = dshChild === child
      const expected = expectedDshExits.has(child)
      expectedDshExits.delete(child)
      if (wasCurrent) dshChild = null
      appendLog(`[dsh] exited (code ${code})`)
      if (!settled) {
        finish({ ok: false, error: `dsh 提前退出（code ${code}）。\n${stderrBuf.slice(-2000)}` })
      } else if (wasCurrent && !expected && !isQuitting) {
        handleUnexpectedDshExit(code, stderrBuf).catch((err) => {
          appendLog(`[dsh] 处理意外退出失败：${err && err.stack ? err.stack : err}`)
        })
      }
    })
    readyTimer = setTimeout(() => {
      if (!settled) finish({ ok: false, error: `等待 dsh web 就绪超时。\n${stderrBuf.slice(-2000)}` })
    }, READY_TIMEOUT_MS)
    // 卡住诊断：就绪行超时阈值仍未见时，拍 CPU/内存快照并尽力抓调用栈写进日志。
    // 只记录证据、不做干预——不杀进程、不重启，后续仍由 readyTimer 正常兜底。
    const runStallDiagnostic = (passName) => {
      if (settled) return
      appendLog(`[dsh] 就绪行 ${passName} 未出现，抓取卡住诊断（pid ${child.pid}）`)
      captureStallDiagnostics(child.pid, { wsUrl: childDebugWsUrl }).then((text) => {
        appendLog(`[dsh] 诊断结果 ${passName}：\n${text}`)
      }).catch((err) => {
        appendLog(`[dsh] 诊断失败：${err && err.message ? err.message : err}`)
      })
    }
    diagTimer = setTimeout(() => runStallDiagnostic(`${STALL_DIAGNOSTIC_DELAY_MS / 1000}s`), STALL_DIAGNOSTIC_DELAY_MS)
    diagTimer2 = setTimeout(() => runStallDiagnostic(`${STALL_DIAGNOSTIC_SECOND_PASS_MS / 1000}s`), STALL_DIAGNOSTIC_SECOND_PASS_MS)
  })
}

/** startDsh 返回成功后，确认就绪的仍是当前存活子进程。 */
function startedDshIsActive(started) {
  return Boolean(started?.ok && started.child && dshChild === started.child && started.child.exitCode === null)
}

/** 停止 dsh：Windows 用 taskkill 杀整棵进程树。 */
function stopDsh() {
  if (!dshChild) return
  const child = dshChild
  dshChild = null
  expectedDshExits.add(child)
  appendLog('[dsh] stopping')
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      child.kill('SIGTERM')
      setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 2000).unref()
    }
  } catch {}
}

/** DSH 就绪后意外退出：不自动重启，立即要求用户选择重试或退出。 */
async function handleUnexpectedDshExit(code, stderr) {
  if (handlingUnexpectedDshExit || isQuitting) return
  handlingUnexpectedDshExit = true
  refreshTrayRuntimeBusy()
  currentUrl = null
  const initialDetail = `dsh exited (code ${code})\n${String(stderr ?? '').slice(-2000)}`.trim()
  appendLog(`[dsh] unexpected exit: code ${code}`)

  try {
    if (!showMainWindow()) {
      if (!splash || splash.isDestroyed()) createSplash()
      setSplashError(
        'dshExitedTitle',
        'dshExitedMessage',
        initialDetail,
        [
          dialogButton('exit', 'actionExit'),
          dialogButton('open-log', 'actionOpenLog'),
          dialogButton('retry', 'actionRetry', 'primary', { default: true }),
        ],
      )
      return
    }

    let detail = initialDetail
    while (!isQuitting) {
      const failure = createAppDialog({
        mode: 'error',
        title: t(locale, 'dshExitedTitle'),
        message: t(locale, 'dshExitedMessage'),
        detail,
        cancelable: false,
        defaultAction: 'retry',
        buttons: [
          dialogButton('open-log', 'actionOpenLog', 'secondary', { keepOpen: true }),
          dialogButton('exit', 'actionExit'),
          dialogButton('retry', 'actionRetry', 'primary'),
        ],
      })
      const action = await failure.result
      if (action === 'exit') {
        quitApp()
        return
      }
      if (action !== 'retry') return

      const progress = createAppDialog({
        mode: 'progress',
        title: t(locale, 'dshRestartingTitle'),
        message: t(locale, 'startupStartDsh'),
        cancelable: false,
        buttons: [],
      })
      const started = await startDsh()
      if (!started.ok || !startedDshIsActive(started)) {
        stopDsh()
        detail = String(started.error ?? t(locale, 'dshExitedMessage')).slice(-4000)
        progress.close('failed')
        continue
      }

      try {
        currentUrl = started.url
        progress.close('completed')
        const wc = contentWebContents()
        if (wc) await wc.loadURL(started.url)
        else createMainWindow(started.url)
        if (!startedDshIsActive(started)) {
          currentUrl = null
          detail = t(locale, 'dshExitedMessage')
          continue
        }
        return
      } catch (err) {
        stopDsh()
        currentUrl = null
        detail = String(err && err.stack ? err.stack : err).slice(-4000)
        progress.close('failed')
      }
    }
  } finally {
    handlingUnexpectedDshExit = false
    refreshTrayRuntimeBusy()
  }
}

// ── 更新 ─────────────────────────────────────────────────────────────────────

async function checkForUpdates(manual) {
  const isManual = manual === true
  if (isManual && !showMainWindow()) return
  if (handlingUnexpectedDshExit) {
    appendLog('[update] 忽略检查请求：DSH 正在等待用户恢复')
    return
  }
  const activeOperation = runtimeOperationLock.activeOperation()
  if (activeOperation) {
    appendLog(`[update] 忽略检查请求：正在执行 ${activeOperation}`)
    return
  }
  if (updateCheckPromise) {
    const currentCheck = updateCheckPromise
    await currentCheck
    if (updateCheckPromise === currentCheck) updateCheckPromise = null
    if (isManual) return checkForUpdates(true)
    return
  }

  updateCheckPromise = performUpdateCheck(isManual)
  try {
    await updateCheckPromise
  } finally {
    updateCheckPromise = null
  }
}

async function performUpdateCheck(manual) {
  const installed = runtime.installedVersion()
  const checking = manual
    ? createAppDialog({
        mode: 'loading',
        title: t(locale, 'updateCheckingTitle'),
        message: t(locale, 'updateCheckingMessage'),
        cancelable: false,
        buttons: [],
      })
    : null

  const latest = await runtime.latestVersion({ log: appendLog })

  if (!latest) {
    appendLog('[update] npm registry unavailable')
    if (!manual) return
    checking.update({
      mode: 'error',
      title: t(locale, 'updateOfflineTitle'),
      message: t(locale, 'updateOfflineMessage'),
      detail: installed ?? '',
      cancelable: true,
      cancelAction: 'close',
      defaultAction: 'retry',
      buttons: [
        dialogButton('close', 'actionClose'),
        dialogButton('retry', 'actionRetry', 'primary'),
      ],
    })
    const action = await checking.result
    if (action === 'retry') return performUpdateCheck(true)
    return
  }

  const hasUpdate = !installed || runtime.compareVersions(latest, installed) > 0
  if (!hasUpdate) {
    setPendingUpdateVersion(null)
    if (!manual) return
    checking.update({
      mode: 'info',
      title: t(locale, 'updateCurrentTitle'),
      message: t(locale, 'updateCurrentMessage', { version: installed ?? latest }),
      detail: '',
      cancelable: true,
      cancelAction: 'close',
      defaultAction: 'close',
      buttons: [dialogButton('close', 'actionClose', 'primary')],
    })
    await checking.result
    return
  }

  if (!manual && (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible())) {
    setPendingUpdateVersion(latest)
    appendLog(`[update] ${latest} available; prompt deferred until window is shown`)
    return
  }

  checking?.close('continue')
  await promptUpdateVersion(latest)
}

function maybeCheckForUpdates() {
  if (!updatePreferences.checkUpdatesOnStartup || startupUpdateChecked) return
  startupUpdateChecked = true
  checkForUpdates(false).catch((err) => appendLog(`[update] 自动检查失败：${err.message}`))
}

async function applyUpdate(version) {
  return installRuntimeVersion(version, 'update')
}

async function promptUpdateVersion(version) {
  if (pendingUpdatePrompting) return
  const installed = runtime.installedVersion()
  if (installed && runtime.compareVersions(version, installed) <= 0) {
    setPendingUpdateVersion(null)
    return
  }
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) {
    setPendingUpdateVersion(version)
    return
  }

  pendingUpdatePrompting = true
  try {
    const action = await showAppDialog({
      mode: 'confirm',
      title: t(locale, 'updateAvailableTitle'),
      message: t(locale, 'updateAvailableMessage', { version }),
      detail: t(locale, 'updateAvailableDetail', { current: installed ?? '-', version }),
      cancelable: true,
      cancelAction: 'later',
      defaultAction: 'update',
      buttons: [
        dialogButton('later', 'actionLater'),
        dialogButton('update', 'actionUpdateNow', 'primary'),
      ],
    })
    if (action === 'unavailable' || action === 'replaced') return
    setPendingUpdateVersion(null)
    if (action === 'update') await applyUpdate(version)
  } finally {
    pendingUpdatePrompting = false
  }
}

function maybeShowPendingUpdate() {
  const version = updatePreferences.pendingUpdateVersion
  if (!version || pendingUpdatePrompting || activeAppDialog) return
  promptUpdateVersion(version).catch((err) => appendLog(`[update] pending prompt failed: ${err.message}`))
}

async function installRuntimeVersion(version, operation) {
  const activeOperation = runtimeOperationLock.activeOperation()
  if (activeOperation) {
    appendLog(`[${operation}] 拒绝并发操作：正在执行 ${activeOperation}`)
    return false
  }

  const execution = await runtimeOperationLock.run(operation, async () => {
    appendLog(`[${operation}] runtime operation started`)
    try {
      return await performRuntimeInstall(version, operation)
    } finally {
      appendLog(`[${operation}] runtime operation finished`)
    }
  })
  return execution.accepted ? execution.value : false
}

async function performRuntimeInstall(version, operation) {
  while (true) {
    const progress = createAppDialog({
      mode: 'progress',
      title: t(locale, 'updateInstallingTitle'),
      message: t(locale, 'updateInstallingMessage', { version }),
      cancelable: false,
      buttons: [],
    })
    appendLog(`[${operation}] installing ${version}`)
    let lastProgressAt = 0
    const installed = await runtime.installVersion(version, {
      log: appendLog,
      // 把 npm 输出实时显示到进度弹窗，用户能看到下载到哪个包、是否在推进
      onProgress: (text) => {
        const now = Date.now()
        if (now - lastProgressAt < 500) return
        lastProgressAt = now
        const line = String(text)
          .replace(/\u001b\[[0-9;]*m/g, '') // 去掉 ANSI 颜色码
          .split(/\r?\n/)
          .filter(Boolean)
          .pop()
        if (line) progress.update({ detail: line.slice(-160) })
      },
    })
    if (!installed.ok) {
      appendLog(`[${operation}] install failed: ${installed.err ?? 'unknown error'}`)
      progress.update({
        mode: 'error',
        title: t(locale, 'updateFailedTitle'),
        message: t(locale, 'updateFailedMessage', { version }),
        detail: String(installed.err ?? '').slice(-4000),
        cancelable: true,
        cancelAction: 'close',
        defaultAction: 'retry',
        buttons: [
          dialogButton('open-log', 'actionOpenLog', 'secondary', { keepOpen: true }),
          dialogButton('close', 'actionClose'),
          dialogButton('retry', 'actionRetry', 'primary'),
        ],
      })
      const action = await progress.result
      if (action === 'retry') continue
      return false
    }

    stopDsh()
    appendLog(`[${operation}] installed ${installed.version}, restarting dsh`)
    progress.update({
      mode: 'progress',
      message: t(locale, 'startupStartDsh'),
      detail: '',
      cancelable: false,
      buttons: [],
    })
    const started = await startDsh()
    if (!started.ok || !startedDshIsActive(started)) {
      appendLog(`[${operation}] restart failed: ${started.error ?? 'dsh exited after becoming ready'}`)
      stopDsh()
      progress.update({
        mode: 'error',
        title: t(locale, 'updateRestartFailedTitle'),
        message: t(locale, 'updateRestartFailedMessage'),
        detail: String(started.error ?? t(locale, 'dshExitedMessage')).slice(-4000),
        cancelable: true,
        cancelAction: 'close',
        defaultAction: 'retry',
        buttons: [
          dialogButton('open-log', 'actionOpenLog', 'secondary', { keepOpen: true }),
          dialogButton('close', 'actionClose'),
          dialogButton('retry', 'actionRetry', 'primary'),
        ],
      })
      const action = await progress.result
      if (action === 'retry') continue
      return false
    }

    setPendingUpdateVersion(null)
    currentUrl = started.url
    progress.close('completed')
    const wc = contentWebContents()
    if (wc) await wc.loadURL(started.url)
    else createMainWindow(started.url)
    return true
  }
}

// ── 托盘动作 ─────────────────────────────────────────────────────────────────

function openInBrowser() {
  if (currentUrl) shell.openExternal(currentUrl)
}

/** 托盘「打开终端」：显示主窗口并展开终端面板。 */
function openTerminal() {
  if (!showMainWindow()) return
  terminalManager?.showPanel()
}

function openLog() {
  shell.openPath(LOG_FILE).catch(() => shell.showItemInFolder(LOG_FILE))
}

function openConfigDir() {
  shell.openPath(path.join(os.homedir(), '.dsh')).catch(() => {})
}

function toggleDevtools() {
  contentWebContents()?.toggleDevTools()
}

function toggleFullscreen() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setFullScreen(!mainWindow.isFullScreen())
}

function quitApp() {
  isQuitting = true
  app.quit()
}

function setupTray() {
  if (tray) return
  tray = createTray({
    checkForUpdates,
    startupUpdateCheckEnabled,
    setStartupUpdateCheckEnabled,
    openInBrowser,
    openTerminal,
    openLog,
    openConfigDir,
    showMainWindow,
    quit: quitApp,
  }, locale)
  refreshTrayRuntimeBusy()
}

// ── 启动流程 ─────────────────────────────────────────────────────────────────

async function startup() {
  initLog()
  loadUpdatePreferences()
  applySettings(settingsReader.readSettings())
  setupIpc()
  terminalManager = createTerminalManager({
    getMainWindow: () => mainWindow,
    getLocale: () => locale,
    getDockMode: () => updatePreferences.terminalDock,
    setDockMode: (mode) => {
      if (updatePreferences.terminalDock === mode) return
      updatePreferences.terminalDock = mode
      saveUpdatePreferences()
      appendLog(`[terminal] 停靠偏好 -> ${mode}`)
    },
    appendLog,
    // 面板可见性所有翻转路径（按钮/快捷键/托盘/面板收起）统一刷新窗口按钮状态
    onPanelVisibleChange: () => sendWindowControlsState(),
  })
  terminalManager.init()
  setupTray()
  setupShortcuts()
  settingsReader.watchSettings(applySettings)
  createSplash()
  await runStartupAttempt()
}

async function runStartupAttempt() {
  if (startupInProgress) return
  startupInProgress = true
  startupAttempt += 1
  if (!splash || splash.isDestroyed()) createSplash()

  try {
    setSplashLoading('startupCheckEnvironment')
    const nodeVersion = runtime.nodeVersion()
    if (!runtime.nodeIsAvailable(nodeVersion)) {
      setSplashError(
        'startupNodeMissingTitle',
        'startupNodeMissingMessage',
        t(locale, 'startupNodeMissingDetail'),
        [
          dialogButton('exit', 'actionExit'),
          dialogButton('retry', 'actionRetry'),
          dialogButton('download-node', 'actionDownloadNode', 'primary', { default: true }),
        ],
      )
      return
    }

    const hasRuntime = runtime.runtimeStatus().usable
    setSplashLoading(hasRuntime ? 'startupPrepareRuntime' : 'startupInstallRuntime')
    const ensured = await runtime.ensureRuntime()
    if (!ensured.ok) {
      appendLog(`[runtime] ensure failed: ${ensured.err ?? 'unknown error'}`)
      setSplashError(
        'startupRuntimeFailedTitle',
        'startupRuntimeFailedMessage',
        ensured.err,
        [
          dialogButton('exit', 'actionExit'),
          dialogButton('open-log', 'actionOpenLog'),
          dialogButton('retry', 'actionRetry', 'primary', { default: true }),
        ],
      )
      return
    }
    appendLog(`[runtime] 当前 @deepseek-ai/dsh 版本：${ensured.version}`)

    setSplashLoading('startupStartDsh')
    stopDsh()
    const started = await startDsh()
    if (!started.ok || !startedDshIsActive(started)) {
      appendLog(`[startup] dsh failed: ${started.error ?? 'dsh exited after becoming ready'}`)
      stopDsh()
      setSplashError(
        'startupDshFailedTitle',
        'startupDshFailedMessage',
        started.error ?? t(locale, 'dshExitedMessage'),
        [
          dialogButton('exit', 'actionExit'),
          dialogButton('open-log', 'actionOpenLog'),
          dialogButton('retry', 'actionRetry', 'primary', { default: true }),
        ],
      )
      return
    }

    setSplashLoading('startupLoadInterface')
    if (mainWindow && !mainWindow.isDestroyed()) {
      currentUrl = started.url
      await mainWindow.webContents.loadURL(started.url)
    } else {
      createMainWindow(started.url)
    }
    maybeCheckForUpdates()
  } catch (err) {
    appendLog(`[startup] unexpected error: ${err && err.stack ? err.stack : err}`)
    setSplashError(
      'startupUnexpectedTitle',
      'startupUnexpectedMessage',
      err && err.stack ? err.stack : err,
      [
        dialogButton('exit', 'actionExit'),
        dialogButton('open-log', 'actionOpenLog'),
        dialogButton('retry', 'actionRetry', 'primary', { default: true }),
      ],
    )
  } finally {
    startupInProgress = false
  }
}

// ── 应用生命周期 ─────────────────────────────────────────────────────────────

app.setAppUserModelId(APP_ID)
nativeTheme.on('updated', () => {
  refreshSplashAppearance()
})

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showMainWindow())

  app.whenReady().then(startup).catch((err) => {
    appendLog(`[startup] fatal bootstrap error: ${err && err.stack ? err.stack : err}`)
    if (splash && !splash.isDestroyed()) {
      startupAttempt += 1
      setSplashError(
        'startupUnexpectedTitle',
        'startupUnexpectedMessage',
        err && err.stack ? err.stack : err,
        [dialogButton('exit', 'actionExit', 'primary', { default: true })],
      )
    } else {
      dialog.showErrorBox('DSH Desktop', `启动界面无法创建：\n${err && err.stack ? err.stack : err}`)
      app.quit()
    }
  })

  // 关窗不退出：主窗口关闭已被拦截为「隐藏到托盘」。
  app.on('window-all-closed', () => {})

  app.on('before-quit', () => {
    isQuitting = true
    stopDsh()
    if (terminalManager) {
      // 优雅关闭终端宿主；即使来不及完成，宿主也会在 stdin 关闭后自行收尾
      terminalManager.shutdown().catch((err) => appendLog(`[terminal] 退出清理异常：${err.message}`))
    }
    runtime.killActiveChildren() // 应用退出时终止在跑的 npm 子进程，避免孤儿进程继续写运行时目录
    if (logStream && !logStream.writableEnded) {
      try { logStream.end() } catch {}
    }
  })
  // 兜底：进程非正常退出时同样清理子进程（fire-and-forget）。
  process.on('exit', () => runtime.killActiveChildren())
}
