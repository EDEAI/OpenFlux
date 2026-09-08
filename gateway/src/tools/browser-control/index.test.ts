import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserControlTool, type BrowserViewRequest } from './index';
import { createBrowserTool } from '../browser';
import { PermissionChecker, RiskLevel } from '../../permissions/checker';
import { ToolRegistry } from '../registry';

test('embedded page inspection is read-only while input retains interactive approval', async () => {
    const checker = new PermissionChecker();
    for (const action of ['list_tabs', 'snapshot', 'end']) {
        assert.equal(checker.assess('browser_control', { action }).level, RiskLevel.None);
    }
    for (const action of ['navigate', 'click', 'type', 'press_key', 'drag', 'evaluate']) {
        assert.equal(checker.assess('browser_control', { action }).level, RiskLevel.Medium);
        assert.equal(await checker.requiresConfirmation('browser_control', { action }), true);
    }
});

test('embedded browser descriptions keep interactive and scheduled conversation browsing in the panel', () => {
    const embedded = createBrowserControlTool({ request: async () => ({ ok: true }) });
    const separate = createBrowserTool();
    const registry = new ToolRegistry();
    registry.register(separate);
    registry.register(embedded);

    const browserDefinitions = registry.toLLMToolDefinitions()
        .filter(tool => tool.name === 'browser_control' || tool.name === 'browser');
    assert.deepEqual(browserDefinitions.map(tool => tool.name), ['browser_control', 'browser']);
    assert.match(embedded.description, /DEFAULT INTERACTIVE BROWSER/);
    assert.match(embedded.description, /both interactive and scheduled runs/);
    assert.match(embedded.description, /does not open an external browser/);
    assert.match(separate.description, /SEPARATE\/BACKGROUND/);
    assert.match(separate.description, /does not provide browser_control/);
});

test('every embedded-browser bridge request carries the owning conversation session', async () => {
    const sessions: Array<string | undefined> = [];
    const request: BrowserViewRequest = async (op, _payload, _timeoutMs, sessionId) => {
        sessions.push(sessionId);
        if (op === 'list') return { tabs: [
            { label: 'bound-tab', url: 'https://example.test/', title: 'Bound', active: true },
        ] };
        if (op === 'cdp') return { result: { result: { value: JSON.stringify({
            url: 'https://example.test/', title: 'Bound', text: 'Session scoped', elements: [],
        }) } } };
        return { ok: true };
    };
    const tool = createBrowserControlTool({ request });
    const result = await tool.execute(
        { action: 'snapshot', tab: 'bound-tab' },
        { sessionId: 'conversation-a', turnId: 'turn-a' },
    );
    assert.equal(result.success, true);
    assert.ok(sessions.length >= 3);
    assert.ok(sessions.every(sessionId => sessionId === 'conversation-a'));
});

test('navigate prepares an existing hidden panel tab before using its native view', async () => {
    const calls: Array<{ op: string; payload?: Record<string, unknown> }> = [];
    let prepared = false;
    const request: BrowserViewRequest = async (op, payload) => {
        calls.push({ op, payload });
        if (op === 'list') return { tabs: [
            { label: 'hidden-tab', url: 'about:blank', title: '', active: false },
        ] };
        if (op === 'prepare') {
            prepared = true;
            return { ok: true };
        }
        if (op === 'cdp') {
            assert.equal(prepared, true, 'native browser calls must wait until the panel tab is prepared');
            if (payload?.method === 'Runtime.evaluate') return { result: { result: { value: JSON.stringify({
                url: 'https://status.openai.com/', title: 'OpenAI Status', text: 'All Systems Operational', elements: [],
            }) } } };
            return { result: {} };
        }
        return { ok: true };
    };
    const tool = createBrowserControlTool({ request });

    const result = await tool.execute(
        { action: 'navigate', tab: 'hidden-tab', url: 'https://status.openai.com' },
        { sessionId: 'conversation-a', turnId: 'turn-a' },
    );

    assert.equal(result.success, true);
    assert.match(String(result.data), /All Systems Operational/);
    assert.deepEqual(calls.slice(0, 4).map(call => call.op), ['list', 'prepare', 'takeover', 'cdp']);
    assert.deepEqual(calls[1].payload, { label: 'hidden-tab' });
});

test('an empty tab list directs the agent to auto-open with navigate', async () => {
    const tool = createBrowserControlTool({
        request: async op => op === 'list' ? { tabs: [] } : { ok: true },
    });

    const result = await tool.execute(
        { action: 'list_tabs' },
        { sessionId: 'conversation-a', turnId: 'turn-a' },
    );

    assert.equal(result.success, true);
    assert.match(String(result.data), /Call navigate.*automatically/);
    assert.doesNotMatch(String(result.data), /Ask the user/);
});

function harness(evaluation?: unknown) {
    const calls: { op: string; payload?: Record<string, unknown> }[] = [];
    const request: BrowserViewRequest = async (op, payload) => {
        calls.push({ op, payload });
        if (op === 'list') return { tabs: [
            { label: 'user-tab', url: 'https://shop.test/', title: 'My shop', active: true },
            { label: 'other-tab', url: 'https://other.test/', title: 'Other', active: false },
        ] };
        if (op === 'cdp') return { result: evaluation ?? { result: { value: JSON.stringify({
            url: 'https://shop.test/', title: 'My shop', text: 'Current recommendations: ¥128',
            elements: [{ ref: 0, tag: 'button', name: 'Details', type: '', x: 40, y: 60 }],
        }) } } };
        return { ok: true };
    };
    return { tool: createBrowserControlTool({ request }), calls };
}

test('inspecting the selected embedded page preserves its tab, URL and page text', async () => {
    const { tool, calls } = harness();
    const result = await tool.execute({ action: 'snapshot', tab: 'user-tab' });
    assert.equal(result.success, true);
    assert.match(String(result.data), /Current recommendations: ¥128/);
    assert.match(String(result.data), /\[0\] <button> Details/);
    assert.ok(calls.every(c => c.op !== 'open' && c.payload?.method !== 'Page.navigate'));
    assert.equal(calls.find(c => c.op === 'cdp')?.payload?.label, 'user-tab');
});

test('click uses the snapshot coordinates in the same embedded tab', async () => {
    const { tool, calls } = harness();
    await tool.execute({ action: 'snapshot', tab: 'other-tab' });
    const result = await tool.execute({ action: 'click', tab: 'other-tab', ref: 0 });
    assert.equal(result.success, true);
    assert.deepEqual(calls.find(c => c.op === 'act')?.payload,
        { label: 'other-tab', kind: 'click', x: 40, y: 60 });
});

test('page evaluation exceptions remain failures rather than empty successful snapshots', async () => {
    const { tool } = harness({ exceptionDetails: { text: 'Uncaught', exception: { description: 'Page script failed' } } });
    const result = await tool.execute({ action: 'snapshot' });
    assert.equal(result.success, false);
    assert.match(result.error!, /Page script failed/);
});

test('missing native evaluation results are rejected', async () => {
    const { tool } = harness({ result: { type: 'undefined' } });
    const result = await tool.execute({ action: 'snapshot' });
    assert.equal(result.success, false);
    assert.match(result.error!, /did not return a snapshot/);
});

test('native bridge errors propagate without opening an isolated browser', async () => {
    const { tool, calls } = harness({ result: { value: '{invalid' } });
    const result = await tool.execute({ action: 'snapshot' });
    assert.equal(result.success, false);
    assert.ok(calls.every(c => c.op !== 'open'));
});

test('an unavailable requested tab does not fall back to the active tab', async () => {
    const { tool, calls } = harness();
    const result = await tool.execute({ action: 'snapshot', tab: 'removed' });
    assert.equal(result.success, false);
    assert.match(result.error!, /tab not found: removed/);
    assert.deepEqual(calls.map(c => c.op), ['list']);
});

test('Mac Command shortcuts retain the native modifier mask', async () => {
    const { tool, calls } = harness();
    const result = await tool.execute({ action: 'press_key', tab: 'user-tab', key: 'a', modifiers: ['Command', 'Shift'] });
    assert.equal(result.success, true);
    assert.deepEqual(calls.find(c => c.op === 'act')?.payload,
        { label: 'user-tab', kind: 'key', key: 'a', modifiers: 12 });
});
