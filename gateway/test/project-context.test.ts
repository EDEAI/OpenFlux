import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ProjectStore, buildProjectSystemPrompt, isProjectEntityId } from '../src/agent/project-store';
import { createFileSystemTool } from '../src/tools/filesystem';
import { createProcessTool } from '../src/tools/process';
import { createFileReaderTool } from '../src/tools/file-reader';
import { createOpenCodeTool } from '../src/tools/opencode';
import { createCodingAgentTool } from '../src/tools/coding-agent';
import { getProfileToolNames } from '../src/tools/policy';
import { sanitizePublicRuntimeDetails } from '../src/runtime/public-output';
import { PermissionChecker, RiskLevel } from '../src/permissions/checker';
import { ToolRegistry } from '../src/tools/registry';

test('projects persist an existing workspace and compile a code-first runtime prompt', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'openflux-project-store-'));
    const workspace = await mkdtemp(join(tmpdir(), 'openflux-project-root-'));
    try {
        const store = new ProjectStore(dataDir);
        const created = store.create({
            name: '示例项目',
            description: '维护现有应用',
            defaultRules: '修改后必须运行测试',
            workspace,
        });

        assert.equal(created.kind, 'project');
        assert.equal(created.codeFirst, true);
        assert.equal(created.workspace, workspace);
        assert.match(buildProjectSystemPrompt(created), /Python、Node\.js、FFmpeg/);
        assert.match(buildProjectSystemPrompt(created), /只读输入/);
        assert.match(buildProjectSystemPrompt(created), /代码优先执行策略/);
        assert.match(buildProjectSystemPrompt(created), /修改后必须运行测试/);

        const restored = new ProjectStore(dataDir).get(created.id);
        assert.deepEqual(restored, created);
    } finally {
        await rm(dataDir, { recursive: true, force: true });
        await rm(workspace, { recursive: true, force: true });
    }
});

test('project creation rejects a missing directory', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'openflux-project-invalid-'));
    try {
        const store = new ProjectStore(dataDir);
        assert.throws(() => store.create({
            name: '无效项目',
            workspace: join(dataDir, 'does-not-exist'),
        }), /项目目录不存在/);
    } finally {
        await rm(dataDir, { recursive: true, force: true });
    }
});

test('projects always use the fixed directory icon while keeping their selected color', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'openflux-project-icon-store-'));
    const workspace = await mkdtemp(join(tmpdir(), 'openflux-project-icon-root-'));
    try {
        const store = new ProjectStore(dataDir);
        const created = store.create({
            name: 'Fixed icon project',
            workspace,
            icon: '🚀',
            color: '#10b981',
        });
        assert.equal(created.icon, '📁');
        assert.equal(created.color, '#10b981');

        const updated = store.update(created.id, { icon: '🎨', color: '#f97316' });
        assert.equal(updated?.icon, '📁');
        assert.equal(updated?.color, '#f97316');
    } finally {
        await rm(dataDir, { recursive: true, force: true });
        await rm(workspace, { recursive: true, force: true });
    }
});

test('filesystem resolves relative writes against the active project root', async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), 'openflux-project-a-'));
    const secondRoot = await mkdtemp(join(tmpdir(), 'openflux-project-b-'));
    let activeRoot = firstRoot;
    try {
        const tool = createFileSystemTool({
            basePath: () => activeRoot,
            allowedWritePaths: () => [activeRoot],
        });
        await tool.execute({ action: 'write', path: 'marker.txt', content: 'first' });
        activeRoot = secondRoot;
        await tool.execute({ action: 'write', path: 'marker.txt', content: 'second' });

        assert.equal(await readFile(join(firstRoot, 'marker.txt'), 'utf-8'), 'first');
        assert.equal(await readFile(join(secondRoot, 'marker.txt'), 'utf-8'), 'second');
    } finally {
        await rm(firstRoot, { recursive: true, force: true });
        await rm(secondRoot, { recursive: true, force: true });
    }
});

test('project filesystem rejects reads outside the active project root', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'openflux-project-read-root-'));
    const outsideRoot = await mkdtemp(join(tmpdir(), 'openflux-project-read-outside-'));
    const outsideFile = join(outsideRoot, 'private.txt');
    await writeFile(outsideFile, 'private', 'utf-8');
    try {
        const tool = createFileSystemTool({
            basePath: () => projectRoot,
            allowedPaths: () => [projectRoot],
            allowedWritePaths: () => [projectRoot],
        });
        await assert.rejects(
            tool.execute({ action: 'read', path: outsideFile }),
            /Path is not in the whitelist/,
        );
    } finally {
        await rm(projectRoot, { recursive: true, force: true });
        await rm(outsideRoot, { recursive: true, force: true });
    }
});

test('project tools can read an explicitly attached external file without granting its directory', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'openflux-project-attachment-root-'));
    const outsideRoot = await mkdtemp(join(tmpdir(), 'openflux-project-attachment-outside-'));
    const attachment = join(outsideRoot, 'attached.txt');
    const sibling = join(outsideRoot, 'not-attached.txt');
    await writeFile(attachment, 'user supplied input', 'utf-8');
    await writeFile(sibling, 'private sibling', 'utf-8');
    try {
        const allowedReadPaths = () => [projectRoot, attachment];
        const filesystem = createFileSystemTool({
            basePath: () => projectRoot,
            allowedPaths: allowedReadPaths,
            allowedWritePaths: () => [projectRoot],
        });
        const readResult = await filesystem.execute({ action: 'read', path: attachment });
        assert.equal(readResult.success, true);
        await assert.rejects(
            filesystem.execute({ action: 'read', path: sibling }),
            /Path is not in the whitelist/,
        );
        await assert.rejects(
            filesystem.execute({ action: 'write', path: attachment, content: 'overwrite' }),
            /Write path is not in the allowed range/,
        );

        const fileReader = createFileReaderTool({
            basePath: () => projectRoot,
            allowedPaths: allowedReadPaths,
        });
        const documentResult = await fileReader.execute({ path: attachment });
        assert.equal(documentResult.success, true);
    } finally {
        await rm(projectRoot, { recursive: true, force: true });
        await rm(outsideRoot, { recursive: true, force: true });
    }
});

test('project filesystem does not treat a sibling prefix as part of its root', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'openflux-project-prefix-'));
    const projectRoot = join(parent, 'app');
    const siblingRoot = join(parent, 'app-private');
    await mkdir(projectRoot);
    await mkdir(siblingRoot);
    const outsideFile = join(siblingRoot, 'private.txt');
    await writeFile(outsideFile, 'private', 'utf-8');
    try {
        const tool = createFileSystemTool({
            basePath: () => projectRoot,
            allowedPaths: () => [projectRoot],
        });
        await assert.rejects(
            tool.execute({ action: 'read', path: outsideFile }),
            /Path is not in the whitelist/,
        );
    } finally {
        await rm(parent, { recursive: true, force: true });
    }
});

test('project process rejects external paths and secret environment inspection', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'openflux-project-process-root-'));
    const outsideRoot = await mkdtemp(join(tmpdir(), 'openflux-project-process-outside-'));
    const outsideFile = join(outsideRoot, 'private.txt');
    await writeFile(outsideFile, 'private', 'utf-8');
    try {
        const tool = createProcessTool({
            cwd: () => projectRoot,
            allowedCwdPaths: () => [projectRoot],
            pathBoundary: () => projectRoot,
        });
        const readCommand = process.platform === 'win32'
            ? `powershell -Command \"Get-Content '${outsideFile}'\"`
            : `cat '${outsideFile}'`;
        await assert.rejects(
            tool.execute({ action: 'run', command: readCommand }),
            /outside the project workspace/,
        );
        await assert.rejects(
            tool.execute({ action: 'run', command: process.platform === 'win32' ? 'echo $env:OPENAI_API_KEY' : 'echo $OPENAI_API_KEY' }),
            /cannot inspect.*environment variables/,
        );
        await assert.rejects(
            tool.execute({ action: 'run', command: process.platform === 'win32' ? 'cd ..\\outside' : 'cd ../outside' }),
            /cannot traverse outside/,
        );
    } finally {
        await rm(projectRoot, { recursive: true, force: true });
        await rm(outsideRoot, { recursive: true, force: true });
    }
});

test('project process accepts an in-project absolute path containing spaces', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'openflux project process '));
    const file = join(parent, 'local file.txt');
    await writeFile(file, 'local', 'utf-8');
    try {
        const tool = createProcessTool({
            cwd: () => parent,
            allowedCwdPaths: () => [parent],
            pathBoundary: () => parent,
        });
        const command = process.platform === 'win32'
            ? `powershell -NoProfile -Command \"Get-Content '${file}'\"`
            : `cat '${file}'`;
        const result = await tool.execute({ action: 'run', command });
        assert.equal(result.success, true);
    } finally {
        await rm(parent, { recursive: true, force: true });
    }
});

test('project process permits an external runtime executable and an explicitly attached input', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'openflux-project-runtime-root-'));
    const outsideRoot = await mkdtemp(join(tmpdir(), 'openflux-project-runtime-input-'));
    const attachment = join(outsideRoot, 'input.txt');
    await writeFile(attachment, 'runtime input', 'utf-8');
    try {
        const tool = createProcessTool({
            cwd: () => projectRoot,
            allowedCwdPaths: () => [projectRoot],
            pathBoundary: () => projectRoot,
            allowedExternalPaths: () => [attachment],
        });
        const runtimeOnly = await tool.execute({
            action: 'run',
            command: `"${process.execPath}" -e "process.stdout.write('runtime-ok')"`,
        });
        assert.equal(runtimeOnly.success, true);
        assert.equal((runtimeOnly.data as { stdout?: string }).stdout, 'runtime-ok');

        const readAttachment = await tool.execute({
            action: 'run',
            command: `"${process.execPath}" -e "process.stdout.write(require('fs').readFileSync(process.argv[1], 'utf8'))" "${attachment}"`,
        });
        assert.equal(readAttachment.success, true);
        assert.equal((readAttachment.data as { stdout?: string }).stdout, 'runtime input');
    } finally {
        await rm(projectRoot, { recursive: true, force: true });
        await rm(outsideRoot, { recursive: true, force: true });
    }
});

test('external project runtimes still obey the selected approval mode', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'openflux-project-runtime-approval-'));
    try {
        const registry = new ToolRegistry({
            permissionChecker: new PermissionChecker(RiskLevel.Low),
        });
        registry.register(createProcessTool({
            cwd: () => projectRoot,
            allowedCwdPaths: () => [projectRoot],
            pathBoundary: () => projectRoot,
        }));
        const args = {
            action: 'run',
            command: `"${process.execPath}" -e "process.stdout.write('approved-runtime')"`,
        };

        for (const approvalMode of ['ask', 'risk_based'] as const) {
            const denied = await registry.executeTool('process', args, { approvalMode });
            assert.equal(denied.success, false);
            assert.match(denied.error || '', /Interactive approval is required/);
        }

        let approvalRequests = 0;
        const approved = await registry.executeTool('process', args, {
            approvalMode: 'risk_based',
            requestApproval: async request => {
                approvalRequests += 1;
                assert.equal(request.riskLabel, 'medium');
                return 'approved';
            },
        });
        assert.equal(approved.success, true);
        assert.equal(approvalRequests, 1);

        const fullAccess = await registry.executeTool('process', args, {
            approvalMode: 'full_access',
            requestApproval: async () => {
                throw new Error('full access should not request approval for a medium-risk process');
            },
        });
        assert.equal(fullAccess.success, true);
    } finally {
        await rm(projectRoot, { recursive: true, force: true });
    }
});

test('project document and coding tools reject explicit outside directories', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'openflux-project-tools-root-'));
    const outsideRoot = await mkdtemp(join(tmpdir(), 'openflux-project-tools-outside-'));
    const outsideFile = join(outsideRoot, 'private.md');
    await writeFile(outsideFile, '# private', 'utf-8');
    try {
        const fileReader = createFileReaderTool({
            basePath: () => projectRoot,
            allowedPaths: () => [projectRoot],
        });
        await assert.rejects(
            fileReader.execute({ path: outsideFile }),
            /outside the project workspace/,
        );

        const openCode = createOpenCodeTool({
            cwd: () => projectRoot,
            allowedCwdPaths: () => [projectRoot],
        });
        await assert.rejects(
            openCode.execute({ action: 'status', cwd: outsideRoot }),
            /outside the project workspace/,
        );

        const codingAgent = createCodingAgentTool({
            defaultCwd: () => projectRoot,
            allowedCwdPaths: () => [projectRoot],
        });
        await assert.rejects(
            codingAgent.execute({ action: 'status', driver: 'codex', cwd: outsideRoot }),
            /outside the project workspace/,
        );
    } finally {
        await rm(projectRoot, { recursive: true, force: true });
        await rm(outsideRoot, { recursive: true, force: true });
    }
});

test('public output hides concrete runtime and internal configuration model identifiers', () => {
    const sanitized = sanitizePublicRuntimeDetails(
        '主编排 LLM：moonshot / kimi-k2.5\n备用 LLM：deepseek-chat',
        [{ provider: 'moonshot', model: 'kimi-k2.5' }],
        'zh-CN',
    );
    assert.doesNotMatch(sanitized, /moonshot|kimi-k2\.5|deepseek-chat/i);
    assert.match(sanitized, /内部信息不展示|内部模型/);

    const ordinaryDiscussion = sanitizePublicRuntimeDetails(
        '新闻中提到了 moonshot 公司。',
        [{ provider: 'moonshot', model: 'kimi-k2.5' }],
        'zh-CN',
    );
    assert.match(ordinaryDiscussion, /moonshot/);
});

test('coding profile exposes the coding-agent driver', () => {
    assert.ok(getProfileToolNames('coding').includes('coding_agent'));
});

test('project identifiers remain distinguishable from legacy Agent session migrations', () => {
    assert.equal(isProjectEntityId('project-1234abcd'), true);
    assert.equal(isProjectEntityId('main'), false);
});
