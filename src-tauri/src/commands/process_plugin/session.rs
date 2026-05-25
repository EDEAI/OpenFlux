//! DriverSession — 每个 NexusAI session × driver 的运行时状态

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// 一个 (nexusai_session_id, driver_id) 对应的运行时状态
#[derive(Debug, Clone)]
pub struct DriverSession {
    pub driver_id: String,
    /// 当前 agy/claude/codex 等工具的 conversation / session ID
    pub conv_id: Option<String>,
    /// 工作目录
    pub cwd: String,
    /// session 创建时间
    pub started_at: Instant,
    /// 已执行的任务次数
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

/// Session 存储，key = "{nexusai_session_id}:{driver_id}"
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

    /// 获取 session 状态摘要（供 UI / 工具状态工具返回）
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
