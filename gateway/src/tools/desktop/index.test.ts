import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import ts from 'typescript';

const desktopSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const windowsSource = readFileSync(new URL('./windows-driver.ts', import.meta.url), 'utf8');
const commonSource = readFileSync(new URL('../common.ts', import.meta.url), 'utf8');
const moduleUrl = (source: string) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;

/** Keep real ES modules and dynamic imports; replace only platform/OS boundaries. */
function compileModule(source: string, imports = new Map<string, string>()): string {
    return ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        transformers: {
            before: [context => {
                const visit: ts.Visitor = node => ts.isStringLiteral(node) && imports.has(node.text)
                    ? ts.factory.createStringLiteral(imports.get(node.text)!)
                    : ts.visitEachChild(node, visit, context);
                return sourceFile => ts.visitNode(sourceFile, visit) as ts.SourceFile;
            }],
        },
    }).outputText;
}

async function createHarness(t: TestContext, platform: string, failFirst = false) {
    const key = `desktop-esm-${randomUUID()}`;
    const audit = { loads: [] as string[], constructions: 0, paths: [] as string[], commands: [] as string[], directories: [] as string[], failRemaining: failFirst ? 1 : 0 };
    (globalThis as any)[key] = audit;
    t.after(() => { delete (globalThis as any)[key]; });
    const auditRef = `const audit = globalThis[${JSON.stringify(key)}];`;
    const driver = (target: 'win32' | 'darwin') => moduleUrl(`${auditRef}
        audit.loads.push(${JSON.stringify(target)});
        export class ${target === 'darwin' ? 'MacOSDesktopDriver' : 'WindowsDesktopDriver'} {
            constructor(screenshotDir) {
                audit.constructions++; audit.paths.push(screenshotDir);
                if (audit.failRemaining > 0) { audit.failRemaining--; throw new Error('Driver temporarily unavailable'); }
            }
            getScreenSize() { return { width: 1440, height: 900 }; }
            ${target === 'win32' ? 'captureRaw() { return { data: Buffer.alloc(4), width: 1, height: 1, format: "rgba" }; }' : ''}
        }
    `);
    const fileSystem = moduleUrl(`${auditRef}
        export function mkdirSync(directory) { audit.directories.push(directory); }
        export function writeFileSync() {}
    `);
    const childProcess = moduleUrl(`${auditRef}
        export function execSync(command) { audit.commands.push(command); return ''; }
    `);
    const imports = new Map([
        ['../common', moduleUrl(compileModule(commonSource))],
        ['./macos-driver', driver('darwin')],
        ['./windows-driver', driver('win32')],
        ['fs', fileSystem],
        ['child_process', childProcess],
        ['node:child_process', childProcess],
    ]);
    const source = `const process = { platform: ${JSON.stringify(platform)} };\n${compileModule(desktopSource, imports)}`;
    const module = await import(moduleUrl(source));
    return { audit, tool: module.createDesktopTool({ screenshotDir: 'desktop-test-output' }) };
}

for (const platform of ['darwin', 'win32']) {
    test(`${platform}: ESM desktop actions lazily load only their platform and share initialization`, async t => {
        const h = await createHarness(t, platform);
        assert.deepEqual(h.audit.loads, [], 'registering the tool must not load native drivers');
        const results = await Promise.all(Array.from({ length: 3 }, () => h.tool.execute({ action: 'screen', subAction: 'getSize' })));
        for (const result of results) assert.deepEqual(result, { success: true, data: { width: 1440, height: 900 } });
        assert.deepEqual(h.audit.loads, [platform], 'the other platform must not be imported');
        assert.equal(h.audit.constructions, 1, 'concurrent first actions must share one driver');
        assert.deepEqual(h.audit.paths, ['desktop-test-output']);
        assert.deepEqual(h.audit.commands, [], 'reading dimensions must not start an OS command in this harness');
    });
}

test('a failed desktop driver initialization can be retried by the next action', async t => {
    const h = await createHarness(t, 'darwin', true);
    const first = await h.tool.execute({ action: 'screen', subAction: 'getSize' });
    assert.equal(first.success, false);
    assert.match(first.error, /Driver temporarily unavailable/);
    const second = await h.tool.execute({ action: 'screen', subAction: 'getSize' });
    assert.deepEqual(second, { success: true, data: { width: 1440, height: 900 } });
    assert.equal(h.audit.constructions, 2);
    assert.deepEqual(h.audit.loads, ['darwin']);
});

test('unsupported platforms return a useful error without importing either native driver', async t => {
    const h = await createHarness(t, 'linux');
    const result = await h.tool.execute({ action: 'screen', subAction: 'getSize' });
    assert.equal(result.success, false);
    assert.match(result.error, /Unsupported platform: linux/);
    assert.deepEqual(h.audit.loads, []);
});

test('stopping a Windows recording invokes the ESM child_process encoder instead of silently skipping it', async t => {
    const h = await createHarness(t, 'win32');
    try {
        const started = await h.tool.execute({ action: 'screen', subAction: 'record', text: 'start' });
        assert.equal(started.success, true);
        assert.equal(started.data.recording, true);
        const stopped = await h.tool.execute({ action: 'screen', subAction: 'record', text: 'stop' });
        assert.equal(stopped.success, true);
        assert.equal(stopped.data.recording, false);
        assert.match(stopped.data.videoPath, /recording_\d+\.mp4$/);
        assert.equal(h.audit.commands.length, 2);
        assert.equal(h.audit.commands[0], 'ffmpeg -version');
        assert.match(h.audit.commands[1], /^ffmpeg -y -framerate 2 -i /);
    } finally {
        await h.tool.execute({ action: 'screen', subAction: 'record', text: 'stop' });
    }
});

test('Windows native keysender uses an ESM-safe loader and is still loaded on first use only', async t => {
    const key = `desktop-keysender-${randomUUID()}`;
    const loads: string[] = [];
    (globalThis as any)[key] = loads;
    t.after(() => { delete (globalThis as any)[key]; });
    const loader = moduleUrl(`
        export function createRequire(moduleUrl) {
            if (!moduleUrl.startsWith('data:')) throw new Error('Expected current ESM module URL');
            return name => {
                globalThis[${JSON.stringify(key)}].push(name);
                if (name !== 'keysender') throw new Error('Unexpected native dependency');
                return { getScreenSize: () => ({ width: 1920, height: 1080 }) };
            };
        }
    `);
    const module = await import(moduleUrl(compileModule(windowsSource, new Map([['node:module', loader]]))));
    const driver = new module.WindowsDesktopDriver();
    assert.deepEqual(loads, []);
    assert.deepEqual(driver.getScreenSize(), { width: 1920, height: 1080 });
    assert.deepEqual(driver.getScreenSize(), { width: 1920, height: 1080 });
    assert.deepEqual(loads, ['keysender']);
});
