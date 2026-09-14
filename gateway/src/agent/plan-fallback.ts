/**
 * Turn a plan the model wrote as ordinary chat text into a PlanDocument.
 *
 * Plan mode requires the model to submit its plan through
 * `publish_plan_document` so the user gets the approval flow. Some models
 * ignore that and print the plan instead; after the loop has pushed back
 * without success, this converts the text so the plan still reaches the user
 * as a reviewable document rather than vanishing as a chat bubble.
 */

import type { PlanDocument, PlanStep } from '../work/types';

const HEADING = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const NUMBERED = /^\s*(\d+)[.)、]\s+(.+)$/;
const BULLET = /^\s*(?:[-*+•]|\d+[.)])\s+(.+)$/;

interface Section { level: number; title: string; lines: string[] }

function cleanInline(text: string): string {
    return text.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
}

function splitSections(text: string): { preamble: string[]; sections: Section[] } {
    const preamble: string[] = [];
    const sections: Section[] = [];
    let inFence = false;
    for (const raw of text.split(/\r?\n/)) {
        if (/^\s*```/.test(raw)) { inFence = !inFence; continue; }
        if (inFence) { (sections.at(-1)?.lines ?? preamble).push(raw); continue; }
        const h = HEADING.exec(raw);
        if (h) { sections.push({ level: h[1].length, title: cleanInline(h[2]), lines: [] }); continue; }
        (sections.at(-1)?.lines ?? preamble).push(raw);
    }
    return { preamble, sections };
}

function bullets(lines: string[]): string[] {
    const out: string[] = [];
    for (const line of lines) {
        const m = BULLET.exec(line);
        if (m) out.push(cleanInline(m[1]));
        else if (/^\s*\|/.test(line) && !/^\s*\|[\s:-]+\|/.test(line)) {
            // Table row → one sentence of its cells.
            const cells = line.split('|').map(cleanInline).filter(Boolean);
            if (cells.length && !/^-+$/.test(cells.join(''))) out.push(cells.join('，'));
        }
    }
    return out.filter(Boolean).slice(0, 40);
}

function paragraph(lines: string[], max = 600): string {
    const text = lines.map(l => l.trim()).filter(l => l && !/^\s*\|[\s:-]+\|/.test(l)).join(' ');
    return cleanInline(text).slice(0, max);
}

const KEYWORDS: Array<[keyof PlanDocument, RegExp]> = [
    ['risks', /风险|risk/i],
    ['rollback', /回滚|回退|rollback/i],
    ['acceptanceCriteria', /验收|acceptance|完成标准|done/i],
    ['validation', /验证|校验|测试|validation|verify|test/i],
    ['assumptions', /假设|前提|assumption/i],
    ['outOfScope', /不在范围|不包含|排除|out of scope|non-goals?/i],
    ['inScope', /范围|scope|包含/i],
    ['dependencies', /依赖|dependenc/i],
    ['confirmedDecisions', /决策|决定|decision/i],
    ['modules', /模块|module|组件|component/i],
];

/** Build a reviewable PlanDocument from free-form plan text. */
export function planDocumentFromMarkdown(text: string, goal: string): PlanDocument {
    const { preamble, sections } = splitSections(text || '');
    const firstLine = preamble.map(l => cleanInline(l)).find(Boolean);
    // A level-1 heading names the document. Otherwise the opening sentence
    // does, and every section heading is a step; only when there is no
    // opening text at all does the first section heading serve as the title.
    const firstHeading = sections.find(s => s.level === 1) ?? (firstLine ? undefined : sections.find(s => s.level <= 2));
    const title = (firstHeading?.title || firstLine || '实施计划').slice(0, 80);

    const doc: PlanDocument = {
        title,
        goal: cleanInline(goal || '').slice(0, 400) || title,
        confirmedDecisions: [],
        assumptions: [],
        inScope: [],
        outOfScope: [],
        steps: [],
        modules: [],
        dependencies: [],
        validation: [],
        risks: [],
        rollback: [],
        acceptanceCriteria: [],
    };

    // Named sections feed the matching lists; everything else becomes steps.
    const stepSources: Section[] = [];
    for (const section of sections) {
        if (section === firstHeading && section.lines.every(l => !l.trim())) continue;
        const key = KEYWORDS.find(([, re]) => re.test(section.title))?.[0];
        if (key && key !== 'steps' && Array.isArray(doc[key])) {
            const items = bullets(section.lines);
            (doc[key] as string[]).push(...(items.length ? items : [paragraph(section.lines, 300)].filter(Boolean)));
            continue;
        }
        stepSources.push(section);
    }

    // Steps: sub-headings when present, else numbered lines, else the sections themselves.
    const steps: PlanStep[] = [];
    const push = (t: string, description: string) => {
        const cleanTitle = cleanInline(t).slice(0, 120);
        if (!cleanTitle) return;
        steps.push({ id: `step-${steps.length + 1}`, title: cleanTitle, description: description || cleanTitle });
    };
    for (const section of stepSources) {
        if (section === firstHeading) {
            // The title heading's own body: numbered lines become steps.
            for (const line of section.lines) { const m = NUMBERED.exec(line); if (m) push(m[2], ''); }
            continue;
        }
        push(section.title, paragraph(section.lines));
    }
    if (steps.length === 0) {
        for (const line of preamble) { const m = NUMBERED.exec(line); if (m) push(m[2], ''); }
    }
    if (steps.length === 0) push(title, paragraph([...preamble, ...sections.flatMap(s => [s.title, ...s.lines])]) || title);
    doc.steps = steps.slice(0, 30);

    if (doc.acceptanceCriteria.length === 0) doc.acceptanceCriteria.push('计划中的每个步骤都已按描述完成并可供检查。');
    return doc;
}
