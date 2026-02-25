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
            log.info('Python 环境就绪', {
                basePath: info.basePath,
                venvPath: info.venvPath,
            });
            break;
        case 'broken':
            log.warn('Python 基础包存在但 venv 缺失，部分功能不可用', {
                basePath: info.basePath,
            });
            break;
        case 'not_installed':
            log.warn('Python 环境未安装，Python 脚本执行功能不可用');
            break;
    }
}
