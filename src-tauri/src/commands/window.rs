use tauri::WebviewWindow;

/// Minimize the window
#[tauri::command]
pub async fn window_minimize(window: WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

/// Maximize / restore the window
#[tauri::command]
pub async fn window_maximize(window: WebviewWindow) -> Result<(), String> {
    if window.is_maximized().unwrap_or(false) {
        window.unmaximize().map_err(|e| e.to_string())
    } else {
        window.maximize().map_err(|e| e.to_string())
    }
}

/// Close the window (hide to tray)
#[tauri::command]
pub async fn window_close(window: WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|e| e.to_string())
}

/// Flash the taskbar icon
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
