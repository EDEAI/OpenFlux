import assert from 'node:assert/strict';
import test from 'node:test';
import {
    canAdvancePlanQuestion,
    firstIncompletePlanQuestionIndex,
    hasPlanQuestionAnswer,
    isPlanAnswerDraftComplete,
    latestPlanPreview,
    planAnswerDraftToResponse,
    type PlanInputRequest,
} from './plan-state';

const request: PlanInputRequest = {
    id: 'request',
    planId: 'plan',
    createdAt: 1,
    status: 'pending',
    questions: [
        {
            id: 'required', prompt: 'Required', kind: 'single', required: true, allowOther: true,
            options: [{ id: 'a', label: 'A', description: 'A' }, { id: 'b', label: 'B', description: 'B' }],
        },
        {
            id: 'optional', prompt: 'Optional', kind: 'multiple', required: false,
            options: [{ id: 'x', label: 'X', description: 'X' }, { id: 'y', label: 'Y', description: 'Y' }],
        },
    ],
};

test('plan draft completion requires every required question', () => {
    assert.equal(isPlanAnswerDraftComplete(request, {}), false);
    assert.equal(isPlanAnswerDraftComplete(request, { required: { optionIds: [], other: 'custom' } }), true);
});

test('plan draft response preserves question order and deduplicates options', () => {
    assert.deepEqual(planAnswerDraftToResponse(request, {
        required: { optionIds: ['a', 'a'] },
        optional: { optionIds: ['x'] },
    }), [
        { questionId: 'required', optionIds: ['a'] },
        { questionId: 'optional', optionIds: ['x'] },
    ]);
});

test('progressive plan questions open at the first unanswered required question', () => {
    assert.equal(firstIncompletePlanQuestionIndex(request, {}), 0);
    const draft = { required: { optionIds: ['a'] } };
    assert.equal(hasPlanQuestionAnswer(request.questions[0], draft), true);
    assert.equal(firstIncompletePlanQuestionIndex(request, draft), 1);
    assert.equal(canAdvancePlanQuestion(request.questions[1], draft), true);
});

test('latest plan preview points at the canonical Markdown file and latest revision', () => {
    const preview = latestPlanPreview({
        sessionId: 'session',
        mode: 'plan',
        planFilePath: 'C:\\Users\\tester\\.openflux\\plans\\plan.md',
        plan: {
            id: 'plan',
            sessionId: 'session',
            status: 'awaiting_approval',
            createdAt: 1,
            updatedAt: 3,
            revision: 2,
            inputRequests: [],
            revisions: [
                { revision: 1, createdAt: 1, markdown: '# One', document: {} as never },
                { revision: 2, createdAt: 2, markdown: '# Two', document: {} as never },
            ],
        },
    });
    assert.deepEqual(preview, {
        id: 'plan-preview-plan-2',
        planId: 'plan',
        revision: 2,
        createdAt: 2,
        markdown: '# Two',
        filePath: 'C:\\Users\\tester\\.openflux\\plans\\plan.md',
    });
    assert.equal(latestPlanPreview({ sessionId: 'session', mode: 'plan' }), undefined);
});
