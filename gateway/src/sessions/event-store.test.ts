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
    store.addMessage('session:visibility', {
        role: 'user',
        content: '[System: approved immutable plan execution]\nPlan ID: legacy-plan',
    });
    store.addMessage('session:visibility', {
        role: 'user',
        content: 'internal approved plan snapshot',
        metadata: { kind: 'plan_execution_snapshot' },
    });
    store.addMessage('session:visibility', { role: 'assistant', content: 'visible response' });

    assert.equal(store.getMessages('session:visibility').length, 6);
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
