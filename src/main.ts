import { invoke } from '@tauri-apps/api/core';
import { open as tauriDialogOpen, save as tauriDialogSave } from '@tauri-apps/plugin-dialog';
/**
 * 渲染进程主入口- 聊天 UI
 * 瘦客户端模式：通过 WebSocket 连接 Gateway Server
 */

import { createTypingHole, destroyTypingHole, setTypingMode } from './cosmicHole';
import { GatewayClient, type ProgressEvent as GatewayProgressEvent, type ScheduledTaskView, type TaskRunView, type DebugLogEntry, type McpServerView } from './gateway-client';
import { renderMarkdown, activateMermaid } from './markdown';
import * as XLSX from 'xlsx';
import mammoth from 'mammoth';
import { recorder, player, ttsManager, streamingTtsManager, ambientSound, bargeInDetector, type RecordingState, type PlaybackState, type RecordingOptions } from './voice';
import { setVoiceSynthesizeCallback } from './voice';
import { initI18n, t, setLocale, getLocale, applyI18nToDOM, type Locale } from './i18n/index';
import { initEvolutionUI } from './evolution-ui';
import zhPack from './i18n/zh';
import enPack from './i18n/en';

// Initialize i18n (auto-detect locale from localStorage or browser)
initI18n(zhPack, enPack);

// 平台检测：为 body 添加平台标记 CSS class
const isMacOS = navigator.platform.toUpperCase().includes('MAC');
if (isMacOS) {
    document.body.classList.add('platform-macos');

    // macOS: titleBarStyle Overlay 下 -webkit-app-region: drag 不可靠
    // 禁用 CSS drag（见 main.css），改用 JS startDragging()
    import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
        const appWindow = getCurrentWindow();
        const titleBar = document.querySelector('.title-bar') as HTMLElement;
        if (titleBar) {
            titleBar.addEventListener('mousedown', (e) => {
                // 仅左键，且不在按钮/输入框等交互元素上
                if (e.button !== 0) return;
                const target = e.target as HTMLElement;
                if (target.closest('button, input, select, a, [data-no-drag]')) return;
                e.preventDefault();
                appWindow.startDragging();
            });
        }
    });
}

interface MessageAttachment {
    name: string;
    ext: string;
    size: number;
    path?: string;          // 文件路径（用于预览/打开）
    thumbnailUrl?: string;  // 图片缩略图（仅用于UI显示）
}

interface Message {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    createdAt: number;
    toolCalls?: ToolCall[];
    attachments?: MessageAttachment[];
    metadata?: Record<string, unknown>;
}

interface ToolCall {
    name: string;
    args: Record<string, unknown>;
    result?: string;
}

interface LogEntry {
    id: string;
    timestamp: number;
    tool: string;
    action?: string;
    args?: Record<string, unknown>;
    success: boolean;
    result?: unknown;
    resultSummary?: string;
}

interface Session {
    id: string;
    title: string;
    createdAt: number;
    updatedAt?: number;
    lastMessagePreview?: string;
    cloudChatroomId?: number;
    cloudAgentName?: string;
}

// ========================
// 附件类型定义
// ========================

interface PendingAttachment {
    path: string;
    name: string;
    size: number;
    ext: string;        // 小写扩展名，如.xlsx
    type: 'image' | 'document' | 'text';
    thumbnailUrl?: string;  // 图片缩略URL（通过 URL.createObjectURL 生成）
}

/** 图片扩展名集合（用于附件缩略图还原） */
const IMAGE_EXTS_SET = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);

/**
 * 将服务端返回的 SessionMessage[] 转为带附件缩略图的 Message[]
 * 图片附件会通过 fileRead 异步还原 dataUrl 缩略图 */
async function hydrateMessageAttachments(rawMessages: unknown[]): Promise<Message[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return Promise.all((rawMessages as any[]).map(async (msg) => {
        const message: Message = {
            id: msg.id,
            role: msg.role,
            content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
            createdAt: msg.createdAt,
            toolCalls: msg.toolCalls,
            metadata: msg.metadata,
        };

        if (msg.attachments?.length) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            message.attachments = await Promise.all(msg.attachments.map(async (a: any) => {
                const attachment: MessageAttachment = {
                    name: a.name,
                    ext: a.ext,
                    size: a.size,
                    path: a.path,
                };

                // 图片附件：尝试从本地文件读取 dataUrl 作为缩略图
                if (IMAGE_EXTS_SET.has(a.ext?.toLowerCase())) {
                    try {
                        const result = await invoke<any>('file_read', { filePath: a.path });
                        if (result.dataUrl) {
                            attachment.thumbnailUrl = result.dataUrl;
                        }
                    } catch { /* 文件可能已被删除，忽略 */ }
                }

                return attachment;
            }));
        }

        return message;
    }));
}

/** 支持拖拽的文件扩展名 */
const SUPPORTED_DROP_EXTS: Record<string, PendingAttachment['type']> = {
    // 图片
    '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image',
    '.webp': 'image', '.bmp': 'image', '.svg': 'image',
    // 文档
    '.xlsx': 'document', '.xls': 'document',
    '.docx': 'document',
    '.pdf': 'document',
    '.pptx': 'document',
    // 文本 & 配置
    '.txt': 'text', '.md': 'text', '.csv': 'text', '.json': 'text',
    '.xml': 'text', '.log': 'text', '.yaml': 'text', '.yml': 'text',
    '.ini': 'text', '.toml': 'text', '.cfg': 'text', '.conf': 'text',
    '.env': 'text', '.properties': 'text', '.editorconfig': 'text',
    // Web
    '.html': 'text', '.htm': 'text', '.css': 'text', '.scss': 'text',
    '.sass': 'text', '.less': 'text', '.styl': 'text',
    // JavaScript / TypeScript
    '.js': 'text', '.jsx': 'text', '.ts': 'text', '.tsx': 'text',
    '.mjs': 'text', '.cjs': 'text', '.mts': 'text', '.cts': 'text',
    '.vue': 'text', '.svelte': 'text', '.astro': 'text',
    // Python
    '.py': 'text', '.pyi': 'text', '.pyx': 'text', '.pyw': 'text',
    // Java / Kotlin / Scala
    '.java': 'text', '.kt': 'text', '.kts': 'text', '.scala': 'text', '.groovy': 'text', '.gradle': 'text',
    // C / C++ / Objective-C
    '.c': 'text', '.cpp': 'text', '.cc': 'text', '.cxx': 'text',
    '.h': 'text', '.hpp': 'text', '.hxx': 'text', '.m': 'text', '.mm': 'text',
    // C# / F#
    '.cs': 'text', '.csx': 'text', '.fs': 'text', '.fsx': 'text',
    // Rust
    '.rs': 'text',
    // Go
    '.go': 'text',
    // Swift
    '.swift': 'text',
    // Ruby
    '.rb': 'text', '.erb': 'text', '.rake': 'text',
    // PHP
    '.php': 'text', '.phtml': 'text',
    // Shell / Scripting
    '.sh': 'text', '.bash': 'text', '.zsh': 'text', '.fish': 'text',
    '.bat': 'text', '.cmd': 'text', '.ps1': 'text', '.psm1': 'text',
    // Lua / Perl / R
    '.lua': 'text', '.pl': 'text', '.pm': 'text', '.r': 'text',
    // Haskell / Elixir / Erlang / Clojure
    '.hs': 'text', '.ex': 'text', '.exs': 'text', '.erl': 'text', '.clj': 'text', '.cljs': 'text',
    // Dart / Zig / Nim / V
    '.dart': 'text', '.zig': 'text', '.nim': 'text', '.v': 'text',
    // SQL & Database
    '.sql': 'text', '.prisma': 'text',
    // Markup & Templating
    '.tex': 'text', '.latex': 'text', '.rst': 'text', '.adoc': 'text',
    '.ejs': 'text', '.hbs': 'text', '.pug': 'text', '.njk': 'text',
    '.j2': 'text', '.jinja': 'text', '.jinja2': 'text',
    // Data serialization
    '.jsonc': 'text', '.json5': 'text', '.jsonl': 'text',
    '.graphql': 'text', '.gql': 'text', '.proto': 'text',
    // DevOps & Build
    '.dockerfile': 'text', '.tf': 'text', '.hcl': 'text',
    '.cmake': 'text', '.makefile': 'text', '.mk': 'text',
    // Misc
    '.diff': 'text', '.patch': 'text', '.gitignore': 'text',
    '.eslintrc': 'text', '.prettierrc': 'text',
};

// DOM 元素
const messageInput = document.getElementById('message-input') as HTMLTextAreaElement;
const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
const messagesContainer = document.getElementById('messages') as HTMLDivElement;
const sessionList = document.getElementById('session-list') as HTMLDivElement;
const newSessionBtn = document.getElementById('new-session-btn') as HTMLButtonElement;
const statusIndicator = document.getElementById('status-indicator') as HTMLDivElement;
const confirmModal = document.getElementById('confirm-modal') as HTMLDivElement;
const confirmMessage = document.getElementById('confirm-message') as HTMLParagraphElement;
const confirmYes = document.getElementById('confirm-yes') as HTMLButtonElement;
const confirmNo = document.getElementById('confirm-no') as HTMLButtonElement;
const attachmentPreview = document.getElementById('attachment-preview') as HTMLDivElement;
const inputContainer = document.querySelector('.input-container') as HTMLDivElement;

// 新增 UI 控件
const sidebar = document.getElementById('sidebar') as HTMLElement;
const sidebarToggle = document.getElementById('sidebar-toggle') as HTMLButtonElement;
const btnMinimize = document.getElementById('btn-minimize') as HTMLButtonElement;
const btnMaximize = document.getElementById('btn-maximize') as HTMLButtonElement;
const btnClose = document.getElementById('btn-close') as HTMLButtonElement;

// 搜索相关


// 用户区和设置
const agentListLoginPrompt = document.getElementById('agent-list-login-prompt') as HTMLDivElement;
const settingsBtn = document.getElementById('settings-btn') as HTMLButtonElement;

// 设置视图（中部区域）
const settingsView = document.getElementById('settings-view') as HTMLDivElement;
const debugModeToggle = document.getElementById('debug-mode-toggle') as HTMLInputElement;

// 设置 Tab 切换
const settingsTabs = settingsView.querySelectorAll('.settings-tab') as NodeListOf<HTMLButtonElement>;
const settingsTabContents = settingsView.querySelectorAll('.settings-tab-content') as NodeListOf<HTMLDivElement>;

// 服务端设置 DOM
const serverOrchProvider = document.getElementById('server-orch-provider') as HTMLSelectElement;
const serverOrchModel = document.getElementById('server-orch-model') as HTMLSelectElement;
const serverOrchModelCustom = document.getElementById('server-orch-model-custom') as HTMLInputElement;
const serverExecProvider = document.getElementById('server-exec-provider') as HTMLSelectElement;
const serverExecModel = document.getElementById('server-exec-model') as HTMLSelectElement;
const serverExecModelCustom = document.getElementById('server-exec-model-custom') as HTMLInputElement;
const serverProviderKeysContainer = document.getElementById('server-provider-keys') as HTMLDivElement;
// Gateway section 已移除，不再需要引用
// const serverGatewayMode = document.getElementById('server-gateway-mode') as HTMLSpanElement;
// const serverGatewayPort = document.getElementById('server-gateway-port') as HTMLSpanElement;
const serverSaveBtn = document.getElementById('server-save-btn') as HTMLButtonElement;
const serverSaveHint = document.getElementById('server-save-hint') as HTMLSpanElement;
const serverEmbeddingProvider = document.getElementById('server-embedding-provider') as HTMLSelectElement | null;
const serverEmbeddingModel = document.getElementById('server-embedding-model') as HTMLInputElement | null;
const embeddingRebuildProgress = document.getElementById('embedding-rebuild-progress') as HTMLDivElement | null;
const embeddingProgressPercent = embeddingRebuildProgress?.querySelector('.embedding-progress-percent') as HTMLSpanElement | null;
const embeddingProgressBarFill = embeddingRebuildProgress?.querySelector('.embedding-progress-bar-fill') as HTMLDivElement | null;

// Web 搜索与获取 DOM
const serverWebSearchProvider = document.getElementById('server-web-search-provider') as HTMLSelectElement;
const serverWebSearchApiKey = document.getElementById('server-web-search-apikey') as HTMLInputElement;
const serverWebSearchApiKeyToggle = document.getElementById('server-web-search-apikey-toggle') as HTMLButtonElement;
const serverWebSearchMaxResults = document.getElementById('server-web-search-max-results') as HTMLInputElement;
const serverWebFetchReadability = document.getElementById('server-web-fetch-readability') as HTMLInputElement;
const serverWebFetchMaxChars = document.getElementById('server-web-fetch-max-chars') as HTMLInputElement;

// 沙盒设置 DOM
const serverSandboxMode = document.getElementById('server-sandbox-mode') as HTMLSelectElement;
const sandboxDockerFields = document.getElementById('sandbox-docker-fields') as HTMLDivElement;
const serverSandboxDockerImage = document.getElementById('server-sandbox-docker-image') as HTMLInputElement;
const serverSandboxDockerMemory = document.getElementById('server-sandbox-docker-memory') as HTMLInputElement;
const serverSandboxDockerCpu = document.getElementById('server-sandbox-docker-cpu') as HTMLInputElement;
const serverSandboxDockerNetwork = document.getElementById('server-sandbox-docker-network') as HTMLSelectElement;
const serverSandboxBlockedExt = document.getElementById('server-sandbox-blocked-ext') as HTMLInputElement;

// 沙盒模式切换 → 显示/隐藏 Docker 配置
serverSandboxMode.addEventListener('change', () => {
    sandboxDockerFields.classList.toggle('hidden', serverSandboxMode.value !== 'docker');
});

// API Key 显示/隐藏切换
serverWebSearchApiKeyToggle.addEventListener('click', () => {
    serverWebSearchApiKey.type = serverWebSearchApiKey.type === 'password' ? 'text' : 'password';
});

// 智能体设置 DOM
const agentNameInput = document.getElementById('agent-name-input') as HTMLInputElement | null;
const agentPromptInput = document.getElementById('agent-prompt-input') as HTMLTextAreaElement | null;
const agentSaveBtn = document.getElementById('agent-save-btn') as HTMLButtonElement | null;
const agentSaveHint = document.getElementById('agent-save-hint') as HTMLSpanElement | null;


// MCP Server 管理 DOM
const mcpServersList = document.getElementById('mcp-servers-list') as HTMLDivElement;
const mcpAddBtn = document.getElementById('mcp-add-btn') as HTMLButtonElement;
const mcpForm = document.getElementById('mcp-form') as HTMLDivElement;
const mcpFormTitle = document.getElementById('mcp-form-title') as HTMLDivElement;
const mcpFormName = document.getElementById('mcp-form-name') as HTMLInputElement;
const mcpFormLocation = document.getElementById('mcp-form-location') as HTMLSelectElement;
const mcpFormTransport = document.getElementById('mcp-form-transport') as HTMLSelectElement;
const mcpFormCommand = document.getElementById('mcp-form-command') as HTMLInputElement;
const mcpFormArgs = document.getElementById('mcp-form-args') as HTMLInputElement;
const mcpFormEnv = document.getElementById('mcp-form-env') as HTMLInputElement;
const mcpFormUrl = document.getElementById('mcp-form-url') as HTMLInputElement;
const mcpFormStdioFields = document.getElementById('mcp-form-stdio-fields') as HTMLDivElement;
const mcpFormSseFields = document.getElementById('mcp-form-sse-fields') as HTMLDivElement;
const mcpFormCancel = document.getElementById('mcp-form-cancel') as HTMLButtonElement;
const mcpFormSubmit = document.getElementById('mcp-form-submit') as HTMLButtonElement;

/** MCP Server 编辑状态 */
let mcpServers: McpServerView[] = [];
let mcpEditingIndex = -1; // -1 表示新增模式

// 语音相关
const micBtn = document.getElementById('mic-btn') as HTMLButtonElement;
const micIconDefault = micBtn.querySelector('.mic-icon-default') as SVGElement;
const micIconRecording = micBtn.querySelector('.mic-icon-recording') as SVGElement;
const recordingIndicator = document.getElementById('recording-indicator') as HTMLDivElement;
const recordingText = document.getElementById('recording-text') as HTMLSpanElement;
const ttsAutoplayToggle = document.getElementById('tts-autoplay-toggle') as HTMLInputElement;
const ttsVoiceSelect = document.getElementById('tts-voice-select') as HTMLSelectElement;

// 语音状态
let voiceStatus: { stt: { enabled: boolean; available: boolean }; tts: { enabled: boolean; available: boolean; voice: string; autoPlay: boolean } } | null = null;
let ttsAutoPlay = false;
let voiceModeActive = false;  // 语音对话模式是否激活
// 语音对话模式 DOM
const voiceOverlay = document.getElementById('voice-overlay') as HTMLDivElement;
const voiceModeBtn = document.getElementById('voice-mode-btn') as HTMLButtonElement;
const voiceOverlayClose = document.getElementById('voice-overlay-close') as HTMLButtonElement;
const voiceMainBtn = document.getElementById('voice-main-btn') as HTMLButtonElement;
const voiceBtnMic = voiceMainBtn.querySelector('.voice-btn-mic') as SVGElement;
const voiceBtnStop = voiceMainBtn.querySelector('.voice-btn-stop') as SVGElement;
const voiceStatusText = document.getElementById('voice-status-text') as HTMLDivElement;
const voiceTranscript = document.getElementById('voice-transcript') as HTMLDivElement;
const outputPathInput = document.getElementById('output-path-input') as HTMLInputElement;
const outputPathBrowse = document.getElementById('output-path-browse') as HTMLButtonElement;
const outputPathReset = document.getElementById('output-path-reset') as HTMLButtonElement;

// Debug 面板
const debugPanel = document.getElementById('debug-panel') as HTMLDivElement;
const debugLogContainer = document.getElementById('debug-log-container') as HTMLDivElement;
const debugClearBtn = document.getElementById('debug-clear-btn') as HTMLButtonElement;
const debugCloseBtn = document.getElementById('debug-close-btn') as HTMLButtonElement;
const debugCopyBtn = document.getElementById('debug-copy-btn') as HTMLButtonElement;
const debugResizeHandle = document.getElementById('debug-resize-handle') as HTMLDivElement;

// 调度器视图（中部区域）
const schedulerBtn = document.getElementById('scheduler-btn') as HTMLDivElement;
const schedulerView = document.getElementById('scheduler-view') as HTMLDivElement;
const schedulerListView = document.getElementById('scheduler-list-view') as HTMLDivElement;
const schedulerTasks = document.getElementById('scheduler-tasks') as HTMLDivElement;
const schedulerTasksWrapper = document.getElementById('scheduler-tasks-wrapper') as HTMLDivElement;
const schedulerRefreshBtn = document.getElementById('scheduler-refresh-btn') as HTMLButtonElement;
const schedulerInlineDetail = document.getElementById('scheduler-inline-detail') as HTMLDivElement;
const schedulerInlineActions = document.getElementById('scheduler-inline-actions') as HTMLDivElement;
const schedulerInlineRuns = document.getElementById('scheduler-inline-runs') as HTMLDivElement;

// 成果物面板
const artifactsPanel = document.getElementById('artifacts-panel') as HTMLElement;
const artifactsToggle = document.getElementById('artifacts-toggle') as HTMLButtonElement;
const artifactsList = document.getElementById('artifacts-list') as HTMLDivElement;


// 文件预览弹窗
const filePreviewModal = document.getElementById('file-preview-modal') as HTMLDivElement;
const filePreviewIcon = document.getElementById('file-preview-icon') as HTMLSpanElement;
const filePreviewName = document.getElementById('file-preview-name') as HTMLSpanElement;
const filePreviewSize = document.getElementById('file-preview-size') as HTMLSpanElement;
const filePreviewBody = document.getElementById('file-preview-body') as HTMLDivElement;
const filePreviewClose = document.getElementById('file-preview-close') as HTMLButtonElement;
const filePreviewOpen = document.getElementById('file-preview-open') as HTMLButtonElement;
const filePreviewReveal = document.getElementById('file-preview-reveal') as HTMLButtonElement;
const filePreviewCopy = document.getElementById('file-preview-copy') as HTMLButtonElement;

// 状态
let currentSessionId: string | null = null;
let currentAgentId: string | null = null; // 多 Agent 支持：当前选中的 Agent ID
let agentsList: Array<{ id: string; name: string; description?: string; icon?: string; color?: string; default?: boolean; systemPrompt?: string; createdAt: number; updatedAt: number }> = [];
const loadingSessions = new Set<string>(); // 正在加载的会话（支持多会话并发）
const chatTargetSessionIds = new Set<string>(); // 正在进行中的聊天会话集（用于进度事件隔离）
const unreadSessionIds = new Set<string>(); // 有未读消息的会话（后台收到回复时标记）
const sessionToChatroomMap = new Map<string, number>(); // sessionId → chatroomId 映射（用于未读标记定位）
let pendingConfirmation: { taskId: string; resolve: (value: boolean) => void } | null = null;
let pendingAttachments: PendingAttachment[] = [];
const sessionDrafts = new Map<string, string>(); // 按会话保存输入框草稿

/** 根据当前会话的加载状态更新发送按钮 */
/** 发送图标 SVG */
const SEND_ICON_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" /></svg>';
/** 停止图标 SVG */
const STOP_ICON_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="3" fill="currentColor" /></svg>';

function updateSendButtonState(): void {
    const currentLoading = currentSessionId ? loadingSessions.has(currentSessionId) : false;
    if (currentLoading) {
        // 任务执行中 → 显示停止按钮
        sendBtn.disabled = false;
        sendBtn.classList.add('is-stop');
        sendBtn.innerHTML = STOP_ICON_SVG;
        sendBtn.title = '停止';
    } else {
        // 空闲 → 显示发送按钮
        sendBtn.classList.remove('is-stop');
        sendBtn.innerHTML = SEND_ICON_SVG;
        sendBtn.title = '发送';
        sendBtn.disabled = false;
    }
}

// Gateway 客户端
let gatewayClient: GatewayClient | null = null;

// ========================
// 主题切换
// ========================
const themeToggle = document.getElementById('theme-toggle') as HTMLButtonElement;
const themeIconSun = themeToggle.querySelector('.theme-icon-sun') as SVGElement;
const themeIconMoon = themeToggle.querySelector('.theme-icon-moon') as SVGElement;

function applyTheme(theme: 'dark' | 'light'): void {
    if (theme === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
        themeIconSun.classList.add('hidden');
        themeIconMoon.classList.remove('hidden');
    } else {
        document.documentElement.removeAttribute('data-theme');
        themeIconSun.classList.remove('hidden');
        themeIconMoon.classList.add('hidden');
    }
    localStorage.setItem('openflux-theme', theme);
}

// 初始化主题（从 localStorage 恢复）
const savedTheme = localStorage.getItem('openflux-theme') as 'dark' | 'light' | null;
applyTheme(savedTheme || 'light');

themeToggle.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    applyTheme(current === 'light' ? 'dark' : 'light');
});

// ========================
// 首次启动设置向导
// ========================
/** 每个供应商的预置模型列表（内置 fallback，待配置加载后覆盖） */
let providerModels: Record<string, { value: string; label: string; multimodal?: boolean }[]> = {
    anthropic: [
        { value: 'claude-opus-4-6', label: `Claude Opus 4.6 (${t('model.latest')})`, multimodal: true },
        { value: 'claude-opus-4-5-20251101', label: 'Claude Opus 4.5', multimodal: true },
        { value: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5', multimodal: true },
        { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4', multimodal: true },
        { value: 'claude-opus-4-20250514', label: 'Claude Opus 4', multimodal: true },
        { value: 'claude-haiku-4-5-20251015', label: 'Claude Haiku 4.5', multimodal: true },
        { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet', multimodal: true },
        { value: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku', multimodal: true },
    ],
    openai: [
        { value: 'gpt-5', label: 'GPT-5', multimodal: true },
        { value: 'gpt-5-mini', label: 'GPT-5 Mini', multimodal: true },
        { value: 'gpt-5-nano', label: 'GPT-5 Nano', multimodal: true },
        { value: 'gpt-4.1', label: 'GPT-4.1', multimodal: true },
        { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini', multimodal: true },
        { value: 'gpt-4.1-nano', label: 'GPT-4.1 Nano', multimodal: false },
        { value: 'gpt-4o', label: 'GPT-4o', multimodal: true },
        { value: 'gpt-4o-mini', label: 'GPT-4o Mini', multimodal: true },
        { value: 'o4-mini', label: 'o4 Mini', multimodal: true },
        { value: 'o3', label: 'o3', multimodal: true },
        { value: 'o3-mini', label: 'o3 Mini', multimodal: false },
    ],
    deepseek: [
        { value: 'deepseek-chat', label: 'DeepSeek Chat (V3.2)', multimodal: false },
        { value: 'deepseek-reasoner', label: 'DeepSeek Reasoner (R1)', multimodal: false },
    ],
    minimax: [
        { value: 'MiniMax-M2.5', label: `MiniMax-M2.5 (${t('model.latest')})`, multimodal: false },
        { value: 'MiniMax-M2.5-highspeed', label: `MiniMax-M2.5 ${t('model.highspeed')}`, multimodal: false },
        { value: 'MiniMax-M2.1', label: 'MiniMax-M2.1', multimodal: false },
        { value: 'MiniMax-M2', label: 'MiniMax-M2', multimodal: false },
        { value: 'MiniMax-M1', label: `MiniMax-M1 (${t('model.reasoning')})`, multimodal: false },
        { value: 'MiniMax-Text-01', label: 'MiniMax-Text-01', multimodal: false },
    ],
    google: [
        { value: 'gemini-3-flash', label: `Gemini 3 Flash (${t('model.latest')})`, multimodal: true },
        { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', multimodal: true },
        { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', multimodal: true },
        { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', multimodal: true },
        { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', multimodal: true },
    ],
    moonshot: [
        { value: 'kimi-k2.5', label: `Kimi K2.5 (${t('model.latest')}·${t('model.multimodal')})`, multimodal: true },
        { value: 'kimi-k2-thinking', label: 'Kimi K2 Thinking', multimodal: false },
        { value: 'kimi-k2-turbo-preview', label: 'Kimi K2 Turbo Preview', multimodal: false },
        { value: 'moonshot-v1-auto', label: 'Moonshot v1 Auto', multimodal: false },
        { value: 'moonshot-v1-128k', label: 'Moonshot v1 128K', multimodal: false },
    ],
    zhipu: [
        { value: 'glm-5', label: `GLM-5 (${t('model.latest')})`, multimodal: false },
        { value: 'glm-4.6v', label: `GLM-4.6V (${t('model.vision')})`, multimodal: true },
        { value: 'glm-4-plus', label: 'GLM-4 Plus', multimodal: false },
        { value: 'glm-4-flash', label: 'GLM-4 Flash', multimodal: false },
        { value: 'glm-4-long', label: 'GLM-4 Long', multimodal: false },
    ],
    ollama: [
        { value: 'qwen2.5:72b', label: 'Qwen 2.5 72B', multimodal: false },
        { value: 'qwen2.5:32b', label: 'Qwen 2.5 32B', multimodal: false },
        { value: 'qwen2.5:14b', label: 'Qwen 2.5 14B', multimodal: false },
        { value: 'llama3.3:70b', label: 'Llama 3.3 70B', multimodal: false },
        { value: 'deepseek-r1:32b', label: 'DeepSeek R1 32B', multimodal: false },
        { value: 'llava:13b', label: 'LLaVA 13B', multimodal: true },
    ],
    custom: [],
};

/**
 * 填充模型下拉框
 */
function populateModelSelect(select: HTMLSelectElement, customInput: HTMLInputElement, provider: string, currentValue?: string): void {
    select.innerHTML = '';
    const models = providerModels[provider] || [];

    for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m.value;
        opt.textContent = m.multimodal ? `\uD83D\uDC41 ${m.label}` : m.label;
        select.appendChild(opt);
    }

    const customOpt = document.createElement('option');
    customOpt.value = '__custom__';
    customOpt.textContent = t('model.custom');
    select.appendChild(customOpt);

    if (currentValue) {
        const exists = models.some(m => m.value === currentValue);
        if (exists) {
            select.value = currentValue;
            customInput.classList.add('hidden');
            customInput.value = '';
        } else {
            select.value = '__custom__';
            customInput.classList.remove('hidden');
            customInput.value = currentValue;
        }
    } else if (models.length > 0) {
        select.value = models[0].value;
        customInput.classList.add('hidden');
    }

    select.onchange = () => {
        if (select.value === '__custom__') {
            customInput.classList.remove('hidden');
            customInput.focus();
        } else {
            customInput.classList.add('hidden');
            customInput.value = '';
        }
    };
}

/** 获取模型 select + 自定义输入框的实际值 */
function getModelSelectValue(select: HTMLSelectElement, customInput: HTMLInputElement): string {
    if (select.value === '__custom__') {
        return customInput.value.trim();
    }
    return select.value;
}

async function showSetupWizard(client: GatewayClient): Promise<void> {
    const wizard = document.getElementById('setup-wizard') as HTMLDivElement;
    const pages = wizard.querySelectorAll('.setup-page') as NodeListOf<HTMLDivElement>;
    const steps = wizard.querySelectorAll('.setup-step') as NodeListOf<HTMLDivElement>;
    const btnPrev = document.getElementById('setup-btn-prev') as HTMLButtonElement;
    const btnNext = document.getElementById('setup-btn-next') as HTMLButtonElement;
    const btnSkip = document.getElementById('setup-btn-skip') as HTMLButtonElement;

    // 表单元素
    const providerSelect = document.getElementById('setup-provider') as HTMLSelectElement;
    const modelSelect = document.getElementById('setup-model') as HTMLSelectElement;
    const modelCustomInput = document.getElementById('setup-model-custom') as HTMLInputElement;
    const apikeyInput = document.getElementById('setup-apikey') as HTMLInputElement;
    const cloudCheckbox = document.getElementById('setup-cloud-enabled') as HTMLInputElement;
    const cloudFields = document.getElementById('setup-cloud-fields') as HTMLDivElement;
    const routerCheckbox = document.getElementById('setup-router-enabled') as HTMLInputElement;
    const routerFields = document.getElementById('setup-router-fields') as HTMLDivElement;

    let currentPage = 1;
    const totalPages = 4;

    // 初始填充模型列表
    populateModelSelect(modelSelect, modelCustomInput, providerSelect.value);

    // provider 切换联动模型列表
    providerSelect.addEventListener('change', () => {
        populateModelSelect(modelSelect, modelCustomInput, providerSelect.value);
    });

    // checkbox 联动
    cloudCheckbox.addEventListener('change', () => {
        cloudFields.style.display = cloudCheckbox.checked ? '' : 'none';
    });
    routerCheckbox.addEventListener('change', () => {
        routerFields.style.display = routerCheckbox.checked ? '' : 'none';
    });

    function goToPage(page: number): void {
        pages.forEach(p => p.classList.remove('active'));
        steps.forEach(s => {
            const sn = Number(s.dataset.step);
            s.classList.remove('active', 'done');
            if (sn < page) s.classList.add('done');
            if (sn === page) s.classList.add('active');
        });
        const target = wizard.querySelector(`.setup-page[data-page="${page}"]`) as HTMLDivElement;
        if (target) target.classList.add('active');

        btnPrev.style.display = page > 1 ? '' : 'none';
        btnNext.textContent = page === totalPages ? t('setup.finish') : t('setup.next');
        currentPage = page;
    }

    // 验证当前步骤
    function validatePage(): boolean {
        if (currentPage === 2) {
            const key = apikeyInput.value.trim();
            if (!key) {
                apikeyInput.focus();
                apikeyInput.style.borderColor = 'var(--color-error)';
                setTimeout(() => { apikeyInput.style.borderColor = ''; }, 2000);
                return false;
            }
        }
        return true;
    }

    // 收集配置并提交
    async function submit(): Promise<void> {
        btnNext.disabled = true;
        btnNext.textContent = t('setup.saving');
        try {
            const config: Parameters<typeof client.setupComplete>[0] = {
                provider: providerSelect.value,
                apiKey: apikeyInput.value.trim(),
                baseUrl: (document.getElementById('setup-baseurl') as HTMLInputElement).value.trim() || undefined,
                model: getModelSelectValue(modelSelect, modelCustomInput) || undefined,
                agentName: (document.getElementById('setup-agent-name') as HTMLInputElement).value.trim() || undefined,
                agentPrompt: (document.getElementById('setup-agent-prompt') as HTMLTextAreaElement).value.trim() || undefined,
            };

            if (routerCheckbox.checked) {
                config.router = {
                    enabled: true,
                    url: (document.getElementById('setup-router-url') as HTMLInputElement).value.trim() || undefined,
                    appId: (document.getElementById('setup-router-appid') as HTMLInputElement).value.trim() || undefined,
                    appSecret: (document.getElementById('setup-router-secret') as HTMLInputElement).value.trim() || undefined,
                };
            }

            await client.setupComplete(config);
            wizard.style.display = 'none';
        } catch (err) {
            console.error('[SetupWizard] Submit failed:', err);
            btnNext.disabled = false;
            btnNext.textContent = t('setup.finish_done');
            alert(t('setup.save_failed', err instanceof Error ? err.message : String(err)));
        }
    }

    return new Promise<void>((resolve) => {
        wizard.style.display = '';

        btnNext.addEventListener('click', async () => {
            if (!validatePage()) return;
            if (currentPage < totalPages) {
                goToPage(currentPage + 1);
            } else {
                await submit();
                resolve();
            }
        });

        btnPrev.addEventListener('click', () => {
            if (currentPage > 1) goToPage(currentPage - 1);
        });

        btnSkip.addEventListener('click', () => {
            wizard.style.display = 'none';
            // 异步标记跳过，不阻塞界面
            client.request('setup.skip').catch((e: unknown) => {
                console.warn('[SetupWizard] Skip marking failed:', e);
            });
            resolve();
        });

        goToPage(1);
    });
}

// 初始化
async function init(): Promise<void> {
    try {
        setStatus(t('status.connecting'), 'running');

        // 获取 Gateway 配置
        const config = await invoke<{ url: string, token?: string }>('get_gateway_config');

        // Gateway sidecar 异步启动，首次安装需解压可能耗时较长，需重试等待
        const maxRetries = 60;
        let connected = false;
        const startTime = Date.now();
        const loadingTextEl = document.querySelector('.app-loading-text') as HTMLElement | null;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                gatewayClient = new GatewayClient(config.url, config.token);
                await gatewayClient.connect();
                connected = true;
                break;
            } catch (err) {
                console.warn(`[Init] Gateway connection attempt ${attempt}/${maxRetries} failed:`, err);
                try { gatewayClient?.disconnect(); } catch { }
                if (attempt < maxRetries) {
                    const delay = Math.min(1000 * attempt, 3000);
                    await new Promise(r => setTimeout(r, delay));
                    const elapsed = Math.round((Date.now() - startTime) / 1000);
                    const progressMsg = attempt <= 3
                        ? t('app.init_agent')
                        : attempt <= 10
                            ? t('app.loading_core', elapsed)
                            : t('app.init_service', elapsed);
                    if (loadingTextEl) loadingTextEl.textContent = progressMsg;
                    setStatus(t('app.waiting_gateway', elapsed), 'running');
                }
            }
        }
        if (!connected) {
            if (loadingTextEl) loadingTextEl.textContent = t('app.timeout');
            throw new Error(t('app.gateway_timeout'));
        }
        console.log('[Init] Gateway connected');

        // 初始化进化 UI（注入样式 + 绑定事件）
        initEvolutionUI(gatewayClient!);

        // 连接成功后注册事件监听器（此时 gatewayClient 必定不为 null）
        const gw = gatewayClient!;

        // 浏览器 CDP 连接状态自动检测
        gw.addMessageHandler((msg: any) => {
            if (msg.type === 'browser.status' && msg.payload) {
                updateBrowserStatusIndicator(msg.payload.connected);
            }
        });
        gw.request('browser.status')
            .then((s: any) => updateBrowserStatusIndicator(s?.connected))
            .catch(() => { /* ignore */ });
        // 定期轮询浏览器 CDP 状态
        setInterval(() => {
            gw.request('browser.status')
                .then((s: any) => updateBrowserStatusIndicator(s?.connected))
                .catch(() => { /* ignore */ });
        }, 15000);

        gw.onConnectionChange((status) => {
            switch (status) {
                case 'connecting':
                    setStatus(t('status.connecting'), 'running');
                    break;
                case 'connected':
                    setStatus(t('titlebar.status_ready'), 'ready');
                    checkOpenFluxLoginStatus();
                    // Sync current language to Gateway on connection
                    gw.request('language.update', { language: getLocale() }).catch(() => { });
                    break;
                case 'disconnected':
                    setStatus(t('status.disconnected'), 'error');
                    break;
                case 'reconnecting':
                    setStatus(t('status.reconnecting'), 'running');
                    break;
                case 'failed':
                    setStatus(t('status.error'), 'error');
                    break;
            }
        });

        gw.onProgress(handleGatewayProgress);

        gw.onRebuildProgress((progress) => {
            if (progress >= 100 || progress < 0) {
                if (progress >= 100) {
                    if (embeddingProgressPercent) embeddingProgressPercent.textContent = t('embed.progress_done');
                    if (embeddingProgressBarFill) embeddingProgressBarFill.style.width = '100%';
                }
                setTimeout(() => {
                    embeddingRebuildProgress?.classList.add('hidden');
                }, 3000);
            } else {
                embeddingRebuildProgress?.classList.remove('hidden');
                if (embeddingProgressPercent) embeddingProgressPercent.textContent = `${Math.round(progress)}%`;
                if (embeddingProgressBarFill) embeddingProgressBarFill.style.width = `${progress}%`;
            }
        });

        // Apply i18n translations to static DOM elements
        applyI18nToDOM();
        document.getElementById('html-root')?.setAttribute('lang', getLocale() === 'zh' ? 'zh-CN' : 'en');

        // Bind language switcher
        const localeSelect = document.getElementById('locale-select') as HTMLSelectElement | null;
        if (localeSelect) {
            localeSelect.value = getLocale();
            localeSelect.addEventListener('change', () => {
                setLocale(localeSelect.value as Locale);
                document.getElementById('html-root')?.setAttribute('lang', localeSelect.value === 'zh' ? 'zh-CN' : 'en');
                // Sync language to Gateway so LLM responds in the correct language
                if (gatewayClient) {
                    gatewayClient.request('language.update', { language: localeSelect.value }).catch(() => { });
                }
            });
        }

        // 隐藏启动 loading 遮罩层
        const loadingOverlay = document.getElementById('app-loading-overlay');
        if (loadingOverlay) {
            loadingOverlay.classList.add('fade-out');
            setTimeout(() => loadingOverlay.classList.add('hidden'), 600);
        }

        // 注入 Voice TTS 合成回调（通过 Gateway WebSocket 调用）
        setVoiceSynthesizeCallback(async (text: string) => {
            if (!gatewayClient) return { error: t('app.gateway_not_connected') };
            try {
                const res = await gatewayClient.request<{ audio?: string; error?: string }>('voice.synthesize', { text });
                if (res.error) return { error: res.error };
                if (res.audio) {
                    const binary = atob(res.audio);
                    const bytes = new Uint8Array(binary.length);
                    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                    return { audio: bytes.buffer };
                }
                return { error: t('app.no_audio_received') };
            } catch (err: any) {
                return { error: err.message || t('app.tts_request_failed') };
            }
        });

        // 首次启动设置向导
        if (gw.isSetupRequired()) {
            console.log('[Init] First-time setup needed, showing wizard');
            await showSetupWizard(gw);
        }

        // 监听 Atlas 认证过期 → 保存失败请求上下文 + 弹出登录框
        gw.onAuthExpired((message) => {
            console.warn('[Atlas] Auth expired:', message);
            // 保存当前正在加载的会话的最后一条用户消息，登录成功后自动重发
            if (currentSessionId && loadingSessions.has(currentSessionId)) {
                // 找到最后一条用户消息的内容
                const allMsgEls = messagesContainer.querySelectorAll('.message.user .message-text');
                const lastUserMsg = allMsgEls.length > 0 ? allMsgEls[allMsgEls.length - 1] : null;
                const lastContent = lastUserMsg?.textContent?.trim();
                if (lastContent) {
                    pendingAuthRetry = {
                        content: lastContent,
                        sessionId: currentSessionId,
                    };
                    console.log('[Atlas] Saved pending retry:', pendingAuthRetry.content.slice(0, 50));
                }
            }
            showLoginModalForAtlas();
        });

        // 监听调度器事件（自动刷新视图 + Toast 通知）
        gw.onSchedulerEvent((event) => {
            if (schedulerViewActive) {
                loadSchedulerData();
                // 如果在详情视图，也刷新执行记录
                if (selectedTaskId) {
                    renderInlineDetail(selectedTaskId);
                    loadTaskRuns(selectedTaskId);
                }
            }
            // Toast 通知
            if (event.type === 'run_complete') {
                showSchedulerToast('✅', event.taskName || '定时任务', '执行完成', event.taskId);
            } else if (event.type === 'run_failed') {
                showSchedulerToast('❌', event.taskName || '定时任务', event.error || '执行失败', event.taskId);
            }
        });

        // 监听会话更新事件（定时任务执行完成后刷新）
        gw.onSessionUpdated(async (sessionId: string) => {
            // 刷新左侧会话列表（可能有新消息）
            await loadLocalAgents();
            // 如果当前正在查看该会话，刷新消息和日志
            if (currentSessionId === sessionId && gatewayClient) {
                try {
                    const [messages, logs] = await Promise.all([
                        gatewayClient.getMessages(sessionId),
                        gatewayClient.getLogs(sessionId),
                    ]);
                    renderMessagesWithLogs(messages as Message[], logs as LogEntry[]);
                } catch (e) {
                    console.error('[SessionUpdated] Refresh messages failed:', e);
                }
            }
        });

        // 监听协作完成事件（Agent 间协作结果通知）
        gw.onCollaborationResult((event) => {
            console.log('[Collaboration] Result received:', event);
            const statusEmoji = event.status === 'completed' || event.status === 'idle' ? '✅' : event.status === 'timeout' ? '⏱️' : '❌';
            const statusText = event.status === 'completed' || event.status === 'idle' ? 'completed' : event.status;
            const durationText = event.duration ? `${(event.duration / 1000).toFixed(1)}s` : '';

            // Toast 通知
            showSchedulerToast(statusEmoji, `Agent: ${event.agentId}`, `${statusText} ${durationText}`.trim());

            // 在当前聊天区域插入协作结果卡片
            const chatMessages = document.getElementById('chat-messages');
            if (chatMessages) {
                const card = document.createElement('div');
                card.className = `collab-card collab-${event.status === 'completed' || event.status === 'idle' ? 'completed' : event.status}`;
                const outputPreview = event.output ? event.output.slice(0, 300) + (event.output.length > 300 ? '...' : '') : '';
                card.innerHTML = `
                    <div class="collab-card-header">
                        <span class="collab-status-icon">${statusEmoji}</span>
                        <span class="collab-agent-name">${event.agentId}</span>
                        <span class="collab-agent-type">${event.agentType}</span>
                        <span class="collab-duration">${durationText}</span>
                    </div>
                    <div class="collab-card-task">${event.task.length > 100 ? event.task.slice(0, 97) + '...' : event.task}</div>
                    ${outputPreview ? `<div class="collab-card-output">${outputPreview.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>` : ''}
                    ${event.error ? `<div class="collab-card-error">${event.error}</div>` : ''}
                    ${event.mode === 'session' ? '<div class="collab-card-session-tag">🔄 Persistent Session</div>' : ''}
                `;
                chatMessages.appendChild(card);
                chatMessages.scrollTop = chatMessages.scrollHeight;
            }
        });

        // 初始化 Router 事件监听和配置
        initRouterListeners();
        await loadRouterConfig();
        // 初始化微信 iLink 事件监听
        initWeixinListeners();

        await loadLocalAgents();
        setStatus(t('titlebar.status_ready'), 'ready');
    } catch (error) {
        console.error('[Init] Gateway connection failed:', error);
        setStatus(t('status.error'), 'error');
    }
}

// 加载会话列表
async function loadSessions(): Promise<void> {
    if (!gatewayClient) {
        console.log('[loadSessions] gatewayClient is null');
        return;
    }
    try {
        console.log('[loadSessions] Loading sessions...');
        const sessions = await gatewayClient.getSessions();
        console.log('[loadSessions] Sessions received', sessions);
        renderSessions(sessions as Session[]);
    } catch (error) {
        console.error('[loadSessions] Load failed:', error);
    }
}

// 渲染会话列表
function renderSessions(sessions: Session[]): void {
    if (sessions.length === 0) {
        sessionList.innerHTML = '<div class="empty-state" style="display:flex;align-items:center;justify-content:center;height:100%;color:rgba(255,255,255,0.35);font-size:0.85rem;">' + t('misc.no_sessions') + '</div>';
        return;
    }

    // Router 固定会话项（如果已连接，始终置顶，结构与普通会话一致）
    const routerBadge = `<span class="session-cloud-badge" style="color:#22c55e;"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M16 3h-2v2h2V3zm-4 0H8v2h4V3zM6 3H4v2h2V3zm14 4h-2v2h2V7zm0 4h-2v2h2v-2zm0 4h-2v2h2v-2zM4 7H2v2h2V7zm0 4H2v2h2v-2zm0 4H2v2h2v-2zm14 4h-2v2h2v-2zm-4 0H8v2h4v-2zm-8 0H4v2h2v-2z"/></svg></span>`;
    const routerItemHtml = routerEnabled ? `
        <div class="session-item${isRouterSession ? ' active' : ''} router-session-item"
             data-session-id="__router__">
            <div class="session-item-content">
                <div class="session-title" title="${t('app.router_channel')}">${routerBadge}${t('app.router_messages')}</div>
                <div class="session-time"></div>
            </div>
        </div>
    ` : '';

    sessionList.innerHTML = routerItemHtml + sessions
        .filter(s => s.title !== t('app.router_messages'))
        .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
        .map(session => {
            const cloudBadge = session.cloudChatroomId
                ? `<span class="session-cloud-badge"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19.35 10.04A7.49 7.49 0 0012 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 000 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z"/></svg></span>`
                : '';
            const titleText = escapeHtml(session.title || t('app.new_session'));
            const tooltipText = session.cloudChatroomId
                ? `Cloud Agent: ${escapeHtml(session.cloudAgentName || '')} - ${titleText}`
                : titleText;
            return `
            <div class="session-item${session.id === currentSessionId ? ' active' : ''}" 
                 data-session-id="${session.id}"
                 data-cloud-chatroom-id="${session.cloudChatroomId || ''}">
                <div class="session-item-content">
                    <div class="session-title" title="${tooltipText}">${cloudBadge}${titleText}</div>
                    <div class="session-time">${formatTime(session.createdAt)}</div>
                    ${unreadSessionIds.has(session.id) ? '<span class="unread-badge"></span>' : ''}
                </div>
                <button class="session-menu-btn" title="${t('app.more_actions')}">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                        <circle cx="12" cy="5" r="2"/>
                        <circle cx="12" cy="12" r="2"/>
                        <circle cx="12" cy="19" r="2"/>
                    </svg>
                </button>
                <div class="session-menu-dropdown hidden">
                    <div class="session-menu-item session-menu-delete" title="${t('misc.delete_session')}">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
                        </svg>
                    </div>
                </div>
            </div>
        `;
        }).join('');

    // 绑定点击事件
    sessionList.querySelectorAll('.session-item:not(.router-session-item)').forEach(item => {
        const el = item as HTMLElement;
        const sessionId = el.dataset.sessionId!;

        // 点击会话内容区域切换会话
        el.querySelector('.session-item-content')?.addEventListener('click', () => {
            selectSession(sessionId);
        });

        // 三点菜单按钮
        const menuBtn = el.querySelector('.session-menu-btn') as HTMLButtonElement;
        const dropdown = el.querySelector('.session-menu-dropdown') as HTMLDivElement;

        // 鼠标移入三点按钮时显示菜单
        menuBtn.addEventListener('mouseenter', () => {
            sessionList.querySelectorAll('.session-menu-dropdown').forEach(d => d.classList.add('hidden'));
            dropdown.classList.remove('hidden');
        });

        // 鼠标离开会话项时关闭菜单
        el.addEventListener('mouseleave', () => {
            dropdown.classList.add('hidden');
        });

        // 删除按钮
        el.querySelector('.session-menu-delete')?.addEventListener('click', async (e) => {
            (e as Event).stopPropagation();
            dropdown.classList.add('hidden');
            if (!confirm(t('app.confirm_delete_session'))) return;
            try {
                if (gatewayClient) {
                    await gatewayClient.deleteSession(sessionId);
                    if (currentSessionId === sessionId) {
                        currentSessionId = null;
                        currentCloudChatroomId = null;
                        messagesContainer.innerHTML = '';
                    }
                    await loadLocalAgents();
                }
            } catch (err) {
                console.error('Delete session failed:', err);
            }
        });
    });

    // 绑定 Router 会话点击事件
    const routerEl = sessionList.querySelector('.router-session-item') as HTMLElement | null;
    if (routerEl) {
        routerEl.addEventListener('click', () => {
            switchToRouterSession();
        });
    }

    // 点击其他区域关闭菜单
    document.addEventListener('click', () => {
        sessionList.querySelectorAll('.session-menu-dropdown').forEach(d => d.classList.add('hidden'));
    }, { once: true });
}

// 选择会话
async function selectSession(sessionId: string): Promise<void> {
    console.log('[selectSession] Called, sessionId:', sessionId, 'current:', currentSessionId);

    // 如果调度器视图激活，先切回聊天
    if (schedulerViewActive) {
        schedulerViewActive = false;
        messagesContainer.classList.remove('hidden');
        (document.querySelector('.input-area') as HTMLElement).classList.remove('hidden');
        schedulerView.classList.add('hidden');
        schedulerBtn.classList.remove('active');
        selectedTaskId = null;
        stopCountdownTimer();
    }

    // 如果设置视图激活，先切回聊天
    closeSettingsView();

    // 如果是当前会话，只更新侧边栏状态，不重新加载消息
    const isSameSession = sessionId === currentSessionId;
    const previousSessionId = currentSessionId; // 保存旧会话ID，用于进度状态缓存

    // 切换会话前：保存当前输入框草稿
    if (!isSameSession && currentSessionId) {
        const draft = messageInput.value.trim();
        if (draft) {
            sessionDrafts.set(currentSessionId, messageInput.value);
        } else {
            sessionDrafts.delete(currentSessionId);
        }
    }

    currentSessionId = sessionId;
    // ?session item ?data 属性恢复云端状态
    const activeItem = sessionList.querySelector(`.session-item[data-session-id="${sessionId}"]`) as HTMLElement;
    const cloudId = activeItem?.dataset.cloudChatroomId;
    currentCloudChatroomId = cloudId ? Number(cloudId) : null;
    isRouterSession = false;
    // 填充 sessionId → chatroomId 映射
    if (currentCloudChatroomId && sessionId) {
        sessionToChatroomMap.set(sessionId, currentCloudChatroomId);
    }
    // 隐藏 Router 绑定 UI，恢复输入区
    document.body.classList.remove('router-active');
    hideRouterBindUI();
    (document.querySelector('.input-area') as HTMLElement).classList.remove('hidden');
    updateInputForCloudSession();

    // 更新侧边栏选中状态
    sessionList.querySelectorAll('.session-item').forEach(item => {
        item.classList.toggle('active', (item as HTMLElement).dataset.sessionId === sessionId);
    });
    // 清除该会话的未读标记
    unreadSessionIds.delete(sessionId);
    const targetItem = sessionList.querySelector(`.session-item[data-session-id="${sessionId}"]`);
    targetItem?.querySelector('.unread-badge')?.remove();

    // 只有切换到不同会话时才加载消息和日志
    if (!isSameSession && gatewayClient) {
        // 恢复目标会话的输入草稿
        messageInput.value = sessionDrafts.get(sessionId) || '';
        autoResize();
        // 更新发送按钮状态（目标会话可能正在加载）
        updateSendButtonState();

        // 保存离开会话的进度状态到缓存
        if (previousSessionId && currentProgressCard && !isProgressFinished) {
            sessionProgressCache.set(previousSessionId, {
                items: [...progressItems],
                title: currentProgressCard.querySelector('.progress-card-title')?.textContent || t('app.running'),
            });
        }

        // 重置实时进度状态
        currentProgressCard = null;
        progressItems = [];
        // 如果目标会话仍在加载，保持 isProgressFinished = false
        // 这样实时 progress 事件到达时会复用进度卡片而不是创建新的
        isProgressFinished = !loadingSessions.has(sessionId);

        try {
            console.log('[selectSession] Loading messages, logs and artifacts sessionId:', sessionId);
            const [messages, logs, savedArtifacts] = await Promise.all([
                gatewayClient.getMessages(sessionId),
                gatewayClient.getLogs(sessionId),
                gatewayClient.getArtifacts(sessionId),
            ]);
            console.log('[selectSession] Messages:', (messages as Message[]).length, ', logs:', (logs as LogEntry[]).length, ', artifacts:', savedArtifacts.length);

            // 云端会话回退：本地消息为空时，从 NexusAI 云端加载历史
            let finalMessages = messages;
            if ((messages as Message[]).length === 0 && currentCloudChatroomId && gatewayClient) {
                console.log('[selectSession] Local messages empty for cloud session, loading from cloud API...');
                try {
                    const cloudMessages = await gatewayClient.openfluxChatHistory(currentCloudChatroomId);
                    if (cloudMessages && cloudMessages.length > 0) {
                        console.log('[selectSession] Loaded', cloudMessages.length, 'messages from cloud');
                        // 转换云端消息格式为本地格式
                        finalMessages = cloudMessages.map((cm: any, idx: number) => ({
                            id: `cloud-${Date.now()}-${idx}`,
                            role: cm.role,
                            content: cm.content,
                            createdAt: cm.createdAt || Date.now(),
                        }));
                    }
                } catch (cloudErr) {
                    console.warn('[selectSession] Failed to load cloud history:', cloudErr);
                }
            }

            // 还原附件信息（图片缩略图异步加载）
            const hydratedMessages = await hydrateMessageAttachments(finalMessages);
            renderMessagesWithLogs(hydratedMessages, logs as LogEntry[]);

            // ═══ 恢复进度卡片：如果目标会话有缓存的进度状态，重建卡片 ═══
            const cachedProgress = sessionProgressCache.get(sessionId);
            if (cachedProgress && loadingSessions.has(sessionId)) {
                for (const item of cachedProgress.items) {
                    addProgressToChat(item.icon, item.text, item.isThinking, item.detail);
                }
                if (currentProgressCard) {
                    const titleEl = (currentProgressCard as HTMLElement).querySelector('.progress-card-title') as HTMLElement;
                    if (titleEl) titleEl.textContent = cachedProgress.title;
                }
                sessionProgressCache.delete(sessionId);
            }

            // 恢复成果物（不再持久化，因为已经在服务端）
            clearArtifacts();
            if (savedArtifacts.length > 0) {
                const sorted = [...savedArtifacts].sort((a: any, b: any) => (b.timestamp || 0) - (a.timestamp || 0));
                for (const a of sorted) {
                    await addArtifact(a as Artifact, false);
                }
            }
        } catch (error) {
            console.error('Failed to load session data:', error);
        }
    }
    // 聚焦输入框
    if (!isRouterSession) messageInput.focus();
}

// 标记会话有未读消息（在侧边栏显示红点）
function markSessionUnread(sessionId: string): void {
    unreadSessionIds.add(sessionId);
    console.log('[markSessionUnread] sessionId:', sessionId, 'chatroomMap:', sessionToChatroomMap.get(sessionId));

    // 尝试1: 通过 data-session-id 查找 session-item
    let target = sessionList.querySelector(`.session-item[data-session-id="${sessionId}"]`) as HTMLElement | null;

    // 尝试2: 通过 chatroomId 查找 cloud-agent-card 或 session-item
    if (!target) {
        const chatroomId = sessionToChatroomMap.get(sessionId);
        if (chatroomId) {
            target = sessionList.querySelector(
                `.cloud-agent-card[data-cloud-chatroom-id="${chatroomId}"], .session-item[data-cloud-chatroom-id="${chatroomId}"]`
            ) as HTMLElement | null;
        }
    }

    // 尝试3: 通过 agentId 查找 local-agent-card（sessionId 格式: user-agent:<agentId>）
    if (!target && sessionId.startsWith('user-agent:')) {
        const agentId = sessionId.slice('user-agent:'.length);
        target = sessionList.querySelector(`.local-agent-card[data-agent-id="${agentId}"]`) as HTMLElement | null;
    }

    console.log('[markSessionUnread] target element:', target?.className);

    if (target && !target.querySelector('.unread-badge')) {
        const badge = document.createElement('span');
        badge.className = 'unread-badge';
        target.appendChild(badge);
        console.log('[markSessionUnread] badge added to:', target.className);
    }
}

// 新建会话（完整版：清空 + 刷新侧边栏，用于用户主动点击"新建"）
async function createSession(): Promise<void> {
    if (!gatewayClient) return;
    try {
        const session = await gatewayClient.createSession();
        currentSessionId = session.id;
        currentCloudChatroomId = null;
        // 退出 Router 会话状态
        isRouterSession = false;
        document.body.classList.remove('router-active');
        hideRouterBindUI();
        (document.querySelector('.input-area') as HTMLElement).classList.remove('hidden');
        await loadLocalAgents();
        clearMessages();
        clearLogs();
        messageInput.value = '';
        autoResize();
        messageInput.focus();
    } catch (error) {
        console.error('Failed to create session:', error);
    }
}

// 静默创建会话（不清屏，用于发消息时自动创建）
async function createSessionSilent(): Promise<void> {
    if (!gatewayClient) return;
    try {
        const session = await gatewayClient.createSession();
        currentSessionId = session.id;
        // 只刷新侧边栏，不清空消息区和日志
        await loadLocalAgents();
    } catch (error) {
        console.error('Failed to create session:', error);
    }
}

// 渲染消息列表（纯消息，不含进度卡片）
function renderMessages(messages: Message[]): void {
    if (messages.length === 0) {
        messagesContainer.innerHTML = `
            <div class="welcome-message">
                <div class="welcome-icon"><img src="./icon.png" alt="OpenFlux" /></div>
                <h3>${t('chat.welcome_title')}</h3>
                <p>${t('chat.welcome_desc')}</p>
            </div>
        `;
        return;
    }

    messagesContainer.innerHTML = messages.map(renderMessage).join('');
    activateMermaid(messagesContainer);
    scrollToBottom();
}

// 渲染消息列表 + 根据工具日志时间线插入历史进度卡片
function renderMessagesWithLogs(messages: Message[], logs: LogEntry[]): void {
    if (messages.length === 0 && logs.length === 0) {
        messagesContainer.innerHTML = `
            <div class="welcome-message">
                <div class="welcome-icon"><img src="./icon.png" alt="OpenFlux" /></div>
                <h3>${t('chat.welcome_title')}</h3>
                <p>${t('chat.welcome_desc')}</p>
            </div>
        `;
        return;
    }

    const sortedLogs = [...logs].sort((a, b) => a.timestamp - b.timestamp);
    let html = '';

    // 如果会话仍在加载，找到最后一条助手消息的时间戳，跳过其后的日志（因为这些步骤的实时进度仍在推送）
    const isSessionLoading = currentSessionId ? loadingSessions.has(currentSessionId) : false;
    let lastAssistantTs = 0;
    if (isSessionLoading) {
        for (const msg of messages) {
            if (msg.role === 'assistant') {
                lastAssistantTs = msg.createdAt;
            }
        }
    }

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        html += renderMessage(msg);

        // 在当前消息和下一条消息之间，插入该时间段内的工具日志进度卡片
        const currentTs = msg.createdAt;
        const nextTs = (i + 1 < messages.length) ? messages[i + 1].createdAt : Infinity;

        // 如果会话仍在加载，跳过最后一条助手消息之后的日志（实时进度会来接管）
        if (isSessionLoading && currentTs >= lastAssistantTs && nextTs === Infinity) {
            continue;
        }

        const logsInGap = sortedLogs.filter(
            log => log.timestamp > currentTs && log.timestamp < nextTs
        );

        if (logsInGap.length > 0) {
            html += renderHistoricalProgressCard(logsInGap);
        }
    }

    messagesContainer.innerHTML = html;

    // 绑定历史进度卡片的折叠/展开事件
    messagesContainer.querySelectorAll('.progress-card.historical .progress-card-header').forEach(header => {
        header.addEventListener('click', () => {
            const card = header.closest('.progress-card') as HTMLElement;
            if (!card) return;
            card.classList.toggle('collapsed');
            const toggle = card.querySelector('.progress-card-toggle') as HTMLElement;
            if (toggle) toggle.textContent = card.classList.contains('collapsed') ? '▾' : ' ▸';
        });
    });

    activateMermaid(messagesContainer);
    scrollToBottom();
}

// 根据工具日志生成历史进度卡片 HTML
function renderHistoricalProgressCard(logs: LogEntry[]): string {
    const items = logs.map(log => {
        const logInfo = getToolLog(log.tool, log.args);
        // 历史日志：优先用 resultSummary，否则从 success 推断
        const detail = log.resultSummary || '';
        return `<div class="progress-item">
            <span class="progress-icon">${logInfo.icon}</span>
            <span class="progress-text">${escapeHtml(logInfo.text)}</span>
            <span class="progress-detail">${escapeHtml(detail)}</span>
        </div>`;
    }).join('');

    return `
        <div class="progress-card collapsed historical">
            <div class="progress-card-header">
                <span class="progress-card-icon">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="20 6 9 17 4 12"/>
                    </svg>
                </span>
                <span class="progress-card-title">${t('app.completed')} (${logs.length} ${t('app.steps')})</span>
                <span class="progress-card-count">${logs.length}</span>
                <span class="progress-card-toggle">▾</span>
            </div>
            <div class="progress-card-body">${items}</div>
        </div>
    `;
}

// 渲染单条消息
function renderMessage(message: Message): string {
    // 跳过内部 system 消息（给 LLM 的上下文提示，不应显示给用户）
    if ((message.role as string) === 'system' && message.content?.startsWith('[Tool context]')) {
        return '';
    }
    const timeStr = formatTime(message.createdAt);

    let toolCallsHtml = '';
    if (message.toolCalls && message.toolCalls.length > 0) {
        toolCallsHtml = message.toolCalls.map(tc => `
            <div class="tool-call">
                <div class="tool-call-header">?${escapeHtml(tc.name)}</div>
                ${tc.result ? `<div class="tool-call-result">${escapeHtml(tc.result.slice(0, 200))}</div>` : ''}
            </div>
        `).join('');
    }

    // 附件卡片（在文字上方）
    let attachmentsHtml = '';
    if (message.attachments && message.attachments.length > 0) {
        attachmentsHtml = `<div class="msg-attachments">${message.attachments.map(a => {
            const iconHtml = a.thumbnailUrl
                ? `<img class="msg-attach-thumb" src="${a.thumbnailUrl}" alt="${escapeHtml(a.name)}" />`
                : `<div class="msg-attach-icon ${getAttachmentIconClass(a.ext)}">${getAttachmentIconLabel(a.ext)}</div>`;
            return `
                    <div class="msg-attach-item" title="${escapeHtml(a.name)}"${a.path ? ` data-path="${escapeHtml(a.path)}" style="cursor:pointer"` : ''}>
                        ${iconHtml}
                        <div class="msg-attach-info">
                            <span class="msg-attach-name">${escapeHtml(a.name)}</span>
                            <span class="msg-attach-size">${formatAttachmentSize(a.size)}</span>
                        </div>
                    </div>`;
        }).join('')
            }</div>`;
    }

    // 清理内部系统提示（不应显示给用户）
    let displayContent = message.content;
    if (message.role === 'assistant') {
        displayContent = displayContent.replace(/\[Tool context\][^\n]*/g, '').trim();
    }

    // assistant 消息使用 Markdown 渲染，user 消息保持纯文本
    const contentHtml = message.role === 'assistant'
        ? renderMarkdown(displayContent)
        : escapeHtml(displayContent).replace(/\n/g, '<br>');

    // 有内容才显示文字区
    const textHtml = message.content.trim()
        ? `<div class="markdown-body">${contentHtml}</div>`
        : '';

    // 助手消息：添加 TTS 播放按钮
    const ttsButtonHtml = message.role === 'assistant' && message.content.trim()
        ? `<button class="tts-play-btn" data-msg-id="${message.id}" title="${t('chat.tts_read')}">
               <svg class="tts-icon-play" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
               <svg class="tts-icon-pause hidden" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
               <svg class="tts-icon-loading hidden" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
           </button>`
        : '';

    // Router 消息标签（显示平台来源）
    const routerLabelHtml = (message.role === 'user' && message.metadata?.source === 'router' && message.metadata?.label)
        ? `<div class="router-msg-label">${escapeHtml(String(message.metadata.label))}</div>`
        : '';

    return `
        <div class="message ${message.role}" data-message-id="${message.id}">
            ${routerLabelHtml}
            <div class="message-bubble">
                ${attachmentsHtml}
                ${textHtml}
                ${toolCallsHtml}
            </div>
            <div class="message-time">${timeStr}${ttsButtonHtml}</div>
        </div>
    `;
}

// 添加消息到 UI
function addMessage(message: Message): void {
    // 移除欢迎消息
    const welcome = messagesContainer.querySelector('.welcome-message');
    if (welcome) welcome.remove();

    const messageHtml = renderMessage(message);
    messagesContainer.insertAdjacentHTML('beforeend', messageHtml);
    scrollToBottom();
}

// 显示加载动画 - 三点跳动效果（新迭代时重置为跳动点）
function showTyping(): void {
    const existingIndicator = document.getElementById('typing-indicator');
    if (existingIndicator) {
        // 重置为跳动点（清除之前的意图文本）
        existingIndicator.innerHTML = `
            <div class="typing-dots">
                <span></span><span></span><span></span>
            </div>`;
        // 确保位于进度卡片之前（切换会话回来后可能位置错误）
        ensureTypingPosition(existingIndicator);
        scrollToBottom();
        return;
    }

    // 创建容器
    const container = document.createElement('div');
    container.className = 'typing-container';
    container.id = 'typing-indicator';

    // 三个跳动的点
    const dots = document.createElement('div');
    dots.className = 'typing-dots';
    dots.innerHTML = '<span></span><span></span><span></span>';
    container.appendChild(dots);

    // 如果已存在进度卡片，插入到进度卡片之前；否则放到末尾
    if (currentProgressCard && currentProgressCard.parentElement === messagesContainer) {
        messagesContainer.insertBefore(container, currentProgressCard);
    } else {
        messagesContainer.appendChild(container);
    }
    scrollToBottom();
}

// 确保 typing 指示器在进度卡片之前
function ensureTypingPosition(typingEl: HTMLElement): void {
    if (currentProgressCard && currentProgressCard.parentElement === messagesContainer) {
        // typing 应在进度卡片之前
        const typingIdx = Array.from(messagesContainer.children).indexOf(typingEl);
        const cardIdx = Array.from(messagesContainer.children).indexOf(currentProgressCard);
        if (typingIdx > cardIdx) {
            messagesContainer.insertBefore(typingEl, currentProgressCard);
        }
    }
}

// 更新 typing 指示器：显示 LLM 意图/思考文本
function updateTypingText(text: string): void {
    // 过滤掉纯工具名（如 "process", "filesystem"），只显示有意义的描述
    const toolNames = ['process', 'filesystem', 'office', 'spawn', 'web_search', 'web_fetch', 'notify_user'];
    const trimmed = text.trim();
    if (!trimmed || toolNames.includes(trimmed) || /^[a-z_,\s]+$/.test(trimmed)) {
        return; // 不是有意义的文本，保持跳动点
    }

    let container = document.getElementById('typing-indicator');
    if (!container) {
        showTyping();
        container = document.getElementById('typing-indicator');
        if (!container) return;
    }

    // 截取前 120 字符，保持简洁
    const displayText = trimmed.length > 120 ? trimmed.slice(0, 120) + '...' : trimmed;

    // 替换内容为意图文本 + 跳动点
    container.innerHTML = `
        <div class="typing-intent">
            <span class="typing-intent-text">${escapeHtml(displayText)}</span>
            <span class="typing-intent-dots"><span></span><span></span><span></span></span>
        </div>`;
    // 确保位于进度卡片之前
    ensureTypingPosition(container);
    scrollToBottom();
}

// 流式消息管理
let streamingMessageEl: HTMLElement | null = null;
let streamingContent = '';
let streamingRenderScheduled = false;
let streamingMsgId = '';  // 流式消息 ID（用于流式 TTS 和最终 DOM 绑定）
// 创建流式消息DOM
function createStreamingMessage(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'message assistant streaming';
    container.id = 'streaming-message';

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';

    const content = document.createElement('div');
    content.className = 'markdown-body';

    bubble.appendChild(content);
    container.appendChild(bubble);

    return container;
}

// 执行流式 Markdown 渲染（节流：每帧最多渲染一次）
function renderStreamingMarkdown(): void {
    if (!streamingMessageEl) return;

    const contentEl = streamingMessageEl.querySelector('.markdown-body');
    if (!contentEl) return;

    // 渲染 Markdown
    contentEl.innerHTML = renderMarkdown(streamingContent);

    // 在最后一个文本元素末尾插入流式光标
    const cursor = document.createElement('span');
    cursor.className = 'streaming-cursor';

    // 查找最后一个可以放置光标的行内文本容器
    const candidates = contentEl.querySelectorAll(
        'p, li, h1, h2, h3, h4, h5, h6, td, th, dd, dt, summary'
    );

    if (candidates.length > 0) {
        candidates[candidates.length - 1].appendChild(cursor);
    } else if (contentEl.lastElementChild) {
        // 如果没有段落类元素（如纯代码块），追加到最后一个子元素
        contentEl.lastElementChild.appendChild(cursor);
    } else {
        contentEl.appendChild(cursor);
    }

    scrollToBottom();
}

// 追加 token 到流式消息
function appendStreamingToken(token: string): void {
    if (!streamingMessageEl) {
        // 第一个 token，创建流式消息 DOM
        streamingMessageEl = createStreamingMessage();
        messagesContainer.appendChild(streamingMessageEl);

        // 生成流式消息 ID 并启动流式 TTS
        streamingMsgId = `streaming-${Date.now()}`;
        if (ttsAutoPlay || voiceModeActive) {
            streamingTtsManager.startStreaming(streamingMsgId);
        }
    }

    streamingContent += token;

    // 喂 token 给流式 TTS（逐句切分 + 流水线合成播放）
    if (ttsAutoPlay || voiceModeActive) {
        streamingTtsManager.feedToken(token);
    }

    // 使用 requestAnimationFrame 节流，每帧最多渲染一次 Markdown
    if (!streamingRenderScheduled) {
        streamingRenderScheduled = true;
        requestAnimationFrame(() => {
            if (streamingRenderScheduled) {
                renderStreamingMarkdown();
            }
            streamingRenderScheduled = false;
        });
    }
}

// 完成流式消息
function finishStreamingMessage(): string {
    const content = streamingContent;

    // 取消待执行的渲染
    streamingRenderScheduled = false;

    if (streamingMessageEl) {
        // 如果没有内容，移除整个消息元素
        if (!content.trim()) {
            streamingMessageEl.remove();
            streamingTtsManager.cancel();
        } else {
            // 移除流式标记
            streamingMessageEl.classList.remove('streaming');

            // 最终 Markdown 渲染（不含光标，确保干净输出）
            const contentEl = streamingMessageEl.querySelector('.markdown-body');
            if (contentEl) {
                contentEl.innerHTML = renderMarkdown(content);
                // 激活 mermaid 图表
                activateMermaid(streamingMessageEl);
            }

            // 使用预生成的消息 ID（流式 TTS 与 DOM 绑定共用）
            const msgId = streamingMsgId || `streaming-${Date.now()}`;
            streamingMessageEl.setAttribute('data-message-id', msgId);
            const timeEl = streamingMessageEl.querySelector('.message-time');
            if (!timeEl) {
                // 如果没有 time 元素，创建一个
                const timeDiv = document.createElement('div');
                timeDiv.className = 'message-time';
                timeDiv.innerHTML = `${formatTime(Date.now())}<button class="tts-play-btn" data-msg-id="${msgId}" title="${t('chat.tts_read')}">
                    <svg class="tts-icon-play" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                    <svg class="tts-icon-pause hidden" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                    <svg class="tts-icon-loading hidden" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
                </button>`;
                streamingMessageEl.appendChild(timeDiv);
            } else {
                timeEl.insertAdjacentHTML('beforeend', `<button class="tts-play-btn" data-msg-id="${msgId}" title="${t('chat.tts_read')}">
                    <svg class="tts-icon-play" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                    <svg class="tts-icon-pause hidden" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                    <svg class="tts-icon-loading hidden" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
                </button>`);
            }

            // 流式 TTS：刷出剩余文本（逐句合成模式，不再整段合成）
            if ((ttsAutoPlay || voiceModeActive) && content.trim()) {
                streamingTtsManager.finishStreaming();
            }
        }
    }

    streamingMessageEl = null;
    streamingContent = '';
    streamingMsgId = '';

    return content;
}

// 隐藏加载动画
function hideTyping(): void {
    destroyTypingHole();
    const typing = document.getElementById('typing-indicator');
    if (typing) typing.remove();
}

// 发送消息（纯同步函数 — 所有 DOM 操作在当前调用栈内完成）
let lastSendTime = 0;
function sendMessage(): void {
    // 防重发：500ms 内不允许重复触发（防止双击、Enter + click 同时触发等)
    const now = Date.now();
    if (now - lastSendTime < 500) return;
    lastSendTime = now;

    const content = messageInput.value.trim();
    // 只检查当前会话是否在加载（不阻塞其他会话）
    const currentLoading = currentSessionId ? loadingSessions.has(currentSessionId) : false;
    if ((!content && pendingAttachments.length === 0) || currentLoading) return;

    // 取消正在进行的流式 TTS（用户发新消息 = 打断）
    streamingTtsManager.cancel();

    // 收集附件快照（发送后立即清空预览区）
    const attachments = pendingAttachments.map(a => ({
        path: a.path,
        name: a.name,
        size: a.size,
        ext: a.ext,
    }));
    // 收集用于消息气泡显示的附件信息（含缩略图，先不释放）
    const messageAttachments: MessageAttachment[] = pendingAttachments.map(a => ({
        name: a.name,
        ext: a.ext,
        size: a.size,
        thumbnailUrl: a.thumbnailUrl, // 缩略图转移给消息显示，不再释放
    }));
    pendingAttachments = [];
    renderAttachmentPreview();

    // ====== 同步阶段：锁定当前会话 UI + 插入 DOM 元素 ======
    if (currentSessionId) {
        loadingSessions.add(currentSessionId);
    }
    sendBtn.disabled = true;
    // 先切为停止按钮
    sendBtn.classList.add('is-stop');
    sendBtn.innerHTML = STOP_ICON_SVG;
    sendBtn.title = '停止';
    sendBtn.disabled = false;
    messageInput.value = '';
    messageInput.style.height = 'auto';
    setStatus(t('chat.thinking'), 'running');

    // 1) 用户消息立刻出现（附件显示在文字上方）
    addMessage({
        id: `msg-${Date.now()}`,
        role: 'user',
        content: content,
        createdAt: Date.now(),
        attachments: messageAttachments.length > 0 ? messageAttachments : undefined,
    });

    // 2) 黑洞 typing 立刻出现
    showTyping();

    // ====== 异步阶段：网络请求推迟到下一轮事件循环 ======
    setTimeout(() => sendMessageAsync(content, attachments), 0);
}

// 异步发送逻辑（和 UI 绘制完全分离）
async function sendMessageAsync(
    content: string,
    attachments?: Array<{ path: string; name: string; size: number; ext: string }>
): Promise<void> {
    // 捕获发送时的会话 ID（异步执行期间用户可能切换会话）
    const targetSessionId = currentSessionId;

    try {
        // 确保有会话
        if (!targetSessionId) {
            await createSessionSilent();
        }

        const sendSessionId = targetSessionId || currentSessionId;

        // 记录本次聊天的目标会话（用于进度事件隔离）
        if (sendSessionId) {
            chatTargetSessionIds.add(sendSessionId);
        }

        // 仅当用户仍在此会话时重置进度卡片
        if (currentSessionId === sendSessionId) {
            currentProgressCard = null;
            progressItems = [];
        }

        if (!gatewayClient) throw new Error('Gateway 未连接');

        // 构建 chat 选项（可能含 cloud source 或 agentId）
        const chatOptions: { source?: 'local' | 'cloud'; chatroomId?: number; agentId?: string } | undefined =
            currentCloudChatroomId
                ? { source: 'cloud', chatroomId: currentCloudChatroomId }
                : currentAgentId
                    ? { agentId: currentAgentId }
                    : undefined;

        await gatewayClient.chat(
            content,
            sendSessionId ?? undefined,
            attachments?.length ? attachments : undefined,
            chatOptions
        );

        // 聊天完成后的清理工作
        // 注意：UI 渲染（hideTyping、finishProgressCard、finishStreamingMessage）
        // 已由 handleGatewayProgress 的 complete 事件处理，此处只做状态清理

        if (sendSessionId) {
            chatTargetSessionIds.delete(sendSessionId);
            loadingSessions.delete(sendSessionId);
        }

        // 无论是否在同一会话，都刷新会话列表（侧边栏标题/时间可能需要更新）
        await loadLocalAgents();
        updateSendButtonState();
        // 只有当没有其他会话在加载时才设置"就绪"
        if (loadingSessions.size === 0) {
            setStatus(t('titlebar.status_ready'), 'ready');
        }
    } catch (error) {
        const sendSessionId = targetSessionId || currentSessionId;
        const stillInSameSession = currentSessionId === sendSessionId;
        if (sendSessionId) {
            chatTargetSessionIds.delete(sendSessionId);
        }

        if (stillInSameSession) {
            hideTyping();
            finishProgressCard();
            console.error('Chat failed:', error);
            setStatus(t('common.error'), 'error');

            addMessage({
                id: `msg-${Date.now()}`,
                role: 'assistant',
                content: `抱歉，发生了错误: ${error instanceof Error ? error.message : t('common.unknown_error')}`,
                createdAt: Date.now(),
            });
        } else {
            console.error('Chat failed (session switched):', error);
            if (loadingSessions.size === 0) {
                setStatus(t('titlebar.status_ready'), 'ready');
            }
        }
    } finally {
        const sendSessionId = targetSessionId || currentSessionId;
        if (sendSessionId) {
            loadingSessions.delete(sendSessionId);
        }
        // 更新按钮状态（根据当前查看的会话）
        updateSendButtonState();
    }
}

// 清空消息
function clearMessages(): void {
    // 重置实时进度状态
    currentProgressCard = null;
    progressItems = [];
    isProgressFinished = true;

    messagesContainer.innerHTML = `
        <div class="welcome-message">
            <div class="welcome-icon"><img src="./icon.png" alt="OpenFlux" /></div>
            <h3>${t('chat.welcome_title')}</h3>
            <p>${t('chat.welcome_desc')}</p>
        </div>
    `;
}

// 设置状态
function setStatus(text: string, type: 'ready' | 'running' | 'error'): void {
    const dot = statusIndicator.querySelector('.dot');
    const textEl = statusIndicator.querySelector('.text');

    if (dot) dot.className = `dot ${type}`;
    if (textEl) textEl.textContent = text;
}

// 滚动到底部
function scrollToBottom(): void {
    // 使用 requestAnimationFrame 确保 DOM 更新后再滚动
    requestAnimationFrame(() => {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
        // 额外滚动进度卡片到可见区域
        const progressCard = messagesContainer.querySelector('.progress-card:last-of-type');
        if (progressCard) {
            progressCard.scrollIntoView({ behavior: 'smooth', block: 'end' });
        }
    });
}

// 格式化时间
function formatTime(timestamp: number | string | undefined): string {
    if (!timestamp) return '';

    // 处理字符串或数字格式的时间戳
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) return '';

    const now = new Date();

    if (date.toDateString() === now.toDateString()) {
        return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

// HTML 转义
function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// 自动调整输入框高度
function autoResize(): void {
    messageInput.style.height = 'auto';
    messageInput.style.height = Math.min(messageInput.scrollHeight, 200) + 'px';
}

// 确认弹窗
function showConfirmation(taskId: string, message: string): Promise<boolean> {
    return new Promise((resolve) => {
        pendingConfirmation = { taskId, resolve };
        confirmMessage.textContent = message;
        confirmModal.classList.remove('hidden');
    });
}

async function handleConfirm(approved: boolean): Promise<void> {
    if (!pendingConfirmation) return;

    const { resolve } = pendingConfirmation;
    // TODO: 瘦客户端模式下确认功能待实现
    resolve(approved);

    pendingConfirmation = null;
    confirmModal.classList.add('hidden');
}

// 事件绑定
sendBtn.addEventListener('click', () => {
    if (sendBtn.classList.contains('is-stop')) {
        // 停止当前任务 — 立即恢复 UI
        if (currentSessionId) {
            loadingSessions.delete(currentSessionId);
        }
        hideTyping();
        finishProgressCard();
        updateSendButtonState();
        setStatus(t('titlebar.status_ready'), 'ready');
        // 发送停止信号给后端
        if (currentSessionId && gatewayClient) {
            gatewayClient.stopTask(currentSessionId);
            console.log('[UI] Task stop requested:', currentSessionId);
        }
        return;
    }
    sendMessage();
});
// newSessionBtn 现在用于创建 Agent（handler 在 Agent 管理区域注册）

messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.ctrlKey) {
        e.preventDefault();
        sendMessage();
    }
});

messageInput.addEventListener('input', autoResize);

// 消息区附件点击 → 打开文件预览弹窗（事件委托）
messagesContainer.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest('.msg-attach-item[data-path]') as HTMLElement | null;
    if (target) {
        const filePath = target.dataset.path;
        if (filePath) openFilePreview(filePath);
    }
});

confirmYes.addEventListener('click', () => handleConfirm(true));
confirmNo.addEventListener('click', () => handleConfirm(false));

// ========================
// 文件拖拽处理
// ========================

// 1) 全局阻止 Chromium 默认拖拽行为（否则拖文件会导航到文件 URL）
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

// 2) 使用 Tauri v2 原生拖拽事件（可获取文件绝对路径）
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { convertFileSrc } from '@tauri-apps/api/core';
import { stat, readFile } from '@tauri-apps/plugin-fs';

const workspace = document.getElementById('workspace') as HTMLElement;

// HTML5 dragenter/dragleave 仅用于 UI 高亮提示
let dragCounter = 0;
workspace.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    if (e.dataTransfer?.types?.includes('Files')) {
        inputContainer.classList.add('drag-over');
    }
});
workspace.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});
workspace.addEventListener('dragleave', () => {
    dragCounter--;
    if (dragCounter <= 0) {
        dragCounter = 0;
        inputContainer.classList.remove('drag-over');
    }
});

// Tauri 原生拖拽：获取文件绝对路径
getCurrentWebview().onDragDropEvent(async (event) => {
    if (event.payload.type === 'drop') {
        dragCounter = 0;
        inputContainer.classList.remove('drag-over');

        const paths = event.payload.paths;
        console.log('[DragDrop] Tauri drop event fired, files:', paths.length);
        if (!paths || paths.length === 0) return;

        let addedCount = 0;
        for (const filePath of paths) {
            const fileName = filePath.split(/[\\/]/).pop() || filePath;
            const ext = getFileExt(fileName);
            const fileType = SUPPORTED_DROP_EXTS[ext];

            console.log(`[DragDrop] File: name=${fileName}, path=${filePath}, ext=${ext}`);

            if (!fileType) {
                console.warn(`[DragDrop] Unsupported file type: ${ext} (${fileName})`);
                continue;
            }

            // 避免重复添加同路径文件
            if (pendingAttachments.some(a => a.path === filePath)) continue;

            // 获取文件大小
            let fileSize = 0;
            try {
                const fileStat = await stat(filePath);
                fileSize = fileStat.size;
            } catch (e) {
                console.warn(`[DragDrop] Get file size failed: ${filePath}`, e);
            }

            // 图片文件生成缩略图：读取文件创建 Blob URL（比 asset 协议更可靠）
            let thumbnailUrl: string | undefined;
            if (fileType === 'image') {
                try {
                    const imgData = await readFile(filePath);
                    const mimeMap: Record<string, string> = {
                        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                        '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
                    };
                    const blob = new Blob([imgData], { type: mimeMap[ext] || 'image/png' });
                    thumbnailUrl = URL.createObjectURL(blob);
                } catch (e) {
                    console.warn('[DragDrop] Generate image preview failed:', e);
                }
            }

            pendingAttachments.push({
                path: filePath,
                name: fileName,
                size: fileSize,
                ext,
                type: fileType,
                thumbnailUrl,
            });
            addedCount++;
        }

        console.log(`[DragDrop] Done: added ${addedCount}, total ${pendingAttachments.length}`);
        if (addedCount > 0) {
            renderAttachmentPreview();
            messageInput.focus();
        }
    } else if (event.payload.type === 'enter') {
        dragCounter++;
        inputContainer.classList.add('drag-over');
    } else if (event.payload.type === 'leave') {
        dragCounter--;
        if (dragCounter <= 0) {
            dragCounter = 0;
            inputContainer.classList.remove('drag-over');
        }
    }
});

/** 获取小写扩展名 */
function getFileExt(filename: string): string {
    const idx = filename.lastIndexOf('.');
    return idx >= 0 ? filename.slice(idx).toLowerCase() : '';
}

/** 渲染附件预览区 */
function renderAttachmentPreview(): void {
    if (pendingAttachments.length === 0) {
        attachmentPreview.classList.add('hidden');
        attachmentPreview.innerHTML = '';
        return;
    }

    attachmentPreview.classList.remove('hidden');
    attachmentPreview.innerHTML = pendingAttachments.map((a, idx) => {
        // 图片：显示缩略图；其他类型：显示文字图标
        const iconHtml = a.thumbnailUrl
            ? `<img class="attachment-thumb" src="${a.thumbnailUrl}" alt="${escapeHtml(a.name)}" />`
            : `<div class="attachment-icon ${getAttachmentIconClass(a.ext)}">${getAttachmentIconLabel(a.ext)}</div>`;
        return `
            <div class="attachment-item${a.thumbnailUrl ? ' has-thumb' : ''}" title="${escapeHtml(a.name)}\n${formatAttachmentSize(a.size)}">
                ${iconHtml}
                <span class="attachment-name">${escapeHtml(a.name)}</span>
                <button class="attachment-remove" data-idx="${idx}" title="${t('common.remove')}">&times;</button>
            </div>
        `;
    }).join('');

    // 绑定删除按钮事件
    attachmentPreview.querySelectorAll('.attachment-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt((btn as HTMLElement).dataset.idx || '0', 10);
            // 释放图片缩略图 URL
            const removed = pendingAttachments[idx];
            if (removed?.thumbnailUrl) URL.revokeObjectURL(removed.thumbnailUrl);
            pendingAttachments.splice(idx, 1);
            renderAttachmentPreview();
        });
    });
}

/** 获取文件图标 CSS ?*/
function getAttachmentIconClass(ext: string): string {
    const e = ext.toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(e)) return 'icon-image';
    if (['.xlsx', '.xls', '.csv'].includes(e)) return 'icon-excel';
    if (['.docx'].includes(e)) return 'icon-word';
    if (['.pdf'].includes(e)) return 'icon-pdf';
    if (['.pptx'].includes(e)) return 'icon-ppt';
    return 'icon-text';
}

/** 获取文件图标标签文字 */
function getAttachmentIconLabel(ext: string): string {
    const e = ext.toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(e)) return 'IMG';
    if (['.xlsx', '.xls'].includes(e)) return 'XLS';
    if (['.csv'].includes(e)) return 'CSV';
    if (['.docx'].includes(e)) return 'DOC';
    if (['.pdf'].includes(e)) return 'PDF';
    if (['.pptx'].includes(e)) return 'PPT';
    if (['.json'].includes(e)) return 'JSON';
    if (['.md'].includes(e)) return 'MD';
    if (['.py'].includes(e)) return 'PY';
    if (['.js', '.ts'].includes(e)) return 'JS';
    return 'TXT';
}

/** 格式化文件大小 */
function formatAttachmentSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// 窗口控制
btnMinimize.addEventListener('click', () => invoke('window_minimize'));
btnMaximize.addEventListener('click', () => invoke('window_maximize'));
btnClose.addEventListener('click', () => invoke('window_close'));

// 侧边栏收起/展开
sidebarToggle.addEventListener('click', () => {
    sidebar.classList.toggle('collapsed');
    if (sidebar.classList.contains('collapsed')) {
        sidebar.style.width = '';
    } else {
        const saved = localStorage.getItem('sidebar-width');
        if (saved) sidebar.style.width = saved + 'px';
    }
});

// 成果物面板收起/展开
artifactsToggle.addEventListener('click', () => {
    artifactsPanel.classList.toggle('collapsed');
    if (artifactsPanel.classList.contains('collapsed')) {
        artifactsPanel.style.width = '';
    } else {
        const saved = localStorage.getItem('artifacts-panel-width');
        if (saved) artifactsPanel.style.width = saved + 'px';
    }
});

// ========== 面板拖拽调宽 ==========
(function initPanelResize() {
    const sidebarHandle = document.getElementById('sidebar-resize-handle')!;
    const artifactsHandle = document.getElementById('artifacts-resize-handle')!;

    const SIDEBAR_MIN = 180, SIDEBAR_MAX = 480;
    const ARTIFACTS_MIN = 200, ARTIFACTS_MAX = 600;

    // 恢复持久化宽度
    const savedSW = localStorage.getItem('sidebar-width');
    const savedAW = localStorage.getItem('artifacts-panel-width');
    if (savedSW) sidebar.style.width = savedSW + 'px';
    if (savedAW) artifactsPanel.style.width = savedAW + 'px';

    function startDrag(
        e: MouseEvent,
        panel: HTMLElement,
        handle: HTMLElement,
        side: 'left' | 'right',
        min: number,
        max: number,
        storageKey: string,
    ) {
        e.preventDefault();
        const startX = e.clientX;
        const startWidth = panel.getBoundingClientRect().width;
        handle.classList.add('active');
        document.body.classList.add('resizing');
        panel.style.transition = 'none';

        const onMove = (ev: MouseEvent) => {
            const diff = ev.clientX - startX;
            const newW = Math.min(max, Math.max(min, side === 'left' ? startWidth + diff : startWidth - diff));
            panel.style.width = newW + 'px';
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            handle.classList.remove('active');
            document.body.classList.remove('resizing');
            panel.style.transition = '';
            const w = panel.getBoundingClientRect().width;
            localStorage.setItem(storageKey, String(Math.round(w)));
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }

    sidebarHandle.addEventListener('mousedown', (e) => {
        if (sidebar.classList.contains('collapsed')) return;
        startDrag(e, sidebar, sidebarHandle, 'left', SIDEBAR_MIN, SIDEBAR_MAX, 'sidebar-width');
    });

    artifactsHandle.addEventListener('mousedown', (e) => {
        if (artifactsPanel.classList.contains('collapsed')) return;
        startDrag(e, artifactsPanel, artifactsHandle, 'right', ARTIFACTS_MIN, ARTIFACTS_MAX, 'artifacts-panel-width');
    });
})();

// 启动调试浏览器按钮
const browserLaunchBtn = document.getElementById('browser-launch-btn') as HTMLButtonElement | null;
browserLaunchBtn?.addEventListener('click', async () => {
    browserLaunchBtn.classList.add('loading');
    browserLaunchBtn.disabled = true;
    try {
        if (!gatewayClient) return;
        const result = await gatewayClient.launchBrowser();
        browserLaunchBtn.classList.remove('loading');
        if (result.success) {
            browserLaunchBtn.classList.add('success');
            setTimeout(() => browserLaunchBtn.classList.remove('success'), 2000);
        } else {
            browserLaunchBtn.classList.add('error');
            setTimeout(() => browserLaunchBtn.classList.remove('error'), 2000);
            console.warn('[Browser] Launch failed:', result.message);
        }
    } catch (err) {
        browserLaunchBtn.classList.remove('loading');
        browserLaunchBtn.classList.add('error');
        setTimeout(() => browserLaunchBtn.classList.remove('error'), 2000);
        console.error('[Browser] Launch error:', err);
    } finally {
        browserLaunchBtn.disabled = false;
    }
});

// 浏览器 CDP 连接状态指示器
function updateBrowserStatusIndicator(connected: boolean): void {
    if (!browserLaunchBtn) return;
    if (connected) {
        browserLaunchBtn.classList.add('connected');
        browserLaunchBtn.title = 'Browser Connected (CDP)';
    } else {
        browserLaunchBtn.classList.remove('connected');
        browserLaunchBtn.title = 'Launch Debug Browser';
    }
}

// Agent 列表内登录按钮（打开登录弹窗）
const agentListLoginBtn = document.getElementById('agent-list-login-btn') as HTMLButtonElement;
if (agentListLoginBtn) {
    agentListLoginBtn.addEventListener('click', () => {
        openfluxLoginModal.classList.remove('hidden');
        openfluxModalUsername.focus();
    });
}

// ========================
// 设置弹窗 & Debug 面板
// ========================

// ---- 工作模式选择器 ----
type WorkingMode = 'standalone' | 'router' | 'managed';
const VALID_MODES: WorkingMode[] = ['standalone', 'router', 'managed'];
const storedMode = localStorage.getItem('openflux-working-mode') as WorkingMode | null;
let currentWorkingMode: WorkingMode = storedMode && VALID_MODES.includes(storedMode) ? storedMode : 'standalone';
let pendingManagedSwitch = false; // 等待登录后再切换到 managed 模式
let pendingAuthRetry: { content: string; sessionId: string | null; attachments?: Array<{ path: string; name: string; size: number; ext: string }> } | null = null; // 401 后登录成功自动重试

const workingModeCards = document.querySelectorAll('.working-mode-card') as NodeListOf<HTMLDivElement>;

/** 为元素添加/移除灰置覆盖层 */
function setManagedOverlay(el: HTMLElement | null, managed: boolean, label?: string): void {
    if (!el) return;
    if (managed) {
        el.classList.add('managed-overlay');
        el.setAttribute('data-managed-label', label || '🔒');
    } else {
        el.classList.remove('managed-overlay');
        el.removeAttribute('data-managed-label');
    }
}

/** 根据工作模式联动设置界面各区域的显隐/灰置状态 */
function applyWorkingMode(mode: WorkingMode): void {
    currentWorkingMode = mode;
    localStorage.setItem('openflux-working-mode', mode);

    // 更新卡片选中态
    workingModeCards.forEach(card => {
        card.classList.toggle('active', card.dataset.mode === mode);
    });


    const routerManaged = t('mode.managed_by_router');
    const nexusManaged = t('mode.managed_by_nexus');
    const isRouterOrManaged = mode === 'router' || mode === 'managed';

    // --- 模型 Tab：编排/执行模型 + 供应商密钥（Router 模式遮罩） ---
    const orchGroup = document.getElementById('server-orch-provider')?.closest('.settings-model-group') as HTMLElement | null;
    const execGroup = document.getElementById('server-exec-provider')?.closest('.settings-model-group') as HTMLElement | null;
    const providerKeysSection = document.getElementById('server-provider-keys');
    const keysParent = providerKeysSection?.closest('.settings-model-group') as HTMLElement || providerKeysSection;

    setManagedOverlay(orchGroup, isRouterOrManaged,
        mode === 'router' ? routerManaged : nexusManaged);
    setManagedOverlay(execGroup, isRouterOrManaged,
        mode === 'router' ? routerManaged : nexusManaged);
    setManagedOverlay(keysParent, isRouterOrManaged,
        mode === 'router' ? routerManaged : nexusManaged);

    // --- 工具 Tab：Web 搜索 API Key ---
    const webSearchGroup = document.getElementById('server-web-search-provider')?.closest('.settings-model-group') as HTMLElement | null;
    setManagedOverlay(webSearchGroup, isRouterOrManaged,
        mode === 'router' ? routerManaged : nexusManaged);

    // --- 模型 Tab：Agent 独立模型配置（仅单机模式显示） ---
    const agentModelSection = document.getElementById('agent-model-section');
    if (agentModelSection) {
        agentModelSection.style.display = mode === 'standalone' ? '' : 'none';
    }

    // --- Router Tab：Router 配置区域始终显示（所有模式都可能需要连接 Router 来对接 App/飞书） ---

    // --- "使用托管配置"开关：始终显示，但团队模式下强制开启且锁定 ---
    const routerManagedConfig = document.getElementById('router-managed-config');
    const llmSourceToggle = document.getElementById('llm-source-toggle') as HTMLInputElement | null;
    if (routerManagedConfig) {
        routerManagedConfig.style.display = '';
    }
    if (llmSourceToggle) {
        if (mode === 'router') {
            // 团队模式：强制开启，禁止用户关闭
            llmSourceToggle.checked = true;
            llmSourceToggle.disabled = true;
        } else {
            // 单机/托管模式：关闭托管配置开关，锁定
            llmSourceToggle.checked = false;
            llmSourceToggle.disabled = true;
        }
    }

    // --- Gateway llmSource 同步 ---
    if (typeof gatewayClient !== 'undefined' && gatewayClient) {
        if (mode === 'managed') {
            // NexusAI 托管模式 → atlas_managed
            gatewayClient.setLlmSource('atlas_managed').then((res: any) => {
                if (res.error) {
                    console.warn('[Atlas] Switch failed:', res.error);
                    // 标记等待登录，connecte 后 checkOpenFluxLoginStatus 会自动处理
                    pendingManagedSwitch = true;
                    // 只有用户主动点击时才弹出登录框（非初始化恢复）
                    if (document.readyState === 'complete' && performance.now() > 5000) {
                        showLoginModalForAtlas();
                    }
                } else {
                    currentLlmSource = 'atlas_managed';
                }
            }).catch((err: any) => {
                console.error('[Atlas] setLlmSource error:', err);
                pendingManagedSwitch = true;
            });
        } else if (mode === 'router' && (managedLlmAvailable)) {
            // 团队模式 + Router 有托管配置 → managed
            gatewayClient.setLlmSource('managed').then(() => {
                currentLlmSource = 'managed';
            }).catch(() => {});
        } else if (currentLlmSource !== 'local') {
            // 单机模式或无托管 → local
            gatewayClient.setLlmSource('local').then(() => {
                currentLlmSource = 'local';
            }).catch(() => {});
        }
    }
}

// 绑定卡片点击事件
workingModeCards.forEach(card => {
    card.addEventListener('click', () => {
        const mode = card.dataset.mode as WorkingMode;
        if (mode && mode !== currentWorkingMode) {
            applyWorkingMode(mode);
        }
    });
});

// 初始化应用当前模式
applyWorkingMode(currentWorkingMode);

// ---- 设置 Tab 切换 ----
settingsTabs.forEach(tab => {
    tab.addEventListener('click', () => {
        const tabName = tab.dataset.tab;
        settingsTabs.forEach(t => t.classList.remove('active'));
        settingsTabContents.forEach(tc => tc.classList.remove('active'));
        tab.classList.add('active');
        const content = settingsView.querySelector(`.settings-tab-content[data-tab="${tabName}"]`);
        content?.classList.add('active');

        // 切换到模型或工具 tab 时加载配置
        if ((tabName === 'models' || tabName === 'tools') && gatewayClient) {
            loadServerConfig();
            if (tabName === 'models') loadAgentConfig();
        }
        // 切换到记忆管理 tab 时加载数据
        if (tabName === 'memory' && gatewayClient) {
            loadMemoryData();
        }

    });
});

// ---- 服务端配置相关 ----

/** 已知供应商列表（名称和显示名）*/
const PROVIDER_NAMES: Record<string, string> = {
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    minimax: 'MiniMax',
    deepseek: 'DeepSeek',
    zhipu: '智谱 (Zhipu)',
    moonshot: 'Moonshot (Kimi)',
    google: 'Google',
    ollama: 'Ollama',
    custom: '自定义',
};

/** 供应商密钥输入缓存（key ?input element?*/
const providerKeyInputs = new Map<string, HTMLInputElement>();

/**
 * 加载服务端配置 */
async function loadServerConfig(): Promise<void> {
    if (!gatewayClient) return;
    try {
        const cfg = await gatewayClient.getServerConfig();

        // 从配置中更新预置模型列表（覆盖内置 fallback）
        if (cfg.presetModels && Object.keys(cfg.presetModels).length > 0) {
            providerModels = cfg.presetModels;
        }

        // 填充模型选择
        serverOrchProvider.value = cfg.llm.orchestration.provider;
        populateModelSelect(serverOrchModel, serverOrchModelCustom, cfg.llm.orchestration.provider, cfg.llm.orchestration.model);
        serverExecProvider.value = cfg.llm.execution.provider;
        populateModelSelect(serverExecModel, serverExecModelCustom, cfg.llm.execution.provider, cfg.llm.execution.model);

        // 供应商切换时联动模型列表
        serverOrchProvider.onchange = () => {
            populateModelSelect(serverOrchModel, serverOrchModelCustom, serverOrchProvider.value);
        };
        serverExecProvider.onchange = () => {
            populateModelSelect(serverExecModel, serverExecModelCustom, serverExecProvider.value);
        };

        // 填充 Embedding 模型
        if (cfg.llm.embedding) {
            if (serverEmbeddingProvider) serverEmbeddingProvider.value = cfg.llm.embedding.provider;
            if (serverEmbeddingModel) serverEmbeddingModel.value = cfg.llm.embedding.model;
        } else {
            // 默认显示 (实际以服务端为准)
            if (serverEmbeddingProvider) serverEmbeddingProvider.value = 'openai';
            if (serverEmbeddingModel) serverEmbeddingModel.value = 'text-embedding-3-small';
        }

        // Gateway 信息（已移除 Gateway section，跳过）
        // serverGatewayMode.textContent = ...;
        // serverGatewayPort.textContent = ...;

        // 填充 Web 搜索配置
        if (cfg.web) {
            if (cfg.web.search) {
                serverWebSearchProvider.value = cfg.web.search.provider || 'brave';
                serverWebSearchApiKey.value = '';
                serverWebSearchApiKey.placeholder = cfg.web.search.apiKey || t('settings.search_apikey_placeholder');
                serverWebSearchMaxResults.value = String(cfg.web.search.maxResults ?? 5);
            }
            if (cfg.web.fetch) {
                serverWebFetchReadability.checked = cfg.web.fetch.readability ?? true;
                serverWebFetchMaxChars.value = String(cfg.web.fetch.maxChars ?? 50000);
            }
        }

        // 渲染供应商密钥列表
        renderProviderKeys(cfg.providers);

        // 加载 MCP Server 配置
        mcpServers = cfg.mcp?.servers || [];
        renderMcpServers();

        // 填充沙盒配置
        let loadedSandboxMode = 'local';
        if (cfg.sandbox) {
            loadedSandboxMode = cfg.sandbox.mode || 'local';
            serverSandboxMode.value = loadedSandboxMode;
            sandboxDockerFields.classList.toggle('hidden', serverSandboxMode.value !== 'docker');

            if (cfg.sandbox.docker) {
                serverSandboxDockerImage.value = cfg.sandbox.docker.image || 'openflux-sandbox';
                serverSandboxDockerMemory.value = cfg.sandbox.docker.memoryLimit || '512m';
                serverSandboxDockerCpu.value = cfg.sandbox.docker.cpuLimit || '1';
                serverSandboxDockerNetwork.value = cfg.sandbox.docker.networkMode || 'none';
            }

            if (cfg.sandbox.blockedExtensions) {
                serverSandboxBlockedExt.value = cfg.sandbox.blockedExtensions.join(',');
            }
        } else {
            serverSandboxMode.value = 'local';
            sandboxDockerFields.classList.add('hidden');
            serverSandboxBlockedExt.value = '';
        }

        serverSaveHint.textContent = '';
        serverSaveHint.className = 'settings-save-hint';
        // 记录加载时的沙盒模式，供保存时对比
        lastSavedSandboxMode = loadedSandboxMode;
    } catch (err) {
        console.error('[Settings] Load server config failed', err);
    }
}

/**
 * 渲染供应商密钥输入列表 */
function renderProviderKeys(providers: Record<string, { apiKey?: string; baseUrl?: string }>): void {
    serverProviderKeysContainer.innerHTML = '';
    providerKeyInputs.clear();

    // 仅显示常用供应商（不含 google/custom/ollama 等不需要 key 的）
    const keyProviders = ['anthropic', 'openai', 'minimax', 'deepseek', 'zhipu', 'moonshot'];

    for (const name of keyProviders) {
        const info = providers[name] || {};
        const hasKey = !!info.apiKey && info.apiKey !== '';
        const displayName = PROVIDER_NAMES[name] || name;

        const item = document.createElement('div');
        item.className = 'settings-provider-key-item';

        const header = document.createElement('div');
        header.className = 'settings-provider-key-header';
        header.innerHTML = `
            <span class="settings-provider-key-name">${displayName}</span>
            <span class="settings-provider-key-status ${hasKey ? 'configured' : 'not-configured'}">${hasKey ? t('settings.key_configured') : t('settings.key_not_configured')} </span>
        `;
        item.appendChild(header);

        const inputRow = document.createElement('div');
        inputRow.className = 'settings-provider-key-input-row';

        const input = document.createElement('input');
        input.type = 'password';
        input.className = 'settings-provider-key-input';
        input.placeholder = hasKey ? info.apiKey! : t('settings.enter_apikey');
        input.value = '';
        input.dataset.provider = name;
        providerKeyInputs.set(name, input);

        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'settings-provider-key-toggle';
        toggleBtn.title = t('settings.show_hide');
        toggleBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
        toggleBtn.addEventListener('click', () => {
            input.type = input.type === 'password' ? 'text' : 'password';
        });

        inputRow.appendChild(input);
        inputRow.appendChild(toggleBtn);
        item.appendChild(inputRow);

        serverProviderKeysContainer.appendChild(item);
    }
}

/**
 * 渲染 MCP Server 列表
 */
function renderMcpServers(): void {
    mcpServersList.innerHTML = '';
    if (mcpServers.length === 0) return;

    for (let i = 0; i < mcpServers.length; i++) {
        const server = mcpServers[i];
        const card = document.createElement('div');
        card.className = 'mcp-server-card';

        const detail = server.transport === 'stdio'
            ? `${server.command || ''} ${(server.args || []).join(' ')}`.trim()
            : server.url || '';

        card.innerHTML = `
            <div class="mcp-server-status ${server.status || 'disconnected'}" title="${server.status === 'connected' ? t('mcp.status_connected') : server.status === 'error' ? t('mcp.status_error') : t('mcp.status_disconnected')}"></div>
            <div class="mcp-server-info">
                <div class="mcp-server-name">
                    ${server.name}
                    <span class="mcp-server-transport">${server.transport}</span>
                    ${server.location === 'client' ? `<span class="mcp-server-location-badge">${t('mcp.client_badge')}</span>` : ''}
                </div>
                <div class="mcp-server-detail">${detail}</div>
            </div>
            ${server.toolCount ? `<span class="mcp-server-tools-badge">${server.toolCount} ${t('mcp.tools_unit')}</span>` : ''}
            <div class="mcp-server-actions">
                <button class="mcp-server-action-btn edit" title="${t('common.edit')}" data-idx="${i}">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                    </svg>
                </button>
                <button class="mcp-server-action-btn delete" title="${t('common.delete')}" data-idx="${i}">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="3 6 5 6 21 6"/>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                    </svg>
                </button>


                                        </div>


                                            `;

        // 编辑按钮
        card.querySelector('.edit')?.addEventListener('click', () => openMcpForm(i));
        // 删除按钮
        card.querySelector('.delete')?.addEventListener('click', () => {
            mcpServers.splice(i, 1);
            renderMcpServers();
        });

        mcpServersList.appendChild(card);
    }
}

/**
 * 处理客户端 MCP Server：连接本机 MCP 并将工具注册到 Gateway
 */
async function handleClientMcpServers(): Promise<void> {
    if (!gatewayClient) return;

    // 1. 先断开旧连接并移除已注册工具
    try {
        await gatewayClient!.request<any>('mcp.disconnect');
        gatewayClient.unregisterClientMcpTools();
    } catch { /* 忽略 */ }

    // 2. 筛选客户端 MCP
    const clientMcps = mcpServers.filter(s => s.location === 'client' && s.enabled !== false);
    if (clientMcps.length === 0) return;

    // 3. 通过 IPC 连接到本机 MCP Server
    const configs = clientMcps.map(s => ({
        name: s.name,
        transport: s.transport,
        command: s.command,
        args: s.args,
        url: s.url,
        env: s.env,
    }));

    try {
        const connectResult = await gatewayClient!.request<any>('mcp.connect', { configs: configs });
        if (!connectResult.success) {
            console.error('[MCP] Client MCP connection failed:', connectResult.error);
            return;
        }

        // mcpConnect 返回中包含工具列表
        const tools = connectResult.tools;
        if (!tools?.length) {
            console.warn('[MCP] Client MCP has no available tools');
            return;
        }

        // 注册到 Gateway
        gatewayClient.registerClientMcpTools(tools);
        console.log(`[MCP] Registered ${tools.length} client MCP tools to Gateway`);
    } catch (err) {
        console.error('[MCP] Client MCP processing failed:', err);
    }
}

/** 打开 MCP 表单（新增或编辑）*/
function openMcpForm(editIndex = -1): void {
    mcpEditingIndex = editIndex;
    if (editIndex >= 0) {
        const s = mcpServers[editIndex];
        mcpFormTitle.textContent = t('mcp.edit_title');
        mcpFormName.value = s.name;
        mcpFormLocation.value = s.location || 'server';
        mcpFormTransport.value = s.transport;
        mcpFormCommand.value = s.command || '';
        mcpFormArgs.value = (s.args || []).join(' ');
        mcpFormEnv.value = Object.entries(s.env || {}).map(([k, v]) => `${k}=${v} `).join(' ');
        mcpFormUrl.value = s.url || '';
    } else {
        mcpFormTitle.textContent = t('mcp.add_title');
        mcpFormName.value = '';
        mcpFormLocation.value = 'server';
        mcpFormTransport.value = 'stdio';
        mcpFormCommand.value = '';
        mcpFormArgs.value = '';
        mcpFormEnv.value = '';
        mcpFormUrl.value = '';
    }
    updateMcpFormFields();
    mcpForm.classList.remove('hidden');
    mcpAddBtn.style.display = 'none';
}

/** 切换 stdio/sse 字段可见性 */
function updateMcpFormFields(): void {
    if (mcpFormTransport.value === 'stdio') {
        mcpFormStdioFields.classList.remove('hidden');
        mcpFormSseFields.classList.add('hidden');
    } else {
        mcpFormStdioFields.classList.add('hidden');
        mcpFormSseFields.classList.remove('hidden');
    }
}

/** 关闭 MCP 表单 */
function closeMcpForm(): void {
    mcpForm.classList.add('hidden');
    mcpAddBtn.style.display = '';
    mcpEditingIndex = -1;
}

// MCP 表单事件
mcpFormTransport.addEventListener('change', updateMcpFormFields);
mcpAddBtn.addEventListener('click', () => openMcpForm());
mcpFormCancel.addEventListener('click', closeMcpForm);
mcpFormSubmit.addEventListener('click', () => {
    const name = mcpFormName.value.trim();
    if (!name) { mcpFormName.focus(); return; }

    const transport = mcpFormTransport.value as 'stdio' | 'sse';
    const location = mcpFormLocation.value as 'server' | 'client';
    const entry: McpServerView = { name, transport, location, enabled: true };

    if (transport === 'stdio') {
        entry.command = mcpFormCommand.value.trim() || undefined;
        const argsStr = mcpFormArgs.value.trim();
        entry.args = argsStr ? argsStr.split(/\s+/) : undefined;
        const envStr = mcpFormEnv.value.trim();
        if (envStr) {
            entry.env = {};
            for (const pair of envStr.split(/\s+/)) {
                const [k, ...rest] = pair.split('=');
                if (k) entry.env[k] = rest.join('=');
            }
        }
    } else {
        entry.url = mcpFormUrl.value.trim() || undefined;
    }

    if (mcpEditingIndex >= 0) {
        mcpServers[mcpEditingIndex] = entry;
    } else {
        mcpServers.push(entry);
    }

    closeMcpForm();
    renderMcpServers();
});

/**
 * 保存服务端配置 */
// 上次加载时的沙盒模式（用于检测变化并提示重启）
let lastSavedSandboxMode = 'local';
let lastSavedMcpSnapshot = '';

serverSaveBtn.addEventListener('click', async () => {
    if (!gatewayClient) return;

    serverSaveBtn.disabled = true;
    serverSaveHint.textContent = t('settings.saving');
    serverSaveHint.className = 'settings-save-hint';

    // 监听后台服务重启进度
    const progressHandler = (msg: any) => {
        if (msg.type === 'config.progress' && msg.payload?.step) {
            serverSaveHint.textContent = msg.payload.step;
        }
    };
    gatewayClient.addMessageHandler(progressHandler);

    try {
        const updates: Record<string, unknown> = {};

        // 收集供应商密钥更新（仅收集非空的输入）
        const providerUpdates: Record<string, { apiKey?: string }> = {};
        for (const [name, input] of providerKeyInputs) {
            const val = input.value.trim();
            if (val) {
                providerUpdates[name] = { apiKey: val };
            }
        }
        if (Object.keys(providerUpdates).length > 0) {
            updates.providers = providerUpdates;
        }

        // 收集模型配置更新
        updates.orchestration = {
            provider: serverOrchProvider.value,
            model: getModelSelectValue(serverOrchModel, serverOrchModelCustom),
        };
        updates.execution = {
            provider: serverExecProvider.value,
            model: getModelSelectValue(serverExecModel, serverExecModelCustom),
        };

        // 收集 Embedding 模型更新
        updates.embedding = {
            provider: serverEmbeddingProvider?.value || 'openai',
            model: serverEmbeddingModel?.value.trim() || 'text-embedding-3-small',
        };

        // 收集 Web 搜索与获取配置
        const webUpdates: Record<string, unknown> = {};
        const searchUpdates: Record<string, unknown> = {
            provider: serverWebSearchProvider.value,
            maxResults: parseInt(serverWebSearchMaxResults.value, 10) || 5,
        };
        const searchKeyVal = serverWebSearchApiKey.value.trim();
        if (searchKeyVal) {
            searchUpdates.apiKey = searchKeyVal;
        }
        webUpdates.search = searchUpdates;
        webUpdates.fetch = {
            readability: serverWebFetchReadability.checked,
            maxChars: parseInt(serverWebFetchMaxChars.value, 10) || 50000,
        };
        updates.web = webUpdates;

        // 收集 MCP Server 配置
        updates.mcp = {
            servers: mcpServers.map(s => ({
                name: s.name,
                location: s.location || 'server',
                transport: s.transport,
                command: s.command,
                args: s.args,
                url: s.url,
                env: s.env,
                enabled: s.enabled !== false,
            })),
        };

        // 收集沙盒配置
        const sandboxUpdates: Record<string, unknown> = {
            mode: serverSandboxMode.value,
        };
        if (serverSandboxMode.value === 'docker') {
            sandboxUpdates.docker = {
                image: serverSandboxDockerImage.value.trim() || 'openflux-sandbox',
                memoryLimit: serverSandboxDockerMemory.value.trim() || '512m',
                cpuLimit: serverSandboxDockerCpu.value.trim() || '1',
                networkMode: serverSandboxDockerNetwork.value,
            };
        }
        const blockedExtStr = serverSandboxBlockedExt.value.trim();
        if (blockedExtStr) {
            sandboxUpdates.blockedExtensions = blockedExtStr.split(',').map(s => s.trim()).filter(Boolean);
        }
        updates.sandbox = sandboxUpdates;

        const result = await gatewayClient.updateServerConfig(updates as any);

        if (result.success) {
            serverSaveHint.textContent = result.message || t('common.save_success');
            serverSaveHint.className = 'settings-save-hint success';

            // 处理客户端 MCP：仅在 MCP 配置变化时才重连（避免修改模型配置时无谓重启 MCP）
            const currentMcpSnapshot = JSON.stringify(updates.mcp);
            if (currentMcpSnapshot !== lastSavedMcpSnapshot) {
                lastSavedMcpSnapshot = currentMcpSnapshot;
                await Promise.race([
                    handleClientMcpServers(),
                    new Promise(r => setTimeout(r, 10000)),
                ]);
            }

            // 沙盒模式变化时仅提示（Gateway 已通过 handleConfigUpdate 热更新，无需重启）
            const newSandboxMode = serverSandboxMode.value;
            if (newSandboxMode !== lastSavedSandboxMode) {
                lastSavedSandboxMode = newSandboxMode;
                serverSaveHint.textContent = `沙盒模式已切换为「${newSandboxMode}」，已即时生效`;
                serverSaveHint.className = 'settings-save-hint success';
            }

            // 重新加载以刷新状态
            setTimeout(() => loadServerConfig(), 800);
        } else {
            serverSaveHint.textContent = result.message || t('common.save_failed');
            serverSaveHint.className = 'settings-save-hint error';
        }
    } catch (err) {
        serverSaveHint.textContent = t('settings.save_failed_detail', err instanceof Error ? err.message : String(err));
        serverSaveHint.className = 'settings-save-hint error';
    } finally {
        gatewayClient.removeMessageHandler(progressHandler);
        serverSaveBtn.disabled = false;
    }
});

// 工具 Tab 保存按钮（复用服务端保存逻辑）
document.getElementById('tools-save-btn')?.addEventListener('click', () => {
    serverSaveBtn.click();
});

// ---- 全局角色设定相关 ----

/**
 * 加载全局角色设定、技能和 Agent 模型
 */
async function loadAgentConfig(): Promise<void> {
    if (!gatewayClient) return;
    // Agent Tab 已移除时跳过
    if (!agentNameInput && !agentPromptInput) return;
    try {
        const cfg = await gatewayClient.getServerConfig();
        if (agentNameInput) agentNameInput.value = cfg.agents?.globalAgentName || '';
        if (agentPromptInput) agentPromptInput.value = cfg.agents?.globalSystemPrompt || '';
        if (agentSaveHint) {
            agentSaveHint.textContent = '';
            agentSaveHint.className = 'settings-save-hint';
        }

        // 加载技能
        skillsData = cfg.agents?.skills || [];
        renderSkills();

        // 加载 Agent 模型配置
        agentListData = (cfg.agents?.list || []).map(a => ({
            id: a.id,
            name: a.name,
            description: a.description,
            provider: a.model?.provider || '',
            model: a.model?.model || '',
        }));
        // 同时获取全局模型信息作为 placeholder
        globalOrchModel = {
            provider: cfg.llm?.orchestration?.provider || '',
            model: cfg.llm?.orchestration?.model || '',
        };
        renderAgentModelCards();
    } catch (err) {
        console.error('[Settings] Load global agent settings failed:', err);
    }
}

// ---- Agent 模型管理逻辑 ----

type AgentModelItem = { id: string; name: string; description: string; provider: string; model: string };
let agentListData: AgentModelItem[] = [];
let globalOrchModel = { provider: '', model: '' };

const agentModelListEl = document.getElementById('agent-model-list');
const KNOWN_PROVIDERS = ['anthropic', 'openai', 'google', 'deepseek', 'zhipu', 'moonshot', 'minimax', 'ollama', 'custom'];
const AGENT_ICONS: Record<string, string> = { default: '💬', coder: '💻', automation: '🤖' };

function renderAgentModelCards(): void {
    if (!agentModelListEl) return;
    agentModelListEl.innerHTML = '';
    if (agentListData.length === 0) return;
    for (const agent of agentListData) {
        agentModelListEl.appendChild(createAgentModelCard(agent));
    }
}

function createAgentModelCard(agent: AgentModelItem): HTMLElement {
    const card = document.createElement('div');
    card.className = 'agent-model-card';

    // 头部
    const header = document.createElement('div');
    header.className = 'agent-model-card-header';

    const icon = document.createElement('span');
    icon.className = 'agent-model-card-icon';
    icon.textContent = AGENT_ICONS[agent.id] || '🤖';

    const info = document.createElement('div');
    info.className = 'agent-model-card-info';

    const name = document.createElement('div');
    name.className = 'agent-model-card-name';
    name.textContent = agent.name;

    const desc = document.createElement('div');
    desc.className = 'agent-model-card-desc';
    desc.textContent = agent.description;

    info.appendChild(name);
    info.appendChild(desc);
    header.appendChild(icon);
    header.appendChild(info);

    // 模型选择
    const fields = document.createElement('div');
    fields.className = 'agent-model-card-fields';

    const providerSelect = document.createElement('select');
    // 默认选项
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = `${t('agent.follow_global')} (${globalOrchModel.provider || t('agent.not_set')})`;
    providerSelect.appendChild(defaultOpt);
    for (const p of KNOWN_PROVIDERS) {
        const opt = document.createElement('option');
        opt.value = p;
        opt.textContent = p;
        providerSelect.appendChild(opt);
    }
    providerSelect.value = agent.provider;
    providerSelect.addEventListener('change', () => {
        agent.provider = providerSelect.value;
        if (!providerSelect.value) {
            agent.model = '';
            modelInput.value = '';
            modelInput.placeholder = globalOrchModel.model || t('agent.follow_global');
        }
    });

    const modelInput = document.createElement('input');
    modelInput.type = 'text';
    modelInput.placeholder = agent.provider ? t('agent.enter_model_name') : (globalOrchModel.model || t('agent.follow_global'));
    modelInput.value = agent.model;
    modelInput.addEventListener('input', () => {
        agent.model = modelInput.value.trim();
    });

    fields.appendChild(providerSelect);
    fields.appendChild(modelInput);

    card.appendChild(header);
    card.appendChild(fields);
    return card;
}

// ---- 技能管理逻辑 ----

type SkillItem = { id: string; title: string; content: string; enabled: boolean };
let skillsData: SkillItem[] = [];

const skillsListEl = document.getElementById('skills-list')!;
const skillAddBtn = document.getElementById('skill-add-btn');

function renderSkills(): void {
    skillsListEl.innerHTML = '';
    if (skillsData.length === 0) {
        skillsListEl.innerHTML = '<div class="skills-empty">' + t('agent.no_skills') + '</div>';
        return;
    }
    for (const skill of skillsData) {
        skillsListEl.appendChild(createSkillCard(skill));
    }
}

function createSkillCard(skill: SkillItem): HTMLElement {
    const card = document.createElement('div');
    card.className = 'skill-card';
    card.dataset.skillId = skill.id;

    // 头部
    const header = document.createElement('div');
    header.className = 'skill-card-header';

    const toggle = document.createElement('span');
    toggle.className = 'skill-card-toggle';
    toggle.textContent = '▶';

    const title = document.createElement('span');
    title.className = 'skill-card-title';
    title.textContent = skill.title || t('agent.unnamed_skill');

    const actions = document.createElement('div');
    actions.className = 'skill-card-actions';

    // 开关
    const switchLabel = document.createElement('label');
    switchLabel.className = 'skill-switch';
    const switchInput = document.createElement('input');
    switchInput.type = 'checkbox';
    switchInput.checked = skill.enabled;
    switchInput.addEventListener('click', (e) => e.stopPropagation());
    switchInput.addEventListener('change', () => {
        skill.enabled = switchInput.checked;
    });
    const slider = document.createElement('span');
    slider.className = 'skill-switch-slider';
    switchLabel.appendChild(switchInput);
    switchLabel.appendChild(slider);

    // 删除
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'skill-delete-btn';
    deleteBtn.textContent = '✕';
    deleteBtn.title = t('agent.delete_skill');
    deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        skillsData = skillsData.filter(s => s.id !== skill.id);
        renderSkills();
    });

    actions.appendChild(switchLabel);
    actions.appendChild(deleteBtn);
    header.appendChild(toggle);
    header.appendChild(title);
    header.appendChild(actions);

    // 折叠/展开
    header.addEventListener('click', () => {
        card.classList.toggle('expanded');
    });

    // 编辑区
    const body = document.createElement('div');
    body.className = 'skill-card-body';

    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.className = 'skill-title-input';
    titleInput.placeholder = t('agent.skill_title_placeholder');
    titleInput.value = skill.title;
    titleInput.addEventListener('input', () => {
        skill.title = titleInput.value;
        title.textContent = titleInput.value || t('agent.unnamed_skill');
    });

    const contentTextarea = document.createElement('textarea');
    contentTextarea.className = 'skill-content-textarea';
    contentTextarea.placeholder = t('agent.skill_content_placeholder');
    contentTextarea.value = skill.content;
    contentTextarea.addEventListener('input', () => {
        skill.content = contentTextarea.value;
    });

    body.appendChild(titleInput);
    body.appendChild(contentTextarea);

    card.appendChild(header);
    card.appendChild(body);
    return card;
}

skillAddBtn?.addEventListener('click', () => {
    const newSkill: SkillItem = {
        id: crypto.randomUUID(),
        title: '',
        content: '',
        enabled: true,
    };
    skillsData.push(newSkill);
    renderSkills();
    // 自动展开新添加的卡片
    const lastCard = skillsListEl.lastElementChild as HTMLElement;
    if (lastCard) {
        lastCard.classList.add('expanded');
        const titleInput = lastCard.querySelector('.skill-title-input') as HTMLInputElement;
        if (titleInput) titleInput.focus();
    }
});

/**
 * 保存全局角色设定、技能和 Agent 模型
 */
agentSaveBtn?.addEventListener('click', async () => {
    if (!gatewayClient) return;

    agentSaveBtn.disabled = true;
    agentSaveHint.textContent = t('agent.saving');
    agentSaveHint.className = 'settings-save-hint';

    try {
        // 过滤掉空标题的技能
        const validSkills = skillsData.filter(s => s.title.trim());

        // 构建 agent model 更新列表
        const agentModelUpdates = agentListData.map(a => ({
            id: a.id,
            model: a.provider && a.model ? { provider: a.provider, model: a.model } : null,
        }));

        const result = await gatewayClient.updateServerConfig({
            agents: {
                globalAgentName: agentNameInput.value.trim(),
                globalSystemPrompt: agentPromptInput.value,
                skills: validSkills,
                list: agentModelUpdates,
            },
        });

        if (result.success) {
            skillsData = validSkills; // 同步过滤结果
            renderSkills();
            agentSaveHint.textContent = result.message || t('common.save_success');
            agentSaveHint.className = 'settings-save-hint success';
        } else {
            agentSaveHint.textContent = result.message || t('common.save_failed');
            agentSaveHint.className = 'settings-save-hint error';
        }
    } catch (err) {
        agentSaveHint.textContent = t('agent.save_failed_detail', err instanceof Error ? err.message : String(err));
        agentSaveHint.className = 'settings-save-hint error';
    } finally {
        agentSaveBtn.disabled = false;
    }
});

// ---- 设置视图切换（中部区域） ----
let settingsViewActive = false;

function toggleSettingsView(): void {
    settingsViewActive = !settingsViewActive;

    if (settingsViewActive) {
        // 如果调度器视图激活，先关闭
        if (schedulerViewActive) {
            schedulerViewActive = false;
            schedulerView.classList.add('hidden');
            schedulerBtn.classList.remove('active');
            stopCountdownTimer();
        }
        // 隐藏聊天消息和输入区，显示设置视图
        messagesContainer.classList.add('hidden');
        (document.querySelector('.input-area') as HTMLElement).classList.add('hidden');
        hideRouterBindUI(); // 隐藏 Router 绑定区域（fixed 定位不受父容器影响）
        settingsView.classList.remove('hidden');
        settingsBtn.classList.add('active');
        // 加载客户端设置
        if (gatewayClient) {
            gatewayClient.getSettings().then(settings => {
                outputPathInput.value = settings.outputPath || '';
                outputPathInput.title = settings.outputPath || '';
            }).catch(() => {
                outputPathInput.value = t('common.load_failed');
            });
        }
        // 如果当前 tab 是模型或工具，也加载配置
        const activeTab = settingsView.querySelector('.settings-tab.active') as HTMLButtonElement;
        if ((activeTab?.dataset.tab === 'models' || activeTab?.dataset.tab === 'tools') && gatewayClient) {
            loadServerConfig();
        }
    } else {
        // 恢复聊天
        messagesContainer.classList.remove('hidden');
        (document.querySelector('.input-area') as HTMLElement).classList.remove('hidden');
        settingsView.classList.add('hidden');
        settingsBtn.classList.remove('active');
        // 恢复 Router 绑定 UI（如果当前是 Router 会话且未绑定）
        if (isRouterSession) showRouterBindUI();
    }
}

function closeSettingsView(): void {
    if (settingsViewActive) {
        settingsViewActive = false;
        messagesContainer.classList.remove('hidden');
        (document.querySelector('.input-area') as HTMLElement).classList.remove('hidden');
        settingsView.classList.add('hidden');
        settingsBtn.classList.remove('active');
    }
}

// 打开/关闭设置
settingsBtn.addEventListener('click', () => {
    toggleSettingsView();
});

// 浏览输出目录
outputPathBrowse.addEventListener('click', async () => {
    const currentPath = outputPathInput.value || undefined;
    const selected = await tauriDialogOpen({ directory: true, defaultPath: currentPath });
    if (selected && gatewayClient) {
        outputPathInput.value = selected;
        outputPathInput.title = selected;
        try {
            await gatewayClient.updateSettings({ outputPath: selected });
        } catch (err) {
            console.error('[Settings] Update output dir failed:', err);
        }
    }
});

// 重置输出目录为默认值
outputPathReset.addEventListener('click', async () => {
    if (gatewayClient) {
        try {
            const result = await gatewayClient.updateSettings({ outputPath: null });
            outputPathInput.value = result.outputPath || '';
            outputPathInput.title = result.outputPath || '';
        } catch (err) {
            console.error('[Settings] Reset output dir failed:', err);
        }
    }
});


// Debug 模式切换
let debugUnsubscribe: (() => void) | null = null;

debugModeToggle.addEventListener('change', () => {
    const enabled = debugModeToggle.checked;

    if (enabled) {
        // 显示 debug 面板（flex 布局自动挤压 main-layout?
        debugPanel.classList.remove('hidden');

        // 订阅 debug 日志
        if (gatewayClient) {
            gatewayClient.subscribeDebugLog();
            debugUnsubscribe = gatewayClient.onDebugLog((entry) => {
                appendDebugLogEntry(entry);
            });
        }

        appendDebugLogEntry({
            timestamp: new Date().toISOString(),
            level: 'info',
            module: 'Client',
            message: 'Debug mode enabled, receiving Gateway logs...',
        });
    } else {
        // 关闭 debug 面板
        debugPanel.classList.add('hidden');

        // 取消订阅
        if (gatewayClient) {
            gatewayClient.unsubscribeDebugLog();
        }
        if (debugUnsubscribe) {
            debugUnsubscribe();
            debugUnsubscribe = null;
        }
    }
});

// 清空日志
debugClearBtn.addEventListener('click', () => {
    debugLogContainer.innerHTML = '';
});

// 复制所有日志
debugCopyBtn.addEventListener('click', () => {
    const entries = debugLogContainer.querySelectorAll('.debug-log-entry');
    const lines: string[] = [];
    entries.forEach(entry => {
        const time = entry.querySelector('.debug-log-time')?.textContent?.trim() || '';
        const level = entry.querySelector('.debug-log-level')?.textContent?.trim() || '';
        const module = entry.querySelector('.debug-log-module')?.textContent?.trim() || '';
        const message = entry.querySelector('.debug-log-message')?.textContent?.trim() || '';
        lines.push(`${time} ${level.toUpperCase().padEnd(5)} ${module} ${message} `);
    });
    if (lines.length === 0) {
        return;
    }
    navigator.clipboard.writeText(lines.join('\n')).then(() => {
        // 按钮短暂变为对勾反馈
        const originalTitle = debugCopyBtn.title;
        debugCopyBtn.title = `${t('common.copied')} ${lines.length} ${t('debug.log_lines')}`;
        debugCopyBtn.style.color = 'var(--color-success)';
        setTimeout(() => {
            debugCopyBtn.title = originalTitle;
            debugCopyBtn.style.color = '';
        }, 1500);
    });
});

// 关闭 debug 面板（同步关闭开关）
debugCloseBtn.addEventListener('click', () => {
    debugModeToggle.checked = false;
    debugModeToggle.dispatchEvent(new Event('change'));
});

// 拖拽调整 debug 面板高度
(() => {
    let isDragging = false;
    let startY = 0;
    let startHeight = 0;

    debugResizeHandle.addEventListener('mousedown', (e: MouseEvent) => {
        isDragging = true;
        startY = e.clientY;
        startHeight = debugPanel.offsetHeight;
        debugResizeHandle.classList.add('dragging');
        document.body.style.cursor = 'ns-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e: MouseEvent) => {
        if (!isDragging) return;
        // 向上拖 = clientY 减小 = 高度增加
        const delta = startY - e.clientY;
        const newHeight = Math.max(80, Math.min(window.innerHeight * 0.7, startHeight + delta));
        debugPanel.style.height = `${newHeight} px`;
    });

    document.addEventListener('mouseup', () => {
        if (!isDragging) return;
        isDragging = false;
        debugResizeHandle.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    });
})();

/**
 * 追加日志条目到 debug 面板
 */
const MAX_DEBUG_LOG_ENTRIES = 500;

function appendDebugLogEntry(entry: { timestamp: string; level: string; module: string; message: string; meta?: Record<string, unknown> }): void {
    const div = document.createElement('div');
    div.className = 'debug-log-entry';

    const time = new Date(entry.timestamp);
    const timeStr = time.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
        + '.' + String(time.getMilliseconds()).padStart(3, '0');

    const levelClass = ['info', 'warn', 'error', 'debug'].includes(entry.level) ? entry.level : 'info';
    const metaStr = entry.meta ? ` ${JSON.stringify(entry.meta)} ` : '';

    div.innerHTML = `< span class="debug-log-time" > ${timeStr} </span>`
        + `<span class="debug-log-level ${levelClass}">${entry.level.toUpperCase()}</span>`
        + `<span class="debug-log-module">[${entry.module}]</span>`
        + `<span class="debug-log-message">${escapeHtml(entry.message)}${metaStr ? ' <span style="opacity:0.5">' + escapeHtml(metaStr) + '</span>' : ''}</span>`;

    debugLogContainer.appendChild(div);

    // 限制最大条目数
    while (debugLogContainer.children.length > MAX_DEBUG_LOG_ENTRIES) {
        debugLogContainer.removeChild(debugLogContainer.firstChild!);
    }

    // 自动滚到底部
    debugLogContainer.scrollTop = debugLogContainer.scrollHeight;
}

/**
 * 播放任务完成提示音（深空科幻风，约 0.8 秒）
 * 使用 Web Audio API 合成：低频扫频 + 温暖共鸣 + 柔和泛音
 */
function playTaskCompleteSound(): void {
    try {
        const ctx = new AudioContext();
        const now = ctx.currentTime;
        const master = ctx.createGain();
        master.gain.setValueAtTime(0.2, now);
        master.connect(ctx.destination);

        // ①：低频扫描音 — 880Hz 柔和滑降到 440Hz
        const sweep = ctx.createOscillator();
        const sweepGain = ctx.createGain();
        sweep.type = 'sine';
        sweep.frequency.setValueAtTime(880, now);
        sweep.frequency.exponentialRampToValueAtTime(440, now + 0.5);
        sweepGain.gain.setValueAtTime(0.2, now);
        sweepGain.gain.exponentialRampToValueAtTime(0.01, now + 0.7);
        sweep.connect(sweepGain).connect(master);
        sweep.start(now);
        sweep.stop(now + 0.7);

        // ②：温暖共鸣 — 330Hz 正弦波 + 轻微颤音
        const tone = ctx.createOscillator();
        const toneGain = ctx.createGain();
        const vibrato = ctx.createOscillator();
        const vibratoGain = ctx.createGain();
        tone.type = 'sine';
        tone.frequency.setValueAtTime(330, now);
        vibrato.frequency.setValueAtTime(4, now);
        vibratoGain.gain.setValueAtTime(8, now);
        vibrato.connect(vibratoGain).connect(tone.frequency);
        toneGain.gain.setValueAtTime(0, now);
        toneGain.gain.linearRampToValueAtTime(0.25, now + 0.15);
        toneGain.gain.exponentialRampToValueAtTime(0.01, now + 0.8);
        tone.connect(toneGain).connect(master);
        vibrato.start(now);
        tone.start(now);
        tone.stop(now + 0.8);
        vibrato.stop(now + 0.8);

        // ③：柔和泛音 — 660Hz 轻声点缀
        const sparkle = ctx.createOscillator();
        const sparkleGain = ctx.createGain();
        sparkle.type = 'sine';
        sparkle.frequency.setValueAtTime(660, now);
        sparkle.frequency.exponentialRampToValueAtTime(550, now + 0.4);
        sparkleGain.gain.setValueAtTime(0.08, now);
        sparkleGain.gain.exponentialRampToValueAtTime(0.01, now + 0.4);
        sparkle.connect(sparkleGain).connect(master);
        sparkle.start(now);
        sparkle.stop(now + 0.4);

        // 自动释放 AudioContext
        setTimeout(() => ctx.close().catch(() => { }), 1500);
    } catch (e) {
        console.warn('[Sound] Notification sound playback failed', e);
    }
}

// Gateway 进度事件处理
function handleGatewayProgress(event: GatewayProgressEvent): void {
    // 会话隔离检查（优先级从高到低）：

    // 1. 如果事件携带 sessionId（Router 广播的消息或服务端附带），只渲染到对应会话
    //    但需考虑云端聊天场景：后端可能修正了 sessionId（resolvedSessionId），
    //    导致事件 sessionId 与前端 currentSessionId 不一致，但仍属于同一次聊天。
    //    此时应检查当前会话是否有活跃的聊天目标（chatTargetSessionIds.has(currentSessionId)），
    //    如果有，说明当前窗口正在等待回复，应该渲染该事件。
    if (event.sessionId && event.sessionId !== currentSessionId) {
        // 检查是否为云端聊天的 sessionId 修正情况：
        // 当前会话有活跃聊天（在 chatTargetSessionIds 中）且当前是云端模式
        const isCloudSessionCorrected = currentSessionId
            && chatTargetSessionIds.has(currentSessionId)
            && currentCloudChatroomId;

        if (!isCloudSessionCorrected) {
            // 非当前会话的 complete 事件：更新按钮状态 + 通知音
            if (event.type === 'complete') {
                if (event.sessionId) {
                    chatTargetSessionIds.delete(event.sessionId);
                    loadingSessions.delete(event.sessionId);
                    // 清理缓存：任务已结束
                    sessionProgressCache.delete(event.sessionId);
                }
                updateSendButtonState();
                // 标记该会话有未读消息
                markSessionUnread(event.sessionId);
                if (!document.hasFocus()) {
                    playTaskCompleteSound();
                    invoke('window_flash_frame', { flash: true });
                }
            } else {
                // 非当前会话的 tool_result / thinking 事件：追加到 sessionProgressCache
                // 这样切回时能恢复完整的 progress 历程，而不只是切走瞬间的快照
                const sid = event.sessionId;
                if (!sessionProgressCache.has(sid)) {
                    sessionProgressCache.set(sid, { items: [], title: t('app.running') });
                }
                const cached = sessionProgressCache.get(sid)!;
                if (event.type === 'tool_result' && event.tool) {
                    const log = getToolLog(event.tool, event.args);
                    const detail = getToolResultSummary(event.tool, event.args, (event as unknown as Record<string, unknown>).result);
                    cached.items.push({ icon: log.icon, text: log.text, isThinking: false, detail });
                } else if (event.type === 'thinking' && (event as any).thinking) {
                    cached.items.push({ icon: '·', text: (event as any).thinking, isThinking: true });
                } else if (event.type === 'tool_start' && event.description) {
                    cached.title = event.description.split('\n')[0].trim().slice(0, 80) || t('app.running');
                }
            }
            return;
        }
        // else: 云端 sessionId 修正情况，继续渲染到当前窗口
        console.log('[handleGatewayProgress] Cloud sessionId corrected, rendering to current session');
    }

    // 2. 如果当前会话本身不在活跃聊天中，且事件也没有 sessionId，跳过
    //    （防止其他会话的无 sessionId progress 泄漏到当前窗口）
    if (!event.sessionId && chatTargetSessionIds.size > 0 && currentSessionId && !chatTargetSessionIds.has(currentSessionId)) {
        return;
    }

    // ═══ 最终安全屏障：如果事件有 sessionId 且不属于当前会话，跳过渲染 ═══
    // 这是在上面复杂逻辑之外的额外保护，防止竞态条件下漏网的事件
    if (event.sessionId && event.sessionId !== currentSessionId && !currentCloudChatroomId) {
        console.log('[handleGatewayProgress] Safety guard: skipping render for non-current session', event.sessionId, 'current:', currentSessionId);
        return;
    }

    console.log('[Gateway Progress Event]', event);

    // 转换为本地 ProgressEvent 类型
    const progressEvent = event as ProgressEvent;

    if (progressEvent.type === 'thinking' && progressEvent.thinking) {
        updateTypingText(progressEvent.thinking);
        addProgressToChat('·', progressEvent.thinking, true);
    } else if (progressEvent.type === 'tool_start' && event.description) {
        // LLM 返回工具调用请求时附带的描述文字 → 更新 typing 指示器 + 进度卡片标题
        updateTypingText(event.description);
        updateProgressCardTitle(event.description);
    } else if (progressEvent.type === 'tool_result' && event.tool) {
        const log = getToolLog(event.tool, event.args);
        const detail = getToolResultSummary(event.tool, event.args, (event as unknown as Record<string, unknown>).result);
        addProgressToChat(log.icon, log.text, false, detail);

        const artifacts = isArtifactTool(event.tool, event.args, (event as unknown as Record<string, unknown>).result);
        if (artifacts) {
            const list = Array.isArray(artifacts) ? artifacts : [artifacts];
            for (const a of list) {
                addArtifact(a).catch(err => console.error('[Artifact] Add failed:', err));
            }
        }
    } else if (progressEvent.type === 'iteration') {
        // iteration 表示新一轮迭代 — 恢复跳动点
        showTyping();
    } else if (event.type === 'token' && event.token) {
        hideTyping();
        appendStreamingToken(event.token);
    } else if (progressEvent.type === 'complete') {
        // 聊天完成 — 即时视觉反馈
        console.log('[Gateway Progress Event] Chat completed');
        hideTyping();
        finishProgressCard();
        finishStreamingMessage();
        if (event.sessionId) {
            chatTargetSessionIds.delete(event.sessionId);
            loadingSessions.delete(event.sessionId);
        }
        // 云端聊天修正场景：event.sessionId 可能与 currentSessionId 不同，都需清理
        if (currentSessionId) {
            chatTargetSessionIds.delete(currentSessionId);
            loadingSessions.delete(currentSessionId);
        }
        updateSendButtonState();
        if (loadingSessions.size === 0) {
            setStatus(t('titlebar.status_ready'), 'ready');
        }
        // 窗口不在焦点时：播放提示音 + 任务栏闪烁
        if (!document.hasFocus()) {
            playTaskCompleteSound();
            invoke('window_flash_frame', { flash: true });
        }
        // 重新加载当前会话的成果物（后端可能在任务完成后保存了新 artifacts）
        const completeSessionId = event.sessionId || currentSessionId;
        if (completeSessionId && completeSessionId === currentSessionId && gatewayClient) {
            gatewayClient.getArtifacts(completeSessionId).then(saved => {
                if (saved.length > 0) {
                    clearArtifacts();
                    const sorted = [...saved].sort((a: any, b: any) => (b.timestamp || 0) - (a.timestamp || 0));
                    for (const a of sorted) {
                        addArtifact(a as Artifact, false).catch(() => { });
                    }
                }
            }).catch(err => console.warn('[Artifacts] Load failed:', err));
        }
    }
}

// ========== 成果物面板 ==========

interface Artifact {
    type: 'file' | 'code' | 'output';
    path?: string;
    filename?: string;
    content?: string;
    language?: string;
    size?: number;
    timestamp: number;
}

// 成果物分类
type ArtifactCategory = 'all' | 'document' | 'code' | 'image' | 'data' | 'media' | 'other';

const CATEGORY_EXT_MAP: Record<string, ArtifactCategory> = {
    // 文档
    md: 'document', txt: 'document', pdf: 'document',
    doc: 'document', docx: 'document',
    ppt: 'document', pptx: 'document',
    // 代码
    py: 'code', js: 'code', ts: 'code', jsx: 'code', tsx: 'code',
    html: 'code', css: 'code', scss: 'code', less: 'code',
    json: 'code', yaml: 'code', yml: 'code', toml: 'code',
    java: 'code', c: 'code', cpp: 'code', h: 'code', hpp: 'code', cs: 'code',
    go: 'code', rs: 'code', rb: 'code', php: 'code', swift: 'code', kt: 'code',
    sh: 'code', bash: 'code', bat: 'code', ps1: 'code', cmd: 'code',
    sql: 'code', graphql: 'code', proto: 'code',
    xml: 'code', ini: 'code', conf: 'code', cfg: 'code',
    env: 'code', dockerfile: 'code', makefile: 'code',
    // 图片
    png: 'image', jpg: 'image', jpeg: 'image', gif: 'image',
    svg: 'image', webp: 'image', bmp: 'image', ico: 'image',
    // 数据
    csv: 'data', xls: 'data', xlsx: 'data',
    // 媒体
    mp4: 'media', mp3: 'media', wav: 'media', avi: 'media', mkv: 'media',
    mov: 'media', flac: 'media', ogg: 'media',
};

const CATEGORY_ICONS: Record<ArtifactCategory, string> = {
    all: '📁', document: '📝', code: '💻', image: '🖼️', data: '📊', media: '🎬', other: '📋',
};

function getArtifactCategory(artifact: Artifact): ArtifactCategory {
    if (artifact.type === 'code') return 'code';
    if (artifact.type === 'output') return 'other';
    // file type — classify by extension
    const fname = artifact.filename || artifact.path?.split(/[/\\]/).pop() || '';
    const ext = fname.split('.').pop()?.toLowerCase() || '';
    return CATEGORY_EXT_MAP[ext] || 'other';
}

// 当前选中的分类过滤
let activeArtifactFilter: ArtifactCategory = 'all';
const artifactFilterTabs = document.getElementById('artifacts-filter-tabs') as HTMLDivElement;

function updateArtifactFilterTabs(): void {
    // Count each category
    const counts: Record<ArtifactCategory, number> = { all: 0, document: 0, code: 0, image: 0, data: 0, media: 0, other: 0 };
    artifacts.forEach(a => { counts.all++; counts[getArtifactCategory(a)]++; });

    // Only show categories with items + always show "all" if > 0
    const categories: ArtifactCategory[] = ['all', 'document', 'code', 'image', 'data', 'media', 'other'];
    const visibleCategories = categories.filter(c => c === 'all' ? counts.all > 0 : counts[c] > 0);

    // Hide tabs if only "all" or nothing
    if (visibleCategories.length <= 2) {
        artifactFilterTabs.classList.remove('visible');
        artifactFilterTabs.innerHTML = '';
        activeArtifactFilter = 'all';
        return;
    }

    artifactFilterTabs.classList.add('visible');
    const categoryLabels: Record<ArtifactCategory, string> = {
        all: t('artifact.cat_all'), document: t('artifact.cat_document'), code: t('artifact.cat_code'),
        image: t('artifact.cat_image'), data: t('artifact.cat_data'), media: t('artifact.cat_media'), other: t('artifact.cat_other'),
    };

    artifactFilterTabs.innerHTML = visibleCategories.map(c => {
        const active = c === activeArtifactFilter ? ' active' : '';
        return `<button class="artifacts-filter-tab${active}" data-category="${c}">${CATEGORY_ICONS[c]} ${categoryLabels[c]}<span class="tab-count">(${counts[c]})</span></button>`;
    }).join('');

    // Bind click events
    artifactFilterTabs.querySelectorAll('.artifacts-filter-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            activeArtifactFilter = (btn as HTMLElement).dataset.category as ArtifactCategory;
            filterArtifactsByCategory();
            // Update active state
            artifactFilterTabs.querySelectorAll('.artifacts-filter-tab').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        });
    });
}

function filterArtifactsByCategory(): void {
    const artifactsList = document.getElementById('artifacts-list') as HTMLDivElement;
    const items = artifactsList.querySelectorAll('.artifact-item') as NodeListOf<HTMLElement>;
    items.forEach(item => {
        if (activeArtifactFilter === 'all' || item.dataset.category === activeArtifactFilter) {
            item.style.display = '';
        } else {
            item.style.display = 'none';
        }
    });
}

// 日期分组：将 timestamp 转为日期 key
function getArtifactDateKey(ts: number): string {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 日期 key 转为友好标签
function getDateLabel(dateKey: string): string {
    const now = new Date();
    const todayKey = getArtifactDateKey(now.getTime());
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayKey = getArtifactDateKey(yesterday.getTime());
    if (dateKey === todayKey) return '今天';
    if (dateKey === yesterdayKey) return '昨天';
    const [, m, d] = dateKey.split('-');
    return `${parseInt(m)}月${parseInt(d)}日`;
}

// 确保日期分组容器存在
function ensureDateGroup(listEl: HTMLDivElement, dateKey: string): HTMLDivElement {
    let group = listEl.querySelector(`.artifact-date-group[data-date="${dateKey}"]`) as HTMLDivElement | null;
    if (group) return group;
    group = document.createElement('div');
    group.className = 'artifact-date-group';
    group.dataset.date = dateKey;
    const header = document.createElement('div');
    header.className = 'artifact-date-header';
    header.textContent = getDateLabel(dateKey);
    group.appendChild(header);
    // 按日期降序插入
    const existingGroups = listEl.querySelectorAll('.artifact-date-group');
    let inserted = false;
    for (const existing of existingGroups) {
        if (dateKey > ((existing as HTMLElement).dataset.date || '')) {
            listEl.insertBefore(group, existing);
            inserted = true;
            break;
        }
    }
    if (!inserted) listEl.appendChild(group);
    return group;
}

// 今天文件的子分组 key 和标签
const TODAY_SUB_GROUPS = [
    { key: '1h', label: '最近 1 小时', maxAgeMs: 1 * 60 * 60 * 1000 },
    { key: '3h', label: '最近 3 小时', maxAgeMs: 3 * 60 * 60 * 1000 },
    { key: 'earlier', label: '更早今天', maxAgeMs: Infinity },
] as const;

// 确定一个时间戳属于今天的哪个子分组
function getTodaySubGroupKey(ts: number): string {
    const age = Date.now() - ts;
    for (const sg of TODAY_SUB_GROUPS) {
        if (age <= sg.maxAgeMs) return sg.key;
    }
    return 'earlier';
}

// 确保今天子分组容器存在（保持 1h → 3h → earlier 顺序）
function ensureTodaySubGroup(group: HTMLDivElement, subKey: string): HTMLDivElement {
    let sub = group.querySelector(`.artifact-sub-group[data-sub="${subKey}"]`) as HTMLDivElement | null;
    if (sub) return sub;
    sub = document.createElement('div');
    sub.className = 'artifact-sub-group';
    sub.dataset.sub = subKey;
    const sg = TODAY_SUB_GROUPS.find(s => s.key === subKey)!;
    const header = document.createElement('div');
    header.className = 'artifact-sub-header';
    header.textContent = sg.label;
    sub.appendChild(header);
    // 按定义顺序插入（1h 在最前）
    const subIndex = TODAY_SUB_GROUPS.findIndex(s => s.key === subKey);
    const existingSubs = group.querySelectorAll('.artifact-sub-group');
    let insertBefore: Element | null = null;
    for (const existing of existingSubs) {
        const existIdx = TODAY_SUB_GROUPS.findIndex(s => s.key === (existing as HTMLElement).dataset.sub);
        if (existIdx > subIndex) { insertBefore = existing; break; }
    }
    if (insertBefore) {
        group.insertBefore(sub, insertBefore);
    } else {
        group.appendChild(sub);
    }
    return sub;
}

// 成果物列表
let artifacts: Artifact[] = [];

// 清空成果物
function clearArtifacts(): void {
    artifacts = [];
    (document.getElementById('artifacts-list') as HTMLDivElement).innerHTML = '';

    (document.getElementById('artifacts-panel') as HTMLElement).classList.add('collapsed');
    addedArtifactPaths.clear();
    activeArtifactFilter = 'all';
    artifactFilterTabs.classList.remove('visible');
    artifactFilterTabs.innerHTML = '';
}

// 格式化文件大小
function formatFileSize(bytes?: number): string {
    if (bytes === undefined || bytes === null) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// 根据文件名获取图标
function getFileIcon(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    const icons: Record<string, string> = {
        py: '🐍', js: '📜', ts: '📜', jsx: '📜', tsx: '📜',
        html: '🌐', css: '🎨', json: '📋', yaml: '📋', yml: '📋',
        md: '📝', txt: '📝',
        png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️', webp: '🖼️',
        pdf: '📕', doc: '📘', docx: '📘', ppt: '📙', pptx: '📙', xls: '📗', xlsx: '📗',
        zip: '📦', rar: '📦', '7z': '📦', tar: '📦', gz: '📦',
        mp4: '🎬', mp3: '🎵', wav: '🎵',
    };
    return icons[ext] || '📄';
}

// 添加成果物(persist=true 时保存到服务端，false 表示从服务端加载的历史记录
async function addArtifact(artifact: Artifact, persist = true): Promise<void> {
    // 对于文件类型的成果物，先验证文件是否存在
    if (artifact.type === 'file' && artifact.path && persist) {
        try {
            const exists = await invoke<boolean>('file_exists', { filePath: artifact.path });
            if (!exists) {
                console.warn('[Artifact] File not found, skipping:', artifact.path);
                addedArtifactPaths.delete(normalizePath(artifact.path)); // 释放路径，允许后续重新检测
                return;
            }
        } catch (err) {
            console.warn('[Artifact] File existence check failed', err);
        }
    }

    artifacts.push(artifact);

    (document.getElementById('artifacts-panel') as HTMLElement).classList.remove('collapsed');

    // 异步持久化到服务端
    if (persist && currentSessionId && gatewayClient) {
        const { type, path, filename, content, language, size, timestamp } = artifact;
        gatewayClient.saveArtifact(currentSessionId, { type, path, filename, content, language, size, timestamp })
            .catch(err => console.error('[Artifact] Save failed:', err));
    }

    const item = document.createElement('div');
    item.className = 'artifact-item';
    item.dataset.category = getArtifactCategory(artifact);
    item.dataset.timestamp = String(artifact.timestamp || 0);

    const timeLabel = artifact.timestamp ? new Date(artifact.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';

    if (artifact.type === 'file') {
        const filename = artifact.filename || artifact.path?.split(/[/\\]/).pop() || '未知文件';
        const sizeStr = formatFileSize(artifact.size);
        const icon = getFileIcon(filename);
        item.innerHTML = `
            <div class="artifact-icon">${icon}</div>
            <div class="artifact-info">
                <div class="artifact-name">${escapeHtml(filename)}${sizeStr ? `<span class="artifact-size">${sizeStr}</span>` : ''}${timeLabel ? `<span class="artifact-time">${timeLabel}</span>` : ''}</div>
                <div class="artifact-path">${escapeHtml(artifact.path || '')}</div>
            </div>
            <div class="artifact-actions">
                <button class="artifact-action-btn" data-action="open" title="${t('preview.open')}">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                </button>
                <button class="artifact-action-btn" data-action="reveal" title="${t('preview.show_in_folder')}">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
                </button>
                <button class="artifact-action-btn" data-action="save-as" title="${t('preview.save_as')}">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                </button>
            </div>
        `;

        // 绑定按钮事件
        const filePath = artifact.path || '';
        item.querySelectorAll('.artifact-action-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const action = (btn as HTMLElement).dataset.action;
                if (action === 'open') invoke('file_open', { filePath: filePath });
                else if (action === 'reveal') invoke('file_reveal', { filePath: filePath });
                else if (action === 'save-as') {
                    const fileName = filePath.split(/[/\\]/).pop() || '';
                    const destPath = await tauriDialogSave({
                        defaultPath: fileName,
                    });
                    if (destPath) {
                        invoke('file_save_as', { sourcePath: filePath, destPath });
                    }
                }
            });
        });
    } else if (artifact.type === 'code') {
        item.innerHTML = `
            <div class="artifact-icon">💻</div>
            <div class="artifact-info">
                <div class="artifact-name">${escapeHtml(artifact.language || t('preview.code'))}${timeLabel ? `<span class="artifact-time">${timeLabel}</span>` : ''}</div>
                <div class="artifact-preview">${escapeHtml((artifact.content || '').slice(0, 50))}...</div>
            </div>
        `;
    } else {
        item.innerHTML = `
            <div class="artifact-icon">📋</div>
            <div class="artifact-info">
                <div class="artifact-name">${t('preview.output_result')}${timeLabel ? `<span class="artifact-time">${timeLabel}</span>` : ''}</div>
                <div class="artifact-preview">${escapeHtml((artifact.content || '').slice(0, 50))}...</div>
            </div>
        `;
    }

    // 双击打开文件预览
    if (artifact.type === 'file' && artifact.path) {
        const filePath = artifact.path;
        item.style.cursor = 'pointer';
        item.addEventListener('dblclick', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openFilePreview(filePath);
        });
    }

    const artifactsList = document.getElementById('artifacts-list') as HTMLDivElement;
    const ts = artifact.timestamp || Date.now();
    const dateKey = getArtifactDateKey(ts);
    const todayKey = getArtifactDateKey(Date.now());
    const group = ensureDateGroup(artifactsList, dateKey);

    if (dateKey === todayKey) {
        // 今天：按子分组插入（1小时内 / 3小时内 / 更早）
        const subKey = getTodaySubGroupKey(ts);
        const subGroup = ensureTodaySubGroup(group, subKey);
        // 在子分组内按时间降序插入
        const existingItems = subGroup.querySelectorAll('.artifact-item');
        let insertedInSub = false;
        for (const existing of existingItems) {
            const existTs = parseInt((existing as HTMLElement).dataset.timestamp || '0', 10);
            if (ts >= existTs) {
                subGroup.insertBefore(item, existing);
                insertedInSub = true;
                break;
            }
        }
        if (!insertedInSub) subGroup.appendChild(item);
    } else {
        // 非今天：在组内按时间降序插入
        const existingItems = group.querySelectorAll('.artifact-item');
        let insertedInGroup = false;
        for (const existing of existingItems) {
            const existTs = parseInt((existing as HTMLElement).dataset.timestamp || '0', 10);
            if (ts >= existTs) {
                group.insertBefore(item, existing);
                insertedInGroup = true;
                break;
            }
        }
        if (!insertedInGroup) group.appendChild(item);
    }
    updateArtifactFilterTabs();
    if (activeArtifactFilter !== 'all') filterArtifactsByCategory();
}

// ========== 文件预览 ==========

// 可预览的文本类型扩展名
const TEXT_EXTS = new Set([
    'txt', 'md', 'json', 'yaml', 'yml', 'xml', 'csv', 'log', 'ini', 'conf', 'cfg',
    'py', 'js', 'ts', 'jsx', 'tsx', 'html', 'css', 'scss', 'less', 'sass',
    'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'swift', 'kt',
    'sh', 'bash', 'bat', 'ps1', 'cmd',
    'sql', 'graphql', 'proto',
    'toml', 'env', 'gitignore', 'dockerfile', 'makefile',
]);

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico']);

function getLanguageFromExt(ext: string): string {
    const map: Record<string, string> = {
        py: 'python', js: 'javascript', ts: 'typescript', jsx: 'javascript', tsx: 'typescript',
        html: 'html', css: 'css', scss: 'scss', less: 'less',
        json: 'json', yaml: 'yaml', yml: 'yaml', xml: 'xml',
        java: 'java', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp',
        go: 'go', rs: 'rust', rb: 'ruby', php: 'php', swift: 'swift', kt: 'kotlin',
        sh: 'bash', bash: 'bash', bat: 'batch', ps1: 'powershell',
        sql: 'sql', md: 'markdown', txt: 'plaintext',
    };
    return map[ext] || 'plaintext';
}

let currentPreviewPath = '';
let previewPanelCounter = 0;
let previewPanelZIndex = 200;
async function openFilePreview(filePath: string): Promise<void> {
    currentPreviewPath = filePath;
    const filename = filePath.split(/[/\\]/).pop() || 'unknown';

    // 使用 Tauri WebviewWindow 创建独立窗口
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const winLabel = `preview-${++previewPanelCounter}`;

    const previewUrl = `${window.location.origin}/preview.html?file=${encodeURIComponent(filePath)}`;

    const previewWin = new WebviewWindow(winLabel, {
        url: previewUrl,
        title: `📄 ${filename}`,
        width: 820,
        height: 620,
        minWidth: 400,
        minHeight: 300,
        center: true,
        decorations: false,
        resizable: true,
        focus: true,
    });

    previewWin.once('tauri://error', (e) => {
        console.error('Failed to create preview window:', e);
    });
}

// 保留旧的 closeFilePreview 用于兼容
function closeFilePreview(): void {
    filePreviewModal.classList.add('hidden');
    filePreviewBody.innerHTML = '';
    currentPreviewPath = '';
}

// 旧事件绑定保留兼容
filePreviewClose.addEventListener('click', closeFilePreview);
filePreviewModal.addEventListener('click', (e) => {
    if (e.target === filePreviewModal) closeFilePreview();
});
filePreviewOpen.addEventListener('click', () => {
    if (currentPreviewPath) invoke('file_open', { filePath: currentPreviewPath });
});
filePreviewReveal.addEventListener('click', () => {
    if (currentPreviewPath) invoke('file_reveal', { filePath: currentPreviewPath });
});
filePreviewCopy.addEventListener('click', async () => {
    const pre = filePreviewBody.querySelector('pre');
    if (pre) {
        await navigator.clipboard.writeText(pre.textContent || '');
        const original = filePreviewCopy.title;
        filePreviewCopy.title = t('common.copied');
        setTimeout(() => { filePreviewCopy.title = original; }, 1500);
    }
});


// ========== 运行过程（在聊天窗口显示）==========

interface ProgressEvent {
    type: 'iteration' | 'thinking' | 'tool_start' | 'tool_result' | 'artifact' | 'token' | 'complete';
    iteration?: number;
    tool?: string;
    args?: Record<string, unknown>;
    result?: unknown;
    thinking?: string;
    artifact?: Artifact;
    token?: string;
    output?: string;
    /** LLM 原始描述文字（仅 tool_start 事件）*/
    llmDescription?: string;
}

// 当前 session 的实时进度状态（仅用于正在进行的对话）
let currentProgressCard: HTMLElement | null = null;
let progressItems: Array<{ icon: string; text: string; isThinking: boolean; detail?: string }> = [];
let isProgressFinished = true; // 标记当前卡片是否已完成

// 按 sessionId 缓存进度状态，解决切换会话后进度卡片消失的问题
interface SessionProgressState {
    items: Array<{ icon: string; text: string; isThinking: boolean; detail?: string }>;
    title: string;
}
const sessionProgressCache = new Map<string, SessionProgressState>();
// 获取或创建运行过程卡片
function getProgressCard(): HTMLElement {
    // 如果当前卡片已完成或不存在，创建新卡片
    if (isProgressFinished || !currentProgressCard || !currentProgressCard.parentElement) {
        // 创建新的折叠式卡片
        const card = document.createElement('div');
        card.className = 'progress-card'; // 只用 progress-card，避免继承 message 样式
        card.innerHTML = `
            <div class="progress-card-header">
                <span class="progress-card-icon">
                    <svg class="spinning-loader" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 12a9 9 0 1 1-6.219-8.56" stroke-linecap="round"/>
                    </svg>
                </span>
                <span class="progress-card-title">${t('app.running')}</span>
                <span class="progress-card-count">0</span>
                <span class="progress-card-toggle">▾</span>
            </div>
            <div class="progress-card-body"></div>
        `;

        // 点击折叠/展开
        const header = card.querySelector('.progress-card-header') as HTMLElement;
        header.addEventListener('click', () => {
            card.classList.toggle('collapsed');
            const toggle = card.querySelector('.progress-card-toggle') as HTMLElement;
            toggle.textContent = card.classList.contains('collapsed') ? '▸' : '▾';
        });

        // 插入位置：如果已有活跃的流式消息，进度卡片应在流式消息之前
        // （云端 Agent 可能先发 token 再发 tool 事件，确保进度卡片在回复内容上方）
        if (streamingMessageEl && streamingMessageEl.parentElement === messagesContainer) {
            messagesContainer.insertBefore(card, streamingMessageEl);
        } else {
            messagesContainer.appendChild(card);
        }
        scrollToBottom();
        currentProgressCard = card;
        progressItems = [];
        isProgressFinished = false; // 标记为进行中
    }

    return currentProgressCard;
}

// 更新进度卡片头部标题（使用 LLM 描述文字）
function updateProgressCardTitle(description: string): void {
    const card = getProgressCard();
    const titleEl = card.querySelector('.progress-card-title') as HTMLElement;
    // 截取首行，去掉多余空格
    const firstLine = description.split('\n')[0].trim();
    titleEl.textContent = firstLine.slice(0, 100) + (firstLine.length > 100 ? '...' : '');
}

// 在聊天窗口添加运行过程项（折叠式卡片内）
function addProgressToChat(icon: string, text: string, isThinking: boolean = false, detail?: string): void {
    const card = getProgressCard();
    const body = card.querySelector('.progress-card-body') as HTMLElement;
    const countEl = card.querySelector('.progress-card-count') as HTMLElement;

    // 添加项
    progressItems.push({ icon, text, isThinking, detail });
    countEl.textContent = String(progressItems.length);

    const item = document.createElement('div');
    item.className = `progress-item${isThinking ? ' thinking' : ''}`;
    item.innerHTML = `
        <span class="progress-icon">${icon}</span>
        <span class="progress-text">${escapeHtml(text)}</span>
        ${detail ? `<span class="progress-detail">${escapeHtml(detail)}</span>` : ''}
    `;
    body.appendChild(item);

    // 字幕效果：平滑滚动 body 到底部，旧条目自然上移并被顶部遮罩渐隐
    body.scrollTo({ top: body.scrollHeight, behavior: 'smooth' });

    // 更新标题为最新操作（tool_start 事件的描述优先，此处作为具体工具执行时的细化更新）
    const titleEl = card.querySelector('.progress-card-title') as HTMLElement;
    titleEl.textContent = isThinking ? t('app.thinking') : text.slice(0, 80) + (text.length > 80 ? '...' : '');

    scrollToBottom();
}

// 完成当前运行过程卡片
function finishProgressCard(): void {
    if (currentProgressCard) {
        const titleEl = currentProgressCard.querySelector('.progress-card-title') as HTMLElement;
        const iconEl = currentProgressCard.querySelector('.progress-card-icon') as HTMLElement;
        titleEl.textContent = `${t('app.completed')} (${progressItems.length} ${t('app.steps')})`;
        iconEl.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`;
        // 折叠完成的卡片
        currentProgressCard.classList.add('collapsed');
        const toggle = currentProgressCard.querySelector('.progress-card-toggle') as HTMLElement;
        if (toggle) toggle.textContent = '▸';
    }
    // 标记为已完成，下次会创建新卡片
    isProgressFinished = true;
    currentProgressCard = null;
    // 清理当前会话的进度缓存
    if (currentSessionId) sessionProgressCache.delete(currentSessionId);
}

// 切换进度卡片图标为白洞（LLM 输出时）
function setProgressWhitehole(): void {
    if (currentProgressCard) {
        const iconEl = currentProgressCard.querySelector('.progress-card-icon') as HTMLElement;
        const hole = iconEl.querySelector('.cosmic-hole');
        if (hole) {
            hole.classList.remove('blackhole');
            hole.classList.add('whitehole');
        }
        const titleEl = currentProgressCard.querySelector('.progress-card-title') as HTMLElement;
        titleEl.textContent = t('chat.generating_title');
    }
}

// 切换进度卡片图标为黑洞（工具执行时）
function setProgressBlackhole(): void {
    if (currentProgressCard) {
        const iconEl = currentProgressCard.querySelector('.progress-card-icon') as HTMLElement;
        const hole = iconEl.querySelector('.cosmic-hole');
        if (hole) {
            hole.classList.remove('whitehole');
            hole.classList.add('blackhole');
        }
    }
}

// 清空日志（兼容旧接口）
function clearLogs(): void {
    clearArtifacts();
}

// 渲染日志列表（兼容旧接口，不再显示在右侧栏）
function renderLogs(_logs: Array<{ tool: string; action?: string; args?: Record<string, unknown> }>): void {
    // 日志不再显示在右侧栏，这里留空
}

// 从参数中提取友好描述信息（面向非技术用户）
function getToolLog(tool: string, args?: Record<string, unknown>): { icon: string; text: string } {
    const action = (args?.action as string) || '';
    const subAction = (args?.subAction as string) || '';

    switch (tool) {
        case 'windows': {
            if (action === 'system') return { icon: '💻', text: '获取系统信息' };
            if (action === 'clipboard') return { icon: '📋', text: subAction === 'write' ? '写入剪贴板' : '读取剪贴板' };
            if (action === 'notification') return { icon: '🔔', text: `${t('tool.send_notification')}: ${args?.title || ''}` };
            if (action === 'window') {
                const winTitle = (args?.windowTitle as string) || '';
                if (subAction === 'activate') return { icon: '🪟', text: `切换到窗口: ${winTitle}` };
                if (subAction === 'list' || subAction === 'find') return { icon: '🔍', text: `查找窗口${winTitle ? ': ' + winTitle : ''}` };
                if (subAction === 'close') return { icon: '❌', text: `关闭窗口: ${winTitle}` };
                return { icon: '🪟', text: `窗口操作: ${winTitle || subAction}` };
            }
            if (action === 'powershell') return { icon: '⚡', text: '执行系统命令' };
            return { icon: '🖥️', text: '系统操作' };
        }

        case 'filesystem': {
            const path = (args?.path as string) || (args?.dir as string) || '';
            const filename = path.split(/[/\\]/).pop() || path;
            const ext = filename.split('.').pop()?.toLowerCase() || '';
            const friendlyName = filename.length > 30 ? filename.slice(0, 27) + '...' : filename;

            if (action === 'list') return { icon: '📂', text: `浏览文件夹` };
            if (action === 'read') return { icon: '📖', text: `读取文件: ${friendlyName}` };
            if (action === 'write') {
                const fileDesc = getFileTypeDesc(ext, filename);
                return { icon: '💾', text: `保存${fileDesc}: ${friendlyName}` };
            }
            if (action === 'delete') return {
                icon: '🗑️', text: `删除: ${friendlyName}`
            };
            if (action === 'exists' || action === 'info') return { icon: '🔍', text: `检查文件: ${friendlyName}` };
            if (action === 'mkdir') return { icon: '📁', text: `创建文件夹` };
            if (action === 'copy') return { icon: '📄', text: `复制文件: ${friendlyName}` };
            if (action === 'move') return { icon: '📄', text: `移动文件: ${friendlyName}` };
            return { icon: '📄', text: `文件操作(${action}): ${friendlyName}` };
        }

        case 'process': {
            const cmd = (args?.command as string) || (args?.name as string) || '';
            if (action === 'run' || action === 'shell') {
                return { icon: '⚙️', text: describeCommand(cmd) };
            }
            if (action === 'spawn') return { icon: '⚙️', text: '启动后台进程' };
            if (action === 'list') return { icon: '📋', text: '查看运行中的进程' };
            if (action === 'kill') return {
                icon: '⚡', text: '终止进程'
            };
            return { icon: '⚙️', text: '执行操作' };
        }

        case 'opencode': {
            const cmd = (args?.command as string) || '';
            if (action === 'run') {
                return { icon: '⚙️', text: describeCommand(cmd) };
            }
            return { icon: '⚙️', text: '执行代码' };
        }

        case 'spawn': {
            const task = (args?.task as string) || '';
            const shortTask = task.length > 30 ? task.slice(0, 27) + '...' : task;
            return { icon: '🔀', text: `子任务: ${shortTask}` };
        }

        case 'browser': {
            if (action === 'navigate') {
                const url = (args?.url as string) || '';
                const domain = url.replace(/https?:\/\//, '').split('/')[0] || url;
                return { icon: '🌐', text: `打开网页: ${domain}` };
            }
            if (action === 'screenshot') return { icon: '📸', text: '截取网页截图' };
            if (action === 'click') return { icon: '👆', text: '点击页面元素' };
            if (action === 'type') return { icon: '⌨️', text: t('tool.type_content') };
            if (action === 'content') return { icon: '📃', text: '获取页面内容' };
            if (action === 'snapshot') return { icon: '📃', text: '分析页面结构' };
            if (action === 'evaluate') return {
                icon: '💻', text: '执行页面脚本'
            };
            if (action === 'scroll') return { icon: '📜', text: '滚动页面' };
            if (action === 'wait') return {
                icon: '⏳', text: '等待页面加载'
            };
            return { icon: '🌐', text: `浏览器操作: ${action}` };
        }

        case 'desktop': {
            if (action === 'screen' || action === 'capture') return { icon: '📸', text: '截取屏幕' };
            if (action === 'keyboard') return { icon: '⌨️', text: t('tool.keyboard_input') };
            if (action === 'mouse') return {
                icon: '🖱️', text: '鼠标操作'
            };
            if (action === 'window') return { icon: '🪟', text: '窗口操作' };
            return {
                icon: '🖥️', text: '桌面操作'
            };
        }

        case 'scheduler': {
            if (action === 'create') return {
                icon: '📅', text: '创建定时任务'
            };
            if (action === 'list') return { icon: '📋', text: '查看定时任务' };
            if (action === 'delete') return {
                icon: '🗑️', text: '删除定时任务'
            };
            if (action === 'update') return { icon: '✏️', text: '更新定时任务' };
            return {
                icon: '📅', text: '管理定时任务'
            };
        }

        case 'web_search': {
            const query = (args?.query as string) || '';
            return { icon: '🔍', text: `搜索: ${query.slice(0, 40)}${query.length > 40 ? '...' : ''}` };
        }

        case 'web_fetch': {
            const url = (args?.url as string) || '';
            const domain = url.replace(/https?:\/\//, '').split('/')[0] || url;
            return { icon: '📥', text: `获取网页: ${domain}` };
        }

        case 'sessions_spawn': {
            const targetAgent = (args?.agentId as string) || '';
            const taskDesc = (args?.task as string) || '';
            const shortTask = taskDesc.length > 25 ? taskDesc.slice(0, 22) + '...' : taskDesc;
            if (args?.batch) {
                const batchArr = args.batch as unknown[];
                return { icon: '🚀', text: `并行派发 ${batchArr.length} 个子任务` };
            }
            return { icon: '🚀', text: `${t('tool.dispatch_subtask')}${targetAgent ? ' → ' + targetAgent : ''}: ${shortTask}` };
        }

        case 'sessions_send': {
            const sendAction = (args?.action as string) || '';
            if (sendAction === 'status') return { icon: '📊', text: '查询子任务状态' };
            if (sendAction === 'waitAll') return { icon: '⏳', text: '等待子任务完成' };
            if (sendAction === 'send') return { icon: '💬', text: '发送消息到子任务' };
            return { icon: '📡', text: `协作通信: ${sendAction}` };
        }

        default:
            return {
                icon: '⚙️', text: `执行操作: ${tool}${action ? ' / ' + action : ''}`
            };
    }
}

/** 从工具执行结果中提取关键信息摘要 */
function getToolResultSummary(tool: string, args?: Record<string, unknown>, result?: unknown): string {
    if (!result || typeof result !== 'object') return '';
    const r = result as Record<string, unknown>;

    // Error check — keep error info but without emoji
    if (r.error) return String(r.error).slice(0, 60);

    switch (tool) {
        case 'filesystem': {
            const action = args?.action as string;
            if (action === 'write' && r.success) {
                const size = r.size || r.bytesWritten;
                return size ? formatBytes(size as number) : '';
            }
            if (action === 'read' && typeof r.content === 'string') {
                return `${(r.content.length / 1000).toFixed(1)}K`;
            }
            return '';
        }
        case 'web_search': {
            const results = r.results as unknown[];
            return results ? `${results.length} results` : '';
        }
        case 'web_fetch': {
            const content = r.content as string || r.text as string;
            if (content) return `${(content.length / 1000).toFixed(1)}K`;
            return '';
        }
        case 'process':
        case 'opencode': {
            const exitCode = r.exitCode ?? r.code;
            if (exitCode !== undefined && exitCode !== 0) return `exit ${exitCode}`;
            if (r.pid) return `PID: ${r.pid}`;
            return '';
        }
        case 'browser': {
            const action = args?.action as string;
            if (action === 'navigate') return r.title ? String(r.title).slice(0, 30) : '';
            return '';
        }
        case 'spawn': {
            if (typeof r === 'object' && r.output) {
                const out = String(r.output);
                return out.slice(0, 40) + (out.length > 40 ? '...' : '');
            }
            return '';
        }
        default:
            return '';
    }
}

/** 格式化文件大小 */
function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 根据文件扩展名返回友好的文件类型描述 */
function getFileTypeDesc(ext: string, filename: string): string {
    const typeMap: Record<string, string> = {
        'py': '脚本', 'js': '脚本', 'ts': '脚本', 'sh': '脚本', 'bat': '脚本',
        'pptx': 'PPT', 'ppt': 'PPT',
        'xlsx': 'Excel表格', 'xls': 'Excel表格', 'csv': '表格',
        'docx': 'Word文档', 'doc': 'Word文档',
        'pdf': 'PDF文档',
        'png': '图片', 'jpg': '图片', 'jpeg': '图片', 'gif': '图片', 'svg': '图片', 'webp': '图片',
        'mp4': '视频', 'webm': '视频', 'avi': '视频', 'mov': '视频',
        'mp3': '音频', 'wav': '音频',
        'zip': '压缩包', 'rar': '压缩包', '7z': '压缩包',
        'html': '网页', 'css': '样式表',
        'json': '配置', 'yaml': '配置', 'yml': '配置', 'toml': '配置',
        'md': '文档', 'txt': '文本',
    };
    return typeMap[ext] || '文件';
}

/** 从命令字符串推断友好描述 */
function describeCommand(cmd: string): string {
    const lowerCmd = cmd.toLowerCase();

    // pip / conda 安装
    if (/^(pip|pip3|conda)\s+install\b/i.test(cmd)) {
        const pkg = cmd.match(/install\s+([^\s-]+)/)?.[1] || '';
        return `安装依赖${pkg ? ': ' + pkg : ''}`;
    }

    // Python 内联脚本，分析 import 推断用途
    if (/^python[23]?\s+-c\s/i.test(cmd)) {
        if (/pptx|Presentation/i.test(cmd)) return '生成PPT演示文稿';
        if (/openpyxl|xlsxwriter|Workbook/i.test(cmd)) return '生成Excel表格';
        if (/docx|Document/i.test(cmd)) return '生成Word文档';
        if (/matplotlib|plotly|seaborn|chart/i.test(cmd)) return '生成图表';
        if (/PIL|Pillow|cv2|opencv/i.test(cmd)) return '处理图片';
        if (/requests|urllib|httpx|aiohttp/i.test(cmd)) return '获取网络数据';
        if (/pandas|numpy|scipy/i.test(cmd)) return '数据处理';
        if (/pdf|reportlab|fpdf/i.test(cmd)) return '生成PDF文档';
        if (/selenium|playwright/i.test(cmd)) return '自动化浏览器操作';
        if (/smtp|email/i.test(cmd)) return '发送邮件';
        if (/sqlite|mysql|postgres/i.test(cmd)) return '数据库操作';
        return '执行Python脚本';
    }

    // Python 脚本文件
    if (/^python[23]?\s+[\w/\\.-]+\.py/i.test(cmd)) {
        const scriptName = cmd.match(/[\w/\\.-]+\.py/)?.[0]?.split(/[/\\]/).pop() || '';
        return `运行脚本: ${scriptName}`;
    }

    // node 脚本
    if (/^node\s/i.test(cmd)) return '运行Node脚本';

    // npm / pnpm / yarn
    if (/^(npm|pnpm|yarn)\s/i.test(cmd)) {
        if (/install/i.test(cmd)) return '安装项目依赖';
        if (/run\s+build/i.test(cmd)) return '构建项目';
        if (/run\s+dev/i.test(cmd)) return '启动开发服务器';
        if (/run\s+test/i.test(cmd)) return '运行测试';
        return '执行包管理命令';
    }

    // git 操作
    if (/^git\s/i.test(cmd)) {
        if (/clone/i.test(cmd)) return '克隆代码仓库';
        if (/pull/i.test(cmd)) return '拉取最新代码';
        if (/push/i.test(cmd)) return '推送代码';
        if (/commit/i.test(cmd)) return '提交代码';
        if (/status/i.test(cmd)) return '检查代码状态';
        return '执行Git操作';
    }

    // 目录操作
    if (/^(mkdir|md)\s/i.test(cmd)) return '创建文件夹';
    if (/^(rmdir|rd)\s/i.test(cmd)) return '删除文件夹';
    if (/^(del|rm)\s/i.test(cmd)) return '删除文件';
    if (/^(copy|cp|xcopy)\s/i.test(cmd)) return '复制文件';
    if (/^(move|mv)\s/i.test(cmd)) return '移动文件';
    if (/^(dir|ls)\s/i.test(cmd)) return '查看文件列表';
    if (/^(type|cat)\s/i.test(cmd)) return '查看文件内容';
    if (/^(curl|wget)\s/i.test(cmd)) return '下载文件';
    if (/^chcp\s/i.test(cmd)) return '设置编码';

    // 通用：显示完整命令（去除 chcp 前缀，过长时截断）
    let displayCmd = cmd.replace(/^chcp\s+\d+\s*>?\s*nul\s*&&\s*/i, '').trim();
    if (displayCmd.length > 60) {
        displayCmd = displayCmd.slice(0, 57) + '...';
    }
    return `执行命令: ${displayCmd}`;
}

// 检查是否是成果物（文件写入、代码执行生成的文件等）
// 已添加过的成果物路径集合（防重复）
const addedArtifactPaths = new Set<string>();

/** 规范化文件路径：统一为反斜杠（Windows 原生格式），用于去重比较 */
function normalizePath(p: string): string {
    return p.replace(/\//g, '\\');
}

/** 检查路径是否已添加（规范化后比较） */
function isPathAdded(p: string): boolean {
    return addedArtifactPaths.has(normalizePath(p));
}

/** 标记路径为已添加 */
function markPathAdded(p: string): void {
    addedArtifactPaths.add(normalizePath(p));
}

function isArtifactTool(tool: string, args?: Record<string, unknown>, result?: unknown): Artifact | Artifact[] | null {
    const action = (args?.action as string) || '';
    const collected: Artifact[] = [];

    // filesystem.write 产生的文件，优先使用 result.data.path（已解析绝对路径）
    if (tool === 'filesystem' && action === 'write') {
        const data = (result as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
        const resolvedPath = normalizePath((data?.path as string) || (args?.path as string) || '');
        if (resolvedPath && !isPathAdded(resolvedPath)) {
            markPathAdded(resolvedPath);
            return {
                type: 'file',
                path: resolvedPath,
                filename: resolvedPath.split(/[/\\]/).pop() || '文件',
                size: (data?.size as number) || undefined,
                timestamp: Date.now(),
            };
        }
    }

    // filesystem.copy 产生的文件，优先使用 result.data.destination（已解析绝对路径）
    if (tool === 'filesystem' && action === 'copy') {
        const data = (result as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
        const resolvedDest = normalizePath((data?.destination as string) || (args?.destination as string) || '');
        if (resolvedDest && !isPathAdded(resolvedDest)) {
            markPathAdded(resolvedDest);
            return {
                type: 'file',
                path: resolvedDest,
                filename: resolvedDest.split(/[/\\]/).pop() || '文件',
                timestamp: Date.now(),
            };
        }
    }

    // filesystem.info 不应产生成果物（仅查询文件信息，非生成操作）

    // process.run / opencode.run 执行后检测到的新文件（file-snapshot 机制）
    if ((tool === 'process' || tool === 'opencode') && result) {
        const data = (result as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
        const generatedFiles = data?.generatedFiles as Array<{ path: string; fullPath: string; size: number }> | undefined;
        if (generatedFiles?.length) {
            for (const f of generatedFiles) {
                const fp = normalizePath(f.fullPath);
                if (!isPathAdded(fp)) {
                    markPathAdded(fp);
                    collected.push({
                        type: 'file',
                        path: fp,
                        filename: f.path.split(/[/\\]/).pop() || f.path,
                        size: f.size,
                        timestamp: Date.now(),
                    });
                }
            }
        }

        // 备用检测：从 stdout 中识别常见文件输出路径模式
        if (collected.length === 0 && data) {
            const stdout = (data.stdout as string) || '';
            // 匹配 Windows ?Unix 路径中带常见扩展名的文件
            const pathRegex = /(?:[A-Z]:[/\\]|\/)[^\s"'<>|*?\n]+\.(?:pptx?|docx?|xlsx?|pdf|png|jpg|jpeg|gif|svg|mp4|mp3|zip|csv|html)\b/gi;
            const matches = stdout.match(pathRegex);
            if (matches) {
                const uniquePaths = [...new Set(matches.map(normalizePath))];
                for (const p of uniquePaths) {
                    if (!isPathAdded(p)) {
                        markPathAdded(p);
                        collected.push({
                            type: 'file',
                            path: p,
                            filename: p.split(/[/\\]/).pop() || p,
                            timestamp: Date.now(),
                        });
                    }
                }
            }
        }

        // 备用检测：从 command 中识别输出文件路径（如 cp/copy 命令的目标）
        if (collected.length === 0 && data) {
            const cmd = (data.command as string) || '';
            const cpMatch = cmd.match(/(?:^|\s)(?:cp|copy)\s+.+?\s+(.+\.(?:pptx?|docx?|xlsx?|pdf|png|jpg|zip))\s*$/i);
            if (cpMatch) {
                const dest = normalizePath(cpMatch[1].replace(/^["']|["']$/g, ''));
                if (dest && !isPathAdded(dest)) {
                    markPathAdded(dest);
                    collected.push({
                        type: 'file',
                        path: dest,
                        filename: dest.split(/[/\\]/).pop() || dest,
                        timestamp: Date.now(),
                    });
                }
            }
        }
    }

    // office 工具（excel/word/pdf/csv）的 create/write 操作产生的文件
    if (tool === 'office') {
        const subAction = (args?.subAction as string) || '';
        if (subAction === 'create' || subAction === 'write') {
            const data = (result as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
            const filePath = normalizePath((data?.file as string) || (args?.filePath as string) || '');
            if (filePath && !isPathAdded(filePath)) {
                markPathAdded(filePath);
                collected.push({
                    type: 'file',
                    path: filePath,
                    filename: filePath.split(/[/\\]/).pop() || '文件',
                    size: undefined,
                    timestamp: Date.now(),
                });
            }
        }
    }

    return collected.length > 1 ? collected : collected.length === 1 ? collected[0] : null;
}

// 注意：进度事件现在通过 Gateway ?onProgress 回调处理，见 handleGatewayProgress 函数

// ========== 调度器视图（中部区域）==========

let schedulerViewActive = false;
let selectedTaskId: string | null = null;
let cachedTasks: ScheduledTaskView[] = [];
let countdownTimerId: ReturnType<typeof setInterval> | null = null;
const schedulerToastContainer = document.getElementById('scheduler-toast-container') as HTMLDivElement;

/** 显示调度器 Toast 通知 */
function showSchedulerToast(icon: string, title: string, desc: string, taskId?: string): void {
    const toast = document.createElement('div');
    toast.className = 'scheduler-toast';
    toast.innerHTML = `
        <span class="scheduler-toast-icon">${icon}</span>
        <div class="scheduler-toast-body">
            <div class="scheduler-toast-title">${escapeHtml(title)}</div>
            <div class="scheduler-toast-desc">${escapeHtml(desc)}</div>
        </div>
    `;
    // 点击跳转到调度器详情
    if (taskId) {
        toast.addEventListener('click', () => {
            toast.remove();
            if (!schedulerViewActive) toggleSchedulerView();
            setTimeout(() => showSchedulerDetail(taskId), 100);
        });
    }
    schedulerToastContainer.appendChild(toast);
    // 自动消失
    setTimeout(() => {
        toast.classList.add('leaving');
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// 切换调度器视图（在中部区域显示/隐藏）
function toggleSchedulerView(): void {
    schedulerViewActive = !schedulerViewActive;

    if (schedulerViewActive) {
        // 如果设置视图激活，先关闭
        closeSettingsView();
        // 隐藏聊天消息和输入区，显示调度器视图
        messagesContainer.classList.add('hidden');
        (document.querySelector('.input-area') as HTMLElement).classList.add('hidden');
        hideRouterBindUI(); // 隐藏 Router 绑定区域（fixed 定位不受父容器影响）
        schedulerView.classList.remove('hidden');
        schedulerBtn.classList.add('active');
        // 回到列表视图
        showSchedulerList();
        loadSchedulerData();
        startCountdownTimer();
    } else {
        // 恢复聊天
        messagesContainer.classList.remove('hidden');
        (document.querySelector('.input-area') as HTMLElement).classList.remove('hidden');
        schedulerView.classList.add('hidden');
        schedulerBtn.classList.remove('active');
        selectedTaskId = null;
        stopCountdownTimer();
        // 恢复 Router 绑定 UI（如果当前是 Router 会话且未绑定）
        if (isRouterSession) showRouterBindUI();
    }
}

// 启动倒计时刷新（每秒更新）
function startCountdownTimer(): void {
    stopCountdownTimer();
    countdownTimerId = setInterval(updateCountdowns, 1000);
}

// 停止倒计时刷新
function stopCountdownTimer(): void {
    if (countdownTimerId) {
        clearInterval(countdownTimerId);
        countdownTimerId = null;
    }
}

// 每秒更新所有倒计时元素
function updateCountdowns(): void {
    const now = Date.now();
    document.querySelectorAll('[data-countdown-ts]').forEach(el => {
        const ts = parseInt((el as HTMLElement).dataset.countdownTs || '0', 10);
        (el as HTMLElement).textContent = formatCountdown(ts, now);
    });
}

// 格式化倒计时
function formatCountdown(targetTs: number, nowTs: number): string {
    const diff = targetTs - nowTs;
    if (diff <= 0) return '即将执行';

    const totalSec = Math.floor(diff / 1000);
    const d = Math.floor(totalSec / 86400);
    const h = Math.floor((totalSec % 86400) / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;

    if (d > 0) return `${d}天${h}时${m}分${s}秒后`;
    if (h > 0) return `${h}时${m}分${s}秒后`;
    if (m > 0) return `${m}分${s}秒后`;
    return `${s}秒后`;
}

// 返回任务列表（恢复所有卡片，隐藏内联详情）
function showSchedulerList(): void {
    selectedTaskId = null;
    // 恢复所有卡片可见
    schedulerTasks.querySelectorAll('.scheduler-task-card').forEach(card => {
        (card as HTMLElement).classList.remove('hidden');
    });
    // 隐藏内联详情
    schedulerInlineDetail.classList.add('hidden');
    // 退出详情模式
    schedulerTasksWrapper.classList.remove('detail-mode');
    // 恢复 header 按钮
    schedulerRefreshBtn.classList.remove('hidden');
    const backBtn = document.getElementById('scheduler-header-back-btn');
    if (backBtn) backBtn.remove();
}

// 选中一条任务：隐藏其他卡片，在选中卡片下方显示执行记录
function showSchedulerDetail(taskId: string): void {
    selectedTaskId = taskId;

    // 隐藏其他卡片，保留选中卡片
    schedulerTasks.querySelectorAll('.scheduler-task-card').forEach(card => {
        const el = card as HTMLElement;
        if (el.dataset.taskId === taskId) {
            el.classList.remove('hidden');
        } else {
            el.classList.add('hidden');
        }
    });

    // 进入详情模式
    schedulerTasksWrapper.classList.add('detail-mode');
    // 显示内联详情
    schedulerInlineDetail.classList.remove('hidden');
    renderInlineDetail(taskId);
    loadTaskRuns(taskId);

    // header：隐藏刷新按钮，显示返回按钮
    schedulerRefreshBtn.classList.add('hidden');
    if (!document.getElementById('scheduler-header-back-btn')) {
        const backBtn = document.createElement('button');
        backBtn.id = 'scheduler-header-back-btn';
        backBtn.className = 'icon-btn-sm';
        backBtn.title = t('scheduler.back_to_list');
        backBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>`;
        backBtn.addEventListener('click', () => {
            showSchedulerList();
            loadSchedulerData();
        });
        // 插入到 header 左侧（h3 之前）
        const header = schedulerListView.querySelector('.scheduler-view-header');
        if (header) header.insertBefore(backBtn, header.firstChild);
    }
}

// 加载调度器数据（任务列表）
async function loadSchedulerData(): Promise<void> {
    if (!gatewayClient) return;
    try {
        cachedTasks = await gatewayClient.getSchedulerTasks();
        renderSchedulerTasks(cachedTasks);
    } catch (error) {
        console.error('[Scheduler] Load data failed:', error);
    }
}

// 加载指定任务的执行记录
async function loadTaskRuns(taskId: string): Promise<void> {
    if (!gatewayClient) return;
    try {
        const runs = await gatewayClient.getSchedulerRuns(taskId, 50);
        renderInlineRuns(runs);
    } catch (error) {
        console.error('[Scheduler] Load run history failed:', error);
    }
}

// 渲染任务列表（中部大面积卡片）
function renderSchedulerTasks(tasks: ScheduledTaskView[]): void {
    if (tasks.length === 0) {
        schedulerTasks.innerHTML = `
            <div class="scheduler-empty">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3">
                    <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                </svg>
                <p>暂无定时任务</p>
                <span>通过对话创建，例如："每天9点帮我检查邮件"</span>
            </div>`;
        return;
    }

    const now = Date.now();

    schedulerTasks.innerHTML = tasks.map(task => {
        const triggerText = formatTriggerDisplay(task.trigger);
        const statusClass = task.status;
        const statusLabel = {
            active: '运行中', paused: '已暂停', completed: '已完成', error: '出错'
        }[task.status] || task.status;

        // 下次执行：实时倒计时
        let nextRunHtml: string;
        if (task.nextRunAt) {
            const countdown = formatCountdown(task.nextRunAt, now);
            nextRunHtml = `<span class="scheduler-task-countdown" data-countdown-ts="${task.nextRunAt}">${countdown}</span>`;
        } else {
            nextRunHtml = '<span>-</span>';
        }

        // 最后执行结果图标
        const lastResultIcon = task.runCount > 0
            ? (task.failCount > 0 && task.failCount === task.runCount ? '❌' : '✅')
            : '';

        return `
            <div class="scheduler-task-card" data-task-id="${task.id}">
                <div class="scheduler-task-card-left">
                    <div class="scheduler-task-card-name">${escapeHtml(task.name)}${lastResultIcon ? `<span class="scheduler-task-last-result">${lastResultIcon}</span>` : ''}</div>
                    <div class="scheduler-task-card-meta">
                        <span class="scheduler-task-trigger-badge">
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                            </svg>
                            ${escapeHtml(triggerText)}
                        </span>
                        <span class="scheduler-task-card-sep">·</span>
                        <span>执行 ${task.runCount} 次</span>
                        <span class="scheduler-task-card-sep">·</span>
                        ${nextRunHtml}
                    </div>
                </div>
                <span class="scheduler-task-status-badge ${statusClass}">${statusLabel}</span>
            </div>
        `;
    }).join('');

    // 绑定卡片点击 ?进入详情
    schedulerTasks.querySelectorAll('.scheduler-task-card').forEach(card => {
        card.addEventListener('click', () => {
            const taskId = (card as HTMLElement).dataset.taskId;
            if (taskId) showSchedulerDetail(taskId);
        });
    });
}

// 渲染内联详情（操作按钮 + 执行记录，显示在选中卡片下方）
function renderInlineDetail(taskId: string): void {
    const task = cachedTasks.find(t => t.id === taskId);
    if (!task) return;

    // 操作按钮
    const actions: string[] = [];
    if (task.status === 'active') {
        actions.push(`<button class="scheduler-detail-action-btn" data-action="pause" title="${t('scheduler.pause')}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>
            </svg>暂停</button>`);
    }
    if (task.status === 'paused') {
        actions.push(`<button class="scheduler-detail-action-btn" data-action="resume" title="${t('scheduler.resume')}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>恢复</button>`);
    }
    actions.push(`<button class="scheduler-detail-action-btn" data-action="trigger" title="${t('scheduler.trigger')}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
        </svg>立即执行</button>`);
    actions.push(`<button class="scheduler-detail-action-btn danger" data-action="delete" title="${t('common.delete')}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14H7L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>
        </svg>删除</button>`);
    schedulerInlineActions.innerHTML = actions.join('');

    // 绑定操作按钮
    schedulerInlineActions.querySelectorAll('.scheduler-detail-action-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const action = (btn as HTMLElement).dataset.action;
            if (!action || !gatewayClient) return;
            try {
                switch (action) {
                    case 'pause': await gatewayClient.pauseSchedulerTask(taskId); break;
                    case 'resume': await gatewayClient.resumeSchedulerTask(taskId); break;
                    case 'delete':
                        await gatewayClient.deleteSchedulerTask(taskId);
                        showSchedulerList();
                        await loadSchedulerData();
                        return;
                    case 'trigger': await gatewayClient.triggerSchedulerTask(taskId); break;
                }
                // 刷新
                await loadSchedulerData();
                renderInlineDetail(taskId);
                await loadTaskRuns(taskId);
            } catch (error) {
                console.error(`[Scheduler] ${action} failed:`, error);
            }
        });
    });
}

// 渲染内联执行记录（可展开 output）
function renderInlineRuns(runs: TaskRunView[]): void {
    if (runs.length === 0) {
        schedulerInlineRuns.innerHTML = '<div class="empty-state" style="padding:24px 0;opacity:0.4;">' + t('scheduler.no_runs_inline') + '</div>';
        return;
    }

    schedulerInlineRuns.innerHTML = runs.map(run => {
        const dotClass = run.status;
        const time = new Date(run.startedAt).toLocaleString('zh-CN');
        const duration = run.duration ? `${(run.duration / 1000).toFixed(1)}s` : '-';
        const statusText = {
            completed: t('common.success'), failed: t('common.failed'), running: t('scheduler.running')
        }[run.status] || run.status;

        // output 摘要（截取前 80 字符）
        const outputSummary = run.output
            ? escapeHtml(run.output.replace(/\n/g, ' ').slice(0, 80)) + (run.output.length > 80 ? '…' : '')
            : '';
        const hasOutput = !!(run.output || run.error);

        // output 完整内容（markdown 渲染）
        const outputHtml = run.output
            ? renderMarkdown(run.output)
            : run.error
                ? `<span style="color:var(--color-error)">${escapeHtml(run.error)}</span>`
                : '';

        return `
            <div class="scheduler-run-row" data-run-id="${run.id}" ${hasOutput ? 'data-expandable="true"' : ''}>
                <span class="scheduler-run-dot ${dotClass}"></span>
                <span class="scheduler-run-status-text ${dotClass}">${statusText}</span>
                <span class="scheduler-run-time-text">${time}</span>
                <span class="scheduler-run-duration-text">${duration}</span>
                ${outputSummary ? `<span class="scheduler-run-summary">${outputSummary}</span>` : ''}
                ${run.error && !run.output ? `<span class="scheduler-run-error-text" title="${escapeHtml(run.error)}">${escapeHtml(run.error.slice(0, 60))}</span>` : ''}
                ${hasOutput ? `<svg class="scheduler-run-expand-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>` : ''}
                ${hasOutput ? `<div class="scheduler-run-output"><div class="message-content">${outputHtml}</div></div>` : ''}
            </div>
        `;
    }).join('');

    // 绑定展开/收起
    schedulerInlineRuns.querySelectorAll('.scheduler-run-row[data-expandable]').forEach(row => {
        row.addEventListener('click', (e) => {
            // 避免点击内部链接等触发收起
            if ((e.target as HTMLElement).closest('a, code, pre')) return;
            row.classList.toggle('expanded');
        });
    });
}

// 格式化触发器显示文本（人类友好）
function formatTriggerDisplay(trigger: ScheduledTaskView['trigger']): string {
    switch (trigger.type) {
        case 'cron':
            return cronToHuman(trigger.expression || '');
        case 'interval': {
            const ms = trigger.intervalMs || 0;
            const seconds = ms / 1000;
            if (seconds < 60) return `?${seconds} 秒`;
            if (seconds < 3600) return `?${Math.round(seconds / 60)} 分钟`;
            if (seconds < 86400) {
                const h = seconds / 3600;
                return h === Math.floor(h) ? `?${h} 小时` : `?${h.toFixed(1)} 小时`;
            }
            const d = seconds / 86400;
            return d === Math.floor(d) ? `?${d} 天` : `?${d.toFixed(1)} 天`;
        }
        case 'once': {
            // ?ISO 时间转为友好格式
            try {
                const date = new Date(trigger.runAt || '');
                const now = new Date();
                const diffMs = date.getTime() - now.getTime();
                const dateStr = date.toLocaleString('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                if (diffMs > 0 && diffMs < 86400000) {
                    return `今天 ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 执行一次`;
                }
                if (diffMs > 0 && diffMs < 172800000) {
                    return `明天 ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 执行一次`;
                }
                return `${dateStr} 执行一次`;
            } catch {
                return `执行一次: ${trigger.runAt}`;
            }
        }
        default:
            return '未知';
    }
}

/**
 * ?cron 表达式转为中文自然语言
 * 支持 5 段格式 分 时 日 月 周 * 支持 6 段格式 秒 分 时 日 月 周周（自动跳过秒）
 */
function cronToHuman(expr: string): string {
    if (!expr) return '自定义周期';
    let parts = expr.trim().split(/\s+/);
    // 6 段格式：去掉秒字段
    if (parts.length === 6) parts = parts.slice(1);
    if (parts.length < 5) return expr;

    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

    // 常见模式匹配
    const weekdayNames: Record<string, string> = {
        '0': '日', '7': '日', '1': '一', '2': '二', '3': '三', '4': '四', '5': '五', '6': '六',
    };

    const isEvery = (v: string) => v === '*';
    const isFixed = (v: string) => /^\d+$/.test(v);
    const isRange = (v: string) => /^\d+-\d+$/.test(v);
    const isStep = (v: string) => v.includes('/');

    // ?N 分钟
    if (isStep(minute) && isEvery(hour) && isEvery(dayOfMonth) && isEvery(month) && isEvery(dayOfWeek)) {
        const step = minute.split('/')[1];
        return `?${step} 分钟`;
    }

    // ?N 小时
    if (isFixed(minute) && isStep(hour) && isEvery(dayOfMonth) && isEvery(month) && isEvery(dayOfWeek)) {
        const step = hour.split('/')[1];
        return `?${step} 小时`;
    }

    // 构建时间部分
    let timeStr = '';
    if (isFixed(hour) && isFixed(minute)) {
        timeStr = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
    } else if (isFixed(hour) && isEvery(minute)) {
        timeStr = `${hour.padStart(2, '0')} 点`;
    }

    // 每天 HH:MM
    if (timeStr && isEvery(dayOfMonth) && isEvery(month) && isEvery(dayOfWeek)) {
        return `每天 ${timeStr}`;
    }

    // 工作日 HH:MM（1-5）
    if (timeStr && isEvery(dayOfMonth) && isEvery(month) && dayOfWeek === '1-5') {
        return `工作日 ${timeStr}`;
    }

    // 周末 HH:MM（0,6 or 6,0）
    if (timeStr && isEvery(dayOfMonth) && isEvery(month) && (dayOfWeek === '0,6' || dayOfWeek === '6,0')) {
        return `周末 ${timeStr}`;
    }

    // 每周 X HH:MM
    if (timeStr && isEvery(dayOfMonth) && isEvery(month) && (isFixed(dayOfWeek) || dayOfWeek.includes(','))) {
        const days = dayOfWeek.split(',').map(d => weekdayNames[d] || d).join('、');
        if (dayOfWeek.split(',').length === 1) {
            return `每周${days} ${timeStr}`;
        }
        return `每周${days} ${timeStr}`;
    }

    // 每周 X-Y HH:MM
    if (timeStr && isEvery(dayOfMonth) && isEvery(month) && isRange(dayOfWeek)) {
        const [start, end] = dayOfWeek.split('-');
        const s = weekdayNames[start] || start;
        const e = weekdayNames[end] || end;
        return `每周${s}至周${e} ${timeStr}`;
    }

    // 每月 N ?HH:MM
    if (timeStr && isFixed(dayOfMonth) && isEvery(month) && isEvery(dayOfWeek)) {
        return `每月 ${dayOfMonth} ?${timeStr}`;
    }

    // 无法识别，返回带说明的原始表达式
    return `周期: ${expr}`;
}

// 调度器事件绑定
schedulerBtn.addEventListener('click', toggleSchedulerView);
schedulerRefreshBtn.addEventListener('click', loadSchedulerData);

// 点击新建对话时切回聊天视图
newSessionBtn.addEventListener('click', () => {
    if (schedulerViewActive) {
        schedulerViewActive = false;
        messagesContainer.classList.remove('hidden');
        (document.querySelector('.input-area') as HTMLElement).classList.remove('hidden');
        schedulerView.classList.add('hidden');
        schedulerBtn.classList.remove('active');
        selectedTaskId = null;
        stopCountdownTimer();
    }
    // 如果设置视图激活，也切回聊天
    closeSettingsView();
});

// 输入框键盘事件：Enter 发送，Shift+Enter 换行
messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault(); // 阻止默认换行
        sendMessage();
    }
});

// 输入框自动调整高度
messageInput.addEventListener('input', () => {
    // 重置高度以获取正确的 scrollHeight
    messageInput.style.height = 'auto';
    // 设置新高度，最大 200px
    const maxHeight = 200;
    const newHeight = Math.min(messageInput.scrollHeight, maxHeight);
    messageInput.style.height = newHeight + 'px';
    // 如果超过最大高度，显示滚动条
    messageInput.style.overflowY = messageInput.scrollHeight > maxHeight ? 'auto' : 'hidden';
});

// ========================
// 语音功能
// ========================

/** 初始化语音功能 */
async function initVoice(): Promise<void> {
    try {
        voiceStatus = await gatewayClient!.request<any>('voice.get-status');
        ttsAutoPlay = voiceStatus.tts.autoPlay;

        // 同步 UI 状态
        ttsAutoplayToggle.checked = ttsAutoPlay;
        if (voiceStatus.tts.voice) {
            ttsVoiceSelect.value = voiceStatus.tts.voice;
        }

        // 如果 STT 不可用，禁用麦克风按钮和语音对话按钮
        const voiceNotice = document.getElementById('voice-unavailable-notice');
        if (!voiceStatus.stt.available) {
            micBtn.title = t('voice.unavailable');
            micBtn.classList.add('disabled');
            voiceModeBtn.title = t('voice.chat_unavailable');
            voiceModeBtn.classList.add('disabled');
            if (voiceNotice) voiceNotice.style.display = '';
        } else {
            micBtn.classList.remove('disabled');
            voiceModeBtn.classList.remove('disabled');
            if (voiceNotice) voiceNotice.style.display = 'none';
        }

        console.log('[Voice] Voice status:', voiceStatus);
    } catch (error) {
        console.warn('[Voice] Get voice status failed:', error);
    }
}

/** 录音状态变化回调 */
recorder.setStateCallback((state: RecordingState, duration?: number) => {
    switch (state) {
        case 'idle':
            micBtn.classList.remove('recording');
            micIconDefault.classList.remove('hidden');
            micIconRecording.classList.add('hidden');
            recordingIndicator.classList.add('hidden');
            break;
        case 'recording':
            micBtn.classList.add('recording');
            micIconDefault.classList.add('hidden');
            micIconRecording.classList.remove('hidden');
            recordingIndicator.classList.remove('hidden');
            recordingText.textContent = `${t('chat.recording')} ${duration ?? 0}s`;
            break;
        case 'processing':
            recordingText.textContent = t('chat.recognizing');
            break;
    }
});

/** 播放状态变化回调 */
player.setStateCallback((state: PlaybackState, messageId?: string) => {
    if (!messageId) return;

    // 更新对应消息的播放按钮状态
    const btn = document.querySelector(`.tts-play-btn[data-msg-id="${messageId}"]`) as HTMLElement;
    if (!btn) return;

    const iconPlay = btn.querySelector('.tts-icon-play') as SVGElement;
    const iconPause = btn.querySelector('.tts-icon-pause') as SVGElement;
    const iconLoading = btn.querySelector('.tts-icon-loading') as SVGElement;

    // 先全部隐藏
    iconPlay?.classList.add('hidden');
    iconPause?.classList.add('hidden');
    iconLoading?.classList.add('hidden');

    switch (state) {
        case 'idle':
            iconPlay?.classList.remove('hidden');
            btn.classList.remove('active');
            break;
        case 'loading':
            iconLoading?.classList.remove('hidden');
            btn.classList.add('active');
            break;
        case 'playing':
            iconPause?.classList.remove('hidden');
            btn.classList.add('active');
            break;
        case 'paused':
            iconPlay?.classList.remove('hidden');
            btn.classList.add('active');
            break;
    }
});

/** 麦克风按钮点击 */
micBtn.addEventListener('click', async () => {
    if (micBtn.classList.contains('disabled')) {
        // STT 不可用，提示用户
        setStatus('语音识别不可用，请下载模型', 'error');
        setTimeout(() => setStatus(t('titlebar.status_ready'), 'ready'), 3000);
        return;
    }

    const currentState = recorder.getState();

    if (currentState === 'idle') {
        // 开始录音，打断流式 TTS
        streamingTtsManager.cancel();
        try {
            await recorder.start();
        } catch (error) {
            console.error('[Voice] Recording start failed:', error);
            setStatus(t('voice.mic_failed'), 'error');
            setTimeout(() => setStatus(t('titlebar.status_ready'), 'ready'), 3000);
        }
    } else if (currentState === 'recording') {
        // 停止录音并识别
        try {
            const audioData = await recorder.stop();
            setStatus('识别中...', 'running');
            const result = await gatewayClient!.request<any>('voice.transcribe', { audioData: audioData });
            if (result.error) {
                console.error('[Voice] Recognition failed:', result.error);
                setStatus(t('voice.recognition_failed'), 'error');
                setTimeout(() => setStatus(t('titlebar.status_ready'), 'ready'), 3000);
            } else if (result.text) {
                // 将识别文字填入输入框（追加模式）
                const currentText = messageInput.value;
                messageInput.value = currentText ? `${currentText} ${result.text}` : result.text;
                // 触发 input 事件以调整高度
                messageInput.dispatchEvent(new Event('input'));
                messageInput.focus();
                setStatus(t('titlebar.status_ready'), 'ready');
            } else {
                setStatus(t('voice.not_recognized'), 'ready');
                setTimeout(() => setStatus(t('titlebar.status_ready'), 'ready'), 2000);
            }
        } catch (error) {
            console.error('[Voice] Recording/recognition failed:', error);
            setStatus(t('voice.process_failed'), 'error');
            setTimeout(() => setStatus(t('titlebar.status_ready'), 'ready'), 3000);
        }
    }
});

/** TTS 播放按钮点击（事件委托） */
messagesContainer.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest('.tts-play-btn') as HTMLElement;
    if (!btn) return;

    const messageId = btn.getAttribute('data-msg-id');
    if (!messageId) return;

    // 如果当前正在播放同一条消息，切换暂停/播放
    if (player.getCurrentMessageId() === messageId) {
        player.togglePause();
        return;
    }

    // 点击手动播放 → 打断流式 TTS
    streamingTtsManager.cancel();

    // 找到消息内容
    const msgEl = btn.closest('.message') as HTMLElement;
    if (!msgEl) return;

    const contentEl = msgEl.querySelector('.markdown-body');
    if (!contentEl) return;

    // 获取纯文本
    const text = contentEl.textContent || '';
    if (!text.trim()) return;

    // 请求 TTS 合成并播放
    ttsManager.speak(text, messageId);
});

/** TTS 设置 */
ttsAutoplayToggle.addEventListener('change', () => {
    ttsAutoPlay = ttsAutoplayToggle.checked;
    localStorage.setItem('openflux-tts-autoplay', ttsAutoPlay ? '1' : '0');
});

ttsVoiceSelect.addEventListener('change', async () => {
    const voice = ttsVoiceSelect.value;
    try {
        await gatewayClient!.request<any>('voice.set-voice', { voice: voice });
        localStorage.setItem('openflux-tts-voice', voice);
    } catch (error) {
        console.error('[Voice] Toggle voice failed:', error);
    }
});

// 从本地存储恢复语音设置
const savedAutoPlay = localStorage.getItem('openflux-tts-autoplay');
if (savedAutoPlay !== null) {
    ttsAutoPlay = savedAutoPlay === '1';
    ttsAutoplayToggle.checked = ttsAutoPlay;
}
const savedVoice = localStorage.getItem('openflux-tts-voice');
if (savedVoice) {
    ttsVoiceSelect.value = savedVoice;
}

// ========================
// 语音对话模式
// ========================

/** 设置语音覆盖层状态 */
function setVoiceOverlayState(state: 'idle' | 'recording' | 'processing' | 'answering' | 'speaking'): void {
    voiceOverlay.setAttribute('data-state', state);
    switch (state) {
        case 'idle':
            voiceStatusText.textContent = t('voice.click_start');
            voiceBtnMic.classList.remove('hidden');
            voiceBtnStop.classList.add('hidden');
            ambientSound.stop();
            bargeInDetector.stop();
            break;
        case 'recording':
            voiceStatusText.textContent = t('voice.listening');
            voiceBtnMic.classList.add('hidden');
            voiceBtnStop.classList.remove('hidden');
            ambientSound.stop();
            bargeInDetector.stop();
            break;
        case 'processing':
            voiceStatusText.textContent = t('voice.recognizing');
            voiceBtnMic.classList.remove('hidden');
            voiceBtnStop.classList.add('hidden');
            ambientSound.start();
            bargeInDetector.stop();
            break;
        case 'answering':
            voiceStatusText.textContent = t('voice.thinking');
            voiceBtnMic.classList.remove('hidden');
            voiceBtnStop.classList.add('hidden');
            if (!ambientSound.getIsPlaying()) ambientSound.start();
            // 思考/回复中启动语音打断检测
            bargeInDetector.start();
            break;
        case 'speaking':
            voiceStatusText.textContent = t('voice.replying');
            voiceBtnMic.classList.remove('hidden');
            voiceBtnStop.classList.add('hidden');
            ambientSound.stop();
            // 朗读中保持语音打断检测
            if (!bargeInDetector.isActive()) bargeInDetector.start();
            break;
    }
}

/**
 * 打断当前回复（通用打断逻辑） * 取消 TTS + 环境音，自动进入下一轮录音 */
function interruptVoiceResponse(): void {
    const state = voiceOverlay.getAttribute('data-state');
    if (state !== 'speaking' && state !== 'answering') return;

    streamingTtsManager.cancel();
    bargeInDetector.stop();
    ambientSound.stopImmediate();
    setVoiceOverlayState('idle');

    // 快速进入下一轮
    setTimeout(() => {
        if (voiceModeActive) startVoiceRound();
    }, 200);
}

/** 进入语音对话模式 */
function enterVoiceMode(): void {
    if (!voiceStatus?.stt?.available) {
        setStatus('语音识别不可用，请下载模型', 'error');
        setTimeout(() => setStatus(t('titlebar.status_ready'), 'ready'), 3000);
        return;
    }

    voiceModeActive = true;
    voiceOverlay.classList.remove('hidden');
    voiceTranscript.textContent = '';

    // 注册 VAD 自动停止回调：静音后自动结束录音并进入处理
    recorder.setAutoStopCallback(() => {
        if (voiceModeActive && recorder.getState() === 'recording') {
            finishVoiceRound();
        }
    });

    // 注册语音打断回调：TTS 播放中检测到用户说话 ?打断
    bargeInDetector.setCallback(() => {
        if (voiceModeActive) {
            console.log('[VoiceMode] Voice barge-in triggered');
            interruptVoiceResponse();
        }
    });

    // 监听流式 TTS 状态，更新覆盖层
    streamingTtsManager.setStateCallback((ttsState) => {
        if (!voiceModeActive) return;
        const currentState = voiceOverlay.getAttribute('data-state');
        if (ttsState === 'playing' && (currentState === 'answering' || currentState === 'speaking')) {
            setVoiceOverlayState('speaking');
        }
    });

    // 进入后自动开始录音（短暂延迟等待 UI 渲染和麦克风就绪）
    setTimeout(() => {
        if (voiceModeActive) startVoiceRound();
    }, 300);
}

/** 退出语音对话模式 */
function exitVoiceMode(): void {
    voiceModeActive = false;
    recorder.setAutoStopCallback(null);
    bargeInDetector.setCallback(null);
    bargeInDetector.stop();
    recorder.cancel();
    streamingTtsManager.cancel();
    streamingTtsManager.setStateCallback(null);
    ambientSound.stopImmediate();
    voiceOverlay.classList.add('hidden');
    setVoiceOverlayState('idle');
    voiceTranscript.textContent = '';
}

/** 等待当前会话响应完成（LLM 响应完成）*/
function waitForResponseComplete(): Promise<void> {
    return new Promise((resolve) => {
        const check = () => {
            const currentLoading = currentSessionId ? loadingSessions.has(currentSessionId) : false;
            if (!currentLoading || !voiceModeActive) {
                resolve();
            } else {
                setTimeout(check, 200);
            }
        };
        // 延迟一点开始检查，确保 isLoading 已被设为 true
        setTimeout(check, 300);
    });
}

/** 等待流式 TTS 播放完毕 */
function waitForTTSComplete(): Promise<void> {
    return new Promise((resolve) => {
        const check = () => {
            if (!streamingTtsManager.isActive() || !voiceModeActive) {
                resolve();
            } else {
                setTimeout(check, 200);
            }
        };
        setTimeout(check, 300);
    });
}

/** 开始一轮录音（启用 VAD 自动停止）*/
async function startVoiceRound(): Promise<void> {
    if (!voiceModeActive) return;
    try {
        setVoiceOverlayState('recording');
        voiceTranscript.textContent = '';
        await recorder.start({
            vad: true,
            vadSilenceMs: 1500,   // 1.5 秒静音后自动停止
            vadThreshold: 12,     // 音量阈值
            minDurationMs: 800,   // 至少 0.8 秒
        });
    } catch (error) {
        console.error('[VoiceMode] Recording start failed:', error);
        setVoiceOverlayState('idle');
    }
}

/** 完成一轮语音对话（录音结束 → 识别 → 发送 → 等回复 → TTS → 下一轮） */
async function finishVoiceRound(): Promise<void> {
    if (!voiceModeActive) return;

    try {
        // 1. 停止录音 + STT 识别
        setVoiceOverlayState('processing');
        const audioData = await recorder.stop();
        const result = await gatewayClient!.request<any>('voice.transcribe', { audioData: audioData });

        if (!voiceModeActive) return;

        if (result.error || !result.text?.trim()) {
            voiceTranscript.textContent = result.error || t('voice.not_recognized');
            setVoiceOverlayState('idle');
            // 短暂停顿后自动进入下一轮
            setTimeout(() => {
                if (voiceModeActive) startVoiceRound();
            }, 1500);
            return;
        }

        // 2. 显示识别文本
        voiceTranscript.textContent = result.text;

        // 3. 发送消息
        setVoiceOverlayState('answering');
        messageInput.value = result.text;
        messageInput.dispatchEvent(new Event('input'));
        sendMessage();

        // 4. 等待 LLM 响应完成
        await waitForResponseComplete();
        if (!voiceModeActive) return;

        // 5. 等待流式 TTS 播放完毕
        await waitForTTSComplete();
        if (!voiceModeActive) return;

        // 6. 短暂间隔后自动开始下一轮
        setVoiceOverlayState('idle');
        setTimeout(() => {
            if (voiceModeActive) startVoiceRound();
        }, 800);
    } catch (error) {
        console.error('[VoiceMode] Voice conversation turn failed:', error);
        if (voiceModeActive) {
            setVoiceOverlayState('idle');
        }
    }
}

/** 语音对话模式入口按钮 */
voiceModeBtn.addEventListener('click', () => {
    if (voiceModeBtn.classList.contains('disabled')) {
        setStatus('语音服务不可用', 'error');
        setTimeout(() => setStatus(t('titlebar.status_ready'), 'ready'), 3000);
        return;
    }
    enterVoiceMode();
});

/** 关闭按钮 */
voiceOverlayClose.addEventListener('click', () => {
    exitVoiceMode();
});

/** 主控按钮 */
voiceMainBtn.addEventListener('click', async () => {
    const state = voiceOverlay.getAttribute('data-state');

    if (state === 'idle') {
        await startVoiceRound();
    } else if (state === 'recording') {
        await finishVoiceRound();
    } else if (state === 'speaking' || state === 'answering') {
        interruptVoiceResponse();
    }
});

/** 点击中央视觉区域打断（大面积点击目标）*/
const voiceVisualArea = document.querySelector('.voice-visual-area') as HTMLElement;
voiceVisualArea?.addEventListener('click', (e) => {
    // 排除主控按钮本身（它在 voice-controls 里，不在 visual-area 里）
    if ((e.target as HTMLElement).closest('.voice-main-btn')) return;
    const state = voiceOverlay.getAttribute('data-state');
    if (state === 'speaking' || state === 'answering') {
        interruptVoiceResponse();
    }
});

/** 键盘快捷键 */
document.addEventListener('keydown', (e) => {
    if (!voiceModeActive) return;

    if (e.key === 'Escape') {
        exitVoiceMode();
    } else if (e.key === ' ' || e.code === 'Space') {
        // 空格键打断回复
        e.preventDefault();
        const state = voiceOverlay.getAttribute('data-state');
        if (state === 'speaking' || state === 'answering') {
            interruptVoiceResponse();
        }
    }
});

// ========================
// 记忆管理 Tab
// ========================

const memoryStatCount = document.getElementById('memory-stat-count')!;
const memoryStatSize = document.getElementById('memory-stat-size')!;
const memoryStatDim = document.getElementById('memory-stat-dim')!;
const memoryStatModel = document.getElementById('memory-stat-model')!;
const memoryDisabledNotice = document.getElementById('memory-disabled-notice')!;
const memorySearchBar = document.getElementById('memory-search-bar')!;
const memorySearchInput = document.getElementById('memory-search-input') as HTMLInputElement;
const memorySearchBtn = document.getElementById('memory-search-btn')!;
const memorySearchClear = document.getElementById('memory-search-clear')!;
const memoryListEl = document.getElementById('memory-list')!;
const memoryPagination = document.getElementById('memory-pagination')!;
const memoryPagePrev = document.getElementById('memory-page-prev') as HTMLButtonElement;
const memoryPageNext = document.getElementById('memory-page-next') as HTMLButtonElement;
const memoryPageInfo = document.getElementById('memory-page-info')!;
const memoryRefreshBtn = document.getElementById('memory-refresh-btn')!;
const memoryClearBtn = document.getElementById('memory-clear-btn')!;
const memorySysinfoBtn = document.getElementById('memory-sysinfo-btn')!;
const memorySysinfoPanel = document.getElementById('memory-sysinfo-panel')!;
const memorySysinfoClose = document.getElementById('memory-sysinfo-close')!;

// 系统信息弹层 toggle
memorySysinfoBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    memorySysinfoPanel.classList.toggle('hidden');
});
memorySysinfoClose.addEventListener('click', () => {
    memorySysinfoPanel.classList.add('hidden');
});
document.addEventListener('click', (e) => {
    if (!memorySysinfoPanel.classList.contains('hidden') &&
        !(e.target as HTMLElement).closest('.memory-sysinfo-wrapper')) {
        memorySysinfoPanel.classList.add('hidden');
    }
});
let memoryCurrentPage = 1;
const MEMORY_PAGE_SIZE = 15;
let memoryIsSearchMode = false;

async function loadMemoryData() {
    if (!gatewayClient) return;
    await loadMemoryStats();
    await loadMemoryList();
    await loadDistillationData();
}

async function loadMemoryStats() {
    if (!gatewayClient) return;
    try {
        const stats = await gatewayClient.memoryStats();
        if (!stats.enabled) {
            memoryDisabledNotice.classList.remove('hidden');
            memorySearchBar.style.display = 'none';
            memoryStatCount.textContent = '-';
            memoryStatSize.textContent = '-';
            memoryStatDim.textContent = '-';
            memoryStatModel.textContent = '-';
            return;
        }
        memoryDisabledNotice.classList.add('hidden');
        memorySearchBar.style.display = '';
        memoryStatCount.textContent = String(stats.totalCount ?? 0);
        memoryStatSize.textContent = formatBytes(stats.dbSizeBytes ?? 0);
        memoryStatDim.textContent = String(stats.vectorDim ?? '-');
        memoryStatModel.textContent = stats.embeddingModel ?? '-';
    } catch (e) {
        console.error('Load memory stats failed', e);
    }
}

async function loadMemoryList(page: number = 1) {
    if (!gatewayClient) return;
    memoryCurrentPage = page;
    memoryIsSearchMode = false;
    memorySearchClear.classList.add('hidden');
    try {
        const result = await gatewayClient.memoryList(page, MEMORY_PAGE_SIZE);
        renderMemoryList(result.items);
        renderMemoryPagination(result.total, result.page, result.pageSize);
    } catch (e) {
        memoryListEl.innerHTML = '<div class="memory-empty-state">' + t('memory.load_failed') + '</div>';
        console.error('Load memory list failed', e);
    }
}

async function searchMemory(query: string) {
    if (!gatewayClient || !query.trim()) return;
    memoryIsSearchMode = true;
    memorySearchClear.classList.remove('hidden');
    try {
        const result = await gatewayClient.memorySearch(query, 20);
        renderMemoryList(result.items, true);
        memoryPagination.classList.add('hidden');
    } catch (e) {
        memoryListEl.innerHTML = '<div class="memory-empty-state">' + t('memory.search_failed') + '</div>';
        console.error('Search memory failed', e);
    }
}

function renderMemoryList(items: any[], isSearch: boolean = false) {
    if (!items.length) {
        memoryListEl.innerHTML = `<div class="memory-empty-state">${isSearch ? t('memory.no_match') : t('memory.empty')}</div>`;
        return;
    }

    memoryListEl.innerHTML = items.map(item => {
        const time = item.createdAt ? new Date(item.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
        const source = item.sourceFile ? `<span class="memory-item-source">${item.sourceFile.split(/[\\/]/).pop()}</span>` : '';
        const score = item.score ? `<span class="memory-item-score">${(item.score * 100).toFixed(0)}%</span>` : '';
        const tags = item.tags?.length ? item.tags.map((t: string) => `#${t}`).join(' ') : '';
        const contentPreview = item.content?.substring(0, 120) || '';

        return `
            <div class="memory-item" data-id="${item.id}">
                <div class="memory-item-header">
                    <div class="memory-item-content">${contentPreview}</div>
                    <div class="memory-item-meta">
                        ${score}${source}
                        <span class="memory-item-time">${time}</span>
                    </div>
                    <button class="memory-item-delete" data-id="${item.id}" title="${t('common.delete')}">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                </div>
                <div class="memory-item-detail">${item.content || ''}${tags ? '\n\n' + t('memory.tags_label') + ': ' + tags : ''}</div>
            </div>`;
    }).join('');

    // 绑定展开/收起
    memoryListEl.querySelectorAll('.memory-item-header').forEach(header => {
        header.addEventListener('click', (e) => {
            if ((e.target as HTMLElement).closest('.memory-item-delete')) return;
            header.closest('.memory-item')?.classList.toggle('expanded');
        });
    });

    // 绑定删除
    memoryListEl.querySelectorAll('.memory-item-delete').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = (btn as HTMLElement).dataset.id;
            if (!id || !gatewayClient) return;
            if (!confirm(t('memory.confirm_delete'))) return;
            const ok = await gatewayClient.memoryDelete(id);
            if (ok) {
                await loadMemoryStats();
                if (memoryIsSearchMode) {
                    await searchMemory(memorySearchInput.value);
                } else {
                    await loadMemoryList(memoryCurrentPage);
                }
            }
        });
    });
}

function renderMemoryPagination(total: number, page: number, pageSize: number) {
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    if (totalPages <= 1 && total <= pageSize) {
        memoryPagination.classList.add('hidden');
        return;
    }
    memoryPagination.classList.remove('hidden');
    memoryPageInfo.textContent = `${page} / ${totalPages}`;
    memoryPagePrev.disabled = page <= 1;
    memoryPageNext.disabled = page >= totalPages;
}

// 事件绑定
memorySearchBtn.addEventListener('click', () => searchMemory(memorySearchInput.value));
memorySearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') searchMemory(memorySearchInput.value);
});
memorySearchClear.addEventListener('click', () => {
    memorySearchInput.value = '';
    loadMemoryList();
});
memoryPagePrev.addEventListener('click', () => loadMemoryList(memoryCurrentPage - 1));
memoryPageNext.addEventListener('click', () => loadMemoryList(memoryCurrentPage + 1));
memoryRefreshBtn.addEventListener('click', () => loadMemoryData());
memoryClearBtn.addEventListener('click', async () => {
    if (!gatewayClient) return;
    if (!confirm(t('memory.confirm_clear_all'))) return;
    const ok = await gatewayClient.memoryClear();
    if (ok) {
        await loadMemoryData();
    }
});



// ========================
// 蒸馏系统
// ========================

const distillSection = document.getElementById('distillation-section')!;
const distillStatMicro = document.getElementById('distill-stat-micro')!;
const distillStatMini = document.getElementById('distill-stat-mini')!;
const distillStatMacro = document.getElementById('distill-stat-macro')!;
const distillStatTopics = document.getElementById('distill-stat-topics')!;
const distillSchedulerIndicator = document.getElementById('distill-scheduler-indicator')!;
const distillSchedulerText = document.getElementById('distill-scheduler-text')!;
const distillEnabled = document.getElementById('distill-enabled') as HTMLInputElement;
const distillStartTime = document.getElementById('distill-start-time') as HTMLInputElement;
const distillEndTime = document.getElementById('distill-end-time') as HTMLInputElement;
const distillQualityThreshold = document.getElementById('distill-quality-threshold') as HTMLInputElement;
const distillSessionDensity = document.getElementById('distill-session-density') as HTMLInputElement;
const distillSimilarityThreshold = document.getElementById('distill-similarity-threshold') as HTMLInputElement;
const distillSaveBtn = document.getElementById('distill-save-btn') as HTMLButtonElement;
const distillTriggerBtn = document.getElementById('distill-trigger-btn') as HTMLButtonElement;
const distillCardsList = document.getElementById('distill-cards-list')!;
const distillCardsEmpty = document.getElementById('distill-cards-empty')!;
const distillCardsRefresh = document.getElementById('distill-cards-refresh') as HTMLButtonElement;
const distillCardsCount = document.getElementById('distill-cards-count')!;
const distillCardsTabs = document.querySelectorAll('.distill-tab');

// 卡片列表状态
let distillCurrentLayer: string = '';
let distillCardsData: any[] = [];
let distillCardsTotal = 0;

async function loadDistillationData() {
    if (!gatewayClient) return;
    try {
        const stats = await gatewayClient.distillationStats();
        if (!stats.available) {
            distillSection.classList.add('hidden');
            return;
        }
        distillSection.classList.remove('hidden');

        // 统计
        distillStatMicro.textContent = String(stats.microCount ?? 0);
        distillStatMini.textContent = String(stats.miniCount ?? 0);
        distillStatMacro.textContent = String(stats.macroCount ?? 0);
        distillStatTopics.textContent = String(stats.topicCount ?? 0);

        // 调度器状态
        const sched = stats.scheduler || {};
        if (!sched.enabled) {
            distillSchedulerIndicator.className = 'distill-status-dot off';
            distillSchedulerText.textContent = t('memory.scheduler_disabled');
        } else if (sched.isRunning) {
            distillSchedulerIndicator.className = 'distill-status-dot running';
            distillSchedulerText.textContent = t('memory.distill_in_progress');
        } else if (sched.isInWindow) {
            distillSchedulerIndicator.className = 'distill-status-dot window';
            distillSchedulerText.textContent = `${t('memory.distill_window')} (${sched.nextWindow || ''})`;
        } else {
            distillSchedulerIndicator.className = 'distill-status-dot idle';
            distillSchedulerText.textContent = `${t('memory.distill_idle')} · ${t('memory.distill_window_label')}: ${sched.nextWindow || t('agent.not_set')}${sched.lastRunDate ? ` · ${t('memory.distill_last')}: ` + sched.lastRunDate : ''}`;
        }

        // 配置
        const cfg = stats.config || {};
        distillEnabled.checked = !!cfg.enabled;
        distillStartTime.value = cfg.startTime || '02:00';
        distillEndTime.value = cfg.endTime || '06:00';
        distillQualityThreshold.value = String(cfg.qualityThreshold ?? 40);
        distillSessionDensity.value = String(cfg.sessionDensityThreshold ?? 5);
        distillSimilarityThreshold.value = String(cfg.similarityThreshold ?? 0.85);

        // 加载卡片列表
        await loadDistillCards(distillCurrentLayer);
    } catch (e) {
        console.error('Load distillation data failed', e);
    }
}

async function loadDistillCards(layer?: string) {
    if (!gatewayClient) return;
    try {
        const result = await gatewayClient.distillationCards(layer || undefined, 200, 0);
        console.log('[Distill] loadDistillCards result:', result);
        distillCardsData = result.cards;
        distillCardsTotal = result.total;
        console.log('[Distill] cards count:', distillCardsData.length, 'total:', distillCardsTotal);
        renderDistillCards();
    } catch (e) {
        console.error('Load card list failed', e);
    }
}

function renderDistillCards() {
    distillCardsCount.textContent = `${distillCardsTotal} ${t('memory.cards_unit')}`;
    if (!distillCardsData.length) {
        distillCardsList.innerHTML = '';
        distillCardsEmpty.classList.remove('hidden');
        return;
    }
    distillCardsEmpty.classList.add('hidden');

    distillCardsList.innerHTML = distillCardsData.map((card: any) => {
        const layerClass = (card.layer || '').toLowerCase();
        const qScore = card.qualityScore != null ? card.qualityScore : null;
        const qColor = qScore != null ? (qScore >= 70 ? '#10b981' : qScore >= 40 ? '#f59e0b' : '#ef4444') : '#555';
        const qWidth = qScore != null ? Math.min(100, Math.max(5, qScore)) : 0;
        const timeStr = card.createdAt ? new Date(card.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
        const tagsHtml = (card.tags || []).map((t: string) => `<span class="distill-card-tag">${t}</span>`).join('');

        return `<div class="distill-card-item" data-card-id="${card.id}">
            <span class="distill-card-layer ${layerClass}">${card.layer}</span>
            <div class="distill-card-body">
                <div class="distill-card-summary">${escapeHtml(card.summary || '')}</div>
                <div class="distill-card-meta">
                    <span class="distill-card-topic" title="${escapeHtml(card.topicTitle || '')}">${escapeHtml(card.topicTitle || t('memory.uncategorized'))}</span>
                    ${qScore != null ? `<span class="distill-card-quality"><span class="distill-card-quality-bar"><span class="distill-card-quality-fill" style="width:${qWidth}%;background:${qColor}"></span></span>${qScore}</span>` : ''}
                    <span>${timeStr}</span>
                </div>
                <div class="distill-card-detail">
                    <div class="distill-card-detail-row"><span class="distill-card-detail-label">ID</span><span class="distill-card-detail-value">${card.id}</span></div>
                    <div class="distill-card-detail-row"><span class="distill-card-detail-label">${t('memory.topic_label')}</span><span class="distill-card-detail-value">${escapeHtml(card.topicTitle || t('memory.uncategorized'))} (${card.topicId || '-'})</span></div>
                    ${qScore != null ? `<div class="distill-card-detail-row"><span class="distill-card-detail-label">${t('memory.quality_label')}</span><span class="distill-card-detail-value">${qScore}</span></div>` : ''}
                    ${tagsHtml ? `<div class="distill-card-tags">${tagsHtml}</div>` : ''}
                </div>
            </div>
            <button class="distill-card-delete" title="${t('memory.delete_card')}" data-delete-id="${card.id}">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
            </button>
        </div>`;
    }).join('');
}


// Tab 切换
distillCardsTabs.forEach(tab => {
    tab.addEventListener('click', () => {
        distillCardsTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        distillCurrentLayer = (tab as HTMLElement).dataset.layer || '';
        loadDistillCards(distillCurrentLayer);
    });
});

// 列表事件委托：展开/收起 + 删除
distillCardsList.addEventListener('click', async (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    // 删除按钮
    const deleteBtn = target.closest('.distill-card-delete') as HTMLElement;
    if (deleteBtn) {
        e.stopPropagation();
        const cardId = deleteBtn.dataset.deleteId;
        if (!cardId || !gatewayClient) return;
        if (!confirm('确定删除此卡片？')) return;
        try {
            const result = await gatewayClient.distillationDeleteCard(cardId);
            if (result.success) {
                // 刷新列表和统计
                await Promise.all([loadDistillCards(distillCurrentLayer), loadDistillationData()]);
            }
        } catch (err) {
            console.error('Delete card failed', err);
        }
        return;
    }
    // 展开/收起
    const item = target.closest('.distill-card-item') as HTMLElement;
    if (item) {
        item.classList.toggle('expanded');
    }
});

// 刷新按钮
distillCardsRefresh.addEventListener('click', async () => {
    if (distillCardsRefresh.classList.contains('refreshing')) return;
    distillCardsRefresh.classList.add('refreshing');
    try {
        await Promise.all([loadDistillCards(distillCurrentLayer), loadDistillationData()]);
    } finally {
        distillCardsRefresh.classList.remove('refreshing');
    }
});




// 配置保存
distillSaveBtn.addEventListener('click', async () => {
    if (!gatewayClient) return;
    distillSaveBtn.disabled = true;
    distillSaveBtn.textContent = t('memory.distill_saving');
    try {
        const config = {
            enabled: distillEnabled.checked,
            startTime: distillStartTime.value,
            endTime: distillEndTime.value,
            qualityThreshold: Number(distillQualityThreshold.value),
            sessionDensityThreshold: Number(distillSessionDensity.value),
            similarityThreshold: Number(distillSimilarityThreshold.value),
        };
        const result = await gatewayClient.distillationUpdateConfig(config);
        if (result.success) {
            distillSaveBtn.textContent = t('memory.distill_saved');
            setTimeout(() => { distillSaveBtn.textContent = t('common.save_config'); }, 2000);
            await loadDistillationData();
        } else {
            distillSaveBtn.textContent = t('memory.distill_save_failed', result.message || t('misc.save_failed'));
            setTimeout(() => { distillSaveBtn.textContent = t('common.save_config'); }, 3000);
        }
    } catch (e) {
        distillSaveBtn.textContent = t('misc.save_failed');
        setTimeout(() => { distillSaveBtn.textContent = t('common.save_config'); }, 3000);
    } finally {
        distillSaveBtn.disabled = false;
    }
});

// 手动触发
distillTriggerBtn.addEventListener('click', async () => {
    if (!gatewayClient) return;
    if (!confirm(t('memory.confirm_manual_distill'))) return;
    distillTriggerBtn.disabled = true;
    distillTriggerBtn.textContent = t('memory.distill_running');
    try {
        const result = await gatewayClient.distillationTrigger();
        if (result.success) {
            distillTriggerBtn.textContent = t('memory.distill_done');
            await loadDistillationData();
        } else {
            distillTriggerBtn.textContent = t('memory.distill_failed', result.message || '');
        }
    } catch (e) {
        console.error('Manual distillation failed:', e);
        distillTriggerBtn.textContent = t('memory.distill_failed', e instanceof Error ? e.message : String(e));
    } finally {
        setTimeout(() => {
            distillTriggerBtn.textContent = t('memory.manual_distill');
            distillTriggerBtn.disabled = false;
        }, 3000);
    }
});



// ========================
// OpenFlux 云端
// ========================

/** 当前会话绑定的云端 chatroomId */
let currentCloudChatroomId: number | null = null;
/** OpenFlux 登录状态（本地缓存标志）*/
let openfluxLoggedIn = false;
/** 云端 Agent 缓存 */
let cachedOpenFluxAgents: Array<{ agentId: number; appId: number; name: string; description?: string; chatroomId: number }> = [];
/** 已使用过的云端会话（chatroomId → session info） */
let usedCloudSessions: Map<number, { sessionId: string; agentName: string }> = new Map();

/** 根据云端会话和登录状态更新输入框是否可用 */
function updateInputForCloudSession(): void {
    const isCloudAndNotLoggedIn = !!currentCloudChatroomId && !openfluxLoggedIn;
    messageInput.disabled = isCloudAndNotLoggedIn;
    const sendBtn = document.getElementById('send-btn') as HTMLButtonElement | null;
    const micBtn = document.getElementById('mic-btn') as HTMLButtonElement | null;
    const voiceModeBtn = document.getElementById('voice-mode-btn') as HTMLButtonElement | null;
    if (sendBtn) sendBtn.disabled = isCloudAndNotLoggedIn;
    // mic-btn 和 voice-mode-btn 使用 .disabled CSS 类
    if (micBtn) micBtn.classList.toggle('disabled', isCloudAndNotLoggedIn);
    if (voiceModeBtn) voiceModeBtn.classList.toggle('disabled', isCloudAndNotLoggedIn);
    if (isCloudAndNotLoggedIn) {
        messageInput.placeholder = t('chat.cloud_login_hint');
    } else {
        messageInput.placeholder = t('chat.input_placeholder');
    }
}

// ---- 登录弹窗元素 ----
const openfluxLoginModal = document.getElementById('openflux-login-modal') as HTMLDivElement;
const openfluxModalUsername = document.getElementById('openflux-modal-username') as HTMLInputElement;
const openfluxModalPassword = document.getElementById('openflux-modal-password') as HTMLInputElement;
const openfluxModalPwdToggle = document.getElementById('openflux-modal-pwd-toggle') as HTMLButtonElement;
const openfluxModalLoginBtn = document.getElementById('openflux-modal-login-btn') as HTMLButtonElement;
const openfluxModalHint = document.getElementById('openflux-modal-hint') as HTMLSpanElement;
const openfluxModalClose = document.getElementById('openflux-login-modal-close') as HTMLButtonElement;

// ---- 侧边栏模式切换元素 ----
const sidebarModeToggle = document.getElementById('sidebar-mode-toggle') as HTMLDivElement;
const modeChatBtn = document.getElementById('mode-chat-btn') as HTMLButtonElement;
const modeAgentBtn = document.getElementById('mode-agent-btn') as HTMLButtonElement;
const sidebarAgentList = document.getElementById('sidebar-agent-list') as HTMLDivElement;

// ---- 登录弹窗逻辑 ----

const loginModalTitle = openfluxLoginModal.querySelector('.openflux-login-modal-header h3') as HTMLElement | null;
const loginModalUsernameInput = openfluxModalUsername;

/** 以 Atlas 品牌弹出登录框（从 NexusAI 托管模式切换触发时） */
function showLoginModalForAtlas(): void {
    if (loginModalTitle) loginModalTitle.textContent = 'NexusAI Atlas 登录';
    if (loginModalUsernameInput) loginModalUsernameInput.placeholder = '输入 NexusAI 账号';
    openfluxLoginModal.classList.remove('hidden');
}

/** 恢复登录框默认标题 */
function restoreLoginModalTitle(): void {
    if (loginModalTitle) loginModalTitle.textContent = t('login.title');
    if (loginModalUsernameInput) loginModalUsernameInput.placeholder = t('login.username_placeholder');
}

openfluxModalClose.addEventListener('click', () => {
    openfluxLoginModal.classList.add('hidden');
    restoreLoginModalTitle();
    // 如果是从 managed 模式切换触发的登录，取消后回退到 standalone
    if (pendingManagedSwitch) {
        pendingManagedSwitch = false;
        applyWorkingMode('standalone');
    }
});
openfluxModalPwdToggle.addEventListener('click', () => {
    openfluxModalPassword.type = openfluxModalPassword.type === 'password' ? 'text' : 'password';
});

// Enter 键登录
openfluxModalPassword.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') openfluxModalLoginBtn.click();
});

// 登录
openfluxModalLoginBtn.addEventListener('click', async () => {
    if (!gatewayClient) return;
    const username = openfluxModalUsername.value.trim();
    const password = openfluxModalPassword.value;
    if (!username || !password) {
        openfluxModalHint.textContent = t('login.enter_credentials');
        openfluxModalHint.className = 'settings-save-hint error';
        return;
    }
    openfluxModalLoginBtn.disabled = true;
    openfluxModalHint.textContent = t('login.saving');
    openfluxModalHint.className = 'settings-save-hint';
    try {
        const res = await gatewayClient.openfluxLogin(username, password);
        if (res.success) {
            openfluxLoginModal.classList.add('hidden');
            openfluxModalPassword.value = '';
            openfluxModalHint.textContent = '';
            onopenfluxLoggedIn(username);
        } else {
            openfluxModalHint.textContent = res.message || t('login.failed_short');
            openfluxModalHint.className = 'settings-save-hint error';
        }
    } catch (e) {
        openfluxModalHint.textContent = t('login.failed', e instanceof Error ? e.message : String(e));
        openfluxModalHint.className = 'settings-save-hint error';
    } finally {
        openfluxModalLoginBtn.disabled = false;
    }
});

// ---- 登录状态切换 ----

// 设置面板云端 Tab 元素
const openfluxSettingsNotLogged = document.getElementById('openflux-settings-not-logged') as HTMLDivElement;
const openfluxSettingsLogged = document.getElementById('openflux-settings-logged') as HTMLDivElement;
const openfluxSettingsUsername = document.getElementById('openflux-settings-username') as HTMLSpanElement;
const openfluxSettingsLogoutBtn = document.getElementById('openflux-settings-logout-btn') as HTMLButtonElement;

// 设置面板登出按钮
openfluxSettingsLogoutBtn.addEventListener('click', async () => {
    if (!gatewayClient) return;
    try {
        await gatewayClient.openfluxLogout();
    } catch { /* 忽略 */ }
    onOpenFluxLoggedOut();
});

/** 登录成功后的 UI 更新 */
async function onopenfluxLoggedIn(username: string): Promise<void> {
    openfluxLoggedIn = true;
    // Agent 列表内：隐藏登录提示
    agentListLoginPrompt.classList.add('hidden');
    // 设置面板：显示已登录状态
    openfluxSettingsNotLogged.classList.add('hidden');
    openfluxSettingsLogged.classList.remove('hidden');
    openfluxSettingsUsername.textContent = username;
    // 保存用户名供反馈窗口使用
    localStorage.setItem('nexusai-username', username);
    // 更新输入框状态（如果当前在云端会话，解除禁用）
    updateInputForCloudSession();
    // 加载云端 Agent 列表（NexusAi tab 用），同时刷新 Agent tab（可能有已用的云端 Agent）
    loadSidebarAgents();
    loadLocalAgents();

    // 如果是从 managed 模式切换触发的登录，登录成功后重试切换
    if (pendingManagedSwitch) {
        pendingManagedSwitch = false;
        // 关闭登录弹窗（如果打开的话）
        openfluxLoginModal.classList.add('hidden');
        restoreLoginModalTitle();
        applyWorkingMode('managed');
    }

    // 如果是 401 认证失败触发的登录，登录成功后自动重发失败的请求
    if (pendingAuthRetry) {
        const retry = pendingAuthRetry;
        pendingAuthRetry = null;
        console.log('[Atlas] Re-login success, retrying failed request:', retry.content.slice(0, 50));
        // 确保切换到目标会话
        if (retry.sessionId && retry.sessionId !== currentSessionId) {
            await selectSession(retry.sessionId);
        }
        // 延迟一下让 Gateway 重建 LLM
        setTimeout(() => {
            messageInput.value = retry.content;
            sendMessage();
        }, 500);
    }
}

/** 登出后的 UI 更新 */
function onOpenFluxLoggedOut(): void {
    openfluxLoggedIn = false;
    // Agent 列表内：显示登录提示
    agentListLoginPrompt.classList.remove('hidden');
    // 设置面板：显示未登录状态
    openfluxSettingsNotLogged.classList.remove('hidden');
    openfluxSettingsLogged.classList.add('hidden');
    // 更新输入框状态（如果当前在云端会话，禁用输入）
    updateInputForCloudSession();
    // 切回 Chat 模式
    switchSidebarMode('agent');
    cachedOpenFluxAgents = [];
    // 重渲染 Agent tab（去掉云端 Agent 分组）
    renderLocalAgents();
}

/** 检查 OpenFlux 登录状态（应用初始化时调用）*/
async function checkOpenFluxLoginStatus(): Promise<void> {
    if (!gatewayClient) return;
    try {
        const status = await gatewayClient.openfluxStatus();
        if (status.loggedIn) {
            onopenfluxLoggedIn(status.username || '已登录');
        } else {
            onOpenFluxLoggedOut();
        }
    } catch {
        onOpenFluxLoggedOut();
    }
}

// ---- Agent / NexusAi 侧边栏切换 ----

modeChatBtn.addEventListener('click', () => switchSidebarMode('agent'));
modeAgentBtn.addEventListener('click', () => switchSidebarMode('nexusai'));

function switchSidebarMode(mode: 'agent' | 'nexusai'): void {
    modeChatBtn.classList.toggle('active', mode === 'agent');
    modeAgentBtn.classList.toggle('active', mode === 'nexusai');
    sessionList.classList.toggle('hidden', mode !== 'agent');
    sidebarAgentList.classList.toggle('hidden', mode !== 'nexusai');
    // 切到 NexusAi 模式时加载云端 Agent
    if (mode === 'nexusai') {
        // 如果已有缓存直接渲染，不重新请求 API
        if (cachedOpenFluxAgents.length > 0) {
            renderSidebarAgents();
        } else {
            loadSidebarAgents();
        }
    }
}

// ---- 本地 Gateway Agent 管理 ----

const agentEditView = document.getElementById('agent-edit-view') as HTMLDivElement;
const agentEditBack = document.getElementById('agent-edit-back') as HTMLButtonElement;
const agentEditTitle = document.getElementById('agent-edit-title') as HTMLHeadingElement;
const agentEditId = document.getElementById('agent-edit-id') as HTMLInputElement;
const agentEditName = document.getElementById('agent-edit-name') as HTMLInputElement;
const agentEditDesc = document.getElementById('agent-edit-desc') as HTMLInputElement;
const agentEditIcon = document.getElementById('agent-edit-icon') as HTMLInputElement;
const agentEditColor = document.getElementById('agent-edit-color') as HTMLInputElement;
const agentColorSwatches = document.getElementById('agent-color-swatches') as HTMLDivElement;

// 色块选择器点击处理
if (agentColorSwatches) {
    agentColorSwatches.addEventListener('click', (e) => {
        const swatch = (e.target as HTMLElement).closest('.color-swatch') as HTMLElement;
        if (!swatch) return;
        const color = swatch.dataset.color;
        if (!color) return;
        agentEditColor.value = color;
        // 更新高亮
        agentColorSwatches.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
        swatch.classList.add('active');
    });
}

/** 设置色块选择器的激活状态 */
function setActiveColorSwatch(color: string): void {
    if (!agentColorSwatches) return;
    agentColorSwatches.querySelectorAll('.color-swatch').forEach(s => {
        const sc = (s as HTMLElement).dataset.color;
        s.classList.toggle('active', sc === color);
    });
}

// ===== Agent 图标选择器 =====
const agentIconPreview = document.getElementById('agent-icon-preview') as HTMLDivElement;
const agentIconGrid = document.getElementById('agent-icon-grid') as HTMLDivElement;
const agentIconUploadBtn = document.getElementById('agent-icon-upload-btn') as HTMLButtonElement;
const agentIconFileInput = document.getElementById('agent-icon-file-input') as HTMLInputElement;

/** 渲染 Agent 图标 HTML（emoji 或图片） */
function renderAgentIcon(icon: string, size: number = 24): string {
    if (icon.startsWith('data:image')) {
        return `<img src="${icon}" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;" />`;
    }
    return icon;
}

/** 更新图标预览 */
function updateIconPreview(iconValue: string): void {
    if (!agentIconPreview) return;
    if (iconValue.startsWith('data:image')) {
        agentIconPreview.innerHTML = `<img src="${iconValue}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;" />`;
    } else {
        agentIconPreview.textContent = iconValue || '🤖';
        // 如果是文本，清空 innerHTML 中可能残留的 img
        if (agentIconPreview.querySelector('img')) {
            agentIconPreview.innerHTML = '';
            agentIconPreview.textContent = iconValue || '🤖';
        }
    }
}

/** 设置图标网格激活状态 */
function setActiveIconGridItem(iconValue: string): void {
    if (!agentIconGrid) return;
    agentIconGrid.querySelectorAll('.agent-icon-grid-item').forEach(btn => {
        const di = (btn as HTMLElement).dataset.icon;
        btn.classList.toggle('active', di === iconValue);
    });
}

// 图标网格点击
if (agentIconGrid) {
    agentIconGrid.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest('.agent-icon-grid-item') as HTMLElement;
        if (!btn) return;
        const icon = btn.dataset.icon;
        if (!icon) return;
        agentEditIcon.value = icon;
        updateIconPreview(icon);
        setActiveIconGridItem(icon);
    });
}

// 上传照片
if (agentIconUploadBtn) {
    agentIconUploadBtn.addEventListener('click', () => agentIconFileInput?.click());
}
if (agentIconFileInput) {
    agentIconFileInput.addEventListener('change', () => {
        const file = agentIconFileInput.files?.[0];
        if (!file) return;
        // 限制 200KB
        if (file.size > 200 * 1024) {
            alert(t('agent.image_too_large'));
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            const dataUri = reader.result as string;
            agentEditIcon.value = dataUri;
            updateIconPreview(dataUri);
            setActiveIconGridItem(''); // 取消网格高亮
        };
        reader.readAsDataURL(file);
        agentIconFileInput.value = ''; // 允许重复选择同一文件
    });
}
const agentEditPrompt = document.getElementById('agent-edit-prompt') as HTMLTextAreaElement;
const agentEditSave = document.getElementById('agent-edit-save') as HTMLButtonElement;
const agentEditCancel = document.getElementById('agent-edit-cancel') as HTMLButtonElement;

let editingAgentId: string | null = null; // null = 创建, 非null = 编辑

/** 加载本地 Agent 列表 */
async function loadLocalAgents(): Promise<void> {
    if (!gatewayClient) return;
    sessionList.innerHTML = '<div class="memory-empty-state" style="font-size:0.8rem;padding:12px;">' + t('common.loading') + '</div>';
    try {
        // 分别加载 Agent 和 Session，Session 失败不影响 Agent 列表
        let agents: Array<{ id: string; name: string; description?: string; icon?: string; color?: string; default?: boolean; systemPrompt?: string; createdAt: number; updatedAt: number }> = [];
        let sessions: any[] = [];

        try {
            agents = await gatewayClient.getAgents();
        } catch (e) {
            console.error('[Agent] getAgents failed:', e);
        }

        try {
            sessions = await gatewayClient.getSessions();
        } catch (e) {
            console.warn('[Agent] getSessions failed (non-fatal):', e);
        }

        agentsList = agents;

        // 提取已使用的云端会话（用于在 Agent tab 显示已用过的云端 Agent）
        usedCloudSessions = new Map();
        for (const s of sessions) {
            if (s.cloudChatroomId) {
                usedCloudSessions.set(s.cloudChatroomId, {
                    sessionId: s.id,
                    agentName: s.cloudAgentName || `Cloud Agent`,
                });
                // 同步填充 sessionId → chatroomId 映射（用于未读标记定位）
                sessionToChatroomMap.set(s.id, s.cloudChatroomId);
            }
        }

        renderLocalAgents();

        // 自动选中默认 Agent（首次启动时），加载会话内容
        if (currentAgentId === null && !currentCloudChatroomId && agents.length > 0) {
            const defaultAgent = agents.find(a => (a as Record<string, unknown>).default === true) || agents[0];
            const agentId = (defaultAgent as Record<string, unknown>).id as string;
            console.log(`[Agent] Auto-switching to default agent: ${agentId}`);
            switchToAgent(agentId).catch(err => console.error('[Agent] Auto-switch failed:', err));
        }
    } catch (e) {
        console.error('[Agent] 加载本地 Agent 失败:', e);
        sessionList.innerHTML = `<div class="memory-empty-state" style="font-size:0.8rem;padding:12px;">${t('common.load_failed')}</div>`;
    }
}

/** 渲染本地 Agent 列表（到 sessionList 位置） */
function renderLocalAgents(): void {
    sessionList.innerHTML = '';
    if (agentsList.length === 0) {
        sessionList.innerHTML = '<div class="memory-empty-state" style="font-size:0.8rem;padding:12px;">暂无 Agent，点击“新建 Agent”创建</div>';
        return;
    }
    for (const agent of agentsList) {
        const card = document.createElement('div');
        const isLocalActive = currentAgentId === agent.id && !currentCloudChatroomId;
        card.className = 'local-agent-card' + (isLocalActive ? ' active' : '');
        card.dataset.agentId = agent.id;
        card.style.borderLeft = `3px solid ${agent.color || '#6366f1'}`;
        const icon = agent.icon || '🤖';
        const color = agent.color || '#6366f1';
        const name = agent.name || agent.id;
        const desc = agent.description || '';
        const isDefault = agent.default ? '<span class="agent-default-badge">默认</span>' : '';
        card.innerHTML = `
            <div class="agent-card-icon" style="background:${escapeHtml(color)}20;color:${escapeHtml(color)}">${renderAgentIcon(icon, 22)}</div>
            <div class="agent-card-info">
                <div class="agent-card-name">${escapeHtml(name)} ${isDefault}</div>
                ${desc ? `<div class="agent-card-desc">${escapeHtml(desc)}</div>` : ''}
            </div>
            <div class="agent-card-actions">
                <button class="agent-action-btn agent-edit-action" title="编辑">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                    </svg>
                </button>
                <button class="agent-action-btn agent-delete-action" title="删除">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                    </svg>
                </button>
            </div>
        `;
        // 点击卡片切换 Agent
        card.addEventListener('click', (e) => {
            const target = e.target as HTMLElement;
            if (target.closest('.agent-edit-action') || target.closest('.agent-delete-action')) return;
            switchToAgent(agent.id);
        });
        // 编辑按钮
        card.querySelector('.agent-edit-action')?.addEventListener('click', () => openAgentEditModal(agent.id));
        // 删除按钮
        card.querySelector('.agent-delete-action')?.addEventListener('click', () => deleteLocalAgent(agent.id, name));
        sessionList.appendChild(card);
    }

    // ---- 已使用的云端 NexusAi Agent 分组 ----
    // 只显示已经双击使用过的云端 Agent（有对应会话记录的）
    if (usedCloudSessions.size > 0) {
        // 从缓存中匹配已用的云端 Agent 详情，或直接用会话名称
        const usedAgents: Array<{ chatroomId: number; appId: number; name: string; description?: string }> = [];
        for (const [chatroomId, info] of usedCloudSessions) {
            const cached = cachedOpenFluxAgents.find(a => a.chatroomId === chatroomId);
            usedAgents.push({
                chatroomId,
                appId: cached?.appId || 0,
                name: cached?.name || info.agentName,
                description: cached?.description,
            });
        }

        if (usedAgents.length > 0) {
            // 分隔线 + 分组标题
            const divider = document.createElement('div');
            divider.className = 'agent-group-divider';
            divider.innerHTML = `<span class="agent-group-label">☁️ ${t('cloud.agent_group')}</span>`;
            sessionList.appendChild(divider);

            for (const agent of usedAgents) {
                const card = document.createElement('div');
                const isCloudActive = currentCloudChatroomId === agent.chatroomId;
                card.className = 'local-agent-card cloud-agent-card' + (isCloudActive ? ' active' : '');
                card.dataset.cloudChatroomId = String(agent.chatroomId);
                card.style.borderLeft = '3px solid #38bdf8';
                card.innerHTML = `
                    <div class="agent-card-icon" style="background:rgba(56,189,248,0.12);color:#38bdf8">${renderAgentIcon('🤖', 22)}</div>
                    <div class="agent-card-info">
                        <div class="agent-card-name">${escapeHtml(agent.name)} <span class="agent-cloud-badge">☁️</span></div>
                        ${agent.description ? `<div class="agent-card-desc">${escapeHtml(agent.description)}</div>` : ''}
                    </div>
                `;
                // 点击切换到该云端会话
                card.addEventListener('click', () => startCloudChat(agent.appId, agent.name, agent.chatroomId));
                sessionList.appendChild(card);
            }
        }
    }

    // ---- Router 会话（当作一个 Agent 显示） ----
    if (routerEnabled) {
        // 分隔线
        const divider = document.createElement('div');
        divider.className = 'agent-group-divider';
        divider.innerHTML = `<span class="agent-group-label">🔗 Router</span>`;
        sessionList.appendChild(divider);

        const card = document.createElement('div');
        card.className = 'local-agent-card router-session-item' + (isRouterSession ? ' active' : '');
        card.dataset.sessionId = '__router__';
        card.style.borderLeft = '3px solid #22c55e';
        card.innerHTML = `
            <div class="agent-card-icon" style="background:rgba(34,197,94,0.12);color:#22c55e">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M16 3h-2v2h2V3zm-4 0H8v2h4V3zM6 3H4v2h2V3zm14 4h-2v2h2V7zm0 4h-2v2h2v-2zm0 4h-2v2h2v-2zM4 7H2v2h2V7zm0 4H2v2h2v-2zm0 4H2v2h2v-2zm14 4h-2v2h2v-2zm-4 0H8v2h4v-2zm-8 0H4v2h2v-2z"/></svg>
            </div>
            <div class="agent-card-info">
                <div class="agent-card-name">${t('app.router_messages')} <span class="agent-cloud-badge" style="color:#22c55e">🔗</span></div>
                <div class="agent-card-desc">${t('app.router_channel')}</div>
            </div>
        `;
        card.addEventListener('click', () => switchToRouterSession());
        sessionList.appendChild(card);
    }
}

/** 切换到指定 Agent */
async function switchToAgent(agentId: string): Promise<void> {
    if (!gatewayClient) return;
    try {
        const result = await gatewayClient.switchAgent(agentId);
        currentAgentId = agentId;
        // 更新会话 ID 为 Agent 的 sessionKey
        const agentInfo = result.agent as Record<string, unknown>;
        const sessionKey = (agentInfo.sessionKey || agentId) as string;

        // 保存当前输入框草稿
        if (currentSessionId) {
            const draft = messageInput.value.trim();
            if (draft) {
                sessionDrafts.set(currentSessionId, messageInput.value);
            } else {
                sessionDrafts.delete(currentSessionId);
            }
        }

        // 保存离开会话的进度状态到缓存（与 selectSession 一致）
        const previousSessionId = currentSessionId !== sessionKey ? currentSessionId : null;
        if (previousSessionId && currentProgressCard && !isProgressFinished) {
            sessionProgressCache.set(previousSessionId, {
                items: [...progressItems],
                title: currentProgressCard.querySelector('.progress-card-title')?.textContent || t('app.running'),
            });
        }

        currentSessionId = sessionKey;
        currentCloudChatroomId = null;
        isRouterSession = false;
        // 清除该 agent 的未读标记
        unreadSessionIds.delete(sessionKey);
        const agentCard = sessionList.querySelector(`.local-agent-card[data-agent-id="${agentId}"]`);
        agentCard?.querySelector('.unread-badge')?.remove();
        // 隐藏 Router 绑定 UI，恢复输入区
        document.body.classList.remove('router-active');
        hideRouterBindUI();
        (document.querySelector('.input-area') as HTMLElement).classList.remove('hidden');

        // 恢复目标会话的输入草稿
        messageInput.value = sessionDrafts.get(sessionKey) || '';
        autoResize();

        // 重置进度状态
        currentProgressCard = null;
        progressItems = [];
        isProgressFinished = !loadingSessions.has(sessionKey);

        // 隐藏编辑视图、设置视图、调度器视图，确保显示聊天区
        hideAgentEditView();
        closeSettingsView();
        if (schedulerViewActive) {
            schedulerViewActive = false;
            schedulerView.classList.add('hidden');
            if (countdownTimerId) { clearInterval(countdownTimerId); countdownTimerId = null; }
        }

        // 使用与 selectSession 相同的方式加载消息、日志和成果物
        const messagesEl = document.getElementById('messages') as HTMLDivElement;
        try {
            const [messages, logs, savedArtifacts] = await Promise.all([
                gatewayClient.getMessages(sessionKey),
                gatewayClient.getLogs(sessionKey),
                gatewayClient.getArtifacts(sessionKey),
            ]);

            if ((messages as Message[]).length > 0) {
                const hydratedMessages = await hydrateMessageAttachments(messages);
                renderMessagesWithLogs(hydratedMessages, logs as LogEntry[]);
            } else {
                // 显示 Agent 欢迎信息
                const agentName = (agentInfo.name || agentId) as string;
                messagesEl.innerHTML = `<div class="memory-empty-state" style="padding:32px;text-align:center;opacity:0.6;">正在与 <strong>${escapeHtml(agentName)}</strong> 对话</div>`;
            }

            // ═══ 恢复进度卡片：如果目标会话有缓存的进度状态，重建卡片 ═══
            const cachedProgress = sessionProgressCache.get(sessionKey);
            if (cachedProgress && loadingSessions.has(sessionKey)) {
                for (const item of cachedProgress.items) {
                    addProgressToChat(item.icon, item.text, item.isThinking, item.detail);
                }
                if (currentProgressCard) {
                    const titleEl = (currentProgressCard as HTMLElement).querySelector('.progress-card-title') as HTMLElement;
                    if (titleEl) titleEl.textContent = cachedProgress.title;
                }
                sessionProgressCache.delete(sessionKey);
            }

            // 恢复成果物
            clearArtifacts();
            if (savedArtifacts.length > 0) {
                const sorted = [...savedArtifacts].sort((a: any, b: any) => (b.timestamp || 0) - (a.timestamp || 0));
                for (const a of sorted) {
                    await addArtifact(a as Artifact, false);
                }
            }
        } catch (loadError) {
            console.error('[Agent] 加载会话数据失败:', loadError);
            messagesEl.innerHTML = '';
        }

        // 刷新 Agent 列表高亮
        renderLocalAgents();
        // 切到 Chat 视图显示对话
        switchSidebarMode('agent');
        updateSendButtonState();
        messageInput.focus();
        console.log(`[Agent] 已切换到 Agent: ${agentId}, session: ${sessionKey}`);
    } catch (e) {
        console.error('[Agent] 切换 Agent 失败:', e);
    }
}

/** 简易追加消息到聊天区 */
function appendMessageToChat(role: string, content: string): void {
    const messagesContainer = document.getElementById('messages') as HTMLDivElement;
    const div = document.createElement('div');
    div.className = `message ${role === 'user' ? 'user-message' : 'assistant-message'}`;
    div.innerHTML = `<div class="message-content">${escapeHtml(content)}</div>`;
    messagesContainer.appendChild(div);
}

/** 显示 Agent 编辑视图（中间窗口） */
function showAgentEditView(): void {
    messagesContainer.classList.add('hidden');
    settingsView.classList.add('hidden');
    agentEditView.classList.remove('hidden');
    // 隐藏输入区域
    const inputArea = document.querySelector('.input-area') as HTMLElement | null;
    if (inputArea) inputArea.classList.add('hidden');
}

/** 隐藏 Agent 编辑视图，回到聊天 */
function hideAgentEditView(): void {
    agentEditView.classList.add('hidden');
    messagesContainer.classList.remove('hidden');
    const inputArea = document.querySelector('.input-area') as HTMLElement | null;
    if (inputArea) inputArea.classList.remove('hidden');
}

/** 打开 Agent 编辑视图 */
function openAgentEditModal(editId?: string): void {
    editingAgentId = editId || null;
    const idGroup = agentEditId.closest('.settings-item') as HTMLElement;
    if (editId) {
        // 编辑模式
        const agent = agentsList.find(a => a.id === editId);
        if (!agent) return;
        agentEditTitle.textContent = t('agent.edit_title_edit');
        if (idGroup) idGroup.style.display = '';
        agentEditId.value = agent.id;
        agentEditId.disabled = true;
        agentEditName.value = agent.name || '';
        agentEditDesc.value = agent.description || '';
        agentEditIcon.value = agent.icon || '🤖';
        updateIconPreview(agent.icon || '🤖');
        setActiveIconGridItem(agent.icon || '🤖');
        agentEditColor.value = agent.color || '#6366f1';
        setActiveColorSwatch(agent.color || '#6366f1');
        agentEditPrompt.value = agent.systemPrompt || '';
    } else {
        // 创建模式（ID 自动生成，隐藏 ID 字段）
        agentEditTitle.textContent = t('agent.create_title');
        if (idGroup) idGroup.style.display = 'none';
        agentEditId.value = '';
        agentEditName.value = '';
        agentEditDesc.value = '';
        agentEditIcon.value = '🤖';
        updateIconPreview('🤖');
        setActiveIconGridItem('🤖');
        agentEditColor.value = '#6366f1';
        setActiveColorSwatch('#6366f1');
        agentEditPrompt.value = '';
    }
    showAgentEditView();
}

/** 保存 Agent（创建或更新） */
async function saveAgent(): Promise<void> {
    if (!gatewayClient) return;
    const name = agentEditName.value.trim();
    if (!name) { agentEditName.focus(); return; }

    try {
        if (editingAgentId) {
            // 更新
            await gatewayClient.updateAgent(editingAgentId, {
                name,
                description: agentEditDesc.value.trim() || undefined,
                icon: agentEditIcon.value.trim() || undefined,
                color: agentEditColor.value || undefined,
                systemPrompt: agentEditPrompt.value.trim() || undefined,
            });
        } else {
            // 创建（ID 由后端自动生成）
            await gatewayClient.createAgent({
                id: '', // 后端忽略，自动生成
                name,
                description: agentEditDesc.value.trim() || undefined,
                icon: agentEditIcon.value.trim() || undefined,
                color: agentEditColor.value || undefined,
                systemPrompt: agentEditPrompt.value.trim() || undefined,
            });
        }
        hideAgentEditView();
        await loadLocalAgents(); // 刷新列表
    } catch (e) {
        console.error('[Agent] 保存 Agent 失败:', e);
        alert('保存失败: ' + (e as Error).message);
    }
}

/** 删除本地 Agent */
/** 自定义确认弹窗（替代原生 confirm，Tauri WebView 中原生 confirm 不可靠） */
function showConfirmDialog(message: string): Promise<boolean> {
    return new Promise((resolve) => {
        const overlay = document.getElementById('confirm-dialog-overlay')!;
        const msgEl = document.getElementById('confirm-dialog-message')!;
        const okBtn = document.getElementById('confirm-dialog-ok')!;
        const cancelBtn = document.getElementById('confirm-dialog-cancel')!;

        msgEl.textContent = message;
        overlay.classList.remove('hidden');

        const cleanup = () => {
            overlay.classList.add('hidden');
            okBtn.removeEventListener('click', onOk);
            cancelBtn.removeEventListener('click', onCancel);
        };
        const onOk = () => { cleanup(); resolve(true); };
        const onCancel = () => { cleanup(); resolve(false); };

        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
    });
}

async function deleteLocalAgent(agentId: string, agentName: string): Promise<void> {
    if (!gatewayClient) return;
    // 默认 Agent 不可删除
    const agent = agentsList.find(a => a.id === agentId);
    if (agent && agent.default) {
        await showConfirmDialog(`默认 Agent "${agentName}" 不可删除。`);
        return;
    }
    const confirmed = await showConfirmDialog(`确定要删除 Agent "${agentName}" 吗？\n注意：Agent 的聊天历史将被清除。`);
    if (!confirmed) return;
    try {
        await gatewayClient.deleteAgent(agentId);
        // 如果删除的是当前激活的 Agent，切换到第一个可用 Agent
        if (currentAgentId === agentId) {
            currentAgentId = null;
            // 自动切到默认或第一个 Agent
            const remaining = agentsList.filter(a => a.id !== agentId);
            if (remaining.length > 0) {
                const fallback = remaining.find(a => a.default) || remaining[0];
                switchToAgent(fallback.id);
            }
        }
        await loadLocalAgents();
    } catch (e) {
        console.error('[Agent] 删除 Agent 失败:', e);
        await showConfirmDialog('删除失败: ' + (e as Error).message);
    }
}

// Agent 编辑事件绑定
newSessionBtn.addEventListener('click', () => openAgentEditModal());
agentEditSave.addEventListener('click', () => saveAgent());
agentEditCancel.addEventListener('click', () => hideAgentEditView());
agentEditBack.addEventListener('click', () => hideAgentEditView());

// ---- 侧边栏 Agent 列表 ----

async function loadSidebarAgents(): Promise<void> {
    if (!gatewayClient) return;

    // 未登录时直接显示登录提示，不请求 API
    if (!openfluxLoggedIn) {
        agentListLoginPrompt.classList.remove('hidden');
        // 清除之前渲染的 Agent 项（保留 login prompt）
        sidebarAgentList.querySelectorAll('.sidebar-agent-item, .memory-empty-state').forEach(el => el.remove());
        return;
    }

    agentListLoginPrompt.classList.add('hidden');
    // 清除旧的动态内容（保留 login prompt 元素）
    sidebarAgentList.querySelectorAll('.sidebar-agent-item, .memory-empty-state').forEach(el => el.remove());
    const loadingEl = document.createElement('div');
    loadingEl.className = 'memory-empty-state';
    loadingEl.style.cssText = 'font-size:0.8rem;padding:16px;';
    loadingEl.textContent = t('common.loading');
    sidebarAgentList.appendChild(loadingEl);

    try {
        const agents = await gatewayClient.openfluxAgents();
        cachedOpenFluxAgents = agents || [];
        renderSidebarAgents();
    } catch (e) {
        sidebarAgentList.querySelectorAll('.sidebar-agent-item, .memory-empty-state').forEach(el => el.remove());
        const errEl = document.createElement('div');
        errEl.className = 'memory-empty-state';
        errEl.style.cssText = 'font-size:0.8rem;padding:16px;';
        errEl.textContent = t('common.load_failed');
        sidebarAgentList.appendChild(errEl);
    }
}

function renderSidebarAgents(): void {
    // 清除旧的动态内容（保留 login prompt 元素）
    sidebarAgentList.querySelectorAll('.sidebar-agent-item, .memory-empty-state').forEach(el => el.remove());

    if (cachedOpenFluxAgents.length === 0) {
        const emptyEl = document.createElement('div');
        emptyEl.className = 'memory-empty-state';
        emptyEl.style.cssText = 'font-size:0.8rem;padding:16px;';
        emptyEl.textContent = t('cloud.no_agents');
        sidebarAgentList.appendChild(emptyEl);
        return;
    }
    for (const agent of cachedOpenFluxAgents) {
        const item = document.createElement('div');
        item.className = 'sidebar-agent-item';
        item.title = agent.description || agent.name;
        item.innerHTML = `
            <div class="agent-avatar">${renderAgentIcon((agent as any).icon || '🤖', 20)}</div>
            <span class="agent-name">${escapeHtml(agent.name)}</span>
        `;
        // 双击发起云端聊天
        item.addEventListener('dblclick', () => startCloudChat(agent.appId, agent.name, agent.chatroomId));
        sidebarAgentList.appendChild(item);
    }
}

// ---- 发起云端聊天 ----

async function startCloudChat(appId: number, agentName: string, chatroomId?: number): Promise<void> {
    if (!gatewayClient) return;
    try {
        // 如果没有 chatroomId，通过 appId 查询
        if (!chatroomId) {
            const info = await gatewayClient.openfluxAgentInfo(appId);
            if (!info || !info.chatroomId) {
                alert(t('cloud.agent_no_room'));
                return;
            }
            chatroomId = info.chatroomId;
        }

        // 查找是否已有该 chatroomId 的会话（单一会话模式）
        const sessions = await gatewayClient.getSessions();
        const existing = sessions.find(s => s.cloudChatroomId === chatroomId);

        if (existing) {
            // 已有会话，直接切换
            currentSessionId = existing.id;
            currentCloudChatroomId = chatroomId;
            currentAgentId = '';  // 清除本地 Agent 选中
            // 填充 sessionId → chatroomId 映射
            if (chatroomId) sessionToChatroomMap.set(existing.id, chatroomId);
            isRouterSession = false;
            document.body.classList.remove('router-active');
            hideRouterBindUI();
            (document.querySelector('.input-area') as HTMLElement).classList.remove('hidden');
            switchSidebarMode('agent');
            closeSettingsView();

            // 清除未读标记
            unreadSessionIds.delete(existing.id);
            const cloudCard = sessionList.querySelector(`.cloud-agent-card[data-cloud-chatroom-id="${chatroomId}"]`);
            cloudCard?.querySelector('.unread-badge')?.remove();
            const sessionItem = sessionList.querySelector(`.session-item[data-session-id="${existing.id}"]`);
            sessionItem?.querySelector('.unread-badge')?.remove();

            // 加载已有消息（优先本地，回退云端）
            let messages = await gatewayClient.getMessages(existing.id);
            if ((messages as any[]).length === 0 && chatroomId) {
                console.log('[startCloudChat] Local messages empty, loading from cloud API...');
                try {
                    const cloudMessages = await gatewayClient.openfluxChatHistory(chatroomId);
                    if (cloudMessages && cloudMessages.length > 0) {
                        console.log('[startCloudChat] Loaded', cloudMessages.length, 'cloud messages');
                        messages = cloudMessages.map((cm: any, idx: number) => ({
                            id: `cloud-${Date.now()}-${idx}`,
                            role: cm.role,
                            content: cm.content,
                            createdAt: cm.createdAt || Date.now(),
                        }));
                    }
                } catch (cloudErr) {
                    console.warn('[startCloudChat] Failed to load cloud history:', cloudErr);
                }
            }
            clearMessages();
            clearLogs();
            for (const msg of messages as any[]) {
                addMessage(msg);
            }
        } else {
            // 无已有会话，创建新会话
            const session = await gatewayClient.createSession(undefined, chatroomId, agentName);
            currentSessionId = session.id;
            currentCloudChatroomId = chatroomId;
            currentAgentId = '';  // 清除本地 Agent 选中
            isRouterSession = false;
            document.body.classList.remove('router-active');
            hideRouterBindUI();
            (document.querySelector('.input-area') as HTMLElement).classList.remove('hidden');
            switchSidebarMode('agent');
            clearMessages();
            clearLogs();

            // 显示欢迎消息
            addMessage({
                id: `msg-${Date.now()}`,
                role: 'assistant',
                content: `${t('cloud.connected_to_agent')} **${escapeHtml(agentName)}**`,
                createdAt: Date.now(),
            });
        }

        await loadLocalAgents();
        closeSettingsView();
    } catch (e) {
        console.error('[Cloud] Start cloud chat failed:', e);
        alert(t('cloud.chat_failed', e instanceof Error ? e.message : String(e)));
    }
}

// ========================
// OpenFluxRouter 客户端逻辑
// ========================

let isRouterSession = false;
let routerConnected = false;
let routerEnabled = false;
let routerBound = false;
let routerRealSessionId: string | null = null;

// 托管 LLM 配置状态
let managedLlmAvailable = false;
let managedLlmProvider = '';
let managedLlmModel = '';
let managedLlmQuota: { daily_limit: number; used_today: number } | null = null;
let currentLlmSource: 'local' | 'managed' | 'atlas_managed' = 'local';

/** 切换到 Router 会话 */
async function switchToRouterSession(): Promise<void> {
    isRouterSession = true;
    currentCloudChatroomId = null;
    currentAgentId = '';  // 清除本地 Agent 选中

    // 关闭设置面板
    closeSettingsView();
    // 清空成果物面板（避免上一个会话的成果物残留）
    clearArtifacts();

    // Router 会话为只读视图（不可输入，内容来自 Router 转发和默认 Agent 回复）
    document.body.classList.add('router-active');
    (document.querySelector('.input-area') as HTMLElement).classList.add('hidden');

    // 如果没有 routerRealSessionId，从 Gateway 获取
    if (!routerRealSessionId && gatewayClient) {
        try {
            const configResp = await gatewayClient.routerConfigGet();
            if ((configResp as any).sessionId) {
                routerRealSessionId = (configResp as any).sessionId;
            }
        } catch (_) { /* ignore */ }
    }

    // 加载 Router 会话历史消息
    if (routerRealSessionId && gatewayClient) {
        currentSessionId = routerRealSessionId;
        try {
            const [messages, logs] = await Promise.all([
                gatewayClient.getMessages(routerRealSessionId),
                gatewayClient.getLogs(routerRealSessionId),
            ]);
            const hydratedMessages = await hydrateMessageAttachments(messages);
            renderMessagesWithLogs(hydratedMessages, logs as LogEntry[]);
        } catch (error) {
            console.error('[Router] Load session messages failed:', error);
            messagesContainer.innerHTML = '<div class="empty-state" style="display:flex;align-items:center;justify-content:center;height:100%;color:rgba(255,255,255,0.35);font-size:0.85rem;">' + t('cloud.waiting_messages') + '</div>';
        }
    } else {
        currentSessionId = null;
        messagesContainer.innerHTML = '<div class="empty-state" style="display:flex;align-items:center;justify-content:center;height:100%;color:rgba(255,255,255,0.35);font-size:0.85rem;">' + t('cloud.waiting_messages') + '</div>';
    }

    // 查询绑定状态，只有未绑定时才显示 bind UI
    if (gatewayClient) {
        try {
            const status = await gatewayClient.routerConfigGet();
            if ((status as any).bound !== undefined) {
                routerBound = !!(status as any).bound;
            }
        } catch (_) { /* ignore */ }
    }
    if (!routerBound) {
        showRouterBindUI();
    } else {
        hideRouterBindUI();
    }

    // 渲染 Agent list 以更新高亮
    renderLocalAgents();
}

/** 显示 Router 绑定 UI */
function showRouterBindUI(): void {
    const area = document.getElementById('router-bind-area');
    if (!area) return;
    if (routerBound) {
        area.classList.add('hidden');
    } else {
        area.classList.remove('hidden');
    }
}

/** 隐藏 Router 绑定 UI */
function hideRouterBindUI(): void {
    const area = document.getElementById('router-bind-area');
    if (area) area.classList.add('hidden');
}

/** 处理 Router 绑定操作 */
async function handleRouterBind(): Promise<void> {
    if (!gatewayClient) return;
    const codeInput = document.getElementById('router-bind-code') as HTMLInputElement;
    const statusEl = document.getElementById('router-bind-status');
    const btn = document.getElementById('router-bind-btn') as HTMLButtonElement;
    const code = codeInput?.value?.trim();
    if (!code) {
        if (statusEl) statusEl.textContent = t('router.enter_code');
        return;
    }

    btn.disabled = true;
    if (statusEl) statusEl.textContent = t('router.sending');

    try {
        const result = await gatewayClient.routerBind(code);
        if (result.success) {
            if (statusEl) statusEl.textContent = t('router.waiting_pair');
        } else {
            if (statusEl) statusEl.textContent = t('router.bind_failed', result.message || '');
        }
    } catch (err) {
        if (statusEl) statusEl.textContent = t('router.bind_error');
    } finally {
        btn.disabled = false;
    }
}



/** 加载 Router 配置到 UI */
async function loadRouterConfig(): Promise<void> {
    if (!gatewayClient) return;
    try {
        const result = await gatewayClient.routerConfigGet();
        routerConnected = result.connected;
        if (result.config) routerEnabled = !!result.config.enabled;
        updateRouterStatusDot(result.connected);

        // 同步绑定状态（服务端记录的 Router connect_status 中的 bound 值）
        if ((result as any).bound !== undefined) {
            routerBound = !!(result as any).bound;
        }

        if (result.config) {
            const urlInput = document.getElementById('router-url') as HTMLInputElement;
            const appIdInput = document.getElementById('router-app-id') as HTMLInputElement;
            const apiKeyInput = document.getElementById('router-api-key') as HTMLInputElement;
            const enabledCheckbox = document.getElementById('router-enabled') as HTMLInputElement;

            if (urlInput) urlInput.value = result.config.url || '';
            if (appIdInput) appIdInput.value = result.config.appId || '';
            if (apiKeyInput) apiKeyInput.placeholder = result.config.apiKey ? t('cloud.api_key_configured') : 'Bearer Token';
            if (enabledCheckbox) enabledCheckbox.checked = result.config.enabled;

            // App User ID
            const appUserIdInput = document.getElementById('router-app-user-id') as HTMLInputElement;
            let uid = result.config.appUserId || '';
            if (!uid) {
                uid = generateAppUserId();
                // 自动保存生成的 ID
                gatewayClient!.routerConfigUpdate({ appUserId: uid }).catch(() => { });
            }
            if (appUserIdInput) appUserIdInput.value = uid;
        }
    } catch (err) {
        console.error('[Router] Load config failed:', err);
    }
}

/** 保存 Router 配置 */
async function saveRouterConfig(): Promise<void> {
    if (!gatewayClient) return;
    const hint = document.getElementById('router-save-hint');

    const url = (document.getElementById('router-url') as HTMLInputElement)?.value?.trim() || '';
    const appId = (document.getElementById('router-app-id') as HTMLInputElement)?.value?.trim() || '';
    const apiKey = (document.getElementById('router-api-key') as HTMLInputElement)?.value?.trim() || '';
    const enabled = (document.getElementById('router-enabled') as HTMLInputElement)?.checked || false;

    try {
        const payload: any = { url, appId, appType: 'openflux', enabled };
        if (apiKey) payload.apiKey = apiKey;
        const appUserId = (document.getElementById('router-app-user-id') as HTMLInputElement)?.value?.trim() || '';
        if (appUserId) payload.appUserId = appUserId;
        const result = await gatewayClient.routerConfigUpdate(payload);
        if (result.success) {
            if (hint) { hint.textContent = '✅ 已保存'; setTimeout(() => { hint.textContent = ''; }, 2000); }
        } else {
            if (hint) { hint.textContent = '❌ ' + (result.message || t('common.save_failed')); }
        }
    } catch (err) {
        if (hint) { hint.textContent = '❌ ' + t('common.save_failed'); }
    }
}

/** 更新 Router 状态指示灯 */
function updateRouterStatusDot(connected: boolean): void {
    const dot = document.getElementById('router-status-dot');
    if (dot) {
        dot.className = `router-status-dot ${connected ? 'connected' : 'disconnected'}`;
        dot.title = connected ? '已连接' : '未连接';
    }
}

/** 生成随机 App User ID */
function generateAppUserId(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let id = 'ofu_';
    for (let i = 0; i < 12; i++) {
        id += chars[Math.floor(Math.random() * chars.length)];
    }
    return id;
}

/** 初始化 Router 事件监听 */
/** 测试 Router 连接 */
async function testRouterConnection(): Promise<void> {
    if (!gatewayClient) return;
    const hint = document.getElementById('router-save-hint');
    const testBtn = document.getElementById('router-test-btn') as HTMLButtonElement;

    const url = (document.getElementById('router-url') as HTMLInputElement)?.value?.trim() || '';
    const appId = (document.getElementById('router-app-id') as HTMLInputElement)?.value?.trim() || '';
    const apiKey = (document.getElementById('router-api-key') as HTMLInputElement)?.value?.trim() || '';

    if (!url || !appId) {
        if (hint) hint.textContent = '⚠️ ' + t('cloud.fill_router_info');
        return;
    }

    if (testBtn) { testBtn.disabled = true; testBtn.textContent = t('router.testing'); }
    if (hint) hint.textContent = t('router.testing');

    try {
        const payload: any = { url, appId, appType: 'openflux' };
        if (apiKey) payload.apiKey = apiKey;
        const result = await gatewayClient.routerTest(payload);
        if (hint) {
            hint.textContent = result.success ? `✅ ${result.message}` : `❌ ${result.message}`;
            setTimeout(() => { hint.textContent = ''; }, 5000);
        }
    } catch (err) {
        if (hint) hint.textContent = t('router.test_failed');
    } finally {
        if (testBtn) { testBtn.disabled = false; testBtn.textContent = t('common.test_connection'); }
    }
}

function initRouterListeners(): void {
    if (!gatewayClient) return;

    // 入站消息（用户消息从 Router 进入 Agent 处理）
    gatewayClient.onRouterMessage(async (msg) => {
        // 保存 Router 的真实 session ID
        if (msg.sessionId) {
            routerRealSessionId = msg.sessionId;
        }

        // 如果当前正在 Router 会话，实时追加用户消息气泡
        if (isRouterSession) {
            currentSessionId = routerRealSessionId;
            // 记录为 chat 目标会话（让进度事件正确渲染）
            if (routerRealSessionId) {
                chatTargetSessionIds.add(routerRealSessionId);
            }
            // 重置进度卡片
            currentProgressCard = null;
            progressItems = [];

            // 处理多媒体附件
            const msgPayload = msg as any;
            let messageAttachments: MessageAttachment[] | undefined;

            if (msgPayload.attachments?.length) {
                messageAttachments = [];
                for (const a of msgPayload.attachments) {
                    const attachment: MessageAttachment = {
                        name: a.name,
                        ext: a.ext,
                        size: a.size,
                        path: a.path,
                    };
                    // 图片附件：通过 file_read 获取缩略图
                    if (a.content_type === 'image' || IMAGE_EXTS_SET.has(a.ext?.toLowerCase())) {
                        try {
                            const result = await invoke<any>('file_read', { filePath: a.path });
                            if (result.dataUrl) {
                                attachment.thumbnailUrl = result.dataUrl;
                            }
                        } catch { /* 文件读取失败，忽略缩略图 */ }
                    }
                    messageAttachments.push(attachment);
                }
            }

            addMessage({
                id: `router-${Date.now()}`,
                role: 'user',
                content: msg.content,
                createdAt: msg.timestamp || Date.now(),
                attachments: messageAttachments,
            });
        }
    });

    // 连接状态变化
    gatewayClient.onRouterStatus((status) => {
        routerConnected = status.connected;
        if (status.connected) routerEnabled = true;
        updateRouterStatusDot(status.connected);
        // 仅在 Router 会话项尚不存在时才刷新列表
        const existing = sessionList.querySelector('.router-session-item');
        if (!existing && routerEnabled) {
            loadLocalAgents();
        }
    });

    // 监听托管 LLM 配置推送
    gatewayClient.onManagedLlmConfig((cfg) => {
        managedLlmAvailable = cfg.available;
        managedLlmProvider = cfg.provider || '';
        managedLlmModel = cfg.model || '';
        managedLlmQuota = cfg.quota || null;
        if (cfg.currentSource) currentLlmSource = cfg.currentSource;
        updateManagedLlmUI();
        console.log('[LLM] Hosted config updated:', { available: cfg.available, provider: cfg.provider, model: cfg.model });

        // 修复时序问题：Router 模式下托管配置异步到达时，如果 Gateway 仍为 local，自动激活 managed
        if (cfg.available && currentWorkingMode === 'router' && currentLlmSource === 'local') {
            console.log('[LLM] Auto-switching to managed (Router config arrived after mode switch)');
            gatewayClient.setLlmSource('managed').then(() => {
                currentLlmSource = 'managed';
            }).catch(() => {});
        }
    });

    // 连接后查询当前 LLM source
    gatewayClient.getLlmSource().then((result) => {
        currentLlmSource = result.source;
        if (result.managed) {
            managedLlmAvailable = result.managed.available;
            managedLlmProvider = result.managed.provider || '';
            managedLlmModel = result.managed.model || '';
            managedLlmQuota = result.managed.quota || null;
        }
        // 同步前端模式卡片状态
        if (result.source === 'atlas_managed' && currentWorkingMode !== 'managed') {
            currentWorkingMode = 'managed';
            localStorage.setItem('openflux-working-mode', 'managed');
            workingModeCards.forEach(card => {
                card.classList.toggle('active', card.dataset.mode === 'managed');
            });
        }
        updateManagedLlmUI();
    }).catch(() => {
        // 旧版 Gateway 不支持或请求失败，仍需创建 UI 容器显示默认状态
        updateManagedLlmUI();
    });

    // 保存按钮
    // 重新生成 App User ID
    document.getElementById('router-regenerate-uid')?.addEventListener('click', () => {
        const input = document.getElementById('router-app-user-id') as HTMLInputElement;
        if (input) input.value = generateAppUserId();
    });

    // 测试按钮
    document.getElementById('router-test-btn')?.addEventListener('click', testRouterConnection);

    // 绑定结果监听（包括 connect_status 推送）
    gatewayClient.onRouterBindResult((result) => {
        const statusEl = document.getElementById('router-bind-status');

        // Router 连接后自动推送的绑定状态
        if (result.action === 'connect_status') {
            const payload = result as any;
            console.log('[Router] connect_status received in onRouterBindResult:', JSON.stringify(payload));
            if (payload.bound) {
                routerBound = true;
                hideRouterBindUI();
                // 同步弹窗状态
                document.getElementById('qr-bind-popup-initial')?.classList.add('hidden');
                document.getElementById('qr-bind-popup-display')?.classList.add('hidden');
                document.getElementById('qr-bind-popup-success')?.classList.remove('hidden');
                console.log('[Router] Platform user bound');
            } else {
                routerBound = false;
                // 同步弹窗状态
                document.getElementById('qr-bind-popup-initial')?.classList.remove('hidden');
                document.getElementById('qr-bind-popup-display')?.classList.add('hidden');
                document.getElementById('qr-bind-popup-success')?.classList.add('hidden');
                if (isRouterSession) showRouterBindUI();
            }
            return;
        }

        // 常规绑定结果
        if (result.status === 'matched') {
            routerBound = true;
            if (statusEl) statusEl.textContent = t('router.bind_success');
            setTimeout(() => {
                hideRouterBindUI();
                // bind 成功后刷新 Router 会话历史
                if (isRouterSession) switchToRouterSession();
            }, 1500);
        } else if (result.status === 'pending') {
            if (statusEl) statusEl.textContent = t('router.waiting_pair');
        } else if (result.status === 'already_bound') {
            routerBound = true;
            if (statusEl) statusEl.textContent = t('router.already_bound');
            setTimeout(() => {
                hideRouterBindUI();
                if (isRouterSession) switchToRouterSession();
            }, 1500);
        } else {
            if (statusEl) statusEl.textContent = '❌ ' + (result.message || t('router.bind_error'));
        }
    });

    // 绑定按钮
    document.getElementById('router-bind-btn')?.addEventListener('click', handleRouterBind);
    // Enter 键触发绑定
    document.getElementById('router-bind-code')?.addEventListener('keydown', (e) => {
        if ((e as KeyboardEvent).key === 'Enter') handleRouterBind();
    });

    // 保存按钮
    document.getElementById('router-save-btn')?.addEventListener('click', saveRouterConfig);


    // ===== 顶栏 QR 按钮 =====
    const qrTopWrap = document.getElementById('qr-bind-topbar-wrap');
    const qrTopBtn = document.getElementById('qr-bind-topbar-btn');
    const qrPopup = document.getElementById('qr-bind-popup');
    let routerConnected = false;

    // 始终显示按钮
    if (qrTopWrap) qrTopWrap.style.display = '';

    // Router 状态变化 → 更新弹窗内容
    gatewayClient.onRouterStatus((status: any) => {
        console.log('[QR Popup] onRouterStatus fired:', JSON.stringify(status));
        routerConnected = !!status?.connected;
        const popupInitial = document.getElementById('qr-bind-popup-initial');
        const popupSuccess = document.getElementById('qr-bind-popup-success');
        const popupDisplay = document.getElementById('qr-bind-popup-display');
        const popupDesc = document.querySelector('.qr-bind-popup-desc') as HTMLElement | null;
        const popupGenBtn = document.getElementById('qr-bind-popup-generate') as HTMLButtonElement | null;

        if (!routerConnected) {
            // 未配置 Router
            popupInitial?.classList.remove('hidden');
            popupDisplay?.classList.add('hidden');
            popupSuccess?.classList.add('hidden');
            if (popupDesc) popupDesc.textContent = '请先在 设置 → Router 中配置连接后再使用';
            if (popupGenBtn) { popupGenBtn.disabled = true; popupGenBtn.textContent = '未配置 Router'; }
        } else if (status?.bound) {
            console.log('[QR Popup] Setting BOUND state');
            popupInitial?.classList.add('hidden');
            popupDisplay?.classList.add('hidden');
            popupSuccess?.classList.remove('hidden');
        } else {
            console.log('[QR Popup] Setting UNBOUND state');
            popupInitial?.classList.remove('hidden');
            popupDisplay?.classList.add('hidden');
            popupSuccess?.classList.add('hidden');
            if (popupDesc) popupDesc.textContent = '生成二维码，使用 OpenFlux App 扫码绑定';
            if (popupGenBtn) { popupGenBtn.disabled = false; popupGenBtn.textContent = '生成绑定二维码'; }
        }
    });

    // 点击弹窗开关
    qrTopBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        qrPopup?.classList.toggle('hidden');
    });

    // 关闭按钮
    document.getElementById('qr-bind-popup-close')?.addEventListener('click', () => {
        qrPopup?.classList.add('hidden');
    });

    // 点击外部关闭
    document.addEventListener('click', (e) => {
        if (qrPopup && !qrPopup.classList.contains('hidden') &&
            !(qrTopWrap?.contains(e.target as Node))) {
            qrPopup.classList.add('hidden');
        }
    });

    // 弹窗内生成按钮
    let qrPopupTimerId: ReturnType<typeof setInterval> | null = null;

    document.getElementById('qr-bind-popup-generate')?.addEventListener('click', async () => {
        if (!gatewayClient || !routerConnected) return;
        const btn = document.getElementById('qr-bind-popup-generate') as HTMLButtonElement;
        btn.disabled = true;
        btn.textContent = '生成中...';
        try {
            await gatewayClient.routerQRBind();
        } catch {
            btn.disabled = false;
            btn.textContent = '生成绑定二维码';
        }
    });

    document.getElementById('qr-bind-popup-refresh')?.addEventListener('click', async () => {
        if (!gatewayClient || !routerConnected) return;
        try { await gatewayClient.routerQRBind(); } catch { /* ignore */ }
    });

    // QR 码回调
    gatewayClient.onRouterQRBindCode(async (data) => {
        const popupInitial = document.getElementById('qr-bind-popup-initial')!;
        const popupDisplay = document.getElementById('qr-bind-popup-display')!;
        const popupCanvas = document.getElementById('qr-bind-popup-canvas') as HTMLCanvasElement;
        const popupTimer = document.getElementById('qr-bind-popup-timer')!;
        const popupRefresh = document.getElementById('qr-bind-popup-refresh') as HTMLButtonElement;
        const popupHint = document.getElementById('qr-bind-popup-hint')!;
        const popupGenBtn = document.getElementById('qr-bind-popup-generate') as HTMLButtonElement;

        if (data.status === 'error') {
            popupGenBtn.disabled = false;
            popupGenBtn.textContent = '生成绑定二维码';
            popupHint.textContent = data.message || '生成失败';
            return;
        }

        try {
            const QRCode = (await import('qrcode')).default;
            await QRCode.toCanvas(popupCanvas, data.qr_data || '', {
                width: 160, margin: 1,
                color: { dark: '#1e1b4b', light: '#ffffff' },
            });
        } catch (err) {
            console.error('[QR] Popup render failed:', err);
            return;
        }

        popupInitial.classList.add('hidden');
        popupDisplay.classList.remove('hidden');
        document.getElementById('qr-bind-popup-success')?.classList.add('hidden');
        popupRefresh.style.display = 'none';
        popupHint.textContent = '使用 OpenFlux App 扫描';
        popupGenBtn.disabled = false;
        popupGenBtn.textContent = '生成绑定二维码';

        // 倒计时
        if (qrPopupTimerId) clearInterval(qrPopupTimerId);
        let remaining = data.expires_in || 300;
        const tick = () => {
            const m = Math.floor(remaining / 60);
            const s = remaining % 60;
            popupTimer.textContent = `${m}:${s.toString().padStart(2, '0')}`;
            if (remaining <= 0) {
                if (qrPopupTimerId) clearInterval(qrPopupTimerId);
                popupTimer.textContent = '已过期';
                popupRefresh.style.display = '';
                popupHint.textContent = '点击刷新重新生成';
            }
        };
        tick();
        qrPopupTimerId = setInterval(() => { remaining--; tick(); }, 1000);
    });

    // QR 绑定成功
    gatewayClient.onRouterQRBindSuccess((_data) => {
        if (qrPopupTimerId) { clearInterval(qrPopupTimerId); qrPopupTimerId = null; }
        document.getElementById('qr-bind-popup-display')?.classList.add('hidden');
        document.getElementById('qr-bind-popup-initial')?.classList.add('hidden');
        document.getElementById('qr-bind-popup-success')?.classList.remove('hidden');
        console.log('[QR] App bind success');
    });
}

/** 更新托管 LLM 配置 UI（仅同步开关状态） */
function updateManagedLlmUI(): void {
    const toggle = document.getElementById('llm-source-toggle') as HTMLInputElement | null;
    if (!toggle) return;

    // 首次绑定事件（避免重复绑定）
    if (!toggle.dataset.bound) {
        toggle.dataset.bound = '1';
        toggle.addEventListener('change', async () => {
            if (!gatewayClient) return;
            const source = toggle.checked ? 'managed' : 'local';
            try {
                await gatewayClient.setLlmSource(source);
                currentLlmSource = source;
            } catch (err) {
                console.error('Switch LLM source failed:', err);
                toggle.checked = !toggle.checked; // 回退
            }
        });
    }

    // 同步开关状态
    toggle.checked = currentLlmSource === 'managed';
}

// ========================
// 反馈窗口（独立 OS 窗口）
// ========================
(function initFeedbackButton() {
    const openBtn = document.getElementById('feedback-btn');
    if (!openBtn) return;

    openBtn.addEventListener('click', async () => {
        try {
            const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
            const feedbackUrl = `${window.location.origin}/feedback.html`;

            const fbWin = new WebviewWindow('feedback-window', {
                url: feedbackUrl,
                title: '💬 反馈',
                width: 480,
                height: 580,
                minWidth: 400,
                minHeight: 460,
                center: true,
                decorations: false,
                resizable: true,
                focus: true,
            });

            fbWin.once('tauri://error', (e) => {
                console.error('Failed to create feedback window:', e);
            });
        } catch {
            // 非 Tauri 环境，直接打开新标签页
            window.open('/feedback.html', '_blank', 'width=480,height=580');
        }
    });
})();

// ========================
// 微信 iLink 前端逻辑
// ========================
function initWeixinListeners(): void {
    if (!gatewayClient) return;

    const statusDot = document.getElementById('weixin-status-dot');
    const connectedInfo = document.getElementById('weixin-connected-info');
    const loginSection = document.getElementById('weixin-login-section');
    const accountLabel = document.getElementById('weixin-account-label');
    const qrContainer = document.getElementById('weixin-qr-container');
    const qrImg = document.getElementById('weixin-qr-img') as HTMLImageElement | null;
    const qrStatus = document.getElementById('weixin-qr-status');
    const qrLoginBtn = document.getElementById('weixin-qr-login-btn');
    const disconnectBtn = document.getElementById('weixin-disconnect-btn');
    const dmPolicySelect = document.getElementById('weixin-dm-policy') as HTMLSelectElement | null;
    const allowlistSection = document.getElementById('weixin-allowlist-section');
    const allowedUsersTA = document.getElementById('weixin-allowed-users') as HTMLTextAreaElement | null;
    const saveBtn = document.getElementById('weixin-save-btn');
    const saveHint = document.getElementById('weixin-save-hint');
    const testBtn = document.getElementById('weixin-test-btn');

    function updateWeixinUI(connected: boolean, accountId?: string) {
        if (statusDot) {
            statusDot.className = `router-status-dot ${connected ? 'connected' : 'disconnected'}`;
            statusDot.title = connected ? '已连接' : '未连接';
        }
        if (connectedInfo) connectedInfo.style.display = connected ? '' : 'none';
        if (loginSection) loginSection.style.display = connected ? 'none' : '';
        if (accountLabel && accountId) accountLabel.textContent = `Account: ${accountId.slice(0, 12)}...`;
    }

    // 连接状态变化
    gatewayClient.onWeixinStatus((status) => {
        updateWeixinUI(status.connected);
    });

    // QR 码推送
    gatewayClient.onWeixinQRCode((data) => {
        console.log('[Weixin] QR code received!', JSON.stringify(data).slice(0, 200));
        if (qrContainer) {
            qrContainer.style.display = '';
        } else {
            console.warn('[Weixin] qrContainer is NULL');
        }
        if (qrImg) {
            if (data.qrImgContent) {
                qrImg.src = data.qrImgContent;
                console.log('[Weixin] img.src =', data.qrImgContent.slice(0, 80));
            } else {
                qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=${encodeURIComponent(data.qrUrl)}`;
            }
        } else {
            console.warn('[Weixin] qrImg is NULL');
        }
        if (qrStatus) qrStatus.textContent = '请使用微信扫描二维码';
        if (qrLoginBtn) qrLoginBtn.disabled = true;
    });

    // QR 扫码状态
    gatewayClient.onWeixinQRStatus((data) => {
        if (qrStatus) {
            const icons: Record<string, string> = {
                scanned: '✅', expired: '⏰', error: '❌', confirmed: '🎉', timeout: '⏳'
            };
            qrStatus.textContent = `${icons[data.status] || '⚪'} ${data.message}`;
        }
        if (data.status === 'confirmed' || data.status === 'error' || data.status === 'timeout') {
            if (qrLoginBtn) qrLoginBtn.disabled = false;
        }
    });

    // 登录成功
    gatewayClient.onWeixinLoginSuccess((data) => {
        updateWeixinUI(true, data.accountId);
        if (qrContainer) qrContainer.style.display = 'none';
        if (qrLoginBtn) qrLoginBtn.disabled = false;
        if (saveHint) {
            saveHint.textContent = '✅ 微信连接成功！';
            saveHint.style.color = 'var(--color-success, #52c41a)';
            setTimeout(() => { if (saveHint) saveHint.textContent = ''; }, 3000);
        }
    });

    // QR 登录按钮
    qrLoginBtn?.addEventListener('click', async () => {
        if (!gatewayClient) return;
        qrLoginBtn.disabled = true;
        if (qrStatus) qrStatus.textContent = '正在获取二维码...';
        try {
            await gatewayClient.weixinQRLogin();
        } catch (err) {
            if (qrStatus) qrStatus.textContent = '❌ 获取二维码失败: ' + String(err);
            qrLoginBtn.disabled = false;
        }
    });

    // 断开按钮
    disconnectBtn?.addEventListener('click', async () => {
        if (!gatewayClient) return;
        await gatewayClient.weixinDisconnect();
        updateWeixinUI(false);
    });

    // DM 策略切换
    dmPolicySelect?.addEventListener('change', () => {
        if (allowlistSection) {
            allowlistSection.style.display = dmPolicySelect.value === 'allowlist' ? '' : 'none';
        }
    });

    // 保存配置
    saveBtn?.addEventListener('click', async () => {
        if (!gatewayClient) return;
        const policy = dmPolicySelect?.value || 'open';
        const users = (allowedUsersTA?.value || '').split('\n').map(s => s.trim()).filter(Boolean);
        try {
            const result = await gatewayClient.weixinConfigUpdate({
                dmPolicy: policy,
                allowedUsers: users,
            });
            if (saveHint) {
                saveHint.textContent = result.success ? '✅ 已保存' : '❌ ' + (result.message || '保存失败');
                saveHint.style.color = result.success ? 'var(--color-success, #52c41a)' : 'var(--color-danger, #f5222d)';
                setTimeout(() => { if (saveHint) saveHint.textContent = ''; }, 3000);
            }
        } catch (err) {
            if (saveHint) {
                saveHint.textContent = '❌ ' + String(err);
                saveHint.style.color = 'var(--color-danger, #f5222d)';
            }
        }
    });

    // 测试连接
    testBtn?.addEventListener('click', async () => {
        if (!gatewayClient) return;
        testBtn.disabled = true;
        testBtn.textContent = '测试中...';
        try {
            const result = await gatewayClient.weixinTest();
            if (saveHint) {
                const msg = result.connected ? '✅ 微信已连接' :
                             result.configured ? '⚠️ 已配置但未连接' : '❌ 未配置';
                saveHint.textContent = msg;
                saveHint.style.color = result.connected ? 'var(--color-success, #52c41a)' : 'var(--color-warning, #faad14)';
                setTimeout(() => { if (saveHint) saveHint.textContent = ''; }, 3000);
            }
        } catch (err) {
            if (saveHint) {
                saveHint.textContent = '❌ ' + String(err);
                saveHint.style.color = 'var(--color-danger, #f5222d)';
            }
        } finally {
            testBtn.disabled = false;
            testBtn.textContent = '测试连接';
        }
    });

    // 初始加载微信状态
    gatewayClient.weixinConfigGet().then((cfg: any) => {
        if (cfg) {
            updateWeixinUI(!!cfg.connected, cfg.accountId);
            if (dmPolicySelect && cfg.dmPolicy) dmPolicySelect.value = cfg.dmPolicy;
            if (allowlistSection) {
                allowlistSection.style.display = cfg.dmPolicy === 'allowlist' ? '' : 'none';
            }
            if (allowedUsersTA && Array.isArray(cfg.allowedUsers)) {
                allowedUsersTA.value = cfg.allowedUsers.join('\n');
            }
        }
    }).catch(() => {});
}

// 初始化
init();
// 延迟初始化语音（不阻塞主 UI）
setTimeout(() => initVoice(), 1000);
