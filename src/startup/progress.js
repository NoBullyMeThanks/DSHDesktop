'use strict'

/**
 * 启动进度模型（事件驱动，不做时间推演）。
 *
 * 设计约束：
 *  1. 进度只在真实事件发生时变化：阶段开始/结束、子事件计数（如 npm 实际抓取的包数）。
 *     绝不按「上次启动花了多久」估算，也不用定时器空转推进。
 *  2. 每个阶段有真实权重（依据它在实际启动中的耗时占比），阶段完成才把这段权重计入。
 *  3. 拿不到总量的阶段标记 measurable=false：渲染层显示不定量流动，不显示百分比，
 *     只展示真实事件文本（例如「已获取 128 个包」）。
 *
 * 权重基于实测：首次安装的 npm 下载占绝大部分时间，DSH 服务就绪次之，
 * 环境检查/运行时校验/界面加载都是毫秒级。阶段一旦开始，其区间立即计入
 * （表示「已推进到这一步」），这与旧版按阶段跳百分比的语义一致，但不含任何
 * 时间推演。
 */
const SPLASH_PROGRESS_PHASES = Object.freeze([
  Object.freeze({ id: 'environment', weight: 4, measurable: true }),
  Object.freeze({ id: 'runtime', weight: 6, measurable: true }),
  Object.freeze({ id: 'install', weight: 35, measurable: false }),
  Object.freeze({ id: 'switch-source', weight: 8, measurable: false }),
  Object.freeze({ id: 'dsh', weight: 40, measurable: false }),
  Object.freeze({ id: 'interface', weight: 7, measurable: true }),
])

/** 各阶段（含其之前所有阶段）的相对位置，用于把权重换算成百分比。 */
const SPLASH_PROGRESS_TOTAL_WEIGHT = SPLASH_PROGRESS_PHASES
  .reduce((total, phase) => total + phase.weight, 0)

const SPLASH_PHASE_IDS = Object.freeze(SPLASH_PROGRESS_PHASES.map((phase) => phase.id))

/** 阶段 id -> 已计入的权重占比（0–100）。 */
function phaseCeiling(phaseId) {
  const index = SPLASH_PROGRESS_PHASES.findIndex((phase) => phase.id === phaseId)
  if (index === -1) return 0
  const weight = SPLASH_PROGRESS_PHASES
    .slice(0, index + 1)
    .reduce((total, phase) => total + phase.weight, 0)
  return weight / SPLASH_PROGRESS_TOTAL_WEIGHT * 100
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

/**
 * 启动进度追踪器。调用方（main.js）在真实事件点调用 begin/advance/finish，
 * 每次变化都会回调 onChange(snapshot)。
 *
 * snapshot = {
 *   percent,      // 已完成阶段的权重占比，0–100
 *   phase,        // 当前阶段 id，未开始为 null
 *   measurable,   // 当前阶段是否有真实子进度
 *   metrics,      // 真实事件文本（可为 null）
 * }
 */
function createStartupProgress(onChange) {
  const notify = typeof onChange === 'function' ? onChange : () => {}
  let percent = 0
  let phase = null
  let measurable = true
  let metrics = null

  function snapshot() {
    return { percent: clampPercent(percent), phase, measurable, metrics }
  }

  function emit() {
    notify(snapshot())
  }

  function begin(nextPhaseId) {
    const index = SPLASH_PHASE_IDS.indexOf(nextPhaseId)
    if (index === -1) return
    // 已进入更靠后的阶段时忽略回退调用，避免重试路径把进度拉回去
    const currentIndex = phase ? SPLASH_PHASE_IDS.indexOf(phase) : -1
    if (index <= currentIndex) return
    const phaseDef = SPLASH_PROGRESS_PHASES[index]
    percent = phaseCeiling(nextPhaseId)
    phase = nextPhaseId
    measurable = phaseDef.measurable
    metrics = null
    emit()
  }

  /**
   * 记录当前阶段的真实子进度。只有 measurable=true 的阶段且 ratio 有效时
   * 才微调百分比——这是唯一允许改变百分比的测量来源，且比例来自真实计数。
   */
  function setMetrics(text, ratio) {
    if (!phase) return
    const previousPercent = percent
    const previousMetrics = metrics
    metrics = typeof text === 'string' && text ? text : metrics
    if (measurable && Number.isFinite(ratio)) {
      const index = SPLASH_PHASE_IDS.indexOf(phase)
      const floor = index > 0 ? phaseCeiling(SPLASH_PHASE_IDS[index - 1]) : 0
      const ceiling = phaseCeiling(phase)
      percent = floor + (ceiling - floor) * Math.min(1, Math.max(0, ratio))
    }
    if (metrics !== previousMetrics || percent !== previousPercent) emit()
  }

  function finish() {
    percent = 100
    phase = null
    measurable = true
    metrics = null
    emit()
  }

  /** 重新开始一次启动尝试（重试按钮）时归零，避免上一轮的 100% 残留。 */
  function reset() {
    percent = 0
    phase = null
    measurable = true
    metrics = null
    emit()
  }

  return { begin, finish, reset, setMetrics, snapshot }
}

module.exports = {
  SPLASH_PHASE_IDS,
  SPLASH_PROGRESS_PHASES,
  SPLASH_PROGRESS_TOTAL_WEIGHT,
  createStartupProgress,
  phaseCeiling,
}
