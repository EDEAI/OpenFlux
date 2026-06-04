/**
 * Desktop control driver interface - platform independent
 * Windows: keysender implementation
 * macOS: AppleScript + screencapture implementation
 */

/** Screenshot results */
export interface CaptureResult {
    data: Buffer;
    width: number;
    height: number;
    format: 'rgba' | 'png';
}

/** Window information */
export interface WindowInfo {
    handle: number;
    title: string;
    className: string;
}

/** Window position and size */
export interface WindowView {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Mouse position */
export interface MousePos {
    x: number;
    y: number;
}

/** Pixel color */
export interface PixelColor {
    hex: string;
    rgb: { r: number; g: number; b: number };
}

/** Screen size */
export interface ScreenSize {
    width: number;
    height: number;
}

/**
 * Desktop control driver interface
 * Each platform implements this interface to provide unified desktop control capabilities
 */
export interface IDesktopDriver {
    /** Platform identification */
    readonly platform: 'win32' | 'darwin';

    // ===== keyboard =====
    /** Enter text */
    type(text: string, windowTitle?: string, windowClass?: string, handle?: number): Promise<void>;
    /** Key/key combination */
    sendKey(keys: string[], windowTitle?: string, windowClass?: string, handle?: number): Promise<void>;
    /** Continuous key sequence */
    sendKeys(keys: string[], windowTitle?: string, windowClass?: string, handle?: number): Promise<void>;

    // ===== mouse =====
    /** Move to coordinates */
    moveTo(x: number, y: number, delay?: number, windowTitle?: string, windowClass?: string, handle?: number): Promise<void>;
    /** click */
    click(button: 'left' | 'right' | 'middle', windowTitle?: string, windowClass?: string, handle?: number): Promise<void>;
    /** Roller */
    scroll(amount: number, windowTitle?: string, windowClass?: string, handle?: number): Promise<void>;
    /** Get the mouse position */
    getMousePos(windowTitle?: string, windowClass?: string, handle?: number): MousePos;
    /** Anthropomorphic movement (optional, macOS can be downgraded to normal movement) */
    humanMoveTo?(x: number, y: number, speed: number, windowTitle?: string, windowClass?: string, handle?: number): Promise<void>;
    /** Mouse button switching (press/release) */
    mouseToggle?(button: 'left' | 'right' | 'middle', down: boolean, delay?: number, windowTitle?: string, windowClass?: string, handle?: number): Promise<void>;

    // ===== Screen =====
    /** Save screenshot to file */
    captureToFile(savePath: string, region?: { x: number; y: number; width: number; height: number }): Promise<{ width: number; height: number; size: number }>;
    /** Get pixel color */
    colorAt(x: number, y: number, windowTitle?: string, windowClass?: string, handle?: number): PixelColor;
    /** Get screen size */
    getScreenSize(): ScreenSize;
    /** Take a screenshot and return to RGBA buffer (for screen recording, optional) */
    captureRaw?(windowTitle?: string, windowClass?: string, handle?: number): CaptureResult;

    // ===== window =====
    /** List all windows */
    listWindows(): WindowInfo[];
    /** Search window */
    findWindows(title?: string, className?: string): WindowInfo[];
    /** Activate window */
    activateWindow(windowTitle?: string, windowClass?: string, handle?: number): WindowInfo | null;
    /** Get window position size */
    getWindowView(windowTitle?: string, windowClass?: string, handle?: number): WindowView;
    /** Set window position and size */
    setWindowView(view: Partial<WindowView>, windowTitle?: string, windowClass?: string, handle?: number): void;
}
