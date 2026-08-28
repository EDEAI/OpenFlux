/** Deterministic content-capacity planning before slide parsing and rendering. */

export interface PresentationCapacitySplit {
    sourceSlide: number;
    outputSlides: number;
    reasons: string[];
}

export interface PresentationCapacityMerge {
    sourceSlides: number[];
    outputSlides: 1;
    reason: 'continuation_reflow';
}

export interface PresentationCapacityResult {
    args: Record<string, unknown>;
    expanded: boolean;
    originalSlideCount: number;
    slideCount: number;
    insertedSlides: number;
    mergedSlides: number;
    splits: PresentationCapacitySplit[];
    merges: PresentationCapacityMerge[];
    /** Maps each rendered slide back to the caller-authored slide that supplied
     * its facts. The mapping survives durable sample retries and pagination. */
    slideOrigins: number[];
}

export interface PresentationCapacityOptions {
    /** A stored design is already paginated and its concrete slide numbers are
     * the revision contract. Re-coalescing those pages would make a patch for
     * rendered slide N silently address a different page. */
    coalesceContinuations?: boolean;
}

type RawSlide = Record<string, unknown>;

export const COMPACT_COLLECTION_CAPACITY = 10;
export const CARD_COLLECTION_CAPACITY = 4;
/** The comparison renderer has a 2.84in reading rail per side and dynamically
 * fits copy down to 13pt. Six concise rows fit that real geometry; keeping the
 * planner at five manufactured a one-row continuation for common 6-vs-3
 * rankings, which the orphan-page quality gate then correctly rejected. */
export const COMPARISON_SIDE_CAPACITY = 6;
export const PROCESS_CAPACITY = 6;
export const NARRATIVE_RAIL_MAX_UNITS = 210;
export const CHART_NARRATIVE_RAIL_MAX_UNITS = 300;
export const CHART_NARRATIVE_BULLET_MAX_UNITS = 128;

interface SlideSegment {
    slide: RawSlide;
    reason: string;
}

const CONTENT_KEYS = [
    'body', 'bullets', 'items', 'metrics', 'steps', 'comparison', 'chart', 'quote', 'attribution',
] as const;

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function strings(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : [];
}

function objects(value: unknown): Record<string, unknown>[] {
    return Array.isArray(value)
        ? value.filter(item => item && typeof item === 'object' && !Array.isArray(item)).map(item => clone(record(item)))
        : [];
}

function visualUnits(value: unknown): number {
    if (typeof value !== 'string') return 0;
    return Array.from(value).reduce((sum, character) => sum + (/[^\x00-\xff]/.test(character) ? 2 : 1), 0);
}

export function fitsPresentationHeaderRail(value: unknown): boolean {
    return typeof value === 'string' && value.trim().length > 0 && visualUnits(value) <= 150;
}

/** A structured page may carry a short audience-facing explanation without
 * becoming a separate editorial continuation. This is intentionally semantic
 * rather than domain-specific: metrics, events, comparisons, and processes all
 * use the same bounded reading rail. */
export function fitsPresentationNarrativeRail(
    body: unknown,
    bulletValues: unknown,
    maxBullets: number,
    maxUnits = NARRATIVE_RAIL_MAX_UNITS,
    maxBulletUnits = 64,
): boolean {
    const bodyText = typeof body === 'string' ? body.trim() : '';
    const bullets = strings(bulletValues);
    if (!bodyText && !bullets.length) return false;
    if (bullets.length > maxBullets) return false;
    if (bodyText && visualUnits(bodyText) > 150) return false;
    if (bullets.some(item => visualUnits(item) > maxBulletUnits)) return false;
    return visualUnits(bodyText) + bullets.reduce((sum, item) => sum + visualUnits(item), 0) <= maxUnits;
}

/** Short records such as schedules, scores, contacts, and source indexes are
 * better represented as a two-column reading list than as oversized cards. */
export function isCompactCollection(items: Array<Record<string, unknown>>): boolean {
    const descriptionLimit = items.length <= 4 ? 160 : 86;
    const recordLimit = items.length <= 4 ? 196 : 112;
    return items.length >= 3
        && items.every(item => {
            const titleUnits = visualUnits(item.title);
            const descriptionUnits = visualUnits(item.description);
            return titleUnits > 0
                && titleUnits <= 58
                && descriptionUnits <= descriptionLimit
                && titleUnits + descriptionUnits <= recordLimit;
        });
}

/** Three peer recommendations or findings can carry substantially more copy
 * than three independent columns when they are rendered as a full-width,
 * stacked reading list. Measure every record against that real geometry
 * instead of rejecting the page only because the aggregate character count is
 * high. The limits keep the body at presentation size (13pt or larger). */
export function fitsPresentationStackedCollection(items: Array<Record<string, unknown>>): boolean {
    if (items.length !== 3) return false;
    let totalUnits = 0;
    for (const item of items) {
        const titleUnits = visualUnits(item.title);
        const descriptionUnits = visualUnits(item.description);
        const recordUnits = titleUnits + descriptionUnits;
        if (titleUnits <= 0 || titleUnits > 72) return false;
        if (descriptionUnits <= 0 || descriptionUnits > 250) return false;
        if (recordUnits > 310) return false;
        totalUnits += recordUnits;
    }
    return totalUnits <= 840;
}

function bulletVisualWeight(value: string): number {
    return Math.max(1, Math.ceil(visualUnits(value) / 48));
}

function bulletChunks(items: string[], maxItems: number): string[][] {
    const totalWeight = items.reduce((sum, item) => sum + bulletVisualWeight(item), 0);
    if (items.length <= 3 && totalWeight <= maxItems + 1) return items.length ? [items] : [];
    // Four decision or action bullets are a common report-page pattern. The
    // full-width narrative renderer can show four two-line bullets at a
    // presentation-safe size, so do not manufacture an orphan continuation.
    if (items.length === 4 && totalWeight <= maxItems + 3) return [items];
    const groups: string[][] = [];
    let current: string[] = [];
    let currentWeight = 0;
    for (const item of items) {
        const weight = bulletVisualWeight(item);
        if (current.length > 0 && (current.length >= maxItems || currentWeight + weight > maxItems)) {
            groups.push(current);
            current = [];
            currentWeight = 0;
        }
        current.push(item);
        currentWeight += weight;
    }
    if (current.length) groups.push(current);
    return groups;
}

function bulletsExceedCapacity(items: string[], maxItems: number): boolean {
    const totalWeight = items.reduce((sum, item) => sum + bulletVisualWeight(item), 0);
    if (items.length === 4 && totalWeight <= maxItems + 3) return false;
    return items.length > maxItems
        || totalWeight > maxItems;
}

function chunks<T>(items: T[], size: number): T[][] {
    const result: T[][] = [];
    for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
    return result;
}

/** Keep continuation pages visually balanced. A capacity of ten with eleven
 * records should yield 6 + 5, not a dense first page followed by an orphan. */
export function balancedChunks<T>(items: T[], capacity: number): T[][] {
    if (!items.length) return [];
    const pageCount = Math.ceil(items.length / capacity);
    const baseSize = Math.floor(items.length / pageCount);
    const largerPageCount = items.length % pageCount;
    const result: T[][] = [];
    let offset = 0;
    for (let page = 0; page < pageCount; page++) {
        const pageSize = baseSize + (page < largerPageCount ? 1 : 0);
        result.push(items.slice(offset, offset + pageSize));
        offset += pageSize;
    }
    return result;
}

function explicitInformationRole(slide: RawSlide): string {
    return String(slide.information_role || slide.informationRole || '').trim().toLowerCase();
}

function isIntentionalClosingSlide(slide: RawSlide): boolean {
    const composition = String(slide.composition || '').trim().toLowerCase();
    const archetype = String(record(slide.layout).archetype || '').trim().toLowerCase();
    return composition === 'closing'
        || archetype === 'closing'
        || explicitInformationRole(slide) === 'action';
}

function comparableText(value: unknown): string {
    return typeof value === 'string'
        ? value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
        : '';
}

/** A closing quote is often repeated verbatim in the closing body. Treating
 * that duplicate as a second content channel created an empty-looking final
 * page and repeated both copy and imagery. A genuinely distinct quote remains
 * an intentional, low-density ending page. */
function independentQuote(source: RawSlide): string | undefined {
    const quote = typeof source.quote === 'string' ? source.quote.trim() : '';
    if (!quote) return undefined;
    const body = comparableText(source.body);
    const normalizedQuote = comparableText(quote);
    if (isIntentionalClosingSlide(source) && body && normalizedQuote && body.includes(normalizedQuote)) {
        return undefined;
    }
    return quote;
}

/** A short action/detail rail belongs on the same final canvas as its quote.
 * Splitting these two bounded pieces created consecutive closing pages that
 * looked intentional to mechanical QA but were editorially redundant. */
function closingQuoteConsumesNarrative(source: RawSlide): boolean {
    return Boolean(independentQuote(source))
        && isIntentionalClosingSlide(source)
        && fitsPresentationNarrativeRail(source.body, source.bullets, 2, 130, 56);
}

/** Models sometimes encode a list of peer events in `steps`, which used to
 * force a timeline renderer. Information role is the stronger signal: events
 * are records, not dependencies, so normalize the channel before pagination. */
function normalizeSemanticChannels(slide: RawSlide): RawSlide {
    const normalized = clone(slide);
    const role = explicitInformationRole(normalized);
    const items = objects(normalized.items);
    const steps = objects(normalized.steps);
    if (role === 'events' && !items.length && steps.length) {
        normalized.items = steps;
        delete normalized.steps;
        normalized.composition = 'grid';
        const layout = record(normalized.layout);
        normalized.layout = {
            ...layout,
            archetype: 'collection',
            variant: 'auto',
            emphasis: layout.emphasis || 'balanced',
        };
    }
    if (typeof normalized.quote === 'string' && normalized.quote.trim() && !independentQuote(normalized)) {
        delete normalized.quote;
        delete normalized.attribution;
    }
    return normalized;
}

function withoutContent(slide: RawSlide): RawSlide {
    const result = clone(slide);
    for (const key of CONTENT_KEYS) delete result[key];
    return result;
}

function withoutImage(slide: RawSlide): RawSlide {
    const result = clone(slide);
    for (const key of [
        'image_path', 'imagePath', 'image_url', 'imageUrl',
        'image_alt', 'imageAlt', 'image_kind', 'imageKind',
        'image_fit', 'imageFit', 'image_focus', 'imageFocus',
        'image_mask', 'imageMask', 'image_source_url', 'imageSourceUrl',
        'image_credit', 'imageCredit',
    ]) {
        delete result[key];
    }
    return result;
}

function semanticSlide(
    base: RawSlide,
    composition: string,
    archetype: string,
    emphasis: string,
    content: Record<string, unknown>,
    preserveImage = false,
): RawSlide {
    const clean = preserveImage ? withoutContent(base) : withoutImage(withoutContent(base));
    const sourceLayout = record(base.layout);
    return {
        ...clean,
        ...content,
        composition,
        layout: {
            ...sourceLayout,
            archetype,
            variant: 'auto',
            emphasis,
        },
    };
}

function continuationLabel(value: unknown, part: number, total: number): string | undefined {
    if (typeof value !== 'string' || !value.trim()) return undefined;
    const suffix = /[^\x00-\xff]/.test(value) ? `（${part}/${total}）` : ` (${part}/${total})`;
    return `${value.trim()}${suffix}`;
}

interface ContinuationMarker {
    part: number;
    total: number;
}

function continuationMarker(slide: RawSlide): ContinuationMarker | undefined {
    for (const value of [slide.title, slide.message]) {
        if (typeof value !== 'string') continue;
        const match = value.match(/[（(](\d+)\s*\/\s*(\d+)[）)]\s*$/);
        if (!match) continue;
        const part = Number(match[1]);
        const total = Number(match[2]);
        if (part >= 1 && total >= 2 && part <= total) return { part, total };
    }
    return undefined;
}

function stripContinuationLabel(value: unknown): string | undefined {
    if (typeof value !== 'string' || !value.trim()) return undefined;
    return value.replace(/\s*[（(]\d+\s*\/\s*\d+[）)]\s*$/, '').trim();
}

function sameContinuationSubject(first: RawSlide, next: RawSlide): boolean {
    const firstMessage = stripContinuationLabel(first.message) || '';
    const nextMessage = stripContinuationLabel(next.message) || '';
    const firstPurpose = typeof first.purpose === 'string' ? first.purpose.trim() : '';
    const nextPurpose = typeof next.purpose === 'string' ? next.purpose.trim() : '';
    return Boolean(firstMessage)
        && firstMessage === nextMessage
        && (!firstPurpose || !nextPurpose || firstPurpose === nextPurpose);
}

function uniqueStrings(values: string[]): string[] {
    return values.filter((value, index) => values.indexOf(value) === index);
}

/** Recombine legacy or model-authored continuation pages, then let the current
 * compatibility matrix decide whether they still require pagination. This
 * migrates old persisted designs without using domain-specific titles. */
function mergeContinuationGroup(group: RawSlide[]): RawSlide {
    const structured = group.find(slide => [
        Object.keys(record(slide.chart)).length > 0,
        objects(slide.metrics).length > 0,
        objects(slide.items).length > 0,
        objects(slide.steps).length > 0,
        Object.keys(record(slide.comparison)).length > 0,
        typeof slide.quote === 'string' && slide.quote.trim().length > 0,
    ].some(Boolean));
    const preferred = structured || group[0];
    const merged: RawSlide = {
        ...clone(group[0]),
        ...clone(preferred),
        purpose: group[0].purpose || preferred.purpose,
        message: stripContinuationLabel(group[0].message) || group[0].message,
        __openfluxSourceSlide: group[0].__openfluxSourceSlide
            || preferred.__openfluxSourceSlide,
    };
    const title = stripContinuationLabel(group[0].title);
    if (title) merged.title = title;
    else delete merged.title;

    const bodies = uniqueStrings(group
        .map(slide => typeof slide.body === 'string' ? slide.body.trim() : '')
        .filter(Boolean));
    const bullets = uniqueStrings(group.flatMap(slide => strings(slide.bullets)));
    const items = group.flatMap(slide => objects(slide.items));
    const metrics = group.flatMap(slide => objects(slide.metrics));
    const steps = group.flatMap(slide => objects(slide.steps));
    const sources = uniqueStrings(group.flatMap(slide => strings(slide.sources)));
    const notes = uniqueStrings(group
        .map(slide => typeof slide.speaker_notes === 'string' ? slide.speaker_notes.trim() : '')
        .filter(Boolean));

    for (const key of CONTENT_KEYS) delete merged[key];
    if (bodies.length) merged.body = bodies.join('\n');
    if (bullets.length) merged.bullets = bullets;
    if (items.length) merged.items = items;
    if (metrics.length) merged.metrics = metrics;
    if (steps.length) merged.steps = steps;
    for (const key of ['chart', 'quote', 'attribution'] as const) {
        const owner = group.find(slide => key === 'chart'
            ? Object.keys(record(slide[key])).length > 0
            : typeof slide[key] === 'string' && slide[key].trim().length > 0);
        if (owner) merged[key] = clone(owner[key]);
    }
    const comparisonPages = group
        .map(slide => record(slide.comparison))
        .filter(comparison => Object.keys(comparison).length > 0);
    if (comparisonPages.length) {
        const firstLeft = record(comparisonPages[0].left);
        const firstRight = record(comparisonPages[0].right);
        const leftItems = uniqueStrings(comparisonPages.flatMap(comparison => {
            const side = record(comparison.left);
            return strings(side.items || side.bullets);
        }));
        const rightItems = uniqueStrings(comparisonPages.flatMap(comparison => {
            const side = record(comparison.right);
            return strings(side.items || side.bullets);
        }));
        if (leftItems.length && rightItems.length) {
            merged.comparison = {
                left: { ...clone(firstLeft), items: leftItems },
                right: { ...clone(firstRight), items: rightItems },
            };
        }
    }
    if (sources.length) merged.sources = sources;
    if (notes.length) merged.speaker_notes = notes.join('\n\n');
    return merged;
}

function coalesceContinuationSlides(slides: RawSlide[]): { slides: RawSlide[]; merges: PresentationCapacityMerge[] } {
    const output: RawSlide[] = [];
    const merges: PresentationCapacityMerge[] = [];
    for (let index = 0; index < slides.length;) {
        const marker = continuationMarker(slides[index]);
        if (!marker || marker.part !== 1) {
            output.push(slides[index]);
            index += 1;
            continue;
        }
        const group = [slides[index]];
        for (let offset = 1; offset < marker.total && index + offset < slides.length; offset++) {
            const candidate = slides[index + offset];
            const candidateMarker = continuationMarker(candidate);
            if (!candidateMarker
                || candidateMarker.total !== marker.total
                || candidateMarker.part !== offset + 1
                || !sameContinuationSubject(slides[index], candidate)) break;
            group.push(candidate);
        }
        if (group.length !== marker.total) {
            output.push(slides[index]);
            index += 1;
            continue;
        }
        output.push(mergeContinuationGroup(group));
        merges.push({
            sourceSlides: Array.from({ length: marker.total }, (_, offset) => index + offset + 1),
            outputSlides: 1,
            reason: 'continuation_reflow',
        });
        index += marker.total;
    }
    return { slides: output, merges };
}

function labelSegments(source: RawSlide, segments: SlideSegment[]): SlideSegment[] {
    if (segments.length <= 1) return segments;
    if (isIntentionalClosingSlide(source)) {
        return segments.map(segment => ({
            ...segment,
            slide: {
                ...clone(segment.slide),
                __openfluxBoundaryRole: 'closing',
            },
        }));
    }
    // Separate semantic channels (for example, an explanatory page followed
    // by a pull quote) are independent editorial beats, not capacity-driven
    // continuation pages. Labelling them 1/2 and 2/2 makes the intentionally
    // sparse quote look like an orphan and weakens both titles.
    const capacitySplit = segments.some(segment => segment.reason !== 'mixed_content_channels');
    if (!capacitySplit) return segments;
    return segments.map((segment, index) => {
        const slide = clone(segment.slide);
        const title = continuationLabel(source.title, index + 1, segments.length);
        if (title) slide.title = title;
        else {
            const message = continuationLabel(source.message, index + 1, segments.length);
            if (message) slide.message = message;
        }
        return { ...segment, slide };
    });
}

function expandComparison(source: RawSlide, base: RawSlide): SlideSegment[] {
    const comparison = record(source.comparison);
    const left = record(comparison.left);
    const right = record(comparison.right);
    const leftItems = strings(left.items || left.bullets);
    const rightItems = strings(right.items || right.bullets);
    if (!leftItems.length || !rightItems.length) return [];
    const pages = Math.max(
        Math.ceil(leftItems.length / COMPARISON_SIDE_CAPACITY),
        Math.ceil(rightItems.length / COMPARISON_SIDE_CAPACITY),
    );
    return Array.from({ length: pages }, (_, index) => ({
        reason: pages > 1 ? 'comparison_capacity' : 'mixed_content_channels',
        slide: semanticSlide(base, 'comparison', 'comparison', 'balanced', {
            comparison: {
                left: {
                    ...clone(left),
                    items: leftItems.slice(
                        index * COMPARISON_SIDE_CAPACITY,
                        index * COMPARISON_SIDE_CAPACITY + COMPARISON_SIDE_CAPACITY,
                    ),
                },
                right: {
                    ...clone(right),
                    items: rightItems.slice(
                        index * COMPARISON_SIDE_CAPACITY,
                        index * COMPARISON_SIDE_CAPACITY + COMPARISON_SIDE_CAPACITY,
                    ),
                },
            },
        }),
    }));
}

/** Maximum short narrative bullets that the single structured renderer on a
 * slide can show. Zero means the combination needs separate pages. */
function narrativeRailBulletCapacity(source: RawSlide): number {
    const items = objects(source.items);
    const metrics = objects(source.metrics);
    const steps = objects(source.steps);
    const chart = Object.keys(record(source.chart)).length > 0;
    const comparison = record(source.comparison);
    const leftItems = strings(record(comparison.left).items || record(comparison.left).bullets);
    const rightItems = strings(record(comparison.right).items || record(comparison.right).bullets);
    const quote = Boolean(independentQuote(source));
    const channels = [
        chart,
        metrics.length > 0,
        items.length > 0,
        steps.length > 0,
        Boolean(leftItems.length && rightItems.length),
        quote,
    ].filter(Boolean).length;
    if (channels !== 1) return 0;
    if (chart) return source.body ? 3 : 4;
    if (metrics.length > 0 && metrics.length <= 4) return 3;
    if (isCompactCollection(items)) {
        if (items.length <= 8) return 2;
        // A header-sized body already has a dedicated rail in the compact list
        // renderer even when the collection itself paginates. Dense lists do
        // not also accept bullets.
        if (!strings(source.bullets).length) return 1;
    }
    if (steps.length > 0 && steps.length <= 5) return 2;
    if (leftItems.length > 0 && leftItems.length <= 4 && rightItems.length > 0 && rightItems.length <= 4) return 2;
    return 0;
}

function expandSlide(source: RawSlide, bulletLimit: number): SlideSegment[] {
    const base = clone(source);
    const body = typeof source.body === 'string' && source.body.trim() ? source.body.trim() : undefined;
    const bullets = strings(source.bullets);
    const items = objects(source.items);
    const metrics = objects(source.metrics);
    const steps = objects(source.steps);
    const chart = Object.keys(record(source.chart)).length ? clone(record(source.chart)) : undefined;
    const quote = independentQuote(source);
    const comparisonSegments = expandComparison(source, base);
    const segments: SlideSegment[] = [];
    const compactCollection = isCompactCollection(items);
    const itemCapacity = compactCollection ? COMPACT_COLLECTION_CAPACITY : CARD_COLLECTION_CAPACITY;
    const narrativeRailCapacity = narrativeRailBulletCapacity(source);
    const railBullets = bullets.slice(0, narrativeRailCapacity);
    const rendererConsumesNarrative = narrativeRailCapacity > 0
        && fitsPresentationNarrativeRail(
            body,
            railBullets,
            narrativeRailCapacity,
            chart ? CHART_NARRATIVE_RAIL_MAX_UNITS : NARRATIVE_RAIL_MAX_UNITS,
            chart ? CHART_NARRATIVE_BULLET_MAX_UNITS : 64,
        );
    const consumedBulletCount = rendererConsumesNarrative ? railBullets.length : 0;
    const rendererBody = rendererConsumesNarrative && body ? body : undefined;
    const rendererBullets = rendererConsumesNarrative && railBullets.length ? railBullets : undefined;
    const closingIntent = isIntentionalClosingSlide(source);
    const compactClosingQuote = closingQuoteConsumesNarrative(source);
    let closingQuoteSegment: SlideSegment | undefined;

    // Structured renderers intentionally support one bounded reading rail.
    // Overflow becomes an editorial continuation instead of a mostly-empty
    // companion page or silently shrunken copy.
    if (chart) {
        segments.push({
            reason: 'mixed_content_channels',
            slide: semanticSlide(base, 'data', 'evidence', 'data', {
                chart,
                ...(rendererBody ? { body: rendererBody } : {}),
                ...(rendererBullets ? { bullets: rendererBullets } : {}),
            }),
        });
    }

    for (const [index, group] of chunks(metrics, 4).entries()) {
        segments.push({
            reason: metrics.length > 4 ? 'metric_capacity' : 'mixed_content_channels',
            slide: semanticSlide(base, 'data', 'evidence', 'data', {
                metrics: group,
                ...(index === 0 && rendererBody ? { body: rendererBody } : {}),
                ...(index === 0 && rendererBullets ? { bullets: rendererBullets } : {}),
            }),
        });
    }
    for (const [index, group] of balancedChunks(items, itemCapacity).entries()) {
        segments.push({
            reason: items.length > itemCapacity ? 'collection_capacity' : 'mixed_content_channels',
            slide: semanticSlide(base, 'grid', 'collection', 'balanced', {
                items: group,
                ...(index === 0 && rendererBody ? { body: rendererBody } : {}),
                ...(index === 0 && rendererBullets ? { bullets: rendererBullets } : {}),
            }),
        });
    }
    for (const [index, group] of balancedChunks(steps, PROCESS_CAPACITY).entries()) {
        segments.push({
            reason: steps.length > PROCESS_CAPACITY ? 'process_capacity' : 'mixed_content_channels',
            slide: semanticSlide(base, 'sequence', 'process', 'balanced', {
                steps: group,
                ...(index === 0 && rendererBody ? { body: rendererBody } : {}),
                ...(index === 0 && rendererBullets ? { bullets: rendererBullets } : {}),
            }),
        });
    }
    segments.push(...comparisonSegments.map((segment, index) => ({
        ...segment,
        slide: {
            ...segment.slide,
            ...(index === 0 && rendererBody ? { body: rendererBody } : {}),
            ...(index === 0 && rendererBullets ? { bullets: rendererBullets } : {}),
        },
    })));
    if (quote) {
        const quoteSegment: SlideSegment = {
            reason: 'mixed_content_channels',
            slide: semanticSlide(base, 'quote', 'quote', 'message', {
                quote,
                ...(typeof source.attribution === 'string' ? { attribution: source.attribution } : {}),
                ...(compactClosingQuote && body ? { body } : {}),
                ...(compactClosingQuote && bullets.length ? { bullets } : {}),
            }, true),
        };
        if (compactClosingQuote) segments.push(quoteSegment);
        else if (closingIntent && Boolean(body || bullets.length)) closingQuoteSegment = quoteSegment;
        else segments.push(quoteSegment);
    }

    const structuredCount = Number(Boolean(chart))
        + Number(metrics.length > 0)
        + Number(items.length > 0)
        + Number(steps.length > 0)
        + Number(comparisonSegments.length > 0)
        + Number(Boolean(quote));
    const remainingBullets = compactClosingQuote ? [] : bullets.slice(consumedBulletCount);
    const needsNarrative = (!rendererBody && !compactClosingQuote && Boolean(body))
        || remainingBullets.length > 0
        || structuredCount === 0;
    if (needsNarrative) {
        const bulletPages = bulletChunks(remainingBullets, bulletLimit);
        if (!bulletPages.length) bulletPages.push([]);
        const narrativeSegments = bulletPages.map((group, index): SlideSegment => {
            const originalComposition = typeof source.composition === 'string' ? source.composition : '';
            const closing = closingIntent;
            const cover = originalComposition === 'focal' && structuredCount === 0 && index === 0;
            return {
                reason: bulletsExceedCapacity(remainingBullets, bulletLimit) ? 'bullet_capacity' : 'mixed_content_channels',
                slide: semanticSlide(
                    base,
                    closing ? 'closing' : cover ? 'focal' : 'narrative',
                    closing ? 'closing' : cover ? 'cover' : 'editorial',
                    cover ? 'visual' : 'message',
                    {
                        ...(body && index === 0 ? { body } : {}),
                        ...(group.length ? { bullets: group } : {}),
                    },
                    closing ? !quote : true,
                ),
            };
        });
        if (closingIntent && segments.length) {
            segments.push(...narrativeSegments);
        } else {
            segments.unshift(...narrativeSegments);
        }
    }
    if (closingQuoteSegment) segments.push(closingQuoteSegment);

    return labelSegments(source, segments);
}

function capacityReasons(source: RawSlide, bulletLimit: number): string[] {
    const bullets = strings(source.bullets);
    const items = objects(source.items);
    const metrics = objects(source.metrics);
    const steps = objects(source.steps);
    const comparison = record(source.comparison);
    const leftItems = strings(record(comparison.left).items || record(comparison.left).bullets);
    const rightItems = strings(record(comparison.right).items || record(comparison.right).bullets);
    const chart = Object.keys(record(source.chart)).length > 0;
    const quote = Boolean(independentQuote(source));
    const compactClosingQuote = closingQuoteConsumesNarrative(source);
    const compactCollection = isCompactCollection(items);
    const hasImage = Boolean(
        (typeof source.image_path === 'string' && source.image_path.trim())
        || (typeof source.imagePath === 'string' && source.imagePath.trim())
        || (typeof source.image_url === 'string' && source.image_url.trim())
        || (typeof source.imageUrl === 'string' && source.imageUrl.trim()),
    );
    const itemCapacity = compactCollection ? COMPACT_COLLECTION_CAPACITY : CARD_COLLECTION_CAPACITY;
    const channels = [chart, metrics.length > 0, items.length > 0, steps.length > 0, Boolean(leftItems.length && rightItems.length), quote]
        .filter(Boolean).length;
    const reasons: string[] = [];
    if (items.length > itemCapacity) reasons.push('collection_capacity');
    if (metrics.length > 4) reasons.push('metric_capacity');
    if (steps.length > PROCESS_CAPACITY) reasons.push('process_capacity');
    if (leftItems.length > COMPARISON_SIDE_CAPACITY || rightItems.length > COMPARISON_SIDE_CAPACITY) {
        reasons.push('comparison_capacity');
    }
    if (channels > 1) reasons.push('mixed_content_channels');
    const railCapacity = narrativeRailBulletCapacity(source);
    const narrativePresent = Boolean(source.body) || bullets.length > 0;
    const railConsumesNarrative = compactClosingQuote || (railCapacity > 0
        && fitsPresentationNarrativeRail(
            source.body,
            bullets.slice(0, railCapacity),
            railCapacity,
            chart ? CHART_NARRATIVE_RAIL_MAX_UNITS : NARRATIVE_RAIL_MAX_UNITS,
            chart ? CHART_NARRATIVE_BULLET_MAX_UNITS : 64,
        ));
    if (channels === 0 && bulletsExceedCapacity(bullets, bulletLimit)) reasons.push('bullet_capacity');
    if (channels === 1 && narrativePresent && (!railConsumesNarrative || (!compactClosingQuote && bullets.length > railCapacity))) {
        reasons.push('narrative_rail_capacity');
    }

    const requestedArchetype = String(record(source.layout).archetype || '').toLowerCase();
    const expectedArchetype = chart || metrics.length
        ? 'evidence'
        : items.length ? 'collection'
            : steps.length ? 'process'
                : leftItems.length && rightItems.length ? 'comparison'
                    : quote ? 'quote'
                        : hasImage ? 'image'
                            : bullets.length || Boolean(source.body) ? 'editorial' : '';
    const boundaryArchetype = ['cover', 'section', 'closing'].includes(requestedArchetype);
    if (expectedArchetype && requestedArchetype && !boundaryArchetype
        && !['auto', expectedArchetype].includes(requestedArchetype)) {
        reasons.push('structured_layout_mismatch');
    }
    return [...new Set(reasons)];
}

/**
 * Expand dense or renderer-incompatible slide payloads before parsing. The
 * returned args are idempotent and are safe to persist as the durable design,
 * so visual-review slide numbers continue to address the rendered deck.
 */
export function fitPresentationArgsToCapacity(
    args: Record<string, unknown>,
    options: PresentationCapacityOptions = {},
): PresentationCapacityResult {
    const result = clone(args);
    const slides = Array.isArray(result.slides)
        ? result.slides.map((item, index) => {
            const normalized = normalizeSemanticChannels(record(item));
            const existingOrigin = Math.trunc(Number(normalized.__openfluxSourceSlide));
            normalized.__openfluxSourceSlide = existingOrigin > 0 ? existingOrigin : index + 1;
            return normalized;
        })
        : [];
    if (!slides.length) {
        return {
            args: result,
            expanded: false,
            originalSlideCount: 0,
            slideCount: 0,
            insertedSlides: 0,
            mergedSlides: 0,
            splits: [],
            merges: [],
            slideOrigins: [],
        };
    }
    const artDirection = record(result.art_direction || result.artDirection);
    const density = String(artDirection.density || 'balanced').toLowerCase();
    const brief = record(result.brief);
    const deliveryMode = String(brief.delivery_mode || brief.deliveryMode || 'marketing').toLowerCase();
    const bulletLimit = deliveryMode === 'report' || deliveryMode === 'reference'
        ? 6
        : density === 'compact' ? 6 : density === 'airy' ? 4 : 5;
    const coalesced = options.coalesceContinuations === false
        ? { slides, merges: [] }
        : coalesceContinuationSlides(slides);
    const expandedSlides: RawSlide[] = [];
    const splits: PresentationCapacitySplit[] = [];

    coalesced.slides.forEach((slide, index) => {
        const reasons = capacityReasons(slide, bulletLimit);
        if (!reasons.length) {
            expandedSlides.push(slide);
            return;
        }
        const segments = expandSlide(slide, bulletLimit);
        expandedSlides.push(...segments.map(segment => segment.slide));
        splits.push({
            sourceSlide: Math.trunc(Number(slide.__openfluxSourceSlide)) || index + 1,
            outputSlides: segments.length,
            reasons: [...new Set([...reasons, ...segments.map(segment => segment.reason)])],
        });
    });

    if (expandedSlides.length > 40) {
        throw new Error(`Automatic presentation pagination requires ${expandedSlides.length} slides, above the 40-slide safety limit. Curate or shorten the source content.`);
    }
    result.slides = expandedSlides;
    return {
        args: result,
        expanded: splits.length > 0,
        originalSlideCount: slides.length,
        slideCount: expandedSlides.length,
        insertedSlides: splits.reduce((sum, split) => sum + Math.max(0, split.outputSlides - 1), 0),
        mergedSlides: coalesced.merges.reduce((sum, merge) => sum + merge.sourceSlides.length - 1, 0),
        splits,
        merges: coalesced.merges,
        slideOrigins: expandedSlides.map((slide, index) => (
            Math.trunc(Number(slide.__openfluxSourceSlide)) || index + 1
        )),
    };
}
