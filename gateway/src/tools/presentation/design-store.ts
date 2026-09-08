/** Persistent design state for sample approval and slide-local visual revisions. */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { authoredSlidesFromRendered } from './capacity';

interface PresentationDesignManifest {
    version: 1;
    designId: string;
    projectRoot: string;
    updatedAt: number;
    args: Record<string, unknown>;
}

const DESIGN_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{5,80}$/;
const PERSISTED_KEYS = new Set([
    'brief', 'art_direction', 'artDirection', 'slides', 'filename', 'output_dir',
    'export_pdf', 'render_preview', 'revision', 'workflow', 'workflow_stage',
    'workflow_mode', 'design_id', 'visual_review', '__quality_state', '__workflow_state',
]);

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function mergeRecords(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
    const merged = clone(base);
    for (const [key, value] of Object.entries(patch)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) continue;
        const current = merged[key];
        if (value && typeof value === 'object' && !Array.isArray(value)
            && current && typeof current === 'object' && !Array.isArray(current)) {
            merged[key] = mergeRecords(record(current), record(value));
        } else {
            merged[key] = clone(value);
        }
    }
    return merged;
}

const REVISION_CONTENT_CHANNELS = ['bullets', 'items', 'metrics', 'steps'] as const;

/** Rendered text overflow has exactly one legal remedy under the revision
 * contract. Naming it next to the rejection stops the model from cycling through
 * the three illegal ones: dropping an entry, retyping the copy into another
 * channel, or splitting the slide. */
export const OVERFLOW_REPAIR_HINT = 'To clear a rendered text overflow, rewrite the existing entries shorter in place: keep the same number of entries, keep them in the channel they already use, and keep the slide count unchanged.';
const SAMPLE_FACT_CHANNELS = [
    'bullets', 'items', 'metrics', 'steps', 'comparison', 'chart', 'quote', 'attribution', 'sources',
] as const;

function arrayLength(value: unknown): number {
    return Array.isArray(value) ? value.length : 0;
}

function comparisonLength(value: unknown): number {
    const comparison = record(value);
    const left = record(comparison.left);
    const right = record(comparison.right);
    return arrayLength(left.items || left.bullets) + arrayLength(right.items || right.bullets);
}

function contentChannelCounts(slide: Record<string, unknown>): Map<string, number> {
    const counts = new Map<string, number>();
    for (const key of REVISION_CONTENT_CHANNELS) counts.set(key, arrayLength(slide[key]));
    counts.set('comparison', comparisonLength(slide.comparison));
    counts.set('chart', Object.keys(record(slide.chart)).length ? 1 : 0);
    counts.set('quote', typeof slide.quote === 'string' && slide.quote.trim() ? 1 : 0);
    // `body` is prose rather than a list, but it is rendered copy that counts against
    // the same capacity as any channel. Leaving it out of the tally let a revision
    // blank a slide's only content and call it a fix, and let one bolt a second
    // channel onto a body-only slide without ever tripping the introduced-channel
    // rule, because such a slide read as having no existing channels at all.
    counts.set('body', typeof slide.body === 'string' && slide.body.trim() ? 1 : 0);
    return counts;
}

function positiveInteger(value: unknown): number | undefined {
    const parsed = Math.trunc(Number(value));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Capacity planning may split one caller-authored source slide into several
 * rendered slides. Sample QA reports sourceSlide, while the stored design is
 * already expanded, so resolve the patch to the concrete failing sibling. */
function samplePatchTargetIndices(
    storedArgs: Record<string, unknown>,
    sourceSlide: number,
    changes: Record<string, unknown>,
): number[] {
    const slides = Array.isArray(storedArgs.slides) ? storedArgs.slides.map(record) : [];
    const sourceMatches = slides
        .map((slide, index) => ({
            index,
            source: positiveInteger(slide.__openfluxSourceSlide) || index + 1,
        }))
        .filter(item => item.source === sourceSlide)
        .map(item => item.index);
    if (sourceMatches.length <= 1) return sourceMatches.length ? sourceMatches : [sourceSlide - 1];

    const changedChannels = SAMPLE_FACT_CHANNELS.filter(channel => (
        Object.prototype.hasOwnProperty.call(changes, channel)
    ));
    if (changedChannels.length) {
        const channelMatches = sourceMatches.filter(index => changedChannels.some(channel => {
            const value = slides[index]?.[channel];
            return Array.isArray(value) ? value.length > 0 : Boolean(value);
        }));
        if (channelMatches.length) return channelMatches;
    }

    const workflow = record(storedArgs.__workflow_state);
    const qa = record(workflow.qa);
    const issues = Array.isArray(qa.issues) ? qa.issues.map(record) : [];
    const failingMatches = issues
        .filter(issue => positiveInteger(issue.sourceSlide) === sourceSlide)
        .map(issue => (positiveInteger(issue.slide) || 0) - 1)
        .filter(index => sourceMatches.includes(index));
    if (failingMatches.length) return [...new Set(failingMatches)];
    return sourceMatches;
}

/** Callers nest this beside the other workflow fields as readily as they nest
 * `revision`, so both spellings have to resolve. Reading only the top level made
 * a nested array indistinguishable from no patches at all: the revision
 * validated nothing, applied nothing, and still reported success, leaving every
 * later render byte-identical to the one before it. */
export function readSlidePatches(args: Record<string, unknown>): unknown[] {
    const source = Array.isArray(args.slide_patches)
        ? args.slide_patches
        : record(args.workflow).slide_patches;
    return Array.isArray(source) ? source : [];
}

/** Visual revision patches must preserve the rendered deck's semantic and page
 * contract. Content rewrites belong in a new design turn; allowing them here
 * can trigger auto-pagination, shift every later review page, and create an
 * expensive review/revision loop. */
export function validatePresentationRevisionPatches(
    storedArgs: Record<string, unknown>,
    requestedArgs: Record<string, unknown>,
): string | undefined {
    const workflow = record(requestedArgs.workflow);
    if (String(workflow.stage || requestedArgs.workflow_stage || '').toLowerCase() !== 'revision') return undefined;
    const patches = readSlidePatches(requestedArgs);
    if (!patches.length) return undefined;
    const slides = Array.isArray(storedArgs.slides) ? storedArgs.slides.map(record) : [];

    for (const item of patches) {
        const patch = record(item);
        const slideNumber = Math.trunc(Number(patch.slide));
        if (!Number.isFinite(slideNumber) || slideNumber < 1 || slideNumber > slides.length) continue;
        const before = slides[slideNumber - 1];
        const after = mergeRecords(before, record(patch.changes));
        const beforeCounts = contentChannelCounts(before);
        const afterCounts = contentChannelCounts(after);
        const existingChannels = [...beforeCounts].filter(([, count]) => count > 0).map(([name]) => name);
        const introducedChannels = [...afterCounts]
            .filter(([name, count]) => count > 0 && (beforeCounts.get(name) || 0) === 0)
            .map(([name]) => name);
        if (existingChannels.length > 0 && introducedChannels.length > 0) {
            return `Visual revision for slide ${slideNumber} introduced a new content channel (${introducedChannels.join(', ')}). Patch the existing ${existingChannels.join(', ')} channel or layout only so slide numbers remain stable. ${OVERFLOW_REPAIR_HINT}`;
        }
        for (const [name, count] of beforeCounts) {
            if (count > 0 && (afterCounts.get(name) || 0) < count) {
                return `Visual revision for slide ${slideNumber} removed ${name} entries. Visual QA patches must preserve every existing entry; change layout or wording without reducing the content count. ${OVERFLOW_REPAIR_HINT}`;
            }
        }
    }
    return undefined;
}

function stableValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(record(value))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]));
}

function sameValue(first: unknown, second: unknown): boolean {
    return JSON.stringify(stableValue(first)) === JSON.stringify(stableValue(second));
}

/** Metric values are factual evidence; their labels and descriptions are
 * presentation copy. A sample repair may shorten or reflow that copy, but it
 * must preserve metric count, order, and every exact value. */
function validateMetricPresentationPatch(
    storedSlide: Record<string, unknown>,
    requestedMetrics: unknown,
    slideNumber: unknown,
): string | undefined {
    const before = Array.isArray(storedSlide.metrics) ? storedSlide.metrics.map(record) : [];
    const after = Array.isArray(requestedMetrics) ? requestedMetrics.map(record) : [];
    if (before.length !== after.length) {
        return `Sample retry patch for slide ${slideNumber} changed the metric count from ${before.length} to ${after.length}. Preserve every metric and value; only label and description wording may change.`;
    }
    for (let index = 0; index < before.length; index++) {
        if (!sameValue(before[index].value, after[index].value)) {
            return `Sample retry patch for slide ${slideNumber} changed metric ${index + 1} value. Metric values are factual and must remain exact; only label and description wording may change.`;
        }
    }
    return undefined;
}

/** A sample retry repairs geometry against the stored design. It must not
 * silently rewrite, add, remove, or reorder factual records just to pass QA. */
export function validatePresentationSampleRetry(
    storedArgs: Record<string, unknown>,
    requestedArgs: Record<string, unknown>,
): string | undefined {
    const workflow = record(requestedArgs.workflow);
    if (String(workflow.stage || requestedArgs.workflow_stage || '').toLowerCase() !== 'sample') return undefined;

    // Nothing has rendered yet, so the stored slides are a rejected draft rather
    // than a deliverable with records worth preserving. A deck turned away by
    // preflight can only be fixed by changing its structure, which this contract
    // otherwise forbids; caught between the two rules, a live turn spent four
    // iterations guessing before it happened to resubmit the draft unchanged.
    const storedState = record(storedArgs.__workflow_state);
    const everRendered = Boolean(record(storedState.designSample).generatedAt || storedState.fullGeneration);
    if (storedArgs.__workflow_state && !everRendered) return undefined;

    const requestedSlides = Array.isArray(requestedArgs.slides) ? requestedArgs.slides.map(record) : [];
    const storedSlides = Array.isArray(storedArgs.slides) ? storedArgs.slides.map(record) : [];
    if (requestedSlides.length) {
        // A stored deck holds the concrete rendered pagination, so one authored
        // slide can occupy several pages. A retry that resubmits `slides` is
        // authoring, and must be measured against the authored deck; comparing it
        // to the expanded pages rejects an unchanged resubmission outright.
        const authoredSlides = authoredSlidesFromRendered(storedArgs.slides);
        if (requestedSlides.length !== authoredSlides.length) {
            return `Sample retry changed the slide count from ${authoredSlides.length} to ${requestedSlides.length}. Resume with design_id and layout-only slide_patches instead.`;
        }
        for (let index = 0; index < authoredSlides.length; index++) {
            for (const channel of SAMPLE_FACT_CHANNELS) {
                if (!sameValue(authoredSlides[index][channel], requestedSlides[index][channel])) {
                    return `Sample retry changed factual channel ${channel} on slide ${index + 1}. Resume with design_id and layout-only slide_patches; preserve every stored record exactly.`;
                }
            }
        }
    }

    const patches = readSlidePatches(requestedArgs);
    for (const item of patches) {
        const patch = record(item);
        const changes = record(patch.changes);
        const slideNumber = Math.trunc(Number(patch.slide));
        if (Object.prototype.hasOwnProperty.call(changes, 'metrics')) {
            const targetIndex = Number.isFinite(slideNumber) && slideNumber >= 1
                ? samplePatchTargetIndices(storedArgs, slideNumber, changes)
                    .find(index => Array.isArray(storedSlides[index]?.metrics) && storedSlides[index].metrics.length > 0)
                : undefined;
            const storedSlide = targetIndex !== undefined ? storedSlides[targetIndex] : undefined;
            if (!storedSlide) return `Sample retry patch contains an invalid slide number: ${patch.slide}.`;
            const metricViolation = validateMetricPresentationPatch(storedSlide, changes.metrics, patch.slide);
            if (metricViolation) return metricViolation;
        }
        const changedFactChannel = SAMPLE_FACT_CHANNELS.find(channel => (
            channel !== 'metrics' && Object.prototype.hasOwnProperty.call(changes, channel)
        ));
        if (changedFactChannel) {
            return `Sample retry patch for slide ${patch.slide} changed factual channel ${changedFactChannel}. Preserve bullets/items/steps/comparison/chart/quote/attribution/sources exactly. Patch layout, design_notes, message, body, eyebrow, purpose, or relationship_to_previous only; metric labels/descriptions may change but metric values may not.`;
        }
    }
    return undefined;
}

function manifestRoot(projectRoot: string, storeRoot?: string): string {
    const appData = storeRoot || process.env.LOCALAPPDATA || join(homedir(), '.openflux');
    const projectKey = createHash('sha256').update(resolve(projectRoot).toLowerCase()).digest('hex').slice(0, 20);
    return join(appData, 'OpenFlux', 'presentation-designs', projectKey);
}

function assertDesignId(designId: string): void {
    if (!DESIGN_ID.test(designId)) throw new Error('design_id is invalid');
}

function persistedArgs(args: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(args).filter(([key]) => PERSISTED_KEYS.has(key)));
}

export async function loadPresentationDesign(
    projectRoot: string,
    designId: string,
    storeRoot?: string,
): Promise<Record<string, unknown> | undefined> {
    assertDesignId(designId);
    const path = join(manifestRoot(projectRoot, storeRoot), `${designId}.json`);
    const raw = await fs.readFile(path, 'utf8').catch(() => undefined);
    if (!raw) return undefined;
    const manifest = JSON.parse(raw) as PresentationDesignManifest;
    if (manifest.version !== 1 || manifest.designId !== designId || resolve(manifest.projectRoot) !== resolve(projectRoot)) {
        throw new Error('Stored presentation design does not belong to the active Project');
    }
    return clone(manifest.args);
}

/**
 * The newest deck this session already built.
 *
 * A follow-up like "add a few images" starts a fresh design because the caller
 * has no reason to repeat an id it was never shown, and the new design inherits
 * none of the first one's settings — which is how an edited deck landed in the
 * output root instead of beside the deck it was editing.
 */
export async function findLatestSessionDesign(
    projectRoot: string,
    sessionId: string,
    storeRoot?: string,
): Promise<{ designId: string; args: Record<string, unknown> } | undefined> {
    if (!sessionId) return undefined;
    const root = manifestRoot(projectRoot, storeRoot);
    const names = await fs.readdir(root).catch(() => [] as string[]);
    let newest: { designId: string; args: Record<string, unknown>; updatedAt: number } | undefined;
    for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const raw = await fs.readFile(join(root, name), 'utf8').catch(() => undefined);
        if (!raw) continue;
        let manifest: PresentationDesignManifest;
        try {
            manifest = JSON.parse(raw) as PresentationDesignManifest;
        } catch {
            continue;
        }
        if (manifest.version !== 1) continue;
        if (resolve(manifest.projectRoot) !== resolve(projectRoot)) continue;
        if (record(record(manifest.args).__workflow_state).sessionId !== sessionId) continue;
        if (newest && manifest.updatedAt <= newest.updatedAt) continue;
        newest = { designId: manifest.designId, args: clone(manifest.args), updatedAt: manifest.updatedAt };
    }
    return newest ? { designId: newest.designId, args: newest.args } : undefined;
}

export async function savePresentationDesign(
    projectRoot: string,
    designId: string,
    args: Record<string, unknown>,
    storeRoot?: string,
): Promise<void> {
    assertDesignId(designId);
    const root = manifestRoot(projectRoot, storeRoot);
    await fs.mkdir(root, { recursive: true });
    const manifest: PresentationDesignManifest = {
        version: 1,
        designId,
        projectRoot: resolve(projectRoot),
        updatedAt: Date.now(),
        args: persistedArgs(args),
    };
    await fs.writeFile(join(root, `${designId}.json`), JSON.stringify(manifest, null, 2), 'utf8');
}

export async function resolvePresentationDesignArgs(
    projectRoot: string,
    args: Record<string, unknown>,
    storeRoot?: string,
): Promise<Record<string, unknown>> {
    const workflow = record(args.workflow);
    const designId = String(args.design_id || workflow.design_id || workflow.designId || '').trim();
    const hasCompletePlan = Boolean(args.brief) && Array.isArray(args.slides) && args.slides.length > 0;
    let effective = clone(args);

    if (designId) {
        const stored = await loadPresentationDesign(projectRoot, designId, storeRoot);
        if (stored) effective = mergeRecords(stored, args);
        else if (!hasCompletePlan) throw new Error(`No stored presentation design was found for design_id ${designId}`);
    } else if (!hasCompletePlan) {
        throw new Error('brief and slides are required when design_id is not supplied');
    }

    const patches = readSlidePatches(args);
    if (patches.length) {
        const slides = Array.isArray(effective.slides) ? clone(effective.slides) as unknown[] : [];
        const requestedStage = String(workflow.stage || args.workflow_stage || '').toLowerCase();
        for (const item of patches) {
            const patch = record(item);
            const slideNumber = Math.trunc(Number(patch.slide));
            const changes = record(patch.changes);
            if (!Number.isFinite(slideNumber) || slideNumber < 1 || slideNumber > slides.length) {
                throw new Error(`slide_patches contains an invalid slide number: ${patch.slide}`);
            }
            const targetIndices = requestedStage === 'sample'
                ? samplePatchTargetIndices(effective, slideNumber, changes)
                : [slideNumber - 1];
            for (const targetIndex of targetIndices) {
                if (targetIndex < 0 || targetIndex >= slides.length) continue;
                slides[targetIndex] = mergeRecords(record(slides[targetIndex]), changes);
            }
        }
        effective.slides = slides;
    }
    if (designId) effective.design_id = designId;
    return effective;
}
