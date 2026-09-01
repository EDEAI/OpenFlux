export type WorkMode = 'normal' | 'plan';

export type PlanStatus =
    | 'researching'
    | 'waiting_input'
    | 'generating_document'
    | 'awaiting_approval'
    | 'revision_requested'
    | 'approved'
    | 'executing'
    | 'completed'
    | 'saved'
    | 'cancelled';

export interface PlanQuestionOption {
    id: string;
    label: string;
    description: string;
    recommended?: boolean;
}

export interface PlanQuestion {
    id: string;
    prompt: string;
    kind: 'single' | 'multiple';
    required?: boolean;
    allowOther?: boolean;
    options: PlanQuestionOption[];
}

export interface PlanQuestionAnswer {
    questionId: string;
    optionIds: string[];
    other?: string;
}

export interface PlanInputRequest {
    id: string;
    planId: string;
    createdAt: number;
    status: 'pending' | 'resolved';
    questions: PlanQuestion[];
}

export interface PlanStep {
    id: string;
    title: string;
    description: string;
    modules?: string[];
    dependencies?: string[];
    validation?: string[];
    status?: 'pending' | 'in_progress' | 'completed' | 'failed';
}

export interface PlanDocument {
    title: string;
    goal: string;
    confirmedDecisions: string[];
    assumptions: string[];
    inScope: string[];
    outOfScope: string[];
    steps: PlanStep[];
    modules: string[];
    dependencies: string[];
    validation: string[];
    risks: string[];
    rollback: string[];
    acceptanceCriteria: string[];
}

export interface PlanRevision {
    revision: number;
    createdAt: number;
    document: PlanDocument;
    markdown: string;
    note?: string;
}

export interface PlanRecord {
    id: string;
    sessionId: string;
    status: PlanStatus;
    createdAt: number;
    updatedAt: number;
    revision: number;
    inputRequests: PlanInputRequest[];
    revisions: PlanRevision[];
    stepProgress?: Record<string, NonNullable<PlanStep['status']>>;
}

export interface WorkStateSnapshot {
    sessionId: string;
    mode: WorkMode;
    plan?: PlanRecord;
    pendingInput?: PlanInputRequest;
    planFilePath?: string;
}

export interface PlanPreviewDescriptor {
    id: string;
    planId: string;
    revision: number;
    createdAt: number;
    markdown: string;
    filePath: string;
}

export type PlanAnswerDraft = Record<string, { optionIds: string[]; other?: string }>;

/** Build the single canonical chat preview for the latest plan revision. */
export function latestPlanPreview(state: WorkStateSnapshot | undefined): PlanPreviewDescriptor | undefined {
    const plan = state?.plan;
    const revision = plan?.revisions.find(item => item.revision === plan.revision) || plan?.revisions.at(-1);
    const filePath = state?.planFilePath?.trim();
    if (!plan || !revision || !filePath) return undefined;
    return {
        id: `plan-preview-${plan.id}-${revision.revision}`,
        planId: plan.id,
        revision: revision.revision,
        createdAt: revision.createdAt,
        markdown: revision.markdown,
        filePath,
    };
}

export function hasPlanQuestionAnswer(question: PlanQuestion, draft: PlanAnswerDraft): boolean {
    const answer = draft[question.id];
    return Boolean(answer?.optionIds?.length || answer?.other?.trim());
}

export function firstIncompletePlanQuestionIndex(request: PlanInputRequest, draft: PlanAnswerDraft): number {
    const index = request.questions.findIndex(question => question.required !== false && !hasPlanQuestionAnswer(question, draft));
    return index >= 0 ? index : Math.max(0, request.questions.length - 1);
}

export function canAdvancePlanQuestion(question: PlanQuestion, draft: PlanAnswerDraft): boolean {
    return question.required === false || hasPlanQuestionAnswer(question, draft);
}

export function isPlanAnswerDraftComplete(request: PlanInputRequest, draft: PlanAnswerDraft): boolean {
    return request.questions.every(question => {
        if (question.required === false) return true;
        return hasPlanQuestionAnswer(question, draft);
    });
}

export function planAnswerDraftToResponse(request: PlanInputRequest, draft: PlanAnswerDraft): PlanQuestionAnswer[] {
    return request.questions.map(question => ({
        questionId: question.id,
        optionIds: [...new Set(draft[question.id]?.optionIds || [])],
        ...(draft[question.id]?.other?.trim() ? { other: draft[question.id].other!.trim() } : {}),
    }));
}
