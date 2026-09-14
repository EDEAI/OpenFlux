import assert from 'node:assert/strict';
import test from 'node:test';
import { applyRoundError, applyRoundVerification, assessRoundProgress, decideAfterRound, goalAchieved } from './goal-policy';
import { DEFAULT_GOAL_BUDGET, type GoalRecord, type GoalRound, type GoalRoundVerification } from './goal-types';

function goal(overrides: Partial<GoalRecord> = {}): GoalRecord {
    return {
        id: 'g',
        sessionId: 's',
        status: 'running',
        goal: 'goal',
        criteria: [
            { id: 'a', text: 'A', check: 'a', kind: 'action', source: 'derived' },
            { id: 'b', text: 'B', check: 'b', kind: 'artifact', source: 'derived' },
        ],
        rounds: [],
        budget: { ...DEFAULT_GOAL_BUDGET },
        createdAt: 0,
        updatedAt: 0,
        startedAt: 0,
        noProgressStreak: 0,
        regressions: 0,
        consecutiveVerifierErrors: 0,
        consecutiveRoundErrors: 0,
        bestPassedCriteria: [],
        processedSubmissions: {},
        ...overrides,
    };
}

function verified(passed: string[], failed: string[] = []): GoalRoundVerification {
    return {
        verifiedAt: 1,
        status: 'verified',
        verdicts: [
            ...passed.map(id => ({ criterionId: id, verdict: 'pass' as const, evidence: [{ round: 1, toolCallIndex: 1, tool: 't', summary: 's' }] })),
            ...failed.map(id => ({ criterionId: id, verdict: 'fail' as const, evidence: [] })),
        ],
    };
}

function round(n: number, verification?: GoalRoundVerification): GoalRound {
    return { round: n, submissionId: `goal:g:round:${n}`, startedAt: 0, finishedAt: 1, status: 'completed', ...(verification ? { verification } : {}) };
}

/** Run one verified round through the counters and return the goal. */
function settle(record: GoalRecord, verification: GoalRoundVerification | undefined, error = false): GoalRecord {
    const next = round(record.rounds.length + 1, verification);
    record.rounds.push(next);
    if (error) applyRoundError(record, next);
    else applyRoundVerification(record, next);
    return record;
}

test('progress means a criterion passing for the first time', () => {
    const record = goal();
    settle(record, verified(['a'], ['b']));
    assert.equal(record.rounds[0].progress, 'progress');
    assert.equal(record.noProgressStreak, 0);
    settle(record, verified(['a'], ['b']));
    assert.equal(record.rounds[1].progress, 'none', 'repeating an earlier pass is not progress');
    assert.equal(record.noProgressStreak, 1);
    assert.deepEqual(decideAfterRound(record, 10), { next: 'continue' });
    settle(record, verified(['a'], ['b']));
    assert.deepEqual(decideAfterRound(record, 10), { next: 'stop', reason: 'no_progress' });
});

test('the goal is achieved when the latest verified round passes everything', () => {
    const record = goal();
    settle(record, verified(['a'], ['b']));
    assert.equal(goalAchieved(record), false);
    settle(record, verified(['a', 'b']));
    assert.equal(goalAchieved(record), true);
    assert.deepEqual(decideAfterRound(record, 10), { next: 'achieved' });
    assert.equal(goalAchieved(goal({ criteria: [] })), false, 'no criteria can never be achieved');
});

test('a passed criterion failing again is a regression and two of them stop the goal', () => {
    const record = goal();
    settle(record, verified(['a'], ['b']));
    settle(record, verified([], ['a', 'b']));
    assert.equal(record.rounds[1].progress, 'regression');
    assert.equal(record.regressions, 1);
    assert.deepEqual(record.bestPassedCriteria, ['a'], 'the best set never shrinks');
    settle(record, verified(['b'], ['a']));
    assert.equal(record.rounds[2].progress, 'regression', 'a new pass does not excuse a regression');
    assert.deepEqual(decideAfterRound(record, 10), { next: 'stop', reason: 'oscillating' });
});

test('unverifiable rounds and thrown rounds have their own caps', () => {
    const errors = goal();
    settle(errors, { verifiedAt: 1, status: 'error', verdicts: [], error: 'timeout' });
    assert.equal(errors.rounds[0].progress, 'unverified');
    // The verifier retries internally; a round that still has no verdict stops
    // the goal rather than opening another round that cannot be judged either.
    assert.deepEqual(decideAfterRound(errors, 10), { next: 'stop', reason: 'verifier_unavailable' });
    const unparseable = goal();
    settle(unparseable, { verifiedAt: 1, status: 'unparseable', verdicts: [] });
    assert.deepEqual(decideAfterRound(unparseable, 10), { next: 'stop', reason: 'verifier_unavailable' });

    const thrown = goal();
    settle(thrown, undefined, true);
    settle(thrown, undefined, true);
    assert.deepEqual(decideAfterRound(thrown, 10), { next: 'stop', reason: 'round_errors' });

    const recovered = goal();
    settle(recovered, undefined, true);
    settle(recovered, verified(['a'], ['b']));
    assert.equal(recovered.consecutiveRoundErrors, 0, 'a verified round clears the error streak');
});

test('hard budgets: max rounds and wall clock', () => {
    const record = goal({ budget: { ...DEFAULT_GOAL_BUDGET, maxRounds: 2, maxNoProgressRounds: 5 } });
    settle(record, verified(['a'], ['b']));
    assert.deepEqual(decideAfterRound(record, 10), { next: 'continue' });
    settle(record, verified(['b'], ['a']));
    assert.deepEqual(decideAfterRound(record, 10), { next: 'stop', reason: 'max_rounds' });

    const slow = goal({ budget: { ...DEFAULT_GOAL_BUDGET, maxWallClockMs: 1000 }, startedAt: 0 });
    settle(slow, verified(['a'], ['b']));
    assert.deepEqual(decideAfterRound(slow, 999), { next: 'continue' });
    assert.deepEqual(decideAfterRound(slow, 1000), { next: 'stop', reason: 'wall_clock' });
});

test('a user hold wins over every other outcome', () => {
    for (const status of ['pausing', 'paused', 'cancelled'] as const) {
        const record = goal({ status });
        settle(record, verified(['a', 'b']));
        assert.deepEqual(decideAfterRound(record, 10), { next: 'hold' }, status);
    }
    assert.deepEqual(assessRoundProgress(goal(), round(1)), { progress: 'unverified', passedNow: [], newlyPassed: [], regressed: [] });
});
