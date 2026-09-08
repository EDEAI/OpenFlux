/**
 * 录制 → Workflow / Skill 转换
 * - recordingToWorkflow：每个可执行步骤映射为 browser 工具调用，存入 WorkflowStore
 * - recordingToSkill：生成 SKILL.md 流程描述，经 EvolutionDataManager 保存
 * - stepToBrowserAction：步骤 → browser 工具 action（供转换与回放共用）
 */

import { createHash } from 'crypto';
import type { Recording, RecordedStep } from './types';
import type { WorkflowTemplate, WorkflowStepTemplate } from '../workflow/types';
import type { WorkflowStore } from '../workflow/workflow-store';
import type { EvolutionDataManager, InstalledSkillMeta } from '../evolution/data-manager';

/** 一个可执行候选：browser 工具 action + 参数 + 命中方式（用于诊断） */
export interface BrowserActionCandidate {
    action: string;
    args: Record<string, unknown>;
    /** 定位方式标签：css / role / text / aria / xpath / url / key / scroll */
    via: string;
}

/** 安全地把字符串包成 Playwright 选择器可用的双引号字面量 */
function quote(value: string): string {
    return JSON.stringify(value);
}

/**
 * 根据录制的多种线索，按可靠性从高到低生成「定位候选」。
 * Playwright 选择器引擎支持 css / text= / role= / xpath=，回放时逐个尝试，任一命中即可。
 */
function locatorCandidates(step: RecordedStep): Array<{ selector: string; via: string }> {
    const s = step.selectors;
    if (!s) return [];
    const out: Array<{ selector: string; via: string }> = [];
    const name = s.ariaLabel || s.text;
    // 文本是否适合做精确匹配（过长/被截断的文本不可靠）
    const nameUsable = !!name && name.length <= 60;

    if (s.css) out.push({ selector: s.css, via: 'css' });
    if (s.role && nameUsable) out.push({ selector: `role=${s.role}[name=${quote(name!)}]`, via: 'role' });
    if (nameUsable) out.push({ selector: `text=${quote(name!)}`, via: 'text' });
    if (s.ariaLabel) out.push({ selector: `[aria-label=${quote(s.ariaLabel)}]`, via: 'aria' });
    if (s.xpath) out.push({ selector: `xpath=${s.xpath}`, via: 'xpath' });
    return out;
}

/**
 * 将单个录制步骤映射为「按优先级排序的」browser 工具调用候选。
 * 回放时逐个尝试，任一成功即视为该步骤完成；空数组表示该步骤仅为元数据（如 select）。
 */
export function stepToBrowserActionCandidates(step: RecordedStep): BrowserActionCandidate[] {
    switch (step.type) {
        case 'navigate':
            return step.url
                ? [{ action: 'navigate', args: { action: 'navigate', url: step.url }, via: 'url' }]
                : [];
        case 'click': {
            const out: BrowserActionCandidate[] = locatorCandidates(step).map((c) => ({
                action: 'click',
                args: { action: 'click', selector: c.selector },
                via: c.via,
            }));
            // 意图兜底：点链接的意图就是"去这个地址"。选择器全失效（内容轮换、改版）时，
            // 直接导航到录制时该链接的指向，等价达成目标且无需 LLM。
            if (step.context?.href) {
                out.push({
                    action: 'navigate',
                    args: { action: 'navigate', url: step.context.href },
                    via: 'href',
                });
            }
            return out;
        }
        case 'type': {
            const text = step.value ?? step.text ?? '';
            return locatorCandidates(step).map((c) => ({
                action: 'type',
                args: { action: 'type', selector: c.selector, text },
                via: c.via,
            }));
        }
        case 'pressKey':
            return step.key
                ? [{ action: 'pressKey', args: { action: 'pressKey', key: step.key }, via: 'key' }]
                : [];
        case 'submit':
            // 表单提交近似为回车
            return [{ action: 'pressKey', args: { action: 'pressKey', key: 'Enter' }, via: 'key' }];
        case 'scroll': {
            // 回放滚动：滚到录制时的绝对 Y 位置（缺失则向下滚一屏）
            const y = Number(step.value);
            const script = Number.isFinite(y)
                ? `window.scrollTo(0, ${Math.round(y)})`
                : 'window.scrollBy(0, window.innerHeight)';
            return [{ action: 'evaluate', args: { action: 'evaluate', script }, via: 'scroll' }];
        }
        case 'wait':
            return [{ action: 'wait', args: { action: 'wait', timeout: 1000 }, via: 'wait' }];
        case 'select':
        default:
            return []; // 仅作为元数据，不进入可执行序列
    }
}

/**
 * 将单个录制步骤映射为 browser 工具调用（取最优候选，供 Workflow 转换使用）。
 * 无可执行候选时返回 null。
 */
export function stepToBrowserAction(
    step: RecordedStep,
): { action: string; args: Record<string, unknown> } | null {
    const [first] = stepToBrowserActionCandidates(step);
    return first ? { action: first.action, args: first.args } : null;
}

/** 人类可读的步骤摘要（用于步骤命名与 SKILL 描述） */
function describeStep(step: RecordedStep): string {
    const target = step.context?.label || step.selectors?.text || step.selectors?.ariaLabel || step.selectors?.css || '';
    switch (step.type) {
        case 'navigate':
            return `打开 ${step.url || ''}`;
        case 'click':
            return `点击「${target}」`;
        case 'type':
            return `在「${target}」输入「${step.value ?? step.text ?? ''}」`;
        case 'pressKey':
            return `按下 ${step.key} 键`;
        case 'submit':
            return `提交表单「${target}」`;
        case 'select':
            return `在「${target}」选择「${step.value ?? ''}」`;
        case 'scroll':
            return `滚动页面到 ${step.value ?? ''}`;
        case 'wait':
            return `等待`;
        default:
            return step.type;
    }
}

/**
 * 录制 → WorkflowTemplate 并保存。
 * @returns 生成的 workflow id
 */
export function recordingToWorkflow(recording: Recording, store: WorkflowStore): string {
    const steps: WorkflowStepTemplate[] = [];
    let idx = 0;
    for (const step of recording.steps) {
        const mapped = stepToBrowserAction(step);
        if (!mapped) continue; // 跳过不可回放步骤
        idx += 1;
        steps.push({
            id: `step-${idx}`,
            name: describeStep(step),
            description: describeStep(step),
            type: 'tool',
            tool: 'browser',
            args: mapped.args,
            onFailure: 'stop',
        });
    }

    const workflowId = `rec-${recording.id}`;
    const template: WorkflowTemplate = {
        id: workflowId,
        name: recording.title || `录制流程 ${recording.id.slice(0, 8)}`,
        description: `由浏览器录制生成的可回放流程（共 ${steps.length} 个可执行步骤）。`,
        intent: `复现用户在 ${recording.startUrl || '网页'} 上的浏览器操作`,
        parameters: [],
        steps,
    };

    store.save(template);
    return workflowId;
}

/** 生成 SKILL.md 文本 */
export function buildSkillMarkdown(recording: Recording): string {
    const lines: string[] = [];
    const title = recording.title || `浏览器录制 ${recording.id.slice(0, 8)}`;
    const desc = `由浏览器录制自动生成，复现在 ${recording.startUrl || '网页'} 上的操作流程。`;

    lines.push('---');
    lines.push(`name: ${title}`);
    lines.push(`description: ${desc}`);
    lines.push('---');
    lines.push('');
    lines.push(`# ${title}`);
    lines.push('');
    lines.push(desc);
    lines.push('');
    lines.push('## 操作步骤');
    lines.push('');
    let n = 0;
    for (const step of recording.steps) {
        if (step.type === 'scroll') continue; // 噪声步骤跳过
        n += 1;
        lines.push(`${n}. ${describeStep(step)}`);
    }
    lines.push('');
    lines.push('## 回放说明');
    lines.push('');
    lines.push('可使用 `browser_recording` 工具的 `replay` 动作按上述步骤自动回放，');
    lines.push('或调用对应的 Workflow 执行。');
    lines.push('');
    return lines.join('\n');
}

/**
 * 录制 → Skill 并保存（installed-skills，含 SKILL.md + meta.json）。
 * @returns 生成的 skill slug
 */
export function recordingToSkill(recording: Recording, dataManager: EvolutionDataManager): string {
    const content = buildSkillMarkdown(recording);
    const slug = `recording-${recording.id.slice(0, 8)}`;
    const meta: InstalledSkillMeta = {
        slug,
        source: 'browser-recording',
        version: '1.0.0',
        installedAt: new Date().toISOString(),
        hash: createHash('sha256').update(content).digest('hex').substring(0, 16),
        description: `由浏览器录制生成：${recording.title || recording.id}`,
    };
    dataManager.saveInstalledSkill(slug, content, meta);
    return slug;
}
