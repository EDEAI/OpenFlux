/**
 * Docker sandbox executor
 * Proxy commands to Docker containers for execution to achieve process-level isolation
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { Logger } from '../../utils/logger';

const execAsync = promisify(exec);
const log = new Logger('DockerExecutor');

export interface DockerExecutorOptions {
    /** Image name, default openflux-sandbox */
    image?: string;
    /** Memory limit, default 512m */
    memoryLimit?: string;
    /** CPU limit, default 1 */
    cpuLimit?: string;
    /** Network mode: none | host | bridge, default none (disconnected) */
    networkMode?: string;
    /** Persistent volume cache mapping: { volumeName: containerPath } */
    cacheVolumes?: Record<string, string>;
    /** Container timeout (seconds), default 60 */
    timeout?: number;
}

export interface DockerExecOptions {
    /** Host working directory (mounted as /workspace in the container) */
    workspaceMount: string;
    /** Environment variables */
    env?: Record<string, string>;
    /** Timeout (milliseconds) */
    timeout?: number;
}

export interface DockerExecResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

/**
 * Docker sandbox executor
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
     * Check if Docker is available (cached results)
     */
    async isAvailable(): Promise<boolean> {
        if (this._available !== null) return this._available;

        try {
            await execAsync('docker info', { timeout: 5000, windowsHide: true });
            this._available = true;
            log.info('Docker available');
        } catch {
            this._available = false;
            log.warn('Docker unavailable, will fall back to local execution');
        }
        return this._available;
    }

    /**
     * Check if the sandbox image exists
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
     * Execute commands in Docker containers
     */
    async exec(command: string, options: DockerExecOptions): Promise<DockerExecResult> {
        const timeout = options.timeout || this.defaultTimeout;

        // Build docker run command
        const args: string[] = [
            'docker', 'run',
            '--rm',                                    // Automatically destroyed after execution
            `--memory=${this.memoryLimit}`,             // memory limit
            `--cpus=${this.cpuLimit}`,                  // CPU Limitations
            `--network=${this.networkMode}`,            // network isolation
            '--security-opt=no-new-privileges',         // No elevation of privileges
            '--pids-limit=256',                         // Limit the number of processes
            '-w', '/workspace',                         // Working directory within the container
        ];

        // Mount working directory (read and write)
        const workspacePath = options.workspaceMount.replace(/\\/g, '/');
        args.push('-v', `${workspacePath}:/workspace`);

        // Mount cache Volume
        for (const [volumeName, containerPath] of Object.entries(this.cacheVolumes)) {
            args.push('-v', `${volumeName}:${containerPath}`);
        }

        // environment variables
        if (options.env) {
            for (const [key, value] of Object.entries(options.env)) {
                args.push('-e', `${key}=${value}`);
            }
        }
        // Default UTF-8 environment
        args.push('-e', 'PYTHONIOENCODING=utf-8');
        args.push('-e', 'PYTHONUTF8=1');

        // Image + command
        args.push(this.image, 'sh', '-c', command);

        const fullCommand = args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ');

        log.debug('Docker execute command', { command: command.slice(0, 100), timeout });

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
                log.warn('Docker container timed out', { timeout });
                return {
                    stdout: error.stdout?.trim() || '',
                    stderr: `Container execution timeout (${timeout}ms)`,
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
