/**
 * 独立 Gateway Server
 * 内置 Agent Loop，客户端通过 WebSocket 连接
 */

// @ts-ignore - 运行时有 ws 模块
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { loadConfig } from '../config/loader';
import { ToolRegistry } from '../tools/registry';
import type { Tool, ToolResult, ToolParameter } from '../tools/types';
import { createSpawnTool } from '../tools/spawn';
import { createLLMProvider } from '../llm/factory';
import { createAgentLoopRunner } from '../agent/loop';
import { createSubAgentExecutor } from '../agent/subagent';
import { AgentManager } from '../agent/manager';
import { SessionStore } from '../sessions';
import { WorkflowEngine } from '../workflow';
import { Scheduler, SchedulerStore } from '../scheduler';
import type { SchedulerEvent, ScheduledTaskMeta } from '../scheduler';
import { Logger, onLogBroadcast, type LogEntry } from '../utils/logger';
import { McpClientManager, type McpServerConfig } from '../tools/mcp-client';
import { MemoryManager } from '../agent/memory/manager';
import { createMemoryTool } from '../tools/memory';
import { OpenFluxChatBridge } from './openflux-chat-bridge';
import type { OpenFluxChatProgressEvent } from './openflux-chat-bridge';
import { RouterBridge } from './router-bridge';
import { createNotifyTool } from '../tools/notify';
import type { RouterConfig, RouterInboundMessage, RouterOutboundMessage } from './router-bridge';
import { TTSService } from '../main/voice/tts';
import { STTService } from '../main/voice/stt';
import { decryptAPIKey } from '../utils/crypto';

/**
 * 运行时设置（可通过客户端动态修改）
 */
interface RuntimeSettings {
    outputPath: string;
}

/**
 * 加载或创建 settings.json
 */
function loadSettings(workspace: string): RuntimeSettings {
    const settingsPath = join(workspace, 'settings.json');
    const defaultOutputPath = join(workspace, 'output');

    try {
        if (existsSync(settingsPath)) {
            const raw = readFileSync(settingsPath, 'utf-8');
            const data = JSON.parse(raw);
            return {
                outputPath: data.outputPath || defaultOutputPath,
            };
        }
    } catch {
        // 解析失败，使用默认值
    }

    return { outputPath: defaultOutputPath };
}

/**
 * 持久化 settings.json
 */
function saveSettings(workspace: string, settings: RuntimeSettings): void {
    const settingsPath = join(workspace, 'settings.json');
    try {
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    } catch (err) {
        console.error('[Settings] 保存失败:', err);
    }
}

function saveServerConfig(workspace: string, config: any): void {
    const configPath = join(workspace, 'server-config.json');
    try {
        const data: Record<string, unknown> = {
            providers: config.providers || {},
            llm: {
                orchestration: {
                    provider: config.llm.orchestration.provider,
                    model: config.llm.orchestration.model,
                },
                execution: {
                    provider: config.llm.execution.provider,
                    model: config.llm.execution.model,
                },
                ...(config.llm.embedding ? {
                    embedding: {
                        provider: (config.llm.embedding as any).provider || 'local',
                        model: config.llm.embedding.model || '',
                    },
                } : {}),
            },
            updatedAt: new Date().toISOString(),
        };
        // 保存全局角色设定、技能和 Agent 模型
        if (config.agents?.globalAgentName || config.agents?.globalSystemPrompt || config.agents?.skills || config.agents?.list) {
            const agentsData: Record<string, unknown> = {
                globalAgentName: config.agents.globalAgentName || undefined,
                globalSystemPrompt: config.agents.globalSystemPrompt || undefined,
                skills: config.agents.skills || undefined,
            };
            // 只保存有自定义 model 的 agent
            const agentModels = (config.agents.list || []).filter((a: any) => a.model).map((a: any) => ({
                id: a.id,
                model: { provider: a.model.provider, model: a.model.model },
            }));
            if (agentModels.length > 0) {
                agentsData.agentModels = agentModels;
            }
            data.agents = agentsData;
        }
        // 保存 Router 配置
        if (config.router) {
            data.router = config.router;
        }
        // 保存 Web 配置
        if (config.web) {
            data.web = config.web;
        }
        // 保存沙盒配置
        if (config.sandbox) {
            data.sandbox = config.sandbox;
        }
        // 保存预置模型列表
        if (config.presetModels) {
            data.presetModels = config.presetModels;
        }
        writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
        console.error('[ServerConfig] 保存失败:', err);
    }
}

/**
 * 启动时加载 server-config.json 并合并到 config（UI 设置覆盖 openflux.yaml）
 */
function mergeServerConfig(workspace: string, config: any): void {
    const configPath = join(workspace, 'server-config.json');
    try {
        if (!existsSync(configPath)) return;
        const raw = readFileSync(configPath, 'utf-8');
        const saved = JSON.parse(raw);

        // 合并 providers（API Key 等）
        if (saved.providers) {
            if (!config.providers) config.providers = {};
            for (const [key, val] of Object.entries(saved.providers)) {
                if (!config.providers[key]) {
                    config.providers[key] = val;
                } else {
                    Object.assign(config.providers[key], val);
                }
            }
        }

        // 合并 LLM 配置
        if (saved.llm) {
            if (saved.llm.orchestration) {
                Object.assign(config.llm.orchestration, saved.llm.orchestration);
            }
            if (saved.llm.execution) {
                Object.assign(config.llm.execution, saved.llm.execution);
            }
            // 恢复 embedding 模型配置
            if (saved.llm.embedding) {
                config.llm.embedding = { ...config.llm.embedding, ...saved.llm.embedding };
                // 迁移已废弃的本地嵌入模型 → 当前打包的默认模型
                const BUNDLED_LOCAL_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
                const DEPRECATED_LOCAL_MODELS = ['Xenova/bge-m3', 'Xenova/bge-small-zh-v1.5'];
                if (config.llm.embedding.provider === 'local' &&
                    DEPRECATED_LOCAL_MODELS.includes(config.llm.embedding.model)) {
                    log.info(`迁移已废弃的本地嵌入模型: ${config.llm.embedding.model} → ${BUNDLED_LOCAL_MODEL}`);
                    config.llm.embedding.model = BUNDLED_LOCAL_MODEL;
                }
            }
        }

        // 合并全局角色设定、技能和 Agent 模型
        if (saved.agents) {
            if (!config.agents) {
                config.agents = { list: [{ id: 'default', default: true, name: '通用助手' }] };
            }
            if (saved.agents.globalAgentName !== undefined) {
                config.agents.globalAgentName = saved.agents.globalAgentName;
            }
            if (saved.agents.globalSystemPrompt !== undefined) {
                config.agents.globalSystemPrompt = saved.agents.globalSystemPrompt;
            }
            if (saved.agents.skills !== undefined) {
                config.agents.skills = saved.agents.skills;
            }
            // 恢复 Agent 自定义模型
            if (saved.agents.agentModels && config.agents.list) {
                for (const am of saved.agents.agentModels) {
                    const agent = config.agents.list.find((a: any) => a.id === am.id);
                    if (agent && am.model) {
                        agent.model = am.model;
                    }
                }
            }
        }

        // 合并 Web 配置
        if (saved.web) {
            config.web = { ...config.web, ...saved.web };
        }

        // 合并沙盒配置
        if (saved.sandbox) {
            config.sandbox = { ...config.sandbox, ...saved.sandbox };
        }

        // 合并 Router 配置
        if (saved.router) {
            config.router = saved.router;
        }

        // 合并预置模型列表
        if (saved.presetModels) {
            config.presetModels = saved.presetModels;
        }

        log.info('已合并 server-config.json 中的 UI 设置');
    } catch {
        // 文件不存在或解析失败，忽略
    }
}

const log = new Logger('GatewayServer');

/**
 * Agent 进度事件
 */
export interface AgentProgressEvent {
    type: 'iteration' | 'tool_start' | 'tool_result' | 'thinking' | 'token';
    iteration?: number;
    tool?: string;
    args?: Record<string, unknown>;
    result?: unknown;
    message?: string;
    thinking?: string;
    token?: string;
    description?: string;
    /** LLM 原始描述文字（仅 tool_start 事件，来自 LLM 的 content） */
    llmDescription?: string;
}

/**
 * 客户端连接
 */
interface GatewayClient {
    id: string;
    ws: WebSocket;
    authenticated: boolean;
    /** 是否订阅了 debug 日志 */
    debugSubscribed?: boolean;
    /** 客户端 MCP 工具名称列表（用于断开时清理） */
    clientMcpToolNames?: string[];
}

/**
 * 消息类型
 */
interface GatewayMessage {
    type: string;
    id?: string;
    payload?: unknown;
}

/**
 * 独立 Gateway Server
 */
export async function createStandaloneGateway() {
    log.info('独立 Gateway 启动中...');

    // 1. 加载配置
    const config = await loadConfig();
    const workspace = config.workspace || '.';
    // 合并 UI 保存的配置（server-config.json → config）
    mergeServerConfig(workspace, config);
    const port = config.remote?.port || 18801;
    const token = config.remote?.token;
    log.info('配置加载完成');

    // 2. 加载运行时设置（输出目录等）
    const runtimeSettings = loadSettings(workspace);
    // 确保输出目录存在
    if (!existsSync(runtimeSettings.outputPath)) {
        try { mkdirSync(runtimeSettings.outputPath, { recursive: true }); } catch { /* ignore */ }
    }
    log.info('运行时设置加载完成', { outputPath: runtimeSettings.outputPath });

    // 2.5 初始化 Voice 服务（TTS + STT）
    let ttsService: TTSService | null = null;
    let sttService: STTService | null = null;
    const voiceConfig = (config as any)?.voice;
    if (voiceConfig?.tts?.enabled !== false) {
        try {
            ttsService = new TTSService({
                enabled: true,
                voice: voiceConfig?.tts?.voice,
                rate: voiceConfig?.tts?.rate,
                volume: voiceConfig?.tts?.volume,
                autoPlay: voiceConfig?.tts?.autoPlay,
            });
            await ttsService.initialize();
            log.info('TTS 服务初始化完成');
        } catch (err) {
            log.warn('TTS 初始化失败（语音合成不可用）', { error: String(err) });
        }
    }
    if (voiceConfig?.stt?.enabled !== false) {
        try {
            sttService = new STTService({
                enabled: true,
                modelDir: voiceConfig?.stt?.modelDir,
                numThreads: voiceConfig?.stt?.numThreads,
            });
            await sttService.initialize();
            log.info('STT 服务初始化完成');
        } catch (err) {
            log.warn('STT 初始化失败（语音识别不可用）', { error: String(err) });
        }
    }

    // 3. 初始化 LLM Provider（容错：无 API Key 时跳过，进入引导模式）
    const llmConfig = config.llm.orchestration;
    let llm: any = null;
    try {
        llm = createLLMProvider({
            provider: llmConfig.provider,
            model: llmConfig.model,
            apiKey: llmConfig.apiKey || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || '',
            baseUrl: llmConfig.baseUrl,
            temperature: llmConfig.temperature,
            maxTokens: llmConfig.maxTokens,
        });
        log.info(`LLM Provider: ${llmConfig.provider}/${llmConfig.model}`);
    } catch (err) {
        log.warn(`LLM 初始化跳过（未配置 API Key），等待引导设置: ${err}`);
    }

    // 3. 初始化工具注册表 + 工作流引擎
    const tools = new ToolRegistry();
    const { WorkflowStore } = await import('../workflow/workflow-store');
    const workflowStore = new WorkflowStore(join(config.workspace || '.', '.workflows'));
    const workflowEngine = new WorkflowEngine({ tools, llm, store: workflowStore });

    // 创建调度器
    const schedulerStore = new SchedulerStore({ storePath: config.workspace || '.' });
    let schedulerAgentExecute: (prompt: string, sessionId?: string, meta?: ScheduledTaskMeta) => Promise<string>;
    const scheduler = new Scheduler({
        store: schedulerStore,
        onAgentExecute: (prompt, sessionId, meta) => schedulerAgentExecute(prompt, sessionId, meta),
        onEvent: (event: SchedulerEvent) => {
            // 广播调度器事件给所有在线客户端
            broadcastSchedulerEvent(event);

            // 任务首次执行时：按需创建关联会话
            if (event.type === 'run_start') {
                try {
                    const task = scheduler.getTask(event.taskId);
                    if (task && !task.sessionId) {
                        const session = sessions.create('default', `🕐 ${task.name}`);
                        scheduler.updateTask(task.id, { sessionId: session.id });
                        log.info(`任务首次执行，创建会话: "${task.name}" → ${session.id}`);
                    }
                } catch (e) {
                    log.error('为定时任务创建会话失败:', e);
                }
            }

            // 任务执行完成/失败：广播会话刷新通知
            if (event.type === 'run_complete' || event.type === 'run_failed') {
                const task = scheduler.getTask(event.taskId);
                if (task?.sessionId) {
                    broadcastSessionUpdate(task.sessionId);
                }
            }
        },
    });

    // 构建允许的工作目录列表（输出路径 + workspace + 用户配置的白名单）
    const allowedCwdPaths = new Set<string>([
        runtimeSettings.outputPath,
        workspace,
        ...(config.permissions?.allowedDirectories || []),
    ]);

    tools.registerDefaults({
        process: {
            cwd: () => runtimeSettings.outputPath,
            allowedCommands: config.sandbox?.allowedCommands,
            allowedCwdPaths: [...allowedCwdPaths],
            docker: config.sandbox?.mode === 'docker' ? config.sandbox.docker : undefined,
        },
        opencode: { cwd: () => runtimeSettings.outputPath },
        filesystem: {
            basePath: () => runtimeSettings.outputPath,
            allowedWritePaths: [...allowedCwdPaths],
            blockedExtensions: config.sandbox?.blockedExtensions,
            maxWriteSize: config.sandbox?.maxWriteSize,
        },
        office: {
            basePath: runtimeSettings.outputPath,
            allowedWritePaths: [...allowedCwdPaths],
        },
        browser: {}, // headless 选项已移除，默认根据环境适配
        workflow: { engine: workflowEngine },
        scheduler: { scheduler },
        webSearch: config.web?.search,
        webFetch: config.web?.fetch,
    });
    log.info('工作流引擎初始化完成');

    // 3.6 验证 Python 环境
    try {
        const { logPythonEnvStatus } = await import('../utils/python-env');
        logPythonEnvStatus();
    } catch (e) {
        log.warn('Python 环境模块加载失败（不影响核心功能）');
    }

    // 3.8 初始化长期记忆
    let memoryManager: MemoryManager | undefined;
    if (config.memory?.enabled) {
        try {
            const memoryConfig = {
                dbPath: join(workspace, '.memory', config.memory.dbName),
                vectorDim: config.memory.vectorDim,
                embeddingModel: config.llm.embedding?.model,
                debug: config.memory.debug,
            };

            // 3.8.1 初始化嵌入 LLM (如果配置了独立 embedding provider)
            let embeddingLLM = llm;
            if (config.llm.embedding) {
                const embConfig = config.llm.embedding;
                const embApiKey = embConfig.apiKey || process.env[`${embConfig.provider.toUpperCase()}_API_KEY`] || '';

                if (!embApiKey && embConfig.provider !== 'local') {
                    log.warn(`Embedding provider '${embConfig.provider}' 缺少 API Key。请在 openflux.yaml 中配置或设置环境变量 ${embConfig.provider.toUpperCase()}_API_KEY。长期记忆系统将不会初始化。`);
                    throw new Error(`Missing API Key for embedding provider: ${embConfig.provider}`);
                }

                embeddingLLM = createLLMProvider({
                    provider: embConfig.provider,
                    model: embConfig.model,
                    apiKey: embApiKey,
                    baseUrl: embConfig.baseUrl,
                });
                log.info(`Embedding LLM Configured: ${embConfig.provider}/${embConfig.model}`);
            }

            memoryManager = new MemoryManager(memoryConfig, embeddingLLM);
            // 监听重建进度并广播
            memoryManager.on('rebuildProgress', (progress: number) => {
                const message = JSON.stringify({ type: 'config.rebuildProgress', payload: { progress } });
                for (const client of clients.values()) {
                    if (client.authenticated && client.ws.readyState === WebSocket.OPEN) {
                        client.ws.send(message);
                    }
                }
            });
            // 注册 memory 工具
            tools.register(createMemoryTool({ memoryManager }));
            log.info('长期记忆系统初始化完成');

            // 3.9 初始化记忆蒸馏系统 (独立于原有 MemoryManager)
            try {
                const { CardManager } = await import('../agent/memory/card-manager');
                const { CardUpgrader } = await import('../agent/memory/card-upgrader');
                const { DistillationScheduler } = await import('../agent/memory/distillation-scheduler');

                const distillationConf = config.memory?.distillation as any || {};
                const distillConfig = {
                    enabled: distillationConf.enabled ?? false,
                    startTime: distillationConf.startTime ?? '02:00',
                    endTime: distillationConf.endTime ?? '06:00',
                    qualityThreshold: distillationConf.qualityThreshold ?? 40,
                    sessionDensityThreshold: distillationConf.sessionDensityThreshold ?? 5,
                    similarityThreshold: distillationConf.similarityThreshold ?? 0.85,
                };

                // CardManager 需要两个 LLM: chatLLM 用于摘要提取, embeddingLLM 用于向量索引
                const cardManager = new CardManager(
                    (memoryManager as any).db,
                    llm,            // chatLLM: 主 LLM (支持 chat)
                    embeddingLLM,   // embeddingLLM: 嵌入模型 (支持 embed)
                    distillConfig
                );

                const cardUpgrader = new CardUpgrader(
                    (memoryManager as any).db,
                    llm,            // chatLLM: 主 LLM (支持 chat) 
                    embeddingLLM,   // embeddingLLM: 嵌入模型 (支持 embed)
                    cardManager,
                    distillConfig
                );

                const distillScheduler = new DistillationScheduler(cardUpgrader, distillConfig);
                distillScheduler.start();

                // 监听新记忆写入 → 异步生成 Micro 卡片 (fire-and-forget, 不阻断原有流程)
                memoryManager.on('memoryAdded', (entry: { id: string; content: string }) => {
                    // 使用 distillScheduler.getStatus() 获取运行时最新状态
                    // (distillConfig 是初始化快照, updateConfig 后不会同步回来)
                    if (distillScheduler.getStatus().enabled) {
                        cardManager.generateMicroCard(entry.content, entry.id).catch(err => {
                            log.debug('Micro 卡片生成失败 (不影响核心记忆)', { error: String(err) });
                        });
                    }
                });

                // 将分层上下文检索注入到 AgentManager (通过扩展 memoryManager)
                (memoryManager as any)._cardManager = cardManager;
                (memoryManager as any)._distillScheduler = distillScheduler;

                log.info(`记忆蒸馏系统初始化完成 (${distillConfig.enabled ? '已启用' : '未启用'}, 时段: ${distillConfig.startTime}-${distillConfig.endTime})`);
            } catch (distillError) {
                log.warn('记忆蒸馏系统初始化失败 (不影响基础记忆功能)', { error: String(distillError) });
            }

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            const errorStack = error instanceof Error ? error.stack : undefined;
            log.error('长期记忆系统初始化失败', { message: errorMsg, stack: errorStack });
        }
    }

    // 3.5 MCP 外部工具加载
    const mcpManager = new McpClientManager();
    if (config.mcp?.servers?.length) {
        try {
            await mcpManager.initialize(config.mcp.servers as McpServerConfig[]);
            for (const tool of mcpManager.getTools()) {
                tools.register(tool);
            }
            const serverInfo = mcpManager.getServerInfo();
            log.info(`MCP 工具注册完成: ${serverInfo.map(s => `${s.name}(${s.toolCount})`).join(', ')}`);
        } catch (error) {
            log.error('MCP 初始化失败（不影响核心功能）:', { error });
        }
    }



    // 4. 添加 spawn 工具（AgentManager 会按需创建带限制的版本）
    const subAgentExecutor = createSubAgentExecutor({
        llm,
        tools,
        onComplete: (result) => {
            log.info(`SubAgent 完成: ${result.id}`, { status: result.status });
        },
    });
    const spawnTool = createSpawnTool({
        defaultTimeout: 300,
        maxConcurrent: 5,
        onExecute: subAgentExecutor,
    });
    tools.register(spawnTool);
    log.info(`工具注册完成，共 ${tools.getToolNames().length} 个`);

    // 5. 初始化会话存储
    const sessions = new SessionStore({
        storePath: config.workspace,
    });
    log.info('会话存储初始化完成');

    // 6. 创建 AgentManager（多 Agent 路由 + 工具过滤 + 执行）
    const agentManager = new AgentManager({
        config,
        tools,
        defaultLLM: llm,
        sessions,
        memoryManager,
        getOutputPath: () => runtimeSettings.outputPath,
    });

    // 7. 保留 agentRunner 给定时任务等内部场景使用（let 以支持热更新重建）
    let agentRunner = createAgentLoopRunner({ llm, tools });

    // 8. 初始化 OpenFlux 云端聊天桥接器
    const openfluxBridge = new OpenFluxChatBridge({
        apiUrl: 'https://nexus-api.atyun.com',
        wsUrl: 'wss://nexus-chat.atyun.com',
    });
    log.info('OpenFlux 云端桥接器初始化完成');

    // 9. 初始化 OpenFluxRouter 桥接器
    const routerBridge = new RouterBridge();

    // Router 托管 LLM 配置（仅存内存）
    let managedLlmConfig: {
        provider: string;
        model: string;
        apiKey: string;   // 解密后
        baseUrl?: string;
        quota?: { daily_limit: number; used_today: number };
    } | null = null;
    let llmSource: 'local' | 'managed' = 'local';

    // 最近一次入站用户信息（用于 notify_user 工具）
    // 持久化到文件，重启后自动恢复
    const routerUserFile = join(process.cwd(), '.router-user.json');
    let lastRouterUser: { platform_type: string; platform_id: string; platform_user_id: string } | null = null;
    try {
        if (existsSync(routerUserFile)) {
            const data = JSON.parse(readFileSync(routerUserFile, 'utf-8'));
            if (data?.platform_type && data?.platform_id && data?.platform_user_id) {
                lastRouterUser = data;
                log.info('已恢复上次入站用户', { platform: data.platform_type, userId: data.platform_user_id });
            }
        }
    } catch {
        // 忽略读取失败
    }

    // 注册 notify_user 工具（需要 routerBridge 已初始化）
    tools.register(createNotifyTool({
        getRouterBridge: () => routerBridge,
        getLastUser: () => lastRouterUser,
    }));

    // Router 入站消息处理：进入 Agent 对话流程
    let routerSessionId: string | null = null;

    /** 获取或创建 Router 专属会话（重启后复用已有会话） */
    function getRouterSessionId(): string {
        // 1. 如果已缓存且有效，直接用
        if (routerSessionId) {
            const existing = sessions.get(routerSessionId);
            if (existing && existing.status === 'active') return routerSessionId;
        }
        // 2. 搜索已有的 Router 会话（按标题匹配）
        const allSessions = sessions.list();
        const routerSession = allSessions.find(s => s.title === 'Router 消息');
        if (routerSession) {
            routerSessionId = routerSession.id;
            log.info('复用已有 Router 会话', { sessionId: routerSessionId });
            return routerSessionId;
        }
        // 3. 没找到则创建新的
        const session = sessions.create('default', 'Router 消息');
        routerSessionId = session.id;
        log.info('创建 Router 专属会话', { sessionId: routerSessionId });
        return routerSessionId;
    }

    /** 广播消息给所有已认证客户端 */
    function broadcastToClients(msg: Record<string, unknown>): void {
        const data = JSON.stringify(msg);
        for (const c of clients.values()) {
            if (c.authenticated && c.ws.readyState === WebSocket.OPEN) {
                c.ws.send(data);
            }
        }
    }

    /**
     * 从 Router WebSocket URL 推导 HTTP 基地址
     * ws://host:port/ws/app → http://host:port
     * wss://host:port/ws/app → https://host:port
     */
    function getRouterHttpBaseUrl(): string | null {
        const wsUrl = routerBridge.getRawConfig()?.url;
        if (!wsUrl) return null;
        try {
            const u = new URL(wsUrl);
            const protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
            return `${protocol}//${u.host}`;
        } catch {
            return null;
        }
    }

    /**
     * 从 Router 下载多媒体文件到本地
     * 调用 Router 的 GET /api/files/download?path=xxx 接口
     */
    async function downloadRouterFile(remotePath: string, fileName: string): Promise<{ localPath: string; size: number } | null> {
        const baseUrl = getRouterHttpBaseUrl();
        const apiKey = routerBridge.getRawConfig()?.apiKey;
        if (!baseUrl || !apiKey) {
            log.error('无法下载 Router 文件：缺少 Router URL 或 API Key');
            return null;
        }

        // 本地存储目录: {workspace}/data/router-files/{date}/
        const date = new Date().toISOString().slice(0, 10);
        const localDir = join(config.workspace, 'data', 'router-files', date);
        mkdirSync(localDir, { recursive: true });

        const downloadUrl = `${baseUrl}/api/files/download?path=${encodeURIComponent(remotePath)}`;
        log.info('从 Router 下载文件', { url: downloadUrl, fileName });

        try {
            const resp = await fetch(downloadUrl, {
                headers: { 'Authorization': `Bearer ${apiKey}` },
            });

            if (!resp.ok) {
                log.error('Router 文件下载失败', { status: resp.status, statusText: resp.statusText });
                return null;
            }

            const buffer = Buffer.from(await resp.arrayBuffer());
            const localPath = join(localDir, fileName);
            const { writeFileSync: writeFile } = await import('fs');
            writeFile(localPath, buffer);

            log.info('Router 文件已下载到本地', { localPath, size: buffer.length });
            return { localPath, size: buffer.length };
        } catch (err) {
            log.error('Router 文件下载异常', { error: err instanceof Error ? err.message : String(err) });
            return null;
        }
    }

    function setupRouterMessageHandler(): void {
        routerBridge.onMessage = async (msg: RouterInboundMessage) => {
            const sessionId = getRouterSessionId();
            const msgId = msg.id || crypto.randomUUID();

            const userLabel = `[${msg.platform_type}] ${msg.platform_user_id}`;

            // 记录最近入站用户（供 notify_user 工具使用）
            lastRouterUser = {
                platform_type: msg.platform_type,
                platform_id: msg.platform_id,
                platform_user_id: msg.platform_user_id,
            };
            // 持久化到文件
            try { writeFileSync(routerUserFile, JSON.stringify(lastRouterUser), 'utf-8'); } catch { /* 忽略 */ }
            const metadata = (msg.metadata || {}) as Record<string, string>;
            const contentType = msg.content_type || 'text';
            const isMedia = contentType !== 'text' && contentType !== 'post';

            // 1. 处理多媒体消息：从 Router 下载文件到本地
            let agentInput = msg.content;
            let attachments: Array<{ path: string; name: string; size: number; ext: string }> | undefined;

            if (isMedia) {
                const remotePath = metadata['local_path'] || msg.content;
                const originalName = metadata['file_name'] || '';
                // 生成安全文件名（保留原始扩展名，或根据 content_type 推断）
                const extMap: Record<string, string> = { image: '.png', audio: '.opus', video: '.mp4', file: '.dat' };
                const ext = originalName ? ('.' + originalName.split('.').pop()) : (extMap[contentType] || '.dat');
                const safeFileName = `${msgId.slice(0, 8)}_${originalName || `file${ext}`}`;

                log.info('收到 Router 多媒体消息', {
                    contentType,
                    remotePath: remotePath.slice(0, 100),
                    fileName: originalName,
                });

                const downloaded = await downloadRouterFile(remotePath, safeFileName);

                if (downloaded) {
                    attachments = [{
                        path: downloaded.localPath,
                        name: originalName || safeFileName,
                        size: downloaded.size,
                        ext: ext,
                    }];

                    // 构造描述性文本作为 Agent input
                    const typeLabel: Record<string, string> = {
                        image: '图片', file: '文件', audio: '语音', video: '视频',
                    };
                    agentInput = `用户发送了一个${typeLabel[contentType] || '文件'}：${originalName || safeFileName}`;
                } else {
                    // 下载失败，降级为文本提示
                    agentInput = `[${contentType}] 用户发送了一个文件，但下载失败，无法处理`;
                    log.warn('多媒体文件下载失败，降级为文本', { remotePath });
                }
            }

            // 2. 广播用户消息给客户端（显示用户气泡）
            broadcastToClients({
                type: 'router.user_message',
                id: msgId,
                payload: {
                    sessionId,
                    content: isMedia ? agentInput : msg.content,
                    label: userLabel,
                    platform_type: msg.platform_type,
                    platform_user_id: msg.platform_user_id,
                    platform_id: msg.platform_id,
                    timestamp: msg.timestamp || Date.now(),
                    // 多媒体附件信息（供前端渲染图片预览等）
                    attachments: attachments?.map(a => ({
                        name: a.name,
                        ext: a.ext,
                        size: a.size,
                        path: a.path,
                        content_type: contentType,
                    })),
                },
            });

            // 3. 调用 Agent 处理
            log.info('Router 入站消息进入 Agent 处理', { from: userLabel, content: agentInput.slice(0, 80) });
            broadcastToClients({ type: 'chat.start', id: msgId });

            const routerMetadata = {
                source: 'router',
                platform_type: msg.platform_type,
                platform_user_id: msg.platform_user_id,
                platform_id: msg.platform_id,
                label: userLabel,
            };

            try {
                const output = await executeAgent(
                    agentInput,
                    sessionId,
                    (event) => {
                        broadcastToClients({
                            type: 'chat.progress',
                            id: msgId,
                            payload: { ...event, sessionId },
                        });
                    },
                    attachments,     // 多媒体附件（图片/文件）
                    routerMetadata,
                );

                broadcastToClients({
                    type: 'chat.complete',
                    id: msgId,
                    payload: { output, sessionId },
                });

                // 回传 AI 回复到平台
                routerBridge.send({
                    platform_type: msg.platform_type,
                    platform_id: msg.platform_id,
                    platform_user_id: msg.platform_user_id,
                    content_type: 'text',
                    content: output,
                });
                log.info('AI 回复已回传到 Router', { platform: msg.platform_type, userId: msg.platform_user_id });
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                broadcastToClients({
                    type: 'chat.error',
                    id: msgId,
                    payload: { message: errorMsg },
                });
                log.error('Router Agent 处理失败', { error: errorMsg });
            }
        };
    }

    // 客户端管理
    const clients = new Map<string, GatewayClient>();
    let wss: WebSocketServer | null = null;
    let setupSkipped = false;

    // RouterBridge 连接状态广播（需在 clients 初始化之后设置）
    routerBridge.onConnectionChange = (status) => {
        const message = JSON.stringify({ type: 'router.status', payload: { connected: status === 'connected', status } });
        for (const c of clients.values()) {
            if (c.authenticated && c.ws.readyState === WebSocket.OPEN) {
                c.ws.send(message);
            }
        }
    };
    // RouterBridge 绑定结果广播
    routerBridge.onBindResult = (result) => {
        const message = JSON.stringify({ type: 'router.bind_result', payload: result });
        for (const c of clients.values()) {
            if (c.authenticated && c.ws.readyState === WebSocket.OPEN) {
                c.ws.send(message);
            }
        }
    };
    // RouterBridge 连接状态推送（Router 连接后自动推送绑定状态）
    routerBridge.onConnectStatus = (status) => {
        // 转换为 bind_result 格式让客户端统一处理
        const payload = status.bound
            ? { action: 'connect_status', status: 'matched', message: '已绑定', bound: true, platform_user_id: status.platform_user_id, platform_id: status.platform_id }
            : { action: 'connect_status', status: 'unbound', message: '未绑定', bound: false };
        const message = JSON.stringify({ type: 'router.bind_result', payload });
        for (const c of clients.values()) {
            if (c.authenticated && c.ws.readyState === WebSocket.OPEN) {
                c.ws.send(message);
            }
        }
    };
    // RouterBridge LLM 配置下发
    routerBridge.onLlmConfig = (cfg) => {
        try {
            const routerCfg = (config as any).router as RouterConfig;
            if (!routerCfg?.appId || !routerCfg?.apiKey) {
                log.warn('收到 LLM 配置但 Router 未配置 appId/apiKey，无法解密');
                return;
            }
            // AES-256-GCM 解密 API Key
            const decryptedKey = decryptAPIKey(
                cfg.api_key_encrypted,
                cfg.iv,
                routerCfg.appId,
            );
            managedLlmConfig = {
                provider: cfg.provider,
                model: cfg.model,
                apiKey: decryptedKey,
                baseUrl: cfg.base_url || undefined,
                quota: cfg.quota,
            };
            log.info('托管 LLM 配置已更新', { provider: cfg.provider, model: cfg.model });

            // 如果当前已使用 managed 源，自动重建 LLM 实例使新配置立即生效
            if (llmSource === 'managed') {
                if (!config.providers) config.providers = {} as any;
                (config.providers as any)[managedLlmConfig.provider] = {
                    apiKey: managedLlmConfig.apiKey,
                    ...(managedLlmConfig.baseUrl ? { baseUrl: managedLlmConfig.baseUrl } : {}),
                };
                config.llm.orchestration.provider = managedLlmConfig.provider as any;
                config.llm.orchestration.model = managedLlmConfig.model;
                config.llm.execution.provider = managedLlmConfig.provider as any;
                config.llm.execution.model = managedLlmConfig.model;
                llm = createLLMProvider({
                    provider: managedLlmConfig.provider as any,
                    model: managedLlmConfig.model,
                    apiKey: managedLlmConfig.apiKey,
                    baseUrl: managedLlmConfig.baseUrl,
                });
                agentManager.updateLLM(llm);
                agentRunner = createAgentLoopRunner({ llm, tools });
                log.info('托管 LLM 配置已自动热更新', { provider: managedLlmConfig.provider, model: managedLlmConfig.model });
            }

            // 推送给所有客户端（不含明文 key）
            const pushMsg = JSON.stringify({
                type: 'managed-llm-config',
                payload: {
                    available: true,
                    provider: cfg.provider,
                    model: cfg.model,
                    quota: cfg.quota,
                    currentSource: llmSource,
                },
            });
            for (const c of clients.values()) {
                if (c.authenticated && c.ws.readyState === WebSocket.OPEN) {
                    c.ws.send(pushMsg);
                }
            }
        } catch (err) {
            log.error('解密托管 LLM 配置失败', { error: err });
        }
    };
    // 初始化 Router 消息处理回调
    setupRouterMessageHandler();
    // 如果配置中已有 Router 设置，自动连接
    if ((config as any).router?.enabled) {
        routerBridge.connect((config as any).router as RouterConfig);
        log.info('OpenFluxRouter 桥接器已初始化并连接');
    } else {
        log.info('OpenFluxRouter 桥接器已初始化（未启用）');
    }

    // 注册全局日志广播：将日志推送到所有已订阅 debug 的客户端
    // 使用 readyState === 1 代替 WebSocket.OPEN，避免外部模块常量在打包后丢失
    onLogBroadcast((entry: LogEntry) => {
        const debugMsg = JSON.stringify({
            type: 'debug.log',
            payload: entry,
        });
        for (const client of clients.values()) {
            if (client.debugSubscribed && client.ws.readyState === 1) {
                try {
                    client.ws.send(debugMsg);
                } catch {
                    // 发送失败不影响其他客户端
                }
            }
        }
    });

    /**
     * 执行 Agent（通过 AgentManager 路由和执行，支持文件附件）
     */
    async function executeAgent(
        input: string,
        sessionId?: string,
        onProgress?: (event: AgentProgressEvent) => void,
        attachments?: Array<{ path: string; name: string; size: number; ext: string }>,
        userMetadata?: Record<string, unknown>,
    ): Promise<string> {
        log.info('执行任务', { input: input.slice(0, 100), sessionId, attachments: attachments?.length || 0 });

        const result = await agentManager.run(
            input,
            undefined,       // agentId: 不指定，由 Router 自动路由
            sessionId,
            onProgress,
            attachments,
            userMetadata,
        );

        log.info('任务完成', {
            agentId: result.agentId,
            route: result.routeResult?.reason,
        });
        return result.output;
    }

    /**
     * 定时任务专用 Agent 执行
     * 与普通聊天的区别：
     * 1. 保存触发消息为系统提示（非普通用户消息）
     * 2. Prompt 包装：告知 Agent 这是定时任务执行，禁止创建新任务
     * 3. 不加载历史对话，避免 Agent 被之前的执行记录干扰
     */
    async function executeScheduledAgent(
        prompt: string,
        sessionId?: string,
        meta?: ScheduledTaskMeta
    ): Promise<string> {
        const taskName = meta?.taskName || '定时任务';
        const msgId = crypto.randomUUID();
        log.info('定时任务执行', { taskName, prompt: prompt.slice(0, 100), sessionId });

        // 保存触发消息（以 assistant 身份发送，不模拟用户发消息）
        if (sessionId) {
            sessions.addMessage(sessionId, {
                role: 'assistant',
                content: `🕐 **定时任务触发：${taskName}**`,
            });
        }

        // 广播定时任务开始（使前端能实时显示进度）
        broadcastToClients({
            type: 'chat.progress',
            id: msgId,
            payload: { type: 'iteration', iteration: 0, sessionId },
        });

        // 包装 prompt：明确告知 Agent 这是定时执行，不要创建新任务
        const wrappedPrompt = [
            `[系统指令] 这是定时任务「${taskName}」的自动触发执行。`,
            `请直接执行以下任务内容，将结果回复给用户。`,
            `⚠ 严禁调用 scheduler 工具，不要创建新的定时任务。这已经是任务执行阶段，只需执行并回复结果。`,
            ``,
            `任务内容：${prompt}`,
        ].join('\n');

        // 运行 Agent Loop（不加载历史，保持上下文干净）
        const result = await agentRunner.run(
            wrappedPrompt,
            undefined,
            {
                onIteration: () => { },
                onToken: () => { },
                onThinking: (thinking: string) => {
                    if (sessionId) {
                        sessions.addLog(sessionId, {
                            tool: '_thinking',
                            args: { content: thinking },
                            success: true,
                        });
                    }
                },
                onToolStart: (description: string, _toolCalls: unknown[], _llmContent?: string) => {
                    broadcastToClients({
                        type: 'chat.progress',
                        id: msgId,
                        payload: { type: 'tool_start', description, sessionId },
                    });
                },
                onToolCall: (toolCall: { name: string; arguments: Record<string, unknown> }, toolResult: unknown) => {
                    if (sessionId) {
                        const success = !(toolResult && typeof toolResult === 'object' && 'error' in toolResult);
                        sessions.addLog(sessionId, {
                            tool: toolCall.name,
                            action: toolCall.arguments?.action as string | undefined,
                            args: toolCall.arguments,
                            success,
                        });
                    }
                    // 广播工具结果给前端（使定时任务也能实时检测交付物）
                    broadcastToClients({
                        type: 'chat.progress',
                        id: msgId,
                        payload: {
                            type: 'tool_result',
                            tool: toolCall.name,
                            args: toolCall.arguments,
                            result: toolResult,
                            sessionId,
                        },
                    });
                },
            },
            [] // 空历史，避免被之前的执行记录干扰
        );

        // 保存助手回复
        if (sessionId) {
            sessions.addMessage(sessionId, { role: 'assistant', content: result.output });

            // 后端提取 artifacts 保存到 session（不依赖前端回传）
            extractAndSaveScheduledArtifacts(sessionId, result.toolCalls);
        }

        // 广播完成事件
        broadcastToClients({
            type: 'chat.progress',
            id: msgId,
            payload: { type: 'complete', sessionId },
        });

        log.info('定时任务完成', { taskName, iterations: result.iterations, toolCalls: result.toolCalls.length });
        return result.output;
    }

    /**
     * 从定时任务的工具调用记录中提取 artifacts 并保存到 session
     * 检测 filesystem.write/copy/info、process/opencode 的生成文件
     */
    function extractAndSaveScheduledArtifacts(
        sessionId: string,
        toolCalls: Array<{ name: string; result: unknown }>,
    ): void {
        const savedPaths = new Set<string>();
        const { resolve: resolvePath } = require('path') as typeof import('path');

        // 常见成果物扩展名
        const artifactExts = new Set([
            'pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx',
            'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp',
            'mp4', 'mp3', 'wav', 'avi',
            'zip', 'rar', '7z', 'tar', 'gz',
            'py', 'js', 'ts', 'html', 'css', 'json', 'yaml', 'md', 'txt', 'csv',
        ]);

        for (const tc of toolCalls) {
            try {
                const resultObj = tc.result as Record<string, unknown> | undefined;
                if (!resultObj) continue;
                const data = resultObj.data as Record<string, unknown> | undefined;

                // filesystem.write / filesystem.copy → 直接取 data.path / data.destination
                if (tc.name === 'filesystem' && data) {
                    const filePath = (data.path as string) || (data.destination as string);
                    if (filePath && !savedPaths.has(filePath)) {
                        try {
                            if (existsSync(filePath)) {
                                savedPaths.add(filePath);
                                const filename = filePath.split(/[/\\]/).pop() || '文件';
                                const size = (data.size as number) || undefined;
                                sessions.addArtifact(sessionId, {
                                    type: 'file', path: filePath, filename, size, timestamp: Date.now(),
                                });
                                log.info('定时任务成果物已保存', { filename, path: filePath });
                            }
                        } catch { /* ignore */ }
                    }
                }

                // process / opencode → 检测 generatedFiles
                if ((tc.name === 'process' || tc.name === 'opencode') && data) {
                    const generatedFiles = data.generatedFiles as Array<{ path: string; fullPath: string; size: number }> | undefined;
                    if (generatedFiles?.length) {
                        for (const f of generatedFiles) {
                            if (f.fullPath && !savedPaths.has(f.fullPath)) {
                                try {
                                    if (existsSync(f.fullPath)) {
                                        savedPaths.add(f.fullPath);
                                        sessions.addArtifact(sessionId, {
                                            type: 'file',
                                            path: f.fullPath,
                                            filename: f.path.split(/[/\\]/).pop() || f.path,
                                            size: f.size,
                                            timestamp: Date.now(),
                                        });
                                        log.info('定时任务成果物已保存', { filename: f.path, path: f.fullPath });
                                    }
                                } catch { /* ignore */ }
                            }
                        }
                    }

                    // 备用：从 stdout 中检测文件路径
                    if (!generatedFiles?.length) {
                        const stdout = (data.stdout as string) || '';
                        const pathRegex = /(?:[A-Z]:[/\\]|\/)[^\s"'<>|*?\n]+\.(?:pptx?|docx?|xlsx?|pdf|png|jpg|jpeg|gif|svg|mp4|mp3|zip|csv|html|txt|md)(?=\s|$|["'])/gi;
                        const matches = stdout.match(pathRegex);
                        if (matches) {
                            for (const m of [...new Set(matches)]) {
                                const resolved = resolvePath(m);
                                if (!savedPaths.has(resolved)) {
                                    try {
                                        if (existsSync(resolved)) {
                                            savedPaths.add(resolved);
                                            sessions.addArtifact(sessionId, {
                                                type: 'file',
                                                path: resolved,
                                                filename: resolved.split(/[/\\]/).pop() || resolved,
                                                timestamp: Date.now(),
                                            });
                                            log.info('定时任务成果物已保存(stdout)', { path: resolved });
                                        }
                                    } catch { /* ignore */ }
                                }
                            }
                        }
                    }
                }

                // filesystem.info → Agent 确认文件存在
                if (tc.name === 'filesystem' && data && data.isFile) {
                    const filePath = (data.path as string) || '';
                    const ext = filePath.split('.').pop()?.toLowerCase() || '';
                    if (filePath && artifactExts.has(ext) && !savedPaths.has(filePath)) {
                        try {
                            if (existsSync(filePath)) {
                                savedPaths.add(filePath);
                                sessions.addArtifact(sessionId, {
                                    type: 'file',
                                    path: filePath,
                                    filename: filePath.split(/[/\\]/).pop() || '文件',
                                    size: (data.size as number) || undefined,
                                    timestamp: Date.now(),
                                });
                                log.info('定时任务成果物已保存(info)', { path: filePath });
                            }
                        } catch { /* ignore */ }
                    }
                }
            } catch (err) {
                log.warn('定时任务成果物提取异常', { tool: tc.name, error: err instanceof Error ? err.message : String(err) });
            }
        }

        if (savedPaths.size > 0) {
            log.info(`定时任务共提取 ${savedPaths.size} 个成果物`);
        }
    }

    // 绑定调度器 Agent 执行回调
    schedulerAgentExecute = executeScheduledAgent;
    scheduler.start();
    log.info('调度器启动完成');

    /**
     * 广播调度器事件给所有在线客户端
     */
    function broadcastSchedulerEvent(event: SchedulerEvent): void {
        const message = JSON.stringify({ type: 'scheduler.event', payload: event });
        for (const client of clients.values()) {
            if (client.authenticated && client.ws.readyState === WebSocket.OPEN) {
                client.ws.send(message);
            }
        }
    }

    /**
     * 广播会话更新通知（通知前端刷新会话列表或指定会话消息）
     */
    function broadcastSessionUpdate(sessionId: string): void {
        const message = JSON.stringify({ type: 'session.updated', payload: { sessionId } });
        for (const client of clients.values()) {
            if (client.authenticated && client.ws.readyState === WebSocket.OPEN) {
                client.ws.send(message);
            }
        }
    }

    /**
     * 处理连接
     */
    function handleConnection(ws: WebSocket): void {
        const clientId = crypto.randomUUID();
        const client: GatewayClient = {
            id: clientId,
            ws,
            authenticated: !token,
            debugSubscribed: false,
        };

        clients.set(clientId, client);
        log.info(`客户端连接: ${clientId}`);

        // 检测是否首次运行（server-config.json 不存在或无 providers 配置）
        let setupRequired = false;
        if (setupSkipped) {
            setupRequired = false;
        } else
            try {
                const cfgPath = join(workspace, 'server-config.json');
                if (!existsSync(cfgPath)) {
                    // server-config.json 不存在，检查 openflux.yaml 中的 providers 是否有真实 apiKey
                    const hasRealKey = config.providers && Object.values(config.providers).some(
                        (p: any) => p?.apiKey && !p.apiKey.startsWith('${')
                    );
                    if (!hasRealKey) setupRequired = true;
                } else {
                    const raw = readFileSync(cfgPath, 'utf-8');
                    const saved = JSON.parse(raw);
                    // 如果已标记跳过设置，不再要求设置
                    if (saved._setupSkipped) {
                        setupRequired = false;
                    } else if (!saved.providers || Object.keys(saved.providers).length === 0) {
                        setupRequired = true;
                    } else {
                        const hasKey = Object.values(saved.providers).some(
                            (p: any) => p?.apiKey && !p.apiKey.startsWith('${')
                        );
                        if (!hasKey) setupRequired = true;
                    }
                }
            } catch {
                setupRequired = true;
            }

        send(client, {
            type: 'welcome',
            payload: { requireAuth: !!token, setupRequired },
        });

        ws.on('message', (data: Buffer) => handleMessage(client, data.toString()));
        ws.on('close', () => {
            // 清理客户端 MCP 代理工具
            if (client.clientMcpToolNames?.length) {
                for (const name of client.clientMcpToolNames) {
                    tools.unregister(name);
                }
                log.info(`客户端 ${clientId} 断开，已清理 ${client.clientMcpToolNames.length} 个代理工具`);
            }
            clients.delete(clientId);
            log.info(`客户端断开: ${clientId}`);
        });
        ws.on('error', (error: Error) => log.error(`客户端错误: ${clientId}`, { error }));
    }

    /**
     * 处理消息
     */
    async function handleMessage(client: GatewayClient, data: string): Promise<void> {
        try {
            const message: GatewayMessage = JSON.parse(data);
            if (!client.authenticated && message.type !== 'auth') {
                send(client, { type: 'error', payload: { message: '未认证' } });
                return;
            }

            switch (message.type) {
                case 'auth':
                    handleAuth(client, message);
                    break;
                case 'chat':
                    await handleChat(client, message);
                    break;
                case 'sessions.list':
                    handleSessionsList(client, message);
                    break;
                case 'sessions.messages':
                    handleSessionsMessages(client, message);
                    break;
                case 'sessions.logs':
                    handleSessionsLogs(client, message);
                    break;
                case 'sessions.create':
                    handleSessionsCreate(client, message);
                    break;
                case 'sessions.delete':
                    handleSessionsDelete(client, message);
                    break;
                case 'sessions.artifacts':
                    handleSessionsArtifacts(client, message);
                    break;
                case 'sessions.artifacts.save':
                    handleSessionsArtifactsSave(client, message);
                    break;
                case 'scheduler.list':
                    handleSchedulerList(client, message);
                    break;
                case 'scheduler.runs':
                    handleSchedulerRuns(client, message);
                    break;
                case 'scheduler.pause':
                    handleSchedulerPause(client, message);
                    break;
                case 'scheduler.resume':
                    handleSchedulerResume(client, message);
                    break;
                case 'scheduler.delete':
                    handleSchedulerDelete(client, message);
                    break;
                case 'scheduler.trigger':
                    await handleSchedulerTrigger(client, message);
                    break;
                case 'settings.get':
                    handleSettingsGet(client, message);
                    break;
                case 'settings.update':
                    handleSettingsUpdate(client, message);
                    break;
                case 'config.get':
                    handleConfigGet(client, message);
                    break;
                case 'config.update':
                    await handleConfigUpdate(client, message);
                    break;
                case 'config.set-llm-source': {
                    const src = (message.payload as any)?.source;
                    if (src === 'managed' && managedLlmConfig) {
                        llmSource = 'managed';
                        // 将托管配置注入到运行时 config（仅影响内存，不持久化）
                        if (!config.providers) config.providers = {} as any;
                        (config.providers as any)[managedLlmConfig.provider] = {
                            apiKey: managedLlmConfig.apiKey,
                            ...(managedLlmConfig.baseUrl ? { baseUrl: managedLlmConfig.baseUrl } : {}),
                        };
                        config.llm.orchestration.provider = managedLlmConfig.provider as any;
                        config.llm.orchestration.model = managedLlmConfig.model;
                        config.llm.execution.provider = managedLlmConfig.provider as any;
                        config.llm.execution.model = managedLlmConfig.model;
                        // 重建 LLM 实例并清除缓存，使新 API Key 生效
                        llm = createLLMProvider({
                            provider: managedLlmConfig.provider as any,
                            model: managedLlmConfig.model,
                            apiKey: managedLlmConfig.apiKey,
                            baseUrl: managedLlmConfig.baseUrl,
                        });
                        agentManager.updateLLM(llm);
                        agentRunner = createAgentLoopRunner({ llm, tools });
                        log.info('已切换到托管 LLM 配置', { provider: managedLlmConfig.provider });
                    } else {
                        llmSource = 'local';
                        // 重新加载本地 server-config.json 恢复配置
                        try {
                            const cfgPath = join(workspace, 'server-config.json');
                            if (existsSync(cfgPath)) {
                                const saved = JSON.parse(readFileSync(cfgPath, 'utf-8'));
                                if (saved.providers) {
                                    (config as any).providers = saved.providers;
                                }
                                if (saved.llm) {
                                    Object.assign(config.llm, saved.llm);
                                }
                            }
                        } catch (e) {
                            log.error('恢复本地 LLM 配置失败', { error: e });
                        }
                        // 重建 LLM 实例并清除缓存
                        const localCfg = config.llm.orchestration;
                        llm = createLLMProvider({
                            provider: localCfg.provider,
                            model: localCfg.model,
                            apiKey: localCfg.apiKey || (config.providers as any)?.[localCfg.provider]?.apiKey || '',
                            baseUrl: localCfg.baseUrl,
                            temperature: localCfg.temperature,
                            maxTokens: localCfg.maxTokens,
                        });
                        agentManager.updateLLM(llm);
                        agentRunner = createAgentLoopRunner({ llm, tools });
                        log.info('已切换到本地 LLM 配置');
                    }
                    send(client, { type: 'config.llm-source', id: message.id, payload: { source: llmSource } });
                    break;
                }
                case 'config.get-llm-source':
                    send(client, {
                        type: 'config.llm-source',
                        id: message.id,
                        payload: {
                            source: llmSource,
                            managed: managedLlmConfig ? {
                                available: true,
                                provider: managedLlmConfig.provider,
                                model: managedLlmConfig.model,
                                quota: managedLlmConfig.quota,
                            } : { available: false },
                        },
                    });
                    break;
                case 'setup.complete':
                    await handleSetupComplete(client, message);
                    break;
                case 'setup.skip': {
                    // 用户跳过引导设置：内存标记 + 文件持久化
                    setupSkipped = true;
                    try {
                        const cfgPath = join(workspace, 'server-config.json');
                        if (!existsSync(cfgPath)) {
                            writeFileSync(cfgPath, JSON.stringify({ _setupSkipped: true, providers: {} }, null, 2), 'utf-8');
                            log.info('用户跳过首次设置，已创建标记文件');
                        }
                        send(client, { type: 'setup.skipped', id: message.id, payload: { message: '已跳过设置' } });
                    } catch (err) {
                        log.error('跳过设置标记失败', err);
                        send(client, { type: 'setup.error', id: message.id, payload: { message: '标记失败' } });
                    }
                    break;
                }
                case 'debug.subscribe':
                    client.debugSubscribed = true;
                    console.log(`[DEBUG] 客户端 ${client.id} 订阅 debug 日志, clients=${clients.size}`);
                    log.info(`客户端 ${client.id} 订阅 debug 日志`);
                    break;
                case 'debug.unsubscribe':
                    client.debugSubscribed = false;
                    log.info(`客户端 ${client.id} 取消订阅 debug 日志`);
                    break;
                case 'mcp.client.register':
                    handleClientMcpRegister(client, message);
                    break;
                case 'mcp.client.unregister':
                    handleClientMcpUnregister(client);
                    break;
                case 'mcp.client.result':
                    handleClientMcpResult(message);
                    break;
                case 'memory.stats':
                    handleMemoryStats(client, message);
                    break;
                case 'memory.list':
                    handleMemoryList(client, message);
                    break;
                case 'memory.search':
                    await handleMemorySearch(client, message);
                    break;
                case 'memory.add':
                    await handleMemoryAdd(client, message);
                    break;
                case 'memory.delete':
                    handleMemoryDelete(client, message);
                    break;
                case 'memory.clear':
                    handleMemoryClear(client, message);
                    break;
                // 蒸馏系统消息
                case 'distillation.stats':
                    handleDistillationStats(client, message);
                    break;
                case 'distillation.graph':
                    handleDistillationGraph(client, message);
                    break;
                case 'distillation.config.update':
                    handleDistillationConfigUpdate(client, message);
                    break;
                case 'distillation.trigger':
                    await handleDistillationTrigger(client, message);
                    break;
                case 'distillation.cards':
                    handleDistillationCards(client, message);
                    break;
                case 'distillation.card.delete':
                    handleDistillationCardDelete(client, message);
                    break;
                // OpenFlux 云端消息
                case 'openflux.login':
                    await handleOpenFluxLogin(client, message);
                    break;
                case 'openflux.logout':
                    await handleOpenFluxLogout(client, message);
                    break;
                case 'openflux.status':
                    handleOpenFluxStatus(client, message);
                    break;
                case 'openflux.agents':
                    await handleOpenFluxAgents(client, message);
                    break;
                case 'openflux.agent-info':
                    await handleOpenFluxAgentInfo(client, message);
                    break;
                case 'openflux.chat-history':
                    await handleOpenFluxChatHistory(client, message);
                    break;
                // OpenFluxRouter 消息
                case 'router.config.get':
                    handleRouterConfigGet(client, message);
                    break;
                case 'router.config.update':
                    handleRouterConfigUpdate(client, message);
                    break;
                case 'router.send':
                    handleRouterSend(client, message);
                    break;
                case 'router.test':
                    handleRouterTest(client, message);
                    break;
                case 'router.bind':
                    handleRouterBind(client, message);
                    break;
                // Voice 语音服务消息
                case 'voice.synthesize':
                    await handleVoiceSynthesize(client, message);
                    break;
                case 'voice.transcribe':
                    await handleVoiceTranscribe(client, message);
                    break;
                case 'voice.get-voices':
                    await handleVoiceGetVoices(client, message);
                    break;
                case 'voice.set-voice':
                    await handleVoiceSetVoice(client, message);
                    break;
                case 'voice.get-status':
                    handleVoiceGetStatus(client, message);
                    break;
                default:
                    send(client, { type: 'error', payload: { message: `未知消息类型: ${message.type}` } });
            }
        } catch (error) {
            log.error('处理消息失败', { error });
            send(client, { type: 'error', payload: { message: '消息处理失败' } });
        }
    }

    /**
     * 认证
     */
    function handleAuth(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { token?: string } | undefined;
        if (payload?.token === token) {
            client.authenticated = true;
            send(client, { type: 'auth.success' });
        } else {
            send(client, { type: 'auth.failed' });
        }
    }

    /**
     * 聊天（核心，支持文件附件）
     */
    async function handleChat(client: GatewayClient, message: GatewayMessage): Promise<void> {
        const payload = message.payload as {
            input: string;
            sessionId?: string;
            attachments?: Array<{ path: string; name: string; size: number; ext: string }>;
            source?: 'local' | 'cloud';
            chatroomId?: number;
        };
        const messageId = message.id || crypto.randomUUID();

        // 云端 Agent 聊天：走 OpenFlux 桥接器
        if (payload?.source === 'cloud' && payload?.chatroomId) {
            await handleCloudChat(client, message, payload, messageId);
            return;
        }

        if (!payload?.input && !payload?.attachments?.length) {
            send(client, { type: 'error', payload: { message: '缺少 input' } });
            return;
        }

        send(client, { type: 'chat.start', id: messageId });

        try {
            const output = await executeAgent(
                payload.input || '',
                payload.sessionId,
                (event) => {
                    // 推送进度事件给客户端（携带 sessionId 支持多会话并发）
                    send(client, {
                        type: 'chat.progress',
                        id: messageId,
                        payload: { ...event, sessionId: payload.sessionId },
                    });
                },
                payload.attachments
            );

            send(client, {
                type: 'chat.complete',
                id: messageId,
                payload: { output, sessionId: payload.sessionId },
            });
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            send(client, {
                type: 'chat.error',
                id: messageId,
                payload: { message: errorMsg },
            });
        }
    }

    /**
     * 会话列表
     */
    function handleSessionsList(client: GatewayClient, message: GatewayMessage): void {
        const sessionList = sessions.list();
        send(client, { type: 'sessions.list', id: message.id, payload: { sessions: sessionList } });
    }

    /**
     * 会话消息
     */
    function handleSessionsMessages(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { sessionId: string };
        const messages = sessions.getMessages(payload.sessionId);
        send(client, { type: 'sessions.messages', id: message.id, payload: { messages } });
    }

    /**
     * 会话日志
     */
    function handleSessionsLogs(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { sessionId: string };
        const logs = sessions.getLogs(payload.sessionId);
        send(client, { type: 'sessions.logs', id: message.id, payload: { logs } });
    }

    /**
     * 创建会话
     */
    function handleSessionsCreate(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { title?: string; cloudChatroomId?: number; cloudAgentName?: string };
        const session = sessions.create('default', payload?.title, payload?.cloudChatroomId, payload?.cloudAgentName);
        send(client, { type: 'sessions.create', id: message.id, payload: { session } });
    }

    /**
     * 删除会话
     */
    function handleSessionsDelete(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { sessionId: string };
        if (!payload?.sessionId) {
            send(client, { type: 'error', id: message.id, payload: { message: '缺少 sessionId' } });
            return;
        }
        sessions.delete(payload.sessionId);
        send(client, { type: 'sessions.delete', id: message.id, payload: { success: true } });
    }

    /**
     * 获取会话成果物
     */
    function handleSessionsArtifacts(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { sessionId: string };
        const artifacts = sessions.getArtifacts(payload.sessionId);
        send(client, { type: 'sessions.artifacts', id: message.id, payload: { artifacts } });
    }

    /**
     * 保存会话成果物
     */
    function handleSessionsArtifactsSave(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { sessionId: string; artifact: any };
        const saved = sessions.addArtifact(payload.sessionId, payload.artifact);
        send(client, { type: 'sessions.artifacts.save', id: message.id, payload: { artifact: saved } });
    }

    // ========================
    // Scheduler 消息处理
    // ========================

    function handleSchedulerList(client: GatewayClient, message: GatewayMessage): void {
        const tasks = scheduler.listTasks();
        send(client, { type: 'scheduler.list', id: message.id, payload: { tasks } });
    }

    function handleSchedulerRuns(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { taskId?: string; limit?: number } | undefined;
        const runs = scheduler.getRuns(payload?.taskId, payload?.limit || 50);
        send(client, { type: 'scheduler.runs', id: message.id, payload: { runs } });
    }

    function handleSchedulerPause(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { taskId: string };
        const ok = scheduler.pauseTask(payload.taskId);
        send(client, { type: 'scheduler.pause', id: message.id, payload: { success: ok } });
    }

    function handleSchedulerResume(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { taskId: string };
        const ok = scheduler.resumeTask(payload.taskId);
        send(client, { type: 'scheduler.resume', id: message.id, payload: { success: ok } });
    }

    function handleSchedulerDelete(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { taskId: string };
        const ok = scheduler.deleteTask(payload.taskId);
        send(client, { type: 'scheduler.delete', id: message.id, payload: { success: ok } });
    }

    async function handleSchedulerTrigger(client: GatewayClient, message: GatewayMessage): Promise<void> {
        const payload = message.payload as { taskId: string };
        const run = await scheduler.triggerTask(payload.taskId);
        send(client, { type: 'scheduler.trigger', id: message.id, payload: { run } });
    }

    // ========================
    // Memory 消息处理
    // ========================

    function handleMemoryStats(client: GatewayClient, message: GatewayMessage): void {
        if (!memoryManager) {
            send(client, { type: 'memory.stats', id: message.id, payload: { enabled: false } });
            return;
        }
        const stats = memoryManager.getStats();
        send(client, { type: 'memory.stats', id: message.id, payload: { enabled: true, ...stats } });
    }

    function handleMemoryList(client: GatewayClient, message: GatewayMessage): void {
        if (!memoryManager) {
            send(client, { type: 'memory.list', id: message.id, payload: { items: [], total: 0, page: 1, pageSize: 20 } });
            return;
        }
        const payload = message.payload as { page?: number; pageSize?: number } | undefined;
        const result = memoryManager.list(payload?.page || 1, payload?.pageSize || 20);
        send(client, { type: 'memory.list', id: message.id, payload: result });
    }

    async function handleMemorySearch(client: GatewayClient, message: GatewayMessage): Promise<void> {
        if (!memoryManager) {
            send(client, { type: 'memory.search', id: message.id, payload: { items: [] } });
            return;
        }
        const payload = message.payload as { query: string; limit?: number };
        const items = await memoryManager.search(payload.query, { limit: payload.limit || 10 });
        send(client, { type: 'memory.search', id: message.id, payload: { items } });
    }

    function handleMemoryDelete(client: GatewayClient, message: GatewayMessage): void {
        if (!memoryManager) {
            send(client, { type: 'memory.delete', id: message.id, payload: { success: false } });
            return;
        }
        const payload = message.payload as { id: string };
        const ok = memoryManager.delete(payload.id);
        send(client, { type: 'memory.delete', id: message.id, payload: { success: ok } });
    }

    function handleMemoryClear(client: GatewayClient, message: GatewayMessage): void {
        if (!memoryManager) {
            send(client, { type: 'memory.clear', id: message.id, payload: { success: false } });
            return;
        }
        memoryManager.clear();
        send(client, { type: 'memory.clear', id: message.id, payload: { success: true } });
    }

    async function handleMemoryAdd(client: GatewayClient, message: GatewayMessage): Promise<void> {
        if (!memoryManager) {
            send(client, { type: 'memory.add', id: message.id, payload: { success: false, error: '记忆系统未启用' } });
            return;
        }
        const payload = message.payload as { content: string; tags?: string[] };
        if (!payload?.content) {
            send(client, { type: 'memory.add', id: message.id, payload: { success: false, error: '缺少 content 参数' } });
            return;
        }
        try {
            const entry = await memoryManager.add(payload.content, { tags: payload.tags });
            send(client, { type: 'memory.add', id: message.id, payload: { success: true, id: entry.id } });
        } catch (error: any) {
            send(client, { type: 'memory.add', id: message.id, payload: { success: false, error: error.message || String(error) } });
        }
    }

    // ========================
    // 蒸馏系统消息处理
    // ========================

    function handleDistillationStats(client: GatewayClient, message: GatewayMessage): void {
        const cardManager = memoryManager ? (memoryManager as any)._cardManager : null;
        const scheduler = memoryManager ? (memoryManager as any)._distillScheduler : null;
        if (!cardManager) {
            send(client, { type: 'distillation.stats', id: message.id, payload: { available: false } });
            return;
        }
        const stats = cardManager.getStats();
        const schedulerStatus = scheduler?.getStatus?.() || {};
        const config = cardManager.getConfig();
        send(client, {
            type: 'distillation.stats', id: message.id, payload: {
                available: true,
                ...stats,
                scheduler: schedulerStatus,
                config,
            }
        });
    }

    function handleDistillationGraph(client: GatewayClient, message: GatewayMessage): void {
        const cardManager = memoryManager ? (memoryManager as any)._cardManager : null;
        if (!cardManager) {
            send(client, { type: 'distillation.graph', id: message.id, payload: { cards: [], relations: [], topics: [] } });
            return;
        }
        try {
            const db = (cardManager as any).db;
            // 查询全部卡片 (限制 200 张避免过大)
            const cards = db.prepare(
                'SELECT card_id, topic_id, layer, summary, quality_score, created_at, tags FROM memory_cards ORDER BY created_at DESC LIMIT 200'
            ).all().map((r: any) => ({
                id: r.card_id,
                topicId: r.topic_id,
                layer: r.layer,
                summary: r.summary,
                quality: r.quality_score,
                createdAt: r.created_at,
                tags: r.tags ? JSON.parse(r.tags) : [],
            }));
            // 查询全部关系
            const relations = db.prepare(
                'SELECT source_card_id, target_card_id, relation_type FROM card_relations'
            ).all().map((r: any) => ({
                source: r.source_card_id,
                target: r.target_card_id,
                type: r.relation_type,
            }));
            // 查询全部主题
            const topics = cardManager.listTopics();
            send(client, { type: 'distillation.graph', id: message.id, payload: { cards, relations, topics } });
        } catch (err) {
            log.error('获取蒸馏图数据失败', { error: String(err) });
            send(client, { type: 'distillation.graph', id: message.id, payload: { cards: [], relations: [], topics: [] } });
        }
    }

    function handleDistillationConfigUpdate(client: GatewayClient, message: GatewayMessage): void {
        const cardManager = memoryManager ? (memoryManager as any)._cardManager : null;
        const scheduler = memoryManager ? (memoryManager as any)._distillScheduler : null;
        if (!cardManager) {
            send(client, { type: 'distillation.config.update', id: message.id, payload: { success: false, message: '蒸馏系统未初始化' } });
            return;
        }
        try {
            const payload = message.payload as Record<string, any>;
            cardManager.updateConfig(payload);
            if (scheduler?.updateConfig) {
                scheduler.updateConfig(payload);
            }
            send(client, { type: 'distillation.config.update', id: message.id, payload: { success: true } });
        } catch (err) {
            send(client, { type: 'distillation.config.update', id: message.id, payload: { success: false, message: String(err) } });
        }
    }

    async function handleDistillationTrigger(client: GatewayClient, message: GatewayMessage): Promise<void> {
        const scheduler = memoryManager ? (memoryManager as any)._distillScheduler : null;
        if (!scheduler) {
            log.warn('手动蒸馏失败: scheduler 不存在', { hasMemory: !!memoryManager, hasCardManager: !!(memoryManager as any)?._cardManager });
            send(client, { type: 'distillation.trigger', id: message.id, payload: { success: false, message: '蒸馏系统未初始化' } });
            return;
        }
        try {
            log.info('⚡ 手动触发蒸馏...');
            await scheduler.triggerManual();
            log.info('⚡ 手动蒸馏完成');
            send(client, { type: 'distillation.trigger', id: message.id, payload: { success: true } });
        } catch (err) {
            log.error('⚡ 手动蒸馏失败', { error: String(err), stack: (err as any)?.stack });
            send(client, { type: 'distillation.trigger', id: message.id, payload: { success: false, message: String(err) } });
        }
    }

    function handleDistillationCards(client: GatewayClient, message: GatewayMessage): void {
        const cardManager = memoryManager ? (memoryManager as any)._cardManager : null;
        if (!cardManager) {
            send(client, { type: 'distillation.cards', id: message.id, payload: { cards: [], total: 0 } });
            return;
        }
        try {
            const { layer, limit = 100, offset = 0 } = (message.payload || {}) as any;
            const db = (cardManager as any).db;
            let query: string;
            let params: any[];
            if (layer && ['Micro', 'Mini', 'Macro'].includes(layer)) {
                query = 'SELECT c.*, t.title as topic_title FROM memory_cards c LEFT JOIN memory_topics t ON c.topic_id = t.topic_id WHERE c.layer = ? ORDER BY c.created_at DESC LIMIT ? OFFSET ?';
                params = [layer, limit, offset];
            } else {
                query = 'SELECT c.*, t.title as topic_title FROM memory_cards c LEFT JOIN memory_topics t ON c.topic_id = t.topic_id ORDER BY c.created_at DESC LIMIT ? OFFSET ?';
                params = [limit, offset];
            }
            const rows = db.prepare(query).all(...params) as any[];
            // 总数
            let countQuery: string;
            let countParams: any[];
            if (layer && ['Micro', 'Mini', 'Macro'].includes(layer)) {
                countQuery = 'SELECT COUNT(*) as c FROM memory_cards WHERE layer = ?';
                countParams = [layer];
            } else {
                countQuery = 'SELECT COUNT(*) as c FROM memory_cards';
                countParams = [];
            }
            const total = (db.prepare(countQuery).get(...countParams) as any).c;
            const cards = rows.map((r: any) => ({
                id: r.card_id,
                topicId: r.topic_id,
                topicTitle: r.topic_title || '未分类',
                layer: r.layer,
                summary: r.summary,
                qualityScore: r.quality_score,
                tags: r.tags ? JSON.parse(r.tags) : [],
                createdAt: r.created_at,
                updatedAt: r.updated_at,
            }));
            send(client, { type: 'distillation.cards', id: message.id, payload: { cards, total } });
        } catch (err) {
            log.error('获取卡片列表失败', { error: String(err) });
            send(client, { type: 'distillation.cards', id: message.id, payload: { cards: [], total: 0 } });
        }
    }

    function handleDistillationCardDelete(client: GatewayClient, message: GatewayMessage): void {
        const cardManager = memoryManager ? (memoryManager as any)._cardManager : null;
        if (!cardManager) {
            send(client, { type: 'distillation.card.delete', id: message.id, payload: { success: false, message: '卡片系统未初始化' } });
            return;
        }
        try {
            const { cardId } = (message.payload || {}) as any;
            if (!cardId) {
                send(client, { type: 'distillation.card.delete', id: message.id, payload: { success: false, message: '缺少 cardId' } });
                return;
            }
            const ok = cardManager.deleteCard(cardId);
            send(client, { type: 'distillation.card.delete', id: message.id, payload: { success: ok } });
        } catch (err) {
            log.error('删除卡片失败', { error: String(err) });
            send(client, { type: 'distillation.card.delete', id: message.id, payload: { success: false, message: String(err) } });
        }
    }

    // ========================
    // Voice 语音服务消息处理
    // ========================

    async function handleVoiceSynthesize(client: GatewayClient, message: GatewayMessage): Promise<void> {
        const payload = message.payload as { text: string };
        if (!ttsService?.isAvailable()) {
            send(client, { type: 'voice.synthesize', id: message.id, payload: { error: 'TTS 服务不可用' } });
            return;
        }
        try {
            const audioBuffer = await ttsService.synthesize(payload.text);
            // 将 Buffer 转为 base64 传输
            const base64Audio = audioBuffer.toString('base64');
            send(client, { type: 'voice.synthesize', id: message.id, payload: { audio: base64Audio } });
        } catch (err: any) {
            send(client, { type: 'voice.synthesize', id: message.id, payload: { error: err.message || '语音合成失败' } });
        }
    }

    async function handleVoiceTranscribe(client: GatewayClient, message: GatewayMessage): Promise<void> {
        const payload = message.payload as { audio: string }; // base64 WAV
        if (!sttService?.isAvailable()) {
            send(client, { type: 'voice.transcribe', id: message.id, payload: { error: 'STT 服务不可用' } });
            return;
        }
        try {
            const buffer = Buffer.from(payload.audio, 'base64');
            const result = await sttService.transcribe(buffer);
            send(client, { type: 'voice.transcribe', id: message.id, payload: { text: result.text, elapsed: result.elapsed } });
        } catch (err: any) {
            send(client, { type: 'voice.transcribe', id: message.id, payload: { error: err.message || '语音识别失败' } });
        }
    }

    async function handleVoiceGetVoices(client: GatewayClient, message: GatewayMessage): Promise<void> {
        if (!ttsService) {
            send(client, { type: 'voice.get-voices', id: message.id, payload: [] });
            return;
        }
        try {
            const voices = await ttsService.getVoices();
            send(client, { type: 'voice.get-voices', id: message.id, payload: voices });
        } catch {
            send(client, { type: 'voice.get-voices', id: message.id, payload: [] });
        }
    }

    async function handleVoiceSetVoice(client: GatewayClient, message: GatewayMessage): Promise<void> {
        const payload = message.payload as { voice: string };
        if (!ttsService) {
            send(client, { type: 'voice.set-voice', id: message.id, payload: { error: 'TTS 服务未初始化' } });
            return;
        }
        try {
            await ttsService.setVoice(payload.voice);
            send(client, { type: 'voice.set-voice', id: message.id, payload: { success: true } });
        } catch (err: any) {
            send(client, { type: 'voice.set-voice', id: message.id, payload: { error: err.message } });
        }
    }

    function handleVoiceGetStatus(client: GatewayClient, message: GatewayMessage): void {
        send(client, {
            type: 'voice.get-status',
            id: message.id,
            payload: {
                stt: {
                    enabled: voiceConfig?.stt?.enabled ?? false,
                    available: sttService?.isAvailable() ?? false,
                },
                tts: {
                    enabled: voiceConfig?.tts?.enabled ?? false,
                    available: ttsService?.isAvailable() ?? false,
                    voice: voiceConfig?.tts?.voice || 'zh-CN-XiaoxiaoNeural',
                    autoPlay: voiceConfig?.tts?.autoPlay ?? false,
                },
            },
        });
    }

    // ========================
    // OpenFlux 云端消息处理
    // ========================

    async function handleOpenFluxLogin(client: GatewayClient, message: GatewayMessage): Promise<void> {
        const payload = message.payload as { username: string; password: string };
        if (!payload?.username || !payload?.password) {
            send(client, { type: 'openflux.login', id: message.id, payload: { success: false, message: '缺少用户名或密码' } });
            return;
        }
        const result = await openfluxBridge.login(payload.username, payload.password);
        send(client, { type: 'openflux.login', id: message.id, payload: result });
    }

    async function handleOpenFluxLogout(client: GatewayClient, message: GatewayMessage): Promise<void> {
        await openfluxBridge.logout();
        send(client, { type: 'openflux.logout', id: message.id, payload: { success: true } });
    }

    function handleOpenFluxStatus(client: GatewayClient, message: GatewayMessage): void {
        const status = openfluxBridge.getStatus();
        send(client, { type: 'openflux.status', id: message.id, payload: status });
    }

    async function handleOpenFluxAgents(client: GatewayClient, message: GatewayMessage): Promise<void> {
        try {
            const agents = await openfluxBridge.getAgentList();
            send(client, { type: 'openflux.agents', id: message.id, payload: { agents } });
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            send(client, { type: 'openflux.agents', id: message.id, payload: { agents: [], error: msg } });
        }
    }

    async function handleOpenFluxAgentInfo(client: GatewayClient, message: GatewayMessage): Promise<void> {
        const payload = message.payload as { appId: number };
        try {
            const agent = await openfluxBridge.getAgentInfo(payload.appId);
            send(client, { type: 'openflux.agent-info', id: message.id, payload: { agent } });
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            send(client, { type: 'openflux.agent-info', id: message.id, payload: { agent: null, error: msg } });
        }
    }

    async function handleOpenFluxChatHistory(client: GatewayClient, message: GatewayMessage): Promise<void> {
        const payload = message.payload as { chatroomId: number; page?: number; pageSize?: number };
        try {
            const messages = await openfluxBridge.getChatHistory(payload.chatroomId, payload.page, payload.pageSize);
            send(client, { type: 'openflux.chat-history', id: message.id, payload: { messages } });
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            send(client, { type: 'openflux.chat-history', id: message.id, payload: { messages: [], error: msg } });
        }
    }

    /**
     * 云端 Agent 聊天（通过 OpenFlux WebSocket 桥接）
     */
    async function handleCloudChat(
        client: GatewayClient,
        message: GatewayMessage,
        payload: { input: string; sessionId?: string; chatroomId?: number },
        messageId: string,
    ): Promise<void> {
        if (!payload.chatroomId) {
            send(client, { type: 'chat.error', id: messageId, payload: { message: '缺少 chatroomId' } });
            return;
        }

        log.info('Cloud 聊天开始', {
            sessionId: payload.sessionId?.slice(0, 8),
            chatroomId: payload.chatroomId,
            inputLength: payload.input?.length,
        });

        send(client, { type: 'chat.start', id: messageId });

        // 在 progress 回调中独立收集 token（不依赖 openfluxBridge.chat 的 resolve）
        const collectedTokens: string[] = [];
        let lastTokenTime = Date.now();

        try {
            // 保存用户消息到本地会话
            if (payload.sessionId) {
                sessions.addMessage(payload.sessionId, {
                    role: 'user',
                    content: payload.input,
                });
            }

            const output = await openfluxBridge.chat(
                payload.chatroomId,
                payload.input,
                (event: OpenFluxChatProgressEvent) => {
                    // 收集 token 内容
                    if (event.type === 'token' && event.token) {
                        collectedTokens.push(event.token);
                        lastTokenTime = Date.now();
                    }
                    send(client, {
                        type: 'chat.progress',
                        id: messageId,
                        payload: { ...event, sessionId: payload.sessionId },
                    });
                },
            );

            // openfluxBridge.chat 正常 resolve — 使用其返回的 output
            const finalOutput = output || collectedTokens.join('');
            saveCloudAssistantMessage(payload.sessionId, finalOutput);

            send(client, {
                type: 'chat.complete',
                id: messageId,
                payload: { output: finalOutput, sessionId: payload.sessionId },
            });
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            log.error('Cloud 聊天异常', { error: errorMsg });

            // 如果已经收集到了回复内容，仍然保存助手消息
            const fallbackOutput = collectedTokens.join('');
            if (fallbackOutput.length > 0) {
                log.info('Cloud 聊天异常但有收集到回复，尝试保存');
                saveCloudAssistantMessage(payload.sessionId, fallbackOutput);
                // 发送 complete（而非 error），因为用户已看到了回复
                send(client, {
                    type: 'chat.complete',
                    id: messageId,
                    payload: { output: fallbackOutput, sessionId: payload.sessionId },
                });
            } else {
                send(client, {
                    type: 'chat.error',
                    id: messageId,
                    payload: { message: errorMsg },
                });
            }
        }
    }

    /** 保存 Cloud 助手消息到本地会话 */
    function saveCloudAssistantMessage(sessionId: string | undefined, output: string): void {
        if (!sessionId || !output) return;
        try {
            sessions.addMessage(sessionId, {
                role: 'assistant',
                content: output,
            });
            const updatedMeta = sessions.get(sessionId);
            log.info('Cloud 助手消息已保存', {
                sessionId: sessionId.slice(0, 8),
                title: updatedMeta?.title,
                messageCount: updatedMeta?.messageCount,
            });
        } catch (e) {
            log.error('Cloud 助手消息保存失败', { error: e instanceof Error ? e.message : String(e) });
        }
    }

    // ========================
    // OpenFluxRouter 消息处理
    // ========================


    function handleRouterConfigGet(client: GatewayClient, message: GatewayMessage): void {
        const status = routerBridge.getStatus();
        // 重启后 routerSessionId 为 null，主动搜索已有 Router 会话
        if (!routerSessionId) {
            const allSessions = sessions.list();
            const existing = allSessions.find(s => s.title === 'Router 消息');
            if (existing) routerSessionId = existing.id;
        }
        const sessionId = routerSessionId || null;
        send(client, {
            type: 'router.config.get',
            id: message.id,
            payload: { ...status, sessionId },
        });
    }

    function handleRouterConfigUpdate(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as Partial<RouterConfig> | undefined;
        if (!payload) {
            send(client, { type: 'router.config.update', id: message.id, payload: { success: false, message: '缺少配置' } });
            return;
        }

        try {
            // 合并配置
            const currentConfig = routerBridge.getRawConfig() || { url: '', appId: '', appType: 'openflux', apiKey: '', appUserId: '', enabled: false };
            const newConfig: RouterConfig = {
                url: payload.url ?? currentConfig.url,
                appId: payload.appId ?? currentConfig.appId,
                appType: payload.appType ?? currentConfig.appType,
                apiKey: payload.apiKey ?? currentConfig.apiKey,
                appUserId: payload.appUserId ?? currentConfig.appUserId ?? '',
                enabled: payload.enabled ?? currentConfig.enabled,
            };

            // 保存到内存 config
            (config as any).router = newConfig;
            // 持久化
            saveServerConfig(workspace, config);

            // 更新连接
            routerBridge.updateConfig(newConfig);

            log.info('Router 配置已更新', { url: newConfig.url, appId: newConfig.appId, enabled: newConfig.enabled });
            send(client, { type: 'router.config.update', id: message.id, payload: { success: true } });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            send(client, { type: 'router.config.update', id: message.id, payload: { success: false, message: msg } });
        }
    }

    function handleRouterSend(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as RouterOutboundMessage | undefined;
        if (!payload?.platform_type || !payload?.platform_id || !payload?.platform_user_id || !payload?.content) {
            send(client, { type: 'router.send', id: message.id, payload: { success: false, message: '消息字段不完整' } });
            return;
        }

        const ok = routerBridge.send(payload);
        send(client, { type: 'router.send', id: message.id, payload: { success: ok } });
    }

    async function handleRouterTest(client: GatewayClient, message: GatewayMessage): Promise<void> {
        try {
            const payload = message.payload as Partial<RouterConfig> | undefined;
            const result = await routerBridge.testConnection(payload || {});
            send(client, { type: 'router.test', id: message.id, payload: result });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            send(client, { type: 'router.test', id: message.id, payload: { success: false, message: msg } });
        }
    }

    /** 处理 Router 绑定请求 */
    function handleRouterBind(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { code?: string } | undefined;
        const code = payload?.code?.trim();
        if (!code) {
            send(client, { type: 'router.bind', id: message.id, payload: { success: false, message: '配对码不能为空' } });
            return;
        }
        const ok = routerBridge.bind(code);
        send(client, { type: 'router.bind', id: message.id, payload: { success: ok, message: ok ? '绑定命令已发送' : 'Router 未连接' } });
    }

    // ========================
    // Settings 消息处理
    // ========================

    function handleSettingsGet(client: GatewayClient, message: GatewayMessage): void {
        const defaultOutputPath = join(workspace, 'output');
        send(client, {
            type: 'settings.current',
            id: message.id,
            payload: {
                outputPath: runtimeSettings.outputPath,
                defaultOutputPath,
            },
        });
    }

    function handleSettingsUpdate(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { outputPath?: string | null } | undefined;

        if (payload) {
            if (payload.outputPath === null || payload.outputPath === undefined) {
                // 重置为默认值
                runtimeSettings.outputPath = join(workspace, 'output');
            } else if (typeof payload.outputPath === 'string' && payload.outputPath.trim()) {
                runtimeSettings.outputPath = payload.outputPath.trim();
            }

            // 确保目录存在
            if (!existsSync(runtimeSettings.outputPath)) {
                try { mkdirSync(runtimeSettings.outputPath, { recursive: true }); } catch { /* ignore */ }
            }

            // 持久化
            saveSettings(workspace, runtimeSettings);
            log.info('设置已更新', { outputPath: runtimeSettings.outputPath });
        }

        send(client, {
            type: 'settings.updated',
            id: message.id,
            payload: { outputPath: runtimeSettings.outputPath },
        });
    }

    // ========================
    // Server Config 消息处理
    // ========================

    /**
     * 脱敏 API Key（仅展示前8位和后4位）
     */
    function maskApiKey(key?: string): string {
        if (!key) return '';
        if (key.startsWith('${') && key.endsWith('}')) return key; // 环境变量占位符
        if (key.length <= 12) return '****';
        return key.slice(0, 8) + '****' + key.slice(-4);
    }

    function handleConfigGet(client: GatewayClient, message: GatewayMessage): void {
        // 构建供应商信息（脱敏 key）
        const providersInfo: Record<string, { apiKey?: string; baseUrl?: string; masked?: boolean }> = {};
        const knownProviders = ['anthropic', 'openai', 'minimax', 'deepseek', 'zhipu', 'moonshot', 'ollama', 'google', 'custom'];

        for (const name of knownProviders) {
            const p = config.providers?.[name];
            if (p) {
                providersInfo[name] = {
                    apiKey: maskApiKey(p.apiKey),
                    baseUrl: p.baseUrl,
                    masked: true,
                };
            } else {
                providersInfo[name] = {};
            }
        }

        send(client, {
            type: 'config.current',
            id: message.id,
            payload: {
                providers: providersInfo,
                llm: {
                    orchestration: {
                        provider: config.llm.orchestration.provider,
                        model: config.llm.orchestration.model,
                    },
                    execution: {
                        provider: config.llm.execution.provider,
                        model: config.llm.execution.model,
                    },
                    embedding: config.llm.embedding ? {
                        provider: (config.llm.embedding as any).provider || 'local',
                        model: config.llm.embedding.model || '',
                    } : undefined,
                    fallback: config.llm.fallback ? {
                        provider: config.llm.fallback.provider,
                        model: config.llm.fallback.model,
                    } : undefined,
                },
                web: {
                    search: {
                        provider: config.web?.search?.provider || 'brave',
                        apiKey: maskApiKey(config.web?.search?.apiKey),
                        maxResults: config.web?.search?.maxResults ?? 5,
                    },
                    fetch: {
                        readability: config.web?.fetch?.readability ?? true,
                        maxChars: config.web?.fetch?.maxChars ?? 50000,
                    },
                },
                mcp: {
                    servers: (config.mcp?.servers || []).map(s => {
                        const connectedInfo = mcpManager.getServerInfo().find(si => si.name === s.name);
                        return {
                            name: s.name,
                            location: s.location || 'server',
                            transport: s.transport || 'stdio',
                            command: s.command,
                            args: s.args,
                            url: s.url,
                            env: s.env,
                            enabled: s.enabled !== false,
                            toolCount: connectedInfo?.toolCount ?? 0,
                            status: connectedInfo ? 'connected' as const : (s.enabled === false ? 'disconnected' as const : 'error' as const),
                        };
                    }),
                },
                gatewayMode: config.remote?.enabled ? 'remote' : 'embedded',
                gatewayPort: config.remote?.port || 18801,
                agents: {
                    globalAgentName: config.agents?.globalAgentName || '',
                    globalSystemPrompt: config.agents?.globalSystemPrompt || '',
                    skills: config.agents?.skills || [],
                    list: (config.agents?.list || []).map((a: any) => ({
                        id: a.id,
                        name: a.name || a.id,
                        description: a.description || '',
                        model: a.model ? { provider: a.model.provider, model: a.model.model } : undefined,
                    })),
                },
                sandbox: config.sandbox ? {
                    mode: config.sandbox.mode || 'local',
                    docker: config.sandbox.docker ? {
                        image: config.sandbox.docker.image || 'openflux-sandbox',
                        memoryLimit: config.sandbox.docker.memoryLimit || '512m',
                        cpuLimit: config.sandbox.docker.cpuLimit || '1',
                        networkMode: config.sandbox.docker.networkMode || 'none',
                    } : undefined,
                    blockedExtensions: config.sandbox.blockedExtensions || [],
                } : undefined,
                presetModels: (config as any).presetModels || undefined,
            },
        });
    }

    /**
     * 首次启动设置向导完成
     */
    async function handleSetupComplete(client: GatewayClient, message: GatewayMessage): Promise<void> {
        const payload = message.payload as {
            provider?: string;
            apiKey?: string;
            baseUrl?: string;
            model?: string;
            agentName?: string;
            agentPrompt?: string;
            router?: {
                enabled?: boolean;
                url?: string;
                appId?: string;
                appSecret?: string;
            };
        } | undefined;

        if (!payload || !payload.provider || !payload.apiKey) {
            send(client, { type: 'setup.error', id: message.id, payload: { message: '缺少必要配置（供应商和 API Key）' } });
            return;
        }

        try {
            // 更新 config 对象
            if (!config.providers) config.providers = {};
            config.providers[payload.provider] = {
                apiKey: payload.apiKey,
                ...(payload.baseUrl ? { baseUrl: payload.baseUrl } : {}),
            };

            const modelName = payload.model || 'claude-sonnet-4-20250514';
            config.llm.orchestration.provider = payload.provider as any;
            config.llm.orchestration.model = modelName;
            config.llm.orchestration.apiKey = payload.apiKey;
            // 切换 provider 时必须重新解析 baseUrl，避免旧 provider 的 URL 残留导致 404
            config.llm.orchestration.baseUrl = payload.baseUrl || config.providers?.[payload.provider]?.baseUrl || undefined;
            config.llm.execution.provider = payload.provider as any;
            config.llm.execution.model = modelName;
            config.llm.execution.apiKey = payload.apiKey;
            config.llm.execution.baseUrl = payload.baseUrl || config.providers?.[payload.provider]?.baseUrl || undefined;

            // Agent 设置
            if (payload.agentName || payload.agentPrompt) {
                if (!config.agents) config.agents = { list: [{ id: 'default', default: true, name: '通用助手' }] } as any;
                if (payload.agentName) config.agents!.globalAgentName = payload.agentName;
                if (payload.agentPrompt) config.agents!.globalSystemPrompt = payload.agentPrompt;
            }

            // Router 设置
            if (payload.router?.enabled) {
                const routerConfig = {
                    url: payload.router.url || '',
                    appId: payload.router.appId || '',
                    appType: 'openflux' as const,
                    apiKey: payload.router.appSecret || '',  // 向导中的 appSecret 对应 RouterConfig 的 apiKey
                    appUserId: '',
                    enabled: true,
                };
                (config as any).router = routerConfig;
                // 立即连接 Router，使托管 LLM 配置在首次设置后即可用（无需重启）
                routerBridge.updateConfig(routerConfig);
            }

            // 保存到 server-config.json
            saveServerConfig(workspace, config);

            // 重新创建 LLM Provider，更新 agentManager
            try {
                const newOrchLLM = createLLMProvider({
                    provider: config.llm.orchestration.provider as any,
                    model: config.llm.orchestration.model,
                    apiKey: config.llm.orchestration.apiKey || '',
                    baseUrl: config.llm.orchestration.baseUrl,
                    temperature: config.llm.orchestration.temperature,
                    maxTokens: config.llm.orchestration.maxTokens,
                });
                const newExecLLM = createLLMProvider({
                    provider: config.llm.execution.provider as any,
                    model: config.llm.execution.model,
                    apiKey: config.llm.execution.apiKey || '',
                    baseUrl: config.llm.execution.baseUrl,
                    temperature: config.llm.execution.temperature,
                    maxTokens: config.llm.execution.maxTokens,
                });
                agentManager.updateLLM(newOrchLLM, newExecLLM);
                agentRunner = createAgentLoopRunner({ llm: newOrchLLM, tools });
                log.info('首次设置完成，LLM Provider 已创建');
            } catch (llmErr) {
                log.warn('LLM 重新创建失败，可能需要重启', { error: String(llmErr) });
            }

            send(client, { type: 'setup.success', id: message.id, payload: { message: '设置完成' } });
        } catch (err) {
            log.error('首次设置保存失败', err);
            send(client, { type: 'setup.error', id: message.id, payload: { message: '保存失败: ' + String(err) } });
        }
    }

    async function handleConfigUpdate(client: GatewayClient, message: GatewayMessage): Promise<void> {
        const payload = message.payload as {
            providers?: Record<string, { apiKey?: string; baseUrl?: string }>;
            orchestration?: { provider?: string; model?: string };
            execution?: { provider?: string; model?: string };
            embedding?: { provider?: string; model?: string };
            web?: {
                search?: { provider?: string; apiKey?: string; maxResults?: number };
                fetch?: { readability?: boolean; maxChars?: number };
            };
            mcp?: {
                servers?: Array<{
                    name: string;
                    transport: 'stdio' | 'sse';
                    command?: string;
                    args?: string[];
                    url?: string;
                    env?: Record<string, string>;
                    enabled?: boolean;
                }>;
            };
            agents?: {
                globalAgentName?: string;
                globalSystemPrompt?: string;
                skills?: Array<{ id: string; title: string; content: string; enabled: boolean }>;
                list?: Array<{ id: string; model?: { provider: string; model: string } | null }>;
            };
            sandbox?: {
                mode?: string;
                docker?: {
                    image?: string;
                    memoryLimit?: string;
                    cpuLimit?: string;
                    networkMode?: string;
                };
                blockedExtensions?: string[];
            };
        } | undefined;

        if (!payload) {
            send(client, { type: 'config.error', id: message.id, payload: { message: '缺少更新内容' } });
            return;
        }

        try {
            let needRecreateLLM = false;
            let needRecreateEmbedding = false;

            // 1. 更新供应商密钥（写入内存 config）
            if (payload.providers) {
                if (!config.providers) config.providers = {};
                for (const [name, updates] of Object.entries(payload.providers)) {
                    if (!config.providers[name]) config.providers[name] = {};
                    if (updates.apiKey !== undefined) {
                        config.providers[name].apiKey = updates.apiKey;
                    }
                    if (updates.baseUrl !== undefined) {
                        config.providers[name].baseUrl = updates.baseUrl;
                    }
                }
                // 重新合并 provider 配置到 llm
                const mergeProvider = (llmCfg: any) => {
                    const pc = config.providers?.[llmCfg.provider];
                    if (pc) {
                        if (pc.apiKey) llmCfg.apiKey = pc.apiKey;
                        if (pc.baseUrl && !llmCfg.baseUrl) llmCfg.baseUrl = pc.baseUrl;
                    }
                };
                mergeProvider(config.llm.orchestration);
                mergeProvider(config.llm.execution);
                if (config.llm.fallback) mergeProvider(config.llm.fallback);
                needRecreateLLM = true;
            }

            // 2. 更新编排模型
            if (payload.orchestration) {
                if (payload.orchestration.provider) {
                    (config.llm.orchestration as any).provider = payload.orchestration.provider;
                }
                if (payload.orchestration.model) {
                    config.llm.orchestration.model = payload.orchestration.model;
                }
                // 合并 provider 配置
                const pc = config.providers?.[(config.llm.orchestration as any).provider];
                if (pc) {
                    if (pc.apiKey) config.llm.orchestration.apiKey = pc.apiKey;
                    if (pc.baseUrl) config.llm.orchestration.baseUrl = pc.baseUrl;
                }
                needRecreateLLM = true;
            }

            // 3. 更新执行模型
            if (payload.execution) {
                if (payload.execution.provider) {
                    (config.llm.execution as any).provider = payload.execution.provider;
                }
                if (payload.execution.model) {
                    config.llm.execution.model = payload.execution.model;
                }
                const pc = config.providers?.[(config.llm.execution as any).provider];
                if (pc) {
                    if (pc.apiKey) config.llm.execution.apiKey = pc.apiKey;
                    if (pc.baseUrl) config.llm.execution.baseUrl = pc.baseUrl;
                }
                needRecreateLLM = true;
            }

            // 4. 更新 Web 搜索与获取配置
            if (payload.web) {
                if (!config.web) config.web = {};
                if (payload.web.search) {
                    if (!config.web.search) {
                        config.web.search = {
                            provider: 'brave' as const,
                            maxResults: 5,
                            timeoutSeconds: 30,
                            cacheTtlMinutes: 15,
                        };
                    }
                    if (payload.web.search.provider) {
                        (config.web.search as any).provider = payload.web.search.provider;
                    }
                    if (payload.web.search.apiKey !== undefined) {
                        config.web.search!.apiKey = payload.web.search.apiKey;
                    }
                    if (payload.web.search.maxResults !== undefined) {
                        config.web.search!.maxResults = payload.web.search.maxResults;
                    }
                }
                if (payload.web.fetch) {
                    if (!config.web.fetch) {
                        config.web.fetch = {
                            readability: true,
                            maxChars: 50000,
                            timeoutSeconds: 30,
                            cacheTtlMinutes: 15,
                        };
                    }
                    if (payload.web.fetch.readability !== undefined) {
                        config.web.fetch!.readability = payload.web.fetch.readability;
                    }
                    if (payload.web.fetch.maxChars !== undefined) {
                        config.web.fetch!.maxChars = payload.web.fetch.maxChars;
                    }
                }
                log.info('Web 搜索/获取配置已更新', {
                    searchProvider: config.web.search?.provider,
                    maxResults: config.web.search?.maxResults,
                });
            }

            // 5. 更新 MCP Server 配置（仅处理 location='server' 的）
            if (payload.mcp?.servers !== undefined) {
                const serverSideMcp = payload.mcp.servers.filter(s => (s as any).location !== 'client');
                config.mcp = {
                    servers: serverSideMcp.map(s => ({
                        ...s,
                        location: (s as any).location || 'server' as const,
                        enabled: s.enabled !== false,
                        timeout: 30,
                    })),
                };
                log.info('MCP 配置已更新', { serverCount: serverSideMcp.length });

                // 热重载 MCP 连接（仅 server 端）
                try {
                    // 移除旧的 MCP 工具
                    const oldMcpTools = mcpManager.getTools();
                    for (const t of oldMcpTools) {
                        tools.unregister(t.name);
                    }

                    // 关闭旧连接
                    await mcpManager.shutdown();

                    // 重新连接
                    if (payload.mcp.servers.length > 0) {
                        await mcpManager.initialize(payload.mcp.servers);
                        for (const t of mcpManager.getTools()) {
                            tools.register(t);
                        }
                        const serverInfo = mcpManager.getServerInfo();
                        log.info(`MCP 热重载完成: ${serverInfo.map(s => `${s.name}(${s.toolCount})`).join(', ')}`);
                    }
                } catch (error) {
                    log.error('MCP 热重载失败:', { error });
                }
            }

            // 5. 更新 Embedding 模型
            if (payload.embedding) {
                if (!config.llm.embedding) {
                    config.llm.embedding = { provider: 'openai', model: 'text-embedding-3-small' };
                }
                if (payload.embedding.provider) (config.llm.embedding as any).provider = payload.embedding.provider;
                if (payload.embedding.model) config.llm.embedding.model = payload.embedding.model;
                needRecreateEmbedding = true;
            }

            // 6. 更新全局角色设定、技能和 Agent 模型
            if (payload.agents?.globalAgentName !== undefined || payload.agents?.globalSystemPrompt !== undefined || payload.agents?.skills !== undefined || payload.agents?.list !== undefined) {
                if (!config.agents) {
                    config.agents = { list: [{ id: 'default', default: true, name: '通用助手' }] };
                }
                if (payload.agents.globalAgentName !== undefined) {
                    config.agents.globalAgentName = payload.agents.globalAgentName || undefined;
                }
                if (payload.agents.globalSystemPrompt !== undefined) {
                    config.agents.globalSystemPrompt = payload.agents.globalSystemPrompt || undefined;
                }
                if (payload.agents.skills !== undefined) {
                    config.agents.skills = payload.agents.skills;
                }
                // 更新 Agent 自定义模型
                if (payload.agents.list && config.agents.list) {
                    for (const update of payload.agents.list) {
                        const agent = config.agents.list.find(a => a.id === update.id);
                        if (agent) {
                            if (update.model) {
                                agent.model = {
                                    provider: update.model.provider as any,
                                    model: update.model.model,
                                };
                            } else {
                                agent.model = undefined; // 清除自定义模型，回退到全局
                            }
                        }
                    }
                }
                // 清除 AgentManager 上下文缓存使新配置生效
                agentManager.updateLLM(agentManager['options'].defaultLLM);
                log.info('全局角色设定/技能/Agent模型已更新');
            }

            // 6.5 更新沙盒配置
            if (payload.sandbox) {
                if (!config.sandbox) {
                    (config as any).sandbox = { mode: 'local', maxWriteSize: 50 * 1024 * 1024 };
                }
                const sb = config.sandbox!;
                if (payload.sandbox.mode) {
                    sb.mode = payload.sandbox.mode as any;
                }
                if (payload.sandbox.docker) {
                    sb.docker = {
                        timeout: sb.docker?.timeout || 60,
                        ...sb.docker,
                        image: payload.sandbox.docker.image || sb.docker?.image || 'openflux-sandbox',
                        memoryLimit: payload.sandbox.docker.memoryLimit || sb.docker?.memoryLimit || '512m',
                        cpuLimit: payload.sandbox.docker.cpuLimit || sb.docker?.cpuLimit || '1',
                        networkMode: (payload.sandbox.docker.networkMode || sb.docker?.networkMode || 'none') as any,
                    };
                }
                if (payload.sandbox.blockedExtensions) {
                    sb.blockedExtensions = payload.sandbox.blockedExtensions;
                }
                log.info('沙盒配置已更新', { mode: sb.mode });
            }

            // 7. 持久化到 settings.json（服务端配置部分）
            saveServerConfig(workspace, config);

            // 5. 如需重建 LLM Provider，更新 agentManager
            if (needRecreateLLM) {
                try {
                    const newOrchLLM = createLLMProvider({
                        provider: config.llm.orchestration.provider as any,
                        model: config.llm.orchestration.model,
                        apiKey: config.llm.orchestration.apiKey || '',
                        baseUrl: config.llm.orchestration.baseUrl,
                        temperature: config.llm.orchestration.temperature,
                        maxTokens: config.llm.orchestration.maxTokens,
                    });
                    const newExecLLM = createLLMProvider({
                        provider: config.llm.execution.provider as any,
                        model: config.llm.execution.model,
                        apiKey: config.llm.execution.apiKey || '',
                        baseUrl: config.llm.execution.baseUrl,
                        temperature: config.llm.execution.temperature,
                        maxTokens: config.llm.execution.maxTokens,
                    });
                    agentManager.updateLLM(newOrchLLM, newExecLLM);
                    // 同步重建定时任务使用的 agentRunner
                    agentRunner = createAgentLoopRunner({ llm: newOrchLLM, tools });
                    log.info('LLM Provider 已热更新（含定时任务 Runner）', {
                        orchestration: `${config.llm.orchestration.provider}/${config.llm.orchestration.model}`,
                        execution: `${config.llm.execution.provider}/${config.llm.execution.model}`,
                    });
                } catch (err) {
                    log.error('LLM Provider 热更新失败:', err);
                }
            }

            // 7. 如需重建 Embedding LLM
            if (needRecreateEmbedding && memoryManager && config.memory?.enabled && config.llm.embedding) {
                try {
                    // 模型 → 向量维度映射
                    const MODEL_DIM_MAP: Record<string, number> = {
                        'Xenova/bge-m3': 1024,
                        'Xenova/bge-small-zh-v1.5': 512,
                        'Xenova/paraphrase-multilingual-MiniLM-L12-v2': 384,
                        'text-embedding-3-small': 1536,
                        'text-embedding-3-large': 3072,
                        'text-embedding-ada-002': 1536,
                    };
                    const { provider, model } = config.llm.embedding;
                    let dim = MODEL_DIM_MAP[model] || (provider === 'local' ? 1024 : 1536);

                    config.memory.vectorDim = dim;
                    // 再次保存以更新 vectorDim
                    saveServerConfig(workspace, config);

                    const embConfig = config.llm.embedding;
                    const embApiKey = embConfig.apiKey || process.env[`${embConfig.provider.toUpperCase()}_API_KEY`] || '';

                    const newEmbeddingLLM = createLLMProvider({
                        provider: embConfig.provider as any,
                        model: embConfig.model,
                        apiKey: embApiKey,
                        baseUrl: embConfig.baseUrl,
                    });

                    memoryManager.updateLLM(newEmbeddingLLM);
                    memoryManager.updateConfig({
                        dbPath: join(workspace, '.memory', config.memory.dbName),
                        vectorDim: dim,
                        embeddingModel: model,
                        debug: config.memory.debug,
                    });

                    // 同步更新卡片系统的 embeddingLLM
                    if ((memoryManager as any)._cardManager) {
                        (memoryManager as any)._cardManager.updateEmbeddingLLM(newEmbeddingLLM);
                    }

                    log.info('Embedding LLM 已更新', { provider, model, dim });
                } catch (err) {
                    log.error('Embedding LLM 更新失败:', err);
                }
            }

            send(client, {
                type: 'config.updated',
                id: message.id,
                payload: { success: true, message: '配置已保存并生效' },
            });
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log.error('更新服务端配置失败:', err);
            send(client, {
                type: 'config.error',
                id: message.id,
                payload: { success: false, message: errMsg },
            });
        }
    }

    // ========================
    // 客户端 MCP 代理
    // ========================

    /** 等待客户端工具调用结果的 Promise Map */
    const pendingClientCalls = new Map<string, {
        resolve: (result: { success: boolean; data?: unknown; error?: string }) => void;
        reject: (error: Error) => void;
    }>();

    /**
     * 处理客户端注册 MCP 工具
     */
    function handleClientMcpRegister(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }> };

        // 先清理旧的代理工具
        if (client.clientMcpToolNames?.length) {
            for (const name of client.clientMcpToolNames) {
                tools.unregister(name);
            }
        }

        const toolNames: string[] = [];

        for (const toolDef of payload.tools) {
            // 将客户端工具定义转为代理 Tool
            const proxyTool: Tool = {
                name: toolDef.name,
                description: `[客户端] ${toolDef.description}`,
                parameters: convertClientParams(toolDef.parameters),
                async execute(args: Record<string, unknown>): Promise<ToolResult> {
                    // 通过 WebSocket 转发到客户端执行
                    const callId = crypto.randomUUID();
                    return new Promise((resolve, reject) => {
                        pendingClientCalls.set(callId, { resolve, reject });

                        send(client, {
                            type: 'mcp.client.call',
                            id: callId,
                            payload: { tool: toolDef.name, args },
                        });

                        // 60 秒超时
                        setTimeout(() => {
                            if (pendingClientCalls.has(callId)) {
                                pendingClientCalls.delete(callId);
                                resolve({ success: false, error: '客户端工具调用超时（60s）' });
                            }
                        }, 60000);
                    });
                },
            };

            tools.register(proxyTool);
            toolNames.push(toolDef.name);
        }

        client.clientMcpToolNames = toolNames;
        log.info(`客户端 ${client.id} 注册了 ${toolNames.length} 个 MCP 代理工具: ${toolNames.join(', ')}`);
    }

    /**
     * 处理客户端取消注册 MCP 工具
     */
    function handleClientMcpUnregister(client: GatewayClient): void {
        if (client.clientMcpToolNames?.length) {
            for (const name of client.clientMcpToolNames) {
                tools.unregister(name);
            }
            log.info(`客户端 ${client.id} 移除了 ${client.clientMcpToolNames.length} 个代理工具`);
            client.clientMcpToolNames = [];
        }
    }

    /**
     * 处理客户端返回的 MCP 工具执行结果
     */
    function handleClientMcpResult(message: GatewayMessage): void {
        if (!message.id) return;

        const pending = pendingClientCalls.get(message.id);
        if (!pending) {
            log.warn(`收到未知的客户端 MCP 结果: ${message.id}`);
            return;
        }

        pendingClientCalls.delete(message.id);
        const payload = message.payload as { success: boolean; result?: { success: boolean; data?: unknown; error?: string }; error?: string };

        if (payload.success && payload.result) {
            pending.resolve(payload.result);
        } else {
            pending.resolve({ success: false, error: payload.error || '客户端工具调用失败' });
        }
    }

    /**
     * 将客户端参数定义转为 ToolParameter 格式
     */
    function convertClientParams(params: Record<string, unknown>): Record<string, ToolParameter> {
        const result: Record<string, ToolParameter> = {};
        const props = (params as any)?.properties || {};
        const required = (params as any)?.required || [];

        for (const [key, schema] of Object.entries(props)) {
            const s = schema as any;
            result[key] = {
                type: s.type || 'string',
                description: s.description || key,
                required: required.includes(key),
                ...(s.enum ? { enum: s.enum } : {}),
            };
        }
        return result;
    }

    /**
     * 发送消息
     */
    function send(client: GatewayClient, message: GatewayMessage): void {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify(message));
        }
    }

    log.info('独立 Gateway 初始化完成');

    return {
        start(): Promise<void> {
            return new Promise((resolve) => {
                wss = new WebSocketServer({ port });
                wss.on('connection', handleConnection);
                wss.on('listening', () => {
                    log.info(`独立 Gateway 启动: ws://localhost:${port}`);
                    resolve();
                });
            });
        },

        async stop(): Promise<void> {
            scheduler.stop();
            openfluxBridge.destroy();
            routerBridge.destroy();
            await mcpManager.shutdown();
            return new Promise((resolve) => {
                if (wss) {
                    wss.close(() => {
                        log.info('独立 Gateway 停止');
                        resolve();
                    });
                } else {
                    resolve();
                }
            });
        },

        getSessionStore: () => sessions,
    };
}

/**
 * 启动独立 Gateway（命令行入口）
 */
export async function startStandaloneGateway(): Promise<void> {
    const gateway = await createStandaloneGateway();
    await gateway.start();

    // 优雅退出
    process.on('SIGINT', async () => {
        log.info('收到退出信号...');
        await gateway.stop();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        log.info('收到终止信号...');
        await gateway.stop();
        process.exit(0);
    });
}
