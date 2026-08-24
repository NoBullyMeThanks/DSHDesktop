# DSH 插件开发约定（对照官方规范）

> 本文档是本机 DSH 插件开发的**强制规范锚点**。开发或审查 DSH 插件前先通读本文，
> 交付前运行 `node scripts/check-plugin-conformance.js <插件目录>`，再做运行时验证。
>
> 锚定版本：`@deepseek-ai/dsh` **0.1.1-rc.2**（本机运行时所装的版本，见
> `%USERPROFILE%\.dshdesktop\runtime\package.json`）。规范随版本演进，升级 DSH
> 时须重新核对下方"事实来源"并修订本文件。

## 强制流程（防走样）

1. **读规范**：先读本文档及其"事实来源"，再动手。
2. **照官方参考**：以官方 in-box 插件源码为模板（本机
   `runtime\node_modules\@deepseek-ai\` 下全部 `dsh-*` 包），
   不要凭记忆自创结构。
3. **静态检查**：`node scripts/check-plugin-conformance.js <插件目录>`。
4. **运行时验证**：装进测试 profile，`--dump-config` 无告警，启动无 `patch ... not found`、
   `inject` 缺失等日志。

## 事实来源（按权威性排序）

1. **本机已装运行时**（唯一可信的"当前版本事实"）：
   - `@deepseek-ai/dsh` 发布包：`lib/bin.js`、`lib/plugin-*.js`（profile 插件管理逻辑）
   - `@deepseek-ai/cordis`（v4 fork）类型：`lib/types/registry.d.ts`、`context.d.ts` —— 插件契约
   - `@deepseek-ai/cordis-plugin-loader` 类型：`lib/types/config/entry.d.ts` —— 配置条目形态
   - `@deepseek-ai/dsh-app-boot` / `dsh-base`：profile 引导与 `cordis.patch.yml` 参考实现
2. **官方仓库文档**（GitHub `deepseek-ai/deepseek-harness`，与发布包同源）：
   - `docs/user/develop/basic/index.zh.md`（插件开发总览）
   - `docs/user/develop/basic/config.zh.md`（patch/配置）
   - `docs/user/develop/basic/tool.zh.md`（工具开发）
   - `docs/user/develop/basic/publish.zh.md`（发布到 npm）
   - `docs/development.zh.md`（仓库级开发约定）
3. **官方讨论/脚手架状态**：`deepseek-harness` Discussion
   [RFC: official plugin scaffold](https://github.com/deepseek-ai/deepseek-harness/discussions/1629)
   —— 官方脚手架尚未定稿，因此"照抄官方 in-box 插件"是最稳的模板来源。

## 两个层次：profile bundle 与 cordis 插件

DSH 的"插件"是两层概念，缺一不可：

- **cordis 插件**：一个可被 loader 加载的模块（函数/类/`{apply}`），向 `ctx` 提供服务。
- **profile bundle（组合包）**：一个 npm 包，通过 `package.json` 的
  `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` 声明"我是 profile 层"，
  由 `dsh plugin --profile <name> add <pkg>` 安装进 profile 的 pnpm 依赖，
  并自动登记到 profile manifest 的 `dsh.profile.bundles` 列表中。

没有 bundle 声明的依赖只作为普通库安装，**不会进入 profile 层**（安装时会有警告）。
对照：官方 `@deepseek-ai/dsh-base` 就是"每个 profile 的第一个 patch 层"。

## 包结构与 package.json 约定

参考官方发布包（如 `@deepseek-ai/dsh-agent-default-model`）：

```
my-plugin/
  package.json          # type: module；dsh.bundle.patch；exports ./cordis.patch.yml
  cordis.patch.yml      # profile 层 patch（插件的"接通"配置）
  lib/index.js          # 主入口（构建产物；源码在 src/）
  lib/invariant.js      # 可选：不变式断言
  lib/types/*.d.ts      # 类型
  src/                  # 源码（若发布，exports 里配 "./src/*"）
  README.md / README.zh.md / README.i18n.yaml
  LICENSE               # MIT
```

`package.json` 逐项要求：

| 字段 | 要求 |
|---|---|
| `type` | `"module"`（官方全部 ESM） |
| `main`/`exports["."]` | 指向 `lib/index.js`；`exports` 必须包含 `"./cordis.patch.yml": "./cordis.patch.yml"` |
| `files` | 含 `lib`、`cordis.patch.yml`、`README*`、`LICENSE` |
| `dsh.bundle.patch` | `"./cordis.patch.yml"`（相对包根） |
| `license` | `"MIT"` |
| `repository` | 指向 deepseek-harness 同风格（`type`/`url`/`directory`） |
| `publishConfig.access` | 带 scope 的包为 `"public"` |
| 依赖 | `@deepseek-ai/cordis`、`@deepseek-ai/cordis-plugin-*`、`@deepseek-ai/dsh-*` 用 `peerDependencies`；运行时强依赖放 `dependencies`；二者版本与 DSH 发布线一致 |

## cordis.patch.yml 方言

参考 `dsh-base/cordis.patch.yml` 与 `@deepseek-ai/dsh-app-boot` 的
`applyEntryPatches`（本机 `dsh-app-boot/lib/index.js`）：

- 顶层是 **条目数组**（或空）。最常用形态：

  ```yaml
  - insert:
      - id: my-feature
        name: 'my-plugin'            # loader 可导入的模块标识符（包名）
        config:
          optionA: 42
      # - group: true / config: [条目...]  // 子组
      # - disabled: '!!js ...'            // 表达式门控
      # - inject: [服务...]                // 条目级依赖
  ```

- 条目字段：`id`（同一树内稳定唯一）、`name`（模块标识符）、`config`（传给插件的配置）、
  `group`、`disabled`、`inject`。
- **行内 `config` 是整体替换**（不合并）：一行只写一个条目完整配置，
  模式差异放到各模式 bundle 而不是同一行里加条件（官方注释原文如此）。
- **行顺序不承载加载语义**：激活由服务可用性（`inject`）驱动。
- **patch 匹配不到会警告并跳过**：`patch insert: entry %C not found` / `patch: id is required`。
  这是最常见的"写完没生效"原因 —— 见运行时验证。
- 非 insert 的 patch 行必须带 `id`（覆盖已有行）；`name` 与目标不一致会跳过。
- `!!js` 标量会在条目激活时求值（如 `disabled: '!!js process.platform === "win32"'`）。

## cordis 插件源码契约

依据 `@deepseek-ai/cordis/lib/types/registry.d.ts`：

- 插件形态三选一：函数 `(ctx, config) => any`、类 `new (ctx, config)`、
  对象 `{ apply(ctx, config) }`；模块 `export default` 该插件。
- 元数据（类上 `static`，函数/对象上同名属性）：
  - `name`：诊断/日志显示名
  - `Config`：standard-schema 校验器（**schemastery 的 `z`**，官方一律 `static Config = z.object({...})`），
    插件启动前校验；缺失则接受任意配置（不规范）
  - `inject`：声明所需服务（数组或 `{服务: 拦截配置}`）；服务未就绪时插件**等待**，不全则加载即失败
  - `provide`：本插件提供的服务名；`intercept`：声明消费哪些服务的拦截配置
- 提供服务：扩展 `@deepseek-ai/cordis` 的 `Service`，`super(ctx, 'serviceName')`；
  服务注册进 `ctx` 后其他插件即可注入（参照 `dsh-agent-default-model`）。
- 加载接口：`ctx.plugin(plugin, config)`（本上下文内挂载）、`ctx.inject(deps, cb)`。
- 生命周期：`ctx.on('ready')` 等事件监听；**一切副作用必须可逆** ——
  用 `ctx.on('dispose')`/`ctx` 派生作用域清理，热重载（HMR）会反复挂载/卸载插件。
- 不要重复造轮子：优先注入并使用 `ctx` 上已有服务（`ctx.fs`、`ctx.llm`、`ctx.jobs`、
  `ctx.agentLoop`、`ctx.settings`、`ctx.loader`……），与官方一样用 `inject` 声明，而不是重新实现。

## 发布与安装流程

```sh
# 开发期：本地安装（从插件目录所在处执行）
dsh plugin --profile <测试profile> add <包名|相对路径|git 地址>

# 相对路径会被锚定到"调用 dsh 时所在的目录"（官方 plugin-*.js 的 anchorPathSpec 行为）

# git 安装：prepare 构建脚本默认被 pnpm 拦截，需在 profile 的
# pnpm-workspace.yaml 的 allowBuilds 中加入 pnpm 提示的精确 key 后重跑

# 组合验证（不启动，打印叠加后的配置树；会在 profile 目录写出组合后的配置，需对 $DSH_HOME 有写权限）
dsh --profile <测试profile> --dump-config
```

发布到 npm 前按 `docs/user/develop/basic/publish.zh.md` 走：版本随官方线、
`files` 裁剪、README 双语、LICENSE、`npm publish`（带 scope 需 `publishConfig.access: public`）。

## 验收清单（交付前逐项打勾）

- [ ] `type: module`，`main`/`exports` 指向 `lib/index.js`
- [ ] `dsh.bundle.patch` 存在且指向包内真实存在的 `cordis.patch.yml`
- [ ] `exports["./cordis.patch.yml"]` 已配置
- [ ] `files` 包含 `lib`、`cordis.patch.yml`、`README*`、`LICENSE`
- [ ] `cordis.patch.yml` 可解析；insert 行有 `id` + 可导入的 `name`；无重复 id
- [ ] 插件默认导出存在；`Config` schema（`z`）已声明；`inject` 已声明所需服务
- [ ] 副作用可逆（dispose/作用域清理），`ctx.plugin`/`ctx.inject` 用法正确
- [ ] `node --check` 通过；`node scripts/check-plugin-conformance.js <目录>` 无 error（`--strict` 无 warn）
- [ ] 装进测试 profile 后 `dsh --profile <p> --dump-config` 不含
      `not found` / `skipping` / `id is required` 等告警
- [ ] 启动冒烟：插件行为正确、进程能正常退出，无未处理异常

## 常见症状对照

| 症状 | 原因 |
|---|---|
| 插件从不生效 | `cordis.patch.yml` 里行 `id` 打错/层级不对，patch 被跳过（只警告） |
| 装了但不在 `bundles` 列表 | 包没声明 `dsh.bundle.patch`（只当普通依赖） |
| 启动报某服务缺失/插件加载失败 | `inject` 声明了不存在的服务，或包没装进 profile 的 node_modules |
| git 插件装不上 | prepare 脚本被 pnpm 拦截，需 `pnpm-workspace.yaml` `allowBuilds` |
| `config` 里改了没生效 | 行内 config 是整体替换，须整行覆盖 |
