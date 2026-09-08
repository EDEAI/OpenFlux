import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import type { LocalEntityView, Session } from '../../src/gateway-client';
import { validateConversationOwnershipUpdate } from '../src/sessions/ownership';
import type { SessionMetadata } from '../src/sessions/types';
import {
    bindConversationOwnerPicker,
    NewConversationController,
    listConversationOwners,
    renderConversationOwnerSelect,
    resolveConversationOwner,
    resolveDefaultAssistant,
} from '../../src/sidebar/new-conversation';

const now = 1;
const entities: LocalEntityView[] = [
    { id: 'writer', kind: 'agent', name: 'Writer', createdAt: now, updatedAt: now },
    { id: 'project-a', kind: 'project', name: 'Alpha', createdAt: now, updatedAt: now },
    { id: 'main', kind: 'agent', name: 'OpenFlux Assistant', default: true, createdAt: now, updatedAt: now },
    { id: 'project-b', kind: 'project', name: 'Beta', createdAt: now, updatedAt: now },
];

function session(id: string, agentId: string): Session {
    return { id, agentId, createdAt: now, updatedAt: now, approvalMode: 'full_access' };
}

test('conversation ownership contains all projects and Agents with one default assistant', () => {
    assert.equal(resolveDefaultAssistant(entities).id, 'main');
    assert.deepEqual(listConversationOwners(entities), [
        { id: 'main', name: 'OpenFlux Assistant', kind: 'assistant' },
        { id: 'project-a', name: 'Alpha', kind: 'project' },
        { id: 'project-b', name: 'Beta', kind: 'project' },
        { id: 'writer', name: 'Writer', kind: 'agent' },
    ]);
    assert.equal(resolveConversationOwner(entities).id, 'main');
    assert.equal(resolveConversationOwner(entities, 'project-b').id, 'project-b');
    assert.equal(resolveConversationOwner(entities, 'writer').id, 'writer');
    assert.throws(() => resolveConversationOwner(entities, 'missing'), /selected conversation owner/i);
});

test('default assistant resolution is stable across renamed and legacy data', () => {
    assert.equal(resolveDefaultAssistant([
        { id: 'custom-default', name: 'Renamed', default: true, createdAt: now, updatedAt: now },
        { id: 'main', name: 'OpenFlux Assistant', createdAt: now, updatedAt: now },
    ]).id, 'custom-default');
    assert.equal(resolveDefaultAssistant([
        { id: 'main', name: 'Renamed', createdAt: now, updatedAt: now },
    ]).id, 'main');
    assert.throws(() => resolveDefaultAssistant([
        { id: 'project-a', kind: 'project', name: 'Alpha', createdAt: now, updatedAt: now },
    ]), /OpenFlux Assistant/);
});

test('gateway ownership validation accepts projects and Agents', () => {
    const metadata: SessionMetadata = {
        id: 'session-current',
        agentId: 'main',
        createdAt: now,
        updatedAt: now,
        messageCount: 0,
        status: 'active',
    };
    const owners = new Map([
        ['main', { id: 'main', kind: 'agent' as const }],
        ['writer', { id: 'writer', kind: 'agent' as const }],
        ['project-a', { id: 'project-a', kind: 'project' as const }],
    ]);
    const lookup = {
        getSession: (id: string) => id === metadata.id ? metadata : undefined,
        getOwner: (id: string) => owners.get(id),
    };

    assert.deepEqual(validateConversationOwnershipUpdate({
        sessionId: ' session-current ', ownerId: ' project-a ',
    }, lookup), { sessionId: 'session-current', ownerId: 'project-a' });
    assert.deepEqual(validateConversationOwnershipUpdate({
        sessionId: 'session-current', ownerId: 'main',
    }, lookup), { sessionId: 'session-current', ownerId: 'main' });
    assert.deepEqual(validateConversationOwnershipUpdate({
        sessionId: 'session-current', ownerId: 'writer',
    }, lookup), { sessionId: 'session-current', ownerId: 'writer' });
    assert.throws(() => validateConversationOwnershipUpdate({
        sessionId: 'session-with-content', ownerId: 'writer',
    }, {
        ...lookup,
        getSession: id => id === 'session-with-content' ? { ...metadata, id, messageCount: 1 } : undefined,
    }), /已有内容/);
    assert.throws(() => validateConversationOwnershipUpdate({
        sessionId: 'session-current', ownerId: 'writer',
    }, {
        ...lookup,
        hasPendingExecution: id => id === 'session-current',
    }), /已开始执行/);
    assert.throws(() => validateConversationOwnershipUpdate({
        sessionId: 'missing', ownerId: 'main',
    }, lookup), /不能更改归属/);
    assert.throws(() => validateConversationOwnershipUpdate({
        sessionId: 'session-current', ownerId: 'missing',
    }, lookup), /项目或 Agent/);
});

test('legacy session creation falls back to the visible default Assistant owner', () => {
    const source = readFileSync(new URL('../src/gateway/standalone.ts', import.meta.url), 'utf-8');
    assert.match(source, /const defaultAssistantId = userAgentStore\.list\(\)\.find\(agent => agent\.default\)\?\.id/);
    assert.match(source, /payload\?\.agentId && payload\.agentId !== 'default'[\s\S]*?sessions\.create\([\s\S]*?ownerId,/);
    assert.doesNotMatch(
        source.slice(source.indexOf('function handleSessionsCreate'), source.indexOf('function handleSessionApprovalModeUpdate')),
        /payload\?\.agentId \|\| 'default'/,
    );
});

test('moving a conversation also updates scheduled tasks bound to that conversation', () => {
    const source = readFileSync(new URL('../src/gateway/standalone.ts', import.meta.url), 'utf-8');
    const handler = source.slice(
        source.indexOf('function handleSessionOwnerUpdate'),
        source.indexOf('function handleSessionsRename'),
    );
    assert.match(handler, /for \(const task of scheduler\.listTasks\(\)\)/);
    assert.match(handler, /task\.sessionId === update\.sessionId/);
    assert.match(handler, /scheduler\.updateTask\(task\.id, \{ agentId: update\.ownerId \}\)/);
});

test('new conversation immediately creates under OpenFlux Assistant and activates it', async () => {
    const creates: unknown[][] = [];
    const activations: Array<[string, string]> = [];
    const controller = new NewConversationController({
        gateway: {
            async createSession(...args) {
                creates.push(args);
                return session('session-new', String(args[3]));
            },
            async updateSessionOwner() { throw new Error('not used'); },
        },
        getEntities: () => entities,
        getApprovalMode: () => 'full_access',
        activate: (created, owner) => { activations.push([created.id, owner.id]); },
    });

    const created = await controller.create();
    assert.equal(created.agentId, 'main');
    assert.deepEqual(creates, [[undefined, undefined, undefined, 'main', 'full_access']]);
    assert.deepEqual(activations, [['session-new', 'main']]);
});

test('top action coalesces repeated clicks while creation is pending', async () => {
    const dom = new JSDOM('<button id="new-chat">New conversation</button>');
    const button = dom.window.document.querySelector<HTMLButtonElement>('#new-chat')!;
    let resolveCreate!: (value: Session) => void;
    let calls = 0;
    const pending = new Promise<Session>(resolve => { resolveCreate = resolve; });
    const controller = new NewConversationController({
        gateway: {
            async createSession() { calls++; return pending; },
            async updateSessionOwner() { throw new Error('not used'); },
        },
        getEntities: () => entities,
        activate: () => undefined,
    });
    const unbind = controller.bindNewConversationButton(button);

    button.click();
    button.click();
    await Promise.resolve();
    assert.equal(calls, 1);
    assert.equal(button.disabled, true);
    assert.equal(button.getAttribute('aria-busy'), 'true');

    resolveCreate(session('session-new', 'main'));
    await pending;
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(button.disabled, false);
    assert.equal(button.hasAttribute('aria-busy'), false);
    unbind();
    dom.window.close();
});

test('conversation owner select moves among projects, Agents, and the default assistant', async () => {
    const dom = new JSDOM('<select id="owner"></select>');
    const select = dom.window.document.querySelector<HTMLSelectElement>('#owner')!;
    renderConversationOwnerSelect(
        select,
        entities,
        'main',
        name => `项目：${name}`,
        name => `Agent：${name}`,
    );
    assert.deepEqual([...select.options].map(option => [option.value, option.textContent]), [
        ['', 'OpenFlux Assistant'],
        ['project-a', '项目：Alpha'],
        ['project-b', '项目：Beta'],
        ['writer', 'Agent：Writer'],
    ]);

    const updates: Array<[string, string]> = [];
    const controller = new NewConversationController({
        gateway: {
            async createSession() { throw new Error('not used'); },
            async updateSessionOwner(sessionId, ownerId) {
                updates.push([sessionId, ownerId]);
                return session(sessionId, ownerId);
            },
        },
        getEntities: () => entities,
        activate: () => undefined,
    });
    controller.bindOwnerSelect(select, () => 'session-current');

    select.value = 'project-a';
    select.dispatchEvent(new dom.window.Event('change'));
    await new Promise(resolve => setTimeout(resolve, 0));
    select.value = 'writer';
    select.dispatchEvent(new dom.window.Event('change'));
    await new Promise(resolve => setTimeout(resolve, 0));
    select.value = '';
    select.dispatchEvent(new dom.window.Event('change'));
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.deepEqual(updates, [
        ['session-current', 'project-a'],
        ['session-current', 'writer'],
        ['session-current', 'main'],
    ]);
    dom.window.close();
});

test('custom conversation owner picker filters choices and drives the backing owner select', async () => {
    const dom = new JSDOM(`
        <div id="root">
            <button id="trigger" aria-expanded="false"><span id="label"></span></button>
            <select id="select"></select>
            <div id="menu" class="hidden">
                <input id="search" />
                <div id="options"></div>
                <div id="empty" class="hidden"></div>
                <button id="create"><span></span><span></span><span class="session-owner-option-check"></span></button>
                <button id="default"><span></span><span></span><span class="session-owner-option-check"></span></button>
            </div>
        </div>
    `);
    const document = dom.window.document;
    const select = document.querySelector<HTMLSelectElement>('#select')!;
    renderConversationOwnerSelect(select, entities, 'project-a');
    const changes: string[] = [];
    let createCount = 0;
    select.addEventListener('change', () => changes.push(select.value));
    const binding = bindConversationOwnerPicker({
        root: document.querySelector<HTMLElement>('#root')!,
        trigger: document.querySelector<HTMLButtonElement>('#trigger')!,
        label: document.querySelector<HTMLElement>('#label')!,
        select,
        menu: document.querySelector<HTMLElement>('#menu')!,
        search: document.querySelector<HTMLInputElement>('#search')!,
        options: document.querySelector<HTMLElement>('#options')!,
        empty: document.querySelector<HTMLElement>('#empty')!,
        createButton: document.querySelector<HTMLButtonElement>('#create')!,
        defaultButton: document.querySelector<HTMLButtonElement>('#default')!,
    }, () => { createCount++; });

    assert.equal(document.querySelector('#label')?.textContent, 'Alpha');
    document.querySelector<HTMLButtonElement>('#trigger')!.click();
    await Promise.resolve();
    assert.equal(document.querySelector('#menu')?.classList.contains('hidden'), false);
    assert.deepEqual(
        [...document.querySelectorAll<HTMLElement>('.session-owner-option-label')].map(node => node.textContent),
        ['Alpha', 'Beta', 'Writer'],
    );

    const search = document.querySelector<HTMLInputElement>('#search')!;
    search.value = ' beta ';
    search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    assert.deepEqual(
        [...document.querySelectorAll<HTMLElement>('.session-owner-option-label')].map(node => node.textContent),
        ['Beta'],
    );
    document.querySelector<HTMLButtonElement>('[data-owner-value="project-b"]')!.click();
    assert.equal(select.value, 'project-b');
    assert.deepEqual(changes, ['project-b']);
    assert.equal(document.querySelector('#menu')?.classList.contains('hidden'), true);

    document.querySelector<HTMLButtonElement>('#trigger')!.click();
    document.querySelector<HTMLButtonElement>('#default')!.click();
    assert.equal(select.value, '');
    assert.deepEqual(changes, ['project-b', '']);
    assert.equal(document.querySelector('#label')?.textContent, 'OpenFlux Assistant');

    document.querySelector<HTMLButtonElement>('#trigger')!.click();
    document.querySelector<HTMLButtonElement>('#create')!.click();
    assert.equal(createCount, 1);
    assert.equal(document.querySelector('#menu')?.classList.contains('hidden'), true);
    binding.destroy();
    dom.window.close();
});

test('a delayed owner update cannot navigate back after the user changes conversations', async () => {
    const dom = new JSDOM('<select id="owner"></select>');
    const select = dom.window.document.querySelector<HTMLSelectElement>('#owner')!;
    renderConversationOwnerSelect(select, entities, 'main');
    let resolveUpdate!: (value: Session) => void;
    const pending = new Promise<Session>(resolve => { resolveUpdate = resolve; });
    const activations: string[] = [];
    const reconciliations: string[] = [];
    let visibleSessionId: string | null = 'session-current';
    let navigationRevision = 1;
    const controller = new NewConversationController({
        gateway: {
            async createSession() { throw new Error('not used'); },
            async updateSessionOwner() { return pending; },
        },
        getEntities: () => entities,
        activate: session => { activations.push(session.id); },
        reconcile: session => { reconciliations.push(session.id); },
    });
    controller.bindOwnerSelect(select, () => visibleSessionId, () => navigationRevision);

    select.value = 'writer';
    select.dispatchEvent(new dom.window.Event('change'));
    await Promise.resolve();
    visibleSessionId = 'session-other';
    navigationRevision++;
    resolveUpdate(session('session-current', 'writer'));
    await pending;
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.deepEqual(activations, []);
    assert.deepEqual(reconciliations, ['session-current']);
    dom.window.close();
});

test('application wires New Chat, the owner picker, and archive-only sidebar actions', () => {
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
    const main = readFileSync(new URL('../../src/main.ts', import.meta.url), 'utf8');
    const client = readFileSync(new URL('../../src/gateway-client.ts', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../../src/styles/main.css', import.meta.url), 'utf8');
    const zh = readFileSync(new URL('../../src/i18n/zh.ts', import.meta.url), 'utf8');
    const en = readFileSync(new URL('../../src/i18n/en.ts', import.meta.url), 'utf8');

    const newChatIndex = html.indexOf('id="new-chat-btn"');
    const newEntityIndex = html.indexOf('id="new-session-btn"');
    assert.ok(newChatIndex >= 0 && newChatIndex < newEntityIndex, 'New Chat must appear above New Agent / Project');
    const document = new JSDOM(html).window.document;
    const ownerControl = document.querySelector<HTMLElement>('#session-owner-control');
    const inputContainer = document.querySelector<HTMLElement>('.input-container');
    assert.ok(ownerControl);
    assert.equal(ownerControl?.parentElement, inputContainer);
    assert.equal(inputContainer?.firstElementChild, ownerControl);
    assert.equal(document.querySelector('.chat-toolbar #session-owner-control'), null);
    assert.doesNotMatch(ownerControl?.textContent || '', /本地|git/i);
    assert.equal(ownerControl?.querySelectorAll('select').length, 1);
    assert.ok(ownerControl?.querySelector('#session-owner-select'));
    assert.ok(ownerControl?.querySelector('#project-context-chip[aria-haspopup="dialog"]'));
    assert.ok(ownerControl?.querySelector('#session-owner-search[type="search"]'));
    assert.ok(ownerControl?.querySelector('#session-owner-options'));
    assert.equal(ownerControl?.querySelector('[data-environment], [data-worktree], [data-branch]'), null);
    assert.match(main, /newConversationController\.bindNewConversationButton\(newChatBtn\)/);
    assert.match(main, /newConversationController\.bindOwnerSelect\(/);
    assert.match(main, /bindConversationOwnerPicker\(/);
    assert.match(main, /renderConversationOwnerSelect\(/);
    assert.match(main, /emptyConversationIds\.has\(currentSessionId\)/);
    assert.match(main, /if \(messageHtml\.trim\(\)\) setConversationEmpty\(currentSessionId, false\)/);
    assert.match(main, /agent\.locked \|\| agent\.default \|\| agent\.id === 'main'/);

    const archiveSessionStart = main.indexOf('async function deleteAgentSession');
    const archiveSessionEnd = main.indexOf('/** 行内重命名会话', archiveSessionStart);
    const archiveSessionBody = main.slice(archiveSessionStart, archiveSessionEnd);
    assert.match(archiveSessionBody, /gatewayClient\.archiveSession\(sessionId\)/);
    assert.doesNotMatch(archiveSessionBody, /last_one_hint|length <= 1/);
    assert.match(client, /'sessions\.archive'/);
    assert.match(client, /'agents\.archive'/);
    assert.match(css, /\.session-owner-control\s*\{[\s\S]*?border-bottom:/);
    assert.match(css, /\.session-owner-select\s*\{/);
    assert.match(css, /\.session-owner-menu\s*\{[\s\S]*?width: min\(392px/);
    assert.match(css, /\.session-owner-options\s*\{[\s\S]*?overflow-y: auto/);
    assert.match(zh, /'session\.owner_search': '搜索项目或 Agent'/);
    assert.match(en, /'session\.owner_search': 'Search projects or Agents'/);
    assert.match(zh, /'misc\.delete_session': '归档会话'/);
    assert.match(en, /'misc\.delete_session': 'Archive session'/);
});
