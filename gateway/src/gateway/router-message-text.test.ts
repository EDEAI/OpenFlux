import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRouterMessageText } from './router-message-text';

test('normalizes transport whitespace in ordinary platform text', () => {
    assert.equal(
        normalizeRouterMessageText('   第一行  \r\n\r\n\r\n      第二行   '),
        '第一行\n\n第二行',
    );
});

test('preserves fenced code indentation', () => {
    assert.equal(
        normalizeRouterMessageText('  说明  \n```ts\n  const value = 1;  \n```\n  完成  '),
        '说明\n```ts\n  const value = 1;\n```\n完成',
    );
});
