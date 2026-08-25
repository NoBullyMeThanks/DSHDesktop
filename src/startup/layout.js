'use strict'

const SPLASH_LAYOUTS = Object.freeze({
  loading: Object.freeze({ width: 400, minHeight: 156, maxHeight: 190 }),
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
