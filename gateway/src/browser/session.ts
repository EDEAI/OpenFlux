/**
 * Browser Session Management
 * Migrated from OpenClaw pw-session.ts
 * 
 * Manage CDP connections, Page status tracking, Role Refs cache
 */

import type {
    Browser,
    BrowserContext,
    ConsoleMessage,
    Page,
    Request,
    Response,
} from 'playwright-core';

// Lazy loading of playwright-core (to avoid occupying ~80MB of memory at startup)
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

// ============ state storage ============

const pageStates = new WeakMap<Page, PageState>();
const contextStates = new WeakMap<BrowserContext, ContextState>();
const observedContexts = new WeakSet<BrowserContext>();
const observedPages = new WeakSet<Page>();

// Role refs cache (stable across requests)
const roleRefsByTarget = new Map<string, RoleRefsCacheEntry>();

// connection cache
let cached: ConnectedBrowser | null = null;
let connecting: Promise<ConnectedBrowser> | null = null;

// ============ Helper function ============

function normalizeCdpUrl(raw: string): string {
    return raw.replace(/\/$/, '');
}

function roleRefsKey(cdpUrl: string, targetId: string): string {
    return `${normalizeCdpUrl(cdpUrl)}::${targetId}`;
}

// ============ Role Refs Management ============

/**
 * Remember role refs for target (for cross-request recovery)
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
    // Limit cache size
    while (roleRefsByTarget.size > MAX_ROLE_REFS_CACHE) {
        const first = roleRefsByTarget.keys().next();
        if (first.done) {
            break;
        }
        roleRefsByTarget.delete(first.value);
    }
}

/**
 * Store role refs into page state
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
 * Restoring role refs from cache
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
        return; // Already have refs, do not overwrite
    }
    state.roleRefs = cachedRefs.refs;
    state.roleRefsFrameSelector = cachedRefs.frameSelector;
    state.roleRefsMode = cachedRefs.mode;
}

// ============ Page status management ============

/**
 * Make sure the page has a state object and set up event listeners
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

        // Listen for console messages
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

        // Listen for page errors
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

        // Listen for network requests
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

        // Listen for responses
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

        // Monitoring request failed
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

        // Clean up when page is closed
        page.on('close', () => {
            pageStates.delete(page);
            observedPages.delete(page);
        });
    }

    return state;
}

// ============ Context state management ============

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

// ============ Browser connection ============

/**
 * Connect to CDP endpoint
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
                // Try to get WebSocket URL
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
 * Get Chrome WebSocket URL
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

// ============ Page search ============

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

    // First try the standard CDP session way
    for (const page of pages) {
        const tid = await pageTargetId(page).catch(() => null);
        if (tid && tid === targetId) {
            return page;
        }
    }

    // Fallback: Use /json/list endpoint for URL matching
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
                    // Try URL match
                    const urlMatch = pages.filter((p) => p.url() === target.url);
                    if (urlMatch.length === 1) {
                        return urlMatch[0];
                    }
                    // Use index fallback when multiple URL matches
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
            // Ignore fetch errors
        }
    }
    return null;
}

/**
 * Get the Page object with the specified targetId
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
        // Single page rollback
        if (pages.length === 1) {
            return first;
        }
        throw new Error('tab not found');
    }
    return found;
}

// ============ Ref locator ============

/**
 * Create Locator using ref
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

// ============ Page operations ============

/**
 * Disconnect browser CDP (without closing the user's browser)
 * Note: browser.close() will close the user's Chrome in CDP connection mode.
 * Here we only disconnect Playwright and keep the browser running
 */
export async function closePlaywrightBrowserConnection(): Promise<void> {
    const cur = cached;
    cached = null;
    if (!cur) {
        return;
    }
    // Only disconnect CDP without calling browser.close() to avoid closing the user's browser
    try {
        // The browser returned by Playwright connectOverCDP has the _isClosedOrClosing flag
        // Just empty the reference and let GC recycle it. Do not call close()
        (cur as any).browser = null;
    } catch {
        // neglect
    }
}

/**
 * List all pages/tabs
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
 * Create new page/tab
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

    // Navigate to URL
    const targetUrl = opts.url.trim() || 'about:blank';
    if (targetUrl !== 'about:blank') {
        await page.goto(targetUrl, { timeout: 30_000 }).catch(() => {
            // Navigation may fail but page is created
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
 * Close specified page
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
 * Activate/focus specified page
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

// Export type
export type { WithSnapshotForAI };
