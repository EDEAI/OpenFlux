import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GoalOrchestrator, type GoalRoundIdentity } from '../src/gateway/goal-orchestrator';
import type { ChatWithToolsResponse, LLMMessage, LLMProvider } from '../src/llm/provider';
import { TurnQueueStore } from '../src/sessions/turn-queue-store';
import { GoalStore } from '../src/work/goal-store';
import { goalRoundSubmissionId, type GoalRecord } from '../src/work/goal-types';
import { PlanStore } from '../src/work/store';

/**
 * Exercises the goal orchestrator against real stores and a scripted model.
 * Rounds are simulated by hand: the harness plays the part of the turn
 * executor, calling beginRound / settleRound / onRoundSettled exactly as the
 * gateway does, so the chaining, pause, cancel and restart paths are covered
 * without a live agent loop.
 */

interface ScriptedVerdict {
    pass: string[];
    fail?: string[];
}

interface Harness {
    root: string;
    goals: GoalStore;
    plans: PlanStore;
    queue: TurnQueueStore;
    orchestrator: GoalOrchestrator<string>;
    enqueued: Array<{ sessionId: string; round: number }>;
    messages: Array<{ role: string; content: string; metadata?: Record<string, unknown> }>;
    aborted: string[];
    cancelledQueued: string[];
    verdicts: ScriptedVerdict[];
    /** Run the round the orchestrator last enqueued, end to end. */
    runNextRound(options?: { toolOk?: boolean; status?: 'completed' | 'failed' }): Promise<GoalRecord>;
}

function scriptedProvider(harness: () => Harness): LLMProvider {
    const chat = async (messages: LLMMessage[]): Promise<string> => {
        const system = String(messages[0]?.content || '');
        if (/验收审计员|acceptance auditor/.test(system)) {
            const verdict = harness().verdicts.shift() || { pass: [], fail: ['c1', 'c2'] };
            const criteria = [
                ...verdict.pass.map(id => ({ id, verdict: 'pass', evidence: [{ round: Number(String(messages[1]?.content).match(/(?:本轮|This round) = (\d+)/)?.[1] || 1), toolCallIndex: 1, quote: 'done' }] })),
                ...(verdict.fail || []).map(id => ({ id, verdict: 'fail', evidence: [] })),
            ];
            return JSON.stringify({ criteria, summary: 'audited', progressStatement: verdict.pass.length ? 'moved' : 'no material progress' });
        }
        return JSON.stringify({
            goal: 'make two files',
            criteria: [
                { text: 'a.txt exists', check: 'filesystem write a.txt', kind: 'artifact' },
                { text: 'b.txt exists', check: 'filesystem write b.txt', kind: 'artifact' },
            ],
        });
    };
    return {
        chat: chat as LLMProvider['chat'],
        chatStream: chat as LLMProvider['chatStream'],
        async chatWithTools(): Promise<ChatWithToolsResponse> { return { content: '', toolCalls: [] }; },
        getConfig: () => ({ provider: 'openai', model: 'goal-test' }),
        async embed(): Promise<number[]> { return []; },
        async embedBatch(): Promise<number[][]> { return []; },
    };
}

function createHarness(verdicts: ScriptedVerdict[]): Harness {
    const root = mkdtempSync(join(tmpdir(), 'openflux-goal-mode-'));
    const goals = new GoalStore({ goalsDirectory: join(root, 'goals') });
    const plans = new PlanStore({
        plansDirectory: join(root, 'plans'),
        workStateDirectory: join(root, 'sessions'),
        resolveGoal: id => goals.getGoal(id),
    });
    const queue = new TurnQueueStore({ filePath: join(root, 'turn-queue.jsonl') });
    const enqueued: Harness['enqueued'] = [];
    const messages: Harness['messages'] = [];
    const aborted: string[] = [];
    const cancelledQueued: string[] = [];
    let self!: Harness;
    const orchestrator = new GoalOrchestrator<string>({
        goalStore: goals,
        planStore: plans,
        sessions: { get: () => ({}), addMessage: (_sessionId, message) => { messages.push(message); return message; } },
        executionRegistry: {
            abortIfCurrent: (_key, target) => { aborted.push(target.runId); return true; },
            cancelQueued: (_key, target) => { cancelledQueued.push(target.runId); return true; },
        },
        turnQueueStore: queue,
        getLlm: () => scriptedProvider(() => self),
        language: 'zh-CN',
        enqueueRound: async (sessionId, _goal, round) => { enqueued.push({ sessionId, round }); },
        broadcastWorkState: () => undefined,
        broadcastSessionUpdate: () => undefined,
        log: { info: () => undefined, warn: () => undefined },
    });
    let runCounter = 0;
    self = {
        root,
        goals,
        plans,
        queue,
        orchestrator,
        enqueued,
        messages,
        aborted,
        cancelledQueued,
        verdicts,
        async runNextRound(options = {}) {
            const next = enqueued.shift();
            assert.ok(next, 'a round must have been enqueued');
            const goal = plans.getSnapshot(next.sessionId).goal!;
            const identity: GoalRoundIdentity = { goalId: goal.id, goalRound: next.round, turnId: `turn-${next.round}`, runId: `run-${++runCounter}` };
            const tracker = { goalUpdate: () => undefined };
            const controller = new AbortController();
            const started = await orchestrator.beginRound(next.sessionId, identity, tracker, controller.signal, goal.goal);
            if (!started) return goals.getGoal(goal.id)!;
            const state: { roundToolLog?: GoalRecord['rounds'][number]['toolLog'] } = {};
            orchestrator.captureToolEvent(state, { type: 'tool_result', tool: 'filesystem', args: { action: 'write', path: `${next.round}.txt` }, result: { success: options.toolOk !== false }, failed: options.toolOk === false });
            await orchestrator.settleRound(next.sessionId, identity, { status: options.status || 'completed', output: `## 本轮总结\n第 ${next.round} 轮` }, state.roundToolLog, tracker, controller.signal);
            await orchestrator.onRoundSettled(next.sessionId, identity, 'client');
            return goals.getGoal(goal.id)!;
        },
    };
    return self;
}

function startGoal(harness: Harness, sessionId = 's1'): GoalRecord {
    const goal = harness.orchestrator.startGoal(sessionId, '在 D:\\tmp 下创建 a.txt 和 b.txt');
    harness.enqueued.push({ sessionId, round: 1 });
    return goal;
}

test('rounds chain until every criterion passes, then the report is posted and the mode returns to normal', async () => {
    const harness = createHarness([{ pass: ['c1'], fail: ['c2'] }, { pass: ['c1', 'c2'] }]);
    try {
        const goal = startGoal(harness);
        assert.equal(harness.plans.getSnapshot('s1').mode, 'goal');
        const afterOne = await harness.runNextRound();
        assert.equal(afterOne.status, 'running');
        assert.equal(afterOne.criteria.length, 2, 'criteria were derived on round one');
        assert.deepEqual(afterOne.bestPassedCriteria, ['c1']);
        assert.deepEqual(harness.enqueued, [{ sessionId: 's1', round: 2 }], 'round two was opened exactly once');
        assert.ok(harness.messages.some(message => message.metadata?.kind === 'goal_criteria'));
        const afterTwo = await harness.runNextRound();
        assert.equal(afterTwo.status, 'achieved');
        assert.equal(harness.enqueued.length, 0);
        assert.ok(afterTwo.finalReport?.includes('已达成'));
        assert.ok(harness.messages.some(message => message.metadata?.kind === 'goal_final_report'));
        assert.equal(harness.plans.getSnapshot('s1').mode, 'normal');
        assert.equal(harness.plans.getSnapshot('s1').goal?.id, goal.id, 'the finished goal stays on the snapshot');
    } finally {
        rmSync(harness.root, { recursive: true, force: true });
    }
});

test('two rounds without a newly passed criterion stop the goal with a no-progress report', async () => {
    const harness = createHarness([{ pass: ['c1'], fail: ['c2'] }, { pass: ['c1'], fail: ['c2'] }, { pass: ['c1'], fail: ['c2'] }]);
    try {
        startGoal(harness);
        await harness.runNextRound();
        await harness.runNextRound();
        const stopped = await harness.runNextRound();
        assert.equal(stopped.status, 'stopped');
        assert.equal(stopped.stopReason, 'no_progress');
        assert.equal(stopped.rounds.length, 3);
        assert.equal(harness.enqueued.length, 0);
        assert.match(stopped.finalReport || '', /连续 2 轮没有新的验收项通过/);
    } finally {
        rmSync(harness.root, { recursive: true, force: true });
    }
});

test('pause is immediate: the queued round is dropped, the goal is paused and resume opens the next round', async () => {
    const harness = createHarness([{ pass: ['c1'], fail: ['c2'] }, { pass: ['c1', 'c2'] }]);
    try {
        startGoal(harness);
        await harness.runNextRound();
        // Round two is open in the store and queued but not yet executing.
        const goalId = harness.plans.getSnapshot('s1').goal!.id;
        const paused = harness.orchestrator.pause('s1', goalId);
        assert.equal(paused.status, 'paused', 'no live run means the goal parks at once');
        assert.equal(paused.rounds[1].status, 'interrupted', 'the opened-but-unrun round is closed, its number not reused');
        harness.enqueued.length = 0;
        const declined = await harness.orchestrator.beginRound('s1', { goalId, goalRound: 2, turnId: 't', runId: 'r' }, { goalUpdate: () => undefined }, new AbortController().signal, '');
        assert.equal(declined, undefined, 'a late executor for the dropped round runs nothing');
        await harness.orchestrator.resume('s1', goalId, 'resume-1', 'client');
        assert.equal(harness.goals.getGoal(goalId)!.status, 'running');
        assert.deepEqual(harness.enqueued, [{ sessionId: 's1', round: 3 }]);
    } finally {
        rmSync(harness.root, { recursive: true, force: true });
    }
});

test('cancel aborts the live run, cancels queued rounds and never opens another one', async () => {
    const harness = createHarness([{ pass: ['c1'], fail: ['c2'] }]);
    try {
        const goal = startGoal(harness);
        await harness.runNextRound();
        // Round two is open in the store and queued for execution.
        harness.queue.enqueue({ sessionId: 's1', submissionId: goalRoundSubmissionId(goal.id, 2), payload: { goalId: goal.id, turnId: 'turn-2' }, id: 'queued-2' });
        const cancelled = await harness.orchestrator.cancel('s1', goal.id, 'cancel-1');
        assert.equal(cancelled.status, 'cancelled');
        assert.deepEqual(harness.cancelledQueued, ['queued-2']);
        assert.equal(harness.queue.get('queued-2')?.status, 'canceled');
        assert.equal(harness.plans.getSnapshot('s1').mode, 'normal');
        assert.ok(harness.messages.some(message => message.metadata?.kind === 'goal_final_report' && message.metadata?.status === 'cancelled'));
        // A late settle of the cancelled round must not revive the goal.
        await harness.orchestrator.onRoundAborted('s1', { goalId: goal.id, goalRound: 2, turnId: 'turn-2', runId: 'run-x' }, { interrupted: true }, 'client');
        assert.equal(harness.goals.getGoal(goal.id)!.status, 'cancelled');
        assert.equal((await harness.orchestrator.cancel('s1', goal.id, 'cancel-1')).status, 'cancelled', 'cancel is idempotent by submission id');
    } finally {
        rmSync(harness.root, { recursive: true, force: true });
    }
});

test('a Stop interrupt parks the goal as paused and the interrupted round number is not reused', async () => {
    const harness = createHarness([{ pass: ['c1'], fail: ['c2'] }]);
    try {
        const goal = startGoal(harness);
        await harness.runNextRound();
        const identity: GoalRoundIdentity = { goalId: goal.id, goalRound: 2, turnId: 'turn-2', runId: 'run-2' };
        await harness.orchestrator.beginRound('s1', identity, { goalUpdate: () => undefined }, new AbortController().signal, goal.goal);
        harness.enqueued.length = 0;
        await harness.orchestrator.onRoundAborted('s1', identity, { interrupted: true }, 'client');
        const paused = harness.goals.getGoal(goal.id)!;
        assert.equal(paused.status, 'paused');
        assert.equal(paused.pauseReason, 'stopped_by_user');
        assert.equal(paused.rounds[1].status, 'interrupted');
        await harness.orchestrator.resume('s1', goal.id, undefined, 'client');
        assert.deepEqual(harness.enqueued, [{ sessionId: 's1', round: 3 }]);
    } finally {
        rmSync(harness.root, { recursive: true, force: true });
    }
});

test('gateway restart parks live goals, marks the open round interrupted and cancels queued goal rounds', async () => {
    const harness = createHarness([{ pass: ['c1'], fail: ['c2'] }]);
    try {
        const goal = startGoal(harness);
        await harness.runNextRound();
        const identity: GoalRoundIdentity = { goalId: goal.id, goalRound: 2, turnId: 'turn-2', runId: 'run-2' };
        await harness.orchestrator.beginRound('s1', identity, { goalUpdate: () => undefined }, new AbortController().signal, goal.goal);
        harness.queue.enqueue({ sessionId: 's1', submissionId: 'goal:other:round:3', payload: { goalId: goal.id }, id: 'queued-3' });

        const recovered = harness.orchestrator.recoverAfterRestart();
        assert.deepEqual(recovered, [{ sessionId: 's1', goalId: goal.id, interruptedRound: 2 }]);
        const parked = harness.goals.getGoal(goal.id)!;
        assert.equal(parked.status, 'paused');
        assert.equal(parked.pauseReason, 'gateway_restart');
        assert.equal(parked.rounds[1].status, 'interrupted');
        assert.equal(harness.queue.get('queued-3')?.status, 'canceled');
        assert.equal(harness.plans.getSnapshot('s1').mode, 'goal', 'the session stays in goal mode so the strip renders after reload');
    } finally {
        rmSync(harness.root, { recursive: true, force: true });
    }
});

test('a settle for a round the goal never opened is ignored', async () => {
    const harness = createHarness([]);
    try {
        const goal = startGoal(harness);
        await harness.orchestrator.onRoundAborted('s1', { goalId: goal.id, goalRound: 7, turnId: 't', runId: 'r' }, { interrupted: false, error: new Error('boom') }, 'client');
        assert.equal(harness.goals.getGoal(goal.id)!.rounds.length, 0);
        assert.equal(harness.goals.getGoal(goal.id)!.status, 'deriving');
    } finally {
        rmSync(harness.root, { recursive: true, force: true });
    }
});

test('suspend interrupts the live round, parks the goal as paused and hands the session back', async () => {
    const harness = createHarness([{ pass: ['c1'], fail: ['c2'] }]);
    try {
        const goal = startGoal(harness);
        await harness.runNextRound();
        assert.ok(harness.orchestrator.owningGoal('s1'), 'a running goal owns the session');
        const identity: GoalRoundIdentity = { goalId: goal.id, goalRound: 2, turnId: 'turn-2', runId: 'run-2' };
        await harness.orchestrator.beginRound('s1', identity, { goalUpdate: () => undefined }, new AbortController().signal, goal.goal);
        harness.enqueued.length = 0;

        const suspended = harness.orchestrator.suspend('s1', goal.id);
        assert.equal(suspended.status, 'pausing', 'the live round is asked to stop');
        assert.deepEqual(harness.aborted, ['run-2']);
        // The interrupted path settles the round exactly as the gateway would.
        await harness.orchestrator.onRoundAborted('s1', identity, { interrupted: true }, 'client');
        const parked = harness.goals.getGoal(goal.id)!;
        assert.equal(parked.status, 'paused');
        assert.equal(parked.pauseReason, 'user');
        assert.equal(parked.rounds[1].status, 'interrupted');
        assert.equal(harness.orchestrator.owningGoal('s1'), undefined, 'a paused goal no longer owns the session');
        assert.ok(harness.orchestrator.activeGoal('s1'), 'but it is still live and resumable');
        assert.equal(harness.enqueued.length, 0);

        await harness.orchestrator.resume('s1', goal.id, undefined, 'client');
        assert.deepEqual(harness.enqueued, [{ sessionId: 's1', round: 3 }]);
        assert.equal(harness.orchestrator.suspend('s1', goal.id).status, 'paused', 'suspending with no live round parks immediately');
    } finally {
        rmSync(harness.root, { recursive: true, force: true });
    }
});
