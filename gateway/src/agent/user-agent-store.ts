/**
 * User Agent Store-User-level Agent management
 * 
 * Separate from the routing agent (default/coder/automation configured in openflux.yaml).
 * User-level Agent is a conversation entity managed by the user on the UI, each Agent = an independent session.
 * 
 * Stored in a JSON file. A default "Main Agent" is created automatically.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Logger } from '../utils/logger';

const log = new Logger('UserAgentStore');

/** User Agent definition */
export interface UserAgent {
    id: string;
    name: string;
    description?: string;
    icon?: string;
    color?: string;
    systemPrompt?: string;
    default?: boolean;
    createdAt: number;
    updatedAt: number;
}

/** Storage file structure */
interface UserAgentData {
    version: 1;
    agents: UserAgent[];
}

/** White-label first-run preset agent (from agentPresets in openflux.brand.yaml) */
export interface AgentPresetInput {
    id?: string;
    name: string;
    description?: string;
    icon?: string;
    color?: string;
    systemPrompt?: string;
    default?: boolean;
}

export class UserAgentStore {
    private filePath: string;
    private agents: UserAgent[] = [];
    private defaultAgentName: string;
    private presets: AgentPresetInput[];

    constructor(
        dataDir: string,
        defaultAgentName: string = 'OpenFlux Assistant',
        presets: AgentPresetInput[] = [],
    ) {
        this.filePath = join(dataDir, 'user_agents.json');
        this.defaultAgentName = defaultAgentName;
        this.presets = Array.isArray(presets) ? presets : [];
        console.error(`[UserAgentStore] Init: filePath=${this.filePath}, dataDir=${dataDir}, presets=${this.presets.length}`);
        this.load();
    }

    /** Load data and create default Agent for first run */
    private load(): void {
        try {
            if (existsSync(this.filePath)) {
                const raw = readFileSync(this.filePath, 'utf-8');
                const data: UserAgentData = JSON.parse(raw);
                this.agents = data.agents || [];
                log.info(`Loaded ${this.agents.length} user agents`);
            }
        } catch (e) {
            log.warn('Failed to load user agents, starting fresh', e);
            this.agents = [];
        }

        // user_agents.json missing or empty → create the default main agent
        if (this.agents.length === 0) {
            // White-label provided multiple agent presets → seed them in batch
            if (this.presets.length > 0) {
                this.seedFromPresets();
            } else {
                // Otherwise create a single default main agent (original behavior)
                const now = Date.now();
                this.agents.push({
                    id: 'main',
                    name: this.defaultAgentName,
                    description: '默认对话助手',
                    icon: '🤖',
                    color: '#6366f1',
                    default: true,
                    createdAt: now,
                    updatedAt: now,
                });
                log.info('Created default main agent');
                this.save();
                console.error(`[UserAgentStore] Initialized with default agent`);
            }
        }
    }

    /** Seed agents in batch from white-label presets (only called when user_agents.json is empty) */
    private seedFromPresets(): void {
        const now = Date.now();
        const usedIds = new Set<string>();
        let hasDefault = false;

        for (const p of this.presets) {
            if (!p?.name) continue;
            // Deduplicate / generate id
            let id = p.id?.trim() || randomUUID().slice(0, 8);
            while (usedIds.has(id)) id = randomUUID().slice(0, 8);
            usedIds.add(id);

            const isDefault = !!p.default && !hasDefault;
            if (isDefault) hasDefault = true;

            this.agents.push({
                id,
                name: p.name,
                description: p.description,
                icon: p.icon || '🤖',
                color: p.color || '#6366f1',
                systemPrompt: p.systemPrompt,
                default: isDefault || undefined,
                createdAt: now,
                updatedAt: now,
            });
        }

        // No preset succeeded → fall back to the default main agent
        if (this.agents.length === 0) {
            this.agents.push({
                id: 'main', name: this.defaultAgentName, description: '默认对话助手',
                icon: '🤖', color: '#6366f1', default: true, createdAt: now, updatedAt: now,
            });
        } else if (!hasDefault) {
            // No preset marked default → make the first one default
            this.agents[0].default = true;
        }

        this.save();
        log.info(`Seeded ${this.agents.length} agents from brand presets`);
        console.error(`[UserAgentStore] Initialized with ${this.agents.length} preset agents`);
    }

    /** Persistence to file */
    private save(): void {
        try {
            const dir = dirname(this.filePath);
            if (!existsSync(dir)) {
                mkdirSync(dir, { recursive: true });
            }
            const data: UserAgentData = { version: 1, agents: this.agents };
            writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
            console.error(`[UserAgentStore] Saved ${data.agents.length} agents to ${this.filePath}`);
        } catch (e) {
            log.error('Failed to save user agents', e);
            console.error(`[UserAgentStore] SAVE FAILED: ${e}`);
        }
    }

    /** Get all user Agents */
    list(): UserAgent[] {
        return [...this.agents];
    }

    /** Get the specified Agent */
    get(id: string): UserAgent | undefined {
        return this.agents.find(a => a.id === id);
    }

    /** Create new Agent */
    create(input: { name: string; description?: string; icon?: string; color?: string; systemPrompt?: string }): UserAgent {
        const now = Date.now();
        const agent: UserAgent = {
            id: randomUUID().slice(0, 8),
            name: input.name || '新 Agent',
            description: input.description,
            icon: input.icon || '🤖',
            color: input.color || '#6366f1',
            systemPrompt: input.systemPrompt,
            createdAt: now,
            updatedAt: now,
        };
        this.agents.push(agent);
        this.save();
        log.info(`Created user agent: ${agent.id} (${agent.name})`);
        return agent;
    }

    /** Update Agent */
    update(id: string, updates: Partial<Omit<UserAgent, 'id' | 'createdAt'>>): UserAgent | null {
        const agent = this.agents.find(a => a.id === id);
        if (!agent) return null;

        if (updates.name !== undefined) agent.name = updates.name;
        if (updates.description !== undefined) agent.description = updates.description;
        if (updates.icon !== undefined) agent.icon = updates.icon;
        if (updates.color !== undefined) agent.color = updates.color;
        if (updates.systemPrompt !== undefined) agent.systemPrompt = updates.systemPrompt;
        agent.updatedAt = Date.now();

        this.save();
        log.info(`Updated user agent: ${id}`);
        return agent;
    }

    /** Update the name and system prompt of the default Agent (called when the initialization wizard is completed) */
    updateDefaultAgent(updates: { name?: string; systemPrompt?: string }): void {
        const defaultAgent = this.agents.find(a => a.default || a.id === 'main');
        if (!defaultAgent) return;

        if (updates.name) defaultAgent.name = updates.name;
        if (updates.systemPrompt !== undefined) defaultAgent.systemPrompt = updates.systemPrompt;
        defaultAgent.updatedAt = Date.now();

        this.save();
        log.info(`Default agent updated: name=${updates.name}`);
    }

    /** Delete Agent */
    delete(id: string): boolean {
        const idx = this.agents.findIndex(a => a.id === id);
        if (idx < 0) return false;

        const agent = this.agents[idx];
        if (agent.default) {
            log.warn('Cannot delete default agent');
            return false;
        }

        this.agents.splice(idx, 1);
        this.save();
        log.info(`Deleted user agent: ${id}`);
        return true;
    }
}
