/**
 * OpenFlux Core Bootstrap
 * Initialize all modules and provide unified entry
 * Supports multi-Agent mode (via AgentManager)
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
import { getPythonExePath, getUvExePath, isPythonReady, logPythonEnvStatus } from '../utils/python-env';
import { getEnvProbe, runEnvProbe } from '../utils/env-probe';
import { PermissionChecker, RiskLevel } from '../permissions/checker';

const log = new Logger('Bootstrap');

/**
 * OpenFlux instance
 */
export interface OpenFlux {
    /** configuration */
    config: OpenFluxConfig;
    /** Default LLM Provider */
    llm: LLMProvider;
    /** Full tool registry (unfiltered) */
    tools: ToolRegistry;
    /** Agent Manager (Multi-Agent Mode Core) */
    agentManager: AgentManager;
    /** Session storage */
    sessions: SessionStore;
    /** Scheduler */
    scheduler: Scheduler;
    /** Evolution data manager */
    evolutionData: EvolutionDataManager;
    /** Gateway service */
    gateway: ReturnType<typeof createGatewayServer> | null;
    /** Run Agent (supports progress callback, agentId routing and file attachment) */
    run: (
        input: string,
        sessionId?: string,
        onProgress?: (event: AgentProgressEvent) => void,
        agentId?: string,
        attachments?: Array<{ path: string; name: string; size: number; ext: string }>
    ) => Promise<string>;
    /** Start Gateway */
    startGateway: () => Promise<void>;
    /** Stop Gateway */
    stopGateway: () => Promise<void>;
}

/**
 * Initialize OpenFlux
 */
export async function bootstrap(): Promise<OpenFlux> {
    log.info('OpenFlux starting...');

    // Keep the non-standalone bootstrap feature-equivalent with the desktop Gateway.
    runEnvProbe();

    // 1. Load configuration
    const config = await loadConfig();
    log.info('Configuration loaded');

    // 2. Initialize the default LLM Provider (configured using orchestration)
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

    // 2.5 Initialize the evolutionary data layer
    const evolutionData = new EvolutionDataManager(config.workspace || '.');
    await evolutionData.initialize();
    try {
        await runMigrations(evolutionData);
    } catch (e) {
        log.warn(`Evolution data migration failed, running without evolution data: ${e}`);
    }
    const manifest = evolutionData.refreshStats();
    log.info(`Evolution data ready: ${JSON.stringify(manifest.stats)}`);

    // 3. Initialize the full tool registry + workflow engine
    const tools = new ToolRegistry({
        permissionChecker: new PermissionChecker(config.permissions?.autoApproveLevel as RiskLevel),
    });

    const { WorkflowStore } = await import('../workflow/workflow-store');
    const workflowStore = new WorkflowStore(join(config.workspace || '.', '.workflows'));
    const workflowEngine = new WorkflowEngine({ tools, llm, store: workflowStore });

    // Create scheduler storage and instance
    const schedulerStore = new SchedulerStore({ storePath: config.workspace || '.' });
    let schedulerAgentExecute: (prompt: string, sessionId?: string) => Promise<string>;
    const scheduler = new Scheduler({
        store: schedulerStore,
        onAgentExecute: (prompt, sessionId) => schedulerAgentExecute(prompt, sessionId),
    });

    // Detect the built-in Python environment
    logPythonEnvStatus();
    const pythonExe = isPythonReady() ? getPythonExePath() : undefined;
    const uvExe = isPythonReady() ? getUvExePath() : undefined;
    if (pythonExe) {
        log.info('Built-in Python will be used for process tool', { pythonExe });
    } else {
        log.warn('Built-in Python not found, process tool will use system Python (not recommended)');
    }

    tools.registerDefaults({
        process: {
            pythonExe,
            uvExe,
        },
        browser: { headless: config.browser?.headless ?? true } as any,
        workflow: { engine: workflowEngine },
        scheduler: { scheduler },
        webSearch: config.web?.search,
        webFetch: config.web?.fetch,
        videoGen: {
            getOutputPath: () => config.workspace || process.cwd(),
            getFfmpegPath: () => getEnvProbe().tools.ffmpeg?.path,
        },
    });
    log.info(`Workflow engine initialized`);

    // 4. Add spawn tool (temporary version, spawn in each Agent context will be replaced by AgentManager later)
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

    // 4.5 Register evolution tool: skill_store + tool_forge
    const { createSkillStoreTool } = await import('../tools/skill-store');
    const { createToolForgeTool, loadConfirmedTools } = await import('../tools/tool-forge');

    // Deferred reference: AgentManager is created later, but callback is registered here
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

    // tool_forge is no longer registered as an Agent runtime tool
    // Tool creation should be manually triggered by the user after task completion (via frontend UI/WebSocket API)
    // const toolForgeTool = createToolForgeTool({...});
    // tools.register(toolForgeTool);

    // Custom tools are no longer automatically injected into the Agent tool list (to avoid token expansion)
    // Users can execute it manually through tool_forge API when needed
    // const confirmedTools = loadConfirmedTools(evolutionData);

    log.info(`Tools registered, total: ${tools.getToolNames().length}`);

    // 5. Initialize session storage
    const sessions = new SessionStore({
        storePath: config.workspace,
    });
    log.info('Session store initialized');

    // 6. Create AgentManager (multi-Agent core)
    const agentManager = new AgentManager({
        config,
        tools,
        defaultLLM: llm,
        sessions,
    });
    agentManagerRef = agentManager;

    // 6.1 Start loading: Inject installed skills into AgentManager
    {
        const { parseSkillMd, toOpenFluxSkill } = await import('../tools/skill-store/parser');
        const { toSkillRuntimeId } = await import('../evolution/data-manager');
        const installedSkills = evolutionData.listInstalledSkills();
        for (const meta of installedSkills) {
            const content = evolutionData.readSkillContent(meta.slug);
            if (content) {
                const parsed = parseSkillMd(content);
                agentManager.addSkill(toOpenFluxSkill(parsed, meta.runtimeSkillId || toSkillRuntimeId(meta.storageSlug || meta.remoteSlug || meta.slug)));
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

    // 7. Run function (supports progress callback + agentId routing + file attachment)
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

    // Agent execution callback bound to the scheduler
    schedulerAgentExecute = run;

    // 8. Start the scheduler
    scheduler.start();
    log.info('Scheduler started');

    // 9. Gateway service
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
 * Quick Start (including Gateway)
 */
export async function quickStart(): Promise<OpenFlux> {
    const bot = await bootstrap();
    await bot.startGateway();
    return bot;
}
