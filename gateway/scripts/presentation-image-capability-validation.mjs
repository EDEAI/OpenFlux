import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import sharp from 'sharp';
import { createPresentationGenTool, exportPresentationWithPowerPoint } from '../src/tools/presentation/index.ts';

const workspaceRoot = resolve(import.meta.dirname, '..', '..');
const fixtureRoot = join(workspaceRoot, 'tmp', 'presentation-image-capability-validation');
const outputRoot = process.env.OPENFLUX_OUTPUT_ROOT || 'D:\\openflux_output';
const outputDir = '2026-08-27/PPT图片能力验证';

async function fixture(name, width, height, colors, label) {
    const path = join(fixtureRoot, name);
    const svg = Buffer.from(`
        <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
          <defs><linearGradient id="g" x1="0" x2="1"><stop stop-color="${colors[0]}"/><stop offset="1" stop-color="${colors[1]}"/></linearGradient></defs>
          <rect width="100%" height="100%" fill="url(#g)"/>
          <circle cx="${Math.round(width * 0.76)}" cy="${Math.round(height * 0.38)}" r="${Math.round(Math.min(width, height) * 0.17)}" fill="#ffffff" fill-opacity="0.78"/>
          <text x="${Math.round(width * 0.07)}" y="${Math.round(height * 0.82)}" font-family="Arial" font-size="${Math.round(Math.min(width, height) * 0.10)}" font-weight="700" fill="#ffffff">${label}</text>
        </svg>`);
    await sharp(svg).png().toFile(path);
    return path;
}

async function screenshotFixture(name) {
    const path = join(fixtureRoot, name);
    const rows = Array.from({ length: 4 }, (_, index) => `
        <rect x="${120 + index * 420}" y="430" width="350" height="310" rx="22" fill="#ffffff" stroke="#d9e1ee"/>
        <rect x="${160 + index * 420}" y="478" width="150" height="18" rx="9" fill="#2f6fed" opacity="${1 - index * 0.12}"/>
        <rect x="${160 + index * 420}" y="530" width="260" height="12" rx="6" fill="#aab5c8"/>
        <rect x="${160 + index * 420}" y="570" width="210" height="12" rx="6" fill="#d6dce7"/>
        <circle cx="${295 + index * 420}" cy="660" r="46" fill="#ef6c26" opacity="${0.85 - index * 0.1}"/>
    `).join('');
    const svg = Buffer.from(`
        <svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080">
          <rect width="100%" height="100%" fill="#eef2f8"/>
          <rect x="70" y="55" width="1780" height="970" rx="32" fill="#f9fbfe" stroke="#ccd5e4" stroke-width="4"/>
          <rect x="70" y="55" width="1780" height="92" rx="32" fill="#15223b"/>
          <circle cx="125" cy="101" r="13" fill="#ef6c26"/><circle cx="169" cy="101" r="13" fill="#f7c948"/><circle cx="213" cy="101" r="13" fill="#3cc995"/>
          <text x="120" y="255" font-family="Arial" font-size="58" font-weight="700" fill="#15223b">OPENFLUX PRODUCT OVERVIEW</text>
          <rect x="120" y="300" width="720" height="22" rx="11" fill="#8793a8"/>
          ${rows}
          <rect x="120" y="830" width="1680" height="120" rx="24" fill="#e5ebf5"/>
          <rect x="170" y="875" width="980" height="24" rx="12" fill="#2f6fed" opacity="0.72"/>
        </svg>`);
    await sharp(svg).png().toFile(path);
    return path;
}

await fs.rm(fixtureRoot, { recursive: true, force: true });
await fs.mkdir(fixtureRoot, { recursive: true });
const wide = await fixture('wide.png', 2400, 1000, ['#102a56', '#ef6c26'], 'WIDE / FOCUS RIGHT');
const panorama = await fixture('panorama.png', 2400, 1000, ['#153a5b', '#48cae4'], 'PANORAMA / SOFT EDGE');
const portrait = await fixture('portrait.png', 1200, 1800, ['#16697a', '#82c0cc'], 'PORTRAIT');
const square = await fixture('square.png', 1400, 1400, ['#3a0ca3', '#f72585'], 'SQUARE');
const logo = await fixture('logo.png', 1400, 1400, ['#14213d', '#fca311'], 'LOGO / CONTAIN');
const screenshot = await screenshotFixture('screenshot.png');

const args = {
    brief: {
        title: 'PPT 图片处理能力验证',
        subtitle: '用户素材、搜索素材、焦点裁切、遮罩与严格长宽比',
        audience: 'OpenFlux 产品与质量团队',
        purpose: '验证 Presentation Agent 的图片编排和输出安全性',
        desired_outcome: '确认素材在不同页面框架中不拉伸、不误裁并保留来源',
        delivery_mode: 'report',
        communication_job: '用可视化样例证明同一套图片契约能覆盖封面、人像、截图、横幅与收束页。',
        narrative_arc: ['沉浸封面', '主体保护', '语义素材完整', '遮罩变化', '来源与交付'],
        requested_slide_count: 6,
    },
    art_direction: {
        mood: 'editorial, crisp, visual-first',
        visual_language: 'editorial',
        design_concept: '每张素材都拥有与其语义匹配的观看窗口',
        signature_element: 'frame',
        density: 'airy',
        palette: { background: 'F4F6FA', surface: 'FFFFFF', text: '15223B', muted: '657089', accent: '2F6FED', accent2: 'EF6C26' },
        typography: { heading: 'Microsoft YaHei', body: 'Microsoft YaHei' },
        spacing: 'balanced',
        image_treatment: 'framed',
        chart_style: 'editorial',
        grid: { columns: 12, margin: 0.7, gutter: 0.22 },
        design_principles: ['图片不拉伸', '主体焦点优先', '信息型素材完整显示'],
    },
    slides: [
        {
            purpose: '验证宽图封面', message: '封面宽图保持主体，不发生非等比拉伸', composition: 'focal',
            body: 'cover + focus right + physical crop', image_path: wide, image_kind: 'background', image_fit: 'cover', image_focus: { x: 0.78, y: 0.42 }, image_mask: 'none',
            image_source_url: 'Local validation fixture: wide.png',
        },
        {
            purpose: '验证自动人像遮罩', message: '人像素材自动进入圆形观看窗口', composition: 'split',
            body: 'Auto mask detects portrait semantics and preserves the upper focal area.', image_path: portrait, image_alt: '创始人人像 portrait headshot', image_kind: 'photo', image_fit: 'cover', image_focus: { x: 0.5, y: 0.28 }, image_mask: 'auto',
            image_source_url: 'Local validation fixture: portrait.png',
        },
        {
            purpose: '验证信息型截图', message: '截图完整 contain，圆角但不裁掉界面边界', composition: 'split',
            body: 'Semantic screenshot assets keep every edge and label visible.', image_path: screenshot, image_alt: 'OpenFlux report screenshot', image_kind: 'screenshot', image_fit: 'contain', image_mask: 'auto',
            image_source_url: 'OpenFlux local regression screenshot',
        },
        {
            purpose: '验证柔边横幅', message: '横幅素材在宽画幅中保留比例并柔化边缘', composition: 'split',
            body: 'Panorama selection follows the intrinsic 2.4:1 ratio.', image_path: panorama, image_kind: 'photo', image_fit: 'cover', image_focus: { x: 0.65, y: 0.5 }, image_mask: 'soft-edge',
            image_source_url: 'Local validation fixture: panorama.png',
        },
        {
            purpose: '验证拱形遮罩', message: '方形素材进入拱形窗口，比例不变', composition: 'split',
            body: 'The mask changes only alpha, never geometry.', image_path: square, image_kind: 'photo', image_fit: 'cover', image_mask: 'arch',
            image_source_url: 'Local validation fixture: square.png',
        },
        {
            purpose: '收束图片契约', message: '好图片要比例正确 主体清楚 来源可靠', composition: 'closing',
            body: '所有素材在 PPTX 内再次经过几何与清晰度 QA。', image_path: logo, image_kind: 'logo', image_fit: 'contain', image_mask: 'none',
            image_source_url: 'Local validation fixture: logo.png',
        },
    ],
    filename: 'PPT图片处理能力验证-6页.pptx',
    output_dir: outputDir,
    export_pdf: true,
    render_preview: true,
};

const tool = createPresentationGenTool({ getOutputPath: () => outputRoot, enforceWorkflow: false });
const result = await tool.execute(args);
if (!result.success) throw new Error(result.error || 'Presentation image validation failed');
const pptxPath = result.data?.pptx;
if (!pptxPath) throw new Error('Presentation image validation did not produce a PPTX path');
const qaSlideDir = join(dirname(pptxPath), 'qa-slides');
await fs.rm(qaSlideDir, { recursive: true, force: true });
await exportPresentationWithPowerPoint({ pptxPath, previewDir: qaSlideDir });
if (result.data?.qa?.status !== 'passed') {
    throw new Error(`Presentation QA did not pass: ${JSON.stringify(result.data?.qa?.issues || [])}`);
}
if (result.data?.imageQa?.issues?.length) {
    throw new Error(`Presentation image QA reported issues: ${JSON.stringify(result.data.imageQa.issues)}`);
}
process.stdout.write(`${JSON.stringify(result.data, null, 2)}\n`);
