import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { applyRoundError, applyRoundVerification } from './goal-policy';
import {
    ACTIVE_GOAL_STATUSES,
    DEFAULT_GOAL_BUDGET,
    goalRoundSubmissionId,
    type GoalBudget,
    type GoalCriterion,
    type GoalPauseReason,
    type GoalRecord,
    type GoalRound,
    type GoalRoundStatus,
    type GoalRoundVerification,
    type GoalStopReason,
    type GoalToolLogEntry,
} from './goal-types';
import { atomicWrite, readJsonWithBackup, safeId } from './persistence';

export interface GoalStoreOptions {
    goalsDirectory?: string;
    now?: () => number;
}

export interface GoalRoundStart {
    duplicate: boolean;
    round: GoalRound;
}

export interface GoalRoundFinish {
    status: Exclude<GoalRoundStatus, 'running'>;
    outputSummary?: string;
    toolLog?: GoalToolLogEntry[];
    error?: string;
}

export type GoalResumeAction =
    | { kind: 'verify_round'; round: number }
    | { kind: 'enqueue_round'; round: number };

const OUTPUT_SUMMARY_LIMIT = 4000;
const TOOL_LOG_LIMIT = 200;

/**
 * Durable goal records, one JSON file per goal. Every transition is a
 * compare-and-set on the persisted status, so a late-settling run, a cancel
 * racing the verifier, or a replayed submission cannot move a goal twice.
 */
export class GoalStore {
    private goalsDirectory: string;
    private now: () => number;

    constructor(options: GoalStoreOptions = {}) {
        this.goalsDirectory = options.goalsDirectory || join(homedir(), '.openflux', 'goals');
        this.now = options.now || Date.now;
    }

    private goalPath(goalId: string): string {
        return join(this.goalsDirectory, `${safeId(goalId)}.json`);
    }

    getGoal(goalId: string): GoalRecord | undefined {
        return readJsonWithBackup<GoalRecord>(this.goalPath(goalId));
    }

    create(
        sessionId: string,
        goal: string,
        options: { goalId?: string; userPlan?: string; budget?: Partial<GoalBudget> } = {},
    ): GoalRecord {
        const text = String(goal || '').trim();
        if (!text) throw new Error('A goal needs a description.');
        const now = this.now();
        const record: GoalRecord = {
            id: options.goalId || randomUUID(),
            sessionId,
            status: 'deriving',
            goal: text,
            ...(options.userPlan?.trim() ? { userPlan: options.userPlan.trim() } : {}),
            criteria: [],
            rounds: [],
            budget: { ...DEFAULT_GOAL_BUDGET, ...(options.budget || {}) },
            createdAt: now,
            updatedAt: now,
            noProgressStreak: 0,
            regressions: 0,
            consecutiveVerifierErrors: 0,
            consecutiveRoundErrors: 0,
            bestPassedCriteria: [],
            processedSubmissions: {},
        };
        this.write(record);
        return record;
    }

    /** Freeze the acceptance criteria; the goal is running from here on. */
    setCriteria(sessionId: string, goalId: string, criteria: GoalCriterion[], userPlan?: string): GoalRecord {
        const goal = this.require(sessionId, goalId);
        if (goal.status !== 'deriving') throw new Error('Acceptance criteria can only be set while deriving.');
        if (!criteria.length) throw new Error('At least one acceptance criterion is required.');
        goal.criteria = criteria.map(item => ({ ...item }));
        if (userPlan?.trim()) goal.userPlan = userPlan.trim();
        goal.status = 'running';
        goal.startedAt = goal.startedAt || this.now();
        this.write(goal);
        return goal;
    }

    /**
     * Open round `round`. Succeeds only when it is the next round of a goal
     * that may run, so two callers racing to open the same round get one
     * record and one `duplicate: true`.
     */
    startRound(sessionId: string, goalId: string, round: number, submissionId = goalRoundSubmissionId(goalId, round)): GoalRoundStart {
        const goal = this.require(sessionId, goalId);
        const existing = goal.rounds[round - 1];
        if (existing && existing.submissionId === submissionId) return { duplicate: true, round: existing };
        if (goal.rounds.length !== round - 1) {
            throw new Error(`Round ${round} is out of order; the goal has ${goal.rounds.length} round(s).`);
        }
        if (goal.rounds[round - 2]?.status === 'running') {
            throw new Error(`Round ${round - 1} is still running; round ${round} cannot start.`);
        }
        if (round === 1 ? goal.status !== 'deriving' && goal.status !== 'running' : goal.status !== 'running') {
            throw new Error(`Goal is ${goal.status}; round ${round} cannot start.`);
        }
        const record: GoalRound = { round, submissionId, startedAt: this.now(), status: 'running' };
        goal.rounds.push(record);
        goal.processedSubmissions[submissionId] = { action: `round:${round}`, at: this.now() };
        this.write(goal);
        return { duplicate: false, round: record };
    }

    attachRoundRun(sessionId: string, goalId: string, round: number, ids: { turnId?: string; runId?: string }): void {
        const goal = this.require(sessionId, goalId);
        const record = goal.rounds[round - 1];
        if (!record) throw new Error(`Round ${round} was not found.`);
        if (ids.turnId) record.turnId = ids.turnId;
        if (ids.runId) record.runId = ids.runId;
        this.write(goal);
    }

    /** Close a running round. Returns false when it was already closed. */
    finishRound(sessionId: string, goalId: string, round: number, finish: GoalRoundFinish): boolean {
        const goal = this.require(sessionId, goalId);
        const record = goal.rounds[round - 1];
        if (!record || record.status !== 'running') return false;
        record.status = finish.status;
        record.finishedAt = this.now();
        if (finish.outputSummary !== undefined) record.outputSummary = finish.outputSummary.slice(0, OUTPUT_SUMMARY_LIMIT);
        if (finish.toolLog) record.toolLog = finish.toolLog.slice(0, TOOL_LOG_LIMIT);
        if (finish.error) record.error = finish.error;
        if (finish.status === 'failed' && finish.error && !finish.outputSummary) applyRoundError(goal, record);
        this.write(goal);
        return true;
    }

    /**
     * Bank the verifier's verdicts and fold them into the progress counters.
     * Returns undefined when the goal was cancelled or finished meanwhile, in
     * which case nothing is written and the caller must not open a round.
     */
    recordVerification(sessionId: string, goalId: string, round: number, verification: GoalRoundVerification): GoalRecord | undefined {
        const goal = this.require(sessionId, goalId);
        if (goal.status !== 'running' && goal.status !== 'pausing') return undefined;
        const record = goal.rounds[round - 1];
        if (!record || record.status === 'running' || record.verification) return undefined;
        record.verification = verification;
        applyRoundVerification(goal, record);
        this.write(goal);
        return goal;
    }

    requestPause(sessionId: string, goalId: string, reason: GoalPauseReason = 'user'): GoalRecord {
        const goal = this.require(sessionId, goalId);
        if (goal.status === 'pausing' || goal.status === 'paused') return goal;
        if (goal.status !== 'running' && goal.status !== 'deriving') throw new Error(`Goal is ${goal.status} and cannot be paused.`);
        const live = goal.rounds[goal.rounds.length - 1];
        goal.status = live?.status === 'running' ? 'pausing' : 'paused';
        goal.pauseReason = reason;
        this.write(goal);
        return goal;
    }

    /** Settle a `pausing` goal once its round is closed, or park an idle one. */
    markPaused(sessionId: string, goalId: string, reason?: GoalPauseReason): GoalRecord {
        const goal = this.require(sessionId, goalId);
        if (!ACTIVE_GOAL_STATUSES.has(goal.status)) return goal;
        goal.status = 'paused';
        if (reason) goal.pauseReason = reason;
        this.write(goal);
        return goal;
    }

    resume(sessionId: string, goalId: string, submissionId?: string): { duplicate: boolean; goal: GoalRecord } {
        const goal = this.require(sessionId, goalId);
        if (submissionId && goal.processedSubmissions[submissionId]) return { duplicate: true, goal };
        if (goal.status !== 'paused') throw new Error(`Goal is ${goal.status} and cannot be resumed.`);
        goal.status = goal.criteria.length ? 'running' : 'deriving';
        delete goal.pauseReason;
        if (submissionId) goal.processedSubmissions[submissionId] = { action: 'resume', at: this.now() };
        this.write(goal);
        return { duplicate: false, goal };
    }

    cancel(sessionId: string, goalId: string, submissionId?: string): { duplicate: boolean; goal: GoalRecord } {
        const goal = this.require(sessionId, goalId);
        if (submissionId && goal.processedSubmissions[submissionId]) return { duplicate: true, goal };
        if (!ACTIVE_GOAL_STATUSES.has(goal.status)) return { duplicate: true, goal };
        goal.status = 'cancelled';
        goal.stopReason = 'cancelled';
        const live = goal.rounds[goal.rounds.length - 1];
        if (live?.status === 'running') {
            live.status = 'cancelled';
            live.finishedAt = this.now();
        }
        if (submissionId) goal.processedSubmissions[submissionId] = { action: 'cancel', at: this.now() };
        this.write(goal);
        return { duplicate: false, goal };
    }

    finish(sessionId: string, goalId: string, status: 'achieved' | 'stopped', stopReason?: GoalStopReason): GoalRecord {
        const goal = this.require(sessionId, goalId);
        if (!ACTIVE_GOAL_STATUSES.has(goal.status)) return goal;
        goal.status = status;
        if (stopReason) goal.stopReason = stopReason;
        else delete goal.stopReason;
        this.write(goal);
        return goal;
    }

    setFinalReport(sessionId: string, goalId: string, report: string): GoalRecord {
        const goal = this.require(sessionId, goalId);
        goal.finalReport = report;
        this.write(goal);
        return goal;
    }

    /**
     * What resuming a paused goal should do first. A round that closed
     * without a verification (the gateway died between the round and the
     * verifier) is verified before anything new is started.
     */
    resumeAction(goalId: string): GoalResumeAction {
        const goal = this.getGoal(goalId);
        if (!goal) throw new Error('Goal was not found.');
        const last = goal.rounds[goal.rounds.length - 1];
        if (last && (last.status === 'completed' || last.status === 'failed') && !last.verification && last.outputSummary !== undefined) {
            return { kind: 'verify_round', round: last.round };
        }
        return { kind: 'enqueue_round', round: goal.rounds.length + 1 };
    }

    /**
     * Gateway restarts never resume a goal automatically. Every goal that was
     * live is parked as paused with the reason on it, and its open round is
     * marked interrupted so the round number is never reused.
     */
    recoverInterrupted(): Array<{ sessionId: string; goalId: string; interruptedRound?: number }> {
        if (!existsSync(this.goalsDirectory)) return [];
        const recovered: Array<{ sessionId: string; goalId: string; interruptedRound?: number }> = [];
        for (const name of readdirSync(this.goalsDirectory)) {
            if (!name.endsWith('.json')) continue;
            const goal = readJsonWithBackup<GoalRecord>(join(this.goalsDirectory, name));
            if (!goal?.id || !goal.sessionId) continue;
            if (goal.status !== 'deriving' && goal.status !== 'running' && goal.status !== 'pausing') continue;
            let interruptedRound: number | undefined;
            const live = goal.rounds[goal.rounds.length - 1];
            if (live?.status === 'running') {
                live.status = 'interrupted';
                live.finishedAt = this.now();
                live.error = 'gateway_restart';
                interruptedRound = live.round;
            }
            goal.status = 'paused';
            goal.pauseReason = 'gateway_restart';
            this.write(goal);
            recovered.push({ sessionId: goal.sessionId, goalId: goal.id, ...(interruptedRound ? { interruptedRound } : {}) });
        }
        return recovered;
    }

    private require(sessionId: string, goalId: string): GoalRecord {
        const goal = this.getGoal(goalId);
        if (!goal) throw new Error('Goal was not found.');
        if (goal.sessionId !== sessionId) throw new Error('Goal does not belong to this session.');
        return goal;
    }

    private write(goal: GoalRecord): void {
        goal.updatedAt = this.now();
        atomicWrite(this.goalPath(goal.id), JSON.stringify(goal, null, 2));
    }
}
