import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as browserModule from './index';
import * as common from '../tools/common';
import type { AnyTool, ToolResult } from '../tools/types';

const compiled = ts.transpileModule(
    readFileSync(new URL('../tools/browser/index.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

/** Exercise the real tool and ref helpers; replace only browser startup and Page I/O. */
function harness(cdp = false, failGotoUrl?: string) {
    const pages: any[] = [];
    const actions: Array<Record<string, unknown>> = [];
    let probes = 0;
    let launches = 0;
    let connections = 0;
    const context = { pages: () => pages, newPage: async () => makePage() };
    function makePage() {
        const index = pages.length;
        let closed = false;
        let url = 'about:blank';
        let tree = '- button "Save"\n- textbox "Search"\n- button "Save"';
        function scope(frame?: string) {
            return {
                locator(selector: string) {
                    return { ariaSnapshot: async () => {
                        actions.push({ action: 'ariaSnapshot', page: index, selector, frame });
                        return tree;
                    } };
                },
                getByRole(role: string, options?: { name?: string; exact?: boolean }) {
                    const target: Record<string, unknown> = { page: index, frame, role, ...options };
                    const record = (action: string, value?: unknown) => async (arg?: unknown) => {
                        actions.push({ ...target, action, value: value ?? arg });
                    };
                    const locator = {
                        nth(nth: number) { target.nth = nth; return locator; },
                        click: record('click'), dblclick: record('dblclick'),
                        fill: record('fill'), type: record('type'), press: record('press'),
                        hover: record('hover'), selectOption: record('select'),
                        scrollIntoViewIfNeeded: record('scroll'),
                    };
                    return locator;
                },
            };
        }
        const page = {
            ...scope(),
            frameLocator: (frame: string) => scope(frame),
            on() {}, isClosed: () => closed, context: () => context,
            title: async () => 'Fixture', url: () => url,
            goto: async (next: string) => {
                url = next;
                if (next === failGotoUrl) throw new Error('Fixture navigation failed');
            },
            evaluate: async () => ({ description: '', h1: [], linkCount: 0 }),
            bringToFront: async () => {}, close: async () => { closed = true; },
            setTree(next: string) { tree = next; },
            // Deliberately no Page.accessibility: Playwright 1.60 removed it.
        };
        pages.push(page);
        return page;
    }
    const browser = {
        contexts: () => pages.length ? [context] : [],
        newContext: async () => context, on() {}, close: async () => {},
    };
    const moduleProxy = { ...browserModule };
    for (const name of ['snapshotRoleViaPlaywright', 'clickViaPlaywright', 'typeViaPlaywright', 'hoverViaPlaywright', 'selectOptionViaPlaywright'] as const) {
        (moduleProxy as any)[name] = async (options: any) => {
            assert.ok(options.page, `${name} must receive the current standalone Page, never reconnect through CDP`);
            return (browserModule[name] as any)(options);
        };
    }
    const exports: {
        createBrowserTool?: () => AnyTool;
        cleanupScheduledPages?: (sessionId: string, runId?: string) => Promise<void>;
        resolveBrowserPageKey?: (context?: Record<string, unknown>) => string | undefined;
    } = {};
    runInNewContext(compiled, {
        exports, module: { exports }, URL, setTimeout, clearTimeout,
        process: { platform: 'darwin', env: {} },
        console: { log() {}, warn() {}, error() {} },
        require(id: string) {
            if (id === '../common') return common;
            if (id === '../../browser/index.js') return moduleProxy;
            if (id === 'fs') return { existsSync: () => false };
            if (id === 'path') return path;
            if (id === 'os') return { homedir: () => '/test-home' };
            if (id === 'child_process') return { execSync() { throw new Error('No Windows process list on macOS'); } };
            if (id === 'http') return { get(_url: string, _options: unknown, callback: (res: any) => void) {
                probes++;
                const request = new EventEmitter() as EventEmitter & { destroy(): void };
                request.destroy = () => {};
                queueMicrotask(() => {
                    if (!cdp) { request.emit('error', new Error('No CDP endpoint')); return; }
                    const response = new EventEmitter() as any;
                    response.statusCode = 200;
                    response.setEncoding = () => {};
                    callback(response);
                    response.emit('data', JSON.stringify({ webSocketDebuggerUrl: 'ws://fixture.test' }));
                    response.emit('end');
                });
                return request;
            } };
            if (id === 'playwright-core') return { chromium: {
                launch: async () => { launches++; return browser; },
                connectOverCDP: async () => { connections++; return browser; },
            } };
            throw new Error(`Unexpected dependency: ${id}`);
        },
    });
    const tool = exports.createBrowserTool!();
    return {
        tool,
        pages,
        actions,
        cleanupScheduledPages: exports.cleanupScheduledPages!,
        resolveBrowserPageKey: exports.resolveBrowserPageKey!,
        get probes() { return probes; },
        get launches() { return launches; },
        get connections() { return connections; },
    };
}

function data(result: ToolResult): any {
    assert.equal(result.success, true, result.error);
    return result.data;
}

test('standalone connect and status clearly scope isolated login state; reconnect preserves the context', async () => {
    const h = harness();
    const connection = data(await h.tool.execute({ action: 'connect' }));
    assert.equal(connection.mode, 'playwright');
    assert.equal(connection.sessionIsolation, 'isolated');
    assert.match(connection.warning, /does not share cookies or login state/);
    assert.match(connection.warning, /OpenFlux in-app browser/);
    assert.match(connection.warning, /cannot establish whether either existing browser is logged in/);
    const status = data(await h.tool.execute({ action: 'status' }));
    assert.equal(status.sessionIsolation, 'isolated');
    await h.tool.execute({ action: 'connect' });
    assert.equal(h.launches, 1);
    assert.equal(h.pages.length, 1);
    assert.equal(h.connections, 0);
});

test('existing CDP connection does not claim it created an isolated Playwright context', async () => {
    const h = harness(true);
    const connection = data(await h.tool.execute({ action: 'connect' }));
    assert.equal(connection.mode, 'cdp');
    assert.equal(connection.sessionIsolation, 'cdp-context');
    assert.equal(h.launches, 0);
    assert.equal(h.connections, 1);
});

test('a scheduled CDP fallback cannot resolve an unowned global Page', async () => {
    const h = harness(true);
    data(await h.tool.execute({ action: 'connect' }, { sessionId: 'interactive' }));
    const result = await h.tool.execute(
        { action: 'snapshot', interactive: true },
        { sessionId: 'scheduled', runId: 'scheduled-run', isScheduledTask: true },
    );
    assert.equal(result.success, false);
    assert.match(result.error!, /No browser page for this session/);
});

test('standalone aria snapshot refs drive click and input on exactly the snapshotted Page', async () => {
    const h = harness();
    const session = { sessionId: 'one' };
    data(await h.tool.execute({ action: 'connect' }, session));
    const probes = h.probes;
    const snapshot = data(await h.tool.execute({ action: 'snapshot', interactive: true }, session));
    assert.match(snapshot.snapshot, /\[ref=e\d+\]/);
    const secondSave = Object.entries(snapshot.refs).find(([, value]: [string, any]) => value.role === 'button' && value.nth === 1)![0];
    const textbox = Object.entries(snapshot.refs).find(([, value]: [string, any]) => value.role === 'textbox')![0];
    data(await h.tool.execute({ action: 'clickRef', ref: secondSave, doubleClick: true, button: 'right', modifiers: ['Shift'] }, session));
    data(await h.tool.execute({ action: 'typeRef', ref: textbox, text: 'test input', submit: true }, session));
    const click = h.actions.find(action => action.action === 'dblclick')!;
    assert.equal(click.page, 0);
    assert.equal(click.nth, 1);
    assert.equal(click.name, 'Save');
    assert.equal((click.value as any).button, 'right');
    assert.equal(h.actions.find(action => action.action === 'fill')?.value, 'test input');
    assert.equal(h.actions.find(action => action.action === 'press')?.value, 'Enter');
    assert.equal(h.probes, probes, 'refs must not probe or reconnect to an unrelated CDP browser');
});

test('scheduled fallback calls keep one Page per run and cleanup does not cross run boundaries', async () => {
    const h = harness();
    const firstRun = {
        sessionId: 'scheduled/team_a',
        turnId: 'turn-a',
        runId: 'run-a',
        isScheduledTask: true,
    };
    const secondRun = { ...firstRun, turnId: 'turn-b', runId: 'run-b' };

    assert.equal(h.resolveBrowserPageKey(firstRun), h.resolveBrowserPageKey({ ...firstRun }));
    assert.notEqual(h.resolveBrowserPageKey(firstRun), h.resolveBrowserPageKey(secondRun));

    data(await h.tool.execute({ action: 'connect' }, firstRun));
    data(await h.tool.execute({ action: 'navigate', url: 'https://first.fixture.test' }, firstRun));
    const firstSnapshot = data(await h.tool.execute({ action: 'snapshot', interactive: true }, firstRun));
    const firstRef = Object.keys(firstSnapshot.refs)[0];
    data(await h.tool.execute({ action: 'clickRef', ref: firstRef }, firstRun));
    assert.equal(h.actions.find(action => action.action === 'click')?.page, 0);

    data(await h.tool.execute({ action: 'connect' }, secondRun));
    data(await h.tool.execute({ action: 'navigate', url: 'https://second.fixture.test' }, secondRun));
    const secondSnapshot = data(await h.tool.execute({ action: 'snapshot', interactive: true }, secondRun));
    const secondRef = Object.keys(secondSnapshot.refs)[0];
    data(await h.tool.execute({ action: 'clickRef', ref: secondRef }, secondRun));
    assert.equal(h.actions.filter(action => action.action === 'click').at(-1)?.page, 1);
    assert.equal(h.pages.length, 2, 'a second run must receive a fresh Page');

    await h.cleanupScheduledPages(firstRun.sessionId, firstRun.runId);
    assert.equal(h.pages[0].isClosed(), true);
    assert.equal(h.pages[1].isClosed(), false, 'cleaning run-a must preserve run-b');
    await h.cleanupScheduledPages(secondRun.sessionId, secondRun.runId);
    assert.equal(h.pages[1].isClosed(), true);
});

test('an interactive session never reuses a Page created by an earlier scheduled fallback', async () => {
    const h = harness();
    const scheduled = { sessionId: 'shared', runId: 'scheduled-first', isScheduledTask: true };
    const interactive = { sessionId: 'interactive-after-scheduled' };

    data(await h.tool.execute({ action: 'connect' }, scheduled));
    data(await h.tool.execute({ action: 'navigate', url: 'https://scheduled-first.fixture.test' }, scheduled));
    data(await h.tool.execute({ action: 'connect' }, interactive));
    data(await h.tool.execute({ action: 'navigate', url: 'https://interactive-after.fixture.test' }, interactive));

    assert.equal(h.pages.length, 2);
    assert.equal(h.pages[0].url(), 'https://scheduled-first.fixture.test');
    assert.equal(h.pages[1].url(), 'https://interactive-after.fixture.test');
    await h.cleanupScheduledPages(scheduled.sessionId, scheduled.runId);
    assert.equal(h.pages[0].isClosed(), true);
    assert.equal(h.pages[1].isClosed(), false, 'interactive Page must not inherit scheduled ownership');
});

test('scheduled tabOpen registers ownership before navigation so failed pages are still cleaned up', async () => {
    const failedUrl = 'https://navigation-fails.fixture.test';
    const h = harness(false, failedUrl);
    const scheduled = { sessionId: 'failed-navigation', runId: 'failed-run', isScheduledTask: true };
    data(await h.tool.execute({ action: 'connect' }, scheduled));
    const result = await h.tool.execute({ action: 'tabOpen', url: failedUrl }, scheduled);
    assert.equal(result.success, false);
    assert.match(result.error!, /Fixture navigation failed/);
    assert.equal(h.pages.length, 2);

    await h.cleanupScheduledPages(scheduled.sessionId, scheduled.runId);
    assert.equal(h.pages[0].isClosed(), true);
    assert.equal(h.pages[1].isClosed(), true, 'failed tabOpen Page must retain scheduled ownership');
});

test('scheduled fallback tab operations expose only owned Pages and preserve interactive tabs during cleanup', async () => {
    const h = harness();
    const interactive = { sessionId: 'interactive-session' };
    const firstRun = { sessionId: 'shared-session', runId: 'run-one', isScheduledTask: true };
    const secondRun = { sessionId: 'shared-session', runId: 'run-two', isScheduledTask: true };

    data(await h.tool.execute({ action: 'connect' }, interactive));
    data(await h.tool.execute({ action: 'navigate', url: 'https://interactive.fixture.test' }, interactive));

    data(await h.tool.execute({ action: 'connect' }, firstRun));
    data(await h.tool.execute({ action: 'navigate', url: 'https://run-one.fixture.test' }, firstRun));
    data(await h.tool.execute({ action: 'tabOpen', url: 'https://run-one-extra.fixture.test' }, firstRun));
    const firstTabs = data(await h.tool.execute({ action: 'tabs' }, firstRun));
    assert.equal(
        firstTabs.tabs.map((tab: any) => tab.url).join('|'),
        'https://run-one.fixture.test|https://run-one-extra.fixture.test',
    );
    assert.equal(firstTabs.tabs.map((tab: any) => tab.index).join(','), '0,1');
    const switched = data(await h.tool.execute({ action: 'tabSwitch', tabIndex: 0 }, firstRun));
    assert.equal(switched.url, 'https://run-one.fixture.test');

    data(await h.tool.execute({ action: 'connect' }, secondRun));
    data(await h.tool.execute({ action: 'navigate', url: 'https://run-two.fixture.test' }, secondRun));
    const secondTabs = data(await h.tool.execute({ action: 'tabs' }, secondRun));
    assert.equal(secondTabs.tabs.map((tab: any) => tab.url).join('|'), 'https://run-two.fixture.test');
    const crossRunSwitch = await h.tool.execute({ action: 'tabSwitch', tabIndex: 1 }, secondRun);
    assert.equal(crossRunSwitch.success, false);
    assert.match(crossRunSwitch.error!, /out of range/);

    const crossRunClose = await h.tool.execute({ action: 'tabClose', tabIndex: 2 }, firstRun);
    assert.equal(crossRunClose.success, false);
    assert.match(crossRunClose.error!, /out of range/);
    assert.equal(h.pages[0].isClosed(), false);
    assert.equal(h.pages[3].isClosed(), false);
    data(await h.tool.execute({ action: 'tabClose' }, firstRun));
    assert.equal(h.pages[1].isClosed(), true, 'tabClose without an index closes only the run current Page');

    await h.cleanupScheduledPages(firstRun.sessionId, firstRun.runId);
    assert.equal(h.pages[0].isClosed(), false, 'interactive Page must survive scheduled cleanup');
    assert.equal(h.pages[1].isClosed(), true);
    assert.equal(h.pages[2].isClosed(), true, 'all tabs opened by run-one must be cleaned up');
    assert.equal(h.pages[3].isClosed(), false, 'run-two Page must survive run-one cleanup');

    const interactiveTabs = data(await h.tool.execute({ action: 'tabs' }, interactive));
    assert.equal(interactiveTabs.count, 1);
    assert.equal(interactiveTabs.tabs[0].url, 'https://interactive.fixture.test');
    await h.cleanupScheduledPages(secondRun.sessionId, secondRun.runId);
    assert.equal(h.pages[0].isClosed(), false);
    assert.equal(h.pages[3].isClosed(), true);
});

test('navigate emits standalone refs and frame snapshots retain their frame for subsequent ref actions', async () => {
    const h = harness();
    data(await h.tool.execute({ action: 'connect' }));
    const navigation = data(await h.tool.execute({ action: 'navigate', url: 'https://fixture.test' }));
    assert.match(navigation.snapshot, /\[ref=e\d+\]/);
    const snapshot = data(await h.tool.execute({ action: 'snapshot', frame: '#checkout' }));
    const textbox = Object.entries(snapshot.refs).find(([, value]: [string, any]) => value.role === 'textbox')![0];
    data(await h.tool.execute({ action: 'typeRef', ref: textbox, text: 'slow input', slowly: true }));
    assert.equal(h.actions.find(action => action.action === 'type')?.frame, '#checkout');
    assert.equal(h.actions.find(action => action.action === 'type')?.value, 'slow input');
});

test('a new standalone tab cannot borrow another Page refs, and explicit CDP targets are rejected', async () => {
    const h = harness();
    data(await h.tool.execute({ action: 'connect' }));
    const snapshot = data(await h.tool.execute({ action: 'snapshot' }));
    const ref = Object.keys(snapshot.refs)[0];
    data(await h.tool.execute({ action: 'tabOpen' }));
    const stale = await h.tool.execute({ action: 'clickRef', ref });
    assert.equal(stale.success, false);
    assert.match(stale.error!, /Unknown ref/);
    const wrongTarget = await h.tool.execute({ action: 'snapshot', targetId: 'unrelated-cdp-tab' });
    assert.equal(wrongTarget.success, false);
    assert.match(wrongTarget.error!, /targetId requires a CDP connection/);
    data(await h.tool.execute({ action: 'tabSwitch', tabIndex: 0 }));
    data(await h.tool.execute({ action: 'clickRef', ref }));
    assert.equal(h.actions.find(action => action.action === 'click')?.page, 0);
});

test('a refreshed snapshot replaces prior refs and closed Page targets fail before connection', async () => {
    const h = harness();
    data(await h.tool.execute({ action: 'connect' }));
    data(await h.tool.execute({ action: 'snapshot' }));
    h.pages[0].setTree('- button "Continue"');
    const updated = data(await h.tool.execute({ action: 'snapshot' }));
    assert.equal(Object.keys(updated.refs).length, 1);
    const removedRef = await h.tool.execute({ action: 'typeRef', ref: 'e2', text: 'stale' });
    assert.equal(removedRef.success, false);
    assert.match(removedRef.error!, /Unknown ref/);
    await h.pages[0].close();
    await assert.rejects(browserModule.snapshotRoleViaPlaywright({ cdpUrl: 'http://unused.invalid', page: h.pages[0] }), /page is closed/);
});
