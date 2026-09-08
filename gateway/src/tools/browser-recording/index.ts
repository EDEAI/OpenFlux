/**
 * browser_recording 工具
 * 让 Agent 列出/查看/回放浏览器录制，并把录制转成 Workflow / Skill。
 * - replay：顺序调用现有 `browser` 工具执行每个可回放步骤
 */

import type { AnyTool, ToolResult, ToolExecutionContext } from '../types';
import type { ToolRegistry } from '../registry';
import type { RecordingStore } from '../../recording/recording-store';
import type { WorkflowStore } from '../../workflow/workflow-store';
import type { EvolutionDataManager } from '../../evolution/data-manager';
import type { LLMProvider, LLMMessage } from '../../llm/provider';
import type { RecordedStep } from '../../recording/types';
import type { StepIntent } from '../../recording/intent';
import { extractJson } from '../../recording/intent';
import {
    stepToBrowserActionCandidates,
    recordingToWorkflow,
    recordingToSkill,
} from '../../recording/converter';
import { readStringParam, validateAction, jsonResult, errorResult } from '../common';
import { Logger } from '../../utils/logger';

const log = new Logger('BrowserRecording');

const ACTIONS = ['list', 'get', 'replay', 'toWorkflow', 'toSkill', 'setGoal'] as const;

export interface BrowserRecordingToolOptions {
    store: RecordingStore;
    registry: ToolRegistry;
    workflowStore: WorkflowStore;
    dataManager: EvolutionDataManager;
    /** 步骤之间等待的基准（毫秒），默认 600ms；实际等待为 [1x, 2x) 基准的随机值 */
    stepDelayMs?: number;
    /** click/type 前对录制选择器做可见性预等待的上限（毫秒），默认 1500ms */
    stepWaitMs?: number;
    /** 回放时单个定位候选的执行超时（毫秒），默认 8000ms。
     *  不用 browser 工具默认的 30s：录制里常有"回放时本就不存在"的元素
     *  （一次性引导弹窗、个性化推荐卡片），每个候选等 30s 会让一次跳过耗时数分钟。 */
    candidateTimeoutMs?: number;
    /** LLM 获取器（语义兜底用）。用 getter 而非实例：Gateway 运行中可能切换 LLM 来源 */
    getLLM?: () => LLMProvider | null;
}

/** [min, max) 区间的随机整数毫秒 */
function randomBetween(min: number, max: number): number {
    return Math.floor(min + Math.random() * (max - min));
}

/** 会触发页面跳转/刷新的步骤，之后需要等更久让新页面就绪 */
function isNavigationalStep(type: string, key?: string): boolean {
    return type === 'navigate' || type === 'submit' || (type === 'pressKey' && key === 'Enter');
}

/**
 * 语义兜底：录制的精确选择器全部失效时，抓当前页面快照（带 ref），
 * 把「总目标 + 该步意图 + 快照」交给 LLM，让它在当前页面上找语义等价的元素执行，
 * 或判断该步在当前页面上已无意义（skip）。
 */
async function semanticFallback(params: {
    browser: AnyTool;
    context?: ToolExecutionContext;
    llm: LLMProvider;
    goal: string;
    step: RecordedStep;
    stepIntent: string;
}): Promise<{ resolved: boolean; via?: string; skip?: boolean; reason?: string }> {
    const { browser, context, llm, goal, step, stepIntent } = params;

    const snap = await browser
        .execute({ action: 'snapshot', interactive: true, compact: true }, context)
        .catch(() => null);
    const snapshotText = (snap?.success && (snap.data as any)?.snapshot) ? String((snap.data as any).snapshot) : '';
    if (!snapshotText) return { resolved: false, reason: 'snapshot unavailable' };

    const messages: LLMMessage[] = [
        {
            role: 'system',
            content:
                '你是浏览器操作回放的语义修复器。一段录制回放到某步时，录制的元素选择器在当前页面全部失效。'
                + '根据整体目标、该步意图和当前页面快照（元素带 ref 标识如 e1/e2），判断如何继续。只输出 JSON：\n'
                + '{"action":"clickRef","ref":"e12"} —— 点击语义等价的元素\n'
                + '{"action":"typeRef","ref":"e12","text":"要输入的文本"} —— 在语义等价的输入框输入\n'
                + '{"action":"skip"} —— 该步在当前页面已无意义（如弹窗本就没出现），跳过\n'
                + '{"action":"abort"} —— 当前页面与预期流程完全不符，无法修复',
        },
        {
            role: 'user',
            content:
                `整体目标：${goal}\n当前步骤意图：${stepIntent}\n`
                + `原始动作：${step.type}${step.value ? ` value="${step.value}"` : ''}`
                + `${step.selectors?.text || step.selectors?.ariaLabel ? ` target="${step.selectors.ariaLabel || step.selectors.text}"` : ''}\n`
                + (step.context
                    ? `录制时的环境：${[
                        step.context.pageTitle ? `页面「${step.context.pageTitle}」` : '',
                        step.context.heading ? `区块「${step.context.heading}」` : '',
                        step.context.label ? `字段「${step.context.label}」` : '',
                        step.context.nearbyText ? `所在条目「${step.context.nearbyText}」` : '',
                        step.context.href ? `链接指向 ${step.context.href}` : '',
                    ].filter(Boolean).join('，')}\n`
                    : '')
                + `当前页面快照：\n${snapshotText.slice(0, 12000)}`,
        },
    ];

    let decision: any;
    try {
        // 思考型模型的推理占输出额度，决策 JSON 虽小也要给足预算避免被截断
        decision = extractJson(await llm.chat(messages, { maxTokens: 8192 }));
    } catch (e) {
        return { resolved: false, reason: `llm error: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (!decision || typeof decision.action !== 'string') return { resolved: false, reason: 'unparsable decision' };

    if (decision.action === 'skip') return { resolved: true, skip: true };
    if (decision.action === 'abort') return { resolved: false, reason: 'llm judged page off-track' };

    if ((decision.action === 'clickRef' || decision.action === 'typeRef') && typeof decision.ref === 'string') {
        const args: Record<string, unknown> = decision.action === 'clickRef'
            ? { action: 'clickRef', ref: decision.ref }
            : { action: 'typeRef', ref: decision.ref, text: String(decision.text ?? step.value ?? step.text ?? '') };
        const r = await browser.execute(args, context);
        if (r.success) return { resolved: true, via: `semantic(${decision.action}:${decision.ref})` };
        return { resolved: false, reason: `semantic ${decision.action} failed: ${r.error}` };
    }
    return { resolved: false, reason: `unknown decision: ${decision.action}` };
}

export function createBrowserRecordingTool(options: BrowserRecordingToolOptions): AnyTool {
    const { store, registry, workflowStore, dataManager, getLLM } = options;
    const stepDelay = options.stepDelayMs ?? 600;
    const stepWaitMs = options.stepWaitMs ?? 1500;
    const candidateTimeoutMs = options.candidateTimeoutMs ?? 8000;

    return {
        name: 'browser_recording',
        description:
            '管理与复用浏览器录制。可列出已保存录制(list)、查看明细(get)、回放(replay，逐步驱动 browser 工具)、'
            + '将录制转为可执行 Workflow(toWorkflow) 或 Skill(toSkill)。录制由 OpenFlux Chrome 扩展产生。'
            + '回放带语义兜底：录制的选择器失效时会按步骤意图在当前页面找等价元素。'
            + '若回放仍中断，返回结果会带 goal（录制总目标）与 remainingIntents（剩余步骤意图），'
            + '此时应使用 browser 工具（snapshot + clickRef/typeRef）继续完成剩余目标，而不是直接放弃。'
            + '用户对录制目的的总结提出修正时，用 setGoal 更新（goal 参数传修正后的目的；'
            + '用户未指明是哪条录制时，用 list 取最近更新的一条）。',
        priority: 40,
        parameters: {
            action: {
                type: 'string',
                description: `操作类型：${ACTIONS.join(' / ')}`,
                required: true,
                enum: [...ACTIONS],
            },
            recordingId: {
                type: 'string',
                description: '录制 ID（get/replay/toWorkflow/toSkill/setGoal 必填）',
                required: false,
            },
            goal: {
                type: 'string',
                description: '修正后的录制目的（setGoal 必填），如「在淘宝搜索并比价影石Luna配件」',
                required: false,
            },
        },

        async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
            try {
                const action = validateAction(args, ACTIONS);
                switch (action) {
                    case 'list': {
                        return jsonResult({ recordings: store.list() });
                    }
                    case 'get': {
                        const id = readStringParam(args, 'recordingId');
                        if (!id) return errorResult('缺少 recordingId');
                        const rec = store.load(id);
                        if (!rec) return errorResult(`录制不存在：${id}`);
                        return jsonResult({ recording: rec });
                    }
                    case 'toWorkflow': {
                        const id = readStringParam(args, 'recordingId');
                        if (!id) return errorResult('缺少 recordingId');
                        const rec = store.load(id);
                        if (!rec) return errorResult(`录制不存在：${id}`);
                        const workflowId = recordingToWorkflow(rec, workflowStore);
                        return jsonResult({ workflowId, message: `已生成 Workflow：${workflowId}` });
                    }
                    case 'toSkill': {
                        const id = readStringParam(args, 'recordingId');
                        if (!id) return errorResult('缺少 recordingId');
                        const rec = store.load(id);
                        if (!rec) return errorResult(`录制不存在：${id}`);
                        const skillId = recordingToSkill(rec, dataManager);
                        return jsonResult({ skillId, message: `已生成 Skill：${skillId}` });
                    }
                    case 'setGoal': {
                        const id = readStringParam(args, 'recordingId');
                        const goal = readStringParam(args, 'goal');
                        if (!id) return errorResult('缺少 recordingId');
                        if (!goal) return errorResult('缺少 goal（修正后的录制目的）');
                        const rec = store.load(id);
                        if (!rec) return errorResult(`录制不存在：${id}`);
                        const existing = store.loadIntent(id);
                        store.saveIntent(id, {
                            goal,
                            steps: existing?.steps || [],
                            generatedAt: existing?.generatedAt || Date.now(),
                        });
                        log.info(`Recording goal corrected by user: ${id} -> "${goal}"`);
                        return jsonResult({ recordingId: id, goal, message: '录制目的已更新' });
                    }
                    case 'replay': {
                        const id = readStringParam(args, 'recordingId');
                        if (!id) return errorResult('缺少 recordingId');
                        const rec = store.load(id);
                        if (!rec) return errorResult(`录制不存在：${id}`);

                        const browser = registry.getTool('browser');
                        if (!browser) return errorResult('browser 工具不可用，无法回放');

                        // 意图归纳结果（录制停止时由 LLM 异步生成）；缺失时按纯机械回放走
                        const llm = getLLM?.() || null;
                        let intentDoc = store.loadIntent(id);
                        // 旧录制（意图功能上线前保存的）没有 intent.json：回放前补一次归纳并落盘
                        if (!intentDoc && llm && rec.steps.length > 0) {
                            const { generateRecordingIntent } = await import('../../recording/intent');
                            intentDoc = await generateRecordingIntent(rec, llm);
                            if (intentDoc) store.saveIntent(id, intentDoc);
                        }
                        const intentById = new Map<string, StepIntent>(
                            (intentDoc?.steps || []).map((s) => [s.id, s]),
                        );

                        log.info(`Replay started: ${id} (${rec.steps.length} recorded steps, intent=${intentDoc ? 'yes' : 'no'})`);
                        const results: Array<{ step: number; type: string; via?: string; success: boolean; error?: string; tried?: string[]; skipped?: boolean }> = [];
                        let stepNo = 0;
                        // 非致命失败跳过：录制里常混入噪声点击（点容器空白处、被浮层挡住的重复点击等），
                        // 单步失败先跳过继续走，后续 navigate 会把流程拉回正轨；连续失败说明已脱轨，再中止。
                        const MAX_CONSECUTIVE_FAILURES = 3;
                        let consecutiveFailures = 0;
                        // 致命失败时给调用方（Agent）的续跑上下文：总目标 + 从失败步骤起的剩余意图
                        const buildHandoff = (fromIndex: number) => {
                            if (!intentDoc) return {};
                            const remaining = rec.steps
                                .slice(fromIndex)
                                .map((s) => intentById.get(s.id)?.intent)
                                .filter((v): v is string => !!v);
                            return {
                                goal: intentDoc.goal,
                                remainingIntents: remaining,
                                hint: '回放中断。可依据 goal 与 remainingIntents，用 browser 工具（snapshot 查看页面 + clickRef/typeRef 操作）继续完成剩余目标。',
                            };
                        };
                        for (let stepIndex = 0; stepIndex < rec.steps.length; stepIndex++) {
                            const step = rec.steps[stepIndex];
                            const candidates = stepToBrowserActionCandidates(step);
                            if (candidates.length === 0) continue; // 跳过仅元数据步骤（如 select）
                            stepNo += 1;
                            log.debug(`Replay step ${stepNo}: ${step.type}`, {
                                selector: step.selectors?.css,
                                url: step.type === 'navigate' ? step.url : undefined,
                                candidates: candidates.map((c) => c.via),
                            });

                            // 自动等待：click/type 前给录制选择器一点出现的时间（非致命，失效则继续走兜底）
                            if ((step.type === 'click' || step.type === 'type') && step.selectors?.css && stepWaitMs > 0) {
                                await browser
                                    .execute({ action: 'wait', selector: step.selectors.css, timeout: stepWaitMs }, context)
                                    .catch(() => undefined);
                            }

                            // 多选择器兜底：按 css → role → text → aria → xpath 顺序逐个尝试
                            let ok = false;
                            let usedVia: string | undefined;
                            let lastError: string | undefined;
                            const tried: string[] = [];
                            let reconnected = false;
                            for (let ci = 0; ci < candidates.length; ci++) {
                                const cand = candidates[ci];
                                tried.push(cand.via);
                                // 选择器类动作用较短超时（元素不存在时快速失败进入兜底/跳过）；
                                // navigate 类候选（含 click 的 href 兜底）保持 browser 工具默认超时（页面加载可能较慢）
                                const args = (step.type === 'click' || step.type === 'type') && cand.action !== 'navigate'
                                    ? { ...cand.args, timeout: candidateTimeoutMs }
                                    : cand.args;
                                const r = await browser.execute(args, context);
                                if (r.success) {
                                    ok = true;
                                    usedVia = cand.via;
                                    break;
                                }
                                lastError = r.error;
                                log.debug(`Replay step ${stepNo}: candidate '${cand.via}' failed`, { error: r.error });
                                // 连接丢失（页面跳转导致 page 引用失效、标签页/浏览器被关闭等）：重连一次后重试当前候选
                                if (!reconnected && /Not connected to browser|No available page|has been closed/i.test(r.error || '')) {
                                    reconnected = true;
                                    log.warn(`Replay step ${stepNo}: browser connection lost, reconnecting`);
                                    const rc = await browser.execute({ action: 'connect' }, context).catch(() => null);
                                    if (rc?.success) {
                                        ci -= 1; // 重试当前候选
                                        continue;
                                    }
                                }
                            }

                            // navigate 的"执行上下文被销毁"：goto 本身已完成，是落地页随即又自动跳转
                            // （点击追踪跳板、302 链）打断了后续信息提取；导航已发生，视为成功继续。
                            if (!ok && step.type === 'navigate' && /Execution context was destroyed/i.test(lastError || '')) {
                                ok = true;
                                usedVia = 'url(redirect-chain)';
                                log.debug(`Replay step ${stepNo}: navigate hit redirect chain, treated as success`);
                            }

                            const stepIntent = intentById.get(step.id);

                            // 意图层判定的条件动作（引导弹窗、cookie 提示等）：回放时不出现属正常，直接跳过不计失败
                            if (!ok && stepIntent?.optional) {
                                results.push({ step: stepNo, type: step.type, success: false, error: lastError, tried, skipped: true });
                                log.debug(`Replay step ${stepNo}: optional step (${stepIntent.intent}) not applicable, skipped`);
                                continue;
                            }

                            // 语义兜底：精确选择器全部失效时，按「这一步想干什么」在当前页面上找等价元素
                            if (!ok && llm && stepIntent && (step.type === 'click' || step.type === 'type')) {
                                log.info(`Replay step ${stepNo}: selectors exhausted, trying semantic fallback (intent: ${stepIntent.intent})`);
                                const fb = await semanticFallback({
                                    browser,
                                    context,
                                    llm,
                                    goal: intentDoc?.goal || rec.title || '',
                                    step,
                                    stepIntent: stepIntent.intent,
                                });
                                if (fb.resolved && fb.skip) {
                                    results.push({ step: stepNo, type: step.type, success: false, error: lastError, tried, skipped: true });
                                    log.info(`Replay step ${stepNo}: semantic fallback judged step skippable`);
                                    consecutiveFailures = 0;
                                    continue;
                                }
                                if (fb.resolved && fb.via) {
                                    ok = true;
                                    usedVia = fb.via;
                                    tried.push(fb.via);
                                    log.info(`Replay step ${stepNo}: recovered via semantic fallback (${fb.via})`);
                                } else {
                                    log.warn(`Replay step ${stepNo}: semantic fallback failed`, { reason: fb.reason });
                                }
                            }

                            if (!ok) {
                                consecutiveFailures += 1;
                                // navigate 失败无法跳过（后续步骤全依赖正确的页面）；
                                // 其余类型单步失败可跳过，连续失败达到上限说明流程已脱轨。
                                const fatal = step.type === 'navigate' || consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
                                results.push({
                                    step: stepNo,
                                    type: step.type,
                                    success: false,
                                    error: lastError,
                                    tried,
                                    skipped: !fatal,
                                });
                                if (fatal) {
                                    log.warn(`Replay failed at step ${stepNo} (${step.type})`, {
                                        recordingId: id,
                                        tried,
                                        error: lastError,
                                        consecutiveFailures,
                                    });
                                    return jsonResult({
                                        replayed: stepNo,
                                        completed: false,
                                        failedAt: stepNo,
                                        error: lastError,
                                        results,
                                        ...buildHandoff(stepIndex),
                                    });
                                }
                                log.warn(`Replay step ${stepNo} (${step.type}) failed, skipped (non-fatal)`, {
                                    recordingId: id,
                                    tried,
                                    error: lastError?.slice(0, 200),
                                });
                                continue;
                            }
                            consecutiveFailures = 0;
                            results.push({
                                step: stepNo,
                                type: step.type,
                                via: usedVia,
                                success: true,
                                tried,
                            });
                            log.debug(`Replay step ${stepNo}: ok via '${usedVia}'`);

                            // 步骤间随机等待：模拟真人节奏，避免固定间隔被风控识别；
                            // 跳转类步骤（navigate/submit/Enter）后等更久，给新页面留出加载时间。
                            if (stepDelay > 0) {
                                const delay = isNavigationalStep(step.type, step.key)
                                    ? randomBetween(stepDelay * 2, stepDelay * 4)
                                    : randomBetween(stepDelay, stepDelay * 2);
                                await new Promise((res) => setTimeout(res, delay));
                            }
                        }
                        const skippedCount = results.filter((r) => r.skipped).length;
                        const semanticCount = results.filter((r) => r.via?.startsWith('semantic(')).length;
                        log.info(`Replay completed: ${id} (${stepNo} steps executed, ${skippedCount} skipped, ${semanticCount} semantic recoveries)`);
                        return jsonResult({
                            replayed: stepNo,
                            completed: true,
                            skipped: skippedCount,
                            semanticRecoveries: semanticCount,
                            // 录制的总目标：让 Agent 能向用户说明这条录制做了什么
                            goal: intentDoc?.goal,
                            results,
                        });
                    }
                    default:
                        return errorResult(`未知操作：${action}`);
                }
            } catch (e) {
                return errorResult(e instanceof Error ? e.message : String(e));
            }
        },
    };
}
