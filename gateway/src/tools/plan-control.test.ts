import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublishPlanDocumentTool, createRequestPlanInputTool } from './plan-control';
import type { ToolExecutionContext } from './types';
import { ToolRegistry } from './registry';
import type { PlanDocument, PlanQuestion } from '../work/types';

const questions: PlanQuestion[] = [{
    id: 'rollout',
    prompt: 'Choose rollout scope',
    kind: 'single',
    required: true,
    allowOther: true,
    options: [
        { id: 'pilot', label: 'Pilot', description: 'Start in one region', recommended: true },
        { id: 'full', label: 'Full', description: 'Start across all regions' },
    ],
}];

const document: PlanDocument = {
    title: 'ETC audit plan',
    goal: 'Build a feasible audit system',
    confirmedDecisions: ['Pilot first'],
    assumptions: ['Read-only research is sufficient'],
    inScope: ['Detection rules'],
    outOfScope: ['Cloud rollout'],
    steps: [{ id: 'data', title: 'Data model', description: 'Define evidence inputs' }],
    modules: ['gateway'],
    dependencies: ['ETC transaction data'],
    validation: ['Replay known cases'],
    risks: ['False positives'],
    rollback: ['Disable new rules'],
    acceptanceCriteria: ['Known cases are detected'],
};

function context(captured: { questions?: PlanQuestion[]; document?: PlanDocument }): ToolExecutionContext {
    return {
        workMode: 'plan',
        planControl: {
            async requestInput(value) {
                captured.questions = value;
                return { planId: 'plan-a', requestId: 'request-a' };
            },
            async publishDocument(value) {
                captured.document = value;
                return { planId: 'plan-a', revision: 1 };
            },
        },
    };
}

test('request_plan_input exposes a flat model schema and decodes questions_json', async () => {
    const tool = createRequestPlanInputTool();
    const properties = (tool.rawInputSchema?.properties || {}) as Record<string, unknown>;
    assert.deepEqual(Object.keys(properties), ['questions_json']);
    assert.deepEqual(tool.rawInputSchema?.required, ['questions_json']);

    const captured: { questions?: PlanQuestion[] } = {};
    const result = await tool.execute({ questions_json: JSON.stringify(questions) }, context(captured));
    assert.equal(result.success, true);
    assert.equal(result.controlSignal, 'waiting_input');
    assert.deepEqual(captured.questions, questions);
});

test('request_plan_input keeps legacy structured calls compatible and rejects the observed empty envelope', async () => {
    const tool = createRequestPlanInputTool();
    const captured: { questions?: PlanQuestion[] } = {};
    await tool.execute({ questions }, context(captured));
    assert.deepEqual(captured.questions, questions);
    await assert.rejects(() => tool.execute({ questions: [{}, {}, {}, {}] }, context({})), /stable id and prompt/);
    await assert.rejects(() => tool.execute({ questions_json: '' }, context({})), /non-empty JSON string/);
    await assert.rejects(() => tool.execute({ questions_json: '[{},' }, context({})), /valid JSON/);
});

test('publish_plan_document decodes a flat document_json envelope and emits its control signal', async () => {
    const tool = createPublishPlanDocumentTool();
    const properties = (tool.rawInputSchema?.properties || {}) as Record<string, unknown>;
    assert.deepEqual(Object.keys(properties), ['document_json', 'note']);
    assert.deepEqual(tool.rawInputSchema?.required, ['document_json']);

    const captured: { document?: PlanDocument } = {};
    const result = await tool.execute({ document_json: JSON.stringify(document), note: 'first draft' }, context(captured));
    assert.equal(result.success, true);
    assert.equal(result.controlSignal, 'awaiting_plan_approval');
    assert.deepEqual(captured.document, document);
});

test('plan control transitions never open the generic tool approval flow', async () => {
    const registry = new ToolRegistry();
    registry.register(createPublishPlanDocumentTool());
    let approvalRequests = 0;
    const captured: { document?: PlanDocument } = {};
    const result = await registry.executeTool(
        'publish_plan_document',
        { document_json: JSON.stringify(document) },
        {
            ...context(captured),
            approvalMode: 'ask',
            async requestApproval() {
                approvalRequests++;
                return 'approved';
            },
        },
    );
    assert.equal(result.success, true);
    assert.equal(result.controlSignal, 'awaiting_plan_approval');
    assert.equal(approvalRequests, 0);
});
