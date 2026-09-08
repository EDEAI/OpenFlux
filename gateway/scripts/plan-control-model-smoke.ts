import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config/loader';
import { createLLMProvider } from '../src/llm/factory';
import { ToolRegistry } from '../src/tools/registry';
import { createPublishPlanDocumentTool, createRequestPlanInputTool } from '../src/tools/plan-control';
import { PlanStore } from '../src/work/store';
import type { ToolExecutionContext } from '../src/tools/types';

const scratch = mkdtempSync(join(tmpdir(), 'openflux-plan-model-smoke-'));

try {
    const config = await loadConfig();
    const workspace = config.workspace ? resolve(config.workspace) : resolve(process.cwd(), '..');
    const savedConfigPath = join(workspace, 'server-config.json');
    const savedConfig = existsSync(savedConfigPath)
        ? JSON.parse(readFileSync(savedConfigPath, 'utf8'))
        : {};
    const modelConfig = {
        ...config.llm.orchestration,
        ...(savedConfig.llm?.orchestration || {}),
    };
    const providerConfig = {
        ...(config.providers?.[modelConfig.provider] || {}),
        ...(savedConfig.providers?.[modelConfig.provider] || {}),
    };
    const provider = createLLMProvider({
        ...modelConfig,
        apiKey: providerConfig.apiKey
            || modelConfig.apiKey
            || process.env.ANTHROPIC_API_KEY
            || process.env.OPENAI_API_KEY
            || '',
        baseUrl: providerConfig.baseUrl || modelConfig.baseUrl,
    });

    const questionTool = createRequestPlanInputTool();
    const documentTool = createPublishPlanDocumentTool();
    const registry = new ToolRegistry();
    registry.register(questionTool);
    registry.register(documentTool);
    const definitions = registry.toLLMToolDefinitions('plan');
    const questionDefinition = definitions.find(item => item.name === questionTool.name)!;
    const documentDefinition = definitions.find(item => item.name === documentTool.name)!;

    const questionResponse = await provider.chatWithTools([
        {
            role: 'system',
            content: 'You are a plan-mode compatibility test. You MUST call request_plan_input exactly once. Use questions_json exactly as documented and return no ordinary answer.',
        },
        {
            role: 'user',
            content: '为高速 ETC 货车逃费稽核系统提出恰好 4 个会实质改变架构的决策问题。每题 2 个选项，包含推荐项和自由输入能力。',
        },
    ], [questionDefinition]);
    const questionCall = questionResponse.toolCalls.find(item => item.name === questionTool.name);
    assert.ok(questionCall, 'The active model did not call request_plan_input.');
    assert.equal(typeof questionCall.arguments.questions_json, 'string', 'The active model did not use the flat questions_json envelope.');

    const store = new PlanStore({
        plansDirectory: join(scratch, 'plans'),
        workStateDirectory: join(scratch, 'sessions'),
    });
    const questionSessionId = `smoke-question-${randomUUID()}`;
    const questionPlan = store.createPlan(questionSessionId);
    const questionContext: ToolExecutionContext = {
        workMode: 'plan',
        planId: questionPlan.id,
        planControl: {
            async requestInput(questions) {
                const request = store.requestInput(questionSessionId, questionPlan.id, questions);
                return { planId: questionPlan.id, requestId: request.id };
            },
            async publishDocument() {
                throw new Error('Unexpected publish call in question smoke test.');
            },
        },
    };
    const questionResult = await questionTool.execute(questionCall.arguments, questionContext);
    assert.equal(questionResult.controlSignal, 'waiting_input');
    const savedQuestions = store.getSnapshot(questionSessionId).pendingInput?.questions || [];
    assert.equal(savedQuestions.length, 4);

    const documentResponse = await provider.chatWithTools([
        {
            role: 'system',
            content: 'You are a plan-mode compatibility test. You MUST call publish_plan_document exactly once. Use document_json exactly as documented and return no ordinary answer.',
        },
        {
            role: 'user',
            content: '生成一份精简但字段完整的高速 ETC 货车逃费稽核系统实施计划。包含至少 3 个步骤，并为每个步骤提供验证方法。',
        },
    ], [documentDefinition]);
    const documentCall = documentResponse.toolCalls.find(item => item.name === documentTool.name);
    assert.ok(documentCall, 'The active model did not call publish_plan_document.');
    assert.equal(typeof documentCall.arguments.document_json, 'string', 'The active model did not use the flat document_json envelope.');

    const documentSessionId = `smoke-document-${randomUUID()}`;
    const documentPlan = store.createPlan(documentSessionId);
    const documentContext: ToolExecutionContext = {
        workMode: 'plan',
        planId: documentPlan.id,
        planControl: {
            async requestInput() {
                throw new Error('Unexpected input call in document smoke test.');
            },
            async publishDocument(document, note) {
                const revision = store.publishDocument(documentSessionId, documentPlan.id, document, note);
                return { planId: documentPlan.id, revision: revision.revision };
            },
        },
    };
    const documentResult = await documentTool.execute(documentCall.arguments, documentContext);
    assert.equal(documentResult.controlSignal, 'awaiting_plan_approval');
    const published = store.getSnapshot(documentSessionId).plan;
    assert.equal(published?.revision, 1);
    assert.ok((published?.revisions[0]?.document.steps.length || 0) >= 3);

    console.log(JSON.stringify({
        provider: modelConfig.provider,
        model: modelConfig.model,
        questionEnvelope: 'questions_json',
        questionCount: savedQuestions.length,
        questionIds: savedQuestions.map(question => question.id),
        optionCounts: savedQuestions.map(question => question.options.length),
        questionControlSignal: questionResult.controlSignal,
        documentEnvelope: 'document_json',
        documentRevision: published?.revision,
        documentSteps: published?.revisions[0]?.document.steps.length,
        documentControlSignal: documentResult.controlSignal,
    }, null, 2));
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
