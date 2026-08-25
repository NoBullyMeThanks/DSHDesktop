'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const resolver = require('../src/workspace-resolver.js')

/** 在临时目录里造一份 dsh 数据布局，返回 dshHome 路径。 */
function makeFakeDshHome(t, { workspaces = [], sessionDirs = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ws-test-'))
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })
  const dshHome = path.join(root, '.dsh')
  const sessionsRoot = path.join(dshHome, 'sessions')
  fs.mkdirSync(sessionsRoot, { recursive: true })
  if (Object.keys(workspaces).length > 0) {
    const tables = {}
    for (const [id, entry] of Object.entries(workspaces)) {
      tables[id] = entry
    }
    fs.mkdirSync(path.join(dshHome, 'storages'), { recursive: true })
    fs.writeFileSync(path.join(dshHome, 'storages', 'workspace.json'), JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: Object.keys(workspaces) },
      tables: { workspaces: tables },
    }))
  }
  for (const dir of sessionDirs) {
    fs.mkdirSync(path.join(sessionsRoot, dir), { recursive: true })
  }
  return { dshHome, sessionsRoot }
}

test('projectKey 与 dsh 的编码约定一致（分隔符合并/转义/包裹）', () => {
  assert.equal(resolver.projectKey('E:\\dsh-desktop'), '--E-dsh-desktop--')
  assert.equal(resolver.projectKey('E:\\DSH Desktop'), '--E-DSH~0020Desktop--')
  assert.equal(resolver.projectKey('E:/a//b'), '--E-a-b--')
  assert.equal(resolver.projectKey('C:'), '--C---') // 尾部分隔符不去除（与 dsh 一致，只去开头）
  assert.equal(resolver.projectKey(''), null)
  assert.equal(resolver.projectKey('~tmp'), '--~007Etmp--')
})

test('resolveWorkspace ①：最新会话目录 slug 与注册表编码比对命中', (t) => {
  const { dshHome, sessionsRoot } = makeFakeDshHome(t, {
    workspaces: {
      'ws-1': { path: 'E:\\old-project', title: 'old', updatedAt: '2026-01-01T00:00:00.000Z' },
      'ws-2': { path: 'E:\\dsh-desktop', title: 'dsh-desktop', updatedAt: '2026-01-02T00:00:00.000Z' },
    },
  })
  // 在 ws-2 的项目目录（--E-dsh-desktop--）里放一个 mtime 最新的会话文件
  const dir = path.join(sessionsRoot, '--E-dsh-desktop--')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'session-latest')
  fs.writeFileSync(file, '')
  const old = Date.now() - 10_000
  fs.utimesSync(file, new Date(old), new Date(old))
  assert.equal(resolver.resolveWorkspace({ dshHome, sessionsRoot }), 'E:\\dsh-desktop')
})

test('resolveWorkspace ②：无最新会话时取 updatedAt 最新', (t) => {
  const { dshHome, sessionsRoot } = makeFakeDshHome(t, {
    workspaces: {
      'ws-1': { path: 'E:\\old', title: 'old', updatedAt: '2026-01-01T00:00:00.000Z' },
      'ws-2': { path: 'E:\\new', title: 'new', updatedAt: '2026-03-01T00:00:00.000Z' },
    },
  })
  assert.equal(resolver.resolveWorkspace({ dshHome, sessionsRoot }), 'E:\\new')
})

test('resolveWorkspace ③：注册表损坏/缺失返回 null', (t) => {
  const { dshHome, sessionsRoot } = makeFakeDshHome(t, {})
  assert.equal(resolver.resolveWorkspace({ dshHome, sessionsRoot }), null)
})

test('resolveWorkspace：最新会话属于未注册项目时跳过比对走 updatedAt 兜底', (t) => {
  const { dshHome, sessionsRoot } = makeFakeDshHome(t, {
    workspaces: {
      'ws-1': { path: 'E:\\registered', title: 'registered', updatedAt: '2026-02-01T00:00:00.000Z' },
    },
  })
  // 未注册项目目录（_no-cwd 形态之外的自造目录）里放最新会话
  const dir = path.join(sessionsRoot, '--E-unregistered--')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session-latest'), '')
  assert.equal(resolver.resolveWorkspace({ dshHome, sessionsRoot }), 'E:\\registered')
})

test('resolveWorkspace：_no-cwd 会话目录不影响判定', (t) => {
  const { dshHome, sessionsRoot } = makeFakeDshHome(t, {
    workspaces: {
      'ws-1': { path: 'E:\\only', title: 'only', updatedAt: '2026-02-01T00:00:00.000Z' },
    },
    sessionDirs: ['_no-cwd'],
  })
  fs.writeFileSync(path.join(sessionsRoot, '_no-cwd', 'session-x'), '')
  assert.equal(resolver.resolveWorkspace({ dshHome, sessionsRoot }), 'E:\\only')
})
