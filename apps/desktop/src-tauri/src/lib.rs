use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::path::PathBuf;

use tauri::Manager;

struct DaemonProcess(Mutex<Option<Child>>);

fn daemon_binary() -> PathBuf {
    if cfg!(windows) {
        PathBuf::from("node.exe")
    } else {
        PathBuf::from("node")
    }
}

fn data_dir() -> PathBuf {
    let base = if cfg!(windows) {
        std::env::var("APPDATA").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("."))
    } else if cfg!(target_os = "macos") {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        PathBuf::from(home).join("Library/Application Support")
    } else {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        PathBuf::from(home).join(".local/share")
    };
    base.join("CreatorStudio")
}

fn resolve_daemon_script() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("CREATOR_STUDIO_DAEMON") {
        let path = PathBuf::from(explicit);
        if path.exists() {
            return Some(path);
        }
    }

    let exe = std::env::current_exe().ok()?;
    let base = exe.parent()?.to_path_buf();

    let candidates = [
        // packaged layout: resources sit next to the exe under daemon-runtime/
        base.join("daemon-runtime").join("dist").join("main.js"),
        base.join("_up_").join("_up_").join("_up_").join("apps").join("daemon").join("runtime").join("dist").join("main.js"),
        base.join("daemon").join("dist").join("main.js"),
        // dev layout: repo/apps/daemon/dist/main.js
        base.join("..").join("..").join("..").join("..").join("..").join("apps").join("daemon").join("dist").join("main.js"),
    ];

    for candidate in candidates {
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

fn spawn_daemon() -> std::io::Result<Child> {
    let dir = data_dir();
    std::fs::create_dir_all(&dir)?;

    let Some(script) = resolve_daemon_script() else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "daemon/main.js not found; set CREATOR_STUDIO_DAEMON",
        ));
    };

    let working_dir = script.parent().map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));

    Command::new(daemon_binary())
        .arg(&script)
        .arg("--dataDir")
        .arg(dir.to_string_lossy().to_string())
        .arg("--port")
        .arg("7878")
        .current_dir(working_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
}

#[tauri::command]
fn daemon_status() -> serde_json::Value {
    serde_json::json!({ "running": true, "port": 7878 })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(DaemonProcess(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![daemon_status])
        .setup(|app| {
            match spawn_daemon() {
                Ok(child) => {
                    let state = app.state::<DaemonProcess>();
                    let mut slot = state.0.lock().unwrap();
                    *slot = Some(child);
                }
                Err(error) => {
                    eprintln!("daemon 启动失败: {error}");
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let app = window.app_handle();
                let state = app.state::<DaemonProcess>();
                let child = {
                    let mut slot = state.0.lock().unwrap();
                    slot.take()
                };
                if let Some(mut process) = child {
                    let _ = process.kill();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
