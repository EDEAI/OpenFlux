import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentProgressEvent } from '../gateway';
import type { ToolApprovalRequest, ToolApprovalDecision } from '../tools/types';
import type { ApprovalMode } from '../permissions/checker';
import type { GoalRevision } from './goal-reconciler';

/** A user instruction queued for the currently running turn. */
export interface SteeringMessage {
    /** Stable submission ID used to make mailbox draining idempotent. */
    id: string;
    /** User-authored instruction. Messages are applied in FIFO order. */
    content: string;
}

export type DrainSteering = () => SteeringMessage[] | Promise<SteeringMessage[]>;

export interface GoalRevisionMessage extends Pick<GoalRevision, 'id' | 'effectiveGoal' | 'title' | 'detail'> {
    revision: number;
}

export type DrainGoalRevisions = () => GoalRevisionMessage[] | Promise<GoalRevisionMessage[]>;
export type OnIntentInvalidated = (
    afterEpoch: number,
    listener: (epoch: number, source: 'steer' | 'goal_revision') => void,
) => () => void;

/**
 * Per-turn execution state propagated through promises and tool calls.
 * AsyncLocalStorage removes the previous process-global "latest run" slots,
 * which could bind a concurrent session to another session's cancellation or
 * progress callback.
 */
export interface AgentExecutionContext {
    sessionId?: string;
    turnId?: string;
    runId?: string;
    traceId?: string;
    parentTurnId?: string;
    depth?: number;
    abortSignal?: AbortSignal;
    /** Drain pending user guidance for this turn in FIFO order. */
    drainSteering?: DrainSteering;
    /** Drain reconciled goal revisions for this turn in revision order. */
    drainGoalRevisions?: DrainGoalRevisions;
    /** Current intent epoch. Any plan made under an older epoch is stale. */
    getIntentEpoch?: () => number;
    /** Subscribe to steer or goal-revision invalidations newer than an epoch. */
    onIntentInvalidated?: OnIntentInvalidated;
    /** Wait for the latest parallel goal reconciliation before replanning. */
    waitForGoalReconciliation?: () => Promise<void>;
    onProgress?: (event: AgentProgressEvent) => void;
    requestApproval?: (request: ToolApprovalRequest) => Promise<ToolApprovalDecision>;
    /** Approval policy frozen when the owning turn starts. */
    approvalMode?: ApprovalMode;
    /** Per-turn workspace boundary used by filesystem, process and coding tools. */
    workspaceRoot?: string;
    /**
     * Files explicitly supplied by the user (for example via drag-and-drop).
     * Project turns may read these paths even when they live outside the project,
     * but write boundaries continue to be enforced by the individual tools.
     */
    userGrantedReadPaths?: string[];
}

const executionStorage = new AsyncLocalStorage<AgentExecutionContext>();

export function runWithAgentExecutionContext<T>(
    context: AgentExecutionContext,
    callback: () => Promise<T>,
): Promise<T> {
    return executionStorage.run(context, callback);
}

export function getAgentExecutionContext(): AgentExecutionContext | undefined {
    return executionStorage.getStore();
}
