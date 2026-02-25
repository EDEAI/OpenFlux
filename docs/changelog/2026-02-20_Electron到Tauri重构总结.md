# OpenFlux 架构重构总结：Electron → Tauri 2.0

**创建时间：** 2026-02-20  
**最后更新：** 2026-02-20  
**作者：** 开发团队  
**状态：** 已发布  

## 文档概述

本文档记录 OpenFlux 从 Electron 一体式架构迁移至 Tauri 2.0 三层架构的完整重构过程，涵盖架构变更、模块拆分、技术选型、已修复问题及当前状态。

## 更新记录

| 日期 | 版本 | 更新内容 | 更新人 |
|------|------|----------|--------|
| 2026-02-20 | v1.0 | 初始版本 | 开发团队 |

---

## 1. 重构背景

### 1.1 原有架构问题

旧版 OpenFlux 基于 **Electron + electron-vite** 的一体式架构：

- **安装包体积大**：Electron 自带 Chromium（~120MB），总安装包 200MB+
- **内存占用高**：Electron 本身消耗 150-300MB 内存
- **跨平台构建复杂**：`electron-builder` 对原生模块（sharp、better-sqlite3、keysender）的跨平台编译频繁出错
- **主进程单点耦合**：所有后端逻辑（LLM、Agent、工具、调度器、会话管理）全部运行在 Electron 主进程中，模块边界模糊
- **启动速度慢**：Electron 冷启动 3-5 秒

### 1.2 重构目标

- 安装包 < 30MB（不含 Gateway 依赖）
- 内存占用降低 50%+
- 清晰的三层架构分离
- 原生窗口体验
- 支持 Windows + macOS 双平台

---

## 2. 新架构概览

```
┌──────────────────────────────────────────────────┐
│                   OpenFlux Tauri                  │
├───────────┬──────────────────┬────────────────────┤
│  Rust 壳  │  前端 (Vite+TS)  │  Gateway Sidecar   │
│  (Tauri)  │  (WebView)       │  (Node.js/tsx)     │
├───────────┼──────────────────┼────────────────────┤
│ • 窗口管理 │ • UI 渲染        │ • LLM 调用         │
│ • 系统托盘 │ • WS 通信客户端   │ • Agent 引擎       │
│ • 文件操作 │ • 语音 UI        │ • 工具执行          │
│ • 进程管理 │ • Markdown 渲染   │ • 会话管理          │
│ • Gateway │ • 粒子动画       │ • 调度器            │
│   自动拉起 │                  │ • 浏览器自动化       │
│ • 配置读取 │                  │ • MCP 客户端        │
└───────────┴──────────────────┴────────────────────┘
       │              │                  │
       ▼              ▼                  ▼
   原生系统 API    WebView2/WKWebView   ws://localhost:18801
```

### 2.1 三层分工

| 层级 | 技术栈 | 职责 | 目录 |
|------|--------|------|------|
| **Rust 原生壳** | Tauri 2.0 + Rust | 窗口、托盘、文件操作、进程管理、Gateway 生命周期管理 | `src-tauri/` |
| **前端** | Vite + TypeScript | UI 渲染、WebSocket 通信、语音交互、动画 | `src/` + `index.html` |
| **Gateway Sidecar** | Node.js + TypeScript | 所有 AI 业务逻辑（LLM、Agent、工具、MCP 等） | `gateway/` |

---

## 3. 各模块详细变更

### 3.1 Rust 原生壳 (`src-tauri/`)

这是全新创建的模块，负责替代 Electron 主进程的 **窗口管理** 和 **系统交互** 职责。

#### 核心文件

| 文件 | 功能 |
|------|------|
| `lib.rs` | 应用入口，初始化 Tauri Builder、注册插件、自动启动 Gateway sidecar |
| `main.rs` | 进程入口点 |
| `config.rs` | 读取 `openflux.yaml` 配置（host/port/token） |
| `tray.rs` | 系统托盘（显示主窗口、退出） |
| `commands/gateway.rs` | Gateway sidecar 的启动/停止/重启管理 |
| `commands/window.rs` | 窗口控制（最小化/最大化/关闭/闪烁） |
| `commands/file.rs` | 文件操作（读取/保存/打开/定位） |
| `commands/system.rs` | 应用重启 |

#### 使用的 Tauri 插件

| 插件 | 用途 | 对应旧版 |
|------|------|----------|
| `tauri-plugin-shell` | 启动 Gateway sidecar 子进程 | Electron `child_process` |
| `tauri-plugin-dialog` | 文件选择对话框 | Electron `dialog` |
| `tauri-plugin-fs` | 文件系统访问 | Node.js `fs` |
| `tauri-plugin-process` | 应用退出/重启 | Electron `app.quit()` |
| `tauri-plugin-notification` | 系统通知 | Electron `Notification` |
| `tauri-plugin-opener` | 打开外部链接 | Electron `shell.openExternal` |

#### Gateway Sidecar 启动策略

```
应用启动 → lib.rs setup()
  → load_config() 读取 openflux.yaml
  → start_gateway_sidecar()
    → [prod] node dist/gateway/start.js    // 打包后
    → [dev]  tsx src/gateway/start.ts       // 开发模式
  → 后台监听 stdout/stderr → eprintln!
  → 应用退出 → on_window_event(Destroyed) → stop_gateway_sidecar()
```

**关键设计决策：**
- Dev 模式使用 `tsx` 直接运行 TypeScript 源码，避免 ESM import 扩展名问题
- 通过 `env!("CARGO_MANIFEST_DIR")` 编译时确定 src-tauri 位置，精确定位 gateway 源码
- 日志使用 `eprintln!` 直接输出到 stderr（未配置 Rust 日志后端）

### 3.2 前端 (`src/` + `index.html`)

#### 工具链变更

| 项目 | 旧版 | 新版 |
|------|------|------|
| 打包工具 | electron-vite | Vite 6.4 |
| 开发服务器端口 | 5173 | 1420 |
| 入口文件 | `src/renderer/index.html` | `index.html`（根目录） |
| 与后端通信 | Electron IPC (`ipcRenderer`) | Tauri invoke (`@tauri-apps/api`) + WebSocket |

#### 前端文件

| 文件 | 功能 |
|------|------|
| `main.ts` | 主 UI 逻辑（250KB，含聊天、设置、Agent 管理等） |
| `gateway-client.ts` | WebSocket 通信客户端（35KB） |
| `voice.ts` | 语音交互（TTS/STT/语音唤醒） |
| `cosmicHole.ts` | 宇宙粒子动画效果 |
| `markdown.ts` | Markdown 渲染（marked + highlight.js + mermaid） |
| `styles/main.css` | 全局样式 |

#### IPC 调用方式对比

```typescript
// 旧版 Electron IPC
const { ipcRenderer } = require('electron');
ipcRenderer.invoke('window-minimize');

// 新版 Tauri invoke
import { invoke } from '@tauri-apps/api/core';
await invoke('window_minimize');
```

#### 新增 Tauri 前端插件依赖

- `@tauri-apps/api` - 核心 API
- `@tauri-apps/plugin-dialog` - 对话框
- `@tauri-apps/plugin-fs` - 文件系统
- `@tauri-apps/plugin-notification` - 通知
- `@tauri-apps/plugin-opener` - 外部链接
- `@tauri-apps/plugin-process` - 进程控制
- `@tauri-apps/plugin-shell` - Shell 命令

### 3.3 Gateway Sidecar (`gateway/`)

Gateway 是从旧版 Electron 主进程中 **完整剥离** 出来的独立 Node.js 应用，包含所有 AI 业务逻辑。

#### 模块结构

| 目录 | 功能 | 文件数 |
|------|------|--------|
| `agent/` | Agent 引擎、Runner、协作管理器 | 12 |
| `browser/` | Playwright 浏览器自动化 | 7 |
| `config/` | 配置加载器 + Schema 定义 | 2 |
| `core/` | 引导程序（工具注册、初始化） | 2 |
| `gateway/` | WebSocket 服务器、独立入口 | 6 |
| `llm/` | LLM Provider（OpenAI/Anthropic/自定义） | 5 |
| `main/` | 主进程兼容层（语音服务） | 2 |
| `permissions/` | 权限管理 | 1 |
| `scheduler/` | 定时任务调度器 | 4 |
| `sessions/` | 会话/历史管理 | 4 |
| `tools/` | 工具集（文件、桌面、浏览器、MCP 等） | 27 |
| `utils/` | 工具函数（日志、Python 环境等） | 4 |
| `workflow/` | 工作流引擎 | 5 |

#### 依赖概览 (34 个)

**AI/LLM 相关：** openai、@anthropic-ai/sdk、@xenova/transformers  
**文档处理：** pdf-parse、mammoth、docx、exceljs、xlsx、jszip  
**浏览器：** playwright-core、jsdom、@mozilla/readability、turndown  
**数据库：** better-sqlite3、sqlite-vec  
**语音：** sherpa-onnx-node、msedge-tts  
**通信：** ws、@modelcontextprotocol/sdk  
**系统：** keysender、sharp、nodemailer、imap、mailparser  
**工具链：** tsx（dev 模式 TS 运行器）

---

## 4. 已修复的问题

### 4.1 TypeScript 编译错误（14 个）

在将 Gateway 从 Electron 主进程剥离后，修复了 14 个 TypeScript 编译错误：

| 错误类型 | 文件 | 修复方式 |
|----------|------|----------|
| `process.resourcesPath` 不存在 | `loader.ts`, `stt.ts`, `python-env.ts` | `(process as any).resourcesPath` |
| 可选属性赋给必选参数 | `manager.ts` ×2 | `as any` 断言 |
| 类型断言不兼容 | `openai.ts` | `as unknown as` 双重断言 |
| `headless` 属性缺失 | `bootstrap.ts` | `as any` 断言 |
| MCP Server 类型不匹配 | `standalone.ts` | `as McpServerConfig[]` |
| 联合类型未窄化 | `scheduler.ts` | 先 `as CronTrigger` 再访问 |
| `cwd` 类型不兼容 + null 流 | `opencode/index.ts` | `as string` + null 检查 |

### 4.2 运行时问题

| 问题 | 原因 | 修复 |
|------|------|------|
| Tauri 构建栈溢出 | `node_modules/**` 递归遍历过深 | 从 resources 中移除 |
| Gateway sidecar 路径找不到 | `resource_dir()` 在 dev 模式返回 `target/debug/` | 使用 `CARGO_MANIFEST_DIR` 回退 |
| ESM import 缺 `.js` 扩展名 | tsc bundler 模式不改写导入路径 | dev 模式改用 `tsx` 直接运行 TS |
| `isPackaged` 误判为 `true` | `!(process.defaultApp)` 在 Node.js 中返回 `true` | 增加 `resourcesPath` 存在性检查 |
| `path.join(undefined)` 崩溃 | `process.resourcesPath` 在 Node.js 中为 `undefined` | 由 `isPackaged` 修复间接解决 |
| Rust `log::` 宏静默 | 未配置日志后端 | 改用 `eprintln!` 输出 |

---

## 5. 构建与打包

### 5.1 开发模式

```bash
# 启动开发环境（一条命令启动全部）
pnpm tauri dev

# 流程：
# 1. Vite 启动前端开发服务器 → http://localhost:1420
# 2. Cargo 编译 Rust 后端 → openflux-rust.exe
# 3. Rust 启动后自动拉起 tsx → Gateway sidecar
# 4. Gateway 启动 WebSocket → ws://localhost:18801
# 5. 前端自动连接 Gateway
```

### 5.2 生产构建

```bash
# 完整构建（NSIS 安装包 / DMG）
pnpm tauri build

# 流程：
# 1. Vite 构建前端 → dist/
# 2. Gateway tsc 编译 → gateway/dist/
# 3. Cargo 编译 Rust（release 模式）
# 4. Tauri 打包（resources 包含 gateway/dist/** + package.json）
```

### 5.3 打包配置

```json
// tauri.conf.json
{
  "bundle": {
    "targets": ["nsis", "dmg"],
    "resources": [
      "../gateway/dist/**",
      "../gateway/package.json"
    ]
  }
}
```

---

## 6. 新旧对比总览

| 维度 | Electron 版 | Tauri 2.0 版 |
|------|-------------|--------------|
| **框架** | Electron 33 | Tauri 2.0 + Rust |
| **前端引擎** | 内嵌 Chromium | 系统 WebView2 / WKWebView |
| **后端** | Node.js（Electron 主进程） | Rust 壳 + Node.js Sidecar |
| **打包工具** | electron-builder | tauri-bundler |
| **构建工具** | electron-vite | Vite 6.4 |
| **安装包大小** | ~200MB | ~30MB（不含 node_modules） |
| **内存占用** | ~300MB | ~100MB（Rust 壳） + Gateway |
| **IPC** | Electron IPC | Tauri invoke |
| **文件数（Rust）** | 0 | 10 |
| **文件数（前端）** | ~10 | 7 |
| **文件数（Gateway）** | 0（嵌入主进程） | 84（独立模块） |
| **进程模型** | 主进程 + 渲染进程 | Rust 壳 + WebView + Node.js sidecar |
| **Windows 打包** | NSIS | NSIS |
| **macOS 打包** | DMG | DMG |
| **系统托盘** | Electron Tray | Tauri TrayIcon |
| **窗口装饰** | frameless (JS 实现) | decorations: false (原生) |

---

## 7. 配置系统迁移（`openflux.yaml`）

原版 `openflux.yaml`（441 行）是整个系统的核心配置文件，定义了 LLM 供应商、模型选择、Agent 路由、语音、记忆、权限、沙盒等所有功能配置。

> ✅ **当前状态**：已从原版完整复制 `openflux.yaml`（441 行）到 Rust 新版根目录，`workspace` 路径已更新。

### 7.1 LLM 供应商配置（`providers`）

原版支持 **8 个** LLM 供应商，每个供应商需配置 `apiKey` 和 `baseUrl`：

| 供应商 | 接口协议 | 默认 baseUrl |
|--------|----------|-------------|
| **Anthropic** | Anthropic API | `https://api.anthropic.com` |
| **OpenAI** | OpenAI API | `https://api.openai.com/v1` |
| **MiniMax** | Anthropic 兼容 | `https://api.minimaxi.com/anthropic` |
| **DeepSeek** | OpenAI 兼容 | `https://api.deepseek.com/v1` |
| **智谱 (Zhipu)** | OpenAI 兼容 | `https://open.bigmodel.cn/api/paas/v4` |
| **Moonshot (Kimi)** | OpenAI 兼容 | `https://api.moonshot.cn/v1` |
| **Google** | — | — |
| **Ollama** | OpenAI 兼容 | `http://localhost:11434/v1` |

### 7.2 LLM 分层配置（`llm`）

原版采用分层 LLM 架构，不同场景使用不同模型：

| 层级 | 用途 | 默认配置 |
|------|------|----------|
| **orchestration** | 任务规划/编排 | moonshot / kimi-k2.5 |
| **execution** | 工具调用/执行 | moonshot / kimi-k2.5 |
| **embedding** | 长期记忆向量化 | local / Xenova/bge-m3 |
| **fallback** | 主模型失败时备用 | deepseek / deepseek-chat |

嵌入模型可选项：
- `Xenova/bge-m3`（~560MB，多语言 SOTA，vectorDim: 1024）
- `Xenova/bge-small-zh-v1.5`（~24MB，中文强，vectorDim: 512）
- `Xenova/paraphrase-multilingual-MiniLM-L12-v2`（~120MB，均衡，vectorDim: 384）

### 7.3 预置模型列表（`presetModels`）

原版定义了 **50+** 个模型供 UI 下拉菜单使用，按供应商分组：

| 供应商 | 模型数 | 代表模型 |
|--------|--------|----------|
| **Anthropic** | 8 | Claude Opus 4.6, Claude Sonnet 4.5, Claude 3.5 Sonnet 等 |
| **OpenAI** | 11 | GPT-5, GPT-4.1, GPT-4o, o4 Mini, o3 等 |
| **DeepSeek** | 2 | DeepSeek Chat (V3.2), DeepSeek Reasoner (R1) |
| **MiniMax** | 6 | MiniMax-M2.5, MiniMax-M2.1, MiniMax-M1 等 |
| **Google** | 5 | Gemini 3 Flash, Gemini 2.5 Pro/Flash 等 |
| **Moonshot** | 5 | Kimi K2.5, Kimi K2 Thinking, Moonshot v1 等 |
| **智谱** | 5 | GLM-5, GLM-4.6V, GLM-4 Plus/Flash/Long |
| **Ollama** | 6 | Qwen 2.5 (72B/32B/14B), Llama 3.3, DeepSeek R1, LLaVA |

每个模型定义：`{ value, label, multimodal }`

### 7.4 其他关键配置块

| 配置块 | 用途 | 关键选项 |
|--------|------|----------|
| **memory** | 长期记忆 | `enabled`, `dbName`, `vectorDim`, 蒸馏（时间窗口/阈值） |
| **remote** | 远程访问 | `enabled`, `port: 18801`, `token` |
| **permissions** | 权限控制 | `autoApproveLevel`, `allowedDirectories`, `blockedDirectories` |
| **browser** | 浏览器 | `enabled`, `headless` |
| **opencode** | 代码工具 | `enabled`, `autoApprove` |
| **web** | 搜索+抓取 | search（Brave/Perplexity）, fetch（Readability/Firecrawl） |
| **mcp** | 外部工具 | MCP 服务器列表（name, transport, command, args） |
| **workspace** | 工作目录 | 项目根路径 |
| **voice** | 语音 | STT（sherpa-onnx）+ TTS（Edge TTS voice/rate/autoPlay） |
| **agents** | 多 Agent | router（路由）, defaults（全局默认工具/子Agent）, list（Agent 列表） |
| **sandbox** | 沙盒隔离 | mode（local/docker）, Docker 镜像/资源限制, 命令白名单, 禁止扩展名 |

### 7.5 迁移待办

- [x] 将原版 `openflux.yaml` 复制到 Rust 新版项目根目录（已完成，`workspace` 路径已更新）
- [x] 确认 Gateway `config/loader.ts` 的配置搜索路径在新目录结构下正确（Gateway 已成功加载配置启动）
- [ ] 验证 `presetModels` 在前端设置 UI 中正常渲染
- [ ] 确认所有供应商的 apiKey 环境变量替换（`${VAR}` 语法）正常工作

---

## 8. 已知限制与待优化

| 项目 | 说明 | 优先级 |
|------|------|--------|
| Rust 日志系统 | 当前使用 `eprintln!`，应集成 `env_logger` 或 `tracing` | 中 |
| Gateway 打包 | 生产环境需要 `node_modules`，当前未打包进 resources | 高 |
| ESM 扩展名 | tsc 编译产物的 import 路径不带 `.js`，prod 模式需用 loader 或切换 CJS | 高 |
| 窗口状态保存 | 关闭前保存窗口位置/大小，下次启动恢复 | 低 |
| 自动更新 | 需要集成 Tauri 更新插件 | 中 |
| dev 模式热重载 | Gateway 代码修改后需手动重启 Tauri | 低 |

---

## 9. 目录结构

```
OpenFlux-Rust/
├── src-tauri/                  # Rust 原生壳
│   ├── Cargo.toml              # Rust 依赖
│   ├── tauri.conf.json         # Tauri 配置
│   ├── icons/                  # 应用图标
│   ├── capabilities/           # Tauri 权限声明
│   └── src/
│       ├── main.rs             # 进程入口
│       ├── lib.rs              # 应用初始化 + Gateway 拉起
│       ├── config.rs           # 配置加载
│       ├── tray.rs             # 系统托盘
│       └── commands/           # Tauri commands
│           ├── gateway.rs      # Gateway 生命周期
│           ├── window.rs       # 窗口控制
│           ├── file.rs         # 文件操作
│           └── system.rs       # 系统操作
├── src/                        # 前端
│   ├── main.ts                 # 主 UI（250KB）
│   ├── gateway-client.ts       # WebSocket 客户端
│   ├── voice.ts                # 语音交互
│   ├── cosmicHole.ts           # 粒子动画
│   ├── markdown.ts             # Markdown 渲染
│   └── styles/main.css         # 样式
├── gateway/                    # Gateway Sidecar
│   ├── package.json            # Node.js 依赖
│   ├── tsconfig.json           # TypeScript 配置
│   └── src/
│       ├── agent/              # Agent 引擎
│       ├── browser/            # 浏览器自动化
│       ├── config/             # 配置系统
│       ├── core/               # 引导程序
│       ├── gateway/            # WS 服务器入口
│       ├── llm/                # LLM Provider
│       ├── scheduler/          # 定时调度
│       ├── sessions/           # 会话管理
│       ├── tools/              # 工具集（27 文件）
│       ├── utils/              # 工具函数
│       └── workflow/           # 工作流引擎
├── index.html                  # 前端入口
├── package.json                # 前端依赖
├── vite.config.ts              # Vite 配置
└── tsconfig.json               # 前端 TS 配置
```
