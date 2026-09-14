import assert from 'node:assert/strict';
import test from 'node:test';
import { assessFollowUpQuestions, countAnswerMessages, finalQuestions, questionTopics, toolErrorSummary } from './user-input-eval-report';
import { buildUserInputAnswerMessage, buildUserInputQuestionMessage } from '../src/gateway/user-input-coordinator';
import type { UserInputRequest } from '../src/work/user-input-types';

test('the observed HTML continuation offer is separate from a repeated requirement question', () => {
    const tail = finalQuestions('三个首版功能已经给出。\n**下一步**：如果你想直接开始，我可以帮你生成一个可运行的首版 HTML 文件。需要吗？');
    const measured = assessFollowUpQuestions({ questions: [], tailQuestionsHeuristic: tail }, new Set(['audience_purpose', 'skill_level', 'practice_goal', 'platform']));
    assert.equal(tail.length, 1);
    assert.deepEqual(measured.repeatedTopicsHeuristic, []);
    assert.equal(measured.routineFollowUpOffersHeuristic.length, 1);
});

test('plain final questions can still repeat a requirement even without another tool call', () => {
    const measured = assessFollowUpQuestions({ questions: [], tailQuestionsHeuristic: finalQuestions('这个工具是给谁使用的？你是自己用还是给别人用？') }, new Set(['audience_purpose']));
    assert.deepEqual(measured.repeatedTopicsHeuristic, ['audience_purpose']);
    assert.deepEqual(measured.routineFollowUpOffersHeuristic, []);
});

test('structured repeat detection distinguishes already answered and new topics', () => {
    const measured = assessFollowUpQuestions({ questions: [{ topics: ['audience_purpose'] }, { topics: ['technology'] }], tailQuestionsHeuristic: [] }, new Set(['audience_purpose', 'skill_level']));
    assert.deepEqual(measured.repeatedTopicsHeuristic, ['audience_purpose']);
});

test('product scope named a training platform does not imply a technical platform question', () => {
    assert.deepEqual(questionTopics({ id: 'focus', prompt: '你最想解决的核心训练场景是什么？', kind: 'single', options: [
        { id: 'basic', label: '基本功与技巧', description: '练习指法技巧' },
        { id: 'combined', label: '综合训练平台', description: '整合多种训练内容' },
    ] }), ['practice_goal']);
    assert.ok(questionTopics({ id: 'platform', prompt: '你希望在哪个平台上使用？', kind: 'single', options: [
        { id: 'web', label: '网页', description: '浏览器访问' },
        { id: 'mobile', label: '手机', description: '移动应用' },
    ] }).includes('platform'));
});

test('answer counts follow the actual coordinator metadata contract', () => {
    const request: UserInputRequest = {
        id: 'request', sessionId: 'session', turnId: 'turn', runId: 'run', createdAt: 1, updatedAt: 2, status: 'resolved',
        questions: [{ id: 'purpose', prompt: '给谁使用？', kind: 'single', options: [{ id: 'self', label: '自用', description: '个人练琴' }, { id: 'others', label: '他人', description: '公开产品' }] }],
        response: { submissionId: 'answer', submittedAt: 2, answers: [{ questionId: 'purpose', optionIds: [], other: '自己用' }] },
        continuationSubmissionId: 'continue', context: { input: '练琴工具' },
    };
    const answer = buildUserInputAnswerMessage(request);
    assert.equal(answer.metadata.kind, 'user_input_answer');
    assert.equal(countAnswerMessages([buildUserInputQuestionMessage(request), answer, { role: 'user', metadata: {} }]), 1);
});

test('failed tool summaries preserve schema diagnostics without dumping arguments, headers, or stacks', () => {
    const redact = (text: string, limit = 360) => text.replaceAll('fixture-secret', '[redacted]').slice(0, limit);
    const summary = toolErrorSummary({ success: false, code: 'INVALID_INPUT', error: 'Question kind must be single or multiple. fixture-secret', args: { credentials: 'do not expose' }, cause: { stack: 'private stack', headers: { authorization: 'private auth' } } }, redact);
    assert.deepEqual(summary, { code: 'INVALID_INPUT', message: 'Question kind must be single or multiple. [redacted]' });
    assert.equal(JSON.stringify(summary).includes('private'), false);
    assert.equal(toolErrorSummary({ success: false, error: new Error('questions_json must contain valid JSON.') }, redact).message, 'questions_json must contain valid JSON.');
});
