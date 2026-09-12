'use strict'

/**
 * 从 `npm install --loglevel=http` 的输出流里提取真实进度信号。
 *
 * npm 在 http 级别会逐条打印实际发生的网络请求，例如：
 *   npm http fetch GET 200 https://registry.npmjs.org/commander 319ms (cache revalidated)
 *   npm http fetch GET 200 https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.5-rc.2.tgz 1204ms (cache miss)
 *   npm http fetch POST 200 https://registry.npmjs.org/-/npm/v1/security/advisories/bulk 89ms
 *
 * 这些是**真实发生的动作**，可以据此展示「已获取 N 个包」这类事实性计数。
 * 注意：npm 不会输出依赖总数，因此模块**不推算百分比**——总包数未知，
 * 任何比例都会是编造的。百分比只由调用方在阶段真正完成时推进。
 *
 * 解析必须是流式的：chunk 边界可能把一行切断，因此保留半行缓冲。
 */
const LINE_BREAK_PATTERN = /\r?\n/
const FETCH_PATTERN = /npm http fetch (\w+) (\d{3}) (\S+)/
const TARBALL_PATTERN = /\/-\/([^/]+\.tgz)$/
/** npm 完成安装时的汇总行，例如：added 412 packages in 37s */
const SUMMARY_PATTERN = /^(added|removed|changed|up to date) .*?(?:in ([\d.]+)s|$)/
/** 首行错误码，用于把失败原因回显到启动窗口。 */
const ERROR_PATTERN = /^npm (?:error|ERR!) (.*)$/

function createNpmProgressReader() {
  let buffer = ''
  let tarballs = 0
  const seenTarballs = new Set()
  let metadataRequests = 0
  let summary = null
  let error = null

  function consumeLine(line) {
    if (!line) return
    const fetch = line.match(FETCH_PATTERN)
    if (fetch) {
      const [, method, , url] = fetch
      const tarball = url.match(TARBALL_PATTERN)
      if (tarball) {
        // 同一 tarball 可能因重试重复出现，按 URL 去重，保证计数是真实包数
        if (!seenTarballs.has(url)) {
          seenTarballs.add(url)
          tarballs += 1
        }
      } else if (method === 'GET') {
        metadataRequests += 1
      }
      return
    }
    const summaryMatch = line.match(SUMMARY_PATTERN)
    if (summaryMatch) {
      summary = line.trim()
      return
    }
    if (!error) {
      const errorMatch = line.match(ERROR_PATTERN)
      if (errorMatch) error = errorMatch[1].trim()
    }
  }

  return {
    /** 喂入原始输出片段（stdout/stderr 均调 onData）。 */
    push(chunk) {
      if (!chunk) return
      buffer += String(chunk)
      const lines = buffer.split(LINE_BREAK_PATTERN)
      buffer = lines.pop() ?? ''
      for (const line of lines) consumeLine(line.trim())
    },
    /** 流结束时调用：最后一行可能没有换行符，不能丢。 */
    flush() {
      if (!buffer) return
      const tail = buffer
      buffer = ''
      consumeLine(tail.trim())
    },
    snapshot() {
      return { tarballs, metadataRequests, summary, error }
    },
  }
}

module.exports = { createNpmProgressReader }
