//! Gateway sidecar process management.
//!
//! Handles spawning, monitoring (watchdog), and stopping the Node.js/TSX
//! Gateway process.  Also manages log forwarding and port cleanup.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

use super::bundle::setup_gateway_runtime;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// Windows: CREATE_NO_WINDOW flag — prevents console flash when spawning .cmd files.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ── Node / TSX path helpers ────────────────────────────────────────────────────

fn get_node_binary_name() -> &'static str {
    if cfg!(target_os = "windows") { "node.exe" } else { "node" }
}

/// Resolve the Node executable path.
///
/// In prod mode returns the bundled `node.exe` inside the Tauri resource directory;
/// in dev mode falls back to the system `node` on PATH.
fn get_node_exe(resource_dir: &Path) -> PathBuf {
    let bundled = resource_dir.join(get_node_binary_name());
    if bundled.exists() {
        // macOS/Linux: Tauri resource copy may strip the execute bit — fix it.
        #[cfg(not(target_os = "windows"))]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(metadata) = std::fs::metadata(&bundled) {
                let perms = metadata.permissions();
                if perms.mode() & 0o111 == 0 {
                    eprintln!("[Gateway] Fixing execute permission on bundled node");
                    let _ = std::fs::set_permissions(
                        &bundled,
                        std::fs::Permissions::from_mode(0o755),
                    );
                }
            }
        }
        bundled
    } else {
        PathBuf::from("node")
    }
}

// ── Port cleanup (Windows only) ────────────────────────────────────────────────

/// Kill any process listening on port 18801 (Windows only).
///
/// Uses PowerShell `Get-NetTCPConnection` for precision — only affects
/// the process we own, not any unrelated services.
#[cfg(target_os = "windows")]
pub fn kill_port_18801() {
    let ps_script = "Get-NetTCPConnection -LocalPort 18801 -State Listen \
        -ErrorAction SilentlyContinue | ForEach-Object { \
        Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue; \
        Write-Host \"Killed PID $($_.OwningProcess)\" }";
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", ps_script])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            if !stdout.trim().is_empty() {
                eprintln!("[Gateway] Port 18801 cleanup: {}", stdout.trim());
            }
        }
        Err(e) => eprintln!("[Gateway] Port 18801 cleanup failed: {}", e),
    }
}

// ── Log forwarding helpers ─────────────────────────────────────────────────────

type SharedLogFile = Option<std::sync::Arc<Mutex<std::fs::File>>>;

fn spawn_stdout_forwarder(stdout: std::process::ChildStdout, log_file: SharedLogFile) {
    std::thread::spawn(move || {
        use std::io::{BufRead, Write};
        let reader = std::io::BufReader::new(stdout);
        for line in reader.lines() {
            if let Ok(line) = line {
                eprintln!("[Gateway] {}", line);
                if let Some(ref lf) = log_file {
                    if let Ok(mut f) = lf.lock() {
                        let _ = writeln!(f, "[Gateway] {}", line);
                    }
                }
            }
        }
    });
}

/// Spawn a thread that reads stderr line-by-line with GBK fallback for Windows.
fn spawn_stderr_forwarder(stderr: std::process::ChildStderr, log_file: SharedLogFile) {
    std::thread::spawn(move || {
        use std::io::{BufRead, Write};
        let mut reader = std::io::BufReader::new(stderr);
        let mut raw_line: Vec<u8> = Vec::new();
        loop {
            raw_line.clear();
            match reader.read_until(b'\n', &mut raw_line) {
                Ok(0) => break, // EOF
                Ok(_) => {
                    // Strip trailing \r\n
                    while raw_line.last() == Some(&b'\n') || raw_line.last() == Some(&b'\r') {
                        raw_line.pop();
                    }
                    // Try UTF-8 first; fall back to latin-1 (avoids panic on GBK bytes).
                    let line = match std::str::from_utf8(&raw_line) {
                        Ok(s) => s.to_string(),
                        Err(_) => raw_line.iter().map(|&b| b as char).collect(),
                    };
                    eprintln!("[Gateway:ERR] {}", line);
                    if let Some(ref lf) = log_file {
                        if let Ok(mut f) = lf.lock() {
                            let _ = writeln!(f, "[Gateway:ERR] {}", line);
                        }
                    }
                }
                Err(_) => break,
            }
        }
    });
}

// ── Public sidecar API ─────────────────────────────────────────────────────────

/// Start the Gateway sidecar process.
///
/// - Dev mode: uses the local `gateway/` source directory and system `tsx`.
/// - Prod mode: extracts the bundled `gateway-bundle.tar.gz` if needed,
///   then runs it with the embedded `node.exe`.
///
/// A watchdog thread monitors the process and auto-restarts on unexpected exit.
pub fn start_gateway_sidecar(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<Mutex<super::GatewaySidecar>>();
    let mut sidecar = state.lock().map_err(|e| e.to_string())?;

    if sidecar.child.is_some() {
        eprintln!("[Gateway] sidecar already running");
        return Ok(());
    }

    let resource_path = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {}", e))?;

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let dev_gateway_root = manifest_dir.join("..").join("gateway");
    let dev_script = dev_gateway_root.join("src").join("gateway").join("start.ts");
    let tar_path = resource_path.join("gateway-bundle.tar.gz");
    let is_dev_exe = cfg!(debug_assertions);

    let (node_exe, tsx_cmd, script_path, working_dir, node_modules_path) =
        if dev_script.exists() && is_dev_exe {
            // ── dev mode ──
            let node = PathBuf::from("node");
            let tsx_name = if cfg!(target_os = "windows") { "tsx.cmd" } else { "tsx" };
            let tsx = dev_gateway_root.join("node_modules").join(".bin").join(tsx_name);
            let nm = dev_gateway_root.join("node_modules");
            (node, tsx, dev_script.clone(), manifest_dir.join(".."), nm)
        } else if tar_path.exists() {
            // ── prod mode ──
            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("获取 app data 目录失败: {}", e))?;
            std::fs::create_dir_all(&app_data_dir)
                .map_err(|e| format!("创建 app data 目录失败: {}", e))?;

            let gateway_data = setup_gateway_runtime(&resource_path, &app_data_dir)?;
            let node = get_node_exe(&resource_path);
            let tsx  = gateway_data.join("node_modules").join("tsx").join("dist").join("cli.mjs");
            let script = gateway_data.join("src").join("gateway").join("start.ts");
            let nm   = gateway_data.join("node_modules");

            // Copy initial config on first launch.
            let config_dest = app_data_dir.join("openflux.yaml");
            if !config_dest.exists() {
                let candidates = [
                    resource_path.join("openflux.example.yaml"),
                    resource_path.join("_up_").join("openflux.example.yaml"),
                ];
                if let Some(src) = candidates.iter().find(|p| p.exists()) {
                    std::fs::copy(src, &config_dest)
                        .map_err(|e| format!("复制初始配置文件失败: {}", e))?;
                    eprintln!("[Gateway] Copied initial config: {:?} -> {:?}", src, config_dest);
                } else {
                    eprintln!(
                        "[Gateway] Warning: openflux.example.yaml not found, search paths: {:?}",
                        candidates
                    );
                }
            }

            (node, tsx, script, app_data_dir, nm)
        } else {
            return Err(format!(
                "Gateway 脚本未找到:\n  prod tar.gz: {:?}\n  dev: {:?}",
                tar_path, dev_script
            ));
        };

    // Compute the resource directory exposed to the Gateway (for model files etc.)
    let gateway_resource_dir = if dev_script.exists() && cfg!(debug_assertions) {
        manifest_dir.join("resources")
    } else {
        resource_path.clone()
    };

    eprintln!(
        "[Gateway] node={:?}, tsx={:?}, script={:?}",
        node_exe, tsx_cmd, script_path
    );
    eprintln!("[Gateway] resource_dir={:?}", gateway_resource_dir);

    // Clean up any leftover process that may still hold port 18801.
    #[cfg(target_os = "windows")]
    kill_port_18801();

    // Build PATH: in prod mode, prepend the bundled node.exe directory.
    let current_path = std::env::var("PATH").unwrap_or_default();
    let is_bundled_node = node_exe.is_absolute() && node_exe.exists();
    let new_path = if is_bundled_node {
        let node_dir = node_exe.parent().unwrap_or(Path::new("."));
        let sep = if cfg!(target_os = "windows") { ";" } else { ":" };
        format!("{}{}{}", node_dir.to_string_lossy(), sep, current_path)
    } else {
        current_path
    };

    // Build the command.
    // Prod: `node --expose-gc --max-old-space-size=192 <tsx-cli.mjs> <start.ts>`
    // Dev:  `tsx <start.ts>`
    let mut cmd = if is_bundled_node {
        let mut c = Command::new(&node_exe);
        c.arg("--expose-gc")
            .arg("--max-old-space-size=192")
            .arg(tsx_cmd.to_string_lossy().to_string())
            .arg(script_path.to_string_lossy().to_string());
        c
    } else {
        let mut c = Command::new(&tsx_cmd);
        c.arg(script_path.to_string_lossy().to_string());
        c
    };
    cmd.env("PATH", &new_path)
        .env("NODE_PATH", node_modules_path.to_string_lossy().to_string())
        .env("OPENFLUX_RESOURCE_DIR", gateway_resource_dir.to_string_lossy().to_string())
        .current_dir(&working_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Explicitly forward the dev white-label overlay env vars so the gateway sidecar always
    // receives them, independent of the pnpm/tauri/cargo env-inheritance chain. Without this the
    // enterprise overlay (brand NexusAI/Router/data-dir isolation) can silently fail to load in dev.
    // Chrome 录制扩展目录跟随品牌 identifier（%APPDATA%/<identifier>/data/plugins/chrome）。
    // Gateway 侧的默认候选路径只有开源版 com.openflux.app，品牌版必须显式传入，
    // 否则已启用的扩展不会被 --load-extension 自动加载。
    if let Ok(data_dir) = app.path().app_data_dir() {
        let ext_dir = data_dir.join("data").join("plugins").join("chrome");
        cmd.env("OPENFLUX_CHROME_EXT_DIR", ext_dir.to_string_lossy().to_string());
    }

    if let Ok(overlay) = std::env::var("OPENFLUX_BRAND_OVERLAY") {
        eprintln!("[Gateway] Forwarding OPENFLUX_BRAND_OVERLAY={}", overlay);
        cmd.env("OPENFLUX_BRAND_OVERLAY", overlay);
    }
    if let Ok(brand_file) = std::env::var("OPENFLUX_BRAND_FILE") {
        cmd.env("OPENFLUX_BRAND_FILE", brand_file);
    } else {
        // Prod mode: if no env var is set, point to the bundled brand.json in resources/.brands/
        let bundled_brand = resource_path.join(".brands").join("brand.json");
        if bundled_brand.exists() {
            eprintln!("[Gateway] Using bundled brand config: {:?}", bundled_brand);
            cmd.env("OPENFLUX_BRAND_FILE", bundled_brand.to_string_lossy().to_string());
        }
    }

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd.spawn().map_err(|e| format!("启动 Gateway 失败: {}", e))?;

    // Create / truncate the log file.
    let log_dir  = working_dir.join("logs");
    let _ = std::fs::create_dir_all(&log_dir);
    let log_path = log_dir.join("gateway.log");
    let log_file: SharedLogFile = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&log_path)
        .map(|f| {
            eprintln!("[Gateway] Log file: {:?}", log_path);
            Some(std::sync::Arc::new(Mutex::new(f)))
        })
        .unwrap_or_else(|e| {
            eprintln!("[Gateway] Cannot create log file: {}", e);
            None
        });

    // Forward stdout / stderr to eprintln and log file.
    if let Some(stdout) = child.stdout.take() {
        spawn_stdout_forwarder(stdout, log_file.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_stderr_forwarder(stderr, log_file);
    }

    sidecar.child = Some(child);
    sidecar.stopping = false;
    eprintln!("[Gateway] sidecar started");

    // Watchdog thread: monitor the child, auto-restart on unexpected exit.
    {
        let app_clone = app.clone();
        std::thread::spawn(move || {
            loop {
                let child_opt = {
                    let state = app_clone.state::<Mutex<super::GatewaySidecar>>();
                    let mut sc = state.lock().unwrap();
                    sc.child.take()
                };

                if let Some(mut child) = child_opt {
                    let exit_status = child.wait();
                    eprintln!("[Gateway] sidecar exited: {:?}", exit_status);

                    let is_stopping = {
                        let state = app_clone.state::<Mutex<super::GatewaySidecar>>();
                        let guard = state.lock().unwrap();
                        guard.stopping
                    };
                    if is_stopping {
                        eprintln!("[Gateway] sidecar stopped intentionally, no restart");
                        break;
                    }

                    let exited_normally = exit_status
                        .as_ref()
                        .ok()
                        .and_then(|s| s.code())
                        .map(|code| code == 0)
                        .unwrap_or(false);
                    if exited_normally {
                        eprintln!("[Gateway] sidecar exited normally (exit code 0), no restart");
                        break;
                    }

                    eprintln!("[Gateway] sidecar crashed, restarting in 2s...");
                    std::thread::sleep(std::time::Duration::from_secs(2));

                    if let Err(e) = start_gateway_sidecar(&app_clone) {
                        eprintln!("[Gateway] auto-restart failed: {}", e);
                        break;
                    }
                    eprintln!("[Gateway] sidecar restarted successfully");
                } else {
                    break;
                }
            }
        });
    }

    Ok(())
}

/// Stop the Gateway sidecar process.
///
/// On Windows, uses `taskkill /F /T` to terminate the entire process tree
/// (the .cmd wrapper may spawn a child node process), then also cleans up
/// any process still holding port 18801 as a safety net.
pub fn stop_gateway_sidecar(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<Mutex<super::GatewaySidecar>>();
    let mut sidecar = state.lock().map_err(|e| e.to_string())?;

    // Mark as intentional stop before killing — watchdog checks this flag.
    sidecar.stopping = true;

    if let Some(mut child) = sidecar.child.take() {
        let pid = child.id();

        #[cfg(target_os = "windows")]
        {
            let result = Command::new("taskkill")
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
            match result {
                Ok(out) => eprintln!("[Gateway] taskkill pid={} exit={}", pid, out.status),
                Err(e)  => eprintln!("[Gateway] taskkill failed: {}", e),
            }
        }

        let _ = child.kill();
        let _ = child.wait();
        eprintln!("[Gateway] sidecar stopped (pid={})", pid);
    }

    // Extra safety: clean up anything still holding port 18801
    // (broken .cmd wrapper process trees can leave orphan node processes).
    #[cfg(target_os = "windows")]
    kill_port_18801();

    Ok(())
}
