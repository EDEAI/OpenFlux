import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite, readJsonWithBackup } from './persistence';
import type { PlanQuestion, PlanQuestionAnswer } from './types';
import type { UserInputRequest } from './user-input-types';
export type { UserInputRequest } from './user-input-types';

function text(value: unknown, label: string, max = 4_000): string {
    if (typeof value !== 'string' || !value.trim() || value.length > max) {
        throw new Error(`${label} must be a non-empty string of at most ${max} characters.`);
    }
    return value.trim();
}

function object(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
    return value as Record<string, unknown>;
}

export function validateUserInputQuestions(value: unknown): PlanQuestion[] {
    if (!Array.isArray(value) || value.length < 1 || value.length > 3) throw new Error('Ask 1–3 questions in one request.');
    const ids = new Set<string>();
    return value.map(raw => {
        const question = object(raw, 'Question');
        const id = text(question.id, 'Question id', 100);
        if (ids.has(id)) throw new Error(`Duplicate question id: ${id}`);
        ids.add(id);
        const prompt = text(question.prompt, 'Question prompt');
        if (question.kind !== 'single' && question.kind !== 'multiple') throw new Error('Question kind must be single or multiple.');
        if (question.required !== undefined && typeof question.required !== 'boolean') throw new Error('Question required must be boolean.');
        if (question.allowOther !== undefined && typeof question.allowOther !== 'boolean') throw new Error('Question allowOther must be boolean.');
        if (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > 3) throw new Error('Each question requires 2–3 options.');
        const optionIds = new Set<string>();
        const options = question.options.map(rawOption => {
            const option = object(rawOption, 'Option');
            const optionId = text(option.id, 'Option id', 100);
            if (optionIds.has(optionId)) throw new Error(`Duplicate option id: ${optionId}`);
            optionIds.add(optionId);
            if (option.recommended !== undefined && typeof option.recommended !== 'boolean') throw new Error('Option recommended must be boolean.');
            return {
                id: optionId,
                label: text(option.label, 'Option label', 200),
                description: text(option.description, 'Option description', 1_000),
                ...(option.recommended === undefined ? {} : { recommended: option.recommended as boolean }),
            };
        });
        return { id, prompt, kind: question.kind, required: question.required !== false, allowOther: true, options };
    });
}

export function validateUserInputAnswers(questions: PlanQuestion[], value: unknown): PlanQuestionAnswer[] {
    if (!Array.isArray(value)) throw new Error('Answers must be an array.');
    const answers = new Map<string, PlanQuestionAnswer>();
    for (const raw of value) {
        const answer = object(raw, 'Answer');
        const questionId = text(answer.questionId, 'Answer question id', 100);
        const question = questions.find(item => item.id === questionId);
        if (!question) throw new Error(`Unknown question id: ${questionId}`);
        if (answers.has(questionId)) throw new Error(`Duplicate answer for question: ${questionId}`);
        if (!Array.isArray(answer.optionIds) || answer.optionIds.some(id => typeof id !== 'string' || !id.trim())) throw new Error('Answer optionIds must be an array of option ids.');
        const optionIds = answer.optionIds.map(id => (id as string).trim());
        if (new Set(optionIds).size !== optionIds.length) throw new Error('Duplicate answer option id.');
        if (optionIds.some(id => !question.options.some(option => option.id === id))) throw new Error('Invalid option id.');
        if (question.kind === 'single' && optionIds.length > 1) throw new Error('Single-choice questions allow at most one option.');
        if (answer.other !== undefined && typeof answer.other !== 'string') throw new Error('Custom answer must be a string.');
        const other = (answer.other as string | undefined)?.trim();
        if (other && other.length > 10_000) throw new Error('Custom answer is too long.');
        // Keep canonical option order so an equivalent retry is idempotent.
        answers.set(questionId, { questionId, optionIds: question.options.filter(option => optionIds.includes(option.id)).map(option => option.id), ...(other ? { other } : {}) });
    }
    return questions.map(question => {
        const answer = answers.get(question.id) || { questionId: question.id, optionIds: [] };
        if (question.required !== false && !answer.optionIds.length && !answer.other) throw new Error(`An answer is required for ${question.id}.`);
        return answer;
    });
}

interface SessionInputs { version: 1; sessionId: string; requests: UserInputRequest[] }
export interface CreateUserInputRequest {
    id?: string;
    sessionId: string;
    turnId: string;
    runId: string;
    questions: PlanQuestion[];
    context: UserInputRequest['context'];
}

/** Independent of plan/work mode. Every response and its continuation outbox share one atomic record. */
export class UserInputStore {
    private readonly directory: string;
    private readonly now: () => number;

    constructor(options: { directory?: string; now?: () => number } = {}) {
        this.directory = options.directory || join(process.cwd(), '.openflux', 'user-input');
        this.now = options.now || Date.now;
    }

    private path(sessionId: string): string {
        return join(this.directory, `${createHash('sha256').update(sessionId).digest('hex')}.json`);
    }

    private read(sessionId: string): SessionInputs {
        text(sessionId, 'Session id', 500);
        const record = readJsonWithBackup<SessionInputs>(this.path(sessionId));
        if (record && (record.version !== 1 || record.sessionId !== sessionId || !Array.isArray(record.requests))) throw new Error('Invalid user input store identity.');
        if (!record && (existsSync(this.path(sessionId)) || existsSync(`${this.path(sessionId)}.bak`))) throw new Error('User input store is unreadable.');
        return record || { version: 1, sessionId, requests: [] };
    }

    private write(record: SessionInputs): void {
        atomicWrite(this.path(record.sessionId), JSON.stringify(record, null, 2));
    }

    get(sessionId: string, requestId: string): UserInputRequest | undefined {
        return this.read(sessionId).requests.find(request => request.id === requestId);
    }

    getPending(sessionId: string): UserInputRequest | undefined {
        return this.read(sessionId).requests.find(request => request.status === 'pending');
    }

    create(input: CreateUserInputRequest): UserInputRequest {
        const record = this.read(input.sessionId);
        const id = text(input.id ?? randomUUID(), 'Request id', 200);
        if (record.requests.some(request => request.id === id)) throw new Error('Request id already exists.');
        if (record.requests.some(request => request.status === 'pending' || request.status === 'resolved' && !request.continuationQueued)) throw new Error('This session already has an outstanding input request.');
        const context = object(input.context, 'Request context');
        const requestInput = text(context.input, 'Original input', 200_000);
        if (context.approvalMode !== undefined && !['ask', 'risk_based', 'full_access'].includes(String(context.approvalMode))) throw new Error('Invalid approval mode.');
        const timestamp = this.now();
        const request: UserInputRequest = {
            id, sessionId: input.sessionId, turnId: text(input.turnId, 'Turn id', 200), runId: text(input.runId, 'Run id', 200),
            createdAt: timestamp, updatedAt: timestamp, status: 'pending',
            questions: validateUserInputQuestions(input.questions),
            continuationSubmissionId: `user-input:${id}:continue`,
            context: { input: requestInput, ...(context.agentId === undefined ? {} : { agentId: text(context.agentId, 'Agent id', 200) }), ...(context.approvalMode === undefined ? {} : { approvalMode: context.approvalMode as UserInputRequest['context']['approvalMode'] }) },
        };
        record.requests.push(request);
        this.write(record);
        return structuredClone(request);
    }

    resolve(sessionId: string, requestId: string, submissionId: string, answers: PlanQuestionAnswer[]): { request: UserInputRequest; duplicate: boolean } {
        submissionId = text(submissionId, 'Submission id', 300);
        const record = this.read(sessionId);
        const request = record.requests.find(item => item.id === requestId);
        if (!request || request.status === 'cancelled') throw new Error('Input request is missing or no longer pending.');
        const normalized = validateUserInputAnswers(request.questions, answers);
        if (request.status === 'resolved') {
            if (request.response?.submissionId !== submissionId || JSON.stringify(request.response.answers) !== JSON.stringify(normalized)) throw new Error('Input request has already been answered with a different submission or answer.');
            return { request, duplicate: true };
        }
        if (record.requests.some(item => item.response?.submissionId === submissionId)) throw new Error('Submission id has already been used for another request.');
        request.status = 'resolved';
        request.updatedAt = this.now();
        request.response = { submissionId, submittedAt: request.updatedAt, answers: normalized };
        this.write(record);
        return { request: structuredClone(request), duplicate: false };
    }

    cancel(sessionId: string, requestId: string): UserInputRequest {
        const record = this.read(sessionId);
        const request = record.requests.find(item => item.id === requestId);
        if (!request) throw new Error('Input request not found.');
        if (request.status === 'resolved') throw new Error('An answered input request cannot be cancelled.');
        if (request.status === 'pending') {
            request.status = 'cancelled';
            request.updatedAt = this.now();
            this.write(record);
        }
        return structuredClone(request);
    }

    markContinuationQueued(sessionId: string, requestId: string): UserInputRequest {
        const record = this.read(sessionId);
        const request = record.requests.find(item => item.id === requestId);
        if (!request || request.status !== 'resolved') throw new Error('Only answered input requests can resume.');
        if (!request.continuationQueued) {
            request.continuationQueued = true;
            request.updatedAt = this.now();
            this.write(record);
        }
        return structuredClone(request);
    }

    private list(): UserInputRequest[] {
        if (!existsSync(this.directory)) return [];
        const files = [...new Set(readdirSync(this.directory).filter(file => /^[a-f0-9]{64}\.json(?:\.bak)?$/.test(file)).map(file => file.replace(/\.bak$/, '')))];
        return files.flatMap(file => {
            const record = readJsonWithBackup<SessionInputs>(join(this.directory, file));
            if (!record || record.version !== 1 || !Array.isArray(record.requests) || this.path(record.sessionId) !== join(this.directory, file)) throw new Error('Invalid user input store record.');
            return record.requests;
        });
    }

    listPending(): UserInputRequest[] { return this.list().filter(request => request.status === 'pending'); }
    listUnqueuedResolved(): UserInputRequest[] { return this.list().filter(request => request.status === 'resolved' && !request.continuationQueued); }
}
