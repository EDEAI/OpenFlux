import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    ProjectStore,
    buildProjectSystemPrompt,
    normalizeExtraWorkspaces,
    projectWorkspaceRoots,
} from '../src/agent/project-store';
import { createFileSystemTool } from '../src/tools/filesystem';
import { createProjectSearchTool } from '../src/tools/project-search';
import { createProcessTool } from '../src/tools/process';

async function tempDirs(...names: string[]): Promise<string[]> {
    return Promise.all(names.map(name => mkdtemp(join(tmpdir(), `openflux-${name}-`))));
}

test('projects keep a primary directory plus validated, de-duplicated extra directories', async () => {
    const [dataDir, primary, second, third] = await tempDirs('project-store', 'primary', 'second', 'third');
    try {
        const store = new ProjectStore(dataDir);
        const created = store.create({
            name: '多目录项目',
            workspace: primary,
            // Primary repeated and the second directory duplicated: both collapse.
            extraWorkspaces: [second, primary, second, '  '],
        });
        assert.equal(created.workspace, primary);
        assert.deepEqual(created.extraWorkspaces, [second]);
        assert.deepEqual(projectWorkspaceRoots(created), [primary, second]);

        const prompt = buildProjectSystemPrompt(created);
        assert.match(prompt, /主目录：/);
        assert.match(prompt, /附加目录：/);
        assert.ok(prompt.includes(second));

        // Promote the second directory to primary: the old primary becomes an extra.
        const updated = store.update(created.id, { workspace: second, extraWorkspaces: [primary, third] });
        assert.equal(updated?.workspace, second);
        assert.deepEqual(updated?.extraWorkspaces, [primary, third]);

        // Changing only the primary re-validates the extra list against it.
        const promoted = store.update(created.id, { workspace: third });
        assert.equal(promoted?.workspace, third);
        assert.deepEqual(promoted?.extraWorkspaces, [primary]);

        // Persisted JSON drops undefined optional fields; compare the same shape.
        const restored = new ProjectStore(dataDir).get(created.id);
        assert.deepEqual(restored, JSON.parse(JSON.stringify(promoted)));
        const raw = JSON.parse(await readFile(join(dataDir, 'projects.json'), 'utf-8')) as { projects: Array<{ extraWorkspaces?: string[] }> };
        assert.deepEqual(raw.projects[0].extraWorkspaces, [primary]);
    } finally {
        await Promise.all([dataDir, primary, second, third].map(dir => rm(dir, { recursive: true, force: true })));
    }
});

test('extra directories must exist and legacy records without the field still load', async () => {
    const [dataDir, primary] = await tempDirs('project-legacy', 'primary');
    try {
        assert.throws(() => normalizeExtraWorkspaces(primary, [join(primary, 'missing')]), /项目目录不存在/);
        assert.deepEqual(normalizeExtraWorkspaces(primary, undefined), []);
        assert.deepEqual(normalizeExtraWorkspaces(primary, [primary]), []);

        await writeFile(join(dataDir, 'projects.json'), JSON.stringify({
            version: 1,
            projects: [{
                id: 'project-legacy1', kind: 'project', name: 'legacy', workspace: primary,
                codeFirst: true, status: 'active', createdAt: 1, updatedAt: 1,
            }],
        }), 'utf-8');
        const legacy = new ProjectStore(dataDir).get('project-legacy1');
        assert.deepEqual(legacy?.extraWorkspaces, []);
        assert.equal(buildProjectSystemPrompt(legacy!).includes('附加目录'), false);
    } finally {
        await Promise.all([dataDir, primary].map(dir => rm(dir, { recursive: true, force: true })));
    }
});

test('filesystem writes default to the primary directory but may target an extra directory', async () => {
    const [primary, extra, outside] = await tempDirs('fs-primary', 'fs-extra', 'fs-outside');
    try {
        const roots = [primary, extra];
        const tool = createFileSystemTool({
            basePath: () => primary,
            allowedPaths: () => roots,
            allowedWritePaths: () => roots,
        });
        await tool.execute({ action: 'write', path: 'in-primary.txt', content: 'primary' });
        assert.equal(await readFile(join(primary, 'in-primary.txt'), 'utf-8'), 'primary');

        await tool.execute({ action: 'write', path: join(extra, 'in-extra.txt'), content: 'extra' });
        assert.equal(await readFile(join(extra, 'in-extra.txt'), 'utf-8'), 'extra');

        const read = await tool.execute({ action: 'read', path: join(extra, 'in-extra.txt') });
        assert.equal(read.success, true);

        await assert.rejects(
            tool.execute({ action: 'write', path: join(outside, 'nope.txt'), content: 'x' }),
            /not in the whitelist|not in the allowed range/,
        );
    } finally {
        await Promise.all([primary, extra, outside].map(dir => rm(dir, { recursive: true, force: true })));
    }
});

test('project search walks every project directory and reports extra-root hits as absolute paths', async () => {
    const [primary, extra] = await tempDirs('search-primary', 'search-extra');
    try {
        await writeFile(join(primary, 'alpha.ts'), 'export const needle = 1;', 'utf-8');
        await mkdir(join(extra, 'src'));
        await writeFile(join(extra, 'src', 'beta.ts'), 'const needle = 2;', 'utf-8');
        const tool = createProjectSearchTool({ basePath: () => primary, extraRoots: () => [extra] });

        const files = await tool.execute({ action: 'files', query: '*.ts' });
        const paths = ((files.data as { results: Array<{ path: string }> }).results).map(item => item.path);
        assert.ok(paths.includes('alpha.ts'));
        assert.ok(paths.includes(join(extra, 'src', 'beta.ts')));

        const content = await tool.execute({ action: 'content', query: 'needle' });
        assert.equal((content.data as { results: unknown[] }).results.length, 2);

        // An absolute path inside an extra directory narrows the search there.
        const scoped = await tool.execute({ action: 'files', query: '*.ts', path: join(extra, 'src') });
        assert.deepEqual(((scoped.data as { results: Array<{ path: string }> }).results).map(item => item.path), [join(extra, 'src', 'beta.ts')]);

        const outside = await tool.execute({ action: 'files', query: '*', path: tmpdir() });
        assert.equal(outside.success, false);
    } finally {
        await Promise.all([primary, extra].map(dir => rm(dir, { recursive: true, force: true })));
    }
});

test('project commands may reference files in an extra directory', async () => {
    const [primary, extra] = await tempDirs('proc-primary', 'proc-extra');
    const extraFile = join(extra, 'notes.txt');
    await writeFile(extraFile, 'shared', 'utf-8');
    try {
        const tool = createProcessTool({
            cwd: () => primary,
            allowedCwdPaths: () => [primary, extra],
            pathBoundary: () => primary,
            allowedExternalPaths: () => [extra],
        });
        const command = process.platform === 'win32'
            ? `powershell -Command "Get-Content '${extraFile}'"`
            : `cat '${extraFile}'`;
        const result = await tool.execute({ action: 'run', command, cwd: extra });
        assert.equal(result.success, true, JSON.stringify(result));
        assert.match(JSON.stringify(result.data), /shared/);
    } finally {
        await Promise.all([primary, extra].map(dir => rm(dir, { recursive: true, force: true })));
    }
});

test('project_search and wait are read-only for approval purposes', async () => {
    const { PermissionChecker, RiskLevel } = await import('../src/permissions/checker');
    const checker = new PermissionChecker();
    assert.equal(checker.assess('project_search', { action: 'content', query: 'x' }).level, RiskLevel.None);
    assert.equal(checker.assess('wait', { seconds: 5 }).level, RiskLevel.None);
});
