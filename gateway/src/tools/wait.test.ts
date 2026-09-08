import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWaitTool } from './wait';

const tool = createWaitTool();

test('wait seconds returns after the delay', async () => {
    const started = Date.now();
    const result = await tool.execute({ seconds: 0.3 });
    assert.equal(result.success, true);
    assert.ok(Date.now() - started >= 250);
});

test('wait file resolves once the file appears and reports honestly on timeout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ofx-wait-'));
    try {
        const target = join(dir, 'ready.txt');
        setTimeout(() => writeFileSync(target, 'ok'), 400);
        const result = await tool.execute({ file: target, timeoutSeconds: 5 });
        assert.equal((result.data as { satisfied: boolean }).satisfied, true);

        const missing = await tool.execute({ file: join(dir, 'never.txt'), timeoutSeconds: 1 });
        assert.equal(missing.success, true);
        assert.equal((missing.data as { satisfied: boolean }).satisfied, false);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('wait url resolves when the endpoint answers with an acceptable status', async () => {
    let ready = false;
    const server = createServer((_req, res) => { res.statusCode = ready ? 200 : 503; res.end(ready ? 'up' : 'starting'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;
    try {
        setTimeout(() => { ready = true; }, 600);
        const result = await tool.execute({ url: `http://127.0.0.1:${port}/health`, timeoutSeconds: 5 });
        const data = result.data as { satisfied: boolean; status: number };
        assert.equal(data.satisfied, true);
        assert.equal(data.status, 200);
    } finally {
        server.close();
    }
});

test('wait rejects ambiguous or missing conditions', async () => {
    const none = await tool.execute({});
    assert.equal(none.success, false);
    const bad = await tool.execute({ url: 'ftp://x' });
    assert.equal(bad.success, false);
});
