(() => {
  'use strict'
  /**
   * 终端面板页面逻辑（多终端）：xterm 每个会话一个 pane，右侧管理区负责
   * 切换/重命名/关闭/新建。xterm 6 的 UMD 构建把导出展开到全局
   * （Terminal/FitAddon/ClipboardAddon），由 index.html 以经典 <script> 引入。
   *
   * 注意：'use strict' 必须放在函数体内——沙箱渲染进程经自定义 scheme 加载
   * 经典脚本时，顶层指令会被当作表达式求值（实测报 "use strict" is not a
   * function），因此本文件整体包在 IIFE 里。
   */
  const bridge = window.__terminalBridge
  const { Terminal } = window
  // 首帧布局：HTML 静态 data-dock 恒为 bottom（回退值）。主进程 loadURL 时把
  // 持久化的停靠模式带在查询参数里，页面加载即按正确模式渲染——否则首启
  // 右停靠会先按 bottom 布局渲染一帧（面板顶部出现本应隐藏的水平拖动条）。
  const dockFromQuery = new URLSearchParams(location.search).get('dock')
  if (dockFromQuery === 'right' || dockFromQuery === 'bottom') {
    document.body.dataset.dock = dockFromQuery
  }
  // UMD 形态差异：xterm 核心把导出展开到全局（window.Terminal 直接是类），
  // 而 addon 的 UMD 把整个导出对象挂到全局名下（window.FitAddon.FitAddon 才是类）。
  const FitAddonCtor = (typeof window.FitAddon === 'function' ? window.FitAddon : window.FitAddon && window.FitAddon.FitAddon) || null
  const ClipboardAddonCtor = (typeof window.ClipboardAddon === 'function' ? window.ClipboardAddon : window.ClipboardAddon && window.ClipboardAddon.ClipboardAddon) || null

  const dot = document.getElementById('dot')
  const titleEl = document.getElementById('title')
  const statusEl = document.getElementById('status')
  const newBtn = document.getElementById('newBtn')
  const dockBottomBtn = document.getElementById('dockBottomBtn')
  const dockRightBtn = document.getElementById('dockRightBtn')
  const closeBtn = document.getElementById('closeBtn')
  const stage = document.getElementById('stage')
  const sessionsEl = document.getElementById('sessions')
  const sessionsEmpty = document.getElementById('sessionsEmpty')

  // ── 文案（主进程按 locale 下发，缺省回退中文） ──────────────────────────────
  const DEFAULT_STRINGS = {
    title: '终端',
    connecting: '正在连接…',
    installing: '正在安装终端服务…',
    startingSession: '正在启动会话…',
    connected: '已连接（{shell}）',
    exited: '进程已退出',
    reopen: '重新打开',
    hostFailed: '终端服务不可用',
    close: '收起面板',
    dockBottom: '停靠到底部',
    dockRight: '停靠到右侧',
    newSession: '新建终端',
    closeSession: '关闭终端',
    renameHint: '双击重命名',
    emptySessions: '暂无终端',
  }
  let STR = { ...DEFAULT_STRINGS }

  // ── xterm 主题（深浅两套，与面板/应用配色同源） ─────────────────────────────
  const THEMES = {
    light: {
      background: '#ffffff',
      foreground: '#1f2328',
      cursor: '#1f2328',
      cursorAccent: '#ffffff',
      selectionBackground: 'rgba(77, 107, 254, 0.30)',
      // xterm 6 滚动条滑块颜色按 theme 字段注入样式，缺省是黑色（实测白主题下呈黑色横条）：
      // 统一改为当前主题的半透明滑块色
      scrollbarSliderBackground: 'rgba(0, 0, 0, 0.25)',
      scrollbarSliderHoverBackground: 'rgba(0, 0, 0, 0.35)',
      scrollbarSliderActiveBackground: 'rgba(0, 0, 0, 0.45)',
      black: '#1f2328',
      red: '#c42b1c',
      green: '#2fae5f',
      yellow: '#b58900',
      blue: '#4d6bfe',
      magenta: '#b5651d',
      cyan: '#0083a5',
      white: '#eef0f2',
      brightBlack: '#626873',
      brightRed: '#c42b1c',
      brightGreen: '#2fae5f',
      brightYellow: '#b58900',
      brightBlue: '#4d6bfe',
      brightMagenta: '#b5651d',
      brightCyan: '#0083a5',
      brightWhite: '#ffffff',
    },
    dark: {
      background: '#151517',
      foreground: '#e6e6e6',
      cursor: '#e6e6e6',
      cursorAccent: '#151517',
      selectionBackground: 'rgba(77, 107, 254, 0.40)',
      scrollbarSliderBackground: 'rgba(255, 255, 255, 0.25)',
      scrollbarSliderHoverBackground: 'rgba(255, 255, 255, 0.35)',
      scrollbarSliderActiveBackground: 'rgba(255, 255, 255, 0.45)',
      black: '#1e1e21',
      red: '#f14c4c',
      green: '#3ecf6f',
      yellow: '#d7a84b',
      blue: '#6d8bff',
      magenta: '#c586c0',
      cyan: '#42a5c9',
      white: '#e6e6e6',
      brightBlack: '#9ba1aa',
      brightRed: '#f14c4c',
      brightGreen: '#3ecf6f',
      brightYellow: '#d7a84b',
      brightBlue: '#6d8bff',
      brightMagenta: '#c586c0',
      brightCyan: '#42a5c9',
      brightWhite: '#ffffff',
    },
  }

  // ── 多会话状态 ──────────────────────────────────────────────────────────────
  // sessionId -> { sessionId, term, fitAddon, pane, exitBar, reopenBtn, exited }
  const panes = new Map()
  const sessionNames = new Map() // 广播数据里的名称（管理区展示）
  let activeSessionId = null
  let currentDark = false
  // 面板边界拖动进行中：挂起 xterm 重排与 PTY resize（拖动结束统一 fit），
  // 否则 bounds 每次变化都触发 xterm 重排，拖动中文字块反复跳动
  let resizingPanel = false

  // ── 终端实例 ────────────────────────────────────────────────────────────────

  function createPane(sessionId) {
    let entry = panes.get(sessionId)
    if (entry) return entry

    const pane = document.createElement('div')
    pane.className = 'term-pane'
    stage.appendChild(pane)

    const viewport = document.createElement('div')
    // 必须是「有确定高度」的 flex 容器（见 index.html 的 .term-pane/.xterm-host）
    viewport.className = 'xterm-host'
    pane.appendChild(viewport)

    const exitBar = document.createElement('div')
    exitBar.className = 'term-exitbar'
    const exitText = document.createElement('span')
    exitText.textContent = STR.exited
    const reopenBtn = document.createElement('button')
    reopenBtn.textContent = STR.reopen
    reopenBtn.addEventListener('click', () => bridge.spawn())
    exitBar.appendChild(exitText)
    exitBar.appendChild(reopenBtn)
    pane.appendChild(exitBar)

    let term = null
    let fitAddon = null
    if (typeof Terminal === 'function' && FitAddonCtor) {
      term = new Terminal({
        fontFamily: '"Cascadia Mono", Consolas, "Microsoft YaHei UI Mono", monospace',
        fontSize: 13,
        lineHeight: 1.25,
        cursorBlink: true,
        scrollback: 2000,
        allowProposedApi: true,
        theme: THEMES[currentDark ? 'dark' : 'light'],
      })
      fitAddon = new FitAddonCtor()
      term.loadAddon(fitAddon)
      if (ClipboardAddonCtor) term.loadAddon(new ClipboardAddonCtor())
      term.open(viewport)
      term.onData((data) => bridge.sendInput(sessionId, data))
    }

    entry = { sessionId, term, fitAddon, pane, exitBar, reopenBtn, exited: false }
    panes.set(sessionId, entry)
    return entry
  }

  function removePane(sessionId) {
    const entry = panes.get(sessionId)
    if (!entry) return
    if (entry.term) {
      try { entry.term.dispose() } catch {}
    }
    entry.pane.remove()
    panes.delete(sessionId)
  }

  /** 激活会话：显示对应 pane，其余隐藏；激活侧的 xterm 重新 fit。 */
  function activatePane(sessionId) {
    activeSessionId = sessionId
    for (const [id, entry] of panes) {
      entry.pane.classList.toggle('active', id === sessionId)
    }
    const entry = panes.get(sessionId)
    if (entry && entry.term && entry.fitAddon) {
      scheduleFitPane(entry)
      entry.term.focus()
    }
    renderSessionsList(sessionId)
  }

  function fitPane(entry) {
    if (!entry || !entry.term || !entry.fitAddon) return
    if (entry.pane.classList.contains('active')) {
      try { entry.fitAddon.fit() } catch {}
      bridge.resize(entry.sessionId, entry.term.cols, entry.term.rows)
    }
  }

  const fitTimers = new Map()
  function scheduleFitPane(entry) {
    clearTimeout(fitTimers.get(entry.sessionId))
    fitTimers.set(entry.sessionId, setTimeout(() => fitPane(entry), 100))
  }

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      if (resizingPanel) return // 拖动期间 xterm 重排挂起，pointerup 后统一 fit
      const entry = panes.get(activeSessionId)
      if (entry) scheduleFitPane(entry)
    }).observe(stage)
  }
  window.addEventListener('resize', () => {
    if (resizingPanel) return
    const entry = panes.get(activeSessionId)
    if (entry) scheduleFitPane(entry)
  })

  // ── 管理区列表 ──────────────────────────────────────────────────────────────

  // 编辑态会话 id：以状态驱动渲染（双击与列表重建存在 DOM 竞态——click 会触发
  // activatePane 重建列表使旧 nameEl 脱离文档，编辑框必须由渲染器生成）
  let editingSessionId = null

  function renderSessionsList(activeId) {
    sessionsEl.querySelectorAll('.session-item').forEach((item) => item.remove())
    const items = Array.from(panes.values())
    if (items.length === 0) {
      sessionsEmpty.style.display = 'block'
      sessionsEmpty.textContent = STR.emptySessions
      return
    }
    sessionsEmpty.style.display = 'none'
    for (const entry of items) {
      const item = document.createElement('div')
      item.className = 'session-item'
      item.dataset.sessionId = entry.sessionId
      if (entry.sessionId === activeId) item.classList.add('active')
      if (entry.exited) item.classList.add('exited')

      const sdot = document.createElement('span')
      sdot.className = 'sdot'
      if (entry.exited) sdot.classList.add('exited')

      const nameEl = document.createElement('span')
      nameEl.className = 'sname'
      nameEl.title = STR.renameHint
      nameEl.textContent = sessionNames.get(entry.sessionId) || STR.title

      const closeBtnEl = document.createElement('button')
      closeBtnEl.className = 'sclose'
      closeBtnEl.title = STR.closeSession
      // 垃圾桶图标：与 resources/lajitong.svg（bootstrap-icons bi-trash）同款路径，
      // 填充式矢量（fill: currentColor），与绘制式描边图标不同，放大后依然清晰
      closeBtnEl.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5m3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0z"/><path d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4zM2.5 3h11V2h-11z"/></svg>'
      closeBtnEl.addEventListener('click', (event) => {
        event.stopPropagation()
        // 有意关闭：立即从 UI 移除（不等 exit 事件），再请求主进程结束会话
        if (editingSessionId === entry.sessionId) editingSessionId = null
        removePane(entry.sessionId)
        renderSessionsList(activeSessionId)
        bridge.kill(entry.sessionId)
      })

      item.appendChild(sdot)
      item.appendChild(nameEl)
      item.appendChild(closeBtnEl)

      item.addEventListener('click', () => {
        if (entry.exited || editingSessionId) return
        activatePane(entry.sessionId)
        bridge.activate(entry.sessionId)
      })
      nameEl.addEventListener('dblclick', (event) => {
        event.stopPropagation()
        if (entry.exited) return
        editingSessionId = entry.sessionId
        renderSessionsList(entry.sessionId)
      })

      sessionsEl.appendChild(item)

      // 编辑态：渲染输入框（状态驱动，避免与重建竞态）
      if (editingSessionId === entry.sessionId) {
        const input = document.createElement('input')
        input.className = 'sname-input'
        input.value = sessionNames.get(entry.sessionId) || STR.title
        item.replaceChild(input, nameEl)
        input.focus()
        input.select()
        let settled = false
        const finish = (commit) => {
          if (settled) return
          settled = true
          const name = commit ? input.value.trim().slice(0, 32) : ''
          if (commit && name && name !== sessionNames.get(entry.sessionId)) {
            sessionNames.set(entry.sessionId, name)
            bridge.rename(entry.sessionId, name)
          }
          editingSessionId = null
          renderSessionsList(activeSessionId)
        }
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') finish(true)
          else if (event.key === 'Escape') finish(false)
        })
        input.addEventListener('blur', () => finish(true))
      }
    }
  }

  // ── 状态与文案 ──────────────────────────────────────────────────────────────

  function setStatus(text, mode) {
    statusEl.textContent = text
    dot.dataset.mode = mode || 'idle'
  }

  function applyStrings(strings) {
    if (strings && typeof strings === 'object') {
      STR = { ...DEFAULT_STRINGS, ...strings }
    }
    titleEl.textContent = STR.title
    closeBtn.title = STR.close
    dockBottomBtn.title = STR.dockBottom
    dockRightBtn.title = STR.dockRight
    newBtn.title = STR.newSession
  }

  // ── 主进程事件 ──────────────────────────────────────────────────────────────

  bridge.on('terminal:appearance', ({ dark, strings }) => {
    currentDark = dark === true
    document.body.dataset.theme = currentDark ? 'dark' : 'light'
    document.documentElement.style.setProperty('--term-bg', THEMES[currentDark ? 'dark' : 'light'].background)
    for (const entry of panes.values()) {
      if (entry.term) entry.term.options.theme = THEMES[currentDark ? 'dark' : 'light']
    }
    if (strings) applyStrings(strings)
  })
  bridge.on('terminal:host-state', ({ state, message }) => {
    if (state === 'installing') {
      setStatus(STR.installing, 'busy')
    } else if (state === 'down') {
      setStatus(message || STR.hostFailed, 'error')
    } else if (state === 'ready' && panes.size === 0) {
      setStatus(STR.startingSession, 'busy')
    }
  })
  bridge.on('terminal:spawned', ({ sessionId, shell }) => {
    createPane(sessionId)
    const entry = panes.get(sessionId)
    if (entry) entry.exited = false
    activatePane(sessionId)
    setStatus(STR.connected.replace('{shell}', shell), 'ready')
  })
  bridge.on('terminal:data', ({ sessionId, data }) => {
    const entry = panes.get(sessionId)
    if (entry && entry.term) entry.term.write(data)
  })
  bridge.on('terminal:sessions', ({ activeSessionId: broadcastActive, sessions }) => {
    for (const session of sessions) {
      sessionNames.set(session.sessionId, session.name)
      // 兜底：广播里有而页面缺失的会话（异常情形）补建 pane
      if (!panes.has(session.sessionId)) createPane(session.sessionId)
    }
    // 不在广播里的 pane：仅当「自然退出」时保留（exited 态由 exit 事件标记）；
    // 有意关闭由页面在点击 × 时主动移除，广播不再负责移除。
    if (broadcastActive && panes.has(broadcastActive)) {
      activatePane(broadcastActive)
    } else if (panes.size > 0) {
      // 优先保持现有激活显示（含退出态 pane），无则退回第一个存活会话
      const keep = activeSessionId && panes.has(activeSessionId) ? activeSessionId : null
      const firstAlive = keep ? null : Array.from(panes.values()).find((p) => !p.exited)
      activatePane(keep ?? (firstAlive ? firstAlive.sessionId : null))
    } else {
      renderSessionsList(null)
    }
  })
  bridge.on('terminal:host-state', ({ state }) => {
    if (state === 'down') {
      // 宿主崩溃：全部会话失效，清空 pane 与名称
      for (const sessionId of Array.from(panes.keys())) removePane(sessionId)
      sessionNames.clear()
      renderSessionsList(null)
    }
  })
  bridge.on('terminal:exit', ({ sessionId }) => {
    const entry = panes.get(sessionId)
    if (!entry) return
    entry.exited = true
    entry.pane.classList.add('exited')
    if (entry.sessionId === activeSessionId) {
      setStatus(STR.exited, 'error')
    }
    renderSessionsList(activeSessionId)
  })
  bridge.on('terminal:error', ({ message }) => {
    setStatus(message || STR.hostFailed, 'error')
  })
  bridge.on('terminal:focus', () => {
    const entry = panes.get(activeSessionId)
    if (entry && entry.term) {
      scheduleFitPane(entry)
      entry.term.focus()
    }
  })
  bridge.on('terminal:dock-state', ({ mode }) => {
    const right = mode === 'right'
    document.body.dataset.dock = right ? 'right' : 'bottom'
    dockBottomBtn.classList.toggle('active', !right)
    dockRightBtn.classList.toggle('active', right)
    // 停靠切换后尺寸立即适配（ResizeObserver 有 100ms 防抖，不足以消除切换瞬间的裁切闪现）
    const entry = panes.get(activeSessionId)
    if (entry) fitPane(entry)
  })

  // ── 拖动调整 ────────────────────────────────────────────────────────────────

  const resizeH = document.getElementById('resizeH')
  const resizeV = document.getElementById('resizeV')
  const split = document.getElementById('split')

  // 面板尺寸拖动（resizeH/resizeV）：相对增量上报，主进程按停靠模式应用。
  // 拖动计算必须用 screenX/screenY（屏幕绝对坐标）而非 clientX/clientY：
  // 拖动条在面板边缘，边缘跟随光标移动，面板坐标系原点随之平移，clientX
  // 增量会被「吃掉」（实测光标走 1cm 边界只走约 0.5cm 且来回抖动）；
  // 屏幕坐标与面板位置无关，增量恒等于光标实际位移。setPointerCapture
  // 保证光标短暂离开拖动条/面板视图时事件流不中断。
  let panelResizeDrag = null // { lastX, lastY }
  const startPanelResize = (event) => {
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch {}
    panelResizeDrag = { lastX: event.screenX, lastY: event.screenY }
    resizingPanel = true
    event.preventDefault()
    document.addEventListener('pointermove', onPanelResizeMove)
    document.addEventListener('pointerup', endPanelResize, { once: true })
    document.addEventListener('pointercancel', endPanelResize, { once: true })
  }
  const onPanelResizeMove = (event) => {
    if (!panelResizeDrag) return
    const dx = event.screenX - panelResizeDrag.lastX
    const dy = event.screenY - panelResizeDrag.lastY
    panelResizeDrag.lastX = event.screenX
    panelResizeDrag.lastY = event.screenY
    if (dx !== 0 || dy !== 0) bridge.panelResize({ dx, dy })
  }
  const endPanelResize = () => {
    panelResizeDrag = null
    resizingPanel = false
    document.removeEventListener('pointermove', onPanelResizeMove)
    // 拖动结束：几何已定格（最后的 setBounds 由主进程完成并触发一次 observer），
    // 补一次 fit/PTY resize（拖动期间被挂起）
    const entry = panes.get(activeSessionId)
    if (entry) scheduleFitPane(entry)
  }
  resizeH.addEventListener('pointerdown', startPanelResize)
  resizeV.addEventListener('pointerdown', startPanelResize)

  // 管理区宽度拖动（页面本地，120–340px）：同步应用到 DOM，天然跟手；
  // 同样加 pointer capture，光标滑出窄条时不中断（用 clientX 无碍——
  // 面板视口原点不随管理区宽度变化）
  let splitDrag = null // { startWidth, startX }
  split.addEventListener('pointerdown', (event) => {
    try { split.setPointerCapture(event.pointerId) } catch {}
    splitDrag = { startWidth: sessionsEl.getBoundingClientRect().width, startX: event.clientX }
    event.preventDefault()
    document.addEventListener('pointermove', onSplitMove)
    document.addEventListener('pointerup', endSplit, { once: true })
    document.addEventListener('pointercancel', endSplit, { once: true })
  })
  const onSplitMove = (event) => {
    if (!splitDrag) return
    const width = Math.min(Math.max(splitDrag.startWidth - (event.clientX - splitDrag.startX), 120), 340)
    sessionsEl.style.width = `${width}px`
  }
  const endSplit = () => {
    splitDrag = null
    document.removeEventListener('pointermove', onSplitMove)
  }

  // ── 本地交互 ────────────────────────────────────────────────────────────────

  newBtn.addEventListener('click', () => bridge.spawn())
  dockBottomBtn.addEventListener('click', () => bridge.setDock('bottom'))
  dockRightBtn.addEventListener('click', () => bridge.setDock('right'))
  closeBtn.addEventListener('click', () => bridge.togglePanel())

  // 集成冒烟用：从激活会话的 xterm 缓冲区取纯文本（与渲染器无关）
  window.__getTermText = () => {
    const entry = panes.get(activeSessionId)
    if (!entry || !entry.term) return ''
    let text = ''
    for (let i = 0; i < entry.term.buffer.active.length; i++) {
      const line = entry.term.buffer.active.getLine(i)
      if (line) text += line.translateToString(true) + '\n'
    }
    return text
  }
  // 集成冒烟用：当前激活会话 id / pane 数量 / 激活态是否退出
  window.__getTermState = () => ({
    active: activeSessionId,
    panes: Array.from(panes.keys()),
    exited: Array.from(panes.values()).find((p) => p.sessionId === activeSessionId)?.exited === true,
  })
  // 诊断用：xterm 尺寸与可视区几何（定位「执行命令后新行不可见」类问题）
  window.__getTermDiagnostics = () => {
    const entry = panes.get(activeSessionId)
    if (!entry || !entry.term) return null
    const term = entry.term
    const buf = term.buffer.active
    const paneRect = entry.pane.getBoundingClientRect()
    const xtermEl = entry.pane.querySelector('.xterm')
    const screenEl = entry.pane.querySelector('.xterm-screen')
    const viewportEl = entry.pane.querySelector('.xterm-viewport')
    const rectOf = (el) => el ? { w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) } : null
    return {
      cols: term.cols,
      rows: term.rows,
      bufferLength: buf.length,
      baseY: buf.baseY,
      viewportY: buf.viewportY,
      cursorY: buf.cursorY,
      cursorX: buf.cursorX,
      pane: rectOf(entry.pane),
      xterm: rectOf(xtermEl),
      screen: rectOf(screenEl),
      viewport: viewportEl
        ? {
            ...rectOf(viewportEl),
            clientH: viewportEl.clientHeight,
            scrollH: viewportEl.scrollHeight,
            scrollTop: Math.round(viewportEl.scrollTop),
          }
        : null,
      stageH: Math.round(stage.getBoundingClientRect().height),
    }
  }

  setStatus(STR.connecting, 'busy')
  bridge.ready()
  window.__readySent = true // 供集成冒烟确认发送侧已执行
})()
