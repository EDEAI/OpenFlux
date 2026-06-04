import { invoke } from '@tauri-apps/api/core';
import { open as tauriDialogOpen, save as tauriDialogSave } from '@tauri-apps/plugin-dialog';
/**
 * Renderer-process entry; chat UI
 * Thin-client mode: connects to the Gateway Server over WebSocket
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
import { initShareImage } from './share-image';
import { initBrand } from './brand';
import zhPack from './i18n/zh';
import enPack from './i18n/en';
import {
    formatTime, escapeHtml, blobToBase64, getFileExt,
    getAttachmentIconClass, getAttachmentIconLabel, formatAttachmentSize,
    formatFileSize, formatBytes, getFileIcon, normalizePath, renderAgentIcon,
} from './utils/format';
import { getToolLog, getToolResultSummary } from './utils/tool-log';
import { formatCountdown, formatTriggerDisplay } from './utils/scheduler-format';

// Initialize i18n (auto-detect locale from localStorage or browser)
initI18n(zhPack, enPack);

// Read optional brand/theme config and apply theme color / default language / feature visibility (fall back to the original look if absent)
void initBrand();

// Platform detection: add a platform-marker CSS class to body
const isMacOS = navigator.platform.toUpperCase().includes('MAC');
if (isMacOS) {
    document.body.classList.add('platform-macos');

    // macOS: titleBarStyle Overlay -webkit-app-region: drag
    // CSS drag( main.css), JS startDragging()
    import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
        const appWindow = getCurrentWindow();
        const titleBar = document.querySelector('.title-bar') as HTMLElement;
        if (titleBar) {
            titleBar.addEventListener('mousedown', (e) => {
                // Only the left button, and not on interactive elements like buttons/inputs
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
    path?: string;          // file path (used for pre-opening)
    thumbnailUrl?: string;  // image thumbnail (used for UI display only)
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
// Attachment type definition
// ========================

interface PendingAttachment {
    path: string;
    name: string;
    size: number;
    ext: string;        // lowercase extension, e.g. xlsx
    type: 'image' | 'document' | 'text';
    thumbnailUrl?: string;  // image thumbnail URL (generated via URL.createObjectURL)
}

/** Image extension set (used to restore attachment thumbnails) */
const IMAGE_EXTS_SET = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);

/**
 * Convert the server-returned SessionMessage[] into Message[] with attachment thumbnails
 * Image attachments are asynchronously restored to dataUrl thumbnails via fileRead */
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

                // Image attachment: try to read a dataUrl from the local file as a thumbnail
                if (IMAGE_EXTS_SET.has(a.ext?.toLowerCase())) {
                    try {
                        const result = await invoke<any>('file_read', { filePath: a.path });
                        if (result.dataUrl) {
                            attachment.thumbnailUrl = result.dataUrl;
                        }
                    } catch { /* file may have been deleted; ignore */ }
                }

                return attachment;
            }));
        }

        return message;
    }));
}

/** File extensions that support drag-and-drop */
const SUPPORTED_DROP_EXTS: Record<string, PendingAttachment['type']> = {
    // Images
    '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image',
    '.webp': 'image', '.bmp': 'image', '.svg': 'image',
    // Documents
    '.xlsx': 'document', '.xls': 'document',
    '.docx': 'document',
    '.pdf': 'document',
    '.pptx': 'document',
    // Text & config
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
    // Archives
    '.zip': 'document', '.rar': 'document',
};

// DOM
const messageInput = document.getElementById('message-input') as HTMLTextAreaElement;
const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
const messagesContainer = document.getElementById('messages') as HTMLDivElement;

// Session list related
const SESSION_PAGE_SIZE = 20; // number of items to load each time
const sessionMsgOffset = new Map<string, number>(); // loaded offset per sessionId (counting back from the end)
const sessionMsgHasMore = new Map<string, boolean>(); // whether the sessionId has more messages
let isLoadingMoreMessages = false; // prevent duplicate triggering
const sessionList = document.getElementById('session-list') as HTMLDivElement;
const newSessionBtn = document.getElementById('new-session-btn') as HTMLButtonElement;
const statusIndicator = document.getElementById('status-indicator') as HTMLDivElement;
const confirmModal = document.getElementById('confirm-modal') as HTMLDivElement;
const confirmMessage = document.getElementById('confirm-message') as HTMLParagraphElement;
const confirmYes = document.getElementById('confirm-yes') as HTMLButtonElement;
const confirmNo = document.getElementById('confirm-no') as HTMLButtonElement;
const attachmentPreview = document.getElementById('attachment-preview') as HTMLDivElement;
const inputContainer = document.querySelector('.input-container') as HTMLDivElement;

// UI
const sidebar = document.getElementById('sidebar') as HTMLElement;
const sidebarToggle = document.getElementById('sidebar-toggle') as HTMLButtonElement;
const btnMinimize = document.getElementById('btn-minimize') as HTMLButtonElement;
const btnMaximize = document.getElementById('btn-maximize') as HTMLButtonElement;
const btnClose = document.getElementById('btn-close') as HTMLButtonElement;

// Search related


// Search related
const agentListLoginPrompt = document.getElementById('agent-list-login-prompt') as HTMLDivElement;
const settingsBtn = document.getElementById('settings-btn') as HTMLButtonElement;

// Settings view (center area)
const settingsView = document.getElementById('settings-view') as HTMLDivElement;
const debugModeToggle = document.getElementById('debug-mode-toggle') as HTMLInputElement;

// Tab
const settingsTabs = settingsView.querySelectorAll('.settings-tab') as NodeListOf<HTMLButtonElement>;
const settingsTabContents = settingsView.querySelectorAll('.settings-tab-content') as NodeListOf<HTMLDivElement>;

// DOM
const serverOrchProvider = document.getElementById('server-orch-provider') as HTMLSelectElement;
const serverOrchModel = document.getElementById('server-orch-model') as HTMLSelectElement;
const serverOrchModelCustom = document.getElementById('server-orch-model-custom') as HTMLInputElement;
const serverExecProvider = document.getElementById('server-exec-provider') as HTMLSelectElement;
const serverExecModel = document.getElementById('server-exec-model') as HTMLSelectElement;
const serverExecModelCustom = document.getElementById('server-exec-model-custom') as HTMLInputElement;
const serverProviderKeysContainer = document.getElementById('server-provider-keys') as HTMLDivElement;
// Gateway section removed, no longer referenced
// const serverGatewayMode = document.getElementById('server-gateway-mode') as HTMLSpanElement;
// const serverGatewayPort = document.getElementById('server-gateway-port') as HTMLSpanElement;
const serverSaveBtn = document.getElementById('server-save-btn') as HTMLButtonElement;
const serverSaveHint = document.getElementById('server-save-hint') as HTMLSpanElement;
const serverEmbeddingProvider = document.getElementById('server-embedding-provider') as HTMLSelectElement | null;
const serverEmbeddingModel = document.getElementById('server-embedding-model') as HTMLInputElement | null;
const embeddingRebuildProgress = document.getElementById('embedding-rebuild-progress') as HTMLDivElement | null;
const embeddingProgressPercent = embeddingRebuildProgress?.querySelector('.embedding-progress-percent') as HTMLSpanElement | null;
const embeddingProgressBarFill = embeddingRebuildProgress?.querySelector('.embedding-progress-bar-fill') as HTMLDivElement | null;

// Web DOM
const serverWebSearchProvider = document.getElementById('server-web-search-provider') as HTMLSelectElement;
const serverWebSearchApiKey = document.getElementById('server-web-search-apikey') as HTMLInputElement;
const serverWebSearchApiKeyToggle = document.getElementById('server-web-search-apikey-toggle') as HTMLButtonElement;
const serverWebSearchMaxResults = document.getElementById('server-web-search-max-results') as HTMLInputElement;
const serverWebFetchReadability = document.getElementById('server-web-fetch-readability') as HTMLInputElement;
const serverWebFetchMaxChars = document.getElementById('server-web-fetch-max-chars') as HTMLInputElement;

// DOM
const serverSandboxMode = document.getElementById('server-sandbox-mode') as HTMLSelectElement;
const sandboxDockerFields = document.getElementById('sandbox-docker-fields') as HTMLDivElement;
const serverSandboxDockerImage = document.getElementById('server-sandbox-docker-image') as HTMLInputElement;
const serverSandboxDockerMemory = document.getElementById('server-sandbox-docker-memory') as HTMLInputElement;
const serverSandboxDockerCpu = document.getElementById('server-sandbox-docker-cpu') as HTMLInputElement;
const serverSandboxDockerNetwork = document.getElementById('server-sandbox-docker-network') as HTMLSelectElement;
const serverSandboxBlockedExt = document.getElementById('server-sandbox-blocked-ext') as HTMLInputElement;

// / Docker
serverSandboxMode.addEventListener('change', () => {
    sandboxDockerFields.classList.toggle('hidden', serverSandboxMode.value !== 'docker');
});

// API Key show/hide toggle
serverWebSearchApiKeyToggle.addEventListener('click', () => {
    serverWebSearchApiKey.type = serverWebSearchApiKey.type === 'password' ? 'text' : 'password';
});

// DOM
const agentNameInput = document.getElementById('agent-name-input') as HTMLInputElement | null;
const agentPromptInput = document.getElementById('agent-prompt-input') as HTMLTextAreaElement | null;
const agentSaveBtn = document.getElementById('agent-save-btn') as HTMLButtonElement | null;
const agentSaveHint = document.getElementById('agent-save-hint') as HTMLSpanElement | null;


// MCP Server management DOM
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

/** MCP Server edit state */
let mcpServers: McpServerView[] = [];
let mcpEditingIndex = -1; // -1 means add mode

// Voice related
const micBtn = document.getElementById('mic-btn') as HTMLButtonElement;
const micIconDefault = micBtn.querySelector('.mic-icon-default') as SVGElement;
const micIconRecording = micBtn.querySelector('.mic-icon-recording') as SVGElement;
const recordingIndicator = document.getElementById('recording-indicator') as HTMLDivElement;
const recordingText = document.getElementById('recording-text') as HTMLSpanElement;
const ttsAutoplayToggle = document.getElementById('tts-autoplay-toggle') as HTMLInputElement;
const ttsVoiceSelect = document.getElementById('tts-voice-select') as HTMLSelectElement;

// Voice status
let voiceStatus: { stt: { enabled: boolean; available: boolean }; tts: { enabled: boolean; available: boolean; voice: string; autoPlay: boolean } } | null = null;
let ttsAutoPlay = false;
let voiceModeActive = false;  // whether voice conversation mode is active
// DOM
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

// Debug
const debugPanel = document.getElementById('debug-panel') as HTMLDivElement;
const debugLogContainer = document.getElementById('debug-log-container') as HTMLDivElement;
const debugClearBtn = document.getElementById('debug-clear-btn') as HTMLButtonElement;
const debugCloseBtn = document.getElementById('debug-close-btn') as HTMLButtonElement;
const debugCopyBtn = document.getElementById('debug-copy-btn') as HTMLButtonElement;
const debugResizeHandle = document.getElementById('debug-resize-handle') as HTMLDivElement;

// Scheduler view (center area)
const schedulerBtn = document.getElementById('scheduler-btn') as HTMLDivElement;
const schedulerView = document.getElementById('scheduler-view') as HTMLDivElement;
const schedulerListView = document.getElementById('scheduler-list-view') as HTMLDivElement;
const schedulerTasks = document.getElementById('scheduler-tasks') as HTMLDivElement;
const schedulerTasksWrapper = document.getElementById('scheduler-tasks-wrapper') as HTMLDivElement;
const schedulerRefreshBtn = document.getElementById('scheduler-refresh-btn') as HTMLButtonElement;
const schedulerInlineDetail = document.getElementById('scheduler-inline-detail') as HTMLDivElement;
const schedulerInlineActions = document.getElementById('scheduler-inline-actions') as HTMLDivElement;
const schedulerInlineRuns = document.getElementById('scheduler-inline-runs') as HTMLDivElement;

// Artifacts panel
const artifactsPanel = document.getElementById('artifacts-panel') as HTMLElement;
const artifactsToggle = document.getElementById('artifacts-toggle') as HTMLButtonElement;
const artifactsList = document.getElementById('artifacts-list') as HTMLDivElement;


// File preview modal
const filePreviewModal = document.getElementById('file-preview-modal') as HTMLDivElement;
const filePreviewIcon = document.getElementById('file-preview-icon') as HTMLSpanElement;
const filePreviewName = document.getElementById('file-preview-name') as HTMLSpanElement;
const filePreviewSize = document.getElementById('file-preview-size') as HTMLSpanElement;
const filePreviewBody = document.getElementById('file-preview-body') as HTMLDivElement;
const filePreviewClose = document.getElementById('file-preview-close') as HTMLButtonElement;
const filePreviewOpen = document.getElementById('file-preview-open') as HTMLButtonElement;
const filePreviewReveal = document.getElementById('file-preview-reveal') as HTMLButtonElement;
const filePreviewCopy = document.getElementById('file-preview-copy') as HTMLButtonElement;

// State
let currentSessionId: string | null = null;
let currentAgentId: string | null = null; // Agent support: the currently selected Agent ID
let agentsList: Array<{ id: string; name: string; description?: string; icon?: string; color?: string; default?: boolean; systemPrompt?: string; createdAt: number; updatedAt: number }> = [];
const loadingSessions = new Set<string>(); // sessions currently loading (supports concurrent multi-session)
const chatTargetSessionIds = new Set<string>(); // set of in-progress chat sessions (used to isolate progress events)
const unreadSessionIds = new Set<string>(); // sessions with unread messages (marked when a reply arrives in the background)
const sessionToChatroomMap = new Map<string, number>(); // sessionId -> chatroomId mapping (used to locate unread markers)
let pendingConfirmation: { taskId: string; resolve: (value: boolean) => void } | null = null;
let pendingAttachments: PendingAttachment[] = [];
const sessionDrafts = new Map<string, string>(); // save input-box drafts per session

/** Send/stop button icons */
/** Send icon SVG */
const SEND_ICON_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" /></svg>';
/** Stop icon SVG */
const STOP_ICON_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="3" fill="currentColor" /></svg>';

function updateSendButtonState(): void {
    const currentLoading = currentSessionId ? loadingSessions.has(currentSessionId) : false;
    if (currentLoading) {
        // Task running -> show the stop button
        sendBtn.disabled = false;
        sendBtn.classList.add('is-stop');
        sendBtn.innerHTML = STOP_ICON_SVG;
        sendBtn.title = t('chat.stop');
    } else {
        // Idle -> show the send button
        sendBtn.classList.remove('is-stop');
        sendBtn.innerHTML = SEND_ICON_SVG;
        sendBtn.title = t('chat.send');
        sendBtn.disabled = false;
    }
}

// Gateway
let gatewayClient: GatewayClient | null = null;

// ========================
// Theme toggle
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

// Init theme (restore from localStorage)
const savedTheme = localStorage.getItem('openflux-theme') as 'dark' | 'light' | null;
applyTheme(savedTheme || 'light');

themeToggle.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    applyTheme(current === 'light' ? 'dark' : 'light');
});

// ========================
// First-run setup wizard
// ========================
/** Provider model presets (fallback when the server list is unavailable) */
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
 * Populate the model dropdown
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

/** Get the actual value of a model select + custom input */
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

    // Form elements
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

    // Initially populate the model list
    populateModelSelect(modelSelect, modelCustomInput, providerSelect.value);

    // provider
    providerSelect.addEventListener('change', () => {
        populateModelSelect(modelSelect, modelCustomInput, providerSelect.value);
    });

    // checkbox
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

    // Validate the current step
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

    // Collect config and submit
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
            // Mark skip asynchronously without blocking the UI
            client.request('setup.skip').catch((e: unknown) => {
                console.warn('[SetupWizard] Skip marking failed:', e);
            });
            resolve();
        });

        goToPage(1);
    });
}

// Initialize
async function init(): Promise<void> {
    try {
        setStatus(t('status.connecting'), 'running');

        // Gateway
        const config = await invoke<{ url: string, token?: string }>('get_gateway_config');

        // Gateway sidecar starts asynchronously; first install may take a while to extract, so retry and wait
        const maxRetries = 60;
        let connected = false;
        const startTime = Date.now();
        const loadingTextEl = document.querySelector('.app-loading-text') as HTMLElement | null;
        // Create a persistent GatewayClient instance, preserving bridgeMode state across retries
        gatewayClient = new GatewayClient(config.url, config.token);
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                await gatewayClient.connect();
                (window as any).__gatewayClient = gatewayClient;  // access entry for the coding agents panel
                connected = true;
                break;

            } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                console.warn(`[Init] Gateway connection attempt ${attempt}/${maxRetries} failed: ${errMsg}`);
                if (attempt < maxRetries) {
                    const delay = Math.min(1000 * attempt, 3000);
                    await new Promise(r => setTimeout(r, delay));
                    const elapsed = Math.round((Date.now() - startTime) / 1000);
                    // Show actual error for early attempts (helps diagnose connection issues)
                    const progressMsg = attempt <= 5
                        ? `[${attempt}] ${errMsg.slice(0, 80)}`
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

        // Initialize evolution UI (inject styles + bind events)
        initEvolutionUI(gatewayClient!);

        // Initialize share-conversation-as-image
        initShareImage();

        // Register event listeners after a successful connection (gatewayClient is guaranteed non-null here)
        const gw = gatewayClient!;

        // CDP
        gw.addMessageHandler((msg: any) => {
            if (msg.type === 'browser.status' && msg.payload) {
                updateBrowserStatusIndicator(msg.payload.connected);
            }
        });
        gw.request('browser.status')
            .then((s: any) => updateBrowserStatusIndicator(s?.connected))
            .catch(() => { /* ignore */ });
        // CDP
        setInterval(() => {
            gw.request('browser.status')
                .then((s: any) => updateBrowserStatusIndicator(s?.connected))
                .catch(() => { /* ignore */ });
        }, 15000);

        const handleGatewayConnected = () => {
            setStatus(t('titlebar.status_ready'), 'ready');
            void checkOpenFluxLoginStatus();
            // Sync current language to Gateway on connection
            gw.request('language.update', { language: getLocale() }).catch(() => { });
        };

        gw.onConnectionChange((status) => {
            switch (status) {
                case 'connecting':
                    setStatus(t('status.connecting'), 'running');
                    break;
                case 'connected':
                    handleGatewayConnected();
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
        if (gw.isConnected()) {
            handleGatewayConnected();
        }

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

        // On language switch, re-render JS-generated sections (these read values via t() at render time,
        // without a data-i18n attribute, so applyI18nToDOM cannot update them)
        document.addEventListener('locale-changed', () => {
            try { renderLocalAgents(); } catch { /* ignore */ }
            try { renderMcpServers(); } catch { /* ignore */ }
        });

        // loading
        const loadingOverlay = document.getElementById('app-loading-overlay');
        if (loadingOverlay) {
            loadingOverlay.classList.add('fade-out');
            setTimeout(() => loadingOverlay.classList.add('hidden'), 600);
        }

        // Voice TTS ( Gateway WebSocket
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

        // First-run setup wizard
        if (gw.isSetupRequired()) {
            console.log('[Init] First-time setup needed, showing wizard');
            await showSetupWizard(gw);
        }

        // Listen for Atlas auth expiry -> save the failed-request context + pop up the login modal
        gw.onAuthExpired((message) => {
            console.warn('[Atlas] Auth expired:', message);
            // Save the last user message of the loading session; resend after login
            if (currentSessionId && loadingSessions.has(currentSessionId)) {
                // Find the content of the last user message
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

        // ( + Toast
        gw.onSchedulerEvent((event) => {
            if (schedulerViewActive) {
                loadSchedulerData();
                // If in detail view, also refresh execution records
                if (selectedTaskId) {
                    renderInlineDetail(selectedTaskId);
                    loadTaskRuns(selectedTaskId);
                }
            }
            // Toast
            if (event.type === 'run_complete') {
                showSchedulerToast('ok', event.taskName || 'Task', '执行完成', event.taskId);
            } else if (event.type === 'run_failed') {
                showSchedulerToast('fail', event.taskName || 'Task', event.error || '执行失败', event.taskId);
            }
        });

        // Listen for session-updated events (refresh after a scheduled task finishes)
        gw.onSessionUpdated(async (sessionId: string) => {
            // Refresh the left session list (may have new messages)
            await loadLocalAgents();
            // If currently viewing this session, refresh messages and logs
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

        // (Agent
        gw.onCollaborationResult((event) => {
            console.log('[Collaboration] Result received:', event);
            const statusEmoji = event.status === 'completed' || event.status === 'idle' ? 'ok' : event.status === 'timeout' ? 'timeout' : 'fail';
            const statusText = event.status === 'completed' || event.status === 'idle' ? 'completed' : event.status;
            const durationText = event.duration ? `${(event.duration / 1000).toFixed(1)}s` : '';

            // Toast
            showSchedulerToast(statusEmoji, `Agent: ${event.agentId}`, `${statusText} ${durationText}`.trim());

            // Insert the collaboration-result card into the current chat area
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

        // Router
        initRouterListeners();
        await loadRouterConfig();
        // iLink
        initWeixinListeners();

        await loadLocalAgents();
        setStatus(t('titlebar.status_ready'), 'ready');
    } catch (error) {
        console.error('[Init] Gateway connection failed:', error);
        setStatus(t('status.error'), 'error');
        // loading overlay,UI
        const overlayOnErr = document.getElementById('app-loading-overlay');
        if (overlayOnErr) {
            overlayOnErr.classList.add('fade-out');
            setTimeout(() => overlayOnErr.classList.add('hidden'), 600);
        }
    }
}

// Load the session list
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

// Render the session list
function renderSessions(sessions: Session[]): void {
    if (sessions.length === 0) {
        sessionList.innerHTML = '<div class="empty-state" style="display:flex;align-items:center;justify-content:center;height:100%;color:rgba(255,255,255,0.35);font-size:0.85rem;">' + t('misc.no_sessions') + '</div>';
        return;
    }

    // Router (,,)
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
                 data-cloud-chatroom-id="${session.cloudChatroomId || ''}">'
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

    // Bind click events
    sessionList.querySelectorAll('.session-item:not(.router-session-item)').forEach(item => {
        const el = item as HTMLElement;
        const sessionId = el.dataset.sessionId!;

        // Click the session content area to switch sessions
        el.querySelector('.session-item-content')?.addEventListener('click', () => {
            selectSession(sessionId);
        });

        // Three-dot menu button
        const menuBtn = el.querySelector('.session-menu-btn') as HTMLButtonElement;
        const dropdown = el.querySelector('.session-menu-dropdown') as HTMLDivElement;

        // Show the menu on mouse enter of the three-dot button
        menuBtn.addEventListener('mouseenter', () => {
            sessionList.querySelectorAll('.session-menu-dropdown').forEach(d => d.classList.add('hidden'));
            dropdown.classList.remove('hidden');
        });

        // Close the menu when the mouse leaves the session item
        el.addEventListener('mouseleave', () => {
            dropdown.classList.add('hidden');
        });

        // Delete button
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

    // Router
    const routerEl = sessionList.querySelector('.router-session-item') as HTMLElement | null;
    if (routerEl) {
        routerEl.addEventListener('click', () => {
            switchToRouterSession();
        });
    }

    // Click elsewhere to close the menu
    document.addEventListener('click', () => {
        sessionList.querySelectorAll('.session-menu-dropdown').forEach(d => d.classList.add('hidden'));
    }, { once: true });
}

// Prepend a 'load more' hint at the top of the message list
// (skip if one already exists)
function prependLoadMoreHint(): void {
    // Avoid duplicate insertion
    if (messagesContainer.querySelector('.load-more-hint')) return;
    const hint = document.createElement('div');
    hint.className = 'load-more-hint';
    hint.innerHTML = `<span class="load-more-spinner"></span><span class="load-more-text">滚动加载更多...</span>`;
    messagesContainer.insertBefore(hint, messagesContainer.firstChild);
}

function removeLoadMoreHint(): void {
    messagesContainer.querySelector('.load-more-hint')?.remove();
}

// Load more history messages (scrolling up)
async function loadMoreMessages(): Promise<void> {
    if (!currentSessionId || !gatewayClient) return;
    if (isLoadingMoreMessages) return;
    if (!sessionMsgHasMore.get(currentSessionId)) return;

    isLoadingMoreMessages = true;
    const sessionId = currentSessionId;

    // Record the first message element before loading, to restore scroll position
    const firstMsg = messagesContainer.querySelector('.message') as HTMLElement | null;

    // loading
    const hint = messagesContainer.querySelector('.load-more-hint') as HTMLElement | null;
    if (hint) hint.innerHTML = `<span class="load-more-spinner spinning"></span><span class="load-more-text">加载..</span>`;

    try {
        const currentOffset = sessionMsgOffset.get(sessionId) ?? 0;
        const result = await gatewayClient.getMessages(sessionId, SESSION_PAGE_SIZE, currentOffset);
        const { messages, hasMore } = result;

        if (messages.length > 0) {
            // offset hasMore
            sessionMsgOffset.set(sessionId, currentOffset + messages.length);
            sessionMsgHasMore.set(sessionId, hasMore);

            // (hint, prepend
            removeLoadMoreHint();
            const hydratedMessages = await hydrateMessageAttachments(messages);
            const html = (hydratedMessages as Message[]).map(renderMessage).join('');
            const fragment = document.createElement('div');
            fragment.innerHTML = html;

            // prepend(:)
            const children = Array.from(fragment.children).reverse();
            for (const el of children) {
                if (firstMsg) {
                    messagesContainer.insertBefore(el, firstMsg);
                } else {
                    messagesContainer.prepend(el);
                }
            }
            activateMermaid(messagesContainer);

            // Restore scroll position to the first message before loading
            if (firstMsg) {
                firstMsg.scrollIntoView({ block: 'start', behavior: 'instant' });
            }

            // If there are more, show the hint again
            if (hasMore) {
                prependLoadMoreHint();
            }
        } else {
            removeLoadMoreHint();
        }
    } catch (err) {
        console.error('[loadMoreMessages] Failed:', err);
        removeLoadMoreHint();
    } finally {
        isLoadingMoreMessages = false;
    }
}

// Scroll-up load-more listener (bound to the message list scroll container)
(function setupScrollLoadMore() {
    messagesContainer.addEventListener('scroll', () => {
        // (80px )
        if (messagesContainer.scrollTop <= 80) {
            loadMoreMessages();
        }
    });
})();



async function selectSession(sessionId: string): Promise<void> {
    console.log('[selectSession] Called, sessionId:', sessionId, 'current:', currentSessionId);

    // If the scheduler view is active, switch back to chat first
    if (schedulerViewActive) {
        schedulerViewActive = false;
        messagesContainer.classList.remove('hidden');
        (document.querySelector('.input-area') as HTMLElement).classList.remove('hidden');
        schedulerView.classList.add('hidden');
        schedulerBtn.classList.remove('active');
        selectedTaskId = null;
        stopCountdownTimer();
    }

    // If the settings view is active, switch back to chat first
    closeSettingsView();

    // If it's the current session, only update the sidebar state, don't reload messages
    const isSameSession = sessionId === currentSessionId;
    const previousSessionId = currentSessionId; // save the old session ID, used for progress-state caching

    // Before switching sessions: save the current input draft
    if (!isSameSession && currentSessionId) {
        const draft = messageInput.value.trim();
        if (draft) {
            sessionDrafts.set(currentSessionId, messageInput.value);
        } else {
            sessionDrafts.delete(currentSessionId);
        }
    }

    currentSessionId = sessionId;
    // ?session item ?data
    const activeItem = sessionList.querySelector(`.session-item[data-session-id="${sessionId}"]`) as HTMLElement;
    const cloudId = activeItem?.dataset.cloudChatroomId;
    currentCloudChatroomId = cloudId ? Number(cloudId) : null;
    isRouterSession = false;
    // sessionId chatroomId
    if (currentCloudChatroomId && sessionId) {
        sessionToChatroomMap.set(sessionId, currentCloudChatroomId);
    }
    // Hide the Router bind UI, restore the input area
    document.body.classList.remove('router-active');
    hideRouterBindUI();
    (document.querySelector('.input-area') as HTMLElement).classList.remove('hidden');
    updateInputForCloudSession();

    // Update the sidebar selected state
    sessionList.querySelectorAll('.session-item').forEach(item => {
        item.classList.toggle('active', (item as HTMLElement).dataset.sessionId === sessionId);
    });
    // Clear the unread mark for this session
    unreadSessionIds.delete(sessionId);
    const targetItem = sessionList.querySelector(`.session-item[data-session-id="${sessionId}"]`);
    targetItem?.querySelector('.unread-badge')?.remove();

    // Only load messages and logs when switching to a different session
    if (!isSameSession && gatewayClient) {
        // Restore the input draft of the target session
        messageInput.value = sessionDrafts.get(sessionId) || '';
        autoResize();
        // Update the send button state (the target session may be loading)
        updateSendButtonState();

        // Save the progress state of the leaving session to cache
        if (previousSessionId && currentProgressCard && !isProgressFinished) {
            sessionProgressCache.set(previousSessionId, {
                items: [...progressItems],
                title: currentProgressCard.querySelector('.progress-card-title')?.textContent || t('app.running'),
            });
        }

        // Reset the live progress state
        currentProgressCard = null;
        progressItems = [];
        // If the target session is still loading, keep isProgressFinished = false
        // progress
        isProgressFinished = !loadingSessions.has(sessionId);

        try {
            console.log('[selectSession] Loading messages, logs and artifacts sessionId:', sessionId);

            // Reset lazy-load state
            sessionMsgOffset.set(sessionId, 0);
            sessionMsgHasMore.set(sessionId, false);

            const [msgResult, logs, savedArtifacts] = await Promise.all([
                gatewayClient.getMessages(sessionId, SESSION_PAGE_SIZE, 0),
                gatewayClient.getLogs(sessionId),
                gatewayClient.getArtifacts(sessionId),
            ]);

            const { messages, total, hasMore } = msgResult;
            sessionMsgOffset.set(sessionId, messages.length);
            sessionMsgHasMore.set(sessionId, hasMore);
            console.log('[selectSession] Messages:', messages.length, '/', total, 'hasMore:', hasMore, ', logs:', (logs as LogEntry[]).length);

            // Cloud session fallback: when local messages are empty, load history from the NexusAI cloud
            let finalMessages: unknown[] = messages;
            if ((messages as Message[]).length === 0 && currentCloudChatroomId && gatewayClient) {
                console.log('[selectSession] Local messages empty for cloud session, loading from cloud API...');
                try {
                    const cloudMessages = await gatewayClient.openfluxChatHistory(currentCloudChatroomId);
                    if (cloudMessages && cloudMessages.length > 0) {
                        console.log('[selectSession] Loaded', cloudMessages.length, 'messages from cloud');
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

            // Restore attachment info (image thumbnails load asynchronously)
            const hydratedMessages = await hydrateMessageAttachments(finalMessages);
            renderMessagesWithLogs(hydratedMessages, logs as LogEntry[]);

            // If there are more, show the hint again
            if (hasMore) {
                prependLoadMoreHint();
            }

            // ═══ Restore progress card: rebuild it if the target session has cached progress ═══
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

            // Restore artifacts (no longer persisted, since they're already on the server)
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
    // Focus the input box
    if (!isRouterSession) messageInput.focus();
}

// Mark the session as having unread messages (show a red dot in the sidebar)
function markSessionUnread(sessionId: string): void {
    unreadSessionIds.add(sessionId);
    console.log('[markSessionUnread] sessionId:', sessionId, 'chatroomMap:', sessionToChatroomMap.get(sessionId));

    // Attempt 1: find session-item via data-session-id
    let target = sessionList.querySelector(`.session-item[data-session-id="${sessionId}"]`) as HTMLElement | null;

    // Attempt 2: find cloud-agent-card or session-item via chatroomId
    if (!target) {
        const chatroomId = sessionToChatroomMap.get(sessionId);
        if (chatroomId) {
            target = sessionList.querySelector(
                `.cloud-agent-card[data-cloud-chatroom-id="${chatroomId}"], .session-item[data-cloud-chatroom-id="${chatroomId}"]`
            ) as HTMLElement | null;
        }
    }

    // Attempt 3: find local-agent-card via agentId (sessionId format: user-agent:<agentId>)
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

// Create a session (full version: clear + refresh sidebar, for clicking New)
async function createSession(): Promise<void> {
    if (!gatewayClient) return;
    try {
        const session = await gatewayClient.createSession();
        currentSessionId = session.id;
        currentCloudChatroomId = null;
        // Router
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

// Silently create a session (no clearing, for auto-create when sending)
async function createSessionSilent(): Promise<void> {
    if (!gatewayClient) return;
    try {
        const session = await gatewayClient.createSession();
        currentSessionId = session.id;
        // Refresh the left session list (may have new messages)
        await loadLocalAgents();
    } catch (error) {
        console.error('Failed to create session:', error);
    }
}

// Render the message list (messages only, without progress cards)
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

// Render the message list + insert historical progress cards by tool-log timeline
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

    // If the session is still loading, find the last assistant message timestamp and skip logs after it (those steps' live progress is still streaming)
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

        // Between the current and next message, insert tool-log progress cards for that interval
        const currentTs = msg.createdAt;
        const nextTs = (i + 1 < messages.length) ? messages[i + 1].createdAt : Infinity;

        // If the session is still loading, skip logs after the last assistant message (live progress takes over)
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

    // Bind collapse/expand events for historical progress cards
    messagesContainer.querySelectorAll('.progress-card.historical .progress-card-header').forEach(header => {
        header.addEventListener('click', () => {
            const card = header.closest('.progress-card') as HTMLElement;
            if (!card) return;
            card.classList.toggle('collapsed');
            const toggle = card.querySelector('.progress-card-toggle') as HTMLElement;
            if (toggle) toggle.textContent = card.classList.contains('collapsed') ? '' : ' ';
        });
    });

    activateMermaid(messagesContainer);
    scrollToBottom();
}

function renderRouterWaitingState(): void {
    messagesContainer.innerHTML = `
        <div class="empty-state router-empty-state" style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--color-text-secondary);opacity:0.72;font-size:0.85rem;">
            ${t('cloud.waiting_messages')}
        </div>
    `;
}

function removeMessagePlaceholderStates(): void {
    Array.from(messagesContainer.children).forEach(el => {
        if (
            el.classList.contains('welcome-message') ||
            el.classList.contains('router-empty-state') ||
            el.classList.contains('empty-state')
        ) {
            el.remove();
        }
    });
}

// HTML
function renderHistoricalProgressCard(logs: LogEntry[]): string {
    const items = logs.map(log => {
        const logInfo = getToolLog(log.tool, log.args);
        // Historical log: prefer resultSummary, otherwise infer from success
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
                <span class="progress-card-toggle">/span>
            </div>
            <div class="progress-card-body">${items}</div>
        </div>
    `;
}

// Render a single message
function renderMessage(message: Message): string {
    // Skip internal system messages (context hints for the LLM, not shown to the user)
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

    // Attachment cards (above the text)
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

    // Strip internal system prompts (should not be shown to the user)
    let displayContent = message.content;
    if (message.role === 'assistant') {
        displayContent = displayContent.replace(/\[Tool context\][^\n]*/g, '').trim();
    }

    // assistant messages render as Markdown, user messages stay plain text
    const contentHtml = message.role === 'assistant'
        ? renderMarkdown(displayContent)
        : escapeHtml(displayContent).replace(/\n/g, '<br>');

    // Only show the text area when there is content
    const textHtml = message.content.trim()
        ? `<div class="markdown-body">${contentHtml}</div>`
        : '';

    // Assistant message: add a TTS play button
    const ttsButtonHtml = message.role === 'assistant' && message.content.trim()
        ? `<button class="tts-play-btn" data-msg-id="${message.id}" title="${t('chat.tts_read')}">
               <svg class="tts-icon-play" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
               <svg class="tts-icon-pause hidden" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
               <svg class="tts-icon-loading hidden" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
           </button>`
        : '';

    // Router ()
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

// UI
function addMessage(message: Message): void {
    removeMessagePlaceholderStates();

    const messageHtml = renderMessage(message);
    messagesContainer.insertAdjacentHTML('beforeend', messageHtml);
    scrollToBottom();
}

// Show the loading animation - bouncing dots (reset to dots on each new iteration)
function showTyping(): void {
    const existingIndicator = document.getElementById('typing-indicator');
    if (existingIndicator) {
        // Reset to bouncing dots (clear previous intent text)
        existingIndicator.innerHTML = `
            <div class="typing-dots">
                <span></span><span></span><span></span>
            </div>`;
        // Ensure it sits before the progress card (position may be wrong after switching back)
        ensureTypingPosition(existingIndicator);
        scrollToBottom();
        return;
    }

    // Create container
    const container = document.createElement('div');
    container.className = 'typing-container';
    container.id = 'typing-indicator';

    // Three bouncing dots
    const dots = document.createElement('div');
    dots.className = 'typing-dots';
    dots.innerHTML = '<span></span><span></span><span></span>';
    container.appendChild(dots);

    // If a progress card exists, insert before it; otherwise append to the end
    if (currentProgressCard && currentProgressCard.parentElement === messagesContainer) {
        messagesContainer.insertBefore(container, currentProgressCard);
    } else {
        messagesContainer.appendChild(container);
    }
    scrollToBottom();
}

// typing
function ensureTypingPosition(typingEl: HTMLElement): void {
    if (currentProgressCard && currentProgressCard.parentElement === messagesContainer) {
        // typing
        const typingIdx = Array.from(messagesContainer.children).indexOf(typingEl);
        const cardIdx = Array.from(messagesContainer.children).indexOf(currentProgressCard);
        if (typingIdx > cardIdx) {
            messagesContainer.insertBefore(typingEl, currentProgressCard);
        }
    }
}

// Update the typing indicator: show LLM intent/thinking text
function updateTypingText(text: string): void {
    // Filter out bare tool names (e.g. "process", "filesystem"), show only meaningful descriptions
    const toolNames = ['process', 'filesystem', 'office', 'spawn', 'web_search', 'web_fetch', 'notify_user'];
    const trimmed = text.trim();
    if (!trimmed || toolNames.includes(trimmed) || /^[a-z_,\s]+$/.test(trimmed)) {
        return; // not meaningful text; keep the bouncing dots
    }

    let container = document.getElementById('typing-indicator');
    if (!container) {
        showTyping();
        container = document.getElementById('typing-indicator');
        if (!container) return;
    }

    // Take the first 120 characters to keep it concise
    const displayText = trimmed.length > 120 ? trimmed.slice(0, 120) + '...' : trimmed;

    // Replace content with intent text + bouncing dots
    container.innerHTML = `
        <div class="typing-intent">
            <span class="typing-intent-text">${escapeHtml(displayText)}</span>
            <span class="typing-intent-dots"><span></span><span></span><span></span></span>
        </div>`;
    // Ensure it sits before the progress card
    ensureTypingPosition(container);
    scrollToBottom();
}

// Streaming message management
let streamingMessageEl: HTMLElement | null = null;
let streamingContent = '';
let streamingRenderScheduled = false;
let streamingMsgId = '';  // streaming message ID (used for streaming TTS and final DOM binding)
// DOM
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

// Markdown (:)
function renderStreamingMarkdown(): void {
    if (!streamingMessageEl) return;

    const contentEl = streamingMessageEl.querySelector('.markdown-body');
    if (!contentEl) return;

    // Markdown
    contentEl.innerHTML = renderMarkdown(streamingContent);

    // Insert the streaming cursor at the end of the last text element
    const cursor = document.createElement('span');
    cursor.className = 'streaming-cursor';

    // Find the last inline text container that can hold the cursor
    const candidates = contentEl.querySelectorAll(
        'p, li, h1, h2, h3, h4, h5, h6, td, th, dd, dt, summary'
    );

    if (candidates.length > 0) {
        candidates[candidates.length - 1].appendChild(cursor);
    } else if (contentEl.lastElementChild) {
        // If there's no paragraph-like element (e.g. a pure code block), append to the last child
        contentEl.lastElementChild.appendChild(cursor);
    } else {
        contentEl.appendChild(cursor);
    }

    scrollToBottom();
}

// token
function appendStreamingToken(token: string): void {
    if (!streamingMessageEl) {
        // token,DOM
        streamingMessageEl = createStreamingMessage();
        messagesContainer.appendChild(streamingMessageEl);

        // ID TTS
        streamingMsgId = `streaming-${Date.now()}`;
        if (ttsAutoPlay || voiceModeActive) {
            streamingTtsManager.startStreaming(streamingMsgId);
        }
    }

    streamingContent += token;

    // token TTS( + )
    if (ttsAutoPlay || voiceModeActive) {
        streamingTtsManager.feedToken(token);
    }

    // requestAnimationFrame ,Markdown
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

// Finish the streaming message
function finishStreamingMessage(): string {
    const content = streamingContent;

    // Cancel the pending render
    streamingRenderScheduled = false;

    if (streamingMessageEl) {
        // If there's no content, remove the whole message element
        if (!content.trim()) {
            streamingMessageEl.remove();
            streamingTtsManager.cancel();
        } else {
            // Remove the streaming marker
            streamingMessageEl.classList.remove('streaming');

            // Final Markdown render (without the cursor, for clean output)
            const contentEl = streamingMessageEl.querySelector('.markdown-body');
            if (contentEl) {
                contentEl.innerHTML = renderMarkdown(content);
                // mermaid
                activateMermaid(streamingMessageEl);
            }

            // ID(TTS DOM
            const msgId = streamingMsgId || `streaming-${Date.now()}`;
            streamingMessageEl.setAttribute('data-message-id', msgId);
            const timeEl = streamingMessageEl.querySelector('.message-time');
            if (!timeEl) {
                // If there's no time element, create one
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

            // TTS:(,)
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

// Hide the loading animation
function hideTyping(): void {
    destroyTypingHole();
    const typing = document.getElementById('typing-indicator');
    if (typing) typing.remove();
}

// (DOM )
let lastSendTime = 0;
function sendMessage(): void {
    // Anti-resend: disallow re-triggering within 500ms (prevents double-click, Enter + click firing together, etc.)
    const now = Date.now();
    if (now - lastSendTime < 500) return;
    lastSendTime = now;

    const content = messageInput.value.trim();
    // Only check whether the current session is loading (don't block other sessions)
    const currentLoading = currentSessionId ? loadingSessions.has(currentSessionId) : false;
    if ((!content && pendingAttachments.length === 0) || currentLoading) return;

    // TTS(=
    streamingTtsManager.cancel();

    // Collect an attachment snapshot (clear the preview area right after sending)
    const attachments = pendingAttachments.map(a => ({
        path: a.path,
        name: a.name,
        size: a.size,
        ext: a.ext,
    }));
    // Collect attachment info for the message bubble (with thumbnails, not released yet)
    const messageAttachments: MessageAttachment[] = pendingAttachments.map(a => ({
        name: a.name,
        ext: a.ext,
        size: a.size,
        thumbnailUrl: a.thumbnailUrl, // hand the thumbnail to the message display; no longer released here
    }));
    pendingAttachments = [];
    renderAttachmentPreview();

    // ====== Sync phase: lock the current session UI + insert DOM elements ======
    if (currentSessionId) {
        loadingSessions.add(currentSessionId);
    }
    sendBtn.disabled = true;
    // Switch to the stop button first
    sendBtn.classList.add('is-stop');
    sendBtn.innerHTML = STOP_ICON_SVG;
    sendBtn.title = t('chat.stop');
    sendBtn.disabled = false;
    messageInput.value = '';
    messageInput.style.height = 'auto';
    setStatus(t('chat.thinking'), 'running');

    // 1) The user message appears immediately (attachments shown above the text)
    addMessage({
        id: `msg-${Date.now()}`,
        role: 'user',
        content: content,
        createdAt: Date.now(),
        attachments: messageAttachments.length > 0 ? messageAttachments : undefined,
    });

    // 2) The black-hole typing indicator appears immediately
    showTyping();

    // ====== :======
    setTimeout(() => sendMessageAsync(content, attachments), 0);
}

// ( UI
async function sendMessageAsync(
    content: string,
    attachments?: Array<{ path: string; name: string; size: number; ext: string }>
): Promise<void> {
    // ID()
    const targetSessionId = currentSessionId;

    try {
        // Make sure there is a session
        if (!targetSessionId) {
            await createSessionSilent();
        }

        const sendSessionId = targetSessionId || currentSessionId;

        // Record the target session of this chat (to isolate progress events)
        if (sendSessionId) {
            chatTargetSessionIds.add(sendSessionId);
        }

        // Only reset the progress card when the user is still in this session
        if (currentSessionId === sendSessionId) {
            currentProgressCard = null;
            progressItems = [];
        }

        if (!gatewayClient) throw new Error('Gateway 未连接');

        // chat ( cloud source agentId
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

        // Record the target session of this chat (to isolate progress events)
        // Reset UI (hideTyping/finishProgressCard/finishStreamingMessage)
        // (reset by handleGatewayProgress on completion)

        if (sendSessionId) {
            chatTargetSessionIds.delete(sendSessionId);
            loadingSessions.delete(sendSessionId);
        }

        // Refresh the left session list (may have new messages)
        await loadLocalAgents();
        updateSendButtonState();
        // Only set status to ready when no other session is loading
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
                content: `抱歉,发生了错误: ${error instanceof Error ? error.message : t('common.unknown_error')}`,
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
        // Update the send button state (the target session may be loading)
        updateSendButtonState();
    }
}

// Clear messages
function clearMessages(): void {
    // Reset the live progress state
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

// Set status
function setStatus(text: string, type: 'ready' | 'running' | 'error'): void {
    const dot = statusIndicator.querySelector('.dot');
    const textEl = statusIndicator.querySelector('.text');

    if (dot) dot.className = `dot ${type}`;
    if (textEl) textEl.textContent = text;
}

// Scroll to bottom
function scrollToBottom(): void {
    // Use requestAnimationFrame to scroll after the DOM has updated
    requestAnimationFrame(() => {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
        // Additionally scroll the progress card into view
        const progressCard = messagesContainer.querySelector('.progress-card:last-of-type');
        if (progressCard) {
            progressCard.scrollIntoView({ behavior: 'smooth', block: 'end' });
        }
    });
}

// Format time
// Auto-adjust the input box height
function autoResize(): void {
    messageInput.style.height = 'auto';
    messageInput.style.height = Math.min(messageInput.scrollHeight, 200) + 'px';
}

// Confirmation modal
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
    // TODO: confirmation feature not yet implemented in thin-client mode
    resolve(approved);

    pendingConfirmation = null;
    confirmModal.classList.add('hidden');
}

// Event binding
sendBtn.addEventListener('click', () => {
    if (sendBtn.classList.contains('is-stop')) {
        // UI
        if (currentSessionId) {
            loadingSessions.delete(currentSessionId);
        }
        hideTyping();
        finishProgressCard();
        updateSendButtonState();
        setStatus(t('titlebar.status_ready'), 'ready');
        // Send the stop signal to the backend
        if (currentSessionId && gatewayClient) {
            gatewayClient.stopTask(currentSessionId);
            console.log('[UI] Task stop requested:', currentSessionId);
        }
        return;
    }
    sendMessage();
});
// newSessionBtn now creates an Agent (handler registered in the Agent management area)

// Keyboard: Ctrl+Enter sends, Enter/Shift+Enter for newline

messageInput.addEventListener('input', autoResize);

// Click an attachment in the message area -> open the file preview modal (event delegation)
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
// File drag-and-drop handling
// ========================

// 1) Chromium native drag only provides a URL
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

// 2) Use Tauri v2 native drag events (can get absolute file paths)
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { convertFileSrc } from '@tauri-apps/api/core';
import { stat, readFile } from '@tauri-apps/plugin-fs';

const workspace = document.getElementById('workspace') as HTMLElement;

// HTML5 dragenter/dragleave UI
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

// Tauri native drag: get the absolute file path
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

            // Avoid adding the same file path twice
            if (pendingAttachments.some(a => a.path === filePath)) continue;

            // Get file size
            let fileSize = 0;
            try {
                const fileStat = await stat(filePath);
                fileSize = fileStat.size;
            } catch (e) {
                console.warn(`[DragDrop] Get file size failed: ${filePath}`, e);
            }

            // Generate image thumbnail: read the file to create a Blob URL (more reliable than the asset protocol)
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

// ========================
// Clipboard screenshot paste
// ========================
/**
 * Read a Blob as a base64 string (without the data: prefix)
 */
// Listen for paste events on the input box (screenshot/image paste)
messageInput.addEventListener('paste', async (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const imageItems: DataTransferItem[] = [];
    for (const item of items) {
        if (item.type.startsWith('image/')) {
            imageItems.push(item);
        }
    }

    if (imageItems.length === 0) return;

    // ( HTML
    e.preventDefault();

    for (const item of imageItems) {
        const blob = item.getAsFile();
        if (!blob) continue;

        // Infer the extension
        const mimeToExt: Record<string, string> = {
            'image/png': 'png',
            'image/jpeg': 'jpg',
            'image/gif': 'gif',
            'image/webp': 'webp',
            'image/bmp': 'bmp',
        };
        const ext = mimeToExt[item.type] ?? 'png';

        try {
            // base64
            const base64 = await blobToBase64(blob);
            const filePath = await invoke<string>('save_temp_image', {
                dataBase64: base64,
                ext,
            });

            // Avoid adding the same file path twice
            if (pendingAttachments.some(a => a.path === filePath)) continue;

            // URL(Blob
            const thumbnailUrl = URL.createObjectURL(blob);
            const fileName = filePath.split(/[\\/]/).pop() || `paste.${ext}`;

            pendingAttachments.push({
                path: filePath,
                name: fileName,
                size: blob.size,
                ext: `.${ext}`,
                type: 'image',
                thumbnailUrl,
            });

            console.log(`[Paste] Image saved to temp: ${filePath}`);
        } catch (err) {
            console.error('[Paste] Failed to save clipboard image:', err);
        }
    }

    if (imageItems.length > 0) {
        renderAttachmentPreview();
        messageInput.focus();
    }
});

/** Render the attachment preview area */
function renderAttachmentPreview(): void {
    if (pendingAttachments.length === 0) {
        attachmentPreview.classList.add('hidden');
        attachmentPreview.innerHTML = '';
        return;
    }

    attachmentPreview.classList.remove('hidden');
    attachmentPreview.innerHTML = pendingAttachments.map((a, idx) => {
        // Image: show thumbnail; other types: show a text icon
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

    // Bind delete button events
    attachmentPreview.querySelectorAll('.attachment-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt((btn as HTMLElement).dataset.idx || '0', 10);
            // URL
            const removed = pendingAttachments[idx];
            if (removed?.thumbnailUrl) URL.revokeObjectURL(removed.thumbnailUrl);
            pendingAttachments.splice(idx, 1);
            renderAttachmentPreview();
        });
    });
}

// Window controls
btnMinimize.addEventListener('click', () => invoke('window_minimize'));
btnMaximize.addEventListener('click', () => invoke('window_maximize'));
btnClose.addEventListener('click', () => invoke('window_close'));

// Collapse/expand the sidebar
sidebarToggle.addEventListener('click', () => {
    sidebar.classList.toggle('collapsed');
    if (sidebar.classList.contains('collapsed')) {
        sidebar.style.width = '';
    } else {
        const saved = localStorage.getItem('sidebar-width');
        if (saved) sidebar.style.width = saved + 'px';
    }
});

// Collapse/expand the artifacts panel
artifactsToggle.addEventListener('click', () => {
    artifactsPanel.classList.toggle('collapsed');
    if (artifactsPanel.classList.contains('collapsed')) {
        artifactsPanel.style.width = '';
    } else {
        const saved = localStorage.getItem('artifacts-panel-width');
        if (saved) artifactsPanel.style.width = saved + 'px';
    }
});

// ========== Panel drag-to-resize ==========
(function initPanelResize() {
    const sidebarHandle = document.getElementById('sidebar-resize-handle')!;
    const artifactsHandle = document.getElementById('artifacts-resize-handle')!;

    const SIDEBAR_MIN = 180, SIDEBAR_MAX = 480;
    const ARTIFACTS_MIN = 200, ARTIFACTS_MAX = 600;

    // Restore the persisted width
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

// Launch debug browser button
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

// CDP
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

// Login button inside the Agent list (opens the login modal)
const agentListLoginBtn = document.getElementById('agent-list-login-btn') as HTMLButtonElement;
if (agentListLoginBtn) {
    agentListLoginBtn.addEventListener('click', () => {
        openfluxLoginModal.classList.remove('hidden');
        openfluxModalUsername.focus();
    });
}

// ========================
// Settings modal & Debug panel
// ========================

// ---- ----
type WorkingMode = 'standalone' | 'router' | 'managed';
const VALID_MODES: WorkingMode[] = ['standalone', 'router', 'managed'];
const storedMode = localStorage.getItem('openflux-working-mode') as WorkingMode | null;
let currentWorkingMode: WorkingMode = storedMode && VALID_MODES.includes(storedMode) ? storedMode : 'standalone';
let pendingManagedSwitch = false; // wait until after login to switch to managed mode
let pendingManagedFallbackMode: WorkingMode | null = null;
let pendingAuthRetry: { content: string; sessionId: string | null; attachments?: Array<{ path: string; name: string; size: number; ext: string }> } | null = null; // auto-retry after a successful login following a 401

const workingModeCards = document.querySelectorAll('.working-mode-card') as NodeListOf<HTMLDivElement>;

/** Add/remove a grayed-out overlay on an element */
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

function updateModeScopedSettingsVisibility(mode: WorkingMode): void {
    const showRouterTab = mode === 'router';
    const nexusAccountSection = document.getElementById('nexusai-account-section');
    const routerTab = settingsView.querySelector('.settings-tab[data-tab="connections"]') as HTMLButtonElement | null;
    const routerContent = document.getElementById('settings-tab-connections');
    const routerConfigSection = document.getElementById('router-config-section');
    const routerManagedConfig = document.getElementById('router-managed-config');
    if (nexusAccountSection) {
        nexusAccountSection.style.display = mode === 'managed' ? '' : 'none';
    }
    if (routerTab) {
        routerTab.style.display = showRouterTab ? '' : 'none';
    }
    if (routerConfigSection) {
        routerConfigSection.style.display = showRouterTab ? '' : 'none';
    }
    if (routerManagedConfig) {
        routerManagedConfig.style.display = showRouterTab ? '' : 'none';
    }
    if (!showRouterTab && routerContent?.classList.contains('active')) {
        const generalTab = settingsView.querySelector('.settings-tab[data-tab="general"]') as HTMLButtonElement | null;
        const generalContent = document.getElementById('settings-tab-general');
        settingsTabs.forEach(t => t.classList.remove('active'));
        settingsTabContents.forEach(tc => tc.classList.remove('active'));
        generalTab?.classList.add('active');
        generalContent?.classList.add('active');
    }
}

/** Update the show/grayed-out state of settings sections based on the working mode */
function applyWorkingMode(mode: WorkingMode): void {
    const previousMode = currentWorkingMode;
    currentWorkingMode = mode;
    localStorage.setItem('openflux-working-mode', mode);

    // Update the card selected state
    workingModeCards.forEach(card => {
        card.classList.toggle('active', card.dataset.mode === mode);
    });


    const routerManaged = t('mode.managed_by_router');
    const nexusManaged = t('mode.managed_by_nexus');
    const isRouterOrManaged = mode === 'router' || mode === 'managed';

    // --- Model tab: orchestration/execution model + provider keys (masked in Router mode) ---
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

    // --- Tools tab: Web search API key ---
    const webSearchGroup = document.getElementById('server-web-search-provider')?.closest('.settings-model-group') as HTMLElement | null;
    setManagedOverlay(webSearchGroup, isRouterOrManaged,
        mode === 'router' ? routerManaged : nexusManaged);

    // --- Model tab: Agent standalone model config (shown only in standalone mode) ---
    const agentModelSection = document.getElementById('agent-model-section');
    if (agentModelSection) {
        agentModelSection.style.display = mode === 'standalone' ? '' : 'none';
    }

    // --- Router Tab:Router (Router App/---
    updateModeScopedSettingsVisibility(mode);

    // --- "":, ---
    const llmSourceToggle = document.getElementById('llm-source-toggle') as HTMLInputElement | null;
    if (llmSourceToggle) {
        if (mode === 'router') {
            // Team mode: forced on, the user cannot turn it off
            llmSourceToggle.checked = true;
            llmSourceToggle.disabled = true;
        } else {
            // Standalone/managed mode: turn off the managed-config switch and lock it
            llmSourceToggle.checked = false;
            llmSourceToggle.disabled = true;
        }
    }

    // --- Gateway llmSource sync ---
    if (typeof gatewayClient !== 'undefined' && gatewayClient) {
        if (mode === 'managed') {
            queueManagedLoginPrompt(previousMode);
            // NexusAI managed mode -> atlas_managed
            gatewayClient.setLlmSource('atlas_managed').then((res: any) => {
                if (res.error) {
                    console.warn('[Atlas] Switch failed:', res.error);
                    promptAtlasLoginIfManaged(previousMode, true);
                } else {
                    currentLlmSource = 'atlas_managed';
                }
            }).catch((err: any) => {
                console.error('[Atlas] setLlmSource error:', err);
                promptAtlasLoginIfManaged(previousMode, true);
            });
        } else if (mode === 'router' && (managedLlmAvailable)) {
            // + Router managed
            gatewayClient.setLlmSource('managed').then(() => {
                currentLlmSource = 'managed';
            }).catch(() => {});
        } else if (currentLlmSource !== 'local') {
            // local
            gatewayClient.setLlmSource('local').then(() => {
                currentLlmSource = 'local';
            }).catch(() => {});
        }
    }
}

// Update the card selected state
workingModeCards.forEach(card => {
    card.addEventListener('click', () => {
        const mode = card.dataset.mode as WorkingMode;
        if (mode && mode !== currentWorkingMode) {
            applyWorkingMode(mode);
        }
    });
});

// Initialize and apply the current mode
applyWorkingMode(currentWorkingMode);

// Coding Agents

const codingAgentsList = document.getElementById('coding-agents-list') as HTMLDivElement | null;
const codingAgentsRefreshBtn = document.getElementById('coding-agents-refresh-btn') as HTMLButtonElement | null;

/** Driver metadata (icon, description, install/auth info) */
const DRIVER_META: Record<string, { icon: string; desc: string; installUrl: string; authCmd?: string; authDesc?: string }> = {
    agy: {
        icon: '',
        desc: 'Antigravity CLI - AI coding assistant by Google DeepMind',
        installUrl: 'https://antigravity.dev',
        authCmd: `& "$env:LOCALAPPDATA\\agy\\bin\\agy.exe"`,
        authDesc: 'Run agy and complete OAuth login',
    },
    claude: {
        icon: '',
        desc: 'Claude Code - AI coding assistant by Anthropic',
        installUrl: 'https://docs.anthropic.com/en/docs/claude-code',
        authCmd: 'claude',
        authDesc: 'Run claude to authenticate with Anthropic account',
    },
    codex: {
        icon: '',
        desc: 'OpenAI Codex CLI - set OPENAI_API_KEY to enable',
        installUrl: 'https://github.com/openai/codex',
        authCmd: undefined,
        authDesc: 'Set OPENAI_API_KEY in system environment',
    },
    cursor: {
        icon: '',
        desc: 'Cursor - AI-native code editor with Agent mode',
        installUrl: 'https://cursor.sh',
        authCmd: undefined,
        authDesc: 'Open Cursor app and sign in to use',
    },
};

/** Coding Agents */
async function renderCodingAgents(): Promise<void> {
    if (!codingAgentsList) return;

    codingAgentsList.innerHTML = '<div class="coding-agent-loading">加载..</div>';

    try {
        const ws = (window as any).__gatewayClient as import('./gateway-client').GatewayClient | undefined;
        if (!ws) {
            codingAgentsList.innerHTML = '<div class="coding-agent-loading" style="color:var(--color-text-secondary);">Gateway 未连接,请稍候重/div>';
            return;
        }

        const drivers = await ws.listCodingAgentDrivers();

        if (drivers.length === 0) {
            codingAgentsList.innerHTML = '<div class="coding-agent-loading" style="color:var(--color-text-secondary);">无可用驱/div>';
            return;
        }

        codingAgentsList.innerHTML = '';
        for (const d of drivers) {
            const meta = DRIVER_META[d.id] || { icon: '🔌', desc: d.id, installUrl: '', authDesc: '' };

            // Status indicator class
            const statusClass = !d.installed ? 'plugin-status-missing' : !d.authenticated ? 'plugin-status-warn' : 'plugin-status-ok';
            const statusText = !d.installed ? 'Not Installed' : !d.authenticated ? 'Not Authenticated' : 'Ready';
            const statusIcon = !d.installed ? 'x' : !d.authenticated ? '!' : 'ok';

            // Action button HTML
            let actionHtml = '';
            if (!d.installed) {
                actionHtml = `<a href="${meta.installUrl}" target="_blank" class="plugin-action-btn plugin-action-install">安装 ${d.displayName}</a>`;
            } else if (!d.authenticated) {
                actionHtml = meta.authCmd
                    ? `<button class="plugin-action-btn plugin-action-auth" onclick="navigator.clipboard.writeText('${escapeHtml(meta.authCmd || '')}').then(()=>showToast('已复制认证命))">复制认证命令</button>`
                    : '';
            }

            const binaryInfo = (d as any).binaryPath
                ? `<div class="plugin-binary-path" title="${escapeHtml((d as any).binaryPath)}">${escapeHtml((d as any).binaryPath)}</div>`
                : '';

            const resumeBadge = d.supportsResume
                ? '<span class="plugin-feature-badge">Session 恢复</span>'
                : '';

            const card = document.createElement('div');
            card.className = 'plugin-card';
            card.innerHTML = `
                <div class="plugin-card-header">
                    <div class="plugin-card-icon">${meta.icon}</div>
                    <div class="plugin-card-info">
                        <div class="plugin-card-name">${escapeHtml(d.displayName)}</div>
                        <div class="plugin-card-id">id: ${escapeHtml(d.id)} ${resumeBadge}</div>
                    </div>
                    <div class="plugin-status-badge ${statusClass}">
                        <span class="plugin-status-icon">${statusIcon}</span>
                        ${statusText}
                    </div>
                </div>
                <div class="plugin-card-desc">${escapeHtml(meta.desc)}</div>
                ${binaryInfo}
                ${!d.installed || !d.authenticated ? `<div class="plugin-card-hint">${escapeHtml(meta.authDesc || '')}</div>` : ''}
                ${actionHtml ? `<div class="plugin-card-actions">${actionHtml}</div>` : ''}
            `;
            codingAgentsList.appendChild(card);
        }
    } catch (e) {
        codingAgentsList.innerHTML = `<div class="coding-agent-loading" style="color:var(--color-error,#ef4444);">加载失败: ${String(e)}</div>`;
    }
}

// Re-render coding agents on click
codingAgentsRefreshBtn?.addEventListener('click', () => renderCodingAgents());

// connections Tab (connections tab
document.querySelectorAll('.settings-tab').forEach(btn => {
    btn.addEventListener('click', () => {
        if ((btn as HTMLElement).dataset.tab === 'connections') {
            setTimeout(() => renderCodingAgents(), 100);
        }
    });
});

// /Coding Agents

// ---- Settings tab switching ----
settingsTabs.forEach(tab => {
    tab.addEventListener('click', () => {
        const tabName = tab.dataset.tab;
        settingsTabs.forEach(t => t.classList.remove('active'));
        settingsTabContents.forEach(tc => tc.classList.remove('active'));
        tab.classList.add('active');
        const content = settingsView.querySelector(`.settings-tab-content[data-tab="${tabName}"]`);
        content?.classList.add('active');

        // tab
        if ((tabName === 'models' || tabName === 'tools') && gatewayClient) {
            loadServerConfig();
            if (tabName === 'models') loadAgentConfig();
        }
        // tab
        if (tabName === 'memory' && gatewayClient) {
            loadMemoryData();
        }

    });
});

// ---- Provider names ----

/** Provider display names */
const PROVIDER_NAMES: Record<string, string> = {
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    minimax: 'MiniMax',
    deepseek: 'DeepSeek',
    zhipu: '智谱 (Zhipu)',
    moonshot: 'Moonshot (Kimi)',
    google: 'Google',
    ollama: 'Ollama',
    custom: 'Custom',
};

/** Provider key input cache (key -> input element) */
const providerKeyInputs = new Map<string, HTMLInputElement>();

/**
 * Load the server config */
async function loadServerConfig(): Promise<void> {
    if (!gatewayClient) return;
    try {
        const cfg = await gatewayClient.getServerConfig();

        // (fallback
        if (cfg.presetModels && Object.keys(cfg.presetModels).length > 0) {
            providerModels = cfg.presetModels;
        }

        // Populate the model selection
        serverOrchProvider.value = cfg.llm.orchestration.provider;
        populateModelSelect(serverOrchModel, serverOrchModelCustom, cfg.llm.orchestration.provider, cfg.llm.orchestration.model);
        serverExecProvider.value = cfg.llm.execution.provider;
        populateModelSelect(serverExecModel, serverExecModelCustom, cfg.llm.execution.provider, cfg.llm.execution.model);

        // Sync the model list when the provider changes
        serverOrchProvider.onchange = () => {
            populateModelSelect(serverOrchModel, serverOrchModelCustom, serverOrchProvider.value);
        };
        serverExecProvider.onchange = () => {
            populateModelSelect(serverExecModel, serverExecModelCustom, serverExecProvider.value);
        };

        // Embedding
        if (cfg.llm.embedding) {
            if (serverEmbeddingProvider) serverEmbeddingProvider.value = cfg.llm.embedding.provider;
            if (serverEmbeddingModel) serverEmbeddingModel.value = cfg.llm.embedding.model;
        } else {
            // Default display (the server value takes precedence)
            if (serverEmbeddingProvider) serverEmbeddingProvider.value = 'openai';
            if (serverEmbeddingModel) serverEmbeddingModel.value = 'text-embedding-3-small';
        }

        // Gateway ( Gateway section,)
        // serverGatewayMode.textContent = ...;
        // serverGatewayPort.textContent = ...;

        // Web
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

        // Render the provider key list
        renderProviderKeys(cfg.providers);

        // MCP Server
        mcpServers = cfg.mcp?.servers || [];
        renderMcpServers();

        // Populate the sandbox config
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
        // Record the sandbox mode at load time, for comparison when saving
        lastSavedSandboxMode = loadedSandboxMode;
    } catch (err) {
        console.error('[Settings] Load server config failed', err);
    }
}

/**
 * Render the provider API-key input list */
function renderProviderKeys(providers: Record<string, { apiKey?: string; baseUrl?: string }>): void {
    serverProviderKeysContainer.innerHTML = '';
    providerKeyInputs.clear();

    // (google/custom/ollama key )
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
 * Render the MCP Server list
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

        // Edit button
        card.querySelector('.edit')?.addEventListener('click', () => openMcpForm(i));
        // Delete button
        card.querySelector('.delete')?.addEventListener('click', () => {
            mcpServers.splice(i, 1);
            renderMcpServers();
        });

        mcpServersList.appendChild(card);
    }
}

/**
 * Handle client MCP Servers: connect to the local MCP and register its tools with the Gateway
 */
async function handleClientMcpServers(): Promise<void> {
    if (!gatewayClient) return;

    // 1.
    try {
        await gatewayClient!.request<any>('mcp.disconnect');
        gatewayClient.unregisterClientMcpTools();
    } catch { /* ignore */ }

    // 2. Filter client MCP
    const clientMcps = mcpServers.filter(s => s.location === 'client' && s.enabled !== false);
    if (clientMcps.length === 0) return;

    // 3. Connect to the local MCP Server via IPC
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

        // mcpConnect
        const tools = connectResult.tools;
        if (!tools?.length) {
            console.warn('[MCP] Client MCP has no available tools');
            return;
        }

        // Gateway
        gatewayClient.registerClientMcpTools(tools);
        console.log(`[MCP] Registered ${tools.length} client MCP tools to Gateway`);
    } catch (err) {
        console.error('[MCP] Client MCP processing failed:', err);
    }
}

/** Open the MCP form (add or edit) */
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

/** Toggle visibility of stdio/sse fields */
function updateMcpFormFields(): void {
    if (mcpFormTransport.value === 'stdio') {
        mcpFormStdioFields.classList.remove('hidden');
        mcpFormSseFields.classList.add('hidden');
    } else {
        mcpFormStdioFields.classList.add('hidden');
        mcpFormSseFields.classList.remove('hidden');
    }
}

/** Close the MCP form */
function closeMcpForm(): void {
    mcpForm.classList.add('hidden');
    mcpAddBtn.style.display = '';
    mcpEditingIndex = -1;
}

// MCP
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
 * Save the server config */
// Sandbox mode at last load; used to detect changes and prompt to save
let lastSavedSandboxMode = 'local';
let lastSavedMcpSnapshot = '';

serverSaveBtn.addEventListener('click', async () => {
    if (!gatewayClient) return;

    serverSaveBtn.disabled = true;
    serverSaveHint.textContent = t('settings.saving');
    serverSaveHint.className = 'settings-save-hint';

    // Listen for backend service restart progress
    const progressHandler = (msg: any) => {
        if (msg.type === 'config.progress' && msg.payload?.step) {
            serverSaveHint.textContent = msg.payload.step;
        }
    };
    gatewayClient.addMessageHandler(progressHandler);

    try {
        const updates: Record<string, unknown> = {};

        // Collect provider key updates (only non-empty inputs)
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

        // Collect model config updates
        updates.orchestration = {
            provider: serverOrchProvider.value,
            model: getModelSelectValue(serverOrchModel, serverOrchModelCustom),
        };
        updates.execution = {
            provider: serverExecProvider.value,
            model: getModelSelectValue(serverExecModel, serverExecModelCustom),
        };

        // Embedding
        updates.embedding = {
            provider: serverEmbeddingProvider?.value || 'openai',
            model: serverEmbeddingModel?.value.trim() || 'text-embedding-3-small',
        };

        // Web
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

        // MCP Server
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

        // Collect sandbox config
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

            // MCP:MCP ( MCP
            const currentMcpSnapshot = JSON.stringify(updates.mcp);
            if (currentMcpSnapshot !== lastSavedMcpSnapshot) {
                lastSavedMcpSnapshot = currentMcpSnapshot;
                await Promise.race([
                    handleClientMcpServers(),
                    new Promise(r => setTimeout(r, 10000)),
                ]);
            }

            // Sandbox mode change only prompts (Gateway hot-reloads via handleConfigUpdate, no restart needed)
            const newSandboxMode = serverSandboxMode.value;
            if (newSandboxMode !== lastSavedSandboxMode) {
                lastSavedSandboxMode = newSandboxMode;
                serverSaveHint.textContent = `' + t('settings.sandbox_switched').replace('{0}', newSandboxMode) + '`;
                serverSaveHint.className = 'settings-save-hint success';
            }

            // Reload to refresh the state
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

// Tools tab save button (reuses the server-save logic)
document.getElementById('tools-save-btn')?.addEventListener('click', () => {
    serverSaveBtn.click();
});

// ---- Global role/persona settings ----

/**
 * Load the global role/persona, skills, and Agent model
 */
async function loadAgentConfig(): Promise<void> {
    if (!gatewayClient) return;
    // Agent Tab
    if (!agentNameInput && !agentPromptInput) return;
    try {
        const cfg = await gatewayClient.getServerConfig();
        if (agentNameInput) agentNameInput.value = cfg.agents?.globalAgentName || '';
        if (agentPromptInput) agentPromptInput.value = cfg.agents?.globalSystemPrompt || '';
        if (agentSaveHint) {
            agentSaveHint.textContent = '';
            agentSaveHint.className = 'settings-save-hint';
        }

        // Load skills
        skillsData = cfg.agents?.skills || [];
        renderSkills();

        // Agent
        agentListData = (cfg.agents?.list || []).map(a => ({
            id: a.id,
            name: a.name,
            description: a.description,
            provider: a.model?.provider || '',
            model: a.model?.model || '',
        }));
        // placeholder
        globalOrchModel = {
            provider: cfg.llm?.orchestration?.provider || '',
            model: cfg.llm?.orchestration?.model || '',
        };
        renderAgentModelCards();
    } catch (err) {
        console.error('[Settings] Load global agent settings failed:', err);
    }
}

// ---- Agent model management logic ----

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

    // Header
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

    // Model selection
    const fields = document.createElement('div');
    fields.className = 'agent-model-card-fields';

    const providerSelect = document.createElement('select');
    // Default option
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

// ---- Skill management logic ----

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

    // Header
    const header = document.createElement('div');
    header.className = 'skill-card-header';

    const toggle = document.createElement('span');
    toggle.className = 'skill-card-toggle';
    toggle.textContent = '';

    const title = document.createElement('span');
    title.className = 'skill-card-title';
    title.textContent = skill.title || t('agent.unnamed_skill');

    const actions = document.createElement('div');
    actions.className = 'skill-card-actions';

    // Switch
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

    // Delete
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'skill-delete-btn';
    deleteBtn.textContent = '';
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

    // Collapse/expand
    header.addEventListener('click', () => {
        card.classList.toggle('expanded');
    });

    // Edit area
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
    // Auto-expand the newly added card
    const lastCard = skillsListEl.lastElementChild as HTMLElement;
    if (lastCard) {
        lastCard.classList.add('expanded');
        const titleInput = lastCard.querySelector('.skill-title-input') as HTMLInputElement;
        if (titleInput) titleInput.focus();
    }
});

/**
 * Save the global role/persona, skills, and Agent model
 */
agentSaveBtn?.addEventListener('click', async () => {
    if (!gatewayClient) return;

    agentSaveBtn.disabled = true;
    agentSaveHint.textContent = t('agent.saving');
    agentSaveHint.className = 'settings-save-hint';

    try {
        // Filter out skills with empty titles
        const validSkills = skillsData.filter(s => s.title.trim());

        // agent model
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
            skillsData = validSkills; // sync the filtered result
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

// ---- () ----
let settingsViewActive = false;

function toggleSettingsView(): void {
    settingsViewActive = !settingsViewActive;

    if (settingsViewActive) {
        // If the scheduler view is active, switch back to chat first
        if (schedulerViewActive) {
            schedulerViewActive = false;
            schedulerView.classList.add('hidden');
            schedulerBtn.classList.remove('active');
            stopCountdownTimer();
        }
        // Hide chat messages and input area, show the settings view
        messagesContainer.classList.add('hidden');
        (document.querySelector('.input-area') as HTMLElement).classList.add('hidden');
        hideRouterBindUI(); // hide the Router bind area (fixed positioning is unaffected by the parent container)
        settingsView.classList.remove('hidden');
        settingsBtn.classList.add('active');
        // Load client settings
        if (gatewayClient) {
            gatewayClient.getSettings().then(settings => {
                outputPathInput.value = settings.outputPath || '';
                outputPathInput.title = settings.outputPath || '';
            }).catch(() => {
                outputPathInput.value = t('common.load_failed');
            });
        }
        // If the current tab is model or tools, also load the config
        const activeTab = settingsView.querySelector('.settings-tab.active') as HTMLButtonElement;
        if ((activeTab?.dataset.tab === 'models' || activeTab?.dataset.tab === 'tools') && gatewayClient) {
            loadServerConfig();
        }
    } else {
        // Restore chat
        messagesContainer.classList.remove('hidden');
        (document.querySelector('.input-area') as HTMLElement).classList.remove('hidden');
        settingsView.classList.add('hidden');
        settingsBtn.classList.remove('active');
        // Restore the Router bind UI (if the current session is a Router session and not yet bound)
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

/** Open the settings view and jump to the given tab */
function showSettings(tab: string): void {
    if (!settingsViewActive) toggleSettingsView();
    if (tab === 'connections' && currentWorkingMode !== 'router') {
        tab = 'general';
    }
    const tabBtn = settingsView.querySelector(`.settings-tab[data-tab="${tab}"]`) as HTMLButtonElement | null;
    if (tabBtn) tabBtn.click();
}

/** Excel uninstall confirmation modal */
async function showExcelUninstallConfirm(): Promise<boolean> {
    return showConfirmDialog(
        t('excel.uninstall_confirm') ||
        'Confirm uninstall Excel plugin? This will remove OpenFlux add-in from Excel.'
    );
}

// Open/close settings
settingsBtn.addEventListener('click', () => {
    toggleSettingsView();
});

// Browse output directory
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

// Reset output directory to default
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


// Debug
let debugUnsubscribe: (() => void) | null = null;

debugModeToggle.addEventListener('change', () => {
    const enabled = debugModeToggle.checked;

    if (enabled) {
        // Show the debug panel (flex layout auto-squeezes main-layout)
        debugPanel.classList.remove('hidden');

        // debug
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
        // debug
        debugPanel.classList.add('hidden');

        // Load client settings
        if (gatewayClient) {
            gatewayClient.unsubscribeDebugLog();
        }
        if (debugUnsubscribe) {
            debugUnsubscribe();
            debugUnsubscribe = null;
        }
    }
});

// Clear logs
debugClearBtn.addEventListener('click', () => {
    debugLogContainer.innerHTML = '';
});

// Copy all logs
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
        // Briefly turn the button into a checkmark for feedback
        const originalTitle = debugCopyBtn.title;
        debugCopyBtn.title = `${t('common.copied')} ${lines.length} ${t('debug.log_lines')}`;
        debugCopyBtn.style.color = 'var(--color-success)';
        setTimeout(() => {
            debugCopyBtn.title = originalTitle;
            debugCopyBtn.style.color = '';
        }, 1500);
    });
});

// debug ()
debugCloseBtn.addEventListener('click', () => {
    debugModeToggle.checked = false;
    debugModeToggle.dispatchEvent(new Event('change'));
});

// debug
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
        // Drag up = clientY decreases = height increases
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
 * Append a log entry to the debug panel
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

    // Limit the maximum number of entries
    while (debugLogContainer.children.length > MAX_DEBUG_LOG_ENTRIES) {
        debugLogContainer.removeChild(debugLogContainer.firstChild!);
    }

    // Auto-scroll to bottom
    debugLogContainer.scrollTop = debugLogContainer.scrollHeight;
}

/**
 * Play the task-completion chime (deep-space sci-fi style, 0.8s)
 * Synthesized with the Web Audio API: low-frequency sweep + warm resonance + soft overtones
 */
function playTaskCompleteSound(): void {
    try {
        const ctx = new AudioContext();
        const now = ctx.currentTime;
        const master = ctx.createGain();
        master.gain.setValueAtTime(0.2, now);
        master.connect(ctx.destination);

        // (1): low-frequency sweep tone - 880Hz softly gliding down to 440Hz
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

        // (2): warm resonance - 330Hz sine wave + slight vibrato
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

        // (3): soft overtone - 660Hz gentle accent
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

        // AudioContext
        setTimeout(() => ctx.close().catch(() => { }), 1500);
    } catch (e) {
        console.warn('[Sound] Notification sound playback failed', e);
    }
}

// Gateway
function handleGatewayProgress(event: GatewayProgressEvent): void {
    // Render progress scoped to its session

    // 1. If the event carries a sessionId (Router broadcast or attached by the server), only render to the matching session
    // Use the resolved sessionId (resolvedSessionId)
    // the sessionId equals currentSessionId, or
    // the current session is an active chat target (chatTargetSessionIds.has(currentSessionId))
    // 1. If the event carries a sessionId (Router broadcast or attached by the server), only render to the matching session
    if (event.sessionId && event.sessionId !== currentSessionId) {
        // sessionId
        // (chatTargetSessionIds )
        const isCloudSessionCorrected = currentSessionId
            && chatTargetSessionIds.has(currentSessionId)
            && currentCloudChatroomId;

        if (!isCloudSessionCorrected) {
            // complete event for a non-current session: update button state + notification sound
            if (event.type === 'complete') {
                if (event.sessionId) {
                    chatTargetSessionIds.delete(event.sessionId);
                    loadingSessions.delete(event.sessionId);
                    // Clean up cache: the task has finished
                    sessionProgressCache.delete(event.sessionId);
                }
                updateSendButtonState();
                // Mark this session as having unread messages
                markSessionUnread(event.sessionId);
                if (!document.hasFocus()) {
                    playTaskCompleteSound();
                    invoke('window_flash_frame', { flash: true });
                }
            } else {
                // tool_result / thinking : sessionProgressCache
                // tool_result / thinking event for a non-current session: append to sessionProgressCache
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
        // else: cloud sessionId correction case, keep rendering to the current window
        console.log('[handleGatewayProgress] Cloud sessionId corrected, rendering to current session');
    }

    // 2. If the current session itself isn't in an active chat and the event has no sessionId, skip
    // (sessionId progress )
    if (!event.sessionId && chatTargetSessionIds.size > 0 && currentSessionId && !chatTargetSessionIds.has(currentSessionId)) {
        return;
    }

    // ═══ Final safety guard: skip rendering if the event has a sessionId not belonging to the current session ═══
    // ═══ Final safety guard: skip rendering if the event has a sessionId not belonging to the current session ═══
    if (event.sessionId && event.sessionId !== currentSessionId && !currentCloudChatroomId) {
        console.log('[handleGatewayProgress] Safety guard: skipping render for non-current session', event.sessionId, 'current:', currentSessionId);
        return;
    }

    console.log('[Gateway Progress Event]', event);

    // ProgressEvent
    const progressEvent = event as ProgressEvent;

    if (progressEvent.type === 'thinking' && progressEvent.thinking) {
        updateTypingText(progressEvent.thinking);
        addProgressToChat('·', progressEvent.thinking, true);
    } else if (progressEvent.type === 'tool_start' && event.description) {
        // Description attached when the LLM returns a tool-call request -> update the typing indicator + progress card title
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
        // iteration
        showTyping();
    } else if (event.type === 'token' && event.token) {
        hideTyping();
        appendStreamingToken(event.token);
    } else if (progressEvent.type === 'complete') {
        // Chat completed - immediate visual feedback
        console.log('[Gateway Progress Event] Chat completed');
        hideTyping();
        finishProgressCard();
        finishStreamingMessage();
        if (event.sessionId) {
            chatTargetSessionIds.delete(event.sessionId);
            loadingSessions.delete(event.sessionId);
        }
        // event.sessionId differs from currentSessionId -> clean up the current session
        if (currentSessionId) {
            chatTargetSessionIds.delete(currentSessionId);
            loadingSessions.delete(currentSessionId);
        }
        updateSendButtonState();
        if (loadingSessions.size === 0) {
            setStatus(t('titlebar.status_ready'), 'ready');
        }
        // When the window is not focused: play a sound + flash the taskbar
        if (!document.hasFocus()) {
            playTaskCompleteSound();
            invoke('window_flash_frame', { flash: true });
        }
        // (artifacts
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

// ========== ==========

interface Artifact {
    type: 'file' | 'code' | 'output';
    path?: string;
    filename?: string;
    content?: string;
    language?: string;
    size?: number;
    timestamp: number;
}

// Artifact categories
type ArtifactCategory = 'all' | 'document' | 'code' | 'image' | 'data' | 'media' | 'other';

const CATEGORY_EXT_MAP: Record<string, ArtifactCategory> = {
    // Documents
    md: 'document', txt: 'document', pdf: 'document',
    doc: 'document', docx: 'document',
    ppt: 'document', pptx: 'document',
    // Code
    py: 'code', js: 'code', ts: 'code', jsx: 'code', tsx: 'code',
    html: 'code', css: 'code', scss: 'code', less: 'code',
    json: 'code', yaml: 'code', yml: 'code', toml: 'code',
    java: 'code', c: 'code', cpp: 'code', h: 'code', hpp: 'code', cs: 'code',
    go: 'code', rs: 'code', rb: 'code', php: 'code', swift: 'code', kt: 'code',
    sh: 'code', bash: 'code', bat: 'code', ps1: 'code', cmd: 'code',
    sql: 'code', graphql: 'code', proto: 'code',
    xml: 'code', ini: 'code', conf: 'code', cfg: 'code',
    env: 'code', dockerfile: 'code', makefile: 'code',
    // Images
    png: 'image', jpg: 'image', jpeg: 'image', gif: 'image',
    svg: 'image', webp: 'image', bmp: 'image', ico: 'image',
    // Data
    csv: 'data', xls: 'data', xlsx: 'data',
    // Media
    mp4: 'media', mp3: 'media', wav: 'media', avi: 'media', mkv: 'media',
    mov: 'media', flac: 'media', ogg: 'media',
};

const CATEGORY_ICONS: Record<ArtifactCategory, string> = {
    all: '📁', document: '📝', code: '💻', image: '🖼', data: '📊', media: '🎵', other: '📦',
};

function getArtifactCategory(artifact: Artifact): ArtifactCategory {
    if (artifact.type === 'code') return 'code';
    if (artifact.type === 'output') return 'other';
    // file type classify by extension
    const fname = artifact.filename || artifact.path?.split(/[/\\]/).pop() || '';
    const ext = fname.split('.').pop()?.toLowerCase() || '';
    return CATEGORY_EXT_MAP[ext] || 'other';
}

// Currently selected category filter
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

// Date grouping: convert timestamp to a date key
function getArtifactDateKey(ts: number): string {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// key
function getDateLabel(dateKey: string): string {
    const now = new Date();
    const todayKey = getArtifactDateKey(now.getTime());
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayKey = getArtifactDateKey(yesterday.getTime());
    if (dateKey === todayKey) return t('date.today');
    if (dateKey === yesterdayKey) return t('date.yesterday');
    // Locale-aware short date: e.g. "3/5" (en) or "3 (zh)
    return new Date(`${dateKey}T00:00:00`).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
}

// Ensure the date group container exists
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
    // Insert in descending date order
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

// key
const TODAY_SUB_GROUPS = [
    { key: '1h', labelKey: 'artifact.sub_1h', maxAgeMs: 1 * 60 * 60 * 1000 },
    { key: '3h', labelKey: 'artifact.sub_3h', maxAgeMs: 3 * 60 * 60 * 1000 },
    { key: 'earlier', labelKey: 'artifact.sub_earlier', maxAgeMs: Infinity },
] as const;

// Determine which sub-group of today a timestamp belongs to
function getTodaySubGroupKey(ts: number): string {
    const age = Date.now() - ts;
    for (const sg of TODAY_SUB_GROUPS) {
        if (age <= sg.maxAgeMs) return sg.key;
    }
    return 'earlier';
}

// ( 1h 3h earlier
function ensureTodaySubGroup(group: HTMLDivElement, subKey: string): HTMLDivElement {
    let sub = group.querySelector(`.artifact-sub-group[data-sub="${subKey}"]`) as HTMLDivElement | null;
    if (sub) return sub;
    sub = document.createElement('div');
    sub.className = 'artifact-sub-group';
    sub.dataset.sub = subKey;
    const sg = TODAY_SUB_GROUPS.find(s => s.key === subKey)!;
    const header = document.createElement('div');
    header.className = 'artifact-sub-header';
    header.textContent = t(sg.labelKey);
    sub.appendChild(header);
    // (1h )
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

// Artifact list
let artifacts: Artifact[] = [];

// Clear artifacts
function clearArtifacts(): void {
    artifacts = [];
    (document.getElementById('artifacts-list') as HTMLDivElement).innerHTML = '';

    (document.getElementById('artifacts-panel') as HTMLElement).classList.add('collapsed');
    addedArtifactPaths.clear();
    activeArtifactFilter = 'all';
    artifactFilterTabs.classList.remove('visible');
    artifactFilterTabs.innerHTML = '';
}

// persist=true ,false
async function addArtifact(artifact: Artifact, persist = true): Promise<void> {
    // For file-type artifacts, first verify the file exists
    if (artifact.type === 'file' && artifact.path && persist) {
        try {
            const exists = await invoke<boolean>('file_exists', { filePath: artifact.path });
            if (!exists) {
                console.warn('[Artifact] File not found, skipping:', artifact.path);
                addedArtifactPaths.delete(normalizePath(artifact.path)); // release the path, allowing it to be re-checked later
                return;
            }
        } catch (err) {
            console.warn('[Artifact] File existence check failed', err);
        }
    }

    artifacts.push(artifact);

    (document.getElementById('artifacts-panel') as HTMLElement).classList.remove('collapsed');

    // Persist to the server asynchronously
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

        // Bind button events
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

    // Double-click to open file preview
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
        // Today: insert by sub-group (within 1 hour / within 3 hours / earlier)
        const subKey = getTodaySubGroupKey(ts);
        const subGroup = ensureTodaySubGroup(group, subKey);
        // Insert within the sub-group in descending time order
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
        // Not today: insert within the group in descending time order
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

// ========== File preview ==========

// ========== File preview ==========
const TEXT_EXTS = new Set([
    'txt', 'md', 'json', 'yaml', 'yml', 'xml', 'csv', 'log', 'ini', 'conf', 'cfg',
    'py', 'js', 'ts', 'jsx', 'tsx', 'html', 'css', 'scss', 'less', 'sass',
    'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'swift', 'kt',
    'sh', 'bash', 'bat', 'ps1', 'cmd',
    'sql', 'graphql', 'proto',
    'toml', 'env', 'gitignore', 'dockerfile', 'makefile',
]);

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico']);

let currentPreviewPath = '';
let previewPanelCounter = 0;
let previewPanelZIndex = 200;
async function openFilePreview(filePath: string): Promise<void> {
    currentPreviewPath = filePath;
    const filename = filePath.split(/[/\\]/).pop() || 'unknown';

    // Tauri WebviewWindow
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

// closeFilePreview
function closeFilePreview(): void {
    filePreviewModal.classList.add('hidden');
    filePreviewBody.innerHTML = '';
    currentPreviewPath = '';
}

// Keep old event binding for compatibility
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


// ========== (=========

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
 /** LLM raw description text (tool_start events only) */
    llmDescription?: string;
}

// Live progress state of the current session (only for an ongoing conversation)
let currentProgressCard: HTMLElement | null = null;
let progressItems: Array<{ icon: string; text: string; isThinking: boolean; detail?: string }> = [];
let isProgressFinished = true; // marks whether the current card is finished

// Cache progress state by sessionId, fixing progress cards disappearing after switching sessions
interface SessionProgressState {
    items: Array<{ icon: string; text: string; isThinking: boolean; detail?: string }>;
    title: string;
}
const sessionProgressCache = new Map<string, SessionProgressState>();
// Get or create the run-process card
function getProgressCard(): HTMLElement {
    // If the current card is finished or missing, create a new one
    if (isProgressFinished || !currentProgressCard || !currentProgressCard.parentElement) {
        // Create a new collapsible card
        const card = document.createElement('div');
        card.className = 'progress-card'; // use only progress-card to avoid inheriting message styles
        card.innerHTML = `
            <div class="progress-card-header">
                <span class="progress-card-icon">
                    <svg class="spinning-loader" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 12a9 9 0 1 1-6.219-8.56" stroke-linecap="round"/>
                    </svg>
                </span>
                <span class="progress-card-title">${t('app.running')}</span>
                <span class="progress-card-count">0</span>
                <span class="progress-card-toggle">/span>
            </div>
            <div class="progress-card-body"></div>
        `;

        // Click to collapse/expand
        const header = card.querySelector('.progress-card-header') as HTMLElement;
        header.addEventListener('click', () => {
            card.classList.toggle('collapsed');
            const toggle = card.querySelector('.progress-card-toggle') as HTMLElement;
            toggle.textContent = card.classList.contains('collapsed') ? '' : '';
        });

        // Insert position: if there's an active streaming message, the progress card should come before it
        // (during Agent token/tool streaming)
        if (streamingMessageEl && streamingMessageEl.parentElement === messagesContainer) {
            messagesContainer.insertBefore(card, streamingMessageEl);
        } else {
            messagesContainer.appendChild(card);
        }
        scrollToBottom();
        currentProgressCard = card;
        progressItems = [];
        isProgressFinished = false; // mark as in progress
    }

    return currentProgressCard;
}

// (LLM
function updateProgressCardTitle(description: string): void {
    const card = getProgressCard();
    const titleEl = card.querySelector('.progress-card-title') as HTMLElement;
    // Take the first line, trim extra spaces
    const firstLine = description.split('\n')[0].trim();
    titleEl.textContent = firstLine.slice(0, 100) + (firstLine.length > 100 ? '...' : '');
}

// Add a run-process item in the chat window (inside the collapsible card)
function addProgressToChat(icon: string, text: string, isThinking: boolean = false, detail?: string): void {
    const card = getProgressCard();
    const body = card.querySelector('.progress-card-body') as HTMLElement;
    const countEl = card.querySelector('.progress-card-count') as HTMLElement;

    // Add item
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

    // Subtitle effect: smoothly scroll body to the bottom; old entries shift up naturally and fade under the top mask
    body.scrollTo({ top: body.scrollHeight, behavior: 'smooth' });

    // Update the title to the latest operation (tool_start description takes precedence; refined here during actual tool execution)
    const titleEl = card.querySelector('.progress-card-title') as HTMLElement;
    titleEl.textContent = isThinking ? t('app.thinking') : text.slice(0, 80) + (text.length > 80 ? '...' : '');

    scrollToBottom();
}

// Finish the current run-process card
function finishProgressCard(): void {
    if (currentProgressCard) {
        const titleEl = currentProgressCard.querySelector('.progress-card-title') as HTMLElement;
        const iconEl = currentProgressCard.querySelector('.progress-card-icon') as HTMLElement;
        titleEl.textContent = `${t('app.completed')} (${progressItems.length} ${t('app.steps')})`;
        iconEl.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`;
        // Collapse the finished card
        currentProgressCard.classList.add('collapsed');
        const toggle = currentProgressCard.querySelector('.progress-card-toggle') as HTMLElement;
        if (toggle) toggle.textContent = '';
    }
    // Mark as finished; a new card will be created next time
    isProgressFinished = true;
    currentProgressCard = null;
    // Clean up the progress cache of the current session
    if (currentSessionId) sessionProgressCache.delete(currentSessionId);
}

// (LLM )
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

// Switch the progress card icon to a black hole (during tool execution)
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

// Clear logs (legacy-compatible)
function clearLogs(): void {
    clearArtifacts();
}

// Render the log list (legacy-compatible, no longer shown in the right sidebar)
function renderLogs(_logs: Array<{ tool: string; action?: string; args?: Record<string, unknown> }>): void {
    // Logs are no longer shown in the right sidebar; left empty here
}



// Check whether it's an artifact (file writes, files generated by code execution, etc.)
// Check whether it's an artifact (file writes, files generated by code execution, etc.)
const addedArtifactPaths = new Set<string>();


/** Check whether a path has been added (compared after normalization) */
function isPathAdded(p: string): boolean {
    return addedArtifactPaths.has(normalizePath(p));
}

/** Mark a path as added */
function markPathAdded(p: string): void {
    addedArtifactPaths.add(normalizePath(p));
}

function isArtifactTool(tool: string, args?: Record<string, unknown>, result?: unknown): Artifact | Artifact[] | null {
    const action = (args?.action as string) || '';
    const collected: Artifact[] = [];

    // Files produced by filesystem.write: prefer result.data.path (already a resolved absolute path)
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

    // Files produced by filesystem.copy: prefer result.data.destination (already a resolved absolute path)
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

    // filesystem.info (,)

    // process.run / opencode.run (file-snapshot
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

        // Fallback detection: recognize common file-output path patterns from stdout
        if (collected.length === 0 && data) {
            const stdout = (data.stdout as string) || '';
            // Windows ?Unix
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

        // Fallback detection: recognize common file-output path patterns from stdout
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

    // office (excel/word/pdf/csv) create/write
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

// Note: progress events are now handled via the Gateway onProgress callback, see handleGatewayProgress

// ========== (=========

let schedulerViewActive = false;
let selectedTaskId: string | null = null;
let cachedTasks: ScheduledTaskView[] = [];
let countdownTimerId: ReturnType<typeof setInterval> | null = null;
const schedulerToastContainer = document.getElementById('scheduler-toast-container') as HTMLDivElement;

/** Show a scheduler toast notification */
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
    // Click to jump to the scheduler detail
    if (taskId) {
        toast.addEventListener('click', () => {
            toast.remove();
            if (!schedulerViewActive) toggleSchedulerView();
            setTimeout(() => showSchedulerDetail(taskId), 100);
        });
    }
    schedulerToastContainer.appendChild(toast);
    // Auto-dismiss
    setTimeout(() => {
        toast.classList.add('leaving');
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

/**
 * Plugin-operation-specific Toast (more prominent than schedulerToast, supports multi-line step descriptions)
 * type: 'success' | 'error' | 'info'
 */
function showPluginToast(
    type: 'success' | 'error' | 'info',
    title: string,
    steps?: string[]
): void {
    const iconMap = { success: '', error: '', info: 'ℹ️' };
    const colorMap = {
        success: 'linear-gradient(135deg,#16a34a,#15803d)',
        error:   'linear-gradient(135deg,#dc2626,#b91c1c)',
        info:    'linear-gradient(135deg,#2563eb,#1d4ed8)',
    };
    const el = document.createElement('div');
    el.style.cssText = [
        'position:fixed', 'bottom:24px', 'right:24px', 'z-index:99999',
        'max-width:340px', 'width:max-content',
        'background:' + colorMap[type],
        'color:#fff', 'border-radius:12px',
        'padding:14px 18px', 'box-shadow:0 8px 32px rgba(0,0,0,.35)',
        'font-family:inherit', 'font-size:13px', 'line-height:1.5',
        'cursor:pointer', 'user-select:none',
        'animation:plugin-toast-in .25s cubic-bezier(.34,1.56,.64,1)',
        'transition:opacity .3s,transform .3s',
    ].join(';');

    const stepsHtml = steps && steps.length
        ? `<ol style="margin:8px 0 0 16px;padding:0;opacity:.9">${steps.map(s =>
            `<li style="margin:2px 0">${escapeHtml(s)}</li>`).join('')}</ol>`
        : '';

    el.innerHTML = `
        <div style="display:flex;align-items:flex-start;gap:10px">
            <span style="font-size:20px;line-height:1;flex-shrink:0">${iconMap[type]}</span>
            <div style="flex:1">
                <div style="font-weight:600;font-size:14px">${escapeHtml(title)}</div>
                ${stepsHtml}
            </div>
            <span style="opacity:.7;font-size:16px;line-height:1;flex-shrink:0">×</span>
        </div>
    `;

    // Click to close
    el.addEventListener('click', () => {
        el.style.opacity = '0';
        el.style.transform = 'translateX(20px)';
        setTimeout(() => el.remove(), 300);
    });

    // Inject keyframe animation (only once)
    if (!document.getElementById('plugin-toast-style')) {
        const s = document.createElement('style');
        s.id = 'plugin-toast-style';
        s.textContent = `@keyframes plugin-toast-in {
            from { opacity:0; transform:translateX(30px) scale(.95); }
            to   { opacity:1; transform:translateX(0)    scale(1); }
        }`;
        document.head.appendChild(s);
    }

    document.body.appendChild(el);

    // Success/info auto-close (8s); errors stay until manually closed
    if (type !== 'error') {
        setTimeout(() => {
            el.style.opacity = '0';
            el.style.transform = 'translateX(20px)';
            setTimeout(() => el.remove(), 300);
        }, 8000);
    }
}

// Toggle the scheduler view (show/hide in the center area)
function toggleSchedulerView(): void {
    schedulerViewActive = !schedulerViewActive;

    if (schedulerViewActive) {
        // If the settings view is active, switch back to chat first
        closeSettingsView();
        // Hide chat messages and input area, show the settings view
        messagesContainer.classList.add('hidden');
        (document.querySelector('.input-area') as HTMLElement).classList.add('hidden');
        hideRouterBindUI(); // hide the Router bind area (fixed positioning is unaffected by the parent container)
        schedulerView.classList.remove('hidden');
        schedulerBtn.classList.add('active');
        // Back to the list view
        showSchedulerList();
        loadSchedulerData();
        startCountdownTimer();
    } else {
        // Restore chat
        messagesContainer.classList.remove('hidden');
        (document.querySelector('.input-area') as HTMLElement).classList.remove('hidden');
        schedulerView.classList.add('hidden');
        schedulerBtn.classList.remove('active');
        selectedTaskId = null;
        stopCountdownTimer();
        // Restore the Router bind UI (if the current session is a Router session and not yet bound)
        if (isRouterSession) showRouterBindUI();
    }
}

// Start the countdown refresh (updates every second)
function startCountdownTimer(): void {
    stopCountdownTimer();
    countdownTimerId = setInterval(updateCountdowns, 1000);
}

// Stop the countdown refresh
function stopCountdownTimer(): void {
    if (countdownTimerId) {
        clearInterval(countdownTimerId);
        countdownTimerId = null;
    }
}

// Update all countdown elements every second
function updateCountdowns(): void {
    const now = Date.now();
    document.querySelectorAll('[data-countdown-ts]').forEach(el => {
        const ts = parseInt((el as HTMLElement).dataset.countdownTs || '0', 10);
        (el as HTMLElement).textContent = formatCountdown(ts, now);
    });
}

// Back to the task list (restore all cards, hide the inline detail)
function showSchedulerList(): void {
    selectedTaskId = null;
    // Restore all cards to visible
    schedulerTasks.querySelectorAll('.scheduler-task-card').forEach(card => {
        (card as HTMLElement).classList.remove('hidden');
    });
    // Hide the inline detail
    schedulerInlineDetail.classList.add('hidden');
    // Exit detail mode
    schedulerTasksWrapper.classList.remove('detail-mode');
    // header
    schedulerRefreshBtn.classList.remove('hidden');
    const backBtn = document.getElementById('scheduler-header-back-btn');
    if (backBtn) backBtn.remove();
}

// Select a task: hide other cards, show execution records below the selected card
function showSchedulerDetail(taskId: string): void {
    selectedTaskId = taskId;

    // Restore all cards to visible
    schedulerTasks.querySelectorAll('.scheduler-task-card').forEach(card => {
        const el = card as HTMLElement;
        if (el.dataset.taskId === taskId) {
            el.classList.remove('hidden');
        } else {
            el.classList.add('hidden');
        }
    });

    // Enter detail mode
    schedulerTasksWrapper.classList.add('detail-mode');
    // Show the inline detail
    schedulerInlineDetail.classList.remove('hidden');
    renderInlineDetail(taskId);
    loadTaskRuns(taskId);

    // header: hide the refresh button, show the back button
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
        // header (h3
        const header = schedulerListView.querySelector('.scheduler-view-header');
        if (header) header.insertBefore(backBtn, header.firstChild);
    }
}

// Load scheduler data (task list)
async function loadSchedulerData(): Promise<void> {
    if (!gatewayClient) return;
    try {
        cachedTasks = await gatewayClient.getSchedulerTasks();
        renderSchedulerTasks(cachedTasks);
    } catch (error) {
        console.error('[Scheduler] Load data failed:', error);
    }
}

// Load execution records for the given task
async function loadTaskRuns(taskId: string): Promise<void> {
    if (!gatewayClient) return;
    try {
        const runs = await gatewayClient.getSchedulerRuns(taskId, 50);
        renderInlineRuns(runs);
    } catch (error) {
        console.error('[Scheduler] Load run history failed:', error);
    }
}

// Render the task list (large cards in the center area)
function renderSchedulerTasks(tasks: ScheduledTaskView[]): void {
    if (tasks.length === 0) {
        schedulerTasks.innerHTML = `
            <div class="scheduler-empty">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3">
                    <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                </svg>
                <p>暂无定时任务</p>
                <span>通过对话创建,例如:"每天9点帮我检查邮</span>
            </div>`;
        return;
    }

    const now = Date.now();

    schedulerTasks.innerHTML = tasks.map(task => {
        const triggerText = formatTriggerDisplay(task.trigger);
        const statusClass = task.status;
        const statusLabel = {
            active: 'active', paused: 'paused', completed: 'done', error: 'error'
        }[task.status] || task.status;

        // Next run: live countdown
        let nextRunHtml: string;
        if (task.nextRunAt) {
            const countdown = formatCountdown(task.nextRunAt, now);
            nextRunHtml = `<span class="scheduler-task-countdown" data-countdown-ts="${task.nextRunAt}">${countdown}</span>`;
        } else {
            nextRunHtml = '<span>-</span>';
        }

        // Last execution result icon
        const lastResultIcon = task.runCount > 0
            ? (task.failCount > 0 && task.failCount === task.runCount ? '' : '')
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

    // Restore all cards to visible
    schedulerTasks.querySelectorAll('.scheduler-task-card').forEach(card => {
        card.addEventListener('click', () => {
            const taskId = (card as HTMLElement).dataset.taskId;
            if (taskId) showSchedulerDetail(taskId);
        });
    });
}

// Render the inline detail (action buttons + execution records, below the selected card)
function renderInlineDetail(taskId: string): void {
    const task = cachedTasks.find(t => t.id === taskId);
    if (!task) return;

    // Action buttons
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

    // Bind action buttons
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
                // Refresh
                await loadSchedulerData();
                renderInlineDetail(taskId);
                await loadTaskRuns(taskId);
            } catch (error) {
                console.error(`[Scheduler] ${action} failed:`, error);
            }
        });
    });
}

// ( output
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

        // output ( 80
        const outputSummary = run.output
            ? escapeHtml(run.output.replace(/\n/g, ' ').slice(0, 80)) + (run.output.length > 80 ? '' : '')
            : '';
        const hasOutput = !!(run.output || run.error);

        // output (markdown
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

    // Bind expand/collapse
    schedulerInlineRuns.querySelectorAll('.scheduler-run-row[data-expandable]').forEach(row => {
        row.addEventListener('click', (e) => {
            // Avoid triggering collapse when clicking inner links etc.
            if ((e.target as HTMLElement).closest('a, code, pre')) return;
            row.classList.toggle('expanded');
        });
    });
}


// Scheduler event binding
schedulerBtn.addEventListener('click', toggleSchedulerView);
schedulerRefreshBtn.addEventListener('click', loadSchedulerData);

// Switch back to chat view when clicking New Conversation
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
    // If the settings view is active, switch back to chat first
    closeSettingsView();
});

// Input keyboard events: Ctrl+Enter sends, Enter/Shift+Enter for newline
messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.ctrlKey) {
        e.preventDefault();
        sendMessage();
    }
    // Enter without Ctrl -> allow default newline behavior (no send)
});

// Auto-adjust the input box height
messageInput.addEventListener('input', () => {
    // scrollHeight
    messageInput.style.height = 'auto';
    // Set the new height, max 200px
    const maxHeight = 200;
    const newHeight = Math.min(messageInput.scrollHeight, maxHeight);
    messageInput.style.height = newHeight + 'px';
    // If it exceeds the max height, show a scrollbar
    messageInput.style.overflowY = messageInput.scrollHeight > maxHeight ? 'auto' : 'hidden';
});

// ========================
// Voice features
// ========================

/** Voice features */
async function initVoice(): Promise<void> {
    try {
        voiceStatus = await gatewayClient!.request<any>('voice.get-status');
        ttsAutoPlay = voiceStatus.tts.autoPlay;

        // UI
        ttsAutoplayToggle.checked = ttsAutoPlay;
        if (voiceStatus.tts.voice) {
            ttsVoiceSelect.value = voiceStatus.tts.voice;
        }

        // If STT is unavailable, disable the microphone and voice-conversation buttons
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

/** Recording state change callback */
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

/** Playback state change callback */
player.setStateCallback((state: PlaybackState, messageId?: string) => {
    if (!messageId) return;

    // Update the play-button state of the corresponding message
    const btn = document.querySelector(`.tts-play-btn[data-msg-id="${messageId}"]`) as HTMLElement;
    if (!btn) return;

    const iconPlay = btn.querySelector('.tts-icon-play') as SVGElement;
    const iconPause = btn.querySelector('.tts-icon-pause') as SVGElement;
    const iconLoading = btn.querySelector('.tts-icon-loading') as SVGElement;

    // Hide all first
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

/** Microphone button click */
micBtn.addEventListener('click', async () => {
    if (micBtn.classList.contains('disabled')) {
        // Microphone disabled (STT/LLM unavailable)
        setStatus('LLM unavailable', 'error');
        setTimeout(() => setStatus(t('titlebar.status_ready'), 'ready'), 3000);
        return;
    }

    const currentState = recorder.getState();

    if (currentState === 'idle') {
        // Cancel the in-progress streaming TTS (a new user message = interrupt)
        streamingTtsManager.cancel();
        try {
            await recorder.start();
        } catch (error) {
            console.error('[Voice] Recording start failed:', error);
            setStatus(t('voice.mic_failed'), 'error');
            setTimeout(() => setStatus(t('titlebar.status_ready'), 'ready'), 3000);
        }
    } else if (currentState === 'recording') {
        // 1. Disconnect the old connection first and remove registered tools
        try {
            const audioData = await recorder.stop();
            setStatus('识别..', 'running');
            const result = await gatewayClient!.request<any>('voice.transcribe', { audioData: audioData });
            if (result.error) {
                console.error('[Voice] Recognition failed:', result.error);
                setStatus(t('voice.recognition_failed'), 'error');
                setTimeout(() => setStatus(t('titlebar.status_ready'), 'ready'), 3000);
            } else if (result.text) {
                // Fill the recognized text into the input box (append mode)
                const currentText = messageInput.value;
                messageInput.value = currentText ? `${currentText} ${result.text}` : result.text;
                // input
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

/** TTS play button click (event delegation) */
messagesContainer.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest('.tts-play-btn') as HTMLElement;
    if (!btn) return;

    const messageId = btn.getAttribute('data-msg-id');
    if (!messageId) return;

    // If the same message is currently playing, toggle pause/play
    if (player.getCurrentMessageId() === messageId) {
        player.togglePause();
        return;
    }

    // TTS
    streamingTtsManager.cancel();

    // Find the message content
    const msgEl = btn.closest('.message') as HTMLElement;
    if (!msgEl) return;

    const contentEl = msgEl.querySelector('.markdown-body');
    if (!contentEl) return;

    // Get plain text
    const text = contentEl.textContent || '';
    if (!text.trim()) return;

    // TTS
    ttsManager.speak(text, messageId);
});

/** TTS settings */
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

// Restore voice settings from local storage
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
// Voice conversation mode
// ========================

/** Voice conversation mode */
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
            // Start voice barge-in detection while thinking/replying
            bargeInDetector.start();
            break;
        case 'speaking':
            voiceStatusText.textContent = t('voice.replying');
            voiceBtnMic.classList.remove('hidden');
            voiceBtnStop.classList.add('hidden');
            ambientSound.stop();
            // Keep voice barge-in detection while speaking
            if (!bargeInDetector.isActive()) bargeInDetector.start();
            break;
    }
}

/**
 * Interrupt the current reply (generic barge-in logic): cancel TTS + ambient sound, then automatically start the next recording round */
function interruptVoiceResponse(): void {
    const state = voiceOverlay.getAttribute('data-state');
    if (state !== 'speaking' && state !== 'answering') return;

    streamingTtsManager.cancel();
    bargeInDetector.stop();
    ambientSound.stopImmediate();
    setVoiceOverlayState('idle');

    // Auto-dismiss
    setTimeout(() => {
        if (voiceModeActive) startVoiceRound();
    }, 200);
}

/** Enter voice conversation mode */
function enterVoiceMode(): void {
    if (!voiceStatus?.stt?.available) {
        setStatus('LLM unavailable', 'error');
        setTimeout(() => setStatus(t('titlebar.status_ready'), 'ready'), 3000);
        return;
    }

    voiceModeActive = true;
    voiceOverlay.classList.remove('hidden');
    voiceTranscript.textContent = '';

    // Register the VAD auto-stop callback: end recording after silence and start processing
    recorder.setAutoStopCallback(() => {
        if (voiceModeActive && recorder.getState() === 'recording') {
            finishVoiceRound();
        }
    });

    // Register the voice barge-in callback: interrupt when the user speaks during TTS playback
    bargeInDetector.setCallback(() => {
        if (voiceModeActive) {
            console.log('[VoiceMode] Voice barge-in triggered');
            interruptVoiceResponse();
        }
    });

    // Listen for streaming TTS state and update the overlay
    streamingTtsManager.setStateCallback((ttsState) => {
        if (!voiceModeActive) return;
        const currentState = voiceOverlay.getAttribute('data-state');
        if (ttsState === 'playing' && (currentState === 'answering' || currentState === 'speaking')) {
            setVoiceOverlayState('speaking');
        }
    });

    // ( UI
    setTimeout(() => {
        if (voiceModeActive) startVoiceRound();
    }, 300);
}

/** Exit voice conversation mode */
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

/** Wait for the current session's response to complete (LLM response done) */
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
        // Start checking after a short delay to ensure isLoading has been set to true
        setTimeout(check, 300);
    });
}

/** Wait for streaming TTS playback to finish */
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

/** Start a recording round (with VAD auto-stop) */
async function startVoiceRound(): Promise<void> {
    if (!voiceModeActive) return;
    try {
        setVoiceOverlayState('recording');
        voiceTranscript.textContent = '';
        await recorder.start({
            vad: true,
            vadSilenceMs: 1500,   // auto-stop after 1.5s of silence
            vadThreshold: 12,     // volume threshold
            minDurationMs: 800,   // at least 0.8s
        });
    } catch (error) {
        console.error('[VoiceMode] Recording start failed:', error);
        setVoiceOverlayState('idle');
    }
}

/** Complete one voice round (record -> recognize -> send -> await reply -> TTS -> next) */
async function finishVoiceRound(): Promise<void> {
    if (!voiceModeActive) return;

    try {
        // 1. Stop recording + STT recognition
        setVoiceOverlayState('processing');
        const audioData = await recorder.stop();
        const result = await gatewayClient!.request<any>('voice.transcribe', { audioData: audioData });

        if (!voiceModeActive) return;

        if (result.error || !result.text?.trim()) {
            voiceTranscript.textContent = result.error || t('voice.not_recognized');
            setVoiceOverlayState('idle');
            // Auto-dismiss
            setTimeout(() => {
                if (voiceModeActive) startVoiceRound();
            }, 1500);
            return;
        }

        // 2.
        voiceTranscript.textContent = result.text;

        // 3.
        setVoiceOverlayState('answering');
        messageInput.value = result.text;
        messageInput.dispatchEvent(new Event('input'));
        sendMessage();

        // 4. Wait for the LLM response to complete
        await waitForResponseComplete();
        if (!voiceModeActive) return;

        // 5. Wait for streaming TTS playback to finish
        await waitForTTSComplete();
        if (!voiceModeActive) return;

        // 6.
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

/** Voice conversation mode entry button */
voiceModeBtn.addEventListener('click', () => {
    if (voiceModeBtn.classList.contains('disabled')) {
        setStatus('Service unavailable', 'error');
        setTimeout(() => setStatus(t('titlebar.status_ready'), 'ready'), 3000);
        return;
    }
    enterVoiceMode();
});

/** Close button */
voiceOverlayClose.addEventListener('click', () => {
    exitVoiceMode();
});

/** Main control button */
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

/** Click the central visual area to interrupt (large click target) */
const voiceVisualArea = document.querySelector('.voice-visual-area') as HTMLElement;
voiceVisualArea?.addEventListener('click', (e) => {
    // (voice-controls , visual-area )
    if ((e.target as HTMLElement).closest('.voice-main-btn')) return;
    const state = voiceOverlay.getAttribute('data-state');
    if (state === 'speaking' || state === 'answering') {
        interruptVoiceResponse();
    }
});

/** Keyboard shortcuts */
document.addEventListener('keydown', (e) => {
    if (!voiceModeActive) return;

    if (e.key === 'Escape') {
        exitVoiceMode();
    } else if (e.key === ' ' || e.code === 'Space') {
        // Has images -> prevent default (avoid pasting image HTML into the text box)
        e.preventDefault();
        const state = voiceOverlay.getAttribute('data-state');
        if (state === 'speaking' || state === 'answering') {
            interruptVoiceResponse();
        }
    }
});

// ========================
// Agent Ctrl+Alt+1~9
// ========================
document.addEventListener('keydown', (e: KeyboardEvent) => {
    // Ctrl+Alt+1~9(macOS Meta+Alt
    const useCtrl = isMacOS ? e.metaKey : e.ctrlKey;
    if (!useCtrl || !e.altKey) return;

    const digit = parseInt(e.key, 10);
    if (isNaN(digit) || digit < 1 || digit > 9) return;

    // If agentsList hasn't loaded yet, ignore
    if (!agentsList || agentsList.length === 0) return;

    const targetIndex = digit - 1; // Ctrl+Alt+1 index 0
    if (targetIndex >= agentsList.length) return;

    const targetAgent = agentsList[targetIndex];
    if (!targetAgent) return;

    e.preventDefault();
    switchToAgent(targetAgent.id);
});


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

// toggle
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

    // Bind expand/collapse
    memoryListEl.querySelectorAll('.memory-item-header').forEach(header => {
        header.addEventListener('click', (e) => {
            if ((e.target as HTMLElement).closest('.memory-item-delete')) return;
            header.closest('.memory-item')?.classList.toggle('expanded');
        });
    });

    // Bind delete
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

// Event binding
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
// Distillation system
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

// Card list state
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

        // Stats
        distillStatMicro.textContent = String(stats.microCount ?? 0);
        distillStatMini.textContent = String(stats.miniCount ?? 0);
        distillStatMacro.textContent = String(stats.macroCount ?? 0);
        distillStatTopics.textContent = String(stats.topicCount ?? 0);

        // Scheduler status
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

        // Config
        const cfg = stats.config || {};
        distillEnabled.checked = !!cfg.enabled;
        distillStartTime.value = cfg.startTime || '02:00';
        distillEndTime.value = cfg.endTime || '06:00';
        distillQualityThreshold.value = String(cfg.qualityThreshold ?? 40);
        distillSessionDensity.value = String(cfg.sessionDensityThreshold ?? 5);
        distillSimilarityThreshold.value = String(cfg.similarityThreshold ?? 0.85);

        // Load the card list
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
                    <div class="distill-card-detail-row"><span class="distill-card-detail-label">${t('memory.topic_label')}</span><span class="distill-card-detail-value">${escapeHtml(card.topicTitle || t('memory.uncategorized'))} (${card.topicId || '-'})</span></div>'
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


// Tab
distillCardsTabs.forEach(tab => {
    tab.addEventListener('click', () => {
        distillCardsTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        distillCurrentLayer = (tab as HTMLElement).dataset.layer || '';
        loadDistillCards(distillCurrentLayer);
    });
});

// List event delegation: expand/collapse + delete
distillCardsList.addEventListener('click', async (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    // Delete button
    const deleteBtn = target.closest('.distill-card-delete') as HTMLElement;
    if (deleteBtn) {
        e.stopPropagation();
        const cardId = deleteBtn.dataset.deleteId;
        if (!cardId || !gatewayClient) return;
        if (!confirm('确定删除此卡片?')) return;
        try {
            const result = await gatewayClient.distillationDeleteCard(cardId);
            if (result.success) {
                // Refresh the list and stats
                await Promise.all([loadDistillCards(distillCurrentLayer), loadDistillationData()]);
            }
        } catch (err) {
            console.error('Delete card failed', err);
        }
        return;
    }
    // Expand/collapse
    const item = target.closest('.distill-card-item') as HTMLElement;
    if (item) {
        item.classList.toggle('expanded');
    }
});

// Refresh button
distillCardsRefresh.addEventListener('click', async () => {
    if (distillCardsRefresh.classList.contains('refreshing')) return;
    distillCardsRefresh.classList.add('refreshing');
    try {
        await Promise.all([loadDistillCards(distillCurrentLayer), loadDistillationData()]);
    } finally {
        distillCardsRefresh.classList.remove('refreshing');
    }
});




// Save config
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

// Manual trigger
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
// OpenFlux
// ========================

/** Current cloud chatroom id */
let currentCloudChatroomId: number | null = null;
/** OpenFlux login state (locally cached flag) */
let openfluxLoggedIn = false;
let openfluxLoginStatusKnown = false;
/** Cloud Agent cache */
let cachedOpenFluxAgents: Array<{ agentId: number; appId: number; name: string; description?: string; chatroomId: number }> = [];
/** Used cloud sessions (chatroomId -> session info) */
let usedCloudSessions: Map<number, { sessionId: string; agentName: string }> = new Map();

/** Update input availability based on the cloud session and login state */
function updateInputForCloudSession(): void {
    const isCloudAndNotLoggedIn = !!currentCloudChatroomId && !openfluxLoggedIn;
    messageInput.disabled = isCloudAndNotLoggedIn;
    const sendBtn = document.getElementById('send-btn') as HTMLButtonElement | null;
    const micBtn = document.getElementById('mic-btn') as HTMLButtonElement | null;
    const voiceModeBtn = document.getElementById('voice-mode-btn') as HTMLButtonElement | null;
    if (sendBtn) sendBtn.disabled = isCloudAndNotLoggedIn;
    // mic-btn and voice-mode-btn use the .disabled CSS class
    if (micBtn) micBtn.classList.toggle('disabled', isCloudAndNotLoggedIn);
    if (voiceModeBtn) voiceModeBtn.classList.toggle('disabled', isCloudAndNotLoggedIn);
    if (isCloudAndNotLoggedIn) {
        messageInput.placeholder = t('chat.cloud_login_hint');
    } else {
        messageInput.placeholder = t('chat.input_placeholder');
    }
}

// ---- Login modal elements ----
const openfluxLoginModal = document.getElementById('openflux-login-modal') as HTMLDivElement;
const openfluxModalUsername = document.getElementById('openflux-modal-username') as HTMLInputElement;
const openfluxModalPassword = document.getElementById('openflux-modal-password') as HTMLInputElement;
const openfluxModalPwdToggle = document.getElementById('openflux-modal-pwd-toggle') as HTMLButtonElement;
const openfluxModalLoginBtn = document.getElementById('openflux-modal-login-btn') as HTMLButtonElement;
const openfluxModalHint = document.getElementById('openflux-modal-hint') as HTMLSpanElement;
const openfluxModalClose = document.getElementById('openflux-login-modal-close') as HTMLButtonElement;

// ---- ----
const sidebarModeToggle = document.getElementById('sidebar-mode-toggle') as HTMLDivElement;
const modeChatBtn = document.getElementById('mode-chat-btn') as HTMLButtonElement;
const modeAgentBtn = document.getElementById('mode-agent-btn') as HTMLButtonElement;
const sidebarAgentList = document.getElementById('sidebar-agent-list') as HTMLDivElement;

// ---- Login modal logic ----

const loginModalTitle = openfluxLoginModal.querySelector('.openflux-login-modal-header h3') as HTMLElement | null;
const loginModalUsernameInput = openfluxModalUsername;

/** Pop up the login modal under the Atlas brand (triggered when switching from NexusAI managed mode) */
function showLoginModalForAtlas(): void {
    if (loginModalTitle) loginModalTitle.textContent = t('cloud.login_title');
    if (loginModalUsernameInput) loginModalUsernameInput.placeholder = '输入 NexusAI 账号';
    openfluxLoginModal.classList.remove('hidden');
}

function requestManagedLogin(fallbackMode?: WorkingMode): void {
    const fallback = fallbackMode && fallbackMode !== 'managed' ? fallbackMode : 'standalone';
    pendingManagedSwitch = true;
    pendingManagedFallbackMode = fallback;
    if (!openfluxLoginModal.classList.contains('hidden')) return;
    showLoginModalForAtlas();
}

function queueManagedLoginPrompt(fallbackMode?: WorkingMode): void {
    window.setTimeout(() => {
        void ensureManagedLoginPrompt(fallbackMode);
    }, 0);
}

async function ensureManagedLoginPrompt(fallbackMode?: WorkingMode): Promise<void> {
    if (currentWorkingMode !== 'managed' || openfluxLoggedIn) return;
    if (!openfluxLoginStatusKnown && gatewayClient) {
        try {
            const status = await gatewayClient.openfluxStatus();
            if (status.loggedIn) {
                await onopenfluxLoggedIn(status.username || 'logged_in');
                return;
            }
            onOpenFluxLoggedOut();
        } catch {
            console.warn('[Atlas] Failed to verify login status; skip managed login prompt for now');
            return;
        }
    }
    if (currentWorkingMode === 'managed' && openfluxLoginStatusKnown && !openfluxLoggedIn) {
        requestManagedLogin(fallbackMode);
    }
}

function promptAtlasLoginIfManaged(fallbackMode?: WorkingMode, force = false): void {
    if (currentWorkingMode !== 'managed' || openfluxLoggedIn) return;
    if (!force && !openfluxLoginStatusKnown) {
        queueManagedLoginPrompt(fallbackMode);
        return;
    }
    requestManagedLogin(fallbackMode);
}

/** Restore the login modal's default title */
function restoreLoginModalTitle(): void {
    if (loginModalTitle) loginModalTitle.textContent = t('login.title');
    if (loginModalUsernameInput) loginModalUsernameInput.placeholder = t('login.username_placeholder');
}

openfluxModalClose.addEventListener('click', () => {
    openfluxLoginModal.classList.add('hidden');
    restoreLoginModalTitle();
    // managed ,standalone
    if (pendingManagedSwitch) {
        const fallbackMode = pendingManagedFallbackMode || 'standalone';
        pendingManagedSwitch = false;
        pendingManagedFallbackMode = null;
        applyWorkingMode(fallbackMode);
    }
});
openfluxModalPwdToggle.addEventListener('click', () => {
    openfluxModalPassword.type = openfluxModalPassword.type === 'password' ? 'text' : 'password';
});

// Enter
openfluxModalPassword.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') openfluxModalLoginBtn.click();
});

// Login
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

// ---- ----

// Tab
const openfluxSettingsNotLogged = document.getElementById('openflux-settings-not-logged') as HTMLDivElement;
const openfluxSettingsLogged = document.getElementById('openflux-settings-logged') as HTMLDivElement;
const openfluxSettingsUsername = document.getElementById('openflux-settings-username') as HTMLSpanElement;
const openfluxSettingsLogoutBtn = document.getElementById('openflux-settings-logout-btn') as HTMLButtonElement;

// Settings panel logout button
openfluxSettingsLogoutBtn.addEventListener('click', async () => {
    if (!gatewayClient) return;
    try {
        await gatewayClient.openfluxLogout();
    } catch { /* ignore */ }
    onOpenFluxLoggedOut();
});

/** UI update after a successful login */
async function onopenfluxLoggedIn(username: string): Promise<void> {
    openfluxLoggedIn = true;
    openfluxLoginStatusKnown = true;
    // In the Agent list: hide the login prompt
    agentListLoginPrompt.classList.add('hidden');
    // Settings panel: show logged-in state
    openfluxSettingsNotLogged.classList.add('hidden');
    openfluxSettingsLogged.classList.remove('hidden');
    openfluxSettingsUsername.textContent = username;
    // Save the username for the feedback window
    localStorage.setItem('nexusai-username', username);
    // Update the input box state (unlock if currently in a cloud session)
    updateInputForCloudSession();
    // Agent (NexusAi tab ),Agent tab(Agent
    loadSidebarAgents();
    loadLocalAgents();

    // If login was triggered from managed mode, fall back to standalone on cancel
    if (pendingManagedSwitch) {
        pendingManagedSwitch = false;
        pendingManagedFallbackMode = null;
        // Close the login modal (if open)
        openfluxLoginModal.classList.add('hidden');
        restoreLoginModalTitle();
        applyWorkingMode('managed');
    }

    // If login was triggered by a 401 auth failure, resend the failed request after login
    if (pendingAuthRetry) {
        const retry = pendingAuthRetry;
        pendingAuthRetry = null;
        console.log('[Atlas] Re-login success, retrying failed request:', retry.content.slice(0, 50));
        // Make sure to switch to the target session
        if (retry.sessionId && retry.sessionId !== currentSessionId) {
            await selectSession(retry.sessionId);
        }
        // Resend the message via the Gateway-managed LLM
        setTimeout(() => {
            messageInput.value = retry.content;
            sendMessage();
        }, 500);
    }
}

/** UI update after logout */
function onOpenFluxLoggedOut(): void {
    openfluxLoggedIn = false;
    openfluxLoginStatusKnown = true;
    // In the Agent list: show the login prompt
    agentListLoginPrompt.classList.remove('hidden');
    // Settings panel: show logged-out state
    openfluxSettingsNotLogged.classList.remove('hidden');
    openfluxSettingsLogged.classList.add('hidden');
    // Update the input box state (unlock if currently in a cloud session)
    updateInputForCloudSession();
    // Chat
    switchSidebarMode('agent');
    cachedOpenFluxAgents = [];
    // Agent tab(Agent
    renderLocalAgents();
}

/** Check OpenFlux login state (called on app init) */
async function checkOpenFluxLoginStatus(): Promise<void> {
    if (!gatewayClient) return;
    try {
        const status = await gatewayClient.openfluxStatus();
        if (status.loggedIn) {
            onopenfluxLoggedIn(status.username || 'logged_in');
        } else {
            onOpenFluxLoggedOut();
            promptAtlasLoginIfManaged();
        }
    } catch (e) {
        console.warn('[OpenFlux] Failed to check login status:', e);
    }
}

// ---- Agent / NexusAi ----

modeChatBtn.addEventListener('click', () => switchSidebarMode('agent'));
modeAgentBtn.addEventListener('click', () => switchSidebarMode('nexusai'));

function switchSidebarMode(mode: 'agent' | 'nexusai'): void {
    modeChatBtn.classList.toggle('active', mode === 'agent');
    modeAgentBtn.classList.toggle('active', mode === 'nexusai');
    sessionList.classList.toggle('hidden', mode !== 'agent');
    sidebarAgentList.classList.toggle('hidden', mode !== 'nexusai');
    // NexusAi Agent
    if (mode === 'nexusai') {
        // If cached, render directly without re-requesting the API
        if (cachedOpenFluxAgents.length > 0) {
            renderSidebarAgents();
        } else {
            loadSidebarAgents();
        }
    }
}

// ---- Local Gateway Agent management ----

const agentEditView = document.getElementById('agent-edit-view') as HTMLDivElement;
const agentEditBack = document.getElementById('agent-edit-back') as HTMLButtonElement;
const agentEditTitle = document.getElementById('agent-edit-title') as HTMLHeadingElement;
const agentEditId = document.getElementById('agent-edit-id') as HTMLInputElement;
const agentEditName = document.getElementById('agent-edit-name') as HTMLInputElement;
const agentEditDesc = document.getElementById('agent-edit-desc') as HTMLInputElement;
const agentEditIcon = document.getElementById('agent-edit-icon') as HTMLInputElement;
const agentEditColor = document.getElementById('agent-edit-color') as HTMLInputElement;
const agentColorSwatches = document.getElementById('agent-color-swatches') as HTMLDivElement;

// Color-swatch picker click handling
if (agentColorSwatches) {
    agentColorSwatches.addEventListener('click', (e) => {
        const swatch = (e.target as HTMLElement).closest('.color-swatch') as HTMLElement;
        if (!swatch) return;
        const color = swatch.dataset.color;
        if (!color) return;
        agentEditColor.value = color;
        // Update highlight
        agentColorSwatches.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
        swatch.classList.add('active');
    });
}

/** Set the active state of the color-swatch picker */
function setActiveColorSwatch(color: string): void {
    if (!agentColorSwatches) return;
    agentColorSwatches.querySelectorAll('.color-swatch').forEach(s => {
        const sc = (s as HTMLElement).dataset.color;
        s.classList.toggle('active', sc === color);
    });
}

// ===== Agent =====
const agentIconPreview = document.getElementById('agent-icon-preview') as HTMLDivElement;
const agentIconGrid = document.getElementById('agent-icon-grid') as HTMLDivElement;
const agentIconUploadBtn = document.getElementById('agent-icon-upload-btn') as HTMLButtonElement;
const agentIconFileInput = document.getElementById('agent-icon-file-input') as HTMLInputElement;


/** Update the icon preview */
function updateIconPreview(iconValue: string): void {
    if (!agentIconPreview) return;
    if (iconValue.startsWith('data:image')) {
        agentIconPreview.innerHTML = `<img src="${iconValue}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;" />`;
    } else {
        agentIconPreview.textContent = iconValue || '🤖';
        // If it's text, clear any leftover img in innerHTML
        if (agentIconPreview.querySelector('img')) {
            agentIconPreview.innerHTML = '';
            agentIconPreview.textContent = iconValue || '🤖';
        }
    }
}

/** Set the active state in the icon grid */
function setActiveIconGridItem(iconValue: string): void {
    if (!agentIconGrid) return;
    agentIconGrid.querySelectorAll('.agent-icon-grid-item').forEach(btn => {
        const di = (btn as HTMLElement).dataset.icon;
        btn.classList.toggle('active', di === iconValue);
    });
}

// Icon grid click
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

// Upload a photo
if (agentIconUploadBtn) {
    agentIconUploadBtn.addEventListener('click', () => agentIconFileInput?.click());
}
if (agentIconFileInput) {
    agentIconFileInput.addEventListener('change', () => {
        const file = agentIconFileInput.files?.[0];
        if (!file) return;
        // 200KB
        if (file.size > 200 * 1024) {
            alert(t('agent.image_too_large'));
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            const dataUri = reader.result as string;
            agentEditIcon.value = dataUri;
            updateIconPreview(dataUri);
            setActiveIconGridItem(''); // clear the grid highlight
        };
        reader.readAsDataURL(file);
        agentIconFileInput.value = ''; // allow selecting the same file again
    });
}
const agentEditPrompt = document.getElementById('agent-edit-prompt') as HTMLTextAreaElement;
const agentEditSave = document.getElementById('agent-edit-save') as HTMLButtonElement;
const agentEditCancel = document.getElementById('agent-edit-cancel') as HTMLButtonElement;

let editingAgentId: string | null = null; // null = create, non-null = edit

/** Load the local Agent list */
async function loadLocalAgents(): Promise<void> {
    if (!gatewayClient) return;
    sessionList.innerHTML = '<div class="memory-empty-state" style="font-size:0.8rem;padding:12px;">' + t('common.loading') + '</div>';
    try {
        // Agent Session,Session Agent
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

        // Extract used cloud sessions (to show previously used cloud Agents in the Agent tab)
        usedCloudSessions = new Map();
        for (const s of sessions) {
            if (s.cloudChatroomId) {
                usedCloudSessions.set(s.cloudChatroomId, {
                    sessionId: s.id,
                    agentName: s.cloudAgentName || `Cloud Agent`,
                });
                // sessionId chatroomId ()
                sessionToChatroomMap.set(s.id, s.cloudChatroomId);
            }
        }

        renderLocalAgents();

        // Auto-select the default Agent (on first launch) and load its session content
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

/** Render the local Agent list (at the sessionList location) */
function renderLocalAgents(): void {
    sessionList.innerHTML = '';
    if (agentsList.length === 0) {
        sessionList.innerHTML = '<div class="memory-empty-state" style="font-size:0.8rem;padding:12px;">' + t('agent.no_agents') + '</div>';
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
                <button class="agent-action-btn agent-edit-action" title="${t('agent.edit_btn')}">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                    </svg>
                </button>
                <button class="agent-action-btn agent-delete-action" title="${t('agent.delete_btn')}">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                    </svg>
                </button>
            </div>
        `;
        // Agent
        card.addEventListener('click', (e) => {
            const target = e.target as HTMLElement;
            if (target.closest('.agent-edit-action') || target.closest('.agent-delete-action')) return;
            switchToAgent(agent.id);
        });
        // Edit button
        card.querySelector('.agent-edit-action')?.addEventListener('click', () => openAgentEditModal(agent.id));
        // Delete button
        card.querySelector('.agent-delete-action')?.addEventListener('click', () => deleteLocalAgent(agent.id, name));
        sessionList.appendChild(card);
    }

    // ---- Used cloud NexusAi Agent group ----
    // Agent()
    if (usedCloudSessions.size > 0) {
        // Match used cloud Agent details from cache, or just use the session name
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
            // Divider + group title
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
                // Click to switch to this cloud session
                card.addEventListener('click', () => startCloudChat(agent.appId, agent.name, agent.chatroomId));
                sessionList.appendChild(card);
            }
        }
    }

    // ---- Router (Agent ----
    if (routerEnabled) {
        // Divider + group title
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

    // ---- Connect (----
    appendConnectSection();
}

/** External connection definitions */
interface ConnectionDef {
    id: string;
    icon: string;
    name: string;
    desc: string;
    getStatus: () => { dot: 'green' | 'yellow' | 'red' | 'gray'; label: string };
    actions: Array<{ label: string; action: () => void; variant?: 'primary' | 'danger' }>;
}

/** Append the Connect section to the end of session-list (styled like an agent card) */
function appendConnectSection(): void {
    const excelInstalled = localStorage.getItem('excel-plugin-installed') === '1';
    const wordInstalled = localStorage.getItem('word-plugin-installed') === '1';
    const pptInstalled = localStorage.getItem('ppt-plugin-installed') === '1';

    interface ConnConfig {
        id: string; icon: string; logo: string; color: string;
        name: string; desc: string; enabled: boolean;
        onToggle: (el: HTMLInputElement) => void;
        onConfigure: () => void;
    }

    const conns: ConnConfig[] = [
        {
            id: 'conn-excel', icon: '📊', logo: '/logos/excel.svg', color: '#22c55e',
            name: t('connections.excel_name') || 'Excel 插件',
            desc: t('connections.excel_desc') || 'Excel plugin',
            enabled: excelInstalled,

            onToggle: async (el) => {
                const turnOn = el.checked; // the new state the user actually toggled to
                el.disabled = true;
                if (turnOn) {
                    // ON
                    try {
                        const { invoke } = await import('@tauri-apps/api/core');
                        await invoke<string>('excel_plugin_install');
                        localStorage.setItem('excel-plugin-installed', '1');
                        showPluginToast('success',
                            t('connections.excel_install_ok') || 'Excel plugin installed',
                            [
                                t('connections.step_restart_excel') || '请重Excel',
                                t('connections.step_insert_addin') || 'Insert add-in',
                                t('connections.step_shared_folder') || 'Share OpenFlux folder',
                            ]
                        );
                        renderLocalAgents();
                    } catch (e) {
                        showPluginToast('error',
                            (t('connections.install_failed') || '安装失败') + ': ' + String(e)
                        );
                        el.checked = false; // roll back to OFF
                        el.disabled = false;
                    }
                } else {
                    // User toggled OFF -> uninstall, confirm first
                    const confirmed = await showExcelUninstallConfirm();
                    if (!confirmed) {
                        el.checked = true; // roll back to ON
                        el.disabled = false;
                        return;
                    }
                    try {
                        const { invoke } = await import('@tauri-apps/api/core');
                        await invoke<string>('excel_plugin_uninstall');
                        localStorage.removeItem('excel-plugin-installed');
                        showPluginToast('info',
                            t('connections.excel_uninstall_ok') || 'Excel plugin uninstalled',
                            [t('connections.step_restart_excel') || '重启 Excel 后插件将不再显示']
                        );
                        renderLocalAgents();
                    } catch (e) {
                        showPluginToast('error',
                            (t('connections.uninstall_failed') || '卸载失败') + ': ' + String(e)
                        );
                        el.checked = true; // roll back to ON
                        el.disabled = false;
                    }
                }
            },
            onConfigure: () => showSettings('connections'),
        },
        {
            id: 'conn-word', icon: '📝', logo: '/logos/word.svg', color: '#3b82f6',
            name: t('connections.word_name') || 'Word 插件',
            desc: t('connections.word_desc') || 'AI 操控 Word 文档',
            enabled: wordInstalled,

            onToggle: async (el) => {
                const turnOn = el.checked;
                el.disabled = true;
                if (turnOn) {
                    try {
                        const { invoke } = await import('@tauri-apps/api/core');
                        await invoke<string>('word_plugin_install');
                        localStorage.setItem('word-plugin-installed', '1');
                        showPluginToast('success',
                            t('connections.word_install_ok') || 'Word plugin installed',
                            [
                                t('connections.step_restart_word') || '请重Word',
                                t('connections.step_insert_addin') || 'Insert add-in',
                                t('connections.step_shared_folder') || '共享文件OpenFlux Agent 添加',
                            ]
                        );
                        renderLocalAgents();
                    } catch (e) {
                        showPluginToast('error',
                            (t('connections.install_failed') || '安装失败') + ': ' + String(e)
                        );
                        el.checked = false;
                        el.disabled = false;
                    }
                } else {
                    const confirmed = await showConfirmDialog(
                        t('connections.word_uninstall_confirm') || 'Confirm uninstall Word plugin',
                    );
                    if (!confirmed) { el.checked = true; el.disabled = false; return; }
                    try {
                        const { invoke } = await import('@tauri-apps/api/core');
                        await invoke<string>('word_plugin_uninstall');
                        localStorage.removeItem('word-plugin-installed');
                        showPluginToast('info',
                            t('connections.word_uninstall_ok') || 'Word plugin uninstalled',
                            [t('connections.step_restart_word') || '重启 Word 后插件将不再显示']
                        );
                        renderLocalAgents();
                    } catch (e) {
                        showPluginToast('error',
                            (t('connections.uninstall_failed') || '卸载失败') + ': ' + String(e)
                        );
                        el.checked = true;
                        el.disabled = false;
                    }
                }
            },
            onConfigure: () => showSettings('connections'),
        },
        {
            id: 'conn-powerpoint', icon: '📊', logo: '/logos/powerpoint.svg', color: '#f97316',
            name: t('connections.ppt_name') || 'PowerPoint 插件',
            desc: t('connections.ppt_desc') || 'PowerPoint plugin',
            enabled: pptInstalled,

            onToggle: async (el) => {
                const turnOn = el.checked;
                el.disabled = true;
                if (turnOn) {
                    try {
                        const { invoke } = await import('@tauri-apps/api/core');
                        await invoke<string>('ppt_plugin_install');
                        localStorage.setItem('ppt-plugin-installed', '1');
                        showPluginToast('success',
                            t('connections.ppt_install_ok') || 'PowerPoint plugin installed',
                            [
                                t('connections.step_restart_ppt') || '请重PowerPoint',
                                t('connections.step_insert_addin') || 'Insert add-in',
                                t('connections.step_shared_folder') || '共享文件OpenFlux Agent 添加',
                            ]
                        );
                        renderLocalAgents();
                    } catch (e) {
                        showPluginToast('error',
                            (t('connections.install_failed') || '安装失败') + ': ' + String(e)
                        );
                        el.checked = false;
                        el.disabled = false;
                    }
                } else {
                    const confirmed = await showConfirmDialog(
                        t('connections.ppt_uninstall_confirm') || 'Confirm uninstall PowerPoint plugin',
                    );
                    if (!confirmed) { el.checked = true; el.disabled = false; return; }
                    try {
                        const { invoke } = await import('@tauri-apps/api/core');
                        await invoke<string>('ppt_plugin_uninstall');
                        localStorage.removeItem('ppt-plugin-installed');
                        showPluginToast('info',
                            t('connections.ppt_uninstall_ok') || 'PowerPoint plugin uninstalled',
                            [t('connections.step_restart_ppt') || '重启 PowerPoint 后插件将不再显示']
                        );
                        renderLocalAgents();
                    } catch (e) {
                        showPluginToast('error',
                            (t('connections.uninstall_failed') || '卸载失败') + ': ' + String(e)
                        );
                        el.checked = true;
                        el.disabled = false;
                    }
                }
            },
            onConfigure: () => showSettings('connections'),
        },
    ];

    const gearSvg = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="3"/>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06.06A1.65 1.65 0 0 0 9 15a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 12 9a1.65 1.65 0 0 0 1.82.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 15z"/>
    </svg>`;

    // Divider + group title
    const divider = document.createElement('div');
    divider.className = 'agent-group-divider';
    divider.innerHTML = `<span class="agent-group-label">${t('connections.title') || 'Connect'}</span>`;
    sessionList.appendChild(divider);

    // Card
    for (const conn of conns) {
        const card = document.createElement('div');
        card.className = 'local-agent-card conn-agent-card';
        card.id = conn.id;
        card.style.borderLeft = `3px solid ${conn.color}`;
        card.innerHTML = `
            <div class="agent-card-icon conn-logo-icon">
                <img src="${conn.logo}" alt="${escapeHtml(conn.name)}" draggable="false"/>
            </div>
            <div class="agent-card-info">
                <div class="agent-card-name">${escapeHtml(conn.name)}</div>
                <div class="agent-card-desc">${escapeHtml(conn.desc)}</div>
            </div>
            <div class="conn-card-controls">
<label class="toggle-switch conn-mini-toggle" title="${conn.enabled ? (t('connections.enabled') || 'On') : (t('connections.disabled') || 'Off')}">
                    <input type="checkbox" ${conn.enabled ? 'checked' : ''} data-conn-toggle="${conn.id}">
                    <span class="toggle-slider"></span>
                </label>
                <button class="agent-action-btn conn-gear-btn" title="${t('connections.configure') || '配置'}">
                    ${gearSvg}
                </button>
            </div>
        `;

        // toggle: listen to input's click directly (avoids label activation compatibility issues in WebView)
        const toggleInput = card.querySelector(`[data-conn-toggle]`) as HTMLInputElement;
        toggleInput?.addEventListener('click', (e) => {
            e.stopPropagation();
            // After click, checked is already toggled, so read the new state directly
            conn.onToggle(toggleInput);
        });

        // Gear button
        const gearBtn = card.querySelector('.conn-gear-btn') as HTMLButtonElement;
        gearBtn?.addEventListener('click', (e) => { e.stopPropagation(); conn.onConfigure(); });

        sessionList.appendChild(card);
    }

    // ---- CLI Coding Agents( Office ,) ----
    const CLI_META: Record<string, { icon: string; logo: string; color: string; desc: string; installUrl: string; authCmd?: string }> = {
        agy:    { icon: '', logo: '/logos/agy.svg',    color: '#6366f1', desc: 'Antigravity CLI by Google DeepMind',   installUrl: 'https://antigravity.dev', authCmd: `& "$env:LOCALAPPDATA\\agy\\bin\\agy.exe"` },
        claude: { icon: '', logo: '/logos/claude.svg', color: '#D97757', desc: 'Claude Code by Anthropic', installUrl: 'https://docs.anthropic.com/en/docs/claude-code', authCmd: 'claude' },
        codex:  { icon: '', logo: '/logos/openai.svg', color: '#10b981', desc: 'OpenAI Codex CLI', installUrl: 'https://github.com/openai/codex' },
        cursor: { icon: '', logo: '/logos/cursor.svg', color: '#3b82f6', desc: 'Cursor - AI native code editor', installUrl: 'https://cursor.sh' },
    };

    (async () => {
        const ws = (window as any).__gatewayClient as import('./gateway-client').GatewayClient | undefined;
        if (!ws) return;
        try {
            const drivers = await ws.listCodingAgentDrivers();
            for (const d of drivers) {
                const meta = CLI_META[d.id] || { icon: '🔌', color: '#6b7280', desc: d.id, installUrl: '' };
                const isReady = d.installed && d.authenticated;
                const statusTitle = !d.installed ? 'Not Installed' : !d.authenticated ? 'Installed, Not Authenticated' : 'Ready';

                const cliCard = document.createElement('div');
                cliCard.className = 'local-agent-card conn-agent-card';
                cliCard.id = `conn-cli-${d.id}`;
                cliCard.dataset.feature = 'codingAgents';  // brand switch: hidden by default in the open-source build
                cliCard.style.borderLeft = `3px solid ${meta.color}`;
                cliCard.innerHTML = `
                    <div class="agent-card-icon conn-logo-icon">
                        <img src="${meta.logo || ''}" alt="${escapeHtml(d.displayName)}" draggable="false"/>
                    </div>
                    <div class="agent-card-info">
                        <div class="agent-card-name">${escapeHtml(d.displayName)}</div>
                        <div class="agent-card-desc">${escapeHtml(meta.desc)}</div>
                    </div>
                    <div class="conn-card-controls">
                        <label class="toggle-switch conn-mini-toggle" title="${statusTitle}">
                            <input type="checkbox" ${isReady ? 'checked' : ''} disabled data-cli-id="${escapeHtml(d.id)}">
                            <span class="toggle-slider"></span>
                        </label>
                        <button class="agent-action-btn conn-gear-btn" title="${t('connections.configure') || '配置'}" data-cli-id="${escapeHtml(d.id)}">
                            ${gearSvg}
                        </button>
                    </div>
                `;

                // Gear button: open settings
                const gearBtn = cliCard.querySelector('.conn-gear-btn') as HTMLButtonElement;
                gearBtn?.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (!d.installed) {
                        window.open(meta.installUrl, '_blank');
                    } else if (!d.authenticated && meta.authCmd) {
                        navigator.clipboard.writeText(meta.authCmd).then(() => showToast(`已复${d.displayName} 认证命令`));
                    } else {
                        showToast(`${d.displayName} 已就绪`);
                    }
                });

                sessionList.appendChild(cliCard);
            }
        } catch { /* fail silently; does not affect the main flow */ }
    })();
}


/** Jump to the given tab on the settings page */
async function switchToAgent(agentId: string): Promise<void> {
    if (!gatewayClient) return;
    try {
        const result = await gatewayClient.switchAgent(agentId);
        currentAgentId = agentId;
        // ID Agent sessionKey
        const agentInfo = result.agent as Record<string, unknown>;
        const sessionKey = (agentInfo.sessionKey || agentId) as string;

        // ====== Sync phase: lock the current session UI + insert DOM elements ======
        if (currentSessionId) {
            const draft = messageInput.value.trim();
            if (draft) {
                sessionDrafts.set(currentSessionId, messageInput.value);
            } else {
                sessionDrafts.delete(currentSessionId);
            }
        }

        // ( selectSession )
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
        // agent
        unreadSessionIds.delete(sessionKey);
        const agentCard = sessionList.querySelector(`.local-agent-card[data-agent-id="${agentId}"]`);
        agentCard?.querySelector('.unread-badge')?.remove();
        // Hide the Router bind UI, restore the input area
        document.body.classList.remove('router-active');
        hideRouterBindUI();
        (document.querySelector('.input-area') as HTMLElement).classList.remove('hidden');

        // Restore the input draft of the target session
        messageInput.value = sessionDrafts.get(sessionKey) || '';
        autoResize();

        // Reset the live progress state
        currentProgressCard = null;
        progressItems = [];
        isProgressFinished = !loadingSessions.has(sessionKey);

        // Hide edit/settings/scheduler views, ensure the chat area is shown
        hideAgentEditView();
        closeSettingsView();
        if (schedulerViewActive) {
            schedulerViewActive = false;
            schedulerView.classList.add('hidden');
            if (countdownTimerId) { clearInterval(countdownTimerId); countdownTimerId = null; }
        }

        // selectSession
        const messagesEl = document.getElementById('messages') as HTMLDivElement;
        try {
            // Reset lazy-load state
            sessionMsgOffset.set(sessionKey, 0);
            sessionMsgHasMore.set(sessionKey, false);

            const [msgResult, logs, savedArtifacts] = await Promise.all([
                gatewayClient.getMessages(sessionKey, SESSION_PAGE_SIZE, 0),
                gatewayClient.getLogs(sessionKey),
                gatewayClient.getArtifacts(sessionKey),
            ]);

            const { messages, total, hasMore } = msgResult;
            sessionMsgOffset.set(sessionKey, messages.length);
            sessionMsgHasMore.set(sessionKey, hasMore);
            console.log(`[Agent] Messages: ${messages.length}/${total} hasMore: ${hasMore}`);

            if ((messages as Message[]).length > 0) {
                const hydratedMessages = await hydrateMessageAttachments(messages);
                renderMessagesWithLogs(hydratedMessages, logs as LogEntry[]);
                if (hasMore) {
                    prependLoadMoreHint();
                }
            } else {
                // Agent
                const agentName = (agentInfo.name || agentId) as string;
                messagesEl.innerHTML = `<div class="memory-empty-state" style="padding:32px;text-align:center;opacity:0.6;">${t('agent.chatting_with').replace('{0}', '<strong>' + escapeHtml(agentName) + '</strong>')}</div>`;
            }

            // ═══ Restore progress card: rebuild it if the target session has cached progress ═══
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

            // Restore artifacts (no longer persisted, since they're already on the server)
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

        // Agent
        renderLocalAgents();
        // Chat
        switchSidebarMode('agent');
        updateSendButtonState();
        messageInput.focus();
        console.log(`[Agent] 已切换到 Agent: ${agentId}, session: ${sessionKey}`);
    } catch (e) {
        console.error('[Agent] 切换 Agent 失败:', e);
    }
}

/** Simply append a message to the chat area */
function appendMessageToChat(role: string, content: string): void {
    const messagesContainer = document.getElementById('messages') as HTMLDivElement;
    const div = document.createElement('div');
    div.className = `message ${role === 'user' ? 'user-message' : 'assistant-message'}`;
    div.innerHTML = `<div class="message-content">${escapeHtml(content)}</div>`;
    messagesContainer.appendChild(div);
}

/** Show the Agent edit view (center window) */
function showAgentEditView(): void {
    messagesContainer.classList.add('hidden');
    settingsView.classList.add('hidden');
    agentEditView.classList.remove('hidden');
    // Hide the input area
    const inputArea = document.querySelector('.input-area') as HTMLElement | null;
    if (inputArea) inputArea.classList.add('hidden');
}

/** Hide the Agent edit view, back to chat */
function hideAgentEditView(): void {
    agentEditView.classList.add('hidden');
    messagesContainer.classList.remove('hidden');
    const inputArea = document.querySelector('.input-area') as HTMLElement | null;
    if (inputArea) inputArea.classList.remove('hidden');
}

/** Open the Agent edit view */
function openAgentEditModal(editId?: string): void {
    editingAgentId = editId || null;
    const idGroup = agentEditId.closest('.settings-item') as HTMLElement;
    if (editId) {
        // Edit mode
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
        // (ID ,ID
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

/** Save the Agent (create or update) */
async function saveAgent(): Promise<void> {
    if (!gatewayClient) return;
    const name = agentEditName.value.trim();
    if (!name) { agentEditName.focus(); return; }

    try {
        if (editingAgentId) {
            // Update
            await gatewayClient.updateAgent(editingAgentId, {
                name,
                description: agentEditDesc.value.trim() || undefined,
                icon: agentEditIcon.value.trim() || undefined,
                color: agentEditColor.value || undefined,
                systemPrompt: agentEditPrompt.value.trim() || undefined,
            });
        } else {
            // (ID )
            await gatewayClient.createAgent({
                id: '', // ignored by the backend; auto-generated
                name,
                description: agentEditDesc.value.trim() || undefined,
                icon: agentEditIcon.value.trim() || undefined,
                color: agentEditColor.value || undefined,
                systemPrompt: agentEditPrompt.value.trim() || undefined,
            });
        }
        hideAgentEditView();
        await loadLocalAgents(); // refresh the list
    } catch (e) {
        console.error('[Agent] 保存 Agent 失败:', e);
        alert('保存失败: ' + (e as Error).message);
    }
}

/** Delete a local Agent */
/** Confirmation dialog (Tauri WebView has no native confirm) */
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
    // Agent
    const agent = agentsList.find(a => a.id === agentId);
    if (agent && agent.default) {
        await showConfirmDialog(`默认 Agent "${agentName}" 不可删除。`);
        return;
    }
    const confirmed = await showConfirmDialog(`确定要删除 Agent "${agentName}" 吗？\n注意：Agent 的聊天历史将被清除。`);
    if (!confirmed) return;
    try {
        await gatewayClient.deleteAgent(agentId);
        // Agent,Agent
        if (currentAgentId === agentId) {
            currentAgentId = null;
            // Agent
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

// Agent
newSessionBtn.addEventListener('click', () => openAgentEditModal());
agentEditSave.addEventListener('click', () => saveAgent());
agentEditCancel.addEventListener('click', () => hideAgentEditView());
agentEditBack.addEventListener('click', () => hideAgentEditView());

// ---- Sidebar Agent list ----

async function loadSidebarAgents(): Promise<void> {
    if (!gatewayClient) return;

    // When not logged in, show the login prompt directly without requesting the API
    if (!openfluxLoggedIn) {
        agentListLoginPrompt.classList.remove('hidden');
        // Agent ( login prompt
        sidebarAgentList.querySelectorAll('.sidebar-agent-item, .memory-empty-state').forEach(el => el.remove());
        return;
    }

    agentListLoginPrompt.classList.add('hidden');
    // ( login prompt
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
    // ( login prompt
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
        // Double-click to start a cloud chat
        item.addEventListener('dblclick', () => startCloudChat(agent.appId, agent.name, agent.chatroomId));
        sidebarAgentList.appendChild(item);
    }
}

// ---- Start a cloud chat ----

async function startCloudChat(appId: number, agentName: string, chatroomId?: number): Promise<void> {
    if (!gatewayClient) return;
    try {
        // chatroomId, appId
        if (!chatroomId) {
            const info = await gatewayClient.openfluxAgentInfo(appId);
            if (!info || !info.chatroomId) {
                alert(t('cloud.agent_no_room'));
                return;
            }
            chatroomId = info.chatroomId;
        }

        // Check whether a session already exists for this chatroomId (single-session mode)
        const sessions = await gatewayClient.getSessions();
        const existing = sessions.find(s => s.cloudChatroomId === chatroomId);

        if (existing) {
            // Existing session, switch directly
            currentSessionId = existing.id;
            currentCloudChatroomId = chatroomId;
            currentAgentId = '';  // clear the local Agent selection
            // sessionId chatroomId
            if (chatroomId) sessionToChatroomMap.set(existing.id, chatroomId);
            isRouterSession = false;
            document.body.classList.remove('router-active');
            hideRouterBindUI();
            (document.querySelector('.input-area') as HTMLElement).classList.remove('hidden');
            switchSidebarMode('agent');
            closeSettingsView();

            // Clear the unread mark
            unreadSessionIds.delete(existing.id);
            const cloudCard = sessionList.querySelector(`.cloud-agent-card[data-cloud-chatroom-id="${chatroomId}"]`);
            cloudCard?.querySelector('.unread-badge')?.remove();
            const sessionItem = sessionList.querySelector(`.session-item[data-session-id="${existing.id}"]`);
            sessionItem?.querySelector('.unread-badge')?.remove();

            // Load existing messages (local first, fall back to cloud)
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
            // No existing session, create a new one
            const session = await gatewayClient.createSession(undefined, chatroomId, agentName);
            currentSessionId = session.id;
            currentCloudChatroomId = chatroomId;
            currentAgentId = '';  // clear the local Agent selection
            isRouterSession = false;
            document.body.classList.remove('router-active');
            hideRouterBindUI();
            (document.querySelector('.input-area') as HTMLElement).classList.remove('hidden');
            switchSidebarMode('agent');
            clearMessages();
            clearLogs();

            // 1) The user message appears immediately (attachments shown above the text)
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
// OpenFluxRouter
// ========================

let isRouterSession = false;
let routerConnected = false;
let routerEnabled = false;
let routerBound = false;
let routerRealSessionId: string | null = null;

// LLM
let managedLlmAvailable = false;
let managedLlmProvider = '';
let managedLlmModel = '';
let managedLlmQuota: { daily_limit: number; used_today: number } | null = null;
let currentLlmSource: 'local' | 'managed' | 'atlas_managed' = 'local';

/** Switch to the Router session */
async function switchToRouterSession(): Promise<void> {
    isRouterSession = true;
    currentCloudChatroomId = null;
    currentAgentId = '';  // clear the local Agent selection

    // If the settings view is active, switch back to chat first
    closeSettingsView();
    // Restore artifacts (no longer persisted, since they're already on the server)
    clearArtifacts();

    // Router (,Router Agent
    document.body.classList.add('router-active');
    (document.querySelector('.input-area') as HTMLElement).classList.add('hidden');

    // routerRealSessionId, Gateway
    if (!routerRealSessionId && gatewayClient) {
        try {
            const configResp = await gatewayClient.routerConfigGet();
            if ((configResp as any).sessionId) {
                routerRealSessionId = (configResp as any).sessionId;
            }
        } catch (_) { /* ignore */ }
    }

    // Router
    if (routerRealSessionId && gatewayClient) {
        currentSessionId = routerRealSessionId;
        try {
            const [messages, logs] = await Promise.all([
                gatewayClient.getMessages(routerRealSessionId),
                gatewayClient.getLogs(routerRealSessionId),
            ]);
            const hydratedMessages = await hydrateMessageAttachments(messages);
            if (hydratedMessages.length === 0 && (logs as LogEntry[]).length === 0) {
                renderRouterWaitingState();
            } else {
                renderMessagesWithLogs(hydratedMessages, logs as LogEntry[]);
            }
        } catch (error) {
            console.error('[Router] Load session messages failed:', error);
            renderRouterWaitingState();
        }
    } else {
        currentSessionId = null;
        renderRouterWaitingState();
    }

    // Load client settings, then bind the Router UI
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

    // Agent list
    renderLocalAgents();
}

/** Show the Router bind UI */
function showRouterBindUI(): void {
    const area = document.getElementById('router-bind-area');
    if (!area) return;
    if (routerBound) {
        area.classList.add('hidden');
    } else {
        area.classList.remove('hidden');
    }
}

/** Hide the Router bind UI */
function hideRouterBindUI(): void {
    const area = document.getElementById('router-bind-area');
    if (area) area.classList.add('hidden');
}

/** Handle the Router bind action */
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



/** Load the Router config into the UI */
async function loadRouterConfig(): Promise<void> {
    if (!gatewayClient) return;
    try {
        const result = await gatewayClient.routerConfigGet();
        routerConnected = result.connected;
        if (result.config) routerEnabled = !!result.config.enabled;
        updateRouterStatusDot(result.connected);

        // Sync bind status (the bound value in the server-recorded Router connect_status)
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
                // ID
                gatewayClient!.routerConfigUpdate({ appUserId: uid }).catch(() => { });
            }
            if (appUserIdInput) appUserIdInput.value = uid;
        }
    } catch (err) {
        console.error('[Router] Load config failed:', err);
    }
}

/** Save the Router config */
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
            if (hint) { hint.textContent = t('agent.saved_hint'); setTimeout(() => { hint.textContent = ''; }, 2000); }
        } else {
            if (hint) { hint.textContent = 'X ' + (result.message || t('common.save_failed')); }
        }
    } catch (err) {
        if (hint) { hint.textContent = 'X ' + t('common.save_failed'); }
    }
}

/** Update the Router status indicator */
function updateRouterStatusDot(connected: boolean): void {
    const dot = document.getElementById('router-status-dot');
    if (dot) {
        dot.className = `router-status-dot ${connected ? 'connected' : 'disconnected'}`;
        dot.title = connected ? 'Connected' : 'Not Connected';
    }
}

/** Generate a random App User ID */
function generateAppUserId(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let id = 'ofu_';
    for (let i = 0; i < 12; i++) {
        id += chars[Math.floor(Math.random() * chars.length)];
    }
    return id;
}


/** Test the Router connection */
async function testRouterConnection(): Promise<void> {
    if (!gatewayClient) return;
    const hint = document.getElementById('router-save-hint');
    const testBtn = document.getElementById('router-test-btn') as HTMLButtonElement;

    const url = (document.getElementById('router-url') as HTMLInputElement)?.value?.trim() || '';
    const appId = (document.getElementById('router-app-id') as HTMLInputElement)?.value?.trim() || '';
    const apiKey = (document.getElementById('router-api-key') as HTMLInputElement)?.value?.trim() || '';

    if (!url || !appId) {
        if (hint) hint.textContent = '[!] ' + t('cloud.fill_router_info');
        return;
    }

    if (testBtn) { testBtn.disabled = true; testBtn.textContent = t('router.testing'); }
    if (hint) hint.textContent = t('router.testing');

    try {
        const payload: any = { url, appId, appType: 'openflux' };
        if (apiKey) payload.apiKey = apiKey;
        const result = await gatewayClient.routerTest(payload);
        if (hint) {
            hint.textContent = result.success ? `${result.message}` : `${result.message}`;
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

    // Inbound message (user message enters Agent handling via the Router)
    gatewayClient.onRouterMessage(async (msg) => {
        // Router session ID
        if (msg.sessionId) {
            routerRealSessionId = msg.sessionId;
        }

        // If currently in a Router session, append the user message bubble in real time
        if (isRouterSession) {
            currentSessionId = routerRealSessionId;
            // Record as the chat target session (so progress events render correctly)
            if (routerRealSessionId) {
                chatTargetSessionIds.add(routerRealSessionId);
            }
            // Reset the live progress state
            currentProgressCard = null;
            progressItems = [];

            // Handle multimedia attachments
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
                    // Image attachment: fetch the thumbnail via file_read
                    if (a.content_type === 'image' || IMAGE_EXTS_SET.has(a.ext?.toLowerCase())) {
                        try {
                            const result = await invoke<any>('file_read', { filePath: a.path });
                            if (result.dataUrl) {
                                attachment.thumbnailUrl = result.dataUrl;
                            }
                        } catch { /* file read failed; ignore the thumbnail */ }
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

    // Connection status change
    gatewayClient.onRouterStatus((status) => {
        routerConnected = status.connected;
        if (status.connected) routerEnabled = true;
        updateRouterStatusDot(status.connected);
        // Router
        const existing = sessionList.querySelector('.router-session-item');
        if (!existing && routerEnabled) {
            loadLocalAgents();
        }
    });

    // LLM
    gatewayClient.onManagedLlmConfig((cfg) => {
        managedLlmAvailable = cfg.available;
        managedLlmProvider = cfg.provider || '';
        managedLlmModel = cfg.model || '';
        managedLlmQuota = cfg.quota || null;
        if (cfg.currentSource) currentLlmSource = cfg.currentSource;
        updateManagedLlmUI();
        console.log('[LLM] Hosted config updated:', { available: cfg.available, provider: cfg.provider, model: cfg.model });

        // Fix a timing issue: in Router mode, when managed config arrives asynchronously and Gateway is still local, auto-activate managed
        if (cfg.available && currentWorkingMode === 'router' && currentLlmSource === 'local') {
            console.log('[LLM] Auto-switching to managed (Router config arrived after mode switch)');
            gatewayClient.setLlmSource('managed').then(() => {
                currentLlmSource = 'managed';
            }).catch(() => {});
        }
    });

    // LLM source
    gatewayClient.getLlmSource().then((result) => {
        currentLlmSource = result.source;
        if (result.managed) {
            managedLlmAvailable = result.managed.available;
            managedLlmProvider = result.managed.provider || '';
            managedLlmModel = result.managed.model || '';
            managedLlmQuota = result.managed.quota || null;
        }
        // Sync the frontend mode card state
        if (result.source === 'atlas_managed' && currentWorkingMode !== 'managed') {
            currentWorkingMode = 'managed';
            localStorage.setItem('openflux-working-mode', 'managed');
            workingModeCards.forEach(card => {
                card.classList.toggle('active', card.dataset.mode === 'managed');
            });
        }
        if (result.source === 'atlas_managed') {
            promptAtlasLoginIfManaged();
        }
        updateManagedLlmUI();
    }).catch(() => {
        // Gateway , UI
        updateManagedLlmUI();
    });

    // Regenerate UID button
    // App User ID
    document.getElementById('router-regenerate-uid')?.addEventListener('click', () => {
        const input = document.getElementById('router-app-user-id') as HTMLInputElement;
        if (input) input.value = generateAppUserId();
    });

    // Test button
    document.getElementById('router-test-btn')?.addEventListener('click', testRouterConnection);

    // (connect_status )
    gatewayClient.onRouterBindResult((result) => {
        const statusEl = document.getElementById('router-bind-status');

        // Router
        if (result.action === 'connect_status') {
            const payload = result as any;
            console.log('[Router] connect_status received in onRouterBindResult:', JSON.stringify(payload));
            if (payload.bound) {
                routerBound = true;
                hideRouterBindUI();
                // Sync the popup state
                document.getElementById('qr-bind-popup-initial')?.classList.add('hidden');
                document.getElementById('qr-bind-popup-display')?.classList.add('hidden');
                document.getElementById('qr-bind-popup-success')?.classList.remove('hidden');
                console.log('[Router] Platform user bound');
            } else {
                routerBound = false;
                // Sync the popup state
                document.getElementById('qr-bind-popup-initial')?.classList.remove('hidden');
                document.getElementById('qr-bind-popup-display')?.classList.add('hidden');
                document.getElementById('qr-bind-popup-success')?.classList.add('hidden');
                if (isRouterSession) showRouterBindUI();
            }
            return;
        }

        // Regular bind result
        if (result.status === 'matched') {
            routerBound = true;
            if (statusEl) statusEl.textContent = t('router.bind_success');
            setTimeout(() => {
                hideRouterBindUI();
                // bind Router
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
            if (statusEl) statusEl.textContent = 'X ' + (result.message || t('router.bind_error'));
        }
    });

    // Bind button
    document.getElementById('router-bind-btn')?.addEventListener('click', handleRouterBind);
    // Enter
    document.getElementById('router-bind-code')?.addEventListener('keydown', (e) => {
        if ((e as KeyboardEvent).key === 'Enter') handleRouterBind();
    });

    // Save button
    document.getElementById('router-save-btn')?.addEventListener('click', saveRouterConfig);


    // ===== Top-bar QR button =====
    const qrTopWrap = document.getElementById('qr-bind-topbar-wrap');
    const qrTopBtn = document.getElementById('qr-bind-topbar-btn');
    const qrPopup = document.getElementById('qr-bind-popup');
    let routerConnected = false;

    // Always show the button
    if (qrTopWrap) qrTopWrap.style.display = '';

    // Router
    gatewayClient.onRouterStatus((status: any) => {
        console.log('[QR Popup] onRouterStatus fired:', JSON.stringify(status));
        routerConnected = !!status?.connected;
        const popupInitial = document.getElementById('qr-bind-popup-initial');
        const popupSuccess = document.getElementById('qr-bind-popup-success');
        const popupDisplay = document.getElementById('qr-bind-popup-display');
        const popupDesc = document.querySelector('.qr-bind-popup-desc') as HTMLElement | null;
        const popupGenBtn = document.getElementById('qr-bind-popup-generate') as HTMLButtonElement | null;

        if (!routerConnected) {
            // Router
            popupInitial?.classList.remove('hidden');
            popupDisplay?.classList.add('hidden');
            popupSuccess?.classList.add('hidden');
            if (popupDesc) popupDesc.textContent = t('cloud.router_not_configured_desc');
            if (popupGenBtn) { popupGenBtn.disabled = true; popupGenBtn.textContent = t('cloud.router_not_configured_btn'); }
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
            if (popupDesc) popupDesc.textContent = t('cloud.gen_qr_desc');
            if (popupGenBtn) { popupGenBtn.disabled = false; popupGenBtn.textContent = t('cloud.gen_qr_btn'); }
        }
    });

    // Click to toggle the popup
    qrTopBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        qrPopup?.classList.toggle('hidden');
    });

    // Close button
    document.getElementById('qr-bind-popup-close')?.addEventListener('click', () => {
        qrPopup?.classList.add('hidden');
    });

    // Click outside to close
    document.addEventListener('click', (e) => {
        if (qrPopup && !qrPopup.classList.contains('hidden') &&
            !(qrTopWrap?.contains(e.target as Node))) {
            qrPopup.classList.add('hidden');
        }
    });

    // Generate button inside the popup
    let qrPopupTimerId: ReturnType<typeof setInterval> | null = null;

    document.getElementById('qr-bind-popup-generate')?.addEventListener('click', async () => {
        if (!gatewayClient || !routerConnected) return;
        const btn = document.getElementById('qr-bind-popup-generate') as HTMLButtonElement;
        btn.disabled = true;
        btn.textContent = t('cloud.generating_qr');
        try {
            await gatewayClient.routerQRBind();
        } catch {
            btn.disabled = false;
            btn.textContent = t('cloud.gen_qr_btn');
        }
    });

    document.getElementById('qr-bind-popup-refresh')?.addEventListener('click', async () => {
        if (!gatewayClient || !routerConnected) return;
        try { await gatewayClient.routerQRBind(); } catch { /* ignore */ }
    });

    // QR
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
            popupGenBtn.textContent = t('cloud.gen_qr_btn');
            popupHint.textContent = data.message || t('cloud.gen_qr_failed');
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
        popupHint.textContent = t('cloud.scan_hint');
        popupGenBtn.disabled = false;
        popupGenBtn.textContent = t('cloud.gen_qr_btn');

        // Countdown
        if (qrPopupTimerId) clearInterval(qrPopupTimerId);
        let remaining = data.expires_in || 300;
        const tick = () => {
            const m = Math.floor(remaining / 60);
            const s = remaining % 60;
            popupTimer.textContent = `${m}:${s.toString().padStart(2, '0')}`;
            if (remaining <= 0) {
                if (qrPopupTimerId) clearInterval(qrPopupTimerId);
                popupTimer.textContent = t('cloud.qr_expired');
                popupRefresh.style.display = '';
                popupHint.textContent = t('cloud.qr_refresh_hint');
            }
        };
        tick();
        qrPopupTimerId = setInterval(() => { remaining--; tick(); }, 1000);
    });

    // QR
    gatewayClient.onRouterQRBindSuccess((_data) => {
        if (qrPopupTimerId) { clearInterval(qrPopupTimerId); qrPopupTimerId = null; }
        document.getElementById('qr-bind-popup-display')?.classList.add('hidden');
        document.getElementById('qr-bind-popup-initial')?.classList.add('hidden');
        document.getElementById('qr-bind-popup-success')?.classList.remove('hidden');
        console.log('[QR] App bind success');
    });
}

/** Update the managed LLM config UI (only syncs the toggle state) */
function updateManagedLlmUI(): void {
    const toggle = document.getElementById('llm-source-toggle') as HTMLInputElement | null;
    if (!toggle) return;

    // First-time bind event (avoid duplicate binding)
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
                toggle.checked = !toggle.checked; // revert
            }
        });
    }

    // Sync the switch state
    toggle.checked = currentLlmSource === 'managed';
}

// ========================
// (OS
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
            // Non-Tauri environment: just open a new tab
            window.open('/feedback.html', '_blank', 'width=480,height=580');
        }
    });
})();

// ========================
// iLink
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
            statusDot.title = connected ? 'Connected' : 'Not Connected';
        }
        if (connectedInfo) connectedInfo.style.display = connected ? '' : 'none';
        if (loginSection) loginSection.style.display = connected ? 'none' : '';
        if (accountLabel && accountId) accountLabel.textContent = `Account: ${accountId.slice(0, 12)}...`;

        // localStorage,Connect
        if (connected) {
            localStorage.setItem('weixin-connected', '1');
        } else {
            localStorage.removeItem('weixin-connected');
        }
        // Directly update the sidebar toggle (if already rendered)
        const sidebarToggle = document.querySelector<HTMLInputElement>('[data-conn-toggle="conn-weixin"]');
        if (sidebarToggle) sidebarToggle.checked = connected;
    }

    // Connection status change
    gatewayClient.onWeixinStatus((status) => {
        updateWeixinUI(status.connected);
    });

    // QR
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
        if (qrStatus) qrStatus.textContent = t('cloud.wechat_scan_hint');
        if (qrLoginBtn) qrLoginBtn.disabled = true;
    });

    // QR
    gatewayClient.onWeixinQRStatus((data) => {
        if (qrStatus) {
            const icons: Record<string, string> = {
                scanned: '', expired: '', error: '', confirmed: '🎉', timeout: ''
            };
            qrStatus.textContent = `${icons[data.status] || ''} ${data.message}`;
        }
        if (data.status === 'confirmed' || data.status === 'error' || data.status === 'timeout') {
            if (qrLoginBtn) qrLoginBtn.disabled = false;
        }
    });

    // Login succeeded
    gatewayClient.onWeixinLoginSuccess((data) => {
        updateWeixinUI(true, data.accountId);
        if (qrContainer) qrContainer.style.display = 'none';
        if (qrLoginBtn) qrLoginBtn.disabled = false;
        if (saveHint) {
            saveHint.textContent = t('cloud.wechat_connected');
            saveHint.style.color = 'var(--color-success, #52c41a)';
            setTimeout(() => { if (saveHint) saveHint.textContent = ''; }, 3000);
        }
    });

    // QR
    qrLoginBtn?.addEventListener('click', async () => {
        if (!gatewayClient) return;
        qrLoginBtn.disabled = true;
        if (qrStatus) qrStatus.textContent = t('cloud.fetching_qr');
        try {
            await gatewayClient.weixinQRLogin();
        } catch (err) {
            if (qrStatus) qrStatus.textContent = t('cloud.fetch_qr_failed').replace('{0}', String(err));
            qrLoginBtn.disabled = false;
        }
    });

    // Disconnect button
    disconnectBtn?.addEventListener('click', async () => {
        if (!gatewayClient) return;
        await gatewayClient.weixinDisconnect();
        updateWeixinUI(false);
    });

    // DM
    dmPolicySelect?.addEventListener('change', () => {
        if (allowlistSection) {
            allowlistSection.style.display = dmPolicySelect.value === 'allowlist' ? '' : 'none';
        }
    });

    // Save config
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
                saveHint.textContent = result.success ? t('cloud.save_ok') : ('X ' + (result.message || t('cloud.save_failed_short')));
                saveHint.style.color = result.success ? 'var(--color-success, #52c41a)' : 'var(--color-danger, #f5222d)';
                setTimeout(() => { if (saveHint) saveHint.textContent = ''; }, 3000);
            }
        } catch (err) {
            if (saveHint) {
                saveHint.textContent = 'X ' + String(err);
                saveHint.style.color = 'var(--color-danger, #f5222d)';
            }
        }
    });

    // Test connection
    testBtn?.addEventListener('click', async () => {
        if (!gatewayClient) return;
        testBtn.disabled = true;
        testBtn.textContent = t('cloud.testing_connection');
        try {
            const result = await gatewayClient.weixinTest();
            if (saveHint) {
                const msg = result.connected ? 'WeChat Connected' :
                             result.configured ? 'Configured but not connected' : 'Not Configured';
                saveHint.textContent = msg;
                saveHint.style.color = result.connected ? 'var(--color-success, #52c41a)' : 'var(--color-warning, #faad14)';
                setTimeout(() => { if (saveHint) saveHint.textContent = ''; }, 3000);
            }
        } catch (err) {
            if (saveHint) {
                saveHint.textContent = 'X ' + String(err);
                saveHint.style.color = 'var(--color-danger, #f5222d)';
            }
        } finally {
            testBtn.disabled = false;
            testBtn.textContent = t('cloud.test_connection_btn');
        }
    });

    // Initially load the WeChat status
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

// Initialize
init();
// ( UI
setTimeout(() => initVoice(), 1000);
