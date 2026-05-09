/**
 * Python 环境管理器
 *
 * 管理 OpenFlux 内置 Python 嵌入式环境的路径和状态检测。
 * Python 环境由 NSIS 安装程序在安装时解压和配置：
 *   - {installDir}/python/base/        → embeddable Python 解释器（直接使用，无 venv）
 *   - {installDir}/python/uv.exe       → 包管理器（用于安装/更新包到 base）
 *
 * 设计决策：不使用 venv
 * Python 3.8+ 在 venv 中加载 .pyd 扩展模块时，python311.dll 不在 DLL 搜索路径内，
 * 导致所有 C 扩展（_ctypes、pyexpat、ssl 等）均无法 import。
 * 直接使用 base/python.exe 并将包安装到 base 的 site-packages 可完全避免此问题。
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { Logger } from './logger';

const log = new Logger('PythonEnv');

/** Python 环境状态 */
export type PythonEnvStatus = 'ready' | 'not_installed';

/** 环境状态详情 */
export interface PythonEnvInfo {
    status: PythonEnvStatus;
    basePath: string;
    pythonExe: string;
    uvExe: string;
}

/**
 * 获取 Python 资源目录（python-embed.zip / uv.exe 所在目录）
 *
 * 优先级：
 *   1. 环境变量 OPENFLUX_RESOURCES（开发/测试时手动指定）
 *   2. Tauri 打包后: process.resourcesPath
 *   3. 开发模式: 从当前目录向上查找包含 resources/python/base 的目录
 */
function getInstallDir(): string {
    // 1. 显式环境变量（最高优先级，开发测试用）
    if (process.env.OPENFLUX_RESOURCES) {
        return process.env.OPENFLUX_RESOURCES;
    }

    // 2. Tauri 打包环境：process.resourcesPath 是 $INSTDIR/resources/
    //    Python 由 NSIS 安装到 $INSTDIR/python/base/
    //    所以需要向上一级找到 $INSTDIR，再拼 resources/
    if ((process as any).resourcesPath) {
        const resourcesPath: string = (process as any).resourcesPath;
        // 先检查 resourcesPath 本身下有没有 python（dev bundle 可能直接在 resources 下）
        if (existsSync(join(resourcesPath, 'python', 'base', 'python.exe'))) {
            return resourcesPath;
        }
        // 安装版：$INSTDIR/resources/ -> 上一级是 $INSTDIR，Python 在 $INSTDIR/python/
        const installDir = join(resourcesPath, '..');
        if (existsSync(join(installDir, 'python', 'base', 'python.exe'))) {
            return installDir;
        }
        // fallback: 返回 resourcesPath（让后续向上查找兜底）
        return resourcesPath;
    }

    // 3. 开发模式：从 cwd 向上最多 4 级查找 resources/python/base
    let dir = process.cwd();
    for (let i = 0; i < 4; i++) {
        const candidate = join(dir, 'resources');
        if (existsSync(join(candidate, 'python', 'base', 'python.exe'))) {
            return candidate;
        }
        // 也检查 dir 本身（安装版 gateway cwd = app_data_dir）
        if (existsSync(join(dir, 'python', 'base', 'python.exe'))) {
            return dir;
        }
        const parent = join(dir, '..');
        if (parent === dir) break;  // 到根目录了
        dir = parent;
    }

    // 4. 最终 fallback
    return join(process.cwd(), 'resources');
}

/**
 * 获取 Python 嵌入式包的基础路径
 */
export function getPythonBasePath(): string {
    return join(getInstallDir(), 'python', 'base');
}

/**
 * 获取捆绑的 uv.exe 路径
 */
export function getUvExePath(): string {
    return join(getInstallDir(), 'python', 'uv.exe');
}

/**
 * 获取 Python 解释器路径（直接使用 base/python.exe）
 * 如果 base/python.exe 不存在，尝试 venv/Scripts/python.exe（NSIS 安装版缩距）
 */
export function getPythonExePath(): string {
    const basePy = join(getPythonBasePath(), 'python.exe');
    if (existsSync(basePy)) return basePy;

    // 安装版的 Python 在 venv/ 目录下
    const installDir = getInstallDir();
    const venvPy = join(installDir, 'python', 'venv', 'Scripts', 'python.exe');
    if (existsSync(venvPy)) return venvPy;

    // cwd 向上查找 resources 目录下的 venv
    let dir = process.cwd();
    for (let i = 0; i < 4; i++) {
        const candidate = join(dir, 'resources', 'python', 'venv', 'Scripts', 'python.exe');
        if (existsSync(candidate)) return candidate;
        const candidate2 = join(dir, 'python', 'venv', 'Scripts', 'python.exe');
        if (existsSync(candidate2)) return candidate2;
        const parent = join(dir, '..');
        if (parent === dir) break;
        dir = parent;
    }

    // 最终 fallback （可能不存在）
    return basePy;
}

// ── 旧接口兼容性保留 ──────────────────────────────────────
/** @deprecated 不再使用 venv，请直接用 getPythonExePath() */
export function getVenvPath(): string {
    return getPythonExePath();
}
// ─────────────────────────────────────────────────────────

/**
 * 获取 Python 环境完整信息
 */
export function getPythonEnvInfo(): PythonEnvInfo {
    const basePath = getPythonBasePath();
    const pythonExe = join(basePath, 'python.exe');
    const uvExe = getUvExePath();
    const status: PythonEnvStatus = existsSync(pythonExe) ? 'ready' : 'not_installed';
    return { status, basePath, pythonExe, uvExe };
}

/**
 * 检查 Python 环境是否就绪
 */
export function isPythonReady(): boolean {
    return getPythonEnvInfo().status === 'ready';
}

/**
 * 启动时验证并记录 Python 环境状态
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
 * 验证捆绑的 uv.exe 是否存在
 */
export async function ensureUv(): Promise<boolean> {
    const uvExe = getUvExePath();
    if (existsSync(uvExe)) {
        log.info('Bundled uv.exe found', { uvExe });
        return true;
    }
    log.warn('uv.exe not found in install dir', { uvExe });
    return false;
}

/**
 * 通过内置 uv 向 base Python 安装第三方包（按需调用）
 * 包直接安装到 base/Lib/site-packages，无需 venv。
 *
 * @param packages 包名列表，例如 ['openpyxl', 'requests']
 * @returns 安装结果
 */
export async function uvInstall(packages: string[]): Promise<{ success: boolean; output: string }> {
    if (packages.length === 0) {
        return { success: true, output: 'no packages specified' };
    }

    const uvExe = getUvExePath();
    if (!existsSync(uvExe)) {
        return { success: false, output: `uv.exe not found: ${uvExe}` };
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
