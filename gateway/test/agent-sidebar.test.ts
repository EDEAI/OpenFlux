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
    replaceAgentOrderSection,
    sortAgentEntities,
} from '../../src/sidebar/agent-order';
import {
    AGENT_SESSION_PAGE_SIZE,
    AgentSessionPaginationController,
    INITIAL_AGENT_SESSION_COUNT,
} from '../../src/sidebar/session-pagination';
import {
    buildSidebarEntitySections,
    createSidebarEntityDivider,
    parseSidebarEntitySortModes,
    sortSidebarEntitySection,
} from '../../src/sidebar/agent-sections';

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
    const source = readFileSync(new URL('../../src/main.ts', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../../src/styles/main.css', import.meta.url), 'utf8');

    assert.doesNotMatch(source, /agent-pinned-badge/);
    assert.doesNotMatch(css, /\.agent-pinned-badge/);
    assert.match(source, /agent-menu-pin/);

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
    assert.deepEqual(
        replaceAgentOrderSection(['p1', 'p2', 'a1', 'a2', 'a3'], ['a3', 'a1', 'a2']),
        ['p1', 'p2', 'a3', 'a1', 'a2'],
    );
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

test('Agent session pagination starts at five and reveals ten sessions per click', () => {
    const pagination = new AgentSessionPaginationController();

    assert.equal(INITIAL_AGENT_SESSION_COUNT, 5);
    assert.equal(AGENT_SESSION_PAGE_SIZE, 10);
    assert.deepEqual(pagination.get('designer', 4), {
        totalCount: 4,
        visibleCount: 4,
        hiddenCount: 0,
        nextRevealCount: 0,
        expanded: false,
        hasMore: false,
        canCollapse: false,
        action: null,
    });

    const initial = pagination.get('designer', 27);
    assert.equal(initial.visibleCount, 5);
    assert.equal(initial.hiddenCount, 22);
    assert.equal(initial.nextRevealCount, 10);
    assert.equal(initial.action, 'expand');

    const secondPage = pagination.expand('designer', 27);
    assert.equal(secondPage.visibleCount, 15);
    assert.equal(secondPage.hiddenCount, 12);
    assert.equal(secondPage.nextRevealCount, 10);
    assert.equal(secondPage.action, 'more');
    assert.equal(secondPage.canCollapse, true);

    const thirdPage = pagination.expand('designer', 27);
    assert.equal(thirdPage.visibleCount, 25);
    assert.equal(thirdPage.hiddenCount, 2);
    assert.equal(thirdPage.nextRevealCount, 2);

    const complete = pagination.expand('designer', 27);
    assert.equal(complete.visibleCount, 27);
    assert.equal(complete.action, null);

    const collapsed = pagination.collapse('designer', 27);
    assert.equal(collapsed.visibleCount, 5);
    assert.equal(collapsed.action, 'expand');
});

test('session pagination keeps state per Agent and can reveal an older selected session', () => {
    const pagination = new AgentSessionPaginationController();
    pagination.expand('project-a', 40);

    assert.equal(pagination.get('project-a', 40).visibleCount, 15);
    assert.equal(pagination.get('agent-b', 40).visibleCount, 5);
    assert.equal(pagination.ensureVisible('agent-b', 24, 40).visibleCount, 25);

    pagination.prune(['agent-b']);
    assert.equal(pagination.get('project-a', 40).visibleCount, 5);
    assert.equal(pagination.get('agent-b', 40).visibleCount, 25);
});

test('pagination boundaries expose rows 5, 15, and 25 without skipping or duplicating a page', () => {
    const five = new AgentSessionPaginationController();
    assert.equal(five.get('five', 5).visibleCount, 5);
    assert.equal(five.get('five', 5).action, null);

    const fifteen = new AgentSessionPaginationController();
    assert.equal(fifteen.get('fifteen', 15).visibleCount, 5);
    const fifteenExpanded = fifteen.expand('fifteen', 15);
    assert.equal(fifteenExpanded.visibleCount, 15);
    assert.equal(fifteenExpanded.action, null);

    const twentyFive = new AgentSessionPaginationController();
    assert.equal(twentyFive.expand('twenty-five', 25).visibleCount, 15);
    assert.equal(twentyFive.get('twenty-five', 25).action, 'more');
    const twentyFiveExpanded = twentyFive.expand('twenty-five', 25);
    assert.equal(twentyFiveExpanded.visibleCount, 25);
    assert.equal(twentyFiveExpanded.action, null);
});

test('sidebar entities are grouped into pinned, project, and Agent sections without reordering', () => {
    const entities = [
        { id: 'pinned-project', kind: 'project' },
        { id: 'pinned-agent', kind: 'agent' },
        { id: 'project-b', kind: 'project' },
        { id: 'agent-b', kind: 'agent' },
        { id: 'legacy-agent' },
    ];

    const sections = buildSidebarEntitySections(entities, ['pinned-project', 'pinned-agent']);
    assert.deepEqual(sections.map(section => [section.id, section.items.map(item => item.id)]), [
        ['pinned', ['pinned-project', 'pinned-agent']],
        ['projects', ['project-b']],
        ['agents', ['agent-b', 'legacy-agent']],
    ]);
    assert.deepEqual(
        buildSidebarEntitySections(entities.filter(entity => entity.kind !== 'project'), []).map(section => section.id),
        ['agents'],
        'empty headings should not be rendered',
    );
});

test('sidebar section sorting supports persisted newest and manual modes', () => {
    assert.deepEqual(parseSidebarEntitySortModes(null), {});
    assert.deepEqual(parseSidebarEntitySortModes('invalid'), {});
    assert.deepEqual(
        parseSidebarEntitySortModes('{"pinned":"newest","projects":"manual","agents":"oldest","unknown":"newest"}'),
        { pinned: 'newest', projects: 'manual' },
    );

    const items = [
        { id: 'a', activeAt: 10 },
        { id: 'b', activeAt: 30 },
        { id: 'c', activeAt: 30 },
    ];
    assert.deepEqual(
        sortSidebarEntitySection(items, 'newest', item => item.activeAt).map(item => item.id),
        ['b', 'c', 'a'],
    );
    assert.deepEqual(
        sortSidebarEntitySection(items, 'manual', item => item.activeAt).map(item => item.id),
        ['a', 'b', 'c'],
    );
});

test('sidebar section divider is accessible and does not interpolate label markup', () => {
    withDom('', dom => {
        const divider = createSidebarEntityDivider(dom.window.document, 'projects', '<项目>');
        assert.equal(divider.className, 'sidebar-entity-divider');
        assert.equal(divider.dataset.sidebarSection, 'projects');
        assert.equal(divider.getAttribute('role'), 'separator');
        assert.equal(divider.getAttribute('aria-label'), '<项目>');
        assert.equal(divider.textContent, '<项目>');
        assert.equal(divider.querySelector('项目'), null);
    });
});

test('sidebar section divider exposes its sort menu on demand and reports the selected mode', () => {
    withDom('', dom => {
        let selected: string | undefined;
        const divider = createSidebarEntityDivider(dom.window.document, 'agents', 'Agent 会话', {
            activeMode: 'manual',
            menuLabel: 'Agent 会话排序',
            newestLabel: '最新排序',
            manualLabel: '手动排序',
            onSelect: mode => { selected = mode; },
        });
        dom.window.document.body.appendChild(divider);

        const trigger = requiredElement<HTMLButtonElement>(dom.window.document, '.sidebar-section-sort-trigger');
        const menu = requiredElement<HTMLElement>(dom.window.document, '.sidebar-section-sort-menu');
        assert.equal(trigger.getAttribute('aria-haspopup'), 'menu');
        assert.equal(trigger.getAttribute('aria-expanded'), 'false');
        assert.equal(menu.classList.contains('hidden'), true);

        trigger.click();
        assert.equal(trigger.getAttribute('aria-expanded'), 'true');
        assert.equal(menu.classList.contains('hidden'), false);
        const manual = requiredElement<HTMLButtonElement>(dom.window.document, '[data-sort-mode="manual"]');
        assert.equal(manual.getAttribute('aria-checked'), 'true');
        assert.equal(manual.textContent?.trim(), '✓手动排序');

        requiredElement<HTMLButtonElement>(dom.window.document, '[data-sort-mode="newest"]').click();
        assert.equal(selected, 'newest');
        assert.equal(menu.classList.contains('hidden'), true);
    });
});

test('session pagination and local section dividers have dedicated sidebar styles', () => {
    const css = readFileSync(new URL('../../src/styles/main.css', import.meta.url), 'utf8');
    assert.match(cssRuleBody(css, String.raw`\.agent-session-pagination`), /min-height\s*:\s*30px\s*;/);
    assert.match(cssRuleBody(css, String.raw`\.agent-session-pagination-action`), /cursor\s*:\s*pointer\s*;/);
    assert.match(cssRuleBody(css, String.raw`\.sidebar-entity-divider`), /display\s*:\s*flex\s*;/);
    assert.match(cssRuleBody(css, String.raw`\.sidebar-entity-divider::after`), /height\s*:\s*1px\s*;/);
    assert.match(cssRuleBody(css, String.raw`\.sidebar-section-sort-trigger`), /opacity\s*:\s*0\s*;/);
    assert.match(css, /\.sidebar-entity-divider:hover \.sidebar-section-sort-trigger,[\s\S]*?\{[^}]*opacity\s*:\s*1\s*;/);
    assert.match(cssRuleBody(css, String.raw`\.sidebar-section-sort-menu`), /position\s*:\s*absolute\s*;/);
    assert.match(cssRuleBody(css, String.raw`\.sidebar-section-sort-menu\.hidden`), /display\s*:\s*none\s*;/);
    assert.match(cssRuleBody(css, String.raw`\.sidebar\.collapsed\s+\.sidebar-entity-divider`), /display\s*:\s*none\s*;/);
});

test('main wires the five-plus-ten session pagination into every Agent and project list', () => {
    const source = readFileSync(new URL('../../src/main.ts', import.meta.url), 'utf8');

    assert.match(source, /new AgentSessionPaginationController\(\)/);
    assert.match(source, /agentSessionPagination\.prune\(sortedAgents\.map\(agent => agent\.id\)\)/);
    assert.match(source, /agentSessionPagination\.get\(agentId, sortedSessions\.length\)/);
    assert.match(source, /sortedSessions\.slice\(0, pagination\.visibleCount\)/);
    assert.match(source, /agentSessionPagination\.ensureVisible\(agentId, activeIndex, sortedSessions\.length\)/);
    assert.match(source, /agentSessionPagination\.expand\(agentId, sortedSessions\.length\)/);
    assert.match(source, /action\.textContent = t\('sidebar\.sessions_expand'\)/);
    assert.doesNotMatch(source, /sidebar\.sessions_(?:more|collapse)/);
    assert.match(source, /paginationRow\.className = 'agent-session-pagination'/);
});

test('sidebar rebuild refreshes the toolbar after applying the active session row', () => {
    const source = readFileSync(new URL('../../src/main.ts', import.meta.url), 'utf8');
    const renderStart = source.indexOf('function renderLocalAgents(): void');
    const renderEnd = source.indexOf('/** 构建当前 Agent 的会话子列表', renderStart);
    const renderBody = source.slice(renderStart, renderEnd);
    const selectionIndex = renderBody.lastIndexOf('syncSidebarEntitySelection();');
    const toolbarIndex = renderBody.lastIndexOf('syncProjectContextIndicator();');

    assert.ok(selectionIndex >= 0, 'the rebuilt rows must receive active state');
    assert.ok(toolbarIndex > selectionIndex, 'the toolbar must read the newly active row, not the stale DOM');

    const selectStart = source.indexOf('async function selectSession(sessionId: string)');
    const selectEnd = source.indexOf('async function createSession()', selectStart);
    const selectBody = source.slice(selectStart, selectEnd);
    const directSelectionIndex = selectBody.indexOf('syncSidebarEntitySelection();');
    const directToolbarIndex = selectBody.indexOf('syncProjectContextIndicator();', directSelectionIndex);
    assert.ok(directToolbarIndex > directSelectionIndex, 'direct session switches must update the toolbar synchronously');
});

test('main renders stable sidebar sections and prevents cross-section reorder', () => {
    const source = readFileSync(new URL('../../src/main.ts', import.meta.url), 'utf8');

    assert.match(source, /buildSidebarEntitySections\(sortedAgents, pinnedIds\)/);
    assert.match(source, /sortSidebarEntitySection\(/);
    assert.match(source, /getSidebarEntityActivityAt/);
    assert.match(source, /sidebarEntitySortModes\[section\.id\] \?\? 'manual'/);
    assert.match(source, /newestLabel: t\('sidebar\.sort_newest'\)/);
    assert.match(source, /manualLabel: t\('sidebar\.sort_manual'\)/);
    assert.match(source, /for \(const section of entitySections\)/);
    assert.match(source, /const sectionLabel = getSidebarEntitySectionLabel\(section\.id\)/);
    assert.match(source, /createSidebarEntityDivider\([\s\S]*?section\.id,[\s\S]*?sectionLabel/);
    assert.match(source, /for \(const agent of section\.items\)/);
    assert.match(source, /card\.dataset\.sidebarSection = section\.id/);
    assert.match(source, /targetCard\.dataset\.sidebarSection !== drag\.sourceCard\.dataset\.sidebarSection/);
    assert.match(source, /setSidebarEntitySortMode\(drag\.sourceSection, 'manual'\)/);
    assert.match(
        source,
        /manualIds: manualEntityIds/,
        'persisted drag order must retain entities from every section',
    );
    assert.match(source, /replaceAgentOrderSection\(drag\.manualIds, reorderedSection\)/);
});

test('sidebar pagination and section labels are translated in both language packs', () => {
    const zh = readFileSync(new URL('../../src/i18n/zh.ts', import.meta.url), 'utf8');
    const en = readFileSync(new URL('../../src/i18n/en.ts', import.meta.url), 'utf8');
    const keys = [
        'sidebar.section_pinned',
        'sidebar.section_projects',
        'sidebar.section_agents',
        'sidebar.sort_menu',
        'sidebar.sort_newest',
        'sidebar.sort_manual',
        'sidebar.sessions_expand',
    ];

    for (const key of keys) {
        assert.match(zh, new RegExp(`['"]${key.replaceAll('.', '\\.')}['"]\\s*:`));
        assert.match(en, new RegExp(`['"]${key.replaceAll('.', '\\.')}['"]\\s*:`));
    }
    assert.match(zh, /['"]sidebar\.sessions_expand['"]\s*:\s*['"]展开显示['"]/);
});
