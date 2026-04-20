/**
 * 独立 Gateway Server
 * 内置 Agent Loop，客户端通过 WebSocket 连接
 */

// @ts-ignore - 运行时有 ws 模块
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, resolve as resolvePath } from 'path';
import { loadConfig } from '../config/loader';
import { ToolRegistry } from '../tools/registry';
import type { Tool, ToolResult, ToolParameter } from '../tools/types';
import { createSpawnTool } from '../tools/spawn';
import { createLLMProvider } from '../llm/factory';
import { LLMError } from '../llm/llm-error';
import { createAgentLoopRunner } from '../agent/loop';
import { createSubAgentExecutor } from '../agent/subagent';
import { AgentManager } from '../agent/manager';
import { UserAgentStore } from '../agent/user-agent-store';
import { SessionStore } from '../sessions';
import { WorkflowEngine } from '../workflow';
import { Scheduler, SchedulerStore } from '../scheduler';
import type { SchedulerEvent, ScheduledTaskMeta } from '../scheduler';
import { Logger, onLogBroadcast, type LogEntry } from '../utils/logger';
// ── 重型模块：懒加载（减少启动内存） ──────────────────────────
// 以下模块在 createStandaloneGateway() 内按需 await import() 加载
// 仅保留 type import（零运行时开销）
import type { McpServerConfig } from '../tools/mcp-client';
import type { OpenFluxChatProgressEvent, AtlasOpenFluxRuntime } from './openflux-chat-bridge';
import type { RouterConfig, RouterInboundMessage, RouterOutboundMessage, ManagedRuntimeConfigMessage } from './router-bridge';
import type { ForgeSuggestion } from '../evolution';

// Value imports 延迟加载，类型占位
type McpClientManagerT = import('../tools/mcp-client').McpClientManager;
type MemoryManagerT = import('../agent/memory/manager').MemoryManager;
type OpenFluxChatBridgeT = import('./openflux-chat-bridge').OpenFluxChatBridge;
type RouterBridgeT = import('./router-bridge').RouterBridge;
type WeixinBridgeT = import('./weixin-bridge').WeixinBridge;
type WeixinConfigT = import('./weixin-bridge').WeixinConfig;
type TTSServiceT = import('../main/voice/tts').TTSService;
type STTServiceT = import('../main/voice/stt').STTService;
type EvolutionDataManagerT = import('../evolution').EvolutionDataManager;
type SkillForgeT = import('../evolution').SkillForge;

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
        console.error('[Settings] Save failed:', err);
    }
}

function saveServerConfig(workspace: string, config: any, localProvidersOverride?: Record<string, any>): void {
    const configPath = join(workspace, 'server-config.json');
    try {
        const data: Record<string, unknown> = {
            providers: localProvidersOverride || config.providers || {},
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
            language: config.language || 'zh-CN',
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
        // 保存 MCP 配置
        if (config.mcp) {
            data.mcp = config.mcp;
        }
        // 保存预置模型列表
        if (config.presetModels) {
            data.presetModels = config.presetModels;
        }
        writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
        console.error('[ServerConfig] Save failed:', err);
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
            // embedding 已固定为本地模型，不从 saved settings 恢复
            // if (saved.llm.embedding) { ... }
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

        // 合并 MCP 配置
        if (saved.mcp) {
            config.mcp = { ...config.mcp, ...saved.mcp };
        }

        // 合并预置模型列表
        if (saved.presetModels) {
            config.presetModels = saved.presetModels;
        }

        // Restore language setting
        if (saved.language) {
            config.language = saved.language;
        }

        // 合并 providers 后，将 provider 的 apiKey/baseUrl 重新同步到 llm 配置
        // 解决 loader.ts 的 mergeProvider 在 mergeServerConfig 之前执行导致的覆盖问题
        if (config.providers) {
            const syncProvider = (llmConfig: any) => {
                const providerConfig = config.providers?.[llmConfig.provider];
                if (providerConfig) {
                    if (providerConfig.apiKey) {
                        llmConfig.apiKey = providerConfig.apiKey;
                    }
                    if (providerConfig.baseUrl) {
                        llmConfig.baseUrl = providerConfig.baseUrl;
                    }
                }
            };
            syncProvider(config.llm.orchestration);
            syncProvider(config.llm.execution);
            if (config.llm.fallback) {
                syncProvider(config.llm.fallback);
            }
        }

        log.info('Merged UI settings from server-config.json');
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
    log.info('Standalone Gateway starting...');

    // ── 懒加载重模块（减少启动时内存占用） ──────────────
    const { McpClientManager } = await import('../tools/mcp-client');
    const { isPythonReady, ensureUv, getUvxPath } = await import('../utils/python-env');
    const { MemoryManager } = await import('../agent/memory/manager');
    const { createMemoryTool } = await import('../tools/memory');
    const { OpenFluxChatBridge } = await import('./openflux-chat-bridge');
    const { RouterBridge } = await import('./router-bridge');
    const { createNotifyTool } = await import('../tools/notify');
    const { TTSService } = await import('../main/voice/tts');
    const { STTService } = await import('../main/voice/stt');
    const { launchChromeWithDebugPort, getBrowserConnectionStatus, initBrowserProbe, cleanupScheduledPages } = await import('../tools/browser/index');
    const { decryptAPIKey } = await import('../utils/crypto');
    const { EvolutionDataManager, SkillForge, runMigrations } = await import('../evolution');
    const { createSkillStoreTool } = await import('../tools/skill-store');
    const { createToolForgeTool } = await import('../tools/tool-forge');
    log.info('Heavy modules lazy-loaded');

    // ── 定时强制 GC（需 --expose-gc 启动参数） ──────────────
    if (typeof globalThis.gc === 'function') {
        setInterval(() => {
            const before = process.memoryUsage();
            globalThis.gc!();
            const after = process.memoryUsage();
            const freed = ((before.heapUsed - after.heapUsed) / 1024 / 1024).toFixed(1);
            log.debug(`GC: freed ${freed}MB, heap ${(after.heapUsed / 1024 / 1024).toFixed(0)}/${(after.heapTotal / 1024 / 1024).toFixed(0)}MB, RSS ${(after.rss / 1024 / 1024).toFixed(0)}MB`);
        }, 60_000);
        log.info('Periodic GC enabled (every 60s)');
    } else {
        log.warn('global.gc not available, start with --expose-gc for periodic memory reclamation');
    }

    // 1. 加载配置
    const config = await loadConfig();
    const workspace = config.workspace || '.';
    // 合并 UI 保存的配置（server-config.json → config）
    mergeServerConfig(workspace, config);
    const port = config.remote?.port || 18801;
    const token = config.remote?.token;
    log.info('Configuration loaded');

    // 2. 加载运行时设置（输出目录等）
    const runtimeSettings = loadSettings(workspace);
    // 确保输出目录存在
    if (!existsSync(runtimeSettings.outputPath)) {
        try { mkdirSync(runtimeSettings.outputPath, { recursive: true }); } catch { /* ignore */ }
    }
    log.info('Runtime settings loaded', { outputPath: runtimeSettings.outputPath });

    // 2.6 初始化用户 Agent 存储
    const defaultAgentName = config.agents?.globalAgentName || 'OpenFlux Assistant';
    const userAgentStore = new UserAgentStore(workspace, defaultAgentName);

    // 2.5 初始化 Voice 服务（TTS + STT）
    let ttsService: TTSServiceT | null = null;
    let sttService: STTServiceT | null = null;
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
            log.info('TTS service initialized');
        } catch (err) {
            log.warn('TTS initialization failed (voice synthesis unavailable)', { error: String(err) });
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
            log.info('STT service initialized');
        } catch (err) {
            log.warn('STT initialization failed (speech recognition unavailable)', { error: String(err) });
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
        log.warn(`LLM initialization skipped (API Key not configured), waiting for setup: ${err}`);
    }

    // 3.1 初始化 Fallback LLM（备用模型，主 LLM 内容审核/限流/不可用时自动切换）
    let fallbackLlm: any = null;
    if (config.llm.fallback) {
        try {
            const fbConfig = config.llm.fallback;
            fallbackLlm = createLLMProvider({
                provider: fbConfig.provider,
                model: fbConfig.model,
                apiKey: fbConfig.apiKey || '',
                baseUrl: fbConfig.baseUrl,
                temperature: fbConfig.temperature,
                maxTokens: fbConfig.maxTokens || llmConfig.maxTokens,
            });
            log.info(`Fallback LLM Provider: ${fbConfig.provider}/${fbConfig.model}`);
        } catch (err) {
            log.warn(`Fallback LLM initialization failed: ${err}`);
        }
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
                        log.info(`Task first run, session created: "${task.name}" → ${session.id}`);
                    }
                } catch (e) {
                    log.error('Failed to create session for scheduled task:', e);
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

    // 活跃执行追踪（支持多会话并发）
    // key: sessionId, value: 执行状态
    const activeExecutions = new Map<string, { startedAt: number }>();
    /** 活跃的 AbortController（用于用户主动停止任务），key = sessionId */
    const activeAbortControllers = new Map<string, AbortController>();
    // Per-session 执行队列：同一 session 的请求自动排队，对用户透明
    const sessionExecutionChains = new Map<string, Promise<unknown>>();
    // 当前执行中的 sessionId（用于 process.spawn 关联，多并发时指向最近启动的）
    let currentExecutingSessionId: string | undefined;

    tools.registerDefaults({
        process: {
            cwd: () => runtimeSettings.outputPath,
            allowedCommands: config.sandbox?.allowedCommands,
            allowedCwdPaths: [...allowedCwdPaths],
            docker: config.sandbox?.mode === 'docker' ? config.sandbox.docker : undefined,
            getSessionId: () => currentExecutingSessionId,
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
        scheduler: { scheduler, getSessionId: () => currentExecutingSessionId },
        webSearch: {
            ...(config.web?.search || {}),
            getRuntimeOptions: () => {
                const routerCfg = (config as any).router as Partial<RouterConfig> | undefined;
                const routerUrl = routerCfg?.url;
                let baseUrl: string | undefined;
                if (routerUrl) {
                    try {
                        const parsed = new URL(routerUrl);
                        baseUrl = `${parsed.protocol === 'wss:' ? 'https:' : 'http:'}//${parsed.host}`;
                    } catch {
                        baseUrl = undefined;
                    }
                }

                return {
                    ...(config.web?.search || {}),
                    routing: managedRuntimeConfig?.routing,
                    routerProxy: {
                        baseUrl,
                        appId: routerCfg?.appId,
                        appUserId: routerCfg?.appUserId,
                        apiKey: routerCfg?.apiKey,
                    },
                };
            },
        },
        webFetch: config.web?.fetch,
    });
    log.info('Workflow engine initialized');

    // 3.6 验证 Python 环境
    try {
        const { logPythonEnvStatus } = await import('../utils/python-env');
        logPythonEnvStatus();
    } catch (e) {
        log.warn('Python environment module load failed (does not affect core functionality)');
    }

    // 3.8 初始化长期记忆
    let memoryManager: MemoryManagerT | undefined;
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
            let embeddingReady = true;
            if (config.llm.embedding) {
                const embConfig = config.llm.embedding;
                const embApiKey = embConfig.apiKey || process.env[`${embConfig.provider.toUpperCase()}_API_KEY`] || '';

                if (!embApiKey && embConfig.provider !== 'local') {
                    log.warn(`Embedding provider '${embConfig.provider}' missing API Key. Please configure in openflux.yaml or set env var ${embConfig.provider.toUpperCase()}_API_KEY. Long-term memory system will not initialize.`);
                    embeddingReady = false;
                } else {
                    embeddingLLM = createLLMProvider({
                        provider: embConfig.provider,
                        model: embConfig.model,
                        apiKey: embApiKey,
                        baseUrl: embConfig.baseUrl,
                    });
                    log.info(`Embedding LLM Configured: ${embConfig.provider}/${embConfig.model}`);
                }
            }

            if (embeddingReady) {
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
            log.info('Long-term memory system initialized');

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
                            log.debug('Micro card generation failed (does not affect core memory)', { error: String(err) });
                        });
                    }
                });

                // 将分层上下文检索注入到 AgentManager (通过扩展 memoryManager)
                (memoryManager as any)._cardManager = cardManager;
                (memoryManager as any)._distillScheduler = distillScheduler;

                log.info(`Memory distillation system initialized (${distillConfig.enabled ? 'enabled' : 'disabled'}, period: ${distillConfig.startTime}-${distillConfig.endTime})`);
            } catch (distillError) {
                log.warn('Memory distillation system initialization failed (does not affect basic memory)', { error: String(distillError) });
            }

            } // end if (embeddingReady)

        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            const errorStack = error instanceof Error ? error.stack : undefined;
            log.error('Long-term memory system initialization failed', { message: errorMsg, stack: errorStack });
        }
    }

    // 3.5 MCP 外部工具加载
    const mcpManager = new McpClientManager();

    // 注入内置 windows-mcp（内置 Python uvx 优先，fallback 系统 PATH）
    {
        const hasUserWindowsMcp = config.mcp?.servers?.some(
            (s: any) => s.name === 'windows-mcp'
        );
        if (!hasUserWindowsMcp) {
            let uvxCmd: string | null = null;

            // 优先：内置 Python 环境
            if (isPythonReady()) {
                const uvReady = await ensureUv();
                if (uvReady) uvxCmd = getUvxPath();
            }

            // Fallback：系统 PATH 中的 uvx
            if (!uvxCmd) {
                try {
                    const { execSync } = await import('child_process');
                    const result = execSync('where uvx', { timeout: 5000, encoding: 'utf-8', windowsHide: true }).trim();
                    if (result) {
                        uvxCmd = result.split('\n')[0].trim();
                        log.info('Using system uvx for windows-mcp', { uvxCmd });
                    }
                } catch { /* uvx not in PATH */ }
            }

            if (uvxCmd) {
                if (!config.mcp) config.mcp = { servers: [] };
                if (!config.mcp.servers) config.mcp.servers = [];
                config.mcp.servers.push({
                    name: 'windows-mcp',
                    transport: 'stdio',
                    command: uvxCmd,
                    args: ['windows-mcp'],
                    env: { ANONYMIZED_TELEMETRY: 'false' },
                    enabled: true,
                    timeout: 120,
                } as any);
                log.info('Built-in windows-mcp injected', { command: uvxCmd });
            }
        }
    }

    if (config.mcp?.servers?.length) {
        try {
            await mcpManager.initialize(config.mcp.servers as McpServerConfig[]);
            for (const tool of mcpManager.getTools()) {
                tools.register(tool);
            }
            const serverInfo = mcpManager.getServerInfo();
            log.info(`MCP tools registered: ${serverInfo.map(s => `${s.name}(${s.toolCount})`).join(', ')}`);
        } catch (error) {
            log.error('MCP initialization failed (does not affect core functionality):', { error });
        }
    }



    // 4. 添加 spawn 工具（AgentManager 会按需创建带限制的版本）
    const subAgentExecutor = createSubAgentExecutor({
        llm,
        tools,
        onComplete: (result) => {
            log.info('SubAgent completed: ${result.id}', { status: result.status });
        },
    });
    const spawnTool = createSpawnTool({
        defaultTimeout: 300,
        maxConcurrent: 5,
        onExecute: subAgentExecutor,
    });
    tools.register(spawnTool);

    // 4.5 初始化进化数据层 + 注册进化工具
    const evolutionData = new EvolutionDataManager(workspace);
    await evolutionData.initialize();
    await runMigrations(evolutionData);
    evolutionData.refreshStats();
    log.info('Evolution data layer initialized', { version: evolutionData.readManifest().schemaVersion });

    // 延迟引用：AgentManager 在后面创建，但回调在这里注册
    let agentManagerRef: AgentManager | null = null;

    // 注册 skill_store 工具
    const skillStoreTool = createSkillStoreTool({
        evolutionData,
        onSkillInstalled: (skill) => {
            agentManagerRef?.addSkill(skill);
            // 通知前端实时刷新
            broadcastToClients({ type: 'evolution.skills.updated' });
        },
        onSkillUninstalled: (skillId) => {
            agentManagerRef?.removeSkill(skillId);
            broadcastToClients({ type: 'evolution.skills.updated' });
        },
    });
    tools.register(skillStoreTool);

    // tool_forge 不再注册为 Agent 运行时工具
    // 工具创建应在任务完成后由用户主动触发，而非 Agent 执行期间自行创建
    // 保留 pendingConfirmations 供未来前端 post-task API 使用
    const pendingConfirmations = new Map<string, (approved: boolean) => void>();
    // 保留 toolForgeTool 实例供 WebSocket API 调用，但不注册到 Agent 工具列表
    const toolForgeTool = createToolForgeTool({
        evolutionData,
        onConfirmRequired: async (toolName, description, humanSummary, validation) => {
            const requestId = crypto.randomUUID();
            return new Promise<boolean>((resolve) => {
                const timer = setTimeout(() => {
                    if (pendingConfirmations.has(requestId)) {
                        pendingConfirmations.delete(requestId);
                        const autoApprove = validation.status === 'PASS';
                        log.info(`Tool "${toolName}" confirmation timed out, auto-${autoApprove ? 'approved' : 'rejected'}`);
                        resolve(autoApprove);
                    }
                }, 30000);

                pendingConfirmations.set(requestId, (approved: boolean) => {
                    clearTimeout(timer);
                    resolve(approved);
                });

                const msg = JSON.stringify({
                    type: 'evolution.confirm',
                    payload: {
                        requestId,
                        toolName,
                        description,
                        confirmMessage: humanSummary,
                        validationStatus: validation.status,
                    },
                });
                for (const c of clients.values()) {
                    if (c.authenticated && c.ws.readyState === WebSocket.OPEN) {
                        c.ws.send(msg);
                    }
                }
            });
        },
        onToolRegistered: (_tool) => {
            // 不再自动注册到 Agent 工具列表
            log.info(`Custom tool created (not registered to Agent): ${_tool.name}`);
        },
    });
    // 注意：不再执行 tools.register(toolForgeTool)

    // 自定义工具也不再自动注入 Agent 工具列表（避免 34+ 个 custom_* 工具消耗 LLM token）
    // Agent 已有 process 工具可直接执行任何脚本，无需预注册自定义工具
    const customToolCount = evolutionData.readManifest().stats.customTools;
    log.info(`Evolution: skills=${evolutionData.readManifest().stats.installedSkills}, custom_tools=${customToolCount} (not loaded into Agent)`);

    // 4.5 初始化 Skill Forge（L2 技能锻造分析器）
    let pendingSuggestion: ForgeSuggestion | null = null;
    const skillForge = new SkillForge({
        llm,
        dataManager: evolutionData,
        minToolCalls: 2,
        minMessageRounds: 3,
        onSuggestion: (suggestion) => {
            pendingSuggestion = suggestion;
            // 广播建议给所有在线客户端
            const msg = JSON.stringify({
                type: 'evolution.forge.suggest',
                payload: suggestion,
            });
            for (const c of clients.values()) {
                if (c.authenticated && c.ws.readyState === WebSocket.OPEN) {
                    c.ws.send(msg);
                }
            }
        },
    });
    log.info('SkillForge analyzer initialized');

    log.info(`Tools registered, total: ${tools.getToolNames().length}`);

    // 5. 初始化会话存储
    const sessions = new SessionStore({
        storePath: config.workspace,
    });
    log.info('Session store initialized');

    // 6. 创建 AgentManager（多 Agent 路由 + 工具过滤 + 执行）
    const agentManager = new AgentManager({
        config,
        tools,
        defaultLLM: llm,
        sessions,
        memoryManager,
        getOutputPath: () => runtimeSettings.outputPath,
        getUserAgents: () => userAgentStore.list().map(ua => ({
            id: ua.id,
            name: ua.name,
            description: ua.description,
            systemPrompt: ua.systemPrompt,
        })),
    });
    agentManagerRef = agentManager;

    // 6.1 启动加载：将已安装技能注入 AgentManager
    {
        const { parseSkillMd, toOpenFluxSkill } = await import('../tools/skill-store/parser');
        const installedSkills = evolutionData.listInstalledSkills();
        for (const meta of installedSkills) {
            const content = evolutionData.readSkillContent(meta.slug);
            if (content) {
                const parsed = parseSkillMd(content);
                agentManager.addSkill(toOpenFluxSkill(parsed));
            }
        }
        if (installedSkills.length > 0) {
            log.info(`Loaded ${installedSkills.length} installed skills into AgentManager`);
        }
    }

    // 7. 保留 agentRunner 给定时任务等内部场景使用（let 以支持热更新重建）
    let agentRunner = createAgentLoopRunner({ llm, fallbackLlm, tools, language: config.language });

    // 7.1 注册协作完成回调（announce 机制 → WebSocket 广播 + 历史注入）
    agentManager.setCollabOnComplete((session) => {
        // 广播给前端
        const event = {
            type: 'collaboration_result',
            sessionId: session.id,
            agentId: session.agentId,
            agentType: session.agentType || 'builtin',
            task: session.task,
            status: session.status,
            mode: session.mode,
            output: session.output?.slice(0, 2000),
            error: session.error,
            duration: session.endTime ? session.endTime - session.startTime : undefined,
        };
        // broadcastToClients is defined later; use setTimeout to defer
        setTimeout(() => {
            try {
                broadcastToClients(event);
            } catch (err) {
                log.error('Failed to broadcast collaboration_result', { error: err });
            }
        }, 0);

        // 将结果注入父 Agent 的 session（如果有 parentSessionId）
        if (session.parentSessionId) {
            const statusEmoji = session.status === 'completed' || session.status === 'idle' ? '✅' : session.status === 'timeout' ? '⏱️' : '❌';
            const announceMsg = [
                `${statusEmoji} Agent "${session.agentId}" ${session.status === 'completed' || session.status === 'idle' ? 'completed' : session.status} task`,
                session.output ? `\nResult:\n${session.output.slice(0, 1500)}` : '',
                session.error ? `\nError: ${session.error}` : '',
                session.endTime ? `\nDuration: ${((session.endTime - session.startTime) / 1000).toFixed(1)}s` : '',
            ].join('');

            try {
                sessions.addMessage(session.parentSessionId!, {
                    role: 'user',
                    content: `[Collaboration Announce] ${announceMsg}`,
                });
                log.info('Injected collaboration result into parent session', {
                    parentSession: session.parentSessionId,
                    childSession: session.id,
                });
            } catch (err) {
                log.error('Failed to inject collaboration result', { error: err });
            }
        }

        // 协作结果自动沉淀为 Micro 卡片（异步，不阻塞主流程）
        if (memoryManager && (memoryManager as any)._cardManager) {
            const cardMgr = (memoryManager as any)._cardManager;
            if (typeof cardMgr.distillCollaboration === 'function') {
                cardMgr.distillCollaboration({
                    agentId: session.agentId,
                    task: session.task,
                    output: session.output,
                    status: session.status,
                    sessionId: session.id,
                }).catch((err: any) => {
                    log.warn('Collaboration distillation failed (non-blocking)', { error: String(err) });
                });
            }
        }
    });

    const stripTrailingSlashes = (value: string): string => value.replace(/\/+$/, '');
    const nexusAiConfig = {
        apiUrl: stripTrailingSlashes(config.nexusai?.apiUrl || 'https://nexus-api.atyun.com'),
        wsUrl: stripTrailingSlashes(config.nexusai?.wsUrl || 'wss://nexus-chat.atyun.com'),
        atlasGatewayBaseUrl: stripTrailingSlashes(config.nexusai?.atlasGatewayBaseUrl || 'https://atlas-gateway.atyun.com/v1/atlas/model-egress'),
    };
    const buildAtlasGatewayUrl = (protocol: 'openai' | 'anthropic' | 'google' = 'openai'): string =>
        `${nexusAiConfig.atlasGatewayBaseUrl}/${protocol}`;

    // 8. 初始化 OpenFlux 云端聊天桥接器
    const openfluxBridge = new OpenFluxChatBridge(nexusAiConfig, join(process.cwd(), '.nexusai-token.json'));
    log.info('OpenFlux cloud bridge initialized');

    // 9. 初始化 OpenFluxRouter 桥接器
    const routerBridge = new RouterBridge();

    // Router 托管 LLM 配置（仅存内存）
    /** 解密后的托管运行配置（新协议） */
    interface ManagedRuntimeConfig {
        profiles: {
            orchestration: { provider: string; model: string };
            router?: { provider: string; model: string };
            subagent?: { provider: string; model: string };
        };
        providers: Record<string, { apiKey: string; baseUrl?: string }>;
        web?: {
            search?: {
                provider: string;
                apiKey?: string;
                maxResults?: number;
                timeoutSeconds?: number;
                cacheTtlMinutes?: number;
                perplexity?: { apiKey?: string; baseUrl?: string; model?: string };
            };
        };
        routing?: {
            modules?: Record<string, string>;
            providers?: Record<string, string>;
        };
        quota?: { daily_limit: number; used_today: number };
    }
    /** 旧协议单模型配置（兼容） */
    let managedLlmConfig: {
        provider: string;
        model: string;
        apiKey: string;
        baseUrl?: string;
        quota?: { daily_limit: number; used_today: number };
    } | null = null;
    let managedRuntimeConfig: ManagedRuntimeConfig | null = null;

    /** V2: 根据 Atlas 下发的 runtime 配置构建 LLM Provider */
    function buildAtlasLLM(
        runtime: AtlasOpenFluxRuntime,
        token: string,
        orchCfg: { temperature?: number; maxTokens?: number; model?: string },
    ) {
        const proto = runtime.chat.protocol; // 'openai' | 'anthropic' | 'google'
        const baseUrlMap: Record<string, string> = {
            openai: buildAtlasGatewayUrl('openai'),
            anthropic: buildAtlasGatewayUrl('anthropic'),
            google: buildAtlasGatewayUrl('google'),
        };
        const providerMap = {
            openai: 'openai' as const,
            anthropic: 'anthropic' as const,
            google: 'openai' as const, // Google 协议暂时走 openai SDK
        };
        return createLLMProvider({
            provider: providerMap[proto] || 'openai',
            model: runtime.chat.model_name || orchCfg.model || 'default',
            apiKey: token,
            baseUrl: baseUrlMap[proto] || baseUrlMap.openai,
            temperature: orchCfg.temperature,
            maxTokens: orchCfg.maxTokens,
        });
    }

    let llmSource: 'local' | 'managed' | 'atlas_managed' = 'local';
    // 本地 providers 快照：进入 managed/atlas 模式前保存，防止 Router key 污染 server-config.json
    let localProvidersSnapshot: Record<string, any> | null = null;
    // 持久化 llmSource 到文件，重启后自动恢复
    const llmSourceFile = join(process.cwd(), '.llm-source.json');
    try {
        if (existsSync(llmSourceFile)) {
            const saved = JSON.parse(readFileSync(llmSourceFile, 'utf-8'));
            if (saved.source === 'managed' || saved.source === 'local' || saved.source === 'atlas_managed') {
                // atlas_managed 需要 access_token，检查是否已恢复
                if (saved.source === 'atlas_managed') {
                    llmSource = 'atlas_managed';
                    if (openfluxBridge.getToken()) {
                        const atlasRt = openfluxBridge.getAtlasRuntime();
                        if (atlasRt?.chat) {
                            llm = buildAtlasLLM(atlasRt, openfluxBridge.getToken()!, config.llm.orchestration);
                            log.info('Restored atlas_managed mode with saved runtime config', {
                                protocol: atlasRt.chat.protocol,
                                model: atlasRt.chat.model_name,
                            });
                        } else {
                            // 没有 runtime 配置，回退 openai 协议
                            llm = createLLMProvider({
                                provider: 'openai',
                                model: config.llm.orchestration.model,
                                apiKey: openfluxBridge.getToken()!,
                                baseUrl: buildAtlasGatewayUrl('openai'),
                                temperature: config.llm.orchestration.temperature,
                                maxTokens: config.llm.orchestration.maxTokens,
                            });
                            log.info('Restored atlas_managed mode without runtime config (fallback openai)');
                        }
                        // 同步更新 agentManager / agentRunner / cardManager（它们在前面已初始化）
                        agentManager.updateLLM(llm);
                        agentRunner = createAgentLoopRunner({ llm, fallbackLlm, tools, language: config.language });
                        if (memoryManager && (memoryManager as any)._cardManager) {
                            (memoryManager as any)._cardManager.updateChatLLM(llm);
                        }
                    } else {
                        log.info('Restored atlas_managed mode without login state, waiting for re-auth');
                    }
                } else {
                    llmSource = saved.source;
                    log.info('Restored LLM source from file', { source: llmSource });
                }
            }
        }
    } catch { /* ignore */ }

    // 最近一次入站用户信息（用于 notify_user 工具）
    // 持久化到文件，重启后自动恢复
    const routerUserFile = join(process.cwd(), '.router-user.json');
    let lastRouterUser: { platform_type: string; platform_id: string; platform_user_id: string } | null = null;
    try {
        if (existsSync(routerUserFile)) {
            const data = JSON.parse(readFileSync(routerUserFile, 'utf-8'));
            if (data?.platform_type && data?.platform_id && data?.platform_user_id) {
                lastRouterUser = data;
                log.info('Restored last inbound user', { platform: data.platform_type, userId: data.platform_user_id });
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
        const routerSession = allSessions.find(s => s.title === 'Router Messages');
        if (routerSession) {
            routerSessionId = routerSession.id;
            log.info('Reusing existing Router session', { sessionId: routerSessionId });
            return routerSessionId;
        }
        // 3. 没找到则创建新的
        const session = sessions.create('default', 'Router Messages');
        routerSessionId = session.id;
        log.info('Created Router dedicated session', { sessionId: routerSessionId });
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
            log.error('Cannot download Router file: missing Router URL or API Key');
            return null;
        }

        // 本地存储目录: {workspace}/data/router-files/{date}/
        const date = new Date().toISOString().slice(0, 10);
        const localDir = join(config.workspace, 'data', 'router-files', date);
        mkdirSync(localDir, { recursive: true });

        const downloadUrl = `${baseUrl}/api/files/download?path=${encodeURIComponent(remotePath)}`;
        log.info('Downloading file from Router', { url: downloadUrl, fileName });

        try {
            const resp = await fetch(downloadUrl, {
                headers: { 'Authorization': `Bearer ${apiKey}` },
            });

            if (!resp.ok) {
                log.error('Router file download failed', { status: resp.status, statusText: resp.statusText });
                return null;
            }

            const buffer = Buffer.from(await resp.arrayBuffer());
            const localPath = join(localDir, fileName);
            const { writeFileSync: writeFile } = await import('fs');
            writeFile(localPath, buffer);

            log.info('Router file downloaded to local', { localPath, size: buffer.length });
            return { localPath, size: buffer.length };
        } catch (err) {
            log.error('Router file download error', { error: err instanceof Error ? err.message : String(err) });
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

                log.info('Received Router multimedia message', {
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
                    log.warn('Multimedia file download failed, falling back to text', { remotePath });
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
            log.info('Router inbound message sent to Agent', { from: userLabel, content: agentInput.slice(0, 80) });
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
                log.info('AI reply sent back to Router', { platform: msg.platform_type, userId: msg.platform_user_id });
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                broadcastToClients({
                    type: 'chat.error',
                    id: msgId,
                    payload: { message: errorMsg },
                });
                log.error('Router Agent processing failed', { error: errorMsg });

                // 回传友好的错误提示到平台用户
                const is429 = errorMsg.includes('429') || errorMsg.includes('overloaded') || errorMsg.includes('rate limit');
                const userFriendlyMsg = is429
                    ? '⏳ 当前 AI 服务繁忙，请稍后再试。'
                    : '⚠️ 处理您的消息时遇到了问题，请稍后重试。';
                routerBridge.send({
                    platform_type: msg.platform_type,
                    platform_id: msg.platform_id,
                    platform_user_id: msg.platform_user_id,
                    content_type: 'text',
                    content: userFriendlyMsg,
                });
            }
        };
    }

    // 客户端管理
    const clients = new Map<string, GatewayClient>();
    let wss: WebSocketServer | null = null;
    let setupSkipped = false;

    // RouterBridge 连接状态广播（需在 clients 初始化之后设置）
    routerBridge.onConnectionChange = (status) => {
        // 连接变化时重置 bound，等待 connect_status 推送实际状态
        if (status === 'connected') {
            (routerBridge as any).bound = false;
        }
        const rs = routerBridge.getStatus();
        const message = JSON.stringify({ type: 'router.status', payload: { connected: status === 'connected', status, bound: rs.bound } });
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
    routerBridge.onConnectStatus = (connectStatus) => {
        // 转换为 bind_result 格式让客户端统一处理
        const payload = connectStatus.bound
            ? { action: 'connect_status', status: 'matched', message: '已绑定', bound: true, platform_user_id: connectStatus.platform_user_id, platform_id: connectStatus.platform_id }
            : { action: 'connect_status', status: 'unbound', message: '未绑定', bound: false };
        const bindMsg = JSON.stringify({ type: 'router.bind_result', payload });
        // 同时推送 router.status 让前端更新绑定状态
        const statusMsg = JSON.stringify({ type: 'router.status', payload: { connected: true, status: 'connected', bound: connectStatus.bound } });
        for (const c of clients.values()) {
            if (c.authenticated && c.ws.readyState === WebSocket.OPEN) {
                c.ws.send(bindMsg);
                c.ws.send(statusMsg);
            }
        }
    };
    // RouterBridge QR 绑定码回调（广播给前端 UI 渲染二维码）
    routerBridge.onQRBindCode = (data) => {
        log.info('[QR] onQRBindCode callback fired', { status: (data as any).status, hasQrData: !!(data as any).qr_data, code: (data as any).code });
        const message = JSON.stringify({ type: 'router.qr_bind_code', payload: data });
        let sent = 0;
        for (const c of clients.values()) {
            if (c.authenticated && c.ws.readyState === WebSocket.OPEN) {
                c.ws.send(message);
                sent++;
            }
        }
        log.info('[QR] Broadcasted qr_bind_code to clients', { count: sent });
    };
    // RouterBridge QR 绑定成功回调（App 扫码完成，通知前端 UI）
    routerBridge.onQRBindSuccess = (data) => {
        log.info('[QR] onQRBindSuccess callback fired', data);
        const message = JSON.stringify({ type: 'router.qr_bind_success', payload: data });
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
                log.warn('Received LLM config but Router has no appId/apiKey, cannot decrypt');
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
            log.info('Hosted LLM config updated', { provider: cfg.provider, model: cfg.model });

            // 如果当前已使用 managed 源，自动重建 LLM 实例使新配置立即生效
            if (llmSource === 'managed') {
                applyManagedConfig();
                log.info('Hosted LLM config auto hot-updated', { provider: managedLlmConfig.provider, model: managedLlmConfig.model });
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
            log.error('Failed to decrypt hosted LLM config', { error: err });
        }
    };

    /**
     * 应用托管运行配置到运行时（profiles → config → LLM 重建）
     * 同时兼容新旧协议：优先使用 managedRuntimeConfig，回退 managedLlmConfig
     */
    function applyManagedConfig(): void {
        if (managedRuntimeConfig) {
            // 新协议：多 provider + 多运行位
            if (!config.providers) config.providers = {} as any;
            // 保存本地 providers 快照（仅首次进入 managed 时）
            if (!localProvidersSnapshot) {
                localProvidersSnapshot = JSON.parse(JSON.stringify(config.providers));
            }
            for (const [name, prov] of Object.entries(managedRuntimeConfig.providers)) {
                (config.providers as any)[name] = {
                    apiKey: prov.apiKey,
                    ...(prov.baseUrl ? { baseUrl: prov.baseUrl } : {}),
                };
            }
            // orchestration
            const orch = managedRuntimeConfig.profiles.orchestration;
            config.llm.orchestration.provider = orch.provider as any;
            config.llm.orchestration.model = orch.model;
            // execution（使用 subagent 配置，回退到 orchestration）
            const exec = managedRuntimeConfig.profiles.subagent || orch;
            config.llm.execution.provider = exec.provider as any;
            config.llm.execution.model = exec.model;
            // web.search 配置
            if (managedRuntimeConfig.web?.search) {
                const ws = managedRuntimeConfig.web.search;
                if (!config.web) config.web = {} as any;
                (config.web as any).search = {
                    ...((config.web as any)?.search || {}),
                    provider: ws.provider,
                    ...(ws.apiKey ? { apiKey: ws.apiKey } : {}),
                    ...(ws.maxResults ? { maxResults: ws.maxResults } : {}),
                    ...(ws.timeoutSeconds ? { timeoutSeconds: ws.timeoutSeconds } : {}),
                    ...(ws.cacheTtlMinutes ? { cacheTtlMinutes: ws.cacheTtlMinutes } : {}),
                    ...(ws.perplexity ? { perplexity: ws.perplexity } : {}),
                };
            }
            // 重建 LLM
            const orchProv = managedRuntimeConfig.providers[orch.provider];
            llm = createLLMProvider({
                provider: orch.provider as any,
                model: orch.model,
                apiKey: orchProv?.apiKey || '',
                baseUrl: orchProv?.baseUrl,
            });
            agentManager.updateLLM(llm);
            agentRunner = createAgentLoopRunner({ llm, fallbackLlm, tools, language: config.language });
            // 同步更新 CardManager 的 chatLLM，使记忆蒸馏使用 Router 提供的 LLM
            if (memoryManager && (memoryManager as any)._cardManager) {
                (memoryManager as any)._cardManager.updateChatLLM(llm);
            }
            log.info('Applied managed runtime config', {
                orchestration: `${orch.provider}/${orch.model}`,
                execution: `${exec.provider}/${exec.model}`,
            });
        } else if (managedLlmConfig) {
            // 旧协议：单 provider + 单 model（兼容）
            if (!config.providers) config.providers = {} as any;
            // 保存本地 providers 快照（仅首次进入 managed 时）
            if (!localProvidersSnapshot) {
                localProvidersSnapshot = JSON.parse(JSON.stringify(config.providers));
            }
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
            agentRunner = createAgentLoopRunner({ llm, fallbackLlm, tools, language: config.language });
            // 同步更新 CardManager 的 chatLLM
            if (memoryManager && (memoryManager as any)._cardManager) {
                (memoryManager as any)._cardManager.updateChatLLM(llm);
            }
            log.info('Applied legacy managed LLM config', { provider: managedLlmConfig.provider, model: managedLlmConfig.model });
        }
    }

    // RouterBridge 新协议：managed_runtime_config 下发
    routerBridge.onManagedRuntimeConfig = (msg) => {
        try {
            const routerCfg = (config as any).router as RouterConfig;
            if (!routerCfg?.appId) {
                log.warn('Received managed_runtime_config but Router has no appId, cannot decrypt');
                return;
            }
            // 解密 providers
            const decryptedProviders: Record<string, { apiKey: string; baseUrl?: string }> = {};
            for (const [name, prov] of Object.entries(msg.providers)) {
                const apiKey = decryptAPIKey(prov.api_key_encrypted, prov.iv, routerCfg.appId);
                decryptedProviders[name] = {
                    apiKey,
                    ...(prov.base_url ? { baseUrl: prov.base_url } : {}),
                };
            }
            // 解密 web.search 凭据
            let webSearch: ManagedRuntimeConfig['web'] = undefined;
            if (msg.web?.search) {
                const ws = msg.web.search;
                const searchApiKey = ws.api_key_encrypted && ws.iv
                    ? decryptAPIKey(ws.api_key_encrypted, ws.iv, routerCfg.appId) : undefined;
                let perplexity: { apiKey?: string; baseUrl?: string; model?: string } | undefined = undefined;
                if (ws.perplexity?.api_key_encrypted && ws.perplexity?.iv) {
                    perplexity = {
                        apiKey: decryptAPIKey(ws.perplexity.api_key_encrypted, ws.perplexity.iv, routerCfg.appId),
                        baseUrl: ws.perplexity.base_url,
                        model: ws.perplexity.model,
                    };
                }
                webSearch = {
                    search: {
                        provider: ws.provider,
                        apiKey: searchApiKey,
                        maxResults: ws.max_results,
                        timeoutSeconds: ws.timeout_seconds,
                        cacheTtlMinutes: ws.cache_ttl_minutes,
                        perplexity,
                    },
                };
            }

            managedRuntimeConfig = {
                profiles: msg.profiles,
                providers: decryptedProviders,
                web: webSearch,
                routing: msg.routing,
                quota: msg.quota,
            };
            log.info('Managed runtime config updated', {
                version: msg.version,
                orchestration: `${msg.profiles.orchestration.provider}/${msg.profiles.orchestration.model}`,
                providerCount: Object.keys(decryptedProviders).length,
                routingModules: Object.keys(msg.routing?.modules || {}).length,
            });

            // 如果当前已使用 managed 源，自动热更新
            if (llmSource === 'managed') {
                applyManagedConfig();
                log.info('Managed runtime config auto hot-updated');
            }

            // 推送给所有客户端
            const pushMsg = JSON.stringify({
                type: 'managed-runtime-config',
                payload: {
                    available: true,
                    profiles: msg.profiles,
                    providerNames: Object.keys(decryptedProviders),
                    routing: msg.routing,
                    quota: msg.quota,
                    currentSource: llmSource,
                },
            });
            for (const c of clients.values()) {
                if (c.authenticated && c.ws.readyState === WebSocket.OPEN) {
                    c.ws.send(pushMsg);
                }
            }
        } catch (err: any) {
            log.error('Failed to process managed_runtime_config', {
                message: err?.message || String(err),
                stack: err?.stack,
            });
        }
    };
    // 初始化 Router 消息处理回调
    setupRouterMessageHandler();
    // 如果配置中已有 Router 设置，自动连接
    if ((config as any).router?.enabled) {
        routerBridge.connect((config as any).router as RouterConfig);
        log.info('OpenFluxRouter bridge initialized and connected');
    } else {
        log.info('OpenFluxRouter bridge initialized (not enabled)');
    }

    // ══════════════════════════════════════════════════════════
    // 微信 iLink 桥接（独立模块，不影响 Router）
    // ══════════════════════════════════════════════════════════
    let weixinBridge: WeixinBridgeT | null = null;
    const weixinConfigFile = join(workspace, 'weixin-config.json');

    function loadWeixinConfig(): WeixinConfigT | null {
        try {
            if (existsSync(weixinConfigFile)) {
                return JSON.parse(readFileSync(weixinConfigFile, 'utf-8'));
            }
        } catch {}
        return null;
    }

    function saveWeixinConfig(cfg: WeixinConfigT): void {
        try {
            writeFileSync(weixinConfigFile, JSON.stringify(cfg, null, 2), 'utf-8');
        } catch (err) {
            log.error('Failed to save weixin config', { error: String(err) });
        }
    }

    function setupWeixinMessageHandler(): void {
        if (!weixinBridge) return;

        weixinBridge.onConnectionChange = (status) => {
            broadcastToClients({ type: 'weixin.status', payload: { connected: status === 'connected', status } });
        };

        weixinBridge.onQRCode = (data) => {
            broadcastToClients({ type: 'weixin.qr_code', payload: data });
        };

        weixinBridge.onQRStatus = (data) => {
            broadcastToClients({ type: 'weixin.qr_status', payload: data });
        };

        weixinBridge.onLoginSuccess = (data) => {
            // 登录成功后保存配置
            const current = loadWeixinConfig() || {
                enabled: false, accountId: '', token: '',
                baseUrl: 'https://ilinkai.weixin.qq.com',
                cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
                dmPolicy: 'open' as const, allowedUsers: [],
            };
            current.accountId = data.accountId;
            current.token = data.token;
            current.baseUrl = data.baseUrl;
            current.enabled = true;
            saveWeixinConfig(current);
            broadcastToClients({ type: 'weixin.login_success', payload: data });
            log.info('Weixin login credentials saved');
        };

        // ── 入站消息 → 共享 Router 会话 ──
        weixinBridge.onMessage = async (msg) => {
            const sessionId = getRouterSessionId();
            const msgId = crypto.randomUUID();
            const userLabel = `[微信] ${msg.from_user_id}`;

            let agentInput = msg.content;
            let attachments: Array<{ path: string; name: string; size: number; ext: string }> | undefined;

            // 处理媒体消息
            if (msg.content_type !== 'text' && msg.media) {
                const downloaded = await weixinBridge!.downloadMedia(msg);
                if (downloaded) {
                    attachments = [{
                        path: downloaded.localPath,
                        name: downloaded.fileName,
                        size: downloaded.size,
                        ext: downloaded.ext,
                    }];
                    const typeLabel: Record<string, string> = { image: '图片', file: '文件', voice: '语音', video: '视频' };
                    agentInput = `用户发送了一个${typeLabel[msg.content_type] || '文件'}：${downloaded.fileName}`;
                } else {
                    agentInput = `[${msg.content_type}] 用户发送了一个文件，但下载失败`;
                }
            }

            // 广播用户消息给前端
            broadcastToClients({
                type: 'weixin.user_message',
                id: msgId,
                payload: {
                    sessionId,
                    content: agentInput,
                    label: userLabel,
                    platform_type: 'weixin',
                    platform_user_id: msg.from_user_id,
                    timestamp: Date.now(),
                    attachments: attachments?.map(a => ({
                        name: a.name, ext: a.ext, size: a.size,
                        path: a.path, content_type: msg.content_type,
                    })),
                },
            });

            // 发送打字状态
            weixinBridge!.sendTyping(msg.from_user_id, true).catch(() => {});

            // 调用 Agent 处理
            broadcastToClients({ type: 'chat.start', id: msgId });

            try {
                const output = await executeAgent(
                    agentInput,
                    sessionId,
                    (event) => broadcastToClients({
                        type: 'chat.progress',
                        id: msgId,
                        payload: { ...event, sessionId },
                    }),
                    attachments,
                    {
                        source: 'weixin',
                        platform_type: 'weixin',
                        platform_user_id: msg.from_user_id,
                        label: userLabel,
                    },
                );

                broadcastToClients({
                    type: 'chat.complete',
                    id: msgId,
                    payload: { output, sessionId },
                });

                await weixinBridge!.sendText(msg.from_user_id, output);
                log.info('Weixin reply sent', { to: msg.from_user_id.slice(0, 8) });
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                broadcastToClients({
                    type: 'chat.error',
                    id: msgId,
                    payload: { message: errorMsg },
                });

                const is429 = errorMsg.includes('429') || errorMsg.includes('overloaded') || errorMsg.includes('rate limit');
                await weixinBridge!.sendText(
                    msg.from_user_id,
                    is429 ? '⏳ AI 服务繁忙，请稍后再试。' : '⚠️ 处理消息时遇到问题，请稍后重试。'
                );
                log.error('Weixin Agent processing failed', { error: errorMsg });
            } finally {
                weixinBridge!.sendTyping(msg.from_user_id, false).catch(() => {});
            }
        };
    }

    // 初始化微信（从独立配置文件加载）
    const weixinInitConfig = loadWeixinConfig();
    if (weixinInitConfig?.enabled && weixinInitConfig?.token) {
        try {
            const { WeixinBridge } = await import('./weixin-bridge');
            weixinBridge = new WeixinBridge(weixinInitConfig, workspace);
            setupWeixinMessageHandler();
            weixinBridge.start().catch(err => log.error('WeixinBridge start failed', { error: String(err) }));
            log.info('Weixin iLink bridge initialized and started');
        } catch (err) {
            log.error('Weixin iLink bridge init failed', { error: String(err) });
        }
    } else {
        log.info('Weixin iLink bridge not configured or disabled');
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
     * 同一 session 的请求自动排队（promise chain），不同 session 并发执行
     */
    async function executeAgent(
        input: string,
        sessionId?: string,
        onProgress?: (event: AgentProgressEvent) => void,
        attachments?: Array<{ path: string; name: string; size: number; ext: string }>,
        userMetadata?: Record<string, unknown>,
        agentId?: string,
        abortSignal?: AbortSignal,
    ): Promise<string> {
        const execKey = sessionId || `__anonymous_${crypto.randomUUID()}`;

        // 链式排队：等待同 session 上一个任务完成后再执行
        const previousChain = sessionExecutionChains.get(execKey) || Promise.resolve();

        const currentExecution = previousChain.catch(() => { }).then(async () => {
            activeExecutions.set(execKey, { startedAt: Date.now() });
            currentExecutingSessionId = sessionId;
            log.info('Executing task', { input: input.slice(0, 100), sessionId, activeCount: activeExecutions.size });

            // 用户 Agent 会话自动创建：如果 sessionId 以 user-agent: 开头且不存在，自动创建
            if (sessionId && sessionId.startsWith('user-agent:') && !sessions.get(sessionId)) {
                const userAgentId = sessionId.replace('user-agent:', '');
                const userAgent = userAgentStore.get(userAgentId);
                sessions.create('default', userAgent?.name || userAgentId, undefined, undefined, sessionId);
                log.info('Auto-created session for user agent', { sessionId, agentName: userAgent?.name });
            }

            try {
                // 如果 agentId 是用户级 Agent（不在路由 Agent 列表中），
                // 传 undefined 让路由器自动分派到合适的路由 Agent
                const routingAgentId = agentId && agentManager.getAgent(agentId) ? agentId : undefined;

                // 用户 Agent 身份注入：从 sessionId 解析用户 Agent 的名称和 systemPrompt
                let globalSettingsOverride: { globalAgentName?: string; globalSystemPrompt?: string } | undefined;
                if (sessionId && sessionId.startsWith('user-agent:')) {
                    const userAgentId = sessionId.replace('user-agent:', '');
                    const ua = userAgentStore.get(userAgentId);
                    if (ua) {
                        globalSettingsOverride = {};
                        if (ua.name) globalSettingsOverride.globalAgentName = ua.name;
                        if (ua.systemPrompt) globalSettingsOverride.globalSystemPrompt = ua.systemPrompt;
                    }
                }

                const result = await agentManager.run(
                    input,
                    routingAgentId,
                    sessionId,
                    onProgress,
                    attachments,
                    userMetadata,
                    globalSettingsOverride,
                    abortSignal,
                );

                log.info('Task completed', {
                    agentId: result.agentId,
                    route: result.routeResult?.reason,
                });
                return result.output;
            } finally {
                activeExecutions.delete(execKey);
                if (activeExecutions.size === 0) {
                    currentExecutingSessionId = undefined;
                }
            }
        });

        sessionExecutionChains.set(execKey, currentExecution);
        return currentExecution;
    }

    /**
     * 定时任务专用 Agent 执行
     *
     * 改造后与普通聊天路径对齐：
     * 1. 注入 Agent 身份（name + systemPrompt）
     * 2. 注入全局技能
     * 3. 注入上一轮执行结果摘要
     * 4. 注入当前时间 + 输出路径
     * 5. 结果写入绑定的 Agent 会话
     * 6. 禁止创建新任务（避免递归）
     */
    async function executeScheduledAgent(
        prompt: string,
        sessionId?: string,
        meta?: ScheduledTaskMeta
    ): Promise<string> {
        const taskName = meta?.taskName || '定时任务';
        const msgId = crypto.randomUUID();

        // ── 1. 解析 sessionId，确保写入正确的 Agent 会话 ──
        // 只在真的没有 sessionId 时回退到主 Agent
        if (!sessionId) {
            sessionId = 'user-agent:main';
        }
        // 确保 session 存在（user-agent:xxx 或 cron:xxx 格式）
        if (!sessions.get(sessionId)) {
            if (sessionId.startsWith('user-agent:')) {
                const agentId = sessionId.replace('user-agent:', '');
                const ua = userAgentStore.get(agentId);
                sessions.create('default', ua?.name || taskName, undefined, undefined, sessionId);
            } else {
                sessions.create('default', `🕐 ${taskName}`, undefined, undefined, sessionId);
            }
        }

        // ── 2. 反查 Agent 身份 ──
        let agentName: string | undefined;
        let agentSystemPrompt: string | undefined;
        if (sessionId.startsWith('user-agent:')) {
            const agentId = sessionId.replace('user-agent:', '');
            const ua = userAgentStore.get(agentId);
            if (ua) {
                agentName = ua.name;
                agentSystemPrompt = ua.systemPrompt;
            } else {
                log.warn('Scheduled task agent not found, using default identity', { agentId, taskName });
            }
        }

        // ── 3. 获取全局技能 ──
        const skills = agentManager.getAgentsConfig()?.skills as
            Array<{ id: string; title: string; content: string; enabled: boolean }> | undefined;

        // ── 4. 加载上一轮执行摘要 ──
        let previousRunContext = '';
        if (meta?.taskId) {
            try {
                const recentRuns = schedulerStore.loadRunsByTaskId(meta.taskId, 3);
                const lastSuccess = recentRuns.find(r => r.status === 'completed' && r.output);
                if (lastSuccess?.output) {
                    const summary = lastSuccess.output.length > 1500
                        ? lastSuccess.output.slice(0, 1500) + '\n...(已截断)'
                        : lastSuccess.output;
                    previousRunContext = [
                        ``,
                        `## 上一次执行结果（${new Date(lastSuccess.startedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}）`,
                        `以下是该任务上一次自动执行的结果摘要，你可以参考但不要机械重复：`,
                        summary,
                    ].join('\n');
                }
            } catch (e) {
                log.warn('Failed to load previous run for context', { taskId: meta.taskId, error: e });
            }
        }

        // ── 5. 注入当前时间（定时任务尤其需要知道"今天"） ──
        const now = new Date();
        const dateStr = now.toLocaleString('zh-CN', {
            timeZone: 'Asia/Shanghai',
            year: 'numeric', month: '2-digit', day: '2-digit',
            weekday: 'long', hour: '2-digit', minute: '2-digit',
            hour12: false,
        });
        const timeContext = `\n\n## 当前时间\n现在是 ${dateStr}（${now.toISOString()}）。`;

        // ── 6. 注入输出路径 ──
        let outputContext = '';
        const outputPath = runtimeSettings.outputPath;
        if (outputPath) {
            const todayStr = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
            outputContext = `\n\n## 文件输出目录\n基础输出目录：${outputPath}\n当前任务目录：${outputPath}/${todayStr}/${taskName}/`;
        }

        log.info('Scheduled task executing', {
            taskName,
            prompt: prompt.slice(0, 100),
            sessionId,
            agentName: agentName || '(default)',
            hasSkills: !!skills?.length,
            hasPreviousContext: !!previousRunContext,
        });

        // ── 7. 链式排队执行 ──
        const execKey = sessionId;
        const previousChain = sessionExecutionChains.get(execKey) || Promise.resolve();

        const scheduledExecution = previousChain.catch(() => { }).then(async () => {
            activeExecutions.set(execKey, { startedAt: Date.now() });
            currentExecutingSessionId = sessionId;

            // 保存触发消息
            if (sessionId) {
                sessions.addMessage(sessionId, {
                    role: 'assistant',
                    content: `🕐 **定时任务触发：${taskName}**`,
                });
            }

            // 广播定时任务开始
            broadcastToClients({
                type: 'chat.progress',
                id: msgId,
                payload: { type: 'iteration', iteration: 0, sessionId },
            });

            // ── 8. 组装 Prompt ──
            const wrappedPrompt = [
                `[系统指令] 这是定时任务「${taskName}」的自动触发执行。`,
                `请直接执行以下任务内容，将结果回复给用户。`,
                `⚠ 严禁调用 scheduler 工具，不要创建新的定时任务。这已经是任务执行阶段，只需执行并回复结果。`,
                `⚠ notify_user 只允许调用一次！在所有工作完成后，用一条消息汇总全部结果并推送。中间过程不要调用 notify_user。`,
                timeContext,
                outputContext,
                previousRunContext,
                ``,
                `任务内容：${prompt}`,
            ].join('\n');

            // ── 9. 运行 Agent Loop（注入 Agent 身份 + 技能） ──
            try {
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
                    [],             // 空历史（上下文通过 prompt 注入，保持干净）
                    undefined,      // contentParts
                    {               // ★ globalSettings：注入 Agent 身份 + 技能
                        globalAgentName: agentName,
                        globalSystemPrompt: agentSystemPrompt,
                        skills: skills,
                        sessionId,
                        isScheduledTask: true,
                    },
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

                log.info('Scheduled task completed', {
                    taskName,
                    agentName: agentName || '(default)',
                    iterations: result.iterations,
                    toolCalls: result.toolCalls.length,
                });

                // 通知前端刷新该会话（定时任务输出已写入 agent 会话）
                if (sessionId) {
                    broadcastSessionUpdate(sessionId);
                }

                return result.output;
            } finally {
                activeExecutions.delete(execKey);
                // 清理定时任务创建的临时 tab（避免浏览器 tab 泄漏）
                if (sessionId) {
                    cleanupScheduledPages(sessionId);
                }
                if (activeExecutions.size === 0) {
                    currentExecutingSessionId = undefined;
                }
            }
        });

        sessionExecutionChains.set(execKey, scheduledExecution);
        return scheduledExecution;
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
        // resolvePath 已在文件顶部 import

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
                // 仅对写入操作(非 read/info/list)提取成果物
                if (tc.name === 'filesystem' && data) {
                    const tcArgs = (tc as any).args as Record<string, unknown> | undefined;
                    const action = (tcArgs?.action as string) || '';
                    if (action === 'write' || action === 'copy') {
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
                                    log.info('Scheduled task artifact saved', { filename, path: filePath });
                                }
                            } catch { /* ignore */ }
                        }
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
                                        log.info('Scheduled task artifact saved', { filename: f.path, path: f.fullPath });
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
                                            log.info('Scheduled task artifact saved (stdout)', { path: resolved });
                                        }
                                    } catch { /* ignore */ }
                                }
                            }
                        }
                    }
                }

                // filesystem.info 不产生成果物（仅查询文件信息，非生成操作）

                // windows (powershell/com) → 从 stdout 中提取文件路径
                if (tc.name === 'windows' && data) {
                    const stdout = (data.stdout as string) || '';
                    if (stdout) {
                        const foundPaths: string[] = [];
                        // 策略1: 逐行检测，允许路径含空格（从驱动器号到行尾扩展名）
                        const lines = stdout.split(/\r?\n/);
                        const linePathRegex = /([A-Z]:[/\\].+\.(?:pptx?|docx?|xlsx?|pdf|png|jpg|jpeg|gif|svg|mp4|mp3|zip|csv|html|txt|md|py|js|ts|json|yaml))\b/i;
                        for (const line of lines) {
                            const m = line.match(linePathRegex);
                            if (m) foundPaths.push(m[1].trim());
                        }
                        // 去重 + 保存
                        for (const p of [...new Set(foundPaths)]) {
                            const resolved = resolvePath(p);
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
                                        log.info('Scheduled task artifact saved (windows stdout)', { path: resolved });
                                    }
                                } catch { /* ignore */ }
                            }
                        }
                    }
                }
            } catch (err) {
                log.warn('Scheduled task artifact extraction error', { tool: tc.name, error: err instanceof Error ? err.message : String(err) });
            }
        }

        if (savedPaths.size > 0) {
            log.info(`Scheduled task extracted ${savedPaths.size} artifacts`);
        }
    }

    // 绑定调度器 Agent 执行回调
    schedulerAgentExecute = executeScheduledAgent;
    scheduler.start();
    log.info('Scheduler started');

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
        log.info(`Client connected: ${clientId}`);

        // 客户端连接后立即推送 Router 状态（前端可能错过启动时的 connect_status 推送）
        if (client.authenticated) {
            const rs = routerBridge.getStatus();
            const routerStatusMsg = JSON.stringify({ type: 'router.status', payload: { connected: rs.connected, status: rs.connected ? 'connected' : 'disconnected', bound: rs.bound } });
            ws.send(routerStatusMsg);
            // 推送微信 iLink 状态
            if (weixinBridge) {
                const wxs = weixinBridge.getStatus();
                ws.send(JSON.stringify({ type: 'weixin.status', payload: { connected: wxs.connected, status: wxs.connected ? 'connected' : 'disconnected' } }));
            }
        }

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
                log.info(`Client ${clientId} disconnected, cleaned up ${client.clientMcpToolNames.length} proxy tools`);
            }
            clients.delete(clientId);
            log.info(`Client disconnected: ${clientId}`);
        });
        ws.on('error', (error: Error) => log.error(`Client error: ${clientId}`, { error }));
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
                case 'chat.stop':
                    handleChatStop(client, message);
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
                // ========================
                // Agent 管理
                // ========================
                case 'agents.list':
                    handleAgentsList(client, message);
                    break;
                case 'agents.create':
                    handleAgentsCreate(client, message);
                    break;
                case 'agents.update':
                    handleAgentsUpdate(client, message);
                    break;
                case 'agents.delete':
                    handleAgentsDelete(client, message);
                    break;
                case 'agents.switch':
                    handleAgentsSwitch(client, message);
                    break;
                case 'agents.history.clear':
                    handleAgentsHistoryClear(client, message);
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
                case 'language.update': {
                    const lang = (message.payload as any)?.language;
                    if (lang && typeof lang === 'string') {
                        // Map frontend locale to BCP 47
                        const langMap: Record<string, string> = { zh: 'zh-CN', en: 'en' };
                        const bcp47 = langMap[lang] || lang;
                        config.language = bcp47;
                        // Rebuild agentRunner with new language
                        agentRunner = createAgentLoopRunner({ llm, fallbackLlm, tools, language: config.language });
                        // Persist language to server-config.json
                        saveServerConfig(workspace, config, localProvidersSnapshot || undefined);
                        log.info('Language updated', { language: bcp47 });
                        send(client, { type: 'language.update', id: message.id, payload: { success: true, language: bcp47 } });
                    } else {
                        send(client, { type: 'language.update', id: message.id, payload: { success: false, message: 'Missing language' } });
                    }
                    break;
                }
                case 'config.set-llm-source': {
                    const src = (message.payload as any)?.source;
                    if (src === 'managed' && (managedRuntimeConfig || managedLlmConfig)) {
                        llmSource = 'managed';
                        applyManagedConfig();
                        log.info('Switched to managed config');
                    } else if (src === 'atlas_managed') {
                        // Atlas 托管模式：使用 NexusAI access_token 走 Atlas Model Access Gateway
                        const atlasToken = openfluxBridge.getToken();
                        if (!atlasToken) {
                            send(client, { type: 'config.llm-source', id: message.id, payload: { source: llmSource, error: '请先登录 NexusAI 账号' } });
                            break;
                        }

                        llmSource = 'atlas_managed';
                        // 保存本地 providers 快照
                        if (!localProvidersSnapshot) {
                            localProvidersSnapshot = JSON.parse(JSON.stringify(config.providers || {}));
                        }

                        // V2：先刷新 user_info 获取最新 atlas runtime 配置
                        await openfluxBridge.fetchUserInfo();
                        const atlasRt = openfluxBridge.getAtlasRuntime();

                        if (atlasRt?.chat) {
                            llm = buildAtlasLLM(atlasRt, atlasToken, config.llm.orchestration);
                            log.info('Switched to Atlas managed mode (V2)', {
                                protocol: atlasRt.chat.protocol,
                                model: atlasRt.chat.model_name,
                                display: atlasRt.chat.display_name,
                            });
                        } else {
                            // 无 runtime 配置，回退 openai 协议
                            llm = createLLMProvider({
                                provider: 'openai',
                                model: config.llm.orchestration.model,
                                apiKey: atlasToken,
                                baseUrl: buildAtlasGatewayUrl('openai'),
                                temperature: config.llm.orchestration.temperature,
                                maxTokens: config.llm.orchestration.maxTokens,
                            });
                            log.warn('Switched to Atlas managed mode without runtime config (fallback openai)');
                        }

                        agentManager.updateLLM(llm);
                        agentRunner = createAgentLoopRunner({ llm, fallbackLlm, tools, language: config.language });
                        // 同步更新 CardManager 的 chatLLM
                        if (memoryManager && (memoryManager as any)._cardManager) {
                            (memoryManager as any)._cardManager.updateChatLLM(llm);
                        }

                        log.info('Atlas managed mode active');
                    } else {
                        llmSource = 'local';
                        // 从本地 providers 快照恢复（优先），避免 server-config.json 被 Router key 污染
                        if (localProvidersSnapshot) {
                            (config as any).providers = JSON.parse(JSON.stringify(localProvidersSnapshot));
                            localProvidersSnapshot = null;
                        }
                        // 从 server-config.json 恢复 llm 模型配置
                        try {
                            const cfgPath = join(workspace, 'server-config.json');
                            if (existsSync(cfgPath)) {
                                const saved = JSON.parse(readFileSync(cfgPath, 'utf-8'));
                                if (!localProvidersSnapshot && saved.providers) {
                                    // 快照不存在时（首次启动直接 local），从文件恢复
                                    (config as any).providers = saved.providers;
                                }
                                if (saved.llm) {
                                    Object.assign(config.llm, saved.llm);
                                }
                            }
                        } catch (e) {
                            log.error('Restore local LLM config failed', { error: e });
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
                        agentRunner = createAgentLoopRunner({ llm, fallbackLlm, tools, language: config.language });
                        // 同步更新 CardManager 的 chatLLM
                        if (memoryManager && (memoryManager as any)._cardManager) {
                            (memoryManager as any)._cardManager.updateChatLLM(llm);
                        }
                        log.info('Switched to local LLM config');
                    }
                    // 持久化 llmSource 到文件
                    try { writeFileSync(llmSourceFile, JSON.stringify({ source: llmSource }), 'utf-8'); } catch { /* ignore */ }
                    send(client, { type: 'config.llm-source', id: message.id, payload: { source: llmSource } });
                    break;
                }
                case 'config.get-llm-source': {
                    // 优先返回新协议配置
                    const managedInfo = managedRuntimeConfig ? {
                        available: true,
                        profiles: managedRuntimeConfig.profiles,
                        providerNames: Object.keys(managedRuntimeConfig.providers),
                        routing: managedRuntimeConfig.routing,
                        quota: managedRuntimeConfig.quota,
                    } : managedLlmConfig ? {
                        available: true,
                        provider: managedLlmConfig.provider,
                        model: managedLlmConfig.model,
                        quota: managedLlmConfig.quota,
                    } : { available: false };
                    send(client, {
                        type: 'config.llm-source',
                        id: message.id,
                        payload: {
                            source: llmSource,
                            managed: managedInfo,
                        },
                    });
                    break;
                }
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
                            log.info('User skipped first-time setup, marker file created');
                        }
                        send(client, { type: 'setup.skipped', id: message.id, payload: { message: '已跳过设置' } });
                    } catch (err) {
                        log.error('Skip setup marking failed', err);
                        send(client, { type: 'setup.error', id: message.id, payload: { message: '标记失败' } });
                    }
                    break;
                }
                case 'debug.subscribe':
                    client.debugSubscribed = true;
                    console.log(`[DEBUG] Client ${client.id} subscribed to debug logs, clients=${clients.size}`);
                    log.info(`Client ${client.id} subscribed to debug logs`);
                    break;
                case 'debug.unsubscribe':
                    client.debugSubscribed = false;
                    log.info(`Client ${client.id} unsubscribed from debug logs`);
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
                case 'router.qr-bind':
                    handleRouterQRBind(client, message);
                    break;
                // ========================
                // 微信 iLink 消息（独立于 Router）
                // ========================
                case 'weixin.config.get':
                    handleWeixinConfigGet(client, message);
                    break;
                case 'weixin.config.update':
                    await handleWeixinConfigUpdate(client, message);
                    break;
                case 'weixin.status':
                    handleWeixinStatusGet(client, message);
                    break;
                case 'weixin.qr-login':
                    await handleWeixinQRLogin(client, message);
                    break;
                case 'weixin.disconnect':
                    handleWeixinDisconnect(client, message);
                    break;
                case 'weixin.test':
                    await handleWeixinTest(client, message);
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
                // 浏览器调试模式启动
                case 'browser.launch':
                    await handleBrowserLaunch(client, message);
                    break;
                case 'browser.status': {
                    const status = getBrowserConnectionStatus();
                    log.info('Browser status query', status);
                    send(client, { type: 'browser.status', id: message.id, payload: status });
                    break;
                }
                // ========================
                // Evolution（自我进化）
                // ========================
                case 'evolution.confirm.response': {
                    const { requestId, approved } = message.payload as { requestId: string; approved: boolean };
                    const resolver = pendingConfirmations.get(requestId);
                    if (resolver) {
                        pendingConfirmations.delete(requestId);
                        resolver(approved);
                        log.info(`Evolution confirm response: ${requestId} → ${approved ? 'approved' : 'rejected'}`);
                    }
                    break;
                }
                case 'evolution.stats': {
                    const manifest = evolutionData.readManifest();
                    send(client, {
                        type: 'evolution.stats',
                        id: message.id,
                        payload: { schemaVersion: manifest.schemaVersion, stats: manifest.stats },
                    });
                    break;
                }
                case 'evolution.skills.list': {
                    const skills = evolutionData.listInstalledSkills();
                    send(client, { type: 'evolution.skills.list', id: message.id, payload: { skills } });
                    break;
                }
                case 'evolution.skills.uninstall': {
                    const { slug } = message.payload as { slug: string };
                    const removed = evolutionData.removeInstalledSkill(slug);
                    if (removed) agentManagerRef?.removeSkill(`skillhub:${slug}`);
                    send(client, { type: 'evolution.skills.uninstall', id: message.id, payload: { success: removed } });
                    break;
                }
                case 'evolution.tools.list': {
                    const customTools2 = evolutionData.listCustomTools();
                    send(client, { type: 'evolution.tools.list', id: message.id, payload: { tools: customTools2 } });
                    break;
                }
                case 'evolution.tools.delete': {
                    const { name: toolName2 } = message.payload as { name: string };
                    const removedTool = evolutionData.removeCustomTool(toolName2);
                    if (removedTool) {
                        // 同时从内存注册表移除，确保立即不可用
                        tools.unregister(`custom_${toolName2}`);
                    }
                    send(client, { type: 'evolution.tools.delete', id: message.id, payload: { success: removedTool } });
                    break;
                }
                // Forged Skills（锻造技能）
                case 'evolution.forge.accept': {
                    const suggestion = message.payload as ForgeSuggestion;
                    if (suggestion?.id) {
                        const meta = skillForge.acceptSuggestion(suggestion);
                        // 注入到 Agent skills
                        const content = evolutionData.readForgedSkillContent(suggestion.id);
                        if (content && agentManagerRef) {
                            agentManagerRef.addSkill({
                                id: `forged:${suggestion.id}`,
                                title: suggestion.title,
                                content,
                            });
                        }
                        send(client, { type: 'evolution.forge.accept', id: message.id, payload: { success: true, meta } });
                    } else {
                        send(client, { type: 'evolution.forge.accept', id: message.id, payload: { success: false } });
                    }
                    break;
                }
                case 'evolution.forge.dismiss': {
                    // 用户忽略建议，清除 pendingSuggestion
                    pendingSuggestion = null;
                    send(client, { type: 'evolution.forge.dismiss', id: message.id, payload: { success: true } });
                    break;
                }
                case 'evolution.forged.list': {
                    const forgedSkills = evolutionData.listForgedSkills();
                    send(client, { type: 'evolution.forged.list', id: message.id, payload: { skills: forgedSkills } });
                    break;
                }
                case 'evolution.forged.delete': {
                    const { id: forgedId } = message.payload as { id: string };
                    const removedForged = evolutionData.removeForgedSkill(forgedId);
                    if (removedForged) agentManagerRef?.removeSkill(`forged:${forgedId}`);
                    send(client, { type: 'evolution.forged.delete', id: message.id, payload: { success: removedForged } });
                    break;
                }
                default:
                    send(client, { type: 'error', payload: { message: `未知消息类型: ${message.type}` } });
            }
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            const errStack = error instanceof Error ? error.stack : undefined;
            log.error('Message processing failed', { errMsg, errStack });
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
            agentId?: string;
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

        if (llmSource === 'atlas_managed' && (!openfluxBridge.getToken() || !llm)) {
            const authMessage = 'NexusAI access token 已失效，请重新登录';
            log.info('Atlas managed chat requires re-authentication');
            send(client, {
                type: 'nexusai.auth-expired',
                id: messageId,
                payload: { message: authMessage },
            });
            send(client, {
                type: 'chat.error',
                id: messageId,
                payload: { message: authMessage },
            });
            return;
        }

        // ── 打印当前工作模式 ──
        const modeLabel = llmSource === 'atlas_managed' ? 'NexusAI 全托管'
            : llmSource === 'managed' ? 'Router 团队模式'
            : '单机模式';
        if (llmSource === 'atlas_managed') {
            log.info(`📡 工作模式: ${modeLabel}`);
        } else {
            if (!llm) {
                send(client, {
                    type: 'chat.error',
                    id: messageId,
                    payload: { message: '当前模型服务尚未初始化，请先完成本地配置。' },
                });
                return;
            }
            const llmCfg = llm.getConfig();
            log.info(`📡 工作模式: ${modeLabel} | 平台: ${llmCfg.provider} | 模型: ${llmCfg.model}`);
        }

        // 创建 AbortController 用于用户主动停止任务
        const abortController = new AbortController();
        const abortKey = payload.sessionId || messageId;
        activeAbortControllers.set(abortKey, abortController);

        try {
            const output = await executeAgent(
                payload.input || '',
                payload.sessionId,
                (event) => {
                    send(client, {
                        type: 'chat.progress',
                        id: messageId,
                        payload: { ...event, sessionId: payload.sessionId },
                    });
                },
                payload.attachments,
                undefined,
                payload.agentId,
                abortController.signal,
            );

            send(client, {
                type: 'chat.complete',
                id: messageId,
                payload: { output, sessionId: payload.sessionId },
            });

            // L2 Skill Forge: 异步分析对话是否有可锻造技能（不阻塞主流程）
            if (payload.sessionId) {
                const sessionMessages = sessions.getMessages(payload.sessionId);
                if (sessionMessages && sessionMessages.length > 0) {
                    const sessionLogs = sessions.getLogs(payload.sessionId);
                    const toolCallNames = (sessionLogs || [])
                        .filter((l: any) => l.type === 'tool_call')
                        .map((l: any) => ({ name: l.toolName || 'unknown', result: l.result }));
                    skillForge.analyzeConversation(
                        sessionMessages as any,
                        { output, iterations: 1, toolCalls: toolCallNames },
                        payload.sessionId,
                    ).catch(err => log.debug('Skill forge analysis error (non-blocking)', { error: String(err) }));
                }
            }
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            const errorStack = error instanceof Error ? error.stack : undefined;
            log.error('Chat execution failed', { message: errorMsg, stack: errorStack });

            // Atlas 模式下认证失败 → 通知前端弹出重新登录
            if (llmSource === 'atlas_managed' && error instanceof LLMError && error.category === 'AUTH_ERROR') {
                send(client, {
                    type: 'nexusai.auth-expired',
                    id: messageId,
                    payload: { message: error.message || 'NexusAI access token 已过期，请重新登录' },
                });
            }

            send(client, {
                type: 'chat.error',
                id: messageId,
                payload: { message: errorMsg },
            });
        } finally {
            activeAbortControllers.delete(abortKey);
        }
    }

    /**
     * 停止正在执行的任务
     */
    function handleChatStop(_client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { sessionId?: string };
        const sessionId = payload?.sessionId;

        if (!sessionId) {
            log.warn('chat.stop received without sessionId');
            return;
        }

        const controller = activeAbortControllers.get(sessionId);
        if (controller) {
            log.info('Aborting task', { sessionId });
            controller.abort();
        } else {
            log.warn('chat.stop: no active task found', { sessionId });
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
    // Agent 管理消息处理
    // ========================

    /**
     * 获取所有 Agent 列表（含 sessionKey）
     */
    function handleAgentsList(client: GatewayClient, message: GatewayMessage): void {
        const agents = userAgentStore.list();
        send(client, { type: 'agents.list', id: message.id, payload: { agents } });
    }

    /**
     * 创建新 Agent
     */
    function handleAgentsCreate(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as any;
        if (!payload?.name) {
            send(client, { type: 'error', id: message.id, payload: { message: '缺少 Agent name' } });
            return;
        }
        try {
            const agent = userAgentStore.create(payload);
            send(client, { type: 'agents.create', id: message.id, payload: { agent } });
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            send(client, { type: 'error', id: message.id, payload: { message: msg } });
        }
    }

    /**
     * 更新 Agent 配置
     */
    function handleAgentsUpdate(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { agentId: string; updates: any };
        if (!payload?.agentId) {
            send(client, { type: 'error', id: message.id, payload: { message: '缺少 agentId' } });
            return;
        }
        try {
            const updated = userAgentStore.update(payload.agentId, payload.updates);
            if (!updated) throw new Error('Agent 不存在');
            send(client, { type: 'agents.update', id: message.id, payload: { agent: updated } });
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            send(client, { type: 'error', id: message.id, payload: { message: msg } });
        }
    }

    /**
     * 删除 Agent
     */
    function handleAgentsDelete(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { agentId: string };
        if (!payload?.agentId) {
            send(client, { type: 'error', id: message.id, payload: { message: '缺少 agentId' } });
            return;
        }
        const success = userAgentStore.delete(payload.agentId);
        send(client, { type: 'agents.delete', id: message.id, payload: { success } });
    }

    /**
     * 切换 Agent（返回该 Agent 的 sessionKey + 会话历史）
     */
    function handleAgentsSwitch(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { agentId: string };
        if (!payload?.agentId) {
            send(client, { type: 'error', id: message.id, payload: { message: '缺少 agentId' } });
            return;
        }
        const agent = userAgentStore.get(payload.agentId);
        if (!agent) {
            send(client, { type: 'error', id: message.id, payload: { message: `Agent 不存在: ${payload.agentId}` } });
            return;
        }
        // 用户 Agent 使用 user-agent:{id} 作为 session key
        const sessionKey = `user-agent:${agent.id}`;
        const messages = sessions.getMessages(sessionKey);
        send(client, {
            type: 'agents.switch',
            id: message.id,
            payload: { agent: { ...agent, sessionKey }, messages },
        });
    }

    /**
     * 清除 Agent 历史消息
     */
    function handleAgentsHistoryClear(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { agentId: string };
        if (!payload?.agentId) {
            send(client, { type: 'error', id: message.id, payload: { message: '缺少 agentId' } });
            return;
        }
        const agent = userAgentStore.get(payload.agentId);
        const sessionKey = `user-agent:${payload.agentId}`;
        sessions.delete(sessionKey);
        sessions.create(payload.agentId, agent?.name || payload.agentId, undefined, undefined, sessionKey);
        send(client, { type: 'agents.history.clear', id: message.id, payload: { success: true } });
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
            log.error('Get distillation graph data failed', { error: String(err) });
            send(client, { type: 'distillation.graph', id: message.id, payload: { cards: [], relations: [], topics: [] } });
        }
    }

    function handleDistillationConfigUpdate(client: GatewayClient, message: GatewayMessage): void {
        const cardManager = memoryManager ? (memoryManager as any)._cardManager : null;
        const scheduler = memoryManager ? (memoryManager as any)._distillScheduler : null;
        if (!cardManager) {
            send(client, { type: 'distillation.config.update', id: message.id, payload: { success: false, message: 'Distillation system not initialized' } });
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
            log.warn('Manual distillation failed: scheduler not found', { hasMemory: !!memoryManager, hasCardManager: !!(memoryManager as any)?._cardManager });
            send(client, { type: 'distillation.trigger', id: message.id, payload: { success: false, message: 'Distillation system not initialized' } });
            return;
        }
        try {
            log.info('Manual distillation triggered...');
            await scheduler.triggerManual();
            log.info('Manual distillation completed');
            send(client, { type: 'distillation.trigger', id: message.id, payload: { success: true } });
        } catch (err) {
            log.error('Manual distillation failed', { error: String(err), stack: (err as any)?.stack });
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
                topicTitle: r.topic_title || 'Uncategorized',
                layer: r.layer,
                summary: r.summary,
                qualityScore: r.quality_score,
                tags: r.tags ? JSON.parse(r.tags) : [],
                createdAt: r.created_at,
                updatedAt: r.updated_at,
            }));
            send(client, { type: 'distillation.cards', id: message.id, payload: { cards, total } });
        } catch (err) {
            log.error('Get card list failed', { error: String(err) });
            send(client, { type: 'distillation.cards', id: message.id, payload: { cards: [], total: 0 } });
        }
    }

    function handleDistillationCardDelete(client: GatewayClient, message: GatewayMessage): void {
        const cardManager = memoryManager ? (memoryManager as any)._cardManager : null;
        if (!cardManager) {
            send(client, { type: 'distillation.card.delete', id: message.id, payload: { success: false, message: 'Card system not initialized' } });
            return;
        }
        try {
            const { cardId } = (message.payload || {}) as any;
            if (!cardId) {
                send(client, { type: 'distillation.card.delete', id: message.id, payload: { success: false, message: 'Missing cardId' } });
                return;
            }
            const ok = cardManager.deleteCard(cardId);
            send(client, { type: 'distillation.card.delete', id: message.id, payload: { success: ok } });
        } catch (err) {
            log.error('Delete card failed', { error: String(err) });
            send(client, { type: 'distillation.card.delete', id: message.id, payload: { success: false, message: String(err) } });
        }
    }

    // ========================
    // Voice 语音服务消息处理
    // ========================

    async function handleVoiceSynthesize(client: GatewayClient, message: GatewayMessage): Promise<void> {
        const payload = message.payload as { text: string };
        if (!ttsService?.isAvailable()) {
            send(client, { type: 'voice.synthesize', id: message.id, payload: { error: 'TTS service unavailable' } });
            return;
        }
        try {
            const audioBuffer = await ttsService.synthesize(payload.text);
            // 将 Buffer 转为 base64 传输
            const base64Audio = audioBuffer.toString('base64');
            send(client, { type: 'voice.synthesize', id: message.id, payload: { audio: base64Audio } });
        } catch (err: any) {
            send(client, { type: 'voice.synthesize', id: message.id, payload: { error: err.message || 'Voice synthesis failed' } });
        }
    }

    async function handleVoiceTranscribe(client: GatewayClient, message: GatewayMessage): Promise<void> {
        const payload = message.payload as { audio: string }; // base64 WAV
        if (!sttService?.isAvailable()) {
            send(client, { type: 'voice.transcribe', id: message.id, payload: { error: 'STT service unavailable' } });
            return;
        }
        try {
            const buffer = Buffer.from(payload.audio, 'base64');
            const result = await sttService.transcribe(buffer);
            send(client, { type: 'voice.transcribe', id: message.id, payload: { text: result.text, elapsed: result.elapsed } });
        } catch (err: any) {
            send(client, { type: 'voice.transcribe', id: message.id, payload: { error: err.message || 'Voice recognition failed' } });
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
            send(client, { type: 'voice.set-voice', id: message.id, payload: { error: 'TTS service not initialized' } });
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
            send(client, { type: 'openflux.login', id: message.id, payload: { success: false, message: 'Missing username or password' } });
            return;
        }
        const result = await openfluxBridge.login(payload.username, payload.password);

        // 登录成功 + 当前是 atlas_managed 模式 → 用新 token 重建 LLM
        if (result.success && llmSource === 'atlas_managed') {
            const newToken = openfluxBridge.getToken();
            if (newToken) {
                const atlasRt = openfluxBridge.getAtlasRuntime();
                if (atlasRt?.chat) {
                    llm = buildAtlasLLM(atlasRt, newToken, config.llm.orchestration);
                } else {
                    llm = createLLMProvider({
                        provider: 'openai',
                        model: config.llm.orchestration.model || 'default',
                        apiKey: newToken,
                        baseUrl: buildAtlasGatewayUrl('openai'),
                        temperature: config.llm.orchestration.temperature,
                        maxTokens: config.llm.orchestration.maxTokens,
                    });
                }
                agentManager.updateLLM(llm);
                agentRunner = createAgentLoopRunner({ llm, fallbackLlm, tools, language: config.language });
                if (memoryManager && (memoryManager as any)._cardManager) {
                    (memoryManager as any)._cardManager.updateChatLLM(llm);
                }
                log.info('Atlas LLM rebuilt with refreshed token after re-login');
            }
        }

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
            send(client, { type: 'chat.error', id: messageId, payload: { message: 'Missing chatroomId' } });
            return;
        }

        // ═══ 校验并修正 sessionId ═══
        // 前端可能传来错误的 sessionId（如 user-agent:main 但 chatroomId=329），
        // 需根据 chatroomId 查找正确的 cloud session
        let resolvedSessionId = payload.sessionId;
        if (resolvedSessionId && payload.chatroomId) {
            const sessionMeta = sessions.get(resolvedSessionId);
            if (sessionMeta && sessionMeta.cloudChatroomId !== payload.chatroomId) {
                // sessionId 与 chatroomId 不匹配！查找正确的 session
                const allSessions = sessions.list();
                const correctSession = allSessions.find(s => s.cloudChatroomId === payload.chatroomId);
                if (correctSession) {
                    log.warn('Cloud chat: sessionId-chatroomId mismatch! Correcting', {
                        originalSessionId: resolvedSessionId.slice(0, 8),
                        correctedSessionId: correctSession.id.slice(0, 8),
                        chatroomId: payload.chatroomId,
                    });
                    resolvedSessionId = correctSession.id;
                } else {
                    log.warn('Cloud chat: sessionId-chatroomId mismatch but no matching session found', {
                        sessionId: resolvedSessionId.slice(0, 8),
                        chatroomId: payload.chatroomId,
                    });
                }
            }
        }

        log.info('Cloud chat started', {
            sessionId: resolvedSessionId?.slice(0, 8),
            chatroomId: payload.chatroomId,
            inputLength: payload.input?.length,
            corrected: resolvedSessionId !== payload.sessionId,
        });

        if (!resolvedSessionId) {
            log.warn('Cloud chat: sessionId is missing! Messages will NOT be saved locally.');
        }

        send(client, { type: 'chat.start', id: messageId });

        // 在 progress 回调中独立收集 token（不依赖 openfluxBridge.chat 的 resolve）
        const collectedTokens: string[] = [];
        let lastTokenTime = Date.now();

        try {
            // 保存用户消息到本地会话
            if (resolvedSessionId) {
                sessions.addMessage(resolvedSessionId, {
                    role: 'user',
                    content: payload.input,
                });
                log.info('Cloud chat: user message saved', { sessionId: resolvedSessionId.slice(0, 8) });
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
                        payload: { ...event, sessionId: resolvedSessionId },
                    });
                },
            );

            // openfluxBridge.chat 正常 resolve — 使用其返回的 output
            const finalOutput = output || collectedTokens.join('');
            saveCloudAssistantMessage(resolvedSessionId, finalOutput);

            send(client, {
                type: 'chat.complete',
                id: messageId,
                payload: { output: finalOutput, sessionId: resolvedSessionId },
            });
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            log.error('Cloud chat error', { error: errorMsg });

            // 如果已经收集到了回复内容，仍然保存助手消息
            const fallbackOutput = collectedTokens.join('');
            if (fallbackOutput.length > 0) {
                log.info('Cloud chat error but collected reply, attempting to save');
                saveCloudAssistantMessage(resolvedSessionId, fallbackOutput);
                // 发送 complete（而非 error），因为用户已看到了回复
                send(client, {
                    type: 'chat.complete',
                    id: messageId,
                    payload: { output: fallbackOutput, sessionId: resolvedSessionId },
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
            log.info('Cloud assistant message saved', {
                sessionId: sessionId.slice(0, 8),
                title: updatedMeta?.title,
                messageCount: updatedMeta?.messageCount,
            });
        } catch (e) {
            log.error('Cloud assistant message save failed', { error: e instanceof Error ? e.message : String(e) });
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
            const existing = allSessions.find(s => s.title === 'Router Messages');
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
            send(client, { type: 'router.config.update', id: message.id, payload: { success: false, message: 'Missing config' } });
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
            saveServerConfig(workspace, config, localProvidersSnapshot || undefined);

            // 更新连接
            routerBridge.updateConfig(newConfig);

            log.info('Router config updated', { url: newConfig.url, appId: newConfig.appId, enabled: newConfig.enabled });
            send(client, { type: 'router.config.update', id: message.id, payload: { success: true } });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            send(client, { type: 'router.config.update', id: message.id, payload: { success: false, message: msg } });
        }
    }

    function handleRouterSend(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as RouterOutboundMessage | undefined;
        if (!payload?.platform_type || !payload?.platform_id || !payload?.platform_user_id || !payload?.content) {
            send(client, { type: 'router.send', id: message.id, payload: { success: false, message: 'Message fields incomplete' } });
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
            send(client, { type: 'router.bind', id: message.id, payload: { success: false, message: 'Pairing code cannot be empty' } });
            return;
        }
        const ok = routerBridge.bind(code);
        send(client, { type: 'router.bind', id: message.id, payload: { success: ok, message: ok ? 'Bind command sent' : 'Router not connected' } });
    }

    /** 处理 Router QR 绑定请求（前端请求生成二维码） */
    function handleRouterQRBind(client: GatewayClient, message: GatewayMessage): void {
        log.info({ connected: routerBridge.connected }, '[QR] handleRouterQRBind called');
        const ok = routerBridge.requestQRBind();
        log.info({ ok }, '[QR] requestQRBind result');
        send(client, { type: 'router.qr-bind', id: message.id, payload: { success: ok, message: ok ? 'QR bind request sent' : 'Router not connected' } });
    }

    // ========================
    // 微信 iLink 消息处理（独立于 Router）
    // ========================

    function handleWeixinConfigGet(client: GatewayClient, message: GatewayMessage): void {
        const wxCfg = loadWeixinConfig();
        const status = weixinBridge?.getStatus() || { connected: false, enabled: false, accountId: '' };
        // 重启后共享 Router 会话 ID
        if (!routerSessionId) {
            const allSessions = sessions.list();
            const existing = allSessions.find(s => s.title === 'Router Messages');
            if (existing) routerSessionId = existing.id;
        }
        const sessionId = routerSessionId || null;
        send(client, {
            type: 'weixin.config.get',
            id: message.id,
            payload: { ...wxCfg, ...status, sessionId },
        });
    }

    async function handleWeixinConfigUpdate(client: GatewayClient, message: GatewayMessage): Promise<void> {
        const payload = message.payload as Partial<WeixinConfigT> | undefined;
        if (!payload) {
            send(client, { type: 'weixin.config.update', id: message.id, payload: { success: false, message: 'Missing config' } });
            return;
        }
        try {
            const current = loadWeixinConfig() || {
                enabled: false, accountId: '', token: '',
                baseUrl: 'https://ilinkai.weixin.qq.com',
                cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
                dmPolicy: 'open' as const, allowedUsers: [] as string[],
            };
            const updated = { ...current, ...payload } as WeixinConfigT;
            saveWeixinConfig(updated);

            // 动态启停
            if (updated.enabled && updated.token && !weixinBridge) {
                const { WeixinBridge } = await import('./weixin-bridge');
                weixinBridge = new WeixinBridge(updated, workspace);
                setupWeixinMessageHandler();
                weixinBridge.start().catch(err => log.error('WeixinBridge start failed', { error: String(err) }));
                log.info('WeixinBridge dynamically started');
            } else if (!updated.enabled && weixinBridge) {
                weixinBridge.stop();
                weixinBridge = null;
                log.info('WeixinBridge dynamically stopped');
            } else if (weixinBridge) {
                weixinBridge.updateConfig(updated);
            }

            send(client, { type: 'weixin.config.update', id: message.id, payload: { success: true } });
        } catch (err) {
            send(client, { type: 'weixin.config.update', id: message.id, payload: { success: false, message: String(err) } });
        }
    }

    function handleWeixinStatusGet(client: GatewayClient, message: GatewayMessage): void {
        const status = weixinBridge?.getStatus() || { connected: false, enabled: false, accountId: '' };
        send(client, { type: 'weixin.status', id: message.id, payload: status });
    }

    async function handleWeixinQRLogin(client: GatewayClient, message: GatewayMessage): Promise<void> {
        try {
            if (!weixinBridge) {
                const { WeixinBridge } = await import('./weixin-bridge');
                const baseCfg: WeixinConfigT = {
                    enabled: false, accountId: '', token: '',
                    baseUrl: 'https://ilinkai.weixin.qq.com',
                    cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
                    dmPolicy: 'open', allowedUsers: [],
                };
                weixinBridge = new WeixinBridge(baseCfg, workspace);
                setupWeixinMessageHandler();
            }
            // 异步启动 QR 登录（不阻塞 WebSocket）
            weixinBridge.startQRLogin().catch(err => {
                log.error('QR login flow error', { error: String(err) });
                broadcastToClients({ type: 'weixin.qr_status', payload: { status: 'error', message: String(err) } });
            });
            send(client, { type: 'weixin.qr-login', id: message.id, payload: { success: true, message: 'QR login started' } });
        } catch (err) {
            send(client, { type: 'weixin.qr-login', id: message.id, payload: { success: false, message: String(err) } });
        }
    }

    function handleWeixinDisconnect(client: GatewayClient, message: GatewayMessage): void {
        if (weixinBridge) {
            weixinBridge.stop();
            weixinBridge = null;
            log.info('Weixin bridge disconnected by user');
        }
        send(client, { type: 'weixin.disconnect', id: message.id, payload: { success: true } });
    }

    async function handleWeixinTest(client: GatewayClient, message: GatewayMessage): Promise<void> {
        const wxCfg = loadWeixinConfig();
        const result = {
            configured: !!(wxCfg?.token && wxCfg?.accountId),
            enabled: wxCfg?.enabled ?? false,
            connected: weixinBridge?.connected ?? false,
        };
        send(client, { type: 'weixin.test', id: message.id, payload: result });
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
            log.info('Settings updated', { outputPath: runtimeSettings.outputPath });
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
            send(client, { type: 'setup.error', id: message.id, payload: { message: 'Missing required config (provider and API Key)' } });
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
                if (!config.agents) config.agents = { list: [{ id: 'default', default: true, name: 'General Assistant' }] } as any;
                if (payload.agentName) config.agents!.globalAgentName = payload.agentName;
                if (payload.agentPrompt) config.agents!.globalSystemPrompt = payload.agentPrompt;
                // 同步更新 UserAgentStore 中默认 Agent 的名称和提示（UI 侧边栏显示来源）
                userAgentStore.updateDefaultAgent({
                    name: payload.agentName,
                    systemPrompt: payload.agentPrompt,
                });
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
            saveServerConfig(workspace, config, localProvidersSnapshot || undefined);

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
                agentRunner = createAgentLoopRunner({ llm: newOrchLLM, fallbackLlm, tools, language: config.language });
                // 同步 Agent 全局设置到运行时（名称 + 系统提示）
                if (payload.agentName || payload.agentPrompt) {
                    agentManager.updateGlobalSettings({
                        globalAgentName: payload.agentName,
                        globalSystemPrompt: payload.agentPrompt,
                    });
                }
                // 同步更新 CardManager 的 chatLLM
                if (memoryManager && (memoryManager as any)._cardManager) {
                    (memoryManager as any)._cardManager.updateChatLLM(newOrchLLM);
                }
                log.info('First-time setup complete, LLM Provider created');
            } catch (llmErr) {
                log.warn('LLM recreation failed, may need restart', { error: String(llmErr) });
            }

            send(client, { type: 'setup.success', id: message.id, payload: { message: 'Setup complete' } });
        } catch (err) {
            log.error('First-time setup save failed', err);
            send(client, { type: 'setup.error', id: message.id, payload: { message: 'Save failed: ' + String(err) } });
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
            send(client, { type: 'config.error', id: message.id, payload: { message: 'Missing update content' } });
            return;
        }

        try {
            let needRecreateLLM = false;
            let needRecreateEmbedding = false;

            // 如果当前使用托管 LLM，先备份运行时 LLM 配置
            // 保存完成后需要恢复，避免前端传来的本地配置值覆盖运行时托管配置
            const managedLlmBackup = (llmSource !== 'local') ? JSON.parse(JSON.stringify(config.llm)) : null;
            const managedProvidersBackup = (llmSource !== 'local' && config.providers) ? JSON.parse(JSON.stringify(config.providers)) : null;

            // Helper: 向客户端推送配置更新进度
            const sendProgress = (step: string) => {
                send(client, { type: 'config.progress', id: message.id, payload: { step } });
            };

            // 1. 更新供应商密钥（写入内存 config）
            if (payload.providers) {
                sendProgress('正在更新供应商密钥...');
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
                log.info('Providers updated', {
                    updated: Object.keys(payload.providers!),
                    orchApiKey: maskApiKey(config.llm.orchestration.apiKey),
                    execApiKey: maskApiKey(config.llm.execution.apiKey),
                });
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
                log.info('Web search/fetch config updated', {
                    searchProvider: config.web.search?.provider,
                    maxResults: config.web.search?.maxResults,
                });
            }

            // 5. 更新 MCP Server 配置（仅处理 location='server' 的）
            if (payload.mcp?.servers !== undefined) {
                sendProgress('正在重载 MCP 服务...');
                const serverSideMcp = payload.mcp.servers.filter(s => (s as any).location !== 'client');
                config.mcp = {
                    servers: serverSideMcp.map(s => ({
                        ...s,
                        location: (s as any).location || 'server' as const,
                        enabled: s.enabled !== false,
                        timeout: 30,
                    })),
                };
                log.info('MCP config updated', { serverCount: serverSideMcp.length });

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
                        sendProgress('正在连接 MCP 服务...');
                        await mcpManager.initialize(payload.mcp.servers);
                        for (const t of mcpManager.getTools()) {
                            tools.register(t);
                        }
                        const serverInfo = mcpManager.getServerInfo();
                        log.info(`MCP hot-reload complete: ${serverInfo.map(s => `${s.name}(${s.toolCount})`).join(', ')}`);
                    }
                } catch (error) {
                    log.error('MCP hot-reload failed:', { error });
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
                // 同步全局设置到 AgentManager 运行时
                agentManager.updateGlobalSettings({
                    globalAgentName: config.agents.globalAgentName,
                    globalSystemPrompt: config.agents.globalSystemPrompt,
                });
                log.info('Global agent settings/skills/agent model updated');
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
                log.info('Sandbox config updated', { mode: sb.mode });
            }

            // 7. 持久化到 settings.json（服务端配置部分）
            saveServerConfig(workspace, config, localProvidersSnapshot || undefined);

            // 如果处于托管模式，恢复运行时 LLM 配置（避免前端传来的本地值污染运行时 config）
            if (managedLlmBackup) {
                config.llm = managedLlmBackup;
            }
            if (managedProvidersBackup) {
                (config as any).providers = managedProvidersBackup;
            }

            // 5. 如需重建 LLM Provider，更新 agentManager
            // 注意：仅在 llmSource === 'local' 时才重建，避免覆盖托管模式的 LLM 实例
            if (needRecreateLLM) {
                if (llmSource === 'local') {
                    sendProgress('正在重建 LLM 模型实例...');
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
                        agentRunner = createAgentLoopRunner({ llm: newOrchLLM, fallbackLlm, tools, language: config.language });
                        // 同步更新 CardManager 的 chatLLM
                        if (memoryManager && (memoryManager as any)._cardManager) {
                            (memoryManager as any)._cardManager.updateChatLLM(newOrchLLM);
                        }
                        log.info('LLM Provider hot-updated (including scheduler runner)', {
                            orchestration: `${config.llm.orchestration.provider}/${config.llm.orchestration.model}`,
                            execution: `${config.llm.execution.provider}/${config.llm.execution.model}`,
                        });
                    } catch (err) {
                        log.error('LLM Provider hot-update failed:', err);
                    }
                } else {
                    log.info('Skipped LLM rebuild: currently using managed source', { llmSource });
                }
            }

            // 7. 如需重建 Embedding LLM
            if (needRecreateEmbedding && memoryManager && config.memory?.enabled && config.llm.embedding) {
                sendProgress('正在更新 Embedding 模型...');
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
                    saveServerConfig(workspace, config, localProvidersSnapshot || undefined);

                    const embConfig = config.llm.embedding;
                    const embApiKey = embConfig.apiKey || process.env[`${embConfig.provider.toUpperCase()}_API_KEY`] || '';

                    if (!embApiKey && embConfig.provider !== 'local') {
                        log.warn(`Embedding provider '${embConfig.provider}' has no API Key, skipping Embedding LLM update. Set apiKey in embedding config or env var ${embConfig.provider.toUpperCase()}_API_KEY.`);
                    } else {
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

                    log.info('Embedding LLM updated', { provider, model, dim });
                    }
                } catch (err) {
                    log.error('Embedding LLM update failed:', err);
                }
            }

            send(client, {
                type: 'config.updated',
                id: message.id,
                payload: { success: true, message: '配置已保存并生效' },
            });
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log.error('Update server config failed:', err);
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
        log.info(`Client ${client.id} registered ${toolNames.length} MCP proxy tools: ${toolNames.join(', ')}`);
    }

    /**
     * 处理客户端取消注册 MCP 工具
     */
    function handleClientMcpUnregister(client: GatewayClient): void {
        if (client.clientMcpToolNames?.length) {
            for (const name of client.clientMcpToolNames) {
                tools.unregister(name);
            }
            log.info(`Client ${client.id} removed ${client.clientMcpToolNames.length} proxy tools`);
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
            log.warn(`Received unknown client MCP result: ${message.id}`);
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
     * 启动调试模式浏览器
     */
    async function handleBrowserLaunch(client: GatewayClient, message: GatewayMessage): Promise<void> {
        try {
            const success = await launchChromeWithDebugPort();
            send(client, {
                type: 'browser.launch',
                id: message.id,
                payload: { success, message: success ? 'Browser launched in debug mode' : 'Chrome is running without debug port. Please close Chrome first.' },
            });
            // 广播浏览器连接状态给所有客户端
            broadcastToClients({ type: 'browser.status', payload: getBrowserConnectionStatus() });
        } catch (error) {
            send(client, {
                type: 'browser.launch',
                id: message.id,
                payload: { success: false, message: error instanceof Error ? error.message : String(error) },
            });
        }
    }

    /**
     * 发送消息
     */
    function send(client: GatewayClient, message: GatewayMessage): void {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify(message));
        }
    }

    log.info('Standalone Gateway initialization complete');

    // 启动时自动探测 Chrome 调试端口
    initBrowserProbe().catch(() => { /* ignore */ });

    return {
        start(): Promise<void> {
            return new Promise((resolve) => {
                wss = new WebSocketServer({ port });
                wss.on('connection', handleConnection);
                wss.on('listening', () => {
                    log.info(`Standalone Gateway started: ws://localhost:${port}`);
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
                        log.info('Standalone Gateway stopped');
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

    // 全局未捕获 Promise rejection 保护（防止 Playwright 内部竞态导致进程崩溃）
    process.on('unhandledRejection', (reason: any) => {
        // Playwright ProtocolError（如 dialog 竞态）：仅记录警告，不崩溃
        if (reason?.constructor?.name === 'ProtocolError' ||
            (reason?.message && reason.message.includes('Protocol error'))) {
            log.warn('Playwright ProtocolError suppressed (non-fatal)', {
                message: reason.message || String(reason)
            });
            return;
        }
        // 其他未捕获 rejection：记录错误但不崩溃
        log.error('Unhandled promise rejection', {
            error: reason?.message || String(reason),
            stack: reason?.stack,
        });
    });

    // 优雅退出
    process.on('SIGINT', async () => {
        log.info('Received exit signal...');
        await gateway.stop();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        log.info('Received termination signal...');
        await gateway.stop();
        process.exit(0);
    });
}
