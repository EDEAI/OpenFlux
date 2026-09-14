import { invoke } from '@tauri-apps/api/core';
import { t } from './i18n/index';

// This is the local preparation state. Chrome owns installation in each profile.
let enabled: boolean | null = null;
let extensionPath = '';
let notify: (kind: 'info' | 'error', message: string) => void = () => {};

export function getChromeExtensionEnabled(): boolean | null {
    return enabled;
}

export function setChromeExtensionEnabled(value: boolean): void {
    enabled = value;
    const status = document.getElementById('chrome-ext-status');
    if (status) {
        const key = value ? 'settings.chrome_ext_ready' : 'settings.chrome_ext_not_ready';
        status.dataset.i18n = key;
        status.textContent = t(key);
    }
}

async function copyExtensionPath(): Promise<void> {
    if (!extensionPath) {
        try {
            updateExtensionPath(await invoke<string>('chrome_extension_path'));
        } catch {
            notify('error', t('settings.chrome_ext_path_fail'));
            return;
        }
    }
    try {
        await navigator.clipboard.writeText(extensionPath);
        notify('info', t('settings.chrome_ext_copied'));
    } catch {
        notify('error', t('settings.chrome_ext_copy_fail'));
    }
}

function updateExtensionPath(path: string): void {
    extensionPath = path;
    const input = document.getElementById('chrome-ext-path') as HTMLInputElement | null;
    if (input) input.value = input.title = path;
    for (const id of ['chrome-ext-path-copy', 'chrome-ext-path-open']) {
        const button = document.getElementById(id) as HTMLButtonElement | null;
        if (button) button.disabled = false;
    }
}

export async function openChromeExtensionSettings(): Promise<void> {
    await copyExtensionPath();
    try {
        await invoke('chrome_extension_open_settings');
    } catch (error) {
        notify('error', t('settings.chrome_ext_settings_fail') + ': ' + String(error));
    }
}

export async function initChromeExtensionSettings(
    onStatusChange: () => void,
    onNotify: typeof notify,
): Promise<void> {
    notify = onNotify;
    const input = document.getElementById('chrome-ext-path') as HTMLInputElement | null;
    const copy = document.getElementById('chrome-ext-path-copy') as HTMLButtonElement | null;
    const open = document.getElementById('chrome-ext-path-open') as HTMLButtonElement | null;
    if (copy) copy.disabled = true;
    if (open) open.disabled = true;
    copy?.addEventListener('click', () => { void copyExtensionPath(); });
    open?.addEventListener('click', async () => {
        if (!extensionPath) return;
        try {
            await invoke('file_open', { filePath: extensionPath });
        } catch {
            notify('error', t('settings.chrome_ext_open_fail'));
        }
    });
    document.getElementById('chrome-ext-settings-open')?.addEventListener('click', () => {
        void openChromeExtensionSettings();
    });

    const results = await Promise.allSettled([
        invoke<string>('chrome_extension_path'),
        invoke<boolean>('chrome_extension_status'),
    ]);
    const [path, status] = results;
    if (path.status === 'fulfilled') {
        updateExtensionPath(path.value);
    } else {
        console.error('[ChromeExt] Cannot resolve extension path:', path.reason);
        if (input) {
            input.dataset.i18nPlaceholder = 'settings.chrome_ext_path_fail';
            input.placeholder = t('settings.chrome_ext_path_fail');
        }
    }
    if (status.status === 'fulfilled') {
        setChromeExtensionEnabled(status.value);
        onStatusChange();
    } else {
        console.error('[ChromeExt] Cannot query extension state:', status.reason);
        const statusEl = document.getElementById('chrome-ext-status');
        if (statusEl) {
            statusEl.dataset.i18n = 'settings.chrome_ext_status_fail';
            statusEl.textContent = t('settings.chrome_ext_status_fail');
        }
    }
}
