//! ClaudeCodeDriver — Anthropic Claude Code CLI 驱动实现
//!
//! 安装：npm install -g @anthropic-ai/claude-code
//! 命令：claude -p "prompt" [--resume <session_id>]

use std::path::PathBuf;
use crate::commands::process_plugin::driver::CodingAgentDriver;

#[derive(Default)]
pub struct ClaudeCodeDriver;

impl CodingAgentDriver for ClaudeCodeDriver {
    fn id(&self) -> &str { "claude" }
    fn display_name(&self) -> &str { "Claude Code" }

    fn find_binary(&self) -> Option<PathBuf> {
        // PATH 中查找
        if let Ok(p) = which::which("claude") {
            return Some(p);
        }
        // Windows npm 全局安装路径
        #[cfg(target_os = "windows")]
        {
            if let Ok(appdata) = std::env::var("APPDATA") {
                let p = PathBuf::from(appdata).join("npm").join("claude.cmd");
                if p.exists() { return Some(p); }
            }
        }
        None
    }

    fn is_authenticated(&self) -> bool {
        // Claude Code 在 ~/.claude/ 或 %APPDATA%\.claude\ 存储认证
        self.find_claude_config_dir()
            .map(|d| d.exists())
            .unwrap_or(false)
    }

    fn build_run_args(&self, prompt: &str, _cwd: &str, session_id: Option<&str>) -> Vec<String> {
        let mut args: Vec<String> = vec![];

        if let Some(id) = session_id {
            args.push("--resume".into());
            args.push(id.into());
        }

        // 非交互打印模式
        args.push("--print".into());
        args.push(prompt.into());

        args
    }

    fn extract_session_id_from_stdout(&self, stdout: &str) -> Option<String> {
        // Claude Code 在输出末尾打印类似：
        // "Session ID: abc-def-123"
        for line in stdout.lines().rev() {
            let l = line.trim();
            if let Some(id) = l.strip_prefix("Session ID: ") {
                return Some(id.trim().to_string());
            }
            if let Some(id) = l.strip_prefix("session: ") {
                return Some(id.trim().to_string());
            }
        }
        None
    }

    fn supports_session_resume(&self) -> bool { true }

    fn default_timeout_secs(&self) -> u64 { 0 } // 不限时
}

impl ClaudeCodeDriver {
    fn find_claude_config_dir(&self) -> Option<PathBuf> {
        #[cfg(target_os = "windows")]
        {
            if let Ok(appdata) = std::env::var("APPDATA") {
                return Some(PathBuf::from(appdata).join(".claude"));
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            if let Ok(home) = std::env::var("HOME") {
                return Some(PathBuf::from(home).join(".claude"));
            }
        }
        None
    }
}
