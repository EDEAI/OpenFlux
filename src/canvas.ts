/**
 * 设计画布 - 独立窗口入口
 *
 * 一个轻量无限画布（平移/缩放 + 图片/文字节点），通过 Gateway WebSocket 与
 * 「设计师」Agent 的 design_canvas 工具协作：
 * - 接收 canvas.command（insert_image / add_text / get_selection / list_images）
 * - 回包 canvas.command.result
 * 节点数据持久化到 localStorage，重开窗口可恢复。
 */
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { GatewayClient, type GatewayMessage } from './gateway-client';

interface Annotation {
    /** 归一化坐标（相对图片，0..1） */
    x: number;
    y: number;
    w: number;
    h: number;
    label?: string;
}

/** 箭头标注（Cowart 风格）：世界坐标的两端点 + 文字说明 */
interface ArrowAnno {
    id: string;
    x1: number; y1: number; // 起点（文字一端）
    x2: number; y2: number; // 终点（箭头指向）
    label?: string;
    color?: string; // 线/箭头/标签颜色（多箭头时随机区分）
    /** 标签 DOM（运行时） */
    labelEl?: HTMLElement;
}

/** 随机箭头颜色（固定饱和度/亮度，保证与深色文字对比） */
function randomArrowColor(): string {
    return `hsl(${Math.floor(Math.random() * 360)}, 72%, 56%)`;
}

interface CanvasNode {
    id: string;
    type: 'image' | 'text' | 'holder';
    x: number;
    y: number;
    w: number;
    h: number;
    z?: number;
    // image
    path?: string;
    url?: string;
    dataUrl?: string;
    caption?: string;
    /** 图片上的框选标注（用于让 Agent 针对局部修改） */
    annotations?: Annotation[];
    // text
    text?: string;
    color?: string;          // 文字颜色
    fontSize?: number;       // 字号(px)
    fontFamily?: string;     // 字体预设 id
    bold?: boolean;          // 加粗
    align?: 'left' | 'center' | 'right'; // 对齐
    // holder（AI 图片槽位）
    aspect?: string;
    el?: HTMLElement;
}

/** 文字字体预设 */
const FONT_OPTIONS: Array<{ id: string; label: string; css: string }> = [
    { id: 'sans', label: '黑体', css: '"Microsoft YaHei", "PingFang SC", system-ui, sans-serif' },
    { id: 'serif', label: '宋体', css: '"SimSun", "Songti SC", serif' },
    { id: 'kai', label: '楷体', css: '"KaiTi", "Kaiti SC", serif' },
    { id: 'round', label: '圆体', css: '"Yuanti SC", "Microsoft YaHei", sans-serif' },
    { id: 'mono', label: '等宽', css: 'Consolas, "Courier New", monospace' },
];
const FONT_SIZES = [12, 14, 16, 20, 24, 32, 40, 56];
function fontCss(id?: string): string { return (FONT_OPTIONS.find(f => f.id === id) || FONT_OPTIONS[0]).css; }

/** 把文字样式应用到文字 DOM */
function applyTextStyle(node: CanvasNode, el: HTMLElement): void {
    el.style.color = node.color || '#e6e6e6';
    el.style.fontSize = (node.fontSize || 14) + 'px';
    el.style.fontFamily = node.fontFamily ? fontCss(node.fontFamily) : '';
    el.style.fontWeight = node.bold ? '700' : '400';
    el.style.textAlign = node.align || 'left';
}

/** AI 图片槽位的比例预设（对齐 Cowart） */
const ASPECT_PRESETS: Array<{ id: string; label: string; w: number; h: number }> = [
    { id: '1-1', label: '1:1', w: 512, h: 512 },
    { id: '3-2', label: '3:2', w: 768, h: 512 },
    { id: '2-3', label: '2:3', w: 512, h: 768 },
    { id: '4-3', label: '4:3', w: 683, h: 512 },
    { id: '3-4', label: '3:4', w: 512, h: 683 },
    { id: '16-9', label: '16:9', w: 1024, h: 576 },
    { id: '9-16', label: '9:16', w: 512, h: 910 },
];

const STORAGE_KEY = 'openflux-canvas-v1';

const viewport = document.getElementById('cv-viewport') as HTMLDivElement;
const world = document.getElementById('cv-world') as HTMLDivElement;
const emptyHint = document.getElementById('cv-empty') as HTMLDivElement;
const zoomVal = document.getElementById('cv-zoom-val') as HTMLSpanElement;
const statusEl = document.getElementById('cv-status') as HTMLSpanElement;
const statusText = document.getElementById('cv-status-text') as HTMLSpanElement;

const nodes = new Map<string, CanvasNode>();
const arrows = new Map<string, ArrowAnno>();
let selectedId: string | null = null;
let camera = { x: 0, y: 0, scale: 1 };
let insertCount = 0;
let annotateMode = false;
let arrowMode = false;
let zCounter = 1;

// ========================
// 视图变换
// ========================
function applyCamera(): void {
    world.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`;
    zoomVal.textContent = `${Math.round(camera.scale * 100)}%`;
}

function screenToWorld(sx: number, sy: number): { x: number; y: number } {
    const rect = viewport.getBoundingClientRect();
    return {
        x: (sx - rect.left - camera.x) / camera.scale,
        y: (sy - rect.top - camera.y) / camera.scale,
    };
}

function viewCenterWorld(): { x: number; y: number } {
    const rect = viewport.getBoundingClientRect();
    return screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
}

function updateEmpty(): void {
    emptyHint.classList.toggle('hidden', nodes.size > 0);
}

// ========================
// 节点渲染
// ========================
function uid(): string {
    return 'n_' + Math.random().toString(36).slice(2, 10);
}

function selectNode(id: string | null): void {
    selectedId = id;
    for (const n of nodes.values()) {
        n.el?.classList.toggle('selected', n.id === id);
    }
    // 选中置顶
    if (id) {
        const n = nodes.get(id);
        if (n && n.el) {
            n.z = ++zCounter;
            n.el.style.zIndex = String(n.z);
        }
    }
    refreshAspectBar();
    refreshTextBar();
}

function renderNode(node: CanvasNode): void {
    const el = document.createElement('div');
    el.className = 'cv-node cv-node-' + node.type;
    el.dataset.id = node.id;
    positionNode(node, el);

    if (node.type === 'image') {
        // 图片节点底部始终显示信息栏（左：名称 / 右：分辨率），故恒为 has-caption
        el.classList.add('has-caption');
        let resEl: HTMLElement | null = null;
        const img = document.createElement('img');
        img.className = 'cv-node-img';
        img.draggable = false;
        img.src = node.dataUrl ? node.dataUrl
            : node.url ? node.url
            : (node.path ? convertFileSrc(node.path) : '');
        // 图片加载后按真实比例调整高度（仅在未被用户手动缩放时）+ 显示分辨率
        img.addEventListener('load', () => {
            if (img.naturalWidth > 0 && resEl) {
                resEl.textContent = `${img.naturalWidth}×${img.naturalHeight}`;
            }
            if (img.naturalWidth > 0 && !(node as any)._sized) {
                const ratio = img.naturalHeight / img.naturalWidth;
                const fit = (node as any)._fit as { x: number; y: number; w: number; h: number } | undefined;
                if (fit) {
                    // 在槽位框内等比缩放（contain），再把节点框收紧到图片实际尺寸并居中
                    let dispW = fit.w;
                    let dispH = fit.w * ratio;
                    if (dispH > fit.h) { dispH = fit.h; dispW = fit.h / ratio; }
                    node.w = Math.round(dispW);
                    node.h = Math.round(dispH) + 28;
                    node.x = fit.x + (fit.w - node.w) / 2;
                    node.y = fit.y + (fit.h - dispH) / 2;
                    delete (node as any)._fit;
                } else {
                    node.h = Math.round(node.w * ratio) + 28;
                }
                (node as any)._sized = true;
                positionNode(node, el);
                persist();
            }
        });
        el.appendChild(img);
        // 标注层
        const annoLayer = document.createElement('div');
        annoLayer.className = 'cv-anno-layer';
        el.appendChild(annoLayer);
        renderAnnotations(node, annoLayer);
        // 底部信息栏：左名称 / 右分辨率
        const cap = document.createElement('div');
        cap.className = 'cv-caption';
        const nameEl = document.createElement('span');
        nameEl.className = 'cv-caption-name';
        nameEl.textContent = node.caption || '图片';
        nameEl.title = node.caption || '';
        resEl = document.createElement('span');
        resEl.className = 'cv-caption-res';
        // 图片已缓存（complete）时立即显示分辨率，否则等 load 事件
        if (img.complete && img.naturalWidth > 0) resEl.textContent = `${img.naturalWidth}×${img.naturalHeight}`;
        cap.appendChild(nameEl);
        cap.appendChild(resEl);
        el.appendChild(cap);
        addResizeHandles(node, el);
    } else if (node.type === 'holder') {
        const body = document.createElement('div');
        body.className = 'cv-holder-body';
        body.innerHTML = `<div class="cv-holder-ico">🖼️</div>`
            + `<div class="cv-holder-title">AI 图片槽位</div>`
            + `<div class="cv-holder-size"><span class="hsz"></span></div>`;
        el.appendChild(body);
        updateHolderLabel(node, el);
        addResizeHandles(node, el);
    } else {
        const txt = document.createElement('div');
        txt.className = 'cv-node-text';
        txt.contentEditable = 'false'; // 默认不可编辑：可选中/拖动；双击才进入编辑
        txt.textContent = node.text || '';
        applyTextStyle(node, txt);
        txt.addEventListener('input', () => { node.text = txt.textContent || ''; });
        // 双击进入编辑态
        txt.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            txt.contentEditable = 'true';
            txt.classList.add('editing');
            txt.focus();
            const sel = window.getSelection();
            if (sel) { const r = document.createRange(); r.selectNodeContents(txt); r.collapse(false); sel.removeAllRanges(); sel.addRange(r); }
        });
        // 失焦退出编辑
        txt.addEventListener('blur', () => {
            txt.contentEditable = 'false';
            txt.classList.remove('editing');
            node.text = txt.textContent || '';
            persist();
        });
        // 编辑态下阻止 mousedown 冒泡（放置光标，不触发拖动）；非编辑态放行以便选中/拖动
        txt.addEventListener('mousedown', (e) => { if (txt.isContentEditable) e.stopPropagation(); });
        el.appendChild(txt);
        addResizeHandles(node, el);
    }

    attachNodeDrag(node, el);
    node.el = el;
    if (node.z) el.style.zIndex = String(node.z);
    world.appendChild(el);
}

// ========================
// 缩放手柄
// ========================
function addResizeHandles(node: CanvasNode, el: HTMLElement): void {
    const corners: Array<'nw' | 'ne' | 'sw' | 'se'> = ['nw', 'ne', 'sw', 'se'];
    for (const corner of corners) {
        const h = document.createElement('div');
        h.className = 'cv-handle cv-handle-' + corner;
        el.appendChild(h);
        h.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            e.preventDefault();
            selectNode(node.id);
            startResize(node, corner, e);
        });
    }
}

function startResize(node: CanvasNode, corner: 'nw' | 'ne' | 'sw' | 'se', e: MouseEvent): void {
    const startX = e.clientX;
    const startY = e.clientY;
    const ox = node.x, oy = node.y, ow = node.w, oh = node.h;
    const ratio = node.type === 'image' && ow > 0 ? oh / ow : 0; // 图片锁定比例
    const minW = 60;

    const onMove = (me: MouseEvent) => {
        const dx = (me.clientX - startX) / camera.scale;
        const dy = (me.clientY - startY) / camera.scale;
        let newW = ow;
        // 以水平方向位移为主驱动宽度（角点方向决定符号）
        if (corner === 'se' || corner === 'ne') newW = ow + dx;
        else newW = ow - dx;
        newW = Math.max(minW, newW);

        let newH: number;
        if (ratio > 0) {
            newH = newW * ratio;
        } else {
            // 文字节点：高度随竖直位移
            if (corner === 'se' || corner === 'sw') newH = Math.max(40, oh + dy);
            else newH = Math.max(40, oh - dy);
        }

        // 左/上角点：调整 x/y 以保持对角固定
        node.w = newW;
        node.h = newH;
        if (corner === 'nw' || corner === 'sw') node.x = ox + (ow - newW);
        if (corner === 'nw' || corner === 'ne') node.y = oy + (oh - newH);
        (node as any)._sized = true;
        positionNode(node);
        if (node.type === 'holder') { node.aspect = undefined; updateHolderLabel(node); refreshAspectBar(); }
    };
    const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        persist();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
}

// ========================
// 标注（框选图片局部）
// ========================
function renderAnnotations(node: CanvasNode, layer: HTMLElement, focusIdx = -1): void {
    layer.innerHTML = '';
    if (!node.annotations) return;
    node.annotations.forEach((a, idx) => {
        const box = document.createElement('div');
        box.className = 'cv-anno';
        box.style.left = (a.x * 100) + '%';
        box.style.top = (a.y * 100) + '%';
        box.style.width = (a.w * 100) + '%';
        box.style.height = (a.h * 100) + '%';

        // 可编辑文字描述
        const label = document.createElement('div');
        label.className = 'cv-anno-label';
        label.contentEditable = 'true';
        label.dataset.placeholder = '描述要改成什么…';
        label.textContent = a.label || '';
        const stop = (e: Event) => e.stopPropagation();
        label.addEventListener('mousedown', stop);
        label.addEventListener('click', stop);
        label.addEventListener('input', () => { a.label = label.textContent || ''; persist(); });
        label.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); label.blur(); }
        });
        box.appendChild(label);

        const del = document.createElement('div');
        del.className = 'cv-anno-del';
        del.textContent = '×';
        del.title = '删除标注';
        del.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            node.annotations?.splice(idx, 1);
            renderAnnotations(node, layer);
            persist();
        });
        box.appendChild(del);
        layer.appendChild(box);

        if (idx === focusIdx) {
            // 画完新框后自动聚焦输入
            setTimeout(() => {
                label.focus();
                const range = document.createRange();
                range.selectNodeContents(label);
                range.collapse(false);
                const sel = window.getSelection();
                sel?.removeAllRanges();
                sel?.addRange(range);
            }, 0);
        }
    });
}

/** 在图片节点上开始绘制标注矩形（annotateMode 时触发） */
function startAnnotation(node: CanvasNode, el: HTMLElement, e: MouseEvent): void {
    const img = el.querySelector('.cv-node-img') as HTMLElement;
    const layer = el.querySelector('.cv-anno-layer') as HTMLElement;
    if (!img || !layer) return;
    const rect = img.getBoundingClientRect();
    const startNX = (e.clientX - rect.left) / rect.width;
    const startNY = (e.clientY - rect.top) / rect.height;

    const preview = document.createElement('div');
    preview.className = 'cv-anno cv-anno-drawing';
    layer.appendChild(preview);

    const onMove = (me: MouseEvent) => {
        const nx = Math.min(1, Math.max(0, (me.clientX - rect.left) / rect.width));
        const ny = Math.min(1, Math.max(0, (me.clientY - rect.top) / rect.height));
        const x = Math.min(startNX, nx), y = Math.min(startNY, ny);
        const w = Math.abs(nx - startNX), h = Math.abs(ny - startNY);
        preview.style.left = (x * 100) + '%';
        preview.style.top = (y * 100) + '%';
        preview.style.width = (w * 100) + '%';
        preview.style.height = (h * 100) + '%';
    };
    const onUp = (me: MouseEvent) => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        const nx = Math.min(1, Math.max(0, (me.clientX - rect.left) / rect.width));
        const ny = Math.min(1, Math.max(0, (me.clientY - rect.top) / rect.height));
        const x = Math.min(startNX, nx), y = Math.min(startNY, ny);
        const w = Math.abs(nx - startNX), h = Math.abs(ny - startNY);
        preview.remove();
        if (w > 0.02 && h > 0.02) {
            if (!node.annotations) node.annotations = [];
            node.annotations.push({ x, y, w, h });
            renderAnnotations(node, layer, node.annotations.length - 1);
            persist();
        }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
}

function positionNode(node: CanvasNode, el?: HTMLElement): void {
    const e = el || node.el;
    if (!e) return;
    e.style.left = node.x + 'px';
    e.style.top = node.y + 'px';
    e.style.width = node.w + 'px';
    if (node.type === 'image' || node.type === 'holder') e.style.height = node.h + 'px';
}

// 节点拖拽
function attachNodeDrag(node: CanvasNode, el: HTMLElement): void {
    el.addEventListener('mousedown', (e) => {
        if ((e.target as HTMLElement).isContentEditable) return;
        if ((e.target as HTMLElement).classList.contains('cv-handle')) return; // 缩放手柄自行处理
        // 箭头模式：在节点上也可起笔画箭头（指向图片局部）
        if (arrowMode) { e.stopPropagation(); startArrowDraw(e); return; }
        const tEl = e.target as HTMLElement;
        // 点在已有标注框/标签/删除上：交给它们自己处理，不拖动也不新建标注
        if (tEl.closest('.cv-anno')) { e.stopPropagation(); selectNode(node.id); return; }
        e.stopPropagation();
        selectNode(node.id);
        // 标注模式：在图片上画框，而非拖动
        if (annotateMode && node.type === 'image') {
            startAnnotation(node, el, e);
            return;
        }
        const startX = e.clientX;
        const startY = e.clientY;
        const origX = node.x;
        const origY = node.y;
        let moved = false;

        const onMove = (me: MouseEvent) => {
            const dx = (me.clientX - startX) / camera.scale;
            const dy = (me.clientY - startY) / camera.scale;
            if (Math.abs(dx) > 1 || Math.abs(dy) > 1) moved = true;
            node.x = origX + dx;
            node.y = origY + dy;
            positionNode(node);
        };
        const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            if (moved) persist();
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    });
}

function addImageNode(opts: { path?: string; url?: string; dataUrl?: string; caption?: string; x?: number; y?: number; w?: number; h?: number; fit?: { x: number; y: number; w: number; h: number } }): CanvasNode {
    const defaultW = 300;
    // 填充槽位：先用槽位框作为占位，onload 后按图片真实比例在框内等比缩放并收紧节点框（避免上下/左右留白）
    if (opts.fit) {
        const f = opts.fit;
        const node: CanvasNode = {
            id: uid(), type: 'image', x: f.x, y: f.y, w: f.w, h: f.h,
            path: opts.path, url: opts.url, dataUrl: opts.dataUrl, caption: opts.caption,
        };
        (node as any)._fit = f;
        nodes.set(node.id, node);
        renderNode(node);
        selectNode(node.id);
        updateEmpty();
        persist();
        return node;
    }
    let x = opts.x;
    let y = opts.y;
    if (x == null || y == null) {
        const c = viewCenterWorld();
        const offset = (insertCount % 6) * 28;
        x = c.x - defaultW / 2 + offset;
        y = c.y - 120 + offset;
        insertCount++;
    }
    const w = opts.w ?? defaultW;
    const h = opts.h ?? (w * 0.75 + (opts.caption ? 28 : 0));
    const node: CanvasNode = {
        id: uid(),
        type: 'image',
        x, y, w, h,
        path: opts.path,
        url: opts.url,
        dataUrl: opts.dataUrl,
        caption: opts.caption,
    };
    // 指定了尺寸（如填充槽位）则锁定，避免 onload 重算比例
    if (opts.w != null && opts.h != null) (node as any)._sized = true;
    nodes.set(node.id, node);
    renderNode(node);
    selectNode(node.id);
    updateEmpty();
    persist();
    return node;
}

function addTextNode(opts: { text: string; x?: number; y?: number }): CanvasNode {
    let x = opts.x;
    let y = opts.y;
    if (x == null || y == null) {
        const c = viewCenterWorld();
        x = c.x - 90;
        y = c.y - 20;
    }
    const node: CanvasNode = {
        id: uid(), type: 'text', x, y, w: 220, h: 0, text: opts.text,
    };
    nodes.set(node.id, node);
    renderNode(node);
    selectNode(node.id);
    updateEmpty();
    persist();
    return node;
}

// ========================
// AI 图片槽位（holder）
// ========================
function aspectLabelFor(node: CanvasNode): string {
    if (node.aspect) {
        const p = ASPECT_PRESETS.find(p => p.id === node.aspect);
        if (p) return p.label;
    }
    const r = node.w / (node.h || 1);
    const hit = ASPECT_PRESETS.find(p => Math.abs(p.w / p.h - r) < 0.02);
    return hit ? hit.label : `${(r).toFixed(2)}`;
}

function updateHolderLabel(node: CanvasNode, el?: HTMLElement): void {
    const e = el || node.el;
    const span = e?.querySelector('.hsz') as HTMLElement | null;
    if (span) span.textContent = `${Math.round(node.w)}×${Math.round(node.h)} · ${aspectLabelFor(node)}`;
}

function addHolderNode(opts: { aspect?: string; w?: number; h?: number; x?: number; y?: number }): CanvasNode {
    const preset = opts.aspect ? ASPECT_PRESETS.find(p => p.id === opts.aspect) : null;
    const w = opts.w ?? preset?.w ?? 512;
    const h = opts.h ?? preset?.h ?? 683;
    let x = opts.x;
    let y = opts.y;
    if (x == null || y == null) {
        const c = viewCenterWorld();
        x = c.x - w / 2;
        y = c.y - h / 2;
    }
    const node: CanvasNode = {
        id: uid(), type: 'holder', x, y, w, h,
        aspect: preset?.id || opts.aspect,
    };
    nodes.set(node.id, node);
    renderNode(node);
    selectNode(node.id);
    updateEmpty();
    persist();
    return node;
}

function setHolderAspect(node: CanvasNode, presetId: string): void {
    const p = ASPECT_PRESETS.find(p => p.id === presetId);
    if (!p) return;
    // 以中心为锚保持位置稳定
    const cx = node.x + node.w / 2;
    const cy = node.y + node.h / 2;
    node.w = p.w;
    node.h = p.h;
    node.x = cx - p.w / 2;
    node.y = cy - p.h / 2;
    node.aspect = p.id;
    (node as any)._sized = true;
    positionNode(node);
    updateHolderLabel(node);
    persist();
}

// 比例预设浮动栏（选中 holder 时显示）
let aspectBar: HTMLElement | null = null;
function ensureAspectBar(): HTMLElement {
    if (aspectBar) return aspectBar;
    const bar = document.createElement('div');
    bar.className = 'cv-aspect-bar';
    bar.style.display = 'none';
    // 阻止 mousedown 冒泡到视口（否则会触发平移并取消选中槽位）
    bar.addEventListener('mousedown', (e) => e.stopPropagation());
    for (const p of ASPECT_PRESETS) {
        const btn = document.createElement('button');
        btn.textContent = p.label;
        btn.dataset.preset = p.id;
        btn.addEventListener('mousedown', (e) => e.stopPropagation());
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const n = selectedId ? nodes.get(selectedId) : null;
            if (n && n.type === 'holder') setHolderAspect(n, p.id);
            refreshAspectBar();
        });
        bar.appendChild(btn);
    }
    viewport.appendChild(bar);
    aspectBar = bar;
    return bar;
}

function refreshAspectBar(): void {
    const bar = ensureAspectBar();
    const n = selectedId ? nodes.get(selectedId) : null;
    if (n && n.type === 'holder') {
        bar.style.display = 'flex';
        bar.querySelectorAll('button').forEach(b => {
            (b as HTMLElement).classList.toggle('active', (b as HTMLElement).dataset.preset === n.aspect);
        });
    } else {
        bar.style.display = 'none';
    }
}

// ========================
// 文字样式浮动栏（选中文字便签时显示）
// ========================
let textBar: HTMLElement | null = null;
function curTextNode(): CanvasNode | null {
    const n = selectedId ? nodes.get(selectedId) : null;
    return n && n.type === 'text' ? n : null;
}
function textElOf(n: CanvasNode): HTMLElement {
    return (n.el?.querySelector('.cv-node-text') as HTMLElement) || n.el as HTMLElement;
}
function ensureTextBar(): HTMLElement {
    if (textBar) return textBar;
    const bar = document.createElement('div');
    bar.className = 'cv-text-bar';
    bar.style.display = 'none';
    bar.addEventListener('mousedown', (e) => e.stopPropagation());

    const apply = (fn: (n: CanvasNode) => void) => {
        const n = curTextNode();
        if (!n) return;
        fn(n);
        applyTextStyle(n, textElOf(n));
        persist();
    };

    // 颜色
    const color = document.createElement('input');
    color.type = 'color'; color.className = 'cv-tb-color'; color.title = '文字颜色';
    color.addEventListener('mousedown', (e) => e.stopPropagation());
    color.addEventListener('input', () => apply(n => { n.color = color.value; }));
    bar.appendChild(color);

    // 字体
    const font = document.createElement('select');
    font.className = 'cv-tb-select'; font.title = '字体';
    for (const f of FONT_OPTIONS) { const o = document.createElement('option'); o.value = f.id; o.textContent = f.label; font.appendChild(o); }
    font.addEventListener('mousedown', (e) => e.stopPropagation());
    font.addEventListener('change', () => apply(n => { n.fontFamily = font.value; }));
    bar.appendChild(font);

    // 字号
    const size = document.createElement('select');
    size.className = 'cv-tb-select'; size.title = '字号';
    for (const s of FONT_SIZES) { const o = document.createElement('option'); o.value = String(s); o.textContent = String(s); size.appendChild(o); }
    size.addEventListener('mousedown', (e) => e.stopPropagation());
    size.addEventListener('change', () => apply(n => { n.fontSize = Number(size.value); }));
    bar.appendChild(size);

    // 加粗
    const bold = document.createElement('button');
    bold.className = 'cv-tb-btn cv-tb-bold'; bold.textContent = 'B'; bold.title = '加粗';
    bold.addEventListener('mousedown', (e) => e.stopPropagation());
    bold.addEventListener('click', (e) => { e.stopPropagation(); apply(n => { n.bold = !n.bold; }); refreshTextBar(); });
    bar.appendChild(bold);

    // 对齐
    for (const al of ['left', 'center', 'right'] as const) {
        const b = document.createElement('button');
        b.className = 'cv-tb-btn cv-tb-align'; b.dataset.align = al;
        b.textContent = al === 'left' ? '⯇' : al === 'center' ? '≡' : '⯈';
        b.title = al === 'left' ? '左对齐' : al === 'center' ? '居中' : '右对齐';
        b.addEventListener('mousedown', (e) => e.stopPropagation());
        b.addEventListener('click', (e) => { e.stopPropagation(); apply(n => { n.align = al; }); refreshTextBar(); });
        bar.appendChild(b);
    }

    viewport.appendChild(bar);
    textBar = bar;
    return bar;
}
function refreshTextBar(): void {
    const bar = ensureTextBar();
    const n = curTextNode();
    if (!n) { bar.style.display = 'none'; return; }
    bar.style.display = 'flex';
    (bar.querySelector('.cv-tb-color') as HTMLInputElement).value = n.color || '#e6e6e6';
    const selects = bar.querySelectorAll('select');
    (selects[0] as HTMLSelectElement).value = n.fontFamily || 'sans';
    (selects[1] as HTMLSelectElement).value = String(n.fontSize || 14);
    (bar.querySelector('.cv-tb-bold') as HTMLElement).classList.toggle('active', !!n.bold);
    bar.querySelectorAll('.cv-tb-align').forEach(b => {
        (b as HTMLElement).classList.toggle('active', (b as HTMLElement).dataset.align === (n.align || 'left'));
    });
}

// ========================
// 放置避让（锚点旁不重叠）
// ========================
function rectsOverlap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
    return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
}

function placeBeside(anchor: CanvasNode, w: number, h: number, placement?: string): { x: number; y: number } {
    const gap = 40;
    const dir = placement || 'right';
    let x = anchor.x + anchor.w + gap;
    let y = anchor.y;
    if (dir === 'left') { x = anchor.x - w - gap; y = anchor.y; }
    else if (dir === 'below') { x = anchor.x; y = anchor.y + (anchor.h || 80) + gap; }
    else if (dir === 'above') { x = anchor.x; y = anchor.y - h - gap; }
    const others = [...nodes.values()].filter(n => n.id !== anchor.id);
    for (let i = 0; i < 50; i++) {
        const cand = { x, y, w, h };
        const hit = others.some(n => rectsOverlap(cand, { x: n.x, y: n.y, w: n.w, h: n.h || 80 }));
        if (!hit) break;
        if (dir === 'right' || dir === 'left') y += h + gap; else x += w + gap;
    }
    return { x, y };
}

// ========================
// 持久化
// ========================
function buildSnapshot(): { camera: typeof camera; nodes: any[]; arrows: any[] } {
    const data = [...nodes.values()].map(n => ({
        id: n.id, type: n.type, x: n.x, y: n.y, w: n.w, h: n.h, z: n.z,
        path: n.path, url: n.url, dataUrl: n.dataUrl, caption: n.caption, text: n.text,
        annotations: n.annotations, aspect: n.aspect,
        color: n.color, fontSize: n.fontSize, fontFamily: n.fontFamily, bold: n.bold, align: n.align,
    }));
    const arrowData = [...arrows.values()].map(a => ({
        id: a.id, x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, label: a.label, color: a.color,
    }));
    return { camera, nodes: data, arrows: arrowData };
}

/** 从快照数据重建箭头标注 */
function restoreArrows(list: any[] | undefined): void {
    for (const a of arrows.values()) a.labelEl?.remove();
    arrows.clear();
    for (const raw of list || []) {
        const a: ArrowAnno = { id: raw.id, x1: raw.x1, y1: raw.y1, x2: raw.x2, y2: raw.y2, label: raw.label, color: raw.color };
        arrows.set(a.id, a);
        createArrowLabel(a);
    }
    renderArrows();
}

function persist(): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(buildSnapshot()));
    } catch { /* ignore */ }
    schedulePersistRemote();
}

// 落盘到网关（工作区文件），跨重启 / 供 Agent 读取
let remoteTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersistRemote(): void {
    if (!client || !client.isConnected()) return;
    if (remoteTimer) clearTimeout(remoteTimer);
    remoteTimer = setTimeout(() => {
        try { client?.sendMessage({ type: 'canvas.persist', payload: { snapshot: buildSnapshot() } }); }
        catch { /* ignore */ }
    }, 800);
}

async function loadRemote(): Promise<void> {
    if (!client) return;
    try {
        const res = await client.request<{ exists?: boolean; snapshot?: { camera?: typeof camera; nodes?: any[]; arrows?: any[] } }>('canvas.load', {}, 8000);
        if (!res?.exists || !res.snapshot) return;
        // 网关有快照：以其为准，替换当前画布
        for (const n of nodes.values()) n.el?.remove();
        nodes.clear();
        if (res.snapshot.camera) camera = res.snapshot.camera;
        let maxZ = 1;
        for (const n of res.snapshot.nodes || []) {
            const node: CanvasNode = { ...n };
            if (node.type === 'image' || node.type === 'holder') (node as any)._sized = true;
            if (node.z && node.z > maxZ) maxZ = node.z;
            nodes.set(node.id, node);
            renderNode(node);
        }
        zCounter = maxZ;
        restoreArrows(res.snapshot.arrows);
        applyCamera();
        updateEmpty();
    } catch { /* 网关无快照或超时，沿用本地 localStorage */ }
}

function restore(): void {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const data = JSON.parse(raw);
        if (data.camera) camera = data.camera;
        let maxZ = 1;
        for (const n of data.nodes || []) {
            const node: CanvasNode = { ...n };
            if (node.type === 'image') (node as any)._sized = true; // 保留持久化的尺寸
            if (node.z && node.z > maxZ) maxZ = node.z;
            nodes.set(node.id, node);
            renderNode(node);
        }
        zCounter = maxZ;
        restoreArrows(data.arrows);
    } catch { /* ignore */ }
}

// ========================
// 箭头标注（Cowart 风格指向 + 文字）
// ========================
const SVG_NS = 'http://www.w3.org/2000/svg';
let arrowSvg: SVGSVGElement | null = null;

function ensureArrowSvg(): SVGSVGElement {
    if (arrowSvg) return arrowSvg;
    const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
    svg.classList.add('cv-arrow-svg');
    svg.style.display = 'none';
    const defs = document.createElementNS(SVG_NS, 'defs');
    const marker = document.createElementNS(SVG_NS, 'marker');
    marker.setAttribute('id', 'cv-arrowhead');
    marker.setAttribute('viewBox', '0 0 10 10');
    marker.setAttribute('refX', '8');
    marker.setAttribute('refY', '5');
    marker.setAttribute('markerWidth', '7');
    marker.setAttribute('markerHeight', '7');
    marker.setAttribute('orient', 'auto-start-reverse');
    marker.setAttribute('markerUnits', 'userSpaceOnUse');
    const tip = document.createElementNS(SVG_NS, 'path');
    tip.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
    // 跟随所属线条的描边色，使箭头与线同色
    tip.setAttribute('fill', 'context-stroke');
    marker.appendChild(tip);
    defs.appendChild(marker);
    svg.appendChild(defs);
    world.appendChild(svg);
    arrowSvg = svg;
    return svg;
}

function createArrowLabel(a: ArrowAnno, focus = false): void {
    const label = document.createElement('div');
    label.className = 'cv-arrow-label';
    if (a.color) label.style.background = a.color;

    // 可编辑文字区（独立于容器，保证光标/占位符在框内）
    const text = document.createElement('div');
    text.className = 'cv-arrow-text';
    text.contentEditable = 'true';
    text.dataset.placeholder = '说明要改成什么…';
    text.textContent = a.label || '';
    const stop = (e: Event) => e.stopPropagation();
    label.addEventListener('mousedown', stop);
    label.addEventListener('click', (e) => { stop(e); text.focus(); });
    text.addEventListener('input', () => { a.label = text.textContent || ''; persist(); });
    text.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); text.blur(); } });
    label.appendChild(text);

    const del = document.createElement('div');
    del.className = 'cv-arrow-del';
    del.textContent = '×';
    del.title = '删除箭头';
    del.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        arrows.delete(a.id);
        a.labelEl?.remove();
        renderArrows();
        persist();
    });
    label.appendChild(del);
    world.appendChild(label);
    a.labelEl = label;
    if (focus) setTimeout(() => text.focus(), 0);
}

function renderArrows(): void {
    const svg = ensureArrowSvg();
    [...svg.querySelectorAll('path.cv-arrow-line')].forEach(p => p.remove());
    if (arrows.size === 0) { svg.style.display = 'none'; return; }
    svg.style.display = 'block';

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const a of arrows.values()) {
        minX = Math.min(minX, a.x1, a.x2); minY = Math.min(minY, a.y1, a.y2);
        maxX = Math.max(maxX, a.x1, a.x2); maxY = Math.max(maxY, a.y1, a.y2);
    }
    const M = 40;
    const ox = minX - M, oy = minY - M;
    const w = (maxX - minX) + 2 * M, h = (maxY - minY) + 2 * M;
    svg.style.left = ox + 'px';
    svg.style.top = oy + 'px';
    svg.setAttribute('width', String(w));
    svg.setAttribute('height', String(h));
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);

    for (const a of arrows.values()) {
        const sx = a.x1 - ox, sy = a.y1 - oy, ex = a.x2 - ox, ey = a.y2 - oy;
        const dx = ex - sx, dy = ey - sy;
        const len = Math.hypot(dx, dy) || 1;
        const off = Math.min(40, len * 0.15);
        const mx = (sx + ex) / 2 - dy / len * off;
        const my = (sy + ey) / 2 + dx / len * off;
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('class', 'cv-arrow-line');
        if (a.color) path.style.stroke = a.color;
        path.setAttribute('marker-end', 'url(#cv-arrowhead)');
        path.setAttribute('d', `M ${sx} ${sy} Q ${mx} ${my} ${ex} ${ey}`);
        svg.appendChild(path);
        // 标签贴在起点端
        if (a.labelEl) {
            a.labelEl.style.left = a.x1 + 'px';
            a.labelEl.style.top = a.y1 + 'px';
        }
    }
}

function startArrowDraw(e: MouseEvent): void {
    const start = screenToWorld(e.clientX, e.clientY);
    const a: ArrowAnno = { id: uid(), x1: start.x, y1: start.y, x2: start.x, y2: start.y, color: randomArrowColor() };
    arrows.set(a.id, a);
    const onMove = (me: MouseEvent) => {
        const p = screenToWorld(me.clientX, me.clientY);
        a.x2 = p.x; a.y2 = p.y;
        renderArrows();
    };
    const onUp = (me: MouseEvent) => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        const dist = Math.hypot(me.clientX - e.clientX, me.clientY - e.clientY);
        if (dist < 8) { arrows.delete(a.id); renderArrows(); return; }
        createArrowLabel(a, true);
        renderArrows();
        persist();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
}

// ========================
// 平移 / 缩放
// ========================
viewport.addEventListener('mousedown', (e) => {
    // 箭头模式：在空白处起笔画箭头，而非平移
    if (arrowMode) { startArrowDraw(e); return; }
    if (e.target !== viewport && e.target !== world && !(e.target as HTMLElement).classList.contains('cv-empty')) {
        if ((e.target as HTMLElement).closest('.cv-zoom')) return;
        if ((e.target as HTMLElement).closest('.cv-node')) return;
        if ((e.target as HTMLElement).closest('.cv-aspect-bar')) return; // 比例预设栏自行处理
    }
    selectNode(null);
    viewport.classList.add('panning');
    const startX = e.clientX;
    const startY = e.clientY;
    const origX = camera.x;
    const origY = camera.y;
    const onMove = (me: MouseEvent) => {
        camera.x = origX + (me.clientX - startX);
        camera.y = origY + (me.clientY - startY);
        applyCamera();
    };
    const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        viewport.classList.remove('panning');
        persist();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
});

viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = -e.deltaY;
    const factor = delta > 0 ? 1.1 : 0.9;
    const newScale = Math.min(4, Math.max(0.15, camera.scale * factor));
    // 以光标为中心缩放
    const rect = viewport.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const wx = (cx - camera.x) / camera.scale;
    const wy = (cy - camera.y) / camera.scale;
    camera.scale = newScale;
    camera.x = cx - wx * newScale;
    camera.y = cy - wy * newScale;
    applyCamera();
    persist();
}, { passive: false });

// ========================
// 拖拽外部图片进画布
// ========================
function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || ''));
        fr.onerror = () => reject(fr.error);
        fr.readAsDataURL(file);
    });
}

viewport.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    viewport.classList.add('dropping');
});
viewport.addEventListener('dragleave', (e) => {
    if (e.target === viewport) viewport.classList.remove('dropping');
});
viewport.addEventListener('drop', async (e) => {
    e.preventDefault();
    viewport.classList.remove('dropping');
    const dt = e.dataTransfer;
    if (!dt) return;
    const pos = screenToWorld(e.clientX, e.clientY);
    // 1) 拖入的图片文件
    const files = [...(dt.files || [])].filter(f => f.type.startsWith('image/'));
    if (files.length) {
        let i = 0;
        for (const f of files) {
            try {
                const dataUrl = await readFileAsDataUrl(f);
                const node = addImageNode({ dataUrl, caption: f.name, x: pos.x + i * 24, y: pos.y + i * 24 });
                void persistDroppedAsset(node, f.name, dataUrl);
                i++;
            } catch { /* 跳过失败的文件 */ }
        }
        persist();
        return;
    }
    // 2) 从浏览器/聊天拖入的图片 URL 或 dataURL
    const uri = (dt.getData('text/uri-list') || dt.getData('text/plain') || '').trim().split('\n')[0];
    if (uri && /^(https?:|data:image\/)/.test(uri)) {
        if (/^data:/.test(uri)) {
            const node = addImageNode({ dataUrl: uri, x: pos.x, y: pos.y });
            void persistDroppedAsset(node, 'dropped.png', uri);
        } else {
            addImageNode({ url: uri, x: pos.x, y: pos.y });
        }
        persist();
    }
});

/** 把拖入的图片落盘到工作区，拿到本地 path（供设计师作为参考图：换头/合成等需要可读文件） */
async function persistDroppedAsset(node: CanvasNode, name: string, dataUrl: string): Promise<void> {
    if (!client || !client.isConnected()) return;
    try {
        const res = await client.request<{ path?: string }>('canvas.save_asset', { name, dataUrl }, 15000);
        if (res?.path) { node.path = res.path; persist(); }
    } catch { /* 落盘失败则仅保留 dataUrl 显示 */ }
}

// ========================
// 删除 / 清空 / 自定义确认
// ========================
function deleteNode(id: string): void {
    const n = nodes.get(id);
    if (!n) return;
    n.el?.remove();
    nodes.delete(id);
    if (selectedId === id) selectedId = null;
    refreshAspectBar();
    updateEmpty();
    persist();
}

function clearCanvas(): void {
    if (nodes.size === 0 && arrows.size === 0) return;
    void confirmDialog('确定清空画布？所有图片、槽位、标注与箭头都会被移除。').then((ok) => {
        if (!ok) return;
        for (const n of nodes.values()) n.el?.remove();
        nodes.clear();
        for (const a of arrows.values()) a.labelEl?.remove();
        arrows.clear();
        selectedId = null;
        renderArrows();
        refreshAspectBar();
        updateEmpty();
        persist();
    });
}

/** 轻量自定义确认弹窗（Tauri webview 下 window.confirm 不可靠） */
function confirmDialog(message: string): Promise<boolean> {
    return new Promise((resolve) => {
        const mask = document.createElement('div');
        mask.className = 'cv-modal-mask';
        mask.innerHTML = `
            <div class="cv-modal">
                <div class="cv-modal-msg"></div>
                <div class="cv-modal-actions">
                    <button class="cv-btn" data-act="cancel">取消</button>
                    <button class="cv-btn cv-btn-primary" data-act="ok">确定</button>
                </div>
            </div>`;
        (mask.querySelector('.cv-modal-msg') as HTMLElement).textContent = message;
        const done = (v: boolean) => { mask.remove(); resolve(v); };
        mask.addEventListener('mousedown', (e) => { if (e.target === mask) done(false); });
        mask.querySelector('[data-act="cancel"]')!.addEventListener('click', () => done(false));
        mask.querySelector('[data-act="ok"]')!.addEventListener('click', () => done(true));
        document.body.appendChild(mask);
    });
}

// ========================
// 右键菜单
// ========================
let ctxMenu: HTMLElement | null = null;
function hideContextMenu(): void { ctxMenu?.remove(); ctxMenu = null; }
function showContextMenu(clientX: number, clientY: number, items: Array<{ label: string; danger?: boolean; onClick: () => void }>): void {
    hideContextMenu();
    const menu = document.createElement('div');
    menu.className = 'cv-context-menu';
    for (const it of items) {
        const mi = document.createElement('div');
        mi.className = 'cv-context-item' + (it.danger ? ' danger' : '');
        mi.textContent = it.label;
        mi.addEventListener('click', () => { hideContextMenu(); it.onClick(); });
        menu.appendChild(mi);
    }
    document.body.appendChild(menu);
    menu.style.left = Math.min(clientX, window.innerWidth - menu.offsetWidth - 8) + 'px';
    menu.style.top = Math.min(clientY, window.innerHeight - menu.offsetHeight - 8) + 'px';
    ctxMenu = menu;
}
window.addEventListener('click', hideContextMenu);
window.addEventListener('blur', hideContextMenu);
viewport.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const nodeEl = (e.target as HTMLElement).closest('.cv-node') as HTMLElement | null;
    if (nodeEl?.dataset.id) {
        const id = nodeEl.dataset.id;
        selectNode(id);
        showContextMenu(e.clientX, e.clientY, [
            { label: '🗑 删除', danger: true, onClick: () => deleteNode(id) },
        ]);
    } else {
        showContextMenu(e.clientX, e.clientY, [
            { label: '适应视图', onClick: () => fitView() },
            { label: '🧹 清空画布', danger: true, onClick: () => clearCanvas() },
        ]);
    }
});

function fitView(): void {
    if (nodes.size === 0) {
        camera = { x: 0, y: 0, scale: 1 };
        applyCamera();
        return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes.values()) {
        minX = Math.min(minX, n.x);
        minY = Math.min(minY, n.y);
        maxX = Math.max(maxX, n.x + n.w);
        maxY = Math.max(maxY, n.y + (n.h || 80));
    }
    const pad = 80;
    const rect = viewport.getBoundingClientRect();
    const cw = maxX - minX + pad * 2;
    const ch = maxY - minY + pad * 2;
    const scale = Math.min(2, Math.max(0.15, Math.min(rect.width / cw, rect.height / ch)));
    camera.scale = scale;
    camera.x = -(minX - pad) * scale + (rect.width - cw * scale) / 2;
    camera.y = -(minY - pad) * scale + (rect.height - ch * scale) / 2;
    applyCamera();
    persist();
}

// ========================
// Gateway 集成
// ========================
let client: GatewayClient | null = null;

function setStatus(state: 'online' | 'offline' | 'connecting', text: string): void {
    statusEl.classList.remove('online', 'offline');
    if (state === 'online') statusEl.classList.add('online');
    if (state === 'offline') statusEl.classList.add('offline');
    statusText.textContent = text;
}

/** 指向某节点的箭头（尖端落在图片内或附近 ≤24px）→ 归一化指向点 */
function arrowsForNode(n: CanvasNode): Array<{ label?: string; target: { x: number; y: number } }> {
    if (n.type !== 'image' && n.type !== 'holder') return [];
    const m = 24;
    const out: Array<{ label?: string; target: { x: number; y: number } }> = [];
    for (const a of arrows.values()) {
        if (a.x2 < n.x - m || a.x2 > n.x + n.w + m || a.y2 < n.y - m || a.y2 > n.y + n.h + m) continue;
        const tx = Math.min(1, Math.max(0, (a.x2 - n.x) / n.w));
        const ty = Math.min(1, Math.max(0, (a.y2 - n.y) / n.h));
        out.push({ label: a.label, target: { x: +tx.toFixed(4), y: +ty.toFixed(4) } });
    }
    return out;
}

/** 命中某点的图片节点（含 margin 容差，重叠时取最上层 z） */
function findImageAt(x: number, y: number, margin = 0): CanvasNode | null {
    let best: CanvasNode | null = null;
    for (const n of nodes.values()) {
        if (n.type !== 'image') continue;
        if (x < n.x - margin || x > n.x + n.w + margin || y < n.y - margin || y > n.y + n.h + margin) continue;
        if (!best || (n.z || 0) > (best.z || 0)) best = n;
    }
    return best;
}

/**
 * 「图 ↔ 图」连接箭头：箭头尾(起点)落在一张图、箭头头(终点)落在另一张图。
 * from = 素材图(尾)，to = 底图/目标(头)，label = 操作说明。
 */
function imageLinks(): Array<{ from: any; to: any; label?: string }> {
    const m = 24;
    const out: Array<{ from: any; to: any; label?: string }> = [];
    for (const a of arrows.values()) {
        const src = findImageAt(a.x1, a.y1, m);
        const dst = findImageAt(a.x2, a.y2, m);
        if (!src || !dst || src.id === dst.id) continue;
        out.push({
            from: { id: src.id, path: src.path, url: src.url, caption: src.caption },
            to: { id: dst.id, path: dst.path, url: dst.url, caption: dst.caption },
            label: a.label,
        });
    }
    return out;
}

/** 叠在某图片/槽位上的文字便签内容（作为该图的额外文字指令参与生成） */
function notesForNode(n: CanvasNode): string[] {
    if (n.type !== 'image' && n.type !== 'holder') return [];
    const box = { x: n.x, y: n.y, w: n.w, h: n.h };
    const out: string[] = [];
    for (const t of nodes.values()) {
        if (t.type !== 'text' || !t.text?.trim()) continue;
        if (rectsOverlap(box, { x: t.x, y: t.y, w: t.w, h: t.h || 80 })) out.push(t.text.trim());
    }
    return out;
}

/** 没有显式选中时，挑选「带框选标注或箭头指向」最多的图片（优先最近置顶的） */
function pickAnnotatedImage(): CanvasNode | null {
    let best: CanvasNode | null = null;
    let bestScore = 0;
    for (const n of nodes.values()) {
        if (n.type !== 'image' && n.type !== 'holder') continue;
        const score = (n.annotations?.length || 0) + arrowsForNode(n).length;
        if (score <= 0) continue;
        // 分数相同则取 z 更大的（更近期/更靠前）
        if (score > bestScore || (score === bestScore && (n.z || 0) > (best?.z || 0))) {
            best = n; bestScore = score;
        }
    }
    return best;
}

/** 构造 get_selection 返回的选区数据 */
function buildSelectionPayload(n: CanvasNode): Record<string, unknown> {
    return {
        id: n.id, type: n.type,
        path: n.path, url: n.url, caption: n.caption, text: n.text,
        bbox: { x: Math.round(n.x), y: Math.round(n.y), w: Math.round(n.w), h: Math.round(n.h) },
        // holder：给出目标生成尺寸/比例，供 Agent 按此生成图片
        ...(n.type === 'holder' ? {
            targetWidth: Math.round(n.w), targetHeight: Math.round(n.h), aspect: aspectLabelFor(n),
        } : {}),
        // 归一化框选区域（0..1，相对图片），用于让 Agent 针对局部修改
        annotations: (n.annotations || []).map(a => ({
            x: +a.x.toFixed(4), y: +a.y.toFixed(4), w: +a.w.toFixed(4), h: +a.h.toFixed(4),
            label: a.label,
        })),
        // 指向该图片的箭头（target 为归一化指向点 0..1）
        arrows: arrowsForNode(n),
        // 叠在该图上的文字便签 → 作为额外文字指令参与生成
        notes: notesForNode(n),
    };
}

function handleCommand(message: GatewayMessage): void {
    const { command, params } = (message.payload as any) || {};
    const reply = (payload: any) => client?.sendMessage({ type: 'canvas.command.result', id: message.id, payload });

    try {
        switch (command) {
            case 'status':
                reply({ open: true, nodeCount: nodes.size });
                break;
            case 'insert_image': {
                let x = params?.x, y = params?.y;
                let w: number | undefined, h: number | undefined;
                let filledHolder: string | undefined;
                let fit: { x: number; y: number; w: number; h: number } | undefined;
                // 1) 填充 AI 图片槽位：显式 holderId，或当前选中的是 holder
                let holderId: string | undefined = params?.holderId;
                if (!holderId && selectedId) {
                    const s = nodes.get(selectedId);
                    if (s?.type === 'holder') holderId = s.id;
                }
                const holder = holderId ? nodes.get(holderId) : null;
                if (holder && holder.type === 'holder') {
                    // 用槽位框做等比贴合，避免比例不符时的留白
                    fit = { x: holder.x, y: holder.y, w: holder.w, h: holder.h };
                    filledHolder = holder.id;
                } else if ((x == null || y == null) && (params?.anchorId || params?.placement)) {
                    // 2) 锚点旁避让放置（before/after 对比）
                    const anchor = params?.anchorId
                        ? nodes.get(params.anchorId)
                        : (selectedId ? nodes.get(selectedId) : null);
                    if (anchor) {
                        const dw = 300, dh = dw * 0.75 + (params?.caption ? 28 : 0);
                        const pos = placeBeside(anchor, dw, dh, params?.placement);
                        x = pos.x; y = pos.y;
                    }
                }
                const node = addImageNode({
                    path: params?.path, url: params?.url, dataUrl: params?.dataUrl, caption: params?.caption,
                    x, y, w, h, fit,
                });
                if (filledHolder) {
                    const hn = nodes.get(filledHolder);
                    hn?.el?.remove();
                    nodes.delete(filledHolder);
                }
                fitViewSoon();
                persist();
                reply({ inserted: true, id: node.id, filledHolder });
                break;
            }
            case 'add_holder': {
                const node = addHolderNode({
                    aspect: params?.aspect, w: params?.w, h: params?.h, x: params?.x, y: params?.y,
                });
                fitViewSoon();
                reply({ inserted: true, id: node.id, w: Math.round(node.w), h: Math.round(node.h), aspect: aspectLabelFor(node) });
                break;
            }
            case 'add_text': {
                const node = addTextNode({ text: String(params?.text || ''), x: params?.x, y: params?.y });
                reply({ inserted: true, id: node.id });
                break;
            }
            case 'list_images': {
                const images = [...nodes.values()].filter(n => n.type === 'image').map(n => ({
                    id: n.id, caption: n.caption, path: n.path, url: n.url,
                    bbox: { x: Math.round(n.x), y: Math.round(n.y), w: Math.round(n.w), h: Math.round(n.h) },
                    annotationCount: n.annotations?.length || 0,
                    arrowCount: arrowsForNode(n).length,
                }));
                const holders = [...nodes.values()].filter(n => n.type === 'holder').map(n => ({
                    id: n.id, targetWidth: Math.round(n.w), targetHeight: Math.round(n.h), aspect: aspectLabelFor(n),
                    bbox: { x: Math.round(n.x), y: Math.round(n.y), w: Math.round(n.w), h: Math.round(n.h) },
                }));
                reply({ images, holders, links: imageLinks() });
                break;
            }
            case 'get_selection': {
                const links = imageLinks();
                let n = selectedId ? nodes.get(selectedId) : null;
                let autoSelected = false;
                // 没有显式选中时：优先用「图↔图连接箭头」的目标(底图)，否则挑带标注的图，再否则唯一槽位
                if (!n) {
                    if (links.length) n = nodes.get(links[0].to.id) || null;
                    if (!n) n = pickAnnotatedImage();
                    if (!n) {
                        const holders = [...nodes.values()].filter(x => x.type === 'holder');
                        if (holders.length === 1) n = holders[0];
                    }
                    autoSelected = !!n;
                    if (n) selectNode(n.id); // 视觉上也高亮，便于用户确认
                }
                if (!n && !links.length) { reply({ selection: null, links: [] }); break; }
                reply({ selection: n ? { ...buildSelectionPayload(n), autoSelected } : null, links });
                break;
            }
            default:
                reply({ error: `未知画布命令：${command}` });
        }
    } catch (err) {
        reply({ error: err instanceof Error ? err.message : String(err) });
    }
}

let fitTimer: ReturnType<typeof setTimeout> | null = null;
function fitViewSoon(): void {
    // 首次插入时自动聚焦，避免图片落在视野外
    if (nodes.size <= 1) {
        if (fitTimer) clearTimeout(fitTimer);
        fitTimer = setTimeout(fitView, 400);
    }
}

async function connectGateway(): Promise<void> {
    setStatus('connecting', '连接中…');
    try {
        const config = await invoke<{ url: string; token?: string }>('get_gateway_config');
        client = new GatewayClient(config.url, config.token);
        client.onConnectionChange((s) => {
            if (s === 'connected') {
                setStatus('online', '已连接');
                client?.sendMessage({ type: 'canvas.register' });
                void loadRemote();
            } else if (s === 'disconnected' || s === 'failed') {
                setStatus('offline', '已断开');
            } else {
                setStatus('connecting', '连接中…');
            }
        });
        client.addMessageHandler((msg) => {
            if (msg.type === 'canvas.command') handleCommand(msg);
        });
        await client.connect();
    } catch (err) {
        console.error('[canvas] gateway connect failed', err);
        setStatus('offline', '网关不可用');
    }
}

/** 「按标注生成」快捷操作：把当前选中/带标注的图片（或槽位）连同标注说明发给设计师 Agent */
function requestGenerate(): void {
    if (!client) { setStatus('offline', '未连接到网关，无法生成'); return; }
    // 选取目标：显式选中 > 带标注最多的图片 > 唯一槽位
    let target = selectedId ? nodes.get(selectedId) || null : null;
    if (!target) target = pickAnnotatedImage();
    if (!target) {
        const holders = [...nodes.values()].filter(n => n.type === 'holder');
        if (holders.length === 1) target = holders[0];
    }
    let text: string;
    if (target && target.type === 'image') {
        const annCount = (target.annotations?.length || 0) + arrowsForNode(target).length;
        text = annCount > 0
            ? '请读取画布上带标注的图片：以它作为参考图（image-to-image），严格按其框选区域和箭头的文字说明进行修改/重绘，把结果放回画布并与原图并排对比。务必基于原图修改，不要凭空新建。'
            : '请读取画布当前选中的图片，结合我的说明对它进行修改并放回画布（以原图作为参考图，不要凭空新建）。';
    } else if (target && target.type === 'holder') {
        text = '请读取画布上的 AI 图片槽位（含目标尺寸/比例），按该尺寸与比例生成图片并填充到槽位中。';
    } else {
        text = '请读取画布上带标注的图片，按其框选区域与箭头说明生成/修改图片，并放回画布。';
    }
    client.sendMessage({ type: 'canvas.prompt', payload: { text } });
    setStatus('online', '已发送给设计师，请在主窗口查看生成进度');
}

// ========================
// 初始化
// ========================
function main(): void {
    const win = getCurrentWindow();
    document.getElementById('cv-close')!.addEventListener('click', () => win.close());
    document.getElementById('cv-min')!.addEventListener('click', () => win.minimize());
    document.getElementById('cv-header')!.addEventListener('mousedown', (e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        win.startDragging();
    });

    document.getElementById('cv-generate')!.addEventListener('click', requestGenerate);
    document.getElementById('cv-add-text')!.addEventListener('click', () => {
        addTextNode({ text: '双击编辑文字' });
    });
    document.getElementById('cv-add-holder')!.addEventListener('click', () => {
        addHolderNode({ aspect: '3-4' });
    });
    // 标注模式开关（框选 / 箭头互斥）
    const annoBtn = document.getElementById('cv-annotate')!;
    const arrowBtn = document.getElementById('cv-arrow')!;
    const setAnnotateMode = (on: boolean) => {
        annotateMode = on;
        annoBtn.classList.toggle('active', on);
        viewport.classList.toggle('annotate', on);
        if (on) setArrowMode(false);
    };
    const setArrowMode = (on: boolean) => {
        arrowMode = on;
        arrowBtn.classList.toggle('active', on);
        viewport.classList.toggle('arrowdraw', on);
        if (on) setAnnotateMode(false);
    };
    annoBtn.addEventListener('click', () => setAnnotateMode(!annotateMode));
    arrowBtn.addEventListener('click', () => setArrowMode(!arrowMode));
    // 删除选中
    document.getElementById('cv-delete')!.addEventListener('click', () => {
        if (selectedId) deleteNode(selectedId);
    });
    document.getElementById('cv-clear')!.addEventListener('click', clearCanvas);
    document.getElementById('cv-fit')!.addEventListener('click', fitView);
    document.getElementById('cv-zoom-in')!.addEventListener('click', () => zoomBy(1.2));
    document.getElementById('cv-zoom-out')!.addEventListener('click', () => zoomBy(1 / 1.2));

    // 键盘：Delete 删除选中节点
    window.addEventListener('keydown', (e) => {
        if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
            const active = document.activeElement as HTMLElement;
            if (active?.isContentEditable) return;
            deleteNode(selectedId);
        }
    });

    restore();
    applyCamera();
    updateEmpty();
    connectGateway();
}

function zoomBy(factor: number): void {
    const rect = viewport.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const newScale = Math.min(4, Math.max(0.15, camera.scale * factor));
    const wx = (cx - camera.x) / camera.scale;
    const wy = (cy - camera.y) / camera.scale;
    camera.scale = newScale;
    camera.x = cx - wx * newScale;
    camera.y = cy - wy * newScale;
    applyCamera();
    persist();
}

main();
