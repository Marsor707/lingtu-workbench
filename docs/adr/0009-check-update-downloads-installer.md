# ADR 0009：检查更新只下发安装包，不就地更新应用

## 状态

已采用

## 背景

灵图工作台发布在 GitHub Release 上并要求支持「在设置里检查更新，有新版就点一下更新」。Tauri 自带 updater 插件能原地替换整个应用，但它的更新包**必须签名**（插件强制校验，无法关闭）：需要一对长期密钥，私钥进 GitHub Secrets，公钥烧进 `tauri.conf.json`。密钥一旦丢失，已安装的用户将永远无法再收到更新。项目当前没有 macOS Developer ID 证书，产出的是 ad-hoc 签名包。

同时，本项目的界面运行在**系统默认浏览器**里，而不是 Tauri WebView 内（`lib.rs` 的 `open_browser`），`src/` 下没有任何 `@tauri-apps/*` 引用，页面拿不到 Tauri IPC。任何需要系统权限的能力都得另开通道。

## 决策

- **只做"检查 + 下载"，不做就地更新**：客户端比对版本后把安装包下载到本机下载目录，由用户手动双击安装。由此**不需要签名密钥，也不需要引入 updater 插件**。
- **检查更新的唯一事实来源是自建的 `latest.json`**，随 Release 发布，客户端固定请求 `releases/latest/download/latest.json`。不直接读 GitHub API，也不依赖 Tauri 对安装包的命名规则——真实资产名是 `_1.0.4_aarch64.dmg` 这种由中文 `productName` 剥离出来的形式，属于实现细节，不能固化进已发行的客户端。
- **该能力由本地 Node 服务承载，而不是 Tauri**：检查与下载都是 Node 侧出站请求，复用既有 sidecar 的代理环境（`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`，由 Rust 注入），前端只跟 `127.0.0.1:8765` 打交道。这绕开了"页面调不到 Tauri IPC"的限制。
- **下载走 Node 的 `fetch` 流式写盘 + SSE 进度**，SSE 复用既有 `dataEvent` 形状；下载状态放在前端 App 层，关掉设置弹窗不中断下载。
- **`latest.json` 额外带 `min_supported_version`**：低于它的客户端提示手动重装，而不是引导下载一个装不上的包。当前填首个带本能力的版本号。
- **下载落盘到系统下载目录**，不进工作区（更新包不是工作产物）。文件名只取 basename，防止更新源用路径穿越写到别处。

## 结果

- 版本号三处清单文件（`package.json`、`Cargo.toml`、`tauri.conf.json`）必须一致，由 `scripts/version.mjs` 同步并在 `build:desktop` 前置断言；不一致会让检查更新静默失灵。
- **本能力只能对已安装该版本的客户端生效**：装了 v1.0.4 及更早版本的用户收不到任何提示，下一个版本必须手动分发一次，自动更新从此版本之后才开始工作。
- 将来若要升级为就地更新，已装机用户仍需手动安装一次；updater 没有追溯能力。届时需要补密钥、`createUpdaterArtifacts` 与签名后的 `.tar.gz`/`.sig` 产物。
- macOS 从 dmg 首装仍可能被 Gatekeeper 拦截（无 Developer ID 签名），属于已知限制，与更新机制无关。
