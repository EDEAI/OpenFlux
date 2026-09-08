import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { type ActiveExecution, ExecutionRegistry } from './execution-registry';
import { getAgentExecutionContext } from '../runtime/execution-context';

test('serializes the same session without publishing queued work as active', async () => {
    const registry = new ExecutionRegistry();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });

    const first = registry.run({ key: 's1', sessionId: 's1', turnId: 't1' }, async () => {
        order.push('first:start');
        await firstGate;
        order.push('first:end');
        return 1;
    });
    const second = registry.run({ key: 's1', sessionId: 's1', turnId: 't2' }, async () => {
        order.push('second:start');
        return 2;
    });

    await delay(5);
    assert.equal(registry.get('s1')?.turnId, 't1');
    assert.deepEqual(order, ['first:start']);
    releaseFirst();
    assert.deepEqual(await Promise.all([first, second]), [1, 2]);
    assert.deepEqual(order, ['first:start', 'first:end', 'second:start']);
    assert.equal(registry.activeCount, 0);
});

test('cancels only the active run and propagates isolated execution context', async () => {
    const registry = new ExecutionRegistry();
    const run = registry.run({ key: 's2', sessionId: 's2', turnId: 'turn-2' }, async execution => {
        const context = getAgentExecutionContext();
        assert.equal(context?.sessionId, 's2');
        assert.equal(context?.turnId, 'turn-2');
        assert.equal(context?.runId, execution.runId);
        await new Promise<void>((_resolve, reject) => {
            execution.controller.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
    });

    await delay(5);
    assert.equal(registry.abort('s2'), true);
    await assert.rejects(run, /aborted/);
    assert.equal(registry.abort('s2'), false);
});

test('a delayed stop cannot abort the run that replaced its target', async () => {
    const registry = new ExecutionRegistry();
    let releaseOld!: () => void;
    const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });

    const oldRun = registry.enqueue({ key: 'session', sessionId: 'session', turnId: 'old' }, async () => {
        // Deliberately ignores AbortSignal to model a remote provider request.
        await oldGate;
        return 'late-old-result';
    });
    const oldResult = assert.rejects(oldRun.result, error => {
        assert.equal((error as any).code, 'EXECUTION_ABORTED');
        return true;
    });
    const nextRun = registry.enqueue({ key: 'session', sessionId: 'session', turnId: 'next' }, async execution => {
        assert.equal(execution.runId, nextRun.runId);
        return 'next-result';
    });

    assert.equal(registry.abortIfCurrent('session', { runId: oldRun.runId, turnId: 'old' }), true);
    assert.equal(await nextRun.result, 'next-result');
    assert.equal(
        registry.abortIfCurrent('session', { runId: oldRun.runId, turnId: 'old' }),
        false,
        'a stale stop must not hit the replacement run',
    );
    await oldResult;

    releaseOld();
    await delay(5);
    assert.equal(registry.activeCount, 0);
});

test('abort gate releases FIFO immediately even when old work never cooperates', async () => {
    const registry = new ExecutionRegistry();
    let oldSettled = false;
    let releaseOld!: () => void;
    const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
    const oldRun = registry.enqueue({ key: 's3', turnId: 't1' }, async () => {
        await oldGate;
        oldSettled = true;
    });
    const ignoredAbort = oldRun.result.catch(() => undefined);

    let secondStarted = false;
    const second = registry.enqueue({ key: 's3', turnId: 't2' }, async () => {
        secondStarted = true;
        return 2;
    });
    registry.abortIfCurrent('s3', { runId: oldRun.runId, turnId: 't1' });

    assert.equal(await second.result, 2);
    assert.equal(secondStarted, true);
    assert.equal(oldSettled, false, 'new work did not wait for late settlement');
    releaseOld();
    await ignoredAbort;
});

test('supports queued cancellation and deterministic reordering', async () => {
    const registry = new ExecutionRegistry();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const first = registry.enqueue({ key: 'fifo', turnId: 'one' }, async () => {
        order.push('one');
        await gate;
        return 'one';
    });
    const second = registry.enqueue({ key: 'fifo', turnId: 'two' }, async () => {
        order.push('two');
        return 'two';
    });
    const canceled = registry.enqueue({ key: 'fifo', turnId: 'three' }, async () => {
        order.push('three');
        return 'three';
    });
    const fourth = registry.enqueue({ key: 'fifo', turnId: 'four' }, async () => {
        order.push('four');
        return 'four';
    });
    const canceledResult = assert.rejects(canceled.result, error => {
        assert.equal((error as any).code, 'QUEUED_EXECUTION_CANCELED');
        return true;
    });

    assert.equal(canceled.cancel(), true);
    assert.equal(registry.reorderQueued('fifo', [fourth.runId, second.runId]), true);
    assert.deepEqual(registry.snapshot('fifo').queue.map(item => item.turnId), ['four', 'two']);
    releaseFirst();

    assert.deepEqual(await Promise.all([first.result, fourth.result, second.result]), ['one', 'four', 'two']);
    await canceledResult;
    assert.deepEqual(order, ['one', 'four', 'two']);
});

test('stop can pause pending work until an explicit resume', async () => {
    const registry = new ExecutionRegistry();
    const current = registry.enqueue({ key: 'paused', turnId: 'current' }, async execution => {
        await new Promise<void>(resolve => execution.controller.signal.addEventListener('abort', () => resolve()));
    });
    const currentResult = current.result.catch(() => undefined);
    let queuedStarted = false;
    const queued = registry.enqueue({ key: 'paused', turnId: 'queued' }, async () => {
        queuedStarted = true;
        return 'resumed';
    });

    assert.equal(registry.abortIfCurrent(
        'paused',
        { runId: current.runId, turnId: 'current' },
        undefined,
        { pauseQueue: true },
    ), true);
    await currentResult;
    await delay(5);
    assert.equal(queuedStarted, false);
    assert.equal(registry.snapshot('paused').paused, true);
    assert.equal(registry.snapshot('paused').queue[0]?.status, 'paused');

    assert.equal(registry.resumeQueue('paused'), true);
    assert.equal(await queued.result, 'resumed');
});

test('a pause gate can be restored before the first in-memory enqueue', async () => {
    const registry = new ExecutionRegistry();
    assert.equal(registry.pauseQueue('restored'), true);
    let started = false;
    const handle = registry.enqueue({ key: 'restored', turnId: 'queued' }, async () => {
        started = true;
        return 'done';
    });
    await delay(2);
    assert.equal(started, false);
    assert.equal(registry.snapshot('restored').paused, true);
    assert.equal(handle.position, 1);
    assert.equal(registry.resumeQueue('restored'), true);
    assert.equal(await handle.result, 'done');
});

test('rehydrates a durable run id and rejects reuse even after logical completion', async () => {
    const registry = new ExecutionRegistry();
    registry.pauseQueue('rehydrated');
    const handle = registry.enqueue({
        key: 'rehydrated',
        sessionId: 'rehydrated',
        turnId: 'turn-from-disk',
        runId: 'durable-item-id',
    }, async execution => {
        assert.equal(execution.runId, 'durable-item-id');
        assert.equal(getAgentExecutionContext()?.runId, 'durable-item-id');
        return 'restored';
    });

    assert.equal(handle.runId, 'durable-item-id');
    assert.throws(() => registry.enqueue({
        key: 'another-session',
        runId: 'durable-item-id',
    }, async () => 'duplicate'), /already allocated/);
    registry.resumeQueue('rehydrated');
    assert.equal(await handle.result, 'restored');
    assert.throws(() => registry.enqueue({
        key: 'rehydrated',
        runId: 'durable-item-id',
    }, async () => 'late duplicate'), /already allocated/);
    assert.throws(() => registry.enqueue({
        key: 'rehydrated',
        runId: '   ',
    }, async () => 'invalid'), /non-empty/);
});

test('run lease and steering mailbox are scoped to the exact active run', async () => {
    const registry = new ExecutionRegistry();
    let execution!: ActiveExecution;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const handle = registry.enqueue({ key: 'steer', turnId: 'turn' }, async current => {
        execution = current;
        await gate;
        return current.drainSteering<string>();
    });
    await delay(1);

    assert.equal(execution.isCurrent(), true);
    assert.equal(registry.pushSteering(
        'steer',
        { runId: 'stale', turnId: 'turn' },
        'ignored',
    ), undefined);
    const accepted = registry.pushSteering(
        'steer',
        { runId: handle.runId, turnId: 'turn' },
        'change course',
    );
    assert.equal(accepted?.payload, 'change course');
    release();
    const drained = await handle.result;
    assert.deepEqual(drained.map(item => item.payload), ['change course']);
    assert.equal(execution.lease.isCurrent(), false);
    assert.equal(execution.lease.guard(() => 'late commit'), undefined);
});

test('intent epochs notify immediately and keep goal revisions in a separate mailbox', async () => {
    const registry = new ExecutionRegistry();
    let execution!: ActiveExecution;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const handle = registry.enqueue({ key: 'intent', turnId: 'turn' }, async current => {
        execution = current;
        await gate;
        return {
            steering: current.drainSteering<string>(),
            revisions: current.drainGoalRevisions<{ revision: number }>(),
        };
    });
    await delay(1);

    const notifications: Array<{ epoch: number; source: string }> = [];
    const unsubscribe = execution.onIntentInvalidated(0, (epoch, source) => {
        notifications.push({ epoch, source });
    });
    const target = { runId: handle.runId, turnId: 'turn' };
    const steer = registry.pushSteering('intent', target, 'add a constraint');
    const revision = registry.pushGoalRevision('intent', target, { revision: 1 }, 'revision-1');

    assert.equal(steer?.intentEpoch, 1);
    assert.equal(revision?.intentEpoch, 2);
    assert.equal(execution.getIntentEpoch(), 2);
    assert.deepEqual(notifications, [
        { epoch: 1, source: 'steer' },
        { epoch: 2, source: 'goal_revision' },
    ]);

    unsubscribe();
    release();
    const drained = await handle.result;
    assert.deepEqual(drained.steering.map(item => item.payload), ['add a constraint']);
    assert.deepEqual(drained.revisions.map(item => item.payload), [{ revision: 1 }]);
});
