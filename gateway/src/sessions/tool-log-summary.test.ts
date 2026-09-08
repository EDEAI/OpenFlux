import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeToolResultForLog } from './tool-log-summary';

test('a failure keeps the reason a later investigation needs', () => {
    // The return that left nothing behind: the count reached the transcript and
    // the cause sat one level down in data, where nothing was reading.
    const summary = summarizeToolResultForLog({
        success: false,
        code: 'presentation_visual_review_unavailable',
        error: 'Only 0/3 visual directions produced readable previews.',
        cause: { name: 'Error', message: 'spawn ENAMETOOLONG', code: 'ENAMETOOLONG' },
        retryable: false,
        data: {
            route: 'local_presentation',
            stage: 'sample',
            nextAction: 'restart_runtime_and_resume_same_design',
            workflowState: { designId: 'abc', qa: { errors: 3, warnings: 7 } },
        },
    });
    assert.ok(summary);
    assert.match(summary, /"success":false/);
    assert.match(summary, /presentation_visual_review_unavailable/);
    assert.match(summary, /spawn ENAMETOOLONG/);
    assert.match(summary, /"stage":"sample"/);
    assert.match(summary, /"errors":3/);
});

test('base64 payloads are counted, never copied', () => {
    const summary = summarizeToolResultForLog({
        success: true,
        images: [{ mimeType: 'image/png', data: 'A'.repeat(4_000) }],
        data: { preview: 'B'.repeat(2_000), path: 'D:/out/deck.pptx' },
    });
    assert.ok(summary);
    assert.equal(summary.includes('AAAA'), false, 'an image must not reach the log');
    assert.equal(summary.includes('BBBB'), false, 'a nested blob must not reach the log');
    assert.match(summary, /<1 image\(s\) omitted>/);
    assert.match(summary, /<2000 chars omitted>/);
    // Ordinary fields beside a blob still have to survive it.
    assert.match(summary, /deck\.pptx/);
});

test('a long result is coarsened rather than dropped', () => {
    const summary = summarizeToolResultForLog({
        success: false,
        code: 'office_read_failed',
        error: 'Sheet not found',
        data: {
            rows: Array.from({ length: 5_000 }, (_, index) => ({
                index,
                text: `row ${index} with a fair amount of trailing prose to pad it out`,
            })),
        },
    });
    assert.ok(summary);
    assert.ok(summary.length <= 4_000, `summary must stay bounded, got ${summary.length}`);
    // The fields a diagnosis starts from outrank the payload that crowded them.
    assert.match(summary, /office_read_failed/);
    assert.match(summary, /Sheet not found/);
});

test('a success is identified without being transcribed', () => {
    const summary = summarizeToolResultForLog({
        success: true,
        summary: 'Read 3 sheets: 明细, 汇总, 参数',
        data: { sheets: ['明细', '汇总', '参数'], rowCount: 28_989 },
    });
    assert.ok(summary);
    assert.match(summary, /Read 3 sheets/);
    assert.match(summary, /"success":true/);
});

test('an empty return is not logged as a summary', () => {
    assert.equal(summarizeToolResultForLog(undefined), undefined);
    assert.equal(summarizeToolResultForLog(null), undefined);
    assert.equal(summarizeToolResultForLog('plain text'), 'plain text');
});

test('a circular result does not take the turn down with it', () => {
    const cyclic: Record<string, unknown> = { success: false, error: 'boom' };
    cyclic.self = cyclic;
    // JSON.stringify throws on a cycle; a log helper must never be the thing
    // that fails a turn that already failed.
    assert.doesNotThrow(() => summarizeToolResultForLog(cyclic));
});
