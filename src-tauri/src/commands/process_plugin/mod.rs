//! ProcessPlugin — CLI AI Coding Agent 统一插件框架
//!
//! 支持 agy / claude / codex / cursor 等 CLI 工具作为 OpenFlux Process Plugin 接入。
//! 工具调用通过 Tauri IPC 直达 Rust，不走 WebSocket，无超时限制。

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

    /// 列出所有驱动状态
    pub fn list_drivers(&self) -> Vec<DriverStatus> {
        let mut statuses: Vec<_> = self.drivers.values().map(|d| d.status()).collect();
        statuses.sort_by(|a, b| a.id.cmp(&b.id));
        statuses
    }

    /// 执行工具（核心路径）
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

        // 获取已有的 conv_id（session 恢复）
        let conv_id = if driver.supports_session_resume() {
            self.sessions.get_conv_id(nexusai_session, driver_id)
        } else {
            None
        };

        let args = driver.build_run_args(prompt, cwd, conv_id.as_deref());

        eprintln!("[ProcessPlugin] {} exec: {:?} args={:?}", driver_id, binary, args);

        // 启动子进程
        let mut child = Command::new(&binary)
            .args(&args)
            .current_dir(cwd)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| anyhow!("Failed to spawn {}: {}", driver.display_name(), e))?;

        // 实时流式读取 stdout
        let mut full_output = String::new();
        if let Some(stdout) = child.stdout.take() {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                full_output.push_str(&line);
                full_output.push('\n');
                progress_cb(line);
            }
        }

        // 超时控制
        let timeout = driver.default_timeout_secs();
        let status = if timeout > 0 {
            tokio::time::timeout(Duration::from_secs(timeout), child.wait())
                .await
                .map_err(|_| anyhow!("{} timed out after {}s", driver.display_name(), timeout))??
        } else {
            child.wait().await?
        };

        // 解析并保存新的 session ID
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

    /// 重置指定驱动的 session（下次 run 会开启新 session）
    pub fn reset_session(&self, driver_id: &str, nexusai_session: &str) {
        self.sessions.reset(nexusai_session, driver_id);
    }

    /// 获取 session 状态
    pub fn get_session_status(&self, driver_id: &str, nexusai_session: &str) -> serde_json::Value {
        self.sessions.get_status(nexusai_session, driver_id)
            .unwrap_or(serde_json::json!({ "driver_id": driver_id, "conv_id": null, "iteration": 0 }))
    }
}

// ── Tauri 状态包装 ────────────────────────────────────────────────────────────

pub struct ProcessPluginState(pub Arc<ProcessPluginManager>);

// ── Tauri Commands ────────────────────────────────────────────────────────────

/// 列出所有已注册的 CLI Agent 驱动及其状态
#[tauri::command]
pub async fn process_plugin_list_drivers(
    state: State<'_, ProcessPluginState>,
) -> Result<Vec<DriverStatus>, String> {
    Ok(state.0.list_drivers())
}

/// 执行 CLI Agent 工具
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

            // 收集进度行（简单收集，后续可改为 Tauri event emit）
            let (tx, rx) = tokio::sync::mpsc::channel::<String>(256);
            let mgr2 = Arc::clone(&mgr);

            let result = mgr2.execute(
                &driver_id,
                &prompt,
                &nexusai_session,
                &cwd,
                move |line| { let _ = tx.try_send(line); },
            ).await.map_err(|e| e.to_string())?;

            // 收集所有进度行（已包含在 result.output 里）
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
