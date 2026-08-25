'use strict'

const DEFAULT_UPDATE_PREFERENCES = Object.freeze({
  checkUpdatesOnStartup: true,
  pendingUpdateVersion: null,
  /** 终端面板停靠位置：'bottom'（会话区域下侧）| 'right'（会话区域右侧）。 */
  terminalDock: 'bottom',
})

/** 迁移旧版每周检查偏好；旧字段无论真假都采用新的“启动检查默认开启”策略。 */
function normalizeUpdatePreferences(data) {
  const source = data && typeof data === 'object' ? data : {}
  const hasCurrentPreference = typeof source.checkUpdatesOnStartup === 'boolean'
  return {
    preferences: {
      checkUpdatesOnStartup: hasCurrentPreference ? source.checkUpdatesOnStartup : true,
      pendingUpdateVersion: typeof source.pendingUpdateVersion === 'string' ? source.pendingUpdateVersion : null,
      terminalDock: source.terminalDock === 'right' ? 'right' : 'bottom',
    },
    needsMigration: !hasCurrentPreference
      || Object.hasOwn(source, 'weeklyUpdateCheck')
      || Object.hasOwn(source, 'lastUpdateCheckAt'),
  }
}

module.exports = { DEFAULT_UPDATE_PREFERENCES, normalizeUpdatePreferences }
