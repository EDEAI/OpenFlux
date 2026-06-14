/**
 * Session Storage Manager
 */

import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import type { SessionMessage, SessionMetadata, SessionListItem, SessionStoreConfig, ToolLog, SessionArtifact } from './types';
import {
    getDefaultStorePath,
    createSession,
    readSessionMessages,
    readRecentSessionMessages,
    appendSessionMessage,
    readSessionMetadata,
    updateSessionMetadata,
    listSessions,
    archiveSession,
    deleteSession,
    getMessagePreview,
    readSessionLogs,
    appendSessionLog,
    clearSessionLogs,
    readSessionArtifacts,
    appendSessionArtifact,
    clearSessionArtifacts,
} from './transcript';
import { Logger } from '../utils/logger';

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
    }

    /**
     * Create new session
     */
    create(agentId: string, title?: string, cloudChatroomId?: number, cloudAgentName?: string, customSessionId?: string): SessionMetadata {
        const session = createSession(agentId, title, this.config.storePath, cloudChatroomId, cloudAgentName, customSessionId);
        this.logger.info(`创建会话: ${session.id} (agent: ${agentId}${cloudChatroomId ? `, cloud: ${cloudAgentName}` : ''})`);
        return session;
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
        if (meta) {
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
                const messages = this.getMessages(sessionId);
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
        } else {
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
     * list sessions
     */
    list(agentId?: string): SessionListItem[] {
        return listSessions(this.config.storePath, agentId);
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
}

// default instance
let defaultStore: SessionStore | null = null;

export function getDefaultSessionStore(): SessionStore {
    if (!defaultStore) {
        defaultStore = new SessionStore();
    }
    return defaultStore;
}
