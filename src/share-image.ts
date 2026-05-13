/**
 * Share as Image v2
 * - 选择：在真实聊天界面显示 overlay，直接点击气泡勾选
 * - 图片：html2canvas 截取真实 DOM 元素，保留 markdown/代码块等格式
 */

import html2canvas from 'html2canvas';

// ========================
// 状态
// ========================
let _selectMode = false;
let _selectedEls: Set<HTMLElement> = new Set();
let _floatingBar: HTMLElement | null = null;

// ========================
// 初始化
// ========================

export function initShareImage(): void {
    injectStyles();
    document.getElementById('share-image-btn')?.addEventListener('click', enterSelectMode);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && _selectMode) exitSelectMode();
    });
}

// ========================
// 进入选择模式
// ========================

function enterSelectMode(): void {
    const container = document.getElementById('messages');
    if (!container) return;

    const msgEls = Array.from(
        container.querySelectorAll<HTMLElement>('.message.user, .message.assistant'),
    );
    if (msgEls.length === 0) { showToast('当前没有对话内容'); return; }

    _selectMode = true;
    _selectedEls = new Set();
    container.classList.add('share-select-mode');

    // 创建独立的勾选列，作为 #messages 的子元素（在其左 padding 区内，不被 overflow 裁切）
    const col = document.createElement('div');
    col.id = 'share-check-col';
    container.appendChild(col);

    msgEls.forEach((el) => {
        el.classList.add('share-selectable');

        const btn = document.createElement('div');
        btn.className = 'share-sel-overlay';
        btn.innerHTML = `<span class="share-sel-check"></span>`;
        // 根据消息的 offsetTop 定位（相对于 #messages 内容区）
        btn.style.top = `${el.offsetTop + 8}px`;
        col.appendChild(btn);

        const toggle = () => toggleMessage(el, btn);
        btn.addEventListener('click', toggle);
        (el as any)._shareBtn = btn;
    });

    showFloatingBar(msgEls);
}

/** 找到消息元素内的气泡 DOM */
function getBubble(el: HTMLElement): HTMLElement {
    return el.querySelector<HTMLElement>('.message-bubble') || el;
}

/** 选中高亮样式 —— outline 外扩 5px，与气泡内容不重叠 */
function applySelStyle(bubble: HTMLElement): void {
    bubble.style.outline = '2px solid #6366f1';
    bubble.style.outlineOffset = '5px';
}
function clearSelStyle(bubble: HTMLElement): void {
    bubble.style.outline = '';
    bubble.style.outlineOffset = '';
}

function toggleMessage(el: HTMLElement, btn: HTMLElement): void {
    const bubble = getBubble(el);
    if (_selectedEls.has(el)) {
        _selectedEls.delete(el);
        el.classList.remove('share-selected');
        btn.classList.remove('checked');
        clearSelStyle(bubble);
    } else {
        _selectedEls.add(el);
        el.classList.add('share-selected');
        btn.classList.add('checked');
        applySelStyle(bubble);
    }
    updateFloatingBar();
}

// ========================
// 退出选择模式
// ========================

function exitSelectMode(): void {
    _selectMode = false;
    const container = document.getElementById('messages');
    container?.classList.remove('share-select-mode');
    document.getElementById('share-check-col')?.remove();

    container?.querySelectorAll<HTMLElement>('.share-selectable').forEach((el) => {
        clearSelStyle(getBubble(el));
        el.classList.remove('share-selectable', 'share-selected');
        delete (el as any)._shareBtn;
    });

    _floatingBar?.remove();
    _floatingBar = null;
    _selectedEls.clear();
}

// ========================
// 浮动工具栏
// ========================

function showFloatingBar(msgEls: HTMLElement[]): void {
    _floatingBar?.remove();
    const bar = document.createElement('div');
    bar.id = 'share-floating-bar';
    bar.innerHTML = `
        <div class="sfb-left">
            <button class="sfb-btn sfb-all">全选</button>
            <button class="sfb-btn sfb-none">取消</button>
        </div>
        <div class="sfb-center">
            <span class="sfb-count">已选 0 条</span>
        </div>
        <div class="sfb-right">
            <button class="sfb-btn sfb-cancel">关闭</button>
            <button class="sfb-btn sfb-confirm primary">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
                    <polyline points="7 10 12 15 17 10"/>
                    <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
                保存图片
            </button>
        </div>`;
    document.body.appendChild(bar);
    _floatingBar = bar;

    bar.querySelector('.sfb-all')?.addEventListener('click', () => {
        msgEls.forEach(el => {
            _selectedEls.add(el);
            el.classList.add('share-selected');
        });
        updateFloatingBar();
    });
    bar.querySelector('.sfb-none')?.addEventListener('click', () => {
        msgEls.forEach(el => {
            _selectedEls.delete(el);
            el.classList.remove('share-selected');
        });
        updateFloatingBar();
    });
    bar.querySelector('.sfb-cancel')?.addEventListener('click', exitSelectMode);
    bar.querySelector('.sfb-confirm')?.addEventListener('click', handleSave);

    // 入场动画
    requestAnimationFrame(() => bar.classList.add('visible'));
}

function updateFloatingBar(): void {
    const count = _floatingBar?.querySelector('.sfb-count');
    if (count) count.textContent = `已选 ${_selectedEls.size} 条`;
    const btn = _floatingBar?.querySelector<HTMLButtonElement>('.sfb-confirm');
    if (btn) btn.disabled = _selectedEls.size === 0;
}

// ========================
// 保存处理
// ========================

async function handleSave(): Promise<void> {
    if (_selectedEls.size === 0) return;

    const confirmBtn = _floatingBar?.querySelector<HTMLButtonElement>('.sfb-confirm');
    if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = '生成中…'; }

    try {
        // 按 DOM 顺序排序选中的元素
        const container = document.getElementById('messages')!;
        const allMsgs = Array.from(container.querySelectorAll<HTMLElement>('.message.user, .message.assistant'));
        const ordered = allMsgs.filter(el => _selectedEls.has(el));

        const dataUrl = await captureMessages(ordered);
        await saveImage(dataUrl);
        exitSelectMode();
        showToast('图片已保存 ✓');
    } catch (err) {
        console.error('[ShareImage]', err);
        showToast('生成图片失败');
        if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> 保存图片`;
        }
    }
}

// ========================
// 截图核心
// ========================

async function captureMessages(elements: HTMLElement[]): Promise<string> {
    const isDark = document.documentElement.getAttribute('data-theme') !== 'light';

    // ① 截图前临时清除气泡高亮，截图后还原
    // 勾选列已是独立元素，截图时不包含它（wrapper 里的 clone 不含 share-check-col）
    elements.forEach(el => {
        clearSelStyle(getBubble(el));
        el.classList.remove('share-selected', 'share-selectable');
    });

    // 创建离屏截图容器
    const wrapper = document.createElement('div');
    wrapper.style.cssText = `
        position: fixed; left: -9999px; top: 0;
        width: 720px;
        background: ${isDark ? '#13131f' : '#f5f5f8'};
        padding: 0; margin: 0;
        font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
        z-index: -1;
    `;

    // 加载 OpenFlux 官方图标（转 base64，html2canvas 可渲染本地图片）
    let iconBase64 = '';
    try {
        const resp = await fetch('./icon.png');
        const blob = await resp.blob();
        iconBase64 = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.readAsDataURL(blob);
        });
    } catch { /* 加载失败时 fallback 到渐变背景 */ }

    // Header
    const header = document.createElement('div');
    header.style.cssText = `
        padding: 20px 28px 16px;
        border-bottom: 1px solid ${isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'};
        display: flex; align-items: center; justify-content: space-between;
    `;
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

    const iconHtml = iconBase64
        ? `<img src="${iconBase64}" style="width:28px;height:28px;border-radius:8px;object-fit:cover;display:block;" />`
        : `<div style="width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,#6366f1,#818cf8);display:flex;align-items:center;justify-content:center;">
               <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5">
                   <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
               </svg>
           </div>`;

    header.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;">
            ${iconHtml}
            <span style="font-size:14px;font-weight:600;color:${isDark ? '#e0e0e0' : '#1a1a2e'};">OpenFlux 对话记录</span>
        </div>
        <span style="font-size:11px;color:${isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)'};">${dateStr}</span>
    `;
    wrapper.appendChild(header);

    // 消息区域
    const msgArea = document.createElement('div');
    msgArea.style.cssText = `padding: 16px 20px; display: flex; flex-direction: column; gap: 12px;`;

    for (const el of elements) {
        // 深克隆气泡
        const clone = el.cloneNode(true) as HTMLElement;

        // 移除交互元素
        clone.querySelectorAll('.share-sel-overlay, .message-actions, .copy-btn, .tts-btn').forEach(n => n.remove());
        clone.classList.remove('share-selectable', 'share-selected');

        // 内联关键计算样式（确保截图正确）
        inlineKeyStyles(el, clone);

        // 固定宽度，去掉动态 padding
        clone.style.maxWidth = '100%';
        clone.style.width = 'auto';

        msgArea.appendChild(clone);
    }

    wrapper.appendChild(msgArea);

    // Footer 水印
    const footer = document.createElement('div');
    footer.style.cssText = `
        padding: 12px 28px;
        border-top: 1px solid ${isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'};
        display: flex; align-items: center; justify-content: center;
        gap: 6px;
    `;
    footer.innerHTML = `<span style="font-size:10px;color:${isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.25)'};">由 OpenFlux 生成 · openflux.app</span>`;
    wrapper.appendChild(footer);

    document.body.appendChild(wrapper);

    try {
        const canvas = await html2canvas(wrapper, {
            backgroundColor: isDark ? '#13131f' : '#f5f5f8',
            scale: 2,
            useCORS: true,
            allowTaint: true,
            logging: false,
            width: 720,
        });
        return canvas.toDataURL('image/png');
    } finally {
        wrapper.remove();
        // ② 截图完成，还原气泡高亮
        elements.forEach(el => {
            applySelStyle(getBubble(el));
            el.classList.add('share-selected', 'share-selectable');
            (el as any)._shareBtn?.classList.add('checked');
        });
    }
}

// 递归内联关键计算样式（仅处理视觉关键属性）
function inlineKeyStyles(src: HTMLElement, dst: HTMLElement): void {
    const PROPS = [
        'color', 'background', 'backgroundColor', 'backgroundImage',
        'borderRadius', 'border', 'borderColor', 'boxShadow',
        'padding', 'margin', 'fontSize', 'fontWeight', 'lineHeight',
        'display', 'flexDirection', 'alignItems', 'gap',
        'whiteSpace', 'wordBreak', 'overflowWrap',
    ];
    const srcStyle = window.getComputedStyle(src);
    PROPS.forEach(p => {
        const val = srcStyle.getPropertyValue(
            p.replace(/([A-Z])/g, c => `-${c.toLowerCase()}`)
        );
        if (val) (dst.style as any)[p] = val;
    });

    const srcChildren = src.children;
    const dstChildren = dst.children;
    for (let i = 0; i < srcChildren.length && i < dstChildren.length; i++) {
        inlineKeyStyles(srcChildren[i] as HTMLElement, dstChildren[i] as HTMLElement);
    }
}

// ========================
// 保存文件
// ========================

async function saveImage(dataUrl: string): Promise<void> {
    const now = new Date();
    const defaultName = `openflux-chat-${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.png`;

    try {
        const { save } = await import('@tauri-apps/plugin-dialog');
        const { writeFile } = await import('@tauri-apps/plugin-fs');

        const savePath = await save({
            defaultPath: defaultName,
            filters: [{ name: 'PNG 图片', extensions: ['png'] }],
        });
        if (!savePath) return;

        const base64 = dataUrl.split(',')[1];
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        await writeFile(savePath, bytes);
    } catch {
        // 非 Tauri 环境回退
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = defaultName;
        a.click();
    }
}

// ========================
// 工具函数
// ========================

function pad(n: number): string { return String(n).padStart(2, '0'); }

function showToast(msg: string): void {
    const t = document.createElement('div');
    t.className = 'share-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('visible'));
    setTimeout(() => { t.classList.remove('visible'); setTimeout(() => t.remove(), 300); }, 2500);
}

// ========================
// CSS 注入
// ========================

function injectStyles(): void {
    if (document.getElementById('share-image-styles')) return;
    const style = document.createElement('style');
    style.id = 'share-image-styles';
    style.textContent = `
/* 分享按钮 */
#share-image-btn {
    display: flex; align-items: center; gap: 5px;
    padding: 4px 10px; border: none; border-radius: 7px;
    background: transparent;
    color: var(--text-secondary, #a0a0b0);
    font-size: 12px; cursor: pointer;
    transition: background 0.15s, color 0.15s;
}
#share-image-btn:hover {
    background: rgba(99,102,241,0.12);
    color: var(--color-primary, #6366f1);
}

/* === 选择模式 === */
/* 消息容器进入选择模式时的遮罩提示 */
#messages.share-select-mode::before {
    content: '点击消息气泡选择 · 按 Esc 退出';
    position: sticky; top: 0; z-index: 100;
    display: block; text-align: center;
    padding: 6px;
    font-size: 11px; color: var(--color-primary, #6366f1);
    background: rgba(99,102,241,0.06);
    border-radius: 6px; margin-bottom: 8px;
    backdrop-filter: blur(4px);
}

/* 可选消息：hover 时高亮 */
.share-selectable {
    cursor: pointer;
    position: relative;
    border-radius: 12px;
    transition: outline 0.1s;
    outline: 2px solid transparent;
}
/* hover 不加描边（checkbox 已外移，无需 hover 提示） */
.share-selectable:hover {
    outline: none;
}

/* 已选中：高亮改由 JS 直接操作气泡 boxShadow，这里保留背景色辅助 */
.share-selected {
    /* box-shadow 和 background 由 toggleMessage() 直接写在 .message-bubble 上 */
}

/* 选择模式：消息容器本身不加 padding，checkbox 列悬浮在原有左侧空白里 */
#messages.share-select-mode {
    /* 仅增加轻微顶部提示条，不改变左右布局 */
}

/* ===== 勾选列（#share-check-col）===== */
/* 独立子元素，绝对定位在 #messages 左 padding 区内，不溢出，随内容滚动 */
#share-check-col {
    position: absolute;
    left: 4px;          /* 位于 #messages 左 padding 区内 */
    top: 0;
    width: 36px;
    pointer-events: none;
    z-index: 20;
}

/* 单个勾选按钮（绝对定位，top 由 JS 动态设置） */
.share-sel-overlay {
    position: absolute;
    left: 0;
    width: 32px; height: 32px;
    display: flex; align-items: center; justify-content: center;
    pointer-events: all;
    cursor: pointer;
    border-radius: 50%;
    transition: background 0.15s;
}
.share-sel-overlay:hover {
    background: rgba(99,102,241,0.12);
}
.share-sel-check {
    display: block; width: 20px; height: 20px;
    border-radius: 50%;
    border: 2px solid rgba(99,102,241,0.5);
    background: transparent;
    transition: background 0.15s, border-color 0.15s;
}
/* 勾选圆：.checked 由 JS 加在 .share-sel-overlay 上 */
.share-sel-overlay.checked .share-sel-check {
    background: #6366f1;
    border-color: #6366f1;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 12 12' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M2 6l3 3 5-5' stroke='white' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: center;
    background-size: 12px;
}

/* === 浮动工具栏 === */
#share-floating-bar {
    position: fixed; bottom: -80px; left: 50%;
    transform: translateX(-50%);
    z-index: 9999;
    display: flex; align-items: center; gap: 16px;
    padding: 10px 20px;
    background: var(--bg-secondary, #1e1e2e);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 16px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.4), 0 0 0 1px rgba(99,102,241,0.15);
    backdrop-filter: blur(12px);
    transition: bottom 0.3s cubic-bezier(0.34,1.56,0.64,1);
    white-space: nowrap;
}
#share-floating-bar.visible { bottom: 24px; }

.sfb-left, .sfb-right { display: flex; align-items: center; gap: 8px; }
.sfb-center { flex: 1; text-align: center; }
.sfb-count {
    font-size: 13px; font-weight: 500;
    color: var(--text-primary, #e0e0e0);
}

.sfb-btn {
    padding: 6px 14px; border: none; border-radius: 8px;
    font-size: 12px; cursor: pointer;
    background: rgba(255,255,255,0.07);
    color: var(--text-secondary, #aaa);
    transition: background 0.15s, color 0.15s;
}
.sfb-btn:hover { background: rgba(255,255,255,0.12); color: var(--text-primary, #e0e0e0); }
.sfb-btn.primary {
    display: flex; align-items: center; gap: 5px;
    background: linear-gradient(135deg, #6366f1, #818cf8);
    color: #fff; font-weight: 500;
    box-shadow: 0 3px 10px rgba(99,102,241,0.4);
}
.sfb-btn.primary:hover { opacity: 0.9; }
.sfb-btn.primary:disabled { opacity: 0.4; cursor: not-allowed; }

/* Toast */
.share-toast {
    position: fixed; bottom: 80px; left: 50%;
    transform: translateX(-50%) translateY(8px);
    background: rgba(20,20,35,0.92); color: #e0e0e0;
    padding: 8px 20px; border-radius: 20px; font-size: 13px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.3);
    z-index: 20000; opacity: 0;
    transition: opacity 0.2s, transform 0.2s;
    pointer-events: none; white-space: nowrap;
    border: 1px solid rgba(255,255,255,0.08);
}
.share-toast.visible { opacity: 1; transform: translateX(-50%) translateY(0); }
`;
    document.head.appendChild(style);
}
