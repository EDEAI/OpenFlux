/**
 * browser_control — let the agent operate the panel's embedded browser tabs.
 *
 * The tab is a real embedded webview the user can see. Every action is
 * delivered through the desktop window to that same webview: WebView2 CDP
 * on Windows, WKWebView evaluation and native input on macOS. A soft cursor
 * moves inside the page without moving the OS pointer or opening a debug port.
 *
 * The agent works from `snapshot`: a numbered list of the visible interactive
 * elements with their on-page centre. It then clicks by `ref` (the number) or
 * by `text`. Coordinates are resolved here from the last snapshot so the model
 * never does pixel math.
 */

import type { Tool, ToolExecutionContext, ToolResult } from '../types';

/** Sends one op to the desktop window and resolves with its result payload. */
export type BrowserViewRequest = (
    op: string,
    payload?: Record<string, unknown>,
    timeoutMs?: number,
    sessionId?: string,
) => Promise<any>;

export interface BrowserControlToolOptions {
    request: BrowserViewRequest;
}

interface TabInfo { label: string; url: string; title: string; active: boolean }
interface SnapEl { ref: number; tag: string; type: string; name: string; x: number; y: number; draggable?: boolean }

const SNAPSHOT_EXPR = `(()=>{
  const sel='a[href],button,input,textarea,select,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=listitem],[onclick],summary,[contenteditable=true],[draggable="true"],.draggable,li[class*=drag],li[class*=sortable]';
  const out=[];const seen=new Set();
  for(const e of document.querySelectorAll(sel)){
    if(seen.has(e))continue;seen.add(e);
    const r=e.getBoundingClientRect();
    if(r.width<2||r.height<2)continue;
    if(r.bottom<0||r.top>innerHeight||r.right<0||r.left>innerWidth)continue;
    const cs=getComputedStyle(e);
    if(cs.visibility==='hidden'||cs.display==='none'||+cs.opacity===0)continue;
    let name=(e.getAttribute('aria-label')||e.value||e.placeholder||e.innerText||e.textContent||'').replace(/\\s+/g,' ').trim().slice(0,80);
    const tag=e.tagName.toLowerCase();
    // A draggable element is worth listing even without a name so drag has a ref.
    const draggable=e.getAttribute('draggable')==='true'||e.draggable===true;
    const keepUnnamed=tag==='input'||tag==='textarea'||draggable;
    if(!name && !keepUnnamed)continue;
    if(!name)name='('+tag+')';
    out.push({ref:out.length,tag,type:e.type||'',name,draggable,x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});
    if(out.length>=120)break;
  }
  return JSON.stringify({url:location.href,title:document.title,text:(document.body?.innerText||'').slice(0,12000),elements:out});
})()`;

export function createBrowserControlTool(options: BrowserControlToolOptions): Tool {
    const { request } = options;
    // Last snapshot per tab label, so click-by-ref can resolve coordinates.
    const lastSnapshot = new Map<string, SnapEl[]>();

    async function listTabs(send: BrowserViewRequest): Promise<TabInfo[]> {
        const res = await send('list');
        return (res?.tabs as TabInfo[]) ?? [];
    }

    async function resolveLabel(send: BrowserViewRequest, requested?: string, autoOpen?: { url?: string }): Promise<{ label: string; tabs: TabInfo[] }> {
        const tabs = await listTabs(send);
        if (tabs.length === 0) {
            if (autoOpen) {
                // Open a browser tab in the panel ourselves rather than asking
                // the user to. Returns the new tab's label.
                const opened = await send('open', autoOpen.url ? { url: autoOpen.url } : {});
                const label = String(opened?.label || '');
                if (!label) throw new Error('no_browser_tab');
                return { label, tabs: [] };
            }
            throw new Error('no_browser_tab');
        }
        if (requested) {
            const found = tabs.find(t => t.label === requested);
            if (!found) throw new Error(`tab not found: ${requested}`);
            return { label: found.label, tabs };
        }
        const active = tabs.find(t => t.active) ?? tabs[0];
        return { label: active.label, tabs };
    }

    async function cdp(send: BrowserViewRequest, label: string, method: string, params: Record<string, unknown> = {}): Promise<any> {
        const res = await send('cdp', { label, method, params });
        return res?.result;
    }

    async function evaluate(send: BrowserViewRequest, label: string, expression: string): Promise<any> {
        const res = await cdp(send, label, 'Runtime.evaluate', { expression, returnByValue: true });
        if (res?.exceptionDetails) {
            throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'Page evaluation failed');
        }
        return res?.result?.value;
    }

    async function snapshot(send: BrowserViewRequest, label: string): Promise<{ url: string; title: string; text: string; elements: SnapEl[] }> {
        const raw = await evaluate(send, label, SNAPSHOT_EXPR);
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!parsed || typeof parsed.url !== 'string' || !Array.isArray(parsed.elements)) {
            throw new Error('The embedded page did not return a snapshot. Wait for the page to load and retry this tab.');
        }
        const elements: SnapEl[] = parsed.elements;
        lastSnapshot.set(label, elements);
        return { url: parsed.url, title: parsed.title ?? '', text: parsed.text ?? '', elements };
    }

    function elementList(elements: SnapEl[]): string {
        return elements
            .map(e => `[${e.ref}] <${e.tag}${e.type ? ' ' + e.type : ''}>${e.draggable ? ' (draggable)' : ''} ${e.name}`.trim())
            .join('\n');
    }

    /** Resolve an on-page point from x,y or from ref/text against the last snapshot. */
    async function resolveTarget(send: BrowserViewRequest, label: string, args: Record<string, unknown>): Promise<{ x: number; y: number }> {
        const x = Number(args.x);
        const y = Number(args.y);
        if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
        const els = lastSnapshot.get(label) ?? (await snapshot(send, label)).elements;
        let target: SnapEl | undefined;
        if (args.ref !== undefined) target = els.find(e => e.ref === Number(args.ref));
        else if (args.text) {
            const needle = String(args.text).toLowerCase();
            target = els.find(e => e.name.toLowerCase().includes(needle));
        }
        if (!target) throw new Error('no_target');
        return { x: target.x, y: target.y };
    }

    /** CDP modifier bitmask from names: Alt=1, Ctrl=2, Meta=4, Shift=8. */
    function modifierMask(mods: unknown): number {
        const names = Array.isArray(mods) ? mods : typeof mods === 'string' ? mods.split('+') : [];
        let mask = 0;
        for (const raw of names) {
            const m = String(raw).trim().toLowerCase();
            if (m === 'alt') mask |= 1;
            else if (m === 'ctrl' || m === 'control') mask |= 2;
            else if (m === 'meta' || m === 'cmd' || m === 'command' || m === 'win') mask |= 4;
            else if (m === 'shift') mask |= 8;
        }
        return mask;
    }

    return {
        name: 'browser_control',
        priority: 14,
        description: [
            'DEFAULT INTERACTIVE BROWSER: the browser the user sees embedded in OpenFlux\'s right panel on Windows and macOS.',
            'Use this for requests to open a website, browse, or click/type in a browser the user watches; it opens a tab in the panel instead of a separate Chrome or Edge window.',
            'Conversation-bound browsing uses this same right-panel browser for both interactive and scheduled runs, so the result stays in the task conversation and does not open an external browser.',
            'When asked to inspect an already open page, use list_tabs then snapshot with its tab label and preserve its URL and login session. If control of that tab fails, report the error instead of silently substituting a different browser or inferring the original tab is logged out. The separate browser tool is exposed only when browser_control is absent from the run.',
            'Input is injected safely with a visible cursor along a real path; it never moves the real mouse/keyboard.',
            'navigate opens a tab automatically if none is open. Typical flow: navigate → snapshot → click (by ref) / type (ref + text) → snapshot again. Call end when finished.',
            'type ALWAYS takes the ref of the field: it clicks the field to focus it, enters the text, and verifies the value landed (an error means the widget is custom — pick options with click/select_option instead). Dialogs/drawers: take a snapshot after opening them; their fields appear as new refs.',
            'For drag-and-drop: snapshot (draggable items are marked "(draggable)"), then drag with ref=source and toRef=destination. Also available: double_click, right_click, hover, scroll (deltaY), select_option, press_key (+modifiers).',
            'On macOS hover, scroll and drag use page DOM operations; drag/hover events are not trusted and CSS-only hover may not activate. Check the next snapshot to confirm the website accepted the action; some sites require trusted input.',
            'wait_for blocks until a condition holds (text: page text contains; urlContains: URL contains; networkIdle: requests settled) and then returns a fresh snapshot; on timeout it reports what the page showed instead. Use it after clicks that trigger loading rather than guessing with fixed delays.',
            'DEBUGGING A PAGE: console returns the page\'s console output and uncaught errors; network returns recent fetch/XHR requests with status, timing and a response snippet. After an action that "did nothing" (a click with no visible change, a form that stays put), call console and network before guessing — do not ask the user to open DevTools. A backend endpoint answering curl does not prove the page works; verify in the page.',
        ].join(' '),
        parameters: {
            action: {
                type: 'string',
                required: true,
                description: 'What to do.',
                enum: ['list_tabs', 'navigate', 'snapshot', 'click', 'double_click', 'right_click', 'hover', 'scroll', 'drag', 'select_option', 'type', 'press_key', 'wait_for', 'console', 'network', 'end'],
            },
            tab: { type: 'string', description: 'Target tab label (from list_tabs). Defaults to the active browser tab.' },
            url: { type: 'string', description: 'For navigate: the URL to open.' },
            ref: { type: 'number', description: 'Target element: the [number] from the latest snapshot (for click/double_click/right_click/hover/drag/select_option, and for type: the field to fill — always pass it).' },
            text: { type: 'string', description: 'Match an element by its text instead of ref; or for type: the text to enter.' },
            clear: { type: 'boolean', description: 'For type: select-all + delete the current value of the field before typing (also used by console/network to clear recorded entries).' },
            x: { type: 'number', description: 'Page x (use ref/text instead when possible).' },
            y: { type: 'number', description: 'Page y.' },
            toRef: { type: 'number', description: 'For drag: the destination element ref.' },
            toX: { type: 'number', description: 'For drag: destination x (if not using toRef).' },
            toY: { type: 'number', description: 'For drag: destination y.' },
            deltaY: { type: 'number', description: 'For scroll: vertical amount, positive = down (default 600).' },
            deltaX: { type: 'number', description: 'For scroll: horizontal amount, positive = right (default 0).' },
            value: { type: 'string', description: 'For select_option: the option label or value to choose.' },
            key: { type: 'string', description: 'For press_key: e.g. Enter, Tab, Escape, ArrowDown, a.' },
            modifiers: { type: 'array', description: 'For press_key: held modifiers, e.g. ["Control"] or ["Control","Shift"].', items: { type: 'string' } },
            limit: { type: 'number', description: 'For console/network: how many most-recent entries to return (default 60 / 40).' },
            urlContains: { type: 'string', description: 'For wait_for: wait until the page URL contains this text.' },
            networkIdle: { type: 'boolean', description: 'For wait_for: wait until no fetch/XHR has started for ~800ms.' },
            timeoutSeconds: { type: 'number', description: 'For wait_for: give up after this many seconds (default 15, max 120).' },
        },

        async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
            const action = String(args.action || '');
            // The desktop keeps a separate right-panel layout for every
            // conversation. Carry the owning session on every bridge message
            // so a background/scheduled run can never operate whichever chat
            // happens to be visible instead.
            const send: BrowserViewRequest = (op, payload, timeoutMs) =>
                request(op, payload, timeoutMs, context?.sessionId);
            try {
                if (action === 'list_tabs') {
                    const tabs = await listTabs(send);
                    if (tabs.length === 0) {
                        return { success: true, data: 'No browser tab is open. Call navigate with a URL to open one automatically in the right panel.' };
                    }
                    const lines = tabs.map(t => `${t.active ? '*' : ' '} ${t.label}  ${t.title || t.url || '(blank)'}  ${t.url}`).join('\n');
                    return { success: true, data: `Open browser tabs:\n${lines}` };
                }

                // navigate opens a tab if none exists; other actions need one already open.
                const autoOpen = action === 'navigate' ? { url: String(args.url || '') } : undefined;
                const { label } = await resolveLabel(send, args.tab ? String(args.tab) : undefined, autoOpen);

                // A tab may already exist while its pane is inactive or the
                // right panel is collapsed. Reveal and activate it before any
                // native operation so the embedded WebView gets real bounds
                // and can be created without user intervention.
                if (action !== 'end') await send('prepare', { label });

                // Any action means the agent is driving: mark the tab.
                await send('takeover', { label, on: true }).catch(() => undefined);

                if (action === 'navigate') {
                    const url = String(args.url || '').trim();
                    if (!url) return { success: false, error: 'url is required for navigate' };
                    await cdp(send, label, 'Page.navigate', { url: /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}` });
                    // Give the page a moment, then snapshot so the agent can act.
                    await new Promise(r => setTimeout(r, 1200));
                    const snap = await snapshot(send, label);
                    return { success: true, data: `Navigated to ${snap.url}\nTitle: ${snap.title}\nPage text:\n${snap.text}\nInteractive elements:\n${elementList(snap.elements)}` };
                }

                if (action === 'snapshot') {
                    const snap = await snapshot(send, label);
                    return { success: true, data: `${snap.url}\nTitle: ${snap.title}\nPage text:\n${snap.text}\nInteractive elements:\n${elementList(snap.elements)}` };
                }

                if (action === 'click' || action === 'double_click' || action === 'right_click' || action === 'hover') {
                    const kind = action === 'click' ? 'click'
                        : action === 'double_click' ? 'double_click'
                        : action === 'right_click' ? 'right_click' : 'hover';
                    const { x, y } = await resolveTarget(send, label, args);
                    const result = await send('act', { label, kind, x, y });
                    const note = action === 'hover' && result?.inputMode === 'dom'
                        ? ' DOM hover events were delivered; CSS-only hover may not activate. Check another snapshot for the result.' : '';
                    return { success: true, data: `${action} at (${Math.round(x)}, ${Math.round(y)}).${note}` };
                }

                if (action === 'scroll') {
                    // Optionally place the pointer over a specific element first.
                    const at = (args.ref !== undefined || args.text || args.x !== undefined)
                        ? await resolveTarget(send, label, args).catch(() => undefined)
                        : undefined;
                    const deltaY = args.deltaY !== undefined ? Number(args.deltaY) : 600;
                    const deltaX = Number(args.deltaX) || 0;
                    await send('act', { label, kind: 'scroll', deltaX, deltaY, ...(at ? { x: at.x, y: at.y } : {}) });
                    return { success: true, data: `Scrolled (dx=${deltaX}, dy=${deltaY}).` };
                }

                if (action === 'drag') {
                    const from = await resolveTarget(send, label, args);
                    let toX = Number(args.toX);
                    let toY = Number(args.toY);
                    if (!Number.isFinite(toX) || !Number.isFinite(toY)) {
                        if (args.toRef === undefined) return { success: false, error: 'drag needs a destination: toRef or toX/toY' };
                        const dest = await resolveTarget(send, label, { ref: args.toRef });
                        toX = dest.x; toY = dest.y;
                    }
                    const result = await send('act', { label, kind: 'drag', x: from.x, y: from.y, x2: toX, y2: toY });
                    const note = result?.inputMode === 'dom'
                        ? ' DOM drag events were delivered (isTrusted=false); take another snapshot to confirm the page accepted the drop.' : '';
                    return { success: true, data: `Dragged (${Math.round(from.x)}, ${Math.round(from.y)}) → (${Math.round(toX)}, ${Math.round(toY)}).${note}` };
                }

                if (action === 'select_option') {
                    const value = String(args.value ?? '');
                    if (!value) return { success: false, error: 'value is required for select_option' };
                    const { x, y } = await resolveTarget(send, label, args);
                    // Find the <select> under the point and set it, firing input+change.
                    const expr = `(()=>{let el=document.elementFromPoint(${x},${y});while(el&&el.tagName!=='SELECT')el=el.parentElement;if(!el)return 'no_select';const v=${JSON.stringify(value)};const opt=[...el.options].find(o=>o.value===v||o.label===v||o.text.trim()===v);if(!opt)return 'no_option';el.value=opt.value;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return 'ok:'+opt.text.trim();})()`;
                    const res = await cdp(send, label, 'Runtime.evaluate', { expression: expr, returnByValue: true });
                    const out = String((res as { result?: { value?: unknown } })?.result?.value ?? '');
                    if (out.startsWith('ok:')) return { success: true, data: `Selected: ${out.slice(3)}` };
                    if (out === 'no_select') return { success: false, error: 'No <select> at that element; use click to open a custom dropdown instead.' };
                    if (out === 'no_option') return { success: false, error: `No option matching "${value}".` };
                    return { success: false, error: 'select_option failed' };
                }

                if (action === 'wait_for') {
                    const wantText = typeof args.text === 'string' ? args.text.trim() : '';
                    const wantUrl = typeof args.urlContains === 'string' ? args.urlContains.trim() : '';
                    const wantIdle = args.networkIdle === true;
                    if (!wantText && !wantUrl && !wantIdle) return { success: false, error: 'wait_for needs text, urlContains or networkIdle' };
                    const timeoutSeconds = Math.min(120, Math.max(1, Number(args.timeoutSeconds) || 15));
                    const deadline = Date.now() + timeoutSeconds * 1000;
                    const probeExpr = `(()=>{const r=window.__ofxRec;const last=r&&r.network.length?r.network[r.network.length-1].t:0;return JSON.stringify({url:location.href,hasText:${JSON.stringify(wantText)}?(document.body?document.body.innerText:'').includes(${JSON.stringify(wantText)}):true,idleMs:last?Date.now()-last:999999});})()`;
                    let observed: { url: string; hasText: boolean; idleMs: number } | undefined;
                    while (Date.now() < deadline) {
                        const res = await cdp(send, label, 'Runtime.evaluate', { expression: probeExpr, returnByValue: true }).catch(() => undefined);
                        const raw = (res as { result?: { value?: unknown } })?.result?.value;
                        if (typeof raw === 'string') {
                            try { observed = JSON.parse(raw); } catch { observed = undefined; }
                        }
                        if (observed) {
                            const textOk = !wantText || observed.hasText;
                            const urlOk = !wantUrl || observed.url.includes(wantUrl);
                            const idleOk = !wantIdle || observed.idleMs >= 800;
                            if (textOk && urlOk && idleOk) {
                                const snap = await snapshot(send, label);
                                return { success: true, data: `Condition met after ${Math.round((timeoutSeconds * 1000 - (deadline - Date.now())) / 1000)}s.\n${snap.url}\nTitle: ${snap.title}\nPage text:\n${snap.text}\nInteractive elements:\n${elementList(snap.elements)}` };
                            }
                        }
                        await new Promise(r => setTimeout(r, 300));
                    }
                    const snap = await snapshot(send, label).catch(() => undefined);
                    return {
                        success: false,
                        error: `wait_for timed out after ${timeoutSeconds}s (${[wantText ? `text "${wantText}" not found` : '', wantUrl ? `URL does not contain "${wantUrl}" (now ${observed?.url ?? 'unknown'})` : '', wantIdle ? 'network still active' : ''].filter(Boolean).join('; ')}).${snap ? `\nPage now: ${snap.url} — ${snap.title}\n${snap.text.slice(0, 600)}` : ''}`,
                    };
                }

                if (action === 'console' || action === 'network') {
                    const limit = Math.max(1, Math.min(200, Number(args.limit) || (action === 'console' ? 60 : 40)));
                    const list = action === 'console' ? 'r.console' : 'r.network';
                    const expr = `(()=>{const r=window.__ofxRec;if(!r)return null;const out=${list}.slice(-${limit});${args.clear ? `${list}.length=0;` : ''}return JSON.stringify({url:location.href,total:${list}.length,items:out});})()`;
                    const res = await cdp(send, label, 'Runtime.evaluate', { expression: expr, returnByValue: true });
                    const raw = (res as { result?: { value?: unknown } })?.result?.value;
                    if (typeof raw !== 'string') {
                        return { success: true, data: 'The page recorder is not active on this page yet (it is installed on navigation). Call navigate to (re)load the page, repeat the action, then call console/network again.' };
                    }
                    const parsed = JSON.parse(raw) as { url: string; total: number; items: Array<Record<string, unknown>> };
                    if (!parsed.items.length) {
                        return { success: true, data: `${parsed.url}\n${action === 'console' ? 'No console output or errors recorded since the page loaded.' : 'No fetch/XHR requests recorded since the page loaded — the action did not trigger a request (check the click target / form submit).'}` };
                    }
                    const time = (t: unknown) => new Date(Number(t)).toISOString().slice(11, 23);
                    const lines = action === 'console'
                        ? parsed.items.map(i => `${time(i.t)} [${String(i.level).toUpperCase()}] ${i.text}`)
                        : parsed.items.map(i => `${time(i.t)} ${i.method} ${i.url} → ${i.status}${i.ok ? '' : ' ✗'} ${i.ms}ms${i.error ? ` error: ${i.error}` : ''}${i.response ? `\n    response: ${String(i.response).replace(/\s+/g, ' ').slice(0, 400)}` : ''}`);
                    return { success: true, data: `${parsed.url}\n${action === 'console' ? 'Console' : 'Network'} (last ${parsed.items.length} of ${parsed.total}):\n${lines.join('\n')}` };
                }

                if (action === 'type') {
                    const text = String(args.text ?? '');
                    if (!text) return { success: false, error: 'text is required for type' };
                    // Text goes to the focused element, so focus the target first
                    // when one is given (ref or x/y). Typing "into nothing" used to
                    // report success while the form stayed empty.
                    const hasTarget = args.ref !== undefined || args.x !== undefined;
                    if (hasTarget) {
                        const { x, y } = await resolveTarget(send, label, { ref: args.ref, x: args.x, y: args.y });
                        await send('act', { label, kind: 'click', x, y });
                        await new Promise(r => setTimeout(r, 120));
                        if (args.clear === true) {
                            await send('act', { label, kind: 'key', key: 'a', modifiers: 2 });
                            await send('act', { label, kind: 'key', key: 'Backspace', modifiers: 0 });
                        }
                    }
                    await send('act', { label, kind: 'type', text });
                    // Verify the text actually landed in an editable field.
                    const check = await cdp(send, label, 'Runtime.evaluate', {
                        expression: `(()=>{const el=document.activeElement;if(!el||el===document.body)return JSON.stringify({tag:'none',value:''});const v=('value' in el)?String(el.value??''):(el.isContentEditable?String(el.textContent??''):'');return JSON.stringify({tag:el.tagName.toLowerCase()+(el.type?'['+el.type+']':''),value:v.slice(-400),readOnly:!!el.readOnly});})()`,
                        returnByValue: true,
                    }).catch(() => undefined);
                    let landed: { tag: string; value: string; readOnly?: boolean } | undefined;
                    try { landed = JSON.parse(String((check as { result?: { value?: unknown } })?.result?.value ?? '')); } catch { /* page blocked evaluation */ }
                    if (landed && !landed.value.includes(text.slice(-Math.min(text.length, 20)))) {
                        return {
                            success: false,
                            error: landed.tag === 'none'
                                ? `Nothing is focused, so the text was not entered. Call type with the field's ref (from the latest snapshot) so it is clicked first.`
                                : `Text did not land in <${landed.tag}>${landed.readOnly ? ' (read-only)' : ''} (value now: "${landed.value.slice(-60)}"). It is probably a custom widget (dropdown/date picker/number input): click it and pick an option with click/select_option, or use press_key.`,
                        };
                    }
                    return { success: true, data: `Typed into <${landed?.tag ?? 'field'}>: ${text}` };
                }

                if (action === 'press_key') {
                    const key = String(args.key || '');
                    if (!key) return { success: false, error: 'key is required for press_key' };
                    const modifiers = modifierMask(args.modifiers);
                    await send('act', { label, kind: 'key', key, modifiers });
                    return { success: true, data: `Pressed ${modifiers ? '(mods) ' : ''}${key}.` };
                }

                if (action === 'end') {
                    await send('takeover', { label, on: false }).catch(() => undefined);
                    return { success: true, data: 'Released the browser.' };
                }

                return { success: false, error: `unknown action: ${action}` };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (message === 'no_browser_tab') {
                    return { success: false, error: 'No browser tab is open. Call navigate with a URL to open one automatically in the right panel.' };
                }
                if (message.includes('desktop window not connected')) {
                    return { success: false, error: 'The desktop app is not connected, so the embedded browser cannot be controlled.' };
                }
                return { success: false, error: message };
            }
        },
    };
}
