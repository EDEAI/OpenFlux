/**
 * Standalone preview window entry point.
 *
 * Receives the file path via ?file=<path> and hands the rendering to the
 * shared viewer, which the panel's file tab uses as well. This file only owns
 * the window chrome: title bar, drag, and the open/reveal/copy actions.
 */
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { applyI18nToDOM, getLocale, initI18n } from './i18n/index';
import zhPack from './i18n/zh';
import enPack from './i18n/en';
import { formatFileSize, getFileIcon } from './utils/format';
import { fileNameOf, renderFileInto } from './panel/file-viewer';

// Standalone preview windows share the locale preference stored by the main window.
initI18n(zhPack, enPack);
applyI18nToDOM();
document.documentElement.lang = getLocale() === 'zh' ? 'zh-CN' : 'en';

async function main() {
    const appWindow = getCurrentWindow();
    const body = document.getElementById('p-body')!;

    const filePath = new URLSearchParams(window.location.search).get('file');
    if (!filePath) {
        body.innerHTML = '<div class="preview-loading">No file specified</div>';
        return;
    }

    const filename = fileNameOf(filePath);
    document.getElementById('p-icon')!.textContent = getFileIcon(filename);
    document.getElementById('p-name')!.textContent = filename;

    // Window controls
    document.getElementById('p-close')!.addEventListener('click', () => appWindow.close());
    document.getElementById('p-minimize')!.addEventListener('click', () => appWindow.minimize());
    document.querySelector('.preview-header')!.addEventListener('mousedown', (e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        appWindow.startDragging();
    });

    // Action buttons
    document.getElementById('p-open')!.addEventListener('click', () => invoke('file_open', { filePath }));
    document.getElementById('p-reveal')!.addEventListener('click', () => invoke('file_reveal', { filePath }));
    document.getElementById('p-copy')!.addEventListener('click', async () => {
        const pre = body.querySelector('pre');
        if (pre) await navigator.clipboard.writeText(pre.textContent || '');
    });

    const result = await renderFileInto(body, filePath);
    if (result?.size) {
        document.getElementById('p-size')!.textContent = formatFileSize(result.size);
    }
}

main();
