/**
 * Gateway 启动环境探测
 *
 * 在 Gateway 启动时一次性检测操作系统环境，供 Agent 运行时使用。
 * 解决的问题：Agent 在任务执行过程中"踩坑"发现基础工具/时区不对，
 * 浪费 LLM 迭代次数来修复本可预先知道的问题。
 *
 * 当前检测项：
 *   1. 系统时区 & Locale（替换硬编码的 zh-CN / Asia/Shanghai）
 *   2. 已安装的关键 CLI 工具（git, ffmpeg, 7z, node, npm, curl 等）
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { Logger } from './logger';

const log = new Logger('EnvProbe');

// ============================================================
// 类型定义
// ============================================================

export interface SystemLocaleInfo {
    /** IANA 时区名，如 'Asia/Shanghai', 'America/New_York' */
    timezone: string;
    /** BCP 47 locale 标签，如 'zh-CN', 'en-US' */
    locale: string;
    /** 是否是中文环境 */
    isChinese: boolean;
}

export interface CliToolInfo {
    /** 工具名 */
    name: string;
    /** 是否可用 */
    available: boolean;
    /** 可执行文件路径（可用时） */
    path?: string;
    /** 版本字符串（可用时，部分工具） */
    version?: string;
}

export interface EnvProbeResult {
    locale: SystemLocaleInfo;
    tools: Record<string, CliToolInfo>;
    /** 内置 Python 可执行文件路径（从 Gateway Python env 注入） */
    builtinPython?: string;
    /** system prompt 注入片段（已格式化好，可直接追加） */
    systemPromptHint: string;
}

// ============================================================
// 全局缓存
// ============================================================

let _probeResult: EnvProbeResult | null = null;

// 需要探测的 CLI 工具列表（PATH 内查找）
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
 * Windows 常见软件的固定安装路径探测表
 * PATH 里找不到时，尝试这些标准路径
 */
const WINDOWS_FIXED_PATHS: Array<{ key: string; path: string; desc?: string }> = [
    // 解压工具
    { key: '7z',       path: 'C:\\Program Files\\7-Zip\\7z.exe',              desc: '7-Zip' },
    { key: '7z',       path: 'C:\\Program Files (x86)\\7-Zip\\7z.exe',        desc: '7-Zip (x86)' },
    { key: 'unrar',    path: 'C:\\Program Files\\WinRAR\\UnRAR.exe',           desc: 'WinRAR UnRAR' },
    { key: 'winrar',   path: 'C:\\Program Files\\WinRAR\\WinRAR.exe',          desc: 'WinRAR' },
    { key: 'winrar',   path: 'C:\\Program Files (x86)\\WinRAR\\WinRAR.exe' },
    { key: 'bandizip', path: 'C:\\Program Files\\Bandizip\\Bandizip.exe',      desc: 'Bandizip' },
    { key: 'bandizip', path: 'C:\\Program Files (x86)\\Bandizip\\Bandizip.exe' },
    // 媒体工具
    { key: 'ffmpeg',   path: 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe' },
    { key: 'ffmpeg',   path: 'C:\\ffmpeg\\bin\\ffmpeg.exe' },
    // OCR
    { key: 'tesseract', path: 'C:\\Program Files\\Tesseract-OCR\\tesseract.exe' },
    { key: 'tesseract', path: 'C:\\Program Files (x86)\\Tesseract-OCR\\tesseract.exe' },
    // 文档转换
    { key: 'pandoc',   path: 'C:\\Program Files\\Pandoc\\pandoc.exe' },
    // Git
    { key: 'git',      path: 'C:\\Program Files\\Git\\bin\\git.exe' },
    { key: 'git',      path: 'C:\\Program Files (x86)\\Git\\bin\\git.exe' },
];

/**
 * macOS Homebrew 安装路径探测表
 * 部分系统的 shell PATH 不包含 Homebrew 路径，需要常见安装目录尕
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
    // macOS 内置工具
    { key: 'git',       path: '/usr/bin/git',               desc: 'Xcode git' },
];

// ============================================================
// 时区 & Locale 检测
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
// CLI 工具检测
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

        // 尝试获取版本
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
            } catch { /* 版本获取失败不影响可用性 */ }
        }

        return { name, available: true, path: foundPath, version };
    } catch {
        // PATH 里没找到 → 对 Windows 额外扫固定安装路径
        return { name, available: false };
    }
}

/** 在固定安装路径表中扫描不在 PATH 里的工具（Win/Mac 通用） */
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

    // PATH 里找不到的工具，额外扫固定安装路径
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
// system prompt 注入片段
// ============================================================

function buildSystemPromptHint(
    locale: SystemLocaleInfo,
    tools: Record<string, CliToolInfo>,
    builtinPython?: string,
): string {
    const lines: string[] = [];

    lines.push('## System Environment');
    lines.push(`- Timezone: ${locale.timezone} | Locale: ${locale.locale}`);

    // 内置 Python 路径 — 放在最显眼的位置，避免 agent 自己尝试找或用系统 Python
    if (builtinPython) {
        lines.push(`- ⚠️ Built-in Python (ALWAYS use this exact path, do NOT use system python/python3/conda): "${builtinPython}"`);
    }

    // 判断一个工具是否在 PATH 中（还是通过固定路径扫到的）
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
// 主入口
// ============================================================

/**
 * 执行环境探测（Gateway 启动时调用一次）
 * 结果缓存在模块全局变量，后续用 getEnvProbe() 获取
 * @param builtinPython 内置 Python 可执行文件路径（来自 Gateway Python env setup）
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
 * 获取已缓存的探测结果（启动后任意时刻调用）
 * 如果未探测过，返回安全的默认值
 */
export function getEnvProbe(): EnvProbeResult {
    if (_probeResult) return _probeResult;

    // 未探测过（理论上不应发生），返回最小默认值
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
 * 在 Python 环境准备好后，将内置 Python 路径注入缓存结果并重新生成 system prompt hint
 * （runEnvProbe 在 Python 环境初始化之前运行，所以需要事后注入）
 */
export function updateEnvProbeBuiltinPython(pythonExe: string): void {
    if (!_probeResult) return;
    _probeResult.builtinPython = pythonExe;
    _probeResult.systemPromptHint = buildSystemPromptHint(_probeResult.locale, _probeResult.tools, pythonExe);
    log.info('Env-probe updated with built-in Python path', { pythonExe });
}


/**
 * 便捷函数：格式化当前时间（使用系统检测到的时区）
 * 替换所有硬编码的 'Asia/Shanghai'
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
 * 便捷函数：获取今天的日期字符串 YYYY-MM-DD（使用系统时区）
 * 替换所有硬编码的 { timeZone: 'Asia/Shanghai' }
 */
export function getTodayStr(): string {
    const { timezone } = getEnvProbe().locale;
    return new Date().toLocaleDateString('sv-SE', { timeZone: timezone });
}

/**
 * 便捷函数：格式化任意 Date（使用系统时区）
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
