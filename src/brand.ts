/**
 * brand.ts - 可选品牌/主题配置运行时应用层
 *
 * 启动时从 Rust 后端 `get_brand_config` 读取配置（若存在 resources/.brands/brand.json，
 * 否则为内置默认），据此应用：主题色 / 主题模式 / 默认语言 / 语言锁定 / 窗口标题 /
 * 功能显隐 / 音频入口。
 *
 * 设计原则：
 * - 只在用户尚未做过选择（localStorage 为空）时套用默认值，尊重用户偏好。
 * - 功能显隐通过 body class（brand-no-<feature>）+ [data-feature] 选择器双钩子实现，
 *   不写死现有 DOM id，既不破坏原版 UI，也便于后续按需挂载。
 */

import { invoke } from '@tauri-apps/api/core';
import { setLocale, type Locale } from './i18n/index';

export interface BrandConfig {
    brandId?: string;
    app?: {
        productName?: string;
        windowTitle?: string;
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
    features?: {
        scheduler?: boolean;
        wechatIntegration?: boolean;
        showcaseGallery?: boolean;
        codingAgents?: boolean;
        [k: string]: unknown;
    };
    links?: Record<string, string>;
    strings?: Record<string, string>;
    [k: string]: unknown;
}

let cachedBrand: BrandConfig | null = null;

/** 当前已加载的品牌配置（initBrand 完成后可用）。 */
export function getBrand(): BrandConfig | null {
    return cachedBrand;
}

/** 把品牌语言代码（如 zh-CN / zh-TW / en）归一化为内置 Locale。 */
function normalizeLocale(lang?: string): Locale | null {
    if (!lang) return null;
    if (lang.toLowerCase().startsWith('zh')) return 'zh';
    if (lang.toLowerCase().startsWith('en')) return 'en';
    return null;
}

/** 应用主题色（写到 documentElement 内联样式，优先级高于任意主题选择器）。 */
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

/** 应用默认主题模式：仅当用户未手动选择过时生效。 */
function applyThemeMode(mode?: 'dark' | 'light' | 'auto'): void {
    if (!mode || mode === 'auto') return;
    const saved = localStorage.getItem('openflux-theme');
    if (saved) return; // 尊重用户已有选择
    if (mode === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
    } else {
        document.documentElement.removeAttribute('data-theme');
    }
    localStorage.setItem('openflux-theme', mode);
}

/** 应用默认/锁定语言。 */
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

/** 应用窗口标题。 */
async function applyTitle(app?: BrandConfig['app']): Promise<void> {
    const title = app?.windowTitle || app?.productName;
    if (!title) return;
    document.title = title;
    try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await getCurrentWindow().setTitle(title);
    } catch {
        // 非 Tauri 环境（如纯浏览器调试）忽略
    }
}

/**
 * 应用功能显隐。对每个被关闭的功能：
 *   - body 增加 class `brand-no-<feature>`（供 CSS / 业务逻辑判断）
 *   - 注入样式隐藏 `[data-feature="<feature>"]` 的元素
 */
function applyFeatures(features: BrandConfig['features'], audio: BrandConfig['audio']): void {
    const flags: Record<string, boolean | undefined> = {
        scheduler: features?.scheduler,
        wechatIntegration: features?.wechatIntegration,
        showcaseGallery: features?.showcaseGallery,
        codingAgents: features?.codingAgents,
        audioPlayback: audio?.playbackEnabled,
    };

    const hiddenSelectors: string[] = [];
    for (const [name, enabled] of Object.entries(flags)) {
        // undefined = 不限制（保持原版可见）；仅当显式 false 才隐藏
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
 * 初始化品牌：读取配置并套用。应在 i18n 初始化之后尽早调用。
 * 失败（无后端 / 解析异常）时静默回退，不影响原版启动。
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
    void applyTitle(brand.app);

    document.dispatchEvent(new CustomEvent('brand-loaded', { detail: brand }));
    return brand;
}
