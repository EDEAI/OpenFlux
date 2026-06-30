/**
 * brand.ts - runtime application layer for optional brand/theme configuration
 *
 * On startup it reads the config from the Rust backend `get_brand_config` (from
 * resources/.brands/brand.json if present, otherwise the built-in default) and
 * applies: theme color / theme mode / default language / language lock / window
 * title / feature visibility / audio entry.
 *
 * Design principles:
 * - Only apply defaults when the user has not made a choice yet (localStorage empty),
 *   respecting user preferences.
 * - Feature visibility uses a dual hook: a body class (brand-no-<feature>) plus a
 *   [data-feature] selector, without hardcoding existing DOM ids — this neither
 *   breaks the original UI nor blocks mounting features on demand later.
 */

import { invoke } from '@tauri-apps/api/core';
import { setLocale, type Locale } from './i18n/index';

export interface BrandConfig {
    brandId?: string;
    app?: {
        productName?: string;
        windowTitle?: string;
        /** Enterprise edition name appended after the top-left "OpenFlux" title, e.g. "XCXD" -> "OpenFlux XCXD" */
        titleSuffix?: string;
    };
    theme?: {
        primaryColor?: string;
        accentColor?: string;
        mode?: 'dark' | 'light' | 'auto';
    };
    language?: {
        enabled?: string[];
        default?: string;
        lockLanguage?: boolean;
    };
    workModes?: {
        enabled?: string[];
        default?: string;
        lockMode?: boolean;
    };
    audio?: {
        playbackEnabled?: boolean;
    };
    services?: {
        /** Lock service addresses (router + nexusai): hidden/disabled in settings, user cannot change */
        lockServices?: boolean;
        [k: string]: unknown;
    };
    agents?: {
        /** Default main agent name; used to pre-fill the first-run wizard name field */
        defaultName?: string;
        [k: string]: unknown;
    };
    features?: {
        scheduler?: boolean;
        wechatIntegration?: boolean;
        showcaseGallery?: boolean;
        codingAgents?: boolean;
        /** 内置「设计师」Agent 及其设计画布入口；缺省显示，设为 false 时隐藏 */
        designerAgent?: boolean;
        [k: string]: unknown;
    };
    links?: Record<string, string>;
    strings?: Record<string, string>;
    update?: {
        enabled?: boolean;
        feedUrl?: string;
        downloadPage?: string;
        startupDelaySec?: number;
        startupMinIntervalHours?: number;
        backgroundIntervalHours?: number;
        dismissDays?: number;
        promptStyle?: 'banner' | 'settings_only';
    };
    [k: string]: unknown;
}

let cachedBrand: BrandConfig | null = null;

/** The currently loaded brand config (available after initBrand completes). */
export function getBrand(): BrandConfig | null {
    return cachedBrand;
}

/** Normalize a brand language code (e.g. zh-CN / zh-TW / en) to a built-in Locale. */
function normalizeLocale(lang?: string): Locale | null {
    if (!lang) return null;
    if (lang.toLowerCase().startsWith('zh')) return 'zh';
    if (lang.toLowerCase().startsWith('en')) return 'en';
    return null;
}

/** Apply theme colors (written as documentElement inline styles, higher priority than any theme selector). */
function applyThemeColors(theme?: BrandConfig['theme']): void {
    if (!theme) return;
    const root = document.documentElement;
    if (theme.primaryColor) {
        root.style.setProperty('--color-primary', theme.primaryColor);
        root.style.setProperty('--color-primary-hover', theme.primaryColor);
    }
    if (theme.accentColor) {
        root.style.setProperty('--color-accent', theme.accentColor);
    }
}

/** Apply the default theme mode: only effective when the user has not chosen manually. */
function applyThemeMode(mode?: 'dark' | 'light' | 'auto'): void {
    if (!mode || mode === 'auto') return;
    const saved = localStorage.getItem('openflux-theme');
    if (saved) return; // respect the user's existing choice
    if (mode === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
    } else {
        document.documentElement.removeAttribute('data-theme');
    }
    localStorage.setItem('openflux-theme', mode);
}

/** Apply the default / locked language. */
function applyLanguage(language?: BrandConfig['language']): void {
    if (!language) return;
    const saved = localStorage.getItem('openflux-locale');
    const def = normalizeLocale(language.default);
    if (!saved && def) {
        setLocale(def);
    }
    if (language.lockLanguage) {
        document.body.classList.add('brand-lock-language');
    }
}

/** Apply the window title. */
async function applyTitle(app?: BrandConfig['app']): Promise<void> {
    const title = app?.windowTitle || app?.productName;
    if (!title) return;
    document.title = title;
    try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await getCurrentWindow().setTitle(title);
    } catch {
        // Ignore in non-Tauri environments (e.g. pure browser debugging)
    }
}

/**
 * Append the enterprise edition name after the top-left "OpenFlux" title.
 * e.g. titleSuffix "XCXD" turns "OpenFlux" into "OpenFlux XCXD".
 */
function applyTopbarName(app?: BrandConfig['app']): void {
    const suffix = app?.titleSuffix?.trim();
    if (!suffix) return;
    const el = document.getElementById('topbar-app-name');
    if (!el) return;
    const base = (el.textContent || 'OpenFlux').trim();
    el.textContent = `${base} ${suffix}`;
}

/**
 * Apply feature visibility. For each disabled feature:
 *   - add the class `brand-no-<feature>` to body (for CSS / business-logic checks)
 *   - inject a style hiding elements matching `[data-feature="<feature>"]`
 */
function applyFeatures(features: BrandConfig['features'], audio: BrandConfig['audio']): void {
    const flags: Record<string, boolean | undefined> = {
        scheduler: features?.scheduler,
        wechatIntegration: features?.wechatIntegration,
        showcaseGallery: features?.showcaseGallery,
        codingAgents: features?.codingAgents,
        designerAgent: features?.designerAgent,
        audioPlayback: audio?.playbackEnabled,
    };

    const hiddenSelectors: string[] = [];
    for (const [name, enabled] of Object.entries(flags)) {
        // undefined = no restriction (keep original visibility); hide only when explicitly false
        if (enabled === false) {
            document.body.classList.add(`brand-no-${name}`);
            hiddenSelectors.push(`[data-feature="${name}"]`);
        }
    }

    if (hiddenSelectors.length > 0) {
        const style = document.createElement('style');
        style.id = 'brand-feature-style';
        style.textContent = `${hiddenSelectors.join(',')} { display: none !important; }`;
        document.head.appendChild(style);
    }
}

/**
 * Initialize the brand: read the config and apply it. Should be called as early as
 * possible after i18n initialization. On failure (no backend / parse error) it falls
 * back silently without affecting the original startup.
 */
export async function initBrand(): Promise<BrandConfig | null> {
    let brand: BrandConfig | null = null;
    try {
        brand = await invoke<BrandConfig>('get_brand_config');
    } catch (e) {
        console.warn('[brand] get_brand_config 调用失败，使用核心默认外观:', e);
        return null;
    }
    if (!brand || typeof brand !== 'object') return null;

    cachedBrand = brand;
    applyThemeColors(brand.theme);
    applyThemeMode(brand.theme?.mode);
    applyLanguage(brand.language);
    applyFeatures(brand.features, brand.audio);
    applyTopbarName(brand.app);
    void applyTitle(brand.app);

    document.dispatchEvent(new CustomEvent('brand-loaded', { detail: brand }));
    return brand;
}
