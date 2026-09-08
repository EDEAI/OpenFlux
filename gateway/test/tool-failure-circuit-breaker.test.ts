import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MAX_TOOL_FAILURE_ATTEMPTS,
    ToolFailureCircuitBreaker,
    isToolResultError,
    normalizeToolErrorSignature,
    runAgentLoop,
} from '../src/agent/loop';
import type {
    ChatOptions,
    ChatWithToolsResponse,
    LLMMessage,
    LLMProvider,
    LLMToolDefinition,
} from '../src/llm/provider';
import type { ToolRegistry } from '../src/tools/registry';

test('tool result errors include success:false and non-empty string errors', () => {
    assert.equal(isToolResultError({ success: false }), true);
    assert.equal(isToolResultError({ success: true, error: 'encoder unavailable' }), true);
    assert.equal(isToolResultError({ success: true, error: '   ' }), false);
    assert.equal(isToolResultError({ content: JSON.stringify({ success: false }) }), true);
    assert.equal(isToolResultError({ success: true }), false);
});

test('same tool and normalized error trips after the initial attempt plus two retries', () => {
    const breaker = new ToolFailureCircuitBreaker();
    const errors = [
        { success: false, error: 'Encoder unavailable; request id: 9c5da74a-b625-4cda-9f13-b1f49b5323bf' },
        { success: false, error: '  ENCODER   UNAVAILABLE; request id: f68d1712-34cc-47bd-b4fb-298999f15430  ' },
        { success: false, error: 'Encoder unavailable; request id: c7080271-1acb-483b-9c43-2252d936441c' },
    ];

    assert.equal(normalizeToolErrorSignature(errors[0]), normalizeToolErrorSignature(errors[1]));
    assert.equal(breaker.record('generate_video', errors[0]).disposition, 'retry');
    // An unrelated success does not erase a repeatedly failing path in this turn.
    assert.equal(breaker.record('generate_video', { success: true }).disposition, 'not_error');
    assert.equal(breaker.record('generate_video', errors[1]).disposition, 'retry');
    const tripped = breaker.record('generate_video', errors[2]);
    assert.equal(tripped.disposition, 'tripped');
    assert.equal(tripped.attempts, MAX_TOOL_FAILURE_ATTEMPTS);
    assert.equal(breaker.isDisabled('generate_video'), true);
    assert.equal(breaker.record('generate_video', errors[2]).disposition, 'disabled');
});

test('an aborted execution is not counted as a retryable tool failure', () => {
    const breaker = new ToolFailureCircuitBreaker();
    const aborted = breaker.record(
        'generate_video',
        { success: false, error: 'Operation aborted' },
        { aborted: true },
    );
    assert.deepEqual(aborted, { disposition: 'aborted', attempts: 0 });

    const firstRealFailure = breaker.record('generate_video', {
        success: false,
        error: 'Operation aborted',
    });
    assert.equal(firstRealFailure.disposition, 'retry');
    assert.equal(firstRealFailure.attempts, 1);
});

test('Agent loop hard-disables a repeatedly failing tool and converges without executing it again', async () => {
    let modelCalls = 0;
    let executions = 0;
    const offeredToolCounts: number[] = [];
    let convergencePrompt = '';

    const provider: LLMProvider = {
        async chat(): Promise<string> {
            throw new Error('completion and claim guards must be bypassed during forced convergence');
        },
        async chatStream(): Promise<string> { return ''; },
        async chatWithTools(
            messages: LLMMessage[],
            definitions: LLMToolDefinition[],
            _options?: ChatOptions,
        ): Promise<ChatWithToolsResponse> {
            modelCalls++;
            offeredToolCounts.push(definitions.length);
            if (modelCalls <= MAX_TOOL_FAILURE_ATTEMPTS) {
                return {
                    content: '',
                    toolCalls: [{ id: `call-${modelCalls}`, name: 'generate_video', arguments: { prompt: 'test' } }],
                };
            }

            convergencePrompt = messages
                .filter(message => message.role === 'system')
                .map(message => message.content)
                .join('\n');
            // A provider may still emit a stale tool call despite receiving an
            // empty tool list. It must not reach the registry after the trip.
            return {
                content: 'The video was not generated after three failed attempts.',
                toolCalls: [{ id: 'stale-call', name: 'generate_video', arguments: { prompt: 'retry' } }],
            };
        },
        getConfig: () => ({ provider: 'openai', model: 'circuit-breaker-test' }),
        async embed(): Promise<number[]> { return []; },
        async embedBatch(): Promise<number[][]> { return []; },
    };

    const registry = {
        getToolNames: () => ['generate_video'],
        toLLMToolDefinitions: (): LLMToolDefinition[] => [{
            name: 'generate_video',
            description: 'Generate a video',
            parameters: { type: 'object', properties: {}, required: [] },
        }],
        async executeTool() {
            executions++;
            const requestId = [
                '9c5da74a-b625-4cda-9f13-b1f49b5323bf',
                'f68d1712-34cc-47bd-b4fb-298999f15430',
                'c7080271-1acb-483b-9c43-2252d936441c',
            ][executions - 1];
            return {
                success: false,
                error: `Encoder unavailable; request id: ${requestId}`,
            };
        },
    } as unknown as ToolRegistry;

    const result = await runAgentLoop('Create a test video', {
        llm: provider,
        tools: registry,
        maxIterations: 6,
        language: 'en',
    });

    assert.equal(executions, MAX_TOOL_FAILURE_ATTEMPTS);
    assert.equal(modelCalls, MAX_TOOL_FAILURE_ATTEMPTS + 1);
    assert.deepEqual(offeredToolCounts, [1, 1, 1, 0]);
    assert.match(convergencePrompt, /hard-disabled for this turn/i);
    assert.equal(result.output, 'The video was not generated after three failed attempts.');
});

test('Agent loop rejects with AbortError without scheduling a tool retry', async () => {
    let modelCalls = 0;
    let executions = 0;
    const provider: LLMProvider = {
        async chat(): Promise<string> { return ''; },
        async chatStream(): Promise<string> { return ''; },
        async chatWithTools(): Promise<ChatWithToolsResponse> {
            modelCalls++;
            return {
                content: '',
                toolCalls: [{ id: 'abort-call', name: 'generate_video', arguments: {} }],
            };
        },
        getConfig: () => ({ provider: 'openai', model: 'abort-test' }),
        async embed(): Promise<number[]> { return []; },
        async embedBatch(): Promise<number[][]> { return []; },
    };
    const registry = {
        getToolNames: () => ['generate_video'],
        toLLMToolDefinitions: (): LLMToolDefinition[] => [{
            name: 'generate_video',
            description: 'Generate a video',
            parameters: { type: 'object', properties: {}, required: [] },
        }],
        async executeTool() {
            executions++;
            const error = new Error('Operation aborted');
            error.name = 'AbortError';
            throw error;
        },
    } as unknown as ToolRegistry;

    await assert.rejects(
        () => runAgentLoop('Create a test video', {
            llm: provider,
            tools: registry,
            maxIterations: 6,
            language: 'en',
        }),
        (error: Error) => error.name === 'AbortError' && /Operation aborted/.test(error.message),
    );

    assert.equal(executions, 1);
    assert.equal(modelCalls, 1);
});
