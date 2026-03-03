use crate::config::AppConfig;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// Windows: CREATE_NO_WINDOW 标志，防止 .cmd 文件执行时闪控制台窗口
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Serialize)]
pub struct GatewayConfig {
    pub url: String,
    pub token: Option<String>,
}

/// Gateway sidecar 进程状态
pub struct GatewaySidecar {
    child: Option<Child>,
}

impl GatewaySidecar {
    pub fn new() -> Self {
        Self { child: None }
    }
}

/// 获取 Gateway WebSocket 连接配置
#[tauri::command]
pub async fn get_gateway_config(
    config: tauri::State<'_, AppConfig>,
) -> Result<GatewayConfig, String> {
    Ok(GatewayConfig {
        url: format!("ws://{}:{}", config.host, config.port),
        token: config.token.clone(),
    })
}

/// 从 gateway-bundle.tar.gz 解压 gateway 到 app_data_dir
fn extract_gateway_bundle(tar_gz_path: &Path, dest_dir: &Path) -> Result<(), String> {
    eprintln!("[Gateway] Extracting gateway-bundle.tar.gz -> {:?}", dest_dir);

    let file = std::fs::File::open(tar_gz_path)
        .map_err(|e| format!("Failed to open gateway-bundle.tar.gz: {}", e))?;
    let gz = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(gz);

    archive.unpack(dest_dir)
        .map_err(|e| format!("Failed to extract tar.gz: {}", e))?;

    eprintln!("[Gateway] Extraction complete");
    Ok(())
}

/// 初始化 gateway 运行时（prod 模式：首次运行解压 tar）
fn setup_gateway_runtime(resource_dir: &Path, app_data_dir: &Path) -> Result<PathBuf, String> {
    let gateway_data = app_data_dir.join("gateway");
    let gateway_script = gateway_data.join("src").join("gateway").join("start.ts");

    // 如果 gateway 目录不存在或启动脚本不存在，需要解压
    if !gateway_script.exists() {
        let tar_path = resource_dir.join("gateway-bundle.tar.gz");
        if !tar_path.exists() {
            return Err(format!("gateway-bundle.tar.gz not found: {:?}", tar_path));
        }
        // 清理旧的不完整目录
        if gateway_data.exists() {
            std::fs::remove_dir_all(&gateway_data)
                .map_err(|e| format!("Failed to clean old gateway dir: {}", e))?;
        }
        std::fs::create_dir_all(&gateway_data)
            .map_err(|e| format!("Failed to create gateway dir: {}", e))?;
        extract_gateway_bundle(&tar_path, &gateway_data)?;
    }

    Ok(gateway_data)
}

/// 获取平台对应的 Node 二进制文件名
fn get_node_binary_name() -> &'static str {
    if cfg!(target_os = "windows") { "node.exe" } else { "node" }
}

/// 获取 node 路径（prod=内嵌, dev=系统）
fn get_node_exe(resource_dir: &Path) -> PathBuf {
    let bundled = resource_dir.join(get_node_binary_name());
    if bundled.exists() {
        bundled
    } else {
        PathBuf::from("node")
    }
}

/// 启动 Gateway sidecar 进程
pub fn start_gateway_sidecar(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<Mutex<GatewaySidecar>>();
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

    // 检查是否 prod 模式（资源目录下有 gateway-bundle.tar 或已解压的 gateway）
    let tar_path = resource_path.join("gateway-bundle.tar.gz");

    // dev 模式判断条件：
    // 1. dev 源码存在
    // 2. 当前 exe 位于 manifest_dir/target/ 下（真正的开发构建）
    //    避免安装版因开发源码在同一机器上而误入 dev 模式
    let exe_path = std::env::current_exe().unwrap_or_default();
    let is_dev_exe = exe_path.starts_with(manifest_dir.join("target"));
    let (node_exe, tsx_cmd, script_path, working_dir) = if dev_script.exists() && is_dev_exe {
        // ===== dev 模式 =====
        let node = PathBuf::from("node");
        let tsx_name = if cfg!(target_os = "windows") { "tsx.cmd" } else { "tsx" };
        let tsx = dev_gateway_root.join("node_modules").join(".bin").join(tsx_name);
        (node, tsx, dev_script, manifest_dir.join(".."))
    } else if tar_path.exists() {
        // ===== prod 模式 =====
        let app_data_dir = app.path().app_data_dir()
            .map_err(|e| format!("获取 app data 目录失败: {}", e))?;
        std::fs::create_dir_all(&app_data_dir)
            .map_err(|e| format!("创建 app data 目录失败: {}", e))?;

        let gateway_data = setup_gateway_runtime(&resource_path, &app_data_dir)?;
        let node = get_node_exe(&resource_path);
        // prod 模式直接用内嵌 node.exe 运行 tsx cli.mjs，
        // 避免 tsx.cmd 的 node 查找逻辑被系统 node 污染
        let tsx = gateway_data.join("node_modules").join("tsx").join("dist").join("cli.mjs");
        let script = gateway_data.join("src").join("gateway").join("start.ts");

        // 首次启动：将 openflux.example.yaml 复制为初始配置
        // Gateway 的 loadConfig() 会在 cwd (app_data_dir) 下查找 openflux.yaml
        let config_dest = app_data_dir.join("openflux.yaml");
        if !config_dest.exists() {
            // Tauri 对 "../" 前缀的 resource 会放到 _up_ 子目录
            let candidates = [
                resource_path.join("openflux.example.yaml"),
                resource_path.join("_up_").join("openflux.example.yaml"),
            ];
            if let Some(src) = candidates.iter().find(|p| p.exists()) {
                std::fs::copy(src, &config_dest)
                    .map_err(|e| format!("复制初始配置文件失败: {}", e))?;
                eprintln!("[Gateway] Copied initial config: {:?} -> {:?}", src, config_dest);
            } else {
                eprintln!("[Gateway] Warning: openflux.example.yaml not found, search paths: {:?}", candidates);
            }
        }

        // 直接用内嵌 node.exe 运行，不走 tsx.cmd
        (node, tsx, script, app_data_dir)
    } else {
        return Err(format!(
            "Gateway 脚本未找到:\n  prod tar.gz: {:?}\n  dev: {:?}",
            tar_path, dev_script
        ));
    };

    eprintln!("[Gateway] node={:?}, tsx={:?}, script={:?}", node_exe, tsx_cmd, script_path);

    // 构建 PATH 环境变量：仅 prod 模式需要把内嵌 node.exe 目录加到 PATH
    let current_path = std::env::var("PATH").unwrap_or_default();
    let is_bundled_node = node_exe.is_absolute() && node_exe.exists();
    let new_path = if is_bundled_node {
        let node_dir = node_exe.parent().unwrap_or(Path::new("."));
        let sep = if cfg!(target_os = "windows") { ";" } else { ":" };
        format!("{}{}{}", node_dir.to_string_lossy(), sep, current_path)
    } else {
        current_path
    };

    // 使用 std::process::Command 启动，设置 CREATE_NO_WINDOW 避免 .cmd 闪控制台
    // prod 模式：直接用内嵌 node.exe 运行 tsx cli.mjs（绕过 tsx.cmd 的 node 查找）
    // dev 模式：用 tsx.cmd 启动（tsx.cmd 自行查找系统 node）
    let mut cmd = if is_bundled_node {
        let mut c = Command::new(&node_exe);
        c.arg(tsx_cmd.to_string_lossy().to_string())
         .arg(script_path.to_string_lossy().to_string());
        c
    } else {
        let mut c = Command::new(&tsx_cmd);
        c.arg(script_path.to_string_lossy().to_string());
        c
    };
    cmd.env("PATH", &new_path)
        .current_dir(&working_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd.spawn()
        .map_err(|e| format!("启动 Gateway 失败: {}", e))?;

    // 创建日志文件（每次启动覆盖旧日志）
    let log_dir = working_dir.join("logs");
    let _ = std::fs::create_dir_all(&log_dir);
    let log_path = log_dir.join("gateway.log");
    // 截断旧日志，保持文件可控
    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&log_path);
    let log_file = match log_file {
        Ok(f) => {
            eprintln!("[Gateway] Log file: {:?}", log_path);
            Some(std::sync::Arc::new(std::sync::Mutex::new(f)))
        }
        Err(e) => {
            eprintln!("[Gateway] Cannot create log file: {}", e);
            None
        }
    };

    // 后台线程转发 stdout（同时写入日志文件）
    if let Some(stdout) = child.stdout.take() {
        let log_clone = log_file.clone();
        std::thread::spawn(move || {
            use std::io::{BufRead, Write};
            let reader = std::io::BufReader::new(stdout);
            for line in reader.lines() {
                if let Ok(line) = line {
                    eprintln!("[Gateway] {}", line);
                    if let Some(ref lf) = log_clone {
                        if let Ok(mut f) = lf.lock() {
                            let _ = writeln!(f, "[Gateway] {}", line);
                        }
                    }
                }
            }
        });
    }

    // 后台线程转发 stderr（同时写入日志文件）
    if let Some(stderr) = child.stderr.take() {
        let log_clone = log_file.clone();
        std::thread::spawn(move || {
            use std::io::{BufRead, Write};
            let reader = std::io::BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(line) = line {
                    eprintln!("[Gateway:ERR] {}", line);
                    if let Some(ref lf) = log_clone {
                        if let Ok(mut f) = lf.lock() {
                            let _ = writeln!(f, "[Gateway:ERR] {}", line);
                        }
                    }
                }
            }
        });
    }

    sidecar.child = Some(child);
    eprintln!("[Gateway] sidecar started");
    Ok(())
}

/// 停止 Gateway sidecar 进程
pub fn stop_gateway_sidecar(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<Mutex<GatewaySidecar>>();
    let mut sidecar = state.lock().map_err(|e| e.to_string())?;

    if let Some(mut child) = sidecar.child.take() {
        child.kill().map_err(|e| format!("停止 Gateway 失败: {}", e))?;
        let _ = child.wait(); // 等待进程完全退出
        eprintln!("[Gateway] sidecar stopped");
    }

    Ok(())
}

#[tauri::command]
pub async fn start_gateway(app: AppHandle) -> Result<(), String> {
    start_gateway_sidecar(&app)
}

#[tauri::command]
pub async fn stop_gateway(app: AppHandle) -> Result<(), String> {
    stop_gateway_sidecar(&app)
}

#[tauri::command]
pub async fn restart_gateway(app: AppHandle) -> Result<(), String> {
    stop_gateway_sidecar(&app)?;
    std::thread::sleep(std::time::Duration::from_millis(500));
    start_gateway_sidecar(&app)
}
