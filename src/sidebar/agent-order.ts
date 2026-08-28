export type AgentDropPlacement = 'before' | 'after';

export function parseStoredAgentOrder(raw: string | null): string[] {
    if (!raw) return [];
    try {
        const value: unknown = JSON.parse(raw);
        if (!Array.isArray(value)) return [];
        return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))];
    } catch {
        return [];
    }
}

export function sortAgentEntities<T extends { id: string }>(
    entities: T[],
    storedOrder: string[],
    pinnedIds: string[],
): T[] {
    const orderRank = new Map(storedOrder.map((id, index) => [id, index]));
    const pinnedRank = new Map(pinnedIds.map((id, index) => [id, index]));
    const sourceRank = new Map(entities.map((entity, index) => [entity.id, index]));

    return [...entities].sort((left, right) => {
        const leftPinned = pinnedRank.has(left.id);
        const rightPinned = pinnedRank.has(right.id);
        if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;

        const leftStored = orderRank.get(left.id);
        const rightStored = orderRank.get(right.id);
        if (leftStored !== undefined || rightStored !== undefined) {
            if (leftStored === undefined) return 1;
            if (rightStored === undefined) return -1;
            if (leftStored !== rightStored) return leftStored - rightStored;
        }

        if (leftPinned && rightPinned) {
            const leftPinRank = pinnedRank.get(left.id) ?? Number.MAX_SAFE_INTEGER;
            const rightPinRank = pinnedRank.get(right.id) ?? Number.MAX_SAFE_INTEGER;
            if (leftPinRank !== rightPinRank) return leftPinRank - rightPinRank;
        }

        return (sourceRank.get(left.id) ?? 0) - (sourceRank.get(right.id) ?? 0);
    });
}

export function reorderAgentIds(
    visibleIds: string[],
    draggedId: string,
    targetId: string,
    placement: AgentDropPlacement,
): string[] {
    if (draggedId === targetId || !visibleIds.includes(draggedId) || !visibleIds.includes(targetId)) {
        return [...visibleIds];
    }

    const reordered = visibleIds.filter(id => id !== draggedId);
    const targetIndex = reordered.indexOf(targetId);
    reordered.splice(targetIndex + (placement === 'after' ? 1 : 0), 0, draggedId);
    return reordered;
}
