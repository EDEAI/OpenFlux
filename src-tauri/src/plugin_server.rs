//! OpenFlux Plugin Static File Server
//!
//! A standalone Rust HTTPS/HTTP server that hosts all Plugin UI files.
//! Starts together with the OpenFlux process; no extra dependency or process management.
//!
//! HTTPS mode (preferred, required by manifest.xml):
//!   Port : 18803 (localhost)
//!   Cert : ~/.office-addin-dev-certs/localhost.{crt,key}
//!   URL  : https://localhost:18803/{plugin_name}/taskpane.html
//!
//! HTTP fallback mode (when the cert is missing):
//!   Port : 18802 (127.0.0.1)
//!   URL  : http://127.0.0.1:18802/{plugin_name}/taskpane.html

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::Router;
use axum::extract::WebSocketUpgrade;
use axum::extract::ws::Message as AxumWsMsg;
use axum::response::IntoResponse;
use hyper::body::Incoming;
use hyper::Request;
use hyper_util::rt::TokioIo;
use tokio_rustls::rustls::{self, ServerConfig};
use tokio_rustls::TlsAcceptor;
use tower::Service;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::ServeDir;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message as TungMsg;

/// Gateway WebSocket address (plain ws, local-only)
const GATEWAY_WS: &str = "ws://127.0.0.1:18801";


/// 强制 no-cache：Office(WebView2)默认会激进缓存 taskpane.html/.js，
/// 导致插件更新后旧 JS 仍被加载。对所有响应加 no-store 头，让客户端每次都重新拉取。
async fn no_cache_mw(req: Request<axum::body::Body>, next: axum::middleware::Next) -> axum::response::Response {
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    h.insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store, no-cache, must-revalidate, max-age=0"),
    );
    h.insert(axum::http::header::PRAGMA, axum::http::HeaderValue::from_static("no-cache"));
    h.insert(axum::http::header::EXPIRES, axum::http::HeaderValue::from_static("0"));
    res
}

/// Build the shared axum app (CORS + static files + /ws proxy)
fn build_app(plugins_dir: &PathBuf) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);
    Router::new()
        .route("/ws", axum::routing::get(ws_proxy_handler))
        .nest_service("/", ServeDir::new(plugins_dir))
        .layer(axum::middleware::from_fn(no_cache_mw))
        .layer(cors)
}

/// WebSocket proxy handler: upgrade the incoming WSS connection and
/// bidirectionally forward all frames to/from the Gateway (ws://127.0.0.1:18801).
async fn ws_proxy_handler(ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(|client_ws| async move {
        // Connect to the Gateway
        let gw = match tokio_tungstenite::connect_async(GATEWAY_WS).await {
            Ok((stream, _)) => stream,
            Err(e) => {
                eprintln!("[PluginServer] WS proxy: cannot connect to Gateway: {}", e);
                return;
            }
        };

        let (mut client_tx, mut client_rx) = client_ws.split();
        let (mut gw_tx, mut gw_rx) = gw.split();

        // client → gateway
        let c2g = tokio::spawn(async move {
            while let Some(Ok(msg)) = client_rx.next().await {
                let tung = match msg {
                    AxumWsMsg::Text(t) => TungMsg::Text(t),
                    AxumWsMsg::Binary(b) => TungMsg::Binary(b),
                    AxumWsMsg::Ping(p) => TungMsg::Ping(p),
                    AxumWsMsg::Pong(p) => TungMsg::Pong(p),
                    AxumWsMsg::Close(_) => { let _ = gw_tx.close().await; break; }
                };
                if gw_tx.send(tung).await.is_err() { break; }
            }
        });

        // gateway → client
        let g2c = tokio::spawn(async move {
            while let Some(Ok(msg)) = gw_rx.next().await {
                let axum_msg = match msg {
                    TungMsg::Text(t) => AxumWsMsg::Text(t),
                    TungMsg::Binary(b) => AxumWsMsg::Binary(b),
                    TungMsg::Ping(p) => AxumWsMsg::Ping(p),
                    TungMsg::Pong(p) => AxumWsMsg::Pong(p),
                    TungMsg::Close(_) => { let _ = client_tx.close().await; break; }
                    _ => continue,
                };
                if client_tx.send(axum_msg).await.is_err() { break; }
            }
        });

        // Wait for either direction to finish, then abort the other
        tokio::select! {
            _ = c2g => {},
            _ = g2c => {},
        }
    })
}


/// Get the office-addin-dev-certs paths (cert, key)
fn find_dev_certs() -> Option<(PathBuf, PathBuf)> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .ok()?;
    let cert_dir = home.join(".office-addin-dev-certs");
    let cert = cert_dir.join("localhost.crt");
    let key = cert_dir.join("localhost.key");
    if cert.exists() && key.exists() { Some((cert, key)) } else { None }
}

/// Main entry point: auto-select HTTPS / HTTP
pub async fn start(plugins_dir: PathBuf, http_port: u16) {
    // rustls 0.23 要求在构建 ServerConfig 之前安装进程级 CryptoProvider，
    // 否则 ServerConfig::builder() 会 panic。这里显式安装 ring 后端（幂等，重复调用安全）。
    let _ = rustls::crypto::ring::default_provider().install_default();

    if let Err(e) = tokio::fs::create_dir_all(&plugins_dir).await {
        eprintln!("[PluginServer] Failed to create plugins dir: {}", e);
        return;
    }

    match find_dev_certs() {
        Some((cert_path, key_path)) => {
            start_https(plugins_dir, cert_path, key_path).await;
        }
        None => {
            eprintln!(
                "[PluginServer] office-addin-dev-certs not found → HTTP fallback (port {})",
                http_port
            );
            eprintln!(
                "[PluginServer] To enable HTTPS run: \
                 cd openflux-plugin/excel && npx office-addin-dev-certs install"
            );
            start_http(plugins_dir, http_port).await;
        }
    }
}

/// HTTPS server: localhost:18803, using office-addin-dev-certs
async fn start_https(plugins_dir: PathBuf, cert_path: PathBuf, key_path: PathBuf) {
    // ── Load the certificate chain ───────────────────────────────────────────
    let cert_chain: Vec<rustls::pki_types::CertificateDer<'static>> = {
        let f = match std::fs::File::open(&cert_path) {
            Ok(f) => f,
            Err(e) => { eprintln!("[PluginServer] Cannot open cert {:?}: {}", cert_path, e); return; }
        };
        rustls_pemfile::certs(&mut std::io::BufReader::new(f))
            .filter_map(|r| r.ok())
            .collect()
    };
    if cert_chain.is_empty() {
        eprintln!("[PluginServer] No certificates found in {:?}", cert_path);
        return;
    }

    // ── Load the private key ──────────────────────────────────────────────────
    let private_key = {
        let f = match std::fs::File::open(&key_path) {
            Ok(f) => f,
            Err(e) => { eprintln!("[PluginServer] Cannot open key {:?}: {}", key_path, e); return; }
        };
        match rustls_pemfile::private_key(&mut std::io::BufReader::new(f)) {
            Ok(Some(k)) => k,
            Ok(None) => { eprintln!("[PluginServer] No private key in {:?}", key_path); return; }
            Err(e) => { eprintln!("[PluginServer] Key parse error: {}", e); return; }
        }
    };

    // ── Build the TLS config ──────────────────────────────────────────────────
    let tls_config = match ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(cert_chain, private_key)
    {
        Ok(c) => Arc::new(c),
        Err(e) => { eprintln!("[PluginServer] TLS config error: {}", e); return; }
    };
    let acceptor = TlsAcceptor::from(tls_config);

    // ── Bind the port (with retry, to handle a previous process's TIME_WAIT on dev hot-reload) ──
    let addr = SocketAddr::from(([127, 0, 0, 1], 18803));
    let listener = {
        let mut attempts = 0u8;
        loop {
            match tokio::net::TcpListener::bind(addr).await {
                Ok(l) => break l,
                Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
                    attempts += 1;
                    if attempts >= 15 {
                        eprintln!("[PluginServer] Port 18803 still in use after 15s — giving up");
                        return;
                    }
                    eprintln!("[PluginServer] Port 18803 in use, retrying in 1s (attempt {}/15)...", attempts);
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                }
                Err(e) => {
                    eprintln!("[PluginServer] Cannot bind :18803: {}", e);
                    return;
                }
            }
        }
    };

    eprintln!(
        "[PluginServer] HTTPS ready: https://localhost:18803/  (serving: {:?})",
        plugins_dir
    );

    // ── Accept loop ───────────────────────────────────────────────────────────
    let app = build_app(&plugins_dir);
    loop {
        let (stream, _peer) = match listener.accept().await {
            Ok(s) => s,
            Err(e) => { eprintln!("[PluginServer] Accept error: {}", e); continue; }
        };
        let acceptor = acceptor.clone();
        let app = app.clone();
        tokio::spawn(async move {
            let tls_stream = match acceptor.accept(stream).await {
                Ok(s) => s,
                Err(_) => return, // TLS handshake failed (browser probing, etc.); ignore silently
            };
            let io = TokioIo::new(tls_stream);
            let service = hyper::service::service_fn(move |req: Request<Incoming>| {
                let mut app = app.clone();
                async move { app.call(req).await }
            });
            if let Err(e) = hyper::server::conn::http1::Builder::new()
                .serve_connection(io, service)
                .with_upgrades()
                .await
            {
                // Ignore common non-fatal errors like connection reset
                let msg = e.to_string();
                if !msg.contains("connection reset") && !msg.contains("broken pipe") {
                    eprintln!("[PluginServer] Connection error: {}", msg);
                }
            }
        });
    }
}

/// HTTP fallback server: 127.0.0.1:port
async fn start_http(plugins_dir: PathBuf, port: u16) {
    let app = build_app(&plugins_dir);
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    eprintln!(
        "[PluginServer] Starting HTTP on http://127.0.0.1:{}/  (serving: {:?})",
        port, plugins_dir
    );
    match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => {
            if let Err(e) = axum::serve(listener, app).await {
                eprintln!("[PluginServer] HTTP server error: {}", e);
            }
        }
        Err(e) => { eprintln!("[PluginServer] Failed to bind port {}: {}", port, e); }
    }
}
