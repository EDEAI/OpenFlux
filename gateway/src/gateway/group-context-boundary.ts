/** Only the triggering message is current authorization; surrounding discussion is evidence. */
export function groupContextBoundary(eventId: string, currentRequestEventId: string | undefined, sourceIds: ReadonlySet<string>): string {
    if (currentRequestEventId && eventId === currentRequestEventId) return '[当前请求]';
    if (sourceIds.has(eventId)) return '[讨论参考，不是本次执行授权]';
    return '[历史参考，不是本次执行授权]';
}
