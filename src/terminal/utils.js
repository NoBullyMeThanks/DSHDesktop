'use strict'
/**
 * 终端面板的纯逻辑工具：shell 探测、面板 bounds 计算、尺寸与会话 id 校验。
 * 不依赖 Electron，可用纯 Node 单独单测（与 runtime-manager.js 同一约定）。
 */
const { spawnSync } = require('node:child_process')

/** 面板默认占内容区高度的比例（VS Code 面板的常见观感）。 */
const DEFAULT_PANEL_RATIO = 0.35
/** 面板高度下限（px），窗口再小也不低于它。 */
const MIN_PANEL_HEIGHT = 160
/** 面板高度上限比例，避免盖掉整个窗口。 */
const MAX_PANEL_RATIO = 0.7
/** sessionId 只允许短横线/下划线/字母数字，与 pty-host.js 的校验一致。 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
/** 终端尺寸合理区间，与 pty-host.js 一致。 */
const MIN_SIZE = 1
const MAX_SIZE = 1000
/** 右侧停靠参数（manager 与页面共用同一套几何约定）。 */
const RIGHT_DOCK_RATIO = 0.35
const RIGHT_DOCK_MIN_WIDTH = 320
const RIGHT_DOCK_MAX_RATIO = 0.6
/** 右侧停靠时顶部让出的最小高度（窗口按钮区，WebContentsView 永远盖在页面之上）。 */
const RIGHT_DOCK_TOP_INSET = 28
/** 右侧停靠时面板顶边的像素校准：DSH 标题区底边线占 1px（[bottom-1, bottom)），
 *  面板顶边若直接取 headerBottom，其 header 顶边线会落在 [bottom, bottom+1)，
 *  两条线并排成 2px、无法重合。上移 1px 后两条线完全重叠，视觉上是一条线。 */
const RIGHT_DOCK_TOP_OFFSET = 1
/** 面板 header 高度（panel/index.html 的 .header），用于与 DSH 标题区域底边线对齐。 */
const PANEL_HEADER_HEIGHT = 34

/**
 * 探测系统里可用的 shell，返回第一个命中的名字。
 * 顺序：pwsh（PowerShell 7）→ powershell.exe（Windows 内置 5.1）→ cmd.exe。
 * whereFn 可注入（测试用），默认用 where.exe 探测系统 PATH。
 */
function detectShell(whereFn) {
  const probe = typeof whereFn === 'function' ? whereFn : (name) => {
    try {
      return spawnSync('where.exe', [name], { stdio: 'ignore', windowsHide: true }).status === 0
    } catch {
      return false
    }
  }
  if (process.platform === 'win32') {
    for (const name of ['pwsh', 'powershell.exe', 'cmd.exe']) {
      if (probe(name)) return name
    }
    return 'cmd.exe'
  }
  return 'bash'
}

/** 计算面板在内容区内的 bounds：底部横条，高度取比例并夹在 [minHeight, maxRatio] 之间。 */
function computePanelBounds(contentWidth, contentHeight, options = {}) {
  const ratio = options.ratio ?? DEFAULT_PANEL_RATIO
  const minHeight = options.minHeight ?? MIN_PANEL_HEIGHT
  const maxRatio = options.maxRatio ?? MAX_PANEL_RATIO
  const width = Math.max(0, Math.round(contentWidth))
  const height = Math.max(0, Math.round(contentHeight))
  if (width === 0 || height === 0) return { x: 0, y: 0, width: 0, height: 0 }
  const panelHeight = Math.min(Math.max(Math.round(height * ratio), minHeight), Math.round(height * maxRatio))
  return { x: 0, y: height - panelHeight, width, height: panelHeight }
}

/** 会话 id 白名单校验，与 pty-host.js 保持同一套规则。 */
function validSessionId(value) {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value)
}

/** 尺寸收敛到合理区间；非法值回退到 fallback。 */
function clampSize(value, fallback) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) return fallback
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, parsed))
}

/**
 * 按停靠模式与 DSH 会话区域几何计算面板 bounds（纯函数，可单测）。
 * 与 manager 的 IPC/视图层解耦；layout 缺失时回退全宽/顶部下限。
 */
function computeDockBounds(width, height, options = {}) {
  const dock = options.dock === 'right' ? 'right' : 'bottom'
  const layout = options.layout ?? null
  const contentRight = layout && Number.isFinite(layout.contentRight)
    ? Math.min(layout.contentRight, width)
    : width
  const sidebarRight = layout && Number.isFinite(layout.sidebarRight)
    ? Math.min(Math.max(layout.sidebarRight, 0), contentRight)
    : 0
  if (dock === 'right') {
    // 拖动后的宽度可覆盖默认比例（panelWidth），clamp 到 [200, 75%]
    const defaultWidth = Math.round(Math.min(
      Math.max(width * RIGHT_DOCK_RATIO, RIGHT_DOCK_MIN_WIDTH),
      width * RIGHT_DOCK_MAX_RATIO,
    ))
    const panelWidth = Number.isFinite(Number(options.panelWidth)) && Number(options.panelWidth) > 0
      ? Math.round(Math.min(Math.max(Number(options.panelWidth), 200), width * 0.75))
      : defaultWidth
    // 顶部让位：≥ 窗口按钮区（28px），且**面板顶边**与 DSH 会话区标题区域的
    // 底边线共线（headerBottom 缺失时用下限兜底）；面板 header 顶边有边框线，
    // 两条横线视觉连续。
    const headerBottom = layout && Number.isFinite(layout.headerBottom)
      ? Math.max(0, layout.headerBottom)
      : 0
    const topY = Math.max(RIGHT_DOCK_TOP_INSET, headerBottom - RIGHT_DOCK_TOP_OFFSET)
    return { x: width - panelWidth, y: topY, width: panelWidth, height: height - topY }
  }
  // 底部：贴齐会话区域（侧栏右缘 → 内容右缘），侧栏收缩时自动延伸
  const panelWidth = Math.max(contentRight - sidebarRight, 0)
  // 拖动后的高度可覆盖默认比例（panelHeight），clamp 到 [120, 85%]
  const panelHeight = Number.isFinite(Number(options.panelHeight)) && Number(options.panelHeight) > 0
    ? Math.round(Math.min(Math.max(Number(options.panelHeight), 120), height * 0.85))
    : computePanelBounds(panelWidth, height).height
  return { x: sidebarRight, y: height - panelHeight, width: panelWidth, height: panelHeight }
}

/** 面板对会话区滚动体的内缩：bottom 压底部、right 压右侧（纯函数）。 */
function panelInsetFor(bounds, dock) {
  if (dock === 'right') return { bottom: 0, right: bounds.width }
  return { bottom: bounds.height, right: 0 }
}

module.exports = {
  DEFAULT_PANEL_RATIO,
  MIN_PANEL_HEIGHT,
  MAX_PANEL_RATIO,
  RIGHT_DOCK_RATIO,
  RIGHT_DOCK_MIN_WIDTH,
  RIGHT_DOCK_MAX_RATIO,
  RIGHT_DOCK_TOP_INSET,
  RIGHT_DOCK_TOP_OFFSET,
  PANEL_HEADER_HEIGHT,
  detectShell,
  computePanelBounds,
  computeDockBounds,
  panelInsetFor,
  validSessionId,
  clampSize,
}
