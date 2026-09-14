import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserControlTool, type BrowserViewRequest } from '../src/tools/browser-control/index';

/**
 * A desktop bridge stub. The page has three child frames:
 *  - F0: same-origin (script can read it; left to the deep-DOM helpers)
 *  - F1: cross-site, in its own process → addressed by session S1
 *  - F2: cross-origin but same process → addressed by main-world context 21
 * The frame's own snapshot/HTML/recorder come back when a request carries
 * that session or context id.
 */
function bridge(options: { reportAfterCalls?: number } = {}) {
    const calls: Array<{ op: string; payload?: Record<string, unknown> }> = [];
    let framesCalls = 0;
    const mainSnapshot = {
        url: 'https://shop.test/', title: 'Shop', text: 'Shop text',
        elements: [
            { ref: 0, tag: 'button', type: '', name: 'Main', x: 50, y: 20, w: 80, h: 20 },
            { ref: 1, tag: 'iframe', type: 'cross-origin', name: 'https://pay.example/widget', x: 400, y: 300, w: 300, h: 200 },
            { ref: 2, tag: 'iframe', type: 'cross-origin', name: 'https://promo.shop.test/w', x: 100, y: 600, w: 200, h: 100 },
        ],
    };
    const paySnapshot = {
        url: 'https://pay.example/widget', title: 'Pay', text: 'Card number',
        elements: [
            { ref: 0, tag: 'input', type: 'text', name: 'Card', x: 100, y: 40, w: 180, h: 24 },
            { ref: 1, tag: 'button', type: '', name: 'Pay', x: 100, y: 90, w: 60, h: 24 },
            { ref: 2, tag: 'a', type: '', name: 'Far away', x: 900, y: 40, w: 60, h: 24 }, // outside the frame box: dropped
        ],
    };
    const promoSnapshot = {
        url: 'https://promo.shop.test/w', title: 'Promo', text: 'Promo code',
        elements: [{ ref: 0, tag: 'input', type: 'text', name: 'Promo', x: 50, y: 30, w: 120, h: 20 }],
    };
    const boxes: Record<string, unknown> = {
        F0: { left: 10, top: 100, width: 100, height: 50, sameOrigin: true, label: 'help' },
        F1: { left: 252, top: 202, width: 296, height: 196, sameOrigin: false, label: 'payment' },
        F2: { left: 2, top: 552, width: 196, height: 96, sameOrigin: false, label: '' },
    };
    const request: BrowserViewRequest = async (op, payload) => {
        calls.push({ op, payload });
        if (op === 'list') return { tabs: [{ label: 't', url: 'https://shop.test/', title: 'Shop', active: true }] };
        if (op === 'frames') {
            framesCalls++;
            if (framesCalls <= (options.reportAfterCalls ?? 0)) return { ok: true, frames: [], contexts: [{ context_id: 1, frame_id: 'MAIN', origin: 'https://shop.test' }] };
            return { ok: true,
                frames: [{ session: 'S1', target_id: 'F1', url: 'https://pay.example/widget', title: 'Pay' }],
                contexts: [
                    { context_id: 1, frame_id: 'MAIN', origin: 'https://shop.test' },
                    { context_id: 20, frame_id: 'F0', origin: 'https://shop.test' },
                    { context_id: 21, frame_id: 'F2', origin: 'https://promo.shop.test' },
                ] };
        }
        if (op === 'cdp') {
            const method = String(payload?.method);
            const params = (payload?.params ?? {}) as Record<string, unknown>;
            const expr = String(params.expression ?? '');
            if (method === 'DOM.enable') return { result: {} };
            // An own-process frame (F1) is not part of the page's frame tree; only its owner element is.
            if (method === 'Page.getFrameTree') return { result: { frameTree: { frame: { id: 'MAIN' }, childFrames: [
                { frame: { id: 'F0', parentId: 'MAIN', url: 'https://shop.test/help', name: 'help' } },
                { frame: { id: 'F2', parentId: 'MAIN', url: 'https://promo.shop.test/w', name: 'promo' } },
            ] } } };
            if (method === 'DOM.getFrameOwner') return { result: { backendNodeId: `node-${params.frameId}` } };
            if (method === 'DOM.resolveNode') return { result: { object: { objectId: `obj-${String(params.backendNodeId).replace('node-', '')}` } } };
            if (method === 'Runtime.callFunctionOn') {
                const frameId = String(params.objectId).replace('obj-', '');
                return { result: { result: { value: JSON.stringify(boxes[frameId]) } } };
            }
            if (method === 'Runtime.evaluate') {
                const where = payload?.session === 'S1' ? 'pay' : params.contextId === 21 ? 'promo' : params.contextId === undefined ? 'main' : 'other';
                if (expr.includes('D.activeElement()')) {
                    return { result: { result: { value: JSON.stringify(
                        where === 'pay' ? { tag: 'input[text]', value: '4242', readOnly: false }
                        : where === 'promo' ? { tag: 'none', value: '' }
                        : { tag: 'iframe', value: '' }) } } };
                }
                if (expr.includes('const recs=D.recorders()')) {
                    return { result: { result: { value: JSON.stringify(
                        where === 'pay' ? { url: 'https://pay.example/widget', total: 1, items: [{ t: 2000, kind: 'fetch', method: 'POST', url: '/charge', status: 402, ok: false, ms: 30 }] }
                        : where === 'promo' ? { url: 'https://promo.shop.test/w', total: 1, items: [{ t: 3000, kind: 'xhr', method: 'GET', url: '/promo', status: 200, ok: true, ms: 8 }] }
                        : { url: 'https://shop.test/', total: 1, items: [{ t: 1000, kind: 'fetch', method: 'GET', url: '/cart', status: 200, ok: true, ms: 12 }] }) } } };
                }
                if (expr.includes('const voidTags=')) {
                    return { result: { result: { value: JSON.stringify(
                        where === 'pay' ? { url: 'https://pay.example/widget', matched: 1, total: 30, chunk: '<form><input id="card"></form>' }
                        : where === 'promo' ? { url: 'https://promo.shop.test/w', matched: 1, total: 18, chunk: '<input id="promo">' }
                        : { url: 'https://shop.test/', matched: 1, total: 40, chunk: '<html><body><iframe src="x"></iframe></body></html>' }) } } };
                }
                return { result: { result: { value: JSON.stringify(where === 'pay' ? paySnapshot : where === 'promo' ? promoSnapshot : mainSnapshot) } } };
            }
        }
        if (op === 'act' && payload?.kind === 'click') return { ok: true, x: payload.x, y: payload.y };
        return { ok: true };
    };
    return { tool: createBrowserControlTool({ request }), calls };
}

test('snapshot folds own-process and same-process cross-origin frames in with top-viewport coordinates', async () => {
    const { tool, calls } = bridge({ reportAfterCalls: 2 }); // attach/context events arrive after two polls
    const result = await tool.execute({ action: 'snapshot' });
    assert.equal(result.success, true);
    const data = String(result.data);
    assert.match(data, /\[1\] <iframe cross-origin> https:\/\/pay\.example\/widget — its elements are listed below/);
    assert.match(data, /\[2\] <iframe cross-origin> https:\/\/promo\.shop\.test\/w — its elements are listed below/);
    // Frames from the page's tree come first, own-process targets after.
    assert.match(data, /\[3\] <input text> Promo \(in frame: promo \(cross-origin\)\)/);
    assert.match(data, /\[4\] <input text> Card \(in frame: payment \(cross-origin\)\)/);
    assert.match(data, /\[5\] <button> Pay \(in frame: payment \(cross-origin\)\)/);
    assert.doesNotMatch(data, /Far away/);
    assert.match(data, /\[frame: payment \(cross-origin\)\]\nCard number/);
    assert.match(data, /\[frame: promo \(cross-origin\)\]\nPromo code/);
    assert.equal(calls.filter(c => c.op === 'frames').length, 3);
    // The same-origin frame F0 is left to the page's own script: no evaluate in context 20.
    assert.ok(calls.every(c => (c.payload?.params as { contextId?: number } | undefined)?.contextId !== 20));

    // Clicking by ref lands at frame-local coordinates plus the frame's content origin.
    const click = await tool.execute({ action: 'click', ref: 4 });
    assert.equal(click.success, true);
    assert.deepEqual(calls.find(c => c.op === 'act')?.payload, { label: 't', kind: 'click', x: 352, y: 242, w: 180, h: 24 });
    const click2 = await tool.execute({ action: 'click', ref: 3 });
    assert.equal(click2.success, true);
    assert.deepEqual(calls.filter(c => c.op === 'act').at(-1)?.payload, { label: 't', kind: 'click', x: 52, y: 582, w: 120, h: 20 });
});

test('typing into an own-process frame is verified through its session', async () => {
    const { tool, calls } = bridge();
    await tool.execute({ action: 'snapshot' });
    const typed = await tool.execute({ action: 'type', ref: 4, text: '4242' });
    assert.equal(typed.success, true, String(typed.error));
    assert.match(String(typed.data), /Typed into <input\[text\]>: 4242/);
    const frameChecks = calls.filter(c => c.op === 'cdp' && c.payload?.session === 'S1' && String((c.payload?.params as { expression?: string })?.expression).includes('D.activeElement()'));
    assert.equal(frameChecks.length, 1);
});

test('get_html, console and network include both kinds of cross-origin frame', async () => {
    const { tool } = bridge();
    const html = await tool.execute({ action: 'get_html' });
    assert.equal(html.success, true);
    assert.match(String(html.data), /<template data-frame-document="cross-origin" data-src="https:\/\/pay\.example\/widget" data-frame="payment">\n<form><input id="card"><\/form>\n<\/template>/);
    assert.match(String(html.data), /<template data-frame-document="cross-origin" data-src="https:\/\/promo\.shop\.test\/w" data-frame="promo">\n<input id="promo">\n<\/template>/);

    const network = await tool.execute({ action: 'network' });
    assert.equal(network.success, true);
    assert.match(String(network.data), /Network \(last 3 of 3\)/);
    assert.match(String(network.data), /GET \/cart → 200 12ms\n.*POST \/charge → 402 ✗ 30ms \(frame: payment \(cross-origin\)\)\n.*GET \/promo → 200 8ms \(frame: promo \(cross-origin\)\)/s);
});
