import type {
    PresentationArtDirection,
    PresentationDeckPlan,
    PresentationLayoutVariant,
} from './model';
import { inferPresentationLayoutFamily, planPresentationLayouts } from './layout-engine';

export type PresentationDirectionId = 'executive' | 'editorial' | 'launch';

export interface PresentationVisualDirection {
    id: PresentationDirectionId;
    name: string;
    description: string;
    plan: PresentationDeckPlan;
}

function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function channel(value: string, offset: number): number {
    return Number.parseInt(value.slice(offset, offset + 2), 16);
}

function hex(value: number): string {
    return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0').toUpperCase();
}

function mix(first: string, second: string, secondShare: number): string {
    return [0, 2, 4].map(offset => hex(
        channel(first, offset) * (1 - secondShare) + channel(second, offset) * secondShare,
    )).join('');
}

function luminance(value: string): number {
    const values = [0, 2, 4].map(offset => channel(value, offset) / 255).map(item => (
        item <= 0.03928 ? item / 12.92 : ((item + 0.055) / 1.055) ** 2.4
    ));
    return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
}

function variantFor(
    direction: PresentationDirectionId,
    family: ReturnType<typeof inferPresentationLayoutFamily>,
    hasImage: boolean,
): PresentationLayoutVariant {
    if (direction === 'executive') {
        if (family === 'cover' || family === 'closing') return 'centered';
        if (family === 'evidence') return 'spotlight';
        if (family === 'collection' || family === 'comparison') return 'cards';
        return 'editorial';
    }
    if (direction === 'editorial') {
        if (family === 'cover') return hasImage ? 'asymmetric' : 'centered';
        if (family === 'section') return 'banded';
        if (family === 'process') return 'stacked';
        return 'asymmetric';
    }
    if (family === 'cover' || family === 'quote') return hasImage ? 'full-bleed' : 'centered';
    if (family === 'evidence') return 'spotlight';
    if (family === 'process') return 'banded';
    if (family === 'collection' || family === 'comparison') return 'cards';
    return 'asymmetric';
}

function artFor(direction: PresentationDirectionId, base: PresentationArtDirection): PresentationArtDirection {
    if (direction === 'executive') {
        return {
            ...clone(base),
            mood: 'decisive, restrained, executive editorial',
            rationale: 'A disciplined decision-making language with strong claims, generous whitespace, and quiet evidence.',
            visualLanguage: 'precision',
            designConcept: base.designConcept || 'A decision axis turns evidence into one clear management choice.',
            signatureElement: 'axis',
            density: base.density === 'compact' ? 'balanced' : base.density,
            spacing: 'generous',
            motif: base.motif === 'none' ? 'line' : base.motif,
            backgroundTreatment: 'solid',
            imageTreatment: base.imageTreatment === 'full-bleed' ? 'natural' : base.imageTreatment,
            chartStyle: 'minimal',
            designPrinciples: [
                'One decisive claim per page',
                'Evidence is quieter than the conclusion',
                'Use whitespace as hierarchy',
                ...base.designPrinciples,
            ].slice(0, 8),
            avoid: ['dashboard chrome', 'decorative gradients', 'dense card walls', ...base.avoid].slice(0, 8),
        };
    }
    if (direction === 'editorial') {
        return {
            ...clone(base),
            mood: 'editorial, asymmetric, story-led',
            rationale: 'A publication-like direction that uses contrast in scale and asymmetric composition to carry a narrative.',
            visualLanguage: 'editorial',
            designConcept: base.designConcept || 'Editorial cutouts shift scale and alignment as the story develops.',
            signatureElement: 'cutout',
            spacing: 'generous',
            motif: 'blocks',
            backgroundTreatment: 'tonal',
            imageTreatment: base.imageTreatment === 'natural' ? 'framed' : base.imageTreatment,
            chartStyle: 'editorial',
            grid: { ...base.grid, columns: 12, gutter: Math.max(base.grid.gutter, 0.24) },
            designPrinciples: [
                'Create a dominant reading entry on every page',
                'Alternate wide statements with contained evidence',
                'Use asymmetry without sacrificing alignment',
                ...base.designPrinciples,
            ].slice(0, 8),
            avoid: ['equal-weight boxes', 'centered body copy', 'repeated symmetric grids', ...base.avoid].slice(0, 8),
        };
    }

    const baseIsDark = luminance(base.palette.background) < 0.25;
    const background = baseIsDark ? base.palette.background : base.palette.text;
    const foreground = baseIsDark ? base.palette.text : base.palette.background;
    return {
        ...clone(base),
        mood: 'bold, cinematic, product-launch energy',
        rationale: 'A high-contrast direction that creates visual peaks for launches, persuasion, and memorable claims.',
        visualLanguage: 'kinetic',
        designConcept: base.designConcept || 'A moving pulse links claims, proof, and the final call to action.',
        signatureElement: base.motif === 'orbit' ? 'orbit' : 'pulse',
        density: 'airy',
        spacing: 'generous',
        motif: base.motif === 'orbit' ? 'orbit' : 'none',
        backgroundTreatment: 'solid',
        imageTreatment: 'full-bleed',
        chartStyle: 'bold',
        palette: {
            ...base.palette,
            background,
            surface: mix(background, foreground, 0.12),
            text: foreground,
            muted: mix(foreground, background, 0.35),
        },
        designPrinciples: [
            'Use scale contrast to create memorable peaks',
            'Let imagery or one number dominate when evidence allows',
            'Keep supporting copy terse',
            ...base.designPrinciples,
        ].slice(0, 8),
        avoid: ['small repeated cards', 'long paragraphs', 'weak focal points', ...base.avoid].slice(0, 8),
    };
}

export function createPresentationVisualDirections(plan: PresentationDeckPlan): PresentationVisualDirection[] {
    const definitions: Array<{
        id: PresentationDirectionId;
        name: string;
        description: string;
    }> = [
        {
            id: 'executive',
            name: 'Executive Editorial',
            description: 'Restrained, decisive, highly readable, and suited to leadership decisions.',
        },
        {
            id: 'editorial',
            name: 'Editorial Story',
            description: 'Asymmetric, publication-like, and designed to turn source material into a narrative.',
        },
        {
            id: 'launch',
            name: 'Bold Launch',
            description: 'High-contrast, image-led, and designed for memorable persuasion.',
        },
    ];

    return definitions.map(definition => {
        const candidate = clone(plan);
        candidate.artDirection = artFor(definition.id, plan.artDirection);
        candidate.slides.forEach((slide, index) => {
            const family = inferPresentationLayoutFamily(slide, index, candidate.slides.length);
            // Semantic ledgers already have purpose-built, capacity-tested
            // geometry. Visual directions may restyle them, but must not push
            // them back into generic cards or mosaics.
            slide.layout.variant = ['events', 'sources'].includes(slide.informationRole)
                ? 'auto'
                : variantFor(definition.id, family, Boolean(slide.imagePath));
            slide.layout.whitespace = definition.id === 'launch'
                ? 'generous'
                : candidate.artDirection.spacing === 'tight' ? 'compact' : candidate.artDirection.spacing;
            slide.layout.emphasis = family === 'evidence'
                ? 'data'
                : slide.imagePath ? 'visual' : definition.id === 'executive' ? 'message' : 'balanced';
        });
        planPresentationLayouts(candidate);
        return { ...definition, plan: candidate };
    });
}

function artDirectionArgs(art: PresentationArtDirection): Record<string, unknown> {
    return {
        mood: art.mood,
        rationale: art.rationale,
        image_style: art.imageStyle,
        visual_language: art.visualLanguage,
        design_concept: art.designConcept,
        signature_element: art.signatureElement,
        density: art.density,
        palette: { ...art.palette },
        typography: {
            heading: art.typography.heading,
            body: art.typography.body,
            title_scale: art.typography.titleScale,
            body_scale: art.typography.bodyScale,
        },
        spacing: art.spacing,
        motif: art.motif,
        background_treatment: art.backgroundTreatment,
        image_treatment: art.imageTreatment,
        chart_style: art.chartStyle,
        grid: { ...art.grid },
        design_principles: [...art.designPrinciples],
        reference_summary: art.referenceSummary,
        avoid: [...art.avoid],
    };
}

/** Persist the winning direction using the existing v1 design-store schema so
 * old design ids and slide patches continue to work without a migration. */
export function applyPresentationDirectionToArgs(
    args: Record<string, unknown>,
    direction: PresentationVisualDirection,
): Record<string, unknown> {
    const result = clone(args);
    result.art_direction = artDirectionArgs(direction.plan.artDirection);
    const slides = Array.isArray(result.slides) ? result.slides.map(item => clone(item) as Record<string, unknown>) : [];
    direction.plan.slides.forEach((slide, index) => {
        const source = slides[index] || {};
        source.layout = {
            ...(source.layout && typeof source.layout === 'object' && !Array.isArray(source.layout)
                ? source.layout as Record<string, unknown>
                : {}),
            archetype: slide.layout.archetype,
            variant: slide.layout.variant,
            emphasis: slide.layout.emphasis,
            alignment: slide.layout.alignment,
            image_position: slide.layout.imagePosition,
            whitespace: slide.layout.whitespace,
            focal_scale: slide.layout.focalScale,
            rationale: slide.layout.rationale,
        };
        slides[index] = source;
    });
    result.slides = slides;
    return result;
}
