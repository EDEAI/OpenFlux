import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { normalizeManagedModelInfo } from '../../src/managed-model-config';

function source(path: string) {
    return ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
}
function find(root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node {
    let result: ts.Node | undefined;
    function visit(node: ts.Node) {
        if (!result && predicate(node)) result = node;
        if (!result) ts.forEachChild(node, visit);
    }
    visit(root);
    assert.ok(result);
    return result;
}
function js(code: string) {
    return ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

test('both Router push formats and initial snapshots expose the same model metadata', async () => {
    const src = source('../../src/gateway-client.ts');
    const methods = ['getLlmSource', 'onManagedLlmConfig'].map(name => find(src,
        node => ts.isMethodDeclaration(node) && node.name.getText(src) === name).getText(src));
    const Client = runInNewContext(js(`class Client { ${methods.join('\n')} }; Client`), { normalizeManagedModelInfo });
    const client = new Client();
    const runtime = { available: true, profiles: { orchestration: { provider: 'moonshot', model: 'kimi' } },
        currentSource: 'managed', apiKey: 'must-not-reach-ui' };
    client.request = async () => ({ source: 'managed', managed: runtime });
    const initial = await client.getLlmSource();
    assert.equal(initial.managed.provider, 'moonshot');
    assert.equal(initial.managed.model, 'kimi');
    assert.equal(initial.managed.apiKey, undefined);
    let listener: (msg: unknown) => void;
    client.addMessageHandler = (handler: typeof listener) => { listener = handler; };
    client.removeMessageHandler = (handler: typeof listener) => assert.equal(handler, listener);
    const events: any[] = [];
    const off = client.onManagedLlmConfig((info: unknown) => events.push(info));
    listener!({ type: 'managed-runtime-config', payload: runtime });
    listener!({ type: 'managed-llm-config', payload: { available: true, provider: 'openai', model: 'legacy' } });
    listener!({ type: 'unrelated', payload: {} });
    assert.equal(events.length, 2);
    assert.equal(events[0].model, 'kimi');
    assert.equal(events[0].apiKey, undefined);
    assert.equal(events[1].model, 'legacy');
    off();
});

test('selecting team mode before config arrives persists managed; late responses cannot relabel local mode', async () => {
    const src = source('../../src/main.ts');
    const fn = find(src, node => ts.isFunctionDeclaration(node) && node.name?.text === 'applyWorkingMode');
    const block = find(fn, node => ts.isIfStatement(node) && node.expression.getText(src).includes("typeof gatewayClient"));
    const calls: string[] = [];
    let resolve!: () => void;
    const state = { mode: 'router', previousMode: 'standalone', currentWorkingMode: 'router',
        currentLlmSource: 'local', managedLlmAvailable: false,
        gatewayClient: { setLlmSource: (value: string) => { calls.push(value); return new Promise<void>(r => { resolve = r; }); } } };
    runInNewContext(js(block.getText(src)), state);
    assert.deepEqual(calls, ['managed']);
    state.currentWorkingMode = 'standalone';
    resolve();
    await new Promise(r => setImmediate(r));
    assert.equal(state.currentLlmSource, 'local');
});

test('team startup reconciles persisted mode when the configuration push was missed', async () => {
    const src = source('../../src/main.ts');
    const listener = find(src, node => ts.isFunctionDeclaration(node) && node.name?.text === 'initRouterListeners');
    const callback = find(listener, node => ts.isArrowFunction(node) && node.parameters[0]?.name.getText(src) === 'result'
        && node.getText(src).includes('result.managed'));
    const calls: string[] = [];
    const state = { currentWorkingMode: 'router', currentLlmSource: 'local', managedLlmAvailable: false,
        managedLlmProvider: '', managedLlmModel: '', managedLlmQuota: null,
        gatewayClient: { setLlmSource: async (value: string) => { calls.push(value); return { source: value }; } },
        updateManagedLlmUI: () => {}, promptAtlasLoginIfManaged: () => {} };
    const run = runInNewContext(js(`const run = ${callback.getText(src)}; run;`), state);
    await run({ source: 'local', managed: { available: true, provider: 'moonshot', model: 'kimi' } });
    assert.deepEqual(calls, ['managed']);
    assert.equal(state.currentLlmSource, 'managed');
    assert.equal(state.managedLlmModel, 'kimi');
});

test('team requests cannot use stale local models before Router configuration arrives', () => {
    const src = source('../src/gateway/standalone.ts');
    const fn = find(src, node => ts.isFunctionDeclaration(node) && node.name?.text === 'executeAgent') as ts.FunctionDeclaration;
    const guard = fn.body!.statements[0].getText(src);
    assert.ok(guard.includes("llmSource === 'managed'"));
    assert.throws(() => runInNewContext(js(guard), {
        llmSource: 'managed', managedRuntimeConfig: null, managedLlmConfig: null,
    }), /Router/);
    for (const [llmSource, managedRuntimeConfig, managedLlmConfig] of [
        ['local', null, null], ['atlas_managed', null, null],
        ['managed', {}, null], ['managed', null, {}],
    ]) {
        assert.doesNotThrow(() => runInNewContext(js(guard), { llmSource, managedRuntimeConfig, managedLlmConfig }));
    }
});

test('changing Router endpoint or device clears previous managed keys, saving unchanged config does not', () => {
    const src = source('../src/gateway/standalone.ts');
    const fn = find(src, node => ts.isFunctionDeclaration(node) && node.name?.text === 'handleRouterConfigUpdate');
    const guard = find(fn, node => ts.isIfStatement(node) && node.expression.getText(src).includes('newConfig.url !=='));
    const original = { url: 'wss://router.test/ws/app', appId: 'app-a', apiKey: 'credential-a', appUserId: 'device-a' };
    for (const key of ['url', 'appId', 'apiKey', 'appUserId', 'unchanged']) {
        const events: any[] = [];
        const state = { currentConfig: original, newConfig: key === 'unchanged' ? original : { ...original, [key]: 'changed' },
            managedRuntimeConfig: {} as object | null, managedLlmConfig: {} as object | null,
            llmSource: 'managed', broadcastToClients: (event: any) => events.push(event) };
        runInNewContext(js(guard.getText(src)), state);
        assert.equal(state.managedRuntimeConfig === null, key !== 'unchanged');
        assert.equal(state.managedLlmConfig === null, key !== 'unchanged');
        assert.equal(events.length, key === 'unchanged' ? 0 : 1);
    }
});
