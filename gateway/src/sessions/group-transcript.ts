import type { SessionMessage } from './types';

function scope(message: SessionMessage): string | undefined {
    const m = message.metadata;
    if (!m || !['router_group', 'router_group_planning'].includes(String(m.source))) return;
    const keys = [m.project_id, m.platform_id, m.workspace_id, m.channel_id];
    if (keys.some(key => typeof key !== 'string' || !key)) return;
    return JSON.stringify(keys);
}

function nativeReply(message: SessionMessage): boolean {
    return !!scope(message) && message.role === 'assistant'
        && !message.metadata?.collaboration_event && !message.metadata?.history_import
        && !!(message.metadata?.native_reply_turn_id || message.metadata?.turnId
            || message.metadata?.source === 'router_group_planning');
}

/** Fold only proven identities, never equal text or nearby timestamps.
 * Original journal entries remain recoverable; native activity/turn IDs are preserved.
 */
export function reconcileGroupTranscript(messages: SessionMessage[]): SessionMessage[] {
    if (!messages.some(message => scope(message))) return messages;
    const originalOrder = new Map(messages.map((message, index) => [message.id, index]));
    const owners = new Map<string, number>();
    const nativeTurns = new Map<string, number>();
    const superseded = new Set<number>();
    const result: SessionMessage[] = [];
    const native = messages.filter(nativeReply);
    for (const message of native) {
        const index = result.push(message) - 1;
        const m = message.metadata!;
        const turn = m.native_reply_turn_id || m.turnId
            || (m.source === 'router_group_planning' && m.external_message_id ? `group-plan:${m.external_message_id}` : undefined);
        if (turn) nativeTurns.set(`${scope(message)}:${turn}`, index);
        for (const id of (Array.isArray(m.public_platform_message_ids) ? m.public_platform_message_ids : [])) {
            owners.set(`${scope(message)}:${id}`, index);
        }
    }
    for (const message of messages) {
        if (nativeReply(message)) continue;
        const s = scope(message);
        const m = message.metadata || {};
        if (!s || m.source !== 'router_group' || !m.external_message_id) { result.push(message); continue; }
        const key = `${s}:${m.external_message_id}`;
        const ref = m.public_reply_reference as Record<string, unknown> | undefined;
        const ownReply = ref && ref.executor_project_id === m.project_id
            && ref.executor_member_id === m.group_member_project_id;
        const nativeIndex = ownReply ? nativeTurns.get(`${s}:${ref.turn_id}`) : undefined;
        const previousOwner = owners.get(key);
        if (nativeIndex !== undefined && previousOwner !== undefined && nativeIndex !== previousOwner) {
            // A platform history page can beat the durable public receipt.
            // Once the exact native link arrives, fold that early copy too.
            superseded.add(previousOwner);
        }
        const index = nativeIndex ?? owners.get(key);
        if (index === undefined) {
            owners.set(key, result.length);
            result.push(message);
            continue;
        }
        const previous = result[index];
        if (nativeReply(previous)) {
            const ids = new Set(Array.isArray(previous.metadata?.public_platform_message_ids)
                ? previous.metadata.public_platform_message_ids as string[] : []);
            ids.add(String(m.external_message_id));
            result[index] = { ...previous, metadata: { ...previous.metadata, public_platform_message_ids: [...ids] } };
        } else {
            // History may repair identity/time, but cannot roll back a live edit or deletion.
            const preferred = m.history_import ? previous : message;
            const other = preferred === message ? previous : message;
            result[index] = { ...preferred, id: previous.id,
                createdAt: m.history_import ? message.createdAt : previous.createdAt,
                metadata: { ...other.metadata, ...preferred.metadata,
                    ...(ref ? { public_reply_reference: ref } : {}),
                    ...(m.sender_is_current_member === true ? { sender_is_current_member: true } : {}),
                },
            };
        }
        owners.set(key, index);
    }
    // Stable source-time ordering; native answers retain their own execution time.
    return result.filter((_message, index) => !superseded.has(index)).sort((a, b) => a.createdAt - b.createdAt
        || (originalOrder.get(a.id) || 0) - (originalOrder.get(b.id) || 0));
}
