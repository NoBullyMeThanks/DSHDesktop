'use strict'
/**
 * 终端面板的 Electron 集成冒烟（开发工具，不进打包）。
 *
 * 用法：node_modules\.bin\electron.cmd scripts/electron-terminal-smoke.js
 *
 * 与正式应用的区别：独立 userData（不占用单实例锁，可在打包版运行时并行验证）、
 * 主窗口只加载占位页面、不接入 DSH 页面。验证链路：
 *   showPanel → 宿主就绪 → 会话创建 → 面板页面输出渲染（文本 + 截图）→ 优雅关闭。
 */
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const { app, BrowserWindow, ipcMain, desktopCapturer } = require('electron')

// 必须在 app ready 之前 require：src/terminal/manager 模块加载时会注册 dsh-term scheme
const { createTerminalManager } = require(path.join(__dirname, '..', 'src', 'terminal', 'manager.js'))

// 独立 userData：避免与正式应用的 userData 目录和单实例锁冲突
app.setPath('userData', path.join(os.tmpdir(), 'dshdesktop-terminal-smoke'))

const ROOT = path.join(__dirname, '..')
const SCREENSHOT_PATH = path.join(ROOT, '.tmp', 'terminal-smoke-panel.png')
const LOG = []
let failures = 0

function appendLog(line) {
  LOG.push(line)
  process.stdout.write(`[smoke] ${line}\n`)
}

function pass(message) {
  process.stdout.write(`[PASS] ${message}\n`)
}

function fail(message) {
  failures += 1
  process.stdout.write(`[FAIL] ${message}\n`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 轮询等待日志中出现匹配行。 */
function waitForLog(pattern, timeoutMs, label) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (LOG.some((line) => pattern.test(line))) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error(`等待${label}超时`))
      setTimeout(tick, 200)
    }
    tick()
  })
}

/** 轮询等待面板页面输出文本满足条件（M3 起从 xterm 缓冲区取文本）。 */
async function waitForPanelText(panel, predicate, timeoutMs, label) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const text = await panel.webContents.executeJavaScript('window.__getTermText ? window.__getTermText() : ""')
      if (predicate(text)) return text
    } catch {}
    await sleep(200)
  }
  throw new Error(`等待${label}超时`)
}

/** 从主窗口 contentView 里找出终端面板视图（URL 以 panel/index.html 结尾，可能带查询参数）。 */
function findPanelView(win) {
  const children = win.contentView.children ?? []
  for (const child of children) {
    try {
      if (child.webContents && child.webContents.getURL().includes('panel/index.html')) return child
    } catch {}
  }
  return null
}

/** 轮询等待面板视图出现（loadFile 后 URL 需要一点时间才就位）。 */
async function waitForPanelView(win, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const view = findPanelView(win)
    if (view) return view
    await sleep(200)
  }
  return null
}

/** 从日志取最近一次「终端宿主已就绪（pid N）」的 pid。 */
function findHostPid() {
  const match = LOG.map((line) => line.match(/终端宿主已就绪（pid (\d+)）/)).filter(Boolean).pop()
  return match ? Number(match[1]) : null
}

async function main() {
  await app.whenReady()
  process.on('unhandledRejection', (reason) => {
    fail(`未处理的 Promise 拒绝：${reason && reason.stack ? reason.stack : reason}`)
  })
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // 探针 preload：模拟 DSH 页面的布局上报 + 捕获面板内缩，仅开发用
      preload: path.join(ROOT, '.tmp', 'terminal-smoke-probe-preload.js'),
    },
  })
  await win.loadURL('data:text/html,<html><body style="background:#151517"></body></html>')

  const manager = createTerminalManager({
    getMainWindow: () => win,
    getLocale: () => 'zh',
    getDockMode: () => 'bottom',
    setDockMode: () => {},
    appendLog,
  })
  manager.init()

  // ready 消息计数器（showPanel 之前注册，覆盖页面加载时的发送）
  let readyCount = 0
  ipcMain.on('terminal:ready', () => {
    readyCount += 1
    process.stdout.write(`[smoke-ipc] terminal:ready 计数 → ${readyCount}\n`)
  })

  // 面板资源错误记录（showPanel 之前注册，覆盖加载期请求）
  win.webContents.session.webRequest.onErrorOccurred((details) => {
    if (String(details.url).includes('dsh-term')) {
      fail(`面板资源请求失败：${details.error}: ${details.url}`)
    }
  })

  /** 面板 bounds 断言辅助。 */
  async function assertBounds(expect, label) {
    const b = findPanelView(win)?.getBounds()
    const ok = b && b.x === expect.x && b.y === expect.y && b.width === expect.width && b.height === expect.height
    if (ok) pass(`面板 bounds ${label}：${expect.width}x${expect.height} @(${expect.x},${expect.y})`)
    else fail(`面板 bounds ${label} 不符：实际 ${JSON.stringify(b)}，期望 ${JSON.stringify(expect)}`)
    return b
  }

  // 1. 打开面板
  const shown = manager.showPanel()
  if (shown) pass('showPanel() 返回 true')
  else fail('showPanel() 返回 false')

  // 2. 面板页面诊断：加载事件、bridge、页面 ready 发送侧标记
  const panel = await waitForPanelView(win, 10_000)
  if (panel) {
    pass('找到面板 WebContentsView')
    panel.webContents.on('did-fail-load', (_e, code, desc, url) => {
      fail(`面板资源加载失败（${code}）${desc}: ${url}`)
    })
    panel.webContents.on('console-message', (_e, _level, message) => {
      process.stdout.write(`[panel-console] ${message}\n`)
    })
    panel.webContents.on('render-process-gone', (_e, details) => {
      fail(`渲染进程异常：${JSON.stringify(details)}`)
    })
    await sleep(800)
    const bounds = panel.getBounds()
    if (bounds.width > 0 && bounds.height > 0) {
      pass(`面板 bounds 正常：${bounds.width}x${bounds.height} @(${bounds.x},${bounds.y})`)
    } else {
      fail(`面板 bounds 为零（${JSON.stringify(bounds)}），将不可见`)
    }
    const pageState = await panel.webContents.executeJavaScript(`({
      readySent: window.__readySent === true,
      bridge: typeof window.__terminalBridge,
      xterm: typeof window.Terminal,
      fit: typeof window.FitAddon,
      clipboard: typeof window.ClipboardAddon,
      scripts: document.scripts.length,
      status: document.getElementById('status') ? document.getElementById('status').textContent : '(no status)',
    })`)
    process.stdout.write(`[smoke-ipc] 页面状态：${JSON.stringify(pageState)}\n`)
    // 诊断：viewport 背景必须随主题（xterm.css 缺省纯黑会在屏幕层下方露出黑色横条）
    const vpBg = await panel.webContents.executeJavaScript(`(() => {
      const vp = document.querySelector('.xterm-viewport')
      return vp ? getComputedStyle(vp).backgroundColor : 'no-viewport'
    })()`)
    if (vpBg === 'rgb(0, 0, 0)') fail(`viewport 背景仍为纯黑：${vpBg}`)
    else if (vpBg === 'no-viewport') fail('未找到 .xterm-viewport')
    else pass(`viewport 背景已主题化：${vpBg}`)

    // 2.5 停靠与布局联动：模拟 DSH 页面布局上报 → 面板贴齐会话区域
    const [cw, ch] = win.getContentSize()
    const panelH = Math.min(Math.max(Math.round(ch * 0.35), 160), Math.round(ch * 0.7))
    const panelW = Math.round(Math.min(Math.max(cw * 0.35, 320), cw * 0.6))
    // headerBottom=70：右侧面板顶边 y = max(28, 70-1) = 69（面板顶边线与标题区底边线重合）
    await win.webContents.executeJavaScript(`window.__probe.sendLayout({ sidebarRight: 240, contentRight: ${cw}, headerBottom: 70 })`)
    await sleep(300)
    await assertBounds({ x: 240, y: ch - panelH, width: cw - 240, height: panelH }, '贴齐会话区域')
    manager.setDock('right')
    await sleep(300)
    await assertBounds({ x: cw - panelW, y: 69, width: panelW, height: ch - 69 }, '右侧停靠（面板顶边线与标题区底边线重合）')
    // 右停靠时面板左侧应有 1px 边界线（与 DSH 内容区分开）。
    // 分数缩放显示下渲染器可能把 1px 折算成 0.67px 之类的小数值
    // （仍是 1 物理像素的线），只断言「明显非零」并输出原始值供诊断。
    const borderInfo = await panel.webContents.executeJavaScript(`(() => ({
      width: getComputedStyle(document.body).borderLeftWidth,
      dpr: window.devicePixelRatio,
      zoom: window.visualViewport ? window.visualViewport.scale : null,
    }))()`)
    const borderPx = Number.parseFloat(borderInfo.width)
    if (borderPx > 0.4) pass(`右侧停靠：面板左边界线已渲染（${borderInfo.width}，dpr=${borderInfo.dpr}）`)
    else fail(`右侧停靠：面板左边界线宽度异常：${JSON.stringify(borderInfo)}`)
    const insetRight = await win.webContents.executeJavaScript('({ b: Number(document.body.dataset.insetBottom || "0"), r: Number(document.body.dataset.insetRight || "0") })')
    if (insetRight.r === panelW && insetRight.b === 0) pass(`右侧内缩已下发：right=${panelW}px`)
    else fail(`右侧内缩值不符：${JSON.stringify(insetRight)}，期望 right=${panelW},bottom=0`)
    // 拖动调整：右侧停靠的拖动条在面板左缘——向右拖 = 左缘右移 = 面板变窄（边缘跟随光标）
    await panel.webContents.executeJavaScript('window.__terminalBridge.panelResize({ dx: 60, dy: 0 })')
    await sleep(300)
    await assertBounds({ x: cw - (panelW - 60), y: 69, width: panelW - 60, height: ch - 69 }, '右侧拖动调整宽度')
    await panel.webContents.executeJavaScript('window.__terminalBridge.panelResize({ dx: -60, dy: 0 })')
    await sleep(300)
    manager.setDock('bottom')
    await sleep(300)
    await assertBounds({ x: 240, y: ch - panelH, width: cw - 240, height: panelH }, '恢复底部停靠')
    // 拖动调整：底部停靠的拖动条在面板顶缘——向上拖 = 顶缘上移 = 面板增高（边缘跟随光标）
    await panel.webContents.executeJavaScript('window.__terminalBridge.panelResize({ dx: 0, dy: -80 })')
    await sleep(300)
    await assertBounds({ x: 240, y: ch - (panelH + 80), width: cw - 240, height: panelH + 80 }, '底部拖动调整高度')
    await panel.webContents.executeJavaScript('window.__terminalBridge.panelResize({ dx: 0, dy: 80 })')
    await sleep(300)
    const inset = await win.webContents.executeJavaScript('({ b: Number(document.body.dataset.insetBottom || "0"), r: Number(document.body.dataset.insetRight || "0") })')
    if (inset.b === panelH && inset.r === 0) pass(`面板内缩已下发：bottom=${inset.b}px`)
    else fail(`面板内缩值不符：${JSON.stringify(inset)}，期望 bottom=${panelH},right=0`)
  } else {
    fail('未找到面板 WebContentsView')
  }

  // 3. 面板自动建会话
  await waitForLog(/会话 [0-9a-f-]+ 已创建/, 20_000, '会话创建').then(
    () => pass('会话已自动创建'),
    (err) => fail(err.message),
  )

  // 4. 等待 PowerShell 提示符输出渲染到面板页面
  const panel2 = findPanelView(win)
  if (!panel2) {
    fail('未找到面板 WebContentsView')
  } else {
    const text = await waitForPanelText(
      panel2,
      (t) => t.includes('PS ') || t.includes('>'),
      30_000,
      'PowerShell 提示符',
    ).then(
      (t) => { pass(`面板已渲染 shell 输出（${t.slice(0, 60).replace(/\s+/g, ' ')}…）`); return t },
      (err) => { fail(err.message); return '' },
    )
    if (text) {
      // 4.5 真实键盘输入链路：字符事件 → xterm onData → IPC → PTY → 输出回显
      const typed = 'write-output m3smokeok'
      for (const ch of typed) {
        panel2.webContents.sendInputEvent({ type: 'char', keyCode: ch })
      }
      panel2.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
      panel2.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
      await waitForPanelText(
        panel2,
        (t) => t.includes('m3smokeok'),
        20_000,
        '键盘输入回显',
      ).then(
        () => pass('键盘输入链路正常（字符事件 → xterm → PTY → 回显）'),
        (err) => fail(err.message),
      )

      // 隐藏窗口里 capturePage 不稳定（偶发 display surface 不可用 / UnknownVizError），
      // 截图期间临时显示窗口，面板/主窗口截图都在显示状态下完成；截图本身加短重试，
      // 避免偶发合成器抖动把整轮冒烟判红（画面内容断言不依赖这一张图）。
      fs.mkdirSync(path.dirname(SCREENSHOT_PATH), { recursive: true })
      win.show()
      await sleep(800)
      const captureWithRetry = async (fn, label, retries = 3) => {
        let lastErr = null
        for (let attempt = 0; attempt < retries; attempt++) {
          try {
            return await fn()
          } catch (err) {
            lastErr = err
            process.stdout.write(`[smoke-ipc] ${label} 第 ${attempt + 1} 次失败：${err.message}，重试\n`)
            await sleep(800)
          }
        }
        throw lastErr
      }
      try {
        const image = await captureWithRetry(() => panel2.webContents.capturePage(), '面板截图')
        fs.writeFileSync(SCREENSHOT_PATH, image.toPNG())
        pass(`面板截图已保存：${SCREENSHOT_PATH}`)
      } catch (err) {
        fail(`面板截图失败：${err.message}`)
      }
      // 主窗口合成截图：面板应盖在主内容底部（验证视图层叠顺序）。
      // webContents.capturePage 拿不到子视图合成结果，改用 desktopCapturer 截真实窗口；
      // 合成器偶发抖动会返回黑色缩略图，采样失败时整体重试（最多 3 轮）。
      const expectedBg = await panel2.webContents.executeJavaScript(`(() => {
        const s = getComputedStyle(document.getElementById('stage')).backgroundColor
        const m = s.match(/rgba?\\((\\d+), (\\d+), (\\d+)/)
        return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [255, 255, 255]
      })()`)
      let compositeOk = false
      let lastPixel = '采集失败'
      let lastCaptureBlack = true // 最近一轮采样是否为全黑帧（采集失败特征）
      for (let attempt = 0; attempt < 3 && !compositeOk; attempt++) {
        lastCaptureBlack = true
        try {
          const sources = await desktopCapturer.getSources({
            types: ['window'],
            thumbnailSize: { width: 1200, height: 800 },
          })
          const source = sources.find((s) => s.id === `window:${win.id}`)
          if (source && !source.thumbnail.isEmpty()) {
            const mainPath = SCREENSHOT_PATH.replace('panel.png', 'main.png')
            fs.writeFileSync(mainPath, source.thumbnail.toPNG())
            // 像素级验证：底部 10% 区域应为面板的主题背景色（主内容冒烟页是深色 #151517）
            const size = source.thumbnail.getSize()
            const bitmap = source.thumbnail.toBitmap() // BGRA
            if (size.width > 0 && bitmap && bitmap.length > 0) {
              const sampleX = Math.floor(size.width / 2)
              const sampleY = Math.floor(size.height * 0.9)
              const idx = (sampleY * size.width + sampleX) * 4
              const [b, g, r] = [bitmap[idx], bitmap[idx + 1], bitmap[idx + 2]]
              lastPixel = `RGB ${r},${g},${b}`
              // 全黑帧 = 桌面采集失败（黑缩略图），不算「真实内容不匹配」
              lastCaptureBlack = r === 0 && g === 0 && b === 0 && idx + 2 < bitmap.length
              const near = (a, b2) => Math.abs(a - b2) <= 4
              compositeOk = !lastCaptureBlack && near(r, expectedBg[0]) && near(g, expectedBg[1]) && near(b, expectedBg[2])
            }
          } else {
            // 严格按窗口 id 匹配源（绝不回退到 sources[0]：可能采到用户的其他窗口，
            // 造成与产品无关的误报）；找不到本窗口 = 采不到，按环境跳过处理
            lastPixel = `未找到窗口源 window:${win.id}（共 ${sources.length} 个源：${sources.map((s) => s.id).join(', ')}）`
            lastCaptureBlack = true
          }
          if (!lastCaptureBlack && !compositeOk) {
            process.stdout.write(`[smoke-ipc] 主窗口合成截图第 ${attempt + 1} 次采样 ${lastPixel}，不匹配期望 ${expectedBg.join(',')}，重试\n`)
            await sleep(800)
          }
        } catch (err) {
          lastPixel = `异常：${err.message}`
          process.stdout.write(`[smoke-ipc] 主窗口截图第 ${attempt + 1} 次失败：${err.message}，重试\n`)
          await sleep(800)
        }
      }
      if (compositeOk) {
        pass(`主窗口合成截图已保存（底部像素 ${lastPixel}，期望 ${expectedBg.join(',')}），面板已合成`)
      } else if (lastCaptureBlack) {
        // 桌面采集始终返回黑帧/空图：环境限制（远程会话/显示器休眠等），
        // 面板合成已由 bounds/面板截图断言覆盖，此项记环境跳过而非产品失败
        process.stdout.write(`[smoke-ipc] 桌面采集不可用（${lastPixel}），跳过合成像素断言（非产品失败）\n`)
        pass('主窗口合成：桌面采集不可用，跳过像素断言（环境限制，非产品失败）')
      } else {
        fail(`主窗口底部像素不符：${lastPixel}，期望 ${expectedBg.join(',')}，面板可能未合成`)
      }
      win.hide()
    }
  }

  // 5. 关闭面板（会话保留）
  manager.hidePanel()
  pass('hidePanel() 完成（会话保留）')
  const insetAfterHide = await win.webContents.executeJavaScript('({ b: Number(document.body.dataset.insetBottom || "0"), r: Number(document.body.dataset.insetRight || "0") })')
  if (insetAfterHide.b === 0 && insetAfterHide.r === 0) pass('隐藏面板后内缩归零')
  else fail(`隐藏面板后内缩未归零：${JSON.stringify(insetAfterHide)}`)

  // 5.0 页面浮层（设置面板/弹窗）→ 自动收起 → 关闭后自动恢复
  manager.showPanel()
  await sleep(400)
  if (manager.isPanelVisible()) {
    await win.webContents.executeJavaScript('window.__probe.sendOverlay({ overlay: true })')
    await sleep(400)
    if (!manager.isPanelVisible()) pass('页面浮层出现：终端面板自动收起')
    else fail('页面浮层出现：面板未自动收起')
    const insetDuringOverlay = await win.webContents.executeJavaScript('Number(document.body.dataset.insetBottom || "0")')
    if (insetDuringOverlay === 0) pass('浮层期间面板内缩归零')
    else fail(`浮层期间内缩未归零：${insetDuringOverlay}`)
    await win.webContents.executeJavaScript('window.__probe.sendOverlay({ overlay: false })')
    await sleep(400)
    if (manager.isPanelVisible()) pass('页面浮层关闭：终端面板自动恢复')
    else fail('页面浮层关闭：面板未自动恢复')
  } else {
    fail('浮层测试前置失败：面板未显示')
  }
  manager.hidePanel()

  // 5.5 会话退出 → 重新打开链路（键盘 exit → 退出态 → 点重新打开 → 新会话 + 提示符）
  manager.showPanel()
  await sleep(500)
  const panel3 = findPanelView(win)
  if (panel3) {
    for (const ch of 'exit') {
      panel3.webContents.sendInputEvent({ type: 'char', keyCode: ch })
    }
    panel3.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    panel3.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    // 退出态：pane 内退出条出现（PowerShell 退出耗时不定，轮询）
    let exited = false
    const exitDeadline = Date.now() + 15_000
    while (Date.now() < exitDeadline) {
      exited = await panel3.webContents.executeJavaScript('window.__getTermState().exited')
      if (exited) break
      await sleep(300)
    }
    if (exited) pass('会话退出后进入退出态（重新打开按钮可见）')
    else fail('会话退出后未进入退出态')
    // 点重新打开（pane 内退出条按钮）→ 新会话
    await panel3.webContents.executeJavaScript('document.querySelector(".term-pane.exited .term-exitbar button").click()')
    await waitForPanelText(
      panel3,
      (t) => t.includes('PS ') || t.includes('>'),
      30_000,
      '重新打开后的提示符',
    ).then(
      () => pass('会话退出后重新打开成功（新会话 + 提示符）'),
      (err) => fail(err.message),
    )
    // 清理重开前的退出态 pane，恢复单会话基线
    await panel3.webContents.executeJavaScript(`(() => {
      const items = document.querySelectorAll('.session-item.exited')
      if (items.length) items[items.length - 1].querySelector('.sclose').click()
    })()`)
    const cleanDeadline = Date.now() + 15_000
    let cleaned = false
    while (Date.now() < cleanDeadline) {
      const state = await panel3.webContents.executeJavaScript('window.__getTermState()')
      if (state.panes.length === 1) { cleaned = true; break }
      await sleep(300)
    }
    if (!cleaned) fail('清理退出态 pane 失败，跳过多终端测试')
    // 5.55 多终端管理：新建 → 两个 pane → 切换 → 重命名 → 关闭
    const paneCountBefore = cleaned ? await panel3.webContents.executeJavaScript('window.__getTermState().panes.length') : 0
    if (paneCountBefore === 1) {
      await panel3.webContents.executeJavaScript('document.getElementById("newBtn").click()')
      await waitForPanelText(
        panel3,
        (t) => t.includes('PS ') || t.includes('>'),
        30_000,
        '第二个会话提示符',
      ).then(
        () => pass('新建终端成功（第二个会话出现）'),
        (err) => fail(err.message),
      )
      const multi = await panel3.webContents.executeJavaScript('window.__getTermState()')
      if (multi.panes.length === 2) pass('管理区显示两个终端')
      else fail(`管理区终端数量不符：${multi.panes.length}`)
      // 关闭按钮应为 Bootstrap 垃圾桶（viewBox 0 0 16 16，填充式、无描边；
      // 注意 computed fill 会把 currentColor 解析为实际颜色，只断言非 none/无描边）
      const scloseSvg = await panel3.webContents.executeJavaScript(`(() => {
        const svg = document.querySelector('.session-item .sclose svg')
        if (!svg) return null
        const s = getComputedStyle(svg)
        return { viewBox: svg.getAttribute('viewBox'), fill: s.fill, stroke: s.stroke }
      })()`)
      if (scloseSvg && scloseSvg.viewBox === '0 0 16 16' && scloseSvg.fill !== 'none' && scloseSvg.stroke === 'none') pass('关闭按钮已替换为垃圾桶图标（bi-trash）')
      else fail(`关闭按钮图标不符：${JSON.stringify(scloseSvg)}`)
      // 切回第一个会话
      await panel3.webContents.executeJavaScript(`(() => {
        const list = document.querySelectorAll('.session-item')
        list[0] && list[0].click()
      })()`)
      await sleep(500)
      const switched = await panel3.webContents.executeJavaScript('window.__getTermState()')
      if (switched.active === multi.panes[0]) pass('切换到第一个终端成功')
      else fail(`切换失败：active=${switched.active}`)
      // 重命名第一个会话
      await panel3.webContents.executeJavaScript(`(() => {
        const item = document.querySelectorAll('.session-item')[0]
        const nameEl = item.querySelector('.sname')
        nameEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      })()`)
      await sleep(300) // 编辑态重渲染
      await panel3.webContents.executeJavaScript(`(() => {
        const item = document.querySelectorAll('.session-item')[0]
        const input = item.querySelector('.sname-input')
        if (!input) return
        input.value = 'dev-shell'
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })()`)
      await sleep(500)
      const renamed = await panel3.webContents.executeJavaScript(`(() => {
        const item = document.querySelectorAll('.session-item')[0]
        return item ? item.querySelector('.sname').textContent : ''
      })()`)
      if (renamed === 'dev-shell') pass('会话重命名成功（dev-shell）')
      else fail(`重命名结果不符：${renamed}`)
      // 真正关闭第二个会话 → 列表剩 1
      await panel3.webContents.executeJavaScript(`(() => {
        const items = document.querySelectorAll('.session-item')
        const closeBtn = items[items.length - 1].querySelector('.sclose')
        closeBtn.click()
      })()`)
      const closeDeadline = Date.now() + 15_000
      let closed = false
      while (Date.now() < closeDeadline) {
        const state = await panel3.webContents.executeJavaScript('window.__getTermState()')
        if (state.panes.length === 1) { closed = true; break }
        await sleep(300)
      }
      if (closed) pass('真正关闭终端成功（列表移除、资源释放）')
      else fail('关闭终端后列表未收敛')
    } else {
      fail(`多终端测试前置失败：pane 数=${paneCountBefore}`)
    }
    // 5.6 宿主崩溃 → 面板错误态 → 重新拉起宿主与会话
    const hostPidBefore = findHostPid()
    if (hostPidBefore) {
      spawnSync('taskkill', ['/pid', String(hostPidBefore), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      await waitForLog(/终端宿主退出/, 15_000, '宿主退出').then(
        () => pass('宿主进程被终止后主进程收到通知'),
        (err) => fail(err.message),
      )
      let down = false
      const downDeadline = Date.now() + 10_000
      while (Date.now() < downDeadline) {
        // 宿主崩溃 → 会话列表清空 → pane 全部移除
        down = await panel3.webContents.executeJavaScript('window.__getTermState().panes.length === 0')
        if (down) break
        await sleep(300)
      }
      if (down) pass('宿主崩溃后面板进入错误态')
      else fail('宿主崩溃后面板未进入错误态')
      await panel3.webContents.executeJavaScript('document.getElementById("newBtn").click()')
      await waitForLog(/会话 [0-9a-f-]+ 已创建/, 30_000, '宿主重启后的会话').then(
        () => pass('宿主崩溃后重新拉起成功（新宿主 + 新会话）'),
        (err) => fail(err.message),
      )
      await waitForPanelText(
        panel3,
        (t) => t.includes('PS ') || t.includes('>'),
        30_000,
        '重启后的提示符',
      ).then(
        () => pass('重启后终端恢复正常交互'),
        (err) => fail(err.message),
      )
    } else {
      fail('无法从日志定位宿主 pid，跳过崩溃重启验证')
    }
    const hostPidAfter = findHostPid()
    process.stdout.write(`[smoke-ipc] 宿主 pid ${hostPidBefore} -> ${hostPidAfter}\n`)
  } else {
    fail('重新打开面板后未找到面板视图')
  }

  // 5.65 首启右停靠回归：重载面板页模拟「首次启动即右停靠」——页面就绪后主进程
  // 补发的 dock-state 应让布局直接为右停靠（面板顶部不再出现水平拖动条）
  manager.setDock('right')
  await sleep(300)
  await panel3.webContents.reload()
  await sleep(1500)
  const dockAfterReload = await panel3.webContents.executeJavaScript('document.body.dataset.dock')
  if (dockAfterReload === 'right') pass('首启右停靠：页面重载后布局立即为右停靠')
  else fail(`重载后 data-dock=${dockAfterReload}，期望 right`)
  const resizeHShown = await panel3.webContents.executeJavaScript(`(() => {
    const el = document.getElementById('resizeH')
    return el ? getComputedStyle(el).display !== 'none' : true
  })()`)
  if (!resizeHShown) pass('右停靠：顶部水平拖动条已隐藏')
  else fail('右停靠：顶部水平拖动条仍显示（首启场景）')
  manager.setDock('bottom')
  await sleep(300)

  manager.hidePanel()

  // 6. 优雅关闭宿主 + 无孤儿进程复查
  const lastHostPid = findHostPid()
  await manager.shutdown().then(
    () => pass('shutdown() 完成，宿主已关闭'),
    (err) => fail(`shutdown() 失败：${err.message}`),
  )
  await sleep(500)
  if (lastHostPid) {
    try {
      process.kill(lastHostPid, 0)
      fail(`退出后宿主进程仍存活（pid ${lastHostPid}）`)
    } catch {
      pass('退出后宿主进程已结束（无孤儿进程）')
    }
  } else {
    fail('无法定位宿主 pid，未做孤儿进程复查')
  }
  await sleep(300)
  app.quit()
}

main().catch((err) => {
  failures += 1
  process.stdout.write(`[FAIL] 冒烟异常：${err.stack || err}\n`)
  app.exit(1)
})

app.on('quit', () => {
  if (failures === 0) {
    process.stdout.write('[smoke] 全部通过 ✓\n')
  } else {
    process.stdout.write(`[smoke] 失败 ${failures} 项 ✗\n`)
    process.exitCode = 1
  }
})
