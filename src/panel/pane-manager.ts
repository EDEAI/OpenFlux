/**
 * The right panel's pane manager.
 *
 * Owns the tab list, which tab is active and persistence. Pane content is
 * supplied by providers so this module never needs to know what an artifacts
 * list, a file tree or a browser view is.
 *
 * Layouts are kept per *scope* — the chat session on the left — so switching
 * sessions swaps the whole panel: each session has its own set of tabs.
 *
 * Every pane's body is mounted once and stays mounted while its tab exists in
 * the current scope; switching tabs only changes which body is visible. That
 * keeps scroll positions, in-flight renders and an embedded browser alive
 * behind an inactive tab.
 */

import { t } from '../i18n/index';
import {
    buildAddMenu,
    buildTab,
    refreshTab,
    type AddMenuItem,
    type PaneTabElements,
} from './pane-chrome';
import { popOverlay, pushOverlay } from './overlay-signal';
import {
    activePane,
    createPane,
    nextActiveAfterClose,
    normalizeLayout,
    type PaneKind,
    type PaneState,
    type PanelLayout,
} from './pane-types';

/**
 * Why a pane is being unmounted. `closed` means the user is done with it;
 * `suspended` means its scope went out of view (session switch) and the pane
 * may come back with the same id, so providers can keep expensive state.
 */
export type PaneUnmountReason = 'closed' | 'suspended';

export interface PaneContentProvider {
    kind: PaneKind;
    /** Emoji shown on the tab and in the "+" menu. */
    icon: string;
    /** i18n key for the default tab title. */
    titleKey: string;
    /** Only one tab of this kind may exist at a time. */
    singleton?: boolean;
    /** Overrides `titleKey` when the title depends on pane content. */
    title?(pane: PaneState): string;
    mount(body: HTMLElement, pane: PaneState): void;
    /** Called before the pane's DOM is discarded. Move borrowed nodes out here. */
    unmount?(body: HTMLElement, pane: PaneState, reason: PaneUnmountReason): void;
    /** Called when the pane becomes / stops being the visible one. */
    onVisibilityChange?(visible: boolean, pane: PaneState): void;
}

export interface PanePanelOptions {
    /** Horizontal tab strip. The "+" row is kept last inside it. */
    tabBar: HTMLElement;
    /** Container the pane bodies are mounted into, one per tab. */
    bodyHost: HTMLElement;
    /** The "+" button that opens the new-pane menu. */
    addButton: HTMLButtonElement;
    /** Shown instead of a pane body when every tab is closed. */
    emptyState: HTMLElement;
    providers: PaneContentProvider[];
    /** Tabs opened when a scope has nothing persisted yet. */
    defaultKinds?: PaneKind[];
    storageKey?: string;
    /** Scope to start in; `null` is the "no session" scope. */
    initialScope?: string | null;
}

export interface PanePanel {
    /** Open a tab of this kind and activate it, or focus an existing singleton. */
    open(kind: PaneKind): PaneState | null;
    /** Activate an existing tab of this kind, opening one only if none exists. */
    ensure(kind: PaneKind): PaneState | null;
    close(paneId: string): void;
    activate(paneId: string): void;
    has(kind: PaneKind): boolean;
    /** Switch to another scope's layout (the chat session on the left). */
    setScope(scope: string | null): void;
    scope(): string | null;
    refresh(): void;
}

const DEFAULT_STORAGE_KEY = 'openflux-panel-layout';

/** Fired on `document` by providers whose tab title changed. */
export const PANE_TITLE_CHANGED_EVENT = 'openflux:pane-title-changed';

let paneSeq = 0;
function nextPaneId(kind: PaneKind): string {
    paneSeq += 1;
    return `${kind}-${Date.now().toString(36)}-${paneSeq}`;
}

export function initPanePanel(options: PanePanelOptions): PanePanel {
    const baseKey = options.storageKey ?? DEFAULT_STORAGE_KEY;
    const providers = new Map<PaneKind, PaneContentProvider>();
    for (const provider of options.providers) providers.set(provider.kind, provider);
    const knownKinds = [...providers.keys()];

    interface MountedPane {
        tab: PaneTabElements;
        body: HTMLElement;
        provider: PaneContentProvider;
        visible: boolean;
    }
    const mounted = new Map<string, MountedPane>();

    // The row wrapping the "+" button; it trails the tabs inside the strip.
    const addRow = options.addButton.parentElement ?? options.addButton;
    let addMenu: HTMLElement | null = null;

    let currentScope: string | null = options.initialScope ?? null;

    function storageKeyFor(scope: string | null): string {
        return `${baseKey}:${scope ?? 'none'}`;
    }

    function loadLayout(scope: string | null): PanelLayout {
        try {
            const raw = localStorage.getItem(storageKeyFor(scope));
            if (raw) {
                const parsed = normalizeLayout(JSON.parse(raw) as unknown, knownKinds);
                if (parsed) return parsed;
            }
        } catch (error) {
            console.warn('[Panel] Ignoring unreadable saved layout:', error);
        }
        const panes = (options.defaultKinds ?? [])
            .filter(kind => providers.has(kind))
            .map(kind => createPane(kind, nextPaneId(kind)));
        return { panes, activeId: panes[0]?.id ?? null };
    }

    let layout: PanelLayout = loadLayout(currentScope);

    function persist(): void {
        try {
            localStorage.setItem(storageKeyFor(currentScope), JSON.stringify(layout));
        } catch (error) {
            console.warn('[Panel] Layout not saved:', error);
        }
    }

    function paneTitle(pane: PaneState, provider: PaneContentProvider): string {
        return provider.title?.(pane) ?? t(provider.titleKey);
    }

    function unmountPane(paneId: string, reason: PaneUnmountReason): void {
        const entry = mounted.get(paneId);
        if (!entry) return;
        const pane = layout.panes.find(p => p.id === paneId) ?? { id: paneId, kind: entry.provider.kind };
        try {
            if (entry.visible) entry.provider.onVisibilityChange?.(false, pane);
            entry.provider.unmount?.(entry.body, pane, reason);
        } catch (error) {
            console.error('[Panel] Pane unmount failed:', error);
        }
        entry.tab.root.remove();
        entry.body.remove();
        mounted.delete(paneId);
    }

    function ensureMounted(pane: PaneState): MountedPane | null {
        const existing = mounted.get(pane.id);
        if (existing) return existing;

        const provider = providers.get(pane.kind);
        if (!provider) return null;

        const tab = buildTab(pane, provider.icon, {
            onActivate: target => activate(target.id),
            onClose: target => close(target.id),
        });

        const body = document.createElement('div');
        body.className = 'panel-pane-body';
        body.dataset.paneId = pane.id;

        const entry: MountedPane = { tab, body, provider, visible: false };
        mounted.set(pane.id, entry);

        try {
            provider.mount(body, pane);
        } catch (error) {
            console.error('[Panel] Pane mount failed:', error);
        }

        return entry;
    }

    function refreshTitles(): void {
        for (const [paneId, entry] of mounted) {
            const pane = layout.panes.find(p => p.id === paneId);
            if (pane) refreshTab(entry.tab, paneTitle(pane, entry.provider), pane.id === layout.activeId);
        }
    }

    function render(): void {
        // Drop panes whose provider disappeared between builds.
        layout.panes = layout.panes.filter(pane => providers.has(pane.kind));
        if (!activePane(layout)) layout.activeId = layout.panes[0]?.id ?? null;

        const liveIds = new Set(layout.panes.map(p => p.id));
        for (const paneId of [...mounted.keys()]) {
            if (!liveIds.has(paneId)) unmountPane(paneId, 'closed');
        }

        // Both the body host and the empty state claim the leftover height, so
        // exactly one of them may be in the layout at a time.
        const isEmpty = layout.panes.length === 0;
        options.emptyState.style.display = isEmpty ? '' : 'none';
        options.bodyHost.style.display = isEmpty ? 'none' : '';

        for (const pane of layout.panes) {
            const entry = ensureMounted(pane);
            if (!entry) continue;

            // Re-appending moves the nodes, so tabs follow the pane order and
            // the "+" row stays last however the tabs were just rearranged.
            options.tabBar.append(entry.tab.root);
            options.bodyHost.append(entry.body);

            const isActive = pane.id === layout.activeId;
            refreshTab(entry.tab, paneTitle(pane, entry.provider), isActive);
            entry.body.classList.toggle('panel-body-inactive', !isActive);

            if (entry.visible !== isActive) {
                entry.visible = isActive;
                try {
                    entry.provider.onVisibilityChange?.(isActive, pane);
                } catch (error) {
                    console.error('[Panel] Pane visibility handler failed:', error);
                }
            }
        }

        options.tabBar.append(addRow);
        persist();
    }

    function findByKind(kind: PaneKind): PaneState | undefined {
        return layout.panes.find(pane => pane.kind === kind);
    }

    function activate(paneId: string): void {
        if (layout.activeId === paneId) return;
        if (!layout.panes.some(pane => pane.id === paneId)) return;
        layout.activeId = paneId;
        render();
    }

    function open(kind: PaneKind): PaneState | null {
        const provider = providers.get(kind);
        if (!provider) return null;

        if (provider.singleton) {
            const existing = findByKind(kind);
            if (existing) {
                // Re-opening a singleton means "show it", not "add another".
                activate(existing.id);
                return existing;
            }
        }

        const pane = createPane(kind, nextPaneId(kind));
        layout.panes.push(pane);
        layout.activeId = pane.id;
        render();
        return pane;
    }

    function ensure(kind: PaneKind): PaneState | null {
        const existing = findByKind(kind);
        if (existing) {
            activate(existing.id);
            return existing;
        }
        return open(kind);
    }

    function close(paneId: string): void {
        const index = layout.panes.findIndex(pane => pane.id === paneId);
        if (index < 0) return;
        // Resolved before the splice: the rule needs the closing tab's position.
        const nextActive = nextActiveAfterClose(layout, paneId);
        layout.panes.splice(index, 1);
        layout.activeId = nextActive;
        unmountPane(paneId, 'closed');
        render();
    }

    function setScope(scope: string | null): void {
        if (scope === currentScope) return;
        persist();
        // Suspend rather than close: the same pane ids come back with the
        // scope, so providers may keep what is expensive to rebuild.
        for (const paneId of [...mounted.keys()]) unmountPane(paneId, 'suspended');
        currentScope = scope;
        layout = loadLayout(scope);
        render();
    }

    function closeAddMenu(): void {
        if (!addMenu) return;
        addMenu.remove();
        addMenu = null;
        popOverlay();
        options.addButton.setAttribute('aria-expanded', 'false');
    }

    function openAddMenu(): void {
        const items: AddMenuItem[] = [...providers.values()].map(provider => ({
            kind: provider.kind,
            icon: provider.icon,
            labelKey: provider.titleKey,
            disabled: provider.singleton === true && findByKind(provider.kind) !== undefined,
            disabledReasonKey: 'panel.already_open',
        }));

        addMenu = buildAddMenu(items, kind => {
            closeAddMenu();
            open(kind);
        });
        pushOverlay();

        // Anchored to the viewport rather than to the "+" row: the tab strip
        // scrolls horizontally and clips its overflow, so an absolutely
        // positioned menu would be cut off.
        addMenu.style.visibility = 'hidden';
        document.body.append(addMenu);

        const anchor = options.addButton.getBoundingClientRect();
        const menuBox = addMenu.getBoundingClientRect();
        const fitsBelow = window.innerHeight - anchor.bottom >= menuBox.height + 8;
        const top = fitsBelow ? anchor.bottom + 4 : anchor.top - menuBox.height - 4;
        addMenu.style.top = `${Math.max(8, Math.min(top, window.innerHeight - menuBox.height - 8))}px`;
        addMenu.style.left = `${Math.max(8, Math.min(anchor.right - menuBox.width, window.innerWidth - menuBox.width - 8))}px`;
        addMenu.style.visibility = '';

        options.addButton.setAttribute('aria-expanded', 'true');
    }

    options.addButton.addEventListener('click', event => {
        event.stopPropagation();
        if (addMenu) closeAddMenu();
        else openAddMenu();
    });
    document.addEventListener('click', () => closeAddMenu());
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && addMenu) closeAddMenu();
    });
    document.addEventListener('locale-changed', () => {
        closeAddMenu();
        refreshTitles();
    });
    document.addEventListener(PANE_TITLE_CHANGED_EVENT, refreshTitles);

    render();

    return {
        open,
        ensure,
        close,
        activate,
        has: kind => findByKind(kind) !== undefined,
        setScope,
        scope: () => currentScope,
        refresh: render,
    };
}
