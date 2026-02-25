/**
 * OpenFlux 核心 Bootstrap
 * 初始化所有模块并提供统一入口
 * 支持多 Agent 模式（通过 AgentManager）
 */

import { join } from 'path';
import { loadConfig } from '../config/loader';
import type { OpenFluxConfig } from '../config/schema';
import { ToolRegistry } from '../tools/registry';
import { createSpawnTool } from '../tools/spawn';
import { createLLMProvider } from '../llm/factory';
import { createAgentLoopRunner } from '../agent/loop';
import { createSubAgentExecutor } from '../agent/subagent';
import { AgentManager } from '../agent/manager';
import { SessionStore } from '../sessions';
import { createGatewayServer, type AgentProgressEvent } from '../gateway';
import { WorkflowEngine } from '../workflow';
import { Scheduler, SchedulerStore } from '../scheduler';
import { Logger } from '../utils/logger';
import type { LLMProvider } from '../llm/provider';

const log = new Logger('Bootstrap');

/**
 * OpenFlux 实例
 */
export interface OpenFlux {
    /** 配置 */
    config: OpenFluxConfig;
    /** 默认 LLM Provider */
    llm: LLMProvider;
    /** 全量工具注册表（未过滤） */
    tools: ToolRegistry;
    /** Agent 管理器（多 Agent 模式核心） */
    agentManager: AgentManager;
    /** 会话存储 */
    sessions: SessionStore;
    /** 调度器 */
    scheduler: Scheduler;
    /** Gateway 服务 */
    gateway: ReturnType<typeof createGatewayServer> | null;
    /** 运行 Agent（支持进度回调、agentId 路由和文件附件） */
    run: (
        input: string,
        sessionId?: string,
        onProgress?: (event: AgentProgressEvent) => void,
        agentId?: string,
        attachments?: Array<{ path: string; name: string; size: number; ext: string }>
    ) => Promise<string>;
    /** 启动 Gateway */
    startGateway: () => Promise<void>;
    /** 停止 Gateway */
    stopGateway: () => Promise<void>;
}

/**
 * 初始化 OpenFlux
 */
export async function bootstrap(): Promise<OpenFlux> {
    log.info('OpenFlux 启动中...');

    // 1. 加载配置
    const config = await loadConfig();
    log.info('配置加载完成');

    // 2. 初始化默认 LLM Provider（使用 orchestration 配置）
    const llmConfig = config.llm.orchestration;
    const llm = createLLMProvider({
        provider: llmConfig.provider,
        model: llmConfig.model,
        apiKey: llmConfig.apiKey || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || '',
        baseUrl: llmConfig.baseUrl,
        temperature: llmConfig.temperature,
        maxTokens: llmConfig.maxTokens,
    });
    log.info(`LLM Provider: ${llmConfig.provider}/${llmConfig.model}`);

    // 3. 初始化全量工具注册表 + 工作流引擎
    const tools = new ToolRegistry();

    const { WorkflowStore } = await import('../workflow/workflow-store');
    const workflowStore = new WorkflowStore(join(config.workspace || '.', '.workflows'));
    const workflowEngine = new WorkflowEngine({ tools, llm, store: workflowStore });

    // 创建调度器存储和实例
    const schedulerStore = new SchedulerStore({ storePath: config.workspace || '.' });
    let schedulerAgentExecute: (prompt: string, sessionId?: string) => Promise<string>;
    const scheduler = new Scheduler({
        store: schedulerStore,
        onAgentExecute: (prompt, sessionId) => schedulerAgentExecute(prompt, sessionId),
    });

    tools.registerDefaults({
        browser: { headless: config.browser?.headless ?? true } as any,
        workflow: { engine: workflowEngine },
        scheduler: { scheduler },
        webSearch: config.web?.search,
        webFetch: config.web?.fetch,
    });
    log.info(`工作流引擎初始化完成`);

    // 4. 添加 spawn 工具（临时版本，后续由 AgentManager 替换各 Agent 上下文中的 spawn）
    const defaultSubAgentExecutor = createSubAgentExecutor({
        llm,
        tools,
        onComplete: (result) => {
            log.info(`SubAgent 完成: ${result.id}`, { status: result.status });
        },
    });
    const spawnTool = createSpawnTool({
        defaultTimeout: 300,
        maxConcurrent: 5,
        onExecute: defaultSubAgentExecutor,
    });
    tools.register(spawnTool);
    log.info(`工具注册完成，共 ${tools.getToolNames().length} 个`);

    // 5. 初始化会话存储
    const sessions = new SessionStore({
        storePath: config.workspace,
    });
    log.info('会话存储初始化完成');

    // 6. 创建 AgentManager（多 Agent 核心）
    const agentManager = new AgentManager({
        config,
        tools,
        defaultLLM: llm,
        sessions,
    });

    if (config.agents) {
        const agents = agentManager.getAgents();
        log.info(`多 Agent 模式: ${agents.length} 个 Agent, 路由: ${agentManager.isRouterEnabled() ? '启用' : '禁用'}`);
    } else {
        log.info('单 Agent 模式（未配置 agents）');
    }

    // 7. 运行函数（支持进度回调 + agentId 路由 + 文件附件）
    const run = async (
        input: string,
        sessionId?: string,
        onProgress?: (event: AgentProgressEvent) => void,
        agentId?: string,
        attachments?: Array<{ path: string; name: string; size: number; ext: string }>
    ): Promise<string> => {
        const result = await agentManager.run(input, agentId, sessionId, onProgress, attachments);
        return result.output;
    };

    // 绑定调度器的 Agent 执行回调
    schedulerAgentExecute = run;

    // 8. 启动调度器
    scheduler.start();
    log.info('调度器启动完成');

    // 9. Gateway 服务
    let gateway: ReturnType<typeof createGatewayServer> | null = null;

    const startGateway = async () => {
        if (gateway) return;

        gateway = createGatewayServer({
            port: config.remote?.port || 18801,
            token: config.remote?.token,
            onAgentExecute: run,
            agentManager,
        });

        await gateway.start();
        log.info(`Gateway 启动: ws://localhost:${config.remote?.port || 18801}`);
    };

    const stopGateway = async () => {
        if (!gateway) return;
        await gateway.stop();
        gateway = null;
        log.info('Gateway 停止');
    };

    log.info('OpenFlux 初始化完成');

    return {
        config,
        llm,
        tools,
        agentManager,
        sessions,
        scheduler,
        gateway,
        run,
        startGateway,
        stopGateway,
    };
}

/**
 * 快速启动（含 Gateway）
 */
export async function quickStart(): Promise<OpenFlux> {
    const bot = await bootstrap();
    await bot.startGateway();
    return bot;
}
