export interface ProjectContextRefreshDecision {
    projectId: string;
    sessionId: string;
    markUnread: boolean;
    refreshVisible: boolean;
}

/**
 * Validate a Gateway project.context_updated event and decide how the desktop
 * should refresh. Keeping this rule separate prevents malformed broadcasts
 * from refreshing an unrelated Project or session.
 */
export function projectContextRefreshDecision(
    payload: Record<string, unknown> | null | undefined,
    currentSessionId: string | null,
): ProjectContextRefreshDecision | null {
    const projectId = typeof payload?.projectId === 'string' ? payload.projectId.trim() : '';
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
    if (!projectId || !sessionId) return null;
    const refreshVisible = sessionId === currentSessionId;
    return {
        projectId,
        sessionId,
        markUnread: !refreshVisible,
        refreshVisible,
    };
}
