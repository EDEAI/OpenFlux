import assert from 'node:assert/strict';
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
