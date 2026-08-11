export type ChatDelivery = 'new' | 'steer' | 'queue';

export interface ActiveTurnRef {
    sessionId: string;
    turnId?: string;
    runId?: string;
    submissionId?: string;
    startedAt: number;
    stopRequested?: boolean;
}

export type QueueItemStatus = 'queued' | 'dispatching' | 'paused' | 'failed';

export interface FollowUpQueueItem {
    id: string;
    submissionId?: string;
    input: string;
    attachments?: Array<{ path: string; name: string; size: number; ext: string }>;
    position: number;
    status: QueueItemStatus;
    createdAt: number;
}

export interface FollowUpQueueState {
    sessionId: string;
    items: FollowUpQueueItem[];
    paused: boolean;
    revision: number;
}

/** The composer queue has no useful UI when there are no pending items. */
export function shouldDisplayFollowUpQueue(state: FollowUpQueueState | undefined): boolean {
    return !!state?.items.length;
}

export interface ChatAcceptedPayload {
    sessionId: string;
    submissionId?: string;
    disposition: 'started' | 'steer_pending' | 'queued' | 'stale_target' | 'unsupported';
    delivery?: ChatDelivery;
    turnId?: string;
    runId?: string;
    queueItem?: unknown;
    queue?: unknown;
    revision?: number;
}

export interface RuntimeSnapshotPayload {
    sessionId: string;
    activeTurn?: unknown;
    queue?: unknown;
}

export interface EventIdentity {
    sessionId?: string;
    turnId?: string;
    runId?: string;
    submissionId?: string;
}

const EMPTY_QUEUE_REVISION = 0;

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeQueueStatus(value: unknown): QueueItemStatus {
    return value === 'dispatching' || value === 'paused' || value === 'failed'
        ? value
        : 'queued';
}

export function normalizeQueueItem(value: unknown, fallbackPosition = 0): FollowUpQueueItem | undefined {
    const record = asRecord(value);
    if (!record) return undefined;
    const id = asString(record.id) ?? asString(record.queueItemId);
    if (!id) return undefined;

    const attachments = Array.isArray(record.attachments)
        ? record.attachments.filter((attachment): attachment is NonNullable<FollowUpQueueItem['attachments']>[number] => {
            const item = asRecord(attachment);
            return !!item
                && typeof item.path === 'string'
                && typeof item.name === 'string'
                && typeof item.size === 'number'
                && typeof item.ext === 'string';
        })
        : undefined;

    return {
        id,
        submissionId: asString(record.submissionId),
        input: asString(record.input) ?? asString(record.content) ?? '',
        attachments,
        position: asNumber(record.position) ?? fallbackPosition,
        status: normalizeQueueStatus(record.status),
        createdAt: asNumber(record.createdAt) ?? Date.now(),
    };
}

/** Pure queue reducer, kept independent from the DOM for race-condition tests. */
export function reduceQueueState(
    current: FollowUpQueueState | undefined,
    sessionId: string,
    payload: unknown,
): FollowUpQueueState {
    const root = asRecord(payload) ?? {};
    const nested = asRecord(root.queue);
    const source = nested ?? root;
    const incomingRevision = asNumber(source.revision)
        ?? asNumber(root.revision)
        ?? current?.revision
        ?? EMPTY_QUEUE_REVISION;

    // A delayed snapshot must never rewind a newer queue projection.
    if (current && incomingRevision < current.revision) return current;

    const rawItems = Array.isArray(source.items)
        ? source.items
        : Array.isArray(root.items)
            ? root.items
            : undefined;
    const items = rawItems
        ? rawItems
            .map((item, index) => normalizeQueueItem(item, index))
            .filter((item): item is FollowUpQueueItem => !!item)
            .sort((a, b) => a.position - b.position || a.createdAt - b.createdAt)
        : current?.items ?? [];

    return {
        sessionId,
        items,
        paused: typeof source.paused === 'boolean'
            ? source.paused
            : typeof root.paused === 'boolean'
                ? root.paused
                : current?.paused ?? false,
        revision: incomingRevision,
    };
}

export function eventMatchesTurn(active: ActiveTurnRef | undefined, event: EventIdentity): boolean {
    if (!active || !event.sessionId || active.sessionId !== event.sessionId) return false;
    if (event.turnId && active.turnId && event.turnId !== active.turnId) return false;
    if (event.runId && active.runId && event.runId !== active.runId) return false;
    if (event.submissionId && active.submissionId && event.submissionId !== active.submissionId) return false;

    // Once the server supplied a stable identity, identity-less legacy events
    // cannot safely mutate the active UI because they may belong to a retired run.
    const activeHasServerIdentity = !!(active.turnId || active.runId);
    const eventHasServerIdentity = !!(event.turnId || event.runId);
    if (activeHasServerIdentity && !eventHasServerIdentity) return false;
    return true;
}

export class FollowUpController {
    readonly activeTurnBySession = new Map<string, ActiveTurnRef>();
    readonly queueStateBySession = new Map<string, FollowUpQueueState>();
    private readonly latestTerminalBySession = new Map<string, ActiveTurnRef>();

    beginOptimistic(sessionId: string, submissionId: string): ActiveTurnRef {
        const active: ActiveTurnRef = { sessionId, submissionId, startedAt: Date.now() };
        this.activeTurnBySession.set(sessionId, active);
        return active;
    }

    applyAccepted(payload: ChatAcceptedPayload): boolean {
        if (!payload.sessionId) return false;
        if (payload.disposition === 'started') {
            const previous = this.activeTurnBySession.get(payload.sessionId);
            const retired = this.latestTerminalBySession.get(payload.sessionId);
            const identity: EventIdentity = {
                sessionId: payload.sessionId,
                turnId: payload.turnId,
                runId: payload.runId,
                submissionId: payload.submissionId,
            };
            const belongsToRetired = !!retired && eventMatchesTurn(retired, identity);
            const conflictsWithOptimistic = !!previous?.submissionId
                && !!payload.submissionId
                && previous.submissionId !== payload.submissionId;
            if (conflictsWithOptimistic
                || (belongsToRetired && previous?.submissionId !== retired?.submissionId)) {
                return false;
            }
            this.activeTurnBySession.set(payload.sessionId, {
                sessionId: payload.sessionId,
                turnId: payload.turnId ?? previous?.turnId,
                runId: payload.runId ?? previous?.runId,
                submissionId: payload.submissionId ?? previous?.submissionId,
                startedAt: previous?.startedAt ?? Date.now(),
            });
            this.latestTerminalBySession.delete(payload.sessionId);
        }

        if (payload.queue || payload.queueItem) {
            const current = this.queueStateBySession.get(payload.sessionId);
            if (payload.queue) {
                this.queueStateBySession.set(
                    payload.sessionId,
                    reduceQueueState(current, payload.sessionId, payload.queue),
                );
            } else if (payload.queueItem) {
                const item = normalizeQueueItem(payload.queueItem, current?.items.length ?? 0);
                if (item && !current?.items.some(existing => existing.id === item.id)) {
                    this.queueStateBySession.set(payload.sessionId, {
                        sessionId: payload.sessionId,
                        paused: current?.paused ?? false,
                        revision: payload.revision ?? current?.revision ?? EMPTY_QUEUE_REVISION,
                        items: [...(current?.items ?? []), item]
                            .sort((a, b) => a.position - b.position || a.createdAt - b.createdAt),
                    });
                }
            }
        }
        return true;
    }

    applyQueueUpdate(sessionId: string, payload: unknown): FollowUpQueueState {
        const next = reduceQueueState(this.queueStateBySession.get(sessionId), sessionId, payload);
        this.queueStateBySession.set(sessionId, next);
        return next;
    }

    applyRuntimeSnapshot(payload: RuntimeSnapshotPayload): void {
        if (!payload.sessionId) return;
        const active = asRecord(payload.activeTurn);
        const turnId = asString(active?.turnId);
        const runId = asString(active?.runId);
        if (active && (turnId || runId)) {
            this.activeTurnBySession.set(payload.sessionId, {
                sessionId: payload.sessionId,
                turnId,
                runId,
                submissionId: asString(active.submissionId),
                startedAt: asNumber(active.startedAt) ?? Date.now(),
            });
        } else if (payload.activeTurn === null) {
            this.activeTurnBySession.delete(payload.sessionId);
        }
        if (payload.queue) this.applyQueueUpdate(payload.sessionId, payload.queue);
    }

    observeTurnStarted(identity: Required<Pick<EventIdentity, 'sessionId' | 'turnId'>> & EventIdentity): void {
        const previous = this.activeTurnBySession.get(identity.sessionId);
        const retired = this.latestTerminalBySession.get(identity.sessionId);
        if (retired && eventMatchesTurn(retired, identity)
            && previous?.submissionId !== retired.submissionId) {
            return;
        }
        // A server turn.started is authoritative. It also advances a persisted
        // queue to its next item without waiting for an old request Promise.
        this.activeTurnBySession.set(identity.sessionId, {
            sessionId: identity.sessionId,
            turnId: identity.turnId,
            runId: identity.runId ?? previous?.runId,
            submissionId: identity.submissionId ?? previous?.submissionId,
            startedAt: Date.now(),
        });
        this.latestTerminalBySession.delete(identity.sessionId);
    }

    matchesActive(identity: EventIdentity): boolean {
        if (!identity.sessionId) return false;
        const active = this.activeTurnBySession.get(identity.sessionId);
        const retired = this.latestTerminalBySession.get(identity.sessionId);
        if (retired && eventMatchesTurn(retired, identity)
            && active?.submissionId !== retired.submissionId) {
            return false;
        }
        return eventMatchesTurn(active, identity);
    }

    matchesActiveOrLatestTerminal(identity: EventIdentity): boolean {
        if (this.matchesActive(identity)) return true;
        if (!identity.sessionId) return false;
        return eventMatchesTurn(this.latestTerminalBySession.get(identity.sessionId), identity);
    }

    isSubmissionActive(sessionId: string, submissionId: string): boolean {
        return this.activeTurnBySession.get(sessionId)?.submissionId === submissionId;
    }

    complete(identity: EventIdentity): boolean {
        if (!identity.sessionId || !this.matchesActive(identity)) return false;
        const active = this.activeTurnBySession.get(identity.sessionId);
        if (!active) return false;
        this.activeTurnBySession.delete(identity.sessionId);
        this.latestTerminalBySession.set(identity.sessionId, active);
        return true;
    }

    retireForStop(sessionId: string): ActiveTurnRef | undefined {
        const active = this.activeTurnBySession.get(sessionId);
        if (!active) return undefined;
        const retired = { ...active, stopRequested: true };
        this.activeTurnBySession.delete(sessionId);
        this.latestTerminalBySession.set(sessionId, retired);
        return retired;
    }

    markQueuePaused(sessionId: string, paused: boolean): void {
        const current = this.queueStateBySession.get(sessionId) ?? {
            sessionId,
            items: [],
            paused: false,
            revision: EMPTY_QUEUE_REVISION,
        };
        this.queueStateBySession.set(sessionId, { ...current, paused });
    }
}
