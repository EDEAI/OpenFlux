//! 原生启动 Splash 窗口（仅 Windows）
//!
//! 进程启动瞬间（Tauri/WebView2 初始化之前）显示，与 WebView 内载入屏
//! （startup-loader.js）**像素级同款**的「黑洞吸收 / 白洞产出」粒子动画，
//! 盖住「进程启动 → WebView2 首帧」这段 Web 技术无法触及的空窗期。
//!
//! 渲染方式：不用 GDI 图元（无 alpha/抗锯齿，质感差），而是软件逐像素合成
//! 整帧 BGRA 缓冲——加性混合、抗锯齿圆点、拖尾、辉光、四角星、旋转碎片，
//! 算法与 Canvas 版逐行对应；每帧 SetDIBitsToDevice 一次上屏。
//! 物理在逻辑坐标（CSS px）推进，常数与 JS 版完全一致，栅格化时乘 DPI。
//!
//! 生命周期：
//! - `show()`  在 `run()` 最前面调用，独立线程跑消息循环，不阻塞 Tauri；
//! - `close()` 由前端触发（startup-loader.js 首帧渲染后 invoke `splash_close`）；
//! - 兜底：15 秒定时器强制关闭，防止 WebView 加载失败时 splash 卡死。
#![cfg(target_os = "windows")]

use std::cell::{Cell, RefCell};
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};

use winapi::shared::minwindef::{LPARAM, LRESULT, UINT, WPARAM};
use winapi::shared::windef::{
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, HBRUSH, HFONT, HWND, POINT, RECT,
};
use winapi::um::libloaderapi::GetModuleHandleW;
use winapi::um::shellscalingapi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use winapi::um::wingdi::{
    CreateCompatibleDC, CreateDIBSection, CreateFontW, CreateSolidBrush, DeleteDC, DeleteObject,
    GdiFlush, GetDeviceCaps, SelectObject, SetBkMode, SetDIBitsToDevice, SetTextCharacterExtra,
    SetTextColor, ANTIALIASED_QUALITY, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CLIP_DEFAULT_PRECIS,
    DEFAULT_CHARSET, DEFAULT_PITCH, DIB_RGB_COLORS, FF_DONTCARE, FW_NORMAL, LOGPIXELSX,
    OUT_DEFAULT_PRECIS, TRANSPARENT,
};
use winapi::um::winnls::GetUserDefaultUILanguage;
use winapi::um::winuser::{
    BeginPaint, CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, DrawTextW,
    EndPaint, FillRect, GetDC, GetMessageW, InvalidateRect, LoadCursorW, MonitorFromPoint,
    PostMessageW, PostQuitMessage, RegisterClassW, ReleaseDC, SetProcessDpiAwarenessContext,
    SetTimer, ShowWindow, SystemParametersInfoW, TranslateMessage, UpdateWindow, DT_CENTER,
    DT_NOCLIP, DT_SINGLELINE, DT_TOP, IDC_ARROW, MONITOR_DEFAULTTOPRIMARY, MSG, PAINTSTRUCT,
    SPI_GETWORKAREA, SW_SHOW, WM_CLOSE, WM_DESTROY, WM_ERASEBKGND, WM_PAINT, WM_TIMER, WNDCLASSW,
    WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
};

/// 与前端载入屏一致的深色背景（#06070d）
const BG: (u8, u8, u8) = (0x06, 0x07, 0x0d);
const BG_COLORREF: u32 = (BG.2 as u32) << 16 | (BG.1 as u32) << 8 | BG.0 as u32;

/// 内嵌 logo（256×256 PNG，按 DPI 缩放到逻辑 128px）
const LOGO_PNG: &[u8] = include_bytes!("../icons/128x128@2x.png");
const LOGO_LOGICAL: f32 = 128.0;
/// 主窗口逻辑尺寸（tauri.conf.json）——splash 与其重合，切换无缝
const WIN_LOGICAL: (f32, f32) = (1200.0, 800.0);

/// 定时器请求间隔：取系统允许的最小值（USER_TIMER_MINIMUM = 10ms）。
/// WM_TIMER 精度差且消息会被合并，真实触发间隔不可靠，
/// 因此物理推进不数 tick，而是按真实流逝时间以固定步长补齐（见 WM_TIMER 处理）。
const TICK_MS: u32 = 10;
/// 物理固定步长：与 requestAnimationFrame 的 60fps 一致
const STEP_MS: f32 = 1000.0 / 60.0;
const TIMER_CLOSE: usize = 1;
const TIMER_TICK: usize = 2;
/// 与 startup-loader.js 的 count 一致
const PARTICLE_COUNT: usize = 170;

/// 输入侧杂色盘（hue, sat）——与 JS 版 IN_PALETTE 一致
const IN_PALETTE: [(f32, f32); 6] = [
    (30.0, 70.0), (42.0, 55.0), (18.0, 60.0),
    (50.0, 30.0), (200.0, 12.0), (25.0, 20.0),
];

static SPLASH_HWND: AtomicIsize = AtomicIsize::new(0);
static CLOSE_REQUESTED: AtomicBool = AtomicBool::new(false);

/// 粒子（字段与 startup-loader.js 对应；物理量均为逻辑 px）
struct P {
    is_in: bool,
    // 吸入：参数化轨迹
    x0: f32, y0: f32, t: f32, dt: f32,
    wob_a: f32, wob_f: f32, wob_p: f32,
    rot: f32, spin: f32, shape: u8, // 0 圆点 / 1 碎片
    // 喷出：极坐标
    angle: f32, d: f32, v: f32,
    spark: bool, tw: f32,
    size: f32, hue: f32, sat: f32, light: f32,
    x: f32, y: f32, vx: f32, vy: f32, alpha: f32,
}

struct State {
    wp: i32,          // 物理像素
    hp: i32,
    scale: f32,       // DPI 缩放
    wl: f32,          // 逻辑尺寸（CSS px 等价）
    hl: f32,
    logo_r: f32,      // 逻辑：logo 半径 + 6（与 JS logoR 一致）
    base: Vec<u8>,    // 静态底图：渐变背景 + 洞口辉光（BGRA）
    frame: Vec<u8>,   // 工作帧
    logo: Vec<u8>,    // 缩放后的 logo（RGBA，直通 alpha）
    logo_dst: i32,    // logo 物理边长
    particles: Vec<P>,
    last_tick: std::time::Instant, // 上次物理推进的时间
    acc_ms: f32,                   // 未消费的流逝时间（固定步长累加器）
    // 状态提示文字（与 WebView 载入屏 .app-loading-text 同款式样）。
    // 文字预渲染成整宽度灰度覆盖条，每帧混进帧缓冲随帧一次性上屏——
    // 若上屏后再用 GDI 补画，会因「先盖帧再画字」两步间的空档产生闪烁。
    started: std::time::Instant,   // splash 启动时刻：按流逝时间推进提示阶段
    text_h: i32,                   // 覆盖条物理高度
    text_masks: Vec<Vec<u8>>,      // 各阶段文案的覆盖度掩码（wp × text_h，最后一条与载入屏一致）
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
    static BG_BRUSH: Cell<HBRUSH> = const { Cell::new(std::ptr::null_mut()) };
    static RNG: Cell<u32> = const { Cell::new(0x9e3779b9) };
}

/// 在独立线程中显示 splash（立即返回，不阻塞调用方）。
///
/// `identifier`：应用标识（tauri.conf.json / 品牌覆盖后的值），用于定位
/// `%APPDATA%\<identifier>\ui-locale` ——前端切换界面语言时经
/// `set_locale_pref` 落盘的偏好，splash 先于 WebView 启动、读不到
/// localStorage，只能从磁盘读；缺失时退回系统 UI 语言。
pub fn show(identifier: &str) {
    let locale_file = std::env::var_os("APPDATA")
        .map(|d| std::path::PathBuf::from(d).join(identifier).join("ui-locale"));
    std::thread::spawn(move || run_splash(locale_file));
}

/// 请求关闭 splash（线程安全，重复调用无害）。
pub fn close() {
    CLOSE_REQUESTED.store(true, Ordering::SeqCst);
    let hwnd = SPLASH_HWND.load(Ordering::SeqCst);
    if hwnd != 0 {
        unsafe {
            PostMessageW(hwnd as HWND, WM_CLOSE, 0, 0);
        }
    }
}

fn rnd() -> f32 {
    RNG.with(|s| {
        let mut x = s.get();
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        s.set(x);
        (x >> 8) as f32 / ((u32::MAX >> 8) as f32)
    })
}

fn hsl_to_rgb(h: f32, s: f32, l: f32) -> (f32, f32, f32) {
    let s = s / 100.0;
    let l = l / 100.0;
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let hp = (h / 60.0).rem_euclid(6.0);
    let x = c * (1.0 - (hp % 2.0 - 1.0).abs());
    let (r, g, b) = match hp as i32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = l - c / 2.0;
    ((r + m) * 255.0, (g + m) * 255.0, (b + m) * 255.0)
}

// ─── 软件光栅化基元（全部加性混合，等价 canvas 'lighter'）────────────────

#[inline]
fn add_px(buf: &mut [u8], wp: i32, hp: i32, x: i32, y: i32, r: f32, g: f32, b: f32, a: f32) {
    if a <= 0.003 || x < 0 || y < 0 || x >= wp || y >= hp {
        return;
    }
    let i = ((y * wp + x) * 4) as usize;
    buf[i] = (buf[i] as f32 + b * a).min(255.0) as u8;
    buf[i + 1] = (buf[i + 1] as f32 + g * a).min(255.0) as u8;
    buf[i + 2] = (buf[i + 2] as f32 + r * a).min(255.0) as u8;
}

/// 抗锯齿实心圆（等价 ctx.arc + fill）
fn draw_circle(buf: &mut [u8], wp: i32, hp: i32, cx: f32, cy: f32, rad: f32, c: (f32, f32, f32), a: f32) {
    let rad = rad.max(0.5);
    let x0 = (cx - rad - 1.0).floor() as i32;
    let x1 = (cx + rad + 1.0).ceil() as i32;
    let y0 = (cy - rad - 1.0).floor() as i32;
    let y1 = (cy + rad + 1.0).ceil() as i32;
    for y in y0..=y1 {
        for x in x0..=x1 {
            let dx = x as f32 + 0.5 - cx;
            let dy = y as f32 + 0.5 - cy;
            let dist = (dx * dx + dy * dy).sqrt();
            let cov = (rad + 0.5 - dist).clamp(0.0, 1.0);
            add_px(buf, wp, hp, x, y, c.0, c.1, c.2, cov * a);
        }
    }
}

/// 径向辉光（等价 createRadialGradient 内亮外透 + 'lighter'）
fn draw_glow(buf: &mut [u8], wp: i32, hp: i32, cx: f32, cy: f32, rad: f32, c: (f32, f32, f32), a0: f32) {
    let x0 = (cx - rad).floor() as i32;
    let x1 = (cx + rad).ceil() as i32;
    let y0 = (cy - rad).floor() as i32;
    let y1 = (cy + rad).ceil() as i32;
    for y in y0..=y1 {
        for x in x0..=x1 {
            let dx = x as f32 + 0.5 - cx;
            let dy = y as f32 + 0.5 - cy;
            let t = (dx * dx + dy * dy).sqrt() / rad;
            if t < 1.0 {
                add_px(buf, wp, hp, x, y, c.0, c.1, c.2, a0 * (1.0 - t));
            }
        }
    }
}

/// 四角星（等价 JS drawSpark 的菱形星路径：横竖两个细长菱形取并集）
fn draw_star(buf: &mut [u8], wp: i32, hp: i32, cx: f32, cy: f32, s: f32, c: (f32, f32, f32), a: f32) {
    let ext = s * 2.2 + 1.0;
    let x0 = (cx - ext).floor() as i32;
    let x1 = (cx + ext).ceil() as i32;
    let y0 = (cy - ext).floor() as i32;
    let y1 = (cy + ext).ceil() as i32;
    let sharp = (s * 2.0).max(1.5);
    for y in y0..=y1 {
        for x in x0..=x1 {
            let dx = (x as f32 + 0.5 - cx).abs();
            let dy = (y as f32 + 0.5 - cy).abs();
            let v1 = 1.0 - (dx / (s * 2.2) + dy / (s * 0.6));
            let v2 = 1.0 - (dx / (s * 0.6) + dy / (s * 2.2));
            let cov = (v1.max(v2) * sharp).clamp(0.0, 1.0);
            add_px(buf, wp, hp, x, y, c.0, c.1, c.2, cov * a);
        }
    }
}

/// 旋转矩形碎片（等价 JS drawShard；三角/矩形在 1~3px 下视觉无差，统一矩形）
fn draw_shard(buf: &mut [u8], wp: i32, hp: i32, cx: f32, cy: f32, s: f32, rot: f32, c: (f32, f32, f32), a: f32) {
    let ext = s * 1.6 + 1.0;
    let x0 = (cx - ext).floor() as i32;
    let x1 = (cx + ext).ceil() as i32;
    let y0 = (cy - ext).floor() as i32;
    let y1 = (cy + ext).ceil() as i32;
    let (sn, cs) = rot.sin_cos();
    let (hw, hh) = (s * 1.4, s * 0.7);
    for y in y0..=y1 {
        for x in x0..=x1 {
            let dx = x as f32 + 0.5 - cx;
            let dy = y as f32 + 0.5 - cy;
            let lx = (dx * cs + dy * sn).abs();
            let ly = (-dx * sn + dy * cs).abs();
            let cov = ((hw - lx).min(hh - ly) + 0.5).clamp(0.0, 1.0);
            add_px(buf, wp, hp, x, y, c.0, c.1, c.2, cov * a);
        }
    }
}

// ─── 粒子物理（逻辑坐标推进，常数与 startup-loader.js 逐一对应）──────────

fn spawn_in(hl: f32, initial: bool) -> P {
    let c = IN_PALETTE[(rnd() * IN_PALETTE.len() as f32) as usize % IN_PALETTE.len()];
    P {
        is_in: true,
        x0: -30.0 - rnd() * 60.0,
        y0: rnd() * hl,
        t: if initial { rnd() * 0.9 } else { 0.0 },
        dt: 0.0020 + rnd() * 0.0020,
        wob_a: 3.0 + rnd() * 9.0,
        wob_f: 4.0 + rnd() * 6.0,
        wob_p: rnd() * std::f32::consts::TAU,
        rot: rnd() * std::f32::consts::TAU,
        spin: (rnd() - 0.5) * 0.16,
        shape: if rnd() < 0.45 { 1 } else { 0 },
        angle: 0.0, d: 0.0, v: 0.0,
        spark: false, tw: 0.0,
        size: 0.5 + rnd() * 2.3,
        hue: c.0, sat: c.1,
        light: 38.0 + rnd() * 30.0,
        x: 0.0, y: 0.0, vx: 0.0, vy: 0.0, alpha: 0.0,
    }
}

fn spawn_out(wl: f32, out_x: f32, initial: bool) -> P {
    let gold = rnd() < 0.15;
    let mut p = P {
        is_in: false,
        x0: 0.0, y0: 0.0, t: 0.0, dt: 0.0,
        wob_a: 0.0, wob_f: 0.0, wob_p: 0.0,
        rot: 0.0, spin: 0.0, shape: 0,
        angle: (rnd() * 2.0 - 1.0) * (std::f32::consts::PI * 0.345),
        d: 2.0 + rnd() * 6.0,
        v: 0.45 + rnd() * 0.55,
        spark: gold || rnd() < 0.22,
        tw: rnd() * std::f32::consts::TAU,
        size: if gold { 1.6 + rnd() * 0.8 } else { 1.2 + rnd() * 0.8 },
        hue: if gold { 46.0 } else { 190.0 + rnd() * 12.0 },
        sat: if gold { 95.0 } else { 90.0 },
        light: if gold { 68.0 + rnd() * 8.0 } else { 72.0 + rnd() * 12.0 },
        x: 0.0, y: 0.0, vx: 0.0, vy: 0.0, alpha: 0.0,
    };
    if initial {
        let warm = rnd();
        p.d += warm * (wl - out_x).max(300.0) * 0.9;
        p.v *= 1.0 + warm * 2.2;
    }
    p
}

fn step(st: &mut State) {
    let (in_x, in_y) = (st.wl / 2.0 - st.logo_r, st.hl / 2.0);
    let (out_x, out_y) = (st.wl / 2.0 + st.logo_r, st.hl / 2.0);
    for i in 0..st.particles.len() {
        let p = &mut st.particles[i];
        if p.is_in {
            let (px, py) = (p.x, p.y);
            p.t += p.dt * (0.45 + p.t * 1.35);
            if p.t >= 1.0 {
                st.particles[i] = spawn_out(st.wl, out_x, false);
                continue;
            }
            p.x = p.x0 + (in_x - p.x0) * p.t;
            // 颠簸随 t 衰减：杂乱信息接近黑洞被逐渐「整流」
            let damp = (1.0 - p.t).powf(1.3);
            let wobble = (p.t * p.wob_f * std::f32::consts::TAU + p.wob_p).sin() * p.wob_a * damp;
            let ey = 1.0 - (1.0 - p.t).powf(1.7);
            p.y = p.y0 + (in_y - p.y0) * ey + wobble;
            p.rot += p.spin;
            p.vx = p.x - px;
            p.vy = p.y - py;
            let fade_in = ((p.x + 30.0) / 80.0).min(1.0);
            let absorb = if p.t > 0.93 { (1.0 - p.t) / 0.07 } else { 1.0 };
            p.alpha = (fade_in * absorb).max(0.0) * 0.85;
        } else {
            p.v *= 1.009;
            p.d += p.v;
            p.x = out_x + p.angle.cos() * p.d;
            p.y = out_y + p.angle.sin() * p.d;
            p.vx = p.angle.cos() * p.v;
            p.vy = p.angle.sin() * p.v;
            p.tw += 0.11;
            p.alpha = (p.d / 26.0).min(1.0) * (0.82 + p.tw.sin() * 0.13);
            if p.x > st.wl + 30.0 || p.y < -30.0 || p.y > st.hl + 30.0 {
                st.particles[i] = spawn_in(st.hl, false);
            }
        }
    }
}

// ─── 帧合成 ──────────────────────────────────────────────────────────────

fn render(st: &mut State) {
    st.frame.copy_from_slice(&st.base);
    let s = st.scale;
    let (wp, hp) = (st.wp, st.hp);

    // 借用拆分：帧缓冲与粒子数组分离，避免可变别名
    let frame = &mut st.frame;
    for pi in 0..st.particles.len() {
        let p = &st.particles[pi];
        if p.alpha <= 0.01 {
            continue;
        }
        let rgb = hsl_to_rgb(p.hue, p.sat, p.light);

        // 短拖尾：沿速度反方向 3 段渐隐
        for k in (1..=3).rev() {
            let tx = p.x - p.vx * k as f32 * 2.2;
            let ty = p.y - p.vy * k as f32 * 2.2;
            let tm = logo_mask_xy(st.wl, st.hl, st.logo_r, tx, ty);
            if tm <= 0.01 {
                continue;
            }
            let a = p.alpha * (1.0 - k as f32 / 4.0) * 0.45 * tm;
            draw_circle(frame, wp, hp, tx * s, ty * s, p.size * 0.55 * s, rgb, a);
        }

        let m = logo_mask_xy(st.wl, st.hl, st.logo_r, p.x, p.y);
        if m <= 0.01 {
            continue;
        }
        let a = p.alpha * m;
        if p.spark {
            // 柔光光晕 + 四角星（高价值产出粒子）
            draw_glow(frame, wp, hp, p.x * s, p.y * s, p.size * 5.0 * s, rgb, a * 0.35 * 0.8);
            draw_star(frame, wp, hp, p.x * s, p.y * s, p.size * 0.8 * s, rgb, a);
        } else if p.is_in && p.shape == 1 {
            draw_shard(frame, wp, hp, p.x * s, p.y * s, p.size * s, p.rot, rgb, a);
        } else {
            draw_circle(frame, wp, hp, p.x * s, p.y * s, p.size * s, rgb, a);
        }
    }

    // logo 置顶混合（直通 alpha srcover）
    let dst = st.logo_dst;
    let lx = (wp - dst) / 2;
    let ly = (hp - dst) / 2;
    for row in 0..dst {
        let fy = ly + row;
        if fy < 0 || fy >= hp {
            continue;
        }
        for col in 0..dst {
            let fx = lx + col;
            if fx < 0 || fx >= wp {
                continue;
            }
            let si = ((row * dst + col) * 4) as usize;
            let a = st.logo[si + 3] as f32 / 255.0;
            if a <= 0.004 {
                continue;
            }
            let di = ((fy * wp + fx) * 4) as usize;
            let blend = |d: u8, c: u8| -> u8 { (d as f32 * (1.0 - a) + c as f32 * a) as u8 };
            st.frame[di] = blend(st.frame[di], st.logo[si + 2]);     // B
            st.frame[di + 1] = blend(st.frame[di + 1], st.logo[si + 1]); // G
            st.frame[di + 2] = blend(st.frame[di + 2], st.logo[si]);     // R
        }
    }

    // 状态提示文字：预渲染掩码 srcover 混入帧，随帧一次性上屏（不闪烁）。
    // 阶段按流逝时间推进，最后一条与 WebView 载入屏文案一致。
    if !st.text_masks.is_empty() {
        let idx = ((st.started.elapsed().as_secs_f32() / 1.5) as usize)
            .min(st.text_masks.len() - 1);
        let mask = &st.text_masks[idx];
        // 文本顶端 = logo 中心 + 半个 stage(130) + gap(28)，与 CSS 载入屏布局同比例
        let top = ((st.hl / 2.0 + 130.0 + 28.0) * s) as i32;
        // CSS 色 rgba(226,232,240,0.72)
        const TXT: (f32, f32, f32) = (226.0, 232.0, 240.0);
        for row in 0..st.text_h {
            let fy = top + row;
            if fy < 0 || fy >= hp {
                continue;
            }
            for col in 0..wp {
                let cov = mask[(row * wp + col) as usize];
                if cov == 0 {
                    continue;
                }
                let a = cov as f32 / 255.0 * 0.72;
                let di = ((fy * wp + col) * 4) as usize;
                st.frame[di] = (st.frame[di] as f32 * (1.0 - a) + TXT.2 * a) as u8;
                st.frame[di + 1] = (st.frame[di + 1] as f32 * (1.0 - a) + TXT.1 * a) as u8;
                st.frame[di + 2] = (st.frame[di + 2] as f32 * (1.0 - a) + TXT.0 * a) as u8;
            }
        }
    }
}

/// logo 圆内不绘制、圆外 14 逻辑 px 羽化（与 JS logoMask 一致）
fn logo_mask_xy(wl: f32, hl: f32, logo_r: f32, x: f32, y: f32) -> f32 {
    let dx = x - wl / 2.0;
    let dy = y - hl / 2.0;
    let d = (dx * dx + dy * dy).sqrt();
    ((d - logo_r) / 14.0).clamp(0.0, 1.0)
}

/// 静态底图：CSS 同款渐变背景 + 洞口辉光（一次性预计算）
fn build_base(wp: i32, hp: i32, scale: f32, logo_r_l: f32) -> Vec<u8> {
    let mut buf = vec![0u8; (wp * hp * 4) as usize];
    let (w, h) = (wp as f32, hp as f32);
    let (cx, cy) = (w / 2.0, h / 2.0);
    let corner = (cx * cx + cy * cy).sqrt();
    // radial-gradient(circle, #0b1020 0%, #06070d 100%)
    let c1 = (0x0b as f32, 0x10 as f32, 0x20 as f32);
    let c2 = (BG.0 as f32, BG.1 as f32, BG.2 as f32);
    for y in 0..hp {
        for x in 0..wp {
            let dx = x as f32 - cx;
            let dy = y as f32 - cy;
            let t = ((dx * dx + dy * dy).sqrt() / corner).min(1.0);
            let i = ((y * wp + x) * 4) as usize;
            buf[i] = (c1.2 + (c2.2 - c1.2) * t) as u8;
            buf[i + 1] = (c1.1 + (c2.1 - c1.1) * t) as u8;
            buf[i + 2] = (c1.0 + (c2.0 - c1.0) * t) as u8;
            buf[i + 3] = 255;
        }
    }
    // 两个椭圆色晕：ellipse at 38%/62% 50%，透明止于 45%
    let ellipse = |buf: &mut Vec<u8>, ecx: f32, color: (f32, f32, f32), a0: f32| {
        let rx = w * 0.62;
        let ry = h * 0.5;
        for y in 0..hp {
            for x in 0..wp {
                let dx = (x as f32 - ecx) / rx;
                let dy = (y as f32 - cy) / ry;
                let t = (dx * dx + dy * dy).sqrt();
                if t < 0.45 {
                    let a = a0 * (1.0 - t / 0.45);
                    let i = ((y * wp + x) * 4) as usize;
                    buf[i] = (buf[i] as f32 * (1.0 - a) + color.2 * a) as u8;
                    buf[i + 1] = (buf[i + 1] as f32 * (1.0 - a) + color.1 * a) as u8;
                    buf[i + 2] = (buf[i + 2] as f32 * (1.0 - a) + color.0 * a) as u8;
                }
            }
        }
    };
    ellipse(&mut buf, w * 0.38, (255.0, 120.0, 40.0), 0.10);
    ellipse(&mut buf, w * 0.62, (120.0, 200.0, 255.0), 0.12);
    // 洞口辉光（canvas 'lighter' 同款）
    let logo_r = logo_r_l * scale;
    draw_glow(&mut buf, wp, hp, cx - logo_r, cy, logo_r * 1.2, (255.0, 120.0, 40.0), 0.10);
    draw_glow(&mut buf, wp, hp, cx + logo_r, cy, logo_r * 1.3, (120.0, 210.0, 255.0), 0.12);
    buf
}

/// 解码并双线性缩放 logo 到目标边长（RGBA 直通 alpha）
fn build_logo(dst: i32) -> Option<Vec<u8>> {
    let img = image::load_from_memory(LOGO_PNG).ok()?;
    let rgba = img.to_rgba8();
    let (sw, sh) = (rgba.width() as i32, rgba.height() as i32);
    if sw == 0 || sh == 0 {
        return None;
    }
    let src = rgba.as_raw();
    let mut out = vec![0u8; (dst * dst * 4) as usize];
    for y in 0..dst {
        for x in 0..dst {
            let fx = (x as f32 + 0.5) / dst as f32 * sw as f32 - 0.5;
            let fy = (y as f32 + 0.5) / dst as f32 * sh as f32 - 0.5;
            let x0 = (fx.floor() as i32).clamp(0, sw - 1);
            let y0 = (fy.floor() as i32).clamp(0, sh - 1);
            let x1 = (x0 + 1).min(sw - 1);
            let y1 = (y0 + 1).min(sh - 1);
            let tx = fx - x0 as f32;
            let ty = fy - y0 as f32;
            let di = ((y * dst + x) * 4) as usize;
            for ch in 0..4 {
                let p00 = src[((y0 * sw + x0) * 4) as usize + ch] as f32;
                let p10 = src[((y0 * sw + x1) * 4) as usize + ch] as f32;
                let p01 = src[((y1 * sw + x0) * 4) as usize + ch] as f32;
                let p11 = src[((y1 * sw + x1) * 4) as usize + ch] as f32;
                let v = p00 * (1.0 - tx) * (1.0 - ty) + p10 * tx * (1.0 - ty)
                    + p01 * (1.0 - tx) * ty + p11 * tx * ty;
                out[di + ch] = v as u8;
            }
        }
    }
    Some(out)
}

// ─── 窗口过程与消息循环 ─────────────────────────────────────────────────

/// 把一条提示文案预渲染成整宽度灰度覆盖条（黑底白字，取单通道作 alpha 掩码）。
/// 式样对齐 WebView 载入屏 .app-loading-text：15 逻辑 px、字距 1px、水平居中。
unsafe fn render_text_mask(text: &[u16], font: HFONT, wp: i32, text_h: i32, scale: f32) -> Vec<u8> {
    let empty = vec![0u8; (wp * text_h) as usize];
    let hdc = CreateCompatibleDC(std::ptr::null_mut());
    if hdc.is_null() {
        return empty;
    }
    let mut bmi: BITMAPINFO = std::mem::zeroed();
    bmi.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: wp,
        biHeight: -text_h,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB,
        ..std::mem::zeroed()
    };
    let mut bits: *mut winapi::ctypes::c_void = std::ptr::null_mut();
    let hbm = CreateDIBSection(hdc, &bmi, DIB_RGB_COLORS, &mut bits, std::ptr::null_mut(), 0);
    if hbm.is_null() || bits.is_null() {
        if !hbm.is_null() {
            DeleteObject(hbm as _);
        }
        DeleteDC(hdc);
        return empty;
    }
    let old_bm = SelectObject(hdc, hbm as _);
    let old_font = SelectObject(hdc, font as _);
    SetBkMode(hdc, TRANSPARENT as i32);
    SetTextColor(hdc, 0x00FF_FFFF); // DIB 初始为全黑，白字灰度即覆盖度
    SetTextCharacterExtra(hdc, scale.round() as i32); // letter-spacing: 1px
    let mut rc = RECT { left: 0, top: 0, right: wp, bottom: text_h };
    DrawTextW(
        hdc,
        text.as_ptr(),
        text.len() as i32,
        &mut rc,
        DT_CENTER | DT_TOP | DT_SINGLELINE | DT_NOCLIP,
    );
    GdiFlush();
    let px = std::slice::from_raw_parts(bits as *const u8, (wp * text_h * 4) as usize);
    let mask: Vec<u8> = (0..(wp * text_h) as usize).map(|i| px[i * 4]).collect();
    SelectObject(hdc, old_font);
    SelectObject(hdc, old_bm);
    DeleteObject(hbm as _);
    DeleteDC(hdc);
    mask
}

unsafe fn blit(hwnd: HWND, st: &State) {
    let hdc = GetDC(hwnd);
    let mut bmi: BITMAPINFO = std::mem::zeroed();
    bmi.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: st.wp,
        biHeight: -st.hp, // 顶朝下
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB,
        ..std::mem::zeroed()
    };
    SetDIBitsToDevice(
        hdc, 0, 0, st.wp as u32, st.hp as u32,
        0, 0, 0, st.hp as u32,
        st.frame.as_ptr() as *const _,
        &bmi,
        DIB_RGB_COLORS,
    );
    ReleaseDC(hwnd, hdc);
}

unsafe extern "system" fn wnd_proc(hwnd: HWND, msg: UINT, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_PAINT => {
            let mut ps: PAINTSTRUCT = std::mem::zeroed();
            let hdc = BeginPaint(hwnd, &mut ps);
            let painted = STATE.with(|s| {
                if let Some(st) = s.borrow_mut().as_mut() {
                    let mut bmi: BITMAPINFO = std::mem::zeroed();
                    bmi.bmiHeader = BITMAPINFOHEADER {
                        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                        biWidth: st.wp,
                        biHeight: -st.hp,
                        biPlanes: 1,
                        biBitCount: 32,
                        biCompression: BI_RGB,
                        ..std::mem::zeroed()
                    };
                    SetDIBitsToDevice(
                        hdc, 0, 0, st.wp as u32, st.hp as u32,
                        0, 0, 0, st.hp as u32,
                        st.frame.as_ptr() as *const _,
                        &bmi,
                        DIB_RGB_COLORS,
                    );
                    true
                } else {
                    false
                }
            });
            if !painted {
                // 状态尚未就绪：纯色背景兜底
                let mut rc: RECT = std::mem::zeroed();
                winapi::um::winuser::GetClientRect(hwnd, &mut rc);
                BG_BRUSH.with(|b| {
                    FillRect(hdc, &rc, b.get());
                });
            }
            EndPaint(hwnd, &ps);
            0
        }
        WM_ERASEBKGND => 1,
        WM_TIMER => {
            if wp == TIMER_TICK {
                let ready = STATE.with(|s| {
                    if let Some(st) = s.borrow_mut().as_mut() {
                        // 固定步长 + 真实时间补偿：WM_TIMER 触发间隔不稳定（≥15.6ms
                        // 且消息会被合并），按实际流逝时间推进相应步数，
                        // 保证与 60fps rAF 的 HTML 版流速一致。
                        let now = std::time::Instant::now();
                        st.acc_ms += now.duration_since(st.last_tick).as_secs_f32() * 1000.0;
                        st.last_tick = now;
                        // 上限防卡顿后猛跳（掉帧超过 4 步就丢弃多余时间）
                        st.acc_ms = st.acc_ms.min(STEP_MS * 4.0);
                        let mut stepped = false;
                        while st.acc_ms >= STEP_MS {
                            step(st);
                            st.acc_ms -= STEP_MS;
                            stepped = true;
                        }
                        if stepped {
                            render(st);
                        }
                        stepped
                    } else {
                        false
                    }
                });
                if ready {
                    // 直接 blit，绕过 Invalidate/WM_PAINT 合并带来的节流
                    STATE.with(|s| {
                        if let Some(st) = s.borrow().as_ref() {
                            blit(hwnd, st);
                        }
                    });
                }
            } else {
                // 兜底定时器：WebView 迟迟不就绪也要自行退场
                DestroyWindow(hwnd);
            }
            0
        }
        WM_CLOSE => {
            DestroyWindow(hwnd);
            0
        }
        WM_DESTROY => {
            SPLASH_HWND.store(0, Ordering::SeqCst);
            STATE.with(|s| *s.borrow_mut() = None);
            PostQuitMessage(0);
            0
        }
        _ => DefWindowProcW(hwnd, msg, wp, lp),
    }
}

fn run_splash(locale_file: Option<std::path::PathBuf>) {
    if CLOSE_REQUESTED.load(Ordering::SeqCst) {
        return;
    }
    // 界面语言：优先应用内设置（磁盘偏好文件），缺失时退回系统 UI 语言
    let is_zh = match locale_file.and_then(|p| std::fs::read_to_string(p).ok()) {
        Some(s) => s.trim() == "zh",
        None => unsafe { (GetUserDefaultUILanguage() & 0x3ff) == 0x04 }, // LANG_CHINESE
    };

    unsafe {
        // 抢在 tao 之前把进程 DPI 感知设为 PerMonitorV2（进程级仅第一次调用生效，
        // 之后 tao 的 become_dpi_aware 再设会失败但无害）。
        // 不设的话本线程可能在 DPI 虚拟化下拿到 96 DPI，splash 以 1200×800 物理像素创建；
        // 而主窗口是 1200×800 逻辑像素（×缩放），高分屏上两个窗口尺寸不一致，切换时跳变。
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

        let hinstance = GetModuleHandleW(std::ptr::null());
        let class_name: Vec<u16> = "OpenFluxSplashWindow\0".encode_utf16().collect();

        let bg_brush = CreateSolidBrush(BG_COLORREF);
        BG_BRUSH.with(|b| b.set(bg_brush));

        let wc = WNDCLASSW {
            style: 0,
            lpfnWndProc: Some(wnd_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinstance,
            hIcon: std::ptr::null_mut(),
            // 必须显式指定光标：留空会让系统一直沿用启动时的「忙碌」漏斗光标
            hCursor: LoadCursorW(std::ptr::null_mut(), IDC_ARROW),
            hbrBackground: bg_brush,
            lpszMenuName: std::ptr::null(),
            lpszClassName: class_name.as_ptr(),
        };
        if RegisterClassW(&wc) == 0 {
            return;
        }

        // 用主显示器的有效 DPI（与 tao 的 get_monitor_dpi 同源：GetDpiForMonitor/MDT_EFFECTIVE_DPI），
        // 保证 splash 与主窗口按同一缩放系数换算物理尺寸；失败时退回 GetDeviceCaps。
        let dpi = {
            let hmon = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
            let (mut dx, mut dy): (UINT, UINT) = (0, 0);
            if GetDpiForMonitor(hmon, MDT_EFFECTIVE_DPI, &mut dx, &mut dy) == 0 && dx > 0 {
                dx as i32
            } else {
                let hdc = GetDC(std::ptr::null_mut());
                let d = GetDeviceCaps(hdc, LOGPIXELSX);
                ReleaseDC(std::ptr::null_mut(), hdc);
                d
            }
        };
        let scale = if dpi > 0 { dpi as f32 / 96.0 } else { 1.0 };

        let wp = (WIN_LOGICAL.0 * scale) as i32;
        let hp = (WIN_LOGICAL.1 * scale) as i32;

        let mut wa: RECT = std::mem::zeroed();
        SystemParametersInfoW(SPI_GETWORKAREA, 0, &mut wa as *mut _ as *mut _, 0);
        let x = wa.left + ((wa.right - wa.left) - wp) / 2;
        let y = wa.top + ((wa.bottom - wa.top) - hp) / 2;

        let hwnd = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
            class_name.as_ptr(),
            std::ptr::null(),
            WS_POPUP,
            x, y, wp, hp,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            hinstance,
            std::ptr::null_mut(),
        );
        if hwnd.is_null() {
            return;
        }
        SPLASH_HWND.store(hwnd as isize, Ordering::SeqCst);

        if CLOSE_REQUESTED.load(Ordering::SeqCst) {
            PostMessageW(hwnd, WM_CLOSE, 0, 0);
        }

        // 先显示（纯色兜底背景），重初始化随后完成——保证窗口即刻可见
        ShowWindow(hwnd, SW_SHOW);
        UpdateWindow(hwnd);

        // 随机种子加入时间扰动
        RNG.with(|s| {
            let t = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(12345);
            s.set(s.get() ^ t | 1);
        });

        // 初始化渲染状态（底图/缩放 logo/粒子预热）
        let logo_dst = (LOGO_LOGICAL * scale) as i32;
        let logo_r_l = LOGO_LOGICAL / 2.0 + 6.0;
        let wl = WIN_LOGICAL.0;
        let hl = WIN_LOGICAL.1;
        let base = build_base(wp, hp, scale, logo_r_l);
        let logo = build_logo(logo_dst).unwrap_or_else(|| vec![0u8; (logo_dst * logo_dst * 4) as usize]);

        // 状态提示文字：15 逻辑 px Segoe UI（中文由 GDI 字体链接自动回落），
        // 分阶段文案按系统 UI 语言选择，最后一条与 WebView 载入屏完全一致。
        // 每条文案预渲染成灰度覆盖条，之后每帧混进帧缓冲（见 render），字体用完即释放。
        let font_name: Vec<u16> = "Segoe UI\0".encode_utf16().collect();
        let font = CreateFontW(
            -((15.0 * scale).round() as i32), 0, 0, 0, FW_NORMAL as i32,
            0, 0, 0,
            DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
            ANTIALIASED_QUALITY, DEFAULT_PITCH | FF_DONTCARE,
            font_name.as_ptr(),
        );
        let msgs_src: &[&str] = if is_zh {
            &["正在启动应用…", "正在初始化界面引擎…", "智能体正在初始化…"]
        } else {
            &["Starting application…", "Initializing UI engine…", "Agent is initializing…"]
        };
        let text_h = (24.0 * scale).ceil() as i32;
        let text_masks: Vec<Vec<u8>> = msgs_src
            .iter()
            .map(|m| {
                let utf16: Vec<u16> = m.encode_utf16().collect();
                render_text_mask(&utf16, font, wp, text_h, scale)
            })
            .collect();
        if !font.is_null() {
            DeleteObject(font as _);
        }

        let mut st = State {
            wp, hp, scale, wl, hl,
            logo_r: logo_r_l,
            frame: base.clone(),
            base,
            logo,
            logo_dst,
            particles: Vec::with_capacity(PARTICLE_COUNT),
            last_tick: std::time::Instant::now(),
            acc_ms: 0.0,
            started: std::time::Instant::now(),
            text_h,
            text_masks,
        };
        let out_x = wl / 2.0 + logo_r_l;
        for i in 0..PARTICLE_COUNT {
            if i % 2 == 0 {
                st.particles.push(spawn_in(hl, true));
            } else {
                st.particles.push(spawn_out(wl, out_x, true));
            }
        }
        // 预热：与 JS 版一致跑 60 步，首帧即充盈
        for _ in 0..60 {
            step(&mut st);
        }
        render(&mut st);
        st.last_tick = std::time::Instant::now();
        STATE.with(|s| *s.borrow_mut() = Some(st));
        InvalidateRect(hwnd, std::ptr::null(), 0);

        SetTimer(hwnd, TIMER_CLOSE, 15_000, None);
        SetTimer(hwnd, TIMER_TICK, TICK_MS, None);

        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}
