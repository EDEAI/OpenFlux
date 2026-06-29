/**
 * Client update checker — manifest-based version prompts (no Router).
 */

import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { openUrl } from '@tauri-apps/plugin-opener';
import { getBrand, type BrandConfig } from './brand';
import { t } from './i18n/index';

const OSS_MANIFEST_BASE = 'https://openflux-release.oss-cn-hangzhou.aliyuncs.com/release/manifests';

const DEFAULT_OPENFLUX_FEED = `${OSS_MANIFEST_BASE}/openflux.json`;
const DEFAULT_XCXD_FEED = `${OSS_MANIFEST_BASE}/xcxd.json`;

const DEFAULT_DOWNLOAD_PAGES: Record<string, string> = {
    openflux: 'https://openflux.io/download',
    xcxd: 'https://openflux.io/xcxd',
};

const STORAGE_PREFIX = 'openflux-update:';

export interface UpdatePolicy {
    enabled?: boolean;
    feedUrl?: string;
    downloadPage?: string;
    startupDelaySec?: number;
    startupMinIntervalHours?: number;
    backgroundIntervalHours?: number;
    dismissDays?: number;
    /** banner = top strip; settings_only = only show in settings/about */
    promptStyle?: 'banner' | 'settings_only';
}

export interface ReleaseManifest {
    brandId: string;
    channel?: string;
    version: string;
    releaseDate?: string;
    minSupportedVersion?: string;
    notes?: string[];
    notesUrl?: string;
    downloadPage?: string;
    downloads?: Record<string, { url: string; sha256?: string }>;
}

export interface UpdateCheckResult {
    currentVersion: string;
    latestVersion?: string;
    updateAvailable: boolean;
    forceUpdate: boolean;
    manifest?: ReleaseManifest;
    downloadUrl?: string;
    downloadPage?: string;
    platformKey: string;
    error?: string;
}

export interface UpdateUiState {
    status: 'idle' | 'checking' | 'up_to_date' | 'available' | 'force' | 'error';
    result?: UpdateCheckResult;
    lastCheckedAt?: number;
    message?: string;
}

let cachedState: UpdateUiState = { status: 'idle' };
let backgroundTimer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<(state: UpdateUiState) => void>();

function isDevRuntime(): boolean {
    try {
        const host = window.location.hostname;
        const port = window.location.port;
        return host === 'localhost' && (port === '1420' || port === '5173');
    } catch {
        return false;
    }
}

function brandId(): string {
    return getBrand()?.brandId || 'openflux';
}

function resolvePolicy(brand: BrandConfig | null): Required<UpdatePolicy> {
    const raw = (brand?.update || {}) as UpdatePolicy;
    const id = brand?.brandId || 'openflux';
    const servicesFeed = typeof brand?.services?.updateFeedUrl === 'string'
        ? brand.services.updateFeedUrl.trim()
        : '';

    const defaultFeed = id === 'xcxd' ? DEFAULT_XCXD_FEED : DEFAULT_OPENFLUX_FEED;
    const defaultBgHours = id === 'xcxd' ? 48 : 24;
    const defaultPrompt = id === 'xcxd' ? 'settings_only' : 'banner';

    return {
        enabled: raw.enabled !== false,
        feedUrl: raw.feedUrl?.trim() || servicesFeed || defaultFeed,
        downloadPage: raw.downloadPage?.trim() || brand?.links?.website?.trim() || DEFAULT_DOWNLOAD_PAGES[id] || DEFAULT_DOWNLOAD_PAGES.openflux,
        startupDelaySec: raw.startupDelaySec ?? 8,
        startupMinIntervalHours: raw.startupMinIntervalHours ?? 6,
        backgroundIntervalHours: raw.backgroundIntervalHours ?? defaultBgHours,
        dismissDays: raw.dismissDays ?? 7,
        promptStyle: raw.promptStyle ?? defaultPrompt,
    };
}

function storageKey(key: string): string {
    return `${STORAGE_PREFIX}${brandId()}:${key}`;
}

function readNumber(key: string): number | undefined {
    const raw = localStorage.getItem(storageKey(key));
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
}

function writeNumber(key: string, value: number): void {
    localStorage.setItem(storageKey(key), String(value));
}

function readString(key: string): string | undefined {
    return localStorage.getItem(storageKey(key)) || undefined;
}

function writeString(key: string, value: string): void {
    localStorage.setItem(storageKey(key), value);
}

function hoursSince(ts?: number): number {
    if (!ts) return Number.POSITIVE_INFINITY;
    return (Date.now() - ts) / (1000 * 60 * 60);
}

function shouldCheck(manual: boolean, minIntervalHours: number): boolean {
    if (manual) return true;
    const last = readNumber('lastCheckAt');
    return hoursSince(last) >= minIntervalHours;
}

function isDismissed(version: string, dismissDays: number): boolean {
    const dismissedVersion = readString('dismissedVersion');
    const dismissedAt = readNumber('dismissedAt');
    if (!dismissedVersion || dismissedVersion !== version) return false;
    return hoursSince(dismissedAt) < dismissDays * 24;
}

function notify(): void {
    for (const fn of listeners) fn(cachedState);
}

function setState(next: UpdateUiState): void {
    cachedState = next;
    notify();
}

export function subscribeUpdateState(listener: (state: UpdateUiState) => void): () => void {
    listeners.add(listener);
    listener(cachedState);
    return () => listeners.delete(listener);
}

export function getUpdateState(): UpdateUiState {
    return cachedState;
}

/** dev 专用清单地址覆盖（仅影响 dev 下的「手动」检查；生产与自动检查不受影响） */
function devFeedOverride(): string | undefined {
    try {
        return localStorage.getItem(`${STORAGE_PREFIX}devFeed`)?.trim() || undefined;
    } catch {
        return undefined;
    }
}

export async function checkForUpdate(manual = false): Promise<UpdateUiState> {
    const brand = getBrand();
    const policy = resolvePolicy(brand);

    if (!policy.enabled) {
        const state: UpdateUiState = { status: 'idle', message: 'disabled' };
        setState(state);
        return state;
    }
    // dev 下：自动/后台检查仍跳过；但「手动」点击「检查更新」允许走真实链路（便于本地联调）
    if (isDevRuntime() && !manual) {
        const state: UpdateUiState = { status: 'idle', message: 'dev_skip' };
        setState(state);
        return state;
    }
    if (!shouldCheck(manual, manual ? 0 : policy.startupMinIntervalHours)) {
        return cachedState;
    }

    // dev 手动检查：默认走线上正式清单；如需模拟「检测到新版本」，用 __setUpdateFeed(url) 指定测试清单，
    // __clearUpdateFeed() 清除覆盖。生产环境一律用品牌正式 feedUrl。
    let feedUrl = policy.feedUrl;
    if (isDevRuntime()) {
        feedUrl = devFeedOverride() || policy.feedUrl;
    }

    setState({ ...cachedState, status: 'checking' });

    try {
        const result = await invoke<UpdateCheckResult>('check_app_update', {
            manifestUrl: feedUrl,
        });
        writeNumber('lastCheckAt', Date.now());

        let status: UpdateUiState['status'] = 'up_to_date';
        if (result.error) {
            status = 'error';
        } else if (result.forceUpdate) {
            status = 'force';
        } else if (result.updateAvailable) {
            status = 'available';
        }

        const state: UpdateUiState = {
            status,
            result,
            lastCheckedAt: Date.now(),
            message: result.error,
        };
        setState(state);
        return state;
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const state: UpdateUiState = {
            status: 'error',
            lastCheckedAt: Date.now(),
            message,
        };
        setState(state);
        return state;
    }
}

/** 默认模拟的目标新版本号（当前线上为 0.6.20，模拟升级到 0.6.25） */
const SIMULATED_TARGET_VERSION = '0.6.25';

/** 0.6.25 模拟更新说明（与实际迭代内容一致，便于演示设置页展示效果） */
const SIMULATED_NOTES_0_6_25 = [
    '新增客户端版本更新检测与提示（横幅 / 设置页）',
    'Office 插件断线自动重连与心跳保活，统一插件版本',
    '设计画布启动增加「画布载入中」提示，优化首屏体验',
    '修正全托管模式下工作模式显示与实际不符的问题',
    '记忆蒸馏过滤时效性「工具不可用」结论，提升长期记忆质量',
];

/**
 * 【仅供测试】注入一个模拟的更新状态，用于在 dev 下走通"检测到新版本"的完整 UI 流程
 * （顶部横幅 / 设置页徽标 / 强制更新弹窗 / 前往下载按钮），绕过 dev 短路、远程清单与 Rust 版本比较。
 * 控制台调用：
 *   await __testUpdate('available')             // 普通新版本（当前 0.6.20 → 0.6.25）
 *   await __testUpdate('force')                 // 强制更新（弹出强制更新模态框）
 *   await __testUpdate('up_to_date')            // 已是最新
 *   await __testUpdate('clear')                 // 清除模拟，恢复 idle
 *   await __testUpdate('available', '0.7.0')    // 自定义目标版本号
 */
export async function simulateUpdateState(
    kind: 'available' | 'force' | 'up_to_date' | 'clear' = 'available',
    targetVersion: string = SIMULATED_TARGET_VERSION,
): Promise<UpdateUiState> {
    let currentVersion = '0.0.0';
    try { currentVersion = await getVersion(); } catch { /* ignore */ }

    if (kind === 'clear') {
        setState({ status: 'idle' });
        return cachedState;
    }

    // 清掉"本版本已忽略"标记，确保横幅能显示
    try {
        localStorage.removeItem(storageKey('dismissedVersion'));
        localStorage.removeItem(storageKey('dismissedAt'));
    } catch { /* ignore */ }

    const fakeLatest = kind === 'up_to_date' ? currentVersion : targetVersion;
    const id = brandId();
    const notes = fakeLatest === SIMULATED_TARGET_VERSION
        ? SIMULATED_NOTES_0_6_25
        : ['【模拟】这是用于测试的新版本更新说明', '修复若干已知问题并提升稳定性'];
    const result: UpdateCheckResult = {
        currentVersion,
        latestVersion: fakeLatest,
        updateAvailable: kind !== 'up_to_date',
        forceUpdate: kind === 'force',
        manifest: {
            brandId: id,
            version: fakeLatest,
            releaseDate: new Date().toISOString().slice(0, 10),
            notes,
            downloadPage: DEFAULT_DOWNLOAD_PAGES[id] || DEFAULT_DOWNLOAD_PAGES.openflux,
        },
        downloadPage: DEFAULT_DOWNLOAD_PAGES[id] || DEFAULT_DOWNLOAD_PAGES.openflux,
        platformKey: 'test',
    };

    const status: UpdateUiState['status'] = kind === 'force' ? 'force'
        : kind === 'up_to_date' ? 'up_to_date'
        : 'available';
    setState({ status, result, lastCheckedAt: Date.now() });
    return cachedState;
}

/**
 * 【仅供测试】走真实链路检查更新：直接调用 Rust `check_app_update`，绕过 dev 短路，
 * 可传入自定义清单 URL（默认用品牌策略的 feedUrl）。结果按真实流程写入 UI 状态。
 * 控制台调用：
 *   await __checkUpdateReal()                                   // 用线上正式清单
 *   await __checkUpdateReal('http://localhost:1420/your-test-manifest.json')  // 指向本地测试清单测真实比较
 */
export async function runRealUpdateCheck(manifestUrl?: string): Promise<UpdateUiState> {
    const policy = resolvePolicy(getBrand());
    const url = (manifestUrl && manifestUrl.trim()) || policy.feedUrl;
    setState({ ...cachedState, status: 'checking' });
    try {
        const result = await invoke<UpdateCheckResult>('check_app_update', { manifestUrl: url });
        let status: UpdateUiState['status'] = 'up_to_date';
        if (result.error) status = 'error';
        else if (result.forceUpdate) status = 'force';
        else if (result.updateAvailable) status = 'available';
        setState({ status, result, lastCheckedAt: Date.now(), message: result.error });
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setState({ status: 'error', lastCheckedAt: Date.now(), message });
    }
    return cachedState;
}

export function shouldShowBanner(policy = resolvePolicy(getBrand())): boolean {
    if (policy.promptStyle === 'settings_only') return false;
    const { status, result } = cachedState;
    if (!result?.latestVersion) return false;
    if (status !== 'available' && status !== 'force') return false;
    if (status === 'available' && isDismissed(result.latestVersion, policy.dismissDays)) return false;
    return true;
}

export function dismissCurrentUpdate(): void {
    const version = cachedState.result?.latestVersion;
    if (!version) return;
    writeString('dismissedVersion', version);
    writeNumber('dismissedAt', Date.now());
    notify();
}

export async function openUpdateDownload(): Promise<void> {
    const policy = resolvePolicy(getBrand());
    const result = cachedState.result;
    const target = result?.downloadUrl || result?.downloadPage || result?.manifest?.downloadPage
        || result?.manifest?.notesUrl || policy.downloadPage;
    if (!target) return;
    await openUrl(target);
}

export function formatUpdateBannerText(): string {
    const result = cachedState.result;
    if (!result?.latestVersion) return '';
    if (cachedState.status === 'force') {
        return t('update.force_banner', result.latestVersion);
    }
    return t('update.banner', result.latestVersion);
}

export async function initUpdateChecker(): Promise<void> {
    if (isDevRuntime()) return;

    const brand = getBrand();
    const policy = resolvePolicy(brand);
    if (!policy.enabled) return;

    await scheduleUpdateChecks();
}

async function scheduleUpdateChecks(): Promise<void> {
    const policy = resolvePolicy(getBrand());
    if (!policy.enabled || isDevRuntime()) return;

    window.setTimeout(() => {
        void checkForUpdate(false);
    }, Math.max(1, policy.startupDelaySec) * 1000);

    if (backgroundTimer) clearInterval(backgroundTimer);
    const bgHours = policy.backgroundIntervalHours;
    if (bgHours > 0) {
        backgroundTimer = window.setInterval(() => {
            void checkForUpdate(false);
        }, bgHours * 60 * 60 * 1000);
    }
}

export async function refreshAboutVersionLabels(): Promise<void> {
    try {
        const version = await getVersion();
        const currentEl = document.getElementById('update-current-version');
        if (currentEl) currentEl.textContent = `v${version}`;
    } catch {
        /* ignore */
    }
}

export function renderAboutUpdateSection(): void {
    const latestEl = document.getElementById('update-latest-version');
    const statusEl = document.getElementById('update-status-text');
    const notesEl = document.getElementById('update-release-notes');
    const checkBtn = document.getElementById('update-check-btn') as HTMLButtonElement | null;
    const badge = document.getElementById('settings-update-badge');

    const { status, result, message } = cachedState;

    if (checkBtn) {
        checkBtn.disabled = status === 'checking';
        checkBtn.textContent = status === 'checking' ? t('update.checking') : t('update.check_now');
    }

    if (latestEl) {
        latestEl.textContent = result?.latestVersion ? `v${result.latestVersion}` : '—';
    }

    if (statusEl) {
        if (status === 'checking') statusEl.textContent = t('update.checking');
        else if (status === 'error') statusEl.textContent = t('update.check_failed');
        else if (status === 'force') statusEl.textContent = t('update.force_required');
        else if (status === 'available') statusEl.textContent = t('update.available');
        else if (status === 'up_to_date') statusEl.textContent = t('update.up_to_date');
        else statusEl.textContent = t('update.not_checked');
        if (status === 'error' && message) statusEl.title = message;
    }

    if (notesEl) {
        const notes = result?.manifest?.notes || [];
        notesEl.innerHTML = notes.length
            ? `<ul>${notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>`
            : '';
    }

    const showBadge = status === 'available' || status === 'force';
    if (badge) badge.classList.toggle('hidden', !showBadge);
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function bindUpdateUi(): void {
    const banner = document.getElementById('update-banner');
    const bannerText = document.getElementById('update-banner-text');
    const bannerAction = document.getElementById('update-banner-action');
    const bannerDismiss = document.getElementById('update-banner-dismiss');
    const checkBtn = document.getElementById('update-check-btn');
    const downloadBtn = document.getElementById('update-download-btn');
    const forceModal = document.getElementById('update-force-modal');
    const forceAction = document.getElementById('update-force-action');
    const settingsBtn = document.getElementById('settings-btn');

    const refreshBanner = () => {
        const policy = resolvePolicy(getBrand());
        const show = shouldShowBanner(policy);
        if (banner) banner.classList.toggle('hidden', !show);
        if (bannerText && show) bannerText.textContent = formatUpdateBannerText();
        if (forceModal) {
            const force = cachedState.status === 'force';
            forceModal.classList.toggle('hidden', !force);
        }
        renderAboutUpdateSection();
        if (settingsBtn && (cachedState.status === 'available' || cachedState.status === 'force')) {
            settingsBtn.classList.add('has-update-badge');
        } else if (settingsBtn) {
            settingsBtn.classList.remove('has-update-badge');
        }
    };

    subscribeUpdateState(refreshBanner);

    bannerAction?.addEventListener('click', () => { void openUpdateDownload(); });
    bannerDismiss?.addEventListener('click', () => {
        dismissCurrentUpdate();
        refreshBanner();
    });
    checkBtn?.addEventListener('click', () => { void checkForUpdate(true); });
    downloadBtn?.addEventListener('click', () => { void openUpdateDownload(); });
    forceAction?.addEventListener('click', () => { void openUpdateDownload(); });

    void refreshAboutVersionLabels();
    refreshBanner();

    // 【测试钩子】
    //  __testUpdate('available'|'force'|'up_to_date'|'clear', '0.6.25')  纯 UI 模拟（默认 0.6.20→0.6.25）
    //  __checkUpdateReal(url?)                                           走真实 Rust 链路检查（一次性）
    //  __setUpdateFeed(url)                                              指定 dev 手动「检查更新」按钮使用的清单地址
    //  __clearUpdateFeed()                                               清除上面的覆盖，按钮恢复用线上清单
    try {
        (window as any).__testUpdate = simulateUpdateState;
        (window as any).__checkUpdateReal = runRealUpdateCheck;
        (window as any).__setUpdateFeed = (url: string) => {
            localStorage.setItem(`${STORAGE_PREFIX}devFeed`, String(url || '').trim());
            return `dev 更新清单已设为: ${url}（现在点击「检查更新」即走真实链路）`;
        };
        (window as any).__clearUpdateFeed = () => {
            localStorage.removeItem(`${STORAGE_PREFIX}devFeed`);
            return 'dev 更新清单覆盖已清除（按钮恢复使用线上清单）';
        };
    } catch { /* ignore */ }
}
