import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/share-image.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

const canvas = { toDataURL: () => 'data:image/png;base64,aW1hZ2U=' };

/** Drain the dynamic imports and async click handlers without using real timers or services. */
async function settleAsync(): Promise<void> {
    await new Promise<void>(resolve => setImmediate(resolve));
}

function createHarness(options: { deferDialog?: boolean } = {}) {
    const dom = new JSDOM(`<!doctype html><html data-theme="light"><body>
        <button id="share-image-btn">分享图片</button>
        <div id="messages">
            <div class="message user" data-message="first"><div class="message-bubble">First message</div></div>
            <div class="message assistant" data-message="second"><div class="message-bubble"><p>Second message</p><button class="copy-btn">Copy</button></div><div class="message-actions">Actions</div></div>
        </div>
    </body></html>`, { url: 'https://openflux.test/' });
    const document = dom.window.document;
    const messages = document.getElementById('messages')!;
    const originals = Array.from(messages.querySelectorAll<HTMLElement>('.message'));
    const captures: Array<{ wrapper: HTMLElement; pending: ReturnType<typeof deferred<typeof canvas>> }> = [];
    const dialogCalls: unknown[] = [];
    const writes: Array<{ path: string; bytes: number[] }> = [];
    const errors: unknown[][] = [];
    const dialog = deferred<string | null>();
    const exports: { initShareImage?: () => void } = {};
    runInNewContext(compiled, {
        exports,
        module: { exports },
        document,
        window: dom.window,
        HTMLElement: dom.window.HTMLElement,
        HTMLButtonElement: dom.window.HTMLButtonElement,
        Node: dom.window.Node,
        FileReader: dom.window.FileReader,
        atob: dom.window.atob.bind(dom.window),
        requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 0; },
        setTimeout: () => 0,
        clearTimeout: () => undefined,
        fetch: async () => { throw new Error('The test uses the fallback icon.'); },
        console: { error: (...args: unknown[]) => errors.push(args) },
        require: (id: string) => {
            if (id === 'html2canvas') return {
                default: (wrapper: HTMLElement) => {
                    const pending = deferred<typeof canvas>();
                    captures.push({ wrapper, pending });
                    return pending.promise;
                },
            };
            if (id === '@tauri-apps/plugin-dialog') return {
                save: async (input: unknown) => {
                    dialogCalls.push(input);
                    return options.deferDialog ? dialog.promise : 'C:\\test\\chat.png';
                },
            };
            if (id === '@tauri-apps/plugin-fs') return {
                writeFile: async (path: string, bytes: Uint8Array) => { writes.push({ path, bytes: Array.from(bytes) }); },
            };
            throw new Error(`Unexpected import: ${id}`);
        },
    }, { filename: 'share-image.test-module.cjs' });
    assert.equal(typeof exports.initShareImage, 'function');
    exports.initShareImage!();

    function click(selector: string, index = 0): void {
        const target = document.querySelectorAll<HTMLElement>(selector)[index];
        assert.ok(target, `Expected a clickable ${selector} at ${index}`);
        target.click();
    }
    function escape(): void {
        document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }
    function assertClean(): void {
        assert.equal(document.querySelectorAll('#share-check-col, #share-floating-bar').length, 0);
        assert.equal(messages.classList.contains('share-select-mode'), false);
        for (const original of originals) {
            assert.equal(original.classList.contains('share-selectable'), false);
            assert.equal(original.classList.contains('share-selected'), false);
            const bubble = original.querySelector<HTMLElement>('.message-bubble')!;
            assert.equal(bubble.style.outline, '');
            assert.equal(bubble.style.outlineOffset, '');
        }
    }
    function assertSelection(index: number): void {
        assert.equal(messages.querySelectorAll('.share-selected').length, 1);
        assert.equal(originals[index].classList.contains('share-selected'), true);
        assert.notEqual(originals[index].querySelector<HTMLElement>('.message-bubble')!.style.outline, '');
        assert.equal(document.querySelector('.sfb-count')?.textContent, '已选 1 条');
    }
    return { dom, document, messages, originals, captures, dialogCalls, writes, errors, dialog, click, escape, assertClean, assertSelection };
}

test('repeated Share clicks preserve the current selection and repeated close/reopen leaves no controls', t => {
    const h = createHarness();
    t.after(() => h.dom.window.close());
    for (let cycle = 0; cycle < 3; cycle += 1) {
        h.click('#share-image-btn');
        h.click('.share-sel-overlay', 1);
        const bar = h.document.getElementById('share-floating-bar');
        const column = h.document.getElementById('share-check-col');
        h.click('#share-image-btn');
        h.click('#share-image-btn');
        assert.equal(h.document.querySelectorAll('#share-check-col').length, 1);
        assert.equal(h.document.querySelectorAll('#share-floating-bar').length, 1);
        assert.equal(h.document.getElementById('share-floating-bar'), bar);
        assert.equal(h.document.getElementById('share-check-col'), column);
        h.assertSelection(1);
        if (cycle % 2) h.escape();
        else h.click('.sfb-cancel');
        h.assertClean();
    }
});

for (const close of ['button', 'Escape'] as const) {
    test(`${close} also removes duplicate checkbox columns left by an earlier share session`, t => {
        const h = createHarness();
        t.after(() => h.dom.window.close());
        h.click('#share-image-btn');
        h.click('.share-sel-overlay');
        const column = h.document.getElementById('share-check-col')!;
        h.messages.appendChild(column.cloneNode(true));
        h.messages.appendChild(column.cloneNode(true));
        if (close === 'Escape') h.escape();
        else h.click('.sfb-cancel');
        h.assertClean();
    });
}

test('capture clears only cloned highlights and finishing after Escape never restores live selection', async t => {
    const h = createHarness();
    t.after(() => h.dom.window.close());
    h.click('#share-image-btn');
    h.click('.share-sel-overlay', 1);
    h.click('.sfb-confirm');
    await settleAsync();
    assert.equal(h.captures.length, 1);
    h.assertSelection(1);
    const capture = h.captures[0];
    const clone = capture.wrapper.querySelector<HTMLElement>('.message')!;
    assert.ok(clone);
    assert.notEqual(clone, h.originals[1]);
    assert.equal(clone.classList.contains('share-selectable'), false);
    assert.equal(clone.classList.contains('share-selected'), false);
    assert.equal(clone.querySelector<HTMLElement>('.message-bubble')!.style.outline, '');
    assert.equal(clone.querySelector('.message-actions, .copy-btn, .share-sel-overlay'), null);
    assert.ok(h.originals[1].querySelector('.copy-btn'), 'capture must preserve live message controls');
    h.escape();
    h.assertClean();
    capture.pending.resolve(canvas);
    await settleAsync();
    h.assertClean();
    assert.equal(capture.wrapper.isConnected, false);
    assert.equal(h.dialogCalls.length, 0);
    assert.equal(h.writes.length, 0);
});

for (const outcome of ['success', 'failure'] as const) {
    test(`an old capture ${outcome} cannot close or change a newly opened share session`, async t => {
        const h = createHarness();
        t.after(() => h.dom.window.close());
        h.click('#share-image-btn');
        h.click('.share-sel-overlay');
        h.click('.sfb-confirm');
        await settleAsync();
        assert.equal(h.captures.length, 1);
        h.click('.sfb-cancel');
        h.click('#share-image-btn');
        h.click('.share-sel-overlay', 1);
        const newBar = h.document.getElementById('share-floating-bar');
        if (outcome === 'success') h.captures[0].pending.resolve(canvas);
        else h.captures[0].pending.reject(new Error('Old capture failed'));
        await settleAsync();
        assert.equal(h.document.getElementById('share-floating-bar'), newBar);
        assert.equal(h.document.querySelectorAll('#share-check-col').length, 1);
        h.assertSelection(1);
        assert.equal(h.document.querySelector<HTMLButtonElement>('.sfb-confirm')!.disabled, false);
        assert.equal(h.document.querySelector('.share-toast'), null, 'stale completion must not show a toast for the new session');
        assert.equal(h.captures[0].wrapper.isConnected, false);
        assert.equal(h.dialogCalls.length, 0);
        assert.equal(h.writes.length, 0);
        h.escape();
        h.assertClean();
    });
}

test('changing the selection during capture cannot re-enable or reenter Save', async t => {
    const h = createHarness();
    t.after(() => h.dom.window.close());
    h.click('#share-image-btn');
    h.click('.share-sel-overlay');
    h.click('.sfb-confirm');
    await settleAsync();
    assert.equal(h.captures.length, 1);
    h.click('.sfb-none');
    h.click('.share-sel-overlay', 1);
    const save = h.document.querySelector<HTMLButtonElement>('.sfb-confirm')!;
    assert.equal(save.disabled, true);
    save.click();
    // Dispatch also exercises the handler's guard, rather than only native disabled-button behavior.
    save.dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true }));
    await settleAsync();
    assert.equal(h.captures.length, 1);
    h.captures[0].pending.resolve(canvas);
    await settleAsync();
    assert.equal(h.dialogCalls.length, 1);
    assert.equal(h.writes.length, 1);
    assert.deepEqual(h.writes[0].bytes, Array.from(Buffer.from('image')));
    h.assertClean();
});

test('a save dialog that finishes after close/reopen cannot dismiss the new toolbar', async t => {
    const h = createHarness({ deferDialog: true });
    t.after(() => h.dom.window.close());
    h.click('#share-image-btn');
    h.click('.share-sel-overlay');
    h.click('.sfb-confirm');
    await settleAsync();
    h.captures[0].pending.resolve(canvas);
    await settleAsync();
    assert.equal(h.dialogCalls.length, 1);
    h.escape();
    h.click('#share-image-btn');
    h.click('.share-sel-overlay', 1);
    const newBar = h.document.getElementById('share-floating-bar');
    h.dialog.resolve('C:\\test\\old-chat.png');
    await settleAsync();
    assert.equal(h.document.getElementById('share-floating-bar'), newBar);
    h.assertSelection(1);
    assert.equal(h.document.querySelector<HTMLButtonElement>('.sfb-confirm')!.disabled, false);
    assert.equal(h.document.querySelector('.share-toast'), null);
    h.escape();
    h.assertClean();
});
