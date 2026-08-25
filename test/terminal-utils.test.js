'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const utils = require('../src/terminal/utils.js')

test('detectShell 按 pwsh → powershell.exe → cmd.exe 顺序探测', () => {
  const order = []
  const probe = (name) => {
    order.push(name)
    return name === 'powershell.exe'
  }
  assert.equal(utils.detectShell(probe), 'powershell.exe')
  assert.deepEqual(order, ['pwsh', 'powershell.exe'])
})

test('detectShell 全部缺失时回退 cmd.exe', () => {
  const probe = () => false
  assert.equal(utils.detectShell(probe), 'cmd.exe')
})

test('detectShell 优先 pwsh', () => {
  const probe = (name) => name === 'pwsh'
  assert.equal(utils.detectShell(probe), 'pwsh')
})

test('computePanelBounds 默认比例 35% 并贴底', () => {
  const bounds = utils.computePanelBounds(1200, 800)
  assert.equal(bounds.width, 1200)
  assert.equal(bounds.height, 280)
  assert.equal(bounds.y, 800 - 280)
  assert.equal(bounds.x, 0)
})

test('computePanelBounds 高度低于下限时抬高到下限', () => {
  const bounds = utils.computePanelBounds(1200, 300)
  assert.equal(bounds.height, 160)
  assert.equal(bounds.y, 300 - 160)
})

test('computePanelBounds 上限比例压缩（小窗口下限把面板顶到上限）', () => {
  // 200*0.35=70 → 下限 160 → 上限 200*0.7=140，最终取 140
  const bounds = utils.computePanelBounds(1200, 200)
  assert.equal(bounds.height, 140)
})

test('computePanelBounds 自定义 maxRatio 生效', () => {
  const bounds = utils.computePanelBounds(800, 1000, { ratio: 0.8, maxRatio: 0.5 })
  assert.equal(bounds.height, 500)
})

test('computePanelBounds 自定义参数生效', () => {
  const bounds = utils.computePanelBounds(800, 1000, { ratio: 0.5, minHeight: 100, maxRatio: 0.8 })
  assert.equal(bounds.height, 500)
})

test('computePanelBounds 空窗口返回全零', () => {
  assert.deepEqual(utils.computePanelBounds(0, 0), { x: 0, y: 0, width: 0, height: 0 })
})

test('validSessionId 白名单校验', () => {
  assert.equal(utils.validSessionId('abc-123_XYZ'), true)
  assert.equal(utils.validSessionId('a'.repeat(64)), true)
  assert.equal(utils.validSessionId(''), false)
  assert.equal(utils.validSessionId('a b'), false)
  assert.equal(utils.validSessionId('../x'), false)
  assert.equal(utils.validSessionId('a'.repeat(65)), false)
  assert.equal(utils.validSessionId(null), false)
})

test('clampSize 收敛到 [1, 1000] 并回退非法值', () => {
  assert.equal(utils.clampSize(120, 24), 120)
  assert.equal(utils.clampSize(2000, 80), 1000)
  assert.equal(utils.clampSize(-5, 80), 1)
  assert.equal(utils.clampSize(0, 80), 1)
  assert.equal(utils.clampSize('x', 24), 24)
  assert.equal(utils.clampSize(1.5, 24), 24)
  assert.equal(utils.clampSize(undefined, 24), 24)
})

test('computeDockBounds 底部：贴齐会话区域（侧栏收缩自动延伸）', () => {
  const layout = { sidebarRight: 280, contentRight: 1264, headerBottom: 70 }
  const bounds = utils.computeDockBounds(1264, 735, { dock: 'bottom', layout })
  const height = Math.round(735 * 0.35)
  assert.deepEqual(bounds, { x: 280, y: 735 - height, width: 984, height })
  // 侧栏收缩
  const collapsed = utils.computeDockBounds(1264, 735, {
    dock: 'bottom',
    layout: { sidebarRight: 0, contentRight: 1264, headerBottom: 70 },
  })
  assert.equal(collapsed.x, 0)
  assert.equal(collapsed.width, 1264)
})

test('computeDockBounds 底部：layout 缺失时回退全宽', () => {
  const bounds = utils.computeDockBounds(1000, 800, { dock: 'bottom' })
  assert.equal(bounds.x, 0)
  assert.equal(bounds.width, 1000)
})

test('computeDockBounds 右侧：宽度 35%（带上下限 clamp）', () => {
  const bounds = utils.computeDockBounds(1264, 735, { dock: 'right' })
  const width = Math.round(1264 * 0.35)
  assert.equal(bounds.width, width)
  assert.equal(bounds.y, utils.RIGHT_DOCK_TOP_INSET) // headerBottom 缺失 → 下限 28
  assert.equal(bounds.height, 735 - utils.RIGHT_DOCK_TOP_INSET)
  // 超小窗口 → 下限 320
  const small = utils.computeDockBounds(800, 600, { dock: 'right' })
  assert.equal(small.width, Math.max(Math.round(800 * 0.35), 320))
  // 极窄窗口（35% 低于 320 且超过 60% 上限）→ 上限 60% 生效
  const narrow = utils.computeDockBounds(500, 600, { dock: 'right' })
  assert.equal(narrow.width, 500 * 0.6)
})

test('computeDockBounds 右侧：面板顶边与标题区底边线对齐', () => {
  const layout = { sidebarRight: 280, contentRight: 1264, headerBottom: 70 }
  const bounds = utils.computeDockBounds(1264, 735, { dock: 'right', layout })
  // 面板顶 = headerBottom - 1：面板 header 顶边线（1px）与标题区底边线（1px）
  // 完全重叠（不校准会并排成 2px，实测对齐差 1px）
  assert.equal(bounds.y, 70 - utils.RIGHT_DOCK_TOP_OFFSET)
  assert.equal(bounds.height, 735 - bounds.y)
  // headerBottom 缺失 / header 隐藏 → 下限 28（窗口按钮区）
  const fallback = utils.computeDockBounds(1264, 735, { dock: 'right' })
  assert.equal(fallback.y, utils.RIGHT_DOCK_TOP_INSET)
})

test('panelInsetFor 按停靠模式返回内缩方向', () => {
  assert.deepEqual(utils.panelInsetFor({ width: 414, height: 700 }, 'right'), { bottom: 0, right: 414 })
  assert.deepEqual(utils.panelInsetFor({ width: 944, height: 257 }, 'bottom'), { bottom: 257, right: 0 })
})
