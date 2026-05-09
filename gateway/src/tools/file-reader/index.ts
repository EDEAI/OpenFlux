/**
 * file_reader 工具 - 将用户文件转换为 Markdown/文本
 *
 * 直接调用各格式库（不依赖 markitdown/magika/onnxruntime），轻量 ~15MB。
 * 支持格式: docx / xlsx / xls / pptx / pdf / csv / html / htm / epub / txt / md
 *
 * 转换策略（内置 Python 脚本，按扩展名分发）：
 *   docx   → python-docx  → Markdown
 *   xlsx   → openpyxl     → Markdown 表格
 *   pptx   → python-pptx  → 幻灯片文字
 *   pdf    → pdfminer.six → 纯文本
 *   csv    → 内置解析     → Markdown 表格
 *   html   → beautifulsoup4 + markdownify → Markdown
 *   epub   → ebooklib + bs4 → 文本
 *   txt/md → 直接读取
 */

import { spawn, spawnSync } from 'child_process';
import { existsSync, statSync } from 'fs';
import { extname, basename, join } from 'path';
import type { AnyTool, ToolResult } from '../types';
import { readStringParam, readNumberParam, jsonResult, errorResult } from '../common';
import { getPythonBasePath } from '../../utils/python-env';

/** 支持的文件扩展名 */
const SUPPORTED_EXTS = new Set([
    'docx', 'xlsx', 'xls', 'pptx',
    'pdf', 'csv', 'html', 'htm',
    'epub', 'txt', 'md',
]);

/** 默认最大字符数 */
const DEFAULT_MAX_CHARS = 80000;

/** 按扩展名生成的 Python 转换脚本 */
function buildScript(ext: string, filePath: string): string {
    // 转义路径（Windows 反斜杠）
    const escapedPath = filePath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

    switch (ext) {
        case 'docx':
            return `
import docx, sys
doc = docx.Document('${escapedPath}')
lines = []
for para in doc.paragraphs:
    text = para.text.strip()
    if not text:
        continue
    style = para.style.name.lower() if para.style else ''
    if 'heading 1' in style:
        lines.append(f'# {text}')
    elif 'heading 2' in style:
        lines.append(f'## {text}')
    elif 'heading 3' in style:
        lines.append(f'### {text}')
    else:
        lines.append(text)
sys.stdout.buffer.write('\\n'.join(lines).encode('utf-8', errors='replace'))
`;

        case 'xlsx':
        case 'xls':
            return `
import openpyxl, sys
wb = openpyxl.load_workbook('${escapedPath}', read_only=True, data_only=True)
out = []
for sheet in wb.worksheets:
    out.append(f'## Sheet: {sheet.title}\\n')
    rows = list(sheet.iter_rows(values_only=True))
    if not rows:
        continue
    # 表头
    header = [str(c or '') for c in rows[0]]
    out.append('| ' + ' | '.join(header) + ' |')
    out.append('| ' + ' | '.join(['---'] * len(header)) + ' |')
    for row in rows[1:2001]:  # 最多 2000 行
        cells = [str(c or '') for c in row]
        out.append('| ' + ' | '.join(cells) + ' |')
    if sheet.max_row and sheet.max_row > 2001:
        out.append(f'\\n*(Showing first 2000 of {sheet.max_row} rows)*')
    out.append('')
sys.stdout.buffer.write('\\n'.join(out).encode('utf-8', errors='replace'))
`;

        case 'pptx':
            return `
from pptx import Presentation
import sys
prs = Presentation('${escapedPath}')
out = []
for i, slide in enumerate(prs.slides, 1):
    out.append(f'## Slide {i}')
    seen = set()
    for shape in slide.shapes:
        if hasattr(shape, 'text') and shape.text:
            txt = shape.text.strip()
            if txt and txt not in seen:
                seen.add(txt)
                out.append(txt)
    out.append('')
sys.stdout.buffer.write('\\n'.join(out).encode('utf-8', errors='replace'))
`;

        case 'pdf':
            return `
from pdfminer.high_level import extract_text
import sys
text = extract_text('${escapedPath}')
sys.stdout.buffer.write(text.encode('utf-8', errors='replace'))
`;

        case 'csv':
            return `
import csv, sys, io
with open('${escapedPath}', 'r', encoding='utf-8-sig', errors='replace') as f:
    reader = csv.reader(f)
    rows = list(reader)
if not rows:
    sys.exit(0)
out = []
header = rows[0]
out.append('| ' + ' | '.join(header) + ' |')
out.append('| ' + ' | '.join(['---'] * len(header)) + ' |')
for row in rows[1:2001]:
    out.append('| ' + ' | '.join(row) + ' |')
if len(rows) > 2001:
    out.append(f'\\n*(Showing first 2000 of {len(rows)-1} rows)*')
sys.stdout.buffer.write('\\n'.join(out).encode('utf-8', errors='replace'))
`;

        case 'html':
        case 'htm':
            return `
from bs4 import BeautifulSoup
import markdownify, sys
with open('${escapedPath}', 'r', encoding='utf-8', errors='replace') as f:
    html = f.read()
soup = BeautifulSoup(html, 'html.parser')
for tag in soup(['script', 'style', 'nav', 'footer', 'header']):
    tag.decompose()
md = markdownify.markdownify(str(soup), heading_style='ATX')
sys.stdout.buffer.write(md.encode('utf-8', errors='replace'))
`;

        case 'epub':
            return `
import ebooklib
from ebooklib import epub
from bs4 import BeautifulSoup
import sys
book = epub.read_epub('${escapedPath}')
out = []
for item in book.get_items_of_type(ebooklib.ITEM_DOCUMENT):
    soup = BeautifulSoup(item.get_content(), 'html.parser')
    text = soup.get_text(separator='\\n')
    out.append(text)
sys.stdout.buffer.write('\\n\\n'.join(out).encode('utf-8', errors='replace'))
`;

        case 'txt':
        case 'md':
            return `
import sys
with open('${escapedPath}', 'r', encoding='utf-8', errors='replace') as f:
    content = f.read()
sys.stdout.buffer.write(content.encode('utf-8', errors='replace'))
`;

        default:
            throw new Error(`No script for extension: ${ext}`);
    }
}

/**
 * 执行 Python 脚本转换文件
 */
function runConversion(script: string, pythonExe: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(pythonExe, ['-c', script], {
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 60000,
        });

        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];

        child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

        child.on('close', (code) => {
            if (code === 0) {
                resolve(Buffer.concat(stdout).toString('utf-8'));
            } else {
                const errMsg = Buffer.concat(stderr).toString('utf-8').trim();
                reject(new Error(errMsg || `Python exited with code ${code}`));
            }
        });

        child.on('error', reject);
    });
}

/**
 * 检查 Python 模块是否已安装
 */
function checkModule(pythonExe: string, moduleName: string): boolean {
    const result = spawnSync(pythonExe, ['-c', `import ${moduleName}`], {
        timeout: 5000,
        encoding: 'utf-8',
    });
    return result.status === 0;
}

/** 按格式对应所需模块 */
const EXT_MODULES: Record<string, string[]> = {
    docx: ['docx'],
    xlsx: ['openpyxl'],
    xls: ['openpyxl'],
    pptx: ['pptx'],
    pdf: ['pdfminer'],
    csv: [],
    html: ['bs4', 'markdownify'],
    htm: ['bs4', 'markdownify'],
    epub: ['ebooklib', 'bs4'],
    txt: [],
    md: [],
};

export interface FileReaderToolOptions {
    maxChars?: number;
}

/**
 * 创建文件读取工具
 */
export function createFileReaderTool(opts: FileReaderToolOptions = {}): AnyTool {
    const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
    const pythonExe = join(getPythonBasePath(), 'python.exe');

    return {
        name: 'file_reader',
        priority: 28,
        description: `Read and extract text content from user files, converting them to Markdown.
Supported formats: docx (Word), xlsx/xls (Excel), pptx (PowerPoint), pdf (text-based), csv, html, epub, txt, md.
Returns document content as Markdown text. Use this tool FIRST when the user sends a file path — do NOT use filesystem/read or install packages manually.`,

        parameters: {
            path: {
                type: 'string',
                description: 'Absolute path to the file',
                required: true,
            },
            maxChars: {
                type: 'number',
                description: `Max characters to return (default ${DEFAULT_MAX_CHARS}). Increase for full document.`,
            },
        },

        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
            const filePath = readStringParam(args, 'path', { required: true, label: 'path' });
            const limit = readNumberParam(args, 'maxChars') ?? maxChars;

            if (!existsSync(filePath)) {
                return errorResult(`File not found: ${filePath}`);
            }

            const ext = extname(filePath).toLowerCase().replace('.', '');
            if (!SUPPORTED_EXTS.has(ext)) {
                return errorResult(
                    `Unsupported file type: .${ext}\nSupported: ${[...SUPPORTED_EXTS].join(', ')}`
                );
            }

            if (!existsSync(pythonExe)) {
                return errorResult(`Bundled Python not found: ${pythonExe}`);
            }

            // 检查所需模块
            const requiredModules = EXT_MODULES[ext] ?? [];
            for (const mod of requiredModules) {
                if (!checkModule(pythonExe, mod)) {
                    return errorResult(
                        `Missing Python module: ${mod}\n` +
                        `Run: uv pip install ${mod} --python "${pythonExe}"`
                    );
                }
            }

            const stats = statSync(filePath);
            const fileSizeMB = parseFloat((stats.size / 1024 / 1024).toFixed(1));

            try {
                const script = buildScript(ext, filePath);
                let content = await runConversion(script, pythonExe);

                const truncated = content.length > limit;
                if (truncated) {
                    content = content.slice(0, limit);
                }

                return jsonResult({
                    file: filePath,
                    filename: basename(filePath),
                    format: ext,
                    fileSizeMB,
                    contentLength: content.length,
                    truncated,
                    ...(truncated ? { note: `Truncated to ${limit} chars. Pass maxChars to get more.` } : {}),
                    content,
                });
            } catch (err: any) {
                const msg = String(err?.message || err);
                if (msg.includes('encrypted') || msg.includes('password') || msg.includes('EncryptedDocException')) {
                    return errorResult(`File is password-protected: ${basename(filePath)}`);
                }
                if (msg.includes('No module named')) {
                    return errorResult(`Missing Python dependency: ${msg}`);
                }
                return errorResult(`Failed to read file: ${msg}`);
            }
        },
    };
}
