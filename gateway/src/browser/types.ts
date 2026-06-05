/**
 * Browser Automation Type Definition
 * Migrated from OpenClaw pw-session.ts
 */

import type { Page, Request, BrowserContext, Browser } from 'playwright-core';

// ============ console/errors/network ============

/** Console messages */
export type BrowserConsoleMessage = {
    type: string;
    text: string;
    timestamp: string;
    location?: { url?: string; lineNumber?: number; columnNumber?: number };
};

/** Page error */
export type BrowserPageError = {
    message: string;
    name?: string;
    stack?: string;
    timestamp: string;
};

/** Network request */
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

// ============ AI Snapshot ============

/** Playwright AI snapshot results */
export type SnapshotForAIResult = {
    full: string;
    incremental?: string;
};

/** Playwright AI snapshot option */
export type SnapshotForAIOptions = {
    timeout?: number;
    track?: string;
};

/** Page with AI snapshot capability */
export type WithSnapshotForAI = {
    _snapshotForAI?: (options?: SnapshotForAIOptions) => Promise<SnapshotForAIResult>;
};

// ============ Target/CDP ============

/** CDP Target message response */
export type TargetInfoResponse = {
    targetInfo?: {
        targetId?: string;
    };
    targetId?: string;
};

/** Connected browser */
export type ConnectedBrowser = {
    browser: Browser;
    cdpUrl: string;
};

// ============ Page status ============

/**
 * Page status
 * Track console, errors, network requests, and role refs
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

/** Role Refs type */
export type RoleRefs = NonNullable<PageState['roleRefs']>;

/** Role Refs cache entries */
export type RoleRefsCacheEntry = {
    refs: RoleRefs;
    frameSelector?: string;
    mode?: NonNullable<PageState['roleRefsMode']>;
};

/** Context status */
export type ContextState = {
    traceActive: boolean;
};

// ============ constant ============

export const MAX_CONSOLE_MESSAGES = 500;
export const MAX_PAGE_ERRORS = 200;
export const MAX_NETWORK_REQUESTS = 500;
export const MAX_ROLE_REFS_CACHE = 50;
