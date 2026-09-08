import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatOptions, ChatWithToolsResponse, ChatWithToolsStreamCallbacks, LLMMessage, LLMProvider, LLMToolDefinition } from '../llm/provider';
import { runWithAgentExecutionContext, type AgentExecutionContext } from '../runtime/execution-context';
import { ToolRegistry } from '../tools/registry';
import { createRequestUserInputTool } from '../tools/user-input';
import type { PlanQuestion } from '../work/types';
import { runAgentLoop, type AgentLoopConfig } from './loop';

const identity = { sessionId: 'decision-session', turnId: 'decision-turn' };
const questions: PlanQuestion[] = [{ id: 'purpose', prompt: 'Who will use the learning tool?', kind: 'single', options: [
    { id: 'self', label: 'Myself', description: 'Personal practice' },
    { id: 'students', label: 'My students', description: 'Teaching a class' },
] }];
const ask: ChatWithToolsResponse = { content: 'PRIVATE_PROBE_EXPLANATION', toolCalls: [{
    id: 'question-call', name: 'request_user_input', arguments: { questions_json: JSON.stringify(questions) },
}] };
const answer: ChatWithToolsResponse = { content: 'A short, practical answer.', toolCalls: [] };

interface Request { messages: LLMMessage[]; tools: LLMToolDefinition[]; signal?: AbortSignal }
function fixture(respond: (request: Request, index: number) => ChatWithToolsResponse | Promise<ChatWithToolsResponse>, streaming = false) {
    const requests: Request[] = [];
    const receivedQuestions: PlanQuestion[][] = [];
    const effects: string[] = [];
    const tokens: string[] = [];
    const iterations: string[] = [];
    const toolSummaries: string[] = [];
    const registry = new ToolRegistry();
    registry.register(createRequestUserInputTool());
    registry.register({ name: 'inspect_fixture', description: 'Read a fixture', parameters: {}, async execute() {
        effects.push('inspect_fixture'); return { success: true, data: { available: true } };
    } });
    const call = async (messages: LLMMessage[], tools: LLMToolDefinition[], opts?: ChatOptions) => {
        const request = { ...structuredClone({ messages, tools }), signal: opts?.signal };
        requests.push(request);
        return respond(request, requests.length - 1);
    };
    const llm: LLMProvider = {
        async chat() { throw new Error('This fixture must not require an auxiliary model call.'); },
        async chatStream() { throw new Error('Unexpected text-only model call.'); },
        chatWithTools: call,
        ...(streaming ? { async chatWithToolsStream(messages: LLMMessage[], tools: LLMToolDefinition[], callbacks: ChatWithToolsStreamCallbacks, opts?: ChatOptions) {
            callbacks.onFirstChunk?.();
            callbacks.onContentDelta?.(requests.length === 0 ? 'PRIVATE_PROBE_STREAM' : 'PUBLIC_ANSWER_STREAM');
            return call(messages, tools, opts);
        } } : {}),
        getConfig: () => ({ provider: 'openai', model: 'offline-fixture', contextWindowTokens: 131_072 }),
        async embed() { return []; }, async embedBatch() { return []; },
    };
    const execution: AgentExecutionContext = { ...identity, runId: 'decision-run', workMode: 'normal', userInputControl: {
        async requestInput(value) { receivedQuestions.push(value); return { requestId: 'request-1' }; },
    } };
    const config: AgentLoopConfig = {
        ...identity, llm, tools: registry, maxIterations: 3, approvalMode: 'full_access', language: 'en',
        userInputDecisionEnabled: true,
        skills: [{ id: 'large-skill', title: 'Large fixture skill', content: 'PRIVATE_SKILL_SENTINEL', enabled: true }],
        onToken: text => tokens.push(text), onIteration: (_iteration, text) => iterations.push(text),
        onToolStart: (description, _calls, content) => toolSummaries.push(`${description}\n${content || ''}`),
    };
    const run = (options: Partial<AgentLoopConfig> = {}, history: LLMMessage[] = [], ctx: AgentExecutionContext = execution) =>
        runWithAgentExecutionContext(ctx, () => runAgentLoop('What advice fits this learning tool?', { ...config, ...options }, history));
    return { requests, receivedQuestions, effects, tokens, iterations, toolSummaries, registry, execution, run };
}
function isDecision(request: Request): boolean {
    return request.messages.some(message => message.role === 'system' && message.content.includes('[User input decision]'));
}

for (const streaming of [false, true]) test(`a private CONTINUE reaches the normal model with the original history (${streaming ? 'streaming' : 'non-streaming'})`, async () => {
    const f = fixture((_request, index) => index === 0 ? { content: 'CONTINUE', toolCalls: [] } : answer, streaming);
    const history: LLMMessage[] = [
        { role: 'user', content: 'This is for my own daily practice, not teaching.' },
        { role: 'assistant', content: 'Personal practice is the confirmed audience.' },
    ];
    const result = await f.run({}, history);
    assert.equal(result.status, 'completed');
    assert.equal(result.output, answer.content);
    assert.equal(f.requests.length, 2);
    assert.ok(isDecision(f.requests[0]));
    assert.deepEqual(f.requests[0].tools.map(tool => tool.name), ['request_user_input']);
    assert.ok(f.requests[0].messages.some(message => message.content === history[0].content));
    assert.ok(!f.requests[0].messages.some(message => message.content.includes('PRIVATE_SKILL_SENTINEL')));
    assert.ok(!isDecision(f.requests[1]));
    assert.ok(f.requests[1].messages.some(message => message.content.includes('PRIVATE_SKILL_SENTINEL')));
    assert.ok(f.requests[1].messages.some(message => message.content === history[0].content));
    assert.ok(!f.requests[1].messages.some(message => message.content === 'CONTINUE' || message.content.includes('PRIVATE_PROBE')));
    assert.ok(!f.tokens.join('').includes('PRIVATE_PROBE'));
    assert.ok(!f.iterations.some(text => text.includes('CONTINUE') || text.includes('PRIVATE_PROBE')));
    assert.deepEqual(f.receivedQuestions, []);
    assert.deepEqual(f.effects, []);
});

test('an actual decision question uses the existing waiting_input control without exposing probe prose', async () => {
    const f = fixture(() => structuredClone(ask), true);
    const result = await f.run();
    assert.equal(result.status, 'waiting_input');
    assert.equal(result.output, '');
    assert.equal(f.requests.length, 1);
    assert.equal(f.receivedQuestions.length, 1);
    assert.deepEqual(result.toolCalls.map(call => call.name), ['request_user_input']);
    assert.deepEqual(f.effects, []);
    assert.ok(!f.tokens.join('').includes('PRIVATE_PROBE'));
    assert.ok(!f.iterations.some(text => text.includes('PRIVATE_PROBE')));
    assert.ok(!f.toolSummaries.some(text => text.includes('PRIVATE_PROBE')));
});

test('CONTINUE does not withdraw later clarification when normal execution discovers a new material gap', async () => {
    const f = fixture((_request, index) => index === 0 ? { content: 'CONTINUE', toolCalls: [] } : structuredClone(ask));
    const result = await f.run();
    assert.equal(result.status, 'waiting_input');
    assert.equal(f.requests.length, 2);
    assert.equal(f.receivedQuestions.length, 1);
    assert.ok(!isDecision(f.requests[1]));
    assert.ok(f.requests[1].tools.some(tool => tool.name === 'request_user_input'));
});

test('malformed, unavailable or mixed decision tool calls fall through without executing any of them', async () => {
    for (const toolCalls of [
        [{ id: 'unknown', name: 'inspect_fixture', arguments: {} }],
        [...ask.toolCalls, { id: 'unoffered', name: 'inspect_fixture', arguments: {} }],
        [...ask.toolCalls, { ...ask.toolCalls[0], id: 'second-question' }],
    ]) {
        const f = fixture((_request, index) => index === 0 ? { content: 'PRIVATE_PROBE_EXPLANATION', toolCalls } : answer);
        const result = await f.run();
        assert.equal(result.status, 'completed');
        assert.equal(f.requests.length, 2);
        assert.deepEqual(f.receivedQuestions, []);
        assert.deepEqual(f.effects, []);
        assert.ok(!f.requests[1].messages.some(message => message.toolCalls?.length || message.content.includes('PRIVATE_PROBE')));
    }
});

test('one optional decision error falls through once without a retry, fallback model, or forced question', async () => {
    const f = fixture((_request, index) => { if (index === 0) throw new Error('Offline decision failure'); return answer; });
    const result = await f.run();
    assert.equal(result.status, 'completed');
    assert.equal(f.requests.length, 2);
    assert.ok(isDecision(f.requests[0]));
    assert.ok(!isDecision(f.requests[1]));
    assert.deepEqual(f.receivedQuestions, []);
});

test('a decision timeout cancels its provider request and continues without cancelling the owning turn', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const controller = new AbortController();
    let started!: () => void;
    const firstRequestStarted = new Promise<void>(resolve => { started = resolve; });
    const f = fixture((request, index) => {
        if (index > 0) return answer;
        started();
        return new Promise<ChatWithToolsResponse>((_resolve, reject) => {
            request.signal?.addEventListener('abort', () => reject(request.signal?.reason), { once: true });
        });
    });
    const running = f.run({ abortSignal: controller.signal });
    await firstRequestStarted;
    t.mock.timers.tick(30_000);
    const result = await running;
    assert.equal(result.status, 'completed');
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[0].signal?.aborted, true, 'the abandoned private request must release provider work');
    assert.equal(controller.signal.aborted, false, 'a private timeout is not a user stop');
    assert.equal(f.requests[1].signal?.aborted, false);
    assert.deepEqual(f.receivedQuestions, []);
});

test('stopping during the decision rejects a stale successful response without creating a question', async () => {
    const controller = new AbortController();
    const f = fixture(() => {
        controller.abort(new Error('Stopped by the user'));
        // Some providers resolve their final response despite a cancelled signal.
        return structuredClone(ask);
    });
    await assert.rejects(() => f.run({ abortSignal: controller.signal }), /abort|stop/i);
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.receivedQuestions, []);
    assert.deepEqual(f.effects, []);
});

for (const ignoresAbort of [false, true]) test(`new guidance invalidates a decision and resumes normal execution (${ignoresAbort ? 'provider ignores abort' : 'provider rejects abort'})`, async () => {
    let epoch = 0;
    let pendingSteer = false;
    const listeners = new Set<(epoch: number, source: 'steer' | 'goal_revision') => void>();
    const steer = 'This is for my own practice. Give me three first-version features.';
    const f = fixture((request, index) => {
        if (index > 0) return answer;
        pendingSteer = true;
        epoch++;
        for (const listener of listeners) listener(epoch, 'steer');
        if (!ignoresAbort) throw request.signal?.reason || new Error('Aborted stale request');
        return structuredClone(ask);
    });
    const result = await f.run({
        getIntentEpoch: () => epoch,
        onIntentInvalidated(afterEpoch, listener) {
            listeners.add(listener);
            if (epoch > afterEpoch) listener(epoch, 'steer');
            return () => listeners.delete(listener);
        },
        drainSteering() { if (!pendingSteer) return []; pendingSteer = false; return [{ id: 'steer-1', content: steer }]; },
    });
    assert.equal(result.status, 'completed');
    assert.equal(f.requests.length, 2);
    assert.ok(!isDecision(f.requests[1]), 'an invalidated optional probe is not retried');
    assert.ok(f.requests[1].messages.some(message => message.role === 'user' && message.content === steer));
    assert.ok(!f.requests[1].messages.some(message => message.toolCalls?.some(call => call.id === 'question-call')));
    assert.deepEqual(f.receivedQuestions, []);
    assert.equal(listeners.size, 0);
});

test('guidance already absorbed before the first model request bypasses the original-input decision', async () => {
    const f = fixture(() => answer);
    let pending = true;
    const steer = 'I already chose personal practice; please continue with three features.';
    await f.run({ drainSteering() {
        if (!pending) return []; pending = false; return [{ id: 'early-steer', content: steer }];
    } });
    assert.equal(f.requests.length, 1);
    assert.ok(!isDecision(f.requests[0]));
    assert.ok(f.requests[0].messages.some(message => message.role === 'user' && message.content === steer));
    assert.deepEqual(f.receivedQuestions, []);
});

test('an already advanced intent epoch bypasses a decision even when no original guidance is available to its history', async () => {
    const f = fixture(() => answer);
    await f.run({ getIntentEpoch: () => 1 });
    assert.equal(f.requests.length, 1);
    assert.ok(!isDecision(f.requests[0]));
    assert.deepEqual(f.receivedQuestions, []);
});

test('unoffered capabilities, different owners, child runs and non-normal modes never create a decision request', async () => {
    const contexts: Array<Partial<AgentExecutionContext>> = [
        { userInputControl: undefined }, { sessionId: 'another-session' }, { turnId: 'another-turn' },
        { depth: 1 }, { parentTurnId: 'parent-turn' }, { workMode: 'plan' }, { workMode: 'goal' }, { workMode: 'plan_execution' },
    ];
    for (const patch of contexts) {
        const f = fixture(() => answer);
        await f.run({}, [], { ...f.execution, ...patch });
        assert.ok(f.requests.length >= 1);
        assert.ok(f.requests.every(request => !isDecision(request)));
        assert.ok(f.requests.every(request => !request.tools.some(tool => tool.name === 'request_user_input')));
    }
    for (const disabled of ['withdrawn', 'scheduled', 'flag'] as const) {
        const f = fixture(() => answer);
        if (disabled === 'withdrawn') f.registry.unregister('request_user_input');
        await f.run(disabled === 'scheduled' ? { isScheduledTask: true } : disabled === 'flag' ? { userInputDecisionEnabled: false } : {});
        assert.equal(f.requests.length, 1);
        assert.ok(!isDecision(f.requests[0]));
    }
});

test('answer continuations and incomplete history skip the optional decision without removing the normal tool', async () => {
    for (const reason of ['continuation', 'incomplete-history'] as const) {
        const f = fixture(() => answer);
        const turnId = reason === 'continuation' ? 'user-input:request-1:continue' : identity.turnId;
        await f.run({ turnId, ...(reason === 'incomplete-history' ? { userInputDecisionHistoryComplete: false } : {}) }, [
            { role: 'user', content: 'Myself. I have already answered the audience question.' },
        ], { ...f.execution, turnId });
        assert.equal(f.requests.length, 1);
        assert.ok(!isDecision(f.requests[0]));
        assert.ok(f.requests[0].tools.some(tool => tool.name === 'request_user_input'));
        assert.deepEqual(f.receivedQuestions, []);
    }
});
