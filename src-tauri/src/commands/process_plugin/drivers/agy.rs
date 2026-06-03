//! AgyDriver — Antigravity CLI (agy) driver implementation

use std::path::PathBuf;
use crate::commands::process_plugin::driver::CodingAgentDriver;

#[derive(Default)]
pub struct AgyDriver;

impl CodingAgentDriver for AgyDriver {
    fn id(&self) -> &str { "agy" }
    fn display_name(&self) -> &str { "Antigravity CLI" }

    fn find_binary(&self) -> Option<PathBuf> {
        // Prefer agy on PATH
        if let Ok(p) = which::which("agy") {
            return Some(p);
        }
        // Windows install path: %LOCALAPPDATA%\agy\bin\agy.exe
        #[cfg(target_os = "windows")]
        {
            let local = std::env::var("LOCALAPPDATA").ok()?;
            let p = PathBuf::from(local).join("agy").join("bin").join("agy.exe");
            if p.exists() { return Some(p); }
        }
        // macOS/Linux: ~/.local/bin/agy or ~/bin/agy
        #[cfg(not(target_os = "windows"))]
        {
            let home = std::env::var("HOME").ok()?;
            for suffix in &[".local/bin/agy", "bin/agy"] {
                let p = PathBuf::from(&home).join(suffix);
                if p.exists() { return Some(p); }
            }
        }
        None
    }

    fn is_authenticated(&self) -> bool {
        // After authenticating, agy writes a credentials file into the config directory
        // Windows: %APPDATA%\agy\ or %LOCALAPPDATA%\agy\
        // Check for a non-empty config file (simple heuristic)
        self.find_credentials_path()
            .map(|p| p.exists())
            .unwrap_or(false)
    }

    fn build_run_args(&self, prompt: &str, _cwd: &str, session_id: Option<&str>) -> Vec<String> {
        let mut args: Vec<String> = vec![];

        // If there is a previous conversation ID, continue that session
        if let Some(id) = session_id {
            args.push("--conversation".into());
            args.push(id.into());
        }

        // Fixed arguments
        args.push("--dangerously-skip-permissions".into());
        args.push("--print".into());
        args.push(prompt.into());

        args
    }

    fn supports_session_resume(&self) -> bool { true }

    fn extra_args(&self) -> Vec<String> {
        vec!["--dangerously-skip-permissions".into()]
    }

    fn read_latest_session_id(&self) -> Option<String> {
        // agy stores conversations in the config directory; read the most recent one.
        // The exact path is determined after agy authenticates; this is a reasonable guess.
        let config_dir = self.find_config_dir()?;
        let conv_dir = config_dir.join("conversations");
        if !conv_dir.exists() { return None; }

        // Find the most recently modified file and use its filename (without extension) as conv_id
        let mut entries: Vec<_> = std::fs::read_dir(&conv_dir).ok()?
            .filter_map(|e| e.ok())
            .collect();
        entries.sort_by_key(|e: &std::fs::DirEntry| {
            e.metadata().and_then(|m| m.modified()).ok()
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
        });
        let latest = entries.last()?;
        let name = latest.file_name();
        let stem = std::path::Path::new(&name).file_stem()?;
        Some(stem.to_string_lossy().to_string())
    }
}

impl AgyDriver {
    fn find_config_dir(&self) -> Option<PathBuf> {
        #[cfg(target_os = "windows")]
        {
            // Try APPDATA\agy first, then LOCALAPPDATA\agy
            if let Ok(appdata) = std::env::var("APPDATA") {
                let p = PathBuf::from(appdata).join("agy");
                if p.exists() { return Some(p); }
            }
            if let Ok(local) = std::env::var("LOCALAPPDATA") {
                let p = PathBuf::from(local).join("agy");
                if p.exists() { return Some(p); }
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            if let Ok(home) = std::env::var("HOME") {
                let p = PathBuf::from(home).join(".config").join("agy");
                if p.exists() { return Some(p); }
            }
        }
        None
    }

    fn find_credentials_path(&self) -> Option<PathBuf> {
        let dir = self.find_config_dir()?;
        // Common credential filenames
        for name in &["credentials.json", "credentials", "auth.json", "token.json"] {
            let p = dir.join(name);
            if p.exists() { return Some(p); }
        }
        // If the config dir exists and has files, treat it as authenticated
        if dir.exists() {
            let has_files = std::fs::read_dir(&dir)
                .map(|mut d| d.next().is_some())
                .unwrap_or(false);
            if has_files { return Some(dir.join("_any")); }
        }
        None
    }
}
