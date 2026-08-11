import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentProgressEvent } from '../gateway';
import type { ToolApprovalRequest, ToolApprovalDecision } from '../tools/types';
import type { ApprovalMode } from '../permissions/checker';

/** A user instruction queued for the currently running turn. */
export interface SteeringMessage {
    /** Stable submission ID used to make mailbox draining idempotent. */
    id: string;
    /** User-authored instruction. Messages are applied in FIFO order. */
    content: string;
}

export type DrainSteering = () => SteeringMessage[] | Promise<SteeringMessage[]>;

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
