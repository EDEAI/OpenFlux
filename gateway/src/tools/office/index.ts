/**
 * Office Document Processing Tools - Factory Mode
 * Supports reading and writing operations of Excel/Word/PDF/CSV
 * assigned to coder agent
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AnyTool, ToolResult } from '../types';
import {
    validateAction,
    readBooleanParam,
    readStringArrayParam,
    readStringParam,
    readNumberParam,
    jsonResult,
    errorResult,
} from '../common';

// Supported actions
const OFFICE_ACTIONS = [
    'excel',  // Excel operations
    'word',   // Word operations
    'pdf',    // PDF Operations
    'csv',    // CSV Operations
] as const;

type OfficeAction = typeof OFFICE_ACTIONS[number];

export interface OfficeToolOptions {
    /** Default working directory */
    basePath?: string | (() => string);
    /** Write whitelist (only checked during writing operations, reading is not restricted) */
    allowedWritePaths?: string[] | (() => string[]);
    /** Global output mode archives by date; project workspaces write paths verbatim. */
    useDateSubdirectory?: boolean | (() => boolean);
}

const TABLE_QUERY_OPERATORS = [
    'equals', 'not_equals', 'contains', 'not_contains', 'is_empty', 'not_empty',
] as const;
type TableQueryOperator = typeof TABLE_QUERY_OPERATORS[number];

function normalizeTableRow(values: unknown[]): unknown[] {
    return values.length > 0 && values[0] === undefined ? values.slice(1) : [...values];
}

function normalizedHeaders(row: unknown[]): string[] {
    return row.map((value, index) => {
        const text = String(value ?? '').trim();
        return (text.length > 120 ? text.slice(0, 117) + '...' : text) || `Column ${index + 1}`;
    });
}

function boundedTableCell(value: unknown, maxChars = 500): unknown {
    if (typeof value !== 'string') return value ?? null;
    return value.length > maxChars ? value.slice(0, maxChars) + '…[cell truncated]' : value;
}

/** The shape of an ExcelJS workbook this module needs to describe its worksheets. */
interface WorksheetIndex {
    worksheets: { name: string; rowCount: number; columnCount: number }[];
}

/**
 * One-line worksheet inventory, small enough to survive context compaction.
 *
 * Names only, deliberately: row and column counts trebled the length and pushed a
 * twelve-sheet workbook past the tightest compaction tier, which then elided real
 * sheet names out of the middle. Dimensions come back from any `read`, whereas a
 * name that has been dropped can only be guessed at.
 */
function sheetInventory(workbook: WorksheetIndex): string {
    const sheets = workbook.worksheets.map(sheet => `"${sheet.name}"`).join(', ');
    return `${workbook.worksheets.length} sheets: ${sheets}`;
}

/**
 * A missing worksheet is nearly always a guessed name, so name the alternatives.
 * Without them the caller can only guess again, and identical dead-end failures
 * are what trip the loop's repeated-failure breaker and end the turn.
 */
function sheetNotFoundError(sheetName: string | undefined, workbook: WorksheetIndex): string {
    const available = workbook.worksheets.map(sheet => `"${sheet.name}"`).join(', ');
    return `Sheet not found: ${sheetName || '(default)'}. Available sheets: ${available || '(none)'}`;
}

function resolveQueryColumn(column: string, headers: string[]): number {
    const numeric = Number.parseInt(column, 10);
    if (/^\d+$/.test(column) && numeric >= 1 && numeric <= headers.length) return numeric - 1;
    const exact = headers.findIndex(header => header === column);
    if (exact >= 0) return exact;
    const lower = column.toLowerCase();
    return headers.findIndex(header => header.toLowerCase() === lower);
}

function queryMatches(
    cell: unknown,
    operator: TableQueryOperator,
    expected: string,
    caseSensitive: boolean,
): boolean {
    const raw = String(cell ?? '');
    const actual = caseSensitive ? raw : raw.toLowerCase();
    const target = caseSensitive ? expected : expected.toLowerCase();
    switch (operator) {
        case 'equals': return actual === target;
        case 'not_equals': return actual !== target;
        case 'contains': return actual.includes(target);
        case 'not_contains': return !actual.includes(target);
        case 'is_empty': return raw.trim().length === 0;
        case 'not_empty': return raw.trim().length > 0;
    }
}

function queryTableRows(
    rows: unknown[][],
    args: Record<string, unknown>,
    sourceRowOffset = 1,
): ToolResult {
    if (rows.length === 0) return jsonResult({ headers: [], scannedRows: 0, totalMatched: 0, rows: [] });
    const headers = normalizedHeaders(normalizeTableRow(rows[0]));
    const column = readStringParam(args, 'queryColumn');
    if (!column) return errorResult('queryColumn is required for query (header name or 1-based column number)');
    const columnIndex = resolveQueryColumn(column, headers);
    if (columnIndex < 0) return errorResult(`Query column not found: ${column}. Available columns: ${headers.join(', ')}`);

    const operatorValue = readStringParam(args, 'queryOperator') || 'equals';
    if (!TABLE_QUERY_OPERATORS.includes(operatorValue as TableQueryOperator)) {
        return errorResult(`Unsupported queryOperator: ${operatorValue}`);
    }
    const operator = operatorValue as TableQueryOperator;
    const expected = readStringParam(args, 'queryValue', { trim: false, allowEmpty: true }) || '';
    const caseSensitive = readBooleanParam(args, 'caseSensitive', false);
    const requestedColumns = readStringArrayParam(args, 'selectColumns');
    const selectedIndices = requestedColumns?.map(name => resolveQueryColumn(name, headers));
    if (selectedIndices?.some(index => index < 0)) {
        const missing = requestedColumns?.filter((_name, index) => selectedIndices[index] < 0) || [];
        return errorResult(`Selected columns not found: ${missing.join(', ')}`);
    }
    const projection = selectedIndices?.length ? selectedIndices : headers.map((_header, index) => index);
    const limit = Math.max(1, Math.min(100, Math.trunc(readNumberParam(args, 'maxRows') || 50)));

    let totalMatched = 0;
    let evidenceChars = 0;
    const matches: Array<{ sourceRow: number; values: Record<string, unknown> }> = [];
    for (let index = 1; index < rows.length; index++) {
        const row = normalizeTableRow(rows[index]);
        if (!queryMatches(row[columnIndex], operator, expected, caseSensitive)) continue;
        totalMatched++;
        if (matches.length >= limit) continue;
        const values: Record<string, unknown> = {};
        for (const selectedIndex of projection) {
            values[headers[selectedIndex]] = boundedTableCell(row[selectedIndex]);
        }
        const match = { sourceRow: index + sourceRowOffset, values };
        const matchChars = JSON.stringify(match).length;
        if (matches.length > 0 && evidenceChars + matchChars > 6_000) continue;
        evidenceChars += matchChars;
        matches.push(match);
    }

    return jsonResult({
        headers,
        query: { column: headers[columnIndex], operator, value: expected, caseSensitive },
        scannedRows: Math.max(0, rows.length - 1),
        totalMatched,
        returnedRows: matches.length,
        hasMore: totalMatched > matches.length,
        rows: matches,
    });
}

function boundedReadPage(
    rows: unknown[][],
    startRow: number,
    maxRows: number,
): { rows: unknown[][]; endRow: number; columnsTruncated: boolean } {
    const page: unknown[][] = [];
    let pageChars = 0;
    let columnsTruncated = false;
    const firstIndex = Math.max(0, startRow - 1);
    const lastExclusive = Math.min(rows.length, firstIndex + maxRows);
    for (let index = firstIndex; index < lastExclusive; index++) {
        const normalized = [...rows[index]];
        if (normalized.length > 50) columnsTruncated = true;
        const bounded = normalized.slice(0, 50).map(value => boundedTableCell(value, 120));
        const rowChars = JSON.stringify(bounded).length;
        if (page.length > 0 && pageChars + rowChars > 6_000) break;
        page.push(bounded);
        pageChars += rowChars;
    }
    return {
        rows: page,
        endRow: page.length > 0 ? startRow + page.length - 1 : startRow - 1,
        columnsTruncated,
    };
}

/**
 * Create Office document processing tools
 */
export function createOfficeTool(opts: OfficeToolOptions = {}): AnyTool {
    const getBasePath = (): string => {
        const configured = typeof opts.basePath === 'function' ? opts.basePath() : opts.basePath;
        return configured || process.cwd();
    };
    const allowedWritePaths = opts.allowedWritePaths;

    // Parse paths (use system separators uniformly)
    const resolvePath = (inputPath: string): string => {
        if (path.isAbsolute(inputPath)) return path.normalize(inputPath);
        return path.resolve(getBasePath(), inputPath);
    };

    // Write path parsing: automatically inject date subdirectories
    // basePath is the outputPath (such as D:\openflux_output), and the YYYY-MM-DD/ subdirectory is automatically created under it when writing.
    const resolveWritePath = (inputPath: string): string => {
        // Absolute paths are used directly
        if (path.isAbsolute(inputPath)) return path.normalize(inputPath);

        // Remove the output/ prefix that may be passed in by LLM (basePath is already the output directory)
        let cleanPath = inputPath.replace(/^output[\\/]/i, '');

        const useDateSubdirectory = typeof opts.useDateSubdirectory === 'function'
            ? opts.useDateSubdirectory()
            : opts.useDateSubdirectory ?? true;
        if (!useDateSubdirectory) return path.resolve(getBasePath(), cleanPath);

        // Check if the path already contains a date directory (YYYY-MM-DD)
        const normalized = cleanPath.replace(/\\/g, '/');
        const datePattern = /(?:^|\/)(\d{4}-\d{2}-\d{2})(?:\/|$)/;
        if (datePattern.test(normalized)) {
            // If there is already a date path, resolve directly to basePath.
            return path.resolve(getBasePath(), cleanPath);
        }

        // No date path -> auto-inject YYYY-MM-DD/
        const today = new Date();
        const yyyy = today.getFullYear();
        const mm = String(today.getMonth() + 1).padStart(2, '0');
        const dd = String(today.getDate()).padStart(2, '0');
        const dateDir = `${yyyy}-${mm}-${dd}`;

        return path.resolve(getBasePath(), dateDir, cleanPath);
    };

    // Write path whitelist check (compare after normalize to avoid forward and backslash mismatch)
    const checkWritePath = (filePath: string): void => {
        const currentAllowedWritePaths = typeof allowedWritePaths === 'function'
            ? allowedWritePaths()
            : allowedWritePaths;
        if (currentAllowedWritePaths && currentAllowedWritePaths.length > 0) {
            const normalizedFile = path.normalize(filePath).toLowerCase();
            const allowed = currentAllowedWritePaths.some((p) => {
                const resolved = path.normalize(resolvePath(p)).toLowerCase();
                return normalizedFile.startsWith(resolved);
            });
            if (!allowed) {
                const resolvedHints = currentAllowedWritePaths.map(p => resolvePath(p));
                throw new Error(`Write path is not in the allowed range: ${filePath}\nAllowed directories: ${resolvedHints.join(', ')}`);
            }
        }
    };

    return {
        name: 'office',
        priority: 55,
        description: `Office 文档处理工具，支持 Excel/Word/PDF/CSV 的读写操作。
excel 子操作: profile(字段/行数/样例), query(全表确定性筛选), read(分页读取), write(写入), create(新建)
word 子操作: read(读取文档文本), create(创建 Word 文档)
pdf 子操作: read(读取 PDF 文本和元信息)
csv 子操作: profile(字段/行数/样例), query(全表确定性筛选), read(分页读取), write(写入 CSV)

选路提示：read 每次最多 500 行，用来看具体行，不适合汇总整表。若结论需要跨全表的聚合（分组计数、求和、均值、Top N、趋势），先用 profile 拿到工作表名与字段，然后直接在一个脚本里读原文件算完，不要先用 read 把各工作表逐页翻一遍再用脚本重读同一文件——那会把同一份数据摄取两次并耗尽本轮预算。`,

        parameters: {
            action: {
                type: 'string',
                description: `Action type: ${OFFICE_ACTIONS.join('/')}`,
                required: true,
                enum: [...OFFICE_ACTIONS],
            },
            subAction: {
                type: 'string',
                description: 'Sub-action: profile/query/read/write/create',
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
                description: 'Excel/CSV read: Maximum rows to return per call (default 200, hard cap 500). Continue from nextStartRow when hasMore=true. Query returns at most 100 bounded evidence rows.',
            },
            queryColumn: {
                type: 'string',
                description: 'Excel/CSV query: header name or 1-based column number to filter across the complete table',
            },
            queryOperator: {
                type: 'string',
                description: `Excel/CSV query operator: ${TABLE_QUERY_OPERATORS.join('/')}`,
                enum: [...TABLE_QUERY_OPERATORS],
            },
            queryValue: {
                type: 'string',
                description: 'Excel/CSV query target value (not needed for is_empty/not_empty)',
            },
            caseSensitive: {
                type: 'boolean',
                description: 'Excel/CSV query: whether string matching is case-sensitive (default false)',
            },
            selectColumns: {
                type: 'array',
                description: 'Excel/CSV query: optional header names or 1-based columns to return',
                items: { type: 'string' },
            },
            // Word parameters
            title: {
                type: 'string',
                description: 'Word create: Document title',
            },
            paragraphs: {
                type: 'array',
                description: 'Word create: Paragraph content array ["paragraph1", "paragraph2"]',
                items: { type: 'string' },
            },
            // CSV parameters
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
            // Write operation check whitelist
            if (isWrite) {
                checkWritePath(fullPath);
            }

            switch (action) {
                // ========================
                // Excel operations
                // ========================
                case 'excel': {
                    const excelMod = await import('exceljs');
                    const ExcelJS = (excelMod as any).default || excelMod;

                    switch (subAction) {
                        case 'profile': {
                            if (!fs.existsSync(fullPath)) {
                                return errorResult(`File not found: ${fullPath}`);
                            }
                            const workbook = new ExcelJS.Workbook();
                            await workbook.xlsx.readFile(fullPath);
                            return jsonResult({
                                file: fullPath,
                                // The worksheet inventory is the map every later read and query
                                // depends on, and a profile payload is large enough to be the first
                                // thing the loop's context compaction discards. Restating it as a
                                // summary keeps the sheet names reachable even after the row samples
                                // below have been squeezed out of the transcript.
                                summary: sheetInventory(workbook),
                                sheets: workbook.worksheets.map(worksheet => {
                                    const headerValues = worksheet.getRow(1).values as unknown[];
                                    const headers = normalizedHeaders(normalizeTableRow(headerValues));
                                    const sampleRows: unknown[][] = [];
                                    for (let rowNumber = 2; rowNumber <= Math.min(worksheet.rowCount, 6); rowNumber++) {
                                        sampleRows.push(normalizeTableRow(worksheet.getRow(rowNumber).values as unknown[])
                                            .map(value => boundedTableCell(value, 200)));
                                    }
                                    return {
                                        name: worksheet.name,
                                        totalRows: worksheet.rowCount,
                                        dataRows: Math.max(0, worksheet.rowCount - 1),
                                        columnCount: worksheet.columnCount,
                                        headers,
                                        sampleRows,
                                    };
                                }),
                            });
                        }

                        case 'query': {
                            if (!fs.existsSync(fullPath)) {
                                return errorResult(`File not found: ${fullPath}`);
                            }
                            const workbook = new ExcelJS.Workbook();
                            await workbook.xlsx.readFile(fullPath);
                            const sheetName = readStringParam(args, 'sheet');
                            const worksheet = sheetName
                                ? workbook.getWorksheet(sheetName)
                                : workbook.worksheets[0];
                            if (!worksheet) return errorResult(sheetNotFoundError(sheetName, workbook));
                            const rows: unknown[][] = [];
                            worksheet.eachRow({ includeEmpty: true }, row => {
                                rows.push(normalizeTableRow(row.values as unknown[]));
                            });
                            const queried = queryTableRows(rows, args);
                            if (!queried.success) return queried;
                            return jsonResult({
                                file: fullPath,
                                sheet: worksheet.name,
                                sheets: workbook.worksheets.map(item => item.name),
                                ...(queried.data as Record<string, unknown>),
                            });
                        }

                        case 'read': {
                            if (!fs.existsSync(fullPath)) {
                                return errorResult(`File not found: ${fullPath}`);
                            }
                            const workbook = new ExcelJS.Workbook();
                            await workbook.xlsx.readFile(fullPath);

                            const sheetName = readStringParam(args, 'sheet');
                            const maxRows = Math.max(1, Math.min(500, Math.trunc(readNumberParam(args, 'maxRows') || 200)));
                            const startRow = readNumberParam(args, 'startRow') || 1;
                            const worksheet = sheetName
                                ? workbook.getWorksheet(sheetName)
                                : workbook.worksheets[0];

                            if (!worksheet) {
                                return errorResult(sheetNotFoundError(sheetName, workbook));
                            }

                            const totalRows = worksheet.rowCount;
                            const requestedRows: unknown[][] = [];
                            const lastRequestedRow = Math.min(totalRows, startRow + maxRows - 1);
                            for (let rowNumber = startRow; rowNumber <= lastRequestedRow; rowNumber++) {
                                requestedRows.push(normalizeTableRow(worksheet.getRow(rowNumber).values as unknown[]));
                            }
                            const page = boundedReadPage(requestedRows, 1, maxRows);
                            const rows = page.rows;
                            const endRow = rows.length > 0 ? startRow + rows.length - 1 : startRow - 1;
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
                                columnsTruncated: page.columnsTruncated,
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

                            // Make sure the directory exists
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

                            // Make sure the directory exists
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
                            return errorResult(`Unknown excel sub-action: ${subAction}, supported: profile/query/read/write/create`);
                    }
                }

                // ========================
                // Word operations
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
                // PDF Operations
                // ========================
                case 'pdf': {
                    switch (subAction) {
                        case 'read': {
                            if (!fs.existsSync(fullPath)) {
                                return errorResult(`File not found: ${fullPath}`);
                            }
                            // pdf-parse v2 exports PDFParse class
                            const pdfParseModule = (await import('pdf-parse')) as any;
                            const PDFParse = pdfParseModule.PDFParse ?? pdfParseModule.default?.PDFParse ?? pdfParseModule.default;
                            const buffer = fs.readFileSync(fullPath);
                            const parser = new PDFParse({ data: buffer });
                            const textResult = await parser.getText();
                            let info: any = {};
                            try {
                                const infoResult = await parser.getInfo();
                                info = infoResult.info || {};
                            } catch { /* Ignore meta-information extraction failure */ }
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
                // CSV Operations
                // ========================
                case 'csv': {
                    const delimiter = readStringParam(args, 'delimiter') || ',';
                    const encoding = (readStringParam(args, 'encoding') || 'utf-8') as BufferEncoding;

                    switch (subAction) {
                        case 'profile': {
                            if (!fs.existsSync(fullPath)) {
                                return errorResult(`File not found: ${fullPath}`);
                            }
                            const content = fs.readFileSync(fullPath, encoding);
                            const rows = parseCSV(content, delimiter, Infinity);
                            const headers = rows.length > 0 ? normalizedHeaders(rows[0]) : [];
                            return jsonResult({
                                file: fullPath,
                                totalRows: rows.length,
                                dataRows: Math.max(0, rows.length - 1),
                                columnCount: headers.length,
                                headers,
                                sampleRows: rows.slice(1, 6).map(row => row.map(value => boundedTableCell(value, 200))),
                            });
                        }

                        case 'query': {
                            if (!fs.existsSync(fullPath)) {
                                return errorResult(`File not found: ${fullPath}`);
                            }
                            const content = fs.readFileSync(fullPath, encoding);
                            const rows = parseCSV(content, delimiter, Infinity);
                            const queried = queryTableRows(rows, args);
                            if (!queried.success) return queried;
                            return jsonResult({
                                file: fullPath,
                                ...(queried.data as Record<string, unknown>),
                            });
                        }

                        case 'read': {
                            if (!fs.existsSync(fullPath)) {
                                return errorResult(`File not found: ${fullPath}`);
                            }
                            const content = fs.readFileSync(fullPath, encoding);
                            const maxRows = Math.max(1, Math.min(500, Math.trunc(readNumberParam(args, 'maxRows') || 200)));
                            const startRow = readNumberParam(args, 'startRow') || 1;

                            // Simple CSV parsing (supports quotation marks)
                            const allRows = parseCSV(content, delimiter, Infinity);
                            const totalRows = allRows.length;
                            const page = boundedReadPage(allRows, startRow, maxRows);
                            const sliced = page.rows;
                            const endRow = page.endRow;
                            const hasMore = endRow < totalRows;

                            return jsonResult({
                                file: fullPath,
                                totalRows,
                                returnedRows: sliced.length,
                                startRow,
                                endRow,
                                hasMore,
                                columnsTruncated: page.columnsTruncated,
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
                                    // Fields containing delimiters or quotes or newlines need to be quoted.
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
                            return errorResult(`Unknown csv sub-action: ${subAction}, supported: profile/query/read/write`);
                    }
                }

                default:
                    return errorResult(`Unknown action: ${action}`);
            }
        },
    };
}

/**
 * Simple CSV parsing (supports quoted fields)
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
