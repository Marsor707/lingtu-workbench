use std::{
  io::{Read, Write},
  net::TcpStream,
  process::Command,
  sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
  },
  time::{Duration, Instant},
};

use tauri::{
  menu::{Menu, MenuItem},
  tray::TrayIconBuilder,
  Manager,
};
use tauri_plugin_log::{Target, TargetKind};
use tauri_plugin_shell::{
  process::{CommandChild, CommandEvent},
  ShellExt,
};

#[cfg(target_os = "windows")]
use winreg::{enums::HKEY_CURRENT_USER, RegKey};

const SERVER_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 8765;
const HEALTH_PATH: &str = "/health";
const TRAY_ID: &str = "lingtu-tray";
/// 启动器等待 sidecar 输出 ready JSON 的上限。超时后托盘进入「未就绪」，不再静默。
/// 给到 60 秒：历史库可能有几个 GB（源图 base64 存在任务行里），SQLite 打开并回收 WAL
/// 本身就要几十秒，20 秒会把「正在慢慢恢复」误报成「没起来」。
const READY_TIMEOUT: Duration = Duration::from_secs(60);
/// 本地 HTTP 探测的单次连接与读取超时。
const PROBE_TIMEOUT: Duration = Duration::from_millis(300);
/// 重启时等待旧进程释放端口的上限。
const PORT_FREE_TIMEOUT: Duration = Duration::from_secs(3);
/// 就绪后刷新执行中任务数的间隔，它决定「重启本地服务」是否可用。
const REFRESH_INTERVAL: Duration = Duration::from_secs(2);
/// 日志与托盘文案里附带的错误原文上限：一行 stdout 可能是整段堆栈，原样照抄会淹没关键信息。
const BRIEF_CHARS: usize = 240;
/// stderr 落盘时允许更长：Node 的 FATAL ERROR 后面常跟着几行堆栈，托盘只取首行，日志要留全。
const STDERR_LOG_CHARS: usize = 1200;
/// 用户数据目录名。
///
/// 刻意**不**等于 bundle identifier：NSIS 卸载器在用户勾选「删除应用数据」时会
/// `RmDir /r "$APPDATA\<identifier>"` 与 `$LOCALAPPDATA\<identifier>`，数据库和图片
/// 原先就在这两个目录里，于是「先卸载再装」（重装选新文件夹必经此页）等于清空提示词库。
const DATA_ROOT_NAME: &str = "lingtu-workbench-data";

#[cfg(any(target_os = "windows", target_os = "macos", test))]
#[derive(Debug, PartialEq)]
struct ProxyEnvironment {
  http_proxy: Option<String>,
  https_proxy: Option<String>,
}

#[cfg(any(target_os = "windows", target_os = "macos", test))]
fn normalize_proxy_url(value: &str) -> Option<String> {
  let value = value.trim();
  if value.is_empty() {
    return None;
  }
  if value.contains("://") {
    Some(value.to_owned())
  } else {
    Some(format!("http://{value}"))
  }
}

#[cfg(any(target_os = "windows", target_os = "macos", test))]
fn build_proxy_environment(http_proxy: Option<String>, https_proxy: Option<String>) -> Option<ProxyEnvironment> {
  if http_proxy.is_none() && https_proxy.is_none() {
    return None;
  }
  Some(ProxyEnvironment { http_proxy, https_proxy })
}

/// 检测到的系统代理地址，作为应用内「网络代理」设置的默认值。
/// 出口最终由 sidecar 内的应用配置决定，这里不再注入 HTTP_PROXY 等进程环境变量。
#[cfg(any(target_os = "windows", target_os = "macos"))]
fn detected_proxy_url() -> Option<String> {
  system_proxy().and_then(|proxy| proxy.https_proxy.or(proxy.http_proxy))
}

#[cfg(any(target_os = "windows", test))]
fn parse_proxy_server(proxy_server: &str) -> Option<ProxyEnvironment> {
  let mut http_proxy = None;
  let mut https_proxy = None;

  if proxy_server.contains('=') {
    for entry in proxy_server.split(';') {
      let Some((protocol, address)) = entry.split_once('=') else {
        continue;
      };
      match protocol.trim().to_ascii_lowercase().as_str() {
        "http" => http_proxy = normalize_proxy_url(address),
        "https" => https_proxy = normalize_proxy_url(address),
        _ => {}
      }
    }
  } else {
    let proxy = normalize_proxy_url(proxy_server)?;
    http_proxy = Some(proxy.clone());
    https_proxy = Some(proxy);
  }

  build_proxy_environment(http_proxy, https_proxy)
}

#[cfg(target_os = "windows")]
fn windows_system_proxy() -> Option<ProxyEnvironment> {
  let current_user = RegKey::predef(HKEY_CURRENT_USER);
  let settings = current_user
    .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings")
    .ok()?;
  let enabled = settings.get_value::<u32, _>("ProxyEnable").ok()?;
  if enabled == 0 {
    return None;
  }
  let server = settings.get_value::<String, _>("ProxyServer").ok()?;
  parse_proxy_server(&server)
}

#[cfg(target_os = "macos")]
fn macos_system_proxy() -> Option<ProxyEnvironment> {
  let output = Command::new("/usr/sbin/scutil").arg("--proxy").output().ok()?;
  if !output.status.success() {
    return None;
  }

  let text = String::from_utf8_lossy(&output.stdout);
  let values = text
    .lines()
    .filter_map(|line| line.trim().split_once(':'))
    .map(|(key, value)| (key.trim(), value.trim()))
    .collect::<std::collections::HashMap<_, _>>();
  let proxy = |enabled_key: &str, host_key: &str, port_key: &str| {
    if values.get(enabled_key).copied() != Some("1") {
      return None;
    }
    let host = values.get(host_key).copied()?;
    let port = values.get(port_key).copied()?.parse::<u16>().ok()?;
    let host = if host.contains(':') && !host.starts_with('[') { format!("[{host}]") } else { host.to_owned() };
    normalize_proxy_url(&format!("{host}:{port}"))
  };

  build_proxy_environment(proxy("HTTPEnable", "HTTPProxy", "HTTPPort"), proxy("HTTPSEnable", "HTTPSProxy", "HTTPSPort"))
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn system_proxy() -> Option<ProxyEnvironment> {
  #[cfg(target_os = "windows")]
  { windows_system_proxy() }
  #[cfg(target_os = "macos")]
  { macos_system_proxy() }
}

/// 本地服务的阶段。托盘的全部文案都由它推导。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ServicePhase {
  Starting,
  Ready,
  NotReady,
  Restarting,
  ForeignVersion,
}

/// 托盘需要表达的事实：阶段、真实端口、执行中任务数，以及旧实例的身份。
#[derive(Clone, Debug, PartialEq, Eq)]
struct ServiceStatus {
  phase: ServicePhase,
  port: Option<u16>,
  running_jobs: u32,
  /// 「启动中」的起点，供就绪超时兜底判断是不是这一次启动还没就绪。
  started_at: Option<Instant>,
  /// 旧版本实例的 (pid, version)，用于接管前复核身份。
  foreign: Option<(u32, String)>,
  /// 未就绪的具体原因。写进托盘菜单的状态项，让用户不必翻日志也能说清现象。
  detail: Option<String>,
}

impl ServiceStatus {
  fn starting() -> Self {
    Self { phase: ServicePhase::Starting, port: None, running_jobs: 0, started_at: Some(Instant::now()), foreign: None, detail: None }
  }

  fn ready(port: u16, running_jobs: u32) -> Self {
    Self { phase: ServicePhase::Ready, port: Some(port), running_jobs, started_at: None, foreign: None, detail: None }
  }

  fn not_ready(detail: impl Into<String>) -> Self {
    Self { phase: ServicePhase::NotReady, port: None, running_jobs: 0, started_at: None, foreign: None, detail: Some(detail.into()) }
  }

  fn restarting() -> Self {
    Self { phase: ServicePhase::Restarting, port: None, running_jobs: 0, started_at: None, foreign: None, detail: None }
  }

  fn foreign(pid: u32, version: String) -> Self {
    Self { phase: ServicePhase::ForeignVersion, port: Some(DEFAULT_PORT), running_jobs: 0, started_at: None, foreign: Some((pid, version)), detail: None }
  }

  fn detail_text(&self) -> String {
    self.detail.clone().unwrap_or_else(|| "原因未知".to_owned())
  }
}

/// 托盘文案。抽成纯函数，让状态与文案的对应关系由单测锁住，而不是每次手工点。
///
/// `status` 是菜单里那个禁用状态项的文案：Windows 的托盘 tooltip 只在悬停时出现、
/// 且由 shell 缓存，用户反馈「一直显示正在启动本地服务」时无法判断是状态真的没变化
/// 还是 tooltip 没刷新；菜单项每次右键都重新读取，是可信的那一面。
struct MenuView {
  tooltip: String,
  status: String,
  open_label: &'static str,
  open_enabled: bool,
  restart_label: &'static str,
  restart_enabled: bool,
}

fn menu_view(status: &ServiceStatus) -> MenuView {
  let make = |tooltip: String, open_label: &'static str, open_enabled: bool, restart_label: &'static str, restart_enabled: bool| MenuView {
    status: status_text(status),
    tooltip,
    open_label,
    open_enabled,
    restart_label,
    restart_enabled,
  };

  match status.phase {
    ServicePhase::Starting => make("灵图工作台 · 正在启动本地服务".to_owned(), "打开灵图工作台", false, "重启本地服务", false),
    ServicePhase::Restarting => make("灵图工作台 · 正在重启本地服务".to_owned(), "打开灵图工作台", false, "重启本地服务", false),
    // 有任务执行中时禁止重启：被中断的 running 任务不会被服务端恢复，只会永久停在执行中。
    ServicePhase::Ready if status.running_jobs > 0 => make(format!("灵图工作台 · 有 {} 个任务执行中", status.running_jobs), "打开灵图工作台", true, "重启本地服务（有任务执行中）", false),
    ServicePhase::Ready => make("灵图工作台".to_owned(), "打开灵图工作台", true, "重启本地服务", true),
    // 未就绪时主项改为「重启并打开」，避免把用户指向一个拒绝连接的页面。
    ServicePhase::NotReady => make(format!("灵图工作台 · 本地服务未就绪（{}）", status.detail_text()), "重启并打开灵图工作台", true, "重启本地服务", true),
    ServicePhase::ForeignVersion => make("灵图工作台 · 检测到旧版本服务在运行".to_owned(), "打开灵图工作台", true, "重启本地服务", true),
  }
}

/// 菜单里的状态项文案。就绪时带上真实端口，因为回退端口后手输 8765 不再可靠。
fn status_text(status: &ServiceStatus) -> String {
  match status.phase {
    ServicePhase::Starting => "状态：正在启动本地服务".to_owned(),
    ServicePhase::Restarting => "状态：正在重启本地服务".to_owned(),
    ServicePhase::Ready if status.running_jobs > 0 => format!("状态：运行中 · {} 个任务执行中", status.running_jobs),
    ServicePhase::Ready => format!("状态：运行中 · {}", server_url(status.port.unwrap_or(DEFAULT_PORT))),
    ServicePhase::NotReady => format!("状态：本地服务未就绪 · {}", status.detail_text()),
    ServicePhase::ForeignVersion => match &status.foreign {
      Some((_, version)) => format!("状态：检测到旧版本服务在运行（v{version}）"),
      None => "状态：检测到旧版本服务在运行".to_owned(),
    },
  }
}

/// 截断一段可能很长的一行输出（堆栈、JSON），供日志与托盘文案使用。
fn brief(text: &str, max_chars: usize) -> String {
  let trimmed = text.trim();
  let mut brief = trimmed.chars().take(max_chars).collect::<String>();
  if trimmed.chars().count() > max_chars {
    brief.push('…');
  }
  brief
}

/// sidecar 就绪时会在 stdout 打一行 ready JSON。端口以它为准，启动器不再硬编码。
fn parse_ready_line(line: &str) -> Option<u16> {
  let value: serde_json::Value = serde_json::from_str(line).ok()?;
  if !value.get("ready")?.as_bool()? {
    return None;
  }
  u16::try_from(value.get("port")?.as_u64()?).ok()
}

/// `/health` 里启动器关心的字段。
#[derive(Debug, PartialEq, Eq)]
struct Health {
  version: String,
  pid: u32,
  running_jobs: u32,
}

/// 探测某个端口上的本地服务。只用于识别「8765 上是不是自己人」和刷新任务数，
/// 「服务是否就绪」一律以 ready JSON 为准。
fn probe_health(port: u16) -> Option<Health> {
  let address = format!("{SERVER_HOST}:{port}");
  let mut stream = TcpStream::connect_timeout(&address.parse().ok()?, PROBE_TIMEOUT).ok()?;
  let _ = stream.set_read_timeout(Some(PROBE_TIMEOUT));
  let request = format!("GET {HEALTH_PATH} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n");
  stream.write_all(request.as_bytes()).ok()?;

  let mut response = Vec::new();
  let mut chunk = [0_u8; 512];
  loop {
    match stream.read(&mut chunk) {
      Ok(0) => break,
      Ok(size) => response.extend_from_slice(&chunk[..size]),
      // 读超时只说明响应到此为止，已经收到的字节仍然可以解析。
      Err(_) => break,
    }
  }

  let text = String::from_utf8_lossy(&response);
  let (head, body) = text.split_once("\r\n\r\n")?;
  if !head.starts_with("HTTP/1.1 200") {
    return None;
  }
  let value: serde_json::Value = serde_json::from_str(body.trim()).ok()?;
  if value.get("service")?.as_str()? != "lingtu-workbench" {
    return None;
  }
  Some(Health {
    version: value.get("version").and_then(|item| item.as_str()).unwrap_or_default().to_owned(),
    pid: value.get("pid").and_then(|item| item.as_u64()).and_then(|pid| u32::try_from(pid).ok()).unwrap_or_default(),
    running_jobs: value.get("runningJobs").and_then(|item| item.as_u64()).unwrap_or_default() as u32,
  })
}

fn is_port_listening(port: u16) -> bool {
  TcpStream::connect_timeout(&socket_address(port), PROBE_TIMEOUT).is_ok()
}

fn socket_address(port: u16) -> std::net::SocketAddr {
  format!("{SERVER_HOST}:{port}").parse().expect("本地服务地址由固定主机与端口拼成，必须有效")
}

/// 等到端口没人监听为止；接管旧实例后必须确认端口真的释放，否则会在别的端口上再起一个服务。
fn wait_port_free(port: u16, timeout: Duration) -> bool {
  let deadline = Instant::now() + timeout;
  loop {
    if !is_port_listening(port) {
      return true;
    }
    if Instant::now() >= deadline {
      return false;
    }
    std::thread::sleep(Duration::from_millis(100));
  }
}

fn server_url(port: u16) -> String {
  format!("http://{SERVER_HOST}:{port}")
}

fn open_browser(port: u16) -> Result<(), String> {
  let url = server_url(port);

  #[cfg(target_os = "windows")]
  let mut command = {
    let mut command = Command::new("cmd");
    command.args(["/C", "start", "", url.as_str()]);
    command
  };

  #[cfg(target_os = "macos")]
  let mut command = {
    let mut command = Command::new("open");
    command.arg(&url);
    command
  };

  #[cfg(target_os = "linux")]
  let mut command = {
    let mut command = Command::new("xdg-open");
    command.arg(&url);
    command
  };

  #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
  return Err("当前平台没有可用的默认浏览器启动方式".to_owned());

  command
    .spawn()
    .map(|_| ())
    .map_err(|error| format!("启动默认浏览器失败: {error}"))
}

fn kill_process_by_pid(pid: u32) -> Result<(), String> {
  let pid_text = pid.to_string();

  #[cfg(target_os = "windows")]
  let output = Command::new("taskkill").args(["/PID", pid_text.as_str(), "/F"]).output();

  #[cfg(not(target_os = "windows"))]
  let output = Command::new("kill").arg(pid_text.as_str()).output();

  let output = output.map_err(|error| format!("结束旧版本服务失败: {error}"))?;
  if output.status.success() {
    Ok(())
  } else {
    Err(format!("结束旧版本服务失败: {}", String::from_utf8_lossy(&output.stderr).trim()))
  }
}

/// 递归复制目录。迁移只能复制不能移动：旧目录保留，出错时两边都还在。
fn copy_directory(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
  std::fs::create_dir_all(to)?;
  for entry in std::fs::read_dir(from)? {
    let entry = entry?;
    let destination = to.join(entry.file_name());
    if entry.file_type()?.is_dir() {
      copy_directory(&entry.path(), &destination)?;
    } else if !destination.exists() {
      std::fs::copy(entry.path(), &destination)?;
    }
  }
  Ok(())
}

/// 把旧位置的数据搬到新的用户数据目录：数据库三件套 + 两处可能的 workspace。
///
/// 两处 workspace 分别是：旧版 appdata 下的 workspace，和安装目录里的 workspace
/// （历史上 workspace 是相对当前工作目录解析的，跟着安装目录跑）。
fn migrate_legacy_data(
  legacy_app_data: &std::path::Path,
  install_workspace: Option<&std::path::Path>,
  target: &std::path::Path,
) -> Result<(), String> {
  std::fs::create_dir_all(target).map_err(|error| format!("创建数据目录失败: {error}"))?;
  // 数据库的 -wal / -shm 必须一起搬，否则 WAL 里的已提交事务会丢。
  for name in ["lingtu.db", "lingtu.db-wal", "lingtu.db-shm"] {
    let source = legacy_app_data.join(name);
    let destination = target.join(name);
    if source.exists() && !destination.exists() {
      std::fs::copy(&source, &destination).map_err(|error| format!("复制 {name} 失败: {error}"))?;
      log::info!("已迁移 {}", source.display());
    }
  }
  let target_workspace = target.join("workspace");
  let mut sources = vec![legacy_app_data.join("workspace")];
  if let Some(install_workspace) = install_workspace {
    sources.push(install_workspace.to_path_buf());
  }
  for source in sources {
    if source.is_dir() && !target_workspace.exists() {
      copy_directory(&source, &target_workspace).map_err(|error| format!("复制 {} 失败: {error}", source.display()))?;
      log::info!("已迁移 {}", source.display());
    }
  }
  Ok(())
}

/// 用户数据根目录（数据库 + 生成的图片）。
///
/// 选择 `$LOCALAPPDATA\lingtu-workbench-data` 而不是 `%APPDATA%\<identifier>`：
/// 后者正是 NSIS 卸载器「删除应用数据」要递归删除的目录，而重装选新文件夹必经该选项。
///
/// `migrate = false` 时只算路径不搬数据：旧版实例还在跑时复制数据库会拿到不一致的快照。
fn resolve_data_root(paths: &tauri::path::PathResolver<tauri::Wry>, migrate: bool) -> tauri::Result<std::path::PathBuf> {
  let legacy = paths.app_data_dir()?;
  let target = paths.local_data_dir()?.join(DATA_ROOT_NAME);
  if !migrate {
    return Ok(target);
  }
  let install_workspace = std::env::current_exe().ok().and_then(|exe| exe.parent().map(|directory| directory.join("workspace")));
  let legacy_workspace = install_workspace.as_ref().map(|path| path.is_dir()).unwrap_or(false);
  // 已经有新数据库就什么都不做；否则只要旧位置有数据就迁移一次。
  let needs_migration = !target.join("lingtu.db").exists() && (legacy.join("lingtu.db").exists() || legacy_workspace);
  if !needs_migration {
    return Ok(target);
  }
  match migrate_legacy_data(&legacy, install_workspace.as_deref(), &target) {
    Ok(()) => Ok(target),
    // 迁移失败宁可继续用旧目录：换目录失败绝不能表现成「提示词全没了」。
    Err(error) => {
      log::error!("迁移用户数据失败，继续使用旧目录（{}）: {error}", legacy.display());
      Ok(legacy)
    }
  }
}

/// 解析数据目录与 sidecar 启动参数。
/// `migrate = true` 用于「确定要自己拉起服务」的时刻，重启/接管旧实例后同样适用。
fn resolve_sidecar_paths(app: &tauri::AppHandle, migrate: bool) -> Result<(std::path::PathBuf, SidecarConfig), String> {
  let data_root = resolve_data_root(app.path(), migrate).map_err(|error| format!("解析数据目录失败: {error}"))?;
  let workspace_path = data_root.join("workspace");
  if let Err(error) = std::fs::create_dir_all(&workspace_path) {
    log::error!("创建数据目录失败: {error}");
  }
  // 发布包把前端 dist 放入 resources/dist，sidecar 通过环境变量读取该目录。
  let static_directory = app.path().resource_dir().map_err(|error| format!("解析资源目录失败: {error}"))?.join("dist");
  #[cfg(any(target_os = "windows", target_os = "macos"))]
  let system_proxy = detected_proxy_url().unwrap_or_default();
  #[cfg(not(any(target_os = "windows", target_os = "macos")))]
  let system_proxy = String::new();
  let config = SidecarConfig {
    database_path: data_root.join("lingtu.db").to_string_lossy().to_string(),
    workspace_path: workspace_path.to_string_lossy().to_string(),
    static_directory: static_directory.to_string_lossy().to_string(),
    app_version: env!("CARGO_PKG_VERSION").to_owned(),
    system_proxy,
  };
  Ok((data_root, config))
}

/// sidecar 的启动参数。重启要复用同一份，所以从 setup 里提出来存进状态。
#[derive(Clone)]
struct SidecarConfig {
  database_path: String,
  workspace_path: String,
  static_directory: String,
  app_version: String,
  system_proxy: String,
}

struct LauncherState {
  child: Mutex<Option<CommandChild>>,
  status: Mutex<ServiceStatus>,
  /// 下次就绪时是否自动打开浏览器：首次启动与「重启并打开」为真。
  open_on_ready: AtomicBool,
  allow_exit: AtomicBool,
  status_item: MenuItem<tauri::Wry>,
  open_item: MenuItem<tauri::Wry>,
  restart_item: MenuItem<tauri::Wry>,
  /// 用户数据目录（数据库 + 图片），供「打开数据目录」使用。
  data_root: std::path::PathBuf,
  /// 服务最近一行 stderr。Node 抛 FATAL ERROR 时是 abort 退出，JS 层没机会写日志，
  /// 这行原始输出是唯一能说清原因的东西，所以它要能直接进托盘文案。
  last_stderr: Mutex<Option<String>>,
}

fn current_status(app: &tauri::AppHandle) -> Option<ServiceStatus> {
  app.try_state::<LauncherState>().and_then(|state| state.status.lock().ok().map(|status| status.clone()))
}

fn current_phase(app: &tauri::AppHandle) -> Option<ServicePhase> {
  current_status(app).map(|status| status.phase)
}

fn stop_sidecar(app: &tauri::AppHandle) {
  if let Some(state) = app.try_state::<LauncherState>() {
    if let Ok(mut child) = state.child.lock() {
      if let Some(child) = child.take() {
        let _ = child.kill();
      }
    }
  }
}

/// 同步托盘文案与状态。状态没有变化时直接返回，避免 2 秒一次的刷新反复改菜单。
fn apply_status(app: &tauri::AppHandle, status: ServiceStatus) {
  let Some(state) = app.try_state::<LauncherState>() else {
    return;
  };
  if let Ok(current) = state.status.lock() {
    if *current == status {
      return;
    }
  }

  let view = menu_view(&status);
  // 先落盘再动托盘：托盘与菜单更新都是同步的跨线程 Shell/menu 调用，卡住时这条日志能定位在哪个阶段断了。
  log::info!("托盘状态: {}", view.status);
  if let Some(tray) = app.tray_by_id(TRAY_ID) {
    if let Err(error) = tray.set_tooltip(Some(view.tooltip.as_str())) {
      log::error!("更新托盘提示失败: {error}");
    }
  }
  for result in [
    state.status_item.set_text(view.status.as_str()),
    state.open_item.set_text(view.open_label),
    state.open_item.set_enabled(view.open_enabled),
    state.restart_item.set_text(view.restart_label),
    state.restart_item.set_enabled(view.restart_enabled),
  ] {
    if let Err(error) = result {
      log::error!("更新托盘菜单失败: {error}");
    }
  }
  log::info!("托盘已更新");

  {
    let locked = state.status.lock();
    if let Ok(mut current) = locked {
      *current = status;
    }
  }
}

/// 拉起 sidecar，并把它的 stdout 当作就绪通道。端口由 sidecar 自己决定：
/// 默认 8765，被占用时回退到系统分配端口，再通过 ready JSON 报回真实端口。
fn spawn_sidecar(app: &tauri::AppHandle, config: &SidecarConfig, open_when_ready: bool) -> Result<(), String> {
  log::info!(
    "拉起本地服务: 数据库={} 工作区={} 静态目录={} 版本={}",
    config.database_path, config.workspace_path, config.static_directory, config.app_version
  );
  let (mut events, child) = app
    .shell()
    .sidecar("lingtu-server")
    .map_err(|error| format!("找不到本地服务程序: {error}"))?
    .env("LINGTU_DB_PATH", config.database_path.clone())
    // workspace（生成的图片、执行日志）也放进用户数据目录：它过去相对当前工作目录解析，
    // 跟着安装目录跑，换安装文件夹后历史任务里的图片就全变死链接了。
    .env("LINGTU_WORKSPACE", config.workspace_path.clone())
    .env("LINGTU_STATIC_DIR", config.static_directory.clone())
    // 启动器被强杀（安装器覆盖安装、任务管理器结束进程）时不会走 RunEvent::Exit，
    // sidecar 会变成孤儿并锁住安装目录里的 lingtu-server.exe。把自身 PID 交给 sidecar，
    // 让它自己发现父进程消失后退出；普通启动路径仍由 stop_sidecar 主动回收。
    .env("LINGTU_PARENT_PID", std::process::id().to_string())
    // 应用版本取自 Cargo.toml，与安装包版本一致，供本地服务比对更新源。
    .env("LINGTU_APP_VERSION", config.app_version.clone())
    // 出口代理由应用内的「网络代理」设置决定，不再走进程环境变量；
    // 这里只把检测到的系统代理作为该设置的默认值，用户可在界面上修改或清空。
    .env("LINGTU_SYSTEM_PROXY", config.system_proxy.clone())
    .spawn()
    .map_err(|error| format!("启动本地服务程序失败: {error}"))?;

  if let Some(state) = app.try_state::<LauncherState>() {
    if let Ok(mut slot) = state.child.lock() {
      *slot = Some(child);
    }
    state.open_on_ready.store(open_when_ready, Ordering::SeqCst);
  }
  apply_status(app, ServiceStatus::starting());

  let app_handle = app.clone();
  tauri::async_runtime::spawn(async move {
    while let Some(event) = events.recv().await {
      match event {
        CommandEvent::Stdout(line) => {
          let text = String::from_utf8_lossy(&line).trim().to_owned();
          if !text.is_empty() {
            match parse_ready_line(&text) {
              Some(port) => mark_ready(&app_handle, port),
              None => log::info!("本地服务 stdout: {}", brief(&text, BRIEF_CHARS)),
            }
            let _ = tauri::Emitter::emit(&app_handle, "sidecar-output", text);
          }
        }
        CommandEvent::Stderr(line) => {
          let text = String::from_utf8_lossy(&line).trim().to_owned();
          if !text.is_empty() {
            // release 包没有可见控制台，stderr 是启动失败唯一的一手证据，必须落盘。
            log::error!("本地服务 stderr: {}", brief(&text, STDERR_LOG_CHARS));
            if let Some(state) = app_handle.try_state::<LauncherState>() {
              if let Ok(mut last) = state.last_stderr.lock() {
                *last = Some(brief(&text, BRIEF_CHARS));
              }
            }
            let _ = tauri::Emitter::emit(&app_handle, "sidecar-error", text);
          }
        }
        CommandEvent::Terminated(payload) => {
          log::error!("本地服务进程退出: code={:?} signal={:?}", payload.code, payload.signal);
          mark_terminated(&app_handle, payload.code);
        }
        _ => {}
      }
    }
  });

  // 就绪超时兜底：sidecar 既不输出 ready 也不退出时，托盘必须离开「启动中」。
  let watchdog = app.clone();
  std::thread::spawn(move || {
    std::thread::sleep(READY_TIMEOUT);
    let Some(status) = current_status(&watchdog) else {
      return;
    };
    let timed_out = status.started_at.map(|started_at| started_at.elapsed() >= READY_TIMEOUT).unwrap_or(false);
    if status.phase == ServicePhase::Starting && timed_out {
      log::error!("本地服务在 {} 秒内未就绪", READY_TIMEOUT.as_secs());
      apply_status(&watchdog, ServiceStatus::not_ready(format!("{} 秒内没有输出就绪信息", READY_TIMEOUT.as_secs())));
    }
  });

  Ok(())
}

fn mark_ready(app: &tauri::AppHandle, port: u16) {
  let open_now = app
    .try_state::<LauncherState>()
    .map(|state| state.open_on_ready.swap(false, Ordering::SeqCst))
    .unwrap_or(false);
  // 这次探测顺带取执行中任务数与版本：探测失败不改判定，ready JSON 才是就绪的事实来源。
  let health = probe_health(port);
  let running_jobs = health.as_ref().map(|health| health.running_jobs).unwrap_or(0);
  // 日志里带上双方版本：排查「旧 sidecar 配新启动器」时一眼就能看出来。
  log::info!(
    "本地服务就绪: 启动器版本={} 服务版本={} port={port}",
    env!("CARGO_PKG_VERSION"),
    health.as_ref().map(|health| health.version.as_str()).unwrap_or("未知")
  );
  // 先开浏览器再更新托盘：托盘更新是同步的 shell 调用，万一卡住也不能让用户连页面都拿不到。
  if open_now {
    if let Err(error) = open_browser(port) {
      log::error!("{error}");
    }
  }
  apply_status(app, ServiceStatus::ready(port, running_jobs));
}

fn mark_terminated(app: &tauri::AppHandle, code: Option<i32>) {
  // 重启路径会主动结束子进程，此时状态已进入「重启中」，不能改成「未就绪」。
  let stderr = app
    .try_state::<LauncherState>()
    .and_then(|state| state.last_stderr.lock().ok().and_then(|last| last.clone()));
  let detail = exit_detail(code, stderr.as_deref());
  log::error!("本地服务未就绪原因: {detail}");
  match current_phase(app) {
    Some(ServicePhase::Ready) | Some(ServicePhase::Starting) => apply_status(app, ServiceStatus::not_ready(detail)),
    _ => {}
  }
}

/// 退出原因文案。带上 stderr 首行：`FATAL ERROR: ...` 这类 abort 不会留下其他痕迹。
fn exit_detail(code: Option<i32>, stderr: Option<&str>) -> String {
  let cause = match (code, stderr.map(str::trim)) {
    (Some(code), Some(text)) if !text.is_empty() => format!("退出码 {code}：{text}"),
    (Some(code), _) => format!("退出码 {code}"),
    _ => return "本地服务进程意外退出".to_owned(),
  };
  format!("本地服务意外退出（{cause}）")
}

/// 就绪后定期复核服务与执行中任务数：任务数是「重启本地服务」是否可用的唯一依据，
/// 服务消失时也靠它立刻更新状态，而不是等用户自己发现问题。
fn watch_service(app: tauri::AppHandle) {
  std::thread::spawn(move || loop {
    std::thread::sleep(REFRESH_INTERVAL);
    let Some(status) = current_status(&app) else {
      continue;
    };
    if status.phase != ServicePhase::Ready {
      continue;
    }
    let Some(port) = status.port else {
      continue;
    };
    match probe_health(port) {
      Some(health) => apply_status(&app, ServiceStatus::ready(port, health.running_jobs)),
      None => apply_status(&app, ServiceStatus::not_ready("本地服务已无响应")),
    }
  });
}

/// 重启涉及杀进程与等待端口释放，必须离开主线程执行，否则菜单事件会把托盘卡住。
fn request_restart(app: &tauri::AppHandle) {
  let app = app.clone();
  std::thread::spawn(move || restart_service(&app));
}

fn restart_service(app: &tauri::AppHandle) {
  let Some(state) = app.try_state::<LauncherState>() else {
    return;
  };
  let Some(status) = state.status.lock().ok().map(|status| status.clone()) else {
    return;
  };
  apply_status(app, ServiceStatus::restarting());

  if status.phase == ServicePhase::ForeignVersion {
    if !take_over_foreign_service(app, status.foreign) {
      return;
    }
  } else {
    stop_sidecar(app);
    let port = status.port.unwrap_or(DEFAULT_PORT);
    if is_port_listening(port) && !wait_port_free(port, PORT_FREE_TIMEOUT) {
      log::error!("本地服务未在 {port} 释放端口");
      apply_status(app, ServiceStatus::not_ready(format!("端口 {port} 未被释放")));
      return;
    }
  }

  // 重启时重新解析数据目录：此刻旧进程已结束，才轮得到迁移旧数据库。
  let config = match resolve_sidecar_paths(app, true) {
    Ok((_, config)) => config,
    Err(error) => {
      log::error!("初始化数据目录失败: {error}");
      apply_status(app, ServiceStatus::not_ready(format!("初始化数据目录失败：{}", brief(&error, BRIEF_CHARS))));
      return;
    }
  };

  // 重启后端口可能变化，旧标签页会指向失效端口，所以总是打开一个新标签页。
  if let Err(error) = spawn_sidecar(app, &config, true) {
    log::error!("重启本地服务失败: {error}");
    apply_status(app, ServiceStatus::not_ready(format!("重启失败：{}", brief(&error, BRIEF_CHARS))));
  }
}

/// 接管 8765 上的旧版本实例：先复核身份再按 pid 强杀，端口没释放就不启动新实例，
/// 避免两个服务写同一个数据库、重复执行同一批任务。
fn take_over_foreign_service(app: &tauri::AppHandle, foreign: Option<(u32, String)>) -> bool {
  let Some((pid, version)) = foreign else {
    apply_status(app, ServiceStatus::not_ready("未找到旧版本服务进程"));
    return false;
  };
  match probe_health(DEFAULT_PORT) {
    // 复核身份，避免 pid 被复用后杀错进程。
    Some(health) if health.pid != pid || health.version != version => {
      log::error!("旧版本服务身份已变化，未执行接管");
      apply_status(app, ServiceStatus::foreign(health.pid, health.version));
      false
    }
    Some(_) => {
      if let Err(error) = kill_process_by_pid(pid) {
        log::error!("{error}");
        apply_status(app, ServiceStatus::foreign(pid, version));
        return false;
      }
      if !wait_port_free(DEFAULT_PORT, PORT_FREE_TIMEOUT) {
        log::error!("旧版本服务未释放 {DEFAULT_PORT}，未启动新实例");
        apply_status(app, ServiceStatus::foreign(pid, version));
        return false;
      }
      true
    }
    // 旧实例已经自行退出，可以直接启动。
    None => true,
  }
}

fn open_current_service(app: &tauri::AppHandle) {
  let Some(port) = current_status(app).and_then(|status| status.port) else {
    return;
  };
  if let Err(error) = open_browser(port) {
    log::error!("{error}");
  }
}

/// 托盘的三个可变项：状态项只读，另外两个是用户可点的动作。
struct TrayItems {
  status: MenuItem<tauri::Wry>,
  open: MenuItem<tauri::Wry>,
  restart: MenuItem<tauri::Wry>,
}

fn create_tray(app: &mut tauri::App, view: &MenuView) -> tauri::Result<TrayItems> {
  let status_item = MenuItem::with_id(app, "status", view.status.as_str(), false, None::<&str>)?;
  let open_item = MenuItem::with_id(app, "open-workbench", view.open_label, view.open_enabled, None::<&str>)?;
  let restart_item = MenuItem::with_id(app, "restart-service", view.restart_label, view.restart_enabled, None::<&str>)?;
  let logs_item = MenuItem::with_id(app, "open-logs", "打开日志目录", true, None::<&str>)?;
  // 数据目录独立于安装目录，用户重装 / 换盘时需要能找到历史图片和提示词库。
  let data_item = MenuItem::with_id(app, "open-data", "打开数据目录", true, None::<&str>)?;
  let exit_item = MenuItem::with_id(app, "exit", "退出", true, None::<&str>)?;
  let menu = Menu::with_items(app, &[&status_item, &open_item, &restart_item, &logs_item, &data_item, &exit_item])?;
  let mut tray = TrayIconBuilder::with_id(TRAY_ID)
    .menu(&menu)
    .tooltip(view.tooltip.as_str())
    .on_menu_event(|app, event| match event.id.as_ref() {
      // 未就绪时点击主项即重启并打开：用户点这个菜单项的意图永远是「我要用」。
      "open-workbench" => match current_phase(app) {
        Some(ServicePhase::NotReady) => request_restart(app),
        _ => open_current_service(app),
      },
      "restart-service" => request_restart(app),
      // release 包没有可见控制台，日志目录是用户唯一能回传的一手证据。
      "open-logs" => {
        if let Err(error) = open_log_directory(app) {
          log::error!("{error}");
        }
      }
      "open-data" => {
        let directory = app.try_state::<LauncherState>().map(|state| state.data_root.clone());
        if let Some(directory) = directory {
          if let Err(error) = open_in_file_manager(&directory) {
            log::error!("{error}");
          }
        }
      }
      "exit" => {
        if let Some(state) = app.try_state::<LauncherState>() {
          state.allow_exit.store(true, Ordering::SeqCst);
        }
        app.exit(0);
      }
      _ => {}
    });

  if let Some(icon) = app.default_window_icon().cloned() {
    tray = tray.icon(icon);
  }
  tray.build(app)?;
  Ok(TrayItems { status: status_item, open: open_item, restart: restart_item })
}

/// 在文件管理器里打开日志目录；目录还没创建时先建出来，避免打开报错。
fn open_log_directory(app: &tauri::AppHandle) -> Result<(), String> {
  let directory = app.path().app_log_dir().map_err(|error| format!("读取日志目录失败: {error}"))?;
  std::fs::create_dir_all(&directory).map_err(|error| format!("创建日志目录失败: {error}"))?;
  open_in_file_manager(&directory)
}

fn open_in_file_manager(path: &std::path::Path) -> Result<(), String> {
  #[cfg(target_os = "windows")]
  let mut command = Command::new("explorer");
  #[cfg(target_os = "macos")]
  let mut command = Command::new("open");
  #[cfg(target_os = "linux")]
  let mut command = Command::new("xdg-open");
  #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
  return Err("当前平台没有可用的文件管理器启动方式".to_owned());

  command.arg(path).spawn().map(|_| ()).map_err(|error| format!("打开文件管理器失败: {error}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    // release 包没有可见控制台：日志必须落盘，否则「一直启动中 / 未就绪」永远无法取证（ADR 0016）。
    .plugin(
      tauri_plugin_log::Builder::default()
        .level(log::LevelFilter::Info)
        .max_file_size(5 * 1024 * 1024)
        .targets([
          Target::new(TargetKind::Stdout),
          Target::new(TargetKind::LogDir { file_name: Some("launcher".to_owned()) }),
        ])
        .build(),
    )
    .plugin(tauri_plugin_shell::init())
    .setup(|app| {
      // 先探 8765：决定本次是接管旧实例、直接打开，还是拉起新服务。
      let initial = match probe_health(DEFAULT_PORT) {
        Some(health) if health.version == env!("CARGO_PKG_VERSION") => {
          let app_handle = app.handle().clone();
          std::thread::spawn(move || {
            if let Err(error) = open_browser(DEFAULT_PORT) {
              log::error!("{error}");
            }
            app_handle.exit(0);
          });
          return Ok(());
        }
        Some(health) => ServiceStatus::foreign(health.pid, health.version),
        None => ServiceStatus::starting(),
      };
      // 只有确定要自己拉服务时才迁移数据：此刻 8765 上没人在写 WAL，复制数据库才是安全快照。
      let migrating = initial.phase == ServicePhase::Starting;
      let (data_root, config) = match resolve_sidecar_paths(app.handle(), migrating) {
        Ok(resolved) => resolved,
        Err(error) => {
          log::error!("初始化数据目录失败: {error}");
          apply_status(app.handle(), ServiceStatus::not_ready(format!("初始化数据目录失败：{}", brief(&error, BRIEF_CHARS))));
          return Ok(());
        }
      };

      let log_directory = app.path().app_log_dir().map(|path| path.to_string_lossy().to_string()).unwrap_or_default();
      // 启动事实全部落盘：版本、数据库、静态资源、代理是否检测到，足以复盘大多数装机问题。
      log::info!(
        "启动器就绪: 版本={} 日志目录={} 数据目录={} 数据库={} 工作区={} 静态目录={} 系统代理={}",
        config.app_version,
        log_directory,
        data_root.display(),
        config.database_path,
        config.workspace_path,
        config.static_directory,
        if config.system_proxy.is_empty() { "未检测到" } else { "已检测到" }
      );
      log::info!("8765 探测结果: {:?}", initial);

      let items = create_tray(app, &menu_view(&initial))?;
      app.manage(LauncherState {
        child: Mutex::new(None),
        status: Mutex::new(initial.clone()),
        open_on_ready: AtomicBool::new(false),
        allow_exit: AtomicBool::new(false),
        status_item: items.status,
        open_item: items.open,
        restart_item: items.restart,
        data_root,
        last_stderr: Mutex::new(None),
      });

      if initial.phase == ServicePhase::Starting {
        if let Err(error) = spawn_sidecar(app.handle(), &config, true) {
          log::error!("启动本地服务失败: {error}");
          apply_status(app.handle(), ServiceStatus::not_ready(format!("启动失败：{}", brief(&error, BRIEF_CHARS))));
        }
      }
      watch_service(app.handle().clone());

      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| {
      match event {
        tauri::RunEvent::ExitRequested { api, .. } => {
          // 常驻托盘模式下，系统关闭请求不能结束服务；只有托盘“退出”会先放行。
          let can_exit = app
            .try_state::<LauncherState>()
            .map(|state| state.allow_exit.load(Ordering::SeqCst))
            .unwrap_or(false);
          if !can_exit {
            api.prevent_exit();
          }
        }
        tauri::RunEvent::WindowEvent {
          event: tauri::WindowEvent::CloseRequested { api, .. },
          ..
        } => {
          // 即使未来恢复主窗口，点击关闭也只隐藏窗口，避免误杀本地服务。
          api.prevent_close();
          if let Some(window) = app.get_webview_window("main") {
            let _ = window.hide();
          }
        }
        tauri::RunEvent::Exit => stop_sidecar(app),
        _ => {}
      }
    })
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::net::TcpListener;

  /// 起一个只应答一次的假本地服务，用来验证探测逻辑，而不是只验证拼接。
  fn serve_once(response: &'static str) -> u16 {
    let listener = TcpListener::bind((SERVER_HOST, 0)).expect("测试用监听端口必须可用");
    let port = listener.local_addr().expect("监听地址必须可读").port();
    std::thread::spawn(move || {
      if let Ok((mut stream, _)) = listener.accept() {
        let mut buffer = [0_u8; 256];
        let _ = stream.read(&mut buffer);
        let _ = stream.write_all(response.as_bytes());
      }
    });
    port
  }

  #[test]
  fn parses_sidecar_ready_line() {
    assert_eq!(parse_ready_line(r#"{"ready":true,"port":51423,"host":"127.0.0.1"}"#), Some(51423));
  }

  #[test]
  fn ignores_lines_that_are_not_a_ready_port() {
    assert_eq!(parse_ready_line(r#"{"ready":false,"port":51423}"#), None);
    assert_eq!(parse_ready_line(r#"{"ready":true}"#), None);
    assert_eq!(parse_ready_line(r#"{"ready":true,"port":70000}"#), None);
    assert_eq!(parse_ready_line("正在启动本地服务"), None);
  }

  #[test]
  fn probes_identity_and_running_jobs_from_health() {
    let port = serve_once("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"status\":\"ok\",\"service\":\"lingtu-workbench\",\"version\":\"1.0.8\",\"pid\":42,\"runningJobs\":3}\n");
    assert_eq!(probe_health(port), Some(Health { version: "1.0.8".to_owned(), pid: 42, running_jobs: 3 }));
  }

  #[test]
  fn ignores_health_response_from_another_service() {
    let port = serve_once("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{\"status\":\"ok\",\"service\":\"别的服务\"}");
    assert_eq!(probe_health(port), None);
  }

  #[test]
  fn ready_without_running_jobs_allows_restart() {
    let view = menu_view(&ServiceStatus::ready(8765, 0));
    assert_eq!(view.tooltip, "灵图工作台");
    assert_eq!(view.open_label, "打开灵图工作台");
    assert!(view.open_enabled);
    assert!(view.restart_enabled);
  }

  /// 状态项必须报出真实端口：端口回退后手输 8765 会打开别的东西。
  #[test]
  fn status_item_shows_the_real_port() {
    let view = menu_view(&ServiceStatus::ready(51423, 0));
    assert_eq!(view.status, "状态：运行中 · http://127.0.0.1:51423");
  }

  #[test]
  fn running_jobs_disable_restart() {
    let view = menu_view(&ServiceStatus::ready(8765, 2));
    assert_eq!(view.tooltip, "灵图工作台 · 有 2 个任务执行中");
    assert_eq!(view.status, "状态：运行中 · 2 个任务执行中");
    assert_eq!(view.restart_label, "重启本地服务（有任务执行中）");
    assert!(view.open_enabled);
    assert!(!view.restart_enabled);
  }

  /// tooltip 可能被 shell 缓存，菜单状态项是用户真正看到的那一面，必须带出原因。
  #[test]
  fn not_ready_offers_restart_and_shows_reason() {
    let view = menu_view(&ServiceStatus::not_ready("本地服务进程意外退出（退出码 1）"));
    assert_eq!(view.tooltip, "灵图工作台 · 本地服务未就绪（本地服务进程意外退出（退出码 1））");
    assert_eq!(view.status, "状态：本地服务未就绪 · 本地服务进程意外退出（退出码 1）");
    assert_eq!(view.open_label, "重启并打开灵图工作台");
    assert!(view.open_enabled);
    assert!(view.restart_enabled);
  }

  #[test]
  fn starting_and_restarting_disable_both_actions() {
    for status in [ServiceStatus::starting(), ServiceStatus::restarting()] {
      let view = menu_view(&status);
      assert!(!view.open_enabled);
      assert!(!view.restart_enabled);
    }
    assert_eq!(menu_view(&ServiceStatus::starting()).status, "状态：正在启动本地服务");
    assert_eq!(menu_view(&ServiceStatus::restarting()).status, "状态：正在重启本地服务");
  }

  #[test]
  fn foreign_version_is_surfaced_with_its_own_wording() {
    let view = menu_view(&ServiceStatus::foreign(42, "1.0.5".to_owned()));
    assert_eq!(view.tooltip, "灵图工作台 · 检测到旧版本服务在运行");
    assert_eq!(view.status, "状态：检测到旧版本服务在运行（v1.0.5）");
    assert_eq!(view.open_label, "打开灵图工作台");
    assert!(view.restart_enabled);
  }

  /// 退出原因文案。带上 stderr 首行：`FATAL ERROR: ...` 这类 abort 不会留下其他痕迹。
  #[test]
  fn exit_detail_carries_first_stderr_line() {
    assert_eq!(
      exit_detail(Some(134), Some("FATAL ERROR: Reached heap limit Allocation failed")),
      "本地服务意外退出（退出码 134：FATAL ERROR: Reached heap limit Allocation failed）"
    );
    assert_eq!(exit_detail(Some(134), None), "本地服务意外退出（退出码 134）");
    assert_eq!(exit_detail(Some(134), Some("   ")), "本地服务意外退出（退出码 134）");
    assert_eq!(exit_detail(None, Some("ignored")), "本地服务进程意外退出");
  }

  /// stderr 的一行可能是整段推栈，日志与托盘只能带开头部分。
  #[test]
  fn brief_cuts_long_output() {
    assert_eq!(brief("  正常行  ", 10), "正常行");
    assert_eq!(brief("一二三四五六", 3), "一二三…");
    assert_eq!(brief("一二三", 3), "一二三");
  }

  /// 临时目录在用例结束后自清，避影影响后续用例。
  struct TempDirectory(std::path::PathBuf);

  impl TempDirectory {
    fn new(name: &str) -> Self {
      let path = std::env::temp_dir().join(format!("lingtu-test-{name}-{}", std::process::id()));
      let _ = std::fs::remove_dir_all(&path);
      std::fs::create_dir_all(&path).expect("必须能创建测试目录");
      Self(path)
    }

    fn path(&self) -> &std::path::Path {
      &self.0
    }
  }

  impl Drop for TempDirectory {
    fn drop(&mut self) {
      let _ = std::fs::remove_dir_all(&self.0);
    }
  }

  /// 「重装选新文件夹」等于卸载 + 勾删除；迁移必须把数据库和图片完整搬到新目录。
  /// 旧目录刻意保留：迁移失败时不能两边都不完整。
  #[test]
  fn migrates_database_and_workspace_to_stable_directory() {
    let root = TempDirectory::new("migrate");
    let legacy = root.path().join("appdata-com.lingtu.workbench");
    let install_workspace = root.path().join("old-install").join("workspace");
    let target = root.path().join("data");

    std::fs::create_dir_all(&legacy).unwrap();
    std::fs::write(legacy.join("lingtu.db"), b"prompts").unwrap();
    // WAL 里的已提交事务必须跟着走，否则看起来就像“提示词退回了旧版本”。
    std::fs::write(legacy.join("lingtu.db-wal"), b"wal").unwrap();
    std::fs::create_dir_all(install_workspace.join("jobs")).unwrap();
    std::fs::write(install_workspace.join("jobs").join("a.png"), b"png").unwrap();

    migrate_legacy_data(&legacy, Some(&install_workspace), &target).unwrap();

    assert_eq!(std::fs::read(target.join("lingtu.db")).unwrap(), b"prompts");
    assert_eq!(std::fs::read(target.join("lingtu.db-wal")).unwrap(), b"wal");
    assert_eq!(std::fs::read(target.join("workspace").join("jobs").join("a.png")).unwrap(), b"png");
    // 旧目录不清空：删除属于用户的决定。
    assert!(legacy.join("lingtu.db").exists());
  }

  /// 已有新数据库时不能再拿旧数据覆盖，否则升级回退会复活旧提示词。
  #[test]
  fn migration_never_overwrites_existing_data() {
    let root = TempDirectory::new("no-overwrite");
    let legacy = root.path().join("legacy");
    let target = root.path().join("data");
    std::fs::create_dir_all(&legacy).unwrap();
    std::fs::create_dir_all(&target).unwrap();
    std::fs::write(legacy.join("lingtu.db"), b"old").unwrap();
    std::fs::write(target.join("lingtu.db"), b"new").unwrap();

    migrate_legacy_data(&legacy, None, &target).unwrap();

    assert_eq!(std::fs::read(target.join("lingtu.db")).unwrap(), b"new");
  }

  #[test]
  fn parses_shared_windows_proxy_for_http_and_https() {
    let proxy = parse_proxy_server("127.0.0.1:7897").unwrap();

    assert_eq!(proxy.http_proxy.as_deref(), Some("http://127.0.0.1:7897"));
    assert_eq!(proxy.https_proxy.as_deref(), Some("http://127.0.0.1:7897"));
  }

  #[test]
  fn parses_protocol_specific_windows_proxy() {
    let proxy = parse_proxy_server("http=127.0.0.1:7890;https=https://127.0.0.1:7891;socks=127.0.0.1:7892").unwrap();

    assert_eq!(proxy.http_proxy.as_deref(), Some("http://127.0.0.1:7890"));
    assert_eq!(proxy.https_proxy.as_deref(), Some("https://127.0.0.1:7891"));
  }
}
