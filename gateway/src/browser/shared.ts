/**
 * 浏览器自动化共享工具
 * 迁移自 OpenClaw pw-tools-core.shared.ts
 */

import { parseRoleRef } from './role-snapshot.js';

// ============ ARM ID 管理 ============

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

// ============ Ref 验证 ============

/**
 * 验证并规范化 ref 参数
 * @param value - 输入值
 * @returns 规范化后的 ref 字符串
 * @throws 如果 ref 为空
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

// ============ 超时规范化 ============

/**
 * 规范化超时时间
 * @param timeoutMs - 用户指定的超时
 * @param fallback - 默认值
 * @returns 规范化后的超时（500ms ~ 120000ms）
 */
export function normalizeTimeoutMs(timeoutMs: number | undefined, fallback: number): number {
    return Math.max(500, Math.min(120_000, timeoutMs ?? fallback));
}

// ============ AI 友好错误 ============

/**
 * 将 Playwright 错误转换为 AI 友好的错误消息
 * @param error - 原始错误
 * @param selector - 相关的选择器/ref
 * @returns AI 友好的 Error
 */
export function toAIFriendlyError(error: unknown, selector: string): Error {
    const message = error instanceof Error ? error.message : String(error);

    // 严格模式冲突（多个元素匹配）
    if (message.includes('strict mode violation')) {
        const countMatch = message.match(/resolved to (\d+) elements/);
        const count = countMatch ? countMatch[1] : 'multiple';
        return new Error(
            `Selector "${selector}" matched ${count} elements. ` +
            `Run a new snapshot to get updated refs, or use a different ref.`
        );
    }

    // 超时/元素不可见
    if (
        (message.includes('Timeout') || message.includes('waiting for')) &&
        (message.includes('to be visible') || message.includes('not visible'))
    ) {
        return new Error(
            `Element "${selector}" not found or not visible. ` +
            `Run a new snapshot to see current page elements.`
        );
    }

    // 元素被遮挡/不可交互
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

// ============ 错误格式化 ============

/**
 * 格式化错误消息
 * @param error - 错误对象
 * @returns 格式化后的错误消息
 */
export function formatErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}
