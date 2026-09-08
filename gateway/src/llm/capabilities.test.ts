import assert from 'node:assert/strict';
import test from 'node:test';
import { inferLLMCapabilities, supportsVision } from './capabilities';

test('undeclared models optimistically attempt image input regardless of model alias', () => {
    assert.equal(supportsVision({ provider: 'deepseek', model: 'deepseek-chat' }), true);
    assert.equal(supportsVision({ provider: 'openai', model: 'deepseek-v4-flash' }), true);
    assert.equal(supportsVision({ provider: 'openai', model: 'gpt-5.2' }), true);
    assert.equal(supportsVision({ provider: 'anthropic', model: 'claude-sonnet-5' }), true);
    assert.equal(supportsVision({ provider: 'moonshot', model: 'kimi-k2.5' }), true);
    assert.equal(supportsVision({ provider: 'moonshot', model: 'kimi-k2.6' }), true);
    assert.equal(supportsVision({ provider: 'moonshot', model: 'kimi-k3' }), true);
    assert.equal(supportsVision({ provider: 'dashscope', model: 'qwen-vl-max' }), true);
});

test('platform-declared capabilities remain authoritative', () => {
    assert.deepEqual(inferLLMCapabilities({
        provider: 'custom',
        model: 'private-vision-model',
        capabilities: { vision: true, tools: false, structuredOutput: true },
    }), {
        vision: true,
        tools: false,
        structuredOutput: true,
    });
    assert.equal(supportsVision({
        provider: 'moonshot',
        model: 'kimi-k3',
        capabilities: { vision: false },
    }), false);
});
