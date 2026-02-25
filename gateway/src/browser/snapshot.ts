/**
 * 页面快照功能
 * 迁移自 OpenClaw pw-tools-core.snapshot.ts
 * 
 * 生成 ARIA 角色快照供 LLM 理解页面结构
 */

import type { Page } from 'playwright-core';
import {
    buildRoleSnapshotFromAiSnapshot,
    buildRoleSnapshotFromAriaSnapshot,
    getRoleSnapshotStats,
    type RoleRefMap,
    type RoleSnapshotOptions,
} from './role-snapshot.js';
import {
    ensurePageState,
    getPageForTargetId,
    storeRoleRefsForTarget,
    type WithSnapshotForAI,
} from './session.js';
import { normalizeTimeoutMs } from './shared.js';

// ============ 类型定义 ============

export type AriaSnapshotNode = {
    nodeId: string;
    role: string;
    name?: string;
    children?: AriaSnapshotNode[];
};

// ============ ARIA 快照 ============

/**
 * 通过 CDP 获取 ARIA 树
 */
export async function snapshotAriaViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    limit?: number;
}): Promise<{ nodes: AriaSnapshotNode[] }> {
    const limit = Math.max(1, Math.min(2000, Math.floor(opts.limit ?? 500)));
    const page = await getPageForTargetId({
        cdpUrl: opts.cdpUrl,
        targetId: opts.targetId,
    });
    ensurePageState(page);

    const session = await page.context().newCDPSession(page);
    try {
        await session.send('Accessibility.enable').catch(() => { });
        const res = (await session.send('Accessibility.getFullAXTree')) as {
            nodes?: Array<{
                nodeId: string;
                role?: { value: string };
                name?: { value: string };
                childIds?: string[];
            }>;
        };
        const rawNodes = Array.isArray(res?.nodes) ? res.nodes : [];

        // 简单转换为 AriaSnapshotNode 格式
        const nodes: AriaSnapshotNode[] = rawNodes.slice(0, limit).map((n) => ({
            nodeId: n.nodeId,
            role: n.role?.value ?? 'unknown',
            name: n.name?.value,
        }));

        return { nodes };
    } finally {
        await session.detach().catch(() => { });
    }
}

/**
 * 通过 Playwright AI 快照获取（如可用）
 */
export async function snapshotAiViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    timeoutMs?: number;
    maxChars?: number;
}): Promise<{ snapshot: string; truncated?: boolean; refs: RoleRefMap }> {
    const page = await getPageForTargetId({
        cdpUrl: opts.cdpUrl,
        targetId: opts.targetId,
    });
    ensurePageState(page);

    const maybe = page as unknown as WithSnapshotForAI;
    if (!maybe._snapshotForAI) {
        throw new Error('Playwright _snapshotForAI is not available. Upgrade playwright-core.');
    }

    const result = await maybe._snapshotForAI({
        timeout: normalizeTimeoutMs(opts.timeoutMs, 5000),
        track: 'response',
    });

    let snapshot = String(result?.full ?? '');
    const maxChars = opts.maxChars;
    const limit =
        typeof maxChars === 'number' && Number.isFinite(maxChars) && maxChars > 0
            ? Math.floor(maxChars)
            : undefined;
    let truncated = false;

    if (limit && snapshot.length > limit) {
        snapshot = `${snapshot.slice(0, limit)}\n\n[...TRUNCATED - page too large]`;
        truncated = true;
    }

    const built = buildRoleSnapshotFromAiSnapshot(snapshot);
    storeRoleRefsForTarget({
        page,
        cdpUrl: opts.cdpUrl,
        targetId: opts.targetId,
        refs: built.refs,
        mode: 'aria',
    });

    return truncated ? { snapshot, truncated, refs: built.refs } : { snapshot, refs: built.refs };
}

/**
 * 通过 Playwright ariaSnapshot 获取角色快照
 */
export async function snapshotRoleViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    selector?: string;
    frameSelector?: string;
    refsMode?: 'role' | 'aria';
    options?: RoleSnapshotOptions;
}): Promise<{
    snapshot: string;
    refs: Record<string, { role: string; name?: string; nth?: number }>;
    stats: { lines: number; chars: number; refs: number; interactive: number };
}> {
    const page = await getPageForTargetId({
        cdpUrl: opts.cdpUrl,
        targetId: opts.targetId,
    });
    ensurePageState(page);

    // 如果请求 aria 模式且支持 AI 快照
    if (opts.refsMode === 'aria') {
        if (opts.selector?.trim() || opts.frameSelector?.trim()) {
            throw new Error('refs=aria does not support selector/frame snapshots yet.');
        }
        const maybe = page as unknown as WithSnapshotForAI;
        if (!maybe._snapshotForAI) {
            throw new Error('refs=aria requires Playwright _snapshotForAI support.');
        }
        const result = await maybe._snapshotForAI({
            timeout: 5000,
            track: 'response',
        });
        const built = buildRoleSnapshotFromAiSnapshot(String(result?.full ?? ''), opts.options);
        storeRoleRefsForTarget({
            page,
            cdpUrl: opts.cdpUrl,
            targetId: opts.targetId,
            refs: built.refs,
            mode: 'aria',
        });
        return {
            snapshot: built.snapshot,
            refs: built.refs,
            stats: getRoleSnapshotStats(built.snapshot, built.refs),
        };
    }

    // 使用 Playwright ariaSnapshot() API
    const frameSelector = opts.frameSelector?.trim() || '';
    const selector = opts.selector?.trim() || '';
    const locator = frameSelector
        ? selector
            ? page.frameLocator(frameSelector).locator(selector)
            : page.frameLocator(frameSelector).locator(':root')
        : selector
            ? page.locator(selector)
            : page.locator(':root');

    const ariaSnapshot = await locator.ariaSnapshot();
    const built = buildRoleSnapshotFromAriaSnapshot(String(ariaSnapshot ?? ''), opts.options);

    storeRoleRefsForTarget({
        page,
        cdpUrl: opts.cdpUrl,
        targetId: opts.targetId,
        refs: built.refs,
        frameSelector: frameSelector || undefined,
        mode: 'role',
    });

    return {
        snapshot: built.snapshot,
        refs: built.refs,
        stats: getRoleSnapshotStats(built.snapshot, built.refs),
    };
}

// ============ 导航 ============

/**
 * 导航到 URL
 */
export async function navigateViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    url: string;
    timeoutMs?: number;
}): Promise<{ url: string }> {
    const url = String(opts.url ?? '').trim();
    if (!url) {
        throw new Error('url is required');
    }
    const page = await getPageForTargetId(opts);
    ensurePageState(page);
    await page.goto(url, {
        timeout: normalizeTimeoutMs(opts.timeoutMs, 20_000),
    });
    return { url: page.url() };
}

// ============ 视口 ============

/**
 * 调整视口大小
 */
export async function resizeViewportViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
    width: number;
    height: number;
}): Promise<void> {
    const page = await getPageForTargetId(opts);
    ensurePageState(page);
    await page.setViewportSize({
        width: Math.max(1, Math.floor(opts.width)),
        height: Math.max(1, Math.floor(opts.height)),
    });
}

// ============ 关闭页面 ============

/**
 * 关闭当前页面
 */
export async function closePageViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
}): Promise<void> {
    const page = await getPageForTargetId(opts);
    ensurePageState(page);
    await page.close();
}

// ============ 导出 PDF ============

/**
 * 导出页面为 PDF
 */
export async function pdfViaPlaywright(opts: {
    cdpUrl: string;
    targetId?: string;
}): Promise<{ buffer: Buffer }> {
    const page = await getPageForTargetId(opts);
    ensurePageState(page);
    const buffer = await page.pdf({ printBackground: true });
    return { buffer };
}
