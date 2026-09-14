import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * A result produced for one external group request, recorded before it is
 * handed to Router. The outbox only ever resends stored content; it never
 * re-runs the Agent. One result per (delivery, kind).
 */
export type ExternalOutboxStatus = 'pending' | 'accepted' | 'fallback_sent' | 'failed';

export interface ExternalOutboxEntry {
    /** `${deliveryId}:${kind}` */
    id: string;
    deliveryId: string;
    mappingId: string;
    /** Router-side trigger identity (`external_event_id` of the group message). */
    triggerEventId: string;
    kind: 'result';
    content: string;
    status: ExternalOutboxStatus;
    attempts: number;
    lastError?: string;
    /** Router receipt after an accepted publish. */
    receipt?: { status?: string; sentCount?: number; pendingCount?: number };
    createdAt: number;
    updatedAt: number;
    nextAttemptAt: number;
}

export interface ExternalOutboxStoreOptions {
    directory?: string;
    filePath?: string;
    clock?: () => number;
}

type OutboxRecord = { version: 1; type: 'upsert'; timestamp: number; entry: ExternalOutboxEntry };

/** Retry delays for transport failures: 5s, 30s, 2m, 10m, then hourly. */
export const OUTBOX_RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000, 3_600_000] as const;
export const OUTBOX_MAX_ATTEMPTS = 12;

export function outboxRetryDelay(attempts: number): number {
    const index = Math.min(Math.max(attempts - 1, 0), OUTBOX_RETRY_DELAYS_MS.length - 1);
    return OUTBOX_RETRY_DELAYS_MS[index];
}

function clone<T>(value: T): T {
    try {
        return structuredClone(value);
    } catch {
        return JSON.parse(JSON.stringify(value)) as T;
    }
}

export class ExternalOutboxStore {
    readonly filePath: string;

    private readonly clock: () => number;
    private readonly items = new Map<string, ExternalOutboxEntry>();
    private readonly order: string[] = [];
    private needsAppendBoundary = false;

    constructor(options: ExternalOutboxStoreOptions = {}) {
        this.filePath = options.filePath
            || join(options.directory || join(process.cwd(), 'sessions'), 'external-outbox.jsonl');
        this.clock = options.clock || Date.now;
        this.reload();
    }

    get(id: string): ExternalOutboxEntry | undefined {
        const item = this.items.get(id);
        return item ? clone(item) : undefined;
    }

    /** Record a result once. A second call for the same delivery returns the existing entry. */
    enqueue(input: {
        deliveryId: string;
        mappingId: string;
        triggerEventId: string;
        content: string;
        kind?: 'result';
    }): { entry: ExternalOutboxEntry; created: boolean } {
        const kind = input.kind || 'result';
        const id = `${input.deliveryId}:${kind}`;
        const existing = this.items.get(id);
        if (existing) return { entry: clone(existing), created: false };
        const now = this.clock();
        const entry: ExternalOutboxEntry = {
            id,
            deliveryId: input.deliveryId,
            mappingId: input.mappingId,
            triggerEventId: input.triggerEventId,
            kind,
            content: input.content,
            status: 'pending',
            attempts: 0,
            createdAt: now,
            updatedAt: now,
            nextAttemptAt: now,
        };
        this.write(entry);
        return { entry: clone(entry), created: true };
    }

    /** Entries Router has not accepted yet whose retry time has come, oldest first. */
    due(now = this.clock()): ExternalOutboxEntry[] {
        const result: ExternalOutboxEntry[] = [];
        for (const id of this.order) {
            const item = this.items.get(id);
            if (item && item.status === 'pending' && item.nextAttemptAt <= now) result.push(clone(item));
        }
        return result;
    }

    pending(): ExternalOutboxEntry[] {
        return this.list().filter(item => item.status === 'pending');
    }

    list(): ExternalOutboxEntry[] {
        return this.order.map(id => this.items.get(id)).filter((item): item is ExternalOutboxEntry => Boolean(item)).map(clone);
    }

    markAttempt(id: string): ExternalOutboxEntry | undefined {
        const item = this.items.get(id);
        if (!item) return undefined;
        item.attempts += 1;
        this.write(item);
        return clone(item);
    }

    markAccepted(id: string, receipt?: ExternalOutboxEntry['receipt']): ExternalOutboxEntry | undefined {
        const item = this.items.get(id);
        if (!item) return undefined;
        item.status = 'accepted';
        item.receipt = receipt;
        item.lastError = undefined;
        this.write(item);
        return clone(item);
    }

    /** Router could not take the structured result; the plain group message went out instead. */
    markFallbackSent(id: string, reason: string): ExternalOutboxEntry | undefined {
        const item = this.items.get(id);
        if (!item) return undefined;
        item.status = 'fallback_sent';
        item.lastError = reason;
        this.write(item);
        return clone(item);
    }

    /** Transport failure: keep pending and back off; give up after OUTBOX_MAX_ATTEMPTS. */
    markRetry(id: string, error: string): ExternalOutboxEntry | undefined {
        const item = this.items.get(id);
        if (!item) return undefined;
        item.lastError = error;
        if (item.attempts >= OUTBOX_MAX_ATTEMPTS) {
            item.status = 'failed';
        } else {
            item.status = 'pending';
            item.nextAttemptAt = this.clock() + outboxRetryDelay(item.attempts);
        }
        this.write(item);
        return clone(item);
    }

    markFailed(id: string, error: string): ExternalOutboxEntry | undefined {
        const item = this.items.get(id);
        if (!item) return undefined;
        item.status = 'failed';
        item.lastError = error;
        this.write(item);
        return clone(item);
    }

    private write(entry: ExternalOutboxEntry): void {
        entry.updatedAt = this.clock();
        const record: OutboxRecord = { version: 1, type: 'upsert', timestamp: entry.updatedAt, entry: clone(entry) };
        this.append(record);
        this.apply(record);
    }

    private reload(): void {
        this.items.clear();
        this.order.length = 0;
        this.needsAppendBoundary = false;
        if (!existsSync(this.filePath)) return;
        const source = readFileSync(this.filePath, 'utf8');
        this.needsAppendBoundary = source.length > 0 && !source.endsWith('\n');
        for (const line of source.split(/\r?\n/)) {
            if (!line.trim()) continue;
            try {
                const record = JSON.parse(line) as OutboxRecord;
                if (record?.version === 1 && record.type === 'upsert') this.apply(record);
            } catch {
                // A truncated append only invalidates that line.
            }
        }
    }

    private apply(record: OutboxRecord): void {
        const entry = record.entry;
        if (!entry?.id || !entry.deliveryId || !entry.triggerEventId) return;
        if (!this.items.has(entry.id)) this.order.push(entry.id);
        this.items.set(entry.id, clone(entry));
    }

    private append(record: OutboxRecord): void {
        mkdirSync(dirname(this.filePath), { recursive: true });
        if (this.needsAppendBoundary) {
            appendFileSync(this.filePath, '\n', 'utf8');
            this.needsAppendBoundary = false;
        }
        appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
    }
}
