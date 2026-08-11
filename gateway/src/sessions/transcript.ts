/**
 * Conversation Transcription - JSONL format reading and writing
 * Reference Clawdbot session-utils.fs.ts
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, statSync, renameSync, openSync, fstatSync, readSync, closeSync } from 'fs';
import { dirname, join, basename } from 'path';
import { homedir } from 'os';
import type { SessionEntry, SessionMessage, SessionMetadata, SessionListItem, ToolLog, SessionArtifact } from './types';
import type { AgentRuntimeEvent } from '../runtime/events';
import { randomUUID } from 'crypto';
import { DEFAULT_APPROVAL_MODE, normalizeApprovalMode, type ApprovalMode } from '../permissions/checker';

/**
 * Default storage path
 */
export function getDefaultStorePath(): string {
    return join(homedir(), '.openflux', 'sessions');
}

/**
 * Make sure the directory exists
 */
function ensureDir(dirPath: string): void {
    if (!existsSync(dirPath)) {
        mkdirSync(dirPath, { recursive: true });
    }
}

/**
 * Convert the Session Key to a file system-safe name
 * agent:coder:main → agent_coder_main
 * (Windows does not allow: to appear in file names)
 */
function sanitizeSessionId(sessionId: string): string {
    return sessionId.replace(/:/g, '_');
}

/**
 * Get session file path
 */
export function getSessionFilePath(sessionId: string, storePath?: string): string {
    const base = storePath || getDefaultStorePath();
    return join(base, `${sanitizeSessionId(sessionId)}.jsonl`);
}

/**
 * Get metadata file path
 */
export function getMetadataFilePath(sessionId: string, storePath?: string): string {
    const base = storePath || getDefaultStorePath();
    return join(base, `${sanitizeSessionId(sessionId)}.meta.json`);
}

/** Runtime events are kept separate so message tail reads remain exact. */
export function getEventsFilePath(sessionId: string, storePath?: string): string {
    const base = storePath || getDefaultStorePath();
    return join(base, `${sanitizeSessionId(sessionId)}.events.jsonl`);
}

export function appendSessionEvent(
    sessionId: string,
    event: AgentRuntimeEvent,
    storePath?: string,
): void {
    const filePath = getEventsFilePath(sessionId, storePath);
    ensureDir(dirname(filePath));
    appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf-8');
}

export function readSessionEvents(sessionId: string, storePath?: string): AgentRuntimeEvent[] {
    const filePath = getEventsFilePath(sessionId, storePath);
    if (!existsSync(filePath)) return [];
    const events: AgentRuntimeEvent[] = [];
    for (const line of readFileSync(filePath, 'utf-8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
            const event = JSON.parse(line) as AgentRuntimeEvent;
            if (event?.version === 1 && event.sessionId && event.turnId) events.push(event);
        } catch {
            // A process crash may leave a partial final line. Earlier events remain recoverable.
        }
    }
    return events;
}

export function readRecentSessionEvents(
    sessionId: string,
    count: number,
    storePath?: string,
): AgentRuntimeEvent[] {
    const filePath = getEventsFilePath(sessionId, storePath);
    // Read a small reserve so a crash-corrupted tail row does not displace the
    // most recent valid event requested by the caller.
    const lines = readTailJsonlLines(filePath, Math.max(count + 10, count * 2));
    const events: AgentRuntimeEvent[] = [];
    for (const line of lines) {
        try {
            const event = JSON.parse(line) as AgentRuntimeEvent;
            if (event?.version === 1 && event.sessionId && event.turnId) events.push(event);
        } catch { /* tolerate partial/corrupt rows */ }
    }
    return events.slice(-count);
}

/**
 * Read session messages
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
            // Skip invalid lines
        }
    }

    return messages;
}

/**
 * Append message to conversation
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
    // Permanently appended, not clipped. When reading, take the last N items as needed.
}

// ========================
// Efficient tail reading
// ========================

/**
 * Efficiently read the last N lines from the end of the JSONL file
 * Do not read the full text, read in chunks in reverse order from the end of the file, O(k) complexity
 */
function readTailJsonlLines(filePath: string, count: number): string[] {
    if (!existsSync(filePath)) return [];

    const fd = openSync(filePath, 'r');
    try {
        const fileSize = fstatSync(fd).size;
        if (fileSize === 0) return [];

        const CHUNK = 64 * 1024; // 64KB per read
        let position = fileSize;
        let remainder = '';
        const lines: string[] = [];

        while (position > 0 && lines.length < count) {
            const readSize = Math.min(CHUNK, position);
            position -= readSize;
            const buf = Buffer.alloc(readSize);
            readSync(fd, buf, 0, readSize, position);
            // Splicing: current block + last remaining (the head of the previous block may be the end of the previous line)
            const chunk = buf.toString('utf-8') + remainder;
            const chunkLines = chunk.split('\n');
            // The first element may be an incomplete line (belonging to the end of the previous block)
            remainder = chunkLines.shift() ?? '';
            // Only take the rows with content and insert the header in reverse order
            for (let i = chunkLines.length - 1; i >= 0; i--) {
                if (chunkLines[i].trim()) lines.unshift(chunkLines[i]);
                if (lines.length >= count) break;
            }
        }

        // Finally process the remaining (first line of file)
        if (remainder.trim() && lines.length < count) {
            lines.unshift(remainder);
        }

        return lines.slice(-count);
    } finally {
        closeSync(fd);
    }
}

/**
 * Efficiently read the latest N conversation messages (without reading the entire file)
 * Used by manager.ts to build LLM context and can be used to replace the full read operation in readSessionMessages
 */
export function readRecentSessionMessages(sessionId: string, count: number, storePath?: string): SessionMessage[] {
    const filePath = getSessionFilePath(sessionId, storePath);
    const lines = readTailJsonlLines(filePath, count);
    const messages: SessionMessage[] = [];
    for (const line of lines) {
        try {
            const entry = JSON.parse(line) as SessionEntry;
            if (entry?.message) messages.push(entry.message);
        } catch { /* Skip corrupted rows */ }
    }
    return messages;
}

/**
 * Create new session
 */
export function createSession(
    agentId: string,
    title?: string,
    storePath?: string,
    cloudChatroomId?: number,
    cloudAgentName?: string,
    customSessionId?: string,
    approvalMode: ApprovalMode = DEFAULT_APPROVAL_MODE,
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
        approvalMode: normalizeApprovalMode(approvalMode),
        ...(cloudChatroomId ? { cloudChatroomId, cloudAgentName } : {}),
    };

    // Save metadata
    const metaPath = getMetadataFilePath(sessionId, storePath);
    ensureDir(dirname(metaPath));
    writeFileSync(metaPath, JSON.stringify(metadata, null, 2), 'utf-8');

    // Create an empty session file
    const sessionPath = getSessionFilePath(sessionId, storePath);
    writeFileSync(sessionPath, '', 'utf-8');

    return metadata;
}

/**
 * Read session metadata
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
 * Update session metadata
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
 * List all sessions
 */
export function listSessions(
    storePath?: string,
    agentId?: string,
    includeHidden: boolean = false,
): SessionListItem[] {
    const base = storePath || getDefaultStorePath();
    if (!existsSync(base)) return [];

    const files = readdirSync(base).filter((f) => f.endsWith('.meta.json'));
    const sessions: SessionListItem[] = [];

    for (const file of files) {
        try {
            const metaPath = join(base, file);
            const meta: SessionMetadata = JSON.parse(readFileSync(metaPath, 'utf-8'));

            if (meta.status === 'deleted') continue;
            // Child-agent sessions are runtime implementation details.  They remain
            // addressable by id, but must not appear in the normal conversation list.
            if (!includeHidden && (meta.visibility === 'hidden' || meta.kind === 'child')) continue;
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
                approvalMode: normalizeApprovalMode(meta.approvalMode),
            });
        } catch {
            // Skip invalid files
        }
    }

    // Sort by update time in descending order
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Read full metadata records for runtime services such as the child-agent store.
 * Unlike listSessions this intentionally does not project away relationship fields.
 */
export function listSessionMetadata(
    storePath?: string,
    options?: {
        includeDeleted?: boolean;
        kind?: SessionMetadata['kind'];
        parentSessionId?: string;
    },
): SessionMetadata[] {
    const base = storePath || getDefaultStorePath();
    if (!existsSync(base)) return [];

    const records: SessionMetadata[] = [];
    for (const file of readdirSync(base).filter((name) => name.endsWith('.meta.json'))) {
        try {
            const meta = JSON.parse(readFileSync(join(base, file), 'utf-8')) as SessionMetadata;
            if (!options?.includeDeleted && meta.status === 'deleted') continue;
            if (options?.kind && meta.kind !== options.kind) continue;
            if (options?.parentSessionId && meta.parentSessionId !== options.parentSessionId) continue;
            records.push(meta);
        } catch {
            // A malformed metadata file must not prevent recovery of other children.
        }
    }

    return records.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Archive session
 */
export function archiveSession(sessionId: string, storePath?: string): void {
    updateSessionMetadata(sessionId, { status: 'archived' }, storePath);
}

/**
 * Delete session (soft delete)
 */
export function deleteSession(sessionId: string, storePath?: string): void {
    updateSessionMetadata(sessionId, { status: 'deleted' }, storePath);
}

/**
 * Read the last few messages (for preview)
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
 * Get message preview text
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
 * Get log file path (change to JSONL)
 */
export function getLogsFilePath(sessionId: string, storePath?: string): string {
    const base = storePath || getDefaultStorePath();
    return join(base, `${sanitizeSessionId(sessionId)}.logs.jsonl`);
}

/**
 * Read session log
 */
export function readSessionLogs(sessionId: string, storePath?: string): ToolLog[] {
    const logsPath = getLogsFilePath(sessionId, storePath);

    // Compatible with old format.logs.json
    const legacyPath = logsPath.replace('.logs.jsonl', '.logs.json');
    if (!existsSync(logsPath) && existsSync(legacyPath)) {
        try {
            const data = readFileSync(legacyPath, 'utf-8');
            return JSON.parse(data) as ToolLog[];
        } catch {
            return [];
        }
    }

    if (!existsSync(logsPath)) return [];
    const lines = readFileSync(logsPath, 'utf-8').split(/\r?\n/);
    const logs: ToolLog[] = [];
    for (const line of lines) {
        if (!line.trim()) continue;
        try { logs.push(JSON.parse(line)); } catch { /* skip */ }
    }
    return logs;
}

/**
 * Append log (JSONL, pure append without full read and write)
 */
export function appendSessionLog(sessionId: string, log: ToolLog, storePath?: string): void {
    const logsPath = getLogsFilePath(sessionId, storePath);
    ensureDir(dirname(logsPath));
    appendFileSync(logsPath, JSON.stringify(log) + '\n', 'utf-8');

    // Light rotation: when the number exceeds 500, truncate and keep the most recent 300
    trimLogsFileIfNeeded(logsPath, 500, 300);
}

/**
 * Log rotation (only triggers a full read and write when the limit is exceeded)
 */
function trimLogsFileIfNeeded(logsPath: string, maxLines: number, keepLines: number): void {
    try {
        const content = readFileSync(logsPath, 'utf-8');
        const lines = content.split(/\r?\n/).filter(l => l.trim());
        if (lines.length > maxLines) {
            const kept = lines.slice(-keepLines).join('\n') + '\n';
            writeFileSync(logsPath, kept, 'utf-8');
        }
    } catch { /* non-critical */ }
}

/**
 * Clear session log
 */
export function clearSessionLogs(sessionId: string, storePath?: string): void {
    const logsPath = getLogsFilePath(sessionId, storePath);
    if (existsSync(logsPath)) {
        writeFileSync(logsPath, '', 'utf-8');
    }
    // Also clears old format files if present
    const legacyPath = logsPath.replace('.logs.jsonl', '.logs.json');
    if (existsSync(legacyPath)) {
        writeFileSync(legacyPath, '[]', 'utf-8');
    }
}

// ========== Persistence of results ==========

/**
 * Get the result file path
 */
export function getArtifactsFilePath(sessionId: string, storePath?: string): string {
    const base = storePath || getDefaultStorePath();
    return join(base, `${sanitizeSessionId(sessionId)}.artifacts.json`);
}

/**
 * Read session results
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
 * Additional achievements
 */
export function appendSessionArtifact(sessionId: string, artifact: SessionArtifact, storePath?: string): void {
    const filePath = getArtifactsFilePath(sessionId, storePath);
    ensureDir(dirname(filePath));

    const artifacts = readSessionArtifacts(sessionId, storePath);
    artifacts.push(artifact);
    writeFileSync(filePath, JSON.stringify(artifacts, null, 2), 'utf-8');
}

/**
 * Clear session results
 */
export function clearSessionArtifacts(sessionId: string, storePath?: string): void {
    const filePath = getArtifactsFilePath(sessionId, storePath);
    if (existsSync(filePath)) {
        writeFileSync(filePath, '[]', 'utf-8');
    }
}
