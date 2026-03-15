/**
 * 调度器工具 - 供 AgentLoop 调用
 *
 * LLM 判断用户想要创建/管理定时任务时，调用此工具。
 *
 * 动作：
 *   list    — 列出所有定时任务
 *   create  — 创建定时任务
 *   update  — 编辑已有任务（修改名称/触发器/目标）
 *   pause   — 暂停任务
 *   resume  — 恢复任务
 *   delete  — 删除任务
 *   trigger — 手动触发（立即执行一次）
 *   runs    — 查看执行记录
 */

import type { AnyTool, ToolResult } from '../types';
import { validateAction, readStringParam, readNumberParam, jsonResult, errorResult } from '../common';
import type { Scheduler } from '../../scheduler/scheduler';
import type { TriggerConfig, TaskTarget } from '../../scheduler/types';
import { Logger } from '../../utils/logger';

const log = new Logger('SchedulerTool');

const SCHEDULER_ACTIONS = ['list', 'create', 'update', 'pause', 'resume', 'delete', 'trigger', 'runs'] as const;
type SchedulerAction = (typeof SCHEDULER_ACTIONS)[number];

export interface SchedulerToolOptions {
    /** 调度器实例 */
    scheduler: Scheduler;
    /** 获取当前执行中的 sessionId（用于将任务绑定到创建它的 Agent 会话） */
    getSessionId?: () => string | undefined;
}

/**
 * 创建调度器工具
 */
export function createSchedulerTool(opts: SchedulerToolOptions): AnyTool {
    const { scheduler, getSessionId } = opts;

    return {
        name: 'scheduler',
        description: [
            '管理定时任务。用户想要设置定时自动执行的任务时使用此工具。',
            '',
            '动作:',
            '  list    — 列出所有定时任务及状态',
            '  create  — 创建新定时任务',
            '  update  — 编辑已有任务（修改名称/触发器/目标，需提供 taskId）',
            '  pause   — 暂停任务（需提供 taskId）',
            '  resume  — 恢复已暂停的任务（需提供 taskId）',
            '  delete  — 删除任务（需提供 taskId）',
            '  trigger — 立即执行一次（需提供 taskId）',
            '  runs    — 查看执行记录（可选 taskId 过滤）',
            '',
            '=== create 参数说明 ===',
            '',
            '★★★ 重要规则：当用户说「X分钟后」「X小时后」等相对时间时，必须使用 delayMinutes 参数！',
            '  例：「5分钟后提醒我」→ triggerType="once", delayMinutes=5',
            '  例：「1小时后检查」→ triggerType="once", delayMinutes=60',
            '  例：「半小时后」→ triggerType="once", delayMinutes=30',
            '  使用 delayMinutes 时，不需要填 triggerValue，系统自动根据服务器时间计算精确的执行时间。',
            '  绝对禁止自己计算 ISO 时间字符串用于相对时间场景！',
            '',
            '触发类型 triggerType:',
            '  cron     — 周期性，triggerValue 为 cron 表达式（如 "0 9 * * 1-5" 工作日早9点）',
            '  interval — 固定间隔，triggerValue 为间隔毫秒数（如 3600000 = 1小时）',
            '  once     — 一次性：',
            '    · 相对时间（推荐）: 仅填 delayMinutes（分钟数），不需要 triggerValue',
            '    · 绝对时间: triggerValue 为 ISO 时间字符串（如 "2026-02-08T09:00:00+08:00"）',
            '',
            '目标类型 targetType:',
            '  agent    — 用自然语言 prompt 触发 Agent 执行，targetValue 为 prompt 文本',
            '  workflow — 触发预设工作流，targetValue 为 workflowId',
            '',
            '示例1: 「10分钟后提醒我开会」→',
            '  action="create", name="开会提醒", triggerType="once", delayMinutes=10,',
            '  targetType="agent", targetValue="提醒用户：开会时间到了！"',
            '',
            '示例2: 「每天早上9点帮我检查日志」→',
            '  action="create", name="每日日志检查", triggerType="cron", triggerValue="0 9 * * *",',
            '  targetType="agent", targetValue="检查 logs/app.log 最近24小时的 ERROR 日志，汇总问题"',
        ].join('\n'),

        parameters: {
            action: {
                type: 'string',
                description: '动作: list | create | update | pause | resume | delete | trigger | runs',
                required: true,
                enum: [...SCHEDULER_ACTIONS],
            },
            taskId: {
                type: 'string',
                description: '任务 ID（update/pause/resume/delete/trigger/runs 时使用）',
                required: false,
            },
            name: {
                type: 'string',
                description: '任务名称（create 时必填）',
                required: false,
            },
            triggerType: {
                type: 'string',
                description: '触发类型: cron | interval | once（create 时必填）',
                required: false,
                enum: ['cron', 'interval', 'once'],
            },
            delayMinutes: {
                type: 'number',
                description: '【相对时间必填】延迟分钟数。用户说"X分钟后/X小时后"时必须使用此参数。如：5分钟后=5，1小时后=60，半小时后=30。使用此参数时不需要填 triggerValue',
                required: false,
            },
            triggerValue: {
                type: 'string',
                description: '触发值: cron 表达式 / 间隔毫秒数 / ISO 时间字符串。注意：相对时间场景请用 delayMinutes 而非此参数',
                required: false,
            },
            targetType: {
                type: 'string',
                description: '目标类型: agent | workflow（create 时必填）',
                required: false,
                enum: ['agent', 'workflow'],
            },
            targetValue: {
                type: 'string',
                description: '目标值: prompt 文本 / workflowId（create 时必填）',
                required: false,
            },
            targetParams: {
                type: 'object',
                description: '工作流参数（targetType=workflow 时可选）',
                required: false,
            },
        },

        async execute(args: Record<string, unknown>): Promise<ToolResult> {
            const action = validateAction(args, SCHEDULER_ACTIONS) as SchedulerAction;

            switch (action) {
                case 'list':
                    return handleList(scheduler);
                case 'create':
                    return handleCreate(scheduler, args, getSessionId);
                case 'update':
                    return handleUpdate(scheduler, args);
                case 'pause':
                    return handlePause(scheduler, args);
                case 'resume':
                    return handleResume(scheduler, args);
                case 'delete':
                    return handleDelete(scheduler, args);
                case 'trigger':
                    return handleTrigger(scheduler, args);
                case 'runs':
                    return handleRuns(scheduler, args);
                default:
                    return errorResult(`未知动作: ${action}`);
            }
        },
    };
}

// ========================
// 动作处理
// ========================

function handleList(scheduler: Scheduler): ToolResult {
    const tasks = scheduler.listTasks();

    return jsonResult({
        count: tasks.length,
        tasks: tasks.map(t => ({
            name: t.name,
            status: t.status,
            trigger: formatTrigger(t.trigger),
            target: formatTarget(t.target),
            lastRunAt: t.lastRunAt ? new Date(t.lastRunAt).toLocaleString('zh-CN') : '未执行',
            nextRunAt: t.nextRunAt ? new Date(t.nextRunAt).toLocaleString('zh-CN') : '-',
            runCount: t.runCount,
        })),
    });
}

function handleCreate(scheduler: Scheduler, args: Record<string, unknown>, getSessionId?: () => string | undefined): ToolResult {
    // 调试日志：记录 LLM 传入的原始参数
    log.info('create 调用参数:', {
        name: args.name,
        triggerType: args.triggerType,
        triggerValue: args.triggerValue,
        delayMinutes: args.delayMinutes,
        delaySeconds: args.delaySeconds,
        targetType: args.targetType,
        targetValue: typeof args.targetValue === 'string' ? args.targetValue.slice(0, 100) : args.targetValue,
    });

    const name = readStringParam(args, 'name', { required: true, label: '任务名称' });
    const triggerType = readStringParam(args, 'triggerType', { required: true, label: '触发类型' });
    const targetType = readStringParam(args, 'targetType', { required: true, label: '目标类型' });
    const targetValue = readStringParam(args, 'targetValue', { required: true, label: '目标值' });

    // 解析延迟参数（优先 delayMinutes > delaySeconds）
    const parseNum = (v: unknown): number | undefined => {
        if (typeof v === 'number' && v > 0) return v;
        if (typeof v === 'string') { const n = parseFloat(v); return n > 0 ? n : undefined; }
        return undefined;
    };
    const delayMinutes = parseNum(args.delayMinutes);
    const delaySeconds = parseNum(args.delaySeconds);

    // 构造触发器
    let trigger: TriggerConfig;
    switch (triggerType) {
        case 'cron': {
            const triggerValue = readStringParam(args, 'triggerValue', { required: true, label: '触发值' });
            trigger = { type: 'cron', expression: triggerValue };
            break;
        }
        case 'interval': {
            const triggerValue = readStringParam(args, 'triggerValue', { required: true, label: '触发值' });
            const ms = parseInt(triggerValue, 10);
            if (isNaN(ms) || ms < 10000) {
                return errorResult('间隔时间必须是大于 10000 的毫秒数');
            }
            trigger = { type: 'interval', intervalMs: ms };
            break;
        }
        case 'once': {
            // 优先级: delayMinutes > delaySeconds > triggerValue
            if (delayMinutes) {
                const totalMs = delayMinutes * 60 * 1000;
                const runAt = new Date(Date.now() + totalMs).toISOString();
                log.info(`使用 delayMinutes=${delayMinutes}，计算 runAt=${runAt}`);
                trigger = { type: 'once', runAt };
            } else if (delaySeconds) {
                const runAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
                log.info(`使用 delaySeconds=${delaySeconds}，计算 runAt=${runAt}`);
                trigger = { type: 'once', runAt };
            } else {
                const triggerValue = readStringParam(args, 'triggerValue', { required: true, label: '触发值' });
                log.info(`使用 triggerValue（绝对时间）: ${triggerValue}`);
                trigger = { type: 'once', runAt: triggerValue };
            }
            break;
        }
        default:
            return errorResult(`无效的触发类型: ${triggerType}，可选: cron / interval / once`);
    }

    // 构造目标
    let target: TaskTarget;
    switch (targetType) {
        case 'agent':
            target = { type: 'agent', prompt: targetValue };
            break;
        case 'workflow':
            target = {
                type: 'workflow',
                workflowId: targetValue,
                params: args.targetParams as Record<string, unknown> | undefined,
            };
            break;
        default:
            return errorResult(`无效的目标类型: ${targetType}，可选: agent / workflow`);
    }

    try {
        const task = scheduler.createTask({ name, trigger, target });
        // 自动绑定任务到创建它的 Agent 会话，使执行结果路由回原始 Agent
        const callerSessionId = getSessionId?.();
        if (callerSessionId && !task.sessionId) {
            scheduler.updateTask(task.id, { sessionId: callerSessionId });
            log.info(`Task auto-bound to session: ${callerSessionId}`);
        }
        const nextRunText = task.nextRunAt ? new Date(task.nextRunAt).toLocaleString('zh-CN') : '未定';
        return jsonResult({
            message: `定时任务「${task.name}」已创建，${formatTrigger(task.trigger)}，下次执行: ${nextRunText}`,
        });
    } catch (error) {
        return errorResult(`创建任务失败: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function handleUpdate(scheduler: Scheduler, args: Record<string, unknown>): ToolResult {
    const taskId = readStringParam(args, 'taskId', { required: true, label: '任务 ID' });

    const task = scheduler.getTask(taskId);
    if (!task) {
        return errorResult(`任务不存在: ${taskId}`);
    }

    const patch: Record<string, unknown> = {};

    // 可选：修改名称
    if (args.name !== undefined) {
        patch.name = readStringParam(args, 'name');
    }

    // 可选：修改触发器
    if (args.triggerType !== undefined) {
        const triggerType = readStringParam(args, 'triggerType');
        switch (triggerType) {
            case 'cron': {
                const triggerValue = readStringParam(args, 'triggerValue', { required: true, label: '触发值' });
                patch.trigger = { type: 'cron', expression: triggerValue };
                break;
            }
            case 'interval': {
                const triggerValue = readStringParam(args, 'triggerValue', { required: true, label: '触发值' });
                const ms = parseInt(triggerValue, 10);
                if (isNaN(ms) || ms < 10000) {
                    return errorResult('间隔时间必须是大于 10000 的毫秒数');
                }
                patch.trigger = { type: 'interval', intervalMs: ms };
                break;
            }
            case 'once': {
                const delayMinutes = typeof args.delayMinutes === 'number' ? args.delayMinutes : undefined;
                if (delayMinutes && delayMinutes > 0) {
                    const runAt = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString();
                    patch.trigger = { type: 'once', runAt };
                } else {
                    const triggerValue = readStringParam(args, 'triggerValue', { required: true, label: '触发值' });
                    patch.trigger = { type: 'once', runAt: triggerValue };
                }
                break;
            }
            default:
                return errorResult(`无效的触发类型: ${triggerType}`);
        }
    }

    // 可选：修改目标
    if (args.targetType !== undefined) {
        const targetType = readStringParam(args, 'targetType');
        const targetValue = readStringParam(args, 'targetValue', { required: true, label: '目标值' });
        switch (targetType) {
            case 'agent':
                patch.target = { type: 'agent', prompt: targetValue };
                break;
            case 'workflow':
                patch.target = {
                    type: 'workflow',
                    workflowId: targetValue,
                    params: args.targetParams as Record<string, unknown> | undefined,
                };
                break;
            default:
                return errorResult(`无效的目标类型: ${targetType}`);
        }
    }

    if (Object.keys(patch).length === 0) {
        return errorResult('未提供任何要修改的字段（可修改: name, triggerType/triggerValue, targetType/targetValue）');
    }

    try {
        const ok = scheduler.updateTask(taskId, patch);
        if (!ok) return errorResult('更新失败');

        const updated = scheduler.getTask(taskId)!;
        return jsonResult({
            success: true,
            message: `任务「${updated.name}」已更新`,
            updatedFields: Object.keys(patch),
            nextRunAt: updated.nextRunAt ? new Date(updated.nextRunAt).toLocaleString('zh-CN') : '-',
        });
    } catch (error) {
        return errorResult(`更新任务失败: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function handlePause(scheduler: Scheduler, args: Record<string, unknown>): ToolResult {
    const taskId = readStringParam(args, 'taskId', { required: true, label: '任务 ID' });
    const ok = scheduler.pauseTask(taskId);
    if (!ok) return errorResult('任务不存在或无法暂停');
    return jsonResult({ message: '任务已暂停' });
}

function handleResume(scheduler: Scheduler, args: Record<string, unknown>): ToolResult {
    const taskId = readStringParam(args, 'taskId', { required: true, label: '任务 ID' });
    const ok = scheduler.resumeTask(taskId);
    if (!ok) return errorResult('任务不存在或无法恢复');
    return jsonResult({ message: '任务已恢复' });
}

function handleDelete(scheduler: Scheduler, args: Record<string, unknown>): ToolResult {
    const taskId = readStringParam(args, 'taskId', { required: true, label: '任务 ID' });
    const ok = scheduler.deleteTask(taskId);
    if (!ok) return errorResult('任务不存在');
    return jsonResult({ message: '任务已删除' });
}

async function handleTrigger(scheduler: Scheduler, args: Record<string, unknown>): Promise<ToolResult> {
    const taskId = readStringParam(args, 'taskId', { required: true, label: '任务 ID' });
    const run = await scheduler.triggerTask(taskId);
    if (!run) return errorResult('任务不存在');
    return jsonResult({
        message: run.status === 'completed' ? '执行完成' : '执行失败',
        duration: run.duration ? `${(run.duration / 1000).toFixed(1)}s` : '-',
        error: run.error || undefined,
    });
}

function handleRuns(scheduler: Scheduler, args: Record<string, unknown>): ToolResult {
    const taskId = readStringParam(args, 'taskId');
    const runs = scheduler.getRuns(taskId, 20);

    return jsonResult({
        count: runs.length,
        runs: runs.map(r => ({
            id: r.id,
            taskName: r.taskName,
            status: r.status,
            startedAt: new Date(r.startedAt).toLocaleString('zh-CN'),
            duration: r.duration ? `${(r.duration / 1000).toFixed(1)}s` : '-',
            output: r.output?.slice(0, 200),
            error: r.error,
        })),
    });
}

// ========================
// 格式化辅助
// ========================

function formatTrigger(trigger: TriggerConfig): string {
    switch (trigger.type) {
        case 'cron':
            return `cron(${trigger.expression})`;
        case 'interval': {
            const seconds = trigger.intervalMs / 1000;
            if (seconds < 60) return `每 ${seconds} 秒`;
            if (seconds < 3600) return `每 ${(seconds / 60).toFixed(0)} 分钟`;
            if (seconds < 86400) return `每 ${(seconds / 3600).toFixed(1)} 小时`;
            return `每 ${(seconds / 86400).toFixed(1)} 天`;
        }
        case 'once':
            return `一次性: ${trigger.runAt}`;
    }
}

function formatTarget(target: TaskTarget): string {
    switch (target.type) {
        case 'agent':
            return `Agent: ${target.prompt.slice(0, 80)}${target.prompt.length > 80 ? '...' : ''}`;
        case 'workflow':
            return `Workflow: ${target.workflowId}`;
    }
}
