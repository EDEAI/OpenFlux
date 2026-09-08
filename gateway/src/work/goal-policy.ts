import {
    latestVerifiedRound,
    passedCriteriaIds,
    type GoalRecord,
    type GoalRound,
    type GoalStopReason,
} from './goal-types';

/**
 * Pure decisions for goal mode: what a verification means for progress, and
 * whether the next round should open. Nothing here touches disk or the LLM,
 * so every branch is unit-testable with a hand-built record.
 */

/** Regressions tolerated before the goal is judged to be oscillating. */
export const MAX_GOAL_REGRESSIONS = 2;
/** Unverifiable rounds before the verifier is judged unavailable. One is
 * enough: the verifier already retries internally, and opening another
 * round with no verdict on the last one just repeats work blindly. */
export const MAX_GOAL_VERIFIER_ERRORS = 1;
/** Consecutive rounds that threw before the goal is judged unrunnable. */
export const MAX_GOAL_ROUND_ERRORS = 2;

export type GoalDecision =
    | { next: 'achieved' }
    | { next: 'continue' }
    | { next: 'hold' }
    | { next: 'stop'; reason: GoalStopReason };

export interface GoalProgressAssessment {
    progress: GoalRound['progress'];
    passedNow: string[];
    newlyPassed: string[];
    regressed: string[];
}

/**
 * Progress is a criterion passing for the first time. More files, more tool
 * calls or "almost there" prose are not progress; a previously passed
 * criterion failing again is a regression, which also counts as no progress.
 */
export function assessRoundProgress(goal: GoalRecord, round: GoalRound): GoalProgressAssessment {
    const verification = round.verification;
    if (!verification || verification.status !== 'verified') {
        return { progress: 'unverified', passedNow: [], newlyPassed: [], regressed: [] };
    }
    const best = new Set(goal.bestPassedCriteria);
    const passedNow = passedCriteriaIds(verification);
    const newlyPassed = passedNow.filter(id => !best.has(id));
    const failedNow = new Set(verification.verdicts.filter(item => item.verdict === 'fail').map(item => item.criterionId));
    const regressed = [...best].filter(id => failedNow.has(id));
    const progress: GoalRound['progress'] = regressed.length ? 'regression' : newlyPassed.length ? 'progress' : 'none';
    return { progress, passedNow, newlyPassed, regressed };
}

/** Fold a round's verification into the goal's running counters. Mutates. */
export function applyRoundVerification(goal: GoalRecord, round: GoalRound): GoalProgressAssessment {
    const assessment = assessRoundProgress(goal, round);
    round.progress = assessment.progress;
    if (assessment.progress === 'unverified') {
        goal.consecutiveVerifierErrors += 1;
        goal.noProgressStreak += 1;
        return assessment;
    }
    goal.consecutiveVerifierErrors = 0;
    goal.consecutiveRoundErrors = 0;
    goal.bestPassedCriteria = [...new Set([...goal.bestPassedCriteria, ...assessment.newlyPassed])];
    if (assessment.progress === 'progress') {
        goal.noProgressStreak = 0;
    } else {
        goal.noProgressStreak += 1;
        if (assessment.progress === 'regression') goal.regressions += 1;
    }
    return assessment;
}

/** A round that threw before producing output: no verification is possible. */
export function applyRoundError(goal: GoalRecord, round: GoalRound): void {
    round.progress = 'unverified';
    goal.consecutiveRoundErrors += 1;
    goal.noProgressStreak += 1;
}

export function goalAchieved(goal: GoalRecord): boolean {
    if (!goal.criteria.length) return false;
    const latest = latestVerifiedRound(goal);
    if (!latest || latest !== goal.rounds[goal.rounds.length - 1]) return false;
    const passed = new Set(passedCriteriaIds(latest.verification));
    return goal.criteria.every(criterion => passed.has(criterion.id));
}

/**
 * Decide what follows a settled round. Order matters: a user hold wins over
 * everything, achievement over any budget, and the budgets are checked in
 * the order of how certain they are that another round is pointless.
 */
export function decideAfterRound(goal: GoalRecord, now: number): GoalDecision {
    if (goal.status === 'pausing' || goal.status === 'paused' || goal.status === 'cancelled') return { next: 'hold' };
    if (goal.status !== 'running') return { next: 'hold' };
    if (goalAchieved(goal)) return { next: 'achieved' };
    if (goal.consecutiveRoundErrors >= MAX_GOAL_ROUND_ERRORS) return { next: 'stop', reason: 'round_errors' };
    if (goal.consecutiveVerifierErrors >= MAX_GOAL_VERIFIER_ERRORS) return { next: 'stop', reason: 'verifier_unavailable' };
    if (goal.regressions >= MAX_GOAL_REGRESSIONS) return { next: 'stop', reason: 'oscillating' };
    if (goal.noProgressStreak >= goal.budget.maxNoProgressRounds) return { next: 'stop', reason: 'no_progress' };
    if (goal.rounds.length >= goal.budget.maxRounds) return { next: 'stop', reason: 'max_rounds' };
    if (goal.startedAt !== undefined && now - goal.startedAt >= goal.budget.maxWallClockMs) return { next: 'stop', reason: 'wall_clock' };
    return { next: 'continue' };
}
