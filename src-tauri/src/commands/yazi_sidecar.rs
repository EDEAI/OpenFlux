//! Yazi Sidecar Bridge
//!
//! Spawns `yazi --plugin <plugin_path>` as a child process and communicates
//! with it via the yazi plugin protocol (one JSON object per line on stdin/stdout).
//!
//! This gives Afrodita access to yazi's core capabilities:
//!   - yazi-fs: async directory listing, stat, glob, character-icon detection
//!   - yazi-vfs: virtual file system overlay
//!   - yazi-dds: pub/sub between watchers and UI
//!   - yazi-watcher: native inotify/fsevent/kqueue file watching
//!   - yazi-shared: natsort, filtering, async sort
//!
//! Plugin protocol: https://yazi-rs.github.io/docs/plugin/integration

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use serde::{Deserialize, Serialize};
use serde_json;

// ─── Yazi Plugin Protocol Types ────────────────────────────────────────────────

/// Events sent FROM yazi TO the plugin (we receive these)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event")]
#[serde(rename_all = "snake_case")]
pub enum YaziToPlugin {
    WatchAdd { payload: WatchPayload },
    WatchRemove { payload: WatchPayload },
    WatchUpdate { payload: WatchUpdatePayload },
    Highlight { payload: HighlightPayload },
    Hover { payload: HoverPayload },
    Search { payload: SearchPayload },
    FilePrefetch { payload: HoverPayload },
    Which { payload: WhichPayload },
    /// Sent when yazi is starting/restarting
    Init,
    /// Yazi version info
    Start { payload: StartPayload },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WatchPayload {
    pub tab_id: u32,
    pub cwd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WatchUpdatePayload {
    pub tab_id: u32,
    pub cwd: String,
    #[serde(default)]
    pub files: Vec<YaziFile>,
    #[serde(default)]
    pub create: Vec<String>,
    #[serde(default)]
    pub delete: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HighlightPayload {
    pub tab_id: u32,
    pub cwd: String,
    pub file: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HoverPayload {
    pub tab_id: u32,
    pub cwd: String,
    pub file: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchPayload {
    pub tab_id: u32,
    pub cwd: String,
    pub query: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhichPayload {
    pub cmd: String,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartPayload {
    pub version: String,
    pub cwd: String,
}

/// Yazi file representation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YaziFile {
    pub name: String,
    pub url: String,
    #[serde(rename = "cha")]
    pub cha: String, // yazi character icon (e.g. "/" for dir, "r" for readable file)
    #[serde(rename = "cha_len")]
    pub cha_len: Option<u64>,
    #[serde(rename = "cha_mode")]
    pub cha_mode: Option<String>,
    #[serde(rename = "cha_mtime")]
    pub cha_mtime: Option<u64>,
    #[serde(rename = "cha_atime")]
    pub cha_atime: Option<u64>,
    #[serde(rename = "cha_btime")]
    pub cha_btime: Option<u64>,
    #[serde(rename = "cha_uid")]
    pub cha_uid: Option<u32>,
    #[serde(rename = "cha_gid")]
    pub cha_gid: Option<u32>,
    pub mime: Option<String>,
    #[serde(rename = "link_to")]
    pub link_to: Option<String>,
}

impl YaziFile {
    /// Convert to Afrodita's FileEntry format
    pub fn to_file_entry(&self) -> FileEntry {
        FileEntry {
            name: self.name.clone(),
            path: self.url.clone(),
            is_directory: self.cha == "/",
            is_symlink: self.link_to.is_some(),
            size: self.cha_len.unwrap_or(0),
            modified: self.cha_mtime.unwrap_or(0),
            permissions: self.cha_mode.clone().unwrap_or_default(),
            uid: self.cha_uid.unwrap_or(u32::MAX),
            gid: self.cha_gid.unwrap_or(u32::MAX),
            mime: self.mime.clone().unwrap_or_else(|| {
                if self.cha == "/" {
                    "inode/directory".to_string()
                } else {
                    "application/octet-stream".to_string()
                }
            }),
        }
    }
}

/// Commands sent FROM plugin TO yazi
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event")]
#[serde(rename_all = "snake_case")]
pub enum PluginToYazi {
    Provide { id: String, data: ProvideData },
    Stderr { msg: String },
    Notify { title: String, body: String },
    Close,
    Detach { tab_id: u32 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProvideData {
    pub content: Option<String>,
    #[serde(rename = "json")]
    pub json_data: Option<serde_json::Value>,
    pub mime: Option<String>,
    pub lines: Option<u32>,
    pub lang: Option<String>,
}

// ─── File Entry (re-export from fs_extra) ────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub modified: u64,
    pub permissions: String,
    pub uid: u32,
    pub gid: u32,
    pub mime: String,
}

// ─── Watcher ──────────────────────────────────────────────────────────────────

pub struct Watcher {
    pub tab_id: u32,
    pub cwd: String,
    pub revision: u64,
}

// ─── Sidecar State ─────────────────────────────────────────────────────────────

pub struct YaziSidecar {
    child: Option<Child>,
    stdin: Option<std::process::ChildStdin>,
    /// Events received from yazi, keyed by tab_id
    watchers: HashMap<u32, Watcher>,
    /// Current tab used for navigation
    current_tab: u32,
    /// Whether the sidecar is running
    running: bool,
}

impl YaziSidecar {
    pub fn new() -> Self {
        Self {
            child: None,
            stdin: None,
            watchers: HashMap::new(),
            current_tab: 0,
            running: false,
        }
    }

    /// Start yazi as a sidecar with the given plugin path
    pub fn start(&mut self, plugin_path: &str) -> Result<(), String> {
        if self.running {
            return Err("Sidecar already running".to_string());
        }

        // Find yazi in PATH
        let yazi_path = std::env::var("PATH")
            .ok()
            .and_then(|p| {
                std::env::split_paths(&p)
                    .find(|pb| {
                        #[cfg(target_os = "windows")]
                        { pb.join("yazi.exe").exists() }
                        #[cfg(not(target_os = "windows"))]
                        { pb.join("yazi").exists() }
                    })
                    .map(|p| {
                        #[cfg(target_os = "windows")]
                        { p.join("yazi.exe") }
                        #[cfg(not(target_os = "windows"))]
                        { p.join("yazi") }
                    })
            })
            .ok_or("yazi not found in PATH. Please install yazi: https://github.com/sxyazi/yazi")?;

        let mut child = Command::new(&yazi_path)
            .arg("--plugin")
            .arg(plugin_path)
            .arg("--cwd") // Start in a specific directory
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("Failed to spawn yazi: {}", e))?;

        let stdin = child.stdin.take().ok_or("Failed to capture yazi stdin")?;
        let stdout = child.stdout.take().ok_or("Failed to capture yazi stdout")?;

        self.stdin = Some(stdin);
        self.child = Some(child);
        self.running = true;

        // Start reading thread
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                // Forward to Tauri event system via a temp file or shared state
                // In practice this would use a channel or the Tauri event emitter
                eprintln!("[YaziSidecar] Received: {}", &line[..line.len().min(200)]);
            }
        });

        Ok(())
    }

    /// Send a command to yazi's stdin
    pub fn send(&mut self, cmd: &PluginToYazi) -> Result<(), String> {
        let json = serde_json::to_string(cmd).map_err(|e| e.to_string())?;
        let line = json + "\n";
        if let Some(ref mut stdin) = self.stdin {
            stdin.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
            stdin.flush().map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Navigate a tab to a directory (creates watcher in yazi)
    pub fn navigate(&mut self, tab_id: u32, cwd: &str) -> Result<(), String> {
        let event = serde_json::json!({
            "event": "watch_add",
            "payload": { "tab_id": tab_id, "cwd": cwd }
        });
        let line = event.to_string() + "\n";
        if let Some(ref mut stdin) = self.stdin {
            stdin.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
            stdin.flush().map_err(|e| e.to_string())?;
        }
        self.watchers.insert(tab_id, Watcher { tab_id, cwd: cwd.to_string(), revision: 0 });
        self.current_tab = tab_id;
        Ok(())
    }

    /// Remove a watcher (tab closed)
    pub fn detach(&mut self, tab_id: u32) -> Result<(), String> {
        self.send(&PluginToYazi::Detach { tab_id })?;
        self.watchers.remove(&tab_id);
        Ok(())
    }

    /// Get all known tabs
    pub fn tabs(&self) -> Vec<(u32, String)> {
        self.watchers.iter().map(|(k, v)| (*k, v.cwd.clone())).collect()
    }

    /// Stop the sidecar
    pub fn stop(&mut self) {
        self.running = false;
        let _ = self.send(&PluginToYazi::Close);
        if let Some(ref mut child) = self.child {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.child = None;
        self.stdin = None;
        self.watchers.clear();
    }

    pub fn is_running(&self) -> bool {
        self.running
    }
}

impl Default for YaziSidecar {
    fn default() -> Self {
        Self::new()
    }
}

// ─── Global Sidecar ─────────────────────────────────────────────────────────────

static YAZI_SIDECAR: std::sync::OnceLock<Mutex<YaziSidecar>> = std::sync::OnceLock::new();

fn get_sidecar() -> &'static Mutex<YaziSidecar> {
    YAZI_SIDECAR.get_or_init(|| Mutex::new(YaziSidecar::new()))
}

// ─── Tauri Commands ───────────────────────────────────────────────────────────

/// Spawn yazi sidecar with the Afrodita plugin
#[tauri::command]
pub async fn yazi_spawn(plugin_path: String) -> Result<(), String> {
    let mut sidecar = get_sidecar().lock().map_err(|e| e.to_string())?;
    if sidecar.is_running() {
        return Err("Yazi sidecar already running".to_string());
    }
    sidecar.start(&plugin_path)
}

/// Stop the yazi sidecar
#[tauri::command]
pub async fn yazi_stop() -> Result<(), String> {
    let mut sidecar = get_sidecar().lock().map_err(|e| e.to_string())?;
    sidecar.stop();
    Ok(())
}

/// Navigate a yazi tab to a directory (creates watcher + triggers listing)
#[tauri::command]
pub async fn yazi_navigate(tab_id: u32, cwd: String) -> Result<(), String> {
    let mut sidecar = get_sidecar().lock().map_err(|e| e.to_string())?;
    if !sidecar.is_running() {
        return Err("Yazi sidecar not running".to_string());
    }
    sidecar.navigate(tab_id, &cwd)
}

/// Detach/close a tab watcher
#[tauri::command]
pub async fn yazi_detach(tab_id: u32) -> Result<(), String> {
    let mut sidecar = get_sidecar().lock().map_err(|e| e.to_string())?;
    sidecar.detach(tab_id)
}

/// Send a raw plugin command to yazi (for advanced use)
#[tauri::command]
pub async fn yazi_send_raw(event: String, payload: serde_json::Value) -> Result<(), String> {
    let mut sidecar = get_sidecar().lock().map_err(|e| e.to_string())?;
    let cmd = PluginToYazi::Provide {
        id: format!("afrodita-{}", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()),
        data: ProvideData {
            content: None,
            json_data: Some(serde_json::json!({"event": event, "payload": payload})),
            mime: None,
            lines: None,
            lang: None,
        },
    };
    sidecar.send(&cmd)
}

/// List all active yazi tabs and their working directories
#[tauri::command]
pub async fn yazi_tabs() -> Result<Vec<(u32, String)>, String> {
    let sidecar = get_sidecar().lock().map_err(|e| e.to_string())?;
    Ok(sidecar.tabs())
}

/// Check if yazi sidecar is running
#[tauri::command]
pub async fn yazi_running() -> Result<bool, String> {
    let sidecar = get_sidecar().lock().map_err(|e| e.to_string())?;
    Ok(sidecar.is_running())
}
