'use strict'
/**
 * 系统托盘图标 + 右键菜单（替代原生菜单栏）。
 * 菜单文案按当前 locale 取。
 */
const path = require('node:path')
const { Tray, Menu, nativeImage } = require('electron')
const { t } = require('./i18n.js')

/** 资源缺失时使用的托盘图标兜底。 */
const TRAY_ICON_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAQElEQVR4nGNgwAN8s//9xyePUxMuTJFmgoYQoxmnIaRoxmrIwBpAjmaqGDKIwoAq6YAqKZEYQwhqxmYYyZpIBQAZT5NpXfEUtQAAAABJRU5ErkJggg=='

/** 加载 DeepSeek 鱼形托盘图标；缺失时退回内嵌图标，保证托盘区域不空白。 */
function loadTrayIcon() {
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray.png'))
  if (!img.isEmpty()) return img
  return nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_BASE64}`)
}

/**
 * 创建托盘。
 * @param {object} controller - main.js 注入的动作集合（见下）。
 * @param {string} locale - 当前语言 'zh'|'en'
 * @returns {{ setLocale(locale): void, destroy(): void }}
 */
function createTray(controller, locale) {
  const tray = new Tray(loadTrayIcon())
  let runtimeBusy = false
  tray.setToolTip('DSH Desktop')

  function buildTemplate() {
    return [
      { label: t(locale, 'checkUpdate'), enabled: !runtimeBusy, click: () => controller.checkForUpdates(true) },
      {
        label: t(locale, 'startupUpdateCheck'),
        type: 'checkbox',
        checked: controller.startupUpdateCheckEnabled(),
        click: (item) => controller.setStartupUpdateCheckEnabled(item.checked),
      },
      { label: t(locale, 'openInBrowser'), click: () => controller.openInBrowser() },
      { label: t(locale, 'actionOpenTerminal'), click: () => controller.openTerminal() },
      { type: 'separator' },
      { label: t(locale, 'openLog'), click: () => controller.openLog() },
      { label: t(locale, 'openConfig'), click: () => controller.openConfigDir() },
      { type: 'separator' },
      { label: t(locale, 'quit'), click: () => controller.quit() },
    ]
  }

  function rebuild(loc) {
    locale = loc
    tray.setContextMenu(Menu.buildFromTemplate(buildTemplate()))
  }

  rebuild(locale)
  // 单击托盘图标：显示并聚焦主窗口
  tray.on('click', () => controller.showMainWindow())

  return {
    setLocale: rebuild,
    setRuntimeBusy(busy) {
      runtimeBusy = busy === true
      rebuild(locale)
    },
    destroy: () => { tray.destroy() },
  }
}

module.exports = { createTray }
