/**
 * Windows 专用工具 - 工厂模式
 * 提供 Windows 系统特定功能
 */

import { exec } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';
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
const WINDOWS_ACTIONS = [
    'system',         // 获取系统信息
    'clipboard',      // 剪贴板操作（文本）
    'clipboardImage', // 剪贴板操作（图片）
    'notification',   // 发送系统通知
    'window',         // 窗口管理
    'powershell',     // 执行 PowerShell 脚本
    'app',            // 应用启动/列表
    'com',            // COM 自动化（控制 Office 等应用）
] as const;

type WindowsAction = (typeof WINDOWS_ACTIONS)[number];

export interface WindowsToolOptions {
    /** PowerShell 超时时间（毫秒） */
    timeout?: number;
}

/**
 * 创建 Windows 专用工具
 */
export function createWindowsTool(opts: WindowsToolOptions = {}): AnyTool {
    const { timeout = 10000 } = opts;

    // 执行 PowerShell 命令（使用临时文件，避免命令行长度限制和引号转义问题）
    async function runPowerShell(script: string, psTimeout: number = timeout): Promise<string> {
        const tmpFile = join(process.env.TEMP || 'C:\\Temp', `openflux_ps_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.ps1`);
        writeFileSync(tmpFile, script, 'utf-8');
        try {
            const { stdout } = await execAsync(
                `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${tmpFile}"`,
                { timeout: psTimeout, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }
            );
            return stdout.trim();
        } finally {
            try { unlinkSync(tmpFile); } catch { /* ignore */ }
        }
    }

    return {
        name: 'windows',
        priority: 18,
        description: `Windows system tool. Supported actions: ${WINDOWS_ACTIONS.join(', ')}`,
        parameters: {
            action: {
                type: 'string',
                description: `Action type: ${WINDOWS_ACTIONS.join('/')}`,
                required: true,
                enum: [...WINDOWS_ACTIONS],
            },
            subAction: {
                type: 'string',
                description: 'Sub-action (clipboard: read/write; clipboardImage: read/write; window: list/activate/minimize/maximize; app: launch/list; com: exec)',
            },
            text: {
                type: 'string',
                description: 'Text content (for clipboard write, notification)',
            },
            title: {
                type: 'string',
                description: 'Notification title',
            },
            windowTitle: {
                type: 'string',
                description: 'Window title (fuzzy match)',
            },
            script: {
                type: 'string',
                description: 'PowerShell script content (for powershell action)',
            },
            timeout: {
                type: 'number',
                description: 'PowerShell timeout in milliseconds, default 30000',
            },
            appName: {
                type: 'string',
                description: 'app: Application name or path (e.g., notepad, excel, chrome); com: COM app name (Excel.Application/Word.Application)',
            },
            appArgs: {
                type: 'string',
                description: 'app launch: Startup arguments',
            },
            imagePath: {
                type: 'string',
                description: 'clipboardImage: Image file path (read save path / write source path)',
            },
        },

        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
            // 检查是否是 Windows
            if (platform() !== 'win32') {
                return errorResult('This tool is only supported on Windows');
            }

            const action = validateAction(args, WINDOWS_ACTIONS);
            const subAction = readStringParam(args, 'subAction') || '';
            const text = readStringParam(args, 'text') || '';
            const title = readStringParam(args, 'title') || 'OpenFlux';
            const windowTitle = readStringParam(args, 'windowTitle') || '';
            const script = readStringParam(args, 'script') || '';
            const scriptTimeout = (args.timeout as number) || 30000;

            switch (action) {
                // 系统信息
                case 'system': {
                    const totalMemory = totalmem();
                    const freeMemory = freemem();
                    const cpuInfo = cpus();

                    return jsonResult({
                        platform: platform(),
                        release: release(),
                        hostname: hostname(),
                        uptime: Math.floor(uptime()),
                        uptimeFormatted: formatUptime(uptime()),
                        memory: {
                            total: formatBytes(totalMemory),
                            free: formatBytes(freeMemory),
                            used: formatBytes(totalMemory - freeMemory),
                            usagePercent: Math.round((1 - freeMemory / totalMemory) * 100),
                        },
                        cpu: {
                            cores: cpuInfo.length,
                            model: cpuInfo[0]?.model || 'Unknown',
                        },
                    });
                }

                // 剪贴板操作
                case 'clipboard': {
                    if (subAction === 'write') {
                        if (!text) {
                            return errorResult('Missing text parameter');
                        }
                        // 使用临时文件避免 PowerShell 字符串解析问题（emoji、换行、引号）
                        const fs = await import('fs');
                        const path = await import('path');
                        const tmpFile = path.join(process.env.TEMP || 'C:\\Temp', `clipboard_${Date.now()}.txt`);
                        fs.writeFileSync(tmpFile, text, 'utf-8');
                        try {
                            await runPowerShell(`Get-Content -Path '${tmpFile}' -Raw -Encoding UTF8 | Set-Clipboard`);
                        } finally {
                            fs.unlinkSync(tmpFile);
                        }
                        return jsonResult({ success: true, action: 'write', length: text.length });
                    } else {
                        // 默认读取
                        const clipboardContent = await runPowerShell('Get-Clipboard');
                        return jsonResult({ content: clipboardContent });
                    }
                }

                // 系统通知
                case 'notification': {
                    if (!text) {
                        return errorResult('Missing text parameter');
                    }

                    const script = `
                        [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
                        $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
                        $textNodes = $template.GetElementsByTagName("text")
                        $textNodes.Item(0).AppendChild($template.CreateTextNode("${title.replace(/"/g, '')}")) | Out-Null
                        $textNodes.Item(1).AppendChild($template.CreateTextNode("${text.replace(/"/g, '')}")) | Out-Null
                        $toast = [Windows.UI.Notifications.ToastNotification]::new($template)
                        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("OpenFlux").Show($toast)
                    `.replace(/\n/g, ' ');

                    try {
                        await runPowerShell(script);
                        return jsonResult({ success: true, title, message: text });
                    } catch (error) {
                        // 备用方案：使用 BurntToast 或简单的 msg
                        try {
                            await runPowerShell(`msg * "${text.replace(/"/g, '')}"`);
                            return jsonResult({ success: true, fallback: true, message: text });
                        } catch {
                            return errorResult('Failed to send notification');
                        }
                    }
                }

                // 窗口管理
                case 'window': {
                    switch (subAction) {
                        case 'list': {
                            const listScript = `Get-Process | Where-Object {$_.MainWindowTitle -ne ""} | Select-Object Id, ProcessName, MainWindowTitle | ConvertTo-Json`;
                            const result = await runPowerShell(listScript);
                            try {
                                const windows = JSON.parse(result || '[]');
                                return jsonResult({ windows: Array.isArray(windows) ? windows : [windows] });
                            } catch {
                                return jsonResult({ windows: [], raw: result });
                            }
                        }

                        case 'activate': {
                            if (!windowTitle) {
                                return errorResult('Missing windowTitle parameter');
                            }
                            const activateScript = `
                                Add-Type @"
                                using System;
                                using System.Runtime.InteropServices;
                                public class Win32 {
                                    [DllImport("user32.dll")]
                                    public static extern bool SetForegroundWindow(IntPtr hWnd);
                                }
"@
                                $proc = Get-Process | Where-Object {$_.MainWindowTitle -match "${windowTitle.replace(/"/g, '')}"} | Select-Object -First 1
                                if ($proc) {
                                    [Win32]::SetForegroundWindow($proc.MainWindowHandle)
                                    $proc.ProcessName
                                } else {
                                    "NotFound"
                                }
                            `.replace(/\n/g, ' ');
                            const result = await runPowerShell(activateScript);
                            if (result === 'NotFound') {
                                return errorResult(`No matching window found: ${windowTitle}`);
                            }
                            return jsonResult({ success: true, activated: result });
                        }

                        case 'minimize': {
                            if (!windowTitle) {
                                return errorResult('Missing windowTitle parameter');
                            }
                            const minScript = `
                                Add-Type @"
                                using System;
                                using System.Runtime.InteropServices;
                                public class Win32 {
                                    [DllImport("user32.dll")]
                                    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
                                }
"@
                                $proc = Get-Process | Where-Object {$_.MainWindowTitle -match "${windowTitle.replace(/"/g, '')}"} | Select-Object -First 1
                                if ($proc) { [Win32]::ShowWindow($proc.MainWindowHandle, 6) }
                            `.replace(/\n/g, ' ');
                            await runPowerShell(minScript);
                            return jsonResult({ success: true, minimized: windowTitle });
                        }

                        case 'maximize': {
                            if (!windowTitle) {
                                return errorResult('Missing windowTitle parameter');
                            }
                            const maxScript = `
                                Add-Type @"
                                using System;
                                using System.Runtime.InteropServices;
                                public class Win32 {
                                    [DllImport("user32.dll")]
                                    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
                                }
"@
                                $proc = Get-Process | Where-Object {$_.MainWindowTitle -match "${windowTitle.replace(/"/g, '')}"} | Select-Object -First 1
                                if ($proc) { [Win32]::ShowWindow($proc.MainWindowHandle, 3) }
                            `.replace(/\n/g, ' ');
                            await runPowerShell(maxScript);
                            return jsonResult({ success: true, maximized: windowTitle });
                        }

                        default:
                            return errorResult(`Unknown window action: ${subAction}, supported: list/activate/minimize/maximize`);
                    }
                }

                // 执行 PowerShell 脚本（临时文件方式，支持超长脚本和复杂语法）
                case 'powershell': {
                    if (!script) {
                        return errorResult('Missing script parameter');
                    }

                    const tmpFile = join(process.env.TEMP || 'C:\\Temp', `openflux_ps_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.ps1`);
                    writeFileSync(tmpFile, script, 'utf-8');
                    try {
                        const { stdout, stderr } = await execAsync(
                            `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${tmpFile}"`,
                            { timeout: scriptTimeout, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }
                        );
                        return jsonResult({
                            success: true,
                            stdout: stdout.trim(),
                            stderr: stderr.trim(),
                        });
                    } catch (error: any) {
                        if (error.killed) {
                            return errorResult(`PowerShell script timed out (${scriptTimeout}ms)`);
                        }
                        return jsonResult({
                            success: false,
                            stdout: error.stdout?.trim() || '',
                            stderr: error.stderr?.trim() || error.message,
                            exitCode: error.code || 1,
                        });
                    } finally {
                        try { unlinkSync(tmpFile); } catch { /* ignore */ }
                    }
                }

                // 应用启动/列表
                case 'app': {
                    const appName = readStringParam(args, 'appName') || '';
                    const appArgs = readStringParam(args, 'appArgs') || '';

                    switch (subAction) {
                        case 'launch': {
                            if (!appName) {
                                return errorResult('Missing appName parameter');
                            }
                            try {
                                const launchCmd = appArgs
                                    ? `Start-Process '${appName.replace(/'/g, "''")}' -ArgumentList '${appArgs.replace(/'/g, "''")}' -PassThru | Select-Object Id, ProcessName | ConvertTo-Json`
                                    : `Start-Process '${appName.replace(/'/g, "''")}' -PassThru | Select-Object Id, ProcessName | ConvertTo-Json`;
                                const result = await runPowerShell(launchCmd);
                                try {
                                    const proc = JSON.parse(result);
                                    return jsonResult({ success: true, launched: appName, pid: proc.Id, processName: proc.ProcessName });
                                } catch {
                                    return jsonResult({ success: true, launched: appName, raw: result });
                                }
                            } catch (error: any) {
                                return errorResult(`Failed to launch application: ${error.message}`);
                            }
                        }

                        case 'list': {
                            try {
                                const listCmd = `Get-ItemProperty HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*, HKLM:\\Software\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* -ErrorAction SilentlyContinue | Where-Object {$_.DisplayName} | Select-Object DisplayName, DisplayVersion, Publisher, InstallDate | Sort-Object DisplayName | ConvertTo-Json -Depth 1`;
                                const result = await runPowerShell(listCmd);
                                try {
                                    const apps = JSON.parse(result || '[]');
                                    return jsonResult({ apps: Array.isArray(apps) ? apps : [apps], count: Array.isArray(apps) ? apps.length : 1 });
                                } catch {
                                    return jsonResult({ apps: [], raw: result });
                                }
                            } catch (error: any) {
                                return errorResult(`Failed to get application list: ${error.message}`);
                            }
                        }

                        default:
                            return errorResult(`Unknown app action: ${subAction}, supported: launch/list`);
                    }
                }

                // 图片剪贴板
                case 'clipboardImage': {
                    const imagePath = readStringParam(args, 'imagePath') || '';

                    switch (subAction) {
                        case 'read': {
                            const savePath = imagePath || `${process.env.TEMP || 'C:\\Temp'}\\clipboard_${Date.now()}.png`;
                            try {
                                const readScript = `
                                    Add-Type -AssemblyName System.Windows.Forms
                                    $img = [System.Windows.Forms.Clipboard]::GetImage()
                                    if ($img) {
                                        $img.Save('${savePath.replace(/'/g, "''")}')
                                        "saved"
                                    } else {
                                        "empty"
                                    }
                                `.replace(/\n/g, ' ');
                                const result = await runPowerShell(readScript);
                                if (result.includes('empty')) {
                                    return jsonResult({ hasImage: false, message: 'No image in clipboard' });
                                }
                                return jsonResult({ hasImage: true, path: savePath });
                            } catch (error: any) {
                                return errorResult(`Failed to read clipboard image: ${error.message}`);
                            }
                        }

                        case 'write': {
                            if (!imagePath) {
                                return errorResult('Missing imagePath parameter');
                            }
                            try {
                                const writeScript = `
                                    Add-Type -AssemblyName System.Windows.Forms
                                    $img = [System.Drawing.Image]::FromFile('${imagePath.replace(/'/g, "''")}')
                                    [System.Windows.Forms.Clipboard]::SetImage($img)
                                    $img.Dispose()
                                    "done"
                                `.replace(/\n/g, ' ');
                                await runPowerShell(writeScript);
                                return jsonResult({ success: true, path: imagePath });
                            } catch (error: any) {
                                return errorResult(`Failed to write clipboard image: ${error.message}`);
                            }
                        }

                        default:
                            return errorResult(`Unknown clipboardImage action: ${subAction}, supported: read/write`);
                    }
                }

                // COM 自动化
                case 'com': {
                    const appName = readStringParam(args, 'appName') || '';
                    if (!appName) {
                        return errorResult('Missing appName parameter (e.g., Excel.Application, Word.Application)');
                    }
                    if (!script) {
                        return errorResult('Missing script parameter (PowerShell COM operation script)');
                    }

                    // 封装 COM 脚本：自动获取或创建 COM 对象
                    const comScript = `
try {
    $app = [System.Runtime.InteropServices.Marshal]::GetActiveObject('${appName.replace(/'/g, "''")}')
} catch {
    $app = New-Object -ComObject '${appName.replace(/'/g, "''")}'
}
${script}
`;

                    try {
                        const result = await runPowerShell(comScript, scriptTimeout);
                        return jsonResult({
                            success: true,
                            appName,
                            stdout: result,
                            stderr: '',
                        });
                    } catch (error: any) {
                        return jsonResult({
                            success: false,
                            appName,
                            stdout: error.stdout?.trim() || '',
                            stderr: error.stderr?.trim() || error.message,
                        });
                    }
                }

                default:
                    return errorResult(`Unknown action: ${action}`);
            }
        },
    };
}

// 格式化字节
function formatBytes(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let unitIndex = 0;
    let size = bytes;

    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
    }

    return `${size.toFixed(1)} ${units[unitIndex]}`;
}

// 格式化运行时间
function formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    parts.push(`${minutes}m`);

    return parts.join(' ');
}
