/**
 * User Agent Store — 用户级 Agent 管理
 * 
 * 与路由 Agent（openflux.yaml 中配置的 default/coder/automation）分离。
 * 用户级 Agent 是用户在 UI 上管理的对话实体，每个 Agent = 一个独立会话。
 * 
 * 存储在 JSON 文件中，自动创建默认"主 Agent"。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Logger } from '../utils/logger';

const log = new Logger('UserAgentStore');

/** 用户 Agent 定义 */
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

/** 存储文件结构 */
interface UserAgentData {
    version: 1;
    agents: UserAgent[];
}

export class UserAgentStore {
    private filePath: string;
    private agents: UserAgent[] = [];
    private defaultAgentName: string;

    constructor(dataDir: string, defaultAgentName: string = 'OpenFlux Assistant') {
        this.filePath = join(dataDir, 'user_agents.json');
        this.defaultAgentName = defaultAgentName;
        this.load();
    }

    /** 加载数据，首次运行创建默认 Agent */
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

        // 没有任何 Agent 时创建默认主 Agent
        if (this.agents.length === 0) {
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
            this.save();
            log.info('Created default main agent');
        }
    }

    /** 持久化到文件 */
    private save(): void {
        try {
            const dir = dirname(this.filePath);
            if (!existsSync(dir)) {
                mkdirSync(dir, { recursive: true });
            }
            const data: UserAgentData = { version: 1, agents: this.agents };
            writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
        } catch (e) {
            log.error('Failed to save user agents', e);
        }
    }

    /** 获取所有用户 Agent */
    list(): UserAgent[] {
        return [...this.agents];
    }

    /** 获取指定 Agent */
    get(id: string): UserAgent | undefined {
        return this.agents.find(a => a.id === id);
    }

    /** 创建新 Agent */
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

    /** 更新 Agent */
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

    /** 删除 Agent */
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
