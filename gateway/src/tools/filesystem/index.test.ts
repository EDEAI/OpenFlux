import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createFileSystemTool } from './index';

test('listing a directory that does not exist is an empty state, not a failed task step', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'openflux-filesystem-list-'));
    try {
        const missing = join(root, 'not-created-yet');
        const result = await createFileSystemTool({
            basePath: root,
            allowedPaths: [root],
            allowedWritePaths: [root],
        }).execute({ action: 'list', path: missing });

        assert.equal(result.success, true);
        assert.deepEqual(result.data, {
            path: missing,
            exists: false,
            count: 0,
            entries: [],
        });
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});
