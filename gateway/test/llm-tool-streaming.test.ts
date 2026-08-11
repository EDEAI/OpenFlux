import test from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicProvider } from '../src/llm/anthropic';
import { OpenAIProvider } from '../src/llm/openai';
import { LLMError } from '../src/llm/llm-error';
import {
    PublicTextStreamFilter,
    isStreamingUnsupportedError,
    runAgentLoop,
} from '../src/agent/loop';
import { ToolRegistry } from '../src/tools/registry';
import type {
    ChatOptions,
    ChatWithToolsResponse,
    ChatWithToolsStreamCallbacks,
    LLMMessage,
    LLMProvider,
    LLMToolDefinition,
} from '../src/llm/provider';

async function* chunks<T>(items: T[]): AsyncGenerator<T> {
    for (const item of items) yield item;
}

const filesystemTool: LLMToolDefinition = {
    name: 'filesystem',
    description: 'Read a file',
    parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
    },
};

test('OpenAI-compatible tool streaming reconstructs text, reasoning, and fragmented calls', async () => {
    const provider = new OpenAIProvider({
        provider: 'moonshot',
        model: 'stream-test',
        apiKey: 'test-key',
        baseUrl: 'https://example.invalid/v1',
    });
    (provider as any).client = {
        chat: {
            completions: {
                create: async () => chunks([
                    { choices: [{ delta: { role: 'assistant' } }] },
                    { choices: [{ delta: { reasoning_content: 'private ' } }] },
                    { choices: [{ delta: { content: 'I will ' } }] },
                    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_', function: { name: 'file', arguments: '{"pa' } }] } }] },
                    { choices: [{ delta: { tool_calls: [{ index: 0, id: '1', function: { name: 'system', arguments: 'th":"C:/tmp"}' } }] } }] },
                ]),
            },
        },
    };

    const contentDeltas: string[] = [];
    const reasoningDeltas: string[] = [];
    const toolDeltas: unknown[] = [];
    let firstChunks = 0;
    const result = await provider.chatWithToolsStream(
        [{ role: 'user', content: 'read it' }],
        [filesystemTool],
        {
            onFirstChunk: () => firstChunks++,
            onContentDelta: delta => contentDeltas.push(delta),
            onReasoningDelta: delta => reasoningDeltas.push(delta),
            onToolCallDelta: delta => toolDeltas.push(delta),
        },
    );

    assert.equal(firstChunks, 1);
    assert.deepEqual(contentDeltas, ['I will ']);
    assert.deepEqual(reasoningDeltas, ['private ']);
    assert.equal(toolDeltas.length, 2);
    assert.equal(result.content, 'I will ');
    assert.equal(result.reasoningContent, 'private ');
    assert.deepEqual(result.toolCalls, [{
        id: 'call_1',
        name: 'filesystem',
        arguments: { path: 'C:/tmp' },
    }]);
});

test('Anthropic tool streaming reconstructs partial_json input independently from public text', async () => {
    const provider = new AnthropicProvider({
        provider: 'anthropic',
        model: 'stream-test',
        apiKey: 'test-key',
        baseUrl: 'https://example.invalid',
    });
    (provider as any).client = {
        messages: {
            stream: () => chunks([
                { type: 'message_start' },
                { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'private' } },
                { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Checking' } },
                { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool-1', name: 'filesystem', input: {} } },
                { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
                { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"C:/tmp"}' } },
            ]),
        },
    };

    const callbacks: Required<Pick<ChatWithToolsStreamCallbacks, 'onContentDelta' | 'onReasoningDelta'>> = {
        onContentDelta: () => undefined,
        onReasoningDelta: () => undefined,
    };
    const result = await provider.chatWithToolsStream(
        [{ role: 'user', content: 'read it' }],
        [filesystemTool],
        callbacks,
    );

    assert.equal(result.content, 'Checking');
    assert.equal(result.reasoningContent, 'private');
    assert.deepEqual(result.toolCalls, [{
        id: 'tool-1',
        name: 'filesystem',
        arguments: { path: 'C:/tmp' },
    }]);
});

test('public stream filter withholds think blocks whose tags span network chunks', () => {
    const filter = new PublicTextStreamFilter();
    assert.equal(filter.push('Before <thi'), 'Before ');
    assert.equal(filter.push('nking>private'), '');
    assert.equal(filter.push(' chain</think'), '');
    assert.equal(filter.push('ing>After'), 'After');
    assert.equal(filter.finish(), '');
});

test('AgentLoop asks for concise public rationale instead of hidden chain-of-thought', async () => {
    let systemPrompt = '';
    const provider: LLMProvider = {
        async chat(): Promise<string> { return ''; },
        async chatStream(): Promise<string> { return ''; },
        async chatWithTools(messages: LLMMessage[]): Promise<ChatWithToolsResponse> {
            systemPrompt = String(messages.find(message => message.role === 'system')?.content || '');
            return { content: 'done', toolCalls: [] };
        },
        getConfig: () => ({ provider: 'test', model: 'test' }),
        async embed(): Promise<number[]> { return []; },
        async embedBatch(): Promise<number[][]> { return []; },
    };

    await runAgentLoop('检查这个项目', {
        llm: provider,
        tools: new ToolRegistry(),
        maxIterations: 1,
        language: 'zh-CN',
    });

    assert.match(systemPrompt, /用户可见的执行说明/);
    assert.match(systemPrompt, /已经读取、修改、验证或发现的事实/);
    assert.match(systemPrompt, /不要写“为了完成……我先……”/);
    assert.match(systemPrompt, /不要输出原始思维链、隐藏推理/);
    assert.match(systemPrompt, /Artifact Size and Convergence/);
    assert.match(systemPrompt, /Never add, delete, rewrite, or repeatedly re-check an artifact solely to cross a size threshold/);
    assert.match(systemPrompt, /Check an artifact's size at most once after content validation/);
});

test('AgentLoop commit-gates streamed text and keeps provider reasoning private', async () => {
    const tokens: Array<{ value: string; provisional: boolean }> = [];
    const phases: string[] = [];
    const provider: LLMProvider = {
        async chat(): Promise<string> { return ''; },
        async chatStream(): Promise<string> { return ''; },
        async chatWithTools(): Promise<ChatWithToolsResponse> {
            throw new Error('non-streaming path must not run');
        },
        async chatWithToolsStream(
            _messages: LLMMessage[],
            _tools: LLMToolDefinition[],
            callbacks: ChatWithToolsStreamCallbacks,
        ): Promise<ChatWithToolsResponse> {
            callbacks.onFirstChunk?.();
            for (const delta of ['<thi', 'nk>secret</think>Hello', ' world']) {
                callbacks.onContentDelta?.(delta);
            }
            callbacks.onReasoningDelta?.('provider-private-reasoning');
            return {
                content: '<think>secret</think>Hello world',
                reasoningContent: 'provider-private-reasoning',
                toolCalls: [],
            };
        },
        getConfig: () => ({ provider: 'openai', model: 'stream-test' }),
        async embed(): Promise<number[]> { return []; },
        async embedBatch(): Promise<number[][]> { return []; },
    };

    const result = await runAgentLoop('hello', {
        llm: provider,
        tools: new ToolRegistry(),
        maxIterations: 1,
        onToken: (value, metadata) => tokens.push({ value, provisional: metadata?.provisional === true }),
        onModelProgress: event => phases.push(event.phase),
    });

    assert.equal(result.output, 'Hello world');
    assert.deepEqual(tokens, [
        { value: 'Hello world', provisional: false },
    ]);
    assert.deepEqual(phases, ['started', 'first_chunk', 'completed']);
});

test('AgentLoop never publishes a streamed draft superseded by steering', async () => {
    const tokens: string[] = [];
    const resets: string[] = [];
    let modelCalls = 0;
    const provider: LLMProvider = {
        async chat(): Promise<string> { return ''; },
        async chatStream(): Promise<string> { return ''; },
        async chatWithTools(): Promise<ChatWithToolsResponse> {
            throw new Error('non-streaming path must not run');
        },
        async chatWithToolsStream(
            _messages: LLMMessage[],
            _tools: LLMToolDefinition[],
            callbacks: ChatWithToolsStreamCallbacks,
        ): Promise<ChatWithToolsResponse> {
            modelCalls++;
            callbacks.onFirstChunk?.();
            const content = modelCalls === 1 ? 'obsolete draft' : 'guided final';
            callbacks.onContentDelta?.(content);
            return { content, toolCalls: [] };
        },
        getConfig: () => ({ provider: 'openai', model: 'stream-test' }),
        async embed(): Promise<number[]> { return []; },
        async embedBatch(): Promise<number[][]> { return []; },
    };
    let drains = 0;

    const result = await runAgentLoop('original', {
        llm: provider,
        tools: new ToolRegistry(),
        maxIterations: 2,
        drainSteering: () => ++drains === 2
            ? [{ id: 'steer-1', content: 'use the new direction' }]
            : [],
        onToken: value => tokens.push(value),
        onStreamReset: reason => resets.push(reason),
    });

    assert.equal(result.output, 'guided final');
    assert.deepEqual(tokens, ['guided final']);
    assert.deepEqual(resets, []);
});

test('AgentLoop falls back only when streaming is rejected before the first chunk', async () => {
    let streamingCalls = 0;
    let nonStreamingCalls = 0;
    const completedEvents: Array<{ streamed: boolean }> = [];
    const provider: LLMProvider = {
        async chat(): Promise<string> { return ''; },
        async chatStream(): Promise<string> { return ''; },
        async chatWithTools(
            _messages: LLMMessage[],
            _tools: LLMToolDefinition[],
            _opts?: ChatOptions,
        ): Promise<ChatWithToolsResponse> {
            nonStreamingCalls++;
            return { content: 'fallback answer', toolCalls: [] };
        },
        async chatWithToolsStream(): Promise<ChatWithToolsResponse> {
            streamingCalls++;
            throw new LLMError(
                'This endpoint does not support streaming; stream must be false',
                'UNKNOWN',
                'custom',
                { statusCode: 400 },
            );
        },
        getConfig: () => ({ provider: 'custom', model: 'legacy-tool-model' }),
        async embed(): Promise<number[]> { return []; },
        async embedBatch(): Promise<number[][]> { return []; },
    };

    const result = await runAgentLoop('hello', {
        llm: provider,
        tools: new ToolRegistry(),
        maxIterations: 1,
        onModelProgress: event => {
            if (event.phase === 'completed') completedEvents.push({ streamed: event.streamed });
        },
    });

    assert.equal(result.output, 'fallback answer');
    assert.equal(streamingCalls, 1);
    assert.equal(nonStreamingCalls, 1);
    assert.deepEqual(completedEvents, [{ streamed: false }]);
    assert.equal(isStreamingUnsupportedError(new Error('ordinary timeout')), false);
});
