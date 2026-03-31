/**
 * 浏览器自动化工具 - CDP 连接模式
 * 基于 playwright-core，连接用户已有浏览器
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
import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

// 导入迁移自 OpenClaw 的浏览器模块
import * as BrowserModule from '../../browser/index.js';

// 动态加载 playwright-core
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

// 支持的动作（参考 Clawdbot 设计 + OpenClaw 增强）
const BROWSER_ACTIONS = [
    'status',     // 获取浏览器状态
    'connect',    // 连接到用户浏览器
    'disconnect', // 断开连接
    'tabs',       // 列出所有标签页
    'tabOpen',    // 打开新标签页
    'tabSwitch',  // 切换标签页
    'tabClose',   // 关闭标签页
    'navigate',   // 导航到 URL
    'screenshot', // 截图（支持 ref/element 定位）
    'click',      // 点击元素（CSS 选择器）
    'type',       // 输入文本（CSS 选择器）
    'evaluate',   // 执行 JavaScript
    'wait',       // 等待
    'content',    // 获取页面内容
    'dialog',     // 处理弹窗（alert/confirm/prompt）
    // OpenClaw 增强动作
    'snapshot',   // 获取 ARIA 角色快照（LLM 可读）
    'clickRef',   // 按 ref 点击元素（支持右键/双击/修饰键）
    'typeRef',    // 按 ref 输入文本（支持慢速逐字输入）
    'hoverRef',   // 按 ref 悬停
    'dragRef',    // 按 ref 拖拽元素（startRef → endRef）
    'pressKey',   // 按键（Enter/Escape/Tab/Ctrl+C 等）
    'selectRef',  // 按 ref 选择下拉选项
    'fillForm',   // 批量填充表单字段
    'scrollRef',  // 按 ref 滚动元素到可视区域
    'uploadFiles',// 上传文件到 input 元素
    'pdf',        // 导出当前页面为 PDF
    'console',    // 获取/清空控制台日志
] as const;

type BrowserAction = (typeof BROWSER_ACTIONS)[number];

// 默认 CDP 端口
const DEFAULT_CDP_URL = 'http://127.0.0.1:9222';
const CDP_PORT = 9222;

export interface BrowserToolOptions {
    /** CDP 连接 URL */
    cdpUrl?: string;
    /** 默认超时时间（毫秒） */
    timeout?: number;
    /** 自动启动 Chrome（如果未运行） */
    autoLaunch?: boolean;
}

// 浏览器连接状态
let browserInstance: any = null;
let pageInstance: any = null;  // 默认 page（无 sessionId 时使用）
let currentCdpUrl: string = DEFAULT_CDP_URL;
/** 当前浏览器连接模式：'cdp'=通过 CDP 连接用户 Chrome, 'playwright'=Playwright 启动的独立浏览器, null=未连接 */
let browserMode: 'cdp' | 'playwright' | null = null;

// Per-session 页面映射：不同 session 操控不同的标签页
const sessionPages = new Map<string, any>();

// 获取当前 session 应使用的 page
function getPageForSession(sessionId?: string): any {
    if (sessionId && sessionPages.has(sessionId)) {
        return sessionPages.get(sessionId);
    }
    return pageInstance;
}

// 设置当前 session 的 page
function setPageForSession(page: any, sessionId?: string): void {
    if (sessionId) {
        sessionPages.set(sessionId, page);
    }
    pageInstance = page;
}

// Dialog 弹窗状态
let pendingDialog: { type: string; message: string; defaultValue?: string; dialog: any } | null = null;

// Console 日志缓存
interface ConsoleEntry {
    type: string;
    text: string;
    timestamp: string;
}
let consoleBuffer: ConsoleEntry[] = [];

/**
 * TCP 端口存活检测（HTTP GET /json/version, 2 秒超时）
 */
async function isPortListening(port: number, host = '127.0.0.1'): Promise<boolean> {
    const http = await import('http');
    return new Promise((resolve) => {
        const url = `http://${host}:${port}/json/version`;
        const req = http.get(url, { timeout: 2000 }, (res) => {
            res.resume();
            console.log(`[browser] Port check ${port}: HTTP ${res.statusCode}`);
            resolve(res.statusCode === 200);
        });
        req.on('error', (err) => {
            console.log(`[browser] Port check ${port}: ${err.message}`);
            resolve(false);
        });
        req.on('timeout', () => {
            console.log(`[browser] Port check ${port}: timeout`);
            req.destroy();
            resolve(false);
        });
    });
}

/**
 * 检测已运行的 Chrome/Edge 是否带有调试端口（wmic + TCP 验证）
 * @returns 已验证可连接的调试端口号，不可用则返回 0
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
            // TCP 验证端口是否真正可连接
            const alive = await isPortListening(port);
            if (alive) {
                console.log(`[browser] Detected existing debug port: ${port} (verified)`);
                return port;
            } else {
                console.log(`[browser] Detected debug port ${port} in process args but port not responding`);
                return 0;
            }
        }
    } catch {
        // wmic 失败，忽略
    }
    return 0;
}

/**
 * 检测 Chrome/Edge 是否正在运行
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
 * 清理浏览器状态（浏览器关闭/断开 时调用）
 */
function resetBrowserState(): void {
    browserInstance = null;
    pageInstance = null;
    sessionPages.clear();
    browserMode = null;
    console.log('[browser] Browser state reset');
}

/**
 * 确保浏览器可用（统一的连接/启动入口）
 * 优先级：已有连接 > CDP 连接用户 Chrome > Playwright 启动独立浏览器
 * @returns true=浏览器就绪, false=启动失败
 */
export async function ensureBrowser(sessionId?: string): Promise<boolean> {
    // 已有可用的 browserInstance
    if (browserInstance) {
        // 确保有 page
        if (!getPageForSession(sessionId)) {
            try {
                const contexts = browserInstance.contexts();
                const page = contexts.length > 0 && contexts[0].pages().length > 0
                    ? contexts[0].pages()[0]
                    : await (contexts[0] || await browserInstance.newContext()).newPage();
                pageInstance = page;
                setPageForSession(page, sessionId);
            } catch {
                // browserInstance 可能已失效，清理后继续
                resetBrowserState();
            }
        }
        if (browserInstance) return true;
    }

    // Step 1: 尝试 CDP 连接用户 Chrome
    const existingPort = await findChromeDebugPort();
    if (existingPort > 0) {
        try {
            const cdpUrl = `http://127.0.0.1:${existingPort}`;
            console.log(`[browser] Connecting via CDP: ${cdpUrl}`);
            browserInstance = await (await getChromium()).connectOverCDP(cdpUrl, { timeout: 5000 });
            currentCdpUrl = cdpUrl;
            browserMode = 'cdp';
            // 获取/创建 page
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

    // Step 1.5: Chrome 正在运行但没有调试端口 → 关闭后以 debug 模式重启
    const chromeRunning = await isChromeRunning();
    if (chromeRunning) {
        console.log('[browser] Chrome running without debug port, restarting with --remote-debugging-port=9222...');
        const { execSync } = await import('child_process');
        try {
            // 关闭所有 Chrome 进程
            execSync('taskkill /F /IM chrome.exe /T', { timeout: 5000, windowsHide: true, stdio: 'ignore' });
            // 等待进程完全退出
            await new Promise(r => setTimeout(r, 2000));
        } catch { /* Chrome 可能已退出 */ }

        // 查找 Chrome 路径
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
            console.log(`[browser] Launching Chrome with debug port: ${chromePath}`);
            spawn(chromePath, ['--remote-debugging-port=9222', '--no-first-run', '--no-default-browser-check'], {
                detached: true,
                stdio: 'ignore',
            }).unref();

            // 等待 CDP 端口就绪（最多 8 秒）
            for (let i = 0; i < 16; i++) {
                await new Promise(r => setTimeout(r, 500));
                if (await isPortListening(CDP_PORT)) {
                    console.log(`[browser] Debug port ${CDP_PORT} ready after ${(i + 1) * 500}ms`);
                    break;
                }
            }

            // 尝试 CDP 连接
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
                    console.log('[browser] CDP connected after Chrome restart, mode=cdp');
                    return true;
                } catch (e: any) {
                    console.warn(`[browser] CDP connect after restart failed: ${e.message}`);
                    resetBrowserState();
                }
            } else {
                console.warn('[browser] Debug port not ready after Chrome restart');
            }
        }
    }

    // Step 2: Playwright 启动独立 Chromium
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

        // 监听浏览器关闭事件，自动清理状态
        browserInstance.on('disconnected', () => {
            console.log('[browser] Playwright browser disconnected');
            resetBrowserState();
        });

        // 获取/创建 page
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

/** 为 page 注册 dialog / console 监听器 */
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

// 保留向后兼容
export const launchChromeWithDebugPort = ensureBrowser;

/**
 * 创建浏览器自动化工具（CDP 连接模式）
 */
export function createBrowserTool(opts: BrowserToolOptions = {}): AnyTool {
    const {
        cdpUrl = DEFAULT_CDP_URL,
        timeout = 30000,
    } = opts;

    currentCdpUrl = cdpUrl;

    return {
        name: 'browser',
        description: `Browser automation tool (connects to user's existing browser).

## Interaction Strategy (must follow)
1. **Preferred: Structured element operations** — After navigate, interactive elements with ref identifiers (e.g., e1, e2) are automatically returned. Use clickRef/typeRef/selectRef directly.
2. **Alternative: snapshot to refresh element list** — After page changes, use snapshot to get updated element list and refs.
3. **Fallback: evaluate script** — Use page scripts for complex DOM operations.
4. **Last resort: screenshot** — Only take screenshots when the above methods cannot identify the target element.

## Standard Flow
connect → navigate (auto-returns interactive elements with refs) → clickRef/typeRef operations → snapshot (refresh after page changes) → continue

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
            // OpenClaw 增强参数
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
            // 根据 sessionId 获取当前 session 的 page
            let currentPage = getPageForSession(sessionId);

            switch (action) {
                // 获取浏览器状态
                case 'status': {
                    return jsonResult({
                        connected: !!browserInstance,
                        hasPage: !!currentPage,
                        cdpUrl: currentCdpUrl,
                        url: currentPage ? (() => { try { return currentPage!.url(); } catch { return null; } })() : null,
                        title: currentPage ? await currentPage.title().catch(() => null) : null,
                    });
                }

                // 连接到用户浏览器（自动启动 Chrome）
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

                // 断开连接
                case 'disconnect': {
                    if (!browserInstance) {
                        return jsonResult({ message: 'Not connected to browser', connected: false });
                    }
                    const wasMode = browserMode;
                    // Playwright 模式：关闭浏览器释放资源；CDP 模式：仅断开不关闭用户浏览器
                    if (wasMode === 'playwright') {
                        try { await browserInstance.close(); } catch { /* ignore */ }
                    }
                    resetBrowserState();
                    return jsonResult({ message: wasMode === 'playwright' ? 'Playwright browser closed' : 'Disconnected (browser keeps running)', connected: false });
                }

                // 列出所有标签页
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

                // 打开新标签页
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
                        // 切换到新标签页
                        currentPage = newPage;
                        setPageForSession(currentPage, sessionId);
                        // 注册 dialog 监听
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

                // 切换标签页
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
                        setPageForSession(currentPage, sessionId);
                        await currentPage.bringToFront();
                        // 重新注册 dialog 监听
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

                // 关闭标签页
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
                            // 未指定索引，关闭当前标签页
                            targetPage = currentPage;
                        }
                        if (!targetPage) {
                            return errorResult('No tab to close');
                        }
                        // 防止关闭最后一个标签页导致 Chrome 退出
                        if (allPages.length <= 1) {
                            return errorResult('Cannot close the last tab (it would cause the browser to exit). Use navigate action to go to another page.');
                        }
                        const closedUrl = targetPage.url();
                        await targetPage.close();
                        // 如果关闭的是当前页面，切换到第一个可用页面
                        if (targetPage === currentPage) {
                            const remaining: any[] = [];
                            for (const ctx of browserInstance.contexts()) {
                                remaining.push(...ctx.pages());
                            }
                            currentPage = remaining.length > 0 ? remaining[0] : null;
                            setPageForSession(currentPage, sessionId);
                        }
                        return jsonResult({ closed: true, closedUrl, remaining: allPages.length - 1 });
                    } catch (error: any) {
                        return errorResult(`Failed to close tab: ${error.message}`);
                    }
                }

                // 处理弹窗（alert/confirm/prompt）
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

                // 导航到 URL
                case 'navigate': {
                    if (!browserInstance) {
                        const ok = await ensureBrowser(sessionId);
                        if (!ok) {
                            return errorResult('Browser launch failed. Please try again or manually launch Chrome with: chrome.exe --remote-debugging-port=9222');
                        }
                    }
                    if (!currentPage) {
                        return errorResult('No available page');
                    }
                    const url = readStringParam(args, 'url', { required: true, label: 'url' });
                    try {
                        await currentPage.goto(url, { timeout: actionTimeout });
                        const title = await currentPage.title();

                        // 提取页面关键信息供 LLM 分析
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

                        // 导航成功后自动获取 snapshot（可交互元素列表）
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
                            title,
                            navigated: true,
                            // 只保留关键 meta 信息，去掉 mainText 减少 token
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
                        console.error(`[browser] Navigate failed: ${error.message}`, { url });
                        return errorResult(`Navigation failed: ${error.message}`);
                    }
                }

                // 截图（增强：支持 ref/element 定位截取特定元素）
                case 'screenshot': {
                    if (!currentPage) {
                        return errorResult('Not connected to browser, please execute connect action first');
                    }
                    const path = readStringParam(args, 'path');
                    const fullPage = readBooleanParam(args, 'fullPage', false);
                    const screenshotRef = readStringParam(args, 'ref');
                    const screenshotElement = readStringParam(args, 'element');
                    try {
                        // 优先使用 BrowserModule 的增强截图（支持 ref/element）
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

                // 点击元素
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

                // 输入文本
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

                // 执行 JavaScript
                case 'evaluate': {
                    if (!currentPage) {
                        return errorResult('Not connected to browser, please execute connect action first');
                    }
                    const script = readStringParam(args, 'script', { required: true, label: 'script' });
                    try {
                        // 如果脚本包含 return 语句，自动包裹到箭头函数中
                        // 避免 page.evaluate 中裸 return 导致 SyntaxError: Illegal return
                        const wrappedScript = /\breturn\b/.test(script)
                            ? `(() => { ${script} })()`
                            : script;
                        const result = await currentPage.evaluate(wrappedScript);
                        return jsonResult({ result });
                    } catch (error: any) {
                        return errorResult(`Script execution failed: ${error.message}. Tip: Script should be an expression (e.g., document.title) or IIFE, do not use bare return.`);
                    }
                }

                // 等待
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

                // 获取页面内容
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

                // ========== OpenClaw 增强动作 ==========

                // 获取 ARIA 角色快照（LLM 可读）
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
                            // CDP 模式：使用 BrowserModule 完整 snapshot（含 ref 标识符）
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
                            // Playwright launch 模式：使用 Accessibility API
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

                // 按 ref 点击元素（增强：支持右键/双击/修饰键）
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

                // 按 ref 输入文本（增强：支持慢速逐字输入）
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

                // 按 ref 悬停
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

                // 按 ref 拖拽元素
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

                // 按键操作
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

                // 按 ref 选择下拉选项
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

                // 批量填充表单
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

                // 按 ref 滚动元素到可视区域
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

                // 上传文件
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

                // PDF 导出
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
                        // 使用 CDP 协议的 Page.printToPDF
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

                        // 写入文件
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

                // Console 日志
                case 'console': {
                    const consoleAct = readStringParam(args, 'consoleAction') || 'status';

                    switch (consoleAct) {
                        case 'status': {
                            const entries = [...consoleBuffer];
                            // 按类型统计
                            const counts: Record<string, number> = {};
                            for (const e of entries) {
                                counts[e.type] = (counts[e.type] || 0) + 1;
                            }
                            return jsonResult({
                                entries: entries.slice(-100), // 最多返回 100 条
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
 * 获取浏览器连接状态
 */
export function getBrowserConnectionStatus(): { connected: boolean; cdpUrl: string; mode: string | null } {
    return { connected: !!browserInstance, cdpUrl: currentCdpUrl, mode: browserMode };
}

/**
 * Gateway 启动时自动探测 Chrome 调试端口（无需用户手动点击）
 */
export async function initBrowserProbe(): Promise<void> {
    const port = await findChromeDebugPort();
    if (port > 0) {
        currentCdpUrl = `http://127.0.0.1:${port}`;
        browserMode = 'cdp';
        console.log(`[browser] Auto-detected Chrome debug port on startup: ${port}`);
    }
    // 定期探测 CDP 端口（仅在无浏览器连接时）
    setInterval(async () => {
        if (browserInstance) return; // 已有浏览器连接，跳过
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


