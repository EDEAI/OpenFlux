/**
 * sessions_spawn tool - Create cross-Agent collaboration sessions
 * Supports single task dispatch and batch parallel dispatch
 */

import type { Tool, ToolResult, ToolParameter, ToolExecutionContext } from './types';
import { jsonResult, errorResult, readStringParam, readNumberParam, readBooleanParam } from './common';
import type {
    CollaborationManager,
    CollabBatchTask,
    CollabSpawnResult,
} from '../agent/collaboration';
import { Logger } from '../utils/logger';
import { getAgentExecutionContext } from '../runtime/execution-context';
import {
    isStandalonePresentationCreationRequest,
    PRESENTATION_AGENT_ID,
} from '../agent/presentation-agent';

const log = new Logger('SessionsSpawn');

/** sessions_spawn tool option */
export interface SessionsSpawnToolOptions {
    /** CollaborationManager instance */
    collaborationManager: CollaborationManager;
    /** Default timeout seconds */
    defaultTimeout?: number;
}

/**
 * Create sessions_spawn tool
 */
export function createSessionsSpawnTool(options: SessionsSpawnToolOptions): Tool {
    const defaultTimeout = options.defaultTimeout || 300;
    const collab = options.collaborationManager;

    const parameters: Record<string, ToolParameter> = {
        agentId: {
            type: 'string',
            description: 'Target Agent ID — can be a builtin agent or user-defined agent (required for single task mode)',
            required: false,
        },
        task: {
            type: 'string',
            description: 'Task description (required for single task mode)',
            required: false,
        },
        timeout: {
            type: 'number',
            description: `Timeout in seconds (default ${defaultTimeout})`,
            required: false,
            default: defaultTimeout,
        },
        waitForResult: {
            type: 'boolean',
            description: 'Whether to wait synchronously for results (default false)',
            required: false,
            default: false,
        },
        mode: {
            type: 'string',
            description: 'Session mode: "run" (one-shot, default) or "session" (persistent, supports follow-up via sessions_send resume)',
            required: false,
            default: 'run',
        },
        // Batch mode parameters
        batch: {
            type: 'array',
            description: 'Batch task list (ignores agentId/task when used). Each element: {"agentId": "...", "task": "...", "label": "optional label"}',
            required: false,
            items: { type: 'object' },
        },
    };

    return {
        name: 'sessions_spawn',
        priority: 45,
        description: [
            'Create collaborative sessions to dispatch tasks to other Agents (builtin or user-defined). Supports:',
            '',
            '[Single task] Specify agentId + task to dispatch one task',
            '[Batch mode] Use batch parameter to dispatch multiple tasks in parallel',
            '[Persistent session] Set mode="session" for multi-round follow-up (use sessions_send resume to continue)',
            '',
            'waitForResult=true: wait synchronously; false (default): async with auto-announce on completion',
            '',
            'Results auto-announce back to your session when complete. Do not poll.',
            '',
            'Define completion with concrete content and verification. Do not invent minimum KB/byte/word-count targets or ask child Agents to micro-tune artifact size. Unless the user explicitly requested an exact limit, length ranges are advisory only.',
        ].join('\n'),
        parameters,

        async execute(args: Record<string, unknown>, toolContext?: ToolExecutionContext): Promise<ToolResult> {
            try {
                const executionContext = getAgentExecutionContext();
                const parentSessionId = toolContext?.sessionId || executionContext?.sessionId;
                const parentTurnId = toolContext?.turnId || executionContext?.turnId;
                const parentAbortSignal = toolContext?.abortSignal || toolContext?.signal || executionContext?.abortSignal;
                const timeout = readNumberParam(args, 'timeout') || defaultTimeout;
                const waitForResult = readBooleanParam(args, 'waitForResult');
                const batch = args.batch;

                if (batch && Array.isArray(batch) && batch.length > 0) {
                    // ========== batch mode ==========
                    return await handleBatch(collab, batch as CollabBatchTask[], timeout, waitForResult, {
                        parentSessionId,
                        parentTurnId,
                        parentAbortSignal,
                    });
                }

                // ========== Single task mode ==========
                const agentId = readStringParam(args, 'agentId', { required: true });
                const task = readStringParam(args, 'task', { required: true });
                const modeRaw = readStringParam(args, 'mode');
                const mode = agentId === PRESENTATION_AGENT_ID || modeRaw === 'session'
                    ? 'session'
                    : 'run';

                const ownershipFailure = presentationOwnershipFailure(agentId, task);
                if (ownershipFailure) return ownershipFailure;

                log.info(`sessions_spawn: agent=${agentId}, mode=${mode}, wait=${waitForResult}`);

                const result = await collab.spawn({
                    agentId,
                    task,
                    timeout,
                    waitForResult,
                    mode,
                    parentSessionId,
                    parentTurnId,
                    parentAbortSignal,
                });

                if (result.status === 'spawned') {
                    return jsonResult({
                        status: 'spawned',
                        sessionId: result.sessionId,
                        agentId,
                        mode,
                        reused: result.reused === true,
                        message: `Collaborative session created, Agent "${agentId}" is executing in background. Use sessions_send(action="status", targetSession="${result.sessionId}") to check progress.`,
                    });
                }

                if (result.status === 'failed' || result.status === 'timeout') {
                    return collaborationFailureResult(agentId, mode, result);
                }

                return jsonResult({
                    status: result.status,
                    sessionId: result.sessionId,
                    agentId,
                    mode,
                    reused: result.reused === true,
                    output: result.output,
                    error: result.error,
                    duration: result.duration ? `${(result.duration / 1000).toFixed(1)}s` : undefined,
                });
            } catch (error) {
                return errorResult(error instanceof Error ? error.message : String(error));
            }
        },
    };
}

/**
 * Batch mode processing
 */
async function handleBatch(
    collab: CollaborationManager,
    batch: CollabBatchTask[],
    timeout: number,
    waitForAll: boolean,
    parent: {
        parentSessionId?: string;
        parentTurnId?: string;
        parentAbortSignal?: AbortSignal;
    },
): Promise<ToolResult> {
    // Verify batch format
    const tasks: CollabBatchTask[] = [];
    for (const item of batch) {
        if (!item.agentId || !item.task) {
            return errorResult(`Each task in batch must include agentId and task. Received: ${JSON.stringify(item)}`);
        }
        const ownershipFailure = presentationOwnershipFailure(String(item.agentId), String(item.task));
        if (ownershipFailure) return ownershipFailure;
        tasks.push({
            agentId: String(item.agentId),
            task: String(item.task),
            label: item.label ? String(item.label) : undefined,
        });
    }

    log.info(`sessions_spawn batch: ${tasks.length} tasks, wait=${waitForAll}`);

    const result = await collab.spawnBatch({
        tasks,
        timeout,
        waitForAll,
        ...parent,
    });

    if (!waitForAll) {
        // Asynchronous mode: Returns a list of session IDs
        return jsonResult({
            status: 'spawned',
            count: result.sessionIds.length,
            sessionIds: result.sessionIds,
            tasks: tasks.map((t, i) => ({
                agentId: t.agentId,
                label: t.label,
                sessionId: result.sessionIds[i],
            })),
            message: `${result.sessionIds.length} collaborative sessions created and running in parallel. Use sessions_send(action="waitAll", sessionIds=["..."]) to wait for all to complete.`,
        });
    }

    // Synchronous mode: return complete results
    return jsonResult({
        status: 'completed',
        count: result.sessionIds.length,
        summary: result.summary,
        results: result.results?.map(r => ({
            sessionId: r.sessionId,
            status: r.status,
            output: r.output?.slice(0, 500), // Truncate to avoid being too long
            error: r.error,
            duration: r.duration ? `${(r.duration / 1000).toFixed(1)}s` : undefined,
        })),
    });
}

function presentationOwnershipFailure(agentId: string, task: string): ToolResult | undefined {
    if (agentId === PRESENTATION_AGENT_ID || !isStandalonePresentationCreationRequest(task)) return undefined;
    return {
        success: false,
        code: 'presentation_agent_required',
        retryable: false,
        error: `Standalone PPTX creation must remain with Agent "${PRESENTATION_AGENT_ID}". `
            + `Agent "${agentId}" cannot replace it with python-pptx, scripts, or a generic file-generation path.`,
        data: {
            requiredAgentId: PRESENTATION_AGENT_ID,
            rejectedAgentId: agentId,
            nextAction: 'resume_owned_presentation_session_or_report_needs_attention',
        },
    };
}

function collaborationFailureResult(
    agentId: string,
    mode: 'run' | 'session',
    result: CollabSpawnResult,
): ToolResult {
    const presentation = agentId === PRESENTATION_AGENT_ID;
    return {
        success: false,
        code: presentation ? 'presentation_agent_requires_attention' : 'collaboration_agent_failed',
        retryable: false,
        error: result.error || (presentation
            ? 'The Presentation Agent did not complete the durable presentation workflow.'
            : `Agent "${agentId}" did not complete the delegated task.`),
        data: {
            status: result.status,
            sessionId: result.sessionId,
            agentId,
            mode,
            reused: result.reused === true,
            output: result.output,
            nextAction: presentation
                ? 'resume_this_presentation_session_or_report_needs_attention'
                : 'report_delegation_failure',
        },
    };
}
