/** Prevents an older history response from replacing a newer committed view. */
export class HistoryLoadOrder {
    private nextVersion = 0;
    private readonly committed = new Map<string, number>();

    begin(): number {
        return ++this.nextVersion;
    }

    commit(sessionId: string, version: number): boolean {
        if (!this.canCommit(sessionId, version)) return false;
        this.committed.set(sessionId, version);
        return true;
    }

    canCommit(sessionId: string, version: number): boolean {
        return version >= (this.committed.get(sessionId) || 0);
    }
}
