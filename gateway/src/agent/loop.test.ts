import assert from 'node:assert/strict';
import test from 'node:test';
import type {
    ChatOptions,
    ChatWithToolsResponse,
    LLMMessage,
    LLMProvider,
    LLMToolDefinition,
} from '../llm/provider';
import { ToolRegistry } from '../tools/registry';
import { generatedArtifactPaths } from './manager';
import {
    agentLoopCompletionStatus,
    DEFAULT_MAX_AGENT_ITERATIONS,
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
    officeAnalysisConvergenceDecision,
    presentationCostBudgetDecision,
    presentationDesignContinuityDecision,
    presentationTerminalFailureMessage,
    presentationToolFailureIsTerminal,
    runAgentLoop,
    shouldCommitReadOnlyInformationAnswer,
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
    assert.equal(fake.offeredTools[2]?.length, 0);
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
