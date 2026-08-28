/** Design-first local PowerPoint generation tool (generate_presentation). */

import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { promises as fs } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import sharp from 'sharp';
import type { Tool, ToolExecutionContext, ToolResult } from '../types';
import { Logger } from '../../utils/logger';
import {
    evaluatePresentationPlan,
    MAX_PRESENTATION_REVISIONS,
    PRESENTATION_DECK_SCORE_THRESHOLD,
    PRESENTATION_DIRECTION_SCORE_THRESHOLD,
    PRESENTATION_ORIGINALITY_SCORE_THRESHOLD,
    PRESENTATION_SLIDE_SCORE_THRESHOLD,
    PRESENTATION_THEME_SCORE_THRESHOLD,
    parsePresentationPlan,
    selectRepresentativeSlides,
    type PresentationDeckPlan,
    type PresentationQualityIssue,
} from './model';
import { renderPresentation, type RenderPresentationResult } from './renderer';
import { planPresentationLayouts, summarizePresentationLayouts } from './layout-engine';
import {
    exportPresentationWithPowerPoint,
    type PresentationExportOptions,
    type PresentationExportResult,
} from './exporter';
import {
    loadPresentationDesign,
    resolvePresentationDesignArgs,
    savePresentationDesign,
    validatePresentationRevisionPatches,
    validatePresentationSampleRetry,
} from './design-store';
import {
    inspectPresentationImageGeometry,
    type PresentationImageQaResult,
} from './image-qa';
import { inspectRenderedPresentation } from './rendered-qa';
import {
    createPresentationWorkflowState,
    evaluatePresentationCompletion,
    readPresentationWorkflowState,
    reviewedEverySlide,
    type PresentationWorkflowState,
} from './workflow';
import {
    applyPresentationDirectionToArgs,
    createPresentationVisualDirections,
    type PresentationVisualDirection,
} from './directions';
import { fitPresentationArgsToCapacity, type PresentationCapacityResult } from './capacity';

interface PresentationPreviewImage {
    mimeType: string;
    data: string;
}

interface PresentationDirectionPreview {
    id: string;
    name: string;
    description: string;
    slideNumbers: number[];
    images: PresentationPreviewImage[];
}

const log = new Logger('PresentationGen');

export interface PresentationGenToolOptions {
    /** Base directory for generated deliverables and relative image paths. */
    getOutputPath?: () => string;
    /** Injectable exporter for tests or platform-specific implementations. */
    exportPresentation?: (options: PresentationExportOptions) => Promise<PresentationExportResult>;
    /** Optional AppData root override used by tests and portable runtimes. */
    getDesignStorePath?: () => string;
    /** Force the durable workflow gate on or off. Agent calls enable it by default. */
    enforceWorkflow?: boolean;
}

function abortError(signal?: AbortSignal): Error {
    const reason = signal?.reason;
    const error = new Error(reason instanceof Error ? reason.message : 'Presentation generation aborted');
    error.name = 'AbortError';
    return error;
}

function isWithin(basePath: string, targetPath: string): boolean {
    const rel = relative(resolve(basePath), resolve(targetPath));
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function bool(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

function string(value: unknown): string | undefined {
    const result = typeof value === 'string' ? value.trim() : '';
    return result || undefined;
}

function object(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const STRUCTURE_PREFLIGHT_ERROR_CODES = new Set([
    'revision_number_required',
    'visual_review_required',
    'communication_job_required',
    'narrative_arc_required',
    'marketing_deck_too_long',
    'content_too_dense',
    'layout_capacity_exceeded',
    'orphaned_continuation_page',
    'structured_content_layout_mismatch',
    'semantic_image_must_contain',
    'semantic_image_mask_unsafe',
]);

function addCapacityOrigin(
    issue: PresentationQualityIssue,
    renderedSlide: number,
    capacityPlan: PresentationCapacityResult,
): PresentationQualityIssue {
    const sourceSlide = capacityPlan.slideOrigins[renderedSlide - 1] || renderedSlide;
    const originNote = sourceSlide !== renderedSlide
        ? ` Caller-authored slide ${sourceSlide} produced rendered slide ${renderedSlide} after automatic pagination.`
        : '';
    return {
        ...issue,
        slide: renderedSlide,
        sourceSlide,
        message: originNote && !issue.message.includes('Caller-authored slide')
            ? `${issue.message}${originNote}`
            : issue.message,
    };
}

function mapDeckIssuesToOrigins(
    issues: PresentationQualityIssue[],
    capacityPlan: PresentationCapacityResult,
): PresentationQualityIssue[] {
    return issues.map(issue => issue.slide
        ? addCapacityOrigin(issue, issue.slide, capacityPlan)
        : issue);
}

/** Native QA numbers slides within the three-page sample. Translate those
 * positions back to durable deck slide numbers before the Agent chooses a
 * repair target. */
function mapSampleIssuesToDeck(
    issues: PresentationQualityIssue[],
    sampleSlideNumbers: number[],
    capacityPlan: PresentationCapacityResult,
): PresentationQualityIssue[] {
    return issues.map(issue => {
        if (!issue.slide) return issue;
        const samplePosition = issue.slide;
        const deckSlide = sampleSlideNumbers[samplePosition - 1];
        if (!deckSlide) return issue;
        const rewritten = samplePosition === deckSlide
            ? issue.message
            : issue.message.replace(
                new RegExp(`\\bslide ${samplePosition}\\b`, 'gi'),
                `deck slide ${deckSlide}`,
            );
        return addCapacityOrigin({ ...issue, message: rewritten }, deckSlide, capacityPlan);
    });
}

function argsWithDesignId(args: Record<string, unknown>, designId: string): Record<string, unknown> {
    return {
        ...args,
        design_id: designId,
        workflow: { ...object(args.workflow), design_id: designId },
    };
}

interface PresentationQualityState {
    revision: number;
    errors: number;
    warnings: number;
}

function qualityState(issues: PresentationQualityIssue[], revision: number): PresentationQualityState {
    return {
        revision,
        errors: issues.filter(issue => issue.severity === 'error').length,
        warnings: issues.filter(issue => issue.severity === 'warning').length,
    };
}

function readQualityState(args: Record<string, unknown>): PresentationQualityState | undefined {
    const source = object(args.__quality_state);
    const revision = Number(source.revision);
    const errors = Number(source.errors);
    const warnings = Number(source.warnings);
    if (![revision, errors, warnings].every(Number.isFinite)) return undefined;
    return { revision, errors, warnings };
}

function qualityRegressed(previous: PresentationQualityState, current: PresentationQualityState): boolean {
    return current.errors > previous.errors
        || (current.errors === previous.errors && current.warnings > previous.warnings);
}

function qaStatus(
    issues: PresentationQualityIssue[],
    regressed = false,
): PresentationWorkflowState['qa']['status'] {
    if (regressed) return 'regressed';
    if (issues.some(issue => issue.severity === 'error')) return 'needs_revision';
    return issues.length ? 'passed_with_warnings' : 'passed';
}

function visualReviewIssues(review: PresentationDeckPlan['workflow']['visualReview']): PresentationQualityIssue[] {
    return (review?.issues || []).map(issue => ({
        severity: issue.severity,
        code: `visual_${issue.category}`,
        message: `${issue.observation} Action: ${issue.action}`,
        slide: issue.slide,
    }));
}

async function runImageGeometryQa(pptxPath: string): Promise<PresentationImageQaResult> {
    try {
        return await inspectPresentationImageGeometry(pptxPath);
    } catch (error) {
        return {
            available: false,
            checkedImages: 0,
            issues: [{
                severity: 'error',
                code: 'image_geometry_qa_unavailable',
                message: `Image geometry QA could not inspect the generated PPTX: ${error instanceof Error ? error.message : String(error)}`,
            }],
        };
    }
}

async function loadPresentationPreviewImages(paths: string[]): Promise<PresentationPreviewImage[]> {
    const images: PresentationPreviewImage[] = [];
    for (const path of paths) {
        const data = await fs.readFile(path).catch(() => undefined);
        if (data?.length) images.push({ mimeType: 'image/png', data: data.toString('base64') });
    }
    return images;
}

function presentationVisionUnavailable(message: string, workflowState?: PresentationWorkflowState): ToolResult {
    return {
        ...structuredError(new Error(message), 'presentation_visual_review_unavailable'),
        data: workflowState ? {
            route: 'local_presentation',
            files: [],
            stage: workflowState.stage,
            designId: workflowState.designId,
            workflowState,
        } : undefined,
    };
}

function workflowTransitionError(message: string, workflowState?: PresentationWorkflowState): ToolResult {
    return {
        ...structuredError(new Error(message), 'presentation_workflow_transition_invalid'),
        data: workflowState ? {
            route: 'local_presentation',
            files: [],
            stage: workflowState.stage,
            designId: workflowState.designId,
            workflowState,
        } : undefined,
    };
}

function safeBaseName(value: string): string {
    return value
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
        .replace(/[.\s]+$/g, '')
        .trim()
        .slice(0, 90) || 'presentation';
}

function sanitizeFilename(value: unknown, title: string): string {
    const requested = string(value);
    if (requested && (/[\\/]/.test(requested) || requested === '.' || requested === '..')) {
        throw new Error('filename must be a plain file name without directory segments');
    }
    const fallback = `${safeBaseName(title)}.pptx`;
    const candidate = safeBaseName(requested || fallback);
    return candidate.toLowerCase().endsWith('.pptx') ? candidate : `${candidate}.pptx`;
}

async function chooseUniquePath(path: string): Promise<string> {
    try {
        await fs.access(path);
    } catch {
        return path;
    }
    const stem = path.slice(0, -5);
    for (let index = 2; index < 10_000; index++) {
        const candidate = `${stem}_${index}.pptx`;
        try {
            await fs.access(candidate);
        } catch {
            return candidate;
        }
    }
    throw new Error('Unable to allocate a unique presentation filename');
}

function relatedPath(pptxPath: string, suffix: string): string {
    return `${pptxPath.slice(0, -5)}${suffix}`;
}

const PRESENTATION_SOURCE_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const PRESENTATION_SOURCE_IMAGE_REDIRECTS = 4;

function presentationImageCachePath(baseOutput: string, source: string): string {
    const extension = extname(new URL(source, 'file:///').pathname).toLowerCase();
    const safeExtension = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(extension)
        ? extension
        : '.img';
    const digest = createHash('sha256').update(source).digest('hex').slice(0, 24);
    return join(baseOutput, '.openflux-presentation-source-assets', `${digest}${safeExtension}`);
}

function isPrivatePresentationAssetAddress(address: string): boolean {
    const normalized = address.toLowerCase().split('%')[0].replace(/^\[|\]$/g, '');
    if (isIP(normalized) === 4) {
        const [a, b] = normalized.split('.').map(Number);
        return a === 0 || a === 10 || a === 127
            || (a === 169 && b === 254)
            || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 168)
            || a >= 224;
    }
    if (isIP(normalized) === 6) {
        if (normalized === '::' || normalized === '::1') return true;
        if (/^(?:fc|fd)/.test(normalized) || /^fe[89ab]/.test(normalized)) return true;
        const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
        return mapped ? isPrivatePresentationAssetAddress(mapped) : false;
    }
    return true;
}

async function validatePresentationAssetUrl(value: string): Promise<URL> {
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        throw new Error('image_url must be a valid absolute HTTPS URL');
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
        throw new Error('image_url must use HTTPS and cannot contain credentials');
    }
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
        throw new Error('image_url cannot target a local or private host');
    }
    const addresses = isIP(hostname)
        ? [{ address: hostname }]
        : await lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(item => isPrivatePresentationAssetAddress(item.address))) {
        throw new Error('image_url cannot resolve to a local, private, multicast, or otherwise unsafe address');
    }
    return parsed;
}

async function downloadPresentationImage(
    sourceUrl: string,
    baseOutput: string,
    signal?: AbortSignal,
): Promise<string> {
    const cachedPath = presentationImageCachePath(baseOutput, sourceUrl);
    const cached = await fs.stat(cachedPath).catch(() => undefined);
    if (cached?.isFile() && cached.size > 0) return cachedPath;
    await fs.mkdir(dirname(cachedPath), { recursive: true });

    let currentUrl = sourceUrl;
    for (let redirect = 0; redirect <= PRESENTATION_SOURCE_IMAGE_REDIRECTS; redirect++) {
        if (signal?.aborted) throw abortError(signal);
        const parsed = await validatePresentationAssetUrl(currentUrl);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(new Error('image download timed out')), 30_000);
        const abort = () => controller.abort(signal?.reason);
        signal?.addEventListener('abort', abort, { once: true });
        let response: Response;
        try {
            response = await fetch(parsed, {
                redirect: 'manual',
                signal: controller.signal,
                headers: {
                    Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/svg+xml,image/*;q=0.8',
                    'User-Agent': 'OpenFlux-Presentation/1.0',
                },
            });
        } finally {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', abort);
        }
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get('location');
            if (!location || redirect === PRESENTATION_SOURCE_IMAGE_REDIRECTS) {
                throw new Error('image_url exceeded the safe redirect limit');
            }
            currentUrl = new URL(location, parsed).toString();
            continue;
        }
        if (!response.ok) throw new Error(`image_url download failed with HTTP ${response.status}`);
        const declaredLength = Number(response.headers.get('content-length') || 0);
        if (declaredLength > PRESENTATION_SOURCE_IMAGE_MAX_BYTES) {
            throw new Error('image_url exceeds the 20 MB presentation asset limit');
        }
        const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (contentType && !contentType.startsWith('image/') && contentType !== 'application/octet-stream') {
            throw new Error(`image_url returned unsupported content type ${contentType}`);
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        if (!buffer.length || buffer.length > PRESENTATION_SOURCE_IMAGE_MAX_BYTES) {
            throw new Error('image_url returned an empty or oversized image asset');
        }
        await fs.writeFile(cachedPath, buffer);
        return cachedPath;
    }
    throw new Error('image_url could not be resolved');
}

async function stagePresentationImage(
    value: string,
    baseOutput: string,
    signal?: AbortSignal,
): Promise<string> {
    if (/^https:\/\//i.test(value)) return downloadPresentationImage(value, baseOutput, signal);
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
        throw new Error('Only local image_path values or HTTPS image_url values are supported');
    }
    const resolved = resolve(isAbsolute(value) ? value : join(baseOutput, value));
    const stat = await fs.stat(resolved).catch(() => undefined);
    if (!stat?.isFile()) throw new Error(`image_path is not a readable file: ${resolved}`);
    if (stat.size > PRESENTATION_SOURCE_IMAGE_MAX_BYTES) {
        throw new Error('image_path exceeds the 20 MB presentation asset limit');
    }
    if (isWithin(baseOutput, resolved)) return resolved;

    const cachedPath = presentationImageCachePath(baseOutput, resolved);
    await fs.mkdir(dirname(cachedPath), { recursive: true });
    const cached = await fs.stat(cachedPath).catch(() => undefined);
    if (!cached?.isFile() || cached.size !== stat.size || cached.mtimeMs < stat.mtimeMs) {
        await fs.copyFile(resolved, cachedPath);
        await fs.utimes(cachedPath, stat.atime, stat.mtime);
    }
    return cachedPath;
}

async function resolveImagePaths(
    plan: PresentationDeckPlan,
    baseOutput: string,
    signal?: AbortSignal,
): Promise<void> {
    for (const slide of plan.slides) {
        if (!slide.imagePath) continue;
        const resolved = await stagePresentationImage(slide.imagePath, baseOutput, signal);
        slide.imagePath = resolved;
        try {
            const metadata = await sharp(resolved, { limitInputPixels: 40_000_000, animated: false }).metadata();
            if (metadata.width && metadata.height) {
                const swapsAxes = [5, 6, 7, 8].includes(metadata.orientation || 0);
                slide.imageAspectRatio = swapsAxes
                    ? metadata.height / metadata.width
                    : metadata.width / metadata.height;
            }
        } catch {
            // The renderer reports the authoritative unsupported-image error.
        }
    }
    planPresentationLayouts(plan);
}

function structuredError(error: unknown, code: string): ToolResult {
    const message = error instanceof Error ? error.message : String(error);
    return {
        success: false,
        error: message,
        code,
        retryable: false,
        route: 'local_presentation',
        cause: {
            name: error instanceof Error ? error.name : undefined,
            message,
            code: error && typeof error === 'object' && 'code' in error
                ? String((error as { code?: unknown }).code || '') || undefined
                : undefined,
        },
    };
}

const rawInputSchema: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    // Do not express the new-design/resume conditional as a root-level anyOf.
    // Moonshot's MFJS rejects schemas that combine a parent `type` with
    // `anyOf`, and this tool is included in every agent request. The same
    // conditional is enforced by resolvePresentationDesignArgs/parsePresentationPlan.
    properties: {
        brief: {
            type: 'object',
            additionalProperties: false,
            required: ['title', 'audience', 'purpose', 'desired_outcome'],
            properties: {
                title: { type: 'string', description: 'Deck title written for the audience.' },
                subtitle: { type: 'string' },
                audience: { type: 'string', description: 'Who will view or decide from this deck.' },
                purpose: { type: 'string', description: 'Educate, persuade, sell, recommend, facilitate, or enable a decision.' },
                desired_outcome: { type: 'string', description: 'What the audience should understand, believe, choose, or do.' },
                language: { type: 'string' },
                delivery_mode: {
                    type: 'string',
                    enum: ['marketing', 'report', 'reference'],
                    description: 'Marketing curates source material for persuasion; reference preserves comprehensive detail.',
                },
                communication_job: {
                    type: 'string',
                    description: 'One sentence: by the end, this audience should reach the desired outcome because of the central takeaway.',
                },
                narrative_arc: {
                    type: 'array',
                    minItems: 3,
                    maxItems: 10,
                    items: { type: 'string' },
                    description: 'Cumulative story beats. This is not a topic inventory or agenda.',
                },
                requested_slide_count: {
                    type: 'number',
                    minimum: 1,
                    maximum: 24,
                    description: 'Exact final slide count only when the user explicitly requests one. Includes cover, section, appendix, and automatically paginated continuation slides.',
                },
            },
        },
        art_direction: {
            type: 'object',
            additionalProperties: false,
            properties: {
                mood: { type: 'string', description: 'A concise visual mood, not a template name.' },
                rationale: { type: 'string', description: 'Why this visual direction suits the audience and message.' },
                image_style: { type: 'string', description: 'Consistent direction for any generated or supplied images.' },
                visual_language: {
                    type: 'string',
                    enum: ['precision', 'editorial', 'kinetic'],
                    description: 'Agent-authored composition grammar. It is sampled automatically and is not a user setting.',
                },
                design_concept: { type: 'string', description: 'One theme-level visual idea that can be expressed across the whole deck.' },
                signature_element: { type: 'string', enum: ['axis', 'cutout', 'pulse', 'frame', 'orbit'] },
                density: { type: 'string', enum: ['airy', 'balanced', 'compact'] },
                palette: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        background: { type: 'string', description: 'Six-digit hex without #.' },
                        surface: { type: 'string' },
                        text: { type: 'string' },
                        muted: { type: 'string' },
                        accent: { type: 'string' },
                        accent2: { type: 'string' },
                    },
                },
                typography: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        heading: { type: 'string', description: 'Installed heading font family.' },
                        body: { type: 'string', description: 'Installed body font family.' },
                        title_scale: { type: 'number', minimum: 0.82, maximum: 1.22 },
                        body_scale: { type: 'number', minimum: 0.86, maximum: 1.16 },
                    },
                },
                spacing: { type: 'string', enum: ['tight', 'balanced', 'generous'] },
                motif: { type: 'string', enum: ['none', 'line', 'frame', 'orbit', 'blocks'] },
                background_treatment: { type: 'string', enum: ['solid', 'tonal', 'contrast'] },
                image_treatment: { type: 'string', enum: ['natural', 'full-bleed', 'framed', 'soft-crop'] },
                chart_style: { type: 'string', enum: ['minimal', 'editorial', 'bold'] },
                grid: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        columns: { type: 'integer', minimum: 6, maximum: 16 },
                        margin: { type: 'number', minimum: 0.45, maximum: 1.2 },
                        gutter: { type: 'number', minimum: 0.12, maximum: 0.5 },
                    },
                },
                design_principles: { type: 'array', maxItems: 8, items: { type: 'string' } },
                reference_summary: { type: 'string', description: 'Design DNA extracted from inspected references; do not name a fixed template.' },
                avoid: { type: 'array', maxItems: 8, items: { type: 'string' } },
            },
        },
        slides: {
            type: 'array',
            minItems: 1,
            maxItems: 40,
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['purpose', 'message'],
                properties: {
                    purpose: { type: 'string', description: 'The slide narrative job; kept in notes, not shown as planning copy.' },
                    message: { type: 'string', description: 'The one claim the audience should remember from this slide.' },
                    title: { type: 'string', description: 'Optional audience-facing title; message is used by default.' },
                    eyebrow: { type: 'string' },
                    composition: {
                        type: 'string',
                        enum: ['focal', 'narrative', 'split', 'sequence', 'grid', 'data', 'comparison', 'quote', 'closing'],
                        description: 'A composition intent, not a fixed visual template. Omit to infer from content.',
                    },
                    visual_role: { type: 'string', description: 'The visual job of this slide in the deck rhythm.' },
                    design_notes: { type: 'string', description: 'Audience-safe design reasoning kept in speaker notes.' },
                    layout: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            archetype: {
                                type: 'string',
                                enum: ['auto', 'cover', 'section', 'editorial', 'image', 'evidence', 'process', 'collection', 'comparison', 'quote', 'closing'],
                                description: 'Semantic page job. Prefer this over micromanaging a visual template; the deck-wide layout engine resolves the concrete silhouette.',
                            },
                            variant: {
                                type: 'string',
                                enum: ['auto', 'editorial', 'asymmetric', 'centered', 'full-bleed', 'cards', 'banded', 'stacked', 'spotlight'],
                                description: 'Model-selected design behavior, not a template name.',
                            },
                            emphasis: { type: 'string', enum: ['message', 'visual', 'data', 'balanced'] },
                            alignment: { type: 'string', enum: ['left', 'center', 'right'] },
                            image_position: { type: 'string', enum: ['auto', 'left', 'right', 'background', 'top', 'bottom'] },
                            whitespace: { type: 'string', enum: ['compact', 'balanced', 'generous'] },
                            focal_scale: { type: 'number', minimum: 0.8, maximum: 1.35 },
                            rationale: { type: 'string', description: 'Why this visual treatment fits this slide message.' },
                        },
                    },
                    information_role: {
                        type: 'string',
                        enum: ['claim', 'status', 'evidence', 'events', 'ranking', 'timeline', 'comparison', 'collection', 'sources', 'action'],
                        description: 'Domain-neutral information semantics used by the layout engine. Describe the data shape, never the industry.',
                    },
                    relationship_to_previous: {
                        type: 'string',
                        description: 'How this page advances the previous page. Kept in notes and never rendered as planning copy.',
                    },
                    body: { type: 'string' },
                    bullets: {
                        type: 'array',
                        maxItems: 20,
                        description: 'Visible points. Dense lists are automatically paginated before rendering.',
                        items: { type: 'string' },
                    },
                    items: {
                        type: 'array',
                        maxItems: 20,
                        description: 'Collection entries. More than four entries are automatically split across slides.',
                        items: {
                            type: 'object',
                            required: ['title'],
                            properties: { title: { type: 'string' }, description: { type: 'string' } },
                        },
                    },
                    metrics: {
                        type: 'array',
                        maxItems: 4,
                        items: {
                            type: 'object',
                            required: ['value', 'label'],
                            properties: {
                                value: { type: 'string' }, label: { type: 'string' }, description: { type: 'string' },
                            },
                        },
                    },
                    steps: {
                        type: 'array',
                        maxItems: 10,
                        description: 'Process steps. More than five steps are automatically split across slides.',
                        items: {
                            type: 'object',
                            required: ['title'],
                            properties: { title: { type: 'string' }, description: { type: 'string' } },
                        },
                    },
                    comparison: {
                        type: 'object',
                        required: ['left', 'right'],
                        properties: {
                            left: {
                                type: 'object', required: ['heading', 'items'],
                                properties: { heading: { type: 'string' }, items: { type: 'array', maxItems: 10, items: { type: 'string' } } },
                            },
                            right: {
                                type: 'object', required: ['heading', 'items'],
                                properties: { heading: { type: 'string' }, items: { type: 'array', maxItems: 10, items: { type: 'string' } } },
                            },
                        },
                    },
                    chart: {
                        type: 'object',
                        required: ['type'],
                        description: 'Editable data visualization. Choose the chart type from the relationship in the evidence; users never need to configure it manually.',
                        properties: {
                            type: {
                                type: 'string',
                                enum: [
                                    'bar', 'column', 'line', 'pie',
                                    'stacked-bar', 'stacked-column', 'area', 'doughnut', 'combo', 'waterfall',
                                    'scatter', 'bubble', 'radar', 'histogram',
                                    'heatmap', 'treemap', 'funnel', 'gantt',
                                ],
                                description: 'bar/column=category comparison; line/area=time trend; pie/doughnut=part-to-whole; stacked=composition across categories; combo=two measures with different scales; waterfall=incremental contribution; scatter/bubble=correlation; radar=multi-factor profile; histogram=distribution; heatmap=two-dimensional intensity; treemap=weighted hierarchy; funnel=ordered conversion stages; gantt=task timing.',
                            },
                            name: { type: 'string' },
                            labels: { type: 'array', items: { type: 'string' } },
                            values: { type: 'array', items: { type: 'number' } },
                            series: {
                                type: 'array',
                                minItems: 2,
                                maxItems: 6,
                                description: 'Required for stacked-bar, stacked-column, and combo. Every series must align to labels.',
                                items: {
                                    type: 'object', required: ['name', 'values'],
                                    properties: {
                                        name: { type: 'string' },
                                        values: { type: 'array', items: { type: 'number' } },
                                    },
                                },
                            },
                            x_values: { type: 'array', items: { type: 'number' }, description: 'Required numeric X coordinates for scatter and bubble.' },
                            sizes: { type: 'array', items: { type: 'number' }, description: 'Required point magnitude for bubble; also accepted as a treemap area alias when values is omitted.' },
                            matrix: {
                                type: 'array',
                                description: 'Required rectangular numeric matrix for heatmap.',
                                items: { type: 'array', items: { type: 'number' } },
                            },
                            row_labels: { type: 'array', items: { type: 'string' }, description: 'Heatmap row labels aligned to matrix rows.' },
                            column_labels: { type: 'array', items: { type: 'string' }, description: 'Heatmap column labels aligned to matrix columns.' },
                            parents: { type: 'array', items: { type: 'string' }, description: 'Optional parent label per treemap node; use an empty string for root.' },
                            start_values: { type: 'array', items: { type: 'number' }, description: 'Required start offset per Gantt task; values contains task duration.' },
                        },
                    },
                    quote: { type: 'string' },
                    attribution: { type: 'string' },
                    image_path: { type: 'string', description: 'Optional local image path. User-supplied paths are staged safely before rendering.' },
                    image_url: { type: 'string', description: 'Optional direct HTTPS URL for a searched image asset. The runtime downloads, validates, caches, and rasterizes it before PowerPoint sees it.' },
                    image_alt: { type: 'string' },
                    image_kind: {
                        type: 'string',
                        enum: ['photo', 'background', 'diagram', 'map', 'logo', 'screenshot'],
                        description: 'Semantic image type. Diagrams, maps, logos, and screenshots default to contain; photos and backgrounds default to cover.',
                    },
                    image_fit: {
                        type: 'string',
                        enum: ['cover', 'contain'],
                        description: 'Aspect-ratio-safe placement. cover crops photographs to fill; contain preserves the complete image.',
                    },
                    image_focus: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            x: { type: 'number', minimum: 0, maximum: 1, description: 'Horizontal focal point, 0=left and 1=right.' },
                            y: { type: 'number', minimum: 0, maximum: 1, description: 'Vertical focal point, 0=top and 1=bottom.' },
                        },
                    },
                    image_mask: {
                        type: 'string',
                        enum: ['auto', 'none', 'rounded-rect', 'circle', 'arch', 'soft-edge'],
                        description: 'Optional visual mask. auto chooses a safe treatment from image semantics and the resolved slide geometry.',
                    },
                    image_source_url: { type: 'string', description: 'Source page or original asset URL recorded in slide notes for provenance.' },
                    image_credit: { type: 'string', description: 'Optional creator, organization, or license credit recorded in slide notes.' },
                    speaker_notes: { type: 'string' },
                    sources: { type: 'array', items: { type: 'string' } },
                },
            },
        },
        filename: { type: 'string', description: 'Plain .pptx filename without directory segments.' },
        design_id: { type: 'string', description: 'Resume a stored design after sample approval or for a local visual revision.' },
        slide_patches: {
            type: 'array',
            maxItems: 12,
            description: 'Slide-local changes applied to a stored design; unchanged slides are preserved.',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['slide', 'changes'],
                properties: {
                    slide: { type: 'integer', minimum: 1 },
                    changes: { type: 'object', description: 'Partial slide plan fields to merge into the stored slide.' },
                },
            },
        },
        output_dir: { type: 'string', description: 'Optional output subdirectory inside the active Project.' },
        export_pdf: { type: 'boolean', default: true },
        render_preview: { type: 'boolean', default: true },
        revision: { type: 'integer', minimum: 0, maximum: MAX_PRESENTATION_REVISIONS, default: 0 },
        workflow: {
            type: 'object',
            additionalProperties: false,
            properties: {
                stage: { type: 'string', enum: ['sample', 'final', 'review', 'revision'], default: 'final' },
                mode: { type: 'string', enum: ['auto', 'confirm'], default: 'auto' },
                design_id: { type: 'string', description: 'Reuse the design id returned by the sample or previous render.' },
                sample_approved: {
                    type: 'boolean',
                    description: 'Required for final generation in confirm mode after the user approves the rendered sample.',
                },
                sample_slide_numbers: {
                    type: 'array', minItems: 1, maxItems: 3, items: { type: 'integer', minimum: 1 },
                },
                direction_review: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['selected_direction_id', 'reviewed_direction_ids', 'scores'],
                    properties: {
                        summary: { type: 'string' },
                        selected_direction_id: { type: 'string', enum: ['executive', 'editorial', 'launch'] },
                        reviewed_direction_ids: {
                            type: 'array', minItems: 1, maxItems: 3, uniqueItems: true,
                            items: { type: 'string', enum: ['executive', 'editorial', 'launch'] },
                        },
                        scores: {
                            type: 'array', minItems: 1, maxItems: 3,
                            items: {
                                type: 'object',
                                additionalProperties: false,
                                required: ['id', 'total'],
                                properties: {
                                    id: { type: 'string', enum: ['executive', 'editorial', 'launch'] },
                                    total: { type: 'number', minimum: 0, maximum: 5 },
                                    rationale: { type: 'string' },
                                },
                            },
                        },
                    },
                },
                visual_review: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        summary: { type: 'string' },
                        strengths: { type: 'array', maxItems: 8, items: { type: 'string' } },
                        overall_score: { type: 'number', minimum: 0, maximum: 5 },
                        scorecard: {
                            type: 'object',
                            additionalProperties: false,
                            required: ['hierarchy', 'composition', 'typography', 'theme', 'originality'],
                            properties: {
                                hierarchy: { type: 'number', minimum: 0, maximum: 5 },
                                composition: { type: 'number', minimum: 0, maximum: 5 },
                                typography: { type: 'number', minimum: 0, maximum: 5 },
                                theme: { type: 'number', minimum: 0, maximum: 5 },
                                originality: { type: 'number', minimum: 0, maximum: 5 },
                            },
                            description: 'Aesthetic scorecard. Mechanical QA is evaluated separately and must not inflate these scores.',
                        },
                        reviewed_slide_numbers: {
                            type: 'array',
                            minItems: 1,
                            items: { type: 'integer', minimum: 1 },
                            description: 'Every slide number actually inspected in the rendered review sheets.',
                        },
                        slide_scores: {
                            type: 'array',
                            minItems: 1,
                            items: {
                                type: 'object',
                                additionalProperties: false,
                                required: ['slide', 'total'],
                                properties: {
                                    slide: { type: 'integer', minimum: 1 },
                                    total: { type: 'number', minimum: 0, maximum: 5 },
                                },
                            },
                        },
                        issues: {
                            type: 'array',
                            items: {
                                type: 'object',
                                additionalProperties: false,
                                required: ['slide', 'category', 'observation', 'action'],
                                properties: {
                                    slide: { type: 'integer', minimum: 1 },
                                    severity: { type: 'string', enum: ['warning', 'error'] },
                                    category: {
                                        type: 'string',
                                        enum: [
                                            'hierarchy', 'composition', 'typography', 'theme', 'originality',
                                            'spacing', 'alignment', 'density', 'imagery', 'consistency', 'rhythm', 'narrative', 'other',
                                        ],
                                    },
                                    observation: { type: 'string' },
                                    action: { type: 'string' },
                                },
                            },
                        },
                    },
                },
            },
        },
    },
};

export function createPresentationGenTool(options: PresentationGenToolOptions = {}): Tool {
    return {
        name: 'generate_presentation',
        priority: 17,
        description: [
            'Create a new, editable PowerPoint deck from a design-first plan and optionally export a PDF and visual contact sheet.',
            'Use this for NEW presentations or redesigning content into a new file. For a presentation already open in PowerPoint, use ppt_* tools instead.',
            'Act as a content director first: define the audience, communication job, cumulative narrative arc, source-selection strategy, and one message per slide; only then choose composition intents and art direction.',
            'Set layout.archetype only when the semantic page job is clear (cover, section, editorial, image, evidence, process, collection, comparison, quote, or closing). The deck-wide layout engine selects concrete silhouettes, alternates image direction, and prevents adjacent template repetition.',
            'Marketing and corporate-profile decks curate source material into at most 22 visible slides; comprehensive detail belongs in notes, an appendix, or a reference deck.',
            'For every supplied or searched image, classify image_kind and choose image_fit: photos/backgrounds use cover, while diagrams/maps/logos/screenshots use contain. Use image_focus to protect an off-center subject, image_mask=auto unless a specific safe mask is warranted, and preserve provenance in image_source_url or image_credit.',
            'Local image_path values and direct HTTPS image_url values are staged, decoded, aspect-ratio normalized, masked, and checked for crop loss and effective PPI before embedding. Do not pre-stretch assets or ask users to configure geometry.',
            'This is not a fixed-template tool. Art direction must name one deck-level design concept, choose a visual language, and express it through scale, composition, typography, and a recurring signature element—not repeated cards.',
            'It validates density and visual variety, renders every slide in PowerPoint, returns readable six-slide review sheets, and blocks delivery while QA errors or low theme/originality scores remain.',
            `The active Flux model reviews returned direction and full-deck images on normal Agent-loop turns. The tool never creates a second model request or provider. Patch only affected slides and increment revision up to ${MAX_PRESENTATION_REVISIONS}. Never publish needs_revision/regressed drafts or chase a target file size.`,
        ].join(' '),
        parameters: {
            brief: { type: 'object', description: 'Audience, purpose, desired outcome, and deck title. Required for a new design.' },
            art_direction: { type: 'object', description: 'Complete deck design language: visual_language, design_concept, signature_element, mood, principles, grid, palette, typography, imagery, and charts. This is authored automatically; it adds no user configuration.' },
            slides: { type: 'array', description: 'Narrative slide plans with one core message and a model-authored visual intent each. Required for a new design.', items: { type: 'object' } },
            design_id: { type: 'string', description: 'Resume the stored plan returned by a sample or prior render.' },
            slide_patches: { type: 'array', description: 'Local changes for selected slides in a stored design.', items: { type: 'object' } },
            filename: { type: 'string', description: 'Optional plain .pptx filename.' },
            output_dir: { type: 'string', description: 'Optional output subdirectory inside the active Project.' },
            export_pdf: { type: 'boolean', description: 'Export a PDF with desktop PowerPoint when available.', default: true },
            render_preview: { type: 'boolean', description: 'Render slides and return a contact sheet for visual review.', default: true },
            revision: { type: 'number', description: `Visual refinement number from 0 to ${MAX_PRESENTATION_REVISIONS}. Continue only while concrete QA errors remain.`, default: 0 },
            workflow: { type: 'object', description: 'Durable sample, full generation, all-slide review, and evidence-based revision workflow. Only the review stage can release final files.' },
        },
        rawInputSchema,

        async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
            const startedAt = Date.now();
            const signal = context?.abortSignal || context?.signal;
            if (signal?.aborted) throw abortError(signal);
            let pptxPath: string | undefined;
            let pdfPath: string | undefined;
            let previewPath: string | undefined;
            let previewDir: string | undefined;
            let sampleRoot: string | undefined;
            try {
                context?.onProgress?.({ type: 'progress', message: 'Checking narrative, art direction, and slide composition' });
                const baseOutput = resolve(options.getOutputPath?.() || process.cwd());
                const designStorePath = options.getDesignStorePath?.();
                const requestedWorkflow = object(args.workflow);
                const requestedStage = String(requestedWorkflow.stage || args.workflow_stage || 'final').toLowerCase();
                const requestedDesignId = string(args.design_id || requestedWorkflow.design_id || requestedWorkflow.designId);
                if (requestedStage === 'sample' && requestedDesignId) {
                    const storedArgs = await loadPresentationDesign(baseOutput, requestedDesignId, designStorePath);
                    if (storedArgs) {
                        const violation = validatePresentationSampleRetry(storedArgs, args);
                        if (violation) {
                            return {
                                success: false,
                                error: violation,
                                code: 'presentation_sample_fact_contract_violation',
                                retryable: false,
                                data: {
                                    route: 'local_presentation',
                                    files: [],
                                    stage: 'sample',
                                    designId: requestedDesignId,
                                    workflowState: readPresentationWorkflowState(storedArgs.__workflow_state),
                                    nextAction: 'retry_sample_from_stored_design_with_layout_only_patches',
                                },
                            };
                        }
                    }
                }
                if (requestedStage === 'revision' && requestedDesignId) {
                    const storedArgs = await loadPresentationDesign(baseOutput, requestedDesignId, designStorePath);
                    if (storedArgs) {
                        const violation = validatePresentationRevisionPatches(storedArgs, args);
                        if (violation) {
                            return {
                                success: false,
                                error: violation,
                                code: 'presentation_revision_content_contract_violation',
                                retryable: false,
                                data: {
                                    route: 'local_presentation',
                                    files: [],
                                    stage: 'revision',
                                    designId: requestedDesignId,
                                    workflowState: readPresentationWorkflowState(storedArgs.__workflow_state),
                                    nextAction: 'patch_layout_or_existing_content_channel_only',
                                },
                            };
                        }
                    }
                }
                let effectiveArgs = await resolvePresentationDesignArgs(baseOutput, args, designStorePath);
                const concreteSlideCount = Array.isArray(effectiveArgs.slides) ? effectiveArgs.slides.length : 0;
                // A design resumed by id already stores the authoritative,
                // rendered pagination. Re-coalescing its continuation labels
                // would invalidate concrete QA page numbers during revision.
                const capacityPlan = fitPresentationArgsToCapacity(effectiveArgs, {
                    coalesceContinuations: !requestedDesignId,
                });
                if (requestedStage === 'revision' && capacityPlan.slideCount !== concreteSlideCount) {
                    return {
                        success: false,
                        error: `Visual revision would change the rendered slide count from ${concreteSlideCount} to ${capacityPlan.slideCount}. Patch the concrete rendered slide reported by qa.issues[].slide; sourceSlide is provenance only.`,
                        code: 'presentation_revision_slide_count_change',
                        retryable: false,
                        data: {
                            route: 'local_presentation',
                            files: [],
                            stage: 'revision',
                            designId: requestedDesignId,
                            capacityPlan,
                            nextAction: 'patch_concrete_rendered_slide_without_changing_channels',
                        },
                    };
                }
                effectiveArgs = capacityPlan.args;
                if (capacityPlan.expanded) {
                    context?.onProgress?.({
                        type: 'progress',
                        message: `Auto-fitted ${capacityPlan.splits.length} dense or incompatible slide(s) into ${capacityPlan.slideCount} readable slides`,
                    });
                }
                const previousQualityState = readQualityState(effectiveArgs);
                let plan = parsePresentationPlan(effectiveArgs);
                let planIssues = mapDeckIssuesToOrigins(evaluatePresentationPlan(plan), capacityPlan);
                const requestedCountIssues = planIssues.filter(issue => (
                    issue.severity === 'error' && issue.code === 'requested_slide_count_mismatch'
                ));
                if (plan.workflow.stage === 'sample' && requestedCountIssues.length) {
                    const overflowSummary = capacityPlan.splits.length
                        ? capacityPlan.splits
                            .map(split => `source slide ${split.sourceSlide} -> ${split.outputSlides} slides (${split.reasons.join(', ')})`)
                            .join('; ')
                        : 'no individual split was reported; reconcile the authored slide count';
                    return {
                        success: false,
                        error: `${requestedCountIssues[0]!.message} Capacity diagnostics: ${overflowSummary}.`,
                        code: 'presentation_requested_slide_count_mismatch',
                        retryable: false,
                        data: {
                            route: 'local_presentation',
                            files: [],
                            stage: 'sample',
                            issues: requestedCountIssues,
                            capacityPlan,
                            requestedSlideCount: plan.brief.requestedSlideCount,
                            actualSlideCount: plan.slides.length,
                            nextAction: 'resubmit_initial_sample_with_exact_requested_slide_count',
                        },
                    };
                }
                const designId = plan.workflow.designId || randomUUID();
                let persistentArgs = argsWithDesignId(effectiveArgs, designId);
                const enforceWorkflow = options.enforceWorkflow ?? Boolean(context?.sessionId || context?.turnId);
                const activeModel = context?.activeModel;
                const activeModelSupportsVision = activeModel?.vision === true;
                const activeModelId = activeModel
                    ? `${activeModel.provider}/${activeModel.model}`
                    : undefined;
                const storedWorkflowState = readPresentationWorkflowState(effectiveArgs.__workflow_state);
                let workflowState = storedWorkflowState || createPresentationWorkflowState(plan, designId, {
                    sessionId: context?.sessionId,
                    turnId: context?.turnId,
                });
                if (storedWorkflowState?.designId !== undefined && storedWorkflowState.designId !== designId) {
                    return workflowTransitionError('The stored presentation workflow belongs to a different design.');
                }
                if (enforceWorkflow && storedWorkflowState?.sessionId && context?.sessionId
                    && storedWorkflowState.sessionId !== context.sessionId) {
                    return workflowTransitionError('The stored presentation workflow belongs to a different agent session.');
                }
                const saveWorkflow = async (
                    state: PresentationWorkflowState,
                    nativeQualityState?: PresentationQualityState,
                ): Promise<void> => {
                    state.updatedAt = Date.now();
                    await savePresentationDesign(baseOutput, designId, {
                        ...persistentArgs,
                        ...(nativeQualityState ? { __quality_state: nativeQualityState } : {}),
                        __workflow_state: state,
                    }, designStorePath);
                };
                const outputDirRaw = string(effectiveArgs.output_dir);
                const outputDir = resolve(outputDirRaw
                    ? (isAbsolute(outputDirRaw) ? outputDirRaw : join(baseOutput, outputDirRaw))
                    : baseOutput);
                if (!isWithin(baseOutput, outputDir)) {
                    throw new Error('output_dir must remain inside the active OpenFlux Project');
                }
                await fs.mkdir(outputDir, { recursive: true });

                if (plan.workflow.stage === 'review') {
                    if (!enforceWorkflow || !storedWorkflowState?.fullGeneration) {
                        return workflowTransitionError(
                            'The review stage requires a full deck generated by the durable presentation workflow.',
                            storedWorkflowState,
                        );
                    }
                    if (!activeModelSupportsVision) {
                        return presentationVisionUnavailable(
                            'The active model selected by the current Flux mode is text-only. Visual review was not rerouted to a separate model.',
                            storedWorkflowState,
                        );
                    }
                    const review = plan.workflow.visualReview;
                    if (!review) {
                        return workflowTransitionError(
                            'workflow.visual_review with all-slide evidence and scores is required for the review stage.',
                            workflowState,
                        );
                    }
                    const totalSlides = storedWorkflowState.fullGeneration.slideCount;
                    const scoredSlides = new Set(review.slideScores.map(item => item.slide));
                    if (review.overallScore === undefined
                        || !review.scorecard
                        || review.slideScores.length !== totalSlides
                        || scoredSlides.size !== totalSlides
                        || Array.from({ length: totalSlides }, (_, index) => index + 1).some(slide => !scoredSlides.has(slide))) {
                        return workflowTransitionError(
                            `Visual review must include the five-part aesthetic scorecard, overall_score, and one slide_scores entry for every slide 1-${totalSlides}.`,
                            workflowState,
                        );
                    }
                    const scoreIssues: PresentationQualityIssue[] = [];
                    if (review.overallScore < PRESENTATION_DECK_SCORE_THRESHOLD) {
                        scoreIssues.push({
                            severity: 'error',
                            code: 'deck_visual_score_below_threshold',
                            message: `The active model scored the rendered deck ${review.overallScore.toFixed(2)}/5, below the ${PRESENTATION_DECK_SCORE_THRESHOLD.toFixed(2)} delivery threshold.`,
                        });
                    }
                    if (review.scorecard.theme < PRESENTATION_THEME_SCORE_THRESHOLD) {
                        scoreIssues.push({
                            severity: 'error',
                            code: 'deck_theme_score_below_threshold',
                            message: `The deck theme scored ${review.scorecard.theme.toFixed(2)}/5, below the ${PRESENTATION_THEME_SCORE_THRESHOLD.toFixed(2)} threshold. The pages do not yet feel like one authored visual system.`,
                        });
                    }
                    if (review.scorecard.originality < PRESENTATION_ORIGINALITY_SCORE_THRESHOLD) {
                        scoreIssues.push({
                            severity: 'error',
                            code: 'deck_originality_score_below_threshold',
                            message: `The deck originality scored ${review.scorecard.originality.toFixed(2)}/5, below the ${PRESENTATION_ORIGINALITY_SCORE_THRESHOLD.toFixed(2)} threshold. Repeated generic card or dashboard treatments are not deliverable.`,
                        });
                    }
                    for (const score of review.slideScores) {
                        if (score.total >= PRESENTATION_SLIDE_SCORE_THRESHOLD
                            || review.issues.some(issue => issue.slide === score.slide && issue.severity === 'error')) continue;
                        scoreIssues.push({
                            severity: 'error',
                            code: 'slide_visual_score_below_threshold',
                            slide: score.slide,
                            message: `The active model scored slide ${score.slide} ${score.total.toFixed(2)}/5, below the ${PRESENTATION_SLIDE_SCORE_THRESHOLD.toFixed(2)} delivery threshold.`,
                        });
                    }
                    workflowState.visualReview = {
                        status: 'pending',
                        reviewedSlideNumbers: review.reviewedSlideNumbers
                            .filter(slide => slide >= 1 && slide <= totalSlides),
                        totalSlides,
                        issues: visualReviewIssues(plan.workflow.visualReview),
                        reviewedAt: Date.now(),
                    };
                    if (!reviewedEverySlide(workflowState)) {
                        workflowState.stage = 'visual_review';
                        const completion = await evaluatePresentationCompletion(workflowState);
                        await saveWorkflow(workflowState);
                        return {
                            success: false,
                            error: `Visual review evidence is incomplete. All slides 1-${totalSlides} must be inspected before completion.`,
                            code: 'presentation_visual_review_incomplete',
                            retryable: false,
                            data: {
                                route: 'local_presentation',
                                files: [],
                                stage: workflowState.stage,
                                designId,
                                workflowState,
                                completion,
                            },
                        };
                    }

                    workflowState.visualReview.status = 'complete';
                    const issues = [
                        ...storedWorkflowState.qa.issues,
                        ...workflowState.visualReview.issues,
                        ...scoreIssues,
                    ];
                    const stateQuality = qualityState(issues, storedWorkflowState.qa.revision);
                    const regressed = previousQualityState !== undefined
                        && qualityRegressed(previousQualityState, stateQuality);
                    if (regressed) {
                        issues.push({
                            severity: 'error',
                            code: 'qa_regression',
                            message: `This revision regressed from ${previousQualityState.errors} errors/${previousQualityState.warnings} warnings to ${stateQuality.errors} errors/${stateQuality.warnings} warnings.`,
                        });
                    }
                    const finalStateQuality = qualityState(issues, storedWorkflowState.qa.revision);
                    workflowState.qa = {
                        status: qaStatus(issues, regressed),
                        issues,
                        errors: finalStateQuality.errors,
                        warnings: finalStateQuality.warnings,
                        revision: storedWorkflowState.qa.revision,
                    };
                    workflowState.outputs = {
                        pptx: storedWorkflowState.fullGeneration.pptx,
                        pdf: storedWorkflowState.fullGeneration.pdf,
                    };
                    workflowState.stage = finalStateQuality.errors > 0 ? 'revision' : 'packaging';
                    let completion = await evaluatePresentationCompletion(workflowState);
                    if (completion.complete) {
                        workflowState.stage = 'completed';
                        completion = await evaluatePresentationCompletion(workflowState);
                    }
                    if (!regressed) await saveWorkflow(workflowState, finalStateQuality);
                    const qualityGateExhausted = finalStateQuality.errors > 0
                        && storedWorkflowState.qa.revision >= MAX_PRESENTATION_REVISIONS;
                    return {
                        success: !qualityGateExhausted,
                        error: qualityGateExhausted
                            ? `Presentation quality gate failed after revision ${storedWorkflowState.qa.revision}: ${finalStateQuality.errors} error(s) remain. The draft was not published.`
                            : undefined,
                        code: qualityGateExhausted ? 'presentation_quality_gate_failed' : undefined,
                        retryable: false,
                        data: {
                            route: 'local_presentation',
                            files: completion.files,
                            stage: workflowState.stage,
                            designId,
                            pptx: workflowState.fullGeneration.pptx,
                            pdf: workflowState.fullGeneration.pdf,
                            slideCount: totalSlides,
                            workflow: plan.workflow,
                            workflowState,
                            qa: workflowState.qa,
                            completion,
                            capacityPlan,
                            reviewer: activeModelId,
                            nextAction: completion.nextAction,
                            tookMs: Date.now() - startedAt,
                        },
                    } satisfies ToolResult;
                }

                if (plan.workflow.stage === 'sample') {
                    const sampleSlideNumbers = selectRepresentativeSlides(plan);
                    if (enforceWorkflow && !activeModelSupportsVision) {
                        return presentationVisionUnavailable(
                            'The active model selected by the current Flux mode is text-only. Direction review was not rerouted to a separate model.',
                            workflowState,
                        );
                    }
                    const structurePreflightIssues = planIssues.filter(issue => (
                        issue.severity === 'error' && STRUCTURE_PREFLIGHT_ERROR_CODES.has(issue.code)
                    ));
                    if (structurePreflightIssues.length) {
                        const sampleQuality = qualityState(structurePreflightIssues, plan.revision);
                        workflowState.contentDirection.complete = false;
                        workflowState.designSample = {
                            required: plan.slides.length >= 4,
                            status: 'pending',
                            mode: 'auto',
                            sampleSlideNumbers,
                            directionIds: [],
                            mechanicallyCleanDirectionIds: [],
                        };
                        workflowState.qa = {
                            status: 'needs_revision',
                            issues: structurePreflightIssues,
                            errors: sampleQuality.errors,
                            warnings: sampleQuality.warnings,
                            revision: plan.revision,
                        };
                        workflowState.stage = 'content_direction';
                        await saveWorkflow(workflowState);
                        context?.onProgress?.({
                            type: 'progress',
                            message: `Structural preflight blocked ${structurePreflightIssues.length} issue(s) before rendering visual directions`,
                        });
                        return {
                            ...structuredError(
                                new Error('Presentation structure failed preflight before visual direction rendering.'),
                                'presentation_structure_preflight_failed',
                            ),
                            data: {
                                route: 'local_presentation',
                                files: [],
                                designId,
                                workflowState,
                                capacityPlan,
                                issues: structurePreflightIssues,
                                nextAction: 'retry_sample_from_stored_design_with_layout_only_patches',
                            },
                        };
                    }
                    sampleRoot = join(outputDir, `.openflux-presentation-sample-${designId}`);
                    await fs.mkdir(sampleRoot, { recursive: true });
                    const allDirectionCandidates: PresentationVisualDirection[] = enforceWorkflow
                        ? createPresentationVisualDirections(plan)
                        : [{
                            id: 'executive',
                            name: 'Current direction',
                            description: 'The model-authored direction for a legacy caller without the Agent-loop review workflow.',
                            plan,
                        }];
                    const repairDirectionId = requestedDesignId
                        && storedWorkflowState?.designSample.status === 'pending'
                        && (storedWorkflowState.designSample.directionIds || []).length > 0
                        ? storedWorkflowState.designSample.repairDirectionId
                            || storedWorkflowState.designSample.directionIds?.[0]
                        : undefined;
                    const directionCandidates = repairDirectionId
                        ? allDirectionCandidates.filter(direction => direction.id === repairDirectionId)
                        : allDirectionCandidates;
                    if (!directionCandidates.length) {
                        return workflowTransitionError(
                            `Stored repair direction ${repairDirectionId} is unavailable. Restart the sample with the existing design_id.`,
                            workflowState,
                        );
                    }
                    const directionPreviews: PresentationDirectionPreview[] = [];
                    const directionIssues = new Map<string, PresentationQualityIssue[]>();
                    const directionRenders = new Map<string, RenderPresentationResult>();

                    for (const direction of directionCandidates) {
                        const samplePlan: PresentationDeckPlan = {
                            ...direction.plan,
                            slides: sampleSlideNumbers.map(slideNumber => direction.plan.slides[slideNumber - 1]),
                            workflow: { ...direction.plan.workflow, mode: 'auto', designId, sampleSlideNumbers },
                        };
                        await resolveImagePaths(samplePlan, baseOutput, signal);
                        const directionRoot = join(sampleRoot, direction.id);
                        await fs.mkdir(directionRoot, { recursive: true });
                        const directionPptx = join(directionRoot, 'design-sample.pptx');
                        const directionPreview = join(directionRoot, 'design-sample-preview.png');
                        const directionPreviewDir = join(directionRoot, 'slides');

                        if (signal?.aborted) throw abortError(signal);
                        context?.onProgress?.({
                            type: 'progress',
                            message: enforceWorkflow
                                ? `Rendering visual direction ${directionPreviews.length + 1}/${directionCandidates.length}`
                                : `Rendering a ${samplePlan.slides.length}-slide visual direction sample`,
                        });
                        const renderResult = await renderPresentation(samplePlan, directionPptx);
                        directionRenders.set(direction.id, renderResult);
                        const imageQa = await runImageGeometryQa(directionPptx);
                        if (imageQa.available && imageQa.checkedImages !== renderResult.preparedImageCount) {
                            imageQa.issues.push({
                                severity: 'error',
                                code: 'image_geometry_count_mismatch',
                                message: `Prepared ${renderResult.preparedImageCount} image(s), but found ${imageQa.checkedImages} embedded image(s) in the sample PPTX.`,
                            });
                        }
                        const exportIssues: PresentationQualityIssue[] = [];
                        let exportResult: PresentationExportResult | undefined;
                        if (options.exportPresentation || process.platform === 'win32') {
                            try {
                                exportResult = await (options.exportPresentation || exportPresentationWithPowerPoint)({
                                    pptxPath: directionPptx,
                                    previewDir: directionPreviewDir,
                                    previewPath: directionPreview,
                                    signal,
                                    onProgress: message => context?.onProgress?.({ type: 'progress', message }),
                                });
                            } catch (error) {
                                if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw abortError(signal);
                                exportIssues.push({
                                    severity: 'error',
                                    code: 'sample_visual_qa_unavailable',
                                    message: `The design sample could not be rendered for visual review: ${error instanceof Error ? error.message : String(error)}`,
                                });
                            }
                        } else {
                            exportIssues.push({
                                severity: 'error',
                                code: 'sample_visual_qa_unavailable',
                                message: 'A visual direction sample requires PowerPoint rendering on Windows.',
                            });
                        }
                        const candidateIssues = [
                            ...mapDeckIssuesToOrigins(evaluatePresentationPlan(direction.plan), capacityPlan),
                            ...mapSampleIssuesToDeck([
                                ...renderResult.imageIssues,
                                ...imageQa.issues,
                                ...(exportResult?.issues || []),
                                ...exportIssues,
                            ], sampleSlideNumbers, capacityPlan),
                        ];
                        directionIssues.set(direction.id, candidateIssues);
                        const reviewPaths = exportResult?.reviewSheetPaths?.length
                            ? exportResult.reviewSheetPaths
                            : exportResult?.previewPath ? [exportResult.previewPath] : [];
                        const previewImages = await loadPresentationPreviewImages(reviewPaths);
                        if (previewImages.length) {
                            directionPreviews.push({
                                id: direction.id,
                                name: direction.name,
                                description: direction.description,
                                slideNumbers: sampleSlideNumbers,
                                images: previewImages,
                            });
                        }
                    }

                    if (enforceWorkflow && directionPreviews.length !== directionCandidates.length) {
                        return presentationVisionUnavailable(
                            `Only ${directionPreviews.length}/${directionCandidates.length} visual directions produced readable previews for the active model.`,
                            workflowState,
                        );
                    }
                    const mechanicallyCleanIds = directionCandidates
                        .filter(item => !(directionIssues.get(item.id) || []).some(issue => issue.severity === 'error'))
                        .map(item => item.id);
                    if (enforceWorkflow && !mechanicallyCleanIds.length) {
                        const issueRank = (issues: PresentationQualityIssue[]): [number, number] => [
                            issues.filter(issue => issue.severity === 'error').length,
                            issues.filter(issue => issue.severity === 'warning').length,
                        ];
                        const bestDirection = [...directionCandidates].sort((left, right) => {
                            const [leftErrors, leftWarnings] = issueRank(directionIssues.get(left.id) || []);
                            const [rightErrors, rightWarnings] = issueRank(directionIssues.get(right.id) || []);
                            return leftErrors - rightErrors || leftWarnings - rightWarnings;
                        })[0];
                        const bestIssues = directionIssues.get(bestDirection.id) || planIssues;
                        const sampleQuality = qualityState(bestIssues, plan.revision);
                        workflowState.contentDirection.complete = !planIssues.some(issue => issue.severity === 'error');
                        workflowState.designSample = {
                            required: plan.slides.length >= 4,
                            status: 'pending',
                            mode: 'auto',
                            sampleSlideNumbers,
                            generatedAt: Date.now(),
                            directionIds: directionCandidates.map(item => item.id),
                            mechanicallyCleanDirectionIds: [],
                            repairDirectionId: bestDirection.id,
                        };
                        workflowState.qa = {
                            status: 'needs_revision',
                            issues: bestIssues,
                            errors: sampleQuality.errors,
                            warnings: sampleQuality.warnings,
                            revision: plan.revision,
                        };
                        workflowState.stage = workflowState.contentDirection.complete
                            ? 'design_sample'
                            : 'content_direction';
                        await saveWorkflow(workflowState);
                        return {
                            ...structuredError(
                                new Error('No rendered visual direction passed structural or rendering QA.'),
                                'presentation_direction_quality_gate_failed',
                            ),
                            data: {
                                route: 'local_presentation',
                                files: [],
                                designId,
                                workflowState,
                                capacityPlan,
                                nextAction: 'retry_sample_from_stored_design_with_layout_only_patches',
                                directions: directionCandidates.map(item => ({
                                    id: item.id,
                                    issues: directionIssues.get(item.id) || [],
                                })),
                            },
                        };
                    }

                    const selectedDirection = directionCandidates[0];
                    const selectedRender = directionRenders.get(selectedDirection.id)!;
                    const issues = enforceWorkflow
                        ? planIssues
                        : (directionIssues.get(selectedDirection.id) || planIssues);
                    let completion;
                    if (enforceWorkflow) {
                        const sampleQuality = qualityState(issues, plan.revision);
                        workflowState.contentDirection.complete = !planIssues.some(issue => issue.severity === 'error');
                        workflowState.designSample = {
                            required: plan.slides.length >= 4,
                            status: issues.some(issue => issue.severity === 'error') ? 'pending' : 'ready',
                            mode: 'auto',
                            sampleSlideNumbers,
                            generatedAt: Date.now(),
                            directionIds: directionCandidates.map(item => item.id),
                            mechanicallyCleanDirectionIds: mechanicallyCleanIds,
                            repairDirectionId: undefined,
                        };
                        workflowState.qa = {
                            status: qaStatus(issues),
                            issues,
                            errors: sampleQuality.errors,
                            warnings: sampleQuality.warnings,
                            revision: plan.revision,
                        };
                        workflowState.stage = workflowState.contentDirection.complete
                            ? 'design_sample'
                            : 'content_direction';
                        completion = await evaluatePresentationCompletion(workflowState);
                        await saveWorkflow(workflowState);
                    } else {
                        await savePresentationDesign(baseOutput, designId, persistentArgs, designStorePath);
                    }
                    return {
                        success: true,
                        data: {
                            route: 'local_presentation',
                            files: [],
                            stage: 'sample',
                            designId,
                            sampleSlideNumbers,
                            selectedDirection: enforceWorkflow ? undefined : selectedDirection.id,
                            directions: directionCandidates.map(direction => ({
                                id: direction.id,
                                name: direction.name,
                                description: direction.description,
                                mechanicallyClean: mechanicallyCleanIds.includes(direction.id),
                                issues: directionIssues.get(direction.id) || [],
                            })),
                            compositions: selectedRender.compositions,
                            layouts: selectedRender.layouts,
                            layoutSummary: summarizePresentationLayouts({
                                ...plan,
                                slides: sampleSlideNumbers.map(slideNumber => plan.slides[slideNumber - 1]),
                            }),
                            artDirection: plan.artDirection,
                            requiresUserConfirmation: false,
                            nextAction: enforceWorkflow
                                ? 'review_all_direction_images_then_submit_direction_review'
                                : 'generate_final_from_selected_direction',
                            qa: {
                                status: issues.some(issue => issue.severity === 'error') ? 'needs_revision' : 'ready_for_visual_review',
                                issues,
                                revision: plan.revision,
                                revisionAllowed: plan.revision < MAX_PRESENTATION_REVISIONS,
                            },
                            workflowState: enforceWorkflow ? workflowState : undefined,
                            completion,
                            capacityPlan,
                        },
                        images: directionPreviews.flatMap(direction => direction.images.map(image => ({
                            ...image,
                            description: [
                                `Visual direction ${direction.id} (${direction.name}) for original slides ${sampleSlideNumbers.join(', ')}.`,
                                'Compare every returned direction in the current Flux model turn.',
                                'Then call generate_presentation with workflow.stage=final and workflow.direction_review containing all three reviewed ids, one score per direction, and the selected direction id.',
                            ].join(' '),
                        }))),
                        imagesForDisplayOnly: false,
                    } satisfies ToolResult;
                }

                if (enforceWorkflow && plan.workflow.stage === 'final') {
                    if (workflowState.designSample.required) {
                        if (!storedWorkflowState || workflowState.designSample.status === 'pending') {
                            return workflowTransitionError(
                                'Render and inspect the representative design sample before full generation.',
                                workflowState,
                            );
                        }
                        const directionReview = plan.workflow.directionReview;
                        const directionIds = workflowState.designSample.directionIds || [];
                        const cleanDirectionIds = new Set(
                            workflowState.designSample.mechanicallyCleanDirectionIds || [],
                        );
                        const reviewedIds = new Set(directionReview?.reviewedDirectionIds || []);
                        const scoredIds = new Set(directionReview?.scores.map(item => item.id) || []);
                        if (!directionReview
                            || directionIds.length < 1
                            || directionIds.length > 3
                            || directionReview.reviewedDirectionIds.length !== directionIds.length
                            || directionReview.scores.length !== directionIds.length
                            || directionIds.some(id => !reviewedIds.has(id) || !scoredIds.has(id))
                            || reviewedIds.size !== directionIds.length
                            || scoredIds.size !== directionIds.length) {
                            return workflowTransitionError(
                                'Inspect every returned direction image in the active Flux model and submit workflow.direction_review with one score per returned direction.',
                                workflowState,
                            );
                        }
                        const selectedScore = directionReview.scores
                            .find(item => item.id === directionReview.selectedDirectionId)?.total;
                        if (!cleanDirectionIds.has(directionReview.selectedDirectionId)) {
                            return workflowTransitionError(
                                'The selected visual direction failed structural or rendering QA. Select a mechanically clean direction.',
                                workflowState,
                            );
                        }
                        if (selectedScore === undefined || selectedScore < PRESENTATION_DIRECTION_SCORE_THRESHOLD) {
                            return {
                                ...structuredError(
                                    new Error(`The selected direction scored ${selectedScore?.toFixed(2) || 'unscored'}/5, below the ${PRESENTATION_DIRECTION_SCORE_THRESHOLD.toFixed(2)} visual threshold.`),
                                    'presentation_direction_score_below_threshold',
                                ),
                                data: {
                                    route: 'local_presentation',
                                    files: [],
                                    designId,
                                    directionReview,
                                },
                            };
                        }
                        const selectedDirection = createPresentationVisualDirections(plan)
                            .find(item => item.id === directionReview.selectedDirectionId);
                        if (!selectedDirection) {
                            return workflowTransitionError('The selected visual direction is unknown.', workflowState);
                        }
                        plan = selectedDirection.plan;
                        plan.workflow = {
                            ...plan.workflow,
                            stage: 'final',
                            mode: 'auto',
                            designId,
                            directionReview,
                        };
                        planIssues = mapDeckIssuesToOrigins(evaluatePresentationPlan(plan), capacityPlan);
                        persistentArgs = argsWithDesignId(
                            applyPresentationDirectionToArgs(effectiveArgs, selectedDirection),
                            designId,
                        );
                        workflowState.designSample.selectedDirectionId = selectedDirection.id;
                        workflowState.designSample.reviewer = activeModelId;
                        workflowState.designSample.directionScores = directionReview.scores
                            .map(item => ({ id: item.id, total: item.total }));
                        workflowState.designSample.status = 'approved';
                        workflowState.designSample.approvedAt = Date.now();
                        workflowState.designSample.approvedTurnId = context?.turnId;
                    }
                    if (!activeModelSupportsVision) {
                        return presentationVisionUnavailable(
                            'The active model selected by the current Flux mode is text-only. Full-deck visual review was not rerouted to a separate model.',
                            workflowState,
                        );
                    }
                    workflowState.stage = 'full_generation';
                }
                if (enforceWorkflow && plan.workflow.stage === 'revision') {
                    if (!activeModelSupportsVision) {
                        return presentationVisionUnavailable(
                            'The active model selected by the current Flux mode is text-only. Revision review was not rerouted to a separate model.',
                            workflowState,
                        );
                    }
                    if (!storedWorkflowState?.fullGeneration) {
                        return workflowTransitionError(
                            'A visual revision requires an existing full deck and all-slide review evidence.',
                            workflowState,
                        );
                    }
                    if (storedWorkflowState.visualReview.status !== 'complete'
                        || !reviewedEverySlide(storedWorkflowState)) {
                        return workflowTransitionError(
                            'Inspect every slide and submit the review stage before applying revisions.',
                            workflowState,
                        );
                    }
                    if (storedWorkflowState.qa.errors === 0) {
                        return workflowTransitionError(
                            'The stored review has no blocking errors, so a revision is not required.',
                            workflowState,
                        );
                    }
                    workflowState.stage = 'revision';
                }

                await resolveImagePaths(plan, baseOutput, signal);
                const plainFilename = sanitizeFilename(effectiveArgs.filename, plan.brief.title);
                const stagedFilename = plan.workflow.stage === 'revision'
                    ? plainFilename.replace(/\.pptx$/i, `-revision-${plan.revision}.pptx`)
                    : plainFilename;
                pptxPath = await chooseUniquePath(join(outputDir, stagedFilename));
                pdfPath = relatedPath(pptxPath, '.pdf');
                previewPath = relatedPath(pptxPath, '-preview.png');
                previewDir = join(outputDir, `.openflux-presentation-${randomUUID()}`);

                if (signal?.aborted) throw abortError(signal);
                context?.onProgress?.({ type: 'progress', message: `Rendering ${plan.slides.length} editable slides` });
                const renderResult = await renderPresentation(plan, pptxPath);
                const pptxStat = await fs.stat(pptxPath);
                if (!pptxStat.isFile() || pptxStat.size === 0) {
                    throw new Error('Presentation renderer completed without producing a valid PPTX file');
                }
                const imageQa = await runImageGeometryQa(pptxPath);
                if (imageQa.available && imageQa.checkedImages !== renderResult.preparedImageCount) {
                    imageQa.issues.push({
                        severity: 'error',
                        code: 'image_geometry_count_mismatch',
                        message: `Prepared ${renderResult.preparedImageCount} image(s), but found ${imageQa.checkedImages} embedded image(s) in the PPTX.`,
                    });
                }

                const wantsPdf = bool(effectiveArgs.export_pdf, true);
                const wantsPreview = enforceWorkflow || bool(effectiveArgs.render_preview, true);
                let exportResult: PresentationExportResult | undefined;
                const exportIssues: PresentationQualityIssue[] = [];
                if ((wantsPdf || wantsPreview) && (options.exportPresentation || process.platform === 'win32')) {
                    try {
                        exportResult = await (options.exportPresentation || exportPresentationWithPowerPoint)({
                            pptxPath,
                            pdfPath: wantsPdf ? pdfPath : undefined,
                            previewDir: wantsPreview ? previewDir : undefined,
                            previewPath: wantsPreview ? previewPath : undefined,
                            signal,
                            onProgress: message => context?.onProgress?.({ type: 'progress', message }),
                        });
                    } catch (error) {
                        if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw abortError(signal);
                        exportIssues.push({
                            severity: 'warning',
                            code: 'powerpoint_qa_unavailable',
                            message: `The editable PPTX was created, but PowerPoint PDF/visual QA was unavailable: ${error instanceof Error ? error.message : String(error)}`,
                        });
                    }
                } else if (wantsPdf || wantsPreview) {
                    exportIssues.push({
                        severity: 'warning',
                        code: 'powerpoint_qa_unavailable',
                        message: 'The editable PPTX was created, but native PDF/visual QA requires PowerPoint on Windows.',
                    });
                }

                const reviewPaths = exportResult?.reviewSheetPaths?.length
                    ? exportResult.reviewSheetPaths
                    : exportResult?.previewPath ? [exportResult.previewPath] : [];
                const renderedQa = await inspectRenderedPresentation(plan, exportResult?.slideImages || []);
                const reviewTransportIssues: PresentationQualityIssue[] = [];
                if (enforceWorkflow && !reviewPaths.length) {
                    reviewTransportIssues.push({
                        severity: 'error',
                        code: 'presentation_visual_review_unavailable',
                        message: 'PowerPoint produced no readable review sheets for the active Flux model.',
                    });
                }

                const coreIssues = [
                    ...planIssues,
                    ...renderResult.imageIssues,
                    ...imageQa.issues,
                    ...(exportResult?.issues || []),
                    ...renderedQa.issues,
                    ...exportIssues,
                    ...reviewTransportIssues,
                ];
                const currentQualityState = qualityState(coreIssues, plan.revision);
                const regressed = !enforceWorkflow
                    && plan.workflow.stage === 'revision'
                    && previousQualityState !== undefined
                    && qualityRegressed(previousQualityState, currentQualityState);
                const issues = [...coreIssues];
                if (regressed && previousQualityState) {
                    issues.push({
                        severity: 'error',
                        code: 'qa_regression',
                        message: `This revision regressed from ${previousQualityState.errors} errors/${previousQualityState.warnings} warnings to ${currentQualityState.errors} errors/${currentQualityState.warnings} warnings. The stored design was not replaced; revise again from the previous design.`,
                    });
                }
                const finalQualityState = qualityState(issues, plan.revision);
                const needsRevision = issues.some(issue => issue.severity === 'error');
                const qualityGateExhausted = !enforceWorkflow
                    && needsRevision
                    && plan.revision >= MAX_PRESENTATION_REVISIONS;
                const generatedFiles = [pptxPath];
                let generatedPdfPath: string | undefined;
                if (wantsPdf && exportResult?.pdfPath) {
                    const stat = await fs.stat(exportResult.pdfPath).catch(() => undefined);
                    if (stat?.isFile() && stat.size > 0) {
                        generatedPdfPath = exportResult.pdfPath;
                        generatedFiles.push(exportResult.pdfPath);
                    }
                }
                const nativeQaAvailable = wantsPreview && reviewPaths.length > 0
                    ? (await Promise.all(reviewPaths.map(path => fs.stat(path).catch(() => undefined))))
                        .some(stat => Boolean(stat?.isFile() && stat.size > 0))
                    : false;
                let completion;
                if (enforceWorkflow) {
                    workflowState.fullGeneration = {
                        generatedAt: Date.now(),
                        slideCount: renderResult.slideCount,
                        pptx: pptxPath,
                        pdf: generatedPdfPath,
                        requirePdf: wantsPdf,
                        nativeQaAvailable,
                        imageQaAvailable: imageQa.available,
                        imageQaChecked: imageQa.checkedImages,
                        imageQaErrors: [...renderResult.imageIssues, ...imageQa.issues]
                            .filter(issue => issue.severity === 'error').length,
                    };
                    workflowState.visualReview = {
                        status: 'pending',
                        reviewedSlideNumbers: [],
                        totalSlides: renderResult.slideCount,
                        issues: [],
                    };
                    workflowState.qa = {
                        status: qaStatus(issues),
                        issues,
                        errors: finalQualityState.errors,
                        warnings: finalQualityState.warnings,
                        revision: plan.revision,
                    };
                    workflowState.outputs = { pptx: pptxPath, pdf: generatedPdfPath };
                    workflowState.stage = 'visual_review';
                    completion = await evaluatePresentationCompletion(workflowState);
                }
                // Drafts with structural or rendering errors stay internal to the
                // repair loop and must not appear as user-deliverable artifacts.
                // Under the durable workflow, even a clean render remains internal
                // until the model submits evidence that every review sheet was read.
                const files = enforceWorkflow
                    ? []
                    : needsRevision ? [] : generatedFiles;
                let images: ToolResult['images'];
                if (wantsPreview && reviewPaths.length) {
                    images = [];
                    for (let sheetIndex = 0; sheetIndex < reviewPaths.length; sheetIndex++) {
                        const data = await fs.readFile(reviewPaths[sheetIndex]).catch(() => undefined);
                        if (!data?.length) continue;
                        const firstSlide = sheetIndex * 6 + 1;
                        const lastSlide = Math.min(plan.slides.length, firstSlide + 5);
                        images.push({
                            mimeType: 'image/png',
                            data: data.toString('base64'),
                            description: [
                                `Readable visual review sheet ${sheetIndex + 1}/${reviewPaths.length} for slides ${firstSlide}-${lastSlide} in design ${designId}.`,
                                'Inspect every slide in this normal current-model turn for hierarchy, whitespace, alignment, typography, wrapping, text overlap, clipping, missing imagery, cropping, consistency, and narrative rhythm.',
                                `Then call generate_presentation with workflow.stage=review, the five-part aesthetic scorecard, overall_score, one slide_scores entry per slide, reviewed_slide_numbers for every slide, and concrete issues. If review errors remain, patch only affected slides and increment revision up to ${MAX_PRESENTATION_REVISIONS}.`,
                            ].join(' '),
                        });
                    }
                }

                const result = {
                    success: !qualityGateExhausted,
                    error: qualityGateExhausted
                        ? `Presentation quality gate failed after revision ${plan.revision}: ${finalQualityState.errors} error(s) remain. The draft was not published.`
                        : undefined,
                    code: qualityGateExhausted ? 'presentation_quality_gate_failed' : undefined,
                    retryable: false,
                    data: {
                        route: 'local_presentation',
                        files,
                        stage: enforceWorkflow ? workflowState.stage : plan.workflow.stage,
                        designId,
                        pptx: pptxPath,
                        pdf: files.find(file => file.toLowerCase().endsWith('.pdf')),
                        preview: exportResult?.previewPath,
                        slideCount: renderResult.slideCount,
                        compositions: renderResult.compositions,
                        layouts: renderResult.layouts,
                        layoutSummary: summarizePresentationLayouts(plan),
                        imageQa: {
                            available: imageQa.available,
                            checkedImages: imageQa.checkedImages,
                            issues: [...renderResult.imageIssues, ...imageQa.issues],
                        },
                        renderedQa,
                        artDirection: plan.artDirection,
                        workflow: plan.workflow,
                        workflowState: enforceWorkflow ? workflowState : undefined,
                        completion,
                        capacityPlan,
                        qa: {
                            status: enforceWorkflow
                                ? (needsRevision ? 'needs_revision' : 'ready_for_visual_review')
                                : regressed
                                    ? 'regressed'
                                    : needsRevision ? 'needs_revision' : (issues.length ? 'passed_with_warnings' : 'passed'),
                            issues,
                            errors: finalQualityState.errors,
                            warnings: finalQualityState.warnings,
                            revision: plan.revision,
                            revisionAllowed: plan.revision < MAX_PRESENTATION_REVISIONS,
                            deliveryBlocked: enforceWorkflow || needsRevision,
                            nextAction: enforceWorkflow
                                ? 'inspect_all_review_sheets_then_submit_workflow_review'
                                : regressed
                                    ? 'retry_revision_from_previous_design'
                                    : needsRevision
                                        ? (qualityGateExhausted ? 'report_quality_failure' : 'apply_structured_visual_review_patches')
                                        : 'deliver_artifacts',
                        },
                        size: pptxStat.size,
                        tookMs: Date.now() - startedAt,
                    },
                    images,
                    imagesForDisplayOnly: false,
                } satisfies ToolResult;
                log.info('Presentation generation completed', {
                    pptxPath,
                    files: generatedFiles,
                    slides: renderResult.slideCount,
                    issues: issues.length,
                    errors: finalQualityState.errors,
                    warnings: finalQualityState.warnings,
                    regressed,
                    deliveryBlocked: needsRevision,
                    tookMs: Date.now() - startedAt,
                });
                if (!regressed && (enforceWorkflow || plan.workflow.designId || plan.workflow.stage === 'revision')) {
                    if (enforceWorkflow) {
                        await saveWorkflow(workflowState);
                    } else {
                        await savePresentationDesign(baseOutput, designId, {
                            ...persistentArgs,
                            __quality_state: finalQualityState,
                        }, designStorePath);
                    }
                }
                return result;
            } catch (error) {
                if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
                    for (const path of [pptxPath, pdfPath, previewPath]) {
                        if (path) await fs.rm(path, { force: true }).catch(() => undefined);
                    }
                    throw abortError(signal);
                }
                log.error('Presentation generation failed', {
                    error: error instanceof Error ? error.message : String(error),
                });
                return structuredError(error, 'presentation_generation_failed');
            } finally {
                if (previewDir) await fs.rm(previewDir, { recursive: true, force: true }).catch(() => undefined);
                if (sampleRoot) await fs.rm(sampleRoot, { recursive: true, force: true }).catch(() => undefined);
            }
        },
    };
}

export * from './model';
export * from './capacity';
export { renderPresentation, resolvePresentationImageFrame } from './renderer';
export { inferPresentationLayoutFamily, planPresentationLayouts, summarizePresentationLayouts } from './layout-engine';
export { inspectPresentationImageGeometry } from './image-qa';
export { inspectRenderedPresentation, measureRenderedSlideActivity } from './rendered-qa';
export { createPresentationReferenceTool } from './references';
export type { PresentationReferenceToolOptions } from './references';
export { createPresentationContactSheet, exportPresentationWithPowerPoint } from './exporter';
