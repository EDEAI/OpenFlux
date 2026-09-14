import test from 'node:test';
import assert from 'node:assert/strict';
import {
    RouterBridge,
    ROUTER_PROTOCOL_VERSION,
    buildRouterHeaders,
    type RouterGroupDelivery,
    type RouterInboundMessage,
} from './router-bridge';

test('handshake headers declare protocol version and group capability', () => {
    const headers = buildRouterHeaders({ appId: 'app-1', appType: 'openflux', appUserId: 'device-1', apiKey: 'k' });
    assert.equal(headers['X-App-ID'], 'app-1');
    assert.equal(headers['X-App-User-ID'], 'device-1');
    assert.equal(headers['Authorization'], 'Bearer k');
    assert.equal(headers['X-OpenFlux-Protocol-Version'], ROUTER_PROTOCOL_VERSION);
    assert.ok(headers['X-OpenFlux-Client-Version']);
    const capabilities = headers['X-OpenFlux-Capabilities'].split(',');
    assert.ok(capabilities.includes('group_context_v1'));
    assert.ok(capabilities.includes('private_text_v1'));
});

test('group deliveries reach onGroupDelivery and never the private inbound handler', () => {
    const bridge = new RouterBridge();
    const inbound: RouterInboundMessage[] = [];
    const groups: RouterGroupDelivery[] = [];
    bridge.onMessage = msg => { inbound.push(msg); };
    bridge.onGroupDelivery = delivery => { groups.push(delivery); };

    bridge.handleIncoming(JSON.stringify({
        action: 'project_context.append', delivery_id: 'dlv-1', external_event_id: 'msg-1',
        platform_type: 'dingtalk', channel_id: 'cidABC', text: 'hello', bot_mentioned: true,
    }));
    bridge.handleIncoming(JSON.stringify({
        direction: 'inbound', id: 'm-1', platform_type: 'dingtalk', platform_user_id: 'staff-1',
        content_type: 'text', content: 'private hi',
    }));
    bridge.handleIncoming('not json');

    assert.equal(groups.length, 1);
    assert.equal(groups[0].delivery_id, 'dlv-1');
    assert.equal(inbound.length, 1);
    assert.equal(inbound[0].content, 'private hi');
});

test('router hello is retained and reports compatibility', () => {
    const bridge = new RouterBridge();
    let seen: string | undefined;
    bridge.onHello = hello => { seen = hello.compatibility_state; };
    bridge.handleIncoming(JSON.stringify({
        action: 'router_hello', server_version: '1.0', protocol_version: '2',
        capabilities: ['group_context_v1'], compatibility_state: 'compatible',
    }));
    assert.equal(seen, 'compatible');
    assert.equal(bridge.getHello()?.protocol_version, '2');
});

test('control frames are not sent while disconnected', () => {
    const bridge = new RouterBridge();
    assert.equal(bridge.ackGroupDelivery('dlv-1'), false);
    assert.equal(bridge.ackGroupDelivery(''), false);
    assert.equal(bridge.registerRuntime({ projects: [{ id: 'p1', name: 'Demo' }] }), false);
});

test('control requests resolve on their matching result frame and reject on failure', async () => {
    const bridge = new RouterBridge();
    const sent: Record<string, unknown>[] = [];
    (bridge as unknown as { sendRaw: (payload: Record<string, unknown>) => boolean }).sendRaw = payload => {
        sent.push(payload);
        return true;
    };

    const ok = bridge.request<{ outcome: string }>('external_conversation.assign', { mapping_id: 'map-1' }, 1_000);
    const requestId = String(sent[0].request_id);
    assert.equal(sent[0].action, 'external_conversation.assign');
    bridge.handleIncoming(JSON.stringify({ action: 'other.result', request_id: 'unrelated', success: true }));
    bridge.handleIncoming(JSON.stringify({
        action: 'external_conversation.assign.result', request_id: requestId, success: true, data: { outcome: 'applied' },
    }));
    assert.equal((await ok).data?.outcome, 'applied');

    const failing = bridge.request('external_conversation.dismiss', { mapping_id: 'map-1' }, 1_000);
    const failingId = String(sent[1].request_id);
    bridge.handleIncoming(JSON.stringify({
        action: 'external_conversation.dismiss.result', request_id: failingId, success: false, message: '只有待分配的群可以忽略',
    }));
    await assert.rejects(failing, /只有待分配的群可以忽略/);

    const timingOut = bridge.request('external_conversation.assign', {}, 20);
    await assert.rejects(timingOut, /没有回应/);
});

test('publishGroupWork resolves on the matching receipt and reports transport failure otherwise', async () => {
    const bridge = new RouterBridge();
    const sent: Record<string, unknown>[] = [];
    (bridge as unknown as { sendRaw: (payload: Record<string, unknown>) => boolean }).sendRaw = payload => {
        sent.push(payload);
        return true;
    };
    const publish = bridge.publishGroupWork({
        trigger_event_id: 'msg-1', platform_id: 'p', workspace_id: 'w', channel_id: 'c', project_id: 'proj', public_reply: '结果',
    }, 1_000);
    assert.equal(sent[0].action, 'group_work.publish');
    bridge.handleIncoming(JSON.stringify({ action: 'group_work.result', trigger_event_id: 'other', success: true, status: 'sent' }));
    bridge.handleIncoming(JSON.stringify({ action: 'group_work.result', trigger_event_id: 'msg-1', success: true, status: 'sent', sent_count: 1 }));
    const receipt = await publish;
    assert.equal(receipt.status, 'sent');
    assert.equal(receipt.sent_count, 1);

    const timedOut = await bridge.publishGroupWork({
        trigger_event_id: 'msg-2', platform_id: 'p', workspace_id: 'w', channel_id: 'c', project_id: 'proj', public_reply: 'x',
    }, 20);
    assert.equal(timedOut.status, 'transport_failed');

    const disconnected = new RouterBridge();
    const failed = await disconnected.publishGroupWork({
        trigger_event_id: 'msg-3', platform_id: 'p', workspace_id: 'w', channel_id: 'c', project_id: 'proj', public_reply: 'x',
    }, 1_000);
    assert.equal(failed.success, false);
    assert.equal(failed.status, 'transport_failed');
});
