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
            throw new Error(`Brave Search API 错误 (${res.status}): ${detail || res.statusText}`);
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
            throw new Error(`Perplexity API 错误 (${res.status}): ${detail || res.statusText}`);
        }

        const data = (await res.json()) as PerplexitySearchResponse;
        const content = data.choices?.[0]?.message?.content ?? '无响应';
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

// ========================
// 工具工厂
// ========================

export function createWebSearchTool(options?: WebSearchToolOptions): Tool {
    const provider = resolveProvider(options);
    const timeoutMs = resolveTimeoutMs(options);
    const cacheTtlMs = resolveCacheTtlMs(options);
    const defaultCount = options?.maxResults ?? DEFAULT_SEARCH_COUNT;

    // 检查 API Key 是否可用
    const apiKeyAvailable = provider === 'perplexity'
        ? Boolean(resolvePerplexityApiKey(options))
        : Boolean(resolveBraveApiKey(options));

    if (!apiKeyAvailable) {
        log.warn(`web_search 工具不可用：未配置 ${provider === 'perplexity' ? 'Perplexity' : 'Brave Search'} API Key`);
    }

    const description = provider === 'perplexity'
        ? '使用 Perplexity Sonar 搜索互联网。返回 AI 综合答案和引用来源。参数: query(必填), count(可选,1-10)'
        : '使用 Brave Search API 搜索互联网。返回标题、URL 和摘要。参数: query(必填), count(可选,1-10), country(可选,2位国家码如CN/US), search_lang(可选,语言码如zh/en), freshness(可选,pd/pw/pm/py 或日期范围)';

    return {
        name: 'web_search',
        available: apiKeyAvailable,
        description,
        parameters: {
            query: {
                type: 'string',
                description: '搜索查询字符串',
                required: true,
            },
            count: {
                type: 'number',
                description: '返回结果数量 (1-10)，默认 5',
            },
            country: {
                type: 'string',
                description: '2位国家码，如 CN、US、DE，用于获取特定地区的搜索结果',
            },
            search_lang: {
                type: 'string',
                description: 'ISO 语言码，如 zh、en、de，用于搜索结果语言',
            },
            ui_lang: {
                type: 'string',
                description: 'ISO 语言码，用于 UI 元素语言',
            },
            freshness: {
                type: 'string',
                description: '时间过滤（仅 Brave）: pd(过去24小时), pw(过去一周), pm(过去一月), py(过去一年), 或日期范围 YYYY-MM-DDtoYYYY-MM-DD',
            },
        },
        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
            try {
                const query = readStringParam(args, 'query', { required: true, label: 'query' });
                const count = resolveCount(
                    readNumberParam(args, 'count', { integer: true }),
                    defaultCount,
                );
                const country = readStringParam(args, 'country');
                const searchLang = readStringParam(args, 'search_lang');
                const uiLang = readStringParam(args, 'ui_lang');
                const rawFreshness = readStringParam(args, 'freshness');

                // freshness 仅 Brave 支持
                if (rawFreshness && provider !== 'brave') {
                    return jsonResult({
                        error: 'unsupported_freshness',
                        message: 'freshness 参数仅 Brave Search 支持',
                    });
                }

                const freshness = rawFreshness ? normalizeFreshness(rawFreshness) : undefined;
                if (rawFreshness && !freshness) {
                    return jsonResult({
                        error: 'invalid_freshness',
                        message: 'freshness 格式错误，可选: pd, pw, pm, py, 或日期范围 YYYY-MM-DDtoYYYY-MM-DD',
                    });
                }

                // 缓存 key
                const cacheKey = `${provider}:${query}:${count}:${country || '-'}:${searchLang || '-'}:${freshness || '-'}`;
                const cached = readCache(cacheKey);
                if (cached) {
                    log.info('搜索命中缓存', { query, provider });
                    return jsonResult({ ...cached, cached: true });
                }

                const start = Date.now();
                let result: Record<string, unknown>;

                if (provider === 'perplexity') {
                    const apiKey = resolvePerplexityApiKey(options);
                    if (!apiKey) {
                        return jsonResult({
                            error: 'missing_api_key',
                            message: 'Perplexity 搜索需要 API Key。请设置环境变量 PERPLEXITY_API_KEY 或 OPENROUTER_API_KEY，或在 openflux.yaml 中配置 web.search.perplexity.apiKey',
                        });
                    }

                    result = await runPerplexitySearch({
                        query,
                        apiKey,
                        baseUrl: resolvePerplexityBaseUrl(options, apiKey),
                        model: resolvePerplexityModel(options),
                        timeoutMs,
                    });
                } else {
                    const apiKey = resolveBraveApiKey(options);
                    if (!apiKey) {
                        return jsonResult({
                            error: 'missing_api_key',
                            message: 'Brave Search 需要 API Key。请设置环境变量 BRAVE_API_KEY，或在 openflux.yaml 中配置 web.search.apiKey',
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
                writeCache(cacheKey, result, cacheTtlMs);
                log.info('搜索完成', { query, provider, tookMs: result.tookMs });

                return jsonResult(result);
            } catch (err: any) {
                log.error('搜索失败', { error: err.message });
                // 返回结构化错误 + 降级建议，帮助 LLM 快速切换策略
                return jsonResult({
                    error: true,
                    message: `搜索失败: ${err.message}`,
                    fallbackSuggestion: '搜索 API 不可用，请勿重复调用 web_search。请改用 web_fetch 直接获取目标网站内容，或使用 browser 工具访问网页。',
                    suggestedActions: [
                        '使用 web_fetch 直接访问相关网站（如新闻站首页）',
                        '使用 browser 导航到目标网站',
                        '如果已有足够信息，直接回答用户',
                    ],
                });
            }
        },
    };
}
