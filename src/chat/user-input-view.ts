import { isUserInputComplete, UserInputDrafts, type UserInputRequest } from './user-input-state';
import type { PlanQuestionAnswer } from './plan-state';
import { renderQuestionStep, type QuestionStepOptions, type QuestionStepView } from './question-input-view';

export interface UserInputViewOptions {
    text: QuestionStepOptions['text'];
    submit: (request: UserInputRequest, answers: PlanQuestionAnswer[], submissionId: string) => Promise<void>;
    cancel: (request: UserInputRequest) => Promise<void>;
    errorText: (error: unknown) => string;
}

interface ActiveUserInput {
    sessionId: string;
    request: UserInputRequest;
    view?: QuestionStepView;
}

/** A bottom-composer question form; persisted chat messages remain read-only. */
export class UserInputView {
    readonly drafts = new UserInputDrafts();
    private active?: ActiveUserInput;

    constructor(private readonly root: HTMLElement, private readonly options: UserInputViewOptions) {}

    reconcile(sessionId: string | null, request?: UserInputRequest): void {
        const pending = request?.status === 'pending' && request.sessionId === sessionId ? request : undefined;
        if (!pending || !sessionId) {
            this.active?.view?.dispose();
            this.active = undefined;
            return;
        }
        if (this.active?.sessionId === sessionId && this.active.request.id === pending.id
            && this.active.request.updatedAt === pending.updatedAt && this.root.firstChild) {
            this.active.request = pending;
            this.active.view?.update();
            return;
        }
        this.active?.view?.dispose();
        const active: ActiveUserInput = { sessionId, request: pending };
        this.active = active;
        const entry = this.drafts.get(pending);
        active.view = renderQuestionStep(this.root, {
            requestId: pending.id,
            questions: pending.questions,
            state: entry,
            title: this.options.text('user_input.title'),
            submitLabel: this.options.text('user_input.submit'),
            cancelLabel: this.options.text('user_input.cancel'),
            text: this.options.text,
            isCurrent: () => this.active === active,
            onNavigate: index => { entry.questionIndex = index; },
            onSubmit: () => {
                if (this.active !== active || entry.busy || !isUserInputComplete(pending, entry.answers)) return;
                const response = this.drafts.submission(pending);
                void this.perform(active, () => this.options.submit(pending, response.answers, response.submissionId));
            },
            onCancel: () => {
                if (this.active !== active || entry.busy) return;
                void this.perform(active, () => this.options.cancel(pending));
            },
        });
    }

    private async perform(active: ActiveUserInput, operation: () => Promise<void>): Promise<void> {
        const { request } = active;
        const entry = this.drafts.get(request);
        if (entry.busy) return;
        entry.busy = true;
        entry.error = undefined;
        active.view?.update();
        try {
            await operation();
            this.drafts.clear(request);
            // The callback normally reconciles the server acknowledgement. If it did
            // not, remove only this completed request, never a newer request or host.
            if (this.isActiveRequest(request)) {
                this.active?.view?.dispose();
                this.active = undefined;
            }
        } catch (cause) {
            entry.error = this.options.errorText(cause);
        } finally {
            entry.busy = false;
            // Switching away and back creates another renderer over the same draft.
            if (this.isActiveRequest(request)) this.active?.view?.update();
        }
    }

    private isActiveRequest(request: UserInputRequest): boolean {
        return this.active?.sessionId === request.sessionId && this.active.request.id === request.id;
    }
}
