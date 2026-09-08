import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { setArtifactPanelExpanded } from '../../src/chat/artifact-panel-state';

test('collapsing the artifact panel clears a resize width that would keep it visible', () => {
    const dom = new JSDOM('<aside class="artifacts-panel" style="width: 384px"></aside>');
    const panel = dom.window.document.querySelector<HTMLElement>('.artifacts-panel');
    assert.ok(panel);

    setArtifactPanelExpanded(panel, false, '384');

    assert.equal(panel.classList.contains('collapsed'), true);
    assert.equal(panel.style.width, '');
});

test('expanding the artifact panel restores a valid saved width', () => {
    const dom = new JSDOM('<aside class="artifacts-panel collapsed"></aside>');
    const panel = dom.window.document.querySelector<HTMLElement>('.artifacts-panel');
    assert.ok(panel);

    setArtifactPanelExpanded(panel, true, '420');

    assert.equal(panel.classList.contains('collapsed'), false);
    assert.equal(panel.style.width, '420px');
});

test('artifact discovery updates content without automatically opening the right panel', () => {
    const source = readFileSync(new URL('../../src/main.ts', import.meta.url), 'utf8');
    const addStart = source.indexOf('async function addArtifact(');
    const addEnd = source.indexOf('/** Build one row for `artifact`', addStart);
    assert.ok(addStart >= 0 && addEnd > addStart);
    const addBody = source.slice(addStart, addEnd);

    assert.doesNotMatch(addBody, /panelPanes\.ensure\(['"]artifacts['"]\)/);
    assert.doesNotMatch(addBody, /setArtifactPanelExpanded\(/);
    assert.match(addBody, /insertArtifactItem\(view, artifact\)/);

    const completionStart = source.indexOf('// (artifacts');
    const completionEnd = source.indexOf('// ========== ==========', completionStart);
    assert.ok(completionStart >= 0 && completionEnd > completionStart);
    assert.match(source.slice(completionStart, completionEnd), /clearArtifacts\(false\)/);
});
