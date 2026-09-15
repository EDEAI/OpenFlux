import { invoke } from '@tauri-apps/api/core';
import { t } from './i18n/index';

// Local preparation state of the Chrome recorder extension. Chrome owns the
// actual installation in each profile; we only prepare the unpacked folder and
// help the user load it. The plugins page renders this state inside the Chrome
// connector card (see buildLocalPluginDefs in main.ts).
let enabled: boolean | null = null;
let extensionPath = '';
let pathError = false;
let statusError = false;
let notify: (kind: 'info' | 'error', message: string) => void = () => {};
let onChange: () => void = () => {};

export interface ChromeExtensionSetup {
    /** null while unknown (backend not queried yet or failed) */
    enabled: boolean | null;
    path: string;
    /** i18n key describing the current state */
    statusKey: string;
    pathError: boolean;
}

export function getChromeExtensionEnabled(): boolean | null {
    return enabled;
}

export function getChromeExtensionSetup(): ChromeExtensionSetup {
    const statusKey = statusError ? 'settings.chrome_ext_status_fail'
        : enabled === null ? 'settings.chrome_ext_status_loading'
            : enabled ? 'settings.chrome_ext_ready' : 'settings.chrome_ext_not_ready';
    return { enabled, path: extensionPath, statusKey, pathError };
}

export function setChromeExtensionEnabled(value: boolean): void {
    enabled = value;
    statusError = false;
    onChange();
}

async function ensurePath(): Promise<boolean> {
    if (extensionPath) return true;
    try {
        extensionPath = await invoke<string>('chrome_extension_path');
        pathError = false;
        onChange();
        return true;
    } catch {
        pathError = true;
        notify('error', t('settings.chrome_ext_path_fail'));
        return false;
    }
}

export async function copyChromeExtensionPath(): Promise<void> {
    if (!(await ensurePath())) return;
    try {
        await navigator.clipboard.writeText(extensionPath);
        notify('info', t('settings.chrome_ext_copied'));
    } catch {
        notify('error', t('settings.chrome_ext_copy_fail'));
    }
}

export async function openChromeExtensionFolder(): Promise<void> {
    if (!(await ensurePath())) return;
    try {
        await invoke('file_open', { filePath: extensionPath });
    } catch {
        notify('error', t('settings.chrome_ext_open_fail'));
    }
}

/** Copies the unpacked folder path and opens chrome://extensions in the user's Chrome. */
export async function openChromeExtensionSettings(): Promise<void> {
    await copyChromeExtensionPath();
    try {
        await invoke('chrome_extension_open_settings');
    } catch (error) {
        notify('error', t('settings.chrome_ext_settings_fail') + ': ' + String(error));
    }
}

/** Query the backend once at startup; `onStatusChange` fires whenever the state or path changes. */
export async function initChromeExtensionSettings(
    onStatusChange: () => void,
    onNotify: typeof notify,
): Promise<void> {
    notify = onNotify;
    onChange = onStatusChange;
    const [path, status] = await Promise.allSettled([
        invoke<string>('chrome_extension_path'),
        invoke<boolean>('chrome_extension_status'),
    ]);
    if (path.status === 'fulfilled') {
        extensionPath = path.value;
        pathError = false;
    } else {
        console.error('[ChromeExt] Cannot resolve extension path:', path.reason);
        pathError = true;
    }
    if (status.status === 'fulfilled') {
        enabled = status.value;
        statusError = false;
    } else {
        console.error('[ChromeExt] Cannot query extension state:', status.reason);
        statusError = true;
    }
    onChange();
}
