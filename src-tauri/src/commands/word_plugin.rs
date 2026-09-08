//! Word Add-in management (thin wrapper; logic lives in office_plugin_common.rs)

use super::office_plugin_common::{self as common, OfficePlugin};

const PLUGIN: OfficePlugin = OfficePlugin {
    sub: "word",
    addin_id: "{c3d4e5f6-a7b8-9012-cdef-123456789012}",
    process: "WINWORD",
    app_label: "Word",
    share: "OpenFluxWord",
    display: "Word",
    mac_container: "com.microsoft.Word",
};

// 命令均为 async + spawn_blocking，避免 PowerShell 子进程阻塞主线程冻结 UI（见 excel_plugin.rs）。
#[tauri::command]
pub async fn word_plugin_install(app: tauri::AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || common::install(&app, &PLUGIN))
        .await
        .map_err(|e| format!("插件安装任务异常: {e}"))?
}

#[tauri::command]
pub async fn word_plugin_uninstall() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| common::uninstall(&PLUGIN))
        .await
        .map_err(|e| format!("插件卸载任务异常: {e}"))?
}

#[tauri::command]
pub async fn word_plugin_status() -> bool {
    tauri::async_runtime::spawn_blocking(|| common::status(&PLUGIN))
        .await
        .unwrap_or(false)
}
