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

#[tauri::command]
pub fn word_plugin_install(app: tauri::AppHandle) -> Result<String, String> {
    common::install(&app, &PLUGIN)
}

#[tauri::command]
pub fn word_plugin_uninstall() -> Result<String, String> {
    common::uninstall(&PLUGIN)
}

#[tauri::command]
pub fn word_plugin_status() -> bool {
    common::status(&PLUGIN)
}
