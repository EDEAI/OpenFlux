/**
 * The panel's file tab: browse directories, view a file's contents, copy paths.
 *
 * Read-only by design — there is no create, rename, delete or move, and no
 * Rust command exists to perform one. The only backend call is `dir_list`,
 * plus the pre-existing `file_open` / `file_reveal` for handing a path to the
 * OS.
 *
 * The listing and the preview are shown together in a split view — side by
 * side when the panel is wide, stacked when it is narrow — so a file can be
 * read without losing one's place in the tree.
 */

import { invoke } from '@tauri-apps/api/core';
import { t } from '../i18n/index';
import { formatFileSize, getFileIcon } from '../utils/format';
import { releaseViewerResources, renderFileInto } from './file-viewer';
import { createSplitView, type SplitView } from './split-view';
import { popOverlay, pushOverlay } from './overlay-signal';
import { PANE_TITLE_CHANGED_EVENT, type PaneContentProvider } from './pane-manager';
import { ICON_FILES } from './pane-icons';

interface DirEntryInfo {
    name: string;
    path: string;
    is_dir: boolean;
    size: number;
    modified: number | null;
    is_hidden: boolean;
}

interface DirListResult {
    path: string;
    parent: string | null;
    entries: DirEntryInfo[];
    total: number;
    truncated: boolean;
}

/**
 * Remembered directory, per pane. Pane ids are stable within a session's
 * layout, so this doubles as per-session memory: every file tab of every
 * session reopens where it was left.
 */
const LAST_DIR_KEY_PREFIX = 'openflux-files-pane-dir:';
function lastDirKey(paneId: string): string {
    return LAST_DIR_KEY_PREFIX + paneId;
}
/** Current directory of each mounted pane, for the tab title. */
const currentDirs = new Map<string, string>();

function folderName(path: string): string {
    const trimmed = path.replace(/[\\/]+$/, '');
    return trimmed.split(/[\\/]/).pop() || trimmed;
}
const SHOW_HIDDEN_KEY = 'openflux-files-pane-hidden';
const SPLIT_KEY = 'openflux-files-pane-split';

export interface FilePaneOptions {
    /** Directory to open when nothing is remembered — usually the active project. */
    initialDirectory?: () => string | undefined;
}

const ICON_UP = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15" /></svg>';
const ICON_REFRESH = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>';
const ICON_EYE = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>';
const ICON_COPY = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>';
const ICON_OPEN = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>';
const ICON_REVEAL = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>';

let openContextMenu: HTMLElement | null = null;

function closeContextMenu(): void {
    if (!openContextMenu) return;
    openContextMenu.remove();
    openContextMenu = null;
    popOverlay();
}

document.addEventListener('click', closeContextMenu);
document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeContextMenu();
});

/** A small menu anchored to the pointer, kept inside the viewport. */
function showContextMenu(x: number, y: number, items: Array<{ label: string; onClick: () => void }>): void {
    closeContextMenu();

    const menu = document.createElement('div');
    menu.className = 'panel-add-menu file-context-menu';
    menu.setAttribute('role', 'menu');
    for (const item of items) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'panel-add-item';
        button.setAttribute('role', 'menuitem');
        button.textContent = item.label;
        button.addEventListener('click', item.onClick);
        menu.append(button);
    }

    menu.style.visibility = 'hidden';
    document.body.append(menu);
    const box = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - box.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - box.height - 8))}px`;
    menu.style.visibility = '';

    openContextMenu = menu;
    pushOverlay();
}

function iconButton(html: string, title: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'file-pane-btn';
    button.innerHTML = html;
    button.title = title;
    return button;
}

async function copyToClipboard(text: string, feedbackOn?: HTMLElement): Promise<void> {
    try {
        await navigator.clipboard.writeText(text);
        if (feedbackOn) {
            const original = feedbackOn.title;
            feedbackOn.title = t('common.copied');
            feedbackOn.classList.add('copied');
            setTimeout(() => {
                feedbackOn.title = original;
                feedbackOn.classList.remove('copied');
            }, 1200);
        }
    } catch (error) {
        console.warn('[Files] Clipboard write failed:', error);
    }
}

export function createFilePaneProvider(options: FilePaneOptions = {}): PaneContentProvider {
    const disposers = new WeakMap<HTMLElement, () => void>();
    return {
        kind: 'files',
        icon: ICON_FILES,
        titleKey: 'panel.pane_files',
        singleton: false,
        title: pane => {
            const dir = currentDirs.get(pane.id) ?? localStorage.getItem(lastDirKey(pane.id));
            return dir ? folderName(dir) : t('panel.pane_files');
        },
        mount: (body, pane) => {
            disposers.set(body, mountFilePane(body, options, pane.id));
        },
        unmount: (body, pane) => {
            disposers.get(body)?.();
            disposers.delete(body);
            currentDirs.delete(pane.id);
            body.innerHTML = '';
        },
    };
}

/** Mounts the pane and returns its teardown. */
function mountFilePane(body: HTMLElement, options: FilePaneOptions, paneId: string): () => void {
    body.classList.add('file-pane');

    // --- chrome -----------------------------------------------------------
    const toolbar = document.createElement('div');
    toolbar.className = 'file-pane-toolbar';

    const upBtn = iconButton(ICON_UP, t('files.up'));
    const crumb = document.createElement('button');
    crumb.type = 'button';
    crumb.className = 'file-pane-crumb';
    const refreshBtn = iconButton(ICON_REFRESH, t('files.refresh'));
    const hiddenBtn = iconButton(ICON_EYE, t('files.show_hidden'));
    const copyPathBtn = iconButton(ICON_COPY, t('files.copy_path'));
    const openBtn = iconButton(ICON_OPEN, t('preview.open'));
    const revealBtn = iconButton(ICON_REVEAL, t('preview.show_in_folder'));

    toolbar.append(upBtn, crumb, copyPathBtn, openBtn, revealBtn, hiddenBtn, refreshBtn);
    body.append(toolbar);

    const split: SplitView = createSplitView(body, { storageKey: SPLIT_KEY, defaultRatio: 0.4 });
    const list = split.primary;
    list.classList.add('file-pane-list');
    const viewer = split.secondary;
    viewer.classList.add('file-pane-viewer');

    // --- state ------------------------------------------------------------
    let currentDir = '';
    let parentDir: string | null = null;
    let selectedFile: string | null = null;
    let showHidden = localStorage.getItem(SHOW_HIDDEN_KEY) === '1';
    // Guards against an earlier, slower load overwriting a newer one, for the
    // listing and the preview alike.
    let loadToken = 0;

    function showViewerHint(): void {
        releaseViewerResources(viewer);
        viewer.innerHTML = '';
        const hint = document.createElement('div');
        hint.className = 'pane-preview-hint';
        hint.textContent = t('files.preview_hint');
        viewer.append(hint);
    }

    function syncChrome(): void {
        upBtn.disabled = parentDir === null;
        crumb.textContent = currentDir || '…';
        crumb.title = currentDir;
        hiddenBtn.classList.toggle('active', showHidden);

        // The toolbar acts on the selected file, or the folder when none is.
        const target = selectedFile ?? currentDir;
        for (const button of [copyPathBtn, openBtn, revealBtn]) button.disabled = !target;
    }

    function currentTarget(): string | null {
        return selectedFile ?? (currentDir || null);
    }

    function entryMenuItems(entry: DirEntryInfo): Array<{ label: string; onClick: () => void }> {
        return [
            { label: t('files.copy_path'), onClick: () => void copyToClipboard(entry.path) },
            { label: t('files.copy_name'), onClick: () => void copyToClipboard(entry.name) },
            { label: t('preview.open'), onClick: () => void invoke('file_open', { filePath: entry.path }) },
            { label: t('preview.show_in_folder'), onClick: () => void invoke('file_reveal', { filePath: entry.path }) },
        ];
    }

    function markSelectedRow(path: string | null): void {
        for (const row of list.querySelectorAll<HTMLElement>('.file-pane-row')) {
            row.classList.toggle('selected', path !== null && row.dataset.path === path);
        }
    }

    function renderEntries(result: DirListResult): void {
        list.innerHTML = '';

        if (result.entries.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'file-pane-empty';
            empty.textContent = t('files.empty');
            list.append(empty);
            return;
        }

        for (const entry of result.entries) {
            const row = document.createElement('div');
            row.className = 'file-pane-row';
            row.classList.toggle('is-dir', entry.is_dir);
            row.classList.toggle('is-hidden-entry', entry.is_hidden);
            row.dataset.path = entry.path;
            row.title = entry.path;

            const icon = document.createElement('span');
            icon.className = 'file-pane-row-icon';
            icon.textContent = entry.is_dir ? '📁' : getFileIcon(entry.name);

            const name = document.createElement('span');
            name.className = 'file-pane-row-name';
            name.textContent = entry.name;

            const meta = document.createElement('span');
            meta.className = 'file-pane-row-meta';
            meta.textContent = entry.is_dir ? '' : formatFileSize(entry.size);

            row.append(icon, name, meta);
            row.addEventListener('click', () => {
                if (entry.is_dir) void loadDirectory(entry.path);
                else void selectFile(entry.path);
            });
            row.addEventListener('contextmenu', event => {
                event.preventDefault();
                event.stopPropagation();
                showContextMenu(event.clientX, event.clientY, entryMenuItems(entry));
            });

            list.append(row);
        }

        if (result.truncated) {
            const note = document.createElement('div');
            note.className = 'file-pane-truncated';
            note.textContent = t('files.truncated', String(result.entries.length), String(result.total));
            list.append(note);
        }
    }

    async function loadDirectory(dirPath: string): Promise<void> {
        const token = ++loadToken;
        selectedFile = null;
        showViewerHint();

        try {
            const result = await invoke<DirListResult>('dir_list', { dirPath, showHidden });
            if (token !== loadToken) return;

            currentDir = result.path;
            parentDir = result.parent;
            localStorage.setItem(lastDirKey(paneId), currentDir);
            currentDirs.set(paneId, currentDir);
            document.dispatchEvent(new CustomEvent(PANE_TITLE_CHANGED_EVENT));
            renderEntries(result);
        } catch (error) {
            if (token !== loadToken) return;
            list.innerHTML = '';
            const failure = document.createElement('div');
            failure.className = 'file-pane-empty';
            failure.textContent = t('files.load_failed', String(error));
            list.append(failure);
        }
        syncChrome();
    }

    async function selectFile(filePath: string): Promise<void> {
        const token = ++loadToken;
        selectedFile = filePath;
        markSelectedRow(filePath);
        syncChrome();

        releaseViewerResources(viewer);
        viewer.innerHTML = `<div class="pane-preview-hint">${t('files.loading')}</div>`;
        await renderFileInto(viewer, filePath);
        // A directory change while the file was loading wins.
        if (token !== loadToken) return;
    }

    // --- wiring -----------------------------------------------------------
    upBtn.addEventListener('click', () => {
        if (parentDir) void loadDirectory(parentDir);
    });

    crumb.addEventListener('click', () => {
        if (currentDir) void copyToClipboard(currentDir, crumb);
    });

    refreshBtn.addEventListener('click', () => {
        if (currentDir) void loadDirectory(currentDir);
    });

    hiddenBtn.addEventListener('click', () => {
        showHidden = !showHidden;
        localStorage.setItem(SHOW_HIDDEN_KEY, showHidden ? '1' : '0');
        if (currentDir) void loadDirectory(currentDir);
        else syncChrome();
    });

    copyPathBtn.addEventListener('click', () => {
        const target = currentTarget();
        if (target) void copyToClipboard(target, copyPathBtn);
    });
    openBtn.addEventListener('click', () => {
        const target = currentTarget();
        if (target) void invoke('file_open', { filePath: target });
    });
    revealBtn.addEventListener('click', () => {
        const target = currentTarget();
        if (target) void invoke('file_reveal', { filePath: target });
    });

    const onLocaleChanged = () => {
        upBtn.title = t('files.up');
        refreshBtn.title = t('files.refresh');
        hiddenBtn.title = t('files.show_hidden');
        copyPathBtn.title = t('files.copy_path');
        openBtn.title = t('preview.open');
        revealBtn.title = t('preview.show_in_folder');
        if (selectedFile === null) showViewerHint();
    };
    document.addEventListener('locale-changed', onLocaleChanged);

    showViewerHint();
    syncChrome();
    void resolveStartDirectory(options, paneId).then(start => {
        // The pane may have been closed while the home directory resolved.
        if (!body.isConnected && paneId) return;
        if (start) void loadDirectory(start);
        else syncChrome();
    });

    return () => {
        document.removeEventListener('locale-changed', onLocaleChanged);
        releaseViewerResources(viewer);
        split.dispose();
    };
}

/**
 * Where the file tab opens: the directory it was last left in, else the active
 * project's workspace, else the user's home directory.
 */
async function resolveStartDirectory(options: FilePaneOptions, paneId: string): Promise<string | undefined> {
    const remembered = localStorage.getItem(lastDirKey(paneId));
    if (remembered && await invoke<boolean>('file_exists', { filePath: remembered }).catch(() => false)) {
        return remembered;
    }

    const initial = options.initialDirectory?.();
    if (initial) return initial;

    try {
        const { homeDir } = await import('@tauri-apps/api/path');
        return await homeDir();
    } catch (error) {
        console.warn('[Files] Could not resolve a home directory:', error);
        return undefined;
    }
}
