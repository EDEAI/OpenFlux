/**
 * 会话存储管理器
 */

import { randomUUID } from 'crypto';
import type { SessionMessage, SessionMetadata, SessionListItem, SessionStoreConfig, ToolLog, SessionArtifact } from './types';
import {
    getDefaultStorePath,
    createSession,
    readSessionMessages,
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
 * 会话存储管理器
 */
export class SessionStore {
    private config: SessionStoreConfig;
    private logger = new Logger('SessionStore');

    constructor(config?: Partial<SessionStoreConfig>) {
        // 如果指定了 storePath，则在其下创建 sessions 子目录
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
     * 创建新会话
     */
    create(agentId: string, title?: string, cloudChatroomId?: number, cloudAgentName?: string): SessionMetadata {
        const session = createSession(agentId, title, this.config.storePath, cloudChatroomId, cloudAgentName);
        this.logger.info(`创建会话: ${session.id} (agent: ${agentId}${cloudChatroomId ? `, cloud: ${cloudAgentName}` : ''})`);
        return session;
    }

    /**
     * 获取会话元数据
     */
    get(sessionId: string): SessionMetadata | null {
        return readSessionMetadata(sessionId, this.config.storePath);
    }

    /**
     * 添加消息
     */
    addMessage(sessionId: string, message: Omit<SessionMessage, 'id' | 'createdAt'>): SessionMessage {
        const fullMessage: SessionMessage = {
            id: randomUUID(),
            createdAt: Date.now(),
            ...message,
        };

        appendSessionMessage(sessionId, fullMessage, this.config.storePath);

        // 更新元数据
        const meta = this.get(sessionId);
        if (meta) {
            const updates: Partial<SessionMetadata> = {
                messageCount: meta.messageCount + 1,
                lastMessagePreview: getMessagePreview(fullMessage),
            };

            // 自动标题生成：助手回复 + 会话无有效标题时触发
            // 放宽 messageCount 条件（<= 2），覆盖 cloud/local/router 各种边界情况
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
     * 从用户输入生成会话标题
     */
    private generateTitle(userInput: string): string {
        // 移除多余空白，取前 30 个字符
        const cleaned = userInput.replace(/\s+/g, ' ').trim();
        if (cleaned.length <= 30) {
            return cleaned;
        }
        return cleaned.slice(0, 27) + '...';
    }

    /**
     * 获取消息历史
     */
    getMessages(sessionId: string): SessionMessage[] {
        return readSessionMessages(sessionId, this.config.storePath);
    }

    /**
     * 获取最近消息
     */
    getRecentMessages(sessionId: string, count: number = 10): SessionMessage[] {
        const messages = this.getMessages(sessionId);
        return messages.slice(-count);
    }

    /**
     * 列出会话
     */
    list(agentId?: string): SessionListItem[] {
        return listSessions(this.config.storePath, agentId);
    }

    /**
     * 归档会话
     */
    archive(sessionId: string): void {
        archiveSession(sessionId, this.config.storePath);
        this.logger.info(`归档会话: ${sessionId}`);
    }

    /**
     * 删除会话
     */
    delete(sessionId: string): void {
        deleteSession(sessionId, this.config.storePath);
        this.logger.info(`删除会话: ${sessionId}`);
    }

    /**
     * 更新会话标题
     */
    updateTitle(sessionId: string, title: string): void {
        updateSessionMetadata(sessionId, { title }, this.config.storePath);
    }

    /**
     * 获取或创建会话
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
     * 添加工具调用日志
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
     * 获取工具调用日志
     */
    getLogs(sessionId: string): ToolLog[] {
        return readSessionLogs(sessionId, this.config.storePath);
    }

    /**
     * 清空工具调用日志
     */
    clearLogs(sessionId: string): void {
        clearSessionLogs(sessionId, this.config.storePath);
        this.logger.debug(`清空日志: ${sessionId}`);
    }

    /**
     * 添加成果物
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
     * 获取成果物列表
     */
    getArtifacts(sessionId: string): SessionArtifact[] {
        return readSessionArtifacts(sessionId, this.config.storePath);
    }

    /**
     * 清空成果物
     */
    clearArtifacts(sessionId: string): void {
        clearSessionArtifacts(sessionId, this.config.storePath);
        this.logger.debug(`清空成果物: ${sessionId}`);
    }
}

// 默认实例
let defaultStore: SessionStore | null = null;

export function getDefaultSessionStore(): SessionStore {
    if (!defaultStore) {
        defaultStore = new SessionStore();
    }
    return defaultStore;
}
