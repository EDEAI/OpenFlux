import type { ApprovalMode } from '../permissions/checker';
import type { PlanQuestion, PlanQuestionAnswer } from './types';

export interface UserInputRequest {
    id: string;
    sessionId: string;
    turnId: string;
    runId: string;
    createdAt: number;
    updatedAt: number;
    status: 'pending' | 'resolved' | 'cancelled';
    questions: PlanQuestion[];
    response?: {
        submissionId: string;
        submittedAt: number;
        answers: PlanQuestionAnswer[];
    };
    continuationSubmissionId: string;
    continuationQueued?: boolean;
    context: { input: string; agentId?: string; approvalMode?: ApprovalMode };
}

/** Only the gateway supplies this bridge; model arguments cannot select a session or run. */
export interface UserInputControl {
    requestInput(questions: PlanQuestion[], context?: { agentId?: string }): Promise<{ requestId: string }>;
}
