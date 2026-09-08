import type { AgentRuntimeEvent } from '../runtime/events';
import type { SessionMessage } from '../sessions/types';

export interface AgentHistoryMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

function metadataString(message: SessionMessage, key: string): string {
    const value = message.metadata?.[key];
    return typeof value === 'string' ? value.trim() : '';
}

function terminalTurnStates(events: AgentRuntimeEvent[]): Map<string, AgentRuntimeEvent['type']> {
    const result = new Map<string, AgentRuntimeEvent['type']>();
    for (const event of events) {
        if (
            event.type === 'turn.completed'
            || event.type === 'turn.failed'
            || event.type === 'turn.interrupted'
        ) {
            result.set(event.turnId, event.type);
        }
    }
    return result;
}

function currentPlatformMessageIndexes(messages: SessionMessage[]): Map<string, number> {
    const indexes = new Map<string, number>();
    messages.forEach((message, index) => {
        if (metadataString(message, 'source') !== 'router_group') return;
        if (!metadataString(message, 'event_type')) return;
        const externalMessageId = metadataString(message, 'external_message_id');
        if (externalMessageId) indexes.set(externalMessageId, index);
    });
    return indexes;
}

/**
 * Build model history from the visible transcript without letting failed turns,
 * stale platform edits, delivery-only notices, or attachment failures authorize
 * a later request. The original messages remain on disk and visible in the UI.
 */
export function buildAgentHistory(
    messages: SessionMessage[],
    events: AgentRuntimeEvent[],
    currentTurnId?: string,
): AgentHistoryMessage[] {
    const currentIndex = currentTurnId
        ? messages.findIndex(message => message.role === 'user' && metadataString(message, 'turnId') === currentTurnId)
        : -1;
    const futureTurns = new Set(messages.slice(currentIndex >= 0 ? currentIndex : messages.length)
        .filter(message => message.role === 'user').map(message => metadataString(message, 'turnId')).filter(Boolean));
    const terminalStates = terminalTurnStates(events);
    const latestPlatformIndexes = currentPlatformMessageIndexes(messages);

    return messages.flatMap((message, index): AgentHistoryMessage[] => {
        if (!['user', 'assistant', 'system'].includes(message.role)) return [];
        const turnId = metadataString(message, 'turnId');
        if (turnId && (turnId === currentTurnId || futureTurns.has(turnId))) return [];
        if (currentIndex >= 0 && index >= currentIndex && message.role === 'user') return [];
        const terminal = turnId ? terminalStates.get(turnId) : undefined;
        if (terminal === 'turn.failed' || terminal === 'turn.interrupted') return [];

        const metadata = message.metadata || {};
        if (metadata.attachment_download_failed === true) return [];
        if (metadata.display_only === true || metadata.collaboration_event) return [];

        const source = metadataString(message, 'source');
        const eventType = metadataString(message, 'event_type');
        const externalMessageId = metadataString(message, 'external_message_id');
        if (source === 'router_group' && eventType && externalMessageId) {
            if (latestPlatformIndexes.get(externalMessageId) !== index) return [];
            if (eventType === 'message_deleted') return [];
        }

        let content = typeof message.content === 'string'
            ? message.content
            : JSON.stringify(message.content);
        if (!content.trim()) return [];

        // Session JSONL intentionally keeps platform metadata for rendering.
        // Restore the speaker label before giving a group line to the model.
        if (source === 'router_group' && message.role === 'user') {
            const sender = metadataString(message, 'sender_display_name') || '群成员';
            const role = metadataString(message, 'sender_role_name');
            content = `[群消息 · ${sender}${role ? `（${role}）` : ''}] ${content}`;
        }

        return [{
            role: message.role as AgentHistoryMessage['role'],
            content,
        }];
    });
}
