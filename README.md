<div align="center">

<img src="public/icon.png" alt="OpenFlux Logo" width="160" />

# ⚡ OpenFlux

**Open-source AI Agent desktop client — multi-LLM, long-term memory, browser automation & tool orchestration**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tauri v2](https://img.shields.io/badge/Tauri-v2-orange)](https://v2.tauri.app/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178c6)](https://www.typescriptlang.org/)
[![Website](https://img.shields.io/badge/Website-openflux.io-brightgreen)](https://openflux.io)

🌐 [Official Website](https://openflux.io) · 📥 [Download](https://openflux.io/#download)

**English** | [中文](README_zh.md)

</div>

---

## ✨ Features

- 🧠 **Multi-Agent Routing** — Auto-detects user intent and dispatches to general / coding / automation agents
- 🔌 **Multi-LLM Support** — Anthropic / OpenAI / DeepSeek / Moonshot / MiniMax / Zhipu / Google / Ollama, switch with one click
- 💾 **Long-term Memory** — SQLite + vector search (sqlite-vec), with conversation distillation & knowledge accumulation
- 🌐 **Browser Automation** — Built-in Playwright for web interaction, data scraping & form filling
- 🛠️ **MCP Tool Ecosystem** — Model Context Protocol compatible, extensible with Excel, PPT and other external tools
- 🗣️ **Voice Interaction** — Offline speech recognition (Sherpa-ONNX) + Edge TTS synthesis
- 🔒 **Sandbox Isolation** — Local code hardening / Docker container isolation for safe code execution
- 🖥️ **Desktop Control** — Mouse & keyboard simulation, window management, desktop automation
- 📡 **Remote Access** — Connect to Lark, DingTalk and other platforms via OpenFlux Router
- 🏗️ **Tauri v2** — Rust backend + TypeScript frontend, small footprint & high performance

## 🌐 Ecosystem

OpenFlux is the desktop entry point in the **Enterprise AI Assistant** ecosystem, working together with [NexusAI](https://github.com/EDEAI/NexusAI) to build a complete AI workflow system:

```
┌─────────────────────────────────────────────────────────┐
│               NexusAI (Enterprise Platform)             │
│  Agent Design · Visual Workflows · Knowledge Base       │
└────────────────────────┬────────────────────────────────┘
                         │ Workflows / Agent Config / API Key Distribution
              ┌──────────▼──────────┐
              │  OpenFlux Router    │
              │  Integration Hub    │
              │  Lark/DingTalk/API  │
              └──────────┬──────────┘
                         │ WebSocket
              ┌──────────▼──────────┐
              │   OpenFlux Desktop  │  ← You are here
              │  Local Agent Engine │
              │  Private Workflows  │
              └─────────────────────┘
```

| Component | Role | Value |
|-----------|------|-------|
| **[NexusAI](https://github.com/EDEAI/NexusAI)** | Enterprise AI Platform | Agent/Workflow design, knowledge management, team collaboration |
| **OpenFlux Router** | Integration Hub | Multi-platform bridging (Lark/DingTalk), unified API key distribution, message routing |
| **OpenFlux (this project)** | Desktop Client | Local agent execution, browser automation, private workflows, long-term memory |

> OpenFlux can also run **standalone** — no NexusAI or Router required. Just configure your own API keys and you're good to go.

## 🏗️ Architecture

```
┌─────────────────────────────┐
│       Tauri v2 Shell        │  ← Rust process management + native APIs
├─────────────────────────────┤
│   Frontend (TypeScript/HTML)│  ← Chat UI / Settings / File preview
├─────────────────────────────┤
│   Gateway Sidecar (Node.js) │  ← AI engine / Tool calls / Memory system
└─────────────────────────────┘
```

## 🚀 Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) >= 20
- [pnpm](https://pnpm.io/) >= 10
- [Rust](https://www.rust-lang.org/) (stable)
- Tauri v2 CLI: `cargo install tauri-cli --version "^2"`

### Installation

```bash
# Clone the repository
git clone https://github.com/EDEAI/OpenFlux.git
cd OpenFlux

# Install frontend dependencies
pnpm install

# Install Gateway dependencies
cd gateway && npm install && cd ..

# Build Gateway
# (see scripts/build-gateway.ps1)
```

### Configuration

```bash
# Copy the config template
cp openflux.example.yaml openflux.yaml

# Edit openflux.yaml and add your API keys
# At least one LLM provider is required
```

### Development

```bash
pnpm tauri dev
```

### Build

```bash
pnpm tauri build
```

## ⚙️ Configuration

All settings are in `openflux.yaml`. See [`openflux.example.yaml`](openflux.example.yaml) for reference:

| Section | Description |
|---------|-------------|
| `providers` | LLM provider API keys and endpoints |
| `llm` | Orchestration / execution / embedding / fallback model selection |
| `memory` | Long-term memory toggle, vector dimensions, distillation strategy |
| `agents` | Multi-agent routing and tool permissions |
| `browser` | Browser automation settings |
| `voice` | Speech recognition & synthesis |
| `sandbox` | Code execution isolation |
| `web` | Search (Brave/Perplexity) & web scraping |
| `mcp` | External MCP tool servers |

## 📁 Project Structure

```
OpenFlux/
├── src/              # Frontend TypeScript (UI / interaction)
├── src-tauri/        # Rust backend (Tauri Shell)
│   └── src/          # Rust source code
├── gateway/          # Gateway Sidecar (AI engine)
│   └── src/          # TypeScript source code
├── public/           # Static assets
├── resources/        # Model files
├── scripts/          # Build scripts
└── openflux.example.yaml  # Config template
```

## 🤝 Contributing

Contributions are welcome! Feel free to open issues and pull requests.

1. Fork this repository
2. Create your feature branch: `git checkout -b feature/amazing-feature`
3. Commit your changes: `git commit -m 'Add amazing feature'`
4. Push to the branch: `git push origin feature/amazing-feature`
5. Open a Pull Request

## 📄 License

This project is licensed under the [MIT License](LICENSE).
