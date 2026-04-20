/**
 * OpenCode 编码工具 - 工厂模式
 */

import { spawn } from 'child_process';
import { mkdirSync, existsSync } from 'fs';
import type { AnyTool, ToolResult } from '../types';
import {
    readStringParam,
    readNumberParam,
    readBooleanParam,
    validateAction,
    jsonResult,
    errorResult,
} from '../common';
import { snapshotDirectory, diffSnapshots } from '../../utils/file-snapshot';

// 支持的动作
const OPENCODE_ACTIONS = [
    'status',   // 检查 OpenCode 状态
    'run',      // 运行编码任务
    'fix',      // 修复代码错误
    'explain',  // 解释代码
    'refactor', // 重构代码
] as const;

type OpenCodeAction = (typeof OPENCODE_ACTIONS)[number];

export interface OpenCodeToolOptions {
    /** OpenCode 可执行文件路径 */
    executable?: string;
    /** 工作目录（支持动态函数，每次执行时获取最新值） */
    cwd?: string | (() => string);
    /** 超时时间（毫秒） */
    timeout?: number;
    /** 是否自动批准操作 */
    autoApprove?: boolean;
}

/**
 * 创建 OpenCode 编码工具
 */
export function createOpenCodeTool(opts: OpenCodeToolOptions = {}): AnyTool {
    const {
        executable = 'opencode',
        cwd,
        timeout = 300000, // 5 分钟
        autoApprove = false,
    } = opts;

    // 执行 OpenCode 命令
    async function runOpenCode(args: string[], workDir?: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
        return new Promise((resolve) => {
            const proc = spawn(executable, args, {
                cwd: (workDir || cwd) as string,
                shell: true,
                windowsHide: true,
            });

            let stdout = '';
            let stderr = '';

            if (proc.stdout) {
                proc.stdout.on('data', (data) => {
                    stdout += data.toString();
                });
            }

            if (proc.stderr) {
                proc.stderr.on('data', (data) => {
                    stderr += data.toString();
                });
            }

            const timer = setTimeout(() => {
                proc.kill();
                resolve({ stdout, stderr: stderr + '\n[Timeout]', exitCode: -1 });
            }, timeout);

            proc.on('close', (code) => {
                clearTimeout(timer);
                resolve({ stdout, stderr, exitCode: code || 0 });
            });

            proc.on('error', (err) => {
                clearTimeout(timer);
                resolve({ stdout, stderr: err.message, exitCode: -1 });
            });
        });
    }

    return {
        name: 'opencode',
        priority: 50,
        description: `OpenCode coding tool. Supported actions: ${OPENCODE_ACTIONS.join(', ')}`,
        parameters: {
            action: {
                type: 'string',
                description: `Action type: ${OPENCODE_ACTIONS.join('/')}`,
                required: true,
                enum: [...OPENCODE_ACTIONS],
            },
            prompt: {
                type: 'string',
                description: 'Coding task description or question',
            },
            file: {
                type: 'string',
                description: 'Target file path',
            },
            code: {
                type: 'string',
                description: 'Code content',
            },
            cwd: {
                type: 'string',
                description: 'Working directory',
            },
            autoApprove: {
                type: 'boolean',
                description: 'Whether to auto-approve operations',
                default: false,
            },
        },

        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
            const action = validateAction(args, OPENCODE_ACTIONS);
            const defaultCwd = typeof cwd === 'function' ? cwd() : cwd;
            const workDir = readStringParam(args, 'cwd') || defaultCwd;
            const shouldAutoApprove = readBooleanParam(args, 'autoApprove', autoApprove);

            // 确保工作目录存在
            if (workDir && !existsSync(workDir)) {
                try { mkdirSync(workDir, { recursive: true }); } catch { /* ignore */ }
            }

            switch (action) {
                // 检查 OpenCode 状态
                case 'status': {
                    try {
                        const result = await runOpenCode(['--version'], workDir);
                        if (result.exitCode === 0) {
                            return jsonResult({
                                available: true,
                                version: result.stdout.trim(),
                            });
                        }
                        return jsonResult({
                            available: false,
                            error: result.stderr || 'OpenCode not installed or unavailable',
                        });
                    } catch (error: any) {
                        return jsonResult({
                            available: false,
                            error: error.message,
                        });
                    }
                }

                // 运行编码任务
                case 'run': {
                    const prompt = readStringParam(args, 'prompt', { required: true, label: 'prompt' });
                    const cmdArgs = [prompt];
                    if (shouldAutoApprove) {
                        cmdArgs.unshift('--yes');
                    }

                    // 文件变更检测：执行前快照
                    const snapshotDir = workDir || process.cwd();
                    let beforeSnapshot;
                    try {
                        beforeSnapshot = await snapshotDirectory(snapshotDir);
                    } catch { /* ignore */ }

                    try {
                        const result = await runOpenCode(cmdArgs, workDir);

                        // 文件变更检测：执行后对比
                        let generatedFiles;
                        if (beforeSnapshot) {
                            try {
                                const afterSnapshot = await snapshotDirectory(snapshotDir);
                                generatedFiles = diffSnapshots(beforeSnapshot, afterSnapshot);
                            } catch { /* ignore */ }
                        }

                        return jsonResult({
                            prompt,
                            stdout: result.stdout,
                            stderr: result.stderr,
                            exitCode: result.exitCode,
                            success: result.exitCode === 0,
                            ...(generatedFiles?.length ? { generatedFiles } : {}),
                        });
                    } catch (error: any) {
                        return errorResult(`Execution failed: ${error.message}`);
                    }
                }

                // 修复代码错误
                case 'fix': {
                    const file = readStringParam(args, 'file', { required: true, label: 'file' });
                    const prompt = readStringParam(args, 'prompt') || 'Fix errors in the code';
                    const cmdArgs = ['fix', file, prompt];
                    if (shouldAutoApprove) {
                        cmdArgs.unshift('--yes');
                    }
                    try {
                        const result = await runOpenCode(cmdArgs, workDir);
                        return jsonResult({
                            file,
                            prompt,
                            stdout: result.stdout,
                            stderr: result.stderr,
                            exitCode: result.exitCode,
                            success: result.exitCode === 0,
                        });
                    } catch (error: any) {
                        return errorResult(`Fix failed: ${error.message}`);
                    }
                }

                // 解释代码
                case 'explain': {
                    const file = readStringParam(args, 'file');
                    const code = readStringParam(args, 'code');
                    if (!file && !code) {
                        return errorResult('Either file or code parameter is required');
                    }
                    const cmdArgs = ['explain'];
                    if (file) {
                        cmdArgs.push(file);
                    }
                    try {
                        const result = await runOpenCode(cmdArgs, workDir);
                        return jsonResult({
                            file,
                            explanation: result.stdout,
                            exitCode: result.exitCode,
                        });
                    } catch (error: any) {
                        return errorResult(`Explanation failed: ${error.message}`);
                    }
                }

                // 重构代码
                case 'refactor': {
                    const file = readStringParam(args, 'file', { required: true, label: 'file' });
                    const prompt = readStringParam(args, 'prompt') || 'Optimize and refactor code';
                    const cmdArgs = ['refactor', file, prompt];
                    if (shouldAutoApprove) {
                        cmdArgs.unshift('--yes');
                    }
                    try {
                        const result = await runOpenCode(cmdArgs, workDir);
                        return jsonResult({
                            file,
                            prompt,
                            stdout: result.stdout,
                            stderr: result.stderr,
                            exitCode: result.exitCode,
                            success: result.exitCode === 0,
                        });
                    } catch (error: any) {
                        return errorResult(`Refactoring failed: ${error.message}`);
                    }
                }

                default:
                    return errorResult(`Unknown action: ${action}`);
            }
        },
    };
}
