//! Gateway command module.
//!
//! Sub-modules:
//! - `bundle`  — tar.gz extraction and runtime setup
//! - `process` — sidecar spawn / stop / watchdog

pub mod bundle;
pub mod process;

use crate::config::AppConfig;
use serde::Serialize;
use std::process::Child;
use tauri::AppHandle;

pub use process::{start_gateway_sidecar, stop_gateway_sidecar};

/// Gateway WebSocket connection configuration returned to the frontend.
#[derive(Serialize)]
pub struct GatewayConfig {
    pub url: String,
    pub token: Option<String>,
}

/// Gateway sidecar process state (managed by Tauri).
pub struct GatewaySidecar {
    pub child: Option<Child>,
    /// `true` when the user explicitly stopped the sidecar — watchdog must not restart.
    pub stopping: bool,
}

impl GatewaySidecar {
    pub fn new() -> Self {
        Self { child: None, stopping: false }
    }
}

// ── Tauri commands ─────────────────────────────────────────────────────────────

/// Return the Gateway WebSocket URL and auth token to the frontend.
#[tauri::command]
pub async fn get_gateway_config(
    config: tauri::State<'_, AppConfig>,
) -> Result<GatewayConfig, String> {
    // Use 127.0.0.1 explicitly to avoid localhost resolving to ::1 (IPv6) on Windows.
    let host = if config.host.is_empty() {
        "127.0.0.1".to_string()
    } else {
        config.host.clone()
    };
    Ok(GatewayConfig {
        url:   format!("ws://{}:{}", host, config.port),
        token: config.token.clone(),
    })
}

#[tauri::command]
pub async fn start_gateway(app: AppHandle) -> Result<(), String> {
    start_gateway_sidecar(&app)
}

#[tauri::command]
pub async fn stop_gateway(app: AppHandle) -> Result<(), String> {
    stop_gateway_sidecar(&app)
}

#[tauri::command]
pub async fn restart_gateway(app: AppHandle) -> Result<(), String> {
    stop_gateway_sidecar(&app)?;
    std::thread::sleep(std::time::Duration::from_millis(500));
    start_gateway_sidecar(&app)
}
