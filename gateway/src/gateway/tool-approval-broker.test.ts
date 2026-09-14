import test from 'node:test';
import assert from 'node:assert/strict';
import {
    bindToolApprovalToVisibleTurn,
    ToolApprovalBroker,
    type ToolApprovalClientIdentity,
} from './tool-approval-broker';
import type { ToolApprovalDecision, ToolApprovalRequest } from '../tools/types';

const request: ToolApprovalRequest = {
    requestId: 'approval-1',
    toolName: 'process',
    args: { action: 'run' },
    riskLevel: 2,
    riskLabel: 'medium',
    reason: 'Executing a local process',
};

function desktop(id: string, instanceId?: string): ToolApprovalClientIdentity {
    return { id, instanceId, role: 'desktop', authenticated: true, open: true };
}

test('binds a hidden child approval to its visible parent turn without mutating the request', () => {
    const childRequest: ToolApprovalRequest = {
        ...request,
        sessionId: 'collab-child',
        turnId: 'child-turn',
    };

    const visible = bindToolApprovalToVisibleTurn(childRequest, {
        sessionId: 'user-agent:designer',
        turnId: 'parent-turn',
    });

    assert.equal(visible.sessionId, 'user-agent:designer');
    assert.equal(visible.turnId, 'parent-turn');
    assert.equal(childRequest.sessionId, 'collab-child');
    assert.equal(childRequest.turnId, 'child-turn');
});

test('replays a pending approval to the same desktop instance after reconnect', () => {
    const broker = new ToolApprovalBroker();
    const decisions: ToolApprovalDecision[] = [];
    const sent: string[] = [];
    const oldClient = desktop('socket-old', 'desktop-a');

    broker.disconnect(oldClient.id);
    broker.add(oldClient, request, decision => decisions.push(decision));
    assert.equal(broker.deliver(request.requestId, [], () => true), 0);

    const newClient = desktop('socket-new', 'desktop-a');
    assert.equal(broker.replayTo(newClient, client => {
        sent.push(client.id);
        return true;
    }), 1);
    assert.deepEqual(sent, ['socket-new']);
    assert.equal(broker.resolve(newClient, request.requestId, 'approved'), true);
    assert.deepEqual(decisions, ['approved']);
});

test('rejects approval responses from another desktop instance', () => {
    const broker = new ToolApprovalBroker();
    const decisions: ToolApprovalDecision[] = [];
    broker.add(desktop('owner', 'desktop-a'), request, decision => decisions.push(decision));

    assert.equal(broker.resolve(desktop('other', 'desktop-b'), request.requestId, 'approved'), false);
    assert.deepEqual(decisions, []);
});

test('denies legacy approvals when their only owning socket disconnects', () => {
    const broker = new ToolApprovalBroker();
    const decisions: ToolApprovalDecision[] = [];
    const legacy = desktop('legacy');
    broker.add(legacy, request, decision => decisions.push(decision));

    broker.disconnect(legacy.id);
    assert.deepEqual(decisions, ['denied']);
});

test('does not route approvals to unauthenticated or non-desktop clients', () => {
    const broker = new ToolApprovalBroker();
    broker.add(desktop('owner', 'desktop-a'), request, () => undefined);
    const ineligible: ToolApprovalClientIdentity[] = [
        { ...desktop('unauthenticated', 'desktop-a'), authenticated: false },
        { ...desktop('closed', 'desktop-a'), open: false },
        { ...desktop('canvas', 'desktop-a'), role: 'canvas' },
    ];

    assert.equal(broker.deliver(request.requestId, ineligible, () => true), 0);
});

test('any desktop may answer an approval owned by a headless external turn', () => {
    const broker = new ToolApprovalBroker();
    const decisions: ToolApprovalDecision[] = [];
    const external: ToolApprovalClientIdentity = { id: 'external:map-1:dlv-1', role: 'external', authenticated: true, open: true };
    broker.add(external, request, decision => decisions.push(decision));

    const delivered = broker.deliver(request.requestId, [desktop('socket-a', 'desktop-a'), desktop('socket-b', 'desktop-b')], () => true);
    assert.equal(delivered, 2);
    assert.equal(broker.resolve(desktop('socket-b', 'desktop-b'), request.requestId, 'approved'), true);
    assert.deepEqual(decisions, ['approved']);

    // A non-desktop client still cannot answer.
    broker.add(external, { ...request, requestId: 'approval-2' }, decision => decisions.push(decision));
    const canvas: ToolApprovalClientIdentity = { id: 'canvas-1', role: 'canvas', authenticated: true, open: true };
    assert.equal(broker.resolve(canvas, 'approval-2', 'approved'), false);
});
