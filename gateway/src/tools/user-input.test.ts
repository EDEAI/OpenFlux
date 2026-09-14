import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRequestUserInputTool } from './user-input';
import type { ToolExecutionContext } from './types';
import type { PlanQuestion } from '../work/types';
import { ToolRegistry } from './registry';
import { runAgentLoop } from '../agent/loop';
import { AgentManager } from '../agent/manager';
import { runWithAgentExecutionContext, type AgentExecutionContext } from '../runtime/execution-context';
import type { ChatWithToolsResponse, LLMMessage, LLMProvider, LLMToolDefinition } from '../llm/provider';
import { SessionStore } from '../sessions/store';
import type { OpenFluxConfig } from '../config/schema';

const questions: PlanQuestion[] = [{ id: 'scope', prompt: 'Which scope?', kind: 'single', options: [
    { id: 'pilot', label: 'Pilot', description: 'One region', recommended: true },
    { id: 'all', label: 'All', description: 'Every region' },
] }];
const payload = { questions_json: JSON.stringify(questions) };
function context(captured: PlanQuestion[][]): Pick<ToolExecutionContext, 'sessionId' | 'turnId' | 'runId' | 'workMode' | 'userInputControl'> {
    return { sessionId: 'session', turnId: 'turn', runId: 'run', workMode: 'normal', userInputControl: {
        async requestInput(value) { captured.push(value); return { requestId: 'request' }; },
    } };
}
function provider(reply: (messages: LLMMessage[], tools: LLMToolDefinition[], call: number) => ChatWithToolsResponse): LLMProvider {
    let calls = 0;
    return {
        async chat() { return 'COMPLETED'; }, async chatStream() { return ''; },
        async chatWithTools(messages, tools) { return reply(messages, tools, calls++); },
        getConfig() { return { provider: 'moonshot', model: 'kimi-k3' }; },
        async embed() { return []; }, async embedBatch() { return []; },
    };
}

test('request_user_input accepts the flat JSON envelope and legacy array, preserving explicit user choice', async () => {
    const captured: PlanQuestion[][] = [];
    const tool = createRequestUserInputTool();
    assert.deepEqual(Object.keys(tool.rawInputSchema!.properties as object), ['questions_json']);
    assert.deepEqual(tool.rawInputSchema!.required, ['questions_json']);
    const result = await tool.execute(payload, context(captured));
    assert.deepEqual(result, { success: true, data: { requestId: 'request' }, controlSignal: 'waiting_input' });
    await tool.execute({ questions }, context(captured));
    assert.equal(captured.length, 2);
    assert.equal(captured[0][0].allowOther, true);
    assert.equal(captured[0][0].options[0].recommended, true);
    for (const invalid of [{ questions_json: '' }, { questions_json: '[{' }, { questions_json: '[{}]' }, { questions: Array(4).fill(questions[0]) }]) {
        await assert.rejects(() => tool.execute(invalid, context(captured)));
    }
    assert.equal(captured.length, 2);
});

test('unsupported execution paths reject direct tool calls without creating a pending request', async () => {
    const captured: PlanQuestion[][] = [];
    const tool = createRequestUserInputTool();
    const allowed = context(captured);
    const unsupported: Array<ToolExecutionContext | undefined> = [
        undefined, { workMode: 'normal' },
        ...(['plan', 'goal', 'plan_execution'] as const).map(workMode => ({ ...allowed, workMode })),
        { ...allowed, isScheduledTask: true }, { ...allowed, parentSessionId: 'parent' },
    ];
    for (const ctx of unsupported) await assert.rejects(() => tool.execute(payload, ctx), /interactive normal session/);
    assert.deepEqual(captured, []);
    const registry = new ToolRegistry();
    registry.register(tool);
    assert.equal(registry.filter(undefined, true, { deny: [] }).getTool(tool.name), undefined);
});

test('ordinary clarification does not open a separate permission confirmation in ask mode', async () => {
    const registry = new ToolRegistry();
    registry.register(createRequestUserInputTool());
    let approvalCount = 0;
    const result = await registry.executeTool('request_user_input', payload, {
        ...context([]), approvalMode: 'ask',
        async requestApproval() { approvalCount++; return 'approved'; },
    });
    assert.equal(result.controlSignal, 'waiting_input');
    assert.equal(approvalCount, 0);
});

test('loop offers clarification only to a normal interactive owning run with the gateway capability', async () => {
    for (const disabled of [
        {}, { workMode: 'normal' as const },
        ...(['plan', 'goal', 'plan_execution'] as const).map(workMode => ({ ...context([]), workMode })),
        { ...context([]), depth: 1 }, { ...context([]), parentTurnId: 'parent-turn' },
    ]) {
        const registry = new ToolRegistry(); registry.register(createRequestUserInputTool());
        const llm = provider((_messages, tools) => {
            assert.equal(tools.some(tool => tool.name === 'request_user_input'), false);
            return { content: 'Done.', toolCalls: [] };
        });
        await runWithAgentExecutionContext(disabled as AgentExecutionContext, () => runAgentLoop('Tell me a fact.', { llm, tools: registry, sessionId: 'session', turnId: 'turn', maxIterations: 1 }));
    }
    const registry = new ToolRegistry(); registry.register(createRequestUserInputTool());
    await runWithAgentExecutionContext(context([]) as AgentExecutionContext, () => runAgentLoop('Tell me a fact.', {
        llm: provider((_messages, tools) => {
            assert.equal(tools.some(tool => tool.name === 'request_user_input'), false);
            return { content: 'Done.', toolCalls: [] };
        }), tools: registry, sessionId: 'session', turnId: 'turn', isScheduledTask: true, maxIterations: 1,
    }));
    // Legacy child runners can inherit the parent's async context, but their
    // loop config does not own that physical session/turn.
    for (const identity of [{}, { sessionId: 'different', turnId: 'turn' }, { sessionId: 'session', turnId: 'different' }]) {
        await runWithAgentExecutionContext(context([]) as AgentExecutionContext, () => runAgentLoop('Tell me a fact.', {
            llm: provider((_messages, tools) => {
                assert.equal(tools.some(tool => tool.name === 'request_user_input'), false);
                return { content: 'Done.', toolCalls: [] };
            }), tools: registry, ...identity, maxIterations: 1,
        }));
    }
});

test('the loop completes earlier tools then pauses exactly at clarification without running the rest of the batch', async () => {
    const registry = new ToolRegistry();
    const effects: string[] = [];
    for (const name of ['before_input', 'after_input']) registry.register({ name, description: name, parameters: {}, async execute() { effects.push(name); return { success: true }; } });
    registry.register(createRequestUserInputTool());
    let modelCalls = 0;
    const llm = provider((_messages, tools) => {
        modelCalls++;
        assert.ok(tools.some(tool => tool.name === 'request_user_input'));
        return { content: 'I inspected the available options.', toolCalls: [
            { id: 'before', name: 'before_input', arguments: {} },
            { id: 'ask', name: 'request_user_input', arguments: payload },
            { id: 'after', name: 'after_input', arguments: {} },
        ] };
    });
    const captured: PlanQuestion[][] = [];
    const result = await runWithAgentExecutionContext(context(captured) as AgentExecutionContext, () => runAgentLoop('Prepare a rollout.', { llm, tools: registry, approvalMode: 'full_access', sessionId: 'session', turnId: 'turn' }));
    assert.equal(result.status, 'waiting_input');
    assert.equal(result.output, '');
    assert.equal(modelCalls, 1);
    assert.deepEqual(effects, ['before_input']);
    assert.deepEqual(result.toolCalls.map(call => call.name), ['before_input', 'request_user_input']);
    assert.equal(captured.length, 1);
});

test('manager persists pre-question evidence and commentary, resumes with one answer, and reports the actual executing agent', async t => {
    const directory = mkdtempSync(join(tmpdir(), 'openflux-user-input-manager-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const sessions = new SessionStore({ storePath: directory });
    sessions.create('main', 'Test', undefined, undefined, 'session');
    const registry = new ToolRegistry();
    registry.register(createRequestUserInputTool());
    let inspections = 0;
    registry.register({ name: 'inspect_rollout', description: 'Read rollout configuration', parameters: {}, async execute() { inspections++; return { success: true, data: { currentRegion: 'EU', file: 'rollout.json' } }; } });
    let executionCalls = 0;
    const llm = provider((messages) => {
        if (messages.some(message => message.role === 'system' && message.content.includes('[User input decision]'))) {
            return { content: 'CONTINUE', toolCalls: [] };
        }
        if (executionCalls++ === 0) return { content: 'I confirmed the existing rollout uses EU.', toolCalls: [
            { id: 'read', name: 'inspect_rollout', arguments: {} },
            { id: 'ask', name: 'request_user_input', arguments: payload },
        ] };
        const history = messages.map(message => message.content).join('\n');
        assert.match(history, /existing rollout uses EU/);
        assert.match(history, /currentRegion/);
        assert.match(history, /rollout.json/);
        assert.equal(messages.filter(message => message.role === 'user' && message.content === 'Pilot only, please.').length, 1);
        return { content: 'The pilot rollout instructions are ready.', toolCalls: [] };
    });
    const manager = new AgentManager({ config: { language: 'en', agents: { list: [{ id: 'main', default: true, name: 'Main' }] } } as OpenFluxConfig, tools: registry, defaultLLM: llm, sessions });
    let executionAgent: string | undefined;
    const first = await runWithAgentExecutionContext({ runId: 'run-a' }, () => manager.run('Prepare the rollout.', 'main', 'session', undefined, undefined, undefined, undefined, undefined, {
        turnId: 'turn-a', workMode: 'normal', approvalMode: 'full_access',
        userInputControl: { async requestInput(_questions, meta) { executionAgent = meta?.agentId; sessions.addMessage('session', { role: 'assistant', content: 'Which scope?' }); return { requestId: 'request' }; } },
    }));
    assert.equal(first.status, 'waiting_input');
    assert.equal(executionAgent, 'main');
    assert.equal(sessions.getMessages('session').filter(message => message.metadata?.kind === 'user_input_checkpoint').length, 1);
    assert.equal(sessions.getMessages('session').filter(message => message.role === 'assistant' && typeof message.content === 'string' && !message.content.trim()).length, 0);
    sessions.addMessage('session', { role: 'user', content: 'Pilot only, please.' });
    const second = await manager.run('Continue the original rollout with the submitted answer.', 'main', 'session', undefined, undefined, undefined, undefined, undefined, { turnId: 'turn-b', workMode: 'normal', skipUserMessage: true, retryCurrentUserMessage: true, approvalMode: 'full_access' });
    assert.equal(second.status, 'completed');
    assert.equal(inspections, 1);
    assert.deepEqual(sessions.getMessages('session').filter(message => message.role === 'user').map(message => message.content), ['Prepare the rollout.', 'Pilot only, please.']);
});
