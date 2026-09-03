import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { createOfficeTool } from './index';

test('Excel profile returns bounded schema metadata and samples', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'openflux-office-profile-'));
    const filePath = join(tempDir, 'people.xlsx');
    try {
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('名单');
        sheet.addRow(['姓名', '手机号', '状态']);
        for (let index = 1; index <= 100; index++) {
            sheet.addRow([`用户${index}`, `1380000${String(index).padStart(4, '0')}`, index % 4 === 0 ? '异常' : '正常']);
        }
        await workbook.xlsx.writeFile(filePath);

        const result = await createOfficeTool().execute({
            action: 'excel',
            subAction: 'profile',
            filePath,
        });
        assert.equal(result.success, true);
        const data = result.data as any;
        assert.equal(data.sheets[0].name, '名单');
        assert.equal(data.sheets[0].dataRows, 100);
        assert.deepEqual(data.sheets[0].headers, ['姓名', '手机号', '状态']);
        assert.equal(data.sheets[0].sampleRows.length, 5);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});

test('A guessed sheet name is answered with the names that do exist', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'openflux-office-sheets-'));
    const filePath = join(tempDir, 'report.xlsx');
    try {
        const workbook = new ExcelJS.Workbook();
        for (const name of ['Wechat channel', 'NBA Search Index']) {
            workbook.addWorksheet(name).addRow(['日期', '金额']);
        }
        await workbook.xlsx.writeFile(filePath);
        const office = createOfficeTool();

        // Both subactions accept a sheet name, so both can be handed a guessed one.
        for (const subAction of ['read', 'query']) {
            const result = await office.execute({
                action: 'excel',
                subAction,
                filePath,
                sheet: 'Wechat by Month Report',
                queryColumn: '金额',
                queryOperator: 'not_empty',
            });
            assert.equal(result.success, false);
            assert.match(String(result.error), /Sheet not found: Wechat by Month Report/);
            assert.match(String(result.error), /"Wechat channel", "NBA Search Index"/);
        }

        // The inventory also rides along on profile as a line terse enough to survive
        // the agent loop compacting an early tool result down to its summary.
        const profile = await office.execute({ action: 'excel', subAction: 'profile', filePath });
        assert.equal(
            (profile.data as any).summary,
            '2 sheets: "Wechat channel", "NBA Search Index"',
        );
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});

test('Excel query scans the complete sheet but returns a bounded evidence page with source rows', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'openflux-office-query-'));
    const filePath = join(tempDir, 'people.xlsx');
    try {
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('名单');
        sheet.addRow(['姓名', '手机号', '状态']);
        for (let index = 1; index <= 1_000; index++) {
            sheet.addRow([`用户${index}`, String(13000000000 + index), index % 10 === 0 ? '异常' : '正常']);
        }
        await workbook.xlsx.writeFile(filePath);

        const result = await createOfficeTool().execute({
            action: 'excel',
            subAction: 'query',
            filePath,
            sheet: '名单',
            queryColumn: '状态',
            queryOperator: 'equals',
            queryValue: '异常',
            selectColumns: ['姓名', '手机号'],
            maxRows: 10,
        });
        assert.equal(result.success, true);
        const data = result.data as any;
        assert.equal(data.scannedRows, 1_000);
        assert.equal(data.totalMatched, 100);
        assert.equal(data.returnedRows, 10);
        assert.equal(data.hasMore, true);
        assert.equal(data.rows[0].sourceRow, 11);
        assert.deepEqual(Object.keys(data.rows[0].values), ['姓名', '手机号']);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});

test('Excel read bounds a context page and advances nextStartRow without skipping unseen rows', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'openflux-office-page-'));
    const filePath = join(tempDir, 'rows.xlsx');
    try {
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('数据');
        sheet.addRow(['id', 'value']);
        for (let index = 1; index <= 1_000; index++) sheet.addRow([index, `value-${index}`]);
        await workbook.xlsx.writeFile(filePath);

        const tool = createOfficeTool();
        const first = await tool.execute({
            action: 'excel', subAction: 'read', filePath, sheet: '数据', startRow: 1, maxRows: 500,
        });
        assert.equal(first.success, true);
        const firstData = first.data as any;
        assert.equal(firstData.hasMore, true);
        assert.ok(firstData.returnedRows < 500);
        assert.ok(JSON.stringify(first).length < 8_000);

        const second = await tool.execute({
            action: 'excel',
            subAction: 'read',
            filePath,
            sheet: '数据',
            startRow: firstData.nextStartRow,
            maxRows: 500,
        });
        assert.equal(second.success, true);
        const secondData = second.data as any;
        assert.equal(secondData.startRow, firstData.endRow + 1);
        assert.equal(secondData.rows[0][0], firstData.endRow);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});

test('CSV query is case-insensitive by default and validates missing columns', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'openflux-csv-query-'));
    const filePath = join(tempDir, 'records.csv');
    try {
        await writeFile(filePath, [
            'name,status,note',
            'Alice,BLOCKED,first',
            'Bob,active,second',
            'Carol,blocked,third',
        ].join('\n'), 'utf8');

        const tool = createOfficeTool();
        const result = await tool.execute({
            action: 'csv',
            subAction: 'query',
            filePath,
            queryColumn: 'status',
            queryOperator: 'equals',
            queryValue: 'blocked',
            selectColumns: ['name'],
        });
        assert.equal(result.success, true);
        const data = result.data as any;
        assert.equal(data.totalMatched, 2);
        assert.deepEqual(data.rows.map((row: any) => row.values.name), ['Alice', 'Carol']);
        assert.deepEqual(data.rows.map((row: any) => row.sourceRow), [2, 4]);

        const invalid = await tool.execute({
            action: 'csv',
            subAction: 'query',
            filePath,
            queryColumn: 'missing',
            queryOperator: 'equals',
            queryValue: 'x',
        });
        assert.equal(invalid.success, false);
        assert.match(invalid.error || '', /Available columns/);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});
