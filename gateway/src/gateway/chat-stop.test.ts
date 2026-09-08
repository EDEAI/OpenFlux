import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Exercise the production handler without starting the standalone server.
const source = ts.createSourceFile('standalone.ts', readFileSync(
    new URL('./standalone.ts', import.meta.url), 'utf8',
), ts.ScriptTarget.Latest, true);
let handlerSource = '';
function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'handleChatStop') {
        handlerSource = node.getText(source);
    }
    ts.forEachChild(node, visit);
}
visit(source);
assert.ok(handlerSource, 'production chat.stop handler must exist');
const handlerJs = ts.transpileModule(handlerSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness(group = true, abortAccepted = true, external = false) {
    const active = { key: 'session', sessionId: 'session', runId: 'run', turnId: 'turn', submissionId: 'submission' };
    const writes: unknown[] = [];
    const reports: unknown[] = [];
    const aborts: unknown[] = [];
    const acks: Array<{ payload: { matched: boolean; queuePaused: boolean } }> = [];
    const pausedQueues: string[] = [];
    const handler = runInNewContext(`${handlerJs}; handleChatStop`, {
        executionRegistry: {
            snapshots: () => [{ active }],
            get: () => active,
            abortIfCurrent: (...args: unknown[]) => { aborts.push(args); return abortAccepted; },
        },
        activeGroupWorkOrderTargets: new Map(group ? [['work', active]] : []),
        externalRunIds: new Set(external ? ['run'] : []),
        projectContextStore: {
            getGroupWorkOrderReceipt: () => ({ status: 'running', session_id: 'session' }),
            updateGroupWorkOrderReceipt: (...args: unknown[]) => writes.push(args),
        },
        reportGroupWorkOrderStatus: (input: unknown) => { reports.push(input); return Promise.resolve(true); },
        turnQueueStore: { pause: (id: string) => pausedQueues.push(id) },
        broadcastQueueState: () => {},
        log: { info: () => {} },
        send: (_client: unknown, ack: typeof acks[number]) => acks.push(ack),
    }) as (client: object, message: object) => void;
    return { writes, reports, aborts, acks, pausedQueues, stop: (payload: object) => handler({}, { id: 'stop', payload }) };
}

test('identity-free and stale stops cannot pause a group work order', () => {
    for (const payload of [{ sessionId: 'session' }, { sessionId: 'session', runId: 'old-run' }]) {
        const h = harness();
        h.stop(payload);
        assert.equal(h.writes.length, 0);
        assert.equal(h.reports.length, 0);
        assert.equal(h.aborts.length, 0);
        assert.equal(h.acks[0].payload.matched, false);
    }
});

test('an execution that no longer accepts cancellation cannot publish a task pause', () => {
    const h = harness(true, false);
    h.stop({ sessionId: 'session', runId: 'run', turnId: 'turn' });
    assert.equal(h.aborts.length, 1);
    assert.equal(h.writes.length, 0);
    assert.equal(h.reports.length, 0);
    assert.equal(h.acks[0].payload.matched, false);
});

test('an exact group stop records its pause but leaves the conversation available', () => {
    const h = harness();
    h.stop({ sessionId: 'session', runId: 'run', turnId: 'turn' });
    assert.equal(h.writes.length, 1);
    assert.equal(h.reports.length, 1);
    assert.equal(h.pausedQueues.length, 0);
    assert.equal(h.acks[0].payload.matched, true);
    assert.equal(h.acks[0].payload.queuePaused, false);
});

test('an exact local-chat stop keeps the existing follow-up queue pause behavior', () => {
    const h = harness(false);
    h.stop({ sessionId: 'session', runId: 'run', turnId: 'turn' });
    assert.equal(h.writes.length, 0);
    assert.equal(h.reports.length, 0);
    assert.deepEqual(h.pausedQueues, ['session']);
    assert.equal(h.acks[0].payload.queuePaused, true);
});

test('stopping an external private or group answer does not pause the next input', () => {
    const h = harness(false, true, true);
    h.stop({ sessionId: 'session', runId: 'run', turnId: 'turn' });
    assert.equal(h.acks[0].payload.matched, true);
    assert.equal(h.acks[0].payload.queuePaused, false);
    assert.deepEqual(h.pausedQueues, []);
});
