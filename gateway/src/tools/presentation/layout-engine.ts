/** Deck-wide presentation layout planning.
 *
 * The content model chooses semantic intent. This engine resolves that intent
 * into a concrete page skeleton while protecting the rhythm of the whole deck.
 * It is deliberately deterministic so revisions and QA can compare layouts.
 */

import type {
    PresentationDeckPlan,
    PresentationLayoutFamily,
    PresentationLayoutSilhouette,
    PresentationSlidePlan,
} from './model';
import { fitsPresentationStackedCollection, isCompactCollection } from './capacity';

interface Candidate {
    silhouette: PresentationLayoutSilhouette;
    base: number;
    why: string;
}

export interface PresentationLayoutSequenceSummary {
    fingerprints: string[];
    families: PresentationLayoutFamily[];
    silhouettes: PresentationLayoutSilhouette[];
    distinctFamilies: number;
    distinctSilhouettes: number;
    adjacentDuplicates: number;
    longestFamilyRun: number;
    longestSilhouetteRun: number;
    dominantSilhouetteShare: number;
    surfaceRoles: Array<'base' | 'surface'>;
    distinctSurfaceRoles: number;
    longestSurfaceRun: number;
}

function semanticText(slide: PresentationSlidePlan): string {
    return [slide.purpose, slide.message, slide.title, slide.eyebrow, slide.visualRole]
        .filter(Boolean)
        .join(' ');
}

function hasSectionLanguage(slide: PresentationSlidePlan): boolean {
    return /(?:章节|章页|转场|过渡|篇章|赛道|板块|part\s*\d|section|chapter)/i.test(semanticText(slide));
}

function hasCoverLanguage(slide: PresentationSlidePlan): boolean {
    return /(?:封面|开场|标题页|cover|opening|title slide)/i.test(semanticText(slide));
}

function visibleContentWeight(slide: PresentationSlidePlan): number {
    return (slide.body?.length || 0)
        + slide.bullets.join('').length
        + slide.items.reduce((sum, item) => sum + item.title.length + (item.description?.length || 0), 0)
        + slide.steps.reduce((sum, step) => sum + step.title.length + (step.description?.length || 0), 0)
        + slide.metrics.reduce((sum, metric) => sum + metric.value.length + metric.label.length, 0);
}

function visualTextUnits(value: string): number {
    return Array.from(value).reduce((sum, character) => (
        sum + (/[^\x00-\xff]/.test(character) ? 2 : 1)
    ), 0);
}

export function inferPresentationLayoutFamily(
    slide: PresentationSlidePlan,
    index: number,
    total: number,
): PresentationLayoutFamily {
    // Cover/section/closing are intentional narrative boundaries. Within the
    // body of a deck, structured content is a harder constraint than a style
    // preference: a chart, metric, process, comparison, quote, or collection
    // must never disappear because a direction requested an incompatible
    // editorial silhouette.
    if (['cover', 'section'].includes(slide.layout.archetype)) {
        return slide.layout.archetype as PresentationLayoutFamily;
    }
    const hasStructuredContent = Boolean(slide.chart || slide.metrics.length || slide.comparison
        || slide.steps.length || slide.quote || slide.items.length >= 2);
    if (index === 0 && !hasStructuredContent && (slide.composition === 'focal' || hasCoverLanguage(slide))) {
        return 'cover';
    }
    if (slide.chart || slide.metrics.length) return 'evidence';
    if (slide.comparison) return 'comparison';
    if (slide.informationRole === 'events' && (slide.items.length || slide.steps.length)) return 'collection';
    if (slide.informationRole === 'sources' && slide.items.length) return 'collection';
    if (slide.steps.length) return 'process';
    if (slide.quote) return 'quote';
    if (slide.items.length >= 2) return 'collection';
    // A closing archetype is a narrative boundary, not permission to discard
    // structured content. Resolve quote/chart/metric/process/comparison slides
    // above, then use the closing renderer for ordinary CTA copy and lists.
    if (slide.layout.archetype === 'closing') return 'closing';
    if (slide.layout.archetype !== 'auto') return slide.layout.archetype as PresentationLayoutFamily;
    if (slide.composition === 'closing'
        || (index === total - 1 && /(?:结语|结束|联系|合作|行动|下一步|closing|contact|next step)/i.test(semanticText(slide)))) {
        return 'closing';
    }
    if (slide.composition === 'quote') return 'quote';
    if (hasSectionLanguage(slide) && visibleContentWeight(slide) < 90) return 'section';
    if (slide.composition === 'comparison') return 'comparison';
    if (slide.composition === 'sequence') return 'process';
    if (slide.composition === 'data' || slide.chart || slide.metrics.length) return 'evidence';
    if (slide.imagePath) return 'image';
    if (slide.composition === 'grid' || slide.items.length >= 2) return 'collection';
    return 'editorial';
}

function candidatesFor(slide: PresentationSlidePlan, family: PresentationLayoutFamily): Candidate[] {
    switch (family) {
        case 'cover':
            return slide.imagePath ? [
                { silhouette: 'cover-split', base: slide.imageAspectRatio && slide.imageAspectRatio < 1.15 ? 14 : 11, why: 'brand claim paired with a decisive visual field' },
                { silhouette: 'cover-full-bleed', base: slide.imageAspectRatio && slide.imageAspectRatio >= 1.35 ? 15 : 10, why: 'immersive opening image with overlaid claim' },
                { silhouette: 'cover-centered', base: 5, why: 'minimal centered opening' },
            ] : [{ silhouette: 'cover-centered', base: 12, why: 'minimal centered opening without a supplied visual' }];
        case 'section':
            return [{ silhouette: 'section-divider', base: 12, why: 'low-density chapter transition' }];
        case 'image':
            if (['diagram', 'map', 'logo', 'screenshot'].includes(slide.imageKind)) {
                return [{ silhouette: 'semantic-stage', base: 14, why: 'uncropped semantic visual with a dedicated explanation field' }];
            }
            const ratio = slide.imageAspectRatio;
            return [
                { silhouette: 'image-split', base: ratio && ratio >= 0.9 && ratio < 1.35 ? 14 : 9, why: 'photographic evidence balanced with a claim' },
                { silhouette: 'image-window', base: ratio && ratio < 0.9 ? 16 : ratio && ratio < 1.9 ? 11 : 8, why: 'editorial image window sized to the source aspect ratio' },
                { silhouette: 'image-panorama', base: ratio && ratio >= 1.9 ? 17 : ratio && ratio >= 1.35 ? 13 : 7, why: 'wide cinematic image band for a landscape source' },
            ];
        case 'evidence':
            if (slide.chart) return slide.informationRole === 'ranking'
                ? [{ silhouette: 'ranking-bars', base: 18, why: 'ordered evidence with a reading rail' }]
                : [{ silhouette: 'chart-editorial', base: 14, why: 'editable chart with a reading column' }];
            if (slide.metrics.length) return [
                { silhouette: 'status-dashboard', base: slide.informationRole === 'status' && slide.metrics.length >= 2 ? 18 : 5, why: 'executive status signals with equal visual weight' },
                { silhouette: 'metric-spotlight', base: slide.informationRole === 'status' && slide.metrics.length === 1 ? 15 : slide.bullets.length ? 6 : slide.metrics.length ? 11 : 6, why: 'one hero number with supporting evidence' },
                { silhouette: 'metric-scoreboard', base: slide.informationRole === 'status' || slide.metrics.length >= 3 || slide.bullets.length ? 13 : 7, why: 'flat multi-metric scoreboard with a bounded insight rail' },
            ];
            return [{ silhouette: 'editorial-aside', base: 10, why: 'evidence stated as an editorial claim' }];
        case 'process':
            const longestStepTitle = Math.max(0, ...slide.steps.map(step => step.title.length));
            return [
                { silhouette: 'milestone-timeline', base: slide.informationRole === 'timeline' && slide.steps.length <= 5 ? 18 : 5, why: 'milestones arranged as an explicit time or dependency sequence' },
                { silhouette: 'process-horizontal', base: longestStepTitle > 18 ? 2 : slide.body || slide.bullets.length ? 7 : slide.steps.length <= 5 ? 12 : 7, why: 'left-to-right audience journey' },
                { silhouette: 'process-stacked', base: longestStepTitle > 18 ? 19 : slide.body || slide.bullets.length ? 15 : slide.steps.length >= 4 ? 11 : 8, why: 'vertical progression with explanatory space and a bounded narrative rail' },
            ];
        case 'collection':
            if (isCompactCollection(slide.items as unknown as Array<Record<string, unknown>>)) {
                return [
                    { silhouette: 'event-ledger', base: slide.informationRole === 'events' ? 20 : 4, why: 'dense but readable ledger of peer events or records' },
                    { silhouette: 'source-index', base: slide.informationRole === 'sources' ? 20 : 4, why: 'traceable index of evidence sources' },
                    { silhouette: 'collection-list', base: slide.informationRole === 'sources' ? 13 : 16, why: 'two-column reading list for short, complete records' },
                    { silhouette: 'collection-list-banded', base: ['events', 'sources'].includes(slide.informationRole) ? 18 : 16, why: 'banded two-column ledger for short, complete records' },
                ];
            }
            if (fitsPresentationStackedCollection(slide.items as unknown as Array<Record<string, unknown>>)) {
                return [
                    { silhouette: 'collection-list', base: 20, why: 'three complete peer records in a full-width stacked reading field' },
                    { silhouette: 'collection-list-banded', base: 14, why: 'three complete peer records separated by restrained horizontal bands' },
                    { silhouette: 'collection-columns', base: 3, why: 'columns remain available only when deck rhythm requires them' },
                ];
            }
            return [
                { silhouette: 'collection-columns', base: 11, why: 'flat editorial columns without dashboard chrome' },
                { silhouette: 'collection-mosaic', base: slide.items.length >= 3 ? 10 : 7, why: 'asymmetric collection with one dominant item' },
            ];
        case 'comparison':
            return [
                { silhouette: 'comparison-split', base: 12, why: 'direct two-sided comparison' },
                { silhouette: 'comparison-cards', base: 8, why: 'contained comparison when the content needs separation' },
            ];
        case 'quote':
            return slide.imagePath ? [
                { silhouette: 'quote-full-bleed', base: 12, why: 'statement over an immersive visual' },
                { silhouette: 'quote-stage', base: 9, why: 'typographic statement stage' },
            ] : [{ silhouette: 'quote-stage', base: 12, why: 'typographic statement stage' }];
        case 'closing':
            return [
                { silhouette: 'closing-cta', base: slide.body || slide.bullets.length || slide.items.length ? 14 : 10, why: 'action-oriented close with next-step content' },
                { silhouette: 'closing-centered', base: 8, why: 'minimal brand close' },
            ];
        case 'editorial':
        default:
            const needsWideReadingField = slide.bullets.length >= 2
                || visualTextUnits(slide.body || '') + visualTextUnits(slide.bullets.join('')) > 120;
            return [
                { silhouette: 'editorial-aside', base: needsWideReadingField ? 2 : 11, why: 'large assertion with a narrow evidence rail' },
                { silhouette: 'editorial-banded', base: needsWideReadingField ? 14 : 9, why: 'chapter-like title band with explanatory field' },
                { silhouette: 'editorial-columns', base: needsWideReadingField ? 20 : 10, why: 'flat editorial columns with a wide reading field' },
            ];
    }
}

function legacyPreference(slide: PresentationSlidePlan, silhouette: PresentationLayoutSilhouette): number {
    const variant = slide.layout.variant;
    if (variant === 'full-bleed' && /full-bleed|panorama/.test(silhouette)) return 18;
    if (variant === 'centered' && /centered|stage/.test(silhouette)) return 16;
    if (variant === 'editorial' && /editorial|window/.test(silhouette)) return 14;
    if (variant === 'asymmetric' && /aside|window|mosaic|stacked/.test(silhouette)) return 14;
    if (variant === 'banded' && /banded|panorama/.test(silhouette)) return 16;
    if (variant === 'stacked' && /stacked|collection-list|editorial-columns/.test(silhouette)) return 18;
    if (variant === 'spotlight' && /spotlight/.test(silhouette)) return 18;
    // "cards" means equal-weight peers. A mosaic deliberately promotes one
    // item, which made four-item schedules oscillate in visual review.
    if (variant === 'cards' && /cards|columns|list/.test(silhouette)) return 14;
    return 0;
}

function chooseImageSide(
    slide: PresentationSlidePlan,
    index: number,
    priorSides: Array<'left' | 'right'>,
): 'left' | 'right' {
    if (slide.layout.imagePosition === 'left' || slide.layout.imagePosition === 'right') {
        return slide.layout.imagePosition;
    }
    const previous = priorSides[priorSides.length - 1];
    if (previous) return previous === 'left' ? 'right' : 'left';
    return index % 2 === 0 ? 'left' : 'right';
}

function fingerprint(
    family: PresentationLayoutFamily,
    silhouette: PresentationLayoutSilhouette,
    slide: PresentationSlidePlan,
): string {
    const side = slide.imagePath && ['image-split', 'image-window', 'semantic-stage'].includes(silhouette)
        ? `:${slide.layout.imagePosition}`
        : '';
    // Different native chart geometries are materially different page
    // skeletons. Preserve the chart type in the fingerprint so a bar, line,
    // and pie sequence is not misreported as three identical layouts.
    const content = slide.chart ? `:chart-${slide.chart.type}`
        : slide.metrics.length ? `:m${Math.min(4, slide.metrics.length)}`
            : slide.items.length ? `:i${Math.min(10, slide.items.length)}`
                : slide.steps.length ? `:s${Math.min(6, slide.steps.length)}`
                    : '';
    return `${family}/${silhouette}${side}${content}`;
}

/** Resolve every page together so local template choices produce an intentional
 * deck rhythm instead of independent, repetitive decisions. */
export function planPresentationLayouts(plan: PresentationDeckPlan): PresentationDeckPlan {
    const usage = new Map<PresentationLayoutSilhouette, number>();
    const selected: PresentationLayoutSilhouette[] = [];
    const families: PresentationLayoutFamily[] = [];
    const imageSides: Array<'left' | 'right'> = [];

    plan.slides.forEach((slide, index) => {
        const family = inferPresentationLayoutFamily(slide, index, plan.slides.length);
        const candidates = candidatesFor(slide, family);
        const previous = selected[index - 1];
        const twoBack = selected[index - 2];
        const previousFamily = families[index - 1];
        const twoBackFamily = families[index - 2];
        const chosen = [...candidates].sort((left, right) => {
            const score = (candidate: Candidate): number => {
                let value = candidate.base + legacyPreference(slide, candidate.silhouette);
                value -= (usage.get(candidate.silhouette) || 0) * 2.4;
                if (candidate.silhouette === previous) value -= 22;
                if (candidate.silhouette === previous && candidate.silhouette === twoBack) value -= 80;
                if (family === previousFamily && family === twoBackFamily && candidates.length > 1) value -= 7;
                return value;
            };
            return score(right) - score(left)
                || left.silhouette.localeCompare(right.silhouette);
        })[0];

        if (slide.imagePath && ['image-split', 'image-window', 'semantic-stage'].includes(chosen.silhouette)) {
            const side = chooseImageSide(slide, index, imageSides);
            slide.layout.imagePosition = side;
            imageSides.push(side);
        }
        slide.resolvedLayout = {
            family,
            silhouette: chosen.silhouette,
            surfaceRole: family === 'cover' || family === 'closing' || family === 'image'
                ? 'base'
                : index % 2 === 1 ? 'surface' : 'base',
            fingerprint: fingerprint(family, chosen.silhouette, slide),
            rationale: chosen.why,
        };
        usage.set(chosen.silhouette, (usage.get(chosen.silhouette) || 0) + 1);
        selected.push(chosen.silhouette);
        families.push(family);
    });
    return plan;
}

function longestRun<T>(values: T[]): number {
    let longest = values.length ? 1 : 0;
    let current = longest;
    for (let index = 1; index < values.length; index++) {
        current = values[index] === values[index - 1] ? current + 1 : 1;
        longest = Math.max(longest, current);
    }
    return longest;
}

export function summarizePresentationLayouts(plan: PresentationDeckPlan): PresentationLayoutSequenceSummary {
    const fingerprints = plan.slides.map(slide => slide.resolvedLayout.fingerprint);
    const families = plan.slides.map(slide => slide.resolvedLayout.family);
    const silhouettes = plan.slides.map(slide => slide.resolvedLayout.silhouette);
    const counts = new Map<PresentationLayoutSilhouette, number>();
    silhouettes.forEach(value => counts.set(value, (counts.get(value) || 0) + 1));
    const dominant = Math.max(0, ...counts.values());
    const surfaceRoles = plan.slides.map(slide => slide.resolvedLayout.surfaceRole);
    return {
        fingerprints,
        families,
        silhouettes,
        distinctFamilies: new Set(families).size,
        distinctSilhouettes: new Set(silhouettes).size,
        adjacentDuplicates: fingerprints.filter((value, index) => index > 0 && value === fingerprints[index - 1]).length,
        longestFamilyRun: longestRun(families),
        longestSilhouetteRun: longestRun(silhouettes),
        dominantSilhouetteShare: silhouettes.length ? dominant / silhouettes.length : 0,
        surfaceRoles,
        distinctSurfaceRoles: new Set(surfaceRoles).size,
        longestSurfaceRun: longestRun(surfaceRoles),
    };
}
