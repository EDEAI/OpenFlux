import type { SessionMessage } from '../sessions/types';
import type { ProjectContextEvent, ProjectContextAttachment } from './project-context-store';
import type { RouterGroupCollaboration } from './router-bridge';

function contentText(value: any, attachments: ProjectContextAttachment[]): string {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return '';
    if (Array.isArray(value)) return value.map(item => contentText(item, attachments)).filter(Boolean)
        .join(value.some(Array.isArray) ? '\n' : '');
    const mediaKey = value.image_key || value.file_key;
    if (mediaKey) {
        if (!attachments.some(item => item.id === mediaKey)) attachments.push({ id: mediaKey,
            type: value.image_key ? 'image' : 'file', name: value.file_name || value.name || undefined });
        return value.file_name || (value.image_key ? '[图片]' : '[附件]');
    }
    if (value.tag === 'at') return value.user_name ? `@${value.user_name}` : '@成员';
    if (typeof value.text === 'string') return value.href ? `${value.text} (${value.href})` : value.text;
    if (typeof value.content === 'string') return value.content;
    if (value.title || value.content || value.elements || value.body) {
        return [contentText(value.title, attachments), contentText(value.content, attachments),
            contentText(value.elements, attachments), contentText(value.body, attachments)].filter(Boolean).join('\n');
    }
    // Post messages may be localized. Read one locale rather than duplicating every translation.
    const locale = value.zh_cn || value.en_us || value.zh_hk || value.ja_jp;
    return locale ? contentText(locale, attachments) : '';
}

export function normalizeFeishuHistory(item: any, group: RouterGroupCollaboration, projectId: string, selfId: string): ProjectContextEvent {
    if (!item || typeof item.message_id !== 'string' || item.chat_id !== group.channel_id) throw new Error('历史消息群标识不匹配');
    let body: any;
    try { body = JSON.parse(item.body?.content || '{}'); } catch { body = { text: String(item.body?.content || '') }; }
    const senderId = String(item.sender?.id || 'unknown');
    const member = group.members.find(member => member.platform_member_id === senderId);
    const attachments: ProjectContextAttachment[] = [];
    let text = item.deleted ? '' : contentText(body, attachments);
    for (const mention of item.mentions || []) {
        if (mention.key) text = text.split(mention.key).join(`@${mention.name || '成员'}`);
    }
    if (!text && !item.deleted && attachments.length === 0) text = `[${item.msg_type || '消息'}] ${item.body?.content || ''}`;
    const bot = item.sender?.sender_type === 'app';
    const version = Number(item.update_time || item.create_time || 0);
    return {
        action: 'project_context.append', delivery_id: `history:${item.message_id}:${version}`,
        event_id: `history:${item.message_id}:${version}`, external_event_id: `history:${item.message_id}:${version}`,
        event_type: item.deleted ? 'message_deleted' : item.updated ? 'message_edited' : 'message_created',
        platform_id: group.platform_id, platform_type: 'feishu', workspace_id: group.workspace_id,
        channel_id: group.channel_id, channel_name: group.channel_name, thread_id: item.thread_id || '', message_id: item.message_id,
        project_id: projectId, sender_platform_id: senderId, sender_type: bot ? 'bot' : 'human',
        sender_display_name: member?.display_name || (bot ? '群机器人' : item.sender?.name || '飞书群成员'),
        sender_role_name: member?.role_name || '', sender_is_current_member: senderId === selfId,
        suppress_agent_execution: true, agent_execution_allowed: false, bot_mentioned: false,
        text, mentions: item.deleted ? [] : item.mentions || [], attachments: item.deleted ? [] : attachments,
        created_at: Number(item.create_time || 0), edited_at: version,
    };
}

export function historySessionMessage(event: ProjectContextEvent): SessionMessage {
    const bot = event.sender_type === 'bot' || event.sender_type === 'app';
    return {
        id: `group-history:${event.platform_id}:${event.channel_id}:${event.message_id}`,
        role: bot ? 'assistant' : 'user', content: event.event_type === 'message_deleted' ? '[消息已撤回]' : event.text || '(附件消息)',
        createdAt: event.created_at,
        metadata: { ...event, source: 'router_group', external_message_id: event.message_id,
            external_event_id: event.external_event_id, history_only: true, suppress_agent_execution: true,
            agent_execution_allowed: false, collaboration_event: event.collaboration_event || (bot ? { event_type: 'public.answer' } : undefined) },
    };
}

/** Overlay canonical external content while retaining native turns and tool/activity metadata. */
export function mergeHistoryMessages(current: SessionMessage[], history: SessionMessage[]): SessionMessage[] {
    if (history.length === 0) return current;
    const identity = (message: SessionMessage): string | undefined => {
        const m = message.metadata;
        return m?.external_message_id ? JSON.stringify([m.platform_id, m.channel_id, m.external_message_id]) : undefined;
    };
    const byId = new Map(history.map(message => [identity(message), message]));
    const merged: SessionMessage[] = [];
    const seen = new Set<string>();
    for (const message of current) {
        const key = identity(message);
        const historical = key ? byId.get(key) : undefined;
        if (historical && key) {
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push({ ...message, content: historical.content, createdAt: historical.createdAt,
                attachments: historical.metadata?.event_type === 'message_deleted' ? undefined : message.attachments,
                metadata: { ...historical.metadata, ...message.metadata } });
        } else merged.push(message);
    }
    for (const message of history) {
        const key = identity(message)!;
        if (!seen.has(key)) { merged.push(message); seen.add(key); }
    }
    return merged.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}
