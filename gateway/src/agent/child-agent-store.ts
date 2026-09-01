import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
    SessionStore,
    getActiveSessionStore,
    getDefaultSessionStore,
} from '../sessions/store';
import type { ApprovalMode } from '../permissions/checker';

export type ChildAgentStatus =
    | 'running'
    | 'idle'
    | 'completed'
    | 'failed'
    | 'timeout'
    | 'interrupted';

export interface ChildAgentMessage {
    id: string;
    from: string;
    to: string;
    content: string;
    timestamp: number;
    read: boolean;
}

export interface ChildAgentRecord {
    version: 1;
    id: string;
    source: 'collaboration' | 'spawn';
    parentSessionId?: string;
    parentTurnId?: string;
    rootSessionId: string;
    agentId: string;
    agentType?: 'builtin' | 'user';
    task: string;
    mode: 'run' | 'session';
    status: ChildAgentStatus;
    startTime: number;
    endTime?: number;
    output?: string;
    error?: string;
    label?: string;
    messages: ChildAgentMessage[];
}

export interface CreateChildAgentRecord {
    id: string;
    source: ChildAgentRecord['source'];
    parentSessionId?: string;
    parentTurnId?: string;
    rootSessionId?: string;
    agentId: string;
    agentType?: ChildAgentRecord['agentType'];
    task: string;
    mode?: ChildAgentRecord['mode'];
    label?: string;
    approvalMode?: ApprovalMode;
}

function safeFileStem(sessionId: string): string {
    return sessionId.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
}

/**
 * Durable child-agent lifecycle store.
 *
 * Relationship fields live in SessionMetadata so the child participates in the
 * normal session/thread model.  Mutable execution state is kept in a sidecar to
 * avoid overloading the conversation transcript with scheduler state.
 */
export class ChildAgentStore {
    constructor(private readonly sessions: SessionStore) {}

    get sessionStore(): SessionStore {
        return this.sessions;
    }

    create(input: CreateChildAgentRecord): ChildAgentRecord {
        const existing = this.get(input.id);
        if (existing) return existing;

        const parentMeta = input.parentSessionId
            ? this.sessions.get(input.parentSessionId)
            : null;
        const rootSessionId = input.rootSessionId
            || parentMeta?.rootSessionId
            || input.parentSessionId
            || input.id;

        this.sessions.createChild({
            id: input.id,
            agentId: input.agentId,
            title: input.task.slice(0, 80),
            parentSessionId: input.parentSessionId,
            parentTurnId: input.parentTurnId,
            rootSessionId,
            approvalMode: input.approvalMode ?? parentMeta?.approvalMode,
        });

        const record: ChildAgentRecord = {
            version: 1,
            id: input.id,
            source: input.source,
            parentSessionId: input.parentSessionId,
            parentTurnId: input.parentTurnId,
            rootSessionId,
            agentId: input.agentId,
            agentType: input.agentType,
            task: input.task,
            mode: input.mode || 'run',
            status: 'running',
            startTime: Date.now(),
            label: input.label,
            messages: [],
        };
        this.write(record);
        return record;
    }

    get(sessionId: string): ChildAgentRecord | undefined {
        const filePath = this.getFilePath(sessionId);
        if (!existsSync(filePath)) return undefined;
        try {
            const value = JSON.parse(readFileSync(filePath, 'utf-8')) as ChildAgentRecord;
            return value?.version === 1 && value.id === sessionId ? value : undefined;
        } catch {
            return undefined;
        }
    }

    list(source?: ChildAgentRecord['source']): ChildAgentRecord[] {
        const records: ChildAgentRecord[] = [];
        for (const meta of this.sessions.listMetadata({ kind: 'child' })) {
            const record = this.get(meta.id);
            if (!record || (source && record.source !== source)) continue;
            records.push(record);
        }
        return records.sort((a, b) => b.startTime - a.startTime);
    }

    update(sessionId: string, patch: Partial<Omit<ChildAgentRecord, 'id' | 'version'>>): ChildAgentRecord {
        const existing = this.require(sessionId);
        const updated: ChildAgentRecord = { ...existing, ...patch, id: existing.id, version: 1 };
        this.write(updated);
        return updated;
    }

    appendMessage(
        sessionId: string,
        message: Omit<ChildAgentMessage, 'id' | 'timestamp' | 'read'> & Partial<Pick<ChildAgentMessage, 'id' | 'timestamp' | 'read'>>,
        persistForModel: boolean = false,
    ): ChildAgentMessage {
        const record = this.require(sessionId);
        const full: ChildAgentMessage = {
            id: message.id || randomUUID().slice(0, 8),
            from: message.from,
            to: message.to,
            content: message.content,
            timestamp: message.timestamp || Date.now(),
            read: message.read ?? false,
        };
        record.messages.push(full);
        this.write(record);

        if (persistForModel) {
            this.sessions.addMessage(sessionId, {
                role: full.from === record.agentId ? 'assistant' : 'user',
                content: full.content,
                metadata: {
                    internal: true,
                    childAgentMessageId: full.id,
                    from: full.from,
                    to: full.to,
                },
            });
        }
        return full;
    }

    appendConversationTurn(sessionId: string, request: string, output?: string): void {
        const record = this.require(sessionId);
        this.appendMessage(sessionId, {
            from: 'requester',
            to: record.agentId,
            content: request,
        }, true);
        if (output) {
            this.appendMessage(sessionId, {
                from: record.agentId,
                to: 'requester',
                content: output,
            }, true);
        }
    }

    getMessages(sessionId: string, markAsRead: boolean = false): ChildAgentMessage[] {
        const record = this.get(sessionId);
        if (!record) return [];
        if (markAsRead && record.messages.some((message) => !message.read)) {
            record.messages = record.messages.map((message) => ({ ...message, read: true }));
            this.write(record);
        }
        return record.messages.map((message) => ({ ...message }));
    }

    /** Mark runs left behind by a previous process as interrupted. */
    recoverInterruptedRuns(source?: ChildAgentRecord['source']): void {
        for (const record of this.list(source)) {
            if (record.status !== 'running') continue;
            this.update(record.id, {
                status: 'interrupted',
                endTime: Date.now(),
                error: record.error || 'Gateway restarted while child agent was running',
            });
        }
    }

    private require(sessionId: string): ChildAgentRecord {
        const record = this.get(sessionId);
        if (!record) throw new Error(`Child session does not exist: ${sessionId}`);
        return record;
    }

    private getFilePath(sessionId: string): string {
        return join(this.sessions.getStorePath(), `${safeFileStem(sessionId)}.child.json`);
    }

    private write(record: ChildAgentRecord): void {
        const filePath = this.getFilePath(record.id);
        mkdirSync(dirname(filePath), { recursive: true });
        const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
        writeFileSync(tempPath, JSON.stringify(record, null, 2), 'utf-8');
        renameSync(tempPath, filePath);
    }
}

let defaultStore: ChildAgentStore | null = null;
let defaultStorePath: string | null = null;

export function getDefaultChildAgentStore(): ChildAgentStore {
    const sessions = getActiveSessionStore() || getDefaultSessionStore();
    if (!defaultStore || defaultStorePath !== sessions.getStorePath()) {
        defaultStore = new ChildAgentStore(sessions);
        defaultStorePath = sessions.getStorePath();
    }
    return defaultStore;
}
