import type { ScheduledTask, SchedulerTaskInput, TaskTarget, TriggerConfig } from './types';

export interface SchedulerBindingLookup {
    hasAgent(id: string): boolean;
    getSession(id: string): { agentId?: string; cloudChatroomId?: number; status?: string } | undefined;
}

function object(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}必须是对象。`);
    return value as Record<string, unknown>;
}

function text(value: unknown, label: string, max: number): string {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空。`);
    const result = value.trim();
    if (result.length > max) throw new Error(`${label}过长（最多 ${max} 个字符）。`);
    return result;
}

export function validateSchedulerTaskId(value: unknown): string {
    return text(value, '任务 ID', 200);
}

function validateCron(expression: unknown): string {
    let fields = text(expression, 'Cron 表达式', 200).split(/\s+/);
    // The engine has minute precision; retain compatibility with a leading zero seconds field.
    if (fields.length === 6 && fields[0] === '0') fields = fields.slice(1);
    if (fields.length !== 5) throw new Error('Cron 表达式需要 5 个字段（分钟、小时、日、月、星期）。');
    const bounds = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
    for (let index = 0; index < fields.length; index += 1) {
        const [min, max] = bounds[index];
        const normalizedParts: string[] = [];
        for (const part of fields[index].split(',')) {
            if (part === '*') { normalizedParts.push(part); continue; }
            if (/^\*\/\d+$/.test(part)) {
                const step = Number(part.slice(2));
                // This scheduler uses value % step. Positive-start fields have no zero to match.
                if (step >= 1 && step <= max + (min === 0 ? 1 : 0)) { normalizedParts.push(part); continue; }
            } else if (/^\d+(?:-\d+)?$/.test(part)) {
                const [start, end = start] = part.split('-').map(Number);
                if (start >= min && end <= max && start <= end) {
                    // The engine aliases a single 7 to Sunday, but not a range ending in 7.
                    normalizedParts.push(index === 4 && end === 7 && part.includes('-')
                        ? Array.from({ length: end - start + 1 }, (_, offset) => (start + offset) % 7).join(',')
                        : part);
                    continue;
                }
            }
            throw new Error(`Cron 第 ${index + 1} 个字段无效；支持数字、范围、列表、* 和 */步长。`);
        }
        fields[index] = normalizedParts.join(',');
    }
    return fields.join(' ');
}

export function validateSchedulerTrigger(value: unknown, now = Date.now()): TriggerConfig {
    const trigger = object(value, '执行频率');
    if (trigger.type === 'cron') return { type: 'cron', expression: validateCron(trigger.expression) };
    if (trigger.type === 'interval') {
        if (!Number.isSafeInteger(trigger.intervalMs) || Number(trigger.intervalMs) < 10_000 || Number(trigger.intervalMs) > 2_147_483_647) {
            throw new Error('执行间隔必须是 10000 到 2147483647 之间的整数毫秒数。');
        }
        return { type: 'interval', intervalMs: Number(trigger.intervalMs) };
    }
    if (trigger.type === 'once') {
        const runAt = trigger.runAt;
        if ((typeof runAt !== 'string' && typeof runAt !== 'number') || (typeof runAt === 'string' && !runAt.trim())) {
            throw new Error('请选择有效的一次性执行时间。');
        }
        const timestamp = new Date(runAt).getTime();
        if (!Number.isFinite(timestamp) || timestamp <= now) throw new Error('一次性执行时间必须晚于当前时间。');
        return { type: 'once', runAt: new Date(timestamp).toISOString() };
    }
    throw new Error('执行频率类型无效。');
}

function validateTarget(value: unknown): TaskTarget {
    const target = object(value, '任务内容');
    if (target.type === 'agent') return { type: 'agent', prompt: text(target.prompt, '任务提示词', 50_000) };
    if (target.type === 'workflow') {
        const workflowId = text(target.workflowId, '工作流 ID', 200);
        return {
            type: 'workflow', workflowId,
            ...(target.params !== undefined ? { params: { ...object(target.params, '工作流参数') } } : {}),
        };
    }
    throw new Error('任务目标类型无效。');
}

/** Validate only supplied fields when editing, so omitted workflow targets and legacy bindings survive. */
export function validateSchedulerTaskInput(
    value: unknown,
    lookup: SchedulerBindingLookup,
    current?: ScheduledTask,
    now = Date.now(),
): Partial<SchedulerTaskInput> {
    const input = object(value, '任务');
    const allowed = new Set(['name', 'trigger', 'target', 'agentId', 'sessionId', 'notificationPolicy']);
    for (const key of Object.keys(input)) {
        if (!allowed.has(key)) throw new Error(`不支持修改任务字段：${key}`);
    }
    const patch: Partial<SchedulerTaskInput> = {};
    if (!current || 'name' in input) patch.name = text(input.name, '任务名称', 160);
    if (!current || 'trigger' in input) patch.trigger = validateSchedulerTrigger(input.trigger, now);
    if (!current || 'target' in input) patch.target = validateTarget(input.target);
    if ('notificationPolicy' in input) {
        if (input.notificationPolicy !== 'all' && input.notificationPolicy !== 'failed_only' && input.notificationPolicy !== 'none') {
            throw new Error('通知偏好无效。');
        }
        patch.notificationPolicy = input.notificationPolicy;
    } else if (!current) {
        patch.notificationPolicy = 'all';
    }
    for (const key of ['agentId', 'sessionId'] as const) {
        if (!(key in input)) continue;
        if (current && input[key] === null) patch[key] = undefined;
        else patch[key] = text(input[key], key === 'agentId' ? 'Agent ID' : '会话 ID', 200);
    }
    const changingBinding = !current || 'agentId' in input || 'sessionId' in input;
    if (changingBinding) {
        const selectedSession = 'sessionId' in patch && typeof patch.sessionId === 'string';
        // Selecting a conversation also selects its owner; an old task's Agent must not override it.
        const agentId = 'agentId' in patch ? patch.agentId : selectedSession ? undefined : current?.agentId;
        const sessionId = 'sessionId' in patch ? patch.sessionId : current?.sessionId;
        if (agentId && !lookup.hasAgent(agentId)) throw new Error('所选 Agent 不存在。');
        if (sessionId) {
            const session = lookup.getSession(sessionId);
            if (!session || session.status === 'archived' || session.status === 'deleted' || session.cloudChatroomId) {
                throw new Error('请选择现有的本地会话。');
            }
            if (agentId && session.agentId !== agentId) throw new Error('所选会话不属于该 Agent。');
            if (!agentId) {
                if (session.agentId && lookup.hasAgent(session.agentId)) patch.agentId = session.agentId;
                else if (selectedSession && current?.agentId) patch.agentId = undefined;
            }
        }
    }
    if (current && !Object.keys(patch).length) throw new Error('请提供要修改的任务字段。');
    return patch;
}
