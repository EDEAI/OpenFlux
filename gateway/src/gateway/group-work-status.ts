/** Serialize status reports for each work order and retain unacknowledged updates.
 * Durable work-order receipts repopulate this queue after a process restart. */
export class GroupWorkStatusReporter<T extends { work_order_id: string }> {
    private readonly pending = new Map<string, T>();
    private readonly active = new Map<string, Promise<boolean>>();

    constructor(private readonly send: (input: T) => Promise<boolean>) {}

    report(input: T): Promise<boolean> {
        this.pending.set(input.work_order_id, { ...input });
        return this.flush(input.work_order_id);
    }

    retryPending(): void {
        for (const id of this.pending.keys()) void this.flush(id);
    }

    private flush(id: string): Promise<boolean> {
        const active = this.active.get(id);
        if (active) return active;
        // Start in a microtask so even a synchronous rejection cannot race
        // insertion into the active map.
        const task = Promise.resolve().then(async () => {
            while (this.pending.has(id)) {
                const input = this.pending.get(id)!;
                let accepted = false;
                try {
                    accepted = await this.send(input);
                } catch {
                    // Keep the latest update for the next connection/heartbeat.
                }
                if (this.pending.get(id) !== input) continue;
                if (!accepted) return false;
                this.pending.delete(id);
            }
            return true;
        }).finally(() => this.active.delete(id));
        this.active.set(id, task);
        return task;
    }
}
