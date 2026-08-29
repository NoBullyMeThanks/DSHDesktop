'use strict'
/**
 * DSH 内容页的内部观测器：读取页面最终计算出的主题色和侧栏宽度，
 * 通过单向 IPC 上报给主进程。不会向 DSH 页面暴露任何 Electron API。
 */
const { ipcRenderer } = require('electron')

let frame = null
let sidebar = null
let resizeObserver = null
let dragRow = null
let headerRow = null
let scheduled = false
let dialogHost = null
let dialogRoot = null
let activeDialogState = null
let dialogPreviousFocus = null
let dialogActionPending = false
let windowControlsHost = null
let windowControlsRoot = null

const DIALOG_MODES = new Set(['loading', 'progress', 'info', 'confirm', 'error'])
const MIN_DIALOG_TEXT_CONTRAST = 4.5
const DARK_DIALOG_LABEL = Object.freeze({ red: 23, green: 23, blue: 23, alpha: 1 })
const LIGHT_DIALOG_LABEL = Object.freeze({ red: 255, green: 255, blue: 255, alpha: 1 })

/** 窗口按钮行高度（windowControls 的 .controls）。 */
const WINDOW_CONTROL_BAR_HEIGHT = 28
/** DSH 会话区 header 的顶部内边距（头部按钮条距窗口顶的既有距离）。 */
const SESSION_HEADER_TOP_PADDING = 12
/**
 * 顶部边框条带高度：DSH 内容整体下移该距离，使窗口按钮行底部与会话区头部
 * 按钮（Session log 等）上边框恰好留 1px 间隙（28 + 1 − 12 = 17）。
 * 条带是窗口拖动区；下移保证窗口按钮不遮挡会话区头部的按钮。
 */
const TOP_BORDER_INSET_PX = WINDOW_CONTROL_BAR_HEIGHT + 1 - SESSION_HEADER_TOP_PADDING

function ensureDialogUi() {
  if (dialogRoot || !document.body) return

  dialogHost = document.createElement('div')
  dialogHost.id = 'dshdesktop-dialog-host'
  Object.assign(dialogHost.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483647',
    display: 'none',
    webkitAppRegion: 'no-drag',
  })
  dialogRoot = dialogHost.attachShadow({ mode: 'closed' })
  dialogRoot.innerHTML = `
    <style>
      :host {
        all: initial;
        --dshdesktop-secondary-label: var(--dsw-alias-label-primary, #171717);
        --dshdesktop-primary-label: var(--dsw-alias-button-primary-label, #ffffff);
        --dshdesktop-danger-label: var(--dsw-alias-label-error, #d64545);
        color: var(--dsw-alias-label-primary, #171717);
        font-family: var(--dsw-font-family, "Segoe UI Variable", "Segoe UI", "Microsoft YaHei UI", sans-serif);
      }
      * { box-sizing: border-box; }
      .backdrop {
        position: fixed;
        inset: 0;
        display: grid;
        padding: 24px;
        place-items: center;
        background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.36));
        backdrop-filter: blur(var(--dsw-mask-blur, 4px));
        -webkit-backdrop-filter: blur(var(--dsw-mask-blur, 4px));
        -webkit-app-region: no-drag;
      }
      .dialog {
        position: relative;
        width: min(420px, calc(100vw - 48px));
        max-height: calc(100vh - 48px);
        padding: 24px;
        overflow: auto;
        color: var(--dsw-alias-label-primary, #171717);
        background: var(--dsw-alias-bg-layer-2, #ffffff);
        border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.06));
        border-radius: 24px;
        box-shadow: var(--dsw-shadow-lv3, 0 20px 48px rgba(0, 0, 0, 0.20));
        outline: none;
        transform-origin: center;
        animation: enter 150ms ease-out;
      }
      .head {
        display: flex;
        min-height: 28px;
        align-items: flex-start;
        gap: 12px;
      }
      .indicator {
        position: relative;
        width: 24px;
        height: 24px;
        flex: 0 0 auto;
        color: var(--dsw-alias-label-secondary, #626873);
        border-radius: 50%;
      }
      .indicator[data-mode='loading'],
      .indicator[data-mode='progress'] {
        border: 2px solid color-mix(in srgb, var(--dsw-alias-label-primary, #4d6bfe) 18%, transparent);
        border-top-color: var(--dsw-alias-button-primary-fill, #4d6bfe);
        animation: spin 0.75s linear infinite;
      }
      .indicator[data-mode='info']::before,
      .indicator[data-mode='error']::before,
      .indicator[data-mode='confirm']::before {
        display: grid;
        width: 24px;
        height: 24px;
        place-items: center;
        font-size: 14px;
        font-weight: 700;
        border: 1px solid currentColor;
        border-radius: 50%;
      }
      .indicator[data-mode='info']::before { content: 'i'; }
      .indicator[data-mode='confirm']::before { content: '?'; }
      .indicator[data-mode='error'] {
        color: var(--dsw-alias-label-error, #d64545);
      }
      .indicator[data-mode='error']::before { content: '!'; }
      h2 {
        flex: 1;
        margin: 0;
        font-size: 18px;
        font-weight: 650;
        line-height: 26px;
      }
      .close {
        width: 28px;
        height: 28px;
        margin: -3px -4px 0 0;
        padding: 0;
        color: var(--dsw-alias-label-secondary, #626873);
        background: transparent;
        border: 0;
        border-radius: 8px;
        font-size: 20px;
        line-height: 28px;
        cursor: pointer;
      }
      .close:hover {
        color: var(--dsw-alias-label-primary, #171717);
        background: var(--dsw-alias-bg-hover, rgba(0, 0, 0, 0.06));
      }
      .message {
        margin: 14px 0 0 36px;
        color: var(--dsw-alias-label-secondary, #626873);
        font-size: 14px;
        line-height: 22px;
        white-space: pre-wrap;
      }
      .detail {
        max-height: 144px;
        margin: 14px 0 0 36px;
        padding: 10px 12px;
        overflow: auto;
        color: var(--dsw-alias-label-tertiary, #777d87);
        background: var(--dsw-alias-bg-layer-1, rgba(0, 0, 0, 0.035));
        border-radius: 10px;
        font: 12px/18px Consolas, "Cascadia Mono", monospace;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .actions {
        display: flex;
        min-height: 36px;
        margin-top: 22px;
        justify-content: flex-end;
        gap: 8px;
      }
      button {
        min-width: 80px;
        height: 36px;
        padding: 0 16px;
        color: var(--dshdesktop-secondary-label);
        background: var(--dsw-alias-button-secondary-fill, rgba(0, 0, 0, 0.055));
        border: 1px solid var(--dsw-alias-border-l1, transparent);
        border-radius: 10px;
        font: inherit;
        font-size: 13px;
        cursor: pointer;
      }
      button:hover:not(:disabled) {
        background: var(--dsw-alias-button-secondary-fill-hover, rgba(0, 0, 0, 0.09));
      }
      button[data-kind='primary'] {
        color: var(--dshdesktop-primary-label);
        background: var(--dsw-alias-button-primary-fill, #4d6bfe);
        border-color: transparent;
      }
      button[data-kind='primary']:hover:not(:disabled) {
        background: var(--dsw-alias-button-primary-fill-hover, #405de5);
      }
      button[data-kind='danger'] {
        color: var(--dshdesktop-danger-label);
        border-color: color-mix(in srgb, var(--dsw-alias-label-error, #d64545) 55%, transparent);
      }
      button:disabled { opacity: 0.55; cursor: default; }
      // 键盘焦点指示只画在可交互按钮上；容器卡片（.dialog）承担焦点锁定时
      // 不显示描边，避免整张小窗边缘出现蓝色 outline。
      button:focus-visible {
        outline: 2px solid var(--dsw-alias-border-focus, #4d6bfe);
        outline-offset: 2px;
      }
      [hidden] { display: none !important; }
      @keyframes spin { to { transform: rotate(360deg); } }
      @keyframes enter {
        from { opacity: 0; transform: scale(0.98) translateY(4px); }
      }
      @media (prefers-reduced-motion: reduce) {
        .dialog { animation: none; }
        .indicator[data-mode='loading'],
        .indicator[data-mode='progress'] { animation-duration: 1.5s; }
      }
      .color-probes {
        position: fixed;
        width: 1px;
        height: 1px;
        overflow: hidden;
        pointer-events: none;
        visibility: hidden;
      }
      .color-probes > span { display: block; }
      [data-color-probe='surface'] { background: var(--dsw-alias-bg-layer-2, #ffffff); }
      [data-color-probe='label-primary'] { background: var(--dsw-alias-label-primary, #171717); }
      [data-color-probe='label-error'] { background: var(--dsw-alias-label-error, #d64545); }
      [data-color-probe='primary-label'] { background: var(--dsw-alias-button-primary-label, #ffffff); }
      [data-color-probe='primary-fill'] { background: var(--dsw-alias-button-primary-fill, #4d6bfe); }
      [data-color-probe='primary-fill-hover'] { background: var(--dsw-alias-button-primary-fill-hover, #405de5); }
      [data-color-probe='secondary-fill'] { background: var(--dsw-alias-button-secondary-fill, rgba(0, 0, 0, 0.055)); }
      [data-color-probe='secondary-fill-hover'] { background: var(--dsw-alias-button-secondary-fill-hover, rgba(0, 0, 0, 0.09)); }
    </style>
    <div class="backdrop">
      <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-message" tabindex="-1">
        <div class="head">
          <span class="indicator" aria-hidden="true"></span>
          <h2 id="dialog-title"></h2>
          <button class="close" type="button" aria-label="Close" hidden>×</button>
        </div>
        <p id="dialog-message" class="message"></p>
        <pre class="detail" hidden></pre>
        <div class="actions"></div>
      </section>
    </div>
    <div class="color-probes" aria-hidden="true">
      <span data-color-probe="surface"></span>
      <span data-color-probe="label-primary"></span>
      <span data-color-probe="label-error"></span>
      <span data-color-probe="primary-label"></span>
      <span data-color-probe="primary-fill"></span>
      <span data-color-probe="primary-fill-hover"></span>
      <span data-color-probe="secondary-fill"></span>
      <span data-color-probe="secondary-fill-hover"></span>
    </div>
  `
  document.body.appendChild(dialogHost)
  syncDialogButtonContrast()

  dialogRoot.querySelector('.close').addEventListener('click', () => sendDialogAction(activeDialogState?.cancelAction))
  dialogRoot.querySelector('.backdrop').addEventListener('mousedown', (event) => {
    if (event.target === event.currentTarget && activeDialogState?.cancelable) {
      sendDialogAction(activeDialogState.cancelAction)
    }
  })
}

function parseCssRgb(value) {
  if (typeof value !== 'string' || !/^rgba?\(/i.test(value.trim())) return null
  const parts = value.match(/[\d.]+%?/g)
  if (!parts || parts.length < 3) return null
  const channels = parts.slice(0, 3).map((part) => {
    const number = Number.parseFloat(part)
    return part.endsWith('%') ? number * 2.55 : number
  })
  const alphaPart = parts[3]
  const alphaNumber = alphaPart === undefined ? 1 : Number.parseFloat(alphaPart)
  const alpha = alphaPart?.endsWith('%') ? alphaNumber / 100 : alphaNumber
  if (![...channels, alpha].every(Number.isFinite)) return null
  return {
    red: Math.min(255, Math.max(0, channels[0])),
    green: Math.min(255, Math.max(0, channels[1])),
    blue: Math.min(255, Math.max(0, channels[2])),
    alpha: Math.min(1, Math.max(0, alpha)),
  }
}

function compositeCssColor(foreground, background) {
  const alpha = foreground.alpha + background.alpha * (1 - foreground.alpha)
  if (alpha === 0) return { red: 0, green: 0, blue: 0, alpha: 0 }
  const channel = (name) => (
    foreground[name] * foreground.alpha
    + background[name] * background.alpha * (1 - foreground.alpha)
  ) / alpha
  return {
    red: channel('red'),
    green: channel('green'),
    blue: channel('blue'),
    alpha,
  }
}

function relativeLuminance(color) {
  const linear = (channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(color.red) + 0.7152 * linear(color.green) + 0.0722 * linear(color.blue)
}

function contrastRatio(foreground, background) {
  const opaqueForeground = compositeCssColor(foreground, background)
  const foregroundLuminance = relativeLuminance(opaqueForeground)
  const backgroundLuminance = relativeLuminance(background)
  const lighter = Math.max(foregroundLuminance, backgroundLuminance)
  const darker = Math.min(foregroundLuminance, backgroundLuminance)
  return (lighter + 0.05) / (darker + 0.05)
}

function chooseReadableLabel(current, backgrounds) {
  if (!current || !Array.isArray(backgrounds) || backgrounds.length === 0) return current
  const candidates = [current, DARK_DIALOG_LABEL, LIGHT_DIALOG_LABEL]
  const score = (candidate) => Math.min(...backgrounds.map((background) => contrastRatio(candidate, background)))
  if (score(current) >= MIN_DIALOG_TEXT_CONTRAST) return current
  return candidates.reduce((best, candidate) => score(candidate) > score(best) ? candidate : best)
}

function formatCssRgb(color) {
  return color.alpha < 1
    ? `rgba(${Math.round(color.red)}, ${Math.round(color.green)}, ${Math.round(color.blue)}, ${color.alpha})`
    : `rgb(${Math.round(color.red)}, ${Math.round(color.green)}, ${Math.round(color.blue)})`
}

function dialogProbeColor(name) {
  const probe = dialogRoot?.querySelector(`[data-color-probe="${name}"]`)
  return probe ? parseCssRgb(getComputedStyle(probe).backgroundColor) : null
}

function setDialogLabelProperty(name, color) {
  if (!dialogHost || !color) return
  const value = formatCssRgb(color)
  if (dialogHost.style.getPropertyValue(name) !== value) dialogHost.style.setProperty(name, value)
}

function syncDialogButtonContrast() {
  if (!dialogHost || !dialogRoot) return
  const surface = dialogProbeColor('surface')
  if (!surface) return
  const background = (name) => {
    const color = dialogProbeColor(name)
    return color ? compositeCssColor(color, surface) : null
  }
  const primaryBackgrounds = ['primary-fill', 'primary-fill-hover'].map(background).filter(Boolean)
  const secondaryBackgrounds = ['secondary-fill', 'secondary-fill-hover'].map(background).filter(Boolean)
  if (primaryBackgrounds.length > 0) {
    setDialogLabelProperty(
      '--dshdesktop-primary-label',
      chooseReadableLabel(dialogProbeColor('primary-label'), primaryBackgrounds),
    )
  }
  if (secondaryBackgrounds.length > 0) {
    setDialogLabelProperty(
      '--dshdesktop-secondary-label',
      chooseReadableLabel(dialogProbeColor('label-primary'), secondaryBackgrounds),
    )
    setDialogLabelProperty(
      '--dshdesktop-danger-label',
      chooseReadableLabel(dialogProbeColor('label-error'), secondaryBackgrounds),
    )
  }
}

function isValidDialogState(state) {
  return state &&
    typeof state === 'object' &&
    typeof state.id === 'string' &&
    DIALOG_MODES.has(state.mode) &&
    typeof state.title === 'string' &&
    typeof state.message === 'string'
}

function renderDialog(state) {
  if (state?.mode === 'close') {
    if (!activeDialogState || !state.id || state.id === activeDialogState.id) closeDialog()
    return
  }
  if (!isValidDialogState(state)) return
  ensureDialogUi()

  if (!activeDialogState) dialogPreviousFocus = document.activeElement
  activeDialogState = {
    ...state,
    cancelable: Boolean(state.cancelable),
    buttons: Array.isArray(state.buttons) ? state.buttons : [],
  }
  dialogActionPending = false

  const dialog = dialogRoot.querySelector('.dialog')
  const indicator = dialogRoot.querySelector('.indicator')
  const title = dialogRoot.querySelector('h2')
  const message = dialogRoot.querySelector('.message')
  const detail = dialogRoot.querySelector('.detail')
  const close = dialogRoot.querySelector('.close')
  const actions = dialogRoot.querySelector('.actions')

  indicator.dataset.mode = state.mode
  title.textContent = state.title
  message.textContent = state.message
  detail.textContent = typeof state.detail === 'string' ? state.detail : ''
  detail.hidden = !detail.textContent
  close.hidden = !activeDialogState.cancelable
  actions.replaceChildren()

  for (const item of activeDialogState.buttons) {
    if (!item || typeof item.id !== 'string' || typeof item.label !== 'string') continue
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.action = item.id
    button.dataset.kind = ['primary', 'danger'].includes(item.kind) ? item.kind : 'secondary'
    button.textContent = item.label
    button.disabled = Boolean(item.disabled)
    button.addEventListener('click', () => sendDialogAction(item.id))
    actions.append(button)
  }

  actions.hidden = actions.childElementCount === 0
  syncDialogButtonContrast()
  dialogHost.style.display = 'block'
  requestAnimationFrame(() => {
    const defaultButton = typeof state.defaultAction === 'string'
      ? actions.querySelector(`[data-action="${CSS.escape(state.defaultAction)}"]`)
      : null
    ;(defaultButton ?? actions.querySelector('button:not(:disabled)') ?? dialog).focus()
  })
}

function sendDialogAction(action) {
  if (!activeDialogState || dialogActionPending || typeof action !== 'string') return
  dialogActionPending = true
  for (const button of dialogRoot.querySelectorAll('button')) button.disabled = true
  ipcRenderer.send('dsh:dialog-action', {
    id: activeDialogState.id,
    action,
  })
}

function closeDialog() {
  if (!dialogHost || !activeDialogState) return
  dialogHost.style.display = 'none'
  activeDialogState = null
  dialogActionPending = false
  if (dialogPreviousFocus instanceof HTMLElement && dialogPreviousFocus.isConnected) dialogPreviousFocus.focus()
  dialogPreviousFocus = null
}

function handleDialogKeydown(event) {
  if (!activeDialogState || dialogHost?.style.display === 'none') return

  if (event.key === 'Escape' && activeDialogState.cancelable) {
    event.preventDefault()
    event.stopImmediatePropagation()
    sendDialogAction(activeDialogState.cancelAction)
    return
  }

  if (event.key === 'Enter' && typeof activeDialogState.defaultAction === 'string') {
    event.preventDefault()
    event.stopImmediatePropagation()
    sendDialogAction(activeDialogState.defaultAction)
    return
  }

  if (event.key !== 'Tab') return
  // 卡片容器（tabindex=-1）仅作初始聚焦回退，不进入 Tab 循环：
  // 避免焦点循环经卡片时给整张小窗画出蓝色焦点描边
  const focusable = [...dialogRoot.querySelectorAll('button:not(:disabled)')]
    .filter((element) => !element.hidden && getComputedStyle(element).display !== 'none')
  if (focusable.length === 0) {
    // 无按钮模态（loading/progress）：拦截 Tab 防止焦点逃逸到背景，保持焦点锁定在卡片上
    event.preventDefault()
    event.stopImmediatePropagation()
    dialogRoot.querySelector('.dialog').focus()
    return
  }
  const current = dialogRoot.activeElement
  let index = focusable.indexOf(current)
  index = event.shiftKey
    ? (index <= 0 ? focusable.length - 1 : index - 1)
    : (index >= focusable.length - 1 ? 0 : index + 1)
  event.preventDefault()
  event.stopImmediatePropagation()
  focusable[index].focus()
}

ipcRenderer.on('dsh:dialog-state', (_event, state) => renderDialog(state))
window.addEventListener('keydown', handleDialogKeydown, true)

function ensureWindowControls() {
  if (windowControlsRoot || !document.body) return

  windowControlsHost = document.createElement('div')
  windowControlsHost.id = 'dshdesktop-window-controls-host'
  Object.assign(windowControlsHost.style, {
    position: 'fixed',
    top: '0',
    right: '0',
    zIndex: '2147483646',
    pointerEvents: 'none',
    webkitAppRegion: 'no-drag',
  })
  windowControlsRoot = windowControlsHost.attachShadow({ mode: 'closed' })
  windowControlsRoot.innerHTML = `
    <style>
      :host {
        all: initial;
        color: var(--dsw-alias-label-primary, #171717);
        font-family: var(--dsw-font-family, "Segoe UI Variable", "Segoe UI", sans-serif);
      }
      * { box-sizing: border-box; }
      .controls {
        display: flex;
        width: 112px;
        height: ${WINDOW_CONTROL_BAR_HEIGHT}px;
        pointer-events: auto;
        -webkit-app-region: no-drag;
      }
      button {
        width: ${WINDOW_CONTROL_BAR_HEIGHT}px;
        height: ${WINDOW_CONTROL_BAR_HEIGHT}px;
        display: grid;
        padding: 0;
        place-items: center;
        color: inherit;
        background: transparent;
        border: 0;
        border-radius: 0;
        outline: none;
      }
      button:hover {
        background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.14));
      }
      button:focus-visible {
        box-shadow: inset 0 0 0 2px var(--dsw-alias-state-business-primary, #4d6bfe);
      }
      button[data-action="close"]:hover,
      button[data-action="close"]:focus-visible {
        color: #ffffff;
        background: #c42b1c;
      }
      svg {
        width: 11px;
        height: 11px;
        overflow: visible;
        fill: none;
        stroke: currentColor;
        stroke-linecap: square;
        stroke-width: 1;
        vector-effect: non-scaling-stroke;
      }
      .restore { display: none; }
      .controls[data-maximized="true"] .maximize { display: none; }
      .controls[data-maximized="true"] .restore { display: block; }
      .controls[data-terminal-open="true"] button[data-action="terminal"] {
        color: var(--dsw-alias-state-business-primary, #4d6bfe);
      }
      @media (prefers-reduced-motion: reduce) {
        button { transition: none; }
      }
    </style>
    <div class="controls" data-maximized="false" data-terminal-open="false">
      <button type="button" data-action="terminal">
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 3.5l3 2.5-3 2.5M6.5 8.5h3" /></svg>
      </button>
      <button type="button" data-action="minimize">
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 8.5h8" /></svg>
      </button>
      <button type="button" data-action="toggle-maximize">
        <svg class="maximize" viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="2" width="8" height="8" /></svg>
        <svg class="restore" viewBox="0 0 12 12" aria-hidden="true"><path d="M4 3V2h6v6H9M2 4h6v6H2z" /></svg>
      </button>
      <button type="button" data-action="close">
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5l7 7m0-7l-7 7" /></svg>
      </button>
    </div>
  `
  document.body.appendChild(windowControlsHost)

  windowControlsRoot.querySelector('.controls').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]')
    if (!button) return
    ipcRenderer.send('dsh:window-control', button.dataset.action)
  })
}

function renderWindowControlsState(state) {
  if (!state || typeof state !== 'object') return
  ensureWindowControls()
  if (!windowControlsRoot) return
  const controls = windowControlsRoot.querySelector('.controls')
  controls.dataset.maximized = state.maximized === true ? 'true' : 'false'
  controls.dataset.terminalOpen = state.terminalOpen === true ? 'true' : 'false'

  const labels = state.labels && typeof state.labels === 'object' ? state.labels : {}
  const labelByAction = {
    terminal: labels.terminal,
    minimize: labels.minimize,
    'toggle-maximize': state.maximized === true ? labels.restore : labels.maximize,
    close: labels.close,
  }
  for (const [action, label] of Object.entries(labelByAction)) {
    if (typeof label !== 'string' || !label) continue
    const button = windowControlsRoot.querySelector(`button[data-action="${action}"]`)
    button.setAttribute('aria-label', label)
    button.title = label
  }
}

ipcRenderer.on('dsh:window-controls-state', (_event, state) => renderWindowControlsState(state))

function ensureDragStyle() {
  if (document.getElementById('dshdesktop-window-drag-style')) return
  const style = document.createElement('style')
  style.id = 'dshdesktop-window-drag-style'
  style.textContent = `
    [data-dshdesktop-drag-region] {
      -webkit-app-region: drag !important;
    }
    /* 只对未标记的子元素降为 no-drag：嵌套的拖动区（列根 + 顶部行）互不覆盖，
       否则外层标记的 no-drag 会以同权重后置规则压掉内层标记的拖动态。 */
    [data-dshdesktop-drag-region] *:not([data-dshdesktop-drag-region]) {
      -webkit-app-region: no-drag !important;
    }
  `
  document.head.appendChild(style)
}

/** 侧栏根容器（SidebarRoot 本体，slot 包装层之上）。 */
function findSidebarRoot() {
  if (!sidebar?.isConnected) return null
  // DSH 的 slot 渲染器会在侧栏列与 SidebarRoot 之间插入 display: contents 包装层。
  const slot = sidebar.querySelector(':scope > [data-slot="sidebar"]')
  const sidebarRoot = slot?.firstElementChild
  return sidebarRoot instanceof HTMLElement ? sidebarRoot : null
}

function findLogoRow() {
  const sidebarRoot = findSidebarRoot()
  const candidate = sidebarRoot?.firstElementChild
  if (!(candidate instanceof HTMLElement)) return null

  const sidebarRect = sidebar.getBoundingClientRect()
  const candidateRect = candidate.getBoundingClientRect()
  const topOffset = candidateRect.top - sidebarRect.top
  const insideSidebar = candidateRect.left >= sidebarRect.left - 1
    && candidateRect.right <= sidebarRect.right + 1
  const isTopRow = topOffset >= -1 && topOffset <= 34
  const hasSafeSize = candidateRect.width > 0
    && candidateRect.height > 0
    && candidateRect.height <= 80
  return insideSidebar && isTopRow && hasSafeSize ? candidate : null
}

/** 交换拖动区标记；标记自身为拖动区，其未标记子元素由样式规则降为 no-drag。 */
function swapDragMark(prev, next) {
  if (prev === next) return next
  if (prev) prev.removeAttribute('data-dshdesktop-drag-region')
  if (next) next.setAttribute('data-dshdesktop-drag-region', '')
  return next
}

const topInsetApplied = new WeakSet()

/**
 * 给容器内容下移 TOP_BORDER_INSET_PX（幂等，每元素只加一次）。
 * 在「列根」上下移而不是整体推 frame：列的背景从窗口顶一直铺到内容，
 * 顶部条带与下方同色，不会出现一条异色横带；内容不越界需 border-box。
 */
function applyTopInset(element) {
  if (!(element instanceof HTMLElement)) return
  if (topInsetApplied.has(element)) return
  const computed = getComputedStyle(element)
  const current = parseFloat(computed.paddingTop)
  if (!Number.isFinite(current)) return
  element.style.boxSizing = 'border-box'
  element.style.paddingTop = `${Math.round(current + TOP_BORDER_INSET_PX)}px`
  topInsetApplied.add(element)
}

let dragStripHost = null

/** 顶部边框拖动条带：独立注入的固定透明层，覆盖 0..TOP_BORDER_INSET_PX。 */
const DRAG_STRIP_Z_INDEX = 30

/**
 * 创建顶部边框拖动条带。不依赖 DSH 页面的任何类名/结构：fixed 定位、透明、
 * 位于页面之上（但在窗口按钮层之下的 z30），整条可拖动窗口。
 * 条带高度与内容下移量一致（TOP_BORDER_INSET_PX），恰好止于会话区头部按钮上方。
 */
function ensureDragStrip() {
  if (dragStripHost || !document.body) return
  dragStripHost = document.createElement('div')
  dragStripHost.id = 'dshdesktop-window-drag-strip'
  Object.assign(dragStripHost.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    right: '0',
    height: `${TOP_BORDER_INSET_PX}px`,
    zIndex: `${DRAG_STRIP_Z_INDEX}`,
    pointerEvents: 'auto',
    background: 'transparent',
    webkitAppRegion: 'drag',
  })
  document.body.appendChild(dragStripHost)
}

/**
 * 顶部条带内容下移：给侧栏根与会话列根加 TOP_BORDER_INSET_PX 顶部内边距
 * （幂等）。在「列根」上下移而不是整体推 frame：列的背景从窗口顶一直铺到
 * 内容，顶部条带与下方同色；会话区头部按钮随之下移，与窗口按钮行留出间隙。
 */
function applyColumnInsets() {
  applyTopInset(findSidebarRoot())
  applyTopInset(findConversationRoot())
}

function updateDragRegion() {
  applyColumnInsets()
  // 顶部行的自有 padding 区域并入拖动区（按钮保持可点）；
  // 顶部边框整条条带由 ensureDragStrip 注入的固定透明层负责。
  dragRow = swapDragMark(dragRow, findLogoRow())
  headerRow = swapDragMark(headerRow, findConversationHeader())
}

function findFrame() {
  const root = document.getElementById('root')
  if (!root) return null
  const candidates = [root, ...root.querySelectorAll('div')]
  return candidates.find((element) => {
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return style.display === 'grid'
      && style.gridTemplateColumns.split(/\s+/).length >= 2
      && rect.width >= window.innerWidth * 0.8
      && rect.height >= window.innerHeight * 0.8
  }) ?? null
}

/** 会话区（frame 的第 2 个轨道列）：侧栏右缘起、宽度最大的内容列。 */
function findCenterColumn() {
  if (!frame || !frame.isConnected) return null
  const frameRect = frame.getBoundingClientRect()
  const sidebarRect = sidebar ? sidebar.getBoundingClientRect() : { right: 0 }
  for (const child of frame.children) {
    const rect = child.getBoundingClientRect()
    if (rect.left >= sidebarRect.right - 8 && rect.width > 300 && rect.height >= frameRect.height * 0.8) {
      return child
    }
  }
  return null
}

/**
 * 会话区顶部标题行（含 crumb、header actions 与 Session log 等按钮的 header）。
 * 用语义 <header> + 几何约束定位：位于顶部条带内、宽度覆盖会话区、高度合理；
 * 滚动体内的 Question/Trajectory 等 header 不满足条带约束，天然排除。
 */
function findConversationHeader() {
  if (!frame || !frame.isConnected) return null
  const centerCol = findCenterColumn()
  if (!centerCol) return null
  const frameRect = frame.getBoundingClientRect()
  const columnRect = centerCol.getBoundingClientRect()
  for (const candidate of centerCol.querySelectorAll('header')) {
    if (!(candidate instanceof HTMLElement)) continue
    const rect = candidate.getBoundingClientRect()
    if (rect.width < columnRect.width * 0.6) continue
    const topOffset = rect.top - frameRect.top
    if (topOffset < -1 || topOffset > TOP_BORDER_INSET_PX + 40) continue
    if (rect.height < 20 || rect.height > 140) continue
    return candidate
  }
  return null
}

/**
 * 会话列布局根（ConversationRoot 的 flex 列容器）：中心列内第一个
 * display:flex + flex-direction:column、覆盖绝大部分列面积的容器。
 * 空会话/hero 阶段它同样在树中（仅内部 header 隐藏），因此顶部条带始终存在。
 */
function findConversationRoot() {
  if (!frame || !frame.isConnected) return null
  const centerCol = findCenterColumn()
  if (!centerCol) return null
  const colRect = centerCol.getBoundingClientRect()
  for (const candidate of centerCol.querySelectorAll('div')) {
    const style = getComputedStyle(candidate)
    if (style.display !== 'flex' || style.flexDirection !== 'column') continue
    const rect = candidate.getBoundingClientRect()
    if (rect.width >= colRect.width * 0.6 && rect.height >= colRect.height * 0.6) {
      return candidate
    }
  }
  return null
}

function observeLayout(nextFrame) {
  const nextSidebar = nextFrame?.firstElementChild ?? null
  if (nextFrame === frame && nextSidebar === sidebar) return
  frame = nextFrame
  sidebar = nextSidebar
  if (resizeObserver) resizeObserver.disconnect()
  resizeObserver = new ResizeObserver(scheduleLayoutUpdate)
  if (frame) resizeObserver.observe(frame)
  if (sidebar) resizeObserver.observe(sidebar)
  applyPanelInset()
  updateDragRegion()
}

// ── 布局几何上报（终端面板贴齐会话区域用） ────────────────────────────────────

let lastLayoutReport = null

/**
 * 会话区标题区域底边线：优先用会话区 <header> 元素（findConversationHeader）
 * 的底边（精确对齐用户视角的「标题区域线条」）；header 隐藏/空会话时用
 * 滚动体 top 兜底，再不行回退 0（右侧面板走窗口按钮区下限）。
 * 右侧停靠面板据此使面板顶边与该线共线。
 */
function measureHeaderBottom() {
  const headerEl = findConversationHeader()
  if (headerEl && headerEl.isConnected) {
    const bottom = headerEl.getBoundingClientRect().bottom
    if (Number.isFinite(bottom) && bottom > 0) return Math.round(bottom)
  }
  const scroller = (scrollBody && scrollBody.isConnected) ? scrollBody : findSessionScrollBody()
  if (!scroller) return 0
  const top = scroller.getBoundingClientRect().top
  return Number.isFinite(top) && top > 0 ? Math.round(top) : 0
}

/**
 * 上报侧栏右缘与会话区右缘（只报校验过的整数，变化才发）。
 * 终端面板据此把 bounds 限定在会话区域：侧栏收缩/展开时自动跟随。
 */
function reportContentLayout() {
  if (!frame || !frame.isConnected || !sidebar || !sidebar.isConnected) return
  const frameRect = frame.getBoundingClientRect()
  const sidebarRect = sidebar.getBoundingClientRect()
  const payload = {
    sidebarRight: Math.round(sidebarRect.right),
    contentRight: Math.round(frameRect.right),
    headerBottom: measureHeaderBottom(),
  }
  if (!Number.isFinite(payload.sidebarRight) || !Number.isFinite(payload.contentRight)) return
  if (lastLayoutReport
    && lastLayoutReport.sidebarRight === payload.sidebarRight
    && lastLayoutReport.contentRight === payload.contentRight
    && lastLayoutReport.headerBottom === payload.headerBottom) return
  lastLayoutReport = payload
  ipcRenderer.send('dsh:content-layout', payload)
}

// ── 面板内缩（滚动遮挡修复） ──────────────────────────────────────────────────

let panelInsetBottom = 0
let panelInsetRight = 0
let scrollBody = null
let originalPadding = null

/**
 * 定位会话区滚动体：布局框架 grid 的第 2 个轨道列（会话区）内、
 * overflow 可滚（auto/scroll）且高度最大的容器。
 * 实测结构（dsh web）：会话区 = centerCol 内全高的 scrollBody（消息区与 composer
 * 都在其滚动流内）。只压缩它的 padding，布局框架零移动、无底部空白；
 * 此前把 padding 加在布局框架上会造成整页上移与底部空白（用户反馈）。
 * 找不到时返回 null（不注入，行为退化为纯覆盖）。
 */
function findSessionScrollBody() {
  if (!frame || !frame.isConnected) return null
  const centerCol = findCenterColumn()
  if (!centerCol) return null
  let best = null
  const scan = (element) => {
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && rect.height > 100) {
      if (!best || rect.height > best.rect.height) best = { element, rect }
    }
    for (const child of element.children) scan(child)
  }
  scan(centerCol)
  return best ? best.element : null
}

/**
 * 终端面板显示/停靠变化时下发内缩：
 *   bottom 模式 → 滚动体 padding-bottom = 面板高度
 *   right 模式 → 滚动体 padding-right = 面板宽度
 * 滚动范围收束到面板内侧边缘，无覆盖遮挡；隐藏时还原。
 */
function applyPanelInset() {
  if (frame && (!scrollBody || !scrollBody.isConnected)) scrollBody = findSessionScrollBody()
  const target = scrollBody && scrollBody.isConnected ? scrollBody : null
  if (!target) return
  if (originalPadding === null) {
    originalPadding = {
      bottom: target.style.paddingBottom,
      right: target.style.paddingRight,
    }
  }
  target.style.paddingBottom = panelInsetBottom > 0 ? `${panelInsetBottom}px` : originalPadding.bottom
  target.style.paddingRight = panelInsetRight > 0 ? `${panelInsetRight}px` : originalPadding.right
}

ipcRenderer.on('dsh:panel-inset', (_event, payload) => {
  const bottom = Number(payload && payload.bottom)
  const right = Number(payload && payload.right)
  panelInsetBottom = Number.isFinite(bottom) && bottom > 0 ? Math.round(bottom) : 0
  panelInsetRight = Number.isFinite(right) && right > 0 ? Math.round(right) : 0
  if (panelInsetBottom === 0 && panelInsetRight === 0) scrollBody = null // 下次重新定位
  applyPanelInset()
})

// ── 页面浮层检测（终端面板悬浮时模态自动收起） ────────────────────────────────

let overlayReported = false

/** 浮层采样点（视口相对坐标）。 */
const OVERLAY_SAMPLE_POINTS = [
  [0.5, 0.5], [0.05, 0.05], [0.95, 0.05], [0.5, 0.05], [0.05, 0.5],
  [0.95, 0.5], [0.5, 0.95], [0.05, 0.95], [0.95, 0.95],
]

/**
 * 页面浮层判定（实测校准）：DSH 的设置面板/弹窗是渲染在 frame 内的定位层
 * （实测 `VOzbGW_overlay`：position fixed、z-index 1000、覆盖全视口，mask 为其
 * 子层），不在 overlayLayer 里也不在 body 顶层。判定：9 点采样，命中元素向上
 * 找祖先链，链上有「覆盖 ≥60% 视口的 fixed/absolute 层」即视为浮层；
 * 正常内容（滚动体/内容区）祖先链无此类元素，不会误命中。
 */
function pageHasOverlay() {
  if (!frame || !frame.isConnected) return false
  let hits = 0
  for (const [xr, yr] of OVERLAY_SAMPLE_POINTS) {
    const el = document.elementFromPoint(innerWidth * xr, innerHeight * yr)
    if (!el || el === document.documentElement || el === document.body) continue
    let cur = el
    let depth = 0
    let found = false
    while (cur && cur !== document.body && depth < 12) {
      const style = getComputedStyle(cur)
      if (style.position === 'fixed' || style.position === 'absolute') {
        const rect = cur.getBoundingClientRect()
        if (rect.width >= innerWidth * 0.6 && rect.height >= innerHeight * 0.6) {
          found = true
          break
        }
      }
      cur = cur.parentElement
      depth += 1
    }
    if (found) hits += 1
  }
  return hits >= 4
}

/** 浮层状态变化时上报（避免面板显示状态与页面浮层失步）。 */
function reportOverlayState() {
  const current = pageHasOverlay()
  if (current === overlayReported) return
  overlayReported = current
  ipcRenderer.send('dsh:overlay-state', { overlay: current })
}

function updateLayout() {
  scheduled = false
  if (!document.body) return
  if (!frame || !frame.isConnected || !sidebar || !sidebar.isConnected) observeLayout(findFrame())
  applyPanelInset()
  reportContentLayout()
  reportOverlayState()
  updateDragRegion()
  syncDialogButtonContrast()
}

function scheduleLayoutUpdate() {
  if (scheduled) return
  scheduled = true
  requestAnimationFrame(updateLayout)
}

function start() {
  ensureDragStyle()
  ensureDragStrip()
  ensureDialogUi()
  ensureWindowControls()
  ipcRenderer.send('dsh:window-controls-ready')
  observeLayout(findFrame())
  const mutationObserver = new MutationObserver(() => {
    // 隔离 UI 的 Shadow DOM 变更不进入页面观察范围，不会触发自激。
    if (!frame || !frame.isConnected || !sidebar || !sidebar.isConnected) observeLayout(findFrame())
    scheduleLayoutUpdate()
  })
  mutationObserver.observe(document.documentElement, {
    attributes: true,
    childList: true,
    subtree: true,
    attributeFilter: ['class', 'style', 'data-ds-dark-theme', 'data-sidebar-collapsed'],
  })
  window.addEventListener('resize', scheduleLayoutUpdate)
  scheduleLayoutUpdate()
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
else start()
