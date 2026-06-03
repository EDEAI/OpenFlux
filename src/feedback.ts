/**
 * Standalone feedback window script
 * A standalone page running inside a Tauri WebviewWindow
 *
 * Note: do not use <input type="file">, because in Tauri 2 a child WebviewWindow
 * on Windows closes unexpectedly after opening the system file dialog (a WebView2 bug).
 * Use @tauri-apps/plugin-dialog + @tauri-apps/plugin-fs instead.
 */

import { getCurrentWindow } from '@tauri-apps/api/window';
import { initI18n, applyI18nToDOM, t } from './i18n/index';
import zh from './i18n/zh';
import en from './i18n/en';

// Initialize i18n (inherits the main window's language setting)
initI18n(zh, en);
applyI18nToDOM();


const appWindow = getCurrentWindow();

// Window controls
document.getElementById('fb-minimize')?.addEventListener('click', () => appWindow.minimize());
document.getElementById('fb-close')?.addEventListener('click', () => appWindow.close());
document.getElementById('fb-cancel')?.addEventListener('click', () => appWindow.close());

// Title bar dragging
const headerEl = document.querySelector('.fb-header');
if (headerEl) {
    headerEl.addEventListener('mousedown', (e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        appWindow.startDragging();
    });
}

// Feedback logic
function initFeedback(): void {
    const titleInput = document.getElementById('fb-title') as HTMLInputElement;
    const contentInput = document.getElementById('fb-content') as HTMLTextAreaElement;
    const contactInput = document.getElementById('fb-contact') as HTMLInputElement;

    const addFileBtn = document.getElementById('fb-add-file');
    const fileListEl = document.getElementById('fb-file-list')!;
    const hintEl = document.getElementById('fb-hint')!;
    const submitBtn = document.getElementById('fb-submit') as HTMLButtonElement;
    const typeBtns = document.querySelectorAll('.fb-type-btn');

    let feedbackType = 'bug_report';
    let selectedFiles: File[] = [];

    // Type switching
    typeBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            typeBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            feedbackType = (btn as HTMLElement).dataset.type || 'bug_report';
        });
    });

    // Attachments — use the Tauri Dialog plugin (avoids the WebView2 child-window file input crash)
    addFileBtn?.addEventListener('click', async () => {
        try {
            const { open } = await import('@tauri-apps/plugin-dialog');
            const selected = await open({
                multiple: true,
                title: t('feedback.select_attachment'),
                filters: [
                    { name: t('feedback.file_filter_images'), extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] },
                    { name: t('feedback.file_filter_all'), extensions: ['*'] },
                ],
            });
            if (!selected) return;

            const paths = Array.isArray(selected) ? selected : [selected];
            const { readFile } = await import('@tauri-apps/plugin-fs');
            const { basename } = await import('@tauri-apps/api/path');

            for (const filePath of paths) {
                if (selectedFiles.length >= 6) {
                    setHint(t('feedback.err_too_many_files'), 'error');
                    break;
                }
                const data = await readFile(filePath);
                const name = await basename(filePath);

                // Infer the MIME type
                const ext = name.split('.').pop()?.toLowerCase() || '';
                const mimeMap: Record<string, string> = {
                    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
                    gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
                    pdf: 'application/pdf', txt: 'text/plain', log: 'text/plain',
                    zip: 'application/zip', json: 'application/json',
                };
                const mime = mimeMap[ext] || 'application/octet-stream';

                const file = new File([data], name, { type: mime });
                if (file.size > 10 * 1024 * 1024) {
                    setHint(t('feedback.err_file_too_large', name), 'error');
                    continue;
                }
                selectedFiles.push(file);
            }
            renderFiles();
        } catch (err) {
            console.error('[Feedback] File pick error:', err);
            // Fallback for non-Tauri environments: use a native file input
            const fallbackInput = document.createElement('input');
            fallbackInput.type = 'file';
            fallbackInput.multiple = true;
            fallbackInput.onchange = () => {
                if (!fallbackInput.files) return;
                for (const file of Array.from(fallbackInput.files)) {
                    if (selectedFiles.length >= 6) { setHint(t('feedback.err_too_many_files'), 'error'); break; }
                    if (file.size > 10 * 1024 * 1024) { setHint(t('feedback.err_file_too_large', file.name), 'error'); continue; }
                    selectedFiles.push(file);
                }
                renderFiles();
            };
            fallbackInput.click();
        }
    });

    function renderFiles(): void {
        fileListEl.innerHTML = '';
        selectedFiles.forEach((file, idx) => {
            const item = document.createElement('div');
            item.className = 'fb-file-item';
            const sizeMB = (file.size / 1024 / 1024).toFixed(1);
            item.innerHTML = `<span class="fname">${file.name} (${sizeMB}MB)</span><button class="fremove" data-idx="${idx}">&times;</button>`;
            fileListEl.appendChild(item);
        });
        fileListEl.querySelectorAll('.fremove').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = parseInt((btn as HTMLElement).dataset.idx || '0');
                selectedFiles.splice(idx, 1);
                renderFiles();
            });
        });
    }

    function setHint(msg: string, cls: string): void {
        hintEl.textContent = msg;
        hintEl.className = 'fb-hint' + (cls ? ` ${cls}` : '');
    }

    // Submit
    submitBtn.addEventListener('click', async () => {
        if (!titleInput.value.trim()) { setHint(t('feedback.err_no_title'), 'error'); return; }
        if (!contentInput.value.trim()) { setHint(t('feedback.err_no_content'), 'error'); return; }

        submitBtn.disabled = true;
        setHint(t('feedback.submitting'), '');

        try {

            const payload: Record<string, any> = {
                feedback_type: feedbackType,
                title: titleInput.value.trim(),
                content: contentInput.value.trim(),
                source: 'openflux-desktop',

                client_platform: 'desktop',
                client_os: navigator.platform?.toLowerCase().includes('win') ? 'windows'
                    : navigator.platform?.toLowerCase().includes('mac') ? 'macos' : 'linux',
            };

            // App version
            try {
                const { getVersion } = await import('@tauri-apps/api/app');
                payload.app_version = await getVersion();
            } catch { /* non-Tauri */ }

            // NexusAI account
            const savedUsername = localStorage.getItem('nexusai-username');
            if (savedUsername) payload.nexus_account = savedUsername;

            if (contactInput.value.trim()) payload.contact = contactInput.value.trim();

            const formData = new FormData();
            formData.append('payload', JSON.stringify(payload));
            for (const file of selectedFiles) {
                formData.append('files', file);
            }

            const resp = await fetch('https://openflux.io/api/feedback/submit', {
                method: 'POST',
                body: formData,
            });

            if (!resp.ok) {
                const errText = await resp.text();
                throw new Error(`${resp.status}: ${errText}`);
            }

            const result = await resp.json();
            console.log('[Feedback] Submitted:', result);
            setHint(t('feedback.success'), 'success');

            // Auto-close after 2 seconds
            setTimeout(() => appWindow.close(), 2000);
        } catch (err) {
            console.error('[Feedback] Error:', err);
            setHint(String(err), 'error');
            submitBtn.disabled = false;
        }
    });
}

initFeedback();

