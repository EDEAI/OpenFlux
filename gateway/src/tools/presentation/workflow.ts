/** Durable presentation workflow state and machine-verifiable completion predicate. */

import { promises as fs } from 'node:fs';
import type { PresentationDeckPlan, PresentationQualityIssue } from './model';

export type PresentationProcessStage =
    | 'content_direction'
    | 'design_sample'
    | 'full_generation'
    | 'visual_review'
    | 'revision'
    | 'packaging'
    | 'completed';

export type PresentationSampleStatus = 'pending' | 'ready' | 'approved' | 'waived';

export interface PresentationWorkflowState {
    version: 1;
    designId: string;
    sessionId?: string;
    initialTurnId?: string;
    updatedAt: number;
    stage: PresentationProcessStage;
    contentDirection: {
        complete: boolean;
        communicationJob?: string;
        narrativeArc: string[];
        slideCount: number;
    };
    designSample: {
        required: boolean;
        status: PresentationSampleStatus;
        mode: 'auto' | 'confirm';
        sampleSlideNumbers: number[];
        generatedAt?: number;
        approvedAt?: number;
        approvedTurnId?: string;
        /** Internally generated alternatives. The active Flux model selects
         * among them on its next normal Agent-loop turn. */
        directionIds?: string[];
        mechanicallyCleanDirectionIds?: string[];
        /** Best mechanically failing direction retained for a single-direction
         * geometry repair, avoiding another three-direction render. */
        repairDirectionId?: string;
        selectedDirectionId?: string;
        reviewer?: string;
        directionScores?: Array<{ id: string; total: number }>;
    };
    fullGeneration?: {
        generatedAt: number;
        slideCount: number;
        pptx: string;
        pdf?: string;
        requirePdf: boolean;
        nativeQaAvailable: boolean;
        imageQaAvailable: boolean;
        imageQaChecked: number;
        imageQaErrors: number;
    };
    visualReview: {
        status: 'pending' | 'complete';
        reviewedSlideNumbers: number[];
        totalSlides: number;
        issues: PresentationQualityIssue[];
        reviewedAt?: number;
    };
    qa: {
        status: 'pending' | 'needs_revision' | 'regressed' | 'passed' | 'passed_with_warnings';
        issues: PresentationQualityIssue[];
        errors: number;
        warnings: number;
        revision: number;
    };
    outputs?: {
        pptx: string;
        pdf?: string;
    };
}

export interface PresentationCompletionResult {
    complete: boolean;
    stage: PresentationProcessStage;
    missing: string[];
    nextAction:
        | 'fix_content_direction'
        | 'render_design_sample'
        | 'select_design_direction'
        | 'approve_design_sample'
        | 'generate_full_deck'
        | 'review_every_slide'
        | 'patch_review_errors'
        | 'repair_output_package'
        | 'deliver_artifacts';
    files: string[];
}

function object(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function strings(value: unknown): string[] {
    return Array.isArray(value)
        ? value.map(item => String(item || '').trim()).filter(Boolean)
        : [];
}

function numbers(value: unknown): number[] {
    return Array.isArray(value)
        ? value.map(Number).filter(Number.isFinite).map(Math.trunc).filter(item => item > 0)
            .filter((item, index, values) => values.indexOf(item) === index)
            .sort((a, b) => a - b)
        : [];
}

function normalizeIssues(value: unknown): PresentationQualityIssue[] {
    if (!Array.isArray(value)) return [];
    return value.map(item => {
        const source = object(item);
        return {
            severity: source.severity === 'error' ? 'error' : 'warning',
            code: String(source.code || 'visual_review_issue'),
            message: String(source.message || ''),
            slide: Number.isFinite(Number(source.slide)) ? Math.trunc(Number(source.slide)) : undefined,
            sourceSlide: Number.isFinite(Number(source.sourceSlide))
                ? Math.trunc(Number(source.sourceSlide))
                : undefined,
        } satisfies PresentationQualityIssue;
    }).filter(issue => issue.message);
}

export function createPresentationWorkflowState(
    plan: PresentationDeckPlan,
    designId: string,
    context?: { sessionId?: string; turnId?: string },
): PresentationWorkflowState {
    const contentIssues = plan.brief.deliveryMode === 'marketing'
        ? !plan.brief.communicationJob || plan.brief.narrativeArc.length < 3 || plan.slides.length > 22
        : plan.brief.narrativeArc.length < 1;
    const sampleRequired = plan.slides.length >= 4;
    return {
        version: 1,
        designId,
        sessionId: context?.sessionId,
        initialTurnId: context?.turnId,
        updatedAt: Date.now(),
        stage: contentIssues ? 'content_direction' : (sampleRequired ? 'design_sample' : 'full_generation'),
        contentDirection: {
            complete: !contentIssues,
            communicationJob: plan.brief.communicationJob,
            narrativeArc: [...plan.brief.narrativeArc],
            slideCount: plan.slides.length,
        },
        designSample: {
            required: sampleRequired,
            status: sampleRequired ? 'pending' : 'waived',
            mode: plan.workflow.mode,
            sampleSlideNumbers: [],
        },
        visualReview: {
            status: 'pending',
            reviewedSlideNumbers: [],
            totalSlides: plan.slides.length,
            issues: [],
        },
        qa: {
            status: 'pending',
            issues: [],
            errors: 0,
            warnings: 0,
            revision: plan.revision,
        },
    };
}

export function readPresentationWorkflowState(value: unknown): PresentationWorkflowState | undefined {
    const source = object(value);
    if (source.version !== 1 || typeof source.designId !== 'string') return undefined;
    const content = object(source.contentDirection);
    const sample = object(source.designSample);
    const generation = object(source.fullGeneration);
    const review = object(source.visualReview);
    const qa = object(source.qa);
    const outputs = object(source.outputs);
    const stage = String(source.stage) as PresentationProcessStage;
    const supportedStages: PresentationProcessStage[] = [
        'content_direction', 'design_sample', 'full_generation', 'visual_review',
        'revision', 'packaging', 'completed',
    ];
    if (!supportedStages.includes(stage)) return undefined;
    return {
        version: 1,
        designId: source.designId,
        sessionId: typeof source.sessionId === 'string' ? source.sessionId : undefined,
        initialTurnId: typeof source.initialTurnId === 'string' ? source.initialTurnId : undefined,
        updatedAt: Number(source.updatedAt) || Date.now(),
        stage,
        contentDirection: {
            complete: content.complete === true,
            communicationJob: typeof content.communicationJob === 'string' ? content.communicationJob : undefined,
            narrativeArc: strings(content.narrativeArc),
            slideCount: Math.max(0, Math.trunc(Number(content.slideCount) || 0)),
        },
        designSample: {
            required: sample.required === true,
            status: ['pending', 'ready', 'approved', 'waived'].includes(String(sample.status))
                ? sample.status as PresentationSampleStatus
                : 'pending',
            mode: sample.mode === 'confirm' ? 'confirm' : 'auto',
            sampleSlideNumbers: numbers(sample.sampleSlideNumbers),
            generatedAt: Number(sample.generatedAt) || undefined,
            approvedAt: Number(sample.approvedAt) || undefined,
            approvedTurnId: typeof sample.approvedTurnId === 'string' ? sample.approvedTurnId : undefined,
            directionIds: strings(sample.directionIds),
            mechanicallyCleanDirectionIds: strings(sample.mechanicallyCleanDirectionIds),
            repairDirectionId: typeof sample.repairDirectionId === 'string' ? sample.repairDirectionId : undefined,
            selectedDirectionId: typeof sample.selectedDirectionId === 'string' ? sample.selectedDirectionId : undefined,
            reviewer: typeof sample.reviewer === 'string' ? sample.reviewer : undefined,
            directionScores: Array.isArray(sample.directionScores)
                ? sample.directionScores.map(item => {
                    const score = object(item);
                    return { id: String(score.id || ''), total: Number(score.total) || 0 };
                }).filter(item => item.id)
                : undefined,
        },
        fullGeneration: generation.pptx ? {
            generatedAt: Number(generation.generatedAt) || Date.now(),
            slideCount: Math.max(0, Math.trunc(Number(generation.slideCount) || 0)),
            pptx: String(generation.pptx),
            pdf: typeof generation.pdf === 'string' ? generation.pdf : undefined,
            requirePdf: generation.requirePdf === true,
            nativeQaAvailable: generation.nativeQaAvailable === true,
            imageQaAvailable: generation.imageQaAvailable === true,
            imageQaChecked: Math.max(0, Math.trunc(Number(generation.imageQaChecked) || 0)),
            imageQaErrors: Math.max(0, Math.trunc(Number(generation.imageQaErrors) || 0)),
        } : undefined,
        visualReview: {
            status: review.status === 'complete' ? 'complete' : 'pending',
            reviewedSlideNumbers: numbers(review.reviewedSlideNumbers),
            totalSlides: Math.max(0, Math.trunc(Number(review.totalSlides) || 0)),
            issues: normalizeIssues(review.issues),
            reviewedAt: Number(review.reviewedAt) || undefined,
        },
        qa: {
            status: ['needs_revision', 'regressed', 'passed', 'passed_with_warnings'].includes(String(qa.status))
                ? qa.status as PresentationWorkflowState['qa']['status']
                : 'pending',
            issues: normalizeIssues(qa.issues),
            errors: Math.max(0, Math.trunc(Number(qa.errors) || 0)),
            warnings: Math.max(0, Math.trunc(Number(qa.warnings) || 0)),
            revision: Math.max(0, Math.trunc(Number(qa.revision) || 0)),
        },
        outputs: outputs.pptx ? {
            pptx: String(outputs.pptx),
            pdf: typeof outputs.pdf === 'string' ? outputs.pdf : undefined,
        } : undefined,
    };
}

async function validNonEmptyFile(path: string | undefined): Promise<boolean> {
    if (!path) return false;
    const stat = await fs.stat(path).catch(() => undefined);
    return Boolean(stat?.isFile() && stat.size > 0);
}

export function reviewedEverySlide(state: PresentationWorkflowState): boolean {
    const total = state.visualReview.totalSlides || state.contentDirection.slideCount;
    if (total <= 0) return false;
    const reviewed = new Set(state.visualReview.reviewedSlideNumbers);
    return Array.from({ length: total }, (_, index) => index + 1).every(slide => reviewed.has(slide));
}

export async function evaluatePresentationCompletion(
    state: PresentationWorkflowState,
): Promise<PresentationCompletionResult> {
    const missing: string[] = [];
    if (!state.contentDirection.complete) missing.push('content_direction_incomplete');
    if (state.designSample.required && state.designSample.status === 'pending') missing.push('design_sample_not_rendered');
    if (state.designSample.required && state.designSample.status === 'ready' && !state.designSample.selectedDirectionId) {
        missing.push('design_direction_not_selected');
    }
    if (state.designSample.required && state.designSample.status === 'ready') missing.push('design_sample_not_approved');
    if (!state.fullGeneration) missing.push('full_deck_not_generated');
    if (state.fullGeneration && !state.fullGeneration.nativeQaAvailable) missing.push('native_visual_qa_unavailable');
    if (state.fullGeneration && !state.fullGeneration.imageQaAvailable) missing.push('image_geometry_qa_unavailable');
    if (state.fullGeneration && state.fullGeneration.imageQaErrors > 0) missing.push('image_qa_errors_remain');
    if (!reviewedEverySlide(state) || state.visualReview.status !== 'complete') missing.push('not_all_slides_reviewed');
    if (state.qa.errors > 0 || ['needs_revision', 'regressed'].includes(state.qa.status)) {
        missing.push('qa_errors_remain');
    }

    const pptx = state.outputs?.pptx || state.fullGeneration?.pptx;
    const pdf = state.outputs?.pdf || state.fullGeneration?.pdf;
    if (!(await validNonEmptyFile(pptx))) missing.push('pptx_missing_or_empty');
    if (state.fullGeneration?.requirePdf && !(await validNonEmptyFile(pdf))) missing.push('pdf_missing_or_empty');

    let nextAction: PresentationCompletionResult['nextAction'] = 'deliver_artifacts';
    if (missing.includes('content_direction_incomplete')) nextAction = 'fix_content_direction';
    else if (missing.includes('design_sample_not_rendered')) nextAction = 'render_design_sample';
    else if (missing.includes('design_direction_not_selected')) nextAction = 'select_design_direction';
    else if (missing.includes('design_sample_not_approved')) nextAction = 'approve_design_sample';
    else if (missing.includes('full_deck_not_generated')) nextAction = 'generate_full_deck';
    else if (missing.includes('not_all_slides_reviewed')) nextAction = 'review_every_slide';
    else if (missing.includes('qa_errors_remain') || missing.includes('image_qa_errors_remain')) nextAction = 'patch_review_errors';
    else if (missing.length) nextAction = 'repair_output_package';

    const complete = missing.length === 0;
    return {
        complete,
        stage: complete ? 'completed' : state.stage,
        missing,
        nextAction,
        files: complete ? [pptx, state.fullGeneration?.requirePdf ? pdf : undefined]
            .filter((path): path is string => Boolean(path)) : [],
    };
}

export function presentationCompletionFromToolResult(result: unknown): PresentationCompletionResult | undefined {
    const data = object(object(result).data);
    const completion = object(data.completion);
    if (typeof completion.complete !== 'boolean') return undefined;
    return {
        complete: completion.complete,
        stage: String(completion.stage || 'content_direction') as PresentationProcessStage,
        missing: strings(completion.missing),
        nextAction: String(completion.nextAction || 'fix_content_direction') as PresentationCompletionResult['nextAction'],
        files: strings(completion.files),
    };
}
