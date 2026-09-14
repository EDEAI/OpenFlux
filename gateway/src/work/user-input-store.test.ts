import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { UserInputStore, validateUserInputQuestions, validateUserInputAnswers } from './user-input-store';
import type { PlanQuestion } from './types';

const questions: PlanQuestion[] = [{
    id: 'scope', prompt: 'Which scope?', kind: 'single',
    options: [
        { id: 'pilot', label: 'Pilot', description: 'One region', recommended: true },
        { id: 'all', label: 'All', description: 'Every region' },
    ],
}];
const answers = [{ questionId: 'scope', optionIds: ['pilot'] }];
function fixture(t: { after(fn: () => void): void }) {
    const directory = mkdtempSync(join(tmpdir(), 'openflux-user-input-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const store = new UserInputStore({ directory, now: () => 1_000 });
    const input = { id: 'request-a', sessionId: 'session-a', turnId: 'turn-a', runId: 'run-a', questions, context: { input: 'Roll out the change', agentId: 'agent-a', approvalMode: 'ask' as const } };
    return { directory, store, input };
}

test('pending requests and response outbox survive recreation without changing work mode or source identity', t => {
    const { directory, store, input } = fixture(t);
    const request = store.create(input);
    assert.equal(request.status, 'pending');
    assert.equal(request.questions[0].allowOther, true);
    assert.equal(request.questions[0].required, true);
    assert.equal(request.questions[0].options[0].recommended, true);
    assert.equal(request.response, undefined);
    assert.deepEqual(new UserInputStore({ directory }).getPending(input.sessionId), request);
    assert.deepEqual(store.listPending(), [request]);
    const result = store.resolve(input.sessionId, request.id, 'submission-a', answers);
    assert.equal(result.duplicate, false);
    assert.equal(store.getPending(input.sessionId), undefined);
    const restored = new UserInputStore({ directory });
    assert.deepEqual(restored.listUnqueuedResolved(), [result.request]);
    assert.equal(restored.listUnqueuedResolved()[0].continuationSubmissionId, request.continuationSubmissionId);
    assert.deepEqual(result.request.context, input.context);
    assert.equal(result.request.turnId, input.turnId);
    restored.markContinuationQueued(input.sessionId, request.id);
    restored.markContinuationQueued(input.sessionId, request.id);
    assert.deepEqual(new UserInputStore({ directory }).listUnqueuedResolved(), []);
    assert.ok(readdirSync(directory).every(file => /^[a-f0-9]{64}\.json(?:\.bak)?$/.test(file)));
});

test('only one outstanding request per session while other sessions and collision-prone session names stay isolated', t => {
    const { store, input } = fixture(t);
    store.create({ ...input, sessionId: 'a:b' });
    store.create({ ...input, sessionId: 'a_b', id: 'request-b' });
    assert.equal(store.getPending('a:b')?.id, input.id);
    assert.equal(store.getPending('a_b')?.id, 'request-b');
    assert.throws(() => store.create({ ...input, sessionId: 'a:b', id: 'new' }), /outstanding/);
    store.resolve('a:b', input.id!, 'answer', answers);
    assert.throws(() => store.create({ ...input, sessionId: 'a:b', id: 'new' }), /outstanding/);
    store.markContinuationQueued('a:b', input.id!);
    assert.equal(store.create({ ...input, sessionId: 'a:b', id: 'new' }).status, 'pending');
});

test('matching answer retries are idempotent; conflicting replies and cross-session or old requests cannot mutate state', t => {
    const { store, input, directory } = fixture(t);
    const request = store.create(input);
    assert.throws(() => store.resolve('different-session', request.id, 'answer', answers), /missing/);
    store.resolve(input.sessionId, request.id, 'answer', answers);
    const before = readdirSync(directory).filter(file => file.endsWith('.json')).map(file => readFileSync(join(directory, file), 'utf8'));
    const reopened = new UserInputStore({ directory });
    assert.equal(reopened.resolve(input.sessionId, request.id, 'answer', answers).duplicate, true);
    assert.throws(() => reopened.resolve(input.sessionId, request.id, 'other-submission', answers), /already been answered/);
    assert.throws(() => reopened.resolve(input.sessionId, request.id, 'answer', [{ questionId: 'scope', optionIds: ['all'] }]), /different/);
    assert.throws(() => reopened.resolve(input.sessionId, 'unknown', 'answer', answers), /missing/);
    assert.deepEqual(readdirSync(directory).filter(file => file.endsWith('.json')).map(file => readFileSync(join(directory, file), 'utf8')), before);
});

test('cancel is durable and idempotent, and late answers or continuation cannot revive cancelled requests', t => {
    const { store, input, directory } = fixture(t);
    const request = store.create(input);
    assert.throws(() => store.markContinuationQueued(input.sessionId, request.id), /Only answered/);
    store.cancel(input.sessionId, request.id);
    const reopened = new UserInputStore({ directory });
    assert.equal(reopened.cancel(input.sessionId, request.id).status, 'cancelled');
    assert.throws(() => reopened.resolve(input.sessionId, request.id, 'late', answers), /no longer pending/);
    assert.throws(() => reopened.markContinuationQueued(input.sessionId, request.id), /Only answered/);
    assert.deepEqual(reopened.listPending(), []);
    assert.deepEqual(reopened.listUnqueuedResolved(), []);
    reopened.create({ ...input, id: 'next' });
    reopened.resolve(input.sessionId, 'next', 'next-answer', answers);
    assert.throws(() => reopened.cancel(input.sessionId, 'next'), /cannot be cancelled/);
});

test('question validation preserves a freeform option, never chooses recommendations, and rejects malformed choices', () => {
    const normalized = validateUserInputQuestions([{ ...questions[0], allowOther: false }]);
    assert.equal(normalized[0].allowOther, true);
    assert.throws(() => validateUserInputAnswers(normalized, []), /required/);
    assert.deepEqual(validateUserInputAnswers(normalized, [{ questionId: 'scope', optionIds: [], other: '  Region B only  ' }]), [{ questionId: 'scope', optionIds: [], other: 'Region B only' }]);
    for (const invalid of [[], Array(4).fill(questions[0]), [{ ...questions[0], id: {} }], [questions[0], questions[0]], [{ ...questions[0], kind: 'free' }], [{ ...questions[0], required: 'yes' }], [{ ...questions[0], options: [questions[0].options[0]] }], [{ ...questions[0], options: [questions[0].options[0], questions[0].options[0]] }]]) {
        assert.throws(() => validateUserInputQuestions(invalid));
    }
    for (const invalid of [null, [...answers, ...answers], [{ questionId: 'missing', optionIds: [] }], [{ questionId: 'scope', optionIds: 'pilot' }], [{ questionId: 'scope', optionIds: ['unknown'] }], [{ questionId: 'scope', optionIds: ['pilot', 'all'] }], [{ questionId: 'scope', optionIds: ['pilot', 'pilot'] }], [{ questionId: 'scope', optionIds: [], other: {} }]]) {
        assert.throws(() => validateUserInputAnswers(normalized, invalid));
    }
});

test('multi-choice retries normalize answer ordering and reject reused submission ids on a later request', t => {
    const { store, input } = fixture(t);
    store.create({ ...input, questions: [{ ...questions[0], kind: 'multiple' }] });
    store.resolve(input.sessionId, input.id, 'submission', [{ questionId: 'scope', optionIds: ['all', 'pilot'] }]);
    assert.equal(store.resolve(input.sessionId, input.id, 'submission', [{ questionId: 'scope', optionIds: ['pilot', 'all'] }]).duplicate, true);
    store.markContinuationQueued(input.sessionId, input.id);
    store.create({ ...input, id: 'second' });
    assert.throws(() => store.resolve(input.sessionId, 'second', 'submission', answers), /already been used/);
});

test('corrupt primary falls back to the last durable snapshot and fully unreadable files fail closed', t => {
    const { store, input, directory } = fixture(t);
    store.create(input);
    store.resolve(input.sessionId, input.id, 'answer', answers);
    const file = readdirSync(directory).find(file => file.endsWith('.json'))!;
    writeFileSync(join(directory, file), '{broken');
    assert.equal(new UserInputStore({ directory }).getPending(input.sessionId)?.id, input.id);
    writeFileSync(join(directory, `${file}.bak`), '{also-broken');
    assert.throws(() => store.create({ ...input, id: 'replacement' }), /unreadable/);
    assert.throws(() => store.listUnqueuedResolved(), /Invalid/);
});
