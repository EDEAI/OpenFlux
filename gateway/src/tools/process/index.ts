/**
 * 进程/命令工具 - 工厂模式
 * 支持本地执行和 Docker 沙盒隔离执行
 */

import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { mkdirSync, existsSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import type { AnyTool, ToolResult } from '../types';
import {
    readStringParam,
    readNumberParam,
    readBooleanParam,
    readStringArrayParam,
    validateAction,
    jsonResult,
    errorResult,
} from '../common';
import { snapshotDirectory, diffSnapshots, type GeneratedFile } from '../../utils/file-snapshot';
import { DockerExecutor, type DockerExecutorOptions } from './docker-executor';
import { Logger } from '../../utils/logger';

const execAsync = promisify(exec);
const log = new Logger('ProcessTool');

// 支持的动作
const PROCESS_ACTIONS = [
    'run',       // 运行命令并等待结果
    'spawn',     // 启动后台进程
    'shell',     // 在 shell 中执行
] as const;

type ProcessAction = (typeof PROCESS_ACTIONS)[number];

// 危险命令列表（完整命令匹配 + 前缀匹配）
const DANGEROUS_COMMANDS = [
    // 文件系统破坏（通用）
    'rm -rf /',
    'rm -rf /*',
    ':(){:|:&};:',  // fork bomb
    // Windows 文件系统破坏
    'del /s /q c:\\',
    'format c:',
    'format d:',
    'rd /s /q c:\\',
    // Windows 系统操作
    'shutdown /s',
    'shutdown /r',
    'shutdown /f',
    // Windows 注册表破坏
    'reg delete hklm',
    'reg delete hkcu',
    'reg delete hkcr',
    // Windows 服务操作
    'sc delete',
    'sc stop',
    'net stop',
    // Windows 磁盘操作
    'diskpart',
    'bcdedit',
    // Windows 引导破坏
    'bootrec',
    'bcdboot',
    // macOS 危险命令
    'sudo rm -rf /',
    'sudo rm -rf /*',
    'diskutil eraseDisk',
    'diskutil eraseVolume',
    'sudo shutdown',
    'sudo halt',
    'sudo reboot',
    'csrutil disable',
];

// 高危命令前缀（模糊匹配）
const DANGEROUS_PREFIXES = [
    // Windows
    'format ',
    'rd /s',
    'rmdir /s',
    'del /s',
    'reg delete',
    'cipher /w',
    'sfc ',
    'dism ',
    'netsh advfirewall',
    'takeown /f c:\\',
    'icacls c:\\ ',
    // macOS
    'sudo rm -rf',
    'sudo diskutil',
    'sudo launchctl unload',
    'sudo nvram',
    'sudo pmset',
    'sudo systemsetup',
    'sudo spctl --master-disable',
];

export interface ProcessToolOptions {
    /** 命令超时时间（毫秒） */
    timeout?: number;
    /** 最大输出缓冲区（字节） */
    maxBuffer?: number;
    /** 工作目录（支持动态函数，每次执行时获取最新值） */
    cwd?: string | (() => string);
    /** 是否允许危险命令 */
    allowDangerous?: boolean;
    /** 命令黑名单 */
    blockedCommands?: string[];
    /** 命令白名单（设置后只允许这些命令前缀） */
    allowedCommands?: string[];
    /** 允许的工作目录范围（cwd 必须在此范围内） */
    allowedCwdPaths?: string[];
    /** Docker 沙盒配置（设置后命令在容器内执行） */
    docker?: DockerExecutorOptions;
}

/**
 * 创建进程/命令工具
 */
export function createProcessTool(opts: ProcessToolOptions = {}): AnyTool {
    const {
        timeout = 30000,
        maxBuffer = 10 * 1024 * 1024, // 10MB
        cwd,
        allowDangerous = false,
        blockedCommands = [],
        allowedCommands,
        allowedCwdPaths,
    } = opts;

    // Docker 执行器（延迟初始化）
    let dockerExecutor: DockerExecutor | null = null;
    let dockerAvailable: boolean | null = null;

    if (opts.docker) {
        dockerExecutor = new DockerExecutor(opts.docker);
    }

    /**
     * 检查 Docker 是否可用（带缓存）
     */
    async function checkDockerAvailable(): Promise<boolean> {
        if (!dockerExecutor) return false;
        if (dockerAvailable !== null) return dockerAvailable;
        dockerAvailable = await dockerExecutor.isAvailable();
        if (dockerAvailable) {
            const hasImage = await dockerExecutor.imageExists();
            if (!hasImage) {
                log.warn(`Docker 镜像 '${opts.docker?.image || 'openflux-sandbox'}' 不存在，请先构建镜像`);
                dockerAvailable = false;
            }
        }
        return dockerAvailable;
    }

    // 命令安全检查
    function checkCommand(command: string): void {
        const lowerCmd = command.toLowerCase().trim();

        // 1. 白名单模式（最严格）
        if (allowedCommands && allowedCommands.length > 0) {
            const allowed = allowedCommands.some(
                ac => lowerCmd.startsWith(ac.toLowerCase())
            );
            if (!allowed) {
                throw new Error(
                    `命令不在白名单中: ${command}\n允许的命令: ${allowedCommands.join(', ')}`
                );
            }
        }

        // 2. 黑名单检查
        if (!allowDangerous) {
            // 完整匹配
            for (const dangerous of DANGEROUS_COMMANDS) {
                if (lowerCmd.includes(dangerous.toLowerCase())) {
                    throw new Error(`危险命令被阻止: ${command}`);
                }
            }
            // 前缀匹配
            for (const prefix of DANGEROUS_PREFIXES) {
                if (lowerCmd.startsWith(prefix.toLowerCase())) {
                    throw new Error(`危险命令被阻止: ${command}`);
                }
            }
        }

        // 3. 自定义黑名单
        for (const blocked of blockedCommands) {
            if (lowerCmd.includes(blocked.toLowerCase())) {
                throw new Error(`命令被阻止: ${command}`);
            }
        }
    }

    /**
     * cwd 安全检查：确保工作目录在允许范围内
     */
    function checkCwd(workDir: string | undefined): void {
        if (!workDir || !allowedCwdPaths || allowedCwdPaths.length === 0) return;

        const normalizedCwd = workDir.toLowerCase().replace(/\//g, '\\');
        const defaultBase = typeof cwd === 'function' ? cwd() : (cwd || process.cwd());
        const allowed = allowedCwdPaths.some(
            p => {
                const resolved = isAbsolute(p) ? p : resolve(defaultBase, p);
                return normalizedCwd.startsWith(resolved.toLowerCase().replace(/\//g, '\\'));
            }
        );
        if (!allowed) {
            const resolvedHints = allowedCwdPaths.map(p => {
                return isAbsolute(p) ? p : resolve(defaultBase, p);
            });
            throw new Error(
                `工作目录不在允许范围内: ${workDir}\n允许的目录: ${resolvedHints.join(', ')}`
            );
        }
    }

    return {
        name: 'process',
        description: `进程和命令执行工具。支持的动作: ${PROCESS_ACTIONS.join(', ')}`,
        parameters: {
            action: {
                type: 'string',
                description: `操作类型: ${PROCESS_ACTIONS.join('/')}`,
                required: true,
                enum: [...PROCESS_ACTIONS],
            },
            command: {
                type: 'string',
                description: '要执行的命令',
                required: true,
            },
            args: {
                type: 'array',
                description: '命令参数数组（spawn 动作使用）',
            },
            cwd: {
                type: 'string',
                description: '工作目录',
            },
            timeout: {
                type: 'number',
                description: '超时时间（毫秒）',
            },
            env: {
                type: 'object',
                description: '环境变量',
            },
        },

        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
            const action = validateAction(args, PROCESS_ACTIONS);
            const command = readStringParam(args, 'command', { required: true, label: 'command' });
            const defaultCwd = typeof cwd === 'function' ? cwd() : cwd;
            const workDir = readStringParam(args, 'cwd') || defaultCwd;
            const cmdTimeout = readNumberParam(args, 'timeout', { integer: true }) || timeout;

            // 确保工作目录存在
            if (workDir && !existsSync(workDir)) {
                try { mkdirSync(workDir, { recursive: true }); } catch { /* ignore */ }
            }

            // 安全检查
            checkCommand(command);
            checkCwd(workDir);

            // Windows UTF-8 编码支持
            const isWindows = process.platform === 'win32';
            const utf8Env = isWindows ? {
                ...process.env,
                PYTHONIOENCODING: 'utf-8',
                PYTHONUTF8: '1',
            } : process.env;
            // Windows 下给单行命令加 chcp 65001 前缀
            const wrapCommand = (cmd: string): string => {
                if (isWindows && !cmd.includes('\n') && !cmd.startsWith('chcp ')) {
                    return `chcp 65001 > nul && ${cmd}`;
                }
                return cmd;
            };

            // 检查是否使用 Docker 执行
            const useDocker = action !== 'spawn' && await checkDockerAvailable();

            switch (action) {
                // 运行命令并等待结果
                case 'run': {
                    // Docker 模式
                    if (useDocker && dockerExecutor) {
                        try {
                            // 文件变更检测：执行前快照
                            const snapshotDir = workDir || process.cwd();
                            let beforeSnapshot;
                            try { beforeSnapshot = await snapshotDirectory(snapshotDir); } catch { /* ignore */ }

                            const result = await dockerExecutor.exec(command, {
                                workspaceMount: workDir || process.cwd(),
                                timeout: cmdTimeout,
                            });

                            // 文件变更检测
                            let generatedFiles: GeneratedFile[] | undefined = undefined;
                            if (beforeSnapshot) {
                                try {
                                    const afterSnapshot = await snapshotDirectory(snapshotDir);
                                    generatedFiles = diffSnapshots(beforeSnapshot, afterSnapshot);
                                } catch { /* ignore */ }
                            }

                            return jsonResult({
                                command,
                                stdout: result.stdout,
                                stderr: result.stderr,
                                exitCode: result.exitCode,
                                sandbox: 'docker',
                                ...(generatedFiles?.length ? { generatedFiles } : {}),
                            });
                        } catch (error: any) {
                            return errorResult(`Docker 执行失败: ${error.message}`);
                        }
                    }

                    // 本地模式
                    const snapshotDir = workDir || process.cwd();
                    let beforeSnapshot;
                    try {
                        beforeSnapshot = await snapshotDirectory(snapshotDir);
                    } catch { /* ignore */ }

                    try {
                        const { stdout, stderr } = await execAsync(wrapCommand(command), {
                            cwd: workDir,
                            timeout: cmdTimeout,
                            maxBuffer,
                            windowsHide: true,
                            env: utf8Env,
                        });

                        let generatedFiles: GeneratedFile[] | undefined = undefined;
                        if (beforeSnapshot) {
                            try {
                                const afterSnapshot = await snapshotDirectory(snapshotDir);
                                generatedFiles = diffSnapshots(beforeSnapshot, afterSnapshot);
                            } catch { /* ignore */ }
                        }

                        return jsonResult({
                            command,
                            stdout: stdout.trim(),
                            stderr: stderr.trim(),
                            exitCode: 0,
                            sandbox: 'local',
                            ...(generatedFiles?.length ? { generatedFiles } : {}),
                        });
                    } catch (error: any) {
                        if (error.killed) {
                            return errorResult(`命令超时（${cmdTimeout}ms）`);
                        }

                        let generatedFiles: GeneratedFile[] | undefined = undefined;
                        if (beforeSnapshot) {
                            try {
                                const afterSnapshot = await snapshotDirectory(snapshotDir);
                                generatedFiles = diffSnapshots(beforeSnapshot, afterSnapshot);
                            } catch { /* ignore */ }
                        }

                        return jsonResult({
                            command,
                            stdout: error.stdout?.trim() || '',
                            stderr: error.stderr?.trim() || error.message,
                            exitCode: error.code || 1,
                            error: error.message,
                            sandbox: 'local',
                            ...(generatedFiles?.length ? { generatedFiles } : {}),
                        });
                    }
                }

                // 启动后台进程（始终本地执行）
                case 'spawn': {
                    const cmdArgs = readStringArrayParam(args, 'args') || [];
                    try {
                        const child = spawn(command, cmdArgs, {
                            cwd: workDir,
                            detached: true,
                            stdio: 'ignore',
                            windowsHide: true,
                        });
                        child.unref();
                        return jsonResult({
                            command,
                            args: cmdArgs,
                            pid: child.pid,
                            spawned: true,
                        });
                    } catch (error: any) {
                        return errorResult(`启动进程失败: ${error.message}`);
                    }
                }

                // 在 shell 中执行
                case 'shell': {
                    // Docker 模式
                    if (useDocker && dockerExecutor) {
                        try {
                            const result = await dockerExecutor.exec(command, {
                                workspaceMount: workDir || process.cwd(),
                                timeout: cmdTimeout,
                            });
                            return jsonResult({
                                command,
                                stdout: result.stdout,
                                stderr: result.stderr,
                                exitCode: result.exitCode,
                                sandbox: 'docker',
                            });
                        } catch (error: any) {
                            return errorResult(`Docker 执行失败: ${error.message}`);
                        }
                    }

                    // 本地模式
                    try {
                        const { stdout, stderr } = await execAsync(wrapCommand(command), {
                            cwd: workDir,
                            timeout: cmdTimeout,
                            maxBuffer,
                            shell: isWindows ? 'cmd.exe' : '/bin/sh',
                            windowsHide: true,
                            env: utf8Env,
                        });
                        return jsonResult({
                            command,
                            stdout: stdout.trim(),
                            stderr: stderr.trim(),
                            exitCode: 0,
                            sandbox: 'local',
                        });
                    } catch (error: any) {
                        return jsonResult({
                            command,
                            stdout: error.stdout?.trim() || '',
                            stderr: error.stderr?.trim() || error.message,
                            exitCode: error.code || 1,
                            sandbox: 'local',
                        });
                    }
                }

                default:
                    return errorResult(`未知动作: ${action}`);
            }
        },
    };
}
