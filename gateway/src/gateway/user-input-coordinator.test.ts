import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ExecutionRegistry } from './execution-registry';
import { SessionStore } from '../sessions/store';
import { TurnQueueStore } from '../sessions/turn-queue-store';
import { recoverInterruptedTurnsAfterRestart } from '../sessions/turn-recovery';
import { UserInputStore } from '../work/user-input-store';
import type { PlanQuestion, PlanQuestionAnswer } from '../work/types';
import { UserInputCoordinator, type UserInputMessage } from './user-input-coordinator';

const questions: PlanQuestion[] = [{
    id: 'scope', prompt: '报告覆盖哪个市场？', kind: 'single',
    options: [
        { id: 'cn', label: '中国', description: '保留现有中国市场分析', recommended: true },
        { id: 'global', label: '全球', description: '增加海外市场分析' },
    ],
}];
const answers: PlanQuestionAnswer[] = [{ questionId: 'scope', optionIds: ['global'] }];

function createInput(sessionId = 's1', id = `question-${sessionId}`) {
    return {
        id, sessionId, turnId: `turn-${id}`, runId: `run-${id}`, questions,
        context: { input: '完成市场报告，沿用已下载的资料并生成最终文件。', agentId: 'researcher', approvalMode: 'ask' as const },
    };
}

interface HarnessOptions {
    failAnswerOnce?: boolean;
    crashAfterEnqueueOnce?: boolean;
    crashAfterCompletedOnce?: boolean;
    failSession?: string;
    beforeEnsure?: (sessionId: string, message: UserInputMessage) => Promise<void>;
}

function harness(directory: string, options: HarnessOptions = {}, started: string[] = []) {
    const store = new UserInputStore({ directory: join(directory, 'input') });
    const sessions = new SessionStore({ storePath: join(directory, 'sessions') });
    const queue = new TurnQueueStore({ filePath: join(directory, 'turn-queue.jsonl') });
    const registry = new ExecutionRegistry();
    const jobs = new Map<string, Promise<unknown>>();
    const changes: Array<{ requestId: string; reason: string }> = [];
    let enqueueCalls = 0;
    const pause = (sessionId: string) => {
        registry.pauseQueue(sessionId);
        queue.pause(sessionId);
    };
    const coordinator = new UserInputCoordinator({
        store,
        pauseSession: pause,
        ensureMessage: async (sessionId, message) => {
            await options.beforeEnsure?.(sessionId, message);
            if (options.failSession === sessionId) throw new Error('message persistence unavailable');
            if (message.metadata.kind === 'user_input_answer' && options.failAnswerOnce) {
                options.failAnswerOnce = false;
                throw new Error('crashed before answer message');
            }
            if (!sessions.get(sessionId)) sessions.create('researcher', sessionId, undefined, undefined, sessionId);
            if (sessions.getMessages(sessionId).some(item => item.metadata?.requestId === message.metadata.requestId
                && item.metadata?.kind === message.metadata.kind)) return;
            sessions.addMessage(sessionId, { role: message.role, content: message.content, metadata: message.metadata });
        },
        enqueueContinuation: async (request, displayAnswer, internalInput) => {
            enqueueCalls++;
            const existing = queue.getBySubmissionId(request.sessionId, request.continuationSubmissionId);
            if (existing && ['completed', 'failed', 'canceled'].includes(existing.status)) return;
            pause(request.sessionId);
            const item = queue.enqueue({
                sessionId: request.sessionId,
                submissionId: request.continuationSubmissionId,
                payload: { requestId: request.id, agentId: request.context.agentId, displayAnswer, internalInput },
            }).item;
            if (options.crashAfterEnqueueOnce) {
                options.crashAfterEnqueueOnce = false;
                throw new Error('crashed after durable enqueue');
            }
            if (!jobs.has(item.id)) {
                const handle = registry.enqueue({
                    key: request.sessionId, sessionId: request.sessionId,
                    runId: item.id, submissionId: request.continuationSubmissionId,
                }, async () => {
                    queue.setStatus(request.sessionId, item.id, 'dispatching');
                    started.push(request.id);
                    await Promise.resolve();
                    queue.complete(request.sessionId, item.id);
                });
                jobs.set(item.id, handle.result);
            }
            queue.move(request.sessionId, item.id, 1);
            registry.moveQueued(request.sessionId, { runId: item.id }, 1);
            // Release only this input hold after the fixed submission is durable.
            queue.resume(request.sessionId);
            registry.resumeQueue(request.sessionId);
            if (options.crashAfterCompletedOnce) {
                options.crashAfterCompletedOnce = false;
                await jobs.get(item.id);
                throw new Error('crashed before queued marker');
            }
        },
        onStateChanged: (request, reason) => { changes.push({ requestId: request.id, reason }); },
    });
    return { store, sessions, queue, registry, coordinator, jobs, started, changes, get enqueueCalls() { return enqueueCalls; } };
}

function temporary(t: { after(callback: () => void): void }): string {
    const directory = mkdtempSync(join(tmpdir(), 'openflux-user-input-coordinator-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    return directory;
}

async function drain(h: ReturnType<typeof harness>) {
    await Promise.all(h.jobs.values());
}

test('waiting holds both real queues before the original lease settles; answer runs before queued follow-up', async t => {
    const h = harness(temporary(t));
    let startQuestion!: () => void;
    const gate = new Promise<void>(resolve => { startQuestion = resolve; });
    let created!: ReturnType<UserInputStore['create']>;
    const first = h.registry.run({ key: 's1', sessionId: 's1', turnId: 'original' }, async execution => {
        await gate;
        const pending = h.coordinator.requestInput({ ...createInput(), runId: execution.runId });
        assert.equal(h.registry.snapshot('s1').paused, true, 'pause happens before requestInput first await');
        assert.equal(h.queue.snapshot('s1').paused, true);
        created = await pending;
        return 'waiting_input';
    });
    const next = h.registry.run({ key: 's1', sessionId: 's1', turnId: 'later' }, async () => {
        h.started.push('later');
    });
    startQuestion();
    assert.equal(await first, 'waiting_input');
    assert.deepEqual(h.started, []);
    assert.equal(h.registry.snapshot('s1').queue.length, 1);
    assert.equal(await h.registry.run({ key: 's2' }, async () => 'independent'), 'independent');
    const result = await h.coordinator.resolve('s1', created.id, 'answer-1', answers);
    await drain(h);
    await next;
    assert.equal(result.request.continuationQueued, true);
    assert.deepEqual(h.started, [created.id, 'later']);
    const messages = h.sessions.getMessages('s1');
    assert.deepEqual(messages.map(item => item.role), ['assistant', 'user']);
    assert.match(String(messages[0].content), /报告覆盖哪个市场/);
    assert.match(String(messages[1].content), /全球.*增加海外/);
    assert.equal((messages[0].metadata?.questions as PlanQuestion[])[0].id, 'scope');
    assert.deepEqual(messages[1].metadata?.answers, answers);
    const item = h.queue.getBySubmissionId<{ internalInput: string; agentId: string }>('s1', created.continuationSubmissionId)!;
    assert.equal(item.payload.agentId, 'researcher');
    assert.match(item.payload.internalInput, /沿用已下载的资料/);
    assert.match(item.payload.internalInput, /不要重复询问/);
});

test('concurrent identical answers enqueue once; changed answers, racing submissions and wrong sessions are rejected', async t => {
    const h = harness(temporary(t));
    const request = await h.coordinator.requestInput(createInput());
    const results = await Promise.all([
        h.coordinator.resolve('s1', request.id, 'answer-1', answers),
        h.coordinator.resolve('s1', request.id, 'answer-1', answers),
    ]);
    await drain(h);
    assert.deepEqual(results.map(item => item.duplicate), [false, true]);
    assert.equal(h.enqueueCalls, 1);
    assert.deepEqual(h.started, [request.id]);
    assert.equal(h.sessions.getMessages('s1').length, 2);
    await assert.rejects(h.coordinator.resolve('s1', request.id, 'answer-2', answers), /different/);
    await assert.rejects(h.coordinator.resolve('s1', request.id, 'answer-1', [{ questionId: 'scope', optionIds: ['cn'] }]), /different/);
    await assert.rejects(h.coordinator.resolve('s2', request.id, 'answer-1', answers), /missing/);
});

test('cancel wins its race, remains idempotent, and stale answers cannot replace a newer request', async t => {
    const h = harness(temporary(t));
    const old = await h.coordinator.requestInput(createInput());
    const cancelled = h.coordinator.cancel('s1', old.id);
    const lateAnswer = assert.rejects(h.coordinator.resolve('s1', old.id, 'late', answers), /pending/);
    await cancelled;
    await lateAnswer;
    await h.coordinator.cancel('s1', old.id);
    const newer = await h.coordinator.requestInput(createInput('s1', 'newer'));
    await assert.rejects(h.coordinator.resolve('s1', old.id, 'late', answers), /pending/);
    assert.equal(h.store.getPending('s1')?.id, newer.id);
    assert.equal(h.enqueueCalls, 0);
    assert.equal(h.queue.snapshot('s1').paused, true);
    assert.equal(h.sessions.getMessages('s1').filter(item => item.metadata?.kind === 'user_input_cancelled').length, 1);
});

test('answer wins its race with cancellation without losing its continuation', async t => {
    const h = harness(temporary(t));
    const request = await h.coordinator.requestInput(createInput());
    const resolved = h.coordinator.resolve('s1', request.id, 'answer-1', answers);
    const lateCancel = assert.rejects(h.coordinator.cancel('s1', request.id), /cannot be cancelled/);
    await resolved;
    await lateCancel;
    await drain(h);
    assert.deepEqual(h.started, [request.id]);
    assert.equal(h.store.get('s1', request.id)?.status, 'resolved');
});

test('startup and scoped reconnect restore pending questions without replaying work or duplicating messages', async t => {
    const directory = temporary(t);
    const first = harness(directory);
    await first.coordinator.requestInput(createInput('s1'));
    await first.coordinator.requestInput(createInput('s2'));
    const restored = harness(directory);
    assert.deepEqual(await restored.coordinator.recover('s1'), { pending: 1, continued: 0, errors: [] });
    assert.equal(restored.registry.snapshot('s1').paused, true);
    assert.equal(restored.registry.snapshot('s2').paused, false, 'scoped recovery touches only one runtime session');
    assert.deepEqual(await restored.coordinator.recover(), { pending: 2, continued: 0, errors: [] });
    assert.equal(restored.sessions.getMessages('s1').length, 1);
    assert.equal(restored.sessions.getMessages('s2').length, 1);
    assert.equal(restored.enqueueCalls, 0);
});

test('startup closes the interrupted asking turn without cancelling its durable question', async t => {
    const directory = temporary(t);
    const first = harness(directory);
    const request = await first.coordinator.requestInput(createInput());
    const original = first.queue.enqueue({
        id: request.runId, sessionId: request.sessionId, submissionId: 'original-submission',
        payload: { turnId: request.turnId },
    }).item;
    first.queue.setStatus('s1', original.id, 'dispatching');
    first.sessions.addEvent('s1', {
        version: 1, eventId: 'started', sessionId: 's1', turnId: request.turnId,
        runId: request.runId, seq: 1, timestamp: 100, type: 'turn.started',
    });
    const restored = harness(directory);
    const recovery = recoverInterruptedTurnsAfterRestart(restored.queue, restored.sessions);
    assert.equal(recovery.queueFailed, 1);
    assert.equal(recovery.interruptedEventsAppended, 1);
    assert.equal(restored.queue.get(original.id)?.status, 'failed');
    assert.equal(restored.store.getPending('s1')?.id, request.id);
    assert.deepEqual(await restored.coordinator.recover('s1'), { pending: 1, continued: 0, errors: [] });
    await restored.coordinator.resolve('s1', request.id, 'after-restart', answers);
    await drain(restored);
    assert.deepEqual(restored.started, [request.id]);
    assert.equal(restored.sessions.getMessages('s1').filter(item => item.metadata?.kind === 'user_input_answer').length, 1);
    assert.equal(restored.queue.get(original.id)?.status, 'failed');
});

test('answer persisted before a message failure is recovered into one visible answer and one durable continuation', async t => {
    const directory = temporary(t);
    const first = harness(directory, { failAnswerOnce: true });
    const request = await first.coordinator.requestInput(createInput());
    await assert.rejects(first.coordinator.resolve('s1', request.id, 'answer-1', answers), /before answer/);
    assert.equal(first.store.get('s1', request.id)?.status, 'resolved');
    assert.equal(first.queue.getBySubmissionId('s1', request.continuationSubmissionId), undefined);
    const restored = harness(directory);
    assert.deepEqual(await restored.coordinator.recover(), { pending: 0, continued: 1, errors: [] });
    await drain(restored);
    assert.equal(restored.sessions.getMessages('s1').length, 2);
    assert.deepEqual(restored.started, [request.id]);
    const retry = await restored.coordinator.resolve('s1', request.id, 'answer-1', answers);
    assert.equal(retry.duplicate, true);
    assert.equal(restored.enqueueCalls, 1);
});

test('a crash after durable enqueue is recovered using the exact original queue submission', async t => {
    const directory = temporary(t);
    const first = harness(directory, { crashAfterEnqueueOnce: true });
    const request = await first.coordinator.requestInput(createInput());
    await assert.rejects(first.coordinator.resolve('s1', request.id, 'answer-1', answers), /after durable enqueue/);
    const queued = first.queue.getBySubmissionId('s1', request.continuationSubmissionId)!;
    assert.equal(first.store.get('s1', request.id)?.continuationQueued, undefined);
    const restored = harness(directory);
    assert.deepEqual(await restored.coordinator.recover('s1'), { pending: 0, continued: 1, errors: [] });
    await drain(restored);
    assert.equal(restored.queue.getBySubmissionId('s1', request.continuationSubmissionId)?.id, queued.id);
    assert.equal(restored.queue.listByStatus('completed').length, 1);
    assert.equal(restored.sessions.getMessages('s1').length, 2);
    assert.deepEqual(restored.started, [request.id]);
});

test('completed continuation with a missing queued marker is reconciled without replay or changing a later Stop', async t => {
    const directory = temporary(t);
    const started: string[] = [];
    const first = harness(directory, { crashAfterCompletedOnce: true }, started);
    const request = await first.coordinator.requestInput(createInput());
    await assert.rejects(first.coordinator.resolve('s1', request.id, 'answer-1', answers), /before queued marker/);
    assert.deepEqual(started, [request.id]);
    first.queue.pause('s1'); // A later explicit Stop must remain authoritative.
    const restored = harness(directory, {}, started);
    assert.deepEqual(await restored.coordinator.recover(), { pending: 0, continued: 1, errors: [] });
    assert.deepEqual(started, [request.id]);
    assert.equal(restored.queue.snapshot('s1').paused, true);
    assert.equal(restored.registry.snapshot('s1').paused, false, 'terminal recovery did not create a new runtime pause');
    assert.equal(restored.store.get('s1', request.id)?.continuationQueued, true);
});

test('duplicate answered requests do not release a newer pending question or manually paused queue', async t => {
    const h = harness(temporary(t));
    const old = await h.coordinator.requestInput(createInput());
    await h.coordinator.resolve('s1', old.id, 'answer-1', answers);
    await drain(h);
    const newer = await h.coordinator.requestInput(createInput('s1', 'newer'));
    const changeCount = h.changes.length;
    await h.coordinator.resolve('s1', old.id, 'answer-1', answers);
    assert.equal(h.enqueueCalls, 1);
    assert.equal(h.changes.length, changeCount);
    assert.equal(h.registry.snapshot('s1').paused, true);
    assert.equal(h.queue.snapshot('s1').paused, true);
    assert.equal(h.store.getPending('s1')?.id, newer.id);
});

test('recovery failure in one session does not suppress another session and reports the failed request', async t => {
    const directory = temporary(t);
    const first = harness(directory);
    first.store.create(createInput('s1'));
    first.store.create(createInput('s2'));
    const restored = harness(directory, { failSession: 's1' });
    const result = await restored.coordinator.recover();
    assert.equal(result.pending, 1);
    assert.deepEqual(result.errors, [{ sessionId: 's1', requestId: 'question-s1', error: 'message persistence unavailable' }]);
    assert.equal(restored.registry.snapshot('s1').paused, true);
    assert.equal(restored.registry.snapshot('s2').paused, true);
    assert.equal(restored.sessions.getMessages('s2').length, 1);
});
