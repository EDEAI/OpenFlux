/**
 * Client mirror of gateway/src/work/goal-types.ts plus the pure view model
 * for the goal strip above the composer. Keep the types in step by hand.
 */

export type GoalStatus =
    | 'deriving'
    | 'running'
    | 'pausing'
    | 'paused'
    | 'achieved'
    | 'stopped'
    | 'cancelled';

export type GoalStopReason =
    | 'no_progress'
    | 'max_rounds'
    | 'wall_clock'
    | 'oscillating'
    | 'verifier_unavailable'
    | 'round_errors'
    | 'cancelled';

export type GoalPauseReason = 'user' | 'stopped_by_user' | 'gateway_restart';

export interface GoalCriterion {
    id: string;
    text: string;
    check: string;
    kind: 'action' | 'artifact' | 'answer';
    source: 'user' | 'derived' | 'fallback';
}

export interface GoalEvidence {
    round: number;
    toolCallIndex: number;
    tool: string;
    summary: string;
}

export interface GoalCriterionVerdict {
    criterionId: string;
    verdict: 'pass' | 'fail' | 'unknown';
    evidence: GoalEvidence[];
    note?: string;
}

export interface GoalRoundVerification {
    verifiedAt: number;
    status: 'verified' | 'unparseable' | 'error';
    verdicts: GoalCriterionVerdict[];
    summary?: string;
    progressStatement?: string;
    error?: string;
}

export interface GoalRound {
    round: number;
    submissionId: string;
    turnId?: string;
    runId?: string;
    startedAt: number;
    finishedAt?: number;
    status: 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled';
    outputSummary?: string;
    verification?: GoalRoundVerification;
    progress?: 'progress' | 'none' | 'regression' | 'unverified';
    error?: string;
}

export interface GoalBudget {
    maxRounds: number;
    maxNoProgressRounds: number;
    maxRoundIterations: number;
    maxWallClockMs: number;
}

export interface GoalRecord {
    id: string;
    sessionId: string;
    status: GoalStatus;
    goal: string;
    userPlan?: string;
    criteria: GoalCriterion[];
    rounds: GoalRound[];
    budget: GoalBudget;
    createdAt: number;
    updatedAt: number;
    startedAt?: number;
    noProgressStreak: number;
    regressions: number;
    consecutiveVerifierErrors: number;
    consecutiveRoundErrors: number;
    bestPassedCriteria: string[];
    pauseReason?: GoalPauseReason;
    stopReason?: GoalStopReason;
    finalReport?: string;
}

export const ACTIVE_GOAL_STATUSES: ReadonlySet<GoalStatus> = new Set<GoalStatus>(['deriving', 'running', 'pausing', 'paused']);

export function isGoalActive(goal: GoalRecord | undefined): goal is GoalRecord {
    return Boolean(goal && ACTIVE_GOAL_STATUSES.has(goal.status));
}

/** A goal drives the session while deriving, running or pausing; paused hands the composer back. */
export const GOAL_OWNING_STATUSES: ReadonlySet<GoalStatus> = new Set<GoalStatus>(['deriving', 'running', 'pausing']);

export function goalOwnsSession(goal: GoalRecord | undefined): goal is GoalRecord {
    return Boolean(goal && GOAL_OWNING_STATUSES.has(goal.status));
}

export function goalCriteriaProgress(goal: GoalRecord): { passed: number; total: number } {
    return { passed: goal.bestPassedCriteria.length, total: goal.criteria.length };
}

export type GoalStripAction = 'pause' | 'resume' | 'cancel' | 'view_report';

export interface GoalStripModel {
    goalId: string;
    title: string;
    /** i18n key `goal.status.<status>`. */
    statusKey: string;
    status: GoalStatus;
    active: boolean;
    round: number;
    maxRounds: number;
    passed: number;
    total: number;
    /** i18n key for a secondary line, when there is something to say. */
    noteKey?: string;
    stopReason?: GoalStopReason;
    actions: GoalStripAction[];
    /** True while a round is executing, so the composer can be locked. */
    roundRunning: boolean;
}

/**
 * Everything the strip needs, computed once from the record. The strip is
 * shown while the goal is active and, after it ends, until the user
 * dismisses it or the session's work state moves on.
 */
export function goalStripModel(goal: GoalRecord | undefined): GoalStripModel | undefined {
    if (!goal) return undefined;
    const live = goal.rounds[goal.rounds.length - 1];
    const roundRunning = live?.status === 'running';
    const { passed, total } = goalCriteriaProgress(goal);
    const active = isGoalActive(goal);
    const actions: GoalStripAction[] = [];
    if (goal.status === 'running' || goal.status === 'deriving') actions.push('pause', 'cancel');
    else if (goal.status === 'pausing') actions.push('cancel');
    else if (goal.status === 'paused') actions.push('resume', 'cancel');
    else if (goal.finalReport) actions.push('view_report');
    let noteKey: string | undefined;
    if (goal.status === 'pausing') noteKey = 'goal.note_pausing';
    else if (goal.status === 'paused' && goal.pauseReason === 'gateway_restart') noteKey = 'goal.paused_restart_note';
    else if (goal.status === 'paused' && goal.pauseReason === 'stopped_by_user') noteKey = 'goal.paused_stopped_note';
    else if (goal.status === 'stopped' && goal.stopReason) noteKey = `goal.stop_reason.${goal.stopReason}`;
    return {
        goalId: goal.id,
        title: goal.goal,
        statusKey: `goal.status.${goal.status}`,
        status: goal.status,
        active,
        round: live?.round || 0,
        maxRounds: goal.budget.maxRounds,
        passed,
        total,
        ...(noteKey ? { noteKey } : {}),
        ...(goal.stopReason ? { stopReason: goal.stopReason } : {}),
        actions,
        roundRunning,
    };
}
