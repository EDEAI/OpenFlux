import type { ToolApprovalDecision, ToolApprovalRequest } from '../tools/types';

export interface ToolApprovalClientIdentity {
    id: string;
    authenticated: boolean;
    open: boolean;
    role?: string;
    instanceId?: string;
}

/**
 * Bind a tool approval to the visible Turn/Item timeline that will render it.
 * Child agents execute in hidden sessions, while their progress is projected
 * into the parent tracker; carrying child ids to the UI makes the prompt fail
 * the frontend's session/turn identity check and become invisible.
 */
export function bindToolApprovalToVisibleTurn(
    request: ToolApprovalRequest,
    visibleTurn: { sessionId: string; turnId: string },
): ToolApprovalRequest {
    return {
        ...request,
        sessionId: visibleTurn.sessionId,
        turnId: visibleTurn.turnId,
    };
}

interface PendingToolApproval {
    ownerClientId: string;
    ownerInstanceId?: string;
    request: ToolApprovalRequest;
    resolve: (decision: ToolApprovalDecision) => void;
    deliveredClientIds: Set<string>;
}

type ApprovalSender = (
    client: ToolApprovalClientIdentity,
    request: ToolApprovalRequest,
) => boolean;

/**
 * Routes risk-gated tool approvals to a stable desktop instance.
 *
 * A WebSocket id is intentionally not treated as the durable owner: page reloads
 * and transport reconnects replace it while the turn continues in the Gateway.
 */
export class ToolApprovalBroker {
    private readonly pending = new Map<string, PendingToolApproval>();

    add(
        owner: ToolApprovalClientIdentity,
        request: ToolApprovalRequest,
        resolve: (decision: ToolApprovalDecision) => void,
    ): void {
        this.pending.get(request.requestId)?.resolve('denied');
        this.pending.set(request.requestId, {
            ownerClientId: owner.id,
            ownerInstanceId: owner.instanceId,
            request,
            resolve,
            deliveredClientIds: new Set<string>(),
        });
    }

    remove(requestId: string): void {
        this.pending.delete(requestId);
    }

    deliver(
        requestId: string,
        clients: Iterable<ToolApprovalClientIdentity>,
        send: ApprovalSender,
    ): number {
        const pending = this.pending.get(requestId);
        if (!pending) return 0;

        let delivered = 0;
        for (const client of clients) {
            if (!this.canAnswer(pending, client) || pending.deliveredClientIds.has(client.id)) continue;
            if (!send(client, pending.request)) continue;
            pending.deliveredClientIds.add(client.id);
            delivered += 1;
        }
        return delivered;
    }

    replayTo(client: ToolApprovalClientIdentity, send: ApprovalSender): number {
        let delivered = 0;
        for (const requestId of this.pending.keys()) {
            delivered += this.deliver(requestId, [client], send);
        }
        return delivered;
    }

    notify(
        requestId: string,
        clients: Iterable<ToolApprovalClientIdentity>,
        send: ApprovalSender,
    ): number {
        const pending = this.pending.get(requestId);
        if (!pending) return 0;

        let notified = 0;
        for (const client of clients) {
            if (!this.canAnswer(pending, client)) continue;
            if (send(client, pending.request)) notified += 1;
        }
        return notified;
    }

    resolve(
        client: ToolApprovalClientIdentity,
        requestId: string,
        decision: ToolApprovalDecision,
    ): boolean {
        const pending = this.pending.get(requestId);
        if (!pending || !this.canAnswer(pending, client)) return false;
        pending.resolve(decision);
        return true;
    }

    disconnect(clientId: string): void {
        for (const pending of this.pending.values()) {
            pending.deliveredClientIds.delete(clientId);
            // Legacy clients have no durable identity, so retaining their request
            // would make it impossible for any future connection to approve it.
            if (!pending.ownerInstanceId && pending.ownerClientId === clientId) {
                pending.resolve('denied');
            }
        }
    }

    private canAnswer(pending: PendingToolApproval, client: ToolApprovalClientIdentity): boolean {
        if (!client.authenticated || !client.open || client.role !== 'desktop') return false;
        if (pending.ownerInstanceId) return client.instanceId === pending.ownerInstanceId;
        return client.id === pending.ownerClientId;
    }
}
