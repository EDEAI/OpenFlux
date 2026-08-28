import assert from 'node:assert/strict';
import test from 'node:test';
import { inferLLMCapabilities, supportsVision } from './capabilities';

test('capability inference keeps text-only planners away from presentation screenshots', () => {
    assert.equal(supportsVision({ provider: 'deepseek', model: 'deepseek-chat' }), false);
    assert.equal(supportsVision({ provider: 'openai', model: 'deepseek-v4-flash' }), false);
    assert.equal(supportsVision({ provider: 'openai', model: 'gpt-5.2' }), true);
    assert.equal(supportsVision({ provider: 'anthropic', model: 'claude-sonnet-5' }), true);
    assert.equal(supportsVision({ provider: 'moonshot', model: 'kimi-k2.5' }), false);
    assert.equal(supportsVision({ provider: 'moonshot', model: 'kimi-k3' }), true);
    assert.equal(supportsVision({ provider: 'dashscope', model: 'qwen-vl-max' }), true);
});

test('platform-declared capabilities override conservative model inference', () => {
    assert.deepEqual(inferLLMCapabilities({
        provider: 'custom',
        model: 'private-vision-model',
        capabilities: { vision: true, tools: false, structuredOutput: true },
    }), {
        vision: true,
        tools: false,
        structuredOutput: true,
    });
});
