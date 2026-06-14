# ProcessPlugin 插件服务架构

**创建时间：** 2026-05-25
**最后更新：** 2026-05-25
**作者：** 开发团队
**状态：** 已发布
**相关文档：** 无

## 文档概述

本文档描述 OpenFlux v0.6.0 引入的 ProcessPlugin 插件服务架构，即通过统一驱动框架接入外部 CLI AI Coding Agent（agy、claude、codex、cursor 等）的机制。该架构同时在 Rust（Tauri IPC 层）和 Node.js（Gateway 工具层）均有实现，两层功能对等，各自服务于不同的调用路径。

## 更新记录

| 日期 | 版本 | 更新内容 | 更新人 |
|------|------|----------|--------|
| 2026-05-25 | v1.0 | 初始版本 | 开发团队 |

---

## 1. 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                        OpenFlux UI                           │
│  settings > tools tab → Coding Agents 面板 (main.ts)        │
└─────────────┬──────────────────────────┬────────────────────┘
              │ Tauri IPC                │ WebSocket (Gateway)
              ▼                          ▼
┌─────────────────────────┐  ┌──────────────────────────────────┐
│  ProcessPluginManager   │  │  coding_agent Tool (Gateway)     │
│  (Rust / src-tauri)     │  │  gateway/src/tools/coding-agent  │
│                         │  │                                  │
│  ┌─────────────────┐    │  │  ┌────────────────────────────┐  │
│  │  CodingAgentDriver trait  │  │  DriverConfig (TypeScript) │  │
│  │  - AgyDriver    │    │  │  │  - agy / claude            │  │
│  │  - ClaudeCodeDriver│  │  │  │  - codex / cursor         │  │
│  │  - CodexDriver  │    │  │  └────────────────────────────┘  │
│  │  - CursorDriver │    │  │                                  │
│  └─────────────────┘    │  │  sessionStore: Map<string,string> │
│                         │  └──────────────────────────────────┘
│  SessionStore           │
│  (Arc<Mutex<HashMap>>)  │
└─────────────────────────┘
              │
              ▼
     CLI Process (spawn)
     agy / claude / codex / cursor
```

### 两层实现说明

| 层 | 位置 | 调用路径 | 特点 |
|----|------|----------|------|
| **Rust IPC 层** | `src-tauri/src/commands/process_plugin/` | 前端 → Tauri IPC → Rust → spawn | 直达 Rust，无超时限制，适合长时间运行任务 |
| **Gateway 工具层** | `gateway/src/tools/coding-agent/index.ts` | Agent → `coding_agent` 工具 → Gateway Node.js → spawn | 作为 Agent 工具调用，Agent 可自主选择调用 |

---

## 2. 核心组件

### 2.1 驱动接口（Rust Trait）

文件：[`driver.rs`](../../src-tauri/src/commands/process_plugin/driver.rs)

```rust
pub trait CodingAgentDriver: Send + Sync {
    fn id(&self) -> &str;                          // 驱动 ID（如 "agy"）
    fn display_name(&self) -> &str;                // UI 显示名称
    fn find_binary(&self) -> Option<PathBuf>;      // 查找可执行文件
    fn is_authenticated(&self) -> bool;            // 检查认证状态
    fn build_run_args(&self, prompt, cwd, session_id) -> Vec<String>;  // 构建命令参数
    fn supports_session_resume(&self) -> bool;     // 是否支持 session 恢复
    fn default_timeout_secs(&self) -> u64;         // 超时（0=不限）
    fn extract_session_id_from_stdout(&self, stdout) -> Option<String>; // 从输出提取 session ID
    fn read_latest_session_id(&self) -> Option<String>;                 // 从文件系统读取 session ID
    fn resolve_session_id(&self, stdout) -> Option<String>;             // 组合上两个方法
}
```

**默认实现**：`status()` 方法组合 `find_binary()` + `is_authenticated()` 返回 `DriverStatus`，无需各驱动重复实现。

### 2.2 驱动管理器

文件：[`mod.rs`](../../src-tauri/src/commands/process_plugin/mod.rs)

```rust
pub struct ProcessPluginManager {
    drivers: HashMap<String, Box<dyn CodingAgentDriver>>,
    sessions: SessionStore,
}
```

**核心方法：**
- `list_drivers()` → 返回所有驱动的状态列表
- `execute(driver_id, prompt, nexusai_session, cwd, progress_cb)` → 执行任务，实时流式 stdout，返回 `DriverResult`
- `reset_session(driver_id, nexusai_session)` → 清除 session，下次从头开始
- `get_session_status(driver_id, nexusai_session)` → 查询当前 session 状态

### 2.3 Session 管理

文件：[`session.rs`](../../src-tauri/src/commands/process_plugin/session.rs)

**Key 设计**：`"{nexusai_session_id}:{driver_id}"` — 同一个 NexusAI 会话（Agent 对话）可以同时维护多个工具（agy/claude 等）各自独立的 session。

```rust
pub struct DriverSession {
    pub driver_id: String,
    pub conv_id: Option<String>,    // CLI 工具的 conversation/session ID
    pub cwd: String,                // 工作目录
    pub started_at: Instant,        // session 创建时间
    pub iteration: u32,             // 已执行次数
}
```

**状态流转：**
```
first run  → conv_id: None        → spawn CLI，执行完成
after run  → conv_id: Some("...") → 下次执行带 --conversation/--resume 参数（session 恢复）
reset      → conv_id: None        → 重置，下次重新开 session
```

### 2.4 Tauri Commands（IPC 接口）

```rust
// 列出驱动状态
process_plugin_list_drivers() -> Vec<DriverStatus>

// 统一工具调用入口
process_plugin_call(driver_id, tool, args) -> serde_json::Value
  // tool = "run"    args: { prompt, cwd, nexusai_session }
  // tool = "reset"  args: { nexusai_session }
  // tool = "status" args: { nexusai_session }
  // tool = "driver_status"
```

---

## 3. 驱动实现一览

| 驱动 ID | 显示名 | Session 恢复 | Session ID 来源 | 超时 | 认证检测 |
|---------|--------|------------|----------------|------|---------|
| `agy` | Antigravity CLI | ✅ | 读取 conversations/ 最新文件名 | 无限 | `%APPDATA%\agy\` 目录存在 |
| `claude` | Claude Code | ✅ | stdout 末行 `Session ID: xxx` | 无限 | `~/.claude` 目录存在 |
| `codex` | OpenAI Codex CLI | ❌ | 不支持 | 300s | `OPENAI_API_KEY` 环境变量 |
| `cursor` | Cursor | ❌ | 不支持 | 60s | `%APPDATA%\Cursor` 目录存在 |

### 驱动二进制查找顺序

1. **PATH 环境变量**（`which::which(name)`）
2. **候选固定路径**（各驱动在 `binaryHints` 中定义）
   - Windows：`%LOCALAPPDATA%\{tool}\bin\{tool}.exe`
   - macOS/Linux：`~/.local/bin/{tool}` 或 `~/bin/{tool}`

---

## 4. 执行流程（Rust 层）

```
前端调用 process_plugin_call("agy", "run", { prompt, cwd, nexusai_session })
         │
         ▼
ProcessPluginManager::execute()
         │
         ├─ 1. 验证 driver 存在
         │
         ├─ 2. find_binary() → 获取可执行路径（失败则 Error）
         │
         ├─ 3. SessionStore::get_conv_id() → 查找上次 session ID（可选）
         │
         ├─ 4. build_run_args(prompt, cwd, conv_id) → 构建命令行参数
         │
         ├─ 5. tokio::process::Command::spawn()
         │      ├─ kill_on_drop: true（自动清理子进程）
         │      └─ 实时读取 stdout 行 → progress_cb(line)
         │
         ├─ 6. 超时控制（driver.default_timeout_secs() > 0 时启用）
         │
         ├─ 7. resolve_session_id(stdout) → 提取新 session ID
         │
         └─ 8. SessionStore::update_conv_id() → 保存 session 状态
                │
                └─ 返回 DriverResult { success, output, exit_code, session_id }
```

---

## 5. Gateway 工具层（TypeScript）

文件：[`gateway/src/tools/coding-agent/index.ts`](../../gateway/src/tools/coding-agent/index.ts)

Agent 侧使用 `coding_agent` 工具时走此路径。

**工具参数：**

```typescript
{
  driver: "agy" | "claude" | "codex" | "cursor",
  action: "run" | "reset" | "status" | "list_drivers",
  prompt?: string,      // action=run 时必填
  cwd?: string,         // 工作目录，默认 agent workspace
  nexusai_session?: string,  // NexusAI session ID，自动管理
}
```

**Session 存储**：Gateway 层用内存 `Map<string, string>` 存储 `sessionKey → conv_id`，Gateway 重启后清空（与 Rust 层的持久化行为不同）。

**spawn 行为：**
- Windows：`shell: true`（支持 `.cmd` 文件）
- `windowsHide: true`（隐藏控制台窗口）
- 实时流式 stdout → `onLine` 回调

---

## 6. UI 集成（Coding Agents 面板）

文件：`src/main.ts`，约 2890-2965 行

- **settings → tools 标签页**：展示所有驱动的安装/认证状态卡片
- **刷新按钮**（`coding-agents-refresh-btn`）：重新调用 `renderCodingAgents()`
- **数据来源**：通过 `GatewayClient` WebSocket 调用 `coding_agent` 工具的 `list_drivers` action

```typescript
// 调用路径
renderCodingAgents()
  → gatewayClient.listCodingAgentDrivers()
  → WebSocket → Gateway → coding_agent { action: "list_drivers" }
  → 返回驱动列表 → 渲染状态卡片
```

---

## 7. 新增驱动（扩展指南）

### Rust 层新增驱动

1. 在 `src-tauri/src/commands/process_plugin/drivers/` 新建 `my_tool.rs`
2. 实现 `CodingAgentDriver` trait（必须实现 `id`、`display_name`、`find_binary`、`is_authenticated`、`build_run_args`）
3. 在 `drivers/mod.rs` 中 `pub mod my_tool;`
4. 在 `ProcessPluginManager::new()` 中 `mgr.register(Box::new(MyToolDriver::default()));`

### Gateway 层新增驱动

在 `gateway/src/tools/coding-agent/index.ts` 的 `DRIVERS` 对象中添加：

```typescript
my_tool: {
    id: 'my_tool',
    displayName: 'My Tool',
    binaryHints: [ /* 固定路径候选 */ ],
    authCheckPaths: [ /* 认证文件路径 */ ],
    buildArgs(prompt, sessionId, extraArgs) { /* 构建命令行 */ },
    extractSessionId(stdout) { /* 从输出提取 session ID */ },
    supportsResume: true,
    timeoutMs: 0,
},
```

---

## 8. 已知限制

1. **Rust 层 SessionStore 内存存储**：进程重启后 session 状态丢失，重启后首次调用会开启新 session（不影响功能，仅上下文连续性）。
2. **Gateway 层 session 更轻量**：仅存 conv_id，无 cwd/iteration 等元数据。
3. **stdout 实时流**：Rust 层目前通过 channel 收集，尚未对接 Tauri Event emit（实时进度前端不可见），后续可改为 `app.emit("process_plugin_progress", line)`。
4. **Cursor 驱动**：当前实现为打开目录（GUI 模式），非无头 headless 运行，适用场景有限。
