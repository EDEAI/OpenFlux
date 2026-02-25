/**
 * macOS 专用工具 - 工厂模式
 * 提供 macOS 系统特定功能
 */

import { exec } from 'child_process';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';
import { tmpdir } from 'os';
import { freemem, totalmem, cpus, uptime, platform, release, hostname } from 'os';
import type { AnyTool, ToolResult } from '../types';
import {
    readStringParam,
    validateAction,
    jsonResult,
    errorResult,
} from '../common';

const execAsync = promisify(exec);

// 支持的动作
const MACOS_ACTIONS = [
    'system',        // 获取系统信息
    'clipboard',     // 剪贴板操作（文本）
    'notification',  // 发送系统通知
    'window',        // 窗口管理
    'shell',         // 执行 shell 脚本
    'app',           // 应用启动/列表
] as const;

type MacOSAction = (typeof MACOS_ACTIONS)[number];

export interface MacOSToolOptions {
    /** Shell 脚本超时时间（毫秒） */
    timeout?: number;
}

/**
 * 执行 AppleScript
 */
async function runAppleScript(script: string, timeout: number = 10000): Promise<string> {
    const tmpFile = join(tmpdir(), `openflux_as_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.scpt`);
    writeFileSync(tmpFile, script, 'utf-8');
    try {
        const { stdout } = await execAsync(
            `osascript "${tmpFile}"`,
            { timeout, maxBuffer: 10 * 1024 * 1024 }
        );
        return stdout.trim();
    } finally {
        try { unlinkSync(tmpFile); } catch { /* ignore */ }
    }
}

/**
 * 执行 shell 命令
 */
async function runShell(script: string, timeout: number = 10000): Promise<string> {
    const tmpFile = join(tmpdir(), `openflux_sh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.sh`);
    writeFileSync(tmpFile, `#!/bin/bash\n${script}`, { mode: 0o755, encoding: 'utf-8' });
    try {
        const { stdout } = await execAsync(
            `bash "${tmpFile}"`,
            { timeout, maxBuffer: 10 * 1024 * 1024 }
        );
        return stdout.trim();
    } finally {
        try { unlinkSync(tmpFile); } catch { /* ignore */ }
    }
}

/**
 * 创建 macOS 专用工具
 */
export function createMacOSTool(opts: MacOSToolOptions = {}): AnyTool {
    const { timeout = 10000 } = opts;

    return {
        name: 'macos',
        description: `macOS 系统专用工具。支持动作: ${MACOS_ACTIONS.join(', ')}。
system: 获取 macOS 系统信息（CPU、内存、磁盘、系统版本）
clipboard: 剪贴板读写（read/write，使用 pbcopy/pbpaste）
notification: 发送 macOS 通知（display notification）
window: 窗口管理（list/activate/close，使用 AppleScript System Events）
shell: 执行 bash 脚本
app: 应用管理（open/list/quit）`,

        parameters: {
            action: {
                type: 'string',
                description: `操作类型: ${MACOS_ACTIONS.join('/')}`,
                required: true,
                enum: [...MACOS_ACTIONS],
            },
            subAction: {
                type: 'string',
                description: '子操作',
            },
            text: {
                type: 'string',
                description: '文本内容（clipboard/write、notification 使用）',
            },
            title: {
                type: 'string',
                description: '标题（notification、window/activate 使用）',
            },
            script: {
                type: 'string',
                description: 'Shell 脚本内容（shell 动作使用）',
            },
            appName: {
                type: 'string',
                description: '应用名称（app 动作使用）',
            },
        },

        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
            // 平台检查
            if (platform() !== 'darwin') {
                return errorResult('此工具仅支持 macOS 系统');
            }

            const action = validateAction(args, MACOS_ACTIONS);
            const subAction = readStringParam(args, 'subAction') || '';

            try {
                switch (action) {
                    // ========================
                    // 系统信息（跨平台 Node.js os 模块）
                    // ========================
                    case 'system': {
                        const mem = {
                            total: (totalmem() / 1024 / 1024 / 1024).toFixed(2) + ' GB',
                            free: (freemem() / 1024 / 1024 / 1024).toFixed(2) + ' GB',
                            used: ((totalmem() - freemem()) / 1024 / 1024 / 1024).toFixed(2) + ' GB',
                            usagePercent: ((1 - freemem() / totalmem()) * 100).toFixed(1) + '%',
                        };

                        const cpuInfo = cpus();
                        const cpu = {
                            model: cpuInfo[0]?.model || 'Unknown',
                            cores: cpuInfo.length,
                            speed: cpuInfo[0]?.speed || 0,
                        };

                        // macOS 特有信息
                        let macVersion = '';
                        try {
                            macVersion = (await execAsync('sw_vers -productVersion', { timeout: 3000 })).stdout.trim();
                        } catch { /* ignore */ }

                        let diskInfo = '';
                        try {
                            diskInfo = (await execAsync('df -h / | tail -1', { timeout: 3000 })).stdout.trim();
                        } catch { /* ignore */ }

                        return jsonResult({
                            platform: 'darwin',
                            hostname: hostname(),
                            macOSVersion: macVersion,
                            kernelVersion: release(),
                            uptime: `${Math.floor(uptime() / 3600)}h ${Math.floor((uptime() % 3600) / 60)}m`,
                            cpu,
                            memory: mem,
                            disk: diskInfo,
                        });
                    }

                    // ========================
                    // 剪贴板（pbcopy / pbpaste）
                    // ========================
                    case 'clipboard': {
                        switch (subAction) {
                            case 'read': {
                                const { stdout } = await execAsync('pbpaste', { timeout: 3000 });
                                return jsonResult({ text: stdout, length: stdout.length });
                            }
                            case 'write': {
                                const text = readStringParam(args, 'text');
                                if (!text) return errorResult('缺少 text 参数');
                                await execAsync(`echo -n ${JSON.stringify(text)} | pbcopy`, { timeout: 3000 });
                                return jsonResult({ success: true, length: text.length });
                            }
                            default:
                                return errorResult(`未知剪贴板操作: ${subAction}，支持: read/write`);
                        }
                    }

                    // ========================
                    // 系统通知
                    // ========================
                    case 'notification': {
                        const text = readStringParam(args, 'text') || 'OpenFlux 通知';
                        const title = readStringParam(args, 'title') || 'OpenFlux';
                        await runAppleScript(
                            `display notification "${text.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"`,
                            5000
                        );
                        return jsonResult({ success: true, title, text });
                    }

                    // ========================
                    // 窗口管理（AppleScript System Events）
                    // ========================
                    case 'window': {
                        switch (subAction) {
                            case 'list': {
                                const script = `
tell application "System Events"
    set output to ""
    repeat with proc in (every process whose background only is false)
        set procName to name of proc
        set procPID to unix id of proc
        try
            repeat with win in (every window of proc)
                set winName to name of win
                set output to output & procPID & "|||" & procName & "|||" & winName & linefeed
            end repeat
        end try
    end repeat
    return output
end tell
`;
                                const result = await runAppleScript(script, timeout);
                                const windows = result.split('\n').filter(Boolean).map(line => {
                                    const parts = line.split('|||');
                                    return {
                                        pid: parseInt(parts[0]) || 0,
                                        appName: parts[1] || '',
                                        title: parts[2] || '',
                                    };
                                });
                                return jsonResult({ count: windows.length, windows });
                            }

                            case 'activate': {
                                const titleParam = readStringParam(args, 'title');
                                const appName = readStringParam(args, 'appName');
                                const target = appName || titleParam || '';
                                if (!target) return errorResult('缺少 title 或 appName 参数');

                                const script = `
tell application "${target.replace(/"/g, '\\"')}"
    activate
end tell
`;
                                await runAppleScript(script, 5000);
                                return jsonResult({ success: true, activated: target });
                            }

                            case 'close': {
                                const appName = readStringParam(args, 'appName');
                                if (!appName) return errorResult('缺少 appName 参数');
                                const script = `
tell application "${appName.replace(/"/g, '\\"')}"
    close every window
end tell
`;
                                await runAppleScript(script, 5000);
                                return jsonResult({ success: true, closed: appName });
                            }

                            default:
                                return errorResult(`未知窗口操作: ${subAction}，支持: list/activate/close`);
                        }
                    }

                    // ========================
                    // Shell 脚本执行
                    // ========================
                    case 'shell': {
                        const script = readStringParam(args, 'script');
                        if (!script) return errorResult('缺少 script 参数');
                        const result = await runShell(script, timeout);
                        return jsonResult({ success: true, output: result });
                    }

                    // ========================
                    // 应用管理
                    // ========================
                    case 'app': {
                        switch (subAction) {
                            case 'open': {
                                const appName = readStringParam(args, 'appName');
                                if (!appName) return errorResult('缺少 appName 参数');
                                await execAsync(`open -a "${appName}"`, { timeout: 5000 });
                                return jsonResult({ success: true, opened: appName });
                            }

                            case 'list': {
                                // 列出正在运行的 GUI 应用
                                const script = `
tell application "System Events"
    set output to ""
    repeat with proc in (every process whose background only is false)
        set procName to name of proc
        set procPID to unix id of proc
        set output to output & procPID & "|||" & procName & linefeed
    end repeat
    return output
end tell
`;
                                const result = await runAppleScript(script, timeout);
                                const apps = result.split('\n').filter(Boolean).map(line => {
                                    const [pid, name] = line.split('|||');
                                    return { pid: parseInt(pid) || 0, name: name || '' };
                                });
                                return jsonResult({ count: apps.length, apps });
                            }

                            case 'quit': {
                                const appName = readStringParam(args, 'appName');
                                if (!appName) return errorResult('缺少 appName 参数');
                                await runAppleScript(
                                    `tell application "${appName.replace(/"/g, '\\"')}" to quit`,
                                    5000
                                );
                                return jsonResult({ success: true, quit: appName });
                            }

                            default:
                                return errorResult(`未知应用操作: ${subAction}，支持: open/list/quit`);
                        }
                    }

                    default:
                        return errorResult(`未知动作: ${action}`);
                }
            } catch (error: any) {
                return errorResult(`macOS 操作失败: ${error.message}`);
            }
        },
    };
}
