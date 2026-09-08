import { strict as assert } from 'node:assert';
import test from 'node:test';
import { bulletChunks, fitPresentationArgsToCapacity } from './capacity';
import { evaluatePresentationPlan, parsePresentationPlan } from './model';
import { planPresentationLayouts } from './layout-engine';

const short = (index: number) => `要点${index}：简短的一句话结论`;
const long = (index: number) => `要点${index}：这是一条比较长的说明，包含背景、数据来源以及对结论的具体支撑，用来占满两行`;

test('three bullets always stay on one page regardless of weight', () => {
    assert.deepEqual(bulletChunks([long(1), long(2), long(3)], 4), [[long(1), long(2), long(3)]]);
});

test('five bullets over capacity split evenly instead of four plus one', () => {
    const bullets = [long(1), long(2), long(3), long(4), long(5)];
    const pages = bulletChunks(bullets, 5);
    assert.equal(pages.length, 2);
    assert.deepEqual(pages.map(page => page.length), [3, 2]);
    assert.deepEqual(pages.flat(), bullets);
});

test('five short bullets stay on one page rather than filling a thin continuation', () => {
    const bullets = [short(1), short(2), short(3), short(4), short(5)];
    assert.deepEqual(bulletChunks(bullets, 5), [bullets]);
    // A tighter density limit forces a split; it still splits evenly.
    assert.deepEqual(bulletChunks(bullets, 4).map(page => page.length), [3, 2]);
});

test('a long list never strands a single bullet on a page', () => {
    const bullets = Array.from({ length: 9 }, (_, index) => long(index + 1));
    const pages = bulletChunks(bullets, 4);
    assert.ok(pages.every(page => page.length >= 2), JSON.stringify(pages.map(page => page.length)));
    assert.deepEqual(pages.flat(), bullets);
});

test('capacity planning of a five-bullet editorial page produces no orphan continuation', () => {
    const args = {
        brief: {
            title: '每周简报',
            audience: '团队',
            purpose: 'inform',
            desired_outcome: '团队了解本周五条要点',
            communication_job: '让团队在一页内看完本周要点并知道下周关注什么。',
            language: 'zh-CN',
            narrative_arc: ['开场', '要点', '收尾'],
        },
        art_direction: { palette: { background: '0C0C10', surface: '1A1A22', text: 'F7F4EE', muted: '9A948C', accent: 'F0B90B', accent2: 'D92632' } },
        slides: [
            { purpose: '开场', message: '本周概览', title: '本周概览', layout: { archetype: 'cover' } },
            {
                purpose: '罗列本周要点',
                message: '五条要点',
                title: '本周五条要点',
                layout: { archetype: 'editorial', variant: 'banded', emphasis: 'message', whitespace: 'balanced' },
                bullets: [long(1), long(2), long(3), short(4), short(5)],
            },
            { purpose: '收尾', message: '谢谢', title: '谢谢', layout: { archetype: 'closing' } },
        ],
    };
    const capacity = fitPresentationArgsToCapacity(args, { coalesceContinuations: true });
    const plan = parsePresentationPlan(capacity.args);
    planPresentationLayouts(plan);
    const issues = evaluatePresentationPlan(plan);
    assert.ok(!issues.some(issue => issue.code === 'orphaned_continuation_page'), JSON.stringify(issues));
    const continuationPages = plan.slides.filter(slide => /（\d+\/\d+）$/.test(slide.title || ''));
    if (continuationPages.length) {
        assert.ok(continuationPages.every(slide => slide.bullets.length >= 2), JSON.stringify(continuationPages.map(slide => slide.bullets.length)));
    }
});
