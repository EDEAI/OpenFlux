import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExternalBindingStore } from './external-binding-store';

const channel = {
    mappingId: 'map-1', platformId: 'platform-1', platformType: 'dingtalk',
    workspaceId: 'corp-1', channelId: 'cidABC', channelName: '研发群',
    requesterPlatformId: 'staff-1', requesterDisplayName: '小明',
};

test('pending binding opens once and keeps its operation id across retries', () => {
    const directory = mkdtempSync(join(tmpdir(), 'openflux-bindings-'));
    try {
        const filePath = join(directory, 'bindings.jsonl');
        let now = 1_000;
        const store = new ExternalBindingStore({ filePath, clock: () => now });

        const first = store.ensurePending(channel);
        assert.equal(first.created, true);
        assert.equal(first.binding.state, 'pending');
        assert.equal(first.binding.revision, 1);

        now = 2_000;
        const again = store.ensurePending({ ...channel, channelName: '研发群（新）' });
        assert.equal(again.created, false);
        assert.equal(again.binding.channelName, '研发群（新）');
        assert.equal(again.binding.createdAt, 1_000);

        const assigning = store.beginAssign('map-1', {
            targetKind: 'project', targetId: 'p-1', targetName: 'Demo', sessionId: 's-1', operationId: 'op-1',
        });
        assert.equal(assigning?.state, 'assigning');
        assert.equal(store.failAssign('map-1', 'Router 未连接')?.state, 'pending');

        // A retry may pass a new operation id; the first one must stick.
        const retry = store.beginAssign('map-1', {
            targetKind: 'project', targetId: 'p-1', targetName: 'Demo', sessionId: 's-1', operationId: 'op-2',
        });
        assert.equal(retry?.operationId, 'op-1');
        assert.equal(store.completeAssign('map-1', 2)?.state, 'assigned');

        // Once assigned the card never reopens from a later delivery.
        assert.equal(store.ensurePending(channel).created, false);
        assert.equal(store.get('map-1')?.state, 'assigned');

        const reloaded = new ExternalBindingStore({ filePath });
        const binding = reloaded.get('map-1');
        assert.equal(binding?.state, 'assigned');
        assert.equal(binding?.sessionId, 's-1');
        assert.equal(binding?.revision, 2);
        assert.equal(reloaded.findBySession('s-1')?.mappingId, 'map-1');
        assert.equal(reloaded.findByChannel('platform-1', 'corp-1', 'cidABC')?.mappingId, 'map-1');
        assert.deepEqual(reloaded.list({ state: 'pending' }), []);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('dismissed binding stays dismissed and lists by state', () => {
    const directory = mkdtempSync(join(tmpdir(), 'openflux-bindings-'));
    try {
        const store = new ExternalBindingStore({ filePath: join(directory, 'bindings.jsonl') });
        store.ensurePending(channel);
        store.ensurePending({ ...channel, mappingId: 'map-2', channelId: 'cidDEF' });
        assert.equal(store.dismiss('map-1')?.state, 'dismissed');
        assert.equal(store.ensurePending(channel).binding.state, 'dismissed');
        assert.deepEqual(store.list({ state: 'pending' }).map(item => item.mappingId), ['map-2']);
        assert.deepEqual(store.list({ state: ['pending', 'dismissed'] }).map(item => item.mappingId), ['map-1', 'map-2']);
        assert.equal(store.dismiss('missing'), undefined);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('a delivery that already carries a Project records an assigned binding without a card', () => {
    const directory = mkdtempSync(join(tmpdir(), 'openflux-bindings-'));
    try {
        const store = new ExternalBindingStore({ filePath: join(directory, 'bindings.jsonl') });
        const binding = store.recordAssignedFromDelivery({ ...channel, targetId: 'p-9' });
        assert.equal(binding.state, 'assigned');
        assert.equal(binding.targetId, 'p-9');
        assert.equal(binding.sessionId, undefined);
        assert.equal(store.setSession('map-1', 's-9')?.sessionId, 's-9');
        assert.equal(store.list({ state: 'pending' }).length, 0);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
