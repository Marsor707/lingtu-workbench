# ADR 0018：任务行里的源图 base64 不得进入列表查询

## 状态

已采用

## 背景

Windows 用户升级到 1.0.10 后，托盘显示「本地服务未就绪 · 本地服务进程意外退出（退出码 134）」，`launcher.log` 给出：

```
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
[7636:...] 10634 ms: Mark-Compact (reduce) 4094.4 (4106.4) -> 4094.4 (4103.4) MB
```

134 是 Node 的 `SIGABRT`，且崩溃发生在输出 ready JSON 之前——所以 `execution.log` 一个字都没有（`service_started` 写在 `startServer()` 之后），1.0.9 时期的「一直正在启动本地服务」是同一个崩溃的静默版。

链路：

1. 编辑任务把原图以 base64 存进 `jobs.request_json` 的 `sourceImage`（上限 8MB，base64 约 10.7MB）。
2. `createApp()` 启动时执行 `for (const job of store.list())` 以恢复未领取任务，而 `list()` 是 `SELECT * FROM jobs ORDER BY created_at DESC`。
3. `node:sqlite` 的 `.all()` 会把每一行的 `request_json` 物化成 JS 字符串。该用户 5768 条任务里约 3000 条是编辑任务，数据库约 6–10GB，物化量级远超 Windows 默认 4094MB 堆上限。
4. 同一个 `SELECT *` 还被 `GET /api/jobs`、`retryFailed`、`DELETE` 类批量接口复用，即使侥幸起来，页面一加载也会崩。

变异验证：把 `list()` 改回 `SELECT *`，仅 60 条 × 2MB 原图就让 `list()` 的堆增长 **355MB**（SQLite 返回 UTF-16 字符串，约 3 倍膨胀），按用户规模推算正好 4GB+。

## 决策

- **列表查询统一走 `JOB_SUMMARY_COLUMNS`**：`json_remove(request_json, '$.sourceImage') AS request_json`，配合显式列名，让源图 base64 永远不离开 SQLite。不改表结构、不写迁移：`json_remove` 对不含该键的行是幂等的，新旧数据同一套 SQL 都能跑。
- **启动恢复不再透视整张表**：新增 `JobStore.queuedJobIds()`，用 SQL 判定「有 prompt 或有 windows」的 `queued` 任务，只返回 id。用 `json_valid()` 兜住历史脏 JSON，避免一条坏记录让整个服务起不来。
- **需要原图的路径仍然走单条 `get(id)` / `request(id)`**：重试、执行都按主键取一行，量级有界。
- **`READY_TIMEOUT` 从 20 秒提到 60 秒**：几个 GB 的库打开 + WAL 回收本身就要几十秒，20 秒会把「正在恢复」误报成「没起来」。

## 结果

- 大历史库（GB 级）也能启动，`/api/jobs` 响应从「把源图全部读进堆」变成只含摘要字段（几千条约几 MB）。
- 托盘在 sidecar 崩溃时会带上 stderr 首行（如 `退出码 134：FATAL ERROR: Reached heap limit ...`），同类问题下次一张截图即可定位。
- 代价：源图仍在数据库里长期累积，库体积只增不减；重装备份、磁盘占用都受此影响。**根治需要把源图落盘成文件、行里只存相对路径**，涉及创建/重试/执行三条路径与旧数据迁移，单独立项。
- 未覆盖：`/api/jobs` 仍未分页。几千条摘要约几 MB，可接受；上万条时需要加游标分页。
- 未覆盖：`stats()` 仍扫全表的两列（`status`、`results_json`），量级小，暂不动。
