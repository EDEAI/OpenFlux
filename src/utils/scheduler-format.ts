// Scheduler trigger / countdown display helpers extracted from main.ts.
// Pure functions; display strings are intentionally kept in Chinese.
import type { ScheduledTaskView } from '../gateway-client';

/** Format a countdown to a target timestamp as a human-readable string. */
export function formatCountdown(targetTs: number, nowTs: number): string {
    const diff = targetTs - nowTs;
    if (diff <= 0) return '即将执行';

    const totalSec = Math.floor(diff / 1000);
    const d = Math.floor(totalSec / 86400);
    const h = Math.floor((totalSec % 86400) / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;

    if (d > 0) return h > 0 ? `${d}天${h}小时后` : `${d}天后`;
    if (h > 0) return m > 0 ? `${h}小时${m}分钟后` : `${h}小时后`;
    if (m > 0) return s > 0 ? `${m}分钟${s}秒后` : `${m}分钟后`;
    return `${s}秒后`;
}

/** Describe a scheduled-task trigger in natural language. */
export function formatTriggerDisplay(trigger: ScheduledTaskView['trigger']): string {
    switch (trigger.type) {
        case 'cron':
            return cronToHuman(trigger.expression || '');
        case 'interval': {
            const ms = trigger.intervalMs || 0;
            const seconds = ms / 1000;
            if (seconds < 60) return `每${seconds} 秒`;
            if (seconds < 3600) return `每${Math.round(seconds / 60)} 分钟`;
            if (seconds < 86400) {
                const h = seconds / 3600;
                return h === Math.floor(h) ? `每${h} 小时` : `每${h.toFixed(1)} 小时`;
            }
            const d = seconds / 86400;
            return d === Math.floor(d) ? `每${d} 天` : `每${d.toFixed(1)} 天`;
        }
        case 'once': {
            // Parse the ISO runAt time
            try {
                const date = new Date(trigger.runAt || '');
                const now = new Date();
                const diffMs = date.getTime() - now.getTime();
                const dateStr = date.toLocaleString('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                if (diffMs > 0 && diffMs < 86400000) {
                    return `今天 ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 执行一次`;
                }
                if (diffMs > 0 && diffMs < 172800000) {
                    return `明天 ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 执行一次`;
                }
                return `${dateStr} 执行一次`;
            } catch {
                return `执行一次 ${trigger.runAt}`;
            }
        }
        default:
            return '未知';
    }
}

/**
 * Convert a cron expression into a natural-language description.
 * Supports 5-field format; also supports 6-field format (with seconds, seconds auto-skipped).
 */
export function cronToHuman(expr: string): string {
    if (!expr) return '自定义周期';
    let parts = expr.trim().split(/\s+/);
    // 6-field format: drop the seconds field
    if (parts.length === 6) parts = parts.slice(1);
    if (parts.length < 5) return expr;

    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

    // Common pattern matching
    const weekdayNames: Record<string, string> = {
        '0': '日', '7': '日', '1': '一', '2': '二', '3': '三', '4': '四', '5': '五', '6': '六',
    };

    const isEvery = (v: string) => v === '*';
    const isFixed = (v: string) => /^\d+$/.test(v);
    const isRange = (v: string) => /^\d+-\d+$/.test(v);
    const isStep = (v: string) => v.includes('/');

    // every N minutes
    if (isStep(minute) && isEvery(hour) && isEvery(dayOfMonth) && isEvery(month) && isEvery(dayOfWeek)) {
        const step = minute.split('/')[1];
        return `每${step} 分钟`;
    }

    // every N hours
    if (isFixed(minute) && isStep(hour) && isEvery(dayOfMonth) && isEvery(month) && isEvery(dayOfWeek)) {
        const step = hour.split('/')[1];
        return `每${step} 小时`;
    }

    // Build the time part
    let timeStr = '';
    if (isFixed(hour) && isFixed(minute)) {
        timeStr = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
    } else if (isFixed(hour) && isEvery(minute)) {
        timeStr = `${hour.padStart(2, '0')} 点`;
    }

    // daily at HH:MM
    if (timeStr && isEvery(dayOfMonth) && isEvery(month) && isEvery(dayOfWeek)) {
        return `每天 ${timeStr}`;
    }

    // weekdays (Mon-Fri) at HH:MM
    if (timeStr && isEvery(dayOfMonth) && isEvery(month) && dayOfWeek === '1-5') {
        return `工作日 ${timeStr}`;
    }

    // weekend (Sat/Sun) at HH:MM
    if (timeStr && isEvery(dayOfMonth) && isEvery(month) && (dayOfWeek === '0,6' || dayOfWeek === '6,0')) {
        return `周末 ${timeStr}`;
    }

    // specific weekday(s) at HH:MM
    if (timeStr && isEvery(dayOfMonth) && isEvery(month) && (isFixed(dayOfWeek) || dayOfWeek.includes(','))) {
        const days = dayOfWeek.split(',').map(d => weekdayNames[d] || d).join('、');
        if (dayOfWeek.split(',').length === 1) {
            return `每周${days} ${timeStr}`;
        }
        return `每周${days} ${timeStr}`;
    }

    // weekday range X-Y at HH:MM
    if (timeStr && isEvery(dayOfMonth) && isEvery(month) && isRange(dayOfWeek)) {
        const [start, end] = dayOfWeek.split('-');
        const s = weekdayNames[start] || start;
        const e = weekdayNames[end] || end;
        return `每周${s}至周${e} ${timeStr}`;
    }

    // monthly on day N at HH:MM
    if (timeStr && isFixed(dayOfMonth) && isEvery(month) && isEvery(dayOfWeek)) {
        return `每月 ${dayOfMonth} 号 ${timeStr}`;
    }

    // Unrecognized; return the original expression with a note
    return `周期: ${expr}`;
}
