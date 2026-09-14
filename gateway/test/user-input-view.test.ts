import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import { UserInputView, type UserInputViewOptions } from '../../src/chat/user-input-view';
import { renderQuestionStep, type QuestionStepState } from '../../src/chat/question-input-view';
import { planAnswerDraftToResponse } from '../../src/chat/plan-state';
import type { UserInputRequest } from '../../src/chat/user-input-state';
import zh from '../../src/i18n/zh';
import { GatewayClient } from '../../src/gateway-client';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const request = (id = 'request-a', sessionId = 'session-a'): UserInputRequest => ({
    id, sessionId, turnId: 'turn-a', createdAt: 1, updatedAt: 1, status: 'pending',
    questions: [{ id: 'style', prompt: '选择风格', kind: 'single', allowOther: true,
        options: [{ id: 'a', label: '简约', description: '清晰易读', recommended: true }, { id: 'b', label: '丰富', description: '内容详细' }] }],
});
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function useQuestionTimers(window: JSDOM['window']) {
    let sequence = 0;
    const pending = new Map<number, () => void>();
    window.setTimeout = ((handler: TimerHandler, _timeout?: number, ...args: unknown[]) => {
        assert.equal(typeof handler, 'function', 'question navigation must not evaluate timer strings');
        const id = ++sequence;
        pending.set(id, () => (handler as (...args: unknown[]) => void)(...args));
        return id;
    }) as typeof window.setTimeout;
    window.clearTimeout = ((id?: number) => { if (id !== undefined) pending.delete(id); }) as typeof window.clearTimeout;
    return {
        callbacks: () => [...pending.values()],
        advance() { const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach(callback => callback()); },
    };
}
function harness(t: TestContext, overrides: Partial<UserInputViewOptions> = {}) {
    const dom = new JSDOM('<!doctype html><body><div id="messages"></div><div id="input-row"><div id="user-input-interaction"></div><textarea id="composer">原来的输入草稿</textarea></div></body>', { url: 'https://input.test' });
    t.after(() => dom.window.close());
    const root = dom.window.document.getElementById('user-input-interaction')!;
    const messages = dom.window.document.getElementById('messages')!;
    const timers = useQuestionTimers(dom.window);
    const submitted: unknown[][] = [];
    const cancelled: UserInputRequest[] = [];
    const view = new UserInputView(root, {
        text: key => (zh as Record<string, string>)[key] || key,
        errorText: error => error instanceof Error ? error.message : String(error),
        submit: async (...args) => { submitted.push(args); view.reconcile('session-a'); },
        cancel: async req => { cancelled.push(req); view.reconcile('session-a'); },
        ...overrides,
    });
    const choose = (value = 'a') => root.querySelector<HTMLInputElement>(`input[value="${value}"]`)!.click();
    const type = (value: string) => {
        const textarea = root.querySelector<HTMLInputElement | HTMLTextAreaElement>('.plan-other-input')!;
        textarea.value = value;
        textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    };
    const submit = () => root.querySelector<HTMLButtonElement>('[data-question-action="submit"]')!.click();
    const button = (key: string) => {
        const label = (zh as Record<string, string>)[key] || key;
        const node = [...root.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label);
        assert.ok(node, `Missing question action ${key}`);
        return node;
    };
    return { dom, root, messages, timers, view, submitted, cancelled, choose, type, submit, button };
}
function history(root: HTMLElement, req: UserInputRequest) {
    const doc = root.ownerDocument;
    const message = doc.createElement('div'); message.className = 'message assistant'; message.dataset.messageId = 'persisted-question';
    const transcript = doc.createElement('div'); transcript.className = 'user-input-transcript'; transcript.textContent = req.questions[0].prompt;
    const slot = doc.createElement('div'); slot.dataset.userInputRequest = req.id;
    message.append(transcript, slot); root.append(message);
}

test('a pending ordinary question requires explicit submit, offers custom input, and leaves the composer intact', async t => {
    const h = harness(t); const req = request();
    h.view.reconcile(req.sessionId, req);
    assert.equal(h.root.querySelector('input:checked'), null);
    assert.equal(h.root.querySelector<HTMLButtonElement>('[data-question-action="submit"]')!.disabled, true);
    h.choose();
    h.timers.advance();
    assert.equal(h.submitted.length, 0);
    h.type('请用我的品牌风格');
    assert.equal(h.root.querySelector('input:checked'), null);
    h.submit(); await settle();
    assert.equal(h.submitted.length, 1);
    assert.deepEqual(h.submitted[0][1], [{ questionId: 'style', optionIds: [], other: '请用我的品牌风格' }]);
    assert.equal(h.root.querySelector('form'), null);
    assert.equal(h.dom.window.document.querySelector<HTMLTextAreaElement>('#composer')!.value, '原来的输入草稿');
});

test('session changes and history replacement retain the bottom draft without changing the read-only transcript', t => {
    const h = harness(t); const req = request();
    history(h.messages, req);
    const originalTranscript = h.messages.innerHTML;
    h.view.reconcile(req.sessionId, req); h.type('尚未提交');
    assert.equal(h.messages.innerHTML, originalTranscript);
    h.view.reconcile('session-b', request('request-b', 'session-b'));
    assert.equal(h.root.querySelector<HTMLInputElement>('.plan-other-input')!.value, '');
    h.messages.replaceChildren(); history(h.messages, req);
    h.view.reconcile(req.sessionId, req);
    assert.equal(h.root.querySelector<HTMLInputElement>('.plan-other-input')!.value, '尚未提交');
    assert.equal(h.root.querySelectorAll('form').length, 1);
    assert.equal(h.messages.innerHTML, originalTranscript);
    assert.equal(h.messages.querySelector('form, input, textarea, button'), null);
    h.view.reconcile(req.sessionId);
    assert.equal(h.messages.innerHTML, originalTranscript);
    assert.equal(h.root.querySelector('form'), null);
});

test('a persisted pending question restores after reload and resolved history remains readable', t => {
    const h = harness(t); const req = request(); history(h.messages, req);
    h.view.reconcile(req.sessionId, req);
    assert.equal(h.root.querySelectorAll('form').length, 1);
    assert.equal(h.messages.querySelector<HTMLElement>('.user-input-transcript')!.hidden, false);
    h.view.reconcile(req.sessionId, { ...req, status: 'resolved' });
    assert.equal(h.root.querySelector('form'), null);
    assert.equal(h.messages.textContent!.includes('选择风格'), true);
    assert.equal(h.messages.querySelector('form, input, textarea, button'), null);
});

test('failed submissions retain answers and unchanged retry IDs; rapid repeats do not send twice', async t => {
    const sent: unknown[][] = []; const first = deferred();
    const h = harness(t, { submit: async (...args) => { sent.push(args); if (sent.length === 1) await first.promise; } });
    const req = request(); h.view.reconcile(req.sessionId, req); h.choose(); h.submit(); h.submit();
    assert.equal(sent.length, 1);
    first.reject(new Error('网络中断')); await settle();
    assert.equal(h.root.querySelector('[role="alert"]')!.textContent, '网络中断');
    assert.equal(h.root.querySelector<HTMLInputElement>('input[value="a"]')!.checked, true);
    h.submit(); await settle();
    assert.equal(sent.length, 2);
    assert.equal(sent[0][2], sent[1][2]);
});

test('an in-flight answer stays disabled through history rebuild and a late failure never alters another session', async t => {
    const pending = deferred(); const h = harness(t, { submit: async () => pending.promise }); const req = request();
    h.view.reconcile(req.sessionId, req); h.choose(); h.submit();
    h.messages.replaceChildren(); history(h.messages, req); h.root.replaceChildren(); h.view.reconcile(req.sessionId, req);
    assert.equal(h.root.querySelector<HTMLButtonElement>('[data-question-action="submit"]')!.disabled, true);
    assert.ok([...h.root.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')].every(input => input.disabled));
    const next = request('next', 'session-b'); h.root.replaceChildren(); h.view.reconcile(next.sessionId, next); h.type('另一个会话');
    pending.reject(new Error('上一会话错误')); await settle();
    assert.equal(h.root.querySelector<HTMLInputElement>('.plan-other-input')!.value, '另一个会话');
    assert.equal(h.root.querySelector('[role="alert"]')!.textContent, '');
    h.root.replaceChildren(); h.view.reconcile(req.sessionId, req);
    assert.equal(h.root.querySelector('[role="alert"]')!.textContent, '上一会话错误');
    assert.equal(h.root.querySelector<HTMLInputElement>('input[value="a"]')!.checked, true);
});

test('cancel sends no answer and failure keeps the question available', async t => {
    const h = harness(t); const req = request(); h.view.reconcile(req.sessionId, req);
    h.root.querySelector<HTMLButtonElement>('[data-question-action="cancel"]')!.click(); await settle();
    assert.equal(h.cancelled[0].id, req.id); assert.equal(h.submitted.length, 0); assert.equal(h.root.querySelector('form'), null);
    const failure = harness(t, { cancel: async () => { throw new Error('取消失败'); } }); failure.view.reconcile(req.sessionId, req);
    failure.root.querySelector<HTMLButtonElement>('[data-question-action="cancel"]')!.click(); await settle();
    assert.equal(failure.root.querySelector('[role="alert"]')!.textContent, '取消失败');
    assert.equal(failure.root.querySelector<HTMLButtonElement>('[data-question-action="cancel"]')!.disabled, false);
});

test('all required questions need answers and question content is rendered as text', async t => {
    const h = harness(t); const req = request();
    req.questions.push({ ...req.questions[0], id: 'scope', kind: 'multiple', prompt: '<img src=x onerror=alert(1)>', allowOther: false });
    h.view.reconcile(req.sessionId, req); h.choose();
    assert.equal(h.root.querySelectorAll('fieldset').length, 1);
    assert.equal(h.root.querySelector('[data-question-action="submit"]'), null);
    h.timers.advance();
    assert.equal(h.root.querySelector<HTMLButtonElement>('[data-question-action="submit"]')!.disabled, true);
    assert.equal(h.root.querySelector('img'), null);
    h.root.querySelector<HTMLInputElement>('[data-question-id="scope"] input[value="a"]')!.click();
    h.root.querySelector<HTMLInputElement>('[data-question-id="scope"] input[value="b"]')!.click(); h.submit(); await settle();
    assert.deepEqual(h.submitted[0][1], [{ questionId: 'style', optionIds: ['a'] }, { questionId: 'scope', optionIds: ['a', 'b'] }]);
});

test('one question at a time retains answers across automatic and manual navigation, with an explicit final submit', async t => {
    const h = harness(t); const req = request();
    req.questions.push(
        { ...req.questions[0], id: 'scope', prompt: '选择用途' },
        { ...req.questions[0], id: 'extras', prompt: '附加要求', kind: 'multiple' },
    );
    h.view.reconcile(req.sessionId, req);
    h.choose('b');
    assert.equal(h.root.querySelector('fieldset')!.getAttribute('data-question-id'), 'style');
    h.timers.advance();
    assert.equal(h.root.querySelector('fieldset')!.getAttribute('data-question-id'), 'scope');
    h.button('plan.previous_question').click();
    assert.equal(h.root.querySelector<HTMLInputElement>('input[value="b"]')!.checked, true);
    h.button('plan.next_question').click();
    h.choose('a'); h.timers.advance();
    assert.equal(h.root.querySelector('fieldset')!.getAttribute('data-question-id'), 'extras');
    h.choose('a'); h.choose('b'); h.type('还需要离线可用'); h.timers.advance();
    assert.equal(h.submitted.length, 0, 'selecting the final answer never submits by itself');
    h.button('plan.previous_question').click();
    assert.equal(h.root.querySelector<HTMLInputElement>('input[value="a"]')!.checked, true);
    h.button('plan.next_question').click();
    assert.equal(h.root.querySelectorAll('input:checked').length, 2);
    assert.equal(h.root.querySelector<HTMLInputElement>('.plan-other-input')!.value, '还需要离线可用');
    h.submit(); await settle();
    assert.deepEqual(h.submitted[0][1], [
        { questionId: 'style', optionIds: ['b'] }, { questionId: 'scope', optionIds: ['a'] },
        { questionId: 'extras', optionIds: ['a', 'b'], other: '还需要离线可用' },
    ]);
});

test('a timer or detached form from the previous session cannot advance or submit the newly mounted question', async t => {
    const h = harness(t); const req = request();
    req.questions.push({ ...req.questions[0], id: 'scope', prompt: '旧会话第二题' });
    h.view.reconcile(req.sessionId, req); h.choose();
    const staleCallbacks = h.timers.callbacks();
    assert.equal(staleCallbacks.length, 1);
    const oldForm = h.root.querySelector('form')!;
    const next = request('request-b', 'session-b');
    next.questions.push({ ...next.questions[0], id: 'scope', prompt: '新会话第二题' });
    h.view.reconcile(next.sessionId, next); h.type('新会话的自填草稿');
    // A callback already dequeued by the browser can still run after clearTimeout.
    staleCallbacks.forEach(callback => callback());
    h.timers.advance();
    oldForm.dispatchEvent(new h.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    assert.equal(h.root.querySelector('form')!.getAttribute('data-request-id'), next.id);
    assert.equal(h.root.querySelector('fieldset')!.getAttribute('data-question-id'), 'style');
    assert.equal(h.root.querySelector<HTMLInputElement>('.plan-other-input')!.value, '新会话的自填草稿');
    assert.equal(h.submitted.length, 0);
});

test('a late successful answer cannot close or reset a newer request in the same session', async t => {
    const pending = deferred(); const h = harness(t, { submit: async () => pending.promise });
    const req = request(); h.view.reconcile(req.sessionId, req); h.choose(); h.submit();
    const next = request('new-question'); h.view.reconcile(next.sessionId, next); h.type('下一题的新答案');
    const form = h.root.querySelector('form');
    pending.resolve(); await settle();
    assert.equal(h.root.querySelector('form'), form);
    assert.equal(h.root.querySelector('form')!.getAttribute('data-request-id'), next.id);
    assert.equal(h.root.querySelector<HTMLInputElement>('.plan-other-input')!.value, '下一题的新答案');
    assert.equal(h.root.querySelector('[role="alert"]')!.textContent, '');
});

test('the shared renderer updates busy/error state without losing focus or navigating a queued choice', async t => {
    const dom = new JSDOM('<!doctype html><body><section id="host"></section></body>');
    t.after(() => dom.window.close());
    const host = dom.window.document.getElementById('host')!;
    const timers = useQuestionTimers(dom.window);
    const req = request(); req.questions.push({ ...req.questions[0], id: 'scope', prompt: '下一题' });
    const state: QuestionStepState = { answers: {}, busy: false };
    const navigated: number[] = [];
    let submits = 0;
    const view = renderQuestionStep(host, {
        requestId: req.id, questions: req.questions, state, title: '确认选择', submitLabel: '提交',
        text: key => (zh as Record<string, string>)[key] || key,
        isCurrent: () => true, onNavigate: index => navigated.push(index), onSubmit: () => { submits++; },
    });
    await settle();
    const originalForm = host.querySelector('form');
    host.querySelector<HTMLInputElement>('input[value="a"]')!.click();
    state.busy = true; view.update(); timers.advance();
    assert.equal(host.querySelector('form'), originalForm);
    assert.equal(state.questionIndex, 0);
    assert.equal(host.querySelector('form')!.getAttribute('aria-busy'), 'true');
    assert.equal(host.querySelector<HTMLInputElement>('input[value="a"]')!.disabled, true);
    state.busy = false; state.error = '请重试'; view.update();
    const other = host.querySelector<HTMLInputElement>('.plan-other-input')!;
    other.focus(); other.value = '自定义决定'; other.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    view.update();
    assert.equal(host.querySelector('form'), originalForm);
    assert.equal(dom.window.document.activeElement, other);
    assert.equal(other.value, '自定义决定');
    assert.deepEqual(state.answers.style.optionIds, []);
    assert.equal(host.querySelector('[role="alert"]')!.textContent, '');
    host.querySelector<HTMLButtonElement>('[data-question-action="next"]')!.click();
    assert.deepEqual(navigated, [1]);
    assert.equal(submits, 0);
    view.dispose();
    assert.equal(host.querySelector('form'), null);
});

test('composing Enter and legacy IME 229 prevent accidental submission while ordinary Enter remains available', t => {
    const dom = new JSDOM('<!doctype html><body><section id="host"></section></body>');
    t.after(() => dom.window.close());
    const host = dom.window.document.getElementById('host')!;
    let submits = 0;
    let composerKeydowns = 0;
    host.addEventListener('keydown', () => { composerKeydowns++; });
    renderQuestionStep(host, {
        requestId: 'ime-question', questions: request().questions,
        state: { answers: { style: { optionIds: [], other: '正在填写的中文答案' } }, busy: false },
        title: '确认选择', submitLabel: '提交', text: key => key,
        isCurrent: () => true, onNavigate: () => {}, onSubmit: () => { submits++; },
    });
    const other = host.querySelector<HTMLInputElement>('.plan-other-input')!;
    for (const keyboard of [{ isComposing: true, keyCode: 13 }, { isComposing: false, keyCode: 229 }]) {
        const event = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...keyboard });
        other.dispatchEvent(event);
        assert.equal(event.defaultPrevented, true, 'choosing an IME candidate must cancel the native form action');
    }
    assert.equal(submits, 0);
    const ordinary = new dom.window.KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true });
    other.dispatchEvent(ordinary);
    assert.equal(ordinary.defaultPrevented, false);
    assert.equal(composerKeydowns, 0, 'question Enter must never reach the ordinary chat composer');
    // JSDOM has no implicit keyboard submission; exercise the form action that
    // the uncancelled Enter enables in the browser.
    host.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    assert.equal(submits, 1);
});

test('disposing an old shared renderer never removes or advances its replacement on the same host', t => {
    const dom = new JSDOM('<!doctype html><body><section id="host"></section></body>');
    t.after(() => dom.window.close());
    const host = dom.window.document.getElementById('host')!;
    const timers = useQuestionTimers(dom.window);
    const req = request(); req.questions.push({ ...req.questions[0], id: 'scope', prompt: '第二题' });
    const options = {
        questions: req.questions, title: '确认选择', submitLabel: '提交',
        text: (key: string) => (zh as Record<string, string>)[key] || key,
        isCurrent: () => true, onNavigate: () => {}, onSubmit: () => { throw new Error('A stale form must not submit'); },
    };
    const firstState: QuestionStepState = { answers: {}, busy: false };
    const first = renderQuestionStep(host, { ...options, requestId: 'first', state: firstState });
    host.querySelector<HTMLInputElement>('input[value="a"]')!.click();
    const oldCallbacks = timers.callbacks();
    const secondState: QuestionStepState = { answers: {}, busy: false };
    const second = renderQuestionStep(host, { ...options, requestId: 'second', state: secondState });
    const secondForm = host.querySelector('form');
    firstState.questionIndex = 1; first.update();
    assert.equal(host.querySelector('form'), secondForm, 'a stale update cannot remount an old request');
    first.dispose(); oldCallbacks.forEach(callback => callback()); timers.advance();
    assert.equal(host.querySelector('form'), secondForm);
    assert.equal(secondForm!.getAttribute('data-request-id'), 'second');
    assert.equal(secondState.questionIndex, 0);
    second.dispose();
});

test('Gateway resolve/cancel use independent user-input endpoints and preserve the supplied retry ID', async () => {
    const client = new GatewayClient('ws://127.0.0.1:18801'); const calls: unknown[][] = [];
    (client as unknown as { request: (...args: unknown[]) => Promise<unknown> }).request = async (...args) => { calls.push(args); return {}; };
    const answers = [{ questionId: 'style', optionIds: ['a'] }];
    await client.resolveUserInput('session-a', 'request-a', answers, 'submission-a');
    await client.cancelUserInput('session-a', 'request-a');
    assert.deepEqual(calls, [
        ['user.input.resolve', { sessionId: 'session-a', requestId: 'request-a', answers, submissionId: 'submission-a' }],
        ['user.input.cancel', { sessionId: 'session-a', requestId: 'request-a' }],
    ]);
});

// Execute the real entry-point functions with transport/DOM boundaries stubbed;
// loading all of main.ts would initialize unrelated native services.
function mainFunctions(names: string[], context: Record<string, unknown>) {
    const source = readFileSync(new URL('../../src/main.ts', import.meta.url), 'utf8');
    const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const declarations = names.map(name => {
        const declaration = ast.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
        assert.ok(declaration, `Missing main entry point ${name}`);
        return declaration.getText(ast);
    });
    const compiled = ts.transpileModule(`${declarations.join('\n')}\n({${names.join(',')}});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    return runInNewContext(compiled, context) as Record<string, (...args: unknown[]) => unknown>;
}
function mainFunction(name: string, context: Record<string, unknown>) {
    return mainFunctions([name], context)[name];
}

function composerHarness(t: TestContext) {
    const dom = new JSDOM(readFileSync(new URL('../../index.html', import.meta.url), 'utf8'), { url: 'https://input.test' });
    t.after(() => dom.window.close());
    useQuestionTimers(dom.window);
    const doc = dom.window.document;
    const userHost = doc.getElementById('user-input-interaction')!;
    const planHost = doc.getElementById('plan-interaction')!;
    const input = doc.getElementById('message-input') as HTMLTextAreaElement;
    const inputRow = input.closest<HTMLElement>('.input-row')!;
    assert.ok(userHost && planHost, 'both modes need their own real bottom host');
    assert.equal(userHost.parentElement, planHost.parentElement);
    assert.equal(inputRow.contains(userHost), false, 'the form must remain visible when the ordinary row is hidden');
    const states = new Map(); const suspended = new Map<string, string>();
    const view = new UserInputView(userHost, {
        text: key => (zh as Record<string, string>)[key] || key, errorText: String,
        submit: async () => {}, cancel: async () => {},
    });
    const context = {
        currentSessionId: 'session-a' as string | null, currentCloudChatroomId: null, isRouterSession: false,
        workStateBySession: states, planSuspendedDrafts: suspended,
        userInputView: view, userInputInteraction: userHost, planInteraction: planHost, planQuestionView: undefined,
        messageInput: input, inputRow, autoResize: () => {}, hideTyping: () => {},
    };
    const actions = mainFunctions(['reconcileUserInput', 'setPlanInteractionActive', 'restoreSuspendedPlanDraft', 'resetQuestionComposer'], context);
    return { dom, userHost, planHost, input, inputRow, states, suspended, view, context, ...actions };
}

test('the real composer mounts ordinary questions below the transcript and restores its existing draft once resolved', t => {
    const h = composerHarness(t); const req = request();
    h.input.value = '现有编辑草稿';
    h.states.set(req.sessionId, { sessionId: req.sessionId, mode: 'normal', pendingUserInput: req });
    h.reconcileUserInput();
    assert.equal(h.userHost.classList.contains('hidden'), false);
    assert.equal(h.planHost.classList.contains('hidden'), true);
    assert.equal(h.inputRow.classList.contains('plan-interaction-active'), true);
    assert.equal(h.input.value, '');
    assert.equal(h.suspended.get(req.sessionId), '现有编辑草稿');
    h.reconcileUserInput();
    assert.equal(h.suspended.get(req.sessionId), '现有编辑草稿', 'repeated state pushes must not replace the draft with an empty input');
    h.states.set(req.sessionId, { sessionId: req.sessionId, mode: 'normal' }); h.reconcileUserInput();
    assert.equal(h.userHost.classList.contains('hidden'), true);
    assert.equal(h.userHost.querySelector('form'), null);
    assert.equal(h.inputRow.classList.contains('plan-interaction-active'), false);
    assert.equal(h.input.value, '现有编辑草稿');
    assert.equal(h.suspended.has(req.sessionId), false);
});

test('the real composer unmount preserves each session draft, and plan interaction keeps the ordinary input suspended', t => {
    const h = composerHarness(t); const first = request();
    h.input.value = '会话 A 的文字';
    h.states.set(first.sessionId, { sessionId: first.sessionId, mode: 'normal', pendingUserInput: first }); h.reconcileUserInput();
    const other = h.userHost.querySelector<HTMLInputElement>('.plan-other-input')!;
    other.value = '会话 A 的选项答案'; other.dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
    h.resetQuestionComposer();
    assert.equal(h.userHost.querySelector('form'), null);
    assert.equal(h.suspended.get(first.sessionId), '会话 A 的文字');
    h.context.currentSessionId = 'session-b'; h.input.value = '会话 B 的文字';
    const next = request('request-b', 'session-b');
    h.states.set(next.sessionId, { sessionId: next.sessionId, mode: 'normal', pendingUserInput: next }); h.reconcileUserInput();
    assert.equal(h.suspended.get(next.sessionId), '会话 B 的文字');
    h.resetQuestionComposer(); h.context.currentSessionId = first.sessionId; h.input.value = ''; h.reconcileUserInput();
    assert.equal(h.userHost.querySelector<HTMLInputElement>('.plan-other-input')!.value, '会话 A 的选项答案');
    h.states.set(first.sessionId, { sessionId: first.sessionId, mode: 'plan', plan: { status: 'waiting_input' } });
    h.reconcileUserInput();
    assert.equal(h.userHost.classList.contains('hidden'), true);
    assert.equal(h.inputRow.classList.contains('plan-interaction-active'), true);
    assert.equal(h.suspended.get(first.sessionId), '会话 A 的文字');
    h.states.set(first.sessionId, { sessionId: first.sessionId, mode: 'normal' }); h.reconcileUserInput();
    assert.equal(h.input.value, '会话 A 的文字');
    h.resetQuestionComposer(); h.context.currentSessionId = next.sessionId; h.input.value = '';
    h.states.set(next.sessionId, { sessionId: next.sessionId, mode: 'normal' }); h.reconcileUserInput();
    assert.equal(h.input.value, '会话 B 的文字');
});

test('the real plan wrapper unlocks its current remounted form when an older in-flight submission fails', async t => {
    const dom = new JSDOM('<!doctype html><body><section id="host"></section></body>');
    t.after(() => dom.window.close()); useQuestionTimers(dom.window);
    const host = dom.window.document.getElementById('host')!;
    const req = { id: 'plan-question', planId: 'plan-a', createdAt: 1, status: 'pending', questions: request().questions };
    const pending = deferred(); const submissions: unknown[][] = [];
    const context = {
        currentSessionId: 'session-a', planInteraction: host, planQuestionView: undefined,
        planAnswerDrafts: new Map(), workStateRevisions: new Map([['session-a', 1]]),
        workStateBySession: new Map([['session-a', { plan: { id: 'plan-a' }, pendingInput: req }]]),
        renderQuestionStep, planAnswerDraftToResponse,
        t: (key: string) => (zh as Record<string, string>)[key] || key,
        userFacingErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
        applyWorkState: () => {},
        gatewayClient: { async resolvePlanInput(...args: unknown[]) { submissions.push(args); await pending.promise; return { state: {} }; } },
    };
    const render = mainFunction('renderPlanQuestions', context);
    render('session-a', req);
    host.querySelector<HTMLInputElement>('input[value="a"]')!.click();
    host.querySelector<HTMLButtonElement>('[data-question-action="submit"]')!.click();
    const oldForm = host.querySelector('form');
    assert.equal(submissions.length, 1);
    render('session-a', req);
    const currentForm = host.querySelector('form');
    assert.notEqual(currentForm, oldForm);
    assert.equal(currentForm!.getAttribute('aria-busy'), 'true');
    assert.equal(host.querySelector<HTMLButtonElement>('[data-question-action="submit"]')!.disabled, true);
    pending.reject(new Error('计划提交失败')); await settle();
    assert.equal(host.querySelector('form'), currentForm);
    assert.equal(currentForm!.getAttribute('aria-busy'), 'false');
    assert.equal(host.querySelector<HTMLButtonElement>('[data-question-action="submit"]')!.disabled, false);
    assert.equal(host.querySelector<HTMLInputElement>('input[value="a"]')!.checked, true);
    assert.equal(host.querySelector('[role="alert"]')!.textContent, '计划提交失败');
});

test('a clarification in a background session updates its waiting badge without mounting in the current session', () => {
    const states = new Map(); const badges: unknown[][] = [];
    const apply = mainFunction('applyWorkState', {
        workStateBySession: states, workStateRevisions: new Map(), currentSessionId: 'session-a',
        setSessionRuntimeState: (...args: unknown[]) => badges.push(args), t: (key: string) => key,
    });
    const req = request('background', 'session-b');
    apply({ sessionId: req.sessionId, mode: 'normal', pendingUserInput: req });
    assert.equal(states.get('session-b').mode, 'normal');
    assert.equal(badges.length, 1); assert.deepEqual(badges[0].slice(0, 2), ['session-b', 'waiting_input']);
});

test('chat.start for clarification resumes from persisted answers without synthesizing a queued user bubble', () => {
    const messages: unknown[] = []; const refreshed: string[] = []; const started: unknown[] = [];
    const handle = mainFunction('handleFollowUpGatewayMessage', {
        currentSessionId: 'session-a', pendingFollowUpSubmissions: new Map(), renderedFollowUpSubmissionIds: new Set(),
        followUpController: { observeTurnStarted: (identity: unknown) => started.push(identity) },
        addMessage: (message: unknown) => messages.push(message), rememberRenderedSubmission: () => {}, showTyping: () => {},
        refreshUserInputSession: (sessionId: string) => { refreshed.push(sessionId); },
        loadingSessions: new Set(), chatTargetSessionIds: new Set(), setSessionRuntimeState: () => {}, t: (key: string) => key,
    });
    handle({ type: 'chat.start', payload: { sessionId: 'session-a', turnId: 'user-input:request-a:continue', submissionId: 'continuation', userInputRequestId: 'request-a', input: 'A saved answer' } });
    assert.equal(started.length, 1); assert.equal(messages.length, 0); assert.deepEqual(refreshed, ['session-a']);
    handle({ type: 'chat.start', payload: { sessionId: 'session-a', turnId: 'ordinary-queue', submissionId: 'ordinary', input: 'A queued task' } });
    assert.equal(messages.length, 1);
});

test('ordinary composer sends queue while clarification is pending, even if no turn is currently active', () => {
    const getDelivery = mainFunction('getRequestedDelivery', {
        currentSessionId: 'session-a', workStateBySession: new Map([['session-a', { mode: 'normal', pendingUserInput: request() }]]),
        goalOwnsSession: () => false, isSessionFollowUpRunning: () => false,
    });
    assert.equal(getDelivery(), 'queue');
});
