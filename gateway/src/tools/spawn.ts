/**
 * Spawn 工具 - 创建SubAgent 执行后台任务
 * 参考 Clawdbot sessions-spawn-tool.ts
 */

import crypto from 'node:crypto';
import type { Tool, ToolResult, ToolParameter } from './types';
import { jsonResult, errorResult, readStringParam, readNumberParam, readStringArrayParam } from './common';
import { Logger } from '../utils/logger';

const log = new Logger('SpawnTool');

/**
 * Spawn 工具配置
 */
export interface SpawnToolOptions {
    /** 默认超时（秒） */
    defaultTimeout?: number;
    /** 最大并发SubAgent */
    maxConcurrent?: number;
    /** SubAgent 执行回调 */
    onExecute?: (params: SpawnParams) => Promise<SpawnResult>;
}

/**
 * Spawn 参数
 */
export interface SpawnParams {
    id: string;
    task: string;
    tools?: string[];
    timeout: number;
    parentSessionId?: string;
}

/**
 * Spawn 结果
 */
export interface SpawnResult {
    id: string;
    status: 'completed' | 'failed' | 'timeout';
    output?: string;
    error?: string;
    duration?: number;
}

/**
 * SubAgent 运行记录
 */
interface SubAgentRun {
    id: string;
    task: string;
    status: 'running' | 'completed' | 'failed' | 'timeout';
    startTime: number;
    endTime?: number;
    result?: SpawnResult;
}

// 运行中的SubAgent
const runningAgents = new Map<string, SubAgentRun>();

/**
 * 创建 Spawn 工具
 */
export function createSpawnTool(options: SpawnToolOptions = {}): Tool {
    const defaultTimeout = options.defaultTimeout || 300;
    const maxConcurrent = options.maxConcurrent || 5;

    const parameters: Record<string, ToolParameter> = {
        task: {
            type: 'string',
            description: '要执行的任务描述',
            required: true,
        },
        tools: {
            type: 'array',
            description: '允许SubAgent 使用的工具列表（可选，默认继承）',
            required: false,
        },
        timeout: {
            type: 'number',
            description: `超时秒数（默认 ${defaultTimeout}）`,
            required: false,
            default: defaultTimeout,
        },
    };

    return {
        name: 'spawn',
        description: '创建SubAgent 执行任务并等待完成。SubAgent 执行完毕后返回结果。用于需要独立执行的子任务。',
        parameters,

        async execute(args: Record<string, unknown>): Promise<ToolResult> {
            try {
                const task = readStringParam(args, 'task', { required: true });
                const tools = readStringArrayParam(args, 'tools');
                const timeout = readNumberParam(args, 'timeout') || defaultTimeout;

                // 检查并发限制
                const runningCount = Array.from(runningAgents.values()).filter(
                    (a) => a.status === 'running'
                ).length;

                if (runningCount >= maxConcurrent) {
                    return errorResult(`已达到最大并发SubAgent 数量 (${maxConcurrent})`);
                }

                const spawnId = `spawn-${crypto.randomUUID().slice(0, 8)}`;

                log.info(`创建SubAgent: ${spawnId}`, { task: task.slice(0, 100) });

                // 记录运行状态
                const run: SubAgentRun = {
                    id: spawnId,
                    task,
                    status: 'running',
                    startTime: Date.now(),
                };
                runningAgents.set(spawnId, run);

                // 如果有执行回调，同步等待子Agent完成
                if (options.onExecute) {
                    const params: SpawnParams = {
                        id: spawnId,
                        task,
                        tools,
                        timeout,
                    };

                    try {
                        const result = await options.onExecute(params);
                        const existing = runningAgents.get(spawnId);
                        if (existing) {
                            existing.status = result.status;
                            existing.endTime = Date.now();
                            existing.result = result;
                        }
                        log.info(`SubAgent 完成: ${spawnId}`, { status: result.status });

                        return jsonResult({
                            status: result.status,
                            id: spawnId,
                            output: result.output,
                            error: result.error,
                            duration: result.duration ? `${(result.duration / 1000).toFixed(1)}s` : undefined,
                        });
                    } catch (error) {
                        const existing = runningAgents.get(spawnId);
                        if (existing) {
                            existing.status = 'failed';
                            existing.endTime = Date.now();
                            existing.result = {
                                id: spawnId,
                                status: 'failed',
                                error: error instanceof Error ? error.message : String(error),
                            };
                        }
                        log.error(`SubAgent 失败: ${spawnId}`, { error });
                        return jsonResult({
                            status: 'failed',
                            id: spawnId,
                            error: error instanceof Error ? error.message : String(error),
                        });
                    }
                }

                return jsonResult({
                    status: 'spawned',
                    id: spawnId,
                    message: `SubAgent 已创建，但未配置执行回调。`,
                });
            } catch (error) {
                return errorResult(error instanceof Error ? error.message : String(error));
            }
        },
    };
}

/**
 * 获取SubAgent 状态
 */
export function getSpawnStatus(spawnId: string): SubAgentRun | undefined {
    return runningAgents.get(spawnId);
}

/**
 * 获取所有运行中的子 Agent
 */
export function getRunningSpawns(): SubAgentRun[] {
    return Array.from(runningAgents.values()).filter((a) => a.status === 'running');
}

/**
 * 清理已完成的子 Agent 记录
 */
export function cleanupCompletedSpawns(maxAge: number = 3600000): void {
    const now = Date.now();
    for (const [id, run] of runningAgents.entries()) {
        if (run.status !== 'running' && run.endTime && now - run.endTime > maxAge) {
            runningAgents.delete(id);
        }
    }
}
