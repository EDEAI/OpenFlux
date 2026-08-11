/**
 * CodingAgent Tool - Unified CLI AI Coding Agent Tool
 *
 * Access CLI tools such as agy / claude / codex / cursor through one tool.
 * Tool name: coding_agent
 * Calling method: { driver: "agy", action: "run", prompt: "...", cwd: "..." }
 */

import { spawn, type ChildProcess } from 'child_process';
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import type { AnyTool, ToolResult } from '../types';
import { Logger } from '../../utils/logger';
import { isPathWithinBoundary } from '../../utils/path-boundary';

const log = new Logger('CodingAgent');

// ── driver definition ─────────────────────────────────────────────────────────────────

export interface DriverConfig {
    /** Driver ID */
    id: string;
    /** display name */
    displayName: string;
    /** Executable file candidate path (searched in order, also found in PATH) */
    binaryHints: string[];
    /** Check the authenticated file/directory path (exists = authenticated) */
    authCheckPaths: string[];
    /** Build execution parameters */
    buildArgs: (prompt: string, sessionId: string | null, extraArgs: string[]) => string[];
    /** Extract session ID from stdout (return null to indicate not supported) */
    extractSessionId: (stdout: string) => string | null;
    /** Whether to support session recovery */
    supportsResume: boolean;
    /** Execution timeout (ms, 0 = no limit) */
    timeoutMs: number;
}

/** Built-in driver configuration */
const DRIVERS: Record<string, DriverConfig> = {
    agy: {
        id: 'agy',
        displayName: 'Antigravity CLI',
        binaryHints: [
            join(process.env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe'),
            join(homedir(), '.local', 'bin', 'agy'),
            join(homedir(), 'bin', 'agy'),
        ],
        // agy automatically logs in through Antigravity IDE without a separate config file
        // As long as the binary exists it is considered authenticated (auto-auth via IDE session)
        authCheckPaths: ['__auto_auth__'],
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
            // agy will save conversation in the configuration directory and read the latest one after startup
            return readLatestConvId('agy');
        },
        supportsResume: true,
        timeoutMs: 30 * 60_000,
    },

    claude: {
        id: 'claude',
        displayName: 'Claude Code',
        binaryHints: [
            join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
        ],
        authCheckPaths: [
            join(homedir(), '.claude'),
            join(homedir(), '.claude', 'credentials.json'),
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
            // Claude Code prints "Session ID: xxx" at the end of the output
            for (const line of stdout.split('\n').reverse()) {
                const m = line.trim().match(/^Session\s+ID:\s*(.+)$/i);
                if (m) return m[1].trim();
            }
            return null;
        },
        supportsResume: true,
        timeoutMs: 30 * 60_000,
    },

    codex: {
        id: 'codex',
        displayName: 'Codex CLI',
        binaryHints: [
            join(process.env.APPDATA || '', 'npm', 'codex.cmd'),
        ],
        // Antigravity Codex authentication data is stored in ~/.codex/
        authCheckPaths: [
            join(homedir(), '.codex', 'log'),
            join(homedir(), '.codex'),
        ],
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
            // User-level installation (new version, priority)
            join(process.env.LOCALAPPDATA || '', 'Programs', 'cursor', 'resources', 'app', 'bin', 'cursor.cmd'),
            join(process.env.LOCALAPPDATA || '', 'Programs', 'cursor', 'Cursor.exe'),
            // System level installation
            'C:\\Program Files\\cursor\\resources\\app\\bin\\cursor.cmd',
            'C:\\Program Files\\Cursor\\Cursor.exe',
            // macOS
            '/Applications/Cursor.app/Contents/MacOS/Cursor',
        ],
        authCheckPaths: [
            join(process.env.APPDATA || '', 'Cursor'),
            join(homedir(), 'Library', 'Application Support', 'Cursor'),
            join(homedir(), '.config', 'Cursor'),
        ],
        buildArgs(_prompt, _sessionId, extraArgs) {
            return [...extraArgs];  // Cursor CLI is mainly used to open directories
        },
        extractSessionId(_stdout) { return null; },
        supportsResume: false,
        timeoutMs: 60_000,
    },
};

// ── Session storage (using the project directory as the key, persisted to disk)──────────────────────────
//
// key format: `{cwd}::{driverId}`
// Projects in the same directory, regardless of cross-OpenFlux conversations or Gateway restarts, can restore the CLI context

class CwdSessionStore {
    private store: Map<string, string> = new Map();
    private storePath: string | null = null;

    /** Initialization: Pass in the persistent file path (optional, if not passed, it will be downgraded to memory) */
    init(storePath: string): void {
        this.storePath = storePath;
        if (existsSync(storePath)) {
            try {
                const raw = readFileSync(storePath, 'utf8');
                const obj = JSON.parse(raw) as Record<string, string>;
                this.store = new Map(Object.entries(obj));
                log.info(`[SessionStore] Loaded ${this.store.size} sessions from ${storePath}`);
            } catch (e) {
                log.warn('[SessionStore] Failed to load sessions file, starting fresh', { error: String(e) });
            }
        }
    }

    /** key: `{cwd}::{driverId}` */
    get(cwd: string, driverId: string): string | undefined {
        return this.store.get(`${cwd}::${driverId}`);
    }

    set(cwd: string, driverId: string, convId: string): void {
        this.store.set(`${cwd}::${driverId}`, convId);
        this.persist();
    }

    delete(cwd: string, driverId: string): void {
        this.store.delete(`${cwd}::${driverId}`);
        this.persist();
    }

    private persist(): void {
        if (!this.storePath) return;
        try {
            mkdirSync(join(this.storePath, '..'), { recursive: true });
            const obj = Object.fromEntries(this.store);
            writeFileSync(this.storePath, JSON.stringify(obj, null, 2), 'utf8');
        } catch (e) {
            log.warn('[SessionStore] Failed to persist sessions', { error: String(e) });
        }
    }
}

const sessionStore = new CwdSessionStore();

// ── Utility function ─────────────────────────────────────────────────────────────────

/** Find binary files (PATH first, then candidate list) */
function findBinary(driver: DriverConfig): string | null {
    // Check PATH first
    const pathName = process.platform === 'win32' ? `${driver.id}.exe` : driver.id;
    const cmdName = `${driver.id}.cmd`;
    for (const name of [pathName, cmdName, driver.id]) {
        const inPath = findInPath(name);
        if (inPath) return inPath;
    }
    // Check candidate paths again
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

/** Check certification status */
function isAuthenticated(driver: DriverConfig): boolean {
    // '__auto_auth__' sentinel: Indicates that the driver is automatically certified through external IDE. As long as the binary exists, it is certified.
    if (driver.authCheckPaths.includes('__auto_auth__')) {
        return !!findBinary(driver);
    }
    // Prioritize checking file/directory paths
    if (driver.authCheckPaths.length > 0) {
        return driver.authCheckPaths.some(p => p && existsSync(p));
    }
    // Downgrade when path is empty: check OPENAI_API_KEY environment variable
    return !!process.env.OPENAI_API_KEY;
}

/** Read agy's latest conversation ID (from the config directory) */
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

/** Execute CLI Agent */
function terminateProcessTree(proc: ChildProcess): void {
    if (!proc.pid) return;
    if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
        });
        killer.once('error', () => {
            try { proc.kill('SIGKILL'); } catch { /* already exited */ }
        });
        return;
    }

    try {
        // POSIX children are started in their own process group below.
        process.kill(-proc.pid, 'SIGTERM');
    } catch {
        try { proc.kill('SIGTERM'); } catch { /* already exited */ }
    }
    const forceTimer = setTimeout(() => {
        try { process.kill(-proc.pid!, 'SIGKILL'); } catch { /* already exited */ }
    }, 1_000);
    forceTimer.unref?.();
}

export async function runDriver(
    driver: DriverConfig,
    binary: string,
    prompt: string,
    cwd: string,
    sessionId: string | null,
    onLine?: (line: string) => void,
    onStderr?: (line: string) => void,
    abortSignal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (abortSignal?.aborted) {
        const error = abortSignal.reason instanceof Error
            ? abortSignal.reason
            : new Error('Coding Agent execution aborted');
        error.name = 'AbortError';
        throw error;
    }
    const args = driver.buildArgs(prompt, sessionId, []);

    return new Promise((resolve, reject) => {
        log.info(`[${driver.id}] spawn: ${binary} ${args.join(' ').slice(0, 120)}`);

        // Windows.cmd/.bat requires shell to execute;.exe spawns directly to avoid DEP0190 security warning
        const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary);
        const spawnBinary = needsShell ? 'cmd.exe' : binary;
        const spawnArgs = needsShell ? ['/c', binary, ...args] : args;

        const proc = spawn(spawnBinary, spawnArgs, {
            cwd: cwd || process.cwd(),
            shell: false,          // Always false, avoid DEP0190
            windowsHide: true,
            detached: process.platform !== 'win32',
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
            const text = chunk.toString();
            stderr += text;
            if (onStderr) {
                text.split('\n').filter(Boolean).forEach(onStderr);
            }
        });

        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let abortTimer: ReturnType<typeof setTimeout> | null = null;
        let abortFailure: Error | null = null;
        const cleanup = () => {
            if (timer) clearTimeout(timer);
            if (abortTimer) clearTimeout(abortTimer);
            abortSignal?.removeEventListener('abort', handleAbort);
        };
        const settleResult = (result: { stdout: string; stderr: string; exitCode: number }) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(result);
        };
        const settleError = (error: Error) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        };
        const handleAbort = () => {
            if (abortFailure || settled) return;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            terminateProcessTree(proc);
            const error = abortSignal?.reason instanceof Error
                ? abortSignal.reason
                : new Error('Coding Agent execution aborted');
            error.name = 'AbortError';
            abortFailure = error;
            // Prefer confirmation from the child close event. The fallback
            // prevents a broken platform process API from blocking stop forever.
            abortTimer = setTimeout(() => settleError(error), 5_000);
        };

        abortSignal?.addEventListener('abort', handleAbort, { once: true });
        if (abortSignal?.aborted) {
            handleAbort();
            return;
        }
        if (driver.timeoutMs > 0) {
            timer = setTimeout(() => {
                terminateProcessTree(proc);
                settleResult({ stdout, stderr: stderr + '\n[Timeout]', exitCode: -1 });
            }, driver.timeoutMs);
        }

        proc.on('close', (code) => {
            if (abortFailure) settleError(abortFailure);
            else settleResult({ stdout, stderr, exitCode: code ?? 0 });
        });

        proc.on('error', (err) => {
            if (abortFailure) settleError(abortFailure);
            else settleResult({ stdout, stderr: err.message, exitCode: -1 });
        });
    });
}

// ── Tool configuration ─────────────────────────────────────────────────────────────────

export interface CodingAgentToolOptions {
    /** Default working directory */
    defaultCwd?: string | (() => string);
    /** Optional dynamic project boundary for explicit cwd values. */
    allowedCwdPaths?: string[] | (() => string[]);
    /** Additional injection of environment variables */
    env?: Record<string, string>;
    /**
     * session persistence file path (it is recommended to pass in workspace/.coding-agent-sessions.json)
     * If not transferred, only memory storage (lost after Gateway restarts)
     */
    sessionsStorePath?: string;
}

// ── Factory function ─────────────────────────────────────────────────────────────────

export function createCodingAgentTool(opts: CodingAgentToolOptions = {}): AnyTool {
    const getDefaultCwd = () => {
        const d = opts.defaultCwd;
        return typeof d === 'function' ? d() : (d || process.cwd());
    };

    // Initialize disk persistence (if sessionsStorePath is passed)
    if (opts.sessionsStorePath) {
        sessionStore.init(opts.sessionsStorePath);
    }

    return {
        name: 'coding_agent',
        priority: 45,
        description: `AI Coding Agent — Delegates coding tasks to a CLI AI agent (agy/claude/codex/cursor).
Use this tool when you need to: write/edit code, run tests, fix bugs, refactor, scaffold projects.
The agent maintains session context PER PROJECT DIRECTORY — the same project directory always resumes
the same CLI session, even after Gateway restarts or across different OpenFlux conversations.

Actions:
- run: Execute a coding task (creates or continues session for the project cwd)
- reset: Clear session for this project+driver (next run starts fresh)  
- status: Get current session info for a driver in this project
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
                description: 'Project working directory — sessions are scoped per directory (defaults to agent workspace)',
            },
        },

        execute: async (args: Record<string, unknown>, context?: import('../types').ToolExecutionContext): Promise<ToolResult> => {
            const driverId = String(args.driver || '');
            const action = String(args.action || 'run');
            const cwd = resolve(String(args.cwd || '') || getDefaultCwd());
            const allowedCwdPaths = typeof opts.allowedCwdPaths === 'function'
                ? opts.allowedCwdPaths()
                : opts.allowedCwdPaths;
            if (allowedCwdPaths?.length
                && !allowedCwdPaths.some(root => isPathWithinBoundary(cwd, root))) {
                throw new Error(`Coding Agent working directory is outside the project workspace: ${cwd}`);
            }

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
                const convId = sessionStore.get(cwd, driverId) ?? null;
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
                sessionStore.delete(cwd, driverId);
                return { success: true, data: { message: `Session reset for driver "${driverId}" in ${cwd}` } };
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

            // Obtain the existing session ID (with the project cwd as the key, it will continue to be valid across OpenFlux sessions and Gateway restarts)
            const existingConvId = driver.supportsResume
                ? (sessionStore.get(cwd, driverId) ?? null)
                : null;

            log.info(`[${driverId}] run: session=${existingConvId ?? 'new'} cwd=${cwd}`);

            // Wrap ToolExecutionContext.onProgress as runDriver's onLine/onStderr
            const onLine = context?.onProgress
                ? (line: string) => context.onProgress!({ type: 'stdout', message: line, driver: driverId })
                : undefined;
            const onStderr = context?.onProgress
                ? (line: string) => context.onProgress!({ type: 'stderr', message: line, driver: driverId })
                : undefined;

            const result = await runDriver(
                driver,
                binary,
                prompt,
                cwd,
                existingConvId,
                onLine,
                onStderr,
                context?.abortSignal || context?.signal,
            );

            // Extract and save the new session ID (persistent with cwd as key)
            const newConvId = driver.extractSessionId(result.stdout);
            if (newConvId && driver.supportsResume) {
                sessionStore.set(cwd, driverId, newConvId);
                log.info(`[${driverId}] session saved: cwd=${cwd} conv=${newConvId}`);
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
