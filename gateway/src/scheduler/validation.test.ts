import assert from 'node:assert/strict';
import test from 'node:test';
import { validateSchedulerTaskId, validateSchedulerTaskInput, validateSchedulerTrigger, type SchedulerBindingLookup } from './validation';
import type { ScheduledTask } from './types';

const now = Date.parse('2026-09-05T08:00:00Z');
const lookup: SchedulerBindingLookup = {
    hasAgent: id => ['agent-a', 'agent-b'].includes(id),
    getSession: id => ({
        'session-a': { agentId: 'agent-a', status: 'active' },
        'session-b': { agentId: 'agent-b', status: 'active' },
        'session-default': { agentId: 'default', status: 'active' },
        archived: { agentId: 'agent-a', status: 'archived' },
        deleted: { agentId: 'agent-a', status: 'deleted' },
        cloud: { agentId: 'agent-a', status: 'active', cloudChatroomId: 1 },
    })[id],
};
const input = {
    name: '  每日简报  ',
    trigger: { type: 'cron', expression: '0 9 * * 1-5' },
    target: { type: 'agent', prompt: '  汇总今天的重要变更  ' },
};
const workflow: ScheduledTask = {
    id: 'task-a', name: 'Weekly workflow', trigger: { type: 'cron', expression: '0 9 * * 1' },
    target: { type: 'workflow', workflowId: 'workflow-a', params: { report: { format: 'pdf' } } },
    status: 'active', createdAt: now, runCount: 0, failCount: 0, maxFailCount: 5,
    agentId: 'agent-a', sessionId: 'session-a',
};

test('task creation trims human text, defaults notifications, and derives the existing session owner', () => {
    const result = validateSchedulerTaskInput({ ...input, sessionId: 'session-a' }, lookup, undefined, now);
    assert.equal(result.name, '每日简报');
    assert.deepEqual(result.target, { type: 'agent', prompt: '汇总今天的重要变更' });
    assert.equal(result.agentId, 'agent-a');
    assert.equal(result.sessionId, 'session-a');
    assert.equal(result.notificationPolicy, 'all');
});

test('creation rejects missing content, unknown fields, and invalid notification policies', () => {
    for (const malformed of [
        null, [], {}, { ...input, name: '' }, { ...input, name: 42 },
        { ...input, target: { type: 'agent', prompt: '  ' } },
        { ...input, target: { type: 'unknown' } },
        { ...input, target: { type: 'workflow', workflowId: ' ' } },
        { ...input, target: { type: 'workflow', workflowId: 'a', params: [] } },
        { ...input, status: 'active' }, { ...input, notificationPolicy: 'sometimes' },
    ]) assert.throws(() => validateSchedulerTaskInput(malformed, lookup, undefined, now));
    assert.throws(() => validateSchedulerTaskId(undefined));
    assert.throws(() => validateSchedulerTaskId('  '));
});

test('binding validation refuses absent, archived, deleted, cloud, and mismatched sessions or agents', () => {
    for (const binding of [
        { sessionId: 'missing' }, { sessionId: 'archived' }, { sessionId: 'deleted' }, { sessionId: 'cloud' },
        { agentId: 'missing' }, { agentId: 'agent-a', sessionId: 'session-b' },
        { agentId: 123 }, { sessionId: '' }, { agentId: null },
    ]) assert.throws(() => validateSchedulerTaskInput({ ...input, ...binding }, lookup, undefined, now));
});

test('supported frequencies normalize safely and reject malformed or expired triggers', () => {
    assert.deepEqual(validateSchedulerTrigger({ type: 'cron', expression: '0 30 9 * * 1,3,5' }, now), { type: 'cron', expression: '30 9 * * 1,3,5' });
    assert.deepEqual(validateSchedulerTrigger({ type: 'cron', expression: '*/15 9-17 * * 1-5' }, now), { type: 'cron', expression: '*/15 9-17 * * 1-5' });
    assert.deepEqual(validateSchedulerTrigger({ type: 'cron', expression: '0 9 * * 6-7' }, now), { type: 'cron', expression: '0 9 * * 6,0' });
    assert.deepEqual(validateSchedulerTrigger({ type: 'cron', expression: '0 9 * * 7-7' }, now), { type: 'cron', expression: '0 9 * * 0' });
    assert.deepEqual(validateSchedulerTrigger({ type: 'interval', intervalMs: 60_000 }, now), { type: 'interval', intervalMs: 60_000 });
    assert.deepEqual(validateSchedulerTrigger({ type: 'once', runAt: now + 60_000 }, now), { type: 'once', runAt: new Date(now + 60_000).toISOString() });
    for (const trigger of [
        { type: 'cron', expression: '60 9 * * *' }, { type: 'cron', expression: '0 24 * * *' },
        { type: 'cron', expression: '0 9 0 * *' }, { type: 'cron', expression: '0 9 * 13 *' },
        { type: 'cron', expression: '0 9 * * 8' }, { type: 'cron', expression: '*/0 * * * *' },
        { type: 'cron', expression: '0 9 */32 * *' }, { type: 'cron', expression: '0 9 * */13 *' },
        { type: 'cron', expression: '0 9 * * 1-5/2' },
        { type: 'cron', expression: '0 9 * * 5-1' }, { type: 'cron', expression: 'every day' },
        { type: 'cron', expression: '15 0 9 * * *' }, { type: 'cron', expression: '0junk 9 * * *' },
        { type: 'interval', intervalMs: '60000' }, { type: 'interval', intervalMs: 9999 },
        { type: 'interval', intervalMs: 10000.5 }, { type: 'interval', intervalMs: 2_147_483_648 },
        { type: 'once', runAt: 'invalid' }, { type: 'once', runAt: now },
        { type: 'once', runAt: NaN }, { type: 'once', runAt: null }, { type: 'later' },
    ]) assert.throws(() => validateSchedulerTrigger(trigger, now));
});

test('partial editing preserves workflow targets and bindings while null explicitly unbinds', () => {
    const patch = validateSchedulerTaskInput({ name: 'Updated workflow', notificationPolicy: 'failed_only' }, lookup, workflow, now);
    assert.deepEqual(patch, { name: 'Updated workflow', notificationPolicy: 'failed_only' });
    const updated = { ...workflow, ...patch };
    assert.deepEqual(updated.target, workflow.target);
    assert.equal(updated.sessionId, 'session-a');
    assert.equal(updated.agentId, 'agent-a');
    const unbound = validateSchedulerTaskInput({ sessionId: null, agentId: null }, lookup, workflow, now);
    assert.equal(Object.hasOwn(unbound, 'sessionId'), true);
    assert.equal(Object.hasOwn(unbound, 'agentId'), true);
    assert.equal(unbound.sessionId, undefined);
    assert.equal(unbound.agentId, undefined);
    assert.throws(() => validateSchedulerTaskInput({}, lookup, workflow, now));
    assert.throws(() => validateSchedulerTaskInput({ agentId: 'agent-b' }, lookup, workflow, now));
    assert.deepEqual(validateSchedulerTaskInput({ agentId: 'agent-b', sessionId: null }, lookup, workflow, now), { agentId: 'agent-b', sessionId: undefined });
});

test('selecting a different conversation derives its owner and clears a stale owner for default sessions', () => {
    assert.deepEqual(validateSchedulerTaskInput({ sessionId: 'session-b' }, lookup, workflow, now), {
        sessionId: 'session-b', agentId: 'agent-b',
    });
    const defaultSession = validateSchedulerTaskInput({ sessionId: 'session-default' }, lookup, workflow, now);
    assert.equal(defaultSession.sessionId, 'session-default');
    assert.equal(Object.hasOwn(defaultSession, 'agentId'), true);
    assert.equal(defaultSession.agentId, undefined, 'the old Agent must not override a default conversation');
    assert.throws(() => validateSchedulerTaskInput({ sessionId: 'session-b', agentId: 'agent-a' }, lookup, workflow, now));
    assert.deepEqual(validateSchedulerTaskInput({ name: 'Renamed only' }, lookup, workflow, now), { name: 'Renamed only' });
});
