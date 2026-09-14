import { isAbortError, type LLMProvider } from '../llm/provider';
import { buildGoalCriteriaPrompt, buildGoalVerifierPrompt } from './goal-prompts';
import type {
    GoalCriterion,
    GoalCriterionKind,
    GoalCriterionVerdict,
    GoalEvidence,
    GoalRecord,
    GoalRound,
    GoalRoundVerification,
    GoalToolLogEntry,
    GoalVerdict,
} from './goal-types';

/**
 * The two model calls goal mode makes outside the agent loop: deriving the
 * frozen acceptance criteria before round one, and auditing a settled round
 * against its tool log. Both parse defensively and never throw on bad model
 * output; only an abort propagates.
 */

/** A round's audit reads the whole condensed tool log; slow models need well
 * over the 30 s first tried, which aborted every audit of a real round. */
export const GOAL_VERIFIER_TIMEOUT_MS = 180_000;
/** Attempts per audit; a second try covers a transient provider failure. */
export const GOAL_VERIFIER_ATTEMPTS = 2;
const MAX_CRITERIA = 8;
const TEXT_LIMIT = 400;
const ARGS_LIMIT = 600;
const RESULT_LIMIT = 2000;

export interface DeriveGoalCriteriaOptions {
    llm?: LLMProvider;
    input: string;
    language?: string;
    signal?: AbortSignal;
    /** Criteria carried over from an approved plan document, kept verbatim. */
    seedCriteria?: string[];
}

export interface DerivedGoalSpec {
    goal: string;
    userPlan?: string;
    criteria: GoalCriterion[];
    source: 'llm' | 'fallback';
}

export interface VerifyGoalRoundOptions {
    llm?: LLMProvider;
    goal: GoalRecord;
    round: GoalRound;
    language?: string;
    signal?: AbortSignal;
    now?: () => number;
}

function clean(value: unknown, max = TEXT_LIMIT): string {
    if (typeof value !== 'string') return '';
    return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

export function parseJsonObject(raw: string): Record<string, unknown> | undefined {
    const trimmed = String(raw || '').trim();
    const unfenced = trimmed
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    if (start < 0 || end <= start) return undefined;
    try {
        const parsed = JSON.parse(unfenced.slice(start, end + 1));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
    } catch {
        return undefined;
    }
}

function stringify(value: unknown, max: number): string {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return clean(value, max);
    try {
        return clean(JSON.stringify(value), max);
    } catch {
        return clean(String(value), max);
    }
}

/** Condense a completed tool call into the form the verifier and the report see. */
export function toGoalToolLogEntry(
    index: number,
    call: { tool: string; action?: unknown; ok: boolean; args?: unknown; result?: unknown },
): GoalToolLogEntry {
    return {
        index,
        tool: String(call.tool || 'tool'),
        ...(typeof call.action === 'string' && call.action ? { action: call.action } : {}),
        ok: Boolean(call.ok),
        args: stringify(call.args, ARGS_LIMIT),
        result: stringify(call.result, RESULT_LIMIT),
    };
}

function fallbackCriteria(input: string, seedCriteria: string[] = []): GoalCriterion[] {
    const seeded = seedCriteria.map((text, index) => ({
        id: `c${index + 1}`,
        text: clean(text),
        check: '按工具调用日志核对该项是否发生 / verify from the tool-call log',
        kind: 'action' as const,
        source: 'user' as const,
    })).filter(item => item.text);
    if (seeded.length) return seeded.slice(0, MAX_CRITERIA);
    return [{
        id: 'c1',
        text: clean(input) || 'Complete the goal',
        check: '按工具调用日志核对目标是否达成 / verify from the tool-call log',
        kind: 'action',
        source: 'fallback',
    }];
}

function normalizeKind(value: unknown): GoalCriterionKind {
    return value === 'artifact' || value === 'answer' ? value : 'action';
}

/** Turn the derivation model's JSON into criteria, dropping anything unusable. */
export function criteriaFromDerivation(parsed: Record<string, unknown> | undefined): GoalCriterion[] {
    if (!parsed || !Array.isArray(parsed.criteria)) return [];
    const criteria: GoalCriterion[] = [];
    for (const item of parsed.criteria) {
        if (!item || typeof item !== 'object') continue;
        const record = item as Record<string, unknown>;
        const text = clean(record.text);
        if (!text) continue;
        criteria.push({
            id: `c${criteria.length + 1}`,
            text,
            check: clean(record.check) || text,
            kind: normalizeKind(record.kind),
            source: record.source === 'user' ? 'user' : 'derived',
        });
        if (criteria.length >= MAX_CRITERIA) break;
    }
    return criteria;
}

export async function deriveGoalCriteria(options: DeriveGoalCriteriaOptions): Promise<DerivedGoalSpec> {
    const fallback = (): DerivedGoalSpec => ({
        goal: clean(options.input) || 'Complete the goal',
        criteria: fallbackCriteria(options.input, options.seedCriteria),
        source: 'fallback',
    });
    if (options.signal?.aborted) {
        const error = new Error('Goal criteria derivation aborted');
        error.name = 'AbortError';
        throw error;
    }
    if (!options.llm) return fallback();
    try {
        const raw = await options.llm.chat(buildGoalCriteriaPrompt(options.input, options.language, options.seedCriteria), {
            signal: options.signal,
            maxTokens: 1800,
        });
        const parsed = parseJsonObject(raw);
        const criteria = criteriaFromDerivation(parsed);
        if (!criteria.length) return fallback();
        const userPlan = clean(parsed?.userPlan, 4000);
        return {
            goal: clean(parsed?.goal) || clean(options.input),
            ...(userPlan ? { userPlan } : {}),
            criteria,
            source: 'llm',
        };
    } catch (error) {
        if (isAbortError(error, options.signal)) throw error;
        return fallback();
    }
}

function resolveEvidence(goal: GoalRecord, current: GoalRound, raw: unknown): GoalEvidence | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const record = raw as Record<string, unknown>;
    const roundNumber = Number(record.round);
    const index = Number(record.toolCallIndex);
    if (!Number.isInteger(roundNumber) || !Number.isInteger(index)) return undefined;
    const round = roundNumber === current.round ? current : goal.rounds.find(item => item.round === roundNumber);
    const entry = round?.toolLog?.find(item => item.index === index);
    if (!entry || !entry.ok) return undefined;
    return {
        round: roundNumber,
        toolCallIndex: index,
        tool: entry.tool + (entry.action ? `.${entry.action}` : ''),
        summary: clean(record.quote, 200) || clean(entry.result, 200),
    };
}

/**
 * Enforce the evidence contract on the model's verdicts. A pass without a
 * resolvable successful tool call becomes unknown, and unknown never counts
 * as passed, so the executor cannot talk its way past a criterion.
 */
export function validateVerdicts(goal: GoalRecord, round: GoalRound, parsed: Record<string, unknown> | undefined): GoalCriterionVerdict[] | undefined {
    if (!parsed || !Array.isArray(parsed.criteria)) return undefined;
    const byId = new Map<string, Record<string, unknown>>();
    for (const item of parsed.criteria) {
        if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string') {
            byId.set((item as { id: string }).id, item as Record<string, unknown>);
        }
    }
    return goal.criteria.map(criterion => {
        const raw = byId.get(criterion.id);
        const claimed: GoalVerdict = raw?.verdict === 'pass' || raw?.verdict === 'fail' ? raw.verdict : 'unknown';
        const evidence = (Array.isArray(raw?.evidence) ? raw!.evidence : [])
            .map(item => resolveEvidence(goal, round, item))
            .filter((item): item is GoalEvidence => Boolean(item));
        const note = clean(raw?.note, 300);
        if (claimed === 'pass' && criterion.kind !== 'answer' && !evidence.length) {
            return {
                criterionId: criterion.id,
                verdict: 'unknown',
                evidence: [],
                note: note ? `evidence_unresolved: ${note}` : 'evidence_unresolved',
            };
        }
        return {
            criterionId: criterion.id,
            verdict: claimed,
            evidence,
            ...(note ? { note } : {}),
        };
    });
}

export async function verifyGoalRound(options: VerifyGoalRoundOptions): Promise<GoalRoundVerification> {
    let last: GoalRoundVerification | undefined;
    for (let attempt = 1; attempt <= GOAL_VERIFIER_ATTEMPTS; attempt += 1) {
        last = await verifyGoalRoundOnce(options);
        if (last.status !== 'error' || options.signal?.aborted) return last;
    }
    return last!;
}

async function verifyGoalRoundOnce(options: VerifyGoalRoundOptions): Promise<GoalRoundVerification> {
    const now = options.now || Date.now;
    if (options.signal?.aborted) {
        const error = new Error('Goal verification aborted');
        error.name = 'AbortError';
        throw error;
    }
    if (!options.llm) {
        return { verifiedAt: now(), status: 'error', verdicts: [], error: 'No model is available to audit the round.' };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Goal verification timed out')), GOAL_VERIFIER_TIMEOUT_MS);
    const onAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
        const raw = await options.llm.chat(buildGoalVerifierPrompt(options.goal, options.round, options.language), {
            signal: controller.signal,
            maxTokens: 2400,
        });
        const parsed = parseJsonObject(raw);
        const verdicts = validateVerdicts(options.goal, options.round, parsed);
        if (!verdicts) {
            return { verifiedAt: now(), status: 'unparseable', verdicts: [], error: 'The audit reply was not a verdict object.' };
        }
        const summary = clean(parsed?.summary, 600);
        const progressStatement = clean(parsed?.progressStatement, 300);
        return {
            verifiedAt: now(),
            status: 'verified',
            verdicts,
            ...(summary ? { summary } : {}),
            ...(progressStatement ? { progressStatement } : {}),
        };
    } catch (error) {
        // Only the caller's abort (cancel, shutdown) propagates. The verifier's
        // own timeout is an ordinary failure the policy counts against the goal.
        if (options.signal?.aborted) throw error;
        return {
            verifiedAt: now(),
            status: 'error',
            verdicts: [],
            error: error instanceof Error ? error.message : String(error),
        };
    } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', onAbort);
    }
}
