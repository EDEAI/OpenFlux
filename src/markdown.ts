/**
 * Markdown 渲染模块
 * 整合 marked + highlight.js + mermaid
 */

import { marked } from 'marked';
import hljs from 'highlight.js';
import mermaid from 'mermaid';

// ========================
// 初始化
// ========================

let mermaidInitialized = false;

function initMermaid(): void {
    if (mermaidInitialized) return;
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
}

// 配置 marked
const renderer = new marked.Renderer();

// 自定义代码块渲染：mermaid 转占位，其他用 highlight.js
renderer.code = function ({ text, lang }: { text: string; lang?: string }) {
    // Mermaid 图表
    if (lang === 'mermaid') {
        const id = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        return `<div class="mermaid-container" data-mermaid-id="${id}"><pre class="mermaid-source">${text}</pre></div>`;
    }

    // 代码高亮
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

// 表格：使用后处理方式包裹（见 renderMarkdown 函数）

// 链接在新窗口打开
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
// 渲染函数
// ========================

/**
 * 将 Markdown 文本渲染为 HTML
 */
export function renderMarkdown(text: string): string {
    if (!text) return '';
    try {
        let html = marked.parse(text) as string;
        // 后处理：为表格添加响应式滚动容器
        html = html.replace(/<table>/g, '<div class="table-wrapper"><table>');
        html = html.replace(/<\/table>/g, '</table></div>');
        return html;
    } catch {
        // 降级：简单转义
        return text.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
    }
}

/**
 * 渲染后处理：激活 mermaid 图表
 * 需要在 DOM 插入后调用
 */
export async function activateMermaid(container: HTMLElement): Promise<void> {
    const mermaidContainers = container.querySelectorAll('.mermaid-container');
    if (mermaidContainers.length === 0) return;

    initMermaid();

    for (const el of Array.from(mermaidContainers)) {
        const sourceEl = el.querySelector('.mermaid-source');
        if (!sourceEl) continue;

        const source = sourceEl.textContent || '';
        const id = el.getAttribute('data-mermaid-id') || `mermaid-${Date.now()}`;

        try {
            const { svg } = await mermaid.render(id, source);
            el.innerHTML = `<div class="mermaid-rendered">${svg}</div>`;
        } catch {
            // 渲染失败，保留源码显示
            el.innerHTML = `<div class="mermaid-error">
                <span class="mermaid-error-label">图表渲染失败</span>
                <pre class="hljs"><code>${source.replace(/</g, '&lt;')}</code></pre>
            </div>`;
        }
    }
}

