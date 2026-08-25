'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createOperationLock } = require('../src/runtime-operation-lock.js')

test('操作进行期间拒绝并发请求并在完成后释放', async () => {
  let release
  const changes = []
  const lock = createOperationLock((busy, operation) => changes.push([busy, operation]))
  const first = lock.run('update', () => new Promise((resolve) => { release = resolve }))
  await Promise.resolve()

  const second = await lock.run('update', async () => true)
  assert.equal(second.accepted, false)
  assert.equal(second.activeOperation, 'update')
  assert.equal(lock.activeOperation(), 'update')

  release('done')
  const completed = await first
  assert.equal(completed.value, 'done')
  assert.equal(lock.activeOperation(), null)
  assert.deepEqual(changes, [[true, 'update'], [false, null]])
})

test('任务抛错后仍释放操作锁', async () => {
  const lock = createOperationLock()
  await assert.rejects(lock.run('update', async () => { throw new Error('failed') }), /failed/)
  assert.equal(lock.activeOperation(), null)
  const next = await lock.run('update', async () => true)
  assert.equal(next.accepted, true)
  assert.equal(next.value, true)
})
