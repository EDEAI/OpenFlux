//! Chrome 录制扩展的安装 / 卸载 / 状态查询。
//!
//! 与 Office 插件不同，Chrome 扩展无需注册表 / SMB 共享：
//! - install：把打包资源 `resources/plugins/chrome` 复制到
//!   `AppData/com.openflux.app/data/plugins/chrome`，并移除 `.disabled` 标志。
//! - uninstall：写入 `.disabled` 标志（保留文件，仅停用），下次启动 sync 时跳过覆盖。
//! - status：扩展目录存在 `manifest.json` 且无 `.disabled` 标志即视为文件已准备。
//!
//! Chrome 正式版 137+ 不再支持 `--load-extension`。启用只准备扩展文件，
//! 用户需在目标 Chrome 的扩展管理页手动加载；文件状态不代表浏览器安装状态。

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::Manager;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 递归复制目录内容（覆盖已存在文件）。
fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let target = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// AppData 下的 Chrome 扩展目录：`<app_data>/data/plugins/chrome`。
fn chrome_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法解析 AppData 目录：{e}"))?
        .join("data")
        .join("plugins")
        .join("chrome"))
}

/// 从打包资源中定位 chrome 扩展源目录（兼容 dev 模式）。
fn resolve_resource_src(app: &tauri::AppHandle) -> Option<PathBuf> {
    // 与启动时的插件同步一致：开发模式优先使用源码，避免 target/debug 的旧资源副本。
    #[cfg(debug_assertions)]
    {
        let dev_src = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("plugins")
            .join("chrome");
        if dev_src.is_dir() {
            return Some(dev_src);
        }
    }
    let resource_dir = app.path().resource_dir().ok()?;
    let p1 = resource_dir
        .join("resources")
        .join("plugins")
        .join("chrome");
    if p1.exists() {
        return Some(p1);
    }
    let p2 = resource_dir
        .join("src-tauri")
        .join("resources")
        .join("plugins")
        .join("chrome");
    if p2.exists() {
        return Some(p2);
    }
    None
}

fn prepare_extension(src: Option<&Path>, dir: &Path) -> Result<(), String> {
    let previously_prepared =
        dir.join("manifest.json").is_file() && !dir.join(".disabled").exists();
    std::fs::create_dir_all(dir).map_err(|e| format!("创建扩展目录失败：{e}"))?;
    // 首次准备也先保留停用标志，避免只复制了 manifest 就因其他文件失败而误报启用。
    if !previously_prepared {
        disable_extension(dir)?;
    }
    match src {
        Some(src) => {
            copy_dir_all(src, dir).map_err(|e| format!("复制扩展文件失败：{e}"))?;
        }
        None => {
            if !dir.join("manifest.json").is_file() {
                return Err("未找到 Chrome 扩展资源，请重新安装 OpenFlux。".to_string());
            }
        }
    }

    let manifest_bytes = std::fs::read(dir.join("manifest.json"))
        .map_err(|e| format!("读取 Chrome 扩展 manifest.json 失败：{e}"))?;
    let manifest: serde_json::Value = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| format!("Chrome 扩展 manifest.json 无效：{e}"))?;
    if manifest["manifest_version"].as_u64() != Some(3)
        || manifest["name"].as_str().unwrap_or_default().is_empty()
        || manifest["version"].as_str().unwrap_or_default().is_empty()
    {
        return Err("Chrome 扩展 manifest.json 缺少有效的名称、版本或 Manifest V3 声明。".into());
    }

    // 文件准备成功后才能更新开关，失败时保留用户之前的停用状态。
    match std::fs::remove_file(dir.join(".disabled")) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("清除扩展停用标志失败：{e}")),
    }
    Ok(())
}

/// 准备（启用）Chrome 录制扩展文件；浏览器内仍需用户手动安装。
#[tauri::command]
pub fn chrome_extension_install(app: tauri::AppHandle) -> Result<String, String> {
    let dir = chrome_dir(&app)?;
    let src = resolve_resource_src(&app);
    prepare_extension(src.as_deref(), &dir)?;
    Ok(format!(
        "✅ Chrome 录制扩展文件已准备。\n\n请在要使用的 Chrome 中打开 chrome://extensions/，开启「开发者模式」，点击「加载已解压的扩展程序」并选择：\n{}\n\nChrome 正式版 137+ 无法通过开关自动安装扩展。加载后可在工具栏的「扩展程序」菜单中将 OpenFlux Recorder 固定。",
        dir.display()
    ))
}

/// 返回真实安装目录（跟随应用品牌 identifier）。
#[tauri::command]
pub fn chrome_extension_path(app: tauri::AppHandle) -> Result<String, String> {
    Ok(chrome_dir(&app)?.to_string_lossy().into_owned())
}

fn first_existing_file(paths: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    paths.into_iter().find(|path| path.is_file())
}

#[cfg(target_os = "windows")]
fn registry_chrome_paths() -> Vec<PathBuf> {
    // 固定脚本只读注册表，并用 UTF-8 返回路径；不插入用户数据，也不依赖 reg.exe 的本地编码。
    const SCRIPT: &str = r#"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryHive]::LocalMachine)) {
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
        $base = $null
        $key = $null
        try {
            $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
            $key = $base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe')
            if ($null -ne $key) {
                $value = $key.GetValue('')
                if ($value -is [string] -and $value.Length -gt 0) { [Console]::WriteLine($value) }
            }
        } catch {} finally {
            if ($null -ne $key) { $key.Dispose() }
            if ($null -ne $base) { $base.Dispose() }
        }
    }
}
"#;
    let result = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    match result {
        Ok(output) if output.status.success() => String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(|line| PathBuf::from(line.trim().trim_matches('"')))
            .filter(|path| !path.as_os_str().is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

fn chrome_executable() -> Option<PathBuf> {
    let mut paths = Vec::new();
    #[cfg(target_os = "windows")]
    {
        paths.extend(registry_chrome_paths());
        for variable in ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"] {
            if let Some(root) = std::env::var_os(variable) {
                paths.push(PathBuf::from(root).join("Google/Chrome/Application/chrome.exe"));
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        paths.push(PathBuf::from(
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        ));
        if let Some(home_dir) = std::env::var_os("HOME") {
            paths.push(
                PathBuf::from(home_dir)
                    .join("Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            );
        }
    }
    for name in [
        "google-chrome",
        "google-chrome-stable",
        "chrome",
        "chromium",
        "chromium-browser",
    ] {
        if let Ok(path) = which::which(name) {
            paths.push(path);
        }
    }
    first_existing_file(paths)
}

/// 直接调用 Chrome；默认浏览器无法打开 chrome:// 扩展管理页。
#[tauri::command]
pub async fn chrome_extension_open_settings() -> Result<(), String> {
    // 注册表探测与进程启动会阻塞，放到后台线程以保持 Tauri 界面响应。
    tauri::async_runtime::spawn_blocking(open_chrome_extension_settings)
        .await
        .map_err(|e| format!("打开 Chrome 扩展管理页任务失败：{e}"))?
}

fn open_chrome_extension_settings() -> Result<(), String> {
    let executable = chrome_executable().ok_or_else(|| {
        "未找到 Chrome。请安装 Chrome，或在自己的 Chrome 中打开 chrome://extensions/。".to_string()
    })?;
    let mut command = Command::new(executable);
    command
        .args(["--new-window", "chrome://extensions/"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    command
        .spawn()
        .map_err(|e| format!("打开 Chrome 扩展管理页失败：{e}"))?;
    Ok(())
}

/// 卸载（停用）Chrome 录制扩展：写入 `.disabled` 标志。
#[tauri::command]
pub fn chrome_extension_uninstall(app: tauri::AppHandle) -> Result<String, String> {
    let dir = chrome_dir(&app)?;
    disable_extension(&dir)?;
    Ok("✅ 已停用 OpenFlux 的 Chrome 扩展文件自动同步与加载。\n\n已在 Chrome 中手动安装的扩展仍由 Chrome 管理，请打开 chrome://extensions/ 将 OpenFlux Recorder 关闭或移除。".to_string())
}

fn disable_extension(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("创建扩展目录失败：{e}"))?;
    std::fs::write(dir.join(".disabled"), b"disabled").map_err(|e| format!("写入停用标志失败：{e}"))
}

/// 查询本地文件准备状态；不代表 Chrome 已安装或加载扩展。
#[tauri::command]
pub fn chrome_extension_status(app: tauri::AppHandle) -> bool {
    match chrome_dir(&app) {
        Ok(dir) => dir.join("manifest.json").is_file() && !dir.join(".disabled").exists(),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "openflux-chrome-{label}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            // Fixtures contain files and empty directories; cleanup never recurses.
            if let Ok(entries) = std::fs::read_dir(&self.0) {
                for entry in entries.flatten() {
                    let _ = std::fs::remove_file(entry.path());
                    let _ = std::fs::remove_dir(entry.path());
                }
            }
            let _ = std::fs::remove_dir(&self.0);
        }
    }

    const MANIFEST: &str = r#"{"manifest_version":3,"name":"Recorder","version":"1.0.0"}"#;

    #[test]
    fn failed_prepare_preserves_disabled_marker() {
        let destination = TestDir::new("failed-prepare");
        disable_extension(&destination.0).unwrap();
        assert!(prepare_extension(None, &destination.0).is_err());
        assert!(destination.0.join(".disabled").is_file());

        std::fs::write(destination.0.join("manifest.json"), "invalid JSON").unwrap();
        assert!(prepare_extension(None, &destination.0).is_err());
        assert!(destination.0.join(".disabled").is_file());
    }

    #[test]
    fn successful_prepare_copies_files_then_enables() {
        let source = TestDir::new("source");
        let destination = TestDir::new("destination");
        std::fs::write(source.0.join("manifest.json"), MANIFEST).unwrap();
        std::fs::write(source.0.join("background.js"), "// fresh resource").unwrap();
        disable_extension(&destination.0).unwrap();
        prepare_extension(Some(&source.0), &destination.0).unwrap();
        assert!(!destination.0.join(".disabled").exists());
        assert_eq!(
            std::fs::read_to_string(destination.0.join("background.js")).unwrap(),
            "// fresh resource"
        );
    }

    #[test]
    fn first_partial_copy_failure_keeps_extension_disabled() {
        let source = TestDir::new("partial-source");
        let destination = TestDir::new("partial-destination");
        std::fs::write(source.0.join("manifest.json"), MANIFEST).unwrap();
        std::fs::write(source.0.join("zzz-conflict.js"), "// resource").unwrap();
        std::fs::create_dir(destination.0.join("zzz-conflict.js")).unwrap();

        assert!(prepare_extension(Some(&source.0), &destination.0).is_err());
        assert!(destination.0.join(".disabled").is_file());
    }

    #[test]
    fn disabling_missing_directory_keeps_sync_disabled() {
        let destination = TestDir::new("missing-destination");
        std::fs::remove_dir(&destination.0).unwrap();
        disable_extension(&destination.0).unwrap();
        assert!(destination.0.join(".disabled").is_file());
    }

    #[test]
    fn executable_resolution_skips_directories_and_preserves_spaces() {
        let directory = TestDir::new("executable");
        let executable = directory.0.join("Chrome with spaces.exe");
        std::fs::write(&executable, "executable fixture").unwrap();
        assert_eq!(
            first_existing_file([
                directory.0.join("missing.exe"),
                directory.0.clone(),
                executable.clone()
            ]),
            Some(executable)
        );
    }
}
