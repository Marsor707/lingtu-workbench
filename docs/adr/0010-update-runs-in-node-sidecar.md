# ADR 0010：更新能力由本地 Node 服务承载而非 Tauri

## 状态

已采用

## 背景

检查更新需要两件系统能力：出站网络请求和把安装包写到下载目录。直觉上应该放进 Tauri（Rust）侧，那里有真实的进程与环境。

但本项目的界面运行在**系统默认浏览器**中，不是 Tauri WebView。应用启动后由 Rust 拉起 Node sidecar 并打开浏览器标签页，`src/` 下没有任何 `@tauri-apps/*` 引用，页面的 `window.__TAURI_INTERNALS__` 永远不存在。即使 Rust 暴露 `#[tauri::command]`，页面也没有调用通路。

同时，sidecar 早已是一个完整的 Node 运行时：它持有数据库、负责所有 Provider 出站请求，并且 Rust 会为它注入系统代理环境变量（`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`，macOS 与 Windows 各有探测逻辑）。

另一个约束是 Node 的 SEA（单文件可执行）形态：官方文档明确 SEA 注入脚本**只能加载内建模块**，`require`/`import` 不到文件系统里的模块。因此 sidecar 里能用的只有 `node:*` 内建能力，没有第三方库。

## 决策

- **更新逻辑全部放在 Node sidecar**：`server/update.ts` 提供版本比较、更新源解析、检查与流式下载；`server/index.ts` 暴露 `GET /api/update/check` 与 `POST /api/update/download`。前端只与 `127.0.0.1:8765` 通信。
- **下载地址由服务端重新解析**：下载接口只接受版本号，服务端重新拉取更新源并比对，不接受前端传入的 URL。
- **不新增任何 Tauri 命令**：`open_update_artifact`（在文件管理器里定位安装包）**明确不做**——在实际发布形态下它的前端分支永远不会执行，写了就是死代码。前端只提供"复制路径 + 展示完整路径"。
- **只使用 Node 内建模块**：下载用内建 `fetch` 配合 `node:stream/promises` 的 `pipeline` 写盘，不引入依赖（SEA 限制）。

## 结果

- Rust 侧本次只多了一行：向 sidecar 注入 `LINGTU_APP_VERSION`（取自 `CARGO_PKG_VERSION`），保证运行时版本号与安装包一致。
- 代理支持是白拿的：Node 的 `fetch` 走 sidecar 已有的代理环境变量，不需要在 Rust 里新写一套网络栈。
- 代价：所有需要系统权限的桌面能力（打开文件夹、托盘联动、窗口控制）都无法从页面触达。将来若要改回 Tauri WebView 主窗口，这是需要一并重新评估的一条线。
- 代价：更新包的"打开/定位"体验止步于复制路径。这是浏览器形态下的能力上限，不是实现取舍。
