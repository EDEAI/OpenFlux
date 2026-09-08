import assert from 'node:assert/strict';
import test from 'node:test';
import { createGroupHistoryTool } from './group-history-tool';

function fixture(cachedPath?: string, memberStatus = 'active') {
    const calls: unknown[] = [];
    const scope = { project_id: 'project-a', platform_id: 'platform-a', workspace_id: 'tenant-a', channel_id: 'group-a', thread_id: '' };
    const tool = createGroupHistoryTool({
        store: {
            getConversationForSession: () => scope,
            readHistoryPage: (key: unknown) => { calls.push(key); return { messages: [], next: undefined }; },
            getMessageByExternalId: (...ids: string[]) => {
                calls.push(ids);
                return ids[4] === 'message-a'
                    ? { message_id: 'message-a', last_event_id: 'event-a', thread_id: 'thread-a', text: 'x'.repeat(9000), deleted: false,
                        attachments: cachedPath ? [{ local_path: cachedPath, name: 'image.png', type: 'image' }] : [] }
                    : undefined;
            },
        } as any,
        bridge: {
            getGroupCollaborations: async () => ({ collaborations: [{ id: 'collaboration-a', ...scope, status: 'active', current_member_id: 'member-a',
                members: [{ id: 'member-a', project_id: 'project-a', status: memberStatus }] }] }),
            accessGroupHistory: async (request: unknown) => { calls.push(request); return { attachments: [{ url: 'https://router.test/media/scoped', name: 'image.png', type: 'image' }] }; },
        } as any,
        sessionId: () => 'session-a',
        openAttachment: async (url: string) => { calls.push(url); return { success: true }; },
        openLocalAttachment: (project, path) => { calls.push({ project, path }); return { success: true, images: [{ mimeType: 'image/png', data: 'cached' }] }; },
    });
    return { tool, calls };
}

test('history scope comes from the session, not caller-supplied project or account', async () => {
    const { tool, calls } = fixture();
    await tool.execute({ action: 'read', project_id: 'victim-project', app_user_id: 'victim-user' });
    assert.deepEqual(calls, [{ projectId: 'project-a', platformId: 'platform-a', workspaceId: 'tenant-a', channelId: 'group-a', threadId: undefined }]);
});

test('a current cached image opens without calling historical access or redownloading', async () => {
    const { tool, calls } = fixture('/project-a/.openflux/attachments/image.png');
    const result = await tool.execute({ action: 'attachment', message_id: 'message-a', path: '/victim/file' });
    assert.equal(result.images?.[0].data, 'cached');
    assert.ok(calls.some(c => typeof c === 'object' && (c as any).project === 'project-a'));
    assert.ok(!calls.some(c => typeof c === 'object' && (c as any).operation));
});

test('paused membership and invalid attachment indices cannot read the cached file', async () => {
    const { tool, calls } = fixture('/cache/image', 'paused');
    assert.equal((await tool.execute({ action: 'attachment', message_id: 'message-a' })).success, false);
    assert.ok(!calls.some(c => typeof c === 'object' && (c as any).path));
    const active = fixture('/cache/image');
    assert.equal((await active.tool.execute({ action: 'attachment', message_id: 'message-a', attachment_index: -1 })).success, false);
});

test('invalid history cursors fail safely without querying the store', async () => {
    const { tool, calls } = fixture();
    for (const cursor of ['{broken', 'null', '{"time":"1","id":2}']) {
        assert.equal((await tool.execute({ action: 'read', cursor })).success, false);
    }
    assert.equal(calls.length, 0);
});

test('a long history message can be read fully without silently truncating it', async () => {
    const { tool } = fixture();
    const first = await tool.execute({ action: 'message', message_id: 'message-a' });
    const second = await tool.execute({ action: 'message', message_id: 'message-a', offset: 8000 });
    assert.equal((first.data as any).text.length + (second.data as any).text.length, 9000);
    assert.equal((first.data as any).next_offset, 8000);
    assert.equal((second.data as any).next_offset, null);
});

test('attachments are resolved by the verified event, never a supplied URL', async () => {
    const { tool, calls } = fixture();
    assert.equal((await tool.execute({ action: 'attachment', message_id: 'message-a', url: 'http://untrusted.test' })).success, true);
    assert.ok(calls.includes('https://router.test/media/scoped'));
    assert.ok(!calls.includes('http://untrusted.test'));
    assert.equal((await tool.execute({ action: 'attachment', message_id: 'private-message' })).success, false);
});
