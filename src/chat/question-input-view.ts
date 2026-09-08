import {
    canAdvancePlanQuestion,
    firstIncompletePlanQuestionIndex,
    isPlanAnswerDraftComplete,
    type PlanAnswerDraft,
    type PlanQuestion,
} from './plan-state';

export interface QuestionStepState {
    answers: PlanAnswerDraft;
    questionIndex?: number;
    busy: boolean;
    error?: string;
}

export interface QuestionStepOptions {
    requestId: string;
    questions: PlanQuestion[];
    state: QuestionStepState;
    title: string;
    submitLabel: string;
    cancelLabel?: string;
    text: (key: string, ...args: Array<string | number>) => string;
    isCurrent: () => boolean;
    onNavigate: (index: number) => void;
    onSubmit: () => void;
    onCancel?: () => void;
}

export interface QuestionStepView {
    update(): void;
    dispose(): void;
}

export function createQuestionOptionLabel(
    doc: Document,
    input: HTMLInputElement,
    labelText: string,
    descriptionText: string,
    recommended: boolean,
    text: QuestionStepOptions['text'],
): HTMLLabelElement {
    const label = doc.createElement('label');
    label.className = 'plan-option';
    const copy = doc.createElement('span');
    copy.className = 'plan-option-copy';
    const title = doc.createElement('strong');
    title.textContent = labelText;
    const description = doc.createElement('small');
    description.textContent = descriptionText;
    copy.append(title, description);
    label.append(input, copy);
    if (recommended) {
        const badge = doc.createElement('span');
        badge.className = 'plan-option-recommended';
        badge.textContent = text('plan.recommended');
        label.append(badge);
    }
    return label;
}

/** One shared question form for plan choices and normal-mode clarification. */
export function renderQuestionStep(host: HTMLElement, options: QuestionStepOptions): QuestionStepView {
    const { state, questions, text } = options;
    const doc = host.ownerDocument;
    let disposed = false;
    let generation = 0;
    let form: HTMLFormElement | undefined;
    let renderedIndex = -1;
    let advanceTimer: ReturnType<typeof setTimeout> | number | undefined;
    let updateControls = () => {};

    const clearAdvance = () => {
        if (advanceTimer !== undefined) {
            if (doc.defaultView) doc.defaultView.clearTimeout(advanceTimer as number);
            else clearTimeout(advanceTimer);
        }
        advanceTimer = undefined;
    };
    const currentIndex = () => Math.max(0, Math.min(
        Number.isInteger(state.questionIndex) ? state.questionIndex! : firstIncompletePlanQuestionIndex({ questions }, state.answers),
        questions.length - 1,
    ));
    const isLive = (expectedGeneration: number) => !disposed && generation === expectedGeneration
        && form?.parentElement === host && options.isCurrent();
    const navigate = (index: number, expectedGeneration: number) => {
        if (!isLive(expectedGeneration) || state.busy || index < 0 || index >= questions.length) return;
        clearAdvance();
        state.questionIndex = index;
        render();
        options.onNavigate(index);
    };

    const render = () => {
        if (disposed) return;
        clearAdvance();
        const activeGeneration = ++generation;
        const index = currentIndex();
        state.questionIndex = index;
        renderedIndex = index;
        const question = questions[index];
        if (!question) {
            form?.remove();
            form = undefined;
            return;
        }
        const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, content?: string) => {
            const element = doc.createElement(tag);
            element.className = className;
            if (content !== undefined) element.textContent = content;
            return element;
        };
        const nextForm = node('form', 'plan-question-form');
        nextForm.dataset.requestId = options.requestId;
        nextForm.setAttribute('aria-label', options.title);
        const header = node('div', 'plan-interaction-header');
        header.append(node('strong', '', options.title), node('span', '', text('plan.question_progress', index + 1, questions.length)));
        const field = node('fieldset', 'plan-question');
        field.dataset.questionId = question.id;
        const legend = node('legend', 'plan-question-title', question.prompt);
        if (question.required !== false) legend.append(node('span', 'plan-question-required', text('plan.required')));
        field.append(legend);
        const list = node('div', 'plan-option-list');
        if (question.kind === 'single') list.setAttribute('role', 'radiogroup');
        const inputs: HTMLInputElement[] = [];
        let other: HTMLInputElement | undefined;
        const answer = () => state.answers[question.id] ||= { optionIds: [], other: '' };
        for (const option of question.options) {
            const input = doc.createElement('input');
            input.type = question.kind === 'single' ? 'radio' : 'checkbox';
            input.name = `question-${options.requestId}-${question.id}`;
            input.value = option.id;
            input.checked = Boolean(state.answers[question.id]?.optionIds.includes(option.id));
            input.addEventListener('change', () => {
                if (!isLive(activeGeneration) || state.busy) return;
                clearAdvance();
                const current = answer();
                current.optionIds = inputs.filter(item => item.checked).map(item => item.value);
                if (question.kind === 'single') {
                    current.other = '';
                    if (other) other.value = '';
                }
                state.error = undefined;
                updateControls();
                if (question.kind === 'single' && input.checked && index < questions.length - 1) {
                    const advance = () => navigate(index + 1, activeGeneration);
                    advanceTimer = doc.defaultView ? doc.defaultView.setTimeout(advance, 160) : setTimeout(advance, 160);
                }
            });
            inputs.push(input);
            list.append(createQuestionOptionLabel(doc, input, option.label, option.description, Boolean(option.recommended), text));
        }
        field.append(list);
        if (question.allowOther !== false) {
            other = node('input', 'plan-other-input');
            other.type = 'text';
            other.placeholder = text('plan.other_placeholder');
            other.setAttribute('aria-label', text('plan.other_aria', question.prompt));
            other.value = state.answers[question.id]?.other || '';
            other.addEventListener('input', () => {
                if (!isLive(activeGeneration) || state.busy) return;
                clearAdvance();
                const current = answer();
                current.other = other!.value;
                if (question.kind === 'single' && other!.value.trim()) {
                    current.optionIds = [];
                    for (const input of inputs) input.checked = false;
                }
                state.error = undefined;
                updateControls();
            });
            field.append(other);
        }
        const error = node('p', 'plan-interaction-error');
        error.setAttribute('role', 'alert');
        const actions = node('div', 'plan-interaction-actions');
        const buttons: HTMLButtonElement[] = [];
        const action = (name: string, label: string) => {
            const button = node('button', 'plan-action-btn', label);
            button.type = 'button';
            button.dataset.questionAction = name;
            buttons.push(button);
            actions.append(button);
            return button;
        };
        if (options.onCancel) {
            const cancel = action('cancel', options.cancelLabel || '');
            cancel.addEventListener('click', () => {
                if (!isLive(activeGeneration) || state.busy) return;
                clearAdvance();
                options.onCancel?.();
            });
        }
        if (index > 0) {
            const previous = action('previous', text('plan.previous_question'));
            previous.addEventListener('click', () => navigate(index - 1, activeGeneration));
        }
        const isLast = index === questions.length - 1;
        const forward = action(isLast ? 'submit' : 'next', isLast ? options.submitLabel : text('plan.next_question'));
        forward.classList.add('primary');
        forward.type = 'submit';
        updateControls = () => {
            if (!isLive(activeGeneration)) return;
            if (state.busy) clearAdvance();
            field.disabled = state.busy;
            for (const input of inputs) input.disabled = state.busy;
            if (other) other.disabled = state.busy;
            for (const button of buttons) button.disabled = state.busy;
            forward.disabled = state.busy || (isLast
                ? !isPlanAnswerDraftComplete({ questions }, state.answers)
                : !canAdvancePlanQuestion(question, state.answers));
            nextForm.setAttribute('aria-busy', String(state.busy));
            error.textContent = state.error || '';
            error.hidden = !state.error;
        };
        nextForm.addEventListener('submit', event => {
            event.preventDefault();
            event.stopPropagation();
            if (!isLive(activeGeneration) || state.busy || forward.disabled) return;
            clearAdvance();
            if (isLast) options.onSubmit();
            else navigate(index + 1, activeGeneration);
        });
        nextForm.addEventListener('keydown', event => {
            // Keep the form's native Enter behavior out of the main chat composer.
            if (event.key === 'Enter') {
                event.stopPropagation();
                // Confirming an IME candidate is not an answer submission.
                if (event.isComposing || event.keyCode === 229) event.preventDefault();
            }
        });
        nextForm.append(header, field, error, actions);
        form = nextForm;
        host.replaceChildren(nextForm);
        updateControls();
        queueMicrotask(() => {
            if (!isLive(activeGeneration) || state.busy) return;
            const selected = inputs.find(input => input.checked);
            const focus = selected || (other?.value ? other : inputs[0] || other);
            focus?.focus();
        });
    };

    render();
    return {
        update() {
            if (disposed || form?.parentElement !== host || !options.isCurrent()) return;
            if (currentIndex() !== renderedIndex) render();
            else updateControls();
        },
        dispose() {
            disposed = true;
            generation++;
            clearAdvance();
            // Never clear a replacement view that now occupies the same host.
            if (form?.parentElement === host) form.remove();
        },
    };
}
