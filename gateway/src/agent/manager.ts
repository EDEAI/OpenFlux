/**
 * Agent Manager - Multiple Agent Manager
 * Manage Agent configuration, tool filtering, route dispatch, and execution entry
 */

import type { OpenFluxConfig, AgentConfig, AgentsConfig } from '../config/schema';
import { buildAgentMainKey, normalizeAgentId, DEFAULT_AGENT_ID } from '../utils/session-key';
import type { LLMProvider } from '../llm/provider';
import type { ToolRegistry } from '../tools/registry';
import type { Tool } from '../tools/types';
import type { AgentToolsConfig } from '../tools/policy';
import { createLLMProvider } from '../llm/factory';
import { createAgentLoopRunner } from './loop';
import { routeToAgent, type RouteResult } from './router';
import { createSubAgentExecutor } from './subagent';
import { createSpawnTool } from '../tools/spawn';
import { createSessionsSpawnTool } from '../tools/sessions-spawn';
import { createSessionsSendTool } from '../tools/sessions-send';
import { createSessionsSearchTool } from '../tools/sessions-search';
import { CollaborationManager, getCollaborationManager, type CollabAgentInfo, type CollabSessionCompleteCallback } from './collaboration';
import { SessionStore } from '../sessions';
import type { AgentProgressEvent } from '../gateway';
import type { MemoryManager } from './memory/manager';
import { buildEnrichedInput, type ChatAttachment, type ImageAttachmentData } from '../utils/file-reader';
import type { LLMContentPart } from '../llm/provider';
import { Logger } from '../utils/logger';
import { formatNow, getTodayStr, formatDate, getEnvProbe } from '../utils/env-probe';
import type { ToolApprovalDecision, ToolApprovalRequest } from '../tools/types';
import { redactSensitiveValue } from '../security/redaction';
import {
    getAgentExecutionContext,
    runWithAgentExecutionContext,
    type DrainSteering,
} from '../runtime/execution-context';
import type { ApprovalMode } from '../permissions/checker';
import { describeToolAction, describeToolCompletion } from '../runtime/activity-descriptor';

const log = new Logger('AgentManager');

// ========================
// User input language detection
// ========================

/**
 * Detect primary language of user input (lightweight charset rules, no LLM required)
 * It is only used to determine the Agent reply language and does not affect the config.language setting of the system UI.
 */
function detectInputLanguage(text: string): 'zh' | 'ja' | 'ko' | 'en' {
    const cleaned = text.replace(/\s/g, '');
    if (!cleaned) return 'en';
    const zhCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const jaCount = (text.match(/[\u3040-\u309f\u30a0-\u30ff]/g) || []).length;
    const koCount = (text.match(/[\uac00-\ud7af]/g) || []).length;
    const total = cleaned.length;
    if (zhCount / total > 0.15) return 'zh';
    if (jaCount / total > 0.15) return 'ja';
    if (koCount / total > 0.15) return 'ko';
    return 'en';
}

// ========================
// type definition
// ========================

/** AgentManager initialization parameters */
export interface AgentManagerOptions {
    /** Global configuration */
    config: OpenFluxConfig;
    /** Full tool registry (unfiltered) */
    tools: ToolRegistry;
    /** Default LLM Provider (orchestration) */
    defaultLLM: LLMProvider;
    /** Session storage */
    sessions: SessionStore;
    /** Memory manager */
    memoryManager?: MemoryManager;
    /** File output path (obtained dynamically and injected into the system prompt) */
    getOutputPath?: () => string;
    /** User Agent storage (for collaborative fusion) */
    getUserAgents?: () => Array<{ id: string; name: string; description?: string; systemPrompt?: string }>;
}

export interface AgentRunOptions {
    /** One-shot LLM override for a single run; does not update cached agent contexts. */
    llmOverride?: LLMProvider;
    /** Internal retry for the same user message; avoids duplicating it in history and persistence. */
    retryCurrentUserMessage?: boolean;
    /**
     * Whether the raw model answer should be appended to the visible session.
     *
     * Group Project requests ask the model for an internal JSON envelope.  The
     * caller parses that envelope and persists only the public reply, so saving
     * the raw answer here would leak implementation details into the chat UI.
     */
    persistAssistantOutput?: boolean;
    /** Whether the internal execution prompt should be appended as a visible user message. */
    persistUserInput?: boolean;
    /**
     * User-facing text persisted in the session while `input` remains the full
     * internal execution prompt consumed by the Agent.
     */
    visibleUserInput?: string;
    /**
     * Converts an internal machine-readable Agent result into the text shown
     * in the conversation. The raw result is still returned to the caller.
     */
    visibleAssistantOutput?: (output: string) => string;
    /** Extra metadata attached to the visible assistant message. */
    assistantMetadata?: Record<string, unknown>;
    /** Stable ID supplied by the thread/turn runtime. */
    turnId?: string;
    /** Interactive approval bridge for risk-gated tools. */
    requestApproval?: (request: ToolApprovalRequest) => Promise<ToolApprovalDecision>;
    /** Approval policy frozen for this run. */
    approvalMode?: ApprovalMode;
    /** FIFO mailbox for guidance sent to the currently running turn. */
    drainSteering?: DrainSteering;
    /** Lease check used to suppress persistence from a retired physical execution. */
    isRunActive?: () => boolean;
    /** Keep the native Agent lifecycle while exposing no tools for analysis-only turns. */
    disableTools?: boolean;
    /** One-shot tools available only to this run, such as a scoped collaboration control. */
    additionalTools?: Tool[];
    /** Optional one-shot allow-list applied after the Agent profile policy. */
    allowedToolNames?: string[];
}

/** Agent runtime context (internal cache) */
interface AgentContext {
    config: AgentConfig;
    llm: LLMProvider;
    tools: ToolRegistry;
    runner: ReturnType<typeof createAgentLoopRunner>;
}

// ========================
// AgentManager
// ========================

export class AgentManager {
    private options: AgentManagerOptions;
    private agentsConfig: AgentsConfig;
    private contextCache = new Map<string, AgentContext>();
    /** 绑定 Agent 注册表（User Agent 绑定的工具集，不参与自动路由） */
    private boundAgents = new Map<string, AgentConfig>();
    private collaborationManager: CollaborationManager;
    private routerLLM: LLMProvider;
    /** Session stickiness: Record the Agent ID of the previous round of routing for each session */
    private lastRouteAgentId = new Map<string, string>();

    constructor(options: AgentManagerOptions) {
        this.options = options;

        // If there is no agents configuration, construct single-Agent compatibility mode
        this.agentsConfig = options.config.agents || {
            list: [{
                id: 'default',
                default: true,
                name: '通用助手',
            }],
        };

        // Router LLM
        const routerModelConfig = this.agentsConfig.router?.model;
        if (routerModelConfig) {
            this.routerLLM = createLLMProvider({
                provider: routerModelConfig.provider,
                model: routerModelConfig.model,
                apiKey: routerModelConfig.apiKey || this.resolveApiKey(routerModelConfig.provider),
                baseUrl: routerModelConfig.baseUrl,
                temperature: routerModelConfig.temperature,
                maxTokens: routerModelConfig.maxTokens,
            });
        } else {
            this.routerLLM = options.defaultLLM;
        }

        // Initialize collaboration manager
        this.collaborationManager = getCollaborationManager();
        this.initCollaboration();

        log.info(`AgentManager initialized: ${this.agentsConfig.list.length} Agents`);
        for (const agent of this.agentsConfig.list) {
            log.info(`  - ${agent.id}: ${agent.name || '(unnamed)'}` +
                (agent.default ? ' [default]' : '') +
                (agent.tools?.profile ? ` [profile: ${agent.tools.profile}]` : ''));
        }
    }

    // ========================
    // Skill runtime injection
    // ========================

    /**
     * Runtime injection of skills (available immediately after installation, no reboot required)
     */
    addSkill(skill: { id: string; title: string; content: string }): void {
        if (!this.agentsConfig.skills) {
            this.agentsConfig.skills = [];
        }
        // If the id is the same, replace
        const idx = this.agentsConfig.skills.findIndex(s => s.id === skill.id);
        if (idx >= 0) {
            this.agentsConfig.skills[idx] = { ...skill, enabled: true };
        } else {
            this.agentsConfig.skills.push({ ...skill, enabled: true });
        }
        log.info(`Skill injected: ${skill.id} (${skill.title})`);
    }

    /**
     * Remove skills at runtime
     */
    removeSkill(skillId: string): boolean {
        if (!this.agentsConfig.skills) return false;
        const before = this.agentsConfig.skills.length;
        this.agentsConfig.skills = this.agentsConfig.skills.filter(s => s.id !== skillId);
        const removed = this.agentsConfig.skills.length < before;
        if (removed) log.info(`Skill removed: ${skillId}`);
        return removed;
    }

    // ========================
    // public method
    // ========================

    /**
     * Get all Agent configurations
     */
    getAgents(): AgentConfig[] {
        return this.agentsConfig.list;
    }

    /**
     * Get the Agent list (including sessionKey, for front-end use)
     */
    getAgentList(): Array<AgentConfig & { sessionKey: string }> {
        return this.agentsConfig.list.map(a => ({
            ...a,
            sessionKey: buildAgentMainKey(a.id),
        }));
    }

    /**
     * Get the main session key bound to the Agent
     */
    getAgentSessionKey(agentId: string): string {
        return buildAgentMainKey(agentId);
    }

    /**
     * Get the specified Agent configuration
     * 优先返回路由 Agent；其次返回「绑定 Agent」（User Agent 绑定的工具集，不参与自动路由）。
     */
    getAgent(agentId: string): AgentConfig | undefined {
        return this.agentsConfig.list.find(a => a.id === agentId) || this.boundAgents.get(agentId);
    }

    /**
     * 注册/同步「绑定 Agent」。
     *
     * 用于 User Agent 绑定工具 Profile（如设计师 = design）。这些 Agent 仅在显式
     * 指定 agentId 执行时生效，不会被加入 agentsConfig.list，因此不会污染其它会话的自动路由。
     * 仅当配置变化时才清除上下文缓存（避免每次执行重建工具集）。
     */
    registerBoundAgent(config: AgentConfig): void {
        const prev = this.boundAgents.get(config.id);
        const changed = !prev
            || prev.name !== config.name
            || prev.description !== config.description
            || prev.systemPrompt !== config.systemPrompt
            || prev.workspace !== config.workspace
            || prev.kind !== config.kind
            || prev.projectRules !== config.projectRules
            || prev.codeFirst !== config.codeFirst
            || JSON.stringify(prev.tools) !== JSON.stringify(config.tools)
            || JSON.stringify(prev.model) !== JSON.stringify(config.model);
        this.boundAgents.set(config.id, config);
        if (changed) {
            this.contextCache.delete(config.id);
            log.info(`Bound agent registered/updated: ${config.id}`, {
                name: config.name,
                profile: config.tools?.profile,
            });
        }
    }

    /**
     * Get the default agent
     */
    getDefaultAgent(): AgentConfig {
        return this.agentsConfig.list.find(a => a.default) || this.agentsConfig.list[0];
    }

    /**
     * Get a list of all Agent IDs
     */
    getAgentIds(): string[] {
        return this.agentsConfig.list.map(a => a.id);
    }

    /**
     * Get collaboration manager
     */
    getCollaborationManager(): CollaborationManager {
        return this.collaborationManager;
    }

    /**
     * Whether to enable routing
     */
    isRouterEnabled(): boolean {
        return this.agentsConfig.router?.enabled !== false && this.agentsConfig.list.length > 1;
    }

    // ========================
    // Dynamic Agent Management (CRUD)
    // ========================

    /**
     * Dynamically create Agent
     */
    createAgent(agentConfig: AgentConfig): AgentConfig {
        const id = normalizeAgentId(agentConfig.id);
        if (this.agentsConfig.list.find(a => a.id === id)) {
            throw new Error(`Agent already exists: ${id}`);
        }

        const config: AgentConfig = {
            ...agentConfig,
            id,
        };

        // If it is the first Agent and there is no default tag, set it to default
        if (this.agentsConfig.list.length === 0 || (!this.agentsConfig.list.some(a => a.default) && !config.default)) {
            config.default = true;
        }

        this.agentsConfig.list.push(config);
        log.info(`Agent created: ${id}`, { name: config.name });
        return config;
    }

    /**
     * Dynamically update Agent configuration
     */
    updateAgent(agentId: string, updates: Partial<AgentConfig>): AgentConfig {
        const idx = this.agentsConfig.list.findIndex(a => a.id === agentId);
        if (idx === -1) {
            throw new Error(`Agent not found: ${agentId}`);
        }

        // Merge updates (modification of id is not allowed)
        const current = this.agentsConfig.list[idx];
        const updated: AgentConfig = {
            ...current,
            ...updates,
            id: current.id, // id is immutable
        };

        this.agentsConfig.list[idx] = updated;

        // Clear the cache and rebuild it the next time you execute it
        this.contextCache.delete(agentId);

        log.info(`Agent updated: ${agentId}`, { name: updated.name });
        return updated;
    }

    /**
     * Dynamically delete Agent
     */
    deleteAgent(agentId: string): boolean {
        const idx = this.agentsConfig.list.findIndex(a => a.id === agentId);
        if (idx === -1) return false;

        const wasDefault = this.agentsConfig.list[idx].default;
        this.agentsConfig.list.splice(idx, 1);
        this.contextCache.delete(agentId);

        // If the default Agent is deleted, set the first one as the default
        if (wasDefault && this.agentsConfig.list.length > 0) {
            this.agentsConfig.list[0].default = true;
        }

        log.info(`Agent deleted: ${agentId}`);
        return true;
    }

    /**
     * Get agents configuration (for persistence to openflux.yaml)
     */
    getAgentsConfig(): AgentsConfig {
        return this.agentsConfig;
    }

    /**
     * Hot update LLM Provider (called after configuration changes)
     * Clear all Agent context caches and rebuild them on next execution
     */
    updateLLM(orchestrationLLM: LLMProvider, _executionLLM?: LLMProvider): void {
        this.options.defaultLLM = orchestrationLLM;
        this.routerLLM = orchestrationLLM;
        this.contextCache.clear();
        log.info('LLM Provider hot-updated, Agent context cache cleared');
    }

    /**
     * Hot update global Agent settings (name, system prompts)
     * Called after the initialization wizard is completed or the settings panel is modified
     */
    updateGlobalSettings(settings: { globalAgentName?: string; globalSystemPrompt?: string }): void {
        if (settings.globalAgentName !== undefined) {
            this.agentsConfig.globalAgentName = settings.globalAgentName || undefined;
        }
        if (settings.globalSystemPrompt !== undefined) {
            this.agentsConfig.globalSystemPrompt = settings.globalSystemPrompt || undefined;
        }
        this.contextCache.clear();
        log.info('Global agent settings updated', {
            agentName: settings.globalAgentName,
            hasPrompt: !!settings.globalSystemPrompt,
        });
    }

    /**
     * Automatic routing: analyze user intent and select Agent
     * @param sessionId session ID (used for session stickiness)
     */
    async resolve(input: string, sessionId?: string): Promise<RouteResult> {
        const uiLanguage = this.options.config.language;
        if (!this.isRouterEnabled()) {
            const defaultAgent = this.getDefaultAgent();
            return {
                agentId: defaultAgent.id,
                reason: (uiLanguage || 'zh-CN').startsWith('zh')
                    ? '路由未启用或仅一个 Agent'
                    : 'Router disabled or only one agent',
                usedLLM: false,
            };
        }

        // Pass in the previous round of Agent ID to achieve session stickiness
        // 传入界面语言，路由提示语（如“已为您匹配…”）跟随 UI 语言
        const lastAgentId = sessionId ? this.lastRouteAgentId.get(sessionId) : undefined;
        return routeToAgent(input, this.agentsConfig.list, this.routerLLM, lastAgentId, uiLanguage);
    }

    /**
     * Core execution entry
     *
     * @param input user input
     * @param agentId Agent ID (automatic routing if not passed)
     * @param sessionId session ID
     * @param onProgress progress callback
     * @param attachments File attachments dragged by the user
     */
    async run(
        input: string,
        agentId?: string,
        sessionId?: string,
        onProgress?: (event: AgentProgressEvent) => void,
        attachments?: ChatAttachment[],
        userMetadata?: Record<string, unknown>,
        globalSettingsOverride?: { globalAgentName?: string; globalSystemPrompt?: string },
        abortSignal?: AbortSignal,
        runOptions?: AgentRunOptions,
    ): Promise<{ output: string; agentId: string; routeResult?: RouteResult }> {
        const detectedInputLang = detectInputLanguage(input);
        if (!runOptions?.retryCurrentUserMessage) {
            onProgress?.({
                type: 'commentary',
                commentary: detectedInputLang === 'zh'
                    ? '正在选择合适的 Agent，并准备会话上下文。'
                    : 'Selecting the right Agent and preparing the conversation context.',
            });
        }

        // 1. Determine Agent
        let resolvedAgentId: string;
        let routeResult: RouteResult | undefined;

        if (agentId) {
            // Explicitly specified
            resolvedAgentId = agentId;
        } else {
            // Automatic routing (pass in sessionId to achieve stickiness)
            routeResult = await this.resolve(input, sessionId);
            resolvedAgentId = routeResult.agentId;

            // Push routing events
            if (routeResult.usedLLM) {
                const selectedAgent = this.agentsConfig.list.find(agent => agent.id === resolvedAgentId);
                const selectedName = selectedAgent?.name || resolvedAgentId;
                onProgress?.({
                    type: 'commentary',
                    commentary: detectedInputLang === 'zh'
                        ? `已选择“${selectedName}”，正在加载工具和会话上下文。`
                        : `Selected “${selectedName}”; loading tools and conversation context.`,
                });
            }
        }

        // Record the routing results of this round (used for the next round of session stickiness)
        if (sessionId && runOptions?.persistAssistantOutput !== false) {
            this.lastRouteAgentId.set(sessionId, resolvedAgentId);
        }

        // 2. Get Agent context
        const ctx = this.getOrCreateContext(resolvedAgentId);
        if (!ctx) {
            throw new Error(`Agent does not exist: ${resolvedAgentId}`);
        }

        log.info(`Executing task`, {
            agentId: resolvedAgentId,
            input: input.slice(0, 100),
            sessionId,
            toolCount: ctx.tools.getToolNames().length,
        });

        // 3. Load session history (collaboration message isolation + token-level truncation)
        let history: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [];
        let collabSummaryForPrompt = '';
        const MAX_HISTORY_TOKENS = 8000;
        const MIN_HISTORY_MESSAGES = 3;

        if (sessionId) {
            const sessionMessages = this.options.sessions.getRecentMessages(sessionId, 200);
            let allMapped = sessionMessages
                .map(msg => ({
                    role: msg.role as 'user' | 'assistant' | 'system',
                    content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
                }))
                .filter(msg => msg.content && msg.content.trim().length > 0);
            if (runOptions?.retryCurrentUserMessage && allMapped.at(-1)?.role === 'user') {
                allMapped = allMapped.slice(0, -1);
            }

            // Separate collaboration messages and user conversations (system tool-context messages are included in the user conversation flow)
            const userMessages = allMapped.filter(m => !m.content.startsWith('[Collaboration'));
            const collabMessages = allMapped.filter(m => m.content.startsWith('[Collaboration'));

            // Token-aware truncate user conversation (P2)
            let tokenCount = 0;
            const selected: typeof userMessages = [];
            for (let i = userMessages.length - 1; i >= 0; i--) {
                // Simple estimation of token number: Chinese ~1.5 token/word, English ~0.75 token/word
                const msgTokens = Math.ceil(userMessages[i].content.length * 0.8);
                if (selected.length >= MIN_HISTORY_MESSAGES && tokenCount + msgTokens > MAX_HISTORY_TOKENS) break;
                selected.unshift(userMessages[i]);
                tokenCount += msgTokens;
            }
            history = selected;

            // Compress collaboration messages into digests (retain at most the 10 most recent messages, each message is truncated)
            if (collabMessages.length > 0) {
                const recentCollab = collabMessages.slice(-10);
                collabSummaryForPrompt = '\n\n## Recent Collaboration Results\n';
                for (const cm of recentCollab) {
                    // Extract key information (remove [Collaboration Announce] prefix)
                    const cleaned = cm.content.replace(/^\[Collaboration Announce\]\s*/, '');
                    collabSummaryForPrompt += `- ${cleaned.slice(0, 200)}${cleaned.length > 200 ? '...' : ''}\n`;
                }
            }

            log.info('Loading session history', {
                sessionId,
                userMessages: history.length,
                collabMessages: collabMessages.length,
                estimatedTokens: tokenCount,
            });

            // P1: Automatically precipitate discarded conversations into Micro cards (asynchronous, not blocking the main process)
            const discardedCount = userMessages.length - selected.length;
            if (discardedCount >= 3) {
                const discarded = userMessages.slice(0, discardedCount);
                const cardMgr = (this.options.memoryManager as any)?._cardManager;
                if (cardMgr && typeof cardMgr.distillConversation === 'function') {
                    cardMgr.distillConversation(discarded, sessionId).catch((err: Error) => {
                        log.warn('Auto-distillation failed (non-blocking)', { error: err.message });
                    });
                }
            }
        }

        // 4. Save user messages (including attachment metadata to restore display after switching sessions)
        if (sessionId && !runOptions?.retryCurrentUserMessage && runOptions?.persistUserInput !== false) {
            // If the user does not enter text but uploads an attachment, use the attachment file name as the message content
            let saveContent = runOptions?.visibleUserInput ?? input;
            if (!saveContent?.trim() && attachments?.length) {
                saveContent = `[上传文件: ${attachments.map(a => a.name).join(', ')}]`;
            }
            this.options.sessions.addMessage(sessionId, {
                role: 'user',
                content: saveContent || input,
                attachments: attachments?.length
                    ? attachments.map(a => ({ path: a.path, name: a.name, ext: a.ext, size: a.size }))
                    : undefined,
                metadata: {
                    ...(userMetadata || {}),
                    ...(runOptions?.turnId ? { turnId: runOptions.turnId } : {}),
                },
            });
        }

        // 5. Build system prompt (injection output path + current time)
        // Note: agentPrompt may be undefined, in which case loop.ts will use DEFAULT_SYSTEM_PROMPT
        // outputPathInfo and timeInfo are appended information and should not cause the default prompt to be skipped
        let agentPrompt = ctx.config.systemPrompt;

        // Detect user input language (used to inject reply language instructions at the end of promptSuffix)
        let promptSuffix = '';

        const projectWorkspace = ctx.config.kind === 'project' ? ctx.config.workspace?.trim() : undefined;
        const outputPath = projectWorkspace || this.options.getOutputPath?.();
        if (projectWorkspace) {
            promptSuffix += `\n\n## 当前项目运行边界（必须遵守）\n项目根目录：${projectWorkspace}\n- filesystem、process、coding_agent 与生成类工具的默认目录均为该项目根目录。\n- 优先修改和验证项目中的现有实现；不要创建 OpenFlux 日期归档目录。\n- 除非用户明确指定其它位置，不要把项目成果写入 OpenFlux 全局 output 目录。`;
        } else if (outputPath) {
            const todayStr = getTodayStr();

            promptSuffix += `\n\n## 文件输出规则（必须严格遵守）\n基础输出目录：${outputPath}\n\n### 1. 任务目录归档\n当任务需要产生文件输出时，必须按以下结构创建独立目录：\n\`${outputPath}/${todayStr}/<任务描述>/\`\n\n规则：\n- 日期目录格式：YYYY-MM-DD（今天是 ${todayStr}）\n- 任务描述：用简短中文概括任务内容（如"销售数据分析"、"产品方案策划"、"数据处理脚本"、"技术报告"、"市场调研汇总"、"图片生成"、"网页爬取"、"翻译文档"）。不同任务根据具体内容命名，最多8个字\n- 目录名必须唯一：先用 filesystem.list 检查同日期目录下是否有同名目录，若存在则加数字后缀（如"销售数据分析_2"）\n- 该任务产生的所有文件都放在此任务目录内\n- filesystem.write 使用相对路径时会自动解析到基础输出目录，所以你需要写完整子路径如 \`${todayStr}/任务描述/文件名\`\n\n### 2. 非编码任务的中间代码清理\n判断：如果用户的核心目标不是获得代码（如"分析数据"、"写报告"、"搜索整理信息"、"生成图表"、"制作文档"、"数据转换"），则属于非编码任务。\n- 非编码任务中创建的辅助脚本（.py .js .ts .sh .bat 等），在最终产出物生成后，用 filesystem.delete 删除这些中间代码文件\n- 只删除当前任务输出目录内的文件，绝不触碰其他目录的任何内容\n- 保留最终产出物（文档、图片、数据文件等）\n- 如果用户明确要求保留代码则不删除\n\n### 3. 禁止事项\n- 不要将文件保存到桌面、C:\\\\temp 等位置\n- process 工具的 cwd 应设为当前任务输出目录`;
        }

        // Inject the current system time early so the LLM correctly understands references such as "today".
        const now = new Date();
        const dateStr = formatNow();
        promptSuffix += `\n\n## 当前时间（重要）\n现在是 ${dateStr}（${now.toISOString()}）。\n- 当用户提到"今天""最新""当前"等时间词时，必须基于上述时间\n- 搜索新闻、资讯时，搜索词中必须包含正确的年月日\n- 生成文件名时使用正确的日期`;

        // Inject environment detection information (time zone/available CLI tool)
        const envProbeResult = getEnvProbe();
        if (envProbeResult.systemPromptHint) {
            promptSuffix += `\n\n${envProbeResult.systemPromptHint}`;
        }

        // Inject the collaborating Agent list (if multiple Agents are available)
        const collabAgents = this.collaborationManager.getAgentInfos();
        // Exclude the current Agent itself
        const peerAgents = collabAgents.filter(a => a.id !== resolvedAgentId);
        if (peerAgents.length > 0) {
            promptSuffix += `\n\n## Multi-Agent Collaboration (${peerAgents.length} agents available)`;
            promptSuffix += '\nYou have access to other specialized agents. Use the sessions_spawn tool internally to delegate tasks to them.';
            promptSuffix += '\nWhen writing delegated tasks, define completion by required facts, sections, outputs, and verification.';
            promptSuffix += '\nDo not invent minimum KB/byte/word-count targets. Length limits are strict only when the user explicitly requested the exact limit; otherwise describe them as optional guidance and never ask an Agent to tune bytes.';

            const builtinPeers = peerAgents.filter(a => a.type === 'builtin');
            const userPeers = peerAgents.filter(a => a.type === 'user');

            if (builtinPeers.length > 0) {
                promptSuffix += '\n\n### Built-in Agents:';
                for (const a of builtinPeers) {
                    const desc = a.description ? ` — ${a.description}` : '';
                    promptSuffix += `\n- **${a.id}**: ${a.name}${desc}`;
                }
            }
            if (userPeers.length > 0) {
                promptSuffix += '\n\n### User-defined Agents:';
                for (const a of userPeers) {
                    const desc = a.description ? ` — ${a.description}` : '';
                    promptSuffix += `\n- **${a.id}**: ${a.name}${desc}`;
                }
            }

            promptSuffix += `\n\n> The above is the COMPLETE list of ALL ${peerAgents.length} available agents. When the user asks about available agents or colleagues, you MUST include ALL of them.`;
            promptSuffix += '\n\n### Important: User-facing Communication Rules';
            promptSuffix += '\n- NEVER show tool call syntax (like sessions_spawn, batch=[...]) to the user';
            promptSuffix += '\n- When explaining collaboration to users, use natural language. Example:';
            promptSuffix += '\n  ✅ "我可以让营销助手帮你制定推广方案，需要我安排吗？"';
            promptSuffix += '\n  ✅ "我已经安排编程助手处理这个任务了，稍等片刻。"';
            promptSuffix += '\n  ❌ "使用 sessions_spawn(agentId=\\"coder\\", task=\\"...\\")"';
            promptSuffix += '\n- The user only needs to describe their needs in plain language; you handle the tool calls internally';
            promptSuffix += '\n\n### Internal Tool Usage (do not expose to user):';
            promptSuffix += '\n- Single task: sessions_spawn(agentId="...", task="...")';
            promptSuffix += '\n- Multi-round: sessions_spawn(agentId="...", task="...", mode="session")';
            promptSuffix += '\n- Batch: sessions_spawn(batch=[...])';
        }

        // Inject collaboration message summary (isolation count, does not occupy the conversation window)
        if (collabSummaryForPrompt) {
            promptSuffix += collabSummaryForPrompt;
        }

        // Inject recent task context (helps LLM focus on the last task and avoid being disturbed by old topics)
        if (history.length >= 2) {
            // Find the last pair of user->assistant interactions
            let lastUserMsg = '';
            let lastAssistantMsg = '';
            for (let i = history.length - 1; i >= 0; i--) {
                if (!lastAssistantMsg && history[i].role === 'assistant') {
                    lastAssistantMsg = history[i].content;
                }
                if (lastAssistantMsg && !lastUserMsg && history[i].role === 'user') {
                    lastUserMsg = history[i].content;
                    break;
                }
            }
            if (lastUserMsg && lastAssistantMsg) {
                const userSnippet = lastUserMsg.length > 200 ? lastUserMsg.slice(0, 200) + '...' : lastUserMsg;
                const assistantSnippet = lastAssistantMsg.length > 500 ? lastAssistantMsg.slice(0, 500) + '...' : lastAssistantMsg;
                promptSuffix += `\n\n## 最近任务上下文（重要）\n以下是你上一次完成的任务，当用户的提问与此相关时，优先基于此上下文回答：\n- **用户请求**: ${userSnippet}\n- **你的回复**: ${assistantSnippet}\n\n注意：对话历史中可能包含更早的无关话题，请优先关注最近的任务上下文和用户当前的新请求。`;
            }
        }

        // Inject historical attachment paths (prevent LLM from searching for known files and read them directly with file_reader)
        if (sessionId && !attachments?.length) {
            const sessionMessages = this.options.sessions.getRecentMessages(sessionId, 10);
            const recentAttachments: Array<{ name: string; path: string }> = [];
            for (const msg of sessionMessages.slice(-10)) {
                if ((msg as any).attachments?.length) {
                    for (const att of (msg as any).attachments) {
                        if (att.path && !recentAttachments.some((a: any) => a.path === att.path)) {
                            recentAttachments.push({ name: att.name, path: att.path });
                        }
                    }
                }
            }
            if (recentAttachments.length > 0) {
                const attList = recentAttachments.map(a => '- ' + a.name + ': ' + a.path).join('\n');
                promptSuffix += '\n\n## 历史附件（已知文件路径）\n以下文件在本次对话中已被处理，如需再次读取，直接使用 file_reader 工具，无需搜索文件系统：\n' + attList;
            }
        }

        // Inject the reply language command (dynamically generated following the user input language and does not conflict with the config.language UI setting)
        const langInstruction: Record<string, string> = {
            zh: '\n\n## 回复语言\n用户使用中文，请用中文回复。',
            en: '\n\n## Response Language\nThe user is writing in English. Please respond in English.',
            ja: '\n\n## 返答言語\nユーザーは日本語で入力しています。日本語で返答してください。',
            ko: '\n\n## 응답 언어\n사용자가 한국어로 입력하고 있습니다. 한국어로 응답하세요。',
        };
        promptSuffix += langInstruction[detectedInputLang] ?? '';

        // Only splice when there is additional content, keeping the semantics of undefined unchanged.
        if (promptSuffix) {
            agentPrompt = (agentPrompt || '') + promptSuffix;
        }

        // 5.5 Attachment preprocessing: extract file content and inject it into input; convert images into multi-modal contentParts
        let enrichedInput = input;
        let contentParts: LLMContentPart[] | undefined;

        if (attachments?.length) {
            log.info('Processing user attachments', { count: attachments.length, files: attachments.map(a => a.name) });
            onProgress?.({
                type: 'tool_start',
                description: `正在读取 ${attachments.length} 个附件...`,
            });
            const enriched = await buildEnrichedInput(attachments, input);
            enrichedInput = enriched.text;

            // If there are images, build multi-modal contentParts
            if (enriched.images.length > 0) {
                contentParts = [];
                // Put pictures first
                for (const img of enriched.images) {
                    contentParts.push({
                        type: 'image',
                        mimeType: img.mimeType,
                        data: img.base64,
                    });
                }
                // put text again
                contentParts.push({
                    type: 'text',
                    text: enrichedInput,
                });
                log.info('Building multimodal message', { imageCount: enriched.images.length });
            }

            log.info('Attachment preprocessing done', { enrichedLength: enrichedInput.length, hasImages: !!contentParts });
        }

        // 6. Run Agent Loop
        const hasOneShotToolPolicy = Boolean(
            runOptions?.disableTools
            || runOptions?.additionalTools?.length
            || runOptions?.allowedToolNames,
        );
        let runnerTools = runOptions?.disableTools
            ? ctx.tools.filter({ deny: ctx.tools.getToolNames() })
            : runOptions?.allowedToolNames
                ? ctx.tools.filter({ allow: runOptions.allowedToolNames })
                : ctx.tools;
        if (runOptions?.additionalTools?.length) {
            if (runnerTools === ctx.tools) runnerTools = ctx.tools.filter();
            for (const tool of runOptions.additionalTools) runnerTools.register(tool);
        }
        const runner = runOptions?.llmOverride || hasOneShotToolPolicy
            ? createAgentLoopRunner({
                llm: runOptions.llmOverride || ctx.llm,
                tools: runnerTools,
                memoryManager: this.options.memoryManager,
                language: this.options.config.language,
            })
            : ctx.runner;

        const reportedToolCalls = new Set<string>();
        const inheritedExecutionContext = getAgentExecutionContext();
        const currentAttachmentPaths = (attachments || [])
            .map(attachment => attachment.path?.trim())
            .filter((path): path is string => !!path);
        const historicalAttachmentPaths = sessionId
            ? this.options.sessions.getMessages(sessionId)
                .flatMap(message => message.attachments || [])
                .map(attachment => attachment.path?.trim())
                .filter((path): path is string => !!path)
            : [];
        const userGrantedReadPaths = [...new Set([
            ...(inheritedExecutionContext?.userGrantedReadPaths || []),
            ...historicalAttachmentPaths,
            ...currentAttachmentPaths,
        ])];
        const isRunActive = (): boolean => runOptions?.isRunActive?.() !== false;
        const result = await runWithAgentExecutionContext({
            ...inheritedExecutionContext,
            sessionId,
            turnId: runOptions?.turnId,
            workspaceRoot: projectWorkspace || inheritedExecutionContext?.workspaceRoot,
            userGrantedReadPaths,
            abortSignal,
            drainSteering: runOptions?.drainSteering ?? inheritedExecutionContext?.drainSteering,
            onProgress,
            requestApproval: runOptions?.requestApproval ?? inheritedExecutionContext?.requestApproval,
            approvalMode: runOptions?.approvalMode ?? inheritedExecutionContext?.approvalMode,
        }, () => runner.run(
            enrichedInput,
            agentPrompt,
            {
                onIteration: (iteration: number) => {
                    if (!isRunActive()) return;
                    onProgress?.({
                        type: 'iteration',
                        iteration,
                        message: `迭代 ${iteration}`,
                    });
                },
                onToken: (token: string, metadata?: { provisional?: boolean }) => {
                    if (!isRunActive()) return;
                    onProgress?.({ type: 'token', token, provisional: metadata?.provisional });
                },
                onStreamReset: reason => {
                    if (!isRunActive()) return;
                    onProgress?.({ type: 'stream_reset', reason });
                },
                onToolStart: (description: string, rawToolCalls: unknown[], llmContent?: string) => {
                    if (!isRunActive()) return;
                    const toolCalls = (rawToolCalls as Array<{
                        id?: string;
                        name?: string;
                        arguments?: Record<string, unknown>;
                    }>)
                        .filter(call => typeof call?.id === 'string' && typeof call?.name === 'string')
                        .map(call => ({
                            id: call.id!,
                            name: call.name!,
                            title: describeToolAction(
                                call.name!,
                                redactSensitiveValue(call.arguments || {}) as Record<string, unknown>,
                                detectedInputLang,
                            ),
                        }));
                    if (toolCalls.length === 0) {
                        onProgress?.({ type: 'commentary', commentary: description });
                        return;
                    }

                    const fresh = toolCalls.filter(call => !reportedToolCalls.has(call.id));
                    if (fresh.length > 0) {
                        fresh.forEach(call => reportedToolCalls.add(call.id));
                        onProgress?.({ type: 'tool_start', description, llmDescription: llmContent, toolCalls: fresh });
                    }
                    for (const call of toolCalls) {
                        if (!fresh.some(item => item.id === call.id)) {
                            onProgress?.({ type: 'tool_progress', toolCallId: call.id, tool: call.name, description });
                        }
                    }
                },
                onToolCall: (toolCall: { id: string; name: string; arguments: Record<string, unknown> }, toolResult: unknown) => {
                    if (!isRunActive()) return;
                    const safeArgs = redactSensitiveValue(toolCall.arguments) as Record<string, unknown>;
                    const safeResult = redactSensitiveValue(toolResult);
                    const success = !(toolResult && typeof toolResult === 'object' && 'error' in toolResult);
                    onProgress?.({
                        type: 'tool_result',
                        tool: toolCall.name,
                        toolCallId: toolCall.id,
                        failed: !success,
                        description: describeToolCompletion(
                            toolCall.name,
                            safeArgs,
                            safeResult,
                            !success,
                            detectedInputLang,
                        ),
                        args: safeArgs,
                        result: safeResult,
                    });
                    if (sessionId) {
                        this.options.sessions.addLog(sessionId, {
                            tool: toolCall.name,
                            action: toolCall.arguments?.action as string | undefined,
                            args: safeArgs,
                            success,
                            turnId: runOptions?.turnId,
                            toolCallId: toolCall.id,
                        });
                    }
                },
            },
            history,
            contentParts,
            {
                globalAgentName: globalSettingsOverride?.globalAgentName || this.agentsConfig.globalAgentName,
                globalSystemPrompt: globalSettingsOverride?.globalSystemPrompt || this.agentsConfig.globalSystemPrompt,
                skills: this.agentsConfig.skills as any,
                sessionId,
                abortSignal,
                drainSteering: runOptions?.drainSteering ?? inheritedExecutionContext?.drainSteering,
                turnId: runOptions?.turnId,
                requestApproval: runOptions?.requestApproval ?? inheritedExecutionContext?.requestApproval,
                approvalMode: runOptions?.approvalMode ?? inheritedExecutionContext?.approvalMode,
            },
        ));

        if (!isRunActive()) {
            const retiredError = new Error('Execution was retired before its result could be committed');
            retiredError.name = 'AbortError';
            throw retiredError;
        }

        // 6. Save assistant responses
        if (sessionId && runOptions?.persistAssistantOutput !== false) {
            // Persist generated images as Markdown images (referencing the saved file path) so they
            // re-appear in the chat after reload. Use the file path (not base64) to avoid bloating
            // session storage and LLM history; the frontend resolves the path to a data URL on render.
            let assistantContent = runOptions?.visibleAssistantOutput
                ? runOptions.visibleAssistantOutput(result.output)
                : result.output;
            const contentForCheck = assistantContent || '';
            // True when the assistant already embedded this file as a Markdown image (avoid duplicates).
            const alreadyEmbedded = (filePath: string): boolean => {
                const base = filePath.split(/[\\/]/).pop() || filePath;
                const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                return new RegExp(`!\\[[^\\]]*\\]\\([^)]*${escaped}[^)]*\\)`).test(contentForCheck);
            };
            const generatedImagePaths: string[] = [];
            for (const tc of result.toolCalls as Array<{ name: string; result?: unknown }>) {
                if (tc.name !== 'generate_image') continue;
                const files = (tc.result as { data?: { files?: string[] } } | undefined)?.data?.files;
                if (Array.isArray(files)) {
                    for (const f of files) {
                        if (typeof f === 'string' && f && !generatedImagePaths.includes(f) && !alreadyEmbedded(f)) {
                            generatedImagePaths.push(f);
                        }
                    }
                }
            }
            if (generatedImagePaths.length > 0) {
                const imgMarkdown = generatedImagePaths
                    .map((p) => `![generated image](<${p.replace(/\\/g, '/')}>)`)
                    .join('\n\n');
                assistantContent = assistantContent?.trim()
                    ? `${assistantContent}\n\n${imgMarkdown}`
                    : imgMarkdown;
            }
            this.options.sessions.addMessage(sessionId, {
                role: 'assistant',
                content: assistantContent,
                metadata: {
                    ...(runOptions?.assistantMetadata || {}),
                    ...(runOptions?.turnId ? { turnId: runOptions.turnId } : {}),
                },
            });

            // Save a separate system note to record the summary of this tool call + key findings (without polluting the assistant output)
            if (result.toolCalls.length > 0) {
                const toolNames = result.toolCalls.map(tc => tc.name);
                const toolCounts: Record<string, number> = {};
                toolNames.forEach(n => { toolCounts[n] = (toolCounts[n] || 0) + 1; });
                const toolSummary = Object.entries(toolCounts)
                    .map(([name, count]) => count > 1 ? `${name}(×${count})` : name)
                    .join(', ');

                // Extract key data points (prices, URL, etc.) from assistant output into context
                const keyFacts: string[] = [];
                const priceMatches = result.output.match(/[¥￥$€]\.?\s*[\d,]+\.?\d*/g);
                if (priceMatches?.length) {
                    keyFacts.push(`Prices found: ${[...new Set(priceMatches)].slice(0, 10).join(', ')}`);
                }
                const urlMatches = result.output.match(/https?:\/\/[^\s)>\]]+/g);
                if (urlMatches?.length) {
                    keyFacts.push(`URLs: ${[...new Set(urlMatches)].slice(0, 5).join(', ')}`);
                }
                const factsSuffix = keyFacts.length > 0
                    ? `\nKey findings from this turn:\n${keyFacts.join('\n')}`
                    : '';

                this.options.sessions.addMessage(sessionId, {
                    role: 'system' as any,
                    content: `[Tool context] Previous response used ${result.toolCalls.length} tool calls: ${toolSummary}.${factsSuffix}\nDo not repeat these operations unless explicitly asked.`,
                });
            }
        }

        log.info('Task completed', {
            agentId: resolvedAgentId,
            iterations: result.iterations,
            toolCalls: result.toolCalls.length,
        });

        return {
            output: result.output,
            agentId: resolvedAgentId,
            routeResult,
        };
    }

    /**
     * Collaboration execution entry (called by CollaborationManager)
     * Simplified version of run(), no routing, directly executed with the specified Agent
     */
    async runForCollaboration(
        agentId: string,
        task: string,
        sessionId?: string,
    ): Promise<{ output: string; agentId: string }> {
        const ctx = this.getOrCreateContext(agentId);
        if (!ctx) {
            throw new Error(`Agent does not exist: ${agentId}`);
        }

        log.info(`Collaboration execution`, { agentId, task: task.slice(0, 100) });

        // Load history (if any)
        let history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
        if (sessionId) {
            const sessionMessages = this.options.sessions.getRecentMessages(sessionId, 20);
            history = sessionMessages.slice(-20).map(msg => ({
                role: msg.role as 'user' | 'assistant',
                content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
            }));
        }

        const agentPrompt = ctx.config.systemPrompt;
        const executionContext = getAgentExecutionContext();
        const onProgress = executionContext?.onProgress;
        const reportedToolCalls = new Set<string>();
        const taskLanguage = detectInputLanguage(task);

        const result = await ctx.runner.run(task, agentPrompt, {
            onIteration: (iteration: number) => {
                onProgress?.({
                    type: 'iteration',
                    iteration,
                    message: `[${agentId}] 迭代 ${iteration}`,
                });
            },
            onToolCall: (toolCall: { id: string; name: string; arguments: Record<string, unknown> }, toolResult: unknown) => {
                const success = !(toolResult && typeof toolResult === 'object' && 'error' in toolResult);
                const safeArgs = redactSensitiveValue(toolCall.arguments) as Record<string, unknown>;
                const safeResult = redactSensitiveValue(toolResult);
                onProgress?.({
                    type: 'tool_result',
                    tool: toolCall.name,
                    toolCallId: toolCall.id,
                    failed: !success,
                    description: describeToolCompletion(toolCall.name, safeArgs, safeResult, !success, taskLanguage),
                    args: safeArgs,
                    result: safeResult,
                });
            },
            onToolStart: (description: string, rawToolCalls: unknown[], llmContent?: string) => {
                const toolCalls = (rawToolCalls as Array<{
                    id?: string;
                    name?: string;
                    arguments?: Record<string, unknown>;
                }>)
                    .filter(call => typeof call?.id === 'string' && typeof call?.name === 'string')
                    .map(call => ({
                        id: call.id!,
                        name: call.name!,
                        title: describeToolAction(
                            call.name!,
                            redactSensitiveValue(call.arguments || {}) as Record<string, unknown>,
                            taskLanguage,
                        ),
                    }));
                if (toolCalls.length === 0) {
                    onProgress?.({ type: 'commentary', commentary: description });
                    return;
                }
                const fresh = toolCalls.filter(call => !reportedToolCalls.has(call.id));
                if (fresh.length > 0) {
                    fresh.forEach(call => reportedToolCalls.add(call.id));
                    onProgress?.({ type: 'tool_start', description, llmDescription: llmContent, toolCalls: fresh });
                }
                for (const call of toolCalls) {
                    if (!fresh.some(item => item.id === call.id)) {
                        onProgress?.({ type: 'tool_progress', toolCallId: call.id, tool: call.name, description });
                    }
                }
            },
        }, history, undefined, {
            globalAgentName: this.agentsConfig.globalAgentName,
            globalSystemPrompt: this.agentsConfig.globalSystemPrompt,
            skills: this.agentsConfig.skills as any,
            sessionId,
            turnId: executionContext?.turnId,
            abortSignal: executionContext?.abortSignal,
            requestApproval: executionContext?.requestApproval,
        });

        log.info('Collaboration execution completed', {
            agentId,
            iterations: result.iterations,
            toolCalls: result.toolCalls.length,
        });

        return {
            output: result.output,
            agentId,
        };
    }

    // ========================
    // internal method
    // ========================

    /**
     * Initialize collaboration manager
     */
    private initCollaboration(): void {
        // Inject executor (supports built-in and user agents)
        this.collaborationManager.setExecutor(
            (agentId, task, sessionId, agentType) => {
                if (agentType === 'user') {
                    return this.runForCollaborationUserAgent(agentId, task, sessionId);
                }
                return this.runForCollaboration(agentId, task, sessionId);
            }
        );

        // Inject Agent list query (fusion of built-in + user Agent)
        this.collaborationManager.setAgentProvider(() => {
            const builtinAgents: CollabAgentInfo[] = this.agentsConfig.list.map(a => ({
                id: a.id,
                name: a.name || a.id,
                type: 'builtin' as const,
                description: a.description,
            }));
            const userAgents: CollabAgentInfo[] = (this.options.getUserAgents?.() || []).map(ua => ({
                id: ua.id,
                name: ua.name,
                type: 'user' as const,
                description: ua.description,
            }));
            return [...builtinAgents, ...userAgents];
        });

        log.info('Collaboration manager initialized (builtin + user agents)');
    }

    /**
     * Register collaboration completion callback (called by standalone for WebSocket push)
     */
    setCollabOnComplete(fn: CollabSessionCompleteCallback): void {
        this.collaborationManager.setOnComplete(fn);
    }

    /**
     * Collaborative execution portal (user-defined Agent)
     * Use the default LLM + full tools to inject the systemPrompt of the user Agent
     */
    async runForCollaborationUserAgent(
        userAgentId: string,
        task: string,
        sessionId?: string,
    ): Promise<{ output: string; agentId: string }> {
        const userAgents = this.options.getUserAgents?.() || [];
        const ua = userAgents.find(a => a.id === userAgentId);
        if (!ua) {
            throw new Error(`User agent does not exist: ${userAgentId}`);
        }

        log.info(`Collaboration execution (user agent)`, { agentId: userAgentId, task: task.slice(0, 100) });

        // Get or create the default Agent context (reusing LLM and tools)
        const defaultAgent = this.getDefaultAgent();
        const ctx = this.getOrCreateContext(defaultAgent.id);
        if (!ctx) {
            throw new Error('Cannot create execution context for user agent collaboration');
        }

        // Load history
        let history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
        if (sessionId) {
            const sessionMessages = this.options.sessions.getRecentMessages(sessionId, 20);
            history = sessionMessages.slice(-20).map(msg => ({
                role: msg.role as 'user' | 'assistant',
                content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
            }));
        }

        const executionContext = getAgentExecutionContext();
        const onProgress = executionContext?.onProgress;
        const reportedToolCalls = new Set<string>();
        const taskLanguage = detectInputLanguage(task);

        const result = await ctx.runner.run(task, ua.systemPrompt || '', {
            onIteration: (iteration: number) => {
                onProgress?.({
                    type: 'iteration',
                    iteration,
                    message: `[${ua.name || userAgentId}] iteration ${iteration}`,
                });
            },
            onToolCall: (toolCall: { id: string; name: string; arguments: Record<string, unknown> }, toolResult: unknown) => {
                const success = !(toolResult && typeof toolResult === 'object' && 'error' in toolResult);
                const safeArgs = redactSensitiveValue(toolCall.arguments) as Record<string, unknown>;
                const safeResult = redactSensitiveValue(toolResult);
                onProgress?.({
                    type: 'tool_result',
                    tool: toolCall.name,
                    toolCallId: toolCall.id,
                    failed: !success,
                    description: describeToolCompletion(toolCall.name, safeArgs, safeResult, !success, taskLanguage),
                    args: safeArgs,
                    result: safeResult,
                });
            },
            onToolStart: (description: string, rawToolCalls: unknown[], llmContent?: string) => {
                const toolCalls = (rawToolCalls as Array<{
                    id?: string;
                    name?: string;
                    arguments?: Record<string, unknown>;
                }>)
                    .filter(call => typeof call?.id === 'string' && typeof call?.name === 'string')
                    .map(call => ({
                        id: call.id!,
                        name: call.name!,
                        title: describeToolAction(
                            call.name!,
                            redactSensitiveValue(call.arguments || {}) as Record<string, unknown>,
                            taskLanguage,
                        ),
                    }));
                if (toolCalls.length === 0) {
                    onProgress?.({ type: 'commentary', commentary: description });
                    return;
                }
                const fresh = toolCalls.filter(call => !reportedToolCalls.has(call.id));
                if (fresh.length > 0) {
                    fresh.forEach(call => reportedToolCalls.add(call.id));
                    onProgress?.({ type: 'tool_start', description, llmDescription: llmContent, toolCalls: fresh });
                }
                for (const call of toolCalls) {
                    if (!fresh.some(item => item.id === call.id)) {
                        onProgress?.({ type: 'tool_progress', toolCallId: call.id, tool: call.name, description });
                    }
                }
            },
        }, history, undefined, {
            globalAgentName: ua.name || userAgentId,
            globalSystemPrompt: ua.systemPrompt || '',
            skills: this.agentsConfig.skills as any,
            sessionId,
            turnId: executionContext?.turnId,
            abortSignal: executionContext?.abortSignal,
            requestApproval: executionContext?.requestApproval,
        });

        log.info('Collaboration execution (user agent) completed', {
            agentId: userAgentId,
            iterations: result.iterations,
            toolCalls: result.toolCalls.length,
        });

        return {
            output: result.output,
            agentId: userAgentId,
        };
    }

    /**
     * Get or create Agent context (with cache)
     */
    private getOrCreateContext(agentId: string): AgentContext | null {
        // cache hit
        if (this.contextCache.has(agentId)) {
            return this.contextCache.get(agentId)!;
        }

        const agentConfig = this.getAgent(agentId);
        if (!agentConfig) {
            return null;
        }

        // Parse LLM
        const llm = this.resolveAgentLLM(agentConfig);

        // Parsing tools (3-layer filtering)
        const mergedToolsConfig = this.mergeToolsConfig(agentConfig);
        const tools = this.options.tools.filter(mergedToolsConfig);

        // Create SubAgent executor (with tool restrictions)
        const subAgentToolsConfig = this.resolveSubAgentConfig(agentConfig);
        const subAgentTools = this.options.tools.filter(
            mergedToolsConfig,
            true, // isSubAgent
            subAgentToolsConfig?.tools
        );

        const subAgentExecutor = createSubAgentExecutor({
            llm: subAgentToolsConfig?.model
                ? createLLMProvider({
                    provider: subAgentToolsConfig.model.provider,
                    model: subAgentToolsConfig.model.model,
                    apiKey: subAgentToolsConfig.model.apiKey || this.resolveApiKey(subAgentToolsConfig.model.provider),
                    baseUrl: subAgentToolsConfig.model.baseUrl,
                })
                : llm,
            tools: subAgentTools,
            onComplete: (result) => {
                log.info(`SubAgent completed: ${result.id}`, { status: result.status });
            },
            onProgress: (event) => {
                // Forward SubAgent progress to the main session
                const progress = event as AgentProgressEvent & { subAgentId?: string };
                getAgentExecutionContext()?.onProgress?.({
                    ...progress,
                    sourceId: progress.sourceId || progress.subAgentId,
                    sourceAgentId: progress.sourceAgentId || progress.subAgentId,
                });
            },
        });

        // Register the spawn tool (if there is spawn in the filtered tool list, it needs to be replaced)
        const spawnTool = createSpawnTool({
            defaultTimeout: subAgentToolsConfig?.defaultTimeout || 300,
            maxConcurrent: subAgentToolsConfig?.maxConcurrent || 5,
            onExecute: subAgentExecutor,
            getParentAbortSignal: () => getAgentExecutionContext()?.abortSignal,
        });

        // If spawn already exists in tools, replace it with the restricted version
        if (tools.getTool('spawn')) {
            tools.register(spawnTool);
        }

        // Register collaboration tools (sessions_spawn + sessions_send)
        const sessionsSpawnTool = createSessionsSpawnTool({
            collaborationManager: this.collaborationManager,
            defaultTimeout: subAgentToolsConfig?.defaultTimeout || 300,
        });
        const sessionsSendTool = createSessionsSendTool({
            collaborationManager: this.collaborationManager,
        });
        tools.register(sessionsSpawnTool);
        tools.register(sessionsSendTool);

        // Sign up for the historical conversation search tool
        const sessionsSearchTool = createSessionsSearchTool({
            sessions: this.options.sessions,
        });
        tools.register(sessionsSearchTool);

        // Create Runner
        const runner = createAgentLoopRunner({ llm, tools, memoryManager: this.options.memoryManager, language: this.options.config.language });

        const ctx: AgentContext = { config: agentConfig, llm, tools, runner };
        this.contextCache.set(agentId, ctx);

        log.info(`Agent context created: ${agentId}`, {
            model: llm?.getConfig()?.model ?? 'unknown',
            tools: tools.getToolNames(),
        });

        return ctx;
    }

    /**
     * Parse LLM used by Agent
     * Priority: Agent.model > Global orchestration
     */
    private resolveAgentLLM(agent: AgentConfig): LLMProvider {
        if (agent.model) {
            return createLLMProvider({
                provider: agent.model.provider,
                model: agent.model.model,
                apiKey: agent.model.apiKey || this.resolveApiKey(agent.model.provider),
                baseUrl: agent.model.baseUrl,
                temperature: agent.model.temperature,
                maxTokens: agent.model.maxTokens,
            });
        }
        if (!this.options.defaultLLM) {
            throw new Error('LLM not configured. Please set up your API Key in Settings > Server.');
        }
        return this.options.defaultLLM;
    }

    /**
     * Merge tool configuration: defaults + agent level
     */
    private mergeToolsConfig(agent: AgentConfig): AgentToolsConfig | undefined {
        const defaults = this.agentsConfig.defaults?.tools;
        const agentTools = agent.tools;

        if (!defaults && !agentTools) return undefined;
        if (!defaults) return agentTools as AgentToolsConfig | undefined;
        if (!agentTools) return defaults as AgentToolsConfig;

        // Agent level override defaults
        return {
            profile: agentTools.profile ?? defaults.profile,
            allow: agentTools.allow ?? defaults.allow,
            deny: agentTools.deny ?? defaults.deny,
            alsoAllow: agentTools.alsoAllow ?? defaults.alsoAllow,
        } as AgentToolsConfig;
    }

    /**
     * Parse SubAgent configuration
     */
    private resolveSubAgentConfig(agent: AgentConfig) {
        const defaults = this.agentsConfig.defaults?.subagents;
        const agentSub = agent.subagents;

        if (!defaults && !agentSub) return undefined;
        if (!defaults) return agentSub;
        if (!agentSub) return defaults;

        return {
            maxConcurrent: agentSub.maxConcurrent ?? defaults.maxConcurrent,
            defaultTimeout: agentSub.defaultTimeout ?? defaults.defaultTimeout,
            model: agentSub.model ?? defaults.model,
            tools: agentSub.tools ?? defaults.tools,
        };
    }

    /**
     * Resolve API Key from global providers configuration
     */
    private resolveApiKey(provider: string): string {
        const providerConfig = this.options.config.providers?.[provider];
        if (providerConfig?.apiKey) return providerConfig.apiKey;

        // Fallback to environment variables
        const envMap: Record<string, string> = {
            anthropic: 'ANTHROPIC_API_KEY',
            openai: 'OPENAI_API_KEY',
            deepseek: 'DEEPSEEK_API_KEY',
            zhipu: 'ZHIPU_API_KEY',
            moonshot: 'MOONSHOT_API_KEY',
        };
        const envKey = envMap[provider];
        return envKey ? (process.env[envKey] || '') : '';
    }
}
