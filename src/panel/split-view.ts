/**
 * Two regions with a draggable divider, used by the artifacts and file tabs to
 * show a list next to its preview.
 *
 * Orientation follows the host width: side by side when there is room, one
 * above the other in a narrow panel. The user's split ratio is remembered per
 * `storageKey` and re-applied whichever way the regions happen to lie.
 */

export interface SplitView {
    root: HTMLElement;
    primary: HTMLElement;
    secondary: HTMLElement;
    dispose(): void;
}

export interface SplitViewOptions {
    storageKey: string;
    /** Host width (px) at or above which the regions sit side by side. */
    rowBreakpoint?: number;
    /** Share of the main axis the primary region takes by default. */
    defaultRatio?: number;
    minPrimaryPx?: number;
    minSecondaryPx?: number;
}

const DEFAULTS = {
    rowBreakpoint: 640,
    defaultRatio: 0.4,
    minPrimaryPx: 120,
    minSecondaryPx: 160,
};

function loadRatio(key: string, fallback: number): number {
    try {
        const saved = Number(localStorage.getItem(key));
        return Number.isFinite(saved) && saved > 0 && saved < 1 ? saved : fallback;
    } catch {
        return fallback;
    }
}

export function createSplitView(host: HTMLElement, options: SplitViewOptions): SplitView {
    const settings = { ...DEFAULTS, ...options };

    const root = document.createElement('div');
    root.className = 'split-view';
    const primary = document.createElement('div');
    primary.className = 'split-primary';
    const divider = document.createElement('div');
    divider.className = 'split-divider';
    const secondary = document.createElement('div');
    secondary.className = 'split-secondary';
    root.append(primary, divider, secondary);
    host.append(root);

    let ratio = loadRatio(settings.storageKey, settings.defaultRatio);
    let orientation: 'row' | 'column' = 'row';

    function applyRatio(): void {
        primary.style.flex = `0 0 ${(ratio * 100).toFixed(2)}%`;
    }

    function applyOrientation(): void {
        const width = host.getBoundingClientRect().width;
        const next: 'row' | 'column' = width >= settings.rowBreakpoint ? 'row' : 'column';
        if (next === orientation && root.classList.contains(next)) return;
        orientation = next;
        root.classList.toggle('row', next === 'row');
        root.classList.toggle('column', next === 'column');
        applyRatio();
    }

    divider.addEventListener('mousedown', event => {
        event.preventDefault();
        const box = root.getBoundingClientRect();
        const axisStart = orientation === 'row' ? box.left : box.top;
        const axisSize = orientation === 'row' ? box.width : box.height;
        if (axisSize <= 0) return;

        const lower = settings.minPrimaryPx / axisSize;
        const upper = 1 - settings.minSecondaryPx / axisSize;

        divider.classList.add('active');
        document.body.classList.add('split-resizing', `split-resizing-${orientation}`);

        const onMove = (moveEvent: MouseEvent) => {
            const pointer = orientation === 'row' ? moveEvent.clientX : moveEvent.clientY;
            // A host too short for both minimums still gets a stable split
            // rather than a divider that snaps to one end.
            const clampedUpper = Math.max(lower, upper);
            ratio = Math.min(clampedUpper, Math.max(lower, (pointer - axisStart) / axisSize));
            applyRatio();
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            divider.classList.remove('active');
            document.body.classList.remove('split-resizing', 'split-resizing-row', 'split-resizing-column');
            try {
                localStorage.setItem(settings.storageKey, ratio.toFixed(4));
            } catch {
                // Not worth failing a drag over.
            }
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(() => applyOrientation());
        observer.observe(host);
    }
    applyOrientation();
    applyRatio();

    return {
        root,
        primary,
        secondary,
        dispose() {
            observer?.disconnect();
            root.remove();
        },
    };
}
