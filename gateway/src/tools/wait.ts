/**
 * `wait`: block the current step until a plain condition holds, with a hard
 * timeout and an honest report either way. The three conditions cover what
 * agents otherwise fake with sleep loops: a delay, a file appearing on disk,
 * an HTTP endpoint answering. Service readiness lives in `process wait`, page
 * conditions in `browser_control wait_for`.
 */

import { existsSync } from 'fs';
import type { Tool, ToolResult } from './types';
import { errorResult, jsonResult, readNumberParam, readStringParam } from './common';

const MAX_SECONDS = 300;
const POLL_MS = 500;

async function probeUrl(url: string, timeoutMs: number): Promise<{ status: number; ok: boolean } | { error: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { method: 'GET', redirect: 'manual', signal: controller.signal });
        return { status: response.status, ok: response.status >= 200 && response.status < 400 };
    } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    } finally {
        clearTimeout(timer);
    }
}

export function createWaitTool(): Tool {
    return {
        name: 'wait',
        priority: 45,
        description: [
            'Wait for a condition before continuing, instead of polling in a loop.',
            'Exactly one of: seconds (a plain delay, max 300), file (an absolute path that must exist), url (an HTTP endpoint that must answer with the expected status).',
            'Returns as soon as the condition holds, or after timeoutSeconds with satisfied=false and what was observed — report that honestly rather than retrying blindly.',
            'For a server you started with process spawn use process wait; for a page use browser_control wait_for.',
        ].join(' '),
        parameters: {
            seconds: { type: 'number', description: 'Delay to wait, in seconds (max 300).' },
            file: { type: 'string', description: 'Absolute path that must exist before continuing.' },
            url: { type: 'string', description: 'HTTP(S) URL that must respond before continuing.' },
            expectStatus: { type: 'number', description: 'For url: exact status to wait for (default: any 2xx/3xx).' },
            timeoutSeconds: { type: 'number', description: 'Give up after this many seconds (default 60, max 300).' },
        },
        async execute(args: Record<string, unknown>): Promise<ToolResult> {
            const seconds = readNumberParam(args, 'seconds');
            const file = readStringParam(args, 'file');
            const url = readStringParam(args, 'url');
            const expectStatus = readNumberParam(args, 'expectStatus', { integer: true });
            const timeoutSeconds = Math.min(MAX_SECONDS, Math.max(1, readNumberParam(args, 'timeoutSeconds') || 60));
            const started = Date.now();
            const elapsed = () => Math.round((Date.now() - started) / 1000);

            if (seconds !== undefined && seconds !== null) {
                const delay = Math.min(MAX_SECONDS, Math.max(0, Number(seconds)));
                await new Promise(resolve => setTimeout(resolve, delay * 1000));
                return jsonResult({ satisfied: true, waited: `${delay}s` });
            }
            if (file) {
                const deadline = started + timeoutSeconds * 1000;
                while (Date.now() < deadline) {
                    if (existsSync(file)) return jsonResult({ satisfied: true, file, elapsed: `${elapsed()}s` });
                    await new Promise(resolve => setTimeout(resolve, POLL_MS));
                }
                return jsonResult({ satisfied: false, file, elapsed: `${elapsed()}s`, note: `File did not appear within ${timeoutSeconds}s.` });
            }
            if (url) {
                if (!/^https?:\/\//i.test(url)) return errorResult('url must start with http:// or https://');
                const deadline = started + timeoutSeconds * 1000;
                let last: { status?: number; error?: string } = {};
                while (Date.now() < deadline) {
                    const probe = await probeUrl(url, Math.min(5000, deadline - Date.now()));
                    if ('status' in probe) {
                        last = { status: probe.status };
                        const good = expectStatus ? probe.status === expectStatus : probe.ok;
                        if (good) return jsonResult({ satisfied: true, url, status: probe.status, elapsed: `${elapsed()}s` });
                    } else {
                        last = { error: probe.error };
                    }
                    await new Promise(resolve => setTimeout(resolve, POLL_MS));
                }
                return jsonResult({ satisfied: false, url, ...last, elapsed: `${elapsed()}s`, note: `Endpoint did not answer as expected within ${timeoutSeconds}s.` });
            }
            return errorResult('wait needs exactly one of: seconds, file, url');
        },
    };
}
