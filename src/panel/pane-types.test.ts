import assert from 'node:assert/strict';
import test from 'node:test';
import {
    activePane,
    createPane,
    nextActiveAfterClose,
    normalizeLayout,
    type PaneKind,
    type PanelLayout,
} from './pane-types';

function layoutOf(kinds: PaneKind[], activeIndex = 0): PanelLayout {
    const panes = kinds.map((kind, index) => createPane(kind, `${kind}-${index}`));
    return { panes, activeId: panes[activeIndex]?.id ?? null };
}

test('activePane resolves the selected tab', () => {
    const layout = layoutOf(['artifacts', 'files'], 1);
    assert.equal(activePane(layout)?.kind, 'files');
});

test('activePane returns null when the active id is stale', () => {
    const layout = layoutOf(['artifacts']);
    layout.activeId = 'gone';
    assert.equal(activePane(layout), null);
});

test('closing the active tab activates its right neighbour', () => {
    const layout = layoutOf(['artifacts', 'files', 'browser'], 1);
    assert.equal(nextActiveAfterClose(layout, 'files-1'), 'browser-2');
});

test('closing the last tab falls back to the left neighbour', () => {
    const layout = layoutOf(['artifacts', 'files', 'browser'], 2);
    assert.equal(nextActiveAfterClose(layout, 'browser-2'), 'files-1');
});

test('closing an inactive tab leaves the selection alone', () => {
    const layout = layoutOf(['artifacts', 'files', 'browser'], 0);
    assert.equal(nextActiveAfterClose(layout, 'browser-2'), 'artifacts-0');
});

test('closing the only tab leaves nothing active', () => {
    const layout = layoutOf(['artifacts']);
    assert.equal(nextActiveAfterClose(layout, 'artifacts-0'), null);
});

test('closing an unknown tab is a no-op', () => {
    const layout = layoutOf(['artifacts', 'files'], 1);
    assert.equal(nextActiveAfterClose(layout, 'nope'), 'files-1');
});

test('normalizeLayout rejects unusable input', () => {
    assert.equal(normalizeLayout(null), null);
    assert.equal(normalizeLayout('{}'), null);
    assert.equal(normalizeLayout({}), null);
    assert.equal(normalizeLayout({ panes: 'nope' }), null);
    assert.equal(normalizeLayout({ panes: [] }), null);
});

test('normalizeLayout drops unknown kinds, duplicates and blank ids', () => {
    const parsed = normalizeLayout({
        panes: [
            { id: 'a', kind: 'artifacts' },
            { id: 'a', kind: 'files' },
            { id: 'b', kind: 'terminal' },
            { id: 'c', kind: 'files' },
            { id: '', kind: 'files' },
        ],
        activeId: 'c',
    });
    assert.deepEqual(parsed?.panes.map(p => [p.id, p.kind]), [['a', 'artifacts'], ['c', 'files']]);
    assert.equal(parsed?.activeId, 'c');
});

test('normalizeLayout falls back to the first tab when activeId is unusable', () => {
    for (const activeId of [undefined, 'dropped', 42]) {
        const parsed = normalizeLayout({
            panes: [{ id: 'a', kind: 'artifacts' }, { id: 'b', kind: 'files' }],
            activeId,
        });
        assert.equal(parsed?.activeId, 'a', `activeId=${String(activeId)}`);
    }
});

test('normalizeLayout honours a restricted kind list', () => {
    const parsed = normalizeLayout(
        { panes: [{ id: 'a', kind: 'artifacts' }, { id: 'b', kind: 'browser' }], activeId: 'b' },
        ['artifacts'],
    );
    assert.deepEqual(parsed?.panes.map(p => p.kind), ['artifacts']);
    assert.equal(parsed?.activeId, 'a', 'an active tab that was dropped falls back to the first');
});
