import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GoalStore } from './goal-store';
import { goalRoundSubmissionId, type GoalCriterion, type GoalRoundVerification } from './goal-types';
import { ActiveGoalError, PlanStore } from './store';

const criteria: GoalCriterion[] = [
    { id: 'c1', text: 'File a exists', check: 'filesystem read shows a.txt', kind: 'artifact', source: 'derived' },
    { id: 'c2', text: 'File b exists', check: 'filesystem read shows b.txt', kind: 'artifact', source: 'derived' },
];

function verification(passed: string[], failed: string[] = [], at = 100): GoalRoundVerification {
    return {
        verifiedAt: at,
        status: 'verified',
        verdicts: [
            ...passed.map(id => ({ criterionId: id, verdict: 'pass' as const, evidence: [{ round: 1, toolCallIndex: 1, tool: 'filesystem', summary: 'wrote' }] })),
            ...failed.map(id => ({ criterionId: id, verdict: 'fail' as const, evidence: [] })),
        ],
    };
}

function fixture(): { root: string; goals: GoalStore; plans: PlanStore } {
    const root = mkdtempSync(join(tmpdir(), 'openflux-goal-store-'));
    let clock = 1000;
    const now = () => (clock += 1);
    const goals = new GoalStore({ goalsDirectory: join(root, 'goals'), now });
    const plans = new PlanStore({
        plansDirectory: join(root, 'plans'),
        workStateDirectory: join(root, 'sessions'),
        now,
        resolveGoal: id => goals.getGoal(id),
    });
    return { root, goals, plans };
}

test('a goal runs from deriving through rounds to achieved', () => {
    const { root, goals, plans } = fixture();
    try {
        const goal = goals.create('s1', '建两个文件', { goalId: 'g1' });
        assert.equal(goal.status, 'deriving');
        plans.enterGoalMode('s1', goal.id);
        assert.equal(plans.getSnapshot('s1').mode, 'goal');
        assert.equal(plans.getSnapshot('s1').goal?.id, 'g1');

        const first = goals.startRound('s1', 'g1', 1);
        assert.equal(first.duplicate, false);
        assert.equal(goals.startRound('s1', 'g1', 1).duplicate, true, 'the same round is opened once');
        assert.throws(() => goals.startRound('s1', 'g1', 3), /out of order/);

        goals.setCriteria('s1', 'g1', criteria);
        assert.equal(goals.getGoal('g1')!.status, 'running');
        goals.attachRoundRun('s1', 'g1', 1, { turnId: 't1', runId: 'r1' });
        assert.equal(goals.finishRound('s1', 'g1', 1, { status: 'completed', outputSummary: 'made a.txt' }), true);
        assert.equal(goals.finishRound('s1', 'g1', 1, { status: 'completed' }), false, 'closing twice is a no-op');
        const afterOne = goals.recordVerification('s1', 'g1', 1, verification(['c1'], ['c2']));
        assert.equal(afterOne?.rounds[0].progress, 'progress');
        assert.deepEqual(afterOne?.bestPassedCriteria, ['c1']);
        assert.equal(goals.recordVerification('s1', 'g1', 1, verification(['c1'])), undefined, 'a round is verified once');

        goals.startRound('s1', 'g1', 2);
        goals.finishRound('s1', 'g1', 2, { status: 'completed', outputSummary: 'made b.txt' });
        const afterTwo = goals.recordVerification('s1', 'g1', 2, verification(['c1', 'c2']));
        assert.deepEqual(afterTwo?.bestPassedCriteria, ['c1', 'c2']);
        goals.finish('s1', 'g1', 'achieved');
        plans.leaveGoalMode('s1');
        const snapshot = plans.getSnapshot('s1');
        assert.equal(snapshot.mode, 'normal');
        assert.equal(snapshot.goal?.status, 'achieved', 'the finished goal stays reachable');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('dismissing a finished goal drops it from the work state, a live goal cannot be dismissed', () => {
    const { root, goals, plans } = fixture();
    try {
        goals.create('s1', 'goal', { goalId: 'g1' });
        plans.enterGoalMode('s1', 'g1');
        assert.throws(() => plans.dismissGoal('s1', 'g1'), ActiveGoalError);
        goals.cancel('s1', 'g1');
        plans.leaveGoalMode('s1');
        assert.equal(plans.getSnapshot('s1').goal?.id, 'g1', 'the finished goal is still shown until dismissed');
        assert.equal(plans.dismissGoal('s1', 'other-goal').goal?.id, 'g1', 'dismissing a different id is a no-op');
        const dismissed = plans.dismissGoal('s1', 'g1');
        assert.equal(dismissed.goal, undefined);
        assert.equal(dismissed.mode, 'normal');
        assert.equal(plans.getSessionWorkState('s1').goalId, undefined, 'the reference is gone after reload');
        assert.equal(goals.getGoal('g1')?.status, 'cancelled', 'the goal record itself is kept');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('mode changes and new plans are refused while a goal is live', () => {
    const { root, goals, plans } = fixture();
    try {
        goals.create('s1', 'goal', { goalId: 'g1' });
        plans.enterGoalMode('s1', 'g1');
        assert.throws(() => plans.setMode('s1', 'normal'), (error: unknown) => error instanceof ActiveGoalError && error.code === 'GOAL_ACTIVE');
        assert.throws(() => plans.createPlan('s1', 'p1'), ActiveGoalError);
        assert.throws(() => goals.create('s1', 'another').id && plans.enterGoalMode('s1', 'another'), ActiveGoalError);
        goals.cancel('s1', 'g1', 'cancel-1');
        assert.equal(goals.cancel('s1', 'g1', 'cancel-1').duplicate, true);
        plans.leaveGoalMode('s1');
        assert.equal(plans.setMode('s1', 'plan').mode, 'plan');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('pause waits for the live round, resume reopens, cancel closes the live round', () => {
    const { root, goals } = fixture();
    try {
        goals.create('s1', 'goal', { goalId: 'g1' });
        goals.startRound('s1', 'g1', 1);
        goals.setCriteria('s1', 'g1', criteria);
        assert.equal(goals.requestPause('s1', 'g1').status, 'pausing', 'a live round keeps the goal pausing');
        goals.finishRound('s1', 'g1', 1, { status: 'completed', outputSummary: 'x' });
        assert.ok(goals.recordVerification('s1', 'g1', 1, verification([], ['c1', 'c2'])), 'verification is banked while pausing');
        goals.markPaused('s1', 'g1');
        assert.equal(goals.getGoal('g1')!.status, 'paused');
        assert.throws(() => goals.startRound('s1', 'g1', 2), /paused/);

        assert.equal(goals.resume('s1', 'g1', 'resume-1').goal.status, 'running');
        assert.equal(goals.resume('s1', 'g1', 'resume-1').duplicate, true);
        assert.deepEqual(goals.resumeAction('g1'), { kind: 'enqueue_round', round: 2 });
        goals.startRound('s1', 'g1', 2);
        assert.equal(goals.requestPause('s1', 'g1').status, 'pausing');
        const cancelled = goals.cancel('s1', 'g1').goal;
        assert.equal(cancelled.status, 'cancelled');
        assert.equal(cancelled.rounds[1].status, 'cancelled');
        assert.equal(goals.recordVerification('s1', 'g1', 2, verification(['c1'])), undefined, 'nothing is banked after cancel');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('restart recovery parks live goals and never reuses an interrupted round number', () => {
    const { root, goals } = fixture();
    try {
        goals.create('s1', 'goal', { goalId: 'g1' });
        goals.startRound('s1', 'g1', 1);
        goals.setCriteria('s1', 'g1', criteria);
        goals.create('s2', 'idle goal', { goalId: 'g2' });
        goals.create('s3', 'done goal', { goalId: 'g3' });
        goals.startRound('s3', 'g3', 1);
        goals.setCriteria('s3', 'g3', criteria);
        goals.finishRound('s3', 'g3', 1, { status: 'completed', outputSummary: 'ok' });
        goals.recordVerification('s3', 'g3', 1, verification(['c1', 'c2']));
        goals.finish('s3', 'g3', 'achieved');

        const recovered = new GoalStore({ goalsDirectory: join(root, 'goals') }).recoverInterrupted();
        assert.deepEqual(
            recovered.sort((a, b) => a.goalId.localeCompare(b.goalId)),
            [{ sessionId: 's1', goalId: 'g1', interruptedRound: 1 }, { sessionId: 's2', goalId: 'g2' }],
        );
        const g1 = goals.getGoal('g1')!;
        assert.equal(g1.status, 'paused');
        assert.equal(g1.pauseReason, 'gateway_restart');
        assert.equal(g1.rounds[0].status, 'interrupted');
        assert.equal(goals.getGoal('g3')!.status, 'achieved');
        goals.resume('s1', 'g1');
        assert.deepEqual(goals.resumeAction('g1'), { kind: 'enqueue_round', round: 2 });
        assert.equal(goals.startRound('s1', 'g1', 2).round.round, 2);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('a round that closed without a verification is verified first on resume', () => {
    const { root, goals } = fixture();
    try {
        goals.create('s1', 'goal', { goalId: 'g1' });
        goals.startRound('s1', 'g1', 1);
        goals.setCriteria('s1', 'g1', criteria);
        goals.finishRound('s1', 'g1', 1, { status: 'completed', outputSummary: 'done' });
        goals.markPaused('s1', 'g1', 'gateway_restart');
        goals.resume('s1', 'g1');
        assert.deepEqual(goals.resumeAction('g1'), { kind: 'verify_round', round: 1 });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('round submission ids are deterministic and a corrupt file falls back to its backup', () => {
    const { root, goals } = fixture();
    try {
        assert.equal(goalRoundSubmissionId('g1', 3), 'goal:g1:round:3');
        goals.create('s1', 'goal', { goalId: 'g1' });
        goals.startRound('s1', 'g1', 1);
        writeFileSync(join(root, 'goals', 'g1.json'), '{ not json', 'utf8');
        assert.equal(goals.getGoal('g1')?.status, 'deriving', 'the .bak copy is read when the primary is corrupt');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
