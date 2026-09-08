import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { ExecutionRegistry, ExecutionAbortedError } from './execution-registry';
import { TurnTracker } from '../runtime/turn-tracker';
import { runWithAgentExecutionContext } from '../runtime/execution-context';
import { prepareTurnInput } from './turn-preparation';

// Run the production external adapter with the native tracker and scheduler,
// without starting a server or sending any real platform/model requests.
const source = ts.createSourceFile('standalone.ts', readFileSync(new URL('./standalone.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
let fn = '';
function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'runGroupAgentTurn') fn = node.getText(source);
    ts.forEachChild(node, visit);
}
visit(source);
assert.ok(fn);
const code = ts.transpileModule(fn, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function harness(executeAgent: (...args: any[]) => Promise<string>) {
    const events: any[] = [];
    const durable: any[] = [];
    const run = runInNewContext(`${code}; runGroupAgentTurn`, {
        executionRegistry: new ExecutionRegistry(), externalRunIds: new Set(),
        ExecutionAbortedError, TurnTracker, runWithAgentExecutionContext, prepareTurnInput,
        normalizeApprovalMode: () => 'full', DEFAULT_APPROVAL_MODE: 'full',
        sessions: { get: () => ({}), addEvent: (_session: string, e: any) => durable.push(e) },
        broadcastToClients: (e: any) => events.push(e), broadcastQueueState: () => {}, broadcastSessionUpdate: () => {},
        executeAgent, Error, AbortController,
    }) as (input: any) => Promise<string>;
    return { run, events, durable };
}

test('external preparation immediately starts the native activity; stop settles before preparation responds', async () => {
    const h = harness(async () => 'unexpected');
    let target: any;
    let finish!: (value: any) => void;
    const pending = h.run({ sessionId: 'router', turnId: 'image-a', prompt: '', visibleInput: 'image', metadata: {},
        visibleAssistantOutput: (s: string) => s,
        prepare: () => new Promise(resolve => { finish = resolve; }),
        onExecutionQueued: (t: any) => { target = t; },
    }).catch(error => error);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.durable[0].type, 'turn.started');
    assert.ok(h.events.some(e => e.type === 'chat.start' && e.payload.externalSource === 'router'));
    target.cancel(new Error('Stopped by user'));
    assert.ok(h.durable.some(e => e.type === 'turn.interrupted'));
    await pending;
    finish({ prompt: 'late', visibleInput: 'late' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.durable.filter(e => e.type === 'turn.interrupted').length, 1);
    assert.equal(h.events.filter(e => e.type === 'chat.complete').length, 0);
});

test('an uncooperative stopped model cannot keep spinning or overwrite the next external answer', async () => {
    let finish!: (value: string) => void;
    const h = harness(async prompt => prompt === 'old' ? new Promise(resolve => { finish = resolve; }) : 'hello');
    let target: any;
    const base = { sessionId: 'group', visibleInput: '', metadata: {}, visibleAssistantOutput: (s: string) => s };
    const old = h.run({ ...base, prompt: 'old', turnId: 'a', onExecutionQueued: (t: any) => { target = t; } }).catch(error => error);
    await new Promise(resolve => setImmediate(resolve));
    target.cancel(new Error('Stopped by user'));
    await old;
    assert.equal(await h.run({ ...base, prompt: 'new', turnId: 'b' }), 'hello');
    finish('42');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.events.filter(e => e.type === 'chat.complete').map(e => e.payload.turnId), ['b']);
    assert.equal(h.durable.filter(e => e.turnId === 'a' && e.type === 'turn.interrupted').length, 1);
});
