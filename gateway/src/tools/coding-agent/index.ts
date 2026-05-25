/**
 * CodingAgent Tool — 统一 CLI AI Coding Agent 工具
 *
 * 通过一个工具接入 agy / claude / codex / cursor 等 CLI 工具。
 * 工具名：coding_agent
 * 调用方式：{ driver: "agy", action: "run", prompt: "...", cwd: "..." }
 */

import { spawn } from 'child_process';
import { existsSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import type { AnyTool, ToolResult } from '../types';
import { Logger } from '../../utils/logger';

const log = new Logger('CodingAgent');

// ── 驱动定义 ─────────────────────────────────────────────────────────────────

export interface DriverConfig {
    /** 驱动 ID */
    id: string;
    /** 显示名称 */
    displayName: string;
    /** 可执行文件候选路径（按顺序查找，也会在 PATH 里找） */
    binaryHints: string[];
    /** 检查认证的文件/目录路径（存在 = 已认证） */
    authCheckPaths: string[];
    /** 构建执行参数 */
    buildArgs: (prompt: string, sessionId: string | null, extraArgs: string[]) => string[];
    /** 从 stdout 中提取 session ID（返回 null 表示不支持） */
    extractSessionId: (stdout: string) => string | null;
    /** 是否支持 session 恢复 */
    supportsResume: boolean;
    /** 执行超时（ms，0 = 不限） */
    timeoutMs: number;
}

/** 内置驱动配置 */
const DRIVERS: Record<string, DriverConfig> = {
    agy: {
        id: 'agy',
        displayName: 'Antigravity CLI',
        binaryHints: [
            join(process.env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe'),
            join(homedir(), '.local', 'bin', 'agy'),
            join(homedir(), 'bin', 'agy'),
        ],
        authCheckPaths: [
            join(process.env.APPDATA || '', 'agy'),
            join(process.env.LOCALAPPDATA || '', 'agy', 'config'),
        ],
        buildArgs(prompt, sessionId, extraArgs) {
            const args: string[] = [];
            if (sessionId) {
                args.push('--conversation', sessionId);
            }
            args.push('--dangerously-skip-permissions');
            args.push('--print', prompt);
            return [...args, ...extraArgs];
        },
        extractSessionId(_stdout) {
            // agy 将 conversation 存在配置目录，启动后读取最新的
            return readLatestConvId('agy');
        },
        supportsResume: true,
        timeoutMs: 0,
    },

    claude: {
        id: 'claude',
        displayName: 'Claude Code',
        binaryHints: [
            join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
        ],
        authCheckPaths: [
            join(process.env.APPDATA || '', '.claude'),
            join(homedir(), '.claude'),
        ],
        buildArgs(prompt, sessionId, extraArgs) {
            const args: string[] = [];
            if (sessionId) {
                args.push('--resume', sessionId);
            }
            args.push('--print', prompt);
            return [...args, ...extraArgs];
        },
        extractSessionId(stdout) {
            // Claude Code 在输出末尾输出 "Session ID: xxx"
            for (const line of stdout.split('\n').reverse()) {
                const m = line.trim().match(/^Session\s+ID:\s*(.+)$/i);
                if (m) return m[1].trim();
            }
            return null;
        },
        supportsResume: true,
        timeoutMs: 0,
    },

    codex: {
        id: 'codex',
        displayName: 'OpenAI Codex CLI',
        binaryHints: [
            join(process.env.APPDATA || '', 'npm', 'codex.cmd'),
        ],
        authCheckPaths: [],
        buildArgs(prompt, _sessionId, extraArgs) {
            return ['--full-auto', '--quiet', prompt, ...extraArgs];
        },
        extractSessionId(_stdout) { return null; },
        supportsResume: false,
        timeoutMs: 300_000,
    },

    cursor: {
        id: 'cursor',
        displayName: 'Cursor',
        binaryHints: [
            join(process.env.LOCALAPPDATA || '', 'Programs', 'cursor', 'Cursor.exe'),
            '/Applications/Cursor.app/Contents/MacOS/Cursor',
        ],
        authCheckPaths: [
            join(process.env.APPDATA || '', 'Cursor'),
            join(homedir(), 'Library', 'Application Support', 'Cursor'),
            join(homedir(), '.config', 'Cursor'),
        ],
        buildArgs(_prompt, _sessionId, extraArgs) {
            return [...extraArgs];  // Cursor CLI 主要用于打开目录
        },
        extractSessionId(_stdout) { return null; },
        supportsResume: false,
        timeoutMs: 60_000,
    },
};

// ── Session 存储（内存，Gateway 重启清空，对应功能已足够）────────────────────

/** key: `${nexusaiSessionId}:${driverId}` → conv_id */
const sessionStore = new Map<string, string>();

function sessionKey(nexusaiSession: string, driverId: string): string {
    return `${nexusaiSession}:${driverId}`;
}

// ── 工具函数 ─────────────────────────────────────────────────────────────────

/** 查找二进制文件（先 PATH，再候选列表） */
function findBinary(driver: DriverConfig): string | null {
    // 先查 PATH
    const pathName = process.platform === 'win32' ? `${driver.id}.exe` : driver.id;
    const cmdName = `${driver.id}.cmd`;
    for (const name of [pathName, cmdName, driver.id]) {
        const inPath = findInPath(name);
        if (inPath) return inPath;
    }
    // 再查候选路径
    for (const hint of driver.binaryHints) {
        if (hint && existsSync(hint)) return hint;
    }
    return null;
}

function findInPath(name: string): string | null {
    const dirs = (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':');
    for (const dir of dirs) {
        if (!dir) continue;
        const full = join(dir, name);
        if (existsSync(full)) return full;
    }
    return null;
}

/** 检查认证状态 */
function isAuthenticated(driver: DriverConfig): boolean {
    if (driver.authCheckPaths.length === 0) {
        // 依赖环境变量（如 OPENAI_API_KEY）
        return !!process.env.OPENAI_API_KEY;
    }
    return driver.authCheckPaths.some(p => p && existsSync(p));
}

/** 读取 agy 最新 conversation ID（从 config 目录） */
function readLatestConvId(driverId: string): string | null {
    if (driverId !== 'agy') return null;

    const dirs = [
        join(process.env.APPDATA || '', 'agy', 'conversations'),
        join(process.env.LOCALAPPDATA || '', 'agy', 'conversations'),
        join(homedir(), '.config', 'agy', 'conversations'),
    ];

    for (const dir of dirs) {
        if (!existsSync(dir)) continue;
        try {
            const files = readdirSync(dir)
                .map(f => ({ name: f, mtime: statSync(join(dir, f)).mtimeMs }))
                .sort((a, b) => b.mtime - a.mtime);
            if (files.length > 0) {
                const stem = files[0].name.replace(/\.[^.]+$/, '');
                return stem;
            }
        } catch { /* ignore */ }
    }
    return null;
}

/** 执行 CLI Agent */
async function runDriver(
    driver: DriverConfig,
    binary: string,
    prompt: string,
    cwd: string,
    sessionId: string | null,
    onLine?: (line: string) => void,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const args = driver.buildArgs(prompt, sessionId, []);

    return new Promise((resolve) => {
        log.info(`[${driver.id}] spawn: ${binary} ${args.join(' ').slice(0, 120)}`);

        const proc = spawn(binary, args, {
            cwd: cwd || process.cwd(),
            shell: process.platform === 'win32',
            windowsHide: true,
            env: { ...process.env },
        });

        let stdout = '';
        let stderr = '';

        proc.stdout?.on('data', (chunk: Buffer) => {
            const text = chunk.toString();
            stdout += text;
            if (onLine) {
                text.split('\n').filter(Boolean).forEach(onLine);
            }
        });

        proc.stderr?.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
        });

        let timer: ReturnType<typeof setTimeout> | null = null;
        if (driver.timeoutMs > 0) {
            timer = setTimeout(() => {
                proc.kill();
                resolve({ stdout, stderr: stderr + '\n[Timeout]', exitCode: -1 });
            }, driver.timeoutMs);
        }

        proc.on('close', (code) => {
            if (timer) clearTimeout(timer);
            resolve({ stdout, stderr, exitCode: code ?? 0 });
        });

        proc.on('error', (err) => {
            if (timer) clearTimeout(timer);
            resolve({ stdout, stderr: err.message, exitCode: -1 });
        });
    });
}

// ── 工具配置 ─────────────────────────────────────────────────────────────────

export interface CodingAgentToolOptions {
    /** 默认工作目录 */
    defaultCwd?: string | (() => string);
    /** 额外注入环境变量 */
    env?: Record<string, string>;
}

// ── 工厂函数 ─────────────────────────────────────────────────────────────────

export function createCodingAgentTool(opts: CodingAgentToolOptions = {}): AnyTool {
    const getDefaultCwd = () => {
        const d = opts.defaultCwd;
        return typeof d === 'function' ? d() : (d || process.cwd());
    };

    return {
        name: 'coding_agent',
        priority: 45,
        description: `AI Coding Agent — Delegates coding tasks to a CLI AI agent (agy/claude/codex/cursor).
Use this tool when you need to: write/edit code, run tests, fix bugs, refactor, scaffold projects.
The agent maintains session context within the same conversation (session resume is automatic).

Actions:
- run: Execute a coding task (creates or continues session)
- reset: Clear current session (next run starts fresh)  
- status: Get current session info for a driver
- list_drivers: List all available drivers and their status`,
        parameters: {
            driver: {
                type: 'string',
                description: 'Which CLI agent to use: agy | claude | codex | cursor',
                required: true,
                enum: Object.keys(DRIVERS),
            },
            action: {
                type: 'string',
                description: 'Action: run | reset | status | list_drivers',
                required: true,
                enum: ['run', 'reset', 'status', 'list_drivers'],
            },
            prompt: {
                type: 'string',
                description: 'Task description (required for action=run)',
            },
            cwd: {
                type: 'string',
                description: 'Working directory (defaults to agent workspace)',
            },
            nexusai_session: {
                type: 'string',
                description: 'NexusAI session ID for context continuity (optional, auto-managed)',
            },
        },

        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
            const driverId = String(args.driver || '');
            const action = String(args.action || 'run');
            const nexusaiSession = String(args.nexusai_session || 'default');
            const cwd = resolve(String(args.cwd || '') || getDefaultCwd());

            // ── list_drivers ──────────────────────────────────────────────────
            if (action === 'list_drivers') {
                const list = Object.values(DRIVERS).map(d => ({
                    id: d.id,
                    displayName: d.displayName,
                    installed: !!findBinary(d),
                    authenticated: isAuthenticated(d),
                    supportsResume: d.supportsResume,
                }));
                return { success: true, data: { drivers: list } };
            }

            const driver = DRIVERS[driverId];
            if (!driver) {
                return {
                    success: false,
                    error: `Unknown driver: "${driverId}". Available: ${Object.keys(DRIVERS).join(', ')}`,
                };
            }

            // ── status ────────────────────────────────────────────────────────
            if (action === 'status') {
                const binary = findBinary(driver);
                const convId = sessionStore.get(sessionKey(nexusaiSession, driverId)) ?? null;
                return {
                    success: true,
                    data: {
                        driver: driverId,
                        installed: !!binary,
                        authenticated: isAuthenticated(driver),
                        conv_id: convId,
                        cwd,
                    },
                };
            }

            // ── reset ─────────────────────────────────────────────────────────
            if (action === 'reset') {
                sessionStore.delete(sessionKey(nexusaiSession, driverId));
                return { success: true, data: { message: `Session reset for driver "${driverId}"` } };
            }

            // ── run ───────────────────────────────────────────────────────────
            const prompt = String(args.prompt || '');
            if (!prompt) {
                return { success: false, error: 'prompt is required for action=run' };
            }

            const binary = findBinary(driver);
            if (!binary) {
                return {
                    success: false,
                    error: `${driver.displayName} is not installed or not found in PATH`,
                };
            }

            // 获取已有 session ID（实现跨调用上下文）
            const existingConvId = driver.supportsResume
                ? (sessionStore.get(sessionKey(nexusaiSession, driverId)) ?? null)
                : null;

            log.info(`[${driverId}] run: session=${existingConvId ?? 'new'} cwd=${cwd}`);

            const result = await runDriver(driver, binary, prompt, cwd, existingConvId);

            // 提取并保存新的 session ID
            const newConvId = driver.extractSessionId(result.stdout);
            if (newConvId && driver.supportsResume) {
                sessionStore.set(sessionKey(nexusaiSession, driverId), newConvId);
                log.info(`[${driverId}] session updated: ${newConvId}`);
            }

            return {
                success: result.exitCode === 0,
                data: {
                    driver: driverId,
                    exitCode: result.exitCode,
                    stdout: result.stdout,
                    stderr: result.stderr || undefined,
                    conv_id: newConvId ?? existingConvId,
                },
                ...(result.exitCode !== 0 ? {
                    error: `${driver.displayName} exited with code ${result.exitCode}.\n${result.stderr || result.stdout}`,
                } : {}),
            };
        },
    };
}
