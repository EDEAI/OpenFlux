export const AGENT_EVENT_VERSION = 1 as const;

export type AgentEventType =
    | 'turn.started'
    | 'item.started'
    | 'item.updated'
    | 'item.completed'
    | 'item.failed'
    | 'turn.completed'
    | 'turn.failed'
    | 'turn.interrupted';

export type AgentActivityKind = 'model' | 'commentary' | 'guidance' | 'goal_update' | 'action' | 'checkpoint' | 'approval' | 'subagent';
export type AgentActivityStatus = 'running' | 'waiting' | 'completed' | 'failed';

export interface AgentEventItem {
    id: string;
    kind: AgentActivityKind;
    status: AgentActivityStatus;
    title: string;
    detail?: string;
    toolCallId?: string;
    tool?: string;
    iteration?: number;
    startedAt?: number;
    completedAt?: number;
}

export interface AgentEventV1 {
    version: typeof AGENT_EVENT_VERSION;
    eventId: string;
    sessionId: string;
    turnId: string;
    seq: number;
    timestamp: number;
    type: AgentEventType;
    item?: AgentEventItem;
    durationMs?: number;
    summary?: string;
}

export type TurnActivityStatus = 'running' | 'completed' | 'failed' | 'interrupted';

export interface ActivityItemState extends AgentEventItem {
    firstSeq: number;
    lastSeq: number;
    updatedAt: number;
}

export interface TurnActivityState {
    sessionId: string;
    turnId: string;
    status: TurnActivityStatus;
    startedAt: number;
    finishedAt?: number;
    durationMs?: number;
    summary?: string;
    collapsed: boolean;
    items: ActivityItemState[];
    seenEventIds: ReadonlySet<string>;
    lastTurnSeq: number;
}

const ITEM_EVENT_TYPES: ReadonlySet<AgentEventType> = new Set([
    'item.started',
    'item.updated',
    'item.completed',
    'item.failed',
]);

const TURN_EVENT_TYPES: ReadonlySet<AgentEventType> = new Set([
    'turn.started',
    'turn.completed',
    'turn.failed',
    'turn.interrupted',
]);

const ITEM_KINDS: ReadonlySet<AgentActivityKind> = new Set([
    'model', 'commentary', 'guidance', 'goal_update', 'action', 'checkpoint', 'approval', 'subagent',
]);

const ITEM_STATUSES: ReadonlySet<AgentActivityStatus> = new Set([
    'running', 'waiting', 'completed', 'failed',
]);

export function isAgentEventV1(value: unknown): value is AgentEventV1 {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<AgentEventV1>;
    if (
        candidate.version !== AGENT_EVENT_VERSION
        || typeof candidate.eventId !== 'string'
        || typeof candidate.sessionId !== 'string'
        || typeof candidate.turnId !== 'string'
        || typeof candidate.seq !== 'number'
        || typeof candidate.timestamp !== 'number'
        || typeof candidate.type !== 'string'
    ) {
        return false;
    }

    if (!ITEM_EVENT_TYPES.has(candidate.type as AgentEventType)
        && !TURN_EVENT_TYPES.has(candidate.type as AgentEventType)) {
        return false;
    }

    if (ITEM_EVENT_TYPES.has(candidate.type as AgentEventType)) {
        const item = candidate.item;
        return !!item
            && typeof item.id === 'string'
            && ITEM_KINDS.has(item.kind as AgentActivityKind)
            && ITEM_STATUSES.has(item.status as AgentActivityStatus)
            && typeof item.title === 'string';
    }

    return true;
}

export function createTurnActivityState(event: AgentEventV1): TurnActivityState {
    const startedAt = event.type === 'turn.started'
        ? event.timestamp
        : event.item?.startedAt ?? event.timestamp;

    return {
        sessionId: event.sessionId,
        turnId: event.turnId,
        status: 'running',
        startedAt,
        collapsed: false,
        items: [],
        seenEventIds: new Set<string>(),
        lastTurnSeq: -1,
    };
}

function resolvedItemStatus(event: AgentEventV1): AgentActivityStatus {
    if (event.type === 'item.completed') return 'completed';
    if (event.type === 'item.failed') return 'failed';
    return event.item?.status ?? 'running';
}

const LEGACY_GUIDANCE_PREFIX = /^(?:\u5df2\u6536\u5230\u65b0\u7684\u7528\u6237\u5f15\u5bfc\uff0c\u5c06\u5728\u5f53\u524d\u6b65\u9aa4\u7ed3\u675f\u540e\u5e94\u7528\uff1a|New user guidance received; it will be applied after the current step:)\s*/i;

const LEGACY_FALLBACK_COMMENTARY = [
    /^为完成“[^”]+”，我会先检查相关文件和当前运行状态，确认可修改范围后再执行。?$/,
    /^为完成“[^”]+”，我会先核对公开来源和原文，避免把未经确认的线索当成事实。?$/,
    /^我会先获取一个可验证的执行结果，再根据结果判断下一步。?$/,
    /^任务包含可独立推进的专业环节，我会先拆分处理，再汇总可验证的结果。?$/,
    /^目标是产出实际交付物，我会先执行生成步骤，并根据生成结果继续验证。?$/,
    /^To complete “[^”]+”, I will inspect the relevant files and runtime state first, then act within the verified change scope\.?$/i,
    /^I will first obtain a verifiable execution result, then use it to decide the next step\.?$/i,
];

function isLegacyFallbackCommentary(item: AgentEventItem): boolean {
    if (item.kind !== 'commentary') return false;
    const title = item.title.replace(/\s+/g, ' ').trim();
    return LEGACY_FALLBACK_COMMENTARY.some(pattern => pattern.test(title));
}

/** Returns the exact user guidance represented by a current or legacy activity item. */
export function guidanceTextFromActivityItem(item: AgentEventItem | undefined): string | undefined {
    if (!item) return undefined;
    const title = item.title.trim();
    if (item.kind === 'guidance') return title || undefined;
    if (item.kind !== 'commentary' || !LEGACY_GUIDANCE_PREFIX.test(title)) return undefined;
    const guidance = title.replace(LEGACY_GUIDANCE_PREFIX, '').trim();
    return guidance || undefined;
}

/** Whether a persisted steer bubble is already represented inside its Process timeline. */
export function isSteerMessageRepresentedInActivity(
    message: { role: string; metadata?: Record<string, unknown> },
    turnsWithGuidance: ReadonlySet<string>,
): boolean {
    const isSteer = message.role === 'user'
        && (message.metadata?.kind === 'steer' || message.metadata?.followUpMode === 'steer');
    if (!isSteer) return false;
    const targetTurnId = typeof message.metadata?.turnId === 'string'
        ? message.metadata.turnId
        : undefined;
    return !!targetTurnId && turnsWithGuidance.has(targetTurnId);
}

function reduceItem(state: TurnActivityState, event: AgentEventV1): ActivityItemState[] {
    if (!event.item) return state.items;
    // Model request lifecycle and timings are infrastructure telemetry. The
    // user timeline is reserved for public reasoning summaries and actions.
    if (event.item.kind === 'model') return state.items;
    // Old Gateway builds injected the same future-intent sentence before almost
    // every tool call. It is not an observed action and makes restored history
    // actively misleading, so omit that exact legacy template.
    if (isLegacyFallbackCommentary(event.item)) return state.items;

    const guidanceText = guidanceTextFromActivityItem(event.item);
    const eventItem: AgentEventItem = guidanceText
        ? { ...event.item, kind: 'guidance', title: guidanceText }
        : event.item;
    const index = state.items.findIndex(item => item.id === eventItem.id);
    const previous = index >= 0 ? state.items[index] : undefined;
    if (previous && event.seq < previous.lastSeq) return state.items;

    const item: ActivityItemState = {
        ...previous,
        ...eventItem,
        status: resolvedItemStatus(event),
        // Once an item exists, preserve its original start time even if a later
        // update (for example an approval resolution) carries a fresh timestamp.
        startedAt: previous?.startedAt ?? eventItem.startedAt ?? event.timestamp,
        completedAt: eventItem.completedAt
            ?? previous?.completedAt
            ?? (event.type === 'item.completed' || event.type === 'item.failed' ? event.timestamp : undefined),
        firstSeq: previous?.firstSeq ?? event.seq,
        lastSeq: event.seq,
        updatedAt: event.timestamp,
    };

    const next = [...state.items];
    if (index >= 0) next[index] = item;
    else next.push(item);

    next.sort((a, b) => a.firstSeq - b.firstSeq || (a.startedAt ?? 0) - (b.startedAt ?? 0));
    return next;
}

export function reduceTurnActivity(
    current: TurnActivityState | undefined,
    event: AgentEventV1,
): TurnActivityState {
    const state = current ?? createTurnActivityState(event);
    if (state.sessionId !== event.sessionId || state.turnId !== event.turnId) return state;
    if (state.seenEventIds.has(event.eventId)) return state;

    const seenEventIds = new Set(state.seenEventIds);
    seenEventIds.add(event.eventId);

    let next: TurnActivityState = {
        ...state,
        seenEventIds,
        items: ITEM_EVENT_TYPES.has(event.type) ? reduceItem(state, event) : state.items,
    };

    if (TURN_EVENT_TYPES.has(event.type) && event.seq >= state.lastTurnSeq) {
        next = { ...next, lastTurnSeq: event.seq };

        if (event.type === 'turn.started') {
            next = {
                ...next,
                status: 'running',
                startedAt: event.timestamp,
                finishedAt: undefined,
                durationMs: undefined,
                summary: event.summary,
                collapsed: false,
            };
        } else if (event.type === 'turn.completed') {
            next = {
                ...next,
                status: 'completed',
                finishedAt: event.timestamp,
                durationMs: event.durationMs ?? Math.max(0, event.timestamp - next.startedAt),
                summary: event.summary ?? next.summary,
                collapsed: true,
            };
        } else if (event.type === 'turn.failed') {
            next = {
                ...next,
                status: 'failed',
                finishedAt: event.timestamp,
                durationMs: event.durationMs ?? Math.max(0, event.timestamp - next.startedAt),
                summary: event.summary ?? next.summary,
                collapsed: true,
            };
        } else if (event.type === 'turn.interrupted') {
            next = {
                ...next,
                status: 'interrupted',
                finishedAt: event.timestamp,
                durationMs: event.durationMs ?? Math.max(0, event.timestamp - next.startedAt),
                summary: event.summary ?? next.summary,
                collapsed: true,
            };
        }
    }

    return next;
}

export function setTurnActivityCollapsed(
    state: TurnActivityState,
    collapsed: boolean,
): TurnActivityState {
    return state.collapsed === collapsed ? state : { ...state, collapsed };
}

export function getTurnActivityDuration(state: TurnActivityState, now: number = Date.now()): number {
    return state.durationMs ?? Math.max(0, (state.finishedAt ?? now) - state.startedAt);
}

export function isTurnActivityTerminal(state: TurnActivityState): boolean {
    return state.status === 'completed' || state.status === 'failed' || state.status === 'interrupted';
}

/**
 * Decide whether an event-only turn belongs to the currently loaded message
 * window. Running turns are always visible. A terminal turn older than the
 * earliest loaded message belongs to an unloaded history page and must not be
 * appended beneath the newest task.
 */
export function shouldRenderUnanchoredTurn(
    events: readonly AgentEventV1[],
    earliestLoadedMessageAt?: number,
): boolean {
    if (events.length === 0) return false;
    const terminal = events.some(event => (
        event.type === 'turn.completed'
        || event.type === 'turn.failed'
        || event.type === 'turn.interrupted'
    ));
    if (!terminal || earliestLoadedMessageAt === undefined) return true;
    const startedAt = events.reduce(
        (earliest, event) => Math.min(earliest, event.timestamp),
        Number.POSITIVE_INFINITY,
    );
    return startedAt >= earliestLoadedMessageAt;
}
