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

export async function checkForUpdate(manual = false): Promise<UpdateUiState> {
    const brand = getBrand();
    const policy = resolvePolicy(brand);

    if (!policy.enabled) {
        const state: UpdateUiState = { status: 'idle', message: 'disabled' };
        setState(state);
        return state;
    }
    if (isDevRuntime()) {
        const state: UpdateUiState = { status: 'idle', message: 'dev_skip' };
        setState(state);
        return state;
    }
    if (!shouldCheck(manual, manual ? 0 : policy.startupMinIntervalHours)) {
        return cachedState;
    }

    setState({ ...cachedState, status: 'checking' });

    try {
        const result = await invoke<UpdateCheckResult>('check_app_update', {
            manifestUrl: policy.feedUrl,
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
}
