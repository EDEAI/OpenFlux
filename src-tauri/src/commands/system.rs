/// Relaunch the application
#[tauri::command]
pub async fn app_relaunch(app: tauri::AppHandle) -> Result<(), String> {
    app.restart();
}

/// 关闭原生启动 splash（前端 WebView 首帧渲染后调用；非 Windows 平台为空操作）
#[tauri::command]
pub fn splash_close() {
    #[cfg(target_os = "windows")]
    crate::splash::close();
}
