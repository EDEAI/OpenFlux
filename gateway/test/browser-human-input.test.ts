import assert from 'node:assert/strict';
import test from 'node:test';
import {
    describeKey, jitterPoint, keyHoldMs, planScrollTicks, scrollTickDelayMs, shouldTypo, thinkDelayMs,
    typingDelayMs, typoFor,
} from '../../src/panel/browser-human-input';

/** Deterministic LCG so distributions are checked over many samples without flakiness. */
function seeded(seed = 42): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return (s + 0.5) / 4294967296;
    };
}

test('printable characters map to US-layout keys with code, keyCode, text and shift', () => {
    assert.deepEqual(describeKey('a'), { key: 'a', code: 'KeyA', keyCode: 65, text: 'a', shift: false });
    assert.deepEqual(describeKey('A'), { key: 'A', code: 'KeyA', keyCode: 65, text: 'A', shift: true });
    assert.deepEqual(describeKey('1'), { key: '1', code: 'Digit1', keyCode: 49, text: '1', shift: false });
    assert.deepEqual(describeKey('!'), { key: '!', code: 'Digit1', keyCode: 49, text: '!', shift: true });
    assert.deepEqual(describeKey(','), { key: ',', code: 'Comma', keyCode: 188, text: ',', shift: false });
    assert.deepEqual(describeKey('<'), { key: '<', code: 'Comma', keyCode: 188, text: '<', shift: true });
    assert.deepEqual(describeKey('?'), { key: '?', code: 'Slash', keyCode: 191, text: '?', shift: true });
    assert.deepEqual(describeKey(' '), { key: ' ', code: 'Space', keyCode: 32, text: ' ', shift: false });
});

test('named keys, aliases and control characters resolve; unmapped characters do not', () => {
    assert.deepEqual(describeKey('Enter'), { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r', shift: false });
    assert.deepEqual(describeKey('\n'), describeKey('Enter'));
    assert.deepEqual(describeKey('return'), describeKey('Enter'));
    assert.deepEqual(describeKey('\t'), describeKey('Tab'));
    assert.deepEqual(describeKey('Backspace'), { key: 'Backspace', code: 'Backspace', keyCode: 8, text: undefined, shift: false });
    assert.equal(describeKey('esc')?.code, 'Escape');
    assert.equal(describeKey('ArrowDown')?.keyCode, 40);
    assert.equal(describeKey('down')?.code, 'ArrowDown');
    assert.equal(describeKey('F5')?.keyCode, 116);
    assert.equal(describeKey('Control')?.code, 'ControlLeft');
    assert.equal(describeKey('中'), undefined);
    assert.equal(describeKey('é'), undefined);
    assert.equal(describeKey('😀'), undefined);
    assert.equal(describeKey('ab'), undefined);
    assert.equal(describeKey(''), undefined);
});

test('typing cadence stays within human bounds and hesitates at word boundaries', () => {
    const rng = seeded(7);
    let plain = 0;
    let boundary = 0;
    const n = 2000;
    for (let i = 0; i < n; i++) {
        const a = typingDelayMs('e', 'r', rng);
        const b = typingDelayMs('e', ' ', rng);
        assert.ok(a >= 35 && a <= 1300, `plain delay ${a}`);
        assert.ok(b >= 35 && b <= 1400, `boundary delay ${b}`);
        plain += a;
        boundary += b;
    }
    const meanPlain = plain / n;
    const meanBoundary = boundary / n;
    assert.ok(meanPlain > 70 && meanPlain < 160, `mean plain ${meanPlain}`);
    assert.ok(meanBoundary > meanPlain + 30, `boundary ${meanBoundary} should exceed plain ${meanPlain}`);
    // Doubled letters come faster than a fresh key.
    let dbl = 0;
    for (let i = 0; i < n; i++) dbl += typingDelayMs('l', 'l', rng);
    assert.ok(dbl / n < meanPlain, `double-letter mean ${dbl / n} vs ${meanPlain}`);
    for (let i = 0; i < 200; i++) {
        const hold = keyHoldMs(rng);
        assert.ok(hold >= 25 && hold <= 110);
    }
});

test('typos are rare, letters only, and land on an adjacent key preserving case', () => {
    const rng = seeded(3);
    let slips = 0;
    for (let i = 0; i < 10000; i++) if (shouldTypo('e', rng)) slips++;
    assert.ok(slips > 150 && slips < 350, `typo rate ${slips / 10000}`);
    for (let i = 0; i < 100; i++) {
        assert.equal(shouldTypo('1', rng), false);
        assert.equal(shouldTypo(' ', rng), false);
        assert.equal(shouldTypo('中', rng), false);
    }
    const neighbours = new Set<string>();
    for (let i = 0; i < 200; i++) neighbours.add(typoFor('g', rng));
    for (const n of neighbours) assert.ok('fhtyvb'.includes(n), `g -> ${n}`);
    assert.ok(neighbours.size >= 3);
    assert.match(typoFor('G', rng), /^[FHTYVB]$/);
    assert.equal(typoFor('中', rng), '中');
});

test('scroll is split into tapering wheel notches that sum exactly to the request', () => {
    const rng = seeded(11);
    for (const [dx, dy] of [[0, 600], [0, -900], [300, 0], [-120, 1500], [0, 45]] as Array<[number, number]>) {
        const ticks = planScrollTicks(dx, dy, rng);
        assert.ok(ticks.length >= 1 && ticks.length <= 14, `${ticks.length} ticks for ${dy}`);
        assert.equal(ticks.reduce((s, t) => s + t.dx, 0), dx);
        assert.equal(ticks.reduce((s, t) => s + t.dy, 0), dy);
        if (Math.abs(dy) >= 400) {
            assert.ok(ticks.length >= 3, `${Math.abs(dy)}px should take several notches, got ${ticks.length}`);
            // Strong first, gentle last.
            assert.ok(Math.abs(ticks[0].dy) > Math.abs(ticks[ticks.length - 1].dy));
            for (const t of ticks) assert.ok(Math.sign(t.dy) === Math.sign(dy) || t.dy === 0);
        }
    }
    assert.deepEqual(planScrollTicks(0, 20, rng), [{ dx: 0, dy: 20 }]);
    for (let i = 0; i < 6; i++) {
        const d = scrollTickDelayMs(i, 6, rng);
        assert.ok(d >= 18 && d <= 60);
    }
    assert.ok(scrollTickDelayMs(5, 6, () => 0) > scrollTickDelayMs(0, 6, () => 0));
});

test('click points spread inside the target box but never reach its edge', () => {
    const rng = seeded(5);
    const seen = new Set<string>();
    for (let i = 0; i < 3000; i++) {
        const p = jitterPoint(100, 50, 120, 32, rng);
        assert.ok(p.x >= 100 - 60 + 2 && p.x <= 100 + 60 - 2, `x ${p.x}`);
        assert.ok(p.y >= 50 - 16 + 2 && p.y <= 50 + 16 - 2, `y ${p.y}`);
        seen.add(`${p.x},${p.y}`);
    }
    assert.ok(seen.size > 100, 'points should vary');
    assert.deepEqual(jitterPoint(10, 10, 4, 4, rng), { x: 10, y: 10 });
    assert.deepEqual(jitterPoint(10, 10, 0, 0, rng), { x: 10, y: 10 });
});

test('think time before an action is bounded per kind and longest after a navigation', () => {
    const rng = seeded(9);
    const bounds = { click: [350, 900], type: [180, 450], key: [120, 350], scroll: [200, 650], drag: [300, 700], navigate: [500, 1800] } as const;
    for (const [kind, [lo, hi]] of Object.entries(bounds)) {
        for (let i = 0; i < 300; i++) {
            const ms = thinkDelayMs(kind as keyof typeof bounds, rng);
            assert.ok(ms >= lo && ms <= hi, `${kind}: ${ms}`);
        }
    }
});
