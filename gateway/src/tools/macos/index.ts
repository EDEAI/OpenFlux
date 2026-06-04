/**
 * macOS-specific tools - factory mode
 * Provides macOS system-specific functionality
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

// Supported actions
const MACOS_ACTIONS = [
    'system',        // Get system information
    'clipboard',     // Clipboard operations (text)
    'notification',  // Send system notification
    'window',        // window management
    'shell',         // Execute shell script
    'app',           // Application launch/list
] as const;

type MacOSAction = (typeof MACOS_ACTIONS)[number];

export interface MacOSToolOptions {
    /** Shell script timeout (milliseconds) */
    timeout?: number;
}

/**
 * Execute AppleScript
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
 * Execute shell command
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
 * Create macOS-specific tools
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
                description: `Action type: ${MACOS_ACTIONS.join('/')}`,
                required: true,
                enum: [...MACOS_ACTIONS],
            },
            subAction: {
                type: 'string',
                description: 'Sub-action',
            },
            text: {
                type: 'string',
                description: 'Text content (for clipboard/write, notification)',
            },
            title: {
                type: 'string',
                description: 'Title (for notification, window/activate)',
            },
            script: {
                type: 'string',
                description: 'Shell script content (for shell action)',
            },
            appName: {
                type: 'string',
                description: 'Application name (for app action)',
            },
        },

        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
            // Platform check
            if (platform() !== 'darwin') {
                return errorResult('This tool is only supported on macOS');
            }

            const action = validateAction(args, MACOS_ACTIONS);
            const subAction = readStringParam(args, 'subAction') || '';

            try {
                switch (action) {
                    // ========================
                    // System information (cross-platform Node.js os module)
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

                        // macOS-specific information
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
                    // Clipboard (pbcopy/pbpaste)
                    // ========================
                    case 'clipboard': {
                        switch (subAction) {
                            case 'read': {
                                const { stdout } = await execAsync('pbpaste', { timeout: 3000 });
                                return jsonResult({ text: stdout, length: stdout.length });
                            }
                            case 'write': {
                                const text = readStringParam(args, 'text');
                                if (!text) return errorResult('Missing text parameter');
                                await execAsync(`echo -n ${JSON.stringify(text)} | pbcopy`, { timeout: 3000 });
                                return jsonResult({ success: true, length: text.length });
                            }
                            default:
                                return errorResult(`Unknown clipboard action: ${subAction}, supported: read/write`);
                        }
                    }

                    // ========================
                    // System notification
                    // ========================
                    case 'notification': {
                        const text = readStringParam(args, 'text') || 'OpenFlux Notification';
                        const title = readStringParam(args, 'title') || 'OpenFlux';
                        await runAppleScript(
                            `display notification "${text.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"`,
                            5000
                        );
                        return jsonResult({ success: true, title, text });
                    }

                    // ========================
                    // Window Management (AppleScript System Events)
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
                                if (!target) return errorResult('Missing title or appName parameter');

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
                                if (!appName) return errorResult('Missing appName parameter');
                                const script = `
tell application "${appName.replace(/"/g, '\\"')}"
    close every window
end tell
`;
                                await runAppleScript(script, 5000);
                                return jsonResult({ success: true, closed: appName });
                            }

                            default:
                                return errorResult(`Unknown window action: ${subAction}, supported: list/activate/close`);
                        }
                    }

                    // ========================
                    // Shell script execution
                    // ========================
                    case 'shell': {
                        const script = readStringParam(args, 'script');
                        if (!script) return errorResult('Missing script parameter');
                        const result = await runShell(script, timeout);
                        return jsonResult({ success: true, output: result });
                    }

                    // ========================
                    // Application management
                    // ========================
                    case 'app': {
                        switch (subAction) {
                            case 'open': {
                                const appName = readStringParam(args, 'appName');
                                if (!appName) return errorResult('Missing appName parameter');
                                await execAsync(`open -a "${appName}"`, { timeout: 5000 });
                                return jsonResult({ success: true, opened: appName });
                            }

                            case 'list': {
                                // List running GUI applications
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
                                if (!appName) return errorResult('Missing appName parameter');
                                await runAppleScript(
                                    `tell application "${appName.replace(/"/g, '\\"')}" to quit`,
                                    5000
                                );
                                return jsonResult({ success: true, quit: appName });
                            }

                            default:
                                return errorResult(`Unknown app action: ${subAction}, supported: open/list/quit`);
                        }
                    }

                    default:
                        return errorResult(`Unknown action: ${action}`);
                }
            } catch (error: any) {
                return errorResult(`macOS operation failed: ${error.message}`);
            }
        },
    };
}
