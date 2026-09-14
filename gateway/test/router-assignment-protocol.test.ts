import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { GatewayClient, type GatewayMessage } from '../../src/gateway-client';
import type { ExternalBinding } from '../src/gateway/external-binding-store';

const handlerNames = ['handleRouterAssignmentAssign', 'handleRouterAssignmentDismiss'] as const;
const source = readFileSync(new URL('../src/gateway/standalone.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('standalone.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const declarations = new Map<string, string>();
function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name && handlerNames.includes(node.name.text as typeof handlerNames[number])) {
        declarations.set(node.name.text, node.getText(ast));
    }
    ts.forEachChild(node, visit);
}
visit(ast);
for (const name of handlerNames) assert.ok(declarations.has(name), `Missing Gateway handler ${name}`);
const compiled = ts.transpileModule(
    `${[...declarations.values()].join('\n')}\n({${handlerNames.join(',')}});`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
).outputText;

function pendingBinding(state: ExternalBinding['state'] = 'pending'): ExternalBinding {
    return {
        mappingId: 'map-1', platformId: 'platform-1', platformType: 'feishu',
        workspaceId: 'workspace-1', channelId: 'channel-1', channelName: '研发群',
        state, revision: 1, createdAt: 1, updatedAt: 1,
    };
}

// Run the real nested handlers against an in-memory transport to the real
// renderer request resolver, without initializing Gateway native services.
function harness(options: {
    binding?: ExternalBinding;
    connected?: boolean;
    entity?: { id: string; name: string; kind: 'project' | 'agent' } | null;
    routerError?: string;
} = {}) {
    const binding = options.binding;
    const entity = options.entity === undefined ? { id: 'project-1', name: 'Demo', kind: 'project' } : options.entity;
    const requests: GatewayMessage[] = [];
    const replies: GatewayMessage[] = [];
    const routerCalls: Array<{ action: string; payload: Record<string, unknown> }> = [];
    const released: string[] = [];
    const client = new GatewayClient('ws://in-memory-assignment-test');
    const transport = client as unknown as {
        sendAsync(message: GatewayMessage): Promise<void>;
        handleMessage(raw: string): void;
    };
    const context = {
        send: (_client: unknown, reply: GatewayMessage) => {
            replies.push(reply);
            transport.handleMessage(JSON.stringify(reply));
        },
        externalBindingStore: {
            get: (id: string) => id === binding?.mappingId ? binding : undefined,
            beginAssign: (_id: string, input: Record<string, unknown>) => Object.assign(binding!, input, { state: 'assigning' }),
            completeAssign: (_id: string, revision: number) => Object.assign(binding!, { state: 'assigned', revision }),
            failAssign: (_id: string, lastError: string) => Object.assign(binding!, { state: 'pending', lastError }),
            dismiss: () => Object.assign(binding!, { state: 'dismissed' }),
        },
        getLocalEntity: (id: string) => id === entity?.id ? entity : undefined,
        routerBridge: {
            getStatus: () => ({ connected: options.connected !== false }),
            request: async (action: string, payload: Record<string, unknown>) => {
                routerCalls.push({ action, payload });
                if (options.routerError) throw new Error(options.routerError);
                return { success: true, data: { assignment: { revision: 2 }, outcome: 'applied' } };
            },
        },
        sessions: { get: () => undefined, create: () => ({ id: 'session-1' }) },
        groupSessionTitle: () => '研发群 · 飞书',
        crypto: { randomUUID }, Error,
        broadcastAssignmentsChanged: () => {},
        broadcastSessionUpdate: () => {},
        releaseGroupRequests: (assigned: ExternalBinding) => released.push(assigned.mappingId),
        log: { info: () => {}, warn: () => {} },
    };
    const handlers = runInNewContext(compiled, context) as Record<typeof handlerNames[number],
        (client: unknown, message: GatewayMessage) => Promise<void>>;
    transport.sendAsync = async message => {
        requests.push(message);
        const name = message.type === 'router.assignment.assign' ? 'handleRouterAssignmentAssign' : 'handleRouterAssignmentDismiss';
        await handlers[name]({}, message);
    };
    return { client, binding, requests, replies, routerCalls, released };
}

test('assignment validation failures reject the renderer request with the original reason and request ID', async () => {
    const cases = [
        { options: {}, payload: {}, reason: '缺少 mappingId 或 targetId' },
        { options: {}, payload: { mappingId: 'missing', targetId: 'project-1' }, reason: '待分配任务不存在' },
        { options: { binding: pendingBinding('dismissed') }, payload: { mappingId: 'map-1', targetId: 'project-1' }, reason: '这个群已被忽略' },
        { options: { binding: pendingBinding(), entity: null }, payload: { mappingId: 'map-1', targetId: 'project-1' }, reason: '目标 Project 或 Agent 不存在或已归档' },
        { options: { binding: pendingBinding() }, payload: { mappingId: 'map-1', targetId: 'project-1', targetKind: 'agent' }, reason: '目标类型与所选对象不一致' },
        { options: { binding: pendingBinding(), connected: false }, payload: { mappingId: 'map-1', targetId: 'project-1' }, reason: 'Router 未连接，暂时不能分配' },
    ];
    for (const item of cases) {
        const h = harness(item.options);
        await assert.rejects(h.client.request('router.assignment.assign', item.payload, 0), { message: item.reason });
        assert.equal(h.replies[0].type, 'router.assignment.assign.error');
        assert.equal(h.replies[0].id, h.requests[0].id);
        assert.equal(h.routerCalls.length, 0);
        assert.deepEqual(h.released, []);
    }
});

test('Router assignment rejection, timeout and disconnect reject instead of resolving as successful assignment', async () => {
    for (const reason of ['待分配记录已被更新，请刷新后重试', 'Router 在 15 秒内没有回应 external_conversation.assign', 'Router 已断开连接']) {
        const h = harness({ binding: pendingBinding(), routerError: reason });
        await assert.rejects(h.client.request('router.assignment.assign', { mappingId: 'map-1', targetId: 'project-1' }, 0), { message: `分配未完成：${reason}` });
        assert.equal(h.replies[0].type, 'router.assignment.assign.error');
        assert.equal(h.replies[0].id, h.requests[0].id);
        assert.equal(h.binding?.state, 'pending');
        assert.equal(h.binding?.sessionId, 'session-1');
        assert.equal(h.binding?.lastError, reason);
        assert.deepEqual(h.released, []);
    }
});

test('a confirmed assignment resolves with its dedicated session and releases the group requests', async () => {
    const h = harness({ binding: pendingBinding() });
    const result = await h.client.request<{ sessionId: string }>('router.assignment.assign', { mappingId: 'map-1', targetId: 'project-1' }, 0);
    assert.equal(result.sessionId, 'session-1');
    assert.equal(h.replies[0].type, 'router.assignment.assign');
    assert.equal(h.binding?.state, 'assigned');
    assert.equal(h.routerCalls[0].action, 'external_conversation.assign');
    assert.deepEqual(h.released, ['map-1']);
});

test('dismiss validation failures reject the renderer request and leave the assignment unchanged', async () => {
    const cases = [
        { options: {}, payload: {}, reason: '缺少 mappingId' },
        { options: {}, payload: { mappingId: 'missing' }, reason: '待分配任务不存在' },
        { options: { binding: pendingBinding('assigned') }, payload: { mappingId: 'map-1' }, reason: '已分配的群不能忽略' },
        { options: { binding: pendingBinding(), connected: false }, payload: { mappingId: 'map-1' }, reason: 'Router 未连接，暂时不能忽略' },
    ];
    for (const item of cases) {
        const h = harness(item.options);
        const before = h.binding?.state;
        await assert.rejects(h.client.request('router.assignment.dismiss', item.payload, 0), { message: item.reason });
        assert.equal(h.replies[0].type, 'router.assignment.dismiss.error');
        assert.equal(h.replies[0].id, h.requests[0].id);
        assert.equal(h.binding?.state, before);
        assert.equal(h.routerCalls.length, 0);
    }
});

test('a Router dismiss failure rejects and keeps the group pending for another attempt', async () => {
    const h = harness({ binding: pendingBinding(), routerError: 'Router 已断开连接' });
    await assert.rejects(h.client.request('router.assignment.dismiss', { mappingId: 'map-1' }, 0), { message: '忽略未完成：Router 已断开连接' });
    assert.equal(h.replies[0].type, 'router.assignment.dismiss.error');
    assert.equal(h.replies[0].id, h.requests[0].id);
    assert.equal(h.binding?.state, 'pending');
});

test('an intentional successful dismiss resolves, and an already dismissed group remains a successful no-op', async () => {
    for (const state of ['pending', 'dismissed'] as const) {
        const h = harness({ binding: pendingBinding(state) });
        const result = await h.client.request<{ binding: ExternalBinding }>('router.assignment.dismiss', { mappingId: 'map-1' }, 0);
        assert.equal(result.binding.state, 'dismissed');
        assert.equal(h.replies[0].type, 'router.assignment.dismiss');
        assert.equal(h.routerCalls.length, state === 'pending' ? 1 : 0);
        assert.deepEqual(h.released, []);
    }
});
