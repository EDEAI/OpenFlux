import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { createPresentationGenTool } from '../src/tools/presentation/index.ts';
import { chartGallerySlides } from './presentation-chart-gallery-fixture.ts';

async function main(): Promise<void> {
    const root = resolve(process.env.PRESENTATION_CHART_SMOKE_ROOT || 'outputs/presentation-chart-smoke');
    await fs.mkdir(root, { recursive: true });
    const requested = new Set((process.env.PRESENTATION_CHART_SMOKE_TYPES || '')
        .split(',').map(value => value.trim()).filter(Boolean));
    const chartSlides = chartGallerySlides.filter(slide => {
        if (!slide.chart || typeof slide.chart !== 'object') return false;
        const type = String((slide.chart as { type?: unknown }).type || '');
        return requested.size === 0 || requested.has(type);
    });
    for (const slide of chartSlides) {
        const chart = slide.chart as { type: string };
        const output = resolve(root, chart.type);
        await fs.mkdir(output, { recursive: true });
        const tool = createPresentationGenTool({ getOutputPath: () => output });
        const result = await tool.execute({
            brief: {
                title: `${chart.type} smoke test`, audience: 'engineering', purpose: 'chart rendering smoke test',
                desired_outcome: 'confirm PowerPoint compatibility', delivery_mode: 'report',
            },
            art_direction: {
                mood: 'analytical, precise', density: 'balanced', spacing: 'generous', motif: 'line',
                palette: { background: 'F4F6F8', surface: 'FFFFFF', text: '172033', muted: '667085', accent: '2563EB', accent2: 'E05D3B' },
                typography: { heading: 'Microsoft YaHei', body: 'Microsoft YaHei' },
            },
            slides: [slide],
            filename: `${chart.type}.pptx`,
            output_dir: '.',
            export_pdf: false,
        });
        const data = result.data && typeof result.data === 'object' ? result.data as Record<string, any> : {};
        const issueText = data.qa?.issues?.map((issue: any) => `${issue.code}: ${issue.message}`).join(' | ') || result.error || '';
        process.stdout.write(`${chart.type}\t${result.success ? 'generated' : 'failed'}\t${data.qa?.status || ''}\t${issueText}\n`);
    }
}

main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
});
