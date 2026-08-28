/**
 * Session Storage Manager
 */

import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { resolve } from 'path';
import type { SessionMessage, SessionMetadata, SessionListItem, SessionStoreConfig, ToolLog, SessionArtifact } from './types';
import type { AgentRuntimeEvent } from '../runtime/events';
import {
    getDefaultStorePath,
    createSession,
    readSessionMessages,
    readRecentSessionMessages,
    appendSessionMessage,
    readSessionMetadata,
    updateSessionMetadata,
    listSessions,
    listSessionMetadata,
    archiveSession,
    deleteSession,
    getMessagePreview,
    readSessionLogs,
    appendSessionLog,
    clearSessionLogs,
    readSessionArtifacts,
    appendSessionArtifact,
    clearSessionArtifacts,
    appendSessionEvent,
    readSessionEvents,
    readRecentSessionEvents,
} from './transcript';
import { Logger } from '../utils/logger';
import type { ApprovalMode } from '../permissions/checker';

let activeSessionStore: SessionStore | null = null;

/**
 * Internal runtime messages are persisted so the parent agent can consume
 * collaboration results, but they are not part of the user-facing transcript.
 * The content-prefix check keeps histories written by older Gateway builds
 * hidden even though those messages do not carry metadata yet.
 */
export function isInternalSessionMessage(
    message: Pick<SessionMessage, 'content' | 'metadata'>,
): boolean {
    const metadata = message.metadata;
    if (metadata?.internal === true
        || metadata?.visibility === 'internal'
        || metadata?.kind === 'collaboration_announce') {
        return true;
    }

    return typeof message.content === 'string'
        && /^\[Collaboration(?:\s+Announce)?\]\s*/i.test(message.content);
}

/**
 * Session Storage Manager
 */
export class SessionStore {
    private config: SessionStoreConfig;
    private logger = new Logger('SessionStore');

    constructor(config?: Partial<SessionStoreConfig>) {
        // If storePath is specified, creates the sessions subdirectory under it
        const basePath = config?.storePath || getDefaultStorePath();
        const sessionsPath = basePath.endsWith('sessions') ? basePath : `${basePath}/sessions`;

        this.config = {
            storePath: sessionsPath,
            maxMessages: config?.maxMessages || 10000,
            autoArchive: config?.autoArchive ?? true,
        };

        this.logger.info(`会话存储初始化: ${this.config.storePath}`);
        activeSessionStore = this;
    }

    /**
     * Create new session
     */
    create(
        agentId: string,
        title?: string,
        cloudChatroomId?: number,
        cloudAgentName?: string,
        customSessionId?: string,
        approvalMode?: ApprovalMode,
    ): SessionMetadata {
        const session = createSession(
            agentId,
            title,
            this.config.storePath,
            cloudChatroomId,
            cloudAgentName,
            customSessionId,
            approvalMode,
        );
        this.logger.info(`创建会话: ${session.id} (agent: ${agentId}${cloudChatroomId ? `, cloud: ${cloudAgentName}` : ''})`);
        return session;
    }

    /** Create a hidden, durable session owned by a child agent. */
    createChild(options: {
        id: string;
        agentId: string;
        title?: string;
        parentSessionId?: string;
        parentTurnId?: string;
        rootSessionId?: string;
    }): SessionMetadata {
        const existing = this.get(options.id);
        if (existing) return existing;

        createSession(
            options.agentId,
            options.title,
            this.config.storePath,
            undefined,
            undefined,
            options.id,
        );
        updateSessionMetadata(options.id, {
            schemaVersion: 1,
            kind: 'child',
            visibility: 'hidden',
            parentSessionId: options.parentSessionId,
            parentTurnId: options.parentTurnId,
            rootSessionId: options.rootSessionId || options.parentSessionId || options.id,
        }, this.config.storePath);
        return this.get(options.id)!;
    }

    /**
     * Get session metadata
     */
    get(sessionId: string): SessionMetadata | null {
        return readSessionMetadata(sessionId, this.config.storePath);
    }

    /**
     * Add message
     */
    addMessage(sessionId: string, message: Omit<SessionMessage, 'id' | 'createdAt'>): SessionMessage {
        const fullMessage: SessionMessage = {
            id: randomUUID(),
            createdAt: Date.now(),
            ...message,
        };

        appendSessionMessage(sessionId, fullMessage, this.config.storePath);

        // Update metadata
        const meta = this.get(sessionId);
        const internal = isInternalSessionMessage(fullMessage);
        if (meta && !internal) {
            const updates: Partial<SessionMetadata> = {
                messageCount: meta.messageCount + 1,
                lastMessagePreview: getMessagePreview(fullMessage),
            };

            // Automatic title generation: triggered when assistant reply + conversation has no valid title
            // Relax the messageCount condition (<= 2) to cover various edge cases of cloud/local/router
            const needsTitle = !meta.title || meta.title === '新会话';
            if (message.role === 'assistant' && meta.messageCount <= 2 && needsTitle) {
                this.logger.info(`标题生成触发`, {
                    sessionId: sessionId.slice(0, 8),
                    messageCount: meta.messageCount,
                    currentTitle: meta.title,
                });
                const messages = this.getVisibleMessages(sessionId);
                const firstUserMessage = messages.find(m => m.role === 'user');
                if (firstUserMessage && typeof firstUserMessage.content === 'string') {
                    updates.title = this.generateTitle(firstUserMessage.content);
                    this.logger.info(`标题已生成: "${updates.title}"`);
                } else {
                    this.logger.warn(`标题生成失败: 未找到用户消息`, {
                        totalMessages: messages.length,
                        roles: messages.map(m => m.role),
                    });
                }
            }

            updateSessionMetadata(sessionId, updates, this.config.storePath);
        } else if (!meta) {
            this.logger.warn(`addMessage: 元数据不存在`, { sessionId: sessionId.slice(0, 8) });
        }

        this.logger.debug(`添加消息: ${sessionId} (${message.role})`);
        return fullMessage;
    }

    /**
     * Generate session title from user input
     */
    private generateTitle(userInput: string): string {
        // Remove excess whitespace and take first 30 characters
        const cleaned = userInput.replace(/\s+/g, ' ').trim();
        if (cleaned.length <= 30) {
            return cleaned;
        }
        return cleaned.slice(0, 27) + '...';
    }

    /**
     * Get message history (full amount, for UI display)
     */
    getMessages(sessionId: string): SessionMessage[] {
        return readSessionMessages(sessionId, this.config.storePath);
    }

    /** Get only messages that belong in the user-facing conversation. */
    getVisibleMessages(sessionId: string): SessionMessage[] {
        return this.getMessages(sessionId).filter(message => !isInternalSessionMessage(message));
    }

    /**
     * Efficiently obtain the latest N messages (without reading the entire file, for LLM context construction)
     */
    getRecentMessages(sessionId: string, count: number = 100): SessionMessage[] {
        return readRecentSessionMessages(sessionId, count, this.config.storePath);
    }

    /**
     * Get the latest news (for a small amount of display)
     */
    getRecentN(sessionId: string, count: number = 10): SessionMessage[] {
        return readRecentSessionMessages(sessionId, count, this.config.storePath);
    }

    /**
     * Get messages in pages (for lazy loading)
     * offset counts down from the end: offset=0 -> the latest limit bar; offset=20 -> the previous limit bar
     * Return { messages, total, hasMore }
     */
    getMessagesPage(sessionId: string, limit: number, offset: number = 0): {
        messages: SessionMessage[];
        total: number;
        hasMore: boolean;
    } {
        const all = readSessionMessages(sessionId, this.config.storePath);
        const total = all.length;
        const end = Math.max(0, total - offset);
        const start = Math.max(0, end - limit);
        const messages = all.slice(start, end);
        return { messages, total, hasMore: start > 0 };
    }

    /**
     * Page through the user-facing transcript. Filtering before slicing keeps
     * offsets, totals, and hasMore stable when many internal notices are next
     * to each other in an older session.
     */
    getVisibleMessagesPage(sessionId: string, limit: number, offset: number = 0): {
        messages: SessionMessage[];
        total: number;
        hasMore: boolean;
    } {
        const all = this.getVisibleMessages(sessionId);
        const total = all.length;
        const end = Math.max(0, total - offset);
        const start = Math.max(0, end - limit);
        const messages = all.slice(start, end);
        return { messages, total, hasMore: start > 0 };
    }

    /**
     * list sessions
     */
    list(agentId?: string, options?: { includeHidden?: boolean }): SessionListItem[] {
        return listSessions(this.config.storePath, agentId, options?.includeHidden ?? false);
    }

    /** Full metadata view used by runtime stores; normal UI code should use list(). */
    listMetadata(options?: {
        includeDeleted?: boolean;
        kind?: SessionMetadata['kind'];
        parentSessionId?: string;
    }): SessionMetadata[] {
        return listSessionMetadata(this.config.storePath, options);
    }

    updateMetadata(sessionId: string, updates: Partial<SessionMetadata>): SessionMetadata | null {
        updateSessionMetadata(sessionId, updates, this.config.storePath);
        return this.get(sessionId);
    }

    getStorePath(): string {
        return this.config.storePath;
    }

    /**
     * Archive session
     */
    archive(sessionId: string): void {
        archiveSession(sessionId, this.config.storePath);
        this.logger.info(`归档会话: ${sessionId}`);
    }

    /**
     * Delete session
     */
    delete(sessionId: string): void {
        deleteSession(sessionId, this.config.storePath);
        this.logger.info(`删除会话: ${sessionId}`);
    }

    /**
     * Update session title
     */
    updateTitle(sessionId: string, title: string): void {
        updateSessionMetadata(sessionId, { title }, this.config.storePath);
    }

    /**
     * Update the owning agent of a session (multi-session grouping)
     */
    updateAgentId(sessionId: string, agentId: string): void {
        updateSessionMetadata(sessionId, { agentId }, this.config.storePath);
    }

    /**
     * Get or create a session
     */
    getOrCreate(sessionId: string | undefined, agentId: string): SessionMetadata {
        if (sessionId) {
            const existing = this.get(sessionId);
            if (existing && existing.status === 'active') {
                return existing;
            }
        }
        return this.create(agentId);
    }

    /**
     * Add tool call log
     */
    addLog(sessionId: string, log: Omit<ToolLog, 'id' | 'timestamp'>): ToolLog {
        const fullLog: ToolLog = {
            id: randomUUID(),
            timestamp: Date.now(),
            ...log,
        };
        appendSessionLog(sessionId, fullLog, this.config.storePath);
        this.logger.debug(`添加日志: ${sessionId} (${log.tool})`);
        return fullLog;
    }

    /**
     * Get tool call log
     */
    getLogs(sessionId: string): ToolLog[] {
        return readSessionLogs(sessionId, this.config.storePath);
    }

    /**
     * Clear tool call log
     */
    clearLogs(sessionId: string): void {
        clearSessionLogs(sessionId, this.config.storePath);
        this.logger.debug(`清空日志: ${sessionId}`);
    }

    /**
     * Add fruits
     */
    addArtifact(sessionId: string, artifact: Omit<SessionArtifact, 'id'>): SessionArtifact {
        if (artifact.type === 'file' && artifact.path) {
            const normalizedPath = resolve(artifact.path).replace(/\\/g, '/').toLowerCase();
            const existing = readSessionArtifacts(sessionId, this.config.storePath).find(candidate => (
                candidate.type === 'file'
                && candidate.path
                && resolve(candidate.path).replace(/\\/g, '/').toLowerCase() === normalizedPath
            ));
            if (existing) return existing;
        }
        const fullArtifact: SessionArtifact = {
            id: randomUUID(),
            ...artifact,
        };
        appendSessionArtifact(sessionId, fullArtifact, this.config.storePath);
        this.logger.debug(`添加成果物: ${sessionId} (${artifact.type})`);
        return fullArtifact;
    }

    /**
     * Get a list of achievements
     */
    getArtifacts(sessionId: string): SessionArtifact[] {
        const artifacts = readSessionArtifacts(sessionId, this.config.storePath);
        // Filter out artifacts whose files have been deleted (solve the timing problem that is still displayed after the temporary script is deleted)
        return artifacts.filter(a => {
            if (a.type === 'file' && a.path) {
                try { return existsSync(a.path); } catch { return true; }
            }
            return true; // Non-file type artifacts reserved
        });
    }

    /**
     * Empty the fruits
     */
    clearArtifacts(sessionId: string): void {
        clearSessionArtifacts(sessionId, this.config.storePath);
        this.logger.debug(`清空成果物: ${sessionId}`);
    }

    /** Append one canonical runtime event before it is broadcast to clients. */
    addEvent(sessionId: string, event: AgentRuntimeEvent): AgentRuntimeEvent {
        appendSessionEvent(sessionId, event, this.config.storePath);
        return event;
    }

    getEvents(sessionId: string): AgentRuntimeEvent[] {
        return readSessionEvents(sessionId, this.config.storePath);
    }

    getRecentEvents(sessionId: string, count: number = 500): AgentRuntimeEvent[] {
        return readRecentSessionEvents(sessionId, count, this.config.storePath);
    }
}

// default instance
let defaultStore: SessionStore | null = null;

export function getDefaultSessionStore(): SessionStore {
    if (!defaultStore) {
        defaultStore = new SessionStore();
    }
    return defaultStore;
}

/** The workspace SessionStore most recently initialized by the application. */
export function getActiveSessionStore(): SessionStore | null {
    return activeSessionStore;
}
