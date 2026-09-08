import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGoalRoundPrompt, buildGoalVerifierPrompt, goalModeSystemPrompt, goalRoundTitle, markdownExcerpt, renderGoalReport } from './goal-prompts';
import { DEFAULT_GOAL_BUDGET, type GoalRecord } from './goal-types';

function goal(): GoalRecord {
    return {
        id: 'g',
        sessionId: 's',
        status: 'running',
        goal: '整理宕机时间线并生成 PPT',
        userPlan: '先搜索，再整理，最后生成',
        criteria: [
            { id: 'c1', text: '时间线已整理', check: '回复含时间线', kind: 'answer', source: 'derived' },
            { id: 'c2', text: 'PPT 已生成', check: 'generate_presentation 返回文件', kind: 'artifact', source: 'user' },
        ],
        rounds: [
            {
                round: 1,
                submissionId: 'goal:g:round:1',
                startedAt: 0,
                finishedAt: 1,
                status: 'completed',
                outputSummary: '## 本轮总结\n已完成：时间线。未完成：PPT。',
                toolLog: [{ index: 1, tool: 'web_search', ok: true, args: '{"q":"outage"}', result: '10 results' }],
                verification: {
                    verifiedAt: 2,
                    status: 'verified',
                    verdicts: [
                        { criterionId: 'c1', verdict: 'pass', evidence: [] },
                        { criterionId: 'c2', verdict: 'fail', evidence: [], note: '没有生成调用' },
                    ],
                    progressStatement: '时间线完成',
                },
                progress: 'progress',
            },
        ],
        budget: { ...DEFAULT_GOAL_BUDGET },
        createdAt: 0,
        updatedAt: 0,
        startedAt: 0,
        noProgressStreak: 0,
        regressions: 0,
        consecutiveVerifierErrors: 0,
        consecutiveRoundErrors: 0,
        bestPassedCriteria: ['c1'],
        processedSubmissions: {},
    };
}

test('the round prompt carries the goal, criteria state, history and the summary contract', () => {
    const prompt = buildGoalRoundPrompt(goal(), 2, 'zh-CN');
    assert.match(prompt, /第 2\/8 轮/);
    assert.match(prompt, /整理宕机时间线并生成 PPT/);
    assert.match(prompt, /先搜索，再整理，最后生成/);
    assert.match(prompt, /\[c1\].*已通过/);
    assert.match(prompt, /\[c2\].*未通过 — 没有生成调用/);
    assert.match(prompt, /第 1 轮：审计结果：通过 1\/2；时间线完成/);
    assert.match(prompt, /## 本轮总结/);
    const english = buildGoalRoundPrompt(goal(), 2, 'en-US');
    assert.match(english, /Goal mode round 2\/8/);
    assert.match(english, /## Round summary/);
});

test('the verifier prompt numbers the tool log and marks failed calls', () => {
    const record = goal();
    record.rounds[0].toolLog!.push({ index: 2, tool: 'filesystem', action: 'write', ok: false, args: '{}', result: 'EACCES' });
    const messages = buildGoalVerifierPrompt(record, record.rounds[0], 'zh-CN');
    assert.equal(messages[0].role, 'system');
    assert.match(String(messages[0].content), /工具调用日志是唯一事实来源/);
    assert.match(String(messages[1].content), /#1 web_search \[ok\]/);
    assert.match(String(messages[1].content), /#2 filesystem\.write \[FAILED\]/);
    assert.match(String(messages[1].content), /id=c2 kind=artifact/);
});

test('the report renders rounds, criteria with evidence, open items and a stop reason', () => {
    const record = goal();
    record.status = 'stopped';
    record.stopReason = 'no_progress';
    const report = renderGoalReport(record, 'zh-CN');
    assert.match(report, /## 目标报告/);
    assert.match(report, /⏹ 已停止（连续 2 轮没有新的验收项通过）/);
    assert.match(report, /\| 1 \| completed \| 1 \| 1\/2 \| 有进展 \|/);
    // Header, separator and rows must be contiguous or Markdown ends the table
    // after the separator and renders the rows as raw pipes.
    assert.match(report, /\|---\|---\|---\|---\|---\|\n\| 1 \|/);
    assert.match(report, /\|---\|---\|---\|---\|---\|---\|\n\| c1 \|/);
    assert.match(report, /\| c1 \| 时间线已整理 \| 通过 \| — \| R1 \| — \|/);
    assert.match(report, /### 未解决\n- \[c2\] PPT 已生成/);
    record.status = 'achieved';
    delete record.stopReason;
    assert.match(renderGoalReport(record, 'en-US'), /✅ Achieved/);
});

test('the last round summary keeps its Markdown structure and prefers the summary section', () => {
    const record = goal();
    record.status = 'achieved';
    record.rounds[0].outputSummary = [
        '前置分析（不需要出现在报告里）。',
        '',
        '## 本轮总结',
        '',
        '| 产品 | 定位 |',
        '|------|------|',
        '| **NexusAI** | 开源企业AI工作室 |',
        '',
        '- 已完成：客户清单',
        '- 未完成：无',
    ].join('\n');
    const report = renderGoalReport(record, 'zh-CN');
    const section = report.slice(report.indexOf('### 最后一轮总结'));
    assert.doesNotMatch(section, /前置分析/, 'only the summary section is quoted');
    assert.match(section, /\n\n## 本轮总结\n/);
    assert.match(section, /\| 产品 \| 定位 \|\n\|------\|------\|\n\| \*\*NexusAI\*\*/, 'table rows stay on their own lines');
    assert.match(section, /\n- 已完成：客户清单\n- 未完成：无/);
    assert.equal(markdownExcerpt('a\n'.repeat(10), 5), 'a\na\na\n…', 'cuts on a line boundary and marks the cut');
});

test('titles and the system block follow the language', () => {
    assert.equal(goalRoundTitle(3, 'zh-CN'), '目标模式 · 第 3 轮');
    assert.equal(goalRoundTitle(3, 'en'), 'Goal mode · round 3');
    assert.match(goalModeSystemPrompt('zh-CN'), /你无权宣布验收通过/);
    assert.match(goalModeSystemPrompt('en-US'), /You cannot declare a criterion passed/);
});
