import { invoke } from '@tauri-apps/api/core';
import { open as tauriDialogOpen, save as tauriDialogSave } from '@tauri-apps/plugin-dialog';
/**
 * Renderer-process entry; chat UI
 * Thin-client mode: connects to the Gateway Server over WebSocket
 */

import { createTypingHole, destroyTypingHole, setTypingMode } from './cosmicHole';
import { GatewayClient, type AgentEventV1, type ProgressEvent as GatewayProgressEvent, type ScheduledTaskView, type TaskRunView, type DebugLogEntry, type McpServerView, type LocalEntityView } from './gateway-client';
import { ActivityViewController } from './chat/activity-view';
import {
    guidanceTextFromActivityItem,
    isSteerMessageRepresentedInActivity,
    shouldRenderUnanchoredTurn,
} from './chat/activity-state';
import { UserMessageNavigator } from './chat/user-message-navigator';
import { setArtifactPanelExpanded } from './chat/artifact-panel-state';
import { hydrateLocalFileLinks } from './chat/local-file-links';
import {
    DEFAULT_APPROVAL_MODE,
    normalizeApprovalMode,
    type ApprovalMode,
} from './chat/approval-mode';
import {
    FollowUpController,
    shouldDisplayFollowUpQueue,
    type ChatAcceptedPayload,
    type ChatDelivery,
    type RuntimeSnapshotPayload,
} from './chat/follow-up-controller';
import { resolveComposerPrimaryAction, shouldSubmitComposerOnKeydown } from './chat/composer-action';
import {
    canAdvancePlanQuestion,
    firstIncompletePlanQuestionIndex,
    isPlanAnswerDraftComplete,
    latestPlanPreview,
    planAnswerDraftToResponse,
    type PlanAnswerDraft,
    type PlanInputRequest,
    type WorkMode,
    type WorkStateSnapshot,
} from './chat/plan-state';
import { applyAgentSessionDisclosure, isAgentDisclosureActionTarget } from './sidebar/agent-disclosure';
import { parseStoredAgentOrder, reorderAgentIds, sortAgentEntities, type AgentDropPlacement } from './sidebar/agent-order';
import { renderMarkdown, activateMermaid } from './markdown';
import { recorder, player, ttsManager, streamingTtsManager, ambientSound, bargeInDetector, type RecordingState, type PlaybackState, type RecordingOptions, type StreamingTTSState } from './voice';
import { setVoiceSynthesizeCallback } from './voice';
import { initI18n, t, tServerCopy, setLocale, getLocale, applyI18nToDOM, type Locale } from './i18n/index';
import { initEvolutionUI } from './evolution-ui';
import { initShareImage } from './share-image';
import { initBrand } from './brand';
import { bindUpdateUi, initUpdateChecker } from './update';
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

// 启动载入动画由独立脚本 public/startup-loader.js 负责（见 index.html），
// 它在模块 bundle 加载前就已开始渲染，覆盖最耗时的启动阶段。此处仅负责收尾。
interface OpenfluxLoaderApi { finale(): void; destroy(): void; }
let overlayDismissed = false;

/** 关闭启动遮罩：播放收尾爆发，淡出并销毁粒子动画（就绪即收，无人工延时）。 */
function dismissStartupOverlay(): void {
    if (overlayDismissed) return;
    overlayDismissed = true;
    const loader = (window as any).__openfluxLoader as OpenfluxLoaderApi | undefined;
    const overlay = document.getElementById('app-loading-overlay');
    try { loader?.finale(); } catch { /* ignore */ }
    if (overlay) {
        overlay.classList.add('fade-out');
        setTimeout(() => overlay.classList.add('hidden'), 600);
    }
    setTimeout(() => { try { loader?.destroy(); } catch { /* ignore */ } }, 650);
    // 交还主题背景色：启动期 html/body 深底（index.html 内联样式）到此为止，
    // 否则浅色主题下深底会从面板拖拽条等透明缝隙透出成黑色竖线
    document.documentElement.classList.remove('app-booting');
}

// Read optional brand/theme config and apply theme color / default language / feature visibility (fall back to the original look if absent)
void initBrand().then(() => {
    void initUpdateChecker();
});

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
    turnId?: string;
    toolCallId?: string;
}

interface Session {
    id: string;
    title: string;
    createdAt: number;
    updatedAt?: number;
    lastMessagePreview?: string;
    cloudChatroomId?: number;
    cloudAgentName?: string;
    approvalMode?: ApprovalMode;
}

// ========================
// Attachment type definition
// ========================

interface PendingAttachment {
    path: string;
    name: string;
    size: number;       // 文件字节数；录制类型时复用为步骤数
    ext: string;        // lowercase extension, e.g. xlsx；录制为 'recording'
    type: 'image' | 'document' | 'text' | 'recording';
    thumbnailUrl?: string;  // image thumbnail URL (generated via URL.createObjectURL)
    recordingId?: string;   // type==='recording' 时的录制 ID
    startUrl?: string;      // type==='recording' 时的起始页
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
    '.doc': 'document', '.docx': 'document',
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
const activityView = new ActivityViewController(messagesContainer);
const userMessageRail = document.getElementById('user-message-rail') as HTMLElement;
const userMessageNavigator = new UserMessageNavigator(messagesContainer, userMessageRail, {
    onNavigate: () => pauseConversationAutoFollow(),
});
window.addEventListener('beforeunload', () => userMessageNavigator.destroy(), { once: true });

// Session list related
const SESSION_PAGE_SIZE = 20; // number of items to load each time
const sessionMsgOffset = new Map<string, number>(); // loaded offset per sessionId (counting back from the end)
const sessionMsgHasMore = new Map<string, boolean>(); // whether the sessionId has more messages
let isLoadingMoreMessages = false; // prevent duplicate triggering
const sessionList = document.getElementById('session-list') as HTMLDivElement;
const newSessionBtn = document.getElementById('new-session-btn') as HTMLButtonElement;
const statusIndicator = document.getElementById('status-indicator') as HTMLDivElement;
const attachmentPreview = document.getElementById('attachment-preview') as HTMLDivElement;
const inputContainer = document.querySelector('.input-container') as HTMLDivElement;
const followUpQueue = document.getElementById('follow-up-queue') as HTMLDivElement;
const approvalModeControl = document.getElementById('approval-mode-control') as HTMLDivElement;
const approvalModeTrigger = document.getElementById('approval-mode-trigger') as HTMLButtonElement;
const approvalModeLabel = document.getElementById('approval-mode-label') as HTMLSpanElement;
const approvalModeMenu = document.getElementById('approval-mode-menu') as HTMLDivElement;
const approvalModeOptions = Array.from(
    document.querySelectorAll<HTMLButtonElement>('.approval-mode-option[data-approval-mode]'),
);
const workModeSelect = document.getElementById('work-mode-select') as HTMLSelectElement;
const planInteraction = document.getElementById('plan-interaction') as HTMLElement;
const inputRow = document.querySelector('.input-row') as HTMLDivElement;

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

// Image generation model DOM
const serverImageProvider = document.getElementById('server-image-provider') as HTMLSelectElement | null;
const serverImageModel = document.getElementById('server-image-model') as HTMLSelectElement | null;
const serverImageApiKey = document.getElementById('server-image-apikey') as HTMLInputElement | null;
const serverImageSize = document.getElementById('server-image-size') as HTMLSelectElement | null;

// Fixed image model/size options per provider (model name / base URL / size are not free-typed).
// OpenAI sizes follow the Images API; Gemini sizes map to aspect ratios on the gateway side.
const IMAGE_MODEL_OPTIONS: Record<string, { value: string; label: string }[]> = {
    openai: [
        { value: 'gpt-image-2', label: 'gpt-image-2' },
        { value: 'gpt-image-1.5', label: 'gpt-image-1.5' },
        { value: 'gpt-image-1', label: 'gpt-image-1' },
        { value: 'gpt-image-1-mini', label: 'gpt-image-1-mini' },
    ],
    gemini: [
        { value: 'gemini-2.5-flash-image', label: 'Nano Banana (gemini-2.5-flash-image)' },
        { value: 'gemini-3.1-flash-image', label: 'Nano Banana 2 (gemini-3.1-flash-image)' },
        { value: 'gemini-3-pro-image', label: 'Nano Banana Pro (gemini-3-pro-image)' },
    ],
};

const IMAGE_SIZE_OPTIONS: Record<string, { value: string; label: string }[]> = {
    openai: [
        { value: 'auto', label: 'auto' },
        { value: '1024x1024', label: '1024x1024' },
        { value: '1536x1024', label: '1536x1024' },
        { value: '1024x1536', label: '1024x1536' },
    ],
    // For Gemini the value is an aspect ratio used by the image config.
    gemini: [
        { value: 'auto', label: 'auto' },
        { value: '1:1', label: '1:1' },
        { value: '16:9', label: '16:9' },
        { value: '9:16', label: '9:16' },
        { value: '4:3', label: '4:3' },
        { value: '3:4', label: '3:4' },
    ],
};

/** Fill the image model/size selects for the given provider, keeping a preferred value if valid. */
function populateImageOptions(provider: string, preferModel?: string, preferSize?: string): void {
    const p = provider === 'gemini' ? 'gemini' : 'openai';
    if (serverImageModel) {
        const models = IMAGE_MODEL_OPTIONS[p] || [];
        serverImageModel.innerHTML = models
            .map((o) => `<option value="${o.value}">${o.label}</option>`)
            .join('');
        if (preferModel && models.some((o) => o.value === preferModel)) {
            serverImageModel.value = preferModel;
        }
    }
    if (serverImageSize) {
        const sizes = IMAGE_SIZE_OPTIONS[p] || [];
        serverImageSize.innerHTML = sizes
            .map((o) => `<option value="${o.value}">${o.label}</option>`)
            .join('');
        if (preferSize && sizes.some((o) => o.value === preferSize)) {
            serverImageSize.value = preferSize;
        }
    }
}

// Repopulate model/size options when switching provider.
serverImageProvider?.addEventListener('change', () => {
    populateImageOptions(serverImageProvider.value);
});

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
const schedulerWaitingBadge = document.getElementById('scheduler-waiting-badge') as HTMLSpanElement;
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
// Guards asynchronous history loads from repainting a session that is no
// longer active. The revision also handles A -> B -> A races where comparing
// currentSessionId alone would accept an older A response.
let sessionViewRevision = 0;
let currentAgentId: string | null = null; // Agent support: the currently selected Agent ID
let agentsList: LocalEntityView[] = [];
// ── 单 Agent 多会话 ──
let agentSessionsList: Session[] = []; // 当前选中 Agent 名下的会话列表（侧栏二级列表）
const agentSessionsMap = new Map<string, Session[]>(); // agentId -> 会话列表（所有 Agent 的子列表默认展开）
const agentActiveSessionMap = new Map<string, string>(); // agentId -> 最近激活的 sessionId（切回 Agent 时恢复）
const sessionAgentMap = new Map<string, string>(); // sessionId -> agentId（用于把后台会话的角标/未读点聚合到 Agent 卡片）

/** 登记会话归属，供角标/未读点在 Agent 卡片上聚合显示 */
function registerSessionAgent(sessions: Array<{ id: string }>, agentId: string): void {
    for (const s of sessions) sessionAgentMap.set(s.id, agentId);
}
const loadingSessions = new Set<string>(); // sessions currently loading (supports concurrent multi-session)
const chatTargetSessionIds = new Set<string>(); // set of in-progress chat sessions (used to isolate progress events)
const userStoppedSessions = new Set<string>(); // 用户手动停止的会话：用于抑制停止后残留的进度事件（避免弹出空的执行卡片）
const unreadSessionIds = new Set<string>(); // sessions with unread messages (marked when a reply arrives in the background)
const sessionToChatroomMap = new Map<string, number>(); // sessionId -> chatroomId mapping (used to locate unread markers)
type SessionRuntimeStatus = 'idle' | 'running' | 'waiting_input' | 'awaiting_plan_approval' | 'completed' | 'error' | 'stopped';
interface SessionRuntimeState {
    state: SessionRuntimeStatus;
    label: string;
    updatedAt: number;
    lastError?: string;
}
const sessionRuntimeStates = new Map<string, SessionRuntimeState>(); // Frontend-only transient runtime state.
const followUpController = new FollowUpController();
// Publicly named projections used by every event/finalizer fence in this module.
const activeTurnBySession = followUpController.activeTurnBySession;
const queueStateBySession = followUpController.queueStateBySession;
let lastRuntimeSnapshotSessionId: string | null = null;
const runtimeSnapshotRequests = new Map<string, Promise<void>>();

interface PendingFollowUpSubmission {
    sessionId: string;
    delivery: ChatDelivery;
    displayContent: string;
    attachments?: MessageAttachment[];
    rendered: boolean;
}

const pendingFollowUpSubmissions = new Map<string, PendingFollowUpSubmission>();
const renderedFollowUpSubmissionIds = new Set<string>();

function rememberRenderedSubmission(submissionId: string): void {
    renderedFollowUpSubmissionIds.add(submissionId);
    if (renderedFollowUpSubmissionIds.size <= 512) return;
    const oldest = renderedFollowUpSubmissionIds.values().next().value as string | undefined;
    if (oldest) renderedFollowUpSubmissionIds.delete(oldest);
}
let pendingAttachments: PendingAttachment[] = [];
const sessionDrafts = new Map<string, string>(); // save input-box drafts per session
const sessionApprovalModes = new Map<string, ApprovalMode>();
let newSessionApprovalMode: ApprovalMode = DEFAULT_APPROVAL_MODE;
const workStateBySession = new Map<string, WorkStateSnapshot>();
const planAnswerDrafts = new Map<string, PlanAnswerDraft>();
const planQuestionPositions = new Map<string, number>();
const planSuspendedDrafts = new Map<string, string>();
type PlanApprovalChoice = 'execute' | 'revise' | 'save';
const planApprovalDrafts = new Map<string, { choice?: PlanApprovalChoice; instruction: string }>();
let newSessionWorkMode: WorkMode = 'normal';

function isSessionFollowUpRunning(sessionId: string | null | undefined): boolean {
    if (!sessionId) return false;
    const runtime = sessionRuntimeStates.get(sessionId);
    return activeTurnBySession.has(sessionId)
        || loadingSessions.has(sessionId)
        || runtime?.state === 'running';
}

function getRequestedDelivery(): ChatDelivery {
    // A send made while this session is running becomes the next queued task;
    // otherwise it starts a new turn immediately.
    return isSessionFollowUpRunning(currentSessionId) ? 'queue' : 'new';
}

const APPROVAL_MODE_LABEL_KEYS: Record<ApprovalMode, string> = {
    ask: 'approval.ask.title',
    risk_based: 'approval.risk_based.title',
    full_access: 'approval.full_access.title',
};

function rememberSessionApprovalModes(sessions: Array<{ id: string; approvalMode?: unknown }>): void {
    for (const session of sessions) {
        sessionApprovalModes.set(session.id, normalizeApprovalMode(session.approvalMode));
    }
}

function getSessionApprovalMode(sessionId: string | null | undefined): ApprovalMode {
    return sessionId
        ? normalizeApprovalMode(sessionApprovalModes.get(sessionId), DEFAULT_APPROVAL_MODE)
        : newSessionApprovalMode;
}

function getCurrentApprovalMode(): ApprovalMode {
    return getSessionApprovalMode(currentSessionId);
}

function setApprovalModeMenuOpen(open: boolean, focusSelected = false): void {
    if (approvalModeTrigger.disabled) open = false;
    approvalModeMenu.hidden = !open;
    approvalModeTrigger.setAttribute('aria-expanded', String(open));
    if (open && focusSelected) {
        approvalModeOptions.find(option => option.getAttribute('aria-selected') === 'true')?.focus();
    }
}

function syncApprovalModeUi(): void {
    const mode = getCurrentApprovalMode();
    approvalModeLabel.textContent = t(APPROVAL_MODE_LABEL_KEYS[mode]);
    approvalModeLabel.dataset.i18n = APPROVAL_MODE_LABEL_KEYS[mode];
    approvalModeTrigger.classList.toggle('is-full-access', mode === 'full_access');
    approvalModeOptions.forEach(option => {
        option.setAttribute('aria-selected', String(option.dataset.approvalMode === mode));
    });

    const running = isSessionFollowUpRunning(currentSessionId);
    const localSession = !currentCloudChatroomId && !document.body.classList.contains('router-active');
    approvalModeTrigger.disabled = running || !localSession;
    approvalModeTrigger.title = running
        ? t('approval.running_hint')
        : !localSession
            ? t('approval.local_only_hint')
            : t(APPROVAL_MODE_LABEL_KEYS[mode]);
    if (approvalModeTrigger.disabled) setApprovalModeMenuOpen(false);
}

async function selectApprovalMode(mode: ApprovalMode): Promise<void> {
    const previousMode = getCurrentApprovalMode();
    if (mode === previousMode) return;

    newSessionApprovalMode = mode;
    if (!currentSessionId) {
        syncApprovalModeUi();
        return;
    }

    const sessionId = currentSessionId;
    sessionApprovalModes.set(sessionId, mode);
    syncApprovalModeUi();
    try {
        if (!gatewayClient) throw new Error('Gateway not connected');
        const persistedMode = await gatewayClient.setSessionApprovalMode(sessionId, mode);
        sessionApprovalModes.set(sessionId, normalizeApprovalMode(persistedMode));
    } catch (error) {
        sessionApprovalModes.set(sessionId, previousMode);
        newSessionApprovalMode = previousMode;
        console.error('[ApprovalMode] Failed to persist session preference:', error);
        setStatus(t('approval.update_failed'), 'error');
    } finally {
        if (currentSessionId === sessionId) syncApprovalModeUi();
    }
}

approvalModeTrigger.addEventListener('click', (event) => {
    event.stopPropagation();
    setApprovalModeMenuOpen(approvalModeMenu.hidden);
});

approvalModeTrigger.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    setApprovalModeMenuOpen(true, true);
});

approvalModeOptions.forEach(option => {
    option.addEventListener('click', (event) => {
        const mode = normalizeApprovalMode(option.dataset.approvalMode);
        setApprovalModeMenuOpen(false);
        if (event.detail === 0) approvalModeTrigger.focus();
        else messageInput.focus();
        void selectApprovalMode(mode);
    });
});

approvalModeMenu.addEventListener('keydown', (event) => {
    const currentIndex = approvalModeOptions.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
        event.preventDefault();
        setApprovalModeMenuOpen(false);
        approvalModeTrigger.focus();
        return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const next = (Math.max(0, currentIndex) + delta + approvalModeOptions.length) % approvalModeOptions.length;
    approvalModeOptions[next]?.focus();
});

document.addEventListener('click', (event) => {
    if (!approvalModeControl.contains(event.target as Node)) setApprovalModeMenuOpen(false);
});

function getCurrentWorkState(): WorkStateSnapshot | undefined {
    return currentSessionId ? workStateBySession.get(currentSessionId) : undefined;
}

function getCurrentWorkMode(): WorkMode {
    return getCurrentWorkState()?.mode || newSessionWorkMode;
}

function planPreviewMessage(state: WorkStateSnapshot | undefined): Message | undefined {
    const preview = latestPlanPreview(state);
    if (!preview) return undefined;
    return {
        id: preview.id,
        role: 'assistant',
        content: preview.markdown,
        createdAt: preview.createdAt,
        metadata: {
            kind: 'plan_document_preview',
            planDocumentPreview: true,
            planId: preview.planId,
            planRevision: preview.revision,
            planFilePath: preview.filePath,
        },
    };
}

function mergeLatestPlanPreview(messages: Message[], state: WorkStateSnapshot | undefined): Message[] {
    const withoutPlanPreviews = messages.filter(message => (
        message.metadata?.planDocumentPreview !== true
        && message.metadata?.kind !== 'plan_document_preview'
    ));
    const preview = planPreviewMessage(state);
    if (!preview) return withoutPlanPreviews;
    return [...withoutPlanPreviews, preview]
        .sort((left, right) => left.createdAt - right.createdAt);
}

function renderLatestPlanPreviewInChat(state: WorkStateSnapshot): void {
    messagesContainer.querySelectorAll('.plan-document-preview').forEach(element => element.remove());
    const preview = planPreviewMessage(state);
    if (!preview) return;
    removeMessagePlaceholderStates();
    messagesContainer.insertAdjacentHTML('beforeend', renderMessage(preview));
    scrollToBottom();
}

function syncWorkModeUi(): void {
    const state = getCurrentWorkState();
    const localSession = !currentCloudChatroomId && !document.body.classList.contains('router-active');
    workModeSelect.value = localSession ? (state?.mode || newSessionWorkMode) : 'normal';
    const blockedByPlanInteraction = state?.plan?.status === 'waiting_input' || state?.plan?.status === 'awaiting_approval';
    workModeSelect.disabled = !localSession || blockedByPlanInteraction;
    workModeSelect.title = localSession ? t('plan.mode_title') : t('plan.local_only');
}

function restoreSuspendedPlanDraft(sessionId: string): void {
    const suspended = planSuspendedDrafts.get(sessionId);
    if (suspended === undefined) return;
    planSuspendedDrafts.delete(sessionId);
    if (!messageInput.value) messageInput.value = suspended;
    autoResize();
}

function setPlanInteractionActive(sessionId: string, active: boolean): void {
    if (active) {
        if (!planSuspendedDrafts.has(sessionId)) planSuspendedDrafts.set(sessionId, messageInput.value);
        messageInput.value = '';
        inputRow.classList.add('plan-interaction-active');
        hideTyping();
    } else {
        inputRow.classList.remove('plan-interaction-active');
        restoreSuspendedPlanDraft(sessionId);
    }
}

function createPlanOptionLabel(
    input: HTMLInputElement,
    labelText: string,
    descriptionText: string,
    recommended = false,
): HTMLLabelElement {
    const label = document.createElement('label');
    label.className = 'plan-option';
    const copy = document.createElement('span');
    copy.className = 'plan-option-copy';
    const optionTitle = document.createElement('strong');
    optionTitle.textContent = labelText;
    const description = document.createElement('small');
    description.textContent = descriptionText;
    copy.append(optionTitle, description);
    label.append(input, copy);
    if (recommended) {
        const badge = document.createElement('span');
        badge.className = 'plan-option-recommended';
        badge.textContent = t('plan.recommended');
        label.appendChild(badge);
    }
    return label;
}

function renderPlanQuestions(sessionId: string, request: PlanInputRequest): void {
    planInteraction.replaceChildren();
    const draftKey = `${sessionId}:${request.id}`;
    const draft = planAnswerDrafts.get(draftKey) || {};
    planAnswerDrafts.set(draftKey, draft);
    const fallbackIndex = firstIncompletePlanQuestionIndex(request, draft);
    const questionIndex = Math.max(0, Math.min(
        planQuestionPositions.get(draftKey) ?? fallbackIndex,
        request.questions.length - 1,
    ));
    planQuestionPositions.set(draftKey, questionIndex);
    const question = request.questions[questionIndex];
    if (!question) return;

    const header = document.createElement('div');
    header.className = 'plan-interaction-header';
    const title = document.createElement('strong');
    title.textContent = t('plan.confirm_options');
    const hint = document.createElement('span');
    hint.textContent = t('plan.question_progress', questionIndex + 1, request.questions.length);
    header.append(title, hint);
    planInteraction.appendChild(header);

    const section = document.createElement('fieldset');
    section.className = 'plan-question';
    const legend = document.createElement('legend');
    legend.className = 'plan-question-title';
    legend.textContent = question.prompt;
    if (question.required !== false) {
        const required = document.createElement('span');
        required.className = 'plan-question-required';
        required.textContent = t('plan.required');
        legend.appendChild(required);
    }
    section.appendChild(legend);
    const options = document.createElement('div');
    options.className = 'plan-option-list';
    if (question.kind === 'single') options.setAttribute('role', 'radiogroup');

    let forwardButton: HTMLButtonElement;
    let advanceTimer: number | undefined;
    const updateForward = () => {
        if (!forwardButton) return;
        forwardButton.disabled = questionIndex === request.questions.length - 1
            ? !isPlanAnswerDraftComplete(request, draft)
            : !canAdvancePlanQuestion(question, draft);
    };
    const goToQuestion = (index: number) => {
        if (advanceTimer !== undefined) window.clearTimeout(advanceTimer);
        planQuestionPositions.set(draftKey, index);
        renderPlanQuestions(sessionId, request);
    };

    question.options.forEach(option => {
        const input = document.createElement('input');
        input.type = question.kind === 'single' ? 'radio' : 'checkbox';
        input.name = `plan-${request.id}-${question.id}`;
        input.value = option.id;
        input.checked = Boolean(draft[question.id]?.optionIds.includes(option.id));
        input.addEventListener('change', () => {
            const current = draft[question.id] || { optionIds: [] };
            if (question.kind === 'single') {
                current.optionIds = [option.id];
                current.other = '';
                const otherInput = section.querySelector<HTMLInputElement>('.plan-other-input');
                if (otherInput) otherInput.value = '';
            } else {
                current.optionIds = input.checked
                    ? [...new Set([...current.optionIds, option.id])]
                    : current.optionIds.filter(id => id !== option.id);
            }
            draft[question.id] = current;
            updateForward();
            if (question.kind === 'single' && questionIndex < request.questions.length - 1) {
                advanceTimer = window.setTimeout(() => goToQuestion(questionIndex + 1), 160);
            }
        });
        options.appendChild(createPlanOptionLabel(input, option.label, option.description, option.recommended));
    });
    section.appendChild(options);
    if (question.allowOther !== false) {
        const other = document.createElement('input');
        other.className = 'plan-other-input';
        other.type = 'text';
        other.placeholder = t('plan.other_placeholder');
        other.setAttribute('aria-label', t('plan.other_aria', question.prompt));
        other.value = draft[question.id]?.other || '';
        other.addEventListener('input', () => {
            const current = draft[question.id] || { optionIds: [] };
            current.other = other.value;
            if (question.kind === 'single' && other.value.trim()) {
                current.optionIds = [];
                section.querySelectorAll<HTMLInputElement>('input[type="radio"]').forEach(input => { input.checked = false; });
            }
            draft[question.id] = current;
            updateForward();
        });
        section.appendChild(other);
    }
    planInteraction.appendChild(section);

    const actions = document.createElement('div');
    actions.className = 'plan-interaction-actions';
    if (questionIndex > 0) {
        const backButton = document.createElement('button');
        backButton.type = 'button';
        backButton.className = 'plan-action-btn';
        backButton.textContent = t('plan.previous_question');
        backButton.addEventListener('click', () => goToQuestion(questionIndex - 1));
        actions.appendChild(backButton);
    }
    forwardButton = document.createElement('button');
    forwardButton.type = 'button';
    forwardButton.className = 'plan-action-btn primary';
    const isLastQuestion = questionIndex === request.questions.length - 1;
    forwardButton.textContent = isLastQuestion ? t('plan.submit_all') : t('plan.next_question');
    updateForward();
    forwardButton.addEventListener('click', async () => {
        if (!isLastQuestion) {
            goToQuestion(questionIndex + 1);
            return;
        }
        const state = workStateBySession.get(sessionId);
        if (!gatewayClient || !state?.plan || currentSessionId !== sessionId) return;
        forwardButton.disabled = true;
        try {
            const result = await gatewayClient.resolvePlanInput(
                sessionId,
                state.plan.id,
                request.id,
                planAnswerDraftToResponse(request, draft),
            );
            planAnswerDrafts.delete(draftKey);
            planQuestionPositions.delete(draftKey);
            applyWorkState(result.state);
            setSessionRuntimeState(sessionId, 'running', { label: t('plan.continuing') });
        } catch (error) {
            setStatus(userFacingErrorMessage(error), 'error');
            updateForward();
        }
    });
    actions.appendChild(forwardButton);
    planInteraction.appendChild(actions);
    queueMicrotask(() => {
        const focusTarget = planInteraction.querySelector<HTMLInputElement>('input:checked')
            || planInteraction.querySelector<HTMLInputElement>('input[type="radio"], input[type="checkbox"], .plan-other-input');
        focusTarget?.focus();
    });
}

function renderPlanApproval(sessionId: string, state: WorkStateSnapshot): void {
    planInteraction.replaceChildren();
    if (!state.plan) return;
    const approvalKey = `${sessionId}:${state.plan.id}:${state.plan.revision}`;
    const draft = planApprovalDrafts.get(approvalKey) || { instruction: '' };
    planApprovalDrafts.set(approvalKey, draft);
    const header = document.createElement('div');
    header.className = 'plan-interaction-header';
    const title = document.createElement('strong');
    title.textContent = t('plan.approval_ready', state.plan.revision);
    const hint = document.createElement('span');
    hint.textContent = t('plan.execution_confirmation');
    header.append(title, hint);

    const section = document.createElement('fieldset');
    section.className = 'plan-question plan-approval-question';
    const legend = document.createElement('legend');
    legend.className = 'plan-question-title';
    legend.textContent = t('plan.execute_question');
    const required = document.createElement('span');
    required.className = 'plan-question-required';
    required.textContent = t('plan.required');
    legend.appendChild(required);
    section.appendChild(legend);
    const options = document.createElement('div');
    options.className = 'plan-option-list';
    options.setAttribute('role', 'radiogroup');
    const revisionInput = document.createElement('textarea');
    revisionInput.className = 'plan-revision-input';
    revisionInput.rows = 2;
    revisionInput.placeholder = t('plan.revision_placeholder');
    revisionInput.value = draft.instruction;
    const approvalOptions: Array<{ id: PlanApprovalChoice; label: string; description: string; recommended?: boolean }> = [
        { id: 'execute', label: t('plan.execute_now'), description: t('plan.execute_now_desc'), recommended: true },
        { id: 'revise', label: t('plan.revise'), description: t('plan.revise_desc') },
        { id: 'save', label: t('plan.save_for_later'), description: t('plan.save_for_later_desc') },
    ];
    const inputs: HTMLInputElement[] = [];
    const actions = document.createElement('div');
    actions.className = 'plan-interaction-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'plan-action-btn';
    cancel.textContent = t('plan.cancel');
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'plan-action-btn primary';
    const updateApproval = () => {
        revisionInput.classList.toggle('hidden', draft.choice !== 'revise');
        confirm.textContent = draft.choice === 'execute'
            ? t('plan.start_execution')
            : draft.choice === 'revise'
                ? t('plan.submit_revision')
                : draft.choice === 'save'
                    ? t('plan.save_only')
                    : t('plan.confirm_selection');
        confirm.disabled = !draft.choice || (draft.choice === 'revise' && !draft.instruction.trim());
    };
    approvalOptions.forEach(option => {
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = `plan-approval-${state.plan!.id}-${state.plan!.revision}`;
        input.value = option.id;
        input.checked = draft.choice === option.id;
        input.addEventListener('change', () => {
            draft.choice = option.id;
            updateApproval();
            if (option.id === 'revise') queueMicrotask(() => revisionInput.focus());
        });
        inputs.push(input);
        options.appendChild(createPlanOptionLabel(input, option.label, option.description, option.recommended));
    });
    revisionInput.addEventListener('input', () => {
        draft.instruction = revisionInput.value;
        updateApproval();
    });
    section.append(options, revisionInput);
    actions.append(cancel, confirm);
    const setBusy = (busy: boolean) => {
        [...inputs, revisionInput, cancel, confirm].forEach(control => { control.disabled = busy; });
    };
    confirm.addEventListener('click', async () => {
        if (!gatewayClient || !draft.choice) return;
        setBusy(true);
        try {
            if (draft.choice === 'execute') {
                const result = await gatewayClient.approvePlan(sessionId, state.plan!.id, state.plan!.revision);
                planApprovalDrafts.delete(approvalKey);
                applyWorkState(result.state);
                setSessionRuntimeState(sessionId, 'running', { label: t('plan.executing_approved') });
            } else if (draft.choice === 'revise') {
                const result = await gatewayClient.revisePlan(sessionId, state.plan!.id, draft.instruction.trim());
                planApprovalDrafts.delete(approvalKey);
                applyWorkState(result.state);
                setSessionRuntimeState(sessionId, 'running', { label: t('plan.revising') });
            } else {
                planApprovalDrafts.delete(approvalKey);
                applyWorkState(await gatewayClient.savePlan(sessionId, state.plan!.id));
            }
        } catch (error) {
            setStatus(userFacingErrorMessage(error), 'error');
            setBusy(false);
            updateApproval();
        }
    });
    cancel.addEventListener('click', async () => {
        if (!gatewayClient) return;
        setBusy(true);
        try {
            planApprovalDrafts.delete(approvalKey);
            applyWorkState(await gatewayClient.cancelPlan(sessionId, state.plan!.id));
        } catch (error) {
            setStatus(userFacingErrorMessage(error), 'error');
            setBusy(false);
            updateApproval();
        }
    });
    updateApproval();
    planInteraction.append(header, section, actions);
    queueMicrotask(() => {
        const checked = options.querySelector<HTMLInputElement>('input:checked');
        (checked || inputs[0])?.focus();
    });
}

function applyWorkState(state: WorkStateSnapshot): void {
    workStateBySession.set(state.sessionId, state);
    if (currentSessionId !== state.sessionId) return;
    newSessionWorkMode = state.mode;
    const status = state.plan?.status;
    const interacting = status === 'waiting_input' || status === 'awaiting_approval';
    setPlanInteractionActive(state.sessionId, interacting);
    planInteraction.classList.toggle('hidden', !interacting);
    if (status === 'waiting_input' && state.pendingInput) {
        renderPlanQuestions(state.sessionId, state.pendingInput);
        setSessionRuntimeState(state.sessionId, 'waiting_input', { label: t('plan.waiting_choice') });
    } else if (status === 'awaiting_approval' && state.plan) {
        renderPlanApproval(state.sessionId, state);
        setSessionRuntimeState(state.sessionId, 'awaiting_plan_approval', { label: t('plan.waiting_approval') });
    } else if (!interacting) {
        planInteraction.replaceChildren();
        if ((status === 'approved' || status === 'executing')
            && (activeTurnBySession.has(state.sessionId) || loadingSessions.has(state.sessionId))) {
            setSessionRuntimeState(state.sessionId, 'running', { label: t('plan.executing_approved') });
        }
        else if (status === 'completed') setSessionRuntimeState(state.sessionId, 'completed');
        else if (status === 'saved' || status === 'cancelled') setSessionRuntimeState(state.sessionId, 'idle');
    }
    if (status === 'awaiting_approval') {
        // The canonical plan file, not provisional model prose, owns the chat
        // preview shown directly before the execution decision.
        finishStreamingMessage('', false);
        renderLatestPlanPreviewInChat(state);
    }
    syncWorkModeUi();
    updateSendButtonState();
}

function handleWorkStateGatewayMessage(message: { type?: string; payload?: unknown }): void {
    if (message.type !== 'work.state.updated' || !message.payload || typeof message.payload !== 'object') return;
    const state = message.payload as WorkStateSnapshot;
    if (!state.sessionId || (state.mode !== 'normal' && state.mode !== 'plan')) return;
    applyWorkState(state);
}

async function selectWorkMode(mode: WorkMode): Promise<void> {
    if (mode === getCurrentWorkMode()) return;
    if (currentCloudChatroomId || document.body.classList.contains('router-active')) {
        workModeSelect.value = 'normal';
        return;
    }
    if (!currentSessionId) {
        newSessionWorkMode = mode;
        syncWorkModeUi();
        return;
    }
    const sessionId = currentSessionId;
    try {
        if (!gatewayClient) throw new Error(t('app.gateway_not_connected'));
        applyWorkState(await gatewayClient.setWorkMode(sessionId, mode));
    } catch (error) {
        console.error('[WorkMode] Failed to update:', error);
        syncWorkModeUi();
        setStatus(userFacingErrorMessage(error), 'error');
    }
}

workModeSelect.addEventListener('change', () => void selectWorkMode(workModeSelect.value === 'plan' ? 'plan' : 'normal'));

/** Send icon SVG */
const SEND_ICON_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" /></svg>';
const STOP_ICON_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2" /></svg>';

function updateSendButtonState(): void {
    const currentRunning = isSessionFollowUpRunning(currentSessionId);
    const cloudBlocked = !!currentCloudChatroomId && !openfluxLoggedIn;
    const hasComposerPayload = messageInput.value.trim().length > 0 || pendingAttachments.length > 0;
    const primaryAction = resolveComposerPrimaryAction({
        running: currentRunning,
        hasPayload: hasComposerPayload,
        sendBlocked: cloudBlocked,
    });

    sendBtn.classList.remove('is-stop');
    if (primaryAction === 'stop') {
        sendBtn.classList.add('is-stop');
        sendBtn.innerHTML = STOP_ICON_SVG;
        sendBtn.title = t('chat.stop');
        sendBtn.setAttribute('aria-label', t('chat.stop'));
        sendBtn.disabled = false;
    } else {
        sendBtn.innerHTML = SEND_ICON_SVG;
        sendBtn.title = currentRunning ? t('follow_up.send_queue') : t('chat.send');
        sendBtn.setAttribute('aria-label', sendBtn.title);
        sendBtn.disabled = primaryAction === 'disabled';
    }
    syncApprovalModeUi();
    renderFollowUpQueue();
}

function renderFollowUpQueue(): void {
    const sessionId = currentSessionId;
    const state = sessionId ? queueStateBySession.get(sessionId) : undefined;
    if (!sessionId || !shouldDisplayFollowUpQueue(state)) {
        followUpQueue.classList.add('hidden');
        followUpQueue.replaceChildren();
        return;
    }

    const hasMultipleItems = state.items.length > 1;
    const rows = state.items.map((item, index) => `
        <div class="follow-up-queue-row" data-queue-item-id="${escapeHtml(item.id)}">
            <span class="follow-up-queue-leading" aria-hidden="true">↳</span>
            <input class="follow-up-queue-input" value="${escapeHtml(item.input)}"
                data-queue-input="${escapeHtml(item.id)}" aria-label="${escapeHtml(t('follow_up.queue_title'))}" />
            ${hasMultipleItems ? `<button class="follow-up-queue-action is-order" type="button" data-queue-action="up"
                title="${escapeHtml(t('follow_up.queue_move_up'))}" ${index === 0 ? 'disabled' : ''}>↑</button>` : ''}
            ${hasMultipleItems ? `<button class="follow-up-queue-action is-order" type="button" data-queue-action="down"
                title="${escapeHtml(t('follow_up.queue_move_down'))}" ${index === state.items.length - 1 ? 'disabled' : ''}>↓</button>` : ''}
            <button class="follow-up-queue-action is-primary has-label" type="button" data-queue-action="send-now"
                title="${escapeHtml(t('follow_up.queue_send_now'))}">
                <span aria-hidden="true">↪</span><span>${escapeHtml(t('follow_up.queue_send_now'))}</span>
            </button>
            <button class="follow-up-queue-action is-danger" type="button" data-queue-action="delete"
                aria-label="${escapeHtml(t('follow_up.queue_delete'))}" title="${escapeHtml(t('follow_up.queue_delete'))}">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
                    <path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M7 7l1 13h8l1-13"/><path d="M10 11v5M14 11v5"/>
                </svg>
            </button>
        </div>
    `).join('');

    followUpQueue.innerHTML = `
        <div class="follow-up-queue-header">
            <span class="follow-up-queue-title">${escapeHtml(t('follow_up.queue_title'))}</span>
            <span class="follow-up-queue-count">${state.items.length}</span>
            ${state.paused ? `<span class="follow-up-queue-paused">${escapeHtml(t('follow_up.queue_paused'))}</span>` : ''}
            <span class="follow-up-queue-spacer"></span>
            ${state.paused ? `<button class="follow-up-queue-action is-primary" type="button" data-queue-action="resume">${escapeHtml(t('follow_up.queue_resume'))}</button>` : ''}
            ${state.items.length > 1 ? `<button class="follow-up-queue-action is-danger" type="button" data-queue-action="clear">${escapeHtml(t('follow_up.queue_clear'))}</button>` : ''}
        </div>
        ${rows}
    `;
    followUpQueue.classList.remove('hidden');
}

function normalizeRuntimeSnapshot(sessionId: string, value: unknown): RuntimeSnapshotPayload {
    const root = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const runtime = root.runtime && typeof root.runtime === 'object'
        ? root.runtime as Record<string, unknown>
        : root;
    return {
        sessionId: typeof runtime.sessionId === 'string' ? runtime.sessionId : sessionId,
        activeTurn: Object.prototype.hasOwnProperty.call(runtime, 'activeTurn')
            ? runtime.activeTurn
            : null,
        queue: runtime.queue,
    };
}

async function refreshFollowUpRuntime(sessionId: string, force = false): Promise<void> {
    if (!gatewayClient || !sessionId) return;
    const existing = runtimeSnapshotRequests.get(sessionId);
    if (existing && !force) return existing;

    const requestedAt = Date.now();
    const request = gatewayClient.getChatRuntime(sessionId)
        .then(snapshot => {
            const normalized = normalizeRuntimeSnapshot(sessionId, snapshot);
            const currentActive = activeTurnBySession.get(sessionId);
            // A snapshot issued before a new optimistic run cannot clear or
            // replace that newer run when its response arrives late.
            if (currentActive && currentActive.startedAt >= requestedAt) {
                normalized.activeTurn = currentActive;
            }
            followUpController.applyRuntimeSnapshot(normalized);
            if (activeTurnBySession.has(sessionId)) {
                loadingSessions.add(sessionId);
                setSessionRuntimeState(sessionId, 'running', { label: t('chat.thinking') });
            } else {
                // Runtime snapshots are authoritative after reconnect/restart.
                // Clear optimistic or plan-derived running state when Gateway
                // confirms that no turn is actually active.
                loadingSessions.delete(sessionId);
                chatTargetSessionIds.delete(sessionId);
                if (sessionRuntimeStates.get(sessionId)?.state === 'running') {
                    setSessionRuntimeState(sessionId, 'idle');
                }
            }
            if (currentSessionId === sessionId) {
                renderFollowUpQueue();
                updateSendButtonState();
            }
        })
        .catch(error => {
            // Older gateways do not expose runtime snapshots. Push events still
            // keep this projection current, so a missing endpoint is non-fatal.
            console.debug('[FollowUp] Runtime snapshot unavailable:', error);
        })
        .finally(() => runtimeSnapshotRequests.delete(sessionId));
    runtimeSnapshotRequests.set(sessionId, request);
    return request;
}

function syncFollowUpRuntimeForVisibleSession(force = false): void {
    renderFollowUpQueue();
    if (!currentSessionId) {
        lastRuntimeSnapshotSessionId = null;
        return;
    }
    if (!force && lastRuntimeSnapshotSessionId === currentSessionId) return;
    lastRuntimeSnapshotSessionId = currentSessionId;
    void refreshFollowUpRuntime(currentSessionId, force);
}

function renderAcceptedSteer(submissionId: string, pending: PendingFollowUpSubmission): void {
    if (pending.rendered) return;
    pending.rendered = true;
    // Accepted guidance is rendered by the durable activity event at the exact
    // point it entered the running turn. Appending a chat bubble here would put
    // it after the whole Process card and duplicate the persisted steer message.
    rememberRenderedSubmission(submissionId);
}

function renderActivatedQueuedTurn(submissionId: string, pending: PendingFollowUpSubmission): void {
    if (pending.rendered || pending.sessionId !== currentSessionId) return;
    pending.rendered = true;
    addMessage({
        id: `msg-queued-${submissionId}`,
        role: 'user',
        content: pending.displayContent,
        createdAt: Date.now(),
        attachments: pending.attachments,
        metadata: { submissionId, followUpMode: 'queue' },
    });
    rememberRenderedSubmission(submissionId);
    showTyping();
}

function handleFollowUpGatewayMessage(message: { type: string; payload?: unknown }): void {
    if (message.type === 'chat.accepted') {
        const payload = message.payload as ChatAcceptedPayload | undefined;
        if (!payload?.sessionId || !payload.disposition) return;
        if (!followUpController.applyAccepted(payload)) {
            console.debug('[FollowUp] Ignoring stale chat.accepted', payload);
            return;
        }

        const submissionId = payload.submissionId;
        const pending = submissionId ? pendingFollowUpSubmissions.get(submissionId) : undefined;
        if (pending && (payload.disposition === 'queued'
            || (payload.disposition === 'started' && pending.delivery === 'steer' && payload.queueItem))) {
            pending.delivery = 'queue';
        }
        if (payload.disposition === 'started') {
            if (submissionId && pending?.delivery === 'queue') {
                renderActivatedQueuedTurn(submissionId, pending);
            }
            loadingSessions.add(payload.sessionId);
            chatTargetSessionIds.add(payload.sessionId);
            setSessionRuntimeState(payload.sessionId, 'running', { label: t('chat.thinking') });
        } else if (payload.disposition === 'steer_pending' && submissionId && pending) {
            renderAcceptedSteer(submissionId, pending);
            if (payload.sessionId === currentSessionId) {
                setStatus(t('follow_up.steer_accepted'), 'running');
            }
        } else if (payload.disposition === 'queued') {
            if (payload.sessionId === currentSessionId) {
                setStatus(t('follow_up.queued_accepted'), 'running');
            }
            void refreshFollowUpRuntime(payload.sessionId, true);
        } else if (payload.disposition === 'stale_target' || payload.disposition === 'unsupported') {
            pendingFollowUpSubmissions.delete(submissionId || '');
            setStatus(t('follow_up.queue_update_failed'), 'error');
        }

        if (submissionId && (payload.disposition === 'started' || payload.disposition === 'steer_pending')) {
            pendingFollowUpSubmissions.delete(submissionId);
        }
        if (payload.sessionId === currentSessionId) {
            renderFollowUpQueue();
            updateSendButtonState();
        }
        return;
    }

    if (message.type === 'chat.start') {
        const payload = message.payload as Record<string, unknown> | undefined;
        const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : undefined;
        const turnId = typeof payload?.turnId === 'string' ? payload.turnId : undefined;
        const runId = typeof payload?.runId === 'string' ? payload.runId : undefined;
        const submissionId = typeof payload?.submissionId === 'string' ? payload.submissionId : undefined;
        if (!sessionId || !turnId) return;
        followUpController.observeTurnStarted({ sessionId, turnId, runId, submissionId });
        if (submissionId) {
            const pending = pendingFollowUpSubmissions.get(submissionId);
            if (pending?.delivery === 'queue') renderActivatedQueuedTurn(submissionId, pending);
            if (!pending && !renderedFollowUpSubmissionIds.has(submissionId)
                && typeof payload.input === 'string' && payload.input.trim()
                && sessionId === currentSessionId) {
                addMessage({
                    id: `msg-queued-${submissionId}`,
                    role: 'user',
                    content: payload.input,
                    createdAt: Date.now(),
                    metadata: { submissionId, followUpMode: 'queue' },
                });
                rememberRenderedSubmission(submissionId);
                showTyping();
            }
            pendingFollowUpSubmissions.delete(submissionId);
        }
        loadingSessions.add(sessionId);
        chatTargetSessionIds.add(sessionId);
        setSessionRuntimeState(sessionId, 'running', { label: t('chat.thinking') });
        return;
    }

    if (message.type === 'chat.queue.updated') {
        const payload = message.payload as Record<string, unknown> | undefined;
        const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : undefined;
        if (!sessionId) return;
        followUpController.applyQueueUpdate(sessionId, payload);
        if (sessionId === currentSessionId) renderFollowUpQueue();
    }
}

function optimisticReorderQueue(sessionId: string, itemId: string, delta: -1 | 1): string[] | undefined {
    const current = queueStateBySession.get(sessionId);
    if (!current) return undefined;
    const index = current.items.findIndex(item => item.id === itemId);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= current.items.length) return undefined;
    const items = [...current.items];
    [items[index], items[target]] = [items[target], items[index]];
    const positioned = items.map((item, position) => ({ ...item, position }));
    queueStateBySession.set(sessionId, { ...current, items: positioned });
    renderFollowUpQueue();
    return positioned.map(item => item.id);
}

async function runQueueMutation(sessionId: string, mutation: () => Promise<void>): Promise<void> {
    try {
        await mutation();
    } catch (error) {
        console.error('[FollowUp] Queue mutation failed:', error);
        setStatus(t('follow_up.queue_update_failed'), 'error');
        await refreshFollowUpRuntime(sessionId, true);
    }
}

followUpQueue.addEventListener('change', event => {
    const input = (event.target as HTMLElement).closest<HTMLInputElement>('[data-queue-input]');
    const sessionId = currentSessionId;
    const itemId = input?.dataset.queueInput;
    if (!sessionId || !itemId || !gatewayClient || !input) return;
    void runQueueMutation(sessionId, () => gatewayClient!.updateQueueItem(sessionId, itemId, input.value.trim()));
});

followUpQueue.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-queue-action]');
    const sessionId = currentSessionId;
    if (!button || !sessionId || !gatewayClient) return;
    const action = button.dataset.queueAction;
    const itemId = button.closest<HTMLElement>('[data-queue-item-id]')?.dataset.queueItemId;

    if ((action === 'up' || action === 'down') && itemId) {
        const itemIds = optimisticReorderQueue(sessionId, itemId, action === 'up' ? -1 : 1);
        if (itemIds) void runQueueMutation(sessionId, () => gatewayClient!.reorderQueue(sessionId, itemIds));
    } else if (action === 'send-now' && itemId) {
        const queuedItem = queueStateBySession.get(sessionId)?.items.find(item => item.id === itemId);
        void runQueueMutation(sessionId, async () => {
            const result = await gatewayClient!.sendQueueItemNow(sessionId, itemId);
            if (result.ok && result.disposition === 'steer_pending' && queuedItem
                && currentSessionId === sessionId
                && !renderedFollowUpSubmissionIds.has(queuedItem.submissionId || '')) {
                const submissionId = queuedItem.submissionId || itemId;
                rememberRenderedSubmission(submissionId);
            }
        });
    } else if (action === 'delete' && itemId) {
        void runQueueMutation(sessionId, () => gatewayClient!.deleteQueueItem(sessionId, itemId));
    } else if (action === 'resume') {
        followUpController.markQueuePaused(sessionId, false);
        renderFollowUpQueue();
        void runQueueMutation(sessionId, () => gatewayClient!.resumeQueue(sessionId));
    } else if (action === 'clear') {
        void runQueueMutation(sessionId, () => gatewayClient!.clearQueue(sessionId));
    }
});

function getSidebarElementSessionId(el: HTMLElement): string | null {
    const directSessionId = el.dataset.sessionId;
    if (directSessionId) {
        return directSessionId === '__router__' ? routerRealSessionId : directSessionId;
    }

    const agentId = el.dataset.agentId;
    if (agentId) return `user-agent:${agentId}`;

    const cloudChatroomId = el.dataset.cloudChatroomId;
    if (cloudChatroomId) {
        const mapped = usedCloudSessions.get(Number(cloudChatroomId));
        if (mapped?.sessionId) return mapped.sessionId;
        for (const [sessionId, chatroomId] of sessionToChatroomMap.entries()) {
            if (String(chatroomId) === cloudChatroomId) return sessionId;
        }
    }

    return null;
}

function renderSessionRuntimeBadges(): void {
    sessionList.querySelectorAll('.session-runtime-badge').forEach(badge => badge.remove());

    sessionList.querySelectorAll<HTMLElement>('.session-item, .local-agent-card').forEach(el => {
        const sessionId = getSidebarElementSessionId(el);
        if (!sessionId) return;

        let runtime = sessionRuntimeStates.get(sessionId);
        // Agent 卡片：聚合名下所有会话的运行状态（任一会话运行中/出错即显示角标）
        if (el.dataset.agentId && (!runtime || runtime.state === 'idle' || runtime.state === 'completed')) {
            for (const [sid, aid] of sessionAgentMap.entries()) {
                if (aid !== el.dataset.agentId) continue;
                const r = sessionRuntimeStates.get(sid);
                if (r && (r.state === 'running' || r.state === 'error' || r.state === 'waiting_input' || r.state === 'awaiting_plan_approval')) {
                    runtime = r;
                    if (r.state === 'running') break;
                }
            }
        }
        if (!runtime || runtime.state === 'idle' || runtime.state === 'completed') return;

        const badge = document.createElement('span');
        if (getComputedStyle(el).position === 'static') {
            el.style.position = 'relative';
        }
        badge.className = `session-runtime-badge session-runtime-${runtime.state}`;
        badge.title = runtime.label;
        const color = runtime.state === 'running'
            ? 'var(--color-warning)'
            : runtime.state === 'error'
                ? 'var(--color-error)'
                : 'var(--color-text-tertiary)';
        const right = el.classList.contains('session-item') && !el.classList.contains('router-session-item')
            ? '30px'
            : '8px';
        badge.style.cssText = [
            'position:absolute',
            'top:50%',
            `right:${right}`,
            'transform:translateY(-50%)',
            'display:block',
            'width:7px',
            'height:7px',
            'border-radius:50%',
            'box-shadow:0 0 0 2px var(--color-bg-secondary)',
            'pointer-events:none',
            'z-index:2',
            `background:${color}`,
            runtime.state === 'running' ? 'animation:pulse 1.5s infinite' : '',
        ].filter(Boolean).join(';');
        el.appendChild(badge);
    });
}

function setSessionRuntimeState(
    sessionId: string | null | undefined,
    state: SessionRuntimeStatus,
    options: { label?: string; lastError?: string } = {},
): void {
    if (!sessionId) return;

    if (state === 'idle') {
        sessionRuntimeStates.delete(sessionId);
    } else {
        sessionRuntimeStates.set(sessionId, {
            state,
            label: options.label || (
                state === 'running' ? t('chat.thinking')
                    : state === 'waiting_input' ? t('plan.waiting_choice')
                        : state === 'awaiting_plan_approval' ? t('plan.waiting_approval')
                    : state === 'error' ? t('common.error')
                        : state === 'stopped' ? t('chat.stop')
                            : t('titlebar.status_ready')
            ),
            updatedAt: Date.now(),
            lastError: options.lastError,
        });
    }

    renderSessionRuntimeBadges();
    if (sessionId === currentSessionId) {
        updateSendButtonState();
        syncTitlebarStatusFromCurrentSession();
    }
}

function getCurrentSessionRuntimeState(): SessionRuntimeState | undefined {
    return currentSessionId ? sessionRuntimeStates.get(currentSessionId) : undefined;
}

function syncTitlebarStatusFromCurrentSession(): void {
    const runtime = getCurrentSessionRuntimeState();
    if (runtime?.state === 'running') {
        setStatus(t('chat.thinking'), 'running');
        return;
    }
    if (runtime?.state === 'error') {
        setStatus(runtime.label || t('common.error'), 'error');
        return;
    }
    setStatus(t('titlebar.status_ready'), 'ready');
}

function syncCurrentSessionRuntimeUi(): void {
    updateSendButtonState();
    syncTitlebarStatusFromCurrentSession();
    renderSessionRuntimeBadges();
    syncFollowUpRuntimeForVisibleSession();
}

type SidebarActionState = 'new-agent' | 'scheduler' | 'settings' | null;

function syncSidebarEntitySelection(): void {
    const suppressEntitySelection =
        newSessionBtn.classList.contains('active')
        || schedulerViewActive
        || settingsViewActive;

    sessionList.querySelectorAll<HTMLElement>('.session-item, .local-agent-card').forEach(el => {
        if (suppressEntitySelection) {
            el.classList.remove('active');
            return;
        }

        let active = false;
        if (el.classList.contains('router-session-item')) {
            active = isRouterSession;
        } else if (el.classList.contains('cloud-agent-card')) {
            const chatroomId = Number(el.dataset.cloudChatroomId || 0);
            active = !!currentCloudChatroomId && currentCloudChatroomId === chatroomId && !isRouterSession;
        } else if (el.dataset.agentId) {
            active = currentAgentId === el.dataset.agentId && !currentCloudChatroomId && !isRouterSession;
        } else if (el.dataset.sessionId) {
            active = el.dataset.sessionId === currentSessionId;
        }
        el.classList.toggle('active', active);
    });
}

function setSidebarActionState(action: SidebarActionState): void {
    newSessionBtn.classList.toggle('active', action === 'new-agent');
    schedulerBtn.classList.toggle('active', action === 'scheduler');
    settingsBtn.classList.toggle('active', action === 'settings');
    syncSidebarEntitySelection();
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
        { value: 'claude-fable-5', label: `Claude Fable 5 (${t('model.latest')})`, multimodal: true },
        { value: 'claude-opus-5', label: 'Claude Opus 5', multimodal: true },
        { value: 'claude-sonnet-5', label: 'Claude Sonnet 5', multimodal: true },
        { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', multimodal: true },
    ],
    openai: [
        { value: 'gpt-5.6', label: `GPT-5.6 Sol (${t('model.latest')})`, multimodal: true },
        { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', multimodal: true },
        { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', multimodal: true },
    ],
    deepseek: [
        { value: 'deepseek-v4-pro', label: `DeepSeek V4 Pro (${t('model.latest')})`, multimodal: false },
        { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', multimodal: false },
    ],
    minimax: [
        { value: 'MiniMax-M2.7', label: `MiniMax-M2.7 (${t('model.latest')})`, multimodal: false },
        { value: 'MiniMax-M2.7-highspeed', label: `MiniMax-M2.7 ${t('model.highspeed')}`, multimodal: false },
    ],
    google: [
        { value: 'gemini-3.6-flash', label: `Gemini 3.6 Flash (${t('model.latest')})`, multimodal: true },
        { value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', multimodal: true },
        { value: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite', multimodal: true },
    ],
    moonshot: [
        { value: 'kimi-k3', label: `Kimi K3 (${t('model.latest')} · ${t('model.multimodal')})`, multimodal: true },
        { value: 'kimi-k2.7-code', label: 'Kimi K2.7 Code', multimodal: true },
        { value: 'kimi-k2.7-code-highspeed', label: `Kimi K2.7 Code ${t('model.highspeed')}`, multimodal: true },
        { value: 'kimi-k2.6', label: 'Kimi K2.6', multimodal: true },
    ],
    dashscope: [
        { value: 'qwen3.8-max', label: `Qwen3.8-Max (${t('model.latest')} · ${t('model.multimodal')})`, multimodal: true },
        { value: 'qwen3.7-plus', label: `Qwen3.7-Plus (${t('model.multimodal')})`, multimodal: true },
        { value: 'qwen3.7-flash', label: 'Qwen3.7-Flash', multimodal: true },
    ],
    zhipu: [
        { value: 'glm-5.2', label: `GLM-5.2 (${t('model.latest')})`, multimodal: false },
        { value: 'glm-5-turbo', label: 'GLM-5 Turbo', multimodal: false },
        { value: 'glm-5v-turbo', label: `GLM-5V Turbo (${t('model.vision')})`, multimodal: true },
    ],
    ollama: [
        { value: 'qwen3.5:35b', label: `Qwen 3.5 35B (${t('model.latest')})`, multimodal: true },
        { value: 'qwen3.5:27b', label: 'Qwen 3.5 27B', multimodal: true },
        { value: 'qwen3.5:9b', label: 'Qwen 3.5 9B', multimodal: true },
        { value: 'gpt-oss:20b', label: 'GPT-OSS 20B', multimodal: false },
        { value: 'gemma3:27b', label: 'Gemma 3 27B', multimodal: true },
        { value: 'llama4:scout', label: 'Llama 4 Scout', multimodal: true },
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
        gatewayClient = new GatewayClient(config.url, config.token, {
            role: 'desktop',
            instanceId: getDesktopGatewayInstanceId(),
        });
        // Approval replay can arrive during the reconnect handshake, so install
        // this handler before connect() instead of after application init.
        gatewayClient.addMessageHandler((msg) => handleToolApprovalGatewayMessage(gatewayClient!, msg));
        gatewayClient.addMessageHandler(handleFollowUpGatewayMessage);
        gatewayClient.addMessageHandler(handleWorkStateGatewayMessage);
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
                    // Always show friendly loading messages — raw errors are logged to console only
                    const progressMsg = attempt <= 3
                        ? t('app.loading_core', elapsed)
                        : attempt <= 10
                            ? t('app.init_service', elapsed)
                            : t('app.waiting_gateway', elapsed);
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
            // Chrome 录制扩展「转发到 OpenFlux」：预填聊天框，等待用户发送
            if (msg.type === 'recording.forward' && msg.payload) {
                handleRecordingForward(msg.payload);
            }
            // 设计画布「按标注生成」：切到设计师 Agent，预填指令并自动发送
            if (msg.type === 'canvas.prompt' && msg.payload) {
                void handleCanvasPrompt(msg.payload);
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
            syncTitlebarStatusFromCurrentSession();
            syncFollowUpRuntimeForVisibleSession(true);
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
        gw.onAgentEvent(handleAgentEvent);

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
        syncApprovalModeUi();
        document.getElementById('html-root')?.setAttribute('lang', getLocale() === 'zh' ? 'zh-CN' : 'en');

        // Bind language switcher
        const localeSelect = document.getElementById('locale-select') as HTMLSelectElement | null;
        if (localeSelect) {
            localeSelect.value = getLocale();
            localeSelect.addEventListener('change', () => {
                setLocale(localeSelect.value as Locale);
                updateSendButtonState();
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
            try { renderAgentModelCards(); } catch { /* ignore */ }
            try { refreshProviderNameLabels(); } catch { /* ignore */ }
            try { updateSchedulerWaitingBadge(cachedTasks); } catch { /* ignore */ }
            try { syncApprovalModeUi(); } catch { /* ignore */ }
            try {
                const state = getCurrentWorkState();
                if (state) applyWorkState(state);
                else {
                    syncWorkModeUi();
                }
            } catch { /* ignore */ }
        });

        // loading：播放收尾爆发并淡出启动遮罩
        dismissStartupOverlay();

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
            handleSchedulerRuntimeEvent(event);
            const taskId = schedulerViewActive ? selectedTaskId : null;
            loadSchedulerData().then(() => {
                if (schedulerViewActive && taskId && selectedTaskId === taskId) {
                    loadTaskRuns(taskId);
                }
            }).catch(error => console.error('[Scheduler] Refresh after event failed:', error));
            // Toast
            if (event.type === 'run_complete') {
                showSchedulerToast('ok', event.taskName || 'Task', '执行完成', event.taskId);
            } else if (event.type === 'run_failed') {
                showSchedulerToast('fail', event.taskName || 'Task', event.error || '执行失败', event.taskId);
            }
        });
        void loadSchedulerData();

        // A title lands mid-turn, so it is applied to the one row rather than
        // refetching the list and repainting the sidebar under a running task.
        gw.onSessionTitleUpdated((sessionId: string, title: string) => {
            applySessionTitleUpdate(sessionId, title);
        });

        // Listen for session-updated events (refresh after a scheduled task finishes).
        // This refresh replaces the messages DOM, so it must hydrate durable
        // Agent events too; rendering legacy logs alone would remove the live
        // Processed card until the user switched sessions.
        gw.onSessionUpdated(async (sessionId: string) => {
            // Refresh the left session list (may have new messages)
            await loadLocalAgents();
            // If currently viewing this session, refresh messages and logs
            if (currentSessionId === sessionId && gatewayClient) {
                try {
                    const [messages, logs, agentEvents] = await Promise.all([
                        gatewayClient.getMessages(sessionId),
                        gatewayClient.getLogs(sessionId),
                        gatewayClient.getAgentEvents(sessionId).catch(() => [] as AgentEventV1[]),
                    ]);
                    if (currentSessionId !== sessionId) return;
                    const hydratedMessages = await hydrateMessageAttachments(messages as Message[]);
                    if (currentSessionId !== sessionId) return;
                    renderMessagesWithActivity(
                        hydratedMessages,
                        logs as LogEntry[],
                        agentEvents,
                        sessionId,
                    );
                } catch (e) {
                    console.error('[SessionUpdated] Refresh messages failed:', e);
                }
            }
        });

        // (Agent
        gw.onCollaborationResult((event) => {
            console.log('[Collaboration] Result received:', event);
            // Child-agent results belong to the parent's Processing timeline.
            // Do not notify whichever unrelated session happens to be open.
            if (!event.parentSessionId || event.parentSessionId !== currentSessionId) return;
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
        syncTitlebarStatusFromCurrentSession();
    } catch (error) {
        console.error('[Init] Gateway connection failed:', error);
        setStatus(t('status.error'), 'error');
        // 连接失败也要收起启动遮罩，露出 UI
        dismissStartupOverlay();
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
        rememberSessionApprovalModes(sessions);
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
                    activityView.clearSession(sessionId);
                    sessionCompletedOutputs.delete(sessionId);
                    if (currentSessionId === sessionId) {
                        currentSessionId = null;
                        currentCloudChatroomId = null;
                        messagesContainer.innerHTML = '';
                        clearArtifacts();
                        syncCurrentSessionRuntimeUi();
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

    syncSidebarEntitySelection();
    renderSessionRuntimeBadges();
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
            // Durable events are cached when the newest page is rendered. Now
            // that their owning messages are visible, move each Process card
            // next to its user/assistant pair instead of appending it at bottom.
            activityView.pauseAutoFollow(2_000);
            const placedTurns = new Set<string>();
            const loadedMessageElements = new Map(
                Array.from(messagesContainer.querySelectorAll<HTMLElement>('.message[data-message-id]'))
                    .map(element => [element.dataset.messageId || '', element] as const),
            );
            for (const loadedMessage of hydratedMessages as Message[]) {
                const turnId = typeof loadedMessage.metadata?.turnId === 'string'
                    ? loadedMessage.metadata.turnId
                    : undefined;
                if (!turnId || placedTurns.has(turnId)) continue;
                const messageElement = loadedMessageElements.get(loadedMessage.id);
                const activityRoot = activityView.restoreTurn(sessionId, turnId);
                if (!messageElement || !activityRoot) continue;
                placedTurns.add(turnId);
                if (loadedMessage.role === 'assistant') messageElement.before(activityRoot);
                else messageElement.after(activityRoot);
            }
            activateMermaid(messagesContainer);
            hydrateLocalImages(messagesContainer);

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
        if (isConversationNavigationPaused()) return;
        // (80px )
        if (messagesContainer.scrollTop <= 80) {
            loadMoreMessages();
        }
    });
})();



async function selectSession(sessionId: string): Promise<void> {
    console.log('[selectSession] Called, sessionId:', sessionId, 'current:', currentSessionId);
    const viewRevision = ++sessionViewRevision;

    // If the scheduler view is active, switch back to chat first
    closeSchedulerView();

    // If the settings view is active, switch back to chat first
    closeSettingsView();
    setSidebarActionState(null);

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
    inputRow.classList.remove('plan-interaction-active');
    planInteraction.classList.add('hidden');
    planInteraction.replaceChildren();
    newSessionApprovalMode = getSessionApprovalMode(sessionId);
    // 若该会话属于当前 Agent，则记录为其激活会话（切回 Agent 时恢复）
    if (currentAgentId && agentSessionsList.some(s => s.id === sessionId)) {
        agentActiveSessionMap.set(currentAgentId, sessionId);
    }
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
    syncApprovalModeUi();
    syncWorkModeUi();

    // Update the sidebar selected state
    sessionList.querySelectorAll('.session-item').forEach(item => {
        item.classList.toggle('active', (item as HTMLElement).dataset.sessionId === sessionId);
    });
    syncSidebarEntitySelection();
    // Clear the unread mark for this session
    unreadSessionIds.delete(sessionId);
    const targetItem = sessionList.querySelector(`.session-item[data-session-id="${sessionId}"]`);
    targetItem?.querySelector('.unread-badge')?.remove();

    const selectedRuntime = sessionRuntimeStates.get(sessionId);
    if (selectedRuntime?.state === 'completed' || selectedRuntime?.state === 'stopped') {
        setSessionRuntimeState(sessionId, 'idle');
    } else {
        syncCurrentSessionRuntimeUi();
    }

    // Only load messages and logs when switching to a different session
    if (!isSameSession && gatewayClient) {
        // Restore the input draft of the target session
        messageInput.value = sessionDrafts.get(sessionId) || '';
        autoResize();

        // Save the progress state of the leaving session to cache
        cacheCurrentProgressState(previousSessionId);

        // Reset the live progress state
        currentProgressCard = null;
        progressItems = [];
        // If the target session is still loading, keep isProgressFinished = false
        // progress
        isProgressFinished = !loadingSessions.has(sessionId);

        // A session owns its own artifacts. Hide and clear the previous
        // session immediately instead of waiting for all history requests.
        clearArtifacts();
        const cachedWorkState = workStateBySession.get(sessionId);
        if (cachedWorkState) applyWorkState(cachedWorkState);

        try {
            console.log('[selectSession] Loading messages, logs and artifacts sessionId:', sessionId);

            // Reset lazy-load state
            sessionMsgOffset.set(sessionId, 0);
            sessionMsgHasMore.set(sessionId, false);

            const [msgResult, logs, savedArtifacts, agentEvents, workState] = await Promise.all([
                gatewayClient.getMessages(sessionId, SESSION_PAGE_SIZE, 0),
                gatewayClient.getLogs(sessionId),
                gatewayClient.getArtifacts(sessionId),
                gatewayClient.getAgentEvents(sessionId).catch(() => [] as AgentEventV1[]),
                currentCloudChatroomId
                    ? Promise.resolve({ sessionId, mode: 'normal' as const } satisfies WorkStateSnapshot)
                    : gatewayClient.getWorkState(sessionId).catch(() => ({ sessionId, mode: 'normal' as const })),
            ]);
            if (viewRevision !== sessionViewRevision || currentSessionId !== sessionId) return;
            applyWorkState(workState);

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
            if (viewRevision !== sessionViewRevision || currentSessionId !== sessionId) return;

            // Restore attachment info (image thumbnails load asynchronously)
            const hydratedMessages = await hydrateMessageAttachments(finalMessages);
            if (viewRevision !== sessionViewRevision || currentSessionId !== sessionId) return;
            renderMessagesWithActivity(hydratedMessages, logs as LogEntry[], agentEvents, sessionId);

            // If there are more, show the hint again
            if (hasMore) {
                prependLoadMoreHint();
            }

            // ═══ 恢复动作卡片：若目标会话仍在执行，重建实时进度卡片（缓存为空也显示"运行中"） ═══
            restoreRunningProgressCard(sessionId);

            // Restore artifacts (no longer persisted, since they're already on the server)
            if (savedArtifacts.length > 0) {
                const sorted = [...savedArtifacts].sort((a: any, b: any) => (b.timestamp || 0) - (a.timestamp || 0));
                for (const a of sorted) {
                    if (viewRevision !== sessionViewRevision || currentSessionId !== sessionId) return;
                    await addArtifact(a as Artifact, false);
                }
            }
        } catch (error) {
            console.error('Failed to load session data:', error);
        }
    }
    if (viewRevision !== sessionViewRevision || currentSessionId !== sessionId) return;
    activityView.restoreRunningSession(sessionId);
    // Focus the input box
    if (!isRouterSession) messageInput.focus();
    syncCurrentSessionRuntimeUi();
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

    // Attempt 3: find local-agent-card via agentId (user-agent:<agentId> 前缀，或多会话的归属映射)
    if (!target) {
        const agentId = sessionId.startsWith('user-agent:')
            ? sessionId.slice('user-agent:'.length)
            : sessionAgentMap.get(sessionId);
        if (agentId) {
            target = sessionList.querySelector(`.local-agent-card[data-agent-id="${agentId}"]`) as HTMLElement | null;
        }
    }

    console.log('[markSessionUnread] target element:', target?.className);

    if (target && !target.querySelector('.unread-badge')) {
        const badge = document.createElement('span');
        badge.className = 'unread-badge';
        target.appendChild(badge);
        console.log('[markSessionUnread] badge added to:', target.className);
    }
    renderSessionRuntimeBadges();
}

// Create a session (full version: clear + refresh sidebar, for clicking New)
async function createSession(): Promise<void> {
    if (!gatewayClient) return;
    try {
        const approvalMode = getCurrentApprovalMode();
        const session = await gatewayClient.createSession(undefined, undefined, undefined, undefined, approvalMode);
        rememberSessionApprovalModes([session]);
        currentSessionId = session.id;
        newSessionApprovalMode = getSessionApprovalMode(session.id);
        clearArtifacts();
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
        syncCurrentSessionRuntimeUi();
    } catch (error) {
        console.error('Failed to create session:', error);
    }
}

// Silently create a session (no clearing, for auto-create when sending)
async function createSessionSilent(): Promise<void> {
    if (!gatewayClient) return;
    try {
        // 绑定到当前 Agent（多会话归组）
        const approvalMode = getCurrentApprovalMode();
        const session = await gatewayClient.createSession(
            undefined,
            undefined,
            undefined,
            currentAgentId || undefined,
            approvalMode,
        );
        rememberSessionApprovalModes([session]);
        currentSessionId = session.id;
        newSessionApprovalMode = getSessionApprovalMode(session.id);
        clearArtifacts();
        if (currentAgentId) {
            agentActiveSessionMap.set(currentAgentId, session.id);
            sessionAgentMap.set(session.id, currentAgentId);
            await refreshAgentSessions(currentAgentId, false);
        }
        // Refresh the left session list (may have new messages)
        await loadLocalAgents();
        syncCurrentSessionRuntimeUi();
    } catch (error) {
        console.error('Failed to create session:', error);
    }
}

// Render the message list (messages only, without progress cards)
function renderMessages(messages: Message[]): void {
    messages = mergeLatestPlanPreview(messages, getCurrentWorkState());
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
    hydrateLocalImages(messagesContainer);
    scrollToBottom();
}

// Render messages with durable Turn/Item events. New messages carry metadata.turnId,
// so their activity card is restored in the same position as the live conversation.
// Legacy logs remain available for older turns that predate the event protocol.
function renderMessagesWithActivity(
    messages: Message[],
    logs: LogEntry[],
    events: AgentEventV1[],
    sessionId: string,
): void {
    messages = mergeLatestPlanPreview(messages, workStateBySession.get(sessionId));
    if (events.length === 0) {
        renderMessagesWithLogs(messages, logs);
        // A live event may have arrived after the history snapshot was taken.
        // renderMessagesWithLogs rebuilds the container, so reattach any
        // already-reduced activity state immediately.
        activityView.restoreRunningSession(sessionId);
        return;
    }

    const byTurn = new Map<string, AgentEventV1[]>();
    for (const event of events) {
        const list = byTurn.get(event.turnId) || [];
        list.push(event);
        byTurn.set(event.turnId, list);
    }
    for (const list of byTurn.values()) list.sort((a, b) => a.seq - b.seq || a.timestamp - b.timestamp);
    for (const event of events) activityView.cacheEvent(event);

    const turnsWithGuidance = new Set(
        events
            .filter(event => !!guidanceTextFromActivityItem(event.item))
            .map(event => event.turnId),
    );
    // Only suppress the standalone bubble when the same guidance is safely
    // represented in that turn's durable Process timeline.
    const visibleMessages = messages.filter(message => (
        !isSteerMessageRepresentedInActivity(message, turnsWithGuidance)
    ));

    const renderedTurns = new Set<string>();
    const renderTurn = (turnId: string | undefined) => {
        if (!turnId || renderedTurns.has(turnId)) return;
        const turnEvents = byTurn.get(turnId);
        if (!turnEvents?.length) return;
        renderedTurns.add(turnId);
        activityView.restoreTurn(sessionId, turnId);
    };

    // Logs with turnId are already represented by Item events. Only use old rows
    // as the compatibility fallback, avoiding duplicate cards for migrated turns.
    const legacyLogs = logs
        .filter(log => !log.turnId || !byTurn.has(log.turnId))
        .filter(log => log.tool !== '_thinking')
        .sort((a, b) => a.timestamp - b.timestamp);

    // Event-only sessions are valid (for example a freshly created Designer
    // session while its user message is still being persisted). Do not replace
    // them with the empty welcome state and discard the Processed timeline.
    messagesContainer.innerHTML = visibleMessages.length === 0 && legacyLogs.length > 0
        ? renderHistoricalProgressCard(legacyLogs)
        : '';

    for (let index = 0; index < visibleMessages.length; index++) {
        const message = visibleMessages[index];
        const turnId = typeof message.metadata?.turnId === 'string'
            ? message.metadata.turnId
            : undefined;

        // A missing/cropped user message should not push the activity below its answer.
        if (message.role === 'assistant') renderTurn(turnId);
        messagesContainer.insertAdjacentHTML('beforeend', renderMessage(message));
        if (message.role === 'user') renderTurn(turnId);

        const nextTimestamp = visibleMessages[index + 1]?.createdAt ?? Infinity;
        const logsInGap = legacyLogs.filter(log => log.timestamp > message.createdAt && log.timestamp < nextTimestamp);
        if (logsInGap.length > 0) {
            messagesContainer.insertAdjacentHTML('beforeend', renderHistoricalProgressCard(logsInGap));
        }
    }

    // Persisted messages from older builds may not carry metadata.turnId. Keep
    // fallbacks inside the loaded time window, while suppressing terminal turns
    // that belong to an older, not-yet-loaded message page.
    const earliestLoadedMessageAt = visibleMessages.length > 0
        ? Math.min(...visibleMessages.map(message => message.createdAt))
        : undefined;
    for (const [turnId, turnEvents] of byTurn.entries()) {
        if (shouldRenderUnanchoredTurn(turnEvents, earliestLoadedMessageAt)) renderTurn(turnId);
    }

    messagesContainer.querySelectorAll('.progress-card.historical .progress-card-header').forEach(header => {
        header.addEventListener('click', () => {
            const card = header.closest('.progress-card') as HTMLElement | null;
            if (!card) return;
            card.classList.toggle('collapsed');
        });
    });
    activateMermaid(messagesContainer);
    hydrateLocalImages(messagesContainer);
    // Reattach live states that arrived after getAgentEvents() returned but
    // before this history render replaced the message container.
    activityView.restoreRunningSession(sessionId);
    scrollToBottom();
}

// Render the message list + insert historical progress cards by tool-log timeline
function renderMessagesWithLogs(messages: Message[], logs: LogEntry[]): void {
    messages = mergeLatestPlanPreview(messages, getCurrentWorkState());
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

    // `_thinking` contains provider-internal reasoning and must never be rendered.
    const sortedLogs = logs
        .filter(log => log.tool !== '_thinking')
        .sort((a, b) => a.timestamp - b.timestamp);
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
    hydrateLocalImages(messagesContainer);
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
                <span class="progress-card-toggle"></span>
            </div>
            <div class="progress-card-body">${items}</div>
        </div>
    `;
}

// Render a single message
function renderMessage(message: Message): string {
    // Defense in depth: internal runtime context must never become a chat
    // bubble, even if it arrives from an older Gateway or a stale live event.
    const metadata = message.metadata;
    const isInternalRuntimeMessage = metadata?.internal === true
        || metadata?.visibility === 'internal'
        || metadata?.kind === 'plan_execution_snapshot'
        || /^\[System:\s*approved immutable plan execution\]\s*/i.test(message.content || '');
    if (isInternalRuntimeMessage
        || ((message.role as string) === 'system' && message.content?.startsWith('[Tool context]'))) {
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
            const sizeLabel = a.ext === 'recording' ? `录制 · ${a.size} 步` : formatAttachmentSize(a.size);
            return `
                    <div class="msg-attach-item" title="${escapeHtml(a.name)}"${a.path ? ` data-path="${escapeHtml(a.path)}" style="cursor:pointer"` : ''}>
                        ${iconHtml}
                        <div class="msg-attach-info">
                            <span class="msg-attach-name">${escapeHtml(a.name)}</span>
                            <span class="msg-attach-size">${sizeLabel}</span>
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

    // Assistant messages render as Markdown; ordinary user messages remain plain text.
    const contentHtml = message.role === 'assistant'
        ? renderMarkdown(displayContent)
        : escapeHtml(displayContent).replace(/\n/g, '<br>');

    // Only show the text area when there is content
    const textHtml = message.content.trim()
        ? `<div class="markdown-body">${contentHtml}</div>`
        : '';

    // Assistant message: add a TTS play button
    const isPlanDocumentPreview = message.role === 'assistant' && message.metadata?.planDocumentPreview === true;
    const ttsButtonHtml = message.role === 'assistant' && !isPlanDocumentPreview && message.content.trim()
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
    const followUpLabelHtml = message.role === 'user' && message.metadata?.followUpMode === 'steer'
        ? `<div class="follow-up-message-label">↳ ${escapeHtml(t('follow_up.steer_badge'))}</div>`
        : '';

    const planPreviewClass = isPlanDocumentPreview
        ? ' plan-document-preview'
        : '';
    const planFilePath = isPlanDocumentPreview && typeof message.metadata?.planFilePath === 'string'
        ? message.metadata.planFilePath
        : '';
    const planPreviewAttributes = planFilePath
        ? ` data-plan-file-path="${escapeHtml(planFilePath)}" role="button" tabindex="0" aria-label="${escapeHtml(t('preview.open'))}" title="${escapeHtml(t('preview.open'))}"`
        : '';

    return `
        <div class="message ${message.role}${planPreviewClass}" data-message-id="${message.id}"${planPreviewAttributes}>
            ${routerLabelHtml}
            ${followUpLabelHtml}
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
    hydrateLocalImages(messagesContainer);
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
let streamingContentIsProvisional = false;
let streamingRenderScheduled = false;
let streamingRenderTimerId: number | null = null;
let streamingRenderFrameId: number | null = null;
const STREAMING_RENDER_INTERVAL_MS = 40;
let streamingMsgId = '';  // streaming message ID (used for streaming TTS and final DOM binding)
// 多会话并发：按会话缓冲流式 token。
// 后台会话的 token 也会累积在这里，切回该会话时恢复已生成的部分回复并继续实时渲染。
const sessionStreamBuffers = new Map<string, string>();
const sessionCompletedOutputs = new Map<string, string>();
// A reset may remove only text explicitly marked as a provisional draft.
// Committed output is append-only even when guidance changes later tool steps.
const sessionProvisionalStreamIds = new Set<string>();

function appendSessionStreamBuffer(sessionId: string, token: string, provisional = false): void {
    sessionStreamBuffers.set(sessionId, (sessionStreamBuffers.get(sessionId) || '') + token);
    if (provisional) sessionProvisionalStreamIds.add(sessionId);
}

function cancelScheduledStreamingRender(): void {
    if (streamingRenderTimerId !== null) {
        window.clearTimeout(streamingRenderTimerId);
        streamingRenderTimerId = null;
    }
    if (streamingRenderFrameId !== null) {
        cancelAnimationFrame(streamingRenderFrameId);
        streamingRenderFrameId = null;
    }
    streamingRenderScheduled = false;
}

function scheduleStreamingRender(): void {
    if (streamingRenderScheduled) return;
    streamingRenderScheduled = true;

    // Parsing and replacing the complete Markdown tree on every token causes
    // repeated layout work. A short cadence remains visually fluid while
    // allowing adjacent token deltas to share one render.
    streamingRenderTimerId = window.setTimeout(() => {
        streamingRenderTimerId = null;
        streamingRenderFrameId = requestAnimationFrame(() => {
            streamingRenderFrameId = null;
            if (streamingRenderScheduled) renderStreamingMarkdown();
            streamingRenderScheduled = false;
        });
    }, STREAMING_RENDER_INTERVAL_MS);
}
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
    const shouldFollowOutput = isNearMessagesBottom();

    // Markdown
    contentEl.innerHTML = renderMarkdown(streamingContent);

    // Resolve any complete local-image tags as they stream in (cached, so no flicker/re-read).
    hydrateLocalImages(contentEl as HTMLElement);

    // Follow new output only while the user is already at the bottom. This
    // prevents a manual upward scroll from being pulled back on every token.
    if (shouldFollowOutput) scrollToBottom();
}

// token
function appendStreamingToken(token: string, provisional = false): void {
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
    streamingContentIsProvisional = streamingContentIsProvisional || provisional;

    // token TTS( + )
    if ((ttsAutoPlay || voiceModeActive) && !provisional) {
        streamingTtsManager.feedToken(token);
    }

    scheduleStreamingRender();
}

// Finish the streaming message
function finishStreamingMessage(canonicalContent?: string, planDocumentPreview = false): string {
    if (canonicalContent !== undefined && streamingMessageEl) streamingContent = canonicalContent;
    const content = streamingContent;

    // Cancel the pending throttled render before applying the canonical result.
    cancelScheduledStreamingRender();

    if (streamingMessageEl) {
        // If there's no content, remove the whole message element
        if (!content.trim()) {
            streamingMessageEl.remove();
            streamingTtsManager.cancel();
        } else {
            if (planDocumentPreview) streamingMessageEl.classList.add('plan-document-preview');
            // Remove the streaming marker
            streamingMessageEl.classList.remove('streaming');

            // Final Markdown render (without the cursor, for clean output)
            const contentEl = streamingMessageEl.querySelector('.markdown-body');
            if (contentEl) {
                contentEl.innerHTML = renderMarkdown(content);
                // mermaid
                activateMermaid(streamingMessageEl);
                hydrateLocalImages(streamingMessageEl);
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
            syncStreamingTtsButtonState(msgId);

            // TTS:(,)
            if ((ttsAutoPlay || voiceModeActive) && content.trim()) {
                if (streamingContentIsProvisional) streamingTtsManager.feedToken(content);
                streamingTtsManager.finishStreaming();
            }
        }
    }

    streamingMessageEl = null;
    streamingContent = '';
    streamingContentIsProvisional = false;
    streamingMsgId = '';

    return content;
}

function discardStreamingMessage(): void {
    cancelScheduledStreamingRender();
    streamingMessageEl?.remove();
    streamingTtsManager.cancel();
    streamingMessageEl = null;
    streamingContent = '';
    streamingContentIsProvisional = false;
    streamingMsgId = '';
}

// Hide the loading animation
function hideTyping(): void {
    destroyTypingHole();
    const typing = document.getElementById('typing-indicator');
    if (typing) typing.remove();
}

/**
 * 处理 Chrome 录制扩展的「转发到 OpenFlux」：把录制作为一个附件 chip 加入输入框
 * （体感与拖入文件一致），聚焦并把窗口带到前台。用户可直接发送（默认回放），
 * 或自行补充指令（如转成 workflow / skill）后发送。
 */
function handleRecordingForward(payload: { id: string; title?: string; startUrl?: string; stepCount?: number }): void {
    const title = payload.title || payload.id;
    const steps = payload.stepCount ?? 0;

    // 去重：同一条录制只加一个 chip
    if (!pendingAttachments.some(a => a.type === 'recording' && a.recordingId === payload.id)) {
        pendingAttachments.push({
            path: '',
            name: title,
            size: steps,            // 录制类型复用 size 字段存步骤数
            ext: 'recording',
            type: 'recording',
            recordingId: payload.id,
            startUrl: payload.startUrl,
        });
        renderAttachmentPreview();
    }

    try { messageInput.focus(); } catch { /* ignore */ }

    // 尽力把主窗口带到前台（扩展弹窗操作时 OpenFlux 可能在后台）
    import('@tauri-apps/api/window')
        .then(({ getCurrentWindow }) => getCurrentWindow().setFocus())
        .catch(() => { /* 非 Tauri 环境忽略 */ });

    try { setStatus(t('recording.forwarded') || '已接收 Chrome 录制，发送即可回放', 'running'); } catch { /* ignore */ }
}

/** 设计画布「按标注生成」：切到设计师 Agent，预填指令并自动发送 */
async function handleCanvasPrompt(payload: { text?: string }): Promise<void> {
    const text = (payload?.text || '').trim()
        || '请读取画布上带标注的图片，按框选区域与箭头说明生成/修改图片并放回画布。';
    // 切换到「设计师」Agent（具备 design_canvas / generate_image 能力）
    try {
        if (gatewayClient) {
            const agents = await gatewayClient.getAgents();
            const designer = (agents as Array<{ id: string; name?: string }>).find(
                a => a.name === '设计师' || /设计/.test(a.name || ''),
            );
            if (designer && currentAgentId !== designer.id) {
                await switchToAgent(designer.id);
            }
        }
    } catch { /* 切换失败则沿用当前 Agent */ }

    messageInput.value = text;
    try { messageInput.dispatchEvent(new Event('input', { bubbles: true })); } catch { /* ignore */ }
    try { messageInput.focus(); } catch { /* ignore */ }
    // 点击发生在画布窗口，把主窗口带到前台
    import('@tauri-apps/api/window')
        .then(({ getCurrentWindow }) => getCurrentWindow().setFocus())
        .catch(() => { /* 非 Tauri 环境忽略 */ });

    sendMessage();
}

// (DOM )
let lastSendTime = 0;
function sendMessage(): void {
    // Anti-resend: disallow re-triggering within 500ms (prevents double-click, Enter + click firing together, etc.)
    const now = Date.now();
    if (now - lastSendTime < 500) return;
    lastSendTime = now;

    const content = messageInput.value.trim();
    if (!content && pendingAttachments.length === 0) return;
    const delivery = getRequestedDelivery();
    const submissionId = crypto.randomUUID();
    const targetSessionId = currentSessionId;
    const targetActive = targetSessionId ? activeTurnBySession.get(targetSessionId) : undefined;
    const targetWorkState = targetSessionId ? workStateBySession.get(targetSessionId) : undefined;
    const targetWorkMode = targetWorkState?.mode || newSessionWorkMode;

    // TTS(=
    streamingTtsManager.cancel();

    // 录制 chip 不作为文件附件下发，而是把回放/引用指令注入到发送内容里
    const recordingAtts = pendingAttachments.filter(a => a.type === 'recording');
    const fileAtts = pendingAttachments.filter(a => a.type !== 'recording');

    // 实际下发给 Agent 的内容：
    // - 用户没写指令 → 默认只回放（明确禁止转 workflow/skill / 乱开网站）
    // - 用户写了指令 → 尊重用户指令，仅附上录制引用，由用户驱动（可让其转 workflow/skill）
    let effectiveContent = content;
    if (recordingAtts.length > 0) {
        const refs = recordingAtts.map(a => `「${a.name}」(录制ID: ${a.recordingId})`).join('、');
        if (content) {
            effectiveContent = `${content}\n\n相关录制：${refs}（可用 browser_recording 工具操作）`;
        } else {
            effectiveContent = `请只用 browser_recording 工具的 replay 动作回放录制 ${refs}；不要转换成 workflow 或 skill，也不要打开其它网站。`;
        }
    }

    // Collect an attachment snapshot (clear the preview area right after sending)
    const attachments = fileAtts.map(a => ({
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

    messageInput.value = '';
    messageInput.style.height = 'auto';

    if (targetSessionId) {
        pendingFollowUpSubmissions.set(submissionId, {
            sessionId: targetSessionId,
            delivery,
            displayContent: content,
            attachments: messageAttachments.length > 0 ? messageAttachments : undefined,
            rendered: delivery === 'new',
        });
    }

    if (delivery === 'new') {
        if (targetSessionId) {
            userStoppedSessions.delete(targetSessionId);
            followUpController.beginOptimistic(targetSessionId, submissionId);
            loadingSessions.add(targetSessionId);
            chatTargetSessionIds.add(targetSessionId);
            setSessionRuntimeState(targetSessionId, 'running', { label: t('chat.thinking') });
        }
        addMessage({
            id: `msg-${submissionId}`,
            role: 'user',
            content,
            createdAt: Date.now(),
            attachments: messageAttachments.length > 0 ? messageAttachments : undefined,
            metadata: { submissionId },
        });
        rememberRenderedSubmission(submissionId);
        showTyping();
    }

    updateSendButtonState();
    syncTitlebarStatusFromCurrentSession();

    setTimeout(() => sendMessageAsync({
        content: effectiveContent,
        displayContent: content,
        attachments,
        messageAttachments,
        submissionId,
        delivery,
        targetSessionId,
        targetTurnId: targetActive?.turnId,
        targetRunId: targetActive?.runId,
        source: currentCloudChatroomId ? 'cloud' : 'local',
        chatroomId: currentCloudChatroomId ?? undefined,
        agentId: currentAgentId ?? undefined,
        approvalMode: getSessionApprovalMode(targetSessionId),
        mode: targetWorkMode,
        planId: targetWorkState?.plan?.id,
        planRevision: targetWorkState?.plan?.revision,
    }), 0);
}

interface SendMessageRequest {
    content: string;
    displayContent: string;
    attachments: Array<{ path: string; name: string; size: number; ext: string }>;
    messageAttachments: MessageAttachment[];
    submissionId: string;
    delivery: ChatDelivery;
    targetSessionId: string | null;
    targetTurnId?: string;
    targetRunId?: string;
    source: 'local' | 'cloud';
    chatroomId?: number;
    agentId?: string;
    approvalMode: ApprovalMode;
    mode: WorkMode;
    planId?: string;
    planRevision?: number;
}

function userFacingErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim()) return error.message.trim();
    if (typeof error === 'string' && error.trim()) return error.trim();
    if (error && typeof error === 'object') {
        const record = error as Record<string, unknown>;
        for (const key of ['message', 'error', 'reason']) {
            if (typeof record[key] === 'string' && record[key].trim()) return record[key].trim();
        }
    }
    if (runtime?.state === 'waiting_input' || runtime?.state === 'awaiting_plan_approval') {
        setStatus(runtime.label, 'ready');
        return;
    }
    return t('common.unknown_error');
}

async function sendMessageAsync(request: SendMessageRequest): Promise<void> {
    let sendSessionId = request.targetSessionId;

    try {
        if (!sendSessionId) {
            await createSessionSilent();
            sendSessionId = currentSessionId;
        }
        if (!sendSessionId) throw new Error('Unable to create a session');

        if (!pendingFollowUpSubmissions.has(request.submissionId)) {
            pendingFollowUpSubmissions.set(request.submissionId, {
                sessionId: sendSessionId,
                delivery: request.delivery,
                displayContent: request.displayContent,
                attachments: request.messageAttachments.length > 0 ? request.messageAttachments : undefined,
                rendered: request.delivery === 'new',
            });
        }

        if (request.delivery === 'new') {
            userStoppedSessions.delete(sendSessionId);
            sessionCompletedOutputs.delete(sendSessionId);
            chatTargetSessionIds.add(sendSessionId);
            loadingSessions.add(sendSessionId);
            if (!followUpController.isSubmissionActive(sendSessionId, request.submissionId)) {
                followUpController.beginOptimistic(sendSessionId, request.submissionId);
            }
            setSessionRuntimeState(sendSessionId, 'running', { label: t('chat.thinking') });
            if (currentSessionId === sendSessionId) {
                currentProgressCard = null;
                progressItems = [];
            }
        }

        if (!gatewayClient) throw new Error('Gateway 未连接');

        await gatewayClient.submitChat(
            request.content,
            sendSessionId,
            request.attachments.length ? request.attachments : undefined,
            {
                source: request.source,
                chatroomId: request.chatroomId,
                agentId: request.agentId,
                approvalMode: request.approvalMode,
                mode: request.mode,
                planId: request.planId,
                planRevision: request.planRevision,
                delivery: request.delivery,
                targetTurnId: request.targetTurnId,
                targetRunId: request.targetRunId,
                submissionId: request.submissionId,
                fallback: request.delivery === 'steer' ? 'queue' : undefined,
            },
        );
    } catch (error) {
        const errorMessage = userFacingErrorMessage(error);
        const stillInSameSession = currentSessionId === sendSessionId;
        if (sendSessionId && request.delivery === 'new'
            && followUpController.isSubmissionActive(sendSessionId, request.submissionId)) {
            followUpController.complete({ sessionId: sendSessionId, submissionId: request.submissionId });
            chatTargetSessionIds.delete(sendSessionId);
            loadingSessions.delete(sendSessionId);
            setSessionRuntimeState(sendSessionId, 'error', {
                label: t('common.error'),
                lastError: errorMessage,
            });
        }

        if (stillInSameSession) {
            hideTyping();
            if (request.delivery === 'new') finishProgressCard();
            console.error('Chat failed:', error);
            syncTitlebarStatusFromCurrentSession();

            addMessage({
                id: `msg-${Date.now()}`,
                role: 'assistant',
                content: `抱歉，发生了错误：${errorMessage}`,
                createdAt: Date.now(),
            });
        } else {
            console.error('Chat failed (session switched):', error);
        }
        pendingFollowUpSubmissions.delete(request.submissionId);
    } finally {
        // Promise settlement is not a terminal state. Only typed turn events may
        // clear the active UI; an old Promise may settle after a newer run began.
        if (sendSessionId === currentSessionId) {
            updateSendButtonState();
            syncTitlebarStatusFromCurrentSession();
        }
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

let scrollToBottomFrameId: number | null = null;
let conversationNavigationPausedUntil = 0;

function isConversationNavigationPaused(): boolean {
    return Date.now() < conversationNavigationPausedUntil;
}

function pauseConversationAutoFollow(durationMs = 1400): void {
    conversationNavigationPausedUntil = Math.max(
        conversationNavigationPausedUntil,
        Date.now() + durationMs,
    );
    if (scrollToBottomFrameId !== null) {
        cancelAnimationFrame(scrollToBottomFrameId);
        scrollToBottomFrameId = null;
    }
    activityView.pauseAutoFollow(durationMs);
}

function isNearMessagesBottom(threshold = 160): boolean {
    if (isConversationNavigationPaused()) return false;
    const distance = messagesContainer.scrollHeight
        - messagesContainer.scrollTop
        - messagesContainer.clientHeight;
    return distance <= threshold;
}

// Scroll to bottom. Coalesce repeated requests from token/activity updates into
// one layout write and avoid restarting a smooth-scroll animation every frame.
function scrollToBottom(): void {
    if (isConversationNavigationPaused()) return;
    if (scrollToBottomFrameId !== null) return;
    scrollToBottomFrameId = requestAnimationFrame(() => {
        scrollToBottomFrameId = null;
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    });
}

// Format time
// Auto-adjust the input box height
function autoResize(): void {
    messageInput.style.height = 'auto';
    messageInput.style.height = Math.min(messageInput.scrollHeight, 200) + 'px';
}

interface ToolApprovalRequest {
    requestId: string;
    toolName: string;
    args?: Record<string, unknown>;
    riskLevel?: number;
    riskLabel?: string;
    reason?: string;
    sessionId?: string;
    turnId?: string;
}

const SENSITIVE_APPROVAL_KEY = /(password|passphrase|secret|token|api[_-]?key|authorization|cookie|credential|private[_-]?key)/i;
const DESKTOP_INSTANCE_STORAGE_KEY = 'openflux.desktop.instance-id';
interface PendingToolApproval {
    gateway: GatewayClient;
    payload: ToolApprovalRequest;
}

const pendingToolApprovals = new Map<string, PendingToolApproval>();
const submittedToolApprovalDecisions = new Map<string, boolean>();
const completedToolApprovalIds = new Set<string>();

function getDesktopGatewayInstanceId(): string {
    try {
        const stored = localStorage.getItem(DESKTOP_INSTANCE_STORAGE_KEY)?.trim();
        if (stored && /^[A-Za-z0-9._:-]{1,128}$/.test(stored)) return stored;
        const created = crypto.randomUUID();
        localStorage.setItem(DESKTOP_INSTANCE_STORAGE_KEY, created);
        return created;
    } catch {
        return crypto.randomUUID();
    }
}

function redactApprovalValue(value: unknown, key: string = '', depth: number = 0): unknown {
    if (SENSITIVE_APPROVAL_KEY.test(key)) return t('approval.redacted');
    if (depth >= 5) return t('approval.truncated');

    if (typeof value === 'string') {
        const redacted = value
            .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer ***')
            .replace(/\b(?:sk|ghp|github_pat|xox[baprs])-[-A-Za-z0-9_]{8,}\b/gi, '***')
            .replace(/\b(password|passphrase|secret|token|api[_-]?key)\s*[:=]\s*([^\s,;]+)/gi, '$1=***');
        return redacted.length > 240 ? `${redacted.slice(0, 237)}...` : redacted;
    }

    if (Array.isArray(value)) {
        const values = value.slice(0, 20).map(item => redactApprovalValue(item, key, depth + 1));
        if (value.length > values.length) values.push(t('approval.truncated'));
        return values;
    }

    if (value && typeof value === 'object') {
        const output: Record<string, unknown> = {};
        const entries = Object.entries(value as Record<string, unknown>);
        for (const [childKey, childValue] of entries.slice(0, 40)) {
            output[childKey] = redactApprovalValue(childValue, childKey, depth + 1);
        }
        if (entries.length > 40) output._more = t('approval.truncated');
        return output;
    }

    return value;
}

function formatApprovalArgs(args?: Record<string, unknown>): string {
    if (!args || Object.keys(args).length === 0) return t('approval.no_args');
    try {
        const preview = JSON.stringify(redactApprovalValue(args), null, 2);
        return preview.length > 1200 ? `${preview.slice(0, 1197)}...` : preview;
    } catch {
        return t('approval.unavailable_args');
    }
}

function formatApprovalRisk(payload: ToolApprovalRequest): string {
    if (payload.riskLabel) {
        const localizedLabel = ['none', 'low', 'medium', 'high'].includes(payload.riskLabel)
            ? t(`approval.risk_${payload.riskLabel}`)
            : payload.riskLabel;
        return payload.riskLevel !== undefined
            ? `${localizedLabel} (${payload.riskLevel})`
            : localizedLabel;
    }
    return payload.riskLevel !== undefined
        ? String(payload.riskLevel)
        : t('approval.unknown_risk');
}

function rememberCompletedToolApproval(requestId: string): void {
    completedToolApprovalIds.add(requestId);
    if (completedToolApprovalIds.size <= 256) return;
    const oldest = completedToolApprovalIds.values().next().value as string | undefined;
    if (oldest) completedToolApprovalIds.delete(oldest);
}

function sendToolApprovalDecision(
    gw: GatewayClient,
    payload: ToolApprovalRequest,
    approved: boolean,
): void {
    if (completedToolApprovalIds.has(payload.requestId)) return;
    // Only an explicit click in the activity card reaches this function. Once
    // settled, ignore duplicate clicks but retain the choice so a replayed
    // request after reconnect can receive the exact same decision.
    if (submittedToolApprovalDecisions.has(payload.requestId)) return;
    pendingToolApprovals.delete(payload.requestId);
    submittedToolApprovalDecisions.set(payload.requestId, approved);
    activityView.clearApproval(payload.requestId);
    gw.sendMessage({
        type: 'tool.approval.resolve',
        id: payload.requestId,
        payload: {
            requestId: payload.requestId,
            decision: approved ? 'approved' : 'denied',
        },
    });
}

function closeToolApprovalUi(requestId: string): void {
    pendingToolApprovals.delete(requestId);
    submittedToolApprovalDecisions.delete(requestId);
    rememberCompletedToolApproval(requestId);
    activityView.clearApproval(requestId);
}

function handleToolApprovalGatewayMessage(
    gw: GatewayClient,
    message: { type: string; payload?: unknown },
): void {
    if (message.type === 'tool.approval.request' && message.payload) {
        enqueueToolApproval(gw, message.payload as ToolApprovalRequest);
        return;
    }
    if (message.type === 'tool.approval.closed' && message.payload) {
        const requestId = (message.payload as { requestId?: string }).requestId;
        if (requestId) closeToolApprovalUi(requestId);
    }
}

function enqueueToolApproval(gw: GatewayClient, payload: ToolApprovalRequest): void {
    if (!payload.requestId || !payload.toolName) {
        console.warn('[Approval] Ignoring malformed approval request', payload);
        return;
    }
    if (completedToolApprovalIds.has(payload.requestId)) return;

    const submittedDecision = submittedToolApprovalDecisions.get(payload.requestId);
    if (submittedDecision !== undefined) {
        // At-least-once response across a reconnect: if the first response was
        // lost with the socket, a replay of the request resends the same choice.
        gw.sendMessage({
            type: 'tool.approval.resolve',
            id: payload.requestId,
            payload: {
                requestId: payload.requestId,
                decision: submittedDecision ? 'approved' : 'denied',
            },
        });
        return;
    }
    // Replayed requests update the active socket and payload in place. The
    // ActivityView upserts by requestId, so this never creates duplicate cards.
    pendingToolApprovals.set(payload.requestId, { gateway: gw, payload });

    const risk = formatApprovalRisk(payload);
    const reason = payload.reason || t('approval.no_reason');
    const argsPreview = formatApprovalArgs(payload.args);
    activityView.presentApproval({
        requestId: payload.requestId,
        sessionId: payload.sessionId,
        turnId: payload.turnId,
        toolName: payload.toolName,
        risk,
        reason,
        argsPreview,
    }, (approved) => {
        const pending = pendingToolApprovals.get(payload.requestId);
        if (!pending) return;
        sendToolApprovalDecision(pending.gateway, pending.payload, approved);
    });
}

function stopCurrentTask(): void {
    const sessionId = currentSessionId;
    if (!sessionId || !gatewayClient) return;
    const retired = followUpController.retireForStop(sessionId);
    lastSendTime = 0;

    // Logical cancellation is immediate. A provider may continue remotely, but
    // its late events are fenced by the retired turn/run identity.
    loadingSessions.delete(sessionId);
    chatTargetSessionIds.delete(sessionId);
    sessionStreamBuffers.delete(sessionId);
    sessionProvisionalStreamIds.delete(sessionId);
    setSessionRuntimeState(sessionId, 'stopped', { label: t('chat.stop') });
    const hasQueuedFollowUps = (queueStateBySession.get(sessionId)?.items.length ?? 0) > 0;
    if (hasQueuedFollowUps) followUpController.markQueuePaused(sessionId, true);
    hideTyping();
    finishProgressCard();
    addMessage({
        id: `msg-stop-${Date.now()}`,
        role: 'assistant',
        content: `⏹️ ${hasQueuedFollowUps ? t('follow_up.stop_hint') : t('activity.interrupted_short')}`,
        createdAt: Date.now(),
    });
    renderFollowUpQueue();
    updateSendButtonState();
    syncTitlebarStatusFromCurrentSession();

    void gatewayClient.stopTask(sessionId, retired?.turnId, retired?.runId, retired?.submissionId)
        .then(ack => {
            if (ack.matched) return;
            console.warn('[UI] Gateway did not match the requested active turn; refreshing runtime', {
                sessionId,
                retired,
            });
            setStatus(t('follow_up.queue_update_failed'), 'error');
            void refreshFollowUpRuntime(sessionId, true);
        })
        .catch(error => {
            const message = userFacingErrorMessage(error);
            console.error('[UI] Stop request failed after retry:', error);
            setSessionRuntimeState(sessionId, 'error', {
                label: t('common.error'),
                lastError: message,
            });
            if (currentSessionId === sessionId) {
                addMessage({
                    id: `msg-stop-error-${Date.now()}`,
                    role: 'assistant',
                    content: `停止请求未送达 Gateway：${message}`,
                    createdAt: Date.now(),
                });
            }
            void refreshFollowUpRuntime(sessionId, true);
        });
    console.log('[UI] Precise task stop requested:', sessionId, retired?.turnId, retired?.runId);
}

// One primary action: pause an active task when the composer is empty; send
// (and automatically queue) as soon as it contains text or attachments.
sendBtn.addEventListener('click', () => {
    const hasComposerPayload = messageInput.value.trim().length > 0 || pendingAttachments.length > 0;
    const primaryAction = resolveComposerPrimaryAction({
        running: isSessionFollowUpRunning(currentSessionId),
        hasPayload: hasComposerPayload,
        sendBlocked: !!currentCloudChatroomId && !openfluxLoggedIn,
    });
    if (primaryAction === 'stop') {
        // After a send, the composer clears synchronously and this same button
        // becomes Stop. Ignore the second click of a send double-click instead
        // of accidentally cancelling the active task.
        if (Date.now() - lastSendTime < 500) return;
        stopCurrentTask();
        return;
    }
    if (primaryAction === 'disabled') return;
    sendMessage();
});
// newSessionBtn now creates an Agent (handler registered in the Agent management area)

// Keyboard: Enter sends; Shift+Enter inserts a newline.

messageInput.addEventListener('input', () => {
    autoResize();
    updateSendButtonState();
});

// Plan previews and attachments share the existing standalone file previewer.
messagesContainer.addEventListener('click', (e) => {
    const planPreview = (e.target as HTMLElement).closest<HTMLElement>('.plan-document-preview[data-plan-file-path]');
    if (planPreview?.dataset.planFilePath) {
        void openFilePreview(planPreview.dataset.planFilePath);
        return;
    }
    const attachment = (e.target as HTMLElement).closest('.msg-attach-item[data-path]') as HTMLElement | null;
    if (attachment) {
        const filePath = attachment.dataset.path;
        if (filePath) openFilePreview(filePath);
    }
});

messagesContainer.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const planPreview = (event.target as HTMLElement).closest<HTMLElement>('.plan-document-preview[data-plan-file-path]');
    if (!planPreview?.dataset.planFilePath) return;
    event.preventDefault();
    void openFilePreview(planPreview.dataset.planFilePath);
});


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

// Tauri native drag: get the absolute file path. The localhost browser test
// surface has no Tauri WebView handle, so native drag registration must degrade
// gracefully instead of aborting the rest of renderer initialization.
try {
    const currentWebview = getCurrentWebview();
    void currentWebview.onDragDropEvent(async (event) => {
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
    }).catch((error) => {
        console.debug('[DragDrop] Native WebView drag events unavailable:', error);
    });
} catch (error) {
    console.debug('[DragDrop] Native WebView drag events unavailable:', error);
}

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
        updateSendButtonState();
        return;
    }

    attachmentPreview.classList.remove('hidden');
    attachmentPreview.innerHTML = pendingAttachments.map((a, idx) => {
        // Image: show thumbnail; other types: show a text icon
        const iconHtml = a.thumbnailUrl
            ? `<img class="attachment-thumb" src="${a.thumbnailUrl}" alt="${escapeHtml(a.name)}" />`
            : `<div class="attachment-icon ${getAttachmentIconClass(a.ext)}">${getAttachmentIconLabel(a.ext)}</div>`;
        const isRec = a.type === 'recording';
        const subLabel = isRec ? `${a.size} 步` : formatAttachmentSize(a.size);
        const titleAttr = isRec
            ? `${escapeHtml(a.name)}\n录制 · ${a.size} 步${a.startUrl ? '\n' + escapeHtml(a.startUrl) : ''}`
            : `${escapeHtml(a.name)}\n${formatAttachmentSize(a.size)}`;
        return `
            <div class="attachment-item${a.thumbnailUrl ? ' has-thumb' : ''}${isRec ? ' is-recording' : ''}" title="${titleAttr}">
                ${iconHtml}
                <span class="attachment-name">${escapeHtml(a.name)}${isRec ? ` <span class="attachment-sub">${subLabel}</span>` : ''}</span>
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
    updateSendButtonState();
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

function syncArtifactsToggleState(): void {
    const expanded = !artifactsPanel.classList.contains('collapsed');
    artifactsToggle.classList.toggle('active', expanded);
    artifactsToggle.setAttribute('aria-pressed', expanded ? 'true' : 'false');
}

// Collapse/expand the artifacts panel
artifactsToggle.addEventListener('click', () => {
    const expanding = artifactsPanel.classList.contains('collapsed');
    setArtifactPanelExpanded(
        artifactsPanel,
        expanding,
        localStorage.getItem('artifacts-panel-width'),
    );
    syncArtifactsToggleState();
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
    setArtifactPanelExpanded(
        artifactsPanel,
        !artifactsPanel.classList.contains('collapsed'),
        savedAW,
    );
    syncArtifactsToggleState();

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
// Whether standalone mode is reachable for this brand. When a brand's enabled modes exclude
// 'standalone' (e.g. XCXD is managed-only), standalone-only config (provider keys, orchestration/
// execution models, web-search key) is hidden entirely instead of just grayed out, so users are
// not shown fields they can never use.
let standaloneModeAvailable = true;
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
    // White-label: when service addresses are locked, keep the Router/connections config
    // reachable (read-only) regardless of work mode, so the baked-in addresses stay visible.
    const lockServices = document.body.classList.contains('brand-lock-services');
    const showRouterConfig = showRouterTab || lockServices;
    const nexusAccountSection = document.getElementById('nexusai-account-section');
    const routerTab = settingsView.querySelector('.settings-tab[data-tab="connections"]') as HTMLButtonElement | null;
    const routerContent = document.getElementById('settings-tab-connections');
    const routerConfigSection = document.getElementById('router-config-section');
    const routerManagedConfig = document.getElementById('router-managed-config');
    if (nexusAccountSection) {
        nexusAccountSection.style.display = mode === 'managed' ? '' : 'none';
    }
    if (routerTab) {
        routerTab.style.display = showRouterConfig ? '' : 'none';
    }
    if (routerConfigSection) {
        routerConfigSection.style.display = showRouterConfig ? '' : 'none';
    }
    if (routerManagedConfig) {
        routerManagedConfig.style.display = showRouterTab ? '' : 'none';
    }
    if (!showRouterConfig && routerContent?.classList.contains('active')) {
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

    // Standalone-only config: gray it out when running router/managed, but if the brand never allows
    // standalone (e.g. XCXD managed-only) hide it entirely so users aren't shown unusable fields.
    const applyStandaloneOnlyGroup = (el: HTMLElement | null, label: string): void => {
        if (!el) return;
        // Brand never allows standalone (e.g. XCXD managed-only): always show the managed-mode
        // (grayed-out) styling regardless of the current mode. Managed mode requires login; while not
        // logged in the UI temporarily falls back to 'standalone', but for such brands these fields
        // should still look locked/managed rather than become editable standalone inputs.
        if (!standaloneModeAvailable) {
            el.style.display = '';
            setManagedOverlay(el, true, label);
        } else {
            el.style.display = '';
            setManagedOverlay(el, isRouterOrManaged, label);
        }
    };
    const managedLabel = mode === 'router' ? routerManaged : nexusManaged;
    applyStandaloneOnlyGroup(orchGroup, managedLabel);
    // 执行模型已废弃（未接线，Agent 实际跑编排模型或单个 Agent 的独立覆盖），始终隐藏，避免被这里重新显示
    if (execGroup) execGroup.style.display = 'none';
    applyStandaloneOnlyGroup(keysParent as HTMLElement | null, managedLabel);

    // --- Tools tab: Web search API key ---
    const webSearchGroup = document.getElementById('server-web-search-provider')?.closest('.settings-model-group') as HTMLElement | null;
    applyStandaloneOnlyGroup(webSearchGroup, managedLabel);

    // --- Model tab: image generation model (standalone editable; team/managed provided by platform -> locked) ---
    // Managed-only brands keep the locked/managed styling even when falling back to standalone before login.
    const imageModelSection = document.getElementById('image-model-section') as HTMLElement | null;
    setManagedOverlay(imageModelSection, isRouterOrManaged || !standaloneModeAvailable,
        mode === 'router' ? routerManaged : nexusManaged);

    // --- Model tab: Agent standalone model config (shown only in standalone mode) ---
    const agentModelSection = document.getElementById('agent-model-section');
    if (agentModelSection) {
        // Standalone-only; hide for managed-only brands even when temporarily falling back to standalone (not logged in).
        agentModelSection.style.display = (mode === 'standalone' && standaloneModeAvailable) ? '' : 'none';
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
        // White-label: locked items stay visible but are not operable
        if (document.body.classList.contains('brand-lock-workmode')) return;
        if (card.classList.contains('locked')) return;
        const mode = card.dataset.mode as WorkingMode;
        if (mode && mode !== currentWorkingMode) {
            applyWorkingMode(mode);
        }
    });
});

// Initialize and apply the current mode
applyWorkingMode(currentWorkingMode);

// White-label: apply work mode (default / allowed set / lock) and service-address lock from the brand config.
// initBrand is async; the work mode is already initialized from localStorage at module load, so correct it here once the brand is ready.
document.addEventListener('brand-loaded', (e: Event) => {
    const brand = (e as CustomEvent).detail as import('./brand').BrandConfig | undefined;
    if (!brand) return;

    // —— Work mode ——
    const wm = brand.workModes;
    if (wm) {
        const def = wm.default as WorkingMode | undefined;
        const defValid = !!(def && VALID_MODES.includes(def));
        const stored = localStorage.getItem('openflux-working-mode') as WorkingMode | null;
        const hasStored = !!(stored && VALID_MODES.includes(stored));

        // Locked: force the default mode; unlocked: use the default only when the user has not chosen yet
        if (wm.lockMode && defValid) {
            applyWorkingMode(def!);
        } else if (!hasStored && defValid) {
            applyWorkingMode(def!);
        }

        // Allowed set: keep visible but lock modes not in `enabled` (non-operable, not hidden)
        const enabled = Array.isArray(wm.enabled) && wm.enabled.length
            ? (wm.enabled as string[]).filter((m): m is WorkingMode => VALID_MODES.includes(m as WorkingMode))
            : null;
        if (enabled && enabled.length) {
            // Standalone-only config is hidden entirely when the brand doesn't enable standalone.
            standaloneModeAvailable = enabled.includes('standalone');
            // If the current mode is disabled (e.g. a previously stored choice), switch
            // to an allowed mode so a locked card never stays active/highlighted.
            if (!enabled.includes(currentWorkingMode)) {
                const fallback = defValid && enabled.includes(def!) ? def! : enabled[0];
                applyWorkingMode(fallback);
            } else {
                // Current mode already allowed: re-apply so standalone-only sections hide/show correctly.
                applyWorkingMode(currentWorkingMode);
            }
            workingModeCards.forEach(card => {
                const mode = card.dataset.mode as WorkingMode;
                card.classList.toggle('locked', !enabled.includes(mode));
            });
        }

        // Locked: lock every non-current card and block switching (visible but not operable)
        if (wm.lockMode) {
            document.body.classList.add('brand-lock-workmode');
            workingModeCards.forEach(card => {
                if (card.dataset.mode !== currentWorkingMode) card.classList.add('locked');
            });
        }
    }

    // —— Brand default agent name: pre-fill the first-run wizard name field (user can still edit) ——
    const brandAgentName = brand.agents?.defaultName?.trim();
    if (brandAgentName) {
        const setupAgentName = document.getElementById('setup-agent-name') as HTMLInputElement | null;
        if (setupAgentName) setupAgentName.value = brandAgentName;
    }

    // —— Service-address lock: keep Router connection config visible but read-only (URL/AppID/Key are baked-in) ——
    if (brand.services?.lockServices) {
        document.body.classList.add('brand-lock-services');
        const routerSection = document.getElementById('router-config-section');
        if (routerSection) {
            routerSection.querySelectorAll('input, select, textarea, button').forEach(el => {
                (el as HTMLInputElement | HTMLButtonElement).disabled = true;
            });
            // Insert a one-time "managed/locked" hint at the top of the section
            if (!document.getElementById('router-lock-hint')) {
                const hint = document.createElement('div');
                hint.id = 'router-lock-hint';
                hint.className = 'brand-lock-hint';
                hint.textContent = t('cloud.locked_by_brand') || '🔒 服务地址由企业版内置，不可修改';
                routerSection.insertBefore(hint, routerSection.firstChild);
            }
        }
        // Refresh so the connections tab/Router config become reachable under the current mode
        updateModeScopedSettingsVisibility(currentWorkingMode);
    }
});

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
    dashscope: '阿里云百炼 (通义千问)',
    google: 'Google',
    ollama: 'Ollama',
    custom: 'Custom',
};

/** Translation keys for provider names that differ by locale. */
const PROVIDER_NAME_I18N_KEYS: Record<string, string> = {
    zhipu: 'settings.provider_zhipu',
    dashscope: 'settings.provider_dashscope',
    ollama: 'settings.provider_ollama_local',
    custom: 'settings.provider_custom',
};

function getProviderDisplayName(name: string): string {
    const i18nKey = PROVIDER_NAME_I18N_KEYS[name];
    return i18nKey ? t(i18nKey) : (PROVIDER_NAMES[name] || name);
}

function refreshProviderNameLabels(): void {
    document.querySelectorAll<HTMLElement>('[data-provider-name]').forEach((element) => {
        const provider = element.dataset.providerName;
        if (provider) element.textContent = getProviderDisplayName(provider);
    });
}

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
            // Keep built-in providers available even when an older deployment
            // supplies a preset list that does not know about newer providers.
            providerModels = { ...providerModels, ...cfg.presetModels };
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

        // Image generation model
        const img = (cfg as any).imageGeneration as
            | { provider?: string; model?: string; apiKey?: string; baseUrl?: string; size?: string }
            | undefined;
        const imgProvider = img?.provider === 'gemini' ? 'gemini' : 'openai';
        if (serverImageProvider) serverImageProvider.value = imgProvider;
        // Model/size are fixed dropdowns; populate per provider and select saved values.
        populateImageOptions(imgProvider, img?.model, img?.size);
        if (serverImageApiKey) {
            serverImageApiKey.value = '';
            serverImageApiKey.placeholder = img?.apiKey || t('settings.enter_apikey');
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
    const keyProviders = ['anthropic', 'openai', 'minimax', 'deepseek', 'zhipu', 'moonshot', 'dashscope'];

    for (const name of keyProviders) {
        const info = providers[name] || {};
        const hasKey = !!info.apiKey && info.apiKey !== '';
        const displayName = getProviderDisplayName(name);

        const item = document.createElement('div');
        item.className = 'settings-provider-key-item';

        const header = document.createElement('div');
        header.className = 'settings-provider-key-header';
        header.innerHTML = `
            <span class="settings-provider-key-name" data-provider-name="${name}">${displayName}</span>
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
            // 网关下发的进度话术仅中文，展示前按本地映射转成界面语言
            serverSaveHint.textContent = tServerCopy(msg.payload.step);
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
        // 执行模型已废弃且未接线（Agent 实际跑编排模型，或下方单个 Agent 的独立覆盖）。
        // 这里让 execution 始终跟随 orchestration，保证 config.llm.execution 与编排模型一致，避免歧义。
        updates.execution = { ...(updates.orchestration as object) };

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

        // Collect image generation model config
        if (serverImageProvider) {
            const imageUpdates: Record<string, unknown> = {
                provider: serverImageProvider.value,
                model: serverImageModel?.value || '',
                size: serverImageSize?.value || '',
            };
            // Only send the key when the user typed a new one (placeholder shows the masked existing key)
            const imageKeyVal = serverImageApiKey?.value.trim();
            if (imageKeyVal) {
                imageUpdates.apiKey = imageKeyVal;
            }
            updates.imageGeneration = imageUpdates;
        }

        // 各 Agent 的独立执行模型覆盖（来自「Agent 模型」卡片，存内存于 agentListData）。
        // 仅在已加载到卡片数据时下发，避免空数组误清空。空覆盖传 null 表示回落到编排模型。
        if (agentListData.length > 0) {
            updates.agents = {
                list: agentListData.map(a => ({
                    id: a.id,
                    model: a.provider && a.model ? { provider: a.provider, model: a.model } : null,
                })),
            };
        }

        const result = await gatewayClient.updateServerConfig(updates as any);

        if (result.success) {
            serverSaveHint.textContent = result.message ? tServerCopy(result.message) : t('common.save_success');
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
            serverSaveHint.textContent = result.message ? tServerCopy(result.message) : t('common.save_failed');
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

// ---- Chrome 录制扩展安装路径（工具 Tab）----
// 计算 <AppData>/<identifier>/data/plugins/chrome 并填入只读输入框，提供复制/打开文件夹。
(async () => {
    const pathInput = document.getElementById('chrome-ext-path') as HTMLInputElement | null;
    const copyBtn = document.getElementById('chrome-ext-path-copy');
    const openBtn = document.getElementById('chrome-ext-path-open');
    if (!pathInput) return;

    let chromeExtPath = '';
    try {
        const { appDataDir, join } = await import('@tauri-apps/api/path');
        const base = await appDataDir();
        chromeExtPath = await join(base, 'data', 'plugins', 'chrome');
        pathInput.value = chromeExtPath;
        pathInput.title = chromeExtPath;
    } catch (e) {
        console.error('[ChromeExt] 解析安装路径失败:', e);
    }

    copyBtn?.addEventListener('click', async () => {
        if (!chromeExtPath) return;
        try {
            await navigator.clipboard.writeText(chromeExtPath);
            showPluginToast('info', t('settings.chrome_ext_copied') || '路径已复制');
        } catch {
            showPluginToast('error', t('settings.chrome_ext_copy_fail') || '复制失败');
        }
    });

    openBtn?.addEventListener('click', async () => {
        if (!chromeExtPath) return;
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            await invoke('file_open', { filePath: chromeExtPath });
        } catch (e) {
            showPluginToast('error', t('settings.chrome_ext_open_fail') || '打开文件夹失败');
            console.error('[ChromeExt] 打开文件夹失败:', e);
        }
    });
})();

// ---- Global role/persona settings ----

/**
 * Load the global role/persona, skills, and Agent model
 */
async function loadAgentConfig(): Promise<void> {
    if (!gatewayClient) return;
    // 注意：不要因为 agent-name/prompt 输入框不存在就早退，
    // 否则会连带导致「Agent 模型」卡片区域无法渲染（永久空白）。
    // 下方所有赋值均已做 null 检查，缺少这些输入框时也能安全渲染模型卡片。
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
const KNOWN_PROVIDERS = ['anthropic', 'openai', 'google', 'deepseek', 'zhipu', 'moonshot', 'dashscope', 'minimax', 'ollama', 'custom'];
const AGENT_ICONS: Record<string, string> = { default: '💬', coder: '💻', automation: '🤖', presentation: '📊' };

const AGENT_MODEL_I18N_KEYS: Record<string, { name: string; description: string }> = {
    default: { name: 'agent.model_default_name', description: 'agent.model_default_desc' },
    coder: { name: 'agent.model_coder_name', description: 'agent.model_coder_desc' },
    automation: { name: 'agent.model_automation_name', description: 'agent.model_automation_desc' },
    presentation: { name: 'agent.model_presentation_name', description: 'agent.model_presentation_desc' },
    image: { name: 'agent.model_image_name', description: 'agent.model_image_desc' },
    designer: { name: 'agent.model_image_name', description: 'agent.model_image_desc' },
};

function getAgentModelDisplayText(agent: AgentModelItem): { name: string; description: string } {
    const keys = AGENT_MODEL_I18N_KEYS[agent.id];
    return keys
        ? { name: t(keys.name), description: t(keys.description) }
        : { name: agent.name, description: agent.description };
}

function getLocalAgentDisplayText(agent: LocalEntityView): { name: string; description: string } {
    const isBuiltinDesigner = agent.id === 'designer'
        && (agent.locked === true || agent.presetId === 'id:designer');
    return isBuiltinDesigner
        ? { name: t('agent.builtin_designer_name'), description: t('agent.builtin_designer_desc') }
        : { name: agent.name || agent.id, description: agent.description || '' };
}

function renderAgentModelCards(): void {
    if (!agentModelListEl) return;
    agentModelListEl.innerHTML = '';
    if (agentListData.length === 0) {
        agentModelListEl.innerHTML = '<div class="skills-empty">' + t('agent.model_empty') + '</div>';
        return;
    }
    for (const agent of agentListData) {
        agentModelListEl.appendChild(createAgentModelCard(agent));
    }
}

function createAgentModelCard(agent: AgentModelItem): HTMLElement {
    const displayText = getAgentModelDisplayText(agent);
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
    name.textContent = displayText.name;

    const desc = document.createElement('div');
    desc.className = 'agent-model-card-desc';
    desc.textContent = displayText.description;

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
    defaultOpt.textContent = `${t('agent.follow_global')} (${globalOrchModel.provider ? getProviderDisplayName(globalOrchModel.provider) : t('agent.not_set')})`;
    providerSelect.appendChild(defaultOpt);
    for (const p of KNOWN_PROVIDERS) {
        const opt = document.createElement('option');
        opt.value = p;
        opt.textContent = getProviderDisplayName(p);
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

const skillsListEl = document.getElementById('skills-list') as HTMLElement | null;
const skillAddBtn = document.getElementById('skill-add-btn');

function renderSkills(): void {
    if (!skillsListEl) return;
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
    const lastCard = skillsListEl?.lastElementChild as HTMLElement | null;
    if (lastCard) {
        lastCard.classList.add('expanded');
        const titleInput = lastCard.querySelector('.skill-title-input') as HTMLInputElement;
        if (titleInput) titleInput.focus();
    }
});

// 说明：原「agent-save-btn」独立保存按钮已废弃（DOM 中不存在该按钮，handler 从不执行）。
// Agent 独立执行模型现已并入「模型」标签的 server-save-btn 统一保存（见上方 updates.agents.list）。

// ---- () ----
let settingsViewActive = false;

function toggleSettingsView(): void {
    settingsViewActive = !settingsViewActive;

    if (settingsViewActive) {
        // If the scheduler view is active, switch back to chat first
        closeSchedulerView({ restoreChat: false });
        // Settings occupies the center workspace; close the artifacts panel so the
        // configuration area always has the full available width.
        if (!artifactsPanel.classList.contains('collapsed')) {
            setArtifactPanelExpanded(artifactsPanel, false);
            syncArtifactsToggleState();
        }
        // Hide chat messages and input area, show the settings view
        messagesContainer.classList.add('hidden');
        (document.querySelector('.input-area') as HTMLElement).classList.add('hidden');
        hideRouterBindUI(); // hide the Router bind area (fixed positioning is unaffected by the parent container)
        settingsView.classList.remove('hidden');
        setSidebarActionState('settings');
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
        setSidebarActionState(null);
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
        setSidebarActionState(null);
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
        t('connections.excel_uninstall_confirm') ||
        'Confirm uninstall Excel Add-in? Excel will be force-closed.'
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
        debugPanel.style.height = `${newHeight}px`;
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

    div.innerHTML = `<span class="debug-log-time">${timeStr}</span>`
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

function discardLegacyLiveProgress(): void {
    currentProgressCard?.remove();
    currentProgressCard = null;
    progressItems = [];
    isProgressFinished = true;
}

function handleAgentEvent(event: AgentEventV1): void {
    const isActiveSession = event.sessionId === currentSessionId;
    const eventIsTerminal = event.type === 'turn.completed'
        || event.type === 'turn.failed'
        || event.type === 'turn.interrupted';
    const enrichedEvent = event as AgentEventV1 & { runId?: string; submissionId?: string };
    const identity = {
        sessionId: event.sessionId,
        turnId: event.turnId,
        runId: enrichedEvent.runId,
        submissionId: enrichedEvent.submissionId,
    };

    if (event.type === 'turn.started') {
        followUpController.observeTurnStarted(identity);
        if (identity.submissionId) {
            const pending = pendingFollowUpSubmissions.get(identity.submissionId);
            if (pending?.delivery === 'queue') {
                renderActivatedQueuedTurn(identity.submissionId, pending);
                pendingFollowUpSubmissions.delete(identity.submissionId);
            }
        }
    }
    const belongsToActiveTurn = followUpController.matchesActive(identity);

    if (belongsToActiveTurn && isActiveSession
        && (event.type === 'turn.started' || event.type.startsWith('item.'))) {
        // The structured timeline supersedes the legacy single progress card.
        discardLegacyLiveProgress();
        hideTyping();
    }

    const activityState = activityView.applyEvent(event, currentSessionId);
    const isTerminal = activityState.status !== 'running';
    sessionProgressCache.delete(event.sessionId);

    // Retired turns may still finish remotely. Their card can settle, but they
    // must never clear or relabel the newer active run for this session.
    if (!belongsToActiveTurn) return;

    if (eventIsTerminal) followUpController.complete(identity);

    if (!isTerminal) {
        loadingSessions.add(event.sessionId);
        chatTargetSessionIds.add(event.sessionId);
        setSessionRuntimeState(event.sessionId, 'running', {
            label: event.item?.title || t('activity.working'),
        });
    } else if (activityState.status === 'completed') {
        loadingSessions.delete(event.sessionId);
        chatTargetSessionIds.delete(event.sessionId);
        setSessionRuntimeState(event.sessionId, 'completed');
    } else if (activityState.status === 'failed') {
        loadingSessions.delete(event.sessionId);
        chatTargetSessionIds.delete(event.sessionId);
        setSessionRuntimeState(event.sessionId, 'error', {
            label: event.summary || t('activity.failed_short'),
            lastError: event.summary,
        });
    } else {
        userStoppedSessions.delete(event.sessionId);
        loadingSessions.delete(event.sessionId);
        chatTargetSessionIds.delete(event.sessionId);
        setSessionRuntimeState(event.sessionId, 'stopped', {
            label: event.summary || t('activity.interrupted_short'),
        });
    }

    if (isActiveSession && isTerminal) hideTyping();
    updateSendButtonState();
    syncTitlebarStatusFromCurrentSession();
}

function collectArtifactsFromToolProgress(event: GatewayProgressEvent): void {
    if (event.type !== 'tool_result' || !event.tool) return;
    const artifacts = isArtifactTool(event.tool, event.args, event.result);
    if (!artifacts) return;
    const list = Array.isArray(artifacts) ? artifacts : [artifacts];
    for (const artifact of list) {
        addArtifact(artifact).catch(error => console.error('[Artifact] Add failed:', error));
    }
}

// Gateway
function handleGatewayProgress(event: GatewayProgressEvent): void {
    // Render progress scoped to its session
    const progressEvent = event as ProgressEvent;

    // 用户手动停止后：抑制该会话残留的在途进度事件，避免在停止后又弹出一个空的执行卡片。
    // 收到 complete 时清除停止标记并继续走正常的完成清理流程。
    const stoppedSid = event.sessionId || currentSessionId || undefined;
    if (stoppedSid && userStoppedSessions.has(stoppedSid)) {
        if (event.type === 'complete') {
            userStoppedSessions.delete(stoppedSid);
        } else {
            return;
        }
    }
    const progressSessionId =
        event.sessionId && event.sessionId !== currentSessionId && currentCloudChatroomId && currentSessionId && chatTargetSessionIds.has(currentSessionId)
            ? currentSessionId
            : event.sessionId || (currentSessionId && chatTargetSessionIds.has(currentSessionId) ? currentSessionId : undefined);

    const identitySessionId = progressSessionId || event.sessionId;
    if (identitySessionId) {
        const identity = {
            sessionId: identitySessionId,
            turnId: event.turnId,
            runId: event.runId,
            submissionId: event.submissionId,
        };
        const matches = event.type === 'complete'
            ? followUpController.matchesActiveOrLatestTerminal(identity)
            : followUpController.matchesActive(identity);
        if (!matches) {
            console.debug('[FollowUp] Ignoring event from a retired or unknown run', event.type, identity);
            return;
        }
    }

    if (progressSessionId && event.type !== 'complete') {
        setSessionRuntimeState(progressSessionId, 'running', {
            // Do not expose provider reasoning/thinking in runtime status chrome.
            label: progressEvent.type === 'tool_start' ? t('activity.working') : t('chat.thinking'),
        });
    }

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
                    followUpController.complete({
                        sessionId: event.sessionId,
                        turnId: event.turnId,
                        runId: event.runId,
                        submissionId: event.submissionId,
                    });
                    chatTargetSessionIds.delete(event.sessionId);
                    loadingSessions.delete(event.sessionId);
                    setSessionRuntimeState(event.sessionId, 'completed');
                    // Clean up cache: the task has finished (完整回复已落盘，切回时从历史加载)
                    sessionProgressCache.delete(event.sessionId);
                    sessionStreamBuffers.delete(event.sessionId);
                    sessionProvisionalStreamIds.delete(event.sessionId);
                }
                updateSendButtonState();
                syncTitlebarStatusFromCurrentSession();
                // Mark this session as having unread messages
                markSessionUnread(event.sessionId);
                // 后台完成的会话：刷新所属 Agent 的子列表（更新标题/预览/未读点，所有列表默认展开）
                const ownerAgentId = event.sessionId ? sessionAgentMap.get(event.sessionId) : undefined;
                if (ownerAgentId) {
                    void refreshAgentSessions(ownerAgentId);
                }
                if (!document.hasFocus()) {
                    playTaskCompleteSound();
                    invoke('window_flash_frame', { flash: true });
                }
            } else if (event.type === 'stream_reset') {
                // Guidance may invalidate pending work, never committed output.
                if (sessionProvisionalStreamIds.has(event.sessionId)) {
                    sessionStreamBuffers.delete(event.sessionId);
                    sessionProvisionalStreamIds.delete(event.sessionId);
                }
            } else if (event.type === 'token' && event.token) {
                // 后台会话的流式 token：按会话缓冲，切回该会话时恢复已生成的部分回复
                appendSessionStreamBuffer(event.sessionId, event.token, event.provisional === true);
            } else {
                // tool_result / thinking : sessionProgressCache
                // tool_result / thinking event for a non-current session: append to sessionProgressCache
                const sid = event.sessionId;
                if (!sessionProgressCache.has(sid)) {
                    sessionProgressCache.set(sid, { items: [], title: t('app.running') });
                }
                const cached = sessionProgressCache.get(sid)!;
                const hasStructuredActivity = activityView.hasRunningTurn(sid);
                if (event.type === 'tool_result' && event.tool && !hasStructuredActivity) {
                    const log = getToolLog(event.tool, event.args);
                    const detail = getToolResultSummary(event.tool, event.args, (event as unknown as Record<string, unknown>).result);
                    cached.items.push({ icon: log.icon, text: log.text, isThinking: false, detail });
                } else if (event.type === 'tool_start' && !hasStructuredActivity) {
                    cached.title = t('activity.working');
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

    const structuredSessionId = progressSessionId || event.sessionId || currentSessionId;
    const hasStructuredActivity = activityView.hasRunningTurn(structuredSessionId);
    if (hasStructuredActivity && progressEvent.type === 'tool_result') {
        // Preserve generated-file discovery while agent.event owns the visual row.
        collectArtifactsFromToolProgress(event);
    }
    if (hasStructuredActivity && (
        progressEvent.type === 'thinking'
        || progressEvent.type === 'tool_start'
        || progressEvent.type === 'tool_result'
        || progressEvent.type === 'iteration'
    )) {
        return;
    }

    if (progressEvent.type === 'thinking' && progressEvent.thinking) {
        // Legacy providers may send private chain-of-thought here. Keep only the
        // generic busy affordance; user-facing summaries arrive via agent.event.
        showTyping();
    } else if (progressEvent.type === 'tool_start') {
        // Legacy fallback: show a deterministic status, never raw model reasoning.
        const safeTitle = t('activity.working');
        updateTypingText(safeTitle);
        updateProgressCardTitle(safeTitle);
    } else if (progressEvent.type === 'tool_result' && event.tool) {
        const log = getToolLog(event.tool, event.args);
        const detail = getToolResultSummary(event.tool, event.args, (event as unknown as Record<string, unknown>).result);
        addProgressToChat(log.icon, log.text, false, detail);

        // Generated images are persisted as Markdown in the final message (and shown there),
        // so we intentionally do NOT render an extra inline preview here to avoid duplicates.

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
    } else if (event.type === 'stream_reset') {
        // Once visible output is committed, it is immutable. A steer can reset
        // only an unpublished/provisional draft and then affect future planning.
        if (streamingContentIsProvisional) {
            if (event.sessionId) {
                sessionStreamBuffers.delete(event.sessionId);
                sessionProvisionalStreamIds.delete(event.sessionId);
            }
            discardStreamingMessage();
            showTyping();
        }
    } else if (event.type === 'token' && event.token) {
        hideTyping();
        // 同步写入会话级缓冲：切走再切回时可从缓冲恢复完整的已生成内容
        if (event.sessionId) appendSessionStreamBuffer(event.sessionId, event.token, event.provisional === true);
        appendStreamingToken(event.token, event.provisional === true);
    } else if (progressEvent.type === 'complete') {
        // Chat completed - immediate visual feedback
        console.log('[Gateway Progress Event] Chat completed');
        hideTyping();
        finishProgressCard();
        const completeSessionId = progressSessionId || event.sessionId || currentSessionId;
        const completionRuntimeState: SessionRuntimeStatus = progressEvent.status === 'waiting_input'
            ? 'waiting_input'
            : progressEvent.status === 'awaiting_plan_approval'
                ? 'awaiting_plan_approval'
                : progressEvent.status === 'failed'
                    ? 'error'
                    : 'completed';
        if (completeSessionId) {
            followUpController.complete({
                sessionId: completeSessionId,
                turnId: event.turnId,
                runId: event.runId,
                submissionId: event.submissionId,
            });
        }
        const priorCompletedOutput = completeSessionId
            ? sessionCompletedOutputs.get(completeSessionId)
            : undefined;
        const isPlanDocumentPreview = progressEvent.status === 'awaiting_plan_approval';
        let streamedOutput = '';
        if (isPlanDocumentPreview) {
            // The PlanStore Markdown file is the only plan preview surface.
            // Discard any provisional model prose so it cannot duplicate it.
            finishStreamingMessage('', false);
            const planState = completeSessionId ? workStateBySession.get(completeSessionId) : undefined;
            if (planState && completeSessionId === currentSessionId) renderLatestPlanPreviewInChat(planState);
        } else {
            streamedOutput = finishStreamingMessage(progressEvent.output, false);
            // Some providers/routes only return the canonical output on chat.complete.
            // Render it when no token delta arrived, while keeping the final answer
            // separate from the activity timeline.
            if (!streamedOutput.trim() && !priorCompletedOutput && progressEvent.output?.trim()) {
                appendStreamingToken(progressEvent.output);
                finishStreamingMessage(undefined, false);
            }
        }
        // Final-answer DOM updates and a near-simultaneous session refresh may
        // detach the structured activity root. Its reduced state is durable,
        // so synchronously reattach the completed/collapsed card for the
        // visible session instead of waiting for a session switch.
        if (completeSessionId === currentSessionId) {
            if (event.turnId) activityView.restoreTurn(completeSessionId, event.turnId);
            else activityView.restoreRunningSession(completeSessionId);
        }
        const canonicalOutput = isPlanDocumentPreview
            ? ''
            : (streamedOutput.trim() ? streamedOutput : progressEvent.output);
        if (completeSessionId && canonicalOutput?.trim()) {
            sessionCompletedOutputs.set(completeSessionId, canonicalOutput);
        }
        if (completeSessionId) {
            sessionStreamBuffers.delete(completeSessionId);
            sessionProvisionalStreamIds.delete(completeSessionId);
        }
        if (event.sessionId) {
            sessionStreamBuffers.delete(event.sessionId);
            sessionProvisionalStreamIds.delete(event.sessionId);
        }
        if (event.sessionId) {
            chatTargetSessionIds.delete(event.sessionId);
            loadingSessions.delete(event.sessionId);
            setSessionRuntimeState(event.sessionId, completionRuntimeState);
        }
        // event.sessionId differs from currentSessionId -> clean up the current session
        if (currentSessionId) {
            chatTargetSessionIds.delete(currentSessionId);
            loadingSessions.delete(currentSessionId);
            setSessionRuntimeState(completeSessionId, completionRuntimeState);
        }
        updateSendButtonState();
        syncTitlebarStatusFromCurrentSession();
        // 会话完成后刷新当前 Agent 的会话子列表（首轮回复后标题会自动生成）
        if (currentAgentId && !currentCloudChatroomId && !isRouterSession) {
            void refreshAgentSessions(currentAgentId);
        }
        // When the window is not focused: play a sound + flash the taskbar
        if (!document.hasFocus() && completionRuntimeState === 'completed') {
            playTaskCompleteSound();
            invoke('window_flash_frame', { flash: true });
        }
        // (artifacts
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
    artifactsList.innerHTML = '';

    setArtifactPanelExpanded(artifactsPanel, false);
    syncArtifactsToggleState();
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

    setArtifactPanelExpanded(
        artifactsPanel,
        true,
        localStorage.getItem('artifacts-panel-width'),
    );
    syncArtifactsToggleState();

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
                ${isImageFile(filename) ? `<button class="artifact-action-btn" data-action="canvas" title="${t('preview.open_in_canvas')}">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
                </button>` : ''}
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
                else if (action === 'canvas') sendImageToCanvas(filePath, filePath.split(/[/\\]/).pop() || undefined);
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
let previewWindowCounter = 0;

async function getNextPreviewWindowPosition(): Promise<{ center?: boolean; x?: number; y?: number }> {
    const PREVIEW_WIDTH = 820;
    const PREVIEW_HEIGHT = 620;
    const CASCADE_STEP = 28;
    const CASCADE_SLOTS = 6;
    const offset = (previewWindowCounter % CASCADE_SLOTS) * CASCADE_STEP;

    try {
        const { getCurrentWindow, currentMonitor } = await import('@tauri-apps/api/window');
        const mainWindow = getCurrentWindow();
        const [mainPosition, mainSize, mainScaleFactor, monitor] = await Promise.all([
            mainWindow.outerPosition(),
            mainWindow.outerSize(),
            mainWindow.scaleFactor(),
            currentMonitor(),
        ]);

        // Window creation coordinates use logical pixels; Tauri reports the current
        // window and monitor work area in physical pixels.
        const mainX = mainPosition.x / mainScaleFactor;
        const mainY = mainPosition.y / mainScaleFactor;
        const mainWidth = mainSize.width / mainScaleFactor;
        const mainHeight = mainSize.height / mainScaleFactor;
        let x = mainX + Math.max(24, (mainWidth - PREVIEW_WIDTH) / 2) + offset;
        let y = mainY + Math.max(24, (mainHeight - PREVIEW_HEIGHT) / 2) + offset;

        if (monitor) {
            const monitorScale = monitor.scaleFactor;
            const workX = monitor.workArea.position.x / monitorScale;
            const workY = monitor.workArea.position.y / monitorScale;
            const workWidth = monitor.workArea.size.width / monitorScale;
            const workHeight = monitor.workArea.size.height / monitorScale;
            const minX = workX + 16;
            const minY = workY + 16;
            const maxX = Math.max(minX, workX + workWidth - PREVIEW_WIDTH - 16);
            const maxY = Math.max(minY, workY + workHeight - PREVIEW_HEIGHT - 16);
            x = Math.min(Math.max(x, minX), maxX);
            y = Math.min(Math.max(y, minY), maxY);
        }

        return { x: Math.round(x), y: Math.round(y) };
    } catch (error) {
        console.warn('Failed to calculate preview window position, falling back to center:', error);
        return { center: true };
    }
}

async function openFilePreview(filePath: string): Promise<void> {
    currentPreviewPath = filePath;
    const filename = filePath.split(/[/\\]/).pop() || 'unknown';

    // Tauri WebviewWindow
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const instanceId = typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${previewWindowCounter}`;
    const winLabel = `preview-${instanceId}`;
    const position = await getNextPreviewWindowPosition();
    previewWindowCounter++;

    const previewUrl = `${window.location.origin}/preview.html?file=${encodeURIComponent(filePath)}`;

    const previewWin = new WebviewWindow(winLabel, {
        url: previewUrl,
        title: `📄 ${filename}`,
        width: 820,
        height: 620,
        minWidth: 400,
        minHeight: 300,
        ...position,
        preventOverflow: { width: 16, height: 16 },
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
    description?: string;
    artifact?: Artifact;
    token?: string;
    output?: string;
    /** LLM raw description text (tool_start events only) */
    llmDescription?: string;
    sessionId?: string;
    turnId?: string;
    runId?: string;
    submissionId?: string;
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

function cacheCurrentProgressState(sessionId: string | null | undefined): void {
    if (!sessionId || !currentProgressCard || isProgressFinished) return;
    sessionProgressCache.set(sessionId, {
        items: [...progressItems],
        title: currentProgressCard.querySelector('.progress-card-title')?.textContent || t('app.running'),
    });
}

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
                <span class="progress-card-toggle"></span>
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

/**
 * 切换回某个会话后，恢复其"正在执行"的动作进度卡片。
 * - 若有缓存的进度明细：完整重建实时卡片并恢复标题；
 * - 若任务仍在执行但没有缓存明细（例如离开过早、明细尚未产生）：仍显示一个带 loading 动画的"运行中"卡片 + 打字指示器，
 *   确保用户能明确判断任务是否还在执行（修复切换会话后动作卡片消失的问题）。
 * 该函数统一供本地会话(selectSession)、本地 Agent(switchToAgent)、云端会话(startCloudChat) 复用。
 */
function restoreRunningProgressCard(sessionId: string | null | undefined): void {
    // 重置实时进度状态（历史消息已渲染完毕后调用）
    currentProgressCard = null;
    progressItems = [];
    // 重置流式渲染状态：旧会话的流式 DOM 已随消息区重建而失效，
    // 内容不会丢——所有会话的流式 token 都在 sessionStreamBuffers 里按会话缓冲
    streamingMessageEl = null;
    streamingContent = '';
    streamingContentIsProvisional = false;
    streamingMsgId = '';
    cancelScheduledStreamingRender();
    const stillRunning = !!sessionId && loadingSessions.has(sessionId);
    isProgressFinished = !stillRunning;
    // History rendering itself restores terminal cards beside their messages.
    // Here only an in-flight turn may legitimately lack a persisted anchor.
    activityView.restoreRunningSession(sessionId);
    if (!sessionId || !stillRunning) return;

    const structuredRestored = activityView.hasRunningTurn(sessionId);
    const cachedProgress = sessionProgressCache.get(sessionId);
    if (!structuredRestored && cachedProgress && cachedProgress.items.length > 0) {
        for (const item of cachedProgress.items) {
            addProgressToChat(item.icon, item.text, item.isThinking, item.detail);
        }
        if (currentProgressCard) {
            const titleEl = (currentProgressCard as HTMLElement).querySelector('.progress-card-title') as HTMLElement;
            if (titleEl) titleEl.textContent = cachedProgress.title;
        }
    } else if (!structuredRestored) {
        // 没有明细缓存，但任务仍在执行：显示一个空的"运行中"卡片（带 loading 动画）
        const card = getProgressCard();
        const titleEl = card.querySelector('.progress-card-title') as HTMLElement;
        if (titleEl) titleEl.textContent = cachedProgress?.title || t('app.running');
    }
    sessionProgressCache.delete(sessionId);

    // 恢复已缓冲的流式回复：任务执行中切回会话，续上已生成的部分内容并继续实时渲染
    const buffered = sessionStreamBuffers.get(sessionId);
    if (buffered) {
        streamingContent = buffered;
        streamingMessageEl = createStreamingMessage();
        streamingMsgId = `streaming-${Date.now()}`;
        messagesContainer.appendChild(streamingMessageEl);
        renderStreamingMarkdown();
        scrollToBottom();
    } else if (!structuredRestored) {
        // 尚无流式内容时显示打字指示器，表明任务正在执行（完成事件会自动 hideTyping）
        showTyping();
    }
}

// Cache resolved data URLs so streaming re-renders (which rebuild innerHTML every token)
// don't re-read the same file from disk or flicker between path/data-url.
const localImageDataUrlCache = new Map<string, string>();

// Resolve local-file <img> sources (e.g. persisted generated images referenced by absolute path)
// into displayable data URLs via the file_read command. Skips http/https/data/blob sources.
async function hydrateLocalImages(container: HTMLElement | null): Promise<void> {
    if (!container) return;
    hydrateLocalFileLinks(
        container,
        { open: t('local_path.open'), reveal: t('local_path.reveal') },
        {
            open: (filePath) => invoke('file_open', { filePath })
                .catch(error => console.warn('[LocalPath] Open failed:', filePath, error)),
            reveal: (filePath) => invoke('file_reveal', { filePath })
                .catch(error => console.warn('[LocalPath] Reveal failed:', filePath, error)),
        },
    );
    const imgs = Array.from(container.querySelectorAll('img'));
    for (const img of imgs) {
        if (img.dataset.localHydrated) continue;
        const raw = (img.getAttribute('src') || '').trim();
        if (!raw || /^(https?:|data:|blob:)/i.test(raw)) continue;
        // Treat as a local path: Windows drive (D:/...), UNC, or POSIX absolute path.
        // marked percent-encodes non-ASCII path segments (e.g. Chinese folder names),
        // so decode before handing the path to the native file reader.
        let filePath = raw.replace(/^file:\/\//i, '');
        try { filePath = decodeURIComponent(filePath); } catch { /* keep raw if not valid %-encoding */ }
        if (!/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(filePath)) continue;
        img.dataset.localHydrated = '1';

        const applyDataUrl = (dataUrl: string) => {
            img.src = dataUrl;
            img.style.maxWidth = '100%';
            img.style.borderRadius = '8px';
            img.style.cursor = 'zoom-in';
            img.addEventListener('click', () => { invoke('file_open', { filePath }); });
        };

        const cached = localImageDataUrlCache.get(filePath);
        if (cached) { applyDataUrl(cached); continue; }

        try {
            const result = await invoke<{ content?: string; is_binary?: boolean; mime_type?: string }>('file_read', { filePath });
            if (result?.content && (result.content.startsWith('data:image') ||
                (result.is_binary && result.mime_type?.startsWith('image/')))) {
                localImageDataUrlCache.set(filePath, result.content);
                applyDataUrl(result.content);
            }
        } catch (err) {
            // Mid-stream the file may not exist yet; allow a later render to retry.
            img.dataset.localHydrated = '';
            console.warn('[hydrateLocalImages] failed to load', filePath, err);
        }
    }
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

    // process.run / opencode.run：仅信任后端基于目录快照(diff)+ stdout(按 mtime 过滤)
    // 得出的 generatedFiles。后端已确保只包含"本次运行真正产出/修改"的文件，
    // 因此这里不再在前端用 stdout 正则兜底（那会把被读取/引用的历史旧文件误当成当日产出）。
    if ((tool === 'process' || tool === 'opencode') && result) {
        const data = (result as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
        const generatedFiles = data?.generatedFiles as Array<{ path: string; fullPath: string; size: number; mtimeMs?: number }> | undefined;
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
                        // 用文件真实修改时间归档，缺失时回退当前时间
                        timestamp: f.mtimeMs || Date.now(),
                    });
                }
            }
        }
    }

    // Media/presentation generation tools: saved deliverables. Presentations
    // are published only after the durable workflow completion predicate passes.
    if (tool === 'generate_image' || tool === 'generate_video' || tool === 'generate_presentation') {
        const data = (result as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
        const completion = data?.completion && typeof data.completion === 'object' && !Array.isArray(data.completion)
            ? data.completion as Record<string, unknown>
            : undefined;
        const canPublish = tool !== 'generate_presentation' || completion?.complete === true;
        const files = canPublish && Array.isArray(data?.files)
            ? (data.files as unknown[]).filter((file): file is string => typeof file === 'string')
            : [];
        for (const f of files) {
            const fp = normalizePath(f);
            if (fp && !isPathAdded(fp)) {
                markPathAdded(fp);
                collected.push({
                    type: 'file',
                    path: fp,
                    filename: fp.split(/[/\\]/).pop()
                        || (tool === 'generate_video' ? '视频.mp4' : tool === 'generate_presentation' ? '演示文稿' : '图片'),
                    timestamp: Date.now(),
                });
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
const schedulerRuntimeErrorTimers = new Map<string, ReturnType<typeof setTimeout>>();

function getWaitingSchedulerTaskCount(tasks: ScheduledTaskView[]): number {
    return tasks.filter(task => task.status === 'active' && typeof task.nextRunAt === 'number').length;
}

function updateSchedulerWaitingBadge(tasks: ScheduledTaskView[]): void {
    const count = getWaitingSchedulerTaskCount(tasks);
    const displayText = count > 99 ? '99+' : String(count);
    const title = t('scheduler.waiting_count_title', count);

    schedulerWaitingBadge.textContent = displayText;
    schedulerWaitingBadge.title = title;
    schedulerWaitingBadge.setAttribute('aria-label', title);
    schedulerWaitingBadge.classList.toggle('hidden', count <= 0);
}

function resolveSchedulerEventSessionId(event: { taskId?: string; sessionId?: string }): string | undefined {
    if (event.sessionId) return event.sessionId;
    if (!event.taskId) return undefined;
    return cachedTasks.find(task => task.id === event.taskId)?.sessionId;
}

function handleSchedulerRuntimeEvent(event: { type: string; taskId?: string; sessionId?: string; error?: string }): void {
    if (event.type !== 'run_start' && event.type !== 'run_complete' && event.type !== 'run_failed') {
        return;
    }

    const sessionId = resolveSchedulerEventSessionId(event);
    if (!sessionId) return;

    const pendingTimer = schedulerRuntimeErrorTimers.get(sessionId);
    if (pendingTimer) {
        clearTimeout(pendingTimer);
        schedulerRuntimeErrorTimers.delete(sessionId);
    }

    const hasActiveChat = chatTargetSessionIds.has(sessionId);

    if (event.type === 'run_start') {
        if (!hasActiveChat) {
            setSessionRuntimeState(sessionId, 'running', { label: t('chat.thinking') });
        }
        return;
    }

    if (hasActiveChat) {
        updateSendButtonState();
        return;
    }

    sessionProgressCache.delete(sessionId);
    updateSendButtonState();

    if (event.type === 'run_complete') {
        setSessionRuntimeState(sessionId, 'completed');
        return;
    }

    const errorLabel = event.error || t('common.error');
    setSessionRuntimeState(sessionId, 'error', { label: errorLabel, lastError: errorLabel });
    const timer = setTimeout(() => {
        const runtime = sessionRuntimeStates.get(sessionId);
        if (runtime?.state === 'error' && runtime.lastError === errorLabel) {
            setSessionRuntimeState(sessionId, 'idle');
        }
        schedulerRuntimeErrorTimers.delete(sessionId);
    }, 3000);
    schedulerRuntimeErrorTimers.set(sessionId, timer);
}

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
): HTMLDivElement {
    const iconMap = { success: '', error: '', info: 'ℹ️' };
    const colorMap = {
        success: 'linear-gradient(135deg,#16a34a,#15803d)',
        error:   'linear-gradient(135deg,#dc2626,#b91c1c)',
        info:    'linear-gradient(135deg,#525252,#404040)',
    };

    // 所有插件 toast 放进同一个右下角容器纵向堆叠，多条并存时不再互相重叠
    let container = document.getElementById('plugin-toast-container') as HTMLDivElement | null;
    if (!container) {
        container = document.createElement('div');
        container.id = 'plugin-toast-container';
        container.style.cssText = [
            'position:fixed', 'bottom:24px', 'right:24px', 'z-index:99999',
            'display:flex', 'flex-direction:column', 'align-items:flex-end', 'gap:10px',
            'pointer-events:none',
        ].join(';');
        document.body.appendChild(container);
    }

    const el = document.createElement('div');
    el.style.cssText = [
        'pointer-events:auto',
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

    container.appendChild(el);

    // Success/info auto-close (8s); errors stay until manually closed
    if (type !== 'error') {
        setTimeout(() => {
            el.style.opacity = '0';
            el.style.transform = 'translateX(20px)';
            setTimeout(() => el.remove(), 300);
        }, 8000);
    }

    return el;
}

/** 提前关闭一条插件 toast（带淡出动画；已被关闭/移除时安全无操作） */
function closePluginToast(el: HTMLDivElement | null): void {
    if (!el || !el.isConnected) return;
    el.style.opacity = '0';
    el.style.transform = 'translateX(20px)';
    setTimeout(() => el.remove(), 300);
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
        setSidebarActionState('scheduler');
        // Back to the list view
        showSchedulerList();
        loadSchedulerData();
        startCountdownTimer();
    } else {
        // Restore chat
        messagesContainer.classList.remove('hidden');
        (document.querySelector('.input-area') as HTMLElement).classList.remove('hidden');
        schedulerView.classList.add('hidden');
        setSidebarActionState(null);
        selectedTaskId = null;
        stopCountdownTimer();
        // Restore the Router bind UI (if the current session is a Router session and not yet bound)
        if (isRouterSession) showRouterBindUI();
    }
}

function closeSchedulerView(options: { restoreChat?: boolean } = {}): void {
    if (!schedulerViewActive) return;

    const restoreChat = options.restoreChat !== false;
    schedulerViewActive = false;
    schedulerView.classList.add('hidden');
    setSidebarActionState(null);
    selectedTaskId = null;
    stopCountdownTimer();

    if (restoreChat) {
        messagesContainer.classList.remove('hidden');
        const inputArea = document.querySelector('.input-area') as HTMLElement;
        inputArea.classList.toggle('hidden', isRouterSession);
        if (isRouterSession) {
            showRouterBindUI();
        }
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

function applySchedulerDetailLayout(taskId: string): boolean {
    const taskExists = cachedTasks.some(task => task.id === taskId);
    if (!taskExists) {
        showSchedulerList();
        return false;
    }

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

    return true;
}

// Select a task: hide other cards, show execution records below the selected card
function showSchedulerDetail(taskId: string): void {
    selectedTaskId = taskId;
    if (applySchedulerDetailLayout(taskId)) {
        loadTaskRuns(taskId);
    }
}

// Load scheduler data (task list)
async function loadSchedulerData(): Promise<void> {
    if (!gatewayClient) return;
    try {
        cachedTasks = await gatewayClient.getSchedulerTasks();
        updateSchedulerWaitingBadge(cachedTasks);
        renderSchedulerTasks(cachedTasks);
        if (selectedTaskId) {
            applySchedulerDetailLayout(selectedTaskId);
        }
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
    if (task.status === 'active' || task.status === 'error') {
        actions.push(`<button class="scheduler-detail-action-btn" data-action="trigger" title="${t('scheduler.trigger')}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
            </svg>${t('scheduler.trigger')}</button>`);
    }
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

// Enter follows the same start-or-queue rule as the primary button.
messageInput.addEventListener('keydown', (e) => {
    if (shouldSubmitComposerOnKeydown(e)) {
        e.preventDefault();
        sendMessage();
    }
    // Shift+Enter keeps the textarea's default newline behavior.
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

let streamingTtsButtonState: { messageId: string; state: StreamingTTSState } | null = null;

function updateTtsButtonPlaybackState(messageId: string, state: PlaybackState): void {
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
}

function mapStreamingTtsToPlaybackState(state: StreamingTTSState): PlaybackState {
    if (state === 'playing') return 'playing';
    if (state === 'paused') return 'paused';
    if (state === 'buffering' || state === 'synthesizing') return 'loading';
    return 'idle';
}

function syncStreamingTtsButtonState(messageId: string): void {
    if (streamingTtsButtonState?.messageId !== messageId) return;
    updateTtsButtonPlaybackState(messageId, mapStreamingTtsToPlaybackState(streamingTtsButtonState.state));
}

/** Playback state change callback */
player.setStateCallback((state: PlaybackState, messageId?: string) => {
    if (!messageId) return;
    updateTtsButtonPlaybackState(messageId, state);
});

/** Streaming TTS state change callback */
streamingTtsManager.setStateCallback((state: StreamingTTSState, messageId?: string) => {
    streamingTtsButtonState = messageId ? { messageId, state } : null;

    if (messageId) {
        updateTtsButtonPlaybackState(messageId, mapStreamingTtsToPlaybackState(state));
    }

    if (!voiceModeActive) return;
    const currentState = voiceOverlay.getAttribute('data-state');
    if (state === 'playing' && (currentState === 'answering' || currentState === 'speaking')) {
        setVoiceOverlayState('speaking');
    }
});

/** Microphone button click */
micBtn.addEventListener('click', async () => {
    if (micBtn.classList.contains('disabled')) {
        // Microphone disabled (STT/LLM unavailable)
        setStatus(t('status.llm_unavailable'), 'error');
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
            setStatus(t('status.recognizing'), 'running');
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

    // If the same message is currently streaming TTS, toggle pause/play for that stream.
    if (
        streamingTtsManager.getCurrentMessageId() === messageId &&
        streamingTtsManager.isActive()
    ) {
        if (!streamingTtsManager.togglePause()) {
            streamingTtsManager.cancel();
        }
        return;
    }

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
        setStatus(t('status.llm_unavailable'), 'error');
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
        setStatus(t('status.service_unavailable'), 'error');
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
    syncWorkModeUi();
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
    if (loginModalUsernameInput) loginModalUsernameInput.placeholder = t('login.username_placeholder');
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
    // Refresh local cloud history first; the NexusAI tab uses it as a fallback when the cloud list is empty.
    await loadLocalAgents();
    loadSidebarAgents();

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
    closeSchedulerView();
    syncSidebarEntitySelection();
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
const projectContextChip = document.getElementById('project-context-chip') as HTMLDivElement;
const projectContextName = document.getElementById('project-context-name') as HTMLSpanElement;
const agentEditBack = document.getElementById('agent-edit-back') as HTMLButtonElement;
const agentEditTitle = document.getElementById('agent-edit-title') as HTMLHeadingElement;
const agentEditId = document.getElementById('agent-edit-id') as HTMLInputElement;
const agentEditName = document.getElementById('agent-edit-name') as HTMLInputElement;
const agentEditDesc = document.getElementById('agent-edit-desc') as HTMLInputElement;
const agentEntityTypeSwitch = document.getElementById('agent-entity-type-switch') as HTMLDivElement;
const agentEntityTypeOptions = Array.from(document.querySelectorAll<HTMLButtonElement>('.agent-entity-type-option'));
const projectEditFields = document.getElementById('project-edit-fields') as HTMLDivElement;
const projectEditWorkspace = document.getElementById('project-edit-workspace') as HTMLInputElement;
const projectWorkspaceBrowse = document.getElementById('project-workspace-browse') as HTMLButtonElement;
const projectEditRules = document.getElementById('project-edit-rules') as HTMLTextAreaElement;
const agentPromptSection = document.getElementById('agent-prompt-section') as HTMLDivElement;
const agentIconField = document.getElementById('agent-icon-field') as HTMLDivElement;
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
let editingEntityKind: 'agent' | 'project' = 'agent';
const PROJECT_ENTITY_ICON = '📁';

function setEditingEntityKind(kind: 'agent' | 'project', immutable: boolean = false): void {
    editingEntityKind = kind;
    agentEntityTypeOptions.forEach(option => {
        const selected = option.dataset.entityKind === kind;
        option.classList.toggle('active', selected);
        option.setAttribute('aria-checked', String(selected));
        option.disabled = immutable;
    });
    projectEditFields.classList.toggle('hidden', kind !== 'project');
    agentPromptSection.classList.toggle('hidden', kind === 'project');
    agentIconField.classList.toggle('hidden', kind === 'project');
    agentEditName.placeholder = kind === 'project' ? t('project.name_placeholder') : 'My Agent';
    agentEditDesc.placeholder = kind === 'project'
        ? t('project.desc_placeholder')
        : t('agent.desc_placeholder');
    if (kind === 'project') {
        // Project identity is expressed by its directory icon and selected color;
        // unlike an Agent, its icon is not user-configurable.
        agentEditIcon.value = PROJECT_ENTITY_ICON;
        if (!editingAgentId) {
            agentEditColor.value = '#737373';
        }
        updateIconPreview(PROJECT_ENTITY_ICON);
        setActiveIconGridItem(PROJECT_ENTITY_ICON);
        setActiveColorSwatch(agentEditColor.value);
    } else if (!editingAgentId) {
        if (agentEditIcon.value === PROJECT_ENTITY_ICON) {
            agentEditIcon.value = '🤖';
            agentEditColor.value = '#737373';
        }
        updateIconPreview(agentEditIcon.value);
        setActiveIconGridItem(agentEditIcon.value);
        setActiveColorSwatch(agentEditColor.value);
    }
    agentEditTitle.textContent = editingAgentId
        ? (kind === 'project' ? t('project.edit_title') : t('agent.edit_title_edit'))
        : (kind === 'project' ? t('project.create_title') : t('agent.create_title'));
}

agentEntityTypeSwitch?.addEventListener('click', event => {
    if (editingAgentId) return;
    const option = (event.target as HTMLElement).closest<HTMLButtonElement>('.agent-entity-type-option');
    const kind = option?.dataset.entityKind;
    if (kind === 'agent' || kind === 'project') setEditingEntityKind(kind);
});

projectWorkspaceBrowse?.addEventListener('click', async () => {
    try {
        const selected = await tauriDialogOpen({
            directory: true,
            multiple: false,
            defaultPath: projectEditWorkspace.value.trim() || undefined,
        });
        if (typeof selected === 'string') projectEditWorkspace.value = selected;
    } catch (error) {
        console.warn('[Project] Directory picker unavailable; path can still be entered manually.', error);
        projectEditWorkspace.focus();
    }
});

/** Load the local Agent list */
async function loadLocalAgents(options: { autoSelect?: boolean } = {}): Promise<void> {
    if (!gatewayClient) return;
    const autoSelect = options.autoSelect ?? true;
    sessionList.innerHTML = '<div class="memory-empty-state" style="font-size:0.8rem;padding:12px;">' + t('common.loading') + '</div>';
    try {
        // Agent Session,Session Agent
        let agents: LocalEntityView[] = [];
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
        rememberSessionApprovalModes(sessions);

        agentsList = agents;

        // 多会话：登记所有会话的 Agent 归属（后台会话的角标/未读点聚合到 Agent 卡片）
        // 同时按 Agent 归组缓存，供所有 Agent 的会话子列表默认展开渲染
        const knownAgentIds = new Set(agents.map(a => a.id));
        agentSessionsMap.clear();
        for (const s of sessions) {
            if (!s.agentId || !knownAgentIds.has(s.agentId)) continue;
            sessionAgentMap.set(s.id, s.agentId);
            // 与网关 listAgentSessions 相同的过滤规则：排除云端/Router/cron/迁移死数据
            if (s.cloudChatroomId || s.id.startsWith('agent:') || s.id.startsWith('cron:') || s.title === 'Router Messages') continue;
            const list = agentSessionsMap.get(s.agentId) || [];
            list.push(s as Session);
            agentSessionsMap.set(s.agentId, list);
        }
        if (currentAgentId) {
            agentSessionsList = agentSessionsMap.get(currentAgentId) || [];
        }

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
        if (autoSelect && currentAgentId === null && !currentCloudChatroomId && agents.length > 0) {
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

// ── Agent 置顶（本地持久化） ──
const AGENT_PINNED_STORAGE_KEY = 'openflux_pinned_agents';
const AGENT_ORDER_STORAGE_KEY = 'openflux_agent_order';
const AGENT_SESSIONS_COLLAPSED_STORAGE_KEY = 'openflux_collapsed_agent_sessions';

function getStoredAgentOrderIds(): string[] {
    return parseStoredAgentOrder(localStorage.getItem(AGENT_ORDER_STORAGE_KEY));
}

function persistAgentOrderIds(ids: string[]): void {
    localStorage.setItem(AGENT_ORDER_STORAGE_KEY, JSON.stringify([...new Set(ids)]));
}

function getPinnedAgentIds(): string[] {
    try {
        const raw = localStorage.getItem(AGENT_PINNED_STORAGE_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr.filter((v): v is string => typeof v === 'string') : [];
    } catch {
        return [];
    }
}

function toggleAgentPinned(agentId: string): void {
    const ids = getPinnedAgentIds();
    const idx = ids.indexOf(agentId);
    if (idx >= 0) {
        ids.splice(idx, 1);
    } else {
        ids.unshift(agentId);
        const currentOrder = sortAgentEntities(agentsList, getStoredAgentOrderIds(), ids)
            .map(agent => agent.id);
        persistAgentOrderIds([agentId, ...currentOrder.filter(id => id !== agentId)]);
    }
    localStorage.setItem(AGENT_PINNED_STORAGE_KEY, JSON.stringify(ids));
}

interface AgentPointerDragState {
    pointerId: number;
    sourceId: string;
    sourcePinned: boolean;
    startX: number;
    startY: number;
    active: boolean;
    visibleIds: string[];
    sourceCard: HTMLElement;
}

let agentPointerDrag: AgentPointerDragState | null = null;
let suppressAgentCardClick = false;

function clearAgentDropState(): void {
    sessionList.classList.remove('agent-reordering');
    sessionList.querySelectorAll('.local-agent-card.dragging, .local-agent-card.agent-drop-before, .local-agent-card.agent-drop-after')
        .forEach(element => element.classList.remove('dragging', 'agent-drop-before', 'agent-drop-after'));
}

function finishAgentPointerDrag(suppressClick: boolean): void {
    agentPointerDrag = null;
    clearAgentDropState();
    if (suppressClick) {
        suppressAgentCardClick = true;
        window.setTimeout(() => { suppressAgentCardClick = false; }, 0);
    }
}

function loadCollapsedAgentSessionIds(): Set<string> {
    try {
        const raw = localStorage.getItem(AGENT_SESSIONS_COLLAPSED_STORAGE_KEY);
        const values = raw ? JSON.parse(raw) : [];
        return new Set(Array.isArray(values)
            ? values.filter((value): value is string => typeof value === 'string')
            : []);
    } catch {
        return new Set();
    }
}

const collapsedAgentSessionIds = loadCollapsedAgentSessionIds();

function syncProjectContextIndicator(): void {
    const entity = !currentCloudChatroomId && !isRouterSession
        ? agentsList.find(item => item.id === currentAgentId)
        : undefined;
    const active = entity?.kind === 'project' && !!entity.workspace;
    projectContextChip.classList.toggle('hidden', !active);
    if (!active || !entity) {
        projectContextName.textContent = '';
        projectContextChip.title = '';
        return;
    }
    projectContextName.textContent = `${entity.name} · ${entity.workspace}`;
    projectContextChip.title = `${entity.name}\n${entity.workspace}`;
}

function persistCollapsedAgentSessionIds(): void {
    try {
        localStorage.setItem(
            AGENT_SESSIONS_COLLAPSED_STORAGE_KEY,
            JSON.stringify([...collapsedAgentSessionIds]),
        );
    } catch { /* localStorage may be unavailable in restricted WebViews */ }
}

function setAgentSessionsCollapsed(agentId: string, collapsed: boolean): void {
    if (collapsed) collapsedAgentSessionIds.add(agentId);
    else collapsedAgentSessionIds.delete(agentId);
    persistCollapsedAgentSessionIds();
}

// 点击其它区域时收起 Agent 操作菜单
document.addEventListener('click', () => {
    sessionList?.querySelectorAll('.agent-menu-dropdown').forEach(d => d.classList.add('hidden'));
});

/** Render the local Agent list (at the sessionList location) */
function renderLocalAgents(): void {
    syncProjectContextIndicator();
    sessionList.innerHTML = '';
    if (agentsList.length === 0) {
        sessionList.innerHTML = '<div class="memory-empty-state" style="font-size:0.8rem;padding:12px;">' + t('agent.no_agents') + '</div>';
        return;
    }
    // 置顶项保持在顶部组内；每组内部遵循用户拖拽保存的顺序。
    const pinnedIds = getPinnedAgentIds();
    const sortedAgents = sortAgentEntities(agentsList, getStoredAgentOrderIds(), pinnedIds);
    for (const agent of sortedAgents) {
        const card = document.createElement('div');
        const isLocalActive = currentAgentId === agent.id && !currentCloudChatroomId;
        const sessionsCollapsed = collapsedAgentSessionIds.has(agent.id);
        card.className = 'local-agent-card'
            + (isLocalActive ? ' active' : '')
            + (sessionsCollapsed ? ' sessions-collapsed' : '');
        card.dataset.agentId = agent.id;
        card.dataset.pinned = String(pinnedIds.includes(agent.id));
        card.setAttribute('aria-expanded', String(!sessionsCollapsed));
        const isProject = agent.kind === 'project';
        const icon = agent.icon || (isProject ? '📁' : '🤖');
        const color = '#737373';
        const cardIconClass = `agent-card-icon${isProject ? ' project-card-icon' : ''}`;
        const cardIconStyle = isProject
            ? ''
            : ` style="background:${escapeHtml(color)}20;color:${escapeHtml(color)}"`;
        const cardIcon = isProject
            ? `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H9l2 2h7.5A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z"/></svg>`
            : renderAgentIcon(icon, 22);
        const displayText = getLocalAgentDisplayText(agent);
        const name = displayText.name;
        const desc = displayText.description || (isProject ? agent.workspace || '' : '');
        const isDefault = agent.default ? '<span class="agent-default-badge">默认</span>' : '';
        const projectBadge = isProject ? `<span class="agent-project-badge">${t('agent.type_project')}</span>` : '';
        const isPinned = pinnedIds.includes(agent.id);
        const pinnedBadge = isPinned ? `<span class="agent-pinned-badge" title="${t('agent.unpin')}">📌</span>` : '';
        // 受保护的内置 Agent（如「设计师」）不可删除，菜单中隐藏删除项
        const deleteMenuHtml = agent.locked ? '' : `
                <div class="agent-menu-item agent-menu-delete">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                    </svg>
                    <span>${t('agent.menu_delete')}</span>
                </div>`;
        card.innerHTML = `
            <div class="${cardIconClass}"${cardIconStyle}>${cardIcon}</div>
            <div class="agent-card-info">
                <div class="agent-card-name">${escapeHtml(name)} ${isDefault}${projectBadge}${pinnedBadge}</div>
                ${desc ? `<div class="agent-card-desc">${escapeHtml(desc)}</div>` : ''}
            </div>
            <span class="agent-session-chevron" aria-hidden="true">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                    <polyline points="6 9 12 15 18 9"/>
                </svg>
            </span>
            <div class="agent-card-actions">
                <button class="agent-action-btn agent-new-session-action" title="${t('app.new_session')}">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                    </svg>
                </button>
                <button class="agent-action-btn agent-more-action" title="${t('app.more_actions')}">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                        <circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>
                    </svg>
                </button>
            </div>
            <div class="agent-menu-dropdown hidden">
                <div class="agent-menu-item agent-menu-edit">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                    </svg>
                    <span>${t('agent.menu_edit')}</span>
                </div>
                <div class="agent-menu-item agent-menu-pin">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M12 17v5"/>
                        <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z"/>
                    </svg>
                    <span>${isPinned ? t('agent.unpin') : t('agent.pin')}</span>
                </div>${deleteMenuHtml}
            </div>
        `;
        const sessionListEl = buildAgentSessionListEl(agent.id);
        const applyDisclosureState = (collapsed: boolean) => {
            setAgentSessionsCollapsed(agent.id, collapsed);
            applyAgentSessionDisclosure(card, sessionListEl, collapsed);
        };

        card.addEventListener('pointerdown', event => {
            if (event.button !== 0 || event.pointerType !== 'mouse') return;
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest('.agent-card-actions, .agent-menu-dropdown')) return;

            agentPointerDrag = {
                pointerId: event.pointerId,
                sourceId: agent.id,
                sourcePinned: pinnedIds.includes(agent.id),
                startX: event.clientX,
                startY: event.clientY,
                active: false,
                visibleIds: sortedAgents.map(item => item.id),
                sourceCard: card,
            };
            card.setPointerCapture(event.pointerId);
        });

        card.addEventListener('pointermove', event => {
            const drag = agentPointerDrag;
            if (!drag || drag.pointerId !== event.pointerId) return;

            if (!drag.active) {
                const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
                if (distance < 6) return;
                drag.active = true;
                sessionList.classList.add('agent-reordering');
                drag.sourceCard.classList.add('dragging');
            }

            event.preventDefault();
            event.stopPropagation();
            sessionList.querySelectorAll('.agent-drop-before, .agent-drop-after')
                .forEach(element => element.classList.remove('agent-drop-before', 'agent-drop-after'));

            const pointedElement = document.elementFromPoint(event.clientX, event.clientY);
            const targetCard = pointedElement?.closest<HTMLElement>('.local-agent-card[data-agent-id]') ?? null;
            if (!targetCard || targetCard.dataset.agentId === drag.sourceId) return;
            if ((targetCard.dataset.pinned === 'true') !== drag.sourcePinned) return;

            const bounds = targetCard.getBoundingClientRect();
            const placement: AgentDropPlacement = event.clientY < bounds.top + bounds.height / 2
                ? 'before'
                : 'after';
            targetCard.classList.add(placement === 'before' ? 'agent-drop-before' : 'agent-drop-after');
        });

        card.addEventListener('pointerup', event => {
            const drag = agentPointerDrag;
            if (!drag || drag.pointerId !== event.pointerId) return;

            if (card.hasPointerCapture(event.pointerId)) {
                card.releasePointerCapture(event.pointerId);
            }
            if (!drag.active) {
                agentPointerDrag = null;
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            const targetCard = sessionList.querySelector<HTMLElement>('.agent-drop-before, .agent-drop-after');
            const targetId = targetCard?.dataset.agentId;
            if (targetCard && targetId) {
                const placement: AgentDropPlacement = targetCard.classList.contains('agent-drop-before') ? 'before' : 'after';
                persistAgentOrderIds(reorderAgentIds(drag.visibleIds, drag.sourceId, targetId, placement));
                finishAgentPointerDrag(true);
                renderLocalAgents();
                return;
            }
            finishAgentPointerDrag(true);
        });

        card.addEventListener('pointercancel', event => {
            const drag = agentPointerDrag;
            if (!drag || drag.pointerId !== event.pointerId) return;
            if (card.hasPointerCapture(event.pointerId)) {
                card.releasePointerCapture(event.pointerId);
            }
            finishAgentPointerDrag(drag.active);
        });

        // Agent 主卡只控制会话列表展开/折叠；进入会话由子会话行负责。
        card.addEventListener('click', (e) => {
            if (suppressAgentCardClick) return;
            if (isAgentDisclosureActionTarget(e.target)) return;
            applyDisclosureState(!collapsedAgentSessionIds.has(agent.id));
        });
        // New session button（若该 Agent 未激活则先切换过去）
        card.querySelector('.agent-new-session-action')?.addEventListener('click', async (e) => {
            e.stopPropagation();
            setAgentSessionsCollapsed(agent.id, false);
            if (currentAgentId !== agent.id || currentCloudChatroomId) {
                await switchToAgent(agent.id);
            }
            await createAgentSession(agent.id);
        });
        // "..." 操作菜单
        const moreMenu = card.querySelector('.agent-menu-dropdown') as HTMLDivElement | null;
        card.querySelector('.agent-more-action')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const wasHidden = moreMenu?.classList.contains('hidden');
            sessionList.querySelectorAll('.agent-menu-dropdown').forEach(d => d.classList.add('hidden'));
            if (wasHidden) moreMenu?.classList.remove('hidden');
        });
        moreMenu?.querySelector('.agent-menu-edit')?.addEventListener('click', (e) => {
            e.stopPropagation();
            moreMenu.classList.add('hidden');
            openAgentEditModal(agent.id);
        });
        moreMenu?.querySelector('.agent-menu-pin')?.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleAgentPinned(agent.id);
            renderLocalAgents();
        });
        moreMenu?.querySelector('.agent-menu-delete')?.addEventListener('click', (e) => {
            e.stopPropagation();
            moreMenu.classList.add('hidden');
            deleteLocalAgent(agent.id, name);
        });
        sessionList.appendChild(card);

        // ── 多会话：所有 Agent 的卡片下方默认展开会话子列表 ──
        sessionList.appendChild(sessionListEl);
    }

    // ---- Used cloud NexusAi Agent group ----
    // Agent()
    if (usedCloudSessions.size > 0) {
        // Match used cloud Agent details from cache, or just use the session name
        const usedAgents: Array<{ chatroomId: number; appId: number; name: string; description?: string; sessionId: string }> = [];
        for (const [chatroomId, info] of usedCloudSessions) {
            const cached = cachedOpenFluxAgents.find(a => a.chatroomId === chatroomId);
            usedAgents.push({
                chatroomId,
                appId: cached?.appId || 0,
                name: cached?.name || info.agentName,
                description: cached?.description,
                sessionId: info.sessionId,
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
                card.dataset.sessionId = agent.sessionId;
                card.innerHTML = `
                    <div class="agent-card-icon" style="background:rgba(115,115,115,0.12);color:#737373">${renderAgentIcon('🤖', 22)}</div>
                    <div class="agent-card-info">
                        <div class="agent-card-name">${escapeHtml(agent.name)} <span class="agent-cloud-badge">☁️</span></div>
                        ${agent.description ? `<div class="agent-card-desc">${escapeHtml(agent.description)}</div>` : ''}
                    </div>
                    <div class="agent-card-actions">
                        <button class="agent-action-btn agent-delete-action" title="${t('agent.delete_btn')}">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                            </svg>
                        </button>
                    </div>
                `;
                // Click to switch to this cloud session (skip if it's already the active one to avoid a needless reload/jump)
                card.addEventListener('click', (e) => {
                    if ((e.target as HTMLElement).closest('.agent-delete-action')) return;
                    if (currentCloudChatroomId === agent.chatroomId && !isRouterSession) return;
                    startCloudChat(agent.appId, agent.name, agent.chatroomId);
                });
                // Delete button + right-click both remove the cloud session
                card.querySelector('.agent-delete-action')?.addEventListener('click', (e) => {
                    e.stopPropagation();
                    deleteCloudSession(agent.sessionId, agent.name);
                });
                card.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    deleteCloudSession(agent.sessionId, agent.name);
                });
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
    syncSidebarEntitySelection();
    renderSessionRuntimeBadges();
}

// ========================
// 单 Agent 多会话：侧栏会话子列表
// ========================

/** 构建当前 Agent 的会话子列表（挂在 Agent 卡片下方） */
function buildAgentSessionListEl(agentId: string): HTMLElement {
    const wrap = document.createElement('div');
    const collapsed = collapsedAgentSessionIds.has(agentId);
    wrap.className = 'agent-session-list' + (collapsed ? ' is-collapsed' : '');
    wrap.dataset.agentId = agentId;
    wrap.setAttribute('aria-hidden', String(collapsed));

    // 按最近更新时间倒序展示。默认会话不显示可见标记（其 id 前缀 user-agent: 即隐藏标记）
    const sessionsOfAgent = agentSessionsMap.get(agentId)
        || (agentId === currentAgentId ? agentSessionsList : []);
    const sortedSessions = [...sessionsOfAgent].sort((a, b) =>
        (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));

    // 只剩最后一个会话时不可删除，直接不渲染删除按钮
    const canDelete = sortedSessions.length > 1;

    for (const session of sortedSessions) {
        const item = document.createElement('div');
        const isActive = session.id === currentSessionId;
        item.className = 'session-item agent-session-item' + (isActive ? ' active' : '');
        item.dataset.sessionId = session.id;
        const titleText = escapeHtml(session.title || t('app.new_session'));
        const deleteBtnHtml = canDelete ? `
                <button class="agent-action-btn agent-session-delete" title="${t('misc.delete_session')}">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                    </svg>
                </button>` : '';
        item.innerHTML = `
            <div class="session-item-content">
                <div class="session-title" title="${titleText}">${titleText}</div>
                ${unreadSessionIds.has(session.id) ? '<span class="unread-badge"></span>' : ''}
            </div>
            <div class="agent-session-actions">
                <button class="agent-action-btn agent-session-rename" title="${t('session.rename')}">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                    </svg>
                </button>${deleteBtnHtml}
            </div>
        `;
        item.addEventListener('click', (e) => {
            const target = e.target as HTMLElement;
            if (target.closest('.agent-session-rename') || target.closest('.agent-session-delete')) return;
            selectAgentSession(agentId, session.id);
        });
        item.querySelector('.agent-session-rename')?.addEventListener('click', (e) => {
            e.stopPropagation();
            startInlineSessionRename(item, session.id, session.title || '');
        });
        item.querySelector('.agent-session-delete')?.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteAgentSession(agentId, session.id);
        });
        wrap.appendChild(item);
    }

    return wrap;
}

/** 切换到某个 Agent 的某个会话（跨 Agent 点击时先切换 Agent） */
async function selectAgentSession(agentId: string, sessionId: string): Promise<void> {
    if (agentId !== currentAgentId || currentCloudChatroomId) {
        await switchToAgent(agentId, sessionId);
        return;
    }
    agentActiveSessionMap.set(agentId, sessionId);
    await selectSession(sessionId);
}

/** 为指定 Agent 新建一个会话并切换过去 */
async function createAgentSession(agentId: string): Promise<void> {
    if (!gatewayClient) return;
    try {
        const session = await gatewayClient.createSession(
            undefined,
            undefined,
            undefined,
            agentId,
            getCurrentApprovalMode(),
        );
        rememberSessionApprovalModes([session]);
        agentActiveSessionMap.set(agentId, session.id);
        sessionAgentMap.set(session.id, agentId);
        await refreshAgentSessions(agentId);
        await selectSession(session.id);
        syncSidebarEntitySelection();
    } catch (e) {
        console.error('[Session] 新建会话失败:', e);
    }
}

/** 删除 Agent 的某个会话（至少保留一个） */
async function deleteAgentSession(agentId: string, sessionId: string): Promise<void> {
    if (!gatewayClient) return;
    if ((agentSessionsMap.get(agentId) || []).length <= 1) {
        await showConfirmDialog(t('session.last_one_hint'));
        return;
    }
    const confirmed = await showConfirmDialog(t('app.confirm_delete_session'));
    if (!confirmed) return;
    try {
        await gatewayClient.deleteSession(sessionId);
        unreadSessionIds.delete(sessionId);
        sessionRuntimeStates.delete(sessionId);
        sessionProgressCache.delete(sessionId);
        sessionStreamBuffers.delete(sessionId);
        sessionProvisionalStreamIds.delete(sessionId);
        sessionCompletedOutputs.delete(sessionId);
        activityView.clearSession(sessionId);
        sessionDrafts.delete(sessionId);
        if (agentActiveSessionMap.get(agentId) === sessionId) {
            agentActiveSessionMap.delete(agentId);
        }
        await refreshAgentSessions(agentId);
        // 删除的是当前会话 → 切到该 Agent 剩余的最近会话
        if (currentSessionId === sessionId) {
            const fallback = (agentSessionsMap.get(agentId) || [])[0];
            if (fallback) {
                agentActiveSessionMap.set(agentId, fallback.id);
                await selectSession(fallback.id);
            } else {
                currentSessionId = null;
                clearMessages();
                clearArtifacts();
                syncCurrentSessionRuntimeUi();
            }
        }
        renderLocalAgents();
    } catch (e) {
        console.error('[Session] 删除会话失败:', e);
    }
}

/** 行内重命名会话（避免 WebView 中 prompt 不可用） */
function startInlineSessionRename(item: HTMLElement, sessionId: string, currentTitle: string): void {
    const titleEl = item.querySelector('.session-title') as HTMLElement | null;
    if (!titleEl || titleEl.querySelector('input')) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'agent-session-rename-input';
    input.value = currentTitle;
    input.placeholder = t('session.rename_prompt');
    titleEl.innerHTML = '';
    titleEl.appendChild(input);
    input.focus();
    input.select();

    let committed = false;
    const commit = async (save: boolean) => {
        if (committed) return;
        committed = true;
        const newTitle = input.value.trim();
        if (save && newTitle && newTitle !== currentTitle && gatewayClient) {
            try {
                await gatewayClient.renameSession(sessionId, newTitle);
                for (const list of agentSessionsMap.values()) {
                    const s = list.find(x => x.id === sessionId);
                    if (s) { s.title = newTitle; break; }
                }
            } catch (e) {
                console.error('[Session] 重命名失败:', e);
            }
        }
        renderLocalAgents();
    };
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); void commit(true); }
        else if (e.key === 'Escape') { void commit(false); }
        e.stopPropagation();
    });
    input.addEventListener('blur', () => void commit(true));
    input.addEventListener('click', (e) => e.stopPropagation());
}

/**
 * 就地改写某个会话的标题（不重拉列表、不整表重绘）
 *
 * 首轮对话会收到两次标题：用户发出消息时的截断标题，以及后台摘要返回后的正式
 * 标题。此时任务往往正在运行，整表重绘会打断用户视线，所以只改那一行。
 */
function applySessionTitleUpdate(sessionId: string, title: string): void {
    for (const list of agentSessionsMap.values()) {
        const entry = list.find(item => item.id === sessionId);
        if (entry) entry.title = title;
    }
    const active = agentSessionsList?.find(item => item.id === sessionId);
    if (active) active.title = title;

    for (const row of document.querySelectorAll(`.session-item[data-session-id="${sessionId}"]`)) {
        // 该行正在内联重命名时不动它，否则会吞掉用户正在输入的内容
        if (row.querySelector('input')) continue;
        const titleEl = row.querySelector('.session-title') as HTMLElement | null;
        if (!titleEl) continue;
        // 云会话的标题里带一个前缀徽标，重写文本时要把它放回去
        const badge = titleEl.querySelector('.session-cloud-badge');
        titleEl.textContent = title;
        if (badge) titleEl.prepend(badge);
        titleEl.title = title;
    }
}

/** 拉取指定 Agent 的会话列表并重绘侧栏（不整表重建，无加载闪烁） */
async function refreshAgentSessions(agentId: string, rerender = true): Promise<void> {
    if (!gatewayClient) return;
    try {
        const list = await gatewayClient.getSessions(agentId) as Session[];
        rememberSessionApprovalModes(list);
        agentSessionsMap.set(agentId, list);
        if (agentId === currentAgentId) agentSessionsList = list;
        registerSessionAgent(list, agentId);
        if (rerender) renderLocalAgents();
    } catch (e) {
        console.warn('[Session] 刷新会话列表失败:', e);
    }
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
    const chromeInstalled = localStorage.getItem('chrome-plugin-installed') === '1';

    interface ConnConfig {
        id: string; icon: string; logo: string; color: string;
        name: string; desc: string; enabled: boolean;
        onToggle: (el: HTMLInputElement) => void;
        onConfigure: () => void;
        // 是否显示右侧齿轮（配置）按钮：仅 Chrome 录制扩展显示，Office 三件套隐藏
        showGear?: boolean;
    }

    /** Office 插件安装结果提示：后端返回 ⚠️ 开头的消息（如证书未被信任）时按警告展示，否则展示常规成功提示 */
    function showInstallResultToast(msg: string, successTitle: string, successSteps: string[]): void {
        if (msg && msg.trimStart().startsWith('⚠️')) {
            const lines = msg.split('\n').map(s => s.trim()).filter(Boolean);
            showPluginToast('error', lines[0], lines.slice(1));
        } else {
            showPluginToast('success', successTitle, successSteps);
        }
    }

    /** 开启插件前的即时提示：安装过程中系统可能弹出证书确认框，提前告知用户如何处理。
     *  返回 toast 元素，安装结束后用 closePluginToast 收掉，避免与结果提示同屏堆叠过久。 */
    function showInstallingToast(): HTMLDivElement {
        return showPluginToast('info',
            t('connections.installing') || '正在开启插件，请稍候…',
            [t('connections.cert_dialog_hint') || '若系统弹出安全证书确认框，请点击"是"以信任本地证书']
        );
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
                    const installingToast = showInstallingToast();
                    try {
                        const { invoke } = await import('@tauri-apps/api/core');
                        const installMsg = await invoke<string>('excel_plugin_install');
                        closePluginToast(installingToast);
                        localStorage.setItem('excel-plugin-installed', '1');
                        showInstallResultToast(installMsg,
                            t('connections.excel_install_ok') || 'Excel plugin installed',
                            [
                                t('connections.step_restart_excel') || 'Please restart Excel',
                                t('connections.step_insert_addin') || 'Insert → Add-ins → My Add-ins',
                                t('connections.step_shared_folder') || 'Shared Folder → OpenFlux Agent → Add',
                            ]
                        );
                        renderLocalAgents();
                    } catch (e) {
                        closePluginToast(installingToast);
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
                    const installingToast = showInstallingToast();
                    try {
                        const { invoke } = await import('@tauri-apps/api/core');
                        const installMsg = await invoke<string>('word_plugin_install');
                        closePluginToast(installingToast);
                        localStorage.setItem('word-plugin-installed', '1');
                        showInstallResultToast(installMsg,
                            t('connections.word_install_ok') || 'Word plugin installed',
                            [
                                t('connections.step_restart_word') || 'Please restart Word',
                                t('connections.step_insert_addin') || 'Insert → Add-ins → My Add-ins',
                                t('connections.step_shared_folder') || 'Shared Folder → OpenFlux Agent → Add',
                            ]
                        );
                        renderLocalAgents();
                    } catch (e) {
                        closePluginToast(installingToast);
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
                    const installingToast = showInstallingToast();
                    try {
                        const { invoke } = await import('@tauri-apps/api/core');
                        const installMsg = await invoke<string>('ppt_plugin_install');
                        closePluginToast(installingToast);
                        localStorage.setItem('ppt-plugin-installed', '1');
                        showInstallResultToast(installMsg,
                            t('connections.ppt_install_ok') || 'PowerPoint plugin installed',
                            [
                                t('connections.step_restart_ppt') || 'Please restart PowerPoint',
                                t('connections.step_insert_addin') || 'Insert → Add-ins → My Add-ins',
                                t('connections.step_shared_folder') || 'Shared Folder → OpenFlux Agent → Add',
                            ]
                        );
                        renderLocalAgents();
                    } catch (e) {
                        closePluginToast(installingToast);
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
        {
            id: 'conn-chrome', icon: '🎬', logo: '/logos/chrome.svg', color: '#f59e0b',
            name: t('connections.chrome_name') || 'Chrome 插件',
            desc: t('connections.chrome_desc') || '录制浏览器操作供 Agent 复用',
            enabled: chromeInstalled,

            onToggle: async (el) => {
                const turnOn = el.checked;
                el.disabled = true;
                if (turnOn) {
                    try {
                        const { invoke } = await import('@tauri-apps/api/core');
                        await invoke<string>('chrome_extension_install');
                        localStorage.setItem('chrome-plugin-installed', '1');
                        showPluginToast('success',
                            t('connections.chrome_install_ok') || 'Chrome 录制扩展已启用',
                            [
                                t('connections.chrome_step_launch') || '由本应用启动的 Chrome 会尝试自动加载该扩展',
                                t('connections.chrome_step_manual') || '新版 Chrome（137+）不允许自动加载：请打开 chrome://extensions 手动加载一次（路径见 设置 → 工具）',
                                t('connections.chrome_step_record') || '点击工具栏 OpenFlux Recorder 开始录制',
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
                        t('connections.chrome_uninstall_confirm') || '确认停用 Chrome 录制扩展？',
                    );
                    if (!confirmed) { el.checked = true; el.disabled = false; return; }
                    try {
                        const { invoke } = await import('@tauri-apps/api/core');
                        await invoke<string>('chrome_extension_uninstall');
                        localStorage.removeItem('chrome-plugin-installed');
                        showPluginToast('info',
                            t('connections.chrome_uninstall_ok') || 'Chrome 录制扩展已停用',
                            [t('connections.chrome_step_relaunch') || '重新启动 Chrome 后将不再加载']
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
            onConfigure: () => showSettings('tools'),
            showGear: true,
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
        // 仅 showGear 的连接显示齿轮（配置）按钮：Office 三件套不显示，Chrome 录制扩展显示。
        // 放大后置于插件名称之后（内联），而非右侧控制区。
        const gearInlineSvg = `<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 4.754a3.246 3.246 0 1 0 0 6.492 3.246 3.246 0 0 0 0-6.492zM5.754 8a2.246 2.246 0 1 1 4.492 0 2.246 2.246 0 0 1-4.492 0z"/>
            <path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 0 1-1.255.52l-.292-.16c-1.64-.892-3.433.901-2.54 2.541l.159.292a.873.873 0 0 1-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 0 1 .52 1.255l-.16.292c-.892 1.64.901 3.434 2.541 2.54l.292-.159a.873.873 0 0 1 1.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 0 1 1.255-.52l.292.16c1.64.893 3.434-.902 2.54-2.541l-.159-.292a.873.873 0 0 1 .52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 0 1-.52-1.255l.16-.292c.893-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 0 1-1.255-.52l-.094-.319zm-2.633.283c.246-.835 1.428-.835 1.674 0l.094.319a1.873 1.873 0 0 0 2.693 1.115l.291-.16c.764-.415 1.6.42 1.184 1.185l-.159.292a1.873 1.873 0 0 0 1.116 2.692l.318.094c.835.246.835 1.428 0 1.674l-.319.094a1.873 1.873 0 0 0-1.115 2.693l.16.291c.415.764-.42 1.6-1.185 1.184l-.291-.159a1.873 1.873 0 0 0-2.693 1.116l-.094.318c-.246.835-1.428.835-1.674 0l-.094-.319a1.873 1.873 0 0 0-2.692-1.115l-.292.16c-.764.415-1.6-.42-1.184-1.185l.159-.291A1.873 1.873 0 0 0 1.945 8.93l-.319-.094c-.835-.246-.835-1.428 0-1.674l.319-.094A1.873 1.873 0 0 0 3.06 4.377l-.16-.292c-.415-.764.42-1.6 1.185-1.184l.292.159a1.873 1.873 0 0 0 2.692-1.115l.094-.319z"/>
        </svg>`;
        const gearBtnHtml = conn.showGear ? `<button class="agent-action-btn conn-gear-btn conn-gear-inline" title="${t('connections.configure') || '配置'}" style="margin-left:5px;width:19px;height:19px;padding:0;display:inline-flex;align-items:center;justify-content:center;vertical-align:middle;flex:none;">${gearInlineSvg}</button>` : '';
        card.innerHTML = `
            <div class="agent-card-icon conn-logo-icon">
                <img src="${conn.logo}" alt="${escapeHtml(conn.name)}" draggable="false"/>
            </div>
            <div class="agent-card-info">
                <div class="agent-card-name" style="display:inline-flex;align-items:center;">${escapeHtml(conn.name)}${gearBtnHtml}</div>
                <div class="agent-card-desc">${escapeHtml(conn.desc)}</div>
            </div>
            <div class="conn-card-controls">
<label class="toggle-switch conn-mini-toggle" title="${conn.enabled ? (t('connections.enabled') || 'On') : (t('connections.disabled') || 'Off')}">
                    <input type="checkbox" ${conn.enabled ? 'checked' : ''} data-conn-toggle="${conn.id}">
                    <span class="toggle-slider"></span>
                </label>
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
async function switchToAgent(agentId: string, preferredSessionId?: string): Promise<void> {
    if (!gatewayClient) return;
    const viewRevision = ++sessionViewRevision;
    try {
        // 多会话：优先恢复该 Agent 最近激活的会话（或调用方指定的会话）
        const wantedSessionId = preferredSessionId || agentActiveSessionMap.get(agentId);
        const result = await gatewayClient.switchAgent(agentId, wantedSessionId);
        if (viewRevision !== sessionViewRevision) return;
        currentAgentId = agentId;
        // ID Agent sessionKey
        const agentInfo = result.agent as Record<string, unknown>;
        const sessionKey = (agentInfo.sessionKey || agentId) as string;
        // 记录该 Agent 的会话列表 + 激活会话
        agentSessionsList = (result.sessions || []) as Session[];
        rememberSessionApprovalModes(agentSessionsList);
        agentSessionsMap.set(agentId, agentSessionsList);
        agentActiveSessionMap.set(agentId, sessionKey);
        registerSessionAgent(agentSessionsList, agentId);

        // ====== Sync phase: lock the current session UI + insert DOM elements ======
        if (currentSessionId) {
            const draft = messageInput.value.trim();
            if (draft) {
                sessionDrafts.set(currentSessionId, messageInput.value);
            } else {
                sessionDrafts.delete(currentSessionId);
            }
        }

        // Cache the current live progress before re-rendering messages.
        // This also covers clicking the already-active Agent from Settings.
        cacheCurrentProgressState(currentSessionId);

        currentSessionId = sessionKey;
        inputRow.classList.remove('plan-interaction-active');
        planInteraction.classList.add('hidden');
        planInteraction.replaceChildren();
        newSessionApprovalMode = getSessionApprovalMode(sessionKey);
        currentCloudChatroomId = null;
        isRouterSession = false;
        // agent
        unreadSessionIds.delete(sessionKey);
        const agentCard = sessionList.querySelector(`.local-agent-card[data-agent-id="${agentId}"]`);
        agentCard?.querySelector('.unread-badge')?.remove();
        const selectedRuntime = sessionRuntimeStates.get(sessionKey);
        if (selectedRuntime?.state === 'completed' || selectedRuntime?.state === 'stopped') {
            setSessionRuntimeState(sessionKey, 'idle');
        } else {
            syncCurrentSessionRuntimeUi();
        }
        // Hide the Router bind UI, restore the input area
        document.body.classList.remove('router-active');
        hideRouterBindUI();
        (document.querySelector('.input-area') as HTMLElement).classList.remove('hidden');
        syncApprovalModeUi();
        syncWorkModeUi();

        // Restore the input draft of the target session
        messageInput.value = sessionDrafts.get(sessionKey) || '';
        autoResize();

        // Reset the live progress state
        currentProgressCard = null;
        progressItems = [];
        isProgressFinished = !loadingSessions.has(sessionKey);

        // Prevent artifacts from the previously selected Agent session from
        // remaining visible while this session is being hydrated.
        clearArtifacts();
        const cachedWorkState = workStateBySession.get(sessionKey);
        if (cachedWorkState) applyWorkState(cachedWorkState);

        // Hide edit/settings/scheduler views, ensure the chat area is shown
        hideAgentEditView();
        closeSettingsView();
        closeSchedulerView();

        // selectSession
        const messagesEl = document.getElementById('messages') as HTMLDivElement;
        try {
            // Reset lazy-load state
            sessionMsgOffset.set(sessionKey, 0);
            sessionMsgHasMore.set(sessionKey, false);

            const [msgResult, logs, savedArtifacts, agentEvents, workState] = await Promise.all([
                gatewayClient.getMessages(sessionKey, SESSION_PAGE_SIZE, 0),
                gatewayClient.getLogs(sessionKey),
                gatewayClient.getArtifacts(sessionKey),
                gatewayClient.getAgentEvents(sessionKey).catch(() => [] as AgentEventV1[]),
                gatewayClient.getWorkState(sessionKey).catch(() => ({ sessionId: sessionKey, mode: 'normal' as const })),
            ]);
            if (viewRevision !== sessionViewRevision || currentSessionId !== sessionKey) return;
            applyWorkState(workState);

            const { messages, total, hasMore } = msgResult;
            sessionMsgOffset.set(sessionKey, messages.length);
            sessionMsgHasMore.set(sessionKey, hasMore);
            console.log(`[Agent] Messages: ${messages.length}/${total} hasMore: ${hasMore}`);

            if ((messages as Message[]).length > 0 || (logs as LogEntry[]).length > 0 || agentEvents.length > 0) {
                const hydratedMessages = await hydrateMessageAttachments(messages);
                if (viewRevision !== sessionViewRevision || currentSessionId !== sessionKey) return;
                renderMessagesWithActivity(hydratedMessages, logs as LogEntry[], agentEvents, sessionKey);
                if (hasMore) {
                    prependLoadMoreHint();
                }
            } else {
                // Agent
                const agentName = (agentInfo.name || agentId) as string;
                messagesEl.innerHTML = `<div class="memory-empty-state" style="padding:32px;text-align:center;opacity:0.6;">${t('agent.chatting_with').replace('{0}', '<strong>' + escapeHtml(agentName) + '</strong>')}</div>`;
                activityView.restoreRunningSession(sessionKey);
            }

            // ═══ 恢复动作卡片：若该 Agent 会话仍在执行，重建实时进度卡片（缓存为空也显示"运行中"） ═══
            restoreRunningProgressCard(sessionKey);

            // Restore artifacts (no longer persisted, since they're already on the server)
            if (savedArtifacts.length > 0) {
                const sorted = [...savedArtifacts].sort((a: any, b: any) => (b.timestamp || 0) - (a.timestamp || 0));
                for (const a of sorted) {
                    if (viewRevision !== sessionViewRevision || currentSessionId !== sessionKey) return;
                    await addArtifact(a as Artifact, false);
                }
            }
        } catch (loadError) {
            console.error('[Agent] 加载会话数据失败:', loadError);
            if (viewRevision !== sessionViewRevision || currentSessionId !== sessionKey) return;
            messagesEl.innerHTML = '';
            activityView.restoreRunningSession(sessionKey);
        }

        if (viewRevision !== sessionViewRevision || currentSessionId !== sessionKey) return;
        activityView.restoreRunningSession(sessionKey);
        // Agent
        renderLocalAgents();
        // Chat
        switchSidebarMode('agent');
        syncCurrentSessionRuntimeUi();
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
function resetAgentEditScroll(): void {
    agentEditView.scrollTop = 0;
    requestAnimationFrame(() => {
        agentEditView.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    });
}

function showAgentEditView(): void {
    closeSchedulerView();
    closeSettingsView();
    messagesContainer.classList.add('hidden');
    settingsView.classList.add('hidden');
    agentEditView.classList.remove('hidden');
    resetAgentEditScroll();
    // Hide the input area
    const inputArea = document.querySelector('.input-area') as HTMLElement | null;
    if (inputArea) inputArea.classList.add('hidden');
    setSidebarActionState(editingAgentId ? null : 'new-agent');
}

/** Hide the Agent edit view, back to chat */
function hideAgentEditView(): void {
    agentEditView.classList.add('hidden');
    messagesContainer.classList.remove('hidden');
    const inputArea = document.querySelector('.input-area') as HTMLElement | null;
    if (inputArea) inputArea.classList.toggle('hidden', isRouterSession);
    if (isRouterSession) showRouterBindUI();
    setSidebarActionState(null);
}

/** Open the Agent edit view */
function openAgentEditModal(editId?: string): void {
    editingAgentId = editId || null;
    const idGroup = agentEditId.closest('.settings-item') as HTMLElement;
    if (editId) {
        // Edit mode
        const agent = agentsList.find(a => a.id === editId);
        if (!agent) return;
        const kind = agent.kind === 'project' ? 'project' : 'agent';
        if (idGroup) idGroup.style.display = '';
        agentEditId.value = agent.id;
        agentEditId.disabled = true;
        agentEditName.value = agent.name || '';
        agentEditDesc.value = agent.description || '';
        agentEditIcon.value = agent.icon || '🤖';
        updateIconPreview(agent.icon || '🤖');
        setActiveIconGridItem(agent.icon || '🤖');
        agentEditColor.value = agent.color || '#737373';
        setActiveColorSwatch(agent.color || '#737373');
        agentEditPrompt.value = agent.systemPrompt || '';
        projectEditWorkspace.value = agent.workspace || '';
        projectEditRules.value = agent.defaultRules || '';
        setEditingEntityKind(kind, true);
    } else {
        // (ID ,ID
        if (idGroup) idGroup.style.display = 'none';
        agentEditId.value = '';
        agentEditName.value = '';
        agentEditDesc.value = '';
        agentEditIcon.value = '🤖';
        updateIconPreview('🤖');
        setActiveIconGridItem('🤖');
        agentEditColor.value = '#737373';
        setActiveColorSwatch('#737373');
        agentEditPrompt.value = '';
        projectEditWorkspace.value = '';
        projectEditRules.value = '';
        setEditingEntityKind('agent');
    }
    showAgentEditView();
}

/** Save the Agent (create or update) */
async function saveAgent(): Promise<void> {
    if (!gatewayClient) return;
    const name = agentEditName.value.trim();
    if (!name) { agentEditName.focus(); return; }
    const workspace = projectEditWorkspace.value.trim();
    if (editingEntityKind === 'project' && !workspace) {
        projectEditWorkspace.focus();
        return;
    }

    try {
        const common = {
            name,
            description: agentEditDesc.value.trim() || undefined,
            color: agentEditColor.value || undefined,
        };
        let createdAgentId: string | null = null;
        if (editingAgentId) {
            // Update
            await gatewayClient.updateAgent(editingAgentId, editingEntityKind === 'project'
                ? {
                    ...common,
                    workspace,
                    defaultRules: projectEditRules.value.trim(),
                }
                : {
                    ...common,
                    icon: agentEditIcon.value.trim() || undefined,
                    systemPrompt: agentEditPrompt.value.trim(),
                });
        } else {
            // (ID )
            const createdAgent = await gatewayClient.createAgent({
                id: '', // ignored by the backend; auto-generated
                kind: editingEntityKind,
                ...common,
                ...(editingEntityKind === 'project'
                    ? { workspace, defaultRules: projectEditRules.value.trim() || undefined }
                    : {
                        icon: agentEditIcon.value.trim() || undefined,
                        systemPrompt: agentEditPrompt.value.trim() || undefined,
                    }),
            });
            createdAgentId = typeof createdAgent.id === 'string' ? createdAgent.id : null;
        }
        hideAgentEditView();
        // switchToAgent 只更新会话区不渲染左侧卡片，必须重载列表，
        // 否则新建的 Agent 在重启前不会出现在左侧列表。
        // 先切换（设置 currentAgentId）再重载，渲染时选中态才正确。
        if (createdAgentId) {
            await switchToAgent(createdAgentId);
        }
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
    if (agent && agent.locked) {
        await showConfirmDialog(`内置 Agent "${agentName}" 不可删除。`);
        return;
    }
    const entityLabel = agent?.kind === 'project' ? '项目' : 'Agent';
    const confirmed = await showConfirmDialog(`确定要删除${entityLabel} "${agentName}" 吗？\n注意：相关聊天历史将被清除，项目目录中的文件不会被删除。`);
    if (!confirmed) return;
    try {
        await gatewayClient.deleteAgent(agentId);
        agentActiveSessionMap.delete(agentId);
        agentSessionsMap.delete(agentId);
        if (collapsedAgentSessionIds.delete(agentId)) persistCollapsedAgentSessionIds();
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

/** 删除云端会话（右键或删除按钮触发） */
async function deleteCloudSession(sessionId: string, agentName: string): Promise<void> {
    if (!gatewayClient || !sessionId) return;
    const confirmed = await showConfirmDialog(`确定要删除云端会话 "${agentName}" 吗？\n注意：该会话的聊天历史将被清除。`);
    if (!confirmed) return;
    try {
        const chatroomId = sessionToChatroomMap.get(sessionId);
        await gatewayClient.deleteSession(sessionId);
        activityView.clearSession(sessionId);
        sessionCompletedOutputs.delete(sessionId);
        sessionToChatroomMap.delete(sessionId);
        // 若删除的是当前会话，则清空聊天区域
        if (currentSessionId === sessionId || (chatroomId && currentCloudChatroomId === chatroomId)) {
            currentSessionId = null;
            currentCloudChatroomId = null;
            messagesContainer.innerHTML = '';
            clearArtifacts();
            syncCurrentSessionRuntimeUi();
        }
        await loadLocalAgents();
    } catch (e) {
        console.error('[Cloud] 删除云端会话失败:', e);
        await showConfirmDialog('删除失败: ' + (e as Error).message);
    }
}

// Agent
newSessionBtn.addEventListener('click', () => {
    closeSchedulerView();
    closeSettingsView();
    switchSidebarMode('agent');
    openAgentEditModal();
});
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

    const displayAgents = [...cachedOpenFluxAgents];
    for (const [chatroomId, info] of usedCloudSessions) {
        if (displayAgents.some(agent => agent.chatroomId === chatroomId)) continue;
        displayAgents.push({
            agentId: 0,
            appId: 0,
            name: info.agentName,
            description: '',
            chatroomId,
        });
    }

    if (displayAgents.length === 0) {
        const emptyEl = document.createElement('div');
        emptyEl.className = 'memory-empty-state';
        emptyEl.style.cssText = 'font-size:0.8rem;padding:16px;';
        emptyEl.textContent = t('cloud.no_agents');
        sidebarAgentList.appendChild(emptyEl);
        return;
    }
    for (const agent of displayAgents) {
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
        rememberSessionApprovalModes(sessions);
        const existing = sessions.find(s => s.cloudChatroomId === chatroomId);

        // 切换会话前：保存当前会话正在执行的动作卡片进度（与标准会话切换流程一致），
        // 避免离开正在执行的会话时丢失进度
        const leavingSessionId = currentSessionId;
        if (leavingSessionId && leavingSessionId !== existing?.id) {
            cacheCurrentProgressState(leavingSessionId);
        }

        // Cloud sessions are artifact-isolated as well. Hide the previous
        // session's panel before remote history can delay the transition.
        clearArtifacts();
        inputRow.classList.remove('plan-interaction-active');
        planInteraction.classList.add('hidden');
        planInteraction.replaceChildren();

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
            const selectedRuntime = sessionRuntimeStates.get(existing.id);
            if (selectedRuntime?.state === 'completed' || selectedRuntime?.state === 'stopped') {
                setSessionRuntimeState(existing.id, 'idle');
            } else {
                syncCurrentSessionRuntimeUi();
            }

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

            // ═══ 恢复动作卡片：若该云端会话仍在执行，重建实时进度卡片（缓存为空也显示"运行中"） ═══
            restoreRunningProgressCard(existing.id);
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
            syncCurrentSessionRuntimeUi();
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

        if (existing) {
            // 已存在的会话：仅更新左侧列表的选中高亮，不整体重载列表（避免列表跳转/闪烁）
            // 与标准 Agent 会话切换流程一致，只有右侧会话内容发生变化
            syncSidebarEntitySelection();
        } else {
            // 新建会话：刷新列表使新的云端会话卡片出现
            await loadLocalAgents();
        }
        closeSettingsView();
        syncCurrentSessionRuntimeUi();
        syncWorkModeUi();
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
    closeSchedulerView();
    // Restore artifacts (no longer persisted, since they're already on the server)
    clearArtifacts();
    inputRow.classList.remove('plan-interaction-active');
    planInteraction.classList.add('hidden');
    planInteraction.replaceChildren();

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
        const selectedRuntime = sessionRuntimeStates.get(routerRealSessionId);
        if (selectedRuntime?.state === 'completed' || selectedRuntime?.state === 'stopped') {
            setSessionRuntimeState(routerRealSessionId, 'idle');
        } else {
            syncCurrentSessionRuntimeUi();
        }
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
        syncCurrentSessionRuntimeUi();
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
    syncCurrentSessionRuntimeUi();
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
            if (hint) { hint.textContent = 'X ' + (result.message ? tServerCopy(result.message) : t('common.save_failed')); }
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
            hint.textContent = tServerCopy(String(result.message ?? ''));
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
                loadingSessions.add(routerRealSessionId);
                setSessionRuntimeState(routerRealSessionId, 'running', { label: t('chat.thinking') });
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
// 设计画布（独立窗口）
// ========================
async function openDesignCanvas(): Promise<void> {
    try {
        const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
        // 已存在则聚焦，不重复创建
        const existing = await WebviewWindow.getByLabel('canvas');
        if (existing) {
            await existing.show();
            await existing.setFocus();
            return;
        }
        const theme = document.documentElement.getAttribute('data-theme') || 'dark';
        const canvasUrl = `${window.location.origin}/canvas.html?theme=${theme}`;
        const win = new WebviewWindow('canvas', {
            url: canvasUrl,
            title: '🎨 设计画布',
            width: 1100,
            height: 760,
            minWidth: 520,
            minHeight: 400,
            center: true,
            decorations: false,
            resizable: true,
            focus: true,
            dragDropEnabled: false, // 关闭原生拖放，改由网页 HTML5 drop 处理（拖图片进画布）
        });
        win.once('tauri://error', (e) => console.error('Failed to create canvas window:', e));
    } catch {
        window.open('/canvas.html', '_blank', 'width=1100,height=760');
    }
}
(window as any).openDesignCanvas = openDesignCanvas;

(function initCanvasButton() {
    const btn = document.getElementById('canvas-open-btn');
    if (!btn) return;
    btn.addEventListener('click', () => { openDesignCanvas(); });
})();

/** 是否图片文件（按扩展名） */
function isImageFile(name: string): boolean {
    const ext = (name.split('.').pop() || '').toLowerCase();
    return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext);
}

/**
 * 等待画布窗口连接并注册到 Gateway（事件驱动 + 轮询兜底）。
 * dev 模式下画布窗口首次打开需现编译，可能耗时较长，故超时放宽。
 */
function waitForCanvasOpen(timeoutMs = 30000): Promise<boolean> {
    return new Promise((resolve) => {
        if (!gatewayClient) { resolve(false); return; }
        const gw = gatewayClient;
        let done = false;
        const finish = (v: boolean) => {
            if (done) return;
            done = true;
            gw.removeMessageHandler(handler);
            clearInterval(poll);
            clearTimeout(to);
            resolve(v);
        };
        const handler = (msg: GatewayMessage) => {
            if (msg.type === 'canvas.status' && (msg.payload as { open?: boolean })?.open) finish(true);
        };
        gw.addMessageHandler(handler);
        const poll = setInterval(() => gw.sendMessage({ type: 'canvas.status.query' }), 700);
        gw.sendMessage({ type: 'canvas.status.query' });
        const to = setTimeout(() => finish(false), timeoutMs);
    });
}

/**
 * 把一张本地图片送入设计画布：
 * 先打开/聚焦画布窗口，等待其连接后通过 Gateway 把图片插入画布。
 */
async function sendImageToCanvas(filePath: string, caption?: string): Promise<void> {
    await openDesignCanvas();
    if (!gatewayClient) return;

    const ready = await waitForCanvasOpen(30000);
    if (!ready) {
        setStatus(t('canvas.not_ready'), 'error');
        console.warn('[canvas] 画布窗口未就绪，放弃送入');
        return;
    }

    // 画布已就绪，发送插入；偶发竞态再重试几次
    for (let i = 0; i < 5; i++) {
        try {
            const res = await gatewayClient.request<{ error?: string; inserted?: boolean }>(
                'canvas.insert', { path: filePath, caption }, 30000,
            );
            if (res?.error === 'canvas_closed') {
                await new Promise(r => setTimeout(r, 600));
                continue;
            }
            if (res?.error) throw new Error(res.error);
            return; // 成功
        } catch (e) {
            console.warn('[canvas] insert 重试', i, e);
            await new Promise(r => setTimeout(r, 600));
        }
    }
    setStatus(t('canvas.insert_failed'), 'error');
}
(window as any).sendImageToCanvas = sendImageToCanvas;

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
bindUpdateUi({
    getActiveTaskCount: () => {
        const running = new Set(activeTurnBySession.keys());
        for (const [sessionId, runtime] of sessionRuntimeStates) {
            if (runtime.state === 'running') running.add(sessionId);
        }
        return running.size;
    },
});
// ( UI
setTimeout(() => initVoice(), 1000);
