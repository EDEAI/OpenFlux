import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentConfig, AgentsConfig } from '../config/schema';
import type { LLMProvider } from '../llm/provider';
import { routeToAgent } from './router';
import {
    BUILTIN_PRESENTATION_AGENT,
    ensureBuiltinPresentationAgent,
    PRESENTATION_AGENT_ID,
} from './presentation-agent';

const baseAgents: AgentConfig[] = [
    { id: 'default', name: '通用助手', default: true },
    { id: 'coder', name: '编程助手', description: '编程和数据处理' },
    BUILTIN_PRESENTATION_AGENT,
];

test('built-in presentation Agent is added once without overriding explicit configuration', () => {
    const source: AgentsConfig = { list: baseAgents.slice(0, 2) };
    const injected = ensureBuiltinPresentationAgent(source);
    assert.equal(injected.list.filter(agent => agent.id === PRESENTATION_AGENT_ID).length, 1);
    assert.equal(source.list.some(agent => agent.id === PRESENTATION_AGENT_ID), false);

    const custom: AgentsConfig = {
        list: [...source.list, {
            id: PRESENTATION_AGENT_ID,
            name: '企业演示团队',
            systemPrompt: 'custom contract',
        }],
    };
    const respected = ensureBuiltinPresentationAgent(custom);
    assert.equal(respected, custom);
    assert.equal(respected.list.find(agent => agent.id === PRESENTATION_AGENT_ID)?.name, '企业演示团队');
});

test('standalone deck requests route directly to Presentation Agent without an extra model call', async () => {
    let routerCalls = 0;
    const llm = {
        chat: async () => {
            routerCalls++;
            return 'coder';
        },
    } as unknown as LLMProvider;
    const result = await routeToAgent(
        '查询德甲26年最新的赛程和比分，帮我生成一个ppt',
        baseAgents,
        llm,
    );
    assert.equal(result.agentId, PRESENTATION_AGENT_ID);
    assert.equal(result.usedLLM, false);
    assert.equal(routerCalls, 0);

    const switchedFromCoder = await routeToAgent(
        '继续生成这份PPT',
        baseAgents,
        llm,
        'coder',
    );
    assert.equal(switchedFromCoder.agentId, PRESENTATION_AGENT_ID);
    assert.equal(switchedFromCoder.usedLLM, false);
    assert.equal(routerCalls, 0);
});

test('PPT implementation questions and live Office edits remain outside the standalone fast path', async () => {
    let routerCalls = 0;
    const llm = {
        chat: async () => {
            routerCalls++;
            return 'coder';
        },
    } as unknown as LLMProvider;
    const implementation = await routeToAgent(
        '帮我分析 PPT 生成工作流的状态机实现',
        baseAgents,
        llm,
    );
    const liveEdit = await routeToAgent(
        '美化当前打开的 PowerPoint',
        baseAgents,
        llm,
    );
    assert.equal(implementation.agentId, 'coder');
    assert.equal(liveEdit.agentId, 'coder');
    assert.equal(routerCalls, 2);
});

test('presentation Agent distinguishes deliberate ending whitespace from orphaned body pages', () => {
    assert.match(BUILTIN_PRESENTATION_AGENT.systemPrompt || '', /closing\/quote 页.*允许低信息密度/);
    assert.match(BUILTIN_PRESENTATION_AGENT.systemPrompt || '', /素材不能只装饰封面和结束页/);
    assert.match(BUILTIN_PRESENTATION_AGENT.systemPrompt || '', /短正文、少量行动信息与独立 quote.*必须合并为一页/);
    assert.match(BUILTIN_PRESENTATION_AGENT.systemPrompt || '', /qa\.issues\[\]\.slide.*具体渲染页/);
    assert.match(BUILTIN_PRESENTATION_AGENT.systemPrompt || '', /确定性错误不得.*重复提交/);
});
