import assert from 'node:assert/strict';
import test from 'node:test';
import type {
    ChatOptions,
    ChatWithToolsResponse,
    LLMMessage,
    LLMProvider,
    LLMToolDefinition,
} from '../llm/provider';
import { LLMError } from '../llm/llm-error';
import { ToolRegistry } from '../tools/registry';
import { generatedArtifactPaths } from './manager';
import {
    agentLoopCompletionStatus,
    DEFAULT_MAX_AGENT_ITERATIONS,
    enforcePresentationSlideCountContract,
    explicitPresentationSlideCount,
    isStandalonePresentationCreationRequest,
    MAX_OFFICE_ANALYSIS_CALLS_PER_TURN,
    MAX_PRESENTATION_IMAGE_CALLS_PER_TURN,
    MAX_PRESENTATION_RENDER_CALLS_PER_TURN,
    MAX_PRESENTATION_REVIEW_CALLS_PER_TURN,
    MAX_PRESENTATION_TOOL_CALLS_PER_TURN,
    MAX_PRESENTATION_WEB_FETCH_CALLS_PER_TURN,
    MAX_PRESENTATION_WEB_SEARCH_CALLS_PER_TURN,
    TARGET_PRESENTATION_TOOL_CALLS_PER_TURN,
    ToolFailureCircuitBreaker,
    normalizeToolCallTranscript,
    PRESENTATION_ITERATION_RESERVE,
    iterationBudgetDirective,
    officeAnalysisConvergenceDecision,
    officeAnalysisSourceKey,
    presentationCostBudgetDecision,
    presentationDesignContinuityDecision,
    presentationTerminalFailureMessage,
    presentationToolFailureRequiresHardStop,
    presentationToolFailureIsTerminal,
    runAgentLoop,
    shouldCommitReadOnlyInformationAnswer,
    toolFailureAttemptLimit,
} from './loop';

test('presentation slide count is a user-owned contract, not an Agent default', () => {
    assert.equal(explicitPresentationSlideCount('请生成 13 页 PPT'), 13);
    assert.equal(explicitPresentationSlideCount('Make this an exactly 18-slide deck.'), 18);
    assert.equal(explicitPresentationSlideCount('做一份中国 AI 发展演示文稿'), undefined);
    assert.equal(explicitPresentationSlideCount('控制在 12 到 15 页'), undefined);
    assert.equal(explicitPresentationSlideCount('大约 13 页左右'), undefined);

    assert.deepEqual(enforcePresentationSlideCountContract({
        brief: { title: 'AI', requested_slide_count: 13 },
    }, undefined), {
        brief: { title: 'AI' },
    });
    assert.deepEqual(enforcePresentationSlideCountContract({
        brief: { title: 'AI', requested_slide_count: 15 },
    }, 13), {
        brief: { title: 'AI', requested_slide_count: 13 },
    });
});

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
    assert.equal(MAX_PRESENTATION_RENDER_CALLS_PER_TURN, 6);
    assert.equal(MAX_PRESENTATION_REVIEW_CALLS_PER_TURN, 4);
    assert.equal(MAX_PRESENTATION_TOOL_CALLS_PER_TURN, 10);
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
    const afterThirdReview = [
        ...fullExceptionalWorkflow,
        { name: 'generate_presentation', args: { workflow: { stage: 'review' } } },
    ];
    assert.equal(presentationCostBudgetDecision(
        true,
        'generate_presentation',
        afterThirdReview,
        { workflow: { stage: 'revision' } },
    ).allowed, true);
    const afterMechanicalRepair = [
        ...afterThirdReview,
        { name: 'generate_presentation', args: { workflow: { stage: 'revision' } } },
    ];
    assert.equal(presentationCostBudgetDecision(
        true,
        'generate_presentation',
        afterMechanicalRepair,
        { workflow: { stage: 'review' } },
    ).allowed, true);
    const afterFinalReview = [
        ...afterMechanicalRepair,
        { name: 'generate_presentation', args: { workflow: { stage: 'review' } } },
    ];
    assert.equal(presentationCostBudgetDecision(
        true,
        'generate_presentation',
        afterFinalReview,
        { workflow: { stage: 'revision' } },
    ).reason, 'presentation_render_budget');
    assert.equal(presentationCostBudgetDecision(
        true,
        'generate_presentation',
        afterFinalReview,
        { workflow: { stage: 'review' } },
    ).reason, 'presentation_review_budget');
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
    // A review the tool refused on shape never became stored evidence, so the
    // model still owes a real review and must not be charged for the attempt.
    const rejectedReview = {
        name: 'generate_presentation',
        args: { workflow: { stage: 'review' } },
        result: {
            success: false,
            code: 'presentation_visual_review_incomplete',
            data: { route: 'local_presentation', files: [] },
        },
    };
    assert.deepEqual(presentationCostBudgetDecision(
        true,
        'generate_presentation',
        Array(MAX_PRESENTATION_REVIEW_CALLS_PER_TURN).fill(rejectedReview),
        { workflow: { stage: 'review' } },
    ), { allowed: true, used: 0, limit: MAX_PRESENTATION_REVIEW_CALLS_PER_TURN });
    // A regressed review is discarded by the tool for the same reason.
    const discardedReview = {
        name: 'generate_presentation',
        args: { workflow: { stage: 'review' } },
        result: {
            success: true,
            data: { route: 'local_presentation', qa: { status: 'regressed', errors: 3, warnings: 1 } },
        },
    };
    assert.deepEqual(presentationCostBudgetDecision(
        true,
        'generate_presentation',
        Array(MAX_PRESENTATION_REVIEW_CALLS_PER_TURN).fill(discardedReview),
        { workflow: { stage: 'review' } },
    ), { allowed: true, used: 0, limit: MAX_PRESENTATION_REVIEW_CALLS_PER_TURN });
    // An accepted review still costs a slot.
    const acceptedReview = {
        name: 'generate_presentation',
        args: { workflow: { stage: 'review' } },
        result: {
            success: true,
            data: { route: 'local_presentation', qa: { status: 'needs_revision', errors: 1, warnings: 1 } },
        },
    };
    assert.equal(presentationCostBudgetDecision(
        true,
        'generate_presentation',
        Array(MAX_PRESENTATION_REVIEW_CALLS_PER_TURN).fill(acceptedReview),
        { workflow: { stage: 'review' } },
    ).reason, 'presentation_review_budget');
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

test('vision-unavailable and exhausted quality gates forbid alternative tool fallbacks', () => {
    assert.equal(presentationToolFailureRequiresHardStop({
        success: false,
        code: 'presentation_visual_review_unavailable',
        retryable: false,
    }), true);
    assert.equal(presentationToolFailureRequiresHardStop({
        success: false,
        code: 'presentation_quality_gate_failed',
        retryable: false,
    }), true);
    assert.equal(presentationToolFailureRequiresHardStop({
        success: false,
        code: 'presentation_requested_slide_count_mismatch',
        retryable: false,
    }), false);
    assert.equal(presentationToolFailureRequiresHardStop({
        success: false,
        code: 'presentation_structure_preflight_failed',
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

test('presentation guard rejections get more identical attempts than rendered failures', () => {
    const failure = {
        success: false,
        code: 'presentation_direction_quality_gate_failed',
        error: 'All three visual directions failed structural or rendering QA.',
    };
    // Three directions were rendered and judged: a real failure, standard limit.
    assert.equal(toolFailureAttemptLimit('generate_presentation', failure), 3);
    // Declined on shape before any render: the model can act on the message,
    // and two strikes used to end a turn with no deck at all.
    assert.equal(toolFailureAttemptLimit('generate_presentation', {
        ...failure,
        code: 'presentation_structure_preflight_failed',
    }), 4);
    assert.equal(toolFailureAttemptLimit('generate_presentation', {
        ...failure,
        code: 'presentation_revision_slide_count_change',
    }), 4);
    assert.equal(toolFailureAttemptLimit('generate_presentation', {
        ...failure,
        code: 'presentation_sample_fact_contract_violation',
    }), 4);
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

    // A late workflow rejection carries mechanicalRepair instead of qa, and the last
    // clean render must still be named so the report is not falsely empty.
    const blocked = presentationTerminalFailureMessage({
        success: false,
        error: 'A final mechanical repair is unavailable because non-mechanical visual or structural errors remain.',
        data: {
            files: [],
            mechanicalRepair: { allowed: false },
            workflowState: {
                qa: { errors: 3, warnings: 1 },
                outputs: { pptx: 'D:\\out\\deck-revision-2.pptx', pdf: 'D:\\out\\deck-revision-2.pdf' },
            },
        },
    }, true);
    assert.match(blocked, /3 个错误、1 个警告/);
    assert.match(blocked, /deck-revision-2\.pptx/);
    assert.match(blocked, /deck-revision-2\.pdf/);
    assert.doesNotMatch(blocked, /已交付|已完成/);

    // An early workflow rejection reports no state at all. Reading only the last
    // result told a user nothing had been produced while a complete pptx and pdf
    // sat in the output folder, so earlier results have to be consulted.
    const earlyRejection = {
        success: false,
        error: 'Visual revision would change the rendered slide count from 12 to 15.',
        code: 'presentation_revision_slide_count_change',
    };
    const rendered = {
        success: true,
        data: {
            workflowState: {
                qa: { errors: 10, warnings: 4 },
                outputs: { pptx: 'D:\\out\\brief.pptx', pdf: 'D:\\out\\brief.pdf' },
            },
        },
    };
    const recovered = presentationTerminalFailureMessage(earlyRejection, false, [rendered, earlyRejection]);
    assert.match(recovered, /brief\.pptx/);
    assert.match(recovered, /brief\.pdf/);
    assert.match(recovered, /not published to the artifact panel/);
    // With nothing on disk the blunt wording is the truthful one.
    assert.match(presentationTerminalFailureMessage(earlyRejection, false), /no artifact was published/);
});

test('a deck request phrased as tidying up is still a deck request', () => {
    // "整理成ppt" names the deliverable as plainly as "生成一个ppt" does. Missing it
    // disengaged the slide-count contract, and a count the model invented for
    // itself was then enforced as though the user had insisted on fourteen slides.
    assert.equal(isStandalonePresentationCreationRequest('帮我查询下今天ai领域的重要新闻 并整理成ppt'), true);
    assert.equal(isStandalonePresentationCreationRequest('把这些结论汇总成一个演示文稿'), true);
    assert.equal(isStandalonePresentationCreationRequest('summarize these findings into a slide deck'), true);
    // Questions about decks are still questions.
    assert.equal(isStandalonePresentationCreationRequest('ppt 生成的流程是怎么实现的'), false);
});

test('a slide count the user never gave is stripped however the request was phrased', () => {
    const inflated = { brief: { audience: '管理层', requested_slide_count: 14 } };
    const briefOf = (args: Record<string, unknown>) => args.brief as Record<string, unknown>;
    assert.equal(briefOf(enforcePresentationSlideCountContract(inflated, undefined)).requested_slide_count, undefined);
    assert.equal(briefOf(enforcePresentationSlideCountContract(inflated, undefined)).audience, '管理层');
    // A count the user did give survives, and replaces whatever the model guessed.
    assert.equal(briefOf(enforcePresentationSlideCountContract(inflated, 10)).requested_slide_count, 10);
    assert.equal(explicitPresentationSlideCount('帮我查询下今天ai领域的重要新闻 并整理成ppt'), undefined);
    assert.equal(explicitPresentationSlideCount('做一个10页的ppt'), 10);
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

test('a deck reached through a follow-up edit is judged on the deck, not on the wording', () => {
    // "增加几个配图吧" names no deck, so intent classification leaves
    // presentationWorkflowRequired false. Judging on that alone reported a deck
    // still carrying eighteen QA errors as a completed execution.
    assert.equal(agentLoopCompletionStatus(false, [{
        name: 'generate_presentation',
        result: { success: true, data: { completion: { complete: false, missing: ['qa_errors_remain'] } } },
    }]), 'failed');
    assert.equal(agentLoopCompletionStatus(false, [{
        name: 'generate_presentation',
        result: { success: true, data: { completion: { complete: true } } },
    }]), 'completed');
    // A turn that never touched the tool is still none of this gate's business.
    assert.equal(agentLoopCompletionStatus(false, [{ name: 'web_search', result: { success: true } }]), 'completed');
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

function sequenceProvider(options: {
    responses: (tools: LLMToolDefinition[], call: number) => ChatWithToolsResponse;
    verify?: (messages: LLMMessage[], opts?: ChatOptions) => Promise<string>;
}) {
    let modelCalls = 0;
    let verificationCalls = 0;
    const offeredTools: string[][] = [];
    const provider: LLMProvider = {
        async chat(messages, opts) {
            verificationCalls++;
            return options.verify?.(messages, opts) ?? 'COMPLETED';
        },
        async chatStream() { return ''; },
        async chatWithTools(_messages, tools) {
            offeredTools.push(tools.map(tool => tool.name));
            return options.responses(tools, modelCalls++);
        },
        getConfig: () => ({ provider: 'moonshot', model: 'kimi-k3' }),
        async embed() { return []; },
        async embedBatch() { return []; },
    };
    return {
        provider,
        get modelCalls() { return modelCalls; },
        get verificationCalls() { return verificationCalls; },
        offeredTools,
    };
}

function registryWithTool(name: string, execute: () => Promise<{ success: boolean; data?: unknown }>): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register({
        name,
        description: `${name} test tool`,
        parameters: {},
        execute,
    });
    return registry;
}

test('ordinary question answering completes in one model turn without verification overhead', async () => {
    const fake = sequenceProvider({
        responses: () => ({ content: '巴黎是法国的首都。', toolCalls: [] }),
        verify: async () => {
            throw new Error('a tool-free answer must not invoke post-answer audits');
        },
    });

    const result = await runAgentLoop('法国的首都是什么？', {
        llm: fake.provider,
        tools: new ToolRegistry(),
        language: 'zh',
        approvalMode: 'full_access',
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.output, '巴黎是法国的首都。');
    assert.equal(result.iterations, 1);
    assert.equal(result.toolCalls.length, 0);
    assert.equal(fake.verificationCalls, 0);
});

test('text-only presentation failure stops before a Python or filesystem fallback can run', async () => {
    let fallbackExecutions = 0;
    const fake = sequenceProvider({
        responses: (_tools, call) => call === 0
            ? {
                content: '',
                toolCalls: [{ id: 'deck', name: 'generate_presentation', arguments: { workflow: { stage: 'sample' } } }],
            }
            : {
                content: '当前模型不能看图，我改用 Python。',
                toolCalls: [{ id: 'fallback', name: 'filesystem', arguments: { action: 'write', path: 'fallback.py' } }],
            },
    });
    const tools = new ToolRegistry();
    tools.register({
        name: 'generate_presentation',
        description: 'presentation test tool',
        parameters: {},
        async execute() {
            return {
                success: false,
                error: 'The active model selected by the current Flux mode is text-only.',
                code: 'presentation_visual_review_unavailable',
                retryable: false,
                data: {
                    files: [],
                    designId: 'durable-deck',
                    designPersisted: true,
                    completion: { complete: false, files: [] },
                },
            };
        },
    });
    tools.register({
        name: 'filesystem',
        description: 'filesystem test tool',
        parameters: {},
        async execute() {
            fallbackExecutions++;
            return { success: true };
        },
    });

    const result = await runAgentLoop('帮我生成一份中国 AI 发展总结 PPT', {
        llm: fake.provider,
        tools,
        language: 'zh',
        approvalMode: 'full_access',
    });

    assert.equal(result.status, 'failed');
    assert.equal(fallbackExecutions, 0);
    assert.equal(result.toolCalls.length, 1);
    assert.match(result.output, /没有发布到成果物面板/);
    assert.doesNotMatch(result.output, /改用 Python/);
});

test('presentation images bypass stale capability metadata and stop only after a real rejection', async () => {
    let modelCalls = 0;
    let receivedImage = false;
    let toolSawVisionAttempt = false;
    const provider: LLMProvider = {
        async chat() { return 'COMPLETED'; },
        async chatStream() { return ''; },
        async chatWithTools(messages) {
            modelCalls++;
            if (modelCalls === 1) {
                return {
                    content: '',
                    toolCalls: [{ id: 'sample', name: 'generate_presentation', arguments: {
                        brief: {
                            title: 'AI', audience: '管理者', purpose: '汇报', desired_outcome: '理解趋势',
                            requested_slide_count: 13,
                        },
                        workflow: { stage: 'sample' },
                    } }],
                };
            }
            receivedImage = messages.some(message => message.contentParts?.some(part => part.type === 'image'));
            throw new LLMError(
                'This endpoint does not support image input.',
                'IMAGE_INPUT_UNSUPPORTED',
                'custom',
                { retryable: false, allowModelFallback: false },
            );
        },
        getConfig: () => ({
            provider: 'custom',
            model: 'private-model-alias',
            capabilities: { vision: false },
        }),
        async embed() { return []; },
        async embedBatch() { return []; },
    };
    const tools = new ToolRegistry();
    tools.register({
        name: 'generate_presentation',
        description: 'presentation test tool',
        parameters: {},
        async execute(args, context) {
            toolSawVisionAttempt = context?.activeModel?.vision === true;
            assert.equal((args.brief as { requested_slide_count?: number }).requested_slide_count, undefined);
            return {
                success: true,
                images: [{ mimeType: 'image/png', data: 'c2FtcGxl', description: 'sample' }],
                data: {
                    designId: 'runtime-probe-deck',
                    completion: { complete: false, files: [] },
                },
            };
        },
    });

    const result = await runAgentLoop('帮我生成一份中国 AI 发展演示文稿', {
        llm: provider,
        tools,
        language: 'zh',
        approvalMode: 'full_access',
    });

    assert.equal(modelCalls, 2);
    assert.equal(toolSawVisionAttempt, true);
    assert.equal(receivedImage, true);
    assert.equal(result.status, 'failed');
    assert.match(result.output, /实际接收 PPT 评审图片时明确拒绝/);
    assert.match(result.output, /runtime-probe-deck/);
    assert.doesNotMatch(result.output, /切换模型.*完成/);
});

test('successful mutation completes after both post-answer audits agree', async () => {
    let executions = 0;
    let audit = 0;
    const fake = sequenceProvider({
        responses: (_tools, call) => call === 0
            ? {
                content: '',
                toolCalls: [{ id: 'create-record', name: 'test_mutation', arguments: { title: '回归测试' } }],
            }
            : { content: '测试记录已经创建。', toolCalls: [] },
        verify: async () => audit++ === 0 ? 'COMPLETED' : 'CONSISTENT',
    });

    const result = await runAgentLoop('创建一条名为“回归测试”的记录', {
        llm: fake.provider,
        tools: registryWithTool('test_mutation', async () => {
            executions++;
            return { success: true, data: { id: 'record-1' } };
        }),
        language: 'zh',
        approvalMode: 'full_access',
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.output, '测试记录已经创建。');
    assert.equal(executions, 1);
    assert.equal(fake.verificationCalls, 2);
});

test('Office analysis can advance to the next page before producing a final answer', async () => {
    let executions = 0;
    const fake = sequenceProvider({
        responses: (_tools, call) => {
            if (call < 2) {
                return {
                    content: '',
                    toolCalls: [{
                        id: `read-page-${call + 1}`,
                        name: 'office',
                        arguments: {
                            action: 'excel',
                            subAction: 'read',
                            filePath: 'members.xlsx',
                            startRow: call === 0 ? 1 : 51,
                            maxRows: 50,
                        },
                    }],
                };
            }
            return { content: '两页数据已分析完成，共发现 4 条异常记录。', toolCalls: [] };
        },
        verify: async () => {
            throw new Error('read-only answer must not invoke a hidden audit');
        },
    });

    const result = await runAgentLoop('分页分析表格中的异常记录', {
        llm: fake.provider,
        tools: registryWithTool('office', async () => {
            executions++;
            return { success: true, data: { rows: [{ risk: 'high' }] } };
        }),
        language: 'zh',
        approvalMode: 'full_access',
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.output, '两页数据已分析完成，共发现 4 条异常记录。');
    assert.equal(executions, 2);
    assert.equal(result.toolCalls.some(call => (
        call.result as { code?: string } | undefined
    )?.code === 'OFFICE_ANALYSIS_CONVERGED'), false);
});

test('user cancellation interrupts a hidden audit even when the provider ignores AbortSignal', async () => {
    const controller = new AbortController();
    const fake = sequenceProvider({
        responses: (_tools, call) => call === 0
            ? {
                content: '',
                toolCalls: [{ id: 'mutation-before-stop', name: 'test_mutation', arguments: {} }],
            }
            : { content: '写入已经完成。', toolCalls: [] },
        verify: async () => new Promise<string>(() => undefined),
    });
    const startedAt = Date.now();

    await assert.rejects(runAgentLoop('写入一条记录', {
        llm: fake.provider,
        tools: registryWithTool('test_mutation', async () => ({ success: true, data: { created: true } })),
        language: 'zh',
        approvalMode: 'full_access',
        abortSignal: controller.signal,
        verificationTimeoutMs: 500,
        onToolStart: description => {
            if (description.includes('核验结果完整性')) {
                setTimeout(() => controller.abort('scenario stop'), 10);
            }
        },
    }), error => error instanceof Error && error.name === 'AbortError');

    assert.ok(Date.now() - startedAt < 200, 'cancellation should not wait for the verification timeout');
});

test('read-only information answers commit without hidden completion or claim audits', async () => {
    let executions = 0;
    const fake = sequenceProvider({
        responses: (_tools, call) => call === 0
            ? {
                content: '',
                toolCalls: [{
                    id: 'office-profile',
                    name: 'office',
                    arguments: { action: 'excel', subAction: 'profile', filePath: 'sample.xlsx' },
                }],
            }
            : { content: '发现 3 名未拉黑但存在高风险行为的会员。', toolCalls: [] },
        verify: async () => {
            throw new Error('read-only answer must not invoke a hidden audit');
        },
    });
    const result = await runAgentLoop('帮我看下有哪些没拉黑的人是异常的', {
        llm: fake.provider,
        tools: registryWithTool('office', async () => {
            executions++;
            return { success: true, data: { rows: [{ risk: 'high' }] } };
        }),
        language: 'zh',
        approvalMode: 'full_access',
    });

    assert.equal(result.output, '发现 3 名未拉黑但存在高风险行为的会员。');
    assert.equal(result.status, 'completed');
    assert.equal(executions, 1);
    assert.equal(fake.verificationCalls, 0);
});

test('hidden post-answer audits time out and pass through the existing answer', async () => {
    const progress: string[] = [];
    const fake = sequenceProvider({
        responses: (_tools, call) => call === 0
            ? {
                content: '',
                toolCalls: [{ id: 'mutation-1', name: 'test_mutation', arguments: {} }],
            }
            : { content: '测试记录已经创建。', toolCalls: [] },
        // Deliberately ignore AbortSignal: Promise.race must still release the turn.
        verify: async () => new Promise<string>(() => undefined),
    });
    const startedAt = Date.now();
    const result = await runAgentLoop('创建一份测试记录', {
        llm: fake.provider,
        tools: registryWithTool('test_mutation', async () => ({ success: true, data: { created: true } })),
        language: 'zh',
        approvalMode: 'full_access',
        verificationTimeoutMs: 20,
        onToolStart: description => progress.push(description),
    });

    assert.equal(result.output, '测试记录已经创建。');
    assert.equal(result.status, 'completed');
    assert.equal(fake.verificationCalls, 2);
    assert.ok(Date.now() - startedAt < 1_000);
    assert.equal(progress.filter(message => message.includes('正在核验结果完整性')).length, 1);
});

test('repeated Office reads are skipped and force a final answer from existing evidence', async () => {
    let executions = 0;
    const fake = sequenceProvider({
        responses: (_tools, call) => {
            if (call === 0) {
                return {
                    content: '',
                    toolCalls: [{
                        id: 'read-500',
                        name: 'office',
                        arguments: { action: 'excel', subAction: 'read', filePath: 'members.xlsx', startRow: 1, maxRows: 500 },
                    }],
                };
            }
            if (call === 1) {
                return {
                    content: '',
                    toolCalls: [{
                        id: 'read-200',
                        name: 'office',
                        arguments: { action: 'excel', subAction: 'read', filePath: 'members.xlsx', startRow: 1, maxRows: 200 },
                    }],
                };
            }
            return { content: '根据已有数据，异常人员共 2 名。', toolCalls: [] };
        },
        verify: async () => {
            throw new Error('converged information answer must not invoke a hidden audit');
        },
    });
    const result = await runAgentLoop('分析表格里哪些人员异常', {
        llm: fake.provider,
        tools: registryWithTool('office', async () => {
            executions++;
            return { success: true, data: { rows: [{ id: 1 }, { id: 2 }], nextStartRow: 51 } };
        }),
        language: 'zh',
        approvalMode: 'full_access',
    });

    assert.equal(executions, 1);
    assert.equal(result.output, '根据已有数据，异常人员共 2 名。');
    // Only the exhausted source is banned, so the tool itself stays registered.
    assert.deepEqual(fake.offeredTools[2], ['office']);
    assert.equal(fake.verificationCalls, 0);
    assert.equal((result.toolCalls[1]?.result as { code?: string }).code, 'OFFICE_ANALYSIS_CONVERGED');
});

test('the last finite iteration is reserved for an evidence-based final answer', async () => {
    let executions = 0;
    const fake = sequenceProvider({
        responses: (tools, call) => tools.length > 0
            ? {
                content: '',
                toolCalls: [{ id: `read-${call}`, name: 'file_reader', arguments: { path: `page-${call}.txt` } }],
            }
            : { content: '已根据前两页内容完成总结。', toolCalls: [] },
        verify: async () => {
            throw new Error('read-only answer must not invoke a hidden audit');
        },
    });
    const result = await runAgentLoop('看看这些页面并总结', {
        llm: fake.provider,
        tools: registryWithTool('file_reader', async () => {
            executions++;
            return { success: true, data: { text: 'evidence' } };
        }),
        language: 'zh',
        approvalMode: 'full_access',
        maxIterations: 3,
    });

    assert.equal(DEFAULT_MAX_AGENT_ITERATIONS, 30);
    assert.equal(result.iterations, 3);
    assert.equal(executions, 2);
    assert.equal(fake.offeredTools[2]?.length, 0);
    assert.equal(result.output, '已根据前两页内容完成总结。');
});

test('a spent budget lets a deck turn report what it built instead of demanding a withdrawn tool', async () => {
    let executions = 0;
    const fake = sequenceProvider({
        responses: (tools) => tools.length > 0
            ? {
                content: '',
                toolCalls: [{
                    id: `deck-${executions}`,
                    name: 'generate_presentation',
                    arguments: { workflow: { stage: 'review' } },
                }],
            }
            : { content: '演示文稿已渲染完成但未完成逐页评审，文件见 D:\\out\\deck.pptx。', toolCalls: [] },
        verify: async () => {
            throw new Error('a budget-limited summary must not invoke a hidden audit');
        },
    });
    const result = await runAgentLoop('帮我生成一个ppt', {
        llm: fake.provider,
        tools: registryWithTool('generate_presentation', async () => {
            executions++;
            // The deck renders clean but its review is not banked yet, so the
            // completion predicate stays unsatisfied to the very last iteration.
            return {
                success: true,
                data: {
                    completion: {
                        complete: false,
                        missing: ['not_all_slides_reviewed'],
                        nextAction: 'submit_review',
                    },
                },
            };
        }),
        language: 'zh',
        approvalMode: 'full_access',
        maxIterations: 3,
    });

    // Tools are gone on the final pass, so insisting on another generate_presentation
    // call would deadlock the turn and bury this summary.
    assert.equal(fake.offeredTools[2]?.length, 0);
    assert.match(result.output, /deck\.pptx/);
    assert.equal(result.iterations, 3);
});

test('the deck reserve withdraws the analysis tools instead of asking the model to stop', async () => {
    // Told in prose that fewer than the reserve remained, a live turn wrote Python
    // for five more iterations and then ran out mid-revision with the deck unfinished.
    // This model does the same thing: it analyzes for as long as it is allowed to.
    const registry = new ToolRegistry();
    let deckCalls = 0;
    registry.register({
        name: 'process',
        description: 'process test tool',
        parameters: {},
        execute: async () => ({ success: true, data: { stdout: '分析输出' } }),
    });
    registry.register({
        name: 'generate_presentation',
        description: 'generate_presentation test tool',
        parameters: {},
        execute: async () => {
            deckCalls++;
            return { success: true, data: { completion: { complete: false, missing: ['qa_errors_remain'] } } };
        },
    });
    const fake = sequenceProvider({
        responses: (tools, call) => {
            const names = tools.map(tool => tool.name);
            if (!names.length) return { content: '初稿已渲染，文件见 D:\\out\\deck.pptx。', toolCalls: [] };
            const name = names.includes('process') ? 'process' : 'generate_presentation';
            return { content: '', toolCalls: [{ id: `${name}-${call}`, name, arguments: {} }] };
        },
        verify: async () => 'COMPLETED',
    });

    await runAgentLoop('帮我生成一个ppt', {
        llm: fake.provider,
        tools: registry,
        language: 'zh',
        approvalMode: 'full_access',
        maxIterations: 4,
    });

    // First pass has no evidence yet, so the turn is left alone to gather some.
    assert.ok(fake.offeredTools[0]?.includes('process'));
    // Second pass falls inside the reserve: only the deliverable remains callable.
    assert.deepEqual(fake.offeredTools[1], ['generate_presentation']);
    assert.ok(deckCalls > 0);
    // The reserve only had to get the deck started; verifying and reporting on it
    // needs the rest of the toolset back.
    assert.ok(fake.offeredTools[2]?.includes('process'));
});

test('a deck-building turn holds iterations back for the deck and never ends silently', () => {
    const budget = { iterations: 20, maxIterations: 30, toolCallCount: 19 };

    // A plain analysis turn is left alone until its final pass.
    assert.equal(iterationBudgetDirective({
        ...budget,
        presentationWorkflowRequired: false,
        presentationWorkflowStarted: false,
    }), undefined);

    // A deck was requested and has not started, so the remaining budget is claimed
    // for it while it is still reachable.
    assert.equal(iterationBudgetDirective({
        ...budget,
        presentationWorkflowRequired: true,
        presentationWorkflowStarted: false,
    }), 'start_presentation');

    // Once the workflow is under way its own budget guards take over.
    assert.equal(iterationBudgetDirective({
        ...budget,
        presentationWorkflowRequired: true,
        presentationWorkflowStarted: true,
    }), undefined);

    // The last pass is reserved for a committed answer even when a deck was required.
    // Exempting deck turns here is what let a full workbook analysis reach the user as
    // nothing at all: no deck, and no words either.
    assert.equal(iterationBudgetDirective({
        iterations: 29,
        maxIterations: 30,
        toolCallCount: 43,
        presentationWorkflowRequired: true,
        presentationWorkflowStarted: false,
    }), 'finalize');

    // Nothing has been gathered yet, so there is neither a summary nor a deck to make.
    assert.equal(iterationBudgetDirective({
        iterations: 29,
        maxIterations: 30,
        toolCallCount: 0,
        presentationWorkflowRequired: true,
        presentationWorkflowStarted: false,
    }), undefined);

    // The reserve has to cover the state machine's longest legal path — sample,
    // render, review, then a revision and its review three times over — plus the
    // model passes spent reasoning between those calls. A ten-call reserve left a
    // deck that had reached zero QA errors stranded one review short of delivery.
    assert.equal(PRESENTATION_ITERATION_RESERVE, 14);

    // One iteration above the reserve the turn may still gather evidence.
    assert.equal(iterationBudgetDirective({
        iterations: 15,
        maxIterations: 30,
        toolCallCount: 19,
        presentationWorkflowRequired: true,
        presentationWorkflowStarted: false,
    }), undefined);

    // At the reserve the deck claims what is left.
    assert.equal(iterationBudgetDirective({
        iterations: 16,
        maxIterations: 30,
        toolCallCount: 19,
        presentationWorkflowRequired: true,
        presentationWorkflowStarted: false,
    }), 'start_presentation');
});

test('Office convergence distinguishes advancing pages from redundant reads', () => {
    const previous = [{
        name: 'office',
        args: { action: 'excel', subAction: 'read', filePath: 'members.xlsx', startRow: 1, maxRows: 50 },
        result: { success: true },
    }];
    assert.equal(officeAnalysisConvergenceDecision('office', {
        action: 'excel', subAction: 'read', filePath: 'members.xlsx', startRow: 51, maxRows: 50,
    }, previous).converge, false);
    assert.deepEqual(officeAnalysisConvergenceDecision('office', {
        action: 'excel', subAction: 'read', filePath: 'members.xlsx', startRow: 1, maxRows: 200,
    }, previous), {
        converge: true,
        reason: 'repeated_analysis',
        used: 2,
        limit: 1,
    });
    assert.equal(MAX_OFFICE_ANALYSIS_CALLS_PER_TURN, 8);
    assert.equal(shouldCommitReadOnlyInformationAnswer('创建一个异常名单', '完成', previous), false);
    assert.equal(shouldCommitReadOnlyInformationAnswer('有哪些异常人员', '有 2 人', previous), true);
});

test('Office convergence treats each worksheet of one workbook as its own source', () => {
    const previous = [{
        name: 'office',
        args: { action: 'excel', subAction: 'read', filePath: 'report.xlsx', sheet: 'Topps MNP Monthly Report' },
        result: { success: true },
    }];
    // A different sheet is new evidence even though both reads start at row 1.
    assert.equal(officeAnalysisConvergenceDecision('office', {
        action: 'excel', subAction: 'read', filePath: 'report.xlsx', sheet: 'Product Performance by Week',
    }, previous).converge, false);
    // The same sheet from the same starting row still converges.
    assert.equal(officeAnalysisConvergenceDecision('office', {
        action: 'excel', subAction: 'read', filePath: 'report.xlsx', sheet: 'Topps MNP Monthly Report', maxRows: 200,
    }, previous).reason, 'repeated_analysis');
});

test('Office convergence never calls a repeated profile redundant', () => {
    const previous = [{
        name: 'office',
        args: { action: 'excel', subAction: 'profile', filePath: 'report.xlsx' },
        result: { success: true },
    }];
    // Compaction evicts the first profile long before the turn ends, so re-asking for
    // the sheet names is a caller recovering its map, not a caller looping.
    const decision = officeAnalysisConvergenceDecision('office', {
        action: 'excel', subAction: 'profile', filePath: 'report.xlsx',
    }, previous);
    assert.equal(decision.converge, false);
    assert.equal(decision.used, 2);
    // A profile shares its source key with a read of the default worksheet, so it must
    // stay outside the per-source ban set or an exhausted read would block it.
    assert.equal(officeAnalysisSourceKey('office', {
        action: 'excel', subAction: 'profile', filePath: 'report.xlsx',
    }), undefined);
    assert.ok(officeAnalysisSourceKey('office', {
        action: 'excel', subAction: 'read', filePath: 'report.xlsx',
    }));
});

test('Office convergence bans only the exhausted sheet, not sheets never read', async () => {
    const executed: string[] = [];
    const fake = sequenceProvider({
        responses: (_tools, call) => {
            const read = (id: string, sheet: string) => ({
                content: '',
                toolCalls: [{
                    id,
                    name: 'office',
                    arguments: { action: 'excel', subAction: 'read', filePath: 'report.xlsx', sheet },
                }],
            });
            if (call === 0) return read('a', 'Sheet1');
            // Same sheet again: must converge and be skipped.
            if (call === 1) return read('b', 'Sheet1');
            // A sheet the turn never touched: must still execute.
            if (call === 2) return read('c', 'Monthly Search Index');
            return { content: '两张工作表的结论如下。', toolCalls: [] };
        },
        verify: async () => 'COMPLETED',
    });
    const result = await runAgentLoop('分析这个表格的各个工作表', {
        llm: fake.provider,
        tools: registryWithTool('office', async () => {
            executed.push('read');
            return { success: true, data: { rows: [{ id: 1 }] } };
        }),
        language: 'zh',
        approvalMode: 'full_access',
    });

    assert.equal(executed.length, 2);
    assert.equal((result.toolCalls[1]?.result as { code?: string }).code, 'OFFICE_ANALYSIS_CONVERGED');
    assert.equal((result.toolCalls[2]?.result as { success?: boolean }).success, true);
    assert.equal((result.toolCalls[2]?.result as { code?: string }).code, undefined);
    assert.equal(result.output, '两张工作表的结论如下。');
});

test('Office convergence keeps non-spreadsheet tools available for the rest of the turn', async () => {
    let officeExecutions = 0;
    let processExecutions = 0;
    const fake = sequenceProvider({
        responses: (tools, call) => {
            if (call <= 1) {
                return {
                    content: '',
                    toolCalls: [{
                        id: `read-${call}`,
                        name: 'office',
                        arguments: { action: 'excel', subAction: 'read', filePath: 'report.xlsx', sheet: 'Sheet1' },
                    }],
                };
            }
            if (call === 2) {
                // The exhausted sheet is banned per source, so nothing is withdrawn and
                // the computation fallback is still reachable.
                assert.deepEqual(tools.map(tool => tool.name), ['office', 'process']);
                return {
                    content: '',
                    toolCalls: [{ id: 'py-1', name: 'process', arguments: { command: 'python analyze.py' } }],
                };
            }
            return { content: '两张表的差异已用脚本核对完成。', toolCalls: [] };
        },
        verify: async () => 'COMPLETED',
    });
    const tools = new ToolRegistry();
    tools.register({
        name: 'office',
        description: 'office test tool',
        parameters: {},
        execute: async () => {
            officeExecutions++;
            return { success: true, data: { rows: [{ id: 1 }] } };
        },
    });
    tools.register({
        name: 'process',
        description: 'process test tool',
        parameters: {},
        execute: async () => {
            processExecutions++;
            return { success: true, data: { stdout: 'diff computed' } };
        },
    });

    const result = await runAgentLoop('分析这两个表格', {
        llm: fake.provider,
        tools,
        language: 'zh',
        approvalMode: 'full_access',
    });

    assert.equal(officeExecutions, 1);
    assert.equal(processExecutions, 1);
    assert.equal(result.output, '两张表的差异已用脚本核对完成。');
});
