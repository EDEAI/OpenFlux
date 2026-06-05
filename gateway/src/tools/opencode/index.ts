/**
 * OpenCode Coding Tools - Factory Mode
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

// Supported actions
const OPENCODE_ACTIONS = [
    'status',   // Check OpenCode status
    'run',      // Run encoding tasks
    'fix',      // Fix code errors
    'explain',  // explain code
    'refactor', // Refactor code
] as const;

type OpenCodeAction = (typeof OPENCODE_ACTIONS)[number];

export interface OpenCodeToolOptions {
    /** OpenCode executable file path */
    executable?: string;
    /** Working directory (supports dynamic functions, obtains the latest value each time it is executed) */
    cwd?: string | (() => string);
    /** Timeout (milliseconds) */
    timeout?: number;
    /** Whether to automatically approve operations */
    autoApprove?: boolean;
}

/**
 * Create an OpenCode coding tool
 */
export function createOpenCodeTool(opts: OpenCodeToolOptions = {}): AnyTool {
    const {
        executable = 'opencode',
        cwd,
        timeout = 300000, // 5 minutes
        autoApprove = false,
    } = opts;

    // Execute OpenCode command
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

            // Make sure the working directory exists
            if (workDir && !existsSync(workDir)) {
                try { mkdirSync(workDir, { recursive: true }); } catch { /* ignore */ }
            }

            switch (action) {
                // Check OpenCode status
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

                // Run encoding tasks
                case 'run': {
                    const prompt = readStringParam(args, 'prompt', { required: true, label: 'prompt' });
                    const cmdArgs = [prompt];
                    if (shouldAutoApprove) {
                        cmdArgs.unshift('--yes');
                    }

                    // File change detection: pre-execution snapshot
                    const snapshotDir = workDir || process.cwd();
                    let beforeSnapshot;
                    try {
                        beforeSnapshot = await snapshotDirectory(snapshotDir);
                    } catch { /* ignore */ }

                    try {
                        const result = await runOpenCode(cmdArgs, workDir);

                        // File change detection: post-execution comparison
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

                // Fix code errors
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

                // explain code
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

                // Refactor code
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
