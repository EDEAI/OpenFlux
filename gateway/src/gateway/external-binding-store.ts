import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * One external group (Feishu / Slack / DingTalk) bound to this device.
 *
 * Lifecycle: `pending` (Router opened a card on the first real @mention) →
 * `assigned` (the user picked a Project or Agent and a dedicated session
 * exists) or `dismissed`. The Router mapping id is the stable key.
 */
export type ExternalBindingState = 'pending' | 'assigning' | 'assigned' | 'dismissed';
export type ExternalBindingTargetKind = 'project' | 'agent';

export interface ExternalBinding {
    /** Router ChannelProjectMapping id. */
    mappingId: string;
    platformId: string;
    platformType: string;
    workspaceId: string;
    channelId: string;
    channelName?: string;
    requesterPlatformId?: string;
    requesterDisplayName?: string;
    state: ExternalBindingState;
    targetKind?: ExternalBindingTargetKind;
    targetId?: string;
    targetName?: string;
    /** Dedicated OpenFlux session; created once, before Router is asked to confirm. */
    sessionId?: string;
    /** Idempotency key for the Router assignment; fixed on the first attempt. */
    operationId?: string;
    /** Router-side assignment revision as last confirmed. */
    revision: number;
    lastError?: string;
    createdAt: number;
    updatedAt: number;
}

export interface ExternalBindingStoreOptions {
    directory?: string;
    filePath?: string;
    clock?: () => number;
}

type BindingRecord = { version: 1; type: 'upsert'; timestamp: number; binding: ExternalBinding };

function clone<T>(value: T): T {
    try {
        return structuredClone(value);
    } catch {
        return JSON.parse(JSON.stringify(value)) as T;
    }
}

/**
 * Append-only journal of group bindings. The latest `upsert` for a mapping id
 * wins, so every mutation writes the whole binding; there are few of them.
 */
export class ExternalBindingStore {
    readonly filePath: string;

    private readonly clock: () => number;
    private readonly items = new Map<string, ExternalBinding>();
    private readonly order: string[] = [];
    private needsAppendBoundary = false;

    constructor(options: ExternalBindingStoreOptions = {}) {
        this.filePath = options.filePath
            || join(options.directory || join(process.cwd(), 'sessions'), 'external-bindings.jsonl');
        this.clock = options.clock || Date.now;
        this.reload();
    }

    get(mappingId: string): ExternalBinding | undefined {
        const item = this.items.get(mappingId);
        return item ? clone(item) : undefined;
    }

    findByChannel(platformId: string, workspaceId: string, channelId: string): ExternalBinding | undefined {
        for (const id of this.order) {
            const item = this.items.get(id);
            if (item && item.platformId === platformId && item.workspaceId === workspaceId && item.channelId === channelId) {
                return clone(item);
            }
        }
        return undefined;
    }

    findBySession(sessionId: string): ExternalBinding | undefined {
        for (const id of this.order) {
            const item = this.items.get(id);
            if (item && item.sessionId === sessionId) return clone(item);
        }
        return undefined;
    }

    /** Oldest first. */
    list(filter: { state?: ExternalBindingState | ExternalBindingState[] } = {}): ExternalBinding[] {
        const states = filter.state ? new Set(Array.isArray(filter.state) ? filter.state : [filter.state]) : null;
        const result: ExternalBinding[] = [];
        for (const id of this.order) {
            const item = this.items.get(id);
            if (!item) continue;
            if (states && !states.has(item.state)) continue;
            result.push(clone(item));
        }
        return result;
    }

    /**
     * Ensure a pending binding exists for a delivery without a Project.
     * Returns the binding and whether it was newly opened. An assigned or
     * dismissed binding is left untouched: the card never reopens by itself.
     */
    ensurePending(input: {
        mappingId: string;
        platformId: string;
        platformType: string;
        workspaceId: string;
        channelId: string;
        channelName?: string;
        requesterPlatformId?: string;
        requesterDisplayName?: string;
    }): { binding: ExternalBinding; created: boolean } {
        const existing = this.items.get(input.mappingId);
        if (existing) {
            let changed = false;
            if (input.channelName && input.channelName !== existing.channelName) {
                existing.channelName = input.channelName;
                changed = true;
            }
            if (!existing.requesterPlatformId && input.requesterPlatformId) {
                existing.requesterPlatformId = input.requesterPlatformId;
                existing.requesterDisplayName = input.requesterDisplayName;
                changed = true;
            }
            if (changed) this.write(existing);
            return { binding: clone(existing), created: false };
        }
        const now = this.clock();
        const binding: ExternalBinding = {
            mappingId: input.mappingId,
            platformId: input.platformId,
            platformType: input.platformType,
            workspaceId: input.workspaceId,
            channelId: input.channelId,
            channelName: input.channelName,
            requesterPlatformId: input.requesterPlatformId,
            requesterDisplayName: input.requesterDisplayName,
            state: 'pending',
            revision: 1,
            createdAt: now,
            updatedAt: now,
        };
        this.write(binding);
        return { binding: clone(binding), created: true };
    }

    /**
     * Record the chosen target and dedicated session before Router confirms.
     * The operation id is fixed on the first attempt so a retry replays the
     * same assignment instead of creating a second one.
     */
    beginAssign(mappingId: string, input: {
        targetKind: ExternalBindingTargetKind;
        targetId: string;
        targetName: string;
        sessionId: string;
        operationId: string;
    }): ExternalBinding | undefined {
        const item = this.items.get(mappingId);
        if (!item) return undefined;
        item.state = 'assigning';
        item.targetKind = input.targetKind;
        item.targetId = input.targetId;
        item.targetName = input.targetName;
        item.sessionId = input.sessionId;
        item.operationId = item.operationId || input.operationId;
        item.lastError = undefined;
        this.write(item);
        return clone(item);
    }

    completeAssign(mappingId: string, revision: number): ExternalBinding | undefined {
        const item = this.items.get(mappingId);
        if (!item) return undefined;
        item.state = 'assigned';
        item.revision = revision;
        item.lastError = undefined;
        this.write(item);
        return clone(item);
    }

    /** Router refused or the network failed: back to pending, keep target and session for retry. */
    failAssign(mappingId: string, error: string): ExternalBinding | undefined {
        const item = this.items.get(mappingId);
        if (!item) return undefined;
        item.state = 'pending';
        item.lastError = error;
        this.write(item);
        return clone(item);
    }

    dismiss(mappingId: string): ExternalBinding | undefined {
        const item = this.items.get(mappingId);
        if (!item) return undefined;
        item.state = 'dismissed';
        item.lastError = undefined;
        this.write(item);
        return clone(item);
    }

    /** A Router delivery already carries a Project: remember the binding as assigned without a card. */
    recordAssignedFromDelivery(input: {
        mappingId: string;
        platformId: string;
        platformType: string;
        workspaceId: string;
        channelId: string;
        channelName?: string;
        targetId: string;
    }): ExternalBinding {
        const existing = this.items.get(input.mappingId);
        if (existing) return clone(existing);
        const now = this.clock();
        const binding: ExternalBinding = {
            mappingId: input.mappingId,
            platformId: input.platformId,
            platformType: input.platformType,
            workspaceId: input.workspaceId,
            channelId: input.channelId,
            channelName: input.channelName,
            state: 'assigned',
            targetKind: 'project',
            targetId: input.targetId,
            revision: 0,
            createdAt: now,
            updatedAt: now,
        };
        this.write(binding);
        return clone(binding);
    }

    /** Attach a session to an assigned binding that was created without one. */
    setSession(mappingId: string, sessionId: string): ExternalBinding | undefined {
        const item = this.items.get(mappingId);
        if (!item) return undefined;
        item.sessionId = sessionId;
        this.write(item);
        return clone(item);
    }

    private write(binding: ExternalBinding): void {
        binding.updatedAt = this.clock();
        const record: BindingRecord = { version: 1, type: 'upsert', timestamp: binding.updatedAt, binding: clone(binding) };
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
                const record = JSON.parse(line) as BindingRecord;
                if (record?.version === 1 && record.type === 'upsert') this.apply(record);
            } catch {
                // A truncated append only invalidates that line.
            }
        }
    }

    private apply(record: BindingRecord): void {
        const binding = record.binding;
        if (!binding?.mappingId || !binding.platformId || !binding.channelId) return;
        if (!this.items.has(binding.mappingId)) this.order.push(binding.mappingId);
        this.items.set(binding.mappingId, clone(binding));
    }

    private append(record: BindingRecord): void {
        mkdirSync(dirname(this.filePath), { recursive: true });
        if (this.needsAppendBoundary) {
            appendFileSync(this.filePath, '\n', 'utf8');
            this.needsAppendBoundary = false;
        }
        appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
    }
}
