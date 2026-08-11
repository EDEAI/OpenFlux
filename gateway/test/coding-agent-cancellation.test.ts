import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runDriver, type DriverConfig } from '../src/tools/coding-agent';

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitForExit(pid: number, timeoutMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!isProcessAlive(pid)) return true;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return !isProcessAlive(pid);
}

test('aborting a coding driver terminates its descendant process tree', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'openflux-coding-abort-'));
    const controller = new AbortController();
    let descendantPid = 0;
    let reportPid!: (pid: number) => void;
    const pidReported = new Promise<number>(resolve => { reportPid = resolve; });
    const script = [
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        "process.stdout.write(String(child.pid) + '\\n');",
        'setInterval(() => {}, 1000);',
    ].join(' ');
    const driver: DriverConfig = {
        id: 'test',
        displayName: 'Test Driver',
        binaryHints: [],
        authCheckPaths: [],
        buildArgs: () => ['-e', script],
        extractSessionId: () => null,
        supportsResume: false,
        timeoutMs: 30_000,
    };

    try {
        const pending = runDriver(
            driver,
            process.execPath,
            '',
            cwd,
            null,
            line => {
                const pid = Number(line.trim());
                if (Number.isInteger(pid) && pid > 0) reportPid(pid);
            },
            undefined,
            controller.signal,
        );
        const pidTimeout = new Promise<number>((_, reject) => {
            const timer = setTimeout(() => reject(new Error('driver did not report child pid')), 5_000);
            timer.unref?.();
        });
        descendantPid = await Promise.race([pidReported, pidTimeout]);
        assert.equal(isProcessAlive(descendantPid), true);

        controller.abort(new Error('Stopped by user'));
        await assert.rejects(pending, /Stopped by user/);
        assert.equal(await waitForExit(descendantPid), true);
    } finally {
        if (descendantPid && isProcessAlive(descendantPid)) {
            try { process.kill(descendantPid, 'SIGKILL'); } catch { /* already exited */ }
        }
        await rm(cwd, { recursive: true, force: true });
    }
});
