/**
 * 桌面控制驱动接口 - 平台无关
 * Windows: keysender 实现
 * macOS: AppleScript + screencapture 实现
 */

/** 屏幕截图结果 */
export interface CaptureResult {
    data: Buffer;
    width: number;
    height: number;
    format: 'rgba' | 'png';
}

/** 窗口信息 */
export interface WindowInfo {
    handle: number;
    title: string;
    className: string;
}

/** 窗口位置与大小 */
export interface WindowView {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** 鼠标位置 */
export interface MousePos {
    x: number;
    y: number;
}

/** 像素颜色 */
export interface PixelColor {
    hex: string;
    rgb: { r: number; g: number; b: number };
}

/** 屏幕尺寸 */
export interface ScreenSize {
    width: number;
    height: number;
}

/**
 * 桌面控制驱动接口
 * 各平台实现此接口以提供统一的桌面控制能力
 */
export interface IDesktopDriver {
    /** 平台标识 */
    readonly platform: 'win32' | 'darwin';

    // ===== 键盘 =====
    /** 输入文本 */
    type(text: string, windowTitle?: string, windowClass?: string, handle?: number): Promise<void>;
    /** 按键/组合键 */
    sendKey(keys: string[], windowTitle?: string, windowClass?: string, handle?: number): Promise<void>;
    /** 连续按键序列 */
    sendKeys(keys: string[], windowTitle?: string, windowClass?: string, handle?: number): Promise<void>;

    // ===== 鼠标 =====
    /** 移动到坐标 */
    moveTo(x: number, y: number, delay?: number, windowTitle?: string, windowClass?: string, handle?: number): Promise<void>;
    /** 点击 */
    click(button: 'left' | 'right' | 'middle', windowTitle?: string, windowClass?: string, handle?: number): Promise<void>;
    /** 滚轮 */
    scroll(amount: number, windowTitle?: string, windowClass?: string, handle?: number): Promise<void>;
    /** 获取鼠标位置 */
    getMousePos(windowTitle?: string, windowClass?: string, handle?: number): MousePos;
    /** 拟人化移动（可选，macOS 可降级为普通移动） */
    humanMoveTo?(x: number, y: number, speed: number, windowTitle?: string, windowClass?: string, handle?: number): Promise<void>;
    /** 鼠标按键切换（按下/释放） */
    mouseToggle?(button: 'left' | 'right' | 'middle', down: boolean, delay?: number, windowTitle?: string, windowClass?: string, handle?: number): Promise<void>;

    // ===== 屏幕 =====
    /** 截图保存到文件 */
    captureToFile(savePath: string, region?: { x: number; y: number; width: number; height: number }): Promise<{ width: number; height: number; size: number }>;
    /** 获取像素颜色 */
    colorAt(x: number, y: number, windowTitle?: string, windowClass?: string, handle?: number): PixelColor;
    /** 获取屏幕尺寸 */
    getScreenSize(): ScreenSize;
    /** 截图并返回 RGBA buffer（用于录屏，可选） */
    captureRaw?(windowTitle?: string, windowClass?: string, handle?: number): CaptureResult;

    // ===== 窗口 =====
    /** 列出所有窗口 */
    listWindows(): WindowInfo[];
    /** 查找窗口 */
    findWindows(title?: string, className?: string): WindowInfo[];
    /** 激活窗口 */
    activateWindow(windowTitle?: string, windowClass?: string, handle?: number): WindowInfo | null;
    /** 获取窗口位置大小 */
    getWindowView(windowTitle?: string, windowClass?: string, handle?: number): WindowView;
    /** 设置窗口位置大小 */
    setWindowView(view: Partial<WindowView>, windowTitle?: string, windowClass?: string, handle?: number): void;
}
