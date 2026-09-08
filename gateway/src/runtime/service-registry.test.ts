import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ServiceRegistry, agentIdFromSessionId, looksLongRunning } from './service-registry';

const SERVER_SCRIPT = `
const http = require('http');
const server = http.createServer((req, res) => { res.end('ok'); });
server.listen(0, '127.0.0.1', () => {
  console.log('listening on http://localhost:' + server.address().port);
});
setInterval(() => {}, 1000);
`;

test('looksLongRunning flags servers and watchers, not builds or tests', () => {
    for (const cmd of ['npm run dev -- --host', 'pnpm dev', 'npx vite', 'php artisan serve --port=8000', 'php -S localhost:8080', 'python -m http.server 8000', 'uvicorn app:app', 'cmd /c "cd /d D:\\x && start /b npm run dev"']) {
        assert.equal(looksLongRunning(cmd), true, cmd);
    }
    for (const cmd of ['npm run build', 'npm test', 'git status', 'php artisan migrate', 'python script.py', 'type file.txt']) {
        assert.equal(looksLongRunning(cmd), false, cmd);
    }
});

test('agentIdFromSessionId reads the agent out of both session id shapes', () => {
    assert.equal(agentIdFromSessionId('user-agent:project-834df02c'), 'project-834df02c');
    assert.equal(agentIdFromSessionId('agent_b4792af0_main'), 'b4792af0');
    assert.equal(agentIdFromSessionId(undefined), undefined);
});

test('registry starts, detects the port, reports status/logs, persists, and stops a service', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ofx-svc-'));
    const script = join(dir, 'server.js');
    writeFileSync(script, SERVER_SCRIPT);
    const registry = new ServiceRegistry(dir);
    try {
        const svc = await registry.start({
            command: process.execPath,
            args: [script],
            cwd: dir,
            name: 'test-api',
            sessionId: 'user-agent:project-abc',
            workspaceRoot: dir,
        });
        assert.equal(svc.status, 'running');
        assert.equal(svc.agentId, 'project-abc');
        assert.ok(svc.port && svc.port > 0, 'port detected from output');
        assert.equal(svc.url, `http://localhost:${svc.port}`);

        const status = await registry.status('test-api');
        assert.equal(status.alive, true);
        assert.equal(status.portOpen, true);
        assert.match(registry.tailLog(svc.id, 10), /listening on/);

        // A second registry over the same store sees the record (persistence).
        const reloaded = new ServiceRegistry(dir);
        assert.equal(reloaded.list({ sessionId: 'user-agent:project-abc' })[0]?.id, svc.id);
        assert.equal(reloaded.resolve(svc.port!)?.id, svc.id);

        const stopped = await registry.stop(svc.port!);
        assert.equal(stopped.status, 'killed');
        await new Promise(r => setTimeout(r, 300));
        const after = await registry.status(svc.id);
        assert.equal(after.alive, false);
        assert.equal(registry.list({ runningOnly: true }).length, 0);
    } finally {
        for (const s of registry.list({ runningOnly: true })) await registry.stop(s.id).catch(() => undefined);
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a command that dies immediately is reported as a failed start with its log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ofx-svc-'));
    const registry = new ServiceRegistry(dir);
    try {
        await assert.rejects(
            registry.start({ command: process.execPath, args: ['-e', 'console.error("boom"); process.exit(3)'], cwd: dir }),
            /exited immediately with code 3[\s\S]*boom/,
        );
        assert.equal(registry.list()[0]?.status, 'exited');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('stopAll on shutdown stops everything except keepAlive; reapOrphans kills leftovers of a previous run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ofx-svc-'));
    const script = join(dir, 'server.js');
    writeFileSync(script, SERVER_SCRIPT);
    const registry = new ServiceRegistry(dir);
    try {
        const normal = await registry.start({ command: process.execPath, args: [script], cwd: dir, name: 'normal' });
        const sticky = await registry.start({ command: process.execPath, args: [script], cwd: dir, name: 'sticky', keepAlive: true });

        const stopped = await registry.stopAll('test shutdown');
        assert.deepEqual(stopped.map(s => s.name), ['normal']);
        assert.equal((await registry.status(sticky.id)).alive, true, 'keepAlive survives stopAll');
        assert.equal((await registry.status(normal.id)).alive, false);

        // Simulate the gateway coming back: a fresh registry over the same
        // store finds `sticky` still running — keepAlive, so it is left alone;
        // a non-keepAlive leftover is reaped.
        const leftover = await registry.start({ command: process.execPath, args: [script], cwd: dir, name: 'leftover' });
        const revived = new ServiceRegistry(dir);
        const reaped = await revived.reapOrphans();
        assert.deepEqual(reaped.map(s => s.name), ['leftover']);
        await new Promise(r => setTimeout(r, 300));
        assert.equal((await revived.status(leftover.id)).alive, false);
        assert.equal((await revived.status(sticky.id)).alive, true);
        await revived.stop(sticky.id);
    } finally {
        for (const s of registry.list({ runningOnly: true })) await registry.stop(s.id).catch(() => undefined);
        rmSync(dir, { recursive: true, force: true });
    }
});

test('output of a server started through a shell shim (cmd → node) lands in the log', { skip: process.platform !== 'win32' }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ofx-svc-'));
    writeFileSync(join(dir, 'server.js'), SERVER_SCRIPT);
    const registry = new ServiceRegistry(dir);
    try {
        // Same shape agents use for npm/vite: a bare shell command, args through cmd.
        const svc = await registry.start({ command: 'cmd', args: ['/c', 'node server.js'], cwd: dir, name: 'via-shell' });
        assert.ok(svc.port && svc.port > 0, 'port detected from grandchild output');
        assert.match(registry.tailLog(svc.id, 10), /listening on/);
        assert.equal((await registry.status(svc.id)).portOpen, true);
    } finally {
        for (const s of registry.list({ runningOnly: true })) await registry.stop(s.id).catch(() => undefined);
        rmSync(dir, { recursive: true, force: true });
    }
});

test('waitFor blocks until the port opens or the log matches, and reports a timeout honestly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ofx-svc-'));
    const script = join(dir, 'server.js');
    // Prints nothing for 700ms, then listens and announces the port.
    writeFileSync(script, "setTimeout(() => {" + SERVER_SCRIPT + "}, 700);");
    const registry = new ServiceRegistry(dir);
    try {
        const svc = await registry.start({ command: process.execPath, args: [script], cwd: dir, name: 'slow' });
        const byLog = await registry.waitFor('slow', { pattern: /listening on/, timeoutMs: 10_000 });
        assert.equal(byLog.satisfied, true);
        assert.match(byLog.matchedLine || '', /listening on/);
        const byPort = await registry.waitFor(svc.id, { until: 'port', timeoutMs: 10_000 });
        assert.equal(byPort.satisfied, true);
        assert.equal(byPort.portOpen, true);
        const never = await registry.waitFor(svc.id, { pattern: /will-not-appear/, timeoutMs: 1000 });
        assert.equal(never.satisfied, false);
        assert.match(never.reason || '', /timed out/);
        await registry.stop(svc.id);
        const exited = await registry.waitFor(svc.id, { until: 'exit', timeoutMs: 5000 });
        assert.equal(exited.satisfied, true);
    } finally {
        for (const s of registry.list({ runningOnly: true })) await registry.stop(s.id).catch(() => undefined);
        rmSync(dir, { recursive: true, force: true });
    }
});
