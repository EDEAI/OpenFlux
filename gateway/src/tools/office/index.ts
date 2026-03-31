/**
 * Office 文档处理工具 - 工厂模式
 * 支持 Excel/Word/PDF/CSV 的读写操作
 * 分配给 coder Agent
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AnyTool, ToolResult } from '../types';
import { validateAction, readStringParam, readNumberParam, jsonResult, errorResult } from '../common';

// 支持的动作
const OFFICE_ACTIONS = [
    'excel',  // Excel 操作
    'word',   // Word 操作
    'pdf',    // PDF 操作
    'csv',    // CSV 操作
] as const;

type OfficeAction = typeof OFFICE_ACTIONS[number];

export interface OfficeToolOptions {
    /** 默认工作目录 */
    basePath?: string;
    /** 写入白名单（仅写入操作时检查，读取不受限） */
    allowedWritePaths?: string[];
}

/**
 * 创建 Office 文档处理工具
 */
export function createOfficeTool(opts: OfficeToolOptions = {}): AnyTool {
    const basePath = opts.basePath || process.cwd();
    const allowedWritePaths = opts.allowedWritePaths;

    // 解析路径（统一使用系统分隔符）
    const resolvePath = (inputPath: string): string => {
        if (path.isAbsolute(inputPath)) return path.normalize(inputPath);
        return path.resolve(basePath, inputPath);
    };

    // 写入路径解析：自动注入日期子目录
    // basePath 即 outputPath（如 D:\openflux_output），写入时自动在其下创建 YYYY-MM-DD/ 子目录
    const resolveWritePath = (inputPath: string): string => {
        // 绝对路径则直接使用
        if (path.isAbsolute(inputPath)) return path.normalize(inputPath);

        // 去掉 LLM 可能传入的 output/ 前缀（basePath 已经是 output 目录）
        let cleanPath = inputPath.replace(/^output[\\/]/i, '');

        // 检查路径是否已包含日期目录（YYYY-MM-DD）
        const normalized = cleanPath.replace(/\\/g, '/');
        const datePattern = /(?:^|\/)(\d{4}-\d{2}-\d{2})(?:\/|$)/;
        if (datePattern.test(normalized)) {
            // 已有日期路径，直接 resolve 到 basePath 下
            return path.resolve(basePath, cleanPath);
        }

        // 无日期路径 → 自动注入 YYYY-MM-DD/
        const today = new Date();
        const yyyy = today.getFullYear();
        const mm = String(today.getMonth() + 1).padStart(2, '0');
        const dd = String(today.getDate()).padStart(2, '0');
        const dateDir = `${yyyy}-${mm}-${dd}`;

        return path.resolve(basePath, dateDir, cleanPath);
    };

    // 写入路径白名单检查（normalize 后比较，避免正反斜杠不匹配）
    const checkWritePath = (filePath: string): void => {
        if (allowedWritePaths && allowedWritePaths.length > 0) {
            const normalizedFile = path.normalize(filePath).toLowerCase();
            const allowed = allowedWritePaths.some((p) => {
                const resolved = path.normalize(resolvePath(p)).toLowerCase();
                return normalizedFile.startsWith(resolved);
            });
            if (!allowed) {
                const resolvedHints = allowedWritePaths.map(p => resolvePath(p));
                throw new Error(`Write path is not in the allowed range: ${filePath}\nAllowed directories: ${resolvedHints.join(', ')}`);
            }
        }
    };

    return {
        name: 'office',
        description: `Office 文档处理工具，支持 Excel/Word/PDF/CSV 的读写操作。
excel 子操作: read(读取工作表数据), write(写入数据到工作表), create(新建 Excel 文件)
word 子操作: read(读取文档文本), create(创建 Word 文档)
pdf 子操作: read(读取 PDF 文本和元信息)
csv 子操作: read(解析 CSV), write(写入 CSV)`,

        parameters: {
            action: {
                type: 'string',
                description: `Action type: ${OFFICE_ACTIONS.join('/')}`,
                required: true,
                enum: [...OFFICE_ACTIONS],
            },
            subAction: {
                type: 'string',
                description: 'Sub-action: read/write/create',
                required: true,
            },
            filePath: {
                type: 'string',
                description: 'File path (required). For write/create: use date-based subdirectory under output, e.g. "output/YYYY-MM-DD/任务描述/filename.xlsx"',
                required: true,
            },
            sheet: {
                type: 'string',
                description: 'Excel sheet name (default: first sheet)',
            },
            data: {
                type: 'array',
                description: 'Excel/CSV write: 2D array data [[row1col1, row1col2], [row2col1, row2col2]]',
                items: { type: 'array', items: { type: 'string' } },
            },
            startRow: {
                type: 'number',
                description: 'Read: Starting row number for pagination (default 1, e.g. 2001 to skip first 2000 rows). Write: Starting row for writing.',
            },
            maxRows: {
                type: 'number',
                description: 'Excel/CSV read: Maximum rows to return per call (default 2000). Use with startRow for pagination: first call startRow=1, second call startRow=2001, etc.',
            },
            // Word 参数
            title: {
                type: 'string',
                description: 'Word create: Document title',
            },
            paragraphs: {
                type: 'array',
                description: 'Word create: Paragraph content array ["paragraph1", "paragraph2"]',
                items: { type: 'string' },
            },
            // CSV 参数
            delimiter: {
                type: 'string',
                description: 'CSV delimiter (default comma)',
            },
            encoding: {
                type: 'string',
                description: 'File encoding (default utf-8)',
            },
        },

        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
            const action = validateAction(args, OFFICE_ACTIONS) as OfficeAction;
            const subAction = readStringParam(args, 'subAction') || '';
            const filePath = readStringParam(args, 'filePath');

            if (!filePath) {
                return errorResult('Missing filePath parameter');
            }
            const isWrite = subAction === 'write' || subAction === 'create';
            const fullPath = isWrite ? resolveWritePath(filePath) : resolvePath(filePath);
            // 写入操作检查白名单
            if (isWrite) {
                checkWritePath(fullPath);
            }

            switch (action) {
                // ========================
                // Excel 操作
                // ========================
                case 'excel': {
                    const excelMod = await import('exceljs');
                    const ExcelJS = (excelMod as any).default || excelMod;

                    switch (subAction) {
                        case 'read': {
                            if (!fs.existsSync(fullPath)) {
                                return errorResult(`File not found: ${fullPath}`);
                            }
                            const workbook = new ExcelJS.Workbook();
                            await workbook.xlsx.readFile(fullPath);

                            const sheetName = readStringParam(args, 'sheet');
                            const maxRows = readNumberParam(args, 'maxRows') || 2000;
                            const startRow = readNumberParam(args, 'startRow') || 1;
                            const worksheet = sheetName
                                ? workbook.getWorksheet(sheetName)
                                : workbook.worksheets[0];

                            if (!worksheet) {
                                return errorResult(`Sheet not found: ${sheetName || '(default)'}`);
                            }

                            const rows: unknown[][] = [];
                            let rowIndex = 0;
                            worksheet.eachRow((row, _rowNumber) => {
                                rowIndex++;
                                if (rowIndex < startRow) return;
                                if (rows.length >= maxRows) return;
                                rows.push(row.values as unknown[]);
                            });

                            const totalRows = worksheet.rowCount;
                            const endRow = startRow + rows.length - 1;
                            const hasMore = endRow < totalRows;
                            const sheets = workbook.worksheets.map(ws => ws.name);
                            return jsonResult({
                                file: fullPath,
                                sheet: worksheet.name,
                                sheets,
                                totalRows,
                                columnCount: worksheet.columnCount,
                                returnedRows: rows.length,
                                startRow,
                                endRow,
                                hasMore,
                                ...(hasMore ? { nextStartRow: endRow + 1 } : {}),
                                rows,
                            });
                        }

                        case 'write': {
                            const data = args.data as unknown[][] | undefined;
                            if (!data || !Array.isArray(data)) {
                                return errorResult('Missing data parameter (2D array)');
                            }

                            const workbook = new ExcelJS.Workbook();
                            if (fs.existsSync(fullPath)) {
                                await workbook.xlsx.readFile(fullPath);
                            }

                            const sheetName = readStringParam(args, 'sheet') || 'Sheet1';
                            let worksheet = workbook.getWorksheet(sheetName);
                            if (!worksheet) {
                                worksheet = workbook.addWorksheet(sheetName);
                            }

                            const startRow = readNumberParam(args, 'startRow') || 1;
                            for (let i = 0; i < data.length; i++) {
                                const row = worksheet.getRow(startRow + i);
                                const rowData = data[i];
                                if (Array.isArray(rowData)) {
                                    for (let j = 0; j < rowData.length; j++) {
                                        row.getCell(j + 1).value = rowData[j] as any;
                                    }
                                }
                                row.commit();
                            }

                            // 确保目录存在
                            const dir = path.dirname(fullPath);
                            if (!fs.existsSync(dir)) {
                                fs.mkdirSync(dir, { recursive: true });
                            }

                            await workbook.xlsx.writeFile(fullPath);
                            return jsonResult({
                                file: fullPath,
                                sheet: sheetName,
                                rowsWritten: data.length,
                                startRow,
                            });
                        }

                        case 'create': {
                            const data = args.data as unknown[][] | undefined;
                            const workbook = new ExcelJS.Workbook();
                            const sheetName = readStringParam(args, 'sheet') || 'Sheet1';
                            const worksheet = workbook.addWorksheet(sheetName);

                            if (data && Array.isArray(data)) {
                                for (const rowData of data) {
                                    if (Array.isArray(rowData)) {
                                        worksheet.addRow(rowData);
                                    }
                                }
                            }

                            // 确保目录存在
                            const dir = path.dirname(fullPath);
                            if (!fs.existsSync(dir)) {
                                fs.mkdirSync(dir, { recursive: true });
                            }

                            await workbook.xlsx.writeFile(fullPath);
                            return jsonResult({
                                file: fullPath,
                                sheet: sheetName,
                                rowCount: data?.length || 0,
                                created: true,
                            });
                        }

                        default:
                            return errorResult(`Unknown excel sub-action: ${subAction}, supported: read/write/create`);
                    }
                }

                // ========================
                // Word 操作
                // ========================
                case 'word': {
                    switch (subAction) {
                        case 'read': {
                            if (!fs.existsSync(fullPath)) {
                                return errorResult(`File not found: ${fullPath}`);
                            }
                            const mammoth = await import('mammoth');
                            const buffer = fs.readFileSync(fullPath);
                            const result = await mammoth.extractRawText({ buffer });
                            const maxRows = readNumberParam(args, 'maxRows') || 500;
                            const lines = result.value.split('\n');
                            const truncated = lines.length > maxRows;
                            const text = truncated ? lines.slice(0, maxRows).join('\n') : result.value;

                            return jsonResult({
                                file: fullPath,
                                text,
                                lineCount: lines.length,
                                characterCount: result.value.length,
                                truncated,
                                messages: result.messages.map(m => m.message),
                            });
                        }

                        case 'create': {
                            const docx = await import('docx');
                            const docTitle = readStringParam(args, 'title') || '';
                            const paragraphs = args.paragraphs as string[] | undefined;

                            const children: any[] = [];

                            if (docTitle) {
                                children.push(new docx.Paragraph({
                                    text: docTitle,
                                    heading: docx.HeadingLevel.HEADING_1,
                                }));
                            }

                            if (paragraphs && Array.isArray(paragraphs)) {
                                for (const p of paragraphs) {
                                    children.push(new docx.Paragraph({ text: String(p) }));
                                }
                            }

                            const doc = new docx.Document({
                                sections: [{
                                    properties: {},
                                    children,
                                }],
                            });

                            const dir = path.dirname(fullPath);
                            if (!fs.existsSync(dir)) {
                                fs.mkdirSync(dir, { recursive: true });
                            }

                            const buffer = await docx.Packer.toBuffer(doc);
                            fs.writeFileSync(fullPath, buffer);

                            return jsonResult({
                                file: fullPath,
                                title: docTitle,
                                paragraphCount: paragraphs?.length || 0,
                                created: true,
                            });
                        }

                        default:
                            return errorResult(`Unknown word sub-action: ${subAction}, supported: read/create`);
                    }
                }

                // ========================
                // PDF 操作
                // ========================
                case 'pdf': {
                    switch (subAction) {
                        case 'read': {
                            if (!fs.existsSync(fullPath)) {
                                return errorResult(`File not found: ${fullPath}`);
                            }
                            // pdf-parse v2 导出 PDFParse 类
                            const pdfParseModule = (await import('pdf-parse')) as any;
                            const PDFParse = pdfParseModule.PDFParse ?? pdfParseModule.default?.PDFParse ?? pdfParseModule.default;
                            const buffer = fs.readFileSync(fullPath);
                            const parser = new PDFParse({ data: buffer });
                            const textResult = await parser.getText();
                            let info: any = {};
                            try {
                                const infoResult = await parser.getInfo();
                                info = infoResult.info || {};
                            } catch { /* 忽略元信息提取失败 */ }
                            await parser.destroy();

                            const fullText = textResult.text || '';
                            const maxRows = readNumberParam(args, 'maxRows') || 500;
                            const lines = fullText.split('\n');
                            const truncated = lines.length > maxRows;
                            const text = truncated ? lines.slice(0, maxRows).join('\n') : fullText;

                            return jsonResult({
                                file: fullPath,
                                text,
                                pageCount: textResult.total,
                                info,
                                lineCount: lines.length,
                                characterCount: fullText.length,
                                truncated,
                            });
                        }

                        default:
                            return errorResult(`Unknown pdf sub-action: ${subAction}, supported: read`);
                    }
                }

                // ========================
                // CSV 操作
                // ========================
                case 'csv': {
                    const delimiter = readStringParam(args, 'delimiter') || ',';
                    const encoding = (readStringParam(args, 'encoding') || 'utf-8') as BufferEncoding;

                    switch (subAction) {
                        case 'read': {
                            if (!fs.existsSync(fullPath)) {
                                return errorResult(`File not found: ${fullPath}`);
                            }
                            const content = fs.readFileSync(fullPath, encoding);
                            const maxRows = readNumberParam(args, 'maxRows') || 2000;
                            const startRow = readNumberParam(args, 'startRow') || 1;

                            // 简单 CSV 解析（支持引号包裹）
                            const allRows = parseCSV(content, delimiter, Infinity);
                            const totalRows = allRows.length;
                            const sliced = allRows.slice(startRow - 1, startRow - 1 + maxRows);
                            const endRow = startRow + sliced.length - 1;
                            const hasMore = endRow < totalRows;

                            return jsonResult({
                                file: fullPath,
                                totalRows,
                                returnedRows: sliced.length,
                                startRow,
                                endRow,
                                hasMore,
                                ...(hasMore ? { nextStartRow: endRow + 1 } : {}),
                                rows: sliced,
                            });
                        }

                        case 'write': {
                            const data = args.data as unknown[][] | undefined;
                            if (!data || !Array.isArray(data)) {
                                return errorResult('Missing data parameter (2D array)');
                            }

                            const dir = path.dirname(fullPath);
                            if (!fs.existsSync(dir)) {
                                fs.mkdirSync(dir, { recursive: true });
                            }

                            const csvContent = data.map(row => {
                                if (!Array.isArray(row)) return '';
                                return row.map(cell => {
                                    const str = String(cell ?? '');
                                    // 包含分隔符或引号或换行的字段需要引号包裹
                                    if (str.includes(delimiter) || str.includes('"') || str.includes('\n')) {
                                        return `"${str.replace(/"/g, '""')}"`;
                                    }
                                    return str;
                                }).join(delimiter);
                            }).join('\n');

                            fs.writeFileSync(fullPath, csvContent, encoding);
                            return jsonResult({
                                file: fullPath,
                                rowsWritten: data.length,
                                created: true,
                            });
                        }

                        default:
                            return errorResult(`Unknown csv sub-action: ${subAction}, supported: read/write`);
                    }
                }

                default:
                    return errorResult(`Unknown action: ${action}`);
            }
        },
    };
}

/**
 * 简单 CSV 解析（支持引号包裹字段）
 */
function parseCSV(content: string, delimiter: string, maxRows: number = Infinity): string[][] {
    const rows: string[][] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length && rows.length < maxRows; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const cells: string[] = [];
        let current = '';
        let inQuotes = false;

        for (let j = 0; j < line.length; j++) {
            const char = line[j];
            if (inQuotes) {
                if (char === '"') {
                    if (j + 1 < line.length && line[j + 1] === '"') {
                        current += '"';
                        j++;
                    } else {
                        inQuotes = false;
                    }
                } else {
                    current += char;
                }
            } else {
                if (char === '"') {
                    inQuotes = true;
                } else if (char === delimiter) {
                    cells.push(current);
                    current = '';
                } else {
                    current += char;
                }
            }
        }
        cells.push(current);
        rows.push(cells);
    }

    return rows;
}
