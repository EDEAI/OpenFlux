import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Document, Packer, Paragraph } from 'docx';
import { createFileReaderTool } from '../tools/file-reader';
import { extractFileText, getFileCategory, isSupportedFile } from './file-reader';

test('.doc is classified as a supported Word attachment', () => {
    assert.equal(isSupportedFile('.doc'), true);
    assert.equal(getFileCategory('.doc'), 'word');
});

test('.doc attachments use the Word extractor and respect maxChars', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'openflux-doc-reader-'));
    const filePath = join(tempDir, 'sample.doc');

    try {
        // word-extractor selects the parser from the file signature. An OOXML
        // payload with a .doc name gives this test a deterministic document
        // without requiring Microsoft Word in CI.
        const document = new Document({
            sections: [{ children: [new Paragraph('OpenFlux DOC attachment content')] }],
        });
        await writeFile(filePath, await Packer.toBuffer(document));

        const extracted = await extractFileText(filePath, 12);
        assert.equal(extracted.type, 'word');
        assert.equal(extracted.error, undefined);
        assert.equal(extracted.text, 'OpenFlux DOC');
        assert.equal(extracted.truncated, true);

        const toolResult = await createFileReaderTool({ maxChars: 200 }).execute({ path: filePath });
        assert.equal(toolResult.success, true);
        assert.match(String((toolResult.data as { content?: string }).content), /OpenFlux DOC attachment content/);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});
