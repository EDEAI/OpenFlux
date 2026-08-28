import { readFile } from 'node:fs/promises';
import { fitPresentationArgsToCapacity } from '../src/tools/presentation/capacity.ts';

const logPath = process.argv[2];
if (!logPath) throw new Error('Usage: inspect-presentation-capacity.mjs <session.logs.jsonl>');
const records = (await readFile(logPath, 'utf8'))
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line))
    .filter(record => record.tool === 'generate_presentation' && record.args?.slides);
const latest = records.at(-1);
if (!latest) throw new Error('No full generate_presentation call found');
const capacity = fitPresentationArgsToCapacity(latest.args);
process.stdout.write(JSON.stringify({
    requested: latest.args.brief?.requested_slide_count,
    authored: latest.args.slides.length,
    rendered: capacity.slideCount,
    expanded: capacity.expanded,
    splits: capacity.splits,
    slideOrigins: capacity.slideOrigins,
}, null, 2));
