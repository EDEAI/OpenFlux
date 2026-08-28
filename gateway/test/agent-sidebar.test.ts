import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import {
    applyAgentSessionDisclosure,
    isAgentDisclosureActionTarget,
} from '../../src/sidebar/agent-disclosure';
import {
    parseStoredAgentOrder,
    reorderAgentIds,
    sortAgentEntities,
} from '../../src/sidebar/agent-order';

function withDom<T>(html: string, run: (dom: JSDOM) => T): T {
    const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
    const previousElement = Object.getOwnPropertyDescriptor(globalThis, 'Element');
    Object.defineProperty(globalThis, 'Element', {
        configurable: true,
        writable: true,
        value: dom.window.Element,
    });

    try {
        return run(dom);
    } finally {
        dom.window.close();
        if (previousElement) Object.defineProperty(globalThis, 'Element', previousElement);
        else delete (globalThis as Record<string, unknown>).Element;
    }
}

function requiredElement<T extends Element>(document: Document, selector: string): T {
    const element = document.querySelector<T>(selector);
    assert.ok(element, `expected ${selector} to exist`);
    return element;
}

test('applyAgentSessionDisclosure keeps the Agent card aria state and session-list classes in sync', () => {
    withDom(`
        <div class="local-agent-card"></div>
        <div class="agent-session-list"></div>
    `, dom => {
        const card = requiredElement<HTMLElement>(dom.window.document, '.local-agent-card');
        const sessionList = requiredElement<HTMLElement>(dom.window.document, '.agent-session-list');

        applyAgentSessionDisclosure(card, sessionList, false);
        assert.equal(card.getAttribute('aria-expanded'), 'true');
        assert.equal(card.classList.contains('sessions-collapsed'), false);
        assert.equal(sessionList.getAttribute('aria-hidden'), 'false');
        assert.equal(sessionList.classList.contains('is-collapsed'), false);

        applyAgentSessionDisclosure(card, sessionList, true);
        assert.equal(card.getAttribute('aria-expanded'), 'false');
        assert.equal(card.classList.contains('sessions-collapsed'), true);
        assert.equal(sessionList.getAttribute('aria-hidden'), 'true');
        assert.equal(sessionList.classList.contains('is-collapsed'), true);

        applyAgentSessionDisclosure(card, sessionList, false);
        assert.equal(card.getAttribute('aria-expanded'), 'true');
        assert.equal(card.classList.contains('sessions-collapsed'), false);
        assert.equal(sessionList.getAttribute('aria-hidden'), 'false');
        assert.equal(sessionList.classList.contains('is-collapsed'), false);
    });
});

test('nested action icons and menu items do not toggle the Agent disclosure', () => {
    withDom(`
        <div class="local-agent-card">
            <div class="agent-card-info"><span class="agent-card-name">Designer</span></div>
            <div class="agent-card-actions">
                <button class="agent-new-session-action"><svg><path></path></svg></button>
                <button class="agent-more-action"><svg><circle></circle></svg></button>
            </div>
            <div class="agent-menu-dropdown">
                <div class="agent-menu-item agent-menu-edit"><svg><path></path></svg></div>
            </div>
        </div>
        <div class="agent-session-list"></div>
    `, dom => {
        const document = dom.window.document;
        const card = requiredElement<HTMLElement>(document, '.local-agent-card');
        const sessionList = requiredElement<HTMLElement>(document, '.agent-session-list');
        const cardInfo = requiredElement<HTMLElement>(document, '.agent-card-info');
        const newSessionIcon = requiredElement<SVGElement>(document, '.agent-new-session-action svg');
        const moreActionIcon = requiredElement<SVGElement>(document, '.agent-more-action svg');
        const menuItem = requiredElement<HTMLElement>(document, '.agent-menu-item');

        assert.equal(isAgentDisclosureActionTarget(cardInfo), false);
        assert.equal(isAgentDisclosureActionTarget(newSessionIcon), true);
        assert.equal(isAgentDisclosureActionTarget(moreActionIcon), true);
        assert.equal(isAgentDisclosureActionTarget(menuItem), true);

        let collapsed = false;
        let disclosureChanges = 0;
        applyAgentSessionDisclosure(card, sessionList, collapsed);
        card.addEventListener('click', event => {
            if (isAgentDisclosureActionTarget(event.target)) return;
            collapsed = !collapsed;
            disclosureChanges++;
            applyAgentSessionDisclosure(card, sessionList, collapsed);
        });

        const click = (target: Element) => target.dispatchEvent(new dom.window.MouseEvent('click', {
            bubbles: true,
        }));

        click(cardInfo);
        assert.equal(disclosureChanges, 1);
        assert.equal(card.getAttribute('aria-expanded'), 'false');

        click(newSessionIcon);
        click(moreActionIcon);
        click(menuItem);
        assert.equal(disclosureChanges, 1, 'Agent actions must not reach the disclosure handler');
        assert.equal(card.getAttribute('aria-expanded'), 'false');
        assert.equal(sessionList.classList.contains('is-collapsed'), true);

        click(cardInfo);
        assert.equal(disclosureChanges, 2);
        assert.equal(card.getAttribute('aria-expanded'), 'true');
        assert.equal(sessionList.classList.contains('is-collapsed'), false);
    });
});

function cssRuleBody(css: string, selectorPattern: string): string {
    const match = css.match(new RegExp(`${selectorPattern}\\s*\\{([^}]*)\\}`, 'm'));
    assert.ok(match, `expected CSS rule ${selectorPattern}`);
    return match[1];
}

function declarationNames(body: string): string[] {
    return [...body.matchAll(/([a-z-]+)\s*:/gi)].map(match => match[1]).sort();
}

test('session action controls keep their layout slot while hover and focus only change visibility', () => {
    const css = readFileSync(new URL('../../src/styles/main.css', import.meta.url), 'utf8');
    const itemRule = cssRuleBody(css, String.raw`\.agent-session-item`);
    const actionsRule = cssRuleBody(css, String.raw`\.agent-session-actions`);
    const visibleRule = cssRuleBody(
        css,
        String.raw`\.agent-session-item:hover\s+\.agent-session-actions\s*,\s*\.agent-session-item:focus-within\s+\.agent-session-actions`,
    );

    assert.match(itemRule, /min-height\s*:\s*32px\s*;/);
    assert.match(itemRule, /box-sizing\s*:\s*border-box\s*;/);

    assert.match(actionsRule, /display\s*:\s*flex\s*;/);
    assert.match(actionsRule, /opacity\s*:\s*0\s*;/);
    assert.match(actionsRule, /visibility\s*:\s*hidden\s*;/);
    assert.match(actionsRule, /pointer-events\s*:\s*none\s*;/);
    assert.doesNotMatch(actionsRule, /display\s*:\s*none/);

    assert.deepEqual(declarationNames(visibleRule), ['opacity', 'pointer-events', 'visibility']);
    assert.match(visibleRule, /opacity\s*:\s*1\s*;/);
    assert.match(visibleRule, /visibility\s*:\s*visible\s*;/);
    assert.match(visibleRule, /pointer-events\s*:\s*auto\s*;/);
});

test('project cards use a neutral monochrome folder icon in the sidebar', () => {
    const css = readFileSync(new URL('../../src/styles/main.css', import.meta.url), 'utf8');
    const source = readFileSync(new URL('../../src/main.ts', import.meta.url), 'utf8');
    const projectIconRule = cssRuleBody(css, String.raw`\.agent-card-icon\.project-card-icon`);

    assert.match(projectIconRule, /background\s*:\s*transparent\s*;/);
    assert.match(projectIconRule, /color\s*:\s*var\(--color-text-secondary\)\s*;/);
    assert.match(source, /project-card-icon/);
    assert.match(source, /fill="none" stroke="currentColor"/);
});

test('stored Agent order is sanitized and applied within pinned and regular groups', () => {
    assert.deepEqual(parseStoredAgentOrder('["project-a","agent-b","project-a",3]'), ['project-a', 'agent-b']);
    assert.deepEqual(parseStoredAgentOrder('invalid'), []);

    const entities = [
        { id: 'agent-a' },
        { id: 'project-a' },
        { id: 'agent-b' },
        { id: 'project-b' },
        { id: 'new-agent' },
    ];
    const sorted = sortAgentEntities(
        entities,
        ['project-b', 'agent-b', 'project-a', 'agent-a'],
        ['agent-b', 'project-b'],
    );

    assert.deepEqual(sorted.map(item => item.id), [
        'project-b',
        'agent-b',
        'project-a',
        'agent-a',
        'new-agent',
    ]);
});

test('drag reorder inserts the source before or after the hovered Agent card', () => {
    assert.deepEqual(reorderAgentIds(['a', 'b', 'c', 'd'], 'b', 'd', 'after'), ['a', 'c', 'd', 'b']);
    assert.deepEqual(reorderAgentIds(['a', 'b', 'c', 'd'], 'd', 'b', 'before'), ['a', 'd', 'b', 'c']);
    assert.deepEqual(reorderAgentIds(['a', 'b'], 'a', 'a', 'after'), ['a', 'b']);
});

test('sidebar drag styles hide child sessions and show the insertion edge', () => {
    const css = readFileSync(new URL('../../src/styles/main.css', import.meta.url), 'utf8');
    const source = readFileSync(new URL('../../src/main.ts', import.meta.url), 'utf8');

    assert.match(cssRuleBody(css, String.raw`\.session-list\.agent-reordering\s+\.agent-session-list`), /display\s*:\s*none\s*;/);
    assert.match(cssRuleBody(css, String.raw`\.local-agent-card\.agent-drop-before`), /box-shadow\s*:\s*0 -2px 0 var\(--color-primary\)\s*;/);
    assert.match(source, /AGENT_ORDER_STORAGE_KEY/);
    assert.match(source, /addEventListener\('pointerdown'/);
    assert.match(source, /addEventListener\('pointermove'/);
    assert.match(source, /addEventListener\('pointerup'/);
    assert.doesNotMatch(source, /card\.draggable = true/);
});
