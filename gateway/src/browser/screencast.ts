/**
 * CDP screencast: stream a live page into the desktop panel.
 *
 * The panel does not embed a browser engine of its own. It shows JPEG frames
 * that Chrome pushes over CDP from the very page the browser tool drives, so
 * the user and the agent look at the same tab for free — no mirroring, no
 * second session to keep in sync.
 *
 * Three rules this module exists to enforce:
 *  1. Every frame MUST be acknowledged with `Page.screencastFrameAck`. Chrome
 *     silently stops producing frames otherwise, with no error anywhere.
 *  2. Frames are dropped, never queued. A projection only ever wants the
 *     newest image; letting them pile up behind a slow socket turns a laggy
 *     view into an unbounded buffer.
 *  3. Chrome only screencasts while it composites. A window the user cannot
 *     see (covered, minimized, on another desktop) may stop yielding frames
 *     entirely, so a watchdog falls back to explicit screenshots until the
 *     stream resumes. The panel must never sit blank for a reason it cannot
 *     show.
 */

import type { Page } from 'playwright-core';
import { getPageForTargetId } from './session.js';

export interface ScreencastFrameMeta {
    /** CSS-pixel size of the page's visible area, used for input mapping. */
    deviceWidth: number;
    deviceHeight: number;
    pageScaleFactor: number;
    offsetTop: number;
    scrollOffsetX: number;
    scrollOffsetY: number;
    /** Wall-clock time Chrome captured the frame, in ms. */
    timestamp: number;
}

export interface ScreencastFrame {
    /** Base64 JPEG, without a data: prefix. */
    data: string;
    meta: ScreencastFrameMeta;
    /** True when the frame came from the screenshot fallback, not the stream. */
    fallback?: boolean;
}

export interface ScreencastPageState {
    targetId: string | null;
    url: string;
    title: string;
    loading: boolean;
}

export interface ScreencastQuality {
    quality: number;
    maxWidth: number;
    maxHeight: number;
    everyNthFrame: number;
}

/**
 * Frame budgets per transport. The renderer normally reaches the gateway over
 * a local WebSocket; when that fails it falls back to a Tauri IPC bridge,
 * which moves base64 far more slowly, so the projection is coarsened rather
 * than allowed to fall behind.
 */
export const SCREENCAST_PRESETS: Record<'ws' | 'bridge', ScreencastQuality> = {
    ws: { quality: 60, maxWidth: 1280, maxHeight: 900, everyNthFrame: 1 },
    bridge: { quality: 40, maxWidth: 900, maxHeight: 640, everyNthFrame: 2 },
};

/**
 * How long the stream may stay silent before the watchdog starts taking
 * screenshots, and how often it takes them. Screenshots are far dearer than
 * stream frames, so the fallback runs slowly and only while needed.
 */
export const SCREENCAST_STALL_MS = 1500;
export const SCREENCAST_FALLBACK_INTERVAL_MS = 700;

export interface StartScreencastOptions {
    cdpUrl: string;
    targetId?: string;
    quality?: Partial<ScreencastQuality>;
    onFrame(frame: ScreencastFrame): void;
    onState(state: ScreencastPageState): void;
    /** Return true to discard this frame (socket already backed up). */
    shouldDropFrame?(): boolean;
    /** Called when the page goes away under us. */
    onClosed?(reason: string): void;
    /** Disable the screenshot watchdog (tests, or a known-visible window). */
    watchdog?: boolean;
}

/**
 * A pointer or keyboard event replayed into the projected page.
 *
 * These drive a real, logged-in browser, so the shapes are deliberately
 * narrow and every field is re-validated here rather than trusted from the
 * wire. The gateway additionally refuses the message from any client that is
 * not the authenticated desktop window.
 */
export type BrowserInputEvent =
    | {
        kind: 'mouse';
        type: 'mousePressed' | 'mouseReleased' | 'mouseMoved';
        x: number;
        y: number;
        button?: 'left' | 'right' | 'middle' | 'none';
        clickCount?: number;
        modifiers?: number;
    }
    | { kind: 'wheel'; x: number; y: number; deltaX: number; deltaY: number; modifiers?: number }
    | {
        kind: 'key';
        type: 'keyDown' | 'keyUp' | 'char';
        key?: string;
        code?: string;
        text?: string;
        windowsVirtualKeyCode?: number;
        modifiers?: number;
    };

const MOUSE_TYPES = new Set(['mousePressed', 'mouseReleased', 'mouseMoved']);
const MOUSE_BUTTONS = new Set(['left', 'right', 'middle', 'none']);
const KEY_TYPES = new Set(['keyDown', 'keyUp', 'char']);

function finite(value: unknown, fallback = 0): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8. */
function modifierMask(value: unknown): number {
    const mask = Math.trunc(finite(value));
    return mask >= 0 && mask <= 15 ? mask : 0;
}

/**
 * Reject anything that is not a recognised event. Returns null rather than
 * throwing so a malformed message is dropped quietly instead of tearing down
 * the projection.
 */
export function normalizeInputEvent(raw: unknown): BrowserInputEvent | null {
    if (!raw || typeof raw !== 'object') return null;
    const input = raw as Record<string, unknown>;
    const modifiers = modifierMask(input.modifiers);

    if (input.kind === 'mouse') {
        if (typeof input.type !== 'string' || !MOUSE_TYPES.has(input.type)) return null;
        const button = typeof input.button === 'string' && MOUSE_BUTTONS.has(input.button)
            ? input.button as 'left' | 'right' | 'middle' | 'none'
            : 'left';
        return {
            kind: 'mouse',
            type: input.type as 'mousePressed' | 'mouseReleased' | 'mouseMoved',
            x: finite(input.x),
            y: finite(input.y),
            button,
            clickCount: Math.min(3, Math.max(0, Math.trunc(finite(input.clickCount, 1)))),
            modifiers,
        };
    }

    if (input.kind === 'wheel') {
        return {
            kind: 'wheel',
            x: finite(input.x),
            y: finite(input.y),
            deltaX: finite(input.deltaX),
            deltaY: finite(input.deltaY),
            modifiers,
        };
    }

    if (input.kind === 'key') {
        if (typeof input.type !== 'string' || !KEY_TYPES.has(input.type)) return null;
        const text = typeof input.text === 'string' ? input.text.slice(0, 8) : undefined;
        // A char event with nothing to insert would be a no-op at best.
        if (input.type === 'char' && !text) return null;
        return {
            kind: 'key',
            type: input.type as 'keyDown' | 'keyUp' | 'char',
            key: typeof input.key === 'string' ? input.key.slice(0, 32) : undefined,
            code: typeof input.code === 'string' ? input.code.slice(0, 32) : undefined,
            text,
            windowsVirtualKeyCode: Math.trunc(finite(input.windowsVirtualKeyCode)),
            modifiers,
        };
    }

    return null;
}

export interface ScreencastHandle {
    readonly targetId: string | null;
    /** Re-apply frame sizing, e.g. after the panel was resized. */
    retune(quality: Partial<ScreencastQuality>): Promise<void>;
    /** Replay a user gesture into the projected page. */
    dispatchInput(event: BrowserInputEvent): Promise<void>;
    state(): Promise<ScreencastPageState>;
    stop(): Promise<void>;
}

/** A page's CDP target id, or null if the session cannot be opened. */
export async function pageTargetId(page: Page): Promise<string | null> {
    try {
        const session = await page.context().newCDPSession(page);
        const info = await session.send('Target.getTargetInfo');
        await session.detach().catch(() => undefined);
        return (info as { targetInfo?: { targetId?: string } }).targetInfo?.targetId ?? null;
    } catch {
        return null;
    }
}

export async function startScreencast(options: StartScreencastOptions): Promise<ScreencastHandle> {
    const page = await getPageForTargetId({ cdpUrl: options.cdpUrl, targetId: options.targetId });
    return startScreencastOnPage(page, options);
}

/**
 * The projection itself, given an already-resolved page. Split out so the
 * frame-acknowledgement and back-pressure rules above can be tested without a
 * real browser.
 */
export async function startScreencastOnPage(
    page: Page,
    options: Omit<StartScreencastOptions, 'cdpUrl'>,
): Promise<ScreencastHandle> {
    const targetId = options.targetId ?? await pageTargetId(page);
    const cdp = await page.context().newCDPSession(page);

    let quality: ScreencastQuality = { ...SCREENCAST_PRESETS.ws, ...options.quality };
    let stopped = false;
    let lastFrameAt = Date.now();
    let fallbackInFlight = false;
    let watchdog: ReturnType<typeof setInterval> | null = null;

    async function readState(): Promise<ScreencastPageState> {
        return {
            targetId,
            url: page.url(),
            title: await page.title().catch(() => ''),
            loading: false,
        };
    }

    function pushState(loading: boolean): void {
        if (stopped) return;
        void page.title()
            .catch(() => '')
            .then(title => {
                if (stopped) return;
                options.onState({ targetId, url: page.url(), title, loading });
            });
    }

    cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
        // Acknowledge first and unconditionally. Skipping the ack — including
        // on a frame we are about to drop — ends the stream permanently.
        try {
            await cdp.send('Page.screencastFrameAck', { sessionId });
        } catch {
            // The session is going away; the stop path handles cleanup.
            return;
        }

        lastFrameAt = Date.now();
        if (stopped || options.shouldDropFrame?.()) return;

        options.onFrame({
            data,
            meta: {
                deviceWidth: metadata.deviceWidth ?? 0,
                deviceHeight: metadata.deviceHeight ?? 0,
                pageScaleFactor: metadata.pageScaleFactor ?? 1,
                offsetTop: metadata.offsetTop ?? 0,
                scrollOffsetX: metadata.scrollOffsetX ?? 0,
                scrollOffsetY: metadata.scrollOffsetY ?? 0,
                timestamp: metadata.timestamp ?? Date.now() / 1000,
            },
        });
    });

    /**
     * Screenshot fallback for a stalled stream. `Page.captureScreenshot`
     * forces the renderer to produce a frame even when the compositor has
     * been idled by occlusion, so the panel keeps showing the page.
     */
    async function captureFallbackFrame(): Promise<void> {
        if (stopped || fallbackInFlight) return;
        fallbackInFlight = true;
        try {
            const [shot, layout] = await Promise.all([
                cdp.send('Page.captureScreenshot', {
                    format: 'jpeg',
                    quality: quality.quality,
                    optimizeForSpeed: true,
                }) as Promise<{ data?: string }>,
                cdp.send('Page.getLayoutMetrics').catch(() => null) as Promise<{
                    cssVisualViewport?: { clientWidth?: number; clientHeight?: number; pageX?: number; pageY?: number; scale?: number };
                } | null>,
            ]);
            if (stopped || !shot?.data) return;
            // A real frame may have landed while the screenshot was in flight;
            // it is fresher than this, so let it stand.
            if (Date.now() - lastFrameAt < SCREENCAST_STALL_MS) return;
            if (options.shouldDropFrame?.()) return;

            const viewport = layout?.cssVisualViewport;
            options.onFrame({
                data: shot.data,
                fallback: true,
                meta: {
                    deviceWidth: viewport?.clientWidth ?? 0,
                    deviceHeight: viewport?.clientHeight ?? 0,
                    pageScaleFactor: viewport?.scale ?? 1,
                    offsetTop: 0,
                    scrollOffsetX: viewport?.pageX ?? 0,
                    scrollOffsetY: viewport?.pageY ?? 0,
                    timestamp: Date.now() / 1000,
                },
            });
        } catch {
            // A failed screenshot is not worth tearing the projection down
            // over; the next tick tries again.
        } finally {
            fallbackInFlight = false;
        }
    }

    function startWatchdog(): void {
        if (options.watchdog === false || watchdog) return;
        watchdog = setInterval(() => {
            if (stopped) return;
            if (Date.now() - lastFrameAt >= SCREENCAST_STALL_MS) void captureFallbackFrame();
        }, SCREENCAST_FALLBACK_INTERVAL_MS);
        // Never keep the gateway process alive on account of a projection.
        (watchdog as { unref?: () => void }).unref?.();
    }

    function stopWatchdog(): void {
        if (watchdog) clearInterval(watchdog);
        watchdog = null;
    }

    const onNavigated = () => pushState(true);
    const onLoad = () => pushState(false);
    const onClose = () => {
        stopped = true;
        stopWatchdog();
        options.onClosed?.('page_closed');
    };
    page.on('framenavigated', onNavigated);
    page.on('load', onLoad);
    page.on('close', onClose);

    async function start(): Promise<void> {
        await cdp.send('Page.startScreencast', {
            format: 'jpeg',
            quality: quality.quality,
            maxWidth: quality.maxWidth,
            maxHeight: quality.maxHeight,
            everyNthFrame: quality.everyNthFrame,
        });
        lastFrameAt = Date.now();
    }

    await start();
    startWatchdog();
    pushState(false);

    return {
        targetId,

        async retune(next: Partial<ScreencastQuality>): Promise<void> {
            if (stopped) return;
            quality = { ...quality, ...next };
            // Chrome applies sizing at start time only, so restart the stream.
            await cdp.send('Page.stopScreencast').catch(() => undefined);
            await start();
        },

        state: readState,

        async dispatchInput(event: BrowserInputEvent): Promise<void> {
            if (stopped) return;
            if (event.kind === 'mouse') {
                await cdp.send('Input.dispatchMouseEvent', {
                    type: event.type,
                    x: event.x,
                    y: event.y,
                    button: event.button,
                    clickCount: event.clickCount,
                    modifiers: event.modifiers,
                });
                return;
            }
            if (event.kind === 'wheel') {
                await cdp.send('Input.dispatchMouseEvent', {
                    type: 'mouseWheel',
                    x: event.x,
                    y: event.y,
                    deltaX: event.deltaX,
                    deltaY: event.deltaY,
                    modifiers: event.modifiers,
                });
                return;
            }
            await cdp.send('Input.dispatchKeyEvent', {
                type: event.type,
                key: event.key,
                code: event.code,
                text: event.text,
                windowsVirtualKeyCode: event.windowsVirtualKeyCode,
                nativeVirtualKeyCode: event.windowsVirtualKeyCode,
                modifiers: event.modifiers,
            });
        },

        async stop(): Promise<void> {
            if (stopped) return;
            stopped = true;
            stopWatchdog();
            page.off('framenavigated', onNavigated);
            page.off('load', onLoad);
            page.off('close', onClose);
            await cdp.send('Page.stopScreencast').catch(() => undefined);
            await cdp.detach().catch(() => undefined);
        },
    };
}
