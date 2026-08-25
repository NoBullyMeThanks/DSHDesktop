'use strict'

/**
 * 创建一个单操作互斥锁。第二个操作不会排队，调用方可立即保持当前 UI 不变。
 * onChange 用于同步托盘等外部状态，不参与锁的正确性。
 */
function createOperationLock(onChange = () => {}) {
  let activeOperation = null

  function notify(busy, operation) {
    try { onChange(busy, operation) } catch {}
  }

  return {
    activeOperation: () => activeOperation,
    async run(operation, task) {
      if (activeOperation) {
        return { accepted: false, activeOperation, value: false }
      }

      activeOperation = operation
      notify(true, operation)
      try {
        return { accepted: true, activeOperation: operation, value: await task() }
      } finally {
        activeOperation = null
        notify(false, null)
      }
    },
  }
}

module.exports = { createOperationLock }
