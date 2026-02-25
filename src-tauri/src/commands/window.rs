use tauri::WebviewWindow;

/// 窗口最小化
#[tauri::command]
pub async fn window_minimize(window: WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

/// 窗口最大化/还原
#[tauri::command]
pub async fn window_maximize(window: WebviewWindow) -> Result<(), String> {
    if window.is_maximized().unwrap_or(false) {
        window.unmaximize().map_err(|e| e.to_string())
    } else {
        window.maximize().map_err(|e| e.to_string())
    }
}

/// 关闭窗口（隐藏到托盘）
#[tauri::command]
pub async fn window_close(window: WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|e| e.to_string())
}

/// 任务栏闪烁
#[tauri::command]
pub async fn window_flash_frame(window: WebviewWindow, flash: bool) -> Result<(), String> {
    if flash {
        window
            .request_user_attention(Some(tauri::UserAttentionType::Informational))
            .map_err(|e| e.to_string())
    } else {
        window
            .request_user_attention(None::<tauri::UserAttentionType>)
            .map_err(|e| e.to_string())
    }
}
