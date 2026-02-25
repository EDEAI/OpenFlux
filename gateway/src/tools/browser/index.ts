/**
 * 浏览器自动化工具 - CDP 连接模式
 * 基于 playwright-core，连接用户已有浏览器
 */

import type { AnyTool, ToolResult } from '../types';
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
            throw new Error(`playwright-core 加载失败: ${error.message}. 请运行: npm install playwright-core`);
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
let pageInstance: any = null;
let currentCdpUrl: string = DEFAULT_CDP_URL;
let launchedProcess: any = null;

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
 * 检测已运行的 Chrome/Edge 是否带有调试端口
 * 通过 wmic 扫描进程命令行参数
 * @returns 调试端口号，未找到则返回 0
 */
async function findChromeDebugPort(): Promise<number> {
    const { execSync } = await import('child_process');
    try {
        const output = execSync(
            'wmic process where "name=\'chrome.exe\' or name=\'msedge.exe\'" get CommandLine /format:list',
            { encoding: 'utf-8', timeout: 5000 }
        );
        const match = output.match(/--remote-debugging-port=(\d+)/);
        if (match) {
            const port = parseInt(match[1], 10);
            console.log(`[browser] 检测到已有调试端口: ${port}`);
            return port;
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
        const output = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /NH', { encoding: 'utf-8', timeout: 3000 });
        if (output.includes('chrome.exe')) return true;
        const output2 = execSync('tasklist /FI "IMAGENAME eq msedge.exe" /NH', { encoding: 'utf-8', timeout: 3000 });
        return output2.includes('msedge.exe');
    } catch {
        return false;
    }
}

/**
 * 尝试连接或启动 Chrome 调试模式
 * - 如果 Chrome 已运行且带调试端口：返回该端口
 * - 如果 Chrome 已运行但无调试端口：不关闭，返回 false（提示用户）
 * - 如果 Chrome 未运行：自动启动（复用默认配置目录，保留登录状态）
 * @returns true=成功启动/已有调试端口, false=Chrome 在运行但无调试端口
 */
async function launchChromeWithDebugPort(): Promise<boolean> {
    // 1. 先检测已运行的 Chrome 是否有调试端口
    const existingPort = await findChromeDebugPort();
    if (existingPort > 0) {
        currentCdpUrl = `http://127.0.0.1:${existingPort}`;
        console.log(`[browser] 复用已有 Chrome 调试端口: ${currentCdpUrl}`);
        return true;
    }

    // 2. 检测 Chrome 是否在运行（但没有调试端口）
    const running = await isChromeRunning();
    if (running) {
        console.warn('[browser] Chrome/Edge 正在运行但未开启调试端口，无法连接');
        console.warn('[browser] 请关闭 Chrome 后重试，或手动以调试模式启动:');
        console.warn('[browser]   chrome.exe --remote-debugging-port=9222');
        return false;
    }

    // 3. Chrome 未运行，自动启动
    const chromePaths = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
        // Edge 作为备选
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ];

    // 查找 Chrome 路径
    let chromePath: string | null = null;
    for (const p of chromePaths) {
        if (existsSync(p)) {
            chromePath = p;
            break;
        }
    }

    if (!chromePath) {
        console.error('[browser] 未找到 Chrome/Edge 浏览器');
        return false;
    }

    const isEdge = chromePath.toLowerCase().includes('edge');
    console.log(`[browser] 正在启动 ${isEdge ? 'Edge' : 'Chrome'}: ${chromePath}`);

    // 使用用户默认配置目录，保留登录状态和 Cookie
    const localAppData = process.env.LOCALAPPDATA || '';
    const userDataDir = localAppData
        ? isEdge
            ? `${localAppData}\\Microsoft\\Edge\\User Data`
            : `${localAppData}\\Google\\Chrome\\User Data`
        : undefined;

    try {
        const args = [
            `--remote-debugging-port=${CDP_PORT}`,
            '--no-first-run',
            '--no-default-browser-check',
            '--restore-last-session',  // 恢复上次打开的标签页
        ];
        if (userDataDir && existsSync(userDataDir)) {
            args.splice(1, 0, `--user-data-dir=${userDataDir}`);
        }
        launchedProcess = spawn(chromePath, args, {
            detached: true,
            stdio: 'ignore',
        });

        launchedProcess.on('error', (err: Error) => {
            console.error('[browser] 启动浏览器失败:', err.message);
            launchedProcess = null;
        });

        launchedProcess.unref();
    } catch (err) {
        console.error('[browser] spawn 浏览器异常:', err);
        launchedProcess = null;
        return false;
    }

    // 等待浏览器启动
    await new Promise(r => setTimeout(r, 3000));
    return true;
}

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
        description: `浏览器自动化工具（连接用户已有浏览器）。

## 交互策略（必须遵循）
1. **优先：结构化元素操作** — navigate 后自动返回页面可交互元素（带 ref 标识符如 e1, e2），直接用 clickRef/typeRef/selectRef 操作
2. **次选：snapshot 刷新元素列表** — 页面变化后用 snapshot 重新获取元素列表及 ref
3. **再次：evaluate 脚本** — 当需要复杂 DOM 操作时使用页面脚本
4. **最后兜底：screenshot 截图** — 仅当以上方法无法识别目标元素时，才截图分析

## 标准流程
connect → navigate（自动返回可交互元素和 ref）→ clickRef/typeRef 操作 → snapshot（页面变化后刷新）→ 继续操作

⚠️ **禁止**在有 ref 可用时使用 screenshot 截图交互，这会浪费时间和 token。

支持的动作: ${BROWSER_ACTIONS.join(', ')}`,
        parameters: {
            action: {
                type: 'string',
                description: `操作类型: ${BROWSER_ACTIONS.join('/')}`,
                required: true,
                enum: [...BROWSER_ACTIONS],
            },
            url: {
                type: 'string',
                description: '目标 URL（navigate 动作需要）或 CDP URL（connect 动作可选，默认 http://127.0.0.1:9222）',
            },
            selector: {
                type: 'string',
                description: '元素选择器（click/type/wait 动作需要）',
            },
            text: {
                type: 'string',
                description: '输入文本（type/typeRef 动作需要）',
            },
            script: {
                type: 'string',
                description: 'JavaScript 代码（evaluate 动作需要）',
            },
            path: {
                type: 'string',
                description: '截图保存路径（screenshot 动作可选）',
            },
            timeout: {
                type: 'number',
                description: '超时时间（毫秒）',
            },
            fullPage: {
                type: 'boolean',
                description: '是否全页面截图',
                default: false,
            },
            targetId: {
                type: 'string',
                description: '标签页 ID（可选，用于操作特定标签页）',
            },
            // OpenClaw 增强参数
            ref: {
                type: 'string',
                description: '元素 ref 标识符（如 e1, e2），来自 snapshot 动作返回。用于 clickRef/typeRef/hoverRef/selectRef/scrollRef/screenshot',
            },
            interactive: {
                type: 'boolean',
                description: 'snapshot 动作：是否只返回可交互元素（推荐用于操作场景，减少输出量）',
                default: false,
            },
            refsMode: {
                type: 'string',
                description: 'snapshot 动作：ref 生成模式。role=基于 ariaSnapshot（默认，稳定）；aria=基于 _snapshotForAI（Playwright 原生 ref，跨调用更稳定）',
                enum: ['role', 'aria'],
            },
            compact: {
                type: 'boolean',
                description: 'snapshot 动作：是否精简输出（移除无名结构元素和空分支，减少 token）',
                default: false,
            },
            maxDepth: {
                type: 'number',
                description: 'snapshot 动作：最大深度限制（0=仅根元素，默认不限）',
            },
            snapshotSelector: {
                type: 'string',
                description: 'snapshot 动作：CSS 选择器，限定快照范围到特定元素',
            },
            frame: {
                type: 'string',
                description: 'snapshot 动作：iframe 选择器，对嵌入的 iframe 取快照',
            },
            submit: {
                type: 'boolean',
                description: 'typeRef 动作：输入后是否按回车提交',
                default: false,
            },
            slowly: {
                type: 'boolean',
                description: 'typeRef 动作：是否逐字慢速输入（模拟人类打字，每字约75ms延迟）',
                default: false,
            },
            doubleClick: {
                type: 'boolean',
                description: 'clickRef 动作：是否双击',
                default: false,
            },
            button: {
                type: 'string',
                description: 'clickRef 动作：鼠标按键 left/right/middle',
            },
            modifiers: {
                type: 'array',
                description: 'clickRef 动作：修饰键数组，可选值: Control, Shift, Alt, Meta',
                items: { type: 'string' },
            },
            key: {
                type: 'string',
                description: 'pressKey 动作：按键名称，如 Enter, Escape, Tab, ArrowDown, Control+c, Control+a 等',
            },
            startRef: {
                type: 'string',
                description: 'dragRef 动作：拖拽起始元素 ref',
            },
            endRef: {
                type: 'string',
                description: 'dragRef 动作：拖拽目标元素 ref',
            },
            values: {
                type: 'array',
                description: 'selectRef 动作：下拉选项值数组',
                items: { type: 'string' },
            },
            fields: {
                type: 'array',
                description: 'fillForm 动作：表单字段数组，每项 {ref: "e1", type: "text|checkbox|radio", value: "..."}',
                items: { type: 'object' },
            },
            paths: {
                type: 'array',
                description: 'uploadFiles 动作：要上传的文件路径数组',
                items: { type: 'string' },
            },
            inputRef: {
                type: 'string',
                description: 'uploadFiles 动作：文件输入框的 ref（与 selector 二选一）',
            },
            element: {
                type: 'string',
                description: 'screenshot/uploadFiles 动作：CSS 选择器定位元素',
            },
            tabIndex: {
                type: 'number',
                description: 'tabSwitch/tabClose 动作：标签页索引（从 0 开始，来自 tabs 动作返回）',
            },
            dialogAction: {
                type: 'string',
                description: 'dialog 动作：弹窗处理方式 accept/dismiss/status',
            },
            promptText: {
                type: 'string',
                description: 'dialog 动作：prompt 弹窗的输入文本',
            },
            filePath: {
                type: 'string',
                description: 'pdf 动作：PDF 保存路径',
            },
            format: {
                type: 'string',
                description: 'pdf 动作：纸张格式（A4/Letter/Legal，默认 A4）',
            },
            consoleAction: {
                type: 'string',
                description: 'console 动作：status(获取日志)/clear(清空)',
            },
        },

        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
            const action = validateAction(args, BROWSER_ACTIONS);
            const actionTimeout = readNumberParam(args, 'timeout', { integer: true }) || timeout;

            switch (action) {
                // 获取浏览器状态
                case 'status': {
                    return jsonResult({
                        connected: !!browserInstance,
                        hasPage: !!pageInstance,
                        cdpUrl: currentCdpUrl,
                        url: pageInstance ? await pageInstance.url().catch(() => null) : null,
                        title: pageInstance ? await pageInstance.title().catch(() => null) : null,
                    });
                }

                // 连接到用户浏览器（自动启动 Chrome）
                case 'connect': {
                    if (browserInstance) {
                        return jsonResult({ message: '已连接到浏览器', connected: true, cdpUrl: currentCdpUrl });
                    }
                    const targetCdpUrl = readStringParam(args, 'url') || currentCdpUrl;

                    // 尝试连接的辅助函数
                    const tryConnect = async () => {
                        console.log(`[browser] 正在连接到 ${targetCdpUrl}...`);
                        browserInstance = await (await getChromium()).connectOverCDP(targetCdpUrl, {
                            timeout: 5000,
                        });
                        currentCdpUrl = targetCdpUrl;

                        // 获取第一个页面
                        const contexts = browserInstance.contexts();
                        if (contexts.length > 0) {
                            const pages = contexts[0].pages();
                            if (pages.length > 0) {
                                pageInstance = pages[0];
                            }
                        }

                        // 如果没有页面，创建一个新的
                        if (!pageInstance) {
                            const context = contexts[0] || await browserInstance.newContext();
                            pageInstance = await context.newPage();
                        }

                        const tabCount = contexts.flatMap((c: any) => c.pages()).length;
                        console.log(`[browser] 已连接，共 ${tabCount} 个标签页`);

                        // 注册 dialog 事件监听器
                        if (pageInstance) {
                            pageInstance.on('dialog', (dialog: any) => {
                                pendingDialog = {
                                    type: dialog.type(),
                                    message: dialog.message(),
                                    defaultValue: dialog.defaultValue?.() || undefined,
                                    dialog,
                                };
                                console.log(`[browser] 检测到弹窗: ${dialog.type()} - ${dialog.message()}`);
                            });

                            // 注册 console 事件监听器
                            pageInstance.on('console', (msg: any) => {
                                consoleBuffer.push({
                                    type: msg.type(),
                                    text: msg.text(),
                                    timestamp: new Date().toISOString(),
                                });
                                // 限制缓存大小
                                if (consoleBuffer.length > 500) consoleBuffer.splice(0, consoleBuffer.length - 300);
                            });
                        }

                        return tabCount;
                    };

                    // 第一次尝试连接
                    try {
                        const tabCount = await tryConnect();
                        return jsonResult({
                            message: '已连接到浏览器',
                            connected: true,
                            cdpUrl: targetCdpUrl,
                            tabCount,
                        });
                    } catch (firstError: any) {
                        console.log('[browser] 首次连接失败，尝试自动启动 Chrome...');

                        // 自动启动 Chrome
                        const launched = await launchChromeWithDebugPort();
                        if (!launched) {
                            const isRunning = await isChromeRunning();
                            if (isRunning) {
                                return errorResult(
                                    'Chrome 正在运行但未开启调试端口，无法接管控制。\n' +
                                    '解决方法（二选一）：\n' +
                                    '1. 关闭所有 Chrome 窗口后重试（Agent 会自动以调试模式启动，保留你的登录状态）\n' +
                                    '2. 手动以调试模式启动 Chrome: chrome.exe --remote-debugging-port=9222'
                                );
                            }
                            return errorResult('未找到 Chrome 浏览器，请手动安装 Chrome');
                        }

                        // 再次尝试连接
                        try {
                            const tabCount = await tryConnect();
                            return jsonResult({
                                message: '已自动启动 Chrome 并连接',
                                connected: true,
                                cdpUrl: targetCdpUrl,
                                tabCount,
                                autoLaunched: true,
                            });
                        } catch (secondError: any) {
                            console.error('[browser] 二次连接失败:', secondError);
                            return errorResult(`连接浏览器失败: ${secondError.message}`);
                        }
                    }
                }

                // 断开连接（不关闭用户浏览器）
                case 'disconnect': {
                    if (!browserInstance) {
                        return jsonResult({ message: '未连接到浏览器', connected: false });
                    }
                    // 只断开 CDP 连接，不调用 close() 避免关闭用户浏览器
                    browserInstance = null;
                    pageInstance = null;
                    return jsonResult({ message: '已断开连接（浏览器保持运行）', connected: false });
                }

                // 列出所有标签页
                case 'tabs': {
                    if (!browserInstance) {
                        return errorResult('未连接到浏览器，请先执行 connect 动作');
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
                        return errorResult(`获取标签页失败: ${error.message}`);
                    }
                }

                // 打开新标签页
                case 'tabOpen': {
                    if (!browserInstance) {
                        return errorResult('未连接到浏览器，请先执行 connect 动作');
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
                        pageInstance = newPage;
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
                        return errorResult(`打开标签页失败: ${error.message}`);
                    }
                }

                // 切换标签页
                case 'tabSwitch': {
                    if (!browserInstance) {
                        return errorResult('未连接到浏览器，请先执行 connect 动作');
                    }
                    try {
                        const tabIndex = readNumberParam(args, 'tabIndex');
                        if (tabIndex === undefined) {
                            return errorResult('缺少 tabIndex 参数，请先使用 tabs 动作获取标签页列表');
                        }
                        const allPages: any[] = [];
                        for (const ctx of browserInstance.contexts()) {
                            allPages.push(...ctx.pages());
                        }
                        if (tabIndex < 0 || tabIndex >= allPages.length) {
                            return errorResult(`标签页索引 ${tabIndex} 超出范围，当前共 ${allPages.length} 个标签页`);
                        }
                        pageInstance = allPages[tabIndex];
                        await pageInstance.bringToFront();
                        // 重新注册 dialog 监听
                        pageInstance.on('dialog', (dialog: any) => {
                            pendingDialog = {
                                type: dialog.type(),
                                message: dialog.message(),
                                defaultValue: dialog.defaultValue?.() || undefined,
                                dialog,
                            };
                        });
                        const title = await pageInstance.title().catch(() => '');
                        const url = pageInstance.url();
                        return jsonResult({ switched: true, tabIndex, title, url });
                    } catch (error: any) {
                        return errorResult(`切换标签页失败: ${error.message}`);
                    }
                }

                // 关闭标签页
                case 'tabClose': {
                    if (!browserInstance) {
                        return errorResult('未连接到浏览器，请先执行 connect 动作');
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
                                return errorResult(`标签页索引 ${tabIndex} 超出范围`);
                            }
                            targetPage = allPages[tabIndex];
                        } else {
                            // 未指定索引，关闭当前标签页
                            targetPage = pageInstance;
                        }
                        if (!targetPage) {
                            return errorResult('无可关闭的标签页');
                        }
                        // 防止关闭最后一个标签页导致 Chrome 退出
                        if (allPages.length <= 1) {
                            return errorResult('无法关闭最后一个标签页（会导致浏览器退出）。如需导航到其他页面，请使用 navigate 动作');
                        }
                        const closedUrl = targetPage.url();
                        await targetPage.close();
                        // 如果关闭的是当前页面，切换到第一个可用页面
                        if (targetPage === pageInstance) {
                            const remaining: any[] = [];
                            for (const ctx of browserInstance.contexts()) {
                                remaining.push(...ctx.pages());
                            }
                            pageInstance = remaining.length > 0 ? remaining[0] : null;
                        }
                        return jsonResult({ closed: true, closedUrl, remaining: allPages.length - 1 });
                    } catch (error: any) {
                        return errorResult(`关闭标签页失败: ${error.message}`);
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
                                return errorResult('当前没有弹窗');
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
                                return errorResult('当前没有弹窗');
                            }
                            await pendingDialog.dialog.dismiss();
                            const info = { type: pendingDialog.type, message: pendingDialog.message };
                            pendingDialog = null;
                            return jsonResult({ dismissed: true, ...info });
                        }
                        default:
                            return errorResult(`未知 dialog 操作: ${dialogAction}，支持: status/accept/dismiss`);
                    }
                }

                // 导航到 URL
                case 'navigate': {
                    if (!browserInstance) {
                        // 自动尝试连接
                        try {
                            console.log(`[browser] 自动连接到 ${currentCdpUrl}...`);
                            browserInstance = await (await getChromium()).connectOverCDP(currentCdpUrl, {
                                timeout: actionTimeout,
                            });
                            const contexts = browserInstance.contexts();
                            if (contexts.length > 0 && contexts[0].pages().length > 0) {
                                pageInstance = contexts[0].pages()[0];
                            } else {
                                const context = contexts[0] || await browserInstance.newContext();
                                pageInstance = await context.newPage();
                            }
                        } catch (error: any) {
                            return errorResult(`连接浏览器失败: ${error.message}。请确保 Chrome 以调试模式启动: chrome.exe --remote-debugging-port=9222`);
                        }
                    }
                    if (!pageInstance) {
                        return errorResult('无可用页面');
                    }
                    const url = readStringParam(args, 'url', { required: true, label: 'url' });
                    try {
                        await pageInstance.goto(url, { timeout: actionTimeout });
                        const title = await pageInstance.title();

                        // 提取页面关键信息供 LLM 分析
                        const pageInfo = await pageInstance.evaluate(() => {
                            const getMeta = (name: string) => {
                                const el = document.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
                                return el?.getAttribute('content') || '';
                            };

                            const getHeadings = (tag: string, limit: number) => {
                                return Array.from(document.querySelectorAll(tag))
                                    .slice(0, limit)
                                    .map(el => (el as HTMLElement).textContent?.trim().substring(0, 100))
                                    .filter(Boolean);
                            };

                            // 提取主要文本内容
                            const getMainText = () => {
                                const clone = document.body.cloneNode(true) as HTMLElement;
                                clone.querySelectorAll('script, style, nav, header, footer, aside').forEach(el => el.remove());
                                return clone.textContent?.replace(/\s+/g, ' ').trim().substring(0, 2000) || '';
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
                        });

                        // 导航成功后自动获取 snapshot（可交互元素列表）
                        let snapshot: { snapshot?: string; stats?: unknown } | null = null;
                        try {
                            snapshot = await BrowserModule.snapshotRoleViaPlaywright({
                                cdpUrl: currentCdpUrl,
                                targetId: readStringParam(args, 'targetId'),
                                options: { interactive: true, compact: true },
                            });
                        } catch (e: any) {
                            console.warn('[browser] navigate 后自动 snapshot 失败:', e.message);
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
                                hint: '页面可交互元素已列出（带 ref 标识符如 e1, e2），请优先使用 clickRef/typeRef 操作，避免截图识别。',
                            } : {}),
                        });
                    } catch (error: any) {
                        return errorResult(`导航失败: ${error.message}`);
                    }
                }

                // 截图（增强：支持 ref/element 定位截取特定元素）
                case 'screenshot': {
                    if (!pageInstance) {
                        return errorResult('未连接到浏览器，请先执行 connect 动作');
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
                        const buffer = await pageInstance.screenshot({
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
                        return errorResult(`截图失败: ${error.message}`);
                    }
                }

                // 点击元素
                case 'click': {
                    if (!pageInstance) {
                        return errorResult('未连接到浏览器，请先执行 connect 动作');
                    }
                    const selector = readStringParam(args, 'selector', { required: true, label: 'selector' });
                    try {
                        await pageInstance.click(selector, { timeout: actionTimeout });
                        return jsonResult({ selector, clicked: true });
                    } catch (error: any) {
                        return errorResult(`点击失败: ${error.message}。建议改用 snapshot 获取元素 ref，然后用 clickRef 操作。`);
                    }
                }

                // 输入文本
                case 'type': {
                    if (!pageInstance) {
                        return errorResult('未连接到浏览器，请先执行 connect 动作');
                    }
                    const selector = readStringParam(args, 'selector', { required: true, label: 'selector' });
                    const text = readStringParam(args, 'text', { required: true, label: 'text' });
                    try {
                        await pageInstance.fill(selector, text, { timeout: actionTimeout });
                        return jsonResult({ selector, text, typed: true });
                    } catch (error: any) {
                        return errorResult(`输入失败: ${error.message}`);
                    }
                }

                // 执行 JavaScript
                case 'evaluate': {
                    if (!pageInstance) {
                        return errorResult('未连接到浏览器，请先执行 connect 动作');
                    }
                    const script = readStringParam(args, 'script', { required: true, label: 'script' });
                    try {
                        // 如果脚本包含 return 语句，自动包裹到箭头函数中
                        // 避免 page.evaluate 中裸 return 导致 SyntaxError: Illegal return
                        const wrappedScript = /\breturn\b/.test(script)
                            ? `(() => { ${script} })()`
                            : script;
                        const result = await pageInstance.evaluate(wrappedScript);
                        return jsonResult({ result });
                    } catch (error: any) {
                        return errorResult(`执行脚本失败: ${error.message}。提示：脚本应为表达式（如 document.title）或自执行函数，不要使用裸 return。`);
                    }
                }

                // 等待
                case 'wait': {
                    if (!pageInstance) {
                        return errorResult('未连接到浏览器，请先执行 connect 动作');
                    }
                    const selector = readStringParam(args, 'selector');
                    const waitTime = readNumberParam(args, 'timeout', { integer: true }) || 1000;
                    try {
                        if (selector) {
                            await pageInstance.waitForSelector(selector, { timeout: actionTimeout });
                            return jsonResult({ selector, waited: true });
                        } else {
                            await new Promise((r) => setTimeout(r, waitTime));
                            return jsonResult({ waited: waitTime });
                        }
                    } catch (error: any) {
                        return errorResult(`等待失败: ${error.message}`);
                    }
                }

                // 获取页面内容
                case 'content': {
                    if (!pageInstance) {
                        return errorResult('未连接到浏览器，请先执行 connect 动作');
                    }
                    try {
                        const content = await pageInstance.content();
                        const title = await pageInstance.title();
                        const url = pageInstance.url();
                        return jsonResult({
                            url,
                            title,
                            contentLength: content.length,
                            content: content.slice(0, 10000),
                        });
                    } catch (error: any) {
                        return errorResult(`获取内容失败: ${error.message}`);
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
                        const result = await BrowserModule.snapshotRoleViaPlaywright({
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
                        return jsonResult({
                            snapshot: result.snapshot,
                            stats: result.stats,
                            refsMode: refsMode || 'role',
                            usage: '使用 ref（如 e1, e2）配合 clickRef/typeRef 动作操作元素',
                        });
                    } catch (error: any) {
                        return errorResult(`获取快照失败: ${error.message}`);
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
                        return errorResult(`点击失败: ${error.message}`);
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
                        return errorResult(`输入失败: ${error.message}`);
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
                        return errorResult(`悬停失败: ${error.message}`);
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
                        return errorResult(`拖拽失败: ${error.message}`);
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
                        return errorResult(`按键失败: ${error.message}`);
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
                        return errorResult(`选择失败: ${error.message}`);
                    }
                }

                // 批量填充表单
                case 'fillForm': {
                    const rawFields = args.fields;
                    if (!Array.isArray(rawFields) || rawFields.length === 0) {
                        return errorResult('fields 参数必填，格式: [{ref: "e1", type: "text", value: "..."}]');
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
                        return errorResult(`填表失败: ${error.message}`);
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
                        return errorResult(`滚动失败: ${error.message}`);
                    }
                }

                // 上传文件
                case 'uploadFiles': {
                    const paths = readStringArrayParam(args, 'paths', { required: true, label: 'paths' })!;
                    const inputRef = readStringParam(args, 'inputRef') || readStringParam(args, 'ref');
                    const element = readStringParam(args, 'element') || readStringParam(args, 'selector');
                    if (!inputRef && !element) {
                        return errorResult('uploadFiles 需要 inputRef 或 element/selector 参数定位文件输入框');
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
                        return errorResult(`上传文件失败: ${error.message}`);
                    }
                }

                // PDF 导出
                case 'pdf': {
                    if (!pageInstance) {
                        return errorResult('未连接浏览器，请先执行 connect');
                    }
                    const filePath = readStringParam(args, 'filePath') || readStringParam(args, 'path');
                    if (!filePath) {
                        return errorResult('缺少 filePath 参数（PDF 保存路径）');
                    }
                    const format = readStringParam(args, 'format') || 'A4';

                    try {
                        // 使用 CDP 协议的 Page.printToPDF
                        const cdpSession = await pageInstance.context().newCDPSession(pageInstance);
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

                        const url = await pageInstance.url().catch(() => 'unknown');
                        return jsonResult({
                            file: filePath,
                            format,
                            url,
                            exported: true,
                        });
                    } catch (error: any) {
                        return errorResult(`PDF 导出失败: ${error.message}`);
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
                            return jsonResult({ cleared, message: '控制台日志已清空' });
                        }
                        default:
                            return errorResult(`未知 console 操作: ${consoleAct}，支持: status/clear`);
                    }
                }

                default:
                    return errorResult(`未知动作: ${action}`);
            }
        },
    };
}
