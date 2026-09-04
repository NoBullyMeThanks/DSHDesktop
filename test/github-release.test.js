'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const github = require('../src/github-release.js')

test('parseReleaseTag 解析官方 dsh-v 前缀 tag', () => {
  assert.equal(github.parseReleaseTag('dsh-v0.1.2-alpha.1'), '0.1.2-alpha.1')
  assert.equal(github.parseReleaseTag('dsh-v1.2.3'), '1.2.3')
  assert.equal(github.parseReleaseTag('dsh-v0.1.1-rc.2'), '0.1.1-rc.2')
})

test('parseReleaseTag 拒绝非 dsh-v 前缀与非法版本', () => {
  assert.equal(github.parseReleaseTag('vendor-cosmokit-v1.0.0'), null)
  assert.equal(github.parseReleaseTag('dsh-vgarbage'), null)
  assert.equal(github.parseReleaseTag('0.1.2-alpha.1'), null)
  assert.equal(github.parseReleaseTag(null), null)
  assert.equal(github.parseReleaseTag(42), null)
})

test('bestReleaseFromList 选择 dsh-v 前缀中 semver 最大者', () => {
  const list = [
    { tag_name: 'dsh-v0.1.0-rc.8', prerelease: true, published_at: '2026-08-19T15:37:57Z' },
    { tag_name: 'dsh-v0.1.1-rc.2', prerelease: true, published_at: '2026-08-21T12:35:08Z' },
    { tag_name: 'dsh-v0.1.2-alpha.1', prerelease: true, published_at: '2026-08-27T17:06:37Z' },
    { tag_name: 'vendor-cosmokit-v4.0.0', prerelease: false },
  ]
  const best = github.bestReleaseFromList(list)
  assert.equal(best.version, '0.1.2-alpha.1')
  assert.equal(best.tag, 'dsh-v0.1.2-alpha.1')
  assert.equal(best.publishedAt, '2026-08-27T17:06:37Z')
  assert.equal(best.prerelease, true)
})

test('bestReleaseFromList 忽略非法 tag 并处理空输入', () => {
  assert.equal(github.bestReleaseFromList([
    { tag_name: 'dsh-vgarbage' },
    { tag_name: 'not-a-tag' },
    { tag_name: 'dsh-v0.1.1-rc.2' },
  ]).version, '0.1.1-rc.2')
  assert.equal(github.bestReleaseFromList([]), null)
  assert.equal(github.bestReleaseFromList(null), null)
  assert.equal(github.bestReleaseFromList({}), null)
})

test('latestGithubRelease 成功时返回版本/tag/commit，并查询 releases 而非 latest', async () => {
  const urls = []
  const fetchImpl = async (url) => {
    urls.push(url)
    if (url.includes('/releases?per_page=')) {
      return { ok: true, status: 200, text: JSON.stringify([
        { tag_name: 'dsh-v0.1.2-alpha.1', prerelease: true, published_at: '2026-08-27T17:06:37Z' },
      ]) }
    }
    return { ok: true, status: 200, text: JSON.stringify({ object: { sha: 'abc123' } }) }
  }
  const result = await github.latestGithubRelease({ fetchImpl, log: () => {} })
  assert.equal(result.version, '0.1.2-alpha.1')
  assert.equal(result.tag, 'dsh-v0.1.2-alpha.1')
  assert.equal(result.commit, 'abc123')
  assert.ok(urls[0].match(/\/releases\?per_page=\d+/))
  assert.ok(urls.every((u) => u.startsWith('https://api.github.com/repos/')))
})

test('latestGithubRelease 在错误/限流/坏数据时返回 null', async () => {
  const cases = [
    { ok: false, error: '网络错误' },
    { ok: true, status: 404, text: '{"message":"Not Found"}' },
    { ok: true, status: 403, text: '{"message":"rate limit"}' },
    { ok: true, status: 429, text: '{"message":"rate limit"}' },
    { ok: true, status: 200, text: 'not json' },
    { ok: true, status: 200, text: '{"message":"Not Found"}' },
    { ok: true, status: 200, text: '[]' },
  ]
  for (const response of cases) {
    const result = await github.latestGithubRelease({ fetchImpl: async () => response, log: () => {} })
    assert.equal(result, null, `expect null for ${JSON.stringify(response).slice(0, 60)}`)
  }
})

const ATOM_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>tag:github.com,2008:Repository/1234</id>
    <title>dsh-v0.1.0-rc.7</title>
  </entry>
  <entry>
    <id>tag:github.com,2008:Repository/1235</id>
    <title>dsh-v0.1.1-rc.2</title>
  </entry>
  <entry>
    <id>tag:github.com,2008:Repository/1236</id>
    <title>dsh-v0.1.2-alpha.1</title>
  </entry>
  <entry>
    <id>tag:github.com,2008:Repository/1237</id>
    <title>vendor-cosmokit-v4.0.0</title>
  </entry>
</feed>`

test('parseAtomTitles 提取 <title> 并解码实体', () => {
  const titles = github.parseAtomTitles(ATOM_FIXTURE)
  assert.deepEqual(titles, ['dsh-v0.1.0-rc.7', 'dsh-v0.1.1-rc.2', 'dsh-v0.1.2-alpha.1', 'vendor-cosmokit-v4.0.0'])
  assert.deepEqual(github.parseAtomTitles('<title>dsh-v1.2.3 &amp; more</title>'), ['dsh-v1.2.3 & more'])
  assert.deepEqual(github.parseAtomTitles('not xml'), [])
  assert.deepEqual(github.parseAtomTitles(null), [])
})

test('bestVersionFromTagList 从 tag 名列表选最大者', () => {
  const best = github.bestVersionFromTagList(['dsh-v0.1.1-rc.2', 'dsh-v0.1.2-alpha.1', 'vendor-cosmokit-v4.0.0', 'garbage'])
  assert.equal(best.version, '0.1.2-alpha.1')
  assert.equal(best.tag, 'dsh-v0.1.2-alpha.1')
  assert.equal(best.publishedAt, null)
  assert.equal(best.commit, null)
  assert.equal(github.bestVersionFromTagList([]), null)
  assert.equal(github.bestVersionFromTagList(['vendor-cosmokit-v4.0.0']), null)
})

test('latestGithubRelease 在 API 不可达时回退到 tags.atom', async () => {
  const urls = []
  const fetchImpl = async (url) => {
    urls.push(url)
    if (url.includes('api.github.com') && url.includes('/releases?per_page=')) {
      return { ok: false, error: '网络错误' }
    }
    if (url.endsWith('/tags.atom')) {
      return { ok: true, status: 200, text: ATOM_FIXTURE }
    }
    return { ok: false, error: 'unexpected' }
  }
  const result = await github.latestGithubRelease({ fetchImpl, log: () => {} })
  assert.equal(result.version, '0.1.2-alpha.1')
  assert.equal(result.tag, 'dsh-v0.1.2-alpha.1')
  assert.equal(result.commit, null)
  assert.ok(urls.some((u) => u.endsWith('/tags.atom')))
})

test('latestGithubRelease 在 API 被限流时改走 feed；feed 也失败才返回 null', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('api.github.com')) return { ok: true, status: 403, text: '{"message":"rate limit"}' }
    return { ok: true, status: 200, text: ATOM_FIXTURE }
  }
  const result = await github.latestGithubRelease({ fetchImpl, log: () => {} })
  assert.equal(result.version, '0.1.2-alpha.1')
  const allFail = await github.latestGithubRelease({ fetchImpl: async () => ({ ok: false, error: 'X' }), log: () => {} })
  assert.equal(allFail, null)
})

test('resolveTagCommit 解析 git ref 返回 commit；失败返回 null', async () => {
  const ok = await github.resolveTagCommit('dsh-v0.1.2-alpha.1', {
    fetchImpl: async () => ({ ok: true, status: 200, text: JSON.stringify({ object: { sha: 'cd5ef8148158c3a752a658978873241fdf8e2bbc' } }) }),
  })
  assert.equal(ok, 'cd5ef8148158c3a752a658978873241fdf8e2bbc')
  assert.equal(await github.resolveTagCommit('dsh-v0.1.2-alpha.1', {
    fetchImpl: async () => ({ ok: true, status: 404, text: '{"message":"Not Found"}' }),
  }), null)
  assert.equal(await github.resolveTagCommit('dsh-v0.1.2-alpha.1', {
    fetchImpl: async () => ({ ok: false, error: '网络错误' }),
  }), null)
  assert.equal(await github.resolveTagCommit(null), null)
})

test('pickUpdateCandidate 合成两源候选', () => {
  assert.deepEqual(github.pickUpdateCandidate('0.1.1-rc.2', '0.1.2-alpha.1'), { version: '0.1.2-alpha.1', source: 'githubOnly' })
  assert.deepEqual(github.pickUpdateCandidate('0.1.2-alpha.1', '0.1.2-alpha.1'), { version: '0.1.2-alpha.1', source: 'both' })
  assert.deepEqual(github.pickUpdateCandidate('0.1.2-alpha.1', '0.1.1-rc.2'), { version: '0.1.2-alpha.1', source: 'npmOnly' })
  assert.deepEqual(github.pickUpdateCandidate('0.1.1-rc.2', null), { version: '0.1.1-rc.2', source: 'npmOnly' })
  assert.deepEqual(github.pickUpdateCandidate(null, '0.1.2-alpha.1'), { version: '0.1.2-alpha.1', source: 'githubOnly' })
  assert.equal(github.pickUpdateCandidate(null, null), null)
  assert.equal(github.pickUpdateCandidate('garbage', null), null)
  assert.deepEqual(github.pickUpdateCandidate('0.1.1-rc.2', 'garbage'), { version: '0.1.1-rc.2', source: 'npmOnly' })
})

test('pickUpdateCandidate 接受 latestGithubRelease 返回的对象形状（回归：对象不被当成无效输入）', () => {
  const form = {
    version: '0.1.2-alpha.1',
    tag: 'dsh-v0.1.2-alpha.1',
    commit: 'abc123',
    publishedAt: '2026-08-27T17:06:37Z',
    prerelease: true,
  }
  assert.deepEqual(github.pickUpdateCandidate('0.1.1-rc.2', form), { version: '0.1.2-alpha.1', source: 'githubOnly' })
  assert.deepEqual(github.pickUpdateCandidate('0.1.2-alpha.1', form), { version: '0.1.2-alpha.1', source: 'both' })
  assert.deepEqual(github.pickUpdateCandidate(null, form), { version: '0.1.2-alpha.1', source: 'githubOnly' })
  assert.deepEqual(github.pickUpdateCandidate('0.1.1-rc.2', { version: 'garbage' }), { version: '0.1.1-rc.2', source: 'npmOnly' })
  assert.equal(github.pickUpdateCandidate(null, { version: 'garbage' }), null)
})
