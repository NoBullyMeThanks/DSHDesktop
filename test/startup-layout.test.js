'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  centeredSplashBounds,
  normalizeSplashMode,
  splashLayoutForContent,
} = require('../src/startup/layout.js')
const {
  SPLASH_PHASE_IDS,
  SPLASH_PROGRESS_PHASES,
  createStartupProgress,
  phaseCeiling,
} = require('../src/startup/progress.js')
const { createNpmProgressReader } = require('../src/startup/npm-progress.js')

test('启动窗口模式只接受 loading 和 error', () => {
  assert.equal(normalizeSplashMode('loading'), 'loading')
  assert.equal(normalizeSplashMode('error'), 'error')
  assert.equal(normalizeSplashMode('unknown'), 'loading')
})

test('加载态使用紧凑宽度并限制测量高度', () => {
  assert.deepEqual(splashLayoutForContent('loading', 150), { width: 400, height: 196 })
  assert.deepEqual(splashLayoutForContent('loading', 211.2), { width: 400, height: 212 })
  assert.deepEqual(splashLayoutForContent('loading', 400), { width: 400, height: 232 })
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

test('进度阶段权重为正且累计到 100', () => {
  let total = 0
  for (const phase of SPLASH_PROGRESS_PHASES) {
    assert.ok(phase.weight > 0, `${phase.id} 权重必须为正`)
    total += phase.weight
  }
  assert.equal(total, 100)
  assert.equal(phaseCeiling(SPLASH_PHASE_IDS[SPLASH_PHASE_IDS.length - 1]), 100)
})

test('阶段区间随阶段推进且不回退', () => {
  const ceilings = SPLASH_PHASE_IDS.map((id) => phaseCeiling(id))
  for (let i = 1; i < ceilings.length; i += 1) {
    assert.ok(ceilings[i] > ceilings[i - 1], `${SPLASH_PHASE_IDS[i]} 的区间未推进`)
  }
})

test('进度只在真实事件推进，不随时间变化', () => {
  const seen = []
  const progress = createStartupProgress((snapshot) => seen.push(snapshot))

  assert.deepEqual(progress.snapshot(), { percent: 0, phase: null, measurable: true, metrics: null })

  progress.begin('environment')
  assert.equal(progress.snapshot().percent, phaseCeiling('environment'))
  assert.equal(progress.snapshot().phase, 'environment')

  progress.begin('runtime')
  assert.equal(progress.snapshot().percent, phaseCeiling('runtime'))

  // 没有新事件时快照保持不变（模型内不存在任何定时器）
  const frozen = progress.snapshot()
  assert.deepEqual(progress.snapshot(), frozen)
  assert.equal(seen.length, 2, '只有真实事件才触发回调')
})

test('不可测量的阶段不因计数改变百分比，只更新事件文本', () => {
  const progress = createStartupProgress(() => {})
  progress.begin('install')
  const before = progress.snapshot()
  assert.equal(before.measurable, false)

  progress.setMetrics('正在下载依赖（已获取 12 个包）', 0.5)
  const after = progress.snapshot()
  assert.equal(after.percent, before.percent, '总量未知时不得推算百分比')
  assert.equal(after.metrics, '正在下载依赖（已获取 12 个包）')
})

test('可测量的阶段按真实比例细化百分比', () => {
  const progress = createStartupProgress(() => {})
  progress.begin('environment')
  const ceiling = progress.snapshot().percent
  progress.setMetrics('half', 0.5)
  assert.ok(Math.abs(progress.snapshot().percent - ceiling / 2) < 0.001)
})

test('阶段回退调用被忽略，重试不会把进度拉回去', () => {
  const progress = createStartupProgress(() => {})
  progress.begin('runtime')
  progress.begin('environment')
  assert.equal(progress.snapshot().phase, 'runtime')
})

test('完成事件把进度置满', () => {
  const progress = createStartupProgress(() => {})
  progress.begin('interface')
  progress.finish()
  assert.deepEqual(progress.snapshot(), { percent: 100, phase: null, measurable: true, metrics: null })
})

test('重试归零后可以重新推进', () => {
  const progress = createStartupProgress(() => {})
  progress.begin('interface')
  progress.finish()
  progress.reset()
  assert.equal(progress.snapshot().percent, 0)
  progress.begin('environment')
  assert.equal(progress.snapshot().percent, phaseCeiling('environment'))
})

test('npm 输出解析：tarball 计数按 URL 去重，元数据请求单独计数', () => {
  const reader = createNpmProgressReader()
  reader.push('npm http fetch GET 200 https://registry.npmjs.org/@deepseek-ai%2fdsh 336ms (cache revalidated)\n')
  reader.push('npm http fetch GET 200 https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.5-rc.2.tgz 1204ms (cache miss)\n')
  reader.push('npm http fetch GET 200 https://registry.npmjs.org/commander/-/commander-12.0.0.tgz 88ms (cache miss)\n')
  // 同一 tarball 因重试重复出现时不应重复计数
  reader.push('npm http fetch GET 200 https://registry.npmjs.org/commander/-/commander-12.0.0.tgz 91ms (cache miss)\n')
  reader.push('npm http fetch POST 200 https://registry.npmjs.org/-/npm/v1/security/advisories/bulk 40ms\n')

  assert.deepEqual(reader.snapshot(), {
    tarballs: 2,
    metadataRequests: 1,
    summary: null,
    error: null,
  })
})

test('npm 输出解析：跨 chunk 的半行不会丢计数', () => {
  const reader = createNpmProgressReader()
  reader.push('npm http fetch GET 200 https://registry.npmjs.org/a/-/a-1.0.0.tg')
  reader.push('z 12ms (cache miss)\nnpm http fetch GET 200 https://registry.npmjs.org/b/-/b-1.0.0.tgz 9ms (cache miss)')
  reader.flush()
  assert.equal(reader.snapshot().tarballs, 2)
})

test('npm 输出解析：结尾无换行的最后一行也不会丢', () => {
  const reader = createNpmProgressReader()
  reader.push('added 412 packages in 37s')
  reader.flush()
  assert.equal(reader.snapshot().summary, 'added 412 packages in 37s')
})

test('npm 输出解析：记录汇总行与错误行', () => {
  const reader = createNpmProgressReader()
  reader.push('added 412 packages in 37s\n')
  reader.push('npm error code ETARGET\n')
  const snapshot = reader.snapshot()
  assert.equal(snapshot.summary, 'added 412 packages in 37s')
  assert.equal(snapshot.error, 'code ETARGET')
})
