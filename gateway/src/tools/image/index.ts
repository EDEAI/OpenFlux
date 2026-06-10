/**
 * Image generation tool (generate_image)
 *
 * Supports text-to-image and image-to-image (via reference_image).
 * Backend is resolved at runtime from the current LLM source (work mode):
 *   - local        -> server-config.json.imageGeneration (user-set provider/model/key)
 *   - managed      -> Router-issued image profile (phase 2)
 *   - atlas_managed -> NexusAI/Atlas image ability (phase 3)
 *
 * Phase 1 implements two providers: OpenAI Images API (gpt-image-2) and
 * Google Gemini "Nano Banana" (gemini-2.5-flash-image).
 *
 * Provider / model / base URL / size are fixed options chosen in settings
 * (not free text). OpenAI sizes are WxH (e.g. 1024x1024); Gemini sizes are
 * aspect ratios (e.g. 1:1, 16:9) mapped into the image config.
 */

import { promises as fs } from 'fs';
import { join, isAbsolute, extname } from 'path';
import type { Tool, ToolResult } from '../types';
import { readStringParam, readNumberParam, errorResult } from '../common';
import { Logger } from '../../utils/logger';

const log = new Logger('ImageGen');

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com';
const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';
const DEFAULT_OPENAI_MODEL = 'gpt-image-2';
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash-image';
const DEFAULT_SIZE = '1024x1024';
const MAX_N = 4;

/** OpenAI accepts WxH or "auto"; pass through only meaningful values. */
function isAspectRatio(size: string): boolean {
    return /^\d+\s*:\s*\d+$/.test(size);
}

// ========================
// Types
// ========================

export type ImageProviderId = 'openai' | 'gemini';

/** Resolved image-model config for the current source */
export interface ImageGenRuntimeConfig {
    provider: ImageProviderId;
    model?: string;
    apiKey?: string;
    baseUrl?: string;
    size?: string;
    /** Source label, only for error/diagnostic messages */
    source?: 'local' | 'managed' | 'atlas_managed';
    /** Extra fetch headers (used by atlas/managed transports) */
    headers?: Record<string, string>;
    /**
     * When set, generation is forwarded through the Router proxy endpoint
     * (POST {baseUrl}/proxy/image-generation); the provider key stays on the Router.
     */
    routerProxy?: {
        baseUrl: string;
        appId: string;
        appUserId?: string;
        apiKey: string;
    };
}

export interface ImageGenToolOptions {
    /** Resolve the image config for the current work mode/source at call time */
    getRuntimeConfig?: () => ImageGenRuntimeConfig | undefined;
    /** Output directory where generated images are written */
    getOutputPath?: () => string;
    /** Timeout in milliseconds */
    timeoutMs?: number;
}

interface GeneratedImage {
    /** base64 (no data: prefix) */
    data: string;
    mimeType: string;
}

interface ImageGenRequest {
    prompt: string;
    size: string;
    n: number;
    /** reference image for image-to-image (base64, no prefix) + mime */
    reference?: { data: string; mimeType: string };
}

interface ImageProvider {
    generate(req: ImageGenRequest): Promise<GeneratedImage[]>;
}

// ========================
// Reference-image loading
// ========================

const DATA_URL_RE = /^data:(?<mime>[^;,]+)?(?:;base64)?,(?<body>.+)$/s;

function guessMimeFromExt(path: string): string {
    const ext = extname(path).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.webp') return 'image/webp';
    if (ext === '.gif') return 'image/gif';
    return 'image/png';
}

/** Resolve a reference image (path | data-url | raw base64) into base64 + mime */
async function loadReferenceImage(
    ref: string,
    outputPath: string,
): Promise<{ data: string; mimeType: string }> {
    const trimmed = ref.trim();

    // data URL
    const m = DATA_URL_RE.exec(trimmed);
    if (m?.groups?.body) {
        return { data: m.groups.body, mimeType: m.groups.mime || 'image/png' };
    }

    // Heuristic: contains a path separator or has an image extension -> treat as file
    const looksLikePath = /[\\/]/.test(trimmed) || /\.(png|jpe?g|webp|gif)$/i.test(trimmed);
    if (looksLikePath) {
        const abs = isAbsolute(trimmed) ? trimmed : join(outputPath, trimmed);
        const buf = await fs.readFile(abs);
        return { data: buf.toString('base64'), mimeType: guessMimeFromExt(abs) };
    }

    // Fallback: assume raw base64 (png)
    return { data: trimmed, mimeType: 'image/png' };
}

// ========================
// OpenAI Images API
// ========================

function createOpenAIProvider(cfg: ImageGenRuntimeConfig, timeoutMs: number): ImageProvider {
    const baseUrl = (cfg.baseUrl || DEFAULT_OPENAI_BASE_URL).replace(/\/$/, '');
    const model = cfg.model || DEFAULT_OPENAI_MODEL;
    const apiKey = cfg.apiKey || '';

    const authHeaders = (): Record<string, string> => ({
        Authorization: `Bearer ${apiKey}`,
        ...(cfg.headers || {}),
    });

    const parseResponse = (data: any): GeneratedImage[] => {
        const items: any[] = Array.isArray(data?.data) ? data.data : [];
        return items
            .map((it) => {
                if (typeof it?.b64_json === 'string') {
                    return { data: it.b64_json, mimeType: 'image/png' };
                }
                return null;
            })
            .filter(Boolean) as GeneratedImage[];
    };

    return {
        async generate(req): Promise<GeneratedImage[]> {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                // OpenAI expects WxH or "auto"; ignore aspect-ratio values.
                const openaiSize = req.size && !isAspectRatio(req.size) ? req.size : '';

                if (req.reference) {
                    // image-to-image -> /v1/images/edits (multipart)
                    const form = new FormData();
                    form.set('model', model);
                    form.set('prompt', req.prompt);
                    if (openaiSize) form.set('size', openaiSize);
                    form.set('n', String(req.n));
                    const bin = Buffer.from(req.reference.data, 'base64');
                    form.set(
                        'image',
                        new Blob([bin], { type: req.reference.mimeType }),
                        `reference.${req.reference.mimeType.split('/')[1] || 'png'}`,
                    );
                    const res = await fetch(`${baseUrl}/v1/images/edits`, {
                        method: 'POST',
                        headers: authHeaders(),
                        body: form,
                        signal: controller.signal,
                    });
                    if (!res.ok) {
                        const detail = await res.text().catch(() => '');
                        throw new Error(`OpenAI image edit error (${res.status}): ${detail || res.statusText}`);
                    }
                    return parseResponse(await res.json());
                }

                // text-to-image -> /v1/images/generations
                const genBody: Record<string, unknown> = { model, prompt: req.prompt, n: req.n };
                if (openaiSize) genBody.size = openaiSize;
                const res = await fetch(`${baseUrl}/v1/images/generations`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...authHeaders() },
                    body: JSON.stringify(genBody),
                    signal: controller.signal,
                });
                if (!res.ok) {
                    const detail = await res.text().catch(() => '');
                    throw new Error(`OpenAI image generation error (${res.status}): ${detail || res.statusText}`);
                }
                return parseResponse(await res.json());
            } finally {
                clearTimeout(timer);
            }
        },
    };
}

// ========================
// Google Gemini (Nano Banana)
// ========================

function createGeminiProvider(cfg: ImageGenRuntimeConfig, timeoutMs: number): ImageProvider {
    const baseUrl = (cfg.baseUrl || DEFAULT_GEMINI_BASE_URL).replace(/\/$/, '');
    const model = cfg.model || DEFAULT_GEMINI_MODEL;
    const apiKey = cfg.apiKey || '';

    return {
        async generate(req): Promise<GeneratedImage[]> {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const parts: any[] = [{ text: req.prompt }];
                if (req.reference) {
                    parts.push({
                        inline_data: { mime_type: req.reference.mimeType, data: req.reference.data },
                    });
                }

                // Image generation requires IMAGE in responseModalities; otherwise the model
                // only returns text. Aspect ratio (when chosen) goes into imageConfig.
                const generationConfig: Record<string, unknown> = {
                    responseModalities: ['TEXT', 'IMAGE'],
                };
                if (req.size && isAspectRatio(req.size)) {
                    generationConfig.imageConfig = { aspectRatio: req.size.replace(/\s+/g, '') };
                }
                const body: Record<string, unknown> = {
                    contents: [{ role: 'user', parts }],
                    generationConfig,
                };

                // API key via x-goog-api-key header; atlas/managed transports may override headers.
                const headers: Record<string, string> = {
                    'Content-Type': 'application/json',
                    ...(apiKey ? { 'x-goog-api-key': apiKey } : {}),
                    ...(cfg.headers || {}),
                };
                // The Gemini Developer API serves image models on the v1beta channel.
                const url = `${baseUrl}/v1beta/models/${model}:generateContent`;

                const res = await fetch(url, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(body),
                    signal: controller.signal,
                });
                if (!res.ok) {
                    const detail = await res.text().catch(() => '');
                    throw new Error(`Gemini image generation error (${res.status}): ${detail || res.statusText}`);
                }

                const data: any = await res.json();
                const out: GeneratedImage[] = [];
                const candidates: any[] = Array.isArray(data?.candidates) ? data.candidates : [];
                for (const cand of candidates) {
                    const candParts: any[] = cand?.content?.parts || [];
                    for (const p of candParts) {
                        const inline = p?.inlineData || p?.inline_data;
                        if (inline?.data) {
                            out.push({ data: inline.data, mimeType: inline.mimeType || inline.mime_type || 'image/png' });
                        }
                    }
                }
                return out;
            } finally {
                clearTimeout(timer);
            }
        },
    };
}

// ========================
// Router proxy transport
// ========================

/**
 * Forward generation to the Router's /proxy/image-generation endpoint.
 * The Router holds the team credentials and calls OpenAI/Gemini server-side.
 */
function createRouterProxyProvider(cfg: ImageGenRuntimeConfig, timeoutMs: number): ImageProvider {
    const proxy = cfg.routerProxy!;
    const endpoint = `${proxy.baseUrl.replace(/\/$/, '')}/proxy/image-generation`;

    return {
        async generate(req): Promise<GeneratedImage[]> {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const body: Record<string, unknown> = {
                    prompt: req.prompt,
                    size: req.size,
                    n: req.n,
                };
                if (req.reference) {
                    body.reference_image = {
                        data: req.reference.data,
                        mime_type: req.reference.mimeType,
                    };
                }
                const res = await fetch(endpoint, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${proxy.apiKey}`,
                        'X-App-ID': proxy.appId,
                        ...(proxy.appUserId ? { 'X-App-User-ID': proxy.appUserId } : {}),
                    },
                    body: JSON.stringify(body),
                    signal: controller.signal,
                });
                if (!res.ok) {
                    const detail = await res.text().catch(() => '');
                    throw new Error(`Router image proxy error (${res.status}): ${detail || res.statusText}`);
                }
                const data: any = await res.json();
                const items: any[] = Array.isArray(data?.images) ? data.images : [];
                return items
                    .filter((it) => typeof it?.b64 === 'string' && it.b64)
                    .map((it) => ({
                        data: it.b64 as string,
                        mimeType: (it.mime_type as string) || 'image/png',
                    }));
            } finally {
                clearTimeout(timer);
            }
        },
    };
}

function createProvider(cfg: ImageGenRuntimeConfig, timeoutMs: number): ImageProvider {
    if (cfg.routerProxy) return createRouterProxyProvider(cfg, timeoutMs);
    if (cfg.provider === 'gemini') return createGeminiProvider(cfg, timeoutMs);
    return createOpenAIProvider(cfg, timeoutMs);
}

// ========================
// Output helpers
// ========================

function extFromMime(mime: string): string {
    if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
    if (mime.includes('webp')) return 'webp';
    if (mime.includes('gif')) return 'gif';
    return 'png';
}

async function saveImages(images: GeneratedImage[], outputPath: string): Promise<string[]> {
    await fs.mkdir(outputPath, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const files: string[] = [];
    for (let i = 0; i < images.length; i++) {
        const img = images[i]!;
        const name = `image_${ts}_${i + 1}.${extFromMime(img.mimeType)}`;
        const abs = join(outputPath, name);
        await fs.writeFile(abs, Buffer.from(img.data, 'base64'));
        files.push(abs);
    }
    return files;
}

// ========================
// Tool factory
// ========================

export function createImageGenTool(options?: ImageGenToolOptions): Tool {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return {
        name: 'generate_image',
        priority: 15,
        available: true,
        description:
            'Generate images from a text prompt (text-to-image), or edit/transform a reference image (image-to-image). ' +
            'Use for posters, illustrations, icons, covers, logos and creative image tasks. ' +
            'The image model backend follows the current work mode and is configured by the user/enterprise.',
        parameters: {
            prompt: {
                type: 'string',
                description: 'Text description of the image to generate (or how to edit the reference image).',
                required: true,
            },
            size: {
                type: 'string',
                description: 'Image size, e.g. 1024x1024, 1024x1536, 1536x1024. Default 1024x1024.',
            },
            n: {
                type: 'number',
                description: 'Number of images to generate (1-4). Default 1.',
            },
            reference_image: {
                type: 'string',
                description:
                    'Optional. For image-to-image/editing: a local file path (relative to the output directory or absolute), a data URL, or raw base64 of the source image.',
            },
            output_dir: {
                type: 'string',
                description:
                    'Optional. Directory to save the generated image into. Use the current task directory so the saved path is correct. Absolute path or relative to the base output directory. Defaults to the base output directory. Always reference the returned `files` paths in your reply (do not invent paths).',
            },
        },
        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
            try {
                const cfg = options?.getRuntimeConfig?.();
                if (!cfg) {
                    return errorResult(
                        'No image generation model is configured. In standalone mode, set it in Settings → Models → Image; in team/managed mode it is provided by the platform.',
                    );
                }
                // router_proxy mode carries no client-side provider key (the Router holds it)
                if (!cfg.routerProxy && !cfg.apiKey && !cfg.headers?.Authorization) {
                    return errorResult(
                        `Image model (${cfg.provider}) is missing an API key. ` +
                        (cfg.source === 'local'
                            ? 'Configure it in Settings → Models → Image.'
                            : 'The platform did not provide image credentials for the current mode.'),
                    );
                }

                const prompt = readStringParam(args, 'prompt', { required: true, label: 'prompt' });
                const size = readStringParam(args, 'size') || cfg.size || DEFAULT_SIZE;
                const nRaw = readNumberParam(args, 'n', { integer: true }) ?? 1;
                const n = Math.max(1, Math.min(MAX_N, nRaw));
                const refRaw = readStringParam(args, 'reference_image');
                const outputDirArg = readStringParam(args, 'output_dir');

                const baseOutputPath = options?.getOutputPath?.() || process.cwd();
                // Save into the agent-specified directory when provided, so the reported path matches reality.
                const outputPath = outputDirArg
                    ? (isAbsolute(outputDirArg) ? outputDirArg : join(baseOutputPath, outputDirArg))
                    : baseOutputPath;

                let reference: { data: string; mimeType: string } | undefined;
                if (refRaw) {
                    try {
                        reference = await loadReferenceImage(refRaw, outputPath);
                    } catch (e: any) {
                        return errorResult(`Failed to load reference_image: ${e?.message || e}`);
                    }
                }

                const provider = createProvider(cfg, timeoutMs);
                const start = Date.now();
                const images = await provider.generate({ prompt, size, n, reference });

                if (!images.length) {
                    return errorResult('The image model returned no image data.');
                }

                const files = await saveImages(images, outputPath);
                log.info('Image generation completed', {
                    provider: cfg.provider,
                    model: cfg.model,
                    route: cfg.routerProxy ? 'router_proxy' : 'direct',
                    count: images.length,
                    tookMs: Date.now() - start,
                });

                return {
                    success: true,
                    data: {
                        provider: cfg.provider,
                        model: cfg.model || (cfg.provider === 'gemini' ? DEFAULT_GEMINI_MODEL : DEFAULT_OPENAI_MODEL),
                        source: cfg.source,
                        route: cfg.routerProxy ? 'router_proxy' : 'direct',
                        count: images.length,
                        files,
                        mode: reference ? 'image-to-image' : 'text-to-image',
                        tookMs: Date.now() - start,
                    },
                    // Return images for frontend/user display only. Do NOT re-feed into the LLM
                    // (these are generated artifacts, not screenshots to analyze).
                    images: images.map((img, i) => ({
                        mimeType: img.mimeType,
                        data: img.data,
                        description: `${reference ? 'edited' : 'generated'} image ${i + 1}`,
                    })),
                    imagesForDisplayOnly: true,
                };
            } catch (err: any) {
                log.error('Image generation failed', { error: err?.message });
                return errorResult(`Image generation failed: ${err?.message || err}`);
            }
        },
    };
}
