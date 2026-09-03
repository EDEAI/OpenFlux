import assert from 'node:assert/strict';
import test from 'node:test';
import {
    classifyAnthropicError,
    classifyOpenAIError,
    isImageInputUnsupportedMessage,
} from './llm-error';

test('provider image-input rejections are classified from the real response', () => {
    const openai = classifyOpenAIError({
        status: 400,
        message: 'This model does not support image input in messages.',
    }, 'moonshot');
    assert.equal(openai.category, 'IMAGE_INPUT_UNSUPPORTED');
    assert.equal(openai.retryable, false);
    assert.equal(openai.allowModelFallback, false);

    const anthropic = classifyAnthropicError({
        status: 400,
        message: 'Unsupported multimodal content: image blocks are not supported.',
    }, 'anthropic');
    assert.equal(anthropic.category, 'IMAGE_INPUT_UNSUPPORTED');
});

test('Atlas invalid-request details preserve an upstream image rejection', () => {
    const error = classifyOpenAIError({
        status: 400,
        error: {
            type: 'atlas_gateway',
            atlas_code: 'invalid_request_body',
            atlas_message: '当前模型不支持图片输入',
            atlas_detail: 'invalid_request_body: 当前模型不支持图片输入',
        },
    }, 'openai');
    assert.equal(error.category, 'IMAGE_INPUT_UNSUPPORTED');
});

test('ordinary image validation failures are not mistaken for missing vision support', () => {
    assert.equal(isImageInputUnsupportedMessage('Image exceeds the 20 MB size limit.'), false);
    assert.equal(isImageInputUnsupportedMessage('Invalid image data or corrupt PNG.'), false);
});
