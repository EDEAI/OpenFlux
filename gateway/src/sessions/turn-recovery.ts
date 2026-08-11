import { randomUUID } from 'node:crypto';
import { AGENT_EVENT_VERSION, type AgentRuntimeEvent } from '../runtime/events';
import type { SessionStore } from './store';
import type { TurnQueueItem, TurnQueueStore } from './turn-queue-store';

export const RESTARTED_TURN_REASON = 'Gateway restarted before the turn reached a terminal state';

const TERMINAL_TURN_TYPES = new Set<AgentRuntimeEvent['type']>([
    'turn.completed',
    'turn.failed',
    'turn.interrupted',
]);

interface RecoverableTurnPayload {
    turnId?: unknown;
}

export interface RestartedTurnRecoveryIssue {
    itemId: string;
    sessionId: string;
    message: string;
}

export interface RestartedTurnRecoveryResult {
    candidates: number;
    dispatching: number;
    previouslyFailed: number;
    queueFailed: number;
    interruptedEventsAppended: number;
    alreadyTerminal: number;
    withoutActivity: number;
    eventIssues: RestartedTurnRecoveryIssue[];
}

function recoverableTurnId(item: TurnQueueItem<RecoverableTurnPayload>): string | undefined {
    const payload = item.payload;
    if (!payload || typeof payload !== 'object') return undefined;
    return typeof payload.turnId === 'string' && payload.turnId.trim()
        ? payload.turnId
        : undefined;
}

function interruptedEventFor(
    item: TurnQueueItem<RecoverableTurnPayload>,
    turnEvents: readonly AgentRuntimeEvent[],
): AgentRuntimeEvent {
    const firstEvent = turnEvents[0];
    const lastActivityEvent = turnEvents[turnEvents.length - 1];
    const startedAt = turnEvents.find(event => event.type === 'turn.started')?.timestamp
        ?? firstEvent.timestamp;
    const traceId = [...turnEvents].reverse().find(event => event.traceId)?.traceId;

    return {
        version: AGENT_EVENT_VERSION,
        eventId: randomUUID(),
        sessionId: item.sessionId,
        turnId: recoverableTurnId(item)!,
        ...(traceId ? { traceId } : {}),
        runId: item.id,
        submissionId: item.submissionId,
        seq: Math.max(...turnEvents.map(event => event.seq)) + 1,
        // Deliberately close the turn at its last persisted activity. Using
        // restart time would turn downtime into a false multi-hour duration.
        timestamp: lastActivityEvent.timestamp,
        type: 'turn.interrupted',
        durationMs: Math.max(0, lastActivityEvent.timestamp - startedAt),
        summary: 'Gateway 重启，任务已中断',
    };
}

/**
 * Close durable turns left dispatching by a previous Gateway process.
 *
 * The terminal event is appended before the queue status is changed. If the
 * process crashes between those writes, the next startup sees the existing
 * terminal event, avoids duplicating it, and can still finish queue recovery.
 */
export function recoverInterruptedTurnsAfterRestart(
    turnQueueStore: TurnQueueStore,
    sessions: Pick<SessionStore, 'getEvents' | 'addEvent'>,
    reason = RESTARTED_TURN_REASON,
): RestartedTurnRecoveryResult {
    const active = turnQueueStore.listDispatching<RecoverableTurnPayload>();
    // Also repair journals produced by older Gateway builds, which marked the
    // queue failed before this event reconciliation existed.
    const previouslyFailed = turnQueueStore.listByStatus<RecoverableTurnPayload>('failed')
        .filter(item => item.error === reason);
    const candidates = [...active, ...previouslyFailed];
    const eventsBySession = new Map<string, AgentRuntimeEvent[]>();
    const result: RestartedTurnRecoveryResult = {
        candidates: candidates.length,
        dispatching: active.length,
        previouslyFailed: previouslyFailed.length,
        queueFailed: 0,
        interruptedEventsAppended: 0,
        alreadyTerminal: 0,
        withoutActivity: 0,
        eventIssues: [],
    };

    for (const item of candidates) {
        const turnId = recoverableTurnId(item);
        if (!turnId) {
            result.withoutActivity += 1;
        } else {
            try {
                let sessionEvents = eventsBySession.get(item.sessionId);
                if (!sessionEvents) {
                    sessionEvents = sessions.getEvents(item.sessionId);
                    eventsBySession.set(item.sessionId, sessionEvents);
                }
                const turnEvents = sessionEvents.filter(event => event.turnId === turnId);
                if (turnEvents.some(event => TERMINAL_TURN_TYPES.has(event.type))) {
                    result.alreadyTerminal += 1;
                } else if (turnEvents.length === 0) {
                    result.withoutActivity += 1;
                } else {
                    const interrupted = interruptedEventFor(item, turnEvents);
                    sessions.addEvent(item.sessionId, interrupted);
                    sessionEvents.push(interrupted);
                    result.interruptedEventsAppended += 1;
                }
            } catch (error) {
                result.eventIssues.push({
                    itemId: item.id,
                    sessionId: item.sessionId,
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        }

        if (item.status === 'dispatching' && turnQueueStore.fail(item.sessionId, item.id, reason)) {
            result.queueFailed += 1;
        }
    }

    return result;
}
