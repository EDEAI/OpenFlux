import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserControlTool, type BrowserViewRequest } from './index';
import { createBrowserTool } from '../browser';
import { PermissionChecker, RiskLevel } from '../../permissions/checker';
import { ToolRegistry } from '../registry';

test('embedded page inspection is read-only while input retains interactive approval', async () => {
    const checker = new PermissionChecker();
    for (const action of ['list_tabs', 'snapshot', 'get_html', 'end']) {
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

test('get_html serializes the live DOM in-page and pages large documents', async () => {
    const { tool, calls } = harness({ result: { value: JSON.stringify({
        url: 'https://shop.test/', matched: 1, total: 120000, chunk: '<!DOCTYPE html>\n<html><body><a href="/x">x</a></body></html>',
    }) } });
    const result = await tool.execute({ action: 'get_html', tab: 'user-tab', maxChars: 40000 });
    assert.equal(result.success, true);
    assert.match(String(result.data), /HTML of document \(chars 0-\d+ of 120000, scripts\/styles stripped\)/);
    assert.match(String(result.data), /<a href="\/x">x<\/a>/);
    assert.match(String(result.data), /offset=\d+ for the next part/);
    const cdpCall = calls.find(c => c.op === 'cdp' && c.payload?.method === 'Runtime.evaluate');
    assert.equal(cdpCall?.payload?.label, 'user-tab');
    const expr = String((cdpCall?.payload?.params as { expression?: string })?.expression);
    assert.match(expr, /shadowrootmode="open"/);
    assert.match(expr, /slice\(0,40000\)/);
    assert.ok(calls.every(c => c.op !== 'open' && c.op !== 'act'));
});

test('get_html scopes to a selector and reports when nothing matches', async () => {
    const scoped = harness({ result: { value: JSON.stringify({
        url: 'https://shop.test/', matched: 2, total: 22, chunk: '<li>a</li>\n\n<li>b</li>',
    }) } });
    const ok = await scoped.tool.execute({ action: 'get_html', tab: 'user-tab', selector: 'ul.items > li', raw: true });
    assert.equal(ok.success, true);
    assert.match(String(ok.data), /2 element\(s\) matching "ul\.items > li" \(chars 0-22 of 22, raw\)/);
    assert.doesNotMatch(String(ok.data), /truncated/);
    const expr = String((scoped.calls.find(c => c.op === 'cdp' && c.payload?.method === 'Runtime.evaluate')?.payload?.params as { expression?: string })?.expression);
    assert.match(expr, /const raw=true/);
    assert.match(expr, /const sel="ul\.items > li"/);

    const empty = harness({ result: { value: JSON.stringify({ url: 'https://shop.test/', matched: 0, total: 0, chunk: '' }) } });
    const miss = await empty.tool.execute({ action: 'get_html', tab: 'user-tab', selector: '#nope' });
    assert.equal(miss.success, false);
    assert.match(String(miss.error), /No element matches selector "#nope"/);
});

test('click uses the snapshot coordinates in the same embedded tab', async () => {
    const { tool, calls } = harness();
    await tool.execute({ action: 'snapshot', tab: 'other-tab' });
    const result = await tool.execute({ action: 'click', tab: 'other-tab', ref: 0 });
    assert.equal(result.success, true);
    assert.deepEqual(calls.find(c => c.op === 'act')?.payload,
        { label: 'other-tab', kind: 'click', x: 40, y: 60 });
});

test('snapshot elements carry their box so the panel can land inside it, and the used point is reported', async () => {
    const calls: Array<{ op: string; payload?: Record<string, unknown>; timeoutMs?: number }> = [];
    const request: BrowserViewRequest = async (op, payload, timeoutMs) => {
        calls.push({ op, payload, timeoutMs });
        if (op === 'list') return { tabs: [{ label: 'user-tab', url: 'https://shop.test/', title: 'My shop', active: true }] };
        if (op === 'cdp') return { result: { result: { value: JSON.stringify({
            url: 'https://shop.test/', title: 'My shop', text: 'x',
            elements: [
                { ref: 0, tag: 'button', name: 'Buy', type: '', x: 200, y: 300, w: 120, h: 40 },
                { ref: 1, tag: 'li', name: 'Item', type: '', x: 50, y: 80, w: 300, h: 24, draggable: true },
                { ref: 2, tag: 'ul', name: 'Done', type: '', x: 50, y: 400, w: 300, h: 200 },
            ],
        }) } } };
        // The panel picks a natural spot inside the box and reports it back.
        if (op === 'act' && payload?.kind === 'click') return { ok: true, x: 213, y: 291 };
        if (op === 'act' && payload?.kind === 'drag') return { ok: true, x: 61, y: 84, x2: 120, y2: 430 };
        return { ok: true };
    };
    const tool = createBrowserControlTool({ request });
    await tool.execute({ action: 'snapshot' });

    const click = await tool.execute({ action: 'click', ref: 0 });
    assert.equal(click.success, true);
    assert.deepEqual(calls.find(c => c.op === 'act')?.payload, { label: 'user-tab', kind: 'click', x: 200, y: 300, w: 120, h: 40 });
    assert.match(String(click.data), /click at \(213, 291\)/);

    const drag = await tool.execute({ action: 'drag', ref: 1, toRef: 2 });
    assert.equal(drag.success, true);
    assert.deepEqual(calls.find(c => c.payload?.kind === 'drag')?.payload,
        { label: 'user-tab', kind: 'drag', x: 50, y: 80, w: 300, h: 24, x2: 50, y2: 400, w2: 300, h2: 200 });
    assert.match(String(drag.data), /Dragged \(61, 84\) → \(120, 430\)/);

    // Explicit coordinates are used as given, with no box.
    const exact = await tool.execute({ action: 'click', x: 10, y: 20 });
    assert.equal(exact.success, true);
    assert.deepEqual(calls.filter(c => c.payload?.kind === 'click').at(-1)?.payload, { label: 'user-tab', kind: 'click', x: 10, y: 20 });
});

test('type is sent as one paced act with a bridge timeout that grows with the text', async () => {
    const calls: Array<{ op: string; payload?: Record<string, unknown>; timeoutMs?: number }> = [];
    const text = 'hello world, this is typed one key at a time';
    const request: BrowserViewRequest = async (op, payload, timeoutMs) => {
        calls.push({ op, payload, timeoutMs });
        if (op === 'list') return { tabs: [{ label: 'user-tab', url: 'https://shop.test/', title: 'My shop', active: true }] };
        if (op === 'cdp' && String((payload?.params as { expression?: string })?.expression).includes('D.activeElement()')) {
            return { result: { result: { value: JSON.stringify({ tag: 'input[text]', value: text, readOnly: false }) } } };
        }
        if (op === 'cdp') return { result: { result: { value: JSON.stringify({
            url: 'https://shop.test/', title: 'My shop', text: 'x',
            elements: [{ ref: 0, tag: 'input', name: '(input)', type: 'text', x: 100, y: 40, w: 240, h: 32 }],
        }) } } };
        return { ok: true };
    };
    const tool = createBrowserControlTool({ request });
    const result = await tool.execute({ action: 'type', ref: 0, text });
    assert.equal(result.success, true);
    const acts = calls.filter(c => c.op === 'act');
    assert.deepEqual(acts.map(a => a.payload?.kind), ['click', 'type']);
    assert.deepEqual(acts[0].payload, { label: 'user-tab', kind: 'click', x: 100, y: 40, w: 240, h: 32 });
    assert.equal(acts[1].payload?.text, text);
    assert.ok((acts[1].timeoutMs ?? 0) >= 30000 + text.length * 400, `timeout ${acts[1].timeoutMs}`);
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
