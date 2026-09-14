import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRouterReply } from './router';

test('router reply: JSON line with agent and plan', () => {
    const parsed = parseRouterReply('{"agent":"qa-helper","plan":"读取工作簿并统计 9 月 3 日的 API 调用"}');
    assert.equal(parsed.agentId, 'qa-helper');
    assert.equal(parsed.summary, '读取工作簿并统计 9 月 3 日的 API 调用');
});

test('router reply: fenced JSON and alternative keys are tolerated', () => {
    const fenced = parseRouterReply('```json\n{"agentId": "coder", "summary": "写脚本"}\n```');
    assert.equal(fenced.agentId, 'coder');
    assert.equal(fenced.summary, '写脚本');
    const noPlan = parseRouterReply('{"agent":"default","plan":""}');
    assert.equal(noPlan.agentId, 'default');
    assert.equal(noPlan.summary, undefined);
});

test('router reply: bare id from an older prompt still works', () => {
    assert.deepEqual(parseRouterReply('"automation"'), { agentId: 'automation' });
    assert.deepEqual(parseRouterReply('  default \n'), { agentId: 'default' });
    assert.equal(parseRouterReply('{not json').agentId, 'not');
});
