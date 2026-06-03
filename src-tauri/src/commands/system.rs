/// Relaunch the application
#[tauri::command]
pub async fn app_relaunch(app: tauri::AppHandle) -> Result<(), String> {
    app.restart();
}
