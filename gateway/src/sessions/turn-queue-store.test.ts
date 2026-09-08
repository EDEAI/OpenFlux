import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TurnQueueStore } from './turn-queue-store';
import { SessionStore } from './store';
import { recoverInterruptedTurnsAfterRestart } from './turn-recovery';
import type { AgentRuntimeEvent } from '../runtime/events';

function runtimeEvent(input: Partial<AgentRuntimeEvent> & Pick<AgentRuntimeEvent, 'seq' | 'timestamp' | 'type'>): AgentRuntimeEvent {
    return {
        version: 1,
        eventId: `event-${input.seq}`,
        sessionId: 'session:restart',
        turnId: 'turn-restart',
        runId: 'run-restart',
        ...input,
    };
}

test('persists FIFO, cancellation and reordering across reloads', () => {
    const directory = mkdtempSync(join(tmpdir(), 'openflux-turn-queue-'));
    try {
        const filePath = join(directory, 'queue.jsonl');
        let nextId = 0;
        const store = new TurnQueueStore({ filePath, idFactory: () => `item-${++nextId}` });
        const first = store.enqueue({ sessionId: 's1', submissionId: 'sub-1', payload: { text: 'one' } });
        const second = store.enqueue({ sessionId: 's1', submissionId: 'sub-2', payload: { text: 'two' } });
        const third = store.enqueue({ sessionId: 's1', submissionId: 'sub-3', payload: { text: 'three' } });

        assert.equal(store.reorder('s1', [third.item.id, first.item.id, second.item.id]), true);
        assert.equal(store.updatePayload('s1', third.item.id, { text: 'three edited' })?.position, 1);
        assert.equal(store.cancel('s1', second.item.id, 'removed'), true);
        assert.equal(store.pause('s1'), true);

        const reloaded = new TurnQueueStore({ filePath });
        assert.equal(reloaded.snapshot('s1').paused, true);
        assert.deepEqual(
            reloaded.snapshot<{ text: string }>('s1').queue.map(item => [item.payload.text, item.status]),
            [['three edited', 'paused'], ['one', 'paused']],
        );
        const duplicate = reloaded.enqueue({
            sessionId: 's1',
            submissionId: 'sub-1',
            payload: { text: 'different payload must not replace original' },
        });
        assert.equal(duplicate.created, false);
        assert.deepEqual(duplicate.item.payload, { text: 'one' });
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('recovers from a malformed tail and keeps submission ids idempotent', () => {
    const directory = mkdtempSync(join(tmpdir(), 'openflux-turn-queue-tail-'));
    try {
        const filePath = join(directory, 'queue.jsonl');
        const firstStore = new TurnQueueStore({ filePath });
        const first = firstStore.enqueue({ sessionId: 's2', submissionId: 'stable', payload: 'first' });
        appendFileSync(filePath, '{"partial":', 'utf8');

        const recovered = new TurnQueueStore({ filePath });
        assert.equal(recovered.getBySubmissionId('s2', 'stable')?.id, first.item.id);
        assert.equal(recovered.enqueue({ sessionId: 's2', submissionId: 'stable', payload: 'duplicate' }).created, false);
        const afterTail = recovered.enqueue({ sessionId: 's2', submissionId: 'after-tail', payload: 'second' });

        const reloadedAgain = new TurnQueueStore({ filePath });
        assert.equal(reloadedAgain.getBySubmissionId('s2', 'after-tail')?.id, afterTail.item.id);
        assert.deepEqual(reloadedAgain.snapshot('s2').queue.map(item => item.payload), ['first', 'second']);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('paused queues do not claim work and dispatching work is not replayed after restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'openflux-turn-queue-restart-'));
    try {
        const filePath = join(directory, 'queue.jsonl');
        const store = new TurnQueueStore({ filePath });
        const item = store.enqueue({ sessionId: 's3', submissionId: 'sub', payload: 'work' }).item;
        store.pause('s3');
        assert.equal(store.claimNext('s3'), undefined);
        store.resume('s3');
        assert.equal(store.claimNext('s3')?.id, item.id);
        store.pause('s3');
        assert.equal(store.snapshot('s3').active?.id, item.id);
        assert.deepEqual(store.snapshot('s3').queue, []);

        const restarted = new TurnQueueStore({ filePath });
        assert.equal(restarted.snapshot('s3').active?.id, item.id);
        assert.equal(restarted.recoverDispatching(), 1);
        assert.equal(restarted.get(item.id)?.status, 'failed');
        assert.equal(restarted.enqueue({ sessionId: 's3', submissionId: 'sub', payload: 'retry' }).created, false);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('restart recovery closes an orphaned turn at its last activity timestamp', () => {
    const directory = mkdtempSync(join(tmpdir(), 'openflux-turn-recovery-'));
    try {
        const sessions = new SessionStore({ storePath: directory });
        sessions.create('default', 'restart test', undefined, undefined, 'session:restart');
        sessions.addEvent('session:restart', runtimeEvent({ seq: 1, timestamp: 1_000, type: 'turn.started' }));
        sessions.addEvent('session:restart', runtimeEvent({
            seq: 2,
            timestamp: 1_350,
            type: 'item.completed',
            item: {
                id: 'action-1',
                kind: 'action',
                status: 'completed',
                title: 'Finished persisted work',
                startedAt: 1_100,
                completedAt: 1_350,
            },
        }));

        let now = 50_000_000;
        const queue = new TurnQueueStore({
            directory: join(directory, 'sessions'),
            clock: () => now++,
            idFactory: () => 'run-restart',
        });
        const queued = queue.enqueue({
            sessionId: 'session:restart',
            submissionId: 'submission-restart',
            payload: { turnId: 'turn-restart', input: 'resume me' },
        }).item;
        assert.equal(queue.claimNext('session:restart')?.status, 'dispatching');

        const recovered = recoverInterruptedTurnsAfterRestart(queue, sessions);

        assert.equal(recovered.dispatching, 1);
        assert.equal(recovered.candidates, 1);
        assert.equal(recovered.previouslyFailed, 0);
        assert.equal(recovered.queueFailed, 1);
        assert.equal(recovered.interruptedEventsAppended, 1);
        assert.deepEqual(recovered.eventIssues, []);
        assert.equal(queue.get(queued.id)?.status, 'failed');

        const terminal = sessions.getEvents('session:restart').at(-1)!;
        assert.equal(terminal.type, 'turn.interrupted');
        assert.equal(terminal.timestamp, 1_350);
        assert.equal(terminal.durationMs, 350);
        assert.equal(terminal.seq, 3);
        assert.equal(terminal.runId, 'run-restart');
        assert.equal(terminal.submissionId, 'submission-restart');
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('restart recovery repairs activity left open by an older queue-only recovery', () => {
    const directory = mkdtempSync(join(tmpdir(), 'openflux-turn-recovery-legacy-'));
    try {
        const sessions = new SessionStore({ storePath: directory });
        sessions.create('default', 'restart test', undefined, undefined, 'session:restart');
        sessions.addEvent('session:restart', runtimeEvent({ seq: 1, timestamp: 2_000, type: 'turn.started' }));
        sessions.addEvent('session:restart', runtimeEvent({
            seq: 2,
            timestamp: 2_400,
            type: 'item.completed',
            item: {
                id: 'checkpoint-legacy',
                kind: 'checkpoint',
                status: 'completed',
                title: 'Last persisted activity',
                startedAt: 2_400,
                completedAt: 2_400,
            },
        }));

        const queue = new TurnQueueStore({
            directory: join(directory, 'sessions'),
            idFactory: () => 'run-restart',
        });
        const queued = queue.enqueue({
            sessionId: 'session:restart',
            submissionId: 'submission-restart',
            payload: { turnId: 'turn-restart' },
        }).item;
        queue.claimNext('session:restart');
        queue.recoverDispatching();

        const recovered = recoverInterruptedTurnsAfterRestart(queue, sessions);

        assert.equal(recovered.candidates, 1);
        assert.equal(recovered.dispatching, 0);
        assert.equal(recovered.previouslyFailed, 1);
        assert.equal(recovered.queueFailed, 0);
        assert.equal(recovered.interruptedEventsAppended, 1);
        assert.equal(queue.get(queued.id)?.status, 'failed');
        const terminal = sessions.getEvents('session:restart').at(-1)!;
        assert.equal(terminal.type, 'turn.interrupted');
        assert.equal(terminal.timestamp, 2_400);
        assert.equal(terminal.durationMs, 400);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('restart recovery is idempotent when the terminal event was already persisted', () => {
    const directory = mkdtempSync(join(tmpdir(), 'openflux-turn-recovery-idempotent-'));
    try {
        const sessions = new SessionStore({ storePath: directory });
        sessions.create('default', 'restart test', undefined, undefined, 'session:restart');
        sessions.addEvent('session:restart', runtimeEvent({ seq: 1, timestamp: 1_000, type: 'turn.started' }));
        sessions.addEvent('session:restart', runtimeEvent({
            seq: 2,
            timestamp: 1_100,
            type: 'turn.interrupted',
            durationMs: 100,
        }));

        const queue = new TurnQueueStore({
            directory: join(directory, 'sessions'),
            idFactory: () => 'run-restart',
        });
        const queued = queue.enqueue({
            sessionId: 'session:restart',
            submissionId: 'submission-restart',
            payload: { turnId: 'turn-restart' },
        }).item;
        queue.claimNext('session:restart');

        const recovered = recoverInterruptedTurnsAfterRestart(queue, sessions);

        assert.equal(recovered.interruptedEventsAppended, 0);
        assert.equal(recovered.alreadyTerminal, 1);
        assert.equal(queue.get(queued.id)?.status, 'failed');
        assert.equal(
            sessions.getEvents('session:restart').filter(event => event.type === 'turn.interrupted').length,
            1,
        );
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
