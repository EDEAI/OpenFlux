import assert from 'node:assert/strict';
import test from 'node:test';
import type { LLMMessage } from '../llm/provider';
import { generatedArtifactPaths } from './manager';
import {
    agentLoopCompletionStatus,
    isStandalonePresentationCreationRequest,
    MAX_PRESENTATION_IMAGE_CALLS_PER_TURN,
    MAX_PRESENTATION_RENDER_CALLS_PER_TURN,
    MAX_PRESENTATION_REVIEW_CALLS_PER_TURN,
    MAX_PRESENTATION_TOOL_CALLS_PER_TURN,
    MAX_PRESENTATION_WEB_FETCH_CALLS_PER_TURN,
    MAX_PRESENTATION_WEB_SEARCH_CALLS_PER_TURN,
    TARGET_PRESENTATION_TOOL_CALLS_PER_TURN,
    ToolFailureCircuitBreaker,
    normalizeToolCallTranscript,
    presentationCostBudgetDecision,
    presentationDesignContinuityDecision,
    presentationTerminalFailureMessage,
    presentationToolFailureIsTerminal,
    toolFailureAttemptLimit,
} from './loop';

test('standalone presentation detection distinguishes artifact work from implementation questions', () => {
    assert.equal(isStandalonePresentationCreationRequest('请生成一份企业介绍PPT'), true);
    assert.equal(isStandalonePresentationCreationRequest('查询德甲26年最新赛程和比分，帮我生成一个PPT'), true);
    assert.equal(isStandalonePresentationCreationRequest('为什么生成PPT的工具会失败？'), false);
    assert.equal(isStandalonePresentationCreationRequest('修改一下PPT生成工作流的状态机'), false);
    assert.equal(isStandalonePresentationCreationRequest('美化当前打开的PPT'), false);
});

test('standalone presentation detection carries an explicit continuation from recent history', () => {
    const history: LLMMessage[] = [
        { role: 'user', content: '请重新设计这份企业介绍演示文稿并导出 PDF' },
        { role: 'assistant', content: '我已经准备了内容方向。' },
    ];
    assert.equal(isStandalonePresentationCreationRequest('继续', history), true);
});

test('presentation cost guard caps renders and generated images without affecting other tasks', () => {
    assert.equal(TARGET_PRESENTATION_TOOL_CALLS_PER_TURN, 5);
    assert.equal(MAX_PRESENTATION_RENDER_CALLS_PER_TURN, 5);
    assert.equal(MAX_PRESENTATION_REVIEW_CALLS_PER_TURN, 3);
    assert.equal(MAX_PRESENTATION_TOOL_CALLS_PER_TURN, 8);
    assert.equal(MAX_PRESENTATION_IMAGE_CALLS_PER_TURN, 2);
    assert.equal(MAX_PRESENTATION_WEB_SEARCH_CALLS_PER_TURN, 2);
    assert.equal(MAX_PRESENTATION_WEB_FETCH_CALLS_PER_TURN, 3);
    assert.equal(presentationCostBudgetDecision(
        true,
        'generate_presentation',
        Array(MAX_PRESENTATION_RENDER_CALLS_PER_TURN).fill('generate_presentation'),
    ).allowed, false);
    const fullExceptionalWorkflow = [
        { name: 'generate_presentation', args: { workflow: { stage: 'sample' } } },
        { name: 'generate_presentation', args: { workflow: { stage: 'sample' } } },
        { name: 'generate_presentation', args: { workflow: { stage: 'final' } } },
        { name: 'generate_presentation', args: { workflow: { stage: 'review' } } },
        { name: 'generate_presentation', args: { workflow: { stage: 'revision' } } },
        { name: 'generate_presentation', args: { workflow: { stage: 'review' } } },
        { name: 'generate_presentation', args: { workflow: { stage: 'revision' } } },
    ];
    assert.equal(presentationCostBudgetDecision(
        true,
        'generate_presentation',
        fullExceptionalWorkflow,
        { workflow: { stage: 'review' } },
    ).allowed, true);
    assert.equal(presentationCostBudgetDecision(
        true,
        'generate_presentation',
        [...fullExceptionalWorkflow, { name: 'generate_presentation', args: { workflow: { stage: 'review' } } }],
        { workflow: { stage: 'revision' } },
    ).reason, 'presentation_render_budget');
    const preflightFailures = Array(8).fill(undefined).map(() => ({
        name: 'generate_presentation',
        args: { workflow: { stage: 'sample' } },
        result: {
            success: false,
            code: 'presentation_requested_slide_count_mismatch',
            data: { route: 'local_presentation', files: [] },
        },
    }));
    assert.deepEqual(presentationCostBudgetDecision(
        true,
        'generate_presentation',
        preflightFailures,
        { workflow: { stage: 'sample' } },
    ), { allowed: true, used: 0, limit: MAX_PRESENTATION_RENDER_CALLS_PER_TURN });
    const renderedFailure = {
        name: 'generate_presentation',
        args: { workflow: { stage: 'sample' } },
        result: {
            success: false,
            code: 'presentation_direction_quality_gate_failed',
            data: { route: 'local_presentation', directions: [{ id: 'executive' }] },
        },
    };
    assert.equal(presentationCostBudgetDecision(
        true,
        'generate_presentation',
        Array(MAX_PRESENTATION_RENDER_CALLS_PER_TURN).fill(renderedFailure),
        { workflow: { stage: 'revision' } },
    ).reason, 'presentation_render_budget');
    assert.equal(presentationCostBudgetDecision(
        true,
        'generate_image',
        Array(MAX_PRESENTATION_IMAGE_CALLS_PER_TURN).fill('generate_image'),
    ).allowed, false);
    assert.equal(presentationCostBudgetDecision(
        true,
        'generate_image',
        ['generate_image'],
    ).allowed, true);
    assert.equal(presentationCostBudgetDecision(
        false,
        'generate_image',
        Array(10).fill('generate_image'),
    ).allowed, true);
    assert.equal(presentationCostBudgetDecision(
        true,
        'web_search',
        Array(MAX_PRESENTATION_WEB_SEARCH_CALLS_PER_TURN).fill('web_search'),
    ).reason, 'presentation_web_search_budget');
    assert.equal(presentationCostBudgetDecision(
        true,
        'web_fetch',
        Array(MAX_PRESENTATION_WEB_FETCH_CALLS_PER_TURN).fill('web_fetch'),
    ).reason, 'presentation_web_fetch_budget');
});

test('presentation continuity keeps every stage on one durable design id', () => {
    const calls = [{
        name: 'generate_presentation',
        args: { workflow: { stage: 'sample' } },
        result: { success: false, data: { designId: 'deck-123' } },
    }];
    assert.deepEqual(presentationDesignContinuityDecision(
        true,
        'generate_presentation',
        { workflow: { stage: 'sample', design_id: 'deck-123' }, slide_patches: [] },
        calls,
    ), { allowed: true, expectedDesignId: 'deck-123', requestedDesignId: 'deck-123' });
    assert.deepEqual(presentationDesignContinuityDecision(
        true,
        'generate_presentation',
        { workflow: { stage: 'sample' }, slides: [{ title: 'replacement deck' }] },
        calls,
    ), { allowed: false, expectedDesignId: 'deck-123', requestedDesignId: '' });
    assert.equal(presentationDesignContinuityDecision(
        true,
        'generate_presentation',
        { design_id: 'deck-456' },
        calls,
    ).allowed, false);
    assert.equal(presentationDesignContinuityDecision(
        true,
        'web_search',
        { query: 'latest results' },
        calls,
    ).allowed, true);
});

test('presentation terminal failures do not reopen the workflow', () => {
    assert.equal(presentationToolFailureIsTerminal({
        success: false,
        retryable: false,
        code: 'presentation_quality_gate_failed',
    }), true);
    assert.equal(presentationToolFailureIsTerminal({
        success: false,
        retryable: true,
        code: 'presentation_structure_preflight_failed',
    }), false);
    assert.equal(presentationToolFailureIsTerminal({
        success: true,
        retryable: false,
    }), false);
});

test('presentation artifacts publish only after durable completion', () => {
    const files = ['C:\\output\\deck.pptx', 'C:\\output\\deck.pdf'];
    assert.deepEqual(generatedArtifactPaths('generate_presentation', {
        data: {
            files,
            preview: 'C:\\output\\deck-preview.png',
            completion: { complete: false },
        },
    }), []);
    assert.deepEqual(generatedArtifactPaths('generate_presentation', {
        data: {
            files: [...files, files[0]],
            preview: 'C:\\output\\deck-preview.png',
            completion: { complete: true },
        },
    }), files);
});

test('deterministic presentation preflight failures receive only one retry', () => {
    const failure = {
        success: false,
        code: 'presentation_direction_quality_gate_failed',
        error: 'All three visual directions failed structural or rendering QA.',
    };
    assert.equal(toolFailureAttemptLimit('generate_presentation', failure), 2);
    assert.equal(toolFailureAttemptLimit('generate_presentation', {
        ...failure,
        code: 'presentation_structure_preflight_failed',
    }), 2);
    assert.equal(toolFailureAttemptLimit('generate_presentation', {
        ...failure,
        code: 'presentation_revision_slide_count_change',
    }), 1);
    assert.equal(toolFailureAttemptLimit('web_search', failure), 3);

    const breaker = new ToolFailureCircuitBreaker();
    assert.equal(breaker.record('generate_presentation', failure, { maxAttempts: 2 }).disposition, 'retry');
    assert.equal(breaker.record('generate_presentation', failure, { maxAttempts: 2 }).disposition, 'tripped');
    assert.equal(breaker.isDisabled('generate_presentation'), true);
});

test('terminal presentation summaries cannot claim an unpublished draft was delivered', () => {
    const message = presentationTerminalFailureMessage({
        success: false,
        error: 'Presentation quality gate failed after revision 2.',
        data: { qa: { errors: 3, warnings: 2 }, files: [], completion: { complete: false } },
    }, true);
    assert.match(message, /没有发布到成果物面板/);
    assert.match(message, /3 个错误、2 个警告/);
    assert.doesNotMatch(message, /已交付|下载|已完成/);
});

test('presentation tasks are failed until the durable completion predicate passes', () => {
    assert.equal(agentLoopCompletionStatus(true, [{
        name: 'generate_presentation',
        result: { success: false, code: 'presentation_direction_quality_gate_failed' },
    }]), 'failed');
    assert.equal(agentLoopCompletionStatus(true, [{
        name: 'generate_presentation',
        result: { success: true, data: { completion: { complete: true } } },
    }]), 'completed');
    assert.equal(agentLoopCompletionStatus(false, []), 'completed');
});

test('tool transcript normalization moves every result directly behind its assistant call batch', () => {
    const transcript: LLMMessage[] = [
        {
            role: 'assistant',
            content: '',
            toolCalls: [
                { id: 'image:1', name: 'inspect', arguments: {} },
                { id: 'filesystem:6', name: 'filesystem', arguments: {} },
            ],
        },
        { role: 'tool', toolCallId: 'image:1', content: '{"success":true}' },
        { role: 'user', content: 'vision content', contentParts: [{ type: 'text', text: 'image' }] },
        { role: 'tool', toolCallId: 'filesystem:6', content: '{"success":true}' },
    ];
    const normalized = normalizeToolCallTranscript(transcript);
    assert.equal(normalized.changed, true);
    assert.deepEqual(normalized.messages.map(message => message.role), ['assistant', 'tool', 'tool', 'user']);
    assert.deepEqual(normalized.messages.slice(1, 3).map(message => message.toolCallId), ['image:1', 'filesystem:6']);
    assert.deepEqual(normalized.synthesizedToolCallIds, []);
});

test('tool transcript normalization synthesizes an explicit failed result for a missing call id', () => {
    const normalized = normalizeToolCallTranscript([{
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'missing:1', name: 'filesystem', arguments: {} }],
    }]);
    assert.equal(normalized.changed, true);
    assert.deepEqual(normalized.synthesizedToolCallIds, ['missing:1']);
    assert.equal(normalized.messages[1].role, 'tool');
    assert.equal(normalized.messages[1].toolCallId, 'missing:1');
    assert.match(normalized.messages[1].content, /missing_tool_result/);
});
