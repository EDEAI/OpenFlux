import { randomUUID } from 'node:crypto';
import type { AgentProgressEvent } from '../gateway';
import type { AgentRuntimeEvent, AgentActivityItem, AgentRuntimeEventType } from './events';
import { AGENT_EVENT_VERSION } from './events';

export interface TurnTrackerOptions {
    sessionId: string;
    turnId?: string;
    traceId?: string;
    runId?: string;
    emit?: (event: AgentRuntimeEvent) => void;
    persist?: (event: AgentRuntimeEvent) => void;
}

/**
 * Converts the legacy Agent callbacks into a durable Thread/Turn/Item stream.
 * It deliberately exposes public commentary and deterministic summaries only.
 */
export class TurnTracker {
    readonly sessionId: string;
    readonly turnId: string;
    readonly traceId: string;

    private readonly startedAt = Date.now();
    private readonly emitCallback?: (event: AgentRuntimeEvent) => void;
    private readonly persistCallback?: (event: AgentRuntimeEvent) => void;
    private readonly runId?: string;
    private readonly toolItems = new Map<string, AgentActivityItem>();
    private readonly progressCommentaryFingerprints = new Set<string>();
    private seq = 0;
    private currentIteration = 0;
    private finished = false;
    private terminalEvent?: AgentRuntimeEvent;

    constructor(options: TurnTrackerOptions) {
        this.sessionId = options.sessionId;
        this.turnId = options.turnId || randomUUID();
        this.traceId = options.traceId || randomUUID();
        this.runId = options.runId;
        this.emitCallback = options.emit;
        this.persistCallback = options.persist;
    }

    start(): AgentRuntimeEvent {
        return this.publish('turn.started');
    }

    handleLegacyProgress(progress: AgentProgressEvent): AgentRuntimeEvent[] {
        if (this.finished) return [];
        const emitted: AgentRuntimeEvent[] = [];

        if (progress.type === 'iteration') {
            this.currentIteration = progress.iteration || this.currentIteration + 1;
            return emitted;
        }

        if (progress.type === 'commentary' && progress.commentary?.trim()) {
            const commentary = this.progressCommentary(progress.commentary, this.currentIteration);
            if (commentary) emitted.push(commentary);
            return emitted;
        }

        if (progress.type === 'tool_start') {
            if (progress.llmDescription?.trim()) {
                const commentary = this.progressCommentary(progress.llmDescription, this.currentIteration);
                if (commentary) emitted.push(commentary);
            }
            for (const toolCall of progress.toolCalls || []) {
                emitted.push(this.startAction({
                    toolCallId: toolCall.id,
                    tool: toolCall.name,
                    title: toolCall.title || this.actionTitle(
                        toolCall.name,
                        progress.description,
                        progress.llmDescription,
                    ),
                    detail: toolCall.detail,
                    sourceId: progress.sourceId,
                    sourceAgentId: progress.sourceAgentId,
                    iteration: this.currentIteration,
                }));
            }
            return emitted;
        }

        if (progress.type === 'tool_progress' && progress.toolCallId) {
            const updated = this.updateAction(
                progress.toolCallId,
                progress.description || progress.message,
                progress.sourceId,
            );
            if (updated) emitted.push(updated);
            return emitted;
        }

        if (progress.type === 'tool_result' && progress.tool) {
            const matchedByRawId = Boolean(progress.toolCallId);
            const toolCallId = progress.toolCallId || this.findLatestToolCall(progress.tool, progress.sourceId);
            if (toolCallId) {
                emitted.push(this.finishAction(
                    toolCallId,
                    progress.failed ? 'failed' : 'completed',
                    progress.description,
                    matchedByRawId ? progress.sourceId : undefined,
                ));
            } else {
                const syntheticId = `legacy-${randomUUID()}`;
                this.startAction({
                    toolCallId: syntheticId,
                    tool: progress.tool,
                    title: this.actionTitle(progress.tool, progress.description),
                    sourceId: progress.sourceId,
                    sourceAgentId: progress.sourceAgentId,
                    iteration: this.currentIteration,
                });
                emitted.push(this.finishAction(
                    syntheticId,
                    progress.failed ? 'failed' : 'completed',
                    progress.description,
                    progress.sourceId,
                ));
            }
        }

        return emitted;
    }

    commentary(text: string, iteration?: number): AgentRuntimeEvent {
        const now = Date.now();
        return this.publish('item.completed', {
            id: `commentary-${randomUUID()}`,
            kind: 'commentary',
            status: 'completed',
            title: this.cleanText(text, 500),
            iteration,
            startedAt: now,
            completedAt: now,
        });
    }

    guidance(text: string, guidanceId?: string): AgentRuntimeEvent {
        const now = Date.now();
        return this.publish('item.completed', {
            id: `guidance-${guidanceId || randomUUID()}`,
            kind: 'guidance',
            status: 'completed',
            title: this.cleanText(text, 1000),
            iteration: this.currentIteration || undefined,
            startedAt: now,
            completedAt: now,
        });
    }

    checkpoint(title: string, iteration?: number): AgentRuntimeEvent {
        const now = Date.now();
        return this.publish('item.completed', {
            id: `checkpoint-${randomUUID()}`,
            kind: 'checkpoint',
            status: 'completed',
            title: this.cleanText(title, 300),
            iteration,
            startedAt: now,
            completedAt: now,
        });
    }

    startAction(input: {
        toolCallId: string;
        tool: string;
        title: string;
        detail?: string;
        sourceId?: string;
        sourceAgentId?: string;
        iteration?: number;
    }): AgentRuntimeEvent {
        const scopedToolCallId = this.scopedToolCallId(input.toolCallId, input.sourceId);
        const item: AgentActivityItem = {
            id: `action-${scopedToolCallId}`,
            kind: input.tool === 'spawn' || input.tool === 'sessions_spawn' ? 'subagent' : 'action',
            status: 'running',
            title: this.cleanText(input.title || input.tool, 300),
            detail: input.detail ? this.cleanText(input.detail, 500) : undefined,
            toolCallId: scopedToolCallId,
            tool: input.tool,
            sourceId: input.sourceId,
            sourceAgentId: input.sourceAgentId,
            iteration: input.iteration,
            startedAt: Date.now(),
        };
        this.toolItems.set(scopedToolCallId, item);
        return this.publish('item.started', item);
    }

    updateAction(toolCallId: string, detail?: string, sourceId?: string): AgentRuntimeEvent | undefined {
        const scopedToolCallId = this.scopedToolCallId(toolCallId, sourceId);
        const item = this.toolItems.get(scopedToolCallId);
        if (!item) return undefined;
        const updated: AgentActivityItem = {
            ...item,
            detail: detail ? this.cleanText(detail, 500) : item.detail,
        };
        this.toolItems.set(scopedToolCallId, updated);
        return this.publish('item.updated', updated);
    }

    finishAction(
        toolCallId: string,
        status: 'completed' | 'failed',
        detail?: string,
        sourceId?: string,
    ): AgentRuntimeEvent {
        const scopedToolCallId = this.scopedToolCallId(toolCallId, sourceId);
        const existing = this.toolItems.get(scopedToolCallId) || {
            id: `action-${scopedToolCallId}`,
            kind: 'action' as const,
            status: 'running' as const,
            title: '工具操作',
            toolCallId: scopedToolCallId,
            sourceId,
            startedAt: Date.now(),
        };
        const item: AgentActivityItem = {
            ...existing,
            status,
            detail: detail ? this.cleanText(detail, 500) : existing.detail,
            completedAt: Date.now(),
        };
        this.toolItems.set(scopedToolCallId, item);
        return this.publish(status === 'failed' ? 'item.failed' : 'item.completed', item);
    }

    approval(input: {
        id: string;
        title: string;
        detail?: string;
        status: 'waiting' | 'completed' | 'failed';
    }): AgentRuntimeEvent {
        const now = Date.now();
        const type: AgentRuntimeEventType = input.status === 'waiting'
            ? 'item.started'
            : input.status === 'failed' ? 'item.failed' : 'item.completed';
        return this.publish(type, {
            id: `approval-${input.id}`,
            kind: 'approval',
            status: input.status,
            title: this.cleanText(input.title, 300),
            detail: input.detail ? this.cleanText(input.detail, 500) : undefined,
            startedAt: now,
            completedAt: input.status === 'waiting' ? undefined : now,
        });
    }

    complete(summary?: string): AgentRuntimeEvent {
        if (this.terminalEvent) return this.terminalEvent;
        this.finished = true;
        this.terminalEvent = this.publish('turn.completed', undefined, {
            durationMs: Date.now() - this.startedAt,
            summary: summary ? this.cleanText(summary, 300) : undefined,
        });
        return this.terminalEvent;
    }

    fail(error: string): AgentRuntimeEvent {
        if (this.terminalEvent) return this.terminalEvent;
        this.finished = true;
        this.terminalEvent = this.publish('turn.failed', undefined, {
            durationMs: Date.now() - this.startedAt,
            summary: this.cleanText(error, 300),
        });
        return this.terminalEvent;
    }

    interrupt(): AgentRuntimeEvent {
        if (this.terminalEvent) return this.terminalEvent;
        this.finished = true;
        this.terminalEvent = this.publish('turn.interrupted', undefined, {
            durationMs: Date.now() - this.startedAt,
            summary: '任务已由用户停止',
        });
        return this.terminalEvent;
    }

    private findLatestToolCall(tool: string, sourceId?: string): string | undefined {
        return [...this.toolItems.entries()].reverse().find(([, item]) =>
            item.tool === tool
            && item.status === 'running'
            && (sourceId === undefined || item.sourceId === sourceId))?.[0];
    }

    private progressCommentary(text: string, iteration?: number): AgentRuntimeEvent | undefined {
        const clean = this.cleanText(text, 500);
        const fingerprint = clean
            .toLocaleLowerCase()
            .replace(/[‐‑‒–—−-]+/g, '-')
            .replace(/[\s，。；：、,.!！?？:;"“”'‘’`()（）\[\]【】]+/g, '');
        if (!clean || this.progressCommentaryFingerprints.has(fingerprint)) return undefined;
        this.progressCommentaryFingerprints.add(fingerprint);
        if (this.progressCommentaryFingerprints.size > 512) {
            const oldest = this.progressCommentaryFingerprints.values().next().value;
            if (oldest) this.progressCommentaryFingerprints.delete(oldest);
        }
        return this.commentary(clean, iteration);
    }

    private scopedToolCallId(toolCallId: string, sourceId?: string): string {
        if (!sourceId) return toolCallId;
        const safeSource = sourceId.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 96);
        return `${safeSource}:${toolCallId}`;
    }

    private actionTitle(tool: string, description?: string, commentary?: string): string {
        const cleanDescription = description ? this.cleanText(description, 1000) : '';
        const cleanCommentary = commentary ? this.cleanText(commentary, 1000) : '';
        const comparableDescription = cleanDescription.replace(/…$/, '');
        const duplicatesCommentary = !!cleanCommentary && (
            cleanCommentary === cleanDescription
            || cleanCommentary.startsWith(comparableDescription)
        );
        const looksLikeNarrative = cleanDescription.length > 160
            || /(?:^|\s)(?:#{1,6}|[-*]\s|\d+\.\s)/.test(description || '')
            || (description || '').includes('|');

        if (!cleanDescription || duplicatesCommentary || looksLikeNarrative) {
            return `调用 ${tool}`;
        }
        return this.cleanText(cleanDescription, 120);
    }

    private cleanText(value: string, maxLength: number): string {
        const clean = value
            .replace(/<(think|thinking)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
            .replace(/<\/?(?:think|thinking)\b[^>]*>/gi, '')
            .replace(/\s+/g, ' ')
            .trim();
        return clean.length > maxLength ? `${clean.slice(0, maxLength - 1)}…` : clean;
    }

    private publish(
        type: AgentRuntimeEventType,
        item?: AgentActivityItem,
        extra?: Pick<AgentRuntimeEvent, 'durationMs' | 'summary'>,
    ): AgentRuntimeEvent {
        const event: AgentRuntimeEvent = {
            version: AGENT_EVENT_VERSION,
            eventId: randomUUID(),
            sessionId: this.sessionId,
            turnId: this.turnId,
            traceId: this.traceId,
            ...(this.runId ? { runId: this.runId } : {}),
            seq: ++this.seq,
            timestamp: Date.now(),
            type,
            ...(item ? { item } : {}),
            ...extra,
        };
        this.persistCallback?.(event);
        this.emitCallback?.(event);
        return event;
    }
}
