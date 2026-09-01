import { randomUUID } from 'node:crypto';
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
    PlanApprovalResult,
    PlanDocument,
    PlanInputRequest,
    PlanInputResponse,
    PlanQuestion,
    PlanQuestionAnswer,
    PlanRecord,
    PlanRevision,
    SessionWorkState,
    WorkMode,
    WorkStateSnapshot,
} from './types';

export interface PlanStoreOptions {
    plansDirectory?: string;
    workStateDirectory?: string;
    now?: () => number;
}

const ACTIVE_PLAN_STATUSES = new Set([
    'researching',
    'waiting_input',
    'generating_document',
    'awaiting_approval',
    'revision_requested',
    'approved',
    'executing',
]);

function safeId(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function ensureDirectory(path: string): void {
    if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function atomicWrite(path: string, content: string): void {
    ensureDirectory(dirname(path));
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const backupPath = `${path}.bak`;
    writeFileSync(temporaryPath, content, 'utf8');
    if (existsSync(path)) {
        const previous = readFileSync(path);
        const backupTemporaryPath = `${backupPath}.${process.pid}.${randomUUID()}.tmp`;
        writeFileSync(backupTemporaryPath, previous);
        try {
            renameSync(backupTemporaryPath, backupPath);
        } catch {
            if (existsSync(backupPath)) unlinkSync(backupPath);
            renameSync(backupTemporaryPath, backupPath);
        }
    }
    try {
        renameSync(temporaryPath, path);
    } catch {
        // Windows does not consistently replace an existing destination.
        if (existsSync(path)) unlinkSync(path);
        renameSync(temporaryPath, path);
    }
}

function readJsonWithBackup<T>(path: string): T | undefined {
    for (const candidate of [path, `${path}.bak`]) {
        if (!existsSync(candidate)) continue;
        try {
            return JSON.parse(readFileSync(candidate, 'utf8')) as T;
        } catch {
            // An interrupted write must not hide the last valid snapshot.
        }
    }
    return undefined;
}

function uniqueNonEmpty(values: string[] | undefined): string[] {
    return [...new Set((values || []).map(value => String(value).trim()).filter(Boolean))];
}

function requiredText(value: unknown, field: string): string {
    const text = String(value || '').trim();
    if (!text) throw new Error(`Plan document field ${field} is required.`);
    return text;
}

function textArray(value: unknown, field: string): string[] {
    if (!Array.isArray(value)) throw new Error(`Plan document field ${field} must be an array.`);
    return uniqueNonEmpty(value.map(item => String(item)));
}

export function validatePlanDocument(input: PlanDocument): PlanDocument {
    if (!input || typeof input !== 'object') throw new Error('A complete plan document is required.');
    if (!Array.isArray(input.steps) || input.steps.length === 0) throw new Error('Plan document needs at least one implementation step.');
    const stepIds = new Set<string>();
    const steps = input.steps.map((step, index) => {
        const id = requiredText(step?.id, `steps[${index}].id`);
        if (stepIds.has(id)) throw new Error(`Duplicate plan step id: ${id}`);
        stepIds.add(id);
        return {
            id,
            title: requiredText(step?.title, `steps[${index}].title`),
            description: requiredText(step?.description, `steps[${index}].description`),
            modules: textArray(step?.modules || [], `steps[${index}].modules`),
            dependencies: textArray(step?.dependencies || [], `steps[${index}].dependencies`),
            validation: textArray(step?.validation || [], `steps[${index}].validation`),
            status: step?.status || 'pending',
        };
    });
    return {
        title: requiredText(input.title, 'title'),
        goal: requiredText(input.goal, 'goal'),
        confirmedDecisions: textArray(input.confirmedDecisions, 'confirmedDecisions'),
        assumptions: textArray(input.assumptions, 'assumptions'),
        inScope: textArray(input.inScope, 'inScope'),
        outOfScope: textArray(input.outOfScope, 'outOfScope'),
        steps,
        modules: textArray(input.modules, 'modules'),
        dependencies: textArray(input.dependencies, 'dependencies'),
        validation: textArray(input.validation, 'validation'),
        risks: textArray(input.risks, 'risks'),
        rollback: textArray(input.rollback, 'rollback'),
        acceptanceCriteria: textArray(input.acceptanceCriteria, 'acceptanceCriteria'),
    };
}

export function validatePlanQuestions(questions: PlanQuestion[]): PlanQuestion[] {
    if (!Array.isArray(questions) || questions.length === 0) {
        throw new Error('At least one plan question is required.');
    }
    const questionIds = new Set<string>();
    return questions.map(question => {
        const id = String(question.id || '').trim();
        const prompt = String(question.prompt || '').trim();
        if (!id || !prompt) throw new Error('Every plan question needs a stable id and prompt.');
        if (questionIds.has(id)) throw new Error(`Duplicate plan question id: ${id}`);
        questionIds.add(id);
        if (question.kind !== 'single' && question.kind !== 'multiple') {
            throw new Error(`Unsupported plan question kind: ${question.kind}`);
        }
        if (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > 3) {
            throw new Error(`Plan question ${id} must contain 2-3 options.`);
        }
        const optionIds = new Set<string>();
        const options = question.options.map(option => {
            const optionId = String(option.id || '').trim();
            const label = String(option.label || '').trim();
            const description = String(option.description || '').trim();
            if (!optionId || !label || !description) {
                throw new Error(`Every option in ${id} needs an id, label, and description.`);
            }
            if (optionIds.has(optionId)) throw new Error(`Duplicate option id in ${id}: ${optionId}`);
            optionIds.add(optionId);
            return { ...option, id: optionId, label, description };
        });
        return {
            ...question,
            id,
            prompt,
            required: question.required !== false,
            allowOther: question.allowOther !== false,
            options,
        };
    });
}

export function validatePlanAnswers(request: PlanInputRequest, answers: PlanQuestionAnswer[]): PlanQuestionAnswer[] {
    if (!Array.isArray(answers)) throw new Error('Plan answers must be an array.');
    const byQuestion = new Map(answers.map(answer => [answer.questionId, answer]));
    const unknown = answers.find(answer => !request.questions.some(question => question.id === answer.questionId));
    if (unknown) throw new Error(`Unknown plan question id: ${unknown.questionId}`);

    return request.questions.map(question => {
        const answer = byQuestion.get(question.id);
        const other = answer?.other?.trim();
        const optionIds = uniqueNonEmpty(answer?.optionIds);
        const knownOptions = new Set(question.options.map(option => option.id));
        if (optionIds.some(id => !knownOptions.has(id))) {
            throw new Error(`Invalid option id for question ${question.id}.`);
        }
        if (question.kind === 'single' && optionIds.length > 1) {
            throw new Error(`Question ${question.id} accepts only one option.`);
        }
        if (other && !question.allowOther) throw new Error(`Question ${question.id} does not allow a custom answer.`);
        if (question.required !== false && optionIds.length === 0 && !other) {
            throw new Error(`Question ${question.id} is required.`);
        }
        return { questionId: question.id, optionIds, ...(other ? { other } : {}) };
    });
}

export function renderPlanMarkdown(document: PlanDocument): string {
    const list = (values: string[], empty = '无') => values.length
        ? values.map(value => `- ${value}`).join('\n')
        : `- ${empty}`;
    const steps = document.steps.length
        ? document.steps.map((step, index) => {
            const details = [
                `${index + 1}. **${step.title}** — ${step.description}`,
                step.modules?.length ? `   - 涉及模块：${step.modules.join('、')}` : '',
                step.dependencies?.length ? `   - 依赖：${step.dependencies.join('、')}` : '',
                step.validation?.length ? `   - 验证：${step.validation.join('；')}` : '',
            ].filter(Boolean);
            return details.join('\n');
        }).join('\n')
        : '1. 暂无步骤';
    return `# ${document.title}\n\n## 目标\n\n${document.goal}\n\n## 已确认决策\n\n${list(document.confirmedDecisions)}\n\n## 假设\n\n${list(document.assumptions)}\n\n## 包含范围\n\n${list(document.inScope)}\n\n## 排除范围\n\n${list(document.outOfScope)}\n\n## 实施步骤\n\n${steps}\n\n## 涉及模块\n\n${list(document.modules)}\n\n## 依赖\n\n${list(document.dependencies)}\n\n## 验证方法\n\n${list(document.validation)}\n\n## 风险\n\n${list(document.risks)}\n\n## 回退方案\n\n${list(document.rollback)}\n\n## 最终验收条件\n\n${list(document.acceptanceCriteria)}\n`;
}

export class PlanStore {
    private plansDirectory: string;
    private workStateDirectory: string;
    private now: () => number;

    constructor(options: PlanStoreOptions = {}) {
        this.plansDirectory = options.plansDirectory || join(homedir(), '.openflux', 'plans');
        this.workStateDirectory = options.workStateDirectory || join(homedir(), '.openflux', 'sessions');
        this.now = options.now || Date.now;
    }

    private planPath(planId: string): string {
        return join(this.plansDirectory, `${safeId(planId)}.json`);
    }

    private markdownPath(planId: string): string {
        return join(this.plansDirectory, `${safeId(planId)}.md`);
    }

    private workPath(sessionId: string): string {
        return join(this.workStateDirectory, `${safeId(sessionId)}.work.json`);
    }

    getPlan(planId: string): PlanRecord | undefined {
        return readJsonWithBackup<PlanRecord>(this.planPath(planId));
    }

    getSessionWorkState(sessionId: string): SessionWorkState {
        return readJsonWithBackup<SessionWorkState>(this.workPath(sessionId)) || {
            version: 1,
            sessionId,
            mode: 'normal',
            updatedAt: this.now(),
        };
    }

    getSnapshot(sessionId: string): WorkStateSnapshot {
        const work = this.getSessionWorkState(sessionId);
        const plan = work.planId ? this.getPlan(work.planId) : undefined;
        const pendingInput = plan?.inputRequests.find(request => request.id === work.pendingRequestId && request.status === 'pending');
        const planFilePath = plan && existsSync(this.markdownPath(plan.id))
            ? this.markdownPath(plan.id)
            : undefined;
        return {
            sessionId,
            mode: work.mode,
            ...(plan ? { plan } : {}),
            ...(pendingInput ? { pendingInput } : {}),
            ...(planFilePath ? { planFilePath } : {}),
        };
    }

    setMode(sessionId: string, mode: WorkMode): WorkStateSnapshot {
        const current = this.getSessionWorkState(sessionId);
        const plan = current.planId ? this.getPlan(current.planId) : undefined;
        if (mode === 'normal' && plan && ACTIVE_PLAN_STATUSES.has(plan.status)) {
            throw new Error('Save or cancel the active plan before returning to normal mode.');
        }
        const next = { ...current, mode, updatedAt: this.now() };
        atomicWrite(this.workPath(sessionId), JSON.stringify(next, null, 2));
        return this.getSnapshot(sessionId);
    }

    createPlan(sessionId: string, planId: string = randomUUID()): PlanRecord {
        const snapshot = this.getSnapshot(sessionId);
        if (snapshot.plan && ACTIVE_PLAN_STATUSES.has(snapshot.plan.status)) {
            throw new Error('Save or cancel the current plan before starting a new plan.');
        }
        const now = this.now();
        const plan: PlanRecord = {
            id: planId,
            sessionId,
            status: 'researching',
            createdAt: now,
            updatedAt: now,
            revision: 0,
            inputRequests: [],
            revisions: [],
            processedSubmissions: {},
        };
        this.writePlan(plan);
        this.writeWork({ version: 1, sessionId, mode: 'plan', planId, updatedAt: now });
        return plan;
    }

    ensurePlan(sessionId: string, planId?: string): PlanRecord {
        if (planId) {
            const existing = this.getPlan(planId);
            if (!existing || existing.sessionId !== sessionId) throw new Error('Plan does not belong to this session.');
            return existing;
        }
        const current = this.getSnapshot(sessionId).plan;
        return current && ACTIVE_PLAN_STATUSES.has(current.status) ? current : this.createPlan(sessionId);
    }

    requestInput(sessionId: string, planId: string, questions: PlanQuestion[], requestId: string = randomUUID()): PlanInputRequest {
        const plan = this.requirePlan(sessionId, planId);
        if (plan.status !== 'researching' && plan.status !== 'revision_requested') {
            throw new Error('Plan input can only be requested while researching or revising.');
        }
        if (plan.inputRequests.some(request => request.status === 'pending')) {
            throw new Error('This plan already has a pending input request.');
        }
        const request: PlanInputRequest = {
            id: requestId,
            planId,
            createdAt: this.now(),
            status: 'pending',
            questions: validatePlanQuestions(questions),
        };
        plan.inputRequests.push(request);
        plan.status = 'waiting_input';
        plan.updatedAt = this.now();
        this.writePlan(plan);
        this.writeWork({ version: 1, sessionId, mode: 'plan', planId, pendingRequestId: requestId, updatedAt: this.now() });
        return request;
    }

    resolveInput(sessionId: string, planId: string, requestId: string, submissionId: string, answers: PlanQuestionAnswer[]): { duplicate: boolean; response: PlanInputResponse } {
        const plan = this.requirePlan(sessionId, planId);
        const request = plan.inputRequests.find(item => item.id === requestId);
        if (!request) throw new Error('Plan input request was not found.');
        const processed = plan.processedSubmissions[submissionId];
        if (processed) {
            if (processed.action !== `input:${requestId}` || !request.response) throw new Error('Submission id was already used for another plan action.');
            return { duplicate: true, response: request.response };
        }
        if (request.status !== 'pending') throw new Error('Plan input request is no longer pending.');
        const response: PlanInputResponse = {
            requestId,
            submissionId,
            submittedAt: this.now(),
            answers: validatePlanAnswers(request, answers),
        };
        request.status = 'resolved';
        request.response = response;
        plan.status = 'researching';
        plan.updatedAt = this.now();
        plan.processedSubmissions[submissionId] = { action: `input:${requestId}`, at: this.now() };
        this.writePlan(plan);
        this.writeWork({ version: 1, sessionId, mode: 'plan', planId, updatedAt: this.now() });
        return { duplicate: false, response };
    }

    publishDocument(sessionId: string, planId: string, document: PlanDocument, note?: string): PlanRevision {
        const plan = this.requirePlan(sessionId, planId);
        if (plan.status !== 'researching' && plan.status !== 'generating_document' && plan.status !== 'revision_requested') {
            throw new Error('A plan document can only be published while researching, generating, or revising.');
        }
        if (plan.inputRequests.some(request => request.status === 'pending')) throw new Error('Resolve pending plan questions before publishing a document.');
        const validatedDocument = validatePlanDocument(document);
        const revision: PlanRevision = {
            revision: plan.revision + 1,
            createdAt: this.now(),
            document: validatedDocument,
            markdown: renderPlanMarkdown(validatedDocument),
            ...(note?.trim() ? { note: note.trim() } : {}),
        };
        plan.revision = revision.revision;
        plan.revisions.push(revision);
        plan.status = 'awaiting_approval';
        plan.updatedAt = this.now();
        delete plan.revisionRequest;
        this.writePlan(plan);
        atomicWrite(this.markdownPath(planId), revision.markdown);
        this.writeWork({ version: 1, sessionId, mode: 'plan', planId, updatedAt: this.now() });
        return revision;
    }

    requestRevision(sessionId: string, planId: string, instruction: string, submissionId: string): { duplicate: boolean } {
        const plan = this.requirePlan(sessionId, planId);
        const processed = plan.processedSubmissions[submissionId];
        if (processed) {
            if (processed.action !== 'revise') throw new Error('Submission id was already used for another plan action.');
            return { duplicate: true };
        }
        if (plan.status !== 'awaiting_approval') throw new Error('Only a plan awaiting approval can be revised.');
        if (!instruction.trim()) throw new Error('A revision instruction is required.');
        plan.status = 'revision_requested';
        plan.revisionRequest = { instruction: instruction.trim(), submissionId, requestedAt: this.now() };
        plan.processedSubmissions[submissionId] = { action: 'revise', at: this.now() };
        plan.updatedAt = this.now();
        this.writePlan(plan);
        return { duplicate: false };
    }

    approve(sessionId: string, planId: string, revision: number, submissionId: string): PlanApprovalResult {
        const plan = this.requirePlan(sessionId, planId);
        const processed = plan.processedSubmissions[submissionId];
        if (processed) {
            if (processed.action !== `approve:${revision}` || !plan.execution) throw new Error('Submission id was already used for another plan action.');
            return { duplicate: true, snapshot: plan.execution };
        }
        if (plan.inputRequests.some(request => request.status === 'pending')) throw new Error('Pending questions must be resolved before approval.');
        if (plan.status !== 'awaiting_approval') throw new Error('Plan is not awaiting approval.');
        if (revision !== plan.revision) throw new Error('Only the latest plan revision can be approved.');
        const selected = plan.revisions.find(item => item.revision === revision);
        if (!selected) throw new Error('Plan revision was not found.');
        const snapshot = {
            planId,
            revision,
            approvedAt: this.now(),
            submissionId,
            document: structuredClone(selected.document),
            markdown: selected.markdown,
        };
        plan.execution = snapshot;
        plan.status = 'approved';
        plan.updatedAt = this.now();
        plan.processedSubmissions[submissionId] = { action: `approve:${revision}`, at: this.now() };
        this.writePlan(plan);
        this.writeWork({ version: 1, sessionId, mode: 'normal', planId, updatedAt: this.now() });
        return { duplicate: false, snapshot };
    }

    markExecuting(sessionId: string, planId: string): void {
        const plan = this.requirePlan(sessionId, planId);
        if (plan.status !== 'approved' || !plan.execution) throw new Error('Only an approved plan can start executing.');
        const steps = plan.execution?.document.steps || [];
        plan.stepProgress = Object.fromEntries(steps.map((step, index) => [step.id, index === 0 ? 'in_progress' : 'pending']));
        plan.status = 'executing';
        plan.updatedAt = this.now();
        this.writePlan(plan);
    }

    markCompleted(sessionId: string, planId: string): void {
        const plan = this.requirePlan(sessionId, planId);
        if (plan.status !== 'executing' || !plan.execution) throw new Error('Only an executing plan can be completed.');
        const steps = plan.execution?.document.steps || [];
        plan.stepProgress = Object.fromEntries(steps.map(step => [step.id, 'completed']));
        plan.status = 'completed';
        plan.updatedAt = this.now();
        this.writePlan(plan);
    }

    /**
     * Return an approved or executing plan to the final confirmation surface.
     * The immutable execution snapshot is intentionally preserved for audit,
     * while step progress is reset so a retry never looks partially complete.
     */
    recoverExecution(sessionId: string, planId: string): boolean {
        const plan = this.requirePlan(sessionId, planId);
        if (plan.status !== 'approved' && plan.status !== 'executing') return false;
        const steps = plan.execution?.document.steps || [];
        plan.stepProgress = Object.fromEntries(steps.map(step => [step.id, 'pending']));
        plan.status = 'awaiting_approval';
        plan.updatedAt = this.now();
        this.writePlan(plan);
        this.writeWork({ version: 1, sessionId, mode: 'plan', planId, updatedAt: this.now() });
        return true;
    }

    /**
     * Gateway restarts never resume a plan execution automatically. Any plan
     * persisted as approved/executing therefore belongs to an interrupted run
     * and must be returned to the user's final confirmation step.
     */
    recoverInterruptedExecutions(): Array<{ sessionId: string; planId: string }> {
        if (!existsSync(this.workStateDirectory)) return [];
        const recovered: Array<{ sessionId: string; planId: string }> = [];
        for (const name of readdirSync(this.workStateDirectory)) {
            if (!name.endsWith('.work.json')) continue;
            const work = readJsonWithBackup<SessionWorkState>(join(this.workStateDirectory, name));
            if (!work?.sessionId || !work.planId) continue;
            const plan = this.getPlan(work.planId);
            if (!plan || plan.sessionId !== work.sessionId) continue;
            if (this.recoverExecution(work.sessionId, work.planId)) {
                recovered.push({ sessionId: work.sessionId, planId: work.planId });
            }
        }
        return recovered;
    }

    save(sessionId: string, planId: string): void {
        const plan = this.requirePlan(sessionId, planId);
        if (plan.status !== 'awaiting_approval') throw new Error('Only a plan awaiting approval can be saved.');
        this.updateStatus(sessionId, planId, 'saved');
        this.writeWork({ version: 1, sessionId, mode: 'normal', planId, updatedAt: this.now() });
    }

    cancel(sessionId: string, planId: string): void {
        const plan = this.requirePlan(sessionId, planId);
        if (!ACTIVE_PLAN_STATUSES.has(plan.status) || plan.status === 'executing') {
            throw new Error('This plan can no longer be cancelled.');
        }
        this.updateStatus(sessionId, planId, 'cancelled');
        this.writeWork({ version: 1, sessionId, mode: 'normal', planId, updatedAt: this.now() });
    }

    private requirePlan(sessionId: string, planId: string): PlanRecord {
        const plan = this.getPlan(planId);
        if (!plan) throw new Error('Plan was not found.');
        if (plan.sessionId !== sessionId) throw new Error('Plan does not belong to this session.');
        return plan;
    }

    private updateStatus(sessionId: string, planId: string, status: PlanRecord['status']): void {
        const plan = this.requirePlan(sessionId, planId);
        plan.status = status;
        plan.updatedAt = this.now();
        this.writePlan(plan);
    }

    private writePlan(plan: PlanRecord): void {
        atomicWrite(this.planPath(plan.id), JSON.stringify(plan, null, 2));
    }

    private writeWork(state: SessionWorkState): void {
        atomicWrite(this.workPath(state.sessionId), JSON.stringify(state, null, 2));
    }
}
