/**
 * Process/Command Tool - Factory Mode
 * Supports local execution and Docker sandbox isolated execution
 */

import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { accessSync, constants, mkdirSync, existsSync, statSync } from 'fs';
import { extname, isAbsolute, resolve, normalize, join } from 'path';
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
import { getServiceRegistry, initServiceRegistry, looksLongRunning, agentIdFromSessionId } from '../../runtime/service-registry';
import { homedir } from 'os';

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

// Supported actions
const PROCESS_ACTIONS = [
    'run',       // Run the command and wait for the results
    'spawn',     // Start a managed long-running service (dev/API server, watcher)
    'kill',      // Stop a managed service (by id, name, pid or port)
    'restart',   // Stop + start a managed service again with the same command
    'list',      // List managed services and whether they are alive
    'status',    // Liveness + port probe of one managed service
    'logs',      // Tail a managed service's stdout/stderr log
    'wait',      // Block until a managed service is ready (port open / log match / exit)
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
    /** Where managed services (services.json + logs) are persisted. */
    serviceStoreDir?: string | (() => string);
    /** Project root of the running agent, recorded as the service owner. */
    getWorkspaceRoot?: () => string | undefined;
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

    function serviceRegistry() {
        const existing = getServiceRegistry();
        if (existing) return existing;
        const configured = typeof opts.serviceStoreDir === 'function' ? opts.serviceStoreDir() : opts.serviceStoreDir;
        return initServiceRegistry(configured || join(homedir(), '.openflux', 'services'));
    }

    function describeService(svc: import('../../runtime/service-registry').ManagedService, currentSessionId?: string) {
        return {
            id: svc.id,
            name: svc.name,
            status: svc.status,
            pid: svc.pid,
            port: svc.port,
            url: svc.url,
            command: [svc.command, ...svc.args].join(' '),
            cwd: svc.cwd,
            owner: { sessionId: svc.sessionId, agentId: svc.agentId, project: svc.workspaceRoot },
            mine: !!currentSessionId && svc.sessionId === currentSessionId,
            startedAt: new Date(svc.startedAt).toISOString(),
            uptime: svc.status === 'running' ? `${Math.round((Date.now() - svc.startedAt) / 1000)}s` : undefined,
            exitCode: svc.exitCode,
            logPath: svc.logPath,
            restartCount: svc.restartCount,
            keepAlive: svc.keepAlive === true,
        };
    }

    async function handleServiceAction(action: ProcessAction, args: Record<string, unknown>): Promise<ToolResult> {
        const registry = serviceRegistry();
        const sessionId = opts.getSessionId?.();
        const refRaw = readStringParam(args, 'id') || readNumberParam(args, 'pid', { integer: true }) || readStringParam(args, 'name') || readNumberParam(args, 'port', { integer: true });
        const ref = refRaw === undefined || refRaw === null || refRaw === '' ? undefined : (typeof refRaw === 'number' ? refRaw : String(refRaw));

        if (action === 'list') {
            // Running services are what the agent needs to decide "reuse or
            // start"; finished/stale records only add noise unless asked for.
            const includeHistory = args.all === true;
            const all = registry.list();
            const shown = includeHistory ? all : all.filter(svc => svc.status === 'running');
            const hidden = all.length - shown.length;
            return jsonResult({
                services: shown.map(svc => describeService(svc, sessionId)),
                running: all.filter(svc => svc.status === 'running').length,
                count: shown.length,
                hiddenHistory: includeHistory ? undefined : (hidden > 0 ? hidden : undefined),
                note: shown.length === 0
                    ? (hidden > 0
                        ? `No running managed services (${hidden} finished/stale records hidden; pass all=true to see them). Start servers with action=spawn.`
                        : 'No managed services. Start servers with action=spawn so they are tracked here.')
                    : undefined,
            });
        }
        if (ref === undefined) {
            return errorResult(`${action} needs a service reference: id, name, pid or port.`);
        }
        try {
            if (action === 'kill') {
                const svc = await registry.stop(ref);
                return jsonResult({ killed: true, service: describeService(svc, sessionId) });
            }
            if (action === 'restart') {
                const svc = await registry.restart(ref);
                return jsonResult({ restarted: true, service: describeService(svc, sessionId), recentOutput: registry.tailLog(svc, 20) });
            }
            if (action === 'status') {
                const { service, alive, portOpen } = await registry.status(ref);
                return jsonResult({
                    service: describeService(service, sessionId),
                    alive,
                    portOpen,
                    verdict: !alive ? 'process is not running' : portOpen === false ? 'process alive but port not accepting connections yet (see logs)' : portOpen ? 'serving' : 'alive (no port known)',
                    recentOutput: registry.tailLog(service, 15),
                });
            }
            if (action === 'logs') {
                const svc = registry.resolve(ref);
                if (!svc) return errorResult(`No managed service matches "${ref}"`);
                const lines = readNumberParam(args, 'lines', { integer: true }) || 80;
                return jsonResult({ service: describeService(svc, sessionId), lines, log: registry.tailLog(svc, lines) });
            }
            if (action === 'wait') {
                const untilRaw = readStringParam(args, 'until');
                const until = untilRaw === 'log' || untilRaw === 'exit' || untilRaw === 'port' ? untilRaw : undefined;
                const patternRaw = readStringParam(args, 'pattern');
                let pattern: RegExp | undefined;
                if (patternRaw) {
                    try { pattern = new RegExp(patternRaw, 'i'); } catch { return errorResult(`pattern is not a valid regular expression: ${patternRaw}`); }
                }
                if (until === 'log' && !pattern) return errorResult('wait with until=log needs a pattern');
                const timeoutSeconds = Math.min(600, Math.max(1, readNumberParam(args, 'timeoutSeconds') || 60));
                const outcome = await registry.waitFor(ref, { until, pattern, timeoutMs: timeoutSeconds * 1000 });
                return jsonResult({
                    satisfied: outcome.satisfied,
                    condition: outcome.condition,
                    elapsed: `${Math.round(outcome.elapsedMs / 1000)}s`,
                    matchedLine: outcome.matchedLine,
                    alive: outcome.alive,
                    portOpen: outcome.portOpen,
                    reason: outcome.reason,
                    service: describeService(outcome.service, sessionId),
                    note: outcome.satisfied ? undefined : 'Condition not met — check logs before retrying; do not assume the service is up.',
                });
            }
        } catch (error: any) {
            return errorResult(error.message);
        }
        return errorResult(`Unsupported service action: ${action}`);
    }

    return {
        name: 'process',
        priority: 40,
        description: [
            `Process and command execution tool. Supported actions: ${PROCESS_ACTIONS.join(', ')}.`,
            'run/shell execute a command and WAIT for it to finish; any child they start dies when the call returns.',
            'LONG-RUNNING SERVERS (npm run dev, vite, artisan serve, php -S, uvicorn, python -m http.server, watchers...) MUST use action=spawn: the process is detached, registered as a managed service owned by this conversation/project, its output goes to a log file, and it survives the call. run/shell reject such commands.',
            'Managed services: list (running services only, with ports and owners; all=true includes finished records), status (alive + port probe), logs (tail output; read this when a page will not load or a request fails), restart, kill. Refer to a service by id, name, pid or port. Before starting a server, list first: reuse one that is already running on the port instead of starting a duplicate.',
            'After spawn, call wait (until=port by default; or until=log with pattern, or until=exit) instead of polling status: it blocks up to timeoutSeconds (default 60) and returns satisfied=true/false with what was observed.',
        ].join(' '),
        parameters: {
            action: {
                type: 'string',
                description: `Action type: ${PROCESS_ACTIONS.join('/')}`,
                required: true,
                enum: [...PROCESS_ACTIONS],
            },
            command: {
                type: 'string',
                description: 'Command to execute (required for run/spawn/shell; not used by list/status/logs/restart/kill)',
                required: false,
            },
            args: {
                type: 'array',
                description: 'Command arguments array (for spawn action)',
                items: { type: 'string' },
            },
            pid: {
                type: 'number',
                description: 'Process PID (kill/restart/status/logs accept pid, or use id/name)',
            },
            id: {
                type: 'string',
                description: 'Managed service id, name, pid or port (for kill/restart/status/logs)',
            },
            name: {
                type: 'string',
                description: 'For spawn: a short name for the service, e.g. "frontend" or "api"',
            },
            port: {
                type: 'number',
                description: 'For spawn: the port the server will listen on (auto-detected from output if omitted)',
            },
            lines: {
                type: 'number',
                description: 'For logs: how many trailing lines to return (default 80)',
            },
            all: {
                type: 'boolean',
                description: 'For list: include finished/stale service records too (default: only running services)',
            },
            keepAlive: {
                type: 'boolean',
                description: 'For spawn: let the service outlive this conversation and the gateway (default false: it is stopped when the app/gateway shuts down, and reaped if found running after a crash). Leave it unset unless it is genuinely needed — the user asked for the service to stay up after the task, or something outside this task depends on it. Ordinary dev/test servers started to verify work must NOT set it.',
            },
            until: {
                type: 'string',
                description: 'For wait: what to wait for — port (default; the service port accepts connections), log (a line matching pattern), exit (the process ends)',
                enum: ['port', 'log', 'exit'],
            },
            pattern: {
                type: 'string',
                description: 'For wait with until=log: regular expression to look for in the service log',
            },
            timeoutSeconds: {
                type: 'number',
                description: 'For wait: give up after this many seconds (default 60, max 600)',
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
            const serviceAction = action === 'kill' || action === 'restart' || action === 'list' || action === 'status' || action === 'logs' || action === 'wait';
            const command = readStringParam(args, 'command', { required: !serviceAction, label: 'command' }) || '';
            if (serviceAction) {
                return await handleServiceAction(action, args);
            }
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

            // A server started by a one-shot run dies with the shell, and the
            // agent then keeps "restarting" a process that is already gone.
            if ((action === 'run' || action === 'shell') && looksLongRunning(command)) {
                return {
                    success: false,
                    code: 'LONG_RUNNING_COMMAND_NEEDS_SPAWN',
                    error: `"${command.slice(0, 120)}" is a long-running server/watcher. run/shell wait for exit and kill the child when they return, so it would not stay up. Start it with action=spawn instead (give name and port), e.g. {"action":"spawn","command":"npm","args":["run","dev","--","--host"],"cwd":"...","name":"frontend","port":5173}. Then use action=status / logs to verify it is serving. Check action=list first: a service may already be running on that port.`,
                };
            }

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

                // Start a managed long-running service (always executed locally)
                case 'spawn': {
                    const cmdArgs = commandArgs;
                    let spawnCmd = resolvePythonCommand(command);
                    let spawnArgs = cmdArgs;
                    if (spawnArgs.length === 0 && command.includes(' ')) {
                        // A full command string ("npm run dev"): split it, honouring a quoted executable.
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
                    spawnCmd = spawnCmd.replace(/^"|"$/g, '');
                    const registry = serviceRegistry();
                    const sessionId = opts.getSessionId?.();
                    const port = readNumberParam(args, 'port', { integer: true }) || undefined;
                    const name = readStringParam(args, 'name') || undefined;
                    const keepAlive = args.keepAlive === true;
                    const workspaceRoot = opts.getWorkspaceRoot?.();

                    // Reuse rather than duplicate: the same port already served by
                    // a live managed service is the agent forgetting it started one.
                    if (port) {
                        const existing = registry.list({ runningOnly: true }).find(svc => svc.port === port);
                        if (existing) {
                            const { alive, portOpen } = await registry.status(existing.id);
                            if (alive && portOpen !== false) {
                                return jsonResult({
                                    spawned: false,
                                    reused: true,
                                    service: describeService(existing, sessionId),
                                    note: `A managed service is already serving port ${port}; reusing it. Use action=restart with id "${existing.id}" if you changed its configuration.`,
                                });
                            }
                        }
                    }

                    try {
                        const service = await registry.start({
                            command: spawnCmd,
                            args: spawnArgs,
                            cwd: workDir || process.cwd(),
                            name,
                            port,
                            env: utf8Env,
                            sessionId,
                            agentId: agentIdFromSessionId(sessionId),
                            workspaceRoot,
                            keepAlive,
                        });
                        return jsonResult({
                            spawned: true,
                            pid: service.pid,
                            service: describeService(service, sessionId),
                            recentOutput: registry.tailLog(service, 20),
                            note: 'Registered as a managed service. Use action=status/logs (by id or name) to verify it is serving before telling the user it is up.',
                        });
                    } catch (error: any) {
                        return errorResult(`Failed to start service: ${error.message}`);
                    }
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
