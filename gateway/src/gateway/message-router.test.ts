import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageRouter } from './message-router';

test('dispatches registered handlers and leaves unknown domains to the legacy router', async () => {
    const calls: string[] = [];
    const router = new MessageRouter<{ name: string }>()
        .register('chat', async (client, message) => {
            calls.push(`${client.name}:${message.type}`);
        });

    assert.equal(await router.dispatch({ name: 'client' }, { type: 'chat' }), true);
    assert.equal(await router.dispatch({ name: 'client' }, { type: 'scheduler.list' }), false);
    assert.deepEqual(calls, ['client:chat']);
    assert.throws(() => router.register('chat', () => undefined), /already registered/);
});
