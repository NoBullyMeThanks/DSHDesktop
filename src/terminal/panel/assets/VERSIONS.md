# 终端面板静态资源版本锁定（src/terminal/panel/assets）

本目录是终端面板页面（index.html）使用的 xterm.js 静态资源，直接从 npm 包拷贝，
**不提交 node_modules**，因此以文件形式锁定版本。

| 文件 | 来源包 | 版本 | 拷贝自 |
|---|---|---|---|
| xterm.js | @xterm/xterm | 6.0.0 | `lib/xterm.js`（UMD 构建，全局名 `Terminal`） |
| xterm.css | @xterm/xterm | 6.0.0 | `css/xterm.css` |
| addon-fit.js | @xterm/addon-fit | 0.11.0 | `lib/addon-fit.js`（UMD，全局名 `FitAddon`） |
| addon-clipboard.js | @xterm/addon-clipboard | 0.1.0 | `lib/addon-clipboard.js`（UMD，全局名 `ClipboardAddon`） |

## 升级步骤

```powershell
# 临时目录安装目标版本
$dir = Join-Path $env:TEMP 'xterm-vendor'
npm install --prefix $dir @xterm/xterm@<新版> @xterm/addon-fit@<新版> @xterm/addon-clipboard@<新版> --no-audit --no-fund
# 拷贝（注意 xterm 6 的 UMD 在 lib/ 而非 dist/，CSS 在 css/）
Copy-Item "$dir\node_modules\@xterm\xterm\lib\xterm.js"  src\terminal\panel\assets\xterm.js
Copy-Item "$dir\node_modules\@xterm\xterm\css\xterm.css" src\terminal\panel\assets\xterm.css
Copy-Item "$dir\node_modules\@xterm\addon-fit\lib\addon-fit.js" src\terminal\panel\assets\addon-fit.js
Copy-Item "$dir\node_modules\@xterm\addon-clipboard\lib\addon-clipboard.js" src\terminal\panel\assets\addon-clipboard.js
```

升级后同步更新本表，并跑一遍 `scripts/electron-terminal-smoke.js` 集成冒烟。
