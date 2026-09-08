import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatWithToolsResponse, LLMProvider } from '../llm/provider';
import { DEFAULT_GOAL_BUDGET, type GoalRecord, type GoalRound } from './goal-types';
import { deriveGoalCriteria, toGoalToolLogEntry, validateVerdicts, verifyGoalRound } from './goal-verifier';

function provider(reply: string | (() => Promise<string>)): LLMProvider {
    const chat = typeof reply === 'string' ? async () => reply : reply;
    return {
        chat: chat as LLMProvider['chat'],
        chatStream: chat as LLMProvider['chatStream'],
        async chatWithTools(): Promise<ChatWithToolsResponse> { return { content: '', toolCalls: [] }; },
        getConfig: () => ({ provider: 'openai', model: 'goal-test' }),
        async embed(): Promise<number[]> { return []; },
        async embedBatch(): Promise<number[][]> { return []; },
    };
}

function goal(): GoalRecord {
    return {
        id: 'g',
        sessionId: 's',
        status: 'running',
        goal: '在 D:\\tmp 下创建 a.txt 并回答文件大小',
        criteria: [
            { id: 'c1', text: 'a.txt 已创建', check: 'filesystem write a.txt 成功', kind: 'artifact', source: 'derived' },
            { id: 'c2', text: '回复给出文件大小', check: '最终回复包含字节数', kind: 'answer', source: 'derived' },
        ],
        rounds: [],
        budget: { ...DEFAULT_GOAL_BUDGET },
        createdAt: 0,
        updatedAt: 0,
        startedAt: 0,
        noProgressStreak: 0,
        regressions: 0,
        consecutiveVerifierErrors: 0,
        consecutiveRoundErrors: 0,
        bestPassedCriteria: [],
        processedSubmissions: {},
    };
}

function round(toolLog: GoalRound['toolLog'], outputSummary = '已创建 a.txt，大小 12 字节。'): GoalRound {
    return { round: 1, submissionId: 'goal:g:round:1', startedAt: 0, finishedAt: 1, status: 'completed', outputSummary, toolLog };
}

const okWrite = toGoalToolLogEntry(1, { tool: 'filesystem', action: 'write', ok: true, args: { path: 'D:/tmp/a.txt' }, result: { success: true } });
const failedWrite = toGoalToolLogEntry(1, { tool: 'filesystem', action: 'write', ok: false, args: { path: 'D:/tmp/a.txt' }, result: { success: false, error: 'EACCES' } });

test('a pass backed by a successful tool call is kept, with the evidence resolved from the log', async () => {
    const verification = await verifyGoalRound({
        llm: provider(JSON.stringify({
            criteria: [
                { id: 'c1', verdict: 'pass', evidence: [{ round: 1, toolCallIndex: 1, quote: 'wrote a.txt' }] },
                { id: 'c2', verdict: 'pass', evidence: [] },
            ],
            summary: 'both done',
            progressStatement: 'created the file',
        })),
        goal: goal(),
        round: round([okWrite]),
        now: () => 5,
    });
    assert.equal(verification.status, 'verified');
    assert.deepEqual(verification.verdicts.map(item => item.verdict), ['pass', 'pass']);
    assert.equal(verification.verdicts[0].evidence[0].tool, 'filesystem.write');
    assert.equal(verification.progressStatement, 'created the file');
});

test('a pass without resolvable evidence is downgraded to unknown', () => {
    const verdicts = validateVerdicts(goal(), round([okWrite]), {
        criteria: [
            { id: 'c1', verdict: 'pass', evidence: [] },
            { id: 'c2', verdict: 'pass' },
        ],
    })!;
    assert.equal(verdicts[0].verdict, 'unknown');
    assert.match(verdicts[0].note || '', /evidence_unresolved/);
    assert.equal(verdicts[1].verdict, 'pass', 'answer criteria may pass on the reply alone');
});

test('evidence pointing at a failed call or a missing index does not support a pass', () => {
    const failed = validateVerdicts(goal(), round([failedWrite]), {
        criteria: [{ id: 'c1', verdict: 'pass', evidence: [{ round: 1, toolCallIndex: 1 }] }],
    })!;
    assert.equal(failed[0].verdict, 'unknown');
    const missing = validateVerdicts(goal(), round([okWrite]), {
        criteria: [{ id: 'c1', verdict: 'pass', evidence: [{ round: 1, toolCallIndex: 9 }] }],
    })!;
    assert.equal(missing[0].verdict, 'unknown');
    const unlisted = validateVerdicts(goal(), round([okWrite]), { criteria: [] })!;
    assert.deepEqual(unlisted.map(item => item.verdict), ['unknown', 'unknown'], 'criteria the model skipped stay unknown');
});

test('evidence from an earlier round resolves against that round\'s log', () => {
    const record = goal();
    record.rounds.push({ ...round([okWrite]), round: 1 });
    const current: GoalRound = { ...round([]), round: 2, submissionId: 'goal:g:round:2' };
    const verdicts = validateVerdicts(record, current, {
        criteria: [{ id: 'c1', verdict: 'pass', evidence: [{ round: 1, toolCallIndex: 1 }] }],
    })!;
    assert.equal(verdicts[0].verdict, 'pass');
    assert.equal(verdicts[0].evidence[0].round, 1);
});

test('malformed audit replies are unparseable and model errors are recorded, never thrown', async () => {
    const garbage = await verifyGoalRound({ llm: provider('sure, looks done!'), goal: goal(), round: round([okWrite]) });
    assert.equal(garbage.status, 'unparseable');
    const failing = await verifyGoalRound({
        llm: provider(async () => { throw new Error('rate limited'); }),
        goal: goal(),
        round: round([okWrite]),
    });
    assert.equal(failing.status, 'error');
    assert.match(failing.error || '', /rate limited/);
    const none = await verifyGoalRound({ goal: goal(), round: round([okWrite]) });
    assert.equal(none.status, 'error');
});

test('a caller abort propagates out of the verifier', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
        verifyGoalRound({ llm: provider('{}'), goal: goal(), round: round([okWrite]), signal: controller.signal }),
        (error: unknown) => error instanceof Error && error.name === 'AbortError',
    );
});

test('criteria derivation keeps user criteria verbatim and falls back when the model is unusable', async () => {
    const derived = await deriveGoalCriteria({
        llm: provider(JSON.stringify({
            goal: '建两个文件',
            userPlan: '先建 a 再建 b',
            criteria: [
                { text: 'a.txt 存在', check: 'filesystem write', kind: 'artifact', source: 'user' },
                { text: '回复列出两个文件', check: '回复包含两个路径', kind: 'answer' },
                { text: '', check: 'ignored' },
            ],
        })),
        input: '建两个文件。验收标准：a.txt 存在',
    });
    assert.equal(derived.source, 'llm');
    assert.equal(derived.userPlan, '先建 a 再建 b');
    assert.deepEqual(derived.criteria.map(item => [item.id, item.source, item.kind]), [['c1', 'user', 'artifact'], ['c2', 'derived', 'answer']]);

    const fallback = await deriveGoalCriteria({ llm: provider('not json'), input: '把报告发给张三' });
    assert.equal(fallback.source, 'fallback');
    assert.equal(fallback.criteria.length, 1);
    assert.equal(fallback.criteria[0].source, 'fallback');

    const seeded = await deriveGoalCriteria({ llm: provider('nope'), input: 'x', seedCriteria: ['发送完成', '收到回执'] });
    assert.deepEqual(seeded.criteria.map(item => item.source), ['user', 'user']);
});

test('tool log entries are condensed and truncated', () => {
    const entry = toGoalToolLogEntry(3, { tool: 'process', action: 'run', ok: true, args: { command: 'x'.repeat(2000) }, result: 'y'.repeat(5000) });
    assert.equal(entry.index, 3);
    assert.equal(entry.action, 'run');
    assert.ok(entry.args.length <= 600);
    assert.ok(entry.result.length <= 2000);
});
