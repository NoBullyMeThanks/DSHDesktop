'use strict'

/**
 * 加载态最小高度 196 是实测值，不是随手取整：窗口按测量高度渲染时，若高度
 * 小于内容自然高度，内容列会被 flex 压扁，measureNaturalCardHeight 量到的仍是
 * 被压扁的高度（自锁），真实事件行会永久被裁掉。196 保证「阶段行 + 进度条 +
 * 真实事件行」在首次测量时就是完整的，且整个启动过程高度恒定、不闪烁。
 */
const SPLASH_LAYOUTS = Object.freeze({
  loading: Object.freeze({ width: 400, minHeight: 196, maxHeight: 232 }),
  error: Object.freeze({ width: 440, minHeight: 196, maxHeight: 300 }),
})

function normalizeSplashMode(mode) {
  return mode === 'error' ? 'error' : 'loading'
}

function splashLayoutForContent(mode, contentHeight) {
  const normalizedMode = normalizeSplashMode(mode)
  const limits = SPLASH_LAYOUTS[normalizedMode]
  const measuredHeight = Number.isFinite(contentHeight)
    ? Math.ceil(contentHeight)
    : limits.minHeight

  return {
    width: limits.width,
    height: Math.min(limits.maxHeight, Math.max(limits.minHeight, measuredHeight)),
  }
}

function centeredSplashBounds(currentBounds, layout) {
  return {
    x: Math.round(currentBounds.x + (currentBounds.width - layout.width) / 2),
    y: Math.round(currentBounds.y + (currentBounds.height - layout.height) / 2),
    width: layout.width,
    height: layout.height,
  }
}

module.exports = {
  SPLASH_LAYOUTS,
  centeredSplashBounds,
  normalizeSplashMode,
  splashLayoutForContent,
}
