/** Machine-verifiable image geometry checks for generated PPTX files. */

import { promises as fs } from 'node:fs';
import { posix } from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';
import type { PresentationQualityIssue } from './model';

const EMU_PER_INCH = 914_400;
const ASPECT_TOLERANCE = 0.02;
const MIN_IMAGE_PPI = 120;
const ERROR_IMAGE_PPI = 96;
const GENERATED_VECTOR_ALT_PREFIX = 'OpenFlux generated vector:';

export interface PresentationImageQaResult {
    available: boolean;
    checkedImages: number;
    issues: PresentationQualityIssue[];
}

function attribute(xml: string, name: string): string | undefined {
    return xml.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
}

function isGeneratedVectorPicture(xml: string): boolean {
    const nonVisualProperties = xml.match(/<p:cNvPr\b([^>]*)\/?\s*>/)?.[1];
    const description = nonVisualProperties ? attribute(nonVisualProperties, 'descr') : undefined;
    return description?.startsWith(GENERATED_VECTOR_ALT_PREFIX) === true;
}

function slideNumber(path: string): number {
    return Number(path.match(/slide(\d+)\.xml$/i)?.[1] || 0);
}

function imageRelationships(xml: string, slidePath: string): Map<string, string> {
    const relationships = new Map<string, string>();
    for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)) {
        const attrs = match[1];
        const id = attribute(attrs, 'Id');
        const target = attribute(attrs, 'Target');
        const type = attribute(attrs, 'Type');
        if (!id || !target || !type?.endsWith('/image')) continue;
        const resolved = target.startsWith('/')
            ? target.slice(1)
            : posix.normalize(posix.join(posix.dirname(slidePath), target));
        relationships.set(id, resolved);
    }
    return relationships;
}

function cropFraction(xml: string, side: 'l' | 't' | 'r' | 'b'): number {
    const raw = Number(attribute(xml, side) || 0);
    return Number.isFinite(raw) ? raw / 100_000 : 0;
}

export async function inspectPresentationImageGeometry(
    pptxPath: string,
): Promise<PresentationImageQaResult> {
    const zip = await JSZip.loadAsync(await fs.readFile(pptxPath));
    const issues: PresentationQualityIssue[] = [];
    let checkedImages = 0;
    const slides = Object.keys(zip.files)
        .filter(path => /^ppt\/slides\/slide\d+\.xml$/i.test(path))
        .sort((left, right) => slideNumber(left) - slideNumber(right));

    for (const slidePath of slides) {
        const slide = slideNumber(slidePath);
        const slideXml = await zip.file(slidePath)!.async('string');
        const relPath = `${posix.dirname(slidePath)}/_rels/${posix.basename(slidePath)}.rels`;
        const relFile = zip.file(relPath);
        const relationships = relFile
            ? imageRelationships(await relFile.async('string'), slidePath)
            : new Map<string, string>();

        for (const picture of slideXml.matchAll(/<p:pic(?:\s[^>]*)?>[\s\S]*?<\/p:pic>/g)) {
            const xml = picture[0];
            // Renderer-authored SVGs are intentional vector artwork. Raster PPI,
            // crop and prepared-image-count checks do not apply to them.
            if (isGeneratedVectorPicture(xml)) continue;
            const relationshipId = xml.match(/<a:blip\b[^>]*\br:embed="([^"]+)"/)?.[1];
            const shapeProperties = xml.match(/<p:spPr(?:\s[^>]*)?>([\s\S]*?)<\/p:spPr>/)?.[1];
            const extentXml = shapeProperties?.match(/<a:ext\b([^>]*)\/?\s*>/)?.[1];
            const widthEmu = Number(extentXml ? attribute(extentXml, 'cx') : 0);
            const heightEmu = Number(extentXml ? attribute(extentXml, 'cy') : 0);
            const mediaPath = relationshipId ? relationships.get(relationshipId) : undefined;
            const mediaFile = mediaPath ? zip.file(mediaPath) : undefined;
            if (!mediaFile || widthEmu <= 0 || heightEmu <= 0) {
                issues.push({
                    severity: 'error',
                    code: 'image_geometry_unreadable',
                    slide,
                    message: 'An embedded image is missing its media relationship or display dimensions.',
                });
                continue;
            }

            const buffer = await mediaFile.async('nodebuffer');
            const metadata = await sharp(buffer, { limitInputPixels: 40_000_000, animated: false }).metadata();
            if (!metadata.width || !metadata.height) {
                issues.push({
                    severity: 'error',
                    code: 'image_geometry_unreadable',
                    slide,
                    message: 'An embedded image has no readable intrinsic dimensions.',
                });
                continue;
            }

            const srcRect = xml.match(/<a:srcRect\b([^>]*)\/?\s*>/)?.[1] || '';
            const visibleWidth = metadata.width * (1 - cropFraction(srcRect, 'l') - cropFraction(srcRect, 'r'));
            const visibleHeight = metadata.height * (1 - cropFraction(srcRect, 't') - cropFraction(srcRect, 'b'));
            const frameRatio = widthEmu / heightEmu;
            const effectiveRatio = visibleWidth / visibleHeight;
            const aspectError = Math.abs(frameRatio / effectiveRatio - 1);
            checkedImages += 1;

            if (!Number.isFinite(effectiveRatio) || effectiveRatio <= 0 || aspectError > ASPECT_TOLERANCE) {
                issues.push({
                    severity: 'error',
                    code: 'image_aspect_ratio_mismatch',
                    slide,
                    message: `Embedded image aspect ratio differs from its frame by ${Math.round(aspectError * 100)}%; non-uniform stretching is not allowed.`,
                });
            }

            const ppi = Math.min(
                visibleWidth / (widthEmu / EMU_PER_INCH),
                visibleHeight / (heightEmu / EMU_PER_INCH),
            );
            if (ppi < MIN_IMAGE_PPI) {
                issues.push({
                    severity: ppi < ERROR_IMAGE_PPI ? 'error' : 'warning',
                    code: ppi < ERROR_IMAGE_PPI ? 'embedded_image_resolution_too_low' : 'embedded_image_resolution_low',
                    slide,
                    message: `Embedded image provides about ${Math.round(ppi)} PPI at its displayed size.`,
                });
            }
        }
    }

    return { available: true, checkedImages, issues };
}
