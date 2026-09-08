// `Window`, not `WebviewWindow`: the main window hosts extra child webviews
// (the right-panel browser tabs), and Tauri can only extract a WebviewWindow
// from a window with exactly one webview. With a tab open, a WebviewWindow
// parameter fails with "current webview is not a WebviewWindow" and the
// title-bar buttons stop working.
use tauri::Window;

/// Minimize the window
#[tauri::command]
pub async fn window_minimize(window: Window) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

/// Maximize / restore the window
#[tauri::command]
pub async fn window_maximize(window: Window) -> Result<(), String> {
    if window.is_maximized().unwrap_or(false) {
        window.unmaximize().map_err(|e| e.to_string())
    } else {
        window.maximize().map_err(|e| e.to_string())
    }
}

/// Close the window (hide to tray)
#[tauri::command]
pub async fn window_close(window: Window) -> Result<(), String> {
    window.hide().map_err(|e| e.to_string())
}

/// Flash the taskbar icon
#[tauri::command]
pub async fn window_flash_frame(window: Window, flash: bool) -> Result<(), String> {
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
