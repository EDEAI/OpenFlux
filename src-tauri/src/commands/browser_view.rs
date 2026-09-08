//! Embedded browser tabs for the right panel.
//!
//! Each browser tab in the renderer owns a native child webview attached to
//! the main window (`Window::add_child`, Tauri's multi-webview API). The
//! renderer keeps the webview positioned over a placeholder element and tells
//! us when it must hide: a native webview paints above all HTML, so it has to
//! get out of the way of menus and inactive tabs.
//!
//! The commands are `async` on purpose. `add_child` blocks on the main thread
//! and, on Windows, deadlocks when called from a synchronous command.

use serde::Serialize;
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewUrl, Window};

/// Label of the window the panel lives in (the config window has no explicit label).
const HOST_WINDOW: &str = "main";
/// Event the renderer listens to for address-bar and title updates.
const NAVIGATION_EVENT: &str = "browser-view:navigated";

#[derive(Serialize, Clone)]
struct NavigationPayload {
    label: String,
    url: String,
    /// "start" when a navigation begins, "finished" once the page has loaded.
    kind: &'static str,
}

#[derive(Serialize)]
pub struct BrowserViewCreateResult {
    /// False when a webview with this label already existed and was adopted.
    pub created: bool,
    pub url: String,
}

fn host_window(app: &AppHandle) -> Result<Window, String> {
    app.get_window(HOST_WINDOW)
        .ok_or_else(|| format!("window '{}' not found", HOST_WINDOW))
}

fn view(app: &AppHandle, label: &str) -> Result<Webview, String> {
    app.get_webview(label)
        .ok_or_else(|| format!("browser view '{}' not found", label))
}

fn parse_url(raw: &str) -> Result<Url, String> {
    Url::parse(raw).map_err(|e| format!("invalid url '{}': {}", raw, e))
}

fn emit_navigation(app: &AppHandle, label: &str, url: &Url, kind: &'static str) {
    // A missed event only leaves the address bar stale for a moment; it must
    // never fail the navigation itself.
    let _ = app.emit_to(
        HOST_WINDOW,
        NAVIGATION_EVENT,
        NavigationPayload {
            label: label.to_string(),
            url: url.to_string(),
            kind,
        },
    );
}

fn apply_bounds(webview: &Webview, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    // Logical units: the renderer reports CSS pixels, which map 1:1.
    webview
        .set_position(LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    webview
        .set_size(LogicalSize::new(width.max(1.0), height.max(1.0)))
        .map_err(|e| e.to_string())
}

/// Create the webview for a tab, or adopt one that already exists under this
/// label (a tab coming back after its session was switched away and back).
#[tauri::command]
pub async fn browser_view_create(
    app: AppHandle,
    label: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<BrowserViewCreateResult, String> {
    if let Some(existing) = app.get_webview(&label) {
        apply_bounds(&existing, x, y, width, height)?;
        existing.show().map_err(|e| e.to_string())?;
        let current = existing.url().map(|u| u.to_string()).unwrap_or_default();
        return Ok(BrowserViewCreateResult { created: false, url: current });
    }

    let parsed = parse_url(&url)?;
    let window = host_window(&app)?;

    let nav_app = app.clone();
    let nav_label = label.clone();
    let load_app = app.clone();
    let load_label = label.clone();
    let popup_app = app.clone();
    let popup_label = label.clone();

    let builder = WebviewBuilder::new(&label, WebviewUrl::External(parsed))
        // Without this, the webview's OS-level file-drop handler intercepts
        // drag events, so in-page HTML5 drag-and-drop never reaches the page —
        // the user's real-mouse drag looks dead. This is a browser pane, not a
        // file-drop target, so turn the interception off.
        .disable_drag_drop_handler()
        .on_navigation(move |target| {
            emit_navigation(&nav_app, &nav_label, target, "start");
            true
        })
        .on_page_load(move |_webview, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                emit_navigation(&load_app, &load_label, payload.url(), "finished");
            }
        })
        // A tab is a single-page browser: anything that asks for a new window
        // (`target="_blank"`, `window.open`) navigates this same webview.
        // Without a handler wry marks the request handled and drops it, which
        // makes most links on real sites look dead.
        .on_new_window(move |url, _features| {
            let app = popup_app.clone();
            let label = popup_label.clone();
            // Off the handler's thread: WebView2 forbids re-entering the
            // control from inside its own event callbacks.
            std::thread::spawn(move || {
                if let Some(webview) = app.get_webview(&label) {
                    let _ = webview.navigate(url);
                }
            });
            NewWindowResponse::Deny
        });

    window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(width.max(1.0), height.max(1.0)),
        )
        .map_err(|e| format!("add_child failed: {}", e))?;

    Ok(BrowserViewCreateResult { created: true, url })
}

#[tauri::command]
pub async fn browser_view_set_bounds(
    app: AppHandle,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    apply_bounds(&view(&app, &label)?, x, y, width, height)
}

#[tauri::command]
pub async fn browser_view_set_visible(app: AppHandle, label: String, visible: bool) -> Result<(), String> {
    let webview = view(&app, &label)?;
    if visible {
        webview.show().map_err(|e| e.to_string())
    } else {
        #[cfg(target_os = "macos")]
        {
            let label = label.clone();
            let _ = webview.with_webview(move |_| macos::release_pressed(&label));
        }
        webview.hide().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn browser_view_navigate(app: AppHandle, label: String, url: String) -> Result<(), String> {
    view(&app, &label)?
        .navigate(parse_url(&url)?)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_view_reload(app: AppHandle, label: String) -> Result<(), String> {
    view(&app, &label)?.reload().map_err(|e| e.to_string())
}

/// Run JavaScript inside a tab's webview.
///
/// Used by the agent's soft-cursor overlay (`browser-cursor.ts`), which must
/// live inside the page's own document to draw above it. The script is authored
/// by the app, not by page content.
#[tauri::command]
pub async fn browser_view_eval(app: AppHandle, label: String, js: String) -> Result<(), String> {
    view(&app, &label)?.eval(&js).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_view_back(app: AppHandle, label: String) -> Result<(), String> {
    view(&app, &label)?
        .eval("history.back()")
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_view_forward(app: AppHandle, label: String) -> Result<(), String> {
    view(&app, &label)?
        .eval("history.forward()")
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_view_close(app: AppHandle, label: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let label = label.clone();
        let _ = app.run_on_main_thread(move || macos::release_pressed(&label));
    }
    match app.get_webview(&label) {
        Some(webview) => {
            webview.close().map_err(|e| e.to_string())
        }
        // Closing a tab that never got its webview is not an error.
        None => Ok(()),
    }
}

/// Call a Chrome DevTools Protocol method against a tab's webview and return
/// its JSON result.
///
/// This is how the agent drives an embedded tab — trusted input
/// (`Input.dispatchMouseEvent`), page evaluation, accessibility snapshots —
/// **without** opening a remote-debugging port. WebView2's own
/// `CallDevToolsProtocolMethod` targets exactly this one webview, so nothing
/// on the machine gains access to the user's logged-in browser.
///
/// Windows only: WKWebView (macOS) has no CDP, so there is no equivalent there.
#[cfg(windows)]
#[tauri::command]
pub async fn browser_view_cdp(
    app: AppHandle,
    label: String,
    method: String,
    params: Option<String>,
) -> Result<String, String> {
    use std::sync::mpsc::sync_channel;
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows::core::{HSTRING, PCWSTR};

    let webview = view(&app, &label)?;
    let params_json = params.unwrap_or_else(|| "{}".to_string());
    // WebView2 always fires the completion handler (with an error result for a
    // bad method), so exactly one message arrives here.
    let (tx, rx) = sync_channel::<Result<String, String>>(1);

    webview
        .with_webview(move |platform| {
            let attempt = (|| -> windows::core::Result<()> {
                // COM must run on the UI thread — which is where with_webview
                // puts us.
                let core = unsafe { platform.controller().CoreWebView2() }?;
                let method_w = HSTRING::from(method.as_str());
                let params_w = HSTRING::from(params_json.as_str());
                let tx_handler = tx.clone();
                let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                    move |result: windows::core::Result<()>, json: String| {
                        let _ = tx_handler.send(match result {
                            Ok(()) => Ok(json),
                            Err(err) => Err(format!("cdp error: {err}")),
                        });
                        Ok(())
                    },
                ));
                unsafe {
                    core.CallDevToolsProtocolMethod(
                        PCWSTR(method_w.as_ptr()),
                        PCWSTR(params_w.as_ptr()),
                        &handler,
                    )
                }?;
                Ok(())
            })();
            if let Err(err) = attempt {
                let _ = tx.send(Err(format!("cdp dispatch failed: {err}")));
            }
        })
        .map_err(|e| format!("with_webview failed: {e}"))?;

    rx.recv_timeout(std::time::Duration::from_secs(20))
        .map_err(|_| "cdp call timed out".to_string())?
}

#[cfg(target_os = "macos")]
#[path = "browser_view/macos.rs"]
mod macos;

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn browser_view_cdp(
    app: AppHandle,
    label: String,
    method: String,
    params: Option<String>,
) -> Result<String, String> {
    macos::dispatch(view(&app, &label)?, &method, params.as_deref()).await
}

#[cfg(not(any(windows, target_os = "macos")))]
#[tauri::command]
pub async fn browser_view_cdp(
    _app: AppHandle,
    _label: String,
    _method: String,
    _params: Option<String>,
) -> Result<String, String> {
    Err("embedded browser control is not supported on this platform".into())
}
