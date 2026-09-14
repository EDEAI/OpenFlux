import type { TaskRunView } from '../gateway-client';

export interface SchedulerRunMessage {
    id: string;
    role: string;
    content: string;
    createdAt: number;
    metadata?: Record<string, unknown>;
}

/** Resolve a run to a known message; a nearby unrelated message is never an anchor. */
export function findSchedulerRunMessageId(
    messages: SchedulerRunMessage[],
    run: TaskRunView,
): string | undefined {
    if (run.messageId) return messages.find(message => message.id === run.messageId)?.id;

    const identified = messages.filter(message => message.metadata?.schedulerRunId === run.id
        && (!message.metadata.taskId || message.metadata.taskId === run.taskId));
    const results = identified.filter(message => message.metadata?.kind === 'scheduler_run_result'
        || message.metadata?.kind === 'scheduler_run_error');
    if (results.length) return results.length === 1 ? results[0].id : undefined;
    const triggers = identified.filter(message => message.metadata?.kind === 'scheduler_run_trigger');
    if (triggers.length) return triggers.length === 1 ? triggers[0].id : undefined;

    // Older builds persisted a named trigger marker without metadata. Require
    // that unique marker inside this run's start window before using its result.
    if (!Number.isFinite(run.startedAt)) return undefined;
    const end = Number.isFinite(run.completedAt) ? run.completedAt! + 1000 : run.startedAt + 10000;
    const markers = messages.filter(message => message.role === 'assistant'
        && message.content.trim() === `🕐 **定时任务触发：${run.taskName}**`
        && message.createdAt >= run.startedAt
        && message.createdAt <= Math.min(end, run.startedAt + 10000));
    if (markers.length !== 1) return undefined;
    const marker = markers[0];
    const output = run.output?.trim();
    const error = run.error ? `定时任务「${run.taskName}」执行失败：${run.error}` : undefined;
    const matchingResults = messages.filter(message => message.id !== marker.id
        && message.role === 'assistant'
        && message.createdAt >= marker.createdAt && message.createdAt <= end
        && ((output && message.content.trim().startsWith(output)) || (error && message.content.trim() === error)));
    return matchingResults.length === 1 ? matchingResults[0].id : marker.id;
}
