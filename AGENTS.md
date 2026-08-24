# Repository Guidelines

## 项目结构与模块组织

本仓库是面向 Windows 的 Electron 启动器，采用 CommonJS。`main.js` 负责应用生命周期、透明原生 Window Controls Overlay、快捷键及 DSH 子进程；BrowserWindow 直接加载 DSH 页面，不另设自定义标题栏页面。`content-preload.js` 负责外观观测和应用内隔离模态框；`startup.html` 与 `startup-preload.js` 实现主页面加载前的启动窗口。`runtime-manager.js` 管理 `@deepseek-ai/dsh` 的安装和更新；`settings-reader.js`、`i18n.js`、`tray.js` 分别处理设置、文案和托盘。静态图标位于 `assets/`，打包结果写入 `dist/`；不要提交生成物或 `node_modules/`。

## 构建、测试与开发命令

- `npm ci`：按 `package-lock.json` 安装可复现依赖；更新依赖时才使用 `npm install`。
- `npm start`：以开发模式运行 `electron .`，用于本地手工验证。
- `npm run build`：通过 electron-builder 生成 x64 NSIS 安装包和便携版，输出到 `dist/`。
- `npm test`：使用 Node.js 内置测试运行器执行 `test/*.test.js`。
- `node --check main.js`：对修改过的 JavaScript 文件做快速语法检查；其他文件可替换文件名重复执行。

- 开发和运行需要系统 PATH 中可用的 Node.js 和 npm；启动器不得硬编码 Node.js 版本门槛，实际兼容性由 DSH 启动结果决定。首次启动会访问 npm registry 下载 DSH 运行时。

## 编码风格与命名约定

沿用现有风格：两空格缩进、单引号、无分号、尾随逗号，以及文件顶部的 `'use strict'`。变量和函数使用 `camelCase`，常量使用 `UPPER_SNAKE_CASE`，文件名使用小写 kebab-case（如 `runtime-manager.js`）。优先使用 `node:` 前缀导入内置模块。注释应解释约束或原因，面向用户的文本和代码注释使用中文。当前未配置 ESLint 或 Prettier，提交前请保持与相邻代码一致。

## 测试指南

仓库使用 Node.js 内置测试运行器，测试放入 `test/` 并命名为 `*.test.js`，目前没有覆盖率门槛。每次变更至少执行 `npm test`、语法检查和 `npm start` 冒烟测试。涉及运行时管理时，验证首次安装、离线复用及升级；涉及窗口时，验证透明覆盖层、主题同步、Logo 行拖动、最小化、最大化、关闭到托盘及真正退出。

## 弹窗与启动界面规范

操作型提示统一使用 `content-preload.js` 创建的 Shadow DOM 模态框；主页面尚未加载时使用本地启动窗口。除启动界面自身无法创建或渲染外，不得使用 Windows 默认消息框。

模态框应继承 DSH 的 CSS 变量并跟随深浅色：遮罩使用半透明背景和模糊效果；卡片宽度保持 380–440px、圆角 24px、内边距 24px，背景使用层级色并配合三级阴影；按钮高度 36px、圆角约 10px，主按钮使用 DSH primary token。仅为变量缺失提供中性回退色，避免硬编码出另一套视觉体系。启动窗口沿用相同的颜色层级、圆角、阴影、按钮和字体风格。

新增提示状态时应复用现有 loading、info、confirm、error 或 progress 模式，并实现焦点锁定、Esc 取消、Enter 默认操作、关闭后恢复焦点、重复点击保护及 `prefers-reduced-motion`。文案统一加入 `i18n.js`；IPC 必须校验来源，不得向 DSH 页面暴露 Electron API；新增启动资源必须加入 electron-builder 文件列表。

## DSH 插件开发（如涉及）

开发或审查 DSH（`@deepseek-ai/dsh` / Cordis）插件时，先通读 [`docs/plugin-dev-conventions.md`](docs/plugin-dev-conventions.md)，按其"事实来源"与"验收清单"执行；以本机已装版本的官方 `dsh-*` 包为模板，不从记忆自创结构。交付前运行 `node scripts/check-plugin-conformance.js <插件目录>`（`--strict`）并做 profile 运行时验证（`--dump-config`、启动冒烟），确认无 patch 告警、无 inject/Config 缺失。

## 提交与 Pull Request

- 提交信息必须采用简洁的 Conventional Commits 格式 `type: 中文说明`；类型使用小写英文（如 `feat`、`fix`、`chore`），说明使用中文，例如 `fix: 处理 DSH 启动超时`。

Pull Request 应说明动机、主要改动和验证命令，关联相关 issue；界面或托盘行为变化需附截图。保持单个 PR 聚焦，避免夹带 `dist/`、日志、凭据或本机 `~/.dsh*` 数据。

## 安全与配置

不要提交 API key、`.credentials.yaml` 或运行日志。DSH 页面必须保持 `contextIsolation: true`、`nodeIntegration: false` 和 `sandbox: true`。`content-preload.js` 只允许向主进程上报经过校验的外观状态，不得向页面暴露 Electron API；新增外部进程参数时避免拼接未经校验的用户输入。
