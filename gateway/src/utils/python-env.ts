/**
 * Python environment manager
 *
 * Manage path and state detection of OpenFlux's built-in Python environment.
 *
 * Windows layout (prepared by the NSIS installer):
 *   - {installDir}/python/base/python.exe
 *   - {installDir}/python/uv.exe
 *
 * macOS layout (extracted by the Tauri host on first launch):
 *   - {appDataDir}/python/base/bin/python3
 *
 * Design Decision: Not using venv
 * When Python 3.8+ loads the.pyd extension module in venv, python311.dll is not in the DLL search path.
 * As a result, all C extensions (_ctypes, pyexpat, ssl, etc.) cannot be imported.
 * Using base/python.exe directly and installing the package to base's site-packages avoids this problem entirely.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { Logger } from './logger';

const log = new Logger('PythonEnv');

function pythonCandidates(root: string): string[] {
    if (process.platform === 'win32') {
        return [
            join(root, 'python', 'base', 'python.exe'),
            join(root, 'python', 'venv', 'Scripts', 'python.exe'),
        ];
    }

    return [
        join(root, 'python', 'base', 'bin', 'python3'),
        join(root, 'python', 'base', 'bin', 'python'),
        join(root, 'python', 'bin', 'python3'),
        join(root, 'python', 'bin', 'python'),
    ];
}

function uvCandidates(root: string): string[] {
    if (process.platform === 'win32') {
        return [join(root, 'python', 'uv.exe')];
    }

    return [
        join(root, 'python', 'uv'),
        join(root, 'python', 'base', 'bin', 'uv'),
    ];
}

function firstExisting(candidates: string[]): string | undefined {
    return candidates.find((candidate) => existsSync(candidate));
}

function hasPythonRuntime(root: string): boolean {
    return firstExisting(pythonCandidates(root)) !== undefined;
}

/** Python environment status */
export type PythonEnvStatus = 'ready' | 'not_installed';

/** Environmental status details */
export interface PythonEnvInfo {
    status: PythonEnvStatus;
    basePath: string;
    pythonExe: string;
    uvExe: string;
}

/**
 * Get the root directory that contains the extracted/installed `python` folder.
 *
 * Priority:
 *   1. Environment variable OPENFLUX_RESOURCES (manually specified during development/testing)
 *   2. After Tauri is packaged: process.resourcesPath
 *   3. Development mode: Search upward from the current directory
 */
function getInstallDir(): string {
    // 1. Explicit environment variables (highest priority, used for development and testing)
    if (process.env.OPENFLUX_RESOURCES) {
        return process.env.OPENFLUX_RESOURCES;
    }

    // 2. Tauri packaging environment: process.resourcesPath is $INSTDIR/resources/
    //    Python is installed by NSIS into $INSTDIR/python/base/
    //    So you need to go up one level to find $INSTDIR, and then spell resources/
    if ((process as any).resourcesPath) {
        const resourcesPath: string = (process as any).resourcesPath;
        if (hasPythonRuntime(resourcesPath)) {
            return resourcesPath;
        }
        const installDir = join(resourcesPath, '..');
        if (hasPythonRuntime(installDir)) {
            return installDir;
        }
        return resourcesPath;
    }

    // 3. Development mode and extracted sidecar runtime.
    let dir = process.cwd();
    for (let i = 0; i < 4; i++) {
        const candidate = join(dir, 'resources');
        if (hasPythonRuntime(candidate)) {
            return candidate;
        }
        if (hasPythonRuntime(dir)) {
            return dir;
        }
        const parent = join(dir, '..');
        if (parent === dir) break;  // Reached the root directory
        dir = parent;
    }

    // 4. Final fallback
    return join(process.cwd(), 'resources');
}

/**
 * Get the base path of Python embedded packages
 */
export function getPythonBasePath(): string {
    return join(getInstallDir(), 'python', 'base');
}

/**
 * Get bundled uv.exe path
 */
export function getUvExePath(): string {
    const candidates = uvCandidates(getInstallDir());
    return firstExisting(candidates) ?? candidates[0];
}

/**
 * Get the Python interpreter path (use base/python.exe directly)
 * If base/python.exe does not exist, try venv/Scripts/python.exe (NSIS installation reduced version)
 */
export function getPythonExePath(): string {
    const installDir = getInstallDir();
    const candidates = pythonCandidates(installDir);
    return firstExisting(candidates) ?? candidates[0];
}

// ── Old interface compatibility retained ──────────────────────────────────────
/** @deprecated no longer uses venv, please use getPythonExePath() directly */
export function getVenvPath(): string {
    return getPythonExePath();
}
// ─────────────────────────────────────────────────────────

/**
 * Get complete information about the Python environment
 */
export function getPythonEnvInfo(): PythonEnvInfo {
    const basePath = getPythonBasePath();
    const pythonExe = getPythonExePath();
    const uvExe = getUvExePath();
    const status: PythonEnvStatus = existsSync(pythonExe) ? 'ready' : 'not_installed';
    return { status, basePath, pythonExe, uvExe };
}

/**
 * Check if the Python environment is ready
 */
export function isPythonReady(): boolean {
    return getPythonEnvInfo().status === 'ready';
}

/**
 * Verify and log Python environment status on startup
 */
export function logPythonEnvStatus(): void {
    const info = getPythonEnvInfo();
    if (info.status === 'ready') {
        log.info('Python environment ready', {
            basePath: info.basePath,
            uvAvailable: existsSync(info.uvExe),
        });
    } else {
        log.warn('Bundled Python not found (expected after install)', {
            basePath: info.basePath,
        });
    }
}

/**
 * Verify that bundled uv exists
 */
export async function ensureUv(): Promise<boolean> {
    const uvExe = getUvExePath();
    if (existsSync(uvExe)) {
        log.info('Bundled uv found', { uvExe });
        return true;
    }
    log.warn('Bundled uv not found in install dir', { uvExe });
    return false;
}

/**
 * Install third-party packages to base Python through built-in uv (call on demand)
 * Packages are installed directly into base/Lib/site-packages, no venv is required.
 *
 * @param packages package name list, for example ['openpyxl', 'requests']
 * @returns installation results
 */
export async function uvInstall(packages: string[]): Promise<{ success: boolean; output: string }> {
    if (packages.length === 0) {
        return { success: true, output: 'no packages specified' };
    }

    const uvExe = getUvExePath();
    if (!existsSync(uvExe)) {
        return { success: false, output: `uv not found: ${uvExe}` };
    }

    const info = getPythonEnvInfo();
    if (info.status !== 'ready') {
        return { success: false, output: 'Python not installed' };
    }

    log.info('Installing Python packages via uv', { packages });

    try {
        const { execFileSync } = await import('child_process');
        const output = execFileSync(uvExe, [
            'pip', 'install', ...packages,
            '--python', info.pythonExe,
            '--quiet',
        ], {
            timeout: 180_000,
            windowsHide: true,
            encoding: 'utf-8',
            env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        });
        log.info('Packages installed successfully', { packages });
        return { success: true, output: output || 'installed' };
    } catch (err: any) {
        const msg = err.stderr || err.stdout || err.message || String(err);
        log.error('Failed to install packages via uv', { packages, error: msg });
        return { success: false, output: msg };
    }
}
