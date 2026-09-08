import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SessionStore } from '../sessions/store';
import { appendSessionMessage } from '../sessions/transcript';
import { SchedulerStore } from './store';
import { resolveSchedulerRun } from './run-resolver';
import type { TaskRun } from './types';

const longOutput = '模型价格监控结果：所有价格已逐项核对，本次记录包含来源与检查日期。'.repeat(8);

function harness() {
    const root = mkdtempSync(join(tmpdir(), 'openflux-run-resolver-test-'));
    const sessions = new SessionStore({ storePath: root });
    const run: TaskRun = {
        id: 'run-a', taskId: 'task-a', taskName: '模型价格日报', status: 'completed',
        startedAt: Date.now() - 1000, completedAt: Date.now() + 1000, output: longOutput,
    };
    const create = (id: string, cloudChatroomId?: number) => sessions.create('main', id, cloudChatroomId, undefined, id);
    const reply = (id: string, content = longOutput, metadata?: Record<string, unknown>) => sessions.addMessage(id, { role: 'assistant', content, metadata });
    const marker = (id: string, taskName = run.taskName, metadata?: Record<string, unknown>) => reply(id, `🕐 **定时任务触发：${taskName}**`, metadata);
    return { root, sessions, run, create, reply, marker, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('existing complete anchors return unchanged without reading sessions', () => {
    const run = { id: 'r', taskId: 't', taskName: 'Task', status: 'completed', startedAt: 1, sessionId: 'known', messageId: 'known-message' } as TaskRun;
    assert.equal(resolveSchedulerRun(run, { sessions: {
        list: () => { throw new Error('Must not scan anchored runs'); },
        getVisibleMessages: () => { throw new Error('Must not scan anchored runs'); },
    } }), run);
});

test('exact run and task metadata finds the real result rather than the current binding', t => {
    const h = harness(); t.after(h.close);
    h.create('current-binding'); h.create('historical-session');
    h.marker('current-binding'); h.reply('current-binding');
    h.marker('historical-session', h.run.taskName, { kind: 'scheduler_run_trigger', taskId: h.run.taskId, schedulerRunId: h.run.id });
    const expected = h.reply('historical-session', 'Actual output', { kind: 'scheduler_run_result', taskId: h.run.taskId, schedulerRunId: h.run.id });
    const result = resolveSchedulerRun(h.run, { sessions: h.sessions, taskSessionId: 'current-binding' });
    assert.equal(result.sessionId, 'historical-session'); assert.equal(result.messageId, expected.id);
});

test('legacy named markers plus truncated output prefixes resolve only inside the current run window', t => {
    const h = harness(); t.after(h.close);
    h.create('historical-session');
    const run = { ...h.run, startedAt: Date.now() - 60_000, output: longOutput.slice(0, 120) };
    h.marker('historical-session');
    const expected = h.reply('historical-session');
    const result = resolveSchedulerRun(run, { sessions: h.sessions, taskSessionId: 'missing-new-binding' });
    assert.equal(result.sessionId, 'historical-session'); assert.equal(result.messageId, expected.id);
    assert.equal(resolveSchedulerRun({ ...run, startedAt: Date.now() + 10_000, completedAt: Date.now() + 20_000 }, { sessions: h.sessions }).messageId, undefined);
});

test('a unique substantial full output resolves without a matching named trigger despite interleaved messages', t => {
    const h = harness(); t.after(h.close);
    h.create('active-session');
    h.marker('active-session', 'Another task'); h.reply('active-session', 'Unrelated output');
    const expected = h.reply('active-session');
    const result = resolveSchedulerRun(h.run, { sessions: h.sessions, taskSessionId: 'wrong-current-binding' });
    assert.equal(result.sessionId, 'active-session'); assert.equal(result.messageId, expected.id);
});

test('deleted message mirrors and cloud sessions do not create false historical links or ambiguity', t => {
    const h = harness(); t.after(h.close);
    h.create('deleted-binding'); h.create('active-mirror'); h.create('cloud-session', 1);
    const expected = h.reply('deleted-binding');
    appendSessionMessage('active-mirror', expected, join(h.root, 'sessions'));
    h.sessions.updateMetadata('deleted-binding', { status: 'deleted' });
    h.reply('cloud-session');
    const result = resolveSchedulerRun(h.run, { sessions: h.sessions, taskSessionId: 'deleted-binding' });
    assert.equal(result.sessionId, 'active-mirror'); assert.equal(result.messageId, expected.id);
});

test('current bindings and default cron sessions without message evidence never become historical links', t => {
    const h = harness(); t.after(h.close);
    h.create('current-binding'); h.create(`cron:${h.run.taskId}`);
    h.reply('current-binding', 'Unrelated'); h.reply(`cron:${h.run.taskId}`, 'Other content');
    assert.equal(resolveSchedulerRun(h.run, { sessions: h.sessions, taskSessionId: 'current-binding' }), h.run);
});

test('short generic replies without markers and ambiguous identical replies remain unresolved', t => {
    const h = harness(); t.after(h.close);
    h.create('one'); h.reply('one', 'Done');
    const shortRun = { ...h.run, output: 'Done' };
    assert.equal(resolveSchedulerRun(shortRun, { sessions: h.sessions }), shortRun);
    h.reply('one'); h.create('two'); h.reply('two');
    assert.equal(resolveSchedulerRun(h.run, { sessions: h.sessions, taskSessionId: 'one' }), h.run);
});

test('same-name markers with multiple possible results or conflicting task metadata never guess', t => {
    const h = harness(); t.after(h.close);
    h.create('one'); h.marker('one'); h.reply('one', 'Prefix result one'); h.reply('one', 'Prefix result two');
    const run = { ...h.run, output: 'Prefix' };
    assert.equal(resolveSchedulerRun(run, { sessions: h.sessions }), run);
    h.create('two');
    h.marker('two', h.run.taskName, { taskId: 'different-task', schedulerRunId: 'different-run' });
    h.reply('two', 'Prefix result', { taskId: 'different-task', schedulerRunId: 'different-run' });
    assert.equal(resolveSchedulerRun(run, { sessions: h.sessions }), run);
});

test('a later trigger blocks borrowing its output, and duplicate exact metadata is ambiguous', t => {
    const h = harness(); t.after(h.close);
    h.create('one'); h.marker('one'); h.marker('one', 'Other task'); h.reply('one', 'Prefix from other task');
    const run = { ...h.run, output: 'Prefix' };
    assert.equal(resolveSchedulerRun(run, { sessions: h.sessions }), run);
    const metadata = { kind: 'scheduler_run_result', schedulerRunId: run.id, taskId: run.taskId };
    h.reply('one', 'Output one', metadata); h.create('two'); h.reply('two', 'Output two', metadata);
    assert.equal(resolveSchedulerRun(run, { sessions: h.sessions }), run);
});

test('a verified legacy failure anchor is returned without rewriting the stored run record', t => {
    const h = harness(); t.after(h.close);
    h.create('historical-session');
    const run = { ...h.run, status: 'failed' as const, output: undefined, error: 'Provider failed' };
    h.marker('historical-session');
    const expected = h.reply('historical-session', `定时任务「${run.taskName}」执行失败：${run.error}`);
    const store = new SchedulerStore({ storePath: h.root }); store.appendRun(run);
    const path = join(h.root, 'scheduler', 'runs.json');
    const before = readFileSync(path, 'utf8');
    const result = resolveSchedulerRun(store.loadRuns()[0], { sessions: h.sessions });
    assert.equal(result.messageId, expected.id); assert.equal(result.sessionId, 'historical-session');
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.equal(store.loadRuns()[0].sessionId, undefined);
});
