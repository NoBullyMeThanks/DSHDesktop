'use strict'
/**
 * GitHub release 侧版本发现与源码下载。
 *
 * 官方流程：deepseek-ai/deepseek-harness 以 `dsh-v<semver>` 打 tag 发 GitHub
 * release（如 dsh-v0.1.2-alpha.1），npm 发布是手动 workflow_dispatch——
 * 二者天然存在时间差。本模块负责发现「已经发了 release、但 npm 还没同步」的版本，
 * 以及下载 release 的源码 tarball（release 本身不附带任何二进制资产）。
 *
 * 所有网络与文件 IO 均可注入，纯 Node 单测；不依赖 Electron。
 */
const fs = require('node:fs')
const https = require('node:https')
const { parseVersion, compareVersions } = require('./runtime-manager.js')

const GITHUB_API_BASE = 'https://api.github.com'
const DSH_REPO = 'deepseek-ai/deepseek-harness'
const RELEASE_TAG_PREFIX = 'dsh-v'
const DEFAULT_API_TIMEOUT_MS = 10000
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000

function defaultHeaders() {
  return {
    'User-Agent': 'dsh-desktop',
    Accept: 'application/vnd.github+json',
  }
}

/** 从 release tag（如 `dsh-v0.1.2-alpha.1`）解析出版本号；非法返回 null。 */
function parseReleaseTag(tag) {
  if (typeof tag !== 'string' || !tag.startsWith(RELEASE_TAG_PREFIX)) return null
  const version = tag.slice(RELEASE_TAG_PREFIX.length)
  return parseVersion(version) ? version : null
}

/**
 * 拉取一个 URL 并返回 { status, headers, text }；跟随重定向（最多 maxRedirects 跳）。
 * 网络错误/超时返回 { ok:false, error }。响应体上限保护（默认 2MB，JSON 场景足够）。
 */
function fetchText(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_API_TIMEOUT_MS
  const maxRedirects = options.maxRedirects ?? 3
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024
  const headers = { ...defaultHeaders(), ...(options.headers ?? {}) }
  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => { if (!settled) { settled = true; resolve(result) } }
    const attempt = (currentUrl, hops) => {
      let req
      try {
        req = https.get(currentUrl, { headers, timeout: timeoutMs }, (res) => {
          const redirect = [301, 302, 303, 307, 308].includes(res.statusCode) ? res.headers.location : null
          if (redirect) {
            res.resume()
            if (hops >= maxRedirects) return finish({ ok: false, error: '重定向过多' })
            let next
            try { next = new URL(redirect, currentUrl).href } catch { return finish({ ok: false, error: '无效的重定向地址' }) }
            return attempt(next, hops + 1)
          }
          if (res.statusCode !== 200) {
            res.resume()
            return finish({ ok: false, error: `HTTP ${res.statusCode}` })
          }
          const chunks = []
          let received = 0
          res.on('data', (chunk) => {
            received += chunk.length
            if (received > maxBytes) {
              res.destroy()
              return finish({ ok: false, error: `响应体超过 ${maxBytes} 字节上限` })
            }
            chunks.push(chunk)
          })
          res.on('end', () => finish({ ok: true, status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }))
          res.on('error', (err) => finish({ ok: false, error: err.message }))
        })
      } catch (err) {
        return finish({ ok: false, error: err.message })
      }
      req.on('error', (err) => finish({ ok: false, error: err.message }))
      req.on('timeout', () => { req.destroy(); finish({ ok: false, error: `请求超时（${timeoutMs}ms）` }) })
    }
    attempt(url, 0)
  })
}

/**
 * 下载任意 URL 到本地文件（含重定向与进度回调）。
 * options：{ timeoutMs, onProgress(bytes, total), headers }。
 * 返回 { ok, bytes?, error? }。
 */
function downloadFile(url, destFile, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS
  const maxRedirects = options.maxRedirects ?? 4
  const headers = { ...defaultHeaders(), ...(options.headers ?? {}) }
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null
  const isAborted = typeof options.isAborted === 'function' ? options.isAborted : () => false
  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const attempt = (currentUrl, hops) => {
      if (isAborted()) {
        finish({ ok: false, cancelled: true, error: '已取消' })
        return
      }
      let req
      try {
        req = https.get(currentUrl, { headers, timeout: timeoutMs }, (res) => {
          const redirect = [301, 302, 303, 307, 308].includes(res.statusCode) ? res.headers.location : null
          if (redirect) {
            res.resume()
            if (hops >= maxRedirects) return finish({ ok: false, error: '重定向过多' })
            let next
            try { next = new URL(redirect, currentUrl).href } catch { return finish({ ok: false, error: '无效的重定向地址' }) }
            return attempt(next, hops + 1)
          }
          if (res.statusCode !== 200) {
            res.resume()
            return finish({ ok: false, error: `HTTP ${res.statusCode}` })
          }
          const total = Number(res.headers['content-length'] ?? 0)
          let received = 0
          let lastEmit = 0
          const stream = fs.createWriteStream(destFile)
          res.on('data', (chunk) => {
            received += chunk.length
            if (isAborted()) {
              res.destroy()
              stream.destroy()
              finish({ ok: false, cancelled: true, error: '已取消' })
              return
            }
            if (onProgress && received - lastEmit >= 262144) {
              lastEmit = received
              try { onProgress(received, total) } catch {}
            }
          })
          stream.on('error', (err) => { res.destroy(); finish({ ok: false, error: err.message }) })
          res.on('error', (err) => { stream.destroy(); finish({ ok: false, error: err.message }) })
          stream.on('finish', () => {
            if (isAborted()) finish({ ok: false, cancelled: true, error: '已取消' })
            else finish({ ok: true, bytes: received })
          })
          res.pipe(stream)
        })
      } catch (err) {
        return finish({ ok: false, error: err.message })
      }
      req.on('error', (err) => finish({ ok: false, error: err.message }))
      req.on('timeout', () => { req.destroy(); finish({ ok: false, error: `下载超时（${timeoutMs}ms）` }) })
    }
    attempt(url, 0)
  })
}

/** 下载指定 release tag 的源码 tarball 到 destFile（api.github.com/tarball 会 302 到 codeload）。 */
async function downloadSourceTarball(tag, destFile, options = {}) {
  const url = `${options.apiBase ?? GITHUB_API_BASE}/repos/${options.repo ?? DSH_REPO}/tarball/${tag}`
  return downloadFile(url, destFile, options)
}

/** 从 GitHub releases 列表 JSON 中选出 dsh-v 前缀、semver 最大的 release。 */
function bestReleaseFromList(list) {
  if (!Array.isArray(list)) return null
  let best = null
  for (const item of list) {
    if (!item || typeof item.tag_name !== 'string') continue
    const version = parseReleaseTag(item.tag_name)
    if (!version) continue
    if (!best || compareVersions(version, best.version) > 0) {
      best = {
        version,
        tag: item.tag_name,
        publishedAt: typeof item.published_at === 'string' ? item.published_at : null,
        prerelease: item.prerelease === true,
      }
    }
  }
  return best
}

/** 解码 XML 文本中的基础 HTML 实体。 */
function decodeXml(text) {
  return String(text)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

/** 从 GitHub atom feed 文本中提取所有 <title>（去掉实体编码）。 */
function parseAtomTitles(text) {
  const titles = []
  if (typeof text !== 'string') return titles
  const regex = /<title[^>]*>([\s\S]*?)<\/title>/g
  let match
  while ((match = regex.exec(text)) !== null) {
    const raw = match[1].trim()
    if (raw) titles.push(decodeXml(raw))
  }
  return titles
}

/** 从 tag 名列表中选出 dsh-v 前缀、semver 最大者（feed 来源没有 publishedAt/commit）。 */
function bestVersionFromTagList(tags) {
  let best = null
  for (const tag of tags) {
    const version = parseReleaseTag(tag)
    if (!version) continue
    if (!best || compareVersions(version, best.version) > 0) {
      best = { version, tag, publishedAt: null, prerelease: true, commit: null }
    }
  }
  return best
}

/**
 * 解析一个 git tag 指向的 commit SHA（尽力而为，溯源/注入构建环境用）。
 * 返回 commit sha 字符串或 null（网络/解析失败一律不阻塞调用方）。
 */
async function resolveTagCommit(tag, options = {}) {
  if (typeof tag !== 'string' || !tag) return null
  try {
    const fetchImpl = options.fetchImpl ?? ((url, opts) => fetchText(url, opts))
    const url = `${options.apiBase ?? GITHUB_API_BASE}/repos/${options.repo ?? DSH_REPO}/git/ref/tags/${encodeURIComponent(tag)}`
    const res = await fetchImpl(url, {
      timeoutMs: options.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
      headers: options.headers ?? defaultHeaders(),
    })
    if (!res.ok || res.status !== 200) return null
    const ref = JSON.parse(res.text)
    return ref?.object?.sha ?? null
  } catch {
    return null
  }
}

/**
 * 查询 GitHub 上最新的 dsh release（含 prerelease——官方所有版本都是 prerelease，
 * 所以不能用 /releases/latest）。
 *
 * 来源顺序：REST API（api.github.com，匿名 60 次/小时限流）→ tags.atom →
 * releases.atom（github.com 主站：国内网络 api.github.com 常被墙，feed 更稳且不限流）。
 * options：{ fetchImpl, apiBase, repo, log, timeoutMs }。
 * 返回 { version, tag, commit, publishedAt } 或 null（不可达/限流/解析失败）。
 */
async function latestGithubRelease(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const fetchImpl = options.fetchImpl ?? ((url, opts) => fetchText(url, opts))
  const apiBase = options.apiBase ?? GITHUB_API_BASE
  const repo = options.repo ?? DSH_REPO
  const timeoutMs = options.timeoutMs ?? DEFAULT_API_TIMEOUT_MS

  // 1) REST API（首选：带 publishedAt / commit 溯源）
  const apiUrl = `${apiBase}/repos/${repo}/releases?per_page=${options.perPage ?? 20}`
  const apiRes = await fetchImpl(apiUrl, {
    timeoutMs,
    headers: options.headers ?? defaultHeaders(),
  })
  if (apiRes.ok && apiRes.status === 200) {
    let list = null
    try { list = JSON.parse(apiRes.text) } catch {}
    const best = bestReleaseFromList(list)
    if (best) {
      const commit = await resolveTagCommit(best.tag, { apiBase, repo, timeoutMs, fetchImpl, headers: options.headers })
      log(`[github] 最新 release（API）：${best.tag}（${best.version}）`)
      return { ...best, commit }
    }
    log('[github] API 有响应但没有匹配 dsh-v 前缀的 release')
  } else if (apiRes.status === 403 || apiRes.status === 429) {
    log(`[github] API 被限流（HTTP ${apiRes.status}），改用 GitHub feed`)
  } else {
    log(`[github] API 查询失败：${apiRes.error ?? `HTTP ${apiRes.status}`}，改用 GitHub feed`)
  }

  // 2) GitHub 主站 atom feed 回退（tags.atom 的 <title> 就是 tag 名）
  const feedHeaders = { 'User-Agent': defaultHeaders()['User-Agent'] }
  const feeds = [
    `https://github.com/${repo}/tags.atom`,
    `https://github.com/${repo}/releases.atom`,
  ]
  for (const feedUrl of feeds) {
    const feed = await fetchImpl(feedUrl, { timeoutMs, headers: feedHeaders })
    if (!feed.ok || feed.status !== 200) {
      log(`[github] feed 失败：${feed.error ?? `HTTP ${feed.status}`}（${feedUrl}）`)
      continue
    }
    const best = bestVersionFromTagList(parseAtomTitles(feed.text))
    if (best) {
      log(`[github] 最新 release（feed）：${best.tag}（${best.version}）`)
      return best
    }
    log(`[github] feed 没有匹配 dsh-v 前缀的条目（${feedUrl}）`)
  }
  log('[github] 所有来源均未找到可用 release')
  return null
}

/**
 * 合并 npm 与 GitHub 两侧的最新版本，选出候选：
 * - 只存在一侧时取该侧；
 * - 两侧都存在时取 semver 较大者；
 * - 相等时视为已同步（source 'both'）。
 * 两侧均接受纯版本字符串或 `{ version }` 形式的对象（latestGithubRelease 的返回形状）。
 * source：'npmOnly' | 'githubOnly' | 'both'；无任何有效版本返回 null。
 */
function pickUpdateCandidate(npmLatest, githubLatest) {
  const npmVersion = normalizeVersionInput(npmLatest)
  const githubVersion = normalizeVersionInput(githubLatest)
  const npmValid = parseVersion(npmVersion) ? npmVersion : null
  const githubValid = parseVersion(githubVersion) ? githubVersion : null
  if (!npmValid && !githubValid) return null
  if (!githubValid) return { version: npmValid, source: 'npmOnly' }
  if (!npmValid) return { version: githubValid, source: 'githubOnly' }
  const cmp = compareVersions(githubValid, npmValid)
  if (cmp > 0) return { version: githubValid, source: 'githubOnly' }
  if (cmp < 0) return { version: npmValid, source: 'npmOnly' }
  return { version: npmValid, source: 'both' }
}

/** 把版本字符串或 `{ version }` 对象归一化为字符串；无法归一化返回 null。 */
function normalizeVersionInput(input) {
  if (typeof input === 'string') return input
  if (input && typeof input === 'object' && typeof input.version === 'string') return input.version
  return null
}

module.exports = {
  GITHUB_API_BASE,
  DSH_REPO,
  RELEASE_TAG_PREFIX,
  parseReleaseTag,
  bestReleaseFromList,
  parseAtomTitles,
  bestVersionFromTagList,
  latestGithubRelease,
  resolveTagCommit,
  pickUpdateCandidate,
  fetchText,
  downloadFile,
  downloadSourceTarball,
}
