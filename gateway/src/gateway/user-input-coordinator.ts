import type { PlanQuestionAnswer } from '../work/types';
import type { UserInputStore } from '../work/user-input-store';
import type { UserInputRequest } from '../work/user-input-types';

export interface UserInputMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    metadata: {
        kind: 'user_input_question' | 'user_input_answer' | 'user_input_cancelled';
        requestId: string;
        turnId: string;
        runId: string;
        questions?: UserInputRequest['questions'];
        answers?: PlanQuestionAnswer[];
    };
}

export type UserInputChangeReason = 'requested' | 'continuation_queued' | 'cancelled' | 'recovered';

export interface UserInputCoordinatorDeps {
    store: UserInputStore;
    /** Pause both runtime and durable queues synchronously, before this turn releases its lease. */
    pauseSession(sessionId: string): void;
    /** Durable upsert by sessionId + metadata.kind + metadata.requestId, never plain append. */
    ensureMessage(sessionId: string, message: UserInputMessage): void | Promise<void>;
    /**
     * Durably enqueue with request.continuationSubmissionId, ahead of later queued work.
     * Repeated calls must recognize queued AND terminal submissions. Return after the
     * durable enqueue, not after agent execution. The host owns releasing the input
     * pause and must never release an unrelated user Stop or a newer input request.
     */
    enqueueContinuation(request: UserInputRequest, displayAnswer: string, internalInput: string): Promise<void>;
    onStateChanged?(request: UserInputRequest, reason: UserInputChangeReason): void | Promise<void>;
}

export interface UserInputRecoveryResult {
    pending: number;
    continued: number;
    errors: Array<{ sessionId: string; requestId: string; error: string }>;
}

function chinese(request: UserInputRequest): boolean {
    return /[\u3400-\u9fff]/.test(request.context.input + request.questions.map(question => question.prompt).join(''));
}

function message(request: UserInputRequest, kind: UserInputMessage['metadata']['kind'], role: UserInputMessage['role'], content: string): UserInputMessage {
    return {
        id: `${kind}:${request.id}`,
        role,
        content,
        metadata: {
            kind, requestId: request.id, turnId: request.turnId, runId: request.runId,
            ...(kind === 'user_input_question' || kind === 'user_input_answer' ? { questions: structuredClone(request.questions) } : {}),
            ...(kind === 'user_input_answer' && request.response ? { answers: structuredClone(request.response.answers) } : {}),
        },
    };
}

export function buildUserInputQuestionMessage(request: UserInputRequest): UserInputMessage {
    const zh = chinese(request);
    const content = request.questions.map((question, index) => {
        const options = question.options.map(option => {
            const recommended = option.recommended ? (zh ? '（推荐）' : ' (Recommended)') : '';
            return `- ${option.label}${recommended}${option.description ? ` — ${option.description}` : ''}`;
        });
        if (question.allowOther !== false) options.push(zh ? '- 其他：可以填写自己的回答。' : '- Other: enter your own answer.');
        return `${index + 1}. ${question.prompt}\n${options.join('\n')}`;
    }).join('\n\n');
    return message(request, 'user_input_question', 'assistant', content);
}

export function buildUserInputAnswerMessage(request: UserInputRequest): UserInputMessage {
    if (!request.response) throw new Error('Cannot render a user input answer before it is resolved.');
    const zh = chinese(request);
    const content = request.questions.map((question, index) => {
        const answer = request.response!.answers.find(item => item.questionId === question.id);
        const options = answer?.optionIds.map(id => {
            const option = question.options.find(item => item.id === id);
            if (!option) throw new Error('The stored answer references an unknown option.');
            return `${option.label}${option.description ? ` — ${option.description}` : ''}`;
        }) || [];
        if (answer?.other?.trim()) options.push(`${zh ? '其他' : 'Other'}: ${answer.other.trim()}`);
        return `${index + 1}. ${question.prompt}\n${options.length ? options.join('\n') : (zh ? '未选择（可选问题）' : 'Not answered (optional question)')}`;
    }).join('\n\n');
    return message(request, 'user_input_answer', 'user', content);
}

export function buildUserInputContinuationPrompt(request: UserInputRequest, displayAnswer = buildUserInputAnswerMessage(request).content): string {
    if (chinese(request)) {
        return [
            '用户已回答此前的澄清问题。请结合当前会话历史继续原任务，保留已完成的工作与约束，不要把这条回答当成一个无关的新任务。',
            `原任务：\n${request.context.input}`,
            `已确认的问题与回答：\n${displayAnswer}`,
            '以上问题已经回答，不要重复询问；继续完成依赖这些选择的工作。此前操作与结果仍在会话历史中，不要重复执行已经完成的操作。',
        ].join('\n\n');
    }
    return [
        'The user has answered the pending clarification. Continue the original task using this conversation history, retaining completed work and existing constraints. Treat this answer as a continuation of that task.',
        `Original task:\n${request.context.input}`,
        `Confirmed questions and answers:\n${displayAnswer}`,
        'These questions are answered; do not ask them again. Continue the work that depended on the choices, and use the conversation history to avoid repeating completed operations.',
    ].join('\n\n');
}

/** Durable input state plus an idempotent continuation outbox; no process-long awaiting-user promise. */
export class UserInputCoordinator {
    private readonly sessionTails = new Map<string, Promise<unknown>>();

    constructor(private readonly deps: UserInputCoordinatorDeps) {}

    async requestInput(input: Parameters<UserInputStore['create']>[0]): Promise<UserInputRequest> {
        // These operations must happen before the first await: the agent can
        // otherwise return waiting_input and let ExecutionRegistry pump FIFO.
        const request = this.deps.store.create(input);
        this.deps.pauseSession(request.sessionId);
        return this.inSession(request.sessionId, async () => {
            await this.deps.ensureMessage(request.sessionId, buildUserInputQuestionMessage(request));
            await this.deps.onStateChanged?.(request, 'requested');
            return request;
        });
    }

    resolve(sessionId: string, requestId: string, submissionId: string, answers: PlanQuestionAnswer[]): Promise<{ request: UserInputRequest; duplicate: boolean }> {
        return this.inSession(sessionId, async () => {
            // Resolve persists the accepted answer before message/queue effects.
            // Retrying the same submission repairs either effect after a crash.
            const result = this.deps.store.resolve(sessionId, requestId, submissionId, answers);
            const request = await this.continueResolved(result.request);
            return { request, duplicate: result.duplicate };
        });
    }

    cancel(sessionId: string, requestId: string): Promise<UserInputRequest> {
        return this.inSession(sessionId, async () => {
            const request = this.deps.store.cancel(sessionId, requestId);
            await this.deps.ensureMessage(sessionId, buildUserInputQuestionMessage(request));
            await this.deps.ensureMessage(sessionId, message(request, 'user_input_cancelled', 'assistant', chinese(request)
                ? '已取消这次澄清，原任务未继续执行。'
                : 'This clarification was cancelled. The original task has not resumed.'));
            // Cancellation never implicitly resumes queued work or picks an option.
            await this.deps.onStateChanged?.(request, 'cancelled');
            return request;
        });
    }

    /** Call before hydrating a session's ordinary queue after startup/reconnect. */
    async recover(sessionId?: string): Promise<UserInputRecoveryResult> {
        const pending = this.deps.store.listPending().filter(request => !sessionId || request.sessionId === sessionId);
        const resolved = this.deps.store.listUnqueuedResolved().filter(request => !sessionId || request.sessionId === sessionId);
        const result: UserInputRecoveryResult = { pending: 0, continued: 0, errors: [] };
        // Apply all holds before awaiting I/O, so a slow message write in A
        // cannot leave a pending B unprotected from queue hydration.
        for (const request of pending) this.deps.pauseSession(request.sessionId);
        await Promise.all([...pending, ...resolved].map(candidate => this.inSession(candidate.sessionId, async () => {
            try {
                const request = this.deps.store.get(candidate.sessionId, candidate.id);
                if (!request || request.status === 'cancelled') return;
                if (request.status === 'pending') {
                    await this.deps.ensureMessage(request.sessionId, buildUserInputQuestionMessage(request));
                    await this.deps.onStateChanged?.(request, 'recovered');
                    result.pending++;
                } else if (!request.continuationQueued) {
                    await this.continueResolved(request);
                    result.continued++;
                }
            } catch (error) {
                result.errors.push({ sessionId: candidate.sessionId, requestId: candidate.id, error: error instanceof Error ? error.message : String(error) });
            }
        })));
        return result;
    }

    private async continueResolved(request: UserInputRequest): Promise<UserInputRequest> {
        await this.deps.ensureMessage(request.sessionId, buildUserInputQuestionMessage(request));
        const answer = buildUserInputAnswerMessage(request);
        await this.deps.ensureMessage(request.sessionId, answer);
        if (request.continuationQueued) return request;
        await this.deps.enqueueContinuation(request, answer.content, buildUserInputContinuationPrompt(request, answer.content));
        const queued = this.deps.store.markContinuationQueued(request.sessionId, request.id);
        await this.deps.onStateChanged?.(queued, 'continuation_queued');
        return queued;
    }

    private inSession<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
        const previous = this.sessionTails.get(sessionId) || Promise.resolve();
        const running = previous.catch(() => undefined).then(operation);
        this.sessionTails.set(sessionId, running);
        void running.finally(() => {
            if (this.sessionTails.get(sessionId) === running) this.sessionTails.delete(sessionId);
        }).catch(() => undefined);
        return running;
    }
}
