/**
 * Versioned, user-visible Agent runtime events.
 *
 * These events intentionally contain an auditable activity summary rather than
 * private model reasoning.  Raw prompts, reasoning_content, tool arguments and
 * full tool output must never be copied into this contract.
 */

export const AGENT_EVENT_VERSION = 1 as const;

export type AgentRuntimeEventType =
    | 'turn.started'
    | 'item.started'
    | 'item.updated'
    | 'item.completed'
    | 'item.failed'
    | 'turn.completed'
    | 'turn.failed'
    | 'turn.interrupted';

export type AgentActivityKind =
    | 'model'
    | 'commentary'
    | 'guidance'
    | 'goal_update'
    | 'action'
    | 'checkpoint'
    | 'approval'
    | 'subagent';

export type AgentActivityStatus = 'running' | 'waiting' | 'completed' | 'failed';

export interface AgentActivityItem {
    id: string;
    kind: AgentActivityKind;
    status: AgentActivityStatus;
    title: string;
    detail?: string;
    toolCallId?: string;
    tool?: string;
    /** Safe child-run identity; raw prompts and arguments remain excluded. */
    sourceId?: string;
    sourceAgentId?: string;
    iteration?: number;
    startedAt?: number;
    completedAt?: number;
}

export interface AgentRuntimeEvent {
    version: typeof AGENT_EVENT_VERSION;
    eventId: string;
    sessionId: string;
    turnId: string;
    /** Correlates Gateway, model, tool and child-agent spans without storing payloads. */
    traceId?: string;
    runId?: string;
    submissionId?: string;
    seq: number;
    timestamp: number;
    type: AgentRuntimeEventType;
    item?: AgentActivityItem;
    durationMs?: number;
    summary?: string;
}

export function isAgentRuntimeEvent(value: unknown): value is AgentRuntimeEvent {
    if (!value || typeof value !== 'object') return false;
    const event = value as Partial<AgentRuntimeEvent>;
    return event.version === AGENT_EVENT_VERSION
        && typeof event.eventId === 'string'
        && typeof event.sessionId === 'string'
        && typeof event.turnId === 'string'
        && typeof event.seq === 'number'
        && typeof event.timestamp === 'number'
        && typeof event.type === 'string';
}

/** Strip internal model routing metadata from replayed legacy events. */
export function toPublicAgentRuntimeEvent(event: AgentRuntimeEvent): AgentRuntimeEvent {
    if (event.item?.kind !== 'model') return event;
    return {
        ...event,
        item: {
            ...event.item,
            detail: undefined,
        },
    };
}
