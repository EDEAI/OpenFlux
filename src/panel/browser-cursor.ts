/**
 * The agent's visual cursor inside an embedded browser tab.
 *
 * When the AI agent takes a tab over, it does not move the OS pointer — it
 * drives a soft cursor drawn *inside the page*, the way the Codex browser
 * does. This keeps the human's real mouse free: the two never collide, and
 * both can act on the tab.
 *
 * The cursor is a self-contained overlay injected into the page via
 * `browser_view_eval`. It is deliberately built as a string of page-side JS
 * (idempotent, re-injectable after navigations) rather than a DOM node on our
 * side, because it must live inside the webview's own document, above the
 * page and immune to the page's own styles.
 */

import { invoke } from '@tauri-apps/api/core';

/**
 * Page-side overlay. Defines `window.__ofxCursor` with:
 *   show()/hide(), move(x,y) in CSS px, click() ripple.
 * Everything is scoped under one host element. `VER` forces a rebuild when the
 * overlay's look changes between app versions.
 */
const OVERLAY_SOURCE = `(() => {
  const ID = '__ofx_cursor_host';
  const VER = '2';
  const existing = document.getElementById(ID);
  if (existing && existing.dataset.ver === VER && window.__ofxCursor) return 'exists';
  if (existing) existing.remove();
  const host = document.createElement('div');
  host.id = ID;
  host.dataset.ver = VER;
  host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
  const cursor = document.createElement('div');
  cursor.style.cssText = 'position:absolute;left:0;top:0;width:34px;height:34px;margin:-3px 0 0 -3px;transition:transform .12s cubic-bezier(.22,1,.36,1);will-change:transform;';
  // Pure black arrow with a white edge; drop-shadow keeps it readable on any bg.
  cursor.innerHTML = '<svg width="34" height="34" viewBox="0 0 24 24" style="filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))"><path d="M5 3l14 7-6 2-2 6z" fill="#000" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  const ring = document.createElement('div');
  ring.style.cssText = 'position:absolute;left:0;top:0;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;border:2px solid rgba(0,0,0,.85);box-shadow:0 0 0 1px rgba(255,255,255,.9);opacity:0;transform:scale(.3);';
  host.appendChild(ring); host.appendChild(cursor);
  const attach = () => { if (!document.getElementById(ID) && document.body) document.body.appendChild(host); };
  attach();
  let rippleT = 0;
  const api = {
    show() { host.style.display = ''; attach(); },
    hide() { host.style.display = 'none'; },
    move(x, y) { attach(); const t = 'translate(' + x + 'px,' + y + 'px)'; cursor.style.transform = t; ring.style.transform = t + ' scale(.3)'; },
    click() {
      const m = /translate\\(([-0-9.]+)px,\\s*([-0-9.]+)px\\)/.exec(cursor.style.transform) || [0, 0, 0];
      const x = +m[1], y = +m[2];
      ring.style.transition = 'none';
      ring.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(.3)';
      ring.style.opacity = '.9';
      const t = ++rippleT;
      requestAnimationFrame(() => {
        ring.style.transition = 'transform .4s ease-out, opacity .4s ease-out';
        ring.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(2.4)';
        ring.style.opacity = '0';
      });
      setTimeout(() => { if (t === rippleT) ring.style.opacity = '0'; }, 420);
    },
  };
  window.__ofxCursor = api;
  return 'created';
})()`;

const CALL = {
    show: 'window.__ofxCursor&&window.__ofxCursor.show()',
    hide: 'window.__ofxCursor&&window.__ofxCursor.hide()',
    click: 'window.__ofxCursor&&window.__ofxCursor.click()',
};

/**
 * Drives one tab's soft cursor. All state is page-side; this only sends evals,
 * so a re-injection after a navigation restores the overlay transparently.
 */
export class BrowserCursor {
    private injected = false;

    constructor(private readonly label: string) {}

    private async run(js: string): Promise<void> {
        try {
            await invoke('browser_view_eval', { label: this.label, js });
        } catch {
            // A closed/navigating webview will reject; the next call re-injects.
            this.injected = false;
        }
    }

    /** Ensure the overlay exists (safe to call repeatedly and after navigation). */
    async ensure(): Promise<void> {
        await this.run(OVERLAY_SOURCE);
        this.injected = true;
        await this.run(CALL.show);
    }

    async move(x: number, y: number): Promise<void> {
        if (!this.injected) await this.ensure();
        await this.run(`window.__ofxCursor&&window.__ofxCursor.move(${Math.round(x)},${Math.round(y)})`);
    }

    async click(): Promise<void> {
        if (!this.injected) await this.ensure();
        await this.run(CALL.click);
    }

    async hide(): Promise<void> {
        await this.run(CALL.hide);
    }

    /** Forget the injected state so the next call rebuilds the overlay. */
    reset(): void {
        this.injected = false;
    }
}

/** The overlay JS, exported so a dev harness can inject it directly over CDP. */
export const CURSOR_OVERLAY_SOURCE = OVERLAY_SOURCE;
