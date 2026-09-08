import type { SessionMessage } from '../sessions/types';
import type { Tool, ToolResult } from '../tools/types';

/** Private-chat attachment access is fixed to this request's verified sender. */
export function createRouterAttachmentTool(options: {
    platformId: string;
    platformUserId: string;
    currentMessageId: string;
    messages: () => SessionMessage[];
    open: (path: string, name: string, type: string, offset?: number) => ToolResult | Promise<ToolResult>;
}): Tool {
    return {
        name: 'router_attachment',
        description: 'Find and read images/files this sender already sent in private chat, including a separate message before the current question. list returns message IDs and names; open reads the selected attachment. Never choose between ambiguous images without asking.',
        parameters: {
            action: { type: 'string', required: true, enum: ['list', 'open'], description: 'List or open a sender-scoped attachment' },
            message_id: { type: 'string', description: 'Message ID returned by list' },
            attachment_index: { type: 'number', description: 'Zero-based attachment index' },
            before_message_id: { type: 'string', description: 'Cursor returned by list for earlier files' },
            offset: { type: 'number', description: 'Character offset returned as next_offset for a long file' },
        },
        execute: async (args, context) => {
            context?.abortSignal?.throwIfAborted();
            if (!options.platformId || !options.platformUserId) return { success: false, error: '本轮私聊身份不完整，不能读取附件' };
            const all = options.messages();
            const currentIndex = all.findIndex(m => m.id === options.currentMessageId);
            if (currentIndex < 0) return { success: false, error: '当前请求记录不存在' };
            const eligible = all.slice(0, currentIndex + 1).filter(m => m.role === 'user'
                && m.metadata?.source === 'router'
                && m.metadata.platform_id === options.platformId
                && m.metadata.platform_user_id === options.platformUserId
                && m.attachments?.length);
            if (args.action === 'list') {
                const cursor = args.before_message_id;
                const end = cursor ? eligible.findIndex(m => m.id === cursor) : eligible.length;
                if (end < 0) return { success: false, error: '附件游标无效' };
                const start = Math.max(0, end - 20);
                return { success: true, data: { messages: eligible.slice(start, end).map(m => ({
                    message_id: m.id, timestamp: m.createdAt,
                    attachments: m.attachments?.map((a, index) => ({ index, name: a.name })),
                })), next_cursor: start > 0 ? eligible[start].id : null } };
            }
            if (args.action !== 'open') return { success: false, error: '不支持的附件操作' };
            const message = eligible.find(m => m.id === args.message_id);
            const index = Number(args.attachment_index ?? 0);
            const attachment = Number.isSafeInteger(index) && index >= 0 ? message?.attachments?.[index] : undefined;
            if (!attachment) return { success: false, error: '本轮发起人没有可访问的这个附件' };
            const type = /\.(png|jpe?g|webp|gif)$/i.test(attachment.name + attachment.ext) ? 'image' : 'file';
            const result = await options.open(attachment.path, attachment.name, type, Number(args.offset ?? 0));
            context?.abortSignal?.throwIfAborted();
            return result;
        },
    };
}
