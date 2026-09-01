import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { ToolRegistry } from '../tools/registry';
import {
    GitWorktreeSession,
    OpenFluxEnterpriseRuntimeWorker,
    type EnterpriseRuntimeConfig,
    type TaskEnvelope,
} from './enterprise-runtime';

const execFileAsync = promisify(execFile);

function config(root: string, repositoryPath: string): EnterpriseRuntimeConfig {
    return {
        osUrl: 'http://os.test',
        studioUrl: 'http://studio.test',
        tenantId: 'team:1',
        runtimeId: 'enterprise-runtime-test',
        runtimeToken: 'runtime-token',
        studioRuntimeToken: 'studio-runtime-token',
        worktreeRoot: join(root, 'worktrees'),
        repositories: [{
            repository_ref: 'fixture-repo',
            repository_path: repositoryPath,
            base_ref: 'HEAD',
        }],
        maxIterations: 4,
        maxToolCalls: 4,
        commandTimeoutMs: 10_000,
    };
}

function envelope(repositoryPath: string): TaskEnvelope {
    return {
        task_id: 'TASK-1',
        run_id: 'RUN-1',
        trace_id: 'TRACE-1',
        action: {
            action_definition_id: 'ACTION-1',
            project_id: 'PROJECT-1',
            runtime_target: 'openflux_enterprise_runtime',
            work_mode: 'ai_execute',
            work_package_context: { work_package_id: 'WP-1', plan_revision: 1 },
            automation_eligibility: 'conditional',
            output_data_ids: ['DATA-OUT'],
            artifact_requirements: ['change_set', 'test_report'],
            workspace_spec: {
                isolation: 'git_worktree',
                repository_ref: 'fixture-repo',
                repository_path: repositoryPath,
                base_ref: 'HEAD',
                allowed_write_paths: [
                    'README.md',
                    'docs/runtime-test/RUNTIME-RESULT.md',
                ],
                cleanup_policy: 'preserve_for_audit',
            },
        },
        input_data: { requirement: '更新说明文件' },
        evidence_requirements: ['EVIDENCE-CODE'],
        lease: { lease_id: 'LEASE-1', state_version: 2 },
    };
}

test('Enterprise Runtime uses an isolated worktree and records a real change set', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openflux-enterprise-runtime-'));
    const repositoryPath = join(root, 'repository');
    await mkdir(repositoryPath, { recursive: true });
    try {
        await execFileAsync('git', ['-C', repositoryPath, 'init']);
        await execFileAsync('git', ['-C', repositoryPath, 'config', 'user.email', 'runtime-test@example.com']);
        await execFileAsync('git', ['-C', repositoryPath, 'config', 'user.name', 'Runtime Test']);
        await writeFile(join(repositoryPath, 'README.md'), '# Fixture\n', 'utf8');
        await execFileAsync('git', ['-C', repositoryPath, 'add', 'README.md']);
        await execFileAsync('git', ['-C', repositoryPath, 'commit', '-m', 'fixture']);

        const session = await GitWorktreeSession.create(config(root, repositoryPath), envelope(repositoryPath));
        const tools = session.tools();
        const write = await tools.executeTool('filesystem', {
            action: 'write',
            path: 'README.md',
            content: '# Fixture\n\n真实 Runtime 已修改。\n',
        }, { approvalMode: 'full_access' });
        assert.equal(write.success, true);
        assert.equal(await readFile(join(repositoryPath, 'README.md'), 'utf8'), '# Fixture\n');
        assert.match(await readFile(join(session.root, 'README.md'), 'utf8'), /真实 Runtime/);
        const newFile = await tools.executeTool('filesystem', {
            action: 'write',
            path: 'docs/runtime-test/RUNTIME-RESULT.md',
            content: '# Runtime Result\n\n由真实隔离工作区生成。\n',
        }, { approvalMode: 'full_access' });
        assert.equal(newFile.success, true);

        const outside = await tools.executeTool('filesystem', {
            action: 'read',
            path: join(root, 'outside.txt'),
        }, { approvalMode: 'full_access' });
        assert.equal(outside.success, false);
        const unplanned = await tools.executeTool('filesystem', {
            action: 'write',
            path: 'UNPLANNED.md',
            content: '不应写入',
        }, { approvalMode: 'full_access' });
        assert.equal(unplanned.success, false);

        const combined = await tools.executeTool('process', {
            action: 'run',
            command: 'git status & echo unsafe',
        }, { approvalMode: 'full_access' });
        assert.equal(combined.success, false);

        const status = await tools.executeTool('process', {
            action: 'run',
            command: 'git',
            args: ['status', '--short'],
        }, { approvalMode: 'full_access' });
        assert.equal(status.success, true);

        const completion = await session.complete('完成低风险说明文件修改');
        assert.ok(completion.changeSet);
        assert.deepEqual(
            completion.changeSet?.changed_files.map(item => item.path).sort(),
            ['README.md', 'docs/runtime-test/RUNTIME-RESULT.md'],
        );
        assert.equal(completion.changeSet?.metadata.commit_created, false);
        assert.equal(completion.changeSet?.metadata.push_performed, false);
        assert.equal(completion.changeSet?.metadata.runtime_id, 'enterprise-runtime-test');
        assert.equal(completion.artifacts[0].artifact_type, 'deliverable');
        assert.equal(completion.artifacts[1].artifact_type, 'test_report');

        const downstreamEnvelope = envelope(repositoryPath);
        downstreamEnvelope.task_id = 'TASK-2';
        downstreamEnvelope.execution_context = {
            change_sets: [completion.changeSet],
        };
        const downstream = await GitWorktreeSession.create(
            config(root, repositoryPath),
            downstreamEnvelope,
        );
        assert.match(await readFile(join(downstream.root, 'README.md'), 'utf8'), /真实 Runtime/);
        assert.match(
            await readFile(join(downstream.root, 'docs/runtime-test/RUNTIME-RESULT.md'), 'utf8'),
            /真实隔离工作区/,
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('Enterprise Runtime executes bounded model tool calls and completes the OS task', async () => {
    const task = envelope('D:\\fixture-repo');
    task.evidence_requirements = ['EVIDENCE-CODE', 'EVIDENCE-AUDIT'];
    const calls: Record<string, any> = { registered: 0, completed: null, failed: null, turns: 0 };
    const os = {
        async register() { calls.registered += 1; return {}; },
        async heartbeat() { return {}; },
        async leaseNext() { return task; },
        async executionState() { return { directive: 'continue', reason: '允许继续执行' }; },
        async complete(_envelope: TaskEnvelope, body: Record<string, any>) {
            calls.completed = body;
            return { status: 'waiting_human' };
        },
        async fail(_envelope: TaskEnvelope, error: unknown) { calls.failed = error; return {}; },
    };
    const studio = {
        async turn() {
            calls.turns += 1;
            if (calls.turns === 1) {
                return {
                    content: '写入文件',
                    complete: false,
                    result_summary: '',
                    output_data: {},
                    tool_calls: [{ id: 'CALL-1', name: 'filesystem', arguments: { action: 'write', path: 'README.md' } }],
                };
            }
            return {
                content: '完成',
                complete: true,
                result_summary: '已完成真实文件修改',
                output_data: { 'DATA-OUT': { changed: true } },
                tool_calls: [],
                usage: { total_tokens: 12 },
            };
        },
    };
    const registry = new ToolRegistry();
    registry.register({
        name: 'filesystem',
        description: '测试文件工具',
        parameters: { action: { type: 'string', description: '动作', required: true } },
        async execute() { return { success: true, data: { written: true } }; },
    });
    const workspace = {
        root: 'D:\\runtime-worktree',
        tools: () => registry,
        async complete() {
            return {
                executionDigest: 'a'.repeat(64),
                artifacts: [
                    {
                        artifact_type: 'deliverable',
                        name: '变更内容包',
                        ref: 'runtime-test://artifact/bundle',
                        digest: 'f'.repeat(64),
                        size: 20,
                        media_type: 'application/json',
                        metadata: {},
                    },
                    {
                        artifact_type: 'test_report',
                        name: '测试报告',
                        ref: 'runtime-test://artifact/report',
                        digest: 'b'.repeat(64),
                        size: 12,
                        media_type: 'application/json',
                        metadata: {},
                    },
                ],
                changeSet: {
                    repository_ref: 'fixture-repo',
                    base_ref: 'HEAD',
                    base_commit: '1'.repeat(40),
                    head_commit: '1'.repeat(40),
                    changed_files: [{ path: 'README.md', sha256: 'c'.repeat(64) }],
                    patch_digest: 'd'.repeat(64),
                    digest: 'e'.repeat(64),
                    test_summary: { passed: 1, failed: 0 },
                    metadata: { isolation: 'git_worktree' },
                },
            };
        },
    };
    const worker = new OpenFluxEnterpriseRuntimeWorker(
        config('D:\\runtime-root', 'D:\\fixture-repo'),
        {
            os: os as any,
            studio: studio as any,
            createWorkspace: async () => workspace as any,
        },
    );
    await worker.initialize();
    const result = await worker.runOnce();
    assert.equal(result.status, 'completed');
    assert.equal(calls.registered, 1);
    assert.equal(calls.turns, 2);
    assert.equal(calls.failed, null);
    assert.equal(calls.completed.output_data['DATA-OUT'].changed, true);
    assert.equal(calls.completed.evidence[0].metadata.evidence_scope, 'runtime_test');
    assert.equal(calls.completed.evidence[0].ref, 'runtime-test://artifact/bundle');
    assert.equal(calls.completed.evidence[0].digest, 'f'.repeat(64));
    assert.equal(calls.completed.evidence[1].ref, 'runtime-test://artifact/report');
    assert.equal(calls.completed.evidence[1].digest, 'b'.repeat(64));
    assert.equal(calls.completed.change_set.changed_files[0].path, 'README.md');
});
