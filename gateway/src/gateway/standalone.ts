/**
 * Standalone Gateway Server
 * Built-in Agent Loop, client connects through WebSocket
 */

// @ts-ignore - Runtime with ws module
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, copyFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, resolve as resolvePath } from 'path';
import { loadConfig } from '../config/loader';
import { ToolRegistry } from '../tools/registry';
import type { ImageGenRuntimeConfig } from '../tools/registry';
import type { Tool, ToolResult, ToolParameter, ToolApprovalDecision, ToolApprovalRequest } from '../tools/types';
import { createSpawnTool } from '../tools/spawn';
import { createLLMProvider } from '../llm/factory';
import { LLMError } from '../llm/llm-error';
import { createAtlasGatewayFetch } from '../llm/atlas-transport';
import { createAgentLoopRunner } from '../agent/loop';
import { createSubAgentExecutor } from '../agent/subagent';
import { AgentManager } from '../agent/manager';
import { UserAgentStore, type UserAgent } from '../agent/user-agent-store';
import { ProjectStore, buildProjectSystemPrompt, isProjectEntityId, normalizeProjectWorkspace, type UserProject } from '../agent/project-store';
import { SessionStore } from '../sessions';
import { TurnQueueStore, type TurnQueueItem } from '../sessions/turn-queue-store';
import { recoverInterruptedTurnsAfterRestart } from '../sessions/turn-recovery';
import { WorkflowEngine } from '../workflow';
import { Scheduler, SchedulerStore } from '../scheduler';
import type { SchedulerEvent, ScheduledTaskMeta } from '../scheduler';
import { Logger, onLogBroadcast, installConsoleCapture, incrementDebugSubscribers, decrementDebugSubscribers, type LogEntry } from '../utils/logger';
import { detectSystemEncoding } from '../utils/system-encoding';
import { initializeEnvProbe, runEnvProbeAsync, getEnvProbe, formatNow, getTodayStr, formatDate } from '../utils/env-probe';
// ── Heavy modules: lazy loading (reduces startup memory) ──────────────────────────
// The following modules are loaded on demand within createStandaloneGateway() await import()
// Keep only type import (zero runtime overhead)
import type { McpServerConfig } from '../tools/mcp-client';
import type { OpenFluxChatProgressEvent, AtlasOpenFluxRuntime, FetchUserInfoResult } from './openflux-chat-bridge';
import type { RouterConfig, RouterInboundMessage, RouterOutboundMessage, ManagedRuntimeConfigMessage } from './router-bridge';
import type { ForgeSuggestion } from '../evolution';
import type { LLMPolicyRetry, LLMProtocol, LLMProvider } from '../llm/provider';
import {
    ExecutionRegistry,
    ExecutionAbortedError,
    QueuedExecutionCanceledError,
    type ActiveExecution,
    type ExecutionHandle,
} from './execution-registry';
import { MessageRouter } from './message-router';
import {
    bindToolApprovalToVisibleTurn,
    ToolApprovalBroker,
    type ToolApprovalClientIdentity,
} from './tool-approval-broker';
import {
    getAgentExecutionContext,
    runWithAgentExecutionContext,
    type DrainGoalRevisions,
    type DrainSteering,
    type GoalRevisionMessage,
    type OnIntentInvalidated,
} from '../runtime/execution-context';
import { TurnTracker } from '../runtime/turn-tracker';
import { toPublicAgentRuntimeEvent } from '../runtime/events';
import { isToolResultFailure } from '../runtime/activity-descriptor';
import {
    createInitialGoalState,
    reconcileGoalState,
    type GoalInstruction,
    type GoalRevision,
    type GoalState,
} from '../runtime/goal-reconciler';
import { telemetry } from '../observability/telemetry';
import { PlanStore } from '../work/store';
import type { PlanDocument, PlanQuestion, PlanQuestionAnswer, WorkMode } from '../work/types';
import type { ExecutionWorkMode } from '../work/policy';
import { createPublishPlanDocumentTool, createRequestPlanInputTool } from '../tools/plan-control';
import { createProjectSearchTool } from '../tools/project-search';
import {
    DEFAULT_APPROVAL_MODE,
    PermissionChecker,
    RiskLevel,
    isApprovalMode,
    normalizeApprovalMode,
    type ApprovalMode,
} from '../permissions/checker';

// Value imports lazy loading, type placeholder
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
 * Runtime settings (can be dynamically modified by the client)
 */
interface RuntimeSettings {
    outputPath: string;
}

/**
 * Load or create settings.json
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
        // Parsing failed, using default value
    }

    return { outputPath: defaultOutputPath };
}

/**
 * Persistence settings.json
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
        // Preserve _setupSkipped flag from existing file to avoid wiping it on config save
        let preservedSetupSkipped = false;
        if (existsSync(configPath)) {
            try {
                const existing = JSON.parse(readFileSync(configPath, 'utf-8'));
                if (existing._setupSkipped) preservedSetupSkipped = true;
            } catch { /* ignore read errors */ }
        }

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
        // Save global character settings, skills, and agent models
        if (config.agents?.globalAgentName || config.agents?.globalSystemPrompt || config.agents?.skills || config.agents?.list) {
            const agentsData: Record<string, unknown> = {
                globalAgentName: config.agents.globalAgentName || undefined,
                globalSystemPrompt: config.agents.globalSystemPrompt || undefined,
                skills: config.agents.skills || undefined,
            };
            // Only save agents with custom models
            const agentModels = (config.agents.list || []).filter((a: any) => a.model).map((a: any) => ({
                id: a.id,
                model: { provider: a.model.provider, model: a.model.model },
            }));
            if (agentModels.length > 0) {
                agentsData.agentModels = agentModels;
            }
            data.agents = agentsData;
        }
        // Save Router configuration
        if (config.router) {
            data.router = config.router;
        }
        // Save web configuration
        if (config.web) {
            data.web = config.web;
        }
        // Save sandbox configuration
        if (config.sandbox) {
            data.sandbox = config.sandbox;
        }
        // Save MCP configuration
        if (config.mcp) {
            data.mcp = config.mcp;
        }
        // Save preset model list
        if (config.presetModels) {
            data.presetModels = config.presetModels;
        }
        // Save image generation model (local source)
        if (config.imageGeneration) {
            data.imageGeneration = config.imageGeneration;
        }
        // Re-apply preserved _setupSkipped so it is never lost on subsequent saves
        if (preservedSetupSkipped) {
            data._setupSkipped = true;
        }
        writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
        console.error('[ServerConfig] Save failed:', err);
    }
}

/**
 * Load server-config.json at startup and merge into config (UI settings override openflux.yaml)
 */
function mergeServerConfig(workspace: string, config: any): void {
    const configPath = join(workspace, 'server-config.json');
    try {
        if (!existsSync(configPath)) return;
        const raw = readFileSync(configPath, 'utf-8');
        const saved = JSON.parse(raw);

        // Merge providers (API Key, etc.)
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

        // Merge LLM configuration
        if (saved.llm) {
            if (saved.llm.orchestration) {
                Object.assign(config.llm.orchestration, saved.llm.orchestration);
            }
            if (saved.llm.execution) {
                Object.assign(config.llm.execution, saved.llm.execution);
            }
            // embedding has been fixed to the local model and is not restored from saved settings
            // if (saved.llm.embedding) { ... }
        }

        // Merge global character settings, skills and agent models
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
            // Restore Agent custom model
            if (saved.agents.agentModels && config.agents.list) {
                for (const am of saved.agents.agentModels) {
                    const agent = config.agents.list.find((a: any) => a.id === am.id);
                    if (agent && am.model) {
                        agent.model = am.model;
                    }
                }
            }
        }

        // Merge web configuration
        if (saved.web) {
            config.web = { ...config.web, ...saved.web };
        }

        // Merge sandbox configuration
        if (saved.sandbox) {
            config.sandbox = { ...config.sandbox, ...saved.sandbox };
        }

        // Merge Router config
        // When white-label locked (brandLock.services), the baked-in router is authoritative; ignore server-config.json override
        const servicesLocked = config.brandLock?.services === true;
        if (saved.router && !servicesLocked) {
            config.router = saved.router;
        } else if (saved.router && servicesLocked) {
            // Addresses/credentials stay locked, but the per-device appUserId is runtime identity,
            // not a brand service address — keep it so each enterprise client connects to the
            // Router with a unique connection key instead of replacing each other.
            if (saved.router.appUserId && config.router && !config.router.appUserId) {
                config.router.appUserId = saved.router.appUserId;
            }
            log.info('Router config locked by brand, ignoring server-config.json override (appUserId preserved)');
        }

        // Merge NexusAI config (also protected by the lock)
        if (saved.nexusai && !servicesLocked) {
            config.nexusai = { ...config.nexusai, ...saved.nexusai };
        } else if (saved.nexusai && servicesLocked) {
            log.info('NexusAI config locked by brand, ignoring server-config.json override');
        }

        // Merge MCP configuration
        
        if (saved.mcp) {
            config.mcp = { ...config.mcp, ...saved.mcp };
        }

        // Merge preset model list
        if (saved.presetModels) {
            config.presetModels = saved.presetModels;
        }

        // Merge image generation model (local source)
        if (saved.imageGeneration) {
            config.imageGeneration = { ...config.imageGeneration, ...saved.imageGeneration };
        }

        // Restore language setting
        if (saved.language) {
            config.language = saved.language;
        }

        // After merging providers, resynchronize provider's apiKey/baseUrl to llm configuration
        // Solve the overwriting problem caused by mergeProvider of loader.ts being executed before mergeServerConfig
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
        // File does not exist or parsing failed, ignored
    }
}

/**
 * Upgrade and migration of old users:
 * 1. Copy the historical sessions of the old path (~/.openflux/sessions) to the new workspace/sessions
 * 2. Remap agentId "default" to the id of the first user agent
 * Design principles: idempotent (safe for multiple executions), only migrate when the new path is empty (to avoid overwriting new data)
 */
function migrateSessionsIfNeeded(workspace: string): void {
    const migrateLog = new Logger('SessionMigration');
    const oldPath = join(homedir(), '.openflux', 'sessions');
    const newPath = join(workspace, 'sessions');

    // Step 0: Migration of old app data directory (0.5.x -> 0.6.0)
    // 0.5.x stores all data in %APPDATA%/com.openflux.app/
    // 0.6.0 Migrate workspace data to %APPDATA%/OpenFlux/ (or user-defined path)
    // Configurations such as router and user_agents (including systemPrompt) need to be automatically merged.
    try {
        const appDataDir = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
        const oldAppDir = join(appDataDir, 'com.openflux.app');
        const oldServerConfig = join(oldAppDir, 'server-config.json');
        const newServerConfig = join(workspace, 'server-config.json');

        if (existsSync(oldServerConfig) && existsSync(newServerConfig)) {
            const stripBom = (s: string) => s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
            const oldCfg = JSON.parse(stripBom(readFileSync(oldServerConfig, 'utf-8')));
            const newCfg = JSON.parse(stripBom(readFileSync(newServerConfig, 'utf-8')));
            let changed = false;

            // Merge router configuration (including appId/apiKey/appUserId)
            if (oldCfg.router && !newCfg.router) {
                newCfg.router = oldCfg.router;
                changed = true;
                migrateLog.info('Step0: Migrated router config from legacy app data dir');
            }

            // Merge _llmSource (managed/local mode tag)
            if (oldCfg._llmSource && !newCfg._llmSource) {
                newCfg._llmSource = oldCfg._llmSource;
                changed = true;
            }

            if (changed) {
                writeFileSync(newServerConfig, JSON.stringify(newCfg, null, 2), 'utf-8');
                migrateLog.info('Step0: server-config.json merged from legacy path');
            }
        }

        // Merge old user_agents.json (may contain more complete data such as systemPrompt, custom icons, etc.)
        const oldUaPath = join(oldAppDir, 'user_agents.json');
        const newUaPath = join(workspace, 'user_agents.json');
        if (existsSync(oldUaPath) && existsSync(newUaPath)) {
            const stripBom = (s: string) => s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
            const oldUa = JSON.parse(stripBom(readFileSync(oldUaPath, 'utf-8')));
            const newUa = JSON.parse(stripBom(readFileSync(newUaPath, 'utf-8')));
            const newIds = new Map<string, any>((newUa.agents || []).map((a: any) => [a.id, a]));
            // 用户删除过的 Agent：不从旧数据目录合并回来
            const deletedUaIds = new Set<string>((newUa.deletedAgentIds || []).map(String));
            let uaChanged = false;

            for (const agent of (oldUa.agents || [])) {
                if (!newIds.has(agent.id)) {
                    if (deletedUaIds.has(String(agent.id))) continue;
                    // The new version does not have this agent, please add it directly
                    newUa.agents.push(agent);
                    uaChanged = true;
                } else {
                    // New versions have this agent, but older versions may have more complete data (systemPrompt, etc.)
                    const existing = newIds.get(agent.id);
                    if (agent.systemPrompt && !existing.systemPrompt) {
                        existing.systemPrompt = agent.systemPrompt;
                        uaChanged = true;
                    }
                    if (agent.icon && existing.icon === '🤖' && agent.icon !== '🤖') {
                        existing.icon = agent.icon;
                        uaChanged = true;
                    }
                    if (agent.name && agent.name !== existing.name) {
                        existing.name = agent.name;
                        uaChanged = true;
                    }
                }
            }

            if (uaChanged) {
                writeFileSync(newUaPath, JSON.stringify(newUa, null, 2), 'utf-8');
                migrateLog.info('Step0: user_agents.json enriched from legacy app data dir');
            }
        }
    } catch (e) {
        migrateLog.warn('Step0 legacy app data migration failed (non-fatal)', { error: String(e) });
    }

    // Step 1: Path migration (old -> new), executed only when the old path has data and the new path is empty
    try {
        const oldFiles = existsSync(oldPath)
            ? readdirSync(oldPath).filter(f => f.endsWith('.meta.json'))
            : [];
        const newFiles = existsSync(newPath)
            ? readdirSync(newPath).filter(f => f.endsWith('.meta.json'))
            : [];

        if (oldFiles.length > 0 && newFiles.length === 0) {
            migrateLog.info(`Migrating ${oldFiles.length} sessions from legacy path: ${oldPath} → ${newPath}`);
            mkdirSync(newPath, { recursive: true });
            for (const file of readdirSync(oldPath)) {
                try {
                    copyFileSync(join(oldPath, file), join(newPath, file));
                } catch (e) {
                    migrateLog.warn(`Failed to copy session file: ${file}`, { error: String(e) });
                }
            }
            migrateLog.info('Session path migration complete');
        }
    } catch (e) {
        migrateLog.warn('Session path migration failed (non-fatal)', { error: String(e) });
    }

    // Step 2: agentId remapping ("default" -> the id of the first user agent)
    // The old version sessions use agentId: "default" (YAML agent), the new version UI displays the agent in user_agents.json
    try {
        const userAgentsPath = join(workspace, 'user_agents.json');
        if (!existsSync(userAgentsPath) || !existsSync(newPath)) return;

        const userAgents = JSON.parse(readFileSync(userAgentsPath, 'utf-8'));
        const firstAgentId: string | undefined = userAgents?.agents?.[0]?.id;
        if (!firstAgentId || firstAgentId === 'default') return; // Already the correct id, skip

        let patchCount = 0;
        for (const file of readdirSync(newPath).filter(f => f.endsWith('.meta.json'))) {
            try {
                const filePath = join(newPath, file);
                const meta = JSON.parse(readFileSync(filePath, 'utf-8'));
                if (meta.agentId === 'default') {
                    meta.agentId = firstAgentId;
                    writeFileSync(filePath, JSON.stringify(meta, null, 2), 'utf-8');
                    patchCount++;
                }
            } catch { /* Skip corrupt files */ }
        }
        if (patchCount > 0) {
            migrateLog.info(`Remapped ${patchCount} sessions: agentId "default" → "${firstAgentId}"`);
        }
    } catch (e) {
        migrateLog.warn('Session agentId remap failed (non-fatal)', { error: String(e) });
    }

    // Step 3: Session Key format migration (user-agent:X -> agent:X:main) + automatic registration of custom agent
    // The new version of Gateway uses the format agent:{agentId}:{scope} (such as agent:main:main),
    // Older versions use user-agent:{agentId} format (such as user-agent:main).
    // Need to rename the file from user-agent_X.* to agent_X_main.*, update meta.json,
    // And automatically add non-built-in custom agents to user_agents.json.
    try {
        if (!existsSync(newPath)) return;
        const allFiles = readdirSync(newPath);
        const oldMetaFiles = allFiles.filter(f => f.startsWith('user-agent_') && f.endsWith('.meta.json'));

        // Read user_agents.json to supplement custom agents
        const userAgentsPath = join(workspace, 'user_agents.json');
        let userAgentsData: any = { version: 1, agents: [] };
        if (existsSync(userAgentsPath)) {
            try { userAgentsData = JSON.parse(readFileSync(userAgentsPath, 'utf-8')); } catch { /* ignore */ }
        }
        const knownAgentIds = new Set((userAgentsData.agents || []).map((a: any) => String(a.id)));
        const builtinIds = new Set(['main', 'default', 'coder', 'automation', 'general']);
        // 用户删除过的 Agent：不从历史会话自动恢复
        const deletedAgentIds = new Set<string>((userAgentsData.deletedAgentIds || []).map(String));

        let renameCount = 0;
        let agentAddCount = 0;
        for (const metaFile of oldMetaFiles) {
            try {
                // Extract old agentId from filename, e.g. user-agent_main.meta.json -> main
                const baseName = metaFile.replace(/^user-agent_/, '').replace(/\.meta\.json$/, '');
                // Project sessions deliberately keep the compatibility key but are owned by ProjectStore.
                // Never migrate or auto-register them as ordinary Agents.
                if (isProjectEntityId(baseName)) continue;
                const newBaseName = `agent_${baseName}_main`;
                const oldId = `user-agent:${baseName}`;
                const newId = `agent:${baseName}:main`;

                // If the new format file already exists, skip it (to avoid overwriting)
                if (existsSync(join(newPath, `${newBaseName}.meta.json`))) continue;

                // Copy all relevant files (.jsonl,.meta.json,.logs.json,.artifacts.json)
                const extensions = ['.jsonl', '.meta.json', '.logs.json', '.artifacts.json'];
                for (const ext of extensions) {
                    const oldFile = join(newPath, `user-agent_${baseName}${ext}`);
                    const newFile = join(newPath, `${newBaseName}${ext}`);
                    if (existsSync(oldFile) && !existsSync(newFile)) {
                        copyFileSync(oldFile, newFile);
                    }
                }

                // Update the id and agentId fields in meta.json
                const newMetaPath = join(newPath, `${newBaseName}.meta.json`);
                if (existsSync(newMetaPath)) {
                    const meta = JSON.parse(readFileSync(newMetaPath, 'utf-8'));
                    let changed = false;
                    if (meta.id === oldId) { meta.id = newId; changed = true; }
                    // agentId should be the agent's own ID (baseName), no matter what the original value is
                    if (meta.agentId !== baseName) { meta.agentId = baseName; changed = true; }
                    if (changed) writeFileSync(newMetaPath, JSON.stringify(meta, null, 2), 'utf-8');
                    // Extract session header for agent name
                    if (meta.title && !knownAgentIds.has(baseName) && !builtinIds.has(baseName) && !deletedAgentIds.has(baseName)) {
                        const colors = ['#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ef4444', '#ec4899'];
                        const icons = ['🏪', '🛍️', '💼', '📊', '🔧', '🤖'];
                        const idx = agentAddCount % colors.length;
                        userAgentsData.agents.push({
                            id: baseName,
                            name: meta.title,
                            description: `${meta.title}（自动从历史数据恢复）`,
                            icon: icons[idx],
                            color: colors[idx],
                            default: false,
                            createdAt: meta.createdAt || Date.now(),
                            updatedAt: meta.updatedAt || Date.now(),
                        });
                        knownAgentIds.add(baseName);
                        agentAddCount++;
                    }
                }
                renameCount++;
            } catch { /* Skipping individual files failed */ }
        }
        // Write back user_agents.json (when a new agent is added)
        if (agentAddCount > 0) {
            writeFileSync(userAgentsPath, JSON.stringify(userAgentsData, null, 2), 'utf-8');
            migrateLog.info(`Auto-registered ${agentAddCount} custom agents from legacy sessions`);
        }
        if (renameCount > 0) {
            migrateLog.info(`Converted ${renameCount} sessions: user-agent:X -> agent:X:main format`);
        }
    } catch (e) {
        migrateLog.warn('Session key format migration failed (non-fatal)', { error: String(e) });
    }

    // Step 4: Fully scan the migrated agent_*_main.meta.json and complete the missing custom agents in user_agents.json
    // Step 3 will be skipped if the new format file already exists (to avoid repeated migration), but the registration of user_agents.json may be missed.
    // Step 4: Run independently, scan every time it is started, idempotent and safe.
    try {
        if (!existsSync(newPath)) return;
        const userAgentsPath = join(workspace, 'user_agents.json');
        if (!existsSync(userAgentsPath)) return;

        const userAgentsData = JSON.parse(readFileSync(userAgentsPath, 'utf-8'));
        const knownIds = new Set((userAgentsData.agents || []).map((a: any) => String(a.id)));
        const builtinIds = new Set(['main', 'default', 'coder', 'automation', 'general']);
        // 用户删除过的 Agent：session 文件还在也不能复活
        const deletedIds = new Set<string>((userAgentsData.deletedAgentIds || []).map(String));

        const colors = ['#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ef4444', '#ec4899'];
        const icons = ['🏪', '🛍️', '💼', '📊', '🔧', '🤖'];
        let addCount = 0;

        const migratedMetas = readdirSync(newPath).filter(
            f => f.startsWith('agent_') && f.endsWith('_main.meta.json')
        );
        for (const f of migratedMetas) {
            try {
                // Extract agentId: agent_{agentId}_main.meta.json
                const agentId = f.replace(/^agent_/, '').replace(/_main\.meta\.json$/, '');
                if (isProjectEntityId(agentId)) continue;
                if (builtinIds.has(agentId) || knownIds.has(agentId) || deletedIds.has(agentId)) continue;

                const rawContent = readFileSync(join(newPath, f), 'utf-8');
                // Strip BOM (UTF-8 files written by some tools contain BOM, JSON.parse will throw an exception)
                const jsonContent = rawContent.charCodeAt(0) === 0xFEFF ? rawContent.slice(1) : rawContent;
                const meta = JSON.parse(jsonContent);
                if (meta.status === 'deleted') continue; // 会话已被删除（删 Agent 时软删）→ 不恢复
                const name = meta.title || agentId;
                const idx = addCount % colors.length;
                userAgentsData.agents.push({
                    id: agentId,
                    name,
                    description: `${name}（自动从历史数据恢复）`,
                    icon: icons[idx],
                    color: colors[idx],
                    default: false,
                    createdAt: meta.createdAt || Date.now(),
                    updatedAt: meta.updatedAt || Date.now(),
                });
                knownIds.add(agentId);
                addCount++;
            } catch { /* Skip corrupt files */ }
        }

        if (addCount > 0) {
            writeFileSync(userAgentsPath, JSON.stringify(userAgentsData, null, 2), 'utf-8');
            migrateLog.info(`Step4: Auto-registered ${addCount} missing custom agents into user_agents.json`);
        }
    } catch (e) {
        migrateLog.warn('Step4 agent auto-registration failed (non-fatal)', { error: String(e) });
    }

    // Step 5: 多会话改造 —— 补写 user-agent_*.meta.json 的 agentId 字段。
    // 历史上默认会话创建时 agentId 写的是 'default'（或被 Step2 重映射成首个 Agent），
    // 多会话按 metadata.agentId 归组，这里统一修正为文件名中的真实 agentId。幂等安全。
    try {
        if (!existsSync(newPath)) return;
        let patchCount = 0;
        const legacyMetas = readdirSync(newPath).filter(
            f => f.startsWith('user-agent_') && f.endsWith('.meta.json')
        );
        for (const f of legacyMetas) {
            try {
                const agentId = f.replace(/^user-agent_/, '').replace(/\.meta\.json$/, '');
                const filePath = join(newPath, f);
                const rawContent = readFileSync(filePath, 'utf-8');
                const jsonContent = rawContent.charCodeAt(0) === 0xFEFF ? rawContent.slice(1) : rawContent;
                const meta = JSON.parse(jsonContent);
                if (meta.agentId !== agentId) {
                    meta.agentId = agentId;
                    writeFileSync(filePath, JSON.stringify(meta, null, 2), 'utf-8');
                    patchCount++;
                }
            } catch { /* Skip corrupt files */ }
        }
        if (patchCount > 0) {
            migrateLog.info(`Step5: Fixed agentId on ${patchCount} default agent sessions (multi-session support)`);
        }
    } catch (e) {
        migrateLog.warn('Step5 session agentId fix failed (non-fatal)', { error: String(e) });
    }
}

const log = new Logger('GatewayServer');
telemetry.setSink(record => log.debug('telemetry.span', { ...record }));

/**
 * Agent progress event
 */
export interface AgentProgressEvent {
    type: 'iteration' | 'tool_start' | 'tool_progress' | 'tool_result' | 'commentary' | 'thinking' | 'token'
        | 'stream_reset';
    iteration?: number;
    tool?: string;
    args?: Record<string, unknown>;
    result?: unknown;
    message?: string;
    thinking?: string;
    token?: string;
    description?: string;
    /** LLM original description text (tool_start event only, content from LLM) */
    llmDescription?: string;
    /** Public, user-facing progress summary. Never contains raw model reasoning. */
    commentary?: string;
    toolCallId?: string;
    toolCalls?: Array<{ id: string; name: string; title?: string; detail?: string }>;
    /** Namespaces child-agent tool-call IDs before they enter the parent timeline. */
    sourceId?: string;
    sourceAgentId?: string;
    failed?: boolean;
    reason?: string;
    provisional?: boolean;
}

/**
 * client connection
 */
interface GatewayClient {
    id: string;
    ws: WebSocket;
    authenticated: boolean;
    /** Stable renderer identity used to survive WebSocket reconnects. */
    instanceId?: string;
    /** Whether to subscribe to the debug log */
    debugSubscribed?: boolean;
    /** Client MCP tool name list (used for cleaning up when disconnected) */
    clientMcpToolNames?: string[];
    /** Plugin Protocol v1 注册原始消息（断开重挂用：其他实例断开误删同名工具时，凭它重新注册） */
    pluginRegisterMessage?: GatewayMessage;
    /** 插件工具调用串行队列：同一文档上并发跑多个 Office.js 批处理会互相干扰报 InvalidArgument，必须排队 */
    pluginCallQueue?: Promise<unknown>;
    /** 客户端角色（如 'canvas' 表示设计画布窗口），用于工具定向下发 */
    role?: string;
}

/**
 * Message type
 */
interface GatewayMessage {
    type: string;
    id?: string;
    payload?: unknown;
}

type ChatDelivery = 'new' | 'steer' | 'queue';

interface InteractiveChatPayload {
    input: string;
    /**
     * Gateway-only execution context. This is deliberately separate from
     * `input`, because `input` is exposed in queue/chat lifecycle events and is
     * therefore user-visible.
     */
    internalInput?: string;
    sessionId?: string;
    agentId?: string;
    attachments?: Array<{ path: string; name: string; size: number; ext: string }>;
    source?: 'local' | 'cloud';
    chatroomId?: number;
    approvalMode?: ApprovalMode;
    delivery?: ChatDelivery;
    submissionId?: string;
    targetTurnId?: string;
    targetRunId?: string;
    fallback?: 'queue';
    mode?: WorkMode;
    planId?: string;
    planRevision?: number;
    planExecution?: boolean;
}

interface DurableChatPayload extends InteractiveChatPayload {
    turnId: string;
    submissionId: string;
    originClientInstanceId?: string;
}

/**
 * Standalone Gateway Server
 */
export async function createStandaloneGateway() {
    // The first thing: detect the operating system character encoding (Chinese/Japanese/Arabic Windows defaults to GBK/Shift-JIS/etc.)
    // All subprocess calls below will use this result to do correct output decoding.
    detectSystemEncoding();

    // Force the console output to UTF-8 (to prevent Chinese stderr from being output as GBK and causing garbled characters)
    if (process.platform === 'win32') {
        try {
            const { execSync } = await import('child_process');
            execSync('chcp 65001', { stdio: 'pipe', windowsHide: true });
        } catch {
            // non-fatal
        }
    }

    // The locale is cheap and needed immediately. CLI discovery is completed in the
    // background after the WebSocket starts listening so it cannot delay the first screen.
    initializeEnvProbe();
    log.info('Standalone Gateway starting...');

    // ── Lazy loading of heavy modules (reduces memory usage at startup) ──────────────
    const { McpClientManager } = await import('../tools/mcp-client');
    const { isPythonReady, ensureUv, getUvExePath, getPythonEnvInfo } = await import('../utils/python-env');
    const { MemoryManager } = await import('../agent/memory/manager');
    const { createMemoryTool } = await import('../tools/memory');
    const { OpenFluxChatBridge, cleanOpenFluxCloudText } = await import('./openflux-chat-bridge');
    const { RouterBridge } = await import('./router-bridge');
    const { createNotifyTool } = await import('../tools/notify');
    const { TTSService } = await import('../main/voice/tts');
    const { STTService } = await import('../main/voice/stt');
    const { launchChromeWithDebugPort, getBrowserConnectionStatus, cleanupScheduledPages } = await import('../tools/browser/index');
    const { decryptAPIKey } = await import('../utils/crypto');
    const { EvolutionDataManager, SkillForge, runMigrations } = await import('../evolution');
    const { createSkillStoreTool } = await import('../tools/skill-store');
    const { createToolForgeTool } = await import('../tools/tool-forge');
    log.info('Heavy modules lazy-loaded');

    // ── Scheduled forced GC (requires --expose-gc startup parameter) ──────────────
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

    // 1. Load configuration
    const config = await loadConfig();
    // When workspace is not configured, fallback to the standard user data directory instead of process.cwd() (installation directory).
    // Brand builds set brandLock.dataDir (the bundle identifier) so an enterprise edition keeps its
    // gateway data in %APPDATA%/<identifier>, fully separate from the open-source OpenFlux data dir.
    const userDataRoot = process.env.APPDATA || process.env.HOME || require('os').homedir();
    // Enterprise data isolation has the highest priority: once brandLock.dataDir is present the
    // workspace is forced to %APPDATA%/<identifier>, even if config.workspace is set (the shared
    // dev openflux.yaml hard-codes workspace to the project dir, which must NOT leak across brands).
    const workspace = config.brandLock?.dataDir
        ? join(userDataRoot, config.brandLock.dataDir)
        : (config.workspace
            ? resolvePath(config.workspace)   // Make sure the path is absolute
            : join(userDataRoot, 'OpenFlux'));
    // Make sure the workspace directory exists
    if (!existsSync(workspace)) {
        try { mkdirSync(workspace, { recursive: true }); } catch { /* ignore */ }
    }
    // Merge UI saved configuration (server-config.json -> config)
    mergeServerConfig(workspace, config);
    // Router App User ID: per-device identity required by the Router connection key
    // (appId + appUserId). Brand builds with locked services never go through the UI flow
    // that generates it, so auto-generate and persist it here on first run.
    if (config.router?.url && config.router?.appId && !config.router.appUserId) {
        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        let uid = 'ofu_';
        for (let i = 0; i < 12; i++) uid += chars[Math.floor(Math.random() * chars.length)];
        config.router.appUserId = uid;
        try {
            const scPath = join(workspace, 'server-config.json');
            const stripBom = (s: string) => s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
            const sc = existsSync(scPath) ? JSON.parse(stripBom(readFileSync(scPath, 'utf-8'))) : {};
            sc.router = { ...(sc.router || {}), appUserId: uid };
            writeFileSync(scPath, JSON.stringify(sc, null, 2), 'utf-8');
            log.info('Generated Router appUserId for this device', { appUserId: uid });
        } catch (e) {
            log.warn('Failed to persist generated Router appUserId', { error: String(e) });
        }
    }
    const port = config.remote?.port || 18801;
    const token = config.remote?.token;
    log.info('Configuration loaded', { workspace });

    // 2. Load runtime settings (output directory, etc.)
    const runtimeSettings = loadSettings(workspace);
    // Make sure the output directory exists
    if (!existsSync(runtimeSettings.outputPath)) {
        try { mkdirSync(runtimeSettings.outputPath, { recursive: true }); } catch { /* ignore */ }
    }
    log.info('Runtime settings loaded', { outputPath: runtimeSettings.outputPath });

    // 5. Old user upgrade data migration (must be performed before UserAgentStore is initialized!)
    // Step 4 will register the existing custom agent in the sessions directory to user_agents.json.
    // If executed after UserAgentStore.load(), the memory cache will not be refreshed, causing the custom agent not to be displayed.
    // Enterprise brands (brandLock.dataDir) MUST start clean: never pull data from the open-source
    // %APPDATA%/com.openflux.app dir, otherwise its user agents / main-agent name / sessions leak in.
    if (config.brandLock?.dataDir) {
        log.info('Brand-isolated workspace: skipping legacy com.openflux.app data migration');
    } else {
        migrateSessionsIfNeeded(workspace);
    }

    // 2.6 Initialize user Agent storage
    const defaultAgentName = config.agents?.globalAgentName || 'OpenFlux Assistant';
    const includeBuiltinAgents = (config as any).builtinAgents?.designer !== false;
    const userAgentStore = new UserAgentStore(workspace, defaultAgentName, (config as any).agentPresets || [], includeBuiltinAgents);
    const projectStore = new ProjectStore(workspace);

    // 2.5 Initialize Voice service (TTS + STT)
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

    // 3. Initialize LLM Provider (fault tolerance: skip when there is no API Key and enter boot mode)
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

    // 3.1 Initialize Fallback LLM (standby model, main LLM content review/current limit/automatic switch when unavailable)
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

    // 3. Initialize tool registry + workflow engine
    const tools = new ToolRegistry({
        permissionChecker: new PermissionChecker(config.permissions?.autoApproveLevel as RiskLevel),
    });
    const planStore = new PlanStore({
        plansDirectory: join(homedir(), '.openflux', 'plans'),
        workStateDirectory: join(workspace, 'sessions'),
    });
    const recoveredPlanExecutions = planStore.recoverInterruptedExecutions();
    if (recoveredPlanExecutions.length > 0) {
        log.warn('Recovered interrupted plan executions for final confirmation', {
            count: recoveredPlanExecutions.length,
            sessionIds: recoveredPlanExecutions.map(item => item.sessionId),
        });
    }
    tools.register(createRequestPlanInputTool());
    tools.register(createPublishPlanDocumentTool());
    const { WorkflowStore } = await import('../workflow/workflow-store');
    // Use the resolved `workspace` (brand-isolated), NOT config.workspace which is the raw yaml value
    // and ignores brandLock.dataDir — otherwise workflows/scheduler leak into the open-source data dir.
    const workflowStore = new WorkflowStore(join(workspace, '.workflows'));
    const workflowEngine = new WorkflowEngine({ tools, llm, store: workflowStore });

    // Browser recording store (used by the Chrome recorder extension + browser_recording tool)
    const { RecordingStore } = await import('../recording/recording-store');
    const recordingStore = new RecordingStore(join(workspace, 'data', 'evolution', 'recordings'));

    // Create scheduler
    const schedulerStore = new SchedulerStore({ storePath: workspace });
    let schedulerAgentExecute: (prompt: string, sessionId?: string, meta?: ScheduledTaskMeta) => Promise<string>;
    const scheduler = new Scheduler({
        store: schedulerStore,
        onAgentExecute: (prompt, sessionId, meta) => schedulerAgentExecute(prompt, sessionId, meta),
        onEvent: (event: SchedulerEvent) => {
            // Broadcast scheduler events to all online clients
            broadcastSchedulerEvent(event);

            // When the task is executed for the first time: ensure that the session carried by the event exists.
            if (event.type === 'run_start') {
                try {
                    if (event.sessionId && !sessions.get(event.sessionId)) {
                        // 会话归属：优先用任务绑定的 agentId，保证会话出现在对应 Agent 的会话列表里
                        const taskAgentId = scheduler.getTask(event.taskId)?.agentId
                            || (event.sessionId.startsWith('user-agent:') ? event.sessionId.replace('user-agent:', '') : undefined);
                        sessions.create(taskAgentId || 'default', `🕐 ${event.taskName || '定时任务'}`, undefined, undefined, event.sessionId);
                        log.info(`Task first run, session ensured: "${event.taskName || event.taskId}" → ${event.sessionId}`);
                    }
                } catch (e) {
                    log.error('Failed to create session for scheduled task:', e);
                }
            }

            // Task execution completion/failure: Broadcast session refresh notification
            if (event.type === 'run_complete' || event.type === 'run_failed') {
                const task = scheduler.getTask(event.taskId);
                const sessionId = event.sessionId || task?.sessionId;
                if (sessionId) {
                    broadcastSessionUpdate(sessionId);
                }
            }
        },
    });

    // Build a list of allowed working directories (output path + workspace + user configured whitelist)
    // Filter out paths that are invalid for the current platform (e.g. D:\xxx on macOS)
    const isWinDrivePath = (p: string) => /^[A-Za-z]:[/\\]/.test(p);
    const isUnixAbsPath = (p: string) => p.startsWith('/');
    const filterPlatformPaths = (dirs: string[]): string[] => {
        return dirs.filter(d => {
            if (process.platform === 'win32') return !isUnixAbsPath(d) || isWinDrivePath(d);
            return !isWinDrivePath(d); // macOS/Linux: drop Windows drive paths
        });
    };
    const allowedCwdPaths = new Set<string>([
        runtimeSettings.outputPath,
        workspace,
        ...filterPlatformPaths(config.permissions?.allowedDirectories || []),
    ]);
    const getActiveToolRoot = (): string =>
        getAgentExecutionContext()?.workspaceRoot || runtimeSettings.outputPath;
    const getAllowedToolRoots = (): string[] => {
        const projectRoot = getAgentExecutionContext()?.workspaceRoot;
        return projectRoot ? [projectRoot] : [...allowedCwdPaths];
    };
    const getProjectReadRoots = (): string[] => {
        const execution = getAgentExecutionContext();
        return execution?.workspaceRoot
            ? [execution.workspaceRoot, ...(execution.userGrantedReadPaths || [])]
            : [];
    };

    // Per-session serialization, active-run ownership and cancellation.
    const executionRegistry = new ExecutionRegistry();
    const turnQueueStore = new TurnQueueStore({ directory: join(workspace, 'sessions') });

    interface AgentExecutionResult {
        output: string;
        status: 'completed' | 'failed' | 'waiting_input' | 'awaiting_plan_approval';
    }

    interface PendingInteractiveTurn {
        payload: DurableChatPayload;
        queueItemId: string;
        client: GatewayClient;
        handle?: ExecutionHandle<AgentExecutionResult>;
        tracker?: TurnTracker;
        execution?: ActiveExecution;
        pendingGuidanceActivity?: Array<{ id?: string; content: string }>;
        pendingGoalActivity?: Array<{
            id: string;
            title: string;
            detail?: string;
            status: 'running' | 'completed' | 'failed';
        }>;
        goalState?: GoalState;
        pendingGoalInstructions?: GoalInstruction[];
        goalReconcileGeneration?: number;
        goalReconcileController?: AbortController;
        goalReconcilePromise?: Promise<void>;
        activeGoalActivityId?: string;
        progressSummary?: string[];
    }

    const pendingInteractiveTurns = new Map<string, PendingInteractiveTurn>();
    const queueRevisionBySession = new Map<string, number>();
    // planExecution is a server-only queueing path. Object identity prevents a
    // websocket client from forging the internal flag in a JSON payload.
    const trustedPlanExecutionPayloads = new WeakSet<object>();

    function publishGuidanceActivity(runId: string, content: string, guidanceId?: string): void {
        const pending = pendingInteractiveTurns.get(runId);
        if (!pending || !content.trim()) return;
        if (pending.tracker) {
            pending.tracker.guidance(content, guidanceId);
            return;
        }
        pending.pendingGuidanceActivity = [
            ...(pending.pendingGuidanceActivity || []),
            { id: guidanceId, content },
        ];
    }

    // Late-bound image-model resolver. The actual `llmSource` is initialized later in this
    // function, so generate_image reads the current source through this getter at call time.
    // Phase 1 only resolves the `local` source; managed/atlas_managed are added in later phases.
    let getImageRuntimeConfig: () => ImageGenRuntimeConfig | undefined = () => undefined;

    tools.register(createProjectSearchTool({ basePath: getActiveToolRoot }));
    tools.registerDefaults({
        process: {
            cwd: getActiveToolRoot,
            allowedCommands: config.sandbox?.allowedCommands,
            allowedCwdPaths: getAllowedToolRoots,
            pathBoundary: () => getAgentExecutionContext()?.workspaceRoot,
            allowedExternalPaths: () => getAgentExecutionContext()?.userGrantedReadPaths || [],
            docker: config.sandbox?.mode === 'docker' ? config.sandbox.docker : undefined,
            getSessionId: () => getAgentExecutionContext()?.sessionId,
            // Built-in Python path injection: intercept the python/pip/uv prefix and replace it with an absolute path without modifying the system PATH
            pythonExe: isPythonReady() ? getPythonEnvInfo().pythonExe : undefined,
            uvExe:     existsSync(getUvExePath())  ? getUvExePath()            : undefined,
        },
        opencode: {
            cwd: getActiveToolRoot,
            allowedCwdPaths: () => {
                const projectRoot = getAgentExecutionContext()?.workspaceRoot;
                return projectRoot ? [projectRoot] : [];
            },
        },
        filesystem: {
            basePath: getActiveToolRoot,
            // Ordinary Agents retain their configured read behavior. Projects
            // receive a per-turn hard read boundary in addition to write scope.
            allowedPaths: getProjectReadRoots,
            allowedWritePaths: getAllowedToolRoots,
            blockedExtensions: config.sandbox?.blockedExtensions,
            maxWriteSize: config.sandbox?.maxWriteSize,
        },
        office: {
            basePath: getActiveToolRoot,
            allowedWritePaths: getAllowedToolRoots,
            useDateSubdirectory: () => !getAgentExecutionContext()?.workspaceRoot,
        },
        fileReader: {
            basePath: getActiveToolRoot,
            allowedPaths: getProjectReadRoots,
        },
        browser: {}, // The headless option has been removed and the default is adapted according to the environment.
        workflow: { engine: workflowEngine },
        scheduler: {
            scheduler,
            getSessionId: () => getAgentExecutionContext()?.sessionId,
            // 多会话：从会话 metadata 解析所属 Agent（user-agent: 前缀之外的 UUID 会话）
            getAgentIdForSession: (sessionId: string) => sessions.get(sessionId)?.agentId || undefined,
        },
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
        imageGen: {
            getOutputPath: getActiveToolRoot,
            getRuntimeConfig: () => getImageRuntimeConfig(),
        },
        videoGen: {
            getOutputPath: getActiveToolRoot,
            getFfmpegPath: () => getEnvProbe().tools.ffmpeg?.path,
        },
        presentationGen: {
            getOutputPath: getActiveToolRoot,
        },
    });
    log.info('Workflow engine initialized');

    // 3.6 Verify Python environment (pythonExe/uvExe has been injected into the process tool)
    try {
        const { logPythonEnvStatus } = await import('../utils/python-env');
        logPythonEnvStatus();
        if (isPythonReady()) {
            const pyExe = getPythonEnvInfo().pythonExe;
            log.info('Bundled Python will be used for Agent python/pip/uv commands', {
                pythonExe: pyExe,
                uvExe: getUvExePath(),
            });
            // Inject the built-in Python path into env-probe and let the system prompt clearly tell the agent which Python to use.
            const { updateEnvProbeBuiltinPython } = await import('../utils/env-probe');
            updateEnvProbeBuiltinPython(pyExe);
        }
    } catch (e) {
        log.warn('Python environment module load failed (does not affect core functionality)');
    }

    // 3.8 Initializing long-term memory
    let memoryManager: MemoryManagerT | undefined;
    if (config.memory?.enabled) {
        try {
            const memoryConfig = {
                dbPath: join(workspace, '.memory', config.memory.dbName),
                vectorDim: config.memory.vectorDim,
                embeddingModel: config.llm.embedding?.model,
                debug: config.memory.debug,
            };

            // 3.8.1 Initialize embedding LLM (if an independent embedding provider is configured)
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
            // Monitor the reconstruction progress and broadcast
            memoryManager.on('rebuildProgress', (progress: number) => {
                const message = JSON.stringify({ type: 'config.rebuildProgress', payload: { progress } });
                for (const client of clients.values()) {
                    if (client.authenticated && client.ws.readyState === WebSocket.OPEN) {
                        client.ws.send(message);
                    }
                }
            });
            // Register memory tool
            tools.register(createMemoryTool({ memoryManager }));
            log.info('Long-term memory system initialized');

            // Seed enterprise built-in memories (vector store) ONCE. A marker file records the
            // content hashes already seeded, so memories the user later deletes are NOT re-added,
            // while a brand update that introduces NEW memories still gets them seeded next start.
            const memoryPresets = (config as unknown as { memoryPresets?: Array<{ content?: string; tags?: string[] }> }).memoryPresets;
            if (memoryManager && Array.isArray(memoryPresets) && memoryPresets.length > 0) {
                const mm = memoryManager;
                void (async () => {
                    const markerPath = join(workspace, '.brand_memories_seeded.json');
                    const seeded = new Set<string>();
                    try {
                        if (existsSync(markerPath)) {
                            const parsed = JSON.parse(readFileSync(markerPath, 'utf-8'));
                            if (Array.isArray(parsed)) for (const h of parsed) seeded.add(String(h));
                        }
                    } catch { /* corrupt marker -> treat as empty */ }

                    let added = 0;
                    for (const m of memoryPresets) {
                        const content = (m?.content || '').trim();
                        if (!content) continue;
                        const hash = crypto.createHash('sha256').update(content).digest('hex');
                        if (seeded.has(hash)) continue; // already seeded once; respect user deletion
                        try {
                            await mm.add(content, { tags: m.tags, sourceFile: 'brand' });
                            seeded.add(hash);
                            added++;
                        } catch (e) {
                            log.warn('Failed to seed brand memory', { error: String(e) });
                        }
                    }
                    try {
                        writeFileSync(markerPath, JSON.stringify(Array.from(seeded), null, 2), 'utf-8');
                    } catch { /* ignore */ }
                    if (added > 0) log.info(`Seeded ${added} enterprise built-in memories`);
                })();
            }

            // 3.9 Initialize the memory distillation system (independent of the original MemoryManager)
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

                // CardManager requires two LLM: chatLLM for summary extraction, embeddingLLM for vector indexing
                const cardManager = new CardManager(
                    (memoryManager as any).db,
                    llm,            // chatLLM: master LLM (supports chat)
                    embeddingLLM,   // embeddingLLM: embedding model (supports embed)
                    distillConfig
                );

                const cardUpgrader = new CardUpgrader(
                    (memoryManager as any).db,
                    llm,            // chatLLM: master LLM (supports chat)
                    embeddingLLM,   // embeddingLLM: embedding model (supports embed)
                    cardManager,
                    distillConfig
                );

                const distillScheduler = new DistillationScheduler(cardUpgrader, distillConfig);
                distillScheduler.start();

                // Monitor new memory writes -> generate Micro cards asynchronously (fire-and-forget, without blocking the original process)
                memoryManager.on('memoryAdded', (entry: { id: string; content: string }) => {
                    // Use distillScheduler.getStatus() to get the latest status at runtime
                    // (distillConfig is an initialization snapshot and will not be synchronized back after updateConfig)
                    if (distillScheduler.getStatus().enabled) {
                        cardManager.generateMicroCard(entry.content, entry.id).catch(err => {
                            log.debug('Micro card generation failed (does not affect core memory)', { error: String(err) });
                        });
                    }
                });

                // Inject hierarchical context retrieval into AgentManager (by extending memoryManager)
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

    // 3.5 MCP external tool loading
    const mcpManager = new McpClientManager();
    let mcpInitialization: Promise<void> | undefined;

    const initializeMcpServers = (servers: McpServerConfig[]): Promise<void> => {
        const task = (async () => {
            try {
                await mcpManager.initialize(servers);
                for (const tool of mcpManager.getTools()) tools.register(tool);
                const serverInfo = mcpManager.getServerInfo();
                log.info(`MCP tools registered: ${serverInfo.map(s => `${s.name}(${s.toolCount})`).join(', ')}`);
            } catch (error) {
                log.error('MCP initialization failed (does not affect core functionality):', { error });
            }
        })();
        mcpInitialization = task;
        void task.finally(() => {
            if (mcpInitialization === task) mcpInitialization = undefined;
        });
        return task;
    };

    // Inject built-in windows-mcp (built-in Python uvx takes priority, fallback system PATH)
    {
        const hasUserWindowsMcp = config.mcp?.servers?.some(
            (s: any) => s.name === 'windows-mcp'
        );
        if (!hasUserWindowsMcp) {
            let uvxCmd: string | null = null;

            // Priority: Built-in Python environment
            if (isPythonReady()) {
                const uvReady = await ensureUv();
                if (uvReady) uvxCmd = getUvExePath();
            }

            // Fallback: uvx in system PATH
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

    // 4. Add the spawn tool (AgentManager will create a restricted version on demand)
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

    // 4.5 Initialize evolution data layer + register evolution tool
    const evolutionData = new EvolutionDataManager(workspace);
    await evolutionData.initialize();
    await runMigrations(evolutionData);
    evolutionData.refreshStats();
    log.info('Evolution data layer initialized', { version: evolutionData.readManifest().schemaVersion });

    // Deferred reference: AgentManager is created later, but callback is registered here
    let agentManagerRef: AgentManager | null = null;

    // Register the skill_store tool
    const skillStoreTool = createSkillStoreTool({
        evolutionData,
        onSkillInstalled: (skill) => {
            agentManagerRef?.addSkill(skill);
            // Notify the front end to refresh in real time
            broadcastToClients({ type: 'evolution.skills.updated' });
        },
        onSkillUninstalled: (skillId) => {
            agentManagerRef?.removeSkill(skillId);
            broadcastToClients({ type: 'evolution.skills.updated' });
        },
    });
    tools.register(skillStoreTool);

    // Register browser_recording tool (list/get/replay/toWorkflow/toSkill for Chrome recordings)
    const { createBrowserRecordingTool } = await import('../tools/browser-recording');
    tools.register(createBrowserRecordingTool({
        store: recordingStore,
        registry: tools,
        workflowStore,
        dataManager: evolutionData,
        // getter 而非实例：llm 会随来源切换（local/managed/atlas）被重新赋值
        getLLM: () => llm,
    }));
    log.info('browser_recording tool registered');

    // Register coding_agent tool (agy/claude/codex/cursor CLI driver)
    // The session uses CLI's own conv/session ID as the value, and uses "project cwd" as the key to persist to disk.
    // In the same project directory, CLI can restore its own context regardless of cross-OpenFlux conversations or Gateway restarts
    const { createCodingAgentTool } = await import('../tools/coding-agent');
    tools.register(createCodingAgentTool({
        defaultCwd: getActiveToolRoot,
        allowedCwdPaths: () => {
            const projectRoot = getAgentExecutionContext()?.workspaceRoot;
            return projectRoot ? [projectRoot] : [];
        },
        sessionsStorePath: join(workspace, '.coding-agent-sessions.json'),
    }));
    log.info('Coding agent tool registered (drivers: agy, claude, codex, cursor)');

    // tool_forge is no longer registered as an Agent runtime tool
    // Tool creation should be actively triggered by the user after the task is completed, rather than created by itself during the execution of the Agent.
    // Reserve pendingConfirmations for future frontend post-task API use
    const pendingConfirmations = new Map<string, (approved: boolean) => void>();
    // Reserve the toolForgeTool instance for WebSocket API calls, but do not register it in the Agent tool list
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
            // No longer automatically registered to the Agent tool list
            log.info(`Custom tool created (not registered to Agent): ${_tool.name}`);
        },
    });
    // Note: tools.register(toolForgeTool) is no longer executed

    // Custom tools are no longer automatically injected into the Agent tool list (to avoid 34+ custom_* tools consuming LLM tokens)
    // Agent already has process tools that can directly execute any script without pre-registering custom tools.
    const customToolCount = evolutionData.readManifest().stats.customTools;
    log.info(`Evolution: skills=${evolutionData.readManifest().stats.installedSkills}, custom_tools=${customToolCount} (not loaded into Agent)`);

    // 4.5 Initialize Skill Forge (L2 Skill Forging Analyzer)
    let pendingSuggestion: ForgeSuggestion | null = null;
    const skillForge = new SkillForge({
        llm,
        dataManager: evolutionData,
        minToolCalls: 2,
        minMessageRounds: 3,
        language: config.language,
        onSuggestion: (suggestion) => {
            // Distinguish between upgrade recommendations and new build recommendations
            pendingSuggestion = suggestion;
            try {
                if (suggestion.isUpgrade && suggestion.upgradeTargetId) {
                    // Upgrade: Update existing skill content
                    const ok = skillForge.upgradeSuggestion(suggestion);
                    if (!ok) {
                        log.warn(`Skill upgrade failed (target not found): ${suggestion.upgradeTargetId}`);
                        return;
                    }
                    log.info(`Skill auto-upgraded silently: "${suggestion.title}" → ${suggestion.upgradeTargetId}`);
                    // If the skill is enabled, update the content in AgentManager synchronously
                    const upgradedMeta = evolutionData.listForgedSkills().find(s => s.id === suggestion.upgradeTargetId);
                    if (upgradedMeta?.enabled && agentManagerRef) {
                        const content = evolutionData.readForgedSkillContent(suggestion.upgradeTargetId!);
                        if (content) {
                            agentManagerRef.addSkill({ id: `forged:${suggestion.upgradeTargetId}`, title: suggestion.title, content });
                        }
                    }
                } else {
                    // New: Save as new skill
                    skillForge.acceptSuggestion(suggestion);
                    log.info(`Skill auto-forged silently: "${suggestion.title}" [${suggestion.category}]`);
                }
            } catch (err) {
                log.warn('Auto-forge save failed:', err);
                return;
            }
            // Notify the front end of new skills or upgrades (lightweight badge event, does not trigger Toast)
            const msg = JSON.stringify({
                type: 'evolution.forge.saved',
                payload: {
                    title: suggestion.title,
                    category: suggestion.category,
                    isUpgrade: suggestion.isUpgrade ?? false,
                    upgradeTargetId: suggestion.upgradeTargetId,
                },
            });
            for (const c of clients.values()) {
                if (c.authenticated && c.ws.readyState === WebSocket.OPEN) {
                    c.ws.send(msg);
                }
            }
        },
    });
    log.info('SkillForge analyzer initialized');

    // Skill Forge Sliding Window Counter
    // key: sessionId, value: number of messages when Forge was last triggered
    const forgeCheckpointMap = new Map<string, number>();
    const FORGE_WINDOW_SIZE = 20; // Check every 20 messages accumulated

    log.info(`Tools registered, total: ${tools.getToolNames().length}`);

    // (The migration has been completed before UserAgentStore is initialized, no need to repeat it here)

    // 6. Initialize session storage
    // Bug fix: The parsed workspace variable must be used (not config.workspace),
    // config.workspace is undefined when yaml is not configured (auto mode).
    // Will cause the SessionStore to fall back to ~/.openflux/sessions (the old path).
    const sessions = new SessionStore({
        storePath: workspace,
    });
    log.info('Session store initialized');

    const restartRecovery = recoverInterruptedTurnsAfterRestart(turnQueueStore, sessions);
    if (
        restartRecovery.dispatching > 0
        || restartRecovery.interruptedEventsAppended > 0
        || restartRecovery.eventIssues.length > 0
    ) {
        log.warn('Recovered interrupted queued turns after Gateway restart', { ...restartRecovery });
    }

    function publishGoalActivity(
        runId: string,
        activity: {
            id: string;
            title: string;
            detail?: string;
            status: 'running' | 'completed' | 'failed';
        },
    ): void {
        const pending = pendingInteractiveTurns.get(runId);
        if (!pending) return;
        if (pending.tracker) {
            pending.tracker.goalUpdate(activity);
            return;
        }
        pending.pendingGoalActivity = [...(pending.pendingGoalActivity || []), activity];
    }

    function recordGoalProgress(pending: PendingInteractiveTurn, event: AgentProgressEvent): void {
        const text = event.commentary?.trim() || event.description?.trim() || event.message?.trim();
        if (!text || event.type === 'token' || event.type === 'thinking') return;
        pending.progressSummary = [...(pending.progressSummary || []), text.slice(0, 500)].slice(-20);
    }

    async function waitForLatestGoalReconciliation(pending: PendingInteractiveTurn): Promise<void> {
        // A steer notification can reject the in-flight model request in the
        // same tick that the Gateway starts reconciliation. Yield once so the
        // just-created promise is visible before checking it.
        await Promise.resolve();
        while (pending.goalReconcilePromise) {
            const current = pending.goalReconcilePromise;
            await current;
            if (pending.goalReconcilePromise === current) return;
        }
    }

    function startGoalReconciliation(
        sessionId: string,
        target: { runId: string; turnId?: string },
        instruction: GoalInstruction,
    ): void {
        const pending = pendingInteractiveTurns.get(target.runId);
        const execution = executionRegistry.get(sessionId);
        if (!pending || !execution || execution.runId !== target.runId) return;
        const goalUiIsZh = !config.language || config.language.toLowerCase().startsWith('zh');

        if (pending.activeGoalActivityId && pending.activeGoalActivityId !== instruction.id) {
            publishGoalActivity(target.runId, {
                id: pending.activeGoalActivityId,
                title: goalUiIsZh
                    ? '目标修订已合并到更新的用户引导'
                    : 'Goal update merged into newer guidance',
                status: 'completed',
            });
        }
        pending.activeGoalActivityId = instruction.id;
        publishGoalActivity(target.runId, {
            id: instruction.id,
            title: goalUiIsZh
                ? '正在根据新引导修订任务目标…'
                : 'Revising task goals from the new guidance…',
            status: 'running',
        });

        pending.pendingGoalInstructions = [...(pending.pendingGoalInstructions || []), instruction];
        pending.goalState ||= createInitialGoalState(pending.payload.input || '', pending.payload.submissionId);
        const generation = (pending.goalReconcileGeneration || 0) + 1;
        pending.goalReconcileGeneration = generation;
        pending.goalReconcileController?.abort(new Error('Superseded by newer steering'));

        const controller = new AbortController();
        pending.goalReconcileController = controller;
        const abortWithTurn = () => controller.abort(execution.controller.signal.reason);
        execution.controller.signal.addEventListener('abort', abortWithTurn, { once: true });
        const timer = setTimeout(() => controller.abort(new Error('Goal reconciliation timed out')), 8_000);
        let rejectOnAbort!: () => void;
        const aborted = new Promise<never>((_resolve, reject) => {
            rejectOnAbort = () => reject(
                controller.signal.reason instanceof Error
                    ? controller.signal.reason
                    : new Error('Goal reconciliation aborted'),
            );
            controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
        });
        const includedInstructions = [...pending.pendingGoalInstructions];
        const baseState = pending.goalState;

        const commitRevision = (revision: GoalRevision): void => {
            if (
                pending.goalReconcileGeneration !== generation
                || !execution.isCurrent()
                || controller.signal.aborted && execution.controller.signal.aborted
            ) return;
            pending.goalState = revision.state;
            const includedIds = new Set(includedInstructions.map(item => item.id));
            pending.pendingGoalInstructions = (pending.pendingGoalInstructions || [])
                .filter(item => !includedIds.has(item.id));
            const message: GoalRevisionMessage = {
                id: revision.id,
                revision: revision.state.revision,
                effectiveGoal: revision.effectiveGoal,
                title: revision.title,
                detail: revision.detail,
            };
            const published = executionRegistry.pushGoalRevision(
                sessionId,
                target,
                message,
                revision.id,
            );
            if (!published) return;
            publishGoalActivity(target.runId, {
                id: instruction.id,
                title: revision.title,
                detail: revision.detail,
                status: 'completed',
            });
            if (pending.activeGoalActivityId === instruction.id) pending.activeGoalActivityId = undefined;
        };

        let reconcilePromise!: Promise<void>;
        reconcilePromise = (async () => {
            let revision: GoalRevision;
            try {
                revision = await Promise.race([
                    reconcileGoalState({
                        llm: llm as LLMProvider | undefined,
                        current: baseState,
                        instructions: includedInstructions,
                        progress: pending.progressSummary,
                        language: config.language,
                        signal: controller.signal,
                    }),
                    aborted,
                ]);
            } catch {
                if (pending.goalReconcileGeneration !== generation || execution.controller.signal.aborted) return;
                revision = await reconcileGoalState({
                    current: baseState,
                    instructions: includedInstructions,
                    progress: pending.progressSummary,
                    language: config.language,
                });
            }
            commitRevision(revision);
        })().finally(() => {
            clearTimeout(timer);
            controller.signal.removeEventListener('abort', rejectOnAbort);
            execution.controller.signal.removeEventListener('abort', abortWithTurn);
            if (pending.goalReconcileGeneration === generation) {
                pending.goalReconcileController = undefined;
                if (pending.goalReconcilePromise === reconcilePromise) {
                    pending.goalReconcilePromise = undefined;
                }
            }
        });
        pending.goalReconcilePromise = reconcilePromise;
    }

    // 6. Create AgentManager (multi-Agent routing + tool filtering + execution)
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

        // 6.2 Start loading: Inject the user's enabled forging skills into AgentManager
        const forgedSkills = evolutionData.listForgedSkills();
        let enabledForgedCount = 0;
        for (const meta of forgedSkills) {
            // Compatible with old data: when the enabled field does not exist, it is considered false (conservative strategy)
            if (meta.enabled === true) {
                const content = evolutionData.readForgedSkillContent(meta.id);
                if (content) {
                    agentManager.addSkill({ id: `forged:${meta.id}`, title: meta.title, content });
                    enabledForgedCount++;
                }
            }
        }
        if (enabledForgedCount > 0) {
            log.info(`Loaded ${enabledForgedCount} enabled forged skills into AgentManager`);
        }
    }

    // 7. Reserve agentRunner for internal scenarios such as scheduled tasks (let it support hot update and reconstruction)
    let agentRunner = createAgentLoopRunner({ llm, fallbackLlm, tools, language: config.language });

    // 7.1 Register collaboration completion callback (announce mechanism -> WebSocket broadcast + history injection)
    agentManager.setCollabOnComplete((session) => {
        // Broadcast to front end
        const event = {
            type: 'collaboration_result',
            sessionId: session.id,
            parentSessionId: session.parentSessionId,
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

        // Inject the results into the parent Agent's session (if there is a parentSessionId)
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
                    metadata: {
                        internal: true,
                        visibility: 'internal',
                        kind: 'collaboration_announce',
                        childSessionId: session.id,
                    },
                });
                log.info('Injected collaboration result into parent session', {
                    parentSession: session.parentSessionId,
                    childSession: session.id,
                });
            } catch (err) {
                log.error('Failed to inject collaboration result', { error: err });
            }
        }

        // Collaboration results are automatically deposited into Micro cards (asynchronous, not blocking the main process)
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
    const isAtlasProtocol = (protocol: unknown): protocol is LLMProtocol =>
        protocol === 'openai' || protocol === 'anthropic' || protocol === 'google';

    // 8. Initialize the OpenFlux cloud chat bridge
    const openfluxBridge = new OpenFluxChatBridge(nexusAiConfig, join(workspace, '.nexusai-token.json'));
    log.info('OpenFlux cloud bridge initialized');

    // 9. Initialize the OpenFluxRouter bridge
    const routerBridge = new RouterBridge();

    // Router hosting LLM configuration (memory only)
    /** Decrypted managed running configuration (new protocol) */
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
        image?: {
            provider: 'openai' | 'gemini';
            apiKey?: string;
            model?: string;
            baseUrl?: string;
            size?: string;
            timeoutSeconds?: number;
        };
        routing?: {
            modules?: Record<string, string>;
            providers?: Record<string, string>;
        };
        quota?: { daily_limit: number; used_today: number };
    }
    /** Old protocol single model configuration (compatible) */
    let managedLlmConfig: {
        provider: string;
        model: string;
        apiKey: string;
        baseUrl?: string;
        quota?: { daily_limit: number; used_today: number };
    } | null = null;
    let managedRuntimeConfig: ManagedRuntimeConfig | null = null;

    /** V2: Build LLM Provider based on the runtime configuration issued by Atlas */
    function buildAtlasLLM(
        runtime: AtlasOpenFluxRuntime,
        token: string,
        orchCfg: { temperature?: number; maxTokens?: number; model?: string },
        override?: {
            protocol?: LLMProtocol;
            modelName?: string;
            extraHeaders?: Record<string, string>;
        },
    ) {
        const proto = override?.protocol || runtime.chat.protocol; // 'openai' | 'anthropic' | 'google'
        const baseUrlMap: Record<string, string> = {
            openai: buildAtlasGatewayUrl('openai'),
            anthropic: buildAtlasGatewayUrl('anthropic'),
            google: buildAtlasGatewayUrl('google'),
        };
        const providerMap = {
            openai: 'openai' as const,
            anthropic: 'anthropic' as const,
            google: 'openai' as const, // Google protocol temporarily goes openai SDK
        };
        const sdkFamily = providerMap[proto] === 'anthropic' ? 'anthropic' as const : 'openai' as const;
        return createLLMProvider({
            provider: providerMap[proto] || 'openai',
            model: override?.modelName || runtime.chat.model_name || orchCfg.model || 'default',
            apiKey: token,
            baseUrl: baseUrlMap[proto] || baseUrlMap.openai,
            temperature: orchCfg.temperature,
            maxTokens: orchCfg.maxTokens,
            extraHeaders: override?.extraHeaders,
            fetch: createAtlasGatewayFetch({ protocol: proto, sdkFamily }),
        });
    }

    let llmSource: 'local' | 'managed' | 'atlas_managed' = 'local';
    let atlasManagedUnavailableReason: string | null = null;

    // Bind the image-model resolver now that llmSource exists.
    // - local: read user-set imageGeneration (independent key, falls back to env var).
    // - managed: Router-issued image config; routing.modules.image_generation decides
    //   direct (decrypted team key, call provider directly) vs router_proxy (forward
    //   through the Router, team key never reaches the client).
    // - atlas_managed: Atlas-issued image ability; forwarded through the Atlas
    //   egress image endpoint with the login access token.
    getImageRuntimeConfig = (): ImageGenRuntimeConfig | undefined => {
        if (llmSource === 'local') {
            const ig = (config as any).imageGeneration as
                | { provider?: 'openai' | 'gemini'; model?: string; apiKey?: string; baseUrl?: string; size?: string }
                | undefined;
            if (!ig) return undefined;
            const provider = ig.provider || 'openai';
            const apiKey = ig.apiKey
                || (provider === 'gemini' ? process.env.GEMINI_API_KEY : process.env.OPENAI_API_KEY)
                || undefined;
            return {
                provider,
                model: ig.model,
                apiKey,
                baseUrl: ig.baseUrl,
                size: ig.size,
                source: 'local',
            };
        }
        if (llmSource === 'managed') {
            const img = managedRuntimeConfig?.image;
            if (!img) return undefined;
            const moduleMode = managedRuntimeConfig?.routing?.modules?.image_generation;
            if (moduleMode === 'router_proxy') {
                const routerCfg = (config as any).router as Partial<RouterConfig> | undefined;
                let baseUrl: string | undefined;
                if (routerCfg?.url) {
                    try {
                        const parsed = new URL(routerCfg.url);
                        baseUrl = `${parsed.protocol === 'wss:' ? 'https:' : 'http:'}//${parsed.host}`;
                    } catch { /* invalid router url */ }
                }
                if (!baseUrl || !routerCfg?.appId || !routerCfg?.apiKey) return undefined;
                return {
                    provider: img.provider,
                    model: img.model,
                    size: img.size,
                    source: 'managed',
                    routerProxy: {
                        baseUrl,
                        appId: routerCfg.appId,
                        appUserId: routerCfg.appUserId,
                        apiKey: routerCfg.apiKey,
                    },
                };
            }
            // direct: call the provider with the decrypted team credentials
            if (!img.apiKey) return undefined;
            return {
                provider: img.provider,
                model: img.model,
                apiKey: img.apiKey,
                baseUrl: img.baseUrl,
                size: img.size,
                source: 'managed',
            };
        }
        // atlas_managed: image ability issued via user_info.atlas_openflux_runtime.
        // Requests are relayed through the Atlas egress endpoint
        // {atlasGatewayBaseUrl}/proxy/image-generation, which speaks the same
        // body contract as the Router image proxy, so the routerProxy transport
        // is reused as-is. The access token authenticates the request; the
        // actual provider credentials stay on the NexusAI/Router side.
        if (llmSource === 'atlas_managed') {
            const img = openfluxBridge.getAtlasRuntime()?.image;
            const token = openfluxBridge.getToken();
            if (!img || !token) return undefined;
            // Provider label is informational only in routerProxy mode (the
            // upstream resolves the real provider from Atlas/Router config).
            const providerLabel = /gemini|google/i.test(`${img.model_name} ${img.display_name}`)
                ? 'gemini' as const
                : 'openai' as const;
            return {
                provider: providerLabel,
                model: img.model_name,
                source: 'atlas_managed',
                routerProxy: {
                    baseUrl: nexusAiConfig.atlasGatewayBaseUrl,
                    appId: 'atlas',
                    apiKey: token,
                },
            };
        }
        return undefined;
    };
    const ATLAS_RUNTIME_UNAVAILABLE_MESSAGE = '当前账号未获得可用的 Atlas OpenFlux 运行时配置，请联系管理员检查组织权限和默认模型配置。';

    const clearAtlasManagedUnavailable = () => {
        atlasManagedUnavailableReason = null;
    };

    const setAtlasManagedUnavailable = (reason: string = ATLAS_RUNTIME_UNAVAILABLE_MESSAGE) => {
        atlasManagedUnavailableReason = reason;
        llm = null;
    };

    interface AtlasRuntimeRefreshState {
        status: FetchUserInfoResult['status'];
        runtime?: AtlasOpenFluxRuntime | null;
        message?: string;
        usedCachedRuntime?: boolean;
    }

    const syncAtlasManagedLLM = (runtime: AtlasOpenFluxRuntime, token: string): void => {
        llm = buildAtlasLLM(runtime, token, config.llm.orchestration);
        clearAtlasManagedUnavailable();
        agentManager.updateLLM(llm);
        agentRunner = createAgentLoopRunner({ llm, fallbackLlm, tools, language: config.language });
        if (memoryManager && (memoryManager as any)._cardManager) {
            (memoryManager as any)._cardManager.updateChatLLM(llm);
        }
        skillForge.updateLLM(llm);
    };

    const buildPolicyRetryLLM = (policyRetry: LLMPolicyRetry): LLMProvider | null => {
        const token = openfluxBridge.getToken();
        const runtime = openfluxBridge.getAtlasRuntime();
        if (!token || !runtime?.chat) return null;
        if (!policyRetry.retryable) return null;
        if (!isAtlasProtocol(policyRetry.target_protocol)) return null;
        if (policyRetry.target_model_id === undefined || policyRetry.target_model_id === null) return null;
        if (policyRetry.max_retry !== undefined && policyRetry.max_retry < 1) return null;

        const extraHeaders: Record<string, string> = {
            'X-Atlas-Requested-Model-Id': String(policyRetry.target_model_id),
        };
        if (policyRetry.source_request_id) {
            extraHeaders['X-Atlas-Policy-Retry-Source-Request-Id'] = policyRetry.source_request_id;
        }
        if (policyRetry.stage) {
            extraHeaders['X-Atlas-Policy-Retry-Stage'] = policyRetry.stage;
        }

        return buildAtlasLLM(runtime, token, config.llm.orchestration, {
            protocol: policyRetry.target_protocol,
            modelName: policyRetry.target_model_name || String(policyRetry.target_model_id),
            extraHeaders,
        });
    };

    async function refreshAtlasManagedRuntime(options?: {
        allowCachedRuntimeOnFailure?: boolean;
        logLabel?: string;
    }): Promise<AtlasRuntimeRefreshState> {
        const token = openfluxBridge.getToken();
        const cachedRuntime = openfluxBridge.getAtlasRuntime();

        if (!token) {
            return { status: 'auth_expired', message: 'NexusAI access token 已失效，请重新登录' };
        }

        const refresh = await openfluxBridge.fetchUserInfo();

        if (refresh.status === 'updated' || refresh.status === 'unchanged') {
            if (refresh.runtime?.chat) {
                syncAtlasManagedLLM(refresh.runtime, token);
                log.info(`${options?.logLabel || 'Atlas runtime refresh'} succeeded`, {
                    status: refresh.status,
                    protocol: refresh.runtime.chat.protocol,
                    model: refresh.runtime.chat.model_name,
                });
                return { status: refresh.status, runtime: refresh.runtime };
            }
            setAtlasManagedUnavailable();
            return { status: 'unavailable', runtime: null };
        }

        if (refresh.status === 'unavailable') {
            setAtlasManagedUnavailable();
            log.warn(`${options?.logLabel || 'Atlas runtime refresh'} returned no runtime config`);
            return { status: 'unavailable', runtime: null };
        }

        if (refresh.status === 'auth_expired') {
            openfluxBridge.invalidateAuth();
            clearAtlasManagedUnavailable();
            llm = null;
            log.warn(`${options?.logLabel || 'Atlas runtime refresh'} detected expired auth`);
            return { status: 'auth_expired', message: refresh.message };
        }

        if (options?.allowCachedRuntimeOnFailure && cachedRuntime?.chat) {
            syncAtlasManagedLLM(cachedRuntime, token);
            log.warn(`${options?.logLabel || 'Atlas runtime refresh'} failed, using cached runtime`, {
                message: refresh.message,
                protocol: cachedRuntime.chat.protocol,
                model: cachedRuntime.chat.model_name,
            });
            return {
                status: 'failed',
                runtime: cachedRuntime,
                message: refresh.message,
                usedCachedRuntime: true,
            };
        }

        setAtlasManagedUnavailable('当前无法从 NexusAI 获取最新运行时配置，请稍后重试。');
        log.warn(`${options?.logLabel || 'Atlas runtime refresh'} failed`, { message: refresh.message });
        return { status: 'failed', message: refresh.message };
    }
    // Local providers snapshot: Save before entering managed/atlas mode to prevent Router key from contaminating server-config.json
    let localProvidersSnapshot: Record<string, any> | null = null;
    // Persist llmSource to file and automatically restore after restart
    const llmSourceFile = join(workspace, '.llm-source.json');
    try {
        if (existsSync(llmSourceFile)) {
            const saved = JSON.parse(readFileSync(llmSourceFile, 'utf-8'));
            if (saved.source === 'managed' || saved.source === 'local' || saved.source === 'atlas_managed') {
                // atlas_managed requires access_token, check if it has been restored
                if (saved.source === 'atlas_managed') {
                    llmSource = 'atlas_managed';
                    if (openfluxBridge.getToken()) {
                        const refreshState = await refreshAtlasManagedRuntime({
                            allowCachedRuntimeOnFailure: true,
                            logLabel: 'Startup atlas runtime refresh',
                        });
                        if (refreshState.status === 'auth_expired') {
                            log.info('Restored atlas_managed mode without login state, waiting for re-auth');
                        }
                    } else {
                        clearAtlasManagedUnavailable();
                        log.info('Restored atlas_managed mode without login state, waiting for re-auth');
                    }
                } else {
                    llmSource = saved.source;
                    clearAtlasManagedUnavailable();
                    log.info('Restored LLM source from file', { source: llmSource });
                }
            }
        }
    } catch { /* ignore */ }

    // Last inbound user information (for notify_user tool)
    // Persistence to file, automatically restored after restart
    const routerUserFile = join(workspace, '.router-user.json');
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
        // Ignore read failures
    }

    // Register notify_user tool (requires routerBridge to be initialized)
    tools.register(createNotifyTool({
        getRouterBridge: () => routerBridge,
        getLastUser: () => lastRouterUser,
    }));

    // Router inbound message processing: entering the Agent dialogue process
    let routerSessionId: string | null = null;

    /** Obtain or create Router-specific sessions (reuse existing sessions after restarting) */
    function getRouterSessionId(): string {
        // 1. If it has been cached and valid, use it directly
        if (routerSessionId) {
            const existing = sessions.get(routerSessionId);
            if (existing && existing.status === 'active') return routerSessionId;
        }
        // 2. Search for existing Router sessions (match by title)
        const allSessions = sessions.list();
        const routerSession = allSessions.find(s => s.title === 'Router Messages');
        if (routerSession) {
            routerSessionId = routerSession.id;
            log.info('Reusing existing Router session', { sessionId: routerSessionId });
            return routerSessionId;
        }
        // 3. If not found, create a new one
        const session = sessions.create('default', 'Router Messages');
        routerSessionId = session.id;
        log.info('Created Router dedicated session', { sessionId: routerSessionId });
        return routerSessionId;
    }

    /** Broadcast message to all authenticated clients */
    function broadcastToClients(msg: Record<string, unknown>): void {
        const data = JSON.stringify(msg);
        for (const c of clients.values()) {
            if (c.authenticated && c.ws.readyState === WebSocket.OPEN) {
                c.ws.send(data);
            }
        }
    }

    /**
     * Derivation of HTTP base address from Router WebSocket URL
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
     * Download multimedia files from Router to local
     * Call Router's GET /api/files/download?path=xxx interface
     */
    async function downloadRouterFile(remotePath: string, fileName: string): Promise<{ localPath: string; size: number } | null> {
        const baseUrl = getRouterHttpBaseUrl();
        const apiKey = routerBridge.getRawConfig()?.apiKey;
        if (!baseUrl || !apiKey) {
            log.error('Cannot download Router file: missing Router URL or API Key');
            return null;
        }

        // Local storage directory: {workspace}/data/router-files/{date}/
        // Use the resolved `workspace` (brand-isolated); config.workspace is the raw yaml value and
        // is undefined in auto mode, which would make join() throw.
        const date = new Date().toISOString().slice(0, 10);
        const localDir = join(workspace, 'data', 'router-files', date);
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

            // Log recent inbound users (for use by notify_user tool)
            lastRouterUser = {
                platform_type: msg.platform_type,
                platform_id: msg.platform_id,
                platform_user_id: msg.platform_user_id,
            };
            // persist to file
            try { writeFileSync(routerUserFile, JSON.stringify(lastRouterUser), 'utf-8'); } catch { /* neglect */ }
            const metadata = (msg.metadata || {}) as Record<string, string>;
            const contentType = msg.content_type || 'text';
            const isMedia = contentType !== 'text' && contentType !== 'post';

            // 1. Process multimedia messages: download files from Router to local
            let agentInput = msg.content;
            let attachments: Array<{ path: string; name: string; size: number; ext: string }> | undefined;

            if (isMedia) {
                const remotePath = metadata['local_path'] || msg.content;
                const originalName = metadata['file_name'] || '';
                // Generate safe filenames (preserve original extension, or infer based on content_type)
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

                    // Construct descriptive text as Agent input
                    const typeLabel: Record<string, string> = {
                        image: '图片', file: '文件', audio: '语音', video: '视频',
                    };
                    agentInput = `用户发送了一个${typeLabel[contentType] || '文件'}：${originalName || safeFileName}`;
                } else {
                    // Download failed, downgraded to text prompt
                    agentInput = `[${contentType}] 用户发送了一个文件，但下载失败，无法处理`;
                    log.warn('Multimedia file download failed, falling back to text', { remotePath });
                }
            }

            // 2. Broadcast user messages to clients (display user bubbles)
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
                    // Multimedia attachment information (for front-end rendering image preview, etc.)
                    attachments: attachments?.map(a => ({
                        name: a.name,
                        ext: a.ext,
                        size: a.size,
                        path: a.path,
                        content_type: contentType,
                    })),
                },
            });

            // 3. Call Agent for processing
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
                const agentResult = await executeAgent(
                    agentInput,
                    sessionId,
                    (event) => {
                        broadcastToClients({
                            type: 'chat.progress',
                            id: msgId,
                            payload: { ...event, sessionId },
                        });
                    },
                    attachments,     // Multimedia attachments (pictures/documents)
                    routerMetadata,
                );

                broadcastToClients({
                    type: 'chat.complete',
                    id: msgId,
                    payload: { output: agentResult.output, sessionId, status: agentResult.status },
                });

                // Return AI reply to platform
                routerBridge.send({
                    platform_type: msg.platform_type,
                    platform_id: msg.platform_id,
                    platform_user_id: msg.platform_user_id,
                    content_type: 'text',
                    content: agentResult.output,
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

                // Send friendly error messages back to platform users
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

    // Client management
    const clients = new Map<string, GatewayClient>();
    const toolApprovalBroker = new ToolApprovalBroker();
    let wss: WebSocketServer | null = null;

    // ========================
    // 设计画布桥接（design_canvas 工具 → 画布窗口）
    // ========================
    const canvasPending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

    /** 当前是否有已连接的画布窗口 */
    function isCanvasOpen(): boolean {
        for (const c of clients.values()) {
            if (c.role === 'canvas' && c.authenticated && c.ws.readyState === WebSocket.OPEN) return true;
        }
        return false;
    }

    /** 向画布窗口下发命令并等待回包 */
    function canvasCommand(command: string, params: Record<string, unknown>, timeoutMs = 20000): Promise<any> {
        const targets = [...clients.values()].filter(
            c => c.role === 'canvas' && c.authenticated && c.ws.readyState === WebSocket.OPEN,
        );
        if (targets.length === 0) {
            return Promise.reject(new Error('画布窗口未打开'));
        }
        const id = crypto.randomUUID();
        return new Promise<any>((resolve, reject) => {
            const timer = setTimeout(() => {
                canvasPending.delete(id);
                reject(new Error('画布命令超时（窗口无响应）'));
            }, timeoutMs);
            canvasPending.set(id, { resolve, reject, timer });
            // 下发给最近连接的画布窗口
            targets[targets.length - 1].ws.send(JSON.stringify({ type: 'canvas.command', id, payload: { command, params } }));
        });
    }

    // 画布快照落盘路径（工作区文件，跨重启 / 供 Agent 离线读取）
    const canvasSnapshotPath = join(workspace, 'canvas', 'openflux-canvas.json');

    // 注册 design_canvas 工具（设计师 Agent 使用）
    {
        const { createDesignCanvasTool } = await import('../tools/design-canvas');
        tools.register(createDesignCanvasTool({ command: canvasCommand, isOpen: isCanvasOpen, snapshotPath: canvasSnapshotPath }));
        log.info('design_canvas tool registered');
    }
    // Restore setupSkipped from persisted server-config.json so it survives Gateway restarts
    let setupSkipped = false;
    try {
        const cfgPath = join(workspace, 'server-config.json');
        if (existsSync(cfgPath)) {
            const saved = JSON.parse(readFileSync(cfgPath, 'utf-8'));
            if (saved._setupSkipped) {
                setupSkipped = true;
                log.info('Restored setupSkipped=true from server-config.json');
            }
        }
    } catch { /* ignore */ }

    // RouterBridge connection status broadcast (needs to be set after clients are initialized)
    routerBridge.onConnectionChange = (status) => {
        // Reset the bound when the connection changes and wait for connect_status to push the actual status
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
    // RouterBridge binding result broadcast
    routerBridge.onBindResult = (result) => {
        const message = JSON.stringify({ type: 'router.bind_result', payload: result });
        for (const c of clients.values()) {
            if (c.authenticated && c.ws.readyState === WebSocket.OPEN) {
                c.ws.send(message);
            }
        }
    };
    // RouterBridge connection status push (Router automatically pushes binding status after connecting)
    routerBridge.onConnectStatus = (connectStatus) => {
        // Convert to bind_result format for unified processing by the client
        const payload = connectStatus.bound
            ? { action: 'connect_status', status: 'matched', message: '已绑定', bound: true, platform_user_id: connectStatus.platform_user_id, platform_id: connectStatus.platform_id }
            : { action: 'connect_status', status: 'unbound', message: '未绑定', bound: false };
        const bindMsg = JSON.stringify({ type: 'router.bind_result', payload });
        // At the same time, push router.status to let the front end update the binding status.
        const statusMsg = JSON.stringify({ type: 'router.status', payload: { connected: true, status: 'connected', bound: connectStatus.bound } });
        for (const c of clients.values()) {
            if (c.authenticated && c.ws.readyState === WebSocket.OPEN) {
                c.ws.send(bindMsg);
                c.ws.send(statusMsg);
            }
        }
    };
    // RouterBridge QR binding code callback (broadcast to the front-end UI to render the QR code)
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
    // RouterBridge QR binding successful callback (the App scans the QR code and notifies the front-end UI)
    routerBridge.onQRBindSuccess = (data) => {
        log.info('[QR] onQRBindSuccess callback fired', data);
        const message = JSON.stringify({ type: 'router.qr_bind_success', payload: data });
        for (const c of clients.values()) {
            if (c.authenticated && c.ws.readyState === WebSocket.OPEN) {
                c.ws.send(message);
            }
        }
    };
    // RouterBridge LLM configuration delivery
    routerBridge.onLlmConfig = (cfg) => {
        try {
            const routerCfg = (config as any).router as RouterConfig;
            if (!routerCfg?.appId || !routerCfg?.apiKey) {
                log.warn('Received LLM config but Router has no appId/apiKey, cannot decrypt');
                return;
            }
            // AES-256-GCM Decryption API Key
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

            // If managed sources are currently in use, automatically rebuild the LLM instance so that the new configuration takes effect immediately
            if (llmSource === 'managed') {
                applyManagedConfig();
                log.info('Hosted LLM config auto hot-updated', { provider: managedLlmConfig.provider, model: managedLlmConfig.model });
            }

            // Pushed to all clients (excluding plaintext key)
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
     * Apply hosted run configuration to runtime (profiles -> config -> LLM rebuild)
     * Compatible with both old and new protocols: use managedRuntimeConfig first and fall back to managedLlmConfig
     */
    function applyManagedConfig(): void {
        if (managedRuntimeConfig) {
            // New protocol: multi-provider + multi-runtime
            if (!config.providers) config.providers = {} as any;
            // Save local providers snapshot (only when entering managed for the first time)
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
            // execution (configured using subagent, fallback to orchestration)
            const exec = managedRuntimeConfig.profiles.subagent || orch;
            config.llm.execution.provider = exec.provider as any;
            config.llm.execution.model = exec.model;
            // web.search configuration
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
            // Rebuild LLM
            const orchProv = managedRuntimeConfig.providers[orch.provider];
            llm = createLLMProvider({
                provider: orch.provider as any,
                model: orch.model,
                apiKey: orchProv?.apiKey || '',
                baseUrl: orchProv?.baseUrl,
            });
            agentManager.updateLLM(llm);
            agentRunner = createAgentLoopRunner({ llm, fallbackLlm, tools, language: config.language });
            // Synchronously update CardManager's chatLLM so that memory distillation uses the LLM provided by Router
            if (memoryManager && (memoryManager as any)._cardManager) {
                (memoryManager as any)._cardManager.updateChatLLM(llm);
            }
            skillForge.updateLLM(llm);
            log.info('Applied managed runtime config', {
                orchestration: `${orch.provider}/${orch.model}`,
                execution: `${exec.provider}/${exec.model}`,
            });
        } else if (managedLlmConfig) {
            // Old protocol: single provider + single model (compatible)
            if (!config.providers) config.providers = {} as any;
            // Save local providers snapshot (only when entering managed for the first time)
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
            // Synchronously update CardManager's chatLLM
            if (memoryManager && (memoryManager as any)._cardManager) {
                (memoryManager as any)._cardManager.updateChatLLM(llm);
            }
            skillForge.updateLLM(llm);
            log.info('Applied legacy managed LLM config', { provider: managedLlmConfig.provider, model: managedLlmConfig.model });
        }
    }

    // RouterBridge new protocol: managed_runtime_config issuance
    routerBridge.onManagedRuntimeConfig = (msg) => {
        try {
            const routerCfg = (config as any).router as RouterConfig;
            if (!routerCfg?.appId) {
                log.warn('Received managed_runtime_config but Router has no appId, cannot decrypt');
                return;
            }
            // decryption providers
            const decryptedProviders: Record<string, { apiKey: string; baseUrl?: string }> = {};
            for (const [name, prov] of Object.entries(msg.providers)) {
                const apiKey = decryptAPIKey(prov.api_key_encrypted, prov.iv, routerCfg.appId);
                decryptedProviders[name] = {
                    apiKey,
                    ...(prov.base_url ? { baseUrl: prov.base_url } : {}),
                };
            }
            // Decrypt web.search credentials
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

            // Decrypt image-generation credentials
            let imageCfg: ManagedRuntimeConfig['image'] = undefined;
            if (msg.image) {
                const im = msg.image;
                const imageApiKey = im.api_key_encrypted && im.iv
                    ? decryptAPIKey(im.api_key_encrypted, im.iv, routerCfg.appId) : undefined;
                imageCfg = {
                    provider: im.provider === 'gemini' ? 'gemini' : 'openai',
                    apiKey: imageApiKey,
                    model: im.model,
                    baseUrl: im.base_url,
                    size: im.size,
                    timeoutSeconds: im.timeout_seconds,
                };
            }

            managedRuntimeConfig = {
                profiles: msg.profiles,
                providers: decryptedProviders,
                web: webSearch,
                image: imageCfg,
                routing: msg.routing,
                quota: msg.quota,
            };
            log.info('Managed runtime config updated', {
                version: msg.version,
                orchestration: `${msg.profiles.orchestration.provider}/${msg.profiles.orchestration.model}`,
                providerCount: Object.keys(decryptedProviders).length,
                routingModules: Object.keys(msg.routing?.modules || {}).length,
            });

            // Automatic hot update if managed source is currently in use
            if (llmSource === 'managed') {
                applyManagedConfig();
                log.info('Managed runtime config auto hot-updated');
            }

            // Push to all clients
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
    // Initialize Router message processing callback
    setupRouterMessageHandler();
    // If there is a Router setting in the configuration, connect automatically
    if ((config as any).router?.enabled) {
        routerBridge.connect((config as any).router as RouterConfig);
        log.info('OpenFluxRouter bridge initialized and connected');
    } else {
        log.info('OpenFluxRouter bridge initialized (not enabled)');
    }

    // ══════════════════════════════════════════════════════════
    // WeChat iLink bridge (independent module, does not affect Router)
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
            // Save configuration after successful login
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

        // ── Inbound Messages -> Share Router Session ──
        weixinBridge.onMessage = async (msg) => {
            const sessionId = getRouterSessionId();
            const msgId = crypto.randomUUID();
            const userLabel = `[微信] ${msg.from_user_id}`;

            let agentInput = msg.content;
            let attachments: Array<{ path: string; name: string; size: number; ext: string }> | undefined;

            // Handle media messages
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

            // Broadcast user messages to the front end
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

            // Send typing status
            weixinBridge!.sendTyping(msg.from_user_id, true).catch(() => {});

            // Call Agent to process
            broadcastToClients({ type: 'chat.start', id: msgId });

            try {
                const agentResult = await executeAgent(
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
                    payload: { output: agentResult.output, sessionId, status: agentResult.status },
                });

                await weixinBridge!.sendText(msg.from_user_id, agentResult.output);
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

    // Initialize WeChat (loaded from independent configuration file)
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

    // Intercept console.* and broadcast all native console output to debug subscribers
    installConsoleCapture();

    // Register global log broadcast: push logs to all clients subscribed to debug
    // Use readyState === 1 instead of WebSocket.OPEN to avoid external module constants being lost after packaging
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
                    // Failure to send does not affect other clients
                }
            }
        }
    });

    // Browser status deduplication: only output info logs when status changes to avoid heartbeat log storms
    let lastBrowserStatusKey = '';

    /**
     * Execute Agent (routing and execution via AgentManager, supports file attachments)
     * Requests for the same session are automatically queued (promise chain), and different sessions are executed concurrently
     */
    type LocalEntity = (UserAgent & { kind: 'agent' }) | UserProject;

    function getLocalEntity(id: string | undefined): LocalEntity | undefined {
        if (!id) return undefined;
        const agent = userAgentStore.get(id);
        if (agent) return { ...agent, kind: 'agent' };
        return projectStore.get(id);
    }

    /** Register fixed runtime contexts for tool-bound Agents and all Projects. */
    function ensureBoundRoutingAgent(entity: LocalEntity | undefined): string | undefined {
        if (!entity) return undefined;
        const isProject = entity.kind === 'project';
        if (!isProject && (!entity.profile && !entity.tools)) return undefined;
        const tools: Record<string, unknown> = { ...(!isProject ? entity.tools || {} : {}) };
        tools.profile = isProject ? 'coding' : entity.profile;
        const projectWorkspace = isProject ? normalizeProjectWorkspace(entity.workspace) : undefined;
        agentManager.registerBoundAgent({
            id: entity.id,
            name: entity.name,
            description: entity.description,
            icon: entity.icon,
            color: entity.color,
            tools: tools as any,
            kind: entity.kind,
            workspace: projectWorkspace,
            projectRules: isProject ? entity.defaultRules : undefined,
            codeFirst: isProject ? true : undefined,
        } as any);
        return entity.id;
    }

    /**
     * 解析会话所属的 User Agent（单 Agent 多会话）
     * 优先级：旧格式 user-agent:{id} 前缀 → session metadata 的 agentId 字段
     */
    function resolveSessionLocalEntity(sessionId: string | undefined): LocalEntity | undefined {
        if (!sessionId) return undefined;
        if (sessionId.startsWith('user-agent:')) {
            return getLocalEntity(sessionId.replace('user-agent:', ''));
        }
        const meta = sessions.get(sessionId);
        if (meta?.agentId) return getLocalEntity(meta.agentId);
        return undefined;
    }

    /** 会话是否存在且未被删除（软删除视为不存在） */
    function isSessionActive(sessionId: string): boolean {
        const meta = sessions.get(sessionId);
        return !!meta && meta.status !== 'deleted';
    }

    /**
     * 返回 Agent 的主会话 id（定时任务等系统写入的兜底目标）。
     * 优先级：user-agent:{agentId} 默认会话 → 该 Agent 最近活跃的其他会话（最后剩下的自动成为主会话）
     * → 一个会话都没有时才重建默认会话。
     */
    function ensureAgentDefaultSession(agentId: string): string {
        const sessionKey = `user-agent:${agentId}`;
        if (isSessionActive(sessionKey)) {
            // 兜底修正：旧数据的默认会话 agentId 可能是 'default'，修正后才能按 Agent 归组
            const meta = sessions.get(sessionKey);
            if (meta && meta.agentId !== agentId) {
                sessions.updateAgentId(sessionKey, agentId);
            }
            return sessionKey;
        }
        // 默认会话已被删除：该 Agent 剩下的会话中最近活跃的自动作为主会话
        const remaining = listAgentSessions(agentId);
        if (remaining.length > 0) {
            log.info('Agent default session deleted, using latest remaining session as main', {
                agentId, mainSessionId: remaining[0].id,
            });
            return remaining[0].id;
        }
        // 名下已无任何会话：重建默认会话
            const entity = getLocalEntity(agentId);
            sessions.create(agentId, entity?.name || agentId, undefined, undefined, sessionKey);
        log.info('Ensured agent default session', { agentId, sessionKey });
        return sessionKey;
    }

    /**
     * 列出某个 Agent 名下的会话（多会话）。
     * 过滤云端会话 / Router 专用会话 / cron 兜底会话 / 历史迁移产生的 agent:X:main 死数据。
     */
    function listAgentSessions(agentId: string) {
        return sessions.list(agentId).filter(s =>
            !s.cloudChatroomId
            && !s.id.startsWith('agent:')
            && !s.id.startsWith('cron:')
            && s.title !== 'Router Messages'
        );
    }

    async function executeAgent(
        input: string,
        sessionId?: string,
        onProgress?: (event: AgentProgressEvent) => void,
        attachments?: Array<{ path: string; name: string; size: number; ext: string }>,
        userMetadata?: Record<string, unknown>,
        agentId?: string,
        abortController?: AbortController,
        agentRunOptions?: {
            llmOverride?: LLMProvider;
            retryCurrentUserMessage?: boolean;
            turnId?: string;
            requestApproval?: (request: ToolApprovalRequest) => Promise<ToolApprovalDecision>;
            approvalMode?: ApprovalMode;
            /** Already-owned execution supplied by the interactive Turn coordinator. */
            execution?: ActiveExecution;
            /** Guidance mailbox supplied by the interactive Turn coordinator. */
            drainSteering?: DrainSteering;
            drainGoalRevisions?: DrainGoalRevisions;
            getIntentEpoch?: () => number;
            onIntentInvalidated?: OnIntentInvalidated;
            waitForGoalReconciliation?: () => Promise<void>;
            /** Lease check used to suppress late persistence and events. */
            isRunActive?: () => boolean;
            workMode?: ExecutionWorkMode;
            planId?: string;
            planRevision?: number;
            planControl?: {
                requestInput(questions: PlanQuestion[]): Promise<{ planId: string; requestId: string }>;
                publishDocument(document: PlanDocument, note?: string): Promise<{ planId: string; revision: number }>;
            };
        },
    ): Promise<AgentExecutionResult> {
        const execKey = sessionId || `__anonymous_${crypto.randomUUID()}`;

        const runWithExecution = (execution: ActiveExecution) => telemetry.trace(
            'agent.turn',
            { traceId: execution.traceId },
            { sessionId, turnId: agentRunOptions?.turnId, runId: execution.runId },
            async () => {
            log.info('Executing task', { input: input.slice(0, 100), sessionId, activeCount: executionRegistry.activeCount });

            // User Agent session is automatically created: If sessionId starts with user-agent: and does not exist, it is automatically created
            if (sessionId && sessionId.startsWith('user-agent:') && !sessions.get(sessionId)) {
                const userAgentId = sessionId.replace('user-agent:', '');
                const userAgent = userAgentStore.get(userAgentId);
                // agentId 写入真实的 Agent id，供多会话按 Agent 归组
                sessions.create(userAgentId, userAgent?.name || userAgentId, undefined, undefined, sessionId);
                log.info('Auto-created session for user agent', { sessionId, agentName: userAgent?.name });
            }

            // If agentId is a user-level Agent (not in the routing Agent list),
            // Pass undefined to let the router automatically assign to the appropriate routing agent.
            let routingAgentId = agentId && agentManager.getAgent(agentId) ? agentId : undefined;

                // User Agent Identity Injection: resolve the owning user Agent
                // (legacy user-agent: prefix OR session metadata.agentId — supports multi-session per agent)
                let globalSettingsOverride: { globalAgentName?: string; globalSystemPrompt?: string } | undefined;
                {
                    const entity = resolveSessionLocalEntity(sessionId);
                    if (entity) {
                        globalSettingsOverride = {};
                        if (entity.name) globalSettingsOverride.globalAgentName = entity.name;
                        const entityPrompt = entity.kind === 'project'
                            ? buildProjectSystemPrompt(entity)
                            : entity.systemPrompt;
                        if (entityPrompt) globalSettingsOverride.globalSystemPrompt = entityPrompt;

                        // Tool-bound Agents and Projects use a fixed runtime context.
                        const boundId = ensureBoundRoutingAgent(entity);
                        if (boundId) routingAgentId = boundId;
                    }
                }

            const approvalMode = normalizeApprovalMode(
                agentRunOptions?.approvalMode,
                normalizeApprovalMode(sessionId ? sessions.get(sessionId)?.approvalMode : undefined),
            );
            const { execution: _execution, ...managerRunOptions } = agentRunOptions || {};
            const result = await agentManager.run(
                input,
                routingAgentId,
                sessionId,
                onProgress,
                attachments,
                userMetadata,
                globalSettingsOverride,
                execution.controller.signal,
                { ...managerRunOptions, approvalMode },
            );

            log.info(result.status === 'completed' ? 'Task completed' : 'Task finished without completion', {
                agentId: result.agentId,
                route: result.routeResult?.reason,
            });
            return { output: result.output, status: result.status };
        });

        if (agentRunOptions?.execution) return runWithExecution(agentRunOptions.execution);
        return executionRegistry.run({
            key: execKey,
            sessionId,
            turnId: agentRunOptions?.turnId,
            traceId: agentRunOptions?.turnId,
            controller: abortController,
        }, runWithExecution);
    }

    /**
     * Dedicated Agent execution for scheduled tasks
     *
     * After transformation, it is aligned with the normal chat path:
     * 1. Inject Agent identity (name + systemPrompt)
     * 2. Inject global skills
     * 3. Inject the summary of the previous round of execution results
     * 4. Inject current time + output path
     * 5. The results are written to the bound Agent session
     * 6. Prohibit the creation of new tasks (avoid recursion)
     */
    async function executeScheduledAgent(
        prompt: string,
        sessionId?: string,
        meta?: ScheduledTaskMeta
    ): Promise<string> {
        const taskName = meta?.taskName || '定时任务';
        const msgId = crypto.randomUUID();

        // ── 1. Parse the sessionId to ensure the correct Agent session is written. ──
        // Fallback priority: bound session → owning Agent's default session → main Agent's default session
        if (!sessionId) {
            sessionId = meta?.agentId
                ? ensureAgentDefaultSession(meta.agentId)
                : 'user-agent:main';
        }
        // Make sure the session exists (user-agent:xxx or cron:xxx format).
        // 多会话下任务可能绑定到普通 UUID 会话：若该会话已被删除，则回退写入所属 Agent 的默认会话。
        if (!isSessionActive(sessionId)) {
            if (sessionId.startsWith('user-agent:')) {
                const agentId = sessionId.replace('user-agent:', '');
                if (getLocalEntity(agentId)) {
                    // 默认会话被删除时优先写入该 Agent 剩余的主会话，而不是直接重建
                    sessionId = ensureAgentDefaultSession(agentId);
                } else {
                    sessions.create(agentId, taskName, undefined, undefined, sessionId);
                }
            } else if (meta?.agentId && getLocalEntity(meta.agentId)) {
                const fallback = ensureAgentDefaultSession(meta.agentId);
                log.info('Scheduled task session missing, rerouted to agent default session', {
                    taskName, boundSessionId: sessionId, fallback,
                });
                sessionId = fallback;
            } else if (!sessions.get(sessionId)) {
                sessions.create('default', `🕐 ${taskName}`, undefined, undefined, sessionId);
            }
        }

        // ── 2. Check the Agent's identity ──
        let agentName: string | undefined;
        let agentSystemPrompt: string | undefined;
        let scheduledWorkspaceRoot: string | undefined;
        {
            const entity = (meta?.agentId ? getLocalEntity(meta.agentId) : undefined)
                || resolveSessionLocalEntity(sessionId);
            if (entity) {
                agentName = entity.name;
                agentSystemPrompt = entity.kind === 'project'
                    ? buildProjectSystemPrompt(entity)
                    : entity.systemPrompt;
                scheduledWorkspaceRoot = entity.kind === 'project'
                    ? normalizeProjectWorkspace(entity.workspace)
                    : undefined;
            } else if (sessionId.startsWith('user-agent:')) {
                log.warn('Scheduled task agent not found, using default identity', { sessionId, taskName });
            }
        }

        // ── 3. Acquire global skills ──
        const skills = agentManager.getAgentsConfig()?.skills as
            Array<{ id: string; title: string; content: string; enabled: boolean }> | undefined;

        // ── 4. Load the last round of executive summary ──
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
                        `## 上一次执行结果（${formatDate(lastSuccess.startedAt)}）`,
                        `以下是该任务上一次自动执行的结果摘要，你可以参考但不要机械重复：`,
                        summary,
                    ].join('\n');
                }
            } catch (e) {
                log.warn('Failed to load previous run for context', { taskId: meta.taskId, error: e });
            }
        }

        // ── 5. Inject the current time (scheduled tasks especially need to know "today") ──
        const now = new Date();
        const dateStr = formatNow();
        const timeContext = `\n\n## 当前时间\n现在是 ${dateStr}（${now.toISOString()}）。`;

        // ── 6. Inject output path ──
        let outputContext = '';
        const outputPath = scheduledWorkspaceRoot || runtimeSettings.outputPath;
        if (outputPath) {
            outputContext = scheduledWorkspaceRoot
                ? `\n\n## 项目工作目录\n项目根目录：${outputPath}\n直接在项目结构内工作，不要创建 OpenFlux 日期归档目录。`
                : `\n\n## 文件输出目录\n基础输出目录：${outputPath}\n当前任务目录：${outputPath}/${getTodayStr()}/${taskName}/`;
        }

        log.info('Scheduled task executing', {
            taskName,
            prompt: prompt.slice(0, 100),
            sessionId,
            agentName: agentName || '(default)',
            hasSkills: !!skills?.length,
            hasPreviousContext: !!previousRunContext,
        });

        // ── 7. Queue execution through the same registry used by interactive chat ──
        const execKey = sessionId;
        const tracker = sessionId ? new TurnTracker({
            sessionId,
            turnId: msgId,
            traceId: msgId,
            persist: event => sessions.addEvent(sessionId, event),
            emit: event => broadcastToClients({ type: 'agent.event', id: msgId, payload: event }),
        }) : undefined;

        return executionRegistry.run({ key: execKey, sessionId, turnId: msgId }, async execution =>
            runWithAgentExecutionContext({
                sessionId,
                turnId: msgId,
                runId: execution.runId,
                abortSignal: execution.controller.signal,
                workspaceRoot: scheduledWorkspaceRoot,
            }, async () => {
            tracker?.start();

            // Save trigger message
            if (sessionId) {
                sessions.addMessage(sessionId, {
                    role: 'assistant',
                    content: `🕐 **定时任务触发：${taskName}**`,
                });
            }

            // Broadcast scheduled task starts
            broadcastToClients({
                type: 'chat.progress',
                id: msgId,
                payload: { type: 'iteration', iteration: 0, sessionId },
            });

            // ── 8. Assemble Prompt ──
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

            // ── 9. Run Agent Loop (inject Agent identity + skills) ──
            try {
                const result = await agentRunner.run(
                    wrappedPrompt,
                    undefined,
                    {
                        onIteration: () => { },
                        onToken: () => { },
                        // Raw model reasoning is neither logged nor broadcast. The UI receives
                        // public action summaries and deterministic checkpoints instead.
                        onThinking: () => { },
                        onToolStart: (description: string, toolCalls: Array<{ id?: string; name: string }>, llmContent?: string) => {
                            tracker?.handleLegacyProgress({
                                type: 'tool_start',
                                description,
                                llmDescription: llmContent,
                                toolCalls: toolCalls.map(call => ({ id: call.id || crypto.randomUUID(), name: call.name })),
                            });
                            broadcastToClients({
                                type: 'chat.progress',
                                id: msgId,
                                payload: { type: 'tool_start', description, sessionId },
                            });
                        },
                        onToolCall: (toolCall: { id?: string; name: string; arguments: Record<string, unknown> }, toolResult: unknown) => {
                            const success = !isToolResultFailure(toolResult);
                            tracker?.handleLegacyProgress({
                                type: 'tool_result',
                                tool: toolCall.name,
                                toolCallId: toolCall.id,
                                failed: !success,
                            });
                            if (sessionId) {
                                sessions.addLog(sessionId, {
                                    tool: toolCall.name,
                                    action: toolCall.arguments?.action as string | undefined,
                                    args: toolCall.arguments,
                                    success,
                                });
                            }
                            // Broadcast tool results to the front end (so that scheduled tasks can also detect deliverables in real time)
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
                    [],             // Empty history (context injected via prompt, keep it clean)
                    undefined,      // contentParts
                    {               // ★ globalSettings: Inject Agent identity + skills
                        globalAgentName: agentName,
                        globalSystemPrompt: agentSystemPrompt,
                        skills: skills,
                        sessionId,
                        isScheduledTask: true,
                    },
                );

                // Save Assistant Reply
                if (sessionId) {
                    sessions.addMessage(sessionId, { role: 'assistant', content: result.output });

                    // The backend extracts artifacts and saves them to the session (does not rely on front-end postback)
                    extractAndSaveScheduledArtifacts(sessionId, result.toolCalls);
                }

                // broadcast completion event
                broadcastToClients({
                    type: 'chat.progress',
                    id: msgId,
                    payload: { type: 'complete', sessionId },
                });
                tracker?.complete(`定时任务「${taskName}」已完成`);

                log.info('Scheduled task completed', {
                    taskName,
                    agentName: agentName || '(default)',
                    iterations: result.iterations,
                    toolCalls: result.toolCalls.length,
                });

                // Notify the front end to refresh the session (the scheduled task output has been written to the agent session)
                if (sessionId) {
                    broadcastSessionUpdate(sessionId);
                }

                return result.output;
            } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                tracker?.fail(errorMsg);
                if (sessionId) {
                    sessions.addMessage(sessionId, {
                        role: 'assistant',
                        content: `定时任务「${taskName}」执行失败：${errorMsg}`,
                    });
                    broadcastSessionUpdate(sessionId);
                }
                throw error;
            } finally {
                // Clean up temporary tabs created by scheduled tasks (to avoid browser tab leaks)
                if (sessionId) {
                    cleanupScheduledPages(sessionId);
                }
            }
            })
        );
    }
    /**
     * Extract artifacts from tool call records of scheduled tasks and save them to session
     * Detect the generated files of filesystem.write/copy/info and process/opencode
     */
    function extractAndSaveScheduledArtifacts(
        sessionId: string,
        toolCalls: Array<{ name: string; result: unknown }>,
    ): void {
        const savedPaths = new Set<string>();
        // resolvePath has been imported at the top of the file

        // 读取文件真实修改时间（用于成果物按真实产出时间归档）
        const fileMtime = (p: string): number | undefined => {
            try { return statSync(p).mtimeMs; } catch { return undefined; }
        };
        // stdout 兜底的时效窗口：只接受最近这段时间内被修改的文件，
        // 避免把命令输出里被读取/引用的历史旧文件误当成本次产出
        const STDOUT_RECENT_WINDOW_MS = 30 * 60 * 1000;
        const recentThreshold = Date.now() - STDOUT_RECENT_WINDOW_MS;

        // Common fruit extensions
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

                // filesystem.write / filesystem.copy -> directly take data.path / data.destination
                // Extract results only for write operations (not read/info/list)
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
                                        type: 'file', path: filePath, filename, size, timestamp: fileMtime(filePath) || Date.now(),
                                    });
                                    log.info('Scheduled task artifact saved', { filename, path: filePath });
                                }
                            } catch { /* ignore */ }
                        }
                    }
                }

                // process/opencode -> detect generatedFiles
                // 说明：process/opencode 工具已在后端用"目录快照(diff)+ stdout(按 mtime 过滤)"
                // 得出可靠的 generatedFiles（仅含本次运行真正产出/修改的文件，并携带 mtimeMs），
                // 因此这里不再做额外的 stdout 正则兜底，避免把被读取/引用的历史旧文件误收。
                if ((tc.name === 'process' || tc.name === 'opencode') && data) {
                    const generatedFiles = data.generatedFiles as Array<{ path: string; fullPath: string; size: number; mtimeMs?: number }> | undefined;
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
                                            timestamp: f.mtimeMs || fileMtime(f.fullPath) || Date.now(),
                                        });
                                        log.info('Scheduled task artifact saved', { filename: f.path, path: f.fullPath });
                                    }
                                } catch { /* ignore */ }
                            }
                        }
                    }
                }

                // filesystem.info does not produce results (only query file information, not a generation operation)

                // windows (powershell/com) -> extract file path from stdout
                if (tc.name === 'windows' && data) {
                    const stdout = (data.stdout as string) || '';
                    if (stdout) {
                        const foundPaths: string[] = [];
                        // Strategy 1: Line-by-line detection, allowing paths with spaces (from drive letter to end-of-line extension)
                        const lines = stdout.split(/\r?\n/);
                        const linePathRegex = /([A-Z]:[/\\].+\.(?:pptx?|docx?|xlsx?|pdf|png|jpg|jpeg|gif|svg|mp4|mp3|zip|csv|html|txt|md|py|js|ts|json|yaml))\b/i;
                        for (const line of lines) {
                            const m = line.match(linePathRegex);
                            if (m) foundPaths.push(m[1].trim());
                        }
                        // Remove duplicates + save
                        for (const p of [...new Set(foundPaths)]) {
                            const resolved = resolvePath(p);
                            if (!savedPaths.has(resolved)) {
                                try {
                                    if (existsSync(resolved)) {
                                        // 仅接受最近修改的文件，过滤被读取/引用的历史旧文件
                                        const mtime = fileMtime(resolved);
                                        if (mtime === undefined || mtime < recentThreshold) continue;
                                        savedPaths.add(resolved);
                                        sessions.addArtifact(sessionId, {
                                            type: 'file',
                                            path: resolved,
                                            filename: resolved.split(/[/\\]/).pop() || resolved,
                                            timestamp: mtime,
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

    // Bind scheduler Agent execution callback
    schedulerAgentExecute = executeScheduledAgent;
    scheduler.start();
    log.info('Scheduler started');

    /**
     * Broadcast scheduler events to all online clients
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
     * Broadcast session update notification (notify the front end to refresh the session list or specify session messages)
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
     * handle connections
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

        // Push the Router status as soon as the client connects (the frontend may miss the connect_status push on startup)
        if (client.authenticated) {
            const rs = routerBridge.getStatus();
            const routerStatusMsg = JSON.stringify({ type: 'router.status', payload: { connected: rs.connected, status: rs.connected ? 'connected' : 'disconnected', bound: rs.bound } });
            ws.send(routerStatusMsg);
            // Push WeChat iLink status
            if (weixinBridge) {
                const wxs = weixinBridge.getStatus();
                ws.send(JSON.stringify({ type: 'weixin.status', payload: { connected: wxs.connected, status: wxs.connected ? 'connected' : 'disconnected' } }));
            }
        }

        // Check whether it is running for the first time (server-config.json does not exist or there is no providers configuration)
        let setupRequired = false;
        if (setupSkipped || config.brandLock?.skipSetup) {
            // Enterprise editions bake in all config (NexusAI/Router/LLM) → never show the wizard
            setupRequired = false;
        } else
            try {
                const cfgPath = join(workspace, 'server-config.json');
                if (!existsSync(cfgPath)) {
                    // server-config.json does not exist, check if the providers in openflux.yaml have a real apiKey
                    const hasRealKey = config.providers && Object.values(config.providers).some(
                        (p: any) => p?.apiKey && !p.apiKey.startsWith('${')
                    );
                    if (!hasRealKey) setupRequired = true;
                } else {
                    const raw = readFileSync(cfgPath, 'utf-8');
                    const saved = JSON.parse(raw);
                    // If setup is marked Skip, setup is no longer required
                    if (saved._setupSkipped) {
                        setupRequired = false;
                    } else if (!saved.providers || Object.keys(saved.providers).length === 0) {
                        setupRequired = true;
                    } else {
                        const hasKey = Object.values(saved.providers).some(
                            (p: any) => p?.apiKey && !p.apiKey.startsWith('${')
                        );
                        // Old users may inject apiKey through environment variables, and there is only ${ENV_VAR} placeholder in the config.
                        // If llm.orchestration.provider has been configured (it means the setting has been completed), skip the wizard directly.
                        const hasLlmConfig = saved.llm?.orchestration?.provider && saved.llm?.orchestration?.model;
                        if (!hasKey && !hasLlmConfig) setupRequired = true;
                    }
                }
            } catch {
                setupRequired = true;
            }

        send(client, {
            type: 'welcome',
            payload: {
                requireAuth: !!token,
                setupRequired,
                capabilities: { agentEvents: 1, sessionEventReplay: true, toolApproval: true, planMode: 1 },
            },
        });

        ws.on('message', (data: Buffer) => handleMessage(client, data.toString()));
        ws.on('close', () => {
            // Clean client MCP proxy tool
            const removedToolNames = new Set<string>();
            if (client.clientMcpToolNames?.length) {
                for (const name of client.clientMcpToolNames) {
                    tools.unregister(name);
                    removedToolNames.add(name);
                }
                log.info(`Client ${clientId} disconnected, cleaned up ${client.clientMcpToolNames.length} proxy tools`);
            }
            // Clean up Plugin Protocol v1 registration records
            for (const [id, info] of pluginRegistry.entries()) {
                if (info.clientId === clientId) {
                    pluginRegistry.delete(id);
                    log.info(`Plugin "${info.name}" (${id}) removed due to client disconnect`);
                }
            }
            // Clean Excel multiple workbook routing table
            for (const [wbName, wbClient] of pluginWorkbookClients.entries()) {
                if (wbClient.id === clientId) {
                    pluginWorkbookClients.delete(wbName);
                    log.info(`Excel workbook "${wbName}" removed from routing table (client disconnected)`);
                }
            }
            // Clean up the Word multi-document routing table
            for (const [pid, entry] of pluginDocumentClients.entries()) {
                if (entry.client.id === clientId) {
                    pluginDocumentClients.delete(pid);
                    log.info(`Word document "${entry.docName}" (${pid}) removed from routing table (client disconnected)`);
                }
            }

            // 断开重挂：多个同类 Office 插件（工具同名）共存时，一个实例断开会把共享的
            // 同名代理工具整体注销，导致其他仍在线实例的工具从 Agent 上"消失"。
            // 这里让任一存活的插件客户端凭其注册消息把这批工具重新挂回。
            if (removedToolNames.size > 0) {
                for (const survivor of clients.values()) {
                    if (survivor.id === clientId || !survivor.pluginRegisterMessage) continue;
                    const survivorTools = survivor.clientMcpToolNames ?? [];
                    if (survivorTools.some((n) => removedToolNames.has(n))) {
                        log.info(`Re-registering plugin tools from surviving client ${survivor.id} after ${clientId} disconnect`);
                        try {
                            // 去掉原始 message.id，避免插件端收到重复 ack 误判
                            handlePluginRegister(survivor, { ...survivor.pluginRegisterMessage, id: undefined });
                        } catch (e) {
                            log.warn(`Plugin tool re-registration failed for client ${survivor.id}: ${e instanceof Error ? e.message : String(e)}`);
                        }
                        break;
                    }
                }
            }


            // If the client is still in the debug subscription state when disconnected, reduce the count (to avoid the log level permanently stopping at debug)
            if (client.debugSubscribed) {
                decrementDebugSubscribers();
            }
            const wasCanvas = client.role === 'canvas';
            clients.delete(clientId);
            toolApprovalBroker.disconnect(clientId);
            log.info(`Client disconnected: ${clientId}`);
            // 画布窗口断开：拒绝挂起命令并广播画布关闭状态
            if (wasCanvas && !isCanvasOpen()) {
                for (const [pid, pend] of canvasPending.entries()) {
                    clearTimeout(pend.timer);
                    pend.reject(new Error('画布窗口已关闭'));
                    canvasPending.delete(pid);
                }
                broadcastToClients({ type: 'canvas.status', payload: { open: false } });
            }
        });
        ws.on('error', (error: Error) => log.error(`Client error: ${clientId}`, { error }));
    }

    // P3 migration seam: high-traffic chat/session domains use a typed router;
    // the remaining legacy domains continue through the switch below.
    const coreMessageRouter = new MessageRouter<GatewayClient, GatewayMessage>()
        .register('auth', handleAuth)
        .register('client.register', handleClientRegister)
        .register('chat', handleChat)
        .register('chat.stop', handleChatStop)
        .register('chat.runtime.get', handleChatRuntimeGet)
        .register('chat.queue.update', handleChatQueueUpdate)
        .register('chat.queue.reorder', handleChatQueueReorder)
        .register('chat.queue.delete', handleChatQueueDelete)
        .register('chat.queue.send-now', handleChatQueueSendNow)
        .register('chat.queue.pause', handleChatQueuePause)
        .register('chat.queue.resume', handleChatQueueResume)
        .register('chat.queue.clear', handleChatQueueClear)
        .register('tool.approval.resolve', handleToolApprovalResolve)
        .register('work.state.get', handleWorkStateGet)
        .register('work.mode.set', handleWorkModeSet)
        .register('plan.input.resolve', handlePlanInputResolve)
        .register('plan.revise', handlePlanRevise)
        .register('plan.approve', handlePlanApprove)
        .register('plan.save', handlePlanSave)
        .register('plan.cancel', handlePlanCancel)
        .register('sessions.list', handleSessionsList)
        .register('sessions.messages', handleSessionsMessages)
        .register('sessions.logs', handleSessionsLogs)
        .register('sessions.events', handleSessionsEvents)
        .register('sessions.create', handleSessionsCreate)
        .register('sessions.approval-mode.update', handleSessionApprovalModeUpdate)
        .register('sessions.delete', handleSessionsDelete)
        .register('sessions.rename', handleSessionsRename)
        .register('sessions.artifacts', handleSessionsArtifacts)
        .register('sessions.artifacts.save', handleSessionsArtifactsSave);

    /** Process messages. */
    async function handleMessage(client: GatewayClient, data: string): Promise<void> {
        try {
            const message: GatewayMessage = JSON.parse(data);
            if (!client.authenticated && message.type !== 'auth') {
                send(client, { type: 'error', payload: { message: '未认证' } });
                return;
            }

            const handledByCore = await telemetry.trace(
                'gateway.request',
                { traceId: message.id },
                { messageType: message.type, clientId: client.id },
                () => coreMessageRouter.dispatch(client, message),
            );
            if (handledByCore) return;

            switch (message.type) {
                // ========================
                // Agent management
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
                    if (src === 'managed') {
                        // 即使托管配置尚未到达也保持 managed，不再静默降级为 local
                        // （否则 UI 显示团队模式、网关实际跑单机配置，图像等工具会误用本地 key）
                        llmSource = 'managed';
                        clearAtlasManagedUnavailable();
                        if (managedRuntimeConfig || managedLlmConfig) {
                            applyManagedConfig();
                            log.info('Switched to managed config');
                        } else {
                            log.warn('Switched to managed mode but config not yet received from Router; waiting for push', {
                                routerConnected: routerBridge.isConnected(),
                            });
                        }
                    } else if (src === 'atlas_managed') {
                        // Atlas hosting mode: Use NexusAI access_token to go to Atlas Model Access Gateway
                        // 与 managed 一致：即使未登录/未就绪也切到 atlas_managed，不静默降级为 local。
                        // 否则 UI 显示「托管」而网关偷偷以单机(local)跑聊天（显示≠实际）。
                        // 切到 atlas_managed 后，未登录时聊天会在 handleChat 处被拦截并要求登录。
                        llmSource = 'atlas_managed';
                        // Save local providers snapshot
                        if (!localProvidersSnapshot) {
                            localProvidersSnapshot = JSON.parse(JSON.stringify(config.providers || {}));
                        }

                        const atlasToken = openfluxBridge.getToken();
                        if (!atlasToken) {
                            // 仍上报错误供 UI 提示登录；source 回传 atlas_managed，保证显示与网关实际一致
                            send(client, { type: 'config.llm-source', id: message.id, payload: { source: 'atlas_managed', error: '请先登录 NexusAI 账号' } });
                            break;
                        }

                        const refreshState = await refreshAtlasManagedRuntime({
                            allowCachedRuntimeOnFailure: true,
                            logLabel: 'Switch atlas_managed runtime refresh',
                        });

                        if (refreshState.status === 'auth_expired') {
                            send(client, { type: 'config.llm-source', id: message.id, payload: { source: 'atlas_managed', error: '请先重新登录 NexusAI 账号' } });
                            break;
                        }

                        if (llm) {
                            log.info('Atlas managed mode active');
                        } else {
                            log.warn('Atlas managed mode entered without available runtime', { status: refreshState.status, message: refreshState.message });
                        }
                    } else {
                        llmSource = 'local';
                        clearAtlasManagedUnavailable();
                        // Restore from local providers snapshot (preferred) to avoid server-config.json being contaminated by Router key
                        if (localProvidersSnapshot) {
                            (config as any).providers = JSON.parse(JSON.stringify(localProvidersSnapshot));
                            localProvidersSnapshot = null;
                        }
                        // Restore llm model configuration from server-config.json
                        try {
                            const cfgPath = join(workspace, 'server-config.json');
                            if (existsSync(cfgPath)) {
                                const saved = JSON.parse(readFileSync(cfgPath, 'utf-8'));
                                if (!localProvidersSnapshot && saved.providers) {
                                    // When the snapshot does not exist (directly local when started for the first time), restore from the file
                                    (config as any).providers = saved.providers;
                                }
                                if (saved.llm) {
                                    Object.assign(config.llm, saved.llm);
                                }
                            }
                        } catch (e) {
                            log.error('Restore local LLM config failed', { error: e });
                        }
                        // Rebuild the LLM instance and clear the cache
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
                        // Synchronously update CardManager's chatLLM
                        if (memoryManager && (memoryManager as any)._cardManager) {
                            (memoryManager as any)._cardManager.updateChatLLM(llm);
                        }
                        skillForge.updateLLM(llm);
                        log.info('Switched to local LLM config');
                    }
                    // Persist llmSource to file
                    try { writeFileSync(llmSourceFile, JSON.stringify({ source: llmSource }), 'utf-8'); } catch { /* ignore */ }
                    send(client, { type: 'config.llm-source', id: message.id, payload: { source: llmSource } });
                    break;
                }
                case 'config.get-llm-source': {
                    // Return to new protocol configuration first
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
                    // User skips boot setup: memory tags + file persistence
                    setupSkipped = true;
                    try {
                        const cfgPath = join(workspace, 'server-config.json');
                        // Always write _setupSkipped to a file (regardless of whether the file already exists)
                        let existing: Record<string, unknown> = { providers: {} };
                        if (existsSync(cfgPath)) {
                            try {
                                existing = JSON.parse(readFileSync(cfgPath, 'utf-8'));
                            } catch { /* If the file is damaged, use the default value. */ }
                        }
                        existing._setupSkipped = true;
                        writeFileSync(cfgPath, JSON.stringify(existing, null, 2), 'utf-8');
                        log.info('User skipped first-time setup, marker persisted');
                        send(client, { type: 'setup.skipped', id: message.id, payload: { message: '已跳过设置' } });
                    } catch (err) {
                        log.error('Skip setup marking failed', err);
                        send(client, { type: 'setup.error', id: message.id, payload: { message: '标记失败' } });
                    }
                    break;
                }
                case 'debug.subscribe':
                    client.debugSubscribed = true;
                    incrementDebugSubscribers();
                    console.log(`[DEBUG] Client ${client.id} subscribed to debug logs, clients=${clients.size}`);
                    log.info(`Client ${client.id} subscribed to debug logs`);
                    break;
                case 'debug.unsubscribe':
                    client.debugSubscribed = false;
                    decrementDebugSubscribers();
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
                // 应用层心跳：插件(Office WebView 无法发 WS ping 帧)定时发 {type:'ping'}，
                // 网关回 {type:'pong'}。插件据此检测"半开死连接"并主动重连，避免幽灵工具。
                case 'ping':
                    send(client, { type: 'pong', id: message.id, payload: { t: Date.now() } });
                    break;
                // Plugin Protocol v1 - upwardly compatible with mcp.client.*
                case 'plugin.register':
                    handlePluginRegister(client, message);
                    break;
                case 'plugin.unregister':
                    handlePluginUnregister(client, message);
                    break;
                case 'plugin.list':
                    handlePluginList(client, message);
                    break;
                case 'plugin.status':
                    handlePluginStatusUpdate(client, message);
                    break;
                // ── Browser recording (Chrome recorder extension) ──────────────
                case 'recording.start': {
                    const p = (message.payload as any) || {};
                    try {
                        recordingStore.start({
                            id: p.recordingId,
                            title: p.title,
                            startUrl: p.startUrl,
                            createdAt: p.createdAt,
                        });
                        send(client, { type: 'recording.start.result', id: message.id, payload: { success: true, recordingId: p.recordingId } });
                    } catch (e) {
                        send(client, { type: 'recording.start.result', id: message.id, payload: { error: e instanceof Error ? e.message : String(e) } });
                    }
                    break;
                }
                case 'recording.event': {
                    const p = (message.payload as any) || {};
                    try {
                        if (p.recordingId && p.step) recordingStore.appendStep(p.recordingId, p.step);
                    } catch (e) {
                        log.warn('recording.event failed', { error: e instanceof Error ? e.message : String(e) });
                    }
                    break;
                }
                case 'recording.stop': {
                    const p = (message.payload as any) || {};
                    const rec = recordingStore.stop(p.recordingId, p.updatedAt);
                    send(client, { type: 'recording.stop.result', id: message.id, payload: { success: !!rec, stepCount: rec?.steps.length || 0 } });
                    // 异步归纳录制意图（总目标 + 每步意图 + 可选步骤标记），供回放语义兜底使用；
                    // 失败不影响录制本身，回放时按无 intent 的旧逻辑走。
                    // 生成后广播给前端展示，让用户确认"系统理解的目的"是否准确（不准可在聊天里修正）。
                    if (rec && rec.steps.length > 0 && llm) {
                        const llmRef = llm;
                        import('../recording/intent')
                            .then(({ generateRecordingIntent }) => generateRecordingIntent(rec, llmRef))
                            .then((intent) => {
                                if (!intent) return;
                                recordingStore.saveIntent(rec.id, intent);
                                // 广播归纳结果：录制扩展 popup 收到后刷新列表展示目的，
                                // 用户在插件端确认/修正后再决定是否转发给 OpenFlux
                                broadcastToClients({
                                    type: 'recording.intent',
                                    payload: {
                                        recordingId: rec.id,
                                        title: rec.title,
                                        goal: intent.goal,
                                        stepCount: rec.steps.length,
                                        intentCount: intent.steps.length,
                                    },
                                });
                            })
                            .catch((e) => log.warn('Recording intent generation failed', { error: e instanceof Error ? e.message : String(e) }));
                    }
                    break;
                }
                case 'recording.list': {
                    // 附带意图归纳的目的：popup 列表展示"系统理解的目的"，未生成完为 undefined
                    const recordings = recordingStore.list().map((s) => ({
                        ...s,
                        goal: recordingStore.loadIntent(s.id)?.goal,
                    }));
                    send(client, { type: 'recording.list.result', id: message.id, payload: { recordings } });
                    break;
                }
                case 'recording.setGoal': {
                    // 用户在录制扩展 popup 里修正"录制目的"
                    const p = (message.payload as any) || {};
                    const rec = p.recordingId ? recordingStore.load(String(p.recordingId)) : null;
                    const goal = String(p.goal || '').trim();
                    if (!rec || !goal) {
                        send(client, { type: 'recording.setGoal.result', id: message.id, payload: { error: !rec ? '录制不存在' : '缺少 goal' } });
                        break;
                    }
                    const existingIntent = recordingStore.loadIntent(rec.id);
                    recordingStore.saveIntent(rec.id, {
                        goal,
                        steps: existingIntent?.steps || [],
                        generatedAt: existingIntent?.generatedAt || Date.now(),
                    });
                    log.info(`Recording goal corrected via plugin: ${rec.id} -> "${goal}"`);
                    send(client, { type: 'recording.setGoal.result', id: message.id, payload: { success: true, goal } });
                    break;
                }
                case 'recording.get': {
                    const p = (message.payload as any) || {};
                    const rec = recordingStore.load(p.recordingId);
                    send(client, { type: 'recording.get.result', id: message.id, payload: rec ? { recording: rec } : { error: '录制不存在' } });
                    break;
                }
                case 'recording.delete': {
                    const p = (message.payload as any) || {};
                    const ok = recordingStore.delete(p.recordingId);
                    send(client, { type: 'recording.delete.result', id: message.id, payload: { success: ok } });
                    break;
                }
                case 'recording.toWorkflow': {
                    const p = (message.payload as any) || {};
                    try {
                        const { recordingToWorkflow } = await import('../recording/converter');
                        const rec = recordingStore.load(p.recordingId);
                        if (!rec) { send(client, { type: 'recording.toWorkflow.result', id: message.id, payload: { error: '录制不存在' } }); break; }
                        const workflowId = recordingToWorkflow(rec, workflowStore);
                        send(client, { type: 'recording.toWorkflow.result', id: message.id, payload: { workflowId } });
                    } catch (e) {
                        send(client, { type: 'recording.toWorkflow.result', id: message.id, payload: { error: e instanceof Error ? e.message : String(e) } });
                    }
                    break;
                }
                case 'recording.toSkill': {
                    const p = (message.payload as any) || {};
                    try {
                        const { recordingToSkill } = await import('../recording/converter');
                        const rec = recordingStore.load(p.recordingId);
                        if (!rec) { send(client, { type: 'recording.toSkill.result', id: message.id, payload: { error: '录制不存在' } }); break; }
                        const skillId = recordingToSkill(rec, evolutionData);
                        broadcastToClients({ type: 'evolution.skills.updated' });
                        send(client, { type: 'recording.toSkill.result', id: message.id, payload: { skillId } });
                    } catch (e) {
                        send(client, { type: 'recording.toSkill.result', id: message.id, payload: { error: e instanceof Error ? e.message : String(e) } });
                    }
                    break;
                }
                case 'recording.forward': {
                    // 转发录制到 OpenFlux 主界面：广播给前端，由前端预填到聊天框
                    const p = (message.payload as any) || {};
                    const rec = recordingStore.load(p.recordingId);
                    if (!rec) {
                        send(client, { type: 'recording.forward.result', id: message.id, payload: { error: '录制不存在' } });
                        break;
                    }
                    broadcastToClients({
                        type: 'recording.forward',
                        payload: {
                            id: rec.id,
                            title: rec.title,
                            startUrl: rec.startUrl,
                            stepCount: rec.steps.length,
                            // 用户在插件端确认/修正过的录制目的（可能尚未生成完，为 undefined）
                            goal: recordingStore.loadIntent(rec.id)?.goal,
                        },
                    });
                    log.info('Recording forwarded to OpenFlux UI', { recordingId: rec.id, steps: rec.steps.length });
                    send(client, { type: 'recording.forward.result', id: message.id, payload: { success: true } });
                    break;
                }
                case 'canvas.register': {
                    // 画布窗口注册：标记角色，便于 design_canvas 工具定向下发命令
                    client.role = 'canvas';
                    send(client, { type: 'canvas.register.result', id: message.id, payload: { ok: true } });
                    broadcastToClients({ type: 'canvas.status', payload: { open: true } });
                    log.info('Canvas window registered', { clientId: client.id });
                    break;
                }
                case 'canvas.prompt': {
                    // 画布「按标注生成」快捷操作：把提示词转发给主窗口，由其切到设计师 Agent 并发送
                    const p = (message.payload as any) || {};
                    broadcastToClients({ type: 'canvas.prompt', payload: { text: String(p.text || '') } });
                    if (message.id) send(client, { type: 'canvas.prompt.result', id: message.id, payload: { ok: true } });
                    break;
                }
                case 'canvas.command.result': {
                    // 画布窗口对 design_canvas 命令的回包
                    const pend = message.id ? canvasPending.get(message.id) : undefined;
                    if (pend && message.id) {
                        clearTimeout(pend.timer);
                        canvasPending.delete(message.id);
                        const p = (message.payload as any) || {};
                        if (p.error) pend.reject(new Error(String(p.error)));
                        else pend.resolve(p);
                    }
                    break;
                }
                case 'canvas.status.query': {
                    send(client, { type: 'canvas.status', payload: { open: isCanvasOpen() } });
                    break;
                }
                case 'canvas.insert': {
                    // 前端把生成的图片送入画布（任意 Agent 产出的图片均可）
                    const p = (message.payload as any) || {};
                    if (!isCanvasOpen()) {
                        send(client, { type: 'canvas.insert.result', id: message.id, payload: { error: 'canvas_closed' } });
                        break;
                    }
                    try {
                        let dataUrl: string | undefined = p.dataUrl;
                        if (!dataUrl && p.path) {
                            const buf = readFileSync(p.path);
                            const ext = String(p.path).toLowerCase().split('.').pop() || 'png';
                            const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
                                : ext === 'gif' ? 'image/gif'
                                : ext === 'webp' ? 'image/webp'
                                : ext === 'svg' ? 'image/svg+xml'
                                : 'image/png';
                            dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
                        }
                        const res = await canvasCommand('insert_image', {
                            path: p.path || undefined,
                            url: p.url || undefined,
                            dataUrl,
                            caption: p.caption || undefined,
                        }, 30000);
                        send(client, { type: 'canvas.insert.result', id: message.id, payload: res || { inserted: true } });
                    } catch (e) {
                        send(client, { type: 'canvas.insert.result', id: message.id, payload: { error: e instanceof Error ? e.message : String(e) } });
                    }
                    break;
                }
                case 'canvas.save_asset': {
                    // 用户拖入画布的图片：落盘到工作区，返回本地路径，供设计师作为参考图读取
                    try {
                        const p = (message.payload as any) || {};
                        const dataUrl = String(p.dataUrl || '');
                        const m = /^data:(?<mime>[^;,]+)?(?:;base64)?,(?<body>.+)$/s.exec(dataUrl);
                        if (!m?.groups?.body) {
                            if (message.id) send(client, { type: 'canvas.save_asset.result', id: message.id, payload: { error: 'invalid_data_url' } });
                            break;
                        }
                        const mime = m.groups.mime || 'image/png';
                        const ext = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg'
                            : mime.includes('webp') ? 'webp'
                            : mime.includes('gif') ? 'gif'
                            : mime.includes('svg') ? 'svg'
                            : 'png';
                        const dir = join(workspace, 'canvas', 'assets');
                        mkdirSync(dir, { recursive: true });
                        const base = String(p.name || 'image').replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').replace(/\.[^.]+$/, '');
                        const file = join(dir, `${Date.now()}_${base || 'image'}.${ext}`);
                        writeFileSync(file, Buffer.from(m.groups.body, 'base64'));
                        if (message.id) send(client, { type: 'canvas.save_asset.result', id: message.id, payload: { path: file } });
                    } catch (e) {
                        if (message.id) send(client, { type: 'canvas.save_asset.result', id: message.id, payload: { error: e instanceof Error ? e.message : String(e) } });
                    }
                    break;
                }
                case 'canvas.persist': {
                    // 画布窗口把当前快照落盘到工作区文件
                    try {
                        const snapshot = (message.payload as any)?.snapshot;
                        if (snapshot) {
                            mkdirSync(join(workspace, 'canvas'), { recursive: true });
                            writeFileSync(canvasSnapshotPath, JSON.stringify({ snapshot, savedAt: Date.now() }), 'utf-8');
                        }
                        if (message.id) send(client, { type: 'canvas.persist.result', id: message.id, payload: { ok: true } });
                    } catch (e) {
                        if (message.id) send(client, { type: 'canvas.persist.result', id: message.id, payload: { error: e instanceof Error ? e.message : String(e) } });
                    }
                    break;
                }
                case 'canvas.load': {
                    // 画布窗口启动时从工作区文件读取快照
                    try {
                        if (existsSync(canvasSnapshotPath)) {
                            const raw = JSON.parse(readFileSync(canvasSnapshotPath, 'utf-8'));
                            send(client, { type: 'canvas.load.result', id: message.id, payload: { exists: true, snapshot: raw.snapshot } });
                        } else {
                            send(client, { type: 'canvas.load.result', id: message.id, payload: { exists: false } });
                        }
                    } catch (e) {
                        send(client, { type: 'canvas.load.result', id: message.id, payload: { exists: false, error: e instanceof Error ? e.message : String(e) } });
                    }
                    break;
                }
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
                // Distillation system messages
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
                // OpenFlux Cloud Messaging
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
                // OpenFluxRouter messages
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
                // WeChat iLink messaging (independent of Router)
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
                // Voice voice service messages
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
                // Start browser debugging mode
                case 'browser.launch':
                    await handleBrowserLaunch(client, message);
                    break;
                case 'browser.status': {
                    const status = getBrowserConnectionStatus();
                    // Only output info when the status changes to avoid heartbeat log storms
                    const statusKey = `${status.connected}-${(status as any).cdpUrl}-${(status as any).mode}`;
                    if (statusKey !== lastBrowserStatusKey) {
                        log.info('Browser status changed', status);
                        lastBrowserStatusKey = statusKey;
                    }
                    send(client, { type: 'browser.status', id: message.id, payload: status });
                    break;
                }
                // ========================
                // Evolution (self-evolution)
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
                    const { installedSkillMatches, toSkillRuntimeId } = await import('../evolution/data-manager');
                    const meta = evolutionData.listInstalledSkills().find(s => installedSkillMatches(s, slug));
                    const runtimeSkillId = meta?.runtimeSkillId || toSkillRuntimeId(meta?.storageSlug || meta?.remoteSlug || meta?.slug || slug);
                    const removed = evolutionData.removeInstalledSkill(slug);
                    if (removed) agentManagerRef?.removeSkill(runtimeSkillId);
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
                        // Also removed from the memory registry to ensure immediate unavailability
                        tools.unregister(`custom_${toolName2}`);
                    }
                    send(client, { type: 'evolution.tools.delete', id: message.id, payload: { success: removedTool } });
                    break;
                }
                // Forged Skills
                case 'evolution.forge.accept': {
                    const suggestion = message.payload as ForgeSuggestion;
                    if (suggestion?.id) {
                        const meta = skillForge.acceptSuggestion(suggestion);
                        // Inject into Agent skills
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
                    // User ignores suggestion, clear pendingSuggestion
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
                case 'evolution.forged.toggle': {
                    const { id: toggleId, enabled } = message.payload as { id: string; enabled: boolean };
                    const updated = evolutionData.updateForgedSkill(toggleId, { enabled });
                    if (updated) {
                        // Inject skills into or out of AgentManager based on switch status
                        if (enabled) {
                            const content = evolutionData.readForgedSkillContent(toggleId);
                            const meta = evolutionData.listForgedSkills().find(s => s.id === toggleId);
                            if (content && meta && agentManagerRef) {
                                agentManagerRef.addSkill({
                                    id: `forged:${toggleId}`,
                                    title: meta.title,
                                    content,
                                });
                                log.info(`Forged skill enabled & injected: "${meta.title}"`);
                            }
                        } else {
                            agentManagerRef?.removeSkill(`forged:${toggleId}`);
                            log.info(`Forged skill disabled & removed from agent: ${toggleId}`);
                        }
                    }
                    send(client, { type: 'evolution.forged.toggle', id: message.id, payload: { success: updated, enabled } });
                    break;
                }
                case 'tool.call': {
                    // The front end directly calls the Gateway tool (only for non-long-running tasks)
                    const { tool: toolName, args: toolArgs = {} } = message.payload as {
                        tool: string;
                        args?: Record<string, unknown>;
                    };
                    if (!tools.getTool(toolName)) {
                        send(client, {
                            type: 'tool.call',
                            id: message.id,
                            payload: { success: false, error: `Unknown tool: ${toolName}` },
                        });
                        break;
                    }
                    try {
                        // Direct UI calls must traverse the same permission and safety boundary
                        // as Agent-initiated calls. Without a session approval callback, gated
                        // medium/high-risk operations fail closed instead of bypassing policy.
                        const result = await tools.executeTool(toolName, toolArgs as any);
                        send(client, { type: 'tool.call', id: message.id, payload: result });
                    } catch (toolErr) {
                        send(client, {
                            type: 'tool.call',
                            id: message.id,
                            payload: { success: false, error: String(toolErr) },
                        });
                    }
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
     * Certification
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

    function queueRevision(sessionId: string, bump = false): number {
        const current = queueRevisionBySession.get(sessionId) || 0;
        const next = bump ? current + 1 : current;
        if (bump) queueRevisionBySession.set(sessionId, next);
        return next;
    }

    function publicQueueItem(item: TurnQueueItem<DurableChatPayload>) {
        const payload = item.payload;
        return {
            id: item.id,
            runId: item.id,
            turnId: payload.turnId,
            submissionId: item.submissionId,
            sessionId: item.sessionId,
            content: payload.input,
            attachments: payload.attachments || [],
            status: item.status,
            position: item.position,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
            error: item.error,
        };
    }

    function publicQueueSnapshot(sessionId: string) {
        const durable = turnQueueStore.snapshot<DurableChatPayload>(sessionId);
        const runtime = executionRegistry.snapshot(sessionId);
        const runtimeActiveId = runtime.active?.runId;
        const durableActive = durable.active
            || durable.queue.find(item => item.id === runtimeActiveId);
        return {
            sessionId,
            revision: queueRevision(sessionId),
            paused: durable.paused || runtime.paused,
            active: durableActive ? publicQueueItem({ ...durableActive, status: 'dispatching', position: 0 }) : undefined,
            items: durable.queue
                .filter(item => item.id !== runtimeActiveId && (item.status === 'queued' || item.status === 'paused'))
                .map(publicQueueItem),
            activeTurn: runtime.active ? {
                turnId: runtime.active.turnId,
                runId: runtime.active.runId,
                submissionId: runtime.active.submissionId,
                startedAt: runtime.active.startedAt,
                status: runtime.active.status,
            } : undefined,
        };
    }

    function broadcastQueueState(sessionId: string, bump = true): void {
        if (bump) queueRevision(sessionId, true);
        broadcastToClients({ type: 'chat.queue.updated', payload: publicQueueSnapshot(sessionId) });
    }

    function approvalClientIdentity(client: GatewayClient): ToolApprovalClientIdentity {
        return {
            id: client.id,
            instanceId: client.instanceId,
            role: client.role,
            authenticated: client.authenticated,
            open: client.ws.readyState === WebSocket.OPEN,
        };
    }

    function sendToClientInstance(client: GatewayClient, message: GatewayMessage): boolean {
        if (client.instanceId) {
            let delivered = false;
            for (const candidate of clients.values()) {
                if (
                    candidate.role === 'desktop'
                    && candidate.instanceId === client.instanceId
                    && candidate.authenticated
                ) {
                    delivered = send(candidate, message) || delivered;
                }
            }
            if (delivered) return true;
        }
        return send(client, message);
    }

    function sendApprovalRequest(
        identity: ToolApprovalClientIdentity,
        request: ToolApprovalRequest,
    ): boolean {
        const target = clients.get(identity.id);
        if (!target) return false;
        return send(target, {
            type: 'tool.approval.request',
            id: request.requestId,
            payload: request,
        });
    }

    function deliverToolApproval(requestId: string): number {
        return toolApprovalBroker.deliver(
            requestId,
            [...clients.values()].map(approvalClientIdentity),
            sendApprovalRequest,
        );
    }

    function notifyToolApprovalClosed(
        requestId: string,
        decision: ToolApprovalDecision,
        reason: 'resolved' | 'timeout' | 'aborted',
    ): void {
        toolApprovalBroker.notify(
            requestId,
            [...clients.values()].map(approvalClientIdentity),
            (identity, request) => {
                const target = clients.get(identity.id);
                if (!target) return false;
                return send(target, {
                    type: 'tool.approval.closed',
                    id: requestId,
                    payload: {
                        requestId,
                        decision,
                        reason,
                        sessionId: request.sessionId,
                        turnId: request.turnId,
                    },
                });
            },
        );
    }

    function handleClientRegister(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { role?: string; instanceId?: string } | undefined;
        const role = payload?.role;
        const instanceId = payload?.instanceId?.trim();
        if (role !== 'desktop' || !instanceId || !/^[A-Za-z0-9._:-]{1,128}$/.test(instanceId)) {
            send(client, {
                type: 'client.register.error',
                id: message.id,
                payload: { message: 'Invalid desktop client identity' },
            });
            return;
        }

        client.role = 'desktop';
        client.instanceId = instanceId;
        send(client, {
            type: 'client.register.result',
            id: message.id,
            payload: { ok: true },
        });
        const replayed = toolApprovalBroker.replayTo(
            approvalClientIdentity(client),
            sendApprovalRequest,
        );
        if (replayed > 0) {
            log.info('Replayed pending tool approvals to reconnected desktop', {
                clientId: client.id,
                instanceId,
                count: replayed,
            });
        }
    }

    function requestToolApproval(
        client: GatewayClient,
        tracker: TurnTracker,
        signal: AbortSignal,
        request: ToolApprovalRequest,
    ): Promise<ToolApprovalDecision> {
        if (signal.aborted) return Promise.resolve('denied');
        const visibleRequest = bindToolApprovalToVisibleTurn(request, tracker);
        tracker.approval({
            id: visibleRequest.requestId,
            title: `等待批准：${visibleRequest.toolName}`,
            detail: visibleRequest.reason,
            status: 'waiting',
        });

        return new Promise(resolve => {
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const finish = (
                decision: ToolApprovalDecision,
                reason: 'resolved' | 'timeout' | 'aborted' = 'resolved',
            ) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                signal.removeEventListener('abort', onAbort);
                const title = decision === 'approved'
                    ? `已批准：${visibleRequest.toolName}`
                    : reason === 'timeout'
                        ? `审批超时：${visibleRequest.toolName}`
                        : reason === 'aborted'
                            ? `审批已取消：${visibleRequest.toolName}`
                            : `已拒绝：${visibleRequest.toolName}`;
                tracker.approval({
                    id: visibleRequest.requestId,
                    title,
                    detail: visibleRequest.reason,
                    status: decision === 'approved' ? 'completed' : 'failed',
                });
                notifyToolApprovalClosed(visibleRequest.requestId, decision, reason);
                toolApprovalBroker.remove(visibleRequest.requestId);
                resolve(decision);
            };
            const onAbort = () => finish('denied', 'aborted');
            timer = setTimeout(() => finish('denied', 'timeout'), 120_000);

            toolApprovalBroker.add(
                approvalClientIdentity(client),
                visibleRequest,
                decision => finish(decision, 'resolved'),
            );
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) {
                finish('denied', 'aborted');
                return;
            }
            const delivered = deliverToolApproval(visibleRequest.requestId);
            if (delivered === 0) {
                log.info('Tool approval is waiting for its desktop client to reconnect', {
                    requestId: visibleRequest.requestId,
                    instanceId: client.instanceId,
                    toolName: visibleRequest.toolName,
                });
            }
        });
    }

    function handleToolApprovalResolve(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { requestId?: string; decision?: ToolApprovalDecision };
        const requestId = payload?.requestId || message.id;
        const resolved = requestId
            ? toolApprovalBroker.resolve(
                approvalClientIdentity(client),
                requestId,
                payload.decision === 'approved' ? 'approved' : 'denied',
            )
            : false;
        if (!resolved) {
            log.warn('Ignoring unknown or cross-client tool approval', { requestId, clientId: client.id });
        }
    }

    function buildPlanExecutionPrompt(markdown: string, planId: string, revision: number): string {
        return [
            '[System: approved immutable plan execution]',
            `Plan ID: ${planId}`,
            `Revision: ${revision}`,
            'Execute this exact approved revision in normal work mode. The plan approval does not bypass any existing tool approval policy.',
            'Report progress truthfully and complete the validation and acceptance criteria before claiming completion.',
            '',
            markdown,
        ].join('\n');
    }

    function buildPlanExecutionDisplayInput(revision: number): string {
        return planCopy(
            `开始执行计划（revision ${revision}）`,
            `Start executing plan (revision ${revision})`,
        );
    }

    function resolveAgentInput(payload: InteractiveChatPayload): string {
        return payload.planExecution && payload.internalInput
            ? payload.internalInput
            : payload.input;
    }

    function planUiIsZh(): boolean {
        return !config.language || config.language.toLowerCase().startsWith('zh');
    }

    function planCopy(zh: string, en: string): string {
        return planUiIsZh() ? zh : en;
    }

    function broadcastWorkState(sessionId: string): void {
        broadcastToClients({
            type: 'work.state.updated',
            payload: planStore.getSnapshot(sessionId),
        });
    }

    function recoverPlanExecutionForRetry(sessionId: string, payload: DurableChatPayload): void {
        if (!payload.planExecution || !payload.planId) return;
        try {
            if (planStore.recoverExecution(sessionId, payload.planId)) broadcastWorkState(sessionId);
        } catch (error) {
            log.warn('Failed to recover interrupted plan execution', {
                sessionId,
                planId: payload.planId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    function planResponseSummary(planId: string, requestId: string): string {
        const plan = planStore.getPlan(planId);
        const request = plan?.inputRequests.find(item => item.id === requestId);
        if (!request?.response) return planCopy('已提交计划选择', 'Plan choices submitted');
        const lines = request.questions.map(question => {
            const answer = request.response!.answers.find(item => item.questionId === question.id);
            const labels = (answer?.optionIds || [])
                .map(optionId => question.options.find(option => option.id === optionId)?.label)
                .filter((label): label is string => !!label);
            if (answer?.other) labels.push(answer.other);
            const separator = planUiIsZh() ? '、' : ', ';
            return `${question.prompt}${planUiIsZh() ? '：' : ': '}${labels.join(separator) || planCopy('未选择', 'Not selected')}`;
        });
        return `${planCopy('计划选择', 'Plan choices')}\n${lines.map(line => `- ${line}`).join('\n')}`;
    }

    function handleWorkStateGet(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { sessionId?: string };
        if (!payload?.sessionId) {
            send(client, { type: 'work.state.get.error', id: message.id, payload: { message: 'sessionId is required' } });
            return;
        }
        send(client, { type: 'work.state.get', id: message.id, payload: planStore.getSnapshot(payload.sessionId) });
    }

    function handleWorkModeSet(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { sessionId?: string; mode?: WorkMode };
        const session = payload?.sessionId ? sessions.get(payload.sessionId) : undefined;
        if (!payload?.sessionId || (payload.mode !== 'normal' && payload.mode !== 'plan')) {
            send(client, { type: 'work.mode.set.error', id: message.id, payload: { message: 'Invalid session or work mode' } });
            return;
        }
        if (!session || session.cloudChatroomId) {
            send(client, { type: 'work.mode.set.error', id: message.id, payload: { message: planCopy('计划模式首版仅支持本地 Agent。', 'Plan mode currently supports local Agents only.') } });
            return;
        }
        const snapshot = planStore.setMode(payload.sessionId, payload.mode);
        send(client, { type: 'work.mode.set', id: message.id, payload: snapshot });
        broadcastWorkState(payload.sessionId);
    }

    async function handlePlanInputResolve(client: GatewayClient, message: GatewayMessage): Promise<void> {
        const payload = message.payload as {
            sessionId?: string;
            planId?: string;
            requestId?: string;
            submissionId?: string;
            answers?: PlanQuestionAnswer[];
        };
        try {
            if (!payload?.sessionId || !payload.planId || !payload.requestId || !payload.submissionId) {
                throw new Error('Missing plan input identity.');
            }
            const result = planStore.resolveInput(
                payload.sessionId,
                payload.planId,
                payload.requestId,
                payload.submissionId,
                payload.answers || [],
            );
            const summary = planResponseSummary(payload.planId, payload.requestId);
            send(client, { type: 'plan.input.resolve', id: message.id, payload: { ...result, state: planStore.getSnapshot(payload.sessionId) } });
            broadcastWorkState(payload.sessionId);
            if (!result.duplicate) {
                await handleChat(client, {
                    type: 'chat',
                    id: crypto.randomUUID(),
                    payload: {
                        input: summary,
                        sessionId: payload.sessionId,
                        source: 'local',
                        mode: 'plan',
                        planId: payload.planId,
                        submissionId: `${payload.submissionId}:continue`,
                        delivery: 'new',
                    } satisfies InteractiveChatPayload,
                });
            }
        } catch (error) {
            send(client, { type: 'plan.input.resolve.error', id: message.id, payload: { message: error instanceof Error ? error.message : String(error) } });
        }
    }

    async function handlePlanRevise(client: GatewayClient, message: GatewayMessage): Promise<void> {
        const payload = message.payload as { sessionId?: string; planId?: string; instruction?: string; submissionId?: string };
        try {
            if (!payload?.sessionId || !payload.planId || !payload.submissionId) throw new Error('Missing plan revision identity.');
            const result = planStore.requestRevision(payload.sessionId, payload.planId, payload.instruction || '', payload.submissionId);
            send(client, { type: 'plan.revise', id: message.id, payload: { ...result, state: planStore.getSnapshot(payload.sessionId) } });
            broadcastWorkState(payload.sessionId);
            if (!result.duplicate) {
                await handleChat(client, {
                    type: 'chat',
                    id: crypto.randomUUID(),
                    payload: {
                        input: `${planCopy('修改计划：', 'Revise plan: ')}${payload.instruction!.trim()}`,
                        sessionId: payload.sessionId,
                        source: 'local',
                        mode: 'plan',
                        planId: payload.planId,
                        submissionId: `${payload.submissionId}:continue`,
                        delivery: 'new',
                    } satisfies InteractiveChatPayload,
                });
            }
        } catch (error) {
            send(client, { type: 'plan.revise.error', id: message.id, payload: { message: error instanceof Error ? error.message : String(error) } });
        }
    }

    async function handlePlanApprove(client: GatewayClient, message: GatewayMessage): Promise<void> {
        const payload = message.payload as { sessionId?: string; planId?: string; revision?: number; submissionId?: string };
        try {
            if (!payload?.sessionId || !payload.planId || !payload.submissionId || !Number.isInteger(payload.revision)) {
                throw new Error('Missing plan approval identity.');
            }
            const result = planStore.approve(payload.sessionId, payload.planId, payload.revision!, payload.submissionId);
            send(client, { type: 'plan.approve', id: message.id, payload: { ...result, state: planStore.getSnapshot(payload.sessionId) } });
            broadcastWorkState(payload.sessionId);
            if (!result.duplicate) {
                const displayInput = buildPlanExecutionDisplayInput(result.snapshot.revision);
                sessions.addMessage(payload.sessionId, {
                    role: 'user',
                    content: displayInput,
                    metadata: {
                        kind: 'plan_approval_summary',
                        planId: payload.planId,
                        revision: result.snapshot.revision,
                    },
                });
                const executionPayload: InteractiveChatPayload = {
                    input: displayInput,
                    internalInput: buildPlanExecutionPrompt(result.snapshot.markdown, payload.planId, result.snapshot.revision),
                    sessionId: payload.sessionId,
                    source: 'local',
                    mode: 'normal',
                    approvalMode: normalizeApprovalMode(
                        sessions.get(payload.sessionId)?.approvalMode,
                        DEFAULT_APPROVAL_MODE,
                    ),
                    planId: payload.planId,
                    planRevision: result.snapshot.revision,
                    planExecution: true,
                    submissionId: `${payload.submissionId}:execute`,
                    delivery: 'new',
                };
                trustedPlanExecutionPayloads.add(executionPayload);
                await handleChat(client, {
                    type: 'chat',
                    id: crypto.randomUUID(),
                    payload: executionPayload,
                });
            }
        } catch (error) {
            send(client, { type: 'plan.approve.error', id: message.id, payload: { message: error instanceof Error ? error.message : String(error) } });
        }
    }

    function handlePlanSave(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { sessionId?: string; planId?: string };
        try {
            if (!payload?.sessionId || !payload.planId) throw new Error('Missing plan identity.');
            planStore.save(payload.sessionId, payload.planId);
            send(client, { type: 'plan.save', id: message.id, payload: planStore.getSnapshot(payload.sessionId) });
            broadcastWorkState(payload.sessionId);
        } catch (error) {
            send(client, { type: 'plan.save.error', id: message.id, payload: { message: error instanceof Error ? error.message : String(error) } });
        }
    }

    function handlePlanCancel(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { sessionId?: string; planId?: string };
        try {
            if (!payload?.sessionId || !payload.planId) throw new Error('Missing plan identity.');
            planStore.cancel(payload.sessionId, payload.planId);
            send(client, { type: 'plan.cancel', id: message.id, payload: planStore.getSnapshot(payload.sessionId) });
            broadcastWorkState(payload.sessionId);
        } catch (error) {
            send(client, { type: 'plan.cancel.error', id: message.id, payload: { message: error instanceof Error ? error.message : String(error) } });
        }
    }

    function stricterApprovalMode(first: ApprovalMode, second: ApprovalMode): ApprovalMode {
        const rank: Record<ApprovalMode, number> = { ask: 0, risk_based: 1, full_access: 2 };
        return rank[first] <= rank[second] ? first : second;
    }

    async function executeQueuedChatTurn(
        pending: PendingInteractiveTurn,
        execution: ActiveExecution,
    ): Promise<AgentExecutionResult> {
        // enqueue() invokes the task synchronously up to the first await. Yield once
        // so the durable queue item and pending map are installed before publishing.
        await Promise.resolve();

        const { payload, client, queueItemId } = pending;
        const sessionId = payload.sessionId || payload.turnId;
        const executionWorkMode: ExecutionWorkMode = payload.planExecution
            ? 'plan_execution'
            : (payload.mode || 'normal');
        pending.execution = execution;
        turnQueueStore.setStatus(sessionId, queueItemId, 'dispatching');

        const tracker = new TurnTracker({
            sessionId,
            turnId: payload.turnId,
            traceId: execution.traceId,
            runId: execution.runId,
            persist: event => {
                if (payload.sessionId && sessions.get(payload.sessionId)) sessions.addEvent(payload.sessionId, event);
            },
            emit: event => sendToClientInstance(client, {
                type: 'agent.event',
                id: payload.turnId,
                payload: event,
            }),
        });
        pending.tracker = tracker;

        sendToClientInstance(client, {
            type: 'chat.start',
            id: payload.turnId,
            payload: {
                sessionId,
                turnId: payload.turnId,
                runId: execution.runId,
                queueItemId,
                submissionId: payload.submissionId,
                input: payload.input,
            },
        });
        tracker.start();
        if (payload.planExecution && payload.planId) {
            planStore.markExecuting(sessionId, payload.planId);
            broadcastWorkState(sessionId);
        }
        for (const guidance of pending.pendingGuidanceActivity || []) {
            tracker.guidance(guidance.content, guidance.id);
        }
        pending.pendingGuidanceActivity = [];
        for (const activity of pending.pendingGoalActivity || []) {
            tracker.goalUpdate(activity);
        }
        pending.pendingGoalActivity = [];
        broadcastQueueState(sessionId);

        if (!llm) throw new Error('The model service is not initialized. Complete model configuration first.');

        const submittedMode = normalizeApprovalMode(payload.approvalMode, DEFAULT_APPROVAL_MODE);
        const currentMode = normalizeApprovalMode(sessions.get(sessionId)?.approvalMode, DEFAULT_APPROVAL_MODE);
        // A queued turn may become more restrictive while waiting, never silently less restrictive.
        const turnApprovalMode = stricterApprovalMode(submittedMode, currentMode);

        const executeAgentOnce = async (agentRunOptions?: {
            llmOverride?: LLMProvider;
            retryCurrentUserMessage?: boolean;
        }): Promise<AgentExecutionResult> => executeAgent(
            resolveAgentInput(payload) || '',
            payload.sessionId,
            event => {
                if (!execution.isCurrent()) return;
                recordGoalProgress(pending, event);
                tracker.handleLegacyProgress(event);
                sendToClientInstance(client, {
                    type: 'chat.progress',
                    id: payload.turnId,
                    payload: {
                        ...event,
                        sessionId,
                        turnId: payload.turnId,
                        runId: execution.runId,
                        submissionId: payload.submissionId,
                    },
                });
            },
            payload.attachments,
            {
                turnId: payload.turnId,
                runId: execution.runId,
                queueItemId,
                submissionId: payload.submissionId,
                ...(payload.planExecution ? {
                    internal: true,
                    visibility: 'internal',
                    kind: 'plan_execution_snapshot',
                } : {}),
            },
            payload.agentId,
            execution.controller,
            {
                ...agentRunOptions,
                turnId: payload.turnId,
                requestApproval: request => requestToolApproval(client, tracker, execution.controller.signal, request),
                approvalMode: turnApprovalMode,
                execution,
                drainSteering: () => execution
                    .drainSteering<{ content: string }>()
                    .map(item => ({ id: item.steerId, content: item.payload.content })),
                drainGoalRevisions: () => execution
                    .drainGoalRevisions<GoalRevisionMessage>()
                    .map(item => item.payload),
                getIntentEpoch: execution.getIntentEpoch,
                onIntentInvalidated: execution.onIntentInvalidated,
                waitForGoalReconciliation: () => waitForLatestGoalReconciliation(pending),
                isRunActive: execution.isCurrent,
                workMode: executionWorkMode,
                planId: payload.planId,
                planRevision: payload.planRevision,
                planControl: executionWorkMode === 'plan' && payload.planId ? {
                    requestInput: async questions => {
                        const request = planStore.requestInput(sessionId, payload.planId!, questions);
                        broadcastWorkState(sessionId);
                        return { planId: payload.planId!, requestId: request.id };
                    },
                    publishDocument: async (document, note) => {
                        const revision = planStore.publishDocument(sessionId, payload.planId!, document, note);
                        broadcastWorkState(sessionId);
                        return { planId: payload.planId!, revision: revision.revision };
                    },
                } : undefined,
            },
        );

        try {
            return await executeAgentOnce();
        } catch (error) {
            let finalError = error;
            if (
                llmSource === 'atlas_managed'
                && error instanceof LLMError
                && error.atlasCode === 'no_available_model'
                && execution.isCurrent()
            ) {
                const refreshState = await refreshAtlasManagedRuntime({ allowCachedRuntimeOnFailure: false });
                if (refreshState.status === 'updated' && refreshState.runtime?.chat) {
                    try {
                        return await executeAgentOnce({ retryCurrentUserMessage: true });
                    } catch (retryError) {
                        finalError = retryError;
                    }
                } else if (refreshState.status === 'auth_expired') {
                    finalError = new Error(refreshState.message || 'NexusAI authentication expired');
                } else if (refreshState.status === 'unavailable') {
                    finalError = new Error(atlasManagedUnavailableReason || ATLAS_RUNTIME_UNAVAILABLE_MESSAGE);
                }
            }

            if (
                llmSource === 'atlas_managed'
                && finalError instanceof LLMError
                && finalError.atlasCode === 'policy_retry_required'
                && finalError.policyRetry?.retryable === true
                && execution.isCurrent()
            ) {
                const retryLlm = buildPolicyRetryLLM(finalError.policyRetry);
                if (retryLlm) {
                    return executeAgentOnce({ llmOverride: retryLlm, retryCurrentUserMessage: true });
                }
            }
            throw finalError;
        }
    }

    async function handleChat(client: GatewayClient, message: GatewayMessage): Promise<void> {
        const rawPayload = message.payload as InteractiveChatPayload;
        const messageId = message.id || crypto.randomUUID();
        const submissionId = rawPayload?.submissionId || messageId;

        if (rawPayload?.source === 'cloud' && rawPayload?.chatroomId) {
            // The cloud bridge has its own queue and currently has no safe steer protocol.
            if (rawPayload.delivery === 'steer') {
                send(client, {
                    type: 'chat.accepted',
                    id: messageId,
                    payload: { disposition: 'unsupported', reason: 'cloud_steer_unsupported' },
                });
                return;
            }
            await handleLegacyChat(client, message);
            return;
        }

        if (!rawPayload?.input && !rawPayload?.attachments?.length) {
            send(client, { type: 'chat.error', id: messageId, payload: { message: 'Missing input' } });
            return;
        }

        const sessionId = rawPayload.sessionId || messageId;
        const session = sessions.get(sessionId);
        if (rawPayload.mode === 'plan' && session?.cloudChatroomId) {
            send(client, { type: 'chat.error', id: messageId, payload: { message: planCopy('计划模式首版仅支持本地 Agent。', 'Plan mode currently supports local Agents only.') } });
            return;
        }
        if (rawPayload.planExecution) {
            if (!trustedPlanExecutionPayloads.has(rawPayload)) {
                send(client, { type: 'chat.error', id: messageId, payload: { message: planCopy('无效的内部计划执行请求。', 'Invalid internal plan execution request.') } });
                return;
            }
            trustedPlanExecutionPayloads.delete(rawPayload);
            const approvedPlan = rawPayload.planId ? planStore.getPlan(rawPayload.planId) : undefined;
            if (!approvedPlan?.execution || approvedPlan.sessionId !== sessionId) {
                send(client, { type: 'chat.error', id: messageId, payload: { message: planCopy('找不到已批准的计划执行快照。', 'The approved plan execution snapshot could not be found.') } });
                return;
            }
            rawPayload.mode = 'normal';
            rawPayload.planRevision = approvedPlan.execution.revision;
            rawPayload.input = buildPlanExecutionDisplayInput(approvedPlan.execution.revision);
            rawPayload.internalInput = buildPlanExecutionPrompt(
                approvedPlan.execution.markdown,
                approvedPlan.id,
                approvedPlan.execution.revision,
            );
        } else if (rawPayload.mode === 'plan') {
            try {
                const plan = planStore.ensurePlan(sessionId, rawPayload.planId);
                rawPayload.planId = plan.id;
                rawPayload.planRevision = plan.revision;
                planStore.setMode(sessionId, 'plan');
                broadcastWorkState(sessionId);
            } catch (error) {
                send(client, { type: 'chat.error', id: messageId, payload: { message: error instanceof Error ? error.message : String(error) } });
                return;
            }
        }
        let delivery: ChatDelivery = rawPayload.delivery || 'new';

        if (delivery === 'steer' && !rawPayload.attachments?.length) {
            const active = executionRegistry.get(sessionId);
            const target = {
                runId: rawPayload.targetRunId || active?.runId || '',
                turnId: rawPayload.targetTurnId || active?.turnId,
            };
            const steer = target.runId
                ? executionRegistry.pushSteering(sessionId, target, { id: submissionId, content: rawPayload.input || '' })
                : undefined;
            if (steer) {
                if (rawPayload.sessionId && sessions.get(rawPayload.sessionId)) {
                    sessions.addMessage(rawPayload.sessionId, {
                        role: 'user',
                        content: rawPayload.input || '',
                        attachments: rawPayload.attachments,
                        metadata: {
                            kind: 'steer',
                            steerId: steer.steerId,
                            turnId: target.turnId,
                            runId: target.runId,
                        },
                    });
                }
                publishGuidanceActivity(target.runId, rawPayload.input || '', steer.steerId);
                startGoalReconciliation(sessionId, target, {
                    id: steer.steerId,
                    content: rawPayload.input || '',
                });
                send(client, {
                    type: 'chat.accepted',
                    id: messageId,
                    payload: {
                        disposition: 'steer_pending',
                        sessionId,
                        submissionId,
                        targetTurnId: target.turnId,
                        targetRunId: target.runId,
                        steerId: steer.steerId,
                    },
                });
                broadcastToClients({
                    type: 'chat.steer.accepted',
                    payload: {
                        sessionId,
                        targetTurnId: target.turnId,
                        targetRunId: target.runId,
                        steerId: steer.steerId,
                        content: rawPayload.input || '',
                    },
                });
                return;
            }
            if (rawPayload.fallback !== 'queue') {
                send(client, {
                    type: 'chat.accepted',
                    id: messageId,
                    payload: { disposition: 'stale_target', sessionId },
                });
                return;
            }
            delivery = 'queue';
        } else if (delivery === 'steer') {
            // The first release keeps steer text-only; attachment follow-ups remain durable via Queue.
            delivery = 'queue';
        }

        const existing = turnQueueStore.getBySubmissionId<DurableChatPayload>(sessionId, submissionId);
        if (existing) {
            send(client, {
                type: 'chat.accepted',
                id: messageId,
                    payload: {
                        disposition: existing.status === 'dispatching' ? 'started' : 'queued',
                        sessionId,
                        submissionId,
                        turnId: existing.payload.turnId,
                    runId: existing.id,
                    queueItem: publicQueueItem(existing),
                    revision: queueRevision(sessionId),
                },
            });
            return;
        }

        const durablePayload: DurableChatPayload = {
            ...rawPayload,
            sessionId,
            delivery,
            turnId: messageId,
            submissionId,
            originClientInstanceId: client.instanceId,
        };

        let pending!: PendingInteractiveTurn;
        const wasPaused = executionRegistry.snapshot(sessionId).paused || turnQueueStore.snapshot(sessionId).paused;
        if (wasPaused) executionRegistry.pauseQueue(sessionId);
        const handle = executionRegistry.enqueue<AgentExecutionResult>({
            key: sessionId,
            sessionId,
            turnId: messageId,
            traceId: messageId,
            submissionId,
        }, execution => executeQueuedChatTurn(pending, execution));

        let stored: TurnQueueItem<DurableChatPayload>;
        try {
            stored = turnQueueStore.enqueue({
                id: handle.runId,
                sessionId,
                submissionId,
                payload: durablePayload,
            }).item;
        } catch (error) {
            handle.cancel(error);
            throw error;
        }

        pending = {
            payload: durablePayload,
            queueItemId: stored.id,
            client,
            handle,
            goalState: createInitialGoalState(resolveAgentInput(durablePayload) || '', submissionId),
        };
        pendingInteractiveTurns.set(handle.runId, pending);

        // A fresh user message after Stop becomes the next turn and resumes the queue.
        if (delivery === 'new' && wasPaused) {
            executionRegistry.moveQueued(sessionId, { runId: handle.runId, turnId: messageId }, 1);
            turnQueueStore.move(sessionId, stored.id, 1);
            turnQueueStore.resume(sessionId);
            executionRegistry.resumeQueue(sessionId);
        }

        send(client, {
            type: 'chat.accepted',
            id: messageId,
            payload: {
                disposition: handle.position === 0 ? 'started' : 'queued',
                sessionId,
                submissionId,
                turnId: messageId,
                runId: handle.runId,
                queueItem: publicQueueItem(turnQueueStore.get<DurableChatPayload>(stored.id)!),
                revision: queueRevision(sessionId),
            },
        });
        broadcastQueueState(sessionId);

        void handle.result.then(result => {
            if (result.status === 'completed') pending.tracker?.complete(planCopy('执行完成', 'Execution completed'));
            else if (result.status === 'waiting_input') pending.tracker?.complete(planCopy('等待计划选择', 'Waiting for plan choices'));
            else if (result.status === 'awaiting_plan_approval') pending.tracker?.complete(planCopy('等待计划批准', 'Waiting for plan approval'));
            else pending.tracker?.fail('任务未完成：交付质量门禁未通过');
            turnQueueStore.complete(sessionId, stored.id);
            if (durablePayload.planExecution && durablePayload.planId) {
                if (result.status === 'completed') {
                    planStore.markCompleted(sessionId, durablePayload.planId);
                    broadcastWorkState(sessionId);
                } else {
                    recoverPlanExecutionForRetry(sessionId, durablePayload);
                }
            }
            sendToClientInstance(client, {
                type: 'chat.complete',
                id: messageId,
                payload: {
                    output: result.output,
                    sessionId,
                    turnId: messageId,
                    runId: handle.runId,
                    submissionId,
                    status: result.status,
                },
            });
            broadcastSessionUpdate(sessionId);

            if (result.status !== 'completed' && result.status !== 'failed') return;
            const sessionMessages = sessions.getMessages(sessionId);
            const msgCount = sessionMessages?.length ?? 0;
            const lastCheckpoint = forgeCheckpointMap.get(sessionId) ?? 0;
            if (msgCount > 0 && msgCount - lastCheckpoint >= FORGE_WINDOW_SIZE) {
                forgeCheckpointMap.set(sessionId, msgCount);
                const windowMessages = sessionMessages.slice(-FORGE_WINDOW_SIZE);
                const toolCallNames = (sessions.getLogs(sessionId) || [])
                    .filter((item: any) => item.tool && item.tool !== '_thinking')
                    .map((item: any) => ({ name: item.tool, result: item.args }));
                skillForge.analyzeConversation(
                    windowMessages as any,
                    { output: result.output, status: result.status, iterations: 1, toolCalls: toolCallNames },
                    sessionId,
                ).catch(error => log.debug('Skill forge analysis error (non-blocking)', { error: String(error) }));
            }
        }).catch(error => {
            const interrupted = error instanceof ExecutionAbortedError
                || pending.execution?.controller.signal.aborted === true
                || (error instanceof Error && error.name === 'AbortError');
            recoverPlanExecutionForRetry(sessionId, durablePayload);
            if (error instanceof QueuedExecutionCanceledError && !pending.tracker) {
                turnQueueStore.cancel(sessionId, stored.id, error);
                return;
            }
            if (interrupted) {
                pending.tracker?.interrupt();
                turnQueueStore.cancel(sessionId, stored.id, error);
                sendToClientInstance(client, {
                    type: 'chat.interrupted',
                    id: messageId,
                    payload: {
                        sessionId,
                        turnId: messageId,
                        runId: handle.runId,
                        submissionId,
                        status: 'interrupted',
                    },
                });
            } else {
                const errorMessage = error instanceof Error ? error.message : String(error);
                pending.tracker?.fail(errorMessage);
                turnQueueStore.fail(sessionId, stored.id, error);
                sendToClientInstance(client, {
                    type: 'chat.error',
                    id: messageId,
                    payload: {
                        message: errorMessage,
                        sessionId,
                        turnId: messageId,
                        runId: handle.runId,
                        submissionId,
                    },
                });
            }
        }).finally(() => {
            pending.goalReconcileController?.abort(new Error('Turn finished'));
            pendingInteractiveTurns.delete(handle.runId);
            broadcastQueueState(sessionId);
        });
    }

    /** Legacy cloud chat path. Local chat is coordinated by handleChat above. */
    async function handleLegacyChat(client: GatewayClient, message: GatewayMessage): Promise<void> {
        const payload = message.payload as {
            input: string;
            sessionId?: string;
            agentId?: string;
            attachments?: Array<{ path: string; name: string; size: number; ext: string }>;
            source?: 'local' | 'cloud';
            chatroomId?: number;
            approvalMode?: ApprovalMode;
        };
        const messageId = message.id || crypto.randomUUID();

        // Cloud Agent Chat: Using the OpenFlux Bridge
        if (payload?.source === 'cloud' && payload?.chatroomId) {
            await handleCloudChat(client, message, payload, messageId);
            return;
        }

        if (!payload?.input && !payload?.attachments?.length) {
            send(client, { type: 'error', payload: { message: '缺少 input' } });
            return;
        }

        send(client, { type: 'chat.start', id: messageId });

        if (llmSource === 'atlas_managed') {
            if (!openfluxBridge.getToken()) {
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

            if (!llm) {
                const unavailableMessage = atlasManagedUnavailableReason || '当前 NexusAI 托管模式暂不可用，请稍后重试。';
                log.warn('Atlas managed chat unavailable', { reason: unavailableMessage });
                send(client, {
                    type: 'chat.error',
                    id: messageId,
                    payload: { message: unavailableMessage },
                });
                return;
            }
        }

        // ── Print current working mode ──
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

        const runtimeSessionId = payload.sessionId || messageId;
        const persistedApprovalMode = normalizeApprovalMode(
            payload.sessionId ? sessions.get(payload.sessionId)?.approvalMode : undefined,
            DEFAULT_APPROVAL_MODE,
        );
        // Freeze the policy for the whole turn. Retried LLM calls and child agents
        // must keep this snapshot even if the user changes the session preference.
        const turnApprovalMode = normalizeApprovalMode(payload.approvalMode, persistedApprovalMode);
        const tracker = new TurnTracker({
            sessionId: runtimeSessionId,
            turnId: messageId,
            traceId: messageId,
            persist: event => {
                if (payload.sessionId && sessions.get(payload.sessionId)) {
                    sessions.addEvent(payload.sessionId, event);
                }
            },
            emit: event => sendToClientInstance(client, { type: 'agent.event', id: messageId, payload: event }),
        });
        tracker.start();

        // Create AbortController for users to actively stop tasks
        const abortController = new AbortController();

        const executeAgentOnce = async (agentRunOptions?: {
            llmOverride?: LLMProvider;
            retryCurrentUserMessage?: boolean;
        }): Promise<AgentExecutionResult> => {
            return executeAgent(
                payload.input || '',
                payload.sessionId,
                (event) => {
                    tracker.handleLegacyProgress(event);
                    sendToClientInstance(client, {
                        type: 'chat.progress',
                        id: messageId,
                        payload: { ...event, sessionId: payload.sessionId },
                    });
                },
                payload.attachments,
                undefined,
                payload.agentId,
                abortController,
                {
                    ...agentRunOptions,
                    turnId: messageId,
                    requestApproval: request => requestToolApproval(client, tracker, abortController.signal, request),
                    approvalMode: turnApprovalMode,
                },
            );
        };

        const finalizeChatSuccess = async (result: AgentExecutionResult): Promise<void> => {
            if (result.status === 'completed') tracker.complete(planCopy('执行完成', 'Execution completed'));
            else tracker.fail('任务未完成：交付质量门禁未通过');
            sendToClientInstance(client, {
                type: 'chat.complete',
                id: messageId,
                payload: { output: result.output, sessionId: payload.sessionId, status: result.status },
            });

            // L2 Skill Forge: Sliding window trigger (checks every 20 new messages)
            if (payload.sessionId) {
                const sessionMessages = sessions.getMessages(payload.sessionId);
                const msgCount = sessionMessages?.length ?? 0;
                if (msgCount > 0) {
                    const lastCheckpoint = forgeCheckpointMap.get(payload.sessionId) ?? 0;
                    if (msgCount - lastCheckpoint >= FORGE_WINDOW_SIZE) {
                        forgeCheckpointMap.set(payload.sessionId, msgCount);
                        // Only take the last 20 messages as the analysis window
                        const windowMessages = sessionMessages!.slice(-FORGE_WINDOW_SIZE);
                        const sessionLogs = sessions.getLogs(payload.sessionId);
                        const toolCallNames = (sessionLogs || [])
                            .filter((l: any) => l.tool && l.tool !== '_thinking')
                            .map((l: any) => ({ name: l.tool, result: l.args }));
                        skillForge.analyzeConversation(
                            windowMessages as any,
                            { output: result.output, status: result.status, iterations: 1, toolCalls: toolCallNames },
                            payload.sessionId,
                        ).catch(err => log.debug('Skill forge analysis error (non-blocking)', { error: String(err) }));
                    }
                }
            }
        };

        try {
            const result = await executeAgentOnce();
            await finalizeChatSuccess(result);
        } catch (error) {
            let finalError = error;

            if (
                llmSource === 'atlas_managed' &&
                error instanceof LLMError &&
                error.atlasCode === 'no_available_model'
            ) {
                if (error.atlasDetail?.includes('protocol_mismatch_after_policy')) {
                    log.info('Atlas no_available_model caused by policy protocol mismatch, refreshing runtime from user_info');
                }
                const refreshState = await refreshAtlasManagedRuntime({
                    allowCachedRuntimeOnFailure: false,
                    logLabel: 'Hot refresh after no_available_model',
                });

                if (refreshState.status === 'updated' && refreshState.runtime?.chat) {
                    log.info('Atlas runtime updated after no_available_model, retrying chat once', {
                        protocol: refreshState.runtime.chat.protocol,
                        model: refreshState.runtime.chat.model_name,
                    });
                    try {
                        const result = await executeAgentOnce({ retryCurrentUserMessage: true });
                        await finalizeChatSuccess(result);
                        return;
                    } catch (retryError) {
                        finalError = retryError;
                    }
                } else if (refreshState.status === 'unavailable') {
                    finalError = new Error(atlasManagedUnavailableReason || ATLAS_RUNTIME_UNAVAILABLE_MESSAGE);
                } else if (refreshState.status === 'auth_expired') {
                    tracker.fail(refreshState.message || 'NexusAI access token 已失效，请重新登录');
                    sendToClientInstance(client, {
                        type: 'nexusai.auth-expired',
                        id: messageId,
                        payload: { message: refreshState.message || 'NexusAI access token 已失效，请重新登录' },
                    });
                    sendToClientInstance(client, {
                        type: 'chat.error',
                        id: messageId,
                        payload: { message: refreshState.message || 'NexusAI access token 已失效，请重新登录' },
                    });
                    return;
                }
            }

            if (
                llmSource === 'atlas_managed' &&
                finalError instanceof LLMError &&
                finalError.atlasCode === 'policy_retry_required' &&
                finalError.policyRetry?.retryable === true
            ) {
                const policyRetry = finalError.policyRetry;
                const retryLlm = buildPolicyRetryLLM(policyRetry);
                if (retryLlm) {
                    log.info('Atlas policy retry requested, retrying chat once with target runtime', {
                        stage: policyRetry.stage,
                        targetProtocol: policyRetry.target_protocol,
                        targetModelId: policyRetry.target_model_id,
                        targetModelName: policyRetry.target_model_name,
                        sourceRequestId: policyRetry.source_request_id,
                    });
                    try {
                        const result = await executeAgentOnce({
                            llmOverride: retryLlm,
                            retryCurrentUserMessage: true,
                        });
                        await finalizeChatSuccess(result);
                        return;
                    } catch (retryError) {
                        finalError = retryError;
                    }
                } else {
                    log.warn('Atlas policy retry requested but retry metadata was unusable', {
                        policyRetry,
                    });
                }
            }

            const errorMsg = finalError instanceof Error ? finalError.message : String(finalError);
            const errorStack = finalError instanceof Error ? finalError.stack : undefined;
            log.error('Chat execution failed', { message: errorMsg, stack: errorStack });
            if (abortController.signal.aborted) tracker.interrupt();
            else tracker.fail(errorMsg);

            const shouldPromptAtlasReauth =
                llmSource === 'atlas_managed' &&
                finalError instanceof LLMError &&
                finalError.recoveryAction === 'reauth';

            if (shouldPromptAtlasReauth) {
                openfluxBridge.invalidateAuth();
                llm = null;
                clearAtlasManagedUnavailable();
                sendToClientInstance(client, {
                    type: 'nexusai.auth-expired',
                    id: messageId,
                    payload: { message: finalError.message || 'NexusAI access token 已过期，请重新登录' },
                });
            }

            sendToClientInstance(client, {
                type: 'chat.error',
                id: messageId,
                payload: { message: errorMsg },
            });
        }
    }

    /**
     * Stop an ongoing task
     */
    function handleChatStop(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as {
            sessionId?: string;
            turnId?: string;
            runId?: string;
            submissionId?: string;
        };
        const sessionId = payload?.sessionId;
        const active = sessionId ? executionRegistry.get(sessionId) : undefined;
        const hasExactIdentity = Boolean(payload?.turnId || payload?.runId || payload?.submissionId);
        const identityMatches = Boolean(active && hasExactIdentity
            && (!payload.turnId || payload.turnId === active.turnId)
            && (!payload.runId || payload.runId === active.runId)
            && (!payload.submissionId || payload.submissionId === active.submissionId));
        const target = identityMatches && active ? {
            runId: active.runId,
            turnId: active.turnId,
        } : undefined;
        const matched = Boolean(sessionId && target && executionRegistry.abortIfCurrent(
            sessionId,
            target,
            new Error('Stopped by user'),
            { pauseQueue: true },
        ));

        if (matched && sessionId) {
            turnQueueStore.pause(sessionId);
            log.info('Stopped exact active turn and paused its follow-up queue', {
                sessionId,
                turnId: target?.turnId,
                runId: target?.runId,
            });
            broadcastQueueState(sessionId);
        } else {
            log.info('Ignoring stale or unmatched chat.stop', {
                sessionId,
                turnId: payload?.turnId,
                runId: payload?.runId,
                submissionId: payload?.submissionId,
            });
        }

        send(client, {
            type: 'chat.stop.ack',
            id: message.id,
            payload: {
                matched,
                sessionId,
                turnId: target?.turnId,
                runId: target?.runId,
                submissionId: active?.submissionId,
                queuePaused: matched,
            },
        });
    }

    function observeRecoveredPendingTurn(
        pending: PendingInteractiveTurn,
        stored: TurnQueueItem<DurableChatPayload>,
    ): void {
        const { handle, payload, client } = pending;
        if (!handle) return;
        const sessionId = stored.sessionId;
        void handle.result.then(result => {
            if (result.status === 'completed') pending.tracker?.complete(planCopy('执行完成', 'Execution completed'));
            else pending.tracker?.fail('任务未完成：交付质量门禁未通过');
            turnQueueStore.complete(sessionId, stored.id);
            sendToClientInstance(client, {
                type: 'chat.complete',
                id: payload.turnId,
                payload: {
                    output: result.output,
                    sessionId,
                    turnId: payload.turnId,
                    runId: handle.runId,
                    submissionId: payload.submissionId,
                    status: result.status,
                },
            });
            broadcastSessionUpdate(sessionId);
        }).catch(error => {
            const interrupted = error instanceof ExecutionAbortedError
                || pending.execution?.controller.signal.aborted === true
                || (error instanceof Error && error.name === 'AbortError');
            if (error instanceof QueuedExecutionCanceledError && !pending.tracker) {
                turnQueueStore.cancel(sessionId, stored.id, error);
                return;
            }
            if (interrupted) {
                pending.tracker?.interrupt();
                turnQueueStore.cancel(sessionId, stored.id, error);
                sendToClientInstance(client, {
                    type: 'chat.interrupted',
                    id: payload.turnId,
                    payload: {
                        sessionId,
                        turnId: payload.turnId,
                        runId: handle.runId,
                        submissionId: payload.submissionId,
                        status: 'interrupted',
                    },
                });
                return;
            }
            const errorMessage = error instanceof Error ? error.message : String(error);
            pending.tracker?.fail(errorMessage);
            turnQueueStore.fail(sessionId, stored.id, error);
            sendToClientInstance(client, {
                type: 'chat.error',
                id: payload.turnId,
                payload: {
                    message: errorMessage,
                    sessionId,
                    turnId: payload.turnId,
                    runId: handle.runId,
                    submissionId: payload.submissionId,
                },
            });
        }).finally(() => {
            pending.goalReconcileController?.abort(new Error('Turn finished'));
            pendingInteractiveTurns.delete(handle.runId);
            broadcastQueueState(sessionId);
        });
    }

    /** Restore durable queued work into the in-memory coordinator after a Gateway restart. */
    function hydratePersistedQueue(sessionId: string, client: GatewayClient): void {
        const durable = turnQueueStore.snapshot<DurableChatPayload>(sessionId);
        if (durable.paused) executionRegistry.pauseQueue(sessionId);
        const runtimeIds = new Set([
            executionRegistry.snapshot(sessionId).active?.runId,
            ...executionRegistry.snapshot(sessionId).queue.map(item => item.runId),
        ].filter((id): id is string => Boolean(id)));

        for (const stored of durable.queue) {
            if (runtimeIds.has(stored.id) || pendingInteractiveTurns.has(stored.id)) continue;
            let pending!: PendingInteractiveTurn;
            try {
                const handle = executionRegistry.enqueue<AgentExecutionResult>({
                    key: sessionId,
                    sessionId,
                    turnId: stored.payload.turnId,
                    traceId: stored.payload.turnId,
                    submissionId: stored.submissionId,
                    runId: stored.id,
                }, execution => executeQueuedChatTurn(pending, execution));
                pending = {
                    payload: stored.payload,
                    queueItemId: stored.id,
                    client,
                    handle,
                    goalState: createInitialGoalState(stored.payload.input || '', stored.submissionId),
                };
                pendingInteractiveTurns.set(stored.id, pending);
                runtimeIds.add(stored.id);
                observeRecoveredPendingTurn(pending, stored);
            } catch (error) {
                log.warn('Unable to hydrate durable turn queue item', {
                    sessionId,
                    runId: stored.id,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }

    function queueItemId(payload: { id?: string; runId?: string; queueItemId?: string }): string | undefined {
        return payload.id || payload.runId || payload.queueItemId;
    }

    function handleChatRuntimeGet(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { sessionId?: string };
        const sessionId = payload?.sessionId;
        if (!sessionId) {
            send(client, { type: 'chat.runtime', id: message.id, payload: { error: 'sessionId is required' } });
            return;
        }
        hydratePersistedQueue(sessionId, client);
        const snapshot = publicQueueSnapshot(sessionId);
        send(client, {
            type: 'chat.runtime',
            id: message.id,
            payload: {
                ...snapshot,
                activeTurn: snapshot.activeTurn || null,
                queue: {
                    items: snapshot.items,
                    paused: snapshot.paused,
                    revision: snapshot.revision,
                },
            },
        });
    }

    function handleChatQueueUpdate(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as {
            sessionId?: string;
            id?: string;
            runId?: string;
            queueItemId?: string;
            content?: string;
            input?: string;
            attachments?: DurableChatPayload['attachments'];
        };
        const sessionId = payload?.sessionId;
        const id = queueItemId(payload || {});
        const current = sessionId && id ? turnQueueStore.get<DurableChatPayload>(id) : undefined;
        const updatedPayload = current ? {
            ...current.payload,
            input: payload.input ?? payload.content ?? current.payload.input,
            attachments: payload.attachments ?? current.payload.attachments,
        } : undefined;
        const updated = sessionId && id && updatedPayload
            ? turnQueueStore.updatePayload(sessionId, id, updatedPayload)
            : undefined;
        const pending = id ? pendingInteractiveTurns.get(id) : undefined;
        if (pending && updated) pending.payload = updated.payload;
        if (updated && sessionId) broadcastQueueState(sessionId);
        send(client, {
            type: 'chat.queue.update.result',
            id: message.id,
            payload: { ok: Boolean(updated), sessionId, item: updated ? publicQueueItem(updated) : undefined },
        });
    }

    function handleChatQueueReorder(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { sessionId?: string; ids?: string[]; orderedIds?: string[]; runIds?: string[] };
        const sessionId = payload?.sessionId;
        const ids = payload?.orderedIds || payload?.ids || payload?.runIds || [];
        if (sessionId) hydratePersistedQueue(sessionId, client);
        const durableChanged = Boolean(sessionId && turnQueueStore.reorder(sessionId, ids));
        const runtimeChanged = Boolean(sessionId && executionRegistry.reorderQueued(sessionId, ids));
        if (sessionId && (durableChanged || runtimeChanged)) broadcastQueueState(sessionId);
        send(client, {
            type: 'chat.queue.reorder.result',
            id: message.id,
            payload: { ok: durableChanged && runtimeChanged, sessionId },
        });
    }

    function handleChatQueueDelete(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { sessionId?: string; id?: string; runId?: string; queueItemId?: string };
        const sessionId = payload?.sessionId;
        const id = queueItemId(payload || {});
        const item = id ? turnQueueStore.get<DurableChatPayload>(id) : undefined;
        const pending = id ? pendingInteractiveTurns.get(id) : undefined;
        const runtimeChanged = pending?.handle?.cancel(new Error('Removed from follow-up queue'))
            ?? Boolean(sessionId && id && executionRegistry.cancelQueued(
                sessionId,
                { runId: id, turnId: item?.payload.turnId },
                new Error('Removed from follow-up queue'),
            ));
        const durableChanged = Boolean(sessionId && id && turnQueueStore.cancel(
            sessionId,
            id,
            new Error('Removed from follow-up queue'),
        ));
        if (sessionId && (runtimeChanged || durableChanged)) broadcastQueueState(sessionId);
        send(client, {
            type: 'chat.queue.delete.result',
            id: message.id,
            payload: { ok: runtimeChanged || durableChanged, sessionId, runId: id },
        });
    }

    function handleChatQueueSendNow(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { sessionId?: string; id?: string; runId?: string; queueItemId?: string };
        const sessionId = payload?.sessionId;
        const id = queueItemId(payload || {});
        if (!sessionId || !id) {
            send(client, {
                type: 'chat.queue.send-now.result',
                id: message.id,
                payload: { ok: false, error: 'sessionId and queue item id are required' },
            });
            return;
        }
        hydratePersistedQueue(sessionId, client);
        const item = turnQueueStore.get<DurableChatPayload>(id);
        const active = executionRegistry.get(sessionId);
        let disposition: 'steer_pending' | 'started' | 'queued_first' | 'missing' = 'missing';
        let ok = false;

        if (item && active && !item.payload.attachments?.length) {
            const steer = executionRegistry.pushSteering(
                sessionId,
                { runId: active.runId, turnId: active.turnId },
                { id: item.submissionId, content: item.payload.input || '' },
            );
            if (steer) {
                if (sessions.get(sessionId)) {
                    sessions.addMessage(sessionId, {
                        role: 'user',
                        content: item.payload.input || '',
                        metadata: {
                            kind: 'steer',
                            steerId: steer.steerId,
                            turnId: active.turnId,
                            runId: active.runId,
                        },
                    });
                }
                publishGuidanceActivity(active.runId, item.payload.input || '', steer.steerId);
                startGoalReconciliation(
                    sessionId,
                    { runId: active.runId, turnId: active.turnId },
                    { id: steer.steerId, content: item.payload.input || '' },
                );
                pendingInteractiveTurns.get(id)?.handle?.cancel(new Error('Moved into the active turn as guidance'));
                turnQueueStore.cancel(sessionId, id, new Error('Moved into the active turn as guidance'));
                disposition = 'steer_pending';
                ok = true;
            }
        } else if (item) {
            const movedRuntime = executionRegistry.moveQueued(
                sessionId,
                { runId: id, turnId: item.payload.turnId },
                1,
            );
            const movedDurable = turnQueueStore.move(sessionId, id, 1);
            turnQueueStore.resume(sessionId);
            executionRegistry.resumeQueue(sessionId);
            disposition = active ? 'queued_first' : 'started';
            ok = movedRuntime || movedDurable;
        }

        if (ok) broadcastQueueState(sessionId);
        send(client, {
            type: 'chat.queue.send-now.result',
            id: message.id,
            payload: { ok, disposition, sessionId, runId: id },
        });
    }

    function handleChatQueuePause(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { sessionId?: string };
        const sessionId = payload?.sessionId;
        const durableChanged = Boolean(sessionId && turnQueueStore.pause(sessionId));
        const runtimeChanged = Boolean(sessionId && executionRegistry.pauseQueue(sessionId));
        if (sessionId && (durableChanged || runtimeChanged)) broadcastQueueState(sessionId);
        send(client, {
            type: 'chat.queue.pause.result',
            id: message.id,
            payload: { ok: Boolean(sessionId), sessionId, paused: Boolean(sessionId) },
        });
    }

    function handleChatQueueResume(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { sessionId?: string };
        const sessionId = payload?.sessionId;
        if (sessionId) hydratePersistedQueue(sessionId, client);
        const durableChanged = Boolean(sessionId && turnQueueStore.resume(sessionId));
        const runtimeChanged = Boolean(sessionId && executionRegistry.resumeQueue(sessionId));
        if (sessionId && (durableChanged || runtimeChanged)) broadcastQueueState(sessionId);
        send(client, {
            type: 'chat.queue.resume.result',
            id: message.id,
            payload: { ok: Boolean(sessionId), sessionId, paused: false },
        });
    }

    function handleChatQueueClear(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { sessionId?: string };
        const sessionId = payload?.sessionId;
        const runtimeCount = sessionId
            ? executionRegistry.clearQueued(sessionId, new Error('Follow-up queue cleared'))
            : 0;
        const durableCount = sessionId
            ? turnQueueStore.clear(sessionId, new Error('Follow-up queue cleared'))
            : 0;
        if (sessionId && (runtimeCount || durableCount)) broadcastQueueState(sessionId);
        send(client, {
            type: 'chat.queue.clear.result',
            id: message.id,
            payload: { ok: Boolean(sessionId), sessionId, cleared: Math.max(runtimeCount, durableCount) },
        });
    }

    /**
     * Conversation list
     */
    function handleSessionsList(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { agentId?: string } | undefined;
        // 带 agentId 时返回该 Agent 名下的会话（多会话）；不带则返回全部（兼容旧调用）
        const rawList = payload?.agentId ? listAgentSessions(payload.agentId) : sessions.list();
        const sessionList = rawList.map(session => {
            if (!session.cloudChatroomId || !session.lastMessagePreview) return session;
            return {
                ...session,
                lastMessagePreview: cleanOpenFluxCloudText(session.lastMessagePreview),
            };
        });
        send(client, { type: 'sessions.list', id: message.id, payload: { sessions: sessionList } });
    }

    function cleanCloudSessionMessages(sessionId: string, messages: unknown[]): unknown[] {
        const meta = sessions.get(sessionId);
        if (!meta?.cloudChatroomId) return messages;

        return messages.map((message) => {
            if (!message || typeof message !== 'object') return message;
            const msg = message as { role?: string; content?: unknown };
            if (msg.role !== 'assistant' || typeof msg.content !== 'string') return message;
            return {
                ...msg,
                content: cleanOpenFluxCloudText(msg.content),
            };
        });
    }

    /**
     * Session messages (supports pagination lazy loading)
     * payload: { sessionId, limit?, offset? }
     * offset counts down from the end: offset=0 -> latest limit bar; do not transmit limit -> full amount (downward compatible)
     */
    function handleSessionsMessages(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { sessionId: string; limit?: number; offset?: number };
        if (payload.limit !== undefined) {
            // Paging mode
            const { messages, total, hasMore } = sessions.getVisibleMessagesPage(
                payload.sessionId,
                payload.limit,
                payload.offset ?? 0,
            );
            send(client, {
                type: 'sessions.messages',
                id: message.id,
                payload: { messages: cleanCloudSessionMessages(payload.sessionId, messages), total, hasMore },
            });
        } else {
            // Full mode (compatible with old calls)
            const messages = sessions.getVisibleMessages(payload.sessionId);
            send(client, {
                type: 'sessions.messages',
                id: message.id,
                payload: { messages: cleanCloudSessionMessages(payload.sessionId, messages) },
            });
        }
    }

    /**
     * session log
     */
    function handleSessionsLogs(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { sessionId: string };
        const logs = sessions.getLogs(payload.sessionId);
        send(client, { type: 'sessions.logs', id: message.id, payload: { logs } });
    }

    /** Durable Turn/Item activity events for exact history reconstruction. */
    function handleSessionsEvents(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { sessionId: string; limit?: number };
        const limit = Math.min(5000, Math.max(1, Math.floor(payload.limit ?? 500)));
        const events = sessions.getRecentEvents(payload.sessionId, limit).map(toPublicAgentRuntimeEvent);
        send(client, { type: 'sessions.events', id: message.id, payload: { events } });
    }

    /**
     * Create session
     */
    function handleSessionsCreate(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as {
            title?: string;
            cloudChatroomId?: number;
            cloudAgentName?: string;
            agentId?: string;
            approvalMode?: ApprovalMode;
        };
        if (payload?.approvalMode !== undefined && !isApprovalMode(payload.approvalMode)) {
            send(client, { type: 'error', id: message.id, payload: { message: 'Invalid approval mode' } });
            return;
        }
        // agentId：会话归属的 User Agent（多会话）；未指定时保持旧行为（'default'）
        const session = sessions.create(
            payload?.agentId || 'default',
            payload?.title,
            payload?.cloudChatroomId,
            payload?.cloudAgentName,
            undefined,
            normalizeApprovalMode(payload?.approvalMode),
        );
        send(client, { type: 'sessions.create', id: message.id, payload: { session } });
    }

    /** Persist the preference used by future turns; a running turn keeps its snapshot. */
    function handleSessionApprovalModeUpdate(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { sessionId?: string; approvalMode?: unknown } | undefined;
        if (!payload?.sessionId || !isApprovalMode(payload.approvalMode)) {
            send(client, { type: 'error', id: message.id, payload: { message: 'Invalid session or approval mode' } });
            return;
        }

        const existing = sessions.get(payload.sessionId);
        if (!existing || existing.status !== 'active' || existing.cloudChatroomId) {
            send(client, { type: 'error', id: message.id, payload: { message: 'Session cannot be updated' } });
            return;
        }

        const updated = sessions.updateMetadata(payload.sessionId, { approvalMode: payload.approvalMode });
        send(client, {
            type: 'sessions.approval-mode.update',
            id: message.id,
            payload: { success: true, approvalMode: updated?.approvalMode || payload.approvalMode },
        });
    }

    /**
     * Rename a session
     */
    function handleSessionsRename(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { sessionId: string; title: string };
        if (!payload?.sessionId || !payload?.title?.trim()) {
            send(client, { type: 'error', id: message.id, payload: { message: '缺少 sessionId 或 title' } });
            return;
        }
        sessions.updateTitle(payload.sessionId, payload.title.trim());
        send(client, { type: 'sessions.rename', id: message.id, payload: { success: true } });
    }

    /**
     * Delete session
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
     * Get session results
     */
    function handleSessionsArtifacts(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { sessionId: string };
        const artifacts = sessions.getArtifacts(payload.sessionId);
        send(client, { type: 'sessions.artifacts', id: message.id, payload: { artifacts } });
    }

    /**
     * Save session results
     */
    function handleSessionsArtifactsSave(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { sessionId: string; artifact: any };
        const saved = sessions.addArtifact(payload.sessionId, payload.artifact);
        send(client, { type: 'sessions.artifacts.save', id: message.id, payload: { artifact: saved } });
    }

    // ========================
    // Agent management message processing
    // ========================

    /**
     * Get the list of all Agents (including sessionKey)
     */
    function handleAgentsList(client: GatewayClient, message: GatewayMessage): void {
        const agents = [
            ...userAgentStore.list().map(agent => ({ ...agent, kind: 'agent' as const })),
            ...projectStore.list(),
        ];
        send(client, { type: 'agents.list', id: message.id, payload: { agents } });
    }

    /**
     * Create new agent
     */
    function handleAgentsCreate(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as any;
        if (!payload?.name) {
            send(client, { type: 'error', id: message.id, payload: { message: '缺少 Agent name' } });
            return;
        }
        try {
            const agent = payload.kind === 'project'
                ? projectStore.create(payload)
                : { ...userAgentStore.create(payload), kind: 'agent' as const };
            // 创建 Agent 后自动创建默认会话（多会话：每个 Agent 至少有一个会话）
            const defaultSessionId = ensureAgentDefaultSession(agent.id);
            send(client, { type: 'agents.create', id: message.id, payload: { agent, defaultSessionId } });
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            send(client, { type: 'error', id: message.id, payload: { message: msg } });
        }
    }

    /**
     * Update Agent configuration
     */
    function handleAgentsUpdate(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { agentId: string; updates: any };
        if (!payload?.agentId) {
            send(client, { type: 'error', id: message.id, payload: { message: '缺少 agentId' } });
            return;
        }
        try {
            const updated = projectStore.get(payload.agentId)
                ? projectStore.update(payload.agentId, payload.updates)
                : userAgentStore.update(payload.agentId, payload.updates);
            if (!updated) throw new Error('Agent 不存在');
            send(client, { type: 'agents.update', id: message.id, payload: { agent: updated } });
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            send(client, { type: 'error', id: message.id, payload: { message: msg } });
        }
    }

    /**
     * Delete Agent
     */
    function handleAgentsDelete(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { agentId: string };
        if (!payload?.agentId) {
            send(client, { type: 'error', id: message.id, payload: { message: '缺少 agentId' } });
            return;
        }
        const success = projectStore.get(payload.agentId)
            ? projectStore.delete(payload.agentId)
            : userAgentStore.delete(payload.agentId);
        if (success) {
            // 一并清除该 Agent 名下的全部会话（多会话）：兑现 UI 的"聊天历史将被清除"，
            // 也避免启动时的 session 扫描迁移把已删除的 Agent 恢复出来
            for (const s of listAgentSessions(payload.agentId)) {
                sessions.delete(s.id);
            }
            // 两种旧 key 格式兜底
            sessions.delete(`user-agent:${payload.agentId}`);
            sessions.delete(`agent:${payload.agentId}:main`);
        }
        send(client, { type: 'agents.delete', id: message.id, payload: { success } });
    }

    /**
     * Switch Agent (multi-session: return the Agent's session list + the active session's latest page of history)
     * payload.sessionId 可选：指定要激活的会话；缺省时选择最近更新的会话（无会话则自动创建默认会话）
     */
    function handleAgentsSwitch(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { agentId: string; sessionId?: string; limit?: number; offset?: number };
        if (!payload?.agentId) {
            send(client, { type: 'error', id: message.id, payload: { message: '缺少 agentId' } });
            return;
        }
        const agent = getLocalEntity(payload.agentId);
        if (!agent) {
            send(client, { type: 'error', id: message.id, payload: { message: `Agent 不存在: ${payload.agentId}` } });
            return;
        }

        // 该 Agent 名下的会话列表（至少保证默认会话存在）
        let agentSessions = listAgentSessions(agent.id);
        if (agentSessions.length === 0) {
            ensureAgentDefaultSession(agent.id);
            agentSessions = listAgentSessions(agent.id);
        }

        // 激活会话：优先使用调用方指定且归属本 Agent 的会话，否则取最近更新的
        const preferred = payload.sessionId
            ? agentSessions.find(s => s.id === payload.sessionId)
            : undefined;
        const activeSession = preferred || agentSessions[0]; // listAgentSessions 已按 updatedAt 降序
        const sessionKey = activeSession?.id || `user-agent:${agent.id}`;

        const limit = payload.limit ?? 20;
        const offset = payload.offset ?? 0;
        const { messages, total, hasMore } = sessions.getMessagesPage(sessionKey, limit, offset);
        send(client, {
            type: 'agents.switch',
            id: message.id,
            payload: { agent: { ...agent, sessionKey }, sessions: agentSessions, messages, total, hasMore },
        });
    }

    /**
     * Clear Agent history messages (multi-session: clears ALL sessions of the agent, then recreates the default one)
     */
    function handleAgentsHistoryClear(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { agentId: string };
        if (!payload?.agentId) {
            send(client, { type: 'error', id: message.id, payload: { message: '缺少 agentId' } });
            return;
        }
        const agent = getLocalEntity(payload.agentId);
        for (const s of listAgentSessions(payload.agentId)) {
            sessions.delete(s.id);
        }
        const sessionKey = `user-agent:${payload.agentId}`;
        sessions.create(payload.agentId, agent?.name || payload.agentId, undefined, undefined, sessionKey);
        send(client, { type: 'agents.history.clear', id: message.id, payload: { success: true, sessionKey } });
    }

    // ========================
    // Scheduler message processing
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
    // Memory message processing
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
    // Distillation system message processing
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
            // Search all cards (limited to 200 to avoid oversize)
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
            // Query all relationships
            const relations = db.prepare(
                'SELECT source_card_id, target_card_id, relation_type FROM card_relations'
            ).all().map((r: any) => ({
                source: r.source_card_id,
                target: r.target_card_id,
                type: r.relation_type,
            }));
            // Query all topics
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
            // total
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
    // Voice voice service message processing
    // ========================

    async function handleVoiceSynthesize(client: GatewayClient, message: GatewayMessage): Promise<void> {
        const payload = message.payload as { text: string };
        if (!ttsService?.isAvailable()) {
            send(client, { type: 'voice.synthesize', id: message.id, payload: { error: 'TTS service unavailable' } });
            return;
        }
        try {
            const audioBuffer = await ttsService.synthesize(payload.text);
            // Convert Buffer to base64 for transmission
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
    // OpenFlux cloud message processing
    // ========================

    async function handleOpenFluxLogin(client: GatewayClient, message: GatewayMessage): Promise<void> {
        const payload = message.payload as { username: string; password: string };
        if (!payload?.username || !payload?.password) {
            send(client, { type: 'openflux.login', id: message.id, payload: { success: false, message: 'Missing username or password' } });
            return;
        }
        const result = await openfluxBridge.login(payload.username, payload.password);

        // Login successful + currently in atlas_managed mode -> Rebuild LLM with new token
        if (result.success && llmSource === 'atlas_managed') {
            const refreshState = await refreshAtlasManagedRuntime({
                allowCachedRuntimeOnFailure: false,
                logLabel: 'Post-login atlas runtime refresh',
            });
            if (refreshState.status === 'auth_expired') {
                send(client, {
                    type: 'nexusai.auth-expired',
                    id: message.id,
                    payload: { message: refreshState.message || 'NexusAI access token 已失效，请重新登录' },
                });
            }
            if (llm) {
                log.info('Atlas LLM rebuilt with refreshed token after re-login');
            } else {
                log.warn('Atlas login succeeded but runtime is still unavailable', { status: refreshState.status, message: refreshState.message });
            }
        }

        send(client, { type: 'openflux.login', id: message.id, payload: result });
    }

    async function handleOpenFluxLogout(client: GatewayClient, message: GatewayMessage): Promise<void> {
        await openfluxBridge.logout();
        clearAtlasManagedUnavailable();
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
     * Cloud Agent Chat (via OpenFlux WebSocket bridge)
     */
    async function handleCloudChat(
        client: GatewayClient,
        message: GatewayMessage,
        payload: {
            input: string;
            sessionId?: string;
            chatroomId?: number;
            attachments?: Array<{ path: string; name: string; size: number; ext: string }>;
        },
        messageId: string,
    ): Promise<void> {
        if (!payload.chatroomId) {
            send(client, { type: 'chat.error', id: messageId, payload: { message: 'Missing chatroomId' } });
            return;
        }

        // ═══ Verify and correct sessionId ═══
        // The front end may send an incorrect sessionId (such as user-agent:main but chatroomId=329),
        // Need to find the correct cloud session based on chatroomId
        let resolvedSessionId = payload.sessionId;
        if (resolvedSessionId && payload.chatroomId) {
            const sessionMeta = sessions.get(resolvedSessionId);
            if (sessionMeta && sessionMeta.cloudChatroomId !== payload.chatroomId) {
                // sessionId does not match chatroomId! Find the correct session
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

        // Collect tokens independently in the progress callback (does not rely on resolve of openfluxBridge.chat)
        const collectedTokens: string[] = [];
        let lastTokenTime = Date.now();
        // Collect Agent-generated files; downloaded and materialized as artifacts after the chat ends
        const cloudFiles: Array<{ name: string; url: string }> = [];

        try {
            // Save user messages to local session
            if (resolvedSessionId) {
                sessions.addMessage(resolvedSessionId, {
                    role: 'user',
                    content: payload.input,
                });
                log.info('Cloud chat: user message saved', { sessionId: resolvedSessionId.slice(0, 8) });
            }

            // Upload user attachments and collect file_id list (for the FILELIST command)
            let fileIds: number[] | undefined;
            if (payload.attachments && payload.attachments.length > 0) {
                log.info('Cloud chat: uploading attachments', { count: payload.attachments.length });
                const uploaded: number[] = [];
                for (const att of payload.attachments) {
                    try {
                        const result = await openfluxBridge.uploadFile(att.path);
                        uploaded.push(result.fileId);
                    } catch (uploadErr) {
                        const em = uploadErr instanceof Error ? uploadErr.message : String(uploadErr);
                        log.error('Cloud chat: attachment upload failed', { name: att.name, error: em });
                        throw new Error(`附件上传失败（${att.name}）：${em}`);
                    }
                }
                fileIds = uploaded;
                log.info('Cloud chat: attachments uploaded', { fileIds });
            }

            const output = await openfluxBridge.chat(
                payload.chatroomId,
                payload.input,
                (event: OpenFluxChatProgressEvent) => {
                    // Collect token content
                    if (event.type === 'token' && event.token) {
                        collectedTokens.push(event.token);
                        lastTokenTime = Date.now();
                    }
                    // Collect Agent-generated files (download deferred to after chat ends to avoid blocking the stream)
                    if (event.type === 'cloud_files' && Array.isArray(event.files)) {
                        cloudFiles.push(...event.files);
                    }
                    send(client, {
                        type: 'chat.progress',
                        id: messageId,
                        payload: { ...event, sessionId: resolvedSessionId },
                    });
                },
                fileIds,
            );

            // openfluxBridge.chat normal resolve - use the output it returns
            const finalOutput = output || collectedTokens.join('');
            saveCloudAssistantMessage(resolvedSessionId, finalOutput);

            // Download Agent-generated files and store them as local artifacts (frontend auto-loads them on complete)
            await saveCloudFilesAsArtifacts(resolvedSessionId, cloudFiles);

            send(client, {
                type: 'chat.complete',
                id: messageId,
                payload: { output: finalOutput, sessionId: resolvedSessionId },
            });
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            log.error('Cloud chat error', { error: errorMsg });

            // Even on timeout/error, materialize files collected during streaming as artifacts
            await saveCloudFilesAsArtifacts(resolvedSessionId, cloudFiles);

            // If the reply content has been collected, the assistant message is still saved
            const fallbackOutput = collectedTokens.join('');
            if (fallbackOutput.length > 0) {
                log.info('Cloud chat error but collected reply, attempting to save');
                saveCloudAssistantMessage(resolvedSessionId, fallbackOutput);
                // Send complete (not error) because the user has already seen the reply
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

    /** Save Cloud Assistant messages to local session */
    function saveCloudAssistantMessage(sessionId: string | undefined, output: string): void {
        if (!sessionId || !output) return;
        const cleanOutput = cleanOpenFluxCloudText(output);
        if (!cleanOutput) return;
        try {
            sessions.addMessage(sessionId, {
                role: 'assistant',
                content: cleanOutput,
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

    /**
     * Download Agent-generated files into the local session directory and store them as artifacts.
     * Materialized artifacts carry a local path, so the frontend panel's open/reveal/save-as all work.
     */
    async function saveCloudFilesAsArtifacts(
        sessionId: string | undefined,
        files: Array<{ name: string; url: string }>,
    ): Promise<void> {
        if (!sessionId || files.length === 0) return;
        const destDir = join(workspace, 'cloud-files', sessionId);
        for (const file of files) {
            try {
                const rawName = file.name || file.url.split('/').pop() || 'file';
                const safeName = rawName.replace(/[\\/:*?"<>|]/g, '_');
                // Prefix with a timestamp to avoid overwriting files with the same name
                const destPath = join(destDir, `${Date.now()}_${safeName}`);
                const size = await openfluxBridge.downloadFile(file.url, destPath);
                sessions.addArtifact(sessionId, {
                    type: 'file',
                    path: destPath,
                    filename: rawName,
                    size,
                    timestamp: Date.now(),
                });
                log.info('Cloud file saved as artifact', { sessionId: sessionId.slice(0, 8), name: rawName, size });
            } catch (e) {
                log.warn('Cloud file download/save failed', {
                    url: file.url,
                    error: e instanceof Error ? e.message : String(e),
                });
            }
        }
    }

    // ========================
    // OpenFluxRouter message processing
    // ========================


    function handleRouterConfigGet(client: GatewayClient, message: GatewayMessage): void {
        const status = routerBridge.getStatus();
        // After restarting, the routerSessionId is null and the existing Router session is actively searched.
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

        // White-label lock: Router is baked-in by the enterprise; reject runtime writes
        if ((config as any).brandLock?.services === true) {
            log.info('Router config update rejected: locked by brand');
            send(client, { type: 'router.config.update', id: message.id, payload: { success: false, message: '该配置已由企业版内置锁定，不可修改' } });
            return;
        }

        try {
            // Merge configuration
            const currentConfig = routerBridge.getRawConfig() || { url: '', appId: '', appType: 'openflux', apiKey: '', appUserId: '', enabled: false };
            const newConfig: RouterConfig = {
                url: payload.url ?? currentConfig.url,
                appId: payload.appId ?? currentConfig.appId,
                appType: payload.appType ?? currentConfig.appType,
                apiKey: payload.apiKey ?? currentConfig.apiKey,
                appUserId: payload.appUserId ?? currentConfig.appUserId ?? '',
                enabled: payload.enabled ?? currentConfig.enabled,
            };

            // Save to memory config
            (config as any).router = newConfig;
            // persistence
            saveServerConfig(workspace, config, localProvidersSnapshot || undefined);

            // Update connection
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

    /** Process Router binding request */
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

    /** Process Router QR binding request (front-end request generates QR code) */
    function handleRouterQRBind(client: GatewayClient, message: GatewayMessage): void {
        log.info(`[QR] handleRouterQRBind called, connected=${routerBridge.getStatus().connected}`);
        const ok = routerBridge.requestQRBind();
        log.info(`[QR] requestQRBind result: ${ok}`);
        send(client, { type: 'router.qr-bind', id: message.id, payload: { success: ok, message: ok ? 'QR bind request sent' : 'Router not connected' } });
    }

    // ========================
    // WeChat iLink message processing (independent of Router)
    // ========================

    function handleWeixinConfigGet(client: GatewayClient, message: GatewayMessage): void {
        const wxCfg = loadWeixinConfig();
        const status = weixinBridge?.getStatus() || { connected: false, enabled: false, accountId: '' };
        // Share Router session ID after restart
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

            // Dynamic start and stop
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
            // Start QR login asynchronously (without blocking WebSocket)
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
    // Settings message processing
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
                // reset to default
                runtimeSettings.outputPath = join(workspace, 'output');
            } else if (typeof payload.outputPath === 'string' && payload.outputPath.trim()) {
                runtimeSettings.outputPath = payload.outputPath.trim();
            }

            // Make sure the directory exists
            if (!existsSync(runtimeSettings.outputPath)) {
                try { mkdirSync(runtimeSettings.outputPath, { recursive: true }); } catch { /* ignore */ }
            }

            // persistence
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
    // Server Config message processing
    // ========================

    /**
     * Desensitization API Key (only the first 8 digits and the last 4 digits are displayed)
     */
    function maskApiKey(key?: string): string {
        if (!key) return '';
        if (key.startsWith('${') && key.endsWith('}')) return key; // environment variable placeholder
        if (key.length <= 12) return '****';
        return key.slice(0, 8) + '****' + key.slice(-4);
    }

    function handleConfigGet(client: GatewayClient, message: GatewayMessage): void {
        // Build supplier information (desensitized key)
        const providersInfo: Record<string, { apiKey?: string; baseUrl?: string; masked?: boolean }> = {};
        const knownProviders = ['anthropic', 'openai', 'minimax', 'deepseek', 'zhipu', 'moonshot', 'dashscope', 'ollama', 'google', 'custom'];

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
                    // 优先用运行中 AgentManager 的真实清单（含内置 default/coder/automation/presentation/image 及各自 model 覆盖），
                    // 避免在某些基础配置加载路径下 config.agents.list 为空，导致设置页「Agent 模型」区域空白。
                    list: (() => {
                        let source: any[] = [];
                        try {
                            const live = agentManager?.getAgents?.() || [];
                            source = live.length > 0 ? live : (config.agents?.list || []);
                        } catch {
                            source = config.agents?.list || [];
                        }
                        return source.map((a: any) => ({
                            id: a.id,
                            name: a.name || a.id,
                            description: a.description || '',
                            model: a.model ? { provider: a.model.provider, model: a.model.model } : undefined,
                        }));
                    })(),
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
                imageGeneration: (config as any).imageGeneration ? {
                    provider: (config as any).imageGeneration.provider || 'openai',
                    model: (config as any).imageGeneration.model || '',
                    apiKey: maskApiKey((config as any).imageGeneration.apiKey),
                    baseUrl: (config as any).imageGeneration.baseUrl || '',
                    size: (config as any).imageGeneration.size || '',
                } : undefined,
            },
        });
    }

    /**
     * First startup setup wizard completed
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
            // Update config object
            if (!config.providers) config.providers = {};
            config.providers[payload.provider] = {
                apiKey: payload.apiKey,
                ...(payload.baseUrl ? { baseUrl: payload.baseUrl } : {}),
            };

            const modelName = payload.model || 'claude-sonnet-5';
            config.llm.orchestration.provider = payload.provider as any;
            config.llm.orchestration.model = modelName;
            config.llm.orchestration.apiKey = payload.apiKey;
            // When switching providers, the baseUrl must be re-parsed to avoid 404 caused by the URL residue of the old provider.
            config.llm.orchestration.baseUrl = payload.baseUrl || config.providers?.[payload.provider]?.baseUrl || undefined;
            config.llm.execution.provider = payload.provider as any;
            config.llm.execution.model = modelName;
            config.llm.execution.apiKey = payload.apiKey;
            config.llm.execution.baseUrl = payload.baseUrl || config.providers?.[payload.provider]?.baseUrl || undefined;

            // Agent settings
            if (payload.agentName || payload.agentPrompt) {
                if (!config.agents) config.agents = { list: [{ id: 'default', default: true, name: 'General Assistant' }] } as any;
                if (payload.agentName) config.agents!.globalAgentName = payload.agentName;
                if (payload.agentPrompt) config.agents!.globalSystemPrompt = payload.agentPrompt;
                // Synchronously update the name and prompt of the default Agent in UserAgentStore (the source is displayed in the UI sidebar)
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
                    apiKey: payload.router.appSecret || '',  // The appSecret in the wizard corresponds to the apiKey of RouterConfig
                    appUserId: '',
                    enabled: true,
                };
                (config as any).router = routerConfig;
                // Connect Router now to make hosted LLM configuration available upon first setup (no reboot required)
                routerBridge.updateConfig(routerConfig);
            } else if (payload.router?.enabled) {
                log.info('Setup router config ignored: locked by brand');
            }

            // Save to server-config.json
            saveServerConfig(workspace, config, localProvidersSnapshot || undefined);

            // Re-create LLM Provider, update agentManager
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
                // Synchronize Agent global settings to runtime (name + system prompt)
                if (payload.agentName || payload.agentPrompt) {
                    agentManager.updateGlobalSettings({
                        globalAgentName: payload.agentName,
                        globalSystemPrompt: payload.agentPrompt,
                    });
                }
                // Synchronously update CardManager's chatLLM
                if (memoryManager && (memoryManager as any)._cardManager) {
                    (memoryManager as any)._cardManager.updateChatLLM(newOrchLLM);
                }
                skillForge.updateLLM(newOrchLLM);
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
            imageGeneration?: {
                provider?: 'openai' | 'gemini';
                model?: string;
                apiKey?: string;
                baseUrl?: string;
                size?: string;
            };
        } | undefined;

        if (!payload) {
            send(client, { type: 'config.error', id: message.id, payload: { message: 'Missing update content' } });
            return;
        }

        try {
            let needRecreateLLM = false;
            let needRecreateEmbedding = false;

            // If you are currently using hosted LLM, first back up the runtime LLM configuration
            // It needs to be restored after saving to prevent the local configuration values ​​​​from the front end from overwriting the runtime managed configuration.
            const managedLlmBackup = (llmSource !== 'local') ? JSON.parse(JSON.stringify(config.llm)) : null;
            const managedProvidersBackup = (llmSource !== 'local' && config.providers) ? JSON.parse(JSON.stringify(config.providers)) : null;

            // Helper: Push configuration update progress to the client
            const sendProgress = (step: string) => {
                send(client, { type: 'config.progress', id: message.id, payload: { step } });
            };

            // 1. Update vendor key (write to memory config)
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
                // Re-merge provider configuration into llm
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

            // 2. Update the orchestration model
            if (payload.orchestration) {
                if (payload.orchestration.provider) {
                    if (config.llm.orchestration.provider !== payload.orchestration.provider) {
                        // Do not carry an endpoint from the previous provider.
                        config.llm.orchestration.baseUrl = undefined;
                    }
                    (config.llm.orchestration as any).provider = payload.orchestration.provider;
                }
                if (payload.orchestration.model) {
                    config.llm.orchestration.model = payload.orchestration.model;
                }
                // Merge provider configuration
                const pc = config.providers?.[(config.llm.orchestration as any).provider];
                if (pc) {
                    if (pc.apiKey) config.llm.orchestration.apiKey = pc.apiKey;
                    if (pc.baseUrl) config.llm.orchestration.baseUrl = pc.baseUrl;
                }
                needRecreateLLM = true;
            }

            // 3. Update execution model
            if (payload.execution) {
                if (payload.execution.provider) {
                    if (config.llm.execution.provider !== payload.execution.provider) {
                        // Do not carry an endpoint from the previous provider.
                        config.llm.execution.baseUrl = undefined;
                    }
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

            // 4. Update Web search and retrieval configuration
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

            // 5. Update MCP Server configuration (only processing location='server')
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

                // Hot reload MCP connection (server side only)
                try {
                    // Remove old MCP tool
                    const oldMcpTools = mcpManager.getTools();
                    for (const t of oldMcpTools) {
                        tools.unregister(t.name);
                    }

                    // Do not race a background startup connection with this hot reload.
                    await mcpInitialization;

                    // close old connection
                    await mcpManager.shutdown();

                    // reconnect
                    if (payload.mcp.servers.length > 0) {
                        sendProgress('正在连接 MCP 服务...');
                        await initializeMcpServers(payload.mcp.servers);
                        const serverInfo = mcpManager.getServerInfo();
                        log.info(`MCP hot-reload complete: ${serverInfo.map(s => `${s.name}(${s.toolCount})`).join(', ')}`);
                    }
                } catch (error) {
                    log.error('MCP hot-reload failed:', { error });
                }
            }

            // 5. Update Embedding model
            if (payload.embedding) {
                if (!config.llm.embedding) {
                    config.llm.embedding = { provider: 'openai', model: 'text-embedding-3-small' };
                }
                if (payload.embedding.provider) (config.llm.embedding as any).provider = payload.embedding.provider;
                if (payload.embedding.model) config.llm.embedding.model = payload.embedding.model;
                needRecreateEmbedding = true;
            }

            // 6. Update global character settings, skills and Agent models
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
                // Update Agent custom model
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
                                agent.model = undefined; // Clear the custom model and fall back to the global model
                            }
                        }
                    }
                }
                // Synchronize global settings to AgentManager runtime
                agentManager.updateGlobalSettings({
                    globalAgentName: config.agents.globalAgentName,
                    globalSystemPrompt: config.agents.globalSystemPrompt,
                });
                log.info('Global agent settings/skills/agent model updated');
            }

            // 6.5 Update sandbox configuration
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

            // 6.6 Update image generation model (local source). Only meaningful in standalone mode;
            // in managed/atlas modes the image model is provided by the platform and the UI is locked.
            if (payload.imageGeneration) {
                const cur = ((config as any).imageGeneration ||= { provider: 'openai' }) as Record<string, unknown>;
                const ig = payload.imageGeneration;
                if (ig.provider !== undefined) cur.provider = ig.provider;
                if (ig.model !== undefined) cur.model = ig.model;
                // Ignore masked placeholder (UI echoes back the masked value when the key is unchanged)
                if (ig.apiKey !== undefined && !ig.apiKey.includes('****')) cur.apiKey = ig.apiKey;
                if (ig.baseUrl !== undefined) cur.baseUrl = ig.baseUrl;
                if (ig.size !== undefined) cur.size = ig.size;
                log.info('Image generation model updated', { provider: cur.provider, model: cur.model });
            }

            // 7. Persistence to settings.json (server configuration part)
            saveServerConfig(workspace, config, localProvidersSnapshot || undefined);

            // If in managed mode, restore the runtime LLM configuration (to avoid contaminating the runtime config with local values ​​from the front end)
            if (managedLlmBackup) {
                config.llm = managedLlmBackup;
            }
            if (managedProvidersBackup) {
                (config as any).providers = managedProvidersBackup;
            }

            // 5. If you need to rebuild LLM Provider, update agentManager
            // NOTE: Rebuild only if llmSource === 'local' to avoid overwriting managed mode LLM instances
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
                        // Synchronously rebuild the agentRunner used by scheduled tasks
                        agentRunner = createAgentLoopRunner({ llm: newOrchLLM, fallbackLlm, tools, language: config.language });
                        // Synchronously update CardManager's chatLLM
                        if (memoryManager && (memoryManager as any)._cardManager) {
                            (memoryManager as any)._cardManager.updateChatLLM(newOrchLLM);
                        }
                        skillForge.updateLLM(newOrchLLM);
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

            // 7. If you need to rebuild Embedding LLM
            if (needRecreateEmbedding && memoryManager && config.memory?.enabled && config.llm.embedding) {
                sendProgress('正在更新 Embedding 模型...');
                try {
                    // Model -> Vector Dimension Mapping
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
                    // Save again to update vectorDim
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

                    // Synchronously update the embeddingLLM of the card system
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
    // Client MCP proxy
    // ========================

    /** Promise Map waiting for the result of client tool call */
    const pendingClientCalls = new Map<string, {
        resolve: (result: { success: boolean; data?: unknown; error?: string }) => void;
        reject: (error: Error) => void;
    }>();

    /**
     * Handle client registration MCP tool
     */
    function handleClientMcpRegister(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }> };

        // Clean old proxy tools first
        if (client.clientMcpToolNames?.length) {
            for (const name of client.clientMcpToolNames) {
                tools.unregister(name);
            }
        }

        const toolNames: string[] = [];

        for (const toolDef of payload.tools) {
            // Convert client tool definition to proxy tool
            const proxyTool: Tool = {
                name: toolDef.name,
                description: `[客户端] ${toolDef.description}`,
                parameters: convertClientParams(toolDef.parameters),
                async execute(args: Record<string, unknown>): Promise<ToolResult> {
                    // Forwarded to client for execution via WebSocket
                    const callId = crypto.randomUUID();
                    return new Promise((resolve, reject) => {
                        pendingClientCalls.set(callId, { resolve, reject });

                        send(client, {
                            type: 'mcp.client.call',
                            id: callId,
                            payload: { tool: toolDef.name, args },
                        });

                        // 60 second timeout
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
     * Handling Client Unregistration MCP Tool
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
     * Process the MCP tool execution results returned by the client
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

        // 插件回包形如 { success: tool.success, result: tool }（失败时 result 内含真实 error）
        // 历史 bug：仅在 payload.success 为 true 时读取 result，导致工具返回 {success:false,error:"真实原因"}
        // 时丢失内层错误、只显示通用 "客户端工具调用失败"。这里只要存在 result 就透传，保留真实错误信息。
        if (payload.result !== undefined && payload.result !== null) {
            pending.resolve(payload.result);
        } else {
            pending.resolve({ success: false, error: payload.error || '客户端工具调用失败' });
        }
    }

    /**
     * Convert client parameter definition to ToolParameter format
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

    // ========================
    // Plugin Protocol v1
    // ========================

    interface PluginInfo {
        pluginId: string;
        name: string;
        version: string;
        icon: string;
        description: string;
        tools: string[];
        status: 'ready' | 'busy' | 'idle' | 'error';
        message?: string;
        connectedAt: string;
        clientId: string;
    }

    /** List of registered plug-ins (pluginId -> PluginInfo) */
    const pluginRegistry = new Map<string, PluginInfo>();

    /** Excel multiple workbook routing table: workbook file name -> GatewayClient (supports multi-window parallel operation) */
    const pluginWorkbookClients = new Map<string, GatewayClient>();

    /** Word multi-document routing table: pluginId -> { docName, client } (using pluginId as key, supports the coexistence of documents with the same name) */
    const pluginDocumentClients = new Map<string, { docName: string; client: GatewayClient }>();

    /**
     * plugin.register - Plugin Protocol v1 registration portal
     * Reuse the tool registration logic of handleClientMcpRegister and add plug-in identity meta information
     */
    function handlePluginRegister(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as {
            pluginId?: string;
            name: string;
            version: string;
            icon?: string;
            description?: string;
            tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
            capabilities?: string[];
        };

        // Automatically generate pluginId if not provided
        const pluginId = payload.pluginId || `plugin-${client.id.slice(0, 8)}`;

        // If the pluginId has been registered by another client, expel the old registration (last-writer-wins)
        // Avoid the race condition caused by the close event not being triggered when the old client is disconnected (registration rejected -> infinite reconnection)
        const existing = pluginRegistry.get(pluginId);
        if (existing && existing.clientId !== client.id) {
            const oldClient = clients.get(existing.clientId);
            if (oldClient) {
                // The old client is still online: tools to clean up its registration and notify it of its eviction
                log.info(`Plugin "${pluginId}" evicting old client ${existing.clientId} (replaced by ${client.id})`);
                if (oldClient.clientMcpToolNames?.length) {
                    for (const name of oldClient.clientMcpToolNames) {
                        tools.unregister(name);
                    }
                    oldClient.clientMcpToolNames = [];
                }
            } else {
                // The old client has been disconnected but the close event has not yet cleared the registry.
                log.info(`Plugin "${pluginId}" stale entry (old client gone), allowing re-registration by ${client.id}`);
            }
            pluginRegistry.delete(pluginId);
        }

        // Reuse the tool registration logic of mcp.client.register
        // Clean up the client's old tools first
        if (client.clientMcpToolNames?.length) {
            for (const name of client.clientMcpToolNames) {
                tools.unregister(name);
            }
        }

        // Maintain Excel multiple workbook routing tables
        const excelWbMatch = payload.name.match(/^Excel - (.+)$/);
        if (excelWbMatch) {
            pluginWorkbookClients.set(excelWbMatch[1], client);
        }

        // Maintain the Word multi-document routing table (keyed by pluginId, supports multiple simultaneous "unknown document" connections)
        const wordDocMatch = payload.name.match(/^Word - (.+)$/);
        if (wordDocMatch) {
            pluginDocumentClients.set(pluginId, { docName: wordDocMatch[1], client });
        }

        const toolNames: string[] = [];
        for (const toolDef of payload.tools) {
            // All connected Excel workbooks are listed in the description to help the Agent understand the multi-window environment
            const connectedWbs = Array.from(pluginWorkbookClients.keys());
            const wbContext = connectedWbs.length > 1
                ? ` [⚠️ ${connectedWbs.length} workbooks open: ${connectedWbs.join(' | ')}. You MUST pass workbook_name to target the right one — if omitted, the call goes to an arbitrary workbook and may fail (e.g. ItemNotFound) or modify the wrong file.]`
                : '';

            // All connected Word documents are listed in the description to help the Agent perceive the multi-document environment.
            const allDocEntries = Array.from(pluginDocumentClients.values());
            const docContext = allDocEntries.length > 0
                ? ` [Connected Word documents (${allDocEntries.length}): ${allDocEntries.map(e => e.docName).join(' | ')}. Call word_list_documents to see all open Word docs. Use document_name param to target a specific one.]`
                : '';

            const proxyTool: Tool = {
                name: toolDef.name,
                description: `[Plugin:${payload.name}]${wbContext}${docContext} ${toolDef.description}`,
                parameters: convertClientParams(toolDef.parameters),
                isPlugin: true,   // Not filtered by profile whitelist
                async execute(args: Record<string, unknown>): Promise<ToolResult> {
                    // Special handling: excel_list_workbooks aggregates all connected workbooks from the routing table
                    if (toolDef.name === 'excel_list_workbooks' && pluginWorkbookClients.size > 0) {
                        const allWorkbooks = Array.from(pluginWorkbookClients.keys());
                        return {
                            success: true,
                            data: {
                                workbooks: allWorkbooks,
                                count: allWorkbooks.length,
                                note: 'Each workbook is a separate plugin instance. Specify workbook_name in other tools to target a specific workbook.',
                            },
                        };
                    }

                    // Workbook routing: Route to the corresponding client according to the workbook_name parameter
                    let targetClient = client; // Default: current (last registered) plugin
                    const requestedWb = args.workbook_name as string | undefined;
                    if (requestedWb && pluginWorkbookClients.size > 1) {
                        for (const [wbName, wbClient] of pluginWorkbookClients.entries()) {
                            if (requestedWb === wbName || requestedWb.includes(wbName) || wbName.includes(requestedWb)) {
                                targetClient = wbClient;
                                break;
                            }
                        }
                    }

                    // Word multi-document routing: routing to the corresponding client based on the document_name parameter
                    if (wordDocMatch && pluginDocumentClients.size > 0) {
                        // Special handling: word_list_documents - Gateway aggregates all connected documents
                        if (toolDef.name === 'word_list_documents') {
                            const allDocs = Array.from(pluginDocumentClients.values());
                            return {
                                success: true,
                                data: {
                                    documents: allDocs.map(e => e.docName),
                                    count: allDocs.length,
                                    pluginIds: Array.from(pluginDocumentClients.keys()),
                                },
                            };
                        }

                        // Special handling: word_save_as - Gateway Save as without dialog via PowerShell COM
                        if (toolDef.name === 'word_save_as') {
                            const targetPath = args.target_path as string;
                            if (!targetPath) {
                                return { success: false, error: 'target_path is required' };
                            }
                            const docName = args.document_name as string | undefined;
                            // Escape single quotes in paths
                            const safePath = targetPath.replace(/'/g, "''");
                            const psScript = docName
                                ? `$word = [Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application'); $doc = $word.Documents | Where-Object { $_.Name -like '*${docName.replace(/'/g, "''")}*' } | Select-Object -First 1; if ($doc) { $doc.SaveAs2('${safePath}'); Write-Output "Saved: $($doc.FullName)" } else { throw "Document not found: ${docName}" }`
                                : `$word = [Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application'); $doc = $word.ActiveDocument; $doc.SaveAs2('${safePath}'); Write-Output "Saved: $($doc.FullName)"`;
                            const windowsTool = tools.getTool('windows');
                            if (!windowsTool) {
                                return { success: false, error: 'windows tool not available for PowerShell COM execution' };
                            }
                            const result = await windowsTool.execute({ action: 'powershell', script: psScript });
                            return result.success
                                ? { success: true, data: { saved: true, targetPath, output: result.data } }
                                : { success: false, error: result.error ?? 'PowerShell COM save failed' };
                        }

                        // Special handling: excel_list_workbooks / excel_get_workbook_path - PowerShell COM returns full path
                        // The plug-in side can only return the file name, the COM method can return the FullName (absolute path), and the Agent can be directly used for openpyxl/win32com operations.
                        if (toolDef.name === 'excel_list_workbooks' || toolDef.name === 'excel_get_workbook_path') {
                            const windowsTool = tools.getTool('windows');
                            if (!windowsTool) return { success: false, error: 'windows tool not available' };
                            const psScript = `$excel=[Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application');$result=@();foreach($wb in $excel.Workbooks){$result+=[PSCustomObject]@{name=$wb.Name;fullPath=$wb.FullName;saved=$wb.Saved}};if($result.Count-eq 0){'[]'}else{$result|ConvertTo-Json -Depth 2 -Compress}`;
                            const r = await windowsTool.execute({ action: 'powershell', script: psScript });
                            if (!r.success) return { success: false, error: r.error ?? 'PowerShell COM failed' };
                            try {
                                const raw = String((r.data as Record<string, unknown>)?.output ?? r.data ?? '[]').trim();
                                const parsed = JSON.parse(raw || '[]');
                                const arr = Array.isArray(parsed) ? parsed : [parsed];
                                return { success: true, data: {
                                    workbooks: arr,
                                    count: arr.length,
                                    note: 'fullPath contains the absolute file path usable with openpyxl/win32com/pyxlsb'
                                }};
                            } catch { return { success: false, error: 'Failed to parse workbook list' }; }
                        }

                        // Document routing: Route to the corresponding client according to the document_name parameter
                        const requestedDoc = args.document_name as string | undefined;
                        if (requestedDoc && pluginDocumentClients.size > 1) {
                            for (const [pid, entry] of pluginDocumentClients.entries()) {
                                if (requestedDoc === entry.docName || requestedDoc === pid ||
                                    requestedDoc.includes(entry.docName) || entry.docName.includes(requestedDoc)) {
                                    targetClient = entry.client;
                                    break;
                                }
                            }
                        }
                    }

                    // Special handling: ppt_add_image - 网关侧把图片(URL 或本地文件路径)转 base64。
                    // Office 任务窗格(WebView2)内 fetch 外链会被 CORS/沙箱拦截、也无法读本地文件路径；
                    // 改由网关(Node)读取后只把 base64 下发给插件，规避以上限制。
                    if (toolDef.name === 'ppt_add_image') {
                        const hasB64 = args.image_base64 || args.base64 || args.image || args.data || args.imageBase64;
                        const imgUrl = (args.image_url || args.url || args.imageUrl) as string | undefined;
                        const imgPath = (args.image_path || args.file_path || args.path || args.filepath || args.localPath) as string | undefined;
                        const stripArgKeys = () => {
                            for (const k of ['image_url', 'url', 'imageUrl', 'image_path', 'file_path', 'path', 'filepath', 'localPath']) {
                                delete (args as Record<string, unknown>)[k];
                            }
                        };
                        if (!hasB64 && imgPath && !/^https?:\/\//i.test(imgPath)) {
                            // 本地文件路径：网关读取并转 base64
                            try {
                                if (!existsSync(imgPath)) return { success: false, error: `图片文件不存在: ${imgPath}` };
                                const buf = readFileSync(imgPath);
                                if (buf.length === 0) return { success: false, error: `图片文件为空: ${imgPath}` };
                                args = { ...args, image_base64: buf.toString('base64') };
                                stripArgKeys();
                            } catch (e) {
                                return { success: false, error: `读取图片文件失败: ${e instanceof Error ? e.message : String(e)} (${imgPath})` };
                            }
                        } else if (!hasB64 && imgUrl && /^https?:\/\//i.test(imgUrl)) {
                            // 远程 URL：网关抓取并转 base64
                            try {
                                const resp = await fetch(imgUrl);
                                if (!resp.ok) return { success: false, error: `获取图片失败: HTTP ${resp.status} (${imgUrl})` };
                                const buf = Buffer.from(await resp.arrayBuffer());
                                if (buf.length === 0) return { success: false, error: `获取图片失败: 响应为空 (${imgUrl})` };
                                args = { ...args, image_base64: buf.toString('base64') };
                                stripArgKeys();
                            } catch (e) {
                                return { success: false, error: `获取图片失败: ${e instanceof Error ? e.message : String(e)} (${imgUrl})` };
                            }
                        }
                    }

                    // Special handling: ppt_apply_template - content 里的图片字段（本地路径 / http URL）网关侧转 base64。
                    // 模板 image 字段插件侧只认 base64 / URL，但 WebView 内 fetch 外链被 CORS 拦、读不了本地文件；
                    // generate_image 产出的是本地文件路径，必须在网关内联成 base64 再下发。
                    if (toolDef.name === 'ppt_apply_template') {
                        const IMG_KEY = /image|photo|avatar|background|^bg$|logo/i;
                        const IMG_EXT = /\.(png|jpe?g|gif|bmp|webp)([?#].*)?$/i;
                        const toBase64 = async (v: string): Promise<string | null> => {
                            const s = v.trim();
                            // 已是 data URL 或疑似裸 base64（超长且无路径分隔符）则不处理
                            if (/^data:image\//i.test(s) || (s.length > 512 && !/[\\/]/.test(s))) return null;
                            if (/^https?:\/\//i.test(s)) {
                                try {
                                    const resp = await fetch(s);
                                    if (!resp.ok) return null;
                                    const buf = Buffer.from(await resp.arrayBuffer());
                                    return buf.length ? buf.toString('base64') : null;
                                } catch { return null; }
                            }
                            if (existsSync(s)) {
                                try { const buf = readFileSync(s); return buf.length ? buf.toString('base64') : null; } catch { return null; }
                            }
                            return null;
                        };
                        const walk = async (node: unknown, key?: string): Promise<unknown> => {
                            if (typeof node === 'string') {
                                const keyHit = key ? IMG_KEY.test(key) : false;
                                if (keyHit || IMG_EXT.test(node.trim())) {
                                    const b64 = await toBase64(node);
                                    if (b64) return b64;
                                }
                                return node;
                            }
                            if (Array.isArray(node)) {
                                const out: unknown[] = [];
                                for (const item of node) out.push(await walk(item, key));
                                return out;
                            }
                            if (node && typeof node === 'object') {
                                const out: Record<string, unknown> = {};
                                for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = await walk(v, k);
                                return out;
                            }
                            return node;
                        };
                        for (const key of ['content', 'fields', 'data'] as const) {
                            const val = (args as Record<string, unknown>)[key];
                            if (val && typeof val === 'object') {
                                args = { ...args, [key]: await walk(val) };
                            } else if (typeof val === 'string' && val.trim().startsWith('{')) {
                                // content 有时被序列化成 JSON 字符串
                                try { args = { ...args, [key]: JSON.stringify(await walk(JSON.parse(val))) }; } catch { /* 保持原样 */ }
                            }
                        }
                    }

                    const finalArgs = args;
                    const runCall = (): Promise<ToolResult> => {
                        const callId = crypto.randomUUID();
                        return new Promise((resolve) => {
                            pendingClientCalls.set(callId, { resolve, reject: (e) => resolve({ success: false, error: String(e) }) });
                            send(targetClient, { type: 'mcp.client.call', id: callId, payload: { tool: toolDef.name, args: finalArgs } });
                            setTimeout(() => {
                                if (pendingClientCalls.has(callId)) {
                                    pendingClientCalls.delete(callId);
                                    resolve({ success: false, error: `Plugin tool "${toolDef.name}" timed out (60s)` });
                                }
                            }, 60000);
                        });
                    };

                    // 串行化：LLM 常并行发起多个 Office 工具调用（如连续 5 个 ppt_apply_template），
                    // 同一文档上并发跑多个 Office.js 批处理会互相干扰报 InvalidArgument（表现为"参数无效"）。
                    // 按目标客户端排队，确保同一文档同一时刻只执行一个插件工具调用。
                    const prev = targetClient.pluginCallQueue ?? Promise.resolve();
                    const next = prev.then(runCall, runCall);
                    targetClient.pluginCallQueue = next.catch(() => undefined);
                    return next;
                },
            };
            tools.register(proxyTool);
            toolNames.push(toolDef.name);
        }

        client.clientMcpToolNames = toolNames;

        // Register to PluginRegistry
        const info: PluginInfo = {
            pluginId,
            name: payload.name,
            version: payload.version,
            icon: payload.icon || '🔌',
            description: payload.description || '',
            tools: toolNames,
            status: 'ready',
            connectedAt: new Date().toISOString(),
            clientId: client.id,
        };
        pluginRegistry.set(pluginId, info);

        // 保存注册消息：其他同类插件实例断开误删同名工具时，凭它把工具重新挂回（见 ws close 处理）
        client.pluginRegisterMessage = message;

        log.info(`Plugin "${payload.name}" v${payload.version || '?'} (${pluginId}) registered ${toolNames.length} tools: ${toolNames.join(', ')}`);

        send(client, {
            type: 'plugin.register.ack',
            id: message.id,
            payload: { success: true, pluginId, registeredTools: toolNames },
        });
    }

    /**
     * plugin.unregister - Plugin actively logs out
     */
    function handlePluginUnregister(client: GatewayClient, message: GatewayMessage): void {
        client.pluginRegisterMessage = undefined;
        handleClientMcpUnregister(client);
        // Remove from PluginRegistry
        for (const [id, info] of pluginRegistry.entries()) {
            if (info.clientId === client.id) {
                pluginRegistry.delete(id);
                log.info(`Plugin "${info.name}" (${id}) unregistered`);
            }
        }
        send(client, { type: 'plugin.unregister', id: message.id, payload: { success: true } });
    }

    /**
     * plugin.list - Query the online plugin list (front-end call)
     */
    function handlePluginList(client: GatewayClient, message: GatewayMessage): void {
        const plugins = Array.from(pluginRegistry.values());
        send(client, { type: 'plugin.list', id: message.id, payload: { plugins } });
    }

    /**
     * plugin.status - Plugin updates its own status
     */
    function handlePluginStatusUpdate(client: GatewayClient, message: GatewayMessage): void {
        const { pluginId, status, message: statusMsg } = message.payload as {
            pluginId?: string;
            status: 'ready' | 'busy' | 'idle' | 'error';
            message?: string;
        };
        // Find the plug-in corresponding to the client
        for (const [id, info] of pluginRegistry.entries()) {
            if (info.clientId === client.id && (!pluginId || id === pluginId)) {
                info.status = status;
                info.message = statusMsg;
                log.info(`Plugin "${info.name}" status: ${status}${statusMsg ? ` — ${statusMsg}` : ''}`);
                break;
            }
        }
    }

    /**
     * Start debug mode browser
     */
    async function handleBrowserLaunch(client: GatewayClient, message: GatewayMessage): Promise<void> {
        try {
            const success = await launchChromeWithDebugPort();
            send(client, {
                type: 'browser.launch',
                id: message.id,
                payload: { success, message: success ? 'Browser launched in debug mode' : 'Chrome is running without debug port. Please close Chrome first.' },
            });
            // Broadcast browser connection status to all clients
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
     * Send message
     */
    function send(client: GatewayClient, message: GatewayMessage): boolean {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify(message));
            return true;
        }
        return false;
    }

    log.info('Standalone Gateway initialization complete');

    return {
        async start(): Promise<void> {
            await new Promise<void>((resolve, reject) => {
                wss = new WebSocketServer({ port, host: '127.0.0.1' });
                wss.on('connection', handleConnection);
                wss.on('listening', () => {
                    log.info(`Standalone Gateway started: ws://127.0.0.1:${port}`);
                    resolve();
                });
                wss.on('error', (err: NodeJS.ErrnoException) => {
                    if (err.code === 'EADDRINUSE') {
                        log.error(`Gateway WebSocket port ${port} is already in use. Another Gateway instance may be running.`, {
                            port,
                            hint: 'Run: netstat -ano | findstr :' + port + ' to find the conflicting process',
                        });
                    } else {
                        log.error('Gateway WebSocket server error', { error: err.message, code: err.code });
                    }
                    reject(err);
                });
            });

            // Optional integrations become ready progressively. Neither a slow/broken MCP
            // process nor CLI discovery should hold the entire desktop UI behind the loader.
            if (config.mcp?.servers?.length) {
                void initializeMcpServers(config.mcp.servers as McpServerConfig[]);
            }
            void runEnvProbeAsync().catch(error => {
                log.warn('Background environment probe failed (does not affect core functionality)', {
                    error: error instanceof Error ? error.message : String(error),
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
 * Start a standalone Gateway (command line entry)
 */
export async function startStandaloneGateway(): Promise<void> {
    const gateway = await createStandaloneGateway();
    try {
        await gateway.start();
    } catch (err: any) {
        if (err?.code === 'EADDRINUSE') {
            // Port is occupied: exit with normal exit code to avoid infinite restart of Tauri sidecar
            // The Rust side will recognize exit(0) as a normal exit and will not trigger the crash restart logic.
            log.error(`[FATAL] Gateway port already in use. Please close the existing OpenFlux instance first.`);
            process.exit(0);
        }
        throw err;
    }

    // Global uncaught Promise rejection protection (prevents Playwright internal race conditions from causing process crash)
    process.on('unhandledRejection', (reason: any) => {
        // Playwright ProtocolError (such as dialog race condition): only log warnings, no crashes
        if (reason?.constructor?.name === 'ProtocolError' ||
            (reason?.message && reason.message.includes('Protocol error'))) {
            log.warn('Playwright ProtocolError suppressed (non-fatal)', {
                message: reason.message || String(reason)
            });
            return;
        }
        // Other uncaught rejections: log errors but don't crash
        log.error('Unhandled promise rejection', {
            error: reason?.message || String(reason),
            stack: reason?.stack,
        });
    });

    // Exit gracefully
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

