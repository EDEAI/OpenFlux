/**
 * Afrodita File Manager — Total Commander Style
 * Dual-pane file browser with JARVIS-style UI
 * Communicates with AI via tool-calling bridge
 */

import { invoke } from '@tauri-apps/api/core';
import { open as tauriOpen } from '@tauri-apps/plugin-dialog';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FileEntry {
    name: string;
    path: string;
    isDirectory: boolean;
    size: number;
    modified: number; // Unix timestamp
    isSymlink: boolean;
}

export interface PaneState {
    path: string;
    entries: FileEntry[];
    selectedIndex: number;
    sortBy: 'name' | 'size' | 'modified';
    sortAsc: boolean;
    showHidden: boolean;
}

export interface FileManagerOptions {
    initialLeftPath?: string;
    initialRightPath?: string;
    onFileOpenRequest?: (path: string) => void;
    onFileSelectedForAI?: (path: string) => void;
}

// ─── File Manager Class ───────────────────────────────────────────────────────

export class AfroditaFileManager {
    private container: HTMLElement;
    private left!: PaneState;
    private right!: PaneState;
    private activePane: 'left' | 'right' = 'left';
    private options: FileManagerOptions;

    constructor(container: HTMLElement, options: FileManagerOptions = {}) {
        this.container = container;
        this.options = options;
        this.initPanes(options.initialLeftPath || this.homePath(), options.initialRightPath || this.homePath());
        this.render();
    }

    private homePath(): string {
        // Use the user's home directory as default
        return process.env.HOME || process.env.USERPROFILE || '/';
    }

    private async initPanes(leftPath: string, rightPath: string): Promise<void> {
        this.left = { path: leftPath, entries: [], selectedIndex: -1, sortBy: 'name', sortAsc: true, showHidden: false };
        this.right = { path: rightPath, entries: [], selectedIndex: -1, sortBy: 'name', sortAsc: true, showHidden: false };
        await Promise.all([this.refreshPane('left'), this.refreshPane('right')]);
    }

    // ─── Path Operations ───────────────────────────────────────────────────

    async cd(pane: 'left' | 'right', path: string): Promise<void> {
        const ps = this.getPane(pane);
        ps.path = path;
        ps.selectedIndex = -1;
        await this.refreshPane(pane);
    }

    async parent(pane: 'left' | 'right'): Promise<void> {
        const ps = this.getPane(pane);
        const parent = ps.path.substring(0, ps.path.lastIndexOf(this.sep()));
        if (parent) await this.cd(pane, parent);
    }

    async selectEntry(pane: 'left' | 'right', index: number): Promise<void> {
        const ps = this.getPane(pane);
        ps.selectedIndex = index;
        if (index >= 0 && ps.entries[index].isDirectory) {
            await this.cd(pane, ps.entries[index].path);
        }
        this.render();
    }

    async refreshPane(pane: 'left' | 'right'): Promise<void> {
        const ps = this.getPane(pane);
        try {
            ps.entries = await this.listDir(ps.path);
            this.sortEntries(ps);
        } catch (e) {
            ps.entries = [];
            console.error(`[FileManager] Failed to list ${ps.path}:`, e);
        }
    }

    // ─── Tauri FS Bridge ───────────────────────────────────────────────────

    private async listDir(path: string): Promise<FileEntry[]> {
        return invoke<FileEntry[]>('fs_list_dir', { path });
    }

    // ─── Sorting ────────────────────────────────────────────────────────────

    private sortEntries(ps: PaneState): void {
        const { sortBy, sortAsc } = ps;
        ps.entries.sort((a, b) => {
            // Directories always first
            if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
            let cmp = 0;
            if (sortBy === 'name') cmp = a.name.localeCompare(b.name);
            else if (sortBy === 'size') cmp = a.size - b.size;
            else if (sortBy === 'modified') cmp = a.modified - b.modified;
            return sortAsc ? cmp : -cmp;
        });
    }

    toggleSort(pane: 'left' | 'right', column: 'name' | 'size' | 'modified'): void {
        const ps = this.getPane(pane);
        if (ps.sortBy === column) ps.sortAsc = !ps.sortAsc;
        else { ps.sortBy = column; ps.sortAsc = true; }
        this.sortEntries(ps);
        this.render();
    }

    toggleHidden(pane: 'left' | 'right'): void {
        const ps = this.getPane(pane);
        ps.showHidden = !ps.showHidden;
        this.render();
    }

    // ─── Copy Between Panes ────────────────────────────────────────────────

    async copyToOtherPane(): Promise<void> {
        const ps = this.getPane(this.activePane);
        if (ps.selectedIndex < 0) return;
        const entry = ps.entries[ps.selectedIndex];
        const destPane = this.activePane === 'left' ? 'right' : 'left';
        const destPS = this.getPane(destPane);
        const destPath = destPS.path + this.sep() + entry.name;
        try {
            await invoke('fs_copy_entry', { sourcePath: entry.path, destPath });
            await this.refreshPane(destPane);
        } catch (e) {
            console.error('[FileManager] Copy failed:', e);
        }
    }

    async copyToActivePane(sourcePath: string): Promise<void> {
        const ps = this.getPane(this.activePane);
        const name = sourcePath.split(this.sep()).pop() || 'file';
        const destPath = ps.path + this.sep() + name;
        try {
            await invoke('fs_copy_entry', { sourcePath, destPath });
            await this.refreshPane(this.activePane);
        } catch (e) {
            console.error('[FileManager] Copy to active pane failed:', e);
        }
    }

    // ─── Getters ────────────────────────────────────────────────────────────

    private getPane(pane: 'left' | 'right'): PaneState {
        return pane === 'left' ? this.left : this.right;
    }

    private sep(): string {
        return this.left.path.includes('/') ? '/' : '\\';
    }

    getActivePanePath(): string {
        return this.getPane(this.activePane).path;
    }

    getSelectedPath(): string | null {
        const ps = this.getPane(this.activePane);
        if (ps.selectedIndex < 0) return null;
        return ps.entries[ps.selectedIndex].path;
    }

    // ─── Render ────────────────────────────────────────────────────────────

    render(): void {
        if (!this.container) return;
        this.container.innerHTML = this.buildHTML();
        this.attachEvents();
    }

    private buildHTML(): string {
        return `
        <style>
        .afro-fm {
            display: flex;
            flex-direction: column;
            height: 100%;
            background: rgba(4, 6, 10, 0.96);
            border: 1px solid rgba(64, 200, 255, 0.2);
            border-radius: 10px;
            overflow: hidden;
            font-family: 'Courier New', monospace;
            font-size: 12px;
            color: #b0e8ff;
        }
        .afro-fm-bar {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 12px;
            background: rgba(64, 200, 255, 0.06);
            border-bottom: 1px solid rgba(64, 200, 255, 0.15);
        }
        .afro-fm-btn {
            background: rgba(64, 200, 255, 0.08);
            border: 1px solid rgba(64, 200, 255, 0.25);
            border-radius: 5px;
            color: rgba(64, 200, 255, 0.7);
            font-size: 11px;
            padding: 3px 8px;
            cursor: pointer;
        }
        .afro-fm-btn:hover { background: rgba(64, 200, 255, 0.18); color: #40c4ff; }
        .afro-fm-btn.active { background: rgba(64, 200, 255, 0.2); color: #40c4ff; border-color: rgba(64, 200, 255, 0.5); }
        .afro-fm-panes { display: flex; flex: 1; overflow: hidden; gap: 1px; background: rgba(64, 200, 255, 0.08); }
        .afro-fm-pane { flex: 1; display: flex; flex-direction: column; overflow: hidden; background: rgba(4, 6, 10, 0.95); }
        .afro-fm-pane.active { background: rgba(4, 12, 20, 0.97); }
        .afro-fm-pathbar {
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 5px 8px;
            background: rgba(64, 200, 255, 0.05);
            border-bottom: 1px solid rgba(64, 200, 255, 0.1);
        }
        .afro-fm-path {
            flex: 1;
            color: #40c4ff;
            font-size: 11px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .afro-fm-path input {
            width: 100%;
            background: rgba(64, 200, 255, 0.06);
            border: 1px solid rgba(64, 200, 255, 0.3);
            border-radius: 4px;
            color: #40c4ff;
            font-family: inherit;
            font-size: 11px;
            padding: 2px 6px;
            outline: none;
        }
        .afro-fm-cols {
            display: flex;
            padding: 3px 8px;
            background: rgba(64, 200, 255, 0.04);
            border-bottom: 1px solid rgba(64, 200, 255, 0.1);
            font-size: 10px;
            color: rgba(64, 200, 255, 0.45);
            text-transform: uppercase;
            letter-spacing: 1px;
        }
        .afro-fm-cols span { cursor: pointer; user-select: none; }
        .afro-fm-cols span:hover { color: #40c4ff; }
        .afro-fm-cols .col-name { flex: 1; }
        .afro-fm-cols .col-size { width: 80px; text-align: right; }
        .afro-fm-cols .col-date { width: 130px; text-align: left; }
        .afro-fm-list { flex: 1; overflow-y: auto; padding: 2px 0; }
        .afro-fm-list::-webkit-scrollbar { width: 6px; }
        .afro-fm-list::-webkit-scrollbar-track { background: transparent; }
        .afro-fm-list::-webkit-scrollbar-thumb { background: rgba(64, 200, 255, 0.2); border-radius: 3px; }
        .afro-fm-entry {
            display: flex;
            align-items: center;
            padding: 2px 8px;
            cursor: pointer;
            border-left: 2px solid transparent;
        }
        .afro-fm-entry:hover { background: rgba(64, 200, 255, 0.07); }
        .afro-fm-entry.selected { background: rgba(64, 200, 255, 0.12); border-left-color: #40c4ff; }
        .afro-fm-entry .entry-icon { width: 16px; text-align: center; margin-right: 4px; font-size: 11px; }
        .afro-fm-entry .entry-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #d4f0ff; }
        .afro-fm-entry .entry-size { width: 80px; text-align: right; color: rgba(64, 200, 255, 0.5); font-size: 11px; }
        .afro-fm-entry .entry-date { width: 130px; color: rgba(64, 200, 255, 0.4); font-size: 10px; }
        .afro-fm-entry.dir .entry-name { color: #69f0ae; }
        .afro-fm-divider { width: 4px; background: rgba(64, 200, 255, 0.15); cursor: col-resize; }
        .afro-fm-divider:hover { background: rgba(64, 200, 255, 0.35); }
        .afro-fm-status {
            display: flex;
            justify-content: space-between;
            padding: 4px 10px;
            background: rgba(64, 200, 255, 0.04);
            border-top: 1px solid rgba(64, 200, 255, 0.1);
            font-size: 10px;
            color: rgba(64, 200, 255, 0.4);
        }
        </style>
        <div class="afro-fm">
            <div class="afro-fm-bar">
                <button class="afro-fm-btn" data-cmd="parent" title="Parent directory">↑</button>
                <button class="afro-fm-btn" data-cmd="refresh" title="Refresh">↻</button>
                <button class="afro-fm-btn" data-cmd="hidden" title="Toggle hidden files">•</button>
                <button class="afro-fm-btn" data-cmd="copy" title="Copy to other pane">⇆</button>
                <button class="afro-fm-btn" data-cmd="home" title="Home">⌂</button>
                <div style="flex:1"></div>
                <button class="afro-fm-btn" data-cmd="close" title="Close (Esc)">✕</button>
            </div>
            <div class="afro-fm-panes">
                ${this.buildPaneHTML('left')}
                <div class="afro-fm-divider"></div>
                ${this.buildPaneHTML('right')}
            </div>
            <div class="afro-fm-status">
                <span class="afro-fm-status-left">${this.left.path}</span>
                <span class="afro-fm-status-right">${this.right.path}</span>
            </div>
        </div>`;
    }

    private buildPaneHTML(pane: 'left' | 'right'): string {
        const ps = this.getPane(pane);
        const isActive = this.activePane === pane;
        const sortIcon = (col: string) => ps.sortBy === col ? (ps.sortAsc ? ' ▲' : ' ▼') : '';

        return `
        <div class="afro-fm-pane ${isActive ? 'active' : ''}" data-pane="${pane}">
            <div class="afro-fm-pathbar">
                <button class="afro-fm-btn" data-pane="${pane}" data-cmd="parent">↑</button>
                <div class="afro-fm-path" data-pane="${pane}" data-cmd="pathclick">${this.escapeHTML(ps.path)}</div>
                <button class="afro-fm-btn" data-pane="${pane}" data-cmd="home">⌂</button>
            </div>
            <div class="afro-fm-cols">
                <span class="col-name" data-pane="${pane}" data-cmd="sort" data-col="name">Název${sortIcon('name')}</span>
                <span class="col-size" data-pane="${pane}" data-cmd="sort" data-col="size">Velikost${sortIcon('size')}</span>
                <span class="col-date" data-pane="${pane}" data-cmd="sort" data-col="modified">Změněno${sortIcon('modified')}</span>
            </div>
            <div class="afro-fm-list" data-pane="${pane}">
                ${ps.entries
                    .filter(e => ps.showHidden || !e.name.startsWith('.'))
                    .map((e, i) => this.buildEntryHTML(e, i, ps))
                    .join('')}
            </div>
        </div>`;
    }

    private buildEntryHTML(entry: FileEntry, index: number, ps: PaneState): string {
        const icon = entry.isDirectory ? '📁' : this.fileIcon(entry.name);
        const size = entry.isDirectory ? '—' : this.formatSize(entry.size);
        const date = new Date(entry.modified * 1000).toLocaleString('cs-CZ', { dateStyle: 'short', timeStyle: 'short' });
        const selected = ps.selectedIndex === index ? 'selected' : '';
        return `
        <div class="afro-fm-entry ${entry.isDirectory ? 'dir' : 'file'} ${selected}"
             data-pane="${this.activePane}"
             data-index="${index}">
            <span class="entry-icon">${icon}</span>
            <span class="entry-name" title="${this.escapeHTML(entry.path)}">${this.escapeHTML(entry.name)}</span>
            <span class="entry-size">${size}</span>
            <span class="entry-date">${date}</span>
        </div>`;
    }

    private fileIcon(name: string): string {
        const ext = name.split('.').pop()?.toLowerCase() || '';
        const icons: Record<string, string> = {
            ts: '🔷', tsx: '🔷', js: '🟨', jsx: '🟨', py: '🐍', rs: '🦀',
            json: '📋', yaml: '📋', yml: '📋', xml: '📋',
            html: '🌐', css: '🎨', scss: '🎨', md: '📝', txt: '📄',
            png: '🖼', jpg: '🖼', jpeg: '🖼', gif: '🖼', svg: '🖼', webp: '🖼',
            mp3: '🎵', wav: '🎵', flac: '🎵', mp4: '🎬', mkv: '🎬', avi: '🎬',
            zip: '📦', tar: '📦', gz: '📦', rar: '📦', seven: '📦',
            pdf: '📕', doc: '📘', docx: '📘', xls: '📗', xlsx: '📗',
            exe: '⚙', dll: '⚙', so: '⚙', dylib: '⚙',
            sh: '📜', bash: '📜', zsh: '📜', bat: '📜', cmd: '📜',
        };
        return icons[ext] || '📄';
    }

    private formatSize(bytes: number): string {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
    }

    private escapeHTML(s: string): string {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // ─── Event Handling ────────────────────────────────────────────────────

    private attachEvents(): void {
        if (!this.container) return;
        const list = this.container.querySelectorAll('.afro-fm-list');
        list.forEach(listEl => {
            (listEl as HTMLElement).addEventListener('click', async (e) => {
                const target = e.target as HTMLElement;
                const entry = target.closest('.afro-fm-entry') as HTMLElement;
                if (!entry) return;
                const pane = entry.dataset.pane as 'left' | 'right';
                const index = parseInt(entry.dataset.index || '-1');
                this.activePane = pane;
                this.getPane(pane).selectedIndex = index;
                const ps = this.getPane(pane);
                if (ps.entries[index]?.isDirectory) {
                    await this.cd(pane, ps.entries[index].path);
                } else {
                    this.options.onFileSelectedForAI?.(ps.entries[index]?.path);
                    this.render();
                }
            });
        });

        // Pane click to focus
        this.container.querySelectorAll('.afro-fm-pane').forEach(paneEl => {
            (paneEl as HTMLElement).addEventListener('click', (e) => {
                const target = e.target as HTMLElement;
                if (target.closest('.afro-fm-entry') || target.closest('.afro-fm-cols')) return;
                const pane = (paneEl as HTMLElement).dataset.pane as 'left' | 'right';
                this.activePane = pane;
                this.render();
            });
        });

        // Global command buttons
        this.container.querySelectorAll('[data-cmd]').forEach(btn => {
            (btn as HTMLElement).addEventListener('click', async (e) => {
                e.stopPropagation();
                const target = btn as HTMLElement;
                const cmd = target.dataset.cmd;
                const pane = (target.dataset.pane || this.activePane) as 'left' | 'right';
                await this.execCmd(cmd!, pane);
            });
        });

        // Keyboard navigation
        this.container.addEventListener('keydown', (e) => this.handleKeydown(e as KeyboardEvent));
    }

    private async execCmd(cmd: string, pane: 'left' | 'right'): Promise<void> {
        switch (cmd) {
            case 'parent': await this.parent(pane); break;
            case 'refresh': await this.refreshPane(pane); await this.refreshPane(pane === 'left' ? 'right' : 'left'); break;
            case 'hidden': this.toggleHidden(pane); break;
            case 'copy': await this.copyToOtherPane(); break;
            case 'home': await this.cd(pane, this.homePath()); break;
            case 'close': this.close(); return;
            case 'sort': this.toggleSort(pane, pane as 'name' | 'size' | 'modified'); break;
        }
        this.render();
    }

    private handleKeydown(e: KeyboardEvent): void {
        const ps = this.getPane(this.activePane);
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            ps.selectedIndex = Math.max(0, ps.selectedIndex - 1);
            this.render();
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            ps.selectedIndex = Math.min(ps.entries.length - 1, ps.selectedIndex + 1);
            this.render();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (ps.selectedIndex >= 0) {
                const entry = ps.entries[ps.selectedIndex];
                if (entry.isDirectory) this.cd(this.activePane, entry.path);
                else this.options.onFileOpenRequest?.(entry.path);
            }
        } else if (e.key === 'Tab') {
            e.preventDefault();
            this.activePane = this.activePane === 'left' ? 'right' : 'left';
            this.render();
        } else if (e.key === 'Escape') {
            this.close();
        }
    }

    close(): void {
        this.container.innerHTML = '';
        this.container.classList.remove('afro-fm-open');
        // Emit close event
        this.container.dispatchEvent(new CustomEvent('fm-close', { bubbles: true }));
    }

    async openPath(path: string): Promise<void> {
        // Set path in active pane, navigate to it
        const ps = this.getPane(this.activePane);
        const name = path.split(this.sep()).pop() || path;
        // Find if it's a file or directory
        const exists = await invoke<boolean>('file_exists', { filePath: path });
        if (!exists) return;
        // Navigate to parent directory and select the file
        const parent = path.substring(0, path.lastIndexOf(this.sep()));
        await this.cd(this.activePane, parent || path);
        // Find and select
        const idx = this.getPane(this.activePane).entries.findIndex(e => e.name === name);
        if (idx >= 0) {
            this.getPane(this.activePane).selectedIndex = idx;
            this.render();
        }
    }

    // ─── AI Bridge ─────────────────────────────────────────────────────────

    /** Called by AI tool handler to open file manager at a specific path */
    async openAt(path: string): Promise<void> {
        this.activePane = 'left';
        await this.cd('left', path);
        this.render();
    }

    /** Called by AI to sync both panes to specific paths */
    async syncPanes(leftPath: string, rightPath: string): Promise<void> {
        await Promise.all([this.cd('left', leftPath), this.cd('right', rightPath)]);
        this.render();
    }
}

// ─── Standalone API (for Tauri invoke bridge) ────────────────────────────────

export interface FsListDirResult {
    entries: FileEntry[];
}

let _fmInstance: AfroditaFileManager | null = null;

export function getFileManagerInstance(): AfroditaFileManager | null {
    return _fmInstance;
}

export function initFileManager(opts: FileManagerOptions = {}): AfroditaFileManager {
    // Find or create container
    let container = document.getElementById('afrodita-filemanager');
    if (!container) {
        container = document.createElement('div');
        container.id = 'afrodita-filemanager';
        document.body.appendChild(container);
    }
    container.classList.add('afro-fm-open');
    _fmInstance = new AfroditaFileManager(container, opts);
    return _fmInstance;
}

export function closeFileManager(): void {
    _fmInstance?.close();
    _fmInstance = null;
}

export function isFileManagerOpen(): boolean {
    return _fmInstance !== null;
}
