import type { SessionStore } from '../sessions/store';
import type { SessionMessage } from '../sessions/types';
import type { TaskRun } from './types';

export interface SchedulerRunResolverOptions {
    /** A current binding is only a search hint, never proof of a historical association. */
    taskSessionId?: string;
    sessions: Pick<SessionStore, 'list' | 'getVisibleMessages'>;
}

interface Anchor { sessionId: string; messageId: string; rank: number }

function text(message: SessionMessage): string {
    return typeof message.content === 'string' ? message.content.trim() : '';
}

function compatibleIdentity(message: SessionMessage, run: TaskRun): boolean {
    const metadata = message.metadata;
    return (!metadata?.taskId || metadata.taskId === run.taskId)
        && (!metadata?.schedulerRunId || metadata.schedulerRunId === run.id);
}

function anchorsInSession(sessionId: string, messages: SessionMessage[], run: TaskRun): Anchor[] {
    const hits: Anchor[] = [];
    for (const message of messages) {
        if (message.role !== 'assistant') continue;
        if (run.messageId && message.id === run.messageId && compatibleIdentity(message, run)) {
            hits.push({ sessionId, messageId: message.id, rank: 4 });
        }
        if (message.metadata?.schedulerRunId !== run.id || message.metadata?.taskId !== run.taskId) continue;
        const kind = message.metadata.kind;
        if ((run.status === 'completed' && kind === 'scheduler_run_result')
            || (run.status === 'failed' && kind === 'scheduler_run_error')) {
            hits.push({ sessionId, messageId: message.id, rank: 3 });
        } else if (kind === 'scheduler_run_trigger') {
            hits.push({ sessionId, messageId: message.id, rank: 2 });
        }
    }
    if (!Number.isFinite(run.startedAt)) return hits;
    const finishedAt = Number.isFinite(run.completedAt) ? run.completedAt!
        : Number.isFinite(run.duration) && run.duration! >= 0 ? run.startedAt + run.duration!
            : run.startedAt + 10_000;
    if (finishedAt < run.startedAt) return hits;
    const end = finishedAt + 1000;
    const output = run.output?.trim();
    // Some old shared-session runs have interleaved or missing trigger messages.
    // A substantial, fully equal reply inside this completed run's window is independent evidence.
    if (run.status === 'completed' && output && output.length >= 80
        && (Number.isFinite(run.completedAt) || Number.isFinite(run.duration))) {
        for (const message of messages) {
            if (message.role === 'assistant' && compatibleIdentity(message, run)
                && message.createdAt >= run.startedAt && message.createdAt <= end && text(message) === output) {
                hits.push({ sessionId, messageId: message.id, rank: 0 });
            }
        }
    }
    const markerText = `🕐 **定时任务触发：${run.taskName}**`;
    const markers = messages.map((message, index) => ({ message, index })).filter(({ message }) => (
        message.role === 'assistant' && text(message) === markerText && compatibleIdentity(message, run)
        && message.createdAt >= run.startedAt && message.createdAt <= end
    ));
    if (markers.length !== 1) return hits;
    const marker = markers[0];
    // A later scheduled trigger starts a different execution segment in the same transcript.
    const later = messages.slice(marker.index + 1);
    const nextTrigger = later.findIndex(message => message.role === 'assistant'
        && (message.metadata?.kind === 'scheduler_run_trigger' || /^🕐 \*\*定时任务触发：.+\*\*$/.test(text(message))));
    const segment = nextTrigger < 0 ? later : later.slice(0, nextTrigger);
    const error = run.error ? `定时任务「${run.taskName}」执行失败：${run.error}` : undefined;
    const results = segment.filter(message => message.role === 'assistant'
        && compatibleIdentity(message, run)
        && message.createdAt >= marker.message.createdAt && message.createdAt <= end
        && (run.status === 'failed' && error ? text(message) === error : Boolean(output && text(message).startsWith(output))));
    if (results.length === 1) hits.push({ sessionId, messageId: results[0].id, rank: 1 });
    return hits;
}

/** Resolve historical navigation in memory only. Neither task bindings nor stored runs are changed. */
export function resolveSchedulerRun(run: TaskRun, options: SchedulerRunResolverOptions): TaskRun {
    if (run.sessionId && run.messageId) return run;
    const localSessions = options.sessions.list().filter(session => !session.cloudChatroomId);
    const localIds = new Set(localSessions.map(session => session.id));
    const orderedIds = [...new Set([
        run.sessionId, options.taskSessionId, `cron:${run.taskId}`, ...localIds,
    ].filter((id): id is string => Boolean(id && localIds.has(id))))];
    const anchors: Anchor[] = [];
    for (const sessionId of orderedIds) {
        anchors.push(...anchorsInSession(sessionId, options.sessions.getVisibleMessages(sessionId), run));
    }
    if (!anchors.length) return run;
    const bestRank = Math.max(...anchors.map(anchor => anchor.rank));
    const best = [...new Map(anchors.filter(anchor => anchor.rank === bestRank)
        .map(anchor => [`${anchor.sessionId}\0${anchor.messageId}`, anchor])).values()];
    // Same-name tasks, duplicate markers, and indistinguishable results must not create guessed links.
    return best.length === 1 ? { ...run, sessionId: best[0].sessionId, messageId: best[0].messageId } : run;
}
