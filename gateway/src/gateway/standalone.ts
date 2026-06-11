/**
 * Standalone Gateway Server
 * Built-in Agent Loop, client connects through WebSocket
 */

// @ts-ignore - Runtime with ws module
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, copyFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve as resolvePath } from 'path';
import { loadConfig } from '../config/loader';
import { ToolRegistry } from '../tools/registry';
import type { ImageGenRuntimeConfig } from '../tools/registry';
import type { Tool, ToolResult, ToolParameter } from '../tools/types';
import { createSpawnTool } from '../tools/spawn';
import { createLLMProvider } from '../llm/factory';
import { LLMError } from '../llm/llm-error';
import { createAtlasGatewayFetch } from '../llm/atlas-transport';
import { createAgentLoopRunner } from '../agent/loop';
import { createSubAgentExecutor } from '../agent/subagent';
import { AgentManager } from '../agent/manager';
import { UserAgentStore } from '../agent/user-agent-store';
import { SessionStore } from '../sessions';
import { WorkflowEngine } from '../workflow';
import { Scheduler, SchedulerStore } from '../scheduler';
import type { SchedulerEvent, ScheduledTaskMeta } from '../scheduler';
import { Logger, onLogBroadcast, installConsoleCapture, incrementDebugSubscribers, decrementDebugSubscribers, type LogEntry } from '../utils/logger';
import { detectSystemEncoding } from '../utils/system-encoding';
import { runEnvProbe, getEnvProbe, formatNow, getTodayStr, formatDate } from '../utils/env-probe';
// ── Heavy modules: lazy loading (reduces startup memory) ──────────────────────────
// The following modules are loaded on demand within createStandaloneGateway() await import()
// Keep only type import (zero runtime overhead)
import type { McpServerConfig } from '../tools/mcp-client';
import type { OpenFluxChatProgressEvent, AtlasOpenFluxRuntime, FetchUserInfoResult } from './openflux-chat-bridge';
import type { RouterConfig, RouterInboundMessage, RouterOutboundMessage, ManagedRuntimeConfigMessage } from './router-bridge';
import type { ForgeSuggestion } from '../evolution';
import type { LLMPolicyRetry, LLMProtocol, LLMProvider } from '../llm/provider';

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
            let uaChanged = false;

            for (const agent of (oldUa.agents || [])) {
                if (!newIds.has(agent.id)) {
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

        let renameCount = 0;
        let agentAddCount = 0;
        for (const metaFile of oldMetaFiles) {
            try {
                // Extract old agentId from filename, e.g. user-agent_main.meta.json -> main
                const baseName = metaFile.replace(/^user-agent_/, '').replace(/\.meta\.json$/, '');
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
                    if (meta.title && !knownAgentIds.has(baseName) && !builtinIds.has(baseName)) {
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
                if (builtinIds.has(agentId) || knownIds.has(agentId)) continue;

                const rawContent = readFileSync(join(newPath, f), 'utf-8');
                // Strip BOM (UTF-8 files written by some tools contain BOM, JSON.parse will throw an exception)
                const jsonContent = rawContent.charCodeAt(0) === 0xFEFF ? rawContent.slice(1) : rawContent;
                const meta = JSON.parse(jsonContent);
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
}

const log = new Logger('GatewayServer');

/**
 * Agent progress event
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
    /** LLM original description text (tool_start event only, content from LLM) */
    llmDescription?: string;
}

/**
 * client connection
 */
interface GatewayClient {
    id: string;
    ws: WebSocket;
    authenticated: boolean;
    /** Whether to subscribe to the debug log */
    debugSubscribed?: boolean;
    /** Client MCP tool name list (used for cleaning up when disconnected) */
    clientMcpToolNames?: string[];
}

/**
 * Message type
 */
interface GatewayMessage {
    type: string;
    id?: string;
    payload?: unknown;
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

    // Second thing: environment detection (time zone/Locale + CLI tool availability)
    runEnvProbe();
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
    const { launchChromeWithDebugPort, getBrowserConnectionStatus, initBrowserProbe, cleanupScheduledPages } = await import('../tools/browser/index');
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
    const userAgentStore = new UserAgentStore(workspace, defaultAgentName, (config as any).agentPresets || []);

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
    const tools = new ToolRegistry();
    const { WorkflowStore } = await import('../workflow/workflow-store');
    // Use the resolved `workspace` (brand-isolated), NOT config.workspace which is the raw yaml value
    // and ignores brandLock.dataDir — otherwise workflows/scheduler leak into the open-source data dir.
    const workflowStore = new WorkflowStore(join(workspace, '.workflows'));
    const workflowEngine = new WorkflowEngine({ tools, llm, store: workflowStore });

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
                        sessions.create('default', `🕐 ${event.taskName || '定时任务'}`, undefined, undefined, event.sessionId);
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

    // Active execution tracking (supports multi-session concurrency)
    // key: sessionId, value: execution status
    const activeExecutions = new Map<string, { startedAt: number }>();
    /** Active AbortController (used for users to actively stop tasks), key = sessionId */
    const activeAbortControllers = new Map<string, AbortController>();
    // Per-session execution queue: requests for the same session are automatically queued and transparent to the user
    const sessionExecutionChains = new Map<string, Promise<unknown>>();
    // The sessionId in the current execution (used for process.spawn association, pointing to the most recently started one when there is multiple concurrency)
    let currentExecutingSessionId: string | undefined;

    // Late-bound image-model resolver. The actual `llmSource` is initialized later in this
    // function, so generate_image reads the current source through this getter at call time.
    // Phase 1 only resolves the `local` source; managed/atlas_managed are added in later phases.
    let getImageRuntimeConfig: () => ImageGenRuntimeConfig | undefined = () => undefined;

    tools.registerDefaults({
        process: {
            cwd: () => runtimeSettings.outputPath,
            allowedCommands: config.sandbox?.allowedCommands,
            allowedCwdPaths: [...allowedCwdPaths],
            docker: config.sandbox?.mode === 'docker' ? config.sandbox.docker : undefined,
            getSessionId: () => currentExecutingSessionId,
            // Built-in Python path injection: intercept the python/pip/uv prefix and replace it with an absolute path without modifying the system PATH
            pythonExe: isPythonReady() ? getPythonEnvInfo().pythonExe : undefined,
            uvExe:     existsSync(getUvExePath())  ? getUvExePath()            : undefined,
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
        browser: {}, // The headless option has been removed and the default is adapted according to the environment.
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
        imageGen: {
            getOutputPath: () => runtimeSettings.outputPath,
            getRuntimeConfig: () => getImageRuntimeConfig(),
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

    // Register coding_agent tool (agy/claude/codex/cursor CLI driver)
    // The session uses CLI's own conv/session ID as the value, and uses "project cwd" as the key to persist to disk.
    // In the same project directory, CLI can restore its own context regardless of cross-OpenFlux conversations or Gateway restarts
    const { createCodingAgentTool } = await import('../tools/coding-agent');
    tools.register(createCodingAgentTool({
        defaultCwd: () => runtimeSettings.outputPath,
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
    // - atlas_managed: NexusAI/Atlas image ability (phase 3).
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
        // Phase 3: atlas_managed (NexusAI/Atlas) image source
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
                    attachments,     // Multimedia attachments (pictures/documents)
                    routerMetadata,
                );

                broadcastToClients({
                    type: 'chat.complete',
                    id: msgId,
                    payload: { output, sessionId },
                });

                // Return AI reply to platform
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
    let wss: WebSocketServer | null = null;
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
    async function executeAgent(
        input: string,
        sessionId?: string,
        onProgress?: (event: AgentProgressEvent) => void,
        attachments?: Array<{ path: string; name: string; size: number; ext: string }>,
        userMetadata?: Record<string, unknown>,
        agentId?: string,
        abortSignal?: AbortSignal,
        agentRunOptions?: {
            llmOverride?: LLMProvider;
            retryCurrentUserMessage?: boolean;
        },
    ): Promise<string> {
        const execKey = sessionId || `__anonymous_${crypto.randomUUID()}`;

        // Chain queuing: wait for the previous task in the same session to complete before executing it
        const previousChain = sessionExecutionChains.get(execKey) || Promise.resolve();

        const currentExecution = previousChain.catch(() => { }).then(async () => {
            activeExecutions.set(execKey, { startedAt: Date.now() });
            currentExecutingSessionId = sessionId;
            log.info('Executing task', { input: input.slice(0, 100), sessionId, activeCount: activeExecutions.size });

            // User Agent session is automatically created: If sessionId starts with user-agent: and does not exist, it is automatically created
            if (sessionId && sessionId.startsWith('user-agent:') && !sessions.get(sessionId)) {
                const userAgentId = sessionId.replace('user-agent:', '');
                const userAgent = userAgentStore.get(userAgentId);
                sessions.create('default', userAgent?.name || userAgentId, undefined, undefined, sessionId);
                log.info('Auto-created session for user agent', { sessionId, agentName: userAgent?.name });
            }

            try {
                // If agentId is a user-level Agent (not in the routing Agent list),
                // Pass undefined to let the router automatically assign to the appropriate routing agent.
                const routingAgentId = agentId && agentManager.getAgent(agentId) ? agentId : undefined;

                // User Agent Identity Injection: Parse user Agent's name and systemPrompt from sessionId
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
                    agentRunOptions,
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
        // Only fall back to the main Agent when there is really no sessionId
        if (!sessionId) {
            sessionId = 'user-agent:main';
        }
        // Make sure the session exists (user-agent:xxx or cron:xxx format)
        if (!sessions.get(sessionId)) {
            if (sessionId.startsWith('user-agent:')) {
                const agentId = sessionId.replace('user-agent:', '');
                const ua = userAgentStore.get(agentId);
                sessions.create('default', ua?.name || taskName, undefined, undefined, sessionId);
            } else {
                sessions.create('default', `🕐 ${taskName}`, undefined, undefined, sessionId);
            }
        }

        // ── 2. Check the Agent's identity ──
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
        const outputPath = runtimeSettings.outputPath;
        if (outputPath) {
            const todayStr = getTodayStr();
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

        // ── 7. Chain queue execution ──
        const execKey = sessionId;
        const previousChain = sessionExecutionChains.get(execKey) || Promise.resolve();

        const scheduledExecution = previousChain.catch(() => { }).then(async () => {
            activeExecutions.set(execKey, { startedAt: Date.now() });
            currentExecutingSessionId = sessionId;

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
                if (sessionId) {
                    sessions.addMessage(sessionId, {
                        role: 'assistant',
                        content: `定时任务「${taskName}」执行失败：${errorMsg}`,
                    });
                    broadcastSessionUpdate(sessionId);
                }
                throw error;
            } finally {
                activeExecutions.delete(execKey);
                // Clean up temporary tabs created by scheduled tasks (to avoid browser tab leaks)
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
     * Extract artifacts from tool call records of scheduled tasks and save them to session
     * Detect the generated files of filesystem.write/copy/info and process/opencode
     */
    function extractAndSaveScheduledArtifacts(
        sessionId: string,
        toolCalls: Array<{ name: string; result: unknown }>,
    ): void {
        const savedPaths = new Set<string>();
        // resolvePath has been imported at the top of the file

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
                                        type: 'file', path: filePath, filename, size, timestamp: Date.now(),
                                    });
                                    log.info('Scheduled task artifact saved', { filename, path: filePath });
                                }
                            } catch { /* ignore */ }
                        }
                    }
                }

                // process/opencode -> detect generatedFiles
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

                    // Alternate: detect file path from stdout
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
            payload: { requireAuth: !!token, setupRequired },
        });

        ws.on('message', (data: Buffer) => handleMessage(client, data.toString()));
        ws.on('close', () => {
            // Clean client MCP proxy tool
            if (client.clientMcpToolNames?.length) {
                for (const name of client.clientMcpToolNames) {
                    tools.unregister(name);
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


            // If the client is still in the debug subscription state when disconnected, reduce the count (to avoid the log level permanently stopping at debug)
            if (client.debugSubscribed) {
                decrementDebugSubscribers();
            }
            clients.delete(clientId);
            log.info(`Client disconnected: ${clientId}`);
        });
        ws.on('error', (error: Error) => log.error(`Client error: ${clientId}`, { error }));
    }

    /**
     * Process messages
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
                        const atlasToken = openfluxBridge.getToken();
                        if (!atlasToken) {
                            send(client, { type: 'config.llm-source', id: message.id, payload: { source: llmSource, error: '请先登录 NexusAI 账号' } });
                            break;
                        }

                        llmSource = 'atlas_managed';
                        // Save local providers snapshot
                        if (!localProvidersSnapshot) {
                            localProvidersSnapshot = JSON.parse(JSON.stringify(config.providers || {}));
                        }

                        const refreshState = await refreshAtlasManagedRuntime({
                            allowCachedRuntimeOnFailure: true,
                            logLabel: 'Switch atlas_managed runtime refresh',
                        });

                        if (refreshState.status === 'auth_expired') {
                            send(client, { type: 'config.llm-source', id: message.id, payload: { source: llmSource, error: '请先重新登录 NexusAI 账号' } });
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
                    const toolDef = tools.getTool(toolName);
                    if (!toolDef) {
                        send(client, {
                            type: 'tool.call',
                            id: message.id,
                            payload: { success: false, error: `Unknown tool: ${toolName}` },
                        });
                        break;
                    }
                    try {
                        const result = await toolDef.execute(toolArgs as any);
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

    /**
     * Chat (core, supports file attachments)
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

        // Create AbortController for users to actively stop tasks
        const abortController = new AbortController();
        const abortKey = payload.sessionId || messageId;
        activeAbortControllers.set(abortKey, abortController);

        const executeAgentOnce = async (agentRunOptions?: {
            llmOverride?: LLMProvider;
            retryCurrentUserMessage?: boolean;
        }): Promise<string> => {
            return executeAgent(
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
                agentRunOptions,
            );
        };

        const finalizeChatSuccess = async (output: string): Promise<void> => {
            send(client, {
                type: 'chat.complete',
                id: messageId,
                payload: { output, sessionId: payload.sessionId },
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
                            { output, iterations: 1, toolCalls: toolCallNames },
                            payload.sessionId,
                        ).catch(err => log.debug('Skill forge analysis error (non-blocking)', { error: String(err) }));
                    }
                }
            }
        };

        try {
            const output = await executeAgentOnce();
            await finalizeChatSuccess(output);
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
                        const output = await executeAgentOnce({ retryCurrentUserMessage: true });
                        await finalizeChatSuccess(output);
                        return;
                    } catch (retryError) {
                        finalError = retryError;
                    }
                } else if (refreshState.status === 'unavailable') {
                    finalError = new Error(atlasManagedUnavailableReason || ATLAS_RUNTIME_UNAVAILABLE_MESSAGE);
                } else if (refreshState.status === 'auth_expired') {
                    send(client, {
                        type: 'nexusai.auth-expired',
                        id: messageId,
                        payload: { message: refreshState.message || 'NexusAI access token 已失效，请重新登录' },
                    });
                    send(client, {
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
                        const output = await executeAgentOnce({
                            llmOverride: retryLlm,
                            retryCurrentUserMessage: true,
                        });
                        await finalizeChatSuccess(output);
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

            const shouldPromptAtlasReauth =
                llmSource === 'atlas_managed' &&
                finalError instanceof LLMError &&
                finalError.recoveryAction === 'reauth';

            if (shouldPromptAtlasReauth) {
                openfluxBridge.invalidateAuth();
                llm = null;
                clearAtlasManagedUnavailable();
                send(client, {
                    type: 'nexusai.auth-expired',
                    id: messageId,
                    payload: { message: finalError.message || 'NexusAI access token 已过期，请重新登录' },
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
     * Stop an ongoing task
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

            // Inject abort mark: Tell the next round of Agent that the previous task has been actively stopped by the user
            // Delay writing, ensuring the abort signal has propagated and run() has exited
            setTimeout(() => {
                try {
                    const msgs = sessions.getMessages(sessionId);
                    const lastMsg = msgs.at(-1);
                    // Append only if the last message is a user message (no corresponding assistant reply)
                    if (lastMsg && lastMsg.role === 'user') {
                        sessions.addMessage(sessionId, {
                            role: 'system' as any,
                            content: '[Task interrupted] The previous task was manually stopped by the user. Do NOT continue that task. Wait for the user\'s next instruction.',
                        });
                        log.info('Abort marker added to session', { sessionId });
                    }
                } catch (e) {
                    log.debug('Failed to add abort marker', { error: String(e) });
                }
            }, 300);
        } else {
            log.warn('chat.stop: no active task found', { sessionId });
        }
    }

    /**
     * Conversation list
     */
    function handleSessionsList(client: GatewayClient, message: GatewayMessage): void {
        const sessionList = sessions.list().map(session => {
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
            const { messages, total, hasMore } = sessions.getMessagesPage(
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
            const messages = sessions.getMessages(payload.sessionId);
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

    /**
     * Create session
     */
    function handleSessionsCreate(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { title?: string; cloudChatroomId?: number; cloudAgentName?: string };
        const session = sessions.create('default', payload?.title, payload?.cloudChatroomId, payload?.cloudAgentName);
        send(client, { type: 'sessions.create', id: message.id, payload: { session } });
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
        const agents = userAgentStore.list();
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
            const agent = userAgentStore.create(payload);
            send(client, { type: 'agents.create', id: message.id, payload: { agent } });
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
            const updated = userAgentStore.update(payload.agentId, payload.updates);
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
        const success = userAgentStore.delete(payload.agentId);
        send(client, { type: 'agents.delete', id: message.id, payload: { success } });
    }

    /**
     * Switch Agent (return the Agent's sessionKey + the latest page of session history)
     */
    function handleAgentsSwitch(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { agentId: string; limit?: number; offset?: number };
        if (!payload?.agentId) {
            send(client, { type: 'error', id: message.id, payload: { message: '缺少 agentId' } });
            return;
        }
        const agent = userAgentStore.get(payload.agentId);
        if (!agent) {
            send(client, { type: 'error', id: message.id, payload: { message: `Agent 不存在: ${payload.agentId}` } });
            return;
        }
        // User Agent uses user-agent:{id} as session key
        const sessionKey = `user-agent:${agent.id}`;
        const limit = payload.limit ?? 20;
        const offset = payload.offset ?? 0;
        const { messages, total, hasMore } = sessions.getMessagesPage(sessionKey, limit, offset);
        send(client, {
            type: 'agents.switch',
            id: message.id,
            payload: { agent: { ...agent, sessionKey }, messages, total, hasMore },
        });
    }

    /**
     * Clear Agent history messages
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

            const modelName = payload.model || 'claude-sonnet-4-20250514';
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

                    // close old connection
                    await mcpManager.shutdown();

                    // reconnect
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

        if (payload.success && payload.result) {
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
                ? ` [Connected workbooks: ${connectedWbs.join(' | ')}. Use workbook_name param to target a specific one.]`
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

                    const callId = crypto.randomUUID();
                    return new Promise((resolve) => {
                        pendingClientCalls.set(callId, { resolve, reject: (e) => resolve({ success: false, error: String(e) }) });
                        send(targetClient, { type: 'mcp.client.call', id: callId, payload: { tool: toolDef.name, args } });
                        setTimeout(() => {
                            if (pendingClientCalls.has(callId)) {
                                pendingClientCalls.delete(callId);
                                resolve({ success: false, error: `Plugin tool "${toolDef.name}" timed out (60s)` });
                            }
                        }, 60000);
                    });

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

        log.info(`Plugin "${payload.name}" (${pluginId}) registered ${toolNames.length} tools: ${toolNames.join(', ')}`);

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
    function send(client: GatewayClient, message: GatewayMessage): void {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify(message));
        }
    }

    log.info('Standalone Gateway initialization complete');

    // Automatically detect Chrome debug port on startup
    initBrowserProbe().catch(() => { /* ignore */ });

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

