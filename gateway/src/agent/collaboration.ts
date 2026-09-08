/**
 * Durable multi-agent collaboration lifecycle.
 * Public tool responses remain compatible with the previous in-memory manager,
 * while child state and conversation context survive Gateway restarts.
 */

import { randomUUID } from 'node:crypto';
import { Logger } from '../utils/logger';
import { getAgentExecutionContext, runWithAgentExecutionContext } from '../runtime/execution-context';
import { telemetry } from '../observability/telemetry';
import {
    ChildAgentStore,
    getDefaultChildAgentStore,
    type ChildAgentRecord,
    type ChildAgentStatus,
} from './child-agent-store';
import {
    isStandalonePresentationCreationRequest,
    PRESENTATION_AGENT_ID,
} from './presentation-agent';

const log = new Logger('Collaboration');

export interface CollabMessage {
    id: string;
    from: string;
    to: string;
    content: string;
    timestamp: number;
    read: boolean;
}

export interface CollaborationSession {
    id: string;
    parentSessionId?: string;
    parentTurnId?: string;
    rootSessionId?: string;
    agentId: string;
    agentType?: 'builtin' | 'user';
    task: string;
    mode: 'run' | 'session';
    status: 'running' | 'completed' | 'failed' | 'timeout' | 'idle';
    startTime: number;
    endTime?: number;
    output?: string;
    error?: string;
    messages: CollabMessage[];
    label?: string;
}

export interface CollabSpawnParams {
    agentId: string;
    task: string;
    timeout?: number;
    parentSessionId?: string;
    parentTurnId?: string;
    rootSessionId?: string;
    parentAbortSignal?: AbortSignal;
    waitForResult?: boolean;
    mode?: 'run' | 'session';
    label?: string;
}

export interface CollabSpawnResult {
    sessionId: string;
    status: 'spawned' | 'completed' | 'failed' | 'timeout';
    output?: string;
    error?: string;
    duration?: number;
    /** True when a repeated specialist dispatch continued an owned child session. */
    reused?: boolean;
}

export interface CollabBatchTask {
    agentId: string;
    task: string;
    label?: string;
}

export interface CollabBatchParams {
    tasks: CollabBatchTask[];
    timeout?: number;
    waitForAll?: boolean;
    parentSessionId?: string;
    parentTurnId?: string;
    rootSessionId?: string;
    parentAbortSignal?: AbortSignal;
}

export interface CollabBatchResult {
    sessionIds: string[];
    results?: CollabSpawnResult[];
    summary?: {
        total: number;
        completed: number;
        failed: number;
        timeout: number;
    };
}

export interface CollabWaitAllResult {
    results: Array<{
        sessionId: string;
        agentId: string;
        label?: string;
        status: string;
        output?: string;
        error?: string;
        duration?: number;
    }>;
    summary: {
        total: number;
        completed: number;
        failed: number;
        timeout: number;
        totalDuration: number;
    };
}

export interface CollabAgentInfo {
    id: string;
    name: string;
    type: 'builtin' | 'user';
    description?: string;
}

/** Kept compatible with AgentManager's existing injected callback. */
export type AgentExecutor = (
    agentId: string,
    task: string,
    sessionId?: string,
    agentType?: 'builtin' | 'user',
) => Promise<{
    output: string;
    agentId: string;
    status?: 'completed' | 'failed' | 'waiting_input' | 'awaiting_plan_approval';
}>;

export type CollabSessionCompleteCallback = (session: CollaborationSession) => void;

type TerminationReason = 'timeout' | 'parent_abort' | 'manual_interrupt';

interface ActiveChildRun {
    controller: AbortController;
    terminationReason?: TerminationReason;
}

function toPublicStatus(status: ChildAgentStatus): CollaborationSession['status'] {
    return status === 'interrupted' ? 'failed' : status;
}

function toPublicResultStatus(status: ChildAgentStatus): CollabSpawnResult['status'] {
    if (status === 'timeout') return 'timeout';
    if (status === 'completed' || status === 'idle') return 'completed';
    return 'failed';
}

export class CollaborationManager {
    private executor: AgentExecutor | null = null;
    private getAvailableAgentInfos: (() => CollabAgentInfo[]) | null = null;
    private readonly maxConcurrent: number;
    private onCompleteCallback: CollabSessionCompleteCallback | null = null;
    private readonly childStore: ChildAgentStore;
    private readonly activeRuns = new Map<string, ActiveChildRun>();

    constructor(options?: { maxConcurrent?: number; childStore?: ChildAgentStore }) {
        this.maxConcurrent = options?.maxConcurrent || 10;
        this.childStore = options?.childStore || getDefaultChildAgentStore();
        this.childStore.recoverInterruptedRuns('collaboration');
    }

    setExecutor(executor: AgentExecutor): void {
        this.executor = executor;
    }

    setAgentProvider(fn: () => CollabAgentInfo[]): void {
        this.getAvailableAgentInfos = fn;
    }

    setOnComplete(fn: CollabSessionCompleteCallback): void {
        this.onCompleteCallback = fn;
    }

    getAgentInfos(): CollabAgentInfo[] {
        return this.getAvailableAgentInfos?.() || [];
    }

    async spawn(params: CollabSpawnParams): Promise<CollabSpawnResult> {
        if (!this.executor) throw new Error('Agent executor not initialized');

        let agentType: 'builtin' | 'user' = 'builtin';
        if (this.getAvailableAgentInfos) {
            const available = this.getAvailableAgentInfos();
            const found = available.find((agent) => agent.id === params.agentId);
            if (!found) {
                const ids = available.map((agent) => `${agent.id}(${agent.type})`).join(', ');
                throw new Error(`Agent "${params.agentId}" does not exist. Available agents: ${ids}`);
            }
            agentType = found.type;
        }

        if (params.agentId !== PRESENTATION_AGENT_ID
            && isStandalonePresentationCreationRequest(params.task)) {
            throw new Error(
                `Standalone PPTX delivery is owned by Agent "${PRESENTATION_AGENT_ID}". `
                + `Do not delegate it to "${params.agentId}" or use python-pptx as a substitute.`,
            );
        }

        const parentContext = getAgentExecutionContext();
        const parentSessionId = params.parentSessionId || parentContext?.sessionId;
        const parentTurnId = params.parentTurnId || parentContext?.turnId;
        const parentAbortSignal = params.parentAbortSignal || parentContext?.abortSignal;
        const timeout = params.timeout || 300;

        // Presentation design state is intentionally bound to the child session.
        // Repeated dispatches in one parent task therefore have to continue that
        // same durable child instead of creating a second session which cannot
        // legally claim the first child's design_id.
        if (params.agentId === PRESENTATION_AGENT_ID) {
            const owned = this.findOwnedSpecialistSession(
                PRESENTATION_AGENT_ID,
                parentSessionId,
                parentTurnId,
            );
            if (owned) {
                if (owned.status === 'running') {
                    if (params.waitForResult) {
                        const waited = await this.wait(owned.id, timeout);
                        return { ...waited, reused: true };
                    }
                    return { sessionId: owned.id, status: 'spawned', reused: true };
                }

                // Upgrade one-shot records written by older builds. Their full
                // transcript already exists, so retaining the id is safer than
                // abandoning the workflow checkpoint.
                if (owned.mode !== 'session') {
                    this.childStore.update(owned.id, { mode: 'session' });
                }
                if (['idle', 'completed', 'failed', 'timeout', 'interrupted'].includes(owned.status)) {
                    const resumed = await this.resume({
                        sessionId: owned.id,
                        message: params.task,
                        timeout,
                    }, {
                        allowRecoverableFailure: true,
                        parentAbortSignal,
                        parentContext,
                    });
                    return { ...resumed, reused: true };
                }
            }
        }

        if (this.getRunningCount() >= this.maxConcurrent) {
            throw new Error(`Maximum concurrent collaboration sessions reached (${this.maxConcurrent})`);
        }

        const sessionId = `collab-${randomUUID().slice(0, 8)}`;

        const record = this.childStore.create({
            id: sessionId,
            source: 'collaboration',
            parentSessionId,
            parentTurnId,
            rootSessionId: params.rootSessionId,
            agentId: params.agentId,
            agentType,
            task: params.task,
            mode: params.agentId === PRESENTATION_AGENT_ID ? 'session' : (params.mode || 'run'),
            label: params.label,
            approvalMode: parentContext?.approvalMode,
        });

        log.info(`Creating collaboration session: ${sessionId}`, {
            agentId: params.agentId,
            agentType,
            mode: record.mode,
            parentSessionId,
            parentTurnId,
            waitForResult: params.waitForResult,
        });

        const execution = this.executeWithCancellation(record, params.task, timeout, {
            parentAbortSignal,
            parentContext,
        });

        if (params.waitForResult) return execution;
        execution.catch((error) => {
            log.error(`Collaboration session async execution failed: ${sessionId}`, { error });
        });
        return { sessionId, status: 'spawned' };
    }

    async resume(
        params: { sessionId: string; message: string; timeout?: number },
        options?: {
            allowRecoverableFailure?: boolean;
            parentAbortSignal?: AbortSignal;
            parentContext?: ReturnType<typeof getAgentExecutionContext>;
        },
    ): Promise<CollabSpawnResult> {
        if (!this.executor) throw new Error('Agent executor not initialized');
        const record = this.childStore.get(params.sessionId);
        if (!record || record.source !== 'collaboration') {
            throw new Error(`Collaboration session does not exist: ${params.sessionId}`);
        }
        if (record.mode !== 'session') {
            throw new Error(`Session ${params.sessionId} is not a persistent session (mode=${record.mode})`);
        }
        if (record.status === 'running') throw new Error(`Session ${params.sessionId} is still running`);
        const recoverableFailure = options?.allowRecoverableFailure
            && ['failed', 'timeout', 'interrupted'].includes(record.status);
        if (record.status !== 'idle' && record.status !== 'completed' && !recoverableFailure) {
            throw new Error(`Session ${params.sessionId} cannot be resumed (status=${record.status})`);
        }

        const parentContext = options?.parentContext || getAgentExecutionContext();
        const updated = this.childStore.update(params.sessionId, {
            status: 'running',
            startTime: Date.now(),
            endTime: undefined,
            output: undefined,
            error: undefined,
        });
        return this.executeWithCancellation(updated, params.message, params.timeout || 300, {
            parentAbortSignal: options?.parentAbortSignal || parentContext?.abortSignal,
            parentContext,
        });
    }

    send(params: { targetSessionId: string; message: string; fromAgentId?: string }): CollabMessage {
        const record = this.childStore.get(params.targetSessionId);
        if (!record || record.source !== 'collaboration') {
            throw new Error(`Collaboration session does not exist: ${params.targetSessionId}`);
        }
        const message = this.childStore.appendMessage(params.targetSessionId, {
            from: params.fromAgentId || 'main',
            to: record.agentId,
            content: params.message,
        }, true);
        return message;
    }

    interrupt(sessionId: string): boolean {
        const active = this.activeRuns.get(sessionId);
        if (!active || active.controller.signal.aborted) return false;
        active.terminationReason = 'manual_interrupt';
        active.controller.abort(new Error('Child agent interrupted'));
        return true;
    }

    getSession(sessionId: string): CollaborationSession | undefined {
        const record = this.childStore.get(sessionId);
        return record?.source === 'collaboration' ? this.toSession(record) : undefined;
    }

    listActive(): CollaborationSession[] {
        return this.listAll().filter((session) => session.status === 'running');
    }

    listAll(): CollaborationSession[] {
        return this.childStore.list('collaboration').map((record) => this.toSession(record));
    }

    getMessages(sessionId: string, markAsRead = false): CollabMessage[] {
        return this.childStore.getMessages(sessionId, markAsRead);
    }

    getRunningCount(): number {
        return this.childStore.list('collaboration').filter((record) => record.status === 'running').length;
    }

    private findOwnedSpecialistSession(
        agentId: string,
        parentSessionId?: string,
        parentTurnId?: string,
    ): ChildAgentRecord | undefined {
        if (!parentSessionId) return undefined;
        return this.childStore.list('collaboration').find((record) => (
            record.agentId === agentId
            && record.parentSessionId === parentSessionId
            && (parentTurnId ? record.parentTurnId === parentTurnId : true)
        ));
    }

    async spawnBatch(params: CollabBatchParams): Promise<CollabBatchResult> {
        if (!this.executor) throw new Error('Agent executor not initialized');
        const spawned = await Promise.all(params.tasks.map((task) => this.spawn({
            agentId: task.agentId,
            task: task.task,
            label: task.label,
            timeout: params.timeout,
            waitForResult: false,
            parentSessionId: params.parentSessionId,
            parentTurnId: params.parentTurnId,
            rootSessionId: params.rootSessionId,
            parentAbortSignal: params.parentAbortSignal,
        })));
        const sessionIds = spawned.map((result) => result.sessionId);
        if (!params.waitForAll) return { sessionIds };

        const waited = await this.waitAll(sessionIds, params.timeout || 300);
        return {
            sessionIds,
            results: waited.results.map((result) => ({
                sessionId: result.sessionId,
                status: result.status as CollabSpawnResult['status'],
                output: result.output,
                error: result.error,
                duration: result.duration,
            })),
            summary: waited.summary,
        };
    }

    async wait(sessionId: string, timeoutSec: number = 300): Promise<CollabSpawnResult> {
        const deadline = Date.now() + timeoutSec * 1000;
        while (Date.now() <= deadline) {
            const record = this.childStore.get(sessionId);
            if (!record || record.source !== 'collaboration') {
                return { sessionId, status: 'failed', error: 'Session does not exist' };
            }
            if (record.status !== 'running') return this.toResult(record);
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return { sessionId, status: 'timeout', error: 'Wait timed out' };
    }

    async waitAll(sessionIds: string[], timeoutSec: number = 300): Promise<CollabWaitAllResult> {
        const startedAt = Date.now();
        const deadline = startedAt + timeoutSec * 1000;
        while (Date.now() <= deadline) {
            const allDone = sessionIds.every((id) => this.childStore.get(id)?.status !== 'running');
            if (allDone) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }

        const results = sessionIds.map((id) => {
            const record = this.childStore.get(id);
            if (!record) {
                return { sessionId: id, agentId: 'unknown', status: 'failed', error: 'Session does not exist' };
            }
            return {
                sessionId: id,
                agentId: record.agentId,
                label: record.label,
                status: record.status === 'running' ? 'timeout' : toPublicResultStatus(record.status),
                output: record.output,
                error: record.error,
                duration: (record.endTime || Date.now()) - record.startTime,
            };
        });
        const summary = {
            total: results.length,
            completed: results.filter((result) => result.status === 'completed').length,
            failed: results.filter((result) => result.status === 'failed').length,
            timeout: results.filter((result) => result.status === 'timeout').length,
            totalDuration: Date.now() - startedAt,
        };
        return { results, summary };
    }

    /** Durable records are intentionally retained; cleanup no longer destroys restart history. */
    cleanup(_maxAgeMs: number = 3600000): void {}

    private async executeWithCancellation(
        record: ChildAgentRecord,
        request: string,
        timeoutSec: number,
        options: {
            parentAbortSignal?: AbortSignal;
            parentContext?: ReturnType<typeof getAgentExecutionContext>;
        },
    ): Promise<CollabSpawnResult> {
        const controller = new AbortController();
        const active: ActiveChildRun = { controller };
        this.activeRuns.set(record.id, active);

        const abort = (reason: TerminationReason, message: string) => {
            if (controller.signal.aborted) return;
            active.terminationReason = reason;
            controller.abort(new Error(message));
        };
        const parentAbortHandler = () => abort('parent_abort', 'Parent agent was interrupted');
        if (options.parentAbortSignal) {
            if (options.parentAbortSignal.aborted) parentAbortHandler();
            else options.parentAbortSignal.addEventListener('abort', parentAbortHandler, { once: true });
        }
        const timeoutTimer = setTimeout(
            () => abort('timeout', 'Execution timed out'),
            Math.max(1, timeoutSec * 1000),
        );

        const abortPromise = new Promise<never>((_, reject) => {
            if (controller.signal.aborted) {
                reject(controller.signal.reason || new Error('Child agent interrupted'));
                return;
            }
            controller.signal.addEventListener('abort', () => {
                reject(controller.signal.reason || new Error('Child agent interrupted'));
            }, { once: true });
        });

        try {
            if (controller.signal.aborted) throw controller.signal.reason;
            const childTurnId = randomUUID();
            const execution = runWithAgentExecutionContext({
                sessionId: record.id,
                turnId: childTurnId,
                parentTurnId: record.parentTurnId,
                runId: randomUUID(),
                traceId: options.parentContext?.traceId,
                depth: (options.parentContext?.depth || 0) + 1,
                abortSignal: controller.signal,
                onProgress: options.parentContext?.onProgress
                    ? event => options.parentContext?.onProgress?.({
                        ...event,
                        sourceId: record.id,
                        sourceAgentId: record.agentId,
                    })
                    : undefined,
                requestApproval: options.parentContext?.requestApproval,
                approvalMode: options.parentContext?.approvalMode,
                workspaceRoot: options.parentContext?.workspaceRoot,
                userGrantedReadPaths: options.parentContext?.userGrantedReadPaths,
            }, () => telemetry.trace(
                'child_agent.run',
                { traceId: options.parentContext?.traceId },
                {
                    sessionId: record.id,
                    parentSessionId: record.parentSessionId,
                    parentTurnId: record.parentTurnId,
                    agentId: record.agentId,
                    mode: record.mode,
                },
                () => this.executor!(record.agentId, request, record.id, record.agentType),
            ));
            // A non-cooperative adapter may finish after cancellation.  Swallow that
            // late settlement while the AbortController still reaches cooperative code.
            execution.catch(() => undefined);
            const result = await Promise.race([execution, abortPromise]);
            const endTime = Date.now();
            const runCompleted = !result.status || result.status === 'completed';
            const status: ChildAgentStatus = record.mode === 'session'
                ? 'idle'
                : runCompleted ? 'completed' : 'failed';
            this.childStore.appendConversationTurn(record.id, request, result.output);
            const completed = this.childStore.update(record.id, {
                status,
                endTime,
                output: result.output,
                error: runCompleted ? undefined : `Agent run ended with status ${result.status}`,
            });
            this.notifyComplete(completed);
            return {
                sessionId: record.id,
                status: runCompleted ? 'completed' : 'failed',
                output: result.output,
                error: runCompleted ? undefined : completed.error,
                duration: endTime - record.startTime,
            };
        } catch (error) {
            const endTime = Date.now();
            const errorMessage = error instanceof Error ? error.message : String(error);
            const status: ChildAgentStatus = active.terminationReason === 'timeout'
                ? 'timeout'
                : active.terminationReason
                    ? 'interrupted'
                    : 'failed';
            this.childStore.appendConversationTurn(record.id, request);
            const failed = this.childStore.update(record.id, {
                status,
                endTime,
                error: status === 'timeout' ? 'Execution timed out' : errorMessage,
            });
            this.notifyComplete(failed);
            return {
                sessionId: record.id,
                status: toPublicResultStatus(status),
                error: failed.error,
                duration: endTime - record.startTime,
            };
        } finally {
            clearTimeout(timeoutTimer);
            if (options.parentAbortSignal) {
                options.parentAbortSignal.removeEventListener('abort', parentAbortHandler);
            }
            this.activeRuns.delete(record.id);
        }
    }

    private notifyComplete(record: ChildAgentRecord): void {
        if (!this.onCompleteCallback) return;
        try {
            this.onCompleteCallback(this.toSession(record));
        } catch (error) {
            log.error('onComplete callback error', { error });
        }
    }

    private toSession(record: ChildAgentRecord): CollaborationSession {
        return {
            id: record.id,
            parentSessionId: record.parentSessionId,
            parentTurnId: record.parentTurnId,
            rootSessionId: record.rootSessionId,
            agentId: record.agentId,
            agentType: record.agentType,
            task: record.task,
            mode: record.mode,
            status: toPublicStatus(record.status),
            startTime: record.startTime,
            endTime: record.endTime,
            output: record.output,
            error: record.error,
            messages: record.messages.map((message) => ({ ...message })),
            label: record.label,
        };
    }

    private toResult(record: ChildAgentRecord): CollabSpawnResult {
        return {
            sessionId: record.id,
            status: toPublicResultStatus(record.status),
            output: record.output,
            error: record.error,
            duration: (record.endTime || Date.now()) - record.startTime,
        };
    }
}

let defaultCollabManager: CollaborationManager | null = null;

export function getCollaborationManager(): CollaborationManager {
    if (!defaultCollabManager) defaultCollabManager = new CollaborationManager();
    return defaultCollabManager;
}
