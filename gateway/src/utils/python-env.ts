/**
 * Python 环境管理器
 *
 * 管理 OpenFlux 内置 Python 嵌入式环境的路径和状态检测。
 * Python 环境由 NSIS 安装程序在安装时解压和配置。
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { Logger } from './logger';

const log = new Logger('PythonEnv');

/** Python 环境状态 */
export type PythonEnvStatus = 'ready' | 'not_installed' | 'broken';

/** 环境状态详情 */
export interface PythonEnvInfo {
    status: PythonEnvStatus;
    basePath: string;
    venvPath: string;
    pythonExe: string;
    venvPythonExe: string;
    pipExe: string;
}

/**
 * 获取 Python 环境的根目录
 * 安装后路径: {installDir}/resources/python/
 */
function getInstallDir(): string {
    // Electron 打包后: process.resourcesPath 指向 resources 目录
    // 开发模式: 使用项目根目录下的 resources
    if ((process as any).resourcesPath) {
        return (process as any).resourcesPath;
    }
    // 开发模式回退
    return join(process.cwd(), 'resources');
}

/**
 * 获取 Python 嵌入式包的基础路径
 */
export function getPythonBasePath(): string {
    return join(getInstallDir(), 'python', 'base');
}

/**
 * 获取 Python venv 虚拟环境路径
 */
export function getVenvPath(): string {
    return join(getInstallDir(), 'python', 'venv');
}

/**
 * 获取 Python 环境完整信息
 */
export function getPythonEnvInfo(): PythonEnvInfo {
    const basePath = getPythonBasePath();
    const venvPath = getVenvPath();
    const pythonExe = join(basePath, 'python.exe');
    const venvPythonExe = join(venvPath, 'Scripts', 'python.exe');
    const pipExe = join(venvPath, 'Scripts', 'pip.exe');

    let status: PythonEnvStatus = 'not_installed';

    if (existsSync(pythonExe)) {
        if (existsSync(venvPythonExe) && existsSync(pipExe)) {
            status = 'ready';
        } else {
            status = 'broken'; // 基础包在但 venv 缺失
        }
    }

    return { status, basePath, venvPath, pythonExe, venvPythonExe, pipExe };
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
    switch (info.status) {
        case 'ready':
            log.info('Python environment ready', {
                basePath: info.basePath,
                venvPath: info.venvPath,
            });
            break;
        case 'broken':
            log.warn('Python base package exists but venv missing, some features unavailable', {
                basePath: info.basePath,
            });
            break;
        case 'not_installed':
            log.warn('Python not installed, Python script execution unavailable');
            break;
    }
}

/**
 * 获取 uvx.exe 路径（在 venv/Scripts/ 下）
 */
export function getUvxPath(): string {
    return join(getVenvPath(), 'Scripts', 'uvx.exe');
}

/**
 * 确保内置 Python venv 中已安装 uv（提供 uvx 命令）
 * 如果未安装则自动通过 pip 安装
 */
export async function ensureUv(): Promise<boolean> {
    if (!isPythonReady()) {
        log.warn('Cannot install uv: Python environment not ready');
        return false;
    }

    const uvxExe = getUvxPath();
    if (existsSync(uvxExe)) {
        log.info('uv already installed', { uvxExe });
        return true;
    }

    // 用内置 pip 安装 uv
    const info = getPythonEnvInfo();
    log.info('Installing uv into built-in Python environment...');
    try {
        const { execFileSync } = await import('child_process');
        execFileSync(info.pipExe, ['install', 'uv', '--quiet'], {
            timeout: 120_000,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        });
        if (existsSync(uvxExe)) {
            log.info('uv installed successfully', { uvxExe });
            return true;
        }
        log.error('uv install completed but uvx.exe not found');
        return false;
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error('Failed to install uv', { error: msg });
        return false;
    }
}
