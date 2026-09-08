/** Spawn a restricted worker SubAgent with durable child-session state. */

import crypto from 'node:crypto';
import type { Tool, ToolResult, ToolParameter, ToolExecutionContext } from './types';
import { jsonResult, errorResult, readStringParam, readNumberParam, readStringArrayParam } from './common';
import { Logger } from '../utils/logger';
import { getAgentExecutionContext } from '../runtime/execution-context';
import { getDefaultChildAgentStore } from '../agent/child-agent-store';

const log = new Logger('SpawnTool');

export interface SpawnToolOptions {
    defaultTimeout?: number;
    maxConcurrent?: number;
    onExecute?: (params: SpawnParams) => Promise<SpawnResult>;
    getParentAbortSignal?: () => AbortSignal | undefined;
}

export interface SpawnParams {
    id: string;
    task: string;
    tools?: string[];
    timeout: number;
    parentSessionId?: string;
    parentTurnId?: string;
    rootSessionId?: string;
    parentAbortSignal?: AbortSignal;
}

export interface SpawnResult {
    id: string;
    status: 'completed' | 'failed' | 'timeout';
    output?: string;
    error?: string;
    duration?: number;
}

interface SubAgentRun {
    id: string;
    task: string;
    status: 'running' | 'completed' | 'failed' | 'timeout';
    startTime: number;
    endTime?: number;
    result?: SpawnResult;
}

const runningAgents = new Map<string, SubAgentRun>();
const recoveredSpawnStores = new Set<string>();

export function createSpawnTool(options: SpawnToolOptions = {}): Tool {
    const defaultTimeout = options.defaultTimeout || 300;
    const maxConcurrent = options.maxConcurrent || 5;

    const parameters: Record<string, ToolParameter> = {
        task: {
            type: 'string',
            description: 'Detailed task description for the SubAgent to execute. Be specific about what to do and expected output.',
            required: true,
        },
        tools: {
            type: 'array',
            description: 'Optional: additional tools for SubAgent. SubAgent ALWAYS has filesystem+process as baseline. Only specify extra tools needed (e.g. ["windows", "browser"]). Omit to inherit all available tools.',
            required: false,
            items: { type: 'string' },
        },
        timeout: {
            type: 'number',
            description: `Timeout in seconds (default ${defaultTimeout})`,
            required: false,
            default: defaultTimeout,
        },
    };

    return {
        name: 'spawn',
        priority: 45,
        description: 'Run a restricted SubAgent worker synchronously (max 30 iterations). This call blocks until the worker completes, fails, or times out. SubAgent always has filesystem+process tools (for file I/O), plus any extra tools you specify, and cannot spawn nested SubAgents. For background or parallel work, use sessions_spawn with waitForResult=false.',
        parameters,

        async execute(args: Record<string, unknown>, toolContext?: ToolExecutionContext): Promise<ToolResult> {
            try {
                // The standalone/bootstrap paths register the placeholder spawn tool
                // before constructing their workspace SessionStore. Resolve lazily so
                // child records always land in the active workspace.
                const childStore = getDefaultChildAgentStore();
                const storePath = childStore.sessionStore.getStorePath();
                if (!recoveredSpawnStores.has(storePath)) {
                    childStore.recoverInterruptedRuns('spawn');
                    recoveredSpawnStores.add(storePath);
                }
                const task = readStringParam(args, 'task', { required: true });
                const tools = readStringArrayParam(args, 'tools');
                const timeout = readNumberParam(args, 'timeout') || defaultTimeout;
                const runningCount = childStore.list('spawn').filter((record) => record.status === 'running').length;
                if (runningCount >= maxConcurrent) {
                    return errorResult(`Maximum concurrent SubAgent limit reached (${maxConcurrent})`);
                }

                const executionContext = getAgentExecutionContext();
                const parentSessionId = toolContext?.sessionId || executionContext?.sessionId;
                const parentTurnId = toolContext?.turnId || executionContext?.turnId;
                const parentSignal = toolContext?.abortSignal
                    || toolContext?.signal
                    || executionContext?.abortSignal
                    || options.getParentAbortSignal?.();
                const spawnId = `spawn-${crypto.randomUUID().slice(0, 8)}`;
                const record = childStore.create({
                    id: spawnId,
                    source: 'spawn',
                    parentSessionId,
                    parentTurnId,
                    agentId: 'subagent',
                    task,
                    mode: 'run',
                    approvalMode: toolContext?.approvalMode ?? executionContext?.approvalMode,
                });
                const run: SubAgentRun = {
                    id: spawnId,
                    task,
                    status: 'running',
                    startTime: record.startTime,
                };
                runningAgents.set(spawnId, run);
                log.info(`Creating SubAgent: ${spawnId}`, { parentSessionId, parentTurnId });

                if (!options.onExecute) {
                    childStore.update(spawnId, {
                        status: 'failed',
                        endTime: Date.now(),
                        error: 'No execution callback configured',
                    });
                    return jsonResult({
                        status: 'spawned',
                        id: spawnId,
                        message: 'SubAgent created, but no execution callback configured.',
                    });
                }

                const controller = new AbortController();
                let termination: 'timeout' | 'parent_abort' | undefined;
                const abort = (kind: typeof termination, message: string) => {
                    if (controller.signal.aborted) return;
                    termination = kind;
                    controller.abort(new Error(message));
                };
                const onParentAbort = () => abort('parent_abort', 'Parent agent was interrupted');
                if (parentSignal) {
                    if (parentSignal.aborted) onParentAbort();
                    else parentSignal.addEventListener('abort', onParentAbort, { once: true });
                }
                const timeoutTimer = setTimeout(
                    () => abort('timeout', 'Execution timed out'),
                    Math.max(1, timeout * 1000),
                );
                const abortPromise = new Promise<never>((_, reject) => {
                    if (controller.signal.aborted) {
                        reject(controller.signal.reason || new Error('SubAgent interrupted'));
                        return;
                    }
                    controller.signal.addEventListener('abort', () => {
                        reject(controller.signal.reason || new Error('SubAgent interrupted'));
                    }, { once: true });
                });

                try {
                    if (controller.signal.aborted) throw controller.signal.reason;
                    const execution = options.onExecute({
                        id: spawnId,
                        task,
                        tools,
                        timeout,
                        parentSessionId,
                        parentTurnId,
                        rootSessionId: record.rootSessionId,
                        parentAbortSignal: controller.signal,
                    });
                    execution.catch(() => undefined);
                    const result = await Promise.race([execution, abortPromise]);
                    const endTime = Date.now();
                    childStore.appendConversationTurn(spawnId, task, result.output);
                    childStore.update(spawnId, {
                        status: result.status,
                        endTime,
                        output: result.output,
                        error: result.error,
                    });
                    run.status = result.status;
                    run.endTime = endTime;
                    run.result = result;
                    return jsonResult({
                        status: result.status,
                        id: spawnId,
                        output: result.output,
                        error: result.error,
                        duration: result.duration ? `${(result.duration / 1000).toFixed(1)}s` : undefined,
                    });
                } catch (error) {
                    const endTime = Date.now();
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    const status: SpawnResult['status'] = termination === 'timeout' ? 'timeout' : 'failed';
                    const durableStatus = termination === 'parent_abort' ? 'interrupted' : status;
                    const result: SpawnResult = {
                        id: spawnId,
                        status,
                        error: termination === 'timeout' ? 'Execution timed out' : errorMessage,
                        duration: endTime - record.startTime,
                    };
                    childStore.appendConversationTurn(spawnId, task);
                    childStore.update(spawnId, {
                        status: durableStatus,
                        endTime,
                        error: result.error,
                    });
                    run.status = status;
                    run.endTime = endTime;
                    run.result = result;
                    return jsonResult({ status, id: spawnId, error: result.error });
                } finally {
                    clearTimeout(timeoutTimer);
                    if (parentSignal) parentSignal.removeEventListener('abort', onParentAbort);
                }
            } catch (error) {
                return errorResult(error instanceof Error ? error.message : String(error));
            }
        },
    };
}

export function getSpawnStatus(spawnId: string): SubAgentRun | undefined {
    const memory = runningAgents.get(spawnId);
    if (memory) return memory;
    const record = getDefaultChildAgentStore().get(spawnId);
    if (!record || record.source !== 'spawn') return undefined;
    const status: SubAgentRun['status'] = record.status === 'interrupted'
        ? 'failed'
        : record.status === 'idle'
            ? 'completed'
            : record.status;
    return {
        id: record.id,
        task: record.task,
        status,
        startTime: record.startTime,
        endTime: record.endTime,
        result: record.status === 'running' ? undefined : {
            id: record.id,
            status: status === 'running' ? 'failed' : status,
            output: record.output,
            error: record.error,
            duration: (record.endTime || Date.now()) - record.startTime,
        },
    };
}

export function getRunningSpawns(): SubAgentRun[] {
    return getDefaultChildAgentStore().list('spawn')
        .filter((record) => record.status === 'running')
        .map((record) => ({
            id: record.id,
            task: record.task,
            status: 'running',
            startTime: record.startTime,
        }));
}

/** Memory cleanup no longer removes durable child history. */
export function cleanupCompletedSpawns(maxAge: number = 3600000): void {
    const now = Date.now();
    for (const [id, run] of runningAgents.entries()) {
        if (run.status !== 'running' && run.endTime && now - run.endTime > maxAge) {
            runningAgents.delete(id);
        }
    }
}
