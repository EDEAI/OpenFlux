import assert from 'node:assert/strict';
import test from 'node:test';
import type {
    ChatOptions,
    ChatWithToolsResponse,
    LLMMessage,
    LLMProvider,
    LLMToolDefinition,
} from '../llm/provider';
import { ToolRegistry } from '../tools/registry';
import { runAgentLoop } from './loop';
import {
    buildCompressionTranscript,
    compactToolResultContent,
    ContextBudgetLedger,
    extractContextWindowFromError,
    inspectContextBudget,
    recommendedHistoryTokenBudget,
    resolveContextWindowTokens,
    serializeToolResultForContext,
} from './context-budget';

test('provider context errors expose an authoritative runtime limit', () => {
    assert.equal(extractContextWindowFromError(
        'Invalid request: Your request exceeded model token limit: 262144 (requested: 279726)',
    ), 262_144);
    assert.equal(extractContextWindowFromError('maximum context length is 1,048,576 tokens'), 1_048_576);
    assert.equal(extractContextWindowFromError('temporary upstream failure'), undefined);
});

test('Kimi K3 and K2.6 use their distinct total context windows', () => {
    assert.equal(resolveContextWindowTokens({ provider: 'moonshot', model: 'kimi-k3' }), 1_048_576);
    assert.equal(resolveContextWindowTokens({ provider: 'moonshot', model: 'kimi-k3-fast' }), 1_048_576);
    assert.equal(resolveContextWindowTokens({ provider: 'moonshot', model: 'kimi-k2.6' }), 262_144);
    assert.equal(resolveContextWindowTokens({ provider: 'moonshot', model: 'kimi-k2.7-code' }), 262_144);
    assert.equal(recommendedHistoryTokenBudget({ provider: 'moonshot', model: 'kimi-k2.6' }), 39_321);
    assert.equal(recommendedHistoryTokenBudget({ provider: 'moonshot', model: 'kimi-k3' }), 131_072);
    assert.equal(resolveContextWindowTokens({
        provider: 'custom',
        model: 'managed-kimi-k3',
        contextWindowTokens: 196_608,
    }), 196_608);
});

test('the same large request compacts on K2.6 but remains below the K3 threshold', () => {
    const messages: LLMMessage[] = [{ role: 'user', content: 'a'.repeat(750_000) }];
    const k26 = inspectContextBudget(messages, [], { provider: 'moonshot', model: 'kimi-k2.6' });
    const k3 = inspectContextBudget(messages, [], { provider: 'moonshot', model: 'kimi-k3' });

    assert.equal(k26.shouldCompact, true);
    assert.equal(k26.overBudget, false);
    assert.equal(k3.shouldCompact, false);
    assert.ok(k26.utilization > k3.utilization * 3);
    assert.ok(k26.safetyTokens > 0);
    assert.ok(k26.reservedOutputTokens > 0);
});

test('per-turn budget ledger reuses unchanged message estimates and invalidates mutations', () => {
    const messages: LLMMessage[] = [
        { role: 'system', content: 'fixed prompt' },
        { role: 'user', content: 'large payload '.repeat(10_000) },
    ];
    const ledger = new ContextBudgetLedger();
    const config = { provider: 'moonshot' as const, model: 'kimi-k2.6' };
    const first = ledger.inspect(messages, [], config);
    assert.deepEqual(ledger.getCacheStats(), { hits: 0, misses: 2 });

    const second = ledger.inspect(messages, [], config);
    assert.equal(second.estimatedInputTokens, first.estimatedInputTokens);
    assert.deepEqual(ledger.getCacheStats(), { hits: 2, misses: 2 });

    messages[1].content += ' changed';
    const third = ledger.inspect(messages, [], config);
    assert.ok(third.estimatedInputTokens > second.estimatedInputTokens);
    assert.deepEqual(ledger.getCacheStats(), { hits: 3, misses: 3 });
});

test('semantic compression input preserves late constraints and evidence from every message', () => {
    const messages: LLMMessage[] = Array.from({ length: 30 }, (_, index): LLMMessage => ({
        role: index % 3 === 0 ? 'user' : 'assistant',
        content: index === 23
            ? `FINAL_CONSTRAINT_X must remain. ${'noise '.repeat(800)}`
            : `message-${index} ${'noise '.repeat(800)}`,
    }));
    messages[25] = {
        role: 'tool',
        toolCallId: 'query-25',
        content: JSON.stringify({
            success: true,
            summary: 'EVIDENCE_REF_Y matched 37 rows',
            data: { hasMore: true, nextStartRow: 2001 },
            rows: Array(500).fill(['large', 'row']),
        }),
    };

    const transcript = buildCompressionTranscript(messages, 12_000);
    assert.match(transcript, /FINAL_CONSTRAINT_X/);
    assert.match(transcript, /EVIDENCE_REF_Y/);
    assert.match(transcript, /nextStartRow/);
    assert.match(transcript, /message-0/);
    assert.ok(transcript.length <= 12_000);
});

test('oversized tool results remain valid JSON and retain pagination state', () => {
    const result = {
        success: true,
        data: {
            totalRows: 40_000,
            returnedRows: 2_000,
            hasMore: true,
            nextStartRow: 2_001,
            rows: Array.from({ length: 2_000 }, (_, index) => [index, 'x'.repeat(80)]),
        },
    };
    const serialized = serializeToolResultForContext(result, 4_000);
    const parsed = JSON.parse(serialized);

    assert.equal(parsed.truncatedForContext, true);
    assert.equal(parsed.data.hasMore, true);
    assert.equal(parsed.data.nextStartRow, 2_001);
    assert.ok(serialized.length <= 4_000);

    const recompressed = compactToolResultContent(serialized, 1_000);
    assert.doesNotThrow(() => JSON.parse(recompressed));
});

function providerFor(
    model: 'kimi-k3' | 'kimi-k2.6',
    observed: { summaryCalls: number; request?: LLMMessage[] },
): LLMProvider {
    return {
        async chat(): Promise<string> {
            observed.summaryCalls++;
            return '- 当前目标不变\n- 保留约束 KEEP_THIS_CONSTRAINT\n- 已有证据 file.xlsx!A2:F2';
        },
        async chatStream(): Promise<string> { return ''; },
        async chatWithTools(
            messages: LLMMessage[],
            _tools: LLMToolDefinition[],
            _opts?: ChatOptions,
        ): Promise<ChatWithToolsResponse> {
            observed.request = messages;
            return { content: 'done', toolCalls: [] };
        },
        getConfig: () => ({ provider: 'moonshot', model }),
        async embed(): Promise<number[]> { return []; },
        async embedBatch(): Promise<number[][]> { return []; },
    };
}

test('agent loop proactively compresses an oversized K2.6 turn but not the same K3 turn', async () => {
    const history: LLMMessage[] = Array.from({ length: 12 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `history-${index} ${'甲'.repeat(9_000)}`,
    }));
    history[8].content = `KEEP_THIS_CONSTRAINT ${'乙'.repeat(9_000)}`;
    const input = `current request ${'丙'.repeat(160_000)}`;

    const k26Observed = { summaryCalls: 0 } as { summaryCalls: number; request?: LLMMessage[] };
    const k26Provider = providerFor('kimi-k2.6', k26Observed);
    const k26Result = await runAgentLoop(input, {
        llm: k26Provider,
        tools: new ToolRegistry(),
        maxIterations: 1,
        language: 'zh',
    }, history);
    assert.equal(k26Result.output, 'done');
    assert.equal(k26Observed.summaryCalls, 1);
    assert.match(k26Observed.request?.map(message => message.content).join('\n') || '', /Previous conversation summary/);
    const k26Budget = inspectContextBudget(k26Observed.request || [], [], k26Provider.getConfig());
    assert.equal(k26Budget.overBudget, false);

    const k3Observed = { summaryCalls: 0 } as { summaryCalls: number; request?: LLMMessage[] };
    const k3Result = await runAgentLoop(input, {
        llm: providerFor('kimi-k3', k3Observed),
        tools: new ToolRegistry(),
        maxIterations: 1,
        language: 'zh',
    }, history);
    assert.equal(k3Result.output, 'done');
    assert.equal(k3Observed.summaryCalls, 0);
    assert.doesNotMatch(k3Observed.request?.map(message => message.content).join('\n') || '', /Previous conversation summary/);
});
