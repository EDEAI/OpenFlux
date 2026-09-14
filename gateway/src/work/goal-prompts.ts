import type { LLMMessage } from '../llm/provider';
import {
    goalCriteriaProgress,
    passedCriteriaIds,
    type GoalCriterion,
    type GoalCriterionVerdict,
    type GoalRecord,
    type GoalRound,
    type GoalToolLogEntry,
} from './goal-types';

/**
 * Every piece of text goal mode puts in front of a model or a person. Pure
 * functions of the goal record, so the same round renders the same prompt
 * after a restart and the tests can pin the wording.
 */

export function isZhLanguage(language?: string): boolean {
    return !language || language.toLowerCase().startsWith('zh');
}

const ROUND_HISTORY_LIMIT = 3;
/** Per-field width of a tool-log line in the audit prompt. The stored log
 * keeps more; the prompt only needs enough to recognise what each call did. */
const TOOL_LOG_ARGS_LIMIT = 240;
const TOOL_LOG_RESULT_LIMIT = 360;
/** Calls beyond this are summarised as a count so a long round still audits in time. */
const TOOL_LOG_ENTRY_LIMIT = 80;
const OUTPUT_EXCERPT_LIMIT = 1500;
/** The auditor judges answer-kind criteria from the reply itself, so it sees far more of it. */
const VERIFIER_REPLY_LIMIT = 6000;
/** The report keeps the executor's own summary readable, structure intact. */
const REPORT_SUMMARY_LIMIT = 3000;

function clip(value: string | undefined, max: number): string {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Cut Markdown for display without flattening it: `clip` folds newlines into
 * spaces, which turns tables and lists into one run-on line once rendered.
 * Prefers the executor's own round-summary section when it wrote one.
 */
export function markdownExcerpt(value: string | undefined, max: number): string {
    const text = String(value || '').replace(/\r\n?/g, '\n').trim();
    if (!text) return '';
    const summaryStart = text.search(/^##\s*(本轮总结|Round summary)/im);
    const body = summaryStart >= 0 ? text.slice(summaryStart) : text;
    const lines = body.split('\n').map(line => line.replace(/\s+$/, ''));
    const kept: string[] = [];
    let length = 0;
    for (const line of lines) {
        if (length + line.length > max) {
            kept.push('…');
            break;
        }
        kept.push(line);
        length += line.length + 1;
    }
    return kept.join('\n').trim();
}

/** Label used for round marker messages and the strip. */
export function goalRoundTitle(round: number, language?: string): string {
    return isZhLanguage(language) ? `目标模式 · 第 ${round} 轮` : `Goal mode · round ${round}`;
}

/** The system-prompt block the agent loop injects for goal rounds. */
export function goalModeSystemPrompt(language?: string): string {
    return isZhLanguage(language)
        ? `## 目标模式（强制）
你正在执行一个跨多轮的目标。本轮的输入里列出了目标、冻结的验收标准、每条标准的检查方式，以及此前各轮的结果。
- 只处理尚未通过的验收项；已通过的不要重做，除非本轮需要依赖它。
- 真实执行：用工具产生可核对的结果（文件、命令输出、网页、数据）。空谈、建议、计划文档都不算完成。
- 完全自主：不要向用户提问、不要请求确认、不要等待输入。缺少信息就用最合理的假设并在总结里注明。
- 你无权宣布验收通过。一个独立的审计员会逐条核对工具调用日志；没有对应日志的主张会被判为未完成。
- 不要调用 notify_user；最终通知由系统统一发送。
- 本轮结束时必须以「## 本轮总结」收尾，包含四段：已完成（附证据：路径、命令、URL）、未完成、遇到的障碍、下一轮建议。`
        : `## Goal mode (MANDATORY)
You are executing one round of a multi-round goal. The round input lists the goal, the frozen acceptance criteria with how each will be checked, and the outcome of earlier rounds.
- Work only on criteria not yet passed; do not redo passed ones unless this round depends on them.
- Execute for real: produce verifiable results with tools (files, command output, pages, data). Advice, plans and documents are not completion.
- Fully autonomous: never ask the user, request confirmation or wait for input. Make the most reasonable assumption and note it in the summary.
- You cannot declare a criterion passed. An independent auditor checks the tool-call log; claims without a matching log entry are judged not done.
- Do not call notify_user; the system sends the final notification.
- End the round with a "## Round summary" section: done (with evidence: paths, commands, URLs), not done, blockers, suggestion for the next round.`;
}

export function formatGoalToolLog(entries: GoalToolLogEntry[] | undefined, language?: string): string {
    if (!entries?.length) return isZhLanguage(language) ? '（本轮没有工具调用）' : '(no tool calls this round)';
    const shown = entries.slice(0, TOOL_LOG_ENTRY_LIMIT);
    const lines = shown.map(entry => (
        `#${entry.index} ${entry.tool}${entry.action ? `.${entry.action}` : ''} [${entry.ok ? 'ok' : 'FAILED'}] args=${clip(entry.args, TOOL_LOG_ARGS_LIMIT)} → ${clip(entry.result, TOOL_LOG_RESULT_LIMIT)}`
    ));
    if (entries.length > shown.length) {
        const rest = entries.length - shown.length;
        lines.push(isZhLanguage(language) ? `（另有 ${rest} 次调用未列出）` : `(${rest} more calls not listed)`);
    }
    return lines.join('\n');
}

function criterionLine(criterion: GoalCriterion, verdict: GoalCriterionVerdict | undefined, language?: string): string {
    const zh = isZhLanguage(language);
    const state = verdict?.verdict === 'pass' ? (zh ? '已通过' : 'passed')
        : verdict?.verdict === 'fail' ? (zh ? '未通过' : 'failed')
            : (zh ? '未验证' : 'unverified');
    const note = verdict?.note ? ` — ${clip(verdict.note, 160)}` : '';
    return `- [${criterion.id}] ${criterion.text}（${zh ? '检查方式' : 'check'}：${criterion.check}）→ ${state}${note}`;
}

function latestVerdictFor(goal: GoalRecord, criterionId: string): GoalCriterionVerdict | undefined {
    for (let index = goal.rounds.length - 1; index >= 0; index -= 1) {
        const verification = goal.rounds[index].verification;
        if (verification?.status !== 'verified') continue;
        const verdict = verification.verdicts.find(item => item.criterionId === criterionId);
        if (verdict) return verdict;
    }
    return undefined;
}

/** Prompt for deriving the frozen acceptance criteria from the user's request. */
export function buildGoalCriteriaPrompt(input: string, language?: string, seedCriteria: string[] = []): LLMMessage[] {
    const zh = isZhLanguage(language);
    const seed = seedCriteria.length
        ? (zh ? `\n\n已有计划文档给出的验收条件（视为用户提供，原样保留）：\n${seedCriteria.map(item => `- ${item}`).join('\n')}` : `\n\nAcceptance criteria from an existing plan document (treat as user-provided, keep verbatim):\n${seedCriteria.map(item => `- ${item}`).join('\n')}`)
        : '';
    const system = zh
        ? `你负责把用户的目标转成可机器核对的验收标准，只输出一个 JSON 对象，不解释。
规则：
1. 若用户消息里自带验收标准或计划（例如「验收标准」「Acceptance」「计划」「Plan」等段落或明显的清单），逐条原样保留为 source="user"，只补充 check。
2. 其余标准由你推导，source="derived"。总数 1 到 5 条，每条必须是可观察的结果，不是过程。少而准，不要为了凑数拆分同一件事。
3. kind：action=必须发生的操作（发送、下单、部署）；artifact=必须存在的产物（文件、页面、记录）；answer=只需在最终回复里给出的信息。
4. check 写明审计员如何核对。审计员只能看到两样东西：工具调用日志（工具名、参数、返回结果）和执行者的最终回复文本。check 必须只依赖这两样：例如「日志中有 generate_presentation 成功返回 .pptx 路径」「回复中列出三家平台各自的故障时间」。禁止写需要打开文件、查看页面内容、人工阅读产物的 check（如「查看 PPT 是否包含 5 页」），这种标准永远无法通过，会导致目标反复重跑。
5. 不要添加用户没有要求的目标；不要把「写总结」当作验收项，除非用户要求交付文档。
返回字段：goal:string（一句话目标）、userPlan?:string（用户给的执行计划原文，没有则省略）、criteria:[{text,check,kind,source}]。`
        : `You turn the user's goal into machine-checkable acceptance criteria. Output one JSON object only, no explanation.
Rules:
1. If the message carries its own criteria or plan (sections like "Acceptance", "验收标准", "Plan", "计划", or an explicit checklist), keep each verbatim with source="user" and only add a check.
2. Derive the rest with source="derived". 1 to 5 criteria total, each an observable outcome, not a step. Few and precise; never split one deliverable into several criteria to pad the list.
3. kind: action = an operation that must happen (send, order, deploy); artifact = something that must exist (file, page, record); answer = information that only needs to appear in the final reply.
4. check states how the auditor verifies it. The auditor sees exactly two things: the tool-call log (tool name, arguments, returned result) and the executor's final reply text. A check must rely only on those, e.g. "the log shows generate_presentation returning a .pptx path" or "the reply lists the outage time for each of the three platforms". Never write a check that requires opening a file, viewing a page or reading the artifact itself (such as "the PPT contains at least 5 slides"): such a criterion can never pass and makes the goal loop pointlessly.
5. Never add goals the user did not ask for; do not make "write a summary" a criterion unless a document was requested.
Return: goal:string (one sentence), userPlan?:string (the user's own execution plan verbatim, omit if none), criteria:[{text,check,kind,source}].`;
    return [
        { role: 'system', content: system },
        { role: 'user', content: `${zh ? '用户的目标：' : "The user's goal:"}\n${input.trim()}${seed}` },
    ];
}

/** The agent's input for one round; replaces the user message for rounds after the first. */
export function buildGoalRoundPrompt(goal: GoalRecord, round: number, language?: string): string {
    const zh = isZhLanguage(language);
    const progress = goalCriteriaProgress(goal);
    const criteria = goal.criteria.map(criterion => criterionLine(criterion, latestVerdictFor(goal, criterion.id), language)).join('\n');
    const history = goal.rounds
        .filter(item => item.round < round && item.status !== 'running')
        .slice(-ROUND_HISTORY_LIMIT)
        .map(item => {
            const verification = item.verification;
            const passed = passedCriteriaIds(verification);
            const verdictLine = verification?.status === 'verified'
                ? (zh ? `审计结果：通过 ${passed.length}/${goal.criteria.length}${verification.progressStatement ? `；${clip(verification.progressStatement, 200)}` : ''}` : `Audit: ${passed.length}/${goal.criteria.length} passed${verification.progressStatement ? `; ${clip(verification.progressStatement, 200)}` : ''}`)
                : (zh ? `审计结果：未能验证（${item.status}${item.error ? `，${clip(item.error, 120)}` : ''}）` : `Audit: not verified (${item.status}${item.error ? `, ${clip(item.error, 120)}` : ''})`);
            return `${zh ? '第' : 'Round'} ${item.round}${zh ? ' 轮' : ''}：${verdictLine}\n${zh ? '本轮总结' : 'Summary'}：${clip(item.outputSummary, OUTPUT_EXCERPT_LIMIT) || (zh ? '（无）' : '(none)')}`;
        })
        .join('\n\n');
    const header = zh
        ? `[目标模式 第 ${round}/${goal.budget.maxRounds} 轮]`
        : `[Goal mode round ${round}/${goal.budget.maxRounds}]`;
    const sections = [
        header,
        `${zh ? '目标' : 'Goal'}：${goal.goal}`,
        goal.userPlan ? `${zh ? '用户给出的执行计划' : "User's execution plan"}：\n${goal.userPlan}` : '',
        `${zh ? '验收标准' : 'Acceptance criteria'}（${zh ? '已通过' : 'passed'} ${progress.passed}/${progress.total}）：\n${criteria}`,
        history ? `${zh ? '此前各轮' : 'Earlier rounds'}：\n${history}` : '',
        zh
            ? `本轮要求：只针对未通过的验收项行动，真实执行并留下可核对的工具调用记录；不要询问用户；结尾用「## 本轮总结」给出已完成（附证据）、未完成、障碍、下一轮建议。`
            : `This round: act only on criteria not yet passed, execute for real and leave verifiable tool calls; never ask the user; end with "## Round summary" listing done (with evidence), not done, blockers, and the suggestion for the next round.`,
    ].filter(Boolean);
    return sections.join('\n\n');
}

export function buildGoalVerifierPrompt(goal: GoalRecord, round: GoalRound, language?: string): LLMMessage[] {
    const zh = isZhLanguage(language);
    const criteria = goal.criteria.map(criterion => (
        `- id=${criterion.id} kind=${criterion.kind}：${criterion.text}\n  ${zh ? '检查方式' : 'check'}：${criterion.check}`
    )).join('\n');
    const earlier = goal.rounds
        .filter(item => item.round < round.round && item.verification?.status === 'verified')
        .map(item => `${zh ? '第' : 'Round'} ${item.round}：${item.verification!.verdicts.map(verdict => `${verdict.criterionId}=${verdict.verdict}`).join(', ')}`)
        .join('\n');
    const system = zh
        ? `你是严格的验收审计员。工具调用日志是唯一事实来源；执行者的文字只是主张，不是证据。只输出一个 JSON 对象。
规则：
1. 逐条判定每个验收项：pass / fail / unknown。
2. kind 为 action 或 artifact 的项，pass 必须引用本轮日志中至少一条【成功】的工具调用（evidence 里给 round 与 toolCallIndex），且该调用的参数或结果确实证明了该项。找不到就判 fail 或 unknown。
3. kind 为 answer 的项，可依据执行者最终回复的内容判定，evidence 可为空。
4. 执行者说"已完成"但日志里没有对应调用 → fail。日志显示调用失败 → 不能作为 pass 的证据。
5. 往轮已通过的项，若本轮没有相反证据，可沿用往轮判定（evidence 引用那一轮）。
6. progressStatement 用一句话说明本轮相对上一轮的实质进展；没有就写"无实质进展"。
返回：{"criteria":[{"id":string,"verdict":"pass"|"fail"|"unknown","evidence":[{"round":number,"toolCallIndex":number,"quote":string}],"note":string}],"summary":string,"progressStatement":string}`
        : `You are a strict acceptance auditor. The tool-call log is the only source of truth; the executor's prose is a claim, not evidence. Output one JSON object only.
Rules:
1. Judge every criterion: pass / fail / unknown.
2. For kind action or artifact, pass requires at least one SUCCESSFUL tool call from this round's log as evidence (give round and toolCallIndex) whose arguments or result actually prove the criterion. Otherwise fail or unknown.
3. For kind answer, judge from the executor's final reply; evidence may be empty.
4. A claim of completion with no matching call is fail. A failed call is never evidence for pass.
5. A criterion passed in an earlier round may keep that verdict if nothing this round contradicts it (cite that round).
6. progressStatement: one sentence on real progress since the previous round, or "no material progress".
Return: {"criteria":[{"id":string,"verdict":"pass"|"fail"|"unknown","evidence":[{"round":number,"toolCallIndex":number,"quote":string}],"note":string}],"summary":string,"progressStatement":string}`;
    const user = [
        `${zh ? '目标' : 'Goal'}：${goal.goal}`,
        `${zh ? '验收标准' : 'Criteria'}：\n${criteria}`,
        earlier ? `${zh ? '往轮判定' : 'Earlier verdicts'}：\n${earlier}` : '',
        `${zh ? '本轮' : 'This round'} = ${round.round}${zh ? '，工具调用日志' : ', tool-call log'}：\n${formatGoalToolLog(round.toolLog, language)}`,
        `${zh ? '执行者的最终回复（节选）' : "Executor's final reply (excerpt)"}：\n${clip(round.outputSummary, VERIFIER_REPLY_LIMIT) || (zh ? '（空）' : '(empty)')}`,
    ].filter(Boolean).join('\n\n');
    return [
        { role: 'system', content: system },
        { role: 'user', content: user },
    ];
}

function stopReasonText(goal: GoalRecord, language?: string): string {
    const zh = isZhLanguage(language);
    const table: Record<string, [string, string]> = {
        no_progress: [`连续 ${goal.budget.maxNoProgressRounds} 轮没有新的验收项通过`, `${goal.budget.maxNoProgressRounds} consecutive rounds without a newly passed criterion`],
        max_rounds: [`达到最大轮次 ${goal.budget.maxRounds}`, `reached the round cap of ${goal.budget.maxRounds}`],
        wall_clock: ['超过总时长上限', 'exceeded the wall-clock budget'],
        oscillating: ['已通过的验收项反复失效', 'passed criteria kept regressing'],
        verifier_unavailable: ['验收审计连续失败', 'the acceptance audit failed repeatedly'],
        round_errors: ['连续多轮执行出错', 'consecutive rounds failed to run'],
        cancelled: ['用户取消', 'cancelled by the user'],
    };
    const entry = goal.stopReason ? table[goal.stopReason] : undefined;
    if (!entry) return zh ? '未知' : 'unknown';
    return zh ? entry[0] : entry[1];
}

/** The Markdown the gateway posts when a goal ends. Rendered by code, never by the model. */
export function renderGoalReport(goal: GoalRecord, language?: string): string {
    const zh = isZhLanguage(language);
    const progress = goalCriteriaProgress(goal);
    const status = goal.status === 'achieved'
        ? (zh ? '✅ 已达成' : '✅ Achieved')
        : goal.status === 'cancelled'
            ? (zh ? '⛔ 已取消' : '⛔ Cancelled')
            : (zh ? `⏹ 已停止（${stopReasonText(goal, language)}）` : `⏹ Stopped (${stopReasonText(goal, language)})`);
    const rounds = goal.rounds.map(round => {
        const passed = passedCriteriaIds(round.verification).length;
        const calls = round.toolLog?.length ?? 0;
        const verdict = round.verification?.status === 'verified'
            ? `${passed}/${goal.criteria.length}`
            : round.verification ? (zh ? '未能验证' : 'unverified') : '—';
        const progressLabel = round.progress === 'progress' ? (zh ? '有进展' : 'progress')
            : round.progress === 'regression' ? (zh ? '回退' : 'regression')
                : round.progress === 'none' ? (zh ? '无进展' : 'none')
                    : round.progress === 'unverified' ? (zh ? '未验证' : 'unverified') : '—';
        return `| ${round.round} | ${round.status} | ${calls} | ${verdict} | ${progressLabel} |`;
    }).join('\n');
    const firstPassed = new Map<string, number>();
    const regressedAt = new Map<string, number[]>();
    for (const round of goal.rounds) {
        const verification = round.verification;
        if (verification?.status !== 'verified') continue;
        for (const verdict of verification.verdicts) {
            if (verdict.verdict === 'pass' && !firstPassed.has(verdict.criterionId)) firstPassed.set(verdict.criterionId, round.round);
            if (verdict.verdict === 'fail' && firstPassed.has(verdict.criterionId) && firstPassed.get(verdict.criterionId)! < round.round) {
                regressedAt.set(verdict.criterionId, [...(regressedAt.get(verdict.criterionId) || []), round.round]);
            }
        }
    }
    const criteria = goal.criteria.map(criterion => {
        const verdict = latestVerdictFor(goal, criterion.id);
        const label = verdict?.verdict === 'pass' ? (zh ? '通过' : 'pass') : verdict?.verdict === 'fail' ? (zh ? '未通过' : 'fail') : (zh ? '未验证' : 'unknown');
        const evidence = (verdict?.evidence || []).map(item => `R${item.round} #${item.toolCallIndex} ${item.tool}`).join('; ') || '—';
        const first = firstPassed.has(criterion.id) ? `R${firstPassed.get(criterion.id)}` : '—';
        const regressions = regressedAt.get(criterion.id)?.map(round => `R${round}`).join(', ') || '—';
        return `| ${criterion.id} | ${criterion.text} | ${label} | ${evidence} | ${first} | ${regressions} |`;
    }).join('\n');
    const unresolved = goal.criteria.filter(criterion => latestVerdictFor(goal, criterion.id)?.verdict !== 'pass');
    const lastSummary = [...goal.rounds].reverse().find(round => round.outputSummary)?.outputSummary;
    const nextStep = goal.status === 'achieved'
        ? (zh ? '目标已全部验收通过，可直接使用结果。' : 'Every criterion passed; the result is ready to use.')
        : unresolved.length
            ? (zh ? `仍有 ${unresolved.length} 项未通过。可以补充信息后以常规模式继续，或缩小目标范围后重新发起目标。` : `${unresolved.length} criteria remain open. Continue in normal mode with more information, or restart the goal with a narrower scope.`)
            : (zh ? '没有未通过的验收项。' : 'No criteria remain open.');
    return [
        `## ${zh ? '目标报告' : 'Goal report'}`,
        `**${zh ? '目标' : 'Goal'}**：${goal.goal}`,
        `**${zh ? '状态' : 'Status'}**：${status}　**${zh ? '验收' : 'Criteria'}**：${progress.passed}/${progress.total}　**${zh ? '轮次' : 'Rounds'}**：${goal.rounds.length}/${goal.budget.maxRounds}`,
        `### ${zh ? '轮次' : 'Rounds'}`,
        // Header, separator and rows must be contiguous lines: a blank line
        // after the separator ends the table and the rows render as raw pipes.
        [
            zh ? '| 轮 | 状态 | 工具调用 | 通过 | 进展 |\n|---|---|---|---|---|' : '| Round | Status | Tool calls | Passed | Progress |\n|---|---|---|---|---|',
            rounds || '| — | — | — | — | — |',
        ].join('\n'),
        `### ${zh ? '验收项' : 'Criteria'}`,
        [
            zh ? '| ID | 验收项 | 判定 | 证据 | 首次通过 | 回退 |\n|---|---|---|---|---|---|' : '| ID | Criterion | Verdict | Evidence | First passed | Regressed |\n|---|---|---|---|---|---|',
            criteria || (zh ? '| — | （尚未推导验收标准） | — | — | — | — |' : '| — | (criteria were not derived) | — | — | — | — |'),
        ].join('\n'),
        unresolved.length ? `### ${zh ? '未解决' : 'Open items'}\n${unresolved.map(criterion => `- [${criterion.id}] ${criterion.text}`).join('\n')}` : '',
        lastSummary ? `### ${zh ? '最后一轮总结' : 'Last round summary'}\n\n${markdownExcerpt(lastSummary, REPORT_SUMMARY_LIMIT)}` : '',
        `### ${zh ? '建议' : 'Next'}\n${nextStep}`,
    ].filter(Boolean).join('\n\n');
}
