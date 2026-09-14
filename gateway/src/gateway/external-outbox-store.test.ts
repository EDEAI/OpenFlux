import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExternalOutboxStore, OUTBOX_MAX_ATTEMPTS, outboxRetryDelay } from './external-outbox-store';

const input = { deliveryId: 'dlv-1', mappingId: 'map-1', triggerEventId: 'msg-1', content: '结果内容' };

test('records one result per delivery and never overwrites it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'openflux-outbox-'));
    try {
        const filePath = join(directory, 'outbox.jsonl');
        let now = 1_000;
        const store = new ExternalOutboxStore({ filePath, clock: () => now });
        const first = store.enqueue(input);
        assert.equal(first.created, true);
        assert.equal(first.entry.status, 'pending');
        assert.deepEqual(store.due().map(item => item.id), ['dlv-1:result']);

        now = 2_000;
        const again = store.enqueue({ ...input, content: '改写后的内容' });
        assert.equal(again.created, false);
        assert.equal(again.entry.content, '结果内容');

        store.markAttempt('dlv-1:result');
        assert.equal(store.markAccepted('dlv-1:result', { status: 'sent', sentCount: 1 })?.status, 'accepted');
        assert.deepEqual(store.due(), []);

        const reloaded = new ExternalOutboxStore({ filePath });
        assert.equal(reloaded.get('dlv-1:result')?.status, 'accepted');
        assert.equal(reloaded.get('dlv-1:result')?.receipt?.sentCount, 1);
        assert.equal(reloaded.get('dlv-1:result')?.attempts, 1);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('transport failures back off and give up after the attempt cap', () => {
    const directory = mkdtempSync(join(tmpdir(), 'openflux-outbox-'));
    try {
        let now = 10_000;
        const store = new ExternalOutboxStore({ filePath: join(directory, 'outbox.jsonl'), clock: () => now });
        store.enqueue(input);
        store.markAttempt('dlv-1:result');
        const retried = store.markRetry('dlv-1:result', 'router_not_connected');
        assert.equal(retried?.status, 'pending');
        assert.equal(retried?.nextAttemptAt, 10_000 + outboxRetryDelay(1));
        assert.deepEqual(store.due(10_000), []);
        assert.deepEqual(store.due(10_000 + outboxRetryDelay(1)).map(item => item.id), ['dlv-1:result']);

        for (let attempt = 1; attempt < OUTBOX_MAX_ATTEMPTS; attempt += 1) store.markAttempt('dlv-1:result');
        assert.equal(store.get('dlv-1:result')?.attempts, OUTBOX_MAX_ATTEMPTS);
        assert.equal(store.markRetry('dlv-1:result', 'still down')?.status, 'failed');
        assert.deepEqual(store.pending(), []);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('a Router refusal is settled with one plain fallback send', () => {
    const directory = mkdtempSync(join(tmpdir(), 'openflux-outbox-'));
    try {
        const store = new ExternalOutboxStore({ filePath: join(directory, 'outbox.jsonl') });
        store.enqueue(input);
        assert.equal(store.markFallbackSent('dlv-1:result', '没有找到触发这次处理的群消息')?.status, 'fallback_sent');
        assert.deepEqual(store.due(), []);
        assert.equal(store.markFailed('missing', 'x'), undefined);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('retry delays grow and clamp to the last step', () => {
    assert.equal(outboxRetryDelay(0), 5_000);
    assert.equal(outboxRetryDelay(1), 5_000);
    assert.equal(outboxRetryDelay(2), 30_000);
    assert.equal(outboxRetryDelay(99), 3_600_000);
});
