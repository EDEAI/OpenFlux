import { strict as assert } from 'node:assert';
import test from 'node:test';
import type { PresentationQualityIssue } from './model';
import {
    MIN_TEXT_FIT_FONT_SCALE,
    isPresentationTextShapeName,
    planTextFitRepairs,
    presentationTextShapeName,
    visualTextUnits,
} from './text-fit';

function overflow(shape: string, boundHeight: number, availableHeight: number, extra: Partial<PresentationQualityIssue> = {}): PresentationQualityIssue {
    return {
        severity: 'error',
        code: 'text_overflow',
        slide: 8,
        shape,
        message: `Text exceeds its box (${shape}).`,
        overflow: { boundHeight, availableHeight, lineCount: 6, textLength: 71 },
        ...extra,
    };
}

test('text shape names are stable and recognisable', () => {
    assert.equal(presentationTextShapeName(11, 3), 'ofx-text-11-3');
    assert.ok(isPresentationTextShapeName('ofx-text-11-3'));
    assert.ok(!isPresentationTextShapeName('Rectangle 4'));
    assert.ok(!isPresentationTextShapeName(undefined));
});

test('visual units count full-width glyphs double', () => {
    assert.equal(visualTextUnits('abc'), 3);
    assert.equal(visualTextUnits('中文'), 4);
    assert.equal(visualTextUnits('GTC 2026柏林'), 8 + 4);
});

test('an overflow shrinks the named box by its measured ratio with a margin', () => {
    const plan = planTextFitRepairs([overflow('ofx-text-8-5', 174, 148)]);
    assert.equal(plan.changed, true);
    assert.deepEqual(plan.repairedShapes, ['ofx-text-8-5']);
    assert.deepEqual(plan.unrepairable, []);
    const scale = plan.overrides['ofx-text-8-5'].fontScale!;
    // 148/174 = 0.851, times the 0.94 margin.
    assert.ok(scale > 0.79 && scale < 0.81, `unexpected scale ${scale}`);
    assert.equal(plan.overrides['ofx-text-8-5'].attempts?.text_overflow, 1);
});

test('repeated overflow compounds the shrink from the previous override', () => {
    const first = planTextFitRepairs([overflow('ofx-text-8-5', 174, 148)]);
    const second = planTextFitRepairs([overflow('ofx-text-8-5', 160, 148)], first.overrides);
    const firstScale = first.overrides['ofx-text-8-5'].fontScale!;
    const secondScale = second.overrides['ofx-text-8-5'].fontScale!;
    assert.ok(secondScale < firstScale);
    assert.equal(second.overrides['ofx-text-8-5'].attempts?.text_overflow, 2);
});

test('an overflow that would need shrinking below the floor is unrepairable', () => {
    const previous = { 'ofx-text-8-5': { fontScale: MIN_TEXT_FIT_FONT_SCALE } };
    const plan = planTextFitRepairs([overflow('ofx-text-8-5', 300, 148)], previous);
    assert.equal(plan.changed, false);
    assert.equal(plan.unrepairable.length, 1);
});

test('a finding without a renderer shape name is left for the model', () => {
    const plan = planTextFitRepairs([overflow('Rectangle 7', 174, 148)]);
    assert.equal(plan.changed, false);
    assert.equal(plan.unrepairable[0].shape, 'Rectangle 7');
});

test('a CJK orphan is first re-wrapped at the measured line width', () => {
    const issue: PresentationQualityIssue = {
        severity: 'warning',
        code: 'cjk_orphan_line',
        slide: 11,
        shape: 'ofx-text-11-9',
        message: 'orphan',
        cjkLine: { lineCount: 3, firstLineChars: 12, lastLineChars: 1, textLength: 20, firstLineText: 'Google与Meta数小时相' },
    };
    const plan = planTextFitRepairs([issue]);
    assert.equal(plan.changed, true);
    const override = plan.overrides['ofx-text-11-9'];
    // 'Google与Meta数小时相' = 10 latin + 5 CJK = 20 units, minus 1 headroom.
    assert.equal(override.wrapUnits, 19);
    assert.equal(override.fontScale, undefined);
});

test('a CJK orphan that survives the re-wrap shrinks and re-measures', () => {
    const issue: PresentationQualityIssue = {
        severity: 'warning',
        code: 'cjk_orphan_line',
        slide: 11,
        shape: 'ofx-text-11-9',
        message: 'orphan',
        cjkLine: { lineCount: 2, firstLineChars: 9, lastLineChars: 2, textLength: 11, firstLineText: '美国版权表态或重塑' },
    };
    const first = planTextFitRepairs([issue]);
    const second = planTextFitRepairs([issue], first.overrides);
    const override = second.overrides['ofx-text-11-9'];
    assert.ok(override.fontScale! < 1);
    // 18 units at the old size; a 0.94 font fits 18/0.94 = 19.1 -> 19, minus headroom.
    assert.equal(override.wrapUnits, 18);
    const third = planTextFitRepairs([issue], second.overrides);
    const fourth = planTextFitRepairs([issue], third.overrides);
    assert.equal(fourth.changed, false);
    assert.equal(fourth.unrepairable.length, 1);
});

test('a box that overflows and mis-wraps in one pass gets its wrap width scaled to the new font', () => {
    const orphan: PresentationQualityIssue = {
        severity: 'warning',
        code: 'cjk_orphan_line',
        slide: 11,
        shape: 'ofx-text-11-5',
        message: 'orphan',
        cjkLine: { lineCount: 3, firstLineChars: 12, lastLineChars: 1, textLength: 20, firstLineText: 'Google与Meta数' },
    };
    const plan = planTextFitRepairs([overflow('ofx-text-11-5', 55, 42), orphan]);
    const override = plan.overrides['ofx-text-11-5'];
    // 42/55 * 0.94 = 0.718; 14 units measured at full size fit 14/0.718 = 19.5 at the new size.
    assert.equal(override.fontScale, 0.718);
    assert.equal(override.wrapUnits, 18);
});

test('a multi-line overflow also calibrates the wrap width from the rendered lines', () => {
    const plan = planTextFitRepairs([overflow('ofx-text-8-5', 174, 148, {
        overflow: {
            boundHeight: 174,
            availableHeight: 148,
            lineCount: 6,
            textLength: 71,
            firstLineText: 'SimReady资产代理：',
            lineTexts: ['SimReady资产代理：', '一句话生成可仿真3D模型', 'GTC 2026欧洲站10月柏林，', '黄仁勋主讲', '主题锁定物理AI、', '机器人与工业数字孪生'],
        },
    })]);
    const override = plan.overrides['ofx-text-8-5'];
    assert.equal(override.fontScale, 0.8);
    // Widest line is 'GTC 2026欧洲站10月柏林，' = 8 + 6 + 2 + 6 + 2 = 24 units; at 0.8 that is 30, minus headroom.
    assert.equal(override.wrapUnits, 29);
});

test('a single-line overflow does not invent a wrap width', () => {
    const plan = planTextFitRepairs([overflow('ofx-text-2-1', 30, 24, {
        overflow: { boundHeight: 30, availableHeight: 24, lineCount: 1, textLength: 12, firstLineText: '一句话结论', lineTexts: ['一句话结论'] },
    })]);
    assert.equal(plan.overrides['ofx-text-2-1'].wrapUnits, undefined);
});

test('the widest rendered line, not the first, measures the box capacity', () => {
    const orphan: PresentationQualityIssue = {
        severity: 'warning',
        code: 'cjk_orphan_line',
        slide: 11,
        shape: 'ofx-text-11-5',
        message: 'orphan',
        cjkLine: {
            lineCount: 3,
            firstLineChars: 11,
            lastLineChars: 3,
            textLength: 20,
            firstLineText: 'Google与Meta',
            lineTexts: ['Google与Meta', '数小时相继发新', '模型'],
        },
    };
    const plan = planTextFitRepairs([orphan]);
    // '数小时相继发新' is 14 units, wider than the 12-unit first line.
    assert.equal(plan.overrides['ofx-text-11-5'].wrapUnits, 13);
});

test('a number split across lines is re-wrapped at the measured width', () => {
    const issue: PresentationQualityIssue = {
        severity: 'warning',
        code: 'numeric_token_split',
        slide: 3,
        shape: 'ofx-text-3-9',
        message: 'split',
        cjkLine: { lineCount: 2, firstLineChars: 5, lastLineChars: 7, textLength: 12, firstLineText: '约 17:', lineTexts: ['约 17:', '00 UTC 后'] },
    };
    const plan = planTextFitRepairs([issue]);
    assert.equal(plan.changed, true);
    // Widest line '00 UTC 后' = 2 + 1 + 3 + 1 + 2 = 9 units, minus headroom.
    assert.equal(plan.overrides['ofx-text-3-9'].wrapUnits, 8);
    assert.equal(plan.overrides['ofx-text-3-9'].fontScale, undefined);
});

test('an overlap caused by an overflow defers to the overflow repair', () => {
    const overlap: PresentationQualityIssue = {
        severity: 'error',
        code: 'text_overlap',
        slide: 11,
        shapes: ['ofx-text-11-9', 'ofx-text-11-12'],
        message: 'overlap',
    };
    const plan = planTextFitRepairs([overflow('ofx-text-11-9', 55, 42), overlap]);
    assert.deepEqual(plan.repairedShapes, ['ofx-text-11-9']);
    assert.equal(plan.overrides['ofx-text-11-12'], undefined);
    assert.deepEqual(plan.unrepairable, []);
});

test('an overlap between two fitting boxes shrinks both, then gives up', () => {
    const overlap: PresentationQualityIssue = {
        severity: 'error',
        code: 'text_overlap',
        slide: 3,
        shapes: ['ofx-text-3-2', 'ofx-text-3-4'],
        message: 'overlap',
    };
    const first = planTextFitRepairs([overlap]);
    assert.deepEqual(first.repairedShapes, ['ofx-text-3-2', 'ofx-text-3-4']);
    assert.equal(first.overrides['ofx-text-3-2'].fontScale, 0.9);
    const second = planTextFitRepairs([overlap], first.overrides);
    assert.equal(second.overrides['ofx-text-3-2'].fontScale, 0.81);
    const third = planTextFitRepairs([overlap], second.overrides);
    assert.equal(third.changed, false);
    assert.equal(third.unrepairable.length, 1);
});

test('out-of-bounds and non-mechanical findings are not touched', () => {
    const plan = planTextFitRepairs([
        { severity: 'error', code: 'text_out_of_bounds', slide: 2, shape: 'ofx-text-2-1', message: 'off canvas' },
        { severity: 'warning', code: 'layout_silhouette_dominates_deck', message: 'rhythm' },
    ]);
    assert.equal(plan.changed, false);
    assert.equal(plan.unrepairable.length, 1);
    assert.equal(plan.unrepairable[0].code, 'text_out_of_bounds');
});

test('previous overrides are not mutated', () => {
    const previous = { 'ofx-text-8-5': { fontScale: 0.9, attempts: { text_overflow: 1 } } };
    planTextFitRepairs([overflow('ofx-text-8-5', 174, 148)], previous);
    assert.equal(previous['ofx-text-8-5'].fontScale, 0.9);
    assert.equal(previous['ofx-text-8-5'].attempts.text_overflow, 1);
});
