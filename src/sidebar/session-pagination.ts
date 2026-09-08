export const INITIAL_AGENT_SESSION_COUNT = 5;
export const AGENT_SESSION_PAGE_SIZE = 10;

export type AgentSessionPaginationAction = 'expand' | 'more' | null;

export interface AgentSessionPaginationModel {
    totalCount: number;
    visibleCount: number;
    hiddenCount: number;
    nextRevealCount: number;
    expanded: boolean;
    hasMore: boolean;
    canCollapse: boolean;
    action: AgentSessionPaginationAction;
}

function normalizeCount(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.floor(value));
}

/**
 * Keeps incremental disclosure state for the session lists under each Agent or
 * project. The stored value is a capacity (5, 15, 25...), rather than the
 * current item count, so a partially filled page stays open when sessions are
 * added or removed during the same app run.
 */
export class AgentSessionPaginationController {
    private readonly visibleLimits = new Map<string, number>();

    get(agentId: string, totalCount: number): AgentSessionPaginationModel {
        const total = normalizeCount(totalCount);
        const limit = Math.max(
            INITIAL_AGENT_SESSION_COUNT,
            this.visibleLimits.get(agentId) ?? INITIAL_AGENT_SESSION_COUNT,
        );
        const visibleCount = Math.min(total, limit);
        const hiddenCount = Math.max(0, total - visibleCount);
        const expanded = limit > INITIAL_AGENT_SESSION_COUNT;
        const hasMore = hiddenCount > 0;
        const canCollapse = expanded && total > INITIAL_AGENT_SESSION_COUNT;

        return {
            totalCount: total,
            visibleCount,
            hiddenCount,
            nextRevealCount: Math.min(AGENT_SESSION_PAGE_SIZE, hiddenCount),
            expanded,
            hasMore,
            canCollapse,
            action: total <= INITIAL_AGENT_SESSION_COUNT || !hasMore
                ? null
                : (expanded ? 'more' : 'expand'),
        };
    }

    /** Reveal the next ten sessions, preserving the new capacity across rerenders. */
    expand(agentId: string, totalCount: number): AgentSessionPaginationModel {
        const currentLimit = Math.max(
            INITIAL_AGENT_SESSION_COUNT,
            this.visibleLimits.get(agentId) ?? INITIAL_AGENT_SESSION_COUNT,
        );
        this.visibleLimits.set(agentId, currentLimit + AGENT_SESSION_PAGE_SIZE);
        return this.get(agentId, totalCount);
    }

    /** Return one Agent or project to the initial five visible sessions. */
    collapse(agentId: string, totalCount: number): AgentSessionPaginationModel {
        this.visibleLimits.delete(agentId);
        return this.get(agentId, totalCount);
    }

    /**
     * Reveal enough pages to keep a selected session visible. This is useful
     * when navigation opens an older session from search or task history.
     */
    ensureVisible(agentId: string, zeroBasedIndex: number, totalCount: number): AgentSessionPaginationModel {
        const index = normalizeCount(zeroBasedIndex);
        if (index >= INITIAL_AGENT_SESSION_COUNT) {
            const requiredPages = Math.ceil((index + 1 - INITIAL_AGENT_SESSION_COUNT) / AGENT_SESSION_PAGE_SIZE);
            const requiredLimit = INITIAL_AGENT_SESSION_COUNT + requiredPages * AGENT_SESSION_PAGE_SIZE;
            const currentLimit = this.visibleLimits.get(agentId) ?? INITIAL_AGENT_SESSION_COUNT;
            if (requiredLimit > currentLimit) this.visibleLimits.set(agentId, requiredLimit);
        }
        return this.get(agentId, totalCount);
    }

    /** Drop state for Agents/projects that no longer exist. */
    prune(agentIds: Iterable<string>): void {
        const retained = new Set(agentIds);
        for (const agentId of this.visibleLimits.keys()) {
            if (!retained.has(agentId)) this.visibleLimits.delete(agentId);
        }
    }
}
