/**
 * 会话类型定义
 * 参考 Clawdbot session-utils.types.ts
 */

/**
 * 消息角色
 */
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

/**
 * 消息内容块
 */
export interface ContentBlock {
    type: 'text' | 'image' | 'tool_call' | 'tool_result';
    text?: string;
    data?: string;
    mimeType?: string;
    toolName?: string;
    toolCallId?: string;
    result?: unknown;
}

/**
 * 会话消息附件（持久化用）
 */
export interface SessionMessageAttachment {
    path: string;
    name: string;
    ext: string;
    size: number;
}

/**
 * 会话消息
 */
export interface SessionMessage {
    id: string;
    role: MessageRole;
    content: string | ContentBlock[];
    createdAt: number;
    metadata?: Record<string, unknown>;
    /** 用户消息携带的文件/图片附件 */
    attachments?: SessionMessageAttachment[];
}

/**
 * 会话条目（存储在 JSONL 中）
 */
export interface SessionEntry {
    ts: number;
    message: SessionMessage;
}

/**
 * 会话元数据
 */
export interface SessionMetadata {
    id: string;
    agentId: string;
    title?: string;
    createdAt: number;
    updatedAt: number;
    messageCount: number;
    lastMessagePreview?: string;
    status: 'active' | 'archived' | 'deleted';
    /** 云端聊天室 ID（非零表示云端会话） */
    cloudChatroomId?: number;
    /** 云端 Agent 名称 */
    cloudAgentName?: string;
}

/**
 * 会话列表项
 */
export interface SessionListItem {
    id: string;
    agentId: string;
    title?: string;
    updatedAt: number;
    messageCount: number;
    lastMessagePreview?: string;
    cloudChatroomId?: number;
    cloudAgentName?: string;
}

/**
 * 会话存储配置
 */
export interface SessionStoreConfig {
    /** 存储目录 */
    storePath: string;
    /** 最大消息数 */
    maxMessages?: number;
    /** 是否自动归档 */
    autoArchive?: boolean;
}

/**
 * 工具调用日志
 */
export interface ToolLog {
    id: string;
    timestamp: number;
    tool: string;
    action?: string;
    args?: Record<string, unknown>;
    success: boolean;
}

/**
 * 会话成果物
 */
export interface SessionArtifact {
    id: string;
    type: 'file' | 'code' | 'output';
    path?: string;
    filename?: string;
    content?: string;
    language?: string;
    size?: number;
    timestamp: number;
}
