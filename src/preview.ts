/**
 * 独立预览窗口入口
 * 通过 URL ?file=<path> 接收文件路径，使用 file_read 命令加载并渲染
 */
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { renderMarkdown } from './markdown';

const TEXT_EXTS = new Set([
    'txt', 'md', 'json', 'yaml', 'yml', 'xml', 'csv', 'log', 'ini', 'conf', 'cfg',
    'py', 'js', 'ts', 'jsx', 'tsx', 'html', 'css', 'scss', 'less', 'sass',
    'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'swift', 'kt',
    'sh', 'bash', 'bat', 'ps1', 'cmd',
    'sql', 'graphql', 'proto',
    'toml', 'env', 'gitignore', 'dockerfile', 'makefile',
]);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico']);

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getFileIcon(name: string): string {
    const ext = name.split('.').pop()?.toLowerCase() || '';
    const map: Record<string, string> = {
        pdf: '📕', doc: '📘', docx: '📘', xls: '📗', xlsx: '📗', ppt: '📙', pptx: '📙',
        png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️', webp: '🖼️',
        mp4: '🎬', avi: '🎬', mkv: '🎬', mov: '🎬',
        mp3: '🎵', wav: '🎵', ogg: '🎵',
        zip: '📦', rar: '📦', '7z': '📦', tar: '📦',
        py: '🐍', js: '📜', ts: '📜', html: '🌐', css: '🎨',
        json: '📋', yaml: '📋', yml: '📋', xml: '📋',
        md: '📝', txt: '📄',
    };
    return map[ext] || '📄';
}

async function main() {
    const appWindow = getCurrentWindow();
    const params = new URLSearchParams(window.location.search);
    const filePath = params.get('file');
    if (!filePath) {
        document.getElementById('p-body')!.innerHTML = '<div class="preview-loading">No file specified</div>';
        return;
    }

    const filename = filePath.split(/[/\\]/).pop() || 'unknown';
    const ext = filename.split('.').pop()?.toLowerCase() || '';

    document.getElementById('p-icon')!.textContent = getFileIcon(filename);
    document.getElementById('p-name')!.textContent = filename;

    // 窗口控制
    document.getElementById('p-close')!.addEventListener('click', () => appWindow.close());
    document.getElementById('p-minimize')!.addEventListener('click', () => appWindow.minimize());
    // 标题栏拖拽
    document.querySelector('.preview-header')!.addEventListener('mousedown', (e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        appWindow.startDragging();
    });

    // 功能按钮
    document.getElementById('p-open')!.addEventListener('click', () => invoke('file_open', { filePath }));
    document.getElementById('p-reveal')!.addEventListener('click', () => invoke('file_reveal', { filePath }));
    document.getElementById('p-copy')!.addEventListener('click', async () => {
        const pre = document.querySelector('pre');
        if (pre) {
            await navigator.clipboard.writeText(pre.textContent || '');
        }
    });

    const body = document.getElementById('p-body')!;

    try {
        const result: any = await invoke('file_read', { filePath });

        // 文件大小
        if (result.size) {
            const sizeStr = result.size > 1048576
                ? `${(result.size / 1048576).toFixed(1)} MB`
                : result.size > 1024
                    ? `${(result.size / 1024).toFixed(1)} KB`
                    : `${result.size} B`;
            document.getElementById('p-size')!.textContent = sizeStr;
        }

        // 图片
        if ((result.is_binary && result.mime_type && result.mime_type.startsWith('image/')) || IMAGE_EXTS.has(ext)) {
            body.innerHTML = `<div class="file-preview-image-container"><img src="${result.content}" alt="${escapeHtml(filename)}" /></div>`;
        }
        // 视频
        else if (['mp4', 'webm', 'avi', 'mov', 'mkv'].includes(ext)) {
            body.innerHTML = `<div class="file-preview-unsupported"><div class="file-preview-unsupported-icon">🎬</div><div class="file-preview-unsupported-text">Video preview not supported</div></div>`;
        }
        // Excel
        else if (['xlsx', 'xls'].includes(ext) && result.content) {
            try {
                const XLSX = await import('xlsx');
                const data = Uint8Array.from(atob(result.content), c => c.charCodeAt(0));
                const wb = XLSX.read(data, { type: 'array' });
                const ws = wb.Sheets[wb.SheetNames[0]];
                const html = XLSX.utils.sheet_to_html(ws, { header: '' });
                body.innerHTML = `<div class="file-preview-office-xlsx">${html}</div>`;
            } catch (e: any) {
                body.innerHTML = `<div class="file-preview-unsupported"><div class="file-preview-unsupported-icon">⚠️</div><div class="file-preview-unsupported-text">Excel preview failed: ${escapeHtml(String(e))}</div></div>`;
            }
        }
        // Word
        else if (ext === 'docx' && result.content) {
            try {
                const mammoth = await import('mammoth');
                const data = Uint8Array.from(atob(result.content), c => c.charCodeAt(0));
                const mammothResult = await mammoth.convertToHtml({ arrayBuffer: data.buffer });
                body.innerHTML = `<div class="file-preview-office-docx markdown-body">${mammothResult.value}</div>`;
            } catch (e: any) {
                body.innerHTML = `<div class="file-preview-unsupported"><div class="file-preview-unsupported-icon">⚠️</div><div class="file-preview-unsupported-text">Word preview failed: ${escapeHtml(String(e))}</div></div>`;
            }
        }
        // PPT
        else if (ext === 'pptx' && result.content) {
            try {
                const data = Uint8Array.from(atob(result.content), c => c.charCodeAt(0));
                const JSZip = (await import('jszip')).default;
                const zip = await JSZip.loadAsync(data);
                const slideFiles = Object.keys(zip.files).filter(f => f.match(/ppt\/slides\/slide\d+\.xml$/)).sort();
                let html = '<div class="pptx-slides">';
                for (const sf of slideFiles) {
                    const xmlStr = await zip.files[sf].async('text');
                    const doc = new DOMParser().parseFromString(xmlStr, 'text/xml');
                    const texts = doc.querySelectorAll('a\\:t, t');
                    const num = sf.match(/slide(\d+)/)?.[1] || '?';
                    html += `<div class="pptx-slide"><div class="pptx-slide-num">Slide ${num}</div>`;
                    const seen = new Set<string>();
                    texts.forEach(el => { const txt = el.textContent?.trim(); if (txt && !seen.has(txt)) { seen.add(txt); html += `<p>${escapeHtml(txt)}</p>`; } });
                    html += '</div>';
                }
                html += '</div>';
                body.innerHTML = `<div class="file-preview-office-pptx">${html}</div>`;
            } catch (e: any) {
                body.innerHTML = `<div class="file-preview-unsupported"><div class="file-preview-unsupported-icon">📊</div><div class="file-preview-unsupported-text">PPT preview failed: ${escapeHtml(String(e))}</div></div>`;
            }
        }
        // PDF
        else if (ext === 'pdf' && result.content) {
            try {
                const bytes = Uint8Array.from(atob(result.content), c => c.charCodeAt(0));
                const blob = new Blob([bytes], { type: 'application/pdf' });
                const blobUrl = URL.createObjectURL(blob);
                body.innerHTML = `<iframe class="file-preview-pdf" src="${blobUrl}" style="width:100%;height:100%;border:none;"></iframe>`;
            } catch (e: any) {
                body.innerHTML = `<div class="file-preview-unsupported"><div class="file-preview-unsupported-icon">📕</div><div class="file-preview-unsupported-text">PDF preview failed: ${escapeHtml(String(e))}</div></div>`;
            }
        }
        // Markdown
        else if (ext === 'md') {
            const html = await renderMarkdown(result.content);
            body.innerHTML = `<div class="file-preview-markdown markdown-body" style="padding:16px;">${html}</div>`;
        }
        // HTML — 渲染预览
        else if (ext === 'html' || ext === 'htm') {
            body.innerHTML = `<iframe class="file-preview-html" srcdoc="${escapeHtml(result.content)}" style="width:100%;height:100%;border:none;background:#fff;" sandbox="allow-scripts allow-same-origin"></iframe>`;
        }
        // 文本/代码
        else if (TEXT_EXTS.has(ext) || !result.is_binary) {
            const lines = (result.content as string).split('\n');
            const lineNums = lines.map((_: string, i: number) => `<span>${i + 1}</span>`).join('');
            body.innerHTML = `
                <div class="file-preview-code">
                    <div class="file-preview-line-numbers">${lineNums}</div>
                    <div class="file-preview-code-content"><pre><code>${escapeHtml(result.content)}</code></pre></div>
                </div>`;
            const codeEl = body.querySelector('.file-preview-code-content') as HTMLElement;
            const numsEl = body.querySelector('.file-preview-line-numbers') as HTMLElement;
            if (codeEl && numsEl) {
                codeEl.addEventListener('scroll', () => { numsEl.scrollTop = codeEl.scrollTop; });
            }
        }
        // 不支持
        else {
            body.innerHTML = `<div class="file-preview-unsupported"><div class="file-preview-unsupported-icon">${getFileIcon(filename)}</div><div class="file-preview-unsupported-text">Unsupported file type</div></div>`;
        }
    } catch (err: any) {
        body.innerHTML = `<div class="file-preview-unsupported"><div class="file-preview-unsupported-icon">⚠️</div><div class="file-preview-unsupported-text">Preview failed: ${escapeHtml(String(err))}</div></div>`;
    }
}

main();
