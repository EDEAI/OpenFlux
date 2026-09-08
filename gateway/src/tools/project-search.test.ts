import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createProjectSearchTool } from './project-search';

test('project search finds names and content without leaving its root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openflux-project-search-'));
    try {
        mkdirSync(join(root, 'src'));
        writeFileSync(join(root, 'src', 'feature.ts'), 'export const planMode = true;\n', 'utf8');
        const tool = createProjectSearchTool({ basePath: root });
        const files = await tool.execute({ action: 'files', query: '*.ts' });
        assert.equal(files.success, true);
        assert.deepEqual((files.data as any).results, [{ path: 'src/feature.ts' }]);
        const content = await tool.execute({ action: 'content', query: 'planMode' });
        assert.equal(content.success, true);
        assert.equal((content.data as any).results[0].line, 1);
        const escaped = await tool.execute({ action: 'files', query: '*', path: '..' });
        assert.equal(escaped.success, false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
