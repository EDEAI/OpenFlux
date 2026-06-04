// Pure formatting / file helpers extracted from main.ts.
// These functions have no module-level state or DOM dependencies.

/** Format a timestamp into a short, locale-aware label (time today, otherwise date). */
export function formatTime(timestamp: number | string | undefined): string {
    if (!timestamp) return '';

    // Handle string or numeric timestamp formats
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) return '';

    const now = new Date();

    if (date.toDateString() === now.toDateString()) {
        return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

/** Escape HTML special characters via a detached element. */
export function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/** Convert a Blob to a base64 string (without the data-URL prefix). */
export function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = reader.result as string;
            // strip the "data:image/png;base64," prefix
            const base64 = result.split(',')[1] ?? '';
            resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

/** Get the lowercase extension (with leading dot) of a filename. */
export function getFileExt(filename: string): string {
    const idx = filename.lastIndexOf('.');
    return idx >= 0 ? filename.slice(idx).toLowerCase() : '';
}

/** Get the attachment icon CSS class from an extension. */
export function getAttachmentIconClass(ext: string): string {
    const e = ext.toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(e)) return 'icon-image';
    if (['.xlsx', '.xls', '.csv'].includes(e)) return 'icon-excel';
    if (['.docx'].includes(e)) return 'icon-word';
    if (['.pdf'].includes(e)) return 'icon-pdf';
    if (['.pptx'].includes(e)) return 'icon-ppt';
    if (['.zip', '.rar', '.7z', '.tar', '.gz'].includes(e)) return 'icon-archive';
    return 'icon-text';
}

/** Get the short attachment icon label text from an extension. */
export function getAttachmentIconLabel(ext: string): string {
    const e = ext.toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(e)) return 'IMG';
    if (['.xlsx', '.xls'].includes(e)) return 'XLS';
    if (['.csv'].includes(e)) return 'CSV';
    if (['.docx'].includes(e)) return 'DOC';
    if (['.pdf'].includes(e)) return 'PDF';
    if (['.pptx'].includes(e)) return 'PPT';
    if (['.json'].includes(e)) return 'JSON';
    if (['.md'].includes(e)) return 'MD';
    if (['.py'].includes(e)) return 'PY';
    if (['.js', '.ts'].includes(e)) return 'JS';
    if (['.zip'].includes(e)) return 'ZIP';
    if (['.rar'].includes(e)) return 'RAR';
    if (['.7z'].includes(e)) return '7Z';
    return 'TXT';
}

/** Format a byte size as B/KB/MB with one decimal. */
export function formatAttachmentSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Format an optional byte size; returns '' when undefined/null. */
export function formatFileSize(bytes?: number): string {
    if (bytes === undefined || bytes === null) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Format a byte size as B/KB/MB with one decimal. */
export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Pick an emoji icon from a file name. */
export function getFileIcon(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    const icons: Record<string, string> = {
        py: '🐍', js: '📜', ts: '📜', jsx: '📜', tsx: '📜',
        html: '🌐', css: '🎨', json: '📋', yaml: '📋', yml: '📋',
        md: '📝', txt: '📝',
        png: '🖼', jpg: '🖼', jpeg: '🖼', gif: '🖼', svg: '🖼', webp: '🖼',
        pdf: '📕', doc: '📘', docx: '📘', ppt: '📙', pptx: '📙', xls: '📗', xlsx: '📗',
        zip: '📦', rar: '📦', '7z': '📦', tar: '📦', gz: '📦',
        mp4: '🎬', mp3: '🎵', wav: '🎵',
    };
    return icons[ext] || '📄';
}

/** Map a file extension to a syntax-highlighting language id. */
export function getLanguageFromExt(ext: string): string {
    const map: Record<string, string> = {
        py: 'python', js: 'javascript', ts: 'typescript', jsx: 'javascript', tsx: 'typescript',
        html: 'html', css: 'css', scss: 'scss', less: 'less',
        json: 'json', yaml: 'yaml', yml: 'yaml', xml: 'xml',
        java: 'java', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp',
        go: 'go', rs: 'rust', rb: 'ruby', php: 'php', swift: 'swift', kt: 'kotlin',
        sh: 'bash', bash: 'bash', bat: 'batch', ps1: 'powershell',
        sql: 'sql', md: 'markdown', txt: 'plaintext',
    };
    return map[ext] || 'plaintext';
}

/** Normalize a file path: unify to backslashes (Windows native), for dedup comparison. */
export function normalizePath(p: string): string {
    return p.replace(/\//g, '\\');
}

/** Render the Agent icon HTML (emoji text, or an <img> when given a data URL). */
export function renderAgentIcon(icon: string, size: number = 24): string {
    if (icon.startsWith('data:image')) {
        return `<img src="${icon}" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;" />`;
    }
    return icon;
}
