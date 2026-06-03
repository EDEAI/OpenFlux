//! CursorDriver — Cursor Editor CLI driver implementation
//!
//! Cursor offers limited CLI support, mainly used to open a project in a given
//! directory and pass an initial instruction. The actual coding is done by
//! Cursor's internal AI, with results reflected through file changes.

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
        // Windows default install path
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
        // Cursor logs in via the GUI; check whether the config directory exists
        self.find_cursor_config_dir()
            .map(|d| d.exists())
            .unwrap_or(false)
    }

    fn build_run_args(&self, _prompt: &str, cwd: &str, _session_id: Option<&str>) -> Vec<String> {
        // Main Cursor CLI feature: open the given directory.
        // Note: Cursor's headless coding mode is still evolving; for now it only opens the directory.
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
