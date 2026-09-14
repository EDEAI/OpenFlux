import assert from 'node:assert/strict';
import test from 'node:test';
import { scheduleDraft, triggerFromDraft } from '../../src/scheduler/model';
import type { ScheduledTaskView } from '../../src/gateway-client';
import { buildScheduledAgentPrompt, requireScheduledFinalOutput } from '../src/scheduler/execution';

test('existing recurring schedules survive opening and saving the editor', () => {
    const triggers: ScheduledTaskView['trigger'][] = [
        { type: 'cron', expression: '0 9 * * *' },
        { type: 'cron', expression: '45 18 * * 1-5' },
        { type: 'cron', expression: '30 7 * * 0' },
        { type: 'cron', expression: '*/15 8-18 * * 1-5' },
        { type: 'interval', intervalMs: 10000 },
        { type: 'interval', intervalMs: 90000 },
        { type: 'interval', intervalMs: 86400000 },
        { type: 'interval', intervalMs: 2147483647 },
    ];
    for (const trigger of triggers) assert.deepEqual(triggerFromDraft(scheduleDraft(trigger)), trigger);
});

test('one-off schedules preserve the instant when converting to the local datetime editor', () => {
    const runAt = '2030-04-20T16:45:00.000Z';
    const draft = scheduleDraft({ type: 'once', runAt });
    assert.equal(new Date(draft.runAt).getTime(), Date.parse(runAt));
    assert.deepEqual(triggerFromDraft(draft, Date.parse('2030-04-19T00:00:00Z')), { type: 'once', runAt });
    assert.throws(() => triggerFromDraft(draft, Date.parse(runAt)), /invalid_date/);
});

test('interval validation uses the scheduler backend limits of 10 seconds through 2147483647 milliseconds', () => {
    const draft = { ...scheduleDraft(), preset: 'interval' as const, unit: '1' };
    for (const interval of ['9999', '2147483648', 'Infinity', 'NaN', '-10000', '10000.5']) {
        assert.throws(() => triggerFromDraft({ ...draft, interval }), /invalid_interval/, interval);
    }
    for (const intervalMs of [10000, 2147483647]) {
        assert.deepEqual(triggerFromDraft({ ...draft, interval: String(intervalMs) }), { type: 'interval', intervalMs });
    }
});

test('scheduled execution writes one complete reply into its bound conversation', () => {
    const prompt = buildScheduledAgentPrompt({
        taskName: '服务状态监控',
        prompt: '检查 OpenAI、Anthropic 和 Grok 的状态',
        timeContext: '## 当前时间\n2026-09-06 23:00',
    });

    assert.match(prompt, /完整、可独立阅读的结果/);
    assert.match(prompt, /不要只回复计划、过渡语、查询意图或“正在处理”/);
    assert.match(prompt, /严禁调用 notify_user/);
    assert.match(prompt, /写入任务绑定的会话/);
    assert.match(prompt, /严禁调用 scheduler/);
    assert.match(prompt, /OpenAI、Anthropic 和 Grok/);
    assert.equal(requireScheduledFinalOutput({ status: 'completed', output: '  三个平台运行正常。  ' }), '三个平台运行正常。');
    assert.throws(
        () => requireScheduledFinalOutput({ status: 'completed', output: '   ' }),
        /没有生成可写入会话的最终回复/,
    );
    assert.throws(
        () => requireScheduledFinalOutput({ status: 'failed', output: '网络访问失败' }),
        /Agent 未完成定时任务（failed）：网络访问失败/,
    );
});
