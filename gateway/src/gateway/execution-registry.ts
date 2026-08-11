import { randomUUID } from 'node:crypto';
import { runWithAgentExecutionContext } from '../runtime/execution-context';

export interface ExecutionTarget {
    /** Globally unique identifier allocated when the execution is enqueued. */
    runId: string;
    /** Optional additional guard for protocols that carry both ids. */
    turnId?: string;
}

export interface RunLease extends ExecutionTarget {
    key: string;
    epoch: number;
    signal: AbortSignal;
    isCurrent(): boolean;
    /** Run a commit only while this lease still owns the session. */
    guard<T>(commit: () => T): T | undefined;
}

export interface SteerEnvelope<T = unknown> {
    steerId: string;
    key: string;
    runId: string;
    turnId?: string;
    payload: T;
    createdAt: number;
}

export interface ActiveExecution {
    key: string;
    runId: string;
    traceId: string;
    submissionId?: string;
    sessionId?: string;
    turnId?: string;
    startedAt: number;
    leaseEpoch: number;
    controller: AbortController;
    lease: RunLease;
    isCurrent(): boolean;
    drainSteering<T = unknown>(): SteerEnvelope<T>[];
}

export interface ExecutionOptions {
    /** Queue key. Calls sharing the same key execute in arrival order. */
    key: string;
    sessionId?: string;
    turnId?: string;
    traceId?: string;
    parentTurnId?: string;
    controller?: AbortController;
    /** Existing durable id used when rehydrating a queue after restart. */
    runId?: string;
    /** Optional client-generated id used by higher-level durable queues. */
    submissionId?: string;
    onStart?: (execution: ActiveExecution) => void;
}

export interface ExecutionHandle<T> extends ExecutionTarget {
    submissionId?: string;
    /** 0 while active, 1..n while queued, and -1 after reaching a terminal state. */
    readonly position: number;
    readonly result: Promise<T>;
    /** Subscribe to activation. A late subscriber is notified in a microtask. */
    onStart(listener: (execution: ActiveExecution) => void): () => void;
    /** Cancels this item if queued, or compare-and-aborts it if active. */
    cancel(reason?: unknown): boolean;
}

export interface ExecutionSnapshotItem extends ExecutionTarget {
    key: string;
    traceId: string;
    submissionId?: string;
    sessionId?: string;
    enqueuedAt: number;
    startedAt?: number;
    leaseEpoch?: number;
    position: number;
    status: 'running' | 'queued' | 'paused';
}

export interface ExecutionQueueSnapshot {
    key: string;
    paused: boolean;
    active?: ExecutionSnapshotItem;
    queue: ExecutionSnapshotItem[];
}

export interface AbortExecutionOptions {
    /** Keep pending work queued after retiring the current run. */
    pauseQueue?: boolean;
}

interface Deferred<T> {
    promise: Promise<T>;
    resolve(value: T | PromiseLike<T>): void;
    reject(reason?: unknown): void;
}

interface QueueEntry<T = unknown> {
    options: ExecutionOptions;
    runId: string;
    traceId: string;
    enqueuedAt: number;
    task: (execution: ActiveExecution) => Promise<T>;
    deferred: Deferred<T>;
    listeners: Set<(execution: ActiveExecution) => void>;
    execution?: ActiveExecution;
    terminal: boolean;
    work?: Promise<T>;
    abortListener?: () => void;
}

interface KeyState {
    epoch: number;
    paused: boolean;
    active?: QueueEntry;
    queue: QueueEntry[];
}

function deferred<T>(): Deferred<T> {
    let resolve!: Deferred<T>['resolve'];
    let reject!: Deferred<T>['reject'];
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function reasonMessage(reason: unknown, fallback: string): string {
    if (reason instanceof Error && reason.message) return reason.message;
    if (typeof reason === 'string' && reason) return reason;
    return fallback;
}

export class ExecutionAbortedError extends Error {
    readonly code = 'EXECUTION_ABORTED';
    readonly key: string;
    readonly runId: string;
    readonly turnId?: string;

    constructor(key: string, target: ExecutionTarget, reason?: unknown) {
        super(reasonMessage(reason, 'Execution aborted'), { cause: reason });
        this.name = 'ExecutionAbortedError';
        this.key = key;
        this.runId = target.runId;
        this.turnId = target.turnId;
    }
}

export class QueuedExecutionCanceledError extends Error {
    readonly code = 'QUEUED_EXECUTION_CANCELED';
    readonly key: string;
    readonly runId: string;
    readonly turnId?: string;

    constructor(key: string, target: ExecutionTarget, reason?: unknown) {
        super(reasonMessage(reason, 'Queued execution canceled'), { cause: reason });
        this.name = 'QueuedExecutionCanceledError';
        this.key = key;
        this.runId = target.runId;
        this.turnId = target.turnId;
    }
}

/**
 * Owns per-session serialization, precise cancellation and run leases.
 *
 * Cancellation is deliberately split into two layers. The AbortController is
 * signalled so cooperative work can stop, while the registry immediately
 * retires the active lease and starts the next queued execution. A remote call
 * that ignores AbortSignal may settle later, but its settlement is consumed
 * and can no longer resolve/reject the public result or regain the lease.
 */
export class ExecutionRegistry {
    private readonly states = new Map<string, KeyState>();
    private readonly steering = new Map<string, SteerEnvelope[]>();
    /** Never reuse an id during this process; retired work may still settle late. */
    private readonly allocatedRunIds = new Set<string>();

    /** Compatibility entry point. Prefer enqueue() when run identity is needed before activation. */
    run<T>(options: ExecutionOptions, task: (execution: ActiveExecution) => Promise<T>): Promise<T> {
        return this.enqueue(options, task).result;
    }

    enqueue<T>(options: ExecutionOptions, task: (execution: ActiveExecution) => Promise<T>): ExecutionHandle<T> {
        const runId = this.allocateRunId(options.runId);
        const state = this.getOrCreateState(options.key);
        const entry: QueueEntry<T> = {
            options: { ...options },
            runId,
            traceId: options.traceId || randomUUID(),
            enqueuedAt: Date.now(),
            task,
            deferred: deferred<T>(),
            listeners: new Set(),
            terminal: false,
        };
        // Handles may intentionally be fire-and-forget (for example after a UI
        // disconnect). Mark the public promise as observed without changing
        // the rejection seen by consumers that do await it.
        void entry.deferred.promise.catch(() => undefined);

        if (options.onStart) entry.listeners.add(options.onStart);
        state.queue.push(entry as QueueEntry);

        const handle: ExecutionHandle<T> = {
            runId: entry.runId,
            turnId: options.turnId,
            submissionId: options.submissionId,
            get position() {
                return thisRegistry.positionOf(options.key, entry);
            },
            result: entry.deferred.promise,
            onStart: listener => this.subscribeToStart(entry, listener),
            cancel: reason => this.cancelHandle(options.key, entry, reason),
        };
        const thisRegistry = this;

        this.pump(options.key, state);
        return handle;
    }

    /** Compatibility stop: aborts whichever execution is currently active for key. */
    abort(key: string, reason?: unknown, options?: AbortExecutionOptions): boolean {
        const execution = this.get(key);
        if (!execution) return false;
        return this.abortIfCurrent(key, { runId: execution.runId, turnId: execution.turnId }, reason, options);
    }

    /** Compare-and-abort. A delayed stop for an older run is a harmless no-op. */
    abortIfCurrent(
        key: string,
        target: ExecutionTarget,
        reason?: unknown,
        options: AbortExecutionOptions = {},
    ): boolean {
        const state = this.states.get(key);
        const entry = state?.active;
        if (!state || !entry || !entry.execution || !this.matches(entry, target)) return false;

        if (options.pauseQueue) state.paused = true;
        const execution = entry.execution;
        if (!execution.controller.signal.aborted) {
            execution.controller.abort(reason);
        } else {
            this.retireActive(key, state, entry, new ExecutionAbortedError(key, target, reason));
        }
        return true;
    }

    pauseQueue(key: string): boolean {
        const state = this.getOrCreateState(key);
        if (state.paused) return false;
        state.paused = true;
        return true;
    }

    resumeQueue(key: string): boolean {
        const state = this.states.get(key);
        if (!state || !state.paused) return false;
        state.paused = false;
        this.pump(key, state);
        return true;
    }

    clearQueued(key: string, reason?: unknown): number {
        const state = this.states.get(key);
        if (!state || state.queue.length === 0) return 0;
        const queued = state.queue.splice(0);
        for (const entry of queued) this.rejectQueued(key, entry, reason);
        this.deleteStateIfIdle(key, state);
        return queued.length;
    }

    /** Cancel a pending queue item without affecting the active execution. */
    cancelQueued(key: string, target: ExecutionTarget, reason?: unknown): boolean {
        const state = this.states.get(key);
        if (!state) return false;
        const index = state.queue.findIndex(entry => this.matches(entry, target));
        if (index < 0) return false;
        const [entry] = state.queue.splice(index, 1);
        this.rejectQueued(key, entry, reason);
        this.deleteStateIfIdle(key, state);
        return true;
    }

    /** Move one pending item to a one-based queue position. */
    moveQueued(key: string, target: ExecutionTarget, position: number): boolean {
        const state = this.states.get(key);
        if (!state) return false;
        const from = state.queue.findIndex(entry => this.matches(entry, target));
        if (from < 0) return false;
        const [entry] = state.queue.splice(from, 1);
        const to = Math.max(0, Math.min(state.queue.length, Math.trunc(position) - 1));
        state.queue.splice(to, 0, entry);
        return true;
    }

    /**
     * Reorder queued runs. Listed ids are placed first in the requested order;
     * unlisted items retain their relative order.
     */
    reorderQueued(key: string, orderedRunIds: readonly string[]): boolean {
        const state = this.states.get(key);
        if (!state) return false;
        const uniqueIds = [...new Set(orderedRunIds)];
        const byId = new Map(state.queue.map(entry => [entry.runId, entry]));
        if (uniqueIds.some(runId => !byId.has(runId))) return false;
        const selected = uniqueIds.map(runId => byId.get(runId)!);
        const selectedIds = new Set(uniqueIds);
        state.queue = [...selected, ...state.queue.filter(entry => !selectedIds.has(entry.runId))];
        return true;
    }

    get(key: string): ActiveExecution | undefined {
        return this.states.get(key)?.active?.execution;
    }

    has(key: string): boolean {
        return Boolean(this.get(key));
    }

    isCurrent(key: string, target: ExecutionTarget | RunLease): boolean {
        const execution = this.get(key);
        if (!execution || execution.runId !== target.runId) return false;
        if (target.turnId !== undefined && execution.turnId !== target.turnId) return false;
        if ('epoch' in target && execution.leaseEpoch !== target.epoch) return false;
        return !execution.controller.signal.aborted;
    }

    getLease(key: string, target?: ExecutionTarget): RunLease | undefined {
        const execution = this.get(key);
        if (!execution) return undefined;
        if (target && !this.isCurrent(key, target)) return undefined;
        return execution.lease;
    }

    pushSteering<T>(key: string, target: ExecutionTarget, payload: T): SteerEnvelope<T> | undefined {
        const execution = this.get(key);
        if (!execution || !this.isCurrent(key, target)) return undefined;
        const envelope: SteerEnvelope<T> = {
            steerId: randomUUID(),
            key,
            runId: execution.runId,
            turnId: execution.turnId,
            payload,
            createdAt: Date.now(),
        };
        const mailbox = this.steering.get(target.runId) || [];
        mailbox.push(envelope as SteerEnvelope);
        this.steering.set(target.runId, mailbox);
        return envelope;
    }

    drainSteering<T = unknown>(key: string, target: ExecutionTarget): SteerEnvelope<T>[] {
        if (!this.isCurrent(key, target)) return [];
        const mailbox = this.steering.get(target.runId) || [];
        this.steering.delete(target.runId);
        return mailbox.filter(item => item.key === key && item.runId === target.runId) as SteerEnvelope<T>[];
    }

    snapshot(key: string): ExecutionQueueSnapshot {
        const state = this.states.get(key);
        return {
            key,
            paused: Boolean(state?.paused),
            active: state?.active ? this.snapshotEntry(state.active, 0, 'running') : undefined,
            queue: (state?.queue || []).map((entry, index) => this.snapshotEntry(
                entry,
                index + 1,
                state?.paused ? 'paused' : 'queued',
            )),
        };
    }

    snapshots(): ExecutionQueueSnapshot[] {
        return [...this.states.keys()].map(key => this.snapshot(key));
    }

    get activeCount(): number {
        let count = 0;
        for (const state of this.states.values()) {
            if (state.active) count += 1;
        }
        return count;
    }

    get queuedCount(): number {
        let count = 0;
        for (const state of this.states.values()) count += state.queue.length;
        return count;
    }

    private getOrCreateState(key: string): KeyState {
        let state = this.states.get(key);
        if (!state) {
            state = { epoch: 0, paused: false, queue: [] };
            this.states.set(key, state);
        }
        return state;
    }

    private allocateRunId(requested?: string): string {
        if (requested !== undefined) {
            if (typeof requested !== 'string' || !requested.trim()) {
                throw new Error('Execution runId must be a non-empty string');
            }
            if (this.allocatedRunIds.has(requested)) {
                throw new Error(`Execution runId is already allocated: ${requested}`);
            }
            this.allocatedRunIds.add(requested);
            return requested;
        }

        let generated = randomUUID();
        while (this.allocatedRunIds.has(generated)) generated = randomUUID();
        this.allocatedRunIds.add(generated);
        return generated;
    }

    private pump(key: string, state: KeyState): void {
        if (state.paused || state.active || state.queue.length === 0) {
            this.deleteStateIfIdle(key, state);
            return;
        }

        const entry = state.queue.shift()!;
        if (entry.terminal) {
            this.pump(key, state);
            return;
        }

        state.epoch += 1;
        state.active = entry;
        const controller = entry.options.controller || new AbortController();
        const leaseEpoch = state.epoch;
        const target: ExecutionTarget = { runId: entry.runId, turnId: entry.options.turnId };
        const lease: RunLease = {
            key,
            ...target,
            epoch: leaseEpoch,
            signal: controller.signal,
            isCurrent: () => this.isCurrent(key, lease),
            guard: commit => this.isCurrent(key, lease) ? commit() : undefined,
        };
        const execution: ActiveExecution = {
            key,
            runId: entry.runId,
            traceId: entry.traceId,
            submissionId: entry.options.submissionId,
            sessionId: entry.options.sessionId,
            turnId: entry.options.turnId,
            startedAt: Date.now(),
            leaseEpoch,
            controller,
            lease,
            isCurrent: lease.isCurrent,
            drainSteering: <T>() => this.drainSteering<T>(key, target),
        };
        entry.execution = execution;

        entry.abortListener = () => {
            this.retireActive(
                key,
                state,
                entry,
                new ExecutionAbortedError(key, target, controller.signal.reason),
            );
        };
        controller.signal.addEventListener('abort', entry.abortListener, { once: true });

        if (controller.signal.aborted) {
            entry.abortListener();
            return;
        }

        for (const listener of entry.listeners) this.notifyStart(listener, execution);
        entry.listeners.clear();

        // Activate synchronously so runId/position snapshots are immediately
        // stable, but invoke user work after enqueue() has returned its handle.
        queueMicrotask(() => this.invokeEntry(key, state, entry, execution));
    }

    private invokeEntry(
        key: string,
        state: KeyState,
        entry: QueueEntry,
        execution: ActiveExecution,
    ): void {
        if (entry.terminal || state.active !== entry) return;
        let work: Promise<unknown>;
        try {
            work = runWithAgentExecutionContext({
                sessionId: entry.options.sessionId,
                turnId: entry.options.turnId,
                runId: execution.runId,
                traceId: execution.traceId,
                parentTurnId: entry.options.parentTurnId,
                abortSignal: execution.controller.signal,
            }, () => entry.task(execution));
        } catch (error) {
            work = Promise.reject(error);
        }
        entry.work = Promise.resolve(work) as Promise<unknown>;

        // Both handlers are always installed: a retired non-cooperative task is
        // allowed to settle later without producing an unhandled rejection.
        void entry.work.then(
            value => this.settleActive(key, state, entry, true, value),
            error => this.settleActive(key, state, entry, false, error),
        );
    }

    private settleActive(
        key: string,
        state: KeyState,
        entry: QueueEntry,
        succeeded: boolean,
        settlement?: unknown,
    ): void {
        if (entry.terminal) return;
        entry.terminal = true;
        this.detachAbortListener(entry);
        this.steering.delete(entry.runId);
        if (succeeded) entry.deferred.resolve(settlement);
        else entry.deferred.reject(settlement);
        if (state.active === entry) state.active = undefined;
        this.pump(key, state);
    }

    private retireActive(key: string, state: KeyState, entry: QueueEntry, error: Error): void {
        if (entry.terminal || state.active !== entry) return;
        entry.terminal = true;
        entry.listeners.clear();
        this.detachAbortListener(entry);
        this.steering.delete(entry.runId);
        entry.deferred.reject(error);
        state.active = undefined;
        this.pump(key, state);
    }

    private rejectQueued(key: string, entry: QueueEntry, reason?: unknown): void {
        if (entry.terminal) return;
        entry.terminal = true;
        entry.listeners.clear();
        entry.deferred.reject(new QueuedExecutionCanceledError(
            key,
            { runId: entry.runId, turnId: entry.options.turnId },
            reason,
        ));
    }

    private detachAbortListener(entry: QueueEntry): void {
        if (entry.abortListener && entry.execution) {
            entry.execution.controller.signal.removeEventListener('abort', entry.abortListener);
        }
        entry.abortListener = undefined;
    }

    private subscribeToStart<T>(entry: QueueEntry<T>, listener: (execution: ActiveExecution) => void): () => void {
        if (entry.execution) {
            this.notifyStart(listener, entry.execution);
            return () => undefined;
        }
        if (entry.terminal) return () => undefined;
        entry.listeners.add(listener);
        return () => entry.listeners.delete(listener);
    }

    private notifyStart(listener: (execution: ActiveExecution) => void, execution: ActiveExecution): void {
        queueMicrotask(() => {
            try {
                listener(execution);
            } catch {
                // onStart is observational and must not break the execution.
            }
        });
    }

    private cancelHandle(key: string, entry: QueueEntry, reason?: unknown): boolean {
        const state = this.states.get(key);
        if (!state || entry.terminal) return false;
        if (state.active === entry) {
            return this.abortIfCurrent(key, { runId: entry.runId, turnId: entry.options.turnId }, reason);
        }
        return this.cancelQueued(key, { runId: entry.runId, turnId: entry.options.turnId }, reason);
    }

    private matches(entry: QueueEntry, target: ExecutionTarget): boolean {
        return entry.runId === target.runId
            && (target.turnId === undefined || entry.options.turnId === target.turnId);
    }

    private positionOf(key: string, entry: QueueEntry): number {
        const state = this.states.get(key);
        if (!state || entry.terminal) return -1;
        if (state.active === entry) return 0;
        const index = state.queue.indexOf(entry);
        return index < 0 ? -1 : index + 1;
    }

    private snapshotEntry(
        entry: QueueEntry,
        position: number,
        status: 'running' | 'queued' | 'paused',
    ): ExecutionSnapshotItem {
        return {
            key: entry.options.key,
            runId: entry.runId,
            traceId: entry.traceId,
            submissionId: entry.options.submissionId,
            sessionId: entry.options.sessionId,
            turnId: entry.options.turnId,
            enqueuedAt: entry.enqueuedAt,
            startedAt: entry.execution?.startedAt,
            leaseEpoch: entry.execution?.leaseEpoch,
            position,
            status,
        };
    }

    private deleteStateIfIdle(key: string, state: KeyState): void {
        if (!state.paused && !state.active && state.queue.length === 0 && this.states.get(key) === state) {
            this.states.delete(key);
        }
    }
}
