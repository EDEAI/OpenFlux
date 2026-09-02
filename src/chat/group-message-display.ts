export interface GroupMessageDisplayMetadata {
    source?: unknown;
    platform_type?: unknown;
    sender_platform_id?: unknown;
    sender_type?: unknown;
    sender_flux_user_id?: unknown;
    sender_is_current_member?: unknown;
    sender_display_name?: unknown;
    sender_role_name?: unknown;
    collaboration_event?: unknown;
}

/** Hide legacy dispatch receipts, not user text or native Agent activity. */
export function isGroupRequestNotice(metadata?: GroupMessageDisplayMetadata): boolean {
    if (metadata?.source !== 'router_group' || metadata.platform_type !== 'feishu') return false;
    const event = metadata.collaboration_event;
    return !!event && typeof event === 'object' && 'type' in event && event.type === 'intent.requested';
}

function extractJsonStringField(raw: string, field: string): string | undefined {
    const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`"${escapedField}"\\s*:\\s*"`, 'i').exec(raw);
    if (!match) return undefined;
    const start = match.index + match[0].length;
    let escaped = false;
    for (let index = start; index < raw.length; index += 1) {
        const char = raw[index];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (char === '\\') {
            escaped = true;
            continue;
        }
        if (char !== '"') continue;
        try {
            return JSON.parse(`"${raw.slice(start, index)}"`);
        } catch {
            return undefined;
        }
    }
    return undefined;
}

/** Keep historical Group Project replies readable without exposing the
 * internal JSON protocol that older builds persisted into the transcript. */
export function groupAssistantContentForDisplay(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return trimmed;
    try {
        const envelope = JSON.parse(trimmed) as Record<string, unknown>;
        const isInternalGroupEnvelope = envelope
            && typeof envelope === 'object'
            && 'public_reply' in envelope
            && ['work_items', 'personal_deliveries', 'bot_handoffs', 'bot_task_result']
                .some(field => field in envelope);
        if (isInternalGroupEnvelope) {
            if (typeof envelope.public_reply === 'string' && envelope.public_reply.trim()) {
                return envelope.public_reply.trim();
            }
            return '这条历史回复的展示格式异常，请重新在群里 @机器人 发送一次。';
        }
        return trimmed;
    } catch { /* recover a complete public_reply from a malformed envelope below */ }
    const looksLikeInternalGroupEnvelope = /"public_reply"\s*:/i.test(trimmed)
        && /"(?:work_items|personal_deliveries|bot_handoffs|bot_task_result)"\s*:/i.test(trimmed);
    if (!looksLikeInternalGroupEnvelope) return trimmed;
    const recovered = extractJsonStringField(trimmed, 'public_reply')?.trim();
    return recovered || '这条历史回复的展示格式异常，请重新在群里 @机器人 发送一次。';
}

/** Hide platform IDs and old mention placeholders in historical Group Project
 * user messages. New messages already arrive with friendly sender labels. */
export function groupUserContentForDisplay(
    raw: string,
    metadata?: GroupMessageDisplayMetadata,
    resolvedSenderName?: string,
): string {
    if (metadata?.source !== 'router_group') return raw;

    let display = raw
        .replace(/^成员\s+(?:ou_[\w-]+|U[A-Z0-9]+)\s*:\s*/u, '')
        .replace(/^已绑定成员(?:（[^）]+）)?\s*:\s*/u, '')
        .replace(/^.+?（(?:前端|后端|测试|设计|产品|项目成员)）\s*:\s*/u, '')
        .replace(/@_user_\d+\b/giu, '@FluxBot');
    const displayName = typeof metadata.sender_display_name === 'string'
        ? metadata.sender_display_name.trim()
        : '';
    const roleName = typeof metadata.sender_role_name === 'string'
        ? metadata.sender_role_name.trim()
        : '';
    const legacyLabels = [
        displayName && roleName ? `${displayName} · ${roleName}` : '',
        displayName,
        resolvedSenderName?.trim() || '',
    ].filter(Boolean);
    for (const label of legacyLabels) {
        if (display.startsWith(`${label}:`)) {
            display = display.slice(label.length + 1).trimStart();
            break;
        }
    }
    return display;
}

export function isCurrentGroupSender(metadata?: GroupMessageDisplayMetadata): boolean {
    return metadata?.source === 'router_group' && metadata.sender_is_current_member === true;
}

export function groupSenderLabel(
    metadata?: GroupMessageDisplayMetadata,
    resolvedSenderName?: string,
): string {
    if (metadata?.source !== 'router_group') return '';
    const platformName = metadata.platform_type === 'feishu'
        ? '飞书'
        : metadata.platform_type === 'slack'
            ? 'Slack'
            : '外部群聊';
    const senderName = isCurrentGroupSender(metadata)
        ? '我'
        : metadata.sender_type === 'bot'
        ? '群机器人'
        : resolvedSenderName?.trim()
            || (typeof metadata.sender_display_name === 'string' ? metadata.sender_display_name.trim() : '')
            || '群成员';
    return `${senderName} · ${platformName}`;
}
