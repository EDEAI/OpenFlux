import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExternalRequestStore, externalRequestFromDelivery } from './external-request-store';
import type { RouterGroupDelivery } from './router-bridge';

function delivery(overrides: Partial<RouterGroupDelivery> = {}): RouterGroupDelivery {
    return {
        action: 'project_context.append',
        delivery_id: 'dlv-1',
        event_id: 'evt-1',
        external_event_id: 'msg-1',
        event_type: 'message_created',
        platform_id: 'platform-1',
        platform_type: 'dingtalk',
        workspace_id: 'corp-1',
        channel_id: 'cidABC',
        channel_name: '研发群',
        thread_id: '',
        message_id: 'msg-1',
        project_id: 'project-1',
        sender_platform_id: 'staff-1',
        sender_is_current_member: true,
        agent_execution_allowed: true,
        sender_display_name: '小明',
        sender_type: 'human',
        bot_mentioned: true,
        suppress_agent_execution: false,
        text: '帮我看下登录问题',
        mentions: [{ platform_user_id: 'bot', is_bot: true }],
        attachments: [],
        created_at: 1700000000000,
        ...overrides,
    };
}

test('stores a delivery once and dedupes by delivery id and platform event', () => {
    const directory = mkdtempSync(join(tmpdir(), 'openflux-external-requests-'));
    try {
        const filePath = join(directory, 'requests.jsonl');
        let now = 1_000;
        const store = new ExternalRequestStore({ filePath, clock: () => now });

        const first = store.record(delivery());
        assert.equal(first.created, true);
        assert.equal(first.item.status, 'received');
        assert.equal(first.item.receivedAt, 1_000);
        assert.equal(first.item.channelName, '研发群');
        assert.equal(first.item.botMentioned, true);

        now = 2_000;
        const sameDelivery = store.record(delivery());
        assert.equal(sameDelivery.created, false);
        assert.equal(sameDelivery.item.receivedAt, 1_000);

        // Router may issue a new delivery id for the same platform event after a retry.
        const sameEvent = store.record(delivery({ delivery_id: 'dlv-1-retry' }));
        assert.equal(sameEvent.created, false);
        assert.equal(sameEvent.item.id, 'dlv-1');

        const other = store.record(delivery({ delivery_id: 'dlv-2', external_event_id: 'msg-2', message_id: 'msg-2' }));
        assert.equal(other.created, true);
        assert.equal(store.size, 2);
        assert.deepEqual(store.list().map(item => item.id), ['dlv-1', 'dlv-2']);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('ack status survives reload and a truncated tail line', () => {
    const directory = mkdtempSync(join(tmpdir(), 'openflux-external-requests-'));
    try {
        const filePath = join(directory, 'requests.jsonl');
        const store = new ExternalRequestStore({ filePath, clock: () => 5_000 });
        store.record(delivery());
        store.record(delivery({ delivery_id: 'dlv-2', external_event_id: 'msg-2' }));
        assert.equal(store.markAckFailed('dlv-1', 'router_not_connected'), true);
        assert.equal(store.markAcked('dlv-2'), true);
        assert.equal(store.markAcked('missing'), false);
        assert.deepEqual(store.unacked().map(item => item.id), ['dlv-1']);

        // Simulate an interrupted append.
        appendFileSync(filePath, '{"version":1,"type":"status","timestamp":6000,"id":"dlv-1","status":"ack', 'utf8');

        const reloaded = new ExternalRequestStore({ filePath, clock: () => 7_000 });
        assert.equal(reloaded.size, 2);
        assert.equal(reloaded.get('dlv-1')?.status, 'ack_failed');
        assert.equal(reloaded.get('dlv-1')?.ackError, 'router_not_connected');
        assert.equal(reloaded.get('dlv-2')?.status, 'acked');
        assert.equal(reloaded.get('dlv-2')?.ackedAt, 5_000);

        // The repaired boundary keeps the next record on its own line.
        assert.equal(reloaded.markAcked('dlv-1'), true);
        const again = new ExternalRequestStore({ filePath });
        assert.equal(again.get('dlv-1')?.status, 'acked');
        assert.deepEqual(again.unacked(), []);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('rejects deliveries without identity so nothing unstored gets acked', () => {
    const directory = mkdtempSync(join(tmpdir(), 'openflux-external-requests-'));
    try {
        const store = new ExternalRequestStore({ filePath: join(directory, 'requests.jsonl') });
        assert.throws(() => store.record(delivery({ delivery_id: '' })), /delivery_id/);
        assert.throws(() => store.record(delivery({ external_event_id: '' })), /事件标识/);
        assert.equal(store.size, 0);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('normalizes optional fields and history flags', () => {
    const item = externalRequestFromDelivery(delivery({
        channel_name: null,
        sender_display_name: '  ',
        history_import: true,
        agent_execution_allowed: false,
        created_at: undefined as unknown as number,
        document_references: [{ type: 'docx', id: 'doc-1' }],
    }), 9_000);
    assert.equal(item.channelName, undefined);
    assert.equal(item.senderDisplayName, undefined);
    assert.equal(item.historyImport, true);
    assert.equal(item.agentExecutionAllowed, false);
    assert.equal(item.createdAt, 9_000);
    assert.deepEqual(item.documentReferences, [{ type: 'docx', id: 'doc-1' }]);
});

test('deferred requests stay releasable until they complete', () => {
    const directory = mkdtempSync(join(tmpdir(), 'openflux-external-requests-'));
    try {
        const filePath = join(directory, 'requests.jsonl');
        const store = new ExternalRequestStore({ filePath, clock: () => 1_000 });
        store.record(delivery({ mapping_id: 'map-1' }));
        store.record(delivery({ mapping_id: 'map-1', delivery_id: 'dlv-2', external_event_id: 'msg-2', bot_mentioned: false }));
        assert.deepEqual(store.unreleased('map-1').map(item => item.id), ['dlv-1']);

        assert.equal(store.markDeferred('dlv-1', 's-1', 'goal_active'), true);
        assert.equal(store.get('dlv-1')?.release?.status, 'deferred');
        assert.deepEqual(store.unreleased('map-1').map(item => item.id), ['dlv-1']);

        assert.equal(store.markReleased('dlv-1', 's-1'), true);
        assert.deepEqual(store.unreleased('map-1'), []);
        assert.equal(store.markReleaseResult('dlv-1', 'waiting_input'), true);
        assert.equal(store.markReleaseResult('dlv-1', 'completed'), true);

        const reloaded = new ExternalRequestStore({ filePath });
        assert.equal(reloaded.get('dlv-1')?.release?.status, 'completed');
        assert.equal(reloaded.get('dlv-1')?.release?.releasedAt, 1_000);
        assert.deepEqual(reloaded.unreleased('map-1'), []);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
