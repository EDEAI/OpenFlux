/**
 * Validate the conversation identity on an Agent → embedded-browser request.
 * The panel only mounts one conversation at a time, so accepting an absent or
 * different identity would let a background run drive the wrong chat's tab.
 */
export function resolveBrowserSessionRoute(
    requestedSession: unknown,
    activeSession: string | null | undefined,
): { sessionId: string } | { error: string } {
    const sessionId = typeof requestedSession === 'string' ? requestedSession.trim() : '';
    if (!sessionId) return { error: 'browser request is missing its conversation session' };
    if (activeSession !== sessionId) {
        return {
            error: `browser conversation is not active: requested ${sessionId}, active ${activeSession || 'none'}`,
        };
    }
    return { sessionId };
}

/**
 * Opening a tab mutates the pane manager's active layout. Require both the
 * chat selection and the already-synchronized panel scope to name the request
 * session, otherwise a fast conversation switch could write into the layout
 * that is just being left.
 */
export function canOpenBrowserInPanel(
    requestedSession: string,
    currentSession: string | null | undefined,
    panelScope: string | null | undefined,
): boolean {
    return requestedSession === currentSession && requestedSession === panelScope;
}

export interface BrowserPanelPreparationContext {
    currentSession(): string | null | undefined;
    panelScope(): string | null | undefined;
    syncScope(): void;
    activatePane(paneId: string): void;
    expandPanel(): void;
}

/**
 * Reveal a conversation-owned browser pane while preserving the session
 * fence across the synchronous scope update. Keeping this small state change
 * here makes the existing-tab path as safe as opening a new browser tab.
 */
export function prepareBrowserInPanel(
    requestedSession: string,
    paneId: string,
    context: BrowserPanelPreparationContext,
): boolean {
    if (requestedSession !== context.currentSession()) return false;
    context.syncScope();
    if (!canOpenBrowserInPanel(requestedSession, context.currentSession(), context.panelScope())) return false;
    context.activatePane(paneId);
    context.expandPanel();
    return true;
}
