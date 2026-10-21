# ADR 0017：用户数据迁到与安装目录、卸载器都无关的目录

## 状态

已采用

## 背景

用户反馈「每次安装都要重新配置提示词」，补充信息是**重装时选了一个新的安装文件夹**。核对 Tauri 的 NSIS 模板（`crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi`）后，链路是确定的：

1. 换安装文件夹必然经过「已有安装，如何处理」页面；用户选择「卸载后再安装」后，安装器执行 `ExecWait '$R1 $INSTDIR _?=$4'`，**没有 `/S`**，于是弹出的是**带界面的卸载器**。
2. 那个界面上有「删除应用数据」勾选框。勾上后在 `Section Uninstall` 里执行：`RmDir /r "$APPDATA\${BUNDLEID}"`、`RmDir /r "$LOCALAPPDATA\${BUNDLEID}"`。
3. 而我们的用户数据正好住在这两个目录里：
   - 数据库（提示词库、供应商与 API Key、任务历史）在 `%APPDATA%\com.lingtu.workbench\lingtu.db`；
   - WebView2 与 localStorage（界面偏好）在 `%LOCALAPPDATA%\com.lingtu.workbench`。
4. 另外，`workspace`（生成的图片、`execution.log`）用的是相对路径 `resolve('workspace')`，会跟着安装目录（Windows 快捷方式的「起始位置」= `$INSTDIR`）跑，换文件夹后历史任务里的图片全部变死链接。

即：「用户数据目录」与「卸载器删除范围」重叠，一次勾选就把提示词清零；图片则被安装目录绑死。

## 决策

- **数据根目录固定为 `local_data_dir()/lingtu-workbench-data`**（Windows：`%LOCALAPPDATA%\lingtu-workbench-data`；macOS：`~/Library/Application Support/lingtu-workbench-data`）。目录名刻意**不等于** bundle identifier，因为卸载器只递归删除 `$APPDATA\<identifier>` 与 `$LOCALAPPDATA\<identifier>`。
- **数据库与 workspace 同住数据根目录**：`lingtu.db` 与 `workspace/`。启动器通过 `LINGTU_DB_PATH` / `LINGTU_WORKSPACE` 两个环境变量传给 sidecar，workspace 不再相对当前工作目录解析。
- **首次启动做一次性迁移**：新目录没有数据库、而旧位置有数据时，复制 `lingtu.db`、`lingtu.db-wal`、`lingtu.db-shm`，以及两处可能的 workspace（旧 appdata 下的 `workspace`、当前 exe 同级的 `workspace`）。
  - **迁移时机固定在「确定要自己拉起服务」的那一刻**：先探 8765，只有确认没人在监听才迁移。旧实例还在跑时复制数据库会拿到不一致的 WAL 快照，宁可晚一步也不能搬出一个坏库。
  - 只复制不移动，旧文件保留：删除属于用户的决定。
  - 目标已存在则跳过，不用旧数据覆盖新数据。
  - **迁移失败时回退使用旧目录**：换目录失败绝不能表现成「提示词全没了」。
- **数据目录可从托盘打开**（「打开数据目录」），与「打开日志目录」并列，用户重装或换盘时能找到历史图片。

## 结果

- 覆盖安装、卸载后重装、换安装文件夹，都不再影响数据库与图片：数据位置与安装位置彻底解耦。
- 已丢过一次数据的用户拿不回来（旧目录已被 `RmDir /r`），但从本版本起不会再发生；迁移逻辑保证升级到本版本的存量用户无感。
- 代价：卸载后数据会留在 `%LOCALAPPDATA%\lingtu-workbench-data`，需要用户手动清理才能「彻底删除」。这是刻意选择：数据安全优先于卸载洁净度。
- 代价：`DB + 图片`从 Roaming 挪到 Local，不再随域漫游配置文件同步。图片体积大，本来也不适合漫游。
- 未覆盖：迁移只认上述两处旧 workspace。若用户把旧安装目录搬到了别处，历史图片需要手动拷进数据目录。
