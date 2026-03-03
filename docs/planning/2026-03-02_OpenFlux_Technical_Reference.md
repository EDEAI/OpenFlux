# OpenFlux Technical Reference

**Created:** 2026-03-02  
**Last Updated:** 2026-03-03  
**Author:** Development Team  
**Status:** Published  
**Version:** v0.1.6

## Overview

This document is the complete technical reference for OpenFlux (Rust/Tauri v2 edition), covering installation, configuration, features, development build, and troubleshooting.

## Changelog

| Date | Version | Changes | Author |
|------|---------|---------|--------|
| 2026-03-03 | v1.0 | Initial English version | Development Team |

---

## Table of Contents

1. [Product Introduction](#1-product-introduction)
2. [System Architecture](#2-system-architecture)
3. [Installation & Deployment](#3-installation--deployment)
4. [Configuration Reference](#4-configuration-reference)
5. [Feature Modules](#5-feature-modules)
6. [Multi-Agent System](#6-multi-agent-system)
7. [Tool System](#7-tool-system)
8. [MCP Tool Extensions](#8-mcp-tool-extensions)
9. [Long-Term Memory System](#9-long-term-memory-system)
10. [Voice Interaction](#10-voice-interaction)
11. [Browser Automation](#11-browser-automation)
12. [Sandbox Isolation](#12-sandbox-isolation)
13. [Remote Access & Router](#13-remote-access--router)
14. [Internationalization (i18n)](#14-internationalization-i18n)
15. [Developer Guide](#15-developer-guide)
16. [Scripts & Utilities](#16-scripts--utilities)
17. [FAQ](#17-faq)

---

## 1. Product Introduction

OpenFlux is an open-source AI Agent desktop client providing multi-model access, long-term memory, browser automation, tool orchestration, and more in an all-in-one AI assistant.

### Core Features

| Feature | Description |
|---------|-------------|
| 🧠 Multi-Agent Routing | Auto-detects user intent, dispatches to General / Coding / Automation assistant |
| 🔌 Multi-Model Support | Anthropic / OpenAI / DeepSeek / Moonshot / MiniMax / Zhipu / Google / Ollama |
| 💾 Long-Term Memory | SQLite + vector search (sqlite-vec), with conversation memory distillation |
| 🌐 Browser Automation | Built-in Playwright for web operations, data scraping, form filling |
| 🛠️ MCP Tool Ecosystem | Model Context Protocol compatible, extensible with Excel, PPT, etc. |
| 🗣️ Voice Interaction | Offline speech recognition (Sherpa-ONNX) + Edge TTS synthesis |
| 🔒 Sandbox Isolation | Local code hardening / Docker container isolation |
| 🖥️ Desktop Control | Keyboard/mouse simulation, window management |
| 📡 Remote Access | Connect to Feishu/Lark via OpenFlux Router |
| 🌍 Internationalization | Chinese/English bilingual auto-switch |

### Ecosystem Positioning

```
┌──────────────────────────────────────────────┐
│           NexusAI (Enterprise Platform)       │
│  Agent Definition · Visual Workflow · KB      │
└──────────────────┬───────────────────────────┘
                   │ Standard Workflows / Agent Config / API Key Distribution
         ┌─────────▼─────────┐
         │  OpenFlux Router  │
         │  Integration Hub  │
         └─────────┬─────────┘
                   │ WebSocket
         ┌─────────▼─────────┐
         │   OpenFlux Desktop │  ← You are here
         │  Local Agent Chain │
         └───────────────────┘
```

> **Standalone Use**: OpenFlux can run independently without NexusAI or Router — just configure your own API Key.

---

## 2. System Architecture

```
┌─────────────────────────────┐
│       Tauri v2 Shell        │  ← Rust process management + native API
├─────────────────────────────┤
│     Frontend (TypeScript)   │  ← Chat UI / Settings / File Preview
├─────────────────────────────┤
│    Gateway Sidecar (Node)   │  ← AI Engine / Tool Calls / Memory System
└─────────────────────────────┘
```

### Layer Responsibilities

| Layer | Tech Stack | Role |
|-------|-----------|------|
| **Tauri Shell** | Rust | Process lifecycle, system tray, native windows, Gateway spawn |
| **Frontend** | TypeScript + HTML + CSS | Chat UI, settings panel, file preview, voice interaction |
| **Gateway** | Node.js + TypeScript | AI engine core: LLM calls, Agent Loop, tool execution, memory, MCP |

### Project Structure

```
OpenFlux/
├── src/              # Frontend TypeScript (UI)
│   ├── main.ts       # Frontend entry point
│   ├── gateway-client.ts  # Gateway WebSocket client
│   ├── voice.ts      # Voice interaction module
│   ├── i18n/         # i18n language packs
│   └── styles/       # CSS styles
├── src-tauri/        # Rust backend (Tauri Shell)
│   └── src/          # Rust source (process management, tray, commands)
├── gateway/          # Gateway Sidecar (AI Engine)
│   └── src/
│       ├── agent/    # Agent system (router, loop, subagent, collaboration)
│       ├── browser/  # Browser automation (Playwright)
│       ├── config/   # Config parsing
│       ├── llm/      # LLM Provider abstraction
│       ├── tools/    # Built-in tools (13 types)
│       ├── workflow/  # Workflow engine
│       └── utils/    # Utilities
├── resources/        # Model files (embedding models, etc.)
├── scripts/          # Build/reset scripts
├── openflux.yaml     # Main config file
└── openflux.example.yaml  # Config template
```

---

## 3. Installation & Deployment

### 3.1 Installer (Recommended)

Download the latest installer (`.msi`) from [GitHub Releases](https://github.com/EDEAI/OpenFlux/releases) and run it.

The first launch triggers a setup wizard to configure your LLM API Key.

### 3.2 Build from Source

#### Requirements

| Dependency | Minimum Version |
|------------|----------------|
| Node.js | >= 20 |
| pnpm | >= 10 |
| Rust | stable |
| Tauri CLI | `cargo install tauri-cli --version "^2"` |

#### Build Steps

```bash
# 1. Clone repository
git clone https://github.com/EDEAI/OpenFlux.git
cd OpenFlux

# 2. Install frontend dependencies
pnpm install

# 3. Install Gateway dependencies
cd gateway && npm install && cd ..

# 4. Configure
cp openflux.example.yaml openflux.yaml
# Edit openflux.yaml — fill in your API Key

# 5. Development mode
pnpm tauri dev

# 6. Build installer
pnpm tauri build
```

#### Gateway Production Build

Use the dedicated script to build the Gateway production bundle:

```powershell
# Windows
.\scripts\build-gateway.ps1

# macOS / Linux
./scripts/build-gateway.sh
```

This script:
1. Creates `gateway-prod/` with source and production `package.json`
2. Installs production deps with npm (flat `node_modules` to avoid pnpm deep nesting)
3. Installs `tsx` (runtime TypeScript executor)
4. Rebuilds `better-sqlite3` native module with bundled `node.exe` for `NODE_MODULE_VERSION` consistency
5. Strips non-win32 platform binaries (onnxruntime / sharp / canvas)
6. Copies embedding model to `resources/`
7. Packages into `gateway-bundle.tar.gz` for Tauri bundling

---

## 4. Configuration Reference

All configuration is centralized in `openflux.yaml`. Copy from `openflux.example.yaml` on first use.

### 4.1 LLM Providers (`providers`)

```yaml
providers:
  anthropic:
    apiKey: ${ANTHROPIC_API_KEY}
    baseUrl: https://api.anthropic.com

  openai:
    apiKey: ${OPENAI_API_KEY}
    baseUrl: https://api.openai.com/v1

  minimax:
    apiKey: ${MINIMAX_API_KEY}
    baseUrl: https://api.minimaxi.com/anthropic

  deepseek:
    apiKey: ${DEEPSEEK_API_KEY}
    baseUrl: https://api.deepseek.com/v1

  zhipu:
    apiKey: ${ZHIPU_API_KEY}
    baseUrl: https://open.bigmodel.cn/api/paas/v4

  moonshot:
    apiKey: ${MOONSHOT_API_KEY}
    baseUrl: https://api.moonshot.cn/v1

  google:
    apiKey: ${GOOGLE_API_KEY}
    baseUrl: https://generativelanguage.googleapis.com/v1beta

  ollama:
    baseUrl: http://localhost:11434/v1  # Local Ollama — no API Key needed
```

**Supported Providers & Models:**

| Provider | Representative Models | Multimodal |
|----------|----------------------|------------|
| Anthropic | Claude Opus 4.6, Sonnet 4.5, Haiku 4.5 | ✅ |
| OpenAI | GPT-5, GPT-4.1, o4-mini, o3 | ✅ |
| DeepSeek | DeepSeek Chat (V3.2), R1 | ❌ |
| MiniMax | MiniMax-M2.5, M2.1, M1 | ❌ |
| Google | Gemini 3 Flash, 2.5 Pro/Flash | ✅ |
| Moonshot | Kimi K2.5, K2 Thinking | ✅ (K2.5) |
| Zhipu | GLM-5, GLM-4.6V, GLM-4 Plus | Partial |
| Ollama | Qwen 2.5, Llama 3.3, LLaVA | Partial |

### 4.2 LLM Configuration (`llm`)

OpenFlux uses layered LLM config — different functions can use different models:

```yaml
llm:
  # Orchestration LLM: task planning and intent understanding
  orchestration:
    provider: moonshot
    model: kimi-k2.5
    maxTokens: 4096

  # Execution LLM: tool calls and execution
  execution:
    provider: moonshot
    model: kimi-k2.5
    maxTokens: 4096

  # Embedding LLM: local model for long-term memory vectorization (bundled)
  embedding:
    provider: local
    model: Xenova/paraphrase-multilingual-MiniLM-L12-v2

  # Fallback LLM (optional): auto-switch when primary fails
  fallback:
    provider: deepseek
    model: deepseek-chat
    temperature: 0.5
```

**Embedding Model Options:**

| Model | Size | Vector Dim | Languages | Speed |
|-------|------|-----------|-----------|-------|
| `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (default) | ~120MB | 384 | Chinese/English balanced | Fast |
| `Xenova/bge-m3` (optional) | ~560MB | 1024 | Best multilingual | Medium |

> **Note:** Changing the embedding model requires updating `memory.vectorDim` accordingly.

### 4.3 Long-Term Memory (`memory`)

```yaml
memory:
  enabled: true
  dbName: openflux_memory.db
  vectorDim: 384                  # Must match embedding model
  debug: false
  distillation:
    enabled: true
    startTime: "02:00"            # Distillation window start
    endTime: "06:00"              # Distillation window end
    qualityThreshold: 40
    sessionDensityThreshold: 5
    similarityThreshold: 0.85     # Dedup threshold
```

### 4.4 Permissions (`permissions`)

```yaml
permissions:
  autoApproveLevel: 1
  allowedDirectories:
    - D:\edeProject
  blockedDirectories:
    - C:\Windows
    - C:\Program Files
```

### 4.5 Browser (`browser`)

```yaml
browser:
  enabled: true       # Enable browser automation
  headless: false     # false = visible browser window
```

### 4.6 Code Execution (`opencode`)

```yaml
opencode:
  enabled: true
  autoApprove: false  # Recommend false for safety
```

### 4.7 Web Search & Fetch (`web`)

```yaml
web:
  search:
    provider: brave               # brave or perplexity
    apiKey: ${BRAVE_API_KEY}
    maxResults: 5
    timeoutSeconds: 30
    cacheTtlMinutes: 15
  fetch:
    readability: true
    maxChars: 50000
    timeoutSeconds: 30
    cacheTtlMinutes: 15
```

### 4.8 Voice (`voice`)

```yaml
voice:
  stt:
    enabled: false
  tts:
    enabled: true
    voice: zh-CN-XiaoxiaoNeural
    rate: "+0%"
    autoPlay: false
```

### 4.9 Sandbox (`sandbox`)

```yaml
sandbox:
  mode: local                     # local (code hardening) or docker (container isolation)
  blockedExtensions:
    - exe
    - bat
    - ps1
    - cmd
    - vbs
    - reg
    - msi
```

### 4.10 Remote Access (`remote`)

```yaml
remote:
  enabled: false
  port: 18801
```

### 4.11 MCP Tool Servers (`mcp`)

```yaml
mcp:
  servers:
    - name: excel
      transport: stdio
      command: uvx
      args: ["excel-mcp-server", "stdio"]
    - name: ppt
      transport: stdio
      command: uvx
      args: ["--from", "office-powerpoint-mcp-server", "ppt_mcp_server"]
```

### 4.12 Preset Models (`presetModels`)

Default model options shown in the UI dropdown, grouped by provider.

---

## 5. Feature Modules

### 5.1 Chat Interaction

- Multi-turn conversation with automatic context management
- Markdown rendering (code highlighting, tables, Mermaid diagrams)
- Image upload (multimodal models)
- Drag-and-drop file sending
- `@AgentId` syntax for manual agent selection

### 5.2 Session Management

- Parallel session management
- Auto-persisted to `sessions/` directory
- Session search and history review

### 5.3 File Preview

- Documents: Word / Excel / PDF
- Images, multimedia files
- Code files with syntax highlighting

---

## 6. Multi-Agent System

### 6.1 Architecture

```
User Input → Router (Intent Analysis) → Select Agent → Agent Loop (Reasoning + Tools) → Response
```

### 6.2 Built-in Agents

| Agent ID | Name | Role | Tool Profile |
|----------|------|------|-------------|
| `default` | General Assistant | Q&A, chat, knowledge, translation | `full` |
| `coder` | Coding Assistant | Programming, file ops, code, data | `coding` |
| `automation` | Automation Assistant | Browser, desktop, scheduling, workflows | `automation` |

### 6.3 Routing Mechanism

**Quick Path (no LLM call):**
- Short input (< 5 chars) → default Agent
- `@agentId` explicit → direct route
- Single Agent → direct
- Keyword match (e.g., "buy", "browser") → automation

**LLM Path:**
- Sends agent list to LLM, returns best match
- Falls back to default on failure

### 6.4 Custom Agents

Add in `openflux.yaml` under `agents.list`:

```yaml
agents:
  list:
    - id: researcher
      name: "Research Assistant"
      description: "Deep research, data collection, paper analysis"
      tools:
        profile: full
        deny:
          - desktop
          - scheduler
```

### 6.5 SubAgents

Agents can spawn child agents for concurrent sub-task execution:

```yaml
agents:
  defaults:
    subagents:
      maxConcurrent: 5
      defaultTimeout: 300
      tools:
        deny:
          - scheduler
          - workflow
          - desktop
```

---

## 7. Tool System

### 7.1 Built-in Tools

| Group | Tool Name | Description |
|-------|-----------|-------------|
| **Filesystem** | `filesystem` | File read/write/create/delete/move/search |
| | `opencode` | Code execution (Node.js / Python, etc.) |
| **Runtime** | `process` | Process management, command execution |
| | `spawn` | SubAgent spawning (concurrent tasks) |
| **Web** | `browser` | Browser automation (Playwright) |
| | `web_search` | Web search (Brave / Perplexity) |
| | `web_fetch` | Web page content extraction |
| **System** | `windows` | Windows system operations |
| | `desktop` | Desktop automation (keyboard/mouse, window mgmt) |
| **Scheduling** | `scheduler` | Scheduled task management |
| | `workflow` | Workflow orchestration |
| **Office** | `office` | Office document operations |
| | `email` | Email sending |
| | `notify_user` | User notifications |

### 7.2 Tool Profiles

| Profile | Included Tools | Use Case |
|---------|---------------|----------|
| `minimal` | None | Pure chat |
| `coding` | filesystem, opencode, process, spawn, office, notify_user | Development |
| `automation` | browser, web_search, web_fetch, windows, desktop, scheduler, workflow, spawn, notify_user | Automation |
| `full` | All tools | General (default) |

### 7.3 Tool Policy (3-Layer Filter)

```
Layer 1: Profile filter (scenario-based)
    ↓
Layer 2: Agent allow/deny (per-agent fine-tuning)
    ↓
Layer 3: SubAgent deny (default safety restrictions for child agents)
```

---

## 8. MCP Tool Extensions

OpenFlux is [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) compatible, supporting external tool servers.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `name` | ✅ | Server name (unique ID) |
| `transport` | ✅ | Transport: `stdio` or `sse` |
| `command` | ✅ | Launch command |
| `args` | ❌ | Command arguments |
| `enabled` | ❌ | Enable/disable (default true) |
| `timeout` | ❌ | Timeout (seconds) |

MCP servers support hot-reload — config changes take effect without restarting.

---

## 9. Long-Term Memory System

### 9.1 How It Works

```
Chat Messages → Embedding Vectorization → SQLite + sqlite-vec Storage
                                                    ↓
User Query → Vector Search Related Memories → Inject Context → LLM Responds with Memory
```

### 9.2 Memory Distillation

- **Window**: Default 02:00 - 06:00 (avoids impacting daily use)
- **Quality**: Memories below `qualityThreshold` are cleaned
- **Dedup**: Memories above `similarityThreshold` similarity are merged
- **Density**: Low-density redundant memories are cleaned

### 9.3 Embedding Models

Run locally (no internet required), default model bundled with installer:

- **Default**: `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (384 dim, ~120MB)
- **High-accuracy**: `Xenova/bge-m3` (1024 dim, ~560MB, extra download needed)

> **Important:** Changing embedding model triggers memory rebuild (re-vectorizes all stored memories).

---

## 10. Voice Interaction

### 10.1 Speech Recognition (STT)

- Offline via **Sherpa-ONNX** with Paraformer Chinese model
- Model files in `resources/models/sherpa-onnx/`
- Init failure does not block app startup

### 10.2 Text-to-Speech (TTS)

- **Edge TTS** based voice synthesis
- Multiple voice roles, adjustable speech rate
- Optional auto-play for assistant replies

---

## 11. Browser Automation

Based on **Playwright**:

- Web navigation and interaction
- Form filling and submission
- Data scraping and screenshots
- Supports headed (visible) and headless modes

```yaml
browser:
  enabled: true
  headless: false     # false = see the browser in action
```

---

## 12. Sandbox Isolation

| Mode | Description | Security Level |
|------|-------------|---------------|
| `local` | Code hardening, file extension & directory restrictions | ★★★ |
| `docker` | Full container isolation | ★★★★★ |

Docker mode setup:
```bash
docker build -f Dockerfile.sandbox -t openflux-sandbox .
```

---

## 13. Remote Access & Router

### Standalone (Default)

OpenFlux runs fully offline. Just configure an LLM API Key to use all features.

### Via Router

OpenFlux Router enables:
- **Multi-platform**: Feishu/Lark, DingTalk, WeCom integration
- **Unified API Key management**: End users don't need their own keys
- **Message routing**: Cross-platform message dispatch

### Remote API Access

```yaml
remote:
  enabled: true
  port: 18801
  token: your-secret-token
```

---

## 14. Internationalization (i18n)

| Language | Pack | Entries |
|----------|------|---------|
| Chinese | `src/i18n/zh.ts` | 454 |
| English | `src/i18n/en.ts` | 453 |

- **Auto-detection**: Follows browser language preference
- **Manual switch**: Settings panel language toggle
- **Persistence**: Saved to `localStorage` + `server-config.json`
- **Coverage**: All frontend UI, Agent system prompts, tool descriptions

---

## 15. Developer Guide

### 15.1 Development Mode

```bash
pnpm tauri dev
```

- Frontend code: hot-reload
- Gateway code: requires restart
- Rust backend: auto-recompiles

### 15.2 Tech Stack

| Component | Technology |
|-----------|-----------|
| Desktop Framework | Tauri v2 |
| Rust Backend | Rust (stable) |
| Frontend | TypeScript 5.6 + HTML + CSS |
| Build Tool | Vite 6 |
| AI Engine | Node.js + TypeScript (tsx) |
| Package Manager | pnpm 10 |
| Vector Search | better-sqlite3 + sqlite-vec |
| Browser Automation | Playwright |
| Speech Recognition | Sherpa-ONNX (ONNX Runtime) |
| Text-to-Speech | Edge TTS |

### 15.3 Key Modules

| Module Path | Function |
|------------|----------|
| `gateway/src/agent/loop.ts` | Agent Loop core cycle |
| `gateway/src/agent/router.ts` | Intent router |
| `gateway/src/agent/manager.ts` | Agent manager (lifecycle) |
| `gateway/src/agent/subagent.ts` | SubAgent spawn & management |
| `gateway/src/agent/collaboration.ts` | Inter-agent collaboration |
| `gateway/src/tools/registry.ts` | Tool registry (factory pattern) |
| `gateway/src/tools/policy.ts` | Tool policy system (profiles + filter chain) |
| `gateway/src/llm/` | LLM Provider abstraction |
| `gateway/src/agent/memory/` | Long-term memory management |
| `src/gateway-client.ts` | Frontend → Gateway communication |
| `src/main.ts` | Frontend entry point |

---

## 16. Scripts & Utilities

### 16.1 Build Scripts

| Script | Description |
|--------|-------------|
| `scripts/build-gateway.ps1` | Build Gateway production bundle (Windows) |
| `scripts/build-gateway.sh` | Build Gateway production bundle (macOS/Linux) |

### 16.2 Reset Script

`scripts/reset.ps1` — Restore project to factory defaults.

```powershell
.\scripts\reset.ps1              # Full reset (with confirmation)
.\scripts\reset.ps1 -Force       # Silent reset
.\scripts\reset.ps1 -KeepBuild   # Keep build artifacts, clean runtime data only
.\scripts\reset.ps1 -KeepConfig  # Keep config file
```

**Cleaned items:**

| Category | Contents |
|----------|----------|
| Runtime files | `server-config.json`, `settings.json`, `openflux_memory.db` |
| Sessions | `sessions/` |
| Logs | `logs/` |
| Scheduler | `scheduler/` |
| Workflows | `.workflows/` |
| User data | `~/.openflux/` |
| Build artifacts | `dist/`, `gateway/dist/`, `src-tauri/target/`, `node_modules/` (optional) |
| Config | `openflux.yaml` → restored from example (optional) |

---

## 17. FAQ

### Q1: What's the minimum setup to get started?

Configure one LLM provider's API Key. Recommended: Moonshot (Kimi K2.5, generous free tier) or DeepSeek.

### Q2: Does the embedding model require internet?

No. The default model is bundled locally and runs offline.

### Q3: How to change the embedding model?

1. Update `llm.embedding.model` in `openflux.yaml`
2. Update `memory.vectorDim` accordingly (384 or 1024)
3. App auto-detects the change and triggers memory rebuild

### Q4: Gateway fails to start?

Common causes:
- Node.js version too low (need >= 20)
- `better-sqlite3` native module not compiled correctly (`NODE_MODULE_VERSION` mismatch)
- Port 18801 occupied

### Q5: Browser automation not working?

Ensure:
1. `browser.enabled: true` is set
2. Playwright browser installed: `npx playwright install chromium`
3. System has a graphical interface (except headless mode)

### Q6: How to use Ollama local models?

1. Install and start Ollama: `ollama serve`
2. Pull a model: `ollama pull qwen2.5:32b`
3. Configure:
```yaml
providers:
  ollama:
    baseUrl: http://localhost:11434/v1

llm:
  orchestration:
    provider: ollama
    model: "qwen2.5:32b"
  execution:
    provider: ollama
    model: "qwen2.5:32b"
```

### Q7: Where are logs?

- Runtime logs in `logs/`
- Format: `[time] [level] [module] message`
- Gateway logs include Agent Loop, tool calls, LLM requests in detail

### Q8: Where is memory data stored?

- Database: `openflux_memory.db` (SQLite)
- WAL files: `openflux_memory.db-wal`, `openflux_memory.db-shm`
- Delete all three files to clear all memories

### Q9: Is my data secure?

- All data stored locally, nothing uploaded to third parties
- LLM API calls go directly to your chosen provider
- Embedding vectorization runs locally
- Sessions, memories, config all stored in project directory or `~/.openflux/`
