'use strict'

const DEFAULT_UPDATE_PREFERENCES = Object.freeze({
  checkUpdatesOnStartup: true,
  pendingUpdateVersion: null,
  /** 待提示更新版本的来源：null（npm）| 'githubOnly'。与 pendingUpdateVersion 成对清空。 */
  pendingUpdateSource: null,
  /** 终端面板停靠位置：'bottom'（会话区域下侧）| 'right'（会话区域右侧）。 */
  terminalDock: 'bottom',
  /**
   * 是否跟随 GitHub release：官方 npm 发布是手动流程、常滞后于 GitHub release，
   * 开启后启动检查同时对比两源，发现 GitHub 更新（且 npm 未同步）时提示并从源码构建。
   */
  followGithubReleases: true,
})

/** 迁移旧版每周检查偏好；旧字段无论真假都采用新的“启动检查默认开启”策略。 */
function normalizeUpdatePreferences(data) {
  const source = data && typeof data === 'object' ? data : {}
  const hasCurrentPreference = typeof source.checkUpdatesOnStartup === 'boolean'
  return {
    preferences: {
      checkUpdatesOnStartup: hasCurrentPreference ? source.checkUpdatesOnStartup : true,
      pendingUpdateVersion: typeof source.pendingUpdateVersion === 'string' ? source.pendingUpdateVersion : null,
      pendingUpdateSource: typeof source.pendingUpdateSource === 'string' ? source.pendingUpdateSource : null,
      terminalDock: source.terminalDock === 'right' ? 'right' : 'bottom',
      followGithubReleases: typeof source.followGithubReleases === 'boolean' ? source.followGithubReleases : true,
    },
    needsMigration: !hasCurrentPreference
      || Object.hasOwn(source, 'weeklyUpdateCheck')
      || Object.hasOwn(source, 'lastUpdateCheckAt'),
  }
}

module.exports = { DEFAULT_UPDATE_PREFERENCES, normalizeUpdatePreferences }
