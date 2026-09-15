/**
 * 插件页（左侧栏「插件」入口打开，占据中间工作区，与定时任务页同级）
 *
 * 一个列表、一种卡片：技能包（插件中心，bundled + openflux.io）、Office 加载项与 Chrome 录制扩展
 * （运行时连接器）都按同一套卡片渲染，用能力标签和顶部筛选区分，而不是分板块。
 * 连接器仍走原来的安装/注册路径，只是描述成同一列表里的条目。
 */
import type { GatewayClient, HubMcpStatus, HubPlugin } from '../gateway-client';
import { escapeHtml } from '../utils/format';
import { getLocale, t } from '../i18n/index';

export interface LocalPluginDef {
    id: string;
    logo: string;
    color: string;
    name: string;
    desc: string;
    enabled: boolean;
    disabled?: boolean;
    /** 连接器类型：Office 加载项 / 浏览器扩展；缺省按 id 推断 */
    kind?: 'office' | 'browser';
    /** 点击开关后调用；input.checked 已经是新状态，回调内失败需自行回滚 */
    onToggle: (el: HTMLInputElement) => void | Promise<void>;
    onConfigure?: () => void;
    showGear?: boolean;
    /** 可展开的详情面板（HTML）。返回空串表示无详情。 */
    details?: () => string;
    /** 详情面板里 `[data-detail-action]` 按钮的处理 */
    onDetailAction?: (action: string, el: HTMLElement) => void | Promise<void>;
}

type HubApi = Pick<GatewayClient, 'listHubPlugins' | 'installHubPlugin' | 'uninstallHubPlugin' | 'connectHubPluginMcp' | 'configureHubPluginMcp'>;

export interface PluginsPageOptions {
    api(): HubApi | null;
    localPlugins(): LocalPluginDef[];
    /** 把插件的示例提示词放进输入框 */
    tryPrompt(prompt: string): void;
    confirm(message: string): Promise<boolean>;
    notify(type: 'success' | 'error' | 'info', title: string, steps?: string[]): void;
}

export type PluginFilter = 'all' | 'installed' | 'skills' | 'connectors';

const icons: Record<string, string> = {
    refresh: '<path d="M20 7V2m0 5h-5M4 17v5m0-5h5M20 7a9 9 0 0 0-16 3m0 7a9 9 0 0 0 16-3"/>',
    chevron: '<path d="m7 10 5 5 5-5"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06.06A1.65 1.65 0 0 0 9 15a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 12 9a1.65 1.65 0 0 0 1.82.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 15z"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
};
function icon(name: string, size = 16): string {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || ''}</svg>`;
}

function compatLabel(p: HubPlugin): string {
    if (p.compat === 'full') return t('plugins.compat_full');
    if (p.compat === 'partial') return t('plugins.compat_partial');
    return t('plugins.compat_connector');
}

function mcpLabel(m: HubMcpStatus): string {
    switch (m.status) {
        case 'connected': return t('plugins.mcp_connected');
        case 'needs_auth': return t('plugins.mcp_needs_auth');
        case 'connecting': return t('plugins.mcp_connecting');
        case 'unsupported': return t('plugins.mcp_unsupported_short');
        case 'error': return t('plugins.mcp_error');
        default: return t('plugins.mcp_disconnected');
    }
}

/** Human explanation for common MCP failures (Figma's catalog gate, unreachable local server). */
function mcpErrorText(m: HubMcpStatus): string {
    const err = m.error || '';
    if (/403/.test(err) && /OAuth|register/i.test(err)) return `${t('plugins.mcp_registration_rejected')} (${err.slice(0, 80)})`;
    if (/ECONNREFUSED|fetch failed|timeout/i.test(err)) return `${t('plugins.mcp_unreachable')} (${err.slice(0, 80)})`;
    return err;
}

function tr(key: string, ...args: string[]): string {
    let s = t(key);
    args.forEach((a, i) => { s = s.replace(`{${i}}`, a); });
    return s;
}

/** Display copy in the current UI language: index.json `i18n[locale]` overlays the English plugin.json text. */
function localized(p: HubPlugin): Pick<HubPlugin, 'displayName' | 'description' | 'shortDescription' | 'longDescription' | 'defaultPrompt'> {
    const locale = String(getLocale()).toLowerCase();
    const key = Object.keys(p.i18n || {}).find(k => k.toLowerCase() === locale || locale.startsWith(k.toLowerCase() + '-'));
    const o = key ? p.i18n![key] : undefined;
    return {
        displayName: o?.displayName || p.displayName,
        description: o?.description || p.description,
        shortDescription: o?.shortDescription || p.shortDescription,
        longDescription: o?.longDescription || p.longDescription,
        defaultPrompt: o?.defaultPrompt?.length ? o.defaultPrompt : p.defaultPrompt,
    };
}

function connectorKind(p: LocalPluginDef): 'office' | 'browser' {
    return p.kind || (/chrome|browser|edge/i.test(p.id) ? 'browser' : 'office');
}

const FILTERS: PluginFilter[] = ['all', 'installed', 'skills', 'connectors'];

/** Owns the plugins page: one list mixing skill packs (hub) and runtime connectors (Office / Chrome). */
export class PluginsPage {
    private plugins: HubPlugin[] = [];
    private remoteOk = false;
    private loading = false;
    private loadedOnce = false;
    private loadError: string | null = null;
    private busy = new Set<string>();
    private open = new Set<string>();
    private refreshId = 0;
    private filter: PluginFilter = 'all';
    /** While the page is visible and some MCP server is not connected, poll so auto-reconnects show up. */
    private pollTimer: ReturnType<typeof setInterval> | null = null;

    constructor(private readonly root: HTMLElement, private readonly opts: PluginsPageOptions) {
        this.root.classList.add('plugins-page');
        this.root.addEventListener('click', e => this.onClick(e));
        try { const f = localStorage.getItem('openflux-plugins-filter') as PluginFilter | null; if (f && FILTERS.includes(f)) this.filter = f; } catch { /* ignore */ }
    }

    show(): void {
        this.render();
        void this.refresh();
        if (!this.pollTimer) {
            this.pollTimer = setInterval(() => {
                const pending = this.plugins.some(p => (p.mcp ?? []).some(m => m.status !== 'connected' && m.status !== 'unsupported'));
                if (pending && this.busy.size === 0) void this.refresh();
            }, 15000);
        }
    }

    hide(): void {
        // 隐藏后仍保留列表状态；下次 show() 会重绘并刷新
        this.refreshId++;
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.pollTimer = null;
    }

    /** 连接器开关状态变化后重绘列表（保留展开状态） */
    renderLocal(): void {
        this.renderList();
    }

    /**
     * 刷新目录。默认先拿"不等 openflux.io"的快照立即渲染（内置 + 已安装 + 缓存的远程条目），
     * 若远程目录还在拉取，再等一次完整结果静默合并。`force` 才会同步等远程并强制刷新。
     */
    async refresh(force = false): Promise<void> {
        const api = this.opts.api();
        const id = ++this.refreshId;
        if (!api) {
            this.loadError = t('plugins.gateway_offline');
            this.renderList();
            return;
        }
        this.loading = true;
        this.loadError = null;
        this.renderList();
        try {
            const first = await api.listHubPlugins(force, force ? true : false);
            if (id !== this.refreshId) return;
            this.apply(first);
            this.loadedOnce = true;
            if (first.remotePending) {
                this.renderList();
                const second = await api.listHubPlugins(false, true);
                if (id !== this.refreshId) return;
                this.apply(second);
            }
        } catch (e) {
            if (id !== this.refreshId) return;
            this.loadError = e instanceof Error ? e.message : String(e);
        } finally {
            if (id === this.refreshId) {
                this.loading = false;
                this.renderList();
            }
        }
    }

    private apply(result: Awaited<ReturnType<HubApi['listHubPlugins']>>): void {
        this.plugins = result.plugins || [];
        this.remoteOk = !!result.remoteOk;
        this.loadError = result.error || null;
    }

    // ---------- rendering ----------

    private render(): void {
        this.root.innerHTML = `
            <div class="plg-pane">
                <div class="plg-top">
                    <div class="plg-intro">
                        <h1>${escapeHtml(t('plugins.title'))}</h1>
                        <p>${escapeHtml(t('plugins.subtitle'))}</p>
                    </div>
                    <button type="button" class="plg-refresh" data-action="refresh" title="${escapeHtml(t('plugins.refresh'))}">${icon('refresh')}<span>${escapeHtml(t('plugins.refresh'))}</span></button>
                </div>
                <div class="plg-toolbar">
                    <div class="plg-filters" role="tablist">${FILTERS.map(f => `<button type="button" class="plg-filter" role="tab" data-filter="${f}">${escapeHtml(t(`plugins.filter_${f}`))}<span class="plg-filter-count" data-filter-count="${f}"></span></button>`).join('')}</div>
                    <div class="plg-source" data-source></div>
                </div>
                <div class="plg-list" data-list></div>
            </div>`;
        this.renderList();
    }

    private counts(): Record<PluginFilter, number> {
        const locals = this.opts.localPlugins();
        const installedHub = this.plugins.filter(p => p.installed).length;
        return {
            all: locals.length + this.plugins.length,
            installed: locals.filter(p => p.enabled).length + installedHub,
            skills: this.plugins.length,
            connectors: locals.length,
        };
    }

    private renderList(): void {
        const host = this.root.querySelector<HTMLElement>('[data-list]');
        if (!host) return;
        const counts = this.counts();
        this.root.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach(btn => {
            const f = btn.dataset.filter as PluginFilter;
            btn.classList.toggle('is-active', f === this.filter);
            btn.setAttribute('aria-selected', String(f === this.filter));
            const c = btn.querySelector('[data-filter-count]');
            if (c) c.textContent = String(counts[f]);
        });
        const source = this.root.querySelector<HTMLElement>('[data-source]');
        if (source) {
            const base = this.loadError && this.plugins.length === 0 ? this.loadError
                : this.remoteOk ? t('plugins.source_remote') : t('plugins.source_bundled');
            source.textContent = this.loading ? `${base} · ${t('plugins.loading')}` : base;
            source.classList.toggle('plg-error', !!this.loadError && this.plugins.length === 0);
        }

        const locals = this.filter === 'skills' ? [] : this.opts.localPlugins().filter(p => this.filter !== 'installed' || p.enabled);
        const hub = this.filter === 'connectors' ? [] : this.plugins.filter(p => this.filter !== 'installed' || p.installed);
        const cards = [...locals.map(p => this.renderLocalCard(p)), ...hub.map(p => this.renderHubCard(p))];
        if (this.filter !== 'connectors' && this.plugins.length === 0) {
            if (this.loading && !this.loadedOnce) cards.push(`<div class="plg-empty">${escapeHtml(t('plugins.loading_catalog'))}</div>`);
            else if (!this.loadError) cards.push(`<div class="plg-empty">${escapeHtml(t('plugins.empty'))}</div>`);
        }
        host.innerHTML = cards.length ? cards.join('') : `<div class="plg-empty">${escapeHtml(t('plugins.empty_filter'))}</div>`;
    }

    /** Expand/collapse a connector card's details from outside (e.g. after the user turned it on). */
    openLocalDetails(id: string, open = true): void {
        const key = `local:${id}`;
        if (open) this.open.add(key); else this.open.delete(key);
        this.renderList();
    }

    private renderLocalCard(p: LocalPluginDef): string {
        const kind = connectorKind(p);
        const detailsHtml = p.details ? p.details() : '';
        const open = !!detailsHtml && this.open.has(`local:${p.id}`);
        const badges = [
            `<span class="plg-badge plg-badge-kind">${escapeHtml(t(kind === 'browser' ? 'plugins.kind_browser' : 'plugins.kind_office'))}</span>`,
            p.enabled
                ? `<span class="plg-badge plg-badge-installed">${escapeHtml(t('plugins.installed'))}</span>`
                : `<span class="plg-badge">${escapeHtml(t('plugins.not_installed'))}</span>`,
        ];
        return `
            <article class="plg-card plg-local ${p.enabled ? 'is-installed' : ''} ${open ? 'is-open' : ''}" data-local-id="${escapeHtml(p.id)}" style="--plg-accent:${escapeHtml(p.color)}">
                <div class="plg-card-head" ${detailsHtml ? 'data-action="toggle-details"' : ''}>
                    <div class="plg-logo"><img src="${escapeHtml(p.logo)}" alt="" draggable="false"/></div>
                    <div class="plg-card-title">
                        <div class="plg-name">${escapeHtml(p.name)}<span class="plg-by">${escapeHtml(tr('plugins.by', t(kind === 'browser' ? 'plugins.vendor_browser' : 'plugins.vendor_office')))}</span></div>
                        <div class="plg-desc">${escapeHtml(p.desc)}</div>
                        <div class="plg-badges">${badges.join('')}</div>
                    </div>
                    <div class="plg-card-controls">
                        ${p.showGear ? `<button type="button" class="plg-icon-btn" data-action="configure" title="${escapeHtml(t('connections.configure'))}">${icon('gear')}</button>` : ''}
                        <label class="toggle-switch conn-mini-toggle" title="${p.enabled ? escapeHtml(t('connections.enabled')) : escapeHtml(t('connections.disabled'))}">
                            <input type="checkbox" data-local-toggle ${p.enabled ? 'checked' : ''} ${p.disabled ? 'disabled' : ''}>
                            <span class="toggle-slider"></span>
                        </label>
                        ${detailsHtml ? `<button type="button" class="plg-icon-btn plg-chevron" data-action="toggle-details" title="${escapeHtml(t('plugins.details'))}">${icon('chevron')}</button>` : ''}
                    </div>
                </div>
                ${open ? `<div class="plg-details">${detailsHtml}</div>` : ''}
            </article>`;
    }

    private renderHubCard(p: HubPlugin): string {
        const copy = localized(p);
        const busy = this.busy.has(p.id);
        const open = this.open.has(p.id);
        const logo = p.logoDataUrl
            ? `<img src="${p.logoDataUrl}" alt="" draggable="false"/>`
            : `<span class="plg-logo-fallback">${escapeHtml((p.displayName || p.id).slice(0, 1).toUpperCase())}</span>`;
        const badges: string[] = [];
        badges.push(`<span class="plg-badge plg-badge-kind">${escapeHtml(tr('plugins.kind_skills', String(p.skills.length)))}</span>`);
        for (const m of p.mcp ?? []) badges.push(`<span class="plg-badge plg-badge-mcp-${m.status}" title="${escapeHtml(m.error || '')}">MCP ${escapeHtml(m.name)} · ${escapeHtml(mcpLabel(m))}</span>`);
        if (!p.mcp?.length && p.compat !== 'full') badges.push(`<span class="plg-badge plg-badge-${p.compat}">${escapeHtml(compatLabel(p))}</span>`);
        badges.push(`<span class="plg-badge">v${escapeHtml(p.installed ? (p.installedVersion || p.version) : p.version)}</span>`);
        if (p.license) badges.push(`<span class="plg-badge">${escapeHtml(p.license)}</span>`);
        if (p.installed) badges.push(`<span class="plg-badge plg-badge-installed">${escapeHtml(t('plugins.installed'))}</span>`);
        if (p.updateAvailable) badges.push(`<span class="plg-badge plg-badge-update">${escapeHtml(tr('plugins.update_to', p.version))}</span>`);

        let action: string;
        if (busy) {
            action = `<button type="button" class="plg-btn" disabled>${escapeHtml(t('plugins.working'))}</button>`;
        } else if (p.installed && p.updateAvailable) {
            action = `<button type="button" class="plg-btn plg-btn-primary" data-action="install">${escapeHtml(t('plugins.update'))}</button>
                      <button type="button" class="plg-btn" data-action="uninstall">${escapeHtml(t('plugins.uninstall'))}</button>`;
        } else if (p.installed) {
            action = `<button type="button" class="plg-btn" data-action="uninstall">${escapeHtml(t('plugins.uninstall'))}</button>`;
        } else if (p.available && p.compat !== 'connector-only') {
            action = `<button type="button" class="plg-btn plg-btn-primary" data-action="install">${escapeHtml(t('plugins.install'))}</button>`;
        } else {
            action = `<button type="button" class="plg-btn" disabled title="${escapeHtml(t('plugins.unavailable'))}">${escapeHtml(t('plugins.unavailable'))}</button>`;
        }

        const details = open ? `
            <div class="plg-details">
                ${copy.longDescription ? `<p class="plg-long">${escapeHtml(copy.longDescription)}</p>` : ''}
                ${p.mcp?.length ? `
                <div class="plg-details-title">${escapeHtml(t('plugins.mcp_title'))}</div>
                <ul class="plg-skills">
                    ${p.mcp.map(m => `<li><b>${escapeHtml(m.name)} <span class="plg-badge plg-badge-mcp-${m.status}">${escapeHtml(mcpLabel(m))}</span>${m.overridden ? ` <span class="plg-badge">${escapeHtml(t('plugins.mcp_overridden'))}</span>` : ''}</b><span>${escapeHtml(m.status === 'connected' ? tr('plugins.mcp_tools', String(m.toolCount)) : m.status === 'needs_auth' ? t('plugins.mcp_auth_hint') : m.status === 'unsupported' ? t('plugins.mcp_unsupported') : mcpErrorText(m))}</span>
                        <div class="plg-mcp-config">
                            <input type="text" class="plg-mcp-url" data-mcp-url="${escapeHtml(m.name)}" value="${escapeHtml(m.url || '')}" placeholder="http://127.0.0.1:3845/mcp" spellcheck="false" />
                            <button type="button" class="plg-btn" data-action="mcp-configure" data-name="${escapeHtml(m.name)}" ${busy ? 'disabled' : ''}>${escapeHtml(t('plugins.mcp_apply_url'))}</button>
                            ${m.overridden ? `<button type="button" class="plg-btn" data-action="mcp-reset" data-name="${escapeHtml(m.name)}" ${busy ? 'disabled' : ''}>${escapeHtml(t('plugins.mcp_reset_url'))}</button>` : ''}
                        </div></li>`).join('')}
                </ul>
                ${p.mcp.some(m => m.status !== 'connected' && m.status !== 'connecting' && m.status !== 'unsupported') ? `<div class="plg-prompts"><button type="button" class="plg-btn plg-btn-primary" data-action="mcp-connect" ${busy ? 'disabled' : ''}>${escapeHtml(p.mcp.some(m => m.status === 'needs_auth') ? t('plugins.mcp_authorize') : t('plugins.mcp_retry'))}</button></div>` : ''}` : ''}
                <div class="plg-details-title">${escapeHtml(t('plugins.skills_title'))}</div>
                <ul class="plg-skills">
                    ${p.skills.map(s => `<li><b>${escapeHtml(s.name)}</b><span>${escapeHtml(s.description || '')}</span></li>`).join('')}
                </ul>
                ${copy.defaultPrompt.length ? `
                <div class="plg-details-title">${escapeHtml(t('plugins.try_title'))}</div>
                <div class="plg-prompts">
                    ${copy.defaultPrompt.map((q, i) => `<button type="button" class="plg-prompt" data-action="try" data-index="${i}" ${p.installed ? '' : 'disabled'} title="${p.installed ? '' : escapeHtml(t('plugins.try_needs_install'))}">${escapeHtml(q)}</button>`).join('')}
                </div>` : ''}
                <div class="plg-meta">
                    ${p.homepage ? `<a href="${escapeHtml(p.homepage)}" target="_blank" rel="noopener">${icon('external', 13)} ${escapeHtml(p.homepage.replace(/^https?:\/\//, ''))}</a>` : ''}
                    ${p.installRoot ? `<span title="${escapeHtml(p.installRoot)}">${escapeHtml(t('plugins.installed_at'))} ${escapeHtml(p.installRoot)}</span>` : ''}
                    <span>${escapeHtml(p.origin === 'remote' ? t('plugins.origin_remote') : t('plugins.origin_bundled'))}</span>
                </div>
            </div>` : '';

        return `
            <article class="plg-card plg-hub-card ${open ? 'is-open' : ''} ${p.installed ? 'is-installed' : ''}" data-plugin-id="${escapeHtml(p.id)}" style="--plg-accent:${escapeHtml(p.brandColor || '#6b7280')}">
                <div class="plg-card-head" data-action="toggle-details">
                    <div class="plg-logo">${logo}</div>
                    <div class="plg-card-title">
                        <div class="plg-name">${escapeHtml(copy.displayName)}${p.developerName ? `<span class="plg-by">${escapeHtml(tr('plugins.by', p.developerName))}</span>` : ''}</div>
                        <div class="plg-desc">${escapeHtml(copy.shortDescription || copy.description)}</div>
                        <div class="plg-badges">${badges.join('')}</div>
                    </div>
                    <div class="plg-card-controls">
                        ${action}
                        <button type="button" class="plg-icon-btn plg-chevron" data-action="toggle-details" title="${escapeHtml(t('plugins.details'))}">${icon('chevron')}</button>
                    </div>
                </div>
                ${details}
            </article>`;
    }

    // ---------- events ----------

    private onClick(e: Event): void {
        const target = e.target as HTMLElement;
        const localToggle = target.closest<HTMLInputElement>('[data-local-toggle]');
        if (localToggle) {
            e.stopPropagation();
            const card = localToggle.closest<HTMLElement>('[data-local-id]');
            const def = this.opts.localPlugins().find(p => p.id === card?.dataset.localId);
            if (def) void def.onToggle(localToggle);
            return;
        }
        const filterBtn = target.closest<HTMLElement>('[data-filter]');
        if (filterBtn) {
            const f = filterBtn.dataset.filter as PluginFilter;
            if (FILTERS.includes(f) && f !== this.filter) {
                this.filter = f;
                try { localStorage.setItem('openflux-plugins-filter', f); } catch { /* ignore */ }
                this.renderList();
            }
            return;
        }
        const detailAction = target.closest<HTMLElement>('[data-detail-action]');
        if (detailAction) {
            e.stopPropagation();
            const localCard = detailAction.closest<HTMLElement>('[data-local-id]');
            const def = this.opts.localPlugins().find(p => p.id === localCard?.dataset.localId);
            if (def?.onDetailAction) void def.onDetailAction(detailAction.dataset.detailAction || '', detailAction);
            return;
        }
        const actionEl = target.closest<HTMLElement>('[data-action]');
        if (!actionEl) return;
        const action = actionEl.dataset.action;
        const localCard = actionEl.closest<HTMLElement>('[data-local-id]');
        if (localCard && action === 'configure') {
            e.stopPropagation();
            this.opts.localPlugins().find(p => p.id === localCard.dataset.localId)?.onConfigure?.();
            return;
        }
        if (localCard && action === 'toggle-details') {
            if (target.closest('a, input, label, button:not(.plg-chevron)')) return;
            const key = `local:${localCard.dataset.localId}`;
            if (this.open.has(key)) this.open.delete(key); else this.open.add(key);
            this.renderList();
            return;
        }
        if (action === 'refresh') { void this.refresh(true); return; }
        const card = actionEl.closest<HTMLElement>('[data-plugin-id]');
        const plugin = card ? this.plugins.find(p => p.id === card.dataset.pluginId) : undefined;
        if (!plugin) return;
        if (action === 'toggle-details') {
            if (target.closest('a')) return;
            if (this.open.has(plugin.id)) this.open.delete(plugin.id); else this.open.add(plugin.id);
            this.renderList();
        } else if (action === 'install') {
            e.stopPropagation();
            void this.install(plugin);
        } else if (action === 'uninstall') {
            e.stopPropagation();
            void this.uninstall(plugin);
        } else if (action === 'mcp-connect') {
            e.stopPropagation();
            void this.connectMcp(plugin);
        } else if (action === 'mcp-configure' || action === 'mcp-reset') {
            e.stopPropagation();
            const name = actionEl.dataset.name || '';
            const input = card?.querySelector<HTMLInputElement>(`[data-mcp-url="${CSS.escape(name)}"]`);
            void this.configureMcp(plugin, name, action === 'mcp-reset' ? null : (input?.value || ''));
        } else if (action === 'try') {
            e.stopPropagation();
            const prompt = localized(plugin).defaultPrompt[Number(actionEl.dataset.index || 0)];
            if (prompt) this.opts.tryPrompt(prompt);
        }
    }

    private async install(plugin: HubPlugin): Promise<void> {
        const api = this.opts.api();
        if (!api || this.busy.has(plugin.id)) return;
        this.busy.add(plugin.id);
        this.renderList();
        try {
            const result = await api.installHubPlugin(plugin.id);
            if (!result.success) throw new Error(result.error || 'install failed');
            this.open.add(plugin.id);
            this.opts.notify('success', tr('plugins.install_ok', plugin.displayName), [t('plugins.install_ok_hint')]);
        } catch (e) {
            this.opts.notify('error', `${t('plugins.install_failed')}: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            this.busy.delete(plugin.id);
            await this.refresh();
        }
    }

    private async configureMcp(plugin: HubPlugin, name: string, url: string | null): Promise<void> {
        const api = this.opts.api();
        if (!api || this.busy.has(plugin.id) || !name) return;
        this.busy.add(plugin.id);
        this.renderList();
        try {
            const local = url !== null && /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/i.test(url);
            const result = url === null
                ? await api.configureHubPluginMcp(plugin.id, name, { reset: true })
                : await api.configureHubPluginMcp(plugin.id, name, { url, oauth: local ? 'off' : 'auto' });
            if (!result.success) throw new Error(result.error || t('plugins.mcp_connect_failed'));
            const tools = (result.mcp ?? []).reduce((n, m) => n + m.toolCount, 0);
            this.opts.notify('success', tr('plugins.mcp_connected_ok', plugin.displayName), [tr('plugins.mcp_tools', String(tools))]);
        } catch (e) {
            this.opts.notify('error', `${t('plugins.mcp_connect_failed')}: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            this.busy.delete(plugin.id);
            await this.refresh();
        }
    }

    private async connectMcp(plugin: HubPlugin): Promise<void> {
        const api = this.opts.api();
        if (!api || this.busy.has(plugin.id)) return;
        this.busy.add(plugin.id);
        this.renderList();
        const needsAuth = (plugin.mcp ?? []).some(m => m.status === 'needs_auth');
        if (needsAuth) this.opts.notify('info', t('plugins.mcp_authorize_started'), [t('plugins.mcp_authorize_steps')]);
        try {
            const result = await api.connectHubPluginMcp(plugin.id);
            if (!result.success) throw new Error(result.error || t('plugins.mcp_connect_failed'));
            const tools = (result.mcp ?? []).reduce((n, m) => n + m.toolCount, 0);
            this.opts.notify('success', tr('plugins.mcp_connected_ok', plugin.displayName), [tr('plugins.mcp_tools', String(tools))]);
        } catch (e) {
            this.opts.notify('error', `${t('plugins.mcp_connect_failed')}: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            this.busy.delete(plugin.id);
            await this.refresh();
        }
    }

    private async uninstall(plugin: HubPlugin): Promise<void> {
        const api = this.opts.api();
        if (!api || this.busy.has(plugin.id)) return;
        const ok = await this.opts.confirm(tr('plugins.uninstall_confirm', plugin.displayName));
        if (!ok) return;
        this.busy.add(plugin.id);
        this.renderList();
        try {
            const result = await api.uninstallHubPlugin(plugin.id);
            if (!result.success) throw new Error('uninstall failed');
            this.opts.notify('info', tr('plugins.uninstall_ok', plugin.displayName));
        } catch (e) {
            this.opts.notify('error', `${t('plugins.uninstall_failed')}: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            this.busy.delete(plugin.id);
            await this.refresh();
        }
    }
}
