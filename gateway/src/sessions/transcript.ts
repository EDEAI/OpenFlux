/**
 * 会话转录 - JSONL 格式读写
 * 参考 Clawdbot session-utils.fs.ts
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, statSync, renameSync } from 'fs';
import { dirname, join, basename } from 'path';
import { homedir } from 'os';
import type { SessionEntry, SessionMessage, SessionMetadata, SessionListItem, ToolLog, SessionArtifact } from './types';
import { randomUUID } from 'crypto';

/**
 * 默认存储路径
 */
export function getDefaultStorePath(): string {
    return join(homedir(), '.openflux', 'sessions');
}

/**
 * 确保目录存在
 */
function ensureDir(dirPath: string): void {
    if (!existsSync(dirPath)) {
        mkdirSync(dirPath, { recursive: true });
    }
}

/**
 * 将 Session Key 转换为文件系统安全的名称
 * agent:coder:main → agent_coder_main
 * (Windows 不允许 : 出现在文件名中)
 */
function sanitizeSessionId(sessionId: string): string {
    return sessionId.replace(/:/g, '_');
}

/**
 * 获取会话文件路径
 */
export function getSessionFilePath(sessionId: string, storePath?: string): string {
    const base = storePath || getDefaultStorePath();
    return join(base, `${sanitizeSessionId(sessionId)}.jsonl`);
}

/**
 * 获取元数据文件路径
 */
export function getMetadataFilePath(sessionId: string, storePath?: string): string {
    const base = storePath || getDefaultStorePath();
    return join(base, `${sanitizeSessionId(sessionId)}.meta.json`);
}

/**
 * 读取会话消息
 */
export function readSessionMessages(sessionId: string, storePath?: string): SessionMessage[] {
    const filePath = getSessionFilePath(sessionId, storePath);
    if (!existsSync(filePath)) return [];

    const lines = readFileSync(filePath, 'utf-8').split(/\r?\n/);
    const messages: SessionMessage[] = [];

    for (const line of lines) {
        if (!line.trim()) continue;
        try {
            const entry = JSON.parse(line) as SessionEntry;
            if (entry?.message) {
                messages.push(entry.message);
            }
        } catch {
            // 跳过无效行
        }
    }

    return messages;
}

/**
 * 追加消息到会话
 */
export function appendSessionMessage(
    sessionId: string,
    message: SessionMessage,
    storePath?: string,
): void {
    const filePath = getSessionFilePath(sessionId, storePath);
    ensureDir(dirname(filePath));

    const entry: SessionEntry = {
        ts: Date.now(),
        message,
    };

    appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8');
}

/**
 * 创建新会话
 */
export function createSession(
    agentId: string,
    title?: string,
    storePath?: string,
    cloudChatroomId?: number,
    cloudAgentName?: string,
    customSessionId?: string,
): SessionMetadata {
    const sessionId = customSessionId || randomUUID();
    const now = Date.now();

    const metadata: SessionMetadata = {
        id: sessionId,
        agentId,
        title,
        createdAt: now,
        updatedAt: now,
        messageCount: 0,
        status: 'active',
        ...(cloudChatroomId ? { cloudChatroomId, cloudAgentName } : {}),
    };

    // 保存元数据
    const metaPath = getMetadataFilePath(sessionId, storePath);
    ensureDir(dirname(metaPath));
    writeFileSync(metaPath, JSON.stringify(metadata, null, 2), 'utf-8');

    // 创建空的会话文件
    const sessionPath = getSessionFilePath(sessionId, storePath);
    writeFileSync(sessionPath, '', 'utf-8');

    return metadata;
}

/**
 * 读取会话元数据
 */
export function readSessionMetadata(sessionId: string, storePath?: string): SessionMetadata | null {
    const metaPath = getMetadataFilePath(sessionId, storePath);
    if (!existsSync(metaPath)) return null;

    try {
        return JSON.parse(readFileSync(metaPath, 'utf-8'));
    } catch {
        return null;
    }
}

/**
 * 更新会话元数据
 */
export function updateSessionMetadata(
    sessionId: string,
    updates: Partial<SessionMetadata>,
    storePath?: string,
): void {
    const existing = readSessionMetadata(sessionId, storePath);
    if (!existing) return;

    const updated: SessionMetadata = {
        ...existing,
        ...updates,
        updatedAt: Date.now(),
    };

    const metaPath = getMetadataFilePath(sessionId, storePath);
    writeFileSync(metaPath, JSON.stringify(updated, null, 2), 'utf-8');
}

/**
 * 列出所有会话
 */
export function listSessions(storePath?: string, agentId?: string): SessionListItem[] {
    const base = storePath || getDefaultStorePath();
    if (!existsSync(base)) return [];

    const files = readdirSync(base).filter((f) => f.endsWith('.meta.json'));
    const sessions: SessionListItem[] = [];

    for (const file of files) {
        try {
            const metaPath = join(base, file);
            const meta: SessionMetadata = JSON.parse(readFileSync(metaPath, 'utf-8'));

            if (meta.status === 'deleted') continue;
            if (agentId && meta.agentId !== agentId) continue;

            sessions.push({
                id: meta.id,
                agentId: meta.agentId,
                title: meta.title,
                updatedAt: meta.updatedAt,
                messageCount: meta.messageCount,
                lastMessagePreview: meta.lastMessagePreview,
                cloudChatroomId: meta.cloudChatroomId,
                cloudAgentName: meta.cloudAgentName,
            });
        } catch {
            // 跳过无效文件
        }
    }

    // 按更新时间倒序
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * 归档会话
 */
export function archiveSession(sessionId: string, storePath?: string): void {
    updateSessionMetadata(sessionId, { status: 'archived' }, storePath);
}

/**
 * 删除会话（软删除）
 */
export function deleteSession(sessionId: string, storePath?: string): void {
    updateSessionMetadata(sessionId, { status: 'deleted' }, storePath);
}

/**
 * 读取最后几条消息（用于预览）
 */
export function readLastMessages(
    sessionId: string,
    count: number = 5,
    storePath?: string,
): SessionMessage[] {
    const messages = readSessionMessages(sessionId, storePath);
    return messages.slice(-count);
}

/**
 * 获取消息预览文本
 */
export function getMessagePreview(message: SessionMessage, maxLength: number = 100): string {
    let text = '';
    if (typeof message.content === 'string') {
        text = message.content;
    } else if (Array.isArray(message.content)) {
        const textBlock = message.content.find((b) => b.type === 'text');
        text = textBlock?.text || '';
    }

    if (text.length > maxLength) {
        return text.slice(0, maxLength - 3) + '...';
    }
    return text;
}

/**
 * 获取日志文件路径
 */
export function getLogsFilePath(sessionId: string, storePath?: string): string {
    const base = storePath || getDefaultStorePath();
    return join(base, `${sanitizeSessionId(sessionId)}.logs.json`);
}

/**
 * 读取会话日志
 */
export function readSessionLogs(sessionId: string, storePath?: string): ToolLog[] {
    const logsPath = getLogsFilePath(sessionId, storePath);
    if (!existsSync(logsPath)) return [];

    try {
        const data = readFileSync(logsPath, 'utf-8');
        return JSON.parse(data) as ToolLog[];
    } catch {
        return [];
    }
}

/**
 * 追加日志
 */
export function appendSessionLog(sessionId: string, log: ToolLog, storePath?: string): void {
    const logsPath = getLogsFilePath(sessionId, storePath);
    ensureDir(dirname(logsPath));

    const logs = readSessionLogs(sessionId, storePath);
    logs.push(log);
    writeFileSync(logsPath, JSON.stringify(logs, null, 2), 'utf-8');
}

/**
 * 清空会话日志
 */
export function clearSessionLogs(sessionId: string, storePath?: string): void {
    const logsPath = getLogsFilePath(sessionId, storePath);
    if (existsSync(logsPath)) {
        writeFileSync(logsPath, '[]', 'utf-8');
    }
}

// ========== 成果物持久化 ==========

/**
 * 获取成果物文件路径
 */
export function getArtifactsFilePath(sessionId: string, storePath?: string): string {
    const base = storePath || getDefaultStorePath();
    return join(base, `${sanitizeSessionId(sessionId)}.artifacts.json`);
}

/**
 * 读取会话成果物
 */
export function readSessionArtifacts(sessionId: string, storePath?: string): SessionArtifact[] {
    const filePath = getArtifactsFilePath(sessionId, storePath);
    if (!existsSync(filePath)) return [];

    try {
        const data = readFileSync(filePath, 'utf-8');
        return JSON.parse(data) as SessionArtifact[];
    } catch {
        return [];
    }
}

/**
 * 追加成果物
 */
export function appendSessionArtifact(sessionId: string, artifact: SessionArtifact, storePath?: string): void {
    const filePath = getArtifactsFilePath(sessionId, storePath);
    ensureDir(dirname(filePath));

    const artifacts = readSessionArtifacts(sessionId, storePath);
    artifacts.push(artifact);
    writeFileSync(filePath, JSON.stringify(artifacts, null, 2), 'utf-8');
}

/**
 * 清空会话成果物
 */
export function clearSessionArtifacts(sessionId: string, storePath?: string): void {
    const filePath = getArtifactsFilePath(sessionId, storePath);
    if (existsSync(filePath)) {
        writeFileSync(filePath, '[]', 'utf-8');
    }
}
