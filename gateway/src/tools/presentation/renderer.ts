import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import PptxGenJS from 'pptxgenjs';
import sharp from 'sharp';
import { evaluatePresentationPlan } from './model';
import { presentationTextShapeName } from './text-fit';
import type { PresentationTextFitOverrides } from './text-fit';
import type {
    PresentationArtDirection,
    PresentationChart,
    PresentationComparisonSide,
    PresentationDeckPlan,
    PresentationItem,
    PresentationMetric,
    PresentationQualityIssue,
    PresentationSlidePlan,
} from './model';

const SLIDE_W = 13.333;
const SLIDE_H = 7.5;

type Slide = PptxGenJS.Slide;

interface RenderContext {
    pptx: PptxGenJS;
    slide: Slide;
    art: PresentationArtDirection;
    index: number;
    total: number;
    /** Text boxes written on this slide so far. Every text box gets the name
     * `ofx-text-<slide>-<ordinal>`, which native QA reports back with each
     * finding so the fit loop can adjust exactly that box. Naming is by call
     * order, which is deterministic for a given plan. */
    textOrdinal: number;
    /** Per-box geometry adjustments learned from a previous QA pass. */
    textFit?: PresentationTextFitOverrides;
}

interface ResolvedTextFit {
    objectName: string;
    fontScale: number;
    wrapUnits?: number;
}

/** Claim the next text-box name on this slide and look up its fit override. */
function resolveTextFit(ctx: RenderContext): ResolvedTextFit {
    ctx.textOrdinal += 1;
    const objectName = presentationTextShapeName(ctx.index + 1, ctx.textOrdinal);
    const override = ctx.textFit?.[objectName];
    return {
        objectName,
        fontScale: override?.fontScale && override.fontScale > 0 ? override.fontScale : 1,
        wrapUnits: override?.wrapUnits && override.wrapUnits > 0 ? override.wrapUnits : undefined,
    };
}

function scaledFontSize(fontSize: number | undefined, fontScale: number): number | undefined {
    if (typeof fontSize !== 'number' || fontScale === 1) return fontSize;
    return Math.round(fontSize * fontScale * 10) / 10;
}

export type PresentationSemanticTone = 'positive' | 'negative' | 'neutral';

/** Infer only explicit audience semantics. This stays intentionally
 * domain-neutral: a number is not positive merely because it is large, and a
 * conversion rate is not negative unless the surrounding copy calls it a
 * loss, risk, or shortfall. */
export function presentationSemanticTone(value: string): PresentationSemanticTone {
    const text = String(value || '');
    if (/流失|损失|下降|下滑|风险|异常|失败|缺口|延误|超支|未注册|未付费|未完成|loss|risk|declin|drop|fail|gap|overrun|churn/i.test(text)) {
        return 'negative';
    }
    if (/收益|增长|提升|改善|目标|预期|达成|完成|成功|收入|利润|节省|正向|gain|growth|improv|target|expected|success|revenue|profit|saving/i.test(text)) {
        return 'positive';
    }
    return 'neutral';
}

function semanticAccentColor(
    ctx: RenderContext,
    slidePlan: PresentationSlidePlan,
    metric: PresentationMetric,
    fallbackIndex: number,
): string {
    const metricTone = presentationSemanticTone(`${metric.label} ${metric.description || ''}`);
    const slideTone = metricTone === 'neutral'
        ? presentationSemanticTone(`${slidePlan.title || ''} ${slidePlan.message}`)
        : metricTone;
    if (slideTone === 'negative') return ctx.art.palette.accent2;
    if (slideTone === 'positive') return ctx.art.palette.accent;
    return fallbackIndex % 2 ? ctx.art.palette.accent2 : ctx.art.palette.accent;
}

function artForSurfaceRole(
    art: PresentationArtDirection,
    role: PresentationSlidePlan['resolvedLayout']['surfaceRole'],
): PresentationArtDirection {
    if (role === 'base') return art;
    return {
        ...art,
        palette: {
            ...art.palette,
            background: art.palette.surface,
            surface: art.palette.background,
        },
    };
}

export interface RenderPresentationResult {
    slideCount: number;
    compositions: string[];
    layouts: string[];
    imageIssues: PresentationQualityIssue[];
    preparedImageCount: number;
}

export interface PresentationImageFrame {
    x: number;
    y: number;
    w: number;
    h: number;
}

const IMAGE_OUTPUT_PPI = 180;
const IMAGE_WARNING_PPI = 120;
const IMAGE_ERROR_PPI = 96;

/**
 * Compositions that reserve room for a picture.
 *
 * A slide that supplies an image under any other silhouette has nowhere to put
 * it. Naming the alternatives in that error is what lets a caller move the image
 * instead of concluding the renderer cannot embed local files at all, which is
 * the wrong lesson and the one it reported to its user.
 *
 * Kept in step with resolvePresentationImageFrame by test, not by discipline.
 */
export const PRESENTATION_IMAGE_CAPABLE_SILHOUETTES = [
    'cover-centered',
    'cover-full-bleed',
    'cover-split',
    'image-split',
    'image-window',
    'image-panorama',
    'semantic-stage',
    'quote-full-bleed',
    'quote-stage',
    'closing-cta',
    'closing-centered',
] as const;

export function resolvePresentationImageFrame(
    slidePlan: PresentationSlidePlan,
    slideIndex: number,
): PresentationImageFrame | undefined {
    if (!slidePlan.imagePath) return undefined;
    const silhouette = slidePlan.resolvedLayout.silhouette;
    // A centered cover is a compact photographic masthead, not a panoramic
    // crop. Keep its frame close enough to common 3:2 / 4:3 source ratios that
    // the default `cover` fit preserves the subject instead of discarding most
    // of the generated or user-supplied image.
    if (silhouette === 'cover-centered') return { x: 3.81, y: 0.58, w: 5.72, h: 2.62 };
    if (silhouette === 'cover-full-bleed' || silhouette === 'quote-full-bleed') {
        return { x: 0, y: 0, w: SLIDE_W, h: SLIDE_H };
    }
    if (silhouette === 'cover-split') return { x: 7.95, y: 0, w: 5.383, h: SLIDE_H };
    if (silhouette === 'image-split') {
        const imageOnLeft = slidePlan.layout.imagePosition === 'left'
            ? true
            : slidePlan.layout.imagePosition === 'right' ? false : slideIndex % 2 === 0;
        return { x: imageOnLeft ? 0.14 : 7.32, y: 0, w: 6.01, h: SLIDE_H };
    }
    if (silhouette === 'image-window' || silhouette === 'semantic-stage') {
        const imageOnLeft = slidePlan.layout.imagePosition === 'left';
        const base = { x: imageOnLeft ? 0.72 : 7.26, y: 1.28, w: 5.35, h: 5.34 };
        // Brand marks should read as deliberate identities, not low-resolution
        // photographs stretched to fill an editorial image field. A compact
        // contain frame also protects transparent PNG edges and wordmarks.
        if (silhouette === 'semantic-stage' && slidePlan.imageKind === 'logo') {
            const size = 3.2;
            return {
                x: base.x + (base.w - size) / 2,
                y: base.y + (base.h - size) / 2,
                w: size,
                h: size,
            };
        }
        if (!slidePlan.imageAspectRatio) return base;
        const ratio = slidePlan.imageAspectRatio;
        if (silhouette === 'semantic-stage' && slidePlan.imageFit === 'contain') {
            const baseRatio = base.w / base.h;
            if (ratio > baseRatio) {
                const height = Math.max(2.36, Math.min(base.h, base.w / ratio));
                return { x: base.x, y: base.y + (base.h - height) / 2, w: base.w, h: height };
            }
            if (ratio < baseRatio) {
                const width = Math.max(2.48, Math.min(base.w, base.h * ratio));
                return { x: base.x + (base.w - width) / 2, y: base.y, w: width, h: base.h };
            }
            return base;
        }
        if (slidePlan.imageMask === 'circle') {
            const size = Math.min(base.w, base.h);
            return { x: base.x + (base.w - size) / 2, y: base.y + (base.h - size) / 2, w: size, h: size };
        }
        if (ratio < 0.88) {
            const width = Math.max(3.58, Math.min(base.w, base.h * Math.max(0.67, ratio)));
            return { x: base.x + (base.w - width) / 2, y: base.y, w: width, h: base.h };
        }
        if (ratio > 1.48) {
            const height = Math.max(2.82, Math.min(base.h, base.w / Math.min(2.1, ratio)));
            return { x: base.x, y: base.y + (base.h - height) / 2, w: base.w, h: height };
        }
        return base;
    }
    if (silhouette === 'image-panorama') return { x: 0.14, y: 3.72, w: 13.193, h: 3.78 };
    if (silhouette === 'quote-stage') return { x: 8.92, y: 0, w: 4.413, h: SLIDE_H };
    if (silhouette === 'closing-cta') return { x: 9.18, y: 3.72, w: 2.78, h: 2.78 };
    if (silhouette === 'closing-centered') return { x: 5.28, y: 5.62, w: 2.78, h: 0.88 };
    return undefined;
}

function marginX(ctx: RenderContext): number {
    return ctx.art.grid.margin;
}

function titleSize(ctx: RenderContext, value: number): number {
    return Math.round(value * ctx.art.typography.titleScale * 10) / 10;
}

function bodySize(ctx: RenderContext, value: number): number {
    return Math.round(value * ctx.art.typography.bodyScale * 10) / 10;
}

function visualTextUnits(value: string): number {
    return Array.from(value).reduce((sum, character) => (
        sum + (/[^\x00-\xff]/.test(character) ? 2 : 1)
    ), 0);
}

export interface MetricLabelTextLayout {
    fontSize: number;
    height: number;
}

export interface MetricValueTextLayout extends MetricLabelTextLayout {
    lines: number;
}

export interface BoundedTextLayout extends MetricValueTextLayout {
    fits: boolean;
}

/** Insert an intentional line break close to the visual midpoint. Native
 * PowerPoint wrapping greedily fills the first line, which can leave a single
 * CJK word or date fragment stranded on line two. Prefer punctuation and word
 * boundaries so long headlines read like editorial headlines, not overflow. */
export function balancedTitleText(value: string): string {
    const text = String(value || '').trim();
    if (!text || /\r?\n/.test(text)) return text;
    const characters = Array.from(text);
    const target = visualTextUnits(text) / 2;
    const candidates: Array<{ index: number; balancePenalty: number; boundaryRank: number }> = [];
    for (let index = 1; index < characters.length; index++) {
        const previous = characters[index - 1] || '';
        const next = characters[index] || '';
        const punctuationBoundary = /[：:，,；;。！？!?、]/.test(previous);
        const whitespaceBoundary = /\s/.test(previous) || /\s/.test(next);
        const safeCharacterBoundary = !(/[A-Za-z0-9]/.test(previous) && /[A-Za-z0-9]/.test(next));
        if (/^[，。；：！？、）》】」』％%—–]/.test(next) || /[（《【「『]$/.test(previous)) continue;
        if (!punctuationBoundary && !whitespaceBoundary && !safeCharacterBoundary) continue;
        const leftUnits = visualTextUnits(characters.slice(0, index).join(''));
        const balancePenalty = Math.abs(leftUnits - target);
        const boundaryRank = punctuationBoundary ? 0 : whitespaceBoundary ? 1 : 2;
        candidates.push({ index, balancePenalty, boundaryRank });
    }
    const selected = candidates.sort((a, b) => {
        // Prefer a real language boundary when it is reasonably close to the
        // optical midpoint, but do not let a very early acronym/space create
        // a tiny first line. Each boundary rank is worth six visual units.
        const leftScore = a.balancePenalty + a.boundaryRank * 6;
        const rightScore = b.balancePenalty + b.boundaryRank * 6;
        return leftScore - rightScore
            || a.balancePenalty - b.balancePenalty
            || a.boundaryRank - b.boundaryRank;
    })[0];
    if (!selected) return text;
    const left = characters.slice(0, selected.index).join('').trimEnd();
    const right = characters.slice(selected.index).join('').trimStart();
    return left && right ? `${left}\n${right}` : text;
}

const CJK_CLOSING_PUNCTUATION = /^[，。；：！？、）》】」』％%—–]/;
const CJK_OPENING_PUNCTUATION = /[（《【「『]$/;
const WRAP_PUNCTUATION = /[，。；：！？、,.;:!?]/;

function splitsNumericToken(characters: string[], index: number): boolean {
    const previous = characters[index - 1] || '';
    const current = characters[index] || '';
    const next = characters[index + 1] || '';
    const afterNext = characters[index + 2] || '';
    if (/\d/.test(current) && /[%％+]/.test(next)) return true;
    if (/\d/.test(current) && /[.,]/.test(next) && /\d/.test(afterNext)) return true;
    if (/[.,]/.test(current) && /\d/.test(previous) && /\d/.test(next)) return true;
    if (/\d/.test(current) && /[:：]/.test(next) && /\d/.test(afterNext)) return true;
    if (/[:：]/.test(current) && /\d/.test(previous) && /\d/.test(next)) return true;
    return false;
}

/** Pre-wrap narrow CJK body copy at readable boundaries. PowerPoint's native
 * wrapping may strand punctuation at line start or leave one-to-three CJK
 * characters on the final line; explicit paragraphs make the result stable. */
/** Wrap into at most `targetLines` lines when the boundaries allow it.
 * Dividing the units evenly picks a limit the balancer cannot always honour:
 * it prefers a clean boundary short of the limit, and the spill then needs
 * one more line, which is how a two-line box came to hold three lines and
 * overflow in PowerPoint. Widen the limit until the line count is met. */
export function balancedCjkBodyTextInLines(value: string, targetLines: number): string {
    const units = visualTextUnits(value);
    const lines = Math.max(1, Math.floor(targetLines));
    if (lines <= 1) return value;
    let limit = Math.ceil(units / lines);
    let wrapped = balancedCjkBodyText(value, limit);
    while (wrapped.split('\n').length > lines && limit < units) {
        limit += 1;
        wrapped = balancedCjkBodyText(value, limit);
    }
    return wrapped;
}

export function balancedCjkBodyText(value: string, maxVisualUnits = 26): string {
    const sourceParagraphs = String(value || '').split(/\r?\n/);
    const wrappedParagraphs: string[] = [];
    const limit = Math.max(12, Math.floor(maxVisualUnits));

    for (const sourceParagraph of sourceParagraphs) {
        let remaining = sourceParagraph.trim();
        const lines: string[] = [];
        while (remaining && visualTextUnits(remaining) > limit) {
            const characters = Array.from(remaining);
            let units = 0;
            let furthest = 1;
            const candidates: Array<{ index: number; rank: number; units: number }> = [];
            for (let index = 0; index < characters.length; index++) {
                units += visualTextUnits(characters[index]!);
                if (units > limit) break;
                furthest = index + 1;
                const current = characters[index] || '';
                const next = characters[index + 1] || '';
                if (CJK_OPENING_PUNCTUATION.test(current)) continue;
                const afterPunctuation = WRAP_PUNCTUATION.test(current);
                const atWhitespace = /\s/.test(current) || /\s/.test(next);
                const safeCharacterBoundary = !(/[A-Za-z0-9]/.test(current) && /[A-Za-z0-9]/.test(next));
                if (!splitsNumericToken(characters, index)
                    && (afterPunctuation || atWhitespace || safeCharacterBoundary)) {
                    candidates.push({
                        index: index + 1,
                        rank: afterPunctuation ? 0 : atWhitespace ? 1 : 2,
                        units,
                    });
                }
            }
            const minimumUsefulUnits = limit * 0.56;
            const selected = candidates
                .filter(candidate => candidate.units >= minimumUsefulUnits)
                .sort((left, right) => left.rank - right.rank || right.units - left.units)[0];
            let splitAt = selected?.index || furthest;
            while (splitAt < characters.length && CJK_CLOSING_PUNCTUATION.test(characters[splitAt] || '')) {
                splitAt += 1;
            }
            while (splitAt > 1 && CJK_OPENING_PUNCTUATION.test(characters[splitAt - 1] || '')) {
                splitAt -= 1;
            }
            // If the next line would begin with only one-to-three Han
            // characters followed by punctuation (for example `恩，`), keep
            // a four-character phrase together by moving a few characters
            // from the previous line. This prevents PowerPoint from turning a
            // proper noun or compact term into an internal orphan.
            const upcoming = characters.slice(splitAt).join('');
            const shortPunctuatedTail = upcoming.match(/^([\u3400-\u9FFF]{1,3})[，。；：！？、—–]/);
            if (shortPunctuatedTail) {
                const moveBack = 4 - Array.from(shortPunctuatedTail[1]).length;
                if (splitAt - moveBack >= 4) splitAt -= moveBack;
            }
            // A one- or two-character fragment before `的` is usually the
            // tail of a compact noun (for example `冲击力的`). Keep at least
            // three Han characters with the particle so narrow editorial
            // rails do not turn a phrase into `冲` / `击力的...`.
            const shortAttributiveTail = characters.slice(splitAt).join('')
                .match(/^([\u3400-\u9FFF]{1,2})的/);
            if (shortAttributiveTail) {
                const moveBack = 3 - Array.from(shortAttributiveTail[1]).length;
                if (splitAt - moveBack >= 4) splitAt -= moveBack;
            }
            // Tail rebalancing above may move the split back onto punctuation
            // that the first pass had already protected. Re-apply the hard
            // boundary rule last so an explicit newline can never begin with
            // a comma, full stop, closing bracket, or similar glyph.
            while (splitAt < characters.length && CJK_CLOSING_PUNCTUATION.test(characters[splitAt] || '')) {
                splitAt += 1;
            }
            while (splitAt > 1 && CJK_OPENING_PUNCTUATION.test(characters[splitAt - 1] || '')) {
                splitAt -= 1;
            }
            const line = characters.slice(0, splitAt).join('').trim();
            remaining = characters.slice(splitAt).join('').trim();
            if (!line) break;
            lines.push(line);
        }
        if (remaining) lines.push(remaining);

        if (lines.length >= 2) {
            const last = lines.at(-1)!;
            const previous = lines.at(-2)!;
            if (/^[\u3400-\u9FFF]{1,3}$/.test(last) && Array.from(previous).length >= 8) {
                const previousCharacters = Array.from(previous);
                const transferCount = Math.min(3, Math.max(1, 4 - Array.from(last).length));
                const transfer = previousCharacters.splice(-transferCount).join('');
                lines[lines.length - 2] = previousCharacters.join('').trimEnd();
                lines[lines.length - 1] = `${transfer}${last}`.trimStart();
            }
        }
        wrappedParagraphs.push(lines.join('\n'));
    }
    return wrappedParagraphs.join('\n');
}

/** Size metric labels from the real horizontal budget. PowerPoint's
 * `fit: shrink` is not consistently applied before native overflow QA, so the
 * generated font must already fit CJK and mixed-language labels. */
export function metricLabelTextLayout(
    value: string,
    width: number,
    requestedFontSize: number,
): MetricLabelTextLayout {
    const emUnits = Math.max(1, visualTextUnits(value) / 2);
    const singleLineFont = width * 72 * 0.82 / emUnits;
    if (singleLineFont >= 11.5) {
        return {
            fontSize: Math.round(Math.min(requestedFontSize, singleLineFont) * 10) / 10,
            height: 0.62,
        };
    }
    const twoLineFont = width * 72 * 1.55 / emUnits;
    return {
        fontSize: Math.round(Math.max(10.5, Math.min(requestedFontSize, twoLineFont)) * 10) / 10,
        height: 0.82,
    };
}

/** Keep metric values visually prominent without relying on PowerPoint's
 * delayed auto-fit. Mixed CJK/date/score values commonly wrap even when their
 * JavaScript character count looks short, so calculate from typographic units
 * and reserve the matching number of lines up front. */
export function metricValueTextLayout(
    value: string,
    width: number,
    requestedFontSize: number,
    maxHeight = 1.62,
): MetricValueTextLayout {
    const emUnits = Math.max(1, visualTextUnits(value) / 2);
    const widthBudget = Math.max(0.5, width) * 72 * 0.72;
    const singleLineFont = widthBudget / emUnits;
    const lines = singleLineFont >= requestedFontSize ? 1 : 2;
    let fontSize = Math.min(requestedFontSize, widthBudget * lines / emUnits);
    fontSize = Math.max(12, fontSize);
    const lineHeight = 1.33;
    const heightPadding = 0.12;
    const height = lines * fontSize * lineHeight / 72 + heightPadding;
    if (height > maxHeight) {
        fontSize = Math.max(12, (maxHeight - heightPadding) * 72 / (lines * lineHeight));
    }
    return {
        fontSize: Math.round(fontSize * 10) / 10,
        height: Math.round(Math.min(maxHeight, Math.max(0.66, lines * fontSize * lineHeight / 72 + heightPadding)) * 100) / 100,
        lines,
    };
}

function metricDescriptionTextLayout(
    value: string,
    width: number,
    requestedFontSize: number,
    maxHeight: number,
): MetricValueTextLayout {
    const emUnits = Math.max(1, visualTextUnits(value) / 2);
    const widthBudget = Math.max(0.5, width) * 72 * 0.68;
    let fontSize = Math.min(requestedFontSize, widthBudget * 3 / emUnits);
    // 12pt floor: the reviewing model graded 10pt card notes unreadable on
    // every metric page, and a note that needs less than 12pt to fit is a
    // note the text-fit loop should shrink from a measured overflow, not one
    // the layout should pre-emptively squeeze.
    fontSize = Math.max(12, fontSize);
    let lines = Math.max(1, Math.min(3, Math.ceil(emUnits / Math.max(1, widthBudget / fontSize))));
    const lineHeight = 1.55;
    const heightPadding = 0.16;
    if (lines * fontSize * lineHeight / 72 + heightPadding > maxHeight) {
        fontSize = Math.max(12, (maxHeight - heightPadding) * 72 / (lines * lineHeight));
        lines = Math.max(1, Math.min(3, Math.ceil(emUnits / Math.max(1, widthBudget / fontSize))));
    }
    return {
        fontSize: Math.round(fontSize * 10) / 10,
        // Use the whole allocated rail. PowerPoint's BoundHeight can be larger
        // than its visible line box for mixed CJK/Latin fallback fonts.
        height: Math.round(maxHeight * 100) / 100,
        lines,
    };
}

/** Bento's most useful lesson for the PowerPoint path is to size text from the
 * renderer's actual box contract instead of JavaScript character counts. This
 * deterministic preflight mirrors that API for PPTX layout selection; native
 * PowerPoint BoundHeight remains the authoritative post-render validator. */
export function boundedTextLayout(
    value: string,
    width: number,
    height: number,
    requestedFontSize: number,
    minimumFontSize = 16,
): BoundedTextLayout {
    const paragraphs = String(value || '').split(/\r?\n/);
    const minimum = Math.min(requestedFontSize, Math.max(8, minimumFontSize));
    const capacityAt = (fontSize: number) => Math.max(1, width * 72 * 0.68 / fontSize);
    const linesAt = (fontSize: number) => paragraphs.reduce((sum, paragraph) => (
        sum + Math.max(1, Math.ceil((visualTextUnits(paragraph) / 2) / capacityAt(fontSize)))
    ), 0);
    const requiredHeight = (fontSize: number, lines: number) => (
        lines * fontSize * 1.48 / 72
        + Math.max(0, paragraphs.length - 1) * fontSize * 0.18 / 72
        + 0.12
    );
    for (let fontSize = requestedFontSize; fontSize >= minimum; fontSize -= 0.5) {
        const lines = linesAt(fontSize);
        const needed = requiredHeight(fontSize, lines);
        if (needed <= height) {
            return {
                fontSize: Math.round(fontSize * 10) / 10,
                height: Math.round(needed * 100) / 100,
                lines,
                fits: true,
            };
        }
    }
    const lines = linesAt(minimum);
    return {
        fontSize: Math.round(minimum * 10) / 10,
        height: Math.round(requiredHeight(minimum, lines) * 100) / 100,
        lines,
        fits: requiredHeight(minimum, lines) <= height,
    };
}

/** Keep factual cover copy intact while reserving enough vertical space for
 * CJK and mixed-language lines. The minimum base size remains 16pt. */
function centeredCoverSubtitleLayout(value: string): { fontSize: number; height: number } {
    const units = visualTextUnits(value);
    if (units <= 84) return { fontSize: 20, height: 0.82 };
    if (units <= 120) return { fontSize: 18, height: 1.06 };
    if (units <= 168) return { fontSize: 16, height: 1.34 };
    return { fontSize: 16, height: 1.52 };
}

function cardRadius(ctx: RenderContext): number {
    return ctx.art.spacing === 'generous' ? 0.12 : ctx.art.spacing === 'tight' ? 0.03 : 0.07;
}

function visualLanguage(ctx: RenderContext): PresentationArtDirection['visualLanguage'] {
    return ctx.art.visualLanguage || (/launch|bold|cinematic|kinetic/i.test(ctx.art.mood)
        ? 'kinetic'
        : /editorial|story|asymmetric/i.test(ctx.art.mood) ? 'editorial' : 'precision');
}

function relativeColorLuminance(value: string): number {
    const channels = [0, 2, 4].map(offset => Number.parseInt(value.slice(offset, offset + 2), 16) / 255);
    const linear = channels.map(channel => channel <= 0.03928
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4);
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function colorContrast(first: string, second: string): number {
    const left = relativeColorLuminance(first);
    const right = relativeColorLuminance(second);
    return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

function textOn(ctx: RenderContext, fill: string): string {
    const candidates = [ctx.art.palette.background, ctx.art.palette.text, 'FFFFFF', '111111'];
    return [...candidates].sort((left, right) => colorContrast(right, fill) - colorContrast(left, fill))[0]!;
}

function mixColor(first: string, second: string, amount: number): string {
    const weight = Math.max(0, Math.min(1, amount));
    return [0, 2, 4].map(offset => {
        const left = Number.parseInt(first.slice(offset, offset + 2), 16);
        const right = Number.parseInt(second.slice(offset, offset + 2), 16);
        return Math.round(left + (right - left) * weight).toString(16).padStart(2, '0');
    }).join('').toUpperCase();
}

function addText(
    ctx: RenderContext,
    value: string,
    options: PptxGenJS.TextPropsOptions,
    fit: ResolvedTextFit = resolveTextFit(ctx),
): void {
    const width = typeof options.w === 'number' ? options.w : 0;
    const fontSize = scaledFontSize(options.fontSize, fit.fontScale) || 0;
    // A measured wrap width from a previous QA pass supersedes both the
    // estimate and any breaks the caller placed against that estimate: those
    // are the breaks PowerPoint has already shown not to hold.
    const rewrapMeasured = fit.wrapUnits !== undefined && /[^\x00-\xff]/.test(value);
    const shouldBalanceBody = width > 0
        && fontSize > 0
        && fontSize <= 20
        && /[^\x00-\xff]/.test(value)
        && !/\r?\n/.test(value);
    const prepared = rewrapMeasured
        ? balancedCjkBodyText(value.replace(/\s*\r?\n\s*/g, ''), fit.wrapUnits!)
        : shouldBalanceBody
            ? balancedCjkBodyText(value, width * 72 * 1.65 / fontSize)
            : value;
    const textValue: string | PptxGenJS.TextProps[] = /\r?\n/.test(prepared)
        ? prepared.split(/\r?\n/).map((line, index, lines) => ({
            text: line,
            options: index < lines.length - 1 ? { breakLine: true } : {},
        }))
        : prepared;
    ctx.slide.addText(textValue, {
        fontFace: ctx.art.typography.body,
        color: ctx.art.palette.text,
        margin: 0,
        breakLine: false,
        fit: 'shrink',
        valign: 'middle',
        ...options,
        ...(fontSize > 0 ? { fontSize } : {}),
        objectName: fit.objectName,
    });
}

/** Write editorial line breaks as real PowerPoint text runs. Passing a plain
 * string containing `\n` to PptxGenJS can be normalized back into one run,
 * which lets PowerPoint greedily re-wrap the headline and strand an orphan.
 * Keep this scoped to display copy; body paragraphs retain native wrapping. */
function addBalancedText(
    ctx: RenderContext,
    value: string,
    options: PptxGenJS.TextPropsOptions,
): void {
    const fit = resolveTextFit(ctx);
    const lines = String(value || '').split(/\r?\n/);
    if (lines.length <= 1 || fit.wrapUnits !== undefined) {
        addText(ctx, value, options, fit);
        return;
    }
    const runs: PptxGenJS.TextProps[] = lines.map((line, index) => ({
        text: line,
        options: index < lines.length - 1 ? { breakLine: true } : {},
    }));
    const fontSize = scaledFontSize(options.fontSize, fit.fontScale);
    ctx.slide.addText(runs, {
        fontFace: ctx.art.typography.body,
        color: ctx.art.palette.text,
        margin: 0,
        breakLine: false,
        fit: 'shrink',
        valign: 'middle',
        ...options,
        ...(typeof fontSize === 'number' ? { fontSize } : {}),
        objectName: fit.objectName,
    });
}

function addBackground(ctx: RenderContext): void {
    const { palette } = ctx.art;
    const language = visualLanguage(ctx);
    ctx.slide.background = { color: palette.background };
    if (ctx.art.backgroundTreatment === 'tonal') {
        ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
            x: 8.45,
            y: 0,
            w: SLIDE_W - 8.45,
            h: SLIDE_H,
            line: { color: palette.surface, transparency: 100 },
            fill: { color: palette.surface, transparency: 18 },
        });
    } else if (ctx.art.backgroundTreatment === 'contrast') {
        ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
            x: 0,
            y: 6.98,
            w: SLIDE_W,
            h: 0.52,
            line: { color: palette.accent, transparency: 100 },
            fill: { color: palette.accent },
        });
    }

    if (ctx.art.motif === 'line') {
        ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
            x: 0,
            y: 0,
            w: 0.14,
            h: SLIDE_H,
            line: { color: palette.accent, transparency: 100 },
            fill: { color: palette.accent },
        });
    } else if (ctx.art.motif === 'frame') {
        ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
            x: 0.28,
            y: 0.28,
            w: SLIDE_W - 0.56,
            h: SLIDE_H - 0.56,
            line: { color: palette.accent, transparency: 55, width: 1 },
            fill: { color: palette.background, transparency: 100 },
        });
    } else if (ctx.art.motif === 'orbit') {
        ctx.slide.addShape(ctx.pptx.ShapeType.arc, {
            x: 10.45,
            y: -1.05,
            w: 3.65,
            h: 3.65,
            rotate: 22,
            line: { color: palette.accent, transparency: 35, width: 1.4 },
            fill: { color: palette.background, transparency: 100 },
        });
    } else if (ctx.art.motif === 'blocks') {
        ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
            x: 11.72,
            y: 0.48,
            w: 0.72,
            h: 0.16,
            line: { color: palette.accent, transparency: 100 },
            fill: { color: palette.accent },
        });
        ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
            x: 12.52,
            y: 0.48,
            w: 0.28,
            h: 0.16,
            line: { color: palette.accent2, transparency: 100 },
            fill: { color: palette.accent2 },
        });
    }


    // A theme-level signature is deliberately stronger than the legacy motif.
    // It gives a deck recognizable design DNA while leaving the information
    // renderer and request routing unchanged.
    if (language === 'precision') {
        ctx.slide.addShape(ctx.pptx.ShapeType.line, {
            x: 9.92,
            y: 0.46,
            w: 2.52,
            h: 0,
            line: { color: palette.accent, transparency: 28, width: 1.1 },
        });
        addText(ctx, `${String(ctx.index + 1).padStart(2, '0')} / ${String(ctx.total).padStart(2, '0')}`, {
            x: 10.68,
            y: 0.22,
            w: 1.72,
            h: 0.24,
            fontSize: 9,
            bold: true,
            color: palette.muted,
            align: 'right',
            charSpacing: 1.2,
        });
    } else if (language === 'editorial') {
        const blockX = ctx.index % 2 === 0 ? 9.22 : 0.14;
        ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
            x: blockX,
            y: 0,
            w: 4.11,
            h: SLIDE_H,
            line: { color: palette.surface, transparency: 100 },
            fill: { color: palette.surface, transparency: 38 },
        });
        if (ctx.index > 0 && ctx.index < ctx.total - 1) addText(ctx, String(ctx.index + 1).padStart(2, '0'), {
                x: blockX + (blockX < 1 ? 0.28 : 2.6),
                y: 6.14,
                w: 1.2,
                h: 0.72,
                fontFace: ctx.art.typography.heading,
                fontSize: 38,
                bold: true,
                color: palette.accent,
                transparency: 72,
                align: blockX < 1 ? 'left' : 'right',
            } as any);
    } else {
        ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
            x: 9.38,
            y: 0.38,
            w: 3.15,
            h: 0.12,
            line: { color: palette.accent, transparency: 100 },
            fill: { color: palette.accent },
        });
        ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
            x: 12.62,
            y: 0.38,
            w: 0.42,
            h: 0.12,
            line: { color: palette.accent2, transparency: 100 },
            fill: { color: palette.accent2 },
        });
    }
}

function addFooter(ctx: RenderContext): void {
    const { palette } = ctx.art;
    ctx.slide.addShape(ctx.pptx.ShapeType.line, {
        x: marginX(ctx),
        y: 7.08,
        w: 11.77,
        h: 0,
        line: { color: palette.muted, transparency: 78, width: 0.7 },
    });
    if (visualLanguage(ctx) !== 'editorial') addText(ctx, String(ctx.index + 1).padStart(2, '0'), {
            x: 12.08,
            y: 7.12,
            w: 0.46,
            h: 0.18,
            fontFace: ctx.art.typography.body,
            fontSize: 9,
            color: palette.muted,
            align: 'right',
        });
}

function addEyebrow(ctx: RenderContext, value?: string): void {
    if (!value) return;
    addText(ctx, value.toUpperCase(), {
        x: marginX(ctx),
        y: 0.45,
        w: 6.9,
        h: 0.28,
        fontFace: ctx.art.typography.body,
        fontSize: bodySize(ctx, 11),
        bold: true,
        charSpacing: 1.6,
        color: ctx.art.palette.accent,
    });
}

function addSlideTitle(ctx: RenderContext, slidePlan: PresentationSlidePlan, width = 11.7): void {
    addEyebrow(ctx, slidePlan.eyebrow);
    const language = visualLanguage(ctx);
    const title = slidePlan.title || slidePlan.message;
    const continuationTitle = title.match(/^(.*?)(\s*[（(]\d+\/\d+[）)])$/);
    const displayTitle = continuationTitle ? continuationTitle[1].trim() : title;
    const titleWidth = continuationTitle ? Math.max(1, width - 1.05) : width;
    const titleEmUnits = Math.max(1, visualTextUnits(displayTitle) / 2);
    const singleLineFont = titleWidth * 72 * 0.72 / titleEmUnits;
    const needsSecondLine = singleLineFont < 24;
    const oneLineCap = language === 'precision' ? 36 : language === 'editorial' ? 39 : 41;
    const twoLineCap = language === 'precision' ? 31 : language === 'editorial' ? 33 : 34;
    const requestedTitleSize = needsSecondLine
        ? Math.min(twoLineCap, titleWidth * 72 * 1.35 / titleEmUnits)
        : Math.min(oneLineCap, singleLineFont);
    const laidOutTitle = needsSecondLine ? balancedTitleText(displayTitle) : displayTitle;
    addBalancedText(ctx, laidOutTitle, {
        x: marginX(ctx),
        y: slidePlan.eyebrow ? 0.82 : 0.62,
        w: titleWidth,
        h: needsSecondLine ? 1.58 : 1.22,
        fontFace: ctx.art.typography.heading,
        fontSize: titleSize(ctx, Math.max(24, requestedTitleSize)),
        bold: true,
        color: ctx.art.palette.text,
        valign: 'top',
        breakLine: false,
    });
    if (!needsSecondLine && language === 'editorial') {
        ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
            x: marginX(ctx), y: 1.58, w: 2.42, h: 0.07,
            line: { color: ctx.art.palette.accent, transparency: 100 },
            fill: { color: ctx.art.palette.accent },
        });
    } else if (!needsSecondLine && language === 'kinetic') {
        ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
            x: marginX(ctx), y: 1.58, w: 3.62, h: 0.1,
            line: { color: ctx.art.palette.accent2, transparency: 100 },
            fill: { color: ctx.art.palette.accent2 },
        });
    }
    if (continuationTitle) {
        addText(ctx, continuationTitle[2].trim(), {
            x: marginX(ctx) + Math.max(0, width - 0.9),
            y: slidePlan.eyebrow ? 0.54 : 0.4,
            w: 0.9,
            h: 0.34,
            fontSize: bodySize(ctx, 10.5),
            bold: true,
            color: ctx.art.palette.muted,
            align: 'right',
        });
    }
}

function addBody(ctx: RenderContext, body: string | undefined, x: number, y: number, w: number, h: number): void {
    if (!body) return;
    const layout = boundedTextLayout(body, w, h, bodySize(ctx, 19), 16);
    addText(ctx, body, {
        x,
        y,
        w,
        h,
        fontSize: layout.fontSize,
        color: ctx.art.palette.muted,
        valign: 'top',
        breakLine: false,
        paraSpaceAfter: 5,
        lineSpacingMultiple: 1,
    });
}

function addBulletList(
    ctx: RenderContext,
    bullets: string[],
    x: number,
    y: number,
    w: number,
    h: number,
    fontSize = 20,
    paraSpaceAfter = 13,
    color = ctx.art.palette.text,
): void {
    if (bullets.length === 0) return;
    const fit = resolveTextFit(ctx);
    const fittedFontSize = scaledFontSize(fontSize, fit.fontScale) || fontSize;
    const runs: PptxGenJS.TextProps[] = [];
    bullets.forEach((bullet, index) => {
        const wrappedBullet = balancedCjkBodyText(
            bullet.replace(/\s*\r?\n\s*/g, ''),
            fit.wrapUnits ?? Math.max(12, (w - 0.32) * 72 * 1.65 / Math.max(1, fittedFontSize)),
        );
        runs.push({
            text: wrappedBullet,
            options: {
                bullet: { type: 'bullet' },
                breakLine: index < bullets.length - 1,
                // Paragraph spacing is part of the run's height; a fit
                // shrink that left it alone kept the list a few points tall.
                paraSpaceAfter: Math.round(paraSpaceAfter * fit.fontScale * 10) / 10,
                color,
            },
        });
    });
    ctx.slide.addText(runs, {
        x,
        y,
        w,
        h,
        fontFace: ctx.art.typography.body,
        fontSize: fittedFontSize,
        color,
        margin: 0,
        breakLine: false,
        fit: 'shrink',
        valign: 'top',
        objectName: fit.objectName,
    });
}

function addInsightStrip(
    ctx: RenderContext,
    bullets: string[],
    y: number,
    height: number,
): void {
    if (!bullets.length) return;
    const gap = 0.28;
    const width = (11.75 - gap * (bullets.length - 1)) / bullets.length;
    bullets.forEach((bullet, index) => {
        const x = marginX(ctx) + index * (width + gap);
        ctx.slide.addShape(ctx.pptx.ShapeType.roundRect, {
            x,
            y,
            w: width,
            h: height,
            rectRadius: cardRadius(ctx),
            line: { color: ctx.art.palette.muted, transparency: 84, width: 0.6 },
            fill: { color: ctx.art.palette.surface, transparency: 8 },
        } as any);
        ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
            x,
            y,
            w: 0.05,
            h: height,
            line: { color: ctx.art.palette.accent, transparency: 100 },
            fill: { color: ctx.art.palette.accent },
        });
        addText(ctx, bullet, {
            x: x + 0.22,
            y: y + 0.11,
            w: width - 0.34,
            h: height - 0.18,
            fontSize: bodySize(ctx, 16),
            color: ctx.art.palette.text,
            valign: 'middle',
        });
    });
}

function addReadingRail(
    ctx: RenderContext,
    body: string | undefined,
    bullets: string[],
    x: number,
    y: number,
    w: number,
    h: number,
    textColor = ctx.art.palette.text,
    mutedColor = ctx.art.palette.muted,
    markerColor = ctx.art.palette.accent,
): void {
    let cursor = y;
    if (body) {
        // When there are no bullets, the body is the reading rail rather than
        // a short preface. Give it the full vertical field so PowerPoint does
        // not shrink and re-wrap a carefully balanced CJK paragraph.
        const bodyH = bullets.length
            ? Math.min(1.12, Math.max(0.72, h * 0.28))
            : h;
        const wrappedBody = balancedCjkBodyText(body, Math.max(18, Math.floor(w * 6)));
        const bodyLayout = boundedTextLayout(wrappedBody, w, bodyH, bodySize(ctx, 16), 12);
        addBalancedText(ctx, wrappedBody, {
            x,
            y: cursor,
            w,
            h: bodyH,
            fontSize: bodyLayout.fontSize,
            color: mutedColor,
            valign: 'top',
            lineSpacingMultiple: 1.04,
        });
        cursor += bodyH + 0.26;
    }
    if (!bullets.length) return;
    const available = Math.max(0.7, y + h - cursor);
    const rowH = available / bullets.length;
    bullets.forEach((bullet, index) => {
        const rowY = cursor + index * rowH;
        ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
            x,
            y: rowY + 0.08,
            w: 0.05,
            h: Math.max(0.32, rowH - 0.18),
            line: { color: markerColor, transparency: 100 },
            fill: { color: markerColor },
        });
        const wrappedBullet = balancedCjkBodyText(bullet, Math.max(28, Math.floor((w - 0.22) * 11)));
        const bulletLayout = boundedTextLayout(wrappedBullet, w - 0.22, rowH, bodySize(ctx, 16), 12);
        addBalancedText(ctx, wrappedBullet, {
            x: x + 0.22,
            y: rowY,
            w: w - 0.22,
            h: rowH,
            fontSize: bulletLayout.fontSize,
            color: textColor,
            valign: 'middle',
        });
    });
}

function addImage(
    ctx: RenderContext,
    path: string,
    altText: string | undefined,
    x: number,
    y: number,
    w: number,
    h: number,
    mask: PresentationSlidePlan['imageMask'] = 'none',
): void {
    const isFullBleed = x <= 0 && y <= 0 && w >= SLIDE_W && h >= SLIDE_H;
    if (ctx.art.imageTreatment === 'framed'
        && !isFullBleed
        && !['arch', 'soft-edge'].includes(mask)) {
        const frameShape = mask === 'circle'
            ? ctx.pptx.ShapeType.ellipse
            : ctx.pptx.ShapeType.roundRect;
        ctx.slide.addShape(frameShape, {
            x: x - 0.08,
            y: y - 0.08,
            w: w + 0.16,
            h: h + 0.16,
            ...(mask === 'circle' ? {} : { rectRadius: cardRadius(ctx) }),
            line: { color: ctx.art.palette.muted, transparency: 72, width: 0.8 },
            fill: { color: ctx.art.palette.surface },
            ...(mask === 'circle'
                ? {}
                : { shadow: { type: 'outer', color: '000000', opacity: 0.16, blur: 2, angle: 45, distance: 1 } }),
        } as any);
    }
    ctx.slide.addImage({
        path,
        x,
        y,
        w,
        h,
        altText: altText || 'Presentation visual',
    });
}

function renderFocalMetricStrip(
    ctx: RenderContext,
    slidePlan: PresentationSlidePlan,
    x: number,
    y: number,
    w: number,
): void {
    const metrics = slidePlan.metrics.slice(0, 4);
    if (!metrics.length) return;
    const gap = 0.18;
    const itemW = (w - gap * (metrics.length - 1)) / metrics.length;
    ctx.slide.addShape(ctx.pptx.ShapeType.line, {
        x,
        y: y - 0.14,
        w,
        h: 0,
        line: { color: ctx.art.palette.muted, transparency: 70, width: 0.8 },
    });
    metrics.forEach((metric, index) => {
        const itemX = x + index * (itemW + gap);
        const labelLayout = metricLabelTextLayout(metric.label, itemW, bodySize(ctx, 9.5));
        const valueLayout = metricValueTextLayout(metric.value, itemW, titleSize(ctx, 20), 0.56);
        addText(ctx, metric.value, {
            x: itemX,
            y,
            w: itemW,
            h: valueLayout.height,
            fontFace: ctx.art.typography.heading,
            fontSize: valueLayout.fontSize,
            bold: true,
            color: ctx.art.palette.text,
            align: 'center',
        });
        addText(ctx, metric.label, {
            x: itemX,
            y: y + valueLayout.height,
            w: itemW,
            h: labelLayout.height,
            fontSize: labelLayout.fontSize,
            color: ctx.art.palette.muted,
            align: 'center',
            valign: 'top',
        });
    });
}

function renderDesignedCover(ctx: RenderContext, plan: PresentationDeckPlan, slidePlan: PresentationSlidePlan): void {
    const language = visualLanguage(ctx);
    const title = slidePlan.title || plan.brief.title || slidePlan.message;
    const subtitle = slidePlan.body || plan.brief.subtitle;
    const pageCode = `01 / ${String(ctx.total).padStart(2, '0')}`;

    if (language === 'precision') {
        ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
            x: 8.64,
            y: 0.72,
            w: 3.96,
            h: 5.98,
            line: { color: ctx.art.palette.surface, transparency: 100 },
            fill: { color: ctx.art.palette.surface },
        });
        ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
            x: 8.34,
            y: 0.72,
            w: 0.12,
            h: 5.98,
            line: { color: ctx.art.palette.accent, transparency: 100 },
            fill: { color: ctx.art.palette.accent },
        });
        addText(ctx, pageCode, {
            x: marginX(ctx), y: 0.72, w: 2.2, h: 0.3,
            fontSize: 11, bold: true, charSpacing: 1.4, color: ctx.art.palette.accent,
        });
        const titleLayout = boundedTextLayout(title, 7.05, 2.72, titleSize(ctx, 54), 40);
        addBalancedText(ctx, titleLayout.lines > 1 ? balancedTitleText(title) : title, {
            x: marginX(ctx), y: 1.42, w: 7.05, h: 2.72,
            fontFace: ctx.art.typography.heading,
            fontSize: titleLayout.fontSize,
            bold: true, color: ctx.art.palette.text, valign: 'middle',
        });
        if (subtitle) {
            const subtitleLayout = boundedTextLayout(subtitle, 6.55, 1.18, bodySize(ctx, 20), 16);
            addBalancedText(ctx, subtitleLayout.lines === 2 ? balancedTitleText(subtitle) : subtitle, {
                x: marginX(ctx), y: 4.62, w: 6.55, h: 1.18,
                fontSize: subtitleLayout.fontSize, color: ctx.art.palette.muted, valign: 'top',
            });
        }
        addText(ctx, '01', {
            x: 9.02, y: 1.22, w: 3.08, h: 1.65,
            fontFace: ctx.art.typography.heading, fontSize: 92, bold: true,
            color: ctx.art.palette.accent, align: 'right',
        });
        ctx.slide.addShape(ctx.pptx.ShapeType.line, {
            x: 9.14, y: 3.34, w: 2.72, h: 0,
            line: { color: ctx.art.palette.accent2, width: 5.2 },
        });
        addText(ctx, plan.brief.desiredOutcome, {
            x: 9.14, y: 3.78, w: 2.72, h: 1.72,
            fontSize: bodySize(ctx, 15.5), color: ctx.art.palette.text, valign: 'top',
        });
        renderFocalMetricStrip(ctx, slidePlan, marginX(ctx), 6.18, 7.0);
        return;
    }

    if (language === 'editorial') {
        const accentText = textOn(ctx, ctx.art.palette.accent);
        ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
            x: 0.14, y: 0, w: 3.42, h: SLIDE_H,
            line: { color: ctx.art.palette.accent, transparency: 100 },
            fill: { color: ctx.art.palette.accent },
        });
        addText(ctx, '01', {
            x: 0.58, y: 0.78, w: 2.42, h: 1.62,
            fontFace: ctx.art.typography.heading, fontSize: 92, bold: true,
            color: accentText,
        });
        addText(ctx, pageCode, {
            x: 0.62, y: 6.54, w: 2.22, h: 0.28,
            fontSize: 10, bold: true, charSpacing: 1.4, color: accentText,
        });
        const titleLayout = boundedTextLayout(title, 8.45, 2.94, titleSize(ctx, 56), 40);
        addBalancedText(ctx, titleLayout.lines > 1 ? balancedTitleText(title) : title, {
            x: 4.05, y: 1.14, w: 8.45, h: 2.94,
            fontFace: ctx.art.typography.heading, fontSize: titleLayout.fontSize,
            bold: true, color: ctx.art.palette.text, valign: 'middle',
        });
        if (subtitle) {
            const subtitleLayout = boundedTextLayout(subtitle, 7.1, 1.4, bodySize(ctx, 20), 16);
            addBalancedText(ctx, subtitleLayout.lines === 2 ? balancedTitleText(subtitle) : subtitle, {
                x: 4.08, y: 4.48, w: 7.1, h: 1.4,
                fontSize: subtitleLayout.fontSize, color: ctx.art.palette.muted, valign: 'top',
            });
        }
        ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
            x: 11.68, y: 4.3, w: 0.68, h: 1.82,
            line: { color: ctx.art.palette.accent2, transparency: 100 },
            fill: { color: ctx.art.palette.accent2 },
        });
        renderFocalMetricStrip(ctx, slidePlan, 4.08, 6.12, 7.52);
        return;
    }

    const accentText = textOn(ctx, ctx.art.palette.accent);
    ctx.slide.addShape(ctx.pptx.ShapeType.ellipse, {
        x: 8.68, y: 0.72, w: 3.88, h: 3.88,
        line: { color: ctx.art.palette.accent, transparency: 100 },
        fill: { color: ctx.art.palette.accent },
    });
    ctx.slide.addShape(ctx.pptx.ShapeType.ellipse, {
        x: 10.22, y: 4.62, w: 2.22, h: 2.22,
        line: { color: ctx.art.palette.accent2, transparency: 100 },
        fill: { color: ctx.art.palette.accent2, transparency: 8 },
    });
    addText(ctx, '01', {
        x: 9.28, y: 1.62, w: 2.68, h: 1.46,
        fontFace: ctx.art.typography.heading, fontSize: 78, bold: true,
        color: accentText, align: 'center',
    });
    addText(ctx, pageCode, {
        x: marginX(ctx), y: 0.72, w: 2.28, h: 0.3,
        fontSize: 11, bold: true, charSpacing: 1.5, color: ctx.art.palette.accent,
    });
    const titleLayout = boundedTextLayout(title, 7.65, 2.85, titleSize(ctx, 58), 40);
    addBalancedText(ctx, titleLayout.lines > 1 ? balancedTitleText(title) : title, {
        x: marginX(ctx), y: 1.28, w: 7.65, h: 2.85,
        fontFace: ctx.art.typography.heading, fontSize: titleLayout.fontSize,
        bold: true, color: ctx.art.palette.text, valign: 'middle',
    });
    if (subtitle) {
        const subtitleLayout = boundedTextLayout(subtitle, 6.95, 1.22, bodySize(ctx, 20), 16);
        addBalancedText(ctx, subtitleLayout.lines === 2 ? balancedTitleText(subtitle) : subtitle, {
            x: marginX(ctx), y: 4.52, w: 6.95, h: 1.22,
            fontSize: subtitleLayout.fontSize, color: ctx.art.palette.muted, valign: 'top',
        });
    }
    ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
        x: marginX(ctx), y: 6.02, w: 3.18, h: 0.12,
        line: { color: ctx.art.palette.accent2, transparency: 100 },
        fill: { color: ctx.art.palette.accent2 },
    });
    renderFocalMetricStrip(ctx, slidePlan, marginX(ctx), 6.32, 7.62);
}

function renderCenteredFocal(ctx: RenderContext, plan: PresentationDeckPlan, slidePlan: PresentationSlidePlan): void {
    if (!slidePlan.imagePath) {
        renderDesignedCover(ctx, plan, slidePlan);
        return;
    }
    const imageFrame = resolvePresentationImageFrame(slidePlan, ctx.index);
    if (slidePlan.imagePath && imageFrame) {
        addImage(ctx, slidePlan.imagePath, slidePlan.imageAlt, imageFrame.x, imageFrame.y, imageFrame.w, imageFrame.h, slidePlan.imageMask);
    }
    const top = slidePlan.imagePath ? 3.25 : 1.58;
    addText(ctx, slidePlan.eyebrow || slidePlan.visualRole || '', {
        x: 3.2,
        y: top - 0.54,
        w: 6.95,
        h: 0.28,
        fontSize: bodySize(ctx, 11),
        bold: true,
        charSpacing: 1.5,
        color: ctx.art.palette.accent,
        align: 'center',
    });
    const coverTitle = slidePlan.title || plan.brief.title || slidePlan.message;
    // The centered cover owns almost the full slide width. Let PowerPoint keep
    // compact mixed CJK/Latin titles on one line here; forcing the same
    // two-line break used by narrow split covers can exceed this shallow box.
    addText(ctx, coverTitle, {
        x: 1.07,
        y: top,
        w: 11.2,
        h: 1.65,
        fontFace: ctx.art.typography.heading,
        fontSize: titleSize(ctx, 50 * slidePlan.layout.focalScale),
        bold: true,
        color: ctx.art.palette.text,
        align: 'center',
        valign: 'middle',
    });
    const subtitle = slidePlan.body || plan.brief.subtitle;
    const subtitleLayout = subtitle
        ? centeredCoverSubtitleLayout(subtitle)
        : { fontSize: 20, height: 0.82 };
    const subtitleRequestedSize = bodySize(ctx, subtitleLayout.fontSize);
    const subtitleFit = subtitle
        ? boundedTextLayout(subtitle, 7.3, 1.52, subtitleRequestedSize, 16)
        : undefined;
    const subtitleHeight = subtitleFit
        ? Math.max(subtitleLayout.height, Math.min(1.52, subtitleFit.height))
        : subtitleLayout.height;
    if (subtitle) addBalancedText(
        ctx,
        subtitleFit && subtitleFit.lines > 1 ? balancedCjkBodyText(subtitle, 36) : subtitle,
        {
            x: 3.02,
            y: top + 1.92,
            w: 7.3,
            h: subtitleHeight,
            fontSize: subtitleFit?.fontSize || subtitleRequestedSize,
            color: ctx.art.palette.muted,
            align: 'center',
            valign: 'top',
        },
    );
    const dividerY = Math.min(6.68, top + 1.92 + subtitleHeight + 0.28);
    ctx.slide.addShape(ctx.pptx.ShapeType.line, {
        x: 5.62,
        y: dividerY,
        w: 2.08,
        h: 0,
        line: { color: ctx.art.palette.accent2, width: 4.5 },
    });
    renderFocalMetricStrip(
        ctx,
        slidePlan,
        2.18,
        slidePlan.imagePath ? 6.46 : Math.max(5.28, dividerY + 0.28),
        8.97,
    );
}

function renderFullBleedFocal(ctx: RenderContext, plan: PresentationDeckPlan, slidePlan: PresentationSlidePlan): void {
    if (!slidePlan.imagePath) {
        renderCenteredFocal(ctx, plan, slidePlan);
        return;
    }
    const imageFrame = resolvePresentationImageFrame(slidePlan, ctx.index)!;
    addImage(ctx, slidePlan.imagePath, slidePlan.imageAlt, imageFrame.x, imageFrame.y, imageFrame.w, imageFrame.h, slidePlan.imageMask);
    ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
        x: 0,
        y: 0,
        w: 7.65,
        h: SLIDE_H,
        line: { color: ctx.art.palette.background, transparency: 100 },
        fill: { color: ctx.art.palette.background, transparency: 18 },
    });
    addText(ctx, slidePlan.eyebrow || slidePlan.visualRole || '', {
        x: marginX(ctx),
        y: 0.76,
        w: 5.75,
        h: 0.32,
        fontSize: bodySize(ctx, 11),
        bold: true,
        charSpacing: 1.4,
        color: ctx.art.palette.accent,
    });
    const coverTitle = slidePlan.title || plan.brief.title || slidePlan.message;
    addBalancedText(ctx, balancedTitleText(coverTitle), {
        x: marginX(ctx),
        y: 1.48,
        w: 6.18,
        h: 2.42,
        fontFace: ctx.art.typography.heading,
        fontSize: titleSize(ctx, 52 * slidePlan.layout.focalScale),
        bold: true,
        color: ctx.art.palette.text,
        valign: 'middle',
    });
    const subtitle = slidePlan.body || plan.brief.subtitle;
    if (subtitle) {
        const wrappedSubtitle = balancedCjkBodyText(subtitle, 34);
        const subtitleLayout = boundedTextLayout(wrappedSubtitle, 5.62, 1.28, bodySize(ctx, 20), 16);
        addBalancedText(ctx, wrappedSubtitle, {
            x: marginX(ctx),
            y: 4.18,
            w: 5.62,
            h: 1.28,
            fontSize: subtitleLayout.fontSize,
            color: ctx.art.palette.muted,
            valign: 'top',
        });
    }
    renderFocalMetricStrip(ctx, slidePlan, marginX(ctx), 5.78, 5.72);
}

function renderFocal(ctx: RenderContext, plan: PresentationDeckPlan, slidePlan: PresentationSlidePlan): void {
    if (slidePlan.resolvedLayout.silhouette === 'cover-centered') {
        renderCenteredFocal(ctx, plan, slidePlan);
        return;
    }
    if (slidePlan.resolvedLayout.silhouette === 'cover-full-bleed') {
        renderFullBleedFocal(ctx, plan, slidePlan);
        return;
    }
    const { palette } = ctx.art;
    if (slidePlan.imagePath) {
        const imageFrame = resolvePresentationImageFrame(slidePlan, ctx.index)!;
        addImage(ctx, slidePlan.imagePath, slidePlan.imageAlt, imageFrame.x, imageFrame.y, imageFrame.w, imageFrame.h, slidePlan.imageMask);
        ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
            x: 7.45,
            y: 0,
            w: 1.15,
            h: SLIDE_H,
            rotate: 0,
            line: { color: palette.background, transparency: 100 },
            fill: { color: palette.background },
        });
    } else {
        ctx.slide.addShape(ctx.pptx.ShapeType.arc, {
            x: 8.95,
            y: -1.45,
            w: 5.1,
            h: 5.1,
            rotate: 18,
            line: { color: palette.accent, transparency: 100 },
            fill: { color: palette.accent, transparency: 12 },
        });
        ctx.slide.addShape(ctx.pptx.ShapeType.ellipse, {
            x: 10.2,
            y: 4.72,
            w: 2.25,
            h: 2.25,
            line: { color: palette.accent2, transparency: 100 },
            fill: { color: palette.accent2, transparency: 10 },
        });
    }

    if (slidePlan.eyebrow) {
        addText(ctx, slidePlan.eyebrow, {
            x: marginX(ctx),
            y: 0.72,
            w: 6.5,
            h: 0.3,
            fontSize: bodySize(ctx, 12),
            bold: true,
            charSpacing: 1.4,
            color: palette.accent,
        });
    }
    const coverTitle = slidePlan.title || plan.brief.title || slidePlan.message;
    addBalancedText(ctx, balancedTitleText(coverTitle), {
        x: marginX(ctx),
        y: 1.45,
        w: slidePlan.imagePath ? 6.45 : 8.4,
        h: 2.18,
        fontFace: ctx.art.typography.heading,
        fontSize: titleSize(ctx, 54 * slidePlan.layout.focalScale),
        bold: true,
        color: palette.text,
        valign: 'middle',
        breakLine: false,
    });
    const subtitle = slidePlan.body || plan.brief.subtitle;
    if (subtitle) {
        const subtitleWidth = slidePlan.imagePath ? 5.95 : 7.15;
        const wrappedSubtitle = balancedCjkBodyText(subtitle, 34);
        const subtitleLayout = boundedTextLayout(wrappedSubtitle, subtitleWidth, 1.28, bodySize(ctx, 21), 16);
        addBalancedText(ctx, wrappedSubtitle, {
            x: marginX(ctx),
            y: 4.12,
            w: subtitleWidth,
            h: 1.28,
            fontSize: subtitleLayout.fontSize,
            color: palette.muted,
            valign: 'top',
        });
    }
    renderFocalMetricStrip(ctx, slidePlan, marginX(ctx), 5.68, slidePlan.imagePath ? 5.95 : 7.85);
}

function renderNarrativeEditorial(ctx: RenderContext, slidePlan: PresentationSlidePlan): void {
    addEyebrow(ctx, slidePlan.eyebrow || slidePlan.visualRole);
    const title = slidePlan.title || slidePlan.message;
    const titleLayout = boundedTextLayout(
        title,
        7.05,
        3.6,
        titleSize(ctx, 48 * slidePlan.layout.focalScale),
        35,
    );
    addText(ctx, slidePlan.title || slidePlan.message, {
        x: marginX(ctx),
        y: 1.2,
        w: 7.05,
        h: 3.6,
        fontFace: ctx.art.typography.heading,
        fontSize: titleLayout.fontSize,
        bold: true,
        color: ctx.art.palette.text,
        valign: 'middle',
        align: slidePlan.layout.alignment,
    });
    ctx.slide.addShape(ctx.pptx.ShapeType.line, {
        x: 8.34,
        y: 1.12,
        w: 0,
        h: 4.9,
        line: { color: ctx.art.palette.accent, width: 2.2, transparency: 22 },
    });
    addBody(ctx, slidePlan.body, 8.76, 1.28, 3.7, 4.42);
    addBulletList(ctx, slidePlan.bullets, 8.76, slidePlan.body ? 3.98 : 1.4, 3.7, 2.05, bodySize(ctx, 16));
    if (!slidePlan.body && !slidePlan.bullets.length && slidePlan.items.length) {
        renderFlatItems(ctx, slidePlan.items, 8.62, 1.12, 3.84, 4.95);
    }
    addFooter(ctx);
}

function renderNarrativeBanded(ctx: RenderContext, slidePlan: PresentationSlidePlan): void {
    ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
        x: 0.14,
        y: 0,
        w: 4.2,
        h: SLIDE_H,
        line: { color: ctx.art.palette.accent, transparency: 100 },
        fill: { color: ctx.art.palette.accent, transparency: 5 },
    });
    addText(ctx, slidePlan.eyebrow || slidePlan.visualRole || '', {
        x: 0.72,
        y: 0.72,
        w: 2.95,
        h: 0.3,
        fontSize: bodySize(ctx, 11),
        bold: true,
        color: ctx.art.palette.surface,
        charSpacing: 1.2,
    });
    const title = slidePlan.title || slidePlan.message;
    const titleLayout = boundedTextLayout(
        title,
        2.98,
        3.4,
        titleSize(ctx, 36 * slidePlan.layout.focalScale),
        22,
    );
    addText(ctx, title, {
        x: 0.72,
        y: 1.42,
        w: 2.98,
        h: 3.4,
        fontFace: ctx.art.typography.heading,
        fontSize: titleLayout.fontSize,
        bold: true,
        color: ctx.art.palette.surface,
        valign: 'middle',
    });
    addBody(ctx, slidePlan.body, 5.02, 1.26, 6.72, 1.55);
    if (slidePlan.bullets.length) addBulletList(ctx, slidePlan.bullets, 5.02, slidePlan.body ? 3.15 : 1.38, 6.65, 3.02, bodySize(ctx, 19));
    else if (slidePlan.items.length) renderFlatItems(ctx, slidePlan.items, 4.85, 2.42, 7.6, 3.42);
    addFooter(ctx);
}

function renderNarrative(ctx: RenderContext, slidePlan: PresentationSlidePlan): void {
    if (slidePlan.resolvedLayout.silhouette === 'editorial-aside') {
        renderNarrativeEditorial(ctx, slidePlan);
        return;
    }
    if (slidePlan.resolvedLayout.silhouette === 'editorial-banded') {
        renderNarrativeBanded(ctx, slidePlan);
        return;
    }
    addSlideTitle(ctx, slidePlan);
    const hasBullets = slidePlan.bullets.length > 0;
    addBody(ctx, slidePlan.body, marginX(ctx), 2.12, hasBullets ? 4.25 : 7.2, 3.65);
    if (hasBullets) {
        ctx.slide.addShape(ctx.pptx.ShapeType.line, {
            x: 5.43,
            y: 2.12,
            w: 0,
            h: 3.7,
            line: { color: ctx.art.palette.accent, transparency: 34, width: 1.6 },
        });
        addBulletList(ctx, slidePlan.bullets, 5.86, 2.12, 6.05, 3.9, 20);
    } else if (slidePlan.items.length) {
        renderFlatItems(ctx, slidePlan.items, marginX(ctx), 2.25, 11.45, 3.55);
    } else {
        ctx.slide.addShape(ctx.pptx.ShapeType.line, {
            x: marginX(ctx),
            y: 5.95,
            w: 3.45,
            h: 0,
            line: { color: ctx.art.palette.accent, width: 4 },
        });
    }
    addFooter(ctx);
}

function renderSplit(ctx: RenderContext, slidePlan: PresentationSlidePlan): void {
    if (!slidePlan.imagePath) {
        renderNarrative(ctx, slidePlan);
        return;
    }
    const imageFrame = resolvePresentationImageFrame(slidePlan, ctx.index)!;
    const imageOnLeft = imageFrame.x < SLIDE_W / 2;
    const textX = imageOnLeft ? 7.08 : marginX(ctx);
    addImage(ctx, slidePlan.imagePath, slidePlan.imageAlt, imageFrame.x, imageFrame.y, imageFrame.w, imageFrame.h, slidePlan.imageMask);
    ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
        x: imageOnLeft ? 5.92 : 7.06,
        y: 0,
        w: 0.26,
        h: SLIDE_H,
        line: { color: ctx.art.palette.accent, transparency: 100 },
        fill: { color: ctx.art.palette.accent },
    });
    if (slidePlan.eyebrow) {
        addText(ctx, slidePlan.eyebrow, {
            x: textX,
            y: 0.82,
            w: 5.1,
            h: 0.35,
            fontSize: bodySize(ctx, 11),
            bold: true,
            charSpacing: 1.4,
            color: ctx.art.palette.accent,
        });
    }
    const hasSupportingCopy = Boolean(slidePlan.body || slidePlan.bullets.length);
    const splitTitle = slidePlan.title || slidePlan.message;
    const splitTitleHeight = hasSupportingCopy ? 1.48 : 2.18;
    const splitTitleLayout = boundedTextLayout(
        splitTitle,
        5.23,
        splitTitleHeight,
        titleSize(ctx, (hasSupportingCopy ? 38 : 35) * slidePlan.layout.focalScale),
        titleSize(ctx, 27),
    );
    addText(ctx, splitTitleLayout.lines > 1 ? balancedTitleText(splitTitle) : splitTitle, {
        x: textX,
        y: 1.42,
        w: 5.23,
        h: splitTitleHeight,
        fontFace: ctx.art.typography.heading,
        fontSize: splitTitleLayout.fontSize,
        bold: true,
        color: ctx.art.palette.text,
        valign: 'top',
    });
    addBody(ctx, slidePlan.body, textX, 3.18, 4.95, 1.18);
    addBulletList(ctx, slidePlan.bullets, textX, slidePlan.body ? 4.52 : 3.38, 4.92, 1.75, bodySize(ctx, 18));
    addText(ctx, String(ctx.index + 1).padStart(2, '0'), {
        x: textX,
        y: 6.78,
        w: 0.55,
        h: 0.22,
        fontSize: 9,
        color: ctx.art.palette.muted,
    });
}

function renderImageWindow(ctx: RenderContext, slidePlan: PresentationSlidePlan): void {
    if (!slidePlan.imagePath) {
        renderNarrative(ctx, slidePlan);
        return;
    }
    const frame = resolvePresentationImageFrame(slidePlan, ctx.index)!;
    const imageOnLeft = frame.x < SLIDE_W / 2;
    const textX = imageOnLeft ? 6.72 : marginX(ctx);
    const textW = imageOnLeft ? 5.65 : 5.72;
    if (ctx.art.imageTreatment !== 'framed'
        && !['circle', 'arch', 'soft-edge'].includes(slidePlan.imageMask)) {
        ctx.slide.addShape(ctx.pptx.ShapeType.roundRect, {
            x: frame.x - 0.08,
            y: frame.y - 0.08,
            w: frame.w + 0.16,
            h: frame.h + 0.16,
            rectRadius: cardRadius(ctx),
            line: { color: ctx.art.palette.accent, transparency: 58, width: 1 },
            fill: { color: ctx.art.palette.surface },
        } as any);
    }
    addImage(ctx, slidePlan.imagePath, slidePlan.imageAlt, frame.x, frame.y, frame.w, frame.h, slidePlan.imageMask);
    addText(ctx, slidePlan.eyebrow || slidePlan.visualRole || '', {
        x: textX,
        y: 1.05,
        w: textW,
        h: 0.3,
        fontSize: bodySize(ctx, 11),
        bold: true,
        charSpacing: 1.25,
        color: ctx.art.palette.accent,
    });
    const windowTitle = slidePlan.title || slidePlan.message;
    const windowTitleLayout = boundedTextLayout(
        windowTitle,
        textW,
        1.72,
        titleSize(ctx, 38 * slidePlan.layout.focalScale),
        titleSize(ctx, 27),
    );
    addText(ctx, windowTitleLayout.lines > 1 ? balancedTitleText(windowTitle) : windowTitle, {
        x: textX,
        y: 1.68,
        w: textW,
        h: 1.72,
        fontFace: ctx.art.typography.heading,
        fontSize: windowTitleLayout.fontSize,
        bold: true,
        color: ctx.art.palette.text,
        valign: 'middle',
    });
    addBody(ctx, slidePlan.body, textX, 3.68, textW, 1.12);
    addBulletList(ctx, slidePlan.bullets, textX, slidePlan.body ? 5.0 : 3.88, textW, 1.36, bodySize(ctx, 17));
    addFooter(ctx);
}

function renderImagePanorama(ctx: RenderContext, slidePlan: PresentationSlidePlan): void {
    if (!slidePlan.imagePath) {
        renderNarrative(ctx, slidePlan);
        return;
    }
    const frame = resolvePresentationImageFrame(slidePlan, ctx.index)!;
    addImage(ctx, slidePlan.imagePath, slidePlan.imageAlt, frame.x, frame.y, frame.w, frame.h, slidePlan.imageMask);
    ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
        x: 0.14,
        y: 3.48,
        w: 4.15,
        h: 0.24,
        line: { color: ctx.art.palette.accent, transparency: 100 },
        fill: { color: ctx.art.palette.accent },
    });
    addEyebrow(ctx, slidePlan.eyebrow || slidePlan.visualRole);
    addText(ctx, slidePlan.title || slidePlan.message, {
        x: marginX(ctx),
        y: 1.05,
        w: 7.22,
        h: 1.8,
        fontFace: ctx.art.typography.heading,
        fontSize: titleSize(ctx, 42 * slidePlan.layout.focalScale),
        bold: true,
        color: ctx.art.palette.text,
        valign: 'middle',
    });
    addBody(ctx, slidePlan.body, 8.28, 1.18, 4.1, 1.5);
}

function renderSectionDivider(ctx: RenderContext, slidePlan: PresentationSlidePlan): void {
    const chapter = String(ctx.index + 1).padStart(2, '0');
    ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
        x: 0.14,
        y: 0,
        w: 2.5,
        h: SLIDE_H,
        line: { color: ctx.art.palette.accent, transparency: 100 },
        fill: { color: ctx.art.palette.accent },
    });
    addText(ctx, chapter, {
        x: 0.62,
        y: 0.72,
        w: 1.48,
        h: 0.55,
        fontFace: ctx.art.typography.heading,
        fontSize: titleSize(ctx, 24),
        bold: true,
        color: ctx.art.palette.surface,
    });
    addText(ctx, slidePlan.eyebrow || slidePlan.visualRole || 'CHAPTER', {
        x: 3.35,
        y: 1.22,
        w: 6.6,
        h: 0.32,
        fontSize: bodySize(ctx, 11),
        bold: true,
        charSpacing: 1.5,
        color: ctx.art.palette.accent,
    });
    addText(ctx, slidePlan.title || slidePlan.message, {
        x: 3.35,
        y: 2.02,
        w: 8.85,
        h: 2.25,
        fontFace: ctx.art.typography.heading,
        fontSize: titleSize(ctx, 50 * slidePlan.layout.focalScale),
        bold: true,
        color: ctx.art.palette.text,
        valign: 'middle',
    });
    addBody(ctx, slidePlan.body, 3.42, 4.82, 6.95, 0.95);
    ctx.slide.addShape(ctx.pptx.ShapeType.line, {
        x: 3.35,
        y: 6.12,
        w: 2.62,
        h: 0,
        line: { color: ctx.art.palette.accent2, width: 4.5 },
    });
    addFooter(ctx);
}

export interface StackedSequenceGeometry {
    startY: number;
    endY: number;
    rowHeight: number;
}

/** Resolve real vertical space for a stacked process. `whitespace` used to be
 * metadata only, which made a layout-only sample repair a no-op. Keep the
 * footer and optional insight strip protected while giving four-stage ledgers
 * enough height for 16pt, two-line factual descriptions. */
export function stackedSequenceGeometry(
    stepCount: number,
    whitespace: 'compact' | 'balanced' | 'generous',
    hasBottomInsight: boolean,
    ledgerMode: boolean,
): StackedSequenceGeometry {
    const count = Math.max(1, stepCount);
    const startY = ledgerMode
        ? whitespace === 'compact' ? 2.38 : whitespace === 'generous' ? 2.48 : 2.42
        : whitespace === 'compact' ? 2.28 : whitespace === 'generous' ? 2.4 : 2.34;
    const endY = hasBottomInsight
        ? 5.72
        : whitespace === 'compact' ? 6.78 : whitespace === 'generous' ? 6.64 : 6.72;
    const maximumRowHeight = ledgerMode
        ? whitespace === 'compact' ? 1.1 : whitespace === 'generous' ? 1.04 : 1.075
        : whitespace === 'compact' ? 1.12 : whitespace === 'generous' ? 1.02 : 1.08;
    return {
        startY,
        endY,
        rowHeight: Math.min(maximumRowHeight, Math.max(0.62, (endY - startY) / count)),
    };
}

function renderStackedSequence(ctx: RenderContext, slidePlan: PresentationSlidePlan): void {
    const hasNarrativeRail = Boolean(slidePlan.body || slidePlan.bullets.length);
    addSlideTitle(ctx, slidePlan, hasNarrativeRail ? 6.15 : 11.7);
    const steps = (slidePlan.steps.length
        ? slidePlan.steps
        : slidePlan.items.map(item => ({ title: item.title, description: item.description })));
    if (!steps.length) {
        renderNarrative(ctx, slidePlan);
        return;
    }
    // Four explanatory stages read better as a flat ledger: stage names stay
    // on the left and immutable factual descriptions receive a wide field on
    // the right. This is intentionally not a card grid.
    const longestDescription = Math.max(
        0,
        ...steps.map(step => visualTextUnits(step.description || '')),
    );
    const ledgerMode = !hasNarrativeRail
        && steps.some(step => Boolean(step.description))
        && (steps.length >= 4 || (steps.length >= 3 && longestDescription > 52));
    const geometry = stackedSequenceGeometry(
        steps.length,
        slidePlan.layout.whitespace,
        slidePlan.bullets.length > 0,
        ledgerMode,
    );
    const startY = geometry.startY;
    const rowH = geometry.rowHeight;
    const railX = hasNarrativeRail ? 7.2 : marginX(ctx);
    const textX = railX + 0.72;
    // Keep the editorial signature column genuinely empty. A full-canvas text
    // box may look harmless because the glyphs sit on the left, but it still
    // collides with the signature/page marker in PowerPoint geometry QA.
    const textW = hasNarrativeRail ? 4.25 : 9.38;
    steps.forEach((step, index) => {
        const y = startY + index * rowH;
        ctx.slide.addShape(ctx.pptx.ShapeType.ellipse, {
            x: railX,
            y: y + 0.06,
            w: 0.42,
            h: 0.42,
            line: { color: ctx.art.palette.accent, width: 1.2 },
            fill: { color: index === 0 ? ctx.art.palette.accent : ctx.art.palette.background },
        });
        if (index < steps.length - 1) ctx.slide.addShape(ctx.pptx.ShapeType.line, {
            x: railX + 0.21,
            y: y + 0.48,
            w: 0,
            h: rowH - 0.06,
            line: { color: ctx.art.palette.accent, transparency: 45, width: 1.5 },
        });
        if (ledgerMode && index < steps.length - 1) ctx.slide.addShape(ctx.pptx.ShapeType.line, {
            x: textX,
            y: y + rowH - 0.02,
            w: textW,
            h: 0,
            line: { color: ctx.art.palette.muted, transparency: 82, width: 0.7 },
        });
        if (ledgerMode) {
            const titleWidth = Math.min(2.55, textW * 0.29);
            const gutter = 0.34;
            const descriptionX = textX + titleWidth + gutter;
            const descriptionWidth = textW - titleWidth - gutter;
            const contentHeight = Math.max(0.42, rowH - 0.12);
            const titleLayout = boundedTextLayout(
                step.title,
                titleWidth,
                contentHeight,
                titleSize(ctx, 18),
                16,
            );
            addBalancedText(
                ctx,
                titleLayout.lines > 1 ? balancedTitleText(step.title) : step.title,
                {
                    x: textX,
                    y: y + 0.03,
                    w: titleWidth,
                    h: contentHeight,
                    fontSize: titleLayout.fontSize,
                    bold: true,
                    color: ctx.art.palette.text,
                    valign: 'middle',
                },
            );
            if (step.description) {
                const descriptionLayout = boundedTextLayout(
                    step.description,
                    descriptionWidth,
                    contentHeight,
                    bodySize(ctx, 16),
                    16,
                );
                const description = descriptionLayout.lines > 1
                    ? balancedCjkBodyTextInLines(step.description, descriptionLayout.lines)
                    : step.description;
                addBalancedText(ctx, description, {
                    x: descriptionX,
                    y: y + 0.03,
                    w: descriptionWidth,
                    h: contentHeight,
                    fontSize: descriptionLayout.fontSize,
                    color: ctx.art.palette.muted,
                    valign: 'middle',
                });
            }
            return;
        }
        addText(ctx, step.title, {
            x: textX,
            y,
            w: textW,
            h: 0.42,
            fontSize: titleSize(ctx, 18),
            bold: true,
            color: ctx.art.palette.text,
        });
        if (step.description) {
            const descriptionHeight = Math.max(0.28, rowH - 0.43);
            const descriptionLayout = boundedTextLayout(
                step.description,
                textW,
                descriptionHeight,
                bodySize(ctx, 16),
                16,
            );
            addBalancedText(ctx, descriptionLayout.lines > 1
                ? balancedCjkBodyTextInLines(step.description, descriptionLayout.lines)
                : step.description, {
                x: textX,
                y: y + 0.39,
                w: textW,
                h: descriptionHeight,
                fontSize: descriptionLayout.fontSize,
                color: ctx.art.palette.muted,
                valign: 'top',
            });
        }
    });
    addBody(ctx, slidePlan.body, marginX(ctx), 3.04, 5.55, 2.22);
    addInsightStrip(ctx, slidePlan.bullets, 5.84, 0.78);
    addFooter(ctx);
}

function renderSequence(ctx: RenderContext, slidePlan: PresentationSlidePlan): void {
    if (slidePlan.resolvedLayout.silhouette === 'process-stacked') {
        renderStackedSequence(ctx, slidePlan);
        return;
    }
    addSlideTitle(ctx, slidePlan, slidePlan.body ? 7.15 : 11.7);
    if (slidePlan.body) {
        addText(ctx, slidePlan.body, {
            x: 8.45,
            y: 0.72,
            w: 3.72,
            h: 1.05,
            fontSize: bodySize(ctx, 14),
            color: ctx.art.palette.muted,
            valign: 'top',
            lineSpacingMultiple: 1.02,
        });
    }
    const steps = slidePlan.steps.length
        ? slidePlan.steps
        : slidePlan.items.map(item => ({ title: item.title, description: item.description }));
    if (steps.length === 0) {
        renderNarrative(ctx, slidePlan);
        return;
    }
    const startX = 1.02;
    const endX = 12.1;
    const y = 3.06;
    const language = visualLanguage(ctx);
    const gap = steps.length === 1 ? 0 : (endX - startX) / (steps.length - 1);
    const textGeometry = horizontalSequenceTextGeometry(steps.length, gap, slidePlan.bullets.length > 0);
    if (steps.length > 1) {
        ctx.slide.addShape(ctx.pptx.ShapeType.line, {
            x: startX,
            y,
            w: endX - startX,
            h: 0,
            line: { color: ctx.art.palette.accent, transparency: 44, width: 2.3 },
        });
    }
    steps.forEach((step, index) => {
        const center = startX + gap * index;
        const labelWidth = textGeometry.labelWidth;
        const labelX = Math.max(0.34, Math.min(SLIDE_W - labelWidth - 0.34, center - labelWidth / 2));
        ctx.slide.addShape(ctx.pptx.ShapeType.ellipse, {
            x: center - 0.19,
            y: y - 0.19,
            w: 0.38,
            h: 0.38,
            line: { color: index % 2 ? ctx.art.palette.accent2 : ctx.art.palette.accent, width: language === 'kinetic' ? 0 : 1.2 },
            fill: {
                color: language === 'kinetic'
                    ? index % 2 ? ctx.art.palette.accent2 : ctx.art.palette.accent
                    : index === 0 ? ctx.art.palette.accent : ctx.art.palette.background,
            },
        });
        addText(ctx, String(index + 1).padStart(2, '0'), {
            x: center - 0.33,
            y: language === 'kinetic' ? 2.03 : 2.3,
            w: 0.66,
            h: language === 'kinetic' ? 0.52 : 0.25,
            fontFace: ctx.art.typography.heading,
            fontSize: bodySize(ctx, language === 'kinetic' ? 26 : 10),
            bold: true,
            color: language === 'kinetic'
                ? index % 2 ? ctx.art.palette.accent2 : ctx.art.palette.accent
                : ctx.art.palette.accent,
            align: 'center',
        });
        if (language === 'kinetic') ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
            x: labelX,
            y: Math.max(6.03, 4.76 + textGeometry.descriptionHeight + 0.12),
            w: labelWidth,
            h: 0.12,
            line: { color: index % 2 ? ctx.art.palette.accent2 : ctx.art.palette.accent, transparency: 100 },
            fill: { color: index % 2 ? ctx.art.palette.accent2 : ctx.art.palette.accent },
        });
        const stepTitleLayout = boundedTextLayout(
            step.title,
            labelWidth,
            1.15,
            titleSize(ctx, 18),
            14,
        );
        addBalancedText(
            ctx,
            stepTitleLayout.lines === 2 ? balancedTitleText(step.title) : step.title,
            {
            x: labelX,
            y: 3.52,
            w: labelWidth,
            h: 1.15,
            fontSize: stepTitleLayout.fontSize,
            bold: true,
            color: ctx.art.palette.text,
            align: 'center',
            valign: 'top',
            },
        );
        if (step.description) {
            const descriptionHeight = textGeometry.descriptionHeight;
            const descriptionLayout = boundedTextLayout(
                step.description,
                labelWidth,
                descriptionHeight,
                bodySize(ctx, 16),
                16,
            );
            addBalancedText(
                ctx,
                descriptionLayout.lines > 1
                    ? balancedCjkBodyTextInLines(step.description, descriptionLayout.lines)
                    : step.description,
                {
                    x: labelX,
                    y: 4.76,
                    w: labelWidth,
                    h: descriptionHeight,
                    fontSize: descriptionLayout.fontSize,
                    color: ctx.art.palette.muted,
                    align: 'center',
                    valign: 'top',
                },
            );
        }
    });
    addInsightStrip(ctx, slidePlan.bullets, 5.84, 0.78);
    addFooter(ctx);
}

export interface HorizontalSequenceTextGeometry {
    labelWidth: number;
    descriptionHeight: number;
}

/** Three-stage timelines have enough horizontal room for real reading fields.
 * The previous 2.1in cap discarded more than half the canvas and forced the
 * final stage below the 16pt body floor. */
export function horizontalSequenceTextGeometry(
    stepCount: number,
    gap: number,
    hasBottomInsight: boolean,
): HorizontalSequenceTextGeometry {
    const count = Math.max(1, stepCount);
    const labelWidth = count === 1
        ? 4.8
        : count <= 3
            ? Math.min(3.6, Math.max(2.8, gap - 0.8))
            : Math.min(2.1, Math.max(1.35, gap - 0.16));
    return {
        labelWidth,
        // PowerPoint's mixed CJK/Latin fallback reports a taller BoundHeight
        // than the JavaScript estimator. Three 16pt lines need about 1.4in in
        // Office even though the visible glyphs appear to fit in 1.15in.
        descriptionHeight: hasBottomInsight ? 0.72 : count <= 3 ? 1.42 : 1.05,
    };
}

function renderFlatItems(
    ctx: RenderContext,
    items: PresentationItem[],
    x: number,
    y: number,
    w: number,
    h: number,
): void {
    const count = items.length;
    const colW = w / count;
    const language = visualLanguage(ctx);
    items.forEach((item, index) => {
        const colX = x + index * colW;
        const itemTitleSize = Array.from(item.title).length > 18 ? 21 : 23;
        if (index > 0 && language !== 'kinetic') {
            ctx.slide.addShape(ctx.pptx.ShapeType.line, {
                x: colX,
                y,
                w: 0,
                h,
                line: { color: ctx.art.palette.muted, transparency: 75, width: 0.8 },
            });
        }
        if (language === 'kinetic') ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
            x: colX + 0.18,
            y,
            w: colW - 0.36,
            h: 0.12,
            line: { color: index % 2 ? ctx.art.palette.accent2 : ctx.art.palette.accent, transparency: 100 },
            fill: { color: index % 2 ? ctx.art.palette.accent2 : ctx.art.palette.accent },
        });
        addText(ctx, String(index + 1).padStart(2, '0'), {
            x: colX + 0.24,
            y: language === 'kinetic' ? y + 0.24 : y,
            w: colW - 0.45,
            h: language === 'kinetic' ? 0.58 : 0.28,
            fontFace: ctx.art.typography.heading,
            fontSize: bodySize(ctx, language === 'kinetic' ? 28 : 10),
            bold: true,
            color: index % 2 ? ctx.art.palette.accent2 : ctx.art.palette.accent,
        });
        addText(ctx, item.title, {
            x: colX + 0.24,
            y: y + (language === 'kinetic' ? 1.02 : 0.54),
            w: colW - 0.48,
            h: 1.0,
            fontFace: ctx.art.typography.heading,
            fontSize: titleSize(ctx, itemTitleSize),
            bold: true,
            color: ctx.art.palette.text,
            valign: 'top',
        });
        if (item.description) {
            const descriptionWidth = colW - 0.48;
            const descriptionFontSize = bodySize(ctx, 16);
            const wrappedDescription = balancedCjkBodyText(
                item.description,
                descriptionWidth * 72 * 1.65 / Math.max(1, descriptionFontSize),
            );
            addBalancedText(ctx, wrappedDescription, {
                x: colX + 0.24,
                y: y + (language === 'kinetic' ? 2.05 : 1.58),
                w: descriptionWidth,
                h: h - (language === 'kinetic' ? 2.18 : 1.7),
                fontSize: descriptionFontSize,
                color: ctx.art.palette.muted,
                valign: 'top',
            });
        }
    });
}

function renderCardItems(ctx: RenderContext, items: PresentationItem[]): void {
    const visible = items;
    const cols = visible.length <= 2 ? visible.length : 2;
    const rows = Math.ceil(visible.length / cols);
    const gap = ctx.art.grid.gutter;
    // Editorial pages reserve the bottom-right signature column. Keeping the
    // full-width collection geometry makes the final row's text box intersect
    // the decorative page number even when the visible glyphs do not touch.
    const availableW = visualLanguage(ctx) === 'editorial' ? 10.72 : 11.75;
    const cardW = (availableW - gap * (cols - 1)) / cols;
    const cardH = (4.25 - gap * (rows - 1)) / rows;
    visible.forEach((item, index) => {
        const col = index % cols;
        const row = Math.floor(index / cols);
        const x = marginX(ctx) + col * (cardW + gap);
        const y = 2.08 + row * (cardH + gap);
        ctx.slide.addShape(ctx.pptx.ShapeType.roundRect, {
            x,
            y,
            w: cardW,
            h: cardH,
            rectRadius: cardRadius(ctx),
            line: { color: ctx.art.palette.muted, transparency: 76, width: 0.8 },
            fill: { color: ctx.art.palette.surface, transparency: 3 },
            shadow: { type: 'outer', color: '000000', opacity: 0.1, blur: 1.5, angle: 45, distance: 0.6 },
        } as any);
        addText(ctx, String(index + 1).padStart(2, '0'), {
            x: x + 0.34,
            y: y + 0.26,
            w: 0.52,
            h: 0.24,
            fontSize: bodySize(ctx, 9),
            bold: true,
            color: ctx.art.palette.accent,
        });
        addText(ctx, item.title, {
            x: x + 0.34,
            y: y + 0.67,
            w: cardW - 0.68,
            h: 0.62,
            fontFace: ctx.art.typography.heading,
            fontSize: titleSize(ctx, 21),
            bold: true,
            color: ctx.art.palette.text,
            valign: 'top',
        });
        if (item.description) addText(ctx, item.description, {
            x: x + 0.34,
            y: y + 1.38,
            w: cardW - 0.68,
            h: Math.max(0.42, cardH - 1.66),
            fontSize: bodySize(ctx, 16),
            color: ctx.art.palette.muted,
            valign: 'top',
        });
    });
}

function renderCollectionMosaic(ctx: RenderContext, items: PresentationItem[]): void {
    const visible = items;
    const primary = visible[0];
    if (!primary) return;
    const primaryText = textOn(ctx, ctx.art.palette.accent);
    ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
        x: marginX(ctx),
        y: 2.08,
        w: 5.25,
        h: 4.12,
        line: { color: ctx.art.palette.accent, transparency: 100 },
        fill: { color: ctx.art.palette.accent, transparency: 4 },
    });
    addText(ctx, '01', {
        x: 1.02,
        y: 2.38,
        w: 0.72,
        h: 0.28,
        fontSize: bodySize(ctx, 10),
        bold: true,
        color: primaryText,
    });
    addText(ctx, primary.title, {
        x: 1.02,
        y: 3.02,
        w: 4.45,
        h: 1.18,
        fontFace: ctx.art.typography.heading,
        fontSize: titleSize(ctx, 31),
        bold: true,
        color: primaryText,
        valign: 'middle',
    });
    if (primary.description) addText(ctx, primary.description, {
        x: 1.02,
        y: 4.62,
        w: 4.3,
        h: 0.92,
        fontSize: bodySize(ctx, 16),
        color: primaryText,
        transparency: 8,
        valign: 'top',
    } as any);
    const supporting = visible.slice(1);
    const rowH = supporting.length ? 4.12 / supporting.length : 4.12;
    supporting.forEach((item, index) => {
        const y = 2.08 + index * rowH;
        if (index > 0) ctx.slide.addShape(ctx.pptx.ShapeType.line, {
            x: 6.65,
            y,
            w: 5.42,
            h: 0,
            line: { color: ctx.art.palette.muted, transparency: 72, width: 0.8 },
        });
        addText(ctx, String(index + 2).padStart(2, '0'), {
            x: 6.65,
            y: y + 0.22,
            w: 0.55,
            h: 0.24,
            fontSize: bodySize(ctx, 9),
            bold: true,
            color: ctx.art.palette.accent,
        });
        addText(ctx, item.title, {
            x: 7.42,
            y: y + 0.16,
            w: 4.68,
            h: 0.5,
            fontFace: ctx.art.typography.heading,
            fontSize: titleSize(ctx, 20),
            bold: true,
            color: ctx.art.palette.text,
        });
        if (item.description) addText(ctx, item.description, {
            x: 7.42,
            y: y + 0.66,
            w: 4.68,
            h: Math.max(0.34, rowH - 0.78),
            fontSize: bodySize(ctx, 16),
            color: ctx.art.palette.muted,
            valign: 'top',
        });
    });
}

function addCollectionHeader(ctx: RenderContext, slidePlan: PresentationSlidePlan): void {
    addSlideTitle(ctx, slidePlan, slidePlan.body ? 7.15 : 11.7);
    if (slidePlan.body) {
        addText(ctx, slidePlan.body, {
            x: 8.45,
            y: 0.72,
            w: 3.72,
            h: 1.05,
            fontSize: bodySize(ctx, 14),
            color: ctx.art.palette.muted,
            valign: 'top',
            lineSpacingMultiple: 1.02,
        });
    }
}

function renderCollectionBanded(ctx: RenderContext, slidePlan: PresentationSlidePlan): void {
    addCollectionHeader(ctx, slidePlan);
    const items = slidePlan.items;
    const x = marginX(ctx);
    const top = 2.02;
    const width = visualLanguage(ctx) === 'editorial' ? 10.72 : 11.75;
    // Keep the final band above the large editorial page signature at bottom
    // left. Ten-item ledgers previously placed their last index on top of it.
    const height = slidePlan.bullets.length ? 3.72 : 3.9;
    const rowH = height / Math.max(1, items.length);
    items.forEach((item, index) => {
        const y = top + index * rowH;
        const fill = index % 2 ? ctx.art.palette.surface : ctx.art.palette.background;
        ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
            x,
            y: y + 0.025,
            w: width,
            h: Math.max(0.24, rowH - 0.05),
            line: { color: fill, transparency: 100 },
            fill: { color: fill, transparency: index % 2 ? 8 : 100 },
        });
        // Use one compact waypoint per record. Repeating full-height accent
        // bars beside the deck-wide signature looked like duplicated chrome
        // on milestone and risk pages.
        ctx.slide.addShape(ctx.pptx.ShapeType.ellipse, {
            x: x + 0.035,
            y: y + Math.max(0.08, rowH / 2 - 0.065),
            w: 0.13,
            h: 0.13,
            line: { color: index % 2 ? ctx.art.palette.accent2 : ctx.art.palette.accent, transparency: 100 },
            fill: { color: index % 2 ? ctx.art.palette.accent2 : ctx.art.palette.accent },
        });
        addText(ctx, String(index + 1).padStart(2, '0'), {
            x: x + 0.34,
            y,
            w: 0.55,
            h: rowH,
            fontFace: ctx.art.typography.heading,
            fontSize: titleSize(ctx, 13),
            bold: true,
            color: ctx.art.palette.accent,
            align: 'center',
        });
        addText(ctx, item.title, {
            x: x + 1.1,
            y,
            w: item.description ? 4.25 : width - 1.42,
            h: rowH,
            fontFace: ctx.art.typography.heading,
            fontSize: titleSize(ctx, rowH > 0.72 ? 17 : 15),
            bold: true,
            color: ctx.art.palette.text,
        });
        if (item.description) addText(ctx, item.description, {
            x: x + 5.58,
            y,
            w: width - 5.9,
            h: rowH,
            fontSize: bodySize(ctx, 14),
            color: ctx.art.palette.muted,
            valign: 'middle',
        });
    });
    addInsightStrip(ctx, slidePlan.bullets, 5.96, 0.7);
}

export function eventLedgerTextParts(
    item: Pick<PresentationItem, 'title' | 'description'>,
    index: number,
): { marker: string; title: string; detail: string } {
    const description = item.description || '';
    const divider = description.search(/[｜|]/);
    const prefix = divider >= 0 ? description.slice(0, divider).trim() : '';
    const marker = prefix && prefix.length <= 18 && /\d/.test(prefix)
        ? prefix
        : String(index + 1).padStart(2, '0');
    return {
        marker,
        title: item.title,
        detail: marker === prefix ? description.slice(divider + 1).trim() : description,
    };
}

function renderEventLedger(ctx: RenderContext, slidePlan: PresentationSlidePlan): void {
    addCollectionHeader(ctx, slidePlan);
    const items = slidePlan.items;
    const top = 2.05;
    const contentH = slidePlan.bullets.length ? 3.72 : 4.42;
    const rowH = contentH / Math.max(1, items.length);
    const spineX = 3.02;
    ctx.slide.addShape(ctx.pptx.ShapeType.line, {
        x: spineX,
        y: top + rowH * 0.34,
        w: 0,
        h: Math.max(0.1, contentH - rowH * 0.68),
        line: { color: ctx.art.palette.accent, transparency: 35, width: 2 },
    });
    items.forEach((item, index) => {
        const y = top + index * rowH;
        const parts = eventLedgerTextParts(item, index);
        const markerLayout = boundedTextLayout(
            parts.marker,
            1.82,
            rowH,
            titleSize(ctx, rowH > 0.75 ? 17 : 14.5),
            11,
        );
        addText(ctx, parts.marker, {
            x: marginX(ctx),
            y,
            w: 1.82,
            h: rowH,
            fontFace: ctx.art.typography.heading,
            fontSize: markerLayout.fontSize,
            bold: true,
            color: index === 0 ? ctx.art.palette.accent : ctx.art.palette.text,
            align: 'right',
        });
        ctx.slide.addShape(ctx.pptx.ShapeType.ellipse, {
            x: spineX - 0.095,
            y: y + rowH * 0.5 - 0.095,
            w: 0.19,
            h: 0.19,
            line: { color: ctx.art.palette.background, width: 1.2 },
            fill: { color: index === 0 ? ctx.art.palette.accent2 : ctx.art.palette.accent },
        });
        const textX = 3.48;
        const textW = 7.8;
        // Four-row event pages have enough vertical room for a real hierarchy.
        // Keeping the title and factual detail in separate text boxes also sends
        // the detail through addText's CJK line balancer. The former rich-text
        // box bypassed that path and could strand one-to-three Han characters on
        // the final rendered line, forcing an otherwise valid deck into a retry
        // loop even though no factual copy was allowed to change.
        if (parts.detail && rowH >= 0.9) {
            const titleH = Math.min(0.38, rowH * 0.34);
            const detailTop = Math.min(0.45, rowH * 0.41);
            const detailH = Math.max(0.34, rowH - detailTop - 0.08);
            const titleLayout = boundedTextLayout(
                parts.title,
                textW,
                titleH,
                bodySize(ctx, 15.5),
                12.5,
            );
            const detailLayout = boundedTextLayout(
                parts.detail,
                textW,
                detailH,
                bodySize(ctx, 13.5),
                10.5,
            );
            addText(ctx, parts.title, {
                x: textX,
                y: y + 0.08,
                w: textW,
                h: titleH,
                fontFace: ctx.art.typography.heading,
                fontSize: titleLayout.fontSize,
                bold: true,
                color: ctx.art.palette.text,
                valign: 'top',
            });
            addText(ctx, parts.detail, {
                x: textX,
                y: y + detailTop,
                w: textW,
                h: detailH,
                fontSize: detailLayout.fontSize,
                color: ctx.art.palette.muted,
                valign: 'top',
            });
        } else {
            const inlineText = parts.detail ? `${parts.title}  ·  ${parts.detail}` : parts.title;
            const inlineLayout = boundedTextLayout(
                inlineText,
                textW,
                rowH,
                bodySize(ctx, rowH > 0.75 ? 16 : 14),
                10.5,
            );
            const inlineFit = resolveTextFit(ctx);
            ctx.slide.addText([
                { text: parts.title, options: { bold: true, color: ctx.art.palette.text } },
                ...(parts.detail ? [{
                    text: `  ·  ${parts.detail}`,
                    options: { color: ctx.art.palette.muted },
                }] : []),
            ], {
                x: textX,
                y,
                w: textW,
                h: rowH,
                fontFace: ctx.art.typography.body,
                fontSize: scaledFontSize(inlineLayout.fontSize, inlineFit.fontScale),
                margin: 0,
                fit: 'shrink',
                valign: 'middle',
                objectName: inlineFit.objectName,
            });
        }
        if (index < items.length - 1) ctx.slide.addShape(ctx.pptx.ShapeType.line, {
            x: 3.48,
            y: y + rowH,
            w: 7.8,
            h: 0,
            line: { color: ctx.art.palette.muted, transparency: 86, width: 0.55 },
        });
    });
    addInsightStrip(ctx, slidePlan.bullets, 5.96, 0.7);
}

function renderSourceIndex(ctx: RenderContext, slidePlan: PresentationSlidePlan): void {
    addCollectionHeader(ctx, slidePlan);
    const items = slidePlan.items;
    const top = 2.04;
    const width = visualLanguage(ctx) === 'editorial' ? 10.72 : 11.75;
    // Source indices use a bottom-left numeric signature on alternating
    // editorial surfaces. Reserve a real vertical gutter for the final row.
    const contentH = slidePlan.bullets.length ? 3.72 : 3.9;
    const rowH = contentH / Math.max(1, items.length);
    items.forEach((item, index) => {
        const y = top + index * rowH;
        const numberFill = index % 2 ? ctx.art.palette.accent2 : ctx.art.palette.accent;
        addText(ctx, `[${String(index + 1).padStart(2, '0')}]`, {
            x: marginX(ctx),
            y,
            w: 0.72,
            h: rowH,
            fontFace: ctx.art.typography.heading,
            fontSize: titleSize(ctx, 12),
            bold: true,
            color: numberFill,
        });
        addText(ctx, item.title, {
            x: marginX(ctx) + 0.92,
            y,
            w: 4.05,
            h: rowH,
            fontFace: ctx.art.typography.heading,
            fontSize: titleSize(ctx, rowH > 0.72 ? 17 : 14.5),
            bold: true,
            color: ctx.art.palette.text,
        });
        addText(ctx, item.description || '可追踪来源', {
            x: marginX(ctx) + 5.32,
            y,
            w: width - 5.55,
            h: rowH,
            fontSize: bodySize(ctx, rowH > 0.72 ? 15 : 13.5),
            color: ctx.art.palette.muted,
        });
        ctx.slide.addShape(ctx.pptx.ShapeType.line, {
            x: marginX(ctx) + 0.92,
            y: y + rowH - 0.02,
            w: width - 0.92,
            h: 0,
            line: { color: numberFill, transparency: 78, width: 0.7 },
        });
    });
    addInsightStrip(ctx, slidePlan.bullets, 5.96, 0.7);
}

function renderDenseCollectionAtlas(ctx: RenderContext, slidePlan: PresentationSlidePlan): void {
    addCollectionHeader(ctx, slidePlan);
    const items = slidePlan.items;
    const columnCount = 3;
    const gap = 0.52;
    const width = visualLanguage(ctx) === 'editorial' ? 10.72 : 11.75;
    const columnW = (width - gap * (columnCount - 1)) / columnCount;
    const rows = Math.ceil(items.length / columnCount);
    const rowH = (slidePlan.bullets.length ? 3.72 : 4.42) / rows;
    items.forEach((item, index) => {
        const column = index % columnCount;
        const row = Math.floor(index / columnCount);
        const x = marginX(ctx) + column * (columnW + gap);
        const y = 2.08 + row * rowH;
        addText(ctx, String(index + 1).padStart(2, '0'), {
            x,
            y,
            w: 0.45,
            h: Math.min(0.4, rowH),
            fontSize: bodySize(ctx, 9),
            bold: true,
            color: ctx.art.palette.accent,
            valign: 'top',
        });
        ctx.slide.addShape(ctx.pptx.ShapeType.line, {
            x: x + 0.58,
            y: y + 0.08,
            w: columnW - 0.58,
            h: 0,
            line: { color: ctx.art.palette.accent, transparency: 42, width: 1.2 },
        });
        addText(ctx, item.title, {
            x: x + 0.58,
            y: y + 0.2,
            w: columnW - 0.64,
            h: item.description ? Math.min(0.52, rowH * 0.42) : Math.max(0.45, rowH - 0.3),
            fontFace: ctx.art.typography.heading,
            fontSize: titleSize(ctx, 16),
            bold: true,
            color: ctx.art.palette.text,
            valign: item.description ? 'top' : 'middle',
        });
        if (item.description) addText(ctx, item.description, {
            x: x + 0.58,
            y: y + Math.min(0.72, rowH * 0.5),
            w: columnW - 0.64,
            h: Math.max(0.28, rowH - Math.min(0.82, rowH * 0.58)),
            fontSize: bodySize(ctx, 13.5),
            color: ctx.art.palette.muted,
            valign: 'top',
        });
    });
    addInsightStrip(ctx, slidePlan.bullets, 5.96, 0.7);
}

function renderCollectionList(ctx: RenderContext, slidePlan: PresentationSlidePlan): void {
    const silhouette = slidePlan.resolvedLayout.silhouette;
    if (silhouette === 'collection-list-banded') {
        renderCollectionBanded(ctx, slidePlan);
        return;
    }
    if (silhouette === 'event-ledger') {
        renderEventLedger(ctx, slidePlan);
        return;
    }
    if (silhouette === 'source-index') {
        renderSourceIndex(ctx, slidePlan);
        return;
    }
    if (slidePlan.items.length >= 7) {
        renderDenseCollectionAtlas(ctx, slidePlan);
        return;
    }
    addCollectionHeader(ctx, slidePlan);

    const items = slidePlan.items;
    // Three concise records read more evenly as a full-width three-row ledger.
    // A 2+1 split leaves one oversized card and weakens comparison rhythm.
    const firstColumnCount = items.length === 3 ? items.length : Math.ceil(items.length / 2);
    const columns = items.length === 3
        ? [items]
        : [items.slice(0, firstColumnCount), items.slice(firstColumnCount)].filter(column => column.length > 0);
    const gap = 0.62;
    // Editorial backgrounds carry a large page signature at bottom right.
    // Reserve that column in the actual PowerPoint geometry, not only in the
    // visible glyph placement, so final-row text boxes remain disjoint.
    const availableW = visualLanguage(ctx) === 'editorial' ? 10.72 : 11.75;
    const columnW = (availableW - gap * (columns.length - 1)) / columns.length;
    const contentTop = 2.08;
    const maxRows = Math.max(...columns.map(column => column.length));
    const maxDescriptionUnits = Math.max(0, ...items.map(item => visualTextUnits(item.description || '') / 2));
    const densityRowHeight = maxDescriptionUnits > 55 ? 2.02 : maxDescriptionUnits > 30 ? 1.82 : 1.58;
    const rowH = Math.min(densityRowHeight, (slidePlan.bullets.length ? 3.72 : 4.48) / maxRows);
    const contentH = rowH * maxRows;

    columns.forEach((column, columnIndex) => {
        const columnX = marginX(ctx) + columnIndex * (columnW + gap);
        if (columnIndex > 0) {
            ctx.slide.addShape(ctx.pptx.ShapeType.line, {
                x: columnX - gap / 2,
                y: contentTop,
                w: 0,
                h: contentH,
                line: { color: ctx.art.palette.muted, transparency: 78, width: 0.8 },
            });
        }
        column.forEach((item, rowIndex) => {
            const itemIndex = columnIndex === 0 ? rowIndex : firstColumnCount + rowIndex;
            const y = contentTop + rowIndex * rowH;
            if (rowIndex > 0) {
                ctx.slide.addShape(ctx.pptx.ShapeType.line, {
                    x: columnX,
                    y,
                    w: columnW,
                    h: 0,
                    line: { color: ctx.art.palette.muted, transparency: 82, width: 0.7 },
                });
            }
            ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
                x: columnX,
                y: y + 0.15,
                w: 0.05,
                h: Math.max(0.28, rowH - 0.3),
                line: { color: ctx.art.palette.accent, transparency: 100 },
                fill: { color: ctx.art.palette.accent },
            });
            addText(ctx, String(itemIndex + 1).padStart(2, '0'), {
                x: columnX + 0.18,
                y: y + 0.14,
                w: 0.42,
                h: Math.min(0.32, rowH - 0.18),
                fontSize: bodySize(ctx, 9),
                bold: true,
                color: ctx.art.palette.accent,
                valign: 'top',
            });
            addText(ctx, item.title, {
                x: columnX + 0.68,
                y: y + (item.description ? 0.1 : 0.13),
                w: columnW - 0.78,
                h: item.description ? Math.min(0.4, rowH * 0.48) : Math.max(0.34, rowH - 0.24),
                fontFace: ctx.art.typography.heading,
                fontSize: titleSize(ctx, 17),
                bold: true,
                color: ctx.art.palette.text,
                valign: item.description ? 'top' : 'middle',
            });
            if (item.description) {
                addText(ctx, item.description, {
                    x: columnX + 0.68,
                    y: y + Math.min(0.48, rowH * 0.52),
                    w: columnW - 0.78,
                    h: Math.max(0.24, rowH - Math.min(0.56, rowH * 0.6) - 0.1),
                    fontSize: boundedTextLayout(
                        item.description,
                        columnW - 0.78,
                        Math.max(0.24, rowH - Math.min(0.56, rowH * 0.6) - 0.1),
                        bodySize(ctx, 15.5),
                        13,
                    ).fontSize,
                    color: ctx.art.palette.muted,
                    valign: 'top',
                });
            }
        });
    });
    addInsightStrip(ctx, slidePlan.bullets, 5.96, 0.7);
}

function renderGrid(ctx: RenderContext, slidePlan: PresentationSlidePlan): void {
    const items = slidePlan.items.length
        ? slidePlan.items
        : slidePlan.bullets.map(item => ({ title: item }));
    if (!items.length) {
        renderNarrative(ctx, slidePlan);
        return;
    }
    if (['collection-list', 'collection-list-banded', 'event-ledger', 'source-index'].includes(slidePlan.resolvedLayout.silhouette)) {
        renderCollectionList(ctx, slidePlan);
    } else {
        addSlideTitle(ctx, slidePlan);
        if (slidePlan.resolvedLayout.silhouette === 'collection-mosaic') renderCollectionMosaic(ctx, items);
        else renderFlatItems(ctx, items, marginX(ctx), 2.1, 11.75, 3.95);
    }
    addFooter(ctx);
}

function renderMetricSpotlight(ctx: RenderContext, slidePlan: PresentationSlidePlan): void {
    const language = visualLanguage(ctx);
    addSlideTitle(ctx, slidePlan, slidePlan.body ? 7.15 : 11.7);
    if (slidePlan.body) {
        addText(ctx, slidePlan.body, {
            x: 8.45,
            y: 0.72,
            w: 3.72,
            h: 1.05,
            fontSize: bodySize(ctx, 14),
            color: ctx.art.palette.muted,
            valign: 'top',
            lineSpacingMultiple: 1.02,
        });
    }
    const metrics = slidePlan.metrics;
    if (!metrics.length) {
        renderNarrative(ctx, slidePlan);
        return;
    }
    const primary = metrics[0];
    const primaryContentWidth = language === 'editorial' ? 4.15 : 5.55;
    const primaryDescriptionWidth = language === 'editorial' ? 3.85 : 5.05;
    const primaryLabelLayout = metricLabelTextLayout(primary.label, primaryContentWidth, titleSize(ctx, 23));
    const primaryValueLayout = metricValueTextLayout(
        primary.value,
        primaryContentWidth,
        titleSize(ctx, 68 * slidePlan.layout.focalScale),
        1.72,
    );
    const heroFill = language === 'kinetic' ? ctx.art.palette.accent : ctx.art.palette.surface;
    const heroText = language === 'kinetic' ? textOn(ctx, heroFill) : ctx.art.palette.text;
    if (language === 'precision') {
        ctx.slide.addShape(ctx.pptx.ShapeType.line, {
            x: 7.12, y: 2.12, w: 0, h: 4.05,
            line: { color: ctx.art.palette.accent, transparency: 24, width: 1.4 },
        });
        ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
            x: marginX(ctx), y: 2.12, w: 2.34, h: 0.1,
            line: { color: ctx.art.palette.accent2, transparency: 100 },
            fill: { color: ctx.art.palette.accent2 },
        });
    } else {
        ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
            x: marginX(ctx),
            y: 2.12,
            w: 6.35,
            h: 4.05,
            line: { color: language === 'kinetic' ? heroFill : ctx.art.palette.accent, transparency: language === 'kinetic' ? 100 : 58, width: 1.2 },
            fill: { color: heroFill },
        } as any);
    }
    if (language === 'editorial') {
        ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
            x: marginX(ctx), y: 2.12, w: 0.16, h: 4.05,
            line: { color: ctx.art.palette.accent, transparency: 100 },
            fill: { color: ctx.art.palette.accent },
        });
        addText(ctx, '01', {
            x: 5.15, y: 2.3, w: 1.25, h: 0.72,
            fontFace: ctx.art.typography.heading, fontSize: 38, bold: true,
            color: ctx.art.palette.accent, transparency: 70, align: 'right',
        } as any);
    }
    addText(ctx, primary.value, {
        x: 1.18,
        y: 2.38,
        w: primaryContentWidth,
        h: primaryValueLayout.height,
        fontFace: ctx.art.typography.heading,
        fontSize: primaryValueLayout.fontSize,
        bold: true,
        color: language === 'kinetic' ? heroText : ctx.art.palette.accent,
        align: 'center',
    });
    addText(ctx, primary.label, {
        x: 1.18,
        y: 4.34,
        w: primaryContentWidth,
        h: primaryLabelLayout.height,
        fontSize: primaryLabelLayout.fontSize,
        bold: true,
        color: heroText,
        align: 'center',
    });
    if (primary.description) {
        const descriptionLayout = metricDescriptionTextLayout(
            primary.description,
            primaryDescriptionWidth,
            bodySize(ctx, 16),
            0.72,
        );
        addText(ctx, primary.description, {
            x: language === 'editorial' ? 1.34 : 1.42,
            y: 4.34 + primaryLabelLayout.height + 0.18,
            w: primaryDescriptionWidth,
            h: descriptionLayout.height,
            fontSize: descriptionLayout.fontSize,
            color: language === 'kinetic' ? heroText : ctx.art.palette.muted,
            transparency: language === 'kinetic' ? 18 : 0,
            align: 'center',
        } as any);
    }
    const supportingMetrics = metrics.slice(1);
    const supportingRowHeight = Math.min(1.82, 3.72 / Math.max(1, supportingMetrics.length));
    supportingMetrics.forEach((metric, index) => {
        const y = 2.18 + index * supportingRowHeight;
        const labelHeight = metric.description
            ? Math.min(0.88, Math.max(0.54, supportingRowHeight * 0.48))
            : Math.min(0.88, supportingRowHeight - 0.12);
        const labelLayout = boundedTextLayout(
            metric.label,
            2.25,
            labelHeight,
            bodySize(ctx, 17),
            10.5,
        );
        const valueLayout = metricValueTextLayout(metric.value, 1.55, titleSize(ctx, 31), 0.78);
        addText(ctx, metric.value, {
            x: 8.02,
            y,
            w: 1.55,
            h: valueLayout.height,
            fontFace: ctx.art.typography.heading,
            fontSize: valueLayout.fontSize,
            bold: true,
            color: semanticAccentColor(ctx, slidePlan, metric, index),
        });
        addText(ctx, metric.label, {
            x: 9.78,
            y: y + 0.04,
            w: 2.25,
            h: labelHeight,
            fontSize: labelLayout.fontSize,
            bold: true,
            color: ctx.art.palette.text,
        });
        if (metric.description) {
            const descriptionHeight = Math.max(0.28, supportingRowHeight - labelHeight - 0.16);
            const descriptionLayout = metricDescriptionTextLayout(
                metric.description,
                2.25,
                bodySize(ctx, 14),
                descriptionHeight,
            );
            addText(ctx, metric.description, {
                x: 9.78,
                y: y + 0.04 + labelHeight + 0.04,
                w: 2.25,
                h: descriptionHeight,
                fontSize: descriptionLayout.fontSize,
                color: ctx.art.palette.muted,
            });
        }
    });
    addInsightStrip(ctx, slidePlan.bullets, 6.02, 0.72);
    addFooter(ctx);
}

function renderMetrics(ctx: RenderContext, slidePlan: PresentationSlidePlan): void {
    if (slidePlan.resolvedLayout.silhouette === 'metric-spotlight') {
        renderMetricSpotlight(ctx, slidePlan);
        return;
    }
    addSlideTitle(ctx, slidePlan, slidePlan.body ? 7.15 : 11.7);
    if (slidePlan.body) {
        addText(ctx, slidePlan.body, {
            x: 8.45,
            y: 0.72,
            w: 3.72,
            h: 1.05,
            fontSize: bodySize(ctx, 14),
            color: ctx.art.palette.muted,
            valign: 'top',
            lineSpacingMultiple: 1.02,
        });
    }
    const metrics = slidePlan.metrics;
    if (!metrics.length) {
        renderNarrative(ctx, slidePlan);
        return;
    }
    const hasInsights = slidePlan.bullets.length > 0;
    const language = visualLanguage(ctx);
    const width = 11.75 / metrics.length;
    metrics.forEach((metric, index) => {
        const x = marginX(ctx) + index * width;
        const editorialLead = language === 'editorial' && index === 0;
        if (editorialLead) {
            ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
                x, y: 2.1, w: width, h: 4.02,
                line: { color: ctx.art.palette.accent, transparency: 100 },
                fill: { color: ctx.art.palette.accent },
            });
        } else if (language === 'kinetic') {
            ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
                x: x + 0.08, y: 2.08, w: width - 0.16, h: 0.12,
                line: { color: index % 2 ? ctx.art.palette.accent2 : ctx.art.palette.accent, transparency: 100 },
                fill: { color: index % 2 ? ctx.art.palette.accent2 : ctx.art.palette.accent },
            });
        }
        const itemText = editorialLead ? textOn(ctx, ctx.art.palette.accent) : ctx.art.palette.text;
        const itemMuted = editorialLead ? itemText : ctx.art.palette.muted;
        const labelWidth = width - 0.5;
        const labelLayout = metricLabelTextLayout(metric.label, labelWidth, titleSize(ctx, 20));
        const metricValueLength = visualTextUnits(metric.value);
        const metricValueSize = metricValueLength > 14
            ? 28
            : metrics.length <= 3 ? 48 : 41;
        const valueLayout = metricValueTextLayout(
            metric.value,
            width - 0.5,
            titleSize(ctx, metricValueSize),
            1.64,
        );
        if (index > 0) {
            ctx.slide.addShape(ctx.pptx.ShapeType.line, {
                x,
                y: 2.25,
                w: 0,
                h: 3.5,
                line: { color: ctx.art.palette.muted, transparency: 72, width: 0.9 },
            });
        }
        addText(ctx, metric.value, {
            x: x + 0.25,
            y: 2.3,
            w: width - 0.5,
            h: valueLayout.height,
            fontFace: ctx.art.typography.heading,
            fontSize: valueLayout.fontSize,
            bold: true,
            color: editorialLead ? itemText : semanticAccentColor(ctx, slidePlan, metric, index),
            align: 'center',
        });
        addText(ctx, metric.label, {
            x: x + 0.25,
            y: 4.08,
            w: labelWidth,
            h: labelLayout.height,
            fontSize: labelLayout.fontSize,
            bold: true,
            color: itemText,
            align: 'center',
        });
        if (metric.description) {
            const descriptionY = 4.08 + labelLayout.height + 0.08;
            const descriptionMaxHeight = hasInsights
                ? Math.max(0.4, 5.58 - descriptionY)
                : Math.max(0.5, 6.15 - descriptionY);
            const descriptionLayout = metricDescriptionTextLayout(
                metric.description,
                width - 0.6,
                bodySize(ctx, 16),
                descriptionMaxHeight,
            );
            addText(ctx, metric.description, {
                x: x + 0.3,
                y: descriptionY,
                w: width - 0.6,
                h: descriptionLayout.height,
                fontSize: descriptionLayout.fontSize,
                color: itemMuted,
                transparency: editorialLead ? 18 : 0,
                align: 'center',
                valign: 'top',
            } as any);
        }
    });
    addInsightStrip(ctx, slidePlan.bullets, 5.68, 0.92);
    addFooter(ctx);
}

interface ChartFrame {
    x: number;
    y: number;
    w: number;
    h: number;
}

function chartColors(ctx: RenderContext): string[] {
    return [
        ctx.art.palette.accent,
        ctx.art.palette.accent2,
        ctx.art.palette.text,
        mixColor(ctx.art.palette.accent, ctx.art.palette.accent2, 0.45),
        mixColor(ctx.art.palette.accent, ctx.art.palette.surface, 0.48),
        mixColor(ctx.art.palette.accent2, ctx.art.palette.surface, 0.42),
    ];
}

function semanticChartColors(
    ctx: RenderContext,
    slidePlan: PresentationSlidePlan,
    chart: PresentationChart,
): string[] {
    const tone = presentationSemanticTone([
        slidePlan.title || '',
        slidePlan.message,
        chart.name || '',
        ...chart.labels,
    ].join(' '));
    if (tone === 'negative') {
        return [
            ctx.art.palette.accent2,
            mixColor(ctx.art.palette.accent2, ctx.art.palette.text, 0.16),
            mixColor(ctx.art.palette.accent2, ctx.art.palette.surface, 0.22),
            mixColor(ctx.art.palette.accent2, ctx.art.palette.text, 0.3),
        ];
    }
    if (tone === 'positive') {
        return [
            ctx.art.palette.accent,
            mixColor(ctx.art.palette.accent, ctx.art.palette.text, 0.16),
            mixColor(ctx.art.palette.accent, ctx.art.palette.surface, 0.22),
            mixColor(ctx.art.palette.accent, ctx.art.palette.text, 0.3),
        ];
    }
    return chartColors(ctx);
}

function chartRange(values: number[], includeZero = true): { min: number; max: number } {
    const minValue = Math.min(...values, includeZero ? 0 : Number.POSITIVE_INFINITY);
    const maxValue = Math.max(...values, includeZero ? 0 : Number.NEGATIVE_INFINITY);
    const spread = Math.max(1, maxValue - minValue);
    return { min: minValue - spread * 0.04, max: maxValue + spread * 0.06 };
}

function chartValueY(value: number, range: { min: number; max: number }, frame: ChartFrame): number {
    return frame.y + frame.h - ((value - range.min) / Math.max(0.0001, range.max - range.min)) * frame.h;
}

function addCustomChartGrid(ctx: RenderContext, frame: ChartFrame, rows = 4): void {
    for (let index = 0; index <= rows; index++) {
        const y = frame.y + frame.h * index / rows;
        ctx.slide.addShape(ctx.pptx.ShapeType.line, {
            x: frame.x,
            y,
            w: frame.w,
            h: 0,
            line: {
                color: ctx.art.palette.muted,
                transparency: index === rows ? 45 : 86,
                width: index === rows ? 1.1 : 0.55,
            },
        });
    }
}

function renderComboChart(ctx: RenderContext, chart: PresentationChart, frame: ChartFrame): void {
    const series = chart.series || [];
    const bars = series[0]?.values || chart.values;
    const line = series[1]?.values || chart.values;
    const barRange = chartRange(bars);
    const lineRange = chartRange(line, false);
    const plot = { x: frame.x + 0.18, y: frame.y + 0.18, w: frame.w - 0.35, h: frame.h - 0.72 };
    addCustomChartGrid(ctx, plot);
    const band = plot.w / bars.length;
    const zeroY = chartValueY(0, barRange, plot);
    const points: Array<{ x: number; y: number }> = [];
    bars.forEach((value, index) => {
        const valueY = chartValueY(value, barRange, plot);
        const x = plot.x + band * index + band * 0.25;
        ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
            x,
            y: Math.min(valueY, zeroY),
            w: band * 0.5,
            h: Math.max(0.04, Math.abs(zeroY - valueY)),
            line: { color: ctx.art.palette.accent, transparency: 100 },
            fill: { color: ctx.art.palette.accent, transparency: 8 },
        });
        points.push({ x: plot.x + band * (index + 0.5), y: chartValueY(line[index] ?? 0, lineRange, plot) });
        addText(ctx, chart.labels[index] || '', {
            x: plot.x + band * index,
            y: plot.y + plot.h + 0.12,
            w: band,
            h: 0.3,
            fontSize: bodySize(ctx, 9.5),
            color: ctx.art.palette.muted,
            align: 'center',
        });
    });
    points.slice(1).forEach((point, index) => {
        const previous = points[index]!;
        const rising = point.y < previous.y;
        ctx.slide.addShape(ctx.pptx.ShapeType.line, {
            x: previous.x,
            y: Math.min(previous.y, point.y),
            w: point.x - previous.x,
            h: Math.max(0.001, Math.abs(point.y - previous.y)),
            flipV: rising,
            line: { color: ctx.art.palette.accent2, width: 2.4 },
        });
    });
    points.forEach(point => ctx.slide.addShape(ctx.pptx.ShapeType.ellipse, {
        x: point.x - 0.07,
        y: point.y - 0.07,
        w: 0.14,
        h: 0.14,
        line: { color: ctx.art.palette.background, width: 1 },
        fill: { color: ctx.art.palette.accent2 },
    }));
    addText(ctx, series[0]?.name || 'Series 1', {
        x: frame.x + 0.2, y: frame.y - 0.05, w: 1.5, h: 0.28,
        fontSize: bodySize(ctx, 10), bold: true, color: ctx.art.palette.accent,
    });
    addText(ctx, series[1]?.name || 'Series 2', {
        x: frame.x + 1.78, y: frame.y - 0.05, w: 1.5, h: 0.28,
        fontSize: bodySize(ctx, 10), bold: true, color: ctx.art.palette.accent2,
    });
    addText(ctx, String(Math.max(...line)), {
        x: plot.x + plot.w - 0.48, y: plot.y - 0.02, w: 0.45, h: 0.24,
        fontSize: bodySize(ctx, 8.5), bold: true, color: ctx.art.palette.accent2, align: 'right',
    });
    addText(ctx, String(Math.min(...line)), {
        x: plot.x + plot.w - 0.48, y: plot.y + plot.h - 0.2, w: 0.45, h: 0.24,
        fontSize: bodySize(ctx, 8.5), bold: true, color: ctx.art.palette.accent2, align: 'right',
    });
}

function renderScatterChart(ctx: RenderContext, chart: PresentationChart, frame: ChartFrame): void {
    const xValues = chart.xValues || chart.values.map((_, index) => index + 1);
    const xRange = chartRange(xValues, false);
    const yRange = chartRange(chart.values, false);
    const plot = { x: frame.x + 0.28, y: frame.y + 0.18, w: frame.w - 0.55, h: frame.h - 0.58 };
    addCustomChartGrid(ctx, plot);
    const sizes = chart.sizes || chart.values.map(() => 1);
    const sizeRange = chartRange(sizes, false);
    chart.values.forEach((value, index) => {
        const x = plot.x + ((xValues[index]! - xRange.min) / Math.max(0.0001, xRange.max - xRange.min)) * plot.w;
        const y = chartValueY(value, yRange, plot);
        const diameter = chart.type === 'bubble'
            ? 0.16 + ((sizes[index]! - sizeRange.min) / Math.max(0.0001, sizeRange.max - sizeRange.min)) * 0.42
            : 0.18;
        const color = chartColors(ctx)[index % chartColors(ctx).length]!;
        ctx.slide.addShape(ctx.pptx.ShapeType.ellipse, {
            x: x - diameter / 2,
            y: y - diameter / 2,
            w: diameter,
            h: diameter,
            line: { color, transparency: 8, width: 1 },
            fill: { color, transparency: chart.type === 'bubble' ? 22 : 4 },
        });
        if (chart.values.length <= 10) addText(ctx, chart.labels[index] || '', {
            x: x + diameter * 0.42,
            y: y - 0.14,
            w: Math.min(1.05, plot.x + plot.w - x),
            h: 0.26,
            fontSize: bodySize(ctx, 8.5),
            color: ctx.art.palette.muted,
        });
    });
}

function renderWaterfallChart(ctx: RenderContext, chart: PresentationChart, frame: ChartFrame): void {
    const totals: number[] = [0];
    chart.values.forEach(value => totals.push(totals[totals.length - 1]! + value));
    const range = chartRange(totals);
    const plot = { x: frame.x + 0.15, y: frame.y + 0.16, w: frame.w - 0.3, h: frame.h - 0.68 };
    addCustomChartGrid(ctx, plot);
    const band = plot.w / chart.values.length;
    chart.values.forEach((delta, index) => {
        const before = totals[index]!;
        const after = totals[index + 1]!;
        const beforeY = chartValueY(before, range, plot);
        const afterY = chartValueY(after, range, plot);
        const color = delta >= 0 ? ctx.art.palette.accent : ctx.art.palette.accent2;
        const x = plot.x + band * index + band * 0.18;
        ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
            x,
            y: Math.min(beforeY, afterY),
            w: band * 0.64,
            h: Math.max(0.05, Math.abs(afterY - beforeY)),
            line: { color, transparency: 100 },
            fill: { color, transparency: 6 },
        });
        if (index < chart.values.length - 1) ctx.slide.addShape(ctx.pptx.ShapeType.line, {
            x: x + band * 0.64,
            y: afterY,
            w: band * 0.36,
            h: 0,
            line: { color: ctx.art.palette.muted, transparency: 55, width: 0.8, dash: 'dash' },
        } as any);
        addText(ctx, `${delta > 0 ? '+' : ''}${delta}`, {
            x: plot.x + band * index,
            y: Math.max(plot.y, Math.min(beforeY, afterY) - 0.3),
            w: band,
            h: 0.25,
            fontSize: bodySize(ctx, 9.5),
            bold: true,
            color,
            align: 'center',
        });
        addText(ctx, chart.labels[index] || '', {
            x: plot.x + band * index,
            y: plot.y + plot.h + 0.12,
            w: band,
            h: 0.3,
            fontSize: bodySize(ctx, 8.8),
            color: ctx.art.palette.muted,
            align: 'center',
        });
    });
}

function renderHeatmap(ctx: RenderContext, chart: PresentationChart, frame: ChartFrame): void {
    const matrix = chart.matrix || [];
    const rowLabels = chart.rowLabels || [];
    const columnLabels = chart.columnLabels || chart.labels;
    const values = matrix.flat();
    const range = chartRange(values, false);
    const rows = matrix.length;
    const columns = matrix[0]?.length || 0;
    const labelW = 1.18;
    const labelH = 0.42;
    const grid = { x: frame.x + labelW, y: frame.y + labelH, w: frame.w - labelW - 0.12, h: frame.h - labelH - 0.1 };
    const cellW = grid.w / columns;
    const cellH = grid.h / rows;
    columnLabels.forEach((label, index) => addText(ctx, label, {
        x: grid.x + index * cellW,
        y: frame.y,
        w: cellW,
        h: labelH - 0.05,
        fontSize: bodySize(ctx, 8.8),
        bold: true,
        color: ctx.art.palette.muted,
        align: 'center',
    }));
    matrix.forEach((row, rowIndex) => {
        addText(ctx, rowLabels[rowIndex] || `R${rowIndex + 1}`, {
            x: frame.x,
            y: grid.y + rowIndex * cellH,
            w: labelW - 0.12,
            h: cellH,
            fontSize: bodySize(ctx, 9),
            bold: true,
            color: ctx.art.palette.muted,
            align: 'right',
        });
        row.forEach((value, columnIndex) => {
            const amount = (value - range.min) / Math.max(0.0001, range.max - range.min);
            const fill = mixColor(ctx.art.palette.surface, ctx.art.palette.accent, 0.12 + amount * 0.88);
            addText(ctx, cellW >= 0.54 && cellH >= 0.42 ? String(value) : '', {
                x: grid.x + columnIndex * cellW + 0.02,
                y: grid.y + rowIndex * cellH + 0.02,
                w: Math.max(0.08, cellW - 0.04),
                h: Math.max(0.08, cellH - 0.04),
                shape: ctx.pptx.ShapeType.rect,
                line: { color: ctx.art.palette.background, transparency: 80, width: 0.4 },
                fill: { color: fill },
                fontSize: bodySize(ctx, 9),
                bold: true,
                color: textOn(ctx, fill),
                align: 'center',
            });
        });
    });
}

function renderTreemap(ctx: RenderContext, chart: PresentationChart, frame: ChartFrame): void {
    const positiveValues = chart.values.map(value => Math.max(0, value));
    const total = positiveValues.reduce((sum, value) => sum + value, 0) || 1;
    const colors = chartColors(ctx);
    const nodes = chart.labels.map((label, index) => ({
        label,
        value: positiveValues[index]!,
        index,
        parent: chart.parents?.[index] || '',
    }));

    if (chart.parents?.some(Boolean)) {
        const grouped = new Map<string, typeof nodes>();
        nodes.forEach(node => {
            const parent = node.parent || '其他';
            grouped.set(parent, [...(grouped.get(parent) || []), node]);
        });
        const groups = [...grouped.entries()].map(([parent, children]) => ({
            parent,
            children,
            value: children.reduce((sum, child) => sum + child.value, 0),
        }));
        const groupTarget = total / 2;
        let firstRowCount = 0;
        let groupRunning = 0;
        while (firstRowCount < groups.length - 1 && groupRunning < groupTarget) {
            groupRunning += groups[firstRowCount]!.value;
            firstRowCount += 1;
        }
        const groupRows = [groups.slice(0, firstRowCount), groups.slice(firstRowCount)].filter(row => row.length);
        const groupRowTotals = groupRows.map(row => row.reduce((sum, group) => sum + group.value, 0));
        groupRows.forEach((row, rowIndex) => {
            const rowH = frame.h * groupRowTotals[rowIndex]! / total;
            const y = frame.y + groupRowTotals.slice(0, rowIndex).reduce((sum, value) => sum + frame.h * value / total, 0);
            let x = frame.x;
            row.forEach(group => {
                const groupW = frame.w * group.value / groupRowTotals[rowIndex]!;
                ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
                    x: x + 0.02, y: y + 0.02, w: Math.max(0.1, groupW - 0.04), h: Math.max(0.1, rowH - 0.04),
                    line: { color: ctx.art.palette.text, transparency: 65, width: 0.8 },
                    fill: { color: ctx.art.palette.surface, transparency: 100 },
                });
                addText(ctx, group.parent, {
                    x: x + 0.12, y: y + 0.08, w: Math.max(0.2, groupW - 0.24), h: 0.25,
                    fontSize: bodySize(ctx, 8.5), bold: true, color: ctx.art.palette.muted,
                });
                const childY = y + 0.35;
                const childH = Math.max(0.12, rowH - 0.39);
                let childX = x + 0.05;
                group.children.forEach(child => {
                    const childW = (groupW - 0.1) * child.value / Math.max(0.001, group.value);
                    const fill = colors[child.index % colors.length]!;
                    addText(ctx, childW >= 0.68 && childH >= 0.44 ? `${child.label}\n${child.value}` : '', {
                        x: childX,
                        y: childY,
                        w: Math.max(0.07, childW - 0.025),
                        h: childH,
                        shape: ctx.pptx.ShapeType.rect,
                        line: { color: ctx.art.palette.background, width: 0.9 },
                        fill: { color: fill, transparency: 5 },
                        fontSize: bodySize(ctx, childW >= 1.2 ? 10 : 8.5),
                        bold: true,
                        color: textOn(ctx, fill),
                        valign: 'top',
                        margin: 0.08,
                    } as any);
                    childX += childW;
                });
                x += groupW;
            });
        });
        return;
    }

    const target = total / 2;
    let firstRowCount = 0;
    let running = 0;
    while (firstRowCount < positiveValues.length - 1 && running < target) {
        running += positiveValues[firstRowCount]!;
        firstRowCount += 1;
    }
    const rows = [
        chart.labels.map((label, index) => ({ label, value: positiveValues[index]!, index })).slice(0, firstRowCount),
        chart.labels.map((label, index) => ({ label, value: positiveValues[index]!, index })).slice(firstRowCount),
    ].filter(row => row.length);
    const rowTotals = rows.map(row => row.reduce((sum, item) => sum + item.value, 0));
    rows.forEach((row, rowIndex) => {
        const rowH = frame.h * rowTotals[rowIndex]! / total;
        const y = frame.y + rowTotals.slice(0, rowIndex).reduce((sum, value) => sum + frame.h * value / total, 0);
        let x = frame.x;
        row.forEach(item => {
            const width = frame.w * item.value / rowTotals[rowIndex]!;
            const fill = colors[item.index % colors.length]!;
            ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
                x: x + 0.025,
                y: y + 0.025,
                w: Math.max(0.08, width - 0.05),
                h: Math.max(0.08, rowH - 0.05),
                line: { color: ctx.art.palette.background, width: 1.2 },
                fill: { color: fill, transparency: 6 },
            });
            if (width >= 0.75 && rowH >= 0.5) addText(ctx, `${item.label}\n${item.value}`, {
                x: x + 0.14,
                y: y + 0.1,
                w: Math.max(0.3, width - 0.28),
                h: Math.max(0.25, rowH - 0.2),
                fontSize: bodySize(ctx, width >= 1.35 ? 11 : 9),
                bold: true,
                color: textOn(ctx, fill),
                valign: 'top',
            });
            x += width;
        });
    });
}

function renderFunnel(ctx: RenderContext, chart: PresentationChart, frame: ChartFrame): void {
    const stageCount = chart.values.length;
    const max = Math.max(...chart.values, 1);
    const funnel = {
        x: frame.x + 0.2,
        y: frame.y + 0.06,
        w: Math.min(4.35, frame.w * 0.62),
        h: frame.h - 0.12,
    };
    const centerX = funnel.x + funnel.w / 2;
    const labelX = funnel.x + funnel.w + 0.34;
    const labelW = Math.max(1.72, frame.x + frame.w - labelX);
    const rowH = funnel.h / stageCount;
    const colors = chartColors(ctx);
    const entryColor = colors[0]!;
    const exitColor = colors[1] || ctx.art.palette.accent2;
    const svgHeight = 1000;
    const svgWidth = Math.round(svgHeight * funnel.w / funnel.h);
    const maximumWidth = svgWidth * 0.92;
    const center = svgWidth / 2;
    const stageHeight = svgHeight / stageCount;
    const stageWidths = chart.values.map(value => maximumWidth * Math.max(0, value) / max);
    const exitWidth = Math.max(32, (stageWidths.at(-1) || maximumWidth * 0.1) * 0.72);
    const segmentColors = chart.values.map((_, index) => mixColor(
        entryColor,
        exitColor,
        stageCount <= 1 ? 0 : index / (stageCount - 1),
    ));
    const polygons = chart.values.map((_, index) => {
        const topWidth = stageWidths[index]!;
        const bottomWidth = stageWidths[index + 1] ?? exitWidth;
        const top = index * stageHeight;
        const bottom = (index + 1) * stageHeight;
        const points = [
            `${center - topWidth / 2},${top}`,
            `${center + topWidth / 2},${top}`,
            `${center + bottomWidth / 2},${bottom}`,
            `${center - bottomWidth / 2},${bottom}`,
        ].join(' ');
        return `<polygon points="${points}" fill="#${segmentColors[index]}" stroke="#${ctx.art.palette.background}" stroke-width="4" stroke-linejoin="round"/>`;
    }).join('');
    const funnelSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}" role="img" aria-label="Data funnel">${polygons}</svg>`;
    ctx.slide.addImage({
        data: `data:image/svg+xml;base64,${Buffer.from(funnelSvg).toString('base64')}`,
        x: funnel.x,
        y: funnel.y,
        w: funnel.w,
        h: funnel.h,
        altText: 'OpenFlux generated vector: continuous segmented data funnel',
    });

    chart.values.forEach((value, index) => {
        const y = funnel.y + index * rowH;
        const previous = index === 0 ? value : chart.values[index - 1]!;
        const retention = index === 0
            ? '100%'
            : `${Math.round(value / Math.max(previous, 0.0001) * 100)}%`;
        const color = segmentColors[index]!;
        const nextWidth = stageWidths[index + 1] ?? exitWidth;
        const bodyWidth = funnel.w * ((stageWidths[index]! + nextWidth) / 2) / maximumWidth;
        const bodyRight = centerX + bodyWidth / 2;
        const leaderEnd = labelX - 0.12;

        ctx.slide.addShape(ctx.pptx.ShapeType.line, {
            x: bodyRight,
            y: y + rowH * 0.5,
            w: Math.max(0.08, leaderEnd - bodyRight),
            h: 0,
            line: { color, transparency: 38, width: 0.8 },
        });
        ctx.slide.addShape(ctx.pptx.ShapeType.ellipse, {
            x: labelX,
            y: y + rowH * 0.5 - 0.045,
            w: 0.09,
            h: 0.09,
            line: { color, transparency: 100 },
            fill: { color },
        });
        addText(ctx, chart.labels[index]!, {
            x: labelX + 0.18,
            y: y + 0.08,
            w: Math.max(0.72, labelW - 1.12),
            h: rowH * 0.42,
            fontSize: bodySize(ctx, 10.5),
            bold: true,
            color: ctx.art.palette.text,
            valign: 'middle',
        });
        addText(ctx, `${value}`, {
            x: labelX + labelW - 0.9,
            y: y + 0.06,
            w: 0.9,
            h: rowH * 0.42,
            fontSize: bodySize(ctx, 11),
            bold: true,
            color,
            align: 'right',
            valign: 'middle',
        });
        addText(ctx, index === 0 ? '基准' : `阶段留存 ${retention}`, {
            x: labelX + 0.18,
            y: y + rowH * 0.47,
            w: Math.max(0.8, labelW - 0.18),
            h: rowH * 0.34,
            fontSize: bodySize(ctx, 8.5),
            color: ctx.art.palette.muted,
            valign: 'middle',
        });
    });
}

function renderGantt(ctx: RenderContext, chart: PresentationChart, frame: ChartFrame): void {
    const starts = chart.startValues || chart.values.map(() => 0);
    const ends = chart.values.map((duration, index) => starts[index]! + duration);
    const min = Math.min(...starts, 0);
    const max = Math.max(...ends, 1);
    const labelW = 1.55;
    const plot = { x: frame.x + labelW, y: frame.y + 0.12, w: frame.w - labelW - 0.08, h: frame.h - 0.24 };
    for (let index = 0; index <= 5; index++) {
        const x = plot.x + plot.w * index / 5;
        ctx.slide.addShape(ctx.pptx.ShapeType.line, {
            x, y: plot.y, w: 0, h: plot.h,
            line: { color: ctx.art.palette.muted, transparency: 84, width: 0.55 },
        });
    }
    const rowH = plot.h / chart.labels.length;
    chart.labels.forEach((label, index) => {
        const y = plot.y + index * rowH;
        addText(ctx, label, {
            x: frame.x,
            y,
            w: labelW - 0.18,
            h: rowH,
            fontSize: bodySize(ctx, 9.5),
            bold: true,
            color: ctx.art.palette.text,
            align: 'right',
        });
        const startX = plot.x + (starts[index]! - min) / Math.max(0.0001, max - min) * plot.w;
        const width = chart.values[index]! / Math.max(0.0001, max - min) * plot.w;
        const color = chartColors(ctx)[index % chartColors(ctx).length]!;
        ctx.slide.addShape(ctx.pptx.ShapeType.roundRect, {
            x: startX,
            y: y + rowH * 0.27,
            w: Math.max(0.08, width),
            h: rowH * 0.46,
            rectRadius: cardRadius(ctx),
            line: { color, transparency: 100 },
            fill: { color, transparency: 5 },
        } as any);
    });
}

function renderCustomChart(ctx: RenderContext, chart: PresentationChart, frame: ChartFrame): boolean {
    switch (chart.type) {
        case 'combo': renderComboChart(ctx, chart, frame); return true;
        case 'waterfall': renderWaterfallChart(ctx, chart, frame); return true;
        case 'scatter':
        case 'bubble': renderScatterChart(ctx, chart, frame); return true;
        case 'heatmap': renderHeatmap(ctx, chart, frame); return true;
        case 'treemap': renderTreemap(ctx, chart, frame); return true;
        case 'funnel': renderFunnel(ctx, chart, frame); return true;
        case 'gantt': renderGantt(ctx, chart, frame); return true;
        default: return false;
    }
}

function renderChart(ctx: RenderContext, slidePlan: PresentationSlidePlan): void {
    const chart = slidePlan.chart;
    if (!chart) {
        renderMetrics(ctx, slidePlan);
        return;
    }
    const language = visualLanguage(ctx);
    addSlideTitle(ctx, slidePlan, 7.3);
    const chartFrame = { x: marginX(ctx), y: 2.0, w: 7.25, h: 4.55 };
    // Custom relationship charts carry editable labels inside their plot.
    // Start them below the maximum two-line title box; native chart objects do
    // not participate in text-overlap QA, but custom labels correctly do.
    const customFrame = { x: marginX(ctx), y: 2.32, w: 7.25, h: 4.2 };
    const custom = renderCustomChart(ctx, chart, customFrame);
    if (!custom) {
        const chartType = {
            bar: ctx.pptx.ChartType.bar,
            column: ctx.pptx.ChartType.bar,
            line: ctx.pptx.ChartType.line,
            pie: ctx.pptx.ChartType.pie,
            'stacked-bar': ctx.pptx.ChartType.bar,
            'stacked-column': ctx.pptx.ChartType.bar,
            area: ctx.pptx.ChartType.area,
            doughnut: ctx.pptx.ChartType.doughnut,
            radar: ctx.pptx.ChartType.radar,
            histogram: ctx.pptx.ChartType.bar,
        }[chart.type];
        const data = chart.series?.length
            ? chart.series.map(series => ({ name: series.name, labels: chart.labels, values: series.values }))
            : [{ name: chart.name || slidePlan.message, labels: chart.labels, values: chart.values }];
        const circular = chart.type === 'pie' || chart.type === 'doughnut';
        const lineLike = ['line', 'area', 'radar'].includes(chart.type);
        const vertical = ['column', 'stacked-column', 'histogram'].includes(chart.type);
        ctx.slide.addChart(chartType as any, data, {
            ...chartFrame,
            showTitle: false,
            showValue: !circular && !lineLike,
            catAxisLabelFontFace: ctx.art.typography.body,
            catAxisLabelFontSize: bodySize(ctx, 12),
            catAxisLabelColor: ctx.art.palette.text,
            catAxisLineColor: ctx.art.palette.muted,
            valAxisLabelFontFace: ctx.art.typography.body,
            valAxisLabelFontSize: bodySize(ctx, 11),
            valAxisLabelColor: ctx.art.palette.muted,
            valAxisLineColor: ctx.art.palette.muted,
            dataLabelColor: ctx.art.palette.text,
            dataLabelFontFace: ctx.art.typography.body,
            dataLabelFontSize: bodySize(ctx, 11),
            chartColors: semanticChartColors(ctx, slidePlan, chart),
            showLabel: circular,
            showPercent: circular,
            showLegend: Boolean(chart.series?.length && chart.series.length > 1),
            legendPos: 'b',
            barDir: vertical ? 'col' : 'bar',
            barGrouping: chart.type.startsWith('stacked-') ? 'stacked' : 'clustered',
            holeSize: chart.type === 'doughnut' ? 62 : undefined,
            radarStyle: chart.type === 'radar' ? 'marker' : undefined,
            lineDataSymbol: lineLike ? 'circle' : undefined,
            lineDataSymbolSize: lineLike ? 5 : undefined,
            lineSize: lineLike ? 2.25 : undefined,
        } as any);
    }
    let railText = ctx.art.palette.text;
    let railMuted = ctx.art.palette.muted;
    let railMarker = ctx.art.palette.accent;
    if (language === 'kinetic') {
        const railFill = ctx.art.palette.accent;
        railText = textOn(ctx, railFill);
        railMuted = railText;
        railMarker = textOn(ctx, railFill);
        ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
            x: 8.52, y: 1.98, w: 3.98, h: 4.28,
            line: { color: railFill, transparency: 100 },
            fill: { color: railFill },
        });
        addText(ctx, 'DATA', {
            x: 9.0, y: 5.35, w: 3.05, h: 0.54,
            fontFace: ctx.art.typography.heading, fontSize: 31, bold: true,
            color: railText, transparency: 72, align: 'right',
        } as any);
    } else {
        if (language === 'editorial') ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
            x: 8.62, y: 1.98, w: 3.88, h: 4.28,
            line: { color: ctx.art.palette.surface, transparency: 100 },
            fill: { color: ctx.art.palette.surface, transparency: 18 },
        });
        ctx.slide.addShape(ctx.pptx.ShapeType.line, {
            x: 8.53,
            y: 2.12,
            w: 0,
            h: 3.9,
            line: { color: ctx.art.palette.accent, transparency: language === 'editorial' ? 0 : 40, width: language === 'editorial' ? 4 : 1.5 },
        });
    }
    addReadingRail(ctx, slidePlan.body, slidePlan.bullets, 8.78, 2.1, 3.7, 3.95, railText, railMuted, railMarker);
    addFooter(ctx);
}

function renderComparison(ctx: RenderContext, slidePlan: PresentationSlidePlan): void {
    if (!slidePlan.comparison) {
        renderNarrative(ctx, slidePlan);
        return;
    }
    addSlideTitle(ctx, slidePlan, slidePlan.body ? 7.15 : 11.7);
    if (slidePlan.body) {
        addText(ctx, slidePlan.body, {
            x: 8.45,
            y: 0.72,
            w: 3.72,
            h: 1.05,
            fontSize: bodySize(ctx, 14),
            color: ctx.art.palette.muted,
            valign: 'top',
            lineSpacingMultiple: 1.02,
        });
    }
    const { left, right } = slidePlan.comparison;
    const language = visualLanguage(ctx);
    const cards = slidePlan.resolvedLayout.silhouette === 'comparison-cards';
    if (language === 'precision') ctx.slide.addShape(ctx.pptx.ShapeType.line, {
        x: 6.66,
        y: 2.08,
        w: 0,
        h: 3.85,
        line: { color: ctx.art.palette.accent, transparency: 30, width: 1.8 },
    });
    const renderSide = (side: PresentationComparisonSide, x: number, color: string, sideIndex: number) => {
        const kineticFill = sideIndex === 0 ? ctx.art.palette.accent : ctx.art.palette.accent2;
        const useColorField = language === 'kinetic';
        const useEditorialField = language === 'editorial';
        if ((cards && language !== 'precision') || useColorField || useEditorialField) ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
            x: x - 0.28,
            y: 1.94,
            w: 5.72,
            h: 4.12,
            line: { color: useColorField ? kineticFill : color, transparency: useColorField ? 100 : 72, width: 1 },
            fill: { color: useColorField ? kineticFill : ctx.art.palette.surface, transparency: useEditorialField && sideIndex === 1 ? 18 : 0 },
        } as any);
        if (useEditorialField) ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
            x: x - 0.28, y: 1.94, w: 0.12, h: 4.12,
            line: { color, transparency: 100 }, fill: { color },
        });
        const sideText = useColorField ? textOn(ctx, kineticFill) : ctx.art.palette.text;
        const headingColor = useColorField ? sideText : color;
        const headingLayout = boundedTextLayout(
            side.heading,
            5.18,
            0.92,
            titleSize(ctx, 25),
            18,
        );
        addBalancedText(ctx, headingLayout.lines > 1 ? balancedTitleText(side.heading) : side.heading, {
            x,
            y: 2.08,
            w: 5.18,
            h: 0.92,
            fontFace: ctx.art.typography.heading,
            fontSize: headingLayout.fontSize,
            bold: true,
            color: headingColor,
        });
        const comparisonCopy = side.items.join('\n');
        const comparisonLayout = boundedTextLayout(
            comparisonCopy,
            5.15,
            Math.max(1.8, 2.84 - Math.max(0, side.items.length - 1) * 0.1),
            bodySize(ctx, 19),
            bodySize(ctx, 13),
        );
        addBulletList(
            ctx,
            side.items,
            x,
            3.22,
            5.15,
            2.84,
            comparisonLayout.fontSize,
            side.items.length >= 3 ? 7 : 11,
            sideText,
        );
    };
    renderSide(left, marginX(ctx), ctx.art.palette.accent, 0);
    renderSide(right, 7.15, ctx.art.palette.accent2, 1);
    addInsightStrip(ctx, slidePlan.bullets, 6.06, 0.66);
    addFooter(ctx);
}

function renderQuote(ctx: RenderContext, slidePlan: PresentationSlidePlan): void {
    const quote = slidePlan.quote || slidePlan.message;
    const supportingBody = slidePlan.body?.trim();
    const supportingBullets = slidePlan.bullets.slice(0, 2);
    const hasSupportingCopy = Boolean(supportingBody || supportingBullets.length);
    const fullBleed = slidePlan.imagePath && slidePlan.resolvedLayout.silhouette === 'quote-full-bleed';
    if (fullBleed) {
        const imageFrame = resolvePresentationImageFrame(slidePlan, ctx.index)!;
        addImage(ctx, slidePlan.imagePath, slidePlan.imageAlt, imageFrame.x, imageFrame.y, imageFrame.w, imageFrame.h, slidePlan.imageMask);
        ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
            x: 0,
            y: 0,
            w: SLIDE_W,
            h: SLIDE_H,
            line: { color: ctx.art.palette.background, transparency: 100 },
            fill: { color: ctx.art.palette.background, transparency: 26 },
        });
    } else if (slidePlan.imagePath) {
        const imageFrame = resolvePresentationImageFrame(slidePlan, ctx.index)!;
        addImage(ctx, slidePlan.imagePath, slidePlan.imageAlt, imageFrame.x, imageFrame.y, imageFrame.w, imageFrame.h, slidePlan.imageMask);
    }
    ctx.slide.addShape(ctx.pptx.ShapeType.line, {
        x: 1.46,
        y: 1.03,
        w: 1.16,
        h: 0,
        line: { color: ctx.art.palette.accent, width: 5.2 },
    });
    const quoteWidth = slidePlan.imagePath && !fullBleed ? 6.72 : 10.28;
    const quoteHeight = hasSupportingCopy ? 3.15 : 3.65;
    const quoteLayout = boundedTextLayout(
        quote,
        quoteWidth,
        quoteHeight,
        titleSize(ctx, 37 * slidePlan.layout.focalScale),
        28,
    );
    const balancedQuote = quoteLayout.lines > 1
        ? balancedCjkBodyText(
            quote,
            quoteWidth * 72 * 1.65 / Math.max(1, quoteLayout.fontSize),
        )
        : quote;
    addBalancedText(ctx, balancedQuote, {
        x: 1.48,
        y: 1.42,
        w: quoteWidth,
        h: quoteHeight,
        fontFace: ctx.art.typography.heading,
        fontSize: quoteLayout.fontSize,
        bold: true,
        color: ctx.art.palette.text,
        align: slidePlan.imagePath && !fullBleed ? 'left' : 'center',
        valign: 'middle',
        italic: false,
    });
    if (supportingBody) {
        const supportLayout = boundedTextLayout(
            supportingBody,
            quoteWidth,
            0.7,
            bodySize(ctx, 17),
            bodySize(ctx, 13),
        );
        addBalancedText(ctx, supportingBody, {
            x: 1.48,
            y: 5.08,
            w: quoteWidth,
            h: 0.7,
            fontFace: ctx.art.typography.body,
            fontSize: supportLayout.fontSize,
            color: ctx.art.palette.muted,
            align: slidePlan.imagePath && !fullBleed ? 'left' : 'center',
            valign: 'middle',
        });
    }
    if (supportingBullets.length) {
        addBulletList(
            ctx,
            supportingBullets,
            1.48,
            supportingBody ? 5.82 : 5.16,
            quoteWidth,
            supportingBody ? 0.82 : 1.34,
            bodySize(ctx, 14),
            5,
            ctx.art.palette.muted,
        );
    }
    if (slidePlan.attribution) {
        addText(ctx, slidePlan.attribution, {
            x: 4.0,
            y: hasSupportingCopy ? 6.52 : 5.57,
            w: 5.35,
            h: 0.42,
            fontSize: bodySize(ctx, 16),
            color: ctx.art.palette.muted,
            align: 'center',
        });
    }
    addFooter(ctx);
}

function renderCenteredClosing(ctx: RenderContext, plan: PresentationDeckPlan, slidePlan: PresentationSlidePlan): void {
    if (slidePlan.imagePath) {
        const frame = resolvePresentationImageFrame(slidePlan, ctx.index)!;
        addImage(ctx, slidePlan.imagePath, slidePlan.imageAlt, frame.x, frame.y, frame.w, frame.h, slidePlan.imageMask);
    }
    const language = visualLanguage(ctx);
    if (language === 'precision') {
        ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
            x: 8.72, y: 0.78, w: 3.82, h: 5.92,
            line: { color: ctx.art.palette.surface, transparency: 100 },
            fill: { color: ctx.art.palette.surface },
        });
        ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
            x: 8.42, y: 0.78, w: 0.12, h: 5.92,
            line: { color: ctx.art.palette.accent, transparency: 100 },
            fill: { color: ctx.art.palette.accent },
        });
        addText(ctx, String(ctx.index + 1).padStart(2, '0'), {
            x: 9.18, y: 1.08, w: 2.78, h: 1.52,
            fontFace: ctx.art.typography.heading, fontSize: 82, bold: true,
            color: ctx.art.palette.accent, align: 'right',
        });
        addText(ctx, slidePlan.eyebrow || slidePlan.visualRole || 'NEXT', {
            x: marginX(ctx), y: 0.82, w: 3.2, h: 0.3,
            fontSize: bodySize(ctx, 11), bold: true, charSpacing: 1.5,
            color: ctx.art.palette.accent,
        });
        const title = slidePlan.title || slidePlan.message;
        const titleLayout = boundedTextLayout(title, 7.15, 2.85, titleSize(ctx, 49 * slidePlan.layout.focalScale), 34);
        addBalancedText(ctx, titleLayout.lines > 1 ? balancedTitleText(title) : title, {
            x: marginX(ctx), y: 1.42, w: 7.15, h: 2.85,
            fontFace: ctx.art.typography.heading, fontSize: titleLayout.fontSize,
            bold: true, color: ctx.art.palette.text, valign: 'middle',
        });
        const decision = slidePlan.body || plan.brief.desiredOutcome;
        if (decision) addText(ctx, decision, {
            x: marginX(ctx), y: 4.58, w: 6.95, h: 1.12,
            fontSize: bodySize(ctx, 18), color: ctx.art.palette.muted, valign: 'top',
        });
        if (slidePlan.bullets.length) {
            addBulletList(ctx, slidePlan.bullets.slice(0, 3), 9.02, 3.68, 3.12, 2.34, bodySize(ctx, 13.5), 8);
        }
        ctx.slide.addShape(ctx.pptx.ShapeType.line, {
            x: 9.18, y: 3.12, w: 2.62, h: 0,
            line: { color: ctx.art.palette.accent2, width: 5.2 },
        });
        addFooter(ctx);
        return;
    }
    addText(ctx, slidePlan.eyebrow || slidePlan.visualRole || 'NEXT', {
        x: 4.52,
        y: 1.02,
        w: 4.3,
        h: 0.3,
        fontSize: bodySize(ctx, 11),
        bold: true,
        charSpacing: 1.5,
        color: ctx.art.palette.accent,
        align: 'center',
    });
    const centeredClosingTitle = slidePlan.title || slidePlan.message;
    const centeredClosingLayout = boundedTextLayout(
        centeredClosingTitle,
        10.5,
        2.82,
        titleSize(ctx, 48 * slidePlan.layout.focalScale),
        32,
    );
    addBalancedText(ctx, centeredClosingLayout.lines > 1 ? balancedTitleText(centeredClosingTitle) : centeredClosingTitle, {
        x: 1.42,
        y: 1.48,
        w: 10.5,
        h: 2.82,
        fontFace: ctx.art.typography.heading,
        fontSize: centeredClosingLayout.fontSize,
        bold: true,
        color: ctx.art.palette.text,
        align: 'center',
        valign: 'middle',
    });
    const body = slidePlan.body || plan.brief.desiredOutcome;
    if (slidePlan.bullets.length) {
        addBulletList(ctx, slidePlan.bullets.slice(0, 3), 3.0, 4.38, 7.35, 1.48, bodySize(ctx, 14.5), 8);
    } else if (body) {
        addText(ctx, body, {
            x: 3.12,
            y: 4.48,
            w: 7.1,
            h: 1.05,
            fontSize: bodySize(ctx, 19),
            color: ctx.art.palette.muted,
            align: 'center',
            valign: 'top',
        });
    }
    ctx.slide.addShape(ctx.pptx.ShapeType.line, {
        x: 5.48,
        y: 5.92,
        w: 2.38,
        h: 0,
        line: { color: ctx.art.palette.accent2, width: 5.2 },
    });
    addFooter(ctx);
}

function renderClosing(ctx: RenderContext, plan: PresentationDeckPlan, slidePlan: PresentationSlidePlan): void {
    if (slidePlan.resolvedLayout.silhouette === 'closing-centered') {
        renderCenteredClosing(ctx, plan, slidePlan);
        return;
    }
    const language = visualLanguage(ctx);
    const closingTitle = slidePlan.title || slidePlan.message;
    const body = slidePlan.body || plan.brief.desiredOutcome;
    const closingImageFrame = slidePlan.imagePath
        ? resolvePresentationImageFrame(slidePlan, ctx.index)
        : undefined;
    const renderClosingImage = (): void => {
        if (!slidePlan.imagePath || !closingImageFrame) return;
        addImage(
            ctx,
            slidePlan.imagePath,
            slidePlan.imageAlt,
            closingImageFrame.x,
            closingImageFrame.y,
            closingImageFrame.w,
            closingImageFrame.h,
            slidePlan.imageMask,
        );
    };
    if (language === 'editorial') {
        const accentText = textOn(ctx, ctx.art.palette.accent);
        ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
            x: 0.14, y: 0, w: 3.12, h: SLIDE_H,
            line: { color: ctx.art.palette.accent, transparency: 100 },
            fill: { color: ctx.art.palette.accent },
        });
        renderClosingImage();
        addText(ctx, String(ctx.index + 1).padStart(2, '0'), {
            x: 0.58, y: 0.92, w: 2.12, h: 1.45,
            fontFace: ctx.art.typography.heading, fontSize: 80, bold: true, color: accentText,
        });
        addText(ctx, slidePlan.eyebrow || 'NEXT', {
            x: 0.62, y: 6.46, w: 1.8, h: 0.28,
            fontSize: 10, bold: true, charSpacing: 1.5, color: accentText,
        });
        const editorialTitleWidth = closingImageFrame ? 5.05 : 8.62;
        const titleLayout = boundedTextLayout(closingTitle, editorialTitleWidth, 3.0, titleSize(ctx, 48 * slidePlan.layout.focalScale), 34);
        addBalancedText(ctx, titleLayout.lines > 1 ? balancedTitleText(closingTitle) : closingTitle, {
            x: 3.78, y: 1.2, w: editorialTitleWidth, h: 3.0,
            fontFace: ctx.art.typography.heading, fontSize: titleLayout.fontSize,
            bold: true, color: ctx.art.palette.text, valign: 'middle',
        });
        if (body) addText(ctx, body, {
            x: 3.82, y: 4.62, w: closingImageFrame ? 4.92 : 7.35, h: 1.12,
            fontSize: bodySize(ctx, 18), color: ctx.art.palette.muted, valign: 'top',
        });
        ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
            x: 11.72, y: 4.42, w: 0.58, h: 1.78,
            line: { color: ctx.art.palette.accent2, transparency: 100 },
            fill: { color: ctx.art.palette.accent2 },
        });
        addFooter(ctx);
        return;
    }
    if (language === 'kinetic') {
        const accentText = textOn(ctx, ctx.art.palette.accent);
        ctx.slide.addShape(ctx.pptx.ShapeType.ellipse, {
            x: 9.05, y: 0.82, w: 3.52, h: 3.52,
            line: { color: ctx.art.palette.accent, transparency: 100 },
            fill: { color: ctx.art.palette.accent },
        });
        renderClosingImage();
        addText(ctx, 'GO', {
            x: 9.48, y: 1.82, w: 2.66, h: 1.02,
            fontFace: ctx.art.typography.heading, fontSize: 54, bold: true,
            color: accentText, align: 'center',
        });
        addText(ctx, slidePlan.eyebrow || 'NEXT', {
            x: marginX(ctx), y: 0.78, w: 3.2, h: 0.3,
            fontSize: bodySize(ctx, 11), bold: true, charSpacing: 1.5,
            color: ctx.art.palette.accent,
        });
        const titleLayout = boundedTextLayout(closingTitle, 7.72, 2.92, titleSize(ctx, 52 * slidePlan.layout.focalScale), 36);
        addBalancedText(ctx, titleLayout.lines > 1 ? balancedTitleText(closingTitle) : closingTitle, {
            x: marginX(ctx), y: 1.32, w: 7.72, h: 2.92,
            fontFace: ctx.art.typography.heading, fontSize: titleLayout.fontSize,
            bold: true, color: ctx.art.palette.text, valign: 'middle',
        });
        if (body) addText(ctx, body, {
            x: marginX(ctx), y: 4.56, w: 7.08, h: 1.16,
            fontSize: bodySize(ctx, 18.5), color: ctx.art.palette.muted, valign: 'top',
        });
        ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
            x: marginX(ctx), y: 6.02, w: 3.08, h: 0.12,
            line: { color: ctx.art.palette.accent2, transparency: 100 },
            fill: { color: ctx.art.palette.accent2 },
        });
        addFooter(ctx);
        return;
    }
    ctx.slide.addShape(ctx.pptx.ShapeType.ellipse, {
        // Keep decorative geometry inside the real slide canvas. PowerPoint
        // clips off-canvas shapes during ordinary viewing, but PDF/export and
        // strict delivery validators correctly treat them as overflow.
        x: 0,
        y: 5.22,
        w: 2.28,
        h: 2.28,
        line: { color: ctx.art.palette.accent, transparency: 100 },
        fill: { color: ctx.art.palette.accent, transparency: 8 },
    });
    renderClosingImage();
    addText(ctx, slidePlan.eyebrow || 'NEXT', {
        x: marginX(ctx),
        y: 0.9,
        w: 3.2,
        h: 0.3,
        fontSize: bodySize(ctx, 11),
        bold: true,
        charSpacing: 1.5,
        color: ctx.art.palette.accent,
    });
    const closingTitleLayout = boundedTextLayout(
        closingTitle,
        10.6,
        2.85,
        titleSize(ctx, 49 * slidePlan.layout.focalScale),
        32,
    );
    addBalancedText(ctx, closingTitleLayout.lines > 1 ? balancedTitleText(closingTitle) : closingTitle, {
        x: marginX(ctx),
        y: 1.42,
        w: 10.6,
        h: 2.85,
        fontFace: ctx.art.typography.heading,
        fontSize: closingTitleLayout.fontSize,
        bold: true,
        color: ctx.art.palette.text,
        valign: 'middle',
    });
    const hasClosingRail = slidePlan.bullets.length > 0 || slidePlan.items.length > 0;
    addBody(ctx, slidePlan.body, marginX(ctx), 4.52, hasClosingRail ? 7.35 : 9.0, 1.08);
    if (slidePlan.bullets.length) {
        addBulletList(ctx, slidePlan.bullets, 8.45, 3.86, 3.65, 2.28, bodySize(ctx, 15), 9);
    } else if (slidePlan.items.length) {
        renderFlatItems(ctx, slidePlan.items, 8.35, 4.05, 3.82, 1.62);
    } else if (plan.brief.desiredOutcome && !slidePlan.body) {
        addBody(ctx, plan.brief.desiredOutcome, marginX(ctx), 4.52, hasClosingRail ? 7.35 : 9.0, 1.08);
    }
    ctx.slide.addShape(ctx.pptx.ShapeType.line, {
        x: 9.72,
        y: slidePlan.bullets.length ? 6.32 : 5.74,
        w: 2.25,
        h: 0,
        line: { color: ctx.art.palette.accent2, width: 5.5 },
    });
    addFooter(ctx);
}

function addSpeakerNotes(slide: Slide, slidePlan: PresentationSlidePlan): void {
    const sections: string[] = [];
    if (slidePlan.speakerNotes) sections.push(slidePlan.speakerNotes);
    sections.push(`[Narrative purpose]\n${slidePlan.purpose}`);
    sections.push(`[Audience takeaway]\n${slidePlan.message}`);
    sections.push(`[Information role]\n${slidePlan.informationRole}`);
    if (slidePlan.relationshipToPrevious) {
        sections.push(`[Relationship to previous]\n${slidePlan.relationshipToPrevious}`);
    }
    sections.push(`[Visual intent]\n${slidePlan.composition} / ${slidePlan.layout.variant} / ${slidePlan.layout.emphasis}`
        + `\n[Resolved layout]\n${slidePlan.resolvedLayout.fingerprint}`
        + `\n${slidePlan.resolvedLayout.rationale}`
        + `${slidePlan.layout.rationale ? `\n${slidePlan.layout.rationale}` : ''}`);
    if (slidePlan.designNotes) sections.push(`[Design notes]\n${slidePlan.designNotes}`);
    if (slidePlan.sources.length) {
        sections.push(`[Sources]\n${slidePlan.sources.map(source => `- ${source}`).join('\n')}`);
    }
    slide.addNotes(sections.join('\n\n'));
}

interface PreparedImagesResult {
    assetDir?: string;
    issues: PresentationQualityIssue[];
    preparedImageCount: number;
}

function orientedDimensions(metadata: sharp.Metadata): { width: number; height: number } | undefined {
    if (!metadata.width || !metadata.height) return undefined;
    const swapsAxes = [5, 6, 7, 8].includes(metadata.orientation || 0);
    return swapsAxes
        ? { width: metadata.height, height: metadata.width }
        : { width: metadata.width, height: metadata.height };
}

export function resolvePresentationImageMask(
    slidePlan: PresentationSlidePlan,
    art: PresentationArtDirection,
): Exclude<PresentationSlidePlan['imageMask'], 'auto'> {
    if (slidePlan.imageMask !== 'auto') {
        if (['cover-full-bleed', 'quote-full-bleed'].includes(slidePlan.resolvedLayout.silhouette)) return 'none';
        return slidePlan.imageMask;
    }
    if (['background'].includes(slidePlan.imageKind)
        || ['cover-full-bleed', 'cover-split', 'image-split', 'image-panorama', 'quote-full-bleed'].includes(slidePlan.resolvedLayout.silhouette)) {
        return art.imageTreatment === 'soft-crop' && slidePlan.resolvedLayout.silhouette === 'image-panorama'
            ? 'soft-edge'
            : 'none';
    }
    if (['diagram', 'map', 'logo'].includes(slidePlan.imageKind)) return 'none';
    if (slidePlan.imageKind === 'screenshot') return 'rounded-rect';
    if (slidePlan.imageKind === 'photo'
        && /\b(?:portrait|headshot|avatar|profile)\b|人物|人像|头像|创始人|管理团队/i.test([
            slidePlan.imageAlt,
            slidePlan.visualRole,
            slidePlan.designNotes,
        ].filter(Boolean).join(' '))
        && ['image-window', 'closing-cta', 'closing-centered'].includes(slidePlan.resolvedLayout.silhouette)) {
        return 'circle';
    }
    if (art.imageTreatment === 'soft-crop') return 'soft-edge';
    if (art.imageTreatment === 'framed' || slidePlan.resolvedLayout.silhouette === 'image-window') return 'rounded-rect';
    return 'none';
}

async function applyPresentationImageMask(
    input: Buffer,
    width: number,
    height: number,
    mask: Exclude<PresentationSlidePlan['imageMask'], 'auto'>,
): Promise<Buffer> {
    if (mask === 'none') return input;
    const radius = Math.max(8, Math.round(Math.min(width, height) * 0.065));
    let body: string;
    if (mask === 'circle') {
        body = `<ellipse cx="${width / 2}" cy="${height / 2}" rx="${width / 2}" ry="${height / 2}" fill="white"/>`;
    } else if (mask === 'arch') {
        const cap = Math.max(radius * 2, Math.round(height * 0.24));
        body = `<ellipse cx="${width / 2}" cy="${cap}" rx="${width / 2}" ry="${cap}" fill="white"/><rect x="0" y="${cap}" width="${width}" height="${height - cap}" fill="white"/>`;
    } else if (mask === 'soft-edge') {
        const feather = Math.max(8, Math.round(Math.min(width, height) * 0.035));
        body = `<defs><filter id="f" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${feather}"/></filter></defs><rect x="${feather}" y="${feather}" width="${Math.max(1, width - feather * 2)}" height="${Math.max(1, height - feather * 2)}" rx="${feather}" ry="${feather}" fill="white" filter="url(#f)"/>`;
    } else {
        body = `<rect width="${width}" height="${height}" rx="${radius}" ry="${radius}" fill="white"/>`;
    }
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${body}</svg>`);
    return sharp(input)
        .composite([{ input: svg, blend: 'dest-in' }])
        .png()
        .toBuffer();
}

function coverCrop(
    sourceWidth: number,
    sourceHeight: number,
    targetRatio: number,
    focus: { x: number; y: number },
): { left: number; top: number; width: number; height: number; croppedFraction: number } {
    const sourceRatio = sourceWidth / sourceHeight;
    let width = sourceWidth;
    let height = sourceHeight;
    if (sourceRatio > targetRatio) width = Math.max(1, Math.round(sourceHeight * targetRatio));
    else if (sourceRatio < targetRatio) height = Math.max(1, Math.round(sourceWidth / targetRatio));
    const left = Math.max(0, Math.min(sourceWidth - width, Math.round((sourceWidth - width) * focus.x)));
    const top = Math.max(0, Math.min(sourceHeight - height, Math.round((sourceHeight - height) * focus.y)));
    return {
        left,
        top,
        width,
        height,
        croppedFraction: Math.max(0, 1 - (width * height) / (sourceWidth * sourceHeight)),
    };
}

function effectiveSourcePpi(
    sourceWidth: number,
    sourceHeight: number,
    frame: PresentationImageFrame,
    fit: PresentationSlidePlan['imageFit'],
    crop?: { width: number; height: number },
): number {
    if (fit === 'cover' && crop) return Math.min(crop.width / frame.w, crop.height / frame.h);
    const sourceRatio = sourceWidth / sourceHeight;
    const frameRatio = frame.w / frame.h;
    const displayedWidth = sourceRatio >= frameRatio ? frame.w : frame.h * sourceRatio;
    const displayedHeight = sourceRatio >= frameRatio ? frame.w / sourceRatio : frame.h;
    return Math.min(sourceWidth / displayedWidth, sourceHeight / displayedHeight);
}

async function prepareImagePaths(plan: PresentationDeckPlan, outputPath: string): Promise<PreparedImagesResult> {
    const plansWithImages = plan.slides
        .map((slide, index) => ({ slide, index }))
        .filter(item => Boolean(item.slide.imagePath));
    if (!plansWithImages.length) return { issues: [], preparedImageCount: 0 };
    const assetDir = join(dirname(outputPath), `.openflux-presentation-assets-${randomUUID()}`);
    await fs.mkdir(assetDir, { recursive: true });
    const issues: PresentationQualityIssue[] = [];
    let preparedImageCount = 0;
    try {
        for (let index = 0; index < plan.slides.length; index++) {
            const slidePlan = plan.slides[index];
            const imagePath = slidePlan.imagePath;
            if (!imagePath) continue;
            const resolvedMask = resolvePresentationImageMask(slidePlan, plan.artDirection);
            slidePlan.imageMask = resolvedMask;
            const frame = resolvePresentationImageFrame(slidePlan, index);
            if (!frame) {
                issues.push({
                    severity: 'error',
                    code: 'image_frame_unresolved',
                    slide: index + 1,
                    message: `The slide supplies an image, but its ${slidePlan.resolvedLayout.silhouette} composition has no image frame, so the picture has nowhere to sit. The image itself is fine: move it to a slide whose composition reserves room for one (${PRESENTATION_IMAGE_CAPABLE_SILHOUETTES.join(', ')}), or drop the image from this slide.`,
                });
                continue;
            }
            const stat = await fs.stat(imagePath).catch(() => undefined);
            if (!stat?.isFile()) throw new Error(`slides[${index}].image_path is not a readable file: ${imagePath}`);
            let metadata: sharp.Metadata;
            try {
                metadata = await sharp(imagePath, { limitInputPixels: 40_000_000, animated: false }).metadata();
            } catch (error) {
                throw new Error(`slides[${index}].image_path is not a supported presentation image: ${error instanceof Error ? error.message : String(error)}`);
            }
            const safeFormats = new Set(['png', 'jpeg', 'webp', 'gif', 'svg']);
            if (!metadata.format || !safeFormats.has(metadata.format)) {
                throw new Error(`slides[${index}].image_path format is not allowed; use PNG, JPEG, WebP, GIF, or SVG`);
            }
            const dimensions = orientedDimensions(metadata);
            if (!dimensions || dimensions.width * dimensions.height > 40_000_000) {
                throw new Error(`slides[${index}].image_path exceeds the 40 megapixel safety limit or has no intrinsic dimensions`);
            }

            const targetWidth = Math.max(1, Math.round(frame.w * IMAGE_OUTPUT_PPI));
            const targetHeight = Math.max(1, Math.round(frame.h * IMAGE_OUTPUT_PPI));
            const safePath = join(assetDir, `image-${index + 1}.png`);
            const pipeline = sharp(imagePath, { limitInputPixels: 40_000_000, animated: false }).rotate();
            let crop: ReturnType<typeof coverCrop> | undefined;
            let preparedBuffer: Buffer;
            if (slidePlan.imageFit === 'cover') {
                crop = coverCrop(
                    dimensions.width,
                    dimensions.height,
                    frame.w / frame.h,
                    slidePlan.imageFocus,
                );
                preparedBuffer = await pipeline
                    .extract({ left: crop.left, top: crop.top, width: crop.width, height: crop.height })
                    .resize(targetWidth, targetHeight, { fit: 'fill' })
                    .png()
                    .toBuffer();
                if (crop.croppedFraction > 0.35) {
                    issues.push({
                        severity: crop.croppedFraction > 0.55 ? 'error' : 'warning',
                        code: crop.croppedFraction > 0.55 ? 'image_visible_area_too_small' : 'image_crop_excessive',
                        slide: index + 1,
                        message: `Cover placement removes ${Math.round(crop.croppedFraction * 100)}% of the source image; reconsider the frame or focal point.`,
                    });
                }
            } else {
                preparedBuffer = await pipeline
                    .resize(targetWidth, targetHeight, {
                        fit: 'contain',
                        position: 'centre',
                        background: { r: 0, g: 0, b: 0, alpha: 0 },
                    })
                    .png()
                    .toBuffer();
            }

            preparedBuffer = await applyPresentationImageMask(
                preparedBuffer,
                targetWidth,
                targetHeight,
                resolvedMask,
            );
            await fs.writeFile(safePath, preparedBuffer);

            // SVG dimensions describe its coordinate system, not a finite
            // pixel budget. Sharp rasterizes it directly at the target size,
            // so applying bitmap PPI thresholds produces false failures.
            if (metadata.format !== 'svg') {
                const ppi = effectiveSourcePpi(
                    dimensions.width,
                    dimensions.height,
                    frame,
                    slidePlan.imageFit,
                    crop,
                );
                if (ppi < IMAGE_WARNING_PPI) {
                    issues.push({
                        severity: ppi < IMAGE_ERROR_PPI ? 'error' : 'warning',
                        code: ppi < IMAGE_ERROR_PPI ? 'image_resolution_too_low' : 'image_resolution_low',
                        slide: index + 1,
                        message: `The source image provides about ${Math.round(ppi)} PPI at its displayed size; use a higher-resolution asset.`,
                    });
                }
            }
            plan.slides[index].imagePath = safePath;
            preparedImageCount += 1;
        }
        return { assetDir, issues, preparedImageCount };
    } catch (error) {
        await fs.rm(assetDir, { recursive: true, force: true }).catch(() => undefined);
        throw error;
    }
}

export interface RenderPresentationOptions {
    /** Per-box geometry adjustments learned from a previous native QA pass. */
    textFit?: PresentationTextFitOverrides;
}

export async function renderPresentation(
    plan: PresentationDeckPlan,
    outputPath: string,
    renderOptions: RenderPresentationOptions = {},
): Promise<RenderPresentationResult> {
    const unsupported = evaluatePresentationPlan(plan)
        .filter(issue => ['layout_capacity_exceeded', 'mixed_content_channels'].includes(issue.code));
    if (unsupported.length) {
        const first = unsupported[0];
        throw new Error(`Presentation capacity planning was skipped for slide ${first.slide || '?'}: ${first.message}`);
    }
    const preparedImages = await prepareImagePaths(plan, outputPath);
    try {
    // tsx/esbuild may expose this CommonJS package as { default: ctor }, while
    // native Node ESM exposes the constructor directly. Support both runtimes.
    const PptxConstructor = ((PptxGenJS as any).default || PptxGenJS) as typeof PptxGenJS;
    const pptx = new PptxConstructor();
    pptx.layout = 'LAYOUT_WIDE';
    pptx.author = 'OpenFlux';
    pptx.company = 'OpenFlux';
    pptx.subject = plan.brief.purpose;
    pptx.title = plan.brief.title;
    pptx.theme = {
        headFontFace: plan.artDirection.typography.heading,
        bodyFontFace: plan.artDirection.typography.body,
    };

    plan.slides.forEach((slidePlan, index) => {
        const slide = pptx.addSlide();
        const ctx: RenderContext = {
            pptx,
            slide,
            art: artForSurfaceRole(plan.artDirection, slidePlan.resolvedLayout.surfaceRole),
            index,
            total: plan.slides.length,
            textOrdinal: 0,
            textFit: renderOptions.textFit,
        };
        addBackground(ctx);
        switch (slidePlan.resolvedLayout.silhouette) {
            case 'cover-split':
            case 'cover-centered':
            case 'cover-full-bleed':
                renderFocal(ctx, plan, slidePlan);
                break;
            case 'section-divider':
                renderSectionDivider(ctx, slidePlan);
                break;
            case 'image-split':
                renderSplit(ctx, slidePlan);
                break;
            case 'image-window':
            case 'semantic-stage':
                renderImageWindow(ctx, slidePlan);
                break;
            case 'image-panorama':
                renderImagePanorama(ctx, slidePlan);
                break;
            case 'process-horizontal':
            case 'process-stacked':
            case 'milestone-timeline':
                renderSequence(ctx, slidePlan);
                break;
            case 'collection-columns':
            case 'collection-mosaic':
            case 'collection-list':
            case 'collection-list-banded':
            case 'event-ledger':
            case 'source-index':
                renderGrid(ctx, slidePlan);
                break;
            case 'metric-spotlight':
            case 'metric-scoreboard':
            case 'status-dashboard':
                renderMetrics(ctx, slidePlan);
                break;
            case 'chart-editorial':
            case 'ranking-bars':
                renderChart(ctx, slidePlan);
                break;
            case 'comparison-split':
            case 'comparison-cards':
                renderComparison(ctx, slidePlan);
                break;
            case 'quote-stage':
            case 'quote-full-bleed':
                renderQuote(ctx, slidePlan);
                break;
            case 'closing-centered':
            case 'closing-cta':
                renderClosing(ctx, plan, slidePlan);
                break;
            case 'editorial-aside':
            case 'editorial-banded':
            case 'editorial-columns':
            default:
                renderNarrative(ctx, slidePlan);
                break;
        }
        addSpeakerNotes(slide, slidePlan);
    });

    await pptx.writeFile({ fileName: outputPath, compression: true });
    return {
        slideCount: plan.slides.length,
        compositions: plan.slides.map(slide => slide.composition),
        layouts: plan.slides.map(slide => slide.resolvedLayout.fingerprint),
        imageIssues: preparedImages.issues,
        preparedImageCount: preparedImages.preparedImageCount,
    };
    } finally {
        if (preparedImages.assetDir) await fs.rm(preparedImages.assetDir, { recursive: true, force: true }).catch(() => undefined);
    }
}
