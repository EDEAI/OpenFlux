//! PowerPoint Add-in 管理（薄封装，逻辑见 office_plugin_common.rs）

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

#[tauri::command]
pub fn ppt_plugin_install(app: tauri::AppHandle) -> Result<String, String> {
    common::install(&app, &PLUGIN)
}

#[tauri::command]
pub fn ppt_plugin_uninstall() -> Result<String, String> {
    common::uninstall(&PLUGIN)
}

#[tauri::command]
pub fn ppt_plugin_status() -> bool {
    common::status(&PLUGIN)
}
