/**
 * DOM construction for the right panel's tab strip: one tab per open pane and
 * the "+" menu that picks which kind of pane to open next.
 *
 * Kept apart from pane-manager so the manager only deals with state, and so
 * the visuals can change without touching the tab bookkeeping.
 */

import { t } from '../i18n/index';
import type { PaneKind, PaneState } from './pane-types';

const ICON_CLOSE = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>';

export interface PaneTabHandlers {
    onActivate(pane: PaneState): void;
    onClose(pane: PaneState): void;
}

export interface PaneTabElements {
    root: HTMLElement;
    icon: HTMLElement;
    label: HTMLElement;
    closeBtn: HTMLButtonElement;
}

/** Build one tab. The pane's content lives in a separate body host. */
export function buildTab(pane: PaneState, icon: string, handlers: PaneTabHandlers): PaneTabElements {
    const root = document.createElement('div');
    root.className = 'panel-tab';
    root.setAttribute('role', 'tab');
    root.dataset.paneId = pane.id;
    root.dataset.paneKind = pane.kind;

    const iconEl = document.createElement('span');
    iconEl.className = 'panel-tab-icon';
    // Icons are monochrome inline SVG (currentColor), so render as HTML.
    iconEl.innerHTML = icon;

    const label = document.createElement('span');
    label.className = 'panel-tab-label';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'panel-tab-close';
    closeBtn.innerHTML = ICON_CLOSE;

    root.append(iconEl, label, closeBtn);

    root.addEventListener('click', () => handlers.onActivate(pane));
    closeBtn.addEventListener('click', event => {
        event.stopPropagation();
        handlers.onClose(pane);
    });
    // Middle-click closes a tab, as it does in a browser.
    root.addEventListener('auxclick', event => {
        if (event.button !== 1) return;
        event.preventDefault();
        handlers.onClose(pane);
    });

    return { root, icon: iconEl, label, closeBtn };
}

/**
 * Refresh every piece of a tab that depends on state or locale. Called on
 * render and again whenever the UI language changes.
 */
export function refreshTab(elements: PaneTabElements, title: string, active: boolean): void {
    elements.label.textContent = title;
    // The label is elided when the panel is narrow, so keep the full name and
    // the close hint reachable through tooltips.
    elements.root.title = title;
    elements.root.classList.toggle('active', active);
    elements.root.setAttribute('aria-selected', active ? 'true' : 'false');
    elements.closeBtn.title = t('panel.close_pane');
}

export interface AddMenuItem {
    kind: PaneKind;
    icon: string;
    labelKey: string;
    /** Rendered but not clickable, with a reason in the tooltip. */
    disabled?: boolean;
    disabledReasonKey?: string;
}

/**
 * The "+" menu. Rebuilt on every open so labels follow the current locale and
 * disabled state follows the current tabs (singletons already on screen).
 */
export function buildAddMenu(items: AddMenuItem[], onPick: (kind: PaneKind) => void): HTMLElement {
    const menu = document.createElement('div');
    menu.className = 'panel-add-menu';
    menu.setAttribute('role', 'menu');

    for (const item of items) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'panel-add-item';
        button.setAttribute('role', 'menuitem');
        button.dataset.kind = item.kind;
        button.disabled = item.disabled === true;
        if (item.disabled && item.disabledReasonKey) button.title = t(item.disabledReasonKey);

        const icon = document.createElement('span');
        icon.className = 'panel-add-item-icon';
        icon.innerHTML = item.icon;

        const label = document.createElement('span');
        label.className = 'panel-add-item-label';
        label.textContent = t(item.labelKey);

        button.append(icon, label);
        button.addEventListener('click', () => onPick(item.kind));
        menu.append(button);
    }

    return menu;
}
