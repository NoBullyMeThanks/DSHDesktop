'use strict'
/**
 * 推断 DSH「当前工作区」路径，供终端面板作为默认工作目录。
 *
 * 不读 dsh 内部会话状态、不改 dsh 源码，只依赖两个稳定文件事实：
 *   1. ~/.dsh/storages/workspace.json —— workspace 注册表（id → path/title/updatedAt）；
 *   2. ~/.dsh/sessions/<--编码路径-->/<会话文件> —— 会话日志目录，
 *      目录名是 workspace 路径经 projectKey 编码后的形态，会话文件 mtime 反映活跃度。
 *
 * 判定顺序：
 *   ① 全 sessions 目录下 mtime 最新的会话文件 → 其父目录 slug →
 *      与注册表里每个 path 的 projectKey 编码比对（编码后比对，规避有损解码）；
 *   ② 兜底：注册表里 updatedAt 最新的 workspace；
 *   ③ 再兜底：返回 null，调用方回退用户主目录。
 *
 * 纯 Node 依赖，可被 node:test 直接单测。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/** dsh 数据根目录，尊重 $DSH_HOME（与 settings-reader.js 的约定一致）。 */
function dshHomePath() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim()
    ? process.env.DSH_HOME.trim()
    : path.join(os.homedir(), '.dsh')
  return home
}

/**
 * 镜像 dsh 的 projectKey（packages/session/session-persistence-jsonl/src/format.ts）：
 * 分隔符（/ \ :）合并为单个 `-`，安全字符保留，其余转 `~XXXX`，去掉开头连字符，
 * 包裹 `--slug--` 并截断 251。有损编码——因此本模块只做「编码后比对」而从不解码。
 */
function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return null
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/** 读 workspace 注册表，返回 [{ id, path, title, updatedAt }]；文件缺失/损坏返回 []。 */
function readWorkspaceRegistry(dshHome) {
  try {
    const text = fs.readFileSync(path.join(dshHome, 'storages', 'workspace.json'), 'utf8')
    const parsed = JSON.parse(text)
    const tables = parsed && typeof parsed === 'object' ? parsed.tables : null
    const workspaces = tables && typeof tables === 'object' ? tables.workspaces : null
    if (!workspaces || typeof workspaces !== 'object') return []
    return Object.entries(workspaces)
      .map(([id, entry]) => ({
        id,
        path: typeof entry?.path === 'string' ? entry.path : null,
        title: typeof entry?.title === 'string' ? entry.title : null,
        updatedAt: typeof entry?.updatedAt === 'string' ? entry.updatedAt : null,
      }))
      .filter((entry) => typeof entry.path === 'string' && entry.path.length > 0)
  } catch {
    return []
  }
}

/**
 * 找出「最新活跃会话」所在的项目目录 slug。
 * 遍历 sessions 根目录下每个项目目录里的所有文件，取 mtime 最新的一个，
 * 返回其父目录名；无会话文件返回 null。
 */
function latestSessionSlug(sessionsRoot) {
  let best = null // { slug, mtime }
  let entries
  try {
    entries = fs.readdirSync(sessionsRoot, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    let files
    try {
      files = fs.readdirSync(path.join(sessionsRoot, entry.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.isFile()) continue
      let mtime
      try {
        mtime = fs.statSync(path.join(sessionsRoot, entry.name, file.name)).mtimeMs
      } catch {
        continue
      }
      if (!best || mtime > best.mtime) best = { slug: entry.name, mtime }
    }
  }
  return best ? best.slug : null
}

/**
 * 解析当前工作区路径。
 * @param {object} [options] - 测试注入：{ dshHome, sessionsRoot }
 * @returns {string|null} 工作区绝对路径；无法推断返回 null（调用方回退主目录）。
 */
function resolveWorkspace(options = {}) {
  const dshHome = options.dshHome ?? dshHomePath()
  const sessionsRoot = options.sessionsRoot ?? path.join(dshHome, 'sessions')

  const workspaces = readWorkspaceRegistry(dshHome)
  if (workspaces.length === 0) return null

  // ① 最新活跃会话所属项目目录 slug → 与注册表编码比对
  const slug = latestSessionSlug(sessionsRoot)
  if (slug) {
    const matched = workspaces.find((entry) => projectKey(entry.path) === slug)
    if (matched) return matched.path
  }

  // ② 注册表 updatedAt 最新
  const byRecency = workspaces
    .filter((entry) => typeof entry.updatedAt === 'string')
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
  if (byRecency.length > 0) return byRecency[0].path

  // ③ 只有 path 的注册项按录入顺序取第一个
  return workspaces[0].path ?? null
}

module.exports = {
  dshHomePath,
  projectKey,
  readWorkspaceRegistry,
  latestSessionSlug,
  resolveWorkspace,
}
