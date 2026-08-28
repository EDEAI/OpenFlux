/** Visual reference inspection for model-directed presentation design. */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { PDFParse } from 'pdf-parse';
import sharp from 'sharp';
import type { Tool, ToolExecutionContext, ToolResult } from '../types';
import {
    exportPresentationWithPowerPoint,
    type PresentationExportOptions,
    type PresentationExportResult,
} from './exporter';

export interface PresentationReferenceToolOptions {
    getOutputPath?: () => string;
    exportPresentation?: (options: PresentationExportOptions) => Promise<PresentationExportResult>;
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);
const POWERPOINT_EXTENSIONS = new Set(['.ppt', '.pptx']);
const MAX_REFERENCE_IMAGES = 8;

function isWithin(basePath: string, targetPath: string): boolean {
    const rel = relative(resolve(basePath), resolve(targetPath));
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function abortError(signal?: AbortSignal): Error {
    const reason = signal?.reason;
    const error = new Error(reason instanceof Error ? reason.message : 'Presentation reference inspection aborted');
    error.name = 'AbortError';
    return error;
}

async function renderImageReference(path: string): Promise<Buffer> {
    return sharp(path, { limitInputPixels: 40_000_000, animated: false })
        .rotate()
        .resize({ width: 1600, height: 1000, fit: 'inside', withoutEnlargement: true })
        .png({ compressionLevel: 8 })
        .toBuffer();
}

async function renderPdfReference(path: string, pagesPerFile: number): Promise<Array<{ page: number; data: Buffer }>> {
    const parser = new PDFParse({ data: await fs.readFile(path) });
    try {
        const result = await parser.getScreenshot({
            first: pagesPerFile,
            desiredWidth: 1400,
            imageDataUrl: false,
            imageBuffer: true,
        });
        return result.pages.map(page => ({ page: page.pageNumber, data: Buffer.from(page.data) }));
    } finally {
        await parser.destroy();
    }
}

async function renderPowerPointReference(
    path: string,
    pagesPerFile: number,
    tempRoot: string,
    options: PresentationReferenceToolOptions,
    context?: ToolExecutionContext,
): Promise<Array<{ page: number; data: Buffer }>> {
    if (!options.exportPresentation && process.platform !== 'win32') {
        throw new Error('PowerPoint visual references require desktop PowerPoint on Windows');
    }
    const previewDir = join(tempRoot, `slides-${randomUUID()}`);
    const previewPath = join(tempRoot, `contact-${randomUUID()}.png`);
    await (options.exportPresentation || exportPresentationWithPowerPoint)({
        pptxPath: path,
        previewDir,
        previewPath,
        signal: context?.abortSignal || context?.signal,
        onProgress: message => context?.onProgress?.({ type: 'progress', message }),
    });
    const names = (await fs.readdir(previewDir))
        .filter(name => /^slide-\d+\.png$/i.test(name))
        .sort()
        .slice(0, pagesPerFile);
    return Promise.all(names.map(async (name, index) => ({
        page: index + 1,
        data: await fs.readFile(join(previewDir, name)),
    })));
}

export function createPresentationReferenceTool(options: PresentationReferenceToolOptions = {}): Tool {
    return {
        name: 'inspect_presentation_references',
        priority: 16,
        description: [
            'Render local presentation design references so the model can inspect them visually before designing a new deck.',
            'Supports PPT/PPTX, PDF, and common image files inside the active Project.',
            'Use the returned images to extract design DNA: hierarchy, grid, whitespace, typography, palette, imagery, charts, motifs, rhythm, and elements to avoid.',
            'Do not copy a reference as a fixed template and do not infer brand claims that are not visible.',
        ].join(' '),
        parameters: {
            paths: { type: 'array', description: 'One to four local reference paths inside the active Project.', required: true, items: { type: 'string' } },
            pages_per_file: { type: 'number', description: 'Representative pages to render from each multipage reference (1-3).', default: 3 },
        },
        rawInputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['paths'],
            properties: {
                paths: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string' } },
                pages_per_file: { type: 'integer', minimum: 1, maximum: 3, default: 3 },
            },
        },
        async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
            const signal = context?.abortSignal || context?.signal;
            if (signal?.aborted) throw abortError(signal);
            const paths = Array.isArray(args.paths)
                ? args.paths.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).slice(0, 4)
                : [];
            if (!paths.length) return { success: false, error: 'paths must contain at least one presentation reference', code: 'reference_paths_required' };
            const pagesPerFile = Math.min(3, Math.max(1, Math.trunc(Number(args.pages_per_file) || 3)));
            const baseOutput = resolve(options.getOutputPath?.() || process.cwd());
            const tempRoot = join(baseOutput, `.openflux-presentation-references-${randomUUID()}`);
            const images: NonNullable<ToolResult['images']> = [];
            const inspected: Array<{ path: string; pages: number }> = [];
            const warnings: string[] = [];

            await fs.mkdir(tempRoot, { recursive: true });
            try {
                for (const rawPath of paths) {
                    if (signal?.aborted) throw abortError(signal);
                    const path = resolve(isAbsolute(rawPath) ? rawPath : join(baseOutput, rawPath));
                    if (!isWithin(baseOutput, path)) {
                        warnings.push(`${basename(path)} was skipped because it is outside the active Project.`);
                        continue;
                    }
                    const stat = await fs.stat(path).catch(() => undefined);
                    if (!stat?.isFile()) {
                        warnings.push(`${basename(path)} is not a readable file.`);
                        continue;
                    }
                    const extension = extname(path).toLowerCase();
                    try {
                        let rendered: Array<{ page: number; data: Buffer }> = [];
                        if (IMAGE_EXTENSIONS.has(extension)) {
                            rendered = [{ page: 1, data: await renderImageReference(path) }];
                        } else if (extension === '.pdf') {
                            rendered = await renderPdfReference(path, pagesPerFile);
                        } else if (POWERPOINT_EXTENSIONS.has(extension)) {
                            rendered = await renderPowerPointReference(path, pagesPerFile, tempRoot, options, context);
                        } else {
                            warnings.push(`${basename(path)} has an unsupported reference format.`);
                            continue;
                        }
                        inspected.push({ path, pages: rendered.length });
                        for (const page of rendered) {
                            if (images.length >= MAX_REFERENCE_IMAGES) break;
                            images.push({
                                mimeType: 'image/png',
                                data: page.data.toString('base64'),
                                description: `${basename(path)} — visual reference page ${page.page}. Analyze design principles and transferable visual relationships; do not copy it as a fixed template.`,
                            });
                        }
                    } catch (error) {
                        warnings.push(`${basename(path)} could not be rendered: ${error instanceof Error ? error.message : String(error)}`);
                    }
                    if (images.length >= MAX_REFERENCE_IMAGES) break;
                }

                if (!images.length) {
                    return {
                        success: false,
                        error: warnings.join(' ') || 'No visual reference could be rendered.',
                        code: 'reference_render_failed',
                    };
                }
                return {
                    success: true,
                    data: {
                        route: 'local_presentation_reference',
                        files: [],
                        inspected,
                        warnings,
                        nextAction: 'Extract a concise design DNA and pass it into generate_presentation.art_direction.reference_summary, design_principles, visual controls, and avoid list.',
                    },
                    images,
                };
            } finally {
                await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
            }
        },
    };
}
