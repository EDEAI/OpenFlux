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

/// 持久化界面语言偏好到 app_data_dir/ui-locale。
/// 原生 splash 先于 WebView 启动、读不到 localStorage，下次启动从这里读取。
#[tauri::command]
pub fn set_locale_pref(app: tauri::AppHandle, locale: String) -> Result<(), String> {
    use tauri::Manager;
    if locale != "zh" && locale != "en" {
        return Err(format!("unsupported locale: {locale}"));
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("ui-locale"), locale).map_err(|e| e.to_string())
}
