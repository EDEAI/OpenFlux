/**
 * A tiny counter for "something is floating over the page".
 *
 * Native child webviews (the embedded browser tabs) always paint above the
 * HTML, so any menu or popover that opens over them would be hidden behind
 * the page. Overlays announce themselves here and the browser panes duck out
 * of the way while one is open.
 */

type Listener = (open: boolean) => void;

let depth = 0;
const listeners = new Set<Listener>();

function notify(open: boolean): void {
    for (const listener of listeners) {
        try {
            listener(open);
        } catch (error) {
            console.error('[Overlay] Listener failed:', error);
        }
    }
}

export function pushOverlay(): void {
    depth += 1;
    if (depth === 1) notify(true);
}

export function popOverlay(): void {
    if (depth === 0) return;
    depth -= 1;
    if (depth === 0) notify(false);
}

export function isOverlayOpen(): boolean {
    return depth > 0;
}

export function onOverlayChange(listener: Listener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
