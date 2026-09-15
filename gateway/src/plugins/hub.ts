/**
 * PluginHub — 技能插件中心（Codex / agent-plugins-spec 兼容的静态插件包）
 *
 * 一个插件 = 目录 + `.codex-plugin/plugin.json` + `skills/<name>/SKILL.md`（可能还带 .mcp.json）。
 * 这类插件不是运行时进程，和 Plugin Protocol v1（Office/Chrome 通过 WS 注册工具）是两回事。
 *
 * 来源有两个，都不依赖本机安装 codex 或访问 GitHub：
 *   - bundled：随安装包打进 Tauri resources 的镜像 `resources/plugin-hub/`（scripts/sync-codex-plugins.mjs 生成）
 *   - remote ：openflux.io 上的镜像 `index.json` + `<id>-<version>.tar.gz`（同一脚本 --dist 产出后上传）
 *
 * 安装 = 把插件目录复制/解压到 data/evolution/installed-plugins/<id>/，然后把技能"目录索引"注入
 * AgentManager（一个插件一条 skill：只列技能名、描述和 SKILL.md 绝对路径，正文由模型按需读取，
 * 与 Codex 的按需加载一致，避免十几个 SKILL.md 全文撑爆 system prompt）。
 */
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { Logger } from '../utils/logger';

const log = new Logger('PluginHub');

// ========================
// Types
// ========================

export interface HubPluginSkill {
    id: string;
    name: string;
    description: string;
    version?: string;
    /** 相对插件根目录，如 skills/gsap */
    path: string;
}

export interface HubPluginMcpServer {
    name: string;
    transport: string;
    command?: string;
    args?: string[];
    cwd?: string;
    url?: string;
    env?: Record<string, string>;
    bearerTokenEnvVar?: string;
    oauthResource?: string;
    headers?: Record<string, string>;
}

/** Live state of one MCP server a plugin declares (from the gateway's MCP manager). */
export interface HubMcpStatus {
    name: string;
    status: 'connecting' | 'connected' | 'needs_auth' | 'error' | 'disconnected' | 'unsupported';
    toolCount: number;
    error?: string;
    /** Effective endpoint (after overrides), for display */
    url?: string;
    transport?: string;
    /** True when the user overrode the declared settings */
    overridden?: boolean;
}

/** What the hub hands the gateway to connect a plugin's MCP servers. */
export interface HubMcpServerConfig {
    name: string;
    transport: 'stdio' | 'sse' | 'http';
    command?: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
    bearerTokenEnvVar?: string;
    oauthResource?: string;
    oauth?: 'auto' | 'off';
    enabled: boolean;
    timeout: number;
}

/** index.json 里的一条插件记录（由 sync-codex-plugins.mjs 生成） */
/** Per-locale overrides of the plugin's display copy (index.json `i18n`, from scripts/plugin-hub-i18n.json). */
export type HubPluginI18n = Record<string, Partial<Pick<HubPluginInfo, 'displayName' | 'description' | 'shortDescription' | 'longDescription' | 'defaultPrompt'>>>;

export interface HubPluginInfo {
    id: string;
    marketplace: string;
    name: string;
    version: string;
    displayName: string;
    description: string;
    shortDescription: string;
    longDescription: string;
    developerName: string;
    category: string;
    license: string;
    homepage: string;
    repository: string;
    keywords: string[];
    defaultPrompt: string[];
    i18n?: HubPluginI18n;
    brandColor: string;
    /** 相对插件根目录的 logo 路径 */
    logo: string;
    manifestPath: string;
    skills: HubPluginSkill[];
    mcpServers: HubPluginMcpServer[];
    hasApps: boolean;
    /** full = 纯技能包；partial = 技能 + MCP；connector-only = 只有 apps（OpenFlux 无法使用） */
    compat: 'full' | 'partial' | 'connector-only';
    mirrored: boolean;
    source?: { repo: string; commit: string; path: string };
    archive?: { file: string; sha256: string; bytes: number };
    files?: number;
    bytes?: number;
    syncedAt?: string;
}

export interface HubIndex {
    schemaVersion: number;
    marketplace: string;
    generatedAt: string;
    source?: { repo: string; ref: string; commit: string };
    plugins: HubPluginInfo[];
}

export type HubPluginOrigin = 'bundled' | 'remote';

export interface InstalledPluginMeta {
    id: string;
    version: string;
    displayName: string;
    installedAt: string;
    origin: HubPluginOrigin;
    skillIds: string[];
    /** 注入 AgentManager 的 skill id：plugin:<id> */
    runtimeSkillId: string;
    /** 快照：安装时的索引记录，供列表展示（镜像被移除后仍能显示） */
    info: HubPluginInfo;
    /** 用户对插件声明的 MCP 服务器的覆盖（如把 Figma 指到桌面版本地服务器） */
    mcpOverrides?: Record<string, HubMcpOverride>;
}

/** Per-server user override of a plugin's declared MCP settings. */
export interface HubMcpOverride {
    url?: string;
    transport?: 'http' | 'sse';
    oauth?: 'auto' | 'off';
}

/** 前端列表用的视图：可用插件 ∪ 已安装插件 */
export interface HubPluginView extends HubPluginInfo {
    origin: HubPluginOrigin;
    /** 当前有可安装的来源（bundled 目录存在 / remote 归档存在） */
    available: boolean;
    installed: boolean;
    installedVersion?: string;
    installedAt?: string;
    updateAvailable: boolean;
    /** 已安装插件的本地根目录 */
    installRoot?: string;
    /** 可直接给前端 <img> 用的 logo data URL（小图内联，避免文件协议限制） */
    logoDataUrl?: string;
    /** 已安装插件声明的 MCP 服务器的连接状态 */
    mcp?: HubMcpStatus[];
}

export interface PluginHubOptions {
    /** 已安装插件根目录，如 data/evolution/installed-plugins */
    installRoot: string;
    /** 覆盖默认的 bundled 镜像候选目录 */
    mirrorDirs?: string[];
    /** 远程镜像 index.json，null 关闭远程 */
    remoteIndexUrl?: string | null;
    /** 远程请求超时（毫秒） */
    remoteTimeoutMs?: number;
    onSkillInstalled?: (skill: { id: string; title: string; content: string }) => void;
    onSkillRemoved?: (skillId: string) => void;
    /** MCP bridge: connect/disconnect the servers a plugin declares and report their state. */
    mcp?: {
        connect(pluginId: string, servers: HubMcpServerConfig[], interactive: boolean): Promise<void>;
        disconnect(pluginId: string): Promise<void>;
        status(pluginId: string, servers: HubMcpServerConfig[]): HubMcpStatus[];
    };
}

const MANIFEST_CANDIDATES = ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json', '.cursor-plugin/plugin.json', 'plugin.json'];
const REMOTE_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_LOGO_BYTES = 256 * 1024;
const DESC_MAX = 320;

export const DEFAULT_REMOTE_INDEX_URL = 'https://openflux.io/plugins/index.json';

// ========================
// Helpers
// ========================

export function pluginRuntimeSkillId(pluginId: string): string {
    return `plugin:${pluginId}`;
}

function isSafePluginId(id: string): boolean {
    return /^[a-z0-9][a-z0-9._-]{0,80}$/i.test(id) && !id.includes('..');
}

function trimText(text: string, max: number): string {
    const t = (text || '').replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

function findManifest(root: string): string | null {
    for (const rel of MANIFEST_CANDIDATES) {
        if (existsSync(join(root, rel))) return rel;
    }
    return null;
}

/** Windows 上 PATH 里常常先找到 Git 的 GNU tar（会把 `C:` 当远程主机），优先用系统自带的 bsdtar */
function tarCommand(): string {
    if (process.platform === 'win32') {
        const sys = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
        if (existsSync(sys)) return sys;
    }
    return 'tar';
}

function defaultMirrorDirs(): string[] {
    const dirs: string[] = [];
    if (process.env.OPENFLUX_PLUGIN_HUB_DIR) dirs.push(process.env.OPENFLUX_PLUGIN_HUB_DIR);
    // Tauri sidecar：process.rs 传入 OPENFLUX_RESOURCE_DIR。
    // dev 指向 src-tauri/resources（镜像直接在其下），打包后指向 Tauri resource dir（镜像在 resources/plugin-hub）。
    const resDir = process.env.OPENFLUX_RESOURCE_DIR;
    if (resDir) {
        dirs.push(join(resDir, 'plugin-hub'), join(resDir, 'resources', 'plugin-hub'));
    }
    // 直接 node 启动 gateway 的开发场景：从本文件位置回溯到项目根
    try {
        const here = typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
        dirs.push(resolve(here, '..', '..', '..', 'src-tauri', 'resources', 'plugin-hub'));
    } catch { /* ignore */ }
    dirs.push(join(process.cwd(), 'src-tauri', 'resources', 'plugin-hub'));
    return [...new Set(dirs)];
}

function readIndexFile(dir: string): HubIndex | null {
    const p = join(dir, 'index.json');
    if (!existsSync(p)) return null;
    try {
        const parsed = JSON.parse(readFileSync(p, 'utf-8')) as HubIndex;
        if (!parsed || !Array.isArray(parsed.plugins)) return null;
        return parsed;
    } catch (e) {
        log.warn(`Invalid plugin hub index: ${p}`, e);
        return null;
    }
}

function readLogoDataUrl(root: string, rel: string): string | undefined {
    if (!rel) return undefined;
    const p = resolve(root, rel);
    if (!p.startsWith(resolve(root)) || !existsSync(p)) return undefined;
    try {
        const buf = readFileSync(p);
        if (buf.length > MAX_LOGO_BYTES) return undefined;
        const ext = rel.toLowerCase().split('.').pop();
        const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
        return `data:${mime};base64,${buf.toString('base64')}`;
    } catch {
        return undefined;
    }
}

/**
 * 生成注入 system prompt 的技能目录（渐进式加载：只放索引，不放正文）
 */
export function buildPluginSkillContent(info: HubPluginInfo, root: string): string {
    const lines: string[] = [];
    const byline = [info.developerName ? `by ${info.developerName}` : '', info.license ? `license ${info.license}` : ''].filter(Boolean).join(', ');
    lines.push(`Plugin "${info.displayName}" (id: ${info.id}, v${info.version}${byline ? `, ${byline}` : ''}).`);
    if (info.description) lines.push(trimText(info.description, DESC_MAX));
    lines.push(`Plugin root: ${root}`);
    lines.push('');
    lines.push('This plugin is a set of SKILL.md instruction files with supporting reference files next to them. It is NOT a tool.');
    lines.push('Only when the user\'s request matches one of the skills below: FIRST read that skill\'s SKILL.md with your file reading tool (filesystem / file_reader), THEN follow its instructions. Relative links inside a SKILL.md resolve against that skill\'s own directory. Do not guess the contents — read the file.');
    lines.push('');
    lines.push('Skills:');
    for (const skill of info.skills) {
        const skillMd = join(root, skill.path.split('/').join(process.platform === 'win32' ? '\\' : '/'), 'SKILL.md');
        const desc = trimText(skill.description, DESC_MAX) || '(no description)';
        lines.push(`- ${skill.name}: ${desc}\n  SKILL.md: ${skillMd}`);
    }
    if (info.mcpServers?.length) {
        lines.push('');
        lines.push(`MCP servers of this plugin: ${info.mcpServers.map(s => `${s.name} [${s.transport}]`).join(', ')}. When connected, their tools are exposed to you with the prefix mcp_<server>_ — e.g. a skill that says "call use_figma" means the tool mcp_figma_use_figma. If such tools are missing from your tool list, the server is not connected (the user must authorize it in the Plugins page); say so instead of guessing.`);
    }
    return lines.join('\n');
}

// ========================
// PluginHub
// ========================

export class PluginHub {
    private readonly installRoot: string;
    private readonly mirrorDirs: string[];
    private readonly remoteIndexUrl: string | null;
    private readonly remoteTimeoutMs: number;
    private readonly onSkillInstalled?: PluginHubOptions['onSkillInstalled'];
    private readonly onSkillRemoved?: PluginHubOptions['onSkillRemoved'];
    private readonly mcp?: PluginHubOptions['mcp'];
    private remoteCache: { at: number; index: HubIndex | null } | null = null;
    private busy = new Set<string>();

    constructor(options: PluginHubOptions) {
        this.installRoot = options.installRoot;
        this.mirrorDirs = options.mirrorDirs ?? defaultMirrorDirs();
        this.remoteIndexUrl = options.remoteIndexUrl === undefined ? DEFAULT_REMOTE_INDEX_URL : options.remoteIndexUrl;
        this.remoteTimeoutMs = options.remoteTimeoutMs ?? 8000;
        this.onSkillInstalled = options.onSkillInstalled;
        this.onSkillRemoved = options.onSkillRemoved;
        this.mcp = options.mcp;
        if (!existsSync(this.installRoot)) mkdirSync(this.installRoot, { recursive: true });
    }

    /** 找到第一个含 index.json 的 bundled 镜像目录 */
    get bundledDir(): string | null {
        for (const dir of this.mirrorDirs) {
            if (existsSync(join(dir, 'index.json'))) return dir;
        }
        return null;
    }

    // ---------- catalog ----------

    private readBundledIndex(): { dir: string; index: HubIndex } | null {
        const dir = this.bundledDir;
        if (!dir) return null;
        const index = readIndexFile(dir);
        return index ? { dir, index } : null;
    }

    private async readRemoteIndex(force = false): Promise<HubIndex | null> {
        if (!this.remoteIndexUrl) return null;
        if (!force && this.remoteCache && Date.now() - this.remoteCache.at < REMOTE_CACHE_TTL_MS) return this.remoteCache.index;
        let index: HubIndex | null = null;
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), this.remoteTimeoutMs);
            try {
                const res = await fetch(this.remoteIndexUrl, { signal: ctrl.signal, headers: { 'Accept': 'application/json' } });
                if (res.ok) {
                    const parsed = await res.json() as HubIndex;
                    if (parsed && Array.isArray(parsed.plugins)) index = parsed;
                    else log.warn(`Remote plugin index has unexpected shape: ${this.remoteIndexUrl}`);
                } else {
                    log.debug(`Remote plugin index unavailable: HTTP ${res.status}`);
                }
            } finally {
                clearTimeout(timer);
            }
        } catch (e) {
            log.debug(`Remote plugin index fetch failed: ${(e as Error).message}`);
        }
        this.remoteCache = { at: Date.now(), index };
        return index;
    }

    /** 列出所有插件（bundled ∪ remote ∪ installed），远程条目版本更新时覆盖同 id 的 bundled 条目 */
    /** True while a remote index fetch is running (started by a non-waiting list()). */
    private remoteRefreshInFlight: Promise<HubIndex | null> | null = null;

    private remoteCacheFresh(): boolean {
        return !!this.remoteCache && Date.now() - this.remoteCache.at < REMOTE_CACHE_TTL_MS;
    }

    /**
     * 列出所有插件（bundled ∪ remote ∪ installed），远程条目版本更新时覆盖同 id 的 bundled 条目。
     * `waitRemote: false`：不等 openflux.io，直接用缓存（或没有远程）返回；若缓存过期则在后台刷新，
     * 结果里 `remotePending: true` 提示调用方稍后再查一次。插件页打开时用它避免"正在加载…"卡住整页。
     */
    async list(options: { refresh?: boolean; waitRemote?: boolean } = {}): Promise<{ plugins: HubPluginView[]; bundledDir: string | null; remoteIndexUrl: string | null; remoteOk: boolean; remotePending: boolean }> {
        const views = new Map<string, HubPluginView>();
        const bundled = this.readBundledIndex();
        if (bundled) {
            for (const info of bundled.index.plugins) {
                if (!isSafePluginId(info.id)) continue;
                const root = join(bundled.dir, 'plugins', info.id);
                const available = info.mirrored !== false && existsSync(root) && !!findManifest(root);
                views.set(info.id, { ...info, origin: 'bundled', available, installed: false, updateAvailable: false, logoDataUrl: available ? readLogoDataUrl(root, info.logo) : undefined });
            }
        }
        let remote: HubIndex | null;
        let remotePending = false;
        if (options.waitRemote === false && !options.refresh && !this.remoteCacheFresh() && this.remoteIndexUrl) {
            remote = this.remoteCache?.index ?? null;
            remotePending = true;
            if (!this.remoteRefreshInFlight) {
                this.remoteRefreshInFlight = this.readRemoteIndex(false).finally(() => { this.remoteRefreshInFlight = null; });
            }
        } else if (options.waitRemote === false && this.remoteRefreshInFlight) {
            remote = this.remoteCache?.index ?? null;
            remotePending = true;
        } else {
            remote = this.remoteRefreshInFlight ? await this.remoteRefreshInFlight : await this.readRemoteIndex(options.refresh);
        }
        if (remote) {
            for (const info of remote.plugins) {
                if (!isSafePluginId(info.id) || !info.archive?.file) continue;
                const existing = views.get(info.id);
                if (existing && existing.available && compareVersions(info.version, existing.version) <= 0) continue;
                views.set(info.id, { ...info, origin: 'remote', available: true, installed: false, updateAvailable: false, logoDataUrl: existing?.logoDataUrl });
            }
        }
        for (const meta of this.listInstalled()) {
            const root = this.installedRoot(meta.id);
            const view = views.get(meta.id);
            if (view) {
                view.installed = true;
                view.installedVersion = meta.version;
                view.installedAt = meta.installedAt;
                view.installRoot = root;
                view.updateAvailable = view.available && compareVersions(view.version, meta.version) > 0;
                if (!view.logoDataUrl) view.logoDataUrl = readLogoDataUrl(root, meta.info.logo);
                view.mcp = this.mcpStatus(meta, root);
            } else {
                views.set(meta.id, {
                    ...meta.info, origin: meta.origin, available: false, installed: true,
                    installedVersion: meta.version, installedAt: meta.installedAt, installRoot: root, updateAvailable: false,
                    logoDataUrl: readLogoDataUrl(root, meta.info.logo),
                    mcp: this.mcpStatus(meta, root),
                });
            }
        }
        const plugins = [...views.values()].sort((a, b) => Number(b.installed) - Number(a.installed) || a.displayName.localeCompare(b.displayName));
        return { plugins, bundledDir: bundled?.dir ?? null, remoteIndexUrl: this.remoteIndexUrl, remoteOk: !!remote, remotePending };
    }

    // ---------- installed ----------

    private installedRoot(id: string): string {
        return join(this.installRoot, id);
    }

    private metaPath(id: string): string {
        return join(this.installedRoot(id), '.openflux-plugin.json');
    }

    listInstalled(): InstalledPluginMeta[] {
        if (!existsSync(this.installRoot)) return [];
        const result: InstalledPluginMeta[] = [];
        for (const entry of readdirSync(this.installRoot, { withFileTypes: true })) {
            if (!entry.isDirectory() || !isSafePluginId(entry.name)) continue;
            const metaPath = this.metaPath(entry.name);
            if (!existsSync(metaPath)) continue;
            try {
                const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as InstalledPluginMeta;
                if (meta?.id === entry.name && meta.info) result.push(meta);
            } catch (e) {
                log.warn(`Invalid installed plugin meta: ${metaPath}`, e);
            }
        }
        return result;
    }

    getInstalled(id: string): InstalledPluginMeta | null {
        if (!isSafePluginId(id)) return null;
        const p = this.metaPath(id);
        if (!existsSync(p)) return null;
        try { return JSON.parse(readFileSync(p, 'utf-8')) as InstalledPluginMeta; } catch { return null; }
    }

    /** 启动时把已安装插件的技能目录注入 AgentManager */
    loadInstalled(): number {
        let count = 0;
        for (const meta of this.listInstalled()) {
            const root = this.installedRoot(meta.id);
            if (!findManifest(root)) {
                log.warn(`Installed plugin ${meta.id} has no manifest under ${root}; skipped`);
                continue;
            }
            this.injectSkill(meta, root);
            count++;
            // Remote/bundled MCP servers: reconnect with stored credentials; never open a browser at startup.
            void this.connectMcp(meta.id, false).catch(error => {
                log.info(`Plugin ${meta.id}: MCP not connected at startup (${error instanceof Error ? error.message : String(error)})`);
            });
        }
        if (count > 0) log.info(`Loaded ${count} installed plugin(s) into AgentManager`);
        return count;
    }

    // ---------- MCP ----------

    /** Gateway-ready configs for the MCP servers a plugin declares (paths resolved against the plugin root). */
    mcpConfigsFor(meta: InstalledPluginMeta, root: string): HubMcpServerConfig[] {
        return (meta.info.mcpServers || []).map(server => {
            const override = meta.mcpOverrides?.[server.name];
            const declared = override?.transport ?? server.transport;
            const transport: HubMcpServerConfig['transport'] = declared === 'http' || declared === 'streamable-http' || declared === 'streamable_http'
                ? 'http'
                : declared === 'sse' ? 'sse' : 'stdio';
            const env: Record<string, string> = {};
            for (const [k, v] of Object.entries(server.env || {})) {
                // Codex allows ${VAR} references in plugin env values.
                env[k] = String(v).replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name: string) => process.env[name] ?? '');
            }
            return {
                name: server.name,
                transport,
                command: server.command,
                args: server.args,
                cwd: transport === 'stdio' ? resolve(root, server.cwd || '.') : undefined,
                env: Object.keys(env).length ? env : undefined,
                url: override?.url || server.url,
                headers: server.headers,
                bearerTokenEnvVar: server.bearerTokenEnvVar,
                oauthResource: override?.url ? undefined : server.oauthResource,
                oauth: override?.oauth,
                enabled: true,
                timeout: 30,
            };
        });
    }

    /** Set (or clear with null) the user's override for one MCP server of an installed plugin. */
    setMcpOverride(id: string, serverName: string, override: HubMcpOverride | null): InstalledPluginMeta {
        const meta = this.getInstalled(id);
        if (!meta) throw new Error(`plugin not installed: ${id}`);
        if (!(meta.info.mcpServers || []).some(s => s.name === serverName)) throw new Error(`plugin ${id} declares no MCP server "${serverName}"`);
        const overrides = { ...(meta.mcpOverrides || {}) };
        if (override && (override.url || override.oauth || override.transport)) {
            if (override.url && !/^https?:\/\//i.test(override.url)) throw new Error('MCP url must start with http:// or https://');
            overrides[serverName] = override;
        } else {
            delete overrides[serverName];
        }
        meta.mcpOverrides = Object.keys(overrides).length ? overrides : undefined;
        writeFileSync(this.metaPath(id), JSON.stringify(meta, null, 2), 'utf-8');
        return meta;
    }

    private mcpStatus(meta: InstalledPluginMeta, root: string): HubMcpStatus[] {
        const servers = this.mcpConfigsFor(meta, root);
        if (servers.length === 0) return [];
        const base = this.mcp
            ? this.mcp.status(meta.id, servers)
            : servers.map(s => ({ name: s.name, status: 'unsupported' as const, toolCount: 0 }));
        return base.map(st => {
            const cfg = servers.find(s => s.name === st.name);
            return { ...st, url: cfg?.url || cfg?.command, transport: cfg?.transport, overridden: !!meta.mcpOverrides?.[st.name] };
        });
    }

    /** Current MCP status of an installed plugin (no connection attempt). */
    getMcpStatus(id: string): HubMcpStatus[] {
        const meta = this.getInstalled(id);
        if (!meta) return [];
        return this.mcpStatus(meta, this.installedRoot(id));
    }

    private autoReconnectTimer: ReturnType<typeof setInterval> | null = null;
    private autoReconnectBusy = false;

    /**
     * Keep trying local MCP servers that are down (e.g. Figma desktop's local
     * server before the app is opened). Only loopback / stdio servers in the
     * `error` state are retried, so a remote server that rejects us is not hammered.
     */
    startMcpAutoReconnect(intervalMs = 30_000): void {
        if (this.autoReconnectTimer || !this.mcp) return;
        const tick = async (): Promise<void> => {
            if (this.autoReconnectBusy) return;
            this.autoReconnectBusy = true;
            try {
                for (const meta of this.listInstalled()) {
                    if (!meta.info.mcpServers?.length) continue;
                    const root = this.installedRoot(meta.id);
                    const servers = this.mcpConfigsFor(meta, root);
                    const status = this.mcp!.status(meta.id, servers);
                    const retryable = servers.filter(s => {
                        const st = status.find(x => x.name === s.name);
                        if (!st || (st.status !== 'error' && st.status !== 'disconnected')) return false;
                        if (s.transport === 'stdio') return true;
                        return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(s.url || '');
                    });
                    if (retryable.length === 0) continue;
                    try {
                        await this.mcp!.connect(meta.id, retryable, false);
                        log.info(`Plugin ${meta.id}: local MCP server(s) reconnected: ${retryable.map(s => s.name).join(', ')}`);
                    } catch {
                        // Still down; try again next tick.
                    }
                }
            } finally {
                this.autoReconnectBusy = false;
            }
        };
        this.autoReconnectTimer = setInterval(() => { void tick(); }, intervalMs);
        this.autoReconnectTimer.unref?.();
    }

    stopMcpAutoReconnect(): void {
        if (this.autoReconnectTimer) clearInterval(this.autoReconnectTimer);
        this.autoReconnectTimer = null;
    }

    /** Reconnect every installed plugin's MCP servers silently (after an MCP config hot-reload). */
    async reconnectInstalledMcp(): Promise<void> {
        for (const meta of this.listInstalled()) {
            if (!meta.info.mcpServers?.length) continue;
            await this.connectMcp(meta.id, false).catch(error => {
                log.info(`Plugin ${meta.id}: MCP reconnect skipped (${error instanceof Error ? error.message : String(error)})`);
            });
        }
    }

    /**
     * Connect the MCP servers of an installed plugin. `interactive` allows an
     * OAuth flow in the user's browser (plugin install / "authorize" button).
     */
    async connectMcp(id: string, interactive: boolean): Promise<HubMcpStatus[]> {
        const meta = this.getInstalled(id);
        if (!meta) throw new Error(`plugin not installed: ${id}`);
        const root = this.installedRoot(id);
        const servers = this.mcpConfigsFor(meta, root);
        if (servers.length === 0 || !this.mcp) return this.mcpStatus(meta, root);
        await this.mcp.connect(id, servers, interactive);
        return this.mcp.status(id, servers);
    }

    private injectSkill(meta: InstalledPluginMeta, root: string): void {
        this.onSkillInstalled?.({
            id: meta.runtimeSkillId,
            title: `${meta.info.displayName} (plugin)`,
            content: buildPluginSkillContent(meta.info, root),
        });
    }

    // ---------- install / uninstall ----------

    async install(id: string): Promise<InstalledPluginMeta> {
        if (!isSafePluginId(id)) throw new Error(`invalid plugin id: ${id}`);
        if (this.busy.has(id)) throw new Error(`plugin ${id} is busy`);
        this.busy.add(id);
        try {
            const { plugins } = await this.list();
            const view = plugins.find(p => p.id === id);
            if (!view) throw new Error(`plugin not found: ${id}`);
            if (!view.available) throw new Error(`plugin ${id} has no installable source`);

            const staging = mkdtempSync(join(tmpdir(), 'openflux-plugin-'));
            try {
                let stagedRoot: string;
                if (view.origin === 'bundled') {
                    const bundled = this.readBundledIndex();
                    if (!bundled) throw new Error('bundled plugin hub not found');
                    const src = join(bundled.dir, 'plugins', id);
                    stagedRoot = join(staging, id);
                    cpSync(src, stagedRoot, { recursive: true });
                } else {
                    stagedRoot = await this.downloadAndExtract(view, staging);
                }
                if (!findManifest(stagedRoot)) throw new Error(`plugin ${id}: manifest missing after staging`);

                const target = this.installedRoot(id);
                const info: HubPluginInfo = { ...view };
                delete (info as Partial<HubPluginView>).logoDataUrl;
                delete (info as Partial<HubPluginView>).installed;
                delete (info as Partial<HubPluginView>).installedVersion;
                delete (info as Partial<HubPluginView>).installedAt;
                delete (info as Partial<HubPluginView>).updateAvailable;
                delete (info as Partial<HubPluginView>).available;
                delete (info as Partial<HubPluginView>).installRoot;
                delete (info as Partial<HubPluginView>).origin;
                const meta: InstalledPluginMeta = {
                    id,
                    version: view.version,
                    displayName: view.displayName,
                    installedAt: new Date().toISOString(),
                    origin: view.origin,
                    skillIds: view.skills.map(s => s.id),
                    runtimeSkillId: pluginRuntimeSkillId(id),
                    info,
                };
                writeFileSync(join(stagedRoot, '.openflux-plugin.json'), JSON.stringify(meta, null, 2), 'utf-8');

                // 原子替换：先挪走旧目录，失败再回滚
                const backup = `${target}.bak-${Date.now()}`;
                if (existsSync(target)) renameSync(target, backup);
                try {
                    mkdirSync(dirname(target), { recursive: true });
                    cpSync(stagedRoot, target, { recursive: true });
                } catch (e) {
                    rmSync(target, { recursive: true, force: true });
                    if (existsSync(backup)) renameSync(backup, target);
                    throw e;
                }
                rmSync(backup, { recursive: true, force: true });

                this.injectSkill(meta, target);
                log.info(`Plugin installed: ${id}@${meta.version} (${view.origin}, ${view.skills.length} skills) -> ${target}`);
                const servers = this.mcpConfigsFor(meta, target);
                if (servers.length && this.mcp) {
                    try {
                        await this.mcp.connect(id, servers, true);
                    } catch (error) {
                        // The plugin is installed; the server can be authorized later from the Plugins page.
                        log.warn(`Plugin ${id}: MCP connect after install failed: ${error instanceof Error ? error.message : String(error)}`);
                    }
                }
                return meta;
            } finally {
                rmSync(staging, { recursive: true, force: true });
            }
        } finally {
            this.busy.delete(id);
        }
    }

    uninstall(id: string): boolean {
        if (!isSafePluginId(id)) return false;
        const meta = this.getInstalled(id);
        const root = this.installedRoot(id);
        if (!meta && !existsSync(root)) return false;
        rmSync(root, { recursive: true, force: true });
        this.onSkillRemoved?.(meta?.runtimeSkillId || pluginRuntimeSkillId(id));
        if (meta?.info.mcpServers?.length && this.mcp) {
            void this.mcp.disconnect(id).catch(error => log.warn(`Plugin ${id}: MCP disconnect failed`, error));
        }
        log.info(`Plugin uninstalled: ${id}`);
        return true;
    }

    // ---------- remote download ----------

    private async downloadAndExtract(view: HubPluginView, staging: string): Promise<string> {
        if (!this.remoteIndexUrl || !view.archive) throw new Error('remote source unavailable');
        const url = new URL(view.archive.file, this.remoteIndexUrl).toString();
        if (!url.startsWith('https://')) throw new Error(`refusing non-https plugin archive: ${url}`);
        log.info(`Downloading plugin ${view.id}@${view.version}: ${url}`);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), Math.max(this.remoteTimeoutMs, 60_000));
        let buf: Buffer;
        try {
            const res = await fetch(url, { signal: ctrl.signal });
            if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
            const len = Number(res.headers.get('content-length') || 0);
            if (len > MAX_ARCHIVE_BYTES) throw new Error(`archive too large: ${len} bytes`);
            buf = Buffer.from(await res.arrayBuffer());
        } finally {
            clearTimeout(timer);
        }
        if (buf.length > MAX_ARCHIVE_BYTES) throw new Error(`archive too large: ${buf.length} bytes`);
        const sha = createHash('sha256').update(buf).digest('hex');
        if (view.archive.sha256 && sha !== view.archive.sha256) throw new Error(`archive checksum mismatch for ${view.id}`);

        const archivePath = join(staging, `${view.id}.tar.gz`);
        writeFileSync(archivePath, buf);
        const extractDir = join(staging, 'extract');
        mkdirSync(extractDir, { recursive: true });
        // bsdtar/GNU tar 默认都会剥离绝对路径和 `..`；再额外校验解压结果只含 <id>/ 一个根
        const res = spawnSync(tarCommand(), ['-xzf', archivePath, '-C', extractDir], { encoding: 'utf-8' });
        if (res.error) throw res.error;
        if (res.status !== 0) throw new Error(`tar failed: ${res.stderr}`);
        const roots = readdirSync(extractDir);
        if (roots.length !== 1 || roots[0] !== view.id) throw new Error(`unexpected archive layout for ${view.id}: ${roots.join(', ')}`);
        return join(extractDir, view.id);
    }
}

/** 简单语义化版本比较：a > b 返回正数 */
export function compareVersions(a: string, b: string): number {
    const pa = String(a || '0').split(/[.-]/).map(x => parseInt(x, 10) || 0);
    const pb = String(b || '0').split(/[.-]/).map(x => parseInt(x, 10) || 0);
    const n = Math.max(pa.length, pb.length);
    for (let i = 0; i < n; i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d !== 0) return d;
    }
    return 0;
}
