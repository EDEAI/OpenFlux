import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isCachedGroupAttachment, readGroupAttachment } from './group-attachment-reader';

test('cached attachments cannot escape their owning Project and image bytes need no extension', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flux-attachment-test-'));
    try {
        const root = join(dir, 'cache');
        mkdirSync(root);
        const image = join(root, 'image-without-extension');
        writeFileSync(image, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        const outside = join(dir, 'private.txt');
        writeFileSync(outside, 'private');
        assert.equal(isCachedGroupAttachment(root, image), true);
        assert.equal(isCachedGroupAttachment(root, outside), false);
        assert.equal(isCachedGroupAttachment(root, root), false);
        assert.equal(isCachedGroupAttachment(root, join(root, 'missing')), false);
        assert.equal((await readGroupAttachment(image, 'image', 'image')).images?.[0].mimeType, 'image/png');
        assert.equal((await readGroupAttachment(outside, 'private.png', 'image')).success, false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('file follow-ups use native extraction and expose a continuation instead of claiming a truncated file is complete', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flux-file-page-test-'));
    try {
        const path = join(dir, 'notes.txt');
        writeFileSync(path, 'abc'.repeat(10000));
        const first = (await readGroupAttachment(path, 'notes.txt', 'file')).data as any;
        assert.equal(first.truncated, true);
        assert.equal(first.next_offset, 20000);
        const second = (await readGroupAttachment(path, 'notes.txt', 'file', first.next_offset)).data as any;
        assert.equal(second.next_offset, null);
        assert.ok((first.text + second.text).includes('abc'.repeat(10000)));
        assert.equal((await readGroupAttachment(path, 'notes.txt', 'file', -1)).success, false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
