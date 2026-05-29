//! Excel Add-in 管理（薄封装，逻辑见 office_plugin_common.rs）

use super::office_plugin_common::{self as common, OfficePlugin};

const PLUGIN: OfficePlugin = OfficePlugin {
    sub: "excel",
    addin_id: "{a1b2c3d4-e5f6-7890-abcd-ef1234567890}",
    process: "EXCEL",
    app_label: "Excel",
    share: "OpenFluxExcel",
    display: "Excel",
};

#[tauri::command]
pub fn excel_plugin_install(app: tauri::AppHandle) -> Result<String, String> {
    common::install(&app, &PLUGIN)
}

#[tauri::command]
pub fn excel_plugin_uninstall() -> Result<String, String> {
    common::uninstall(&PLUGIN)
}

#[tauri::command]
pub fn excel_plugin_status() -> bool {
    common::status(&PLUGIN)
}
