import assert from 'node:assert/strict';
import test from 'node:test';
import { canOpenBrowserInPanel, prepareBrowserInPanel, resolveBrowserSessionRoute } from '../../src/panel/browser-session-routing';

test('embedded browser accepts only the conversation whose panel is mounted', () => {
    assert.deepEqual(resolveBrowserSessionRoute('conversation-a', 'conversation-a'), {
        sessionId: 'conversation-a',
    });
    assert.match(
        (resolveBrowserSessionRoute('conversation-a', 'conversation-b') as { error: string }).error,
        /requested conversation-a, active conversation-b/,
    );
});

test('embedded browser rejects unbound and no-active-conversation requests', () => {
    assert.match((resolveBrowserSessionRoute(undefined, 'conversation-a') as { error: string }).error, /missing/);
    assert.match((resolveBrowserSessionRoute('conversation-a', null) as { error: string }).error, /active none/);
});

test('opening a browser tab requires the pane scope to have caught up with the selected conversation', () => {
    assert.equal(canOpenBrowserInPanel('conversation-b', 'conversation-b', 'conversation-b'), true);
    assert.equal(canOpenBrowserInPanel('conversation-b', 'conversation-b', 'conversation-a'), false);
    assert.equal(canOpenBrowserInPanel('conversation-b', 'conversation-a', 'conversation-a'), false);
});

test('preparing an existing browser tab synchronizes its scope, activates it and expands the panel', () => {
    let currentSession = 'conversation-b';
    let panelScope = 'conversation-a';
    const calls: string[] = [];

    const prepared = prepareBrowserInPanel('conversation-b', 'browser-pane-1', {
        currentSession: () => currentSession,
        panelScope: () => panelScope,
        syncScope: () => { calls.push('sync'); panelScope = currentSession; },
        activatePane: paneId => calls.push(`activate:${paneId}`),
        expandPanel: () => calls.push('expand'),
    });

    assert.equal(prepared, true);
    assert.deepEqual(calls, ['sync', 'activate:browser-pane-1', 'expand']);
});

test('preparing a browser tab aborts if the visible conversation changes during scope sync', () => {
    let currentSession = 'conversation-b';
    let panelScope = 'conversation-a';
    const calls: string[] = [];

    const prepared = prepareBrowserInPanel('conversation-b', 'browser-pane-1', {
        currentSession: () => currentSession,
        panelScope: () => panelScope,
        syncScope: () => {
            calls.push('sync');
            currentSession = 'conversation-c';
            panelScope = currentSession;
        },
        activatePane: paneId => calls.push(`activate:${paneId}`),
        expandPanel: () => calls.push('expand'),
    });

    assert.equal(prepared, false);
    assert.deepEqual(calls, ['sync']);
});
