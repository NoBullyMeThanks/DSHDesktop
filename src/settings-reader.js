'use strict'
/**
 * 读取并监听 dsh 的 settings.yaml，提取「深浅色偏好」与「语言偏好」。
 * 只依赖 Node 内置模块，不依赖 Electron，可被纯 Node 单测。
 *
 * settings.yaml 是 dsh 用 js-yaml 生成的，顶层是「命名空间 → 段落」的 map：
 *   ui-theme:
 *     preference: dark
 *   locale:
 *     preference: zh
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const THEME_VALUES = ['light', 'dark', 'system']
const LOCALE_VALUES = ['zh', 'en']

/** settings.yaml 的路径，尊重 $DSH_HOME（与 dsh 的 resolveDshHome 一致）。 */
function settingsPath() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim()
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh')
  return path.join(home, 'settings.yaml')
}

/**
 * 从 YAML 文本里提取「顶层命名空间 ns 下、缩进的 field 标量值」。
 * 轻量按行扫描，不解析完整 YAML——只针对机器生成的稳定结构，
 * 容错注释、引号、以及目标命名空间/字段缺失。取不到返回 null。
 */
function extractScalar(yaml, ns, field) {
  if (typeof yaml !== 'string') return null
  let inNs = false
  for (const raw of yaml.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trimEnd()
    // 顶层键：行首无缩进、以冒号结尾（namespace 段头）
    if (/^\S[^:]*:$/.test(line)) {
      inNs = line.replace(/:$/, '').trim() === ns
      continue
    }
    if (!inNs) continue
    // 出现另一个顶层键 => 目标命名空间已结束
    if (/^\S/.test(line)) { inNs = false; continue }
    const m = line.match(new RegExp('^\\s+' + field + ':\\s*(\\S.*?)\\s*$'))
    if (m) return m[1].replace(/^['"]|['"]$/g, '')
  }
  return null
}

/** 读 settings.yaml，返回 { theme, locale }；文件不存在/损坏时返回 null 值。 */
function readSettings() {
  let text = null
  try { text = fs.readFileSync(settingsPath(), 'utf8') } catch { text = null }
  const theme = extractScalar(text, 'ui-theme', 'preference')
  const locale = extractScalar(text, 'locale', 'preference')
  return {
    theme: THEME_VALUES.includes(theme) ? theme : null,
    locale: LOCALE_VALUES.includes(locale) ? locale : null,
  }
}

/**
 * 轮询监听 settings.yaml（dsh 是「临时文件 + rename」原子写，fs.watch 会丢事件，
 * 故用 fs.watchFile 轮询）。变化时回调最新的 { theme, locale }。
 * @returns 取消监听的函数。
 */
function watchSettings(cb) {
  const file = settingsPath()
  const stat = () => {
    try {
      const s = fs.statSync(file)
      return `${s.mtimeMs}:${s.size}`
    } catch {
      return 'missing'
    }
  }
  let last = stat()
  fs.watchFile(file, { interval: 500 }, () => {
    const now = stat()
    if (now === last) return
    last = now
    cb(readSettings())
  })
  return () => { try { fs.unwatchFile(file) } catch {} }
}

module.exports = { settingsPath, readSettings, watchSettings, extractScalar, THEME_VALUES, LOCALE_VALUES }
