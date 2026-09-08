/**
 * Right-panel pane model.
 *
 * The right panel used to render a single artifacts list. It is now a browser
 * style tab strip: a horizontal row of tabs with a trailing "+", one pane
 * visible at a time, restored across restarts.
 *
 * Everything in this module is pure so the tab bookkeeping can be unit tested
 * without a DOM.
 */

export type PaneKind = 'artifacts' | 'files' | 'browser';

export const PANE_KINDS: readonly PaneKind[] = ['artifacts', 'files', 'browser'];

export interface PaneState {
    id: string;
    kind: PaneKind;
}

export interface PanelLayout {
    panes: PaneState[];
    /** The tab whose content is on screen; null only when there are no tabs. */
    activeId: string | null;
}

export function createPane(kind: PaneKind, id: string): PaneState {
    return { id, kind };
}

export function activePane(layout: PanelLayout): PaneState | null {
    return layout.panes.find(pane => pane.id === layout.activeId) ?? null;
}

/**
 * Which tab takes focus once `closedId` goes away.
 *
 * Follows the browser convention: closing the active tab moves focus to its
 * right neighbour, falling back to the left one when it was the last tab.
 * Closing any other tab leaves the selection alone.
 */
export function nextActiveAfterClose(layout: PanelLayout, closedId: string): string | null {
    const index = layout.panes.findIndex(pane => pane.id === closedId);
    if (index < 0) return layout.activeId;
    if (layout.activeId !== closedId) return layout.activeId;

    const neighbour = layout.panes[index + 1] ?? layout.panes[index - 1];
    return neighbour?.id ?? null;
}

/**
 * Parse a persisted layout defensively. Anything unrecognised — a pane kind
 * dropped from a later build, a hand-edited value, a truncated write — falls
 * back to `null` so the caller can start from the default layout rather than
 * render a broken panel.
 */
export function normalizeLayout(raw: unknown, knownKinds: readonly PaneKind[] = PANE_KINDS): PanelLayout | null {
    if (!raw || typeof raw !== 'object') return null;
    const panesRaw = (raw as { panes?: unknown }).panes;
    if (!Array.isArray(panesRaw)) return null;

    const seenIds = new Set<string>();
    const panes: PaneState[] = [];
    for (const entry of panesRaw) {
        if (!entry || typeof entry !== 'object') continue;
        const { id, kind } = entry as Record<string, unknown>;
        if (typeof id !== 'string' || !id || seenIds.has(id)) continue;
        if (typeof kind !== 'string' || !knownKinds.includes(kind as PaneKind)) continue;
        seenIds.add(id);
        panes.push({ id, kind: kind as PaneKind });
    }
    if (panes.length === 0) return null;

    // A saved active tab that no longer survives normalization would leave the
    // panel blank, so fall back to the first tab rather than to nothing.
    const savedActive = (raw as { activeId?: unknown }).activeId;
    const activeId = typeof savedActive === 'string' && seenIds.has(savedActive)
        ? savedActive
        : panes[0].id;

    return { panes, activeId };
}
