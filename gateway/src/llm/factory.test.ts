import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenFluxConfigSchema } from '../config/schema';
import { resolveAnthropicMaxTokens } from './anthropic';
import { createLLMProvider } from './factory';
import { OpenAIProvider } from './openai';

test('creates an OpenAI-compatible DashScope provider with the China endpoint by default', () => {
    const provider = createLLMProvider({
        provider: 'dashscope',
        model: 'qwen3.8-max',
        apiKey: 'test-key',
    });

    assert.ok(provider instanceof OpenAIProvider);
    assert.equal(provider.getConfig().provider, 'dashscope');
    assert.equal(provider.getConfig().baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
});

test('keeps a custom DashScope workspace endpoint', () => {
    const baseUrl = 'https://workspace-id.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
    const provider = createLLMProvider({
        provider: 'dashscope',
        model: 'qwen3.7-plus',
        apiKey: 'test-key',
        baseUrl,
    });

    assert.equal(provider.getConfig().baseUrl, baseUrl);
});

test('accepts DashScope in the application config schema', () => {
    const result = OpenFluxConfigSchema.safeParse({
        llm: {
            orchestration: { provider: 'dashscope', model: 'qwen3.7-plus' },
            execution: { provider: 'dashscope', model: 'qwen3.7-plus' },
        },
    });

    assert.equal(result.success, true);
});

test('uses the published model maximum when an Anthropic-compatible request requires max_tokens', () => {
    assert.equal(resolveAnthropicMaxTokens({
        provider: 'anthropic',
        model: 'claude-sonnet-5',
    }), 128_000);
    assert.equal(resolveAnthropicMaxTokens({
        provider: 'minimax',
        model: 'MiniMax-M2.7',
    }), 204_800);
});

test('preserves explicit max token overrides for Anthropic-compatible requests', () => {
    assert.equal(resolveAnthropicMaxTokens({
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        maxTokens: 32_000,
    }, 64_000), 64_000);
});

test('omits output token limits when an OpenAI-compatible provider has no configured cap', async () => {
    let body: Record<string, unknown> | undefined;
    const provider = new OpenAIProvider({
        provider: 'moonshot',
        model: 'kimi-k3',
        apiKey: 'test-key',
        baseUrl: 'https://example.invalid/v1',
        fetch: async (_input, init) => {
            body = JSON.parse(String(init?.body));
            return new Response(JSON.stringify({
                id: 'chatcmpl-test',
                object: 'chat.completion',
                created: 0,
                model: 'kimi-k3',
                choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        },
    });

    assert.equal(await provider.chat([{ role: 'user', content: 'hello' }]), 'ok');
    assert.equal(body?.max_tokens, undefined);
    assert.equal(body?.max_completion_tokens, undefined);
});

test('uses max_completion_tokens for an explicit Kimi K3 per-call cap', async () => {
    let body: Record<string, unknown> | undefined;
    const provider = new OpenAIProvider({
        provider: 'moonshot',
        model: 'kimi-k3',
        apiKey: 'test-key',
        baseUrl: 'https://example.invalid/v1',
        fetch: async (_input, init) => {
            body = JSON.parse(String(init?.body));
            return new Response(JSON.stringify({
                id: 'chatcmpl-test',
                object: 'chat.completion',
                created: 0,
                model: 'kimi-k3',
                choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        },
    });

    await provider.chat([{ role: 'user', content: 'hello' }], { maxTokens: 131_072 });
    assert.equal(body?.max_completion_tokens, 131_072);
    assert.equal(body?.max_tokens, undefined);
});
