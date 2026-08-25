'use strict'
/**
 * 终端面板主进程管理器。
 *
 * 职责：
 *  1. pty-host 生命周期：node-pty 懒安装（~/.dshdesktop/pty-host）→ 拉起宿主 → 退出记录；
 *  2. 会话表：spawn/write/resize/kill 的会话状态机，data/exit 事件转发；
 *  3. IPC：面板视图专属通道，全部校验 event.sender === 面板 webContents，
 *     DSH 内容页（mainWindow.webContents）永远无法触达终端通道；
 *  4. 面板视图：WebContentsView 懒创建、bounds 与窗口 resize 防抖联动、开关与焦点。
 *
 * 通过 createTerminalManager(deps) 注入主窗口提供者与日志，与 main.js 解耦。
 */
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const crypto = require('node:crypto')
const { app, WebContentsView, ipcMain, nativeTheme, protocol } = require('electron')
const runtime = require('../runtime-manager.js')
const utils = require('./utils.js')
const { TerminalHostClient } = require('./host-client.js')
const { t } = require('../i18n.js')
const workspaceResolver = require('../workspace-resolver.js')

/**
 * 面板页面的专用 scheme。沙箱渲染进程里 file:// 页面无法加载 file:// 子资源
 * （外部 <script src> 被静默拦截，集成冒烟实测），自定义 scheme 由浏览器进程
 * 经 protocol.handle 提供字节，子资源加载不受 file: 策略限制。
 * 必须在 app ready 之前注册：本模块被 main.js 在顶层 require，模块加载即注册。
 */
const PANEL_SCHEME = 'dsh-term'
protocol.registerSchemesAsPrivileged([
  { scheme: PANEL_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

/**
 * 面板入口地址（相对引用 renderer.js 等子资源解析到同一 scheme）。
 * 携带停靠模式查询参数：持久化停靠为 right 时，页面首帧即按右停靠布局渲染，
 * 避免「首启右停靠却按 bottom 布局渲染、面板顶部出现水平拖动条」的错版
 * （用户实测：切换一次停靠后才恢复，因为首个 dock-state 在页面加载前发送会丢失）。
 */
function panelEntry(mode) {
  return `${PANEL_SCHEME}://local/panel/index.html?dock=${mode}`
}

/** node-pty 安装目录（与 pty-host.js 的默认模块目录一致）。 */
const PTY_HOST_DIR = path.join(runtime.BASE_DIR, 'pty-host')
/** 锁定的 node-pty 版本，与 pty-host.js 顶部常量保持一致。 */
const PTY_PACKAGE_VERSION = '1.1.0'
/** npm 11 的 allow-scripts 机制：必须显式放行 node-pty 的安装脚本（下载预编译二进制）。 */
const PTY_ALLOW_SCRIPTS = { [`node-pty@${PTY_PACKAGE_VERSION}`]: true }
/** 首次安装 node-pty 的硬超时（与 runtime-manager 的安装超时同量级）。 */
const HOST_INSTALL_TIMEOUT_MS = 600000
/** 窗口 resize 后重算面板 bounds 的防抖时长。 */
const PANEL_RESIZE_DEBOUNCE_MS = 100
/** 会话初始尺寸（面板打开后由页面按实际尺寸上报并 resize）。 */
const INITIAL_COLS = 80
const INITIAL_ROWS = 24
/** 右侧停靠模式的默认宽度比例与上下限。 */
const RIGHT_DOCK_RATIO = 0.35
const RIGHT_DOCK_MIN_WIDTH = 320
const RIGHT_DOCK_MAX_RATIO = 0.6
/** 右侧停靠时顶部让出的最小高度（窗口按钮区 28px，WebContentsView 永远盖在页面之上）。 */
const RIGHT_DOCK_TOP_INSET = 28
/** 面板 header 高度（panel/index.html 的 .header），用于与 DSH 标题区域底边线对齐。 */
const PANEL_HEADER_HEIGHT = 34

function createTerminalManager({
  getMainWindow,
  getLocale,
  getDockMode,
  setDockMode,
  appendLog,
  onPanelVisibleChange,
}) {
  let panelView = null
  let panelVisible = false
  let resizeTimer = null
  let insetTimer = null
  let hostClient = null
  let hostEnsurePromise = null
  let hostStarting = null
  let disposed = false
  // 当前停靠模式由本模块持有，外部持久化（preferences.json）只是副作用
  let dock = 'bottom'
  // 会话区域几何（preload.js 从 DSH 页面观测上报，缺失时回退全宽）
  let layout = null // { sidebarRight, contentRight, headerBottom }
  // 页面浮层状态（设置面板/弹窗）：浮层出现时自动收起面板，关闭后恢复
  let overlayOpen = false
  let reopenedAfterOverlay = false
  // 多会话：当前激活的会话 id（面板展示的 pane），命名序号
  let activeSessionId = null
  let sessionSequence = 0
  // 用户拖动后的面板尺寸覆盖（null = 默认比例）；带 clamp，不持久化
  let panelHeightOverride = null
  let panelWidthOverride = null
  const sessions = new Map() // sessionId -> { sessionId, shell, pid, name }

  function log(message) {
    appendLog(`[terminal] ${message}`)
  }

  /**
   * 面板可见性翻转后通知外部（main.js 据此刷新窗口按钮的「终端已显示」状态）。
   * 所有开关路径（窗口按钮、面板收起按钮、Ctrl+` 快捷键、托盘）都汇聚到这里，
   * 避免某个入口漏刷新导致按钮状态停留在旧值。
   */
  function notifyPanelVisibleChange() {
    if (typeof onPanelVisibleChange === 'function') onPanelVisibleChange(panelVisible)
  }

  // ── 面板消息通道 ────────────────────────────────────────────────────────────

  function sendToPanel(channel, payload) {
    if (!panelView || panelView.webContents.isDestroyed()) return
    panelView.webContents.send(channel, payload)
  }

  function isPanelSender(event) {
    return Boolean(panelView && !panelView.webContents.isDestroyed() && event.sender === panelView.webContents)
  }

  /** 面板文案：统一在 i18n.js 维护，随 locale 下发，页面不内置语言分支。 */
  function panelStrings(locale) {
    return {
      title: t(locale, 'terminalTitle'),
      connecting: t(locale, 'terminalConnecting'),
      installing: t(locale, 'terminalInstalling'),
      startingSession: t(locale, 'terminalStartingSession'),
      connected: t(locale, 'terminalConnected'),
      exited: t(locale, 'terminalExited'),
      reopen: t(locale, 'terminalReopen'),
      hostFailed: t(locale, 'terminalHostFailed'),
      close: t(locale, 'terminalClose'),
      dockBottom: t(locale, 'terminalDockBottom'),
      dockRight: t(locale, 'terminalDockRight'),
      newSession: t(locale, 'terminalNewSession'),
      closeSession: t(locale, 'terminalCloseSession'),
      renameHint: t(locale, 'terminalRenameHint'),
    }
  }

  /** 下发外观：深/浅色 + locale + 面板文案（ready、主题变化、语言切换时调用）。 */
  function sendAppearance() {
    const locale = typeof getLocale === 'function' ? getLocale() : 'zh'
    sendToPanel('terminal:appearance', {
      dark: nativeTheme.shouldUseDarkColors,
      locale,
      strings: panelStrings(locale),
    })
  }

  // ── node-pty 懒安装 ─────────────────────────────────────────────────────────

  function nodePtyInstalled() {
    return fs.existsSync(path.join(PTY_HOST_DIR, 'node_modules', 'node-pty'))
  }

  /** 确保 node-pty 可用；首次打开终端时才触发安装，不增加应用首启负担。 */
  function ensurePtyHostInstalled() {
    if (nodePtyInstalled()) return Promise.resolve({ ok: true })
    if (hostEnsurePromise) return hostEnsurePromise
    hostEnsurePromise = (async () => {
      log(`node-pty 未安装，开始安装到 ${PTY_HOST_DIR}`)
      sendToPanel('terminal:host-state', { state: 'installing' })
      try {
        fs.mkdirSync(PTY_HOST_DIR, { recursive: true })
        fs.writeFileSync(path.join(PTY_HOST_DIR, 'package.json'), JSON.stringify({
          name: 'dsh-pty-host',
          private: true,
          version: '1.0.0',
          description: 'DSH Desktop 终端宿主运行时目录，请勿手动修改',
          dependencies: { 'node-pty': PTY_PACKAGE_VERSION },
          allowScripts: PTY_ALLOW_SCRIPTS,
        }, null, 2) + '\n')
        const res = await runtime.run(runtime.npmCommand(), [
          'install', '--no-audit', '--no-fund', '--loglevel=http',
          '--fetch-timeout=90000', '--fetch-retries=1',
        ], { cwd: PTY_HOST_DIR, timeoutMs: HOST_INSTALL_TIMEOUT_MS })
        if (!res.ok) {
          const detail = String(res.err || res.error?.message || '未知错误').slice(-2000)
          return { ok: false, error: detail }
        }
        if (!nodePtyInstalled()) return { ok: false, error: '安装完成但 node-pty 缺失' }
        log('node-pty 安装完成')
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err.message }
      } finally {
        hostEnsurePromise = null
      }
    })()
    return hostEnsurePromise
  }

  // ── 宿主进程生命周期 ────────────────────────────────────────────────────────

  /** 确保宿主进程在跑；首次会先确保 node-pty 就位。返回宿主客户端或 null。 */
  function ensureHost() {
    if (hostClient && hostClient.alive) return Promise.resolve(hostClient)
    if (hostStarting) return hostStarting
    hostStarting = (async () => {
      const installed = await ensurePtyHostInstalled()
      if (!installed.ok) {
        const message = `终端服务不可用：${installed.error}`
        log(message)
        sendToPanel('terminal:error', { message })
        return null
      }
      // pty-host 由系统 Node 独立执行（不是 Electron 主进程），读不了 app.asar
      // 归档内的脚本；打包后必须指向 resources/app.asar.unpacked 下的副本
      // （package.json 的 asarUnpack 正是为此），否则宿主报 Cannot find module
      // 立即退出，安装版终端表现为红灯、无默认会话、加号无效。开发模式
      // __dirname 是真实源码目录，直接使用即可。
      const hostPath = app.isPackaged
        ? path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'terminal', 'pty-host.js')
        : path.join(__dirname, 'pty-host.js')
      const client = new TerminalHostClient({
        hostPath,
        moduleDir: path.join(PTY_HOST_DIR, 'node_modules'),
        log: (text) => log(String(text).trimEnd()),
      })
      client.onData = ({ sessionId, data }) => {
        if (sessions.has(sessionId)) sendToPanel('terminal:data', { sessionId, data })
      }
      client.onExit = ({ sessionId, code }) => {
        sessions.delete(sessionId)
        if (activeSessionId === sessionId) activeSessionId = null
        sendToPanel('terminal:exit', { sessionId, code })
        broadcastSessions()
      }
      client.onClosed = (code) => {
        log(`终端宿主退出（code ${code}），全部会话失效`)
        sessions.clear()
        activeSessionId = null
        hostClient = null
        broadcastSessions()
        if (!disposed) sendToPanel('terminal:host-state', { state: 'down', message: '终端服务已停止' })
      }
      try {
        await client.start()
      } catch (err) {
        log(`终端宿主启动失败：${err.message}`)
        sendToPanel('terminal:error', { message: `终端服务不可用：${err.message}` })
        return null
      }
      hostClient = client
      log(`终端宿主已就绪（pid ${client.pid}）`)
      return client
    })()
    const result = hostStarting
    hostStarting.finally(() => { if (hostStarting === result) hostStarting = null })
    return result
  }

  // ── 会话表 ──────────────────────────────────────────────────────────────────

  /** 会话默认工作目录：优先 DSH 当前工作区，推断失败回退用户主目录。 */
  function defaultSessionCwd() {
    try {
      const workspace = workspaceResolver.resolveWorkspace()
      if (typeof workspace === 'string' && workspace.length > 0) return workspace
    } catch (err) {
      log(`工作区推断失败：${err.message}`)
    }
    return os.homedir()
  }

  /** 新会话默认名称：终端 1、终端 2…（随 locale 文案）。 */
  function nextSessionName() {
    sessionSequence += 1
    const locale = typeof getLocale === 'function' ? getLocale() : 'zh'
    return t(locale, 'terminalSessionName', { n: sessionSequence })
  }

  /** 会话列表广播：面板据此维护右侧管理区（列表/激活态/命名）。 */
  function broadcastSessions() {
    sendToPanel('terminal:sessions', {
      activeSessionId,
      sessions: Array.from(sessions.values()).map((session) => ({
        sessionId: session.sessionId,
        name: session.name,
        shell: session.shell,
        pid: session.pid,
      })),
    })
  }

  async function spawnSession() {
    const client = await ensureHost()
    if (!client) return { ok: false, error: '终端服务不可用' }
    const sessionId = crypto.randomUUID()
    const shell = utils.detectShell()
    const cwd = defaultSessionCwd()
    const name = nextSessionName()
    try {
      const res = await client.request('spawn', {
        sessionId,
        shell,
        cwd,
        cols: INITIAL_COLS,
        rows: INITIAL_ROWS,
      })
      if (!res.ok) return { ok: false, error: res.error || '创建会话失败' }
      sessions.set(sessionId, { sessionId, shell, pid: res.pid, name })
      activeSessionId = sessionId
      log(`会话 ${sessionId} 已创建（shell=${shell}, cwd=${cwd}, name=${name}）`)
      return { ok: true, sessionId, shell, pid: res.pid, name }
    } catch (err) {
      log(`创建会话失败：${err.message}`)
      return { ok: false, error: err.message }
    }
  }

  // ── IPC（面板专属，全部校验来源） ──────────────────────────────────────────

  function setupIpc() {
    ipcMain.on('terminal:ready', (event) => {
      if (!isPanelSender(event)) return
      // 就绪时补发停靠模式：首次 showPanel 时页面尚未加载完，早先的 dock-state
      // 消息会丢失；不补发则首启右停靠时页面停留在 data-dock=bottom 布局，
      // 面板顶部出现本应隐藏的水平拖动条（用户实测：切一次停靠才恢复）
      sendToPanel('terminal:dock-state', { mode: dockMode() })
      sendAppearance()
      const state = hostClient && hostClient.alive ? 'ready' : 'starting'
      sendToPanel('terminal:host-state', { state })
      void spawnSession().then((result) => {
        if (result.ok) {
          sendToPanel('terminal:spawned', { sessionId: result.sessionId, shell: result.shell, pid: result.pid, name: result.name })
          broadcastSessions()
        } else {
          sendToPanel('terminal:error', { message: result.error })
        }
      })
    })

    ipcMain.on('terminal:spawn', (event) => {
      if (!isPanelSender(event)) return
      void spawnSession().then((result) => {
        if (result.ok) {
          sendToPanel('terminal:spawned', { sessionId: result.sessionId, shell: result.shell, pid: result.pid, name: result.name })
          broadcastSessions()
        } else {
          sendToPanel('terminal:error', { message: result.error })
        }
      })
    })

    ipcMain.on('terminal:data', (event, payload) => {
      if (!isPanelSender(event)) return
      const { sessionId, text } = payload || {}
      if (!utils.validSessionId(sessionId) || !sessions.has(sessionId) || typeof text !== 'string') return
      void hostClient?.write(sessionId, text).catch((err) => log(`写入失败：${err.message}`))
    })

    ipcMain.on('terminal:resize', (event, payload) => {
      if (!isPanelSender(event)) return
      const { sessionId, cols, rows } = payload || {}
      if (!utils.validSessionId(sessionId) || !sessions.has(sessionId)) return
      void hostClient?.resize(sessionId, utils.clampSize(cols, INITIAL_COLS), utils.clampSize(rows, INITIAL_ROWS))
        .catch((err) => log(`调整尺寸失败：${err.message}`))
    })

    ipcMain.on('terminal:kill', (event, payload) => {
      if (!isPanelSender(event)) return
      const { sessionId } = payload || {}
      if (!utils.validSessionId(sessionId) || !sessions.has(sessionId)) return
      void hostClient?.killSession(sessionId).catch(() => {})
    })

    ipcMain.on('terminal:activate', (event, payload) => {
      if (!isPanelSender(event)) return
      const { sessionId } = payload || {}
      if (!utils.validSessionId(sessionId) || !sessions.has(sessionId)) return
      if (activeSessionId === sessionId) return
      activeSessionId = sessionId
      broadcastSessions()
    })

    ipcMain.on('terminal:rename', (event, payload) => {
      if (!isPanelSender(event)) return
      const { sessionId, name } = payload || {}
      if (!utils.validSessionId(sessionId) || !sessions.has(sessionId)) return
      const normalized = typeof name === 'string' ? name.trim().slice(0, 32) : ''
      if (!normalized) return
      sessions.get(sessionId).name = normalized
      log(`会话 ${sessionId} 重命名为 ${normalized}`)
      broadcastSessions()
    })

    ipcMain.on('terminal:toggle-panel', (event) => {
      if (!isPanelSender(event)) return
      togglePanel()
    })

    ipcMain.on('terminal:set-dock', (event, mode) => {
      if (!isPanelSender(event)) return
      setDock(mode)
    })

    // 面板拖动调整（相对增量）。边界拖动条语义（与内部 #split 一致）：
    // 右停靠的 resizeV 在面板左缘——右拖 = 左缘右移 = 面板变窄；
    // 底部停靠的 resizeH 在面板顶缘——下拖 = 顶缘下移 = 面板变矮。
    // 因此按「边缘跟随光标」取负增量（未取负前用户实测方向反转：
    // 向下拖动终端反而增加了高度）。
    ipcMain.on('terminal:panel-resize', (event, payload) => {
      if (!isPanelSender(event)) return
      const dx = Number(payload && payload.dx)
      const dy = Number(payload && payload.dy)
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return
      const win = getMainWindow()
      if (!win || win.isDestroyed()) return
      const [width, height] = win.getContentSize()
      if (dockMode() === 'right') {
        const base = panelWidthOverride ?? computeDockBounds(width, height).width
        panelWidthOverride = Math.round(Math.min(Math.max(base - dx, 200), width * 0.75))
      } else {
        const base = panelHeightOverride ?? computeDockBounds(width, height).height
        panelHeightOverride = Math.round(Math.min(Math.max(base - dy, 120), height * 0.85))
      }
      updatePanelBounds()
    })

    // DSH 页面布局观测（preload.js 上报，只校验 sender 与数值）
    ipcMain.on('dsh:content-layout', (event, payload) => {
      const win = getMainWindow()
      if (!win || win.isDestroyed() || event.sender !== win.webContents) return
      const sidebarRight = Number(payload && payload.sidebarRight)
      const contentRight = Number(payload && payload.contentRight)
      const headerBottom = Number(payload && payload.headerBottom)
      if (!Number.isFinite(sidebarRight) || !Number.isFinite(contentRight)) return
      const next = {
        sidebarRight: Math.round(sidebarRight),
        contentRight: Math.round(contentRight),
        headerBottom: Number.isFinite(headerBottom) ? Math.round(headerBottom) : 0,
      }
      if (layout
        && layout.sidebarRight === next.sidebarRight
        && layout.contentRight === next.contentRight
        && layout.headerBottom === next.headerBottom) return
      layout = next
      updatePanelBounds()
    })

    // 页面浮层状态（preload.js 检测：设置面板/弹窗等）
    // WebContentsView 永远盖在页面之上，浮层出现时工具栏面板会在其下被遮挡——
    // 自动收起（会话保留），浮层关闭后恢复，与「模态优先」的交互语义一致。
    ipcMain.on('dsh:overlay-state', (event, payload) => {
      const win = getMainWindow()
      if (!win || win.isDestroyed() || event.sender !== win.webContents) return
      const open = Boolean(payload && payload.overlay)
      if (open === overlayOpen) return
      overlayOpen = open
      if (open && panelVisible) {
        reopenedAfterOverlay = true
        hidePanel()
        log('页面浮层出现，终端面板已自动收起（会话保留）')
      } else if (!open && reopenedAfterOverlay) {
        reopenedAfterOverlay = false
        showPanel()
        log('页面浮层关闭，终端面板已自动恢复')
      }
    })
  }

  // ── 面板视图 ────────────────────────────────────────────────────────────────

  function ensurePanelView() {
    if (panelView && !panelView.webContents.isDestroyed()) return panelView
    const win = getMainWindow()
    if (!win || win.isDestroyed()) return null
    panelView = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'panel', 'preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    })
    panelView.setVisible(false)
    win.contentView.addChildView(panelView)
    win.on('resize', schedulePanelResize)
    win.on('closed', () => {
      panelView = null
      panelVisible = false
    })
    // 面板是本地受信页面，子资源失败也应进 dsh.log 便于定位
    panelView.webContents.on('did-fail-load', (_event, code, description, url) => {
      log(`面板资源加载失败（${code}）${description}: ${url}`)
    })
    panelView.webContents.loadURL(panelEntry(dockMode())).catch((err) => {
      log(`终端面板加载失败：${err.message}`)
    })
    return panelView
  }

  /** 当前停靠模式（底部/右侧）。 */
  function dockMode() {
    return dock
  }

  /** 按停靠模式与 DSH 会话区域几何计算面板 bounds（纯函数在 utils）。 */
  function computeDockBounds(width, height) {
    return utils.computeDockBounds(width, height, {
      dock: dockMode(),
      layout,
      panelHeight: panelHeightOverride,
      panelWidth: panelWidthOverride,
    })
  }

  /** 面板对 DSH 会话区滚动体的内缩：bottom 模式压底部，right 模式压右侧。 */
  function panelInset() {
    if (!panelVisible) return { bottom: 0, right: 0 }
    const win = getMainWindow()
    if (!win || win.isDestroyed()) return { bottom: 0, right: 0 }
    const [width, height] = win.getContentSize()
    return utils.panelInsetFor(computeDockBounds(width, height), dockMode())
  }

  /** 下发面板内缩给 DSH 页面（preload.js 给会话区滚动体加 padding）。 */
  function sendPanelInset() {
    const win = getMainWindow()
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send('dsh:panel-inset', panelInset())
  }

  /**
   * 内缩下发改 150ms 尾随防抖：拖动边界时 bounds 以 ~60Hz 变化，若每次
   * 都注入 padding，DSH 会话区布局会被以同样频率反复重排（用户实测抖动）。
   * 拖动期间会话区保持静止、松手后一次到位；hidePanel/showPanel 仍即时下发。
   */
  function schedulePanelInset() {
    clearTimeout(insetTimer)
    insetTimer = setTimeout(sendPanelInset, 150)
  }

  function updatePanelBounds() {
    if (!panelView || panelView.webContents.isDestroyed()) return
    const win = getMainWindow()
    if (!win || win.isDestroyed()) return
    const [width, height] = win.getContentSize()
    panelView.setBounds(computeDockBounds(width, height))
    schedulePanelInset()
    // 尺寸变化后由页面 ResizeObserver 重新上报 cols/rows（M3 接 xterm fit；
    // 拖动期间页面会挂起重排，松手后统一 fit）
  }

  function schedulePanelResize() {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(updatePanelBounds, PANEL_RESIZE_DEBOUNCE_MS)
  }

  function showPanel() {
    const view = ensurePanelView()
    if (!view) return false
    // 必须先置 panelVisible 再算 bounds：updatePanelBounds 曾依赖可见状态，
    // 顺序颠倒会让面板永远停在零尺寸（实测表现为按 Ctrl+` 无任何显示）。
    panelVisible = true
    updatePanelBounds()
    panelView.setVisible(true)
    sendToPanel('terminal:focus', {})
    sendToPanel('terminal:dock-state', { mode: dockMode() })
    log('面板已打开')
    notifyPanelVisibleChange()
    return true
  }

  function hidePanel() {
    if (panelView && !panelView.webContents.isDestroyed()) {
      panelView.setVisible(false)
    }
    panelVisible = false
    sendPanelInset()
    log('面板已关闭（会话保留）')
    notifyPanelVisibleChange()
  }

  function togglePanel() {
    return panelVisible ? hidePanel() : showPanel()
  }

  /** 切换停靠模式（底部/右侧），由面板 header 按钮触发；持久化经注入的 setDockMode。 */
  function setDock(mode) {
    const next = mode === 'right' ? 'right' : 'bottom'
    if (dock === next) return
    dock = next
    if (typeof setDockMode === 'function') setDockMode(next)
    log(`停靠模式 -> ${next}`)
    updatePanelBounds()
    sendToPanel('terminal:dock-state', { mode: next })
  }

  // ── 初始化与退出 ────────────────────────────────────────────────────────────

  function init() {
    // 从持久化偏好恢复停靠模式（缺省 bottom）
    if (typeof getDockMode === 'function' && getDockMode() === 'right') dock = 'right'
    // 面板 scheme 的内容提供器：只允许面板自己的文件，杜绝路径穿越。
    // 显式指定 MIME：Chromium 对脚本做严格 MIME 校验，net.fetch(file://) 的
    // Content-Type 不可靠（实测 200 送达但脚本拒不执行）。
    const mimeFor = (filePath) => ({
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
    })[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
    const allowedPanelFile = (filePath) => {
      const rel = path.relative(__dirname, filePath)
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false
      // 面板只允许自身页面（panel/index.html、panel/renderer.js）与 vendor 资源
      // （panel/assets/**）；path.relative 返回平台分隔符，目录级改用 path.sep 拼接
      return rel === path.join('panel', 'index.html') || rel === path.join('panel', 'renderer.js')
        || rel.startsWith(path.join('panel', 'assets') + path.sep)
    }
    protocol.handle(PANEL_SCHEME, (request) => {
      try {
        const url = new URL(request.url)
        const filePath = path.resolve(__dirname, `.${url.pathname}`)
        if (!allowedPanelFile(filePath) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          return new Response('not found', { status: 404 })
        }
        return new Response(fs.readFileSync(filePath), {
          headers: { 'content-type': mimeFor(filePath) },
        })
      } catch (err) {
        log(`面板资源请求失败：${err.message}`)
        return new Response('bad request', { status: 400 })
      }
    })
    setupIpc()
    nativeTheme.on('updated', sendAppearance)
    log('终端管理器已初始化')
  }

  /** 应用退出前调用：优雅关闭宿主（shutdown 请求 + 超时整树强杀兜底）。 */
  async function shutdown() {
    disposed = true
    if (resizeTimer) {
      clearTimeout(resizeTimer)
      resizeTimer = null
    }
    if (insetTimer) {
      clearTimeout(insetTimer)
      insetTimer = null
    }
    if (!hostClient) return
    const client = hostClient
    hostClient = null
    try {
      const result = await client.shutdown(3000)
      log(`终端宿主已关闭（exitCode ${result.exitCode}）`)
    } catch (err) {
      log(`终端宿主关闭异常：${err.message}`)
      client.killTree()
    }
  }

  return {
    init,
    togglePanel,
    showPanel,
    hidePanel,
    isPanelVisible: () => panelVisible,
    /** 主题/语言变化时重新下发外观与文案（main.js 的 applySettings 调用）。 */
    refreshAppearance: sendAppearance,
    /** 切换停靠模式（托盘等外部入口用）。 */
    setDock,
    shutdown,
  }
}

module.exports = { createTerminalManager }
