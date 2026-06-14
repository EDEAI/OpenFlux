/**
 * core scheduler
 * Manage the registration, triggering and execution of scheduled tasks
 * Use node-cron to implement cron expressions, and setInterval/setTimeout to implement interval and one-time tasks
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
// Configuration
// ========================

/** Task metadata for Agent execution callback */
export interface ScheduledTaskMeta {
    taskId: string;
    taskName: string;
}

export interface SchedulerConfig {
    /** Storage */
    store: SchedulerStore;
    /** Agent execution callback */
    onAgentExecute: (prompt: string, sessionId?: string, meta?: ScheduledTaskMeta) => Promise<string>;
    /** Event callback (notify Gateway to push to client) */
    onEvent?: (event: SchedulerEvent) => void;
}

// ========================
// Internal timer handle
// ========================

interface TaskTimer {
    /** cron tasks are simulated with setInterval, or setTimeout */
    timerId?: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>;
    /** interval ID used by cron (checked every minute) */
    cronCheckId?: ReturnType<typeof setInterval>;
}

// ========================
// scheduler
// ========================

export class Scheduler {
    private store: SchedulerStore;
    private onAgentExecute: SchedulerConfig['onAgentExecute'];
    private onEvent?: SchedulerConfig['onEvent'];
    /** Task table in memory */
    private tasks: Map<string, ScheduledTask> = new Map();
    /** Running timer */
    private timers: Map<string, TaskTimer> = new Map();
    /** The task being executed (to prevent concurrent execution of the same task) */
    private executing: Set<string> = new Set();
    private started = false;

    constructor(config: SchedulerConfig) {
        this.store = config.store;
        this.onAgentExecute = config.onAgentExecute;
        this.onEvent = config.onEvent;
    }

    /**
     * Start the scheduler (load persistent tasks, start timer)
     */
    start(): void {
        if (this.started) return;
        this.started = true;

        // Load tasks from file
        const savedTasks = this.store.loadTasks();
        for (const task of savedTasks) {
            // Recalculate nextRunAt (fixes old approximation)
            task.nextRunAt = this.calculateNextRun(task.trigger);
            this.tasks.set(task.id, task);
            if (task.status === 'active') {
                this.scheduleTask(task);
            }
        }
        // Persistence modified nextRunAt
        if (savedTasks.length > 0) {
            this.store.saveTasks([...this.tasks.values()]);
        }

        log.info(`Scheduler started, loaded ${savedTasks.length} tasks, ${savedTasks.filter(t => t.status === 'active').length} active`);
    }

    /**
     * Stop the scheduler (clear all timers)
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
    // task management
    // ========================

    /**
     * Create task
     */
    createTask(params: {
        name: string;
        trigger: TriggerConfig;
        target: TaskTarget;
        channel?: string;
        sessionId?: string;
        agentId?: string;
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
            sessionId: params.sessionId,
            agentId: params.agentId,
        };

        // Calculate next execution time
        task.nextRunAt = this.calculateNextRun(task.trigger);

        this.tasks.set(task.id, task);
        this.store.saveTask(task);

        // Start timer
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
     * Get tasks
     */
    getTask(taskId: string): ScheduledTask | undefined {
        return this.tasks.get(taskId);
    }

    /**
     * Update task properties (partial update)
     * Support modifying name, trigger, target, sessionId
     * If the trigger is modified, the timer will be automatically rescheduled.
     */
    updateTask(taskId: string, patch: Partial<Pick<ScheduledTask, 'name' | 'trigger' | 'target' | 'sessionId' | 'agentId'>>): boolean {
        const task = this.tasks.get(taskId);
        if (!task) return false;

        const triggerChanged = patch.trigger !== undefined;

        Object.assign(task, patch);

        // Trigger change -> Recalculate the next execution time and reschedule
        if (triggerChanged) {
            task.nextRunAt = this.calculateNextRun(task.trigger);
            if ((task.status === 'completed' || task.status === 'error') && task.nextRunAt) {
                task.status = 'active';
                task.failCount = 0;
            }
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
     * list all tasks
     */
    listTasks(): ScheduledTask[] {
        return Array.from(this.tasks.values())
            .sort((a, b) => b.createdAt - a.createdAt);
    }

    /**
     * Pause task
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
     * recovery task
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
     * Delete task
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
     * Manual trigger (execute immediately, does not affect the timing plan)
     */
    async triggerTask(taskId: string): Promise<TaskRun | null> {
        const task = this.tasks.get(taskId);
        if (!task) return null;

        if (task.status !== 'active' && task.status !== 'error') {
            log.warn(`Task cannot be manually triggered in current status: ${task.name}`, { status: task.status });
            return null;
        }

        // Prevent concurrent execution (consistent with onTrigger)
        if (this.executing.has(task.id)) {
            log.warn(`Task is currently running, skipping manual trigger: ${task.name}`);
            return null;
        }

        return this.executeTask(task, 'manual');
    }

    /**
     * Get execution record
     */
    getRuns(taskId?: string, limit: number = 50): TaskRun[] {
        if (taskId) {
            return this.store.loadRunsByTaskId(taskId, limit);
        }
        return this.store.loadRuns(limit);
    }

    // ========================
    // Internal: timer management
    // ========================

    /**
     * Start a timer for a task
     */
    private scheduleTask(task: ScheduledTask): void {
        // Clear existing timers first
        this.clearTimer(task.id);

        const timer: TaskTimer = {};

        switch (task.trigger.type) {
            case 'cron': {
                const cronTrigger = task.trigger as import('./types').CronTrigger;
                // Simple cron: Check for a match every minute
                timer.cronCheckId = setInterval(() => {
                    if (this.matchesCron(cronTrigger.expression, new Date())) {
                        this.onTrigger(task);
                    }
                }, 60_000);
                // Check the current minute now
                if (this.matchesCron(cronTrigger.expression, new Date())) {
                    // Delay 1 second to avoid triggering immediately on startup
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
                        void this.onTrigger(task);
                    }, delay);
                } else {
                    // Expired, mark directly as completed
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
     * Clear task timer
     */
    private clearTimer(taskId: string): void {
        const timer = this.timers.get(taskId);
        if (!timer) return;

        if (timer.timerId) clearTimeout(timer.timerId);
        if (timer.cronCheckId) clearInterval(timer.cronCheckId);

        this.timers.delete(taskId);
    }

    /**
     * Timer trigger callback
     */
    private async onTrigger(task: ScheduledTask): Promise<void> {
        // Prevent concurrent execution
        if (this.executing.has(task.id)) {
            log.warn(`Task is currently running, skipping: ${task.name}`);
            return;
        }

        // Check task status
        const current = this.tasks.get(task.id);
        if (!current || current.status !== 'active') return;

        await this.executeTask(current, 'scheduled');
    }

    /**
     * perform tasks
     */
    private async executeTask(task: ScheduledTask, source: 'scheduled' | 'manual'): Promise<TaskRun> {
        this.executing.add(task.id);
        const sessionId = task.sessionId || `cron:${task.id}`;
        if (!task.sessionId) {
            task.sessionId = sessionId;
            this.store.saveTask(task);
        }

        const run: TaskRun = {
            id: randomUUID(),
            taskId: task.id,
            taskName: task.name,
            status: 'running',
            startedAt: Date.now(),
            sessionId,
        };

        // Write the running record first
        this.store.appendRun(run);

        this.emit({
            type: 'run_start',
            taskId: task.id,
            taskName: task.name,
            runId: run.id,
            sessionId,
            timestamp: Date.now(),
        });

        log.info(`Task execution started: ${task.name} (run: ${run.id})`);

        try {
            let output = '';

            // Use associated session if available, otherwise fall back to temporary session
            const meta: ScheduledTaskMeta = { taskId: task.id, taskName: task.name };

            if (task.target.type === 'agent') {
                // Agent conversation mode
                output = await this.onAgentExecute(task.target.prompt, sessionId, meta);
            } else if (task.target.type === 'workflow') {
                // Workflow mode - calling workflow tools through Agent
                const prompt = `请执行工作流 "${task.target.workflowId}"，参数: ${JSON.stringify(task.target.params || {})}`;
                output = await this.onAgentExecute(prompt, sessionId, meta);
            }

            // success
            run.status = 'completed';
            run.completedAt = Date.now();
            run.duration = run.completedAt - run.startedAt;
            run.output = output.slice(0, 2000); // Truncate to avoid being too long

            task.lastRunAt = run.startedAt;
            task.runCount++;
            task.failCount = 0;
            const nextRunAt = this.calculateNextRun(task.trigger);
            const shouldFinalizeOneTime =
                task.trigger.type === 'once'
                && (source === 'scheduled' || task.status === 'error' || !nextRunAt);
            task.nextRunAt = shouldFinalizeOneTime ? undefined : nextRunAt;
            if (shouldFinalizeOneTime) {
                task.status = 'completed';
                this.clearTimer(task.id);
            }
            this.store.saveTask(task);
            this.store.updateRun(run.id, run);

            this.emit({
                type: 'run_complete',
                taskId: task.id,
                taskName: task.name,
                runId: run.id,
                sessionId,
                timestamp: Date.now(),
            });

            log.info(`Task execution completed: ${task.name} (${run.duration}ms)`);

        } catch (error) {
            // fail
            const errorMsg = error instanceof Error ? error.message : String(error);
            run.status = 'failed';
            run.completedAt = Date.now();
            run.duration = run.completedAt - run.startedAt;
            run.error = errorMsg;

            task.lastRunAt = run.startedAt;
            task.runCount++;
            task.failCount++;
            const nextRunAt = this.calculateNextRun(task.trigger);
            const shouldFinalizeOneTime =
                task.trigger.type === 'once'
                && (source === 'scheduled' || task.status === 'error' || !nextRunAt);
            task.nextRunAt = shouldFinalizeOneTime ? undefined : nextRunAt;
            if (shouldFinalizeOneTime) {
                task.status = 'error';
                this.clearTimer(task.id);
            }

            // Too many consecutive failures, automatic suspension
            if (!shouldFinalizeOneTime && task.maxFailCount > 0 && task.failCount >= task.maxFailCount) {
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
                sessionId,
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
    // Internal: Cron parsing (easy version)
    // ========================

    /**
     * Parse cron expression to match the current time
     * Supports 5-segment format: minute, hour, day, month, week
     * Supports 6-segment format: seconds, minutes, hours, days, months, weeks (automatically skip the seconds segment)
     * support: *, - /
     */
    private matchesCron(expression: string, now: Date): boolean {
        let parts = expression.trim().split(/\s+/);
        // 6-segment format: remove the seconds field (only do minute-level scheduling)
        if (parts.length === 6) parts = parts.slice(1);
        if (parts.length !== 5) return false;

        const [minuteExpr, hourExpr, dayExpr, monthExpr, weekdayExpr] = parts;
        const minute = now.getMinutes();
        const hour = now.getHours();
        const day = now.getDate();
        const month = now.getMonth() + 1;
        const weekday = now.getDay(); // 0=Sunday

        return (
            this.matchCronField(minuteExpr, minute, 0, 59) &&
            this.matchCronField(hourExpr, hour, 0, 23) &&
            this.matchCronField(dayExpr, day, 1, 31) &&
            this.matchCronField(monthExpr, month, 1, 12) &&
            this.matchCronField(weekdayExpr, weekday, 0, 7) // 0 and 7 both represent Sunday
        );
    }

    /**
     * Match a single cron field
     */
    private matchCronField(expr: string, value: number, min: number, max: number): boolean {
        // Handle comma separated multiple values
        const parts = expr.split(',');
        return parts.some(part => this.matchCronPart(part.trim(), value, min, max));
    }

    private matchCronPart(part: string, value: number, min: number, max: number): boolean {
        // *
        if (part === '*') return true;

        // */n (step size)
        if (part.startsWith('*/')) {
            const step = parseInt(part.slice(2), 10);
            if (isNaN(step) || step <= 0) return false;
            return value % step === 0;
        }

        // n-m (range)
        if (part.includes('-')) {
            const [startStr, endStr] = part.split('-');
            const start = parseInt(startStr, 10);
            const end = parseInt(endStr, 10);
            if (isNaN(start) || isNaN(end)) return false;
            return value >= start && value <= end;
        }

        // n-m/s (range + step size)
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

        // pure numbers
        const num = parseInt(part, 10);
        if (!isNaN(num)) {
            // Special treatment for Sunday: both 0 and 7 match
            if (max === 7 && (num === 0 || num === 7) && (value === 0 || value === 7)) {
                return true;
            }
            return value === num;
        }

        return false;
    }

    // ========================
    // Internal: tool methods
    // ========================

    /**
     * Calculate next execution time
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
     * Accurately calculate the next execution time of cron
     * Scan minute by minute from the current time, up to 366 days
     */
    private getNextCronTime(expression: string, nowMs: number): number | undefined {
        const start = new Date(nowMs);
        // Start from next minute (seconds reset to zero)
        start.setSeconds(0, 0);
        start.setMinutes(start.getMinutes() + 1);

        const maxIterations = 366 * 24 * 60; // Scan up to 366 days
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
     * Send event
     */
    private emit(event: SchedulerEvent): void {
        this.onEvent?.(event);
    }
}
