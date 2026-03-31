/**
 * 浏览器 Session 管理
 * 迁移自 OpenClaw pw-session.ts
 * 
 * 管理 CDP 连接、Page 状态追踪、Role Refs 缓存
 */

import type {
    Browser,
    BrowserContext,
    ConsoleMessage,
    Page,
    Request,
    Response,
} from 'playwright-core';

// 懒加载 playwright-core（避免启动时就占用 ~80MB 内存）
let _chromium: typeof import('playwright-core').chromium | null = null;
async function getChromium() {
    if (!_chromium) {
        const pw = await import('playwright-core');
        _chromium = pw.chromium;
    }
    return _chromium;
}

import type {
    BrowserConsoleMessage,
    BrowserPageError,
    BrowserNetworkRequest,
    ConnectedBrowser,
    PageState,
    ContextState,
    RoleRefs,
    RoleRefsCacheEntry,
    TargetInfoResponse,
    WithSnapshotForAI,
} from './types.js';
import {
    MAX_CONSOLE_MESSAGES,
    MAX_PAGE_ERRORS,
    MAX_NETWORK_REQUESTS,
    MAX_ROLE_REFS_CACHE,
} from './types.js';
import { formatErrorMessage } from './shared.js';

// ============ 状态存储 ============

const pageStates = new WeakMap<Page, PageState>();
const contextStates = new WeakMap<BrowserContext, ContextState>();
const observedContexts = new WeakSet<BrowserContext>();
const observedPages = new WeakSet<Page>();

// Role refs 缓存（跨请求保持稳定）
const roleRefsByTarget = new Map<string, RoleRefsCacheEntry>();

// 连接缓存
let cached: ConnectedBrowser | null = null;
let connecting: Promise<ConnectedBrowser> | null = null;

// ============ 辅助函数 ============

function normalizeCdpUrl(raw: string): string {
    return raw.replace(/\/$/, '');
}

function roleRefsKey(cdpUrl: string, targetId: string): string {
    return `${normalizeCdpUrl(cdpUrl)}::${targetId}`;
}

// ============ Role Refs 管理 ============

/**
 * 记住 target 的 role refs（用于跨请求恢复）
 */
export function rememberRoleRefsForTarget(opts: {
    cdpUrl: string;
    targetId: string;
    refs: RoleRefs;
    frameSelector?: string;
    mode?: NonNullable<PageState['roleRefsMode']>;
}): void {
    const targetId = opts.targetId.trim();
    if (!targetId) {
        return;
    }
    roleRefsByTarget.set(roleRefsKey(opts.cdpUrl, targetId), {
        refs: opts.refs,
        ...(opts.frameSelector ? { frameSelector: opts.frameSelector } : {}),
        ...(opts.mode ? { mode: opts.mode } : {}),
    });
    // 限制缓存大小
    while (roleRefsByTarget.size > MAX_ROLE_REFS_CACHE) {
        const first = roleRefsByTarget.keys().next();
        if (first.done) {
            break;
        }
        roleRefsByTarget.delete(first.value);
    }
}

/**
 * 存储 role refs 到页面状态
 */
export function storeRoleRefsForTarget(opts: {
    page: Page;
    cdpUrl: string;
    targetId?: string;
    refs: RoleRefs;
    frameSelector?: string;
    mode: NonNullable<PageState['roleRefsMode']>;
}): void {
    const state = ensurePageState(opts.page);
    state.roleRefs = opts.refs;
    state.roleRefsFrameSelector = opts.frameSelector;
    state.roleRefsMode = opts.mode;
    if (!opts.targetId?.trim()) {
        return;
    }
    rememberRoleRefsForTarget({
        cdpUrl: opts.cdpUrl,
        targetId: opts.targetId,
        refs: opts.refs,
        frameSelector: opts.frameSelector,
        mode: opts.mode,
    });
}

/**
 * 从缓存恢复 role refs
 */
export function restoreRoleRefsForTarget(opts: {
    cdpUrl: string;
    targetId?: string;
    page: Page;
}): void {
    const targetId = opts.targetId?.trim() || '';
    if (!targetId) {
        return;
    }
    const cachedRefs = roleRefsByTarget.get(roleRefsKey(opts.cdpUrl, targetId));
    if (!cachedRefs) {
        return;
    }
    const state = ensurePageState(opts.page);
    if (state.roleRefs) {
        return; // 已有 refs，不覆盖
    }
    state.roleRefs = cachedRefs.refs;
    state.roleRefsFrameSelector = cachedRefs.frameSelector;
    state.roleRefsMode = cachedRefs.mode;
}

// ============ Page 状态管理 ============

/**
 * 确保页面有状态对象，并设置事件监听
 */
export function ensurePageState(page: Page): PageState {
    const existing = pageStates.get(page);
    if (existing) {
        return existing;
    }

    const state: PageState = {
        console: [],
        errors: [],
        requests: [],
        requestIds: new WeakMap(),
        nextRequestId: 0,
        armIdUpload: 0,
        armIdDialog: 0,
        armIdDownload: 0,
    };
    pageStates.set(page, state);

    if (!observedPages.has(page)) {
        observedPages.add(page);

        // 监听控制台消息
        page.on('console', (msg: ConsoleMessage) => {
            const entry: BrowserConsoleMessage = {
                type: msg.type(),
                text: msg.text(),
                timestamp: new Date().toISOString(),
                location: msg.location(),
            };
            state.console.push(entry);
            if (state.console.length > MAX_CONSOLE_MESSAGES) {
                state.console.shift();
            }
        });

        // 监听页面错误
        page.on('pageerror', (err: Error) => {
            state.errors.push({
                message: err?.message ? String(err.message) : String(err),
                name: err?.name ? String(err.name) : undefined,
                stack: err?.stack ? String(err.stack) : undefined,
                timestamp: new Date().toISOString(),
            });
            if (state.errors.length > MAX_PAGE_ERRORS) {
                state.errors.shift();
            }
        });

        // 监听网络请求
        page.on('request', (req: Request) => {
            state.nextRequestId += 1;
            const id = `r${state.nextRequestId}`;
            state.requestIds.set(req, id);
            state.requests.push({
                id,
                timestamp: new Date().toISOString(),
                method: req.method(),
                url: req.url(),
                resourceType: req.resourceType(),
            });
            if (state.requests.length > MAX_NETWORK_REQUESTS) {
                state.requests.shift();
            }
        });

        // 监听响应
        page.on('response', (resp: Response) => {
            const req = resp.request();
            const id = state.requestIds.get(req);
            if (!id) {
                return;
            }
            let rec: BrowserNetworkRequest | undefined;
            for (let i = state.requests.length - 1; i >= 0; i -= 1) {
                const candidate = state.requests[i];
                if (candidate && candidate.id === id) {
                    rec = candidate;
                    break;
                }
            }
            if (!rec) {
                return;
            }
            rec.status = resp.status();
            rec.ok = resp.ok();
        });

        // 监听请求失败
        page.on('requestfailed', (req: Request) => {
            const id = state.requestIds.get(req);
            if (!id) {
                return;
            }
            let rec: BrowserNetworkRequest | undefined;
            for (let i = state.requests.length - 1; i >= 0; i -= 1) {
                const candidate = state.requests[i];
                if (candidate && candidate.id === id) {
                    rec = candidate;
                    break;
                }
            }
            if (!rec) {
                return;
            }
            rec.failureText = req.failure()?.errorText;
            rec.ok = false;
        });

        // 页面关闭时清理
        page.on('close', () => {
            pageStates.delete(page);
            observedPages.delete(page);
        });
    }

    return state;
}

// ============ Context 状态管理 ============

function observeContext(context: BrowserContext): void {
    if (observedContexts.has(context)) {
        return;
    }
    observedContexts.add(context);
    ensureContextState(context);

    for (const page of context.pages()) {
        ensurePageState(page);
    }
    context.on('page', (page) => ensurePageState(page));
}

export function ensureContextState(context: BrowserContext): ContextState {
    const existing = contextStates.get(context);
    if (existing) {
        return existing;
    }
    const state: ContextState = { traceActive: false };
    contextStates.set(context, state);
    return state;
}

function observeBrowser(browser: Browser): void {
    for (const context of browser.contexts()) {
        observeContext(context);
    }
}

// ============ 浏览器连接 ============

/**
 * 连接到 CDP 端点
 */
async function connectBrowser(cdpUrl: string): Promise<ConnectedBrowser> {
    const normalized = normalizeCdpUrl(cdpUrl);
    if (cached?.cdpUrl === normalized) {
        return cached;
    }
    if (connecting) {
        return await connecting;
    }

    const connectWithRetry = async (): Promise<ConnectedBrowser> => {
        let lastErr: unknown;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                const timeout = 5000 + attempt * 2000;
                // 尝试获取 WebSocket URL
                const wsUrl = await getChromeWebSocketUrl(normalized, timeout).catch(() => null);
                const endpoint = wsUrl ?? normalized;
                const browser = await (await getChromium()).connectOverCDP(endpoint, { timeout });
                const connected: ConnectedBrowser = { browser, cdpUrl: normalized };
                cached = connected;
                observeBrowser(browser);
                browser.on('disconnected', () => {
                    if (cached?.browser === browser) {
                        cached = null;
                    }
                });
                return connected;
            } catch (err) {
                lastErr = err;
                const delay = 250 + attempt * 250;
                await new Promise((r) => setTimeout(r, delay));
            }
        }
        if (lastErr instanceof Error) {
            throw lastErr;
        }
        const message = lastErr ? formatErrorMessage(lastErr) : 'CDP connect failed';
        throw new Error(message);
    };

    connecting = connectWithRetry().finally(() => {
        connecting = null;
    });

    return await connecting;
}

/**
 * 获取 Chrome WebSocket URL
 */
async function getChromeWebSocketUrl(cdpUrl: string, timeout: number): Promise<string | null> {
    try {
        const baseUrl = cdpUrl.replace(/^ws:/, 'http:').replace(/\/cdp$/, '');
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        const response = await fetch(`${baseUrl}/json/version`, {
            signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (!response.ok) {
            return null;
        }
        const data = await response.json() as { webSocketDebuggerUrl?: string };
        return data.webSocketDebuggerUrl || null;
    } catch {
        return null;
    }
}

// ============ Page 查找 ============

async function getAllPages(browser: Browser): Promise<Page[]> {
    const contexts = browser.contexts();
    const pages = contexts.flatMap((c) => c.pages());
    return pages;
}

async function pageTargetId(page: Page): Promise<string | null> {
    const session = await page.context().newCDPSession(page);
    try {
        const info = (await session.send('Target.getTargetInfo')) as TargetInfoResponse;
        const targetId = String(info?.targetInfo?.targetId ?? '').trim();
        return targetId || null;
    } finally {
        await session.detach().catch(() => { });
    }
}

async function findPageByTargetId(
    browser: Browser,
    targetId: string,
    cdpUrl?: string,
): Promise<Page | null> {
    const pages = await getAllPages(browser);

    // 首先尝试标准 CDP session 方式
    for (const page of pages) {
        const tid = await pageTargetId(page).catch(() => null);
        if (tid && tid === targetId) {
            return page;
        }
    }

    // 回退：使用 /json/list 端点进行 URL 匹配
    if (cdpUrl) {
        try {
            const baseUrl = cdpUrl
                .replace(/\/+$/, '')
                .replace(/^ws:/, 'http:')
                .replace(/\/cdp$/, '');
            const listUrl = `${baseUrl}/json/list`;
            const response = await fetch(listUrl);
            if (response.ok) {
                const targets = (await response.json()) as Array<{
                    id: string;
                    url: string;
                    title?: string;
                }>;
                const target = targets.find((t) => t.id === targetId);
                if (target) {
                    // 尝试 URL 匹配
                    const urlMatch = pages.filter((p) => p.url() === target.url);
                    if (urlMatch.length === 1) {
                        return urlMatch[0];
                    }
                    // 多个 URL 匹配时使用索引回退
                    if (urlMatch.length > 1) {
                        const sameUrlTargets = targets.filter((t) => t.url === target.url);
                        if (sameUrlTargets.length === urlMatch.length) {
                            const idx = sameUrlTargets.findIndex((t) => t.id === targetId);
                            if (idx >= 0 && idx < urlMatch.length) {
                                return urlMatch[idx];
                            }
                        }
                    }
                }
            }
        } catch {
            // 忽略 fetch 错误
        }
    }
    return null;
}

/**
 * 获取指定 targetId 的 Page 对象
 */
export async function getPageForTargetId(opts: {
    cdpUrl: string;
    targetId?: string;
}): Promise<Page> {
    const { browser } = await connectBrowser(opts.cdpUrl);
    const pages = await getAllPages(browser);
    if (!pages.length) {
        throw new Error('No pages available in the connected browser.');
    }
    const first = pages[0];
    if (!opts.targetId) {
        return first;
    }
    const found = await findPageByTargetId(browser, opts.targetId, opts.cdpUrl);
    if (!found) {
        // 单页面回退
        if (pages.length === 1) {
            return first;
        }
        throw new Error('tab not found');
    }
    return found;
}

// ============ Ref 定位器 ============

/**
 * 使用 ref 创建 Locator
 */
export function refLocator(page: Page, ref: string) {
    const normalized = ref.startsWith('@')
        ? ref.slice(1)
        : ref.startsWith('ref=')
            ? ref.slice(4)
            : ref;

    if (/^e\d+$/.test(normalized)) {
        const state = pageStates.get(page);
        if (state?.roleRefsMode === 'aria') {
            const scope = state.roleRefsFrameSelector
                ? page.frameLocator(state.roleRefsFrameSelector)
                : page;
            return scope.locator(`aria-ref=${normalized}`);
        }
        const info = state?.roleRefs?.[normalized];
        if (!info) {
            throw new Error(
                `Unknown ref "${normalized}". Run a new snapshot and use a ref from that snapshot.`,
            );
        }
        const scope = state?.roleRefsFrameSelector
            ? page.frameLocator(state.roleRefsFrameSelector)
            : page;
        const locAny = scope as unknown as {
            getByRole: (
                role: never,
                opts?: { name?: string; exact?: boolean },
            ) => ReturnType<Page['getByRole']>;
        };
        const locator = info.name
            ? locAny.getByRole(info.role as never, { name: info.name, exact: true })
            : locAny.getByRole(info.role as never);
        return info.nth !== undefined ? locator.nth(info.nth) : locator;
    }

    return page.locator(`aria-ref=${normalized}`);
}

// ============ 页面操作 ============

/**
 * 断开浏览器 CDP 连接（不关闭用户浏览器）
 * 注意：CDP 连接模式下 browser.close() 会关闭用户的 Chrome，
 * 这里只断开 Playwright 的连接，保留浏览器运行
 */
export async function closePlaywrightBrowserConnection(): Promise<void> {
    const cur = cached;
    cached = null;
    if (!cur) {
        return;
    }
    // 只断开 CDP 连接，不调用 browser.close() 以避免关闭用户浏览器
    try {
        // Playwright connectOverCDP 返回的 browser 有 _isClosedOrClosing 标志
        // 直接置空引用让 GC 回收即可，不要调用 close()
        (cur as any).browser = null;
    } catch {
        // 忽略
    }
}

/**
 * 列出所有页面/标签页
 */
export async function listPagesViaPlaywright(opts: { cdpUrl: string }): Promise<
    Array<{
        targetId: string;
        title: string;
        url: string;
        type: string;
    }>
> {
    const { browser } = await connectBrowser(opts.cdpUrl);
    const pages = await getAllPages(browser);
    const results: Array<{
        targetId: string;
        title: string;
        url: string;
        type: string;
    }> = [];

    for (const page of pages) {
        const tid = await pageTargetId(page).catch(() => null);
        if (tid) {
            results.push({
                targetId: tid,
                title: await page.title().catch(() => ''),
                url: page.url(),
                type: 'page',
            });
        }
    }
    return results;
}

/**
 * 创建新页面/标签页
 */
export async function createPageViaPlaywright(opts: { cdpUrl: string; url: string }): Promise<{
    targetId: string;
    title: string;
    url: string;
    type: string;
}> {
    const { browser } = await connectBrowser(opts.cdpUrl);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    ensureContextState(context);

    const page = await context.newPage();
    ensurePageState(page);

    // 导航到 URL
    const targetUrl = opts.url.trim() || 'about:blank';
    if (targetUrl !== 'about:blank') {
        await page.goto(targetUrl, { timeout: 30_000 }).catch(() => {
            // 导航可能失败，但页面已创建
        });
    }

    const tid = await pageTargetId(page).catch(() => null);
    if (!tid) {
        throw new Error('Failed to get targetId for new page');
    }

    return {
        targetId: tid,
        title: await page.title().catch(() => ''),
        url: page.url(),
        type: 'page',
    };
}

/**
 * 关闭指定页面
 */
export async function closePageByTargetIdViaPlaywright(opts: {
    cdpUrl: string;
    targetId: string;
}): Promise<void> {
    const { browser } = await connectBrowser(opts.cdpUrl);
    const page = await findPageByTargetId(browser, opts.targetId, opts.cdpUrl);
    if (!page) {
        throw new Error('tab not found');
    }
    await page.close();
}

/**
 * 激活/聚焦指定页面
 */
export async function focusPageByTargetIdViaPlaywright(opts: {
    cdpUrl: string;
    targetId: string;
}): Promise<void> {
    const { browser } = await connectBrowser(opts.cdpUrl);
    const page = await findPageByTargetId(browser, opts.targetId, opts.cdpUrl);
    if (!page) {
        throw new Error('tab not found');
    }
    try {
        await page.bringToFront();
    } catch (err) {
        const session = await page.context().newCDPSession(page);
        try {
            await session.send('Page.bringToFront');
            return;
        } catch {
            throw err;
        } finally {
            await session.detach().catch(() => { });
        }
    }
}

// 导出类型
export type { WithSnapshotForAI };
