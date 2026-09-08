import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from './store';
import { getEventsFilePath } from './transcript';
import type { AgentRuntimeEvent } from '../runtime/events';

const root = mkdtempSync(join(tmpdir(), 'openflux-events-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('group ingress upserts real message IDs in the journal and merges native public aliases', () => {
    const store = new SessionStore({ storePath: root });
    const id = 'project-thread-identity';
    store.create('project-a', 'group', undefined, undefined, id);
    const scope = { source: 'router_group', project_id: 'project-a', platform_id: 'platform', workspace_id: 'tenant', channel_id: 'chat' };
    const native = store.addMessage(id, { role: 'assistant', content: '42', createdAt: 100,
        metadata: { ...scope, source: 'router_group_planning', turnId: 'group-plan:request', runId: 'native-run' } });
    const history = { role: 'assistant' as const, content: '42', createdAt: 200, metadata: {
        ...scope, external_message_id: 'om-1', history_import: true, group_member_project_id: 'member-a',
        public_reply_reference: { result_id: 'result', executor_project_id: 'project-a', executor_member_id: 'member-a', turn_id: 'group-plan:request' },
    } };
    store.upsertGroupMessage(id, history);
    store.upsertGroupMessage(id, history);
    assert.equal(store.getMessages(id).length, 1);
    assert.equal(store.getMessages(id)[0].id, native.id);
    assert.equal(store.getMessages(id)[0].metadata?.runId, 'native-run');
    assert.deepEqual(store.getMessages(id)[0].metadata?.public_platform_message_ids, ['om-1']);
    store.upsertGroupMessage(id, { role: 'user', content: 'hello', createdAt: 300,
        metadata: { ...scope, external_message_id: 'om-question', history_import: false } });
    store.upsertGroupMessage(id, { role: 'user', content: 'hello', createdAt: 300,
        metadata: { ...scope, external_message_id: 'om-question', history_import: true } });
    assert.equal(store.getMessages(id).length, 2);
});

test('refresh retains the loaded anchor after more than one page of new messages', () => {
    const store = new SessionStore({ storePath: root });
    const id = 'session:refresh-anchor';
    store.create('default', 'anchor', undefined, undefined, id);
    const anchor = store.addMessage(id, { role: 'user', content: 'reading here', createdAt: 100 });
    for (let i = 0; i < 65; i++) store.addMessage(id, { role: 'user', content: `new ${i}`, createdAt: 200 + i });
    store.addMessage(id, { role: 'user', content: 'imported history', createdAt: 1 });
    const page = store.getVisibleMessagesPage(id, 20, 0, anchor.id);
    assert.equal(page.messages[0].id, anchor.id);
    assert.equal(page.messages.length, 66);
    assert.equal(page.hasMore, true);
    assert.equal(store.getVisibleMessagesPage(id, 20, 0, 'another-session-id').messages.length, 20);
});

test('attachment preparation updates the original input without adding or changing another turn', () => {
    const store = new SessionStore({ storePath: root });
    const id = 'session:attachment-input';
    store.create('default', 'attachments', undefined, undefined, id);
    const input = store.addMessage(id, { role: 'user', content: 'image', metadata: { turnId: 'one' } });
    store.addMessage(id, { role: 'user', content: 'next', metadata: { turnId: 'two' } });
    assert.equal(store.updateMessage(id, { ...input, content: 'image ready', attachments: [
        { path: '/test/image.png', name: 'image.png', size: 5, ext: '.png' },
    ] }), true);
    const result = store.getMessages(id);
    assert.equal(result.length, 2);
    assert.equal(result[0].id, input.id);
    assert.equal(result[0].metadata?.turnId, 'one');
    assert.equal(result[1].content, 'next');
    assert.equal(store.updateMessage(id, { ...input, id: 'missing' }), false);
});

function event(seq: number): AgentRuntimeEvent {
    return {
        version: 1,
        eventId: `event-${seq}`,
        sessionId: 'session:one',
        turnId: 'turn',
        seq,
        timestamp: seq,
        type: seq === 1 ? 'turn.started' : 'item.completed',
    };
}

test('persists events separately from messages and tolerates a corrupt tail', () => {
    const store = new SessionStore({ storePath: root });
    store.create('default', 'test', undefined, undefined, 'session:one');
    store.addMessage('session:one', { role: 'user', content: 'hello' });
    store.addEvent('session:one', event(1));
    store.addEvent('session:one', event(2));

    const eventPath = getEventsFilePath('session:one', join(root, 'sessions'));
    appendFileSync(eventPath, '{"partial":', 'utf8');

    assert.equal(store.getMessages('session:one').length, 1);
    assert.deepEqual(store.getEvents('session:one').map(item => item.seq), [1, 2]);
    assert.deepEqual(store.getRecentEvents('session:one', 1).map(item => item.seq), [2]);
    assert.deepEqual(store.getRecentEvents('session:one', 3).map(item => item.seq), [1, 2]);
});

test('keeps collaboration announcements available to agents but hides them from chat history', () => {
    const store = new SessionStore({ storePath: root });
    store.create('default', 'visibility', undefined, undefined, 'session:visibility');
    store.addMessage('session:visibility', { role: 'user', content: 'visible request' });
    store.addMessage('session:visibility', {
        role: 'user',
        content: '[Collaboration Announce] legacy timeout',
    });
    store.addMessage('session:visibility', {
        role: 'user',
        content: '[Collaboration Announce] metadata timeout',
        metadata: { internal: true, kind: 'collaboration_announce' },
    });
    store.addMessage('session:visibility', { role: 'assistant', content: 'visible response' });

    assert.equal(store.getMessages('session:visibility').length, 4);
    assert.deepEqual(
        store.getVisibleMessages('session:visibility').map(message => message.content),
        ['visible request', 'visible response'],
    );
    const page = store.getVisibleMessagesPage('session:visibility', 1, 0);
    assert.deepEqual(page.messages.map(message => message.content), ['visible response']);
    assert.equal(page.total, 2);
    assert.equal(page.hasMore, true);
    assert.equal(store.get('session:visibility')?.messageCount, 2);
    assert.equal(store.get('session:visibility')?.lastMessagePreview, 'visible response');
});
