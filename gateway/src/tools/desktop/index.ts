/**
 * 桌面控制工具 - 跨平台封装
 * Windows: keysender 驱动
 * macOS: AppleScript + Quartz 驱动
 */

import * as path from 'path';
import * as fs from 'fs';
import type { AnyTool, ToolResult } from '../types';
import {
    readStringParam,
    readNumberParam,
    readBooleanParam,
    validateAction,
    jsonResult,
    errorResult,
} from '../common';
import type { IDesktopDriver } from './types';

// 支持的动作
const DESKTOP_ACTIONS = [
    'keyboard',  // 键盘操作
    'mouse',     // 鼠标操作
    'screen',    // 屏幕操作
    'window',    // 窗口管理
] as const;

type DesktopAction = (typeof DESKTOP_ACTIONS)[number];

export interface DesktopToolOptions {
    /** 默认目标窗口标题（模糊匹配） */
    defaultWindowTitle?: string;
    /** 截图保存目录 */
    screenshotDir?: string;
}

/**
 * 根据平台创建桌面控制驱动
 */
function createDriver(screenshotDir: string): IDesktopDriver {
    if (process.platform === 'win32') {
        const { WindowsDesktopDriver } = require('./windows-driver');
        return new WindowsDesktopDriver(screenshotDir);
    } else if (process.platform === 'darwin') {
        const { MacOSDesktopDriver } = require('./macos-driver');
        return new MacOSDesktopDriver(screenshotDir);
    }
    throw new Error(`Unsupported platform: ${process.platform}, desktop control supports Windows and macOS only`);
}

/**
 * 创建桌面控制工具
 */
export function createDesktopTool(opts: DesktopToolOptions = {}): AnyTool {
    const { screenshotDir = '.' } = opts;

    // 延迟初始化驱动
    let driver: IDesktopDriver | null = null;
    function getDriver(): IDesktopDriver {
        if (!driver) {
            driver = createDriver(screenshotDir);
        }
        return driver;
    }

    // 录屏状态
    const recordingState = {
        active: false,
        timer: null as ReturnType<typeof setInterval> | null,
        tempDir: null as string | null,
        frameCount: 0,
        startTime: 0,
    };

    const isMac = process.platform === 'darwin';
    const platformNote = isMac
        ? ' (macOS: humanMove fallback to linear movement, record unavailable)'
        : '';

    return {
        name: 'desktop',
        priority: 18,
        description: `OS-level desktop control tool for keyboard, mouse, screenshots, and window management in any application${platformNote}. Supported actions: ${DESKTOP_ACTIONS.join(', ')}.
keyboard sub-actions: type (input text), key (key/combo), keys (sequential keys)
mouse sub-actions: click, doubleClick, rightClick, move, humanMove, scroll, getPos, drag
screen sub-actions: capture (save screenshot), analyze (screenshot + LLM Vision analysis), colorAt (get pixel color), getSize (get screen resolution)${isMac ? '' : ', record (start/stop/status)'}
window sub-actions: list, find, activate, getView, setView`,

        parameters: {
            action: {
                type: 'string',
                description: `Action type: ${DESKTOP_ACTIONS.join('/')}`,
                required: true,
                enum: [...DESKTOP_ACTIONS],
            },
            subAction: {
                type: 'string',
                description: 'Sub-action (see sub-action list for each action in tool description)',
                required: true,
            },
            text: {
                type: 'string',
                description: 'Input text (for keyboard/type)',
            },
            key: {
                type: 'string',
                description: 'Key name, e.g. "enter", "tab", "a", "f5". Combine with comma, e.g. "ctrl,c" (for keyboard/key)',
            },
            keys: {
                type: 'string',
                description: 'Sequential key presses, JSON array format, e.g. ["tab","enter"] (for keyboard/keys)',
            },
            x: {
                type: 'number',
                description: 'X coordinate (for mouse, screenshot area, color detection)',
            },
            y: {
                type: 'number',
                description: 'Y coordinate (for mouse, screenshot area, color detection)',
            },
            toX: {
                type: 'number',
                description: 'Target X coordinate (drag end point)',
            },
            toY: {
                type: 'number',
                description: 'Target Y coordinate (drag end point)',
            },
            button: {
                type: 'string',
                description: 'Mouse button: left/right/middle, default left',
            },
            scrollAmount: {
                type: 'number',
                description: 'Scroll amount, positive for up, negative for down',
            },
            speed: {
                type: 'number',
                description: 'Human-like movement speed (1-10), default 5',
            },
            width: {
                type: 'number',
                description: 'Screenshot area width',
            },
            height: {
                type: 'number',
                description: 'Screenshot area height',
            },
            savePath: {
                type: 'string',
                description: 'Screenshot save path (full filename, e.g. "C:/temp/screen.png")',
            },
            windowTitle: {
                type: 'string',
                description: 'Target window title (fuzzy match, for specifying target window)',
            },
            windowClass: {
                type: 'string',
                description: 'Target window class name',
            },
            windowHandle: {
                type: 'number',
                description: 'Target window handle',
            },
            setX: {
                type: 'number',
                description: 'Set window X position',
            },
            setY: {
                type: 'number',
                description: 'Set window Y position',
            },
            setWidth: {
                type: 'number',
                description: 'Set window width',
            },
            setHeight: {
                type: 'number',
                description: 'Set window height',
            },
            prompt: {
                type: 'string',
                description: 'Prompt for screenshot analysis (for screen/analyze), e.g. "find the login button location"',
            },
        },

        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
            const action = validateAction(args, DESKTOP_ACTIONS);
            const subAction = readStringParam(args, 'subAction') || '';
            const windowTitle = readStringParam(args, 'windowTitle') || opts.defaultWindowTitle || '';
            const windowClass = readStringParam(args, 'windowClass') || '';
            const windowHandle = readNumberParam(args, 'windowHandle');

            try {
                const drv = getDriver();

                switch (action) {
                    // ========================
                    // 键盘操作
                    // ========================
                    case 'keyboard': {
                        switch (subAction) {
                            case 'type': {
                                const text = readStringParam(args, 'text');
                                if (!text) return errorResult('Missing text parameter');
                                await drv.type(text, windowTitle, windowClass, windowHandle);
                                return jsonResult({ success: true, action: 'type', text, length: text.length });
                            }

                            case 'key': {
                                const keyStr = readStringParam(args, 'key');
                                if (!keyStr) return errorResult('Missing key parameter');
                                const keys = keyStr.split(',').map(k => k.trim());
                                await drv.sendKey(keys, windowTitle, windowClass, windowHandle);
                                return jsonResult({ success: true, action: 'key', key: keyStr });
                            }

                            case 'keys': {
                                const keysStr = readStringParam(args, 'keys');
                                if (!keysStr) return errorResult('Missing keys parameter');
                                let keysList: string[];
                                try {
                                    keysList = JSON.parse(keysStr);
                                } catch {
                                    keysList = keysStr.split(',').map(k => k.trim());
                                }
                                await drv.sendKeys(keysList, windowTitle, windowClass, windowHandle);
                                return jsonResult({ success: true, action: 'keys', keys: keysList });
                            }

                            default:
                                return errorResult(`Unknown keyboard action: ${subAction}, supported: type/key/keys`);
                        }
                    }

                    // ========================
                    // 鼠标操作
                    // ========================
                    case 'mouse': {
                        const x = readNumberParam(args, 'x');
                        const y = readNumberParam(args, 'y');

                        switch (subAction) {
                            case 'click': {
                                if (x !== undefined && y !== undefined) {
                                    await drv.moveTo(x, y, 50, windowTitle, windowClass, windowHandle);
                                }
                                const btn = (readStringParam(args, 'button') || 'left') as 'left' | 'right' | 'middle';
                                await drv.click(btn, windowTitle, windowClass, windowHandle);
                                return jsonResult({ success: true, action: 'click', button: btn, x, y });
                            }

                            case 'doubleClick': {
                                if (x !== undefined && y !== undefined) {
                                    await drv.moveTo(x, y, 50, windowTitle, windowClass, windowHandle);
                                }
                                await drv.click('left', windowTitle, windowClass, windowHandle);
                                await new Promise(r => setTimeout(r, 35));
                                await drv.click('left', windowTitle, windowClass, windowHandle);
                                return jsonResult({ success: true, action: 'doubleClick', x, y });
                            }

                            case 'rightClick': {
                                if (x !== undefined && y !== undefined) {
                                    await drv.moveTo(x, y, 50, windowTitle, windowClass, windowHandle);
                                }
                                await drv.click('right', windowTitle, windowClass, windowHandle);
                                return jsonResult({ success: true, action: 'rightClick', x, y });
                            }

                            case 'move': {
                                if (x === undefined || y === undefined) {
                                    return errorResult('Missing x or y parameter');
                                }
                                await drv.moveTo(x, y, undefined, windowTitle, windowClass, windowHandle);
                                return jsonResult({ success: true, action: 'move', x, y });
                            }

                            case 'humanMove': {
                                if (x === undefined || y === undefined) {
                                    return errorResult('Missing x or y parameter');
                                }
                                const speed = readNumberParam(args, 'speed') ?? 5;
                                if (drv.humanMoveTo) {
                                    await drv.humanMoveTo(x, y, speed, windowTitle, windowClass, windowHandle);
                                } else {
                                    // 降级为普通移动
                                    await drv.moveTo(x, y, undefined, windowTitle, windowClass, windowHandle);
                                }
                                return jsonResult({ success: true, action: 'humanMove', x, y, speed });
                            }

                            case 'scroll': {
                                const amount = readNumberParam(args, 'scrollAmount');
                                if (amount === undefined) {
                                    return errorResult('Missing scrollAmount parameter');
                                }
                                if (x !== undefined && y !== undefined) {
                                    await drv.moveTo(x, y, 50, windowTitle, windowClass, windowHandle);
                                }
                                await drv.scroll(amount, windowTitle, windowClass, windowHandle);
                                return jsonResult({ success: true, action: 'scroll', amount, x, y });
                            }

                            case 'getPos': {
                                const pos = drv.getMousePos(windowTitle, windowClass, windowHandle);
                                return jsonResult({ x: pos.x, y: pos.y });
                            }

                            case 'drag': {
                                if (x === undefined || y === undefined) {
                                    return errorResult('Missing start coordinates x, y');
                                }
                                const toX = readNumberParam(args, 'toX');
                                const toY = readNumberParam(args, 'toY');
                                if (toX === undefined || toY === undefined) {
                                    return errorResult('Missing target coordinates toX, toY');
                                }
                                await drv.moveTo(x, y, 100, windowTitle, windowClass, windowHandle);
                                if (drv.mouseToggle) {
                                    await drv.mouseToggle('left', true, 50, windowTitle, windowClass, windowHandle);
                                }
                                if (drv.humanMoveTo) {
                                    await drv.humanMoveTo(toX, toY, 3, windowTitle, windowClass, windowHandle);
                                } else {
                                    await drv.moveTo(toX, toY, undefined, windowTitle, windowClass, windowHandle);
                                }
                                if (drv.mouseToggle) {
                                    await drv.mouseToggle('left', false, 50, windowTitle, windowClass, windowHandle);
                                }
                                return jsonResult({ success: true, action: 'drag', from: { x, y }, to: { x: toX, y: toY } });
                            }

                            default:
                                return errorResult(`Unknown mouse action: ${subAction}, supported: click/doubleClick/rightClick/move/humanMove/scroll/getPos/drag`);
                        }
                    }

                    // ========================
                    // 屏幕操作
                    // ========================
                    case 'screen': {
                        switch (subAction) {
                            case 'capture': {
                                let savePath = readStringParam(args, 'savePath');
                                if (!savePath) {
                                    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                                    savePath = path.resolve(screenshotDir, `desktop_${timestamp}.png`);
                                }

                                const cx = readNumberParam(args, 'x');
                                const cy = readNumberParam(args, 'y');
                                const cw = readNumberParam(args, 'width');
                                const ch = readNumberParam(args, 'height');

                                const region = (cx !== undefined && cy !== undefined && cw !== undefined && ch !== undefined)
                                    ? { x: cx, y: cy, width: cw, height: ch }
                                    : undefined;

                                const result = await drv.captureToFile(savePath, region);
                                return jsonResult({
                                    success: true,
                                    path: savePath,
                                    width: result.width,
                                    height: result.height,
                                    size: result.size,
                                });
                            }

                            case 'colorAt': {
                                const cx = readNumberParam(args, 'x');
                                const cy = readNumberParam(args, 'y');
                                if (cx === undefined || cy === undefined) {
                                    return errorResult('Missing x or y parameter');
                                }
                                const color = drv.colorAt(cx, cy, windowTitle, windowClass, windowHandle);
                                return jsonResult({
                                    hex: color.hex,
                                    rgb: color.rgb,
                                    x: cx,
                                    y: cy,
                                });
                            }

                            case 'getSize': {
                                const size = drv.getScreenSize();
                                return jsonResult({ width: size.width, height: size.height });
                            }

                            case 'analyze': {
                                const ax = readNumberParam(args, 'x');
                                const ay = readNumberParam(args, 'y');
                                const aw = readNumberParam(args, 'width');
                                const ah = readNumberParam(args, 'height');
                                const prompt = readStringParam(args, 'prompt') || '';

                                const tmpPath = path.resolve(screenshotDir, `analyze_${Date.now()}.png`);
                                const region = (ax !== undefined && ay !== undefined && aw !== undefined && ah !== undefined)
                                    ? { x: ax, y: ay, width: aw, height: ah }
                                    : undefined;

                                const captureResult = await drv.captureToFile(tmpPath, region);

                                // PNG → base64
                                const pngBuffer = fs.readFileSync(tmpPath);
                                const base64Data = pngBuffer.toString('base64');
                                try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }

                                const description = prompt
                                    ? `Screenshot (${captureResult.width}x${captureResult.height}). Analysis request: ${prompt}`
                                    : `Screenshot (${captureResult.width}x${captureResult.height}). Please describe the interface content, including text, buttons, input fields, and other interactive elements with their positions.`;

                                return {
                                    success: true,
                                    data: {
                                        width: captureResult.width,
                                        height: captureResult.height,
                                        message: 'Screenshot submitted to LLM Vision for analysis',
                                    },
                                    images: [{
                                        mimeType: 'image/png',
                                        data: base64Data,
                                        description,
                                    }],
                                };
                            }

                            case 'record': {
                                // 录屏功能仅 Windows 支持（依赖 captureRaw）
                                if (!drv.captureRaw) {
                                    return errorResult('Screen recording is not available on the current platform');
                                }

                                const recordAction = readStringParam(args, 'text') || 'status';
                                const fps = readNumberParam(args, 'width') || 2;

                                switch (recordAction) {
                                    case 'start': {
                                        if (recordingState.active) {
                                            return jsonResult({
                                                recording: true,
                                                frames: recordingState.frameCount,
                                                message: 'Screen recording is already in progress',
                                            });
                                        }

                                        const tempDir = path.resolve(screenshotDir, `recording_${Date.now()}`);
                                        fs.mkdirSync(tempDir, { recursive: true });

                                        recordingState.active = true;
                                        recordingState.tempDir = tempDir;
                                        recordingState.frameCount = 0;
                                        recordingState.startTime = Date.now();

                                        const interval = Math.max(200, Math.floor(1000 / fps));
                                        recordingState.timer = setInterval(() => {
                                            try {
                                                const img = drv.captureRaw!(windowTitle, windowClass, windowHandle);
                                                const bmpBuf = rgbaToBmp(img.data, img.width, img.height);
                                                const frameNum = String(recordingState.frameCount).padStart(6, '0');
                                                fs.writeFileSync(path.join(tempDir, `frame_${frameNum}.bmp`), bmpBuf);
                                                recordingState.frameCount++;
                                            } catch {
                                                // 截图失败忽略
                                            }
                                        }, interval);

                                        return jsonResult({
                                            recording: true,
                                            tempDir,
                                            fps,
                                            interval,
                                            message: 'Screen recording started',
                                        });
                                    }

                                    case 'stop': {
                                        if (!recordingState.active) {
                                            return jsonResult({ recording: false, message: 'Not currently recording' });
                                        }

                                        if (recordingState.timer) {
                                            clearInterval(recordingState.timer);
                                            recordingState.timer = null;
                                        }
                                        recordingState.active = false;
                                        const duration = Date.now() - (recordingState.startTime || 0);
                                        const tempDir = recordingState.tempDir!;
                                        const frameCount = recordingState.frameCount;

                                        let videoPath: string | null = null;
                                        try {
                                            const { execSync } = require('child_process');
                                            execSync('ffmpeg -version', { stdio: 'ignore', windowsHide: true });
                                            videoPath = path.resolve(screenshotDir, `recording_${Date.now()}.mp4`);
                                            execSync(
                                                `ffmpeg -y -framerate ${fps || 2} -i "${path.join(tempDir, 'frame_%06d.bmp')}" -c:v libx264 -pix_fmt yuv420p "${videoPath}"`,
                                                { stdio: 'ignore', timeout: 60000, windowsHide: true }
                                            );
                                        } catch {
                                            videoPath = null;
                                        }

                                        return jsonResult({
                                            recording: false,
                                            frameCount,
                                            durationMs: duration,
                                            tempDir,
                                            videoPath,
                                            message: videoPath
                                                ? `Recording complete, video saved: ${videoPath}`
                                                : `Recording complete, ${frameCount} frames saved in: ${tempDir} (ffmpeg not found, video not synthesized)`,
                                        });
                                    }

                                    case 'status': {
                                        return jsonResult({
                                            recording: recordingState.active,
                                            frameCount: recordingState.frameCount,
                                            durationMs: recordingState.active
                                                ? Date.now() - (recordingState.startTime || 0)
                                                : 0,
                                            tempDir: recordingState.tempDir,
                                        });
                                    }

                                    default:
                                        return errorResult(`Unknown record action: ${recordAction}, supported: start/stop/status`);
                                }
                            }

                            default:
                                return errorResult(`Unknown screen action: ${subAction}, supported: capture/analyze/colorAt/getSize${isMac ? '' : '/record'}`);
                        }
                    }

                    // ========================
                    // 窗口管理
                    // ========================
                    case 'window': {
                        switch (subAction) {
                            case 'list': {
                                const windows = drv.listWindows();
                                return jsonResult({
                                    count: windows.length,
                                    windows: windows.map(w => ({
                                        handle: w.handle,
                                        title: w.title,
                                        className: w.className,
                                    })),
                                });
                            }

                            case 'find': {
                                if (!windowTitle && !windowClass) {
                                    return errorResult('Missing windowTitle or windowClass parameter');
                                }
                                const matches = drv.findWindows(windowTitle, windowClass);
                                return jsonResult({
                                    count: matches.length,
                                    windows: matches.map(w => ({
                                        handle: w.handle,
                                        title: w.title,
                                        className: w.className,
                                    })),
                                });
                            }

                            case 'activate': {
                                const info = drv.activateWindow(windowTitle, windowClass, windowHandle);
                                if (!info) {
                                    return errorResult('Target window not found');
                                }
                                return jsonResult({
                                    success: true,
                                    window: {
                                        handle: info.handle,
                                        title: info.title,
                                        className: info.className,
                                    },
                                });
                            }

                            case 'getView': {
                                const view = drv.getWindowView(windowTitle, windowClass, windowHandle);
                                return jsonResult({
                                    x: view.x,
                                    y: view.y,
                                    width: view.width,
                                    height: view.height,
                                });
                            }

                            case 'setView': {
                                const viewUpdate: Partial<{ x: number; y: number; width: number; height: number }> = {};
                                const sx = readNumberParam(args, 'setX');
                                const sy = readNumberParam(args, 'setY');
                                const sw = readNumberParam(args, 'setWidth');
                                const sh = readNumberParam(args, 'setHeight');
                                if (sx !== undefined) viewUpdate.x = sx;
                                if (sy !== undefined) viewUpdate.y = sy;
                                if (sw !== undefined) viewUpdate.width = sw;
                                if (sh !== undefined) viewUpdate.height = sh;

                                if (Object.keys(viewUpdate).length === 0) {
                                    return errorResult('At least one parameter required: setX/setY/setWidth/setHeight');
                                }
                                drv.setWindowView(viewUpdate, windowTitle, windowClass, windowHandle);
                                return jsonResult({ success: true, view: viewUpdate });
                            }

                            default:
                                return errorResult(`Unknown window action: ${subAction}, supported: list/find/activate/getView/setView`);
                        }
                    }

                    default:
                        return errorResult(`Unknown action: ${action}`);
                }
            } catch (error: any) {
                return errorResult(`Desktop operation failed: ${error.message}`);
            }
        },
    };
}

/**
 * RGBA raw buffer → BMP 文件 buffer
 */
function rgbaToBmp(rgbaData: Buffer, width: number, height: number): Buffer {
    const rowSize = Math.ceil((width * 3) / 4) * 4;
    const pixelDataSize = rowSize * height;
    const fileSize = 54 + pixelDataSize;

    const buffer = Buffer.alloc(fileSize);
    let offset = 0;

    // BMP File Header (14 bytes)
    buffer.write('BM', offset); offset += 2;
    buffer.writeUInt32LE(fileSize, offset); offset += 4;
    buffer.writeUInt32LE(0, offset); offset += 4;
    buffer.writeUInt32LE(54, offset); offset += 4;

    // BMP Info Header (40 bytes)
    buffer.writeUInt32LE(40, offset); offset += 4;
    buffer.writeInt32LE(width, offset); offset += 4;
    buffer.writeInt32LE(-height, offset); offset += 4;
    buffer.writeUInt16LE(1, offset); offset += 2;
    buffer.writeUInt16LE(24, offset); offset += 2;
    buffer.writeUInt32LE(0, offset); offset += 4;
    buffer.writeUInt32LE(pixelDataSize, offset); offset += 4;
    buffer.writeInt32LE(2835, offset); offset += 4;
    buffer.writeInt32LE(2835, offset); offset += 4;
    buffer.writeUInt32LE(0, offset); offset += 4;
    buffer.writeUInt32LE(0, offset); offset += 4;

    // 像素数据（RGBA → BGR）
    for (let row = 0; row < height; row++) {
        let rowOffset = 54 + row * rowSize;
        for (let col = 0; col < width; col++) {
            const srcIdx = (row * width + col) * 4;
            buffer[rowOffset++] = rgbaData[srcIdx + 2]; // B
            buffer[rowOffset++] = rgbaData[srcIdx + 1]; // G
            buffer[rowOffset++] = rgbaData[srcIdx + 0]; // R
        }
    }

    return buffer;
}
