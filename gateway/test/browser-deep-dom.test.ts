import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { DEEP_DOM_SOURCE, withDeepDom } from '../src/browser/deep-dom';
import { SNAPSHOT_EXPR, createBrowserControlTool, type BrowserViewRequest } from '../src/tools/browser-control/index';

/**
 * A page with a shadow-DOM button, a same-origin iframe holding a login form,
 * and a cross-origin iframe. jsdom has no layout, so rects come from
 * `data-rect="left,top,width,height"` (each document in its own viewport
 * coordinates, as in a browser) and elementFromPoint is derived from them.
 */
function fixture() {
    const dom = new JSDOM(`<!doctype html><html><head><title>Deep page</title></head><body>
<h1>Store</h1>
<button id="main-btn" data-rect="20,20,100,30">Main button</button>
<div id="host" data-rect="20,80,200,40"></div>
<iframe id="frame" title="checkout" data-rect="300,100,400,300" style="border:0"></iframe>
<iframe id="ads" src="https://ads.example/slot" data-rect="750,100,200,200"></iframe>
<p>Main text</p>
</body></html>`, { url: 'https://shop.test/', runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window as unknown as Window & typeof globalThis & { eval: (s: string) => unknown };
    const doc = w.document;

    const host = doc.getElementById('host')!;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<style>button{color:red}</style><span>Widget</span> <button id="shadow-btn" data-rect="120,85,80,30">Shadow OK</button>';

    const frame = doc.getElementById('frame') as HTMLIFrameElement;
    const fdoc = frame.contentDocument!;
    fdoc.body.innerHTML = '<form><label>Login</label><input id="email" placeholder="Email" data-rect="10,10,200,30"><button id="pay" data-rect="10,60,80,30">Pay</button></form>';

    const ads = doc.getElementById('ads') as HTMLIFrameElement;
    // Browsers expose null for a cross-origin frame's document.
    Object.defineProperty(ads, 'contentDocument', { get() { return null; } });

    // Layout stand-ins for both realms (main window and the frame's window).
    for (const win of [w, frame.contentWindow as unknown as typeof w]) {
        const ElementProto = (win as unknown as { Element: { prototype: Element } }).Element.prototype;
        ElementProto.getBoundingClientRect = function (this: Element) {
            const raw = this.getAttribute('data-rect');
            const [left, top, width, height] = raw ? raw.split(',').map(Number) : [0, 0, 0, 0];
            return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() { return this; } } as DOMRect;
        };
        Object.defineProperty(ElementProto, 'clientLeft', { get: () => 0, configurable: true });
        Object.defineProperty(ElementProto, 'clientTop', { get: () => 0, configurable: true });
        if (!('innerText' in ElementProto)) {
            Object.defineProperty(ElementProto, 'innerText', { get(this: Element) { return this.textContent ?? ''; }, configurable: true });
        }
        const originalGcs = win.getComputedStyle.bind(win);
        win.getComputedStyle = ((el: Element) => {
            const cs = originalGcs(el);
            return new Proxy(cs, { get: (t, k) => (k === 'opacity' ? (t.opacity || '1') : k === 'visibility' ? (t.visibility || 'visible') : Reflect.get(t, k)) });
        }) as typeof win.getComputedStyle;
        const hit = function (this: ParentNode, x: number, y: number): Element | null {
            let found: Element | null = null;
            for (const e of this.querySelectorAll('[data-rect]')) {
                const r = e.getBoundingClientRect();
                if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) found = e; // last = deepest in document order
            }
            return found;
        };
        (win as unknown as { Document: { prototype: Document } }).Document.prototype.elementFromPoint = hit;
        (win as unknown as { ShadowRoot: { prototype: ShadowRoot } }).ShadowRoot.prototype.elementFromPoint = hit;
    }
    return { w, doc, frame, fdoc, shadow };
}

test('snapshot lists elements from shadow roots and same-origin frames in page coordinates, and opaque cross-origin frames', () => {
    const { w } = fixture();
    const snap = JSON.parse(String(w.eval(SNAPSHOT_EXPR))) as { text: string; elements: Array<Record<string, unknown>> };
    const byName = Object.fromEntries(snap.elements.map(e => [e.name as string, e]));

    assert.deepEqual({ x: byName['Main button'].x, y: byName['Main button'].y, frame: byName['Main button'].frame }, { x: 70, y: 35, frame: undefined });
    // Shadow content shares the host document's viewport.
    assert.deepEqual({ x: byName['Shadow OK'].x, y: byName['Shadow OK'].y, w: byName['Shadow OK'].w, h: byName['Shadow OK'].h }, { x: 160, y: 100, w: 80, h: 30 });
    // Frame content is offset by the frame's position: input at (10,10)+(300,100).
    assert.deepEqual({ x: byName['Email'].x, y: byName['Email'].y, frame: byName['Email'].frame, tag: byName['Email'].tag }, { x: 410, y: 125, frame: 'checkout', tag: 'input' });
    assert.deepEqual({ x: byName['Pay'].x, y: byName['Pay'].y, frame: byName['Pay'].frame }, { x: 350, y: 175, frame: 'checkout' });
    const opaque = snap.elements.find(e => e.type === 'cross-origin')!;
    assert.deepEqual({ tag: opaque.tag, name: opaque.name, x: opaque.x, y: opaque.y, w: opaque.w, h: opaque.h }, { tag: 'iframe', name: 'https://ads.example/slot', x: 850, y: 200, w: 200, h: 200 });
    assert.match(snap.text, /Main text/);
    assert.match(snap.text, /Widget\s*Shadow OK/);
    assert.doesNotMatch(snap.text, /color:red/); // shadow <style> bodies are not page text
    assert.match(snap.text, /\[frame: checkout\]\s*Login/);
});

test('the tool renders frame membership and cross-origin frames in the element list', async () => {
    const { w } = fixture();
    const request: BrowserViewRequest = async (op, payload) => {
        if (op === 'list') return { tabs: [{ label: 't', url: 'https://shop.test/', title: 'Deep page', active: true }] };
        if (op === 'cdp') return { result: { result: { value: w.eval(String((payload?.params as { expression: string }).expression)) } } };
        return { ok: true };
    };
    const tool = createBrowserControlTool({ request });
    const snap = await tool.execute({ action: 'snapshot' });
    assert.equal(snap.success, true);
    assert.match(String(snap.data), /\[\d+\] <input text> Email \(in frame: checkout\)/);
    assert.match(String(snap.data), /\[\d+\] <button submit> Shadow OK\n/);
    assert.match(String(snap.data), /<iframe cross-origin> https:\/\/ads\.example\/slot — its contents could not be read/);

    const html = await tool.execute({ action: 'get_html' });
    assert.equal(html.success, true);
    assert.match(String(html.data), /<template data-frame-document="same-origin"><html><head><\/head><body><form>/);
    assert.match(String(html.data), /<template shadowrootmode="open"><style><\/style><span>Widget<\/span>/);
    assert.match(String(html.data), /<!-- cross-origin frame: contents unavailable to script -->/);

    const scoped = await tool.execute({ action: 'get_html', selector: '#email, #shadow-btn' });
    assert.equal(scoped.success, true);
    assert.match(String(scoped.data), /2 element\(s\) matching/);
    assert.match(String(scoped.data), /<input id="email" placeholder="Email"/);
    assert.match(String(scoped.data), /<button id="shadow-btn"/);
});

test('deep hit-testing and focus resolve into shadow roots and frames', () => {
    const { w, fdoc, frame } = fixture();
    const D = w.eval(DEEP_DOM_SOURCE) as {
        elementFromPoint: (x: number, y: number) => Element | null;
        activeElement: () => Element | null;
        text: (max: number) => string;
        querySelectorAll: (sel: string, limit: number) => Element[];
    };
    assert.equal(D.elementFromPoint(160, 100)?.id, 'shadow-btn');
    assert.equal(D.elementFromPoint(410, 125)?.id, 'email');
    assert.equal(D.elementFromPoint(70, 35)?.id, 'main-btn');
    assert.equal(D.elementFromPoint(850, 200)?.id, 'ads'); // cross-origin: stops at the frame element
    assert.equal(D.elementFromPoint(5, 5), null);

    frame.focus();
    (fdoc.getElementById('email') as HTMLInputElement).focus();
    assert.equal(D.activeElement()?.id, 'email');

    // Array.from re-homes the jsdom-realm array so strict deepEqual can compare prototypes.
    assert.deepEqual(Array.from(D.querySelectorAll('button', 10), e => e.id), ['main-btn', 'shadow-btn', 'pay']);

    const typed = w.eval(withDeepDom(`const el=D.activeElement();return el?el.tagName.toLowerCase()+':'+el.id:'none';`));
    assert.equal(typed, 'input:email');
});
