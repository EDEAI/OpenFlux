import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { hydrateLocalFileLinks } from '../../src/chat/local-file-links';

test('a local path opens a nearby action menu before performing an action', () => {
    const dom = new JSDOM('<div id="root"><p>D:\\output\\deck.pptx</p></div>');
    const previous = {
        document: globalThis.document,
        Node: globalThis.Node,
        NodeFilter: globalThis.NodeFilter,
    };
    Object.assign(globalThis, {
        document: dom.window.document,
        Node: dom.window.Node,
        NodeFilter: dom.window.NodeFilter,
    });

    try {
        const opened: string[] = [];
        const revealed: string[] = [];
        const root = dom.window.document.getElementById('root') as HTMLElement;
        hydrateLocalFileLinks(
            root,
            { open: '直接打开', reveal: '打开所在目录' },
            {
                open: path => opened.push(path),
                reveal: path => revealed.push(path),
            },
        );

        const trigger = root.querySelector<HTMLButtonElement>('.local-path-trigger');
        const menu = root.querySelector<HTMLElement>('.local-path-menu');
        const items = root.querySelectorAll<HTMLButtonElement>('.local-path-menu-item');
        assert.ok(trigger);
        assert.ok(menu);
        assert.equal(items.length, 2);
        assert.equal(menu.hidden, true);
        assert.deepEqual(opened, []);

        trigger.click();
        assert.equal(menu.hidden, false);
        assert.equal(trigger.getAttribute('aria-expanded'), 'true');
        items[0].click();
        assert.deepEqual(opened, ['D:\\output\\deck.pptx']);
        assert.equal(menu.hidden, true);

        trigger.click();
        items[1].click();
        assert.deepEqual(revealed, ['D:\\output\\deck.pptx']);

        trigger.click();
        dom.window.document.body.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
        assert.equal(menu.hidden, true);
    } finally {
        Object.assign(globalThis, previous);
        dom.window.close();
    }
});
