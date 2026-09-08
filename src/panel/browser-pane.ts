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
import type { GatewayClient, GatewayMessage } from '../gateway-client';

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
                    const result = await controller.cdp(String(p.method || ''), (p.params as Record<string, unknown>) || {});
                    reply(id, { ok: true, result });
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

interface AgentActPayload {
    kind?: string;
    x?: number;
    y?: number;
    /** Drag end point. */
    x2?: number;
    y2?: number;
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
const RECORDER_SOURCE = `(()=>{if(window.__ofxRec)return;const rec={console:[],network:[],installedAt:Date.now()};const cap=(a,n)=>{while(a.length>n)a.shift();};const fmt=(a)=>{try{if(typeof a==='string')return a;if(a instanceof Error)return a.stack||a.message;return JSON.stringify(a);}catch(e){return String(a);}};for(const level of ['error','warn','info','log','debug']){const orig=console[level];console[level]=function(...args){try{rec.console.push({t:Date.now(),level,text:args.map(fmt).join(' ').slice(0,1000)});cap(rec.console,200);}catch(e){}return orig.apply(this,args);};}window.addEventListener('error',e=>{rec.console.push({t:Date.now(),level:'error',text:'Uncaught '+(e.message||'')+' @'+(e.filename||'')+':'+(e.lineno||0)});cap(rec.console,200);});window.addEventListener('unhandledrejection',e=>{rec.console.push({t:Date.now(),level:'error',text:'Unhandled rejection: '+fmt(e.reason)});cap(rec.console,200);});const pushNet=(e)=>{rec.network.push(e);cap(rec.network,100);};const snippet=async(res)=>{try{const ct=res.headers.get('content-type')||'';if(!/json|text/.test(ct))return '';const txt=await res.clone().text();return txt.slice(0,400);}catch(e){return '';}};const of=window.fetch;if(of){window.fetch=async function(input,init){const start=Date.now();const url=typeof input==='string'?input:(input&&input.url)||String(input);const method=((init&&init.method)||(input&&input.method)||'GET').toUpperCase();try{const res=await of.apply(this,arguments);const e={t:start,kind:'fetch',method,url,status:res.status,ok:res.ok,ms:Date.now()-start};if(!res.ok||/json/.test(res.headers.get('content-type')||''))e.response=await snippet(res);pushNet(e);return res;}catch(err){pushNet({t:start,kind:'fetch',method,url,status:0,ok:false,ms:Date.now()-start,error:fmt(err)});throw err;}};}const XO=XMLHttpRequest.prototype.open,XS=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.open=function(m,u){this.__ofx={method:String(m).toUpperCase(),url:String(u)};return XO.apply(this,arguments);};XMLHttpRequest.prototype.send=function(){const x=this;const start=Date.now();x.addEventListener('loadend',()=>{try{const ct=x.getResponseHeader('content-type')||'';const e={t:start,kind:'xhr',method:(x.__ofx||{}).method,url:(x.__ofx||{}).url,status:x.status,ok:x.status>=200&&x.status<300,ms:Date.now()-start};if(x.status===0)e.error='network error / blocked';if((!e.ok||/json/.test(ct))&&x.responseType!=='blob'&&x.responseType!=='arraybuffer')e.response=String(x.responseText||'').slice(0,400);pushNet(e);}catch(e){}});return XS.apply(this,arguments);};window.__ofxRec=rec;})();`;

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
    private unlistenOverlay: (() => void) | null = null;

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

        this.toolbar.append(this.backBtn, this.forwardBtn, this.reloadBtn, this.address);

        // The stage is only a placeholder; the native webview is positioned
        // over it by the Rust side. The hint shows through until a page loads.
        this.stage.className = 'browser-pane-stage';
        this.hint.className = 'browser-pane-stage-hint';
        this.hint.textContent = t('browser.hint_empty');
        this.stage.append(this.hint);

        this.status.className = 'browser-pane-status';
        this.status.style.display = 'none';

        body.append(this.toolbar, this.stage, this.status);
        this.wire();
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
    async cdp(method: string, params: Record<string, unknown>): Promise<unknown> {
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
            const expr = `(()=>{let el=document.elementFromPoint(${x},${y});while(el){if(el.draggable===true||el.getAttribute&&el.getAttribute('draggable')==='true')return true;el=el.parentElement;}return false;})()`;
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
        const expr = `(()=>{
            let src=document.elementFromPoint(${x1},${y1});
            while(src&&!(src.draggable===true||(src.getAttribute&&src.getAttribute('draggable')==='true')))src=src.parentElement;
            const tgt=document.elementFromPoint(${x2},${y2});
            if(!src||!tgt)return 'no_el';
            const dt=new DataTransfer();
            const fire=(el,type,cx,cy)=>{const ev=new DragEvent(type,{bubbles:true,cancelable:true,composed:true,dataTransfer:dt,clientX:cx,clientY:cy});el.dispatchEvent(ev);};
            fire(src,'dragstart',${x1},${y1});
            fire(tgt,'dragenter',${x2},${y2});
            fire(tgt,'dragover',${x2},${y2});
            fire(tgt,'drop',${x2},${y2});
            fire(src,'dragend',${x2},${y2});
            return 'ok';
        })()`;
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
        const x = Number(payload.x) || 0;
        const y = Number(payload.y) || 0;

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
            return {};
        }
        if (kind === 'drag') {
            const x2 = Number(payload.x2) || x;
            const y2 = Number(payload.y2) || y;
            if (IS_MAC) {
                // WKWebView's native drag events read the physical mouse-button
                // state. Use an explicit DOM drag instead of reporting a native
                // drag that the page received with buttons=0.
                await this.humanMove(x, y);
                const result = await this.cdp('OpenFlux.drag', { x, y, x2, y2 });
                this.cursorX = x2;
                this.cursorY = y2;
                await this.cursor.move(x2, y2);
                return { ...(result as Record<string, unknown>), inputMode: 'dom', isTrusted: false };
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
            return {};
        }
        if (kind === 'scroll') {
            // Scroll at the cursor's current spot (move there first if given).
            if (payload.x !== undefined || payload.y !== undefined) await this.humanMove(x, y);
            const result = await this.cdp(IS_MAC ? 'OpenFlux.scroll' : 'Input.dispatchMouseEvent', {
                type: 'mouseWheel',
                x: this.cursorX,
                y: this.cursorY,
                deltaX: Number(payload.deltaX) || 0,
                deltaY: Number(payload.deltaY) || 0,
            });
            return IS_MAC ? { ...(result as Record<string, unknown>), inputMode: 'dom' } : {};
        }
        if (kind === 'type') {
            await this.cdp('Input.insertText', { text: String(payload.text ?? '') });
            return {};
        }
        if (kind === 'key') {
            const key = String(payload.key ?? '');
            const modifiers = Number(payload.modifiers) || 0;
            await this.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, modifiers });
            await this.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, modifiers });
            return {};
        }
        throw new Error(`unknown act kind: ${kind}`);
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
