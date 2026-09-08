import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';
import sharp from 'sharp';
import {
    createPresentationGenTool,
    createPresentationReferenceTool,
    deduplicatePresentationQualityIssues,
    describeChartRejection,
    evaluatePresentationPlan,
    fitPresentationArgsToCapacity,
    inspectRenderedPresentation,
    parsePresentationPlan,
    presentationMechanicalRepairGuidance,
    PRESENTATION_CHART_TYPES,
    PRESENTATION_IMAGE_CAPABLE_SILHOUETTES,
    resolvePresentationImageFrame,
    selectRepresentativeSlides,
    summarizePresentationLayouts,
} from './index';
import {
    describeCjkLineRepair,
    describeTextOverflowRepair,
    withCjkLineRepairGuidance,
    withTextOverflowRepairGuidance,
} from './model';
import {
    loadPresentationDesign,
    resolvePresentationDesignArgs,
    findLatestSessionDesign,
    savePresentationDesign,
    validatePresentationRevisionPatches,
    validatePresentationSampleRetry,
} from './design-store';
import { balancedCjkBodyText, balancedTitleText, boundedTextLayout, eventLedgerTextParts, horizontalSequenceTextGeometry, metricLabelTextLayout, metricValueTextLayout, presentationSemanticTone, stackedSequenceGeometry } from './renderer';
import { createPresentationVisualDirections } from './directions';
import { createPresentationWorkflowState } from './workflow';

test('generate_presentation exposes a Moonshot MFJS-compatible root schema', () => {
    const schema = createPresentationGenTool().rawInputSchema;
    assert.equal(schema?.type, 'object');
    assert.equal(Object.hasOwn(schema || {}, 'anyOf'), false);
});

test('metric label sizing accounts for CJK text and the actual card width', () => {
    const regular = metricLabelTextLayout('参赛球队', 2.44, 23);
    const long = metricLabelTextLayout('揭幕战（当地时间）', 2.44, 23);
    assert.equal(regular.height, 0.62);
    assert.ok(long.fontSize < regular.fontSize);
    assert.ok(long.fontSize >= 11.5);
});

test('metric value sizing reserves lines for mixed CJK dates and score labels', () => {
    const short = metricValueTextLayout('18', 2.44, 41);
    const schedule = metricValueTextLayout('34轮 / 306场', 2.44, 41);
    const date = metricValueTextLayout('2027年5月22日', 2.44, 41);
    assert.equal(short.lines, 1);
    assert.equal(schedule.lines, 2);
    assert.equal(date.lines, 2);
    assert.ok(schedule.height > short.height);
    assert.ok(date.fontSize < 41);
    assert.ok(date.height <= 1.62);
});

test('bounded text sizing fits multiline CJK copy without dropping below body minimum', () => {
    const copy = [
        '当地时间：8月28日 20:30（周五）',
        '北京时间：8月29日 02:30',
        '拜仁：卫冕冠军，78分第34冠',
        '斯图加特：第7名，53分',
    ].join('\n');
    const narrow = boundedTextLayout(copy, 2.88, 1.68, 19, 16);
    const properRail = boundedTextLayout(copy, 3.7, 4.42, 19, 16);
    assert.equal(narrow.fits, false);
    assert.equal(properRail.fits, true);
    assert.ok(properRail.fontSize >= 16);
});

test('bounded closing headlines keep long English decisions inside a readable title region', () => {
    const title = 'Approve the four-week reliability backlog and assign one owner for shared-client resilience';
    const layout = boundedTextLayout(title, 10.6, 2.85, 49, 32);
    assert.equal(layout.fits, true);
    assert.ok(layout.fontSize >= 32);
    assert.ok(layout.height <= 2.85);
});

test('bounded bilingual labels fit comparison and supporting-metric regions', () => {
    const comparison = boundedTextLayout('Professional Services / 专业服务', 5.18, 0.92, 25, 18);
    const metric = boundedTextLayout('Design partners / 共创客户', 2.25, 0.87, 17, 10.5);
    assert.equal(comparison.fits, true);
    assert.equal(metric.fits, true);
    assert.ok(comparison.fontSize >= 18);
    assert.ok(metric.fontSize >= 10.5);
});

test('long CJK headlines break at a balanced editorial boundary', () => {
    const title = '五大节点贯穿全季：8月末揭幕，12月进入冬歇期，次年5月收官';
    const balanced = balancedTitleText(title);
    const [first, second] = balanced.split('\n');
    assert.ok(first?.endsWith('，'));
    assert.ok(second?.startsWith('12月'));
    assert.ok(Math.abs(Array.from(first || '').length - Array.from(second || '').length) <= 6);
    assert.ok(balancedTitleText('拜仁78分夺冠领先12分，追赶集团从勒沃库森到美因茨仅差14分').startsWith('拜仁78分夺冠领先12分，\n'));
    assert.equal(balancedTitleText('OpenFlux 2026 Roadmap').includes('202\n6'), false);
    assert.equal(balancedTitleText('德甲 2026-27 赛季前瞻'), '德甲 2026-27\n赛季前瞻');
});

test('mixed Latin and CJK headlines do not isolate a short acronym on its own line', () => {
    const balanced = balancedTitleText('SVG 转入演示文稿后保持清晰完整');
    const lines = balanced.split('\n');
    assert.equal(lines.length, 2);
    assert.notEqual(lines[0], 'SVG');
    assert.ok(lines.every(line => line.length >= 6));
});

test('balanced headlines never start the second line with CJK punctuation', () => {
    const balanced = balancedTitleText('标识类素材默认 contain，完整性高于铺满画面');
    const lines = balanced.split('\n');
    assert.equal(lines.length, 2);
    assert.doesNotMatch(lines[1] || '', /^[，。；：！？、）》】」』％%—–]/);
});

test('narrow CJK body copy wraps without leading punctuation or orphan endings', () => {
    const copy = '按渠道拆解注册转化率，砍掉低意向投放，把预算集中到高转化来源，用流量质量而非流量规模解决问题';
    const wrapped = balancedCjkBodyText(copy, 26);
    const lines = wrapped.split('\n');
    assert.ok(lines.length >= 3);
    assert.ok(lines.every(line => !/^[，。；：！？、）》】」』％%]/.test(line)));
    assert.equal(/^[\u3400-\u9FFF]{1,3}[，。；：！？、）》】」』％%]?$/.test(lines.at(-1) || ''), false);
    assert.equal(lines.join(''), copy);

    const closingQuote = '第64届德甲大幕将启——拜仁守擂、双雄挑战、新军登场，一切悬念从首轮开始。';
    const closingLines = balancedCjkBodyText(closingQuote, 30).split('\n');
    assert.equal(/^[\u3400-\u9FFF]{1,3}[，。；：！？、）》】」』％%]?$/.test(closingLines.at(-1) || ''), false);
    assert.equal(closingLines.join(''), closingQuote);
});

test('CJK tail rebalancing never moves a comma to the start of an explicit line', () => {
    const wrapped = balancedCjkBodyText(
        'MIT 协议开源——每一行代码可审计，无黑盒、无厂商锁定',
        25,
    );
    assert.ok(wrapped.includes('\n'));
    assert.ok(wrapped.split('\n').every(line => !/^[，。；：！？、）》】」』％%—–]/.test(line)));
});

test('CJK body wrapping keeps business number tokens intact', () => {
    const copy = '本季度付费转化率提升至4.05%，预期每季多产出2,000+注册，收入质量继续改善';
    const wrapped = balancedCjkBodyText(copy, 22);
    assert.ok(wrapped.includes('4.05%'));
    assert.ok(wrapped.includes('2,000+'));
    assert.equal(wrapped.replace(/\n/g, ''), copy);

    const schedule = balancedCjkBodyText('北京时间 8月29日 02:30 · 拜仁慕尼黑 vs 斯图加特 · 安联球场', 34);
    assert.equal(schedule.includes('02:\n30'), false);
    assert.match(schedule, /02:30/);

    const readingRail = balancedCjkBodyText('升降级附加赛不敌帕德博恩，沃尔夫斯堡自1997年升入德甲后首次降级', 22);
    assert.equal(readingRail.includes('博\n恩'), false);
    assert.ok(readingRail.split('\n').some(line => line.startsWith('帕德博恩，')));

    const fullReadingRail = balancedCjkBodyText(
        '升降级附加赛不敌帕德博恩，沃尔夫斯堡自1997年升入德甲后首次降级——队史首次、也是近三十年德甲最具冲击力的告别。',
        3.7 * 72 * 1.65 / 19,
    );
    assert.ok(fullReadingRail.split('\n').some(line => line.startsWith('首次降级——')));
    assert.ok(fullReadingRail.split('\n').some(line => line.startsWith('冲击力的告别。')));
});

test('explicit positive and negative presentation semantics map to stable color roles', () => {
    assert.equal(presentationSemanticTone('访问后未注册 8400 人，属于最大流失'), 'negative');
    assert.equal(presentationSemanticTone('预期收益：整体目标转化率提升至 12%+'), 'positive');
    assert.equal(presentationSemanticTone('访问 12000 → 注册 3600 → 付费 900'), 'neutral');
});

function baseArgs(): Record<string, unknown> {
    return {
        brief: {
            title: 'OpenFlux 1.0 Beta',
            subtitle: '让复杂工作持续向前',
            audience: '希望提升个人与团队执行效率的知识工作者',
            purpose: '介绍产品价值并促成试用',
            desired_outcome: '理解多会话与任务执行体验，并下载试用',
            language: 'zh-CN',
            delivery_mode: 'marketing',
            communication_job: '让知识工作者愿意试用 OpenFlux，因为多个任务可以保持独立上下文并持续推进。',
            narrative_arc: ['复杂工作容易混在一起', 'OpenFlux 用 Project 和会话拆开工作', '用户可以立即创建 Project 开始试用'],
        },
        art_direction: {
            mood: 'editorial, warm, confident',
            density: 'airy',
            palette: {
                background: 'F4F1EA',
                surface: 'FFFFFF',
                text: '17211B',
                muted: '667168',
                accent: '1F9D68',
                accent2: 'F0A34A',
            },
            typography: { heading: 'Microsoft YaHei', body: 'Microsoft YaHei' },
        },
        slides: [
            {
                purpose: '建立核心承诺',
                message: '一个 Project，承载所有正在推进的工作',
                composition: 'focal',
                body: '让每项工作拥有独立上下文，也让多个任务可以持续推进。',
            },
            {
                purpose: '解释使用变化',
                message: '多个会话并行推进，记录和文件不再混在一起',
                composition: 'narrative',
                body: '每个 Agent 和 Project 都能建立多个独立会话。',
                bullets: ['随时切换并继续原来的工作', '后台完成后显示未读提醒', '会话可重命名和整理'],
            },
            {
                purpose: '展示任务过程',
                message: '任务执行中仍可补充要求，也可把后续工作加入队列',
                composition: 'sequence',
                steps: [
                    { title: '提出目标' },
                    { title: '继续补充' },
                    { title: '队列执行' },
                    { title: '完成提醒' },
                ],
            },
            {
                purpose: '强调结果',
                message: '过程更清楚，等待更安心',
                composition: 'data',
                metrics: [
                    { value: '10', label: '最近动作', description: '执行中保持简洁' },
                    { value: '0', label: '虚假长任务', description: '重启后正确结束' },
                    { value: '1×', label: '稳定追加', description: '不再反复闪烁' },
                ],
            },
            {
                purpose: '给出行动',
                message: '现在就用 OpenFlux 开始下一项重要工作',
                composition: 'closing',
                body: '创建 Project，打开一个新会话，把目标交给 Agent。',
            },
        ],
        export_pdf: false,
        render_preview: false,
        filename: 'openflux-beta.pptx',
    };
}

test('an explicit requested slide count is a hard content contract', () => {
    const args = baseArgs();
    args.brief = { ...(args.brief as Record<string, unknown>), requested_slide_count: 6 };
    let issues = evaluatePresentationPlan(parsePresentationPlan(args));
    assert.ok(issues.some(issue => issue.code === 'requested_slide_count_mismatch' && issue.severity === 'error'));

    (args.slides as Array<Record<string, unknown>>).push({
        purpose: '明确下一步',
        message: '现在开始试用',
        composition: 'closing',
        body: '创建第一个 Project 并启动任务。',
    });
    issues = evaluatePresentationPlan(parsePresentationPlan(args));
    assert.equal(issues.some(issue => issue.code === 'requested_slide_count_mismatch'), false);
});

test('slide-count mismatch is rejected before a design id is created', async () => {
    const args = baseArgs();
    args.brief = { ...(args.brief as Record<string, unknown>), requested_slide_count: 6 };
    args.workflow = { stage: 'sample', mode: 'auto' };
    const result = await createPresentationGenTool({ getOutputPath: () => tmpdir() }).execute(args);
    assert.equal(result.success, false);
    assert.equal(result.code, 'presentation_requested_slide_count_mismatch');
    const data = result.data as Record<string, unknown>;
    assert.equal(data.requestedSlideCount, 6);
    assert.equal(data.actualSlideCount, 5);
    assert.equal(Object.hasOwn(data, 'designId'), false);
});

test('presentation plan keeps narrative and art direction separate from compositions', () => {
    const plan = parsePresentationPlan(baseArgs());
    assert.equal(plan.brief.desiredOutcome, '理解多会话与任务执行体验，并下载试用');
    assert.equal(plan.artDirection.mood, 'editorial, warm, confident');
    assert.deepEqual(plan.slides.map(slide => slide.composition), [
        'focal', 'narrative', 'sequence', 'data', 'closing',
    ]);
    assert.equal(plan.slides[1].message, '多个会话并行推进，记录和文件不再混在一起');
});

test('composition is inferred from semantic content when omitted', () => {
    const args = baseArgs();
    const slides = args.slides as Array<Record<string, unknown>>;
    delete slides[2].composition;
    delete slides[3].composition;
    const plan = parsePresentationPlan(args);
    assert.equal(plan.slides[2].composition, 'sequence');
    assert.equal(plan.slides[3].composition, 'data');
});

test('domain-neutral information roles are inferred and can be model-directed', () => {
    const args = baseArgs();
    const slides = args.slides as Array<Record<string, unknown>>;
    slides[1].information_role = 'events';
    slides[1].relationship_to_previous = 'Turns the opening claim into observable records.';
    const plan = parsePresentationPlan(args);
    assert.equal(plan.slides[0].informationRole, 'claim');
    assert.equal(plan.slides[1].informationRole, 'events');
    assert.equal(plan.slides[2].informationRole, 'timeline');
    assert.equal(plan.slides[3].informationRole, 'status');
    assert.equal(plan.slides[4].informationRole, 'action');
    assert.equal(plan.slides[1].relationshipToPrevious, 'Turns the opening claim into observable records.');
});

test('citation metadata does not misclassify event records as a source index', () => {
    const args = baseArgs();
    args.slides = [
        {
            purpose: 'Publish the operating schedule',
            message: 'Four dated records define the next window',
            items: Array.from({ length: 4 }, (_, index) => ({ title: `8/${29 + index} 09:30`, description: `Record ${index + 1}` })),
            sources: ['Primary calendar'],
        },
        {
            purpose: 'Index the evidence sources',
            message: 'Four sources support the analysis',
            items: Array.from({ length: 4 }, (_, index) => ({ title: `Source ${index + 1}`, description: 'Primary evidence' })),
            sources: ['Research log'],
        },
    ];
    const plan = parsePresentationPlan(args);
    assert.equal(plan.slides[0].informationRole, 'events');
    assert.equal(plan.slides[0].resolvedLayout.silhouette, 'event-ledger');
    assert.equal(plan.slides[1].informationRole, 'sources');
    assert.equal(plan.slides[1].resolvedLayout.silhouette, 'source-index');
});

test('model-authored design language and per-slide layout intent are preserved', () => {
    const args = baseArgs();
    Object.assign(args.art_direction as Record<string, unknown>, {
        visual_language: 'editorial',
        design_concept: 'A shifting editorial cutout turns each claim into the next chapter.',
        signature_element: 'cutout',
        spacing: 'generous',
        motif: 'orbit',
        background_treatment: 'tonal',
        image_treatment: 'framed',
        chart_style: 'editorial',
        design_principles: ['one focal point', 'intentional whitespace'],
        reference_summary: 'Editorial hierarchy with restrained color and asymmetric balance.',
        avoid: ['decorative clutter'],
        grid: { columns: 12, margin: 0.9, gutter: 0.28 },
        typography: {
            heading: 'Microsoft YaHei',
            body: 'Microsoft YaHei',
            title_scale: 1.08,
            body_scale: 0.96,
        },
    });
    (args.slides as Array<Record<string, unknown>>)[1].layout = {
        variant: 'editorial',
        emphasis: 'message',
        alignment: 'left',
        whitespace: 'generous',
        focal_scale: 1.12,
        rationale: 'A large claim creates a decisive transition after the cover.',
    };
    const plan = parsePresentationPlan(args);
    assert.equal(plan.artDirection.motif, 'orbit');
    assert.equal(plan.artDirection.visualLanguage, 'editorial');
    assert.equal(plan.artDirection.signatureElement, 'cutout');
    assert.match(plan.artDirection.designConcept || '', /editorial cutout/);
    assert.equal(plan.artDirection.typography.titleScale, 1.08);
    assert.equal(plan.artDirection.grid.margin, 0.9);
    assert.equal(plan.slides[1].layout.variant, 'editorial');
    assert.equal(plan.slides[1].layout.focalScale, 1.12);
});

test('sample directions produce three distinct composition grammars without user configuration', () => {
    const directions = createPresentationVisualDirections(parsePresentationPlan(baseArgs()));
    assert.deepEqual(directions.map(direction => direction.plan.artDirection.visualLanguage), [
        'precision', 'editorial', 'kinetic',
    ]);
    assert.deepEqual(directions.map(direction => direction.plan.artDirection.signatureElement), [
        'axis', 'cutout', 'pulse',
    ]);
    assert.ok(directions.every(direction => Boolean(direction.plan.artDirection.designConcept)));
});

test('deck-wide layout engine resolves semantic families into varied page silhouettes', () => {
    const args = baseArgs();
    args.slides = [
        (args.slides as unknown[])[0],
        {
            purpose: '章节转场：解释增长路径',
            message: '从产品能力走向业务结果',
            layout: { archetype: 'section' },
        },
        {
            purpose: '解释价值主张',
            message: '上下文连续，任务才能持续推进',
            composition: 'narrative',
            body: '每个 Project 都保持独立的任务空间。',
        },
        {
            purpose: '用现场照片建立真实感',
            message: '复杂任务在同一个工作空间里有序展开',
            composition: 'split',
            image_path: 'scene-a.png',
            image_kind: 'photo',
        },
        {
            purpose: '用第二张照片补充场景',
            message: '人在切换任务时仍然保留清晰的工作边界',
            composition: 'split',
            image_path: 'scene-b.png',
            image_kind: 'photo',
        },
        {
            purpose: '展示执行过程',
            message: '目标、补充、执行和交付形成连续闭环',
            composition: 'sequence',
            steps: [{ title: '目标' }, { title: '补充' }, { title: '执行' }, { title: '交付' }],
        },
        {
            purpose: '展示证据',
            message: '关键结果可以被直接读取',
            composition: 'data',
            metrics: [{ value: '4×', label: '推进效率' }, { value: '92%', label: '按时完成' }],
        },
        {
            purpose: '比较改变前后',
            message: '工作从分散等待变成并行推进',
            composition: 'comparison',
            comparison: {
                left: { heading: '过去', items: ['上下文混杂'] },
                right: { heading: '现在', items: ['任务独立推进'] },
            },
        },
        {
            purpose: '给出明确行动',
            message: '现在开始下一项重要工作',
            composition: 'closing',
            body: '创建 Project，交给 Agent 一个清楚的目标。',
        },
    ];
    const plan = parsePresentationPlan(args);
    const summary = summarizePresentationLayouts(plan);
    assert.ok(plan.slides.every(slide => slide.resolvedLayout.fingerprint !== 'pending'));
    assert.equal(plan.slides[1].resolvedLayout.silhouette, 'section-divider');
    assert.notEqual(plan.slides[3].resolvedLayout.silhouette, plan.slides[4].resolvedLayout.silhouette);
    assert.ok(summary.distinctFamilies >= 7);
    assert.ok(summary.distinctSilhouettes >= 7);
    assert.equal(summary.adjacentDuplicates, 0);
});

test('deck-wide layout planning assigns automatic surface rhythm without user configuration', () => {
    const plan = parsePresentationPlan(baseArgs());
    assert.deepEqual(plan.slides.map(slide => slide.resolvedLayout.surfaceRole), [
        'base', 'surface', 'base', 'surface', 'base',
    ]);
    const summary = summarizePresentationLayouts(plan);
    assert.equal(summary.distinctSurfaceRoles, 2);
    assert.ok(summary.longestSurfaceRun <= 2);
});

test('long CJK editorial copy and stacked revisions resolve to a wide reading field', () => {
    const args = baseArgs();
    const slides = args.slides as Array<Record<string, unknown>>;
    slides[1] = {
        purpose: '解释季度经营结论',
        message: '量质齐升，但增长杠杆已经转向激活与转化',
        title: '季度总结论',
        body: '本季度访问量连续六个月爬升至二十万，付费转化率提升至4.05%，收入净增一百四十五万。最大的流失不在获客端，而在访问到注册的第一步与意向到付费的最后一步。',
        layout: { archetype: 'editorial', variant: 'stacked' },
    };
    const plan = parsePresentationPlan(args);
    assert.equal(plan.slides[1].resolvedLayout.silhouette, 'editorial-columns');
});

test('four long process records use a full-width stacked ledger at the 16pt body floor', () => {
    const args = baseArgs();
    const description = '企业级 AI Studio 与 Agent 运行时：可视化编排、工作流、RAG 知识库、Python 扩展';
    args.slides = [{
        purpose: '把产品信念落到四层架构',
        message: '四层产品栈：从引擎到入口，一套完整的企业 AI 技术栈',
        information_role: 'collection',
        steps: [
            { title: 'NexusAI · 引擎层', description },
            { title: 'NexusAI Atlas · 治理层', description: '与引擎深度耦合的信任平面：全程可见、成本可归因、合规可证明' },
            { title: 'OpenFlux · 桌面入口', description: '跨平台 AI Agent 桌面应用：本地数据、长期记忆、自动执行' },
            { title: 'OpenFlux Router · IM 入口', description: 'Slack / Teams / WhatsApp 群聊里的 AI，@一下即得答案' },
        ],
        layout: { archetype: 'process', variant: 'auto', whitespace: 'compact' },
    }];
    const plan = parsePresentationPlan(fitPresentationArgsToCapacity(args).args);
    assert.equal(plan.slides[0].resolvedLayout.silhouette, 'process-stacked');

    const geometry = stackedSequenceGeometry(4, 'compact', false, true);
    const descriptionHeight = geometry.rowHeight - 0.12;
    const descriptionWidth = 9.38 - 2.55 - 0.34;
    const layout = boundedTextLayout(description, descriptionWidth, descriptionHeight, 16, 16);
    assert.equal(layout.fits, true);
    assert.equal(layout.fontSize, 16);
    assert.ok(descriptionHeight >= 0.9);
});

test('three-stage timelines use the available canvas and keep descriptions at 16pt', () => {
    const description = 'NexusAI + Atlas 私有化部署，可管控、可审计、可归因的 AI 基础设施';
    const geometry = horizontalSequenceTextGeometry(3, (12.1 - 1.02) / 2, false);
    assert.equal(geometry.labelWidth, 3.6);
    assert.equal(geometry.descriptionHeight, 1.42);
    const layout = boundedTextLayout(
        description,
        geometry.labelWidth,
        geometry.descriptionHeight,
        16,
        16,
    );
    assert.equal(layout.fits, true);
    assert.equal(layout.fontSize, 16);
});

test('three long stages switch to the stacked ledger instead of shallow stacked labels', () => {
    const args = baseArgs();
    args.slides = [{
        purpose: '展示不设断点的演进路径',
        message: '从个人到企业，一条不设断点的演进路径',
        information_role: 'timeline',
        steps: [
            { title: '准备', description: '完成依赖检查、环境初始化和基础参数核对，确保执行条件一致' },
            { title: '实施', description: '按模块推进任务并同步关键状态，让参与者及时掌握当前进度' },
            { title: '验收', description: '汇总执行结果、异常记录和验证证据，确认全部目标已经完成' },
        ],
        layout: { archetype: 'process', whitespace: 'generous' },
    }];
    const plan = parsePresentationPlan(args);
    assert.equal(plan.slides[0].resolvedLayout.silhouette, 'process-stacked');
    const geometry = stackedSequenceGeometry(3, 'generous', false, true);
    const contentHeight = geometry.rowHeight - 0.12;
    const descriptionWidth = 9.38 - 2.55 - 0.34;
    const descriptionLayout = boundedTextLayout(
        String((args.slides as Array<Record<string, any>>)[0].steps[2].description),
        descriptionWidth,
        contentHeight,
        16,
        16,
    );
    assert.equal(descriptionLayout.fits, true);
});

test('one semantic presentation grammar works across six unrelated business domains', () => {
    const cases: Array<{ name: string; expectedSilhouette: string; slides: Array<Record<string, unknown>> }> = [
        {
            name: 'sports schedule and results',
            expectedSilhouette: 'event-ledger',
            slides: [
                {
                    purpose: 'Show the next set of fixtures', message: 'The next eight fixtures define the competitive window',
                    information_role: 'events', items: Array.from({ length: 8 }, (_, index) => ({ title: `Fixture ${index + 1}`, description: `Round ${index + 2} · confirmed` })),
                    body: 'Read the schedule as a sequence of decision points.', bullets: ['Three away fixtures increase travel load', 'The final two rounds carry the largest ranking impact'],
                },
                {
                    purpose: 'Show recent form', message: 'Conversion improved while defensive variance remained',
                    information_role: 'evidence', chart: { type: 'line', labels: ['R1', 'R2', 'R3', 'R4'], values: [1, 2, 2, 4] },
                    bullets: ['The trend is directional, not a forecast', 'Use the next two rounds to validate it'],
                },
            ],
        },
        {
            name: 'enterprise monthly operations',
            expectedSilhouette: 'status-dashboard',
            slides: [
                {
                    purpose: 'Summarize operating health', message: 'Delivery improved without increasing service risk',
                    information_role: 'status', metrics: [{ value: '94%', label: 'On time' }, { value: '-18%', label: 'Backlog' }, { value: '2.1h', label: 'Response' }],
                    bullets: ['Quality held above the agreed floor', 'Backlog reduction came from two workflow changes'],
                },
                {
                    purpose: 'Compare operating models', message: 'The new cadence exposes delays earlier',
                    information_role: 'comparison', comparison: { left: { heading: 'Previous', items: ['Weekly handoff', 'Late escalation'] }, right: { heading: 'Current', items: ['Daily signal', 'Owner at source'] } },
                    body: 'The change is about feedback speed, not more meetings.',
                },
            ],
        },
        {
            name: 'software project progress',
            expectedSilhouette: 'milestone-timeline',
            slides: [
                {
                    purpose: 'Explain the delivery path', message: 'Four gates turn implementation into a releasable increment',
                    information_role: 'timeline', steps: [{ title: 'Scope', description: 'Freeze acceptance' }, { title: 'Build', description: 'Implement thin slice' }, { title: 'Verify', description: 'Run regressions' }, { title: 'Release', description: 'Observe production' }],
                    bullets: ['Each gate has one accountable owner', 'Rollback evidence is prepared before release'],
                },
                {
                    purpose: 'Show project health', message: 'Risk is concentrated in one dependency',
                    information_role: 'status', metrics: [{ value: '72%', label: 'Complete' }, { value: '1', label: 'Blocked dependency' }, { value: '8', label: 'Passing suites' }],
                    body: 'The schedule remains credible if the dependency clears this week.',
                },
            ],
        },
        {
            name: 'product comparison',
            expectedSilhouette: 'ranking-bars',
            slides: [
                {
                    purpose: 'Make the buying trade-off explicit', message: 'The decision turns on control versus setup time',
                    information_role: 'comparison', comparison: { left: { heading: 'Option A', items: ['Fast setup', 'Fixed workflow', 'Lower entry cost'] }, right: { heading: 'Option B', items: ['Flexible control', 'Longer setup', 'Lower change cost'] } },
                    bullets: ['Both options satisfy the baseline requirement', 'Choose based on the expected rate of change'],
                },
                {
                    purpose: 'Score the decision criteria', message: 'No single option wins every criterion',
                    information_role: 'ranking', chart: { type: 'bar', labels: ['Setup', 'Control', 'Scale', 'Cost'], values: [9, 6, 8, 7] },
                    body: 'Weights should be agreed before comparing vendors.',
                },
            ],
        },
        {
            name: 'industry research and sources',
            expectedSilhouette: 'source-index',
            slides: [
                {
                    purpose: 'Index the evidence base', message: 'Eight sources establish the market range',
                    information_role: 'sources', items: Array.from({ length: 8 }, (_, index) => ({ title: `Source ${index + 1}`, description: `Primary evidence · 202${index % 5 + 2}` })),
                    body: 'Primary sources are separated from analyst interpretation.',
                },
                {
                    purpose: 'Show the evidence trend', message: 'Adoption is broadening but remains uneven',
                    information_role: 'evidence', chart: { type: 'column', labels: ['Segment A', 'Segment B', 'Segment C'], values: [42, 67, 55] },
                    bullets: ['The median masks a wide operating range', 'Segment B provides the strongest comparable cohort'],
                },
            ],
        },
        {
            name: 'event schedule and execution',
            expectedSilhouette: 'event-ledger',
            slides: [
                {
                    purpose: 'Publish the operating schedule', message: 'Eight sessions share one clear run of show',
                    information_role: 'events', items: Array.from({ length: 8 }, (_, index) => ({ title: `Session ${index + 1}`, description: `${9 + index}:00 · owner confirmed` })),
                    bullets: ['Two rooms run in parallel', 'Transitions include a ten-minute buffer'],
                },
                {
                    purpose: 'Explain execution readiness', message: 'Five checkpoints keep the event recoverable',
                    information_role: 'timeline', steps: [{ title: 'Brief' }, { title: 'Load in' }, { title: 'Rehearse' }, { title: 'Go live' }, { title: 'Close' }],
                    body: 'Every checkpoint has an explicit fallback and owner.',
                },
            ],
        },
    ];

    for (const regression of cases) {
        const source = {
            brief: {
                title: regression.name,
                audience: 'Enterprise decision makers',
                purpose: 'Turn current evidence into an actionable decision',
                desired_outcome: 'Understand the situation and approve the next action',
                delivery_mode: 'report',
            },
            art_direction: {
                mood: 'clear, executive, restrained', density: 'balanced',
                palette: { background: '0B0F14', surface: '171D26', text: 'F5F7FA', muted: 'A8B1C0', accent: 'EF3340', accent2: 'F2B134' },
            },
            slides: [
                { purpose: 'Open with the governing claim', message: regression.name, information_role: 'claim', composition: 'focal' },
                ...regression.slides,
                { purpose: 'Turn evidence into action', message: 'Approve the next controlled step', information_role: 'action', composition: 'closing', body: 'Assign an owner, a date, and one observable success measure.' },
            ],
        };
        const capacity = fitPresentationArgsToCapacity(source);
        assert.equal(capacity.expanded, false, `${regression.name} unexpectedly paginated`);
        const plan = parsePresentationPlan(capacity.args);
        const issues = evaluatePresentationPlan(plan);
        assert.deepEqual(issues.filter(issue => issue.severity === 'error'), [], regression.name);
        assert.ok(plan.slides.slice(1, -1).every(slide => slide.body || slide.bullets.length || slide.items.length || slide.metrics.length || slide.steps.length || slide.comparison || slide.chart), regression.name);
        assert.ok(plan.slides.some(slide => slide.resolvedLayout.silhouette === regression.expectedSilhouette), regression.name);
        assert.equal(summarizePresentationLayouts(plan).distinctSurfaceRoles, 2, regression.name);
    }
});

test('visual-direction preferences cannot hide structured slide content', () => {
    const args = baseArgs();
    args.slides = [{
        purpose: 'Show the decision metrics',
        message: 'The pilot is judged on three outcomes',
        composition: 'data',
        metrics: [
            { value: '92%', label: 'Completion' },
            { value: '-31%', label: 'Rework' },
            { value: '-24%', label: 'Intervention' },
        ],
        layout: { archetype: 'editorial', variant: 'asymmetric' },
    }];
    const plan = parsePresentationPlan(args);
    assert.equal(plan.slides[0].resolvedLayout.family, 'evidence');
    assert.ok(['metric-spotlight', 'metric-scoreboard', 'status-dashboard'].includes(plan.slides[0].resolvedLayout.silhouette));
    assert.ok(!evaluatePresentationPlan(plan).some(issue => issue.code === 'structured_content_layout_mismatch'));
});

test('a final closing quote keeps its quote renderer and full-bleed image', () => {
    const args = baseArgs();
    (args.brief as Record<string, unknown>).delivery_mode = 'marketing';
    args.slides = [{
        purpose: 'Close with the opening-night invitation',
        message: 'The new season starts now',
        composition: 'quote',
        quote: 'When the stadium lights return, the next chapter begins.',
        image_path: 'C:\\assets\\stadium-night.png',
        image_kind: 'photo',
        image_fit: 'cover',
        layout: { archetype: 'closing', emphasis: 'visual', whitespace: 'generous' },
    }];
    const plan = parsePresentationPlan(args);
    assert.equal(plan.slides[0].resolvedLayout.family, 'quote');
    assert.equal(plan.slides[0].resolvedLayout.silhouette, 'quote-full-bleed');
    const issues = evaluatePresentationPlan(plan);
    assert.ok(!issues.some(issue => issue.code === 'structured_content_layout_mismatch'));
    assert.ok(!issues.some(issue => issue.code === 'marketing_closing_layout_required'));
});

test('a flattened one-sided comparison preserves every fact as a collection', () => {
    const args = baseArgs();
    args.slides = [{
        purpose: 'Introduce the promoted teams',
        message: 'Three new teams enter the league',
        composition: 'comparison',
        information_role: 'comparison',
        comparison: {
            heading: 'Promoted teams',
            items: ['Schalke 04 returns', 'Elversberg debuts', 'Paderborn wins the playoff'],
        },
        layout: { archetype: 'comparison' },
    }];
    const plan = parsePresentationPlan(args);
    assert.equal(plan.slides[0].comparison, undefined);
    assert.deepEqual(plan.slides[0].items.map(item => item.title), [
        'Schalke 04 returns', 'Elversberg debuts', 'Paderborn wins the playoff',
    ]);
    assert.equal(plan.slides[0].resolvedLayout.family, 'collection');
    assert.ok(!evaluatePresentationPlan(plan).some(issue => issue.severity === 'error'));
});

test('semantic image fields choose aspect-ratio-safe defaults', () => {
    const args = baseArgs();
    args.slides = [{
        purpose: 'Explain the power trading mechanism',
        message: 'The mechanism connects generation, trading, and demand',
        composition: 'split',
        image_path: 'diagram.png',
        image_alt: 'Power trading architecture diagram',
        image_focus: { x: 0.75, y: 0.25 },
    }];
    const slide = parsePresentationPlan(args).slides[0];
    assert.equal(slide.imageKind, 'diagram');
    assert.equal(slide.imageFit, 'contain');
    assert.equal(slide.resolvedLayout.silhouette, 'semantic-stage');
    assert.deepEqual(slide.imageFocus, { x: 0.75, y: 0.25 });

    (args.slides as Array<Record<string, unknown>>)[0].image_kind = 'photo';
    (args.slides as Array<Record<string, unknown>>)[0].image_fit = 'cover';
    const photo = parsePresentationPlan(args).slides[0];
    assert.equal(photo.imageKind, 'photo');
    assert.equal(photo.imageFit, 'cover');
});

test('capacity planning preserves an explicit image layout with supporting narrative', () => {
    const args = baseArgs();
    args.slides = [{
        purpose: 'Use the supplied portrait as primary visual evidence',
        message: 'The supplied subject is framed without stretching',
        body: 'The supporting explanation shares the page with the visual.',
        composition: 'split',
        image_path: 'portrait.png',
        image_kind: 'photo',
        image_fit: 'cover',
        layout: { archetype: 'image', emphasis: 'visual', variant: 'asymmetric' },
    }];
    const fitted = fitPresentationArgsToCapacity(args);
    assert.equal(fitted.expanded, false);
    const plan = parsePresentationPlan(fitted.args);
    assert.equal(plan.slides[0].resolvedLayout.family, 'image');
    assert.ok(['image-split', 'image-window', 'image-panorama'].includes(plan.slides[0].resolvedLayout.silhouette));
    assert.ok(resolvePresentationImageFrame(plan.slides[0], 0));
});

test('every composition named in the image_frame_unresolved error really reserves a frame', () => {
    // The error tells a caller to move its picture to one of these. Advertising a
    // composition that reserves nothing would send it in a circle, and the last
    // caller to hit this error concluded local images were unsupported instead.
    const framed = (silhouette: string) => resolvePresentationImageFrame({
        imagePath: 'photo.png',
        imageKind: 'photo',
        layout: {},
        resolvedLayout: { silhouette },
    } as unknown as Parameters<typeof resolvePresentationImageFrame>[0], 0);
    for (const silhouette of PRESENTATION_IMAGE_CAPABLE_SILHOUETTES) {
        assert.ok(framed(silhouette), `${silhouette} is advertised as image-capable but reserves no frame`);
    }
    // The deck that failed put eight logos on a collection page and its scene
    // image on an editorial page; neither reserves room for a picture.
    assert.equal(framed('collection-columns'), undefined);
    assert.equal(framed('editorial-columns'), undefined);
});

test('semantic images reject masks that can hide labels or boundaries', () => {
    const args = baseArgs();
    args.slides = [{
        purpose: 'Explain a system architecture',
        message: 'Every labeled boundary must remain visible',
        composition: 'split',
        image_path: 'architecture.png',
        image_kind: 'diagram',
        image_fit: 'contain',
        image_mask: 'circle',
    }];
    const issues = evaluatePresentationPlan(parsePresentationPlan(args));
    assert.ok(issues.some(issue => issue.code === 'semantic_image_mask_unsafe' && issue.severity === 'error'));
});

test('searched image URLs preserve provenance and reject unsafe transports', async () => {
    const parsedArgs = baseArgs();
    parsedArgs.slides = [{
        purpose: 'Use a rights-cleared searched photograph',
        message: 'The source remains traceable in the deck notes',
        image_url: 'https://images.example.test/original.jpg',
        image_source_url: 'https://example.test/media-library/photo',
        image_credit: 'Example Media Library',
    }];
    const parsed = parsePresentationPlan(parsedArgs).slides[0];
    assert.equal(parsed.imagePath, 'https://images.example.test/original.jpg');
    assert.equal(parsed.imageSource, 'https://example.test/media-library/photo');
    assert.ok(parsed.sources.includes('https://example.test/media-library/photo'));

    const root = await fs.mkdtemp(join(tmpdir(), 'openflux-presentation-image-url-'));
    try {
        const unsafeArgs = baseArgs();
        unsafeArgs.slides = [{
            purpose: 'Reject an unsafe remote image transport',
            message: 'Remote presentation assets require HTTPS',
            image_url: 'http://127.0.0.1/private.png',
        }];
        const result = await createPresentationGenTool({ getOutputPath: () => root }).execute(unsafeArgs);
        assert.equal(result.success, false);
        assert.match(result.error || '', /HTTPS|local or private host|Only local image_path/i);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('representative sample selection covers cover, content, and evidence', () => {
    const plan = parsePresentationPlan(baseArgs());
    assert.deepEqual(selectRepresentativeSlides(plan), [1, 3, 4]);
});

test('representative sample selection does not spend two slots on continuation siblings', () => {
    const args = baseArgs();
    args.workflow = { stage: 'sample', sample_slide_numbers: [1, 3, 4] };
    args.slides = [
        (args.slides as unknown[])[0],
        { purpose: '建立背景', message: '先解释背景', composition: 'narrative', body: '背景说明' },
        { purpose: '列出事件', message: '完整事件', title: '事件清单（1/2）', composition: 'grid', items: [{ title: 'A' }, { title: 'B' }] },
        { purpose: '列出事件', message: '完整事件', title: '事件清单（2/2）', composition: 'grid', items: [{ title: 'C' }, { title: 'D' }] },
        { purpose: '给出证据', message: '关键指标', composition: 'data', metrics: [{ value: '94%', label: '完成率' }] },
        { purpose: '给出行动', message: '立即开始', composition: 'closing' },
    ];
    const selected = selectRepresentativeSlides(parsePresentationPlan(args));
    assert.deepEqual(selected, [1, 3, 5]);
});

test('quality checks warn about real density and monotony without file-size targets', () => {
    const args = baseArgs();
    args.slides = Array.from({ length: 6 }, (_, index) => ({
        purpose: `推进论证 ${index + 1}`,
        message: index === 0
            ? '这是一个明显过长的标题，它把多个并列观点全部塞进同一页并且会破坏演示时的清晰层级'
            : `核心观点 ${index + 1}`,
        composition: 'narrative',
        layout: { archetype: 'section' },
        bullets: ['一', '二', '三', '四', '五', '六', '七'],
    }));
    const issues = evaluatePresentationPlan(parsePresentationPlan(args));
    assert.ok(issues.some(issue => issue.code === 'title_too_dense'));
    assert.ok(issues.some(issue => issue.code === 'content_too_dense'));
    assert.ok(issues.some(issue => issue.code === 'composition_monotony'));
    assert.ok(issues.every(issue => !/file.?size|byte|\bkb\b/i.test(`${issue.code} ${issue.message}`)));
});

test('capacity planner splits mixed and over-capacity content before parsing', () => {
    const args = baseArgs();
    args.slides = [{
        purpose: '完整呈现赛程与关键数据',
        message: '赛程、阵容和关键指标需要完整保留',
        body: '这段说明不能被指标版式静默丢弃。',
        bullets: Array.from({ length: 8 }, (_, index) => `赛程 ${index + 1}`),
        items: Array.from({ length: 5 }, (_, index) => ({ title: `球队 ${index + 1}` })),
        metrics: Array.from({ length: 4 }, (_, index) => ({ value: `${index + 1}`, label: `指标 ${index + 1}` })),
        layout: { archetype: 'section' },
    }];

    const rawPlan = parsePresentationPlan(args);
    assert.equal(rawPlan.slides[0].items.length, 5, 'parsing must not truncate source items');
    const rawIssues = evaluatePresentationPlan(rawPlan);
    assert.ok(rawIssues.some(issue => issue.code === 'layout_capacity_exceeded'));
    assert.ok(rawIssues.some(issue => issue.code === 'mixed_content_channels'));

    const fitted = fitPresentationArgsToCapacity(args);
    assert.equal(fitted.expanded, true);
    assert.equal(fitted.originalSlideCount, 1);
    assert.equal(fitted.slideCount, 4);
    assert.equal(fitted.insertedSlides, 3);
    const fittedPlan = parsePresentationPlan(fitted.args);
    assert.equal(fittedPlan.slides.reduce((sum, slide) => sum + slide.items.length, 0), 5);
    assert.equal(fittedPlan.slides.reduce((sum, slide) => sum + slide.bullets.length, 0), 8);
    assert.equal(fittedPlan.slides.reduce((sum, slide) => sum + slide.metrics.length, 0), 4);
    assert.ok(!evaluatePresentationPlan(fittedPlan).some(issue => (
        issue.code === 'layout_capacity_exceeded' || issue.code === 'mixed_content_channels'
    )));
});

test('event semantics convert peer steps into one safe ledger without dropping records', () => {
    const args = baseArgs();
    args.slides = [{
        purpose: '完整发布同一轮的全部事件',
        message: '九条同级事件应作为清单，而不是流程依赖',
        information_role: 'events',
        composition: 'sequence',
        steps: Array.from({ length: 9 }, (_, index) => ({
            title: `08月${23 + index}日 21:30 · 事件主体 ${index + 1} 对阵另一主体`,
            description: `第 ${index + 1} 条已确认记录`,
        })),
        layout: { archetype: 'process', variant: 'stacked' },
    }];

    const fitted = fitPresentationArgsToCapacity(args);
    assert.equal(fitted.slideCount, 1);
    const plan = parsePresentationPlan(fitted.args);
    assert.equal(plan.slides[0].steps.length, 0);
    assert.equal(plan.slides[0].items.length, 9);
    assert.equal(plan.slides[0].resolvedLayout.family, 'collection');
    assert.equal(plan.slides[0].resolvedLayout.silhouette, 'event-ledger');
    assert.deepEqual(evaluatePresentationPlan(plan).filter(issue => issue.severity === 'error'), []);
});

test('three short event records keep a concise status note on the same ledger page', () => {
    const args = baseArgs();
    args.slides = [{
        purpose: '发布周日档的完整赛程与当前状态',
        message: '周日档三场比赛均尚未开赛',
        information_role: 'events',
        composition: 'grid',
        body: '截至8月26日，三场比赛均未开球，比分待定。',
        items: [
            { title: '00:30 多特蒙德 vs 汉堡', description: '周日凌晨焦点战' },
            { title: '21:30 弗赖堡 vs 云达不莱梅', description: '老牌球队对话' },
            { title: '23:30 奥格斯堡 vs 沙尔克04', description: '升班马回归首战' },
        ],
        layout: { archetype: 'collection', variant: 'cards' },
    }];

    const fitted = fitPresentationArgsToCapacity(args);
    assert.equal(fitted.expanded, false);
    assert.equal(fitted.slideCount, 1);
    assert.deepEqual(fitted.slideOrigins, [1]);
    const plan = parsePresentationPlan(fitted.args);
    assert.equal(plan.slides[0].body, '截至8月26日，三场比赛均未开球，比分待定。');
    assert.equal(plan.slides[0].items.length, 3);
    assert.ok([
        'event-ledger', 'collection-list', 'collection-list-banded',
    ].includes(plan.slides[0].resolvedLayout.silhouette));
    assert.ok(!evaluatePresentationPlan(plan).some(issue => (
        issue.code === 'orphaned_continuation_page' || issue.code === 'mixed_content_channels'
    )));
});

test('six-versus-three comparison stays on one readable page without an orphan continuation', () => {
    const args = baseArgs();
    args.slides = [{
        purpose: 'Compare the complete leading and trailing groups',
        message: 'The top six and bottom three define the final table',
        information_role: 'comparison',
        composition: 'comparison',
        comparison: {
            left: {
                heading: 'Top six',
                items: Array.from({ length: 6 }, (_, index) => `${index + 1} Leading team ${index + 1}`),
            },
            right: {
                heading: 'Bottom three',
                items: Array.from({ length: 3 }, (_, index) => `${index + 16} Relegated team ${index + 1}`),
            },
        },
        layout: { archetype: 'comparison', variant: 'auto' },
    }];

    const fitted = fitPresentationArgsToCapacity(args);
    assert.equal(fitted.expanded, false);
    assert.equal(fitted.slideCount, 1);
    const plan = parsePresentationPlan(fitted.args);
    assert.equal(plan.slides[0].comparison?.left.items.length, 6);
    assert.equal(plan.slides[0].comparison?.right.items.length, 3);
    assert.deepEqual(evaluatePresentationPlan(plan).filter(issue => issue.severity === 'error'), []);
});

test('event and process overflow paginate into balanced continuation pages', () => {
    const eventArgs = baseArgs();
    eventArgs.slides = [{
        purpose: '发布完整事件记录',
        message: '十一条事件全部保留',
        information_role: 'events',
        steps: Array.from({ length: 11 }, (_, index) => ({ title: `8/${index + 1} 09:30`, description: `Event ${index + 1}` })),
    }];
    const fittedEvents = fitPresentationArgsToCapacity(eventArgs);
    const eventPlan = parsePresentationPlan(fittedEvents.args);
    assert.deepEqual(eventPlan.slides.map(slide => slide.items.length), [6, 5]);
    assert.deepEqual(fittedEvents.slideOrigins, [1, 1]);
    assert.equal(eventPlan.slides.reduce((sum, slide) => sum + slide.items.length, 0), 11);

    const processArgs = baseArgs();
    processArgs.slides = [{
        purpose: '解释完整流程',
        message: '七个依赖步骤形成一条流程',
        information_role: 'timeline',
        steps: Array.from({ length: 7 }, (_, index) => ({ title: `Step ${index + 1}` })),
    }];
    const fittedProcess = fitPresentationArgsToCapacity(processArgs);
    assert.deepEqual(parsePresentationPlan(fittedProcess.args).slides.map(slide => slide.steps.length), [4, 3]);
});

test('a metric-bearing cover remains a cover and preserves its headline indicators', () => {
    const args = baseArgs();
    args.slides = [{
        purpose: '建立开场承诺',
        message: '年度经营概览',
        composition: 'focal',
        metrics: [
            { value: '18', label: '关键事件' },
            { value: '34', label: '总记录' },
            { value: '89', label: '领先分值' },
        ],
        layout: { archetype: 'cover', variant: 'centered' },
    }];
    const fitted = fitPresentationArgsToCapacity(args);
    assert.equal(fitted.expanded, false);
    const plan = parsePresentationPlan(fitted.args);
    assert.equal(plan.slides[0].resolvedLayout.family, 'cover');
    assert.equal(plan.slides[0].metrics.length, 3);
    assert.deepEqual(evaluatePresentationPlan(plan).filter(issue => issue.severity === 'error'), []);
});

test('four readable report bullets stay on one full-width action page', () => {
    const args = baseArgs();
    args.brief = { ...(args.brief as Record<string, unknown>), delivery_mode: 'report' };
    args.slides = [{
        purpose: '明确批准后的启动动作与治理机制',
        message: '批准即启动，本周完成范围冻结并建立治理节奏',
        layout: { archetype: 'editorial', variant: 'asymmetric' },
        bullets: [
            '本周签署范围冻结令，专项组六个团队全部到位',
            '双周向管委会简报，门禁状态使用红黄绿看板',
            '十六个业务团队联络人参加周会，问题四十八小时闭环',
            '一级事故十五分钟直达指挥部，回退双签授权立即生效',
        ],
    }];
    const fitted = fitPresentationArgsToCapacity(args);
    assert.equal(fitted.slideCount, 1);
    assert.equal(fitted.expanded, false);
});

test('short narrative stays with one structured channel instead of creating an orphan continuation', () => {
    const cases = [
        {
            purpose: 'Summarize the current operating state',
            message: 'Four indicators explain the current state',
            body: 'The period is stable, with one risk that needs attention.',
            bullets: ['Growth remains positive', 'Delivery risk is concentrated in one stage'],
            metrics: Array.from({ length: 4 }, (_, index) => ({ value: `${index + 1}`, label: `Metric ${index + 1}` })),
        },
        {
            purpose: 'Compare the incoming and outgoing groups',
            message: 'The portfolio changed in both directions',
            bullets: ['Three entities entered', 'Three entities exited'],
            comparison: {
                left: { heading: 'Incoming', items: ['A', 'B', 'C'] },
                right: { heading: 'Outgoing', items: ['D', 'E', 'F'] },
            },
        },
        {
            purpose: 'Explain the delivery sequence',
            message: 'Five milestones form one delivery path',
            body: 'Each milestone has a distinct decision point.',
            bullets: ['The third milestone is the critical gate'],
            steps: Array.from({ length: 5 }, (_, index) => ({ title: `Milestone ${index + 1}` })),
        },
    ];

    for (const slide of cases) {
        const args = baseArgs();
        args.slides = [slide];
        const fitted = fitPresentationArgsToCapacity(args);
        assert.equal(fitted.slideCount, 1, slide.message);
        assert.equal(fitted.expanded, false, slide.message);
        assert.ok(!evaluatePresentationPlan(parsePresentationPlan(fitted.args)).some(issue => (
            issue.code === 'mixed_content_channels' || issue.code === 'layout_capacity_exceeded'
        )), slide.message);
    }
});

test('legacy continuation pairs are recombined and reflowed through current capacity rules', () => {
    const args = baseArgs();
    args.slides = [
        {
            purpose: 'Summarize the operating period',
            message: 'The period is stable',
            title: 'Operating overview (1/2)',
            composition: 'narrative',
            bullets: ['Demand remained stable', 'Risk is concentrated'],
        },
        {
            purpose: 'Summarize the operating period',
            message: 'The period is stable',
            title: 'Operating overview (2/2)',
            composition: 'data',
            metrics: [{ value: '94%', label: 'Ready' }, { value: '3', label: 'Risks' }, { value: '8d', label: 'Runway' }],
            layout: { archetype: 'evidence' },
        },
    ];
    const result = fitPresentationArgsToCapacity(args);
    assert.equal(result.originalSlideCount, 2);
    assert.equal(result.slideCount, 1);
    assert.equal(result.expanded, false);
    assert.equal(result.insertedSlides, 0);
    assert.equal(result.mergedSlides, 1);
    assert.deepEqual(result.merges[0].sourceSlides, [1, 2]);
    assert.deepEqual(result.slideOrigins, [1]);
    const slide = (result.args.slides as Array<Record<string, unknown>>)[0];
    assert.equal(slide.title, 'Operating overview');
    assert.deepEqual(slide.bullets, ['Demand remained stable', 'Risk is concentrated']);
    assert.equal((slide.metrics as unknown[]).length, 3);
    assert.deepEqual(evaluatePresentationPlan(parsePresentationPlan(result.args)).filter(issue => issue.severity === 'error'), []);
});

test('legacy comparison continuations preserve every record when reflowed to current capacity', () => {
    const args = baseArgs();
    args.slides = [
        {
            purpose: 'Compare the final groups',
            message: 'Final table (1/2)',
            composition: 'comparison',
            comparison: {
                left: { heading: 'Top six', items: ['1 A', '2 B', '3 C', '4 D', '5 E'] },
                right: { heading: 'Bottom three', items: ['16 X', '17 Y', '18 Z'] },
            },
        },
        {
            purpose: 'Compare the final groups',
            message: 'Final table (2/2)',
            composition: 'comparison',
            comparison: {
                left: { heading: 'Top six', items: ['6 F'] },
                right: { heading: 'Bottom three', items: [] },
            },
        },
    ];

    const result = fitPresentationArgsToCapacity(args);
    assert.equal(result.slideCount, 1);
    assert.equal(result.mergedSlides, 1);
    const comparison = parsePresentationPlan(result.args).slides[0].comparison;
    assert.deepEqual(comparison?.left.items, ['1 A', '2 B', '3 C', '4 D', '5 E', '6 F']);
    assert.deepEqual(comparison?.right.items, ['16 X', '17 Y', '18 Z']);
});

test('mixed narrative and quote channels remain independent beats without continuation labels', () => {
    const args = baseArgs();
    args.slides = [{
        purpose: 'Pair context with an emotional pull quote',
        message: 'A long era comes to an end',
        body: 'The explanatory context belongs on a readable editorial page.',
        quote: 'Twenty-nine seasons end here.',
        composition: 'narrative',
        layout: { archetype: 'editorial' },
    }];

    const result = fitPresentationArgsToCapacity(args);
    assert.equal(result.slideCount, 2);
    const slides = result.args.slides as Array<Record<string, unknown>>;
    assert.ok(slides.every(slide => !/[（(]\d+\/\d+[）)]$/.test(String(slide.title || slide.message))));
    assert.equal(parsePresentationPlan(result.args).slides[1].resolvedLayout.family, 'quote');
});

test('stored rendered pagination remains concrete during design revisions', () => {
    const args = baseArgs();
    args.slides = [
        {
            purpose: 'Close the narrative',
            message: 'Decide now',
            title: 'Decision (1/2)',
            composition: 'closing',
            body: 'Approve the next step.',
            layout: { archetype: 'closing' },
            __openfluxSourceSlide: 1,
        },
        {
            purpose: 'Close the narrative',
            message: 'Decide now',
            title: 'Decision (2/2)',
            composition: 'quote',
            quote: 'Move while the evidence is fresh.',
            layout: { archetype: 'quote' },
            __openfluxSourceSlide: 1,
        },
    ];
    const result = fitPresentationArgsToCapacity(args, { coalesceContinuations: false });
    assert.equal(result.slideCount, 2);
    assert.equal(result.mergedSlides, 0);
    assert.equal(result.expanded, false);
    assert.deepEqual(result.slideOrigins, [1, 1]);
});

test('closing capacity removes duplicated quote copy and assigns imagery to only one page', () => {
    const duplicate = baseArgs();
    duplicate.slides = [{
        purpose: 'End with one clear invitation',
        message: 'Join the opening event',
        composition: 'closing',
        body: 'Join us tomorrow. A delayed season can still hold an unexpected story.',
        quote: 'A delayed season can still hold an unexpected story.',
        image_path: 'C:\\assets\\ending.png',
        layout: { archetype: 'closing' },
    }];
    const deduplicated = fitPresentationArgsToCapacity(duplicate);
    assert.equal(deduplicated.slideCount, 1);
    const only = (deduplicated.args.slides as Array<Record<string, unknown>>)[0];
    assert.equal(only.quote, undefined);
    assert.equal(only.image_path, 'C:\\assets\\ending.png');

    const distinct = baseArgs();
    distinct.slides = [{
        purpose: 'End with an action and a final thought',
        message: 'Approve the next step',
        composition: 'closing',
        body: 'Confirm the owner and start date.',
        quote: 'Move while the evidence is fresh.',
        image_path: 'C:\\assets\\ending.png',
        layout: { archetype: 'closing' },
    }];
    const combined = fitPresentationArgsToCapacity(distinct);
    assert.equal(combined.slideCount, 1);
    const onlyCombined = (combined.args.slides as Array<Record<string, unknown>>)[0];
    assert.equal(onlyCombined.composition, 'closing');
    assert.equal(onlyCombined.body, 'Confirm the owner and start date.');
    assert.equal(onlyCombined.quote, 'Move while the evidence is fresh.');
    assert.equal(onlyCombined.image_path, 'C:\\assets\\ending.png');

    const longDistinct = baseArgs();
    longDistinct.slides = [{
        purpose: 'End with a detailed handoff and a final thought',
        message: 'Approve the next step',
        composition: 'closing',
        body: 'Confirm the accountable owner, executive sponsor, funded capacity, measurement cadence, escalation threshold, legal review, operating checkpoint, and dated start decision before work begins.',
        quote: 'Move while the evidence is fresh.',
        image_path: 'C:\\assets\\ending.png',
        layout: { archetype: 'closing' },
    }];
    const split = fitPresentationArgsToCapacity(longDistinct);
    assert.equal(split.slideCount, 2);
    const pages = split.args.slides as Array<Record<string, unknown>>;
    assert.equal(pages.filter(slide => slide.image_path).length, 1);
    assert.equal(pages[1].composition, 'quote');
    assert.ok(pages.every(slide => !/[（(]\d+\s*\/\s*\d+[）)]$/.test(String(slide.title || slide.message))));
});

test('event ledgers extract schedule markers without putting long titles in the narrow rail', () => {
    assert.deepEqual(eventLedgerTextParts({
        title: '埃弗斯堡 vs 勒沃库森',
        description: '8/29 21:30｜新军埃弗斯堡的德甲历史首战',
    }, 1), {
        marker: '8/29 21:30',
        title: '埃弗斯堡 vs 勒沃库森',
        detail: '新军埃弗斯堡的德甲历史首战',
    });
    assert.equal(eventLedgerTextParts({ title: 'Quarterly review', description: 'Owner confirmed' }, 8).marker, '09');
});

test('structured narrative still paginates when its bounded reading rail is exceeded', () => {
    const args = baseArgs();
    args.slides = [{
        purpose: 'Preserve a complete evidence explanation',
        message: 'Long evidence moves to a continuation only when it cannot share the page safely',
        body: 'This explanation is intentionally longer than the bounded structured-page reading rail. '.repeat(8),
        bullets: ['One', 'Two', 'Three', 'Four'],
        metrics: Array.from({ length: 4 }, (_, index) => ({ value: `${index + 1}`, label: `Metric ${index + 1}` })),
    }];
    const fitted = fitPresentationArgsToCapacity(args);
    assert.equal(fitted.expanded, true);
    assert.ok(fitted.slideCount >= 2);
    const plan = parsePresentationPlan(fitted.args);
    assert.equal(plan.slides.reduce((sum, slide) => sum + slide.metrics.length, 0), 4);
    assert.equal(plan.slides.reduce((sum, slide) => sum + slide.bullets.length, 0), 4);
});

test('chart reading rail keeps four concise findings with the chart', () => {
    const args = baseArgs();
    (args.brief as Record<string, unknown>).delivery_mode = 'report';
    args.slides = [{
        purpose: 'Explain an editable chart',
        message: 'The chart and its four findings form one argument',
        chart: { type: 'bar', labels: ['A', 'B', 'C', 'D'], values: [11, 9, 6, 4] },
        bullets: [
            'The largest result establishes the upper bound',
            'Two middle results define the comparable cohort',
            'The smallest result still clears the operating threshold',
            'One postponed observation remains outside this chart and should be disclosed without creating a separate slide',
        ],
    }];
    const result = fitPresentationArgsToCapacity(args);
    assert.equal(result.expanded, false);
    assert.equal(result.slideCount, 1);
    assert.deepEqual(evaluatePresentationPlan(parsePresentationPlan(result.args)).filter(issue => issue.severity === 'error'), []);
});

test('four short peer records use an equal-weight compact collection layout', () => {
    const args = baseArgs();
    args.slides = [{
        purpose: '展示四场同等重要的焦点赛事',
        message: '四场赛事应等权呈现',
        items: Array.from({ length: 4 }, (_, index) => ({
            title: `焦点战 ${index + 1}`,
            description: `第 ${index + 2} 轮 · 周六 21:30`,
        })),
        layout: { archetype: 'collection', variant: 'cards' },
    }];
    const plan = parsePresentationPlan(fitPresentationArgsToCapacity(args).args);
    assert.ok(['collection-list', 'collection-list-banded'].includes(plan.slides[0].resolvedLayout.silhouette));
    assert.notEqual(plan.slides[0].resolvedLayout.silhouette, 'collection-mosaic');
});

test('four long factual records use a readable list instead of narrow cards', () => {
    const args = baseArgs();
    args.slides = [{
        purpose: 'Define an experiment without losing factual detail',
        message: 'The experiment keeps its owner, guardrail, and six-week cadence visible',
        information_role: 'action',
        items: [
            { title: '假设', description: '注册从五步减到三步，注册到激活转化率从百分之五十提升到百分之五十八' },
            { title: '主指标', description: '主指标为注册到激活转化率，护栏指标为注册完成率且不得连续两周下降' },
            { title: '停止条件', description: '激活率两周无提升或注册完成率下降超过五个百分点时立即停止并回滚' },
            { title: '负责人与节奏', description: '产品负责人统筹前端两人与数据一人，从第一周基线到第六周复盘决策' },
        ],
        layout: { archetype: 'collection', variant: 'stacked' },
    }];
    const fitted = fitPresentationArgsToCapacity(args);
    const plan = parsePresentationPlan(fitted.args);
    assert.equal(fitted.expanded, false);
    assert.ok(['collection-list', 'collection-list-banded'].includes(plan.slides[0].resolvedLayout.silhouette));
    assert.equal(evaluatePresentationPlan(plan).some(issue => issue.severity === 'error'), false);
});

test('three complete peer recommendations use stacked full-width geometry instead of aggregate density rejection', () => {
    const args = baseArgs();
    args.slides = [{
        purpose: '给出三条按优先级排序的完整建议',
        message: '先修付费引导，再提注册质量，周度复测锁成果',
        title: '三条建议',
        information_role: 'action',
        composition: 'grid',
        items: [
            {
                title: '建议一：优化试用到付费的引导路径',
                description: '在试用期第 3 天和第 6 天触发价值回顾提示，把用户在核心功能上已经取得的使用成果直接呈现在付费页，让用户在决策前看见自己将要买到什么，减少因价值感知不足造成的决策摩擦，直接对症 75% 的环节流失。',
            },
            {
                title: '建议二：提升注册环节的流量质量',
                description: '对全部访问来源按注册率分层排队，暂停注册率低于 20% 的低质渠道投放，把预算集中到高意向来源，让 3600 的注册基数变得更干净，为付费环节输送更有购买意向的用户，同时压低 8400 的无效流失。',
            },
            {
                title: '建议三：建立分环节的周度复测机制',
                description: '固定每周复测访问、注册、付费三个数，任一环节转化率环比波动超过 5 个百分点即触发专项诊断，把问题暴露在当周而不是积压到季度末，确保前两条建议的修复效果可以被持续验证、及时纠偏。',
            },
        ],
        layout: { archetype: 'collection', variant: 'stacked', whitespace: 'compact' },
    }];
    const fitted = fitPresentationArgsToCapacity(args);
    const plan = parsePresentationPlan(fitted.args);
    const issues = evaluatePresentationPlan(plan);
    assert.equal(fitted.expanded, false);
    assert.equal(issues.some(issue => issue.code === 'content_too_dense'), false);
    assert.ok(['collection-list', 'collection-list-banded'].includes(plan.slides[0].resolvedLayout.silhouette));
});

test('long bullets paginate by visual weight before PowerPoint text QA', () => {
    const args = baseArgs();
    args.slides = [{
        purpose: '完整呈现四条较长赛程说明',
        message: '赛程说明不能依靠缩小字号硬塞',
        bullets: Array.from({ length: 4 }, (_, index) => (
            `第 ${index + 2} 轮焦点赛事：主队迎战客队，比赛时间为周六晚间并包含完整观赛提示`
        )),
        layout: { archetype: 'editorial' },
    }];
    const fitted = fitPresentationArgsToCapacity(args);
    assert.equal(fitted.expanded, true);
    assert.equal(fitted.slideCount, 2);
    assert.equal(parsePresentationPlan(fitted.args).slides.reduce((sum, slide) => sum + slide.bullets.length, 0), 4);
});

test('visual revision patches preserve content channels and slide numbering', () => {
    const stored = baseArgs();
    stored.slides = [{
        purpose: '展示四场焦点赛事',
        message: '四场赛事应等权呈现',
        items: Array.from({ length: 4 }, (_, index) => ({ title: `焦点战 ${index + 1}` })),
        layout: { archetype: 'collection' },
    }];
    const safe = validatePresentationRevisionPatches(stored, {
        workflow: { stage: 'revision' },
        slide_patches: [{ slide: 1, changes: { layout: { variant: 'banded' } } }],
    });
    assert.equal(safe, undefined);

    const introduced = validatePresentationRevisionPatches(stored, {
        workflow: { stage: 'revision' },
        slide_patches: [{ slide: 1, changes: { bullets: ['新增的第二内容通道'] } }],
    });
    assert.match(introduced || '', /introduced a new content channel/);

    const removed = validatePresentationRevisionPatches(stored, {
        workflow: { stage: 'revision' },
        slide_patches: [{ slide: 1, changes: { items: [] } }],
    });
    assert.match(removed || '', /removed items entries/);

    // Nested beside the other workflow fields, which is where a live run put them
    // for three straight revisions while the validator saw an empty patch set.
    assert.match(validatePresentationRevisionPatches(stored, {
        workflow: {
            stage: 'revision',
            slide_patches: [{ slide: 1, changes: { bullets: ['新增的第二内容通道'] } }],
        },
    }) || '', /introduced a new content channel/);
});

test('series-shaped charts plot on the ordinary category types', () => {
    // The exact charts a live deck lost on five of twelve slides: the renderer
    // already plots one line or bar group per series for every category type, but
    // the parser read `series` only for the stacked types and dropped the rest.
    const args = baseArgs();
    args.slides = [
        {
            purpose: '风险分布', message: '注册与营销风险等级对比',
            chart: {
                type: 'bar', name: '风险等级分布',
                labels: ['0-无风险', '1-低风险', '2-中风险', '3-中高风险', '4-高风险'],
                series: [
                    { name: '注册风险', values: [14248, 2473, 6149, 6110, 8] },
                    { name: '营销风险', values: [13976, 2724, 6151, 6129, 8] },
                ],
            },
        },
        {
            purpose: '月度趋势', message: '月度销售趋势',
            chart: {
                type: 'line', name: '月度销售趋势',
                labels: ['Jan', 'Feb', 'Mar', 'Apr'],
                series: [
                    { name: '2025', values: [12, 18, 25, 22] },
                    { name: '2026', values: [15, 20, 28, 32] },
                ],
            },
        },
        {
            purpose: '搜索指数', message: 'NBA搜索指数走势',
            chart: {
                type: 'area', name: 'NBA搜索指数',
                labels: ['2026-01', '2026-02', '2026-03'],
                series: [{ name: '搜索指数', values: [165, 180, 210] }],
            },
        },
    ];
    const plan = parsePresentationPlan(args);
    assert.equal(plan.slides[0].chart?.series?.length, 2);
    assert.deepEqual(plan.slides[0].chart?.labels, ['0-无风险', '1-低风险', '2-中风险', '3-中高风险', '4-高风险']);
    assert.equal(plan.slides[1].chart?.type, 'line');
    assert.equal(plan.slides[1].chart?.series?.length, 2);
    // A single series is a complete chart on a plain type, though not on a stacked one.
    assert.equal(plan.slides[2].chart?.series?.length, 1);
    assert.equal(plan.slides.every(slide => !slide.chartRejection), true);
});

test('an unplottable chart says so instead of vanishing into a bare title', () => {
    const args = baseArgs();
    args.slides = [{
        purpose: '会员规模', message: '会员注册年份分布',
        // One category is not a chart, and this one rendered as a title alone.
        chart: { type: 'column', name: '注册年份分布', labels: ['2026年'], values: [28988] },
    }];
    const plan = parsePresentationPlan(args);
    assert.equal(plan.slides[0].chart, undefined);
    assert.match(plan.slides[0].chartRejection || '', /at least two numeric values/);

    const rejected = evaluatePresentationPlan(plan).find(issue => issue.code === 'chart_data_rejected');
    assert.equal(rejected?.severity, 'error');
    assert.equal(rejected?.slide, 1);
    // The repair has to be legal under the revision contract, or naming it would
    // just start another loop: patching an existing channel changes no counts.
    assert.match(rejected?.message || '', /Patch the chart channel/);

    assert.match(describeChartRejection({ type: 'doughnut', series: [{ values: [1, 2] }, { values: [3, 4] }] }), /plots a single series/);
    assert.match(describeChartRejection({ type: 'line', series: [{ values: [1, 2, 3] }, { values: [4, 5] }] }), /different value counts/);
    assert.match(describeChartRejection({ type: 'sunburst' }), /not a supported type/);
    assert.match(describeChartRejection({ type: 'bar', labels: ['a', 'b', 'c'], values: [1, 2] }), /must match one to one/);
});

test('a draft turned away by preflight can be restructured instead of preserved', () => {
    // Ownership is claimed before preflight reports its verdict, so a deck that
    // never rendered still binds the retry contract. Fixing a structural rejection
    // means changing structure, which that contract forbids: a live turn spent
    // four iterations trapped between the two before resubmitting the draft as-is.
    const rejected = baseArgs();
    rejected.slides = [
        { purpose: '开场', message: '标题页', layout: { archetype: 'statement' } },
        { purpose: '数据', message: '销售概览', bullets: ['原始要点一', '原始要点二'] },
    ];
    rejected.__workflow_state = {
        version: 1,
        designId: 'preflight-rejected',
        stage: 'design_sample',
        designSample: { required: true, status: 'pending', mode: 'auto', sampleSlideNumbers: [] },
    };
    const restructured = {
        workflow: { stage: 'sample' },
        slides: [{ purpose: '开场', message: '标题页', layout: { archetype: 'statement' } }],
    };
    assert.equal(validatePresentationSampleRetry(rejected, restructured), undefined);

    // Once directions have rendered there are real records to protect, and the
    // same resubmission must be refused again.
    const rendered = baseArgs();
    rendered.slides = rejected.slides;
    rendered.__workflow_state = {
        ...(rejected.__workflow_state as Record<string, unknown>),
        designSample: { required: true, status: 'pending', mode: 'auto', sampleSlideNumbers: [], generatedAt: Date.now() },
    };
    assert.match(
        validatePresentationSampleRetry(rendered, restructured) || '',
        /changed the slide count from 2 to 1/,
    );
});

test('a follow-up design inherits the output folder of the deck it follows', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'openflux-presentation-session-dir-'));
    const store = join(root, 'design-store');
    try {
        const first = baseArgs();
        first.output_dir = '2026-09-03/AI行业分析';
        first.__workflow_state = { version: 1, designId: 'first-design', sessionId: 'session-a', stage: 'completed' };
        await savePresentationDesign(root, 'first-design', first, store);

        const found = await findLatestSessionDesign(root, 'session-a', store);
        assert.equal(found?.designId, 'first-design');
        assert.equal(found?.args.output_dir, '2026-09-03/AI行业分析');

        // Another session's deck must not pull an edit into its folder, and a
        // session with no prior deck must fall back to the Project root.
        assert.equal(await findLatestSessionDesign(root, 'session-b', store), undefined);
        assert.equal(await findLatestSessionDesign(root, '', store), undefined);

        const second = baseArgs();
        second.__workflow_state = { version: 1, designId: 'second-design', sessionId: 'session-a', stage: 'design_sample' };
        await savePresentationDesign(root, 'second-design', second, store);
        assert.equal((await findLatestSessionDesign(root, 'session-a', store))?.designId, 'second-design');
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('nested workflow.slide_patches reach the resolved design', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'openflux-presentation-nested-patch-'));
    const store = join(root, 'design-store');
    try {
        const stored = baseArgs();
        stored.slides = [
            { purpose: '开场', message: '原始第一页标题', layout: { archetype: 'statement' } },
            { purpose: '收束', message: '原始第二页标题', layout: { archetype: 'statement' } },
        ];
        const designId = 'nested-patch-design';
        await savePresentationDesign(root, designId, stored, store);

        // Two different messages for two different slides: the exact shape a live
        // run submitted twice while the stored deck kept its duplicate titles.
        const resolved = await resolvePresentationDesignArgs(root, {
            design_id: designId,
            workflow: {
                stage: 'revision',
                revision: 1,
                slide_patches: [
                    { slide: 1, changes: { message: '改写后的第一页' } },
                    { slide: 2, changes: { message: '改写后的第二页' } },
                ],
            },
        }, store);
        const slides = resolved.slides as Array<{ message: string }>;
        assert.equal(slides[0].message, '改写后的第一页');
        assert.equal(slides[1].message, '改写后的第二页');
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('sample retry compares against the authored deck, not the rendered pagination', () => {
    // The stored deck is post-expansion: one authored closing slide occupies two
    // rendered pages carrying three and two of its five bullets. Closing pages get
    // no "(n/m)" label, so provenance is the only way back to the authored deck.
    const stored = baseArgs();
    stored.slides = [
        { purpose: '开场', message: '标题页', layout: { archetype: 'statement' }, __openfluxSourceSlide: 1 },
        {
            purpose: '收束',
            message: '下一步行动',
            bullets: ['行动一', '行动二', '行动三'],
            __openfluxSourceSlide: 2,
            __openfluxBoundaryRole: 'closing',
        },
        {
            purpose: '收束',
            message: '下一步行动',
            bullets: ['行动四', '行动五'],
            __openfluxSourceSlide: 2,
            __openfluxBoundaryRole: 'closing',
        },
    ];
    const authoredResubmission = {
        workflow: { stage: 'sample' },
        slides: [
            { purpose: '开场', message: '标题页', layout: { archetype: 'statement' } },
            {
                purpose: '收束',
                message: '下一步行动',
                bullets: ['行动一', '行动二', '行动三', '行动四', '行动五'],
            },
        ],
    };
    assert.equal(validatePresentationSampleRetry(stored, authoredResubmission), undefined);

    // Dropping a bullet is still a factual change and must still be caught.
    assert.match(validatePresentationSampleRetry(stored, {
        workflow: { stage: 'sample' },
        slides: [
            authoredResubmission.slides[0],
            { purpose: '收束', message: '下一步行动', bullets: ['行动一', '行动二', '行动三', '行动四'] },
        ],
    }) || '', /changed factual channel bullets/);

    // A genuine page-count change reports the authored count the caller can see.
    assert.match(validatePresentationSampleRetry(stored, {
        workflow: { stage: 'sample' },
        slides: [authoredResubmission.slides[0]],
    }) || '', /changed the slide count from 2 to 1/);
});

test('sample retry preserves every factual record and allows layout-only repair', () => {
    const stored = baseArgs();
    stored.slides = [{
        purpose: '发布事件',
        message: '四条事件必须完整保留',
        items: Array.from({ length: 4 }, (_, index) => ({ title: `Event ${index + 1}` })),
        layout: { archetype: 'collection' },
    }];
    assert.equal(validatePresentationSampleRetry(stored, {
        workflow: { stage: 'sample' },
        slide_patches: [{ slide: 1, changes: { layout: { variant: 'banded' } } }],
    }), undefined);
    assert.match(validatePresentationSampleRetry(stored, {
        workflow: { stage: 'sample' },
        slides: [{
            purpose: '发布事件',
            message: '四条事件必须完整保留',
            items: Array.from({ length: 3 }, (_, index) => ({ title: `Event ${index + 1}` })),
        }],
    }) || '', /changed factual channel items/);
    assert.match(validatePresentationSampleRetry(stored, {
        workflow: { stage: 'sample' },
        slide_patches: [{ slide: 1, changes: { items: [] } }],
    }) || '', /changed factual channel items/);

    stored.slides = [{
        purpose: '展示赛季指标',
        message: '四项指标概括赛季',
        metrics: [
            { value: '18', label: '参赛球队' },
            { value: '8月28日', label: '揭幕战（当地时间）', description: '北京时间8月29日' },
        ],
    }];
    assert.equal(validatePresentationSampleRetry(stored, {
        workflow: { stage: 'sample' },
        slide_patches: [{
            slide: 1,
            changes: {
                metrics: [
                    { value: '18', label: '球队' },
                    { value: '8月28日', label: '揭幕战', description: '当地时间；北京时间8月29日' },
                ],
            },
        }],
    }), undefined);
    assert.match(validatePresentationSampleRetry(stored, {
        workflow: { stage: 'sample' },
        slide_patches: [{
            slide: 1,
            changes: {
                metrics: [
                    { value: '18', label: '球队' },
                    { value: '8/28', label: '揭幕战' },
                ],
            },
        }],
    }) || '', /changed metric 2 value/);
});

test('sample patches map sourceSlide to the concrete failing continuation sibling', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'openflux-presentation-source-map-'));
    const store = join(root, 'store');
    const designId = 'design-source-map';
    try {
        const stored = baseArgs();
        stored.slides = [
            { purpose: '封面', message: '封面', __openfluxSourceSlide: 1 },
            {
                purpose: '赛季速览', message: '赛季速览',
                bullets: ['说明一', '说明二'],
                __openfluxSourceSlide: 2,
            },
            {
                purpose: '赛季速览', message: '赛季速览',
                metrics: [
                    { value: '18', label: '参赛球队' },
                    { value: '8月28日', label: '揭幕战（当地时间）' },
                ],
                layout: { variant: 'auto' },
                __openfluxSourceSlide: 2,
            },
        ];
        stored.__workflow_state = {
            version: 1,
            designId,
            stage: 'design_sample',
            qa: {
                issues: [{ code: 'text_overflow', slide: 3, sourceSlide: 2 }],
            },
        };
        await savePresentationDesign(root, designId, stored, store);
        const requested = {
            design_id: designId,
            workflow: { stage: 'sample', design_id: designId },
            slide_patches: [{
                slide: 2,
                changes: {
                    metrics: [
                        { value: '18', label: '球队' },
                        { value: '8月28日', label: '揭幕战' },
                    ],
                    layout: { variant: 'stacked' },
                },
            }],
        };
        assert.equal(validatePresentationSampleRetry(stored, requested), undefined);
        const resolved = await resolvePresentationDesignArgs(root, requested, store);
        const slides = resolved.slides as Array<Record<string, any>>;
        assert.deepEqual(slides[1].bullets, ['说明一', '说明二']);
        assert.equal(slides[1].layout, undefined);
        assert.equal(slides[2].metrics[1].label, '揭幕战');
        assert.equal(slides[2].layout.variant, 'stacked');
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('generate_presentation uses a compact reading list and paginates only beyond ten entries', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'openflux-presentation-capacity-'));
    try {
        const args = baseArgs();
        const slides = args.slides as Array<Record<string, unknown>>;
        slides[1] = {
            purpose: '完整呈现十三个赛程条目',
            message: '十三场比赛都必须出现在演示文稿中',
            body: '短记录优先采用双栏清单，不要求用户选择模板。',
            items: Array.from({ length: 13 }, (_, index) => ({ title: `比赛 ${index + 1}` })),
            layout: { archetype: 'collection' },
        };
        args.filename = 'capacity.pptx';
        const result = await createPresentationGenTool({ getOutputPath: () => root }).execute(args);
        assert.equal(result.success, true, result.error);
        const data = result.data as {
            pptx: string;
            slideCount: number;
            capacityPlan: { expanded: boolean; insertedSlides: number; splits: unknown[] };
        };
        assert.equal(data.slideCount, 6);
        assert.equal(data.capacityPlan.expanded, true);
        assert.equal(data.capacityPlan.insertedSlides, 1);
        assert.equal(data.capacityPlan.splits.length, 1);

        const zip = await JSZip.loadAsync(await fs.readFile(data.pptx));
        const slideXml = await Promise.all(
            Object.keys(zip.files)
                .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
                .map(name => zip.file(name)!.async('string')),
        );
        const visibleMatches = slideXml.join('\n').match(/比赛 1[0-3]|比赛 [1-9]/g) || [];
        assert.equal(new Set(visibleMatches).size, 13);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('quality checks reject unreadable art-direction contrast', () => {
    const args = baseArgs();
    (args.art_direction as Record<string, unknown>).palette = {
        background: 'F4F1EA',
        text: 'D8D5CF',
        muted: 'D8D5CF',
        accent: '1F9D68',
        accent2: 'F0A34A',
    };
    const issues = evaluatePresentationPlan(parsePresentationPlan(args));
    assert.ok(issues.some(issue => issue.code === 'low_text_contrast' && issue.severity === 'error'));
});

test('quality checks reject orphaned continuation pages and exempt intentional boundaries', () => {
    const args = baseArgs();
    args.slides = [{
        purpose: 'Continue an automatically split explanation',
        message: 'Operating overview (1/2)',
        composition: 'narrative',
        bullets: ['Only one short fact remains'],
        layout: { archetype: 'editorial' },
    }];
    const issues = evaluatePresentationPlan(parsePresentationPlan(args));
    assert.ok(issues.some(issue => issue.code === 'orphaned_continuation_page' && issue.severity === 'error'));

    (args.slides as Array<Record<string, unknown>>)[0].layout = { archetype: 'section' };
    const sectionIssues = evaluatePresentationPlan(parsePresentationPlan(args));
    assert.ok(!sectionIssues.some(issue => issue.code === 'orphaned_continuation_page'));

    (args.slides as Array<Record<string, unknown>>)[0] = {
        purpose: 'Close the narrative deliberately',
        message: 'Operating overview (2/2)',
        composition: 'quote',
        quote: 'The final decision is now clear.',
        layout: { archetype: 'quote' },
    };
    const endingQuoteIssues = evaluatePresentationPlan(parsePresentationPlan(args));
    assert.ok(!endingQuoteIssues.some(issue => issue.code === 'orphaned_continuation_page'));
});

test('rendered QA rejects visually orphaned continuation pages', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'openflux-rendered-qa-'));
    try {
        const imagePath = join(root, 'slide-1.png');
        await sharp({
            create: { width: 1600, height: 900, channels: 3, background: '#111827' },
        }).png().toFile(imagePath);
        const args = baseArgs();
        args.slides = [{
            purpose: 'Continue an automatically split explanation',
            message: 'Operating overview (2/2)',
            composition: 'narrative',
            bullets: ['Only one short fact remains'],
            layout: { archetype: 'editorial' },
        }];
        const result = await inspectRenderedPresentation(parsePresentationPlan(args), [imagePath]);
        assert.equal(result.available, true);
        assert.equal(result.slides[0].occupiedCellRatio, 0);
        assert.ok(result.issues.some(issue => issue.code === 'rendered_orphaned_continuation' && issue.severity === 'error'));
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('rendered QA permits deliberate low-density closing and final quote pages', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'openflux-rendered-ending-qa-'));
    try {
        const imagePath = join(root, 'slide-1.png');
        await sharp({
            create: { width: 1600, height: 900, channels: 3, background: '#111827' },
        }).png().toFile(imagePath);
        for (const slide of [
            {
                purpose: 'End with a clear action',
                message: 'Approve the next step (2/2)',
                composition: 'closing',
                layout: { archetype: 'closing' },
            },
            {
                purpose: 'End with a deliberate final statement',
                message: 'One final thought (2/2)',
                composition: 'quote',
                quote: 'The ending resolves the opening question.',
                layout: { archetype: 'quote' },
            },
        ]) {
            const args = baseArgs();
            args.slides = [slide];
            const result = await inspectRenderedPresentation(parsePresentationPlan(args), [imagePath]);
            assert.ok(!result.issues.some(issue => issue.code === 'rendered_orphaned_continuation'));
        }
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('quality checks validate text contrast on card surfaces as well as slide backgrounds', () => {
    const args = baseArgs();
    (args.art_direction as Record<string, any>).palette = {
        background: '111827',
        surface: 'F8FAFC',
        text: 'FFFFFF',
        muted: 'CBD5E1',
        accent: 'F43F5E',
        accent2: 'FBBF24',
    };
    const issues = evaluatePresentationPlan(parsePresentationPlan(args));
    assert.ok(issues.some(issue => issue.code === 'low_surface_text_contrast' && issue.severity === 'error'));
});

test('generate_presentation creates an editable PPTX and keeps output inside the Project', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'openflux-presentation-unit-'));
    try {
        const tool = createPresentationGenTool({ getOutputPath: () => root });
        const result = await tool.execute(baseArgs());
        assert.equal(result.success, true, result.error);
        const data = result.data as { files: string[]; pptx: string; slideCount: number; qa: { issues: unknown[] } };
        assert.equal(data.slideCount, 5);
        assert.equal(data.files.length, 1);
        assert.equal(data.files[0], data.pptx);
        const bytes = await fs.readFile(data.pptx);
        assert.ok(bytes.length > 10_000);
        const zip = await JSZip.loadAsync(bytes);
        assert.ok(zip.file('ppt/presentation.xml'));
        assert.equal(Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length, 5);

        const escaped = await tool.execute({
            ...baseArgs(),
            output_dir: join(root, '..', 'outside'),
        });
        assert.equal(escaped.success, false);
        assert.match(escaped.error || '', /inside the active OpenFlux Project/);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('generated display headlines preserve balanced lines as separate PowerPoint paragraphs', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'openflux-presentation-balanced-title-'));
    try {
        const args = baseArgs();
        const title = '批准两个行业、一个季度和一套冻结指标';
        const expectedLines = balancedTitleText(title).split('\n');
        assert.equal(expectedLines.length, 2);
        (args.slides as Array<Record<string, unknown>>)[4].message = title;
        args.filename = 'balanced-title.pptx';
        const result = await createPresentationGenTool({ getOutputPath: () => root }).execute(args);
        assert.equal(result.success, true, result.error);
        const pptx = (result.data as { pptx: string }).pptx;
        const zip = await JSZip.loadAsync(await fs.readFile(pptx));
        const slideXml = await zip.file('ppt/slides/slide5.xml')!.async('string');
        const paragraphs = Array.from(slideXml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)).map(match => (
            Array.from(match[1].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g))
                .map(text => text[1])
                .join('')
        ));
        assert.ok(paragraphs.includes(expectedLines[0]));
        assert.ok(paragraphs.includes(expectedLines[1]));
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('two visual revisions plus one constrained mechanical revision are the absolute cap', async () => {
    const result = await createPresentationGenTool().execute({ ...baseArgs(), revision: 4 });
    assert.equal(result.success, false);
    assert.match(result.error || '', /between 0 and 3/);
});

test('quality issue aggregation keeps native QA and drops the model restatement', () => {
    const issues = deduplicatePresentationQualityIssues([
        {
            severity: 'error',
            code: 'text_overflow',
            slide: 6,
            message: "Text 'five data sources' exceeds its box on slide 6.",
        },
        {
            severity: 'error',
            code: 'visual_typography',
            slide: 6,
            message: 'Native QA text_overflow on slide 6. Action: shorten the description.',
        },
        {
            severity: 'error',
            code: 'visual_typography',
            slide: 13,
            message: 'IO is split across two lines. Action: remove the abbreviation.',
        },
    ]);
    assert.deepEqual(issues.map(issue => [issue.code, issue.slide]), [
        ['text_overflow', 6],
        ['visual_typography', 13],
    ]);
});

test('the third revision opens only for residual mechanical text QA', () => {
    const guidance = presentationMechanicalRepairGuidance([
        {
            severity: 'error',
            code: 'text_overflow',
            slide: 6,
            message: 'Text exceeds its box.',
        },
        {
            severity: 'error',
            code: 'visual_typography',
            slide: 13,
            message: 'A word is split across lines.',
        },
        {
            severity: 'error',
            code: 'deck_visual_score_below_threshold',
            message: 'Typography defects lowered the deck score.',
        },
    ], 2);
    assert.equal(guidance.allowed, true);
    assert.equal(guidance.repairRevision, 3);
    assert.deepEqual(guidance.targetSlides, [6, 13]);

    const visualBlocker = presentationMechanicalRepairGuidance([
        ...guidance.issues,
        {
            severity: 'error',
            code: 'visual_composition',
            slide: 11,
            message: 'The entire composition has no focal point.',
        },
    ], 2);
    assert.equal(visualBlocker.allowed, false);
    assert.equal(visualBlocker.blockingIssues[0]?.code, 'visual_composition');

    // Every text-geometry code the exporter emits is repaired the same way, so
    // none of them may present itself as a non-mechanical blocker.
    for (const code of ['cjk_line_start_punctuation', 'cjk_orphan_line', 'text_out_of_bounds']) {
        const nativeText = presentationMechanicalRepairGuidance([
            { severity: 'error', code, slide: 5, message: 'Rewrap or shorten the copy.' },
        ], 2);
        assert.equal(nativeText.allowed, true, `${code} should open the mechanical repair`);
        assert.deepEqual(nativeText.blockingIssues, [], code);
        assert.deepEqual(nativeText.targetSlides, [5], code);
    }

    // Before the reserved revision opens, the model must still be told the one
    // legal remedy instead of discovering it through rejections.
    const earlyGuidance = presentationMechanicalRepairGuidance([
        { severity: 'error', code: 'text_overflow', slide: 5, message: 'Text exceeds its box.' },
    ], 1);
    assert.equal(earlyGuidance.allowed, false);
    assert.deepEqual(earlyGuidance.targetSlides, [5]);
    assert.match(earlyGuidance.instruction, /rewrite the existing entries shorter in place/);
    assert.match(earlyGuidance.instruction, /keep the same number of entries/);
});

test('the final mechanical repair must patch every machine target in one pass', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'openflux-presentation-mechanical-contract-'));
    const store = join(root, 'design-store');
    try {
        const args = baseArgs();
        const designId = 'design-mechanical-contract';
        const plan = parsePresentationPlan(args);
        const workflowState = createPresentationWorkflowState(plan, designId);
        const slideCount = plan.slides.length;
        workflowState.designSample.status = 'approved';
        workflowState.designSample.selectedDirectionId = 'executive';
        workflowState.fullGeneration = {
            generatedAt: Date.now(),
            slideCount,
            pptx: join(root, 'revision-2.pptx'),
            requirePdf: false,
            nativeQaAvailable: true,
            imageQaAvailable: true,
            imageQaChecked: 0,
            imageQaErrors: 0,
        };
        workflowState.visualReview = {
            status: 'complete',
            reviewedSlideNumbers: Array.from({ length: slideCount }, (_, index) => index + 1),
            totalSlides: slideCount,
            issues: [],
        };
        workflowState.qa = {
            status: 'needs_revision',
            revision: 2,
            errors: 2,
            warnings: 0,
            issues: [
                { severity: 'error', code: 'text_overflow', slide: 2, message: 'Overflow on slide 2.' },
                { severity: 'error', code: 'text_overflow', slide: 3, message: 'Overflow on slide 3.' },
            ],
        };
        workflowState.stage = 'revision';
        await savePresentationDesign(root, designId, {
            ...args,
            design_id: designId,
            __quality_state: { revision: 2, errors: 2, warnings: 0 },
            __workflow_state: workflowState,
        }, store);

        const tool = createPresentationGenTool({
            getOutputPath: () => root,
            getDesignStorePath: () => store,
            enforceWorkflow: true,
        });
        const result = await tool.execute({
            design_id: designId,
            revision: 3,
            workflow: {
                stage: 'revision',
                visual_review: {
                    issues: [{
                        slide: 2,
                        category: 'typography',
                        observation: 'Text overflows.',
                        action: 'Shorten it.',
                    }],
                },
            },
            slide_patches: [{ slide: 2, changes: { layout: { variant: 'stacked' } } }],
        }, { activeModel: { provider: 'moonshot', model: 'kimi-k3', vision: true } });
        assert.equal(result.success, false);
        assert.equal(result.code, 'presentation_mechanical_repair_contract_violation');
        assert.match(result.error || '', /Missing slides: 3/);
        assert.deepEqual(
            (result.data as { mechanicalRepair: { targetSlides: number[] } }).mechanicalRepair.targetSlides,
            [2, 3],
        );
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('revision-two review deduplicates native errors and opens the final mechanical repair', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'openflux-presentation-mechanical-review-'));
    const store = join(root, 'design-store');
    try {
        const args = baseArgs();
        args.slides = Array.from({ length: 16 }, (_, index) => ({
            purpose: `Decision point ${index + 1}`,
            message: `Slide ${index + 1}`,
            composition: index === 0 ? 'hero' : 'narrative',
        }));
        const designId = 'design-mechanical-review';
        const plan = parsePresentationPlan(args);
        const workflowState = createPresentationWorkflowState(plan, designId);
        const draftPath = join(root, 'revision-2.pptx');
        await fs.writeFile(draftPath, 'draft');
        workflowState.designSample.status = 'approved';
        workflowState.designSample.selectedDirectionId = 'executive';
        workflowState.fullGeneration = {
            generatedAt: Date.now(),
            slideCount: 16,
            pptx: draftPath,
            requirePdf: false,
            nativeQaAvailable: true,
            imageQaAvailable: true,
            imageQaChecked: 0,
            imageQaErrors: 0,
        };
        workflowState.visualReview = {
            status: 'pending',
            reviewedSlideNumbers: [],
            totalSlides: 16,
            issues: [],
        };
        workflowState.qa = {
            status: 'needs_revision',
            revision: 2,
            errors: 3,
            warnings: 0,
            issues: [
                { severity: 'error', code: 'text_overflow', slide: 6, message: 'Overflow on slide 6.' },
                { severity: 'error', code: 'text_overflow', slide: 10, message: 'Overflow on slide 10.' },
                { severity: 'error', code: 'text_overflow', slide: 16, message: 'Overflow on slide 16.' },
            ],
        };
        workflowState.stage = 'visual_review';
        await savePresentationDesign(root, designId, {
            ...args,
            design_id: designId,
            __quality_state: { revision: 1, errors: 9, warnings: 2 },
            __workflow_state: workflowState,
        }, store);

        const reviewedSlides = Array.from({ length: 16 }, (_, index) => index + 1);
        const result = await createPresentationGenTool({
            getOutputPath: () => root,
            getDesignStorePath: () => store,
            enforceWorkflow: true,
        }).execute({
            design_id: designId,
            workflow: {
                stage: 'review',
                visual_review: {
                    summary: 'Four local typography defects remain.',
                    strengths: ['The narrative and theme are otherwise coherent.'],
                    overall_score: 4,
                    scorecard: {
                        hierarchy: 4.5,
                        composition: 4.3,
                        typography: 3.5,
                        theme: 4.6,
                        originality: 4.2,
                    },
                    reviewed_slide_numbers: reviewedSlides,
                    slide_scores: reviewedSlides.map(slide => ({ slide, total: 4.2 })),
                    issues: [
                        { slide: 6, severity: 'error', category: 'typography', observation: 'Native QA text_overflow on slide 6.', action: 'Shorten the text.' },
                        { slide: 10, severity: 'error', category: 'typography', observation: 'Native QA text_overflow on slide 10.', action: 'Shorten the text.' },
                        { slide: 16, severity: 'error', category: 'typography', observation: 'Native QA text_overflow on slide 16.', action: 'Shorten the text.' },
                        { slide: 13, severity: 'error', category: 'typography', observation: 'IO is split across two lines.', action: 'Remove the abbreviation.' },
                        { slide: 11, severity: 'warning', category: 'composition', observation: 'The right side is sparse.', action: 'Accept the deliberate whitespace.' },
                        { slide: 9, severity: 'warning', category: 'composition', observation: 'The final grid cell is empty.', action: 'Accept the list rhythm.' },
                    ],
                },
            },
        }, { activeModel: { provider: 'moonshot', model: 'kimi-k3', vision: true } });

        assert.equal(result.success, true, result.error);
        const data = result.data as {
            qa: { errors: number; warnings: number; issues: Array<{ code: string; slide?: number }> };
            mechanicalRepair: { allowed: boolean; repairRevision: number; targetSlides: number[] };
            nextAction: string;
        };
        assert.equal(data.qa.errors, 5);
        assert.equal(data.qa.warnings, 2);
        assert.equal(data.qa.issues.filter(issue => issue.code === 'visual_typography').length, 1);
        assert.equal(data.mechanicalRepair.allowed, true);
        assert.equal(data.mechanicalRepair.repairRevision, 3);
        assert.deepEqual(data.mechanicalRepair.targetSlides, [6, 10, 13, 16]);
        assert.equal(data.nextAction, 'apply_final_mechanical_repair');
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('marketing decks require content direction and reject source-dump length', () => {
    const args = baseArgs();
    const brief = args.brief as Record<string, unknown>;
    delete brief.communication_job;
    brief.narrative_arc = ['只有一个目录主题'];
    args.slides = Array.from({ length: 23 }, (_, index) => ({
        purpose: `保留原资料第 ${index + 1} 部分`,
        message: `资料主题 ${index + 1}`,
        composition: 'narrative',
    }));
    const issues = evaluatePresentationPlan(parsePresentationPlan(args));
    assert.ok(issues.some(issue => issue.code === 'communication_job_required' && issue.severity === 'error'));
    assert.ok(issues.some(issue => issue.code === 'narrative_arc_required' && issue.severity === 'error'));
    assert.ok(issues.some(issue => issue.code === 'marketing_deck_too_long' && issue.severity === 'error'));
});

test('QA errors block draft files from delivery', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'openflux-presentation-gate-'));
    try {
        const tool = createPresentationGenTool({
            getOutputPath: () => root,
            getDesignStorePath: () => join(root, 'design-store'),
            exportPresentation: async options => ({
                previewPath: options.previewPath,
                slideImages: [],
                issues: [{
                    severity: 'error',
                    code: 'text_overflow',
                    slide: 2,
                    message: 'Text exceeds its box on slide 2.',
                }],
            }),
        });
        const args = baseArgs();
        args.export_pdf = false;
        args.render_preview = true;
        const result = await tool.execute(args);
        assert.equal(result.success, true, result.error);
        const data = result.data as {
            files: string[];
            qa: { status: string; errors: number; deliveryBlocked: boolean; nextAction: string };
        };
        assert.deepEqual(data.files, []);
        assert.equal(data.qa.status, 'needs_revision');
        assert.equal(data.qa.errors, 1);
        assert.equal(data.qa.deliveryBlocked, true);
        assert.equal(data.qa.nextAction, 'apply_structured_visual_review_patches');
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('a deck rejected before rendering is stored as authored, not as its pagination', async () => {
    // A live turn died here twice. An authored slide too dense for one page was
    // paginated, preflight rejected one of the resulting pages, and the
    // expanded deck was persisted. The retry then loaded the rejected page as
    // an authored slide of its own and reported the identical error, with no
    // legal move left: it may patch layout only, is told not to resend slides,
    // and merging pages is neither. It also aimed the patch at the wrong slide,
    // since issues[].sourceSlide counts authored slides.
    // (The planner no longer strands orphan continuations, so the rejected
    // page here is a body paragraph too dense for any single page.)
    const root = await fs.mkdtemp(join(tmpdir(), 'openflux-presentation-preflight-'));
    const store = join(root, 'design-store');
    try {
        const tool = createPresentationGenTool({
            getOutputPath: () => root,
            getDesignStorePath: () => store,
            enforceWorkflow: true,
        });
        const args = baseArgs();
        args.slides = [
            { purpose: '开场', message: '标题页', layout: { archetype: 'statement' } },
            { purpose: '过渡', message: '章节', layout: { archetype: 'section' } },
            { purpose: '收束', message: '结语', layout: { archetype: 'statement' } },
            {
                purpose: '罗列今日全部动态，密度足以触发自动分页',
                message: '今日动态汇总',
                composition: 'narrative',
                layout: { archetype: 'editorial' },
                body: Array.from({ length: 12 }, (_, index) => `第${index + 1}段背景说明，交代事件的起因、经过、涉及的各方以及对行业的影响。`).join(''),
                bullets: Array.from(
                    { length: 11 },
                    (_, index) => `第${index + 1}条动态，附带一段足够长的说明文字以占满版面容量`,
                ),
            },
        ];
        const designId = 'design-preflight-authored';
        args.design_id = designId;
        const result = await tool.execute(
            { ...args, workflow: { stage: 'sample' } },
            { activeModel: { provider: 'moonshot', model: 'kimi-k3', vision: true } },
        );

        assert.equal(result.success, false);
        assert.equal(result.code, 'presentation_structure_preflight_failed');
        const data = result.data as {
            capacityPlan: { originalSlideCount: number; slideCount: number };
            issues: Array<{ code: string; sourceSlide?: number; severity: string }>;
        };
        assert.ok(data.capacityPlan.slideCount > data.capacityPlan.originalSlideCount, 'the dense slide must paginate');
        assert.ok(
            !data.issues.some(issue => issue.code === 'orphaned_continuation_page'),
            'pagination must not strand a continuation page',
        );
        const orphan = data.issues.find(issue => issue.severity === 'error' && issue.code === 'content_too_dense');
        assert.ok(orphan, `the dense body must be rejected: ${JSON.stringify(data.issues.map(issue => issue.code))}`);

        // The stored deck is what the retry loads, so it has to be the authored
        // four slides. Storing the pagination is what made the orphan permanent.
        const stored = await loadPresentationDesign(root, designId, store);
        assert.equal(
            (stored?.slides as unknown[]).length,
            4,
            'the retry must load the authored deck, not the expanded one',
        );
        assert.equal(
            ((stored?.__workflow_state as Record<string, unknown>).contentDirection as { slideCount: number }).slideCount,
            4,
            'the stored state must agree with the stored deck',
        );
        // sourceSlide addresses the authored deck, so it must be in range of it.
        assert.ok(
            orphan.sourceSlide && orphan.sourceSlide <= 4,
            `sourceSlide ${orphan.sourceSlide} must address an authored slide`,
        );
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('a QA-regressing revision does not replace the stored design baseline', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'openflux-presentation-regression-'));
    const store = join(root, 'design-store');
    let exportCall = 0;
    try {
        const tool = createPresentationGenTool({
            getOutputPath: () => root,
            getDesignStorePath: () => store,
            exportPresentation: async () => {
                exportCall += 1;
                const count = exportCall === 1 ? 1 : 2;
                return {
                    slideImages: [],
                    issues: Array.from({ length: count }, (_, index) => ({
                        severity: 'error' as const,
                        code: 'text_overflow',
                        slide: index + 1,
                        message: `Overflow ${index + 1}`,
                    })),
                };
            },
        });
        const designId = 'design-quality-regression';
        const initial = await tool.execute({
            ...baseArgs(),
            design_id: designId,
            export_pdf: false,
            render_preview: true,
        });
        assert.equal(initial.success, true, initial.error);
        assert.equal((initial.data as { qa: { errors: number } }).qa.errors, 1);

        const revision = await tool.execute({
            design_id: designId,
            revision: 1,
            workflow: {
                stage: 'revision',
                slide_patches: [{ slide: 1, changes: { layout: { whitespace: 'generous' } } }],
                visual_review: {
                    issues: [{
                        slide: 1,
                        category: 'density',
                        observation: 'Text is still overflowing.',
                        action: 'Shorten the visible copy.',
                    }],
                },
            },
        });
        assert.equal(revision.success, true, revision.error);
        const qa = (revision.data as { qa: { status: string; nextAction: string } }).qa;
        assert.equal(qa.status, 'regressed');
        assert.equal(qa.nextAction, 'retry_revision_from_previous_design');

        const stored = await loadPresentationDesign(root, designId, store);
        assert.deepEqual(stored?.__quality_state, { revision: 0, errors: 1, warnings: 1 });

        // Without patches the render is byte-identical and the defects survive, so
        // the call must fail rather than quietly spend a revision on nothing.
        const empty = await tool.execute({
            design_id: designId,
            revision: 1,
            workflow: { stage: 'revision' },
        });
        assert.equal(empty.success, false);
        assert.equal(empty.code, 'presentation_revision_empty_patch_set');
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('a review of a worse render is still banked so the next revision can proceed', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'openflux-presentation-review-regression-'));
    const store = join(root, 'design-store');
    try {
        const png = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
            'base64',
        );
        const vision = { activeModel: { provider: 'moonshot', model: 'kimi-k3', vision: true } };
        // The direction samples must render clean, otherwise no direction survives
        // sample QA. The overflow belongs to the full deck.
        let reportOverflow = false;
        const tool = createPresentationGenTool({
            getOutputPath: () => root,
            getDesignStorePath: () => store,
            enforceWorkflow: true,
            exportPresentation: async options => {
                if (options.previewPath) await fs.writeFile(options.previewPath, png);
                return {
                    previewPath: options.previewPath,
                    reviewSheetPaths: options.previewPath ? [options.previewPath] : [],
                    slideImages: [],
                    issues: reportOverflow
                        ? [{
                            severity: 'error' as const,
                            code: 'text_overflow',
                            slide: 1,
                            message: 'Overflow 1',
                        }]
                        : [],
                };
            },
        });
        const sample = await tool.execute({
            ...baseArgs(),
            workflow: { stage: 'sample', mode: 'auto' },
        }, vision);
        assert.equal(sample.success, true, sample.error);
        const designId = (sample.data as { designId: string }).designId;
        reportOverflow = true;

        const final = await tool.execute({
            design_id: designId,
            export_pdf: false,
            workflow: {
                stage: 'final',
                direction_review: {
                    summary: 'Editorial reads clearest for this audience.',
                    selected_direction_id: 'editorial',
                    reviewed_direction_ids: ['executive', 'editorial', 'launch'],
                    scores: [
                        { id: 'executive', total: 4.2 },
                        { id: 'editorial', total: 4.7 },
                        { id: 'launch', total: 4.1 },
                    ],
                },
            },
        }, vision);
        assert.equal(final.success, true, final.error);
        const slideCount = (final.data as { slideCount: number }).slideCount;
        const slides = Array.from({ length: slideCount }, (_, index) => index + 1);
        const scorecard = {
            hierarchy: 4.7,
            composition: 4.6,
            typography: 4.5,
            theme: 4.6,
            originality: 4.4,
        };

        // The first review establishes the stored quality baseline.
        const baseline = await tool.execute({
            design_id: designId,
            workflow: {
                stage: 'review',
                visual_review: {
                    summary: 'Only the native overflow blocks delivery.',
                    strengths: ['Consistent palette', 'Readable hierarchy'],
                    overall_score: 4.6,
                    scorecard,
                    reviewed_slide_numbers: slides,
                    slide_scores: slides.map(slide => ({ slide, total: 4.6 })),
                    issues: [{
                        slide: 1,
                        category: 'typography',
                        severity: 'warning',
                        observation: 'The headline sits slightly tight against the rule.',
                        action: 'Add a little breathing room.',
                    }],
                },
            },
        }, vision);
        assert.equal(baseline.success, true, baseline.error);

        // A revision produces a new render, so the next review is compared against
        // the baseline rather than being exempt as a re-read of the same deck.
        const revision = await tool.execute({
            design_id: designId,
            revision: 1,
            workflow: {
                stage: 'revision',
                slide_patches: [{
                    slide: 1,
                    changes: { layout: { whitespace: 'generous' } },
                }],
            },
        }, vision);
        assert.equal(revision.success, true, revision.error);

        // The review of the new render reports more errors than the baseline.
        const review = await tool.execute({
            design_id: designId,
            workflow: {
                stage: 'review',
                visual_review: {
                    summary: 'Escalating an earlier typography warning to an error.',
                    strengths: ['Consistent palette', 'Readable hierarchy'],
                    overall_score: 4.6,
                    scorecard,
                    reviewed_slide_numbers: slides,
                    slide_scores: slides.map(slide => ({ slide, total: 4.6 })),
                    issues: [
                        {
                            slide: 2,
                            category: 'typography',
                            severity: 'error',
                            observation: 'The numbering glyphs may fall back to a blank box.',
                            action: 'Use plain digits instead.',
                        },
                        {
                            slide: 3,
                            category: 'density',
                            severity: 'error',
                            observation: 'The right rail now reads as a wall of text.',
                            action: 'Shorten each line to one clause.',
                        },
                    ],
                },
            },
        }, vision);

        assert.ok(review.data, `review returned no data: ${review.error}`);
        const data = review.data as {
            stage: string;
            qa: {
                status: string;
                issues: Array<{ code: string; severity: string; message: string }>;
            };
            workflowState: { stage: string; visualReview: { status: string } };
        };

        // The render really did get worse, and the tool says so.
        const regression = data.qa.issues.find(issue => issue.code === 'qa_regression');
        assert.equal(regression?.severity, 'warning');
        assert.match(regression?.message || '', /worse than the one before it/);

        // But the review is banked and the workflow moves on to the repair. Discarding
        // it here deadlocked the turn: only a revision can lower the error count, a
        // revision needs a banked review, and the review of a worse render was thrown
        // away, so one backfiring repair ended the workflow for good.
        assert.equal(data.qa.status, 'needs_revision');
        assert.equal(data.workflowState.visualReview.status, 'complete');
        assert.equal(data.stage, 'revision');

        const nextRevision = await tool.execute({
            design_id: designId,
            revision: 2,
            workflow: {
                stage: 'revision',
                slide_patches: [{ slide: 2, changes: { layout: { whitespace: 'generous' } } }],
            },
        }, vision);
        assert.equal(nextRevision.success, true, nextRevision.error);
        assert.doesNotMatch(
            String(nextRevision.error || ''),
            /submit the review stage before applying revisions/,
        );
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('a revision may shorten a slide body but not empty it or bolt on a second channel', async () => {
    const stored = {
        slides: [
            { title: 'Sales tracking', body: 'Monthly, weekly and daily reporting across the funnel.' },
        ],
    };
    const revise = (changes: Record<string, unknown>) => validatePresentationRevisionPatches(
        stored,
        { workflow: { stage: 'revision' }, slide_patches: [{ slide: 1, changes }] },
    );

    // Shortening prose in place is the one legal remedy, and it stays legal.
    assert.equal(revise({ body: 'Monthly, weekly and daily reporting.' }), undefined);

    // Blanking a slide's only content is a deletion, not a repair. `body` used to be
    // absent from the tally, so this passed and the deck simply lost the slide's copy.
    assert.match(String(revise({ body: '' })), /removed body entries/);

    // A body-only slide used to read as having no channels at all, which let a patch
    // add a list beside the prose without tripping the introduced-channel rule.
    assert.match(
        String(revise({ bullets: ['Monthly', 'Weekly', 'Daily'] })),
        /introduced a new content channel \(bullets\)/,
    );
});

test('a second look at the same render may report more than the first pass did', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'openflux-presentation-rereview-'));
    const store = join(root, 'design-store');
    try {
        const png = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
            'base64',
        );
        const vision = { activeModel: { provider: 'moonshot', model: 'kimi-k3', vision: true } };
        let reportOverflow = false;
        const tool = createPresentationGenTool({
            getOutputPath: () => root,
            getDesignStorePath: () => store,
            enforceWorkflow: true,
            exportPresentation: async options => {
                if (options.previewPath) await fs.writeFile(options.previewPath, png);
                return {
                    previewPath: options.previewPath,
                    reviewSheetPaths: options.previewPath ? [options.previewPath] : [],
                    slideImages: [],
                    issues: reportOverflow
                        ? [{
                            severity: 'error' as const,
                            code: 'text_overflow',
                            slide: 1,
                            message: 'Overflow 1',
                        }]
                        : [],
                };
            },
        });
        const sample = await tool.execute({
            ...baseArgs(),
            workflow: { stage: 'sample', mode: 'auto' },
        }, vision);
        assert.equal(sample.success, true, sample.error);
        const designId = (sample.data as { designId: string }).designId;
        reportOverflow = true;

        const final = await tool.execute({
            design_id: designId,
            export_pdf: false,
            workflow: {
                stage: 'final',
                direction_review: {
                    summary: 'Editorial reads clearest for this audience.',
                    selected_direction_id: 'editorial',
                    reviewed_direction_ids: ['executive', 'editorial', 'launch'],
                    scores: [
                        { id: 'executive', total: 4.2 },
                        { id: 'editorial', total: 4.7 },
                        { id: 'launch', total: 4.1 },
                    ],
                },
            },
        }, vision);
        assert.equal(final.success, true, final.error);
        const slides = Array.from(
            { length: (final.data as { slideCount: number }).slideCount },
            (_, index) => index + 1,
        );
        const scorecard = {
            hierarchy: 4.7,
            composition: 4.6,
            typography: 4.5,
            theme: 4.6,
            originality: 4.4,
        };
        const submitReview = (issues: unknown[]) => tool.execute({
            design_id: designId,
            workflow: {
                stage: 'review',
                visual_review: {
                    summary: 'Reviewed every rendered slide.',
                    strengths: ['Consistent palette', 'Readable hierarchy'],
                    overall_score: 4.6,
                    scorecard,
                    reviewed_slide_numbers: slides,
                    slide_scores: slides.map(slide => ({ slide, total: 4.6 })),
                    issues,
                },
            },
        }, vision);

        const first = await submitReview([]);
        assert.equal(first.success, true, first.error);

        // Same render, second pass, two findings the first pass missed. Punishing
        // this made a live run escalate its own warnings and lose the submission.
        const second = await submitReview([
            {
                slide: 2,
                category: 'typography',
                severity: 'error',
                observation: 'The numbering glyphs may fall back to a blank box.',
                action: 'Use plain digits instead.',
            },
            {
                slide: 3,
                category: 'density',
                severity: 'error',
                observation: 'The right rail reads as a wall of text.',
                action: 'Shorten each line to one clause.',
            },
        ]);
        assert.equal(second.success, true, second.error);
        const data = second.data as {
            qa: { status: string; errors: number; issues: Array<{ code: string }> };
            workflowState: { visualReview: { status: string } };
        };
        assert.notEqual(data.qa.status, 'regressed');
        assert.equal(data.qa.issues.some(issue => issue.code === 'qa_regression'), false);
        assert.equal(data.workflowState.visualReview.status, 'complete');
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('revision three fails closed while QA errors remain', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'openflux-presentation-exhausted-'));
    try {
        const tool = createPresentationGenTool({
            getOutputPath: () => root,
            getDesignStorePath: () => join(root, 'design-store'),
            exportPresentation: async () => ({
                slideImages: [],
                issues: [{
                    severity: 'error',
                    code: 'text_overlap',
                    slide: 2,
                    message: 'Two text boxes overlap.',
                }],
            }),
        });
        const result = await tool.execute({
            ...baseArgs(),
            design_id: 'design-quality-exhausted',
            revision: 3,
            workflow: {
                stage: 'revision',
                visual_review: {
                    issues: [{
                        slide: 2,
                        category: 'spacing',
                        observation: 'Two text boxes overlap.',
                        action: 'Reflow the content into separate regions.',
                    }],
                },
            },
            export_pdf: false,
            render_preview: true,
        });
        assert.equal(result.success, false);
        assert.equal(result.code, 'presentation_quality_gate_failed');
        assert.deepEqual((result.data as { files: string[] }).files, []);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('visual revision requires concrete slide-level review evidence', () => {
    const args = baseArgs();
    args.revision = 1;
    args.workflow = { stage: 'revision', design_id: 'design-1' };
    let issues = evaluatePresentationPlan(parsePresentationPlan(args));
    assert.ok(issues.some(issue => issue.code === 'visual_review_required' && issue.severity === 'error'));

    args.workflow = {
        stage: 'revision',
        design_id: 'design-1',
        visual_review: {
            summary: 'The data slide has no clear focal point.',
            issues: [{
                slide: 4,
                severity: 'warning',
                category: 'hierarchy',
                observation: 'All metrics carry the same visual weight.',
                action: 'Promote the primary metric and demote supporting values.',
            }],
        },
    };
    issues = evaluatePresentationPlan(parsePresentationPlan(args));
    assert.ok(!issues.some(issue => issue.code === 'visual_review_required'));

    // A reviewer that inspected every slide and found nothing of its own has still
    // done the work. The machine's QA carries the remaining defect, and refusing
    // the revision here left that defect unfixable.
    args.workflow = {
        stage: 'revision',
        design_id: 'design-1',
        visual_review: {
            summary: 'Every slide reads cleanly.',
            issues: [],
            reviewed_slide_numbers: [1, 2, 3, 4],
        },
    };
    issues = evaluatePresentationPlan(parsePresentationPlan(args));
    assert.ok(!issues.some(issue => issue.code === 'visual_review_required'));
});

test('a clean review does not lock the mechanical repair its deck still needs', () => {
    // The state that deadlocked a real deck: one machine-detected CJK orphan left,
    // and a paperwork complaint standing next to it.
    const withComplaint = presentationMechanicalRepairGuidance([
        {
            severity: 'error',
            code: 'cjk_orphan_line',
            slide: 10,
            message: "Only '未开通' remains on the final rendered line on slide 10 (shape 6).",
        },
        {
            severity: 'error',
            code: 'visual_review_required',
            message: 'A visual revision requires an inspected deck.',
        },
    ], 2);
    assert.equal(withComplaint.allowed, true);
    assert.deepEqual(withComplaint.targetSlides, [10]);

    // A real visual defect still holds the repair shut.
    const withRealBlocker = presentationMechanicalRepairGuidance([
        {
            severity: 'error',
            code: 'cjk_orphan_line',
            slide: 10,
            message: "Only '未开通' remains on the final rendered line on slide 10 (shape 6).",
        },
        {
            severity: 'error',
            code: 'low_text_contrast',
            slide: 4,
            message: 'Body text fails the contrast floor against its background.',
        },
    ], 2);
    assert.equal(withRealBlocker.allowed, false);
    assert.match(withRealBlocker.instruction, /non-mechanical visual or structural errors remain/);
});

test('sample stage renders three representative slides without publishing temporary artifacts', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'openflux-presentation-sample-'));
    try {
        const args = baseArgs();
        args.workflow = { stage: 'sample', mode: 'auto' };
        args.render_preview = true;
        const tool = createPresentationGenTool({
            getOutputPath: () => root,
            getDesignStorePath: () => join(root, 'design-store'),
            exportPresentation: async options => {
                assert.ok(options.previewPath);
                await fs.writeFile(options.previewPath!, Buffer.from(
                    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
                    'base64',
                ));
                return { previewPath: options.previewPath, slideImages: [], issues: [] };
            },
        });
        const result = await tool.execute(args);
        assert.equal(result.success, true, result.error);
        const data = result.data as {
            stage: string;
            files: string[];
            sampleSlideNumbers: number[];
            designId: string;
            nextAction: string;
        };
        assert.equal(data.stage, 'sample');
        assert.deepEqual(data.sampleSlideNumbers, [1, 3, 4]);
        assert.equal(data.files.length, 0);
        assert.ok(data.designId);
        assert.equal(result.images?.length, 1);
        assert.equal((await fs.readdir(root)).some(name => name.startsWith('.openflux-presentation-sample-')), false);

        const final = await tool.execute({
            design_id: data.designId,
            workflow: { stage: 'final' },
            export_pdf: false,
            render_preview: false,
        });
        assert.equal(final.success, true, final.error);
        assert.equal((final.data as { slideCount: number }).slideCount, 5);

        const revision = await tool.execute({
            design_id: data.designId,
            revision: 1,
            workflow: {
                stage: 'revision',
                visual_review: {
                    issues: [{
                        slide: 2,
                        category: 'hierarchy',
                        observation: 'The core claim needs a stronger silhouette.',
                        action: 'Use a banded treatment and increase focal scale.',
                    }],
                },
            },
            slide_patches: [{
                slide: 2,
                changes: { layout: { variant: 'banded', focal_scale: 1.08 } },
            }],
            export_pdf: false,
            render_preview: false,
        });
        assert.equal(revision.success, true, revision.error);
        assert.equal((revision.data as { stage: string }).stage, 'revision');
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('sample structural preflight blocks orphaned content before rendering three directions', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'openflux-presentation-preflight-'));
    let exportCalls = 0;
    try {
        const args = baseArgs();
        args.workflow = { stage: 'sample', mode: 'auto' };
        const slides = args.slides as Array<Record<string, unknown>>;
        slides[1] = {
            purpose: '短提示',
            message: '提示',
            title: '提示（1/2）',
            composition: 'narrative',
            body: '暂无更新',
        };
        const tool = createPresentationGenTool({
            getOutputPath: () => root,
            getDesignStorePath: () => join(root, 'design-store'),
            enforceWorkflow: true,
            exportPresentation: async () => {
                exportCalls += 1;
                return { slideImages: [], issues: [] };
            },
        });
        const result = await tool.execute(args, {
            activeModel: { provider: 'moonshot', model: 'kimi-k3', vision: true },
        });
        assert.equal(result.success, false);
        assert.equal(result.code, 'presentation_structure_preflight_failed');
        assert.equal(exportCalls, 0);
        const data = result.data as { issues: Array<{ code: string; slide: number; sourceSlide: number }> };
        assert.ok(data.issues.some(issue => (
            issue.code === 'orphaned_continuation_page'
            && issue.slide === 2
            && issue.sourceSlide === 2
        )));
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('sample native QA maps sample positions back to durable deck slide numbers', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'openflux-presentation-sample-map-'));
    try {
        const args = baseArgs();
        args.workflow = { stage: 'sample', mode: 'auto' };
        let exportCalls = 0;
        const tool = createPresentationGenTool({
            getOutputPath: () => root,
            getDesignStorePath: () => join(root, 'design-store'),
            enforceWorkflow: true,
            exportPresentation: async options => {
                exportCalls++;
                await fs.writeFile(options.previewPath!, Buffer.from(
                    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
                    'base64',
                ));
                return {
                    previewPath: options.previewPath,
                    slideImages: [],
                    issues: [
                        {
                            severity: 'error',
                            code: 'text_overflow',
                            slide: 2,
                            message: "Text 'mapped sample issue' exceeds its box on slide 2 (shape 4).",
                        },
                        // A mechanical overflow alone no longer blocks the gate, so the
                        // mapping assertions below need a genuinely blocking defect too.
                        {
                            severity: 'error',
                            code: 'image_frame_unresolved',
                            slide: 2,
                            message: 'The hero frame on slide 2 could not be resolved.',
                        },
                    ],
                };
            },
        });
        const result = await tool.execute(args, {
            activeModel: { provider: 'moonshot', model: 'kimi-k3', vision: true },
        });
        assert.equal(result.success, false);
        assert.equal(result.code, 'presentation_direction_quality_gate_failed');
        const data = result.data as {
            designId: string;
            blockingIssues: Array<{ code: string }>;
            advisoryIssues: Array<{ code: string }>;
            directions: Array<{ issues: Array<{ code: string; slide: number; sourceSlide: number; message: string }> }>;
        };
        assert.equal(exportCalls, 3);
        for (const direction of data.directions) {
            const issue = direction.issues.find(item => item.code === 'text_overflow');
            assert.equal(issue?.slide, 3);
            assert.equal(issue?.sourceSlide, 3);
            assert.match(issue?.message || '', /deck slide 3/);
        }
        // The overflow is reported, but not as something this stage must clear: no
        // allowed patch path can shorten copy in a protected fact channel.
        assert.deepEqual(data.blockingIssues.map(issue => issue.code), ['image_frame_unresolved']);
        assert.equal(data.advisoryIssues.some(issue => issue.code === 'text_overflow'), true);

        const retry = await tool.execute({
            design_id: data.designId,
            workflow: { stage: 'sample', mode: 'auto', design_id: data.designId },
            slide_patches: [{ slide: 3, changes: { layout: { variant: 'stacked' } } }],
        }, {
            activeModel: { provider: 'moonshot', model: 'kimi-k3', vision: true },
        });
        assert.equal(retry.success, false);
        assert.equal(retry.code, 'presentation_direction_quality_gate_failed');
        assert.equal((retry.data as { directions: unknown[] }).directions.length, 1);
        assert.equal(exportCalls, 4);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('a mechanical text overflow alone does not block sample direction selection', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'openflux-presentation-sample-overflow-'));
    try {
        const png = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
            'base64',
        );
        const tool = createPresentationGenTool({
            getOutputPath: () => root,
            getDesignStorePath: () => join(root, 'design-store'),
            enforceWorkflow: true,
            exportPresentation: async options => {
                if (options.previewPath) await fs.writeFile(options.previewPath, png);
                return {
                    previewPath: options.previewPath,
                    reviewSheetPaths: options.previewPath ? [options.previewPath] : [],
                    slideImages: [],
                    // The overflowing copy sits in a protected fact channel, so the only
                    // physical repair — shortening it — is forbidden at this stage. A live
                    // run burned every retry being told to fix what it could not touch.
                    issues: [{
                        severity: 'error' as const,
                        code: 'text_overflow',
                        slide: 2,
                        message: "Text 'far too long to fit' exceeds its box on slide 2.",
                    }],
                };
            },
        });
        const sample = await tool.execute({
            ...baseArgs(),
            workflow: { stage: 'sample', mode: 'auto' },
        }, { activeModel: { provider: 'moonshot', model: 'kimi-k3', vision: true } });
        assert.equal(sample.success, true, sample.error);
        assert.equal((sample.data as { directions: unknown[] }).directions.length, 3);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('a repaired sample returns one direction and final review accepts that one direction', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'openflux-presentation-single-repair-'));
    try {
        const png = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
            'base64',
        );
        let exportCalls = 0;
        const tool = createPresentationGenTool({
            getOutputPath: () => root,
            getDesignStorePath: () => join(root, 'design-store'),
            enforceWorkflow: true,
            exportPresentation: async options => {
                exportCalls++;
                if (options.previewPath) await fs.writeFile(options.previewPath, png);
                return {
                    previewPath: options.previewPath,
                    reviewSheetPaths: options.previewPath ? [options.previewPath] : [],
                    slideImages: [],
                    issues: exportCalls <= 3 ? [{
                        severity: 'error' as const,
                        code: 'image_frame_unresolved',
                        slide: 2,
                        message: 'The hero frame on slide 2 could not be resolved.',
                    }] : [],
                };
            },
        });
        const initial = await tool.execute({
            ...baseArgs(),
            workflow: { stage: 'sample', mode: 'auto' },
        }, { activeModel: { provider: 'moonshot', model: 'kimi-k3', vision: true } });
        assert.equal(initial.success, false);
        const designId = (initial.data as { designId: string }).designId;

        const repair = await tool.execute({
            design_id: designId,
            workflow: { stage: 'sample', mode: 'auto', design_id: designId },
            slide_patches: [{ slide: 3, changes: { layout: { variant: 'stacked' } } }],
        }, { activeModel: { provider: 'moonshot', model: 'kimi-k3', vision: true } });
        assert.equal(repair.success, true, repair.error);
        const directions = (repair.data as { directions: Array<{ id: string }> }).directions;
        assert.equal(directions.length, 1);

        const selected = directions[0].id;
        const final = await tool.execute({
            design_id: designId,
            workflow: {
                stage: 'final',
                direction_review: {
                    summary: 'The repaired direction is mechanically clean.',
                    selected_direction_id: selected,
                    reviewed_direction_ids: [selected],
                    scores: [{ id: selected, total: 4.5 }],
                },
            },
            export_pdf: false,
        }, { activeModel: { provider: 'moonshot', model: 'kimi-k3', vision: true } });
        assert.equal(final.success, true, final.error);
        assert.equal((final.data as { stage: string }).stage, 'visual_review');
        assert.equal(exportCalls, 5);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('durable workflow rejects full generation before its design proof', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'openflux-presentation-transition-'));
    try {
        const tool = createPresentationGenTool({
            getOutputPath: () => root,
            getDesignStorePath: () => join(root, 'design-store'),
            enforceWorkflow: true,
        });
        const result = await tool.execute({
            ...baseArgs(),
            workflow: { stage: 'final', mode: 'auto' },
        });
        assert.equal(result.success, false);
        assert.equal(result.code, 'presentation_workflow_transition_invalid');
        assert.deepEqual((result.data as { files: string[] }).files, []);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('durable workflow keeps visual review on the active Flux model route', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'openflux-presentation-completion-'));
    try {
        const png = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
            'base64',
        );
        const tool = createPresentationGenTool({
            getOutputPath: () => root,
            getDesignStorePath: () => join(root, 'design-store'),
            enforceWorkflow: true,
            exportPresentation: async options => {
                if (options.previewPath) await fs.writeFile(options.previewPath, png);
                return {
                    previewPath: options.previewPath,
                    reviewSheetPaths: options.previewPath ? [options.previewPath] : [],
                    slideImages: [],
                    issues: [],
                };
            },
        });
        const sample = await tool.execute({
            ...baseArgs(),
            workflow: { stage: 'sample', mode: 'auto' },
        }, { activeModel: { provider: 'moonshot', model: 'kimi-k3', vision: true } });
        assert.equal(sample.success, true, sample.error);
        const sampleData = sample.data as {
            designId: string;
            selectedDirection?: string;
            directions: Array<{ id: string }>;
            completion: { complete: boolean };
        };
        assert.equal(sampleData.completion.complete, false);
        assert.equal(sampleData.selectedDirection, undefined);
        assert.deepEqual(sampleData.directions.map(item => item.id).sort(), ['editorial', 'executive', 'launch']);
        assert.equal(sample.images?.length, 3);

        const final = await tool.execute({
            design_id: sampleData.designId,
            workflow: {
                stage: 'final',
                direction_review: {
                    summary: 'Editorial is the clearest direction for this audience.',
                    selected_direction_id: 'editorial',
                    reviewed_direction_ids: ['executive', 'editorial', 'launch'],
                    scores: [
                        { id: 'executive', total: 4.2 },
                        { id: 'editorial', total: 4.7 },
                        { id: 'launch', total: 4.1 },
                    ],
                },
            },
            export_pdf: false,
        }, { activeModel: { provider: 'moonshot', model: 'kimi-k3', vision: true } });
        assert.equal(final.success, true, final.error);
        const finalData = final.data as {
            files: string[];
            stage: string;
            designId: string;
            completion: { complete: boolean; files: string[] };
        };
        assert.equal(finalData.stage, 'visual_review');
        assert.equal(finalData.completion.complete, false);
        assert.deepEqual(finalData.files, []);
        assert.ok(final.images?.length);

        const reviewedSlides = Array.from({ length: 5 }, (_, index) => index + 1);
        const incompleteReview = await tool.execute({
            design_id: finalData.designId,
            workflow: {
                stage: 'review',
                visual_review: {
                    summary: 'Mechanical cleanliness alone is not an aesthetic review.',
                    overall_score: 4.8,
                    reviewed_slide_numbers: reviewedSlides,
                    slide_scores: reviewedSlides.map(slide => ({ slide, total: 4.8 })),
                    issues: [],
                },
            },
        }, { activeModel: { provider: 'moonshot', model: 'kimi-k3', vision: true } });
        assert.equal(incompleteReview.success, false);
        assert.match(incompleteReview.error || '', /five-part aesthetic scorecard/);

        const review = await tool.execute({
            design_id: finalData.designId,
            workflow: {
                stage: 'review',
                visual_review: {
                    summary: 'The rendered deck is ready for delivery.',
                    strengths: ['Strong hierarchy', 'Consistent design language'],
                    overall_score: 4.6,
                    scorecard: {
                        hierarchy: 4.7,
                        composition: 4.6,
                        typography: 4.5,
                        theme: 4.6,
                        originality: 4.4,
                    },
                    reviewed_slide_numbers: reviewedSlides,
                    slide_scores: reviewedSlides.map(slide => ({ slide, total: 4.6 })),
                    issues: [],
                },
            },
        }, { activeModel: { provider: 'moonshot', model: 'kimi-k3', vision: true } });
        assert.equal(review.success, true, review.error);
        const reviewed = review.data as {
            files: string[];
            stage: string;
            completion: { complete: boolean; files: string[] };
            reviewer: string;
        };
        assert.equal(reviewed.stage, 'completed');
        assert.equal(reviewed.completion.complete, true);
        assert.equal(reviewed.reviewer, 'moonshot/kimi-k3');
        assert.equal(reviewed.files.length, 1);
        assert.equal(reviewed.files[0], reviewed.completion.files[0]);
        assert.ok((await fs.stat(reviewed.files[0])).size > 0);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('durable workflow fails closed when the active Flux model is text-only', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'openflux-presentation-no-vision-'));
    try {
        const tool = createPresentationGenTool({
            getOutputPath: () => root,
            getDesignStorePath: () => join(root, 'design-store'),
            enforceWorkflow: true,
        });
        const result = await tool.execute({
            ...baseArgs(),
            workflow: { stage: 'sample', mode: 'auto' },
        }, { activeModel: { provider: 'deepseek', model: 'deepseek-chat', vision: false } });
        assert.equal(result.success, false);
        assert.equal(result.code, 'presentation_visual_review_unavailable');
        const data = result.data as {
            files: string[];
            designId: string;
            designPersisted: boolean;
            nextAction: string;
        };
        assert.deepEqual(data.files, []);
        assert.equal(data.designPersisted, true);
        assert.equal(data.nextAction, 'restart_runtime_and_resume_same_design_with_vision_capable_active_model');
        const stored = await loadPresentationDesign(root, data.designId, join(root, 'design-store'));
        assert.ok(stored, 'the rejected initial sample must still own a resumable durable design');
        assert.equal((stored?.__workflow_state as { designId?: string })?.designId, data.designId);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('visual reference inspection feeds normalized local images back to the model', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'openflux-presentation-reference-'));
    try {
        const imagePath = join(root, 'reference.png');
        await fs.writeFile(imagePath, Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
            'base64',
        ));
        const result = await createPresentationReferenceTool({ getOutputPath: () => root }).execute({
            paths: [imagePath],
            pages_per_file: 2,
        });
        assert.equal(result.success, true, result.error);
        assert.equal(result.images?.length, 1);
        assert.match(result.images?.[0].description || '', /design principles|visual relationships/i);
        const data = result.data as { inspected: Array<{ path: string; pages: number }>; files: string[] };
        assert.equal(data.inspected[0].path, imagePath);
        assert.equal(data.inspected[0].pages, 1);
        assert.deepEqual(data.files, []);
        assert.equal((await fs.readdir(root)).some(name => name.startsWith('.openflux-presentation-references-')), false);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('data composition can render a native editable chart', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'openflux-presentation-chart-'));
    try {
        const args = baseArgs();
        args.slides = [
            (args.slides as unknown[])[0],
            {
                purpose: '用可比较的数据支持结论',
                message: '活跃工作持续增长',
                composition: 'data',
                body: '三个季度保持稳定增长。',
                chart: {
                    type: 'column',
                    name: '活跃 Project',
                    labels: ['Q1', 'Q2', 'Q3'],
                    values: [28, 43, 61],
                },
            },
        ];
        args.filename = 'chart.pptx';
        const result = await createPresentationGenTool({ getOutputPath: () => root }).execute(args);
        assert.equal(result.success, true, result.error);
        const pptx = (result.data as { pptx: string }).pptx;
        const zip = await JSZip.loadAsync(await fs.readFile(pptx));
        const chartPath = Object.keys(zip.files).find(name => /^ppt\/charts\/chart\d+\.xml$/.test(name));
        assert.ok(chartPath);
        const chartXml = await zip.file(chartPath!)!.async('string');
        const textColor = String((args.art_direction as Record<string, any>).palette.text);
        const mutedColor = String((args.art_direction as Record<string, any>).palette.muted);
        assert.match(chartXml, new RegExp(`<a:srgbClr val="${textColor}"`));
        assert.match(chartXml, new RegExp(`<a:srgbClr val="${mutedColor}"`));
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('centered closing slides render up to three decision actions', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'openflux-presentation-closing-actions-'));
    try {
        const args = baseArgs();
        args.slides = [{
            purpose: 'Request the final committee decision',
            message: 'Approve the controlled migration start',
            title: '管委会决策',
            composition: 'closing',
            bullets: ['批准20周路线', '确认五道切换门禁', '核准峰值资源调度'],
            layout: { archetype: 'closing', variant: 'centered' },
        }];
        args.filename = 'closing-actions.pptx';
        const plan = parsePresentationPlan(args);
        assert.equal(plan.slides[0].resolvedLayout.silhouette, 'closing-centered');
        const result = await createPresentationGenTool({ getOutputPath: () => root }).execute(args);
        assert.equal(result.success, true, result.error);
        const pptx = (result.data as { pptx: string }).pptx;
        const zip = await JSZip.loadAsync(await fs.readFile(pptx));
        const slideXml = await zip.file('ppt/slides/slide1.xml')!.async('string');
        assert.match(slideXml, /批准20周路线/);
        assert.match(slideXml, /确认五道切换门禁/);
        assert.match(slideXml, /核准峰值资源调度/);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('treemap normalization accepts sizes as an area-value alias', () => {
    const args = baseArgs();
    args.slides = [{
        purpose: 'Show the weighted customer mix',
        message: 'Enterprise customers form the largest segment',
        composition: 'data',
        chart: {
            type: 'treemap',
            labels: ['Enterprise', 'Team', 'Professional', 'Basic'],
            sizes: [46, 31, 15, 8],
            parents: ['', '', '', ''],
        },
    }];
    const plan = parsePresentationPlan(args);
    assert.equal(plan.slides[0].chart?.type, 'treemap');
    assert.deepEqual(plan.slides[0].chart?.values, [46, 31, 15, 8]);
});

test('all eighteen chart relationships survive presentation normalization', () => {
    const simple = { labels: ['A', 'B', 'C'], values: [12, 8, 5] };
    const multi = {
        labels: ['Q1', 'Q2', 'Q3'],
        series: [
            { name: 'Plan', values: [8, 11, 14] },
            { name: 'Actual', values: [7, 12, 16] },
        ],
    };
    const relationships: Record<string, Record<string, unknown>> = {
        bar: simple,
        column: simple,
        line: simple,
        pie: simple,
        'stacked-bar': multi,
        'stacked-column': multi,
        area: simple,
        doughnut: simple,
        combo: multi,
        waterfall: { labels: ['Base', 'Growth', 'Cost'], values: [20, 8, -5] },
        scatter: { labels: ['A', 'B', 'C'], x_values: [1, 2, 4], values: [3, 5, 8] },
        bubble: { labels: ['A', 'B', 'C'], x_values: [1, 2, 4], values: [3, 5, 8], sizes: [4, 9, 16] },
        radar: simple,
        histogram: { labels: ['0–10', '10–20', '20–30'], values: [3, 9, 4] },
        heatmap: { matrix: [[1, 2, 3], [3, 5, 8]], row_labels: ['R1', 'R2'], column_labels: ['C1', 'C2', 'C3'] },
        treemap: simple,
        funnel: simple,
        gantt: { labels: ['Plan', 'Build', 'Verify'], start_values: [0, 2, 5], values: [2, 3, 2] },
    };
    assert.equal(PRESENTATION_CHART_TYPES.length, 18);
    for (const type of PRESENTATION_CHART_TYPES) {
        const args = baseArgs();
        args.slides = [{
            purpose: `Render ${type}`,
            message: `${type} expresses its intended data relationship`,
            composition: 'data',
            chart: { type, ...relationships[type] },
        }];
        assert.equal(parsePresentationPlan(args).slides[0].chart?.type, type, type);
    }
});

test('semantic status, ranking, timeline, event, and source silhouettes all render', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'openflux-presentation-semantics-'));
    try {
        const args = baseArgs();
        (args.brief as Record<string, unknown>).delivery_mode = 'report';
        args.slides = [
            { purpose: 'Open the report', message: 'One grammar, many information structures', composition: 'focal' },
            { purpose: 'Show status', message: 'Three signals describe current health', information_role: 'status', metrics: [{ value: '94%', label: 'Ready' }, { value: '3', label: 'Risks' }, { value: '8d', label: 'Runway' }] },
            { purpose: 'Rank evidence', message: 'The priorities are ordered by impact', information_role: 'ranking', chart: { type: 'bar', labels: ['A', 'B', 'C'], values: [9, 6, 3] } },
            { purpose: 'Show milestones', message: 'Four milestones define the path', information_role: 'timeline', steps: [{ title: 'Frame' }, { title: 'Build' }, { title: 'Verify' }, { title: 'Release' }] },
            { purpose: 'List peer events', message: 'Eight records remain readable together', information_role: 'events', items: Array.from({ length: 8 }, (_, index) => ({ title: `Event ${index + 1}`, description: 'Owner confirmed' })) },
            { purpose: 'Index the sources', message: 'Evidence remains traceable', information_role: 'sources', items: Array.from({ length: 8 }, (_, index) => ({ title: `Source ${index + 1}`, description: 'Primary evidence' })) },
            { purpose: 'Close with action', message: 'Approve the next controlled step', information_role: 'action', composition: 'closing' },
        ];
        args.filename = 'semantic-silhouettes.pptx';
        const result = await createPresentationGenTool({ getOutputPath: () => root }).execute(args);
        assert.equal(result.success, true, result.error);
        const data = result.data as { pptx: string; layouts: string[]; qa: { errors: number } };
        assert.equal(data.qa.errors, 0);
        for (const silhouette of ['status-dashboard', 'ranking-bars', 'milestone-timeline', 'event-ledger', 'source-index']) {
            assert.ok(data.layouts.some(layout => layout.includes(silhouette)), silhouette);
        }
        assert.ok((await fs.stat(data.pptx)).size > 10_000);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('rendered slide activity is part of the main delivery quality gate', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'openflux-presentation-rendered-gate-'));
    try {
        const blank = join(root, 'blank.png');
        await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#111827' } }).png().toFile(blank);
        const args = baseArgs();
        (args.brief as Record<string, unknown>).delivery_mode = 'report';
        args.slides = [{
            purpose: 'Continue a split explanation',
            message: 'Operating overview (2/2)',
            composition: 'narrative',
            bullets: ['A single residual fact'],
        }];
        args.render_preview = true;
        const result = await createPresentationGenTool({
            getOutputPath: () => root,
            exportPresentation: async () => ({ slideImages: [blank], issues: [] }),
        }).execute(args);
        assert.equal(result.success, true, result.error);
        const data = result.data as {
            files: string[];
            renderedQa: { available: boolean; issues: Array<{ code: string }> };
            qa: { errors: number; deliveryBlocked: boolean };
        };
        assert.equal(data.renderedQa.available, true);
        assert.ok(data.renderedQa.issues.some(issue => issue.code === 'rendered_orphaned_continuation'));
        assert.ok(data.qa.errors >= 1);
        assert.equal(data.qa.deliveryBlocked, true);
        assert.deepEqual(data.files, []);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('bounded narrative rails preserve visible copy across structured renderers', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'openflux-presentation-rails-'));
    try {
        const args = baseArgs();
        (args.brief as Record<string, unknown>).delivery_mode = 'report';
        args.slides = [
            {
                purpose: 'Metrics with interpretation',
                message: 'Metrics keep their short interpretation',
                bullets: ['metric-insight-one', 'metric-insight-two'],
                metrics: [
                    { value: '71', label: 'Alpha' },
                    { value: '29', label: 'Beta' },
                ],
            },
            {
                purpose: 'Chart with interpretation',
                message: 'Charts keep their short interpretation',
                body: 'chart-context-copy',
                bullets: ['chart-insight-one', 'chart-insight-two'],
                chart: { type: 'bar', labels: ['A', 'B'], values: [7, 4] },
            },
            {
                purpose: 'Comparison with interpretation',
                message: 'Comparisons keep their short interpretation',
                bullets: ['comparison-insight-one', 'comparison-insight-two'],
                comparison: {
                    left: { heading: 'Before', items: ['A', 'B'] },
                    right: { heading: 'After', items: ['C', 'D'] },
                },
            },
            {
                purpose: 'Process with interpretation',
                message: 'Processes keep their short interpretation',
                body: 'process-context-copy',
                bullets: ['process-insight-one'],
                steps: [{ title: 'Start' }, { title: 'Finish' }],
            },
            {
                purpose: 'Events with interpretation',
                message: 'Event records keep their short interpretation',
                information_role: 'events',
                bullets: ['events-insight-one'],
                items: Array.from({ length: 4 }, (_, index) => ({ title: `Event ${index + 1}` })),
            },
        ];
        args.filename = 'rails.pptx';
        const result = await createPresentationGenTool({ getOutputPath: () => root }).execute(args);
        assert.equal(result.success, true, result.error);
        const zip = await JSZip.loadAsync(await fs.readFile((result.data as { pptx: string }).pptx));
        const xml = (await Promise.all(Object.keys(zip.files)
            .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
            .map(name => zip.file(name)!.async('string')))).join('\n');
        for (const expected of [
            'metric-insight-one', 'chart-context-copy', 'chart-insight-one',
            'comparison-insight-one', 'process-context-copy', 'process-insight-one', 'events-insight-one',
        ]) {
            assert.match(xml, new RegExp(expected));
        }
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('presentation images are verified and rasterized before PptxGenJS sees them', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'openflux-presentation-image-'));
    try {
        const pngPath = join(root, 'visual.png');
        await fs.writeFile(pngPath, Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
            'base64',
        ));
        const args = baseArgs();
        args.slides = [
            (args.slides as unknown[])[0],
            {
                purpose: '用经过验证的图片加强记忆',
                message: '图片经过安全解码后再进入演示文稿',
                composition: 'split',
                image_path: 'visual.png',
                body: '输入图片不会直接交给底层格式解析器。',
            },
        ];
        args.filename = 'image.pptx';
        const tool = createPresentationGenTool({ getOutputPath: () => root });
        const result = await tool.execute(args);
        assert.equal(result.success, true, result.error);
        assert.equal((await fs.readdir(root)).some(name => name.startsWith('.openflux-presentation-assets-')), false);

        const unsafePath = join(root, 'unsafe.icns');
        await fs.writeFile(unsafePath, Buffer.from('not-an-image'));
        const unsafeArgs = baseArgs();
        unsafeArgs.slides = [{
            purpose: '验证不受支持的图片格式',
            message: '不允许高风险图片解析器',
            composition: 'split',
            image_path: 'unsafe.icns',
        }];
        unsafeArgs.filename = 'unsafe.pptx';
        const unsafe = await tool.execute(unsafeArgs);
        assert.equal(unsafe.success, false);
        assert.match(unsafe.error || '', /not a supported presentation image|format is not allowed/);
        assert.equal((await fs.readdir(root)).some(name => name.startsWith('.openflux-presentation-assets-')), false);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('presentation photos are physically cropped to the image frame before PPTX embedding', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'openflux-presentation-aspect-'));
    try {
        const source = join(root, 'wide-photo.png');
        await sharp({
            create: { width: 4000, height: 1000, channels: 3, background: '#cc3333' },
        }).png().toFile(source);
        const args = baseArgs();
        args.slides = [{
            purpose: 'Use a photograph as visual evidence',
            message: 'The photograph fills its frame without distortion',
            composition: 'split',
            image_path: 'wide-photo.png',
            image_kind: 'photo',
            image_fit: 'cover',
            image_focus: { x: 0.8, y: 0.5 },
        }];
        args.filename = 'aspect-safe.pptx';
        const result = await createPresentationGenTool({ getOutputPath: () => root }).execute(args);
        assert.equal(result.success, true, result.error);
        const data = result.data as {
            pptx: string;
            layouts: string[];
            imageQa: { available: boolean; checkedImages: number; issues: Array<{ code: string }> };
        };
        assert.equal(data.imageQa.available, true);
        assert.equal(data.imageQa.checkedImages, 1);
        assert.ok(!data.imageQa.issues.some(issue => issue.code === 'image_aspect_ratio_mismatch'));

        const zip = await JSZip.loadAsync(await fs.readFile(data.pptx));
        const mediaPath = Object.keys(zip.files).find(path => /^ppt\/media\/image-1-\d+\.png$/i.test(path));
        assert.ok(mediaPath);
        const metadata = await sharp(await zip.file(mediaPath!)!.async('nodebuffer')).metadata();
        assert.ok(metadata.width && metadata.height);
        assert.ok(data.layouts[0].includes('image-panorama'));
        assert.ok((metadata.width! / metadata.height!) > 3.4);
        assert.ok((metadata.width! / metadata.height!) < 3.6);
        const slideXml = await zip.file('ppt/slides/slide1.xml')!.async('string');
        assert.doesNotMatch(slideXml, /<a:srcRect\b/);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('full-bleed images do not receive an out-of-canvas decorative frame', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'openflux-presentation-full-bleed-'));
    try {
        const source = join(root, 'background.png');
        await sharp({
            create: { width: 2400, height: 1350, channels: 3, background: '#16324f' },
        }).png().toFile(source);
        const args = baseArgs();
        (args.art_direction as Record<string, unknown>).image_treatment = 'framed';
        args.slides = [{
            purpose: 'Open with an immersive supplied visual',
            message: 'The image reaches the canvas edge without a frame outside it',
            title: 'Full-bleed visual',
            composition: 'focal',
            image_path: source,
            image_kind: 'background',
            image_fit: 'cover',
            layout: { archetype: 'cover', variant: 'full-bleed', emphasis: 'visual' },
        }];
        args.filename = 'full-bleed.pptx';
        const result = await createPresentationGenTool({ getOutputPath: () => root }).execute(args);
        assert.equal(result.success, true, result.error);
        const zip = await JSZip.loadAsync(await fs.readFile((result.data as { pptx: string }).pptx));
        const slideXml = await zip.file('ppt/slides/slide1.xml')!.async('string');
        assert.doesNotMatch(slideXml, /<a:off x="-\d+" y="-\d+"\/>/);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('vector logos are rasterized at the target frame without bitmap PPI failures', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'openflux-presentation-svg-logo-'));
    try {
        const source = join(root, 'mark.svg');
        await fs.writeFile(source, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="4" fill="#2255ee"/><circle cx="12" cy="12" r="6" fill="white"/></svg>');
        const args = baseArgs();
        args.slides = [{
            purpose: 'Validate a vector brand mark',
            message: 'The mark remains crisp and complete',
            body: 'Vector coordinates are not interpreted as source pixels.',
            composition: 'split',
            image_path: source,
            image_kind: 'logo',
            image_fit: 'contain',
            layout: { archetype: 'image', emphasis: 'visual' },
        }];
        args.filename = 'svg-logo.pptx';
        const result = await createPresentationGenTool({ getOutputPath: () => root }).execute(args);
        assert.equal(result.success, true, result.error);
        const data = result.data as {
            imageQa: { issues: Array<{ code: string }> };
        };
        assert.ok(!data.imageQa.issues.some(issue => issue.code === 'image_resolution_too_low' || issue.code === 'image_resolution_low'));
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('external user imagery is staged, masked, sourced, and embedded without distortion', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'openflux-presentation-user-image-output-'));
    const sourceRoot = await fs.mkdtemp(join(tmpdir(), 'openflux-presentation-user-image-source-'));
    try {
        const source = join(sourceRoot, 'portrait.png');
        await sharp({
            create: { width: 1200, height: 1800, channels: 3, background: '#2f6fed' },
        }).png().toFile(source);
        const args = baseArgs();
        args.slides = [
            (args.slides as unknown[])[0],
            {
                purpose: 'Use the supplied portrait as primary visual evidence',
                message: 'The supplied subject is framed without stretching',
                composition: 'split',
                image_path: source,
                image_alt: 'User-provided portrait used for presentation validation',
                image_kind: 'photo',
                image_fit: 'cover',
                image_focus: { x: 0.5, y: 0.35 },
                image_mask: 'circle',
                image_source_url: 'User-provided asset',
                image_credit: 'Provided by the user',
            },
        ];
        args.filename = 'user-image-mask.pptx';
        const result = await createPresentationGenTool({ getOutputPath: () => root }).execute(args);
        assert.equal(result.success, true, result.error);
        const data = result.data as {
            pptx: string;
            imageQa: { available: boolean; checkedImages: number; issues: Array<{ code: string }> };
        };
        assert.equal(data.imageQa.available, true);
        assert.equal(data.imageQa.checkedImages, 1);
        assert.ok(!data.imageQa.issues.some(issue => issue.code === 'image_aspect_ratio_mismatch'));

        const cacheFiles = await fs.readdir(join(root, '.openflux-presentation-source-assets'));
        assert.equal(cacheFiles.length, 1);

        const zip = await JSZip.loadAsync(await fs.readFile(data.pptx));
        const mediaPaths = Object.keys(zip.files).filter(path => /^ppt\/media\/image-\d+-\d+\.png$/i.test(path));
        const maskedMedia = await Promise.all(mediaPaths.map(async path => ({
            path,
            buffer: await zip.file(path)!.async('nodebuffer'),
        })));
        const masked = (await Promise.all(maskedMedia.map(async item => ({
            ...item,
            metadata: await sharp(item.buffer).metadata(),
        })))).find(item => item.metadata.hasAlpha);
        assert.ok(masked, 'expected an embedded transparent masked image');
        assert.ok(masked!.metadata.width && masked!.metadata.height);
        assert.ok(Math.abs(masked!.metadata.width! / masked!.metadata.height! - 1) < 0.02);
        const raw = await sharp(masked!.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        assert.equal(raw.data[3], 0, 'circle mask should make the top-left corner transparent');

        const notes = (await Promise.all(Object.keys(zip.files)
            .filter(path => /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(path))
            .map(path => zip.file(path)!.async('string')))).join('\n');
        assert.match(notes, /User-provided asset/);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
        await fs.rm(sourceRoot, { recursive: true, force: true });
    }
});

test('an already stopped turn does not start presentation generation', async () => {
    const controller = new AbortController();
    controller.abort(new Error('user stopped'));
    await assert.rejects(
        () => createPresentationGenTool().execute(baseArgs(), { abortSignal: controller.signal }),
        (error: Error) => error.name === 'AbortError' && /user stopped/.test(error.message),
    );
});

test('a measured overflow reports how much copy has to go', () => {
    const guidance = describeTextOverflowRepair({
        boundHeight: 112,
        availableHeight: 81,
        lineCount: 7,
        textLength: 78,
    });
    assert.ok(guidance, 'a measured overflow must yield a trim target');
    // 81/112 of the copy fits, so ~28% has to go; the margin overshoots that
    // to 25 of 78 characters so one edit clears the box instead of landing on it.
    assert.match(guidance, /38% taller than its box \(112pt of text in 81pt\)/);
    assert.match(guidance, /wrapped onto 7 lines in a box that holds about 5/);
    assert.match(guidance, /Cut about 25 of its 78 characters, down to roughly 53/);
    assert.match(guidance, /same number of entries in the same channel/);
});

test('a stranded line tail is offered both ways out, not just the shorter one', () => {
    // Slide 10 of a real deck: "2026年，AI全面融入数字经济" at 54pt wrapped as
    // "2026年，AI全面融入数字" / "经济". The model shortened this run four times
    // and the tail never left, because every trim landed just past one line.
    const guidance = describeCjkLineRepair({
        lineCount: 2,
        firstLineChars: 14,
        lastLineChars: 2,
        textLength: 16,
    });
    assert.ok(guidance, 'a measured wrap must yield a target');
    assert.match(guidance, /fits about 14 characters per line/);
    assert.match(guidance, /2 of 16 landed on line 2/);
    // Cutting to one line means clearing the measured capacity with a character
    // of headroom, not merely trimming the visible tail.
    assert.match(guidance, /cut about 3 of its 16 characters, down to roughly 13/);
    assert.match(guidance, /lengthen it by about 2 characters so the last line carries at least 4/);
    // The trap this deck fell into has to be named, or shortening stays the
    // obvious move and strands a fresh tail every revision.
    assert.match(guidance, /only partway strands the tail again/);
});

test('a tail long enough to look deliberate is not padded further', () => {
    // The comfortable two-line wrap the model discarded one revision earlier.
    const guidance = describeCjkLineRepair({
        lineCount: 2,
        firstLineChars: 13,
        lastLineChars: 6,
        textLength: 19,
    });
    assert.ok(guidance);
    assert.match(guidance, /cut about 7 of its 19 characters/);
    assert.doesNotMatch(guidance, /lengthen/);
});

test('an unmeasurable wrap keeps the message the renderer wrote', () => {
    const bare = {
        severity: 'warning' as const,
        code: 'cjk_orphan_line',
        slide: 10,
        message: "Only '经济' remains on the final rendered line on slide 10 (shape 7).",
    };
    assert.equal(withCjkLineRepairGuidance(bare).message, bare.message);
    // A single line cannot strand anything, and a run no longer than one line
    // cannot support a cut target.
    assert.equal(describeCjkLineRepair({ lineCount: 1, firstLineChars: 8, lastLineChars: 8, textLength: 8 }), undefined);
    assert.equal(describeCjkLineRepair({ lineCount: 2, firstLineChars: 20, lastLineChars: 2, textLength: 20 }), undefined);
});

test('line-start punctuation gets the same wrap targets', () => {
    const enriched = withCjkLineRepairGuidance({
        severity: 'error',
        code: 'cjk_line_start_punctuation',
        slide: 4,
        message: "CJK punctuation starts a rendered line on slide 4 (shape 3): '，成熟之年'.",
        cjkLine: { lineCount: 2, firstLineChars: 12, lastLineChars: 5, textLength: 17 },
    });
    assert.match(enriched.message, /punctuation starts a rendered line/);
    assert.match(enriched.message, /fits about 12 characters per line/);
});

test('a stranded tail is repaired alongside a blocker but never buys a revision', () => {
    // Reported as a warning, so a finished deck is no longer withheld over two
    // characters. It must still ride along when a repair is happening anyway.
    const alone = presentationMechanicalRepairGuidance([
        {
            severity: 'warning',
            code: 'cjk_orphan_line',
            slide: 10,
            message: "Only '经济' remains on the final rendered line on slide 10 (shape 7).",
        },
    ], 2);
    assert.equal(alone.allowed, false, 'a cosmetic warning must not open the reserved revision');

    const alongsideBlocker = presentationMechanicalRepairGuidance([
        {
            severity: 'error',
            code: 'text_overflow',
            slide: 3,
            message: 'Text exceeds its box on slide 3 (shape 5).',
        },
        {
            severity: 'warning',
            code: 'cjk_orphan_line',
            slide: 10,
            message: "Only '经济' remains on the final rendered line on slide 10 (shape 7).",
        },
    ], 2);
    assert.equal(alongsideBlocker.allowed, true);
    assert.deepEqual(alongsideBlocker.targetSlides, [3, 10]);
});

test('overflow guidance is appended to the finding the renderer reported', () => {
    const enriched = withTextOverflowRepairGuidance({
        severity: 'error',
        code: 'text_overflow',
        slide: 3,
        message: "Text 'Quarterly revenue grew' exceeds its box on slide 3 (shape 5).",
        overflow: { boundHeight: 200, availableHeight: 100, lineCount: 8, textLength: 100 },
    });
    assert.match(enriched.message, /exceeds its box on slide 3 \(shape 5\)\./);
    assert.match(enriched.message, /100% taller than its box/);
    assert.match(enriched.message, /Cut about 58 of its 100 characters/);
});

test('an unmeasurable overflow keeps the message the renderer wrote', () => {
    const unmeasured = {
        severity: 'error' as const,
        code: 'text_overflow',
        slide: 3,
        message: 'Text exceeds its box on slide 3 (shape 5).',
    };
    assert.equal(withTextOverflowRepairGuidance(unmeasured).message, unmeasured.message);
    // A run that reports no overshoot cannot support a trim target, so the
    // caller must not be handed a fabricated one.
    assert.equal(
        describeTextOverflowRepair({
            boundHeight: 80,
            availableHeight: 100,
            lineCount: 3,
            textLength: 40,
        }),
        undefined,
    );
    assert.equal(
        describeTextOverflowRepair({
            boundHeight: 120,
            availableHeight: 100,
            lineCount: 1,
            textLength: 1,
        }),
        undefined,
    );
});

test('a single-line overflow omits the wrap detail it could not measure', () => {
    const guidance = describeTextOverflowRepair({
        boundHeight: 60,
        availableHeight: 40,
        lineCount: 0,
        textLength: 30,
    });
    assert.ok(guidance);
    assert.doesNotMatch(guidance, /wrapped onto/);
    assert.match(guidance, /Cut about 12 of its 30 characters/);
});

test('other quality codes are left exactly as reported', () => {
    const overlap = {
        severity: 'error' as const,
        code: 'text_overlap',
        slide: 2,
        message: 'Two text boxes overlap on slide 2.',
    };
    assert.equal(withTextOverflowRepairGuidance(overlap), overlap);
});
