export interface LocalFileLinkLabels {
    open: string;
    reveal: string;
}

export interface LocalFileLinkActions {
    open(path: string): void | Promise<unknown>;
    reveal(path: string): void | Promise<unknown>;
}

interface ActivePathMenu {
    chip: HTMLElement;
    menu: HTMLElement;
    trigger: HTMLButtonElement;
}

const activePathMenus = new WeakMap<Document, ActivePathMenu>();
const initializedDocuments = new WeakSet<Document>();

const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/;
const WINDOWS_UNC_PATH = /^\\\\[^\\/]+[\\/][^\\/]+/;
const POSIX_ABSOLUTE_PATH = /^\//;

// Raw prose paths need a definite file extension so surrounding words are not
// mistaken for part of a directory with spaces. Directory paths remain
// supported when they are written as inline code or an explicit Markdown link.
const RAW_WINDOWS_FILE_PATH = /(?:[a-zA-Z]:[\\/]|\\\\)[^\r\n`<>"|?*]*?\.[a-zA-Z0-9]{1,10}(?=$|[\s)\]}>，。；、,;:!?！？”’"'])/g;

function unwrapPath(value: string): string {
    let path = value.trim();
    if ((path.startsWith('<') && path.endsWith('>'))
        || (path.startsWith('`') && path.endsWith('`'))
        || (path.startsWith('"') && path.endsWith('"'))
        || (path.startsWith("'") && path.endsWith("'"))) {
        path = path.slice(1, -1).trim();
    }

    try { path = decodeURIComponent(path); } catch { /* keep undecoded input */ }

    if (/^file:\/\/\/[a-zA-Z]:[\\/]/i.test(path)) {
        path = path.slice('file:///'.length);
    } else if (/^file:\/\//i.test(path)) {
        const unc = path.slice('file://'.length).replace(/\//g, '\\');
        path = `\\\\${unc.replace(/^\\+/, '')}`;
    }
    return path;
}

export function parseAbsoluteLocalPath(value: string): string | null {
    const path = unwrapPath(value);
    if (WINDOWS_ABSOLUTE_PATH.test(path) || WINDOWS_UNC_PATH.test(path) || POSIX_ABSOLUTE_PATH.test(path)) {
        return path;
    }
    return null;
}

function closeActivePathMenu(document: Document, restoreFocus = false): void {
    const active = activePathMenus.get(document);
    if (!active) return;
    active.menu.hidden = true;
    active.trigger.setAttribute('aria-expanded', 'false');
    active.chip.classList.remove('menu-open', 'menu-above', 'menu-align-right');
    activePathMenus.delete(document);
    if (restoreFocus) active.trigger.focus();
}

function ensureMenuDismissHandlers(document: Document): void {
    if (initializedDocuments.has(document)) return;
    initializedDocuments.add(document);

    document.addEventListener('pointerdown', (event) => {
        const active = activePathMenus.get(document);
        if (!active || !(event.target instanceof Node) || active.chip.contains(event.target)) return;
        closeActivePathMenu(document);
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closeActivePathMenu(document, true);
    });
    document.addEventListener('scroll', () => closeActivePathMenu(document), true);
    document.defaultView?.addEventListener('resize', () => closeActivePathMenu(document));
}

function createPathChip(
    path: string,
    displayText: string,
    labels: LocalFileLinkLabels,
    actions: LocalFileLinkActions,
): HTMLElement {
    const ownerDocument = document;
    ensureMenuDismissHandlers(ownerDocument);

    const chip = ownerDocument.createElement('span');
    chip.className = 'local-path-chip';
    chip.dataset.localPath = path;

    const trigger = ownerDocument.createElement('button');
    trigger.type = 'button';
    trigger.className = 'local-path-trigger';
    trigger.title = path;
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.textContent = displayText || path;

    const menu = ownerDocument.createElement('span');
    menu.className = 'local-path-menu';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;

    const openButton = ownerDocument.createElement('button');
    openButton.type = 'button';
    openButton.className = 'local-path-menu-item';
    openButton.setAttribute('role', 'menuitem');
    openButton.textContent = labels.open;
    openButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeActivePathMenu(ownerDocument);
        void Promise.resolve(actions.open(path));
    });

    const revealButton = ownerDocument.createElement('button');
    revealButton.type = 'button';
    revealButton.className = 'local-path-menu-item';
    revealButton.setAttribute('role', 'menuitem');
    revealButton.textContent = labels.reveal;
    revealButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeActivePathMenu(ownerDocument);
        void Promise.resolve(actions.reveal(path));
    });

    menu.append(openButton, revealButton);
    trigger.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();

        const active = activePathMenus.get(ownerDocument);
        if (active?.menu === menu) {
            closeActivePathMenu(ownerDocument);
            return;
        }
        closeActivePathMenu(ownerDocument);

        const rect = trigger.getBoundingClientRect();
        chip.classList.toggle('menu-above', rect.bottom + 92 > (ownerDocument.defaultView?.innerHeight ?? 0));
        chip.classList.toggle('menu-align-right', rect.left + 180 > (ownerDocument.defaultView?.innerWidth ?? 0));
        menu.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
        chip.classList.add('menu-open');
        activePathMenus.set(ownerDocument, { chip, menu, trigger });
    });

    chip.append(trigger, menu);
    return chip;
}

function decorateExplicitPaths(
    container: HTMLElement,
    labels: LocalFileLinkLabels,
    actions: LocalFileLinkActions,
): void {
    container.querySelectorAll<HTMLAnchorElement>('a[href]:not([data-local-path])').forEach((anchor) => {
        const path = parseAbsoluteLocalPath(anchor.getAttribute('href') || '');
        if (!path) return;
        anchor.replaceWith(createPathChip(path, anchor.textContent?.trim() || path, labels, actions));
    });

    container.querySelectorAll<HTMLElement>('code:not(pre code)').forEach((code) => {
        const path = parseAbsoluteLocalPath(code.textContent || '');
        if (!path) return;
        code.replaceWith(createPathChip(path, path, labels, actions));
    });
}

function decorateRawFilePaths(
    container: HTMLElement,
    labels: LocalFileLinkLabels,
    actions: LocalFileLinkActions,
): void {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const candidates: Text[] = [];
    let current: Node | null;
    while ((current = walker.nextNode())) {
        const parent = current.parentElement;
        if (!parent || parent.closest('a, button, code, pre, script, style, .local-path-chip')) continue;
        if (RAW_WINDOWS_FILE_PATH.test(current.textContent || '')) candidates.push(current as Text);
        RAW_WINDOWS_FILE_PATH.lastIndex = 0;
    }

    for (const node of candidates) {
        const text = node.textContent || '';
        const matches = Array.from(text.matchAll(new RegExp(RAW_WINDOWS_FILE_PATH.source, 'g')));
        if (matches.length === 0) continue;

        const fragment = document.createDocumentFragment();
        let offset = 0;
        for (const match of matches) {
            const index = match.index ?? 0;
            if (index > offset) fragment.append(document.createTextNode(text.slice(offset, index)));
            const path = parseAbsoluteLocalPath(match[0]);
            if (path) fragment.append(createPathChip(path, path, labels, actions));
            else fragment.append(document.createTextNode(match[0]));
            offset = index + match[0].length;
        }
        if (offset < text.length) fragment.append(document.createTextNode(text.slice(offset)));
        node.replaceWith(fragment);
    }
}

/** Turn absolute paths in rendered chat content into open/reveal controls. */
export function hydrateLocalFileLinks(
    container: HTMLElement | null,
    labels: LocalFileLinkLabels,
    actions: LocalFileLinkActions,
): void {
    if (!container) return;
    decorateExplicitPaths(container, labels, actions);
    decorateRawFilePaths(container, labels, actions);
}
