import assert from 'node:assert/strict';
import test from 'node:test';
import { goalCriteriaProgress, goalOwnsSession, goalStripModel, isGoalActive, type GoalRecord } from './goal-state';

function goal(overrides: Partial<GoalRecord> = {}): GoalRecord {
    return {
        id: 'g1',
        sessionId: 's1',
        status: 'running',
        goal: '整理故障时间线并生成 PPT',
        criteria: [
            { id: 'c1', text: 'A', check: 'a', kind: 'answer', source: 'derived' },
            { id: 'c2', text: 'B', check: 'b', kind: 'artifact', source: 'derived' },
        ],
        rounds: [{ round: 2, submissionId: 'goal:g1:round:2', startedAt: 1, status: 'running' }],
        budget: { maxRounds: 8, maxNoProgressRounds: 2, maxRoundIterations: 40, maxWallClockMs: 1 },
        createdAt: 0,
        updatedAt: 0,
        noProgressStreak: 0,
        regressions: 0,
        consecutiveVerifierErrors: 0,
        consecutiveRoundErrors: 0,
        bestPassedCriteria: ['c1'],
        ...overrides,
    };
}

test('a running goal offers pause and cancel and reports round and criteria progress', () => {
    const model = goalStripModel(goal())!;
    assert.equal(model.active, true);
    assert.equal(model.roundRunning, true);
    assert.equal(model.round, 2);
    assert.equal(model.maxRounds, 8);
    assert.deepEqual([model.passed, model.total], [1, 2]);
    assert.deepEqual(model.actions, ['pause', 'cancel']);
    assert.equal(model.statusKey, 'goal.status.running');
    assert.equal(model.noteKey, undefined);
});

test('pausing, paused and finished goals expose the matching actions and notes', () => {
    assert.deepEqual(goalStripModel(goal({ status: 'pausing' }))!.actions, ['cancel']);
    assert.equal(goalStripModel(goal({ status: 'pausing' }))!.noteKey, 'goal.note_pausing');
    const restarted = goalStripModel(goal({ status: 'paused', pauseReason: 'gateway_restart' }))!;
    assert.deepEqual(restarted.actions, ['resume', 'cancel']);
    assert.equal(restarted.noteKey, 'goal.paused_restart_note');
    const stopped = goalStripModel(goal({ status: 'stopped', stopReason: 'no_progress', finalReport: '# report' }))!;
    assert.equal(stopped.active, false);
    assert.deepEqual(stopped.actions, ['view_report']);
    assert.equal(stopped.noteKey, 'goal.stop_reason.no_progress');
    assert.deepEqual(goalStripModel(goal({ status: 'achieved' }))!.actions, []);
    assert.equal(goalStripModel(undefined), undefined);
});

test('active and progress helpers mirror the gateway definitions', () => {
    assert.equal(isGoalActive(goal()), true);
    assert.equal(isGoalActive(goal({ status: 'paused' })), true);
    assert.equal(isGoalActive(goal({ status: 'cancelled' })), false);
    assert.equal(goalOwnsSession(goal()), true);
    assert.equal(goalOwnsSession(goal({ status: 'pausing' })), true);
    assert.equal(goalOwnsSession(goal({ status: 'paused' })), false, 'a paused goal hands the composer back');
    assert.equal(goalOwnsSession(goal({ status: 'achieved' })), false);
    assert.deepEqual(goalCriteriaProgress(goal({ bestPassedCriteria: [] })), { passed: 0, total: 2 });
});
