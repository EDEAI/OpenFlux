import type { EventIdentity } from './follow-up-controller';

/** External ingress bookkeeping; the ordinary Assistant controller is unchanged. */
export class ExternalTurnLifecycle {
    private readonly runs = new Map<string, 'running' | 'stopped' | 'terminal'>();

    private key(identity: EventIdentity): string | undefined {
        return identity.sessionId && identity.turnId && identity.runId
            ? JSON.stringify([identity.sessionId, identity.turnId, identity.runId]) : undefined;
    }

    start(identity: EventIdentity): boolean {
        const key = this.key(identity);
        if (!key) return false;
        const state = this.runs.get(key);
        if (state === 'stopped' || state === 'terminal') return false;
        this.runs.set(key, 'running');
        if (this.runs.size > 2000) this.runs.delete(this.runs.keys().next().value!);
        return true;
    }

    owns(identity: EventIdentity): boolean {
        const key = this.key(identity);
        return !!key && this.runs.has(key);
    }

    isRunning(identity: EventIdentity): boolean {
        const key = this.key(identity);
        return !!key && this.runs.get(key) === 'running';
    }

    finish(identity: EventIdentity, stopped = false): void {
        const key = this.key(identity);
        if (key && this.runs.has(key)) this.runs.set(key, stopped ? 'stopped' : 'terminal');
    }
}
