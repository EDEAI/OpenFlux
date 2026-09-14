/**
 * Goal mode: a durable objective the agent works toward across several turns.
 *
 * One round is one ordinary turn. After each round an independent verifier
 * grades the frozen acceptance criteria against that round's tool log, and the
 * orchestrator decides whether to open the next round, stop, or hold.
 *
 * The frontend mirrors these types in src/chat/goal-state.ts; keep both in
 * step by hand, as plan-state.ts does for the plan types.
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

export type GoalCriterionKind = 'action' | 'artifact' | 'answer';

export interface GoalCriterion {
    id: string;
    text: string;
    /** How the verifier will check it, stated up front so it cannot drift. */
    check: string;
    kind: GoalCriterionKind;
    source: 'user' | 'derived' | 'fallback';
}

export interface GoalEvidence {
    round: number;
    toolCallIndex: number;
    tool: string;
    summary: string;
}

export type GoalVerdict = 'pass' | 'fail' | 'unknown';

export interface GoalCriterionVerdict {
    criterionId: string;
    verdict: GoalVerdict;
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

/** A condensed tool call from one round, the only evidence a verdict may cite. */
export interface GoalToolLogEntry {
    index: number;
    tool: string;
    action?: string;
    ok: boolean;
    args: string;
    result: string;
}

export type GoalRoundStatus = 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled';

export type GoalRoundProgress = 'progress' | 'none' | 'regression' | 'unverified';

export interface GoalRound {
    round: number;
    submissionId: string;
    turnId?: string;
    runId?: string;
    startedAt: number;
    finishedAt?: number;
    status: GoalRoundStatus;
    outputSummary?: string;
    toolLog?: GoalToolLogEntry[];
    verification?: GoalRoundVerification;
    progress?: GoalRoundProgress;
    error?: string;
}

export interface GoalBudget {
    maxRounds: number;
    maxNoProgressRounds: number;
    maxRoundIterations: number;
    maxWallClockMs: number;
}

export const DEFAULT_GOAL_BUDGET: GoalBudget = {
    maxRounds: 8,
    maxNoProgressRounds: 2,
    maxRoundIterations: 40,
    maxWallClockMs: 90 * 60_000,
};

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
    processedSubmissions: Record<string, { action: string; at: number }>;
}

export const ACTIVE_GOAL_STATUSES: ReadonlySet<GoalStatus> = new Set<GoalStatus>(['deriving', 'running', 'pausing', 'paused']);

export function isGoalActive(goal: GoalRecord | undefined): goal is GoalRecord {
    return Boolean(goal && ACTIVE_GOAL_STATUSES.has(goal.status));
}

/** Statuses in which the goal is driving the session's turns. A paused goal
 * keeps its record and its strip but hands the composer back to the user. */
export const GOAL_OWNING_STATUSES: ReadonlySet<GoalStatus> = new Set<GoalStatus>(['deriving', 'running', 'pausing']);

export function goalOwnsSession(goal: GoalRecord | undefined): goal is GoalRecord {
    return Boolean(goal && GOAL_OWNING_STATUSES.has(goal.status));
}

export function goalRoundSubmissionId(goalId: string, round: number): string {
    return `goal:${goalId}:round:${round}`;
}

/** Exactly the ids the verifier marked passed in one verification. */
export function passedCriteriaIds(verification: GoalRoundVerification | undefined): string[] {
    if (!verification || verification.status !== 'verified') return [];
    return verification.verdicts.filter(item => item.verdict === 'pass').map(item => item.criterionId);
}

export function latestVerifiedRound(goal: GoalRecord): GoalRound | undefined {
    for (let index = goal.rounds.length - 1; index >= 0; index -= 1) {
        const round = goal.rounds[index];
        if (round.verification?.status === 'verified') return round;
    }
    return undefined;
}

export function goalCriteriaProgress(goal: GoalRecord): { passed: number; total: number } {
    return { passed: goal.bestPassedCriteria.length, total: goal.criteria.length };
}
