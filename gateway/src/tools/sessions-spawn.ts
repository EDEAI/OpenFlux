/**
 * sessions_spawn 工具 - 创建跨 Agent 协作会话
 * 支持单个任务派发和批量并行派发
 */

import type { Tool, ToolResult, ToolParameter } from './types';
import { jsonResult, errorResult, readStringParam, readNumberParam, readBooleanParam } from './common';
import type { CollaborationManager, CollabBatchTask } from '../agent/collaboration';
import { Logger } from '../utils/logger';

const log = new Logger('SessionsSpawn');

/** sessions_spawn 工具选项 */
export interface SessionsSpawnToolOptions {
    /** CollaborationManager 实例 */
    collaborationManager: CollaborationManager;
    /** 默认超时秒数 */
    defaultTimeout?: number;
}

/**
 * 创建 sessions_spawn 工具
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
        // 批量模式参数
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
        ].join('\n'),
        parameters,

        async execute(args: Record<string, unknown>): Promise<ToolResult> {
            try {
                const timeout = readNumberParam(args, 'timeout') || defaultTimeout;
                const waitForResult = readBooleanParam(args, 'waitForResult');
                const batch = args.batch;

                if (batch && Array.isArray(batch) && batch.length > 0) {
                    // ========== 批量模式 ==========
                    return await handleBatch(collab, batch as CollabBatchTask[], timeout, waitForResult);
                }

                // ========== 单任务模式 ==========
                const agentId = readStringParam(args, 'agentId', { required: true });
                const task = readStringParam(args, 'task', { required: true });
                const modeRaw = readStringParam(args, 'mode');
                const mode = modeRaw === 'session' ? 'session' : 'run';

                log.info(`sessions_spawn: agent=${agentId}, mode=${mode}, wait=${waitForResult}`);

                const result = await collab.spawn({
                    agentId,
                    task,
                    timeout,
                    waitForResult,
                    mode,
                });

                if (result.status === 'spawned') {
                    return jsonResult({
                        status: 'spawned',
                        sessionId: result.sessionId,
                        agentId,
                        message: `Collaborative session created, Agent "${agentId}" is executing in background. Use sessions_send(action="status", targetSession="${result.sessionId}") to check progress.`,
                    });
                }

                return jsonResult({
                    status: result.status,
                    sessionId: result.sessionId,
                    agentId,
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
 * 批量模式处理
 */
async function handleBatch(
    collab: CollaborationManager,
    batch: CollabBatchTask[],
    timeout: number,
    waitForAll: boolean,
): Promise<ToolResult> {
    // 验证 batch 格式
    const tasks: CollabBatchTask[] = [];
    for (const item of batch) {
        if (!item.agentId || !item.task) {
            return errorResult(`Each task in batch must include agentId and task. Received: ${JSON.stringify(item)}`);
        }
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
    });

    if (!waitForAll) {
        // 异步模式：返回会话 ID 列表
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

    // 同步模式：返回完整结果
    return jsonResult({
        status: 'completed',
        count: result.sessionIds.length,
        summary: result.summary,
        results: result.results?.map(r => ({
            sessionId: r.sessionId,
            status: r.status,
            output: r.output?.slice(0, 500), // 截断避免过长
            error: r.error,
            duration: r.duration ? `${(r.duration / 1000).toFixed(1)}s` : undefined,
        })),
    });
}
