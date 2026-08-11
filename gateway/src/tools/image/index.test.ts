import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createImageGenTool } from './index';
import type { ToolResult } from '../types';

function transportError(message: string, code: string): TypeError {
    const cause = Object.assign(new Error(message), { code });
    const error = new TypeError('fetch failed');
    Object.assign(error, { cause });
    return error;
}

function successResponse(): Response {
    return new Response(JSON.stringify({
        images: [{ b64: Buffer.from('test-image').toString('base64'), mime_type: 'image/png' }],
    }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

function failureData(result: ToolResult): any {
    return (result.data as any)?.failure;
}

async function withRouterTool(
    fetchImpl: typeof globalThis.fetch,
    run: (tool: ReturnType<typeof createImageGenTool>) => Promise<void>,
): Promise<void> {
    const outputPath = await mkdtemp(join(tmpdir(), 'openflux-image-router-'));
    try {
        const tool = createImageGenTool({
            getRuntimeConfig: () => ({
                provider: 'openai',
                model: 'test-image-model',
                source: 'managed',
                routerProxy: {
                    baseUrl: 'https://router.test',
                    appId: 'test-app',
                    apiKey: 'test-key',
                },
            }),
            getOutputPath: () => outputPath,
            fetchImpl,
            routerMaxRetries: 1,
            routerRetryDelayMs: 0,
            timeoutMs: 50,
        });
        await run(tool);
    } finally {
        await rm(outputPath, { recursive: true, force: true });
    }
}

test('Router connection refusal retries once and preserves the low-level code', async () => {
    let calls = 0;
    await withRouterTool((async () => {
        calls++;
        throw transportError('connection refused', 'ECONNREFUSED');
    }) as typeof globalThis.fetch, async (tool) => {
        const result = await tool.execute({ prompt: 'test' });
        assert.equal(result.success, false);
        assert.equal(result.code, 'router_unavailable');
        assert.equal(result.retryable, true);
        assert.equal(result.route, 'router_proxy');
        assert.equal(result.cause?.code, 'ECONNREFUSED');
        assert.equal(failureData(result).attempts, 2);
        assert.equal(failureData(result).maxAttempts, 2);
    });
    assert.equal(calls, 2, 'retry count must remain bounded');
});

test('Router timeout is delivery-ambiguous and is not retried', async () => {
    let calls = 0;
    await withRouterTool((async () => {
        calls++;
        const error = new Error('request timed out');
        error.name = 'AbortError';
        throw error;
    }) as typeof globalThis.fetch, async (tool) => {
        const result = await tool.execute({ prompt: 'test' });
        assert.equal(result.success, false);
        assert.equal(result.code, 'timeout');
        assert.equal(result.retryable, false);
        assert.equal(result.route, 'router_proxy');
        assert.equal(failureData(result).attempts, 1);
    });
    assert.equal(calls, 1);
});

test('ambiguous Router network reset is not retried', async () => {
    let calls = 0;
    await withRouterTool((async () => {
        calls++;
        throw transportError('connection reset', 'ECONNRESET');
    }) as typeof globalThis.fetch, async (tool) => {
        const result = await tool.execute({ prompt: 'test' });
        assert.equal(result.success, false);
        assert.equal(result.code, 'network');
        assert.equal(result.retryable, false);
        assert.equal(result.cause?.code, 'ECONNRESET');
    });
    assert.equal(calls, 1);
});

test('upstream failure stops an n-image batch and makes no follow-up requests', async () => {
    let calls = 0;
    await withRouterTool((async () => {
        calls++;
        return new Response(JSON.stringify({
            code: 'upstream_overloaded',
            message: 'image provider unavailable',
            retryable: true,
        }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }) as typeof globalThis.fetch, async (tool) => {
        const result = await tool.execute({ prompt: 'test', n: 4 });
        assert.equal(result.success, false);
        assert.equal(result.code, 'upstream');
        assert.equal(result.retryable, true);
        assert.equal(result.cause?.code, 'upstream_overloaded');
        assert.equal(result.cause?.status, 503);
        assert.deepEqual(failureData(result).batch, {
            requested: 4,
            stopped: true,
            followUpRequests: 0,
        });
    });
    assert.equal(calls, 1, 'an HTTP failure is not auto-retried without an explicit safety guarantee');
});

test('Router explicit safe_to_retry permits one controlled retry', async () => {
    let calls = 0;
    await withRouterTool((async () => {
        calls++;
        if (calls === 1) {
            return new Response(JSON.stringify({
                code: 'upstream_busy',
                message: 'retry on a fresh allocation',
                retryable: true,
                safe_to_retry: true,
            }), { status: 503, headers: { 'Content-Type': 'application/json' } });
        }
        return successResponse();
    }) as typeof globalThis.fetch, async (tool) => {
        const result = await tool.execute({ prompt: 'test' });
        assert.equal(result.success, true);
        assert.equal((result.data as any).route, 'router_proxy');
        assert.equal((result.data as any).count, 1);
    });
    assert.equal(calls, 2);
});

test('turn cancellation is forwarded to Router fetch and rejects with AbortError', async () => {
    const outputPath = await mkdtemp(join(tmpdir(), 'openflux-image-abort-'));
    let notifyStarted!: () => void;
    const started = new Promise<void>(resolve => { notifyStarted = resolve; });
    try {
        const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
            notifyStarted();
            return await new Promise<Response>((_resolve, reject) => {
                const signal = init?.signal;
                const onAbort = () => reject(signal?.reason || Object.assign(new Error('aborted'), { name: 'AbortError' }));
                if (signal?.aborted) onAbort();
                else signal?.addEventListener('abort', onAbort, { once: true });
            });
        }) as typeof globalThis.fetch;
        const tool = createImageGenTool({
            getRuntimeConfig: () => ({
                provider: 'openai',
                source: 'managed',
                routerProxy: { baseUrl: 'https://router.test', appId: 'app', apiKey: 'key' },
            }),
            getOutputPath: () => outputPath,
            fetchImpl,
            timeoutMs: 5_000,
        });
        const controller = new AbortController();
        const execution = tool.execute({ prompt: 'test' }, { abortSignal: controller.signal });
        await started;
        controller.abort(new Error('user stopped image turn'));
        await assert.rejects(
            execution,
            (error: Error) => error.name === 'AbortError' && /user stopped image turn/.test(error.message),
        );
        assert.deepEqual(await readdir(outputPath), []);
    } finally {
        await rm(outputPath, { recursive: true, force: true });
    }
});

test('a late image provider result is discarded without writing an orphan artifact', async () => {
    const outputPath = await mkdtemp(join(tmpdir(), 'openflux-image-late-'));
    let notifyStarted!: () => void;
    let resolveFetch!: (response: Response) => void;
    const started = new Promise<void>(resolve => { notifyStarted = resolve; });
    const response = new Promise<Response>(resolve => { resolveFetch = resolve; });
    try {
        const tool = createImageGenTool({
            getRuntimeConfig: () => ({
                provider: 'openai',
                source: 'managed',
                routerProxy: { baseUrl: 'https://router.test', appId: 'app', apiKey: 'key' },
            }),
            getOutputPath: () => outputPath,
            // Simulate an upstream transport that ignores AbortSignal and returns late.
            fetchImpl: (async () => {
                notifyStarted();
                return await response;
            }) as typeof globalThis.fetch,
            timeoutMs: 5_000,
        });
        const controller = new AbortController();
        const execution = tool.execute({ prompt: 'test' }, { abortSignal: controller.signal });
        await started;
        controller.abort(new Error('superseded turn'));
        resolveFetch(successResponse());
        await assert.rejects(
            execution,
            (error: Error) => error.name === 'AbortError' && /superseded turn/.test(error.message),
        );
        assert.deepEqual(await readdir(outputPath), []);
    } finally {
        await rm(outputPath, { recursive: true, force: true });
    }
});
