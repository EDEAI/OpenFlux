import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ORPHANED_RUN_ERROR, Scheduler, type ScheduledTaskMeta } from './scheduler';
import { SchedulerStore } from './store';
import { SessionStore } from '../sessions/store';
import type { SchedulerEvent } from './types';
import { validateSchedulerTaskInput, validateSchedulerTrigger } from './validation';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

/** No start() call: all storage is temporary, and the only executor is an explicitly controlled fake. */
function harness(onEvent?: (event: SchedulerEvent) => void) {
    const root = mkdtempSync(join(tmpdir(), 'openflux-scheduler-test-'));
    const store = new SchedulerStore({ storePath: root });
    const events: SchedulerEvent[] = [];
    const pending = deferred<string>();
    const calls: Array<{ prompt: string; sessionId?: string; agentId?: string }> = [];
    const metas: ScheduledTaskMeta[] = [];
    const scheduler = new Scheduler({
        store,
        onAgentExecute: (prompt, sessionId, meta) => {
            calls.push({ prompt, sessionId, agentId: meta?.agentId });
            if (meta) metas.push(meta);
            return pending.promise;
        },
        onEvent: event => { events.push(event); onEvent?.(event); },
    });
    return { root, store, scheduler, events, pending, calls, metas, close: () => { scheduler.stop(); rmSync(root, { recursive: true, force: true }); } };
}

test('create/update persist notification choices and preserve an omitted workflow target', t => {
    const h = harness();
    t.after(h.close);
    const task = h.scheduler.createTask({
        name: 'Workflow', trigger: { type: 'interval', intervalMs: 60_000 },
        target: { type: 'workflow', workflowId: 'workflow-a', params: { format: 'pdf' } },
        agentId: 'agent-a', sessionId: 'session-a',
    });
    assert.equal(task.notificationPolicy, 'all');
    assert.equal(h.calls.length, 0, 'creating test records must not launch a timer or executor');
    assert.equal(h.scheduler.updateTask(task.id, { name: 'Renamed', notificationPolicy: 'none' }), true);
    const stored = h.store.loadTasks()[0];
    assert.equal(stored.name, 'Renamed');
    assert.equal(stored.notificationPolicy, 'none');
    assert.deepEqual(stored.target, { type: 'workflow', workflowId: 'workflow-a', params: { format: 'pdf' } });
    assert.equal(stored.sessionId, 'session-a');
    assert.equal(stored.agentId, 'agent-a');
    h.scheduler.updateTask(task.id, { sessionId: undefined });
    assert.equal(h.store.loadTasks()[0].sessionId, undefined);
});

test('legacy persisted tasks default to all notifications without starting the scheduler', t => {
    const h = harness();
    t.after(h.close);
    const task = h.scheduler.createTask({ name: 'Legacy', trigger: { type: 'interval', intervalMs: 60_000 }, target: { type: 'agent', prompt: 'Report' } });
    const { notificationPolicy: _policy, ...legacy } = task;
    writeFileSync(join(h.root, 'scheduler', 'tasks.json'), JSON.stringify([legacy]));
    assert.equal(h.store.loadTasks()[0].notificationPolicy, 'all');
    assert.equal(h.calls.length, 0);
});

test('manual requests acknowledge the actual run immediately and reject duplicate dispatch', async t => {
    const h = harness();
    t.after(h.close);
    const task = h.scheduler.createTask({ name: 'Report', trigger: { type: 'interval', intervalMs: 60_000 }, target: { type: 'agent', prompt: 'Report' }, sessionId: 'session-a' });
    const accepted = h.scheduler.requestTaskRun(task.id);
    assert.equal(accepted.accepted, true);
    if (!accepted.accepted) return;
    assert.equal(accepted.sessionId, 'session-a');
    assert.equal(h.calls.length, 1);
    assert.equal(h.scheduler.getRuns(task.id)[0].id, accepted.runId);
    assert.equal(h.scheduler.getRuns(task.id)[0].status, 'running');
    assert.ok(h.events.some(event => event.type === 'run_start' && event.runId === accepted.runId));
    assert.deepEqual(h.scheduler.requestTaskRun(task.id), { accepted: false, reason: 'already_running' });
    assert.equal(await h.scheduler.triggerTask(task.id), null, 'Agent-tool triggers share the same duplicate guard');
    assert.equal(h.calls.length, 1);
    h.pending.resolve('Completed report');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(h.scheduler.getRuns(task.id)[0].status, 'completed');
    assert.equal(h.scheduler.getRuns(task.id)[0].output, 'Completed report');
    assert.equal(h.scheduler.getRuns(task.id)[0].messageId, undefined, 'legacy executors must not receive fabricated message anchors');
    assert.ok(h.events.some(event => event.type === 'run_complete' && event.runId === accepted.runId));
});

test('a paused task runs manually without resuming or moving its schedule', async t => {
    const h = harness();
    t.after(h.close);
    assert.deepEqual(h.scheduler.requestTaskRun('missing'), { accepted: false, reason: 'not_found' });
    const task = h.scheduler.createTask({ name: 'Report', trigger: { type: 'interval', intervalMs: 60_000 }, target: { type: 'agent', prompt: 'Report' } });
    const pausedNextRunAt = task.nextRunAt;
    h.scheduler.pauseTask(task.id);
    const accepted = h.scheduler.requestTaskRun(task.id);
    assert.equal(accepted.accepted, true);
    if (!accepted.accepted) return;
    assert.equal(h.scheduler.getTask(task.id)?.status, 'paused');
    assert.equal(h.scheduler.getTask(task.id)?.nextRunAt, pausedNextRunAt);
    assert.deepEqual(h.scheduler.requestTaskRun(task.id), { accepted: false, reason: 'already_running' });
    h.pending.reject(new Error('Mock execution failed'));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(h.scheduler.getRuns(task.id)[0].status, 'failed');
    assert.ok(h.events.some(event => event.type === 'run_failed' && event.runId === accepted.runId));
    assert.equal(h.scheduler.getTask(task.id)?.status, 'paused');
    assert.equal(h.scheduler.getTask(task.id)?.nextRunAt, pausedNextRunAt);
    assert.equal(h.calls.length, 1);
});

test('Agent-tool manual trigger also completes a paused task without resuming it', async t => {
    const h = harness();
    t.after(h.close);
    const task = h.scheduler.createTask({ name: 'Paused report', trigger: { type: 'interval', intervalMs: 60_000 }, target: { type: 'agent', prompt: 'Report' } });
    const pausedNextRunAt = task.nextRunAt;
    h.scheduler.pauseTask(task.id);
    const pending = h.scheduler.triggerTask(task.id);
    assert.equal(h.calls.length, 1);
    assert.equal(h.scheduler.getTask(task.id)?.status, 'paused');
    h.pending.resolve('Completed while paused');
    const run = await pending;
    assert.equal(run?.status, 'completed');
    assert.equal(run?.output, 'Completed while paused');
    assert.equal(h.scheduler.getTask(task.id)?.status, 'paused');
    assert.equal(h.scheduler.getTask(task.id)?.nextRunAt, pausedNextRunAt);
});

test('normalized Sunday ranges produce a real Sunday next-run time without starting timers', t => {
    const h = harness();
    t.after(h.close);
    const task = h.scheduler.createTask({ name: 'Sunday report', trigger: validateSchedulerTrigger({ type: 'cron', expression: '0 9 * * 7-7' }), target: { type: 'agent', prompt: 'Report' } });
    assert.equal(typeof task.nextRunAt, 'number');
    const next = new Date(task.nextRunAt!);
    assert.equal(next.getDay(), 0);
    assert.equal(next.getHours(), 9);
    assert.equal(next.getMinutes(), 0);
    assert.equal(h.calls.length, 0);
});

test('a run-start listener cannot reenter dispatch, and a completed one-time task can run again ad hoc', async t => {
    let reentrant: ReturnType<Scheduler['requestTaskRun']> | undefined;
    const h = harness(event => {
        if (event.type === 'run_start') reentrant = h.scheduler.requestTaskRun(event.taskId);
    });
    t.after(h.close);
    const task = h.scheduler.createTask({ name: 'One-time report', trigger: { type: 'once', runAt: Date.now() - 1 }, target: { type: 'agent', prompt: 'Report' } });
    assert.equal(task.sessionId, undefined, 'creation does not create or bind the default session');
    const accepted = h.scheduler.requestTaskRun(task.id);
    assert.equal(accepted.accepted, true);
    if (!accepted.accepted) return;
    assert.equal(accepted.sessionId, `cron:${task.id}`);
    assert.equal(h.calls[0].sessionId, accepted.sessionId);
    assert.deepEqual(reentrant, { accepted: false, reason: 'already_running' });
    h.pending.resolve('Complete');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(h.scheduler.getTask(task.id)?.status, 'completed');
    assert.equal(h.scheduler.getTask(task.id)?.nextRunAt, undefined);
    const rerun = h.scheduler.requestTaskRun(task.id);
    assert.equal(rerun.accepted, true);
    if (!rerun.accepted) return;
    assert.deepEqual(h.scheduler.requestTaskRun(task.id), { accepted: false, reason: 'already_running' });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(h.scheduler.getTask(task.id)?.status, 'completed');
    assert.equal(h.scheduler.getTask(task.id)?.nextRunAt, undefined);
    assert.equal(h.scheduler.getRuns(task.id).length, 2);
    assert.equal(h.calls.length, 2);
});

test('completed recurring records remain ineligible for manual dispatch', t => {
    const h = harness();
    t.after(h.close);
    const task = h.scheduler.createTask({ name: 'Legacy completed interval', trigger: { type: 'interval', intervalMs: 60_000 }, target: { type: 'agent', prompt: 'Report' } });
    task.status = 'completed';
    h.store.saveTask(task);
    assert.deepEqual(h.scheduler.requestTaskRun(task.id), { accepted: false, reason: 'inactive' });
    assert.equal(h.calls.length, 0);
});

test('changing the selected conversation routes future runs to its owner without altering old runs', async t => {
    const h = harness();
    t.after(h.close);
    const task = h.scheduler.createTask({ name: 'Report', trigger: { type: 'interval', intervalMs: 60_000 }, target: { type: 'agent', prompt: 'Report' }, agentId: 'agent-a', sessionId: 'session-a' });
    const firstPending = h.scheduler.triggerTask(task.id);
    h.pending.resolve('Complete');
    const first = await firstPending;
    assert.equal(first?.sessionId, 'session-a');
    const patch = validateSchedulerTaskInput({ sessionId: 'session-b' }, {
        hasAgent: id => ['agent-a', 'agent-b'].includes(id),
        getSession: id => id === 'session-b' ? { agentId: 'agent-b', status: 'active' } : undefined,
    }, task);
    h.scheduler.updateTask(task.id, patch);
    const second = await h.scheduler.triggerTask(task.id);
    assert.equal(second?.sessionId, 'session-b');
    assert.equal(h.calls[1].sessionId, 'session-b');
    assert.equal(h.calls[1].agentId, 'agent-b');
    assert.equal(h.store.loadTasks()[0].agentId, 'agent-b');
    assert.equal(h.scheduler.getRuns(task.id).find(run => run.id === first!.id)?.sessionId, 'session-a');
    assert.equal(h.calls[0].agentId, 'agent-a');
});

for (const outcome of ['completed', 'failed'] as const) {
    test(`${outcome} runs persist the real final-message ID and actual session after routing`, async t => {
        const h = harness();
        t.after(h.close);
        const sessions = new SessionStore({ storePath: h.root });
        sessions.create('agent-a', 'Original', undefined, undefined, 'original-session');
        sessions.create('agent-a', 'Fallback', undefined, undefined, 'actual-session');
        const task = h.scheduler.createTask({ name: 'Report', trigger: { type: 'interval', intervalMs: 60_000 }, target: { type: 'agent', prompt: 'Report' }, sessionId: 'original-session', agentId: 'agent-a' });
        const accepted = h.scheduler.requestTaskRun(task.id);
        assert.equal(accepted.accepted, true);
        if (!accepted.accepted) return;
        const meta = h.metas[0];
        assert.equal(meta.schedulerRunId, accepted.runId);
        const trigger = sessions.addMessage('actual-session', {
            role: 'assistant', content: 'Scheduled run started',
            metadata: { kind: 'scheduler_run_trigger', taskId: task.id, schedulerRunId: meta.schedulerRunId },
        });
        const reply = sessions.addMessage('actual-session', {
            role: 'assistant', content: outcome === 'completed' ? 'The final report' : 'Execution failed: mock failure',
            metadata: { kind: outcome === 'completed' ? 'scheduler_run_result' : 'scheduler_run_error', taskId: task.id, schedulerRunId: meta.schedulerRunId },
        });
        meta.onMessageSaved?.({ sessionId: 'actual-session', messageId: reply.id });
        assert.equal(h.scheduler.getRuns(task.id)[0].messageId, reply.id, 'the anchor is durable as soon as the reply is saved');
        if (outcome === 'completed') h.pending.resolve('The final report');
        else h.pending.reject(new Error('Mock failure'));
        await new Promise<void>(resolve => setImmediate(resolve));
        const persisted = new SchedulerStore({ storePath: h.root }).loadRunsByTaskId(task.id)[0];
        assert.equal(persisted.status, outcome);
        assert.equal(persisted.sessionId, 'actual-session');
        assert.equal(persisted.messageId, reply.id);
        assert.notEqual(persisted.messageId, trigger.id);
        assert.ok(sessions.getMessages(persisted.sessionId!).some(message => message.id === persisted.messageId && message.content === reply.content));
        assert.ok(h.events.some(event => event.type === (outcome === 'completed' ? 'run_complete' : 'run_failed') && event.runId === persisted.id && event.sessionId === 'actual-session'));
        meta.onMessageSaved?.({ sessionId: 'original-session', messageId: trigger.id });
        assert.equal(h.scheduler.getRuns(task.id)[0].messageId, reply.id, 'a late callback cannot replace a settled run anchor');
    });
}

test('start() settles runs left in running state by a previous process without touching the task schedule', t => {
    const h = harness();
    t.after(h.close);
    const task = h.scheduler.createTask({
        name: 'Daily report', trigger: { type: 'interval', intervalMs: 60_000 },
        target: { type: 'agent', prompt: 'report' },
    });
    const before = h.store.loadTasks()[0];
    // Simulate a run that was in progress when the gateway was killed (dev rebuild, crash, updater relaunch).
    h.store.appendRun({ id: 'orphan-1', taskId: task.id, taskName: task.name, status: 'running', startedAt: Date.now() - 5_000, sessionId: 'cron:' + task.id });
    h.store.appendRun({ id: 'done-1', taskId: task.id, taskName: task.name, status: 'completed', startedAt: Date.now() - 90_000, completedAt: Date.now() - 80_000 });

    h.scheduler.start();

    const runs = h.store.loadRunsByTaskId(task.id);
    const orphan = runs.find(run => run.id === 'orphan-1')!;
    assert.equal(orphan.status, 'failed');
    assert.equal(orphan.error, ORPHANED_RUN_ERROR);
    assert.ok(orphan.completedAt && orphan.duration !== undefined && orphan.duration >= 5_000);
    assert.equal(runs.find(run => run.id === 'done-1')!.status, 'completed', 'settled runs are left alone');
    assert.ok(h.events.some(event => event.type === 'run_failed' && event.runId === 'orphan-1' && event.error === ORPHANED_RUN_ERROR));
    const after = h.store.loadTasks()[0];
    assert.equal(after.status, before.status);
    assert.equal(after.failCount, before.failCount, 'an interruption must not count towards auto-pause');
    assert.equal(after.runCount, before.runCount);
    assert.equal(h.calls.length, 0, 'settling does not re-run the task');
    // A second start is a no-op and finds nothing to settle.
    h.scheduler.stop();
    h.scheduler.start();
    assert.equal(h.store.loadRunsByTaskId(task.id).filter(run => run.status === 'running').length, 0);
});
