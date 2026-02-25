/**
 * Web Fetch 工具
 * 获取并提取网页内容（HTML → Markdown/Text）
 * 支持 Readability 本地提取，反爬检测时提示使用 browser 工具
 */

import type { Tool, ToolResult } from '../types';
import { readStringParam, readNumberParam, jsonResult, errorResult } from '../common';
import { Logger } from '../../utils/logger';

const log = new Logger('WebFetch');

// ========================
// 常量
// ========================

const DEFAULT_MAX_CHARS = 50_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000; // 15 分钟
const DEFAULT_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

type ExtractMode = 'markdown' | 'text';

// ========================
// 反爬检测特征
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
 * 检测响应是否被反爬机制拦截
 */
function detectAntiBot(status: number, body: string): boolean {
    // 403/404/503 + HTML 含反爬特征
    if (![403, 404, 503].includes(status)) return false;
    const lower = body.toLowerCase();
    return ANTI_BOT_PATTERNS.some(p => lower.includes(p));
}

// ========================
// 缓存
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
// 类型定义
// ========================

export interface WebFetchToolOptions {
    /** 是否启用 Readability（默认 true） */
    readability?: boolean;
    /** 最大字符数上限 */
    maxChars?: number;
    /** 超时时间（秒） */
    timeoutSeconds?: number;
    /** 缓存 TTL（分钟） */
    cacheTtlMinutes?: number;
    /** 自定义 User-Agent */
    userAgent?: string;
}

// ========================
// Readability 提取（延迟加载）
// ========================

let readabilityModule: any = null;
let turndownModule: any = null;

async function loadReadability(): Promise<any> {
    if (!readabilityModule) {
        try {
            readabilityModule = await import('@mozilla/readability');
        } catch {
            log.warn('未安装 @mozilla/readability，Readability 提取不可用');
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
            log.warn('未安装 turndown，HTML → Markdown 转换不可用');
            return null;
        }
    }
    return turndownModule;
}

/**
 * 使用 Readability 提取网页主要内容
 */
async function extractReadableContent(params: {
    html: string;
    url: string;
    extractMode: ExtractMode;
}): Promise<{ text: string; title?: string } | null> {
    const readabilityMod = await loadReadability();
    if (!readabilityMod) return null;

    // 使用 JSDOM 解析
    let jsdomModule: any;
    try {
        jsdomModule = await import('jsdom');
    } catch {
        log.warn('未安装 jsdom，Readability 提取不可用');
        return null;
    }

    const { JSDOM } = jsdomModule;
    const { Readability } = readabilityMod;

    try {
        const dom = new JSDOM(params.html, { url: params.url });
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
                // 移除图片（减少噪声）
                turndown.addRule('removeImages', {
                    filter: 'img',
                    replacement: () => '',
                });
                text = turndown.turndown(article.content);
            } else {
                // 降级：简单去标签
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
        log.warn('Readability 提取失败', { error: err.message });
        return null;
    }
}

/**
 * 简单的 HTML 标签移除
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
 * 简单的 Markdown → 纯文本
 */
function markdownToText(md: string): string {
    return md
        .replace(/!\[.*?\]\(.*?\)/g, '')                // 移除图片
        .replace(/\[([^\]]+)\]\(.*?\)/g, '$1')          // 链接 → 文本
        .replace(/#{1,6}\s+/g, '')                       // 移除标题标记
        .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')        // 移除加粗/斜体
        .replace(/`{1,3}[^`]*`{1,3}/g, (m) =>           // 代码块保留内容
            m.replace(/`/g, ''))
        .replace(/^[-*+]\s+/gm, '• ')                   // 列表项
        .replace(/^\d+\.\s+/gm, '')                      // 有序列表
        .replace(/\n{3,}/g, '\n\n')                      // 压缩空行
        .trim();
}

// ========================
// 核心 fetch 逻辑
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
    // 缓存检查
    const cacheKey = `fetch:${params.url}:${params.extractMode}:${params.maxChars}`;
    const cached = readCache(cacheKey);
    if (cached) return { ...cached, cached: true };

    // URL 校验
    let parsedUrl: URL;
    try {
        parsedUrl = new URL(params.url);
    } catch {
        throw new Error('无效的 URL：必须是 http 或 https');
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new Error('无效的 URL：必须是 http 或 https');
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
        throw new Error(`页面获取失败: ${fetchErr.message}`);
    } finally {
        clearTimeout(timer);
    }

    // HTTP 错误处理
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        // 检测反爬拦截
        if (detectAntiBot(res.status, body)) {
            throw new Error(
                `页面被反爬机制拦截 (HTTP ${res.status})，该网站需要浏览器环境访问。` +
                `\n请使用 browser 工具访问此 URL: ${params.url}`
            );
        }
        throw new Error(`页面获取失败 (HTTP ${res.status}): ${body.slice(0, 300) || res.statusText}`);
    }

    // 解析内容
    const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
    const body = await res.text();
    const finalUrl = res.url || params.url;

    let title: string | undefined;
    let extractor = 'raw';
    let text = body;

    if (contentType.includes('text/html')) {
        // 检测：200 但内容是反爬页面（某些站点返回 200 + JS 挑战）
        if (body.length < 5000 && detectAntiBot(200, body)) {
            throw new Error(
                `页面返回了反爬验证页面，该网站需要浏览器环境访问。` +
                `\n请使用 browser 工具访问此 URL: ${params.url}`
            );
        }

        // HTML → 使用 Readability 提取
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
                // Readability 失败，简单 strip
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

    // 截断
    const truncatedText = truncateText(text, params.maxChars);
    const normalizedContentType = contentType.split(';')[0]?.trim() || 'application/octet-stream';

    // 如果没有提取到 title，从 HTML 中简单提取
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
// 工具工厂
// ========================

export function createWebFetchTool(options?: WebFetchToolOptions): Tool {
    const readabilityEnabled = options?.readability !== false;
    const userAgent = options?.userAgent || DEFAULT_USER_AGENT;
    const maxCharsCap = options?.maxChars ?? DEFAULT_MAX_CHARS;
    const timeoutMs = (options?.timeoutSeconds ?? 30) * 1000;
    const cacheTtlMs = (options?.cacheTtlMinutes ?? 15) * 60 * 1000;

    return {
        name: 'web_fetch',
        description: '获取并提取网页内容（HTML → Markdown/纯文本）。用于读取网页文章、文档等。如果遇到反爬拦截，请改用 browser 工具访问。参数: url(必填), extractMode(可选,markdown/text), maxChars(可选,最大字符数)',
        parameters: {
            url: {
                type: 'string',
                description: '要获取的 HTTP/HTTPS URL',
                required: true,
            },
            extractMode: {
                type: 'string',
                description: '提取模式: markdown(默认,保留格式) 或 text(纯文本)',
                enum: ['markdown', 'text'],
            },
            maxChars: {
                type: 'number',
                description: '最大返回字符数（超出则截断），默认 50000',
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

                log.info('页面获取完成', {
                    url,
                    extractor: result.extractor,
                    length: result.length,
                    tookMs: result.tookMs,
                });

                return jsonResult(result);
            } catch (err: any) {
                log.error('页面获取失败', { error: err.message });
                return errorResult(err.message);
            }
        },
    };
}
