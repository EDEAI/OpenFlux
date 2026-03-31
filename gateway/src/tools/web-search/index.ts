/**
 * Web Search 工具
 * 支持 Brave Search API 和 Perplexity Sonar 两种搜索提供商
 * 参考 OpenClaw web-search.ts 设计
 */

import type { Tool, ToolResult } from '../types';
import { readStringParam, readNumberParam, jsonResult, errorResult } from '../common';
import { Logger } from '../../utils/logger';

const log = new Logger('WebSearch');

// ========================
// 常量
// ========================

const SEARCH_PROVIDERS = ['brave', 'perplexity'] as const;
type SearchProvider = (typeof SEARCH_PROVIDERS)[number];

const DEFAULT_SEARCH_COUNT = 5;
const MAX_SEARCH_COUNT = 10;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000; // 15 分钟

const BRAVE_SEARCH_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const DEFAULT_PERPLEXITY_BASE_URL = 'https://openrouter.ai/api/v1';
const PERPLEXITY_DIRECT_BASE_URL = 'https://api.perplexity.ai';
const DEFAULT_PERPLEXITY_MODEL = 'perplexity/sonar-pro';

/** Brave freshness 快捷值 */
const BRAVE_FRESHNESS_SHORTCUTS = new Set(['pd', 'pw', 'pm', 'py']);
const BRAVE_FRESHNESS_RANGE = /^(\d{4}-\d{2}-\d{2})to(\d{4}-\d{2}-\d{2})$/;

// ========================
// 缓存
// ========================

interface CacheEntry<T> {
    value: T;
    expiresAt: number;
}

const SEARCH_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();

function readCache(key: string): Record<string, unknown> | null {
    const entry = SEARCH_CACHE.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        SEARCH_CACHE.delete(key);
        return null;
    }
    return entry.value;
}

function writeCache(key: string, value: Record<string, unknown>, ttlMs: number): void {
    SEARCH_CACHE.set(key, { value, expiresAt: Date.now() + ttlMs });
    // 简单清理：超过 200 条时删除最旧的
    if (SEARCH_CACHE.size > 200) {
        const oldest = SEARCH_CACHE.keys().next().value;
        if (oldest) SEARCH_CACHE.delete(oldest);
    }
}

// ========================
// 类型定义
// ========================

export interface WebSearchToolOptions {
    /** 搜索提供商 */
    provider?: SearchProvider;
    /** Brave Search API Key */
    apiKey?: string;
    /** 最大结果数 */
    maxResults?: number;
    /** 超时时间（秒） */
    timeoutSeconds?: number;
    /** 缓存 TTL（分钟） */
    cacheTtlMinutes?: number;
    /** Perplexity 配置 */
    perplexity?: {
        apiKey?: string;
        baseUrl?: string;
        model?: string;
    };
    /** Router 下发的请求路由策略 */
    routing?: {
        modules?: Record<string, string>;
        providers?: Record<string, string>;
    };
    /** Router 中转调用所需信息 */
    routerProxy?: {
        baseUrl?: string;
        appId?: string;
        appUserId?: string;
        apiKey?: string;
    };
    /** 运行时动态获取最新配置 */
    getRuntimeOptions?: () => WebSearchToolOptions | undefined;
}

type BraveSearchResult = {
    title?: string;
    url?: string;
    description?: string;
    age?: string;
};

type BraveSearchResponse = {
    web?: {
        results?: BraveSearchResult[];
    };
};

type PerplexitySearchResponse = {
    choices?: Array<{
        message?: {
            content?: string;
        };
    }>;
    citations?: string[];
};

// ========================
// 辅助函数
// ========================

function resolveProvider(options?: WebSearchToolOptions): SearchProvider {
    const raw = options?.provider?.toLowerCase().trim() || '';
    if (raw === 'perplexity') return 'perplexity';
    return 'brave';
}

type SearchRouteMode = 'direct' | 'router_proxy';

function getEffectiveOptions(options?: WebSearchToolOptions): WebSearchToolOptions {
    return options?.getRuntimeOptions?.() || options || {};
}

function resolveRouteMode(provider: SearchProvider, options?: WebSearchToolOptions): SearchRouteMode {
    const routing = options?.routing;
    const moduleMode = routing?.modules?.web_search;
    if (moduleMode === 'router_proxy') return 'router_proxy';
    if (moduleMode === 'direct') return 'direct';

    const providerMode = routing?.providers?.[provider];
    if (providerMode === 'router_proxy') return 'router_proxy';
    return 'direct';
}

function resolveBraveApiKey(options?: WebSearchToolOptions): string | undefined {
    const fromConfig = options?.apiKey?.trim() || '';
    const fromEnv = (process.env.BRAVE_API_KEY ?? '').trim();
    return fromConfig || fromEnv || undefined;
}

function resolvePerplexityApiKey(options?: WebSearchToolOptions): string | undefined {
    const fromConfig = options?.perplexity?.apiKey?.trim() || '';
    const fromEnvPerplexity = (process.env.PERPLEXITY_API_KEY ?? '').trim();
    const fromEnvOpenRouter = (process.env.OPENROUTER_API_KEY ?? '').trim();
    return fromConfig || fromEnvPerplexity || fromEnvOpenRouter || undefined;
}

function resolvePerplexityBaseUrl(options?: WebSearchToolOptions, apiKey?: string): string {
    const fromConfig = options?.perplexity?.baseUrl?.trim() || '';
    if (fromConfig) return fromConfig;

    // 根据 API Key 前缀推断
    if (apiKey) {
        const lower = apiKey.toLowerCase();
        if (lower.startsWith('pplx-')) return PERPLEXITY_DIRECT_BASE_URL;
        if (lower.startsWith('sk-or-')) return DEFAULT_PERPLEXITY_BASE_URL;
    }

    // 检查环境变量来源
    if ((process.env.PERPLEXITY_API_KEY ?? '').trim()) return PERPLEXITY_DIRECT_BASE_URL;
    if ((process.env.OPENROUTER_API_KEY ?? '').trim()) return DEFAULT_PERPLEXITY_BASE_URL;

    return DEFAULT_PERPLEXITY_BASE_URL;
}

function resolvePerplexityModel(options?: WebSearchToolOptions): string {
    return options?.perplexity?.model?.trim() || DEFAULT_PERPLEXITY_MODEL;
}

function resolveTimeoutMs(options?: WebSearchToolOptions): number {
    const seconds = options?.timeoutSeconds;
    if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
        return seconds * 1000;
    }
    return DEFAULT_TIMEOUT_MS;
}

function resolveCacheTtlMs(options?: WebSearchToolOptions): number {
    const minutes = options?.cacheTtlMinutes;
    if (typeof minutes === 'number' && Number.isFinite(minutes) && minutes >= 0) {
        return minutes * 60 * 1000;
    }
    return DEFAULT_CACHE_TTL_MS;
}

function resolveCount(value: unknown, fallback: number): number {
    const parsed = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    return Math.max(1, Math.min(MAX_SEARCH_COUNT, Math.floor(parsed)));
}

function normalizeFreshness(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;

    const lower = trimmed.toLowerCase();
    if (BRAVE_FRESHNESS_SHORTCUTS.has(lower)) return lower;

    const match = trimmed.match(BRAVE_FRESHNESS_RANGE);
    if (!match) return undefined;

    const [, start, end] = match;
    if (!isValidIsoDate(start!) || !isValidIsoDate(end!)) return undefined;
    if (start! > end!) return undefined;

    return `${start}to${end}`;
}

function isValidIsoDate(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(p => parseInt(p, 10));
    const date = new Date(Date.UTC(year!, month! - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day;
}

/** Brave search_lang 合法值映射：修正 LLM 常传的无效简写 */
const BRAVE_SEARCH_LANG_MAP: Record<string, string> = {
    'zh': 'zh-hans',
    'zh-cn': 'zh-hans',
    'zh-tw': 'zh-hant',
    'pt': 'pt-pt',
    'en-us': 'en',
};

function normalizeSearchLang(lang: string | undefined): string | undefined {
    if (!lang) return undefined;
    const lower = lang.trim().toLowerCase();
    if (!lower) return undefined;
    return BRAVE_SEARCH_LANG_MAP[lower] || lower;
}

function getSiteName(url: string | undefined): string | undefined {
    if (!url) return undefined;
    try { return new URL(url).hostname; } catch { return undefined; }
}

// ========================
// 搜索执行
// ========================

async function runBraveSearch(params: {
    query: string;
    count: number;
    apiKey: string;
    timeoutMs: number;
    country?: string;
    searchLang?: string;
    uiLang?: string;
    freshness?: string;
}): Promise<Record<string, unknown>> {
    const url = new URL(BRAVE_SEARCH_ENDPOINT);
    url.searchParams.set('q', params.query);
    url.searchParams.set('count', String(params.count));
    if (params.country) url.searchParams.set('country', params.country);
    if (params.searchLang) url.searchParams.set('search_lang', params.searchLang);
    if (params.uiLang) url.searchParams.set('ui_lang', params.uiLang);
    if (params.freshness) url.searchParams.set('freshness', params.freshness);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), params.timeoutMs);

    try {
        const res = await fetch(url.toString(), {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'X-Subscription-Token': params.apiKey,
            },
            signal: controller.signal,
        });

        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            throw new Error(`Brave Search API error (${res.status}): ${detail || res.statusText}`);
        }

        const data = (await res.json()) as BraveSearchResponse;
        const results = Array.isArray(data.web?.results) ? data.web!.results : [];

        return {
            query: params.query,
            provider: 'brave',
            count: results.length,
            results: results.map(entry => ({
                title: entry.title ?? '',
                url: entry.url ?? '',
                description: entry.description ?? '',
                published: entry.age || undefined,
                siteName: getSiteName(entry.url),
            })),
        };
    } finally {
        clearTimeout(timer);
    }
}

async function runPerplexitySearch(params: {
    query: string;
    apiKey: string;
    baseUrl: string;
    model: string;
    timeoutMs: number;
}): Promise<Record<string, unknown>> {
    const endpoint = `${params.baseUrl.replace(/\/$/, '')}/chat/completions`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), params.timeoutMs);

    try {
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${params.apiKey}`,
                'HTTP-Referer': 'https://OpenFlux.local',
                'X-Title': 'OpenFlux Web Search',
            },
            body: JSON.stringify({
                model: params.model,
                messages: [{ role: 'user', content: params.query }],
            }),
            signal: controller.signal,
        });

        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            throw new Error(`Perplexity API error (${res.status}): ${detail || res.statusText}`);
        }

        const data = (await res.json()) as PerplexitySearchResponse;
        const content = data.choices?.[0]?.message?.content ?? 'No response';
        const citations = data.citations ?? [];

        return {
            query: params.query,
            provider: 'perplexity',
            model: params.model,
            content,
            citations,
        };
    } finally {
        clearTimeout(timer);
    }
}

async function runRouterProxySearch(params: {
    query: string;
    count: number;
    timeoutMs: number;
    proxy?: WebSearchToolOptions['routerProxy'];
    country?: string;
    searchLang?: string;
    uiLang?: string;
    freshness?: string;
}): Promise<Record<string, unknown>> {
    if (!params.proxy?.baseUrl || !params.proxy.appId || !params.proxy.apiKey) {
        throw new Error('Router proxy requires router url, appId and apiKey');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), params.timeoutMs);

    try {
        const res = await fetch(`${params.proxy.baseUrl.replace(/\/$/, '')}/proxy/web-search`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${params.proxy.apiKey}`,
                'X-App-ID': params.proxy.appId,
                ...(params.proxy.appUserId ? { 'X-App-User-ID': params.proxy.appUserId } : {}),
            },
            body: JSON.stringify({
                query: params.query,
                count: params.count,
                country: params.country,
                search_lang: params.searchLang,
                ui_lang: params.uiLang,
                freshness: params.freshness,
            }),
            signal: controller.signal,
        });

        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            throw new Error(`Router proxy error (${res.status}): ${detail || res.statusText}`);
        }

        return await res.json() as Record<string, unknown>;
    } finally {
        clearTimeout(timer);
    }
}

// ========================
// 工具工厂
// ========================

export function createWebSearchTool(options?: WebSearchToolOptions): Tool {
    return {
        name: 'web_search',
        available: true,
        description: 'Search the internet using Brave Search or Perplexity. Supports direct provider access and optional Router proxy mode.',
        parameters: {
            query: {
                type: 'string',
                description: 'Search query string',
                required: true,
            },
            count: {
                type: 'number',
                description: 'Number of results to return (1-10), default 5',
            },
            country: {
                type: 'string',
                description: '2-letter country code, e.g., CN, US, DE, for region-specific search results',
            },
            search_lang: {
                type: 'string',
                description: 'Brave search language code. Use zh-hans (Simplified Chinese), zh-hant (Traditional Chinese), en, ja, ko, de, fr, es, etc.',
            },
            ui_lang: {
                type: 'string',
                description: 'ISO language code for UI element language',
            },
            freshness: {
                type: 'string',
                description: 'Time filter (Brave only): pd (past 24h), pw (past week), pm (past month), py (past year), or date range YYYY-MM-DDtoYYYY-MM-DD',
            },
        },
        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
            try {
                const effectiveOptions = getEffectiveOptions(options);
                const provider = resolveProvider(effectiveOptions);
                const routeMode = resolveRouteMode(provider, effectiveOptions);
                const timeoutMs = resolveTimeoutMs(effectiveOptions);
                const cacheTtlMs = resolveCacheTtlMs(effectiveOptions);
                const defaultCount = effectiveOptions.maxResults ?? DEFAULT_SEARCH_COUNT;
                const query = readStringParam(args, 'query', { required: true, label: 'query' });
                const count = resolveCount(
                    readNumberParam(args, 'count', { integer: true }),
                    defaultCount,
                );
                const country = readStringParam(args, 'country');
                const searchLang = normalizeSearchLang(readStringParam(args, 'search_lang'));
                const uiLang = readStringParam(args, 'ui_lang');
                const rawFreshness = readStringParam(args, 'freshness');

                // freshness 仅 Brave 支持
                if (rawFreshness && provider !== 'brave') {
                    return jsonResult({
                        error: 'unsupported_freshness',
                        message: 'freshness parameter is only supported by Brave Search',
                    });
                }

                const freshness = rawFreshness ? normalizeFreshness(rawFreshness) : undefined;
                if (rawFreshness && !freshness) {
                    return jsonResult({
                        error: 'invalid_freshness',
                        message: 'Invalid freshness format, options: pd, pw, pm, py, or date range YYYY-MM-DDtoYYYY-MM-DD',
                    });
                }

                // 缓存 key
                const cacheKey = `${routeMode}:${provider}:${query}:${count}:${country || '-'}:${searchLang || '-'}:${freshness || '-'}`;
                const cached = readCache(cacheKey);
                if (cached) {
                    log.info('Search cache hit', { query, provider });
                    return jsonResult({ ...cached, cached: true });
                }

                const start = Date.now();
                let result: Record<string, unknown>;

                if (routeMode === 'router_proxy') {
                    result = await runRouterProxySearch({
                        query,
                        count,
                        timeoutMs,
                        proxy: effectiveOptions.routerProxy,
                        country,
                        searchLang,
                        uiLang,
                        freshness,
                    });
                } else if (provider === 'perplexity') {
                    const apiKey = resolvePerplexityApiKey(effectiveOptions);
                    if (!apiKey) {
                        return jsonResult({
                            error: 'missing_api_key',
                            message: 'Perplexity search requires an API Key. Set environment variable PERPLEXITY_API_KEY or OPENROUTER_API_KEY, or configure web.search.perplexity.apiKey in openflux.yaml',
                        });
                    }

                    result = await runPerplexitySearch({
                        query,
                        apiKey,
                        baseUrl: resolvePerplexityBaseUrl(effectiveOptions, apiKey),
                        model: resolvePerplexityModel(effectiveOptions),
                        timeoutMs,
                    });
                } else {
                    const apiKey = resolveBraveApiKey(effectiveOptions);
                    if (!apiKey) {
                        return jsonResult({
                            error: 'missing_api_key',
                            message: 'Brave Search requires an API Key. Set environment variable BRAVE_API_KEY, or configure web.search.apiKey in openflux.yaml',
                        });
                    }

                    result = await runBraveSearch({
                        query,
                        count,
                        apiKey,
                        timeoutMs,
                        country,
                        searchLang,
                        uiLang,
                        freshness,
                    });
                }

                result.tookMs = Date.now() - start;
                result.route = routeMode;
                writeCache(cacheKey, result, cacheTtlMs);
                log.info('Search completed', { query, provider, routeMode, tookMs: result.tookMs });

                return jsonResult(result);
            } catch (err: any) {
                log.error('Search failed', { error: err.message });
                // 返回结构化错误 + 降级建议，帮助 LLM 快速切换策略
                return jsonResult({
                    error: true,
                    message: `Search failed: ${err.message}`,
                    fallbackSuggestion: 'Search API is unavailable, do not repeatedly call web_search. Use web_fetch to directly access target website content, or use the browser tool to browse web pages.',
                    suggestedActions: [
                        'Use web_fetch to directly access relevant websites (e.g., news site homepage)',
                        'Use browser to navigate to the target website',
                        'If you already have enough information, answer the user directly',
                    ],
                });
            }
        },
    };
}
