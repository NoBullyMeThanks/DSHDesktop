'use strict'
/**
 * 终端面板页面的 preload：把主进程的终端通道包装成页面可见的窄接口。
 * 页面是本地 file://，沙箱内运行；不向页面暴露任何 Electron API。
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('__terminalBridge', {
  /** 页面加载完成，请求初始状态（主题 + 自动建会话）。 */
  ready: () => ipcRenderer.send('terminal:ready'),
  /** 请求新建会话（会话退出后重新打开）。 */
  spawn: () => ipcRenderer.send('terminal:spawn'),
  /** 把用户输入写入会话（明文文本，base64 编解码收敛在主进程侧）。 */
  sendInput: (sessionId, text) => ipcRenderer.send('terminal:data', { sessionId, text }),
  /** 上报终端尺寸变化（M3 由 xterm fit 驱动）。 */
  resize: (sessionId, cols, rows) => ipcRenderer.send('terminal:resize', { sessionId, cols, rows }),
  /** 结束当前会话。 */
  kill: (sessionId) => ipcRenderer.send('terminal:kill', { sessionId }),
  /** 切换停靠模式（'bottom' | 'right'）。 */
  setDock: (mode) => ipcRenderer.send('terminal:set-dock', mode),
  /** 激活指定会话（多终端切换）。 */
  activate: (sessionId) => ipcRenderer.send('terminal:activate', { sessionId }),
  /** 重命名会话。 */
  rename: (sessionId, name) => ipcRenderer.send('terminal:rename', { sessionId, name }),
  /** 面板拖动调整（相对增量，主进程按停靠模式应用）。 */
  panelResize: (payload) => ipcRenderer.send('terminal:panel-resize', payload),
  /** 请求主进程收起面板（标题栏关闭按钮）。 */
  togglePanel: () => ipcRenderer.send('terminal:toggle-panel'),
  /** 订阅主进程事件；返回取消订阅函数。 */
  on: (channel, callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
})
