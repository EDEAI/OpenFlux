/**
 * 启动载入动画（独立经典脚本，不进主 bundle）
 * =====================================================
 * 以 OpenFlux logo 为核心的「黑洞吸收 / 白洞产出」全屏定向粒子流。
 *
 * 视觉语义：
 *   左侧：数据、内容、经验（琥珀色小粒子）从屏幕外广域飞入，汇聚进 logo 左缘的黑洞；
 *   右侧：更有价值的内容与动作（青白色亮粒子、星形闪光）从 logo 右缘的白洞喷出，
 *         向右侧广域扩散飞出屏幕外。
 *   轨迹为平滑汇聚/扩散曲线，无螺旋舞动；logo 本体始终不被粒子遮挡。
 *
 * 为什么是独立脚本：主 bundle 下载/解析本身是启动耗时大户，动画若在 bundle 内
 * 会错过最需要它的时段。本脚本以经典 <script src> 解析即执行，早于模块 bundle。
 *
 * 对外接口（供 main.ts 收尾）：
 *   window.__openfluxLoaderStartedAt : number   动画起始时间戳
 *   window.__openfluxLoader.finale()            收尾爆发（全部转为白洞喷发）
 *   window.__openfluxLoader.destroy()           停止并移除
 */
(function () {
    'use strict';

    var overlay = document.getElementById('app-loading-overlay');
    var logoEl = document.querySelector('.app-loading-logo');
    if (!overlay) return;

    window.__openfluxLoaderStartedAt = Date.now();

    var reduced = (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) || false;

    // 画布铺满整个启动窗口（overlay 是 fixed inset:0）
    var canvas = document.createElement('canvas');
    canvas.className = 'startup-loader-canvas';
    overlay.appendChild(canvas);
    var ctx = canvas.getContext('2d');
    if (!ctx) return;

    var raf = null;
    var particles = [];
    var dpr = 1, w = 0, h = 0;
    var logoCx = 0, logoCy = 0, logoR = 70;
    var inX = 0, inY = 0;    // 黑洞（logo 左缘）
    var outX = 0, outY = 0;  // 白洞（logo 右缘）
    var finishing = false;
    var MARGIN = 30;         // 屏幕外余量：粒子在可视区外出生/消亡

    function resize() {
        var rect = overlay.getBoundingClientRect();
        w = Math.max(1, rect.width);
        h = Math.max(1, rect.height);
        dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        // logo 实际位置（overlay 为全屏 fixed，client 坐标即画布坐标）
        if (logoEl) {
            var lr = logoEl.getBoundingClientRect();
            logoCx = lr.left + lr.width / 2;
            logoCy = lr.top + lr.height / 2;
            logoR = lr.width / 2 + 6;
        } else {
            logoCx = w / 2;
            logoCy = h / 2;
            logoR = 70;
        }
        inX = logoCx - logoR; inY = logoCy;
        outX = logoCx + logoR; outY = logoCy;
        if (reduced) draw();
    }

    // 输入侧杂色盘：土黄/暗橙/灰褐/青灰——低饱和、明度参差，表达原始信息的驳杂
    var IN_PALETTE = [
        { hue: 30, sat: 70 }, { hue: 42, sat: 55 }, { hue: 18, sat: 60 },
        { hue: 50, sat: 30 }, { hue: 200, sat: 12 }, { hue: 25, sat: 20 },
    ];

    /**
     * 吸入粒子：屏幕左侧外出生（y 覆盖全高，广度进入），
     * 沿平滑曲线汇聚到黑洞：y 先于 x 收敛 → 轨迹先弯向水平轴再滑入洞口。
     * 「杂乱」表达：形状混杂（圆点/翻滚碎片）、杂色、大小参差、
     * 轨迹带轻微颠簸——且颠簸随接近黑洞衰减为零（被整流感）。
     */
    function spawnIn(initial) {
        var c = IN_PALETTE[(Math.random() * IN_PALETTE.length) | 0];
        return {
            side: 'in',
            x0: -MARGIN - Math.random() * 60,
            y0: Math.random() * h,
            t: initial ? Math.random() * 0.9 : 0,
            dt: 0.0020 + Math.random() * 0.0020,
            size: 0.5 + Math.random() * 2.3,
            alpha: 0,
            hue: c.hue,
            sat: c.sat,
            light: 38 + Math.random() * 30,
            // 形状：0 圆点 / 1 三角碎片 / 2 矩形碎屑（碎片自转翻滚）
            shape: Math.random() < 0.45 ? ((Math.random() * 2 | 0) + 1) : 0,
            rot: Math.random() * Math.PI * 2,
            spin: (Math.random() - 0.5) * 0.16,
            // 颠簸：垂直小幅摆动，幅度随 t 衰减（接近黑洞被整流）
            wobA: 3 + Math.random() * 9,
            wobF: 4 + Math.random() * 6,
            wobP: Math.random() * Math.PI * 2,
            x: 0, y: 0, vx: 0, vy: 0
        };
    }

    /**
     * 喷出粒子：白洞出生，向右侧扇形（±62°）加速扩散，飞出屏幕外。
     * 「价值」表达：色系纯净统一（青白）、大小均匀、轨迹笔直、
     * 带闪烁与柔光光晕；约 15% 为金色星形（稀缺 = 贵重）。
     */
    function spawnOut(initial) {
        var a = (Math.random() * 2 - 1) * (Math.PI * 0.345);
        var gold = Math.random() < 0.15;
        var p = {
            side: 'out',
            angle: a,
            d: 2 + Math.random() * 6,
            v: 0.45 + Math.random() * 0.55,
            size: gold ? 1.6 + Math.random() * 0.8 : 1.2 + Math.random() * 0.8,
            alpha: 0,
            hue: gold ? 46 : 190 + Math.random() * 12,
            sat: gold ? 95 : 90,
            light: gold ? 68 + Math.random() * 8 : 72 + Math.random() * 12,
            spark: gold || Math.random() < 0.22,  // 金色必为星形；青白少量星形
            gold: gold,
            tw: Math.random() * Math.PI * 2,       // 闪烁相位
            x: 0, y: 0, vx: 0, vy: 0
        };
        if (initial) {
            var warm = Math.random();
            p.d += warm * Math.max(w - outX, 300) * 0.9;
            p.v *= 1 + warm * 2.2;
        }
        return p;
    }

    // y 收敛先于 x：形成「先弯向水平、再滑入洞口」的汇聚曲线（无舞动）
    function easeY(t) { return 1 - Math.pow(1 - t, 1.7); }
    // t 推进随接近洞口加速（吸力感）
    function inSpeed(t) { return 0.45 + t * 1.35; }

    function update() {
        for (var i = 0; i < particles.length; i++) {
            var p = particles[i];
            if (p.side === 'in' && !finishing) {
                var prevX = p.x, prevY = p.y;
                p.t += p.dt * inSpeed(p.t);
                if (p.t >= 1) { particles[i] = spawnOut(false); continue; }
                p.x = p.x0 + (inX - p.x0) * p.t;
                // 颠簸随 t 衰减：杂乱信息接近黑洞时被逐渐「整流」
                var damp = Math.pow(1 - p.t, 1.3);
                var wobble = Math.sin(p.t * p.wobF * Math.PI * 2 + p.wobP) * p.wobA * damp;
                p.y = p.y0 + (inY - p.y0) * easeY(p.t) + wobble;
                p.rot += p.spin;
                p.vx = p.x - prevX; p.vy = p.y - prevY;
                // 进入可视区淡入；接近洞口略微收暗（被吸收感）
                var fadeIn = Math.min(1, (p.x + MARGIN) / 80);
                var absorb = p.t > 0.93 ? (1 - p.t) / 0.07 : 1;
                p.alpha = Math.max(0, fadeIn * absorb) * 0.85;
            } else {
                if (p.side === 'in') { particles[i] = spawnOut(false); continue; }
                var boost = finishing ? 2.4 : 1;
                p.v *= 1.009;
                p.d += p.v * boost;
                p.x = outX + Math.cos(p.angle) * p.d;
                p.y = outY + Math.sin(p.angle) * p.d;
                p.vx = Math.cos(p.angle) * p.v; p.vy = Math.sin(p.angle) * p.v;
                p.tw += 0.11;
                // 基础淡入 × 轻微闪烁（twinkle）：产出粒子的「光感」
                p.alpha = Math.min(1, p.d / 26) * (0.82 + Math.sin(p.tw) * 0.13);
                if (p.x > w + MARGIN || p.y < -MARGIN || p.y > h + MARGIN) {
                    particles[i] = finishing ? spawnOut(false) : spawnIn(false);
                }
            }
        }
    }

    /** logo 圆内不绘制、圆外 14px 羽化——粒子只环绕 logo 周围 */
    function logoMask(x, y) {
        var dx = x - logoCx, dy = y - logoCy;
        var d = Math.sqrt(dx * dx + dy * dy);
        var m = (d - logoR) / 14;
        return m <= 0 ? 0 : (m >= 1 ? 1 : m);
    }

    function glow(x, y, r, inner, outer) {
        var g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, inner);
        g.addColorStop(1, outer);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
    }

    function drawSpark(x, y, s) {
        // 四角星：高价值产出粒子
        ctx.beginPath();
        ctx.moveTo(x, y - s * 2.2);
        ctx.lineTo(x + s * 0.6, y - s * 0.6);
        ctx.lineTo(x + s * 2.2, y);
        ctx.lineTo(x + s * 0.6, y + s * 0.6);
        ctx.lineTo(x, y + s * 2.2);
        ctx.lineTo(x - s * 0.6, y + s * 0.6);
        ctx.lineTo(x - s * 2.2, y);
        ctx.lineTo(x - s * 0.6, y - s * 0.6);
        ctx.closePath();
        ctx.fill();
    }

    /** 输入侧碎片：翻滚的三角 / 矩形碎屑（杂乱的原始信息） */
    function drawShard(p) {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        var s = p.size;
        ctx.beginPath();
        if (p.shape === 1) {
            ctx.moveTo(0, -s * 1.5);
            ctx.lineTo(s * 1.3, s);
            ctx.lineTo(-s * 1.3, s * 0.7);
            ctx.closePath();
            ctx.fill();
        } else {
            ctx.fillRect(-s * 1.4, -s * 0.7, s * 2.8, s * 1.4);
        }
        ctx.restore();
    }

    function draw() {
        ctx.clearRect(0, 0, w, h);

        ctx.globalCompositeOperation = 'lighter';
        glow(inX, inY, logoR * 1.2, 'rgba(255,120,40,0.10)', 'rgba(255,120,40,0)');
        glow(outX, outY, logoR * 1.3, 'rgba(120,210,255,0.12)', 'rgba(120,210,255,0)');

        for (var i = 0; i < particles.length; i++) {
            var p = particles[i];
            if (p.alpha <= 0.01) continue;

            var sat = p.sat != null ? p.sat : 90;

            // 短拖尾：沿速度反方向 3 段渐隐（直线流动感）
            var tail = 3;
            for (var k = tail; k >= 1; k--) {
                var tx = p.x - p.vx * k * 2.2;
                var ty = p.y - p.vy * k * 2.2;
                var tm = logoMask(tx, ty);
                if (tm <= 0.01) continue;
                ctx.globalAlpha = p.alpha * (1 - k / (tail + 1)) * 0.45 * tm;
                ctx.fillStyle = 'hsl(' + p.hue + ', ' + sat + '%, ' + p.light + '%)';
                ctx.beginPath();
                ctx.arc(tx, ty, p.size * 0.55, 0, Math.PI * 2);
                ctx.fill();
            }

            var m = logoMask(p.x, p.y);
            if (m <= 0.01) continue;

            // 星形粒子的柔光光晕（价值感的「发光」）
            if (p.spark) {
                ctx.globalAlpha = p.alpha * m * 0.35;
                glow(p.x, p.y, p.size * 5,
                    'hsla(' + p.hue + ', ' + sat + '%, ' + p.light + '%, 0.8)',
                    'hsla(' + p.hue + ', ' + sat + '%, ' + p.light + '%, 0)');
            }

            ctx.globalAlpha = p.alpha * m;
            ctx.fillStyle = 'hsl(' + p.hue + ', ' + sat + '%, ' + p.light + '%)';
            if (p.spark) drawSpark(p.x, p.y, p.size * 0.8);
            else if (p.side === 'in' && p.shape > 0) drawShard(p);
            else {
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
    }

    function tick() {
        update();
        draw();
        raf = requestAnimationFrame(tick);
    }

    function pause() {
        if (raf != null) { cancelAnimationFrame(raf); raf = null; }
    }
    function resume() {
        if (raf == null) raf = requestAnimationFrame(tick);
    }

    function onVisibility() {
        if (document.hidden) pause();
        else if (!reduced) resume();
    }

    // 初始化
    resize();
    var count = 170;
    for (var i = 0; i < count; i++) {
        particles.push(i % 2 === 0 ? spawnIn(true) : spawnOut(true));
    }
    // 预热：先推进若干步，第一帧就是充盈的粒子流，避免启动瞬间空白
    for (var j = 0; j < 60; j++) update();

    var ro = null;
    if (window.ResizeObserver) {
        ro = new ResizeObserver(resize);
        ro.observe(overlay);
    }
    document.addEventListener('visibilitychange', onVisibility);

    if (reduced) draw(); else resume();

    // WebView 首帧真正上屏后，关闭 Rust 原生启动 splash（双 rAF 确保已完成一次合成）。
    // withGlobalTauri 已开启，经典脚本里可直接使用 window.__TAURI__。
    requestAnimationFrame(function () {
        requestAnimationFrame(function () {
            try {
                var t = window.__TAURI__;
                if (t && t.core && typeof t.core.invoke === 'function') {
                    t.core.invoke('splash_close');
                }
            } catch (e) { /* 非 Tauri 环境（纯浏览器调试）忽略 */ }
        });
    });

    window.__openfluxLoader = {
        finale: function () {
            finishing = true;
            for (var i = 0; i < particles.length; i++) {
                var p = spawnOut(false);
                p.v *= 1.8;
                particles[i] = p;
            }
        },
        destroy: function () {
            pause();
            document.removeEventListener('visibilitychange', onVisibility);
            if (ro) { ro.disconnect(); ro = null; }
            if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
        }
    };
})();
