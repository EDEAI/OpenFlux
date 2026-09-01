import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PlanStore } from './store';
import type { PlanDocument, PlanQuestion } from './types';

const questions: PlanQuestion[] = [{
    id: 'storage',
    prompt: 'Choose storage',
    kind: 'single',
    required: true,
    allowOther: true,
    options: [
        { id: 'json', label: 'JSON', description: 'Use JSON files', recommended: true },
        { id: 'sqlite', label: 'SQLite', description: 'Use a local database' },
    ],
}];

const document: PlanDocument = {
    title: 'Implementation plan',
    goal: 'Ship plan mode',
    confirmedDecisions: ['Local Agent only'],
    assumptions: ['Existing approval policy remains active'],
    inScope: ['Interactive planning'],
    outOfScope: ['Cloud sessions'],
    steps: [{ id: 'state', title: 'State', description: 'Add durable state', validation: ['Unit tests'] }],
    modules: ['gateway'],
    dependencies: [],
    validation: ['Run tests'],
    risks: ['Stale revisions'],
    rollback: ['Disable mode entry'],
    acceptanceCriteria: ['Approved revision executes once'],
};

function fixture(): { root: string; store: PlanStore } {
    const root = mkdtempSync(join(tmpdir(), 'openflux-plan-store-'));
    return {
        root,
        store: new PlanStore({ plansDirectory: join(root, 'plans'), workStateDirectory: join(root, 'sessions') }),
    };
}

test('plan lifecycle increments revisions and approves only the latest document', () => {
    const { root, store } = fixture();
    try {
        const plan = store.createPlan('session-a', 'plan-a');
        const request = store.requestInput('session-a', plan.id, questions, 'request-a');
        const resolved = store.resolveInput('session-a', plan.id, request.id, 'answer-a', [
            { questionId: 'storage', optionIds: ['json'] },
        ]);
        assert.equal(resolved.duplicate, false);
        assert.equal(store.resolveInput('session-a', plan.id, request.id, 'answer-a', []).duplicate, true);

        assert.equal(store.publishDocument('session-a', plan.id, document).revision, 1);
        const firstSnapshot = store.getSnapshot('session-a');
        assert.equal(firstSnapshot.planFilePath, join(root, 'plans', 'plan-a.md'));
        assert.equal(existsSync(firstSnapshot.planFilePath!), true);
        assert.throws(() => store.approve('session-a', plan.id, 0, 'approval-old'), /latest/);
        store.requestRevision('session-a', plan.id, 'Strengthen the execution details', 'revision-a');
        const second = store.publishDocument('session-a', plan.id, { ...document, goal: 'Ship the revised plan mode' }, 'review');
        assert.equal(second.revision, 2);

        const approval = store.approve('session-a', plan.id, 2, 'approval-a');
        assert.equal(approval.duplicate, false);
        assert.equal(approval.snapshot.document.goal, 'Ship the revised plan mode');
        assert.equal(store.approve('session-a', plan.id, 2, 'approval-a').duplicate, true);
        assert.equal(store.getSnapshot('session-a').mode, 'normal');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('active plans cannot bypass terminal actions or invalid state transitions', () => {
    const { root, store } = fixture();
    try {
        const plan = store.createPlan('session-e', 'plan-e');
        assert.throws(() => store.setMode('session-e', 'normal'), /Save or cancel/);
        store.publishDocument('session-e', plan.id, document);
        assert.throws(() => store.requestInput('session-e', plan.id, questions), /only be requested/);
        assert.throws(() => store.publishDocument('session-e', plan.id, document), /only be published/);
        assert.throws(() => store.markExecuting('session-e', plan.id), /approved/);
        store.cancel('session-e', plan.id);
        assert.equal(store.getSnapshot('session-e').mode, 'normal');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('input validation rejects missing required answers and unstable option ids', () => {
    const { root, store } = fixture();
    try {
        const plan = store.createPlan('session-b', 'plan-b');
        const request = store.requestInput('session-b', plan.id, questions, 'request-b');
        assert.throws(() => store.resolveInput('session-b', plan.id, request.id, 'missing', []), /required/);
        assert.throws(() => store.resolveInput('session-b', plan.id, request.id, 'unknown', [
            { questionId: 'storage', optionIds: ['unstable'] },
        ]), /Invalid option id/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('corrupt primary state falls back to the last valid atomic backup', () => {
    const { root, store } = fixture();
    try {
        const plan = store.createPlan('session-c', 'plan-c');
        const planPath = join(root, 'plans', 'plan-c.json');
        store.requestInput('session-c', plan.id, questions, 'request-c');
        const backup = JSON.parse(readFileSync(`${planPath}.bak`, 'utf8'));
        writeFileSync(planPath, '{"truncated":', 'utf8');
        assert.equal(store.getPlan(plan.id)?.revision, backup.revision);
        assert.equal(store.getPlan(plan.id)?.id, plan.id);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('publishing rejects incomplete documents and duplicate step ids', () => {
    const { root, store } = fixture();
    try {
        const plan = store.createPlan('session-d', 'plan-d');
        assert.throws(() => store.publishDocument('session-d', plan.id, { ...document, title: '' }), /title/);
        assert.throws(() => store.publishDocument('session-d', plan.id, {
            ...document,
            steps: [document.steps[0], { ...document.steps[0] }],
        }), /Duplicate plan step id/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('interrupted execution returns to final approval and can be retried', () => {
    const { root, store } = fixture();
    try {
        const plan = store.createPlan('session-retry', 'plan-retry');
        store.publishDocument('session-retry', plan.id, document);
        store.approve('session-retry', plan.id, 1, 'approval-first');
        store.markExecuting('session-retry', plan.id);

        assert.equal(store.recoverExecution('session-retry', plan.id), true);
        const recovered = store.getSnapshot('session-retry');
        assert.equal(recovered.mode, 'plan');
        assert.equal(recovered.plan?.status, 'awaiting_approval');
        assert.deepEqual(recovered.plan?.stepProgress, { state: 'pending' });
        assert.equal(recovered.plan?.execution?.submissionId, 'approval-first');
        assert.equal(store.recoverExecution('session-retry', plan.id), false);

        store.approve('session-retry', plan.id, 1, 'approval-retry');
        store.markExecuting('session-retry', plan.id);
        store.markCompleted('session-retry', plan.id);
        assert.equal(store.getPlan(plan.id)?.status, 'completed');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('startup recovery repairs approved and executing plans without auto-executing them', () => {
    const { root, store } = fixture();
    try {
        for (const suffix of ['approved', 'executing']) {
            const sessionId = `session-${suffix}`;
            const planId = `plan-${suffix}`;
            store.createPlan(sessionId, planId);
            store.publishDocument(sessionId, planId, document);
            store.approve(sessionId, planId, 1, `approval-${suffix}`);
            if (suffix === 'executing') store.markExecuting(sessionId, planId);
        }

        const recovered = store.recoverInterruptedExecutions();
        assert.deepEqual(
            recovered.sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
            [
                { sessionId: 'session-approved', planId: 'plan-approved' },
                { sessionId: 'session-executing', planId: 'plan-executing' },
            ],
        );
        assert.equal(store.getSnapshot('session-approved').plan?.status, 'awaiting_approval');
        assert.equal(store.getSnapshot('session-executing').plan?.status, 'awaiting_approval');
        assert.deepEqual(store.recoverInterruptedExecutions(), []);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
