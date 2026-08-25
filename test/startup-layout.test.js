'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  centeredSplashBounds,
  normalizeSplashMode,
  splashLayoutForContent,
} = require('../src/startup/layout.js')

test('启动窗口模式只接受 loading 和 error', () => {
  assert.equal(normalizeSplashMode('loading'), 'loading')
  assert.equal(normalizeSplashMode('error'), 'error')
  assert.equal(normalizeSplashMode('unknown'), 'loading')
})

test('加载态使用紧凑宽度并限制测量高度', () => {
  assert.deepEqual(splashLayoutForContent('loading', 150), { width: 400, height: 156 })
  assert.deepEqual(splashLayoutForContent('loading', 171.2), { width: 400, height: 172 })
  assert.deepEqual(splashLayoutForContent('loading', 400), { width: 400, height: 190 })
})

test('错误态保留详情和按钮所需空间', () => {
  assert.deepEqual(splashLayoutForContent('error', 180), { width: 440, height: 196 })
  assert.deepEqual(splashLayoutForContent('error', 246.1), { width: 440, height: 247 })
  assert.deepEqual(splashLayoutForContent('error', 500), { width: 440, height: 300 })
})

test('改变尺寸时保持窗口中心点不变', () => {
  assert.deepEqual(
    centeredSplashBounds(
      { x: 100, y: 200, width: 440, height: 260 },
      { width: 400, height: 172 },
    ),
    { x: 120, y: 244, width: 400, height: 172 },
  )
})
