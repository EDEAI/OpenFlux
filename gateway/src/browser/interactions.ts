/**
 * Browser interoperability
 * Migrated from OpenClaw pw-tools-core.interactions.ts
 * 
 * All operations support ref positioning
 */

import type { Page } from 'playwright-core';
import {
    ensurePageState,
    getPageForTargetId,
    refLocator,
    restoreRoleRefsForTarget,
} from './session.js';
import { normalizeTimeoutMs, requireRef, toAIFriendlyError } from './shared.js';

// ============ type definition ============

export type BrowserFormField = {
    ref: string;
    type: string;
    value: string | number | boolean;
};

// ============ Highlight ============

export async function highlightViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    ref: string;
}): Promise<void> {
    const page = await getPageForTargetId(opts);
    ensurePageState(page);
    restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });
    const ref = requireRef(opts.ref);
    try {
        await refLocator(page, ref).highlight();
    } catch (err) {
        throw toAIFriendlyError(err, ref);
    }
}

// ============ Click ============

export async function clickViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    ref: string;
    doubleClick?: boolean;
    button?: 'left' | 'right' | 'middle';
    modifiers?: Array<'Alt' | 'Control' | 'ControlOrMeta' | 'Meta' | 'Shift'>;
    timeoutMs?: number;
}): Promise<void> {
    const page = await getPageForTargetId({
        cdpUrl: opts.cdpUrl,
        targetId: opts.targetId,
    });
    ensurePageState(page);
    restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });
    const ref = requireRef(opts.ref);
    const locator = refLocator(page, ref);
    const timeout = normalizeTimeoutMs(opts.timeoutMs, 8000);
    try {
        if (opts.doubleClick) {
            await locator.dblclick({
                timeout,
                button: opts.button,
                modifiers: opts.modifiers,
            });
        } else {
            await locator.click({
                timeout,
                button: opts.button,
                modifiers: opts.modifiers,
            });
        }
    } catch (err) {
        throw toAIFriendlyError(err, ref);
    }
}

// ============ hover ============

export async function hoverViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    ref: string;
    timeoutMs?: number;
}): Promise<void> {
    const ref = requireRef(opts.ref);
    const page = await getPageForTargetId(opts);
    ensurePageState(page);
    restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });
    try {
        await refLocator(page, ref).hover({
            timeout: normalizeTimeoutMs(opts.timeoutMs, 8000),
        });
    } catch (err) {
        throw toAIFriendlyError(err, ref);
    }
}

// ============ drag ============

export async function dragViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    startRef: string;
    endRef: string;
    timeoutMs?: number;
}): Promise<void> {
    const startRef = requireRef(opts.startRef);
    const endRef = requireRef(opts.endRef);
    if (!startRef || !endRef) {
        throw new Error('startRef and endRef are required');
    }
    const page = await getPageForTargetId(opts);
    ensurePageState(page);
    restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });
    try {
        await refLocator(page, startRef).dragTo(refLocator(page, endRef), {
            timeout: normalizeTimeoutMs(opts.timeoutMs, 8000),
        });
    } catch (err) {
        throw toAIFriendlyError(err, `${startRef} -> ${endRef}`);
    }
}

// ============ choose ============

export async function selectOptionViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    ref: string;
    values: string[];
    timeoutMs?: number;
}): Promise<void> {
    const ref = requireRef(opts.ref);
    if (!opts.values?.length) {
        throw new Error('values are required');
    }
    const page = await getPageForTargetId(opts);
    ensurePageState(page);
    restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });
    try {
        await refLocator(page, ref).selectOption(opts.values, {
            timeout: normalizeTimeoutMs(opts.timeoutMs, 8000),
        });
    } catch (err) {
        throw toAIFriendlyError(err, ref);
    }
}

// ============ button ============

export async function pressKeyViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    key: string;
    delayMs?: number;
}): Promise<void> {
    const key = String(opts.key ?? '').trim();
    if (!key) {
        throw new Error('key is required');
    }
    const page = await getPageForTargetId(opts);
    ensurePageState(page);
    await page.keyboard.press(key, {
        delay: Math.max(0, Math.floor(opts.delayMs ?? 0)),
    });
}

// ============ enter ============

export async function typeViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    ref: string;
    text: string;
    submit?: boolean;
    slowly?: boolean;
    timeoutMs?: number;
}): Promise<void> {
    const text = String(opts.text ?? '');
    const page = await getPageForTargetId(opts);
    ensurePageState(page);
    restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });
    const ref = requireRef(opts.ref);
    const locator = refLocator(page, ref);
    const timeout = normalizeTimeoutMs(opts.timeoutMs, 8000);
    try {
        if (opts.slowly) {
            await locator.click({ timeout });
            await locator.type(text, { timeout, delay: 75 });
        } else {
            await locator.fill(text, { timeout });
        }
        if (opts.submit) {
            await locator.press('Enter', { timeout });
        }
    } catch (err) {
        throw toAIFriendlyError(err, ref);
    }
}

// ============ form filling ============

export async function fillFormViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    fields: BrowserFormField[];
    timeoutMs?: number;
}): Promise<void> {
    const page = await getPageForTargetId(opts);
    ensurePageState(page);
    restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });
    const timeout = normalizeTimeoutMs(opts.timeoutMs, 8000);

    for (const field of opts.fields) {
        const ref = field.ref.trim();
        const type = field.type.trim();
        const rawValue = field.value;
        const value =
            typeof rawValue === 'string'
                ? rawValue
                : typeof rawValue === 'number' || typeof rawValue === 'boolean'
                    ? String(rawValue)
                    : '';
        if (!ref || !type) {
            continue;
        }
        const locator = refLocator(page, ref);

        if (type === 'checkbox' || type === 'radio') {
            const checked =
                rawValue === true || rawValue === 1 || rawValue === '1' || rawValue === 'true';
            try {
                await locator.setChecked(checked, { timeout });
            } catch (err) {
                throw toAIFriendlyError(err, ref);
            }
            continue;
        }

        try {
            await locator.fill(value, { timeout });
        } catch (err) {
            throw toAIFriendlyError(err, ref);
        }
    }
}

// ============ Execute JavaScript ============

export async function evaluateViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    fn: string;
    ref?: string;
}): Promise<unknown> {
    const fnText = String(opts.fn ?? '').trim();
    if (!fnText) {
        throw new Error('function is required');
    }
    const page = await getPageForTargetId(opts);
    ensurePageState(page);
    restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });

    if (opts.ref) {
        const locator = refLocator(page, opts.ref);
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const elementEvaluator = new Function(
            'el',
            'fnBody',
            `
            "use strict";
            try {
                var candidate = eval("(" + fnBody + ")");
                return typeof candidate === "function" ? candidate(el) : candidate;
            } catch (err) {
                throw new Error("Invalid evaluate function: " + (err && err.message ? err.message : String(err)));
            }
            `,
        ) as (el: Element, fnBody: string) => unknown;
        return await locator.evaluate(elementEvaluator, fnText);
    }

    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const browserEvaluator = new Function(
        'fnBody',
        `
        "use strict";
        try {
            var candidate = eval("(" + fnBody + ")");
            return typeof candidate === "function" ? candidate() : candidate;
        } catch (err) {
            throw new Error("Invalid evaluate function: " + (err && err.message ? err.message : String(err)));
        }
        `,
    ) as (fnBody: string) => unknown;
    return await page.evaluate(browserEvaluator, fnText);
}

// ============ scroll ============

export async function scrollIntoViewViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    ref: string;
    timeoutMs?: number;
}): Promise<void> {
    const page = await getPageForTargetId(opts);
    ensurePageState(page);
    restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });
    const timeout = normalizeTimeoutMs(opts.timeoutMs, 20_000);

    const ref = requireRef(opts.ref);
    const locator = refLocator(page, ref);
    try {
        await locator.scrollIntoViewIfNeeded({ timeout });
    } catch (err) {
        throw toAIFriendlyError(err, ref);
    }
}

// ============ wait ============

export async function waitForViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    timeMs?: number;
    text?: string;
    textGone?: string;
    selector?: string;
    url?: string;
    loadState?: 'load' | 'domcontentloaded' | 'networkidle';
    fn?: string;
    timeoutMs?: number;
}): Promise<void> {
    const page = await getPageForTargetId(opts);
    ensurePageState(page);
    const timeout = normalizeTimeoutMs(opts.timeoutMs, 20_000);

    // Wait for fixed time
    if (typeof opts.timeMs === 'number' && Number.isFinite(opts.timeMs)) {
        await page.waitForTimeout(Math.max(0, opts.timeMs));
    }

    // Wait for text to appear
    if (opts.text) {
        await page.getByText(opts.text).first().waitFor({
            state: 'visible',
            timeout,
        });
    }

    // Wait for the text to disappear
    if (opts.textGone) {
        await page.getByText(opts.textGone).first().waitFor({
            state: 'hidden',
            timeout,
        });
    }

    // Wait for selector
    if (opts.selector) {
        const selector = String(opts.selector).trim();
        if (selector) {
            await page.locator(selector).first().waitFor({ state: 'visible', timeout });
        }
    }

    // Waiting for URL
    if (opts.url) {
        const url = String(opts.url).trim();
        if (url) {
            await page.waitForURL(url, { timeout });
        }
    }

    // Waiting for loading status
    if (opts.loadState) {
        await page.waitForLoadState(opts.loadState, { timeout });
    }

    // Wait for custom function
    if (opts.fn) {
        const fn = String(opts.fn).trim();
        if (fn) {
            await page.waitForFunction(fn, { timeout });
        }
    }
}

// ============ screenshot ============

export async function takeScreenshotViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    ref?: string;
    element?: string;
    fullPage?: boolean;
    type?: 'png' | 'jpeg';
}): Promise<{ buffer: Buffer }> {
    const page = await getPageForTargetId(opts);
    ensurePageState(page);
    restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });
    const type = opts.type ?? 'png';

    if (opts.ref) {
        if (opts.fullPage) {
            throw new Error('fullPage is not supported for element screenshots');
        }
        const locator = refLocator(page, opts.ref);
        const buffer = await locator.screenshot({ type });
        return { buffer };
    }

    if (opts.element) {
        if (opts.fullPage) {
            throw new Error('fullPage is not supported for element screenshots');
        }
        const locator = page.locator(opts.element).first();
        const buffer = await locator.screenshot({ type });
        return { buffer };
    }

    const buffer = await page.screenshot({
        type,
        fullPage: Boolean(opts.fullPage),
    });
    return { buffer };
}

// ============ File upload ============

export async function setInputFilesViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    inputRef?: string;
    element?: string;
    paths: string[];
}): Promise<void> {
    const page = await getPageForTargetId(opts);
    ensurePageState(page);
    restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });

    if (!opts.paths.length) {
        throw new Error('paths are required');
    }
    const inputRef = typeof opts.inputRef === 'string' ? opts.inputRef.trim() : '';
    const element = typeof opts.element === 'string' ? opts.element.trim() : '';

    if (inputRef && element) {
        throw new Error('inputRef and element are mutually exclusive');
    }
    if (!inputRef && !element) {
        throw new Error('inputRef or element is required');
    }

    const locator = inputRef ? refLocator(page, inputRef) : page.locator(element).first();

    try {
        await locator.setInputFiles(opts.paths);
    } catch (err) {
        throw toAIFriendlyError(err, inputRef || element);
    }

    // Trigger event (required by some websites)
    try {
        const handle = await locator.elementHandle();
        if (handle) {
            await handle.evaluate((el) => {
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            });
        }
    } catch {
        // neglect
    }
}
