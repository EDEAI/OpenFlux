//! Excel Add-in management (thin wrapper; logic lives in office_plugin_common.rs)

use super::office_plugin_common::{self as common, OfficePlugin};

const PLUGIN: OfficePlugin = OfficePlugin {
    sub: "excel",
    addin_id: "{a1b2c3d4-e5f6-7890-abcd-ef1234567890}",
    process: "EXCEL",
    app_label: "Excel",
    share: "OpenFluxExcel",
    display: "Excel",
    mac_container: "com.microsoft.Excel",
};

// 命令均为 async + spawn_blocking：安装/卸载内部要跑多个 PowerShell 子进程（SMB 共享、
// 注册表、certutil、杀进程等待），同步命令会在主线程执行并冻结整个 UI（低配设备上数秒）。
#[tauri::command]
pub async fn excel_plugin_install(app: tauri::AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || common::install(&app, &PLUGIN))
        .await
        .map_err(|e| format!("插件安装任务异常: {e}"))?
}

#[tauri::command]
pub async fn excel_plugin_uninstall() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| common::uninstall(&PLUGIN))
        .await
        .map_err(|e| format!("插件卸载任务异常: {e}"))?
}

#[tauri::command]
pub async fn excel_plugin_status() -> bool {
    tauri::async_runtime::spawn_blocking(|| common::status(&PLUGIN))
        .await
        .unwrap_or(false)
}
