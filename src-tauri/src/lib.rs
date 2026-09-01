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
use tauri_plugin_shell::process::CommandChild;

const SERVER_URL: &str = "http://127.0.0.1:8765";
const HEALTH_PATH: &str = "/health";

struct SidecarState {
  child: Mutex<Option<CommandChild>>,
  allow_exit: AtomicBool,
}

fn stop_sidecar<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
  if let Some(state) = app.try_state::<SidecarState>() {
    if let Ok(mut child) = state.child.lock() {
      if let Some(child) = child.take() {
        let _ = child.kill();
      }
    }
  }
}

fn server_is_ready() -> bool {
  let address = "127.0.0.1:8765";
  let Ok(mut stream) = TcpStream::connect_timeout(
    &address.parse().expect("固定的本地服务地址必须有效"),
    Duration::from_millis(300),
  ) else {
    return false;
  };

  let _ = stream.set_read_timeout(Some(Duration::from_millis(300)));
  let request = format!(
    "GET {HEALTH_PATH} HTTP/1.1\r\nHost: 127.0.0.1:8765\r\nConnection: close\r\n\r\n"
  );
  if stream.write_all(request.as_bytes()).is_err() {
    return false;
  }

  let mut response = [0_u8; 256];
  let Ok(size) = stream.read(&mut response) else {
    return false;
  };
  String::from_utf8_lossy(&response[..size]).starts_with("HTTP/1.1 200")
}

fn open_browser() -> Result<(), String> {
  #[cfg(target_os = "windows")]
  let mut command = {
    let mut command = Command::new("cmd");
    command.args(["/C", "start", "", SERVER_URL]);
    command
  };

  #[cfg(target_os = "macos")]
  let mut command = {
    let mut command = Command::new("open");
    command.arg(SERVER_URL);
    command
  };

  #[cfg(target_os = "linux")]
  let mut command = {
    let mut command = Command::new("xdg-open");
    command.arg(SERVER_URL);
    command
  };

  #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
  return Err("当前平台没有可用的默认浏览器启动方式".to_owned());

  command
    .spawn()
    .map(|_| ())
    .map_err(|error| format!("启动默认浏览器失败: {error}"))
}

fn open_browser_when_ready() {
  std::thread::spawn(|| {
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
      if server_is_ready() {
        if let Err(error) = open_browser() {
          log::error!("{error}");
        }
        return;
      }
      std::thread::sleep(Duration::from_millis(250));
    }
    log::error!("本地服务在 20 秒内未就绪，未自动打开浏览器");
  });
}

fn create_tray<R: tauri::Runtime>(app: &mut tauri::App<R>) -> tauri::Result<()> {
  let open_item = MenuItem::with_id(app, "open-workbench", "打开灵图工作台", true, None::<&str>)?;
  let exit_item = MenuItem::with_id(app, "exit", "退出", true, None::<&str>)?;
  let menu = Menu::with_items(app, &[&open_item, &exit_item])?;
  let mut tray = TrayIconBuilder::with_id("lingtu-tray")
    .menu(&menu)
    .tooltip("灵图工作台")
    .on_menu_event(|app, event| match event.id.as_ref() {
      "open-workbench" => {
        if let Err(error) = open_browser() {
          log::error!("{error}");
        }
      }
      "exit" => {
        if let Some(state) = app.try_state::<SidecarState>() {
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
  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .setup(|app| {
      use tauri_plugin_shell::{process::CommandEvent, ShellExt};

      let database_path = app.path().app_data_dir()?.join("lingtu.db");
      // 发布包把前端 dist 放入 resources/dist，sidecar 通过环境变量读取该目录。
      let static_directory = app.path().resource_dir()?.join("dist");
      let sidecar = app.shell()
        .sidecar("lingtu-server")?
        .env("LINGTU_PORT", "8765")
        .env("LINGTU_DB_PATH", database_path.to_string_lossy().to_string())
        .env("LINGTU_STATIC_DIR", static_directory.to_string_lossy().to_string())
        // 让 sidecar 使用系统 HTTP_PROXY/HTTPS_PROXY/NO_PROXY 环境变量访问 Provider。
        .env("NODE_USE_ENV_PROXY", "1");
      let (mut events, child) = sidecar.spawn()?;
      app.manage(SidecarState {
        child: Mutex::new(Some(child)),
        allow_exit: AtomicBool::new(false),
      });
      create_tray(app)?;
      open_browser_when_ready();
      let app_handle = app.handle().clone();
      tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
          match event {
            CommandEvent::Stdout(line) => {
              let text = String::from_utf8_lossy(&line).trim().to_owned();
              if !text.is_empty() {
                let _ = tauri::Emitter::emit(&app_handle, "sidecar-output", text);
              }
            }
            CommandEvent::Stderr(line) => {
              let text = String::from_utf8_lossy(&line).trim().to_owned();
              if !text.is_empty() {
                let _ = tauri::Emitter::emit(&app_handle, "sidecar-error", text);
              }
            }
            _ => {}
          }
        }
      });

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
            .try_state::<SidecarState>()
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
