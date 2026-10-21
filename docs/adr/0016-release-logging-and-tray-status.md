# ADR 0016：release 版日志落盘与托盘状态可见化

## 状态

已采用

## 背景

Windows 用户反馈「打开 exe 一直提示正在启动本地服务，重启电脑也没用」，附带的 `execution.log` 只有任务事件，最后一条停在 `2026-10-20T23:08:11`，**10-21 全天零记录**。这意味着本地服务当天一次都没有正常起来，但开发者手上没有任何启动链路的证据：

1. `run()` 里 `if cfg!(debug_assertions) { plugin log }`，**release 包完全不写日志**，`log::error!` 全部丢弃。
2. sidecar 的 stderr 只 `emit` 给一个不存在的 webview（`app.windows` 为空），Node 崩溃的堆栈直接蒸发。
3. `CommandEvent::Terminated(_)` 丢掉了退出码，无法区分「正常结束」「崩溃」「被杀」。
4. 启动事实（版本、数据库路径、静态目录）从未记录，连「重新配提示词」这类问题都没法确认数据落在哪。
5. 托盘 tooltip 是 Windows shell 缓存的一次性文本，用户能看到的只有「正在启动本地服务」；真实状态（如「未就绪」）和原因都无处呈现。

## 决策

- **日志在 release 也落盘**：`tauri-plugin-log` 从 `setup` 里的 debug 分支提到 builder 链，targets = `Stdout` + `LogDir{launcher}`，单文件 5MB 轮转。Windows 路径为 `%LOCALAPPDATA%\com.lingtu.workbench\logs\launcher.log`。
- **启动事实一次性打全**：版本、日志目录、数据目录、数据库路径、工作区、静态目录、是否检测到系统代理、8765 探测结果。就绪日志同时记录**启动器版本与服务版本**，用来识别「新启动器配旧 sidecar」。
- **sidecar 的输出全部落盘**：stdout 非 ready 行按 info 记录，stderr 按 error 记录（截断到 240 字符，避免整段堆栈淹没关键行），`Terminated` 记录 `code`/`signal` 并写进托盘原因。
- **托盘改成两面可信**：tooltip 保持原样，但新增一个禁用的「状态」菜单项，文案由状态纯函数推导（`状态：运行中 · http://127.0.0.1:<port>`、`状态：本地服务未就绪 · <原因>`、`状态：检测到旧版本服务在运行（v1.0.8）`）。菜单项每次右键都重新读取，不受 shell tooltip 缓存影响。
- **未就绪必须带原因**：`ServiceStatus` 增加 `detail`，取值为「本地服务进程意外退出（退出码 N）」「20 秒内没有输出就绪信息」「端口 8765 未被释放」「启动失败：<错误>」「本地服务已无响应」「未找到旧版本服务进程」。
- **就绪时先开浏览器、后更新托盘**：托盘更新是同步的跨线程 shell 调用，万一卡住不能连带让用户拿不到页面。
- **托盘增「打开日志目录」「打开数据目录」**：release 包没有可见控制台，这是非技术用户唯一能回传一手证据的入口。
- **sidecar 启动记录写进执行日志**：`service_started` 带 `version` / `port` / `pid` / `dbPath`，启动失败写 `service_start_failed` 带错误信息。这样即使只拿到 `workspace/logs/execution.log`，也能分清「压根没起来」和「起来了但页面打不开」。

## 结果

- 下一次同类反馈只需要两份文件：`launcher.log` 与 `execution.log`。前者能定位到「进程没起来 / 起来了没就绪 / 就绪了但浏览器没开」，后者给出 dbPath 与版本。
- 代价：release 包开始产生磁盘写。日志 5MB 轮转、只保留一个历史文件，可接受。
- 代价：托盘菜单从 3 项变 6 项，略长；但状态项是这份 ADR 的核心收益。
- 未覆盖：「托盘更新调用本身卡死」这类极端情况仍只能靠 `托盘状态: ...` 与 `托盘已更新` 两条日志的缺口来推断，尚未做异步化改造。
