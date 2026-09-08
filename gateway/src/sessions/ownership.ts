import type { SessionMetadata } from './types';

export interface ConversationOwnerEntity {
    id: string;
    kind: 'agent' | 'project';
    default?: boolean;
}

export interface ConversationOwnershipLookup {
    getSession(sessionId: string): SessionMetadata | null | undefined;
    getOwner(ownerId: string): ConversationOwnerEntity | undefined;
    hasPendingExecution?(sessionId: string): boolean;
}

export interface ConversationOwnershipUpdate {
    sessionId: string;
    ownerId: string;
}

/** Validate the narrow ownership contract exposed to the conversation UI. */
export function validateConversationOwnershipUpdate(
    input: unknown,
    lookup: ConversationOwnershipLookup,
): ConversationOwnershipUpdate {
    const payload = input && typeof input === 'object'
        ? input as Record<string, unknown>
        : {};
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
    const ownerId = typeof payload.ownerId === 'string' ? payload.ownerId.trim() : '';
    if (!sessionId || !ownerId) throw new Error('缺少会话或归属对象。');

    const session = lookup.getSession(sessionId);
    if (!session || session.status !== 'active' || session.cloudChatroomId
        || session.kind === 'child' || session.visibility === 'hidden') {
        throw new Error('该会话不能更改归属。');
    }
    if (session.messageCount > 0) {
        throw new Error('已有内容的会话不能更改归属。');
    }
    if (lookup.hasPendingExecution?.(sessionId)) {
        throw new Error('会话已开始执行，不能再更改归属。');
    }

    const owner = lookup.getOwner(ownerId);
    if (!owner || (owner.kind !== 'project' && owner.kind !== 'agent')) {
        throw new Error('会话只能归属某个项目或 Agent。');
    }

    return { sessionId, ownerId: owner.id };
}
