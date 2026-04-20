/**
 * Agent Manager - 多 Agent 管理器
 * 管理 Agent 配置、工具过滤、路由分派、执行入口
 */

import type { OpenFluxConfig, AgentConfig, AgentsConfig } from '../config/schema';
import { buildAgentMainKey, normalizeAgentId, DEFAULT_AGENT_ID } from '../utils/session-key';
import type { LLMProvider } from '../llm/provider';
import type { ToolRegistry } from '../tools/registry';
import type { AgentToolsConfig } from '../tools/policy';
import { createLLMProvider } from '../llm/factory';
import { createAgentLoopRunner } from './loop';
import { routeToAgent, type RouteResult } from './router';
import { createSubAgentExecutor } from './subagent';
import { createSpawnTool } from '../tools/spawn';
import { createSessionsSpawnTool } from '../tools/sessions-spawn';
import { createSessionsSendTool } from '../tools/sessions-send';
import { CollaborationManager, getCollaborationManager, type CollabAgentInfo, type CollabSessionCompleteCallback } from './collaboration';
import { SessionStore } from '../sessions';
import type { AgentProgressEvent } from '../gateway';
import type { MemoryManager } from './memory/manager';
import { buildEnrichedInput, type ChatAttachment, type ImageAttachmentData } from '../utils/file-reader';
import type { LLMContentPart } from '../llm/provider';
import { Logger } from '../utils/logger';

const log = new Logger('AgentManager');

// ========================
// 类型定义
// ========================

/** AgentManager 初始化参数 */
export interface AgentManagerOptions {
    /** 全局配置 */
    config: OpenFluxConfig;
    /** 全量工具注册表（未过滤） */
    tools: ToolRegistry;
    /** 默认 LLM Provider（orchestration） */
    defaultLLM: LLMProvider;
    /** 会话存储 */
    sessions: SessionStore;
    /** 记忆管理器 */
    memoryManager?: MemoryManager;
    /** 文件输出路径（动态获取，注入到系统提示中） */
    getOutputPath?: () => string;
    /** 用户 Agent 存储（用于协作融合） */
    getUserAgents?: () => Array<{ id: string; name: string; description?: string; systemPrompt?: string }>;
}

/** Agent 运行时上下文（内部缓存） */
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
    private collaborationManager: CollaborationManager;
    private routerLLM: LLMProvider;
    /** 当前主会话的进度回调（用于子Agent进度转发） */
    private currentOnProgress: ((event: AgentProgressEvent) => void) | null = null;
    /** 当前主会话的 AbortSignal（用于级联停止 SubAgent） */
    private currentAbortSignal: AbortSignal | undefined = undefined;

    constructor(options: AgentManagerOptions) {
        this.options = options;

        // 如果没有 agents 配置，构造单 Agent 兼容模式
        this.agentsConfig = options.config.agents || {
            list: [{
                id: 'default',
                default: true,
                name: '通用助手',
            }],
        };

        // 路由器 LLM
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

        // 初始化协作管理器
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
    // 技能运行时注入
    // ========================

    /**
     * 运行时注入技能（安装后立即可用，无需重启）
     */
    addSkill(skill: { id: string; title: string; content: string }): void {
        if (!this.agentsConfig.skills) {
            this.agentsConfig.skills = [];
        }
        // 相同 id 则替换
        const idx = this.agentsConfig.skills.findIndex(s => s.id === skill.id);
        if (idx >= 0) {
            this.agentsConfig.skills[idx] = { ...skill, enabled: true };
        } else {
            this.agentsConfig.skills.push({ ...skill, enabled: true });
        }
        log.info(`Skill injected: ${skill.id} (${skill.title})`);
    }

    /**
     * 运行时移除技能
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
    // 公开方法
    // ========================

    /**
     * 获取所有 Agent 配置
     */
    getAgents(): AgentConfig[] {
        return this.agentsConfig.list;
    }

    /**
     * 获取 Agent 列表（含 sessionKey，供前端使用）
     */
    getAgentList(): Array<AgentConfig & { sessionKey: string }> {
        return this.agentsConfig.list.map(a => ({
            ...a,
            sessionKey: buildAgentMainKey(a.id),
        }));
    }

    /**
     * 获取 Agent 绑定的主会话 Key
     */
    getAgentSessionKey(agentId: string): string {
        return buildAgentMainKey(agentId);
    }

    /**
     * 获取指定 Agent 配置
     */
    getAgent(agentId: string): AgentConfig | undefined {
        return this.agentsConfig.list.find(a => a.id === agentId);
    }

    /**
     * 获取默认 Agent
     */
    getDefaultAgent(): AgentConfig {
        return this.agentsConfig.list.find(a => a.default) || this.agentsConfig.list[0];
    }

    /**
     * 获取所有 Agent ID 列表
     */
    getAgentIds(): string[] {
        return this.agentsConfig.list.map(a => a.id);
    }

    /**
     * 获取协作管理器
     */
    getCollaborationManager(): CollaborationManager {
        return this.collaborationManager;
    }

    /**
     * 是否启用路由
     */
    isRouterEnabled(): boolean {
        return this.agentsConfig.router?.enabled !== false && this.agentsConfig.list.length > 1;
    }

    // ========================
    // 动态 Agent 管理（CRUD）
    // ========================

    /**
     * 动态创建 Agent
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

        // 如果是第一个 Agent 且没有 default 标记，设为 default
        if (this.agentsConfig.list.length === 0 || (!this.agentsConfig.list.some(a => a.default) && !config.default)) {
            config.default = true;
        }

        this.agentsConfig.list.push(config);
        log.info(`Agent created: ${id}`, { name: config.name });
        return config;
    }

    /**
     * 动态更新 Agent 配置
     */
    updateAgent(agentId: string, updates: Partial<AgentConfig>): AgentConfig {
        const idx = this.agentsConfig.list.findIndex(a => a.id === agentId);
        if (idx === -1) {
            throw new Error(`Agent not found: ${agentId}`);
        }

        // 合并更新（不允许修改 id）
        const current = this.agentsConfig.list[idx];
        const updated: AgentConfig = {
            ...current,
            ...updates,
            id: current.id, // id 不可变
        };

        this.agentsConfig.list[idx] = updated;

        // 清除缓存，下次执行时重建
        this.contextCache.delete(agentId);

        log.info(`Agent updated: ${agentId}`, { name: updated.name });
        return updated;
    }

    /**
     * 动态删除 Agent
     */
    deleteAgent(agentId: string): boolean {
        const idx = this.agentsConfig.list.findIndex(a => a.id === agentId);
        if (idx === -1) return false;

        const wasDefault = this.agentsConfig.list[idx].default;
        this.agentsConfig.list.splice(idx, 1);
        this.contextCache.delete(agentId);

        // 如果删除的是默认 Agent，将第一个设为默认
        if (wasDefault && this.agentsConfig.list.length > 0) {
            this.agentsConfig.list[0].default = true;
        }

        log.info(`Agent deleted: ${agentId}`);
        return true;
    }

    /**
     * 获取 agents 配置（用于持久化到 openflux.yaml）
     */
    getAgentsConfig(): AgentsConfig {
        return this.agentsConfig;
    }

    /**
     * 热更新 LLM Provider（配置变更后调用）
     * 清除所有 Agent 上下文缓存，下次执行时重建
     */
    updateLLM(orchestrationLLM: LLMProvider, _executionLLM?: LLMProvider): void {
        this.options.defaultLLM = orchestrationLLM;
        this.routerLLM = orchestrationLLM;
        this.contextCache.clear();
        log.info('LLM Provider hot-updated, Agent context cache cleared');
    }

    /**
     * 热更新全局 Agent 设置（名称、系统提示）
     * 在初始化向导完成或设置面板修改后调用
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
     * 自动路由：分析用户意图，选择 Agent
     */
    async resolve(input: string): Promise<RouteResult> {
        if (!this.isRouterEnabled()) {
            const defaultAgent = this.getDefaultAgent();
            return {
                agentId: defaultAgent.id,
                reason: '路由未启用或仅一个 Agent',
                usedLLM: false,
            };
        }

        return routeToAgent(input, this.agentsConfig.list, this.routerLLM);
    }

    /**
     * 核心执行入口
     *
     * @param input 用户输入
     * @param agentId Agent ID（不传则自动路由）
     * @param sessionId 会话 ID
     * @param onProgress 进度回调
     * @param attachments 用户拖拽的文件附件
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
    ): Promise<{ output: string; agentId: string; routeResult?: RouteResult }> {
        // 1. 确定 Agent
        let resolvedAgentId: string;
        let routeResult: RouteResult | undefined;

        if (agentId) {
            // 显式指定
            resolvedAgentId = agentId;
        } else {
            // 自动路由
            routeResult = await this.resolve(input);
            resolvedAgentId = routeResult.agentId;

            // 推送路由事件
            if (routeResult.usedLLM) {
                onProgress?.({
                    type: 'thinking',
                    thinking: `${routeResult.reason}`,
                });
            }
        }

        // 2. 获取 Agent 上下文
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

        // 3. 加载会话历史（协作消息隔离 + token 级截断）
        let history: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [];
        let collabSummaryForPrompt = '';
        const MAX_HISTORY_TOKENS = 8000;
        const MIN_HISTORY_MESSAGES = 3;

        if (sessionId) {
            const sessionMessages = this.options.sessions.getMessages(sessionId);
            const allMapped = sessionMessages
                .map(msg => ({
                    role: msg.role as 'user' | 'assistant' | 'system',
                    content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
                }))
                .filter(msg => msg.content && msg.content.trim().length > 0);

            // 分离协作消息和用户对话（system tool-context 消息归入用户对话流）
            const userMessages = allMapped.filter(m => !m.content.startsWith('[Collaboration'));
            const collabMessages = allMapped.filter(m => m.content.startsWith('[Collaboration'));

            // Token-aware 截断用户对话（P2）
            let tokenCount = 0;
            const selected: typeof userMessages = [];
            for (let i = userMessages.length - 1; i >= 0; i--) {
                // 简单估算 token 数：中文 ~1.5 token/字，英文 ~0.75 token/word
                const msgTokens = Math.ceil(userMessages[i].content.length * 0.8);
                if (selected.length >= MIN_HISTORY_MESSAGES && tokenCount + msgTokens > MAX_HISTORY_TOKENS) break;
                selected.unshift(userMessages[i]);
                tokenCount += msgTokens;
            }
            history = selected;

            // 压缩协作消息为摘要（最多保留最近 10 条，每条截断）
            if (collabMessages.length > 0) {
                const recentCollab = collabMessages.slice(-10);
                collabSummaryForPrompt = '\n\n## Recent Collaboration Results\n';
                for (const cm of recentCollab) {
                    // 提取关键信息（去掉 [Collaboration Announce] 前缀）
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

            // P1: 自动沉淀被丢弃的对话为 Micro 卡片（异步，不阻塞主流程）
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

        // 4. 保存用户消息（含附件元数据，以便切换会话后恢复显示）
        if (sessionId) {
            // 如果用户没有输入文字但上传了附件，用附件文件名作为消息内容
            let saveContent = input;
            if (!saveContent?.trim() && attachments?.length) {
                saveContent = `[上传文件: ${attachments.map(a => a.name).join(', ')}]`;
            }
            this.options.sessions.addMessage(sessionId, {
                role: 'user',
                content: saveContent || input,
                attachments: attachments?.length
                    ? attachments.map(a => ({ path: a.path, name: a.name, ext: a.ext, size: a.size }))
                    : undefined,
                metadata: userMetadata,
            });
        }

        // 5. 构建系统提示（注入输出路径 + 当前时间）
        // 注意：agentPrompt 可能为 undefined，此时 loop.ts 会使用 DEFAULT_SYSTEM_PROMPT
        // outputPathInfo 和 timeInfo 是追加信息，不应导致跳过默认 prompt
        let agentPrompt = ctx.config.systemPrompt;

        let promptSuffix = '';

        const outputPath = this.options.getOutputPath?.();
        if (outputPath) {
            const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
            promptSuffix += `\n\n## 文件输出规则（必须严格遵守）\n基础输出目录：${outputPath}\n\n### 1. 任务目录归档\n当任务需要产生文件输出时，必须按以下结构创建独立目录：\n\`${outputPath}/${todayStr}/<任务描述>/\`\n\n规则：\n- 日期目录格式：YYYY-MM-DD（今天是 ${todayStr}）\n- 任务描述：用简短中文概括任务内容（如"销售数据分析"、"产品方案策划"、"数据处理脚本"、"技术报告"、"市场调研汇总"、"图片生成"、"网页爬取"、"翻译文档"）。不同任务根据具体内容命名，最多8个字\n- 目录名必须唯一：先用 filesystem.list 检查同日期目录下是否有同名目录，若存在则加数字后缀（如"销售数据分析_2"）\n- 该任务产生的所有文件都放在此任务目录内\n- filesystem.write 使用相对路径时会自动解析到基础输出目录，所以你需要写完整子路径如 \`${todayStr}/任务描述/文件名\`\n\n### 2. 非编码任务的中间代码清理\n判断：如果用户的核心目标不是获得代码（如"分析数据"、"写报告"、"搜索整理信息"、"生成图表"、"制作文档"、"数据转换"），则属于非编码任务。\n- 非编码任务中创建的辅助脚本（.py .js .ts .sh .bat 等），在最终产出物生成后，用 filesystem.delete 删除这些中间代码文件\n- 只删除当前任务输出目录内的文件，绝不触碰其他目录的任何内容\n- 保留最终产出物（文档、图片、数据文件等）\n- 如果用户明确要求保留代码则不删除\n\n### 3. 禁止事项\n- 不要将文件保存到桌面、C:\\\\temp 等位置\n- process 工具的 cwd 应设为当前任务输出目录`;
        }

        // 注入当前系统时间（必须放在靠前位置，确保 LLM 正确理解"今天"）
        const now = new Date();
        const dateStr = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        promptSuffix += `\n\n## 当前时间（重要）\n现在是 ${dateStr}（${now.toISOString()}）。\n- 当用户提到"今天""最新""当前"等时间词时，必须基于上述时间\n- 搜索新闻、资讯时，搜索词中必须包含正确的年月日\n- 生成文件名时使用正确的日期`;

        // 注入协作 Agent 列表（如果有多个 Agent 可用）
        const collabAgents = this.collaborationManager.getAgentInfos();
        // 排除当前 Agent 自身
        const peerAgents = collabAgents.filter(a => a.id !== resolvedAgentId);
        if (peerAgents.length > 0) {
            promptSuffix += `\n\n## Multi-Agent Collaboration (${peerAgents.length} agents available)`;
            promptSuffix += '\nYou have access to other specialized agents. Use the sessions_spawn tool internally to delegate tasks to them.';

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

        // 注入协作消息摘要（隔离计数，不占对话窗口）
        if (collabSummaryForPrompt) {
            promptSuffix += collabSummaryForPrompt;
        }

        // 注入最近任务上下文（帮助 LLM 聚焦到最后一个任务，避免被旧话题干扰）
        if (history.length >= 2) {
            // 找到最后一对 user→assistant 交互
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

        // 只有当有追加内容时才拼接，保持 undefined 的语义不变
        if (promptSuffix) {
            agentPrompt = (agentPrompt || '') + promptSuffix;
        }

        // 5.5 附件预处理：提取文件内容并注入 input；图片转为多模态 contentParts
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

            // 如果有图片，构建多模态 contentParts
            if (enriched.images.length > 0) {
                contentParts = [];
                // 先放图片
                for (const img of enriched.images) {
                    contentParts.push({
                        type: 'image',
                        mimeType: img.mimeType,
                        data: img.base64,
                    });
                }
                // 再放文本
                contentParts.push({
                    type: 'text',
                    text: enrichedInput,
                });
                log.info('Building multimodal message', { imageCount: enriched.images.length });
            }

            log.info('Attachment preprocessing done', { enrichedLength: enrichedInput.length, hasImages: !!contentParts });
        }

        // 6. 运行 Agent Loop
        // 存储 onProgress + abortSignal 供子 Agent 协作转发
        this.currentOnProgress = onProgress || null;
        this.currentAbortSignal = abortSignal;
        const result = await ctx.runner.run(
            enrichedInput,
            agentPrompt,
            {
                onIteration: (iteration: number) => {
                    onProgress?.({
                        type: 'iteration',
                        iteration,
                        message: `迭代 ${iteration}`,
                    });
                },
                onToken: (token: string) => {
                    onProgress?.({ type: 'token', token });
                },
                onThinking: (thinking: string) => {
                    onProgress?.({ type: 'thinking', thinking });
                    if (sessionId) {
                        this.options.sessions.addLog(sessionId, {
                            tool: '_thinking',
                            args: { content: thinking },
                            success: true,
                        });
                    }
                },
                onToolStart: (description: string, _toolCalls: unknown[], llmContent?: string) => {
                    onProgress?.({ type: 'tool_start', description, llmDescription: llmContent });
                },
                onToolCall: (toolCall: { id: string; name: string; arguments: Record<string, unknown> }, toolResult: unknown) => {
                    onProgress?.({
                        type: 'tool_result',
                        tool: toolCall.name,
                        args: toolCall.arguments,
                        result: toolResult,
                    });
                    if (sessionId) {
                        const success = !(toolResult && typeof toolResult === 'object' && 'error' in toolResult);
                        this.options.sessions.addLog(sessionId, {
                            tool: toolCall.name,
                            action: toolCall.arguments?.action as string | undefined,
                            args: toolCall.arguments,
                            success,
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
            },
        );

        // 清理进度回调和 abort 信号引用
        this.currentOnProgress = null;
        this.currentAbortSignal = undefined;

        // 6. 保存助手回复
        if (sessionId) {
            this.options.sessions.addMessage(sessionId, { role: 'assistant', content: result.output });

            // 单独存一条 system 备注，记录本次工具调用摘要（不污染 assistant 输出）
            if (result.toolCalls.length > 0) {
                const toolNames = result.toolCalls.map(tc => tc.name);
                const toolCounts: Record<string, number> = {};
                toolNames.forEach(n => { toolCounts[n] = (toolCounts[n] || 0) + 1; });
                const toolSummary = Object.entries(toolCounts)
                    .map(([name, count]) => count > 1 ? `${name}(×${count})` : name)
                    .join(', ');
                this.options.sessions.addMessage(sessionId, {
                    role: 'system' as any,
                    content: `[Tool context] Previous response used ${result.toolCalls.length} tool calls: ${toolSummary}. Do not repeat these operations unless explicitly asked.`,
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
     * 协作执行入口（供 CollaborationManager 调用）
     * 简化版 run()，不走路由，直接用指定 Agent 执行
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

        // 加载历史（如有）
        let history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
        if (sessionId) {
            const sessionMessages = this.options.sessions.getMessages(sessionId);
            history = sessionMessages.slice(-20).map(msg => ({
                role: msg.role as 'user' | 'assistant',
                content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
            }));
        }

        const agentPrompt = ctx.config.systemPrompt;
        const onProgress = this.currentOnProgress;

        const result = await ctx.runner.run(task, agentPrompt, {
            onIteration: (iteration: number) => {
                onProgress?.({
                    type: 'iteration',
                    iteration,
                    message: `[${agentId}] 迭代 ${iteration}`,
                });
            },
            onToolCall: (toolCall: { id: string; name: string; arguments: Record<string, unknown> }, toolResult: unknown) => {
                onProgress?.({
                    type: 'tool_result',
                    tool: toolCall.name,
                    args: toolCall.arguments,
                    result: toolResult,
                });
            },
            onToolStart: (description: string, _toolCalls: unknown[], llmContent?: string) => {
                onProgress?.({ type: 'tool_start', description, llmDescription: llmContent });
            },
        }, history, undefined, {
            globalAgentName: this.agentsConfig.globalAgentName,
            globalSystemPrompt: this.agentsConfig.globalSystemPrompt,
            skills: this.agentsConfig.skills as any,
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
    // 内部方法
    // ========================

    /**
     * 初始化协作管理器
     */
    private initCollaboration(): void {
        // 注入执行器（支持内置和用户 Agent）
        this.collaborationManager.setExecutor(
            (agentId, task, sessionId, agentType) => {
                if (agentType === 'user') {
                    return this.runForCollaborationUserAgent(agentId, task, sessionId);
                }
                return this.runForCollaboration(agentId, task, sessionId);
            }
        );

        // 注入 Agent 列表查询（融合内置 + 用户 Agent）
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
     * 注册协作完成回调（由 standalone 调用，用于 WebSocket 推送）
     */
    setCollabOnComplete(fn: CollabSessionCompleteCallback): void {
        this.collaborationManager.setOnComplete(fn);
    }

    /**
     * 协作执行入口（用户自定义 Agent）
     * 使用默认 LLM + 全量工具，注入用户 Agent 的 systemPrompt
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

        // 获取或创建默认 Agent 上下文（复用 LLM 和工具）
        const defaultAgent = this.getDefaultAgent();
        const ctx = this.getOrCreateContext(defaultAgent.id);
        if (!ctx) {
            throw new Error('Cannot create execution context for user agent collaboration');
        }

        // 加载历史
        let history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
        if (sessionId) {
            const sessionMessages = this.options.sessions.getMessages(sessionId);
            history = sessionMessages.slice(-20).map(msg => ({
                role: msg.role as 'user' | 'assistant',
                content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
            }));
        }

        const onProgress = this.currentOnProgress;

        const result = await ctx.runner.run(task, ua.systemPrompt || '', {
            onIteration: (iteration: number) => {
                onProgress?.({
                    type: 'iteration',
                    iteration,
                    message: `[${ua.name || userAgentId}] iteration ${iteration}`,
                });
            },
            onToolCall: (toolCall: { id: string; name: string; arguments: Record<string, unknown> }, toolResult: unknown) => {
                onProgress?.({
                    type: 'tool_result',
                    tool: toolCall.name,
                    args: toolCall.arguments,
                    result: toolResult,
                });
            },
            onToolStart: (description: string, _toolCalls: unknown[], llmContent?: string) => {
                onProgress?.({ type: 'tool_start', description, llmDescription: llmContent });
            },
        }, history, undefined, {
            globalAgentName: ua.name || userAgentId,
            globalSystemPrompt: ua.systemPrompt || '',
            skills: this.agentsConfig.skills as any,
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
     * 获取或创建 Agent 上下文（带缓存）
     */
    private getOrCreateContext(agentId: string): AgentContext | null {
        // 缓存命中
        if (this.contextCache.has(agentId)) {
            return this.contextCache.get(agentId)!;
        }

        const agentConfig = this.getAgent(agentId);
        if (!agentConfig) {
            return null;
        }

        // 解析 LLM
        const llm = this.resolveAgentLLM(agentConfig);

        // 解析工具（3 层过滤）
        const mergedToolsConfig = this.mergeToolsConfig(agentConfig);
        const tools = this.options.tools.filter(mergedToolsConfig);

        // 创建 SubAgent 执行器（带工具限制）
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
                // 转发 SubAgent 进度到主会话
                this.currentOnProgress?.(event as AgentProgressEvent);
            },
        });

        // 注册 spawn 工具（如果过滤后的工具列表中有 spawn 的话需要替换）
        const spawnTool = createSpawnTool({
            defaultTimeout: subAgentToolsConfig?.defaultTimeout || 300,
            maxConcurrent: subAgentToolsConfig?.maxConcurrent || 5,
            onExecute: subAgentExecutor,
            getParentAbortSignal: () => this.currentAbortSignal,
        });

        // 如果 tools 中已有 spawn，替换为带限制的版本
        if (tools.getTool('spawn')) {
            tools.register(spawnTool);
        }

        // 注册协作工具（sessions_spawn + sessions_send）
        const sessionsSpawnTool = createSessionsSpawnTool({
            collaborationManager: this.collaborationManager,
            defaultTimeout: subAgentToolsConfig?.defaultTimeout || 300,
        });
        const sessionsSendTool = createSessionsSendTool({
            collaborationManager: this.collaborationManager,
        });
        tools.register(sessionsSpawnTool);
        tools.register(sessionsSendTool);

        // 创建 Runner
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
     * 解析 Agent 使用的 LLM
     * 优先级：Agent.model > 全局 orchestration
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
     * 合并工具配置：defaults + agent 级
     */
    private mergeToolsConfig(agent: AgentConfig): AgentToolsConfig | undefined {
        const defaults = this.agentsConfig.defaults?.tools;
        const agentTools = agent.tools;

        if (!defaults && !agentTools) return undefined;
        if (!defaults) return agentTools as AgentToolsConfig | undefined;
        if (!agentTools) return defaults as AgentToolsConfig;

        // Agent 级覆盖 defaults
        return {
            profile: agentTools.profile ?? defaults.profile,
            allow: agentTools.allow ?? defaults.allow,
            deny: agentTools.deny ?? defaults.deny,
            alsoAllow: agentTools.alsoAllow ?? defaults.alsoAllow,
        } as AgentToolsConfig;
    }

    /**
     * 解析 SubAgent 配置
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
     * 从全局 providers 配置中解析 API Key
     */
    private resolveApiKey(provider: string): string {
        const providerConfig = this.options.config.providers?.[provider];
        if (providerConfig?.apiKey) return providerConfig.apiKey;

        // 回退到环境变量
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
