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
    /** Stable key of the brand preset this agent was seeded from (used to backfill deleted presets) */
    presetId?: string;
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

    /** Load data, then reconcile brand presets (seed on first run, backfill deleted presets later). */
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

        this.reconcilePresets();
    }

    /** Stable identity key for a preset, used to detect whether it still exists in the store. */
    private presetKey(p: AgentPresetInput): string {
        const explicit = p.id?.trim();
        return explicit ? `id:${explicit}` : `name:${p.name}`;
    }

    /**
     * Reconcile brand presets with stored agents. Runs on every startup:
     * - First run (empty store): seed all presets, or a single default main agent if none.
     * - Later runs: re-add any brand preset the user has deleted, so enterprise presets always
     *   come back. Existing agents (matched by presetId, even if renamed/edited) are left untouched.
     */
    private reconcilePresets(): void {
        const now = Date.now();

        // No brand presets → preserve original behavior (only create default main when empty).
        if (this.presets.length === 0) {
            if (this.agents.length === 0) {
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
                this.save();
                log.info('Created default main agent');
            }
            return;
        }

        const usedIds = new Set(this.agents.map(a => a.id));
        const existingKeys = new Set(
            this.agents.map(a => a.presetId).filter((k): k is string => !!k),
        );
        let hasDefault = this.agents.some(a => a.default);
        let added = 0;

        for (const p of this.presets) {
            if (!p?.name) continue;
            const key = this.presetKey(p);
            if (existingKeys.has(key)) continue; // still present (possibly renamed) → leave as is

            let id = p.id?.trim() || randomUUID().slice(0, 8);
            while (usedIds.has(id)) id = randomUUID().slice(0, 8);
            usedIds.add(id);

            const isDefault = !!p.default && !hasDefault;
            if (isDefault) hasDefault = true;

            this.agents.push({
                id,
                presetId: key,
                name: p.name,
                description: p.description,
                icon: p.icon || '🤖',
                color: p.color || '#6366f1',
                systemPrompt: p.systemPrompt,
                default: isDefault || undefined,
                createdAt: now,
                updatedAt: now,
            });
            existingKeys.add(key);
            added++;
        }

        // Safety net: nothing valid and store still empty → fall back to default main agent.
        if (this.agents.length === 0) {
            this.agents.push({
                id: 'main', name: this.defaultAgentName, description: '默认对话助手',
                icon: '🤖', color: '#6366f1', default: true, createdAt: now, updatedAt: now,
            });
            added++;
        } else if (!hasDefault) {
            // No agent marked default → make the first one default
            this.agents[0].default = true;
            added++;
        }

        if (added > 0) {
            this.save();
            log.info(`Reconciled brand presets: added ${added} agent(s), total ${this.agents.length}`);
            console.error(`[UserAgentStore] Reconciled presets, total ${this.agents.length} agents`);
        }
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
