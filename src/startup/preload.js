'use strict'

const { ipcRenderer } = require('electron')

let currentRequestId = null
let defaultActionId = null
let layoutFrame = null

function isValidState(state) {
  return state &&
    typeof state === 'object' &&
    (state.mode === 'loading' || state.mode === 'error') &&
    typeof state.title === 'string' &&
    typeof state.message === 'string'
}

function render(state) {
  if (!isValidState(state)) return

  document.documentElement.lang = state.locale === 'en' ? 'en' : 'zh-CN'
  document.documentElement.dataset.theme = state.theme === 'dark' ? 'dark' : 'light'
  document.documentElement.dataset.mode = state.mode

  const title = document.getElementById('title')
  const message = document.getElementById('message')
  const status = document.getElementById('status')
  const stage = document.getElementById('stage')
  const detail = document.getElementById('detail')
  const actions = document.getElementById('actions')

  title.textContent = state.title
  message.textContent = state.message
  currentRequestId = typeof state.id === 'string' ? state.id : null
  defaultActionId = null

  if (state.mode === 'loading') {
    status.hidden = false
    stage.textContent = typeof state.stage === 'string' ? state.stage : ''
    detail.hidden = true
    detail.textContent = ''
    actions.hidden = true
    actions.replaceChildren()
    reportLayout(state)
    return
  }

  status.hidden = true
  stage.textContent = ''
  detail.textContent = typeof state.detail === 'string' ? state.detail : ''
  detail.hidden = !detail.textContent
  actions.replaceChildren()

  const safeActions = Array.isArray(state.actions) ? state.actions : []
  for (const action of safeActions) {
    if (!action || typeof action.id !== 'string' || typeof action.label !== 'string') continue

    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.action = action.id
    button.dataset.kind = action.kind === 'primary' ? 'primary' : 'secondary'
    button.textContent = action.label
    if (action.default) defaultActionId = action.id
    button.addEventListener('click', () => sendAction(action.id))
    actions.append(button)
  }

  actions.hidden = actions.childElementCount === 0
  requestAnimationFrame(() => {
    const preferred = defaultActionId
      ? actions.querySelector(`[data-action="${CSS.escape(defaultActionId)}"]`)
      : actions.querySelector('button')
    preferred?.focus()
  })
  reportLayout(state)
}

function reportLayout(state) {
  if (layoutFrame) cancelAnimationFrame(layoutFrame)
  layoutFrame = requestAnimationFrame(() => {
    layoutFrame = null
    const card = document.querySelector('.window')
    if (!card || currentRequestId !== state.id) return
    ipcRenderer.send('splash:layout', {
      id: currentRequestId,
      mode: state.mode,
      height: measureNaturalCardHeight(card),
    })
  })
}

function measureNaturalCardHeight(card) {
  const cardRect = card.getBoundingClientRect()
  const style = getComputedStyle(card)
  const visibleContent = Array.from(card.querySelectorAll('.brand img, .content > *'))
    .filter((element) => !element.hidden)
  const contentBottom = visibleContent.reduce(
    (bottom, element) => Math.max(bottom, element.getBoundingClientRect().bottom),
    cardRect.top,
  )
  const paddingBottom = Number.parseFloat(style.paddingBottom) || 0
  const borderBottom = Number.parseFloat(style.borderBottomWidth) || 0
  return Math.ceil(contentBottom - cardRect.top + paddingBottom + borderBottom)
}

function sendAction(actionId) {
  if (!currentRequestId || typeof actionId !== 'string') return

  const buttons = document.querySelectorAll('#actions button')
  for (const button of buttons) button.disabled = true
  ipcRenderer.send('splash:action', {
    id: currentRequestId,
    action: actionId,
  })
}

ipcRenderer.on('splash:state', (_event, state) => render(state))

window.addEventListener('DOMContentLoaded', () => {
  ipcRenderer.send('splash:ready')
})

window.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && defaultActionId) {
    event.preventDefault()
    sendAction(defaultActionId)
  }
})
