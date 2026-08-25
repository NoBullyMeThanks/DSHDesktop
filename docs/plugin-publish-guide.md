# DSH 插件打包与发布流程(本机工作流)

> 与 [`plugin-dev-conventions.md`](plugin-dev-conventions.md) 配套:前者是"开发规范锚点",本文是**打包/发布
> 流程与注意事项**(面向 GitHub Releases 分发,无 npm 账号的场景)。锚定 `@deepseek-ai/dsh` **0.1.1-rc.2**。
> 所有结论均经本机实测(conformance、`pnpm pack`、发布形态临摹打包验证)。

## 目录约定(本机规范)

- **插件源码**:`<项目根>/plugin/<插件名>/`(host 包根,内含 `client/` 子包);本机 =
  `E:\dsh-desktop\plugin\{workspace-file-tree,dsh-usage-monitor}`。
- **发布产物**:`<项目根>/plugin/release/<tag>/`;`pnpm release` 默认输出于此(脚本按
  `<插件根>/../release/<tag>` 推导),`DSH_RELEASE_DIR` 可覆盖;本机样板 =
  `E:\dsh-desktop\plugin\release\v0.1.0\`。
- 产物与 `node_modules/` 不提交(根 `.gitignore` 已覆盖);旧 `release-artifacts/` 约定已废弃,不再新建。

## 0. 发布前自检(每一项不过关就不打包)

```sh
# ① 规范检查:零 error;warn 逐条说明(如 inject 启发式警告属"可选服务"设计的可保留)
node scripts/check-plugin-conformance.js <插件目录> --strict
```

- [ ] **`exports["./cordis.patch.yml"]` 已配置** —— 漏配是最隐蔽的致命伤:本地 `link:` 安装照常工作,
  但发布后 loader 按模块标识符导入 patch 失败,表现是"插件装了完全不生效"(无任何报错)。
- [ ] 插件有**默认导出**(`export default` 函数/类/`{apply, Config, name}` 对象)。
- [ ] 仓库根有 **LICENSE**(MIT)且 `package.json` 有 `repository`(真实地址;纯元数据,本地运行不读,
  但发布物必填)。
- [ ] **`@deepseek-ai/cordis` 在 `peerDependencies`**(不在 `dependencies`:多实例会导致服务注册/注入失配)。
- [ ] peer/dev 依赖版本对当前 DSH 线**实测满足**(不要凭直觉):
  ```sh
  # 在 E:\dsh-desktop(带 semver)执行,两行都应为 true
  node -e "console.log(require('semver').satisfies('0.1.1-rc.2', '^0.1.1-rc.2'))"   # true
  node -e "console.log(require('semver').satisfies('0.1.1-rc.2', '^0.1.0-rc.7'))"   # false ← 旧版范围的坑
  ```
  prerelease 的 caret 只匹配同 `[major,minor,patch]` 元组,所以 `^0.1.0-rc.7` **不含** `0.1.1-rc.2`。
- [ ] 发布物**无 `link:` / `file:` / `workspace:` 依赖**。开发期 host→client 用 `link:./client` 没问题,
  但打包前必须换成发布形态(见下);建议加 prepack 守卫强制把关。
- [ ] client 半区是**独立包**(见 §3),`dsh.client.inject` 声明的 `@deepseek-ai/dsh-client-*` 在
  `peerDependencies`(版本同 DSH 线),外部化的 react 等放在 `devDependencies`。

## 1. 每次发布流程(GitHub Releases)

> **一键脚本 `pnpm release`**(由 `dsh-plugin-development` 技能随附,两个插件已内置同一份)。
> 脚本自动完成
> "构建 → 打包 client → **临时从 host manifest 移除 client 依赖** → 打包 host →
> **恢复 manifest 为 link: 开发形态**";需要你手动做的只剩上传。以下手动流程与脚本等价,保留作备选。
>
> ⚠️ **发布形态为什么"移除"而不是"URL 依赖"**:pnpm 11 默认开启 `blockExoticSubdeps`,
> 只允许根 package.json 直接使用 exotic 源(git/URL tarball),**传递依赖**(host 里的 client URL)
> 一律拦截 → 用户装 host 时直接 `ERR_PNPM_EXOTIC_SUBDEP`。所以 client 必须由用户**显式安装为
> 顶层依赖**(`file:` 本地 tgz,顶层不受拦截)。这是 GitHub Releases 线
> (无 npm registry) 的唯一无配置可行形态,已本机端到端实测验证。

### 1.1 一键发布(推荐)

```powershell
cd E:\dsh-desktop\plugin\workspace-file-tree
pnpm release            # → plugin\release\plugin-v1.0.0\ 下生成 2 个 tgz,manifest 自动恢复
cd E:\dsh-desktop\plugin\dsh-usage-monitor
pnpm release            # 同上
# 然后:建 Release plugin-v1.0.0 → 上传全部 4 个 tgz(无顺序要求)
```

> tag 默认 `v<版本>`;与仓库中主应用(DSHDesktop 自身)的 v2.x tag 冲突时用
> `$env:DSH_RELEASE_TAG='plugin-v1.0.0'` 显式指定插件专用 tag(本仓库惯例)。

**用户安装(下载两个 tgz 到同一目录后执行)**:

```powershell
# 用户下载两个 tgz 到同一目录(如 D:\plugins\),在该目录执行:
dsh plugin --profile <p> add file:./workspace-file-tree-client-1.0.0.tgz file:./workspace-file-tree-1.0.0.tgz
```

安装时出现的 `declares no dsh.bundle — installed as a plain dependency` 警告是**预期无害**的:
client 半区本来就没有 `dsh.bundle`(它是纯浏览器插件),装成普通依赖后 DSH 的 loader
按包名解析照常工作(已验证:冒烟启动无告警、插件路由 200)。

新插件开发时:从技能资源 `resources/release.mjs` 复制到 `<插件根>/scripts/` 并在
`package.json` 的 `scripts` 加 `"release": "node scripts/release.mjs"` 即可获得同样的能力。
可选用环境变量:`DSH_RELEASE_TAG`(默认 `v<host 版本>`)、`DSH_RELEASE_DIR`(默认
`<项目根>/plugin/release/<tag>`);脚本结束时会打印:上传清单与用户安装命令。

### 1.2 手动流程(与脚本等价,备选)

以 plugin-v1.0.0、仓库 `github.com/<owner>/<repo>`(示例 `NoBullyMeThanks/DSHDesktop`)为例:

```powershell
# ① 先打两个 client 包(无需改动,现在就能打)
cd <插件>\workspace-file-tree\client        # 或对应 client 目录
pnpm pack --pack-destination D:\releases\plugin-v1.0.0    # → workspace-file-tree-client-1.0.0.tgz
cd <插件>\dsh-usage-monitor\client
pnpm pack --pack-destination D:\releases\plugin-v1.0.0    # → dsh-usage-monitor-client-1.0.0.tgz

# ② 在 GitHub 建 Release plugin-v1.0.0,上传这两个 client tgz(及后续两个 host tgz)

# ③ 两个 host 的 package.json 各删一行:移除 client 依赖(link:./client 是开发形态,
#    发布物不携带——URL 依赖会被 pnpm 11 blockExoticSubdeps 拦截,link: 用户机器上无此目录;
#    client 由用户显式安装为顶层依赖,不受拦截)
#    打完包后想继续本地开发改回 link:(prepack 守卫只在 pack 时运行)

# ④ 打两个 host 包(此时 prepack 守卫放行)
cd <插件>\workspace-file-tree
pnpm build;   pnpm pack --pack-destination D:\releases\plugin-v1.0.0   # → workspace-file-tree-1.0.0.tgz
cd <插件>\dsh-usage-monitor
pnpm build;   pnpm pack --pack-destination D:\releases\plugin-v1.0.0   # → dsh-usage-monitor-1.0.0.tgz

# ⑤ 把两个 host tgz 上传到同一个 Release plugin-v1.0.0,发布完成
```

**用户侧安装**(对方机器,下载两个 tgz 到同一目录后执行):

```sh
# 一条命令装两个,均无网络依赖:
dsh plugin --profile <p> add file:./workspace-file-tree-client-1.0.0.tgz file:./workspace-file-tree-1.0.0.tgz
```

pnpm 安装时:host 本体、client 子包是顶层依赖(来自本地文件),
其余公共依赖(chokidar/diff/codemirror/`@deepseek-ai/*` 等)走 npm 官方 registry;
安装完成后运行完全本地化。`declares no dsh.bundle` 警告为预期无害(client 无 profile 层声明)。

## 2. 打包细节与产物核对

- `pnpm pack` 是**一个包一次**,须在各自包根目录运行;client 虽在 host 的 pnpm workspace 里,
  直接 `cd client` 执行也会正确打包**当前目录的包**(已实测)。
- 不写 `--pack-destination` 时 tgz 落在当前包目录,会污染源码树——永远显式指定;文件名自动为
  `<包名>-<版本号>.tgz`,Release 资产名必须与之一致。
- `pnpm pack` **不会自动构建**:源码改动后先 `pnpm build`(tsc 编 host、esbuild 编 client 的 `lib/`),
  否则打出旧产物。
- 用 `pnpm release` 时无需操心上述细节(脚本内部先 build);产物目录默认
  `<项目根>/plugin/release/<tag>/`,可用 `DSH_RELEASE_DIR` 改;
- 打包后抽查内容(必须含 lib、cordis.patch.yml、LICENSE、README):
  ```sh
  tar -tf D:\releases\plugin-v1.0.0\workspace-file-tree-1.0.0.tgz
  tar -xOf 该tgz package/package.json   # 确认无 client 依赖(发布形态不含 link:/URL)
  ```
- 本机成品样板:`E:\dsh-desktop\plugin\release\plugin-v1.0.0\`(4 个 tgz,host 均不含 client 依赖)。

## 3. 关键机制(为什么必须这样)

1. **两层概念**:`dsh.bundle.patch` 声明是"profile 层"卡点(见 conventions 文档)。
2. **client 必须是独立包**:`dsh-client-modules` 按"**包清单**声明 `dsh.client`"发现浏览器插件。
   若把 client 合进 host 作为子路径导出,host 入口与 client 共享同一份 package.json,host 入口会被
   误判为浏览器插件 → 浏览器端尝试加载 node 代码而炸掉。
3. **`link:` 禁用**:`link:./client` 写进发布物后,消费者无法解析本地相对路径。
   开发期由 profile 层对 host/client 分别 `link:` 保持本地开发;发布形态**移除**该依赖
   (client 由用户显式安装为顶层依赖),避免 `blockExoticSubdeps` 拦截。
4. **cordis 放 peer**:宿主(DSH + 官方插件)共用一份 cordis 实例;放 dependencies 会引入第二份,
   `Service` 类身份不同 → 注入/服务发现失配。
5. **repository 是纯元数据**:只有 npmjs/GitHub 页面与 `npm view` 读取;安装、加载、运行都不走它。
   改它不影响本地任何行为,但发布物必须填真实地址;仓库改名后本机 `git remote` 可能残留旧名
   (GitHub 对旧名 301 重定向,`git ls-remote` 仍能命中),此时以 GitHub 页面/`curl -I` 实测为准,
   并同步 remote 与 repository 字段。

## 4. 注意事项清单

- **三处一致性**:Release tag、4 个包的 `version`、用户安装命令中的资产名,必须完全一致
  (资产名 = `<包名>-<版本>.tgz`)。升级时同步改(仅本地自用时重跑 `release` 覆盖即可)。
- **pnpm 11 `blockExoticSubdeps`(默认 true)**:发布物 host **必须不含** client 依赖
  (URL 依赖在传递依赖位置会被拦截,`ERR_PNPM_EXOTIC_SUBDEP`);client 由用户显式安装为
  顶层依赖(`file:` 本地 tgz,顶层不受拦截)。
- 发布后无感:用 `pnpm release` 时 host manifest 由脚本**自动恢复为 `link:`**(已实测 end-to-end),
  本地开发与 profile 安装行为完全不变;手动流程则记得打完包改回。
- DSH 官方线升级(如 0.1.1-rc.2 → 0.2.0)时,先按 §0 的 semver 校验再批量更新 peer/dev 范围。
- 有 npm 账号时走 npm 线:带 scope 需 `publishConfig.access: public`;先发布 client 再发布 host,
  host 依赖写 semver 范围(参考官方 `docs/user/develop/basic/publish.zh.md`)。
- "常用症状对照"见 conventions 文档;与发布相关的补充:

| 症状 | 原因 | 处理 |
|---|---|---|
| 用户装了整套但插件不生效 | host 缺 `exports["./cordis.patch.yml"]` 或 client 未安装 | 按 §0 自检后重发;确认用户安装命令含 client |
| `pnpm pack` 报错退出 | prepack 守卫拦下 `link:`/`file:`/`workspace:` 依赖 | 移除该依赖后再打(这正说明守卫在工作) |
| 用户装 host 后缺 client 页签 | client 未显式安装,或资产名/tag 对不上 | 核对 §1 安装命令与 §4 一致性 |
| 用户安装报 `ERR_PNPM_EXOTIC_SUBDEP` | host 包仍带 client 依赖(旧发布物) | 用新 release 脚本重打 |
| 安装时版本告警/解析到旧版 | peer 范围不含当前 DSH 线(prerelease 元组规则) | semver 实测后对齐 |
