import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebFetchTool } from './index';

test('anti-bot responses return a non-error browser routing outcome', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('<html>Access denied: checking your browser</html>', {
        status: 403,
        headers: { 'content-type': 'text/html' },
    });
    try {
        const result = await createWebFetchTool().execute({ url: 'https://protected.example.test/report' });
        assert.equal(result.success, true);
        assert.equal(result.code, 'browser_required');
        assert.equal(result.route, 'browser_required');
        assert.equal(result.retryable, false);
        assert.deepEqual(result.data, {
            url: 'https://protected.example.test/report',
            fetched: false,
            blocked: true,
            reason: 'anti_bot',
            message: 'The page requires a real browser session; no page content was returned.',
            nextAction: 'Open the same URL with the browser tool. Do not retry web_fetch for this domain in the same turn.',
        });
    } finally {
        globalThis.fetch = originalFetch;
    }
});
