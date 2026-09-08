import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import { SchedulerPage, type SchedulerPageOptions } from '../../src/scheduler/view';
import type { ScheduledTaskView, SchedulerTaskInput, SchedulerTaskPatch, TaskRunView } from '../../src/gateway-client';

const readKey = 'openflux-scheduler-read-v1';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

function task(id: string, patch: Partial<ScheduledTaskView> = {}): ScheduledTaskView {
    return {
        id, name: `Task ${id}`, trigger: { type: 'cron', expression: '0 9 * * 1-5' },
        target: { type: 'agent', prompt: `Instructions for ${id}` },
        status: 'active', createdAt: 1, runCount: 0, failCount: 0, ...patch,
    };
}

function run(taskId: string, output: string): TaskRunView {
    return { id: `run-${taskId}`, taskId, taskName: `Task ${taskId}`, status: 'completed', startedAt: 100, output };
}

function setup(t: TestContext, initial: ScheduledTaskView[], read: Record<string, number> = {}) {
    const dom = new JSDOM('<main id="scheduler"></main>', { url: 'http://localhost/' });
    const globals = ['window', 'document', 'localStorage'] as const;
    const previous = globals.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
    globals.forEach(key => Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] }));
    t.after(() => {
        dom.window.close();
        globals.forEach((key, index) => {
            const descriptor = previous[index];
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        });
    });
    dom.window.localStorage.setItem(readKey, JSON.stringify(read));
    let tasks = structuredClone(initial);
    const creates: SchedulerTaskInput[] = [];
    const updates: Array<{ id: string; patch: SchedulerTaskPatch }> = [];
    const actions: Array<[string, string]> = [];
    const selections: Array<string | null> = [];
    const notifications: string[] = [];
    const confirmations: string[] = [];
    const chats: Array<[string | undefined, string | undefined, TaskRunView | undefined]> = [];
    let sessions = [
        { id: 'session-a', title: 'Research notes', agentId: 'agent-a' },
        { id: 'session-b', title: 'Project Alpha notes', agentId: 'project-b' },
    ];
    let currentSessionId: string | undefined = 'session-a';
    let allowDelete = true;
    const api: NonNullable<ReturnType<SchedulerPageOptions['api']>> = {
        getSchedulerTasks: async () => structuredClone(tasks),
        getSchedulerRuns: async () => [],
        createSchedulerTask: async input => {
            creates.push(structuredClone(input));
            const saved = task('created', {
                ...input,
                agentId: sessions.find(session => session.id === input.sessionId)?.agentId,
            });
            tasks.push(saved);
            return structuredClone(saved);
        },
        updateSchedulerTask: async (id, patch) => {
            updates.push({ id, patch: structuredClone(patch) });
            const current = tasks.find(item => item.id === id)!;
            Object.assign(current, patch);
            if (typeof patch.sessionId === 'string') {
                current.agentId = sessions.find(session => session.id === patch.sessionId)?.agentId;
            }
            if (patch.agentId === null) delete current.agentId;
            if (patch.sessionId === null) delete current.sessionId;
            return structuredClone(current);
        },
        pauseSchedulerTask: async id => {
            actions.push(['pause', id]); tasks.find(item => item.id === id)!.status = 'paused'; return true;
        },
        resumeSchedulerTask: async id => {
            actions.push(['resume', id]); tasks.find(item => item.id === id)!.status = 'active'; return true;
        },
        deleteSchedulerTask: async id => {
            actions.push(['delete', id]); tasks = tasks.filter(item => item.id !== id); return true;
        },
        triggerSchedulerTask: async id => {
            actions.push(['trigger', id]); return { accepted: true, runId: `run-${id}`, sessionId: `session-${id}` };
        },
    };
    const options: SchedulerPageOptions = {
        api: () => api,
        sessions: async () => structuredClone(sessions),
        currentSessionId: () => currentSessionId,
        locale: () => 'en', onTasks: () => {}, onSelect: id => { selections.push(id); },
        openChat: async (sessionId, agentId, selectedRun) => { chats.push([sessionId, agentId, selectedRun]); },
        createInChat: () => {}, confirm: async message => { confirmations.push(message); return allowDelete; },
        notify: message => { notifications.push(message); },
    };
    const root = dom.window.document.querySelector<HTMLElement>('#scheduler')!;
    const page = new SchedulerPage(root, options);
    function element<T extends Element = HTMLElement>(selector: string): T {
        const found = root.querySelector<T>(selector);
        assert.ok(found, `Missing visible control: ${selector}`);
        return found;
    }
    function click(selector: string) {
        const button = element<HTMLButtonElement>(selector);
        assert.equal(button.disabled, false, `Control is disabled: ${selector}`);
        assert.equal(button.closest('[hidden]'), null, `Control is hidden: ${selector}`);
        button.click();
    }
    function input(selector: string, value: string) {
        const control = element<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(selector);
        control.value = value;
        control.dispatchEvent(new dom.window.Event(control.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    }
    function menu(id: string, action: string) {
        click(`[data-task-id="${id}"] .sched-task-menu-button`);
        click(`[role="menu"] [data-action="${action}"]`);
    }
    const names = () => Array.from(root.querySelectorAll('.sched-task-name'), el => el.textContent);
    const select = (id: string) => click(`[data-task-id="${id}"] .sched-task-open`);
    return {
        dom, root, page, options, api, creates, updates, actions, selections, notifications, confirmations, chats,
        element, click, input, menu, names, select,
        allowDelete: (value: boolean) => { allowDelete = value; },
        replaceTasks: (value: ScheduledTaskView[]) => { tasks = structuredClone(value); },
        replaceSessions: (value: typeof sessions) => { sessions = structuredClone(value); },
        setCurrentSession: (value: string | undefined) => { currentSessionId = value; },
    };
}

test('search and status filters combine, including instructions and workflow names', async t => {
    const h = setup(t, [
        task('a', { name: 'Daily research', target: { type: 'agent', prompt: 'Check solar news' } }),
        task('b', { name: 'Evening research', status: 'paused' }),
        task('c', { name: 'Finished export', status: 'completed', target: { type: 'workflow', workflowId: 'solar-report' } }),
    ]);
    await h.page.refresh();
    h.input('input[type="search"]', ' SOLAR ');
    assert.deepEqual(h.names(), ['Daily research', 'Finished export']);
    h.click('[data-filter="completed"]');
    assert.deepEqual(h.names(), ['Finished export']);
    h.click('[data-filter="paused"]');
    assert.match(h.element('.sched-task-list').textContent!, /No matching tasks/);
    h.input('input[type="search"]', 'research');
    assert.deepEqual(h.names(), ['Evening research']);
    h.click('[data-filter="active"]');
    assert.deepEqual(h.names(), ['Daily research']);
});

test('selection survives refreshing and switching tasks; closing details keeps the task list', async t => {
    const h = setup(t, [task('a'), task('b')]);
    await h.page.refresh();
    h.select('a');
    h.replaceTasks([task('a', { name: 'Updated task' }), task('b')]);
    await h.page.refresh();
    assert.equal(h.element<HTMLInputElement>('.sched-detail-title').value, 'Updated task');
    assert.equal(h.element('[data-task-id="a"] .sched-task-open').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(h.names(), ['Updated task', 'Task b']);
    h.select('b');
    assert.equal(h.element<HTMLInputElement>('.sched-detail-title').value, 'Task b');
    assert.equal(h.root.querySelectorAll('.sched-task-open[aria-pressed="true"]').length, 1);
    h.click('.sched-detail-controls [data-action="close-detail"]');
    assert.equal(h.element<HTMLElement>('.sched-detail-pane').hidden, true);
    assert.equal(h.root.querySelectorAll('.sched-task-open[aria-pressed="true"]').length, 0);
    assert.equal(h.selections.at(-1), null);
    assert.deepEqual(h.names(), ['Updated task', 'Task b']);
    await tick();
});

test('opening results and marking all read persist without hiding later unseen runs', async t => {
    const h = setup(t, [task('a', { lastRunAt: 100 }), task('b', { lastRunAt: 200 })], { a: 100 });
    await h.page.refresh();
    assert.equal(h.root.querySelectorAll('.is-unread').length, 1);
    h.select('b');
    assert.equal(h.root.querySelectorAll('.is-unread').length, 0);
    assert.deepEqual(JSON.parse(h.dom.window.localStorage.getItem(readKey)!), { a: 100, b: 200 });
    h.page.showList();
    h.replaceTasks([task('a', { lastRunAt: 300 }), task('b', { lastRunAt: 200 })]);
    await h.page.refresh();
    assert.equal(h.root.querySelectorAll('.is-unread').length, 1);
    h.click('[data-action="mark-read"]');
    assert.deepEqual(JSON.parse(h.dom.window.localStorage.getItem(readKey)!), { a: 300, b: 200 });
    h.page.hide();
    const remounted = new SchedulerPage(h.root, h.options);
    await remounted.refresh();
    assert.equal(h.root.querySelectorAll('.is-unread').length, 0);
});

test('background refresh after leaving the page keeps newer results unread', async t => {
    const h = setup(t, [task('a', { lastRunAt: 100 })]);
    await h.page.refresh();
    h.select('a');
    assert.deepEqual(JSON.parse(h.dom.window.localStorage.getItem(readKey)!), { a: 100 });
    h.root.classList.add('hidden');
    h.page.hide();
    h.replaceTasks([task('a', { lastRunAt: 200 })]);
    h.page.onEvent({ type: 'run_complete', taskId: 'a' });
    await h.page.refresh();
    assert.deepEqual(JSON.parse(h.dom.window.localStorage.getItem(readKey)!), { a: 100 });
    h.root.classList.remove('hidden');
    h.page.showList();
    assert.equal(h.root.querySelectorAll('[data-task-id="a"] .is-unread').length, 1);
    h.select('a');
    assert.equal(h.root.querySelectorAll('.is-unread').length, 0);
    assert.deepEqual(JSON.parse(h.dom.window.localStorage.getItem(readKey)!), { a: 200 });
    await tick();
});

test('history rows open the exact run in chat, including message anchors and legacy timestamps', async t => {
    const h = setup(t, [task('a', { agentId: 'agent-a', sessionId: 'session-a' })]);
    h.replaceSessions([
        { id: 'session-a', title: 'Current task conversation', agentId: 'agent-a' },
        { id: 'latest-run-chat', title: 'Earlier run conversation', agentId: 'project-b' },
    ]);
    const latest: TaskRunView = {
        ...run('a', 'Newest report'), sessionId: 'latest-run-chat', messageId: 'assistant-message-a',
    };
    const older: TaskRunView = {
        ...run('a', 'An older report'), id: 'older-run-a', sessionId: 'older-run-chat', startedAt: 50,
    };
    h.api.getSchedulerRuns = async () => [latest, older];
    await h.page.refresh();
    h.select('a');
    await tick();
    assert.equal(h.root.querySelector('.sched-history details'), null);
    assert.equal(h.root.querySelector('.sched-history .sched-run-output'), null);
    h.click('button[data-action="open-run"][data-run-id="run-a"]');
    await tick();
    assert.deepEqual(h.chats, [['latest-run-chat', 'project-b', latest]]);
    assert.equal(h.chats[0][2]?.messageId, 'assistant-message-a');

    h.replaceTasks([task('a', { name: 'Updated schedule name', agentId: 'agent-a', sessionId: 'session-a' })]);
    await h.page.refresh();
    assert.equal(h.element<HTMLInputElement>('.sched-detail-title').value, 'Updated schedule name');
    h.click('button[data-action="open-run"][data-run-id="older-run-a"]');
    await tick();
    assert.deepEqual(h.chats[1], ['older-run-chat', undefined, older]);
    assert.equal(h.chats[1][2]?.messageId, undefined);
    assert.equal(h.chats[1][2]?.startedAt, 50);
});

test('late history from a previous task never replaces the selected task history or chat', async t => {
    const h = setup(t, [task('a'), task('b', { agentId: 'project-b' })]);
    const first = deferred<TaskRunView[]>();
    const second = deferred<TaskRunView[]>();
    h.api.getSchedulerRuns = id => id === 'a' ? first.promise : second.promise;
    await h.page.refresh();
    h.select('a');
    h.select('b');
    second.resolve([{ ...run('b', 'Result for B'), sessionId: 'chat-b' }]);
    await tick();
    first.resolve([{ ...run('a', 'Result for A'), sessionId: 'chat-a' }]);
    await tick();
    assert.equal(h.element<HTMLInputElement>('.sched-detail-title').value, 'Task b');
    assert.ok(h.root.querySelector('.sched-history [data-run-id="run-b"]'));
    assert.equal(h.root.querySelector('.sched-history [data-run-id="run-a"]'), null);
    h.click('.sched-open-chat');
    assert.deepEqual(h.chats, [['chat-b', 'project-b', undefined]]);
});

test('creating through the form defaults to the current conversation and sends the chosen session without agentId', async t => {
    const h = setup(t, []);
    await h.page.refresh();
    h.click('[data-action="create-menu"]');
    h.click('[role="menu"] [data-action="create"]');
    await tick();
    assert.equal(h.element<HTMLSelectElement>('[name="sessionId"]').value, 'session-a');
    h.input('[name="name"]', '  Friday digest  ');
    h.input('[name="prompt"]', '  Summarize project progress  ');
    h.input('[name="sessionId"]', 'session-b');
    h.input('[name="preset"]', 'weekly');
    h.input('[name="weekday"]', '5');
    h.input('[name="time"]', '16:30');
    h.click('form [type="submit"]');
    await tick();
    assert.deepEqual(h.creates, [{
        name: 'Friday digest', trigger: { type: 'cron', expression: '30 16 * * 5' },
        target: { type: 'agent', prompt: 'Summarize project progress' }, sessionId: 'session-b',
    }]);
    assert.equal(h.root.querySelector('[role="dialog"]'), null);
    assert.equal(h.element<HTMLInputElement>('.sched-detail-title').value, 'Friday digest');
    assert.match(h.element('.sched-detail-pane').textContent!, /Project Alpha notes/);
    assert.equal(Object.hasOwn(h.creates[0], 'agentId'), false);
});

test('editing a bound task changes only sessionId and preserves its binding on a later rename', async t => {
    const h = setup(t, [task('a', { agentId: 'agent-a', sessionId: 'session-a' })]);
    await h.page.refresh();
    h.menu('a', 'edit');
    await tick();
    assert.equal(h.element<HTMLSelectElement>('[name="sessionId"]').value, 'session-a');
    h.input('[name="sessionId"]', 'session-b');
    h.input('[name="preset"]', 'interval');
    h.input('[name="interval"]', '15');
    h.input('[name="unit"]', '60000');
    h.click('form [type="submit"]');
    await tick();
    assert.deepEqual(h.updates[0], { id: 'a', patch: {
        name: 'Task a', trigger: { type: 'interval', intervalMs: 900000 },
        target: { type: 'agent', prompt: 'Instructions for a' }, sessionId: 'session-b',
    } });
    assert.match(h.element('.sched-detail-pane').textContent!, /Project Alpha notes/);
    h.menu('a', 'edit');
    await tick();
    assert.equal(h.element<HTMLSelectElement>('[name="sessionId"]').value, 'session-b');
    h.input('[name="name"]', 'Renamed without moving');
    h.click('form [type="submit"]');
    await tick();
    assert.equal(Object.hasOwn(h.updates[1].patch, 'agentId'), false);
    assert.equal(Object.hasOwn(h.updates[1].patch, 'sessionId'), false);
    h.click('.sched-open-chat');
    assert.deepEqual(h.chats, [['session-b', 'project-b', undefined]]);
});

test('new tasks cannot be saved without a concrete conversation', async t => {
    const h = setup(t, []);
    h.replaceSessions([]);
    h.setCurrentSession(undefined);
    await h.page.refresh();
    h.click('[data-action="create-menu"]');
    h.click('[role="menu"] [data-action="create"]');
    await tick();
    h.input('[name="name"]', 'Unbound task');
    h.input('[name="prompt"]', 'Do not create this without a conversation');
    assert.equal(h.element<HTMLSelectElement>('[name="sessionId"]').value, '');
    h.element<HTMLFormElement>('form').dispatchEvent(new h.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await tick();
    assert.deepEqual(h.creates, []);
    assert.ok(h.root.querySelector('[role="dialog"]'));
    assert.equal(h.element<HTMLElement>('form [role="alert"]').hidden, false);
});

test('legacy tasks without a conversation can keep that binding until their first run', async t => {
    const h = setup(t, [task('a', { agentId: 'legacy-agent' })]);
    await h.page.refresh();
    h.menu('a', 'edit');
    await tick();
    const session = h.element<HTMLSelectElement>('[name="sessionId"]');
    assert.equal(session.value, '');
    assert.match(session.selectedOptions[0].textContent!, /first run/i);
    h.input('[name="name"]', 'Legacy reminder renamed');
    h.click('form [type="submit"]');
    await tick();
    assert.equal(h.updates.length, 1);
    assert.equal(Object.hasOwn(h.updates[0].patch, 'sessionId'), false);
    assert.equal(Object.hasOwn(h.updates[0].patch, 'agentId'), false);
    assert.equal(h.element<HTMLInputElement>('.sched-detail-title').value, 'Legacy reminder renamed');
    assert.match(h.element('.sched-detail-pane').textContent!, /first run/i);
});

test('editing a workflow keeps its workflow parameters and unchanged bindings', async t => {
    const target = { type: 'workflow' as const, workflowId: 'report-flow', params: { region: 'APAC', count: 12 } };
    const h = setup(t, [task('a', { target, agentId: 'legacy-agent', sessionId: 'workflow-chat' })]);
    await h.page.refresh();
    h.menu('a', 'edit');
    await tick();
    assert.equal(h.root.querySelector('[name="prompt"]'), null);
    assert.equal(h.element<HTMLSelectElement>('[name="sessionId"]').value, 'workflow-chat');
    h.input('[name="name"]', 'Renamed workflow');
    h.click('form [type="submit"]');
    await tick();
    assert.deepEqual(h.updates[0].patch.target, target);
    assert.equal(Object.hasOwn(h.updates[0].patch, 'agentId'), false);
    assert.equal(Object.hasOwn(h.updates[0].patch, 'sessionId'), false);
    h.click('.sched-open-chat');
    assert.deepEqual(h.chats, [['workflow-chat', 'legacy-agent', undefined]]);
});

test('renaming an already completed one-off task does not reschedule it or reject its past date', async t => {
    const trigger = { type: 'once' as const, runAt: '2020-01-02T03:04:56.789Z' };
    const h = setup(t, [task('a', { status: 'completed', trigger })]);
    await h.page.refresh();
    h.menu('a', 'edit');
    await tick();
    h.input('[name="name"]', 'Archived reminder');
    h.click('form [type="submit"]');
    await tick();
    assert.equal(h.updates.length, 1);
    assert.equal(Object.hasOwn(h.updates[0].patch, 'trigger'), false);
    assert.equal(h.root.querySelector('[role="dialog"]'), null);
    assert.equal(h.element<HTMLInputElement>('.sched-detail-title').value, 'Archived reminder');
    h.click('[data-filter="completed"]');
    assert.deepEqual(h.names(), ['Archived reminder']);
});

test('an invalid interval stays in the editor with an error and does not create a task', async t => {
    const h = setup(t, []);
    await h.page.refresh();
    h.click('[data-action="create-menu"]');
    h.click('[role="menu"] [data-action="create"]');
    await tick();
    h.input('[name="name"]', 'Monitor');
    h.input('[name="prompt"]', 'Check progress');
    h.input('[name="preset"]', 'interval');
    h.input('[name="unit"]', '1000');
    h.input('[name="interval"]', '9');
    h.click('form [type="submit"]');
    await tick();
    assert.equal(h.creates.length, 0);
    assert.equal(h.element<HTMLElement>('form [role="alert"]').hidden, false);
    assert.match(h.element('form [role="alert"]').textContent!, /10 seconds/);
    assert.equal(h.element<HTMLButtonElement>('form [type="submit"]').disabled, false);
});

test('canceling creation or editing sends no write request', async t => {
    const h = setup(t, [task('a')]);
    await h.page.refresh();
    h.click('[data-action="create-menu"]');
    h.click('[role="menu"] [data-action="create"]');
    await tick();
    h.input('[name="name"]', 'Do not save');
    h.click('.sched-editor-footer [data-dismiss]');
    h.menu('a', 'edit');
    await tick();
    h.input('[name="name"]', 'Discarded rename');
    h.dom.window.document.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();
    assert.equal(h.root.querySelector('[role="dialog"]'), null);
    assert.deepEqual(h.creates, []);
    assert.deepEqual(h.updates, []);
    assert.deepEqual(h.names(), ['Task a']);
});

test('action-menu pause/resume/delete use the selected task and respect declined deletion', async t => {
    const h = setup(t, [task('a'), task('b')]);
    await h.page.refresh();
    h.select('a');
    h.menu('b', 'pause');
    await tick();
    h.click('[data-filter="paused"]');
    assert.deepEqual(h.names(), ['Task b']);
    h.menu('b', 'resume');
    await tick();
    assert.deepEqual(h.names(), []);
    h.click('[data-filter="all"]');
    h.allowDelete(false);
    h.menu('b', 'delete');
    await tick();
    assert.deepEqual(h.names(), ['Task a', 'Task b']);
    assert.deepEqual(h.actions, [['pause', 'b'], ['resume', 'b']]);
    h.allowDelete(true);
    h.menu('b', 'delete');
    await tick();
    assert.deepEqual(h.actions, [['pause', 'b'], ['resume', 'b'], ['delete', 'b']]);
    assert.deepEqual(h.names(), ['Task a']);
    assert.equal(h.confirmations.length, 2);
    assert.equal(h.element<HTMLInputElement>('.sched-detail-title').value, 'Task a');
});

test('run-now acknowledges acceptance before background refresh or execution finishes', async t => {
    const h = setup(t, [task('a')]);
    await h.page.refresh();
    const accepted = deferred<{ accepted: true; runId: string; sessionId: string }>();
    const refresh = deferred<ScheduledTaskView[]>();
    h.api.triggerSchedulerTask = id => { h.actions.push(['trigger', id]); return accepted.promise; };
    h.api.getSchedulerTasks = () => refresh.promise;
    h.menu('a', 'trigger');
    assert.deepEqual(h.actions, [['trigger', 'a']]);
    assert.equal(h.notifications.length, 0);
    accepted.resolve({ accepted: true, runId: 'run-a', sessionId: 'session-a' });
    await tick();
    assert.equal(h.notifications.length, 1, 'acceptance must be visible without waiting for the long-running task');
    assert.match(h.notifications[0], /started|accepted|queued/i);
    refresh.resolve([task('a')]);
    await tick();
});

test('run-now stays available for paused tasks and completed one-time tasks', async t => {
    const h = setup(t, [
        task('paused', { status: 'paused', nextRunAt: 123_456 }),
        task('once', { status: 'completed', trigger: { type: 'once', runAt: 100 } }),
        task('legacy-completed', { status: 'completed' }),
    ]);
    await h.page.refresh();

    h.menu('paused', 'trigger');
    await tick();
    h.menu('once', 'trigger');
    await tick();
    assert.deepEqual(h.actions, [['trigger', 'paused'], ['trigger', 'once']]);

    h.click('[data-task-id="legacy-completed"] .sched-task-menu-button');
    assert.equal(h.element<HTMLButtonElement>('[role="menu"] [data-action="trigger"]').disabled, true);
});

test('inline content editing saves only changed fields and hides Save after success', async t => {
    const h = setup(t, [task('a', { agentId: 'agent-a', sessionId: 'session-a' })]);
    await h.page.refresh();
    h.select('a');
    await tick();
    assert.equal(h.element<HTMLButtonElement>('[data-action="save-content"]').hidden, true);
    h.input('input.sched-detail-title', 'Daily briefing');
    assert.equal(h.element<HTMLButtonElement>('[data-action="save-content"]').hidden, false);
    assert.deepEqual(h.updates, [], 'typing alone must not send a mutation');
    h.click('[data-action="save-content"]');
    await tick();
    assert.deepEqual(h.updates, [{ id: 'a', patch: { name: 'Daily briefing' } }]);
    assert.deepEqual(h.names(), ['Daily briefing']);
    assert.equal(h.element<HTMLInputElement>('.sched-detail-title').value, 'Daily briefing');
    assert.equal(h.element<HTMLButtonElement>('[data-action="save-content"]').hidden, true);

    h.input('textarea.sched-prompt', 'Summarize progress and list sources.');
    h.click('[data-action="save-content"]');
    await tick();
    assert.deepEqual(h.updates[1], { id: 'a', patch: { target: { type: 'agent', prompt: 'Summarize progress and list sources.' } } });
    assert.equal(h.element<HTMLTextAreaElement>('.sched-prompt').value, 'Summarize progress and list sources.');
    assert.equal(h.element<HTMLButtonElement>('[data-action="save-content"]').hidden, true);
});

test('restoring original inline values removes the unsaved change without sending a request', async t => {
    const h = setup(t, [task('a')]);
    await h.page.refresh();
    h.select('a');
    await tick();
    h.input('input.sched-detail-title', 'Temporary name');
    h.input('textarea.sched-prompt', 'Temporary instructions');
    h.input('input.sched-detail-title', 'Task a');
    assert.equal(h.element<HTMLButtonElement>('[data-action="save-content"]').hidden, false);
    h.input('textarea.sched-prompt', 'Instructions for a');
    assert.equal(h.element<HTMLButtonElement>('[data-action="save-content"]').hidden, true);
    assert.deepEqual(h.updates, []);
});

test('inline drafts belong to their task and survive switching tasks and background refresh', async t => {
    const h = setup(t, [task('a'), task('b')]);
    await h.page.refresh();
    h.select('a');
    await tick();
    h.input('input.sched-detail-title', 'Unsaved A title');
    h.input('textarea.sched-prompt', 'Unsaved A instructions');
    h.select('b');
    await tick();
    assert.equal(h.element<HTMLInputElement>('.sched-detail-title').value, 'Task b');
    assert.equal(h.element<HTMLTextAreaElement>('.sched-prompt').value, 'Instructions for b');
    assert.equal(h.element<HTMLButtonElement>('[data-action="save-content"]').hidden, true);
    h.input('textarea.sched-prompt', 'Unsaved B instructions');
    h.replaceTasks([task('a', { lastRunAt: 200 }), task('b', { status: 'paused' })]);
    await h.page.refresh();
    assert.equal(h.element<HTMLTextAreaElement>('.sched-prompt').value, 'Unsaved B instructions');
    h.select('a');
    await tick();
    assert.equal(h.element<HTMLInputElement>('.sched-detail-title').value, 'Unsaved A title');
    assert.equal(h.element<HTMLTextAreaElement>('.sched-prompt').value, 'Unsaved A instructions');
    assert.equal(h.element<HTMLButtonElement>('[data-action="save-content"]').hidden, false);
    assert.deepEqual(h.updates, []);
});

test('failed inline saves keep the draft and show an error so the user can retry', async t => {
    const h = setup(t, [task('a')]);
    await h.page.refresh();
    h.select('a');
    await tick();
    const update = h.api.updateSchedulerTask;
    let attempts = 0;
    h.api.updateSchedulerTask = async (id, patch) => {
        attempts++;
        if (attempts === 1) throw new Error('Storage unavailable');
        return update(id, patch);
    };
    h.input('input.sched-detail-title', 'Keep this draft');
    h.click('[data-action="save-content"]');
    await tick();
    assert.equal(h.element<HTMLInputElement>('.sched-detail-title').value, 'Keep this draft');
    assert.equal(h.element<HTMLButtonElement>('[data-action="save-content"]').hidden, false);
    assert.equal(h.element<HTMLButtonElement>('[data-action="save-content"]').disabled, false);
    assert.equal(h.element<HTMLElement>('.sched-detail-error').hidden, false);
    assert.match(h.element('.sched-detail-error').textContent!, /Storage unavailable/);
    h.click('[data-action="save-content"]');
    await tick();
    assert.equal(attempts, 2);
    assert.deepEqual(h.names(), ['Keep this draft']);
    assert.equal(h.element<HTMLButtonElement>('[data-action="save-content"]').hidden, true);
});

test('a pending inline save rejects duplicate clicks and preserves changes typed before its acknowledgement', async t => {
    const h = setup(t, [task('a')]);
    await h.page.refresh();
    h.select('a');
    await tick();
    const pending = deferred<void>();
    const update = h.api.updateSchedulerTask;
    const attempts: SchedulerTaskPatch[] = [];
    h.api.updateSchedulerTask = async (id, patch) => {
        attempts.push(structuredClone(patch));
        await pending.promise;
        return update(id, patch);
    };
    h.input('input.sched-detail-title', 'First saved version');
    h.click('[data-action="save-content"]');
    const button = h.element<HTMLButtonElement>('[data-action="save-content"]');
    assert.equal(button.disabled, true);
    button.click();
    assert.equal(attempts.length, 1);
    assert.equal(h.element<HTMLInputElement>('.sched-detail-title').disabled, false);
    h.input('input.sched-detail-title', 'Newer unsaved version');
    h.input('textarea.sched-prompt', 'New instructions typed while saving');
    pending.resolve();
    await tick();
    assert.deepEqual(attempts, [{ name: 'First saved version' }]);
    assert.equal(h.element<HTMLInputElement>('.sched-detail-title').value, 'Newer unsaved version');
    assert.equal(h.element<HTMLTextAreaElement>('.sched-prompt').value, 'New instructions typed while saving');
    assert.equal(h.element<HTMLButtonElement>('[data-action="save-content"]').hidden, false);
    assert.equal(h.element<HTMLButtonElement>('[data-action="save-content"]').disabled, false);
    h.click('[data-action="save-content"]');
    await tick();
    assert.deepEqual(h.updates[1], { id: 'a', patch: {
        name: 'Newer unsaved version', target: { type: 'agent', prompt: 'New instructions typed while saving' },
    } });
    assert.equal(h.element<HTMLButtonElement>('[data-action="save-content"]').hidden, true);
});

test('an inline save completing after task navigation does not replace the other task draft', async t => {
    const h = setup(t, [task('a'), task('b')]);
    await h.page.refresh();
    h.select('a');
    await tick();
    const pending = deferred<void>();
    const update = h.api.updateSchedulerTask;
    h.api.updateSchedulerTask = async (id, patch) => { await pending.promise; return update(id, patch); };
    h.input('input.sched-detail-title', 'Saved A title');
    h.click('[data-action="save-content"]');
    h.select('b');
    await tick();
    h.input('input.sched-detail-title', 'Unsaved B title');
    pending.resolve();
    await tick();
    assert.equal(h.element<HTMLInputElement>('.sched-detail-title').value, 'Unsaved B title');
    assert.equal(h.element<HTMLTextAreaElement>('.sched-prompt').value, 'Instructions for b');
    assert.equal(h.element<HTMLButtonElement>('[data-action="save-content"]').hidden, false);
    assert.equal(h.selections.at(-1), 'b');
    assert.deepEqual(h.updates, [{ id: 'a', patch: { name: 'Saved A title' } }]);
});

test('inline workflow renaming leaves its workflow target and parameters untouched', async t => {
    const target = { type: 'workflow' as const, workflowId: 'report-flow', params: { region: 'APAC', count: 12 } };
    const h = setup(t, [task('a', { target })]);
    await h.page.refresh();
    h.select('a');
    await tick();
    const prompt = h.root.querySelector<HTMLTextAreaElement>('textarea.sched-prompt');
    assert.ok(!prompt || prompt.readOnly || prompt.disabled, 'workflow instructions must not become an editable agent prompt');
    h.input('input.sched-detail-title', 'Quarterly workflow');
    h.click('[data-action="save-content"]');
    await tick();
    assert.deepEqual(h.updates, [{ id: 'a', patch: { name: 'Quarterly workflow' } }]);
    const saved = (await h.api.getSchedulerTasks())[0];
    assert.deepEqual(saved.target, target);
    assert.equal(h.element<HTMLButtonElement>('[data-action="save-content"]').hidden, true);
});

test('the conversation field searches existing chats and saves only the selected session', async t => {
    const h = setup(t, [task('a', { agentId: 'agent-a', sessionId: 'session-a' })]);
    await h.page.refresh();
    h.select('a');
    await tick();
    h.input('input.sched-detail-title', 'Unsaved title');
    h.input('textarea.sched-prompt', 'Unsaved instructions');
    h.click('[data-action="edit-session"]');
    await tick();
    assert.ok(h.root.querySelector('.sched-field-popover[data-field="session"]'));
    assert.equal(h.root.querySelector('.sched-editor-backdrop'), null);
    h.input('input.sched-session-search', ' ALPHA ');
    const options = Array.from(h.root.querySelectorAll<HTMLElement>('.sched-session-option'), option => option.dataset.sessionId);
    assert.deepEqual(options, ['session-b']);
    h.click('.sched-session-option[data-session-id="session-b"]');
    await tick();
    assert.deepEqual(h.updates, [{ id: 'a', patch: { sessionId: 'session-b' } }]);
    assert.equal(h.root.querySelector('.sched-field-popover'), null);
    assert.match(h.element('[data-action="edit-session"]').textContent!, /Project Alpha notes/);
    assert.equal(h.element<HTMLInputElement>('.sched-detail-title').value, 'Unsaved title');
    assert.equal(h.element<HTMLTextAreaElement>('.sched-prompt').value, 'Unsaved instructions');
    assert.equal(h.element<HTMLButtonElement>('[data-action="save-content"]').hidden, false);
});

test('choosing the already bound conversation closes its field popup without writing', async t => {
    const h = setup(t, [task('a', { agentId: 'agent-a', sessionId: 'session-a' })]);
    await h.page.refresh();
    h.select('a');
    await tick();
    h.click('[data-action="edit-session"]');
    await tick();
    h.click('.sched-session-option[data-session-id="session-a"]');
    await tick();
    assert.deepEqual(h.updates, []);
    assert.equal(h.root.querySelector('.sched-field-popover'), null);
});

test('the frequency field saves only its trigger and keeps inline content drafts', async t => {
    const h = setup(t, [task('a', { sessionId: 'session-a' })]);
    await h.page.refresh();
    h.select('a');
    await tick();
    h.input('input.sched-detail-title', 'Unpublished name');
    h.input('textarea.sched-prompt', 'Unpublished instructions');
    h.click('[data-action="edit-frequency"]');
    await tick();
    const popover = h.element('.sched-field-popover[data-field="frequency"]');
    assert.equal(h.root.querySelector('.sched-editor-backdrop'), null);
    assert.equal(popover.querySelector('[name="name"], [name="prompt"], [name="sessionId"]'), null);
    h.input('.sched-field-popover [name="preset"]', 'weekly');
    h.input('.sched-field-popover [name="time"]', '17:45');
    h.input('.sched-field-popover [name="weekday"]', '5');
    h.click('.sched-field-popover [type="submit"]');
    await tick();
    assert.deepEqual(h.updates, [{ id: 'a', patch: { trigger: { type: 'cron', expression: '45 17 * * 5' } } }]);
    assert.equal(h.root.querySelector('.sched-field-popover'), null);
    assert.equal(h.element<HTMLInputElement>('.sched-detail-title').value, 'Unpublished name');
    assert.equal(h.element<HTMLTextAreaElement>('.sched-prompt').value, 'Unpublished instructions');
    assert.equal(h.element<HTMLButtonElement>('[data-action="save-content"]').hidden, false);
});

test('saving an unchanged expired one-off frequency does not reschedule the task', async t => {
    const trigger = { type: 'once' as const, runAt: '2020-02-03T04:05:06.789Z' };
    const h = setup(t, [task('a', { status: 'completed', trigger })]);
    await h.page.refresh();
    h.select('a');
    await tick();
    h.click('[data-action="edit-frequency"]');
    await tick();
    assert.equal(h.element<HTMLSelectElement>('.sched-field-popover [name="preset"]').value, 'once');
    h.click('.sched-field-popover [type="submit"]');
    await tick();
    assert.deepEqual(h.updates, []);
    assert.equal(h.root.querySelector('.sched-field-popover'), null);
    assert.deepEqual((await h.api.getSchedulerTasks())[0].trigger, trigger);
});

test('Cancel, Escape, clicking outside, and switching tasks dismiss independent field drafts without saving', async t => {
    const h = setup(t, [task('a'), task('b')]);
    await h.page.refresh();
    h.select('a');
    await tick();
    h.click('[data-action="edit-frequency"]');
    await tick();
    h.input('.sched-field-popover [name="time"]', '21:10');
    h.dom.window.document.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(h.root.querySelector('.sched-field-popover'), null);
    assert.equal(h.element<HTMLInputElement>('.sched-detail-title').value, 'Task a');

    h.click('[data-action="edit-frequency"]');
    await tick();
    h.input('.sched-field-popover [name="time"]', '19:40');
    h.click('.sched-field-footer [data-dismiss]');
    assert.equal(h.root.querySelector('.sched-field-popover'), null);

    h.click('[data-action="edit-session"]');
    await tick();
    h.input('.sched-session-search', 'Alpha');
    h.element('.sched-list-top').dispatchEvent(new h.dom.window.MouseEvent('pointerdown', { bubbles: true }));
    assert.equal(h.root.querySelector('.sched-field-popover'), null);

    h.click('[data-action="edit-frequency"]');
    await tick();
    h.input('.sched-field-popover [name="time"]', '23:20');
    h.select('b');
    await tick();
    assert.equal(h.root.querySelector('.sched-field-popover'), null);
    assert.equal(h.element<HTMLInputElement>('.sched-detail-title').value, 'Task b');
    assert.deepEqual(h.updates, []);
});

test('a rejected conversation change keeps its popup and error available for retry', async t => {
    const h = setup(t, [task('a', { sessionId: 'session-a' })]);
    await h.page.refresh();
    h.select('a');
    await tick();
    const update = h.api.updateSchedulerTask;
    let attempts = 0;
    h.api.updateSchedulerTask = async (id, patch) => {
        if (++attempts === 1) throw new Error('Conversation update unavailable');
        return update(id, patch);
    };
    h.click('[data-action="edit-session"]');
    await tick();
    h.click('.sched-session-option[data-session-id="session-b"]');
    await tick();
    assert.ok(h.root.querySelector('.sched-field-popover[data-field="session"]'));
    assert.equal(h.element<HTMLElement>('.sched-field-popover [role="alert"]').hidden, false);
    assert.match(h.element('.sched-field-popover [role="alert"]').textContent!, /Conversation update unavailable/);
    h.click('.sched-session-option[data-session-id="session-b"]');
    await tick();
    assert.equal(attempts, 2);
    assert.deepEqual(h.updates, [{ id: 'a', patch: { sessionId: 'session-b' } }]);
    assert.equal(h.root.querySelector('.sched-field-popover'), null);
});

test('a rejected frequency change retains its edited values and retries only the trigger patch', async t => {
    const h = setup(t, [task('a')]);
    await h.page.refresh();
    h.select('a');
    await tick();
    const update = h.api.updateSchedulerTask;
    let attempts = 0;
    h.api.updateSchedulerTask = async (id, patch) => {
        if (++attempts === 1) throw new Error('Schedule update unavailable');
        return update(id, patch);
    };
    h.click('[data-action="edit-frequency"]');
    await tick();
    h.input('.sched-field-popover [name="preset"]', 'interval');
    h.input('.sched-field-popover [name="interval"]', '30');
    h.input('.sched-field-popover [name="unit"]', '60000');
    h.click('.sched-field-popover [type="submit"]');
    await tick();
    assert.equal(h.element<HTMLInputElement>('.sched-field-popover [name="interval"]').value, '30');
    assert.equal(h.element<HTMLElement>('.sched-field-popover [role="alert"]').hidden, false);
    assert.match(h.element('.sched-field-popover [role="alert"]').textContent!, /Schedule update unavailable/);
    h.click('.sched-field-popover [type="submit"]');
    await tick();
    assert.equal(attempts, 2);
    assert.deepEqual(h.updates, [{ id: 'a', patch: { trigger: { type: 'interval', intervalMs: 1800000 } } }]);
    assert.equal(h.root.querySelector('.sched-field-popover'), null);
});

test('legacy history without a session remains clickable and never borrows the task current binding', async t => {
    const h = setup(t, [task('a', { sessionId: 'session-a', agentId: 'agent-a' })]);
    const legacy: TaskRunView = {
        ...run('a', 'Saved legacy output'), id: 'legacy-no-session', status: 'failed',
        error: 'Original service failed', startedAt: 123, completedAt: 456,
    };
    h.api.getSchedulerRuns = async () => [legacy];
    await h.page.refresh();
    h.select('a');
    await tick();
    h.click('.sched-history-link[data-run-id="legacy-no-session"]');
    await tick();
    assert.deepEqual(h.chats, [[undefined, undefined, legacy]]);

    h.replaceTasks([task('a', { sessionId: 'session-b', agentId: 'project-b' })]);
    await h.page.refresh();
    h.click('.sched-history-link[data-run-id="legacy-no-session"]');
    await tick();
    assert.deepEqual(h.chats[1], [undefined, undefined, legacy]);
    assert.equal(h.chats[1][2]?.startedAt, 123);
    assert.equal(h.chats[1][2]?.error, 'Original service failed');
});

test('history navigation failures stay visible in task details instead of silently disabling the row', async t => {
    const h = setup(t, [task('a')]);
    const legacy = run('a', 'Saved report');
    h.api.getSchedulerRuns = async () => [legacy];
    h.options.openChat = async () => { throw new Error('Cannot load this run conversation'); };
    await h.page.refresh();
    h.select('a');
    await tick();
    h.click('.sched-history-link[data-run-id="run-a"]');
    await tick();
    assert.equal(h.element<HTMLElement>('.sched-detail-pane').hidden, false);
    assert.equal(h.element<HTMLInputElement>('.sched-detail-title').value, 'Task a');
    assert.equal(h.element<HTMLElement>('.sched-detail-error').hidden, false);
    assert.match(h.element('.sched-detail-error').textContent!, /Cannot load this run conversation/);
    assert.equal(h.element<HTMLButtonElement>('.sched-history-link[data-run-id="run-a"]').disabled, false);
});

test('saved-run fallback escapes output and errors, is read-only, and closes back to the task draft', async t => {
    const h = setup(t, [task('a')]);
    await h.page.refresh();
    h.select('a');
    await tick();
    h.input('input.sched-detail-title', 'Unsaved detail title');
    h.input('textarea.sched-prompt', 'Unsaved detail instructions');
    const output = '<img src=x onerror="window.pwned=true"> **Saved report** <script>window.pwned=true</script>';
    const error = '<svg onload="window.pwned=true"> & unavailable';
    h.page.showRunResult({ ...run('a', output), status: 'failed', error });
    const fallback = h.element('.sched-editor-backdrop .sched-run-fallback');
    assert.ok(fallback.textContent!.includes(output));
    assert.ok(fallback.textContent!.includes(error));
    assert.equal(fallback.querySelector('script, img, svg[onload], [onerror]'), null);
    assert.equal(fallback.querySelector('input:not([readonly]):not([disabled]), textarea:not([readonly]):not([disabled]), [contenteditable="true"]'), null);
    assert.equal(fallback.querySelector('[type="submit"], [data-action="save-content"]'), null);
    assert.match(fallback.textContent!, /conversation.*not|could not.*conversation|conversation.*unavailable/i);
    h.click('.sched-run-fallback [data-dismiss]');
    assert.equal(h.root.querySelector('.sched-editor-backdrop'), null);
    assert.equal(h.element<HTMLElement>('.sched-detail-pane').hidden, false);
    assert.equal(h.element<HTMLInputElement>('.sched-detail-title').value, 'Unsaved detail title');
    assert.equal(h.element<HTMLTextAreaElement>('.sched-prompt').value, 'Unsaved detail instructions');
    assert.deepEqual(h.updates, []);
    assert.deepEqual(h.creates, []);
});

test('saved-run fallback explains when the historical run has no stored output or error', async t => {
    const h = setup(t, [task('a')]);
    await h.page.refresh();
    h.select('a');
    await tick();
    h.page.showRunResult({ ...run('a', ''), output: undefined, error: undefined });
    const fallback = h.element('.sched-editor-backdrop .sched-run-fallback');
    assert.match(fallback.textContent!, /no (saved |stored )?(output|result|content)|not.*saved|no.*available/i);
    assert.equal(fallback.querySelector('[type="submit"], [data-action="save-content"]'), null);
    h.dom.window.document.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(h.root.querySelector('.sched-editor-backdrop'), null);
    assert.equal(h.selections.at(-1), 'a');
});
