/**
 * The panel's browser tab: a real web page, embedded.
 *
 * Each tab owns a native child webview (Tauri `Window::add_child`) that the
 * Rust side keeps positioned over this pane's stage element. The page is laid
 * out at the panel's actual size — no scaling — and lives inside the OpenFlux
 * window, so there is no separate browser window to lose or close by
 * accident.
 *
 * Two consequences shape this file:
 *  - A native webview paints above all HTML. It is hidden whenever anything
 *    should appear over it: another tab is active, the panel is collapsed, or
 *    a menu is open (see overlay-signal).
 *  - The webview outlives this controller across a session switch. Panes are
 *    *suspended* then, not closed, and the same pane id comes back later, so
 *    the webview is merely hidden and re-adopted instead of recreated.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { t } from '../i18n/index';
import { onOverlayChange, isOverlayOpen } from './overlay-signal';
import { PANE_TITLE_CHANGED_EVENT, type PaneContentProvider, type PaneUnmountReason } from './pane-manager';
import type { PaneState } from './pane-types';
import { BrowserCursor } from './browser-cursor';
import { ICON_BROWSER } from './pane-icons';
import { resolveBrowserSessionRoute } from './browser-session-routing';
import {
    clampedGaussian, describeKey, jitterPoint, keyHoldMs, planScrollTicks, scrollTickDelayMs, shouldTypo,
    thinkDelayMs, typingDelayMs, typoFor,
    type KeyDescriptor, type ThinkKind,
} from './browser-human-input';
import type { GatewayClient, GatewayMessage } from '../gateway-client';
// Shared with the gateway tool so hit-testing sees the same tree (shadow roots, same-origin frames).
import { withDeepDom } from '../../gateway/src/browser/deep-dom';

export interface BrowserPaneOptions {
    /** The live gateway connection, or null while it is down. */
    client?: () => GatewayClient | null;
    /** Conversation whose panel layout is currently mounted. */
    session?: () => string | null;
}

/**
 * Every mounted browser tab, keyed by its webview label. The agent bridge
 * enumerates and targets tabs through this — it is the current session's set
 * of browser tabs, because the panel itself is per-session.
 */
const controllersByLabel = new Map<string, BrowserPaneController>();

interface NavigationPayload {
    label: string;
    url: string;
    /** 'start' when navigation begins, 'finished' once the page loaded. */
    kind: 'start' | 'finished';
}

/** `browser-view:download` from Rust: a tab started or finished saving a file. */
interface DownloadPayload {
    label: string;
    url: string;
    path: string;
    kind: 'started' | 'finished';
    success: boolean;
}

/** One download of a tab, as the agent's `downloads` action reports it. */
export interface DownloadRecord {
    url: string;
    path: string;
    name: string;
    state: 'in_progress' | 'completed' | 'failed';
    startedAt: number;
    finishedAt?: number;
}

const MAX_DOWNLOADS = 50;

interface CreateResult {
    created: boolean;
    url: string;
}

interface Bounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

const URL_KEY_PREFIX = 'openflux-browser-pane-url:';
const DEFAULT_URL = 'about:blank';
const IS_MAC = /Mac/i.test(navigator.platform);
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Multiplier on every human pause (think time, key cadence, scroll notches).
 * 1 = realistic. Set `localStorage['openflux-browser-pace'] = '0'` in the
 * app's devtools to make the agent instant while debugging a page.
 */
const HUMAN_PACE = (() => {
    try {
        const raw = localStorage.getItem('openflux-browser-pace');
        const n = raw === null ? 1 : Number(raw);
        return Number.isFinite(n) && n >= 0 ? n : 1;
    } catch {
        return 1;
    }
})();

/** Which kind of hesitation precedes each act. */
const THINK_KIND: Record<string, ThinkKind> = {
    click: 'click', double_click: 'click', right_click: 'click',
    hover: 'key', move: 'key', drag: 'drag', scroll: 'scroll', type: 'type', key: 'key',
};

async function think(kind: ThinkKind): Promise<void> {
    if (HUMAN_PACE <= 0) return;
    await sleep(Math.round(thinkDelayMs(kind) * HUMAN_PACE));
}

/** A human-scale pause, scaled by the configured pace (0 = none). */
async function pause(ms: number): Promise<void> {
    if (HUMAN_PACE <= 0) return;
    await sleep(Math.round(ms * HUMAN_PACE));
}

/** The point to act on: jittered inside the box when one is known, else exact. */
function pickPoint(x: unknown, y: unknown, w: unknown, h: unknown): { x: number; y: number } {
    const cx = Number(x) || 0;
    const cy = Number(y) || 0;
    const bw = Number(w);
    const bh = Number(h);
    if (HUMAN_PACE <= 0 || !Number.isFinite(bw) || !Number.isFinite(bh)) return { x: cx, y: cy };
    return jitterPoint(cx, cy, bw, bh);
}

/** Tauri webview labels: letters, digits, `-`, `/`, `:`, `_`. Pane ids fit. */
function labelFor(paneId: string): string {
    return `bv-${paneId}`;
}

function storedUrl(paneId: string): string | null {
    try {
        return localStorage.getItem(URL_KEY_PREFIX + paneId);
    } catch {
        return null;
    }
}

const DOWNLOADS_KEY_PREFIX = 'openflux-browser-pane-downloads:';

/** Download history survives the pane being suspended/reopened and app restarts. */
function storedDownloads(paneId: string): DownloadRecord[] {
    try {
        const raw = localStorage.getItem(DOWNLOADS_KEY_PREFIX + paneId);
        const list = raw ? JSON.parse(raw) as DownloadRecord[] : [];
        if (!Array.isArray(list)) return [];
        // A download that was in flight when the app closed never finishes.
        return list.filter(d => d && typeof d.path === 'string').map(d => d.state === 'in_progress' ? { ...d, state: 'failed' as const, finishedAt: d.finishedAt ?? d.startedAt } : d);
    } catch {
        return [];
    }
}

function rememberDownloads(paneId: string, list: DownloadRecord[] | null): void {
    try {
        if (list && list.length) localStorage.setItem(DOWNLOADS_KEY_PREFIX + paneId, JSON.stringify(list.slice(-MAX_DOWNLOADS)));
        else localStorage.removeItem(DOWNLOADS_KEY_PREFIX + paneId);
    } catch { /* storage unavailable */ }
}

/** One visited page. History is shared by every browser tab (one browser, many tabs). */
export interface HistoryEntry {
    url: string;
    title: string;
    at: number;
}

const HISTORY_KEY = 'openflux-browser-history';
const MAX_HISTORY = 300;

function storedHistory(): HistoryEntry[] {
    try {
        const raw = localStorage.getItem(HISTORY_KEY);
        const list = raw ? JSON.parse(raw) as HistoryEntry[] : [];
        return Array.isArray(list) ? list.filter(e => e && typeof e.url === 'string') : [];
    } catch {
        return [];
    }
}

function rememberHistory(list: HistoryEntry[]): void {
    try {
        if (list.length) localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(-MAX_HISTORY)));
        else localStorage.removeItem(HISTORY_KEY);
    } catch { /* storage unavailable */ }
}

/** Append a visit (newest last); a repeat of the latest URL only refreshes its title and time. */
function recordHistory(url: string, title: string): void {
    if (!url || url === DEFAULT_URL || url.startsWith('chrome-error://') || url.startsWith('about:')) return;
    const list = storedHistory();
    const last = list[list.length - 1];
    if (last && last.url === url) {
        last.at = Date.now();
        if (title) last.title = title;
    } else {
        list.push({ url, title: title || '', at: Date.now() });
    }
    rememberHistory(list);
}

/** Newest first, optionally filtered by a case-insensitive substring of URL or title. */
export function listHistory(query = '', limit = 100): HistoryEntry[] {
    const q = query.trim().toLowerCase();
    const list = storedHistory().reverse();
    const filtered = q ? list.filter(e => e.url.toLowerCase().includes(q) || e.title.toLowerCase().includes(q)) : list;
    return filtered.slice(0, Math.max(1, limit));
}

export function clearHistory(): void {
    rememberHistory([]);
}

/** A cookie as CDP `Network.getCookies` reports it (the fields the panel and the agent show). */
interface CookieInfo {
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    session: boolean;
}

type PanelMode = 'downloads' | 'history' | 'cookies';

function rememberUrl(paneId: string, url: string | null): void {
    try {
        if (url) localStorage.setItem(URL_KEY_PREFIX + paneId, url);
        else localStorage.removeItem(URL_KEY_PREFIX + paneId);
    } catch {
        // Not worth failing navigation over.
    }
}

/** Tab title: the host of the current page, or nothing for a blank tab. */
function titleForUrl(url: string | null): string | null {
    if (!url || url === DEFAULT_URL) return null;
    try {
        const parsed = new URL(url);
        return parsed.hostname || url;
    } catch {
        return url;
    }
}

const ICON_BACK = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6" /></svg>';
const ICON_FORWARD = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6" /></svg>';
const ICON_RELOAD = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>';
const ICON_DOWNLOAD = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12" /><polyline points="7 10 12 15 17 10" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></svg>';
const ICON_FOLDER = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>';
const ICON_OPEN = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" /></svg>';
const ICON_TRASH = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M9 6V4h6v2M6 6l1 14h10l1-14" /></svg>';
const ICON_HISTORY = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15 14" /></svg>';
const ICON_COOKIE = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9 3 3 0 0 0 3 3 3 3 0 0 0 3 3 3 3 0 0 0 3 3z" /><circle cx="8.5" cy="10.5" r="0.8" /><circle cx="14" cy="15" r="0.8" /><circle cx="9" cy="16" r="0.8" /></svg>';
const ICON_REFRESH_SMALL = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>';

export function createBrowserPaneProvider(options: BrowserPaneOptions = {}): PaneContentProvider {
    const controllers = new Map<string, BrowserPaneController>();
    if (options.client) installAgentBridge(options.client, options.session ?? (() => null));

    return {
        kind: 'browser',
        icon: ICON_BROWSER,
        titleKey: 'panel.pane_browser',
        singleton: false,
        title(pane) {
            const controller = controllers.get(pane.id);
            // Prefer the page's real <title>; fall back to its host, then the
            // generic label.
            const base = controller?.currentTitle
                || titleForUrl(controller?.currentUrl ?? storedUrl(pane.id))
                || t('panel.pane_browser');
            // A tab the agent is driving is marked in the tab strip itself.
            return controller?.takenOver ? `🔴 ${base}` : base;
        },
        mount(body, pane) {
            controllers.set(pane.id, new BrowserPaneController(body, pane, options.session?.() ?? null));
        },
        unmount(_body, pane, reason: PaneUnmountReason) {
            controllers.get(pane.id)?.dispose(reason);
            controllers.delete(pane.id);
        },
        onVisibilityChange(visible, pane) {
            // Deferred by a task: this can fire during the panel's very first
            // render, before the stage has a layout box to position over.
            const controller = controllers.get(pane.id);
            setTimeout(() => controller?.setTabVisible(visible), 0);
        },
    };
}

// ---------------------------------------------------------------------------
// Agent bridge: the gateway relays the agent's browser actions here.
//
// Protocol (mirrors the canvas.* round-trip): the gateway sends
//   { type:'browser.view.request', id, payload:{ op, label?, ... } }
// and we answer
//   { type:'browser.view.result', id, payload:{ ok, ... } | { error } }.
// Windows input uses CDP; macOS uses native input and scoped DOM operations.
// Everything targets the selected webview without moving the OS pointer.
// ---------------------------------------------------------------------------

let agentBridgeInstalled = false;

/**
 * Opens a new browser tab in the panel and returns its webview label. Set by
 * main.ts (which owns the panel). Lets the agent open a tab itself instead of
 * asking the user to.
 */
let browserTabOpener: ((sessionId: string) => string | null) | null = null;
export function setBrowserTabOpener(fn: (sessionId: string) => string | null): void {
    browserTabOpener = fn;
}

/**
 * Makes an existing browser pane the visible pane for its conversation. A
 * pane can stay mounted while another panel tab is active or while the whole
 * panel is collapsed; in both cases its native child view deliberately has
 * no layout box and cannot service CDP until the pane is revealed again.
 */
let browserTabPreparer: ((sessionId: string, paneId: string) => boolean) | null = null;
export function setBrowserTabPreparer(fn: (sessionId: string, paneId: string) => boolean): void {
    browserTabPreparer = fn;
}

function installAgentBridge(
    getClient: () => GatewayClient | null,
    getCurrentSession: () => string | null,
): void {
    if (agentBridgeInstalled) return;
    agentBridgeInstalled = true;

    const reply = (id: string | undefined, payload: Record<string, unknown>): void => {
        if (!id) return;
        getClient()?.sendMessage({ type: 'browser.view.result', id, payload });
    };

    const handler = (message: GatewayMessage): void => {
        if (message.type !== 'browser.view.request') return;
        const { id } = message as { id?: string };
        const p = (message.payload as Record<string, unknown>) || {};
        const op = String(p.op || '');

        void (async () => {
            try {
                const route = resolveBrowserSessionRoute(p.sessionId, getCurrentSession());
                if ('error' in route) {
                    reply(id, { error: route.error });
                    return;
                }
                const requestedSession = route.sessionId;
                if (op === 'list') {
                    const tabs = [...controllersByLabel.values()]
                        .filter(controller => controller.sessionId === requestedSession)
                        .map(controller => controller.describe());
                    reply(id, { ok: true, tabs });
                    return;
                }
                if (op === 'history') {
                    // Shared browsing history (all tabs); `clear` wipes it.
                    if (p.clear === true) {
                        clearHistory();
                        reply(id, { ok: true, history: [] });
                        return;
                    }
                    const limit = Math.max(1, Math.min(300, Number(p.limit) || 50));
                    reply(id, { ok: true, history: listHistory(typeof p.query === 'string' ? p.query : '', limit) });
                    return;
                }
                if (op === 'config') {
                    // Gateway-wide settings for every tab: where downloads land.
                    if (typeof p.downloadDir === 'string') {
                        const dir = await invoke<string>('browser_view_set_download_dir', { path: p.downloadDir });
                        reply(id, { ok: true, downloadDir: dir });
                    } else {
                        reply(id, { ok: true });
                    }
                    return;
                }
                if (op === 'open') {
                    // Open a fresh browser tab and (optionally) point it at a URL.
                    if (!browserTabOpener) {
                        reply(id, { error: 'cannot open a browser tab' });
                        return;
                    }
                    const newLabel = browserTabOpener(requestedSession);
                    if (!newLabel) {
                        reply(id, { error: 'cannot open a browser tab' });
                        return;
                    }
                    const url = typeof p.url === 'string' ? p.url.trim() : '';
                    if (url) controllersByLabel.get(newLabel)?.openUrl(url);
                    reply(id, { ok: true, label: newLabel });
                    return;
                }
                const label = String(p.label || '');
                const controller = controllersByLabel.get(label);
                if (!controller || controller.sessionId !== requestedSession) {
                    reply(id, { error: 'tab_not_found' });
                    return;
                }
                if (op === 'prepare') {
                    if (!browserTabPreparer?.(requestedSession, controller.paneId)) {
                        reply(id, { error: 'cannot show the browser tab' });
                        return;
                    }
                    reply(id, { ok: true });
                    void controller.installRecorder();
                } else if (op === 'cdp') {
                    const session = typeof p.session === 'string' && p.session ? p.session : undefined;
                    const result = await controller.cdp(String(p.method || ''), (p.params as Record<string, unknown>) || {}, session);
                    reply(id, { ok: true, result });
                } else if (op === 'frames') {
                    reply(id, { ok: true, ...(await controller.frames()) });
                } else if (op === 'downloads') {
                    reply(id, { ok: true, downloads: controller.listDownloads(p.clear === true) });
                } else if (op === 'act') {
                    const out = await controller.agentAct(p as AgentActPayload);
                    reply(id, { ok: true, ...out });
                } else if (op === 'takeover') {
                    controller.setTakeover(p.on === true);
                    reply(id, { ok: true });
                } else {
                    reply(id, { error: `unknown op: ${op}` });
                }
            } catch (error) {
                reply(id, { error: error instanceof Error ? error.message : String(error) });
            }
        })();
    };

    // The client instance persists across reconnects (its handler list is not
    // cleared), so registering once is enough. If it is not up yet, poll until
    // it is, then attach exactly once.
    const tryAttach = (): boolean => {
        const client = getClient();
        if (!client) return false;
        client.addMessageHandler(handler);
        return true;
    };
    if (!tryAttach()) {
        const timer = setInterval(() => { if (tryAttach()) clearInterval(timer); }, 500);
    }
}

/** Frames of a tab the agent can address beyond the page's own script reach (see browser_view_frames). */
interface FrameReport {
    /** Own-process (cross-site) iframes with their CDP session. */
    frames: Array<{ session: string; target_id: string; url: string; title: string }>;
    /** Main-world contexts of frames in the tab's process (the main document included). */
    contexts: Array<{ context_id: number; frame_id: string; origin: string }>;
}

interface AgentActPayload {
    kind?: string;
    x?: number;
    y?: number;
    /** Target box size (from a snapshot element); the click lands somewhere natural inside it. */
    w?: number;
    h?: number;
    /** Drag end point, with its box when it came from a snapshot element. */
    x2?: number;
    y2?: number;
    w2?: number;
    h2?: number;
    /** Wheel deltas for scroll. */
    deltaX?: number;
    deltaY?: number;
    text?: string;
    key?: string;
    /** CDP modifier bitmask for key: Alt=1, Ctrl=2, Meta=4, Shift=8. */
    modifiers?: number;
}

/**
 * In-page recorder the agent reads through the `console` / `network`
 * actions: console output, uncaught errors, and every fetch/XHR with its
 * status. It is what lets the agent debug a page itself instead of asking
 * the user to open DevTools. Idempotent; capped so it never grows unbounded.
 */
const RECORDER_SOURCE = `(function __ofxRecInstall(){if(window.__ofxRec)return;const rec={console:[],network:[],installedAt:Date.now()};const cap=(a,n)=>{while(a.length>n)a.shift();};const fmt=(a)=>{try{if(typeof a==='string')return a;if(a instanceof Error)return a.stack||a.message;return JSON.stringify(a);}catch(e){return String(a);}};for(const level of ['error','warn','info','log','debug']){const orig=console[level];console[level]=function(...args){try{rec.console.push({t:Date.now(),level,text:args.map(fmt).join(' ').slice(0,1000)});cap(rec.console,200);}catch(e){}return orig.apply(this,args);};}window.addEventListener('error',e=>{rec.console.push({t:Date.now(),level:'error',text:'Uncaught '+(e.message||'')+' @'+(e.filename||'')+':'+(e.lineno||0)});cap(rec.console,200);});window.addEventListener('unhandledrejection',e=>{rec.console.push({t:Date.now(),level:'error',text:'Unhandled rejection: '+fmt(e.reason)});cap(rec.console,200);});const pushNet=(e)=>{rec.network.push(e);cap(rec.network,100);};const snippet=async(res)=>{try{const ct=res.headers.get('content-type')||'';if(!/json|text/.test(ct))return '';const txt=await res.clone().text();return txt.slice(0,400);}catch(e){return '';}};const of=window.fetch;if(of){window.fetch=async function(input,init){const start=Date.now();const url=typeof input==='string'?input:(input&&input.url)||String(input);const method=((init&&init.method)||(input&&input.method)||'GET').toUpperCase();try{const res=await of.apply(this,arguments);const e={t:start,kind:'fetch',method,url,status:res.status,ok:res.ok,ms:Date.now()-start};if(!res.ok||/json/.test(res.headers.get('content-type')||''))e.response=await snippet(res);pushNet(e);return res;}catch(err){pushNet({t:start,kind:'fetch',method,url,status:0,ok:false,ms:Date.now()-start,error:fmt(err)});throw err;}};}const XO=XMLHttpRequest.prototype.open,XS=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.open=function(m,u){this.__ofx={method:String(m).toUpperCase(),url:String(u)};return XO.apply(this,arguments);};XMLHttpRequest.prototype.send=function(){const x=this;const start=Date.now();x.addEventListener('loadend',()=>{try{const ct=x.getResponseHeader('content-type')||'';const e={t:start,kind:'xhr',method:(x.__ofx||{}).method,url:(x.__ofx||{}).url,status:x.status,ok:x.status>=200&&x.status<300,ms:Date.now()-start};if(x.status===0)e.error='network error / blocked';if((!e.ok||/json/.test(ct))&&x.responseType!=='blob'&&x.responseType!=='arraybuffer')e.response=String(x.responseText||'').slice(0,400);pushNet(e);}catch(e){}});return XS.apply(this,arguments);};window.__ofxRec=rec;const install=w=>{try{if(w&&w.document&&!w.__ofxRec)w.eval('('+__ofxRecInstall.toString()+')()');}catch(e){}};for(const f of document.querySelectorAll('iframe,frame'))install(f.contentWindow);document.addEventListener('load',e=>{const t=e.target;if(t&&(t.tagName==='IFRAME'||t.tagName==='FRAME'))install(t.contentWindow);},true);})();`;

class BrowserPaneController {
    private readonly label: string;
    private readonly toolbar = document.createElement('div');
    private readonly address = document.createElement('input');
    private readonly stage = document.createElement('div');
    private readonly hint = document.createElement('div');
    private readonly status = document.createElement('div');
    private readonly backBtn: HTMLButtonElement;
    private readonly forwardBtn: HTMLButtonElement;
    private readonly reloadBtn: HTMLButtonElement;
    private readonly historyBtn: HTMLButtonElement;
    private readonly cookiesBtn: HTMLButtonElement;
    private readonly downloadsBtn: HTMLButtonElement;
    private readonly downloadsBadge = document.createElement('span');
    /** Slide-down panel (downloads / history / cookies); sits between toolbar and stage so the native view is not covered. */
    private readonly panel = document.createElement('div');
    private panelMode: PanelMode | null = null;
    private historyQuery = '';
    private cookieRequest = 0;

    currentUrl: string;
    readonly paneId: string;
    /** The page's <title>, resolved after each navigation for the tab label. */
    currentTitle = '';
    /** True while the agent is driving this tab (soft cursor + 🔴 tab marker). */
    takenOver = false;

    private readonly cursor: BrowserCursor;

    private created = false;
    private creating = false;
    private tabVisible = false;
    private shown = false;
    private disposed = false;
    private addressEdited = false;
    private lastBounds = '';
    private syncQueued = false;
    private resizeObserver: ResizeObserver | null = null;
    private unlistenNavigation: UnlistenFn | null = null;
    private unlistenDownload: UnlistenFn | null = null;
    private unlistenOverlay: (() => void) | null = null;
    /** Files this tab saved (newest last), for the pane status and the agent. */
    private downloads: DownloadRecord[] = [];

    private readonly onWindowChange = () => this.scheduleSync();

    constructor(
        private readonly body: HTMLElement,
        private readonly pane: PaneState,
        readonly sessionId: string | null,
    ) {
        this.label = labelFor(pane.id);
        this.paneId = pane.id;
        this.currentUrl = storedUrl(pane.id) ?? DEFAULT_URL;
        this.cursor = new BrowserCursor(this.label);
        controllersByLabel.set(this.label, this);

        body.classList.add('browser-pane');

        this.toolbar.className = 'browser-pane-toolbar';
        this.backBtn = this.iconButton(ICON_BACK, t('browser.back'));
        this.forwardBtn = this.iconButton(ICON_FORWARD, t('browser.forward'));
        this.reloadBtn = this.iconButton(ICON_RELOAD, t('browser.reload'));

        this.address.type = 'text';
        this.address.className = 'browser-pane-address';
        this.address.spellcheck = false;
        this.address.placeholder = t('browser.address_placeholder');
        this.address.value = this.currentUrl === DEFAULT_URL ? '' : this.currentUrl;

        this.historyBtn = this.iconButton(ICON_HISTORY, t('browser.history'));
        this.cookiesBtn = this.iconButton(ICON_COOKIE, t('browser.cookies'));
        this.downloadsBtn = this.iconButton(ICON_DOWNLOAD, t('browser.downloads'));
        this.downloadsBtn.classList.add('browser-pane-downloads-btn');
        this.downloadsBadge.className = 'browser-pane-downloads-badge';
        this.downloadsBtn.append(this.downloadsBadge);
        this.panel.className = 'browser-pane-panel';
        this.panel.style.display = 'none';
        this.downloads = storedDownloads(pane.id);

        // Left: navigation. Middle: the address, centred. Right: history / cookies / downloads.
        const nav = document.createElement('div');
        nav.className = 'browser-pane-nav';
        nav.append(this.backBtn, this.forwardBtn, this.reloadBtn);
        const tools = document.createElement('div');
        tools.className = 'browser-pane-tools';
        tools.append(this.historyBtn, this.cookiesBtn, this.downloadsBtn);
        this.toolbar.append(nav, this.address, tools);

        // The stage is only a placeholder; the native webview is positioned
        // over it by the Rust side. The hint shows through until a page loads.
        this.stage.className = 'browser-pane-stage';
        this.hint.className = 'browser-pane-stage-hint';
        this.hint.textContent = t('browser.hint_empty');
        this.stage.append(this.hint);

        this.status.className = 'browser-pane-status';
        this.status.style.display = 'none';

        body.append(this.toolbar, this.panel, this.stage, this.status);
        this.wire();
        this.updateDownloadsBadge();
    }

    private iconButton(html: string, title: string): HTMLButtonElement {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'file-pane-btn';
        button.innerHTML = html;
        button.title = title;
        return button;
    }

    private wire(): void {
        this.address.addEventListener('input', () => { this.addressEdited = true; });
        this.address.addEventListener('keydown', event => {
            if (event.key !== 'Enter') return;
            const url = this.normalizeUrl(this.address.value.trim());
            if (url) void this.navigate(url);
        });
        this.address.addEventListener('blur', () => {
            // Drop a half-typed address rather than leaving it contradicting
            // the page actually on screen.
            this.addressEdited = false;
            this.address.value = this.currentUrl === DEFAULT_URL ? '' : this.currentUrl;
        });

        this.downloadsBtn.addEventListener('click', () => this.togglePanel('downloads'));
        this.historyBtn.addEventListener('click', () => this.togglePanel('history'));
        this.cookiesBtn.addEventListener('click', () => this.togglePanel('cookies'));
        this.panel.addEventListener('input', event => {
            const target = event.target as HTMLInputElement;
            if (target.dataset.historyFilter !== undefined) {
                this.historyQuery = target.value;
                this.renderHistoryRows();
            }
        });
        this.panel.addEventListener('click', event => {
            const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
            if (!target) return;
            void this.onPanelAction(target.dataset.action || '', target.dataset);
        });

        this.backBtn.addEventListener('click', () => void this.command('browser_view_back'));
        this.forwardBtn.addEventListener('click', () => void this.command('browser_view_forward'));
        this.reloadBtn.addEventListener('click', () => void this.command('browser_view_reload'));

        if (typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(() => this.scheduleSync());
            this.resizeObserver.observe(this.stage);
        }
        window.addEventListener('resize', this.onWindowChange);
        // Any ancestor scrolling moves the stage; the webview must follow.
        document.addEventListener('scroll', this.onWindowChange, true);

        this.unlistenOverlay = onOverlayChange(() => this.scheduleSync());

        void listen<NavigationPayload>('browser-view:navigated', event => {
            if (event.payload.label !== this.label) return;
            this.onNavigated(event.payload);
        }).then(unlisten => {
            if (this.disposed) unlisten();
            else this.unlistenNavigation = unlisten;
        }).catch(error => {
            console.warn('[Browser] Navigation events unavailable:', error);
        });

        void listen<DownloadPayload>('browser-view:download', event => {
            if (event.payload.label !== this.label) return;
            this.onDownload(event.payload);
        }).then(unlisten => {
            if (this.disposed) unlisten();
            else this.unlistenDownload = unlisten;
        }).catch(error => {
            console.warn('[Browser] Download events unavailable:', error);
        });
    }

    private onDownload(payload: DownloadPayload): void {
        const name = payload.path.split(/[\\/]/).pop() || payload.url.split('/').pop() || 'download';
        if (payload.kind === 'started') {
            this.downloads.push({ url: payload.url, path: payload.path, name, state: 'in_progress', startedAt: Date.now() });
            while (this.downloads.length > MAX_DOWNLOADS) this.downloads.shift();
            this.setStatus(t('browser.download_started', name));
            this.afterDownloadsChanged();
            return;
        }
        // Finished: match the in-progress record by path, then by URL.
        const record = [...this.downloads].reverse().find(d => d.state === 'in_progress' && (d.path === payload.path || d.url === payload.url))
            ?? [...this.downloads].reverse().find(d => d.state === 'in_progress');
        if (record) {
            if (payload.path) record.path = payload.path;
            record.name = record.path.split(/[\\/]/).pop() || record.name;
            record.state = payload.success ? 'completed' : 'failed';
            record.finishedAt = Date.now();
        } else {
            this.downloads.push({ url: payload.url, path: payload.path, name, state: payload.success ? 'completed' : 'failed', startedAt: Date.now(), finishedAt: Date.now() });
        }
        this.setStatus(payload.success ? t('browser.download_finished', name) : t('browser.download_failed', name));
        this.afterDownloadsChanged();
    }

    /** Downloads of this tab for the agent bridge; `clear` forgets finished ones. */
    listDownloads(clear = false): DownloadRecord[] {
        const list = this.downloads.map(d => ({ ...d }));
        if (clear) {
            this.downloads = this.downloads.filter(d => d.state === 'in_progress');
            this.afterDownloadsChanged();
        }
        return list;
    }

    private afterDownloadsChanged(): void {
        rememberDownloads(this.pane.id, this.downloads);
        this.updateDownloadsBadge();
        if (this.panelMode === 'downloads') this.renderPanel();
    }

    /** Badge on the toolbar button: a pulsing count while something downloads, else the history count. */
    private updateDownloadsBadge(): void {
        const active = this.downloads.filter(d => d.state === 'in_progress').length;
        const total = this.downloads.length;
        this.downloadsBtn.classList.toggle('is-downloading', active > 0);
        this.downloadsBadge.textContent = active > 0 ? String(active) : total > 0 ? String(Math.min(total, 99)) : '';
        this.downloadsBadge.style.display = this.downloadsBadge.textContent ? '' : 'none';
        this.downloadsBtn.title = active > 0 ? t('browser.downloads_active', String(active)) : t('browser.downloads');
    }

    /** Open the panel in a mode, switch modes, or close it when the same button is clicked again. */
    private togglePanel(mode: PanelMode): void {
        this.panelMode = this.panelMode === mode ? null : mode;
        this.panel.style.display = this.panelMode ? '' : 'none';
        this.downloadsBtn.classList.toggle('active', this.panelMode === 'downloads');
        this.historyBtn.classList.toggle('active', this.panelMode === 'history');
        this.cookiesBtn.classList.toggle('active', this.panelMode === 'cookies');
        if (this.panelMode) this.renderPanel();
        // The stage just changed height; the native view must follow it.
        this.scheduleSync();
    }

    private static esc(s: string): string {
        return s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));
    }

    private static fmtTime(ts: number, withDate = false): string {
        const d = new Date(ts);
        const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        if (!withDate) return hm;
        const today = new Date();
        const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
        return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
    }

    private renderPanel(): void {
        if (this.panelMode === 'downloads') this.renderDownloads();
        else if (this.panelMode === 'history') this.renderHistory();
        else if (this.panelMode === 'cookies') void this.renderCookies();
    }

    private async onPanelAction(action: string, data: DOMStringMap): Promise<void> {
        switch (action) {
            case 'dl-clear':
                this.downloads = this.downloads.filter(d => d.state === 'in_progress');
                this.afterDownloadsChanged();
                return;
            case 'dl-open':
            case 'dl-reveal': {
                const path = data.path || '';
                if (!path) return;
                await invoke(action === 'dl-reveal' ? 'file_reveal' : 'file_open', { filePath: path })
                    .catch(error => this.setStatus(t('browser.download_open_failed', String(error))));
                return;
            }
            case 'history-open': {
                const url = data.url || '';
                if (url) void this.navigate(url);
                return;
            }
            case 'history-clear':
                clearHistory();
                this.renderHistory();
                return;
            case 'cookies-refresh':
                await this.renderCookies();
                return;
            case 'cookie-delete': {
                const name = data.name || '';
                if (!name) return;
                try {
                    await this.cdp('Network.deleteCookies', { name, domain: data.domain || '', path: data.path || '/' });
                    await this.renderCookies();
                } catch (error) {
                    this.setStatus(t('browser.cookies_failed', String(error)));
                }
                return;
            }
            case 'cookies-clear-site': {
                try {
                    const cookies = await this.fetchCookies();
                    for (const c of cookies) await this.cdp('Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path });
                    this.setStatus(t('browser.cookies_cleared', String(cookies.length)));
                    await this.renderCookies();
                } catch (error) {
                    this.setStatus(t('browser.cookies_failed', String(error)));
                }
                return;
            }
            case 'cookies-clear-all': {
                try {
                    await this.cdp('Network.clearBrowserCookies', {});
                    this.setStatus(t('browser.cookies_cleared_all'));
                    await this.renderCookies();
                } catch (error) {
                    this.setStatus(t('browser.cookies_failed', String(error)));
                }
                return;
            }
            default:
                return;
        }
    }

    private renderDownloads(): void {
        const esc = BrowserPaneController.esc;
        const rows = [...this.downloads].reverse().map(d => {
            const stateKey = d.state === 'in_progress' ? 'browser.download_state_progress' : d.state === 'completed' ? 'browser.download_state_completed' : 'browser.download_state_failed';
            const took = d.finishedAt && d.state === 'completed' ? ` · ${Math.max(0.1, Math.round((d.finishedAt - d.startedAt) / 100) / 10)}s` : '';
            const actions = d.state === 'completed'
                ? `<button type="button" class="file-pane-btn" data-action="dl-open" data-path="${esc(d.path)}" title="${esc(t('browser.download_open'))}">${ICON_OPEN}</button>
                   <button type="button" class="file-pane-btn" data-action="dl-reveal" data-path="${esc(d.path)}" title="${esc(t('browser.download_reveal'))}">${ICON_FOLDER}</button>`
                : '';
            return `<div class="browser-pane-row is-${d.state}" title="${esc(d.path || d.url)}">
                <div class="browser-pane-row-main">
                    <div class="browser-pane-row-name">${esc(d.name)}</div>
                    <div class="browser-pane-row-meta">${esc(t(stateKey))}${took} · ${BrowserPaneController.fmtTime(d.startedAt)} · ${esc(d.path || d.url)}</div>
                </div>
                <div class="browser-pane-row-actions">${actions}</div>
            </div>`;
        });
        const hasHistory = this.downloads.some(d => d.state !== 'in_progress');
        this.panel.innerHTML = `
            <div class="browser-pane-panel-head">
                <span>${esc(t('browser.downloads'))}</span>
                ${hasHistory ? `<button type="button" class="file-pane-btn" data-action="dl-clear" title="${esc(t('browser.downloads_clear'))}">${ICON_TRASH}</button>` : ''}
            </div>
            ${rows.length ? rows.join('') : `<div class="browser-pane-panel-empty">${esc(t('browser.downloads_empty'))}</div>`}`;
    }

    private renderHistory(): void {
        const esc = BrowserPaneController.esc;
        this.panel.innerHTML = `
            <div class="browser-pane-panel-head">
                <span>${esc(t('browser.history'))}</span>
                <input type="search" class="browser-pane-panel-filter" data-history-filter placeholder="${esc(t('browser.history_filter'))}" value="${esc(this.historyQuery)}" />
                <button type="button" class="file-pane-btn" data-action="history-clear" title="${esc(t('browser.history_clear'))}">${ICON_TRASH}</button>
            </div>
            <div data-history-rows></div>`;
        this.renderHistoryRows();
        if (this.historyQuery) this.panel.querySelector<HTMLInputElement>('[data-history-filter]')?.focus();
    }

    private renderHistoryRows(): void {
        const esc = BrowserPaneController.esc;
        const host = this.panel.querySelector<HTMLElement>('[data-history-rows]');
        if (!host) return;
        const entries = listHistory(this.historyQuery, 200);
        host.innerHTML = entries.length
            ? entries.map(e => `<div class="browser-pane-row is-link" data-action="history-open" data-url="${esc(e.url)}" title="${esc(e.url)}">
                <div class="browser-pane-row-main">
                    <div class="browser-pane-row-name">${esc(e.title || titleForUrl(e.url) || e.url)}</div>
                    <div class="browser-pane-row-meta">${BrowserPaneController.fmtTime(e.at, true)} · ${esc(e.url)}</div>
                </div>
            </div>`).join('')
            : `<div class="browser-pane-panel-empty">${esc(this.historyQuery ? t('browser.history_no_match') : t('browser.history_empty'))}</div>`;
    }

    /** Cookies visible to the current page (CDP `Network.getCookies`; Windows only). */
    private async fetchCookies(): Promise<CookieInfo[]> {
        const url = this.currentUrl && this.currentUrl !== DEFAULT_URL ? this.currentUrl : '';
        const res = await this.cdp('Network.getCookies', url ? { urls: [url] } : {}) as { cookies?: CookieInfo[] };
        return Array.isArray(res?.cookies) ? res.cookies : [];
    }

    private async renderCookies(): Promise<void> {
        const esc = BrowserPaneController.esc;
        const request = ++this.cookieRequest;
        let host = '';
        try { host = new URL(this.currentUrl).host; } catch { /* about:blank */ }
        const head = (extra = '') => `
            <div class="browser-pane-panel-head">
                <span>${esc(t('browser.cookies'))}${host ? ` · ${esc(host)}` : ''}</span>
                <span class="browser-pane-panel-head-actions">
                    <button type="button" class="file-pane-btn" data-action="cookies-refresh" title="${esc(t('browser.cookies_refresh'))}">${ICON_REFRESH_SMALL}</button>
                    ${extra}
                </span>
            </div>`;
        this.panel.innerHTML = `${head()}<div class="browser-pane-panel-empty">${esc(t('browser.cookies_loading'))}</div>`;
        let cookies: CookieInfo[];
        try {
            cookies = await this.fetchCookies();
        } catch (error) {
            if (request !== this.cookieRequest) return;
            this.panel.innerHTML = `${head()}<div class="browser-pane-panel-empty">${esc(IS_MAC ? t('browser.cookies_unsupported') : t('browser.cookies_failed', String(error)))}</div>`;
            return;
        }
        if (request !== this.cookieRequest) return;
        const actions = `
            <button type="button" class="browser-pane-panel-textbtn" data-action="cookies-clear-site" ${cookies.length ? '' : 'disabled'}>${esc(t('browser.cookies_clear_site'))}</button>
            <button type="button" class="browser-pane-panel-textbtn is-danger" data-action="cookies-clear-all">${esc(t('browser.cookies_clear_all'))}</button>`;
        const rows = cookies.map(c => {
            const expires = c.session || !c.expires || c.expires < 0 ? t('browser.cookie_session') : BrowserPaneController.fmtTime(c.expires * 1000, true);
            const flags = [c.httpOnly ? 'HttpOnly' : '', c.secure ? 'Secure' : ''].filter(Boolean).join(' ');
            const value = c.value.length > 80 ? `${c.value.slice(0, 80)}…` : c.value;
            return `<div class="browser-pane-row" title="${esc(c.value)}">
                <div class="browser-pane-row-main">
                    <div class="browser-pane-row-name">${esc(c.name)} <span class="browser-pane-row-value">${esc(value)}</span></div>
                    <div class="browser-pane-row-meta">${esc(c.domain)}${esc(c.path)} · ${esc(t('browser.cookie_expires'))} ${esc(expires)}${flags ? ` · ${flags}` : ''}</div>
                </div>
                <div class="browser-pane-row-actions">
                    <button type="button" class="file-pane-btn" data-action="cookie-delete" data-name="${esc(c.name)}" data-domain="${esc(c.domain)}" data-path="${esc(c.path)}" title="${esc(t('browser.cookie_delete'))}">${ICON_TRASH}</button>
                </div>
            </div>`;
        });
        this.panel.innerHTML = `${head(actions)}${rows.length ? rows.join('') : `<div class="browser-pane-panel-empty">${esc(t('browser.cookies_empty'))}</div>`}`;
    }

    /** Bare hostnames are common in an address bar; a search box this is not. */
    private normalizeUrl(input: string): string {
        if (!input) return '';
        if (/^[a-z][a-z0-9+.-]*:/i.test(input)) return input;
        if (input.startsWith('localhost') || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?/.test(input)) return `http://${input}`;
        return `https://${input}`;
    }

    private setStatus(text: string | null): void {
        this.status.textContent = text ?? '';
        this.status.style.display = text ? '' : 'none';
    }

    private onNavigated(payload: NavigationPayload): void {
        this.currentUrl = payload.url;
        rememberUrl(this.pane.id, payload.url);
        this.hint.style.display = payload.url === DEFAULT_URL ? '' : 'none';
        // Never clobber what the user is in the middle of typing.
        if (!this.addressEdited && document.activeElement !== this.address) {
            this.address.value = payload.url === DEFAULT_URL ? '' : payload.url;
        }
        this.setStatus(payload.kind === 'start' ? t('browser.loading') : null);
        if (payload.kind === 'start') {
            // The old page's title no longer applies; fall back to the host
            // until the new page's <title> arrives.
            this.currentTitle = '';
            // A refused/failed navigation never reports "finished": probe the
            // page ourselves so the status settles instead of saying 加载中… forever.
            this.scheduleLoadProbe();
        }
        // A navigation wipes the page's DOM, taking the soft-cursor overlay
        // with it; rebuild it on the new page while the agent is driving.
        if (payload.kind === 'finished') {
            this.cursor.reset();
            if (this.takenOver) void this.cursor.ensure();
            void this.refreshTitle();
            void this.installRecorder();
        }
        document.dispatchEvent(new CustomEvent(PANE_TITLE_CHANGED_EVENT));
    }

    private recorderArmed = false;

    /**
     * Install the console/network recorder on the current page and, once per
     * webview, on every future document so it is present before page scripts
     * run. Safe to call repeatedly.
     */
    async installRecorder(): Promise<void> {
        try {
            if (!this.recorderArmed) {
                this.recorderArmed = true;
                // Not every engine supports it (WKWebView adapter); the direct
                // evaluate below still covers the current page.
                await this.cdp('Page.addScriptToEvaluateOnNewDocument', { source: RECORDER_SOURCE }).catch(() => undefined);
            }
            await this.cdp('Runtime.evaluate', { expression: RECORDER_SOURCE });
        } catch {
            // A page that blocks evaluation: the agent gets a "not active" hint.
        }
    }

    private loadProbeTimers: number[] = [];

    private scheduleLoadProbe(): void {
        for (const id of this.loadProbeTimers) window.clearTimeout(id);
        this.loadProbeTimers = [1200, 3000, 6000, 12000].map(delay => window.setTimeout(() => { void this.refreshTitle(); }, delay));
    }

    /**
     * Read the page's <title> so the tab shows the site name, not just its
     * host — and notice when the engine landed on its own error page
     * (`chrome-error://…`, the Edge-styled "无法访问此页面"), so the pane can
     * say what happened in its own words instead of looking like Edge.
     */
    private async refreshTitle(): Promise<void> {
        try {
            const res = await this.cdp('Runtime.evaluate', {
                expression: 'JSON.stringify({ title: document.title, href: location.href, ready: document.readyState })',
                returnByValue: true,
            });
            const raw = (res as { result?: { value?: unknown } })?.result?.value;
            let title = '';
            let href = '';
            let ready = '';
            if (typeof raw === 'string') {
                try { ({ title = '', href = '', ready = '' } = JSON.parse(raw) as { title?: string; href?: string; ready?: string }); } catch { /* keep defaults */ }
            }
            // The page settled on its own: drop a stale "加载中…".
            if (ready === 'complete' && this.status.textContent === t('browser.loading')) this.setStatus(null);
            if (href.startsWith('chrome-error://')) {
                let host = this.currentUrl;
                try { host = new URL(this.currentUrl).host || this.currentUrl; } catch { /* not a URL */ }
                this.setStatus(t('browser.unreachable', host));
                return;
            }
            if (this.status.textContent === t('browser.unreachable', (() => { try { return new URL(this.currentUrl).host || this.currentUrl; } catch { return this.currentUrl; } })())) {
                this.setStatus(null);
            }
            const next = title.trim();
            if (next && next !== this.currentTitle) {
                this.currentTitle = next;
                document.dispatchEvent(new CustomEvent(PANE_TITLE_CHANGED_EVENT));
            }
            // History: the page settled with a real title (or at least an address).
            if (ready === 'complete' && href) {
                recordHistory(href, next);
                if (this.panelMode === 'history') this.renderHistoryRows();
            }
        } catch {
            // A page that blocks evaluation: keep the host name.
        }
    }

    // --- agent bridge surface --------------------------------------------

    /** What `browser.view.list` reports for this tab. */
    describe(): { label: string; url: string; title: string; active: boolean } {
        return {
            label: this.label,
            url: this.currentUrl === DEFAULT_URL ? '' : this.currentUrl,
            title: this.currentTitle || titleForUrl(this.currentUrl) || '',
            active: this.tabVisible,
        };
    }

    /** Browser protocol adapter (WebView2 CDP or the native WKWebView bridge). */
    /**
     * Cross-origin iframes of this tab that have their own DevTools session
     * (Windows; empty on macOS). The console/network recorder is (re)installed
     * in each so the agent can debug inside them too; the call is idempotent.
     */
    async frames(): Promise<FrameReport> {
        const report = await invoke<FrameReport>('browser_view_frames', { label: this.label })
            .catch((): FrameReport => ({ frames: [], contexts: [] }));
        // Own-process frames: through their session. Same-process frames:
        // through their main-world context (the main document's own context
        // is among them; the install is a no-op where it already ran).
        for (const frame of report.frames ?? []) {
            await this.cdp('Runtime.evaluate', { expression: RECORDER_SOURCE }, frame.session).catch(() => undefined);
        }
        for (const context of report.contexts ?? []) {
            await this.cdp('Runtime.evaluate', { expression: RECORDER_SOURCE, contextId: context.context_id }).catch(() => undefined);
        }
        return { frames: report.frames ?? [], contexts: report.contexts ?? [] };
    }

    /**
     * Run one CDP method in this tab. `session` addresses an attached
     * cross-origin iframe (from `frames()`) instead of the main document.
     */
    async cdp(method: string, params: Record<string, unknown>, session?: string): Promise<unknown> {
        // Opening a pane mounts its controller before the native child view is
        // created. Wait for that view, including macOS's main-thread creation.
        const deadline = Date.now() + 10000;
        while (!this.created) {
            if (this.disposed) throw new Error('Browser tab was closed');
            if (Date.now() >= deadline) throw new Error('Browser tab is not ready; show the browser panel and retry');
            this.scheduleSync();
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        const json = await invoke<string>('browser_view_cdp', {
            label: this.label,
            method,
            params: JSON.stringify(params ?? {}),
            ...(session ? { session } : {}),
        });
        let result: any;
        try { result = JSON.parse(json); } catch { return json; }
        if (result?.exceptionDetails) {
            throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Page evaluation failed');
        }
        return result;
    }

    // The cursor's current page position, so a move starts from where it is —
    // the path is continuous across actions, like a real hand.
    private cursorX = 0;
    private cursorY = 0;

    /**
     * Move the pointer along a human-like path from its current spot to (x,y):
     * a slightly curved trajectory, eased slow→fast→slow, dispatching a CDP
     * `mouseMoved` at every step (with `buttons` held during a drag) and moving
     * the soft cursor with it. Pages that listen to mousemove see a real path,
     * not a teleport.
     */
    private async humanMove(x: number, y: number, buttons = 0): Promise<void> {
        const fromX = this.cursorX;
        const fromY = this.cursorY;
        const dist = Math.hypot(x - fromX, y - fromY);
        const steps = Math.max(6, Math.min(48, Math.round(dist / 22)));
        // One control point offset perpendicular to the line gives a gentle arc.
        const midX = (fromX + x) / 2;
        const midY = (fromY + y) / 2;
        const nx = dist ? -(y - fromY) / dist : 0;
        const ny = dist ? (x - fromX) / dist : 0;
        const arc = (Math.random() * 2 - 1) * Math.min(40, dist * 0.18);
        const ctrlX = midX + nx * arc;
        const ctrlY = midY + ny * arc;
        const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

        for (let i = 1; i <= steps; i++) {
            const t = ease(i / steps);
            const mt = 1 - t;
            // Quadratic Bézier: (1-t)^2 P0 + 2(1-t)t C + t^2 P1
            const px = mt * mt * fromX + 2 * mt * t * ctrlX + t * t * x;
            const py = mt * mt * fromY + 2 * mt * t * ctrlY + t * t * y;
            await this.cdp(IS_MAC ? 'OpenFlux.hover' : 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, buttons });
            void this.cursor.move(px, py);
            await new Promise(r => setTimeout(r, 8 + Math.random() * 10));
        }
        this.cursorX = x;
        this.cursorY = y;
    }

    /** True when the element under (x,y) is an HTML5 draggable (needs DnD events). */
    private async pointIsHtml5Draggable(x: number, y: number): Promise<boolean> {
        try {
            const expr = withDeepDom(`let el=D.elementFromPoint(${x},${y});while(el){if(el.draggable===true||el.getAttribute&&el.getAttribute('draggable')==='true')return true;el=el.parentElement;}return false;`);
            const res = await this.cdp('Runtime.evaluate', { expression: expr, returnByValue: true });
            return (res as { result?: { value?: unknown } })?.result?.value === true;
        } catch {
            return false;
        }
    }

    /**
     * Fire the HTML5 drag-and-drop event sequence (dragstart → dragenter →
     * dragover → drop → dragend) with one shared DataTransfer between the
     * draggable under (x1,y1) and the drop target under (x2,y2). This is what
     * makes native `draggable="true"` widgets actually drop; mouse events alone
     * do not, in Chromium.
     */
    private async html5DragDrop(x1: number, y1: number, x2: number, y2: number): Promise<void> {
        // Elements may live in a shadow root or a same-origin frame; events are
        // built with the element's own window so a frame's listeners see them.
        const expr = withDeepDom(`
            let src=D.elementFromPoint(${x1},${y1});
            while(src&&!(src.draggable===true||(src.getAttribute&&src.getAttribute('draggable')==='true')))src=src.parentElement;
            const tgt=D.elementFromPoint(${x2},${y2});
            if(!src||!tgt)return 'no_el';
            const W=src.ownerDocument.defaultView||window;
            const dt=new W.DataTransfer();
            const fire=(el,type,cx,cy)=>{const EV=(el.ownerDocument.defaultView||window).DragEvent;const ev=new EV(type,{bubbles:true,cancelable:true,composed:true,dataTransfer:dt,clientX:cx,clientY:cy});el.dispatchEvent(ev);};
            fire(src,'dragstart',${x1},${y1});
            fire(tgt,'dragenter',${x2},${y2});
            fire(tgt,'dragover',${x2},${y2});
            fire(tgt,'drop',${x2},${y2});
            fire(src,'dragend',${x2},${y2});
            return 'ok';
        `);
        await this.cdp('Runtime.evaluate', { expression: expr });
    }

    private async pressRelease(x: number, y: number, button: 'left' | 'right' | 'middle', clickCount: number): Promise<void> {
        await this.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount });
        await new Promise(r => setTimeout(r, 30 + Math.random() * 40));
        await this.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount });
    }

    /**
     * Perform an action in this webview with the visible soft cursor. macOS
     * DOM actions return their mode so callers can verify the page's response.
     */
    async agentAct(payload: AgentActPayload): Promise<Record<string, unknown>> {
        const kind = String(payload.kind || '');
        // Land inside the target's box the way a hand does, not dead centre.
        const { x, y } = pickPoint(payload.x, payload.y, payload.w, payload.h);
        // A person sees the target and decides before moving; pages that
        // measure the gap between events see that beat too.
        await think(THINK_KIND[kind] ?? 'key');

        if (kind === 'move' || kind === 'hover') {
            await this.humanMove(x, y);
            if (kind === 'hover') await new Promise(r => setTimeout(r, 250));
            return IS_MAC ? { inputMode: 'dom', isTrusted: false } : {};
        }
        if (kind === 'click' || kind === 'double_click' || kind === 'right_click') {
            await this.humanMove(x, y);
            await new Promise(r => setTimeout(r, 60));
            await this.cursor.click();
            const button = kind === 'right_click' ? 'right' : 'left';
            const clicks = kind === 'double_click' ? 2 : 1;
            if (clicks === 2) {
                await this.pressRelease(x, y, button, 1);
                await this.pressRelease(x, y, button, 2);
            } else {
                await this.pressRelease(x, y, button, 1);
            }
            return { x, y };
        }
        if (kind === 'drag') {
            const end = payload.x2 === undefined && payload.y2 === undefined
                ? { x, y }
                : pickPoint(payload.x2, payload.y2, payload.w2, payload.h2);
            const x2 = end.x;
            const y2 = end.y;
            if (IS_MAC) {
                // WKWebView's native drag events read the physical mouse-button
                // state. Use an explicit DOM drag instead of reporting a native
                // drag that the page received with buttons=0.
                await this.humanMove(x, y);
                const result = await this.cdp('OpenFlux.drag', { x, y, x2, y2 });
                this.cursorX = x2;
                this.cursorY = y2;
                await this.cursor.move(x2, y2);
                return { ...(result as Record<string, unknown>), inputMode: 'dom', isTrusted: false, x, y, x2, y2 };
            }
            // Two kinds of drag need two mechanisms:
            //  - mouse-based (canvas, sliders, sortable libs) reacts to real
            //    mousedown/move/up — the trusted CDP path below drives it.
            //  - HTML5 native DnD (draggable="true" + drop handlers) is NOT
            //    triggered by mouse events in Chromium; it needs dragstart/
            //    dragover/drop with a shared DataTransfer. We fire those too.
            const isHtml5 = await this.pointIsHtml5Draggable(x, y);

            await this.humanMove(x, y);
            await this.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
            await new Promise(r => setTimeout(r, 80));
            await this.humanMove(x2, y2, 1); // buttons=1: left held during the drag (visible path)
            await new Promise(r => setTimeout(r, 80));
            if (isHtml5) {
                await this.html5DragDrop(x, y, x2, y2);
            }
            await this.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1 });
            return { x, y, x2, y2 };
        }
        if (kind === 'scroll') {
            // Scroll at the cursor's current spot (move there first if given).
            if (payload.x !== undefined || payload.y !== undefined) await this.humanMove(x, y);
            // A real wheel flick lands as several notches that taper off, not
            // one 600px jump; pages with scroll listeners see the same shape.
            const ticks = planScrollTicks(Number(payload.deltaX) || 0, Number(payload.deltaY) || 0);
            let result: unknown = {};
            for (let i = 0; i < ticks.length; i++) {
                if (i > 0) await pause(scrollTickDelayMs(i, ticks.length));
                result = await this.cdp(IS_MAC ? 'OpenFlux.scroll' : 'Input.dispatchMouseEvent', {
                    type: 'mouseWheel',
                    x: this.cursorX,
                    y: this.cursorY,
                    deltaX: ticks[i].dx,
                    deltaY: ticks[i].dy,
                });
            }
            return IS_MAC ? { ...(result as Record<string, unknown>), inputMode: 'dom', ticks: ticks.length } : { ticks: ticks.length };
        }
        if (kind === 'type') {
            const typed = await this.humanType(String(payload.text ?? ''));
            return typed;
        }
        if (kind === 'key') {
            const key = String(payload.key ?? '');
            const modifiers = Number(payload.modifiers) || 0;
            const desc = describeKey(key) ?? { key, code: '', keyCode: 0, shift: false };
            await this.pressKey(desc, modifiers | (desc.shift ? 8 : 0));
            return {};
        }
        throw new Error(`unknown act kind: ${kind}`);
    }

    /**
     * One physical key press as a page sees it from a real keyboard: keyDown
     * carrying `code`/virtual key code and the produced text (so frameworks
     * reading `keyCode` and inputs reading the character both work), a short
     * hold, then keyUp. With Ctrl/Alt/Meta held no text is produced.
     */
    private async pressKey(desc: KeyDescriptor, modifiers: number): Promise<void> {
        const producesText = desc.text !== undefined && (modifiers & ~8) === 0;
        const base: Record<string, unknown> = { key: desc.key, modifiers };
        if (desc.code) {
            base.code = desc.code;
            base.windowsVirtualKeyCode = desc.keyCode;
            base.nativeVirtualKeyCode = desc.keyCode;
        }
        await this.cdp('Input.dispatchKeyEvent', {
            type: producesText ? 'keyDown' : 'rawKeyDown',
            ...base,
            ...(producesText ? { text: desc.text, unmodifiedText: desc.text } : {}),
        });
        await pause(keyHoldMs());
        await this.cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    }

    /**
     * Enter one character the way a hand does. On a US layout key it is a real
     * key press (keydown/keypress/input/keyup fire, `keyCode` is right);
     * anything else (CJK, emoji, accents) is inserted as composed text. On
     * macOS printable characters always go through insertText because the
     * WK adapter only maps the keys it needs for shortcuts.
     */
    private async pressChar(ch: string): Promise<void> {
        const desc = describeKey(ch);
        if (desc && desc.code && (!IS_MAC || desc.text === undefined || desc.text === '\r' || desc.text === '\t')) {
            await this.pressKey(desc, desc.shift ? 8 : 0);
            return;
        }
        await this.cdp('Input.insertText', { text: ch });
    }

    /**
     * Type text character by character at a human cadence, with the odd
     * adjacent-key slip that is noticed and backspaced. Newlines are Enter.
     */
    private async humanType(text: string): Promise<{ chars: number; typos: number }> {
        const chars = Array.from(text);
        let prev: string | undefined;
        let typos = 0;
        for (const ch of chars) {
            await pause(typingDelayMs(prev, ch));
            if (chars.length >= 4 && shouldTypo(ch)) {
                typos++;
                await this.pressChar(typoFor(ch));
                await pause(clampedGaussian(220, 70, 120, 420));
                await this.pressKey(describeKey('Backspace')!, 0);
                await pause(clampedGaussian(140, 50, 70, 300));
            }
            await this.pressChar(ch);
            prev = ch;
        }
        return { chars: chars.length, typos };
    }

    /** Enter/leave agent takeover: show the soft cursor and mark the tab (🔴). */
    setTakeover(on: boolean): void {
        if (this.takenOver === on) return;
        this.takenOver = on;
        this.body.classList.toggle('browser-pane-taken-over', on);
        if (on) void this.cursor.ensure();
        else void this.cursor.hide();
        document.dispatchEvent(new CustomEvent(PANE_TITLE_CHANGED_EVENT));
    }

    setTabVisible(visible: boolean): void {
        this.tabVisible = visible;
        this.scheduleSync();
    }

    /**
     * Whether the webview should be on screen right now: this tab is active,
     * the stage actually has a box (panel not collapsed) and nothing is
     * floating over the page.
     */
    private shouldShow(): boolean {
        return this.tabVisible && !isOverlayOpen() && this.stage.isConnected && !this.disposed;
    }

    private scheduleSync(): void {
        if (this.syncQueued || this.disposed) return;
        this.syncQueued = true;
        // One sync per frame: resize, scroll and visibility often fire together.
        requestAnimationFrame(() => {
            this.syncQueued = false;
            void this.sync();
        });
    }

    private stageBounds(): Bounds | null {
        const rect = this.stage.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return null;
        return {
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
        };
    }

    private async sync(): Promise<void> {
        if (this.disposed) return;
        const bounds = this.stageBounds();
        const show = this.shouldShow() && bounds !== null;

        if (!this.created) {
            // Nothing to size a webview against yet; try again when we have a box.
            if (!show || !bounds) return;
            await this.create(bounds);
            return;
        }

        try {
            if (show && bounds) {
                const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
                if (key !== this.lastBounds) {
                    this.lastBounds = key;
                    await invoke('browser_view_set_bounds', { label: this.label, ...bounds });
                }
            }
            if (show !== this.shown) {
                this.shown = show;
                await invoke('browser_view_set_visible', { label: this.label, visible: show });
            }
        } catch (error) {
            this.setStatus(t('browser.unavailable', String(error)));
        }
    }

    private async create(bounds: Bounds): Promise<void> {
        if (this.creating || this.created) return;
        this.creating = true;
        try {
            const result = await invoke<CreateResult>('browser_view_create', {
                label: this.label,
                url: this.currentUrl,
                ...bounds,
            });
            this.created = true;
            this.shown = true;
            this.lastBounds = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
            void this.installRecorder();
            // A re-adopted webview may have navigated while this pane was
            // suspended; take its word for where it is.
            if (!result.created && result.url) {
                this.onNavigated({ label: this.label, url: result.url, kind: 'finished' });
            }
            this.hint.style.display = this.currentUrl === DEFAULT_URL ? '' : 'none';
            this.setStatus(null);
            // Layout may have moved on while the webview was being created.
            this.scheduleSync();
        } catch (error) {
            this.setStatus(t('browser.unavailable', String(error)));
        } finally {
            this.creating = false;
        }
    }

    private async command(name: 'browser_view_back' | 'browser_view_forward' | 'browser_view_reload'): Promise<void> {
        if (!this.created) return;
        try {
            await invoke(name, { label: this.label });
        } catch (error) {
            this.setStatus(t('browser.unavailable', String(error)));
        }
    }

    /** Public entry for the agent bridge to point a freshly opened tab at a URL. */
    openUrl(url: string): void {
        const normalized = this.normalizeUrl(url.trim());
        if (normalized) void this.navigate(normalized);
    }

    private async navigate(url: string): Promise<void> {
        this.currentUrl = url;
        rememberUrl(this.pane.id, url);
        this.addressEdited = false;
        this.setStatus(t('browser.loading'));

        if (!this.created) {
            // The webview is created at this URL as soon as the stage has a box.
            this.scheduleSync();
            return;
        }
        try {
            await invoke('browser_view_navigate', { label: this.label, url });
        } catch (error) {
            this.setStatus(t('browser.navigate_failed', String(error)));
        }
    }

    dispose(reason: PaneUnmountReason): void {
        this.disposed = true;
        if (controllersByLabel.get(this.label) === this) controllersByLabel.delete(this.label);
        this.resizeObserver?.disconnect();
        window.removeEventListener('resize', this.onWindowChange);
        document.removeEventListener('scroll', this.onWindowChange, true);
        this.unlistenOverlay?.();
        this.unlistenNavigation?.();
        this.unlistenDownload?.();

        if (this.created) {
            if (reason === 'closed') {
                rememberUrl(this.pane.id, null);
                void invoke('browser_view_close', { label: this.label }).catch(() => undefined);
            } else {
                // Suspended: keep the page alive, just get it off the screen.
                void invoke('browser_view_set_visible', { label: this.label, visible: false }).catch(() => undefined);
            }
        } else if (reason === 'closed') {
            rememberUrl(this.pane.id, null);
        }

        this.body.classList.remove('browser-pane');
        this.body.innerHTML = '';
    }
}
