/**
 * Agent Manager - 多 Agent 管理器
 * 管理 Agent 配置、工具过滤、路由分派、执行入口
 */

import type { OpenFluxConfig, AgentConfig, AgentsConfig } from '../config/schema';
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
import { CollaborationManager, getCollaborationManager } from './collaboration';
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

        log.info(`AgentManager 初始化: ${this.agentsConfig.list.length} 个 Agent`);
        for (const agent of this.agentsConfig.list) {
            log.info(`  - ${agent.id}: ${agent.name || '(unnamed)'}` +
                (agent.default ? ' [default]' : '') +
                (agent.tools?.profile ? ` [profile: ${agent.tools.profile}]` : ''));
        }
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

    /**
     * 热更新 LLM Provider（配置变更后调用）
     * 清除所有 Agent 上下文缓存，下次执行时重建
     */
    updateLLM(orchestrationLLM: LLMProvider, _executionLLM?: LLMProvider): void {
        this.options.defaultLLM = orchestrationLLM;
        this.routerLLM = orchestrationLLM;
        this.contextCache.clear();
        log.info('LLM Provider 已热更新，Agent 上下文缓存已清除');
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
                    thinking: `路由到 Agent "${resolvedAgentId}": ${routeResult.reason}`,
                });
            }
        }

        // 2. 获取 Agent 上下文
        const ctx = this.getOrCreateContext(resolvedAgentId);
        if (!ctx) {
            throw new Error(`Agent 不存在: ${resolvedAgentId}`);
        }

        log.info(`执行任务`, {
            agentId: resolvedAgentId,
            input: input.slice(0, 100),
            sessionId,
            toolCount: ctx.tools.getToolNames().length,
        });

        // 3. 加载会话历史
        let history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
        if (sessionId) {
            const sessionMessages = this.options.sessions.getMessages(sessionId);
            history = sessionMessages.slice(-20).map(msg => ({
                role: msg.role as 'user' | 'assistant',
                content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
            }));
            log.info('加载会话历史', { sessionId, messageCount: history.length });
        }

        // 4. 保存用户消息（含附件元数据，以便切换会话后恢复显示）
        if (sessionId) {
            this.options.sessions.addMessage(sessionId, {
                role: 'user',
                content: input,
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
            promptSuffix += `\n\n## 文件输出目录\n所有生成的文件（文档、图片、代码等）必须保存到以下目录：${outputPath}\n- 使用 process 工具时，不要将文件保存到其他位置（如桌面、C:\\temp 等）\n- filesystem.write 使用相对路径时会自动解析到此目录\n- 如需创建子目录可以，但根目录必须是上述路径`;
        }

        // 注入当前系统时间（必须放在靠前位置，确保 LLM 正确理解"今天"）
        const now = new Date();
        const dateStr = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        promptSuffix += `\n\n## 当前时间（重要）\n现在是 ${dateStr}（${now.toISOString()}）。\n- 当用户提到"今天""最新""当前"等时间词时，必须基于上述时间\n- 搜索新闻、资讯时，搜索词中必须包含正确的年月日\n- 生成文件名时使用正确的日期`;

        // 只有当有追加内容时才拼接，保持 undefined 的语义不变
        if (promptSuffix) {
            agentPrompt = (agentPrompt || '') + promptSuffix;
        }

        // 5.5 附件预处理：提取文件内容并注入 input；图片转为多模态 contentParts
        let enrichedInput = input;
        let contentParts: LLMContentPart[] | undefined;

        if (attachments?.length) {
            log.info('处理用户附件', { count: attachments.length, files: attachments.map(a => a.name) });
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
                log.info('构建多模态消息', { imageCount: enriched.images.length });
            }

            log.info('附件预处理完成', { enrichedLength: enrichedInput.length, hasImages: !!contentParts });
        }

        // 6. 运行 Agent Loop
        // 存储 onProgress 供子 Agent 协作转发
        this.currentOnProgress = onProgress || null;
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
                globalAgentName: this.agentsConfig.globalAgentName,
                globalSystemPrompt: this.agentsConfig.globalSystemPrompt,
                skills: this.agentsConfig.skills as any,
            },
        );

        // 清理进度回调引用
        this.currentOnProgress = null;

        // 6. 保存助手回复
        if (sessionId) {
            this.options.sessions.addMessage(sessionId, { role: 'assistant', content: result.output });
        }

        log.info('任务完成', {
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
            throw new Error(`Agent 不存在: ${agentId}`);
        }

        log.info(`协作执行`, { agentId, task: task.slice(0, 100) });

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

        log.info('协作执行完成', {
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
        // 注入执行器
        this.collaborationManager.setExecutor(
            (agentId, task, sessionId) => this.runForCollaboration(agentId, task, sessionId)
        );

        // 注入 Agent 列表查询
        this.collaborationManager.setAgentProvider(() => this.getAgentIds());

        log.info('协作管理器已初始化');
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
                log.info(`SubAgent 完成: ${result.id}`, { status: result.status });
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
        const runner = createAgentLoopRunner({ llm, tools, memoryManager: this.options.memoryManager });

        const ctx: AgentContext = { config: agentConfig, llm, tools, runner };
        this.contextCache.set(agentId, ctx);

        log.info(`Agent 上下文已创建: ${agentId}`, {
            model: llm.getConfig().model,
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
