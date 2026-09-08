import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';

const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'openflux-python-env-')));
let pythonEnv: typeof import('../src/utils/python-env');

before(async () => {
    const appData = process.env.APPDATA;
    process.env.APPDATA = fixtureRoot;
    try {
        pythonEnv = await import('../src/utils/python-env');
    } finally {
        if (appData === undefined) delete process.env.APPDATA;
        else process.env.APPDATA = appData;
    }
});

after(() => {
    for (const logger of (globalThis as any).__openflux_loggers__ ?? []) logger.close();
    rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function withRuntime(
    platform: 'win32' | 'darwin',
    files: string[],
    verify: (root: string) => void,
): void {
    const root = mkdtempSync(join(fixtureRoot, 'runtime-'));
    for (const file of files) {
        const path = join(root, file);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, 'fixture');
    }
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const resourcesDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
    const explicitRoot = process.env.OPENFLUX_RESOURCES;
    const cwd = process.cwd();
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });
    delete (process as any).resourcesPath;
    process.env.OPENFLUX_RESOURCES = root;
    try {
        verify(root);
    } finally {
        Object.defineProperty(process, 'platform', platformDescriptor);
        if (resourcesDescriptor) Object.defineProperty(process, 'resourcesPath', resourcesDescriptor);
        else delete (process as any).resourcesPath;
        if (explicitRoot === undefined) delete process.env.OPENFLUX_RESOURCES;
        else process.env.OPENFLUX_RESOURCES = explicitRoot;
        process.chdir(cwd);
    }
}

test('Windows installed Python and uv remain discoverable', () => {
    withRuntime('win32', ['python/base/python.exe', 'python/uv.exe'], (root) => {
        assert.equal(pythonEnv.getPythonExePath(), join(root, 'python/base/python.exe'));
        assert.equal(pythonEnv.getUvExePath(), join(root, 'python/uv.exe'));
        assert.equal(pythonEnv.getPythonEnvInfo().status, 'ready');
    });
});

test('Windows reduced NSIS layout reports the venv interpreter as ready', () => {
    withRuntime('win32', ['python/venv/Scripts/python.exe'], (root) => {
        assert.equal(pythonEnv.getPythonExePath(), join(root, 'python/venv/Scripts/python.exe'));
        assert.equal(pythonEnv.getPythonEnvInfo().pythonExe, pythonEnv.getPythonExePath());
        assert.equal(pythonEnv.isPythonReady(), true);
    });
});

test('macOS extracted framework uses bin/python3 and optional native uv', () => {
    withRuntime('darwin', ['python/base/bin/python3', 'python/base/bin/uv'], (root) => {
        assert.equal(pythonEnv.getPythonExePath(), join(root, 'python/base/bin/python3'));
        assert.equal(pythonEnv.getPythonBasePath(), join(root, 'python/base'));
        assert.equal(pythonEnv.getUvExePath(), join(root, 'python/base/bin/uv'));
        assert.equal(pythonEnv.getPythonEnvInfo().status, 'ready');
    });
});

test('macOS alternate Python layout is accepted without Windows executable names', () => {
    withRuntime('darwin', ['python/bin/python', 'python/uv'], (root) => {
        assert.equal(pythonEnv.getPythonExePath(), join(root, 'python/bin/python'));
        assert.equal(pythonEnv.getUvExePath(), join(root, 'python/uv'));
        assert.equal(pythonEnv.isPythonReady(), true);
    });
});

for (const platform of ['win32', 'darwin'] as const) {
    const executable = platform === 'win32' ? 'python/base/python.exe' : 'python/base/bin/python3';

    test(`${platform} resourcesPath resolves an interpreter in its parent installation`, () => {
        withRuntime(platform, [executable], (root) => {
            delete process.env.OPENFLUX_RESOURCES;
            Object.defineProperty(process, 'resourcesPath', {
                configurable: true, value: join(root, 'resources'),
            });
            assert.equal(pythonEnv.getPythonExePath(), join(root, executable));
        });
    });

    test(`${platform} gateway working directory resolves the installed runtime`, () => {
        withRuntime(platform, [executable], (root) => {
            delete process.env.OPENFLUX_RESOURCES;
            const gateway = join(root, 'gateway');
            mkdirSync(gateway);
            process.chdir(gateway);
            assert.equal(pythonEnv.getPythonExePath(), join(root, executable));
        });
    });

    test(`${platform} explicit missing runtime remains not installed`, () => {
        withRuntime(platform, [executable], (root) => {
            const missingRoot = join(root, 'missing');
            process.env.OPENFLUX_RESOURCES = missingRoot;
            process.chdir(root);
            assert.equal(pythonEnv.getPythonExePath(), join(missingRoot, executable));
            assert.equal(pythonEnv.isPythonReady(), false);
        });
    });
}
