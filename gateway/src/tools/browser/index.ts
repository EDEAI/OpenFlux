/**
 * Browser Automation Tool - CDP Connection Mode
 * Based on playwright-core, connect users' existing browsers
 */

import type { AnyTool, ToolResult, ToolExecutionContext } from '../types';
import {
    readStringParam,
    readNumberParam,
    readBooleanParam,
    readStringArrayParam,
    validateAction,
    jsonResult,
    errorResult,
} from '../common';
import { spawn } from 'child_process';
import { existsSync, writeFileSync, mkdirSync, copyFileSync } from 'fs';
import { dirname, join } from 'path';

// Import browser modules migrated from OpenClaw
import * as BrowserModule from '../../browser/index.js';

// Dynamically load playwright-core
let playwrightCoreModule: typeof import('playwright-core') | null = null;
async function getChromium() {
    if (!playwrightCoreModule) {
        try {
            playwrightCoreModule = await import('playwright-core');
        } catch (error: any) {
            throw new Error(`Failed to load playwright-core: ${error.message}. Please run: npm install playwright-core`);
        }
    }
    return playwrightCoreModule!.chromium;
}

// Supported actions (refer to Clawdbot design + OpenClaw enhancement)
const BROWSER_ACTIONS = [
    'status',     // Get browser status
    'connect',    // Connect to user browser
    'disconnect', // Disconnect
    'tabs',       // List all tabs
    'tabOpen',    // Open new tab
    'tabSwitch',  // Switch tabs
    'tabClose',   // Close tab
    'navigate',   // Navigate to URL
    'screenshot', // Screenshot (supports ref/element positioning)
    'click',      // Click element (CSS selector)
    'type',       // Enter text (CSS selector)
    'evaluate',   // Execute JavaScript
    'wait',       // wait
    'content',    // Get page content
    'dialog',     // Handle pop-up windows (alert/confirm/prompt)
    // OpenClaw enhanced actions
    'snapshot',   // Get ARIA character snapshot (readable by LLM)
    'clickRef',   // Press ref to click on the element (supports right-click/double-click/modifier keys)
    'typeRef',    // Press ref to enter text (supports slow verbatim input)
    'hoverRef',   // Hover by ref
    'dragRef',    // Press ref to drag the element (startRef -> endRef)
    'pressKey',   // Keystrokes (Enter/Escape/Tab/Ctrl+C, etc.)
    'selectRef',  // Press ref to select dropdown option
    'fillForm',   // Fill in form fields in batches
    'scrollRef',  // Press ref to scroll the element to the visible area
    'uploadFiles',// Upload files to input elements
    'pdf',        // Export the current page as PDF
    'console',    // Get/clear console logs
] as const;

type BrowserAction = (typeof BROWSER_ACTIONS)[number];

// Default CDP port
const DEFAULT_CDP_URL = 'http://127.0.0.1:9222';
const CDP_PORT = 9222;

export interface BrowserToolOptions {
    /** CDP connects to URL */
    cdpUrl?: string;
    /** Default timeout (milliseconds) */
    timeout?: number;
    /** Automatically launch Chrome if not running */
    autoLaunch?: boolean;
}

// Browser connection status
let browserInstance: any = null;
let pageInstance: any = null;  // Default page (used when there is no sessionId)
let currentCdpUrl: string = DEFAULT_CDP_URL;
/** Current browser connection mode: 'cdp'=Connecting user Chrome via CDP, 'playwright'=Stand-alone browser launched by Playwright, null=Not connected */
let browserMode: 'cdp' | 'playwright' | null = null;

// Per-session page mapping: different sessions control different tabs
const sessionPages = new Map<string, any>();

// Get the page that should be used by the current session
function getPageForSession(sessionId?: string): any {
    if (sessionId && sessionPages.has(sessionId)) {
        const page = sessionPages.get(sessionId);
        // Verify that the page has not been closed
        if (page && !page.isClosed()) {
            return page;
        }
        // page is closed, clean mapping
        sessionPages.delete(sessionId);
    }
    // There is a sessionId but returns null if it is not hit (does not roll back the global situation to avoid grabbing tabs across sessions)
    return sessionId ? null : pageInstance;
}

// Set the page of the current session (no longer unconditionally override the global pageInstance)
function setPageForSession(page: any, sessionId?: string): void {
    if (sessionId) {
        sessionPages.set(sessionId, page);
    } else {
        // The global page is only set when there is no sessionId (backward compatibility)
        pageInstance = page;
    }
}

// Dialog pop-up status
let pendingDialog: { type: string; message: string; defaultValue?: string; dialog: any } | null = null;

// Console log cache
interface ConsoleEntry {
    type: string;
    text: string;
    timestamp: string;
}
let consoleBuffer: ConsoleEntry[] = [];

// Navigation history (for anti-loop circuit breaker) - per-session isolation
const navigationHistoryMap = new Map<string, Array<{ url: string; finalUrl: string; timestamp: number }>>();
function getNavHistory(key?: string): Array<{ url: string; finalUrl: string; timestamp: number }> {
    const k = key || '__global__';
    if (!navigationHistoryMap.has(k)) navigationHistoryMap.set(k, []);
    return navigationHistoryMap.get(k)!;
}
const MAX_SAME_DOMAIN_REDIRECTS = 3; // The same target domain name is blocked after being redirected N times.
const NAVIGATION_HISTORY_TTL = 5 * 60 * 1000; // History in 5 minutes

/**
 * TCP port survival detection (HTTP GET /json/version, 2 seconds timeout)
 */
async function isPortListening(port: number, host = '127.0.0.1'): Promise<boolean> {
    const http = await import('http');
    return new Promise((resolve) => {
        const url = `http://${host}:${port}/json/version`;
        const req = http.get(url, { timeout: 2000 }, (res) => {
            res.resume();
            // debug-level only — suppress from production logs
            if (process.env.BROWSER_DEBUG) console.log(`[browser] Port check ${port}: HTTP ${res.statusCode}`);
            resolve(res.statusCode === 200);
        });
        req.on('error', (_err) => {
            resolve(false);
        });
        req.on('timeout', () => {
            req.destroy();
            resolve(false);
        });
    });
}

/**
 * Detect whether the running Chrome/Edge has a debug port (wmic + TCP verification)
 * @returns Verified debugging port number that can be connected, returns 0 if unavailable
 */
async function findChromeDebugPort(): Promise<number> {
    const { execSync } = await import('child_process');
    try {
        const output = execSync(
            'wmic process where "name=\'chrome.exe\' or name=\'msedge.exe\'" get CommandLine /format:list',
            { encoding: 'utf-8', timeout: 5000, windowsHide: true }
        );
        const match = output.match(/--remote-debugging-port=(\d+)/);
        if (match) {
            const port = parseInt(match[1], 10);
            // TCP Verifies that the port is actually connectable
            const alive = await isPortListening(port);
            if (alive) {
                console.log(`[browser] Detected existing debug port: ${port} (verified)`);
                return port;
            } else {
                // port not responding — silent
                return 0;
            }
        }
    } catch {
        // wmic failed, ignored
    }
    return 0;
}

/**
 * Detect if Chrome/Edge is running
 */
async function isChromeRunning(): Promise<boolean> {
    const { execSync } = await import('child_process');
    try {
        const output = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /NH', { encoding: 'utf-8', timeout: 3000, windowsHide: true });
        if (output.includes('chrome.exe')) return true;
        const output2 = execSync('tasklist /FI "IMAGENAME eq msedge.exe" /NH', { encoding: 'utf-8', timeout: 3000, windowsHide: true });
        return output2.includes('msedge.exe');
    } catch {
        return false;
    }
}

/**
 * Clean browser status (called when the browser is closed/disconnected)
 */
function resetBrowserState(): void {
    browserInstance = null;
    pageInstance = null;
    sessionPages.clear();
    navigationHistoryMap.clear();
    browserMode = null;
    console.log('[browser] Browser state reset');
}

/**
 * Get the persistent Chrome debugging profile directory (under AppData, not TEMP)
 */
function getPersistentDebugDataDir(): string {
    const appData = process.env.APPDATA || process.env.LOCALAPPDATA || process.env.TEMP || 'C:\\Temp';
    return join(appData, 'NexusAiBot', 'chrome-debug');
}

/**
 * Copy session data (Cookie/Login Data) from user Chrome profile to debug profile
 * Note: Cookie files may be locked while Chrome is running, and copying may fail (skipping silently)
 */
function copyChromeSessionData(srcDir: string, destDir: string): void {
    const filesToCopy = [
        join('Default', 'Cookies'),
        join('Default', 'Cookies-journal'),
        join('Default', 'Login Data'),
        join('Default', 'Login Data-journal'),
        join('Default', 'Web Data'),
        join('Default', 'Web Data-journal'),
        'Local State',
    ];

    let copied = 0;
    for (const file of filesToCopy) {
        const src = join(srcDir, file);
        const dest = join(destDir, file);
        if (existsSync(src)) {
            try {
                mkdirSync(dirname(dest), { recursive: true });
                copyFileSync(src, dest);
                copied++;
            } catch {
                // Chrome may have locked the file and is skipping it silently
            }
        }
    }
    console.log(`[browser] Copied ${copied}/${filesToCopy.length} session files from user Chrome profile`);
}

/**
 * Make sure the browser is available (unified connection/launch portal)
 * Priority: Already connected > CDP connects user Chrome > Playwright starts independent browser
 * @returns true=Browser ready, false=Start failed
 */
export async function ensureBrowser(sessionId?: string): Promise<boolean> {
    // A browserInstance is already available
    if (browserInstance) {
        // Make sure there is page
        if (!getPageForSession(sessionId)) {
            try {
                const contexts = browserInstance.contexts();
                const page = contexts.length > 0 && contexts[0].pages().length > 0
                    ? contexts[0].pages()[0]
                    : await (contexts[0] || await browserInstance.newContext()).newPage();
                if (!sessionId) pageInstance = page;
                setPageForSession(page, sessionId);
            } catch {
                // browserInstance may have expired, clean it up and continue
                resetBrowserState();
            }
        }
        if (browserInstance) return true;
    }

    // Step 1: Try CDP to connect user Chrome
    const existingPort = await findChromeDebugPort();
    if (existingPort > 0) {
        try {
            const cdpUrl = `http://127.0.0.1:${existingPort}`;
            console.log(`[browser] Connecting via CDP: ${cdpUrl}`);
            browserInstance = await (await getChromium()).connectOverCDP(cdpUrl, { timeout: 5000 });
            currentCdpUrl = cdpUrl;
            browserMode = 'cdp';
            // Get/create page
            const contexts = browserInstance.contexts();
            const page = contexts.length > 0 && contexts[0].pages().length > 0
                ? contexts[0].pages()[0]
                : await (contexts[0] || await browserInstance.newContext()).newPage();
            pageInstance = page;
            setPageForSession(page, sessionId);
            setupPageListeners(page);
            console.log(`[browser] CDP connected, mode=cdp`);
            return true;
        } catch (e: any) {
            console.warn(`[browser] CDP connect failed: ${e.message}`);
            resetBrowserState();
        }
    }

    // Step 1.5: Chrome is running but no debug port -> start a separate debug instance (reuse user session data)
    const chromeRunning = await isChromeRunning();
    if (chromeRunning) {
        console.log('[browser] Chrome running without debug port, launching a separate debug instance with session reuse...');

        // Find Chrome path
        const localAppData = process.env.LOCALAPPDATA || '';
        const chromePaths = [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            localAppData + '\\Google\\Chrome\\Application\\chrome.exe',
        ];
        let chromePath: string | undefined;
        for (const p of chromePaths) {
            if (existsSync(p)) { chromePath = p; break; }
        }
        if (chromePath) {
            // Use a persistent AppData directory (not TEMP) to preserve login status across reboots
            const debugDataDir = getPersistentDebugDataDir();
            try { mkdirSync(debugDataDir, { recursive: true }); } catch { /* ignore */ }

            // Smart session reuse: If the debug profile doesn't have a cookie yet, copy it from the user's Chrome
            const debugCookiePath = join(debugDataDir, 'Default', 'Cookies');
            if (!existsSync(debugCookiePath)) {
                const userChromeDataDir = join(localAppData, 'Google', 'Chrome', 'User Data');
                const userCookiePath = join(userChromeDataDir, 'Default', 'Cookies');
                if (existsSync(userCookiePath)) {
                    console.log('[browser] First-time debug launch: copying session data from user Chrome profile...');
                    copyChromeSessionData(userChromeDataDir, debugDataDir);
                }
            } else {
                console.log('[browser] Using existing persistent debug profile with saved sessions');
            }

            console.log(`[browser] Launching isolated Chrome debug instance: ${chromePath}`);
            spawn(chromePath, [
                `--remote-debugging-port=${CDP_PORT}`,
                `--user-data-dir=${debugDataDir}`,
                '--no-first-run',
                '--no-default-browser-check',
            ], {
                detached: true,
                stdio: 'ignore',
            }).unref();

            // Wait for CDP port to be ready (up to 8 seconds)
            for (let i = 0; i < 16; i++) {
                await new Promise(r => setTimeout(r, 500));
                if (await isPortListening(CDP_PORT)) {
                    console.log(`[browser] Debug port ${CDP_PORT} ready after ${(i + 1) * 500}ms`);
                    break;
                }
            }

            // Try CDP connection
            if (await isPortListening(CDP_PORT)) {
                try {
                    const cdpUrl = `http://127.0.0.1:${CDP_PORT}`;
                    browserInstance = await (await getChromium()).connectOverCDP(cdpUrl, { timeout: 5000 });
                    currentCdpUrl = cdpUrl;
                    browserMode = 'cdp';
                    const contexts = browserInstance.contexts();
                    const page = contexts.length > 0 && contexts[0].pages().length > 0
                        ? contexts[0].pages()[0]
                        : await (contexts[0] || await browserInstance.newContext()).newPage();
                    pageInstance = page;
                    setPageForSession(page, sessionId);
                    setupPageListeners(page);
                    console.log('[browser] CDP connected to isolated debug instance (session-aware), mode=cdp');
                    return true;
                } catch (e: any) {
                    console.warn(`[browser] CDP connect to isolated instance failed: ${e.message}`);
                    resetBrowserState();
                }
            } else {
                console.warn('[browser] Debug port not ready for isolated Chrome instance');
            }
        }
    }

    // Step 2: Playwright launches standalone Chromium
    console.log('[browser] Launching Playwright Chromium...');
    try {
        const chromium = await getChromium();
        const localAppData2 = process.env.LOCALAPPDATA || '';
        const chromePaths2 = [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            localAppData2 + '\\Google\\Chrome\\Application\\chrome.exe',
        ];
        let executablePath: string | undefined;
        for (const p of chromePaths2) {
            if (existsSync(p)) { executablePath = p; break; }
        }

        browserInstance = await chromium.launch({
            headless: false,
            ...(executablePath ? { executablePath, channel: undefined } : { channel: 'chrome' }),
            args: ['--no-first-run', '--no-default-browser-check'],
        });
        browserMode = 'playwright';

        // Monitor browser closing events and automatically clean up the status
        browserInstance.on('disconnected', () => {
            console.log('[browser] Playwright browser disconnected');
            resetBrowserState();
        });

        // Get/create page
        const contexts = browserInstance.contexts();
        const page = contexts.length > 0 && contexts[0].pages().length > 0
            ? contexts[0].pages()[0]
            : await (contexts[0] || await browserInstance.newContext()).newPage();
        pageInstance = page;
        setPageForSession(page, sessionId);
        setupPageListeners(page);
        console.log('[browser] Playwright Chromium launched, mode=playwright');
        return true;
    } catch (err: any) {
        console.error(`[browser] Playwright launch failed: ${err.message}`);
        resetBrowserState();
        return false;
    }
}

/** Register dialog / console listener for page */
function setupPageListeners(page: any): void {
    if (!page) return;
    page.on('dialog', (dialog: any) => {
        pendingDialog = {
            type: dialog.type(),
            message: dialog.message(),
            defaultValue: dialog.defaultValue?.() || undefined,
            dialog,
        };
        console.log(`[browser] Dialog detected: ${dialog.type()} - ${dialog.message()}`);
    });
    page.on('console', (msg: any) => {
        consoleBuffer.push({
            type: msg.type(),
            text: msg.text(),
            timestamp: new Date().toISOString(),
        });
        if (consoleBuffer.length > 500) consoleBuffer.splice(0, consoleBuffer.length - 300);
    });
}

// Retain backward compatibility
export const launchChromeWithDebugPort = ensureBrowser;

/**
 * Create a browser automation tool (CDP connection mode)
 */
export function createBrowserTool(opts: BrowserToolOptions = {}): AnyTool {
    const {
        cdpUrl = DEFAULT_CDP_URL,
        timeout = 30000,
    } = opts;

    currentCdpUrl = cdpUrl;

    return {
        name: 'browser',
        priority: 15,
        description: `Browser automation tool (connects to user's existing browser).

## Interaction Strategy (must follow)
1. **Preferred: Structured element operations** — After navigate, interactive elements with ref identifiers (e.g., e1, e2) are automatically returned. Use clickRef/typeRef/selectRef directly.
2. **Alternative: snapshot to refresh element list** — After page changes, use snapshot to get updated element list and refs.
3. **Fallback: evaluate script** — Use page scripts for complex DOM operations.
4. **Last resort: screenshot** — Only take screenshots when the above methods cannot identify the target element.

## Session-Aware Browsing (CRITICAL for login-required sites)
When accessing sites that require login (Taobao, JD.com, Amazon, etc.):
1. **FIRST** use **tabs** action to list all open tabs — an already-logged-in tab may exist
2. Use **tabSwitch** to switch to the logged-in tab, then operate within it
3. If no logged-in tab exists, use **tabOpen** and navigate from the new tab
4. If navigate returns **redirected: true**, the session has NO login cookie — do NOT retry
5. After 2-3 redirect failures, STOP and tell the user: "Please log in to [site] first"
6. **NEVER** try HTTP requests, Python crawlers, or Playwright scripts as alternatives — they will also fail without cookies

## Standard Flow
connect → tabs (check for logged-in pages) → navigate or tabSwitch → clickRef/typeRef operations → snapshot (refresh after page changes) → continue

⚠️ **Do NOT** use screenshot when refs are available. It wastes time and tokens.

Supported actions: ${BROWSER_ACTIONS.join(', ')}`,
        parameters: {
            action: {
                type: 'string',
                description: `Action type: ${BROWSER_ACTIONS.join('/')}`,
                required: true,
                enum: [...BROWSER_ACTIONS],
            },
            url: {
                type: 'string',
                description: 'Target URL (required for navigate) or CDP URL (optional for connect, default http://127.0.0.1:9222)',
            },
            selector: {
                type: 'string',
                description: 'Element selector (required for click/type/wait actions)',
            },
            text: {
                type: 'string',
                description: 'Input text (required for type/typeRef actions)',
            },
            script: {
                type: 'string',
                description: 'JavaScript code (required for evaluate action)',
            },
            path: {
                type: 'string',
                description: 'Screenshot save path (optional for screenshot action)',
            },
            timeout: {
                type: 'number',
                description: 'Timeout in milliseconds',
            },
            fullPage: {
                type: 'boolean',
                description: 'Whether to take a full-page screenshot',
                default: false,
            },
            targetId: {
                type: 'string',
                description: 'Tab ID (optional, for operating on a specific tab)',
            },
            // OpenClaw enhancement parameters
            ref: {
                type: 'string',
                description: 'Element ref identifier (e.g., e1, e2) from snapshot action. Used for clickRef/typeRef/hoverRef/selectRef/scrollRef/screenshot',
            },
            interactive: {
                type: 'boolean',
                description: 'snapshot action: Whether to return only interactive elements (recommended for operation scenarios, reduces output)',
                default: false,
            },
            refsMode: {
                type: 'string',
                description: 'snapshot action: ref generation mode. role=based on ariaSnapshot (default, stable); aria=based on _snapshotForAI (Playwright native refs, more stable across calls)',
                enum: ['role', 'aria'],
            },
            compact: {
                type: 'boolean',
                description: 'snapshot action: Whether to compact output (removes unnamed structural elements and empty branches, reduces tokens)',
                default: false,
            },
            maxDepth: {
                type: 'number',
                description: 'snapshot action: Maximum depth limit (0=root only, default unlimited)',
            },
            snapshotSelector: {
                type: 'string',
                description: 'snapshot action: CSS selector to scope snapshot to a specific element',
            },
            frame: {
                type: 'string',
                description: 'snapshot action: iframe selector to snapshot an embedded iframe',
            },
            submit: {
                type: 'boolean',
                description: 'typeRef action: Whether to press Enter after typing to submit',
                default: false,
            },
            slowly: {
                type: 'boolean',
                description: 'typeRef action: Whether to type slowly character by character (simulates human typing, ~75ms delay per character)',
                default: false,
            },
            doubleClick: {
                type: 'boolean',
                description: 'clickRef action: Whether to double-click',
                default: false,
            },
            button: {
                type: 'string',
                description: 'clickRef action: Mouse button left/right/middle',
            },
            modifiers: {
                type: 'array',
                description: 'clickRef action: Modifier keys array, values: Control, Shift, Alt, Meta',
                items: { type: 'string' },
            },
            key: {
                type: 'string',
                description: 'pressKey action: Key name, e.g., Enter, Escape, Tab, ArrowDown, Control+c, Control+a',
            },
            startRef: {
                type: 'string',
                description: 'dragRef action: Source element ref for drag',
            },
            endRef: {
                type: 'string',
                description: 'dragRef action: Target element ref for drag',
            },
            values: {
                type: 'array',
                description: 'selectRef action: Dropdown option values array',
                items: { type: 'string' },
            },
            fields: {
                type: 'array',
                description: 'fillForm action: Form fields array, each item {ref: "e1", type: "text|checkbox|radio", value: "..."}',
                items: { type: 'object' },
            },
            paths: {
                type: 'array',
                description: 'uploadFiles action: File paths array to upload',
                items: { type: 'string' },
            },
            inputRef: {
                type: 'string',
                description: 'uploadFiles action: File input ref (alternative to selector)',
            },
            element: {
                type: 'string',
                description: 'screenshot/uploadFiles action: CSS selector to locate element',
            },
            tabIndex: {
                type: 'number',
                description: 'tabSwitch/tabClose action: Tab index (0-based, from tabs action)',
            },
            dialogAction: {
                type: 'string',
                description: 'dialog action: Dialog handling method accept/dismiss/status',
            },
            promptText: {
                type: 'string',
                description: 'dialog action: Input text for prompt dialogs',
            },
            filePath: {
                type: 'string',
                description: 'pdf action: PDF save path',
            },
            format: {
                type: 'string',
                description: 'pdf action: Paper format (A4/Letter/Legal, default A4)',
            },
            consoleAction: {
                type: 'string',
                description: 'console action: status (get logs) / clear (clear logs)',
            },
        },

        execute: async (args: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> => {
            const action = validateAction(args, BROWSER_ACTIONS);
            const actionTimeout = readNumberParam(args, 'timeout', { integer: true }) || timeout;
            const sessionId = context?.sessionId;
            // Use independent tab keys for scheduled tasks (to avoid contaminating tabs that users manually browse)
            const isScheduled = context?.isScheduledTask === true;
            const pageKey = isScheduled && sessionId ? `__sched_${sessionId}_${Date.now()}` : sessionId;
            // Get the page of the current session based on pageKey
            let currentPage = getPageForSession(pageKey);

            switch (action) {
                // Get browser status
                case 'status': {
                    return jsonResult({
                        connected: !!browserInstance,
                        hasPage: !!currentPage,
                        cdpUrl: currentCdpUrl,
                        url: currentPage ? (() => { try { return currentPage!.url(); } catch { return null; } })() : null,
                        title: currentPage ? await currentPage.title().catch(() => null) : null,
                    });
                }

                // Connect to user browser (automatically launch Chrome)
                case 'connect': {
                    const ok = await ensureBrowser(sessionId);
                    if (!ok) {
                        return errorResult('Browser launch failed. Please try again or manually launch Chrome with: chrome.exe --remote-debugging-port=9222');
                    }
                    const tabCount = browserInstance.contexts().flatMap((c: any) => c.pages()).length;
                    return jsonResult({
                        message: browserMode === 'cdp' ? 'Connected to browser via CDP' : 'Playwright browser launched and ready',
                        connected: true,
                        mode: browserMode,
                        ...(browserMode === 'cdp' ? { cdpUrl: currentCdpUrl } : {}),
                        tabCount,
                    });
                }

                // Disconnect
                case 'disconnect': {
                    if (!browserInstance) {
                        return jsonResult({ message: 'Not connected to browser', connected: false });
                    }
                    const wasMode = browserMode;
                    // Playwright mode: close the browser to release resources; CDP mode: only disconnect without closing the user's browser
                    if (wasMode === 'playwright') {
                        try { await browserInstance.close(); } catch { /* ignore */ }
                    }
                    resetBrowserState();
                    return jsonResult({ message: wasMode === 'playwright' ? 'Playwright browser closed' : 'Disconnected (browser keeps running)', connected: false });
                }

                // List all tabs
                case 'tabs': {
                    if (!browserInstance) {
                        return errorResult('Not connected to browser, please execute connect action first');
                    }
                    try {
                        const contexts = browserInstance.contexts();
                        const tabs: Array<{ title: string; url: string; index: number }> = [];
                        let index = 0;
                        for (const context of contexts) {
                            for (const page of context.pages()) {
                                tabs.push({
                                    title: await page.title().catch(() => ''),
                                    url: page.url(),
                                    index: index++,
                                });
                            }
                        }
                        return jsonResult({ tabs, count: tabs.length });
                    } catch (error: any) {
                        return errorResult(`Failed to get tabs: ${error.message}`);
                    }
                }

                // Open new tab
                case 'tabOpen': {
                    if (!browserInstance) {
                        return errorResult('Not connected to browser, please execute connect action first');
                    }
                    try {
                        const url = readStringParam(args, 'url') || 'about:blank';
                        const contexts = browserInstance.contexts();
                        const context = contexts[0] || await browserInstance.newContext();
                        const newPage = await context.newPage();
                        if (url !== 'about:blank') {
                            await newPage.goto(url, { timeout: actionTimeout, waitUntil: 'domcontentloaded' });
                        }
                        // Switch to new tab
                        currentPage = newPage;
                        setPageForSession(currentPage, pageKey);
                        // Register dialog listener
                        newPage.on('dialog', (dialog: any) => {
                            pendingDialog = {
                                type: dialog.type(),
                                message: dialog.message(),
                                defaultValue: dialog.defaultValue?.() || undefined,
                                dialog,
                            };
                        });
                        const title = await newPage.title().catch(() => '');
                        return jsonResult({ opened: true, url, title });
                    } catch (error: any) {
                        return errorResult(`Failed to open tab: ${error.message}`);
                    }
                }

                // Switch tabs
                case 'tabSwitch': {
                    if (!browserInstance) {
                        return errorResult('Not connected to browser, please execute connect action first');
                    }
                    try {
                        const tabIndex = readNumberParam(args, 'tabIndex');
                        if (tabIndex === undefined) {
                            return errorResult('Missing tabIndex parameter, please use tabs action first to get the tab list');
                        }
                        const allPages: any[] = [];
                        for (const ctx of browserInstance.contexts()) {
                            allPages.push(...ctx.pages());
                        }
                        if (tabIndex < 0 || tabIndex >= allPages.length) {
                            return errorResult(`Tab index ${tabIndex} out of range, total ${allPages.length} tabs`);
                        }
                        currentPage = allPages[tabIndex];
                        setPageForSession(currentPage, pageKey);
                        await currentPage.bringToFront();
                        // Re-register dialog listener
                        currentPage.on('dialog', (dialog: any) => {
                            pendingDialog = {
                                type: dialog.type(),
                                message: dialog.message(),
                                defaultValue: dialog.defaultValue?.() || undefined,
                                dialog,
                            };
                        });
                        const title = await currentPage.title().catch(() => '');
                        const url = currentPage.url();
                        return jsonResult({ switched: true, tabIndex, title, url });
                    } catch (error: any) {
                        return errorResult(`Failed to switch tab: ${error.message}`);
                    }
                }

                // Close tab
                case 'tabClose': {
                    if (!browserInstance) {
                        return errorResult('Not connected to browser, please execute connect action first');
                    }
                    try {
                        const tabIndex = readNumberParam(args, 'tabIndex');
                        const allPages: any[] = [];
                        for (const ctx of browserInstance.contexts()) {
                            allPages.push(...ctx.pages());
                        }
                        let targetPage: any;
                        if (tabIndex !== undefined) {
                            if (tabIndex < 0 || tabIndex >= allPages.length) {
                                return errorResult(`Tab index ${tabIndex} out of range`);
                            }
                            targetPage = allPages[tabIndex];
                        } else {
                            // No index specified, close the current tab
                            targetPage = currentPage;
                        }
                        if (!targetPage) {
                            return errorResult('No tab to close');
                        }
                        // Prevent closing the last tab from causing Chrome to quit
                        if (allPages.length <= 1) {
                            return errorResult('Cannot close the last tab (it would cause the browser to exit). Use navigate action to go to another page.');
                        }
                        const closedUrl = targetPage.url();
                        await targetPage.close();
                        // If the current page is closed, switch to the first available page
                        if (targetPage === currentPage) {
                            const remaining: any[] = [];
                            for (const ctx of browserInstance.contexts()) {
                                remaining.push(...ctx.pages());
                            }
                            currentPage = remaining.length > 0 ? remaining[0] : null;
                            setPageForSession(currentPage, pageKey);
                        }
                        return jsonResult({ closed: true, closedUrl, remaining: allPages.length - 1 });
                    } catch (error: any) {
                        return errorResult(`Failed to close tab: ${error.message}`);
                    }
                }

                // Handle pop-up windows (alert/confirm/prompt)
                case 'dialog': {
                    const dialogAction = readStringParam(args, 'dialogAction') || 'status';
                    switch (dialogAction) {
                        case 'status': {
                            if (!pendingDialog) {
                                return jsonResult({ hasDialog: false });
                            }
                            return jsonResult({
                                hasDialog: true,
                                type: pendingDialog.type,
                                message: pendingDialog.message,
                                defaultValue: pendingDialog.defaultValue,
                            });
                        }
                        case 'accept': {
                            if (!pendingDialog) {
                                return errorResult('No dialog currently');
                            }
                            const promptText = readStringParam(args, 'promptText');
                            if (promptText) {
                                await pendingDialog.dialog.accept(promptText);
                            } else {
                                await pendingDialog.dialog.accept();
                            }
                            const info = { type: pendingDialog.type, message: pendingDialog.message };
                            pendingDialog = null;
                            return jsonResult({ accepted: true, ...info });
                        }
                        case 'dismiss': {
                            if (!pendingDialog) {
                                return errorResult('No dialog currently');
                            }
                            await pendingDialog.dialog.dismiss();
                            const info = { type: pendingDialog.type, message: pendingDialog.message };
                            pendingDialog = null;
                            return jsonResult({ dismissed: true, ...info });
                        }
                        default:
                            return errorResult(`Unknown dialog action: ${dialogAction}, supported: status/accept/dismiss`);
                    }
                }

                // Navigate to URL
                case 'navigate': {
                    if (!browserInstance) {
                        const ok = await ensureBrowser(sessionId);
                        if (!ok) {
                            return errorResult('Browser launch failed. Please try again or manually launch Chrome with: chrome.exe --remote-debugging-port=9222');
                        }
                        // ensureBrowser may have created a global page, search again
                        currentPage = getPageForSession(pageKey);
                    }
                    // The current session/task does not have an independent tab -> automatically created
                    if (!currentPage && browserInstance) {
                        try {
                            const contexts = browserInstance.contexts();
                            const ctx = contexts[0] || await browserInstance.newContext();
                            currentPage = await ctx.newPage();
                            setupPageListeners(currentPage);
                            setPageForSession(currentPage, pageKey);
                            console.log(`[browser] New tab created for ${isScheduled ? 'scheduled task' : 'session'}: ${pageKey}`);
                        } catch (e: any) {
                            return errorResult(`Failed to create tab: ${e.message}`);
                        }
                    }
                    if (!currentPage) {
                        return errorResult('No available page');
                    }
                    const url = readStringParam(args, 'url', { required: true, label: 'url' });

                    // === Anti-loop circuit breaker: clean up expiration history + detect repeated redirects ===
                    const navigationHistory = getNavHistory(pageKey);
                    const now = Date.now();
                    while (navigationHistory.length > 0 && now - navigationHistory[0].timestamp > NAVIGATION_HISTORY_TTL) {
                        navigationHistory.shift();
                    }
                    let requestedHost: string;
                    try { requestedHost = new URL(url).hostname; } catch { requestedHost = url; }
                    const recentRedirects = navigationHistory.filter(h => {
                        try { return new URL(h.url).hostname === requestedHost && new URL(h.finalUrl).hostname !== requestedHost; } catch { return false; }
                    });
                    if (recentRedirects.length >= MAX_SAME_DOMAIN_REDIRECTS) {
                        return errorResult(
                            `Navigation to "${requestedHost}" has been redirected ${recentRedirects.length} times in the last 5 minutes. ` +
                            `This means the site requires authentication and the current browser session has no valid login cookies. ` +
                            `STOP retrying and tell the user: "Please log in to ${requestedHost} in the browser first, then try again." ` +
                            `Alternative: use "tabs" action to find an already-logged-in tab.`
                        );
                    }

                    try {
                        await currentPage.goto(url, { timeout: actionTimeout });
                        const title = await currentPage.title();
                        const finalUrl = currentPage.url();

                        // === Redirect detection ===
                        let redirected = false;
                        let redirectWarning: string | undefined;
                        try {
                            const requestedHostname = new URL(url).hostname;
                            const finalHostname = new URL(finalUrl).hostname;
                            if (requestedHostname !== finalHostname) {
                                redirected = true;
                                redirectWarning = `Page was redirected from ${requestedHostname} to ${finalHostname}. ` +
                                    `This usually means the site requires login and the browser has no valid session cookies. ` +
                                    `Use "tabs" action to check if there's an already-logged-in tab for ${requestedHostname}. ` +
                                    `If not, STOP and tell the user to log in first. Do NOT retry this navigation.`;
                                console.warn(`[browser] Redirect detected: ${requestedHostname} → ${finalHostname}`);
                            }
                        } catch { /* URL parse error, skip detection */ }

                        // Record to navigation history
                        navigationHistory.push({ url, finalUrl, timestamp: Date.now() });
                        // Limit history size
                        while (navigationHistory.length > 50) navigationHistory.shift();

                        // Extract key information from the page for analysis by LLM
                        const pageInfo = await currentPage.evaluate(`(function() {
                            var getMeta = function(name) {
                                var el = document.querySelector('meta[name="' + name + '"], meta[property="' + name + '"]');
                                return el ? (el.getAttribute('content') || '') : '';
                            };
                            var getHeadings = function(tag, limit) {
                                return Array.from(document.querySelectorAll(tag))
                                    .slice(0, limit)
                                    .map(function(el) { return el.textContent ? el.textContent.trim().substring(0, 100) : ''; })
                                    .filter(Boolean);
                            };
                            var getMainText = function() {
                                var clone = document.body.cloneNode(true);
                                clone.querySelectorAll('script, style, nav, header, footer, aside').forEach(function(el) { el.remove(); });
                                return clone.textContent ? clone.textContent.replace(/\\s+/g, ' ').trim().substring(0, 2000) : '';
                            };
                            return {
                                description: getMeta('description'),
                                keywords: getMeta('keywords'),
                                ogTitle: getMeta('og:title'),
                                ogDescription: getMeta('og:description'),
                                h1: getHeadings('h1', 3),
                                h2: getHeadings('h2', 5),
                                mainText: getMainText(),
                                linkCount: document.querySelectorAll('a').length,
                                imageCount: document.querySelectorAll('img').length,
                            };
                        })()`) as any;

                        // Automatically obtain snapshot (list of interactive elements) after successful navigation
                        let snapshot: { snapshot?: string; stats?: unknown } | null = null;
                        if (browserMode === 'cdp' && currentCdpUrl) {
                            try {
                                snapshot = await BrowserModule.snapshotRoleViaPlaywright({
                                    cdpUrl: currentCdpUrl,
                                    targetId: readStringParam(args, 'targetId'),
                                    options: { interactive: true, compact: true },
                                });
                            } catch (e: any) {
                                console.warn('[browser] Auto snapshot after navigate failed:', e.message);
                            }
                        }

                        return jsonResult({
                            url,
                            finalUrl,
                            title,
                            navigated: true,
                            redirected,
                            ...(redirectWarning ? { warning: redirectWarning } : {}),
                            // Only keep key meta information and remove mainText to reduce tokens
                            pageInfo: {
                                description: pageInfo.description,
                                h1: pageInfo.h1,
                                linkCount: pageInfo.linkCount,
                            },
                            ...(snapshot ? {
                                snapshot: snapshot.snapshot,
                                interactiveElements: snapshot.stats,
                                hint: 'Interactive elements are listed with ref identifiers (e.g., e1, e2). Prefer using clickRef/typeRef to operate, avoid screenshot.',
                            } : {}),
                        });
                    } catch (error: any) {
                        // Record history even if navigation fails (to prevent repeated timeouts)
                        getNavHistory(pageKey).push({ url, finalUrl: '', timestamp: Date.now() });
                        console.error(`[browser] Navigate failed: ${error.message}`, { url });
                        return errorResult(`Navigation failed: ${error.message}`);
                    }
                }

                // Screenshot (enhancement: support ref/element positioning to capture specific elements)
                case 'screenshot': {
                    if (!currentPage) {
                        return errorResult('Not connected to browser, please execute connect action first');
                    }
                    const path = readStringParam(args, 'path');
                    const fullPage = readBooleanParam(args, 'fullPage', false);
                    const screenshotRef = readStringParam(args, 'ref');
                    const screenshotElement = readStringParam(args, 'element');
                    try {
                        // Prioritize the use of enhanced screenshots of BrowserModule (support ref/element)
                        if (screenshotRef || screenshotElement) {
                            const result = await BrowserModule.takeScreenshotViaPlaywright({
                                cdpUrl: currentCdpUrl,
                                targetId: readStringParam(args, 'targetId'),
                                ref: screenshotRef,
                                element: screenshotElement,
                                fullPage,
                                type: 'png',
                            });
                            if (path) {
                                writeFileSync(path, result.buffer);
                            }
                            return jsonResult({
                                path,
                                size: result.buffer.length,
                                base64: path ? undefined : result.buffer.toString('base64'),
                                ref: screenshotRef,
                                element: screenshotElement,
                            });
                        }
                        const buffer = await currentPage.screenshot({
                            path,
                            fullPage,
                            type: 'png',
                        });
                        return jsonResult({
                            path,
                            size: buffer.length,
                            base64: path ? undefined : buffer.toString('base64'),
                        });
                    } catch (error: any) {
                        return errorResult(`Screenshot failed: ${error.message}`);
                    }
                }

                // click element
                case 'click': {
                    if (!currentPage) {
                        return errorResult('Not connected to browser, please execute connect action first');
                    }
                    const selector = readStringParam(args, 'selector', { required: true, label: 'selector' });
                    try {
                        await currentPage.click(selector, { timeout: actionTimeout });
                        return jsonResult({ selector, clicked: true });
                    } catch (error: any) {
                        return errorResult(`Click failed: ${error.message}. Suggestion: use snapshot to get element refs, then use clickRef.`);
                    }
                }

                // Enter text
                case 'type': {
                    if (!currentPage) {
                        return errorResult('Not connected to browser, please execute connect action first');
                    }
                    const selector = readStringParam(args, 'selector', { required: true, label: 'selector' });
                    const text = readStringParam(args, 'text', { required: true, label: 'text' });
                    try {
                        await currentPage.fill(selector, text, { timeout: actionTimeout });
                        return jsonResult({ selector, text, typed: true });
                    } catch (error: any) {
                        return errorResult(`Input failed: ${error.message}`);
                    }
                }

                // Execute JavaScript
                case 'evaluate': {
                    if (!currentPage) {
                        return errorResult('Not connected to browser, please execute connect action first');
                    }
                    const script = readStringParam(args, 'script', { required: true, label: 'script' });
                    try {
                        // If the script contains a return statement, it is automatically wrapped into an arrow function
                        // Avoid naked return in page.evaluate causing SyntaxError: Illegal return
                        const wrappedScript = /\breturn\b/.test(script)
                            ? `(() => { ${script} })()`
                            : script;
                        const result = await currentPage.evaluate(wrappedScript);
                        return jsonResult({ result });
                    } catch (error: any) {
                        return errorResult(`Script execution failed: ${error.message}. Tip: Script should be an expression (e.g., document.title) or IIFE, do not use bare return.`);
                    }
                }

                // wait
                case 'wait': {
                    if (!currentPage) {
                        return errorResult('Not connected to browser, please execute connect action first');
                    }
                    const selector = readStringParam(args, 'selector');
                    const waitTime = readNumberParam(args, 'timeout', { integer: true }) || 1000;
                    try {
                        if (selector) {
                            await currentPage.waitForSelector(selector, { timeout: actionTimeout });
                            return jsonResult({ selector, waited: true });
                        } else {
                            await new Promise((r) => setTimeout(r, waitTime));
                            return jsonResult({ waited: waitTime });
                        }
                    } catch (error: any) {
                        return errorResult(`Wait failed: ${error.message}`);
                    }
                }

                // Get page content
                case 'content': {
                    if (!currentPage) {
                        return errorResult('Not connected to browser, please execute connect action first');
                    }
                    try {
                        const content = await currentPage.content();
                        const title = await currentPage.title();
                        const url = currentPage.url();
                        return jsonResult({
                            url,
                            title,
                            contentLength: content.length,
                            content: content.slice(0, 10000),
                        });
                    } catch (error: any) {
                        return errorResult(`Failed to get content: ${error.message}`);
                    }
                }

                // ========== OpenClaw enhanced actions ==========

                // Get ARIA character snapshot (readable by LLM)
                case 'snapshot': {
                    const interactive = readBooleanParam(args, 'interactive', false);
                    const compact = readBooleanParam(args, 'compact', false);
                    const maxDepth = readNumberParam(args, 'maxDepth', { integer: true });
                    const refsMode = readStringParam(args, 'refsMode') as 'role' | 'aria' | undefined;
                    const snapshotSelector = readStringParam(args, 'snapshotSelector');
                    const frameSelector = readStringParam(args, 'frame');
                    try {
                        let result: any;
                        if (browserMode === 'cdp' && currentCdpUrl) {
                            // CDP mode: Use BrowserModule full snapshot (with ref identifier)
                            result = await BrowserModule.snapshotRoleViaPlaywright({
                                cdpUrl: currentCdpUrl,
                                targetId: readStringParam(args, 'targetId'),
                                refsMode: refsMode || undefined,
                                selector: snapshotSelector || undefined,
                                frameSelector: frameSelector || undefined,
                                options: {
                                    interactive,
                                    compact,
                                    ...(maxDepth !== undefined ? { maxDepth } : {}),
                                },
                            });
                        } else if (currentPage) {
                            // Playwright launch mode: using Accessibility API
                            const tree = await currentPage.accessibility.snapshot({ interestingOnly: interactive });
                            result = { snapshot: tree ? JSON.stringify(tree, null, 2) : 'Empty page', stats: {} };
                        } else {
                            return errorResult('No browser connection available. Use browser connect first.');
                        }
                        return jsonResult({
                            snapshot: result.snapshot,
                            stats: result.stats,
                            refsMode: refsMode || 'role',
                            usage: 'Use ref (e.g., e1, e2) with clickRef/typeRef actions to operate elements',
                        });
                    } catch (error: any) {
                        return errorResult(`Failed to get snapshot: ${error.message}`);
                    }
                }

                // Press ref to click on the element (enhancement: support right-click/double-click/modifier keys)
                case 'clickRef': {
                    const ref = readStringParam(args, 'ref', { required: true, label: 'ref' });
                    const doubleClick = readBooleanParam(args, 'doubleClick', false);
                    const button = readStringParam(args, 'button') as 'left' | 'right' | 'middle' | undefined;
                    const modifiers = readStringArrayParam(args, 'modifiers') as Array<'Alt' | 'Control' | 'ControlOrMeta' | 'Meta' | 'Shift'> | undefined;
                    try {
                        await BrowserModule.clickViaPlaywright({
                            cdpUrl: currentCdpUrl,
                            targetId: readStringParam(args, 'targetId'),
                            ref,
                            doubleClick,
                            button,
                            modifiers,
                        });
                        return jsonResult({ ref, clicked: true, doubleClick, button, modifiers });
                    } catch (error: any) {
                        return errorResult(`Click failed: ${error.message}`);
                    }
                }

                // Press ref to enter text (enhancement: support for slow verbatim input)
                case 'typeRef': {
                    const ref = readStringParam(args, 'ref', { required: true, label: 'ref' });
                    const text = readStringParam(args, 'text', { required: true, label: 'text' });
                    const submit = readBooleanParam(args, 'submit', false);
                    const slowly = readBooleanParam(args, 'slowly', false);
                    try {
                        await BrowserModule.typeViaPlaywright({
                            cdpUrl: currentCdpUrl,
                            targetId: readStringParam(args, 'targetId'),
                            ref,
                            text,
                            submit,
                            slowly,
                        });
                        return jsonResult({ ref, text, typed: true, submitted: submit, slowly });
                    } catch (error: any) {
                        return errorResult(`Type failed: ${error.message}`);
                    }
                }

                // Hover by ref
                case 'hoverRef': {
                    const ref = readStringParam(args, 'ref', { required: true, label: 'ref' });
                    try {
                        await BrowserModule.hoverViaPlaywright({
                            cdpUrl: currentCdpUrl,
                            targetId: readStringParam(args, 'targetId'),
                            ref,
                        });
                        return jsonResult({ ref, hovered: true });
                    } catch (error: any) {
                        return errorResult(`Hover failed: ${error.message}`);
                    }
                }

                // Drag element by ref
                case 'dragRef': {
                    const startRef = readStringParam(args, 'startRef', { required: true, label: 'startRef' });
                    const endRef = readStringParam(args, 'endRef', { required: true, label: 'endRef' });
                    try {
                        await BrowserModule.dragViaPlaywright({
                            cdpUrl: currentCdpUrl,
                            targetId: readStringParam(args, 'targetId'),
                            startRef,
                            endRef,
                        });
                        return jsonResult({ startRef, endRef, dragged: true });
                    } catch (error: any) {
                        return errorResult(`Drag failed: ${error.message}`);
                    }
                }

                // Key operation
                case 'pressKey': {
                    const key = readStringParam(args, 'key', { required: true, label: 'key' });
                    try {
                        await BrowserModule.pressKeyViaPlaywright({
                            cdpUrl: currentCdpUrl,
                            targetId: readStringParam(args, 'targetId'),
                            key,
                        });
                        return jsonResult({ key, pressed: true });
                    } catch (error: any) {
                        return errorResult(`Key press failed: ${error.message}`);
                    }
                }

                // Press ref to select dropdown option
                case 'selectRef': {
                    const ref = readStringParam(args, 'ref', { required: true, label: 'ref' });
                    const values = readStringArrayParam(args, 'values', { required: true, label: 'values' })!;
                    try {
                        await BrowserModule.selectOptionViaPlaywright({
                            cdpUrl: currentCdpUrl,
                            targetId: readStringParam(args, 'targetId'),
                            ref,
                            values,
                        });
                        return jsonResult({ ref, values, selected: true });
                    } catch (error: any) {
                        return errorResult(`Select failed: ${error.message}`);
                    }
                }

                // Fill out forms in batches
                case 'fillForm': {
                    const rawFields = args.fields;
                    if (!Array.isArray(rawFields) || rawFields.length === 0) {
                        return errorResult('fields parameter is required, format: [{ref: "e1", type: "text", value: "..."}]');
                    }
                    const fields = rawFields.map((f: any) => ({
                        ref: String(f.ref ?? ''),
                        type: String(f.type ?? 'text'),
                        value: f.value ?? '',
                    }));
                    try {
                        await BrowserModule.fillFormViaPlaywright({
                            cdpUrl: currentCdpUrl,
                            targetId: readStringParam(args, 'targetId'),
                            fields,
                        });
                        return jsonResult({ fieldCount: fields.length, filled: true });
                    } catch (error: any) {
                        return errorResult(`Form fill failed: ${error.message}`);
                    }
                }

                // Press ref to scroll the element to the visible area
                case 'scrollRef': {
                    const ref = readStringParam(args, 'ref', { required: true, label: 'ref' });
                    try {
                        await BrowserModule.scrollIntoViewViaPlaywright({
                            cdpUrl: currentCdpUrl,
                            targetId: readStringParam(args, 'targetId'),
                            ref,
                        });
                        return jsonResult({ ref, scrolled: true });
                    } catch (error: any) {
                        return errorResult(`Scroll failed: ${error.message}`);
                    }
                }

                // Upload files
                case 'uploadFiles': {
                    const paths = readStringArrayParam(args, 'paths', { required: true, label: 'paths' })!;
                    const inputRef = readStringParam(args, 'inputRef') || readStringParam(args, 'ref');
                    const element = readStringParam(args, 'element') || readStringParam(args, 'selector');
                    if (!inputRef && !element) {
                        return errorResult('uploadFiles requires inputRef or element/selector parameter to locate the file input');
                    }
                    try {
                        await BrowserModule.setInputFilesViaPlaywright({
                            cdpUrl: currentCdpUrl,
                            targetId: readStringParam(args, 'targetId'),
                            inputRef: inputRef || undefined,
                            element: element || undefined,
                            paths,
                        });
                        return jsonResult({ paths, uploaded: true, inputRef, element });
                    } catch (error: any) {
                        return errorResult(`File upload failed: ${error.message}`);
                    }
                }

                // PDF Export
                case 'pdf': {
                    if (!currentPage) {
                        return errorResult('Not connected to browser, please execute connect first');
                    }
                    const filePath = readStringParam(args, 'filePath') || readStringParam(args, 'path');
                    if (!filePath) {
                        return errorResult('Missing filePath parameter (PDF save path)');
                    }
                    const format = readStringParam(args, 'format') || 'A4';

                    try {
                        // Page.printToPDF using CDP protocol
                        const cdpSession = await currentPage.context().newCDPSession(currentPage);
                        const result = await cdpSession.send('Page.printToPDF', {
                            landscape: false,
                            printBackground: true,
                            paperWidth: format === 'Letter' ? 8.5 : format === 'Legal' ? 8.5 : 8.27,
                            paperHeight: format === 'Letter' ? 11 : format === 'Legal' ? 14 : 11.69,
                            marginTop: 0.4,
                            marginBottom: 0.4,
                            marginLeft: 0.4,
                            marginRight: 0.4,
                        });
                        await cdpSession.detach();

                        // write file
                        const dir = dirname(filePath);
                        if (!existsSync(dir)) {
                            mkdirSync(dir, { recursive: true });
                        }
                        writeFileSync(filePath, Buffer.from(result.data, 'base64'));

                        let url = 'unknown'; try { url = currentPage.url(); } catch { /* ignore */ }
                        return jsonResult({
                            file: filePath,
                            format,
                            url,
                            exported: true,
                        });
                    } catch (error: any) {
                        return errorResult(`PDF export failed: ${error.message}`);
                    }
                }

                // Console log
                case 'console': {
                    const consoleAct = readStringParam(args, 'consoleAction') || 'status';

                    switch (consoleAct) {
                        case 'status': {
                            const entries = [...consoleBuffer];
                            // Statistics by type
                            const counts: Record<string, number> = {};
                            for (const e of entries) {
                                counts[e.type] = (counts[e.type] || 0) + 1;
                            }
                            return jsonResult({
                                entries: entries.slice(-100), // Return at most 100 items
                                total: entries.length,
                                counts,
                                truncated: entries.length > 100,
                            });
                        }
                        case 'clear': {
                            const cleared = consoleBuffer.length;
                            consoleBuffer = [];
                            return jsonResult({ cleared, message: 'Console logs cleared' });
                        }
                        default:
                            return errorResult(`Unknown console action: ${consoleAct}, supported: status/clear`);
                    }
                }

                default:
                    return errorResult(`Unknown action: ${action}`);
            }
        },
    };
}

/**
 * Get browser connection status
 */
export function getBrowserConnectionStatus(): { connected: boolean; cdpUrl: string; mode: string | null } {
    return { connected: !!browserInstance, cdpUrl: currentCdpUrl, mode: browserMode };
}

/**
 * Clean up temporary tabs created by scheduled tasks
 * Called after executeScheduledAgent is completed to avoid tab leakage
 */
export function cleanupScheduledPages(sessionId: string): void {
    const toDelete: string[] = [];
    for (const [key, page] of sessionPages.entries()) {
        if (key.startsWith(`__sched_${sessionId}_`)) {
            if (page && !page.isClosed()) {
                page.close().catch(() => {});
            }
            toDelete.push(key);
        }
    }
    for (const key of toDelete) {
        sessionPages.delete(key);
        navigationHistoryMap.delete(key);
    }
    if (toDelete.length > 0) {
        console.log(`[browser] Cleaned up ${toDelete.length} scheduled task tab(s) for session: ${sessionId}`);
    }
}

/**
 * Gateway automatically detects the Chrome debugging port when it starts (no need for the user to manually click)
 */
export async function initBrowserProbe(): Promise<void> {
    const port = await findChromeDebugPort();
    if (port > 0) {
        currentCdpUrl = `http://127.0.0.1:${port}`;
        browserMode = 'cdp';
        console.log(`[browser] Auto-detected Chrome debug port on startup: ${port}`);
    }
    // Periodically probe the CDP port (only when no browser is connected)
    setInterval(async () => {
        if (browserInstance) return; // Already have a browser connection, skip
        const p = await findChromeDebugPort();
        const hadCdp = browserMode === 'cdp';
        const hasCdp = p > 0;
        if (hasCdp) {
            currentCdpUrl = `http://127.0.0.1:${p}`;
            if (!hadCdp) {
                browserMode = 'cdp';
                console.log('[browser] CDP port detected');
            }
        } else if (hadCdp) {
            browserMode = null;
            console.log('[browser] CDP port lost');
        }
    }, 15000);
}


