import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Script } from 'node:vm';
import { JSDOM } from 'jsdom';

const helpers = Object.fromEntries(['drag', 'pointer'].map(name => [name,
    readFileSync(new URL(`../../src-tauri/src/commands/browser_view/${name}.js`, import.meta.url), 'utf8'),
]));
const captureMethods = ['setPointerCapture', 'releasePointerCapture', 'hasPointerCapture'] as const;

/** JSDOM supplies event dispatch; only unsupported layout and browser constructors are simulated. */
function fixture() {
    const dom = new JSDOM('<!doctype html><body><div id="source">Source</div><div id="destination">Destination</div><div id="outer"><div id="inner"><span id="child">Scroll</span></div></div><iframe id="frame"></iframe></body>', {
        runScripts: 'outside-only', url: 'https://fixture.invalid/',
    });
    const window = dom.window;
    const document = window.document;
    const source = document.getElementById('source')!;
    const destination = document.getElementById('destination')!;
    const originalCalls: Array<{ method: string; id: number }> = [];
    for (const method of captureMethods) {
        Object.defineProperty(window.Element.prototype, method, { configurable: true, writable: true,
            value(id: number) { originalCalls.push({ method, id }); return method === 'hasPointerCapture' ? false : undefined; },
        });
    }
    const originals = new Map(captureMethods.map(name => [name, Object.getOwnPropertyDescriptor(window.Element.prototype, name)!]));
    (window as any).PointerEvent = class extends window.MouseEvent {
        constructor(type: string, options: any = {}) {
            super(type, options);
            for (const key of ['pointerId', 'pointerType', 'isPrimary', 'pressure', 'width', 'height']) {
                Object.defineProperty(this, key, { value: options[key] });
            }
        }
    };
    (window as any).DataTransfer = class {
        private data = new Map<string, string>();
        effectAllowed = 'all'; dropEffect = 'none';
        setData(type: string, value: string) { this.data.set(type, value); }
        getData(type: string) { return this.data.get(type) || ''; }
        clearData() { this.data.clear(); }
    };
    (window as any).DragEvent = class extends window.MouseEvent {
        constructor(type: string, options: any = {}) {
            super(type, options);
            Object.defineProperty(this, 'dataTransfer', { value: options.dataTransfer });
        }
    };
    Object.defineProperty(window, 'innerWidth', { value: 800 });
    Object.defineProperty(window, 'innerHeight', { value: 600 });
    Object.defineProperty(document, 'scrollingElement', { value: document.documentElement });
    let hit = (x: number, _y: number): Element | null => x < 200 ? source : destination;
    (document as any).elementFromPoint = (x: number, y: number) => hit(x, y);
    const events: any[] = [];
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'mousemove', 'mouseup', 'pointerover', 'pointerout', 'pointerenter', 'pointerleave', 'wheel']) {
        document.addEventListener(type, (event: any) => events.push({ type, target: event.target.id, x: event.clientX, y: event.clientY, button: event.button, buttons: event.buttons, trusted: event.isTrusted }), true);
    }
    const run = (name: 'drag' | 'pointer', params: Record<string, unknown>) => {
        const value = new Script(`(${helpers[name]})(${JSON.stringify(params)})`).runInContext(dom.getInternalVMContext(), { timeout: 1000 });
        assert.equal(typeof value, 'string');
        return JSON.parse(value);
    };
    const assertRestored = () => {
        for (const name of captureMethods) {
            assert.deepEqual(Object.getOwnPropertyDescriptor(window.Element.prototype, name), originals.get(name), `${name} descriptor must be restored`);
        }
    };
    return { dom, window, document, source, destination, events, run, originals, originalCalls, assertRestored,
        setHit(next: typeof hit) { hit = next; },
    };
}

const dragParams = { x: 40, y: 50, x2: 320, y2: 240 };

test('DOM drag delivers requested coordinates, held/released buttons and transparent untrusted mode', () => {
    const f = fixture();
    try {
        const result = f.run('drag', dragParams);
        assert.equal(result.error, undefined);
        assert.equal(result.inputMode, 'dom');
        assert.equal(result.isTrusted, false);
        const down = f.events.find(e => e.type === 'pointerdown');
        assert.deepEqual([down.target, down.x, down.y, down.button, down.buttons], ['source', 40, 50, 0, 1]);
        const moves = f.events.filter(e => e.type === 'pointermove');
        assert.ok(moves.length > 1);
        assert.ok(moves.every(e => e.buttons === 1));
        assert.deepEqual([moves.at(-1).target, moves.at(-1).x, moves.at(-1).y], ['destination', 320, 240]);
        const up = f.events.find(e => e.type === 'pointerup');
        assert.deepEqual([up.x, up.y, up.buttons], [320, 240, 0]);
        assert.ok(f.events.every(e => e.trusted === false));
        f.assertRestored();
    } finally { f.dom.window.close(); }
});

test('capture emulation retains the source for moves, delegates other pointer IDs and restores prototypes', () => {
    const f = fixture();
    try {
        f.source.addEventListener('pointerdown', (e: any) => {
            (f.source as any).setPointerCapture(e.pointerId);
            assert.equal((f.source as any).hasPointerCapture(e.pointerId), true);
            (f.source as any).setPointerCapture(42);
        });
        assert.equal(f.run('drag', dragParams).error, undefined);
        assert.ok(f.events.filter(e => e.type === 'pointermove').every(e => e.target === 'source'));
        assert.deepEqual(f.originalCalls, [{ method: 'setPointerCapture', id: 42 }]);
        f.assertRestored();
    } finally { f.dom.window.close(); }
});

test('HTML5 drag events share a single DataTransfer from dragstart through accepted drop and dragend', () => {
    const f = fixture();
    try {
        f.source.setAttribute('draggable', 'true');
        const transfers: any[] = [];
        f.source.addEventListener('dragstart', (e: any) => { transfers.push(e.dataTransfer); e.dataTransfer.setData('text/plain', 'shared payload'); });
        f.destination.addEventListener('dragover', (e: any) => { transfers.push(e.dataTransfer); e.preventDefault(); });
        let dropped = '';
        f.destination.addEventListener('drop', (e: any) => { transfers.push(e.dataTransfer); dropped = e.dataTransfer.getData('text/plain'); });
        f.source.addEventListener('dragend', (e: any) => transfers.push(e.dataTransfer));
        assert.equal(f.run('drag', dragParams).error, undefined);
        assert.equal(dropped, 'shared payload');
        assert.ok(transfers.length >= 4);
        assert.ok(transfers.every(transfer => transfer === transfers[0]));
        f.assertRestored();
    } finally { f.dom.window.close(); }
});

test('canceled dragstart returns an error, cancels the pointer and restores prototype methods', () => {
    const f = fixture();
    try {
        f.source.setAttribute('draggable', 'true');
        f.source.addEventListener('dragstart', event => event.preventDefault());
        assert.match(f.run('drag', dragParams).error, /canceled.*dragstart/i);
        assert.equal(f.events.filter(e => e.type === 'pointercancel').length, 1);
        assert.equal(f.events.filter(e => e.type === 'pointerup').length, 0);
        f.assertRestored();
    } finally { f.dom.window.close(); }
});

test('an HTML5 destination must accept dragover before drop can be dispatched', () => {
    const f = fixture();
    try {
        f.source.setAttribute('draggable', 'true');
        let drops = 0;
        f.destination.addEventListener('drop', () => { drops++; });
        const result = f.run('drag', dragParams);
        assert.match(result.error, /accept|cancel|dragover|drop/i);
        assert.equal(drops, 0, 'an unaccepted target must not receive a forced drop');
        f.assertRestored();
    } finally { f.dom.window.close(); }
});

test('invalid coordinates and cross-frame targets are rejected before pointerdown', () => {
    const f = fixture();
    try {
        assert.match(f.run('drag', { ...dragParams, x2: 800 }).error, /viewport/);
        assert.match(f.run('pointer', { operation: 'hover', x: -1, y: 2 }).error, /viewport/);
        f.setHit(() => f.document.getElementById('frame'));
        assert.match(f.run('drag', dragParams).error, /current document/);
        assert.match(f.run('pointer', { operation: 'scroll', x: 2, y: 2, deltaY: 10 }).error, /current document/);
        assert.equal(f.events.length, 0);
        f.assertRestored();
    } finally { f.dom.window.close(); }
});

test('mid-drag page API failure is reported and cannot leave capture methods installed', () => {
    const f = fixture();
    try {
        let hits = 0;
        f.setHit(() => { if (++hits > 2) throw new Error('fixture hit testing failed'); return f.source; });
        assert.match(f.run('drag', dragParams).error, /fixture hit testing failed/);
        assert.equal(f.events.filter(e => e.type === 'pointercancel').length, 1);
        f.assertRestored();
    } finally { f.dom.window.close(); }
});

test('capture methods are restored even when pointercancel dispatch itself fails', () => {
    const f = fixture();
    try {
        let hits = 0;
        f.setHit(() => { if (++hits > 2) throw new Error('fixture hit testing failed'); return f.source; });
        const dispatch = f.source.dispatchEvent.bind(f.source);
        f.source.dispatchEvent = event => {
            if (event.type === 'pointercancel') throw new Error('fixture cancel failure');
            return dispatch(event);
        };
        // A cleanup failure may propagate to the WK callback as a script
        // error; either way it must never return a successful drag result.
        assert.throws(() => f.run('drag', dragParams), /fixture cancel failure/);
        f.assertRestored();
    } finally { f.dom.window.close(); }
});

test('partial capture installation failures restore methods already replaced', () => {
    const f = fixture();
    try {
        const second = Object.getOwnPropertyDescriptor(f.window.Element.prototype, 'releasePointerCapture')!;
        Object.defineProperty(f.window.Element.prototype, 'releasePointerCapture', { ...second, configurable: false });
        assert.match(f.run('drag', dragParams).error, /releasePointerCapture/);
        assert.deepEqual(Object.getOwnPropertyDescriptor(f.window.Element.prototype, 'setPointerCapture'), f.originals.get('setPointerCapture'));
        assert.equal(f.events.length, 0);
    } finally { f.dom.window.close(); }
});

test('DOM hover delivers enter/move and transition coordinates without claiming CSS hover', () => {
    const f = fixture();
    try {
        const first = f.run('pointer', { operation: 'hover', x: 50, y: 70 });
        assert.equal(first.cssHover, false);
        assert.equal(first.isTrusted, false);
        assert.equal(first.inputMode, 'dom');
        f.run('pointer', { operation: 'hover', x: 300, y: 220 });
        assert.ok(f.events.some(e => e.type === 'pointerout' && e.target === 'source'));
        const move = f.events.filter(e => e.type === 'pointermove').at(-1);
        assert.deepEqual([move.target, move.x, move.y, move.buttons], ['destination', 300, 220, 0]);
    } finally { f.dom.window.close(); }
});

test('hover enters ancestors once and does not re-enter a shared parent when moving between children', () => {
    const f = fixture();
    try {
        const parent = f.document.createElement('div');
        parent.id = 'hover-parent';
        f.document.body.append(parent);
        parent.append(f.source, f.destination);
        f.run('pointer', { operation: 'hover', x: 50, y: 70 });
        f.run('pointer', { operation: 'hover', x: 300, y: 220 });
        f.run('pointer', { operation: 'hover', x: 310, y: 230 });
        assert.equal(f.events.filter(e => e.type === 'pointerenter' && e.target === 'hover-parent').length, 1);
        assert.equal(f.events.filter(e => e.type === 'pointerleave' && e.target === 'hover-parent').length, 0);
        assert.equal(f.events.filter(e => e.type === 'pointerleave' && e.target === 'source').length, 1);
        assert.equal(f.events.filter(e => e.type === 'pointerenter' && e.target === 'destination').length, 1);
    } finally { f.dom.window.close(); }
});

function scrollable(element: Element, height = 100, contentHeight = 400) {
    const el = element as HTMLElement;
    el.style.overflowY = 'auto';
    Object.defineProperties(el, { clientHeight: { value: height }, scrollHeight: { value: contentHeight }, clientWidth: { value: 100 }, scrollWidth: { value: 100 } });
    const calls: any[] = [];
    el.scrollBy = ((options: ScrollToOptions) => {
        calls.push(options);
        el.scrollTop = Math.max(0, Math.min(contentHeight - height, el.scrollTop + (options.top || 0)));
    }) as any;
    return { el, calls };
}

test('DOM scroll uses the nearest scrollable container before the outer document', () => {
    const f = fixture();
    try {
        const inner = scrollable(f.document.getElementById('inner')!);
        const outer = scrollable(f.document.getElementById('outer')!);
        f.setHit(() => f.document.getElementById('child'));
        const result = f.run('pointer', { operation: 'scroll', x: 40, y: 50, deltaY: 65 });
        assert.equal(result.error, undefined);
        assert.equal(result.scrolled, true);
        assert.equal(inner.el.scrollTop, 65);
        assert.equal(outer.calls.length, 0);
        const wheel = f.events.find(e => e.type === 'wheel');
        assert.deepEqual([wheel.target, wheel.x, wheel.y, wheel.buttons], ['child', 40, 50, 0]);
    } finally { f.dom.window.close(); }
});

test('wheel preventDefault blocks synthetic default scrolling', () => {
    const f = fixture();
    try {
        const inner = scrollable(f.document.getElementById('inner')!);
        f.setHit(() => f.document.getElementById('child'));
        inner.el.addEventListener('wheel', event => event.preventDefault());
        const result = f.run('pointer', { operation: 'scroll', x: 40, y: 50, deltaY: 65 });
        assert.equal(result.defaultPrevented, true);
        assert.equal(result.scrolled, undefined);
        assert.equal(inner.calls.length, 0);
    } finally { f.dom.window.close(); }
});

test('scrolling at a boundary chains to the parent unless overscroll containment blocks it', () => {
    const f = fixture();
    try {
        const inner = scrollable(f.document.getElementById('inner')!);
        const outer = scrollable(f.document.getElementById('outer')!);
        inner.el.scrollTop = 300;
        f.setHit(() => f.document.getElementById('child'));
        assert.equal(f.run('pointer', { operation: 'scroll', x: 40, y: 50, deltaY: 65 }).scrolled, true);
        assert.equal(outer.el.scrollTop, 65);
        Object.defineProperty(f.window, 'getComputedStyle', { value: (element: Element) => ({ overflowY: 'auto', overflowX: 'visible', overscrollBehaviorY: element === inner.el ? 'contain' : 'auto' }) });
        const result = f.run('pointer', { operation: 'scroll', x: 40, y: 50, deltaY: 65 });
        assert.equal(result.scrolled, false);
        assert.equal(result.boundary, true);
        assert.equal(outer.el.scrollTop, 65);
    } finally { f.dom.window.close(); }
});

test('unknown operations and throwing scroll implementations return an error rather than success', () => {
    const f = fixture();
    try {
        assert.match(f.run('pointer', { operation: 'unknown', x: 40, y: 50 }).error, /Unknown.*operation/);
        const inner = scrollable(f.document.getElementById('inner')!);
        inner.el.scrollBy = () => { throw new Error('fixture scroll failure'); };
        f.setHit(() => f.document.getElementById('child'));
        const result = f.run('pointer', { operation: 'scroll', x: 40, y: 50, deltaY: 65 });
        assert.match(result.error, /fixture scroll failure/);
        assert.equal(result.scrolled, undefined);
    } finally { f.dom.window.close(); }
});
