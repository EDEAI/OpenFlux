import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_HARD_ITERATION_CEILING, ITERATION_BUDGET_EXTENSION, extendedBudget, isProgressing, type IterationProgressSample } from './iteration-budget';

const s = (mutations = 0, novel = 0, duplicates = 0): IterationProgressSample => ({ mutations, novel, duplicates });

test('a turn that writes or runs things is progressing; one that only re-reads is not', () => {
    assert.equal(isProgressing([s(0, 1), s(1, 0), s(0, 0)]), true, 'one mutation in the window');
    assert.equal(isProgressing([s(0, 1), s(0, 1), s(0, 1)]), true, 'three novel reads');
    assert.equal(isProgressing([s(0, 1, 2), s(0, 1, 3), s(0, 1, 2)]), false, 'novel reads drowned by repeats');
    assert.equal(isProgressing([s(0, 0, 4), s(0, 0, 4)]), false, 'only duplicates');
    assert.equal(isProgressing([]), false);
});

test('only the recent window counts', () => {
    const early = Array.from({ length: 10 }, () => s(2, 2));
    const stalled = Array.from({ length: 10 }, () => s(0, 0, 3));
    assert.equal(isProgressing([...early, ...stalled]), false);
    assert.equal(isProgressing([...stalled, s(1)]), true);
});

test('budget extends only when about to finalize, progressing, and under the ceiling', () => {
    assert.equal(extendedBudget(30, 29, 120, true), 30 + ITERATION_BUDGET_EXTENSION, 'one left → extend');
    assert.equal(extendedBudget(30, 20, 120, true), 30, 'plenty left → no change');
    assert.equal(extendedBudget(30, 29, 120, false), 30, 'not progressing → finalize');
    assert.equal(extendedBudget(110, 109, 120, true), 120, 'clamped to the ceiling');
    assert.equal(extendedBudget(120, 119, 120, true), 120, 'at the ceiling → stays');
    assert.equal(DEFAULT_HARD_ITERATION_CEILING, 120);
});
