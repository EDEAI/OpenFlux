import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatWithToolsResponse, LLMMessage, LLMProvider, LLMToolDefinition } from '../llm/provider';
import { LLMError } from '../llm/llm-error';
import { runWithAgentExecutionContext, type AgentExecutionContext } from '../runtime/execution-context';
import { ToolRegistry } from '../tools/registry';
import { createRequestUserInputTool } from '../tools/user-input';
import { runAgentLoop } from './loop';
import { userInputDecisionPolicy, withUserInputDecisionPolicy } from './user-input-policy';

const execution: AgentExecutionContext = {
    sessionId: 'policy-session', turnId: 'policy-turn', runId: 'policy-run', workMode: 'normal',
    userInputControl: { async requestInput() { throw new Error('These scenarios must not create a real clarification request.'); } },
};
const identity = { sessionId: 'policy-session', turnId: 'policy-turn' };

function registry(includeClarification = true, read?: () => void): ToolRegistry {
    const tools = new ToolRegistry();
    if (includeClarification) tools.register(createRequestUserInputTool());
    if (read) tools.register({
        name: 'file_reader', description: 'Read an evidence page', parameters: {},
        async execute() { read(); return { success: true, data: { text: 'Verified evidence from the requested page.' } }; },
    });
    return tools;
}

interface RequestSnapshot { messages: LLMMessage[]; tools: LLMToolDefinition[] }
function fakeProvider(
    respond: (request: RequestSnapshot, index: number) => ChatWithToolsResponse,
    options: { streaming?: boolean; contextWindowTokens?: number } = {},
) {
    const requests: RequestSnapshot[] = [];
    const summaries: LLMMessage[][] = [];
    const call = async (messages: LLMMessage[], tools: LLMToolDefinition[]) => {
        const request = structuredClone({ messages, tools });
        requests.push(request);
        return respond(request, requests.length - 1);
    };
    const provider: LLMProvider = {
        async chat(messages) {
            summaries.push(structuredClone(messages));
            return 'Earlier evidence was read. The user requested a concise summary, with the original scope unchanged.';
        },
        async chatStream() { throw new Error('No plain-text streaming call is expected.'); },
        chatWithTools: options.streaming ? async () => { throw new Error('Expected the streaming provider boundary.'); } : call,
        ...(options.streaming ? { chatWithToolsStream: call } : {}),
        getConfig: () => ({ provider: 'moonshot', model: 'kimi-k3', contextWindowTokens: options.contextWindowTokens || 131_072 }),
        async embed() { return []; }, async embedBatch() { return []; },
    };
    return { provider, requests, summaries };
}

function assertPolicyMatchesCapability(request: RequestSnapshot, offered: boolean, language: string): void {
    assert.equal(request.tools.some(tool => tool.name === 'request_user_input'), offered);
    const policy = userInputDecisionPolicy(language);
    const ruleCount = request.messages.reduce((count, message) => count + message.content.split(policy).length - 1, 0);
    assert.equal(ruleCount, offered ? 1 : 0, 'each actual provider request gets exactly one policy iff it offers the tool');
    if (offered) assert.ok(request.messages.find(message => message.role === 'system')?.content.endsWith(policy), 'first-system-only providers must receive the current policy after other system instructions');
}

test('per-request policy ends the first system without modifying caller history or accumulating across calls', () => {
    const original: LLMMessage[] = [
        Object.freeze({ role: 'system' as const, content: 'Base instructions\n## Installed Skills\nOptional catalog.' }),
        Object.freeze({ role: 'user' as const, content: 'Explain this term.' }),
    ];
    Object.freeze(original);
    const before = JSON.stringify(original);
    for (const language of ['zh-CN', 'en-US']) {
        const first = withUserInputDecisionPolicy(original, true, language);
        const second = withUserInputDecisionPolicy(original, true, language);
        assert.notEqual(first, original);
        assert.notEqual(second, first);
        assert.equal(first.length, original.length);
        assert.deepEqual(first, second);
        assert.notEqual(first[0], original[0]);
        assert.equal(first[1], original[1]);
        assert.equal(first[0].content, `${original[0].content}\n\n${userInputDecisionPolicy(language)}`);
    }
    assert.equal(withUserInputDecisionPolicy(original, false, 'en'), original);
    assert.equal(JSON.stringify(original), before);
});

test('a transcript without system messages receives one new first system and keeps its original messages', () => {
    for (const original of [[], [{ role: 'user' as const, content: 'Original request' }, { role: 'assistant' as const, content: 'Earlier response' }]] satisfies LLMMessage[][]) {
        const before = structuredClone(original);
        Object.freeze(original);
        const request = withUserInputDecisionPolicy(original, true, 'en');
        assert.equal(request.length, original.length + 1);
        assert.deepEqual(request[0], { role: 'system', content: userInputDecisionPolicy('en') });
        for (let index = 0; index < original.length; index++) assert.equal(request[index + 1], original[index]);
        assert.deepEqual(original, before);
        assert.equal(withUserInputDecisionPolicy(original, false, 'en'), original);
    }
});

test('multiple system messages retain their order and content except for the cloned first system', () => {
    const original: LLMMessage[] = [
        { role: 'user', content: 'Preserve this leading message.' },
        { role: 'system', content: 'Base instructions\n## Installed Skills\nOptional skill catalog.' },
        { role: 'assistant', content: 'Existing work.' },
        { role: 'system', content: 'Later runtime instruction.' },
        { role: 'user', content: 'Continue.' },
    ];
    const before = structuredClone(original);
    original.forEach(Object.freeze);
    Object.freeze(original);
    const request = withUserInputDecisionPolicy(original, true, 'zh');
    assert.equal(request.length, original.length);
    assert.deepEqual(request.map(message => message.role), original.map(message => message.role));
    for (const index of [0, 2, 3, 4]) assert.equal(request[index], original[index]);
    assert.notEqual(request[1], original[1]);
    assert.equal(request[1].content, `${original[1].content}\n\n${userInputDecisionPolicy('zh')}`);
    assert.deepEqual(original, before);
});

test('real loop policy follows actual tool registration and execution ownership, not just normal mode', async () => {
    const cases: Array<{ registered: boolean; context: AgentExecutionContext; offered: boolean }> = [
        { registered: true, context: execution, offered: true },
        { registered: false, context: execution, offered: false },
        { registered: true, context: { sessionId: identity.sessionId, turnId: identity.turnId, workMode: 'normal' }, offered: false },
        { registered: true, context: { ...execution, turnId: 'parent-turn', depth: 1 }, offered: false },
    ];
    for (const scenario of cases) {
        const fake = fakeProvider(request => {
            assertPolicyMatchesCapability(request, scenario.offered, 'en');
            return { content: 'A direct answer needs no clarification.', toolCalls: [] };
        });
        const result = await runWithAgentExecutionContext(scenario.context, () => runAgentLoop('Explain the supplied term.', {
            ...identity, llm: fake.provider, tools: registry(scenario.registered), language: 'en', maxIterations: 1,
        }));
        assert.equal(result.status, 'completed');
        assert.equal(fake.requests.length, 1);
        assert.equal(fake.summaries.length, 0);
    }
});

for (const streaming of [false, true]) {
    test(`long skills/history and a context-error retry retain one policy at the ${streaming ? 'streaming' : 'non-streaming'} provider boundary`, async () => {
        const history: LLMMessage[] = Array.from({ length: 20 }, (_, index) => ({
            role: index % 2 ? 'assistant' : 'user',
            content: `Evidence ${index}: ${'previously established context '.repeat(60)}`,
        }));
        const before = structuredClone(history);
        const optionalCatalog = 'OPTIONAL_SKILL_CATALOG_SENTINEL';
        let reads = 0;
        const progress: string[] = [];
        const fake = fakeProvider((request, index) => {
            assertPolicyMatchesCapability(request, true, 'en');
            assert.ok(!request.messages[0].content.includes(optionalCatalog), 'fixture must actually remove the optional Installed Skills section');
            if (index === 0) throw new LLMError('Synthetic context overflow after preflight.', 'CONTEXT_TOO_LONG', 'moonshot');
            if (index === 1) return { content: '', toolCalls: [{ id: 'inspect-page', name: 'file_reader', arguments: {} }] };
            return { content: 'The verified evidence supports the requested summary.', toolCalls: [] };
        }, { streaming, contextWindowTokens: 32_768 });
        const result = await runWithAgentExecutionContext(execution, () => runAgentLoop('Read the evidence page and summarize it.', {
            ...identity, llm: fake.provider, tools: registry(true, () => { reads++; }), language: 'en',
            approvalMode: 'full_access', maxIterations: 5,
            skills: [{ id: 'large-catalog', title: 'Optional catalog', enabled: true, content: `${optionalCatalog}\n${'Long optional skill documentation. '.repeat(10_000)}` }],
            onToolStart: description => progress.push(description),
        }, history));
        assert.equal(result.status, 'completed');
        assert.equal(reads, 1);
        assert.equal(fake.requests.length, 3, 'initial request, compressed retry and one subsequent iteration');
        assert.ok(fake.summaries.length > 0, 'the long-context case must really run summarization');
        assert.ok(progress.some(message => message.includes('级别 1/3')), 'the provider error must reach the recovery branch');
        assert.deepEqual(history, before, 'caller-owned history remains unchanged');
        for (const summary of fake.summaries) {
            assert.ok(summary.every(message => !message.content.includes(userInputDecisionPolicy('en'))), 'request policy must not leak into compacted history and accumulate');
        }
    });
}

test('iteration-budget finalization withdraws clarification policy together with all tools', async () => {
    let reads = 0;
    const fake = fakeProvider((request, index) => {
        const finalizing = index === 2;
        assertPolicyMatchesCapability(request, !finalizing, 'zh');
        if (finalizing) {
            assert.deepEqual(request.tools, []);
            return { content: '已基于两页证据完成总结，尚未核实的部分已注明。', toolCalls: [] };
        }
        return { content: '', toolCalls: [{ id: `read-page-${index}`, name: 'file_reader', arguments: { page: index + 1 } }] };
    });
    const result = await runWithAgentExecutionContext(execution, () => runAgentLoop('请读取这些证据页面并总结。', {
        ...identity, llm: fake.provider, tools: registry(true, () => { reads++; }), language: 'zh', approvalMode: 'full_access', maxIterations: 3,
    }));
    assert.equal(result.status, 'completed');
    assert.equal(result.iterations, 3);
    assert.equal(reads, 2);
    assert.equal(fake.requests.length, 3);
    assert.equal(fake.summaries.length, 0);
    assert.match(result.output, /两页证据/);
});
