import assert from 'node:assert/strict';
import test from 'node:test';
import { routeToAgent } from '../src/agent/router';
import type { AgentConfig } from '../src/config/schema';
import type { LLMProvider } from '../src/llm/provider';

test('video requests use the normal classifier instead of a hard-coded internal video agent', async () => {
    const agents: AgentConfig[] = [
        { id: 'default', default: true, name: 'General' },
        { id: 'coder', name: 'Coder' },
        { id: 'image', name: 'Image' },
        { id: 'video', name: 'Video' },
    ];
    let classifierCalled = false;
    const llm = {
        chat: async () => {
            classifierCalled = true;
            return 'default';
        },
    } as unknown as LLMProvider;

    const result = await routeToAgent(
        '我要分享到抖音和视频号，你看看同事谁能帮你，先帮我生成一个测试视频',
        agents,
        llm,
    );
    assert.equal(result.agentId, 'default');
    assert.equal(result.usedLLM, true);
    assert.equal(classifierCalled, true);
});
