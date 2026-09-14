/**
 * 插件页（左侧栏「插件」入口打开，占据中间工作区，与定时任务页同级）
 *
 * 两个板块：
 *  - 本地插件：Excel / Word / PowerPoint / Chrome 录制扩展（原来挂在侧栏「外部连接」分组下的四个开关）
 *  - 技能插件：Codex 插件市场镜像（bundled + openflux.io），安装后技能目录注入 Agent
 */
import type { GatewayClient, HubMcpStatus, HubPlugin } from '../gateway-client';
import { escapeHtml } from '../utils/format';
import { t } from '../i18n/index';

export interface LocalPluginDef {
    id: string;
    logo: string;
    color: string;
    name: string;
    desc: string;
    enabled: boolean;
    disabled?: boolean;
    /** 点击开关后调用；input.checked 已经是新状态，回调内失败需自行回滚 */
    onToggle: (el: HTMLInputElement) => void | Promise<void>;
    onConfigure?: () => void;
    showGear?: boolean;
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

const icons: Record<string, string> = {
    refresh: '<path d="M20 7V2m0 5h-5M4 17v5m0-5h5M20 7a9 9 0 0 0-16 3m0 7a9 9 0 0 0 16-3"/>',
    chevron: '<path d="m7 10 5 5 5-5"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06.06A1.65 1.65 0 0 0 9 15a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 12 9a1.65 1.65 0 0 0 1.82.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 15z"/>',
    spark: '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.2 2.2M16.2 16.2l2.2 2.2M5.6 18.4l2.2-2.2M16.2 7.8l2.2-2.2"/>',
    puzzle: '<path d="M14 3a2 2 0 0 1 2 2v2h3a1 1 0 0 1 1 1v3h-2a2 2 0 1 0 0 4h2v3a1 1 0 0 1-1 1h-3v-2a2 2 0 1 0-4 0v2H9a1 1 0 0 1-1-1v-3H6a2 2 0 1 1 0-4h2V8a1 1 0 0 1 1-1h3V5a2 2 0 0 1 2-2z"/>',
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

/** Owns the plugins page: local plugin toggles + hub catalog with install state. */
export class PluginsPage {
    private plugins: HubPlugin[] = [];
    private remoteOk = false;
    private loading = false;
    private loadError: string | null = null;
    private busy = new Set<string>();
    private open = new Set<string>();
    private refreshId = 0;
    /** While the page is visible and some MCP server is not connected, poll so auto-reconnects show up. */
    private pollTimer: ReturnType<typeof setInterval> | null = null;

    constructor(private readonly root: HTMLElement, private readonly opts: PluginsPageOptions) {
        this.root.classList.add('plugins-page');
        this.root.addEventListener('click', e => this.onClick(e));
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

    /** 本地插件开关状态变化后只重绘本地板块 */
    renderLocal(): void {
        const host = this.root.querySelector<HTMLElement>('[data-local-grid]');
        if (host) host.innerHTML = this.renderLocalCards();
    }

    async refresh(force = false): Promise<void> {
        const api = this.opts.api();
        const id = ++this.refreshId;
        if (!api) {
            this.loadError = t('plugins.gateway_offline');
            this.renderHub();
            return;
        }
        this.loading = true;
        this.loadError = null;
        this.renderHub();
        try {
            const result = await api.listHubPlugins(force);
            if (id !== this.refreshId) return;
            this.plugins = result.plugins || [];
            this.remoteOk = !!result.remoteOk;
            this.loadError = result.error || null;
        } catch (e) {
            if (id !== this.refreshId) return;
            this.loadError = e instanceof Error ? e.message : String(e);
        } finally {
            if (id === this.refreshId) {
                this.loading = false;
                this.renderHub();
            }
        }
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
                <section class="plg-section">
                    <header class="plg-section-head">
                        <h2>${icon('puzzle', 18)}${escapeHtml(t('plugins.local_section'))}</h2>
                        <p>${escapeHtml(t('plugins.local_desc'))}</p>
                    </header>
                    <div class="plg-grid" data-local-grid>${this.renderLocalCards()}</div>
                </section>
                <section class="plg-section">
                    <header class="plg-section-head">
                        <h2>${icon('spark', 18)}${escapeHtml(t('plugins.hub_section'))}</h2>
                        <p>${escapeHtml(t('plugins.hub_desc'))}</p>
                    </header>
                    <div class="plg-hub" data-hub></div>
                </section>
            </div>`;
        this.renderHub();
    }

    private renderLocalCards(): string {
        return this.opts.localPlugins().map(p => `
            <article class="plg-card plg-local" data-local-id="${escapeHtml(p.id)}" style="--plg-accent:${escapeHtml(p.color)}">
                <div class="plg-card-head">
                    <div class="plg-logo"><img src="${escapeHtml(p.logo)}" alt="" draggable="false"/></div>
                    <div class="plg-card-title">
                        <div class="plg-name">${escapeHtml(p.name)}</div>
                        <div class="plg-desc">${escapeHtml(p.desc)}</div>
                    </div>
                    <div class="plg-card-controls">
                        ${p.showGear ? `<button type="button" class="plg-icon-btn" data-action="configure" title="${escapeHtml(t('connections.configure'))}">${icon('gear')}</button>` : ''}
                        <label class="toggle-switch conn-mini-toggle" title="${p.enabled ? escapeHtml(t('connections.enabled')) : escapeHtml(t('connections.disabled'))}">
                            <input type="checkbox" data-local-toggle ${p.enabled ? 'checked' : ''} ${p.disabled ? 'disabled' : ''}>
                            <span class="toggle-slider"></span>
                        </label>
                    </div>
                </div>
            </article>`).join('');
    }

    private renderHub(): void {
        const host = this.root.querySelector<HTMLElement>('[data-hub]');
        if (!host) return;
        if (this.loading && this.plugins.length === 0) {
            host.innerHTML = `<div class="plg-empty">${escapeHtml(t('plugins.loading'))}</div>`;
            return;
        }
        if (this.loadError && this.plugins.length === 0) {
            host.innerHTML = `<div class="plg-empty plg-error">${escapeHtml(this.loadError)}</div>`;
            return;
        }
        if (this.plugins.length === 0) {
            host.innerHTML = `<div class="plg-empty">${escapeHtml(t('plugins.empty'))}</div>`;
            return;
        }
        const source = this.remoteOk ? t('plugins.source_remote') : t('plugins.source_bundled');
        host.innerHTML = `
            <div class="plg-source">${escapeHtml(source)}${this.loading ? ` · ${escapeHtml(t('plugins.loading'))}` : ''}</div>
            <div class="plg-grid">${this.plugins.map(p => this.renderHubCard(p)).join('')}</div>`;
    }

    private renderHubCard(p: HubPlugin): string {
        const busy = this.busy.has(p.id);
        const open = this.open.has(p.id);
        const logo = p.logoDataUrl
            ? `<img src="${p.logoDataUrl}" alt="" draggable="false"/>`
            : `<span class="plg-logo-fallback">${escapeHtml((p.displayName || p.id).slice(0, 1).toUpperCase())}</span>`;
        const badges: string[] = [];
        badges.push(`<span class="plg-badge">v${escapeHtml(p.installed ? (p.installedVersion || p.version) : p.version)}</span>`);
        if (p.license) badges.push(`<span class="plg-badge">${escapeHtml(p.license)}</span>`);
        badges.push(`<span class="plg-badge">${escapeHtml(tr('plugins.skills_count', String(p.skills.length)))}</span>`);
        badges.push(`<span class="plg-badge plg-badge-${p.compat}">${escapeHtml(compatLabel(p))}</span>`);
        for (const m of p.mcp ?? []) badges.push(`<span class="plg-badge plg-badge-mcp-${m.status}" title="${escapeHtml(m.error || '')}">MCP ${escapeHtml(m.name)} · ${escapeHtml(mcpLabel(m))}</span>`);
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
                ${p.longDescription ? `<p class="plg-long">${escapeHtml(p.longDescription)}</p>` : ''}
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
                ${p.defaultPrompt.length ? `
                <div class="plg-details-title">${escapeHtml(t('plugins.try_title'))}</div>
                <div class="plg-prompts">
                    ${p.defaultPrompt.map((q, i) => `<button type="button" class="plg-prompt" data-action="try" data-index="${i}" ${p.installed ? '' : 'disabled'} title="${p.installed ? '' : escapeHtml(t('plugins.try_needs_install'))}">${escapeHtml(q)}</button>`).join('')}
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
                        <div class="plg-name">${escapeHtml(p.displayName)}${p.developerName ? `<span class="plg-by">${escapeHtml(tr('plugins.by', p.developerName))}</span>` : ''}</div>
                        <div class="plg-desc">${escapeHtml(p.shortDescription || p.description)}</div>
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
        const actionEl = target.closest<HTMLElement>('[data-action]');
        if (!actionEl) return;
        const action = actionEl.dataset.action;
        const localCard = actionEl.closest<HTMLElement>('[data-local-id]');
        if (localCard && action === 'configure') {
            e.stopPropagation();
            this.opts.localPlugins().find(p => p.id === localCard.dataset.localId)?.onConfigure?.();
            return;
        }
        if (action === 'refresh') { void this.refresh(true); return; }
        const card = actionEl.closest<HTMLElement>('[data-plugin-id]');
        const plugin = card ? this.plugins.find(p => p.id === card.dataset.pluginId) : undefined;
        if (!plugin) return;
        if (action === 'toggle-details') {
            if (target.closest('a')) return;
            if (this.open.has(plugin.id)) this.open.delete(plugin.id); else this.open.add(plugin.id);
            this.renderHub();
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
            const prompt = plugin.defaultPrompt[Number(actionEl.dataset.index || 0)];
            if (prompt) this.opts.tryPrompt(prompt);
        }
    }

    private async install(plugin: HubPlugin): Promise<void> {
        const api = this.opts.api();
        if (!api || this.busy.has(plugin.id)) return;
        this.busy.add(plugin.id);
        this.renderHub();
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
        this.renderHub();
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
        this.renderHub();
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
        this.renderHub();
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
