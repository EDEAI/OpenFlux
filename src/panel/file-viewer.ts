/**
 * Shared file content renderer.
 *
 * Extracted from the standalone preview window so the same rendering serves
 * both that window and the panel's file tab. Every renderer writes into a host
 * element the caller owns; nothing here assumes a particular window.
 */

import { invoke } from '@tauri-apps/api/core';
import { renderMarkdown } from '../markdown';
import { escapeHtml, getFileIcon } from '../utils/format';
import { t } from '../i18n/index';

export interface FileReadResult {
    content: string;
    mime_type: string;
    is_binary: boolean;
    size: number;
}

export const TEXT_EXTS = new Set([
    'txt', 'md', 'json', 'yaml', 'yml', 'xml', 'csv', 'log', 'ini', 'conf', 'cfg',
    'py', 'js', 'ts', 'jsx', 'tsx', 'html', 'css', 'scss', 'less', 'sass',
    'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'swift', 'kt',
    'sh', 'bash', 'bat', 'ps1', 'cmd',
    'sql', 'graphql', 'proto',
    'toml', 'env', 'gitignore', 'dockerfile', 'makefile',
]);

export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico']);

const VIDEO_EXTS = new Set(['mp4', 'webm', 'avi', 'mov', 'mkv']);

export function fileNameOf(filePath: string): string {
    return filePath.split(/[/\\]/).pop() || 'unknown';
}

function extensionOf(filePath: string): string {
    return fileNameOf(filePath).split('.').pop()?.toLowerCase() || '';
}

/** Blob URLs handed to an <iframe>; revoked when the host is re-rendered. */
const blobUrlsByHost = new WeakMap<HTMLElement, string[]>();

function trackBlobUrl(host: HTMLElement, url: string): void {
    const urls = blobUrlsByHost.get(host) ?? [];
    urls.push(url);
    blobUrlsByHost.set(host, urls);
}

/**
 * Release the blob URLs an earlier render handed to this host. Callers that
 * discard the host entirely should call it too, so a closed tab does not pin
 * a whole PDF in memory.
 */
export function releaseViewerResources(host: HTMLElement): void {
    for (const url of blobUrlsByHost.get(host) ?? []) URL.revokeObjectURL(url);
    blobUrlsByHost.delete(host);
}

function notice(host: HTMLElement, icon: string, text: string): void {
    host.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'file-preview-unsupported';
    const iconEl = document.createElement('div');
    iconEl.className = 'file-preview-unsupported-icon';
    iconEl.textContent = icon;
    const textEl = document.createElement('div');
    textEl.className = 'file-preview-unsupported-text';
    textEl.textContent = text;
    wrap.append(iconEl, textEl);
    host.append(wrap);
}

function base64ToBytes(base64: string): Uint8Array {
    return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}

/** An iframe fed by srcdoc/blob, built as DOM so no attribute escaping is needed. */
function appendIframe(host: HTMLElement, className: string, source: { src?: string; srcdoc?: string }): void {
    const frame = document.createElement('iframe');
    frame.className = className;
    frame.style.cssText = 'width:100%;height:100%;border:none;';
    if (source.src) frame.src = source.src;
    if (source.srcdoc !== undefined) {
        frame.srcdoc = source.srcdoc;
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
        frame.style.background = '#fff';
    }
    host.innerHTML = '';
    host.append(frame);
}

function renderPdf(host: HTMLElement, base64: string): void {
    const blob = new Blob([base64ToBytes(base64)], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    trackBlobUrl(host, url);
    appendIframe(host, 'file-preview-pdf', { src: url });
}

/**
 * OpenFlux presentations are exported with visual sidecars. Prefer the PDF
 * because it preserves every slide, shape, chart and image at readable size.
 * The contact sheet remains a fallback for environments where PDF export was
 * unavailable. Returning false lets legacy/external PPTX files fall back to
 * the text-only OOXML summary.
 */
async function renderPresentationVisualPreview(filePath: string, host: HTMLElement): Promise<boolean> {
    const sidecar = (suffix: string) => filePath.replace(/\.pptx$/i, suffix);

    const pdfPath = sidecar('.pdf');
    if (await invoke<boolean>('file_exists', { filePath: pdfPath }).catch(() => false)) {
        const pdf = await invoke<FileReadResult>('file_read', { filePath: pdfPath }).catch(() => undefined);
        if (pdf?.content) {
            renderPdf(host, pdf.content);
            return true;
        }
    }

    const sheetPath = sidecar('-preview.png');
    if (await invoke<boolean>('file_exists', { filePath: sheetPath }).catch(() => false)) {
        const sheet = await invoke<FileReadResult>('file_read', { filePath: sheetPath }).catch(() => undefined);
        if (sheet?.content) {
            host.innerHTML = '';
            const container = document.createElement('div');
            container.className = 'file-preview-image-container';
            const img = document.createElement('img');
            img.src = sheet.content;
            img.alt = fileNameOf(filePath);
            container.append(img);
            host.append(container);
            return true;
        }
    }

    return false;
}

/**
 * Text/code with a gutter whose scroll follows the content. Exported so
 * inline artifacts (code the agent produced without a file) share the look.
 */
export function renderTextInto(host: HTMLElement, content: string): void {
    const lines = content.split('\n');
    const lineNums = lines.map((_, i) => `<span>${i + 1}</span>`).join('');
    host.innerHTML = `
        <div class="file-preview-code">
            <div class="file-preview-line-numbers">${lineNums}</div>
            <div class="file-preview-code-content"><pre><code>${escapeHtml(content)}</code></pre></div>
        </div>`;
    const codeEl = host.querySelector('.file-preview-code-content') as HTMLElement | null;
    const numsEl = host.querySelector('.file-preview-line-numbers') as HTMLElement | null;
    if (codeEl && numsEl) {
        codeEl.addEventListener('scroll', () => { numsEl.scrollTop = codeEl.scrollTop; });
    }
}

/** Text-only outline of a PPTX, used when no visual sidecar exists. */
async function renderPptxOutline(host: HTMLElement, base64: string): Promise<void> {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(base64ToBytes(base64));
    const slideFiles = Object.keys(zip.files)
        .filter(name => /ppt\/slides\/slide\d+\.xml$/.test(name))
        .sort();

    let html = '<div class="pptx-slides">';
    for (const slideFile of slideFiles) {
        const xml = await zip.files[slideFile].async('text');
        const doc = new DOMParser().parseFromString(xml, 'text/xml');
        const num = slideFile.match(/slide(\d+)/)?.[1] || '?';
        html += `<div class="pptx-slide"><div class="pptx-slide-num">${escapeHtml(t('viewer.slide', num))}</div>`;
        const seen = new Set<string>();
        doc.querySelectorAll('a\\:t, t').forEach(el => {
            const text = el.textContent?.trim();
            if (text && !seen.has(text)) {
                seen.add(text);
                html += `<p>${escapeHtml(text)}</p>`;
            }
        });
        html += '</div>';
    }
    html += '</div>';
    host.innerHTML = `<div class="file-preview-office-pptx">${html}</div>`;
}

/**
 * Read `filePath` and render it into `host`.
 *
 * Returns the read result so callers can show size/mime, or null when the read
 * or the render failed (the failure is already displayed in `host`).
 */
export async function renderFileInto(host: HTMLElement, filePath: string): Promise<FileReadResult | null> {
    releaseViewerResources(host);

    const filename = fileNameOf(filePath);
    const ext = extensionOf(filePath);

    let result: FileReadResult;
    try {
        result = await invoke<FileReadResult>('file_read', { filePath });
    } catch (error) {
        notice(host, '⚠️', t('viewer.failed', String(error)));
        return null;
    }

    try {
        const isImage = IMAGE_EXTS.has(ext)
            || (result.is_binary && result.mime_type.startsWith('image/'));

        if (isImage) {
            host.innerHTML = '';
            const container = document.createElement('div');
            container.className = 'file-preview-image-container';
            const img = document.createElement('img');
            img.src = result.content;
            img.alt = filename;
            container.append(img);
            host.append(container);
        } else if (VIDEO_EXTS.has(ext)) {
            notice(host, '🎬', t('viewer.video_unsupported'));
        } else if ((ext === 'xlsx' || ext === 'xls') && result.content) {
            try {
                const XLSX = await import('xlsx');
                const workbook = XLSX.read(base64ToBytes(result.content), { type: 'array' });
                const sheet = workbook.Sheets[workbook.SheetNames[0]];
                host.innerHTML = `<div class="file-preview-office-xlsx">${XLSX.utils.sheet_to_html(sheet, { header: '' })}</div>`;
            } catch (error) {
                notice(host, '⚠️', t('viewer.excel_failed', String(error)));
            }
        } else if (ext === 'docx' && result.content) {
            try {
                const mammoth = await import('mammoth');
                const bytes = base64ToBytes(result.content);
                const converted = await mammoth.convertToHtml({ arrayBuffer: bytes.buffer as ArrayBuffer });
                host.innerHTML = `<div class="file-preview-office-docx markdown-body">${converted.value}</div>`;
            } catch (error) {
                notice(host, '⚠️', t('viewer.word_failed', String(error)));
            }
        } else if (ext === 'pptx' && result.content) {
            try {
                if (!await renderPresentationVisualPreview(filePath, host)) {
                    await renderPptxOutline(host, result.content);
                }
            } catch (error) {
                notice(host, '📊', t('viewer.ppt_failed', String(error)));
            }
        } else if (ext === 'pdf' && result.content) {
            try {
                renderPdf(host, result.content);
            } catch (error) {
                notice(host, '📕', t('viewer.pdf_failed', String(error)));
            }
        } else if (ext === 'md') {
            host.innerHTML = `<div class="file-preview-markdown markdown-body" style="padding:16px;">${await renderMarkdown(result.content)}</div>`;
        } else if (ext === 'html' || ext === 'htm') {
            appendIframe(host, 'file-preview-html', { srcdoc: result.content });
        } else if (TEXT_EXTS.has(ext) || !result.is_binary) {
            renderTextInto(host, result.content);
        } else {
            notice(host, getFileIcon(filename), t('viewer.unsupported'));
        }
    } catch (error) {
        notice(host, '⚠️', t('viewer.failed', String(error)));
        return null;
    }

    return result;
}
