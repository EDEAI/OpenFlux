import type {
    PresentationCjkLineMeasurement,
    PresentationQualityIssue,
    PresentationTextOverflowMeasurement,
} from './model';

/**
 * Deterministic text-fit repair.
 *
 * The renderer sizes every run from an estimate of how PowerPoint will wrap
 * it, and PowerPoint's own shrink-to-fit is not applied when a deck is opened
 * by automation, so the native QA pass keeps finding runs that sit a little
 * taller than their box. Those findings used to travel back to the model as
 * "cut N characters", which it rarely did precisely and often not at all.
 *
 * Every text box the renderer writes now carries a stable name, native QA
 * reports that name with each finding, and this module turns the measured
 * geometry into per-box overrides (a font multiplier and a measured wrap
 * width) that the next render applies. Only geometry changes: wording, entry
 * counts, channels and slide count are untouched, so the fact contract the
 * revision guards enforce for the model holds here by construction.
 */

export interface PresentationTextFitOverride {
    /** Multiplier applied to the font size the layout chose for this box. */
    fontScale?: number;
    /** Visual units (2 per full-width glyph, 1 otherwise) PowerPoint fit on
     * one rendered line of this box, used to place editorial line breaks where
     * they will actually hold instead of where the estimate hoped. */
    wrapUnits?: number;
    /** Repair passes already spent on this box, by issue code. */
    attempts?: Record<string, number>;
}

export type PresentationTextFitOverrides = Record<string, PresentationTextFitOverride>;

export interface PresentationTextFitSummary {
    /** Re-render passes spent on automatic fitting (0 when the first render was clean). */
    passes: number;
    /** Boxes whose geometry was adjusted, by shape name. */
    repairedShapes: string[];
    /** Mechanical findings the loop could not resolve on its own. */
    unrepairable: PresentationQualityIssue[];
}

export interface TextFitRepairPlan {
    overrides: PresentationTextFitOverrides;
    changed: boolean;
    repairedShapes: string[];
    unrepairable: PresentationQualityIssue[];
}

/** Re-render passes after the first before the remaining findings go to the model. */
export const MAX_TEXT_FIT_PASSES = 3;
/** Never shrink a run below this share of its designed size; past it the
 * copy is genuinely too long for the box and only an edit will do. */
export const MIN_TEXT_FIT_FONT_SCALE = 0.7;
/** Aim inside the measured fit: line counts are discrete, so a shrink that
 * lands exactly on the boundary tends to leave one line still spilling. */
const OVERFLOW_FIT_MARGIN = 0.94;
/** Two boxes colliding without either overflowing: shrink both a step. */
const OVERLAP_SHRINK_STEP = 0.9;
/** A CJK wrap defect that survived a measured re-wrap: shrink and re-wrap. */
const CJK_RETRY_SHRINK_STEP = 0.94;
/** Units held back from the measured line so a different glyph mix still fits. */
const WRAP_HEADROOM_UNITS = 1;
const MIN_WRAP_UNITS = 6;
const MAX_OVERLAP_ATTEMPTS = 2;
const MAX_CJK_ATTEMPTS = 3;

export const TEXT_FIT_SHAPE_PREFIX = 'ofx-text-';

export function presentationTextShapeName(slideNumber: number, ordinal: number): string {
    return `${TEXT_FIT_SHAPE_PREFIX}${slideNumber}-${ordinal}`;
}

export function isPresentationTextShapeName(name: unknown): name is string {
    return typeof name === 'string' && name.startsWith(TEXT_FIT_SHAPE_PREFIX);
}

export function visualTextUnits(value: string): number {
    return Array.from(String(value || '')).reduce((sum, character) => (
        sum + (/[^\x00-\xff]/.test(character) ? 2 : 1)
    ), 0);
}

/**
 * The widest rendered line is the closest measurement of what the box holds
 * at the size it was rendered. Lines the renderer broke by hand run short of
 * capacity; a line PowerPoint wrapped by itself runs at it.
 */
export function measuredLineCapacityUnits(
    measurement: Pick<PresentationCjkLineMeasurement, 'firstLineText' | 'lineTexts'> | Pick<PresentationTextOverflowMeasurement, 'firstLineText' | 'lineTexts'> | undefined,
): number | undefined {
    if (!measurement) return undefined;
    const lines = (measurement.lineTexts?.length ? measurement.lineTexts : [measurement.firstLineText || ''])
        .map(line => visualTextUnits(String(line || '').trim()))
        .filter(units => units > 0);
    return lines.length ? Math.max(...lines) : undefined;
}

function round3(value: number): number {
    return Math.round(value * 1000) / 1000;
}

function cloneOverrides(overrides: PresentationTextFitOverrides): PresentationTextFitOverrides {
    const copy: PresentationTextFitOverrides = {};
    for (const [name, override] of Object.entries(overrides)) {
        copy[name] = { ...override, attempts: { ...(override.attempts || {}) } };
    }
    return copy;
}

function bumpAttempt(override: PresentationTextFitOverride, code: string): number {
    override.attempts = override.attempts || {};
    override.attempts[code] = (override.attempts[code] || 0) + 1;
    return override.attempts[code];
}

function attemptsFor(override: PresentationTextFitOverride | undefined, code: string): number {
    return override?.attempts?.[code] || 0;
}

/** Shrink a box's font by `factor`, honouring the floor. Returns false when the
 * floor was already reached, which means shrinking is no longer a remedy. */
function shrink(override: PresentationTextFitOverride, factor: number): boolean {
    const current = override.fontScale ?? 1;
    if (current <= MIN_TEXT_FIT_FONT_SCALE + 1e-9) return false;
    override.fontScale = round3(Math.max(MIN_TEXT_FIT_FONT_SCALE, current * factor));
    return true;
}

/**
 * Convert one QA pass into the overrides for the next render.
 *
 * `previous` carries the overrides that produced the render being judged, so
 * repeated findings on the same box escalate instead of repeating the same
 * remedy. Findings without a shape name (an older QA script, or a shape the
 * renderer did not name) are returned as unrepairable rather than guessed at.
 *
 * Font decisions are made first and wrap widths last: a measured line width
 * belongs to the size it was measured at, and the box may be about to change
 * size in this same pass.
 */
export function planTextFitRepairs(
    issues: PresentationQualityIssue[],
    previous: PresentationTextFitOverrides = {},
): TextFitRepairPlan {
    const overrides = cloneOverrides(previous);
    const repaired = new Set<string>();
    const unrepairable: PresentationQualityIssue[] = [];
    const overflowShapes = new Set(issues
        .filter(issue => issue.code === 'text_overflow' && isPresentationTextShapeName(issue.shape))
        .map(issue => issue.shape as string));
    /** Boxes whose wrap width must be (re)derived from this pass's measurement. */
    const rewrap = new Map<string, number>();

    const overrideFor = (name: string): PresentationTextFitOverride => {
        overrides[name] = overrides[name] || {};
        return overrides[name];
    };
    const noteCapacity = (name: string, units: number | undefined) => {
        if (units === undefined) return;
        rewrap.set(name, Math.max(rewrap.get(name) || 0, units));
    };

    for (const issue of issues) {
        switch (issue.code) {
            case 'text_overflow': {
                const shape = issue.shape;
                const geometry = issue.overflow;
                if (!isPresentationTextShapeName(shape) || !geometry
                    || !(geometry.boundHeight > 0) || !(geometry.availableHeight > 0)
                    || geometry.boundHeight <= geometry.availableHeight) {
                    unrepairable.push(issue);
                    break;
                }
                const override = overrideFor(shape);
                const ratio = geometry.availableHeight / geometry.boundHeight;
                if (!shrink(override, ratio * OVERFLOW_FIT_MARGIN)) {
                    unrepairable.push(issue);
                    break;
                }
                bumpAttempt(override, issue.code);
                repaired.add(shape);
                // Wrap the next render against what PowerPoint actually fit
                // on a line, scaled to the new size. The estimate the first
                // render used runs long for mixed Latin and CJK copy, and a
                // smaller font placed by that estimate wraps mid-word.
                if ((geometry.lineTexts?.length || 0) >= 2 || override.wrapUnits !== undefined) {
                    noteCapacity(shape, measuredLineCapacityUnits(geometry));
                }
                break;
            }
            case 'cjk_orphan_line':
            case 'cjk_line_start_punctuation':
            case 'numeric_token_split': {
                const shape = issue.shape;
                const line = issue.cjkLine;
                if (!isPresentationTextShapeName(shape) || !line) {
                    unrepairable.push(issue);
                    break;
                }
                const attempts = attemptsFor(overrides[shape], issue.code);
                if (attempts >= MAX_CJK_ATTEMPTS) {
                    unrepairable.push(issue);
                    break;
                }
                const override = overrideFor(shape);
                const capacity = measuredLineCapacityUnits(line);
                if (attempts >= 1 || capacity === undefined) {
                    // Either a measured re-wrap did not clear it, so the box is
                    // too narrow for a clean break at this size, or there is
                    // nothing measured to wrap against. Shrink a step.
                    if (!shrink(override, CJK_RETRY_SHRINK_STEP)) {
                        unrepairable.push(issue);
                        break;
                    }
                }
                noteCapacity(shape, capacity);
                bumpAttempt(override, issue.code);
                repaired.add(shape);
                break;
            }
            case 'text_overlap': {
                const shapes = (issue.shapes || []).filter(isPresentationTextShapeName);
                if (!shapes.length) {
                    unrepairable.push(issue);
                    break;
                }
                // A collision caused by a run spilling out of its box clears
                // with that run's overflow repair; do not shrink twice.
                if (shapes.some(shape => overflowShapes.has(shape))) break;
                let touched = false;
                for (const shape of shapes) {
                    if (attemptsFor(overrides[shape], issue.code) >= MAX_OVERLAP_ATTEMPTS) continue;
                    const override = overrideFor(shape);
                    if (!shrink(override, OVERLAP_SHRINK_STEP)) continue;
                    bumpAttempt(override, issue.code);
                    repaired.add(shape);
                    touched = true;
                }
                if (!touched) unrepairable.push(issue);
                break;
            }
            case 'text_out_of_bounds':
                // The box itself sits off the canvas; that is a layout defect,
                // not a fit defect, and shrinking the copy would not move it.
                unrepairable.push(issue);
                break;
            default:
                break;
        }
    }

    // Wrap widths, scaled from the size they were measured at to the size
    // the box will be rendered at next: a smaller font fits proportionally
    // more units on the same line.
    for (const [shape, measuredUnits] of rewrap) {
        const before = previous[shape]?.fontScale ?? 1;
        const after = overrides[shape]?.fontScale ?? 1;
        const scaled = Math.floor(measuredUnits * (before / after)) - WRAP_HEADROOM_UNITS;
        overrideFor(shape).wrapUnits = Math.max(MIN_WRAP_UNITS, scaled);
    }

    return {
        overrides,
        changed: repaired.size > 0,
        repairedShapes: [...repaired].sort(),
        unrepairable,
    };
}
