/**
 * 通用文件文本提取工具
 * 支持：图片、文本/代码、Excel、Word、PDF、PPT
 * 用于 Agent 附件预处理，将文件内容转为可注入 LLM 上下文的文本
 */

import { readFileSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { extname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { getPythonExePath } from './python-env';
import { Logger } from './logger';

const log = new Logger('FileReader');

// ========================
// 类型定义
// ========================

export interface FileTextResult {
    /** 文件类型分类 */
    type: 'image' | 'text' | 'excel' | 'word' | 'pdf' | 'ppt' | 'archive' | 'unknown';
    /** 提取的文本内容 */
    text: string;
    /** 是否被截断 */
    truncated?: boolean;
    /** 错误信息 */
    error?: string;
    /** 图片 base64 数据（仅图片文件） */
    imageBase64?: string;
    /** 图片 MIME 类型（仅图片文件） */
    imageMimeType?: string;
}

/** 附件信息（前端传递） */
export interface ChatAttachment {
    path: string;
    name: string;
    size: number;
    ext: string;
}

// ========================
// 支持的文件扩展名
// ========================

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico'];
const TEXT_EXTS = [
    '.txt', '.md', '.csv', '.json', '.xml', '.log', '.yaml', '.yml',
    '.js', '.ts', '.py', '.java', '.c', '.cpp', '.h', '.hpp', '.cs',
    '.go', '.rs', '.rb', '.php', '.html', '.css', '.scss', '.less',
    '.sql', '.sh', '.bat', '.ps1', '.ini', '.toml', '.cfg', '.conf',
    '.env', '.gitignore', '.dockerignore', '.editorconfig',
];
const EXCEL_EXTS = ['.xlsx', '.xls'];
const WORD_EXTS = ['.docx'];
const PDF_EXTS = ['.pdf'];
const PPT_EXTS = ['.pptx'];
const ZIP_EXTS = ['.zip'];
const ARCHIVE_EXTS = ['.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.tgz'];

/** 所有支持的扩展名 */
export const SUPPORTED_EXTS = [
    ...IMAGE_EXTS, ...TEXT_EXTS, ...EXCEL_EXTS,
    ...WORD_EXTS, ...PDF_EXTS, ...PPT_EXTS,
    ...ZIP_EXTS, ...ARCHIVE_EXTS,
];

/**
 * 判断文件扩展名是否被支持
 */
export function isSupportedFile(ext: string): boolean {
    return SUPPORTED_EXTS.includes(ext.toLowerCase());
}

/**
 * 根据扩展名获取文件分类
 */
export function getFileCategory(ext: string): FileTextResult['type'] {
    const e = ext.toLowerCase();
    if (IMAGE_EXTS.includes(e)) return 'image';
    if (TEXT_EXTS.includes(e)) return 'text';
    if (EXCEL_EXTS.includes(e)) return 'excel';
    if (WORD_EXTS.includes(e)) return 'word';
    if (PDF_EXTS.includes(e)) return 'pdf';
    if (PPT_EXTS.includes(e)) return 'ppt';
    if (ZIP_EXTS.includes(e)) return 'archive';
    if (ARCHIVE_EXTS.includes(e)) return 'archive';
    return 'unknown';
}

// ========================
// 核心提取函数
// ========================

/**
 * 从文件中提取可读文本内容
 *
 * @param filePath 文件绝对路径
 * @param maxChars 最大字符数（默认 200000，约 50K tokens）
 */
export async function extractFileText(filePath: string, maxChars = 200000): Promise<FileTextResult> {
    if (!existsSync(filePath)) {
        return { type: 'unknown', text: '', error: '文件不存在' };
    }

    const ext = extname(filePath).toLowerCase();
    const fileName = basename(filePath);

    try {
        const stats = statSync(filePath);
        const sizeStr = formatFileSize(stats.size);

        // ---- 图片：读取 base64 直接传给 LLM ----
        if (IMAGE_EXTS.includes(ext)) {
            // 限制图片大小（20MB），过大的图片跳过 base64
            const MAX_IMAGE_SIZE = 20 * 1024 * 1024;
            if (stats.size > MAX_IMAGE_SIZE) {
                return {
                    type: 'image',
                    text: `[图片文件: ${fileName}, 大小: ${sizeStr}，超过 20MB 限制，无法直接发送给模型]`,
                };
            }

            const mimeMap: Record<string, string> = {
                '.png': 'image/png',
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.gif': 'image/gif',
                '.webp': 'image/webp',
                '.bmp': 'image/bmp',
                '.svg': 'image/svg+xml',
                '.ico': 'image/x-icon',
            };
            const mimeType = mimeMap[ext] || 'image/png';
            const imageBuffer = readFileSync(filePath);
            const imageBase64 = imageBuffer.toString('base64');

            return {
                type: 'image',
                text: `[图片文件: ${fileName}, 大小: ${sizeStr}]`,
                imageBase64,
                imageMimeType: mimeType,
            };
        }

        // ---- 文本/代码 ----
        if (TEXT_EXTS.includes(ext)) {
            return extractText(filePath, maxChars);
        }

        // ---- Excel ----
        if (EXCEL_EXTS.includes(ext)) {
            return await extractExcel(filePath, maxChars);
        }

        // ---- Word ----
        if (WORD_EXTS.includes(ext)) {
            return await extractWord(filePath, maxChars);
        }

        // ---- PDF ----
        if (PDF_EXTS.includes(ext)) {
            return await extractPdf(filePath, maxChars);
        }

        // ---- PPT ----
        if (PPT_EXTS.includes(ext)) {
            return await extractPpt(filePath, maxChars);
        }

        // ---- ZIP：列出内部文件目录 ----
        if (ZIP_EXTS.includes(ext)) {
            return await extractZip(filePath, maxChars);
        }

        // ---- 其他压缩包：RAR / 7z / tar 等（给出最优解压方案） ----
        if (ARCHIVE_EXTS.includes(ext)) {
            const archiveFormat = ext.replace('.', '').toUpperCase();
            const isRar = ext === '.rar';
            let hint = `[压缩包: ${fileName}, 格式: ${archiveFormat}, 大小: ${sizeStr}]\n`;

            try {
                const { getEnvProbe } = await import('./env-probe');
                const probe = getEnvProbe();
                const tools = probe.tools;

                // 查找已安装的解压工具（含固定路径）
                const archiveTools = ['7z', 'winrar', 'unrar', 'bandizip'];
                let found: { name: string; path: string } | null = null;
                for (const t of archiveTools) {
                    if (tools[t]?.available && tools[t].path) {
                        found = { name: t, path: tools[t].path! };
                        break;
                    }
                }

                if (found) {
                    const isWin = process.platform === 'win32';
                    const q = found.path.includes(' ') ? `"${found.path}"` : found.path;
                    // 判断是否在 PATH 里（绝对路径说明是固定路径扫到的）
                    const inPath = !(found.path.match(/^[A-Za-z]:\\/) || found.path.startsWith('/opt/homebrew') || found.path.startsWith('/usr/local'));
                    const sep = isWin ? '\\' : '/';

                    hint += `\n✅ 检测到解压工具: ${found.name}`;
                    hint += inPath ? ` (in PATH)\n` : ` (${found.path})\n`;

                    // ── 方案 A：直接调用解压工具命令 ──
                    hint += `\n【方案A】直接命令解压（将 <目标目录> 替换为实际路径）:\n`;
                    if (found.name === '7z') {
                        hint += `  ${q} x "${filePath}" -o"<目标目录>" -y\n`;
                    } else if (found.name === 'winrar') {
                        hint += `  ${q} x "${filePath}" "<目标目录>\\" -ibck\n`;
                    } else if (found.name === 'unrar') {
                        hint += isWin
                            ? `  ${q} x "${filePath}" "<目标目录>\\"\n`
                            : `  ${q} x "${filePath}" "<目标目录>/"\n`;
                    } else if (found.name === 'bandizip') {
                        hint += `  ${q} x -o:"<目标目录>" "${filePath}"\n`;
                    }
                    if (!inPath) {
                        hint += `  ⚠️ 不在 PATH 中，必须用上述完整路径，不能只用 "${found.name}"\n`;
                    }

                    // ── 方案 B（RAR 专用）：Python rarfile + UNRAR_TOOL ──
                    // 只要能找到 UnRAR.exe，Python rarfile 就能完整提取 RAR 内容
                    if (isRar) {
                        // 找 unrar.exe 路径（可能来自 winrar 或 unrar 工具）
                        let unrarExe = found.path;
                        if (found.name === 'winrar') {
                            // WinRAR 安装目录下通常同时有 UnRAR.exe
                            const winrarDir = found.path.replace(/[/\\][^/\\]+$/, '');
                            unrarExe = winrarDir + '\\UnRAR.exe';
                        }
                        hint += `\n【方案B】Python rarfile 解压（适合需要进一步处理文件内容的场景）:\n`;
                        hint += `  # rarfile 需要指定 UNRAR_TOOL 路径，否则 extractall() 会报错\n`;
                        hint += `  import rarfile, os\n`;
                        hint += `  rarfile.UNRAR_TOOL = r"${unrarExe}"   # 关键：必须设置此路径\n`;
                        hint += `  rf = rarfile.RarFile(r"${filePath}")\n`;
                        hint += `  rf.extractall(r"<目标目录>")\n`;
                        hint += `  # 如需处理中文文件名：\n`;
                        hint += `  # for info in rf.infolist():\n`;
                        hint += `  #     data = rf.read(info.filename); open(os.path.join("<目标>", os.path.basename(info.filename)), "wb").write(data)\n`;
                    }
                } else {
                    // ─── 真的什么都没有：Python 也走不通，因为 rarfile 同样依赖二进制 ───
                    const isWin = process.platform === 'win32';
                    const isMac = process.platform === 'darwin';
                    hint += `\n❌ 无法处理此压缩包。`;
                    hint += `\n\n原因：系统未安装任何支持 ${archiveFormat} 格式的解压工具`;
                    if (isWin) {
                        hint += `（已检查 PATH、C:\\Program Files\\7-Zip\\、C:\\Program Files\\WinRAR\\ 等常见位置）。`;
                    } else if (isMac) {
                        hint += `（已检查 PATH、/opt/homebrew/bin/、/usr/local/bin/ 等常见位置）。`;
                    } else {
                        hint += `（已检查 PATH 及常见安装位置）。`;
                    }
                    if (isRar) {
                        hint += `\n\nPython rarfile 库的 extractall() 同样依赖系统 unrar 二进制，无法绕过。`;
                    }
                    hint += `\n\n请直接告知用户：`;
                    if (isMac) {
                        hint += `\n> 当前 Mac 没有安装 unrar 或 7-Zip，无法打开 ${archiveFormat} 格式。`;
                        hint += `\n> 可运行: brew install unar  （免费，支持 RAR/7z 等格式）`;
                        hint += `\n> 或将文件转换为 .zip 格式后重新发送。`;
                    } else {
                        hint += `\n> 当前电脑没有安装 WinRAR 或 7-Zip，无法打开 ${archiveFormat} 格式的压缩包。`;
                        hint += `\n> 请将文件转换为 .zip 格式后重新发送，或安装 7-Zip（免费）后重试。`;
                    }
                    hint += `\n\n不要再尝试其他方法，等待用户回复。`;
                }
            } catch {
                const isWin = process.platform === 'win32';
                const isMac = process.platform === 'darwin';
                if (isWin) {
                    hint += `\n请检查以下固定路径是否存在解压工具：\n`;
                    hint += `  "C:\\Program Files\\7-Zip\\7z.exe" x "${filePath}" -o"<目标目录>" -y\n`;
                    hint += `  "C:\\Program Files\\WinRAR\\WinRAR.exe" x "${filePath}" "<目标目录>\\" -ibck\n`;
                    if (isRar) {
                        hint += `\nPython 方案（需先确认 UnRAR.exe 存在）：\n`;
                        hint += `  import rarfile; rarfile.UNRAR_TOOL = r"C:\\Program Files\\WinRAR\\UnRAR.exe"\n`;
                        hint += `  rarfile.RarFile(r"${filePath}").extractall(r"<目标目录>")\n`;
                    }
                } else if (isMac) {
                    hint += `\n请检查以下路径是否存在解压工具：\n`;
                    hint += `  /opt/homebrew/bin/7z x "${filePath}" -o"<目标目录>" -y\n`;
                    hint += `  /usr/local/bin/unrar x "${filePath}" "<目标目录>/"\n`;
                    if (isRar) {
                        hint += `\n如无工具，可安装: brew install unar\n`;
                    }
                } else {
                    hint += `\n请使用系统包管理器安装解压工具后重试。`;
                }
                hint += `\n如工具均不存在，请告知用户安装或将文件转为 .zip 格式。`;
            }

            return { type: 'archive', text: hint };
        }

        // ---- 未知类型：返回说明而非读取二进制 ----
        return {
            type: 'unknown',
            text: `[未知文件类型: ${fileName}, 大小: ${sizeStr}]\n` +
                `不支持自动预览此类文件。如需处理，请使用 filesystem 或 process 工具。`,
        };

    } catch (err: any) {
        log.error(`Failed to extract file content: ${filePath}`, { error: err.message });
        return { type: getFileCategory(ext), text: '', error: `提取失败: ${err.message}` };
    }
}

// ========================
// 各类型提取实现
// ========================

/** 列出 ZIP 内部文件目录，并给出正确的解压命令提示 */
async function extractZip(filePath: string, maxChars: number): Promise<FileTextResult> {
    try {
        const JSZip = (await import('jszip')).default;
        const buf = readFileSync(filePath);
        const zip = await JSZip.loadAsync(buf);

        const entries: { path: string; isDir: boolean }[] = [];
        zip.forEach((relativePath: string, file: any) => {
            entries.push({ path: relativePath, isDir: file.dir });
        });

        const fileEntries = entries.filter(e => !e.isDir);
        const fileName = basename(filePath);
        const sizeStr = formatFileSize(statSync(filePath).size);

        const entryLines = entries.map(e =>
            e.isDir ? `  [DIR]  ${e.path}` : `  [FILE] ${e.path}`
        );

        // 检测是否含非 ASCII 文件名（中文/日文等）
        const hasNonAscii = fileEntries.some(e => /[^\x00-\x7F]/.test(e.path));

        let text = `[ZIP 压缩包: ${fileName}, 大小: ${sizeStr}, 共 ${fileEntries.length} 个条目]\n`;
        text += `\n内部文件列表:\n${entryLines.join('\n')}\n`;

        if (hasNonAscii) {
            // ⚠️ 明确警告 Expand-Archive 会乱码，给出正确命令
            text += `
⚠️ 此 ZIP 包含非 ASCII 文件名（中文/日文等）。
Windows 的 Expand-Archive 会导致文件名乱码（GBK 字节被误读为 UTF-8），解压后找不到文件。

✅ 请使用以下 Python 命令正确解压（自动处理编码）：
\`\`\`
python -c "
import zipfile, os, sys
zpath = r'${filePath.replace(/\\/g, '\\\\')}'
dest  = r'<解压目标目录>'
with zipfile.ZipFile(zpath) as z:
    for info in z.infolist():
        # 尝试 UTF-8，失败则用 GBK（中文 Windows ZIP 默认编码）
        try:
            name = info.filename.encode('cp437').decode('utf-8')
        except Exception:
            name = info.filename.encode('cp437').decode('gbk', errors='replace')
        info.filename = name
        z.extract(info, dest)
        print('extracted:', name)
"
\`\`\`
将 <解压目标目录> 替换为实际目标路径后执行。`;
        } else {
            text += `\n提示: 如需解压，请使用 process 工具执行 Expand-Archive 或 7z 命令。`;
        }

        const truncated = text.length > maxChars;
        return { type: 'archive', text: truncated ? text.slice(0, maxChars) : text, truncated };
    } catch (err: any) {
        return { type: 'archive', text: '', error: `ZIP 列目失败: ${err.message}` };
    }
}

/** 提取纯文本/代码文件 */
function extractText(filePath: string, maxChars: number): FileTextResult {
    const stats = statSync(filePath);
    // 对于过大的文件，只读取前面的部分
    const limit = Math.min(stats.size, maxChars * 2); // 按字节估算
    const buf = Buffer.alloc(limit);
    const fd = openSync(filePath, 'r');
    const bytesRead = readSync(fd, buf, 0, limit, 0);
    closeSync(fd);

    let content = buf.subarray(0, bytesRead).toString('utf-8');
    let truncated = false;

    if (content.length > maxChars) {
        content = content.slice(0, maxChars);
        truncated = true;
    }

    return { type: 'text', text: content, truncated };
}

/** 提取 Excel 内容（转为 CSV 文本） */
async function extractExcel(filePath: string, maxChars: number): Promise<FileTextResult> {
    try {
        const xlsxModule = await import('xlsx');
        const XLSX = xlsxModule.default || xlsxModule;
        const workbook = XLSX.readFile(filePath);

        let text = '';
        for (const sheetName of workbook.SheetNames) {
            const sheet = workbook.Sheets[sheetName];
            const csv = XLSX.utils.sheet_to_csv(sheet);
            text += `=== Sheet: ${sheetName} ===\n${csv}\n\n`;

            if (text.length > maxChars) {
                text = text.slice(0, maxChars);
                return { type: 'excel', text, truncated: true };
            }
        }

        return { type: 'excel', text };
    } catch (err: any) {
        return { type: 'excel', text: '', error: `Excel 解析失败: ${err.message}` };
    }
}

/** 提取 Word (.docx) 纯文本 */
async function extractWord(filePath: string, maxChars: number): Promise<FileTextResult> {
    try {
        const mammothModule = await import('mammoth');
        const mammoth = mammothModule.default || mammothModule;
        const result = await mammoth.extractRawText({ path: filePath });
        let text = result.value || '';

        let truncated = false;
        if (text.length > maxChars) {
            text = text.slice(0, maxChars);
            truncated = true;
        }

        return { type: 'word', text, truncated };
    } catch (err: any) {
        return { type: 'word', text: '', error: `Word 解析失败: ${err.message}` };
    }
}

/** 提取 PDF 文本（使用内置 Python，优先 fitz/pymupdf，兜底 pdfminer.six） */
async function extractPdf(filePath: string, maxChars: number): Promise<FileTextResult> {
    try {
        const pythonExe = getPythonExePath();
        if (!existsSync(pythonExe)) {
            return { type: 'pdf', text: '', error: 'Python 未安装，无法提取 PDF' };
        }

        const script = `
import sys
try:
    import fitz
    doc = fitz.open(${JSON.stringify(filePath)})
    pages = []
    for page in doc:
        txt = page.get_text()
        if txt.strip():
            pages.append(txt)
    text = '\\n'.join(pages)
except ImportError:
    from pdfminer.high_level import extract_text
    text = extract_text(${JSON.stringify(filePath)})
sys.stdout.buffer.write(text.encode('utf-8', errors='replace'))
`;
        const result = spawnSync(pythonExe, ['-c', script], {
            timeout: 30000,
            encoding: 'buffer',
        });

        if (result.error) {
            return { type: 'pdf', text: '', error: `进程启动失败: ${result.error.message}` };
        }
        if (result.status !== 0) {
            const errMsg = result.stderr?.toString('utf-8').trim() || `exit ${result.status}`;
            return { type: 'pdf', text: '', error: `PDF 解析失败: ${errMsg}` };
        }

        let text = result.stdout?.toString('utf-8') || '';
        let truncated = false;
        if (text.length > maxChars) {
            text = text.slice(0, maxChars);
            truncated = true;
        }

        return { type: 'pdf', text, truncated };
    } catch (err: any) {
        return { type: 'pdf', text: '', error: `PDF 解析失败: ${err.message}` };
    }
}

/** 提取 PPT (.pptx) 幻灯片文本 */
async function extractPpt(filePath: string, maxChars: number): Promise<FileTextResult> {
    try {
        const JSZip = (await import('jszip')).default;
        const buf = readFileSync(filePath);
        const zip = await JSZip.loadAsync(buf);

        // 收集 slide 文件并排序
        const slideFiles = Object.keys(zip.files)
            .filter(f => /^ppt\/slides\/slide\d+\.xml$/i.test(f))
            .sort((a, b) => {
                const na = parseInt(a.match(/slide(\d+)/i)?.[1] || '0');
                const nb = parseInt(b.match(/slide(\d+)/i)?.[1] || '0');
                return na - nb;
            });

        let text = '';
        for (let i = 0; i < slideFiles.length; i++) {
            const xmlContent = await zip.files[slideFiles[i]].async('text');
            // 提取 <a:t> 文本节点
            const texts: string[] = [];
            const regex = /<a:t[^>]*>([^<]*)<\/a:t>/g;
            let match;
            while ((match = regex.exec(xmlContent)) !== null) {
                if (match[1].trim()) texts.push(match[1]);
            }

            if (texts.length > 0) {
                text += `--- Slide ${i + 1} ---\n`;
                text += texts.join('\n') + '\n\n';
            }

            if (text.length > maxChars) {
                text = text.slice(0, maxChars);
                return { type: 'ppt', text, truncated: true };
            }
        }

        return { type: 'ppt', text: text || '（无文字内容）' };
    } catch (err: any) {
        return { type: 'ppt', text: '', error: `PPT 解析失败: ${err.message}` };
    }
}

// ========================
// 工具函数
// ========================

function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ========================
// 批量处理（供 AgentManager 调用）
// ========================

/** 图片附件信息（供 LLM 多模态消息使用） */
export interface ImageAttachmentData {
    /** 文件名 */
    name: string;
    /** MIME 类型 */
    mimeType: string;
    /** base64 编码数据 */
    base64: string;
}

/** buildEnrichedInput 返回的结构化结果 */
export interface EnrichedInputResult {
    /** 文本内容（包含非图片附件的提取文本 + 用户消息） */
    text: string;
    /** 图片列表（直接传给 LLM 的多模态内容） */
    images: ImageAttachmentData[];
}

/**
 * 将附件列表处理为结构化结果，分离图片和文本内容
 *
 * @param attachments 附件信息数组
 * @param userInput 用户原始输入
 * @returns 文本内容 + 图片列表
 */
export async function buildEnrichedInput(
    attachments: ChatAttachment[],
    userInput: string,
): Promise<EnrichedInputResult> {
    if (!attachments.length) return { text: userInput, images: [] };

    const maxChars = 200000; // 与 extractFileText 默认值保持一致
    const results = await Promise.all(
        attachments.map(a => extractFileText(a.path, maxChars))
    );

    const images: ImageAttachmentData[] = [];
    let hasTextAttachments = false;
    let block = '';

    for (let i = 0; i < attachments.length; i++) {
        const a = attachments[i];
        const r = results[i];

        // 图片附件：收集 base64 数据传给 LLM Vision，同时在文本中告知文件路径
        if (r.type === 'image' && r.imageBase64 && r.imageMimeType) {
            images.push({
                name: a.name,
                mimeType: r.imageMimeType,
                base64: r.imageBase64,
            });
            // 同时在文本中注入路径信息，确保 Agent 知道文件位置
            if (!hasTextAttachments) {
                block += '## 用户附件\n\n';
                hasTextAttachments = true;
            }
            block += `### ${a.name} (图片)\n`;
            block += `> 文件路径: ${a.path}\n`;
            block += `> 此图片已通过 Vision 传递给你，你可以直接看到内容\n`;
            block += `> 如需用工具处理此图片（如 Python 脚本），请使用上述文件路径\n\n`;
            continue;
        }

        // 非图片附件：拼接为文本
        if (!hasTextAttachments) {
            block += '## 用户附件\n\n';
            hasTextAttachments = true;
        }

        const typeLabel = getTypeLabel(r.type);
        block += `### ${a.name} (${typeLabel})\n`;
        block += `> 文件路径: ${a.path}\n`;
        block += '> 若需再次调用工具处理此文件，请始终使用上述完整路径，不要只用文件名\n';

        if (r.error) {
            block += `> 提取失败: ${r.error}\n`;
            block += '\n';
        } else {
            if (r.truncated) {
                block += `> 注意: 文件内容过长(超过${Math.round(maxChars / 1000)}K字符)，以下仅为部分预览\n`;
                if (r.type === 'text' || r.type === 'unknown') {
                    block += `> 如需完整数据，请使用 filesystem 工具读取: filesystem(action="read", path="${a.path}")\n`;
                } else {
                    const officeAction = r.type === 'excel' ? 'excel' : r.type === 'word' ? 'word' : r.type === 'pdf' ? 'pdf' : 'csv';
                    block += `> 如需完整数据，请使用 office 工具读取（默认返回 2000 行，支持 startRow 分页）:\n`;
                    block += `> office(action="${officeAction}", subAction="read", filePath="${a.path}")\n`;
                    block += `> 若数据超过 2000 行，返回的 hasMore=true 和 nextStartRow 可用于翻页\n`;
                }
            }
            block += r.text + '\n\n';
        }
    }

    // 拼接最终文本
    const text = hasTextAttachments
        ? block + '## 用户消息\n\n' + userInput
        : userInput;

    log.info('Attachment preprocessing complete', {
        count: attachments.length,
        imageCount: images.length,
        textChars: text.length,
    });

    return { text, images };
}

function getTypeLabel(type: FileTextResult['type']): string {
    switch (type) {
        case 'image': return '图片';
        case 'text': return '文本文件';
        case 'excel': return 'Excel 表格';
        case 'word': return 'Word 文档';
        case 'pdf': return 'PDF 文档';
        case 'ppt': return 'PPT 演示文稿';
        case 'archive': return '压缩包';
        default: return '文件';
    }
}
