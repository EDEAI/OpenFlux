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

import { mkdirSync, writeFileSync } from 'fs';
import { isAbsolute, join, resolve } from 'path';
import type { Tool, ToolExecutionContext, ToolResult } from '../types';
import { withDeepDom } from '../../browser/deep-dom';

/** Sends one op to the desktop window and resolves with its result payload. */
export type BrowserViewRequest = (
    op: string,
    payload?: Record<string, unknown>,
    timeoutMs?: number,
    sessionId?: string,
) => Promise<any>;

export interface BrowserControlToolOptions {
    request: BrowserViewRequest;
    /**
     * Output folder of the gateway. Screenshots are written to
     * `<output>/browser-screenshots/` and the panel is told to save tab
     * downloads under `<output>/downloads/`, so the agent can read them back.
     */
    getOutputPath?: () => string;
}

interface TabInfo { label: string; url: string; title: string; active: boolean }

/** One file a tab saved, as reported by the panel's `downloads` op. */
interface DownloadInfo {
    url: string;
    path: string;
    name: string;
    state: 'in_progress' | 'completed' | 'failed';
    startedAt: number;
    finishedAt?: number;
}
/**
 * One interactive element: centre plus box size so the panel can pick a
 * natural click point inside it. `frame` names the same-origin iframe chain
 * it lives in; coordinates are always top-viewport. A cross-origin iframe is
 * listed as its own opaque element (`type: 'cross-origin'`).
 */
interface SnapEl {
    ref: number; tag: string; type: string; name: string; x: number; y: number; w?: number; h?: number; draggable?: boolean; frame?: string;
    /** For a cross-origin iframe entry: its contents were listed as separate elements. */
    listed?: boolean;
}
/** A resolved target: a point, or a box when it came from a snapshot element. */
interface Target { x: number; y: number; w?: number; h?: number }
/** What the desktop knows about a tab's frames beyond the page's own script reach. */
interface FrameReport {
    /** Own-process (cross-site) iframes, each with its CDP session. */
    frames: Array<{ session: string; target_id: string; url: string; title: string }>;
    /** Main-world contexts of frames in the tab's process (main document included). */
    contexts: Array<{ context_id: number; frame_id: string; origin: string }>;
}
/** How to evaluate inside one cross-origin frame: its own session, or a context id on the tab's session. */
interface FrameHandle { session?: string; contextId?: number }
/** A cross-origin iframe the agent can read, with its content box in top-viewport coordinates. */
interface FrameBox { handle: FrameHandle; frameId: string; url: string; label: string; left: number; top: number; width: number; height: number }

/**
 * Numbered list of the visible interactive elements with top-viewport
 * centres, walking open shadow roots and same-origin iframes at any depth.
 * Cross-origin iframes are listed as opaque boxes. Exported for the jsdom
 * tests.
 */
export const SNAPSHOT_EXPR = withDeepDom(`
  const sel='a[href],button,input,textarea,select,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=listitem],[onclick],summary,[contenteditable=true],[draggable="true"],.draggable,li[class*=drag],li[class*=sortable]';
  const out=[];const seen=new Set();
  const visible=(e,r,ox,oy,clip)=>{
    if(r.width<2||r.height<2)return false;
    const l=r.left+ox,t=r.top+oy,rt=r.right+ox,b=r.bottom+oy;
    if(b<clip.t||t>clip.b||rt<clip.l||l>clip.r)return false;
    const w=(e.ownerDocument&&e.ownerDocument.defaultView)||window;
    const cs=w.getComputedStyle(e);
    return !(cs.visibility==='hidden'||cs.display==='none'||+cs.opacity===0);
  };
  outer:for(const {root,ox,oy,clip,frame} of D.allRoots()){
    for(const e of root.querySelectorAll(sel)){
      if(seen.has(e))continue;seen.add(e);
      const r=e.getBoundingClientRect();
      if(!visible(e,r,ox,oy,clip))continue;
      let name=(e.getAttribute('aria-label')||e.value||e.placeholder||e.innerText||e.textContent||'').replace(/\\s+/g,' ').trim().slice(0,80);
      const tag=e.tagName.toLowerCase();
      // A draggable element is worth listing even without a name so drag has a ref.
      const draggable=e.getAttribute('draggable')==='true'||e.draggable===true;
      const keepUnnamed=tag==='input'||tag==='textarea'||draggable;
      if(!name && !keepUnnamed)continue;
      if(!name)name='('+tag+')';
      const el={ref:out.length,tag,type:e.type||'',name,draggable,x:Math.round(r.left+ox+r.width/2),y:Math.round(r.top+oy+r.height/2),w:Math.round(r.width),h:Math.round(r.height)};
      if(frame)el.frame=frame;
      out.push(el);
      if(out.length>=120)break outer;
    }
  }
  // Frames script cannot see into: the agent can still click/scroll inside by position.
  for(const {frame,ox,oy,clip,parent} of D.opaqueFrames()){
    if(out.length>=120)break;
    const r=frame.getBoundingClientRect();
    if(!visible(frame,r,ox,oy,clip))continue;
    const el={ref:out.length,tag:'iframe',type:'cross-origin',name:(frame.src||frame.title||frame.name||'frame').slice(0,120),draggable:false,x:Math.round(r.left+ox+r.width/2),y:Math.round(r.top+oy+r.height/2),w:Math.round(r.width),h:Math.round(r.height)};
    if(parent)el.frame=parent;
    out.push(el);
  }
  return JSON.stringify({url:location.href,title:document.title,text:D.text(12000),elements:out});
`);

export function createBrowserControlTool(options: BrowserControlToolOptions): Tool {
    const { request, getOutputPath } = options;
    // Last snapshot per tab label, so click-by-ref can resolve coordinates.
    const lastSnapshot = new Map<string, SnapEl[]>();
    // Download folder the panel was last told about; re-sent when the output path changes.
    let configuredDownloadDir = '';

    /**
     * Point tab downloads at `<output>/downloads` once per output path. Runs
     * before every action so a click that triggers a download already lands
     * in the right folder. Best effort: an old desktop build without the op
     * keeps the engine's default folder.
     */
    async function ensureDownloadDir(send: BrowserViewRequest): Promise<string> {
        const base = getOutputPath?.();
        if (!base) return configuredDownloadDir;
        const dir = join(resolve(base), 'downloads');
        if (dir === configuredDownloadDir) return dir;
        try {
            const res = await send('config', { downloadDir: dir }, 5000);
            if (res?.ok) configuredDownloadDir = dir;
        } catch { /* panel not ready or older build */ }
        return configuredDownloadDir;
    }

    /** Local wall-clock time for the model and the user (matches what the panel shows). */
    function fmtLocal(ts: number): string {
        const d = new Date(ts);
        const p = (n: number) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    function formatDownloads(list: DownloadInfo[]): string {
        if (list.length === 0) return 'No downloads recorded for this tab.';
        return list.map(d => {
            const took = d.finishedAt ? ` in ${Math.max(0, Math.round((d.finishedAt - d.startedAt) / 100) / 10)}s` : '';
            const state = d.state === 'completed' ? 'completed' : d.state === 'failed' ? 'FAILED' : 'in progress';
            return `- ${d.name}  [${state}${took}]  ${d.path || '(path unknown)'}\n  from ${d.url}`;
        }).join('\n');
    }
    // Cross-origin frames per tab from the last time they were resolved, so
    // select/type/wait_for/console can address the right frame session.
    const lastFrames = new Map<string, FrameBox[]>();

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

    /**
     * Evaluate inside one cross-origin frame: through its own CDP session when
     * it runs in its own process, or through its main-world context id on the
     * tab's session when it shares the page's process.
     */
    async function evaluateIn(send: BrowserViewRequest, label: string, handle: FrameHandle, expression: string): Promise<any> {
        const res = handle.session
            ? await send('cdp', { label, method: 'Runtime.evaluate', params: { expression, returnByValue: true }, session: handle.session })
            : await send('cdp', { label, method: 'Runtime.evaluate', params: { expression, returnByValue: true, contextId: handle.contextId } });
        const result = res?.result;
        if (result?.exceptionDetails) {
            throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Frame evaluation failed');
        }
        return result?.result?.value;
    }

    /**
     * Runs on an <iframe> element (via Runtime.callFunctionOn): its content
     * box relative to its own document's viewport, whether script in that
     * document may read it, and a human label for the element list.
     */
    const FRAME_BOX_FN = `function(){const r=this.getBoundingClientRect();let sameOrigin=false;try{sameOrigin=!!this.contentDocument;}catch(e){}return JSON.stringify({left:r.left+this.clientLeft,top:r.top+this.clientTop,width:this.clientWidth,height:this.clientHeight,sameOrigin,label:this.title||this.name||this.id||''});}`;
    /** Same, but absolute: walks up through same-origin ancestor frames (for frames the frame tree does not list). */
    const FRAME_BOX_ABS_FN = `function(){const r=this.getBoundingClientRect();let left=r.left+this.clientLeft,top=r.top+this.clientTop;let win=this.ownerDocument.defaultView;for(let i=0;i<32&&win&&win!==win.top;i++){let fe=null;try{fe=win.frameElement;}catch(e){}if(!fe)break;const fr=fe.getBoundingClientRect();left+=fr.left+fe.clientLeft;top+=fr.top+fe.clientTop;win=win.parent;}return JSON.stringify({left,top,width:this.clientWidth,height:this.clientHeight,sameOrigin:false,label:this.title||this.name||this.id||''});}`;

    /** Every frame below the main one, parents before children. */
    function flattenFrameTree(tree: any): Array<{ id: string; parentId: string; url: string; name: string }> {
        const out: Array<{ id: string; parentId: string; url: string; name: string }> = [];
        const walk = (node: any) => {
            for (const child of node?.childFrames ?? []) {
                const f = child.frame ?? {};
                out.push({ id: String(f.id ?? ''), parentId: String(f.parentId ?? node?.frame?.id ?? ''), url: String(f.url ?? ''), name: String(f.name ?? '') });
                walk(child);
            }
        };
        walk(tree);
        return out;
    }

    /**
     * Cross-origin frames of the tab the agent can read, with their boxes in
     * top-viewport coordinates. Frames the page's own script can read are
     * left to the deep-DOM helpers. Each remaining frame is addressed through
     * its own session (own process) or its main-world context (same process).
     * The desktop starts tracking on the first call and reports arrive a
     * moment later, so when the page is known to have such frames we retry
     * briefly. Frames whose owner element cannot be located stay opaque.
     */
    async function frames(send: BrowserViewRequest, label: string, expected: number): Promise<FrameBox[]> {
        // Attach and context events trickle in after tracking starts: poll
        // until enough frames are known to cover what the page shows, or the
        // report stops growing.
        let report: FrameReport = { frames: [], contexts: [] };
        let previous = -1;
        for (let attempt = 0; attempt < (expected > 0 ? 6 : 1); attempt++) {
            const res = await send('frames', { label }).catch(() => undefined);
            report = { frames: Array.isArray(res?.frames) ? res.frames : [], contexts: Array.isArray(res?.contexts) ? res.contexts : [] };
            const known = report.frames.length + Math.max(0, report.contexts.length - 1);
            if (expected === 0 || known >= expected || (known > 0 && known === previous)) break;
            previous = known;
            await new Promise(r => setTimeout(r, 350));
        }
        const boxes: FrameBox[] = [];
        if (!report.frames.length && report.contexts.length <= 1) {
            lastFrames.set(label, boxes);
            return boxes;
        }
        const ownerBox = async (frameId: string, fn: string) => {
            const owner = await cdp(send, label, 'DOM.getFrameOwner', { frameId });
            const node = await cdp(send, label, 'DOM.resolveNode', { backendNodeId: owner?.backendNodeId });
            const objectId = node?.object?.objectId;
            if (!objectId) return undefined;
            const res = await cdp(send, label, 'Runtime.callFunctionOn', { objectId, functionDeclaration: fn, returnByValue: true });
            return JSON.parse(String(res?.result?.value ?? '')) as { left: number; top: number; width: number; height: number; sameOrigin: boolean; label: string };
        };
        const hostOf = (url: string) => { try { return new URL(url).host || url; } catch { return url; } };
        const placed = new Set<string>();
        try {
            const tree = await cdp(send, label, 'Page.getFrameTree');
            const mainId = String(tree?.frameTree?.frame?.id ?? '');
            await cdp(send, label, 'DOM.enable').catch(() => undefined);
            // Content origin of every frame we could place, so nested frames add up.
            const origins = new Map<string, { left: number; top: number }>([[mainId, { left: 0, top: 0 }]]);
            for (const frame of flattenFrameTree(tree?.frameTree)) {
                const parent = origins.get(frame.parentId);
                if (!parent) continue; // parent itself was not placeable
                let local: Awaited<ReturnType<typeof ownerBox>>;
                try { local = await ownerBox(frame.id, FRAME_BOX_FN); } catch { continue; }
                if (!local) continue;
                const abs = { left: parent.left + local.left, top: parent.top + local.top };
                origins.set(frame.id, abs);
                placed.add(frame.id);
                if (local.sameOrigin) continue; // the page's own script (deep-DOM helpers) already reads it
                const target = report.frames.find(f => f.target_id === frame.id);
                const context = target ? undefined : report.contexts.find(c => c.frame_id === frame.id);
                if (!target && !context) continue;
                boxes.push({
                    handle: target ? { session: target.session } : { contextId: context!.context_id },
                    frameId: frame.id, url: frame.url,
                    label: local.label || frame.name || hostOf(frame.url) || 'frame',
                    left: abs.left, top: abs.top, width: local.width, height: local.height,
                });
            }
        } catch {
            // No frame tree (page mid-navigation): fall through to the targets.
        }
        // Own-process frames are not part of the page's frame tree; their
        // owner element still is, and locates them.
        for (const target of report.frames) {
            if (placed.has(target.target_id)) continue;
            try {
                await cdp(send, label, 'DOM.enable').catch(() => undefined);
                const box = await ownerBox(target.target_id, FRAME_BOX_ABS_FN);
                if (!box) continue;
                boxes.push({
                    handle: { session: target.session }, frameId: target.target_id, url: target.url,
                    label: box.label || hostOf(target.url) || 'frame',
                    left: box.left, top: box.top, width: box.width, height: box.height,
                });
            } catch {
                // Owner lives in another own-process frame: stays opaque.
            }
        }
        lastFrames.set(label, boxes);
        return boxes;
    }

    /** Cross-origin frames as last resolved for the tab, resolving once if never done. */
    async function frameSessions(send: BrowserViewRequest, label: string): Promise<FrameBox[]> {
        return lastFrames.get(label) ?? await frames(send, label, 0);
    }

    /** The cross-origin frame whose box contains a top-viewport point. */
    function frameAt(label: string, x: number, y: number): FrameBox | undefined {
        return (lastFrames.get(label) ?? []).find(f => x >= f.left && x <= f.left + f.width && y >= f.top && y <= f.top + f.height);
    }

    async function snapshot(send: BrowserViewRequest, label: string): Promise<{ url: string; title: string; text: string; elements: SnapEl[] }> {
        const raw = await evaluate(send, label, SNAPSHOT_EXPR);
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!parsed || typeof parsed.url !== 'string' || !Array.isArray(parsed.elements)) {
            throw new Error('The embedded page did not return a snapshot. Wait for the page to load and retry this tab.');
        }
        const elements: SnapEl[] = parsed.elements;
        let text: string = parsed.text ?? '';

        // Cross-origin frames: snapshot each through its own session and fold
        // its elements in with top-viewport coordinates, clipped to the frame.
        const opaque = elements.filter(e => e.tag === 'iframe' && e.type === 'cross-origin');
        const boxes = opaque.length ? await frames(send, label, opaque.length) : [];
        for (const box of boxes) {
            let inner: { text?: string; elements?: SnapEl[] } | undefined;
            try {
                const innerRaw = await evaluateIn(send, label, box.handle, SNAPSHOT_EXPR);
                inner = typeof innerRaw === 'string' ? JSON.parse(innerRaw) : innerRaw;
            } catch {
                continue;
            }
            if (!inner || !Array.isArray(inner.elements)) continue;
            const tag = `${box.label} (cross-origin)`;
            const clip = { l: Math.max(0, box.left), t: Math.max(0, box.top), r: box.left + box.width, b: box.top + box.height };
            const entry = opaque.find(o => o.x >= clip.l && o.x <= clip.r && o.y >= clip.t && o.y <= clip.b && !o.listed);
            if (entry) entry.listed = true;
            for (const e of inner.elements) {
                const x = e.x + box.left;
                const y = e.y + box.top;
                if (x < clip.l || x > clip.r || y < clip.t || y > clip.b) continue;
                if (elements.length >= 160) break;
                elements.push({ ...e, ref: elements.length, x, y, frame: e.frame ? `${tag} > ${e.frame}` : tag });
            }
            const innerText = String(inner.text ?? '').trim();
            if (innerText) text += `\n\n[frame: ${tag}]\n${innerText.slice(0, 4000)}`;
        }
        lastSnapshot.set(label, elements);
        return { url: parsed.url, title: parsed.title ?? '', text, elements };
    }

    /**
     * Serialize the live DOM to HTML inside the page. Walks the tree itself
     * (rather than reading outerHTML) so open shadow roots are inlined as
     * `<template shadowrootmode="open">` and script/style bodies and comments
     * can be dropped. Paging is done in-page so only the requested slice
     * crosses the bridge.
     */
    type HtmlOpts = { selector: string; raw: boolean; maxChars: number; offset: number };
    type HtmlResult = { url: string; matched: number; total: number; chunk: string };

    function htmlExpr(opts: HtmlOpts): string {
        return withDeepDom(`
  const raw=${opts.raw ? 'true' : 'false'};
  const sel=${JSON.stringify(opts.selector)};
  const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const escAttr=s=>String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;');
  const voidTags=new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
  const ser=(n,out)=>{
    if(n.nodeType===3){out.push(esc(n.nodeValue));return;}
    if(n.nodeType===8){if(raw)out.push('<!--'+n.nodeValue+'-->');return;}
    if(n.nodeType!==1)return;
    const tag=n.tagName.toLowerCase();
    let s='<'+tag;
    for(const a of n.attributes)s+=' '+a.name+'="'+escAttr(a.value)+'"';
    out.push(s+'>');
    if(voidTags.has(tag))return;
    if(!raw&&(tag==='script'||tag==='style'||tag==='noscript')){out.push('</'+tag+'>');return;}
    if(n.shadowRoot){out.push('<template shadowrootmode="open">');for(const c of n.shadowRoot.childNodes)ser(c,out);out.push('</template>');}
    if(tag==='iframe'||tag==='frame'){
      // Same-origin frames are inlined so their forms are visible; others are marked.
      const d=D.sameOriginDoc(n);
      if(d){out.push('<template data-frame-document="same-origin">');ser(d.documentElement,out);out.push('</template>');}
      else out.push('<!-- cross-origin frame: contents unavailable to script -->');
    }
    if(tag==='template'&&n.content){for(const c of n.content.childNodes)ser(c,out);}
    else for(const c of n.childNodes)ser(c,out);
    out.push('</'+tag+'>');
  };
  let roots;
  if(sel){roots=D.querySelectorAll(sel,50);}
  else{roots=[document.documentElement];}
  const out=[];
  if(!sel){const dt=document.doctype;if(dt)out.push('<!DOCTYPE '+dt.name+'>\\n');}
  roots.forEach((r,i)=>{if(i)out.push('\\n\\n');ser(r,out);});
  const html=out.join('');
  return JSON.stringify({url:location.href,matched:roots.length,total:html.length,chunk:html.slice(${opts.offset},${opts.offset + opts.maxChars})});
`);
    }

    /** Serialize the main document, or one cross-origin frame when `handle` is given. */
    async function getHtml(send: BrowserViewRequest, label: string, opts: HtmlOpts, handle?: FrameHandle): Promise<HtmlResult> {
        const expr = htmlExpr(opts);
        const raw = handle ? await evaluateIn(send, label, handle, expr) : await evaluate(send, label, expr);
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!parsed || typeof parsed.url !== 'string' || typeof parsed.chunk !== 'string') {
            throw new Error('The embedded page did not return its HTML. Wait for the page to load and retry this tab.');
        }
        return { url: parsed.url, matched: Number(parsed.matched) || 0, total: Number(parsed.total) || 0, chunk: parsed.chunk };
    }

    function elementList(elements: SnapEl[]): string {
        return elements
            .map(e => {
                if (e.tag === 'iframe' && e.type === 'cross-origin') {
                    return e.listed
                        ? `[${e.ref}] <iframe cross-origin> ${e.name} — its elements are listed below as "(in frame: … (cross-origin))"${e.frame ? ` (in frame: ${e.frame})` : ''}`
                        : `[${e.ref}] <iframe cross-origin> ${e.name} — its contents could not be read; click/scroll inside it by ref or x,y${e.frame ? ` (in frame: ${e.frame})` : ''}`;
                }
                return `[${e.ref}] <${e.tag}${e.type ? ' ' + e.type : ''}>${e.draggable ? ' (draggable)' : ''} ${e.name}${e.frame ? ` (in frame: ${e.frame})` : ''}`.trim();
            })
            .join('\n');
    }

    /**
     * Resolve an on-page target from x,y or from ref/text against the last
     * snapshot. Snapshot elements carry their box so the panel can land the
     * click somewhere natural inside it rather than dead centre every time.
     */
    async function resolveTarget(send: BrowserViewRequest, label: string, args: Record<string, unknown>): Promise<Target> {
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
        const box: Target = { x: target.x, y: target.y };
        if (target.w && target.h) { box.w = target.w; box.h = target.h; }
        return box;
    }

    /** The point the panel actually used (after its in-box jitter), else the requested one. */
    function landed(result: unknown, fallback: { x: number; y: number }): { x: number; y: number } {
        const r = result as { x?: unknown; y?: unknown } | undefined;
        const x = Number(r?.x);
        const y = Number(r?.y);
        return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : fallback;
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
            'Input is injected safely with a visible cursor along a real path; it never moves the real mouse/keyboard. Actions are paced like a person (a short pause before each, clicks land at a natural spot inside the element, text is typed key by key, scrolling arrives as wheel notches), so long text takes seconds — do not retry an action just because it was slow.',
            'navigate opens a tab automatically if none is open. Typical flow: navigate → snapshot → click (by ref) / type (ref + text) → snapshot again. Call end when finished.',
            'type ALWAYS takes the ref of the field: it clicks the field to focus it, enters the text, and verifies the value landed (an error means the widget is custom — pick options with click/select_option instead). Dialogs/drawers: take a snapshot after opening them; their fields appear as new refs.',
            'For drag-and-drop: snapshot (draggable items are marked "(draggable)"), then drag with ref=source and toRef=destination. Also available: double_click, right_click, hover, scroll (deltaY), select_option, press_key (+modifiers).',
            'On macOS hover, scroll and drag use page DOM operations; drag/hover events are not trusted and CSS-only hover may not activate. Check the next snapshot to confirm the website accepted the action; some sites require trusted input.',
            'wait_for blocks until a condition holds (text: page text contains; urlContains: URL contains; networkIdle: requests settled) and then returns a fresh snapshot; on timeout it reports what the page showed instead. Use it after clicks that trigger loading rather than guessing with fixed delays.',
            'DEBUGGING A PAGE: console returns the page\'s console output and uncaught errors; network returns recent fetch/XHR requests with status, timing and a response snippet. After an action that "did nothing" (a click with no visible change, a form that stays put), call console and network before guessing — do not ask the user to open DevTools. A backend endpoint answering curl does not prove the page works; verify in the page.',
            'snapshot, get_html, select_option, type and wait_for see through open shadow DOM and same-origin iframes at any depth: elements inside a frame are listed with "(in frame: …)" and use the same page coordinates, so click/type on them by ref exactly as usual. Cross-origin iframes (payment widgets, embedded logins, ads) are read through their own browser sessions on Windows: their elements appear as "(in frame: … (cross-origin))" with page coordinates, and get_html/console/network/wait_for include them. If a cross-origin frame says its contents could not be read (or on macOS), click/scroll inside it by ref/x,y or navigate to its src URL directly.',
            'get_html returns the live DOM serialized as HTML (the whole document, or only the elements matching selector), including open shadow roots, with <script>/<style> bodies removed unless raw=true. Use it when snapshot is not enough: hidden elements, attributes (href/src/data-*), table structure, or extracting data from a page. Large pages are paged with maxChars/offset.',
            'screenshot captures the tab as a PNG (viewport by default; fullPage=true for the whole page; ref=N for one element), saves it under the output folder and attaches the image so you can look at it — use it for visual checks (layout, charts, images, captcha-like widgets) when text snapshots are not enough; prefer snapshot/get_html for reading text. Windows only for now.',
            'DOWNLOADS: files the page saves (a download link/button, an export) are written to <output>/downloads/ automatically. After the click, call downloads with wait=true to block until the file is complete and get its path, then read or process it with your file tools. downloads without wait just lists what this tab saved so far.',
            'history lists the panel browser\'s browsing history (newest first; text filters by URL/title; limit caps the count) — use it to find a page the user visited earlier instead of asking. cookies lists the cookies the current page (or url) can see; set_cookie / delete_cookies change them (delete_cookies with all=true wipes every site\'s cookies and logins — only when the user asks). Cookie actions are Windows-only for now.',
        ].join(' '),
        parameters: {
            action: {
                type: 'string',
                required: true,
                description: 'What to do.',
                enum: ['list_tabs', 'navigate', 'snapshot', 'get_html', 'screenshot', 'click', 'double_click', 'right_click', 'hover', 'scroll', 'drag', 'select_option', 'type', 'press_key', 'wait_for', 'downloads', 'history', 'cookies', 'set_cookie', 'delete_cookies', 'console', 'network', 'end'],
            },
            name: { type: 'string', description: 'For cookies/set_cookie/delete_cookies: the cookie name (cookies: filter to this name).' },
            domain: { type: 'string', description: 'For set_cookie/delete_cookies: cookie domain (default: derived from the current page URL).' },
            all: { type: 'boolean', description: 'For delete_cookies: true clears every cookie of the embedded browser (all sites). Ask the user before doing this unless they requested it.' },
            expiresInSeconds: { type: 'number', description: 'For set_cookie: lifetime in seconds (default: session cookie).' },
            fullPage: { type: 'boolean', description: 'For screenshot: capture the whole scrollable page instead of the viewport (default false). Ignored when ref/text is given.' },
            path: { type: 'string', description: 'For screenshot: where to save the PNG (absolute, or relative to the output folder). Default: <output>/browser-screenshots/<timestamp>-<tab>.png.' },
            wait: { type: 'boolean', description: 'For downloads: block until no download of this tab is in progress (default false), up to timeoutSeconds (default 60).' },
            tab: { type: 'string', description: 'Target tab label (from list_tabs). Defaults to the active browser tab.' },
            url: { type: 'string', description: 'For navigate: the URL to open. For cookies/set_cookie/delete_cookies: the page URL whose cookies to use (default: the current page).' },
            ref: { type: 'number', description: 'Target element: the [number] from the latest snapshot (for click/double_click/right_click/hover/drag/select_option/screenshot, and for type: the field to fill — always pass it).' },
            text: { type: 'string', description: 'Match an element by its text instead of ref; for type: the text to enter; for history: a filter on URL/title.' },
            clear: { type: 'boolean', description: 'For type: select-all + delete the current value of the field before typing (also used by console/network/downloads to clear recorded entries).' },
            x: { type: 'number', description: 'Page x (use ref/text instead when possible).' },
            y: { type: 'number', description: 'Page y.' },
            toRef: { type: 'number', description: 'For drag: the destination element ref.' },
            toX: { type: 'number', description: 'For drag: destination x (if not using toRef).' },
            toY: { type: 'number', description: 'For drag: destination y.' },
            deltaY: { type: 'number', description: 'For scroll: vertical amount, positive = down (default 600).' },
            deltaX: { type: 'number', description: 'For scroll: horizontal amount, positive = right (default 0).' },
            value: { type: 'string', description: 'For select_option: the option label or value to choose; for set_cookie: the cookie value.' },
            key: { type: 'string', description: 'For press_key: e.g. Enter, Tab, Escape, ArrowDown, a.' },
            modifiers: { type: 'array', description: 'For press_key: held modifiers, e.g. ["Control"] or ["Control","Shift"].', items: { type: 'string' } },
            limit: { type: 'number', description: 'For console/network: how many most-recent entries to return (default 60 / 40); for history: max entries (default 50).' },
            urlContains: { type: 'string', description: 'For wait_for: wait until the page URL contains this text.' },
            networkIdle: { type: 'boolean', description: 'For wait_for: wait until no fetch/XHR has started for ~800ms.' },
            timeoutSeconds: { type: 'number', description: 'For wait_for: give up after this many seconds (default 15, max 120); for downloads with wait=true: how long to wait for the file (default 60, max 300).' },
            selector: { type: 'string', description: 'For get_html: a CSS selector; only matching elements (up to 50) are returned. Omit for the whole document.' },
            raw: { type: 'boolean', description: 'For get_html: keep <script>/<style> contents and comments (default false); for cookies: return full cookie values instead of truncating long ones.' },
            maxChars: { type: 'number', description: 'For get_html: maximum characters to return (default 40000, max 200000).' },
            offset: { type: 'number', description: 'For get_html: character offset into the serialized HTML for paging (default 0).' },
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
                // Downloads triggered by any later click must already target the output folder.
                await ensureDownloadDir(send);
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
                    // Give the page a moment to land, plus the glance a person
                    // takes before doing anything on a new page.
                    await new Promise(r => setTimeout(r, 1200 + Math.round(500 + Math.random() * 1300)));
                    const snap = await snapshot(send, label);
                    return { success: true, data: `Navigated to ${snap.url}\nTitle: ${snap.title}\nPage text:\n${snap.text}\nInteractive elements:\n${elementList(snap.elements)}` };
                }

                if (action === 'snapshot') {
                    const snap = await snapshot(send, label);
                    return { success: true, data: `${snap.url}\nTitle: ${snap.title}\nPage text:\n${snap.text}\nInteractive elements:\n${elementList(snap.elements)}` };
                }

                if (action === 'screenshot') {
                    // WebView2 CDP on Windows. The macOS bridge only evaluates script,
                    // so Page.captureScreenshot fails there with a clear message.
                    const fullPage = args.fullPage === true;
                    const params: Record<string, unknown> = { format: 'png' };
                    let what = 'viewport';
                    if (args.ref !== undefined || args.text !== undefined) {
                        const els = lastSnapshot.get(label) ?? (await snapshot(send, label)).elements;
                        const el = args.ref !== undefined
                            ? els.find(e => e.ref === Number(args.ref))
                            : els.find(e => e.name.toLowerCase().includes(String(args.text).toLowerCase()));
                        if (!el) return { success: false, error: 'Element not found in the latest snapshot; take a snapshot first and pass its ref.' };
                        const w = Math.max(1, el.w || 1), h = Math.max(1, el.h || 1);
                        // Element boxes are page coordinates; the clip needs page coordinates too.
                        params.clip = { x: Math.max(0, el.x - w / 2), y: Math.max(0, el.y - h / 2), width: w, height: h, scale: 1 };
                        params.captureBeyondViewport = true;
                        what = `element [${el.ref}] ${el.name}`;
                    } else if (fullPage) {
                        params.captureBeyondViewport = true;
                        const metrics = await cdp(send, label, 'Page.getLayoutMetrics').catch(() => undefined);
                        const size = metrics?.cssContentSize ?? metrics?.contentSize;
                        if (size?.width && size?.height) {
                            params.clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.min(Math.ceil(size.height), 16384), scale: 1 };
                        }
                        what = 'full page';
                    }
                    let shot: { data?: string } | undefined;
                    try {
                        shot = await cdp(send, label, 'Page.captureScreenshot', params);
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        return { success: false, error: `Screenshot is not available in this embedded browser (${message}). On macOS the panel browser cannot capture pixels yet; use snapshot / get_html instead.` };
                    }
                    const data = typeof shot?.data === 'string' ? shot.data : '';
                    if (!data) return { success: false, error: 'The browser returned an empty screenshot.' };
                    const base = getOutputPath?.();
                    let savedPath = '';
                    const requested = typeof args.path === 'string' ? args.path.trim() : '';
                    try {
                        let target: string;
                        if (requested) {
                            target = isAbsolute(requested) || !base ? requested : join(resolve(base), requested);
                        } else {
                            const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                            target = join(resolve(base || process.cwd()), 'browser-screenshots', `${stamp}-${label.replace(/[^\w-]+/g, '_')}.png`);
                        }
                        mkdirSync(join(target, '..'), { recursive: true });
                        writeFileSync(target, Buffer.from(data, 'base64'));
                        savedPath = target;
                    } catch (error) {
                        // Keep the image for the model even if the disk write failed.
                        savedPath = `(not saved: ${error instanceof Error ? error.message : String(error)})`;
                    }
                    const tabs = await listTabs(send).catch(() => [] as TabInfo[]);
                    const tab = tabs.find(t => t.label === label);
                    return {
                        success: true,
                        data: `Screenshot of ${what}${tab?.url ? ` — ${tab.url}` : ''}\nSaved to: ${savedPath}\nThe image is attached for you to look at; use snapshot refs to act on what you see.`,
                        images: [{ mimeType: 'image/png', data, description: `browser screenshot (${what})` }],
                    };
                }

                if (action === 'history') {
                    // Shared browsing history of the panel browser (all tabs, persisted by the desktop).
                    const limit = Math.max(1, Math.min(300, Number(args.limit) || 50));
                    const query = typeof args.text === 'string' ? args.text.trim() : '';
                    const res = await send('history', { limit, query });
                    const list = (res?.history as Array<{ url: string; title: string; at: number }>) ?? [];
                    if (list.length === 0) return { success: true, data: query ? `No history entries match "${query}".` : 'The panel browser has no browsing history yet.' };
                    const lines = list.map(e => `- ${fmtLocal(e.at)}  ${e.title || '(untitled)'}  ${e.url}`);
                    return { success: true, data: `Browsing history (newest first${query ? `, matching "${query}"` : ''}, ${list.length}):\n${lines.join('\n')}` };
                }

                if (action === 'cookies') {
                    // Cookies the current page (or args.url) can see. Values are truncated unless raw=true.
                    const tabs = await listTabs(send).catch(() => [] as TabInfo[]);
                    const pageUrl = typeof args.url === 'string' && args.url.trim() ? args.url.trim() : (tabs.find(t => t.label === label)?.url || '');
                    let res: { cookies?: Array<{ name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; session: boolean }> };
                    try {
                        res = await cdp(send, label, 'Network.getCookies', pageUrl ? { urls: [pageUrl] } : {});
                    } catch (error) {
                        return { success: false, error: `Cookies are not readable in this embedded browser (${error instanceof Error ? error.message : String(error)}). This is Windows-only for now.` };
                    }
                    const cookies = res?.cookies ?? [];
                    const wanted = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : '';
                    const shown = wanted ? cookies.filter(c => c.name === wanted) : cookies;
                    if (shown.length === 0) return { success: true, data: `${pageUrl || '(no page)'}\nNo cookies${wanted ? ` named "${wanted}"` : ''} for this page.` };
                    const raw = args.raw === true;
                    const lines = shown.map(c => {
                        const value = raw || c.value.length <= 60 ? c.value : `${c.value.slice(0, 60)}… (${c.value.length} chars, raw=true for all)`;
                        const exp = c.session || !c.expires || c.expires < 0 ? 'session' : fmtLocal(c.expires * 1000);
                        return `- ${c.name}=${value}\n  domain=${c.domain} path=${c.path} expires=${exp}${c.httpOnly ? ' HttpOnly' : ''}${c.secure ? ' Secure' : ''}`;
                    });
                    return { success: true, data: `${pageUrl}\nCookies (${shown.length}):\n${lines.join('\n')}` };
                }

                if (action === 'set_cookie') {
                    const name = typeof args.name === 'string' ? args.name.trim() : '';
                    const value = typeof args.value === 'string' ? args.value : '';
                    if (!name) return { success: false, error: 'set_cookie needs name (and value).' };
                    const tabs = await listTabs(send).catch(() => [] as TabInfo[]);
                    const pageUrl = typeof args.url === 'string' && args.url.trim() ? args.url.trim() : (tabs.find(t => t.label === label)?.url || '');
                    const domain = typeof args.domain === 'string' && args.domain.trim() ? args.domain.trim() : '';
                    if (!pageUrl && !domain) return { success: false, error: 'set_cookie needs url or domain (open a page first).' };
                    const params: Record<string, unknown> = { name, value, path: typeof args.path === 'string' && args.path ? args.path : '/' };
                    if (domain) params.domain = domain; else params.url = pageUrl;
                    if (typeof args.expiresInSeconds === 'number' && args.expiresInSeconds > 0) params.expires = Math.floor(Date.now() / 1000) + args.expiresInSeconds;
                    let res: { success?: boolean };
                    try {
                        res = await cdp(send, label, 'Network.setCookie', params);
                    } catch (error) {
                        return { success: false, error: `set_cookie is not available in this embedded browser (${error instanceof Error ? error.message : String(error)}).` };
                    }
                    if (res?.success === false) return { success: false, error: `The browser refused the cookie ${name} (check domain/url and Secure/SameSite rules).` };
                    return { success: true, data: `Cookie set: ${name} for ${domain || pageUrl}. Reload the page for it to take effect on the server side.` };
                }

                if (action === 'delete_cookies') {
                    const all = args.all === true;
                    const name = typeof args.name === 'string' ? args.name.trim() : '';
                    const domain = typeof args.domain === 'string' ? args.domain.trim() : '';
                    try {
                        if (all) {
                            await cdp(send, label, 'Network.clearBrowserCookies', {});
                            return { success: true, data: 'All cookies of the embedded browser were cleared (every site; logins are gone).' };
                        }
                        const tabs = await listTabs(send).catch(() => [] as TabInfo[]);
                        const pageUrl = typeof args.url === 'string' && args.url.trim() ? args.url.trim() : (tabs.find(t => t.label === label)?.url || '');
                        const res = await cdp(send, label, 'Network.getCookies', pageUrl ? { urls: [pageUrl] } : {});
                        const cookies = ((res?.cookies as Array<{ name: string; domain: string; path: string }>) ?? [])
                            .filter(c => (!name || c.name === name) && (!domain || c.domain === domain || c.domain === `.${domain}`));
                        if (cookies.length === 0) return { success: true, data: `No cookies matched${name ? ` name "${name}"` : ''}${domain ? ` domain "${domain}"` : ''} on ${pageUrl || 'the current page'}.` };
                        for (const c of cookies) await cdp(send, label, 'Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path });
                        return { success: true, data: `Deleted ${cookies.length} cookie(s): ${cookies.map(c => c.name).join(', ')}. Reload the page to see the effect.` };
                    } catch (error) {
                        return { success: false, error: `Cookie deletion is not available in this embedded browser (${error instanceof Error ? error.message : String(error)}).` };
                    }
                }

                if (action === 'downloads') {
                    const wait = args.wait === true;
                    const timeoutSeconds = Math.min(300, Math.max(1, Number(args.timeoutSeconds) || 60));
                    const deadline = Date.now() + timeoutSeconds * 1000;
                    let list: DownloadInfo[] = [];
                    for (;;) {
                        const res = await send('downloads', { label });
                        list = (res?.downloads as DownloadInfo[]) ?? [];
                        const pending = list.some(d => d.state === 'in_progress');
                        if (!wait || !pending || Date.now() >= deadline) {
                            if (wait && pending) {
                                return { success: false, error: `Download still in progress after ${timeoutSeconds}s:\n${formatDownloads(list)}` };
                            }
                            break;
                        }
                        await new Promise(r => setTimeout(r, 500));
                    }
                    if (args.clear === true) await send('downloads', { label, clear: true }).catch(() => undefined);
                    const dir = configuredDownloadDir || '(engine default folder)';
                    const completed = list.filter(d => d.state === 'completed');
                    return {
                        success: true,
                        data: `Download folder: ${dir}\n${formatDownloads(list)}${completed.length ? `\nCompleted files are on disk at the paths above — read or process them with your file tools.` : list.length ? '' : '\nA download starts when the page triggers one (a link/button with a file response). After clicking, call downloads with wait=true.'}`,
                    };
                }

                if (action === 'get_html') {
                    const selector = typeof args.selector === 'string' ? args.selector.trim() : '';
                    const raw = args.raw === true;
                    const maxChars = Math.max(1000, Math.min(200000, Number(args.maxChars) || 40000));
                    const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
                    const html = await getHtml(send, label, { selector, raw, maxChars, offset });
                    // Cross-origin frames are serialized through their own
                    // sessions and appended once the main document is complete.
                    let matched = html.matched;
                    let extra = '';
                    if (offset + html.chunk.length >= html.total) {
                        for (const box of await frameSessions(send, label)) {
                            try {
                                const inner = await getHtml(send, label, { selector, raw, maxChars, offset: 0 }, box.handle);
                                if (inner.matched === 0) continue;
                                matched += selector ? inner.matched : 0;
                                const cut = inner.chunk.length < inner.total ? `\n<!-- … ${inner.total - inner.chunk.length} more chars in this frame -->` : '';
                                extra += `\n\n<template data-frame-document="cross-origin" data-src="${inner.url.replace(/"/g, '&quot;')}" data-frame="${box.label.replace(/"/g, '&quot;')}">\n${inner.chunk}${cut}\n</template>`;
                            } catch {
                                // Frame detached meanwhile.
                            }
                        }
                    }
                    if (matched === 0) {
                        return { success: false, error: `No element matches selector "${selector}" on ${html.url} (main document and cross-origin frames).` };
                    }
                    const scope = selector ? `${matched} element(s) matching "${selector}"` : 'document';
                    const range = `chars ${offset}-${Math.min(offset + html.chunk.length, html.total)} of ${html.total}`;
                    const more = offset + html.chunk.length < html.total
                        ? `\n… truncated. Call get_html again with offset=${offset + html.chunk.length} for the next part.`
                        : '';
                    return { success: true, data: `${html.url}\nHTML of ${scope} (${range}${raw ? ', raw' : ', scripts/styles stripped'}):\n${html.chunk}${more}${extra}` };
                }

                if (action === 'click' || action === 'double_click' || action === 'right_click' || action === 'hover') {
                    const kind = action === 'click' ? 'click'
                        : action === 'double_click' ? 'double_click'
                        : action === 'right_click' ? 'right_click' : 'hover';
                    const target = await resolveTarget(send, label, args);
                    const result = await send('act', { label, kind, ...target });
                    const { x, y } = landed(result, target);
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
                    let to: Target = { x: Number(args.toX), y: Number(args.toY) };
                    if (!Number.isFinite(to.x) || !Number.isFinite(to.y)) {
                        if (args.toRef === undefined) return { success: false, error: 'drag needs a destination: toRef or toX/toY' };
                        to = await resolveTarget(send, label, { ref: args.toRef });
                    }
                    const result = await send('act', { label, kind: 'drag', x: from.x, y: from.y, w: from.w, h: from.h, x2: to.x, y2: to.y, w2: to.w, h2: to.h });
                    const start = landed(result, from);
                    const end = landed({ x: result?.x2, y: result?.y2 }, to);
                    const note = result?.inputMode === 'dom'
                        ? ' DOM drag events were delivered (isTrusted=false); take another snapshot to confirm the page accepted the drop.' : '';
                    return { success: true, data: `Dragged (${Math.round(start.x)}, ${Math.round(start.y)}) → (${Math.round(end.x)}, ${Math.round(end.y)}).${note}` };
                }

                if (action === 'select_option') {
                    const value = String(args.value ?? '');
                    if (!value) return { success: false, error: 'value is required for select_option' };
                    const { x, y } = await resolveTarget(send, label, args);
                    // Find the <select> under the point and set it, firing input+change.
                    const selectExpr = (px: number, py: number) => withDeepDom(`let el=D.elementFromPoint(${px},${py});while(el&&el.tagName!=='SELECT')el=el.parentElement;if(!el)return 'no_select';const v=${JSON.stringify(value)};const opt=[...el.options].find(o=>o.value===v||o.label===v||o.text.trim()===v);if(!opt)return 'no_option';const W=el.ownerDocument.defaultView||window;el.value=opt.value;el.dispatchEvent(new W.Event('input',{bubbles:true}));el.dispatchEvent(new W.Event('change',{bubbles:true}));return 'ok:'+opt.text.trim();`);
                    let out = String(await evaluate(send, label, selectExpr(x, y)) ?? '');
                    if (out === 'no_select') {
                        // The point may sit inside a cross-origin frame: retry there in its own coordinates.
                        const frame = frameAt(label, x, y);
                        if (frame) out = String(await evaluateIn(send, label, frame.handle, selectExpr(x - frame.left, y - frame.top)).catch(() => 'no_select') ?? '');
                    }
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
                    // Text and network activity are read across shadow roots and same-origin frames.
                    const probeExpr = withDeepDom(`let last=0;for(const {rec} of D.recorders()){if(rec.network.length)last=Math.max(last,rec.network[rec.network.length-1].t);}return JSON.stringify({url:location.href,hasText:${JSON.stringify(wantText)}?D.text(300000).includes(${JSON.stringify(wantText)}):true,idleMs:last?Date.now()-last:999999});`);
                    let observed: { url: string; hasText: boolean; idleMs: number } | undefined;
                    while (Date.now() < deadline) {
                        const res = await cdp(send, label, 'Runtime.evaluate', { expression: probeExpr, returnByValue: true }).catch(() => undefined);
                        const raw = (res as { result?: { value?: unknown } })?.result?.value;
                        if (typeof raw === 'string') {
                            try { observed = JSON.parse(raw); } catch { observed = undefined; }
                        }
                        if (observed && ((wantText && !observed.hasText) || wantIdle)) {
                            // Text may live in, and requests may come from, a cross-origin frame.
                            for (const box of await frameSessions(send, label)) {
                                try {
                                    const inner = JSON.parse(String(await evaluateIn(send, label, box.handle, probeExpr))) as { hasText: boolean; idleMs: number };
                                    if (inner.hasText) observed.hasText = true;
                                    observed.idleMs = Math.min(observed.idleMs, inner.idleMs);
                                } catch { /* frame gone */ }
                            }
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
                    const list = action === 'console' ? 'console' : 'network';
                    // Merge the recorders of the main document and every same-origin frame, newest last.
                    const expr = withDeepDom(`const recs=D.recorders();if(!recs.length)return null;let all=[];for(const {rec,frame} of recs){for(const i of rec.${list})all.push(frame?Object.assign({},i,{frame}):i);}all.sort((a,b)=>a.t-b.t);const out=all.slice(-${limit});${args.clear ? `for(const {rec} of recs)rec.${list}.length=0;` : ''}return JSON.stringify({url:location.href,total:all.length,items:out});`);
                    const res = await cdp(send, label, 'Runtime.evaluate', { expression: expr, returnByValue: true });
                    const raw = (res as { result?: { value?: unknown } })?.result?.value;
                    if (typeof raw !== 'string') {
                        return { success: true, data: 'The page recorder is not active on this page yet (it is installed on navigation). Call navigate to (re)load the page, repeat the action, then call console/network again.' };
                    }
                    const parsed = JSON.parse(raw) as { url: string; total: number; items: Array<Record<string, unknown>> };
                    // Cross-origin frames keep their own recorders (installed by the desktop when listed).
                    for (const box of await frameSessions(send, label)) {
                        try {
                            const inner = await evaluateIn(send, label, box.handle, expr);
                            if (typeof inner !== 'string') continue;
                            const p = JSON.parse(inner) as { total: number; items: Array<Record<string, unknown>> };
                            const tag = `${box.label} (cross-origin)`;
                            parsed.items.push(...p.items.map(i => ({ ...i, frame: i.frame ? `${tag} > ${i.frame}` : tag })));
                            parsed.total += p.total;
                        } catch { /* frame gone */ }
                    }
                    parsed.items.sort((a, b) => Number(a.t) - Number(b.t));
                    parsed.items = parsed.items.slice(-limit);
                    if (!parsed.items.length) {
                        return { success: true, data: `${parsed.url}\n${action === 'console' ? 'No console output or errors recorded since the page loaded.' : 'No fetch/XHR requests recorded since the page loaded — the action did not trigger a request (check the click target / form submit).'}` };
                    }
                    const time = (t: unknown) => new Date(Number(t)).toISOString().slice(11, 23);
                    const where = (i: Record<string, unknown>) => (i.frame ? ` (frame: ${i.frame})` : '');
                    const lines = action === 'console'
                        ? parsed.items.map(i => `${time(i.t)} [${String(i.level).toUpperCase()}]${where(i)} ${i.text}`)
                        : parsed.items.map(i => `${time(i.t)} ${i.method} ${i.url} → ${i.status}${i.ok ? '' : ' ✗'} ${i.ms}ms${where(i)}${i.error ? ` error: ${i.error}` : ''}${i.response ? `\n    response: ${String(i.response).replace(/\s+/g, ' ').slice(0, 400)}` : ''}`);
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
                        const target = await resolveTarget(send, label, { ref: args.ref, x: args.x, y: args.y });
                        await send('act', { label, kind: 'click', ...target });
                        if (args.clear === true) {
                            await send('act', { label, kind: 'key', key: 'a', modifiers: 2 });
                            await send('act', { label, kind: 'key', key: 'Backspace', modifiers: 0 });
                        }
                    }
                    // Typed key by key at a human pace: give the bridge time for long text.
                    await send('act', { label, kind: 'type', text }, 30000 + text.length * 400);
                    // Verify the text actually landed in an editable field.
                    const landedExpr = withDeepDom(`const el=D.activeElement();if(!el||el===el.ownerDocument.body)return JSON.stringify({tag:'none',value:''});const v=('value' in el)?String(el.value??''):(el.isContentEditable?String(el.textContent??''):'');return JSON.stringify({tag:el.tagName.toLowerCase()+(el.type?'['+el.type+']':''),value:v.slice(-400),readOnly:!!el.readOnly});`);
                    const check = await evaluate(send, label, landedExpr).catch(() => undefined);
                    let landed: { tag: string; value: string; readOnly?: boolean } | undefined;
                    try { landed = JSON.parse(String(check ?? '')); } catch { /* page blocked evaluation */ }
                    if (landed?.tag === 'iframe') {
                        // Focus is inside a cross-origin frame: ask each attached frame session.
                        for (const box of await frameSessions(send, label)) {
                            try {
                                const inner = JSON.parse(String(await evaluateIn(send, label, box.handle, landedExpr) ?? '')) as typeof landed;
                                if (inner && inner.tag !== 'none') { landed = inner; break; }
                            } catch { /* frame gone */ }
                        }
                    }
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
