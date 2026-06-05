/**
 * Session type definition
 * Reference Clawdbot session-utils.types.ts
 */

/**
 * message role
 */
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

/**
 * message content block
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
 * Session message attachments (for persistence)
 */
export interface SessionMessageAttachment {
    path: string;
    name: string;
    ext: string;
    size: number;
}

/**
 * Conversation message
 */
export interface SessionMessage {
    id: string;
    role: MessageRole;
    content: string | ContentBlock[];
    createdAt: number;
    metadata?: Record<string, unknown>;
    /** File/picture attachments carried by user messages */
    attachments?: SessionMessageAttachment[];
}

/**
 * Session entries (stored in JSONL)
 */
export interface SessionEntry {
    ts: number;
    message: SessionMessage;
}

/**
 * session metadata
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
    /** Cloud chat room ID (non-zero indicates cloud session) */
    cloudChatroomId?: number;
    /** Cloud Agent name */
    cloudAgentName?: string;
}

/**
 * Conversation list items
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
 * Session storage configuration
 */
export interface SessionStoreConfig {
    /** Storage directory */
    storePath: string;
    /** Maximum number of messages */
    maxMessages?: number;
    /** Whether to automatically archive */
    autoArchive?: boolean;
}

/**
 * Tool call log
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
 * Conversation products
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
