//! Cross-origin iframe access for embedded browser tabs (Windows).
//!
//! Script in a page cannot read a cross-origin iframe. DevTools can, in two
//! ways depending on where Chromium put the frame:
//!
//! * **Own process** (a cross-site frame with site isolation): the frame is a
//!   separate target. `Target.setAutoAttach` in flatten mode gives it its own
//!   CDP session; WebView2 reaches it through
//!   `CallDevToolsProtocolMethodForSession`.
//! * **Same process** (cross-origin but same site, or isolation off): the
//!   frame has no target, but its main-world execution context is reported by
//!   `Runtime.executionContextCreated` once `Runtime` is enabled;
//!   `Runtime.evaluate { contextId }` then runs inside it.
//!
//! This module subscribes to both kinds of event through WebView2's DevTools
//! event receivers and keeps the live sessions and contexts per tab so the
//! renderer (and through it the agent) can address any frame. Nothing here
//! opens a debugging port: everything stays inside this app's WebView2.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2DevToolsProtocolEventReceivedEventArgs,
    ICoreWebView2DevToolsProtocolEventReceivedEventArgs2, ICoreWebView2_11,
};
use webview2_com::{CallDevToolsProtocolMethodCompletedHandler, DevToolsProtocolEventReceivedEventHandler};
use windows::core::{Interface, HSTRING, PCWSTR, PWSTR};

/// An iframe that runs in its own process and has its own CDP session.
#[derive(Clone, Debug, Serialize)]
pub struct FrameTarget {
    /// CDP session id to pass to `CallDevToolsProtocolMethodForSession`.
    pub session: String,
    /// Target id; for iframes this is also the frame id the parent knows
    /// (`DOM.getFrameOwner`), which is how the renderer finds its box.
    pub target_id: String,
    pub url: String,
    pub title: String,
}

/// A main-world execution context of a frame in the tab's own process.
#[derive(Clone, Debug, Serialize)]
pub struct FrameContext {
    /// `contextId` for `Runtime.evaluate` on the tab's main session.
    pub context_id: i64,
    pub frame_id: String,
    pub origin: String,
}

/// Everything the renderer needs to address the frames of a tab.
#[derive(Clone, Debug, Default, Serialize)]
pub struct FrameReport {
    pub frames: Vec<FrameTarget>,
    pub contexts: Vec<FrameContext>,
}

#[derive(Default)]
struct Registry {
    /// Tabs whose auto-attach, Runtime domain and event receivers are installed.
    enabled: HashSet<String>,
    /// Live iframe sessions per tab label.
    targets: HashMap<String, Vec<FrameTarget>>,
    /// Live main-world contexts (all frames of the tab's process) per label.
    contexts: HashMap<String, Vec<FrameContext>>,
}

fn registry() -> &'static Mutex<Registry> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(Registry::default()))
}

const AUTO_ATTACH: &str = r#"{"autoAttach":true,"waitForDebuggerOnStart":false,"flatten":true}"#;
const EVENTS: [&str; 6] = [
    "Target.attachedToTarget",
    "Target.detachedFromTarget",
    "Target.targetInfoChanged",
    "Runtime.executionContextCreated",
    "Runtime.executionContextDestroyed",
    "Runtime.executionContextsCleared",
];

/// Fire-and-forget CDP call on the main session or on one frame session.
fn call(core: &ICoreWebView2, session: Option<&str>, method: &str, params: &str) -> windows::core::Result<()> {
    let method_w = HSTRING::from(method);
    let params_w = HSTRING::from(params);
    let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|_result, _json| Ok(())));
    unsafe {
        match session {
            Some(session) => {
                let session_w = HSTRING::from(session);
                core.cast::<ICoreWebView2_11>()?.CallDevToolsProtocolMethodForSession(
                    PCWSTR(session_w.as_ptr()),
                    PCWSTR(method_w.as_ptr()),
                    PCWSTR(params_w.as_ptr()),
                    &handler,
                )
            }
            None => core.CallDevToolsProtocolMethod(PCWSTR(method_w.as_ptr()), PCWSTR(params_w.as_ptr()), &handler),
        }
    }
}

fn take_string(getter: impl FnOnce(*mut PWSTR) -> windows::core::Result<()>) -> String {
    let mut raw = PWSTR::null();
    if getter(&mut raw).is_err() || raw.is_null() {
        return String::new();
    }
    webview2_com::take_pwstr(raw)
}

fn text(value: &serde_json::Value, key: &str) -> String {
    value[key].as_str().unwrap_or("").to_string()
}

/// Update the registry from one DevTools event. Runs on the UI thread.
fn on_event(label: &str, core: &ICoreWebView2, event: &str, args: &ICoreWebView2DevToolsProtocolEventReceivedEventArgs) {
    let json = take_string(|out| unsafe { args.ParameterObjectAsJson(out) });
    let value: serde_json::Value = match serde_json::from_str(&json) {
        Ok(value) => value,
        Err(_) => return,
    };
    // Events raised inside a child session (an own-process frame) carry that
    // session id; its execution contexts are addressed through the session,
    // not through the main session's context ids.
    let from_child_session = args
        .cast::<ICoreWebView2DevToolsProtocolEventReceivedEventArgs2>()
        .map(|args2| !take_string(|out| unsafe { args2.SessionId(out) }).is_empty())
        .unwrap_or(false);

    // Session of a frame that just attached and needs its own auto-attach so
    // frames nested inside it are reported too. Called after the lock drops.
    let mut attach_nested: Option<String> = None;
    {
        let mut registry = registry().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        match event {
            "Target.attachedToTarget" => {
                let session = text(&value, "sessionId");
                let info = &value["targetInfo"];
                if session.is_empty() || info["type"].as_str() != Some("iframe") {
                    return;
                }
                let list = registry.targets.entry(label.to_string()).or_default();
                list.retain(|t| t.session != session);
                list.push(FrameTarget {
                    session: session.clone(),
                    target_id: text(info, "targetId"),
                    url: text(info, "url"),
                    title: text(info, "title"),
                });
                attach_nested = Some(session);
            }
            "Target.detachedFromTarget" => {
                let session = text(&value, "sessionId");
                registry.targets.entry(label.to_string()).or_default().retain(|t| t.session != session);
            }
            "Target.targetInfoChanged" => {
                let info = &value["targetInfo"];
                let id = text(info, "targetId");
                for target in registry.targets.entry(label.to_string()).or_default().iter_mut().filter(|t| t.target_id == id) {
                    target.url = text(info, "url");
                    target.title = text(info, "title");
                }
            }
            "Runtime.executionContextCreated" if !from_child_session => {
                let context = &value["context"];
                let aux = &context["auxData"];
                // Only the frame's own (main) world; isolated worlds are not pages.
                if aux["isDefault"].as_bool() != Some(true) {
                    return;
                }
                let Some(id) = context["id"].as_i64() else { return };
                let list = registry.contexts.entry(label.to_string()).or_default();
                list.retain(|c| c.context_id != id);
                list.push(FrameContext { context_id: id, frame_id: text(aux, "frameId"), origin: text(context, "origin") });
            }
            "Runtime.executionContextDestroyed" if !from_child_session => {
                if let Some(id) = value["executionContextId"].as_i64() {
                    registry.contexts.entry(label.to_string()).or_default().retain(|c| c.context_id != id);
                }
            }
            "Runtime.executionContextsCleared" if !from_child_session => {
                registry.contexts.remove(label);
            }
            _ => {}
        }
    }
    if let Some(session) = attach_nested {
        let _ = call(core, Some(&session), "Target.setAutoAttach", AUTO_ATTACH);
    }
}

/// Start tracking frame sessions and contexts for a tab (idempotent). Must
/// run on the UI thread with the tab's `ICoreWebView2`.
pub fn enable(label: &str, core: &ICoreWebView2) -> windows::core::Result<()> {
    {
        let mut registry = registry().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if !registry.enabled.insert(label.to_string()) {
            return Ok(());
        }
    }
    for event in EVENTS {
        let event_w = HSTRING::from(event);
        let receiver = unsafe { core.GetDevToolsProtocolEventReceiver(PCWSTR(event_w.as_ptr())) }?;
        let label = label.to_string();
        let handler = DevToolsProtocolEventReceivedEventHandler::create(Box::new(
            move |sender: Option<ICoreWebView2>, args: Option<ICoreWebView2DevToolsProtocolEventReceivedEventArgs>| {
                if let (Some(core), Some(args)) = (sender, args) {
                    on_event(&label, &core, event, &args);
                }
                Ok(())
            },
        ));
        let mut token = 0i64;
        unsafe { receiver.add_DevToolsProtocolEventReceived(&handler, &mut token) }?;
        // The subscription lives as long as the webview; keep the receiver
        // (a COM object owned by WebView2) from being released here.
        std::mem::forget(receiver);
    }
    // Runtime.enable replays executionContextCreated for the contexts that
    // already exist, so frames loaded before this point are reported too.
    call(core, None, "Runtime.enable", "{}")?;
    call(core, None, "Target.setAutoAttach", AUTO_ATTACH)
}

/// Currently known frame sessions and main-world contexts of a tab.
pub fn report(label: &str) -> FrameReport {
    let registry = registry().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    FrameReport {
        frames: registry.targets.get(label).cloned().unwrap_or_default(),
        contexts: registry.contexts.get(label).cloned().unwrap_or_default(),
    }
}

/// Drop everything known about a closed tab.
pub fn forget(label: &str) {
    let mut registry = registry().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    registry.enabled.remove(label);
    registry.targets.remove(label);
    registry.contexts.remove(label);
}
