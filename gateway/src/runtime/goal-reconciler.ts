import { isAbortError, type LLMMessage, type LLMProvider } from '../llm/provider';

export type GoalStatus = 'active' | 'superseded' | 'cancelled';

export interface GoalItem {
    id: string;
    text: string;
    status: GoalStatus;
    sourceIds: string[];
}

export interface GoalState {
    revision: number;
    goals: GoalItem[];
    nextFocus: string[];
}

export interface GoalInstruction {
    id: string;
    content: string;
}

export interface GoalModification {
    before: string;
    after: string;
}

export interface GoalDelta {
    added: string[];
    preserved: string[];
    modified: GoalModification[];
    superseded: string[];
    cancelled: string[];
}

export interface GoalRevision {
    id: string;
    state: GoalState;
    delta: GoalDelta;
    effectiveGoal: string;
    title: string;
    detail: string;
    fallback: boolean;
}

interface GoalReconcilerOutput {
    effectiveGoals?: unknown;
    preserved?: unknown;
    added?: unknown;
    modified?: unknown;
    superseded?: unknown;
    cancelled?: unknown;
    nextFocus?: unknown;
}

export interface ReconcileGoalOptions {
    llm?: LLMProvider;
    current: GoalState;
    instructions: GoalInstruction[];
    progress?: string[];
    language?: string;
    signal?: AbortSignal;
}

const MAX_GOALS = 24;
const MAX_TEXT = 1000;

function cleanText(value: unknown, max = MAX_TEXT): string {
    if (typeof value !== 'string') return '';
    return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

function stringList(value: unknown, max = MAX_GOALS): string[] {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map(item => cleanText(item)).filter(Boolean))].slice(0, max);
}

function modificationList(value: unknown): GoalModification[] {
    if (!Array.isArray(value)) return [];
    const result: GoalModification[] = [];
    for (const item of value) {
        if (!item || typeof item !== 'object') continue;
        const before = cleanText((item as { before?: unknown }).before);
        const after = cleanText((item as { after?: unknown }).after);
        if (!before || !after) continue;
        result.push({ before, after });
        if (result.length >= MAX_GOALS) break;
    }
    return result;
}

function uniqueGoalId(text: string, revision: number, index: number): string {
    let hash = 2166136261;
    for (const char of text) {
        hash ^= char.codePointAt(0) || 0;
        hash = Math.imul(hash, 16777619);
    }
    return `goal-${revision}-${index + 1}-${(hash >>> 0).toString(36)}`;
}

function parseJsonObject(raw: string): GoalReconcilerOutput | undefined {
    const trimmed = raw.trim();
    const unfenced = trimmed
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    if (start < 0 || end <= start) return undefined;
    try {
        const parsed = JSON.parse(unfenced.slice(start, end + 1));
        return parsed && typeof parsed === 'object' ? parsed as GoalReconcilerOutput : undefined;
    } catch {
        return undefined;
    }
}

function isZh(language?: string): boolean {
    return !language || language.toLowerCase().startsWith('zh');
}

export function createInitialGoalState(input: string, sourceId = 'original'): GoalState {
    const text = cleanText(input) || (isZh() ? '完成用户当前请求' : 'Complete the current user request');
    return {
        revision: 0,
        goals: [{ id: uniqueGoalId(text, 0, 0), text, status: 'active', sourceIds: [sourceId] }],
        nextFocus: [text],
    };
}

export function effectiveGoalText(state: GoalState): string {
    const active = state.goals.filter(goal => goal.status === 'active');
    return active.map((goal, index) => `${index + 1}. ${goal.text}`).join('\n');
}

function renderRevision(
    delta: GoalDelta,
    nextFocus: string[],
    language: string | undefined,
    fallback: boolean,
): { title: string; detail: string } {
    const zh = isZh(language);
    const lines: string[] = [];
    const join = (items: string[]) => items.join('；');
    if (delta.added.length) lines.push(`${zh ? '新增' : 'Added'}：${join(delta.added)}`);
    if (delta.preserved.length) lines.push(`${zh ? '保留' : 'Preserved'}：${join(delta.preserved)}`);
    if (delta.modified.length) {
        lines.push(`${zh ? '调整' : 'Changed'}：${delta.modified.map(item => `${item.before} → ${item.after}`).join('；')}`);
    }
    if (delta.superseded.length) lines.push(`${zh ? '替换' : 'Superseded'}：${join(delta.superseded)}`);
    if (delta.cancelled.length) lines.push(`${zh ? '取消' : 'Cancelled'}：${join(delta.cancelled)}`);
    if (nextFocus.length) lines.push(`${zh ? '当前重点' : 'Current focus'}：${join(nextFocus)}`);
    if (fallback) {
        lines.push(zh
            ? '目标解析服务未返回有效结构，已按“保留旧目标并追加最新引导”的保守规则修订。'
            : 'The goal parser did not return a valid structure; the safe preserve-and-append rule was applied.');
    }
    return {
        title: zh ? '任务目标已修订' : 'Task goals revised',
        detail: lines.join('\n'),
    };
}

function fallbackRevision(options: ReconcileGoalOptions): GoalRevision {
    const currentActive = options.current.goals.filter(goal => goal.status === 'active');
    const additions = options.instructions.map(item => cleanText(item.content)).filter(Boolean);
    const revision = options.current.revision + 1;
    const goals: GoalItem[] = [
        ...currentActive.map(goal => ({ ...goal, sourceIds: [...goal.sourceIds] })),
        ...additions.map((text, index) => ({
            id: uniqueGoalId(text, revision, currentActive.length + index),
            text,
            status: 'active' as const,
            sourceIds: options.instructions.filter(item => cleanText(item.content) === text).map(item => item.id),
        })),
    ];
    const nextFocus = additions.length ? additions : currentActive.map(goal => goal.text);
    const delta: GoalDelta = {
        added: additions,
        preserved: currentActive.map(goal => goal.text),
        modified: [],
        superseded: [],
        cancelled: [],
    };
    const state = { revision, goals, nextFocus } satisfies GoalState;
    const rendered = renderRevision(delta, nextFocus, options.language, true);
    return {
        id: `goal-revision-${revision}`,
        state,
        delta,
        effectiveGoal: effectiveGoalText(state),
        ...rendered,
        fallback: true,
    };
}

function buildRevision(options: ReconcileGoalOptions, parsed: GoalReconcilerOutput): GoalRevision | undefined {
    const parsedEffectiveGoals = stringList(parsed.effectiveGoals);
    if (parsedEffectiveGoals.length === 0) return undefined;

    const activeBefore = options.current.goals.filter(goal => goal.status === 'active');
    const preserved = stringList(parsed.preserved);
    const added = stringList(parsed.added);
    const modified = modificationList(parsed.modified);
    const superseded = stringList(parsed.superseded);
    const cancelled = stringList(parsed.cancelled);
    const nextFocus = stringList(parsed.nextFocus);
    const explicitlyRemoved = new Set([
        ...superseded,
        ...cancelled,
        ...modified.map(item => item.before),
    ]);
    const effectiveGoals = [...new Set([
        ...parsedEffectiveGoals,
        ...added,
        ...modified.map(item => item.after),
        // The parser is not allowed to silently drop an unrelated old goal.
        ...activeBefore.filter(goal => !explicitlyRemoved.has(goal.text)).map(goal => goal.text),
    ])].slice(0, MAX_GOALS);
    const normalizedPreserved = [...new Set([
        ...preserved,
        ...activeBefore
            .filter(goal => effectiveGoals.includes(goal.text) && !explicitlyRemoved.has(goal.text))
            .map(goal => goal.text),
    ])].slice(0, MAX_GOALS);
    const revision = options.current.revision + 1;
    const instructionIds = options.instructions.map(item => item.id);
    const previousByText = new Map(activeBefore.map(goal => [goal.text, goal]));
    const goals: GoalItem[] = effectiveGoals.map((text, index) => {
        const previous = previousByText.get(text);
        return previous
            ? { ...previous, sourceIds: [...previous.sourceIds] }
            : {
                id: uniqueGoalId(text, revision, index),
                text,
                status: 'active' as const,
                sourceIds: instructionIds,
            };
    });
    for (const previous of activeBefore) {
        if (effectiveGoals.includes(previous.text)) continue;
        goals.push({
            ...previous,
            status: cancelled.includes(previous.text) ? 'cancelled' : 'superseded',
            sourceIds: [...previous.sourceIds],
        });
    }
    const normalizedNextFocus = nextFocus.length ? nextFocus : effectiveGoals.slice(0, 3);
    const delta: GoalDelta = { added, preserved: normalizedPreserved, modified, superseded, cancelled };
    const state = { revision, goals, nextFocus: normalizedNextFocus } satisfies GoalState;
    const rendered = renderRevision(delta, normalizedNextFocus, options.language, false);
    return {
        id: `goal-revision-${revision}`,
        state,
        delta,
        effectiveGoal: effectiveGoalText(state),
        ...rendered,
        fallback: false,
    };
}

function buildPrompt(options: ReconcileGoalOptions): LLMMessage[] {
    const zh = isZh(options.language);
    const currentGoals = options.current.goals
        .filter(goal => goal.status === 'active')
        .map((goal, index) => `${index + 1}. ${goal.text}`)
        .join('\n');
    const instructions = options.instructions
        .map((item, index) => `${index + 1}. [${item.id}] ${cleanText(item.content)}`)
        .join('\n');
    const progress = (options.progress || []).slice(-20).join('\n') || (zh ? '无' : 'None');
    const system = zh
        ? `你是任务目标修订器，只输出一个 JSON 对象，不调用工具，不解释推理。
规则：
1. 新引导默认是增量补充，无冲突的旧目标必须保留。
2. 只在发生冲突的字段或子目标上采用更新、更晚的用户引导，不得无故替换整个任务。
3. 已完成动作是事实，除非用户明确要求撤销或重做，否则不得假装其未发生。
4. 不得添加用户没有提出的目标。重大歧义应保留旧目标，而不是擅自删除。
5. effectiveGoals 必须列出修订后所有仍然有效的目标。
返回字段：effectiveGoals:string[]、preserved:string[]、added:string[]、modified:{before:string,after:string}[]、superseded:string[]、cancelled:string[]、nextFocus:string[]。`
        : `You reconcile task goals and output one JSON object only. Do not call tools or explain reasoning.
Rules: preserve every non-conflicting existing goal; treat new guidance as additive by default; apply newer guidance only to the conflicting field or sub-goal; keep completed actions as facts unless rollback or rework was explicitly requested; never invent goals; preserve old goals when materially ambiguous. effectiveGoals must contain every goal that remains active.
Return: effectiveGoals:string[], preserved:string[], added:string[], modified:{before:string,after:string}[], superseded:string[], cancelled:string[], nextFocus:string[].`;
    return [
        { role: 'system', content: system },
        {
            role: 'user',
            content: zh
                ? `当前有效目标：\n${currentGoals}\n\n按到达顺序排列的新引导：\n${instructions}\n\n已观察到的执行进展（仅作事实参考）：\n${progress}`
                : `Current active goals:\n${currentGoals}\n\nNew guidance in arrival order:\n${instructions}\n\nObserved execution progress (facts only):\n${progress}`,
        },
    ];
}

export async function reconcileGoalState(options: ReconcileGoalOptions): Promise<GoalRevision> {
    if (options.signal?.aborted) {
        const error = new Error('Goal reconciliation aborted');
        error.name = 'AbortError';
        throw error;
    }
    if (!options.llm || options.instructions.length === 0) return fallbackRevision(options);

    try {
        const raw = await options.llm.chat(buildPrompt(options), {
            signal: options.signal,
            maxTokens: 1800,
        });
        const parsed = parseJsonObject(raw);
        return parsed ? buildRevision(options, parsed) || fallbackRevision(options) : fallbackRevision(options);
    } catch (error) {
        if (isAbortError(error, options.signal)) throw error;
        return fallbackRevision(options);
    }
}
