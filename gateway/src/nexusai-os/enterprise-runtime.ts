import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { ToolRegistry, createFileSystemTool, createProcessTool } from '../tools/registry';
import type { ToolResult } from '../tools/types';

const execFileAsync = promisify(execFile);

export interface RepositoryRegistration {
    repository_ref: string;
    repository_path: string;
    base_ref?: string;
}

export interface EnterpriseRuntimeConfig {
    osUrl: string;
    studioUrl: string;
    tenantId: string;
    runtimeId: string;
    runtimeToken: string;
    studioRuntimeToken: string;
    worktreeRoot: string;
    repositories: RepositoryRegistration[];
    maxIterations?: number;
    maxToolCalls?: number;
    commandTimeoutMs?: number;
}

export interface TaskEnvelope {
    task_id: string;
    run_id: string;
    trace_id: string;
    action: Record<string, any>;
    input_data: Record<string, any>;
    execution_context?: Record<string, any>;
    evidence_requirements: string[];
    lease: { lease_id: string; state_version: number };
}

export interface ModelTurnResult {
    content: string;
    complete: boolean;
    result_summary: string;
    output_data: Record<string, any>;
    tool_calls: Array<{ id: string; name: string; arguments: Record<string, any> }>;
    usage?: Record<string, number>;
}

export interface ChangeSetPayload {
    repository_ref: string;
    base_ref: string;
    base_commit: string;
    head_commit: string;
    changed_files: Array<Record<string, any>>;
    patch_digest: string;
    digest: string;
    test_summary: Record<string, any>;
    metadata: Record<string, any>;
}

interface RequestOptions {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    allowNull?: boolean;
}

function trimUrl(value: string): string {
    return value.replace(/\/+$/, '');
}

function sha256(value: string | Buffer): string {
    return createHash('sha256').update(value).digest('hex');
}

function safeSegment(value: string): string {
    return value.replace(/[^A-Za-z0-9_.-]+/g, '-').slice(0, 160) || 'task';
}

function assertInside(path: string, root: string): void {
    const normalizedRoot = resolve(root);
    const normalizedPath = resolve(path);
    const rel = relative(normalizedRoot, normalizedPath);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error(`路径超出 Runtime 工作区：${path}`);
    }
}

async function requestJson<T>(url: string, options: RequestOptions = {}): Promise<T> {
    const response = await fetch(url, {
        method: options.method || 'GET',
        headers: {
            ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...(options.headers || {}),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok) {
        const message = payload?.error?.message || payload?.detail || payload?.message || text;
        throw new Error(`HTTP ${response.status}: ${message || response.statusText}`);
    }
    if (payload === null && !options.allowNull) throw new Error('服务返回空响应');
    return payload as T;
}

export class NexusAIOSRuntimeClient {
    constructor(private readonly config: EnterpriseRuntimeConfig) {}

    private headers(): Record<string, string> {
        return {
            'X-Tenant-ID': this.config.tenantId,
            'X-Runtime-Token': this.config.runtimeToken,
            'X-Actor-Ref': `runtime:${this.config.runtimeId}`,
        };
    }

    register(): Promise<Record<string, any>> {
        return requestJson(`${trimUrl(this.config.osUrl)}/v1/runtimes/register`, {
            method: 'POST',
            headers: this.headers(),
            body: {
                runtime_id: this.config.runtimeId,
                runtime_type: 'openflux_enterprise_runtime',
                environment: 'test',
                capabilities: ['software.development'],
                metadata: {
                    protocol_version: 'nexusai-os-pull-v1',
                    runtime_build: 'openflux-gateway-dev',
                    execution_surface: 'enterprise_host',
                    gateway_transport: 'direct_https',
                    supervision_mode: 'service_manager',
                    workspace_isolation: true,
                    worker_mode: 'pull',
                    repositories: this.config.repositories.map(item => ({
                        repository_ref: item.repository_ref,
                        repository_path: resolve(item.repository_path),
                        base_ref: item.base_ref || 'HEAD',
                    })),
                },
            },
        });
    }

    heartbeat(): Promise<Record<string, any>> {
        return requestJson(
            `${trimUrl(this.config.osUrl)}/v1/runtimes/${encodeURIComponent(this.config.runtimeId)}/heartbeat`,
            {
                method: 'POST',
                headers: this.headers(),
                body: {
                    status: 'online',
                    capabilities: ['software.development'],
                    metadata: { worker_mode: 'pull', workspace_isolation: true },
                },
            },
        );
    }

    leaseNext(): Promise<TaskEnvelope | null> {
        return requestJson<TaskEnvelope | null>(
            `${trimUrl(this.config.osUrl)}/v1/runtimes/${encodeURIComponent(this.config.runtimeId)}/tasks/lease-next`,
            { method: 'POST', headers: this.headers(), allowNull: true },
        );
    }

    executionState(envelope: TaskEnvelope): Promise<Record<string, any>> {
        const query = new URLSearchParams({
            runtime_id: this.config.runtimeId,
            lease_id: envelope.lease.lease_id,
        });
        return requestJson(
            `${trimUrl(this.config.osUrl)}/v1/tasks/${encodeURIComponent(envelope.task_id)}/execution-state?${query}`,
            { headers: this.headers() },
        );
    }

    complete(envelope: TaskEnvelope, body: Record<string, any>): Promise<Record<string, any>> {
        return requestJson(
            `${trimUrl(this.config.osUrl)}/v1/tasks/${encodeURIComponent(envelope.task_id)}/complete`,
            { method: 'POST', headers: this.headers(), body },
        );
    }

    fail(envelope: TaskEnvelope, error: unknown): Promise<Record<string, any>> {
        const message = error instanceof Error ? error.message : String(error);
        return requestJson(
            `${trimUrl(this.config.osUrl)}/v1/tasks/${encodeURIComponent(envelope.task_id)}/fail`,
            {
                method: 'POST',
                headers: this.headers(),
                body: {
                    runtime_id: this.config.runtimeId,
                    lease_id: envelope.lease.lease_id,
                    state_version: envelope.lease.state_version,
                    idempotency_key: `openflux-fail:${envelope.task_id}:${envelope.lease.state_version}`,
                    failure_type: /暂停|取消|租约|stop/i.test(message) ? 'unsafe_to_retry' : 'unknown',
                    code: /安全|禁止|超出|outside|blocked/i.test(message)
                        ? 'runtime_safety_blocked'
                        : 'enterprise_runtime_failed',
                    message: message.slice(0, 2000),
                    retryable: false,
                    evidence: [],
                },
            },
        );
    }
}

export class StudioRuntimeModelClient {
    constructor(private readonly config: EnterpriseRuntimeConfig) {}

    async turn(projectId: string, payload: Record<string, any>): Promise<ModelTurnResult> {
        const response = await requestJson<Record<string, any>>(
            `${trimUrl(this.config.studioUrl)}/v1/business-design/projects/${encodeURIComponent(projectId)}/runtime/service/model-turn`,
            {
                method: 'POST',
                headers: {
                    'X-Tenant-ID': this.config.tenantId,
                    'X-Runtime-ID': this.config.runtimeId,
                    'X-Runtime-Token': this.config.studioRuntimeToken,
                },
                body: payload,
            },
        );
        if (Number(response.code) !== 0 || !response.data) {
            throw new Error(response.message || response.detail || 'Studio 模型轮次失败');
        }
        return response.data as ModelTurnResult;
    }
}

export interface WorkspaceCompletion {
    changeSet: ChangeSetPayload | null;
    artifacts: Array<Record<string, any>>;
    executionDigest: string;
}

export class GitWorktreeSession {
    readonly root: string;
    readonly baseCommit: string;
    readonly allowedWritePaths: string[];
    private readonly commandLog: Array<Record<string, any>> = [];
    private readonly appliedChangeSets: Array<Record<string, any>> = [];

    private constructor(
        private readonly config: EnterpriseRuntimeConfig,
        readonly envelope: TaskEnvelope,
        readonly repository: RepositoryRegistration,
        root: string,
        baseCommit: string,
        allowedWritePaths: string[],
    ) {
        this.root = root;
        this.baseCommit = baseCommit;
        this.allowedWritePaths = allowedWritePaths;
    }

    static async create(
        config: EnterpriseRuntimeConfig,
        envelope: TaskEnvelope,
    ): Promise<GitWorktreeSession> {
        const spec = envelope.action.workspace_spec || {};
        if (spec.isolation !== 'git_worktree') {
            throw new Error('Enterprise Runtime 任务必须声明 git_worktree 隔离');
        }
        const repositoryRef = String(spec.repository_ref || '');
        const repository = config.repositories.find(item => item.repository_ref === repositoryRef);
        if (!repository) throw new Error(`Runtime 未登记代码库：${repositoryRef}`);
        const registeredPath = resolve(repository.repository_path);
        if (spec.repository_path && resolve(String(spec.repository_path)) !== registeredPath) {
            throw new Error('任务代码库路径与 Runtime 登记路径不一致');
        }
        const baseRef = String(spec.base_ref || repository.base_ref || 'HEAD');
        await mkdir(resolve(config.worktreeRoot), { recursive: true });
        const root = resolve(
            config.worktreeRoot,
            `${safeSegment(envelope.task_id)}-v${Number(envelope.lease.state_version)}`,
        );
        assertInside(root, config.worktreeRoot);
        try {
            await stat(root);
            throw new Error(`隔离工作区已经存在，为保留审计记录拒绝覆盖：${root}`);
        } catch (error: any) {
            if (error?.code !== 'ENOENT') throw error;
        }
        const baseCommit = (
            await execFileAsync('git', ['-C', registeredPath, 'rev-parse', baseRef], {
                windowsHide: true,
                timeout: 30_000,
            })
        ).stdout.trim();
        await execFileAsync('git', ['-C', registeredPath, 'worktree', 'add', '--detach', root, baseCommit], {
            windowsHide: true,
            timeout: 60_000,
        });
        const configuredWritePaths = Array.isArray(spec.allowed_write_paths)
            ? spec.allowed_write_paths.map((item: unknown) => String(item).trim()).filter(Boolean)
            : [];
        if (envelope.action.work_package_context && !configuredWritePaths.length) {
            throw new Error('动态研发任务缺少冻结的 allowed_write_paths，拒绝开放写入能力');
        }
        const allowedWritePaths = configuredWritePaths.length
            ? configuredWritePaths.map((item: string) => {
                if (isAbsolute(item) || item.replace(/\\/g, '/').split('/').includes('..')) {
                    throw new Error(`无效的 Enterprise Runtime 写入路径：${item}`);
                }
                const absolute = resolve(root, item);
                assertInside(absolute, root);
                return absolute;
            })
            : [root];
        const session = new GitWorktreeSession(
            config,
            envelope,
            repository,
            root,
            baseCommit,
            allowedWritePaths,
        );
        await session.applyUpstreamChangeBundles();
        return session;
    }

    private isWriteAllowed(path: string): boolean {
        const absolute = resolve(path);
        return this.allowedWritePaths.some(allowed => absolute === allowed);
    }

    private async applyUpstreamChangeBundles(): Promise<void> {
        const changeSets = Array.isArray(this.envelope.execution_context?.change_sets)
            ? this.envelope.execution_context?.change_sets
            : [];
        for (const changeSet of changeSets) {
            if (String(changeSet?.repository_ref || '') !== this.repository.repository_ref) continue;
            const metadata = changeSet?.metadata || {};
            const bundleRef = String(metadata.bundle_ref || '').trim();
            if (!bundleRef) continue;
            const bundlePath = resolve(bundleRef);
            assertInside(bundlePath, this.config.worktreeRoot);
            const bundleText = await readFile(bundlePath, 'utf8');
            const expectedDigest = String(metadata.bundle_digest || changeSet.patch_digest || '').trim();
            if (expectedDigest && sha256(bundleText) !== expectedDigest) {
                throw new Error(`上游 ChangeSet 内容摘要不匹配：${changeSet.change_set_id || 'unknown'}`);
            }
            const bundle = JSON.parse(bundleText);
            if (String(bundle.repository_ref || '') !== this.repository.repository_ref) {
                throw new Error('上游 ChangeSet 代码库与当前任务不一致');
            }
            if (String(bundle.base_commit || '') !== this.baseCommit) {
                throw new Error('上游 ChangeSet 基线与当前隔离工作区不一致');
            }
            for (const file of Array.isArray(bundle.files) ? bundle.files : []) {
                const normalized = String(file.path || '').replace(/\\/g, '/');
                if (!normalized || file.deleted) {
                    throw new Error('Enterprise Runtime 不允许从上游 ChangeSet 应用删除或空路径');
                }
                const target = resolve(this.root, normalized);
                assertInside(target, this.root);
                if (!this.isWriteAllowed(target)) {
                    throw new Error(`上游 ChangeSet 超出冻结写入范围：${normalized}`);
                }
                const content = Buffer.from(String(file.content_base64 || ''), 'base64');
                if (sha256(content) !== String(file.sha256 || '')) {
                    throw new Error(`上游 ChangeSet 文件摘要不匹配：${normalized}`);
                }
                await mkdir(dirname(target), { recursive: true });
                await writeFile(target, content);
            }
            this.appliedChangeSets.push({
                change_set_id: changeSet.change_set_id || '',
                digest: changeSet.digest || '',
                bundle_ref: bundlePath,
            });
        }
    }

    tools(): ToolRegistry {
        const registry = new ToolRegistry();
        const filesystem = createFileSystemTool({
            allowDelete: false,
            allowedPaths: [this.root],
            allowedWritePaths: this.allowedWritePaths,
            basePath: this.root,
            maxWriteSize: 2 * 1024 * 1024,
        });
        registry.register({
            ...filesystem,
            description: '仅在当前隔离 Git 工作区读取、列出或写入文件。禁止删除和越界访问。',
            parameters: {
                ...filesystem.parameters,
                action: { ...filesystem.parameters.action, enum: ['read', 'write', 'list', 'exists', 'info'] },
            },
            execute: async (args, context) => {
                if (!['read', 'write', 'list', 'exists', 'info'].includes(String(args.action || ''))) {
                    return { success: false, error: 'Enterprise Runtime 禁止该文件操作' };
                }
                if (String(args.action || '') === 'write') {
                    const target = resolve(this.root, String(args.path || ''));
                    if (!this.isWriteAllowed(target)) {
                        return { success: false, error: '文件不在冻结需求的 allowed_write_paths 内' };
                    }
                }
                const result = await filesystem.execute(args, context);
                this.commandLog.push({ tool: 'filesystem', args, success: result.success, error: result.error || '' });
                return result;
            },
        });

        const processTool = createProcessTool({
            cwd: this.root,
            allowedCwdPaths: [this.root],
            pathBoundary: this.root,
            allowDangerous: false,
            timeout: this.config.commandTimeoutMs || 120_000,
            maxBuffer: 4 * 1024 * 1024,
            allowedCommands: [
                'git status', 'git diff', 'git rev-parse',
                'npm test', 'npm run test', 'npm run lint', 'npm run typecheck', 'npm run check',
                'pnpm test', 'pnpm run test', 'pnpm run lint', 'pnpm run typecheck', 'pnpm run check',
                'yarn test', 'yarn lint', 'pytest', 'python -m pytest', 'cargo test', 'go test',
            ],
            blockedCommands: ['git commit', 'git push', 'git tag', 'git reset', 'git clean', 'git checkout'],
        });
        registry.register({
            ...processTool,
            description: '仅运行当前隔离工作区内的只读 Git 检查和测试、Lint、类型检查命令。',
            parameters: {
                ...processTool.parameters,
                action: { ...processTool.parameters.action, enum: ['run'] },
            },
            execute: async (args, context) => {
                const rawCommand = String(args.command || '').trim();
                const commandArgs = Array.isArray(args.args)
                    ? args.args.map(item => String(item).trim()).filter(Boolean)
                    : [];
                const command = commandArgs.length
                    ? `${rawCommand} ${commandArgs.join(' ')}`
                    : rawCommand;
                if (
                    String(args.action || '') !== 'run'
                    || /[;&|><\r\n]/.test(command)
                    || commandArgs.some(item => !/^[A-Za-z0-9_./:@=+,\-]+$/.test(item))
                ) {
                    return { success: false, error: 'Enterprise Runtime 只允许单个白名单命令' };
                }
                const result = await processTool.execute(
                    { ...args, action: 'run', command, args: [], cwd: this.root, env: {} },
                    context,
                );
                this.commandLog.push({
                    tool: 'process',
                    command,
                    success: result.success,
                    error: result.error || '',
                    data: result.data,
                });
                return result;
            },
        });
        return registry;
    }

    async complete(resultSummary: string): Promise<WorkspaceCompletion> {
        const statusResult = await execFileAsync(
            'git',
            ['-C', this.root, 'status', '--porcelain=v1', '--untracked-files=all'],
            {
            windowsHide: true,
            timeout: 30_000,
            },
        );
        const changedFiles: Array<Record<string, any>> = [];
        const bundleFiles: Array<Record<string, any>> = [];
        let bundleBytes = 0;
        for (const line of statusResult.stdout.split(/\r?\n/).filter(Boolean)) {
            const code = line.slice(0, 2).trim() || 'M';
            const rawPath = line.slice(3).split(' -> ').pop() || '';
            const normalized = rawPath.replace(/\\/g, '/');
            if (!normalized) continue;
            const absolute = resolve(this.root, normalized);
            assertInside(absolute, this.root);
            if (!this.isWriteAllowed(absolute)) {
                throw new Error(`交付物超出冻结需求的 allowed_write_paths：${normalized}`);
            }
            if (code.includes('D')) {
                throw new Error(`Enterprise Runtime 当前安全策略禁止交付删除操作：${normalized}`);
            }
            const content = await readFile(absolute);
            bundleBytes += content.byteLength;
            if (bundleBytes > 16 * 1024 * 1024) {
                throw new Error('Enterprise Runtime ChangeSet 内容超过 16MB 上限');
            }
            const digest = sha256(content);
            changedFiles.push({ path: normalized, status: code, sha256: digest });
            bundleFiles.push({
                path: normalized,
                status: code,
                sha256: digest,
                content_base64: content.toString('base64'),
            });
        }

        const execution = {
            task_id: this.envelope.task_id,
            run_id: this.envelope.run_id,
            result_summary: resultSummary,
            worktree: this.root,
            base_commit: this.baseCommit,
            commands: this.commandLog,
            changed_files: changedFiles,
            applied_change_sets: this.appliedChangeSets,
        };
        const executionText = JSON.stringify(execution, null, 2);
        const executionDigest = sha256(executionText);
        const artifactRoot = resolve(this.config.worktreeRoot, '_artifacts', safeSegment(this.envelope.task_id));
        assertInside(artifactRoot, this.config.worktreeRoot);
        await mkdir(artifactRoot, { recursive: true });
        const artifactPath = join(artifactRoot, `execution-v${this.envelope.lease.state_version}.json`);
        await writeFile(artifactPath, executionText, 'utf8');
        const bundlePath = join(artifactRoot, `changes-v${this.envelope.lease.state_version}.bundle.json`);
        const bundleText = JSON.stringify({
            schema_version: '1.0',
            repository_ref: this.repository.repository_ref,
            base_commit: this.baseCommit,
            files: bundleFiles,
        });
        const bundleDigest = sha256(bundleText);
        if (changedFiles.length) await writeFile(bundlePath, bundleText, 'utf8');
        const testCommands = this.commandLog.filter(item => item.tool === 'process');
        const testSummary = {
            commands: testCommands.length,
            passed: testCommands.filter(item => item.success).length,
            failed: testCommands.filter(item => !item.success).length,
            results: testCommands,
        };
        const patchDigest = bundleDigest;
        const changeSet = changedFiles.length
            ? {
                repository_ref: this.repository.repository_ref,
                base_ref: String(this.envelope.action.workspace_spec?.base_ref || this.repository.base_ref || 'HEAD'),
                base_commit: this.baseCommit,
                head_commit: this.baseCommit,
                changed_files: changedFiles,
                patch_digest: patchDigest,
                digest: sha256(JSON.stringify({ base: this.baseCommit, patch: patchDigest, changedFiles })),
                test_summary: testSummary,
                metadata: {
                    isolation: 'git_worktree',
                    worktree_ref: this.root,
                    runtime_id: this.config.runtimeId,
                    bundle_ref: bundlePath,
                    bundle_digest: bundleDigest,
                    uncommitted: true,
                    commit_created: false,
                    push_performed: false,
                },
            }
            : null;
        return {
            changeSet,
            executionDigest,
            artifacts: [
                ...(changedFiles.length ? [{
                    artifact_type: 'deliverable',
                    name: 'Enterprise Runtime 变更内容包',
                    ref: `file:///${bundlePath.replace(/\\/g, '/')}`,
                    digest: bundleDigest,
                    size: Buffer.byteLength(bundleText),
                    media_type: 'application/json',
                    metadata: {
                        evidence_scope: 'runtime_test',
                        worktree_ref: this.root,
                        bundle_ref: bundlePath,
                    },
                }] : []),
                {
                artifact_type: 'test_report',
                name: 'Enterprise Runtime 执行与测试报告',
                ref: `file:///${artifactPath.replace(/\\/g, '/')}`,
                digest: executionDigest,
                size: Buffer.byteLength(executionText),
                media_type: 'application/json',
                metadata: { evidence_scope: 'runtime_test', worktree_ref: this.root },
                },
            ],
        };
    }
}

export interface RuntimeWorkerDependencies {
    os?: NexusAIOSRuntimeClient;
    studio?: StudioRuntimeModelClient;
    createWorkspace?: (config: EnterpriseRuntimeConfig, envelope: TaskEnvelope) => Promise<GitWorktreeSession>;
}

export class OpenFluxEnterpriseRuntimeWorker {
    private readonly os: NexusAIOSRuntimeClient;
    private readonly studio: StudioRuntimeModelClient;
    private readonly createWorkspace: RuntimeWorkerDependencies['createWorkspace'];

    constructor(
        readonly config: EnterpriseRuntimeConfig,
        dependencies: RuntimeWorkerDependencies = {},
    ) {
        this.os = dependencies.os || new NexusAIOSRuntimeClient(config);
        this.studio = dependencies.studio || new StudioRuntimeModelClient(config);
        this.createWorkspace = dependencies.createWorkspace || GitWorktreeSession.create;
    }

    async initialize(): Promise<void> {
        await this.os.register();
    }

    async runOnce(): Promise<Record<string, any>> {
        await this.os.heartbeat();
        const envelope = await this.os.leaseNext();
        if (!envelope) return { status: 'idle' };
        try {
            const action = envelope.action || {};
            if (action.runtime_target !== 'openflux_enterprise_runtime') {
                throw new Error('OS 任务目标不是 OpenFlux Enterprise Runtime');
            }
            if (action.work_mode !== 'ai_execute') throw new Error('Runtime 只能执行 AI 主执行动作');
            const projectId = String(action.project_id || '');
            if (!projectId) throw new Error('OS 任务缺少 Studio 项目 ID');
            const workspace = await this.createWorkspace!(this.config, envelope);
            const tools = workspace.tools();
            const definitions = tools.toLLMToolDefinitions().map(tool => ({
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
            }));
            const messages: Array<Record<string, any>> = [];
            const maxIterations = this.config.maxIterations || 16;
            let remainingToolCalls = this.config.maxToolCalls || 32;
            let finalTurn: ModelTurnResult | null = null;

            for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
                const state = await this.os.executionState(envelope);
                if (state.directive !== 'continue') throw new Error(`Runtime 已停止：${state.reason}`);
                const turn = await this.studio.turn(projectId, {
                    task_id: envelope.task_id,
                    run_id: envelope.run_id,
                    trace_id: envelope.trace_id,
                    action,
                    input_data: {
                        ...(envelope.input_data || {}),
                        _execution_context: envelope.execution_context || {},
                        _workspace: { root: workspace.root, isolation: 'git_worktree' },
                    },
                    messages,
                    tools: definitions,
                    iteration,
                    remaining_tool_calls: remainingToolCalls,
                });
                if (turn.complete) {
                    finalTurn = turn;
                    break;
                }
                if (!turn.tool_calls.length) throw new Error('模型既未完成任务也未请求工具');
                if (turn.tool_calls.length > remainingToolCalls) throw new Error('模型工具调用超过任务预算');
                messages.push({ role: 'assistant', content: turn.content || '', tool_calls: turn.tool_calls });
                for (const call of turn.tool_calls) {
                    const current = await this.os.executionState(envelope);
                    if (current.directive !== 'continue') throw new Error(`Runtime 已停止：${current.reason}`);
                    const toolResult: ToolResult = await tools.executeTool(call.name, call.arguments || {}, {
                        sessionId: envelope.run_id,
                        turnId: call.id,
                        runId: envelope.run_id,
                        traceId: envelope.trace_id,
                        approvalMode: 'full_access',
                    });
                    messages.push({
                        role: 'tool',
                        tool_call_id: call.id,
                        name: call.name,
                        content: JSON.stringify(toolResult).slice(0, 12_000),
                    });
                    remainingToolCalls -= 1;
                }
            }
            if (!finalTurn) throw new Error('Enterprise Runtime 超过最大模型迭代次数');
            const completion = await workspace.complete(finalTurn.result_summary);
            const requiredArtifacts = new Set((action.artifact_requirements || []).map(String));
            if (requiredArtifacts.has('change_set') && !completion.changeSet) {
                throw new Error('动作要求代码变更集，但隔离工作区没有产生文件差异');
            }
            const deliverableArtifact = completion.artifacts.find(
                item => item.artifact_type === 'deliverable',
            );
            const reportArtifact = completion.artifacts.find(
                item => item.artifact_type === 'test_report',
            );
            const evidence = (envelope.evidence_requirements || []).map((requirement, index) => {
                const requirementName = String(requirement).toUpperCase();
                const artifact = requirementName.includes('AUDIT') || requirementName.includes('REPORT')
                    ? reportArtifact || deliverableArtifact
                    : deliverableArtifact || reportArtifact;
                return {
                    requirement,
                    ref: artifact?.ref || `runtime-test://tasks/${envelope.task_id}/evidence/${index + 1}`,
                    digest: artifact?.digest || completion.executionDigest,
                    metadata: {
                        runtime_id: this.config.runtimeId,
                        evidence_scope: 'runtime_test',
                        workspace_isolation: 'git_worktree',
                        artifact_type: artifact?.artifact_type || 'runtime_evidence',
                    },
                };
            });
            const run = await this.os.complete(envelope, {
                runtime_id: this.config.runtimeId,
                lease_id: envelope.lease.lease_id,
                state_version: envelope.lease.state_version,
                idempotency_key: `openflux-complete:${envelope.task_id}:${envelope.lease.state_version}`,
                result: {
                    summary: finalTurn.result_summary,
                    evidence_scope: 'runtime_test',
                    workspace_ref: workspace.root,
                    model_usage: finalTurn.usage || {},
                },
                output_data: finalTurn.output_data,
                evidence,
                artifacts: completion.artifacts,
                change_set: completion.changeSet || undefined,
                cost: finalTurn.usage || {},
            });
            return {
                status: 'completed',
                task_id: envelope.task_id,
                run_id: envelope.run_id,
                run_status: run.status,
                workspace: workspace.root,
                changed_files: completion.changeSet?.changed_files.length || 0,
            };
        } catch (error) {
            try {
                await this.os.fail(envelope, error);
            } catch {
                // Preserve the original execution error; the expired lease can be
                // recovered by OS and the local worktree remains available for audit.
            }
            throw error;
        }
    }
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): EnterpriseRuntimeConfig {
    const repositories = JSON.parse(env.NEXUSAI_ENTERPRISE_REPOSITORIES_JSON || '[]');
    if (!Array.isArray(repositories) || !repositories.length) {
        throw new Error('NEXUSAI_ENTERPRISE_REPOSITORIES_JSON 必须登记至少一个代码库');
    }
    const config: EnterpriseRuntimeConfig = {
        osUrl: env.NEXUSAI_OS_URL || 'http://127.0.0.1:9480',
        studioUrl: env.NEXUSAI_STUDIO_URL || 'http://127.0.0.1:9472',
        tenantId: env.NEXUSAI_TENANT_ID || 'team:1',
        runtimeId: env.NEXUSAI_ENTERPRISE_RUNTIME_ID || 'openflux-enterprise-runtime-local',
        runtimeToken: env.NEXUSAI_OS_RUNTIME_ENROLLMENT_TOKEN || 'local-runtime-token',
        studioRuntimeToken: env.NEXUSAI_ENTERPRISE_RUNTIME_SERVICE_TOKEN || 'local-runtime-token',
        worktreeRoot: resolve(env.NEXUSAI_ENTERPRISE_WORKTREE_ROOT || '.openflux-enterprise-runtime/worktrees'),
        repositories: repositories.map((item: any) => ({
            repository_ref: String(item.repository_ref || ''),
            repository_path: resolve(String(item.repository_path || '')),
            base_ref: String(item.base_ref || 'HEAD'),
        })),
        maxIterations: Number(env.NEXUSAI_ENTERPRISE_MAX_ITERATIONS || 16),
        maxToolCalls: Number(env.NEXUSAI_ENTERPRISE_MAX_TOOL_CALLS || 32),
        commandTimeoutMs: Number(env.NEXUSAI_ENTERPRISE_COMMAND_TIMEOUT_MS || 120_000),
    };
    if (!config.tenantId.startsWith('team:')) throw new Error('NEXUSAI_TENANT_ID 格式无效');
    for (const repository of config.repositories) {
        if (!repository.repository_ref || !repository.repository_path) {
            throw new Error('代码库登记必须包含 repository_ref 和 repository_path');
        }
    }
    return config;
}
