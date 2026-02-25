/**
 * 浏览器自动化类型定义
 * 迁移自 OpenClaw pw-session.ts
 */

import type { Page, Request, BrowserContext, Browser } from 'playwright-core';

// ============ 控制台/错误/网络 ============

/** 控制台消息 */
export type BrowserConsoleMessage = {
    type: string;
    text: string;
    timestamp: string;
    location?: { url?: string; lineNumber?: number; columnNumber?: number };
};

/** 页面错误 */
export type BrowserPageError = {
    message: string;
    name?: string;
    stack?: string;
    timestamp: string;
};

/** 网络请求 */
export type BrowserNetworkRequest = {
    id: string;
    timestamp: string;
    method: string;
    url: string;
    resourceType?: string;
    status?: number;
    ok?: boolean;
    failureText?: string;
};

// ============ AI 快照 ============

/** Playwright AI 快照结果 */
export type SnapshotForAIResult = {
    full: string;
    incremental?: string;
};

/** Playwright AI 快照选项 */
export type SnapshotForAIOptions = {
    timeout?: number;
    track?: string;
};

/** 带 AI 快照能力的 Page */
export type WithSnapshotForAI = {
    _snapshotForAI?: (options?: SnapshotForAIOptions) => Promise<SnapshotForAIResult>;
};

// ============ Target/CDP ============

/** CDP Target 信息响应 */
export type TargetInfoResponse = {
    targetInfo?: {
        targetId?: string;
    };
    targetId?: string;
};

/** 连接的浏览器 */
export type ConnectedBrowser = {
    browser: Browser;
    cdpUrl: string;
};

// ============ 页面状态 ============

/**
 * 页面状态
 * 跟踪控制台、错误、网络请求和 role refs
 */
export type PageState = {
    console: BrowserConsoleMessage[];
    errors: BrowserPageError[];
    requests: BrowserNetworkRequest[];
    requestIds: WeakMap<Request, string>;
    nextRequestId: number;
    armIdUpload: number;
    armIdDialog: number;
    armIdDownload: number;
    /**
     * Role-based refs from the last role snapshot (e.g. e1/e2).
     * Mode "role" refs are generated from ariaSnapshot and resolved via getByRole.
     * Mode "aria" refs are Playwright aria-ref ids and resolved via `aria-ref=...`.
     */
    roleRefs?: Record<string, { role: string; name?: string; nth?: number }>;
    roleRefsMode?: 'role' | 'aria';
    roleRefsFrameSelector?: string;
};

/** Role Refs 类型 */
export type RoleRefs = NonNullable<PageState['roleRefs']>;

/** Role Refs 缓存条目 */
export type RoleRefsCacheEntry = {
    refs: RoleRefs;
    frameSelector?: string;
    mode?: NonNullable<PageState['roleRefsMode']>;
};

/** Context 状态 */
export type ContextState = {
    traceActive: boolean;
};

// ============ 常量 ============

export const MAX_CONSOLE_MESSAGES = 500;
export const MAX_PAGE_ERRORS = 200;
export const MAX_NETWORK_REQUESTS = 500;
export const MAX_ROLE_REFS_CACHE = 50;
