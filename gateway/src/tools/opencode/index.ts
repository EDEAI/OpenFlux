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
                resolve({ stdout, stderr: stderr + '\n[超时]', exitCode: -1 });
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
        description: `OpenCode 编码工具。支持的动作: ${OPENCODE_ACTIONS.join(', ')}`,
        parameters: {
            action: {
                type: 'string',
                description: `操作类型: ${OPENCODE_ACTIONS.join('/')}`,
                required: true,
                enum: [...OPENCODE_ACTIONS],
            },
            prompt: {
                type: 'string',
                description: '编码任务描述或问题',
            },
            file: {
                type: 'string',
                description: '目标文件路径',
            },
            code: {
                type: 'string',
                description: '代码内容',
            },
            cwd: {
                type: 'string',
                description: '工作目录',
            },
            autoApprove: {
                type: 'boolean',
                description: '是否自动批准操作',
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
                            error: result.stderr || 'OpenCode 未安装或不可用',
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
                        return errorResult(`执行失败: ${error.message}`);
                    }
                }

                // 修复代码错误
                case 'fix': {
                    const file = readStringParam(args, 'file', { required: true, label: 'file' });
                    const prompt = readStringParam(args, 'prompt') || '修复代码中的错误';
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
                        return errorResult(`修复失败: ${error.message}`);
                    }
                }

                // 解释代码
                case 'explain': {
                    const file = readStringParam(args, 'file');
                    const code = readStringParam(args, 'code');
                    if (!file && !code) {
                        return errorResult('需要提供 file 或 code 参数');
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
                        return errorResult(`解释失败: ${error.message}`);
                    }
                }

                // 重构代码
                case 'refactor': {
                    const file = readStringParam(args, 'file', { required: true, label: 'file' });
                    const prompt = readStringParam(args, 'prompt') || '优化和重构代码';
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
                        return errorResult(`重构失败: ${error.message}`);
                    }
                }

                default:
                    return errorResult(`未知动作: ${action}`);
            }
        },
    };
}
