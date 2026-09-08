import sharp from 'sharp';
import {
    isIntentionalPresentationBoundary,
    type PresentationDeckPlan,
    type PresentationQualityIssue,
} from './model';

const SAMPLE_WIDTH = 320;
const SAMPLE_HEIGHT = 180;
const GRID_COLUMNS = 16;
const GRID_ROWS = 9;

export interface RenderedSlideActivity {
    slide: number;
    edgeDensity: number;
    occupiedCellRatio: number;
    occupiedCells: number;
    totalCells: number;
}

export interface RenderedPresentationQaResult {
    available: boolean;
    slides: RenderedSlideActivity[];
    issues: PresentationQualityIssue[];
}

function colorDelta(data: Buffer, first: number, second: number): number {
    return Math.max(
        Math.abs(data[first] - data[second]),
        Math.abs(data[first + 1] - data[second + 1]),
        Math.abs(data[first + 2] - data[second + 2]),
    );
}

export async function measureRenderedSlideActivity(path: string, slide: number): Promise<RenderedSlideActivity> {
    const { data, info } = await sharp(path, { limitInputPixels: 40_000_000 })
        .flatten({ background: '#ffffff' })
        .resize(SAMPLE_WIDTH, SAMPLE_HEIGHT, { fit: 'fill' })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    const channels = info.channels;
    const cellCounts = Array.from({ length: GRID_COLUMNS * GRID_ROWS }, () => 0);
    let edgePixels = 0;
    for (let y = 1; y < info.height; y++) {
        for (let x = 1; x < info.width; x++) {
            const index = (y * info.width + x) * channels;
            const left = index - channels;
            const above = index - info.width * channels;
            if (Math.max(colorDelta(data, index, left), colorDelta(data, index, above)) < 28) continue;
            edgePixels += 1;
            const column = Math.min(GRID_COLUMNS - 1, Math.floor(x / (info.width / GRID_COLUMNS)));
            const row = Math.min(GRID_ROWS - 1, Math.floor(y / (info.height / GRID_ROWS)));
            cellCounts[row * GRID_COLUMNS + column] += 1;
        }
    }
    const cellArea = (info.width / GRID_COLUMNS) * (info.height / GRID_ROWS);
    const occupiedCells = cellCounts.filter(count => count >= Math.max(6, cellArea * 0.022)).length;
    return {
        slide,
        edgeDensity: edgePixels / (info.width * info.height),
        occupiedCellRatio: occupiedCells / cellCounts.length,
        occupiedCells,
        totalCells: cellCounts.length,
    };
}

function continuationTitle(value: string): boolean {
    return /[（(]\d+\s*\/\s*\d+[）)]\s*$/.test(value);
}

export async function inspectRenderedPresentation(
    plan: PresentationDeckPlan,
    slideImages: string[],
): Promise<RenderedPresentationQaResult> {
    if (!slideImages.length || slideImages.length !== plan.slides.length) {
        return { available: false, slides: [], issues: [] };
    }
    const slides = await Promise.all(slideImages.map((path, index) => measureRenderedSlideActivity(path, index + 1)));
    const issues: PresentationQualityIssue[] = [];
    slides.forEach((activity, index) => {
        const slide = plan.slides[index];
        const boundary = isIntentionalPresentationBoundary(slide, index, plan.slides.length);
        const continuation = continuationTitle(slide.title || slide.message);
        if (!boundary && continuation && activity.occupiedCellRatio < 0.3) {
            issues.push({
                severity: 'error',
                code: 'rendered_orphaned_continuation',
                slide: index + 1,
                message: `The rendered continuation occupies only ${Math.round(activity.occupiedCellRatio * 100)}% of the visual grid. Merge it with its companion page.`,
            });
        } else if (!boundary && !slide.imagePath && activity.occupiedCellRatio < 0.22 && activity.edgeDensity < 0.055) {
            issues.push({
                severity: 'warning',
                code: 'rendered_content_utilization_low',
                slide: index + 1,
                message: `The rendered content occupies only ${Math.round(activity.occupiedCellRatio * 100)}% of the visual grid. Strengthen the evidence or use a more suitable composition.`,
            });
        }
    });
    return { available: true, slides, issues };
}
