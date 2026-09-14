//! A deliberately small CDP-shaped adapter for the methods the panel uses.
//! WKWebView has no CDP endpoint. Evaluation uses its completion callback;
//! native input is delivered only to a view inside this WKWebView.

use objc2::rc::Retained;
use objc2::{msg_send, sel, MainThreadMarker};
use objc2_app_kit::{NSEvent, NSEventModifierFlags, NSEventType, NSView};
use objc2_foundation::{NSObjectProtocol, NSPoint, NSProcessInfo, NSRange, NSString};
use serde_json::Value;
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::mpsc;
use std::time::Duration;
use tauri::Webview;

// NSViews are main-thread-only. Keep the press target through a drag, even
// when the pointer moves over another WK subview; never share it with workers.
thread_local! {
    static PRESSED_VIEWS: RefCell<HashMap<String, Retained<NSView>>> = RefCell::new(HashMap::new());
}

pub(super) fn release_pressed(label: &str) {
    PRESSED_VIEWS.with(|views| views.borrow_mut().remove(label));
}

async fn receive<T: Send + 'static>(rx: mpsc::Receiver<T>) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(15)))
        .await
        .map_err(|e| format!("embedded browser callback failed: {e}"))?
        .map_err(|_| "embedded browser callback timed out".to_string())
}

fn string<'a>(params: &'a Value, key: &str) -> Result<&'a str, String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{key} must be a string"))
}

fn number(params: &Value, key: &str, default: Option<f64>) -> Result<f64, String> {
    let value = match params.get(key) {
        Some(v) => v.as_f64(),
        None => default,
    }
    .ok_or_else(|| format!("{key} must be a finite number"))?;
    if value.is_finite() {
        Ok(value)
    } else {
        Err(format!("{key} must be finite"))
    }
}

fn integer(params: &Value, key: &str, default: u64, max: u64) -> Result<u64, String> {
    let value = number(params, key, Some(default as f64))?;
    if value < 0.0 || value > max as f64 || value.fract() != 0.0 {
        return Err(format!("{key} must be an integer between 0 and {max}"));
    }
    Ok(value as u64)
}

pub(super) async fn dispatch(
    webview: Webview,
    method: &str,
    params: Option<&str>,
) -> Result<String, String> {
    let params: Value = serde_json::from_str(params.unwrap_or("{}"))
        .map_err(|e| format!("invalid browser parameters: {e}"))?;
    if !params.is_object() {
        return Err("browser parameters must be an object".into());
    }
    // Raw CDP-shaped callers get the same truthful fallback as panel actions.
    // AppKit's ordinary NSEvents cannot maintain virtual button state, and
    // CGEvent-backed wheel events are not associated with this WK window.
    let method = if method == "Input.dispatchMouseEvent" {
        match params.get("type").and_then(Value::as_str) {
            Some("mouseWheel") => "OpenFlux.scroll",
            Some("mouseMoved") => {
                if integer(&params, "buttons", 0, 7)? != 0 {
                    return Err("macOS native events cannot represent held virtual buttons; use OpenFlux.drag (DOM input)".into());
                }
                "OpenFlux.hover"
            }
            _ => method,
        }
    } else {
        method
    };
    match method {
        "Page.navigate" => {
            let url = super::parse_url(string(&params, "url")?)?;
            webview.navigate(url).map_err(|e| e.to_string())?;
            Ok("{}".into())
        }
        "Runtime.evaluate" => {
            let expression = string(&params, "expression")?;
            if params.get("awaitPromise").and_then(Value::as_bool) == Some(true) {
                return Err(
                    "awaitPromise is not supported by the macOS embedded browser bridge".into(),
                );
            }
            // WK's privileged script evaluation is allowed even when page CSP
            // prohibits eval/Function. Calling either *inside* the page is not.
            // Newlines also protect the closing wrapper from a trailing //.
            let script = format!(
                "({})(() => (\n{}\n))",
                include_str!("evaluate.js"),
                expression
            );
            let (tx, rx) = mpsc::channel();
            webview
                .eval_with_callback(script, move |result| {
                    let _ = tx.send(result);
                })
                .map_err(|e| format!("JavaScript dispatch failed: {e}"))?;
            let raw = receive(rx).await?;
            let result: String = serde_json::from_str(&raw).map_err(|_| {
                "JavaScript syntax/evaluation failed: WKWebView returned no serialized result; use an expression or an IIFE".to_string()
            })?;
            let _: Value = serde_json::from_str(&result)
                .map_err(|e| format!("invalid JavaScript result: {e}"))?;
            Ok(result)
        }
        "OpenFlux.drag" | "OpenFlux.scroll" | "OpenFlux.hover" => {
            let mut params = params;
            let helper = if method == "OpenFlux.drag" {
                for key in ["x", "y", "x2", "y2"] {
                    number(&params, key, None)?;
                }
                include_str!("drag.js")
            } else {
                for key in ["x", "y", "deltaX", "deltaY"] {
                    number(&params, key, Some(0.0))?;
                }
                params["operation"] = Value::String(
                    if method == "OpenFlux.scroll" {
                        "scroll"
                    } else {
                        "hover"
                    }
                    .into(),
                );
                include_str!("pointer.js")
            };
            let script = format!("({helper})({params})");
            let (tx, rx) = mpsc::channel();
            webview
                .eval_with_callback(script, move |result| {
                    let _ = tx.send(result);
                })
                .map_err(|e| format!("{method} dispatch failed: {e}"))?;
            let raw = receive(rx).await?;
            let result: String = serde_json::from_str(&raw)
                .map_err(|_| format!("WKWebView did not return a result for {method}"))?;
            let value: Value = serde_json::from_str(&result)
                .map_err(|e| format!("invalid {method} result: {e}"))?;
            if let Some(error) = value.get("error").and_then(Value::as_str) {
                return Err(format!("{method} failed: {error}"));
            }
            Ok(result)
        }
        "Input.dispatchMouseEvent" | "Input.insertText" | "Input.dispatchKeyEvent" => {
            let method = method.to_string();
            let label = webview.label().to_string();
            let (tx, rx) = mpsc::channel();
            webview
                .with_webview(move |platform| {
                    // Tauri guarantees this closure runs on the AppKit main thread.
                    let result =
                        unsafe { native_input(platform.inner().cast(), &label, &method, &params) }
                            .map_err(|error| {
                                format!("{method} failed for browser tab {label}: {error}")
                            });
                    let _ = tx.send(result);
                })
                .map_err(|e| format!("native browser dispatch failed: {e}"))?;
            receive(rx).await??;
            Ok("{}".into())
        }
        _ => Err(format!(
            "{method} is not implemented by the macOS embedded browser bridge"
        )),
    }
}

fn modifiers(params: &Value) -> Result<NSEventModifierFlags, String> {
    let bits = integer(params, "modifiers", 0, 15)?;
    let mut flags = NSEventModifierFlags::empty();
    if bits & 1 != 0 {
        flags |= NSEventModifierFlags::Option;
    }
    if bits & 2 != 0 {
        flags |= NSEventModifierFlags::Control;
    }
    if bits & 4 != 0 {
        flags |= NSEventModifierFlags::Command;
    }
    if bits & 8 != 0 {
        flags |= NSEventModifierFlags::Shift;
    }
    Ok(flags)
}

// The pointer remains borrowed only for the main-thread closure. NSView is a
// superclass of WKWebView, so this cast does not change object ownership.
unsafe fn native_input(
    ptr: *mut NSView,
    label: &str,
    method: &str,
    params: &Value,
) -> Result<(), String> {
    MainThreadMarker::new().ok_or("AppKit input must run on the main thread")?;
    // Remove before any validation/native call so an invalid release or a
    // detached/hidden target cannot retain the old WK content view forever.
    let released_target = if method == "Input.dispatchMouseEvent"
        && params.get("type").and_then(Value::as_str) == Some("mouseReleased")
    {
        PRESSED_VIEWS.with(|views| views.borrow_mut().remove(label))
    } else {
        None
    };
    let view = ptr.as_ref().ok_or("WKWebView is unavailable")?;
    if view.isHiddenOrHasHiddenAncestor() {
        release_pressed(label);
        return Err("browser tab is hidden".into());
    }
    let window = view
        .window()
        .ok_or("browser tab is not attached to a window")?;
    let flags = modifiers(params)?;
    if method == "Input.dispatchMouseEvent" {
        let kind = string(params, "type")?;
        let x = number(params, "x", None)?;
        let y = number(params, "y", None)?;
        let zoom: f64 = msg_send![view, pageZoom];
        let bounds = view.bounds();
        let local = NSPoint::new(
            bounds.origin.x + x * zoom,
            bounds.origin.y
                + if view.isFlipped() {
                    y * zoom
                } else {
                    bounds.size.height - y * zoom
                },
        );
        let point = view.convertPoint_toView(local, None);
        // hitTest receives a point in the receiver's superview coordinates.
        let parent = view.superview().ok_or("browser tab has no parent view")?;
        let hit_point = view.convertPoint_toView(local, Some(&parent));
        let target = if kind == "mouseReleased" {
            released_target.or_else(|| view.hitTest(hit_point))
        } else {
            view.hitTest(hit_point)
        }
        .ok_or("pointer is outside the browser tab")?;
        if std::env::var("OPENFLUX_BROWSER_DEBUG").as_deref() == Ok("1") {
            eprintln!(
                "[EmbeddedBrowser/macOS] tab={label} event={kind} view={} target={} css=({x},{y}) local=({},{}) window=({},{}) zoom={zoom} flipped={} key_window={} window_number={}",
                view.class().name().to_string_lossy(), target.class().name().to_string_lossy(),
                local.x, local.y, point.x, point.y, view.isFlipped(), window.isKeyWindow(), window.windowNumber()
            );
        }
        if !target.isDescendantOf(view) {
            return Err("pointer target is outside the browser tab".into());
        }
        let button = params
            .get("button")
            .and_then(Value::as_str)
            .unwrap_or("none");
        let buttons = integer(params, "buttons", 0, 7)?;
        let event_type = match (kind, button, buttons) {
            ("mousePressed", "left", _) => NSEventType::LeftMouseDown,
            ("mouseReleased", "left", _) => NSEventType::LeftMouseUp,
            ("mousePressed", "right", _) => NSEventType::RightMouseDown,
            ("mouseReleased", "right", _) => NSEventType::RightMouseUp,
            _ => {
                return Err(format!(
                    "unsupported macOS mouse event: {kind}, button={button}, buttons={buttons}"
                ))
            }
        };
        let count = integer(params, "clickCount", 0, 3)?;
        let event = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            event_type, point, flags, NSProcessInfo::processInfo().systemUptime(), window.windowNumber(), None, 0, count as isize, if kind == "mouseReleased" { 0.0 } else { 1.0 })
            .ok_or("could not create native mouse event")?;
        if kind == "mousePressed" {
            window.makeFirstResponder(Some(&target));
            PRESSED_VIEWS
                .with(|views| views.borrow_mut().insert(label.to_string(), target.clone()));
        }
        match event_type {
            NSEventType::LeftMouseDown => target.mouseDown(&event),
            NSEventType::LeftMouseUp => target.mouseUp(&event),
            NSEventType::RightMouseDown => target.rightMouseDown(&event),
            NSEventType::RightMouseUp => target.rightMouseUp(&event),
            _ => unreachable!("only validated native press/release event types reach dispatch"),
        }
        return Ok(());
    }

    let responder = window
        .firstResponder()
        .ok_or("browser has no focused input target")?;
    let focused_view = responder
        .downcast_ref::<NSView>()
        .ok_or("focused input is not a browser view")?;
    if !focused_view.isDescendantOf(view) {
        return Err("focus is outside the browser tab; click the target first".into());
    }
    if method == "Input.insertText" {
        let text = NSString::from_str(string(params, "text")?);
        if !responder.respondsToSelector(sel!(insertText:replacementRange:)) {
            return Err("focused browser view cannot insert text".into());
        }
        let _: () = msg_send![&responder, insertText: &*text, replacementRange: NSRange::new(isize::MAX as usize, 0)];
        return Ok(());
    }
    let key = string(params, "key")?;
    let (characters, code) = key_description(key)?;
    let event_type = match string(params, "type")? {
        "keyDown" | "rawKeyDown" => NSEventType::KeyDown,
        "keyUp" => NSEventType::KeyUp,
        other => return Err(format!("unsupported macOS keyboard event: {other}")),
    };
    let characters = NSString::from_str(&characters);
    let event = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
        event_type, NSPoint::new(0.0, 0.0), flags, NSProcessInfo::processInfo().systemUptime(), window.windowNumber(), None, &characters, &characters, false, code)
        .ok_or("could not create native keyboard event")?;
    if event_type == NSEventType::KeyUp {
        responder.keyUp(&event);
    } else if flags == NSEventModifierFlags::Command && key.eq_ignore_ascii_case("a") {
        // AppKit's key-equivalent path can depend on an application's menu.
        // Apply the standard editing command only to this verified WK view;
        // never route through NSApplication or the system clipboard.
        if !responder.respondsToSelector(sel!(selectAll:)) {
            return Err("focused browser view cannot select all".into());
        }
        let _: () = msg_send![&responder, selectAll: view];
    } else if flags.contains(NSEventModifierFlags::Command) {
        if !responder.performKeyEquivalent(&event) {
            return Err(format!("browser did not handle Command+{key}"));
        }
    } else {
        responder.keyDown(&event);
    }
    Ok(())
}

fn key_description(key: &str) -> Result<(String, u16), String> {
    let named = match key {
        "Enter" => Some(("\r", 36)),
        "Tab" => Some(("\t", 48)),
        "Backspace" => Some(("\u{7f}", 51)),
        "Escape" => Some(("\u{1b}", 53)),
        "ArrowLeft" => Some(("\u{f702}", 123)),
        "ArrowRight" => Some(("\u{f703}", 124)),
        "ArrowDown" => Some(("\u{f701}", 125)),
        "ArrowUp" => Some(("\u{f700}", 126)),
        "Delete" => Some(("\u{f728}", 117)),
        "Home" => Some(("\u{f729}", 115)),
        "End" => Some(("\u{f72b}", 119)),
        "PageUp" => Some(("\u{f72c}", 116)),
        "PageDown" => Some(("\u{f72d}", 121)),
        " " | "Space" => Some((" ", 49)),
        _ => None,
    };
    if let Some((text, code)) = named {
        return Ok((text.into(), code));
    }
    // Printable text is normally sent through insertText; these physical codes
    // are needed for common modifier shortcuts without touching the clipboard.
    let code = match key.to_ascii_lowercase().as_str() {
        "a" => 0,
        "s" => 1,
        "d" => 2,
        "f" => 3,
        "h" => 4,
        "g" => 5,
        "z" => 6,
        "x" => 7,
        "c" => 8,
        "v" => 9,
        "b" => 11,
        "q" => 12,
        "w" => 13,
        "e" => 14,
        "r" => 15,
        "y" => 16,
        "t" => 17,
        "1" => 18,
        "2" => 19,
        "3" => 20,
        "4" => 21,
        "6" => 22,
        "5" => 23,
        "=" => 24,
        "9" => 25,
        "7" => 26,
        "-" => 27,
        "8" => 28,
        "0" => 29,
        "]" => 30,
        "o" => 31,
        "u" => 32,
        "[" => 33,
        "i" => 34,
        "p" => 35,
        "l" => 37,
        "j" => 38,
        "'" => 39,
        "k" => 40,
        ";" => 41,
        "\\" => 42,
        "," => 43,
        "/" => 44,
        "n" => 45,
        "m" => 46,
        "." => 47,
        "`" => 50,
        _ => {
            return Err(format!(
                "unsupported key {key}; use Input.insertText for Unicode text"
            ))
        }
    };
    Ok((key.to_string(), code))
}
