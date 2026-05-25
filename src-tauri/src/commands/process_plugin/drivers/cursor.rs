//! CursorDriver — Cursor Editor CLI 驱动实现
//!
//! Cursor 提供有限的 CLI 支持，主要用于在指定目录打开项目并传递初始指令。
//! 实际编码由 Cursor 内部 AI 完成，结果通过文件变更体现。

use std::path::PathBuf;
use crate::commands::process_plugin::driver::CodingAgentDriver;

#[derive(Default)]
pub struct CursorDriver;

impl CodingAgentDriver for CursorDriver {
    fn id(&self) -> &str { "cursor" }
    fn display_name(&self) -> &str { "Cursor" }

    fn find_binary(&self) -> Option<PathBuf> {
        if let Ok(p) = which::which("cursor") {
            return Some(p);
        }
        // Windows 默认安装路径
        #[cfg(target_os = "windows")]
        {
            if let Ok(local) = std::env::var("LOCALAPPDATA") {
                let p = PathBuf::from(local).join("Programs").join("cursor").join("Cursor.exe");
                if p.exists() { return Some(p); }
            }
        }
        // macOS
        #[cfg(target_os = "macos")]
        {
            let p = PathBuf::from("/Applications/Cursor.app/Contents/MacOS/Cursor");
            if p.exists() { return Some(p); }
        }
        None
    }

    fn is_authenticated(&self) -> bool {
        // Cursor 通过 GUI 登录，检查配置目录是否存在
        self.find_cursor_config_dir()
            .map(|d| d.exists())
            .unwrap_or(false)
    }

    fn build_run_args(&self, _prompt: &str, cwd: &str, _session_id: Option<&str>) -> Vec<String> {
        // Cursor CLI 主要功能：在指定目录打开
        // 注：Cursor 的无头编码模式仍在发展中，当前仅支持打开目录
        vec![cwd.into()]
    }

    fn supports_session_resume(&self) -> bool { false }

    fn default_timeout_secs(&self) -> u64 { 60 }
}

impl CursorDriver {
    fn find_cursor_config_dir(&self) -> Option<PathBuf> {
        #[cfg(target_os = "windows")]
        {
            if let Ok(appdata) = std::env::var("APPDATA") {
                return Some(PathBuf::from(appdata).join("Cursor"));
            }
        }
        #[cfg(target_os = "macos")]
        {
            if let Ok(home) = std::env::var("HOME") {
                return Some(PathBuf::from(home)
                    .join("Library/Application Support/Cursor"));
            }
        }
        #[cfg(target_os = "linux")]
        {
            if let Ok(home) = std::env::var("HOME") {
                return Some(PathBuf::from(home).join(".config/Cursor"));
            }
        }
        None
    }
}
