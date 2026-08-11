import {
    type ActiveExecution,
    type ExecutionHandle,
    type ExecutionOptions,
    type ExecutionQueueSnapshot,
    ExecutionRegistry,
    type ExecutionTarget,
    type RunLease,
    type SteerEnvelope,
} from '../gateway/execution-registry';

export interface SessionTurnOptions extends Omit<ExecutionOptions, 'key' | 'sessionId'> {
    sessionId: string;
}

/**
 * Session-oriented facade over ExecutionRegistry.
 *
 * Protocol handlers should retain the returned runId and use stopTurn rather
 * than session-wide aborts. This makes a delayed stop request incapable of
 * canceling the run that replaced its original target.
 */
export class SessionTurnCoordinator {
    readonly registry: ExecutionRegistry;

    constructor(registry = new ExecutionRegistry()) {
        this.registry = registry;
    }

    enqueue<T>(
        options: SessionTurnOptions,
        task: (execution: ActiveExecution) => Promise<T>,
    ): ExecutionHandle<T> {
        return this.registry.enqueue({ ...options, key: options.sessionId }, task);
    }

    run<T>(
        options: SessionTurnOptions,
        task: (execution: ActiveExecution) => Promise<T>,
    ): Promise<T> {
        return this.enqueue(options, task).result;
    }

    stopTurn(sessionId: string, target: ExecutionTarget, reason?: unknown, pauseQueue = true): boolean {
        return this.registry.abortIfCurrent(sessionId, target, reason, { pauseQueue });
    }

    current(sessionId: string): ActiveExecution | undefined {
        return this.registry.get(sessionId);
    }

    isCurrent(sessionId: string, target: ExecutionTarget | RunLease): boolean {
        return this.registry.isCurrent(sessionId, target);
    }

    snapshot(sessionId: string): ExecutionQueueSnapshot {
        return this.registry.snapshot(sessionId);
    }

    pauseQueue(sessionId: string): boolean {
        return this.registry.pauseQueue(sessionId);
    }

    resumeQueue(sessionId: string): boolean {
        return this.registry.resumeQueue(sessionId);
    }

    clearQueue(sessionId: string, reason?: unknown): number {
        return this.registry.clearQueued(sessionId, reason);
    }

    cancelQueued(sessionId: string, target: ExecutionTarget, reason?: unknown): boolean {
        return this.registry.cancelQueued(sessionId, target, reason);
    }

    moveQueued(sessionId: string, target: ExecutionTarget, position: number): boolean {
        return this.registry.moveQueued(sessionId, target, position);
    }

    reorderQueued(sessionId: string, orderedRunIds: readonly string[]): boolean {
        return this.registry.reorderQueued(sessionId, orderedRunIds);
    }

    steer<T>(sessionId: string, target: ExecutionTarget, payload: T): SteerEnvelope<T> | undefined {
        return this.registry.pushSteering(sessionId, target, payload);
    }

    drainSteering<T = unknown>(sessionId: string, target: ExecutionTarget): SteerEnvelope<T>[] {
        return this.registry.drainSteering<T>(sessionId, target);
    }
}
