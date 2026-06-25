//! Chrome 录制扩展的安装 / 卸载 / 状态查询。
//!
//! 与 Office 插件不同，Chrome 扩展无需注册表 / SMB 共享：
//! - install：把打包资源 `resources/plugins/chrome` 复制到
//!   `AppData/com.openflux.app/data/plugins/chrome`，并移除 `.disabled` 标志。
//! - uninstall：写入 `.disabled` 标志（保留文件，仅停用），下次启动 sync 时跳过覆盖。
//! - status：扩展目录存在 `manifest.json` 且无 `.disabled` 标志即视为已启用。
//!
//! 启用后，Gateway 的 `browser` 工具会在启动 OpenFlux 托管的 Chrome 时
//! 追加 `--load-extension=<该目录>`，从而自动加载录制扩展。

use std::path::{Path, PathBuf};
use tauri::Manager;

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
    let resource_dir = app.path().resource_dir().ok()?;
    let p1 = resource_dir.join("resources").join("plugins").join("chrome");
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
    #[cfg(debug_assertions)]
    {
        let p3 = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("plugins")
            .join("chrome");
        if p3.exists() {
            return Some(p3);
        }
    }
    None
}

/// 安装（启用）Chrome 录制扩展。
#[tauri::command]
pub fn chrome_extension_install(app: tauri::AppHandle) -> Result<String, String> {
    let dir = chrome_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建扩展目录失败：{e}"))?;

    // 移除停用标志
    let _ = std::fs::remove_file(dir.join(".disabled"));

    // 从资源复制最新扩展文件
    match resolve_resource_src(&app) {
        Some(src) => {
            copy_dir_all(&src, &dir).map_err(|e| format!("复制扩展文件失败：{e}"))?;
        }
        None => {
            if !dir.join("manifest.json").exists() {
                return Err("未找到 Chrome 扩展资源，请重新安装 OpenFlux。".to_string());
            }
        }
    }

    Ok("✅ 已启用 Chrome 录制扩展！\n\n下次由 OpenFlux 启动的 Chrome 将自动加载该扩展；\n点击工具栏中的 OpenFlux Recorder 图标即可开始录制。".to_string())
}

/// 卸载（停用）Chrome 录制扩展：写入 `.disabled` 标志。
#[tauri::command]
pub fn chrome_extension_uninstall(app: tauri::AppHandle) -> Result<String, String> {
    let dir = chrome_dir(&app)?;
    if dir.exists() {
        std::fs::write(dir.join(".disabled"), b"disabled")
            .map_err(|e| format!("写入停用标志失败：{e}"))?;
    }
    Ok("✅ 已停用 Chrome 录制扩展。\n\nOpenFlux 启动的 Chrome 将不再加载该扩展。".to_string())
}

/// 查询安装状态：存在 `manifest.json` 且无 `.disabled` 标志。
#[tauri::command]
pub fn chrome_extension_status(app: tauri::AppHandle) -> bool {
    match chrome_dir(&app) {
        Ok(dir) => dir.join("manifest.json").exists() && !dir.join(".disabled").exists(),
        Err(_) => false,
    }
}
