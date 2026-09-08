/**
 * Markdown rendering module
 * Integrates marked + highlight.js + mermaid
 */

import { marked } from 'marked';
// The full highlight.js entry registers every language and adds ~1 MB to the
// startup graph. The common build keeps the languages users typically need.
import hljs from 'highlight.js/lib/common';

// ========================
// Initialization
// ========================

let mermaidInitialized = false;
let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;

async function initMermaid(): Promise<typeof import('mermaid').default> {
    const mermaid = await (mermaidPromise ??= import('mermaid').then(module => module.default));
    if (mermaidInitialized) return mermaid;
    mermaid.initialize({
        startOnLoad: false,
        theme: 'dark',
        themeVariables: {
            darkMode: true,
            background: '#1e293b',
            primaryColor: '#6366f1',
            primaryTextColor: '#f8fafc',
            primaryBorderColor: '#475569',
            lineColor: '#94a3b8',
            secondaryColor: '#334155',
            tertiaryColor: '#1e293b',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        },
        flowchart: { useMaxWidth: true, htmlLabels: true },
        sequence: { useMaxWidth: true },
    });
    mermaidInitialized = true;
    return mermaid;
}

// Configure marked
const renderer = new marked.Renderer();

// Custom code block rendering: mermaid becomes a placeholder, others use highlight.js
renderer.code = function ({ text, lang }: { text: string; lang?: string }) {
    // Mermaid diagram
    if (lang === 'mermaid') {
        const id = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        return `<div class="mermaid-container" data-mermaid-id="${id}"><pre class="mermaid-source">${text}</pre></div>`;
    }

    // Code highlighting
    const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
    const highlighted = hljs.highlight(text, { language }).value;
    const langLabel = lang || '';
    return `<div class="code-block-wrapper">
        <div class="code-block-header">
            <span class="code-lang">${langLabel}</span>
            <button class="code-copy-btn" onclick="navigator.clipboard.writeText(decodeURIComponent('${encodeURIComponent(text)}'))">复制</button>
        </div>
        <pre class="hljs"><code class="language-${language}">${highlighted}</code></pre>
    </div>`;
};

// Tables: wrapped via post-processing (see the renderMarkdown function)

// Open links in a new window
renderer.link = function ({ href, title, text }: { href: string; title?: string | null; text: string }) {
    const titleAttr = title ? ` title="${title}"` : '';
    return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
};

marked.setOptions({
    renderer,
    breaks: true,
    gfm: true,
});

// ========================
// Rendering functions
// ========================

/**
 * Render Markdown text to HTML
 */
export function renderMarkdown(text: string): string {
    if (!text) return '';
    try {
        let html = marked.parse(text) as string;
        // Post-processing: wrap tables in a responsive scroll container
        html = html.replace(/<table>/g, '<div class="table-wrapper"><table>');
        html = html.replace(/<\/table>/g, '</table></div>');
        return html;
    } catch {
        // Fallback: simple escaping
        return text.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
    }
}

/**
 * Render post-processing: activate mermaid diagrams.
 * Must be called after the DOM is inserted.
 */
export async function activateMermaid(container: HTMLElement): Promise<void> {
    const mermaidContainers = container.querySelectorAll('.mermaid-container');
    if (mermaidContainers.length === 0) return;

    const mermaid = await initMermaid();

    for (const el of Array.from(mermaidContainers)) {
        const sourceEl = el.querySelector('.mermaid-source');
        if (!sourceEl) continue;

        const source = sourceEl.textContent || '';
        const id = el.getAttribute('data-mermaid-id') || `mermaid-${Date.now()}`;

        try {
            const { svg } = await mermaid.render(id, source);
            el.innerHTML = `<div class="mermaid-rendered">${svg}</div>`;
        } catch {
            // Rendering failed; keep the source displayed
            el.innerHTML = `<div class="mermaid-error">
                <span class="mermaid-error-label">图表渲染失败</span>
                <pre class="hljs"><code>${source.replace(/</g, '&lt;')}</code></pre>
            </div>`;
        }
    }
}

