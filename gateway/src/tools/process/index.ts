/**
 * Process/Command Tool - Factory Mode
 * Supports local execution and Docker sandbox isolated execution
 */

import { exec, spawn } from 'child_process';
import { kill as processKill } from 'process';
import { promisify } from 'util';
import { accessSync, constants, mkdirSync, existsSync, statSync } from 'fs';
import { extname, isAbsolute, resolve, normalize } from 'path';
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
import { snapshotDirectory, diffSnapshots, detectGeneratedFromStdout, type GeneratedFile } from '../../utils/file-snapshot';
import { DockerExecutor, type DockerExecutorOptions } from './docker-executor';
import { Logger } from '../../utils/logger';
import { decodeProcessOutput } from '../../utils/system-encoding';
import { isPathWithinBoundary } from '../../utils/path-boundary';

const execAsync = promisify(exec);
const log = new Logger('ProcessTool');

/**
 * 与 promisify(exec) 等价，但在进程创建后立即关闭 stdin（发送 EOF）。
 *
 * 背景：默认的 exec 会为子进程保留一个永不写入、永不关闭的 stdin 管道。
 * 当 Agent 执行裸解释器命令（如 python / python3 / node，不带脚本）或任何
 * 会读取 stdin 的命令时，进程会进入交互模式阻塞在 stdin 读取上，直到达到
 * timeout 被强杀——表现为大量「Command timed out (30000ms)」。
 *
 * 自动化场景没有人工输入，主动关闭 stdin 后交互式解释器读到 EOF 会立即退出，
 * 从而把「挂满超时」变成「秒回」。这是严格更优的行为。
 */
function execWithClosedStdin(
    command: string,
    options: Parameters<typeof exec>[1],
): Promise<{ stdout: Buffer; stderr: Buffer }> {
    return new Promise((resolvePromise, rejectPromise) => {
        const child = exec(command, options, (error, stdout, stderr) => {
            if (error) {
                (error as any).stdout = stdout;
                (error as any).stderr = stderr;
                rejectPromise(error);
            } else {
                resolvePromise({ stdout: stdout as unknown as Buffer, stderr: stderr as unknown as Buffer });
            }
        });
        // 立即关闭 stdin，避免交互式进程阻塞等待输入直到超时
        try { child.stdin?.end(); } catch { /* ignore */ }
    });
}

/**
 * 合并 diff 检测结果与 stdout 兜底检测结果。
 * stdout 兜底只纳入"本次运行期间真正被写入/修改"的文件（按 mtime 过滤），
 * 避免把脚本中被读取/引用的历史旧文件误当成本次产出。
 */
function mergeStdoutFiles(
    diffFiles: GeneratedFile[] | undefined,
    stdout: string,
    baseDir: string,
    runStartMs: number,
): GeneratedFile[] | undefined {
    const files = diffFiles ? [...diffFiles] : [];
    try {
        const seen = new Set(files.map(f => f.fullPath));
        const extra = detectGeneratedFromStdout(stdout, baseDir, runStartMs, seen);
        files.push(...extra);
    } catch { /* ignore */ }
    return files.length ? files : undefined;
}

// Spawned process records
interface SpawnedProcess {
    pid: number;
    command: string;
    args: string[];
    cwd?: string;
    sessionId?: string;
    startTime: number;
}
const spawnedProcesses = new Map<number, SpawnedProcess>();

// Supported actions
const PROCESS_ACTIONS = [
    'run',       // Run the command and wait for the results
    'spawn',     // Start background process
    'kill',      // Terminate a started process
    'list',      // List started processes
    'shell',     // Execute in shell
] as const;

type ProcessAction = (typeof PROCESS_ACTIONS)[number];

// Dangerous command list (full command match + prefix match)
const DANGEROUS_COMMANDS = [
    // File system corruption (general)
    'rm -rf /',
    'rm -rf /*',
    ':(){:|:&};:',  // fork bomb
    // Windows file system corruption
    'del /s /q c:\\',
    'format c:',
    'format d:',
    'rd /s /q c:\\',
    // Windows system operation
    'shutdown /s',
    'shutdown /r',
    'shutdown /f',
    // Windows registry corruption
    'reg delete hklm',
    'reg delete hkcu',
    'reg delete hkcr',
    // Windows service operations
    'sc delete',
    'sc stop',
    'net stop',
    // Windows disk operations
    'diskpart',
    'bcdedit',
    // Windows boot destruction
    'bootrec',
    'bcdboot',
    // macOS dangerous commands
    'sudo rm -rf /',
    'sudo rm -rf /*',
    'diskutil eraseDisk',
    'diskutil eraseVolume',
    'sudo shutdown',
    'sudo halt',
    'sudo reboot',
    'csrutil disable',
];

// High-risk command prefix (fuzzy matching)
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
    /** Command timeout (milliseconds) */
    timeout?: number;
    /** Maximum output buffer (bytes) */
    maxBuffer?: number;
    /** Working directory (supports dynamic functions, obtains the latest value each time it is executed) */
    cwd?: string | (() => string);
    /** Whether to allow dangerous commands */
    allowDangerous?: boolean;
    /** Command blacklist */
    blockedCommands?: string[];
    /** Command whitelist (only these command prefixes are allowed after setting) */
    allowedCommands?: string[];
    /** Allowed working directory range (cwd must be within this range) */
    allowedCwdPaths?: string[] | (() => string[]);
    /**
     * Optional hard boundary for command arguments. When set, commands may not
     * reference absolute/traversal paths outside this directory or explicitly
     * inspect secret-bearing environment variables.
     */
    pathBoundary?: string | (() => string | undefined);
    /** Explicit user-owned input paths that a project command may reference. */
    allowedExternalPaths?: string[] | (() => string[]);
    /** Docker sandbox configuration (commands are executed within the container after setting) */
    docker?: DockerExecutorOptions;
    /** Get the current session ID (used to associate the spawn process) */
    getSessionId?: () => string | undefined;
    /**
     * Built-in Python interpreter path (absolute path)
     * Once set, the python/python3 prefix in the command will be replaced with this path,
     * No need to modify process.env.PATH.
     * Example: "C:\\Program Files\\OpenFlux\\python\\base\\python.exe"
     */
    pythonExe?: string;
    /**
     * Built-in uv executable file path (absolute path)
     * Once set, the pip/uv prefix in the command will be replaced with this path.
     * Example: "C:\\Program Files\\OpenFlux\\python\\uv.exe"
     */
    uvExe?: string;
}

/**
 * Create process/command tool
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
        pathBoundary,
        allowedExternalPaths,
    } = opts;

    // Built-in Python/uv path (if the path contains spaces, please add quotes)
    const _pythonExe = opts.pythonExe ? normalize(opts.pythonExe) : null;
    const _uvExe     = opts.uvExe     ? normalize(opts.uvExe)     : null;

    /**
     * Python command interception and replacement
     *
     * Replace Agent-generated generic commands (python/python3/pip/uv) with those of the built-in executable
     * Full absolute path, thus completely avoiding dependency on process.env.PATH.
     *
     * Replacement rules (only takes effect when pythonExe / uvExe is configured):
     *   python script.py          → "<pythonExe>" script.py
     *   python3 -c "..."          → "<pythonExe>" -c "..."
     *   pip install openpyxl      → "<uvExe>" pip install openpyxl
     *   pip3 install openpyxl     → "<uvExe>" pip install openpyxl
     *   uv pip install openpyxl   → "<uvExe>" pip install openpyxl
     *   uv run script.py          → "<uvExe>" run script.py
     */
    function resolvePythonCommand(cmd: string): string {
        // Remove leading and trailing blanks and compare uniformly
        const trimmed = cmd.trimStart();

        // If the path contains spaces, it must be wrapped in quotes.
        const quoted = (p: string) => p.includes(' ') ? `"${p}"` : p;

        // pip / pip3 → uv pip
        if (_uvExe) {
            const pipMatch = trimmed.match(/^pip3?\s+(.*)$/i);
            if (pipMatch) {
                const resolved = `${quoted(_uvExe)} pip ${pipMatch[1]}`;
                log.debug('Python command rewritten', { original: cmd, resolved });
                return resolved;
            }
        }

        // uv <subcommand> → <uvExe> <subcommand>
        if (_uvExe) {
            const uvMatch = trimmed.match(/^uv\s+(.*)$/i);
            if (uvMatch) {
                const resolved = `${quoted(_uvExe)} ${uvMatch[1]}`;
                log.debug('Python command rewritten', { original: cmd, resolved });
                return resolved;
            }
        }

        // python / python3 → <pythonExe>
        if (_pythonExe) {
            const pyMatch = trimmed.match(/^python3?\s*(.*)?$/i);
            if (pyMatch) {
                const rest = pyMatch[1] || '';
                const resolved = rest ? `${quoted(_pythonExe)} ${rest}` : quoted(_pythonExe);
                log.debug('Python command rewritten', { original: cmd, resolved });
                return resolved;
            }
        }

        // Intercept the full absolute path of python.exe (such as C:\ProgramData\anaconda3\python.exe)
        // Agent sometimes falls back to system Python after failing to find the built-in python, here is a unified hijacking
        if (_pythonExe) {
            // Matches the full python.exe path with or without quotes (including anaconda/envs and other variations)
            const absPyMatch = trimmed.match(/^(?:"([^"]*python(?:3|\.exe|3\.exe)?)"|([\w:\\/.-]*python(?:3|\.exe|3\.exe)?))\s*(.*)?$/i);
            if (absPyMatch) {
                const matchedExe = absPyMatch[1] || absPyMatch[2];
                // Only intercept system paths (not the built-in paths themselves to avoid infinite loops)
                const normalizedMatch = matchedExe.replace(/\\/g, '/').toLowerCase();
                const normalizedBuiltin = _pythonExe.replace(/\\/g, '/').toLowerCase();
                if (normalizedMatch !== normalizedBuiltin) {
                    const rest = (absPyMatch[3] || '').trim();
                    const resolved = rest ? `${quoted(_pythonExe)} ${rest}` : quoted(_pythonExe);
                    log.warn('System Python path intercepted, redirected to built-in', {
                        original: matchedExe,
                        resolved: _pythonExe,
                    });
                    return resolved;
                }
            }
        }

        // Intercept the full path of pip (such as C:\ProgramData\anaconda3\Scripts\pip.exe)
        if (_uvExe) {
            const absPipMatch = trimmed.match(/^(?:"([^"]*pip(?:3|\.exe|3\.exe)?)"|([\w:\\/.-]*pip(?:3|\.exe|3\.exe)?))\s+(.*)?$/i);
            if (absPipMatch) {
                const rest = (absPipMatch[3] || '').trim();
                const resolved = `${quoted(_uvExe)} pip ${rest}`;
                log.warn('System pip path intercepted, redirected to uv pip', {
                    original: absPipMatch[1] || absPipMatch[2],
                    resolved,
                });
                return resolved;
            }
        }

        return cmd;
    }

    // Docker executor (lazy initialization)
    let dockerExecutor: DockerExecutor | null = null;
    let dockerAvailable: boolean | null = null;

    if (opts.docker) {
        dockerExecutor = new DockerExecutor(opts.docker);
    }

    /**
     * Check if Docker is available (with cache)
     */
    async function checkDockerAvailable(): Promise<boolean> {
        if (!dockerExecutor) return false;
        if (dockerAvailable !== null) return dockerAvailable;
        dockerAvailable = await dockerExecutor.isAvailable();
        if (dockerAvailable) {
            const hasImage = await dockerExecutor.imageExists();
            if (!hasImage) {
                log.warn(`Docker image '${opts.docker?.image || 'openflux-sandbox'}' not found, please build it first`);
                dockerAvailable = false;
            }
        }
        return dockerAvailable;
    }

    // Command security check
    function checkCommand(command: string): void {
        const lowerCmd = command.toLowerCase().trim();

        // 1. Whitelist mode (most strict)
        if (allowedCommands && allowedCommands.length > 0) {
            const allowed = allowedCommands.some(
                ac => lowerCmd.startsWith(ac.toLowerCase())
            );
            if (!allowed) {
                throw new Error(
                    `Command is not in the whitelist: ${command}\nAllowed commands: ${allowedCommands.join(', ')}`
                );
            }
        }

        // 2. Blacklist check
        if (!allowDangerous) {
            // complete match
            for (const dangerous of DANGEROUS_COMMANDS) {
                if (lowerCmd.includes(dangerous.toLowerCase())) {
                    throw new Error(`Dangerous command blocked: ${command}`);
                }
            }
            // prefix matching
            for (const prefix of DANGEROUS_PREFIXES) {
                if (lowerCmd.startsWith(prefix.toLowerCase())) {
                    throw new Error(`Dangerous command blocked: ${command}`);
                }
            }
        }

        // 3. Customized blacklist
        for (const blocked of blockedCommands) {
            if (lowerCmd.includes(blocked.toLowerCase())) {
                throw new Error(`Command blocked: ${command}`);
            }
        }
    }

    /**
     * cwd security check: make sure the working directory is within the allowed range
     */
    function checkCwd(workDir: string | undefined): void {
        const currentAllowedCwdPaths = typeof allowedCwdPaths === 'function'
            ? allowedCwdPaths()
            : allowedCwdPaths;
        if (!workDir || !currentAllowedCwdPaths || currentAllowedCwdPaths.length === 0) return;

        const defaultBase = typeof cwd === 'function' ? cwd() : (cwd || process.cwd());
        // Relative paths automatically resolve to absolute paths
        const absoluteWorkDir = isAbsolute(workDir) ? workDir : resolve(defaultBase, workDir);
        const allowed = currentAllowedCwdPaths.some(p => {
            const resolved = isAbsolute(p) ? p : resolve(defaultBase, p);
            return isPathWithinBoundary(absoluteWorkDir, resolved);
        });
        if (!allowed) {
            const resolvedHints = currentAllowedCwdPaths.map(p => {
                return isAbsolute(p) ? p : resolve(defaultBase, p);
            });
            throw new Error(
                `Working directory is not in the allowed range: ${workDir}\nAllowed directories: ${resolvedHints.join(', ')}`
            );
        }
    }

    const WINDOWS_QUOTED_ABSOLUTE_PATH = /["']([A-Za-z]:[\\/][^"']+)["']/g;
    const WINDOWS_BARE_ABSOLUTE_PATH = /(?:^|[\s=,(;])([A-Za-z]:[\\/][^\s"'|;&)]*)/g;
    const POSIX_QUOTED_ABSOLUTE_PATH = /["'](\/(?!\/)[^"']+)["']/g;
    const POSIX_BARE_ABSOLUTE_PATH = /(?:^|[\s=,(;])(\/(?!\/)[^\s"'|;&)]*)/g;
    const PARENT_TRAVERSAL = /(?:^|[\\/\s"'=])\.\.(?:[\\/]|$)/;
    const HOME_ALIAS = /(?:^|[\s"'=,(])~(?:[\\/]|$)/;
    const ROOT_DIRECTORY_CHANGE = /\b(?:cd|chdir|set-location|sl|pushd)\s+["']?[\\/](?:["']?(?:\s|$))/i;
    const SENSITIVE_ENV_ACCESS = /(?:\$env:|%|\$\{?)(?:APPDATA|LOCALAPPDATA|USERPROFILE|HOME|HOMEDRIVE|HOMEPATH|PROGRAMDATA|PROGRAMFILES|WINDIR|SYSTEMROOT|TEMP|TMP|[^\s}%$]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[^\s}%$]*)(?:%|\}?\b)/i;
    const ENV_ENUMERATION = /(?:Get-ChildItem|gci|dir)\s+env:|\bGetEnvironmentVariables?\s*\(|(?:^|[;&|]\s*)(?:printenv|env)\s*(?:$|[;&|])|(?:^|[;&|]\s*)set(?:\s+[A-Za-z_][A-Za-z0-9_]*)?\s*(?:$|[;&|])/i;

    function activePathBoundary(): string | undefined {
        const value = typeof pathBoundary === 'function' ? pathBoundary() : pathBoundary;
        return value?.trim() || undefined;
    }

    function activeAllowedExternalPaths(): string[] {
        const value = typeof allowedExternalPaths === 'function'
            ? allowedExternalPaths()
            : allowedExternalPaths;
        return (value || []).filter(path => !!path?.trim());
    }

    /**
     * Executable locations are runtime infrastructure, not project content.
     * On Windows the executable extension is authoritative; on POSIX require
     * an existing executable file so arbitrary absolute data paths stay blocked.
     */
    function isRuntimeExecutable(candidate: string): boolean {
        try {
            if (!statSync(candidate).isFile()) return false;
            if (process.platform === 'win32') {
                return ['.exe', '.com', '.cmd', '.bat'].includes(extname(candidate).toLowerCase());
            }
            accessSync(candidate, constants.X_OK);
            return true;
        } catch {
            return false;
        }
    }

    function extractAbsolutePaths(value: string): string[] {
        const matches: string[] = [];
        const patterns = process.platform === 'win32'
            ? [WINDOWS_QUOTED_ABSOLUTE_PATH, WINDOWS_BARE_ABSOLUTE_PATH]
            : [POSIX_QUOTED_ABSOLUTE_PATH, POSIX_BARE_ABSOLUTE_PATH];
        for (const pattern of patterns) {
            pattern.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = pattern.exec(value)) !== null) {
                const candidate = match[1]?.trim();
                if (candidate && !matches.includes(candidate)) matches.push(candidate);
            }
        }
        return matches;
    }

    function checkCommandBoundary(command: string, commandArgs: string[] = []): void {
        const boundary = activePathBoundary();
        if (!boundary) return;
        const combined = [command, ...commandArgs].join(' ');

        if (PARENT_TRAVERSAL.test(combined) || HOME_ALIAS.test(combined) || ROOT_DIRECTORY_CHANGE.test(combined)) {
            throw new Error(`Project command cannot traverse outside its workspace: ${boundary}`);
        }
        if (SENSITIVE_ENV_ACCESS.test(combined) || ENV_ENUMERATION.test(combined)) {
            throw new Error('Project command cannot inspect application, system, or secret-bearing environment variables');
        }
        const externalInputs = activeAllowedExternalPaths();
        for (const candidate of extractAbsolutePaths(combined)) {
            const allowedInput = externalInputs.some(path => isPathWithinBoundary(candidate, path));
            if (!isPathWithinBoundary(candidate, boundary) && !allowedInput && !isRuntimeExecutable(candidate)) {
                throw new Error(`Command path is outside the project workspace: ${candidate}\nProject workspace: ${boundary}`);
            }
        }
    }

    return {
        name: 'process',
        priority: 40,
        description: `Process and command execution tool. Supported actions: ${PROCESS_ACTIONS.join(', ')}`,
        parameters: {
            action: {
                type: 'string',
                description: `Action type: ${PROCESS_ACTIONS.join('/')}`,
                required: true,
                enum: [...PROCESS_ACTIONS],
            },
            command: {
                type: 'string',
                description: 'Command to execute',
                required: true,
            },
            args: {
                type: 'array',
                description: 'Command arguments array (for spawn action)',
                items: { type: 'string' },
            },
            pid: {
                type: 'number',
                description: 'Process PID (for kill action)',
            },
            cwd: {
                type: 'string',
                description: 'Working directory',
            },
            timeout: {
                type: 'number',
                description: 'Timeout in milliseconds',
            },
            env: {
                type: 'object',
                description: 'Environment variables',
            },
        },

        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
            const action = validateAction(args, PROCESS_ACTIONS);
            const command = readStringParam(args, 'command', { required: true, label: 'command' });
            const commandArgs = readStringArrayParam(args, 'args') || [];
            const defaultCwd = typeof cwd === 'function' ? cwd() : cwd;
            const rawWorkDir = readStringParam(args, 'cwd') || defaultCwd;
            // Relative paths automatically resolve to absolute paths (relative to the default working directory)
            const workDir = rawWorkDir && !isAbsolute(rawWorkDir) && defaultCwd
                ? resolve(defaultCwd, rawWorkDir)
                : rawWorkDir;
            const cmdTimeout = readNumberParam(args, 'timeout', { integer: true }) || timeout;

            // security check
            checkCommand(command);
            checkCwd(workDir);
            checkCommandBoundary(command, commandArgs);

            // Make sure the working directory exists only after it has passed
            // the boundary check; rejected commands must not create directories.
            if (workDir && !existsSync(workDir)) {
                try { mkdirSync(workDir, { recursive: true }); } catch { /* ignore */ }
            }

            // Python command interception and replacement (after security check, ensure the original command is verified first)
            const resolvedCommand = resolvePythonCommand(command);

            // Windows UTF-8 encoding support
            const isWindows = process.platform === 'win32';
            const utf8Env = isWindows ? {
                ...process.env,
                PYTHONIOENCODING: 'utf-8',
                PYTHONUTF8: '1',
            } : process.env;

            /**
             * Command preprocessing:
             * 1. Add chcp 65001 under Windows to ensure the encoding is correct (single line command)
             * 2. Detect python -c "multiline code" mode, extract the code, and execute it from a temporary file
             *    Reason: cmd.exe cannot pass a string containing a newline as a single parameter to -c, causing silent failure
             */
            const wrapCommand = (cmd: string): string => {
                // Detect python -c "..." multi-line code mode
                // Matches python[3] [path] -c "code" or python[3] [path] -c 'code' (including newlines)
                if (isWindows && cmd.includes('\n')) {
                    const pyInlineMatch = cmd.match(/^(.*?python(?:3|\.exe)?[^\n]*?)\s+-c\s+["'](.+)["']\s*$/s);
                    if (pyInlineMatch) {
                        const pyCmd = pyInlineMatch[1].trim();
                        const code = pyInlineMatch[2];
                        // Write to temporary file
                        const { writeFileSync, mkdirSync } = require('fs');
                        const { join } = require('path');
                        const tmpDir = process.env.TEMP || process.env.TMP || 'C:\\Temp';
                        try { mkdirSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
                        const tmpFile = join(tmpDir, `_openflux_py_${Date.now()}.py`);
                        writeFileSync(tmpFile, code, 'utf-8');
                        const wrapped = `chcp 65001 > nul && "${pyCmd.includes('"') ? pyCmd : pyCmd}" "${tmpFile}"`;
                        log.debug('Multi-line python -c rewritten to temp file', { tmpFile });
                        return wrapped;
                    }
                    // Other multi-line commands: do not add chcp (chcp can only put the first line), return directly
                    return cmd;
                }
                // Single line command plus chcp 65001
                if (isWindows && !cmd.startsWith('chcp ')) {
                    return `chcp 65001 > nul && ${cmd}`;
                }
                return cmd;
            };


            // Check if executed using Docker
            const useDocker = action !== 'spawn' && await checkDockerAvailable();

            switch (action) {
                // Run the command and wait for the results
                case 'run': {
                    // Docker mode
                    if (useDocker && dockerExecutor) {
                        try {
                            // File change detection: pre-execution snapshot
                            const snapshotDir = workDir || process.cwd();
                            const runStartMs = Date.now();
                            let beforeSnapshot;
                            try { beforeSnapshot = await snapshotDirectory(snapshotDir); } catch { /* ignore */ }

                            const result = await dockerExecutor.exec(command, {
                                workspaceMount: workDir || process.cwd(),
                                timeout: cmdTimeout,
                            });

                            // File change detection
                            let generatedFiles: GeneratedFile[] | undefined = undefined;
                            if (beforeSnapshot) {
                                try {
                                    const afterSnapshot = await snapshotDirectory(snapshotDir);
                                    generatedFiles = diffSnapshots(beforeSnapshot, afterSnapshot);
                                } catch { /* ignore */ }
                            }
                            generatedFiles = mergeStdoutFiles(generatedFiles, result.stdout, snapshotDir, runStartMs);

                            return jsonResult({
                                command,
                                stdout: result.stdout,
                                stderr: result.stderr,
                                exitCode: result.exitCode,
                                sandbox: 'docker',
                                ...(generatedFiles?.length ? { generatedFiles } : {}),
                            });
                        } catch (error: any) {
                            return errorResult(`Docker execution failed: ${error.message}`);
                        }
                    }

                    // local mode
                    const snapshotDir = workDir || process.cwd();
                    const runStartMs = Date.now();
                    let beforeSnapshot;
                    try {
                        beforeSnapshot = await snapshotDirectory(snapshotDir);
                    } catch { /* ignore */ }

                    try {
                        const { stdout, stderr } = await execWithClosedStdin(wrapCommand(resolvedCommand), {
                            cwd: workDir,
                            timeout: cmdTimeout,
                            maxBuffer,
                            windowsHide: true,
                            env: utf8Env,
                            encoding: 'buffer',
                        });

                        const decodedStdout = decodeProcessOutput(stdout as unknown as Buffer).trim();
                        let generatedFiles: GeneratedFile[] | undefined = undefined;
                        if (beforeSnapshot) {
                            try {
                                const afterSnapshot = await snapshotDirectory(snapshotDir);
                                generatedFiles = diffSnapshots(beforeSnapshot, afterSnapshot);
                            } catch { /* ignore */ }
                        }
                        generatedFiles = mergeStdoutFiles(generatedFiles, decodedStdout, snapshotDir, runStartMs);

                        return jsonResult({
                            command,
                            stdout: decodedStdout,
                            stderr: decodeProcessOutput(stderr as unknown as Buffer).trim(),
                            exitCode: 0,
                            sandbox: 'local',
                            ...(generatedFiles?.length ? { generatedFiles } : {}),
                        });
                    } catch (error: any) {
                        if (error.killed) {
                            return errorResult(`Command timed out (${cmdTimeout}ms)`);
                        }

                        const decodedStdout = decodeProcessOutput(error.stdout).trim();
                        let generatedFiles: GeneratedFile[] | undefined = undefined;
                        if (beforeSnapshot) {
                            try {
                                const afterSnapshot = await snapshotDirectory(snapshotDir);
                                generatedFiles = diffSnapshots(beforeSnapshot, afterSnapshot);
                            } catch { /* ignore */ }
                        }
                        generatedFiles = mergeStdoutFiles(generatedFiles, decodedStdout, snapshotDir, runStartMs);

                        return jsonResult({
                            command,
                            stdout: decodedStdout,
                            stderr: decodeProcessOutput(error.stderr) || error.message,
                            exitCode: error.code || 1,
                            error: error.message,
                            sandbox: 'local',
                            ...(generatedFiles?.length ? { generatedFiles } : {}),
                        });
                    }
                }

                // Start a background process (always executed locally)
                case 'spawn': {
                    const cmdArgs = commandArgs;
                    try {
                        // If LLM passes a complete command string (such as "python app.py"), it will be automatically split
                        let spawnCmd = resolvePythonCommand(command);
                        let spawnArgs = cmdArgs;
                        if (spawnArgs.length === 0 && command.includes(' ')) {
                            // Process paths wrapped in quotes: such as '"C:\path\python.exe" app.py'
                            const match = command.match(/^"([^"]+)"\s*(.*)?$/);
                            if (match) {
                                spawnCmd = match[1];
                                spawnArgs = match[2] ? match[2].split(/\s+/).filter(Boolean) : [];
                            } else {
                                const parts = command.split(/\s+/);
                                spawnCmd = parts[0];
                                spawnArgs = parts.slice(1);
                            }
                        }
                        // Remove possible wrapping quotes
                        spawnCmd = spawnCmd.replace(/^"|"$/g, '');

                        const child = spawn(spawnCmd, spawnArgs, {
                            cwd: workDir,
                            detached: true,
                            stdio: 'ignore',
                            windowsHide: true,
                        });

                        // Wrap spawn results with Promise: wait a short time to confirm whether the process startup is successful or failed
                        const result = await new Promise<ToolResult>((resolve) => {
                            let settled = false;
                            child.on('error', (err: Error) => {
                                if (!settled) {
                                    settled = true;
                                    resolve(errorResult(`Failed to start process: ${err.message}`));
                                }
                            });
                            // If there is no error within 200ms, the startup is considered successful.
                            setTimeout(() => {
                                if (!settled) {
                                    settled = true;
                                    child.unref();
                                    const pid = child.pid!;
                                    // Record the spawned process and associate the session
                                    spawnedProcesses.set(pid, {
                                        pid,
                                        command: spawnCmd,
                                        args: spawnArgs,
                                        cwd: workDir,
                                        sessionId: opts.getSessionId?.(),
                                        startTime: Date.now(),
                                    });
                                    log.info('Background process started', { pid, command: spawnCmd, args: spawnArgs });
                                    resolve(jsonResult({
                                        command: spawnCmd,
                                        args: spawnArgs,
                                        pid,
                                        spawned: true,
                                    }));
                                }
                            }, 200);
                        });
                        return result;
                    } catch (error: any) {
                        return errorResult(`Failed to start process: ${error.message}`);
                    }
                }

                // Terminate a started process
                case 'kill': {
                    const pid = readNumberParam(args, 'pid', { integer: true });
                    if (!pid) {
                        return errorResult('Please provide the PID of the process to terminate');
                    }
                    const proc = spawnedProcesses.get(pid);
                    try {
                        // Windows uses taskkill to forcefully terminate the process tree, other platforms use SIGTERM
                        if (process.platform === 'win32') {
                            await execAsync(`taskkill /PID ${pid} /T /F`, { windowsHide: true }).catch(() => {
                                // When taskkill fails try process.kill
                                processKill(pid);
                            });
                        } else {
                            processKill(pid, 'SIGTERM');
                        }
                        spawnedProcesses.delete(pid);
                        log.info('Background process terminated', { pid, command: proc?.command });
                        return jsonResult({
                            pid,
                            killed: true,
                            command: proc?.command || 'unknown',
                            sessionId: proc?.sessionId,
                        });
                    } catch (error: any) {
                        // The process may have exited
                        spawnedProcesses.delete(pid);
                        return errorResult(`Failed to terminate process (PID: ${pid}): ${error.message}`);
                    }
                }

                // List started background processes
                case 'list': {
                    // Check which processes are still alive
                    const alive: SpawnedProcess[] = [];
                    for (const [pid, proc] of spawnedProcesses) {
                        try {
                            processKill(pid, 0); // Signal 0 only detects whether the process exists
                            alive.push(proc);
                        } catch {
                            spawnedProcesses.delete(pid); // Exited, clean
                        }
                    }
                    return jsonResult({
                        processes: alive.map(p => ({
                            pid: p.pid,
                            command: p.command,
                            args: p.args,
                            cwd: p.cwd,
                            sessionId: p.sessionId,
                            startTime: new Date(p.startTime).toISOString(),
                            uptime: Math.round((Date.now() - p.startTime) / 1000) + 's',
                        })),
                        count: alive.length,
                    });
                }


                // Execute in shell
                case 'shell': {
                    // Docker mode
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
                            return errorResult(`Docker execution failed: ${error.message}`);
                        }
                    }

                    // local mode
                    try {
                        const { stdout, stderr } = await execWithClosedStdin(wrapCommand(resolvedCommand), {
                            cwd: workDir,
                            timeout: cmdTimeout,
                            maxBuffer,
                            shell: isWindows ? 'cmd.exe' : '/bin/sh',
                            windowsHide: true,
                            env: utf8Env,
                            encoding: 'buffer',
                        });
                        return jsonResult({
                            command,
                            stdout: decodeProcessOutput(stdout as unknown as Buffer).trim(),
                            stderr: decodeProcessOutput(stderr as unknown as Buffer).trim(),
                            exitCode: 0,
                            sandbox: 'local',
                        });
                    } catch (error: any) {
                        return jsonResult({
                            command,
                            stdout: decodeProcessOutput(error.stdout).trim(),
                            stderr: decodeProcessOutput(error.stderr) || error.message,
                            exitCode: error.code || 1,
                            sandbox: 'local',
                        });
                    }
                }

                default:
                    return errorResult(`Unknown action: ${action}`);
            }
        },
    };
}
