/**
 * 通用文件文本提取工具
 * 支持：图片、文本/代码、Excel、Word、PDF、PPT
 * 用于 Agent 附件预处理，将文件内容转为可注入 LLM 上下文的文本
 */

import { readFileSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { extname, basename } from 'node:path';
import { Logger } from './logger';

const log = new Logger('FileReader');

// ========================
// 类型定义
// ========================

export interface FileTextResult {
    /** 文件类型分类 */
    type: 'image' | 'text' | 'excel' | 'word' | 'pdf' | 'ppt' | 'unknown';
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

/** 所有支持的扩展名 */
export const SUPPORTED_EXTS = [
    ...IMAGE_EXTS, ...TEXT_EXTS, ...EXCEL_EXTS,
    ...WORD_EXTS, ...PDF_EXTS, ...PPT_EXTS,
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
    return 'unknown';
}

// ========================
// 核心提取函数
// ========================

/**
 * 从文件中提取可读文本内容
 *
 * @param filePath 文件绝对路径
 * @param maxChars 最大字符数（默认 50000）
 */
export async function extractFileText(filePath: string, maxChars = 50000): Promise<FileTextResult> {
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

        // ---- 未知类型：尝试当文本读取 ----
        return extractText(filePath, maxChars);

    } catch (err: any) {
        log.error(`提取文件内容失败: ${filePath}`, { error: err.message });
        return { type: getFileCategory(ext), text: '', error: `提取失败: ${err.message}` };
    }
}

// ========================
// 各类型提取实现
// ========================

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

/** 提取 PDF 文本 */
async function extractPdf(filePath: string, maxChars: number): Promise<FileTextResult> {
    try {
        // pdf-parse v2 导出 PDFParse 类，需要实例化后调用 getText()
        const pdfParseModule = await import('pdf-parse') as any;
        const PDFParse = pdfParseModule.PDFParse ?? pdfParseModule.default?.PDFParse ?? pdfParseModule.default;
        const buf = readFileSync(filePath);
        const parser = new PDFParse({ data: buf });
        const result = await parser.getText();
        await parser.destroy();
        let text = result.text || '';

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

    const results = await Promise.all(
        attachments.map(a => extractFileText(a.path))
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

        if (r.error) {
            block += `> 提取失败: ${r.error}\n`;
            block += `> 文件路径: ${a.path}\n\n`;
        } else {
            if (r.truncated) {
                block += `> 注意: 文件内容过长，已截断显示\n`;
            }
            block += r.text + '\n\n';
        }
    }

    // 拼接最终文本
    const text = hasTextAttachments
        ? block + '## 用户消息\n\n' + userInput
        : userInput;

    log.info('附件预处理完成', {
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
        default: return '文件';
    }
}
