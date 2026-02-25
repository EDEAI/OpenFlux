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
    throw new Error(`不支持的平台: ${process.platform}，桌面控制仅支持 Windows 和 macOS`);
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
        ? '（macOS 平台：humanMove 降级为线性移动，record 不可用）'
        : '';

    return {
        name: 'desktop',
        description: `OS 级桌面控制工具，可操作任意应用的键盘、鼠标、屏幕截图、窗口管理${platformNote}。支持动作: ${DESKTOP_ACTIONS.join(', ')}。
keyboard 子操作: type(输入文本), key(按键/组合键), keys(连续按键)
mouse 子操作: click(点击), doubleClick(双击), rightClick(右键), move(移动), humanMove(拟人化移动), scroll(滚轮), getPos(获取光标位置), drag(拖拽)
screen 子操作: capture(截图保存文件), analyze(截图并交给LLM Vision分析界面内容), colorAt(获取像素颜色), getSize(获取屏幕分辨率)${isMac ? '' : ', record(录屏 start/stop/status)'}
window 子操作: list(列出窗口), find(查找窗口), activate(激活窗口), getView(获取窗口位置大小), setView(设置窗口位置大小)`,

        parameters: {
            action: {
                type: 'string',
                description: `操作类型: ${DESKTOP_ACTIONS.join('/')}`,
                required: true,
                enum: [...DESKTOP_ACTIONS],
            },
            subAction: {
                type: 'string',
                description: '子操作（见工具描述中各 action 的子操作列表）',
                required: true,
            },
            text: {
                type: 'string',
                description: '输入文本（keyboard/type 使用）',
            },
            key: {
                type: 'string',
                description: '按键名称，如 "enter", "tab", "a", "f5" 等。组合键用逗号分隔，如 "ctrl,c"（keyboard/key 使用）',
            },
            keys: {
                type: 'string',
                description: '连续按键序列，JSON 数组格式，如 ["tab","enter"]（keyboard/keys 使用）',
            },
            x: {
                type: 'number',
                description: 'X 坐标（鼠标操作、屏幕截图区域、颜色检测）',
            },
            y: {
                type: 'number',
                description: 'Y 坐标（鼠标操作、屏幕截图区域、颜色检测）',
            },
            toX: {
                type: 'number',
                description: '目标 X 坐标（drag 拖拽终点）',
            },
            toY: {
                type: 'number',
                description: '目标 Y 坐标（drag 拖拽终点）',
            },
            button: {
                type: 'string',
                description: '鼠标按键: left/right/middle，默认 left',
            },
            scrollAmount: {
                type: 'number',
                description: '滚轮滚动量，正值向上，负值向下',
            },
            speed: {
                type: 'number',
                description: '拟人化移动速度（1-10），默认 5',
            },
            width: {
                type: 'number',
                description: '截图区域宽度',
            },
            height: {
                type: 'number',
                description: '截图区域高度',
            },
            savePath: {
                type: 'string',
                description: '截图保存路径（完整文件名，如 "C:/temp/screen.png"）',
            },
            windowTitle: {
                type: 'string',
                description: '目标窗口标题（模糊匹配，用于指定操作的目标窗口）',
            },
            windowClass: {
                type: 'string',
                description: '目标窗口类名',
            },
            windowHandle: {
                type: 'number',
                description: '目标窗口句柄（handle）',
            },
            setX: {
                type: 'number',
                description: '设置窗口 X 位置',
            },
            setY: {
                type: 'number',
                description: '设置窗口 Y 位置',
            },
            setWidth: {
                type: 'number',
                description: '设置窗口宽度',
            },
            setHeight: {
                type: 'number',
                description: '设置窗口高度',
            },
            prompt: {
                type: 'string',
                description: '截图分析的提示词（screen/analyze 使用），如 "找到登录按钮的位置"',
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
                                if (!text) return errorResult('缺少 text 参数');
                                await drv.type(text, windowTitle, windowClass, windowHandle);
                                return jsonResult({ success: true, action: 'type', text, length: text.length });
                            }

                            case 'key': {
                                const keyStr = readStringParam(args, 'key');
                                if (!keyStr) return errorResult('缺少 key 参数');
                                const keys = keyStr.split(',').map(k => k.trim());
                                await drv.sendKey(keys, windowTitle, windowClass, windowHandle);
                                return jsonResult({ success: true, action: 'key', key: keyStr });
                            }

                            case 'keys': {
                                const keysStr = readStringParam(args, 'keys');
                                if (!keysStr) return errorResult('缺少 keys 参数');
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
                                return errorResult(`未知键盘操作: ${subAction}，支持: type/key/keys`);
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
                                    return errorResult('缺少 x 或 y 参数');
                                }
                                await drv.moveTo(x, y, undefined, windowTitle, windowClass, windowHandle);
                                return jsonResult({ success: true, action: 'move', x, y });
                            }

                            case 'humanMove': {
                                if (x === undefined || y === undefined) {
                                    return errorResult('缺少 x 或 y 参数');
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
                                    return errorResult('缺少 scrollAmount 参数');
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
                                    return errorResult('缺少起始坐标 x, y');
                                }
                                const toX = readNumberParam(args, 'toX');
                                const toY = readNumberParam(args, 'toY');
                                if (toX === undefined || toY === undefined) {
                                    return errorResult('缺少目标坐标 toX, toY');
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
                                return errorResult(`未知鼠标操作: ${subAction}，支持: click/doubleClick/rightClick/move/humanMove/scroll/getPos/drag`);
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
                                    return errorResult('缺少 x 或 y 参数');
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
                                    ? `屏幕截图（${captureResult.width}x${captureResult.height}）。分析要求：${prompt}`
                                    : `屏幕截图（${captureResult.width}x${captureResult.height}）。请描述界面内容，包括文字、按钮、输入框等可操作元素的位置。`;

                                return {
                                    success: true,
                                    data: {
                                        width: captureResult.width,
                                        height: captureResult.height,
                                        message: '截图已提交给 LLM Vision 分析',
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
                                    return errorResult('录屏功能在当前平台不可用');
                                }

                                const recordAction = readStringParam(args, 'text') || 'status';
                                const fps = readNumberParam(args, 'width') || 2;

                                switch (recordAction) {
                                    case 'start': {
                                        if (recordingState.active) {
                                            return jsonResult({
                                                recording: true,
                                                frames: recordingState.frameCount,
                                                message: '录屏已在进行中',
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
                                            message: '录屏已开始',
                                        });
                                    }

                                    case 'stop': {
                                        if (!recordingState.active) {
                                            return jsonResult({ recording: false, message: '未在录屏' });
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
                                            execSync('ffmpeg -version', { stdio: 'ignore' });
                                            videoPath = path.resolve(screenshotDir, `recording_${Date.now()}.mp4`);
                                            execSync(
                                                `ffmpeg -y -framerate ${fps || 2} -i "${path.join(tempDir, 'frame_%06d.bmp')}" -c:v libx264 -pix_fmt yuv420p "${videoPath}"`,
                                                { stdio: 'ignore', timeout: 60000 }
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
                                                ? `录屏完成，已合成视频: ${videoPath}`
                                                : `录屏完成，${frameCount} 帧截图保存在: ${tempDir}（系统无 ffmpeg，未合成视频）`,
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
                                        return errorResult(`未知 record 操作: ${recordAction}，支持: start/stop/status`);
                                }
                            }

                            default:
                                return errorResult(`未知屏幕操作: ${subAction}，支持: capture/analyze/colorAt/getSize${isMac ? '' : '/record'}`);
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
                                    return errorResult('缺少 windowTitle 或 windowClass 参数');
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
                                    return errorResult('未找到目标窗口');
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
                                    return errorResult('需要至少一个参数: setX/setY/setWidth/setHeight');
                                }
                                drv.setWindowView(viewUpdate, windowTitle, windowClass, windowHandle);
                                return jsonResult({ success: true, view: viewUpdate });
                            }

                            default:
                                return errorResult(`未知窗口操作: ${subAction}，支持: list/find/activate/getView/setView`);
                        }
                    }

                    default:
                        return errorResult(`未知动作: ${action}`);
                }
            } catch (error: any) {
                return errorResult(`桌面操作失败: ${error.message}`);
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
