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

export type PlanQuestionKind = 'single' | 'multiple';

export interface PlanQuestionOption {
    id: string;
    label: string;
    description: string;
    recommended?: boolean;
}

export interface PlanQuestion {
    id: string;
    prompt: string;
    kind: PlanQuestionKind;
    required?: boolean;
    allowOther?: boolean;
    options: PlanQuestionOption[];
}

export interface PlanInputRequest {
    id: string;
    planId: string;
    createdAt: number;
    status: 'pending' | 'resolved';
    questions: PlanQuestion[];
    response?: PlanInputResponse;
}

export interface PlanQuestionAnswer {
    questionId: string;
    optionIds: string[];
    other?: string;
}

export interface PlanInputResponse {
    requestId: string;
    submissionId: string;
    submittedAt: number;
    answers: PlanQuestionAnswer[];
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

export interface PlanExecutionSnapshot {
    planId: string;
    revision: number;
    approvedAt: number;
    submissionId: string;
    document: PlanDocument;
    markdown: string;
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
    revisionRequest?: { instruction: string; submissionId: string; requestedAt: number };
    execution?: PlanExecutionSnapshot;
    stepProgress?: Record<string, NonNullable<PlanStep['status']>>;
    processedSubmissions: Record<string, { action: string; at: number }>;
}

export interface SessionWorkState {
    version: 1;
    sessionId: string;
    mode: WorkMode;
    planId?: string;
    pendingRequestId?: string;
    updatedAt: number;
}

export interface WorkStateSnapshot {
    sessionId: string;
    mode: WorkMode;
    plan?: PlanRecord;
    pendingInput?: PlanInputRequest;
    /** Absolute path of the latest canonical Markdown plan file. */
    planFilePath?: string;
}

export interface PlanApprovalResult {
    duplicate: boolean;
    snapshot: PlanExecutionSnapshot;
}
