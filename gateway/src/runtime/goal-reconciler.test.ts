import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatWithToolsResponse, LLMProvider } from '../llm/provider';
import { createInitialGoalState, reconcileGoalState } from './goal-reconciler';

function providerReturning(output: string): LLMProvider {
    return {
        async chat(): Promise<string> { return output; },
        async chatStream(): Promise<string> { return output; },
        async chatWithTools(): Promise<ChatWithToolsResponse> { return { content: output, toolCalls: [] }; },
        getConfig: () => ({ provider: 'openai', model: 'goal-test' }),
        async embed(): Promise<number[]> { return []; },
        async embedBatch(): Promise<number[][]> { return []; },
    };
}

test('adds non-conflicting steering while preserving the original goal', async () => {
    const current = createInitialGoalState('清洗销售数据', 'original');
    const revision = await reconcileGoalState({
        llm: providerReturning(JSON.stringify({
            effectiveGoals: ['清洗销售数据', '输出 CSV'],
            preserved: ['清洗销售数据'],
            added: ['输出 CSV'],
            modified: [],
            superseded: [],
            cancelled: [],
            nextFocus: ['输出 CSV'],
        })),
        current,
        instructions: [{ id: 'steer-1', content: '另外输出 CSV' }],
        language: 'zh-CN',
    });

    assert.deepEqual(
        revision.state.goals.filter(goal => goal.status === 'active').map(goal => goal.text),
        ['清洗销售数据', '输出 CSV'],
    );
    assert.deepEqual(revision.delta.preserved, ['清洗销售数据']);
    assert.match(revision.detail, /新增：输出 CSV/);
});

test('does not let a parser silently drop an unrelated existing goal', async () => {
    const current = createInitialGoalState('校验结果', 'original');
    const revision = await reconcileGoalState({
        llm: providerReturning(JSON.stringify({
            effectiveGoals: ['增加摘要'],
            preserved: [],
            added: ['增加摘要'],
            modified: [],
            superseded: [],
            cancelled: [],
            nextFocus: ['增加摘要'],
        })),
        current,
        instructions: [{ id: 'steer-2', content: '增加摘要' }],
    });

    assert.deepEqual(
        revision.state.goals.filter(goal => goal.status === 'active').map(goal => goal.text),
        ['增加摘要', '校验结果'],
    );
    assert.ok(revision.delta.preserved.includes('校验结果'));
});

test('applies a newer instruction only to the conflicting goal', async () => {
    const current = createInitialGoalState('输出 JSON', 'original');
    const revision = await reconcileGoalState({
        llm: providerReturning(JSON.stringify({
            effectiveGoals: ['输出 CSV'],
            preserved: [],
            added: [],
            modified: [{ before: '输出 JSON', after: '输出 CSV' }],
            superseded: ['输出 JSON'],
            cancelled: [],
            nextFocus: ['输出 CSV'],
        })),
        current,
        instructions: [{ id: 'steer-3', content: '不要 JSON，改成 CSV' }],
        language: 'zh-CN',
    });

    assert.deepEqual(
        revision.state.goals.filter(goal => goal.status === 'active').map(goal => goal.text),
        ['输出 CSV'],
    );
    assert.equal(revision.state.goals.find(goal => goal.text === '输出 JSON')?.status, 'superseded');
    assert.match(revision.detail, /输出 JSON → 输出 CSV/);
});

test('falls back to preserve-and-append when the parser output is invalid', async () => {
    const current = createInitialGoalState('读取项目', 'original');
    const revision = await reconcileGoalState({
        llm: providerReturning('not-json'),
        current,
        instructions: [{ id: 'steer-4', content: '再运行测试' }],
        language: 'zh-CN',
    });

    assert.equal(revision.fallback, true);
    assert.deepEqual(
        revision.state.goals.filter(goal => goal.status === 'active').map(goal => goal.text),
        ['读取项目', '再运行测试'],
    );
    assert.match(revision.detail, /保守规则/);
});
