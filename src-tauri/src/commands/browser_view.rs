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
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewUrl, Window};

/// Label of the window the panel lives in (the config window has no explicit label).
const HOST_WINDOW: &str = "main";
/// Event the renderer listens to for address-bar and title updates.
const NAVIGATION_EVENT: &str = "browser-view:navigated";
/// Event the renderer listens to for file downloads started/finished by a tab.
const DOWNLOAD_EVENT: &str = "browser-view:download";

/// Where tab downloads land. Set by the renderer (`browser_view_set_download_dir`)
/// from the gateway's output path; until then the engine's default folder is kept.
static DOWNLOAD_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);

#[derive(Serialize, Clone)]
struct NavigationPayload {
    label: String,
    url: String,
    /// "start" when a navigation begins, "finished" once the page has loaded.
    kind: &'static str,
}

#[derive(Serialize, Clone)]
struct DownloadPayload {
    label: String,
    url: String,
    /// Absolute path the file is being written to (empty when unknown).
    path: String,
    /// "started" when the download is accepted, "finished" when it ends.
    kind: &'static str,
    /// Only meaningful for "finished".
    success: bool,
}

fn download_dir() -> Option<PathBuf> {
    DOWNLOAD_DIR.lock().ok().and_then(|d| d.clone())
}

/// Pick `dir/<name>` that does not exist yet: `report.pdf`, `report (1).pdf`, …
/// The engine's own suggested name (from Content-Disposition or the URL) is kept.
fn unique_target(dir: &Path, suggested: &Path) -> PathBuf {
    let name = suggested
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "download".to_string());
    let candidate = dir.join(&name);
    if !candidate.exists() {
        return candidate;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (name[..i].to_string(), name[i..].to_string()),
        _ => (name.clone(), String::new()),
    };
    for n in 1..1000 {
        let candidate = dir.join(format!("{stem} ({n}){ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!("{stem}-{}{ext}", std::process::id()))
}

fn emit_download(app: &AppHandle, label: &str, url: &Url, path: &Path, kind: &'static str, success: bool) {
    let _ = app.emit_to(
        HOST_WINDOW,
        DOWNLOAD_EVENT,
        DownloadPayload {
            label: label.to_string(),
            url: url.to_string(),
            path: path.to_string_lossy().to_string(),
            kind,
            success,
        },
    );
}

/// Set the folder tab downloads are saved to (created on demand). An empty
/// path restores the engine's default download folder.
#[tauri::command]
pub async fn browser_view_set_download_dir(path: String) -> Result<String, String> {
    let trimmed = path.trim();
    let next = if trimmed.is_empty() {
        None
    } else {
        let dir = PathBuf::from(trimmed);
        if !dir.is_absolute() {
            return Err(format!("download dir must be absolute: {}", trimmed));
        }
        std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create download dir {}: {}", dir.display(), e))?;
        Some(dir)
    };
    let shown = next.as_ref().map(|d| d.to_string_lossy().to_string()).unwrap_or_default();
    *DOWNLOAD_DIR.lock().map_err(|_| "download dir lock poisoned".to_string())? = next;
    Ok(shown)
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
    let dl_app = app.clone();
    let dl_label = label.clone();

    let builder = WebviewBuilder::new(&label, WebviewUrl::External(parsed))
        // Downloads: redirect into the configured folder (the gateway's output
        // dir, so the agent can pick the file up) and tell the renderer about
        // start and end. With a handler installed the engine hides its own
        // download bar, so the pane shows the status instead.
        .on_download(move |_webview, event| {
            match event {
                DownloadEvent::Requested { url, destination } => {
                    if let Some(dir) = download_dir() {
                        if std::fs::create_dir_all(&dir).is_ok() {
                            *destination = unique_target(&dir, destination);
                        }
                    }
                    emit_download(&dl_app, &dl_label, &url, destination, "started", false);
                }
                DownloadEvent::Finished { url, path, success } => {
                    let path = path.unwrap_or_default();
                    emit_download(&dl_app, &dl_label, &url, &path, "finished", success);
                }
                // Tauri may grow more variants; ignore them.
                #[allow(unreachable_patterns)]
                _ => {}
            }
            true
        })
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
    #[cfg(windows)]
    frames::forget(&label);
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
/// `session` addresses one attached cross-origin iframe (see
/// `browser_view_frames`) instead of the tab's main document.
///
/// Windows only: WKWebView (macOS) has no CDP, so there is no equivalent there.
#[cfg(windows)]
#[tauri::command]
pub async fn browser_view_cdp(
    app: AppHandle,
    label: String,
    method: String,
    params: Option<String>,
    session: Option<String>,
) -> Result<String, String> {
    use std::sync::mpsc::sync_channel;
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_11;
    use windows::core::{Interface, HSTRING, PCWSTR};

    let webview = view(&app, &label)?;
    let params_json = params.unwrap_or_else(|| "{}".to_string());
    let session = session.filter(|s| !s.is_empty());
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
                    match &session {
                        Some(session) => {
                            let session_w = HSTRING::from(session.as_str());
                            core.cast::<ICoreWebView2_11>()?.CallDevToolsProtocolMethodForSession(
                                PCWSTR(session_w.as_ptr()),
                                PCWSTR(method_w.as_ptr()),
                                PCWSTR(params_w.as_ptr()),
                                &handler,
                            )
                        }
                        None => core.CallDevToolsProtocolMethod(
                            PCWSTR(method_w.as_ptr()),
                            PCWSTR(params_w.as_ptr()),
                            &handler,
                        ),
                    }
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

#[cfg(windows)]
#[path = "browser_view/frames.rs"]
mod frames;

/// List the cross-origin iframes of a tab that have their own DevTools
/// session, enabling that tracking on first call. The renderer pairs each
/// entry with its on-page box (`DOM.getFrameOwner` on the target id) and
/// evaluates inside it with `browser_view_cdp { session }`.
///
/// Attach events arrive asynchronously after enabling, so the first call on a
/// tab can return an empty list while frames exist; callers retry shortly.
#[cfg(windows)]
#[tauri::command]
pub async fn browser_view_frames(app: AppHandle, label: String) -> Result<frames::FrameReport, String> {
    use std::sync::mpsc::sync_channel;

    let webview = view(&app, &label)?;
    let (tx, rx) = sync_channel::<Result<(), String>>(1);
    let tab = label.clone();
    webview
        .with_webview(move |platform| {
            let attempt = (|| -> windows::core::Result<()> {
                let core = unsafe { platform.controller().CoreWebView2() }?;
                frames::enable(&tab, &core)
            })();
            let _ = tx.send(attempt.map_err(|e| format!("frame tracking failed: {e}")));
        })
        .map_err(|e| format!("with_webview failed: {e}"))?;
    rx.recv_timeout(std::time::Duration::from_secs(10))
        .map_err(|_| "frame tracking timed out".to_string())??;
    Ok(frames::report(&label))
}

/// Shape of `browser_view_frames` on platforms without DevTools sessions.
#[cfg(not(windows))]
#[derive(Serialize, Default)]
pub struct FrameReportUnsupported {
    pub frames: Vec<()>,
    pub contexts: Vec<()>,
}

/// WKWebView has no DevTools sessions; cross-origin frames stay opaque there.
#[cfg(not(windows))]
#[tauri::command]
pub async fn browser_view_frames(_app: AppHandle, _label: String) -> Result<FrameReportUnsupported, String> {
    Ok(FrameReportUnsupported::default())
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
    session: Option<String>,
) -> Result<String, String> {
    if session.as_deref().is_some_and(|s| !s.is_empty()) {
        return Err("cross-origin frame sessions are not available in the macOS embedded browser".into());
    }
    macos::dispatch(view(&app, &label)?, &method, params.as_deref()).await
}

#[cfg(not(any(windows, target_os = "macos")))]
#[tauri::command]
pub async fn browser_view_cdp(
    _app: AppHandle,
    _label: String,
    _method: String,
    _params: Option<String>,
    _session: Option<String>,
) -> Result<String, String> {
    Err("embedded browser control is not supported on this platform".into())
}
