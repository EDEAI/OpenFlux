//! CodingAgentDriver — unified CLI Agent tool interface
//!
//! Implement this trait to integrate any CLI coding agent (agy / claude / codex / cursor, etc.).

use std::path::PathBuf;

// ── Execution result ──────────────────────────────────────────────────────────

/// Result of a single tool invocation
#[derive(Debug, Clone, serde::Serialize)]
pub struct DriverResult {
    pub success: bool,
    pub output: String,
    pub exit_code: Option<i32>,
    /// Session ID extracted after this execution (if any)
    pub session_id: Option<String>,
}

// ── Driver status ─────────────────────────────────────────────────────────────

/// Current driver status (for UI display)
#[derive(Debug, Clone, serde::Serialize)]
pub struct DriverStatus {
    pub id: String,
    pub display_name: String,
    pub installed: bool,
    pub authenticated: bool,
    pub enabled: bool,
    pub binary_path: Option<String>,
}

// ── Trait definition ──────────────────────────────────────────────────────────

/// Every CLI Agent tool must implement this trait
pub trait CodingAgentDriver: Send + Sync {
    // ── Metadata ───────────────────────────────────────────────────────────────

    /// Tool ID, used for routing; lowercase with no spaces (e.g. "agy", "claude", "codex")
    fn id(&self) -> &str;

    /// UI display name
    fn display_name(&self) -> &str;

    // ── Install & authentication ─────────────────────────────────────────────────

    /// Find the executable path (None = not installed)
    fn find_binary(&self) -> Option<PathBuf>;

    /// Check whether authentication is complete (by checking credentials files, etc., without starting a process)
    fn is_authenticated(&self) -> bool;

    // ── Build execution arguments ─────────────────────────────────────────────────

    /// Build command arguments
    ///
    /// - `prompt`: task description
    /// - `cwd`: working directory
    /// - `session_id`: previous session ID (None = create a new session)
    fn build_run_args(&self, prompt: &str, cwd: &str, session_id: Option<&str>) -> Vec<String>;

    /// Whether session resume is supported (default true)
    fn supports_session_resume(&self) -> bool {
        true
    }

    /// Timeout in seconds per execution (0 = no limit, default 0)
    fn default_timeout_secs(&self) -> u64 {
        0
    }

    // ── Session management ───────────────────────────────────────────────────────

    /// Extract the session ID from stdout
    ///
    /// Returns None if the tool does not print the session ID to stdout
    /// (it may be in a config file, handled by `read_latest_session_id`)
    fn extract_session_id_from_stdout(&self, _stdout: &str) -> Option<String> {
        None
    }

    /// Read the latest session ID from the filesystem (for tools that don't print the ID to stdout)
    fn read_latest_session_id(&self) -> Option<String> {
        None
    }

    /// Resolve the session ID: try stdout first, then the filesystem
    fn resolve_session_id(&self, stdout: &str) -> Option<String> {
        self.extract_session_id_from_stdout(stdout)
            .or_else(|| self.read_latest_session_id())
    }

    // ── Extra CLI arguments ──────────────────────────────────────────────────────

    /// Fixed arguments appended to every execution (e.g. --dangerously-skip-permissions)
    fn extra_args(&self) -> Vec<String> {
        vec![]
    }

    // ── Status reporting ─────────────────────────────────────────────────────────

    fn status(&self) -> DriverStatus {
        let binary = self.find_binary();
        let installed = binary.is_some();
        DriverStatus {
            id: self.id().to_string(),
            display_name: self.display_name().to_string(),
            installed,
            authenticated: if installed { self.is_authenticated() } else { false },
            enabled: true,
            binary_path: binary.map(|p| p.to_string_lossy().to_string()),
        }
    }
}
