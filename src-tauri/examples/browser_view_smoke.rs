//! Native, local-fixture smoke test. No Gateway, user profile or system input.
//! Serve gateway/test/fixtures/browser-control.html on localhost first, then:
//! OPENFLUX_BROWSER_FIXTURE=http://127.0.0.1:18989/browser-control.html \
//! cargo run --release --example browser_view_smoke
use openflux_rust_lib::commands::browser_view::*;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

const LABEL: &str = "bv-native-test";
async fn call(app: &AppHandle, method: &str, params: Value) -> Result<Value, String> {
    let raw = browser_view_cdp(
        app.clone(),
        LABEL.into(),
        method.into(),
        Some(params.to_string()),
    )
    .await?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}
async fn eval(app: &AppHandle, expr: &str) -> Result<Value, String> {
    let response = call(
        app,
        "Runtime.evaluate",
        json!({"expression":expr,"returnByValue":true}),
    )
    .await?;
    if response.get("exceptionDetails").is_some() {
        return Err(format!("Evaluation failed: {response}"));
    }
    Ok(response["result"]["value"].clone())
}
fn check(condition: bool, name: &str) -> Result<(), String> {
    if !condition {
        return Err(format!("FAIL {name}"));
    }
    println!("PASS {name}");
    Ok(())
}
async fn pause() {
    tokio::time::sleep(std::time::Duration::from_millis(180)).await;
}
async fn point(app: &AppHandle, id: &str) -> Result<(f64, f64), String> {
    let p = eval(app, &format!("(()=>{{const e=document.getElementById({});e.scrollIntoView({{block:'nearest'}});const r=e.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]}})()",json!(id))).await?;
    Ok((
        p[0].as_f64().ok_or("missing x")?,
        p[1].as_f64().ok_or("missing y")?,
    ))
}
async fn mouse(app: &AppHandle, kind: &str, x: f64, y: f64, extra: Value) -> Result<(), String> {
    let mut args = json!({"type":kind,"x":x,"y":y});
    for (k, v) in extra.as_object().unwrap() {
        args[k] = v.clone();
    }
    let method = if cfg!(target_os = "macos") && kind == "mouseWheel" {
        "OpenFlux.scroll"
    } else if cfg!(target_os = "macos") && kind == "mouseMoved" {
        "OpenFlux.hover"
    } else {
        "Input.dispatchMouseEvent"
    };
    call(app, method, args).await?;
    pause().await;
    Ok(())
}
async fn click(app: &AppHandle, id: &str, button: &str, count: i32) -> Result<(), String> {
    let (x, y) = point(app, id).await?;
    mouse(app, "mouseMoved", x, y, json!({})).await?;
    mouse(
        app,
        "mousePressed",
        x,
        y,
        json!({"button":button,"clickCount":count}),
    )
    .await?;
    mouse(
        app,
        "mouseReleased",
        x,
        y,
        json!({"button":button,"clickCount":count}),
    )
    .await
}
async fn key(app: &AppHandle, key: &str, modifiers: u32) -> Result<(), String> {
    for kind in ["keyDown", "keyUp"] {
        call(
            app,
            "Input.dispatchKeyEvent",
            json!({"type":kind,"key":key,"modifiers":modifiers}),
        )
        .await?;
    }
    pause().await;
    Ok(())
}
async fn run(app: AppHandle, url: String) -> Result<(), String> {
    browser_view_create(
        app.clone(),
        LABEL.into(),
        url.clone(),
        40.0,
        75.0,
        800.0,
        620.0,
    )
    .await?;
    app.get_window("main")
        .ok_or("missing test window")?
        .set_focus()
        .map_err(|e| e.to_string())?;
    let mut ready = false;
    let mut last = Ok(Value::Null);
    for _ in 0..50 {
        last = eval(&app, "!!window.results").await;
        if last == Ok(json!(true)) {
            ready = true;
            break;
        }
        pause().await;
    }
    if !ready {
        eprintln!("Fixture readiness: {last:?}");
    }
    check(ready, "WKWebView loaded local fixture")?;
    check(
        eval(&app, "({answer:42,text:'中文'})").await? == json!({"answer":42,"text":"中文"}),
        "evaluate structured result",
    )?;
    let exception = call(
        &app,
        "Runtime.evaluate",
        json!({"expression":"(()=>{throw new Error('fixture exception')})()","returnByValue":true}),
    )
    .await?;
    check(
        exception.get("exceptionDetails").is_some(),
        "evaluation exception reported",
    )?;
    click(&app, "button", "left", 1).await?;
    if std::env::var("OPENFLUX_BROWSER_DEBUG").is_ok() {
        eprintln!("Native click state: {}", eval(&app, "results").await?);
    }
    check(
        eval(&app, "results.clicks===1 && results.trusted.every(Boolean)").await? == json!(true),
        "trusted native click",
    )?;
    click(&app, "input", "left", 1).await?;
    call(&app, "Input.insertText", json!({"text":"Mac 中文 123"})).await?;
    check(
        eval(&app, "document.getElementById('input').value").await? == json!("Mac 中文 123"),
        "Unicode text input",
    )?;
    key(&app, "a", 4).await?;
    call(&app, "Input.insertText", json!({"text":"replaced"})).await?;
    check(
        eval(&app, "document.getElementById('input').value").await? == json!("replaced"),
        "Command+A and replace",
    )?;
    key(&app, "Enter", 0).await?;
    check(
        eval(&app, "results.submitted").await? == json!(1),
        "Enter submits focused form",
    )?;
    key(&app, "Tab", 0).await?;
    check(
        eval(&app, "document.activeElement.id").await? == json!("textarea"),
        "Tab moves page focus",
    )?;
    let (x, y) = point(&app, "scroll").await?;
    mouse(&app, "mouseWheel", x, y, json!({"deltaY":150,"deltaX":0})).await?;
    check(
        eval(&app, "document.getElementById('scroll').scrollTop>0").await? == json!(true),
        "scroll moves target inside the embedded page",
    )?;
    click(&app, "button", "right", 1).await?;
    check(
        eval(&app, "results.contexts").await? == json!(1),
        "right click",
    )?;
    click(&app, "button", "left", 1).await?;
    click(&app, "button", "left", 2).await?;
    check(
        eval(&app, "results.double>0").await? == json!(true),
        "double click",
    )?;
    let (x, y) = point(&app, "drag").await?;
    let moves = eval(&app, "results.moves").await?.as_i64().unwrap_or(0);
    mouse(&app, "mouseMoved", x - 80.0, y, json!({})).await?;
    check(
        eval(&app, "results.moves").await?.as_i64().unwrap_or(0) > moves,
        "hover event reaches the target",
    )?;
    if cfg!(target_os = "macos") {
        let mode = call(
            &app,
            "OpenFlux.drag",
            json!({"x":x-80.0,"y":y,"x2":x+70.0,"y2":y}),
        )
        .await?;
        check(
            mode["inputMode"] == json!("dom") && mode["isTrusted"] == json!(false),
            "DOM drag reports its input mode",
        )?;
    } else {
        mouse(
            &app,
            "mousePressed",
            x - 80.0,
            y,
            json!({"button":"left","clickCount":1}),
        )
        .await?;
        for i in 1..6 {
            mouse(
                &app,
                "mouseMoved",
                x - 80.0 + 30.0 * i as f64,
                y,
                json!({"buttons":1}),
            )
            .await?;
        }
        mouse(
            &app,
            "mouseReleased",
            x + 70.0,
            y,
            json!({"button":"left","clickCount":1}),
        )
        .await?;
    }
    check(
        eval(&app, "results.drags>0").await? == json!(true),
        "drag delivers held-button movement",
    )?;
    if cfg!(target_os = "macos") {
        let (x, y) = point(&app, "source").await?;
        let (x2, y2) = point(&app, "drop").await?;
        call(&app, "OpenFlux.drag", json!({"x":x,"y":y,"x2":x2,"y2":y2})).await?;
        check(
            eval(&app, "results.dropped").await? == json!("native-fixture-payload"),
            "HTML5 drop preserves DataTransfer",
        )?;
    }
    call(
        &app,
        "Page.navigate",
        json!({"url":format!("{url}?second=1")}),
    )
    .await?;
    let mut navigated = false;
    for _ in 0..50 {
        if eval(&app, "location.search==='?second=1' && !!window.results").await == Ok(json!(true))
        {
            navigated = true;
            break;
        }
        pause().await;
    }
    check(navigated, "navigate same WKWebView")?;
    check(
        call(&app, "Unsupported.method", json!({})).await.is_err(),
        "unsupported method reports failure",
    )?;
    browser_view_close(app.clone(), LABEL.into()).await?;
    check(
        call(&app, "Runtime.evaluate", json!({"expression":"1"}))
            .await
            .is_err(),
        "closed tab reports failure",
    )?;
    Ok(())
}
fn main() {
    let url = std::env::var("OPENFLUX_BROWSER_FIXTURE")
        .expect("Set OPENFLUX_BROWSER_FIXTURE to the local fixture URL");
    assert!(
        url.starts_with("http://127.0.0.1:"),
        "Only a loopback fixture is permitted"
    );
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = "com.openflux.browser-smoke".into();
    context.config_mut().app.windows.clear();
    tauri::Builder::default()
        .setup(move |app| {
            tauri::window::WindowBuilder::new(app, "main")
                .title("OpenFlux native browser test")
                .decorations(false)
                .inner_size(850.0, 750.0)
                .build()?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let result = run(handle.clone(), url).await;
                if let Err(error) = &result {
                    eprintln!("{error}");
                }
                println!(
                    "NATIVE_BROWSER_SMOKE {}",
                    if result.is_ok() { "PASSED" } else { "FAILED" }
                );
                handle.exit(if result.is_ok() { 0 } else { 1 });
            });
            Ok(())
        })
        .run(context)
        .expect("test app failed");
}
