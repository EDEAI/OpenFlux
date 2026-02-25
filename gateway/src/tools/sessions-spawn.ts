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
            description: '目标 Agent ID（单任务模式必填，batch 模式不填）',
            required: false,
        },
        task: {
            type: 'string',
            description: '任务描述（单任务模式必填，batch 模式不填）',
            required: false,
        },
        timeout: {
            type: 'number',
            description: `超时秒数（默认 ${defaultTimeout}）`,
            required: false,
            default: defaultTimeout,
        },
        waitForResult: {
            type: 'boolean',
            description: '是否同步等待结果（默认 false）',
            required: false,
            default: false,
        },
        // 批量模式参数
        batch: {
            type: 'array',
            description: '批量任务列表（使用此参数时忽略 agentId/task）。每个元素: {"agentId": "...", "task": "...", "label": "可选标签"}',
            required: false,
            items: { type: 'object' },
        },
    };

    return {
        name: 'sessions_spawn',
        description: [
            '创建协作会话，将任务分派给指定 Agent 执行。支持两种模式：',
            '',
            '【单任务模式】指定 agentId + task，分派一个任务',
            '【批量模式】使用 batch 参数，同时分派多个任务给不同 Agent 并行执行',
            '',
            'waitForResult=true 时同步等待完成；false（默认）时异步返回会话 ID 后用 sessions_send 查询',
            '',
            '批量示例：',
            'batch: [',
            '  {"agentId": "coder", "task": "写一个工具函数", "label": "编码任务"},',
            '  {"agentId": "automation", "task": "搜索相关资料", "label": "搜索任务"}',
            ']',
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

                log.info(`sessions_spawn: agent=${agentId}, wait=${waitForResult}`);

                const result = await collab.spawn({
                    agentId,
                    task,
                    timeout,
                    waitForResult,
                });

                if (result.status === 'spawned') {
                    return jsonResult({
                        status: 'spawned',
                        sessionId: result.sessionId,
                        agentId,
                        message: `协作会话已创建，Agent "${agentId}" 正在后台执行。使用 sessions_send(action="status", targetSession="${result.sessionId}") 查询进度。`,
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
            return errorResult(`batch 中每个任务必须包含 agentId 和 task。收到: ${JSON.stringify(item)}`);
        }
        tasks.push({
            agentId: String(item.agentId),
            task: String(item.task),
            label: item.label ? String(item.label) : undefined,
        });
    }

    log.info(`sessions_spawn batch: ${tasks.length} 个任务, wait=${waitForAll}`);

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
            message: `${result.sessionIds.length} 个协作会话已创建并行执行中。使用 sessions_send(action="waitAll", sessionIds=["..."]) 等待全部完成。`,
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
