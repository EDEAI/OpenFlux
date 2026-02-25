/// 重启应用
#[tauri::command]
pub async fn app_relaunch(app: tauri::AppHandle) -> Result<(), String> {
    app.restart();
}
