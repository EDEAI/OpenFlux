import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatWithToolsResponse, LLMMessage } from '../llm/provider';
import { buildUserInputDecisionMessages, userInputDecisionToolResponse } from './user-input-decision';

test('focused context preserves every known user/assistant answer and role without execution skills', () => {
    const history: LLMMessage[] = [
        { role: 'user', content: 'The audience is my class, not a public product.' },
        { role: 'assistant', content: 'Teaching is the confirmed purpose.' },
        { role: 'user', content: 'I delegate the platform choice.', contentParts: [{ type: 'text', text: 'I delegate the platform choice.' }] },
    ];
    const original = structuredClone(history);
    const request = buildUserInputDecisionMessages({
        input: 'Give three initial features.', history, language: 'en',
        globalSystemPrompt: 'GLOBAL_ROLE', systemPrompt: 'AGENT_ROLE', memoryContext: 'Known user constraint: only ten minutes per day.',
    })!;
    assert.equal(request.length, history.length + 2);
    assert.deepEqual(request.slice(1, -1), history);
    assert.deepEqual(request.at(-1), { role: 'user', content: 'Give three initial features.' });
    assert.ok(request[0].content.includes('GLOBAL_ROLE'));
    assert.ok(request[0].content.includes('AGENT_ROLE'));
    assert.ok(request[0].content.includes('ten minutes per day'));
    assert.ok(request[0].content.includes('[User input decision]'));
    assert.ok(!request[0].content.includes('## Installed Skills'));
    request[1].content = 'Changed provider-side copy';
    request[3].contentParts![0] = { type: 'text', text: 'Changed part' };
    assert.deepEqual(history, original);
});

test('incomplete, multimodal, tool and compressed contexts skip rather than omit known evidence', () => {
    const cases: Parameters<typeof buildUserInputDecisionMessages>[0][] = [
        { input: 'Continue', historyComplete: false },
        { input: 'Interpret this', contentParts: [{ type: 'image', mimeType: 'image/png', data: 'fixture' }] },
        { input: 'Continue', history: [{ role: 'user', content: 'An attached image', contentParts: [{ type: 'image', mimeType: 'image/png', data: 'fixture' }] }] },
        { input: 'Continue', history: [{ role: 'tool', content: 'Already inspected', toolCallId: 'read' }] },
        { input: 'Continue', history: [{ role: 'assistant', content: '', toolCalls: [{ id: 'read', name: 'file_reader', arguments: {} }] }] },
        { input: 'Continue', history: [{ role: 'system', content: 'Task checkpoint before a prior question.' }] },
        { input: 'Continue', history: [{ role: 'user', content: '[Earlier conversation archive; derived and compressed. Original user messages remain authoritative.]\nsummary' }] },
        { input: 'Continue', history: [{ role: 'user', content: '[Previous conversation summary (20 messages compressed)]\nsummary' }] },
    ];
    for (const context of cases) assert.equal(buildUserInputDecisionMessages(context), undefined);
});

test('large input, history, roles or memory skip the phase without truncating any source', () => {
    const long = 'A significant earlier user constraint. '.repeat(2_000);
    const contexts = [
        { input: long },
        { input: 'Current task', history: [{ role: 'user' as const, content: long }] },
        { input: 'Current task', systemPrompt: long },
        { input: 'Current task', memoryContext: long },
    ];
    for (const context of contexts) {
        const before = structuredClone(context);
        assert.equal(buildUserInputDecisionMessages(context), undefined);
        assert.deepEqual(context, before);
    }
});

test('only one real clarification call survives; prose, mixed or repeated tools cannot execute', () => {
    const original: ChatWithToolsResponse = { content: 'Private reasoning or advice.', reasoningContent: 'Private provider reasoning', toolCalls: [
        { id: 'ask-real-id', name: 'request_user_input', arguments: { questions_json: '[]' } },
    ] };
    const before = structuredClone(original);
    const accepted = userInputDecisionToolResponse(original)!;
    assert.equal(accepted.content, '');
    assert.deepEqual(accepted.toolCalls, original.toolCalls);
    assert.deepEqual(original, before);
    for (const response of [
        { content: 'CONTINUE', toolCalls: [] },
        { content: 'Unrequested full answer', toolCalls: [] },
        { content: '', toolCalls: [{ id: 'other', name: 'filesystem', arguments: {} }] },
        { content: '', toolCalls: [...original.toolCalls, ...original.toolCalls] },
        { content: '', toolCalls: [...original.toolCalls, { id: 'other', name: 'filesystem', arguments: {} }] },
    ]) assert.equal(userInputDecisionToolResponse(response), undefined);
});
