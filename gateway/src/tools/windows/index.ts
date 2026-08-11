/**
 * Windows-Specific Tools - Factory Mode
 * Provides Windows system specific functionality
 */

import { exec, spawn } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';
import { freemem, totalmem, cpus, uptime, platform, release, hostname } from 'os';
import type { AnyTool, ToolResult } from '../types';
import { decodeProcessOutput } from '../../utils/system-encoding';
import {
    readStringParam,
    validateAction,
    jsonResult,
    errorResult,
} from '../common';

const execAsync = promisify(exec);

export interface GpuAdapterInfo {
    name: string;
    memoryMb: number | null;
    driverVersion: string | null;
}

/**
 * Read NVIDIA adapter details without touching WMI. `nvidia-smi` is a bounded,
 * direct child process and is present with normal NVIDIA driver installs. An
 * empty result is intentional: callers must not fall back to broad CIM/WMI
 * hardware enumeration, which can saturate the shared WMI provider.
 */
function queryNvidiaAdapters(timeoutMs = 3000): Promise<GpuAdapterInfo[]> {
    return new Promise((resolvePromise) => {
        let settled = false;
        let stdout = '';
        const finish = (value: GpuAdapterInfo[]) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolvePromise(value);
        };

        const child = spawn('nvidia-smi', [
            '--query-gpu=name,memory.total,driver_version',
            '--format=csv,noheader,nounits',
        ], {
            windowsHide: true,
            shell: false,
            stdio: ['ignore', 'pipe', 'ignore'],
        });

        const timer = setTimeout(() => {
            try { child.kill(); } catch { /* ignore */ }
            finish([]);
        }, timeoutMs);
        timer.unref?.();

        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
            stdout += chunk;
            if (stdout.length > 64 * 1024) {
                try { child.kill(); } catch { /* ignore */ }
                finish([]);
            }
        });
        child.once('error', () => finish([]));
        child.once('close', (code) => {
            if (code !== 0) return finish([]);
            const adapters = stdout
                .split(/\r?\n/)
                .map(line => line.trim())
                .filter(Boolean)
                .map((line): GpuAdapterInfo | null => {
                    const [name, memoryRaw, driverRaw] = line.split(',').map(part => part.trim());
                    if (!name) return null;
                    const memoryMb = Number(memoryRaw);
                    return {
                        name,
                        memoryMb: Number.isFinite(memoryMb) ? memoryMb : null,
                        driverVersion: driverRaw || null,
                    };
                })
                .filter((adapter): adapter is GpuAdapterInfo => adapter !== null);
            finish(adapters);
        });
    });
}

// Supported actions
const WINDOWS_ACTIONS = [
    'system',         // Get system information
    'clipboard',      // Clipboard operations (text)
    'clipboardImage', // Clipboard operations (pictures)
    'notification',   // Send system notification
    'window',         // window management
    'powershell',     // Execute PowerShell script
    'app',            // Application launch/list
    'com',            // COM Automation (control applications such as Office)
] as const;

type WindowsAction = (typeof WINDOWS_ACTIONS)[number];

export interface WindowsToolOptions {
    /** PowerShell timeout (milliseconds) */
    timeout?: number;
    /** Test/embedding hook for the WMI-free GPU probe. */
    gpuProbe?: () => Promise<GpuAdapterInfo[]>;
}

/**
 * Create Windows-specific tools
 */
export function createWindowsTool(opts: WindowsToolOptions = {}): AnyTool {
    const { timeout = 10000 } = opts;
    const gpuProbe = opts.gpuProbe || queryNvidiaAdapters;
    let gpuCache: { expiresAt: number; adapters: GpuAdapterInfo[] } | null = null;
    let gpuQueryInFlight: Promise<GpuAdapterInfo[]> | null = null;

    async function getGpuAdapters(): Promise<GpuAdapterInfo[]> {
        if (gpuCache && gpuCache.expiresAt > Date.now()) return gpuCache.adapters;
        if (gpuQueryInFlight) return gpuQueryInFlight;

        gpuQueryInFlight = gpuProbe().then((adapters) => {
            gpuCache = { expiresAt: Date.now() + 60_000, adapters };
            return adapters;
        }).finally(() => {
            gpuQueryInFlight = null;
        });
        return gpuQueryInFlight;
    }

    // UTF-8 encoding header added to all PowerShell scripts
    // Solve the garbled output caused by the default GBK(CP936) in Chinese Windows
    const PS_UTF8_HEADER = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'
`;

    // Execute PowerShell commands (use temporary files to avoid command line length limits and quote escaping issues)
    async function runPowerShell(script: string, psTimeout: number = timeout): Promise<string> {
        const tmpFile = join(process.env.TEMP || 'C:\\Temp', `openflux_ps_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.ps1`);
        // 关键：加 UTF-8 BOM(\uFEFF)。Windows PowerShell 5.1 读取无 BOM 的 .ps1 时按系统 ANSI 代码页
        // (中文系统=GBK)解析，导致脚本中的中文(如文件名"新文档")被读成乱码"鏂版枃妗"。
        // 带 BOM 后 PowerShell 会正确按 UTF-8 读取整个脚本。
        writeFileSync(tmpFile, '\uFEFF' + PS_UTF8_HEADER + script, 'utf-8');
        try {
            const { stdout } = await execAsync(
                `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${tmpFile}"`,
                { timeout: psTimeout, windowsHide: true, maxBuffer: 10 * 1024 * 1024, encoding: 'buffer' }
            );
            // The PS script header has set the output to UTF-8, so UTF-8 is always used for decoding here.
            return (stdout as unknown as Buffer).toString('utf-8').trim();
        } finally {
            try { unlinkSync(tmpFile); } catch { /* ignore */ }
        }
    }

    return {
        name: 'windows',
        priority: 18,
        description: `Windows system tool. Supported actions: ${WINDOWS_ACTIONS.join(', ')}. Use action=system for CPU, memory, and GPU details; do not run WMI/CIM hardware or process queries through PowerShell.`,
        parameters: {
            action: {
                type: 'string',
                description: `Action type: ${WINDOWS_ACTIONS.join('/')}. system safely returns CPU/memory/GPU information without WMI.`,
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
            // Check if it is Windows
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
                // System information
                case 'system': {
                    const totalMemory = totalmem();
                    const freeMemory = freemem();
                    const cpuInfo = cpus();
                    const gpuAdapters = await getGpuAdapters();

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
                        gpu: {
                            source: gpuAdapters.length > 0 ? 'nvidia-smi' : 'unavailable',
                            adapters: gpuAdapters,
                            safeProbeComplete: true,
                            wmiFallbackAllowed: false,
                            note: gpuAdapters.length > 0
                                ? 'NVIDIA adapters were detected without WMI; other adapter families are intentionally not enumerated.'
                                : 'GPU details unavailable without WMI; do not retry with CIM/WMI. Ask the user only if the task requires them.',
                        },
                    });
                }

                // Clipboard operations
                case 'clipboard': {
                    if (subAction === 'write') {
                        if (!text) {
                            return errorResult('Missing text parameter');
                        }
                        // Use temporary files to avoid PowerShell string parsing issues (emoji, newlines, quotes)
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
                        // Default read
                        const clipboardContent = await runPowerShell('Get-Clipboard');
                        return jsonResult({ content: clipboardContent });
                    }
                }

                // System notification
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
                        // Alternative: Use BurntToast or simple msg
                        try {
                            await runPowerShell(`msg * "${text.replace(/"/g, '')}"`);
                            return jsonResult({ success: true, fallback: true, message: text });
                        } catch {
                            return errorResult('Failed to send notification');
                        }
                    }
                }

                // window management
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

                // Execute PowerShell script (temporary file mode, supports long scripts and complex syntax)
                case 'powershell': {
                    if (!script) {
                        return errorResult('Missing script parameter');
                    }

                    const tmpFile = join(process.env.TEMP || 'C:\\Temp', `openflux_ps_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.ps1`);
                    // 关键：加 UTF-8 BOM(\uFEFF)。否则 Windows PowerShell 5.1 按系统 ANSI(GBK)
                    // 解析含中文的脚本(如 word_save_as 的中文路径)，导致 SaveAs2 收到乱码路径而抛 COMException。
                    writeFileSync(tmpFile, '\uFEFF' + PS_UTF8_HEADER + script, 'utf-8');
                    try {
                        const { stdout, stderr } = await execAsync(
                            `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${tmpFile}"`,
                            { timeout: scriptTimeout, windowsHide: true, maxBuffer: 10 * 1024 * 1024, encoding: 'buffer' }
                        );
                        return jsonResult({
                            success: true,
                            stdout: (stdout as unknown as Buffer).toString('utf-8').trim(),
                            stderr: (stderr as unknown as Buffer).toString('utf-8').trim(),
                        });
                    } catch (error: any) {
                        if (error.killed) {
                            return errorResult(`PowerShell script timed out (${scriptTimeout}ms)`);
                        }
                        return jsonResult({
                            success: false,
                            stdout: decodeProcessOutput(error.stdout).trim(),
                            stderr: decodeProcessOutput(error.stderr) || error.message,
                            exitCode: error.code || 1,
                        });
                    } finally {
                        try { unlinkSync(tmpFile); } catch { /* ignore */ }
                    }
                }

                // Application launch/list
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

                // Picture clipboard
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

                // COM Automation
                case 'com': {
                    const appName = readStringParam(args, 'appName') || '';
                    if (!appName) {
                        return errorResult('Missing appName parameter (e.g., Excel.Application, Word.Application)');
                    }
                    if (!script) {
                        return errorResult('Missing script parameter (PowerShell COM operation script)');
                    }

                    // Wrap COM script: automatically obtain or create COM objects
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

// Format bytes
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

// Format run time
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
