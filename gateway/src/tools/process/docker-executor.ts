/**
 * Docker 沙盒执行器
 * 将命令代理到 Docker 容器内执行，实现进程级隔离
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { Logger } from '../../utils/logger';

const execAsync = promisify(exec);
const log = new Logger('DockerExecutor');

export interface DockerExecutorOptions {
    /** 镜像名，默认 openflux-sandbox */
    image?: string;
    /** 内存限制，默认 512m */
    memoryLimit?: string;
    /** CPU 限制，默认 1 */
    cpuLimit?: string;
    /** 网络模式: none | host | bridge，默认 none（断网） */
    networkMode?: string;
    /** 持久化 volume 缓存映射 { volume名: 容器路径 } */
    cacheVolumes?: Record<string, string>;
    /** 容器超时（秒），默认 60 */
    timeout?: number;
}

export interface DockerExecOptions {
    /** 宿主机工作目录（挂载为容器内 /workspace） */
    workspaceMount: string;
    /** 环境变量 */
    env?: Record<string, string>;
    /** 超时（毫秒） */
    timeout?: number;
}

export interface DockerExecResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

/**
 * Docker 沙盒执行器
 */
export class DockerExecutor {
    private image: string;
    private memoryLimit: string;
    private cpuLimit: string;
    private networkMode: string;
    private cacheVolumes: Record<string, string>;
    private defaultTimeout: number;
    private _available: boolean | null = null;

    constructor(options: DockerExecutorOptions = {}) {
        this.image = options.image || 'openflux-sandbox';
        this.memoryLimit = options.memoryLimit || '512m';
        this.cpuLimit = options.cpuLimit || '1';
        this.networkMode = options.networkMode || 'none';
        this.cacheVolumes = options.cacheVolumes || {};
        this.defaultTimeout = (options.timeout || 60) * 1000;
    }

    /**
     * 检查 Docker 是否可用（缓存结果）
     */
    async isAvailable(): Promise<boolean> {
        if (this._available !== null) return this._available;

        try {
            await execAsync('docker info', { timeout: 5000, windowsHide: true });
            this._available = true;
            log.info('Docker 可用');
        } catch {
            this._available = false;
            log.warn('Docker 不可用，将回退到本地执行');
        }
        return this._available;
    }

    /**
     * 检查沙盒镜像是否存在
     */
    async imageExists(): Promise<boolean> {
        try {
            await execAsync(`docker image inspect ${this.image}`, { timeout: 5000, windowsHide: true });
            return true;
        } catch {
            return false;
        }
    }

    /**
     * 在 Docker 容器中执行命令
     */
    async exec(command: string, options: DockerExecOptions): Promise<DockerExecResult> {
        const timeout = options.timeout || this.defaultTimeout;

        // 构建 docker run 命令
        const args: string[] = [
            'docker', 'run',
            '--rm',                                    // 执行完自动销毁
            `--memory=${this.memoryLimit}`,             // 内存限制
            `--cpus=${this.cpuLimit}`,                  // CPU 限制
            `--network=${this.networkMode}`,            // 网络隔离
            '--security-opt=no-new-privileges',         // 禁止提权
            '--pids-limit=256',                         // 限制进程数
            '-w', '/workspace',                         // 容器内工作目录
        ];

        // 挂载工作目录（读写）
        const workspacePath = options.workspaceMount.replace(/\\/g, '/');
        args.push('-v', `${workspacePath}:/workspace`);

        // 挂载缓存 Volume
        for (const [volumeName, containerPath] of Object.entries(this.cacheVolumes)) {
            args.push('-v', `${volumeName}:${containerPath}`);
        }

        // 环境变量
        if (options.env) {
            for (const [key, value] of Object.entries(options.env)) {
                args.push('-e', `${key}=${value}`);
            }
        }
        // 默认 UTF-8 环境
        args.push('-e', 'PYTHONIOENCODING=utf-8');
        args.push('-e', 'PYTHONUTF8=1');

        // 镜像 + 命令
        args.push(this.image, 'sh', '-c', command);

        const fullCommand = args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ');

        log.debug('Docker 执行命令', { command: command.slice(0, 100), timeout });

        try {
            const { stdout, stderr } = await execAsync(fullCommand, {
                timeout,
                maxBuffer: 10 * 1024 * 1024,
                windowsHide: true,
            });

            return {
                stdout: stdout.trim(),
                stderr: stderr.trim(),
                exitCode: 0,
            };
        } catch (error: any) {
            if (error.killed) {
                log.warn('Docker 容器超时', { timeout });
                return {
                    stdout: error.stdout?.trim() || '',
                    stderr: `容器执行超时（${timeout}ms）`,
                    exitCode: 124,
                };
            }

            return {
                stdout: error.stdout?.trim() || '',
                stderr: error.stderr?.trim() || error.message,
                exitCode: error.code || 1,
            };
        }
    }
}
