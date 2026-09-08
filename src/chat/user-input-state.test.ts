import assert from 'node:assert/strict';
import test from 'node:test';
import { canApplyUserInputAck, isUserInputComplete, userInputAnswers, UserInputDrafts, type UserInputRequest } from './user-input-state';

const request: UserInputRequest = {
    id: 'request-a', sessionId: 'session-a', turnId: 'turn-a', createdAt: 1, updatedAt: 1, status: 'pending',
    questions: [{ id: 'style', prompt: 'Which style?', kind: 'single', allowOther: true,
        options: [{ id: 'a', label: 'A', description: '', recommended: true }, { id: 'b', label: 'B', description: '' }] }],
};

test('recommended choices are not answers; whitespace and unknown options do not satisfy required questions', () => {
    assert.equal(isUserInputComplete(request, {}), false);
    assert.equal(isUserInputComplete(request, { style: { optionIds: ['unknown'], other: '  ' } }), false);
    assert.equal(isUserInputComplete(request, { style: { optionIds: [], other: ' My preference ' } }), true);
    assert.deepEqual(userInputAnswers(request, { style: { optionIds: ['a'], other: ' Custom ' } }), [
        { questionId: 'style', optionIds: [], other: 'Custom' },
    ]);
});

test('multiple selection accepts a custom addition, filters duplicates, and honors no-other questions', () => {
    const multiple: UserInputRequest = { ...request, questions: [{ ...request.questions[0], kind: 'multiple' }] };
    assert.deepEqual(userInputAnswers(multiple, { style: { optionIds: ['a', 'a', 'b', 'missing'], other: 'Extra' } }), [
        { questionId: 'style', optionIds: ['a', 'b'], other: 'Extra' },
    ]);
    const optionsOnly = { ...request, questions: [{ ...request.questions[0], allowOther: false }] };
    assert.equal(isUserInputComplete(optionsOnly, { style: { optionIds: [], other: 'Forbidden' } }), false);
});

test('draft identity is per session/request and equivalent retries reuse the same submission ID', () => {
    let ids = 0;
    const drafts = new UserInputDrafts(() => `submission-${++ids}`);
    drafts.get(request).answers.style = { optionIds: ['a'] };
    const first = drafts.submission(request);
    assert.deepEqual(drafts.submission({ ...request }), first);
    assert.deepEqual(drafts.get({ ...request, sessionId: 'another' }).answers, {});
    drafts.get(request).answers.style = { optionIds: [], other: 'Changed' };
    assert.notEqual(drafts.submission(request).submissionId, first.submissionId);
    drafts.clear(request);
    assert.deepEqual(drafts.get(request).answers, {});
});

test('old acknowledgements cannot erase pushed state or a subsequent question', () => {
    assert.equal(canApplyUserInputAck(3, 3, request.id, request), true);
    assert.equal(canApplyUserInputAck(3, 4, request.id, request), false);
    assert.equal(canApplyUserInputAck(3, 3, request.id, { ...request, id: 'next' }), false);
    assert.equal(canApplyUserInputAck(3, 3, request.id, { ...request, status: 'resolved' }), false);
    assert.equal(canApplyUserInputAck(3, 3, request.id, undefined), false);
});
