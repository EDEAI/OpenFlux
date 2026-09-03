import test from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets, redactSensitiveValue } from '../src/security/redaction';
import { createMemoryTool } from '../src/tools/memory';
import { ToolRegistry } from '../src/tools/registry';
import { runAgentLoop } from '../src/agent/loop';
import type { ChatOptions, ChatWithToolsResponse, LLMMessage, LLMProvider, LLMToolDefinition } from '../src/llm/provider';
import { getAgentExecutionContext, runWithAgentExecutionContext } from '../src/runtime/execution-context';
import {
    DEFAULT_APPROVAL_MODE,
    PermissionChecker,
    RiskLevel,
    normalizeApprovalMode,
    type ApprovalMode,
} from '../src/permissions/checker';
import { createWindowsTool } from '../src/tools/windows';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/sessions';

test('credential redaction covers structured and textual secrets', () => {
    const result = redactSecrets('password=hunter2 api_key=sk-abcdefghijklmnop1234');
    assert.equal(result.findings.length, 2);
    assert.doesNotMatch(result.value, /hunter2|sk-abcdefghijklmnop1234/);

    const structured = redactSensitiveValue({
        authorization: 'Bearer secret-token-value',
        nested: { reasoning_content: 'private chain of thought' },
    }) as Record<string, any>;
    assert.equal(structured.authorization, '[REDACTED]');
    assert.equal(structured.nested.reasoning_content, '[OMITTED]');
});

test('memory tool refuses credentials and never calls the persistence layer', async () => {
    let addCalls = 0;
    const memoryManager = {
        add: async () => { addCalls++; },
        search: async () => [],
        list: () => ({ items: [], total: 0 }),
    } as any;
    const tool = createMemoryTool({ memoryManager });

    const result = await tool.execute({
        action: 'save',
        content: 'My password=hunter2',
    });

    assert.equal(result.success, false);
    assert.equal(addCalls, 0);
    assert.doesNotMatch(String(result.error), /hunter2/);
});

test('ToolRegistry centrally gates risk and forwards turn cancellation context', async () => {
    const registry = new ToolRegistry();
    let executions = 0;
    let capturedSignal: AbortSignal | undefined;
    registry.register({
        name: 'process',
        description: 'test process',
        parameters: {},
        async execute(_args, context) {
            executions++;
            capturedSignal = context?.abortSignal;
            return { success: true, data: 'ok' };
        },
    });

    const denied = await registry.executeTool('process', { action: 'run', command: 'node -v' });
    assert.equal(denied.success, false);
    assert.equal(executions, 0);

    const controller = new AbortController();
    let approvalTurn: string | undefined;
    const approved = await registry.executeTool('process', { action: 'run', command: 'node -v' }, {
        sessionId: 'session-a',
        turnId: 'turn-a',
        abortSignal: controller.signal,
        requestApproval: async request => {
            approvalTurn = request.turnId;
            return 'approved';
        },
    });
    assert.equal(approved.success, true);
    assert.equal(executions, 1);
    assert.equal(approvalTurn, 'turn-a');
    assert.equal(capturedSignal, controller.signal);

    controller.abort();
    await assert.rejects(
        registry.executeTool('process', { action: 'run', command: 'node -v' }, {
            abortSignal: controller.signal,
            requestApproval: async () => 'approved',
        }),
        (error: any) => error?.name === 'AbortError',
    );
    assert.equal(executions, 1);
});

test('approval modes apply an isolated four-risk-by-three-mode policy', async () => {
    const checker = new PermissionChecker();
    const cases: Array<{
        name: string;
        args: Record<string, unknown>;
        risk: RiskLevel;
        expected: Record<ApprovalMode, boolean>;
    }> = [
        {
            name: 'filesystem',
            args: { action: 'read', path: 'notes.txt' },
            risk: RiskLevel.None,
            expected: { ask: false, risk_based: false, full_access: false },
        },
        {
            name: 'filesystem',
            args: { action: 'write', path: 'notes.txt' },
            risk: RiskLevel.Low,
            expected: { ask: true, risk_based: false, full_access: false },
        },
        {
            name: 'process',
            args: { action: 'run', command: 'node -v' },
            risk: RiskLevel.Medium,
            expected: { ask: true, risk_based: true, full_access: false },
        },
        {
            name: 'filesystem',
            args: { action: 'delete', path: 'old-output.txt' },
            risk: RiskLevel.High,
            expected: { ask: true, risk_based: true, full_access: false },
        },
    ];

    for (const item of cases) {
        assert.equal(checker.assess(item.name, item.args).level, item.risk);
        for (const mode of ['ask', 'risk_based', 'full_access'] as const) {
            assert.equal(
                await checker.requiresConfirmation(item.name, item.args, mode),
                item.expected[mode],
                `${item.name}/${RiskLevel[item.risk]}/${mode}`,
            );
        }
    }

    assert.equal(DEFAULT_APPROVAL_MODE, 'risk_based');
    assert.equal(normalizeApprovalMode(undefined), 'risk_based');
    assert.equal(normalizeApprovalMode('invalid'), 'risk_based');
});

test('full access skips confirmation but cannot bypass immutable safety policy', async () => {
    const registry = new ToolRegistry();
    let executions = 0;
    registry.register({
        name: 'process',
        description: 'test process',
        parameters: {},
        async execute() {
            executions++;
            return { success: true, data: 'ok' };
        },
    });

    const ordinary = await registry.executeTool(
        'process',
        { action: 'run', command: 'node -v' },
        { approvalMode: 'full_access' },
    );
    assert.equal(ordinary.success, true);
    assert.equal(executions, 1);

    const blocked = await registry.executeTool(
        'process',
        { action: 'run', command: 'diskpart' },
        { approvalMode: 'full_access' },
    );
    assert.equal(blocked.success, false);
    assert.match(String(blocked.error), /immutable safety policy/i);
    assert.equal(executions, 1);
});

test('session approval mode persists and legacy metadata normalizes to the safe default', () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'openflux-approval-mode-'));
    try {
        const store = new SessionStore({ storePath: temporaryRoot });
        const created = store.create('default', 'approval test', undefined, undefined, undefined, 'full_access');
        assert.equal(created.approvalMode, 'full_access');
        assert.equal(store.list().find(item => item.id === created.id)?.approvalMode, 'full_access');

        store.updateMetadata(created.id, { approvalMode: 'ask' });
        const reloaded = new SessionStore({ storePath: temporaryRoot });
        assert.equal(reloaded.get(created.id)?.approvalMode, 'ask');
        assert.equal(reloaded.list().find(item => item.id === created.id)?.approvalMode, 'ask');
    } finally {
        rmSync(temporaryRoot, { recursive: true, force: true });
    }
});

test('WMI/CIM inventory commands are blocked while Format-List itself is not treated as disk formatting', () => {
    const checker = new PermissionChecker();
    const wmiQuery = checker.assess('process', {
        action: 'run',
        command: 'Get-CimInstance Win32_VideoController | Format-List Name,AdapterRAM',
    });
    const safeFormatList = checker.assess('process', {
        action: 'run',
        command: 'Get-Process | Format-List Name,CPU',
    });
    const diskFormat = checker.assess('process', {
        action: 'run',
        command: 'format E: /FS:NTFS',
    });

    assert.equal(wmiQuery.blocked, true);
    assert.equal(wmiQuery.level, RiskLevel.High);
    assert.equal(safeFormatList.level, RiskLevel.Medium);
    assert.equal(diskFormat.level, RiskLevel.High);
});

test('full access cannot bypass the WMI Provider Host protection', async () => {
    const registry = new ToolRegistry();
    let executions = 0;
    registry.register({
        name: 'windows',
        description: 'test windows tool',
        parameters: {},
        async execute() {
            executions++;
            return { success: true };
        },
    });

    const result = await registry.executeTool('windows', {
        action: 'powershell',
        script: 'Get-ComputerInfo | Format-List',
    }, { approvalMode: 'full_access' });
    assert.equal(result.success, false);
    assert.match(result.error || '', /WMI Provider Host/i);
    assert.equal(executions, 0);

    const netTcpResult = await registry.executeTool('windows', {
        action: 'powershell',
        script: 'Get-NetTCPConnection -State Listen',
    }, { approvalMode: 'full_access' });
    assert.equal(netTcpResult.success, false);
    assert.equal(executions, 0);
});

test('Windows system info coalesces and caches the WMI-free GPU probe', async () => {
    let probeCalls = 0;
    const tool = createWindowsTool({
        gpuProbe: async () => {
            probeCalls++;
            await new Promise(resolve => setTimeout(resolve, 10));
            return [{ name: 'Test GPU', memoryMb: 8192, driverVersion: '1.2.3' }];
        },
    });

    const [first, second] = await Promise.all([
        tool.execute({ action: 'system' }),
        tool.execute({ action: 'system' }),
    ]);
    const third = await tool.execute({ action: 'system' });

    assert.equal(probeCalls, 1);
    for (const result of [first, second, third]) {
        assert.equal(result.success, true);
        const gpu = (result.data as any).gpu;
        assert.equal(gpu.source, 'nvidia-smi');
        assert.equal(gpu.safeProbeComplete, true);
        assert.equal(gpu.wmiFallbackAllowed, false);
        assert.deepEqual(gpu.adapters, [{ name: 'Test GPU', memoryMb: 8192, driverVersion: '1.2.3' }]);
    }
});

test('Browser discovery has no periodic or WMIC process probe', () => {
    const source = readFileSync(new URL('../src/tools/browser/index.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /execSync\(\s*['"`]wmic\b/i);
    assert.doesNotMatch(source, /function\s+initBrowserProbe\b/);
});

test('AgentLoop forwards AbortSignal and withholds raw model reasoning', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const thinkingEvents: string[] = [];
    const iterationContent: string[] = [];

    const provider: LLMProvider = {
        async chat(): Promise<string> { return ''; },
        async chatStream(_messages: LLMMessage[], _onChunk: (chunk: string) => void): Promise<string> { return ''; },
        async chatWithTools(
            _messages: LLMMessage[],
            _tools: LLMToolDefinition[],
            opts?: ChatOptions,
        ): Promise<ChatWithToolsResponse> {
            receivedSignal = opts?.signal;
            return {
                content: '<think>private chain of thought</think>Public answer',
                reasoningContent: 'provider-private-reasoning',
                toolCalls: [],
            };
        },
        getConfig: () => ({ provider: 'openai', model: 'test' }),
        async embed(): Promise<number[]> { return []; },
        async embedBatch(): Promise<number[][]> { return []; },
    };

    const result = await runAgentLoop('hello', {
        llm: provider,
        tools: new ToolRegistry(),
        maxIterations: 1,
        abortSignal: controller.signal,
        onThinking: value => thinkingEvents.push(value),
        onIteration: (_iteration, content) => iterationContent.push(content),
    });

    assert.equal(receivedSignal, controller.signal);
    assert.equal(result.output, 'Public answer');
    assert.deepEqual(thinkingEvents, []);
    assert.deepEqual(iterationContent, ['Public answer']);
});

test('AsyncLocal execution context stays isolated across concurrent turns', async () => {
    const observed: string[] = [];
    await Promise.all([
        runWithAgentExecutionContext({ sessionId: 'session-a', turnId: 'turn-a', approvalMode: 'ask' }, async () => {
            await new Promise(resolve => setTimeout(resolve, 20));
            observed.push(`${getAgentExecutionContext()?.sessionId}:${getAgentExecutionContext()?.turnId}:${getAgentExecutionContext()?.approvalMode}`);
        }),
        runWithAgentExecutionContext({ sessionId: 'session-b', turnId: 'turn-b', approvalMode: 'full_access' }, async () => {
            await new Promise(resolve => setTimeout(resolve, 5));
            observed.push(`${getAgentExecutionContext()?.sessionId}:${getAgentExecutionContext()?.turnId}:${getAgentExecutionContext()?.approvalMode}`);
        }),
    ]);

    assert.deepEqual(observed.sort(), ['session-a:turn-a:ask', 'session-b:turn-b:full_access']);
});

test('AgentLoop turn cancellation rejects with AbortError instead of a successful stopped message', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stop old turn'));
    let modelCalls = 0;
    const provider: LLMProvider = {
        async chat(): Promise<string> { return 'COMPLETED'; },
        async chatStream(): Promise<string> { return ''; },
        async chatWithTools(): Promise<ChatWithToolsResponse> {
            modelCalls++;
            return { content: 'must not run', toolCalls: [] };
        },
        getConfig: () => ({ provider: 'openai', model: 'test' }),
        async embed(): Promise<number[]> { return []; },
        async embedBatch(): Promise<number[][]> { return []; },
    };

    await assert.rejects(
        () => runAgentLoop('hello', {
            llm: provider,
            tools: new ToolRegistry(),
            abortSignal: controller.signal,
        }),
        (error: Error) => error.name === 'AbortError' && /stop old turn/.test(error.message),
    );
    assert.equal(modelCalls, 0);
});

test('steering received while the model is running invalidates its stale tool plan', async () => {
    const registry = new ToolRegistry();
    let toolExecutions = 0;
    registry.register({
        name: 'stale_tool',
        description: 'must not execute after steering',
        parameters: {},
        async execute() {
            toolExecutions++;
            return { success: true };
        },
    });

    const modelMessages: LLMMessage[][] = [];
    let modelCalls = 0;
    const provider: LLMProvider = {
        async chat(): Promise<string> { return 'COMPLETED'; },
        async chatStream(): Promise<string> { return ''; },
        async chatWithTools(messages): Promise<ChatWithToolsResponse> {
            modelMessages.push(messages.map(message => ({ ...message, toolCalls: message.toolCalls?.map(call => ({ ...call })) })));
            modelCalls++;
            if (modelCalls === 1) {
                return {
                    content: 'old plan',
                    toolCalls: [{ id: 'old-call', name: 'stale_tool', arguments: {} }],
                };
            }
            return { content: 'followed the new direction', toolCalls: [] };
        },
        getConfig: () => ({ provider: 'openai', model: 'test' }),
        async embed(): Promise<number[]> { return []; },
        async embedBatch(): Promise<number[][]> { return []; },
    };
    let drains = 0;
    const result = await runAgentLoop('original goal', {
        llm: provider,
        tools: registry,
        maxIterations: 2,
        approvalMode: 'full_access',
        drainSteering: () => ++drains === 2
            ? [{ id: 'steer-1', content: 'do the safer alternative instead' }]
            : [],
    });

    assert.equal(result.output, 'followed the new direction');
    assert.equal(toolExecutions, 0);
    assert.equal(modelCalls, 2);
    assert.ok(modelMessages[1].some(message => message.role === 'user' && message.content === 'do the safer alternative instead'));
    assert.ok(!modelMessages[1].some(message => message.toolCalls?.some(call => call.id === 'old-call')));
});

test('steering aborts an in-flight model request and waits for its goal revision before replanning', async () => {
    const registry = new ToolRegistry();
    const modelMessages: LLMMessage[][] = [];
    const intentListeners = new Set<(epoch: number, source: 'steer' | 'goal_revision') => void>();
    let epoch = 0;
    let steeringReady = false;
    let revisionReady = false;
    let modelCalls = 0;

    const provider: LLMProvider = {
        async chat(): Promise<string> { return 'COMPLETED'; },
        async chatStream(): Promise<string> { return ''; },
        async chatWithTools(messages, _tools, opts): Promise<ChatWithToolsResponse> {
            modelMessages.push(messages.map(message => ({ ...message })));
            modelCalls++;
            if (modelCalls > 1) return { content: 'followed reconciled goals', toolCalls: [] };
            return new Promise((_resolve, reject) => {
                opts?.signal?.addEventListener('abort', () => reject(opts.signal?.reason), { once: true });
                queueMicrotask(() => {
                    steeringReady = true;
                    epoch = 1;
                    for (const listener of intentListeners) listener(epoch, 'steer');
                });
            });
        },
        getConfig: () => ({ provider: 'openai', model: 'test' }),
        async embed(): Promise<number[]> { return []; },
        async embedBatch(): Promise<number[][]> { return []; },
    };

    const result = await runAgentLoop('生成 JSON 报告', {
        llm: provider,
        tools: registry,
        maxIterations: 2,
        approvalMode: 'full_access',
        getIntentEpoch: () => epoch,
        onIntentInvalidated: (afterEpoch, listener) => {
            intentListeners.add(listener);
            if (epoch > afterEpoch) queueMicrotask(() => listener(epoch, 'steer'));
            return () => intentListeners.delete(listener);
        },
        drainSteering: () => {
            if (!steeringReady) return [];
            steeringReady = false;
            return [{ id: 'steer-live', content: '保留报告内容，但改为 CSV 输出' }];
        },
        waitForGoalReconciliation: async () => {
            await Promise.resolve();
            revisionReady = true;
        },
        drainGoalRevisions: () => revisionReady
            ? [{
                id: 'revision-1',
                revision: 1,
                effectiveGoal: '1. 生成报告内容\n2. 输出 CSV',
                title: '任务目标已修订',
                detail: '保留：报告内容\n调整：JSON → CSV',
            }]
            : [],
    });

    assert.equal(result.output, 'followed reconciled goals');
    assert.equal(modelCalls, 2);
    assert.ok(modelMessages[1].some(message => (
        message.role === 'user'
        && message.content.includes('保留报告内容，但改为 CSV 输出')
    )));
    assert.ok(modelMessages[1].some(message => (
        message.role === 'user'
        && message.content.includes('运行时目标修订摘要')
        && message.content.includes('输出 CSV')
    )));
});

test('steering preserves completed tool results, skips only pending work, and replans in FIFO order', async () => {
    const registry = new ToolRegistry();
    const executed: string[] = [];
    const observedResults: string[] = [];
    for (const name of ['first_tool', 'second_tool']) {
        registry.register({
            name,
            description: name,
            parameters: {},
            async execute() {
                executed.push(name);
                return { success: true, data: name };
            },
        });
    }

    const modelMessages: LLMMessage[][] = [];
    let modelCalls = 0;
    const provider: LLMProvider = {
        async chat(): Promise<string> { return 'COMPLETED'; },
        async chatStream(): Promise<string> { return ''; },
        async chatWithTools(messages): Promise<ChatWithToolsResponse> {
            modelMessages.push(messages.map(message => ({ ...message, toolCalls: message.toolCalls?.map(call => ({ ...call })) })));
            modelCalls++;
            if (modelCalls === 1) {
                return {
                    content: 'run two old steps',
                    toolCalls: [
                        { id: 'call-1', name: 'first_tool', arguments: {} },
                        { id: 'call-2', name: 'second_tool', arguments: {} },
                    ],
                };
            }
            return { content: 'replanned', toolCalls: [] };
        },
        getConfig: () => ({ provider: 'openai', model: 'test' }),
        async embed(): Promise<number[]> { return []; },
        async embedBatch(): Promise<number[][]> { return []; },
    };
    let drains = 0;
    const result = await runAgentLoop('original goal', {
        llm: provider,
        tools: registry,
        maxIterations: 3,
        approvalMode: 'full_access',
        onToolCall: (call, result) => {
            if ((result as { success?: boolean }).success) observedResults.push(call.name);
        },
        drainSteering: () => ++drains === 5
            ? [
                { id: 'steer-a', content: 'first new instruction' },
                { id: 'steer-a', content: 'duplicate must be ignored' },
                { id: 'steer-b', content: 'second new instruction' },
            ]
            : [],
    });

    assert.equal(result.output, 'replanned');
    assert.deepEqual(executed, ['first_tool']);
    assert.deepEqual(observedResults, ['first_tool']);
    const replanningContext = modelMessages[1];
    const firstResult = replanningContext.findIndex(message => message.toolCallId === 'call-1');
    const skippedResult = replanningContext.findIndex(message => message.toolCallId === 'call-2');
    const steerA = replanningContext.findIndex(message => message.role === 'user' && message.content === 'first new instruction');
    const steerB = replanningContext.findIndex(message => message.role === 'user' && message.content === 'second new instruction');
    assert.ok(firstResult >= 0 && skippedResult > firstResult && steerA > skippedResult && steerB > steerA);
    assert.ok(!replanningContext.some(message => message.content === 'duplicate must be ignored'));
    assert.match(replanningContext[skippedResult].content, /superseded_by_steering/);
});

test('multi-tool batches keep image vision content after every tool result', async () => {
    const registry = new ToolRegistry();
    registry.register({
        name: 'inspect_images',
        description: 'inspect images',
        parameters: {},
        async execute(_args, context) {
            assert.deepEqual(context?.activeModel, {
                provider: 'openai',
                model: 'test',
                vision: true,
            });
            return {
                success: true,
                images: [{ mimeType: 'image/png', data: 'aW1hZ2U=', description: 'review image' }],
            };
        },
    });
    registry.register({
        name: 'filesystem',
        description: 'read file',
        parameters: {},
        async execute() { return { success: true, data: 'file contents' }; },
    });

    let modelCalls = 0;
    const provider: LLMProvider = {
        async chat(): Promise<string> { return 'COMPLETED'; },
        async chatStream(): Promise<string> { return ''; },
        async chatWithTools(messages): Promise<ChatWithToolsResponse> {
            modelCalls++;
            if (modelCalls === 1) {
                return {
                    content: '',
                    toolCalls: [
                        { id: 'inspect:1', name: 'inspect_images', arguments: {} },
                        { id: 'filesystem:6', name: 'filesystem', arguments: {} },
                    ],
                };
            }
            const assistantIndex = messages.findIndex(message => message.toolCalls?.some(call => call.id === 'inspect:1'));
            assert.ok(assistantIndex >= 0);
            assert.deepEqual(
                messages.slice(assistantIndex + 1, assistantIndex + 3).map(message => message.toolCallId),
                ['inspect:1', 'filesystem:6'],
            );
            assert.equal(messages[assistantIndex + 3].role, 'user');
            assert.ok(messages[assistantIndex + 3].contentParts?.some(part => part.type === 'image'));
            return { content: 'done', toolCalls: [] };
        },
        getConfig: () => ({ provider: 'openai', model: 'test', capabilities: { vision: true } }),
        async embed(): Promise<number[]> { return []; },
        async embedBatch(): Promise<number[][]> { return []; },
    };

    const result = await runAgentLoop('inspect then read', {
        llm: provider,
        tools: registry,
        maxIterations: 2,
        approvalMode: 'full_access',
    });
    assert.equal(result.output, 'done');
    assert.equal(modelCalls, 2);
});

test('explicitly declared text-only planners receive no screenshot payload and get a review boundary', async () => {
    const registry = new ToolRegistry();
    registry.register({
        name: 'inspect_images',
        description: 'inspect images',
        parameters: {},
        async execute() {
            return {
                success: true,
                images: [{ mimeType: 'image/png', data: 'aW1hZ2U=', description: 'review image' }],
            };
        },
    });
    let calls = 0;
    const provider: LLMProvider = {
        async chat(): Promise<string> { return ''; },
        async chatStream(): Promise<string> { return ''; },
        async chatWithTools(messages): Promise<ChatWithToolsResponse> {
            calls++;
            if (calls === 1) {
                return { content: '', toolCalls: [{ id: 'inspect:1', name: 'inspect_images', arguments: {} }] };
            }
            assert.ok(!messages.some(message => message.contentParts?.some(part => part.type === 'image')));
            assert.ok(messages.some(message => message.role === 'system' && /active model is text-only/i.test(message.content)));
            return { content: 'done without pretending to see it', toolCalls: [] };
        },
        getConfig: () => ({
            provider: 'deepseek',
            model: 'deepseek-chat',
            capabilities: { vision: false },
        }),
        async embed(): Promise<number[]> { return []; },
        async embedBatch(): Promise<number[][]> { return []; },
    };
    const result = await runAgentLoop('inspect image safely', {
        llm: provider,
        tools: registry,
        maxIterations: 2,
        approvalMode: 'full_access',
    });
    assert.equal(result.output, 'done without pretending to see it');
});
