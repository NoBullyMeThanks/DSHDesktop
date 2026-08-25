'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function loadContrastHelpers() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8')
  const context = {
    require: () => ({ ipcRenderer: { on() {}, send() {} } }),
    document: { readyState: 'loading', addEventListener() {} },
    window: { addEventListener() {} },
  }
  vm.runInNewContext(`${source}\n;globalThis.helpers = { parseCssRgb, contrastRatio, chooseReadableLabel }`, context)
  return context.helpers
}

test('CSS RGB 解析支持透明度与百分比', () => {
  const { parseCssRgb } = loadContrastHelpers()
  assert.deepEqual(
    { ...parseCssRgb('rgba(255, 128, 0, 50%)') },
    { red: 255, green: 128, blue: 0, alpha: 0.5 },
  )
  assert.equal(parseCssRgb('transparent'), null)
})

test('浅色主按钮会自动选择深色文字', () => {
  const { parseCssRgb, contrastRatio, chooseReadableLabel } = loadContrastHelpers()
  const white = parseCssRgb('rgb(255, 255, 255)')
  const hover = parseCssRgb('rgb(238, 238, 238)')
  const selected = chooseReadableLabel(white, [white, hover])
  assert.ok(contrastRatio(selected, white) >= 4.5)
  assert.ok(selected.red < 64 && selected.green < 64 && selected.blue < 64)
})

test('深色或品牌色按钮会保留可读的浅色文字', () => {
  const { parseCssRgb, chooseReadableLabel } = loadContrastHelpers()
  const white = parseCssRgb('rgb(255, 255, 255)')
  const fill = parseCssRgb('rgb(64, 93, 229)')
  const selected = chooseReadableLabel(white, [fill])
  assert.equal(Math.round(selected.red), 255)
  assert.equal(Math.round(selected.green), 255)
  assert.equal(Math.round(selected.blue), 255)
})
