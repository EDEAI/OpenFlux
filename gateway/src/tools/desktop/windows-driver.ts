/**
 * Windows 桌面控制驱动 - keysender 封装
 */

import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import type {
    IDesktopDriver,
    CaptureResult,
    WindowInfo,
    WindowView,
    MousePos,
    PixelColor,
    ScreenSize,
} from './types';

// 动态加载 keysender（native addon，避免 Electron 打包问题）
let keysenderModule: typeof import('keysender') | null = null;
function getKeysender() {
    if (!keysenderModule) {
        try {
            keysenderModule = require('keysender');
        } catch (error: any) {
            throw new Error(`keysender 加载失败: ${error.message}. 请运行: pnpm add keysender && pnpm rebuild keysender`);
        }
    }
    return keysenderModule!;
}

function createWorker(windowTitle?: string, windowClass?: string, handle?: number) {
    const ks = getKeysender();
    if (handle) {
        return new ks.Hardware(handle);
    }
    if (windowTitle || windowClass) {
        return new ks.Hardware(windowTitle || null, windowClass || null);
    }
    return new ks.Hardware();
}

export class WindowsDesktopDriver implements IDesktopDriver {
    readonly platform = 'win32' as const;

    private screenshotDir: string;

    constructor(screenshotDir: string = '.') {
        this.screenshotDir = screenshotDir;
    }

    // ===== 键盘 =====
    async type(text: string, windowTitle?: string, windowClass?: string, handle?: number): Promise<void> {
        const worker = createWorker(windowTitle, windowClass, handle);
        await worker.keyboard.printText(text, 10);
    }

    async sendKey(keys: string[], windowTitle?: string, windowClass?: string, handle?: number): Promise<void> {
        const worker = createWorker(windowTitle, windowClass, handle);
        if (keys.length === 1) {
            await worker.keyboard.sendKey(keys[0] as any);
        } else {
            await worker.keyboard.sendKey(keys as any);
        }
    }

    async sendKeys(keys: string[], windowTitle?: string, windowClass?: string, handle?: number): Promise<void> {
        const worker = createWorker(windowTitle, windowClass, handle);
        await worker.keyboard.sendKeys(keys as any);
    }

    // ===== 鼠标 =====
    async moveTo(x: number, y: number, delay?: number, windowTitle?: string, windowClass?: string, handle?: number): Promise<void> {
        const worker = createWorker(windowTitle, windowClass, handle);
        await worker.mouse.moveTo(x, y, delay);
    }

    async click(button: 'left' | 'right' | 'middle', windowTitle?: string, windowClass?: string, handle?: number): Promise<void> {
        const worker = createWorker(windowTitle, windowClass, handle);
        await worker.mouse.click(button);
    }

    async scroll(amount: number, windowTitle?: string, windowClass?: string, handle?: number): Promise<void> {
        const worker = createWorker(windowTitle, windowClass, handle);
        await worker.mouse.scrollWheel(amount);
    }

    getMousePos(windowTitle?: string, windowClass?: string, handle?: number): MousePos {
        const worker = createWorker(windowTitle, windowClass, handle);
        const pos = worker.mouse.getPos();
        return { x: pos.x, y: pos.y };
    }

    async humanMoveTo(x: number, y: number, speed: number, windowTitle?: string, windowClass?: string, handle?: number): Promise<void> {
        const worker = createWorker(windowTitle, windowClass, handle);
        await worker.mouse.humanMoveTo(x, y, speed);
    }

    async mouseToggle(button: 'left' | 'right' | 'middle', down: boolean, delay?: number, windowTitle?: string, windowClass?: string, handle?: number): Promise<void> {
        const worker = createWorker(windowTitle, windowClass, handle);
        await worker.mouse.toggle(button, down, delay);
    }

    // ===== 屏幕 =====
    async captureToFile(savePath: string, region?: { x: number; y: number; width: number; height: number }): Promise<{ width: number; height: number; size: number }> {
        const dir = path.dirname(savePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const escaped = savePath.replace(/'/g, "''");
        let psScript: string;
        if (region) {
            const { x, y, width, height } = region;
            psScript = `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(${width}, ${height})
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(${x}, ${y}, 0, 0, $bmp.Size)
$g.Dispose()
$bmp.Save('${escaped}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "${width}x${height}"
`;
        } else {
            psScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(0, 0, 0, 0, $bmp.Size)
$g.Dispose()
$bmp.Save('${escaped}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "$($screen.Width)x$($screen.Height)"
`;
        }

        const output = execSync(
            `powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"').replace(/\n/g, '; ')}"`,
            { encoding: 'utf-8', timeout: 10000 }
        ).trim();
        const [imgW, imgH] = output.split('x').map(Number);
        const fileSize = fs.statSync(savePath).size;
        return { width: imgW, height: imgH, size: fileSize };
    }

    colorAt(x: number, y: number, windowTitle?: string, windowClass?: string, handle?: number): PixelColor {
        const worker = createWorker(windowTitle, windowClass, handle);
        const color = worker.workwindow.colorAt(x, y, 'string');
        const colorArray = worker.workwindow.colorAt(x, y, 'array');
        return {
            hex: `#${color}`,
            rgb: { r: colorArray[0], g: colorArray[1], b: colorArray[2] },
        };
    }

    getScreenSize(): ScreenSize {
        const ks = getKeysender();
        const size = ks.getScreenSize();
        return { width: size.width, height: size.height };
    }

    captureRaw(windowTitle?: string, windowClass?: string, handle?: number): CaptureResult {
        const worker = createWorker(windowTitle, windowClass, handle);
        const img = worker.workwindow.capture('rgba');
        return {
            data: img.data,
            width: img.width,
            height: img.height,
            format: 'rgba',
        };
    }

    // ===== 窗口 =====
    listWindows(): WindowInfo[] {
        const ks = getKeysender();
        const windows = ks.getAllWindows();
        return windows.map(w => ({
            handle: w.handle,
            title: w.title,
            className: w.className,
        }));
    }

    findWindows(title?: string, className?: string): WindowInfo[] {
        const all = this.listWindows();
        return all.filter(w => {
            const titleMatch = !title || w.title.includes(title);
            const classMatch = !className || w.className.includes(className);
            return titleMatch && classMatch;
        });
    }

    activateWindow(windowTitle?: string, windowClass?: string, handle?: number): WindowInfo | null {
        const worker = createWorker(windowTitle, windowClass, handle);
        const info = worker.workwindow.get();
        if (!info.handle) return null;
        worker.workwindow.setForeground();
        return {
            handle: info.handle,
            title: info.title,
            className: info.className,
        };
    }

    getWindowView(windowTitle?: string, windowClass?: string, handle?: number): WindowView {
        const worker = createWorker(windowTitle, windowClass, handle);
        const view = worker.workwindow.getView();
        return { x: view.x, y: view.y, width: view.width, height: view.height };
    }

    setWindowView(view: Partial<WindowView>, windowTitle?: string, windowClass?: string, handle?: number): void {
        const worker = createWorker(windowTitle, windowClass, handle);
        worker.workwindow.setView(view);
    }
}
