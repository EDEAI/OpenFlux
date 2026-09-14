/**
 * Human input model for the embedded browser: how a person types, presses
 * keys, scrolls, pauses and where they actually click inside a target.
 *
 * Pure functions only — no DOM, no timers, no CDP. The panel
 * (`browser-pane.ts`) and the gateway tool (`browser-control`) consume these
 * to schedule real events; tests feed a seeded `rng` to check the shapes.
 */

export type Rng = () => number;

/** A key as CDP `Input.dispatchKeyEvent` wants it, on a US layout. */
export interface KeyDescriptor {
    /** DOM `KeyboardEvent.key`, e.g. `a`, `A`, `!`, `Enter`. */
    key: string;
    /** Physical `KeyboardEvent.code`, e.g. `KeyA`, `Digit1`, `Enter`. */
    code: string;
    /** Windows virtual key code (`windowsVirtualKeyCode`). */
    keyCode: number;
    /** Character the key produces, if any (`\r` for Enter, `\t` for Tab). */
    text?: string;
    /** True when a US layout needs Shift held to produce `key`. */
    shift: boolean;
}

const NAMED_KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
    Enter: { code: 'Enter', keyCode: 13, text: '\r' },
    Tab: { code: 'Tab', keyCode: 9, text: '\t' },
    Escape: { code: 'Escape', keyCode: 27 },
    Backspace: { code: 'Backspace', keyCode: 8 },
    Delete: { code: 'Delete', keyCode: 46 },
    Insert: { code: 'Insert', keyCode: 45 },
    ArrowUp: { code: 'ArrowUp', keyCode: 38 },
    ArrowDown: { code: 'ArrowDown', keyCode: 40 },
    ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
    ArrowRight: { code: 'ArrowRight', keyCode: 39 },
    Home: { code: 'Home', keyCode: 36 },
    End: { code: 'End', keyCode: 35 },
    PageUp: { code: 'PageUp', keyCode: 33 },
    PageDown: { code: 'PageDown', keyCode: 34 },
    Space: { code: 'Space', keyCode: 32, text: ' ' },
    CapsLock: { code: 'CapsLock', keyCode: 20 },
    Shift: { code: 'ShiftLeft', keyCode: 16 },
    Control: { code: 'ControlLeft', keyCode: 17 },
    Alt: { code: 'AltLeft', keyCode: 18 },
    Meta: { code: 'MetaLeft', keyCode: 91 },
    ContextMenu: { code: 'ContextMenu', keyCode: 93 },
};
for (let i = 1; i <= 12; i++) NAMED_KEYS[`F${i}`] = { code: `F${i}`, keyCode: 111 + i };

/** Common spellings models use for named keys. */
const KEY_ALIASES: Record<string, string> = {
    return: 'Enter', enter: 'Enter', esc: 'Escape', escape: 'Escape', del: 'Delete', delete: 'Delete',
    backspace: 'Backspace', tab: 'Tab', space: 'Space', spacebar: 'Space',
    up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
    arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
    home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', insert: 'Insert',
    ctrl: 'Control', control: 'Control', alt: 'Alt', option: 'Alt', shift: 'Shift',
    meta: 'Meta', cmd: 'Meta', command: 'Meta', win: 'Meta', capslock: 'CapsLock', contextmenu: 'ContextMenu',
};

/** Shifted digit symbols on a US layout, indexed by the digit. */
const SHIFTED_DIGITS = ')!@#$%^&*(';

/** [unshifted, shifted, code, keyCode] for US punctuation keys. */
const PUNCTUATION: Array<[string, string, string, number]> = [
    ['-', '_', 'Minus', 189],
    ['=', '+', 'Equal', 187],
    ['[', '{', 'BracketLeft', 219],
    [']', '}', 'BracketRight', 221],
    ['\\', '|', 'Backslash', 220],
    [';', ':', 'Semicolon', 186],
    ["'", '"', 'Quote', 222],
    [',', '<', 'Comma', 188],
    ['.', '>', 'Period', 190],
    ['/', '?', 'Slash', 191],
    ['`', '~', 'Backquote', 192],
];

/**
 * Describe a named key (`Enter`, `ArrowDown`, `F5`) or a single printable
 * character on a US keyboard. Returns undefined for characters that have no
 * key on that layout (CJK, emoji, accented letters); callers insert those as
 * text instead.
 */
export function describeKey(input: string): KeyDescriptor | undefined {
    if (!input) return undefined;
    const named = NAMED_KEYS[input] ?? (input.length > 1 ? NAMED_KEYS[KEY_ALIASES[input.toLowerCase()] ?? ''] : undefined);
    if (named) {
        const key = NAMED_KEYS[input] ? input : KEY_ALIASES[input.toLowerCase()];
        return { key: key === 'Space' ? ' ' : key, code: named.code, keyCode: named.keyCode, text: named.text, shift: false };
    }
    if (Array.from(input).length !== 1) return undefined;
    const ch = input;
    if (ch === '\n' || ch === '\r') return describeKey('Enter');
    if (ch === '\t') return describeKey('Tab');
    if (ch === ' ') return { key: ' ', code: 'Space', keyCode: 32, text: ' ', shift: false };
    if (/^[a-z]$/.test(ch)) return { key: ch, code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0), text: ch, shift: false };
    if (/^[A-Z]$/.test(ch)) return { key: ch, code: `Key${ch}`, keyCode: ch.charCodeAt(0), text: ch, shift: true };
    if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, keyCode: 48 + Number(ch), text: ch, shift: false };
    const shiftedDigit = SHIFTED_DIGITS.indexOf(ch);
    if (shiftedDigit >= 0) return { key: ch, code: `Digit${shiftedDigit}`, keyCode: 48 + shiftedDigit, text: ch, shift: true };
    for (const [plain, shifted, code, keyCode] of PUNCTUATION) {
        if (ch === plain) return { key: ch, code, keyCode, text: ch, shift: false };
        if (ch === shifted) return { key: ch, code, keyCode, text: ch, shift: true };
    }
    return undefined;
}

// ── Randomness ───────────────────────────────────────────────────────────────

/** Standard normal sample (Box–Muller). */
export function gaussian(rng: Rng = Math.random): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Normal sample with mean/sd, clamped to [min, max]. */
export function clampedGaussian(mean: number, sd: number, min: number, max: number, rng: Rng = Math.random): number {
    return Math.min(max, Math.max(min, mean + sd * gaussian(rng)));
}

/** Triangular sample in [min, max], peaked at the middle. */
export function between(min: number, max: number, rng: Rng = Math.random): number {
    return min + (max - min) * (rng() + rng()) / 2;
}

// ── Typing ───────────────────────────────────────────────────────────────────

const QWERTY_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

/** A physically adjacent letter on a QWERTY keyboard, preserving case. */
export function typoFor(ch: string, rng: Rng = Math.random): string {
    const lower = ch.toLowerCase();
    const candidates: string[] = [];
    for (let r = 0; r < QWERTY_ROWS.length; r++) {
        const c = QWERTY_ROWS[r].indexOf(lower);
        if (c < 0) continue;
        const row = QWERTY_ROWS[r];
        if (c > 0) candidates.push(row[c - 1]);
        if (c < row.length - 1) candidates.push(row[c + 1]);
        for (const dr of [-1, 1]) {
            const other = QWERTY_ROWS[r + dr];
            if (!other) continue;
            // Rows are staggered by roughly half a key.
            for (const dc of [0, dr > 0 ? -1 : 1]) {
                const n = other[c + dc];
                if (n) candidates.push(n);
            }
        }
    }
    if (candidates.length === 0) return ch;
    const pick = candidates[Math.floor(rng() * candidates.length) % candidates.length];
    return ch === lower ? pick : pick.toUpperCase();
}

/** Whether to slip on this character: only plain letters, at a low rate. */
export function shouldTypo(ch: string, rng: Rng = Math.random, rate = 0.025): boolean {
    return /^[a-zA-Z]$/.test(ch) && rng() < rate;
}

/**
 * Milliseconds to wait before pressing `next`, given the previous character.
 * Roughly 50–60 wpm with the hesitations people actually have: a beat at
 * word boundaries, a reach for Shift, fast doubled letters, the occasional
 * long think.
 */
export function typingDelayMs(prev: string | undefined, next: string, rng: Rng = Math.random): number {
    let ms = clampedGaussian(95, 35, 35, 260, rng);
    if (next === ' ' || (prev !== undefined && /[.,;:!?]/.test(prev))) ms += between(40, 120, rng);
    if (/[A-Z]/.test(next) || (describeKey(next)?.shift ?? false)) ms += between(20, 60, rng);
    if (prev !== undefined && prev === next) ms *= 0.7;
    if (describeKey(next) === undefined) ms += between(30, 90, rng); // IME / composed character
    if (rng() < 0.03) ms += between(400, 900, rng);
    return Math.round(ms);
}

/** How long a key stays down. */
export function keyHoldMs(rng: Rng = Math.random): number {
    return Math.round(clampedGaussian(55, 20, 25, 110, rng));
}

// ── Pointer ──────────────────────────────────────────────────────────────────

/**
 * Where inside a target box a person actually clicks: near the centre with
 * normal spread, never within the outer margin (so it stays on the element
 * even with borders/padding). Tiny targets get their exact centre.
 */
export function jitterPoint(cx: number, cy: number, w: number, h: number, rng: Rng = Math.random): { x: number; y: number } {
    if (!(w >= 6) || !(h >= 6)) return { x: cx, y: cy };
    const marginX = Math.max(2, w * 0.15);
    const marginY = Math.max(2, h * 0.15);
    const dx = clampedGaussian(0, w / 7, -(w / 2 - marginX), w / 2 - marginX, rng);
    const dy = clampedGaussian(0, h / 7, -(h / 2 - marginY), h / 2 - marginY, rng);
    return { x: Math.round(cx + dx), y: Math.round(cy + dy) };
}

// ── Scrolling ────────────────────────────────────────────────────────────────

/**
 * Split one scroll into wheel ticks the way a flick of a real wheel/trackpad
 * arrives: several notches, strong first and tapering off, that sum exactly
 * to the requested deltas.
 */
export function planScrollTicks(deltaX: number, deltaY: number, rng: Rng = Math.random): Array<{ dx: number; dy: number }> {
    const dominant = Math.max(Math.abs(deltaX), Math.abs(deltaY));
    if (dominant < 40) return [{ dx: deltaX, dy: deltaY }];
    const count = Math.max(2, Math.min(14, Math.round(dominant / 110 + between(-0.5, 0.5, rng))));
    const weights: number[] = [];
    for (let i = 0; i < count; i++) {
        const t = i / count;
        weights.push(Math.pow(1 - t, 1.3) + 0.15 + rng() * 0.12);
    }
    const sum = weights.reduce((a, b) => a + b, 0);
    const ticks: Array<{ dx: number; dy: number }> = [];
    let usedX = 0;
    let usedY = 0;
    for (let i = 0; i < count; i++) {
        const last = i === count - 1;
        const dx = last ? deltaX - usedX : Math.round(deltaX * weights[i] / sum);
        const dy = last ? deltaY - usedY : Math.round(deltaY * weights[i] / sum);
        usedX += dx;
        usedY += dy;
        ticks.push({ dx, dy });
    }
    return ticks;
}

/** Gap before tick `index` of `count`: quick at first, slowing as it settles. */
export function scrollTickDelayMs(index: number, count: number, rng: Rng = Math.random): number {
    const t = count > 1 ? index / (count - 1) : 0;
    return Math.round(18 + 24 * t + rng() * 14);
}

// ── Pacing between actions ───────────────────────────────────────────────────

export type ThinkKind = 'click' | 'type' | 'key' | 'scroll' | 'drag' | 'navigate';

/**
 * How long a person pauses before an action: seeing the target, deciding,
 * moving a hand. `navigate` is the reading pause after a page lands.
 */
export function thinkDelayMs(kind: ThinkKind, rng: Rng = Math.random): number {
    switch (kind) {
        case 'click': return Math.round(between(350, 900, rng));
        case 'type': return Math.round(between(180, 450, rng));
        case 'key': return Math.round(between(120, 350, rng));
        case 'scroll': return Math.round(between(200, 650, rng));
        case 'drag': return Math.round(between(300, 700, rng));
        case 'navigate': return Math.round(between(500, 1800, rng));
    }
}
