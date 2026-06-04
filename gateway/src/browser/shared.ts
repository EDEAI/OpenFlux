/**
 * Browser automation sharing tool
 * Migrated from OpenClaw pw-tools-core.shared.ts
 */

import { parseRoleRef } from './role-snapshot.js';

// ============ ARM ID Management ============

let nextUploadArmId = 0;
let nextDialogArmId = 0;
let nextDownloadArmId = 0;

export function bumpUploadArmId(): number {
    nextUploadArmId += 1;
    return nextUploadArmId;
}

export function bumpDialogArmId(): number {
    nextDialogArmId += 1;
    return nextDialogArmId;
}

export function bumpDownloadArmId(): number {
    nextDownloadArmId += 1;
    return nextDownloadArmId;
}

// ============ Ref verification ============

/**
 * Validate and normalize ref parameters
 * @param value - input value
 * @returns normalized ref string
 * @throws if ref is empty
 */
export function requireRef(value: unknown): string {
    const raw = typeof value === 'string' ? value.trim() : '';
    const roleRef = raw ? parseRoleRef(raw) : null;
    const ref = roleRef ?? (raw.startsWith('@') ? raw.slice(1) : raw);
    if (!ref) {
        throw new Error('ref is required');
    }
    return ref;
}

// ============ Timeout normalization ============

/**
 * Normalized timeout
 * @param timeoutMs - User specified timeout
 * @param fallback - default
 * @returns normalized timeout (500ms ~ 120000ms)
 */
export function normalizeTimeoutMs(timeoutMs: number | undefined, fallback: number): number {
    return Math.max(500, Math.min(120_000, timeoutMs ?? fallback));
}

// ============ AI friendly bugs ============

/**
 * Convert Playwright errors into AI-friendly error messages
 * @param error - original error
 * @param selector - related selectors/ref
 * @returns AI friendly Error
 */
export function toAIFriendlyError(error: unknown, selector: string): Error {
    const message = error instanceof Error ? error.message : String(error);

    // Strict mode conflict (multiple elements match)
    if (message.includes('strict mode violation')) {
        const countMatch = message.match(/resolved to (\d+) elements/);
        const count = countMatch ? countMatch[1] : 'multiple';
        return new Error(
            `Selector "${selector}" matched ${count} elements. ` +
            `Run a new snapshot to get updated refs, or use a different ref.`
        );
    }

    // Timeout/Element not visible
    if (
        (message.includes('Timeout') || message.includes('waiting for')) &&
        (message.includes('to be visible') || message.includes('not visible'))
    ) {
        return new Error(
            `Element "${selector}" not found or not visible. ` +
            `Run a new snapshot to see current page elements.`
        );
    }

    // Element is obscured/not interactive
    if (
        message.includes('intercepts pointer events') ||
        message.includes('not visible') ||
        message.includes('not receive pointer events')
    ) {
        return new Error(
            `Element "${selector}" is not interactable (hidden or covered). ` +
            `Try scrolling it into view, closing overlays, or re-snapshotting.`
        );
    }

    return error instanceof Error ? error : new Error(message);
}

// ============ Error formatting ============

/**
 * Format error message
 * @param error - error object
 * @returns error message after formatting
 */
export function formatErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}
