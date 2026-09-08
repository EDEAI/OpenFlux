import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAbsoluteLocalPath } from './local-file-links';

test('recognizes Windows files and directories with spaces', () => {
    assert.equal(
        parseAbsoluteLocalPath('D:\\openflux_output\\2026-08-12\\PPT output\\deck.pptx'),
        'D:\\openflux_output\\2026-08-12\\PPT output\\deck.pptx',
    );
    assert.equal(
        parseAbsoluteLocalPath('D:\\openflux_output\\2026-08-12\\PPT output'),
        'D:\\openflux_output\\2026-08-12\\PPT output',
    );
});

test('decodes file URLs produced by Markdown renderers', () => {
    assert.equal(
        parseAbsoluteLocalPath('file:///D:/openflux_output/%E6%BC%94%E7%A4%BA%E6%96%87%E7%A8%BF.pdf'),
        'D:/openflux_output/演示文稿.pdf',
    );
});

test('does not treat web URLs or relative paths as local files', () => {
    assert.equal(parseAbsoluteLocalPath('https://openflux.io/file.pdf'), null);
    assert.equal(parseAbsoluteLocalPath('output/deck.pptx'), null);
});
