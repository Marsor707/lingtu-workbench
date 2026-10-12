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
const READY_TIMEOUT: Duration = Duration::from_secs(20);
/// 本地 HTTP 探测的单次连接与读取超时。
const PROBE_TIMEOUT: Duration = Duration::from_millis(300);
/// 重启时等待旧进程释放端口的上限。
const PORT_FREE_TIMEOUT: Duration = Duration::from_secs(3);
/// 就绪后刷新执行中任务数的间隔，它决定「重启本地服务」是否可用。
const REFRESH_INTERVAL: Duration = Duration::from_secs(2);

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
}

impl ServiceStatus {
  fn starting() -> Self {
    Self { phase: ServicePhase::Starting, port: None, running_jobs: 0, started_at: Some(Instant::now()), foreign: None }
  }

  fn ready(port: u16, running_jobs: u32) -> Self {
    Self { phase: ServicePhase::Ready, port: Some(port), running_jobs, started_at: None, foreign: None }
  }

  fn not_ready() -> Self {
    Self { phase: ServicePhase::NotReady, port: None, running_jobs: 0, started_at: None, foreign: None }
  }

  fn restarting() -> Self {
    Self { phase: ServicePhase::Restarting, port: None, running_jobs: 0, started_at: None, foreign: None }
  }

  fn foreign(pid: u32, version: String) -> Self {
    Self { phase: ServicePhase::ForeignVersion, port: Some(DEFAULT_PORT), running_jobs: 0, started_at: None, foreign: Some((pid, version)) }
  }
}

/// 托盘文案。抽成纯函数，让状态与文案的对应关系由单测锁住，而不是每次手工点。
struct MenuView {
  tooltip: String,
  open_label: &'static str,
  open_enabled: bool,
  restart_label: &'static str,
  restart_enabled: bool,
}

fn menu_view(status: &ServiceStatus) -> MenuView {
  match status.phase {
    ServicePhase::Starting => MenuView { tooltip: "灵图工作台 · 正在启动本地服务".to_owned(), open_label: "打开灵图工作台", open_enabled: false, restart_label: "重启本地服务", restart_enabled: false },
    ServicePhase::Restarting => MenuView { tooltip: "灵图工作台 · 正在重启本地服务".to_owned(), open_label: "打开灵图工作台", open_enabled: false, restart_label: "重启本地服务", restart_enabled: false },
    // 有任务执行中时禁止重启：被中断的 running 任务不会被服务端恢复，只会永久停在执行中。
    ServicePhase::Ready if status.running_jobs > 0 => MenuView { tooltip: format!("灵图工作台 · 有 {} 个任务执行中", status.running_jobs), open_label: "打开灵图工作台", open_enabled: true, restart_label: "重启本地服务（有任务执行中）", restart_enabled: false },
    ServicePhase::Ready => MenuView { tooltip: "灵图工作台".to_owned(), open_label: "打开灵图工作台", open_enabled: true, restart_label: "重启本地服务", restart_enabled: true },
    // 未就绪时主项改为「重启并打开」，避免把用户指向一个拒绝连接的页面。
    ServicePhase::NotReady => MenuView { tooltip: "灵图工作台 · 本地服务未就绪".to_owned(), open_label: "重启并打开灵图工作台", open_enabled: true, restart_label: "重启本地服务", restart_enabled: true },
    ServicePhase::ForeignVersion => MenuView { tooltip: "灵图工作台 · 检测到旧版本服务在运行".to_owned(), open_label: "打开灵图工作台", open_enabled: true, restart_label: "重启本地服务", restart_enabled: true },
  }
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

/// sidecar 的启动参数。重启要复用同一份，所以从 setup 里提出来存进状态。
#[derive(Clone)]
struct SidecarConfig {
  database_path: String,
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
  open_item: MenuItem<tauri::Wry>,
  restart_item: MenuItem<tauri::Wry>,
  config: SidecarConfig,
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
  if let Some(tray) = app.tray_by_id(TRAY_ID) {
    if let Err(error) = tray.set_tooltip(Some(view.tooltip.as_str())) {
      log::error!("更新托盘提示失败: {error}");
    }
  }
  for result in [
    state.open_item.set_text(view.open_label),
    state.open_item.set_enabled(view.open_enabled),
    state.restart_item.set_text(view.restart_label),
    state.restart_item.set_enabled(view.restart_enabled),
  ] {
    if let Err(error) = result {
      log::error!("更新托盘菜单失败: {error}");
    }
  }

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
  let (mut events, child) = app
    .shell()
    .sidecar("lingtu-server")
    .map_err(|error| error.to_string())?
    .env("LINGTU_DB_PATH", config.database_path.clone())
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
    .map_err(|error| error.to_string())?;

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
            if let Some(port) = parse_ready_line(&text) {
              mark_ready(&app_handle, port);
            }
            let _ = tauri::Emitter::emit(&app_handle, "sidecar-output", text);
          }
        }
        CommandEvent::Stderr(line) => {
          let text = String::from_utf8_lossy(&line).trim().to_owned();
          if !text.is_empty() {
            let _ = tauri::Emitter::emit(&app_handle, "sidecar-error", text);
          }
        }
        CommandEvent::Terminated(_) => mark_terminated(&app_handle),
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
      apply_status(&watchdog, ServiceStatus::not_ready());
    }
  });

  Ok(())
}

fn mark_ready(app: &tauri::AppHandle, port: u16) {
  let open_now = app
    .try_state::<LauncherState>()
    .map(|state| state.open_on_ready.swap(false, Ordering::SeqCst))
    .unwrap_or(false);
  // 这次探测顺带取执行中任务数；探测失败不改判定，ready JSON 才是就绪的事实来源。
  let running_jobs = probe_health(port).map(|health| health.running_jobs).unwrap_or(0);
  apply_status(app, ServiceStatus::ready(port, running_jobs));
  if open_now {
    if let Err(error) = open_browser(port) {
      log::error!("{error}");
    }
  }
}

fn mark_terminated(app: &tauri::AppHandle) {
  // 重启路径会主动结束子进程，此时状态已进入「重启中」，不能改成「未就绪」。
  match current_phase(app) {
    Some(ServicePhase::Ready) | Some(ServicePhase::Starting) => apply_status(app, ServiceStatus::not_ready()),
    _ => {}
  }
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
      None => apply_status(&app, ServiceStatus::not_ready()),
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
  let config = state.config.clone();
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
      apply_status(app, ServiceStatus::not_ready());
      return;
    }
  }

  // 重启后端口可能变化，旧标签页会指向失效端口，所以总是打开一个新标签页。
  if let Err(error) = spawn_sidecar(app, &config, true) {
    log::error!("重启本地服务失败: {error}");
    apply_status(app, ServiceStatus::not_ready());
  }
}

/// 接管 8765 上的旧版本实例：先复核身份再按 pid 强杀，端口没释放就不启动新实例，
/// 避免两个服务写同一个数据库、重复执行同一批任务。
fn take_over_foreign_service(app: &tauri::AppHandle, foreign: Option<(u32, String)>) -> bool {
  let Some((pid, version)) = foreign else {
    apply_status(app, ServiceStatus::not_ready());
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

fn create_tray(app: &mut tauri::App, view: &MenuView) -> tauri::Result<(MenuItem<tauri::Wry>, MenuItem<tauri::Wry>)> {
  let open_item = MenuItem::with_id(app, "open-workbench", view.open_label, view.open_enabled, None::<&str>)?;
  let restart_item = MenuItem::with_id(app, "restart-service", view.restart_label, view.restart_enabled, None::<&str>)?;
  let exit_item = MenuItem::with_id(app, "exit", "退出", true, None::<&str>)?;
  let menu = Menu::with_items(app, &[&open_item, &restart_item, &exit_item])?;
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
  Ok((open_item, restart_item))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .setup(|app| {
      let database_path = app.path().app_data_dir()?.join("lingtu.db");
      // 发布包把前端 dist 放入 resources/dist，sidecar 通过环境变量读取该目录。
      let static_directory = app.path().resource_dir()?.join("dist");
      #[cfg(any(target_os = "windows", target_os = "macos"))]
      let system_proxy = detected_proxy_url().unwrap_or_default();
      #[cfg(not(any(target_os = "windows", target_os = "macos")))]
      let system_proxy = String::new();
      let config = SidecarConfig {
        database_path: database_path.to_string_lossy().to_string(),
        static_directory: static_directory.to_string_lossy().to_string(),
        app_version: env!("CARGO_PKG_VERSION").to_owned(),
        system_proxy,
      };

      // 8765 上已经有自己人时不再起第二个服务：同版本只打开浏览器并让本次启动退出
      // （两个同版本托盘图标没有区分度），异版本交给用户点「重启本地服务」接管。
      let initial = match probe_health(DEFAULT_PORT) {
        Some(health) if health.version == config.app_version => {
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

      let (open_item, restart_item) = create_tray(app, &menu_view(&initial))?;
      app.manage(LauncherState {
        child: Mutex::new(None),
        status: Mutex::new(initial.clone()),
        open_on_ready: AtomicBool::new(false),
        allow_exit: AtomicBool::new(false),
        open_item,
        restart_item,
        config: config.clone(),
      });

      if initial.phase == ServicePhase::Starting {
        if let Err(error) = spawn_sidecar(app.handle(), &config, true) {
          log::error!("启动本地服务失败: {error}");
          apply_status(app.handle(), ServiceStatus::not_ready());
        }
      }
      watch_service(app.handle().clone());

      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
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

  #[test]
  fn running_jobs_disable_restart() {
    let view = menu_view(&ServiceStatus::ready(8765, 2));
    assert_eq!(view.tooltip, "灵图工作台 · 有 2 个任务执行中");
    assert_eq!(view.restart_label, "重启本地服务（有任务执行中）");
    assert!(view.open_enabled);
    assert!(!view.restart_enabled);
  }

  #[test]
  fn not_ready_offers_restart_and_open() {
    let view = menu_view(&ServiceStatus::not_ready());
    assert_eq!(view.tooltip, "灵图工作台 · 本地服务未就绪");
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
  }

  #[test]
  fn foreign_version_is_surfaced_with_its_own_wording() {
    let view = menu_view(&ServiceStatus::foreign(42, "1.0.5".to_owned()));
    assert_eq!(view.tooltip, "灵图工作台 · 检测到旧版本服务在运行");
    assert_eq!(view.open_label, "打开灵图工作台");
    assert!(view.restart_enabled);
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
