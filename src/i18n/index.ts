/**
 * i18n - Internationalization core module
 * Lightweight translation system for OpenFlux client
 */

export type Locale = 'zh' | 'en';

// Current locale
let currentLocale: Locale = 'zh';

// Language packs registry
const messages: Record<Locale, Record<string, string>> = {
    zh: {},
    en: {},
};

/**
 * Translate a key to the current locale.
 * Supports {0} {1} positional placeholders.
 */
export function t(key: string, ...args: (string | number)[]): string {
    const template = messages[currentLocale]?.[key] || messages['en']?.[key] || key;
    if (args.length === 0) return template;
    return template.replace(/\{(\d+)\}/g, (_, i) => String(args[+i] ?? ''));
}

/**
 * Set locale and refresh DOM
 */
export function setLocale(locale: Locale): void {
    currentLocale = locale;
    localStorage.setItem('openflux-locale', locale);
    persistLocaleToDisk(locale);
    applyI18nToDOM();
    document.dispatchEvent(new CustomEvent('locale-changed', { detail: locale }));
}

/**
 * 把语言偏好同步落盘（app_data_dir/ui-locale）：原生启动 splash 先于 WebView
 * 运行、读不到 localStorage，下次启动时从磁盘读取以显示同语言的提示文字。
 * 非 Tauri 环境（纯浏览器调试）静默跳过。
 */
function persistLocaleToDisk(locale: Locale): void {
    import('@tauri-apps/api/core')
        .then(({ invoke }) => invoke('set_locale_pref', { locale }))
        .catch(() => { /* ignore */ });
}

/**
 * Get current locale
 */
export function getLocale(): Locale {
    return currentLocale;
}

/**
 * Initialize i18n: detect user preference or browser language
 */
export function initI18n(zhPack: Record<string, string>, enPack: Record<string, string>): void {
    messages.zh = zhPack;
    messages.en = enPack;

    const saved = localStorage.getItem('openflux-locale') as Locale | null;
    if (saved && (saved === 'zh' || saved === 'en')) {
        currentLocale = saved;
    } else {
        currentLocale = navigator.language.startsWith('zh') ? 'zh' : 'en';
    }
    // 首次启动也落盘一次，保证下次 splash 与实际界面语言一致
    persistLocaleToDisk(currentLocale);
}

/**
 * 服务端（网关 / NexusAI）下发的固定话术 → 本地 i18n key 映射。
 * 网关的进度/提示文案由服务端统一管理且仅有中文；客户端在展示前
 * 用该表按原文精确匹配转成当前界面语言，匹配不到的原样透传
 * （服务端新增话术时最多退化为显示中文，不会报错）。
 */
const SERVER_COPY_KEYS: Record<string, string> = {
    '正在更新供应商密钥...': 'server.updating_provider_keys',
    '正在重载 MCP 服务...': 'server.reloading_mcp',
    '正在连接 MCP 服务...': 'server.connecting_mcp',
    '正在重建 LLM 模型实例...': 'server.rebuilding_llm',
    '正在更新 Embedding 模型...': 'server.updating_embedding',
    'NexusAI access token 已过期，请重新登录': 'server.auth_expired',
    'NexusAI access token 已失效，请重新登录': 'server.auth_expired',
    '当前模型服务尚未初始化，请先完成本地配置。': 'server.model_not_ready',
    '该配置已由企业版内置锁定，不可修改': 'server.config_locked',
    '配置已保存并生效': 'server.config_saved',
    '消息处理失败': 'server.message_failed',
    '未认证': 'server.unauthenticated',
};

/**
 * Translate a fixed server-sent copy to the current locale.
 * Unknown texts are returned unchanged.
 */
export function tServerCopy(text: string): string {
    const key = SERVER_COPY_KEYS[text?.trim()];
    return key ? t(key) : text;
}

/**
 * Batch apply translations to DOM elements with data-i18n attributes.
 * Call after locale change or initial load.
 *
 *   data-i18n="key"             → textContent
 *   data-i18n-placeholder="key" → placeholder
 *   data-i18n-title="key"       → title attribute
 *   data-i18n-html="key"        → innerHTML (use sparingly)
 */
export function applyI18nToDOM(): void {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n')!;
        el.textContent = t(key);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder')!;
        (el as HTMLInputElement).placeholder = t(key);
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
        const key = el.getAttribute('data-i18n-title')!;
        el.setAttribute('title', t(key));
    });
    document.querySelectorAll('[data-i18n-html]').forEach(el => {
        const key = el.getAttribute('data-i18n-html')!;
        el.innerHTML = t(key);
    });
}
