# 灵图工作台

灵图工作台是单用户、本地优先的跨平台图像生产工具，复刻参考软件的四种工作流：正常生图、改图、文生图和一裂多。用户双击启动器后使用系统浏览器访问本机 Web 页面，远程生图 API 由用户在本地配置，图片、任务和运行结果默认写入本机工作区。

## 技术栈

- 前端：React + Vite + TypeScript，当前页面使用自定义 CSS 和 `lucide-react`。
- 启动器：Tauri 2 常驻托盘程序，负责启动/监控 Node 服务、打开系统浏览器和回收服务进程。
- 本地 Web 服务：Node.js + TypeScript，使用 Node 原生 `node:http` 同时托管 Vite `dist` 静态资源和 REST + SSE API。
- 本地数据目标：SQLite + 本地文件系统。
- 本期不做 OpenCV、OCR 或本地视觉模型；合规检测作为后置可插拔能力，不阻塞生图主流程。

## 当前状态

截至 2026-08-31，仓库已切换到 Node/TypeScript 后端，并完成本地 Mock Provider 闭环：

- React/Vite/TypeScript 前端已通过 `POST /api/jobs` 提交真实任务，并通过 SSE 接收状态；真实 Provider 仍需用户自行配置后验证。
- Tauri 2 已配置 `externalBin`、托盘菜单和 Shell 插件；macOS 本机已验证 `.app` 能启动包内 sidecar、托管 `dist` 并打开浏览器，Windows runner 尚未在本机验证。
- `server/` 已提供 SQLite 任务元数据、异步任务编排、REST/SSE、OpenAI 兼容 Provider 适配器和 base64 图片落盘；API Key 仅在进程内存中使用，不写入任务快照。
- `src/data/builtin-prompts.ts` 已内置参考软件 v2.3.9 配置快照中的 79 条非空生成提示词，按类别和两宫格/四宫格/十五宫格布局标记；运行时不依赖参考软件目录。
- 迁移期间保留的 `backend/` Python 健康检查代码仅作为过渡证据，不属于目标生产技术栈；新增业务代码统一放在 `server/` 并使用 TypeScript。

## 本地开发

需要 Node.js LTS 和 npm。首次安装依赖：

```bash
npm ci
```

启动前端原型：

```bash
npm run dev
```

默认开发地址为 `http://localhost:5173`。

启动 Node 本地服务：

```bash
npm run backend:dev
```

该命令会先编译 `server/`，再启动本地服务。服务只监听 `127.0.0.1`，启动后输出包含端口的 ready JSON。

发布包启动流程：

```text
双击 Tauri 启动器 → 托盘常驻 → 启动 Node sidecar → 健康检查通过 → 打开系统浏览器
```

托盘菜单中的“打开灵图工作台”可重新打开页面，“退出”会停止 Node 服务并退出启动器。

## 测试与构建

前端构建：

```bash
npm run build
```

Node 后端单元/协议测试：

```bash
npm run backend:test
```

完整前端、后端和 sidecar 构建：

```bash
npm run build:desktop
```

当前测试使用 Node `node:test` 覆盖 HTTP 协议、异步 Mock Provider、SSE、取消、幂等和结果落盘；不使用真实 API Key、不上传真实图片、不发起真实计费请求。真实 Provider、Tauri 安装包和签名仍需分别验证，不能互相替代。

## 内置提示词

提示词库首屏直接加载 `src/data/builtin-prompts.ts`，包含参考软件中 79 条非空模板；空的“本地提示词”和“自定义提示词”槽位不会被迁移。迁移脚本 `scripts/import-reference-prompts.py` 只接受显式传入的外部快照路径，避免运行时或构建时依赖已下载的参考软件目录。

## Tauri 构建

开发模式：

```bash
npm run tauri dev
```

当前配置会先执行 `npm run build:desktop`，生成当前平台 Node SEA sidecar 后再构建安装包：

```bash
npm run tauri build
```

当前已完成：Node SEA sidecar 生成、`bundle.externalBin` 配置、`resources/dist` 静态资源打包、托盘启动器、浏览器就绪检查、Shell 执行权限和退出时 child 回收。动态端口、会话 token、shutdown 接口和正式签名仍待实现。

Tauri sidecar 文件名需要包含平台 target triple，例如：

```text
src-tauri/binaries/lingtu-server-aarch64-apple-darwin
src-tauri/binaries/lingtu-server-x86_64-apple-darwin
src-tauri/binaries/lingtu-server-x86_64-pc-windows-msvc.exe
```

当前构建得到的 macOS `.app` 已包含 Node 本地服务；Windows/Linux 产物需要在各自 CI runner 上验证。

## GitHub Actions 跨平台打包

没有 Windows 开发环境时，使用 GitHub Actions 的平台 runner：

- `macos-latest`：构建 Apple Silicon 和 Intel 的 macOS 包。
- `windows-latest`：构建 Windows x64 的 NSIS `.exe` 或 MSI 包。

每个平台的 job 都应执行 `npm ci`、构建对应平台的 Node sidecar、放置 target triple 文件，然后运行 `tauri build`。Windows 安装包由 Windows runner 生成，不依赖本地 Windows 机器。发布前再配置 macOS 签名/公证、Windows 代码签名和构建产物 SHA-256。

## 生图体验约束

- 提交后立即进入队列，显示总进度及每个任务项的独立状态。
- 单项失败不隐藏或回滚其他成功结果；结果落盘后才显示成功。
- 用户可以取消当前任务和后续队列，已落盘结果保留。
- 超时或连接中断进入待确认状态，不自动重复可能计费的请求。
- 重试由用户明确触发，并沿用原任务上下文和幂等键。
- 四种工作流共享队列、进度、失败、待确认和画廊体验。

## 安全边界

API Key 只能在本地服务内部注入 Provider 请求，不得进入前端响应、日志、错误信息、导出文件或任务快照。服务只监听 `127.0.0.1`。参考安装包目录中的凭据若仍有效，应先撤销/轮换；不要将密钥、`.env`、本地数据库、生成图片或运行日志提交到仓库。
