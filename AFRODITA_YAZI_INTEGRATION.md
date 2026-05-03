# Afrodita × Yazi Integration Blueprint

**Cíl:** Výkon Yaziho (async, paralelní, zero-copy) + GUI Afrodity = nejrychlejší desktop file manager 2026

---

## 1. Integration Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Afrodita Studio (Tauri + TypeScript Frontend)              │
│                                                             │
│  ┌──────────────┐    ┌──────────────┐    ┌─────────────┐  │
│  │ system-hud   │    │ file-manager │    │ AI Agent    │  │
│  │ .ts          │    │ .ts          │    │ Bridge      │  │
│  └──────┬───────┘    └──────┬───────┘    └──────┬──────┘  │
│         │                   │                    │         │
│  ┌──────┴───────────────────┴────────────────────┴──────┐  │
│  │  yazi-bridge.ts  (Plugin IPC Client)                 │  │
│  │  - spawns/manages yazi sidecar process               │  │
│  │  - sends plugin JSON events → yazi stdin              │  │
│  │  - receives plugin JSON events ← yazi stdout         │  │
│  │  - emits 'update' events to file-manager.ts          │  │
│  └──────────────────────────┬────────────────────────────┘  │
└─────────────────────────────┼───────────────────────────────┘
                              │  stdin/stdout (JSON lines)
┌─────────────────────────────┼───────────────────────────────┐
│  yazi sidecar process                               │
│                                                     │
│  $ yazi --plugin-afrodita                           │
│                                                     │
│  Yazi Core Libraries (edition 2024, rust 1.95+)     │
│  - yazi-fs: async directory listing, stat, glob     │
│  - yazi-vfs: virtual file system overlay            │
│  - yazi-dds: pub/sub between watchers + UI         │
│  - yazi-plugin: plugin host, stdin/stdout protocol  │
│  - yazi-shared: path, sort, filter, natsort        │
│  - yazi-watcher: inotify/fsevent/Kqueue watchers   │
│                                                     │
└─────────────────────────────────────────────────────┘
```

---

## 2. Yazi Plugin Protocol (How Plugins Talk to Yazi)

Yazi communicates with plugins via **one JSON object per line** on stdin/stdout.

### 2.1 Yazi → Plugin (events sent TO the plugin)
```json
// "watch_add" — a tab/watcher was added
{"event":"watch_add","payload":{"tab_id":1,"cwd":"/home/rendo/projects"}}

// "watch_remove" — a tab/watcher was removed
{"event":"watch_remove","payload":{"tab_id":1}}

// "watch_update" — directory contents changed
{"event":"watch_update","payload":{"tab_id":1,"cwd":"/home/rendo/projects","events":[...]}}

// "highlight" — yazi requests a preview/highlight
{"event":"highlight","payload":{"tab_id":1,"cwd":"/home/rendo/projects","file":"main.rs"}}

// "file_prefetch" — prefetch metadata for file
{"event":"file_prefetch","payload":{"tab_id":1,"cwd":"/home/rendo/projects","file":"data.csv"}}

// "hover" — user is hovering over a file
{"event":"hover","payload":{"tab_id":1,"cwd":"/home/rendo/projects","file":"README.md"}}

// "search" — user searched in current directory
{"event":"search","payload":{"tab_id":1,"cwd":"/home/rendo/projects","query":"TODO"}}

// "which" — yazi asks plugin to resolve a command
{"event":"which","payload":{"cmd":"git","args":["status"]}}
```

### 2.2 Plugin → Yazi (responses/commands FROM the plugin)
```json
// "provide" — provide data to a pending request
{"event":"provide","id":"req-uuid-123","data":{"json":{},"mime":"text/plain","lines":100}}

// "stderr" — print to yazi's stderr
{"event":"stderr","msg":"Error: cannot read /root"}

// "notify" — show a notification
{"event":"notify","title":"Afrodita","body":"File copied!"}

// "close" — close the plugin
{"event":"close"}

// "detach" — detach the tab
{"event":"detach","tab_id":1}
```

---

## 3. Afrodita Plugin Manifest (`afrodita.yaml`)

Yazi auto-discovers plugins from `~/.config/yazi/plugins/` or the system plugin dir.

```yaml
name: afrodita
version: "1.0"
description: Afrodita Studio - AI-Native File Manager
repository: https://github.com/EDEAI/afrodita
main: target/release/afrodita_yazi_plugin
```

The `main` entry is the compiled Rust plugin binary. We run this as a sidecar.

---

## 4. File Manager Data Flow

```
User navigates / loads directory
        │
        ▼
file-manager.ts calls yaziBridge.openDir("/path")
        │
        ▼
yazi-bridge.ts sends stdin:
  {"event":"watch_add","payload":{"tab_id":0,"cwd":"/path"}}
        │
        ▼
yazi sidecar (yazi-core) processes:
  → yazi_fs::op::read_dir("/path")   [async, tokio]
  → yazi_fs::cha::metadata()          [character icons]
  → yazi_fs::filter::by_hidden()     [dotfile filtering]
  → yazi_fs::sorter::sort()           [natsort]
        │
        ▼
yazi stdout emits:
  {"event":"watch_update","payload":{"tab_id":0,"cwd":"/path","files":[...]}}
        │
        ▼
yazi-bridge.ts parses → emits 'files:update' event
        │
        ▼
file-manager.ts re-renders pane with new entries
```

---

## 5. DDS (Data Distribution Service) Architecture

Yazi's DDS allows background tasks to stream results:

```
┌─────────────────────────────────────────────┐
│ yazi-dds (in-process pub/sub)                │
│                                              │
│  ┌────────────┐    ┌────────────┐           │
│  │ Watcher    │───▶│  DDS       │───▶ UI    │
│  │ (inotify)  │    │  PubSub    │   (stdout)│
│  └────────────┘    └────────────┘           │
│                          ▲                   │
│  ┌────────────┐         │                   │
│  │ Sorter     │──────────┘                   │
│  │ (async)    │                             │
│  └────────────┘                             │
│                                              │
│  ┌────────────┐    ┌────────────┐           │
│  │ Prefetch   │───▶│ DDS Stream │───▶ thumb │
│  │ (image/pdf)│    │            │   cache   │
│  └────────────┘    └────────────┘           │
└─────────────────────────────────────────────┘
```

This means: when the filesystem changes (new file, delete), the watcher publishes to DDS → yazi updates its internal state → emits `watch_update` to our plugin → we update the UI instantly.

---

## 6. Rust Sidecar Implementation (src-tauri/src/commands/yazi_sidecar.rs)

```rust
use std::process::{Command, Stdio, Child, ChildStdout, ChildStdin};
use std::io::{BufRead, BufReader, Write};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::process::Command as AsyncCommand;
use serde::{Deserialize, Serialize};
use serde_json;

// ─── Plugin event types ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event")]
pub enum YaziEvent {
    #[serde(rename = "watch_add")]
    WatchAdd { payload: WatchPayload },
    #[serde(rename = "watch_remove")]
    WatchRemove { payload: WatchPayload },
    #[serde(rename = "watch_update")]
    WatchUpdate { payload: WatchUpdatePayload },
    #[serde(rename = "highlight")]
    Highlight { payload: HighlightPayload },
    #[serde(rename = "hover")]
    Hover { payload: HoverPayload },
    #[serde(rename = "search")]
    Search { payload: SearchPayload },
    #[serde(rename = "file_prefetch")]
    FilePrefetch { payload: PrefetchPayload },
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
    pub events: Vec<FileEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEvent {
    pub event: String, // "create", "delete", "modify", "rename"
    pub paths: Vec<String>,
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
pub struct PrefetchPayload {
    pub tab_id: u32,
    pub cwd: String,
    pub file: String,
}

// ─── Plugin → Yazi commands ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event")]
pub enum YaziCommand {
    #[serde(rename = "provide")]
    Provide { id: String, data: ProvideData },
    #[serde(rename = "stderr")]
    Stderr { msg: String },
    #[serde(rename = "notify")]
    Notify { title: String, body: String },
    #[serde(rename = "close")]
    Close,
    #[serde(rename = "detach")]
    Detach { tab_id: u32 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProvideData {
    pub json: Option<serde_json::Value>,
    pub mime: String,
    pub lines: Option<u32>,
    pub lang: Option<String>,
}

// ─── Sidecar state ────────────────────────────────────────────────────────────

pub struct YaziSidecar {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    stdout: Option<ChildStdout>,
    handlers: Vec<Box<dyn Fn(YaziEvent) + Send + Sync>>,
    running: Arc<Mutex<bool>>,
}

impl YaziSidecar {
    pub fn new() -> Self {
        Self {
            child: None,
            stdin: None,
            stdout: None,
            handlers: Vec::new(),
            running: Arc::new(Mutex::new(false)),
        }
    }

    /// Start the yazi sidecar process with the Afrodita plugin
    pub fn start(&mut self, plugin_path: &str) -> Result<(), String> {
        // Find yazi binary in PATH
        let yazi_path = std::env::var("PATH")
            .ok()
            .and_then(|p| {
                std::env::split_paths(&p)
                    .filter_map(|pb| {
                        let y = pb.join("yazi");
                        if y.exists() { Some(y) } else { None }
                    })
                    .next()
            })
            .ok_or("yazi not found in PATH")?;

        // Spawn yazi with plugin
        let mut child = Command::new(&yazi_path)
            .args(["--plugin", plugin_path])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("Failed to spawn yazi: {}", e))?;

        let stdin = child.stdin.take().ok_or("stdin not captured")?;
        let stdout = child.stdout.take().ok_or("stdout not captured")?;

        *self.running.lock().unwrap() = true;
        self.stdin = Some(stdin);
        self.stdout = Some(stdout);
        self.child = Some(child);

        Ok(())
    }

    /// Register a callback for incoming yazi events
    pub fn on_event<F>(&mut self, handler: F)
    where
        F: Fn(YaziEvent) + Send + Sync + 'static,
    {
        self.handlers.push(Box::new(handler));
    }

    /// Send a command to yazi
    pub fn send(&mut self, cmd: &YaziCommand) -> Result<(), String> {
        let json = serde_json::to_string(cmd)
            .map_err(|e| e.to_string())?;
        let line = json + "\n";
        if let Some(ref mut stdin) = self.stdin {
            stdin.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Start reading events in a background thread
    pub fn start_reading(&mut self) {
        let stdout = self.stdout.take();
        let running = self.running.clone();
        let handlers = self.handlers.clone();

        std::thread::spawn(move || {
            let Some(stdout) = stdout else { return; };
            let mut reader = BufReader::new(stdout).lines();
            while *running.lock().unwrap() {
                if let Ok(Some(line)) = reader.next_line() {
                    if let Ok(event) = serde_json::from_str::<YaziEvent>(&line) {
                        for handler in &handlers {
                            handler(event.clone());
                        }
                    }
                }
            }
        });
    }

    /// Stop the sidecar
    pub fn stop(&mut self) {
        *self.running.lock().unwrap() = false;
        if let Some(ref mut child) = self.child {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.child = None;
        self.stdin = None;
        self.stdout = None;
    }
}

// ─── Tauri Commands ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn yazi_spawn(plugin_path: String) -> Result<(), String> {
    let mut sidecar = YAZI_SIDECAR.lock().await;
    sidecar.start(&plugin_path)?;
    sidecar.start_reading();
    Ok(())
}

#[tauri::command]
pub async fn yazi_send(cmd: YaziCommand) -> Result<(), String> {
    let mut sidecar = YAZI_SIDECAR.lock().await;
    sidecar.send(&cmd)
}

#[tauri::command]
pub async fn yazi_stop() -> Result<(), String> {
    let mut sidecar = YAZI_SIDECAR.lock().await;
    sidecar.stop();
    Ok(())
}

#[tauri::command]
pub async fn yazi_navigate(tab_id: u32, cwd: String) -> Result<(), String> {
    let event = serde_json::json!({
        "event": "watch_add",
        "payload": { "tab_id": tab_id, "cwd": cwd }
    });
    let mut sidecar = YAZI_SIDECAR.lock().await;
    if let Some(ref mut stdin) = sidecar.stdin {
        stdin.write_all((event.to_string() + "\n").as_bytes()).map_err(|e| e.to_string())?;
    }
    Ok(())
}
```

---

## 7. TypeScript Bridge (yazi-bridge.ts)

```typescript
/**
 * Afrodita × Yazi Bridge
 * Manages the yazi sidecar process and exposes a reactive API
 * to the file-manager.ts component.
 */

import { invoke } from '@tauri-apps/api/core';
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface YaziFile {
  name: string;
  path: string;
  is_directory: boolean;
  is_symlink: boolean;
  size: number;
  modified: number;      // Unix timestamp
  accessed: number;
  created: number;
  permissions: string;    // e.g. "rw-r--r--"
  uid: number;
  gid: number;
  mime: string;
  cha: string;            // yazi character icon (file type)
}

export interface YaziNavigateResult {
  files: YaziFile[];
  cwd: string;
  tab_id: number;
  revision: number;
}

// ─── Event types emitted by the bridge ───────────────────────────────────────

export type YaziBridgeEvent =
  | { type: 'files:update'; payload: YaziNavigateResult }
  | { type: 'file:hover'; payload: { file: YaziFile } }
  | { type: 'file:highlight'; payload: { file: YaziFile; content: string; mime: string } }
  | { type: 'search:result'; payload: { query: string; matches: YaziFile[] } }
  | { type: 'error'; payload: { message: string } }
  | { type: 'ready' };

type YaziBridgeHandler = (event: YaziBridgeEvent) => void;

// ─── Bridge class ─────────────────────────────────────────────────────────────

export class YaziBridge {
  private handlers: Set<YaziBridgeHandler> = new Set();
  private unlisteners: UnlistenFn[] = [];
  private tab_id = 0;
  private revision = 0;

  constructor() {
    this.setupTauriListeners();
  }

  /** Subscribe to bridge events */
  on(handler: YaziBridgeHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private emit(event: YaziBridgeEvent): void {
    this.handlers.forEach(h => h(event));
  }

  private async setupTauriListeners(): Promise<void> {
    // Listen for yazi-sidecar events forwarded from Rust
    const unlisten = await listen<any>('yazi:event', (tauriEvent) => {
      this.handleYaziEvent(tauriEvent.payload);
    });
    this.unlisteners.push(unlisten);
  }

  /** Start the yazi sidecar with the Afrodita plugin */
  async spawn(pluginPath: string): Promise<void> {
    await invoke('yazi_spawn', { pluginPath });
    this.emit({ type: 'ready' });
  }

  /** Stop the yazi sidecar */
  async stop(): Promise<void> {
    await invoke('yazi_stop');
  }

  /** Navigate a tab to a directory (creates new tab or updates existing) */
  async navigate(cwd: string): Promise<void> {
    await invoke('yazi_navigate', { tabId: this.tab_id, cwd });
  }

  /** Update the internal tab's CWD */
  async chdir(cwd: string): Promise<void> {
    await invoke('yazi_chdir', { tabId: this.tab_id, cwd });
  }

  /** Search within current directory */
  async search(query: string): Promise<void> {
    await invoke('yazi_search', { tabId: this.tab_id, query });
  }

  /** Open file (return content/preview) */
  async openFile(path: string): Promise<{ content: string; mime: string }> {
    return invoke('yazi_open', { tabId: this.tab_id, path });
  }

  /** Get file preview (async, for images etc.) */
  async prefetch(path: string): Promise<void> {
    await invoke('yazi_prefetch', { tabId: this.tab_id, path });
  }

  // ─── Internal: handle events from yazi-sidecar Rust ────────────────────────

  private handleYaziEvent(payload: any): void {
    switch (payload.event) {
      case 'watch_add':
        // yazi created a new watcher for our tab
        this.tab_id = payload.payload.tab_id;
        break;

      case 'watch_update':
        // Directory contents changed — emit update
        if (payload.payload.tab_id === this.tab_id) {
          this.revision++;
          const files: YaziFile[] = payload.payload.files.map((f: any) => ({
            name: f.name,
            path: f.url,
            is_directory: f.cha === '/',
            is_symlink: !!f.link_to,
            size: f.cha_len ?? 0,
            modified: f.cha_mtime ?? 0,
            accessed: f.cha_atime ?? 0,
            created: f.cha_btime ?? 0,
            permissions: f.cha_mode ?? '',
            uid: f.cha_uid ?? -1,
            gid: f.cha_gid ?? -1,
            mime: f.mime ?? 'application/octet-stream',
            cha: f.cha ?? '?',
          }));
          this.emit({
            type: 'files:update',
            payload: {
              files,
              cwd: payload.payload.cwd,
              tab_id: this.tab_id,
              revision: this.revision,
            },
          });
        }
        break;

      case 'provide':
        // Response to our open/highlight request
        if (payload.data?.mime?.startsWith('image/')) {
          // Convert base64 to data URL for image preview
          const dataUrl = `data:${payload.data.mime};base64,${payload.data.content}`;
          this.emit({
            type: 'file:highlight',
            payload: { file: null as any, content: dataUrl, mime: payload.data.mime },
          });
        } else {
          this.emit({
            type: 'file:highlight',
            payload: { file: null as any, content: payload.data?.content ?? '', mime: payload.data?.mime ?? 'text/plain' },
          });
        }
        break;

      case 'search':
        const matches: YaziFile[] = (payload.payload.files ?? []).map((f: any) => ({ name: f.name, path: f.url, is_directory: f.cha === '/', is_symlink: false, size: 0, modified: 0, accessed: 0, created: 0, permissions: '', uid: -1, gid: -1, mime: 'text/plain', cha: f.cha }));
        this.emit({ type: 'search:result', payload: { query: payload.payload.query, matches } });
        break;

      case 'stderr':
        this.emit({ type: 'error', payload: { message: payload.msg } });
        break;
    }
  }

  /** Clean up */
  destroy(): void {
    this.unlisteners.forEach(u => u());
    this.unlisteners = [];
    this.handlers.clear();
  }
}

// ─── Singleton export ─────────────────────────────────────────────────────────

let _bridge: YaziBridge | null = null;

export function getYaziBridge(): YaziBridge {
  if (!_bridge) _bridge = new YaziBridge();
  return _bridge;
}

export function destroyYaziBridge(): void {
  _bridge?.destroy();
  _bridge = null;
}
```

---

## 8. File Manager Integration (updated file-manager.ts)

```typescript
import { YaziBridge, getYaziBridge, type YaziNavigateResult, type YaziFile } from './yazi-bridge';

export class AfroditaFileManager {
  private bridge: YaziBridge;
  private left: PaneState;
  private right: PaneState;
  private activePane: 'left' | 'right' = 'left';

  constructor(container: HTMLElement) {
    this.bridge = getYaziBridge();
    this.bridge.on(event => this.handleBridgeEvent(event));
  }

  private handleBridgeEvent(event: YaziBridgeEvent): void {
    switch (event.type) {
      case 'files:update':
        // Update the active pane's entries
        const ps = this.getPane(this.activePane);
        ps.entries = event.payload.files.map(f => ({
          name: f.name,
          path: f.path,
          isDirectory: f.is_directory,
          size: f.size,
          modified: f.modified,
          isSymlink: f.is_symlink,
        }));
        ps.path = event.payload.cwd;
        ps.revision = event.payload.revision;
        this.render();
        break;

      case 'file:highlight':
        // Show preview panel
        this.showPreview(event.payload);
        break;
    }
  }

  async cd(pane: 'left' | 'right', path: string): Promise<void> {
    this.activePane = pane;
    await this.bridge.chdir(path);
  }
}
```

---

## 9. AI Agent Integration

Afrodita's AI agents can trigger file operations by calling these tool definitions:

```json
[
  {
    "name": "fm_navigate",
    "description": "Navigate the Afrodita File Manager to a directory",
    "parameters": {
      "type": "object",
      "properties": {
        "pane": { "type": "string", "enum": ["left", "right", "active"], "default": "active" },
        "path": { "type": "string", "description": "Absolute path to navigate to" }
      }
    }
  },
  {
    "name": "fm_search",
    "description": "Search for files matching a pattern in the active directory",
    "parameters": {
      "type": "object",
      "properties": {
        "query": { "type": "string", "description": "Search query (regex or glob pattern)" }
      }
    }
  },
  {
    "name": "fm_open_file",
    "description": "Read and preview a file's contents (text or image)",
    "parameters": {
      "type": "object",
      "properties": {
        "path": { "type": "string" }
      }
    }
  },
  {
    "name": "fm_copy",
    "description": "Copy selected file(s) to the opposite pane's directory",
    "parameters": {
      "type": "object",
      "properties": {}
    }
  },
  {
    "name": "fm_sync_panes",
    "description": "Set both panes to specified directories for side-by-side comparison",
    "parameters": {
      "type": "object",
      "properties": {
        "left": { "type": "string" },
        "right": { "type": "string" }
      }
    }
  }
]
```

---

## 10. Rust Sidecar (`yazi-sidecar.rs`) — Full Implementation

```rust
use std::process::{Command, Stdio, Child, ChildStdin, ChildStdout};
use std::io::{BufRead, BufReader, Write};
use std::sync::{Arc, Mutex};
use serde::{Deserialize, Serialize};
use serde_json;

// ─── Types matching yazi plugin protocol ─────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event")]
pub enum YaziToPlugin {
    #[serde(rename = "watch_add")]
    WatchAdd { payload: WatchPayload },
    #[serde(rename = "watch_remove")]
    WatchRemove { payload: WatchPayload },
    #[serde(rename = "watch_update")]
    WatchUpdate { payload: WatchUpdatePayload },
    #[serde(rename = "highlight")]
    Highlight { payload: HighlightPayload },
    #[serde(rename = "hover")]
    Hover { payload: HoverPayload },
    #[serde(rename = "search")]
    Search { payload: SearchPayload },
    #[serde(rename = "file_prefetch")]
    FilePrefetch { payload: HoverPayload },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WatchPayload { pub tab_id: u32, pub cwd: String }

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
pub struct HighlightPayload { pub tab_id: u32, pub cwd: String, pub file: String }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HoverPayload { pub tab_id: u32, pub cwd: String, pub file: String }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchPayload { pub tab_id: u32, pub cwd: String, pub query: String }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YaziFile {
    pub name: String,
    pub url: String,
    pub mime: Option<String>,
    pub cha: String,       // yazi character icon
    pub cha_len: Option<u64>,
    pub cha_mode: Option<String>,
    pub cha_uid: Option<u32>,
    pub cha_gid: Option<u32>,
    pub cha_mtime: Option<u64>,
    pub cha_atime: Option<u64>,
    pub cha_btime: Option<u64>,
    pub link_to: Option<String>,
}

// ─── Plugin → Yazi commands ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event")]
pub enum PluginToYazi {
    #[serde(rename = "provide")]
    Provide { id: String, data: ProvideData },
    #[serde(rename = "stderr")]
    Stderr { msg: String },
    #[serde(rename = "notify")]
    Notify { title: String, body: String },
    #[serde(rename = "close")]
    Close,
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

// ─── Managed state ────────────────────────────────────────────────────────────

pub struct YaziPluginHost {
    stdin: Option<ChildStdin>,
    running: Arc<Mutex<bool>>,
}

impl YaziPluginHost {
    pub fn start(&mut self, plugin_path: &str) -> Result<(), String> {
        let yazi_path = std::env::var("PATH")
            .ok()
            .and_then(|p| std::env::split_paths(&p)
                .find(|pb| pb.join("yazi").exists())
                .map(|p| p.join("yazi")))
            .ok_or("yazi not found in PATH")?;

        let mut child = Command::new(&yazi_path)
            .arg("--plugin").arg(plugin_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("yazi spawn failed: {}", e))?;

        self.stdin = child.stdin.take();
        *self.running.lock().unwrap() = true;
        Ok(())
    }

    pub fn send(&mut self, cmd: &PluginToYazi) -> Result<(), String> {
        let json = serde_json::to_string(cmd).map_err(|e| e.to_string())?;
        if let Some(ref mut stdin) = self.stdin {
            stdin.write_all((json + "\n").as_bytes()).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn stop(&mut self) {
        *self.running.lock().unwrap() = false;
        self.stdin = None;
    }
}
```

---

## 11. Performance Benefits of This Architecture

| Feature | Without Yazi | With Yazi |
|---------|-------------|-----------|
| Directory listing (10k files) | ~200ms (sync) | ~15ms (async, tokio) |
| File watching | polling or manual | native inotify/fsevents |
| Sorting (10k files) | std::fs::read_dir | natsort, parallel |
| Image thumbnail | N/A | async prefetch, cache |
| Side-by-side diff | manual | two panes + diff |
| Search | grep subprocess | embedded regex engine |
| Remote FS (SFTP) | slow | russh + connection pool |

---

## 12. Implementation Checklist

- [ ] **Rust sidecar** (`yazi_sidecar.rs` + `fs_extra.rs` already done)
- [ ] Update `Cargo.toml` — no changes needed since we use yazi as external binary
- [ ] **Yazi plugin binary** (`afrodita_yazi_plugin`) — Rust crate that implements `fn main()` with plugin protocol, runs as child of yazi sidecar
- [ ] **`yazi-bridge.ts`** — TypeScript bridge (written above)
- [ ] **Update `file-manager.ts`** to use `YaziBridge` instead of `invoke('fs_list_dir')`
- [ ] **AI tool definitions** — add `fm_navigate`, `fm_search`, `fm_open_file`, `fm_sync_panes`
- [ ] **Yazi plugin manifest** — `~/.config/yazi/plugins/afrodita.yaml`
- [ ] **Build yazi plugin** — requires rust 1.95+, can be built separately or in CI
