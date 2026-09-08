/**
 * 录制意图归纳
 * 录制停止后调用 LLM 对整条录制做一次语义归纳，产出 intent.json：
 * - goal：整条录制的总目标（自然语言）
 * - steps：每个步骤的意图描述 + 是否为「可选步骤」（如关闭引导弹窗、cookie 横幅等条件动作）
 * 回放失败时用这些意图做语义兜底（找等价元素 / 判断可跳过），
 * 致命失败时把总目标 + 剩余意图交还给 Agent 续跑。
 */

import type { Recording, RecordedStep } from './types';
import type { LLMProvider, LLMMessage } from '../llm/provider';
import { Logger } from '../utils/logger';

const log = new Logger('RecordingIntent');

export interface StepIntent {
    /** 对应 RecordedStep.id */
    id: string;
    /** 这一步想达成什么（自然语言，如「在搜索框输入关键词 107」） */
    intent: string;
    /** 条件动作：回放时元素不存在属正常（一次性弹窗、cookie 提示等），失败可直接跳过 */
    optional?: boolean;
}

export interface RecordingIntent {
    /** 整条录制的总目标，如「在哈雷官网搜索 107 发动机配件并提交试驾申请」 */
    goal: string;
    steps: StepIntent[];
    generatedAt: number;
}

/** 单步的紧凑文本表示（给 LLM 归纳用，控制 token 量） */
function stepBrief(step: RecordedStep, index: number): string {
    const parts: string[] = [`#${index} [${step.id}] ${step.type}`];
    if (step.type === 'navigate' && step.url) parts.push(`url=${step.url.slice(0, 160)}`);
    const label = step.selectors?.ariaLabel || step.selectors?.text;
    if (label) parts.push(`target="${label.slice(0, 60)}"`);
    else if (step.selectors?.css) parts.push(`css=${step.selectors.css.slice(0, 80)}`);
    if (step.type === 'type') {
        const masked = step.context?.inputType === 'password';
        parts.push(`value="${masked ? '(密码，已脱敏)' : (step.value ?? step.text ?? '').slice(0, 60)}"`);
    }
    if (step.type === 'pressKey' && step.key) parts.push(`key=${step.key}`);
    if (step.tagName) parts.push(`tag=${step.tagName}`);
    // 录制时采集的环境上下文：页面标题/表单标签/区块标题/卡片摘要/链接指向，
    // 是推断"这一步想干什么"的主要素材
    const c = step.context;
    if (c) {
        if (c.pageTitle) parts.push(`page="${c.pageTitle.slice(0, 60)}"`);
        if (c.label) parts.push(`field="${c.label.slice(0, 40)}"`);
        if (c.heading) parts.push(`section="${c.heading.slice(0, 40)}"`);
        if (c.nearbyText) parts.push(`item="${c.nearbyText.slice(0, 60)}"`);
        if (c.href) parts.push(`href=${c.href.slice(0, 120)}`);
    }
    return parts.join(' ');
}

/** 从 LLM 回复中提取 JSON（容忍代码围栏与前后缀文本） */
export function extractJson(text: string): any | null {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = (fenced ? fenced[1] : text).trim();
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
        return JSON.parse(raw.slice(start, end + 1));
    } catch {
        return null;
    }
}

/** 解开 JSON 字符串字面量的转义（\" \\ \n 等） */
function unescapeJsonString(s: string): string {
    try {
        return JSON.parse(`"${s}"`);
    } catch {
        return s;
    }
}

/**
 * 从被截断的 LLM 回复里抢救意图：长录制（几十步）时输出可能超长被截断导致整体 JSON 解析失败，
 * 但 goal 和前面已完整输出的步骤对象仍然可用——有前半段兜底总比全没有强。
 */
export function salvageIntent(text: string): { goal: string; steps: StepIntent[] } | null {
    const goalMatch = text.match(/"goal"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (!goalMatch) return null;
    const steps: StepIntent[] = [];
    const stepRe = /\{\s*"id"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"intent"\s*:\s*"((?:[^"\\]|\\.)*)"(?:\s*,\s*"optional"\s*:\s*(true|false))?\s*\}/g;
    let m: RegExpExecArray | null;
    while ((m = stepRe.exec(text)) !== null) {
        steps.push({
            id: unescapeJsonString(m[1]),
            intent: unescapeJsonString(m[2]),
            optional: m[3] === 'true',
        });
    }
    if (steps.length === 0) return null;
    return { goal: unescapeJsonString(goalMatch[1]), steps };
}

/**
 * 调用 LLM 归纳录制意图。失败（LLM 不可用/输出无法解析）返回 null，不抛异常。
 */
export async function generateRecordingIntent(
    recording: Recording,
    llm: LLMProvider,
): Promise<RecordingIntent | null> {
    const briefs = recording.steps
        .filter((s) => s.type !== 'scroll')
        .map((s, i) => stepBrief(s, i + 1))
        .join('\n');

    const messages: LLMMessage[] = [
        {
            role: 'system',
            content:
                '你是浏览器操作录制的意图分析器。用户在浏览器里录制了一串操作（点击/输入/跳转等），'
                + '你要归纳：1) 这条录制整体想完成什么目标；2) 每一步的操作意图。'
                + '意图要描述"想达成什么"而不是"点了哪个元素"，例如「在搜索框输入关键词」而不是「点击 #sb_form_q」。'
                + '如果某步是条件性动作（关闭引导弹窗、关闭 cookie 提示、关闭广告浮层等，回放时可能根本不出现），'
                + '标记 optional=true。只输出 JSON，不要任何解释。'
                + '这是后台批处理任务，无需深入推敲：按步骤顺序快速直接地标注即可，不要反复权衡措辞。'
                + '每条 intent 必须精炼（不超过 20 个字）；optional 为 false 时省略该字段，控制输出总长度。格式：\n'
                + '{"goal":"总目标一句话","steps":[{"id":"步骤id","intent":"该步意图"},{"id":"...","intent":"...","optional":true}]}',
        },
        {
            role: 'user',
            content:
                `录制标题：${recording.title || '(无)'}\n起始页面：${recording.startUrl || '(未知)'}\n`
                + `步骤列表（#序号 [步骤id] 类型 关键信息）：\n${briefs}`,
        },
    ];

    try {
        // 思考型模型（kimi 等）的推理内容也计入输出额度，默认 4096 会被"先想后写"耗尽
        // （实测 51 步录制推理就用掉 4084 token，正文只吐出 24 字符）——给足预算
        const response = await llm.chat(messages, { maxTokens: 16384 });
        const parsed = extractJson(response);
        let goal: string | undefined;
        let steps: StepIntent[] = [];
        if (parsed && typeof parsed.goal === 'string' && Array.isArray(parsed.steps)) {
            goal = parsed.goal;
            steps = parsed.steps
                .filter((s: any) => s && typeof s.id === 'string' && typeof s.intent === 'string')
                .map((s: any) => ({ id: s.id, intent: s.intent, optional: s.optional === true }));
        } else {
            // 长录制输出被截断时整体解析失败，抢救 goal + 已完整输出的步骤意图
            const salvaged = salvageIntent(response);
            if (salvaged) {
                goal = salvaged.goal;
                steps = salvaged.steps;
                log.warn(`Intent generation: response truncated, salvaged ${steps.length} step intents`, {
                    recordingId: recording.id,
                });
            }
        }
        if (!goal || steps.length === 0) {
            log.warn('Intent generation: unparsable LLM response', { preview: response.slice(0, 200) });
            return null;
        }
        const intent: RecordingIntent = { goal, steps, generatedAt: Date.now() };
        log.info(`Intent generated for recording ${recording.id}: "${intent.goal}" (${steps.length} step intents)`);
        return intent;
    } catch (e) {
        log.warn('Intent generation failed', { error: e instanceof Error ? e.message : String(e) });
        return null;
    }
}
