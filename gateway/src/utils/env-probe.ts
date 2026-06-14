/**
 * Gateway starts environment detection
 *
 * The operating system environment is detected once when the Gateway is started for use by the Agent when running.
 * Problem solved: agents previously discovered incorrect basic tools or time zones only during task execution.
 * Waste LLM iterations fixing a problem that could have been known about in advance.
 *
 * Current detection items:
 *   1. System Time Zone & Locale (replace the hard-coded zh-CN / Asia/Shanghai)
 *   2. Installed key CLI tools (git, ffmpeg, 7z, node, npm, curl, etc.)
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { Logger } from './logger';

const log = new Logger('EnvProbe');

// ============================================================
// type definition
// ============================================================

export interface SystemLocaleInfo {
    /** IANA time zone name, such as 'Asia/Shanghai', 'America/New_York' */
    timezone: string;
    /** BCP 47 locale tags, such as 'zh-CN', 'en-US' */
    locale: string;
    /** Whether it is a Chinese environment */
    isChinese: boolean;
}

export interface CliToolInfo {
    /** Tool name */
    name: string;
    /** Available */
    available: boolean;
    /** Executable file path (when available) */
    path?: string;
    /** Version string (when available, some tools) */
    version?: string;
}

export interface EnvProbeResult {
    locale: SystemLocaleInfo;
    tools: Record<string, CliToolInfo>;
    /** Built-in Python executable path (injected from Gateway Python env) */
    builtinPython?: string;
    /** system prompt injection fragment (already formatted, can be appended directly) */
    systemPromptHint: string;
}

// ============================================================
// global cache
// ============================================================

let _probeResult: EnvProbeResult | null = null;

// List of CLI tools that need to be detected (search within PATH)
const CLI_TOOLS = [
    'git',
    'ffmpeg',
    'ffprobe',
    '7z',
    'node',
    'npm',
    'npx',
    'curl',
    'wget',
    'pandoc',
    'convert',   // ImageMagick
    'tesseract',
    'python3',
] as const;

type CliToolName = typeof CLI_TOOLS[number];

/**
 * Fixed installation path detection table for common Windows software
 * When not found in PATH, try these standard paths
 */
const WINDOWS_FIXED_PATHS: Array<{ key: string; path: string; desc?: string }> = [
    // Unzip tool
    { key: '7z',       path: 'C:\\Program Files\\7-Zip\\7z.exe',              desc: '7-Zip' },
    { key: '7z',       path: 'C:\\Program Files (x86)\\7-Zip\\7z.exe',        desc: '7-Zip (x86)' },
    { key: 'unrar',    path: 'C:\\Program Files\\WinRAR\\UnRAR.exe',           desc: 'WinRAR UnRAR' },
    { key: 'winrar',   path: 'C:\\Program Files\\WinRAR\\WinRAR.exe',          desc: 'WinRAR' },
    { key: 'winrar',   path: 'C:\\Program Files (x86)\\WinRAR\\WinRAR.exe' },
    { key: 'bandizip', path: 'C:\\Program Files\\Bandizip\\Bandizip.exe',      desc: 'Bandizip' },
    { key: 'bandizip', path: 'C:\\Program Files (x86)\\Bandizip\\Bandizip.exe' },
    // media tools
    { key: 'ffmpeg',   path: 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe' },
    { key: 'ffmpeg',   path: 'C:\\ffmpeg\\bin\\ffmpeg.exe' },
    // OCR
    { key: 'tesseract', path: 'C:\\Program Files\\Tesseract-OCR\\tesseract.exe' },
    { key: 'tesseract', path: 'C:\\Program Files (x86)\\Tesseract-OCR\\tesseract.exe' },
    // Document conversion
    { key: 'pandoc',   path: 'C:\\Program Files\\Pandoc\\pandoc.exe' },
    // Git
    { key: 'git',      path: 'C:\\Program Files\\Git\\bin\\git.exe' },
    { key: 'git',      path: 'C:\\Program Files (x86)\\Git\\bin\\git.exe' },
];

/**
 * macOS Homebrew installation path detection table
 * The shell PATH of some systems does not contain the Homebrew path and requires a common installation directory.
 */
const MAC_FIXED_PATHS: Array<{ key: string; path: string; desc?: string }> = [
    // Homebrew (Apple Silicon)
    { key: '7z',        path: '/opt/homebrew/bin/7z',        desc: '7-Zip (Homebrew)' },
    { key: 'unrar',     path: '/opt/homebrew/bin/unrar',     desc: 'unrar (Homebrew)' },
    { key: 'ffmpeg',    path: '/opt/homebrew/bin/ffmpeg',    desc: 'ffmpeg (Homebrew)' },
    { key: 'tesseract', path: '/opt/homebrew/bin/tesseract', desc: 'Tesseract (Homebrew)' },
    { key: 'pandoc',    path: '/opt/homebrew/bin/pandoc',    desc: 'pandoc (Homebrew)' },
    { key: 'git',       path: '/opt/homebrew/bin/git',       desc: 'git (Homebrew)' },
    // Homebrew (Intel Mac)
    { key: '7z',        path: '/usr/local/bin/7z' },
    { key: 'unrar',     path: '/usr/local/bin/unrar' },
    { key: 'ffmpeg',    path: '/usr/local/bin/ffmpeg' },
    { key: 'tesseract', path: '/usr/local/bin/tesseract' },
    { key: 'pandoc',    path: '/usr/local/bin/pandoc' },
    { key: 'git',       path: '/usr/local/bin/git' },
    // macOS built-in tools
    { key: 'git',       path: '/usr/bin/git',               desc: 'Xcode git' },
];

// ============================================================
// Time Zone & Locale Detection
// ============================================================

function detectLocale(): SystemLocaleInfo {
    try {
        const resolved = Intl.DateTimeFormat().resolvedOptions();
        const timezone = resolved.timeZone || 'UTC';
        const locale = resolved.locale || 'en-US';
        const isChinese = locale.startsWith('zh') ||
            timezone.startsWith('Asia/Shanghai') ||
            timezone.startsWith('Asia/Chongqing') ||
            timezone.startsWith('Asia/Harbin') ||
            timezone.startsWith('Asia/Urumqi');

        log.info('System locale detected', { timezone, locale, isChinese });
        return { timezone, locale, isChinese };
    } catch (err: any) {
        log.warn('Locale detection failed, defaulting to UTC/en-US', { error: err.message });
        return { timezone: 'UTC', locale: 'en-US', isChinese: false };
    }
}

// ============================================================
// CLI tool detection
// ============================================================

function detectOneTool(name: string): CliToolInfo {
    const isWindows = process.platform === 'win32';
    const findCmd = isWindows ? `where ${name} 2>nul` : `which ${name} 2>/dev/null`;

    try {
        const foundPath = execSync(findCmd, {
            windowsHide: true,
            timeout: 3000,
            encoding: 'utf-8',
        }).trim().split('\n')[0].trim();

        if (!foundPath) throw new Error('not found in PATH');

        // Try to get the version
        let version: string | undefined;
        const versionCmds: Partial<Record<string, string>> = {
            git:      'git --version',
            ffmpeg:   'ffmpeg -version 2>&1',
            node:     'node --version',
            npm:      'npm --version',
            curl:     'curl --version 2>&1',
            pandoc:   'pandoc --version 2>&1',
            '7z':     '7z i 2>&1',
            python3:  'python3 --version',
            python:   'python --version',
        };
        if (versionCmds[name]) {
            try {
                version = execSync(versionCmds[name]!, {
                    windowsHide: true, timeout: 3000, encoding: 'utf-8',
                }).trim().split('\n')[0].slice(0, 80);
            } catch { /* Failure to obtain version does not affect availability */ }
        }

        return { name, available: true, path: foundPath, version };
    } catch {
        // Not found in PATH -> Scan the fixed installation path for Windows additionally
        return { name, available: false };
    }
}

/** Scan the fixed installation path table for tools that are not in PATH (common to Win/Mac) */
function detectFixedPaths(table: Array<{ key: string; path: string; desc?: string }>): Record<string, CliToolInfo> {
    const extras: Record<string, CliToolInfo> = {};
    for (const entry of table) {
        if (extras[entry.key]?.available) continue;
        try {
            if (existsSync(entry.path)) {
                extras[entry.key] = {
                    name: entry.key,
                    available: true,
                    path: entry.path,
                    version: entry.desc,
                };
                log.info(`Fixed-path tool found: ${entry.key}`, { path: entry.path });
            }
        } catch { /* ignore */ }
    }
    return extras;
}

function detectCliTools(): Record<string, CliToolInfo> {
    const isWin = process.platform === 'win32';
    const isMac = process.platform === 'darwin';

    const toolsToDetect = [...CLI_TOOLS] as string[];
    if (isWin) {
        toolsToDetect.push('python', 'unrar', 'winrar', 'bandizip');
    } else if (isMac) {
        toolsToDetect.push('python3', 'python', 'unrar', 'brew');
    }

    const results: Record<string, CliToolInfo> = {};
    for (const tool of toolsToDetect) {
        results[tool] = detectOneTool(tool);
    }

    // Tools not found in PATH, additionally scan the fixed installation path
    const fixedTable = isWin ? WINDOWS_FIXED_PATHS : isMac ? MAC_FIXED_PATHS : [];
    if (fixedTable.length > 0) {
        const fixedResults = detectFixedPaths(fixedTable);
        for (const [key, info] of Object.entries(fixedResults)) {
            if (!results[key]?.available) {
                results[key] = info;
            }
        }
    }

    const available = Object.values(results).filter(t => t.available).map(t => t.name);
    const missing = Object.values(results).filter(t => !t.available).map(t => t.name);
    log.info('CLI tools detected', { available, missing });

    return results;
}

// ============================================================
// system prompt injection fragment
// ============================================================

function buildSystemPromptHint(
    locale: SystemLocaleInfo,
    tools: Record<string, CliToolInfo>,
    builtinPython?: string,
): string {
    const lines: string[] = [];

    lines.push('## System Environment');
    lines.push(`- Timezone: ${locale.timezone} | Locale: ${locale.locale}`);

    // Built-in Python path - put it in the most conspicuous position to prevent the agent from trying to find or use the system Python
    if (builtinPython) {
        lines.push(`- ⚠️ Built-in Python (ALWAYS use this exact path, do NOT use system python/python3/conda): "${builtinPython}"`);
    }

    // Determine whether a tool is in PATH (or scanned through a fixed path)
    const isFixedPath = (t: CliToolInfo) => {
        if (!t.path) return false;
        if (t.path.match(/^[A-Za-z]:\\/)) return true;
        if (t.path.startsWith('/opt/homebrew') || t.path.startsWith('/usr/local')) return true;
        return false;
    };

    const inPath = Object.values(tools)
        .filter(t => t.available && !isFixedPath(t))
        .map(t => t.version ? `${t.name} (${t.version})` : t.name);

    const fixedPath = Object.values(tools)
        .filter(t => t.available && isFixedPath(t))
        .map(t => `${t.name} → "${t.path}"`);

    const missing = Object.values(tools)
        .filter(t => !t.available)
        .map(t => t.name);

    if (inPath.length > 0) {
        lines.push(`- Available CLI tools (use by name): ${inPath.join(', ')}`);
    }
    if (fixedPath.length > 0) {
        lines.push(`- Available tools (NOT in PATH, use full path): ${fixedPath.join('; ')}`);
    }
    if (missing.length > 0) {
        lines.push(`- ⚠️ NOT found (do NOT use without verifying): ${missing.join(', ')}`);
    }

    return lines.join('\n');
}

// ============================================================
// main entrance
// ============================================================

/**
 * Execute environment detection (called once when Gateway starts)
 * The results are cached in module global variables and subsequently obtained using getEnvProbe()
 * @param builtinPython Built-in Python executable path (from Gateway Python env setup)
 */
export function runEnvProbe(builtinPython?: string): EnvProbeResult {
    log.info('Running environment probe...');

    const locale = detectLocale();
    const tools = detectCliTools();
    const systemPromptHint = buildSystemPromptHint(locale, tools, builtinPython);

    _probeResult = { locale, tools, builtinPython, systemPromptHint };
    return _probeResult;
}

/**
 * Get cached detection results (called at any time after startup)
 * If not detected, return a safe default value
 */
export function getEnvProbe(): EnvProbeResult {
    if (_probeResult) return _probeResult;

    // Not detected (theoretically should not happen), returns the minimum default value
    const locale: SystemLocaleInfo = {
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        locale: Intl.DateTimeFormat().resolvedOptions().locale || 'en-US',
        isChinese: false,
    };
    return {
        locale,
        tools: {},
        systemPromptHint: `## System Environment\n- Timezone: ${locale.timezone}`,
    };
}

/**
 * After the Python environment is ready, inject the built-in Python path into the cached result and regenerate the system prompt hint
 * (runEnvProbe runs before the Python environment is initialized, so it needs to be injected afterwards)
 */
export function updateEnvProbeBuiltinPython(pythonExe: string): void {
    if (!_probeResult) return;
    _probeResult.builtinPython = pythonExe;
    _probeResult.systemPromptHint = buildSystemPromptHint(_probeResult.locale, _probeResult.tools, pythonExe);
    log.info('Env-probe updated with built-in Python path', { pythonExe });
}


/**
 * Convenience function: formats the current time (using the system-detected time zone)
 * Replace all hardcoded 'Asia/Shanghai'
 */
export function formatNow(opts?: Intl.DateTimeFormatOptions): string {
    const { timezone, locale } = getEnvProbe().locale;
    const now = new Date();
    const defaultOpts: Intl.DateTimeFormatOptions = {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        weekday: 'long',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        ...opts,
    };
    return now.toLocaleString(locale, defaultOpts);
}

/**
 * Convenience function: Get today's date string YYYY-MM-DD (using system time zone)
 * Replace all hardcoded { timeZone: 'Asia/Shanghai' }
 */
export function getTodayStr(): string {
    const { timezone } = getEnvProbe().locale;
    return new Date().toLocaleDateString('sv-SE', { timeZone: timezone });
}

/**
 * Convenience function: format any Date (using system time zone)
 */
export function formatDate(date: Date | number | string, opts?: Intl.DateTimeFormatOptions): string {
    const { timezone, locale } = getEnvProbe().locale;
    const d = date instanceof Date ? date : new Date(date);
    return d.toLocaleString(locale, {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        ...opts,
    });
}
