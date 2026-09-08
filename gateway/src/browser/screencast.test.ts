import assert from 'node:assert/strict';
import test from 'node:test';
import type { Page } from 'playwright-core';
import { normalizeInputEvent, SCREENCAST_PRESETS, startScreencastOnPage, type ScreencastFrame, type ScreencastPageState } from './screencast';

interface SentCall { method: string; params?: Record<string, unknown> }

/**
 * A stand-in for the CDP session and page. Enough surface for the projection:
 * emitting frames, recording what was sent, and firing page lifecycle events.
 */
function fakePage(options: { ackFails?: boolean } = {}) {
    const sent: SentCall[] = [];
    const listeners = new Map<string, Array<(payload: unknown) => void>>();
    const pageListeners = new Map<string, Array<() => void>>();
    let detached = false;
    let url = 'https://example.test/start';

    const cdp = {
        on(event: string, handler: (payload: unknown) => void) {
            listeners.set(event, [...(listeners.get(event) ?? []), handler]);
        },
        async send(method: string, params?: Record<string, unknown>) {
            sent.push({ method, params });
            if (method === 'Page.screencastFrameAck' && options.ackFails) {
                throw new Error('session gone');
            }
            if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: 'TARGET-1' } };
            return {};
        },
        async detach() { detached = true; },
    };

    const page = {
        context: () => ({ newCDPSession: async () => cdp }),
        url: () => url,
        title: async () => 'Example title',
        on(event: string, handler: () => void) {
            pageListeners.set(event, [...(pageListeners.get(event) ?? []), handler]);
        },
        off(event: string, handler: () => void) {
            pageListeners.set(event, (pageListeners.get(event) ?? []).filter(h => h !== handler));
        },
    } as unknown as Page;

    return {
        page,
        sent,
        get detached() { return detached; },
        setUrl(next: string) { url = next; },
        pageListenerCount(event: string) { return (pageListeners.get(event) ?? []).length; },
        firePageEvent(event: string) {
            for (const handler of pageListeners.get(event) ?? []) handler();
        },
        async emitFrame(sessionId: number, metadata: Record<string, number> = {}) {
            for (const handler of listeners.get('Page.screencastFrame') ?? []) {
                await handler({ data: `frame-${sessionId}`, sessionId, metadata });
            }
        },
        sentMethods() { return sent.map(call => call.method); },
    };
}

function collector() {
    const frames: ScreencastFrame[] = [];
    const states: ScreencastPageState[] = [];
    const closed: string[] = [];
    return {
        frames, states, closed,
        onFrame: (frame: ScreencastFrame) => { frames.push(frame); },
        onState: (state: ScreencastPageState) => { states.push(state); },
        onClosed: (reason: string) => { closed.push(reason); },
    };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('starts the screencast with the requested quality preset', async () => {
    const fake = fakePage();
    const sink = collector();

    const handle = await startScreencastOnPage(fake.page, { ...sink, quality: SCREENCAST_PRESETS.bridge });

    const start = fake.sent.find(call => call.method === 'Page.startScreencast');
    assert.ok(start, 'startScreencast was sent');
    assert.deepEqual(start.params, {
        format: 'jpeg',
        quality: SCREENCAST_PRESETS.bridge.quality,
        maxWidth: SCREENCAST_PRESETS.bridge.maxWidth,
        maxHeight: SCREENCAST_PRESETS.bridge.maxHeight,
        everyNthFrame: SCREENCAST_PRESETS.bridge.everyNthFrame,
    });
    assert.equal(handle.targetId, 'TARGET-1', 'resolved the target id from CDP');
});

test('acknowledges every frame and forwards it with mapped metadata', async () => {
    const fake = fakePage();
    const sink = collector();
    await startScreencastOnPage(fake.page, sink);

    await fake.emitFrame(7, {
        deviceWidth: 1024, deviceHeight: 768, pageScaleFactor: 2,
        offsetTop: 12, scrollOffsetX: 3, scrollOffsetY: 40, timestamp: 1700,
    });

    const acks = fake.sent.filter(call => call.method === 'Page.screencastFrameAck');
    assert.deepEqual(acks.map(a => a.params), [{ sessionId: 7 }]);
    assert.equal(sink.frames.length, 1);
    assert.equal(sink.frames[0].data, 'frame-7');
    assert.deepEqual(sink.frames[0].meta, {
        deviceWidth: 1024, deviceHeight: 768, pageScaleFactor: 2,
        offsetTop: 12, scrollOffsetX: 3, scrollOffsetY: 40, timestamp: 1700,
    });
});

test('a dropped frame is still acknowledged', async () => {
    // The whole point: skipping the ack on a dropped frame would end the
    // stream silently, so back-pressure must never short-circuit the ack.
    const fake = fakePage();
    const sink = collector();
    let dropping = true;
    await startScreencastOnPage(fake.page, { ...sink, shouldDropFrame: () => dropping });

    await fake.emitFrame(1);
    await fake.emitFrame(2);
    dropping = false;
    await fake.emitFrame(3);

    const acks = fake.sent.filter(call => call.method === 'Page.screencastFrameAck');
    assert.deepEqual(acks.map(a => (a.params as { sessionId: number }).sessionId), [1, 2, 3], 'all three acked');
    assert.deepEqual(sink.frames.map(f => f.data), ['frame-3'], 'only the undropped frame was forwarded');
});

test('missing metadata fields fall back instead of producing NaN', async () => {
    const fake = fakePage();
    const sink = collector();
    await startScreencastOnPage(fake.page, sink);

    await fake.emitFrame(1, {});

    const meta = sink.frames[0].meta;
    assert.equal(meta.deviceWidth, 0);
    assert.equal(meta.pageScaleFactor, 1, 'scale defaults to 1, not 0');
    assert.ok(Number.isFinite(meta.timestamp));
});

test('an ack failure stops forwarding that frame rather than throwing', async () => {
    const fake = fakePage({ ackFails: true });
    const sink = collector();
    await startScreencastOnPage(fake.page, sink);

    await fake.emitFrame(1);

    assert.equal(sink.frames.length, 0, 'no frame forwarded once the session is gone');
});

test('navigation and load push page state', async () => {
    const fake = fakePage();
    const sink = collector();
    await startScreencastOnPage(fake.page, sink);
    await settle();
    sink.states.length = 0;

    fake.setUrl('https://example.test/next');
    fake.firePageEvent('framenavigated');
    await settle();
    fake.firePageEvent('load');
    await settle();

    assert.deepEqual(sink.states.map(s => [s.url, s.loading]), [
        ['https://example.test/next', true],
        ['https://example.test/next', false],
    ]);
    assert.equal(sink.states[0].title, 'Example title');
});

test('retune restarts the stream with the new sizing', async () => {
    const fake = fakePage();
    const sink = collector();
    const handle = await startScreencastOnPage(fake.page, sink);

    await handle.retune({ maxWidth: 480, maxHeight: 320 });

    assert.deepEqual(
        fake.sentMethods().filter(m => m.startsWith('Page.') && m.endsWith('Screencast')),
        ['Page.startScreencast', 'Page.stopScreencast', 'Page.startScreencast'],
        'sizing only applies at start, so the stream is restarted',
    );
    const restart = fake.sent.filter(c => c.method === 'Page.startScreencast').at(-1)!;
    assert.equal((restart.params as { maxWidth: number }).maxWidth, 480);
    assert.equal((restart.params as { quality: number }).quality, SCREENCAST_PRESETS.ws.quality, 'unrelated settings kept');
});

test('stop detaches, unhooks page events and silences later frames', async () => {
    const fake = fakePage();
    const sink = collector();
    const handle = await startScreencastOnPage(fake.page, sink);

    await handle.stop();

    assert.ok(fake.sentMethods().includes('Page.stopScreencast'));
    assert.ok(fake.detached, 'CDP session detached');
    assert.equal(fake.pageListenerCount('framenavigated'), 0, 'page listeners removed');
    assert.equal(fake.pageListenerCount('close'), 0);

    await fake.emitFrame(9);
    assert.equal(sink.frames.length, 0, 'frames after stop are ignored');

    await handle.stop();
    assert.equal(fake.sentMethods().filter(m => m === 'Page.stopScreencast').length, 1, 'stop is idempotent');
});

test('a closed page reports once and stops forwarding', async () => {
    const fake = fakePage();
    const sink = collector();
    await startScreencastOnPage(fake.page, sink);

    fake.firePageEvent('close');
    await fake.emitFrame(4);

    assert.deepEqual(sink.closed, ['page_closed']);
    assert.equal(sink.frames.length, 0);
});

test('retune after stop is a no-op', async () => {
    const fake = fakePage();
    const sink = collector();
    const handle = await startScreencastOnPage(fake.page, sink);
    await handle.stop();

    await handle.retune({ maxWidth: 100 });

    assert.equal(
        fake.sent.filter(c => c.method === 'Page.startScreencast').length,
        1,
        'a stopped projection is not silently restarted',
    );
});

test('normalizeInputEvent accepts well-formed gestures', () => {
    assert.deepEqual(
        normalizeInputEvent({ kind: 'mouse', type: 'mousePressed', x: 10.5, y: 20, button: 'right', clickCount: 2, modifiers: 8 }),
        { kind: 'mouse', type: 'mousePressed', x: 10.5, y: 20, button: 'right', clickCount: 2, modifiers: 8 },
    );
    assert.deepEqual(
        normalizeInputEvent({ kind: 'wheel', x: 1, y: 2, deltaX: 0, deltaY: -120 }),
        { kind: 'wheel', x: 1, y: 2, deltaX: 0, deltaY: -120, modifiers: 0 },
    );
    const key = normalizeInputEvent({ kind: 'key', type: 'keyDown', key: 'a', code: 'KeyA', text: 'a', windowsVirtualKeyCode: 65 });
    assert.equal(key?.kind, 'key');
});

test('normalizeInputEvent rejects anything it does not recognise', () => {
    // This is the boundary between the panel and a browser holding the user's
    // logged-in sessions, so unknown shapes are dropped rather than passed on.
    for (const bad of [
        null,
        'mousePressed',
        { kind: 'mouse', type: 'Input.dispatchDragEvent', x: 0, y: 0 },
        { kind: 'key', type: 'rawKeyDown' },
        { kind: 'key', type: 'char' },
        { kind: 'touch', x: 0, y: 0 },
        {},
    ]) {
        assert.equal(normalizeInputEvent(bad), null, JSON.stringify(bad));
    }
});

test('normalizeInputEvent sanitises out-of-range and non-finite values', () => {
    const mouse = normalizeInputEvent({
        kind: 'mouse', type: 'mouseMoved',
        x: Number.NaN, y: Number.POSITIVE_INFINITY,
        button: 'evil', clickCount: 99, modifiers: 4096,
    });
    assert.deepEqual(mouse, {
        kind: 'mouse', type: 'mouseMoved', x: 0, y: 0,
        button: 'left', clickCount: 3, modifiers: 0,
    });

    const key = normalizeInputEvent({ kind: 'key', type: 'char', text: 'x'.repeat(500), key: 'y'.repeat(500) });
    assert.equal((key as { text: string }).text.length, 8, 'text is capped');
    assert.equal((key as { key: string }).key.length, 32, 'key name is capped');
});

test('dispatchInput maps each gesture onto the right CDP call', async () => {
    const fake = fakePage();
    const sink = collector();
    const handle = await startScreencastOnPage(fake.page, sink);

    await handle.dispatchInput({ kind: 'mouse', type: 'mousePressed', x: 5, y: 6, button: 'left', clickCount: 1, modifiers: 0 });
    await handle.dispatchInput({ kind: 'wheel', x: 5, y: 6, deltaX: 0, deltaY: -50, modifiers: 0 });
    await handle.dispatchInput({ kind: 'key', type: 'char', text: 'q', modifiers: 0 });

    const dispatched = fake.sent.filter(c => c.method.startsWith('Input.'));
    assert.deepEqual(dispatched.map(c => c.method), [
        'Input.dispatchMouseEvent',
        'Input.dispatchMouseEvent',
        'Input.dispatchKeyEvent',
    ]);
    assert.equal((dispatched[1].params as { type: string }).type, 'mouseWheel');
    assert.equal((dispatched[2].params as { text: string }).text, 'q');
});

test('dispatchInput is inert after stop', async () => {
    const fake = fakePage();
    const sink = collector();
    const handle = await startScreencastOnPage(fake.page, sink);
    await handle.stop();

    await handle.dispatchInput({ kind: 'mouse', type: 'mousePressed', x: 1, y: 1, button: 'left', clickCount: 1, modifiers: 0 });

    assert.equal(fake.sent.filter(c => c.method.startsWith('Input.')).length, 0);
});
