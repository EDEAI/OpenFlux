<div align="center">

<img src="public/icon.png" alt="OpenFlux Logo" width="160" />

# ⚡ OpenFlux

**开源 AI Agent 桌面客户端 — 多模型、长期记忆、浏览器自动化、工具编排，一站式 AI 助手**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tauri v2](https://img.shields.io/badge/Tauri-v2-orange)](https://v2.tauri.app/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178c6)](https://www.typescriptlang.org/)
[![官网](https://img.shields.io/badge/官网-openflux.io-brightgreen)](https://openflux.io)

🌐 [官方网站](https://openflux.io) · 📥 [下载安装](https://openflux.io/#download)

[English](README.md) | **中文**

</div>

---

## ✨ 特性

- 🧠 **多 Agent 路由** — 自动识别用户意图，智能分派到通用助手 / 编码助手 / 自动化助手
- 🔌 **多模型支持** — Anthropic / OpenAI / DeepSeek / Moonshot / MiniMax / 智谱 / Google / Ollama，一键切换
- 💾 **长期记忆** — 基于 SQLite + 向量检索（sqlite-vec），支持对话记忆蒸馏与知识沉淀
- 🌐 **浏览器自动化** — 内置 Playwright，支持网页操作、数据抓取、表单填写
- 🛠️ **MCP 工具生态** — 兼容 Model Context Protocol，可扩展 Excel、PPT 等外部工具
- 🗣️ **语音交互** — 离线语音识别（Sherpa-ONNX）+ Edge TTS 语音合成
- 🔒 **沙盒隔离** — 本地代码加固 / Docker 容器隔离，安全执行代码
- 🖥️ **桌面控制** — 键鼠模拟、窗口管理、桌面自动化
- 📡 **远程访问** — 通过 OpenFlux Router 连接飞书等外部平台
- 🏗️ **Tauri v2** — Rust 后端 + TypeScript 前端，体积小、性能高

## 🌐 生态定位

OpenFlux 是 **企业超级助理** 生态的终端入口，与 [NexusAI](https://github.com/EDEAI/NexusAI) 协作构建完整的 AI 工作流体系：

```
┌─────────────────────────────────────────────────────────┐
│                    NexusAI (企业平台)                     │
│  Agent 定义 · 可视化 Workflow · 知识库 · 团队协作          │
└────────────────────────┬────────────────────────────────┘
                         │ 标准工作流 / Agent 配置 / API Key 分发
              ┌──────────▼──────────┐
              │  OpenFlux Router    │
              │  集成中枢 · 多端互联  │
              │  飞书/钉钉/企微/API  │
              └──────────┬──────────┘
                         │ WebSocket
              ┌──────────▼──────────┐
              │     OpenFlux 桌面    │  ← 你在这里
              │  本地 Agent · 工具链  │
              │  私有化工作流 · 记忆   │
              └─────────────────────┘
```

| 组件 | 定位 | 核心价值 |
|------|------|---------|
| **[NexusAI](https://github.com/EDEAI/NexusAI)** | 企业 AI 协作平台 | Agent/Workflow 定义、知识库管理、团队协作、全链路可视化 |
| **OpenFlux Router** | 集成中枢 | 多端互联（飞书/钉钉等）、LLM API Key 统一分发、消息路由 |
| **OpenFlux（本项目）** | 终端桌面客户端 | 本地 Agent 执行、浏览器自动化、私有化工作流、长期记忆 |

**三者协作**：NexusAI 在企业端完成 Agent 和 Workflow 的标准化定义 → OpenFlux 通过 Router 对接后，可直接使用企业标准工作流，同时也能在本地灵活创建私有化工作流 → Router 还负责 LLM API Key 的统一管理和分发，终端用户无需自行配置密钥即可开箱即用。

> OpenFlux 也可以 **独立使用**，无需部署 NexusAI 和 Router，只需配置自己的 API Key 即可。

## 🏗️ 客户端架构

```
┌─────────────────────────────┐
│       Tauri v2 Shell        │  ← Rust 进程管理 + 原生 API
├─────────────────────────────┤
│     前端 (TypeScript/HTML)   │  ← 聊天 UI / 设置 / 文件预览
├─────────────────────────────┤
│    Gateway Sidecar (Node)   │  ← AI 引擎 / 工具调用 / 记忆系统
└─────────────────────────────┘
```

## 🚀 快速开始

### 环境要求

- [Node.js](https://nodejs.org/) >= 20
- [pnpm](https://pnpm.io/) >= 10
- [Rust](https://www.rust-lang.org/) (stable)
- Tauri v2 CLI: `cargo install tauri-cli --version "^2"`

### 安装

```bash
# 克隆仓库
git clone https://github.com/EDEAI/OpenFlux.git
cd OpenFlux

# 安装前端依赖
pnpm install

# 安装 Gateway 依赖
cd gateway && npm install && cd ..

# 构建 Gateway
# (参考 scripts/build-gateway.ps1)
```

### 配置

```bash
# 复制配置模板
cp openflux.example.yaml openflux.yaml

# 编辑 openflux.yaml，填入你的 API Key
# 至少配置一个 LLM 供应商即可使用
```

### 开发运行

```bash
pnpm tauri dev
```

### 构建安装包

```bash
pnpm tauri build
```

## ⚙️ 配置说明

所有配置集中在 `openflux.yaml`，参考 [`openflux.example.yaml`](openflux.example.yaml)：

| 配置项 | 说明 |
|--------|------|
| `providers` | LLM 供应商 API Key 和地址 |
| `llm` | 编排 / 执行 / 嵌入 / 备用模型选择 |
| `memory` | 长期记忆开关、向量维度、蒸馏策略 |
| `agents` | 多 Agent 路由和工具权限 |
| `browser` | 浏览器自动化 |
| `voice` | 语音识别与合成 |
| `sandbox` | 代码执行隔离 |
| `web` | 搜索（Brave/Perplexity）与网页抓取 |
| `mcp` | 外部 MCP 工具服务器 |

## 📁 项目结构

```
OpenFlux/
├── src/              # 前端 TypeScript（UI / 交互）
├── src-tauri/        # Rust 后端（Tauri Shell）
│   └── src/          # Rust 源码
├── gateway/          # Gateway Sidecar（AI 引擎）
│   └── src/          # TypeScript 源码
├── public/           # 静态资源
├── resources/        # 模型文件
├── scripts/          # 构建脚本
└── openflux.example.yaml  # 配置模板
```

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

1. Fork 本仓库
2. 创建特性分支: `git checkout -b feature/amazing-feature`
3. 提交更改: `git commit -m 'Add amazing feature'`
4. 推送分支: `git push origin feature/amazing-feature`
5. 提交 Pull Request

## 📄 许可证

本项目基于 [MIT License](LICENSE) 开源。
