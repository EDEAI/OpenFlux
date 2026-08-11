import assert from 'node:assert/strict';
import test from 'node:test';
import { createSubAgentExecutor } from '../src/agent/subagent';
import type {
    ChatOptions,
    ChatWithToolsResponse,
    LLMMessage,
    LLMProvider,
    LLMToolDefinition,
} from '../src/llm/provider';
import { PermissionChecker, RiskLevel } from '../src/permissions/checker';
import { ToolRegistry } from '../src/tools/registry';
import { createSpawnTool } from '../src/tools/spawn';
import { createSessionsSpawnTool } from '../src/tools/sessions-spawn';

function providerWithToolCall(onDefinitions?: (tools: LLMToolDefinition[]) => void): LLMProvider {
    let callCount = 0;
    return {
        async chat(): Promise<string> { return ''; },
        async chatStream(): Promise<string> { return ''; },
        async chatWithTools(
            _messages: LLMMessage[],
            tools: LLMToolDefinition[],
        ): Promise<ChatWithToolsResponse> {
            callCount++;
            onDefinitions?.(tools);
            if (callCount === 1) {
                return {
                    content: '',
                    toolCalls: [{
                        id: 'process-call',
                        name: 'process',
                        arguments: { action: 'run', command: 'node -v' },
                    }],
                };
            }
            return { content: 'done', toolCalls: [] };
        },
        getConfig: () => ({ provider: 'openai', model: 'test' }),
        async embed(): Promise<number[]> { return []; },
        async embedBatch(): Promise<number[][]> { return []; },
    };
}

function providerThatReturnsWhenAborted(): LLMProvider {
    return {
        async chat(): Promise<string> { return ''; },
        async chatStream(): Promise<string> { return ''; },
        async chatWithTools(
            _messages: LLMMessage[],
            _tools: LLMToolDefinition[],
            options?: ChatOptions,
        ): Promise<ChatWithToolsResponse> {
            return new Promise(resolve => {
                const finish = () => resolve({ content: 'stopped', toolCalls: [] });
                if (options?.signal?.aborted) finish();
                else options?.signal?.addEventListener('abort', finish, { once: true });
            });
        },
        getConfig: () => ({ provider: 'openai', model: 'test' }),
        async embed(): Promise<number[]> { return []; },
        async embedBatch(): Promise<number[][]> { return []; },
    };
}

function providerWithFinalAnswer(onDefinitions: (tools: LLMToolDefinition[]) => void): LLMProvider {
    return {
        async chat(): Promise<string> { return ''; },
        async chatStream(): Promise<string> { return ''; },
        async chatWithTools(
            _messages: LLMMessage[],
            tools: LLMToolDefinition[],
        ): Promise<ChatWithToolsResponse> {
            onDefinitions(tools);
            return { content: 'done', toolCalls: [] };
        },
        getConfig: () => ({ provider: 'openai', model: 'test' }),
        async embed(): Promise<number[]> { return []; },
        async embedBatch(): Promise<number[][]> { return []; },
    };
}

test('SubAgent filtering clones the registry and preserves its PermissionChecker', async () => {
    const registry = new ToolRegistry({
        permissionChecker: new PermissionChecker(RiskLevel.High),
    });
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
    registry.register({
        name: 'spawn',
        description: 'must not be inherited by a SubAgent',
        parameters: {},
        async execute() { return { success: true }; },
    });

    const observedDefinitions: string[][] = [];
    const execute = createSubAgentExecutor({
        llm: providerWithToolCall(tools => observedDefinitions.push(tools.map(tool => tool.name))),
        tools: registry,
        maxIterations: 3,
    });
    const result = await execute({
        id: 'filtered-worker',
        task: 'run the test process',
        tools: ['process'],
        timeout: 1,
    });

    assert.equal(result.status, 'completed');
    assert.equal(executions, 1, 'the inherited high auto-approve threshold should allow process execution');
    assert.ok(observedDefinitions.every(definitions => !definitions.includes('spawn')));
    assert.ok(registry.getTool('spawn'), 'filtering must not unregister tools from the shared registry');
});

test('SubAgent removes denied tools from a clone when params.tools is omitted', async () => {
    const registry = new ToolRegistry();
    registry.register({
        name: 'process',
        description: 'allowed tool',
        parameters: {},
        async execute() { return { success: true }; },
    });
    registry.register({
        name: 'spawn',
        description: 'denied nested spawn',
        parameters: {},
        async execute() { return { success: true }; },
    });
    let definitions: string[] = [];
    const execute = createSubAgentExecutor({
        llm: providerWithFinalAnswer(tools => { definitions = tools.map(tool => tool.name); }),
        tools: registry,
    });

    const result = await execute({
        id: 'inherited-worker',
        task: 'answer without tools',
        timeout: 1,
    });

    assert.equal(result.status, 'completed');
    assert.deepEqual(definitions, ['process']);
    assert.ok(registry.getTool('spawn'), 'denied-tool removal must not mutate the source registry');
});

test('SubAgent reports timeout when runAgentLoop returns normally after its signal aborts', async () => {
    const execute = createSubAgentExecutor({
        llm: providerThatReturnsWhenAborted(),
        tools: new ToolRegistry(),
    });

    const result = await execute({
        id: 'timed-worker',
        task: 'wait until timeout',
        timeout: 0.02,
    });

    assert.equal(result.status, 'timeout');
    assert.equal(result.error, 'Execution timed out');
});

test('SubAgent reports parent abort as failed instead of completed', async () => {
    const parent = new AbortController();
    const execute = createSubAgentExecutor({
        llm: providerThatReturnsWhenAborted(),
        tools: new ToolRegistry(),
    });
    setTimeout(() => parent.abort(new Error('user stopped parent')), 10);

    const result = await execute({
        id: 'interrupted-worker',
        task: 'wait until parent interruption',
        timeout: 1,
        parentAbortSignal: parent.signal,
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.error, 'Parent agent was interrupted');
});

test('spawn tool advertises its blocking semantics and points to sessions_spawn for background work', () => {
    const tool = createSpawnTool();
    assert.match(tool.description, /synchronously/i);
    assert.match(tool.description, /blocks until/i);
    assert.match(tool.description, /sessions_spawn/);
    assert.match(tool.description, /waitForResult=false/);
    assert.doesNotMatch(tool.description, /Use for parallel or background subtasks/i);
});

test('sessions_spawn tells parent agents not to invent hard artifact sizes', () => {
    const tool = createSessionsSpawnTool({ collaborationManager: {} as never });
    assert.match(tool.description, /Do not invent minimum KB\/byte\/word-count targets/);
    assert.match(tool.description, /length ranges are advisory only/);
});
