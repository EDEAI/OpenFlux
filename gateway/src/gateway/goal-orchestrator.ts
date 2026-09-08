import type { LLMProvider } from '../llm/provider';
import type { AgentProgressEvent } from './server';
import { decideAfterRound } from '../work/goal-policy';
import { buildGoalRoundPrompt, goalRoundTitle, isZhLanguage, renderGoalReport } from '../work/goal-prompts';
import type { GoalStore } from '../work/goal-store';
import {
    goalOwnsSession,
    isGoalActive,
    type GoalRecord,
    type GoalRoundVerification,
    type GoalToolLogEntry,
} from '../work/goal-types';
import { deriveGoalCriteria, toGoalToolLogEntry, verifyGoalRound } from '../work/goal-verifier';
import type { PlanStore } from '../work/store';

/**
 * Drives a goal across turns.
 *
 * One round is one ordinary turn. The orchestrator opens the round record
 * before the turn starts, derives the acceptance criteria on the first
 * round, audits the round against its tool log when the agent loop returns,
 * and then decides whether to open the next round, hold, or finish. Every
 * transition is a compare-and-set in the store, so a cancel racing the audit
 * or a late-settling run cannot open a second round.
 */

export interface GoalRoundIdentity {
    goalId: string;
    goalRound: number;
    turnId: string;
    runId: string;
}

export interface GoalRoundTracker {
    goalUpdate(input: { id: string; title: string; detail?: string; status: 'running' | 'completed' | 'failed' }): unknown;
}

export interface GoalOrchestratorDeps<TClient> {
    goalStore: GoalStore;
    planStore: PlanStore;
    sessions: {
        get(sessionId: string): unknown;
        addMessage(sessionId: string, message: { role: 'user' | 'assistant'; content: string; metadata?: Record<string, unknown> }): unknown;
    };
    executionRegistry: {
        abortIfCurrent(key: string, target: { runId: string; turnId?: string }, reason?: unknown, options?: { pauseQueue?: boolean }): boolean;
        cancelQueued(key: string, target: { runId: string; turnId?: string }, reason?: unknown): boolean;
    };
    turnQueueStore: {
        snapshot<T>(sessionId: string): { queue: Array<{ id: string; status: string; payload: T }> };
        snapshots<T>(): Array<{ sessionId: string; queue: Array<{ id: string; status: string; payload: T }> }>;
        cancel(sessionId: string, id: string, reason?: unknown): boolean;
    };
    getLlm(): LLMProvider | undefined;
    language?: string;
    /** Synthesize and submit the turn for `round`; the store record already exists. */
    enqueueRound(sessionId: string, goal: GoalRecord, round: number, client: TClient): Promise<void>;
    broadcastWorkState(sessionId: string): void;
    broadcastSessionUpdate(sessionId: string): void;
    notifyUser?(sessionId: string, text: string): Promise<void>;
    log: { info(message: string, meta?: Record<string, unknown>): void; warn(message: string, meta?: Record<string, unknown>): void };
    now?: () => number;
}

export interface GoalRoundStart {
    /** The agent's input for this round. */
    input: string;
    iterationBudget: number;
}

export class GoalCancelledError extends Error {
    constructor() {
        super('Goal cancelled');
        this.name = 'GoalCancelledError';
    }
}

const TOOL_LOG_CAP = 200;

export class GoalOrchestrator<TClient> {
    private readonly activeVerifications = new Map<string, AbortController>();
    private readonly now: () => number;

    constructor(private readonly deps: GoalOrchestratorDeps<TClient>) {
        this.now = deps.now || Date.now;
    }

    /** Goal copy follows the goal's own language: a Chinese goal gets Chinese
     * prompts and reports even when the gateway is configured for English. */
    private languageFor(goalText: string | undefined): string | undefined {
        return goalText && /[㐀-鿿]/.test(goalText) ? 'zh-CN' : this.deps.language;
    }

    private copy(zh: string, en: string, goalText?: string): string {
        return isZhLanguage(this.languageFor(goalText)) ? zh : en;
    }

    /** The session's goal when it is still live (including paused). */
    activeGoal(sessionId: string): GoalRecord | undefined {
        const goal = this.deps.planStore.getSnapshot(sessionId).goal;
        return isGoalActive(goal) ? goal : undefined;
    }

    /** The session's goal when it is driving the turns; a paused goal does not own the session. */
    owningGoal(sessionId: string): GoalRecord | undefined {
        const goal = this.deps.planStore.getSnapshot(sessionId).goal;
        return goalOwnsSession(goal) ? goal : undefined;
    }

    /**
     * Park the goal right now so the user can run something else: the live
     * round is interrupted (its number is never reused), queued rounds are
     * dropped, and the goal waits as paused until Resume.
     */
    suspend(sessionId: string, goalId: string): GoalRecord {
        const { goalStore } = this.deps;
        const goal = goalStore.getGoal(goalId);
        if (!goal || goal.sessionId !== sessionId) throw new Error('Goal was not found.');
        if (!isGoalActive(goal)) return goal;
        this.activeVerifications.get(goalId)?.abort(new Error('Goal suspended'));
        this.cancelQueuedRounds(sessionId, goalId);
        const live = goal.rounds[goal.rounds.length - 1];
        if (live?.status === 'running' && live.runId) {
            // The interrupted path settles the round and parks the goal.
            goalStore.requestPause(sessionId, goalId, 'user');
            this.deps.executionRegistry.abortIfCurrent(sessionId, { runId: live.runId, turnId: live.turnId }, new Error('Goal suspended by user'), { pauseQueue: false });
        } else {
            if (live?.status === 'running') goalStore.finishRound(sessionId, goalId, live.round, { status: 'interrupted', error: 'suspended' });
            goalStore.markPaused(sessionId, goalId, 'user');
        }
        this.deps.broadcastWorkState(sessionId);
        return goalStore.getGoal(goalId)!;
    }

    /** Create the goal from the user's first message and put the session in goal mode. */
    startGoal(sessionId: string, input: string): GoalRecord {
        const goal = this.deps.goalStore.create(sessionId, input);
        try {
            this.deps.planStore.enterGoalMode(sessionId, goal.id);
        } catch (error) {
            this.deps.goalStore.cancel(sessionId, goal.id);
            throw error;
        }
        return goal;
    }

    /**
     * Open the round inside the turn's run lease. Returns undefined when the
     * goal can no longer run (cancelled or paused while the turn was queued),
     * in which case the caller completes the turn without running the agent.
     */
    async beginRound(
        sessionId: string,
        identity: GoalRoundIdentity,
        tracker: GoalRoundTracker,
        signal: AbortSignal,
        userInput: string,
    ): Promise<GoalRoundStart | undefined> {
        const { goalStore } = this.deps;
        let goal = goalStore.getGoal(identity.goalId);
        if (!goal || goal.sessionId !== sessionId) return undefined;
        if (goal.status === 'cancelled' || goal.status === 'achieved' || goal.status === 'stopped' || goal.status === 'paused') return undefined;
        try {
            goalStore.startRound(sessionId, identity.goalId, identity.goalRound);
        } catch (error) {
            this.deps.log.warn('Goal round could not start', { goalId: identity.goalId, round: identity.goalRound, error: String(error) });
            return undefined;
        }
        goalStore.attachRoundRun(sessionId, identity.goalId, identity.goalRound, { turnId: identity.turnId, runId: identity.runId });
        goal = goalStore.getGoal(identity.goalId)!;

        const language = this.languageFor(goal.goal);
        if (goal.status === 'deriving') {
            const activityId = `goal-derive-${identity.goalId}`;
            tracker.goalUpdate({ id: activityId, title: this.copy('正在推导验收标准…', 'Deriving acceptance criteria…', goal.goal), status: 'running' });
            const spec = await deriveGoalCriteria({
                llm: this.deps.getLlm(),
                input: userInput || goal.goal,
                language,
                signal,
                seedCriteria: this.seedCriteria(sessionId),
            });
            goal = goalStore.setCriteria(sessionId, identity.goalId, spec.criteria, spec.userPlan);
            const listed = spec.criteria.map(item => `- [${item.id}] ${item.text}${item.source === 'user' ? this.copy('（用户给定）', ' (user)', goal.goal) : ''}`).join('\n');
            tracker.goalUpdate({
                id: activityId,
                title: this.copy(`验收标准已确定（${spec.criteria.length} 项）`, `Acceptance criteria set (${spec.criteria.length})`, goal.goal),
                detail: listed,
                status: 'completed',
            });
            this.deps.sessions.addMessage(sessionId, {
                role: 'assistant',
                content: `${this.copy('## 验收标准', '## Acceptance criteria', goal.goal)}\n${listed}\n\n${this.copy(`最多 ${goal.budget.maxRounds} 轮，连续 ${goal.budget.maxNoProgressRounds} 轮无进展即停止。`, `Up to ${goal.budget.maxRounds} rounds; stops after ${goal.budget.maxNoProgressRounds} rounds without progress.`, goal.goal)}`,
                metadata: { kind: 'goal_criteria', goalId: goal.id },
            });
            this.deps.broadcastSessionUpdate(sessionId);
        }
        this.deps.broadcastWorkState(sessionId);
        return {
            input: buildGoalRoundPrompt(goal, identity.goalRound, language),
            iterationBudget: goal.budget.maxRoundIterations,
        };
    }

    private seedCriteria(sessionId: string): string[] {
        const plan = this.deps.planStore.getSnapshot(sessionId).plan;
        return plan?.execution?.document.acceptanceCriteria || [];
    }

    /** Keep a condensed copy of every completed tool call for the auditor. */
    captureToolEvent(state: { roundToolLog?: GoalToolLogEntry[] }, event: AgentProgressEvent): void {
        if (event.type !== 'tool_result' || !event.tool) return;
        state.roundToolLog = state.roundToolLog || [];
        if (state.roundToolLog.length >= TOOL_LOG_CAP) return;
        state.roundToolLog.push(toGoalToolLogEntry(state.roundToolLog.length + 1, {
            tool: event.tool,
            action: event.args?.action,
            ok: !event.failed,
            args: event.args,
            result: event.result,
        }));
    }

    /**
     * Close the round and audit it, still inside the run lease so a cancel
     * aborts the audit. The decision about the next round is taken later, in
     * `onRoundSettled`, once the queue has released the turn.
     */
    async settleRound(
        sessionId: string,
        identity: GoalRoundIdentity,
        result: { status: string; output: string },
        toolLog: GoalToolLogEntry[] | undefined,
        tracker: GoalRoundTracker,
        signal: AbortSignal,
    ): Promise<void> {
        const { goalStore } = this.deps;
        const closed = goalStore.finishRound(sessionId, identity.goalId, identity.goalRound, {
            status: result.status === 'completed' ? 'completed' : 'failed',
            outputSummary: result.output,
            toolLog,
        });
        if (!closed) return;
        const goal = goalStore.getGoal(identity.goalId);
        if (!goal || (goal.status !== 'running' && goal.status !== 'pausing')) return;
        await this.verifyAndRecord(sessionId, goal, identity.goalRound, tracker, signal);
    }

    private async verifyAndRecord(
        sessionId: string,
        goal: GoalRecord,
        roundNumber: number,
        tracker: GoalRoundTracker | undefined,
        signal?: AbortSignal,
    ): Promise<GoalRecord | undefined> {
        const round = goal.rounds[roundNumber - 1];
        if (!round) return undefined;
        const activityId = `goal-audit-${goal.id}-${roundNumber}`;
        tracker?.goalUpdate({ id: activityId, title: this.copy('正在验收本轮结果…', 'Auditing this round…', goal.goal), status: 'running' });
        const controller = new AbortController();
        const onAbort = () => controller.abort(signal?.reason);
        signal?.addEventListener('abort', onAbort, { once: true });
        this.activeVerifications.set(goal.id, controller);
        let verification: GoalRoundVerification;
        try {
            verification = await verifyGoalRound({
                llm: this.deps.getLlm(),
                goal,
                round,
                language: this.languageFor(goal.goal),
                signal: controller.signal,
                now: this.now,
            });
        } finally {
            signal?.removeEventListener('abort', onAbort);
            if (this.activeVerifications.get(goal.id) === controller) this.activeVerifications.delete(goal.id);
        }
        const updated = this.deps.goalStore.recordVerification(sessionId, goal.id, roundNumber, verification);
        if (!updated) return undefined;
        const passed = verification.verdicts.filter(item => item.verdict === 'pass').length;
        const total = updated.criteria.length;
        tracker?.goalUpdate({
            id: activityId,
            title: verification.status === 'verified'
                ? this.copy(`验收：通过 ${passed}/${total}`, `Audit: ${passed}/${total} passed`, goal.goal)
                : this.copy('验收未能完成', 'Audit could not complete', goal.goal),
            detail: verification.progressStatement || verification.summary || verification.error,
            status: verification.status === 'verified' ? 'completed' : 'failed',
        });
        this.deps.broadcastWorkState(sessionId);
        return updated;
    }

    /** The turn released the queue: decide what comes next. */
    async onRoundSettled(sessionId: string, identity: GoalRoundIdentity, client: TClient): Promise<void> {
        await this.advance(sessionId, identity.goalId, client);
    }

    /** The turn threw or was interrupted before it could settle. */
    async onRoundAborted(sessionId: string, identity: GoalRoundIdentity, outcome: { interrupted: boolean; error?: unknown }, client: TClient): Promise<void> {
        const { goalStore } = this.deps;
        const goal = goalStore.getGoal(identity.goalId);
        if (!goal || goal.sessionId !== sessionId) return;
        const round = goal.rounds[identity.goalRound - 1];
        if (round?.runId && round.runId !== identity.runId) return;
        if (outcome.interrupted) {
            goalStore.finishRound(sessionId, identity.goalId, identity.goalRound, { status: 'interrupted', error: 'stopped' });
            const current = goalStore.getGoal(identity.goalId);
            if (current && isGoalActive(current) && current.status !== 'paused') {
                // A pause the user asked for keeps its reason; a bare Stop is recorded as such.
                goalStore.markPaused(sessionId, identity.goalId, current.status === 'pausing' && current.pauseReason ? undefined : 'stopped_by_user');
            }
            this.deps.broadcastWorkState(sessionId);
            return;
        }
        goalStore.finishRound(sessionId, identity.goalId, identity.goalRound, {
            status: 'failed',
            error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error || 'round failed'),
        });
        await this.advance(sessionId, identity.goalId, client);
    }

    private async advance(sessionId: string, goalId: string, client: TClient): Promise<void> {
        const { goalStore } = this.deps;
        const goal = goalStore.getGoal(goalId);
        if (!goal || goal.sessionId !== sessionId) return;
        const decision = decideAfterRound(goal, this.now());
        switch (decision.next) {
            case 'hold':
                if (goal.status === 'pausing') goalStore.markPaused(sessionId, goalId);
                this.deps.broadcastWorkState(sessionId);
                return;
            case 'achieved':
                await this.finalize(sessionId, goalId, 'achieved');
                return;
            case 'stop':
                await this.finalize(sessionId, goalId, 'stopped', decision.reason);
                return;
            case 'continue': {
                const next = goal.rounds.length + 1;
                let started;
                try {
                    started = goalStore.startRound(sessionId, goalId, next);
                } catch (error) {
                    this.deps.log.warn('Next goal round was not opened', { goalId, round: next, error: String(error) });
                    return;
                }
                if (started.duplicate) return;
                const fresh = goalStore.getGoal(goalId)!;
                await this.deps.enqueueRound(sessionId, fresh, next, client);
                this.deps.broadcastWorkState(sessionId);
                return;
            }
            default:
                return;
        }
    }

    private async finalize(sessionId: string, goalId: string, status: 'achieved' | 'stopped', reason?: GoalRecord['stopReason']): Promise<void> {
        const { goalStore } = this.deps;
        const goal = goalStore.finish(sessionId, goalId, status, reason);
        const report = renderGoalReport(goal, this.languageFor(goal.goal));
        goalStore.setFinalReport(sessionId, goalId, report);
        this.deps.sessions.addMessage(sessionId, {
            role: 'assistant',
            content: report,
            metadata: { kind: 'goal_final_report', goalId, status: goal.status, stopReason: goal.stopReason },
        });
        this.deps.planStore.leaveGoalMode(sessionId);
        this.deps.broadcastWorkState(sessionId);
        this.deps.broadcastSessionUpdate(sessionId);
        this.deps.log.info('Goal finished', { goalId, status: goal.status, stopReason: goal.stopReason, rounds: goal.rounds.length });
        if (this.deps.notifyUser) {
            const headline = status === 'achieved'
                ? this.copy(`目标已达成：${goal.goal}`, `Goal achieved: ${goal.goal}`, goal.goal)
                : this.copy(`目标已停止（${goal.stopReason}）：${goal.goal}`, `Goal stopped (${goal.stopReason}): ${goal.goal}`, goal.goal);
            await this.deps.notifyUser(sessionId, headline).catch(error => {
                this.deps.log.warn('Goal notification failed', { goalId, error: String(error) });
            });
        }
    }

    /**
     * Pause is immediate. A pause that waited for the live round to finish
     * left the strip without a Resume button for minutes, which read as "no
     * way back"; interrupting the round costs at most that round's partial
     * work, and Resume opens a fresh round with the goal's history.
     */
    pause(sessionId: string, goalId: string): GoalRecord {
        return this.suspend(sessionId, goalId);
    }

    async resume(sessionId: string, goalId: string, submissionId: string | undefined, client: TClient): Promise<GoalRecord> {
        const { goalStore } = this.deps;
        const resumed = goalStore.resume(sessionId, goalId, submissionId);
        this.deps.broadcastWorkState(sessionId);
        if (resumed.duplicate) return resumed.goal;
        const action = goalStore.resumeAction(goalId);
        if (action.kind === 'verify_round') {
            const goal = goalStore.getGoal(goalId)!;
            await this.verifyAndRecord(sessionId, goal, action.round, undefined);
            await this.advance(sessionId, goalId, client);
            return goalStore.getGoal(goalId)!;
        }
        const goal = goalStore.getGoal(goalId)!;
        if (goal.criteria.length === 0) {
            // Derivation was interrupted: round one runs again from scratch.
            const started = goalStore.startRound(sessionId, goalId, action.round);
            if (!started.duplicate) await this.deps.enqueueRound(sessionId, goalStore.getGoal(goalId)!, action.round, client);
            return goalStore.getGoal(goalId)!;
        }
        const started = goalStore.startRound(sessionId, goalId, action.round);
        if (!started.duplicate) await this.deps.enqueueRound(sessionId, goalStore.getGoal(goalId)!, action.round, client);
        this.deps.broadcastWorkState(sessionId);
        return goalStore.getGoal(goalId)!;
    }

    async cancel(sessionId: string, goalId: string, submissionId?: string): Promise<GoalRecord> {
        const { goalStore } = this.deps;
        const before = goalStore.getGoal(goalId);
        if (!before || before.sessionId !== sessionId) throw new Error('Goal was not found.');
        this.activeVerifications.get(goalId)?.abort(new GoalCancelledError());
        const cancelled = goalStore.cancel(sessionId, goalId, submissionId);
        if (cancelled.duplicate) return cancelled.goal;
        const live = cancelled.goal.rounds[cancelled.goal.rounds.length - 1];
        if (live?.runId) {
            this.deps.executionRegistry.abortIfCurrent(sessionId, { runId: live.runId, turnId: live.turnId }, new GoalCancelledError(), { pauseQueue: false });
        }
        this.cancelQueuedRounds(sessionId, goalId);
        const report = renderGoalReport(cancelled.goal, this.languageFor(cancelled.goal.goal));
        goalStore.setFinalReport(sessionId, goalId, report);
        this.deps.sessions.addMessage(sessionId, {
            role: 'assistant',
            content: report,
            metadata: { kind: 'goal_final_report', goalId, status: 'cancelled', stopReason: 'cancelled' },
        });
        this.deps.planStore.leaveGoalMode(sessionId);
        this.deps.broadcastWorkState(sessionId);
        this.deps.broadcastSessionUpdate(sessionId);
        return goalStore.getGoal(goalId)!;
    }

    private cancelQueuedRounds(sessionId: string, goalId: string): void {
        const snapshot = this.deps.turnQueueStore.snapshot<{ goalId?: string; turnId?: string }>(sessionId);
        for (const item of snapshot.queue) {
            if (item.payload?.goalId !== goalId) continue;
            this.deps.executionRegistry.cancelQueued(sessionId, { runId: item.id, turnId: item.payload.turnId }, new GoalCancelledError());
            this.deps.turnQueueStore.cancel(sessionId, item.id, new GoalCancelledError());
        }
    }

    /**
     * Gateway startup. Live goals are parked as paused with the reason on
     * them, and any queued goal round is cancelled so queue hydration cannot
     * run it while the goal is paused. Nothing resumes on its own.
     */
    recoverAfterRestart(): Array<{ sessionId: string; goalId: string; interruptedRound?: number }> {
        const recovered = this.deps.goalStore.recoverInterrupted();
        for (const snapshot of this.deps.turnQueueStore.snapshots<{ goalId?: string }>()) {
            for (const item of snapshot.queue) {
                if (!item.payload?.goalId) continue;
                if (item.status !== 'queued' && item.status !== 'paused') continue;
                this.deps.turnQueueStore.cancel(snapshot.sessionId, item.id, 'Goal paused by gateway restart');
            }
        }
        if (recovered.length) {
            this.deps.log.warn('Parked live goals after Gateway restart', { count: recovered.length, goals: recovered.map(item => item.goalId) });
        }
        return recovered;
    }

    roundMarker(round: number, goalText?: string): string {
        return goalRoundTitle(round, this.languageFor(goalText));
    }
}
