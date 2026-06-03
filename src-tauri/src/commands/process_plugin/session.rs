//! DriverSession — runtime state per NexusAI session × driver

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// Runtime state for one (nexusai_session_id, driver_id) pair
#[derive(Debug, Clone)]
pub struct DriverSession {
    pub driver_id: String,
    /// Conversation / session ID of the current tool (agy/claude/codex, etc.)
    pub conv_id: Option<String>,
    /// Working directory
    pub cwd: String,
    /// Session creation time
    pub started_at: Instant,
    /// Number of tasks executed
    pub iteration: u32,
}

impl DriverSession {
    pub fn new(driver_id: &str, cwd: &str) -> Self {
        Self {
            driver_id: driver_id.to_string(),
            conv_id: None,
            cwd: cwd.to_string(),
            started_at: Instant::now(),
            iteration: 0,
        }
    }
}

/// Session store, key = "{nexusai_session_id}:{driver_id}"
#[derive(Clone, Default)]
pub struct SessionStore(Arc<Mutex<HashMap<String, DriverSession>>>);

impl SessionStore {
    pub fn key(nexusai_session: &str, driver_id: &str) -> String {
        format!("{}:{}", nexusai_session, driver_id)
    }

    pub fn get_conv_id(&self, nexusai_session: &str, driver_id: &str) -> Option<String> {
        let key = Self::key(nexusai_session, driver_id);
        self.0.lock().unwrap().get(&key)?.conv_id.clone()
    }

    pub fn update_conv_id(&self, nexusai_session: &str, driver_id: &str, conv_id: Option<String>, cwd: &str) {
        let key = Self::key(nexusai_session, driver_id);
        let mut map = self.0.lock().unwrap();
        let entry = map.entry(key).or_insert_with(|| DriverSession::new(driver_id, cwd));
        entry.conv_id = conv_id;
        entry.iteration += 1;
    }

    pub fn reset(&self, nexusai_session: &str, driver_id: &str) {
        let key = Self::key(nexusai_session, driver_id);
        self.0.lock().unwrap().remove(&key);
    }

    /// Get a session status summary (returned to the UI / status tool)
    pub fn get_status(&self, nexusai_session: &str, driver_id: &str) -> Option<serde_json::Value> {
        let key = Self::key(nexusai_session, driver_id);
        let map = self.0.lock().unwrap();
        let s = map.get(&key)?;
        Some(serde_json::json!({
            "driver_id": s.driver_id,
            "conv_id": s.conv_id,
            "cwd": s.cwd,
            "iteration": s.iteration,
            "elapsed_secs": s.started_at.elapsed().as_secs(),
        }))
    }
}
