/** Design-first data model for locally generated presentations. */

import { planPresentationLayouts, summarizePresentationLayouts } from './layout-engine';
import {
    CARD_COLLECTION_CAPACITY,
    CHART_NARRATIVE_BULLET_MAX_UNITS,
    CHART_NARRATIVE_RAIL_MAX_UNITS,
    COMPARISON_SIDE_CAPACITY,
    COMPACT_COLLECTION_CAPACITY,
    fitsPresentationStackedCollection,
    fitsPresentationHeaderRail,
    fitsPresentationNarrativeRail,
    isCompactCollection,
    PROCESS_CAPACITY,
} from './capacity';

export type PresentationDensity = 'airy' | 'balanced' | 'compact';
export type PresentationDeliveryMode = 'marketing' | 'report' | 'reference';
export type PresentationVisualLanguage = 'precision' | 'editorial' | 'kinetic';

export const MAX_PRESENTATION_REVISIONS = 2;
/** A mechanically valid deck is still a draft. These thresholds deliberately
 * reserve delivery for work that also has a coherent theme, purposeful
 * composition, and a recognisable visual point of view. */
export const PRESENTATION_DIRECTION_SCORE_THRESHOLD = 4.1;
export const PRESENTATION_DECK_SCORE_THRESHOLD = 4.35;
export const PRESENTATION_SLIDE_SCORE_THRESHOLD = 4.1;
export const PRESENTATION_THEME_SCORE_THRESHOLD = 4.0;
export const PRESENTATION_ORIGINALITY_SCORE_THRESHOLD = 4.0;

export type PresentationWorkflowStage = 'sample' | 'final' | 'review' | 'revision';
export type PresentationWorkflowMode = 'auto' | 'confirm';
export type PresentationLayoutVariant =
    | 'auto'
    | 'editorial'
    | 'asymmetric'
    | 'centered'
    | 'full-bleed'
    | 'cards'
    | 'banded'
    | 'stacked'
    | 'spotlight';

/** Semantic page family. The model may express this intent, but the layout
 * engine owns the concrete geometry and deck-wide rhythm. */
export type PresentationLayoutArchetype =
    | 'auto'
    | 'cover'
    | 'section'
    | 'editorial'
    | 'image'
    | 'evidence'
    | 'process'
    | 'collection'
    | 'comparison'
    | 'quote'
    | 'closing';

export type PresentationLayoutFamily = Exclude<PresentationLayoutArchetype, 'auto'>;

export type PresentationLayoutSilhouette =
    | 'cover-split'
    | 'cover-centered'
    | 'cover-full-bleed'
    | 'section-divider'
    | 'editorial-aside'
    | 'editorial-banded'
    | 'editorial-columns'
    | 'image-split'
    | 'image-window'
    | 'image-panorama'
    | 'semantic-stage'
    | 'metric-spotlight'
    | 'metric-scoreboard'
    | 'status-dashboard'
    | 'chart-editorial'
    | 'ranking-bars'
    | 'process-horizontal'
    | 'process-stacked'
    | 'milestone-timeline'
    | 'collection-columns'
    | 'collection-mosaic'
    | 'collection-list'
    | 'collection-list-banded'
    | 'event-ledger'
    | 'source-index'
    | 'comparison-split'
    | 'comparison-cards'
    | 'quote-stage'
    | 'quote-full-bleed'
    | 'closing-centered'
    | 'closing-cta';

export interface PresentationResolvedLayout {
    family: PresentationLayoutFamily;
    silhouette: PresentationLayoutSilhouette;
    /** Automatic theme surface used to create deck-wide rhythm without asking
     * the user to configure per-slide colors. */
    surfaceRole: 'base' | 'surface';
    /** Stable, machine-verifiable description of the page skeleton. */
    fingerprint: string;
    rationale: string;
}

export type PresentationComposition =
    | 'focal'
    | 'narrative'
    | 'split'
    | 'sequence'
    | 'grid'
    | 'data'
    | 'comparison'
    | 'quote'
    | 'closing';

/** Domain-neutral information semantics. A match, order, and incident can all
 * be an event; the layout engine never needs industry-specific keywords. */
export type PresentationInformationRole =
    | 'claim'
    | 'status'
    | 'evidence'
    | 'events'
    | 'ranking'
    | 'timeline'
    | 'comparison'
    | 'collection'
    | 'sources'
    | 'action';

export type PresentationImageFit = 'cover' | 'contain';
export type PresentationImageKind = 'photo' | 'background' | 'diagram' | 'map' | 'logo' | 'screenshot';
export type PresentationImageMask = 'auto' | 'none' | 'rounded-rect' | 'circle' | 'arch' | 'soft-edge';

export interface PresentationImageFocus {
    /** Horizontal focal point from 0 (left) to 1 (right). */
    x: number;
    /** Vertical focal point from 0 (top) to 1 (bottom). */
    y: number;
}

export interface PresentationBrief {
    title: string;
    subtitle?: string;
    audience: string;
    purpose: string;
    desiredOutcome: string;
    language?: string;
    /** Marketing decks curate the source into an audience-facing story instead
     * of preserving every source paragraph on visible slides. */
    deliveryMode: PresentationDeliveryMode;
    /** One-sentence content-director contract for the deck. */
    communicationJob?: string;
    /** Cumulative story beats, not a topic inventory or agenda. */
    narrativeArc: string[];
    /** Exact final slide count when the user explicitly requests one. */
    requestedSlideCount?: number;
}

export interface PresentationPalette {
    background: string;
    surface: string;
    text: string;
    muted: string;
    accent: string;
    accent2: string;
}

export interface PresentationTypography {
    heading: string;
    body: string;
    titleScale: number;
    bodyScale: number;
}

export interface PresentationGrid {
    columns: number;
    margin: number;
    gutter: number;
}

export interface PresentationArtDirection {
    mood: string;
    rationale?: string;
    imageStyle?: string;
    /** Theme-level composition grammar authored by the Presentation Agent.
     * Users never need to configure this directly; sampled directions supply
     * a durable visual language that the renderer can express consistently. */
    visualLanguage: PresentationVisualLanguage;
    designConcept?: string;
    signatureElement?: 'axis' | 'cutout' | 'pulse' | 'frame' | 'orbit';
    density: PresentationDensity;
    palette: PresentationPalette;
    typography: PresentationTypography;
    spacing: 'tight' | 'balanced' | 'generous';
    motif: 'none' | 'line' | 'frame' | 'orbit' | 'blocks';
    backgroundTreatment: 'solid' | 'tonal' | 'contrast';
    imageTreatment: 'natural' | 'full-bleed' | 'framed' | 'soft-crop';
    chartStyle: 'minimal' | 'editorial' | 'bold';
    grid: PresentationGrid;
    designPrinciples: string[];
    referenceSummary?: string;
    avoid: string[];
}

export interface PresentationLayoutIntent {
    archetype: PresentationLayoutArchetype;
    variant: PresentationLayoutVariant;
    emphasis: 'message' | 'visual' | 'data' | 'balanced';
    alignment: 'left' | 'center' | 'right';
    imagePosition: 'auto' | 'left' | 'right' | 'background' | 'top' | 'bottom';
    whitespace: 'compact' | 'balanced' | 'generous';
    focalScale: number;
    rationale?: string;
}

export interface PresentationVisualReviewIssue {
    slide: number;
    severity: 'warning' | 'error';
    category: 'hierarchy' | 'composition' | 'typography' | 'theme' | 'originality'
        | 'spacing' | 'alignment' | 'density' | 'imagery' | 'consistency' | 'rhythm' | 'narrative' | 'other';
    observation: string;
    action: string;
}

export interface PresentationVisualScorecard {
    hierarchy: number;
    composition: number;
    typography: number;
    theme: number;
    originality: number;
}

export interface PresentationVisualReview {
    summary?: string;
    strengths: string[];
    issues: PresentationVisualReviewIssue[];
    /** Explicit evidence that every returned review sheet and slide was inspected. */
    reviewedSlideNumbers: number[];
    /** Separate aesthetic dimensions prevent mechanical cleanliness from being
     * misreported as design quality. */
    scorecard?: PresentationVisualScorecard;
    /** Current-model visual quality score. Delivery requires >= 4.35. */
    overallScore?: number;
    /** Current-model score for every slide. Each slide requires >= 4.1. */
    slideScores: Array<{ slide: number; total: number }>;
}

export interface PresentationDirectionReview {
    summary?: string;
    selectedDirectionId: string;
    reviewedDirectionIds: string[];
    scores: Array<{ id: string; total: number; rationale?: string }>;
}

export interface PresentationWorkflow {
    stage: PresentationWorkflowStage;
    mode: PresentationWorkflowMode;
    designId?: string;
    sampleApproved: boolean;
    sampleSlideNumbers: number[];
    directionReview?: PresentationDirectionReview;
    visualReview?: PresentationVisualReview;
}

export interface PresentationMetric {
    value: string;
    label: string;
    description?: string;
}

export interface PresentationStep {
    title: string;
    description?: string;
}

export interface PresentationItem {
    title: string;
    description?: string;
}

export interface PresentationComparisonSide {
    heading: string;
    items: string[];
}

export const PRESENTATION_CHART_TYPES = [
    'bar', 'column', 'line', 'pie',
    'stacked-bar', 'stacked-column', 'area', 'doughnut', 'combo', 'waterfall',
    'scatter', 'bubble', 'radar', 'histogram',
    'heatmap', 'treemap', 'funnel', 'gantt',
] as const;

export type PresentationChartType = typeof PRESENTATION_CHART_TYPES[number];

export interface PresentationChartSeries {
    name: string;
    values: number[];
}

export interface PresentationChart {
    type: PresentationChartType;
    name?: string;
    labels: string[];
    values: number[];
    /** Multiple comparable series for stacked and combination charts. */
    series?: PresentationChartSeries[];
    /** Numeric horizontal coordinates for scatter and bubble relationships. */
    xValues?: number[];
    /** Relative point magnitude for bubble charts. */
    sizes?: number[];
    /** Two-dimensional intensity values for heatmaps. */
    matrix?: number[][];
    rowLabels?: string[];
    columnLabels?: string[];
    /** Optional parent label for each treemap node. Empty means root. */
    parents?: string[];
    /** Start offset for every Gantt task. values stores task duration. */
    startValues?: number[];
}

export interface PresentationSlidePlan {
    /** Why this slide exists in the narrative. Kept in notes, never rendered as planning copy. */
    purpose: string;
    /** The single claim the audience should remember. Used as the default audience-facing title. */
    message: string;
    informationRole: PresentationInformationRole;
    relationshipToPrevious?: string;
    title?: string;
    eyebrow?: string;
    composition: PresentationComposition;
    layout: PresentationLayoutIntent;
    resolvedLayout: PresentationResolvedLayout;
    visualRole?: string;
    designNotes?: string;
    body?: string;
    bullets: string[];
    items: PresentationItem[];
    metrics: PresentationMetric[];
    steps: PresentationStep[];
    comparison?: {
        left: PresentationComparisonSide;
        right: PresentationComparisonSide;
    };
    chart?: PresentationChart;
    quote?: string;
    attribution?: string;
    imagePath?: string;
    imageAlt?: string;
    imageFit: PresentationImageFit;
    imageKind: PresentationImageKind;
    imageFocus: PresentationImageFocus;
    /** Shape treatment applied after aspect-ratio-safe raster preparation. */
    imageMask: PresentationImageMask;
    /** Original URL or attribution for externally sourced imagery. */
    imageSource?: string;
    /** Intrinsic source ratio, populated after local assets are resolved. */
    imageAspectRatio?: number;
    speakerNotes?: string;
    sources: string[];
}

export interface PresentationDeckPlan {
    brief: PresentationBrief;
    artDirection: PresentationArtDirection;
    slides: PresentationSlidePlan[];
    revision: number;
    workflow: PresentationWorkflow;
}

export interface PresentationQualityIssue {
    severity: 'warning' | 'error';
    code: string;
    message: string;
    /** Slide number in the rendered deck. */
    slide?: number;
    /** Caller-authored slide that produced this rendered page after automatic
     * pagination. Equal to slide when no reflow occurred. */
    sourceSlide?: number;
}

const DEFAULT_PALETTE: PresentationPalette = {
    background: 'F4F1EA',
    surface: 'FFFFFF',
    text: '17211B',
    muted: '667168',
    accent: '1F9D68',
    accent2: 'F0A34A',
};

const DEFAULT_TYPOGRAPHY: PresentationTypography = {
    heading: 'Aptos Display',
    body: 'Aptos',
    titleScale: 1,
    bodyScale: 1,
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
    return isRecord(value) ? value : {};
}

function text(value: unknown, fallback = ''): string {
    return typeof value === 'string' ? value.trim() : fallback;
}

function stringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.map(item => text(item)).filter(Boolean);
}

function hex(value: unknown, fallback: string): string {
    const candidate = text(value).replace(/^#/, '').toUpperCase();
    return /^[0-9A-F]{6}$/.test(candidate) ? candidate : fallback;
}

function number(value: unknown, fallback: number, minimum: number, maximum: number): number {
    const candidate = Number(value);
    if (!Number.isFinite(candidate)) return fallback;
    return Math.min(maximum, Math.max(minimum, candidate));
}

function enumText<T extends string>(value: unknown, supported: readonly T[], fallback: T): T {
    const candidate = text(value).toLowerCase() as T;
    return supported.includes(candidate) ? candidate : fallback;
}

function normalizeItems(value: unknown): PresentationItem[] {
    if (!Array.isArray(value)) return [];
    return value.map(item => {
        if (typeof item === 'string') return { title: text(item) };
        const source = record(item);
        return {
            title: text(source.title || source.heading),
            description: text(source.description || source.body) || undefined,
        };
    }).filter(item => item.title);
}

function normalizeMetrics(value: unknown): PresentationMetric[] {
    if (!Array.isArray(value)) return [];
    return value.map(item => {
        const source = record(item);
        return {
            value: text(source.value),
            label: text(source.label),
            description: text(source.description) || undefined,
        };
    }).filter(item => item.value && item.label);
}

function normalizeSteps(value: unknown): PresentationStep[] {
    if (!Array.isArray(value)) return [];
    return value.map(item => {
        if (typeof item === 'string') return { title: text(item) };
        const source = record(item);
        return {
            title: text(source.title),
            description: text(source.description || source.body) || undefined,
        };
    }).filter(item => item.title);
}

function normalizeComparison(value: unknown): PresentationSlidePlan['comparison'] | undefined {
    const source = record(value);
    const readSide = (sideValue: unknown): PresentationComparisonSide | undefined => {
        const side = record(sideValue);
        const heading = text(side.heading || side.title);
        const items = stringArray(side.items || side.bullets);
        return heading && items.length ? { heading, items } : undefined;
    };
    const left = readSide(source.left);
    const right = readSide(source.right);
    return left && right ? { left, right } : undefined;
}

function normalizeChart(value: unknown): PresentationChart | undefined {
    const source = record(value);
    const type = text(source.type, 'column') as PresentationChart['type'];
    if (!PRESENTATION_CHART_TYPES.includes(type)) {
        return undefined;
    }
    const numericArray = (input: unknown, limit = 24): number[] => Array.isArray(input)
        ? input.map(item => Number(item)).filter(Number.isFinite).slice(0, limit)
        : [];
    let labels = stringArray(source.labels).slice(0, 24);
    let values = numericArray(source.values);
    // Models commonly describe treemap area as `sizes` (the Plotly/ECharts
    // convention). Accept it as an alias while preserving `sizes` as the
    // independent magnitude channel for bubble charts.
    if (type === 'treemap' && values.length === 0) values = numericArray(source.sizes);
    const name = text(source.name) || undefined;

    if (type === 'heatmap') {
        const rawMatrix = Array.isArray(source.matrix) ? source.matrix : [];
        const matrix = rawMatrix
            .map(row => numericArray(row, 12))
            .filter(row => row.length >= 2)
            .slice(0, 10);
        const width = matrix[0]?.length || 0;
        if (matrix.length < 2 || width < 2 || matrix.some(row => row.length !== width)) return undefined;
        const rowLabels = stringArray(source.row_labels || source.rowLabels).slice(0, matrix.length);
        const columnLabels = stringArray(source.column_labels || source.columnLabels).slice(0, width);
        return {
            type,
            name,
            labels: columnLabels.length === width ? columnLabels : Array.from({ length: width }, (_, index) => `C${index + 1}`),
            values: matrix.flat(),
            matrix,
            rowLabels: rowLabels.length === matrix.length ? rowLabels : Array.from({ length: matrix.length }, (_, index) => `R${index + 1}`),
            columnLabels: columnLabels.length === width ? columnLabels : Array.from({ length: width }, (_, index) => `C${index + 1}`),
        };
    }

    if (['stacked-bar', 'stacked-column', 'combo'].includes(type)) {
        const rawSeries = Array.isArray(source.series) ? source.series : [];
        const series = rawSeries.map((item, index) => {
            const entry = record(item);
            return {
                name: text(entry.name, `Series ${index + 1}`),
                values: numericArray(entry.values),
            };
        }).filter(item => item.values.length >= 2).slice(0, 6);
        const width = series[0]?.values.length || 0;
        if (series.length < 2 || width < 2 || series.some(item => item.values.length !== width)) return undefined;
        if (labels.length !== width) labels = Array.from({ length: width }, (_, index) => `C${index + 1}`);
        return { type, name, labels, values: series[0]!.values, series };
    }

    if (type === 'scatter' || type === 'bubble') {
        const xValues = numericArray(source.x_values || source.xValues);
        const sizes = numericArray(source.sizes);
        if (values.length < 2 || xValues.length !== values.length) return undefined;
        if (type === 'bubble' && sizes.length !== values.length) return undefined;
        if (labels.length !== values.length) labels = values.map((_, index) => `P${index + 1}`);
        return { type, name, labels, values, xValues, sizes: type === 'bubble' ? sizes : undefined };
    }

    if (type === 'gantt') {
        const startValues = numericArray(source.start_values || source.startValues);
        if (labels.length < 2 || values.length !== labels.length || startValues.length !== labels.length) return undefined;
        return { type, name, labels, values, startValues };
    }

    if (labels.length < 2 || labels.length !== values.length) return undefined;
    if (type === 'treemap') {
        const parents = stringArray(source.parents).slice(0, labels.length);
        return { type, name, labels, values, parents: parents.length === labels.length ? parents : undefined };
    }
    return { type, name, labels, values };
}

function normalizeLayout(value: unknown): PresentationLayoutIntent {
    const source = record(value);
    return {
        archetype: enumText(source.archetype || source.family, [
            'auto', 'cover', 'section', 'editorial', 'image', 'evidence', 'process',
            'collection', 'comparison', 'quote', 'closing',
        ] as const, 'auto'),
        variant: enumText(source.variant, [
            'auto', 'editorial', 'asymmetric', 'centered', 'full-bleed', 'cards', 'banded', 'stacked', 'spotlight',
        ] as const, 'auto'),
        emphasis: enumText(source.emphasis, ['message', 'visual', 'data', 'balanced'] as const, 'balanced'),
        alignment: enumText(source.alignment, ['left', 'center', 'right'] as const, 'left'),
        imagePosition: enumText(source.image_position || source.imagePosition, [
            'auto', 'left', 'right', 'background', 'top', 'bottom',
        ] as const, 'auto'),
        whitespace: enumText(source.whitespace, ['compact', 'balanced', 'generous'] as const, 'balanced'),
        focalScale: number(source.focal_scale || source.focalScale, 1, 0.8, 1.35),
        rationale: text(source.rationale) || undefined,
    };
}

function inferImageKind(source: Record<string, unknown>): PresentationImageKind {
    const requested = text(source.image_kind || source.imageKind).toLowerCase();
    const supported: PresentationImageKind[] = ['photo', 'background', 'diagram', 'map', 'logo', 'screenshot'];
    if (supported.includes(requested as PresentationImageKind)) return requested as PresentationImageKind;

    const descriptor = [
        source.image_alt,
        source.imageAlt,
        source.visual_role,
        source.visualRole,
        source.design_notes,
        source.designNotes,
        source.purpose,
    ].map(value => text(value)).join(' ');
    if (/\b(?:logo|mark|brand)\b|标志|标识|商标/i.test(descriptor)) return 'logo';
    if (/\b(?:map|route|routing)\b|地图|线路|路线/i.test(descriptor)) return 'map';
    if (/\b(?:diagram|flow|process|architecture|schematic)\b|流程|架构|示意|机制|关系图|系统图/i.test(descriptor)) return 'diagram';
    if (/\b(?:screenshot|screen|interface|ui)\b|截图|界面/i.test(descriptor)) return 'screenshot';

    const layout = record(source.layout);
    if (text(layout.image_position || layout.imagePosition) === 'background'
        || text(layout.variant) === 'full-bleed') {
        return 'background';
    }
    return 'photo';
}

function normalizeImageFit(source: Record<string, unknown>, kind: PresentationImageKind): PresentationImageFit {
    const requested = text(source.image_fit || source.imageFit).toLowerCase();
    if (requested === 'cover' || requested === 'contain') return requested;
    return ['diagram', 'map', 'logo', 'screenshot'].includes(kind) ? 'contain' : 'cover';
}

function normalizeImageFocus(value: unknown): PresentationImageFocus {
    const source = record(value);
    return {
        x: number(source.x, 0.5, 0, 1),
        y: number(source.y, 0.5, 0, 1),
    };
}

function normalizeImageMask(source: Record<string, unknown>): PresentationImageMask {
    return enumText(source.image_mask || source.imageMask, [
        'auto', 'none', 'rounded-rect', 'circle', 'arch', 'soft-edge',
    ] as const, 'auto');
}

function normalizeVisualReview(value: unknown): PresentationVisualReview | undefined {
    const source = record(value);
    const issues = Array.isArray(source.issues) ? source.issues.map(item => {
        const issue = record(item);
        return {
            slide: Math.max(1, Math.trunc(number(issue.slide, 1, 1, 40))),
            severity: enumText(issue.severity, ['warning', 'error'] as const, 'warning'),
            category: enumText(issue.category, [
                'hierarchy', 'composition', 'typography', 'theme', 'originality',
                'spacing', 'alignment', 'density', 'imagery', 'consistency', 'rhythm', 'narrative', 'other',
            ] as const, 'other'),
            observation: text(issue.observation),
            action: text(issue.action),
        } satisfies PresentationVisualReviewIssue;
    }).filter(issue => issue.observation && issue.action) : [];
    const summary = text(source.summary);
    const strengths = stringArray(source.strengths).slice(0, 8);
    const reviewedSlideNumbers = (Array.isArray(source.reviewed_slide_numbers || source.reviewedSlideNumbers)
        ? (source.reviewed_slide_numbers || source.reviewedSlideNumbers) as unknown[]
        : [])
        .map(item => Math.trunc(Number(item)))
        .filter(item => Number.isFinite(item) && item >= 1 && item <= 40)
        .filter((item, index, values) => values.indexOf(item) === index)
        .sort((a, b) => a - b);
    const overallScoreRaw = Number(source.overall_score ?? source.overallScore);
    const overallScore = Number.isFinite(overallScoreRaw)
        ? Math.max(0, Math.min(5, overallScoreRaw))
        : undefined;
    const scorecardSource = record(source.scorecard);
    const scorecardKeys = ['hierarchy', 'composition', 'typography', 'theme', 'originality'] as const;
    const scorecardValues = scorecardKeys.map(key => Number(scorecardSource[key]));
    const scorecard = scorecardValues.every(Number.isFinite)
        ? Object.fromEntries(scorecardKeys.map((key, index) => [
            key,
            Math.max(0, Math.min(5, scorecardValues[index])),
        ])) as unknown as PresentationVisualScorecard
        : undefined;
    const slideScores = (Array.isArray(source.slide_scores || source.slideScores)
        ? (source.slide_scores || source.slideScores) as unknown[]
        : [])
        .map(item => {
            const score = record(item);
            return {
                slide: Math.trunc(Number(score.slide)),
                total: Math.max(0, Math.min(5, Number(score.total))),
            };
        })
        .filter(item => Number.isFinite(item.slide) && item.slide >= 1 && item.slide <= 40 && Number.isFinite(item.total));
    return summary || strengths.length || issues.length || reviewedSlideNumbers.length || scorecard || overallScore !== undefined || slideScores.length
        ? { summary: summary || undefined, strengths, issues, reviewedSlideNumbers, scorecard, overallScore, slideScores }
        : undefined;
}

function normalizeDirectionReview(value: unknown): PresentationDirectionReview | undefined {
    const source = record(value);
    const selectedDirectionId = text(source.selected_direction_id || source.selectedDirectionId);
    const reviewedDirectionIds = stringArray(source.reviewed_direction_ids || source.reviewedDirectionIds)
        .filter((item, index, values) => values.indexOf(item) === index);
    const scores = (Array.isArray(source.scores) ? source.scores as unknown[] : [])
        .map(item => {
            const score = record(item);
            const total = Number(score.total);
            return {
                id: text(score.id),
                total: Number.isFinite(total) ? Math.max(0, Math.min(5, total)) : Number.NaN,
                rationale: text(score.rationale) || undefined,
            };
        })
        .filter(item => item.id && Number.isFinite(item.total));
    if (!selectedDirectionId && !reviewedDirectionIds.length && !scores.length) return undefined;
    return {
        summary: text(source.summary) || undefined,
        selectedDirectionId,
        reviewedDirectionIds,
        scores,
    };
}

function inferDeliveryMode(brief: Record<string, unknown>): PresentationDeliveryMode {
    const requested = enumText(
        brief.delivery_mode || brief.deliveryMode,
        ['marketing', 'report', 'reference'] as const,
        'report',
    );
    if (brief.delivery_mode || brief.deliveryMode) return requested;
    const summary = [
        brief.title,
        brief.purpose,
        brief.desired_outcome,
        brief.desiredOutcome,
    ].map(value => text(value)).join(' ');
    if (/企业(?:介绍|简介)|集团简介|品牌|营销|宣传|招商|路演|销售|profile|marketing|sales|pitch/i.test(summary)) {
        return 'marketing';
    }
    if (/手册|参考|资料汇编|技术文档|培训|reference|manual|handbook|training/i.test(summary)) {
        return 'reference';
    }
    return 'report';
}

function inferComposition(source: Record<string, unknown>, index: number, total: number): PresentationComposition {
    const requested = text(source.composition).toLowerCase() as PresentationComposition;
    const supported: PresentationComposition[] = [
        'focal', 'narrative', 'split', 'sequence', 'grid', 'data', 'comparison', 'quote', 'closing',
    ];
    if (supported.includes(requested)) return requested;
    if (index === 0) return 'focal';
    if (source.chart) return 'data';
    if (source.comparison) return 'comparison';
    if (source.quote) return 'quote';
    if (source.steps) return 'sequence';
    if (source.metrics) return 'data';
    if (source.image_path || source.imagePath) return 'split';
    if (source.items) return 'grid';
    if (index === total - 1 && /close|closing|action|next|结尾|行动|下一步|总结/i.test(text(source.purpose))) {
        return 'closing';
    }
    return 'narrative';
}

function inferInformationRole(
    source: Record<string, unknown>,
    composition: PresentationComposition,
    index: number,
    total: number,
): PresentationInformationRole {
    const requested = enumText(source.information_role || source.informationRole, [
        'claim', 'status', 'evidence', 'events', 'ranking', 'timeline',
        'comparison', 'collection', 'sources', 'action',
    ] as const, 'claim');
    if (source.information_role || source.informationRole) return requested;
    if (index === total - 1 && composition === 'closing') return 'action';
    if (source.metrics) return 'status';
    if (source.chart) return 'evidence';
    if (source.comparison) return 'comparison';
    if (source.steps) return 'timeline';
    if (source.items) {
        const summary = [source.purpose, source.message, source.title].map(value => text(value)).join(' ');
        if (/(?:来源|参考|出处|文献|资料索引|source|reference|bibliograph|evidence index)/i.test(summary)) return 'sources';
        const itemSources = Array.isArray(source.items) ? source.items.map(record) : [];
        const eventLike = itemSources.filter(item => /(?:\b\d{1,2}[:：]\d{2}\b|\b\d{1,2}[\/-]\d{1,2}\b|\bQ[1-4]\b|\b(?:mon|tue|wed|thu|fri|sat|sun)(?:day)?\b|\bround\s*\d+|日期|时间|周[一二三四五六日天]|\d{1,2}月\d{1,2}日)/i
            .test(`${text(item.title)} ${text(item.description)}`)).length;
        if (itemSources.length >= 3 && eventLike / itemSources.length >= 0.5) return 'events';
        return 'collection';
    }
    if (composition === 'closing') return 'action';
    return 'claim';
}

function normalizeArtDirection(value: unknown): PresentationArtDirection {
    const source = record(value);
    const palette = record(source.palette);
    const typography = record(source.typography);
    const grid = record(source.grid);
    const densityValue = text(source.density, 'balanced') as PresentationDensity;
    const mood = text(source.mood, 'confident, editorial, clear');
    const inferredVisualLanguage: PresentationVisualLanguage = /(?:launch|bold|cinematic|kinetic|energy|动势|发布)/i.test(mood)
        ? 'kinetic'
        : /(?:editorial|publication|story|asymmetric|杂志|叙事)/i.test(mood)
            ? 'editorial'
            : 'precision';
    return {
        mood,
        rationale: text(source.rationale) || undefined,
        imageStyle: text(source.image_style || source.imageStyle) || undefined,
        visualLanguage: enumText(source.visual_language || source.visualLanguage, [
            'precision', 'editorial', 'kinetic',
        ] as const, inferredVisualLanguage),
        designConcept: text(source.design_concept || source.designConcept) || undefined,
        signatureElement: enumText(source.signature_element || source.signatureElement, [
            'axis', 'cutout', 'pulse', 'frame', 'orbit',
        ] as const, inferredVisualLanguage === 'kinetic'
            ? 'pulse'
            : inferredVisualLanguage === 'editorial' ? 'cutout' : 'axis'),
        density: ['airy', 'balanced', 'compact'].includes(densityValue) ? densityValue : 'balanced',
        palette: {
            background: hex(palette.background, DEFAULT_PALETTE.background),
            surface: hex(palette.surface, DEFAULT_PALETTE.surface),
            text: hex(palette.text, DEFAULT_PALETTE.text),
            muted: hex(palette.muted, DEFAULT_PALETTE.muted),
            accent: hex(palette.accent, DEFAULT_PALETTE.accent),
            accent2: hex(palette.accent2, DEFAULT_PALETTE.accent2),
        },
        typography: {
            heading: text(typography.heading, DEFAULT_TYPOGRAPHY.heading),
            body: text(typography.body, DEFAULT_TYPOGRAPHY.body),
            titleScale: number(typography.title_scale || typography.titleScale, DEFAULT_TYPOGRAPHY.titleScale, 0.82, 1.22),
            bodyScale: number(typography.body_scale || typography.bodyScale, DEFAULT_TYPOGRAPHY.bodyScale, 0.86, 1.16),
        },
        spacing: enumText(source.spacing, ['tight', 'balanced', 'generous'] as const, 'balanced'),
        motif: enumText(source.motif, ['none', 'line', 'frame', 'orbit', 'blocks'] as const, 'line'),
        backgroundTreatment: enumText(source.background_treatment || source.backgroundTreatment, [
            'solid', 'tonal', 'contrast',
        ] as const, 'solid'),
        imageTreatment: enumText(source.image_treatment || source.imageTreatment, [
            'natural', 'full-bleed', 'framed', 'soft-crop',
        ] as const, 'natural'),
        chartStyle: enumText(source.chart_style || source.chartStyle, ['minimal', 'editorial', 'bold'] as const, 'minimal'),
        grid: {
            columns: Math.round(number(grid.columns, 12, 6, 16)),
            margin: number(grid.margin, 0.78, 0.45, 1.2),
            gutter: number(grid.gutter, 0.22, 0.12, 0.5),
        },
        designPrinciples: stringArray(source.design_principles || source.designPrinciples).slice(0, 8),
        referenceSummary: text(source.reference_summary || source.referenceSummary) || undefined,
        avoid: stringArray(source.avoid).slice(0, 8),
    };
}

export function parsePresentationPlan(args: Record<string, unknown>): PresentationDeckPlan {
    const briefSource = record(args.brief);
    const slideSources = Array.isArray(args.slides) ? args.slides.map(record) : [];
    if (slideSources.length === 0) throw new Error('slides must contain at least one planned slide');
    if (slideSources.length > 40) throw new Error('slides cannot contain more than 40 slides');

    const slides = slideSources.map((source, index): PresentationSlidePlan => {
        const purpose = text(source.purpose);
        const message = text(source.message || source.title);
        if (!purpose) throw new Error(`slides[${index}].purpose is required`);
        if (!message) throw new Error(`slides[${index}].message is required`);
        const imageKind = inferImageKind(source);
        const composition = inferComposition(source, index, slideSources.length);
        const comparison = normalizeComparison(source.comparison);
        const explicitItems = normalizeItems(source.items);
        // Some tool-capable models flatten a one-sided comparison into
        // `{ heading, items }`. That is not a true comparison, but its facts
        // must never disappear. Preserve them as a normal collection so the
        // layout engine can render every record on a compatible silhouette.
        const flatComparisonItems = comparison
            ? []
            : normalizeItems(record(source.comparison).items);
        return {
            purpose,
            message,
            informationRole: inferInformationRole(source, composition, index, slideSources.length),
            relationshipToPrevious: text(source.relationship_to_previous || source.relationshipToPrevious) || undefined,
            title: text(source.title) || undefined,
            eyebrow: text(source.eyebrow) || undefined,
            composition,
            layout: normalizeLayout(source.layout),
            // Replaced by the deck-wide layout engine after the full plan is
            // available. Keeping an explicit placeholder makes the resolved
            // geometry part of the durable design contract.
            resolvedLayout: {
                family: index === 0 ? 'cover' : index === slideSources.length - 1 ? 'closing' : 'editorial',
                silhouette: index === 0 ? 'cover-split' : index === slideSources.length - 1 ? 'closing-cta' : 'editorial-columns',
                surfaceRole: 'base',
                fingerprint: 'pending',
                rationale: 'Pending deck-wide layout planning.',
            },
            visualRole: text(source.visual_role || source.visualRole) || undefined,
            designNotes: text(source.design_notes || source.designNotes) || undefined,
            body: text(source.body) || undefined,
            bullets: stringArray(source.bullets).slice(0, 8),
            items: explicitItems.length ? explicitItems : flatComparisonItems,
            metrics: normalizeMetrics(source.metrics),
            steps: normalizeSteps(source.steps),
            comparison,
            chart: normalizeChart(source.chart),
            quote: text(source.quote) || undefined,
            attribution: text(source.attribution) || undefined,
            imagePath: text(source.image_path || source.imagePath || source.image_url || source.imageUrl) || undefined,
            imageAlt: text(source.image_alt || source.imageAlt) || undefined,
            imageFit: normalizeImageFit(source, imageKind),
            imageKind,
            imageFocus: normalizeImageFocus(source.image_focus || source.imageFocus),
            imageMask: normalizeImageMask(source),
            imageSource: text(
                source.image_source_url || source.imageSourceUrl
                || source.image_credit || source.imageCredit
                || source.image_url || source.imageUrl,
            ) || undefined,
            speakerNotes: text(source.speaker_notes || source.speakerNotes) || undefined,
            sources: [
                ...stringArray(source.sources),
                text(source.image_source_url || source.imageSourceUrl || source.image_url || source.imageUrl),
                text(source.image_credit || source.imageCredit),
            ].filter((value, sourceIndex, values) => Boolean(value) && values.indexOf(value) === sourceIndex),
        };
    });

    const title = text(briefSource.title, slides[0].title || slides[0].message);
    const audience = text(briefSource.audience);
    const purpose = text(briefSource.purpose);
    const desiredOutcome = text(briefSource.desired_outcome || briefSource.desiredOutcome);
    if (!title) throw new Error('brief.title is required');
    if (!audience) throw new Error('brief.audience is required');
    if (!purpose) throw new Error('brief.purpose is required');
    if (!desiredOutcome) throw new Error('brief.desired_outcome is required');
    const requestedSlideCountSource = briefSource.requested_slide_count ?? briefSource.requestedSlideCount;
    const requestedSlideCountNumber = Number(requestedSlideCountSource);
    const requestedSlideCount = requestedSlideCountSource === undefined
        ? undefined
        : Math.trunc(requestedSlideCountNumber);
    if (requestedSlideCount !== undefined && (
        !Number.isFinite(requestedSlideCountNumber)
        || requestedSlideCountNumber !== requestedSlideCount
        || requestedSlideCount < 1
        || requestedSlideCount > 24
    )) {
        throw new Error('brief.requested_slide_count must be an integer between 1 and 24');
    }

    const revision = Math.trunc(Number(args.revision || 0));
    if (!Number.isFinite(revision) || revision < 0 || revision > MAX_PRESENTATION_REVISIONS) {
        throw new Error(`revision must be between 0 and ${MAX_PRESENTATION_REVISIONS}`);
    }

    const workflowSource = record(args.workflow);
    const stage = enumText(workflowSource.stage || args.workflow_stage, ['sample', 'final', 'review', 'revision'] as const, 'final');
    const mode = enumText(workflowSource.mode || args.workflow_mode, ['auto', 'confirm'] as const, 'auto');
    const sampleSlideNumbers = (Array.isArray(workflowSource.sample_slide_numbers || workflowSource.sampleSlideNumbers)
        ? (workflowSource.sample_slide_numbers || workflowSource.sampleSlideNumbers) as unknown[]
        : [])
        .map(item => Math.trunc(Number(item)))
        .filter(item => Number.isFinite(item) && item >= 1 && item <= slides.length)
        .filter((item, index, values) => values.indexOf(item) === index)
        .slice(0, 3);

    return planPresentationLayouts({
        brief: {
            title,
            subtitle: text(briefSource.subtitle) || undefined,
            audience,
            purpose,
            desiredOutcome,
            language: text(briefSource.language) || undefined,
            deliveryMode: inferDeliveryMode(briefSource),
            communicationJob: text(briefSource.communication_job || briefSource.communicationJob) || undefined,
            narrativeArc: stringArray(briefSource.narrative_arc || briefSource.narrativeArc).slice(0, 10),
            requestedSlideCount,
        },
        artDirection: normalizeArtDirection(args.art_direction || args.artDirection),
        slides,
        revision,
        workflow: {
            stage,
            mode,
            designId: text(workflowSource.design_id || workflowSource.designId || args.design_id) || undefined,
            sampleApproved: workflowSource.sample_approved === true || workflowSource.sampleApproved === true,
            sampleSlideNumbers,
            directionReview: normalizeDirectionReview(workflowSource.direction_review || workflowSource.directionReview),
            visualReview: normalizeVisualReview(workflowSource.visual_review || workflowSource.visualReview || args.visual_review),
        },
    });
}

function continuationSampleKey(slide: PresentationSlidePlan): string | undefined {
    for (const value of [slide.title, slide.message]) {
        if (!value) continue;
        const match = value.match(/^(.*?)[（(](\d+)\s*\/\s*(\d+)[）)]\s*$/);
        if (match && Number(match[3]) >= 2) {
            return `${match[1].trim().toLowerCase()}|${slide.purpose.trim().toLowerCase()}`;
        }
    }
    return undefined;
}

/** Pick a cover, a representative content slide, and an evidence/data slide for visual direction review. */
export function selectRepresentativeSlides(plan: PresentationDeckPlan): number[] {
    const count = plan.slides.length;
    if (count <= 3) return Array.from({ length: count }, (_, index) => index + 1);

    const selected: number[] = [];
    const selectedContinuationKeys = new Set<string>();
    const add = (slideNumber: number): void => {
        if (selected.length >= 3 || selected.includes(slideNumber) || slideNumber < 1 || slideNumber > count) return;
        const key = continuationSampleKey(plan.slides[slideNumber - 1]);
        if (key && selectedContinuationKeys.has(key)) return;
        selected.push(slideNumber);
        if (key) selectedContinuationKeys.add(key);
    };

    // Honor valid explicit samples, but never spend two of the three review
    // slots on sibling continuation pages from the same semantic record set.
    plan.workflow.sampleSlideNumbers.forEach(add);

    const evidenceIndex = plan.slides.findIndex((slide, index) => (
        index > 0 && (slide.composition === 'data' || slide.composition === 'comparison')
    ));
    const contentCandidates = plan.slides
        .map((slide, index) => ({ slide, index }))
        .filter(({ slide, index }) => (
            index > 0
            && index < count - 1
            && ['narrative', 'split', 'sequence', 'grid'].includes(slide.composition)
        ));
    const content = contentCandidates[Math.floor(contentCandidates.length / 2)];
    add(1);
    if (content) add(content.index + 1);
    if (evidenceIndex >= 0) add(evidenceIndex + 1);

    for (let index = 1; selected.length < 3 && index < count; index++) {
        const slideNumber = index + 1;
        if (slideNumber !== count) add(slideNumber);
    }
    return selected.slice(0, 3);
}

function visualUnits(value: string): number {
    return Array.from(value).reduce((sum, character) => sum + (/[^\x00-\xff]/.test(character) ? 1 : 0.55), 0);
}

function relativeLuminance(value: string): number {
    const channels = [0, 2, 4].map(offset => parseInt(value.slice(offset, offset + 2), 16) / 255);
    const linear = channels.map(channel => channel <= 0.03928
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4);
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(foreground: string, background: string): number {
    const first = relativeLuminance(foreground);
    const second = relativeLuminance(background);
    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function visibleInformationUnits(slide: PresentationSlidePlan): number {
    const comparisonUnits = slide.comparison
        ? visualUnits(slide.comparison.left.heading)
            + visualUnits(slide.comparison.right.heading)
            + slide.comparison.left.items.reduce((sum, item) => sum + visualUnits(item), 0)
            + slide.comparison.right.items.reduce((sum, item) => sum + visualUnits(item), 0)
        : 0;
    return visualUnits(slide.body || '')
        + slide.bullets.reduce((sum, item) => sum + visualUnits(item), 0)
        + slide.items.reduce((sum, item) => sum + visualUnits(item.title) + visualUnits(item.description || ''), 0)
        + slide.steps.reduce((sum, item) => sum + visualUnits(item.title) + visualUnits(item.description || ''), 0)
        + slide.metrics.reduce((sum, item) => (
            sum + visualUnits(item.value) + visualUnits(item.label) + visualUnits(item.description || '')
        ), 0)
        + (slide.chart?.labels.reduce((sum, item) => sum + visualUnits(item), 0) || 0)
        + visualUnits(slide.quote || '')
        + visualUnits(slide.attribution || '')
        + comparisonUnits;
}

function isContinuationTitle(value: string): boolean {
    return /[（(]\d+\s*\/\s*\d+[）)]\s*$/.test(value);
}

/** Cover, section, and closing pages intentionally trade information density
 * for pacing. A final quote or action page has the same narrative job even
 * when its concrete renderer is quote rather than closing. */
export function isIntentionalPresentationBoundary(
    slide: PresentationSlidePlan,
    index: number,
    total: number,
): boolean {
    if (['cover', 'section', 'closing'].includes(slide.resolvedLayout.family)) return true;
    return index === total - 1 && (
        slide.resolvedLayout.family === 'quote'
        || slide.composition === 'closing'
        || slide.layout.archetype === 'closing'
        || slide.informationRole === 'action'
    );
}

export function evaluatePresentationPlan(plan: PresentationDeckPlan): PresentationQualityIssue[] {
    const issues: PresentationQualityIssue[] = [];
    const compositionCounts = new Map<PresentationComposition, number>();
    const designSignatures = new Set<string>();
    const imageUseCounts = new Map<string, number>();
    let repeated = 1;

    if (plan.workflow.stage === 'revision' && plan.revision === 0) {
        issues.push({
            severity: 'error',
            code: 'revision_number_required',
            message: `A visual revision must use a revision number from 1 to ${MAX_PRESENTATION_REVISIONS}.`,
        });
    }
    if (plan.workflow.stage === 'revision' && !plan.workflow.visualReview?.issues.length) {
        issues.push({
            severity: 'error',
            code: 'visual_review_required',
            message: 'A visual revision requires concrete slide-level review findings and actions.',
        });
    }

    if (
        plan.brief.requestedSlideCount !== undefined
        && plan.slides.length !== plan.brief.requestedSlideCount
    ) {
        issues.push({
            severity: 'error',
            code: 'requested_slide_count_mismatch',
            message: `The user requested exactly ${plan.brief.requestedSlideCount} slides, but the capacity-planned deck contains ${plan.slides.length}. The count includes cover, section, appendix, and continuation slides.`,
        });
    }

    if (plan.brief.deliveryMode === 'marketing') {
        if (!plan.brief.communicationJob) {
            issues.push({
                severity: 'error',
                code: 'communication_job_required',
                message: 'A marketing deck requires a one-sentence communication job before slide design begins.',
            });
        }
        if (plan.brief.narrativeArc.length < 3) {
            issues.push({
                severity: 'error',
                code: 'narrative_arc_required',
                message: 'A marketing deck requires at least three cumulative narrative beats, not only an agenda.',
            });
        }
        if (plan.slides.length > 22) {
            issues.push({
                severity: 'error',
                code: 'marketing_deck_too_long',
                message: 'Marketing and corporate-profile decks must curate the visible story to at most 22 slides; move comprehensive source detail into notes or an appendix.',
            });
        }
    }

    if (contrastRatio(plan.artDirection.palette.text, plan.artDirection.palette.background) < 4.5) {
        issues.push({
            severity: 'error',
            code: 'low_text_contrast',
            message: 'The main text and background colors do not have enough contrast for comfortable reading.',
        });
    }
    if (contrastRatio(plan.artDirection.palette.muted, plan.artDirection.palette.background) < 3) {
        issues.push({
            severity: 'warning',
            code: 'low_secondary_contrast',
            message: 'Secondary text may be difficult to read against the selected background.',
        });
    }
    if (contrastRatio(plan.artDirection.palette.text, plan.artDirection.palette.surface) < 4.5) {
        issues.push({
            severity: 'error',
            code: 'low_surface_text_contrast',
            message: 'Text placed on cards or panels does not have enough contrast against the surface color.',
        });
    }
    if (contrastRatio(plan.artDirection.palette.muted, plan.artDirection.palette.surface) < 3) {
        issues.push({
            severity: 'warning',
            code: 'low_surface_secondary_contrast',
            message: 'Secondary text placed on cards or panels may be difficult to read.',
        });
    }
    for (const [name, color] of [
        ['accent', plan.artDirection.palette.accent],
        ['accent2', plan.artDirection.palette.accent2],
    ] as const) {
        const weakest = Math.min(
            contrastRatio(color, plan.artDirection.palette.background),
            contrastRatio(color, plan.artDirection.palette.surface),
        );
        if (weakest < 2) {
            issues.push({
                severity: 'warning',
                code: `low_${name}_contrast`,
                message: `The ${name} color is too close to one of the presentation surfaces for labels or smaller data values.`,
            });
        }
    }

    const marketingDeck = plan.brief.deliveryMode === 'marketing';
    const layoutSummary = summarizePresentationLayouts(plan);
    const densityLimit = marketingDeck
        ? (plan.artDirection.density === 'airy' ? 150 : plan.artDirection.density === 'compact' ? 220 : 180)
        : (plan.artDirection.density === 'airy' ? 190 : plan.artDirection.density === 'compact' ? 270 : 230);

    plan.slides.forEach((slide, index) => {
        compositionCounts.set(slide.composition, (compositionCounts.get(slide.composition) || 0) + 1);
        const signature = slide.resolvedLayout.fingerprint;
        designSignatures.add(signature);
        if (index > 0 && signature === plan.slides[index - 1].resolvedLayout.fingerprint) repeated += 1;
        else repeated = 1;
        if (repeated > 2) {
            issues.push({
                severity: 'warning',
                code: 'composition_monotony',
                slide: index + 1,
                message: 'The same composition appears on more than two consecutive slides; vary the silhouette if the content allows it.',
            });
        }

        if (slide.imagePath) {
            const imageKey = slide.imagePath.trim().toLowerCase();
            const uses = (imageUseCounts.get(imageKey) || 0) + 1;
            imageUseCounts.set(imageKey, uses);
            if (uses > 1 && slide.imageKind !== 'background') {
                issues.push({
                    severity: 'warning',
                    code: 'image_reused_without_background_role',
                    slide: index + 1,
                    message: 'The same non-background visual is reused on multiple slides; prefer a distinct asset or use it only where it adds evidence.',
                });
            }
        }

        const title = slide.title || slide.message;
        if (visualUnits(title) > 34) {
            issues.push({
                severity: 'warning',
                code: 'title_too_dense',
                slide: index + 1,
                message: 'The audience-facing title is dense. Shorten the claim before reducing the title size.',
            });
        }
        const bodyUnits = visualUnits(slide.body || '')
            + slide.bullets.reduce((sum, item) => sum + visualUnits(item), 0)
            + slide.items.reduce((sum, item) => sum + visualUnits(item.title) + visualUnits(item.description || ''), 0);
        const compactCollection = isCompactCollection(slide.items as unknown as Array<Record<string, unknown>>);
        const narrativeUnits = visualUnits(slide.body || '')
            + slide.bullets.reduce((sum, item) => sum + visualUnits(item), 0);
        const stackedCollection = fitsPresentationStackedCollection(
            slide.items as unknown as Array<Record<string, unknown>>,
        ) && (!slide.body || fitsPresentationHeaderRail(slide.body))
            && slide.bullets.length <= 1
            && narrativeUnits <= 150;
        if ((!compactCollection && !stackedCollection && bodyUnits > densityLimit) || slide.bullets.length > 6) {
            issues.push({
                severity: bodyUnits > densityLimit * 1.35 || slide.bullets.length > 7 ? 'error' : 'warning',
                code: 'content_too_dense',
                slide: index + 1,
                message: 'This slide carries too much visible copy. Split the thought or remove low-value detail.',
            });
        }
        const bulletCapacity = plan.brief.deliveryMode === 'report' || plan.brief.deliveryMode === 'reference'
            ? 6
            : plan.artDirection.density === 'compact'
                ? 6
                : plan.artDirection.density === 'airy' ? 4 : 5;
        const collectionCapacity = compactCollection
            ? COMPACT_COLLECTION_CAPACITY
            : CARD_COLLECTION_CAPACITY;
        const slideBulletCapacity = slide.chart ? (slide.body ? 3 : 4) : bulletCapacity;
        const capacityFailures = [
            slide.bullets.length > slideBulletCapacity ? `bullets ${slide.bullets.length}/${slideBulletCapacity}` : '',
            slide.items.length > collectionCapacity ? `items ${slide.items.length}/${collectionCapacity}` : '',
            slide.metrics.length > 4 ? `metrics ${slide.metrics.length}/4` : '',
            slide.steps.length > PROCESS_CAPACITY ? `steps ${slide.steps.length}/${PROCESS_CAPACITY}` : '',
            slide.comparison && (
                slide.comparison.left.items.length > COMPARISON_SIDE_CAPACITY
                || slide.comparison.right.items.length > COMPARISON_SIDE_CAPACITY
            )
                ? `comparison ${slide.comparison.left.items.length},${slide.comparison.right.items.length}/${COMPARISON_SIDE_CAPACITY}`
                : '',
        ].filter(Boolean);
        if (capacityFailures.length) {
            issues.push({
                severity: 'error',
                code: 'layout_capacity_exceeded',
                slide: index + 1,
                message: `Slide content exceeds renderer capacity (${capacityFailures.join('; ')}). Auto-paginate before rendering; never truncate content.`,
            });
        }
        const primaryChannels = [
            Boolean(slide.chart),
            slide.metrics.length > 0,
            slide.items.length > 0,
            slide.steps.length > 0,
            Boolean(slide.comparison),
            Boolean(slide.quote),
        ].filter(Boolean).length;
        const boundaryPage = isIntentionalPresentationBoundary(slide, index, plan.slides.length);
        const informationUnits = visibleInformationUnits(slide);
        const continuation = isContinuationTitle(title);
        if (!boundaryPage && !slide.imagePath && primaryChannels === 0 && informationUnits < 48) {
            issues.push({
                severity: continuation ? 'error' : 'warning',
                code: continuation ? 'orphaned_continuation_page' : 'low_information_page',
                slide: index + 1,
                message: continuation
                    ? 'This continuation has too little independent information. Merge it with its structured companion instead of publishing a mostly empty page.'
                    : 'This content page has too little independent information for its own slide. Merge it, strengthen the evidence, or use an intentional section/focal role.',
            });
        }
        const narrativeRailCapacity = slide.chart
            ? (slide.body ? 3 : 4)
            : ['quote-stage', 'quote-full-bleed'].includes(slide.resolvedLayout.silhouette)
                && Boolean(slide.quote)
                ? 2
            : ['metric-spotlight', 'metric-scoreboard', 'status-dashboard'].includes(slide.resolvedLayout.silhouette)
                ? 3
                : ['collection-list', 'collection-list-banded', 'event-ledger', 'source-index'].includes(slide.resolvedLayout.silhouette)
                    ? slide.items.length <= 8 ? 2 : slide.bullets.length === 0 ? 1 : 0
                    : ['comparison-split', 'comparison-cards'].includes(slide.resolvedLayout.silhouette)
                        && Boolean(slide.comparison)
                        && slide.comparison!.left.items.length <= 4
                        && slide.comparison!.right.items.length <= 4
                        ? 2
                        : ['process-horizontal', 'process-stacked', 'milestone-timeline'].includes(slide.resolvedLayout.silhouette)
                            && slide.steps.length <= 5
                            ? 2
                            : 0;
        const primaryRendererConsumesNarrative = narrativeRailCapacity > 0
            && fitsPresentationNarrativeRail(
                slide.body,
                slide.bullets,
                narrativeRailCapacity,
                slide.chart ? CHART_NARRATIVE_RAIL_MAX_UNITS : undefined,
                slide.chart ? CHART_NARRATIVE_BULLET_MAX_UNITS : undefined,
            );
        const coverConsumesMetrics = slide.resolvedLayout.family === 'cover'
            && slide.metrics.length > 0
            && slide.metrics.length <= 4
            && primaryChannels === 1
            && slide.bullets.length === 0;
        if (!coverConsumesMetrics && (primaryChannels > 1
            || (!primaryRendererConsumesNarrative && primaryChannels === 1 && Boolean(slide.body || slide.bullets.length)))) {
            issues.push({
                severity: 'error',
                code: 'mixed_content_channels',
                slide: index + 1,
                message: 'This slide combines content channels that its resolved renderer cannot show together. Split the channels before rendering.',
            });
        }
        if (slide.composition === 'split' && !slide.imagePath) {
            issues.push({
                severity: marketingDeck ? 'error' : 'warning',
                code: 'split_without_image',
                slide: index + 1,
                message: 'The split composition has no image; it will fall back to a text-led composition.',
            });
        }
        if (slide.composition === 'data' && !slide.chart && slide.metrics.length === 0) {
            issues.push({
                severity: 'warning',
                code: 'data_without_evidence',
                slide: index + 1,
                message: 'The data composition has neither a chart nor metrics; provide evidence or choose another composition.',
            });
        }
        if (slide.layout.emphasis === 'visual' && !slide.imagePath) {
            issues.push({
                severity: marketingDeck ? 'error' : 'warning',
                code: 'visual_emphasis_without_image',
                slide: index + 1,
                message: 'The design asks for visual emphasis but provides no image; use a graphic-led variant or supply a verified visual.',
            });
        }
        const silhouette = slide.resolvedLayout.silhouette;
        const contentLayoutMismatch = coverConsumesMetrics
            ? false
            : slide.chart
            ? !['chart-editorial', 'ranking-bars'].includes(silhouette)
            : slide.metrics.length
                ? !['metric-spotlight', 'metric-scoreboard', 'status-dashboard'].includes(silhouette)
                : slide.comparison
                    ? !['comparison-split', 'comparison-cards'].includes(silhouette)
                    : slide.steps.length
                        ? !['process-horizontal', 'process-stacked', 'milestone-timeline'].includes(silhouette)
                        : slide.quote
                            ? !['quote-stage', 'quote-full-bleed'].includes(silhouette)
                            : slide.items.length >= 2
                                ? !['collection-columns', 'collection-mosaic', 'collection-list', 'collection-list-banded', 'event-ledger', 'source-index'].includes(silhouette)
                                : false;
        if (contentLayoutMismatch) {
            issues.push({
                severity: 'error',
                code: 'structured_content_layout_mismatch',
                slide: index + 1,
                message: `The resolved ${silhouette} layout cannot render all structured content on this slide.`,
            });
        }
        if (slide.imagePath
            && ['diagram', 'map', 'logo', 'screenshot'].includes(slide.imageKind)
            && slide.imageFit === 'cover') {
            issues.push({
                severity: 'error',
                code: 'semantic_image_must_contain',
                slide: index + 1,
                message: 'Diagrams, maps, logos, and screenshots must use contain so labels and boundaries are not cropped.',
            });
        }
        if (slide.imagePath
            && ['diagram', 'map', 'logo', 'screenshot'].includes(slide.imageKind)
            && ['circle', 'arch', 'soft-edge'].includes(slide.imageMask)) {
            issues.push({
                severity: 'error',
                code: 'semantic_image_mask_unsafe',
                slide: index + 1,
                message: 'Diagrams, maps, logos, and screenshots may use none or rounded-rect masks only; decorative masks can hide labels or boundaries.',
            });
        }
    });

    if (plan.slides.length >= 6 && compositionCounts.size < 3) {
        issues.push({
            severity: 'warning',
            code: 'deck_visual_monotony',
            message: 'A deck of this length should normally use at least three distinct composition families.',
        });
    }
    if (plan.slides.length >= 6 && designSignatures.size < 3) {
        issues.push({
            severity: 'warning',
            code: 'layout_rhythm_monotony',
            message: 'The deck uses too few composition and layout combinations to create an intentional visual rhythm.',
        });
    }
    if (plan.slides.length >= 8 && layoutSummary.distinctSilhouettes < 4) {
        issues.push({
            severity: marketingDeck ? 'error' : 'warning',
            code: 'layout_silhouette_variety_too_low',
            message: 'The deck uses fewer than four concrete page silhouettes; plan the whole-deck rhythm before rendering.',
        });
    }
    if (layoutSummary.longestSilhouetteRun > 2 || layoutSummary.adjacentDuplicates > Math.max(1, Math.floor(plan.slides.length * 0.12))) {
        issues.push({
            severity: marketingDeck ? 'error' : 'warning',
            code: 'layout_fingerprint_repetition',
            message: 'Concrete page skeletons repeat too often. Adjacent slides must change visual silhouette, not only color or copy.',
        });
    }
    if (plan.slides.length >= 10 && layoutSummary.dominantSilhouetteShare > 0.34) {
        issues.push({
            severity: 'warning',
            code: 'layout_silhouette_dominates_deck',
            message: 'One concrete page skeleton occupies more than a third of the deck and weakens the visual rhythm.',
        });
    }
    if (marketingDeck && plan.slides.length >= 4) {
        const ending = plan.slides[plan.slides.length - 1];
        if (!['closing', 'quote'].includes(ending.resolvedLayout.family)) {
            issues.push({
                severity: 'error',
                code: 'marketing_closing_layout_required',
                slide: plan.slides.length,
                message: 'A marketing deck must end with a closing layout that resolves the narrative and gives the audience a next action.',
            });
        } else if (!ending.body && !ending.bullets.length && !ending.items.length && !ending.attribution) {
            issues.push({
                severity: 'warning',
                code: 'marketing_closing_missing_action_detail',
                slide: plan.slides.length,
                message: 'The closing page contains only a slogan. Add a concrete next step, contact detail, service promise, or handoff instruction.',
            });
        }
    }
    return issues;
}
