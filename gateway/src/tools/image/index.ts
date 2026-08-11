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
import type { Tool, ToolExecutionContext, ToolResult } from '../types';
import { readStringParam, readNumberParam, errorResult } from '../common';
import { Logger } from '../../utils/logger';

const log = new Logger('ImageGen');

const DEFAULT_TIMEOUT_MS = 240_000;
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com';
const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';
const DEFAULT_OPENAI_MODEL = 'gpt-image-2';
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash-image';
const DEFAULT_SIZE = '1024x1024';
const MAX_N = 4;
const DEFAULT_ROUTER_MAX_RETRIES = 1;
const DEFAULT_ROUTER_RETRY_DELAY_MS = 250;

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
    /**
     * Router retries are deliberately capped at one. A retry is only attempted
     * when the request is known not to have reached the Router, or the Router
     * explicitly marks the failure as safe to retry.
     */
    routerMaxRetries?: number;
    /** Delay before the one controlled Router retry (primarily configurable for tests). */
    routerRetryDelayMs?: number;
    /** Injectable fetch implementation for deterministic transport tests. */
    fetchImpl?: typeof globalThis.fetch;
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
    /** reference images for image-to-image / 多图合成 (base64, no prefix) + mime */
    references?: Array<{ data: string; mimeType: string }>;
}

interface ImageProvider {
    generate(req: ImageGenRequest, signal?: AbortSignal): Promise<GeneratedImage[]>;
}

function imageAbortError(signal?: AbortSignal, fallback = 'Image generation aborted'): Error {
    const reason = signal?.reason;
    const error = new Error(reason instanceof Error && reason.message
        ? reason.message
        : typeof reason === 'string' && reason
            ? reason
            : fallback);
    error.name = 'AbortError';
    return error;
}

function throwIfImageAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw imageAbortError(signal);
}

/** Compose the turn signal with a request-local timeout without losing either cause. */
function createTimedSignal(parent: AbortSignal | undefined, timeoutMs: number): {
    signal: AbortSignal;
    dispose: () => void;
} {
    const controller = new AbortController();
    const onParentAbort = () => controller.abort(parent?.reason ?? imageAbortError(parent));
    if (parent?.aborted) onParentAbort();
    else parent?.addEventListener('abort', onParentAbort, { once: true });

    const timer = setTimeout(() => {
        const timeout = new Error(`Image generation timed out after ${timeoutMs}ms`);
        timeout.name = 'AbortError';
        controller.abort(timeout);
    }, timeoutMs);
    return {
        signal: controller.signal,
        dispose: () => {
            clearTimeout(timer);
            parent?.removeEventListener('abort', onParentAbort);
        },
    };
}

export type ImageGenerationRoute = 'router_proxy' | 'direct';
export type ImageGenerationErrorCode =
    | 'router_unavailable'
    | 'timeout'
    | 'upstream'
    | 'network'
    | 'provider_error'
    | 'invalid_response';

interface ImageGenerationErrorOptions {
    route: ImageGenerationRoute;
    retryable: boolean;
    /** Narrower than retryable: safe for the client to retry without risking duplicate billing. */
    safeToRetry?: boolean;
    status?: number;
    cause?: unknown;
}

/** Transport error that keeps both the stable category and the original low-level cause. */
export class ImageGenerationError extends Error {
    readonly code: ImageGenerationErrorCode;
    readonly route: ImageGenerationRoute;
    readonly retryable: boolean;
    readonly safeToRetry: boolean;
    readonly status?: number;
    readonly cause?: unknown;
    attempts = 1;
    maxAttempts = 1;

    constructor(code: ImageGenerationErrorCode, message: string, options: ImageGenerationErrorOptions) {
        super(message);
        this.name = 'ImageGenerationError';
        this.code = code;
        this.route = options.route;
        this.retryable = options.retryable;
        this.safeToRetry = options.safeToRetry === true;
        this.status = options.status;
        this.cause = options.cause;
    }
}

type ErrorLike = {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    status?: unknown;
    cause?: unknown;
};

function asErrorLike(value: unknown): ErrorLike | undefined {
    return value !== null && typeof value === 'object' ? value as ErrorLike : undefined;
}

function findCauseCode(value: unknown): string | undefined {
    let current = asErrorLike(value);
    const seen = new Set<unknown>();
    for (let depth = 0; current && depth < 5 && !seen.has(current); depth++) {
        seen.add(current);
        if (typeof current.code === 'string' && current.code) return current.code;
        current = asErrorLike(current.cause);
    }
    return undefined;
}

function deepestErrorLike(value: unknown): ErrorLike | undefined {
    let current = asErrorLike(value);
    let deepest = current;
    const seen = new Set<unknown>();
    for (let depth = 0; current && depth < 5 && !seen.has(current); depth++) {
        seen.add(current);
        deepest = current;
        current = asErrorLike(current.cause);
    }
    return deepest;
}

function serializeCause(value: unknown, status?: number): NonNullable<ToolResult['cause']> | undefined {
    const root = deepestErrorLike(value);
    const code = findCauseCode(value);
    const name = typeof root?.name === 'string' ? root.name : undefined;
    const message = typeof root?.message === 'string' ? root.message.slice(0, 1_000) : undefined;
    const rootStatus = typeof root?.status === 'number' ? root.status : undefined;
    if (!name && !message && !code && status === undefined && rootStatus === undefined) return undefined;
    return { name, message, code, status: status ?? rootStatus };
}

function errorMessage(value: unknown): string {
    if (value instanceof Error && value.message) return value.message;
    if (typeof value === 'string') return value;
    return 'Unknown image generation failure';
}

const DEFINITELY_NOT_SENT_CODES = new Set([
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
]);

const TIMEOUT_CODES = new Set([
    'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
]);

function normalizeImageGenerationError(
    value: unknown,
    route: ImageGenerationRoute,
): ImageGenerationError {
    if (value instanceof ImageGenerationError) return value;

    const causeCode = findCauseCode(value)?.toUpperCase();
    const name = asErrorLike(value)?.name;
    const message = errorMessage(value);
    if (name === 'AbortError' || (causeCode && TIMEOUT_CODES.has(causeCode))) {
        return new ImageGenerationError('timeout', message, {
            route,
            // A timeout/reset can happen after the server accepted the billable request.
            retryable: false,
            cause: value,
        });
    }

    if (route === 'router_proxy' && causeCode && DEFINITELY_NOT_SENT_CODES.has(causeCode)) {
        return new ImageGenerationError('router_unavailable', message, {
            route,
            retryable: true,
            safeToRetry: true,
            cause: value,
        });
    }

    if (value instanceof TypeError || causeCode) {
        return new ImageGenerationError('network', message, {
            route,
            // Connection resets and generic fetch failures are delivery-ambiguous.
            retryable: false,
            cause: value,
        });
    }

    return new ImageGenerationError('provider_error', message, {
        route,
        retryable: false,
        cause: value,
    });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    throwIfImageAborted(signal);
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(imageAbortError(signal));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
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

function createOpenAIProvider(
    cfg: ImageGenRuntimeConfig,
    timeoutMs: number,
    fetchImpl: typeof globalThis.fetch,
): ImageProvider {
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
        async generate(req, parentSignal): Promise<GeneratedImage[]> {
            throwIfImageAborted(parentSignal);
            const request = createTimedSignal(parentSignal, timeoutMs);
            try {
                // OpenAI expects WxH or "auto"; ignore aspect-ratio values.
                const openaiSize = req.size && !isAspectRatio(req.size) ? req.size : '';

                if (req.references?.length) {
                    // image-to-image / 多图合成 -> /v1/images/edits (multipart)
                    // 多张参考图用 image[] 字段（gpt-image-1/2 支持多图输入，如换头/合成）
                    const form = new FormData();
                    form.set('model', model);
                    form.set('prompt', req.prompt);
                    if (openaiSize) form.set('size', openaiSize);
                    form.set('n', String(req.n));
                    req.references.forEach((r, i) => {
                        const bin = Buffer.from(r.data, 'base64');
                        form.append(
                            'image[]',
                            new Blob([bin], { type: r.mimeType }),
                            `reference_${i + 1}.${r.mimeType.split('/')[1] || 'png'}`,
                        );
                    });
                    const res = await fetchImpl(`${baseUrl}/v1/images/edits`, {
                        method: 'POST',
                        headers: authHeaders(),
                        body: form,
                        signal: request.signal,
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
                const res = await fetchImpl(`${baseUrl}/v1/images/generations`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...authHeaders() },
                    body: JSON.stringify(genBody),
                    signal: request.signal,
                });
                if (!res.ok) {
                    const detail = await res.text().catch(() => '');
                    throw new Error(`OpenAI image generation error (${res.status}): ${detail || res.statusText}`);
                }
                return parseResponse(await res.json());
            } finally {
                request.dispose();
            }
        },
    };
}

// ========================
// Google Gemini (Nano Banana)
// ========================

function createGeminiProvider(
    cfg: ImageGenRuntimeConfig,
    timeoutMs: number,
    fetchImpl: typeof globalThis.fetch,
): ImageProvider {
    const baseUrl = (cfg.baseUrl || DEFAULT_GEMINI_BASE_URL).replace(/\/$/, '');
    const model = cfg.model || DEFAULT_GEMINI_MODEL;
    const apiKey = cfg.apiKey || '';

    return {
        async generate(req, parentSignal): Promise<GeneratedImage[]> {
            throwIfImageAborted(parentSignal);
            const request = createTimedSignal(parentSignal, timeoutMs);
            try {
                const parts: any[] = [{ text: req.prompt }];
                // 多张参考图全部作为 inline_data 传入（Gemini 原生支持多图合成，最适合换头/风格迁移）
                for (const r of req.references || []) {
                    parts.push({ inline_data: { mime_type: r.mimeType, data: r.data } });
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

                const res = await fetchImpl(url, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(body),
                    signal: request.signal,
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
                request.dispose();
            }
        },
    };
}

// ========================
// Router proxy transport
// ========================

function firstString(...values: unknown[]): string | undefined {
    return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

function firstBoolean(...values: unknown[]): boolean | undefined {
    return values.find((value): value is boolean => typeof value === 'boolean');
}

function classifyRouterHttpError(
    status: number,
    routerCode: string | undefined,
    message: string,
): ImageGenerationErrorCode {
    const signal = `${routerCode || ''} ${message}`.toLowerCase();
    if (status === 408 || status === 504 || /(?:^|[_\s-])time(?:d)?[_\s-]?out(?:$|[_\s-])/.test(signal)) {
        return 'timeout';
    }
    if (
        /router[_\s-]?(?:unavailable|offline|not[_\s-]?(?:connected|ready|bound))/.test(signal)
        || /(?:route|runtime|image[_\s-]?generation)[_\s-]?(?:unavailable|not[_\s-]?configured)/.test(signal)
    ) {
        return 'router_unavailable';
    }
    return 'upstream';
}

async function routerHttpError(response: Response): Promise<ImageGenerationError> {
    const raw = await response.text().catch(() => '');
    let parsed: any;
    try {
        parsed = raw ? JSON.parse(raw) : undefined;
    } catch {
        parsed = undefined;
    }
    const errorObject = parsed?.error && typeof parsed.error === 'object' ? parsed.error : undefined;
    const detailObject = parsed?.detail && typeof parsed.detail === 'object' ? parsed.detail : undefined;
    const routerCode = firstString(
        parsed?.code,
        errorObject?.code,
        detailObject?.code,
        parsed?.error_code,
    );
    const routerMessage = firstString(
        parsed?.message,
        errorObject?.message,
        typeof parsed?.detail === 'string' ? parsed.detail : undefined,
        detailObject?.message,
        raw,
        response.statusText,
    ) || `Router returned HTTP ${response.status}`;
    const category = classifyRouterHttpError(response.status, routerCode, routerMessage);
    const explicitRetryable = firstBoolean(parsed?.retryable, errorObject?.retryable, detailObject?.retryable);
    const safeToRetry = firstBoolean(
        parsed?.safe_to_retry,
        errorObject?.safe_to_retry,
        detailObject?.safe_to_retry,
    ) === true;
    const defaultRetryable = category === 'router_unavailable'
        || (category === 'upstream' && (response.status === 429 || response.status >= 500));
    const cause = new Error(routerMessage) as Error & { code?: string; status?: number };
    cause.name = 'RouterProxyError';
    cause.code = routerCode;
    cause.status = response.status;

    return new ImageGenerationError(category, routerMessage, {
        route: 'router_proxy',
        retryable: explicitRetryable ?? defaultRetryable,
        // HTTP delivery is ambiguous unless the Router makes an explicit guarantee.
        safeToRetry,
        status: response.status,
        cause,
    });
}

interface RouterRetryOptions {
    maxRetries: number;
    delayMs: number;
}

/**
 * Forward generation to the Router's /proxy/image-generation endpoint.
 * The Router holds the team credentials and calls OpenAI/Gemini server-side.
 */
function createRouterProxyProvider(
    cfg: ImageGenRuntimeConfig,
    timeoutMs: number,
    fetchImpl: typeof globalThis.fetch,
    retryOptions: RouterRetryOptions,
): ImageProvider {
    const proxy = cfg.routerProxy!;
    const endpoint = `${proxy.baseUrl.replace(/\/$/, '')}/proxy/image-generation`;

    return {
        async generate(req, parentSignal): Promise<GeneratedImage[]> {
            throwIfImageAborted(parentSignal);
            const maxAttempts = retryOptions.maxRetries + 1;
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                throwIfImageAborted(parentSignal);
                const request = createTimedSignal(parentSignal, timeoutMs);
                const body: Record<string, unknown> = {
                    prompt: req.prompt,
                    size: req.size,
                    n: req.n,
                };
                if (req.references?.length) {
                    body.reference_images = req.references.map((r) => ({
                        data: r.data,
                        mime_type: r.mimeType,
                    }));
                    // 向后兼容：仅支持单图的旧 Router 取第一张
                    body.reference_image = body.reference_images[0];
                }
                try {
                    const res = await fetchImpl(endpoint, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            Authorization: `Bearer ${proxy.apiKey}`,
                            'X-App-ID': proxy.appId,
                            ...(proxy.appUserId ? { 'X-App-User-ID': proxy.appUserId } : {}),
                        },
                        body: JSON.stringify(body),
                        signal: request.signal,
                    });
                    if (!res.ok) throw await routerHttpError(res);

                    const data: any = await res.json();
                    const items: any[] = Array.isArray(data?.images) ? data.images : [];
                    return items
                        .filter((it) => typeof it?.b64 === 'string' && it.b64)
                        .map((it) => ({
                            data: it.b64 as string,
                            mimeType: (it.mime_type as string) || 'image/png',
                        }));
                } catch (value) {
                    if (parentSignal?.aborted) throw imageAbortError(parentSignal);
                    const error = normalizeImageGenerationError(value, 'router_proxy');
                    error.attempts = attempt;
                    error.maxAttempts = maxAttempts;
                    if (!error.retryable || !error.safeToRetry || attempt >= maxAttempts) throw error;
                    log.warn('Router image request failed before confirmed delivery; retrying once', {
                        code: error.code,
                        causeCode: findCauseCode(error.cause),
                        attempt,
                        maxAttempts,
                    });
                    await sleep(retryOptions.delayMs, parentSignal);
                } finally {
                    request.dispose();
                }
            }
            throw new ImageGenerationError('router_unavailable', 'Router image request exhausted', {
                route: 'router_proxy',
                retryable: true,
            });
        },
    };
}

function createProvider(
    cfg: ImageGenRuntimeConfig,
    timeoutMs: number,
    fetchImpl: typeof globalThis.fetch,
    retryOptions: RouterRetryOptions,
): ImageProvider {
    if (cfg.routerProxy) return createRouterProxyProvider(cfg, timeoutMs, fetchImpl, retryOptions);
    if (cfg.provider === 'gemini') return createGeminiProvider(cfg, timeoutMs, fetchImpl);
    return createOpenAIProvider(cfg, timeoutMs, fetchImpl);
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

async function saveImages(
    images: GeneratedImage[],
    outputPath: string,
    signal?: AbortSignal,
): Promise<string[]> {
    throwIfImageAborted(signal);
    await fs.mkdir(outputPath, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const files: string[] = [];
    try {
        for (let i = 0; i < images.length; i++) {
            throwIfImageAborted(signal);
            const img = images[i]!;
            const name = `image_${ts}_${i + 1}.${extFromMime(img.mimeType)}`;
            const abs = join(outputPath, name);
            // Track before the write so a partially written file is also removed.
            files.push(abs);
            await fs.writeFile(abs, Buffer.from(img.data, 'base64'), { signal });
            throwIfImageAborted(signal);
        }
        return files;
    } catch (error) {
        await Promise.all(files.map(file => fs.rm(file, { force: true }).catch(() => undefined)));
        if (signal?.aborted) throw imageAbortError(signal);
        throw error;
    }
}

function imageGenerationFailureResult(
    value: unknown,
    route: ImageGenerationRoute,
    requestedCount: number,
): ToolResult {
    const error = normalizeImageGenerationError(value, route);
    const cause = serializeCause(error.cause ?? error, error.status);
    const batchStopped = requestedCount > 1;
    return {
        success: false,
        error: `Image generation failed [${error.code}]: ${error.message}`,
        code: error.code,
        retryable: error.retryable,
        route: error.route,
        cause,
        data: {
            failure: {
                code: error.code,
                retryable: error.retryable,
                route: error.route,
                attempts: error.attempts,
                maxAttempts: error.maxAttempts,
                // n is forwarded atomically. After a failed batch the client never issues
                // follow-up per-image calls, so remaining images cannot keep accruing cost.
                batch: {
                    requested: requestedCount,
                    stopped: batchStopped,
                    followUpRequests: 0,
                },
                cause,
            },
        },
    };
}

// ========================
// Tool factory
// ========================

export function createImageGenTool(options?: ImageGenToolOptions): Tool {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const requestedRouterRetries = Number.isFinite(options?.routerMaxRetries)
        ? Math.trunc(options!.routerMaxRetries!)
        : DEFAULT_ROUTER_MAX_RETRIES;
    // This cap is intentional: callers cannot accidentally turn a billable image
    // request into an unbounded retry loop.
    const routerMaxRetries = Math.max(0, Math.min(DEFAULT_ROUTER_MAX_RETRIES, requestedRouterRetries));
    const routerRetryDelayMs = Math.max(0, options?.routerRetryDelayMs ?? DEFAULT_ROUTER_RETRY_DELAY_MS);
    const fetchImpl = options?.fetchImpl ?? globalThis.fetch;

    return {
        name: 'generate_image',
        priority: 15,
        available: true,
        description:
            'Generate images from a text prompt (text-to-image), or edit/transform reference images (image-to-image). ' +
            'Supports MULTIPLE reference images via reference_images for compositing tasks such as head-swap, ' +
            'face/object insertion, style transfer, or merging subjects from different pictures. ' +
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
            reference_images: {
                type: 'array',
                items: { type: 'string' },
                description:
                    'Optional. Multiple reference images for compositing (e.g. head-swap, merging a face/object from one image into another, style transfer). ' +
                    'Each entry is a local file path / data URL / raw base64. Order matters: put the BASE image (the one to keep overall composition) first, then the source(s) to take features from. ' +
                    'Combined with reference_image if both are given. Gemini handles multi-image best.',
            },
            output_dir: {
                type: 'string',
                description:
                    'Optional. Directory to save the generated image into. Use the current task directory so the saved path is correct. Absolute path or relative to the base output directory. Defaults to the base output directory. Always reference the returned `files` paths in your reply (do not invent paths).',
            },
        },
        execute: async (args: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> => {
            let failureRoute: ImageGenerationRoute = 'direct';
            let requestedCount = 1;
            const signal = context?.abortSignal || context?.signal;
            let persistedFiles: string[] = [];
            try {
                throwIfImageAborted(signal);
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
                failureRoute = cfg.routerProxy ? 'router_proxy' : 'direct';

                const prompt = readStringParam(args, 'prompt', { required: true, label: 'prompt' });
                const size = readStringParam(args, 'size') || cfg.size || DEFAULT_SIZE;
                const nRaw = readNumberParam(args, 'n', { integer: true }) ?? 1;
                const n = Math.max(1, Math.min(MAX_N, nRaw));
                requestedCount = n;
                const refRaw = readStringParam(args, 'reference_image');
                const outputDirArg = readStringParam(args, 'output_dir');

                const baseOutputPath = options?.getOutputPath?.() || process.cwd();
                // Save into the agent-specified directory when provided, so the reported path matches reality.
                const outputPath = outputDirArg
                    ? (isAbsolute(outputDirArg) ? outputDirArg : join(baseOutputPath, outputDirArg))
                    : baseOutputPath;

                // 收集参考图：reference_image（单张）+ reference_images（多张），去重保序
                const refInputs: string[] = [];
                if (refRaw) refInputs.push(refRaw.trim());
                const refsArg = args['reference_images'];
                if (Array.isArray(refsArg)) {
                    for (const r of refsArg) if (typeof r === 'string' && r.trim()) refInputs.push(r.trim());
                } else if (typeof refsArg === 'string' && refsArg.trim()) {
                    for (const r of refsArg.split(/[\n,]/)) if (r.trim()) refInputs.push(r.trim());
                }
                const uniqueRefs = [...new Set(refInputs)];

                let references: Array<{ data: string; mimeType: string }> | undefined;
                if (uniqueRefs.length) {
                    references = [];
                    for (const r of uniqueRefs) {
                        try {
                            throwIfImageAborted(signal);
                            references.push(await loadReferenceImage(r, outputPath));
                            throwIfImageAborted(signal);
                        } catch (e: any) {
                            if (signal?.aborted) throw imageAbortError(signal);
                            return errorResult(`Failed to load reference image (${r}): ${e?.message || e}`);
                        }
                    }
                }

                const provider = createProvider(cfg, timeoutMs, fetchImpl, {
                    maxRetries: routerMaxRetries,
                    delayMs: routerRetryDelayMs,
                });
                const start = Date.now();
                const images = await provider.generate({ prompt, size, n, references }, signal);
                throwIfImageAborted(signal);

                if (!images.length) {
                    throw new ImageGenerationError('invalid_response', 'The image model returned no image data.', {
                        route: cfg.routerProxy ? 'router_proxy' : 'direct',
                        retryable: false,
                    });
                }

                // The remote provider may ignore cancellation and return late.
                // Recheck the owning turn immediately before any artifact write.
                throwIfImageAborted(signal);
                const files = await saveImages(images, outputPath, signal);
                persistedFiles = files;
                throwIfImageAborted(signal);
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
                        mode: references?.length ? 'image-to-image' : 'text-to-image',
                        referenceCount: references?.length || 0,
                        tookMs: Date.now() - start,
                    },
                    // Return images for frontend/user display only. Do NOT re-feed into the LLM
                    // (these are generated artifacts, not screenshots to analyze).
                    images: images.map((img, i) => ({
                        mimeType: img.mimeType,
                        data: img.data,
                        description: `${references?.length ? 'edited' : 'generated'} image ${i + 1}`,
                    })),
                    imagesForDisplayOnly: true,
                };
            } catch (err: any) {
                if (signal?.aborted) {
                    await Promise.all(persistedFiles.map(file => fs.rm(file, { force: true }).catch(() => undefined)));
                    throw imageAbortError(signal);
                }
                log.error('Image generation failed', { error: err?.message });
                return imageGenerationFailureResult(err, failureRoute, requestedCount);
            }
        },
    };
}
