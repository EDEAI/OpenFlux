//! PowerPoint Add-in management (thin wrapper; logic lives in office_plugin_common.rs)

use super::office_plugin_common::{self as common, OfficePlugin};

const PLUGIN: OfficePlugin = OfficePlugin {
    sub: "powerpoint",
    addin_id: "{e5f6a7b8-c9d0-1234-ef01-234567890123}",
    process: "POWERPNT",
    app_label: "PowerPoint",
    share: "OpenFluxPPT",
    display: "PowerPoint",
    mac_container: "com.microsoft.Powerpoint",
};

// 命令均为 async + spawn_blocking，避免 PowerShell 子进程阻塞主线程冻结 UI（见 excel_plugin.rs）。
#[tauri::command]
pub async fn ppt_plugin_install(app: tauri::AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || common::install(&app, &PLUGIN))
        .await
        .map_err(|e| format!("插件安装任务异常: {e}"))?
}

#[tauri::command]
pub async fn ppt_plugin_uninstall() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| common::uninstall(&PLUGIN))
        .await
        .map_err(|e| format!("插件卸载任务异常: {e}"))?
}

#[tauri::command]
pub async fn ppt_plugin_status() -> bool {
    tauri::async_runtime::spawn_blocking(|| common::status(&PLUGIN))
        .await
        .unwrap_or(false)
}
