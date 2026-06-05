/**
 * Scheduling task persistent storage
 * JSON file reading and writing, consistent with SessionStore style
 */

import fs from 'node:fs';
import path from 'node:path';
import { Logger } from '../utils/logger';
import type { ScheduledTask, TaskRun } from './types';

const log = new Logger('SchedulerStore');

export interface SchedulerStoreConfig {
    /** Storage directory */
    storePath: string;
}

/**
 * Scheduling task storage
 */
export class SchedulerStore {
    private tasksFile: string;
    private runsFile: string;

    constructor(config: SchedulerStoreConfig) {
        const dir = path.join(config.storePath, 'scheduler');
        // Make sure the directory exists
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        this.tasksFile = path.join(dir, 'tasks.json');
        this.runsFile = path.join(dir, 'runs.json');
        log.info(`Scheduler store initialized: ${dir}`);
    }

    // ========================
    // Task CRUD
    // ========================

    /** Read all tasks */
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

    /** Save all tasks */
    saveTasks(tasks: ScheduledTask[]): void {
        try {
            fs.writeFileSync(this.tasksFile, JSON.stringify(tasks, null, 2), 'utf-8');
        } catch (error) {
            log.error('Failed to save tasks file', { error });
        }
    }

    /** Save a single task (updated or new) */
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

    /** Delete task */
    deleteTask(taskId: string): boolean {
        const tasks = this.loadTasks();
        const filtered = tasks.filter(t => t.id !== taskId);
        if (filtered.length === tasks.length) return false;
        this.saveTasks(filtered);
        return true;
    }

    // ========================
    // Execution record
    // ========================

    /** Read execution records (latest first, limited number) */
    loadRuns(limit: number = 100): TaskRun[] {
        try {
            if (fs.existsSync(this.runsFile)) {
                const data = fs.readFileSync(this.runsFile, 'utf-8');
                const runs = JSON.parse(data) as TaskRun[];
                // In descending order of start time, intercept the latest
                return runs
                    .sort((a, b) => b.startedAt - a.startedAt)
                    .slice(0, limit);
            }
        } catch (error) {
            log.error('Failed to read execution records', { error });
        }
        return [];
    }

    /** Get execution records by task ID */
    loadRunsByTaskId(taskId: string, limit: number = 20): TaskRun[] {
        return this.loadRuns(500).filter(r => r.taskId === taskId).slice(0, limit);
    }

    /** Add execution record */
    appendRun(run: TaskRun): void {
        try {
            let runs: TaskRun[] = [];
            if (fs.existsSync(this.runsFile)) {
                const data = fs.readFileSync(this.runsFile, 'utf-8');
                runs = JSON.parse(data) as TaskRun[];
            }
            runs.push(run);
            // Only keep the most recent 500 items
            if (runs.length > 500) {
                runs = runs.sort((a, b) => b.startedAt - a.startedAt).slice(0, 500);
            }
            fs.writeFileSync(this.runsFile, JSON.stringify(runs, null, 2), 'utf-8');
        } catch (error) {
            log.error('Failed to save execution records', { error });
        }
    }

    /** Update execution record */
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
