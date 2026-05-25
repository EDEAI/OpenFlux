//! CodexDriver — OpenAI Codex CLI 驱动实现
//!
//! 安装：npm install -g @openai/codex
//! 命令：codex --full-auto "prompt"

use std::path::PathBuf;
use crate::commands::process_plugin::driver::CodingAgentDriver;

#[derive(Default)]
pub struct CodexDriver;

impl CodingAgentDriver for CodexDriver {
    fn id(&self) -> &str { "codex" }
    fn display_name(&self) -> &str { "OpenAI Codex CLI" }

    fn find_binary(&self) -> Option<PathBuf> {
        if let Ok(p) = which::which("codex") {
            return Some(p);
        }
        #[cfg(target_os = "windows")]
        {
            if let Ok(appdata) = std::env::var("APPDATA") {
                let p = PathBuf::from(appdata).join("npm").join("codex.cmd");
                if p.exists() { return Some(p); }
            }
        }
        None
    }

    fn is_authenticated(&self) -> bool {
        // Codex 使用 OPENAI_API_KEY 环境变量或 ~/.openai 配置
        if std::env::var("OPENAI_API_KEY").is_ok() {
            return true;
        }
        #[cfg(not(target_os = "windows"))]
        {
            if let Ok(home) = std::env::var("HOME") {
                let p = PathBuf::from(home).join(".openai");
                if p.exists() { return true; }
            }
        }
        false
    }

    fn build_run_args(&self, prompt: &str, _cwd: &str, _session_id: Option<&str>) -> Vec<String> {
        vec![
            "--full-auto".into(),  // 无人值守，自动批准所有操作
            "--quiet".into(),      // 减少非必要输出
            prompt.into(),
        ]
    }

    /// Codex 暂不支持 session 恢复
    fn supports_session_resume(&self) -> bool { false }

    fn default_timeout_secs(&self) -> u64 { 300 } // 默认 5 分钟超时
}
