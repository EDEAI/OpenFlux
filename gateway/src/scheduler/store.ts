/**
 * 调度任务持久化存储
 * JSON 文件读写，与 SessionStore 风格一致
 */

import fs from 'node:fs';
import path from 'node:path';
import { Logger } from '../utils/logger';
import type { ScheduledTask, TaskRun } from './types';

const log = new Logger('SchedulerStore');

export interface SchedulerStoreConfig {
    /** 存储目录 */
    storePath: string;
}

/**
 * 调度任务存储
 */
export class SchedulerStore {
    private tasksFile: string;
    private runsFile: string;

    constructor(config: SchedulerStoreConfig) {
        const dir = path.join(config.storePath, 'scheduler');
        // 确保目录存在
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        this.tasksFile = path.join(dir, 'tasks.json');
        this.runsFile = path.join(dir, 'runs.json');
        log.info(`Scheduler store initialized: ${dir}`);
    }

    // ========================
    // 任务 CRUD
    // ========================

    /** 读取所有任务 */
    loadTasks(): ScheduledTask[] {
        try {
            if (fs.existsSync(this.tasksFile)) {
                const data = fs.readFileSync(this.tasksFile, 'utf-8');
                return JSON.parse(data) as ScheduledTask[];
            }
        } catch (error) {
            log.error('Failed to read tasks file', { error });
        }
        return [];
    }

    /** 保存所有任务 */
    saveTasks(tasks: ScheduledTask[]): void {
        try {
            fs.writeFileSync(this.tasksFile, JSON.stringify(tasks, null, 2), 'utf-8');
        } catch (error) {
            log.error('Failed to save tasks file', { error });
        }
    }

    /** 保存单个任务（更新或新增） */
    saveTask(task: ScheduledTask): void {
        const tasks = this.loadTasks();
        const index = tasks.findIndex(t => t.id === task.id);
        if (index >= 0) {
            tasks[index] = task;
        } else {
            tasks.push(task);
        }
        this.saveTasks(tasks);
    }

    /** 删除任务 */
    deleteTask(taskId: string): boolean {
        const tasks = this.loadTasks();
        const filtered = tasks.filter(t => t.id !== taskId);
        if (filtered.length === tasks.length) return false;
        this.saveTasks(filtered);
        return true;
    }

    // ========================
    // 执行记录
    // ========================

    /** 读取执行记录（最新在前，限制数量） */
    loadRuns(limit: number = 100): TaskRun[] {
        try {
            if (fs.existsSync(this.runsFile)) {
                const data = fs.readFileSync(this.runsFile, 'utf-8');
                const runs = JSON.parse(data) as TaskRun[];
                // 按开始时间降序，截取最新
                return runs
                    .sort((a, b) => b.startedAt - a.startedAt)
                    .slice(0, limit);
            }
        } catch (error) {
            log.error('Failed to read execution records', { error });
        }
        return [];
    }

    /** 按任务 ID 获取执行记录 */
    loadRunsByTaskId(taskId: string, limit: number = 20): TaskRun[] {
        return this.loadRuns(500).filter(r => r.taskId === taskId).slice(0, limit);
    }

    /** 追加执行记录 */
    appendRun(run: TaskRun): void {
        try {
            let runs: TaskRun[] = [];
            if (fs.existsSync(this.runsFile)) {
                const data = fs.readFileSync(this.runsFile, 'utf-8');
                runs = JSON.parse(data) as TaskRun[];
            }
            runs.push(run);
            // 只保留最近 500 条
            if (runs.length > 500) {
                runs = runs.sort((a, b) => b.startedAt - a.startedAt).slice(0, 500);
            }
            fs.writeFileSync(this.runsFile, JSON.stringify(runs, null, 2), 'utf-8');
        } catch (error) {
            log.error('Failed to save execution records', { error });
        }
    }

    /** 更新执行记录 */
    updateRun(runId: string, updates: Partial<TaskRun>): void {
        try {
            if (!fs.existsSync(this.runsFile)) return;
            const data = fs.readFileSync(this.runsFile, 'utf-8');
            const runs = JSON.parse(data) as TaskRun[];
            const index = runs.findIndex(r => r.id === runId);
            if (index >= 0) {
                runs[index] = { ...runs[index], ...updates };
                fs.writeFileSync(this.runsFile, JSON.stringify(runs, null, 2), 'utf-8');
            }
        } catch (error) {
            log.error('Failed to update execution record', { error });
        }
    }
}
