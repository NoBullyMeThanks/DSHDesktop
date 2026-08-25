# 内嵌终端（Embedded Terminal）实施方案

> 状态：**全部完成（M1–M4）并已提交** `ca2461d feat: 内嵌终端面板`
> 目录说明：M4 之后的目录重构（避免终端文件散落在项目根）——应用源码已整体收拢到 `src/`：
> 主进程模块（manager/host-client/utils/pty-host）位于 `src/terminal/`，面板页面与资源位于
> `src/terminal/panel/`（index.html、renderer.js、preload.js、assets/），主进程入口 `src/main.js`、
> DSH 页面 preload `src/preload.js`；本文档除「当前状态」章节外沿用重构前的文件名。
> 目标：像 VS Code 一样在 DSH Desktop 窗口内直接打开一个底部终端面板，运行 PowerShell，默认工作目录为当前 DSH 工作区。

## 1. 已确认决策

| 决策点 | 结论 |
|---|---|
| 前端渲染 | xterm.js（`@xterm/xterm` + `@xterm/addon-fit`，VS Code 同款，MIT） |
| 后端 PTY | node-pty（Windows 走 ConPTY，VS Code 同款） |
| PTY 宿主位置 | **系统 Node 宿主进程**（方案 1）：node-pty 装在 `~/.dshdesktop` 运行时目录，Electron 包保持 100% 纯 JS |
| 面板形态 | 主窗口 `WebContentsView` 底部面板，覆盖 DSH 页面底部（DSH 页面零改动） |
| 默认 shell | PowerShell（探测顺序：`pwsh` → `powershell.exe` → `cmd.exe`） |
| 默认工作目录 | 用户主目录（`os.homedir()`） |
| 入口 | `Ctrl+\`` 快捷键 + 窗口控件区「终端」按钮，可选托盘项 |

## 2. 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│ BrowserWindow（隐藏标题栏）                                   │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  DSH 页面（主 webContents，http://127.0.0.1:PORT）     │  │
│  │  内容铺满窗口，未被面板覆盖的区域保持可交互               │  │
│  └───────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  WebContentsView 终端面板（file://，sandbox）           │  │
│  │  src/terminal/panel/index.html + xterm.js + preload.js │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘

渲染层（src/terminal/panel）      主进程（Electron）              宿主（系统 Node）
┌──────────────────┐   IPC   ┌──────────────────┐   stdio   ┌──────────────────┐
│ xterm.js         │ ⇄dsh:   │ src/terminal/    │ JSON Lines │ src/terminal/    │
│ fit/resize/主题   │ terminal│ manager.js       │ ⇄         │ pty-host.js      │
│ 输入转发/输出渲染  │ -* 通道 │ 面板生命周期/校验  │           │ node-pty 会话     │
└──────────────────┘         └──────────────────┘           └──────────────────┘
```

三层职责：

- **UI 层**：本地 `src/terminal/panel/index.html`（`file://` 加载，`sandbox: true`、`contextIsolation: true`），只做终端渲染与输入转发，不接触任何 Electron API。
- **桥接层**：`src/terminal/manager.js`（主进程）管理面板视图、会话表、IPC 来源校验、窗口 resize 联动、退出清理。
- **PTY 层**：`src/terminal/pty-host.js`（跑在系统 Node ≥ 22.19 上）持有 node-pty 会话，通过 JSON Lines over stdio 与主进程通信。

## 3. 组件设计

### 3.1 src/terminal/pty-host.js（系统 Node 侧，新增文件）

**安装与加载**

- `pty-host.js` 是纯 JS 源码，随应用打包（加入 electron-builder `files`），**本身不含 node-pty 代码**。
- node-pty 以 npm 包形式装进运行时目录：`~/.dshdesktop/pty-host/`（`npm install node-pty@<锁定版本> --prefix <该目录>`），版本号常量写在 `pty-host.js` 顶部并注明升级步骤。**注意 npm 11 的 allow-scripts 机制**：node-pty 的安装脚本（下载预编译二进制）默认被拦截，装完需执行 `npm approve-scripts node-pty --prefix <该目录>`，或在托管 package.json 里预写 `"allowScripts": {"node-pty@<版本>": true}`（M1 实测：`npm approve-scripts` 会把这个字段写进 package.json，自动安装器要复刻这一步）。
- `pty-host.js` 通过绝对路径 `require` 加载 node-pty（避免依赖 `NODE_PATH` 的隐式行为），找不到时输出明确错误。
- 首次打开终端时才执行 `ensurePtyHost()`（懒安装，不增加首启负担）；失败时面板内显示错误 + 「打开日志」按钮。安装逻辑沿用 `runtime-manager.js` 的 npm 执行与日志模式，并纳入 `runtime.killActiveChildren` 清理范围。
- 离线场景：与 dsh runtime 首次安装行为一致——装不上则终端不可用，其余功能不受影响。

**stdio 协议（JSON Lines）**

`main → host`（host 的 stdin）：

```jsonc
{"id":1,"type":"spawn","sessionId":"<uuid>","shell":"powershell","cwd":"C:\\Users\\x","cols":120,"rows":30,"env":{...}}
{"id":2,"type":"write","sessionId":"...","data":"<base64>"}
{"id":3,"type":"resize","sessionId":"...","cols":120,"rows":30}
{"id":4,"type":"kill","sessionId":"..."}
{"id":5,"type":"shutdown"}
```

`host → main`（host 的 stdout）：

```jsonc
{"id":1,"ok":true}
{"id":1,"ok":false,"error":"..."}
{"type":"data","sessionId":"...","data":"<base64>"}
{"type":"exit","sessionId":"...","code":0}
{"type":"log","message":"..."}
```

要点：

- **data 一律 base64**：PTY 输出可能是任意字节序列，JSON 字符串里裸 `\n` 会破坏按行分帧，base64 最稳。
- 每个请求带递增 `id`，响应回带 `id` 以便对账；`data`/`exit` 是事件，不带 `id`。
- host 的 stderr 只写自身日志（异常堆栈），主进程转写进 `dsh.log`。

**会话与 shell**

- 会话用 `sessionId`（主进程生成的 uuid）标识，一个 host 进程托管全部会话。
- shell 探测由主进程决定后传给 host（`powershell.exe` 为 Windows 内置 5.1，`pwsh` 为 7.x，优先 pwsh；都缺则回退 `cmd.exe`），探测用 `spawnSync('where', ...)` 或 `process.env` 判断，与 `runtime.nodeVersion()` 的既有校验风格一致。
- node-pty 在 win32 上默认 ConPTY（node-pty 1.1.0-beta 系列，[VS Code 同款版本](https://github.com/microsoft/vscode/pull/282577)）。
- `cwd` 默认 `os.homedir()`；`env` 继承 `process.env`（与 `startDsh` 一致）。

**生命周期与清理**

- host 收到 `shutdown` 或 stdin EOF 后：kill 全部会话并退出，退出码 0。
- 单个会话退出（shell 关闭）→ 发 `exit` 事件；kill 时优先 `pty.kill()`，**再对会话 pid 执行 `taskkill /pid <pid> /T /F`** 兜底杀整树（PowerShell 可能拉起子进程，与 `stopDsh()` 的整树杀模式一致，参考 [microsoft/node-pty#733](https://github.com/microsoft/node-pty/issues/733) 的进程残留教训）。
- host 自身异常退出：主进程记录日志，面板显示「终端服务已退出」并可一键重启 host 与会话。

### 3.2 src/terminal/manager.js（主进程，新增文件）

职责：pty-host 生命周期、会话表、IPC 校验、面板视图管理、退出清理。挂载点为 `main.js` 的 `setupIpc()` 与 `before-quit`。

**面板视图**

- 懒创建：首次打开面板时才 `new WebContentsView({ webPreferences: { preload: src/terminal/panel/preload.js, sandbox: true, contextIsolation: true, nodeIntegration: false } })`，`loadURL('dsh-term://local/panel/index.html')`。
- `mainWindow.contentView.addChildView(panelView)` 挂到主窗口；关闭面板只 `setVisible(false)`，**保留会话**（VS Code 行为）；应用退出时销毁。
- 尺寸：高度 = 内容区高度的 35%，下限 160px，上限 70%；`mainWindow.on('resize')` 防抖 ~100ms 后重算 `setBounds`，并通知 UI 层重新 `fit()` + `pty.resize(cols, rows)`（否则列宽错乱）。
- 打开面板时 `panelView.webContents.focus()`；用户点击 DSH 页面区域焦点自然回到 DSH 页（面板只占底部，不拦截上方点击）。
- 窗口隐藏/显示、最大化/还原时面板跟随主窗口（子视图自动跟随 bounds）。

**IPC 通道（全部校验 `event.sender === panelView.webContents`）**

| 通道 | 方向 | 载荷 | 说明 |
|---|---|---|---|
| `terminal:ready` | view → main | — | 页面加载完成，请求初始主题与 spawn |
| `terminal:spawn` | view → main | `{cols, rows}` | 主进程决定 shell/cwd，创建会话 |
| `terminal:data` | view → main | `{sessionId, data}` | 按键输入（xterm onData 原文转发） |
| `terminal:resize` | view → main | `{sessionId, cols, rows}` | fit 后上报 |
| `terminal:kill` | view → main | `{sessionId}` | 关闭当前会话 |
| `terminal:data` | main → view | `{sessionId, data}` | 输出渲染 |
| `terminal:exit` | main → view | `{sessionId, code}` | 会话退出，UI 显示「进程已退出」 |
| `terminal:theme` | main → view | `{dark: boolean}` | 深浅色切换 |

**安全边界**（对应 AGENTS.md 要求）

- 终端通道只接受面板 view 的 sender，`mainWindow.webContents`（DSH 页面）一律拒绝——DSH 页面永远拿不到终端 IPC。
- `src/terminal/panel/preload.js` 只通过 `contextBridge` 暴露窄接口（`onData/onTheme/onExit/sendInput/resize` 等），不暴露任何 Electron 对象；面板页面是本地 `file://`，无远程内容。
- 终端输入是用户主动操作自己 shell 的行为，属功能本体；主进程不解析、不拼接终端内容，无注入面。

**退出清理**

- `before-quit`：向 host 发 `shutdown`（带 2s 超时），随后复用 `taskkill /T /F` 整树兜底；纳入 `runtime.killActiveChildren()` 的既有清理路径。

### 3.3 src/terminal/panel/index.html + src/terminal/panel/preload.js（渲染层，新增文件）

**静态资源（vendoring）**

- xterm 是 npm 包，而 electron-builder 只打包列出的文件，且仓库不提交 `node_modules`。做法：把 `@xterm/xterm` 的 `dist/xterm.js`、`dist/xterm.css`（及 `@xterm/addon-fit` 的 dist）**拷贝进 `terminal/panel/assets/` 作为版本锁定的静态文件提交**，文件头部注释记录来源与版本，升级 xterm 时同步替换并更新注释。最小集：xterm + addon-fit；可选加 addon-web-links。
- 本地文件加载无网络依赖，离线可用（与启动窗口同思路）。

**页面行为**

- `src/terminal/panel/index.html`：标题栏条（「终端」+ 关闭按钮）+ xterm 容器；样式复用 DSH CSS 变量（`--dsw-alias-*`），深色/浅色由 `terminal:theme` 驱动；字体栈 `"Cascadia Mono", Consolas, "Microsoft YaHei UI Mono", monospace`。
- `src/terminal/panel/preload.js`：`contextBridge.exposeInMainWorld('__terminalBridge', ...)`，把 IPC 包装成页面可用的窄 API；`window.addEventListener('resize')` + 防抖 → `fitAddon.fit()` → 上报 cols/rows。
- 粘贴：xterm 默认右键/`Ctrl+V` 粘贴路径需要 `@xterm/addon-clipboard` 或页面内用 `navigator.clipboard` 读取后走 `sendInput`（二选一，冒烟时验证中文与多行粘贴）。
- 会话退出态：`terminal:exit` 后禁用输入，显示「进程已退出」，提供「重新打开」按钮（重新 spawn）。
- 面板打开时自动聚焦；`Esc` 不强制收面板（避免与 shell 内程序冲突），收面板只走 `Ctrl+\`` / 按钮。

### 3.4 入口与集成（改动既有文件）

**src/main.js**

- `setupShortcuts()` 新增隐藏菜单项：`{ label: t(locale, 'toggleTerminal'), accelerator: 'CmdOrCtrl+`', click: toggleTerminalPanel }`（`` ` `` 键；若与 DSH 页面快捷键冲突，冒烟后改 `Ctrl+Shift+\``）。
- `setupIpc()` 新增 `dsh:terminal-toggle`（校验 sender 为 `mainWindow.webContents`，即窗口控件区按钮）。
- `startup()` / `before-quit` 接入 `src/terminal/manager.js` 的初始化和清理。
- `createMainWindow` 的窗口控件状态推送（`sendWindowControlsState`）不动，终端按钮由 preload 自绘 UI 直接发 IPC。

**src/preload.js**

- 窗口控件自绘区域（右上角）新增「终端」按钮（终端图标，沿用现有控件视觉），点击 `ipcRenderer.send('dsh:terminal-toggle')`，按下态由主进程回推状态（面板开/关）保持样式同步；不向页面暴露任何新 API。

**src/tray.js**（可选）

- 托盘菜单加「打开终端」：`showMainWindow()` + `toggleTerminalPanel(true)`。

**src/i18n.js**

- 新增键（zh/en 双语）：`toggleTerminal`（切换终端）、`terminalTitle`（终端）、`terminalExited`（进程已退出）、`terminalReopen`（重新打开）、`terminalHostFailed`（终端服务不可用）、`terminalHostFailedDetail`、`actionOpenTerminal`（打开终端）等。

**package.json / electron-builder**

- `files` 新增：`src` 整目录（含 `src/terminal/panel/index.html`、`src/terminal/panel/preload.js`、`src/terminal/pty-host.js`、`src/terminal/panel/assets/*`）。
- 方案 1 下无原生模块进 Electron，**不需要** `asarUnpack` / `npmRebuild`。

## 4. 测试与验证清单

- `npm test`：为 `src/terminal/manager.js` 纯逻辑补单测——协议帧编解码（含 base64 多字节/中文）、面板 bounds 计算、shell 探测顺序、会话表状态机。
- `node --check`：`src/terminal/pty-host.js`、`src/terminal/manager.js`、`src/terminal/panel/preload.js`、`src/main.js`、`src/preload.js`。
- `npm start` 冒烟（每项手验）：
  1. `Ctrl+\`` 与「终端」按钮开/关面板，焦点来回切换正常；
  2. 窗口缩放/最大化/还原后面板尺寸与终端列宽正确（fit + resize 链路）；
  3. PowerShell 交互：中文输入输出、复制/粘贴（含多行）、`Ctrl+C` 中断、运行 `ipconfig` / `dir` 等；
  4. 面板关闭再打开，shell 会话保持；shell 手动 `exit` 后出现「进程已退出」并可重新打开；
  5. 深色/浅色主题切换（改 `~/.dsh/settings.yaml`）后终端配色跟随；
  6. 面板打开时 DSH 页面上方区域仍可正常点击/滚动；DSH 页 `Ctrl+滚轮` 缩放不受面板影响；
  7. 托盘「退出」后 `tasklist` 确认无残留 `node`（pty-host）与 `powershell` 进程；
  8. 离线环境首次打开终端：安装失败提示清晰，其余功能不受影响；
  9. 窗口隐藏到托盘再恢复，面板与会话状态正确。

## 5. 实施里程碑

- **M1 宿主原型**：`pty-host.js` + runtime 目录装 node-pty；用管道手动喂 JSON 冒烟 spawn/write/resize/kill/退出清理。**已完成**：
  - 落地文件：`pty-host.js`、`scripts/smoke-pty-host.js`；node-pty 锁定 **1.1.0**（npm latest 稳定版，N-API 预编译，无需本机编译工具链）装入 `~/.dshdesktop/pty-host/`。
  - 冒烟结果（`node scripts/smoke-pty-host.js`，7/7 通过）：spawn 120x30 → 输出回显 → resize 100x24 后继续交互 → `exit` 自然退出（code 0）→ 再 spawn 复用 → kill 后收到 exit 事件 → shutdown 后宿主以 0 退出；退出后无孤儿进程。
  - 实测要点：① npm 11 需 `npm approve-scripts node-pty`（或托管 package.json 预写 `allowScripts`），否则预编译二进制不会下载；② PSReadLine 会给输入回显加 ANSI 着色码，协议断言前需剥色（冒烟脚本已内置 `stripAnsi`）；③ `taskkill /F` 强杀时 node-pty 的 console-list 辅助进程可能打印 `AttachConsole failed` 噪音，属良性，宿主不受影响，只会进 dsh.log。
- **M2 主进程骨架**：`terminal-manager.js` + WebContentsView 面板 + IPC 校验 + 会话表；面板能显示 shell 输出。**已完成**：
  - 落地文件：`terminal-manager.js`（面板视图/宿主生命周期/会话表/IPC）、`terminal-host-client.js`（协议客户端）、`terminal-utils.js`（shell 探测/bounds/校验）、`terminal.html` + `terminal-preload.js` + `terminal.js`（M2 占位 UI）、`scripts/electron-terminal-smoke.js`（可复用的 Electron 集成冒烟）。
  - 集成冒烟（`node_modules\.bin\electron.cmd scripts/electron-terminal-smoke.js`）全链路通过：showPanel → 页面 `ready` → 宿主就绪 → 会话自动创建（powershell.exe）→ 面板渲染横幅输出 → 截图 → hidePanel 保留会话 → shutdown 优雅关闭（exitCode 0）。单测 65/65 通过（含真实宿主的协议客户端集成测试）。
  - **面板页面加载的四个实测坑**（均已解决并注释在代码里）：
    1. 沙箱 WebContentsView 里 file:// 页面加载 file:// 外部脚本被**静默拦截**（无报错、无 console），内联脚本正常 → 改用自定义协议 `dsh-term://`（`protocol.registerSchemesAsPrivileged` + `protocol.handle`，内容由浏览器进程提供，M3 的 xterm 静态资源也走它）。
    2. 自定义 scheme 必须注册 `supportFetchAPI` 特权，否则页面内 fetch 同源资源报 "Failed to fetch"。
    3. 经典脚本**顶层 `'use strict'` 指令**在该 scheme 下被当作表达式求值，紧跟的 IIFE 变成 `'use strict'(...)` 调用（报 "use strict" is not a function）→ `'use strict'` 必须放函数体内。
    4. `showPanel()` 里 **`updatePanelBounds()` 依赖 `panelVisible` 状态而调用顺序颠倒**：面板 bounds 永远是 (0,0,0,0)，表现为按 Ctrl+` 日志一切正常但屏幕上什么都看不到（用户实测反馈）。已修复为先置 `panelVisible` 再算 bounds；集成冒烟新增 bounds 非零断言 + desktopCapturer 截真实窗口并做**像素级合成断言**（主窗口底部像素应为面板浅色，实测 RGB 255,255,255 通过）。
  - 入口仅接了 `Ctrl+\`` 快捷键（M3 补窗口按钮/托盘项）；`pty-host.js` 已加入 `asarUnpack`（外部 node 无法读 asar 内文件）。
- **M3 UI 与入口**：xterm.js 渲染 + 全部入口。**已完成**：
  - xterm 版本锁定（v6.0.0）：`@xterm/xterm` + `@xterm/addon-fit` + `@xterm/addon-clipboard` 的 UMD 构建 vendor 进 `terminal-assets/`（不提交 node_modules，`VERSIONS.md` 记录来源与升级步骤），经 `dsh-term://` scheme 提供。
  - `terminal.html`/`terminal.js` 重写为 xterm 渲染：fit 自适应 + 按实际 cols/rows 上报、深浅两套主题、ClipboardAddon 剪贴板、退出态（禁输入 + 「重新打开」按钮）、文案由主进程按 locale 下发（i18n.js 统一维护）。
  - 入口齐备：`Ctrl+\`` 快捷键、**窗口控件区「终端」按钮**（content-preload 自绘 UI，开/关高亮态经 window-controls-state 回推）、**托盘「打开终端」项**（显示窗口并展开面板）。
  - 集成冒烟新增**真实键盘输入链路**验证（sendInputEvent 字符事件 → xterm onData → IPC → PTY → 回显）全通过；主窗口像素断言确认面板合成。
  - 实测坑：xterm 核心与 addon 的 **UMD 形态不一致**——核心把导出展开到全局（`window.Terminal` 直接是类），addon 把导出对象挂全局名下（`window.FitAddon.FitAddon` 才是类），页面取类需兼容两种形态。
- **体验增强（用户反馈驱动的四项）**：**已完成**：
  1. **面板贴齐会话区域**：content-preload 复用既有 `findFrame()`/`sidebar` 观测，新增 `dsh:content-layout` 单向上报（侧栏右缘/内容右缘，变化才发）；面板 bottom 模式 bounds = 会话区域（侧栏收缩自动延伸），观测缺失回退全宽。
  2. **停靠切换**：面板 header 新增「停靠到底部/停靠到右侧」两个按钮（当前模式高亮），`terminal:set-dock` → 主进程按模式计算 bounds；右侧模式宽 35%（320–60% clamp）且**顶部让出 34px 窗口按钮条**（WebContentsView 永远盖在页面之上，全高会遮住右上角窗口按钮）；停靠偏好持久化到 `preferences.json`（`terminalDock` 字段）。
  3. **默认工作目录 = 当前 DSH 工作区**：新增 `workspace-resolver.js`（纯 Node 可单测）——**不做有损解码，做编码后比对**：dsh 的 `projectKey`（`packages/session/session-persistence-jsonl/src/format.ts`）是分隔符合并的有损编码（`E-dsh-desktop` 无法还原），故把注册表（`~/.dsh/storages/workspace.json`）里每个 path 用同规则编码后与 `sessions/` 下最新活跃会话目录 slug 比对；兜底 updatedAt 最新 → 主目录。已用本机真实数据验证（当前工作区 E:\dsh-desktop 命中）。
  4. **滚动遮挡修复**（已按用户实测反馈二次修正）：面板显示时 main → preload 下发 `dsh:panel-inset {bottom, right}`，content-preload 定位**会话区滚动体**（centerCol 内 overflow 可滚且高度最大的容器，含 composer 的滚动流）并只改它的 padding——布局框架零移动、无底部空白；right 模式改注入 `padding-right = 面板宽`（实测不影响 composer）；隐藏/归零；找不到滚动体时跳过注入（行为不退化）。
  - **二次修正记录（用户实测反馈）**：① xterm 初始主题曾固定 light（appearance 先到而 term 后创建）→ 改为创建时用「最近收到/默认的深色状态」；② 原注入点（布局框架 grid）造成整页上移+底部空白 → 改为注入会话区滚动体，实测验证 composer/布局框架均不被推移（filler 假消息实验）；③ 右侧停靠遮挡会话区右侧 → right inset = 面板宽；④ dock 按钮原 SVG 缺尺寸规则导致黑色方块/不可见 → 限定 svg 11px + 重画向下/向右线框图标（参考用户提供的风格，未使用原图）。
  - **三次修正记录（用户实测反馈）**：① 黑块（终端底部黑色矩形块）＝ xterm 6 自绘滚动条滑块 theme 字段缺省黑色 → THEMES 补 `scrollbarSlider*` 半透明色；② 停靠切换瞬间黑块闪现 ＝ fit 延迟期旧尺寸 xterm 溢出被裁切、露出容器背景 → `#terminal` 背景与 xterm 主题背景同色（`--term-bg` 变量）＋ dock-state 时立即 `reportSize()`；③ 右侧停靠面板 header 底边灰线与 DSH 会话区标题区域底边灰线不共线 → content-preload 上报 `headerBottom`（会话区滚动体 top），面板 y = `max(28, headerBottom - 34)`，两线共线（headerBottom 缺失时下限 28px 兜底，保证窗口按钮可点）。
  - 集成冒烟新增：模拟布局上报后 bounds 贴齐断言、右侧停靠 bounds 断言（含 headerBottom 对齐）、底部/右侧内缩下发与归零断言（探针 preload 挂在冒烟主窗口，不进打包）；72/72 单测通过。
- **M4 打磨收尾**：**已完成**：
  - bounds/inset 计算抽为纯函数（`terminal-utils.computeDockBounds`/`panelInsetFor`），单测覆盖底部贴齐、右侧 clamp 与 headerBottom 对齐、内缩方向（16 项 utils 测试）。
  - 集成冒烟扩展到 **25 项**：会话退出→退出态→重新打开成功；**宿主崩溃（taskkill）→ 主进程收到通知 → 面板错误态 → 重新拉起新宿主+新会话**（实测 pid 13328→21908）；shutdown 后**无孤儿进程**（pid 探测）复查。
  - 单测 **78 项**全过；AGENTS.md 合规复查（打包 files 完整、`'use strict'`/风格、sandbox/contextIsolation/IPC sender 校验）通过。
  - 已提交：`ca2461d feat: 内嵌终端面板`（27 文件，+3707 行；docs/pty-host/terminal-*/workspace-resolver/测试与冒烟脚本、终端页面资源与配置改动）。
- **四次修正记录（用户实测反馈，已提交 632c9b8 + 本轮）**：
  1. 右侧停靠顶部对齐改用**标题区 `<header>` 元素的底边**（`findConversationHeader()`，滚动体 top 仅作回退），并在本轮再上移 1px：新增 `RIGHT_DOCK_TOP_OFFSET = 1`，面板 y = `max(28, headerBottom - 1)`——DSH 底边线与面板 header 顶边线各占 1px，上移后两条线完全重叠（不校准则并排成 2px，用户实测仍差 1px）。
  2. 管理区关闭按钮从 12px 描边叉替换为**垃圾桶**：首次为 12×12 线框 SVG，本轮替换为用户提供的 `resources/lajitong.svg`（bootstrap-icons bi-trash，viewBox 0 0 16 16）同款路径并放大到 12px——填充式矢量（`fill: currentColor`）比 1px 描边更清晰。
  3. 滚动归属修正：`body`/`.main` 设 `overflow: hidden`，滚动只发生在 xterm 舞台与管理区内部（管理区 `overflow-y: auto`，内容不超阈值不出现滚动条），消除「一条滚动条控制整个区域向下滚」的观感。
  4. 三条拖动条（resizeH/resizeV/split）悬停色从主题蓝改为深灰 `var(--drag-hover)`（浅色 `rgba(0,0,0,.28)` / 深色 `rgba(255,255,255,.28)`）。
  5. 右侧停靠面板新增 **1px 左边界线**（`body[data-dock="right"] { border-left: 1px solid var(--border) }`），与 DSH 内容区明确分隔。
  - 集成冒烟新增两项断言（右停靠左边界线已渲染、关闭按钮为 bi-trash），单测更新 headerBottom 对齐值（70 → 69）。
- **六次修正记录（用户实测反馈）**：
  1. **首启右停靠错版布局**：持久化停靠为 right 时首开面板，顶部出现本应是隐藏的水平拖动条（resizeH 按 bottom 布局渲染），切一次停靠才恢复——根因是首个 `terminal:dock-state` 在页面加载前发送被丢弃、HTML 静态 `data-dock` 恒为 bottom。修复双保险：① 入口 URL 带停靠查询参数（`terminal.html?dock=right`，页面首帧即按正确模式渲染）；② `terminal:ready` 时补发 dock-state（覆盖重载/崩溃恢复等场景）。
  2. **边界拖动方向反转**：resizeH/resizeV 位于面板**顶缘/左缘**，原实现 `base + 增量` 使面板边缘反向移动（向下拖顶缘反而增高，用户实测）。改为「边缘跟随光标」取负增量（`base - dx` / `base - dy`），与内部 `#split` 的方向语义一致；冒烟的拖动断言同步翻转（右拖即变窄、上拖即增高）。
  3. 集成冒烟截图抗抖：capturePage 偶发 `UnknownVizError`、desktopCapturer 偶发黑帧（远程会话/显示器休眠时更常见）——截图加短重试；合成像素断言仅在取到非黑帧时严格判定，连续黑帧记「环境限制跳过」而非产品失败（面板截图/bounds 断言仍全量执行）。
- **七次修正记录（拖动顺滑性，用户实测反馈）**：边界拖动（resizeH/resizeV）「不跟手 + 抖动」根因与修法：
  1. **坐标系反馈环（0.5cm 根因）**：拖动计算原用 `clientX/clientY`（面板页面视口坐标），而拖动条在面板边缘、边缘又跟随光标移动——面板原点每次平移把下一个增量「吃掉」（实测光标走 1cm 边界只走约 0.5cm 且来回顿挫）。改用 `screenX/screenY`（屏幕绝对坐标，与面板位置无关）后增量恒等于光标真实位移；同时**去掉 30ms 发送节流**、`setPointerCapture` + `pointercancel` 兜底，光标短暂出界/出视图不丢事件流。管理区 `#split` 本就同步直接改 DOM 且视口原点不移动，方向与跟手均正确，仅补了 pointer capture。
  2. **会话区抖动**：拖动期间每次 bounds 变化都即时 `dsh:panel-inset`，DSH 会话区以 ~33Hz 反复重排 → 改 **150ms 尾随防抖**（拖动中会话区静止、松手一次到位；隐藏/显示/停靠切换仍即时下发）。
  3. **终端区抖动**：拖动中 `ResizeObserver` 反复触发 xterm `fit()`/PTY resize（~10Hz 文字重排）→ 拖动期间挂起重排（`resizingPanel` 标志，observer/窗口 resize 监听均跳过），`pointerup` 后统一补一次 fit。
  - 冒烟健壮性：① 边界线断言放宽为「明显非零」——150% 分数缩放下渲染器会把 1px 折算成 0.666667px（仍是 1 物理像素线），原 `=== '1px'` 会误报；② desktopCapturer 源**严格按窗口 id 匹配、绝不回退 sources[0]**（曾采到用户其他窗口造成误报），采不到本窗口记环境跳过。

## 6. 风险与备选

| 风险 | 应对 |
|---|---|
| Electron 43 的 `WebContentsView` 与主 webContents 的层级/焦点细节 | 首选方案；备选：无边框透明子窗口（overlay），语义基本一致但更重 |
| xterm 静态资源 vendoring 的版本漂移 | `src/terminal/panel/assets/` 内注释锁定版本，升级步骤写入文件头 |
| node-pty 依赖 npm 安装脚本与 allow-scripts 机制 | npm 11 会拦截安装脚本，自动安装器需预写 `allowScripts` 或安装后 `npm approve-scripts`（M1 已实测） |
| `Ctrl+\`` 与 DSH 页面内快捷键冲突 | 冒烟验证，冲突则换 `Ctrl+Shift+\`` |
| 面板覆盖 DSH 页面底部 | 已解决：`dsh:panel-inset` 给 DSH 布局框架注入底部 padding，滚动范围收束到面板上方；frame 观测失败时退化为覆盖式，行为不退化 |
| PowerShell 输出编码（ConPTY 下 UTF-8） | 默认 pwsh/powershell 规避 cmd 的 codepage 问题；cmd 回退路径冒烟验证 |
| `sessions/` 目录名编码是 dsh 内部约定 | 只做「编码后比对」不做解码，注册表损坏/编码变化时逐级兜底（updatedAt → 主目录） |

## 7. 后续扩展（不在本期范围）

- 多会话标签页、shell 下拉切换（pwsh/powershell/cmd/WSL）。
- 面板高度拖拽（`WebContentsView` 的 `setBounds` 直接支持，成本低）。
- 停靠偏好已持久化；默认 shell/面板高度/工作目录策略的更多设置项可继续沿用 `preferences.json` 模式。
- 终端会话直接落到 `~/.dsh` 或 DSH runtime 目录的快捷入口（后续按需）。
