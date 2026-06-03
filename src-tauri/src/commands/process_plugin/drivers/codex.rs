//! CodexDriver — OpenAI Codex CLI driver implementation
//!
//! Install: npm install -g @openai/codex
//! Command: codex --full-auto "prompt"

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
        // Codex uses the OPENAI_API_KEY env var or the ~/.openai config
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
            "--full-auto".into(),  // unattended, auto-approve all operations
            "--quiet".into(),      // reduce non-essential output
            prompt.into(),
        ]
    }

    /// Codex does not support session resume for now
    fn supports_session_resume(&self) -> bool { false }

    fn default_timeout_secs(&self) -> u64 { 300 } // default 5-minute timeout
}
