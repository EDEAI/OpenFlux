import type { PlanAnswerDraft, PlanQuestion, PlanQuestionAnswer } from './plan-state';

/** An Agent can request clarification in any work mode, independently of plans. */
export interface UserInputRequest {
    id: string;
    sessionId: string;
    turnId: string;
    runId?: string;
    createdAt: number;
    updatedAt: number;
    status: 'pending' | 'resolved' | 'cancelled';
    questions: PlanQuestion[];
    response?: { submissionId: string; submittedAt: number; answers: PlanQuestionAnswer[] };
}

export function userInputAnswers(request: UserInputRequest, draft: PlanAnswerDraft): PlanQuestionAnswer[] {
    return request.questions.map(question => {
        const allowed = new Set(question.options.map(option => option.id));
        const selected = [...new Set(draft[question.id]?.optionIds || [])].filter(id => allowed.has(id));
        const other = question.allowOther !== false ? draft[question.id]?.other?.trim() : undefined;
        return {
            questionId: question.id,
            optionIds: question.kind === 'single' ? (other ? [] : selected.slice(0, 1)) : selected,
            ...(other ? { other } : {}),
        };
    });
}

export function isUserInputComplete(request: UserInputRequest, draft: PlanAnswerDraft): boolean {
    const answers = userInputAnswers(request, draft);
    return request.questions.length > 0 && request.questions.every((question, index) =>
        question.required === false || answers[index].optionIds.length > 0 || Boolean(answers[index].other));
}

export interface UserInputDraft {
    answers: PlanAnswerDraft;
    questionIndex?: number;
    busy: boolean;
    error?: string;
    submission?: { fingerprint: string; id: string };
}

/** Drafts survive DOM replacement and session changes; unchanged retries reuse their ID. */
export class UserInputDrafts {
    private entries = new Map<string, UserInputDraft>();
    constructor(private readonly randomId: () => string = () => crypto.randomUUID()) {}

    get(request: Pick<UserInputRequest, 'sessionId' | 'id'>): UserInputDraft {
        const key = JSON.stringify([request.sessionId, request.id]);
        let entry = this.entries.get(key);
        if (!entry) {
            entry = { answers: {}, busy: false };
            this.entries.set(key, entry);
        }
        return entry;
    }

    submission(request: UserInputRequest): { submissionId: string; answers: PlanQuestionAnswer[] } {
        const entry = this.get(request);
        const answers = userInputAnswers(request, entry.answers);
        // Option order is not meaningful, including after a failed request.
        const fingerprint = JSON.stringify(answers.map(answer => ({ ...answer, optionIds: [...answer.optionIds].sort() })));
        if (entry.submission?.fingerprint !== fingerprint) entry.submission = { fingerprint, id: this.randomId() };
        return { submissionId: entry.submission.id, answers };
    }

    clear(request: Pick<UserInputRequest, 'sessionId' | 'id'>): void {
        this.entries.delete(JSON.stringify([request.sessionId, request.id]));
    }
}

/** A response started before a pushed state must not erase a newer question. */
export function canApplyUserInputAck(startRevision: number, currentRevision: number, requestId: string, current?: UserInputRequest): boolean {
    return startRevision === currentRevision && current?.id === requestId && current.status === 'pending';
}
