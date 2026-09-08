import type { ScheduledTaskView } from '../gateway-client';

export type TaskFilter = 'all' | 'active' | 'paused' | 'completed';
export type SchedulePreset = 'daily' | 'weekdays' | 'weekly' | 'interval' | 'once' | 'custom';
export interface ScheduleDraft {
    preset: SchedulePreset;
    time: string;
    weekday: string;
    interval: string;
    unit: string;
    runAt: string;
    expression: string;
}

export function filterTasks(tasks: ScheduledTaskView[], filter: TaskFilter, query: string): ScheduledTaskView[] {
    const term = query.trim().toLocaleLowerCase();
    return tasks.filter(task => (filter === 'all' || task.status === filter)
        && (!term || `${task.name}\n${task.target.prompt || ''}\n${task.target.workflowId || ''}`.toLocaleLowerCase().includes(term)));
}

export function scheduleDraft(trigger?: ScheduledTaskView['trigger']): ScheduleDraft {
    const draft: ScheduleDraft = { preset: 'daily', time: '09:00', weekday: '1', interval: '1', unit: '3600000', runAt: '', expression: '0 9 * * *' };
    if (!trigger) return draft;
    if (trigger.type === 'once') {
        const date = new Date(trigger.runAt || '');
        draft.preset = 'once';
        if (Number.isFinite(date.getTime())) {
            draft.runAt = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        }
    } else if (trigger.type === 'interval') {
        draft.preset = 'interval';
        const ms = trigger.intervalMs || 60000;
        const unit = [86400000, 3600000, 60000, 1000].find(value => ms % value === 0) || 1;
        draft.unit = String(unit);
        draft.interval = String(ms / unit);
    } else {
        draft.expression = trigger.expression || '';
        const match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-6])$/.exec(draft.expression);
        if (match) {
            draft.time = `${match[2].padStart(2, '0')}:${match[1].padStart(2, '0')}`;
            draft.preset = match[3] === '*' ? 'daily' : match[3] === '1-5' ? 'weekdays' : 'weekly';
            if (draft.preset === 'weekly') draft.weekday = match[3];
        } else draft.preset = 'custom';
    }
    return draft;
}

/** Validation codes are translated by the view; the server validates again. */
export function triggerFromDraft(draft: ScheduleDraft, now = Date.now()): ScheduledTaskView['trigger'] {
    if (draft.preset === 'once') {
        const date = new Date(draft.runAt);
        if (!Number.isFinite(date.getTime()) || date.getTime() <= now) throw new Error('invalid_date');
        return { type: 'once', runAt: date.toISOString() };
    }
    if (draft.preset === 'interval') {
        const intervalMs = Number(draft.interval) * Number(draft.unit);
        if (!Number.isFinite(intervalMs) || intervalMs < 10000 || intervalMs > 2147483647 || !Number.isSafeInteger(intervalMs)) throw new Error('invalid_interval');
        return { type: 'interval', intervalMs };
    }
    if (draft.preset === 'custom') {
        const expression = draft.expression.trim().replace(/\s+/g, ' ');
        if (expression.split(' ').length !== 5) throw new Error('invalid_cron');
        return { type: 'cron', expression };
    }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time)) throw new Error('invalid_time');
    const [hour, minute] = draft.time.split(':').map(Number);
    if (draft.preset === 'weekly' && !/^[0-6]$/.test(draft.weekday)) throw new Error('invalid_time');
    return { type: 'cron', expression: `${minute} ${hour} * * ${draft.preset === 'daily' ? '*' : draft.preset === 'weekdays' ? '1-5' : draft.weekday}` };
}

export function hasUnreadRun(task: ScheduledTaskView, readAt: Record<string, number>): boolean {
    return typeof task.lastRunAt === 'number' && task.lastRunAt > (readAt[task.id] || 0);
}
