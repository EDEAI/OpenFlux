import assert from 'node:assert/strict';
import test from 'node:test';
import { findSchedulerRunMessageId, type SchedulerRunMessage } from '../../src/chat/scheduler-run-navigation';
import type { TaskRunView } from '../../src/gateway-client';

const run: TaskRunView = { id: 'run-a', taskId: 'task-a', taskName: 'Daily report', status: 'completed', startedAt: 10000, completedAt: 20000, output: 'Actual result' };
const message = (id: string, content: string, createdAt: number, metadata?: Record<string, unknown>): SchedulerRunMessage => ({ id, role: 'assistant', content, createdAt, metadata });
const trigger = message('trigger', '🕐 **定时任务触发：Daily report**', 10010);

test('an explicit persisted message ID is authoritative even when another message is closer in time', () => {
    const messages = [message('exact', 'Reply', 19000), message('nearby', 'Actual result', 20000)];
    assert.equal(findSchedulerRunMessageId(messages, { ...run, messageId: 'exact' }), 'exact');
    assert.equal(findSchedulerRunMessageId(messages, { ...run, messageId: 'deleted' }), undefined);
});

test('scheduler metadata chooses the run result instead of its trigger or another task', () => {
    const metadata = { taskId: run.taskId, schedulerRunId: run.id };
    assert.equal(findSchedulerRunMessageId([
        message('start', '', 10001, { ...metadata, kind: 'scheduler_run_trigger' }),
        message('result', '', 19000, { ...metadata, kind: 'scheduler_run_result' }),
        message('other', '', 20000, { ...metadata, taskId: 'other-task', kind: 'scheduler_run_result' }),
    ], run), 'result');
});

test('legacy runs require their named trigger and a unique result inside that run window', () => {
    assert.equal(findSchedulerRunMessageId([
        message('previous-result', 'Actual result', 9000), trigger,
        message('result', 'Actual result with the remainder omitted by the run log', 19999),
        message('next-result', 'Actual result', 22000),
    ], run), 'result');
});

test('a legacy failure locates its saved error reply', () => {
    assert.equal(findSchedulerRunMessageId([
        trigger, message('failure', '定时任务「Daily report」执行失败：Service unavailable', 19000),
    ], { ...run, status: 'failed', output: undefined, error: 'Service unavailable' }), 'failure');
});

test('nearby unrelated text and ambiguous trigger markers never produce a guessed anchor', () => {
    assert.equal(findSchedulerRunMessageId([message('other', 'Actual result', 19999)], run), undefined);
    assert.equal(findSchedulerRunMessageId([trigger, { ...trigger, id: 'second', createdAt: 11000 }], run), undefined);
});

test('a unique legacy trigger remains a valid run anchor when its reply is unavailable or ambiguous', () => {
    assert.equal(findSchedulerRunMessageId([trigger], run), 'trigger');
    assert.equal(findSchedulerRunMessageId([
        trigger, message('a', 'Actual result', 18000), message('b', 'Actual result', 19000),
    ], run), 'trigger');
});
