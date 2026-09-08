import { randomUUID } from 'node:crypto';
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export type TurnQueueStatus =
    | 'queued'
    | 'paused'
    | 'dispatching'
    | 'completed'
    | 'canceled'
    | 'failed';

export interface TurnQueueItem<T = unknown> {
    id: string;
    submissionId: string;
    sessionId: string;
    payload: T;
    status: TurnQueueStatus;
    position: number;
    createdAt: number;
    updatedAt: number;
    error?: string;
}

export interface TurnQueueSubmission<T = unknown> {
    sessionId: string;
    submissionId: string;
    payload: T;
    id?: string;
}

export interface TurnQueueEnqueueResult<T = unknown> {
    item: TurnQueueItem<T>;
    /** False when submissionId was already observed, including terminal items. */
    created: boolean;
}

export interface TurnQueueSnapshot<T = unknown> {
    sessionId: string;
    paused: boolean;
    active?: TurnQueueItem<T>;
    queue: TurnQueueItem<T>[];
}

export interface TurnQueueStoreOptions {
    /** Directory containing turn-queue.jsonl. Defaults to the workspace sessions directory. */
    directory?: string;
    /** Explicit file path, primarily useful for tests and embedded runtimes. */
    filePath?: string;
    clock?: () => number;
    idFactory?: () => string;
}

type QueueRecord =
    | { version: 1; type: 'enqueue'; timestamp: number; item: TurnQueueItem }
    | {
        version: 1;
        type: 'status';
        timestamp: number;
        sessionId: string;
        id: string;
        status: TurnQueueStatus;
        error?: string;
    }
    | {
        version: 1;
        type: 'update';
        timestamp: number;
        sessionId: string;
        id: string;
        payload: unknown;
    }
    | { version: 1; type: 'reorder'; timestamp: number; sessionId: string; ids: string[] }
    | { version: 1; type: 'pause' | 'resume'; timestamp: number; sessionId: string };

function submissionKey(sessionId: string, submissionId: string): string {
    return `${sessionId}\u0000${submissionId}`;
}

function isTerminal(status: TurnQueueStatus): boolean {
    return status === 'completed' || status === 'canceled' || status === 'failed';
}

function clone<T>(value: T): T {
    try {
        return structuredClone(value);
    } catch {
        return JSON.parse(JSON.stringify(value)) as T;
    }
}

/**
 * Append-only durable queue journal.
 *
 * Each mutation is one independent JSON line. Replay ignores malformed lines,
 * including a truncated final write. Before the next append a missing newline
 * is repaired, so a corrupt tail cannot consume the first recovered record.
 */
export class TurnQueueStore {
    readonly filePath: string;

    private readonly clock: () => number;
    private readonly idFactory: () => string;
    private readonly items = new Map<string, TurnQueueItem>();
    private readonly bySubmission = new Map<string, string>();
    private readonly orderBySession = new Map<string, string[]>();
    private readonly pausedSessions = new Set<string>();
    private needsAppendBoundary = false;

    constructor(options: TurnQueueStoreOptions = {}) {
        this.filePath = options.filePath
            || join(options.directory || join(process.cwd(), 'sessions'), 'turn-queue.jsonl');
        this.clock = options.clock || Date.now;
        this.idFactory = options.idFactory || randomUUID;
        this.reload();
    }

    enqueue<T>(submission: TurnQueueSubmission<T>): TurnQueueEnqueueResult<T> {
        const existingId = this.bySubmission.get(submissionKey(submission.sessionId, submission.submissionId));
        if (existingId) {
            return { item: this.get<T>(existingId)!, created: false };
        }

        const timestamp = this.clock();
        const order = this.orderFor(submission.sessionId);
        const item: TurnQueueItem<T> = {
            id: submission.id || this.idFactory(),
            submissionId: submission.submissionId,
            sessionId: submission.sessionId,
            payload: clone(submission.payload),
            status: 'queued',
            position: order.length + 1,
            createdAt: timestamp,
            updatedAt: timestamp,
        };
        if (this.items.has(item.id)) {
            throw new Error(`Turn queue id already exists: ${item.id}`);
        }

        const record: QueueRecord = { version: 1, type: 'enqueue', timestamp, item };
        this.append(record);
        this.apply(record);
        return { item: this.copyItem(this.items.get(item.id)!) as TurnQueueItem<T>, created: true };
    }

    get<T = unknown>(id: string): TurnQueueItem<T> | undefined {
        const item = this.items.get(id);
        return item ? this.copyItem(item, this.positionFor(item)) as TurnQueueItem<T> : undefined;
    }

    getBySubmissionId<T = unknown>(sessionId: string, submissionId: string): TurnQueueItem<T> | undefined {
        const id = this.bySubmission.get(submissionKey(sessionId, submissionId));
        return id ? this.get<T>(id) : undefined;
    }

    snapshot<T = unknown>(sessionId: string): TurnQueueSnapshot<T> {
        const paused = this.pausedSessions.has(sessionId);
        const active = [...this.items.values()].find(
            item => item.sessionId === sessionId && item.status === 'dispatching',
        );
        const queue = this.orderFor(sessionId)
            .map(id => this.items.get(id))
            .filter((item): item is TurnQueueItem => Boolean(item)
                && !isTerminal(item!.status)
                && item!.status !== 'dispatching')
            .map((item, index) => this.copyItem(item, index + 1, paused ? 'paused' : item.status));
        return {
            sessionId,
            paused,
            active: active ? this.copyItem(active, 0) as TurnQueueItem<T> : undefined,
            queue: queue as TurnQueueItem<T>[],
        };
    }

    snapshots<T = unknown>(): TurnQueueSnapshot<T>[] {
        const sessionIds = new Set<string>(this.pausedSessions);
        for (const item of this.items.values()) {
            if (!isTerminal(item.status)) sessionIds.add(item.sessionId);
        }
        return [...sessionIds].map(sessionId => this.snapshot<T>(sessionId));
    }

    /** Return durable in-flight work without mutating it. */
    listDispatching<T = unknown>(): TurnQueueItem<T>[] {
        return [...this.items.values()]
            .filter(item => item.status === 'dispatching')
            .map(item => this.copyItem(item, 0) as TurnQueueItem<T>);
    }

    /** Return items in one durable state, including terminal history. */
    listByStatus<T = unknown>(status: TurnQueueStatus): TurnQueueItem<T>[] {
        return [...this.items.values()]
            .filter(item => item.status === status)
            .map(item => this.copyItem(item) as TurnQueueItem<T>);
    }

    claimNext<T = unknown>(sessionId: string): TurnQueueItem<T> | undefined {
        if (this.pausedSessions.has(sessionId)) return undefined;
        const hasActive = [...this.items.values()].some(
            item => item.sessionId === sessionId && item.status === 'dispatching',
        );
        if (hasActive) return undefined;
        const id = this.orderFor(sessionId).find(candidate => this.items.get(candidate)?.status === 'queued');
        if (!id) return undefined;
        this.setStatus(sessionId, id, 'dispatching');
        return this.get<T>(id);
    }

    setStatus(sessionId: string, id: string, status: TurnQueueStatus, error?: unknown): boolean {
        const item = this.items.get(id);
        if (!item || item.sessionId !== sessionId || item.status === status && error === undefined) return false;
        const record: QueueRecord = {
            version: 1,
            type: 'status',
            timestamp: this.clock(),
            sessionId,
            id,
            status,
            error: error instanceof Error ? error.message : error === undefined ? undefined : String(error),
        };
        this.append(record);
        this.apply(record);
        return true;
    }

    complete(sessionId: string, id: string): boolean {
        return this.setStatus(sessionId, id, 'completed');
    }

    fail(sessionId: string, id: string, error?: unknown): boolean {
        return this.setStatus(sessionId, id, 'failed', error);
    }

    cancel(sessionId: string, id: string, reason?: unknown): boolean {
        const item = this.items.get(id);
        if (!item || item.sessionId !== sessionId || isTerminal(item.status)) return false;
        return this.setStatus(sessionId, id, 'canceled', reason);
    }

    /** Edit a pending item in place while preserving its id and queue position. */
    updatePayload<T>(sessionId: string, id: string, payload: T): TurnQueueItem<T> | undefined {
        const item = this.items.get(id);
        if (!item || item.sessionId !== sessionId || isTerminal(item.status) || item.status === 'dispatching') {
            return undefined;
        }
        const record: QueueRecord = {
            version: 1,
            type: 'update',
            timestamp: this.clock(),
            sessionId,
            id,
            payload: clone(payload),
        };
        this.append(record);
        this.apply(record);
        return this.get<T>(id);
    }

    clear(sessionId: string, reason?: unknown): number {
        const ids = [...this.orderFor(sessionId)];
        let canceled = 0;
        for (const id of ids) {
            if (this.cancel(sessionId, id, reason)) canceled += 1;
        }
        return canceled;
    }

    pause(sessionId: string): boolean {
        if (this.pausedSessions.has(sessionId)) return false;
        const record: QueueRecord = { version: 1, type: 'pause', timestamp: this.clock(), sessionId };
        this.append(record);
        this.apply(record);
        return true;
    }

    resume(sessionId: string): boolean {
        if (!this.pausedSessions.has(sessionId)) return false;
        const record: QueueRecord = { version: 1, type: 'resume', timestamp: this.clock(), sessionId };
        this.append(record);
        this.apply(record);
        return true;
    }

    move(sessionId: string, id: string, position: number): boolean {
        const order = [...this.orderFor(sessionId)];
        const from = order.indexOf(id);
        if (from < 0) return false;
        order.splice(from, 1);
        const to = Math.max(0, Math.min(order.length, Math.trunc(position) - 1));
        order.splice(to, 0, id);
        return this.reorder(sessionId, order);
    }

    /** Listed ids move first; omitted queued items keep their relative order. */
    reorder(sessionId: string, orderedIds: readonly string[]): boolean {
        const current = this.orderFor(sessionId);
        const unique = [...new Set(orderedIds)];
        if (unique.some(id => !current.includes(id))) return false;
        const selected = new Set(unique);
        const ids = [...unique, ...current.filter(id => !selected.has(id))];
        if (ids.every((id, index) => current[index] === id)) return true;
        const record: QueueRecord = {
            version: 1,
            type: 'reorder',
            timestamp: this.clock(),
            sessionId,
            ids,
        };
        this.append(record);
        this.apply(record);
        return true;
    }

    /**
     * On process restart, an in-flight item is not replayed automatically. It
     * is marked failed so a caller can explicitly retry with a new submission.
     */
    recoverDispatching(reason = 'Gateway restarted before the turn reached a terminal state'): number {
        const active = this.listDispatching();
        for (const item of active) this.fail(item.sessionId, item.id, reason);
        return active.length;
    }

    reload(): void {
        this.items.clear();
        this.bySubmission.clear();
        this.orderBySession.clear();
        this.pausedSessions.clear();
        this.needsAppendBoundary = false;
        if (!existsSync(this.filePath)) return;

        const source = readFileSync(this.filePath, 'utf8');
        this.needsAppendBoundary = source.length > 0 && !source.endsWith('\n');
        for (const line of source.split(/\r?\n/)) {
            if (!line.trim()) continue;
            try {
                const record = JSON.parse(line) as QueueRecord;
                if (record?.version === 1 && typeof record.type === 'string') this.apply(record);
            } catch {
                // An append interrupted mid-record only invalidates that line.
            }
        }
    }

    private apply(record: QueueRecord): void {
        if (record.type === 'enqueue') {
            if (!record.item?.id || !record.item.sessionId || !record.item.submissionId) return;
            const key = submissionKey(record.item.sessionId, record.item.submissionId);
            if (this.bySubmission.has(key) || this.items.has(record.item.id)) return;
            const item = clone(record.item);
            this.items.set(item.id, item);
            this.bySubmission.set(key, item.id);
            if (!isTerminal(item.status) && item.status !== 'dispatching') this.orderFor(item.sessionId).push(item.id);
            return;
        }

        if (record.type === 'status') {
            const item = this.items.get(record.id);
            if (!item || item.sessionId !== record.sessionId) return;
            item.status = record.status;
            item.updatedAt = record.timestamp;
            item.error = record.error;
            const order = this.orderFor(item.sessionId);
            const index = order.indexOf(item.id);
            if (record.status === 'queued' || record.status === 'paused') {
                if (index < 0) order.push(item.id);
            } else if (index >= 0) {
                order.splice(index, 1);
            }
            return;
        }

        if (record.type === 'update') {
            const item = this.items.get(record.id);
            if (!item || item.sessionId !== record.sessionId || isTerminal(item.status) || item.status === 'dispatching') {
                return;
            }
            item.payload = clone(record.payload);
            item.updatedAt = record.timestamp;
            return;
        }

        if (record.type === 'reorder') {
            const current = this.orderFor(record.sessionId);
            const valid = record.ids.filter(id => current.includes(id));
            const selected = new Set(valid);
            this.orderBySession.set(
                record.sessionId,
                [...valid, ...current.filter(id => !selected.has(id))],
            );
            return;
        }

        if (record.type === 'pause') this.pausedSessions.add(record.sessionId);
        else this.pausedSessions.delete(record.sessionId);
    }

    private append(record: QueueRecord): void {
        mkdirSync(dirname(this.filePath), { recursive: true });
        if (this.needsAppendBoundary) {
            appendFileSync(this.filePath, '\n', 'utf8');
            this.needsAppendBoundary = false;
        }
        appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
    }

    private orderFor(sessionId: string): string[] {
        let order = this.orderBySession.get(sessionId);
        if (!order) {
            order = [];
            this.orderBySession.set(sessionId, order);
        }
        return order;
    }

    private copyItem(
        item: TurnQueueItem,
        position = item.status === 'dispatching' ? 0 : item.position,
        status = item.status,
    ): TurnQueueItem {
        return {
            ...item,
            payload: clone(item.payload),
            status,
            position: isTerminal(status) ? -1 : position,
        };
    }

    private positionFor(item: TurnQueueItem): number {
        if (isTerminal(item.status)) return -1;
        if (item.status === 'dispatching') return 0;
        const index = this.orderFor(item.sessionId).indexOf(item.id);
        return index < 0 ? item.position : index + 1;
    }
}
