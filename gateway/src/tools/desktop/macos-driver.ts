/**
 * macOS 桌面控制驱动 - AppleScript + screencapture
 * 需要用户授权辅助功能权限（Accessibility）
 */

import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import type {
    IDesktopDriver,
    WindowInfo,
    WindowView,
    MousePos,
    PixelColor,
    ScreenSize,
} from './types';

/**
 * 执行 osascript 命令
 */
function osascript(script: string, timeout: number = 5000): string {
    return execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
        encoding: 'utf-8',
        timeout,
    }).trim();
}

/**
 * 执行多行 AppleScript
 */
function osascriptMulti(script: string, timeout: number = 5000): string {
    // 用 heredoc 方式传递多行脚本
    return execSync(`osascript <<'APPLESCRIPT'\n${script}\nAPPLESCRIPT`, {
        encoding: 'utf-8',
        timeout,
        shell: '/bin/bash',
    }).trim();
}

export class MacOSDesktopDriver implements IDesktopDriver {
    readonly platform = 'darwin' as const;

    private screenshotDir: string;

    constructor(screenshotDir: string = '.') {
        this.screenshotDir = screenshotDir;
    }

    // ===== 键盘 =====
    async type(text: string, windowTitle?: string): Promise<void> {
        if (windowTitle) {
            this.activateWindowByTitle(windowTitle);
            await this.sleep(100);
        }
        // AppleScript keystroke 支持 Unicode 文本
        const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        osascript(`tell application "System Events" to keystroke "${escaped}"`);
    }

    async sendKey(keys: string[], windowTitle?: string): Promise<void> {
        if (windowTitle) {
            this.activateWindowByTitle(windowTitle);
            await this.sleep(100);
        }

        if (keys.length === 1) {
            // 单个按键
            const keyCode = this.mapKeyName(keys[0]);
            osascript(`tell application "System Events" to key code ${keyCode}`);
        } else {
            // 组合键：最后一个是主键，前面的是修饰键
            const modifiers = keys.slice(0, -1).map(k => this.mapModifier(k)).filter(Boolean);
            const mainKey = keys[keys.length - 1];
            const modStr = modifiers.length > 0 ? ` using {${modifiers.join(', ')}}` : '';

            if (mainKey.length === 1) {
                osascript(`tell application "System Events" to keystroke "${mainKey}"${modStr}`);
            } else {
                const keyCode = this.mapKeyName(mainKey);
                osascript(`tell application "System Events" to key code ${keyCode}${modStr}`);
            }
        }
    }

    async sendKeys(keys: string[]): Promise<void> {
        for (const key of keys) {
            await this.sendKey([key]);
            await this.sleep(50);
        }
    }

    // ===== 鼠标 =====
    async moveTo(x: number, y: number): Promise<void> {
        // 使用 CoreGraphics 通过 Python 脚本移动鼠标
        const pyScript = `
import Quartz
Quartz.CGEventPost(Quartz.kCGHIDEventTap, Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventMouseMoved, (${x}, ${y}), Quartz.kCGMouseButtonLeft))
`;
        execSync(`python3 -c '${pyScript.replace(/'/g, "'\\''")}'`, { timeout: 3000 });
    }

    async click(button: 'left' | 'right' | 'middle'): Promise<void> {
        // 获取当前鼠标位置后点击
        const pos = this.getMousePos();
        const btnMap = {
            left: { down: 'kCGEventLeftMouseDown', up: 'kCGEventLeftMouseUp', btn: 'kCGMouseButtonLeft' },
            right: { down: 'kCGEventRightMouseDown', up: 'kCGEventRightMouseUp', btn: 'kCGMouseButtonRight' },
            middle: { down: 'kCGEventOtherMouseDown', up: 'kCGEventOtherMouseUp', btn: 'kCGMouseButtonCenter' },
        };
        const b = btnMap[button];
        const pyScript = `
import Quartz, time
pos = (${pos.x}, ${pos.y})
Quartz.CGEventPost(Quartz.kCGHIDEventTap, Quartz.CGEventCreateMouseEvent(None, Quartz.${b.down}, pos, Quartz.${b.btn}))
time.sleep(0.05)
Quartz.CGEventPost(Quartz.kCGHIDEventTap, Quartz.CGEventCreateMouseEvent(None, Quartz.${b.up}, pos, Quartz.${b.btn}))
`;
        execSync(`python3 -c '${pyScript.replace(/'/g, "'\\''")}'`, { timeout: 3000 });
    }

    async scroll(amount: number): Promise<void> {
        const pyScript = `
import Quartz
event = Quartz.CGEventCreateScrollWheelEvent(None, Quartz.kCGScrollEventUnitLine, 1, ${amount})
Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)
`;
        execSync(`python3 -c '${pyScript.replace(/'/g, "'\\''")}'`, { timeout: 3000 });
    }

    getMousePos(): MousePos {
        const pyScript = `
import Quartz
loc = Quartz.NSEvent.mouseLocation()
screen_h = Quartz.CGDisplayPixelsHigh(Quartz.CGMainDisplayID())
print(f"{int(loc.x)},{int(screen_h - loc.y)}")
`;
        const output = execSync(`python3 -c '${pyScript.replace(/'/g, "'\\''")}'`, {
            encoding: 'utf-8',
            timeout: 3000,
        }).trim();
        const [x, y] = output.split(',').map(Number);
        return { x, y };
    }

    // humanMoveTo 在 macOS 下降级为线性移动
    async humanMoveTo(x: number, y: number, speed: number = 5): Promise<void> {
        const pos = this.getMousePos();
        const steps = Math.max(5, Math.floor(20 / speed * 5));
        const dx = (x - pos.x) / steps;
        const dy = (y - pos.y) / steps;

        // 通过 Python 批量移动
        const pyScript = `
import Quartz, time
cx, cy = ${pos.x}, ${pos.y}
dx, dy = ${dx}, ${dy}
for i in range(${steps}):
    cx += dx
    cy += dy
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventMouseMoved, (cx, cy), Quartz.kCGMouseButtonLeft))
    time.sleep(0.01)
Quartz.CGEventPost(Quartz.kCGHIDEventTap, Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventMouseMoved, (${x}, ${y}), Quartz.kCGMouseButtonLeft))
`;
        execSync(`python3 -c '${pyScript.replace(/'/g, "'\\''")}'`, { timeout: 10000 });
    }

    async mouseToggle(button: 'left' | 'right' | 'middle', down: boolean): Promise<void> {
        const pos = this.getMousePos();
        const btnMap = {
            left: { event: down ? 'kCGEventLeftMouseDown' : 'kCGEventLeftMouseUp', btn: 'kCGMouseButtonLeft' },
            right: { event: down ? 'kCGEventRightMouseDown' : 'kCGEventRightMouseUp', btn: 'kCGMouseButtonRight' },
            middle: { event: down ? 'kCGEventOtherMouseDown' : 'kCGEventOtherMouseUp', btn: 'kCGMouseButtonCenter' },
        };
        const b = btnMap[button];
        const pyScript = `
import Quartz
Quartz.CGEventPost(Quartz.kCGHIDEventTap, Quartz.CGEventCreateMouseEvent(None, Quartz.${b.event}, (${pos.x}, ${pos.y}), Quartz.${b.btn}))
`;
        execSync(`python3 -c '${pyScript.replace(/'/g, "'\\''")}'`, { timeout: 3000 });
    }

    // ===== 屏幕 =====
    async captureToFile(savePath: string, region?: { x: number; y: number; width: number; height: number }): Promise<{ width: number; height: number; size: number }> {
        const dir = path.dirname(savePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        let cmd: string;
        if (region) {
            const { x, y, width, height } = region;
            cmd = `screencapture -x -R${x},${y},${width},${height} "${savePath}"`;
        } else {
            cmd = `screencapture -x "${savePath}"`;
        }
        execSync(cmd, { timeout: 10000 });

        // 用 sips 获取尺寸
        const sipsOutput = execSync(`sips -g pixelWidth -g pixelHeight "${savePath}"`, {
            encoding: 'utf-8',
            timeout: 5000,
        });
        const widthMatch = sipsOutput.match(/pixelWidth:\s*(\d+)/);
        const heightMatch = sipsOutput.match(/pixelHeight:\s*(\d+)/);
        const imgW = widthMatch ? parseInt(widthMatch[1]) : 0;
        const imgH = heightMatch ? parseInt(heightMatch[1]) : 0;
        const fileSize = fs.statSync(savePath).size;

        return { width: imgW, height: imgH, size: fileSize };
    }

    colorAt(x: number, y: number): PixelColor {
        // 截一个 1x1 的区域，然后用 Python 读取像素
        const tmpPath = path.join(this.screenshotDir, `_color_${Date.now()}.png`);
        try {
            execSync(`screencapture -x -R${x},${y},1,1 "${tmpPath}"`, { timeout: 5000 });
            const pyScript = `
from PIL import Image
img = Image.open("${tmpPath.replace(/"/g, '\\"')}")
r, g, b = img.getpixel((0, 0))[:3]
print(f"{r},{g},{b}")
`;
            const output = execSync(`python3 -c '${pyScript.replace(/'/g, "'\\''")}'`, {
                encoding: 'utf-8',
                timeout: 5000,
            }).trim();
            const [r, g, b] = output.split(',').map(Number);
            const hex = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
            return { hex, rgb: { r, g, b } };
        } finally {
            try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        }
    }

    getScreenSize(): ScreenSize {
        const pyScript = `
import Quartz
d = Quartz.CGMainDisplayID()
print(f"{Quartz.CGDisplayPixelsWide(d)},{Quartz.CGDisplayPixelsHigh(d)}")
`;
        const output = execSync(`python3 -c '${pyScript.replace(/'/g, "'\\''")}'`, {
            encoding: 'utf-8',
            timeout: 3000,
        }).trim();
        const [w, h] = output.split(',').map(Number);
        return { width: w, height: h };
    }

    // ===== 窗口 =====
    listWindows(): WindowInfo[] {
        const script = `
tell application "System Events"
    set windowList to ""
    repeat with proc in (every process whose background only is false)
        set procName to name of proc
        try
            repeat with win in (every window of proc)
                set winName to name of win
                set windowList to windowList & procName & "|||" & winName & "\\n"
            end repeat
        end try
    end repeat
    return windowList
end tell
`;
        const output = osascriptMulti(script);
        if (!output) return [];

        return output.split('\n').filter(Boolean).map((line, idx) => {
            const parts = line.split('|||');
            return {
                handle: idx + 1,
                title: parts[1] || '',
                className: parts[0] || '',
            };
        });
    }

    findWindows(title?: string, className?: string): WindowInfo[] {
        const all = this.listWindows();
        return all.filter(w => {
            const titleMatch = !title || w.title.includes(title);
            const classMatch = !className || w.className.includes(className);
            return titleMatch && classMatch;
        });
    }

    activateWindow(windowTitle?: string, windowClass?: string): WindowInfo | null {
        const appName = windowClass || windowTitle || '';
        if (!appName) return null;

        try {
            // 先尝试按进程名激活
            osascriptMulti(`
tell application "System Events"
    set frontmost of (first process whose name contains "${appName.replace(/"/g, '\\"')}") to true
end tell
`);
            const found = this.findWindows(windowTitle, windowClass);
            return found.length > 0 ? found[0] : null;
        } catch {
            // 尝试按窗口标题激活
            try {
                osascriptMulti(`
tell application "System Events"
    repeat with proc in (every process whose background only is false)
        repeat with win in (every window of proc)
            if name of win contains "${(windowTitle || '').replace(/"/g, '\\"')}" then
                set frontmost of proc to true
                return name of proc
            end if
        end repeat
    end repeat
end tell
`);
                const found = this.findWindows(windowTitle, windowClass);
                return found.length > 0 ? found[0] : null;
            } catch {
                return null;
            }
        }
    }

    getWindowView(windowTitle?: string, windowClass?: string): WindowView {
        const target = windowClass || windowTitle || '';
        const script = `
tell application "System Events"
    set proc to first process whose name contains "${target.replace(/"/g, '\\"')}"
    set win to first window of proc
    set {x, y} to position of win
    set {w, h} to size of win
    return (x as text) & "," & (y as text) & "," & (w as text) & "," & (h as text)
end tell
`;
        const output = osascriptMulti(script);
        const [x, y, w, h] = output.split(',').map(Number);
        return { x, y, width: w, height: h };
    }

    setWindowView(view: Partial<WindowView>, windowTitle?: string, windowClass?: string): void {
        const target = windowClass || windowTitle || '';
        let commands = '';
        if (view.x !== undefined && view.y !== undefined) {
            commands += `set position of win to {${view.x}, ${view.y}}\n`;
        }
        if (view.width !== undefined && view.height !== undefined) {
            commands += `set size of win to {${view.width}, ${view.height}}\n`;
        }

        if (!commands) return;

        const script = `
tell application "System Events"
    set proc to first process whose name contains "${target.replace(/"/g, '\\"')}"
    set win to first window of proc
    ${commands}
end tell
`;
        osascriptMulti(script);
    }

    // ===== 工具方法 =====
    private activateWindowByTitle(title: string): void {
        try {
            osascriptMulti(`
tell application "System Events"
    set frontmost of (first process whose name contains "${title.replace(/"/g, '\\"')}") to true
end tell
`);
        } catch { /* ignore */ }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * 将按键名映射到 macOS key code
     */
    private mapKeyName(keyName: string): number {
        const keyMap: Record<string, number> = {
            'return': 36, 'enter': 36,
            'tab': 48,
            'space': 49,
            'delete': 51, 'backspace': 51,
            'escape': 53, 'esc': 53,
            'left': 123, 'right': 124, 'down': 125, 'up': 126,
            'f1': 122, 'f2': 120, 'f3': 99, 'f4': 118,
            'f5': 96, 'f6': 97, 'f7': 98, 'f8': 100,
            'f9': 101, 'f10': 109, 'f11': 103, 'f12': 111,
            'home': 115, 'end': 119,
            'pageup': 116, 'pagedown': 121,
            'forwarddelete': 117,
        };
        return keyMap[keyName.toLowerCase()] ?? 0;
    }

    /**
     * 将修饰键名映射到 AppleScript 修饰键
     */
    private mapModifier(modName: string): string {
        const modMap: Record<string, string> = {
            'ctrl': 'control down',
            'control': 'control down',
            'shift': 'shift down',
            'alt': 'option down',
            'option': 'option down',
            'cmd': 'command down',
            'command': 'command down',
            'meta': 'command down',
        };
        return modMap[modName.toLowerCase()] || '';
    }
}
