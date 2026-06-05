/**
 * Web Fetch tool
 * Get and extract web page content (HTML -> Markdown/Text)
 * Supports Readability local extraction, prompts to use browser tool during anti-crawling detection
 */

import type { Tool, ToolResult } from '../types';
import { readStringParam, readNumberParam, jsonResult, errorResult } from '../common';
import { Logger } from '../../utils/logger';

const log = new Logger('WebFetch');

// ========================
// constant
// ========================

const DEFAULT_MAX_CHARS = 50_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

type ExtractMode = 'markdown' | 'text';

// ========================
// Anti-climbing detection features
// ========================

const ANTI_BOT_PATTERNS = [
    'turnstile',
    'cloudflare',
    'cf-browser-verification',
    'challenge-platform',
    'cf_chl_opt',
    'just a moment',
    'checking your browser',
    'enable javascript',
    'captcha',
    'access denied',
    'bot detection',
    'ddos-guard',
    'sucuri',
    'incapsula',
    'distilnetworks',
];

/**
 * Check whether the response is intercepted by the anti-crawling mechanism
 */
function detectAntiBot(status: number, body: string): boolean {
    // 403/404/503 + HTML contains anti-climbing features
    if (![403, 404, 503].includes(status)) return false;
    const lower = body.toLowerCase();
    return ANTI_BOT_PATTERNS.some(p => lower.includes(p));
}

// ========================
// cache
// ========================

interface CacheEntry<T> {
    value: T;
    expiresAt: number;
}

const FETCH_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();

function readCache(key: string): Record<string, unknown> | null {
    const entry = FETCH_CACHE.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        FETCH_CACHE.delete(key);
        return null;
    }
    return entry.value;
}

function writeCache(key: string, value: Record<string, unknown>, ttlMs: number): void {
    FETCH_CACHE.set(key, { value, expiresAt: Date.now() + ttlMs });
    if (FETCH_CACHE.size > 200) {
        const oldest = FETCH_CACHE.keys().next().value;
        if (oldest) FETCH_CACHE.delete(oldest);
    }
}

// ========================
// type definition
// ========================

export interface WebFetchToolOptions {
    /** Whether to enable Readability (default true) */
    readability?: boolean;
    /** Maximum number of characters */
    maxChars?: number;
    /** Timeout (seconds) */
    timeoutSeconds?: number;
    /** Cache TTL (minutes) */
    cacheTtlMinutes?: number;
    /** Custom User-Agent */
    userAgent?: string;
}

// ========================
// Readability extraction (lazy loading)
// ========================

let readabilityModule: any = null;
let turndownModule: any = null;

async function loadReadability(): Promise<any> {
    if (!readabilityModule) {
        try {
            readabilityModule = await import('@mozilla/readability');
        } catch {
            log.warn('@mozilla/readability not installed, Readability extraction unavailable');
            return null;
        }
    }
    return readabilityModule;
}

async function loadTurndown(): Promise<any> {
    if (!turndownModule) {
        try {
            turndownModule = await import('turndown');
        } catch {
            log.warn('turndown not installed, HTML to Markdown conversion unavailable');
            return null;
        }
    }
    return turndownModule;
}

/**
 * Use Readability to extract the main content of web pages
 */
async function extractReadableContent(params: {
    html: string;
    url: string;
    extractMode: ExtractMode;
}): Promise<{ text: string; title?: string } | null> {
    const readabilityMod = await loadReadability();
    if (!readabilityMod) return null;

    // Parse using JSDOM
    let jsdomModule: any;
    try {
        jsdomModule = await import('jsdom');
    } catch {
        log.warn('jsdom not installed, Readability extraction unavailable');
        return null;
    }

    const { JSDOM, VirtualConsole } = jsdomModule;
    const { Readability } = readabilityMod;

    try {
        // Using VirtualConsole to suppress CSS parsing errors for jsdom
        // jsdom does not support modern CSS syntax such as nested @media, and will output a lot of stderr noise.
        const virtualConsole = new VirtualConsole();
        virtualConsole.on('error', () => { /* suppress CSS parse errors */ });

        const dom = new JSDOM(params.html, { url: params.url, virtualConsole });
        const reader = new Readability(dom.window.document);
        const article = reader.parse();

        if (!article || !article.content) return null;

        let text: string;
        if (params.extractMode === 'markdown') {
            const turndownMod = await loadTurndown();
            if (turndownMod) {
                const TurndownService = turndownMod.default || turndownMod;
                const turndown = new TurndownService({
                    headingStyle: 'atx',
                    codeBlockStyle: 'fenced',
                    bulletListMarker: '-',
                });
                // Remove pictures (reduce noise)
                turndown.addRule('removeImages', {
                    filter: 'img',
                    replacement: () => '',
                });
                text = turndown.turndown(article.content);
            } else {
                // Downgrade: simply remove the tag
                text = article.textContent || stripHtml(article.content);
            }
        } else {
            text = article.textContent || stripHtml(article.content);
        }

        return {
            text: text.trim(),
            title: article.title || undefined,
        };
    } catch (err: any) {
        log.warn('Readability extraction failed', { error: err.message });
        return null;
    }
}

/**
 * Simple HTML tag removal
 */
function stripHtml(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Simple Markdown -> plain text
 */
function markdownToText(md: string): string {
    return md
        .replace(/!\[.*?\]\(.*?\)/g, '')                // Remove image
        .replace(/\[([^\]]+)\]\(.*?\)/g, '$1')          // link -> text
        .replace(/#{1,6}\s+/g, '')                       // Remove title tag
        .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')        // Remove bold/italics
        .replace(/`{1,3}[^`]*`{1,3}/g, (m) =>           // Code block reserved content
            m.replace(/`/g, ''))
        .replace(/^[-*+]\s+/gm, '• ')                   // list item
        .replace(/^\d+\.\s+/gm, '')                      // ordered list
        .replace(/\n{3,}/g, '\n\n')                      // Compress empty lines
        .trim();
}

// ========================
// Core fetch logic
// ========================

async function runWebFetch(params: {
    url: string;
    extractMode: ExtractMode;
    maxChars: number;
    timeoutMs: number;
    cacheTtlMs: number;
    userAgent: string;
    readabilityEnabled: boolean;
}): Promise<Record<string, unknown>> {
    // cache check
    const cacheKey = `fetch:${params.url}:${params.extractMode}:${params.maxChars}`;
    const cached = readCache(cacheKey);
    if (cached) return { ...cached, cached: true };

    // URL check
    let parsedUrl: URL;
    try {
        parsedUrl = new URL(params.url);
    } catch {
        throw new Error('Invalid URL: must be http or https');
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new Error('Invalid URL: must be http or https');
    }

    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), params.timeoutMs);

    let res: Response;
    try {
        res = await fetch(params.url, {
            method: 'GET',
            headers: {
                'Accept': '*/*',
                'User-Agent': params.userAgent,
                'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
            },
            redirect: 'follow',
            signal: controller.signal,
        });
    } catch (fetchErr: any) {
        clearTimeout(timer);
        throw new Error(`Page fetch failed: ${fetchErr.message}`);
    } finally {
        clearTimeout(timer);
    }

    // HTTP error handling
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        // Detect anti-crawling interception
        if (detectAntiBot(res.status, body)) {
            throw new Error(
                `Page blocked by anti-bot mechanism (HTTP ${res.status}), this website requires a browser environment.` +
                `\nPlease use the browser tool to access this URL: ${params.url}`
            );
        }
        throw new Error(`Page fetch failed (HTTP ${res.status}): ${body.slice(0, 300) || res.statusText}`);
    }

    // parse content
    const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
    const body = await res.text();
    const finalUrl = res.url || params.url;

    let title: string | undefined;
    let extractor = 'raw';
    let text = body;

    if (contentType.includes('text/html')) {
        // Detection: 200 but the content is an anti-crawling page (some sites return 200 + JS challenge)
        if (body.length < 5000 && detectAntiBot(200, body)) {
            throw new Error(
                `Page returned an anti-bot verification page, this website requires a browser environment.` +
                `\nPlease use the browser tool to access this URL: ${params.url}`
            );
        }

        // HTML -> Extract using Readability
        if (params.readabilityEnabled) {
            const readable = await extractReadableContent({
                html: body,
                url: finalUrl,
                extractMode: params.extractMode,
            });

            if (readable?.text) {
                text = readable.text;
                title = readable.title;
                extractor = 'readability';
            } else {
                // Readability failed, simple strip
                text = stripHtml(body);
                extractor = 'strip';
            }
        } else {
            text = stripHtml(body);
            extractor = 'strip';
        }
    } else if (contentType.includes('application/json')) {
        try {
            text = JSON.stringify(JSON.parse(body), null, 2);
            extractor = 'json';
        } catch {
            extractor = 'raw';
        }
    }

    // truncate
    const truncatedText = truncateText(text, params.maxChars);
    const normalizedContentType = contentType.split(';')[0]?.trim() || 'application/octet-stream';

    // If the title is not extracted, simply extract it from HTML
    if (!title && contentType.includes('text/html')) {
        const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        if (titleMatch) {
            title = titleMatch[1]?.trim().slice(0, 200);
        }
    }

    const payload: Record<string, unknown> = {
        url: params.url,
        finalUrl,
        status: res.status,
        contentType: normalizedContentType,
        title,
        extractMode: params.extractMode,
        extractor,
        truncated: truncatedText.length < text.length,
        length: truncatedText.length,
        fetchedAt: new Date().toISOString(),
        tookMs: Date.now() - start,
        text: truncatedText,
    };

    writeCache(cacheKey, payload, params.cacheTtlMs);
    return payload;
}

function truncateText(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars);
}

// ========================
// tool factory
// ========================

export function createWebFetchTool(options?: WebFetchToolOptions): Tool {
    const readabilityEnabled = options?.readability !== false;
    const userAgent = options?.userAgent || DEFAULT_USER_AGENT;
    const maxCharsCap = options?.maxChars ?? DEFAULT_MAX_CHARS;
    const timeoutMs = (options?.timeoutSeconds ?? 30) * 1000;
    const cacheTtlMs = (options?.cacheTtlMinutes ?? 15) * 60 * 1000;

    return {
        name: 'web_fetch',
        priority: 28,
        description: 'Fetch and extract web page content (HTML → Markdown/plain text). Used for reading web articles, documents, etc. If anti-bot blocking is encountered, use the browser tool instead. Params: url (required), extractMode (optional, markdown/text), maxChars (optional, max character count)',
        parameters: {
            url: {
                type: 'string',
                description: 'The HTTP/HTTPS URL to fetch',
                required: true,
            },
            extractMode: {
                type: 'string',
                description: 'Extraction mode: markdown (default, preserves formatting) or text (plain text)',
                enum: ['markdown', 'text'],
            },
            maxChars: {
                type: 'number',
                description: 'Maximum characters to return (truncated if exceeded), default 50000',
            },
        },
        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
            try {
                const url = readStringParam(args, 'url', { required: true, label: 'url' });
                const extractMode: ExtractMode =
                    readStringParam(args, 'extractMode') === 'text' ? 'text' : 'markdown';
                const maxChars = readNumberParam(args, 'maxChars', { integer: true });

                const effectiveMaxChars = Math.max(
                    100,
                    Math.min(maxChars ?? maxCharsCap, maxCharsCap),
                );

                const result = await runWebFetch({
                    url,
                    extractMode,
                    maxChars: effectiveMaxChars,
                    timeoutMs,
                    cacheTtlMs,
                    userAgent,
                    readabilityEnabled,
                });

                log.info('Page fetch completed', {
                    url,
                    extractor: result.extractor,
                    length: result.length,
                    tookMs: result.tookMs,
                });

                return jsonResult(result);
            } catch (err: any) {
                log.error('Page fetch failed', { error: err.message });
                return errorResult(err.message);
            }
        },
    };
}
