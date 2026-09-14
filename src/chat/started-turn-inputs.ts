interface TurnInputMessage {
    id: string;
    role: string;
    metadata?: Record<string, unknown>;
}

/** Keeps a started request visible until it appears in persisted history. */
export class StartedTurnInputStore<T extends TurnInputMessage> {
    private readonly inputs = new Map<string, { sessionId: string; message: T }>();

    constructor(private readonly limit = 512) {}

    remember(sessionId: string, message: T): T {
        const identity = message.metadata?.submissionId || message.metadata?.turnId || message.id;
        const key = JSON.stringify([sessionId, identity]);
        const existing = this.inputs.get(key);
        if (existing) return existing.message;
        this.inputs.set(key, { sessionId, message });
        if (this.inputs.size > this.limit) {
            const oldest = this.inputs.keys().next().value;
            if (oldest !== undefined) this.inputs.delete(oldest);
        }
        return message;
    }

    has(sessionId: string): boolean {
        return [...this.inputs.values()].some(input => input.sessionId === sessionId);
    }

    merge(sessionId: string, history: readonly T[]): T[] {
        const messages = [...history];
        for (const [key, input] of this.inputs) {
            if (input.sessionId !== sessionId) continue;
            const live = input.message;
            const matches = (message: T): boolean => message.role === 'user' && (
                message.id === live.id
                || Boolean(live.metadata?.submissionId && message.metadata?.submissionId === live.metadata.submissionId)
                || Boolean(live.metadata?.turnId && message.metadata?.turnId === live.metadata.turnId)
            );
            if (history.some(matches)) {
                this.inputs.delete(key);
                continue;
            }
            // If an answer persisted before its input snapshot, keep the input
            // before that turn's answer so the activity card has its user anchor.
            const answerIndex = messages.findIndex(message => live.metadata?.turnId
                && message.metadata?.turnId === live.metadata.turnId);
            messages.splice(answerIndex < 0 ? messages.length : answerIndex, 0, live);
        }
        return messages;
    }
}
