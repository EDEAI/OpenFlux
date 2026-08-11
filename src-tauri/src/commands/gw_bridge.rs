use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{State, ipc::Channel};
use tokio::sync::mpsc;
use tokio::time::timeout;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::{connect_async, tungstenite::Message};

/// Rust-side WebSocket bridge state
/// Used when WebView2 cannot connect to ws://127.0.0.1:18801 directly
/// due to network isolation policies on some Windows machines.
pub struct GwBridgeState {
    sender: Option<mpsc::UnboundedSender<String>>,
    generation: u64,
}

impl GwBridgeState {
    pub fn new() -> Self {
        GwBridgeState { sender: None, generation: 0 }
    }
}

/// Connect Rust-side WebSocket to the Gateway and stream messages to frontend.
///
/// Strategy:
///   1. Drop any previous connection (idempotent).
///   2. Connect to ws://127.0.0.1:18801 from the Rust process (bypasses WebView2
///      AppContainer / loopback isolation on Windows).
///   3. Wait up to 10 s for the first message from the Gateway (the "welcome" frame).
///   4. Forward the welcome via Channel<String> BEFORE returning Ok(()).
///      This guarantees the frontend's channel.onmessage fires *before* the invoke()
///      Promise resolves, so the welcomeHandler can never miss the message.
///   5. Spawn a background task that forwards all subsequent Gateway → Frontend messages.
///
/// The command returns Err if the connection or welcome times out, so the JS caller
/// receives a proper rejection that it can retry.
#[tauri::command]
pub async fn gw_bridge_connect(
    state: State<'_, Arc<Mutex<GwBridgeState>>>,
    on_event: Channel<String>,
) -> Result<(), String> {
    // Drop any previous connection: this kills the old writer task → sends WS Close →
    // the old reader task exits on the next read.
    let generation = {
        let mut s = state.lock().unwrap();
        s.sender = None;
        s.generation = s.generation.wrapping_add(1);
        s.generation
    };

    let url = "ws://127.0.0.1:18801";
    eprintln!("[Bridge] Connecting to {}", url);

    // Connect with a 10-second timeout so we don't hang forever if the gateway
    // isn't listening yet.
    let ws_stream = timeout(Duration::from_secs(10), connect_async(url))
        .await
        .map_err(|_| {
            eprintln!("[Bridge] Connect timed out after 10s");
            "Bridge connect timed out".to_string()
        })?
        .map_err(|e| {
            eprintln!("[Bridge] Connect failed: {}", e);
            format!("Bridge connect failed: {e}")
        })?
        .0; // connect_async returns (WsStream, Response)

    eprintln!("[Bridge] Connected to gateway WebSocket");

    let (mut write, mut read) = ws_stream.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    {
        let mut s = state.lock().unwrap();
        if s.generation != generation {
            return Err("Bridge connect was superseded by a newer connection".to_string());
        }
        s.sender = Some(tx);
    }

    // Writer task: forwards messages from frontend → Gateway
    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if write.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
        let _ = write.send(Message::Close(None)).await;
    });

    // --- Wait for the first message (the "welcome" frame) with a 10-second deadline ---
    // We do this synchronously (still inside the command) so we can:
    //   a) Return Err if the gateway doesn't greet us in time → JS can retry.
    //   b) Forward the welcome via Channel BEFORE this async fn returns → the
    //      channel.onmessage callback in JS fires *before* invoke() resolves,
    //      so the welcomeHandler is guaranteed to see it.
    let first_msg = timeout(Duration::from_secs(10), read.next())
        .await
        .map_err(|_| {
            eprintln!("[Bridge] Timed out waiting for welcome message");
            "Bridge: no welcome in 10s".to_string()
        })?
        .ok_or_else(|| "Bridge: stream closed before welcome".to_string())?
        .map_err(|e| format!("Bridge: read error waiting for welcome: {e}"))?;

    match first_msg {
        Message::Text(text) => {
            eprintln!("[Bridge] → Frontend (welcome): {}...", text.chars().take(80).collect::<String>());
            on_event.send(text.to_string())
                .map_err(|e| format!("Bridge: channel send failed: {e}"))?;
        }
        other => {
            let msg = format!("Bridge: unexpected first message type: {:?}", other);
            eprintln!("[Bridge] {}", msg);
            return Err(msg);
        }
    }

    // --- Spawn background reader task for all subsequent Gateway → Frontend messages ---
    let state2 = state.inner().clone();
    let on_event2 = on_event.clone();
    tokio::spawn(async move {
        while let Some(result) = read.next().await {
            match result {
                Ok(Message::Text(text)) => {
                    let preview: String = text.chars().take(80).collect();
                    eprintln!("[Bridge] → Frontend: {}...", preview);
                    if on_event2.send(text.to_string()).is_err() {
                        eprintln!("[Bridge] Channel closed by frontend");
                        break;
                    }
                }
                Ok(Message::Close(_)) | Err(_) => {
                    eprintln!("[Bridge] Gateway closed connection");
                    break;
                }
                _ => {}
            }
        }
        // Clear sender so the next gw_bridge_connect can reconnect cleanly
        let is_current = {
            let mut s = state2.lock().unwrap();
            if s.generation == generation {
                s.sender = None;
                true
            } else {
                false
            }
        };
        // A retired bridge must not disconnect the replacement connection.
        if is_current {
            let _ = on_event2.send(r#"{"type":"bridge_disconnected"}"#.to_string());
        }
    });

    eprintln!("[Bridge] Bridge ready, welcome forwarded");
    Ok(())
}

/// Send a message from frontend → Gateway via the Rust bridge.
#[tauri::command]
pub fn gw_bridge_send(
    state: State<'_, Arc<Mutex<GwBridgeState>>>,
    message: String,
) -> Result<(), String> {
    let s = state.lock().unwrap();
    match &s.sender {
        Some(tx) => tx.send(message).map_err(|e| e.to_string()),
        None => Err("Bridge not connected".to_string()),
    }
}

/// Disconnect and reset the bridge.
#[tauri::command]
pub fn gw_bridge_disconnect(state: State<'_, Arc<Mutex<GwBridgeState>>>) {
    let mut s = state.lock().unwrap();
    s.sender = None;
    s.generation = s.generation.wrapping_add(1);
}
