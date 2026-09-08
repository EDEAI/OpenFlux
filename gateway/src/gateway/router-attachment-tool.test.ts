import assert from 'node:assert/strict';
import test from 'node:test';
import { createRouterAttachmentTool } from './router-attachment-tool';
import type { SessionMessage } from '../sessions/types';

test('private attachment follow-up works in Feishu and DingTalk without borrowing another sender or future input', async () => {
    for (const platform of ['feishu-app', 'dingtalk-app']) {
        const message = (id: string, user: string): SessionMessage => ({ id, role: 'user', content: 'image', createdAt: 1,
            metadata: { source: 'router', platform_id: platform, platform_user_id: user },
            attachments: [{ path: `/cache/${id}.png`, name: 'picture.png', ext: '.png', size: 8 }],
        });
        const opened: string[] = [];
        const tool = createRouterAttachmentTool({ platformId: platform, platformUserId: 'a', currentMessageId: 'question',
            messages: () => [message('old', 'a'), message('private-b', 'b'), message('question', 'a'), message('future', 'a')],
            open: path => { opened.push(path); return { success: true }; },
        });
        const listed = (await tool.execute({ action: 'list' })).data as any;
        assert.deepEqual(listed.messages.map((m: any) => m.message_id), ['old', 'question']);
        assert.equal((await tool.execute({ action: 'open', message_id: 'old' })).success, true);
        assert.equal((await tool.execute({ action: 'open', message_id: 'private-b', platform_user_id: 'b' })).success, false);
        assert.equal((await tool.execute({ action: 'open', message_id: 'future' })).success, false);
        assert.deepEqual(opened, ['/cache/old.png']);
    }
});
