import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RouterGroupDelivery } from './router-bridge';

/**
 * A group message delivered by Router (`project_context.append`) and durably
 * stored on this device. The record is the local source of truth for the
 * acknowledgement Router expects: Router only marks a delivery as acked after
 * we report it, and we only report it after the append below succeeded.
 *
 * P1 scope: receive, persist, acknowledge. Nothing here starts an Agent turn;
 * assignment and execution arrive with the 待分配 work (P2/P3).
 */
export interface ExternalRequest {
    /** Router delivery id; unique per (device, event). */
    id: string;
    eventId: string;
    externalEventId: string;
    eventType: string;
    platformId: string;
    platformType: string;
    workspaceId: string;
    channelId: string;
    channelName?: string;
    threadId: string;
    messageId: string;
    projectId: string;
    mappingId?: string;
    collaborationId?: string;
    senderPlatformId: string;
    senderFluxUserId?: string;
    senderDisplayName?: string;
    senderRoleName?: string;
    senderType: string;
    senderIsCurrentMember: boolean;
    botMentioned: boolean;
    agentExecutionAllowed: boolean;
    suppressAgentExecution: boolean;
    historyImport: boolean;
    text: string;
    mentions: unknown[];
    attachments: unknown[];
    documentReferences: unknown[];
    sourceUrl?: string;
    /** Platform timestamps in epoch milliseconds. */
    createdAt: number;
    editedAt?: number;
    /** Local receive time in epoch milliseconds. */
    receivedAt: number;
    status: ExternalRequestStatus;
    ackedAt?: number;
    ackError?: string;
    /** `pending` while the group has no Project or Agent yet. */
    assignmentState: 'pending' | 'assigned';
    /**
     * Set once the request was handed to the dedicated session.
     * `deferred` means the session was busy with something that must not be
     * interrupted (a running goal, a workspace another session is writing to);
     * the request stays eligible for release and is retried later.
     */
    release?: {
        sessionId: string;
        releasedAt: number;
        status: ExternalReleaseStatus;
        error?: string;
    };
}

export type ExternalReleaseStatus = 'queued' | 'waiting_input' | 'completed' | 'failed' | 'deferred';

export type ExternalRequestStatus = 'received' | 'acked' | 'ack_failed';

export interface ExternalRequestRecordResult {
    item: ExternalRequest;
    /** False when the same delivery or platform event was already stored. */
    created: boolean;
}

export interface ExternalRequestStoreOptions {
    /** Directory containing external-requests.jsonl. Defaults to the workspace sessions directory. */
    directory?: string;
    /** Explicit file path, primarily useful for tests. */
    filePath?: string;
    clock?: () => number;
}

type StoreRecord =
    | { version: 1; type: 'receive'; timestamp: number; item: ExternalRequest }
    | {
        version: 1;
        type: 'status';
        timestamp: number;
        id: string;
        status: ExternalRequestStatus;
        error?: string;
    }
    | {
        version: 1;
        type: 'release';
        timestamp: number;
        id: string;
        sessionId: string;
        status: ExternalReleaseStatus;
        error?: string;
    };

function eventKey(platformId: string, externalEventId: string): string {
    return `${platformId}\u0000${externalEventId}`;
}

function clone<T>(value: T): T {
    try {
        return structuredClone(value);
    } catch {
        return JSON.parse(JSON.stringify(value)) as T;
    }
}

function asString(value: unknown): string {
    return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function asOptionalString(value: unknown): string | undefined {
    const text = asString(value).trim();
    return text ? text : undefined;
}

function asNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
    return undefined;
}

/** Normalize a Router delivery into the local record shape. Unknown fields are dropped. */
export function externalRequestFromDelivery(delivery: RouterGroupDelivery, receivedAt: number): ExternalRequest {
    return {
        id: asString(delivery.delivery_id).trim(),
        eventId: asString(delivery.event_id),
        externalEventId: asString(delivery.external_event_id).trim(),
        eventType: asString(delivery.event_type) || 'message_created',
        platformId: asString(delivery.platform_id),
        platformType: asString(delivery.platform_type),
        workspaceId: asString(delivery.workspace_id),
        channelId: asString(delivery.channel_id),
        channelName: asOptionalString(delivery.channel_name),
        threadId: asString(delivery.thread_id),
        messageId: asString(delivery.message_id),
        projectId: asString(delivery.project_id),
        mappingId: asOptionalString(delivery.mapping_id),
        collaborationId: asOptionalString(delivery.collaboration_id),
        senderPlatformId: asString(delivery.sender_platform_id),
        senderFluxUserId: asOptionalString(delivery.sender_flux_user_id),
        senderDisplayName: asOptionalString(delivery.sender_display_name),
        senderRoleName: asOptionalString(delivery.sender_role_name),
        senderType: asString(delivery.sender_type) || 'unknown',
        senderIsCurrentMember: delivery.sender_is_current_member === true,
        botMentioned: delivery.bot_mentioned === true,
        agentExecutionAllowed: delivery.agent_execution_allowed === true,
        suppressAgentExecution: delivery.suppress_agent_execution === true,
        historyImport: delivery.history_import === true,
        text: asString(delivery.text),
        mentions: Array.isArray(delivery.mentions) ? clone(delivery.mentions) : [],
        attachments: Array.isArray(delivery.attachments) ? clone(delivery.attachments) : [],
        documentReferences: Array.isArray(delivery.document_references) ? clone(delivery.document_references) : [],
        sourceUrl: asOptionalString(delivery.source_url),
        createdAt: asNumber(delivery.created_at) ?? receivedAt,
        editedAt: asNumber(delivery.edited_at),
        receivedAt,
        status: 'received',
        assignmentState: delivery.assignment_state === 'pending' || !asString(delivery.project_id).trim()
            ? 'pending'
            : 'assigned',
    };
}

/** A request that should start an Agent turn once its group has a session. */
export function isExecutableExternalRequest(item: Pick<ExternalRequest,
    'eventType' | 'senderType' | 'botMentioned' | 'agentExecutionAllowed' | 'suppressAgentExecution' | 'historyImport' | 'text' | 'attachments'>): boolean {
    return item.eventType === 'message_created'
        && item.senderType === 'human'
        && item.botMentioned
        && item.agentExecutionAllowed
        && !item.suppressAgentExecution
        && !item.historyImport
        && (item.text.trim().length > 0 || item.attachments.length > 0);
}

/**
 * Append-only journal of Router group deliveries.
 *
 * Mirrors TurnQueueStore: one JSON line per mutation, malformed or truncated
 * lines are ignored on replay, and a missing trailing newline is repaired
 * before the next append.
 */
export class ExternalRequestStore {
    readonly filePath: string;

    private readonly clock: () => number;
    private readonly items = new Map<string, ExternalRequest>();
    private readonly byEvent = new Map<string, string>();
    private readonly order: string[] = [];
    private needsAppendBoundary = false;

    constructor(options: ExternalRequestStoreOptions = {}) {
        this.filePath = options.filePath
            || join(options.directory || join(process.cwd(), 'sessions'), 'external-requests.jsonl');
        this.clock = options.clock || Date.now;
        this.reload();
    }

    /**
     * Store a delivery. Idempotent on delivery id and on (platform, external event).
     * Throws when the delivery has no usable identity, so the caller never acks
     * something that was not written.
     */
    record(delivery: RouterGroupDelivery): ExternalRequestRecordResult {
        const item = externalRequestFromDelivery(delivery, this.clock());
        if (!item.id) throw new Error('Router 群投递缺少 delivery_id');
        if (!item.platformId || !item.externalEventId) throw new Error('Router 群投递缺少平台或事件标识');

        const existingId = this.items.has(item.id)
            ? item.id
            : this.byEvent.get(eventKey(item.platformId, item.externalEventId));
        if (existingId) {
            return { item: clone(this.items.get(existingId)!), created: false };
        }

        this.append({ version: 1, type: 'receive', timestamp: item.receivedAt, item });
        this.apply({ version: 1, type: 'receive', timestamp: item.receivedAt, item });
        return { item: clone(item), created: true };
    }

    markAcked(id: string): boolean {
        return this.setStatus(id, 'acked');
    }

    markAckFailed(id: string, error: string): boolean {
        return this.setStatus(id, 'ack_failed', error);
    }

    get(id: string): ExternalRequest | undefined {
        const item = this.items.get(id);
        return item ? clone(item) : undefined;
    }

    /** Oldest first. */
    list(filter: { status?: ExternalRequestStatus; channelId?: string; limit?: number } = {}): ExternalRequest[] {
        const result: ExternalRequest[] = [];
        for (const id of this.order) {
            const item = this.items.get(id);
            if (!item) continue;
            if (filter.status && item.status !== filter.status) continue;
            if (filter.channelId && item.channelId !== filter.channelId) continue;
            result.push(clone(item));
            if (filter.limit && result.length >= filter.limit) break;
        }
        return result;
    }

    /** Deliveries stored locally whose acknowledgement never reached Router. */
    unacked(): ExternalRequest[] {
        return this.list().filter(item => item.status !== 'acked');
    }

    /**
     * Executable requests of one mapping still waiting for a session turn,
     * oldest first: never released, or released but deferred.
     */
    unreleased(mappingId: string): ExternalRequest[] {
        return this.list().filter(item => item.mappingId === mappingId
            && (!item.release || item.release.status === 'deferred')
            && isExecutableExternalRequest(item));
    }

    markReleased(id: string, sessionId: string): boolean {
        return this.setRelease(id, sessionId, 'queued');
    }

    markDeferred(id: string, sessionId: string, reason: string): boolean {
        return this.setRelease(id, sessionId, 'deferred', reason);
    }

    markReleaseResult(id: string, status: Exclude<ExternalReleaseStatus, 'queued' | 'deferred'>, error?: string): boolean {
        const item = this.items.get(id);
        if (!item?.release) return false;
        return this.setRelease(id, item.release.sessionId, status, error);
    }

    private setRelease(id: string, sessionId: string, status: ExternalReleaseStatus, error?: string): boolean {
        if (!this.items.has(id)) return false;
        const record: StoreRecord = { version: 1, type: 'release', timestamp: this.clock(), id, sessionId, status, error };
        this.append(record);
        this.apply(record);
        return true;
    }

    get size(): number {
        return this.items.size;
    }

    private setStatus(id: string, status: ExternalRequestStatus, error?: string): boolean {
        const item = this.items.get(id);
        if (!item) return false;
        if (item.status === status && item.ackError === error) return true;
        const record: StoreRecord = { version: 1, type: 'status', timestamp: this.clock(), id, status, error };
        this.append(record);
        this.apply(record);
        return true;
    }

    private reload(): void {
        this.items.clear();
        this.byEvent.clear();
        this.order.length = 0;
        this.needsAppendBoundary = false;
        if (!existsSync(this.filePath)) return;

        const source = readFileSync(this.filePath, 'utf8');
        this.needsAppendBoundary = source.length > 0 && !source.endsWith('\n');
        for (const line of source.split(/\r?\n/)) {
            if (!line.trim()) continue;
            try {
                const record = JSON.parse(line) as StoreRecord;
                if (record?.version === 1 && typeof record.type === 'string') this.apply(record);
            } catch {
                // An append interrupted mid-record only invalidates that line.
            }
        }
    }

    private apply(record: StoreRecord): void {
        if (record.type === 'receive') {
            const item = record.item;
            if (!item?.id || !item.platformId || !item.externalEventId) return;
            const key = eventKey(item.platformId, item.externalEventId);
            if (this.items.has(item.id) || this.byEvent.has(key)) return;
            const stored = clone(item);
            if (stored.assignmentState !== 'pending' && stored.assignmentState !== 'assigned') {
                stored.assignmentState = stored.projectId ? 'assigned' : 'pending';
            }
            this.items.set(stored.id, stored);
            this.byEvent.set(key, stored.id);
            this.order.push(stored.id);
            return;
        }
        if (record.type === 'status') {
            const item = this.items.get(record.id);
            if (!item) return;
            item.status = record.status;
            item.ackError = record.error;
            if (record.status === 'acked') item.ackedAt = record.timestamp;
            return;
        }
        if (record.type === 'release') {
            const item = this.items.get(record.id);
            if (!item || !record.sessionId) return;
            const releasedAt = item.release?.releasedAt ?? record.timestamp;
            item.release = { sessionId: record.sessionId, releasedAt, status: record.status, error: record.error };
        }
    }

    private append(record: StoreRecord): void {
        mkdirSync(dirname(this.filePath), { recursive: true });
        if (this.needsAppendBoundary) {
            appendFileSync(this.filePath, '\n', 'utf8');
            this.needsAppendBoundary = false;
        }
        appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
    }
}
