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
import { EvolutionDataManager, runMigrations } from '../evolution';

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
    /** 进化数据管理器 */
    evolutionData: EvolutionDataManager;
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
    log.info('OpenFlux starting...');

    // 1. 加载配置
    const config = await loadConfig();
    log.info('Configuration loaded');

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

    // 2.5 初始化进化数据层
    const evolutionData = new EvolutionDataManager(config.workspace || '.');
    await evolutionData.initialize();
    try {
        await runMigrations(evolutionData);
    } catch (e) {
        log.warn(`Evolution data migration failed, running without evolution data: ${e}`);
    }
    const manifest = evolutionData.refreshStats();
    log.info(`Evolution data ready: ${JSON.stringify(manifest.stats)}`);

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
    log.info(`Workflow engine initialized`);

    // 4. 添加 spawn 工具（临时版本，后续由 AgentManager 替换各 Agent 上下文中的 spawn）
    const defaultSubAgentExecutor = createSubAgentExecutor({
        llm,
        tools,
        onComplete: (result) => {
            log.info(`SubAgent completed: ${result.id}`, { status: result.status });
        },
    });
    const spawnTool = createSpawnTool({
        defaultTimeout: 300,
        maxConcurrent: 5,
        onExecute: defaultSubAgentExecutor,
    });
    tools.register(spawnTool);

    // 4.5 注册进化工具: skill_store + tool_forge
    const { createSkillStoreTool } = await import('../tools/skill-store');
    const { createToolForgeTool, loadConfirmedTools } = await import('../tools/tool-forge');

    // 延迟引用：AgentManager 在后面创建，但回调在这里注册
    let agentManagerRef: AgentManager | null = null;

    const skillStoreTool = createSkillStoreTool({
        evolutionData,
        onSkillInstalled: (skill) => {
            agentManagerRef?.addSkill(skill);
        },
        onSkillUninstalled: (skillId) => {
            agentManagerRef?.removeSkill(skillId);
        },
    });
    tools.register(skillStoreTool);

    // tool_forge 不再注册为 Agent 运行时工具
    // 工具创建应在任务完成后由用户手动触发（通过前端 UI / WebSocket API）
    // const toolForgeTool = createToolForgeTool({...});
    // tools.register(toolForgeTool);

    // 自定义工具也不再自动注入 Agent 工具列表（避免 token 膨胀）
    // 用户需要时可通过 tool_forge API 手动执行
    // const confirmedTools = loadConfirmedTools(evolutionData);

    log.info(`Tools registered, total: ${tools.getToolNames().length}`);

    // 5. 初始化会话存储
    const sessions = new SessionStore({
        storePath: config.workspace,
    });
    log.info('Session store initialized');

    // 6. 创建 AgentManager（多 Agent 核心）
    const agentManager = new AgentManager({
        config,
        tools,
        defaultLLM: llm,
        sessions,
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

    if (config.agents) {
        const agents = agentManager.getAgents();
        log.info(`Multi-Agent mode: ${agents.length} Agents, router: ${agentManager.isRouterEnabled() ? 'enabled' : 'disabled'}`);
    } else {
        log.info('Single Agent mode (agents not configured)');
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
    log.info('Scheduler started');

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
        log.info(`Gateway started: ws://localhost:${config.remote?.port || 18801}`);
    };

    const stopGateway = async () => {
        if (!gateway) return;
        await gateway.stop();
        gateway = null;
        log.info('Gateway stopped');
    };

    log.info('OpenFlux initialization complete');

    return {
        config,
        llm,
        tools,
        agentManager,
        sessions,
        scheduler,
        evolutionData,
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
