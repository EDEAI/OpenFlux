//! ProcessPlugin — unified plugin framework for CLI AI coding agents
//!
//! Supports integrating CLI tools like agy / claude / codex / cursor as OpenFlux Process Plugins.
//! Tool calls reach Rust directly via Tauri IPC, bypassing WebSocket, with no timeout limit.

pub mod driver;
pub mod drivers;
pub mod session;

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use driver::{CodingAgentDriver, DriverResult, DriverStatus};
use drivers::{agy::AgyDriver, claude::ClaudeCodeDriver, codex::CodexDriver, cursor::CursorDriver};
use session::SessionStore;
use tauri::State;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

// ── Manager ───────────────────────────────────────────────────────────────────

pub struct ProcessPluginManager {
    drivers: HashMap<String, Box<dyn CodingAgentDriver>>,
    sessions: SessionStore,
}

impl ProcessPluginManager {
    pub fn new() -> Self {
        let mut mgr = Self {
            drivers: HashMap::new(),
            sessions: SessionStore::default(),
        };
        mgr.register(Box::new(AgyDriver::default()));
        mgr.register(Box::new(ClaudeCodeDriver::default()));
        mgr.register(Box::new(CodexDriver::default()));
        mgr.register(Box::new(CursorDriver::default()));
        mgr
    }

    fn register(&mut self, driver: Box<dyn CodingAgentDriver>) {
        self.drivers.insert(driver.id().to_string(), driver);
    }

    /// List the status of all drivers
    pub fn list_drivers(&self) -> Vec<DriverStatus> {
        let mut statuses: Vec<_> = self.drivers.values().map(|d| d.status()).collect();
        statuses.sort_by(|a, b| a.id.cmp(&b.id));
        statuses
    }

    /// Execute a tool (core path)
    pub async fn execute(
        &self,
        driver_id: &str,
        prompt: &str,
        nexusai_session: &str,
        cwd: &str,
        progress_cb: impl Fn(String) + Send + 'static,
    ) -> Result<DriverResult> {
        let driver = self.drivers.get(driver_id)
            .ok_or_else(|| anyhow!("Unknown driver: '{}'. Available: {}", driver_id,
                self.drivers.keys().cloned().collect::<Vec<_>>().join(", ")))?;

        let binary = driver.find_binary()
            .ok_or_else(|| anyhow!("{} is not installed or not found in PATH", driver.display_name()))?;

        // Get the existing conv_id (session resume)
        let conv_id = if driver.supports_session_resume() {
            self.sessions.get_conv_id(nexusai_session, driver_id)
        } else {
            None
        };

        let args = driver.build_run_args(prompt, cwd, conv_id.as_deref());

        eprintln!("[ProcessPlugin] {} exec: {:?} args={:?}", driver_id, binary, args);

        // Spawn the child process
        let mut child = Command::new(&binary)
            .args(&args)
            .current_dir(cwd)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| anyhow!("Failed to spawn {}: {}", driver.display_name(), e))?;

        // Stream stdout in real time
        let mut full_output = String::new();
        if let Some(stdout) = child.stdout.take() {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                full_output.push_str(&line);
                full_output.push('\n');
                progress_cb(line);
            }
        }

        // Timeout control
        let timeout = driver.default_timeout_secs();
        let status = if timeout > 0 {
            tokio::time::timeout(Duration::from_secs(timeout), child.wait())
                .await
                .map_err(|_| anyhow!("{} timed out after {}s", driver.display_name(), timeout))??
        } else {
            child.wait().await?
        };

        // Parse and store the new session ID
        let new_conv_id = driver.resolve_session_id(&full_output);
        self.sessions.update_conv_id(
            nexusai_session,
            driver_id,
            new_conv_id.clone(),
            cwd,
        );

        Ok(DriverResult {
            success: status.success(),
            output: full_output,
            exit_code: status.code(),
            session_id: new_conv_id,
        })
    }

    /// Reset the session for the given driver (the next run starts a new session)
    pub fn reset_session(&self, driver_id: &str, nexusai_session: &str) {
        self.sessions.reset(nexusai_session, driver_id);
    }

    /// Get the session status
    pub fn get_session_status(&self, driver_id: &str, nexusai_session: &str) -> serde_json::Value {
        self.sessions.get_status(nexusai_session, driver_id)
            .unwrap_or(serde_json::json!({ "driver_id": driver_id, "conv_id": null, "iteration": 0 }))
    }
}

// ── Tauri state wrapper ───────────────────────────────────────────────────────

pub struct ProcessPluginState(pub Arc<ProcessPluginManager>);

// ── Tauri Commands ────────────────────────────────────────────────────────────

/// List all registered CLI Agent drivers and their status
#[tauri::command]
pub async fn process_plugin_list_drivers(
    state: State<'_, ProcessPluginState>,
) -> Result<Vec<DriverStatus>, String> {
    Ok(state.0.list_drivers())
}

/// Execute a CLI Agent tool
///
/// tool: "run" | "reset" | "status"
#[tauri::command]
pub async fn process_plugin_call(
    driver_id: String,
    tool: String,
    args: serde_json::Value,
    state: State<'_, ProcessPluginState>,
) -> Result<serde_json::Value, String> {
    let mgr = Arc::clone(&state.0);

    match tool.as_str() {
        "run" => {
            let prompt = args["prompt"].as_str()
                .ok_or("Missing 'prompt' argument")?
                .to_string();
            let cwd = args["cwd"].as_str()
                .unwrap_or(".")
                .to_string();
            let nexusai_session = args["nexusai_session"].as_str()
                .unwrap_or("default")
                .to_string();

            // Collect progress lines (simple collection; could later become a Tauri event emit)
            let (tx, rx) = tokio::sync::mpsc::channel::<String>(256);
            let mgr2 = Arc::clone(&mgr);

            let result = mgr2.execute(
                &driver_id,
                &prompt,
                &nexusai_session,
                &cwd,
                move |line| { let _ = tx.try_send(line); },
            ).await.map_err(|e| e.to_string())?;

            // All progress lines are already collected in result.output
            drop(rx);

            Ok(serde_json::json!({
                "success": result.success,
                "output": result.output,
                "exit_code": result.exit_code,
                "session_id": result.session_id,
            }))
        }

        "reset" => {
            let nexusai_session = args["nexusai_session"].as_str().unwrap_or("default");
            mgr.reset_session(&driver_id, nexusai_session);
            Ok(serde_json::json!({ "success": true, "message": "Session reset" }))
        }

        "status" => {
            let nexusai_session = args["nexusai_session"].as_str().unwrap_or("default");
            let status = mgr.get_session_status(&driver_id, nexusai_session);
            Ok(status)
        }

        "driver_status" => {
            let drivers = mgr.list_drivers();
            let d = drivers.iter().find(|d| d.id == driver_id)
                .cloned()
                .ok_or_else(|| format!("Unknown driver: {}", driver_id))?;
            Ok(serde_json::to_value(d).unwrap())
        }

        _ => Err(format!("Unknown tool: '{}'. Available: run, reset, status, driver_status", tool))
    }
}
