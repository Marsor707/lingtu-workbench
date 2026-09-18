# ADR 0013：sidecar 通过父进程监听自杀，避免覆盖安装时被占用

## 状态

已采用

## 背景

v1.0.5 用户走「设置 → 应用更新 → 下载 → 双击安装」覆盖安装 1.0.6 时，NSIS 报：

```
Error opening file for writing:
D:\灵图工作台\lingtu-server.exe
```

点「重试」必然重复报错，点「忽略」能装完。原因是安装期间 sidecar 仍然存活并锁住自己的映像文件。

链路如下：

1. 安装器 NSIS 的 `CheckIfAppIsRunning "${MAINBINARYNAME}.exe"` 只检查主程序 `lingtu-workbench.exe`，**不知道 sidecar 的存在**。它的强杀走 `nsis_tauri_utils::KillProcess`，底层是 `TerminateProcess`，不给进程任何收尾时机。
2. 本项目回收 sidecar 的唯一位置是 `RunEvent::Exit => stop_sidecar(app)`，而 `RunEvent::Exit` 由 tao 的 `Event::LoopDestroyed` 派发。被 `TerminateProcess` 掐死的进程不会进入事件循环销毁流程，**这一行永远不会执行**。
3. `tauri-plugin-shell` 在 Windows 上没有 Job Object（全量检索确认无 `AssignProcessToJobObject`），内核层面没有「父死子亡」保障。
4. sidecar 是 Node SEA 单文件可执行程序，无限期运行、不监听父进程、不处理 stdin EOF。

结果：sidecar 变孤儿，继续监听 8765 并锁住 `lingtu-server.exe`，NSIS 写该文件报共享冲突。用户点「忽略」跳过该文件后，安装目录里留下旧的 sidecar 配新的 launcher：由于版本号由 launcher 注入（`LINGTU_APP_VERSION` 取 `CARGO_PKG_VERSION`），此后「检查更新」会一直误报已是最新。**这是数据正确性问题，不只是安装体验问题。**

触发条件需要同时满足：走在线更新或覆盖安装同一 `INSTDIR`、用户在「程序正在运行」提示上选择关闭、版本发生过变更。新建安装、卸载后重装、安装前从托盘正常退出都不受影响。

## 决策

- **sidecar 自检父进程**：Rust 启动 sidecar 时注入 `LINGTU_PARENT_PID`（`std::process::id()`）；sidecar 检测到该变量才启用监听，检测不到就当作独立运行的服务。
- **主通道是 stdin EOF，不是 PID 轮询**：`tauri-plugin-shell` 用 `std::process::Command` + 管道 spawn sidecar，stdin 写端由启动器进程持有。启动器一死，内核立刻关闭写端，sidecar 收到 EOF。这与父进程消失**同步发生**，没有轮询间隔的滞后窗口——而安装器在杀进程后紧接着就写文件，滞后一秒就会复现同样的报错。
- **轮询仅作兜底**：1 秒一次的 `process.kill(pid, 0)` 存在活性检查，防管道不可用的情形；判定 `EPERM` 时仍视为存活，避免权限差异误杀。定时器 `unref()`，不拖住进程退出。
- **保留 `stop_sidecar`**：正常退出（托盘「退出」）仍由 Rust 主动回收，路径更干净；自杀机制只负责强杀这类不给收尾时机的场景。两条路径并存，后者是兜底而非替代。
- **不用 Job Object**：那是更彻底的内核级方案，但需要引入 `windows-sys` 依赖并只覆盖 Windows；本项目的 sidecar 逻辑是跨平台的，先用无依赖的通用方案，Job Object 留作后续可选加固。

## 结果

- 安装器强杀启动器后，sidecar 在百毫秒级自行退出，`lingtu-server.exe` 被释放，覆盖安装不再报写文件失败。
- 独立运行服务（开发期 `node dist-server/index.js`、测试里的 `startServer`）不受影响：不注入 `LINGTU_PARENT_PID` 就完全不启监听。
- 回归测试 `server/parent-watch.test.mjs` 起真实进程，用 SIGKILL 模拟 `TerminateProcess`，断言 sidecar 必须自行退出。已用变异验证过它具备「红」的能力：去掉监听后该测试会超时失败。
- 代价：sidecar 的 stdin 被占用为生命周期通道，将来若要给它加 stdin 协议（如交互式命令），需要改用独立管道或换回 Job Object。
- 代价：本机制对**已安装的 1.0.5 无效**——旧 sidecar 没有这段代码。它只能保证从 1.0.6 起不再出现该问题；1.0.5 用户升级到 1.0.6 时仍需按「忽略」或先手动退出。
- 未覆盖的相邻缺陷：`AppHandle::exit` 在事件循环不可达时会直接 `cleanup_before_exit()` + `std::process::exit()`，同样跳过 `RunEvent::Exit`。该路径同样会留下孤儿 sidecar，本次由 sidecar 自杀机制一并兜住。
