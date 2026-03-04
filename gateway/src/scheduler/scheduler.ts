/**
 * 核心调度器
 * 管理定时任务的注册、触发、执行
 * 使用 node-cron 实现 cron 表达式，setInterval/setTimeout 实现间隔和一次性任务
 */

import { randomUUID } from 'crypto';
import { Logger } from '../utils/logger';
import { SchedulerStore } from './store';
import type {
    ScheduledTask,
    TaskRun,
    TriggerConfig,
    TaskTarget,
    TaskStatus,
    SchedulerEvent,
} from './types';

const log = new Logger('Scheduler');

// ========================
// 配置
// ========================

/** Agent 执行回调的任务元数据 */
export interface ScheduledTaskMeta {
    taskId: string;
    taskName: string;
}

export interface SchedulerConfig {
    /** 存储 */
    store: SchedulerStore;
    /** Agent 执行回调 */
    onAgentExecute: (prompt: string, sessionId?: string, meta?: ScheduledTaskMeta) => Promise<string>;
    /** 事件回调（通知 Gateway 推送给客户端） */
    onEvent?: (event: SchedulerEvent) => void;
}

// ========================
// 内部定时器句柄
// ========================

interface TaskTimer {
    /** cron 任务用 setInterval 模拟，或 setTimeout */
    timerId?: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>;
    /** cron 用的 interval ID（每分钟检查一次） */
    cronCheckId?: ReturnType<typeof setInterval>;
}

// ========================
// 调度器
// ========================

export class Scheduler {
    private store: SchedulerStore;
    private onAgentExecute: SchedulerConfig['onAgentExecute'];
    private onEvent?: SchedulerConfig['onEvent'];
    /** 内存中的任务表 */
    private tasks: Map<string, ScheduledTask> = new Map();
    /** 运行中的定时器 */
    private timers: Map<string, TaskTimer> = new Map();
    /** 正在执行的任务（防止同一任务并发执行） */
    private executing: Set<string> = new Set();
    private started = false;

    constructor(config: SchedulerConfig) {
        this.store = config.store;
        this.onAgentExecute = config.onAgentExecute;
        this.onEvent = config.onEvent;
    }

    /**
     * 启动调度器（加载持久化任务，启动定时器）
     */
    start(): void {
        if (this.started) return;
        this.started = true;

        // 从文件加载任务
        const savedTasks = this.store.loadTasks();
        for (const task of savedTasks) {
            // 重新计算 nextRunAt（修正旧版近似值）
            task.nextRunAt = this.calculateNextRun(task.trigger);
            this.tasks.set(task.id, task);
            if (task.status === 'active') {
                this.scheduleTask(task);
            }
        }
        // 持久化修正后的 nextRunAt
        if (savedTasks.length > 0) {
            this.store.saveTasks([...this.tasks.values()]);
        }

        log.info(`Scheduler started, loaded ${savedTasks.length} tasks, ${savedTasks.filter(t => t.status === 'active').length} active`);
    }

    /**
     * 停止调度器（清除所有定时器）
     */
    stop(): void {
        for (const taskId of this.timers.keys()) {
            this.clearTimer(taskId);
        }
        this.timers.clear();
        this.started = false;
        log.info('Scheduler stopped');
    }

    // ========================
    // 任务管理
    // ========================

    /**
     * 创建任务
     */
    createTask(params: {
        name: string;
        trigger: TriggerConfig;
        target: TaskTarget;
        channel?: string;
    }): ScheduledTask {
        const task: ScheduledTask = {
            id: randomUUID(),
            name: params.name,
            trigger: params.trigger,
            target: params.target,
            status: 'active',
            createdAt: Date.now(),
            runCount: 0,
            failCount: 0,
            maxFailCount: 5,
            channel: params.channel,
        };

        // 计算下次执行时间
        task.nextRunAt = this.calculateNextRun(task.trigger);

        this.tasks.set(task.id, task);
        this.store.saveTask(task);

        // 启动定时器
        if (this.started) {
            this.scheduleTask(task);
        }

        this.emit({
            type: 'task_created',
            taskId: task.id,
            taskName: task.name,
            timestamp: Date.now(),
        });

        log.info(`Task created: ${task.name} (${task.id})`, { trigger: task.trigger.type });
        return task;
    }

    /**
     * 获取任务
     */
    getTask(taskId: string): ScheduledTask | undefined {
        return this.tasks.get(taskId);
    }

    /**
     * 更新任务属性（部分更新）
     * 支持修改 name、trigger、target、sessionId
     * 如果修改了 trigger，会自动重新调度定时器
     */
    updateTask(taskId: string, patch: Partial<Pick<ScheduledTask, 'name' | 'trigger' | 'target' | 'sessionId'>>): boolean {
        const task = this.tasks.get(taskId);
        if (!task) return false;

        const triggerChanged = patch.trigger !== undefined;

        Object.assign(task, patch);

        // 触发器变更 → 重新计算下次执行时间并重新调度
        if (triggerChanged) {
            task.nextRunAt = this.calculateNextRun(task.trigger);
            if (this.started && task.status === 'active') {
                this.scheduleTask(task);
            }
        }

        this.store.saveTask(task);

        this.emit({
            type: 'task_updated',
            taskId: task.id,
            taskName: task.name,
            timestamp: Date.now(),
        });

        log.info(`Task updated: ${task.name} (${task.id})`, { fields: Object.keys(patch) });
        return true;
    }

    /**
     * 列出所有任务
     */
    listTasks(): ScheduledTask[] {
        return Array.from(this.tasks.values())
            .sort((a, b) => b.createdAt - a.createdAt);
    }

    /**
     * 暂停任务
     */
    pauseTask(taskId: string): boolean {
        const task = this.tasks.get(taskId);
        if (!task || task.status !== 'active') return false;

        task.status = 'paused';
        this.clearTimer(taskId);
        this.store.saveTask(task);

        this.emit({
            type: 'task_paused',
            taskId: task.id,
            taskName: task.name,
            timestamp: Date.now(),
        });

        log.info(`Task paused: ${task.name}`);
        return true;
    }

    /**
     * 恢复任务
     */
    resumeTask(taskId: string): boolean {
        const task = this.tasks.get(taskId);
        if (!task || task.status !== 'paused') return false;

        task.status = 'active';
        task.failCount = 0;
        task.nextRunAt = this.calculateNextRun(task.trigger);
        this.store.saveTask(task);

        if (this.started) {
            this.scheduleTask(task);
        }

        this.emit({
            type: 'task_resumed',
            taskId: task.id,
            taskName: task.name,
            timestamp: Date.now(),
        });

        log.info(`Task resumed: ${task.name}`);
        return true;
    }

    /**
     * 删除任务
     */
    deleteTask(taskId: string): boolean {
        const task = this.tasks.get(taskId);
        if (!task) return false;

        this.clearTimer(taskId);
        this.tasks.delete(taskId);
        this.store.deleteTask(taskId);

        this.emit({
            type: 'task_deleted',
            taskId: task.id,
            taskName: task.name,
            timestamp: Date.now(),
        });

        log.info(`Task deleted: ${task.name}`);
        return true;
    }

    /**
     * 手动触发（立即执行一次，不影响定时计划）
     */
    async triggerTask(taskId: string): Promise<TaskRun | null> {
        const task = this.tasks.get(taskId);
        if (!task) return null;
        return this.executeTask(task);
    }

    /**
     * 获取执行记录
     */
    getRuns(taskId?: string, limit: number = 50): TaskRun[] {
        if (taskId) {
            return this.store.loadRunsByTaskId(taskId, limit);
        }
        return this.store.loadRuns(limit);
    }

    // ========================
    // 内部：定时器管理
    // ========================

    /**
     * 为任务启动定时器
     */
    private scheduleTask(task: ScheduledTask): void {
        // 先清除已有定时器
        this.clearTimer(task.id);

        const timer: TaskTimer = {};

        switch (task.trigger.type) {
            case 'cron': {
                const cronTrigger = task.trigger as import('./types').CronTrigger;
                // 简易 cron：每分钟检查一次是否匹配
                timer.cronCheckId = setInterval(() => {
                    if (this.matchesCron(cronTrigger.expression, new Date())) {
                        this.onTrigger(task);
                    }
                }, 60_000);
                // 立即检查一次当前分钟
                if (this.matchesCron(cronTrigger.expression, new Date())) {
                    // 延迟 1 秒避免启动时立即触发
                    setTimeout(() => this.onTrigger(task), 1000);
                }
                break;
            }

            case 'interval':
                timer.timerId = setInterval(() => {
                    this.onTrigger(task);
                }, task.trigger.intervalMs);
                break;

            case 'once': {
                const runAt = typeof task.trigger.runAt === 'string'
                    ? new Date(task.trigger.runAt).getTime()
                    : task.trigger.runAt;
                const delay = runAt - Date.now();
                if (delay > 0) {
                    timer.timerId = setTimeout(() => {
                        this.onTrigger(task);
                        // 一次性任务执行后标记为已完成
                        task.status = 'completed';
                        this.store.saveTask(task);
                    }, delay);
                } else {
                    // 已过期，直接标记完成
                    log.warn(`One-time task expired: ${task.name}`);
                    task.status = 'completed';
                    this.store.saveTask(task);
                }
                break;
            }
        }

        this.timers.set(task.id, timer);
    }

    /**
     * 清除任务定时器
     */
    private clearTimer(taskId: string): void {
        const timer = this.timers.get(taskId);
        if (!timer) return;

        if (timer.timerId) clearTimeout(timer.timerId);
        if (timer.cronCheckId) clearInterval(timer.cronCheckId);

        this.timers.delete(taskId);
    }

    /**
     * 定时器触发回调
     */
    private async onTrigger(task: ScheduledTask): Promise<void> {
        // 防止并发执行
        if (this.executing.has(task.id)) {
            log.warn(`Task is currently running, skipping: ${task.name}`);
            return;
        }

        // 检查任务状态
        const current = this.tasks.get(task.id);
        if (!current || current.status !== 'active') return;

        await this.executeTask(current);
    }

    /**
     * 执行任务
     */
    private async executeTask(task: ScheduledTask): Promise<TaskRun> {
        this.executing.add(task.id);

        const run: TaskRun = {
            id: randomUUID(),
            taskId: task.id,
            taskName: task.name,
            status: 'running',
            startedAt: Date.now(),
        };

        // 先写入运行记录
        this.store.appendRun(run);

        this.emit({
            type: 'run_start',
            taskId: task.id,
            taskName: task.name,
            runId: run.id,
            timestamp: Date.now(),
        });

        log.info(`Task execution started: ${task.name} (run: ${run.id})`);

        try {
            let output = '';

            // 使用关联会话（如有），否则回退到临时 session
            const sessionId = task.sessionId || `cron:${task.id}`;
            const meta: ScheduledTaskMeta = { taskId: task.id, taskName: task.name };

            if (task.target.type === 'agent') {
                // Agent 对话模式
                output = await this.onAgentExecute(task.target.prompt, sessionId, meta);
            } else if (task.target.type === 'workflow') {
                // Workflow 模式 - 通过 Agent 调用 workflow 工具
                const prompt = `请执行工作流 "${task.target.workflowId}"，参数: ${JSON.stringify(task.target.params || {})}`;
                output = await this.onAgentExecute(prompt, sessionId, meta);
            }

            // 成功
            run.status = 'completed';
            run.completedAt = Date.now();
            run.duration = run.completedAt - run.startedAt;
            run.output = output.slice(0, 2000); // 截断避免过长

            task.lastRunAt = run.startedAt;
            task.runCount++;
            task.failCount = 0;
            task.nextRunAt = this.calculateNextRun(task.trigger);
            this.store.saveTask(task);
            this.store.updateRun(run.id, run);

            this.emit({
                type: 'run_complete',
                taskId: task.id,
                taskName: task.name,
                runId: run.id,
                timestamp: Date.now(),
            });

            log.info(`Task execution completed: ${task.name} (${run.duration}ms)`);

        } catch (error) {
            // 失败
            const errorMsg = error instanceof Error ? error.message : String(error);
            run.status = 'failed';
            run.completedAt = Date.now();
            run.duration = run.completedAt - run.startedAt;
            run.error = errorMsg;

            task.lastRunAt = run.startedAt;
            task.runCount++;
            task.failCount++;
            task.nextRunAt = this.calculateNextRun(task.trigger);

            // 连续失败过多，自动暂停
            if (task.maxFailCount > 0 && task.failCount >= task.maxFailCount) {
                task.status = 'paused';
                log.warn(`Task failed ${task.failCount} times consecutively, auto-paused: ${task.name}`);
                this.clearTimer(task.id);
            }

            this.store.saveTask(task);
            this.store.updateRun(run.id, run);

            this.emit({
                type: 'run_failed',
                taskId: task.id,
                taskName: task.name,
                runId: run.id,
                error: errorMsg,
                timestamp: Date.now(),
            });

            log.error(`Task execution failed: ${task.name}`, { error: errorMsg });
        } finally {
            this.executing.delete(task.id);
        }

        return run;
    }

    // ========================
    // 内部：Cron 解析（简易版）
    // ========================

    /**
     * 解析 cron 表达式，匹配当前时间
     * 支持 5 段格式: 分 时 日 月 周
     * 支持 6 段格式: 秒 分 时 日 月 周（自动跳过秒段）
     * 支持: * , - /
     */
    private matchesCron(expression: string, now: Date): boolean {
        let parts = expression.trim().split(/\s+/);
        // 6 段格式：去掉秒字段（只做分钟级调度）
        if (parts.length === 6) parts = parts.slice(1);
        if (parts.length !== 5) return false;

        const [minuteExpr, hourExpr, dayExpr, monthExpr, weekdayExpr] = parts;
        const minute = now.getMinutes();
        const hour = now.getHours();
        const day = now.getDate();
        const month = now.getMonth() + 1;
        const weekday = now.getDay(); // 0=周日

        return (
            this.matchCronField(minuteExpr, minute, 0, 59) &&
            this.matchCronField(hourExpr, hour, 0, 23) &&
            this.matchCronField(dayExpr, day, 1, 31) &&
            this.matchCronField(monthExpr, month, 1, 12) &&
            this.matchCronField(weekdayExpr, weekday, 0, 7) // 0和7都表示周日
        );
    }

    /**
     * 匹配单个 cron 字段
     */
    private matchCronField(expr: string, value: number, min: number, max: number): boolean {
        // 处理逗号分隔的多个值
        const parts = expr.split(',');
        return parts.some(part => this.matchCronPart(part.trim(), value, min, max));
    }

    private matchCronPart(part: string, value: number, min: number, max: number): boolean {
        // *
        if (part === '*') return true;

        // */n (步长)
        if (part.startsWith('*/')) {
            const step = parseInt(part.slice(2), 10);
            if (isNaN(step) || step <= 0) return false;
            return value % step === 0;
        }

        // n-m (范围)
        if (part.includes('-')) {
            const [startStr, endStr] = part.split('-');
            const start = parseInt(startStr, 10);
            const end = parseInt(endStr, 10);
            if (isNaN(start) || isNaN(end)) return false;
            return value >= start && value <= end;
        }

        // n-m/s (范围+步长)
        if (part.includes('/')) {
            const [rangeStr, stepStr] = part.split('/');
            const step = parseInt(stepStr, 10);
            if (isNaN(step) || step <= 0) return false;

            if (rangeStr.includes('-')) {
                const [startStr, endStr] = rangeStr.split('-');
                const start = parseInt(startStr, 10);
                const end = parseInt(endStr, 10);
                if (isNaN(start) || isNaN(end)) return false;
                return value >= start && value <= end && (value - start) % step === 0;
            }
        }

        // 纯数字
        const num = parseInt(part, 10);
        if (!isNaN(num)) {
            // 周日特殊处理: 0 和 7 都匹配
            if (max === 7 && (num === 0 || num === 7) && (value === 0 || value === 7)) {
                return true;
            }
            return value === num;
        }

        return false;
    }

    // ========================
    // 内部：工具方法
    // ========================

    /**
     * 计算下次执行时间
     */
    private calculateNextRun(trigger: TriggerConfig): number | undefined {
        const now = Date.now();

        switch (trigger.type) {
            case 'interval':
                return now + trigger.intervalMs;
            case 'once': {
                const runAt = typeof trigger.runAt === 'string'
                    ? new Date(trigger.runAt).getTime()
                    : trigger.runAt;
                return runAt > now ? runAt : undefined;
            }
            case 'cron':
                return this.getNextCronTime(trigger.expression, now);
        }
    }

    /**
     * 精确计算 cron 下一次执行时间
     * 从当前时间往后逐分钟扫描，最多扫描 366 天
     */
    private getNextCronTime(expression: string, nowMs: number): number | undefined {
        const start = new Date(nowMs);
        // 从下一分钟开始（秒归零）
        start.setSeconds(0, 0);
        start.setMinutes(start.getMinutes() + 1);

        const maxIterations = 366 * 24 * 60; // 最多扫描 366 天
        const candidate = new Date(start);

        for (let i = 0; i < maxIterations; i++) {
            if (this.matchesCron(expression, candidate)) {
                return candidate.getTime();
            }
            candidate.setMinutes(candidate.getMinutes() + 1);
        }

        return undefined;
    }

    /**
     * 发送事件
     */
    private emit(event: SchedulerEvent): void {
        this.onEvent?.(event);
    }
}
