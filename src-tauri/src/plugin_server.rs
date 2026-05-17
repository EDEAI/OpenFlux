//! OpenFlux Plugin Static File Server
//!
//! 独立的 Rust HTTPS/HTTP 服务器，托管所有 Plugin UI 文件。
//! 随 OpenFlux 进程启动，无需额外依赖或进程管理。
//!
//! HTTPS 模式（优先，manifest.xml 要求）：
//!   端口 : 3000（localhost）
//!   证书 : ~/.office-addin-dev-certs/localhost.{crt,key}
//!   URL  : https://localhost:3000/{plugin_name}/taskpane.html
//!
//! HTTP 备用模式（证书不存在时）：
//!   端口 : 18802（127.0.0.1）
//!   URL  : http://127.0.0.1:18802/{plugin_name}/taskpane.html

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::Router;
use hyper::body::Incoming;
use hyper::Request;
use hyper_util::rt::TokioIo;
use tokio_rustls::rustls::{self, ServerConfig};
use tokio_rustls::TlsAcceptor;
use tower::Service;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::ServeDir;

/// 构建共用的 axum App（CORS + 静态文件）
fn build_app(plugins_dir: &PathBuf) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);
    Router::new()
        .nest_service("/", ServeDir::new(plugins_dir))
        .layer(cors)
}

/// 获取 office-addin-dev-certs 路径（cert, key）
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

/// 主入口：自动判断 HTTPS / HTTP
pub async fn start(plugins_dir: PathBuf, http_port: u16) {
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

/// HTTPS 服务器：localhost:3000，使用 office-addin-dev-certs
async fn start_https(plugins_dir: PathBuf, cert_path: PathBuf, key_path: PathBuf) {
    // ── 加载证书链 ───────────────────────────────────────────────────────────
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

    // ── 加载私钥 ─────────────────────────────────────────────────────────────
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

    // ── 构建 TLS 配置 ────────────────────────────────────────────────────────
    let tls_config = match ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(cert_chain, private_key)
    {
        Ok(c) => Arc::new(c),
        Err(e) => { eprintln!("[PluginServer] TLS config error: {}", e); return; }
    };
    let acceptor = TlsAcceptor::from(tls_config);

    // ── 绑定端口 ─────────────────────────────────────────────────────────────
    let addr = SocketAddr::from(([127, 0, 0, 1], 3000));
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            eprintln!("[PluginServer] Port 3000 in use (webpack dev-server running? plugin connects OK)");
            return;
        }
        Err(e) => { eprintln!("[PluginServer] Cannot bind :3000: {}", e); return; }
    };

    eprintln!(
        "[PluginServer] HTTPS ready: https://localhost:3000/  (serving: {:?})",
        plugins_dir
    );

    // ── Accept 循环 ──────────────────────────────────────────────────────────
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
                Err(_) => return, // TLS 握手失败（浏览器探测等），静默忽略
            };
            let io = TokioIo::new(tls_stream);
            let service = hyper::service::service_fn(move |req: Request<Incoming>| {
                let mut app = app.clone();
                async move { app.call(req).await }
            });
            if let Err(e) = hyper::server::conn::http1::Builder::new()
                .serve_connection(io, service)
                .await
            {
                // 忽略连接被重置等常见非致命错误
                let msg = e.to_string();
                if !msg.contains("connection reset") && !msg.contains("broken pipe") {
                    eprintln!("[PluginServer] Connection error: {}", msg);
                }
            }
        });
    }
}

/// HTTP 备用服务器：127.0.0.1:port
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
