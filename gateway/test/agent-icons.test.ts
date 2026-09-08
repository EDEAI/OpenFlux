import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import {
    AGENT_ICON_OPTIONS,
    DEFAULT_AGENT_ICON,
    getAgentIconAssetName,
    normalizeAgentIcon,
    renderAgentVectorIcon,
} from '../../src/agent-icons';
import { renderAgentIcon } from '../../src/utils/format';

const legacyIconMappings: ReadonlyArray<readonly [string, string]> = [
    ['🤖', 'tabler:robot'],
    ['💬', 'tabler:message-chatbot'],
    ['🧠', 'tabler:brain'],
    ['💡', 'tabler:bulb'],
    ['🎨', 'tabler:palette'],
    ['🔧', 'tabler:tool'],
    ['🛠', 'tabler:tool'],
    ['🛠️', 'tabler:tool'],
    ['💻', 'tabler:code'],
    ['📊', 'tabler:chart-bar'],
    ['📝', 'tabler:pencil'],
    ['🔍', 'tabler:search'],
    ['🚀', 'tabler:rocket'],
    ['⚡', 'tabler:bolt'],
    ['🎯', 'tabler:target-arrow'],
    ['🛡', 'tabler:shield-check'],
    ['🛡️', 'tabler:shield-check'],
    ['📚', 'tabler:book-2'],
    ['🎵', 'tabler:music'],
    ['🌐', 'tabler:world'],
    ['🤝', 'tabler:users-group'],
    ['👨‍💻', 'tabler:terminal-2'],
    ['🧑‍💻', 'tabler:terminal-2'],
    ['🦾', 'tabler:automation'],
    // Older session-to-Agent migration and project records used these values.
    ['📁', 'tabler:folder'],
    ['🏪', 'tabler:building-store'],
    ['🛍', 'tabler:shopping-bag'],
    ['🛍️', 'tabler:shopping-bag'],
    ['💼', 'tabler:briefcase'],
];

test('Agent icon catalog exposes 20 stable choices backed by vendored SVG assets', () => {
    assert.equal(DEFAULT_AGENT_ICON, 'tabler:robot');
    assert.equal(AGENT_ICON_OPTIONS.length, 20);
    assert.equal(new Set(AGENT_ICON_OPTIONS.map(option => option.id)).size, 20);
    assert.equal(new Set(AGENT_ICON_OPTIONS.map(option => option.assetName)).size, 20);

    for (const option of AGENT_ICON_OPTIONS) {
        assert.match(option.id, /^tabler:[a-z0-9-]+$/);
        assert.equal(normalizeAgentIcon(option.id), option.id);
        assert.equal(getAgentIconAssetName(option.id), option.assetName);
        const assetUrl = new URL(`../../public/agent-icons/tabler/${option.assetName}.svg`, import.meta.url);
        assert.equal(existsSync(assetUrl), true, `${option.id} must have a vendored SVG`);
        assert.match(readFileSync(assetUrl, 'utf8'), /<svg\b/);
        assert.match(renderAgentVectorIcon(option.id, 24) || '', new RegExp(`/${option.assetName}\\.svg`));
    }

    assert.equal(existsSync(new URL('../../public/agent-icons/tabler/LICENSE.txt', import.meta.url)), true);
    assert.equal(existsSync(new URL('../../public/agent-icons/tabler/SOURCE.txt', import.meta.url)), true);
});

test('every former picker and historical migration emoji resolves to its Tabler replacement', () => {
    for (const [legacyValue, stableId] of legacyIconMappings) {
        assert.equal(normalizeAgentIcon(legacyValue), stableId, `legacy value ${legacyValue}`);
        const assetName = getAgentIconAssetName(stableId);
        assert.ok(assetName, `${stableId} must remain renderable`);
        const rendered = renderAgentVectorIcon(legacyValue, 20) || '';
        assert.match(rendered, new RegExp(`/agent-icons/tabler/${assetName}\\.svg`));
        assert.doesNotMatch(rendered, new RegExp(legacyValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
});

test('uploaded Agent images remain images while unknown persisted strings are escaped as text', t => {
    const dom = new JSDOM('<div id="host"></div>');
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', {
        value: dom.window.document,
        configurable: true,
        writable: true,
    });
    t.after(() => {
        if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
        else Reflect.deleteProperty(globalThis, 'document');
        dom.window.close();
    });

    const uploaded = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
    assert.equal(normalizeAgentIcon(uploaded), uploaded);
    const imageHtml = renderAgentIcon(uploaded, 32);
    const host = dom.window.document.querySelector<HTMLElement>('#host')!;
    host.innerHTML = imageHtml;
    const image = host.querySelector<HTMLImageElement>('img');
    assert.ok(image);
    assert.equal(image?.getAttribute('src'), uploaded);
    assert.equal(image?.getAttribute('alt'), '');
    assert.equal(image?.style.width, '32px');
    assert.equal(host.textContent, '');

    const unknown = '<img src=x onerror="globalThis.compromised=true"><script>bad()</script>&';
    const escapedHtml = renderAgentIcon(unknown, 24);
    host.innerHTML = escapedHtml;
    assert.equal(host.querySelector('img, script'), null);
    assert.equal(host.textContent, unknown);
    assert.doesNotMatch(escapedHtml, /<img|<script/i);

    const unrecognizedEmoji = '🧭';
    assert.equal(renderAgentIcon(unrecognizedEmoji), unrecognizedEmoji);
});
