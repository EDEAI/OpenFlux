import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import { StartedTurnInputStore } from '../../src/chat/started-turn-inputs';
import { HistoryLoadOrder } from '../../src/chat/history-load-order';
import { FollowUpController } from '../../src/chat/follow-up-controller';
import { renderConversationOwnerSelect } from '../../src/sidebar/new-conversation';
import type { LocalEntityView, RouterAssignmentCard } from '../../src/gateway-client';
import zh from '../../src/i18n/zh';

interface TestMessage {
    id: string;
    role: string;
    content: string;
    createdAt: number;
    metadata?: Record<string, unknown>;
}

const entities: LocalEntityView[] = [
    { id: 'main', name: 'OpenFlux Assistant', kind: 'agent', default: true, createdAt: 1, updatedAt: 1 },
    { id: 'project-a', name: 'Alpha', kind: 'project', workspace: 'D:/alpha', createdAt: 1, updatedAt: 1 },
    { id: 'writer', name: 'Writer', kind: 'agent', createdAt: 1, updatedAt: 1 },
];
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const text = (key: string) => (zh as Record<string, string>)[key] || key;

// Run the actual entry points without loading unrelated native services in main.ts.
function mainFunctions(names: string[], context: Record<string, unknown>) {
    const source = readFileSync(new URL('../../src/main.ts', import.meta.url), 'utf8');
    const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const declarations = names.map(name => {
        const declaration = ast.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
        assert.ok(declaration, `Missing main entry point ${name}`);
        return declaration.getText(ast);
    });
    const compiled = ts.transpileModule(`${declarations.join('\n')}\n({${names.join(',')}});`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    return runInNewContext(compiled, context) as Record<string, (...args: unknown[]) => unknown>;
}

function viewHarness(t: TestContext) {
    const dom = new JSDOM(readFileSync(new URL('../../index.html', import.meta.url), 'utf8'), { url: 'https://assignment.test' });
    t.after(() => dom.window.close());
    const document = dom.window.document;
    const messagesContainer = document.getElementById('messages')!;
    const sessionList = document.getElementById('session-list')!;
    const sessionOwnerControl = document.getElementById('session-owner-control')!;
    const projectContextChip = document.getElementById('project-context-chip')!;
    const sessionOwnerSelect = document.getElementById('session-owner-select') as HTMLSelectElement;
    const startedTurnInputs = new StartedTurnInputStore<TestMessage>();
    const followUpController = new FollowUpController();
    const renderedFollowUpSubmissionIds = new Set<string>();
    const context = {
        document, Error, currentSessionId: 'local-empty', currentAgentId: 'main',
        currentCloudChatroomId: null, isRouterSession: false,
        agentsList: entities, sessionList, messagesContainer,
        sessionOwnerControl, sessionOwnerSelect, projectContextChip,
        projectContextIcon: document.getElementById('project-context-icon')!,
        chatSessionTitle: document.getElementById('chat-session-title')!,
        sessionOwnerPicker: { sync() {}, close() {} },
        emptyConversationIds: new Set(['local-empty']), nonEmptyConversationIds: new Set<string>(),
        externalConversationIds: new Set<string>(), startedTurnInputs,
        sessionRuntimeStates: new Map(), workStateBySession: new Map(),
        loadingSessions: new Set<string>(), chatTargetSessionIds: new Set<string>(),
        activeTurnBySession: followUpController.activeTurnBySession, followUpController,
        pendingFollowUpSubmissions: new Map(), renderedFollowUpSubmissionIds,
        rememberRenderedSubmission: (id: string) => renderedFollowUpSubmissionIds.add(id),
        mergeLatestPlanPreview: (messages: TestMessage[]) => messages,
        getCurrentWorkState: () => undefined,
        getLocale: () => 'zh-CN', t: text,
        CHAT_HEADER_ICON_PROJECT: '<svg></svg>', DEFAULT_AGENT_ICON: '', renderAgentIcon: () => '<svg></svg>',
        renderConversationOwnerSelect,
        renderMessage: (message: TestMessage) => {
            const node = document.createElement('div');
            node.className = `message ${message.role}`;
            node.dataset.messageId = message.id;
            if (typeof message.metadata?.turnId === 'string') node.dataset.turnId = message.metadata.turnId;
            node.textContent = message.content;
            return node.outerHTML;
        },
        activityView: {
            restoreRunningSession() {}, cacheEvent() {}, restoreTurn() { return null; },
        },
        guidanceTextFromActivityItem: () => undefined,
        isSteerMessageRepresentedInActivity: () => false,
        shouldRenderUnanchoredTurn: () => true,
        activateMermaid() {}, hydrateLocalImages() {}, reconcileUserInput() {}, scrollToBottom() {},
        showTyping() {}, renderFollowUpQueue() {}, updateSendButtonState() {},
        setSessionRuntimeState: (sessionId: string, state: string) => context.sessionRuntimeStates.set(sessionId, { state }),
    };
    const actions = mainFunctions([
        'handleFollowUpGatewayMessage', 'isSessionFollowUpRunning', 'setConversationEmpty',
        'syncProjectContextIndicator', 'renderMessagesWithActivity', 'renderMessagesWithLogs',
        'removeMessagePlaceholderStates', 'addMessage',
    ], context);
    return { dom, document, context, actions, messagesContainer, sessionOwnerControl, sessionOwnerSelect, startedTurnInputs };
}

function start(sessionId = 'group-session', submissionId = 'external:delivery-a', turnId = 'external-turn-a') {
    return {
        type: 'chat.start',
        payload: {
            sessionId, submissionId, turnId, runId: 'run-a',
            input: '【飞书群「研发群」· 小明】 请检查登录问题',
        },
    };
}

function assertAssignedView(h: ReturnType<typeof viewHarness>, id = 'msg-queued-external:delivery-a') {
    const messages = h.messagesContainer.querySelectorAll('.message.user');
    assert.equal(messages.length, 1, 'the started request must be visible before its first result');
    assert.equal((messages[0] as HTMLElement).dataset.messageId, id);
    assert.match(messages[0].textContent || '', /请检查登录问题/);
    assert.equal(h.messagesContainer.querySelector('.welcome-message'), null);
    assert.equal(h.sessionOwnerControl.classList.contains('hidden'), true);
    assert.equal(h.sessionOwnerSelect.options.length, 0, 'an assigned group must not offer creation-time reassignment');
}

test('a background external start survives an empty history snapshot when its assigned conversation opens', t => {
    const h = viewHarness(t);
    h.actions.syncProjectContextIndicator();
    assert.equal(h.sessionOwnerControl.classList.contains('hidden'), false, 'the previous local empty conversation starts with its picker');
    h.actions.handleFollowUpGatewayMessage(start());
    assert.equal(h.messagesContainer.querySelector('.message.user'), null, 'the background request must not enter the previous conversation');
    assert.equal(h.startedTurnInputs.has('group-session'), true);
    h.context.currentSessionId = 'group-session';
    h.context.currentAgentId = 'project-a';
    h.actions.renderMessagesWithActivity([], [], [], 'group-session');
    assertAssignedView(h);
    assert.equal(h.context.nonEmptyConversationIds.has('group-session'), true);
});

test('a foreground external start arriving during a history load is retained after that empty snapshot renders', async t => {
    const h = viewHarness(t);
    h.context.currentSessionId = 'group-session';
    h.context.currentAgentId = 'project-a';
    let resolveHistory!: (messages: TestMessage[]) => void;
    const snapshot = new Promise<TestMessage[]>(resolve => { resolveHistory = resolve; });
    const loaded = snapshot.then(messages => h.actions.renderMessagesWithActivity(messages, [], [], 'group-session'));
    h.actions.handleFollowUpGatewayMessage(start());
    assertAssignedView(h);
    resolveHistory([]);
    await loaded;
    assertAssignedView(h);
});

for (const identity of ['submissionId', 'turnId'] as const) {
    test(`persisted history matching the started ${identity} replaces its live input without a duplicate`, t => {
        const h = viewHarness(t);
        h.actions.handleFollowUpGatewayMessage(start());
        h.context.currentSessionId = 'group-session';
        h.context.currentAgentId = 'project-a';
        const serverMessage: TestMessage = {
            id: 'server-input', role: 'user', content: '服务端确认：请检查登录问题', createdAt: 3,
            metadata: { [identity]: identity === 'submissionId' ? 'external:delivery-a' : 'external-turn-a' },
        };
        h.actions.renderMessagesWithActivity([serverMessage], [], [], 'group-session');
        assertAssignedView(h, 'server-input');
        assert.equal(h.messagesContainer.querySelector('.message.user')!.textContent, serverMessage.content);
        assert.equal(h.startedTurnInputs.has('group-session'), false, 'persisted history acknowledges the cached input');
    });
}

test('a truly idle empty local conversation keeps its welcome and creation-time owner picker', t => {
    const h = viewHarness(t);
    h.actions.renderMessagesWithActivity([], [], [], 'local-empty');
    assert.ok(h.messagesContainer.querySelector('.welcome-message'));
    assert.equal(h.messagesContainer.querySelector('.message.user'), null);
    assert.equal(h.sessionOwnerControl.classList.contains('hidden'), false);
    assert.deepEqual([...h.sessionOwnerSelect.options].map(option => option.dataset.ownerId), ['main', 'project-a', 'writer']);
});

test('an empty running snapshot suppresses welcome and ownership controls before any input is persisted', t => {
    const h = viewHarness(t);
    h.context.loadingSessions.add('local-empty');
    h.actions.renderMessagesWithActivity([], [], [], 'local-empty');
    assert.equal(h.messagesContainer.querySelector('.welcome-message'), null);
    assert.equal(h.sessionOwnerControl.classList.contains('hidden'), true);
    assert.equal(h.sessionOwnerSelect.options.length, 0);
});

test('a newly assigned group suppresses creation controls even before its start event arrives', t => {
    const h = viewHarness(t);
    h.context.currentSessionId = 'group-session';
    h.context.currentAgentId = 'project-a';
    h.context.externalConversationIds.add('group-session');
    h.context.emptyConversationIds.add('group-session');
    h.actions.renderMessagesWithActivity([], [], [], 'group-session');
    assert.equal(h.messagesContainer.querySelector('.welcome-message'), null);
    assert.equal(h.sessionOwnerControl.classList.contains('hidden'), true);
    assert.equal(h.sessionOwnerSelect.options.length, 0);
});

function navigationHistoryHarness(t: TestContext, getMessages: () => Promise<unknown>) {
    const h = viewHarness(t);
    const historyLoadOrder = new HistoryLoadOrder();
    const errors: unknown[][] = [];
    let messageRequests = 0;
    const context = Object.assign(h.context, h.actions, {
        historyLoadOrder, console: { log() {}, error: (...args: unknown[]) => errors.push(args) },
        sessionViewRevision: 0, currentAgentId: 'project-a',
        sessionDrafts: new Map(), sessionMsgOffset: new Map(), sessionMsgHasMore: new Map(),
        unreadSessionIds: new Set(), workStateRevisions: new Map(), agentSessionsList: [],
        agentActiveSessionMap: new Map(), agentSessionsMap: new Map(), newSessionApprovalMode: 'ask',
        messageInput: h.document.getElementById('message-input'), inputRow: h.document.querySelector('.input-row'),
        closeSchedulerView() {}, closeSettingsView() {}, setSidebarActionState() {},
        resetQuestionComposer() {}, syncPanelScope() {}, getSessionApprovalMode: () => 'ask',
        hideRouterBindUI() {}, updateInputForCloudSession() {}, syncApprovalModeUi() {}, syncWorkModeUi() {},
        syncSidebarEntitySelection() {}, syncCurrentSessionRuntimeUi() {}, autoResize() {},
        cacheCurrentProgressState() {}, clearArtifacts() {}, applyWorkState() {},
        rememberSessionApprovalModes() {}, registerSessionAgent() {}, userInputView: { reconcile() {} },
        hideAgentEditView() {}, renderLocalAgents() {}, switchSidebarMode() {},
        currentProgressCard: null, progressItems: [], isProgressFinished: false,
        SESSION_PAGE_SIZE: 50, restoreRunningProgressCard() {},
        hydrateMessageAttachments: async (messages: TestMessage[]) => messages,
        gatewayClient: {
            getMessages: async () => { messageRequests++; return getMessages(); },
            getLogs: async () => [], getArtifacts: async () => [], getAgentEvents: async () => [],
            getWorkState: async () => ({ sessionId: 'group-session', mode: 'normal' }),
            switchAgent: async (id: string, sessionKey: string) => ({ agent: { id, sessionKey, name: 'Alpha' }, sessions: [] }),
        },
    });
    return { ...h, context, historyLoadOrder, errors, messageRequests: () => messageRequests };
}

function persistedInput(): TestMessage {
    return {
        id: 'server-input', role: 'user', content: '服务端确认：请检查登录问题', createdAt: 3,
        metadata: { turnId: 'external-turn-a', submissionId: 'external:delivery-a' },
    };
}

test('an older real session load cannot erase an input after newer persisted history acknowledges its cache', async t => {
    let resolveOlder!: (result: { messages: TestMessage[]; total: number; hasMore: boolean }) => void;
    const olderSnapshot = new Promise<{ messages: TestMessage[]; total: number; hasMore: boolean }>(resolve => { resolveOlder = resolve; });
    const h = navigationHistoryHarness(t, () => olderSnapshot);
    h.actions.handleFollowUpGatewayMessage(start());
    const { context, historyLoadOrder, errors } = h;
    const selectSession = mainFunctions(['selectSession'], context).selectSession;
    const olderLoad = selectSession('group-session') as Promise<void>;
    assert.equal(h.messageRequests(), 1, 'the old empty request must start before the newer refresh');
    const newerVersion = historyLoadOrder.begin();
    assert.equal(historyLoadOrder.commit('group-session', newerVersion), true);
    const serverInput = persistedInput();
    h.actions.renderMessagesWithActivity([serverInput], [], [], 'group-session');
    assert.equal(h.startedTurnInputs.has('group-session'), false, 'the newer server snapshot clears the acknowledged live input');
    resolveOlder({ messages: [], total: 0, hasMore: false });
    await olderLoad;
    assert.deepEqual(errors, [], 'the actual session load must run without missing boundary dependencies');
    assertAssignedView(h, 'server-input');
    assert.equal(h.messagesContainer.querySelector('.message.user')!.textContent, serverInput.content);
});

test('a failed older real Agent history load cannot clear a newer committed conversation', async t => {
    let rejectOlder!: (error: Error) => void;
    const olderSnapshot = new Promise<never>((_resolve, reject) => { rejectOlder = reject; });
    const h = navigationHistoryHarness(t, () => olderSnapshot);
    h.context.currentAgentId = 'main';
    h.actions.handleFollowUpGatewayMessage(start());
    const switchToAgent = mainFunctions(['switchToAgent'], h.context).switchToAgent;
    const olderLoad = switchToAgent('project-a', 'group-session') as Promise<void>;
    await settle();
    assert.equal(h.messageRequests(), 1, 'the actual Agent navigation must reach its history transport');
    assert.equal(h.context.currentAgentId, 'project-a');
    assert.equal(h.context.currentSessionId, 'group-session');
    assert.equal(h.historyLoadOrder.commit('group-session', h.historyLoadOrder.begin()), true);
    h.actions.renderMessagesWithActivity([persistedInput()], [], [], 'group-session');
    assert.equal(h.startedTurnInputs.has('group-session'), false);
    const failure = new Error('The older history request failed');
    rejectOlder(failure);
    await olderLoad;
    assert.equal(h.errors.length, 1);
    assert.equal(h.errors[0].includes(failure), true, 'the only logged error must come from the failed history transport');
    assertAssignedView(h, 'server-input');
});

function card(): RouterAssignmentCard {
    return {
        binding: {
            mappingId: 'mapping-a', platformId: 'feishu-a', platformType: 'feishu', workspaceId: 'tenant-a',
            channelId: 'channel-a', channelName: '研发群', requesterDisplayName: '小明',
            state: 'pending', createdAt: 1, updatedAt: 1,
        },
        platformLabel: '飞书', requestCount: 1, contextCount: 0, latestAt: 1,
        requests: [{
            id: 'delivery-a', text: '请检查登录问题', senderPlatformId: 'sender-a', senderDisplayName: '小明',
            attachmentCount: 0, createdAt: 1, receivedAt: 1, executable: true,
        }],
    };
}

function assignmentHarness(t: TestContext, assign: (...args: unknown[]) => Promise<unknown>) {
    const dom = new JSDOM('<!doctype html><body></body>');
    t.after(() => dom.window.close());
    const calls: Array<{ action: string; args: unknown[] }> = [];
    const context = {
        document: dom.window.document, Error, assignmentDialogOverlay: null,
        currentAgentId: 'main', currentSessionId: 'local-empty', currentCloudChatroomId: null,
        agentsList: entities, t: text, renderConversationOwnerSelect,
        externalConversationIds: new Set<string>(), sessionAgentMap: new Map<string, string>(),
        agentActiveSessionMap: new Map<string, string>(),
        gatewayClient: {
            async assignRouterConversation(...args: unknown[]) {
                calls.push({ action: 'assign', args });
                return assign(...args);
            },
            updateSessionOwner() { assert.fail('assignment must activate the existing owner without another ownership mutation'); },
            createSession() { assert.fail('the group assignment already created its dedicated conversation'); },
        },
        setAgentSessionsCollapsed: (...args: unknown[]) => calls.push({ action: 'collapse', args }),
        switchSidebarMode: (...args: unknown[]) => calls.push({ action: 'sidebar', args }),
        hideAgentEditView: () => calls.push({ action: 'hide-editor', args: [] }),
        // This is the transport/UI boundary of normal navigation, not a second assignment.
        switchToAgent: async (ownerId: string, sessionId: string) => {
            calls.push({ action: 'navigate', args: [ownerId, sessionId] });
            context.currentAgentId = ownerId;
            context.currentSessionId = sessionId;
        },
        selectSession: async (sessionId: string) => {
            calls.push({ action: 'navigate-session', args: [sessionId] });
            assert.equal(context.currentAgentId, context.sessionAgentMap.get(sessionId));
            context.currentSessionId = sessionId;
        },
        loadLocalAgents: async (options: { autoSelect?: boolean }) => {
            calls.push({ action: 'load', args: [options.autoSelect] });
            assert.equal(context.currentAgentId, context.sessionAgentMap.get(context.currentSessionId));
        },
        refreshPendingAssignments: async () => { calls.push({ action: 'refresh', args: [] }); },
    };
    const actions = mainFunctions(['ensureAssignmentDialog', 'openAssignmentDialog', 'selectAgentSession'], context);
    return { dom, calls, context, actions };
}

test('the real assignment dialog activates its Project session through normal navigation before refreshing the sidebar', async t => {
    const h = assignmentHarness(t, async () => ({ sessionId: 'group-session', binding: { targetId: 'project-a' } }));
    const opened = h.actions.openAssignmentDialog(card()) as Promise<void>;
    const overlay = h.dom.window.document.getElementById('assignment-dialog-overlay')!;
    const select = overlay.querySelector<HTMLSelectElement>('#assignment-owner-select')!;
    select.value = 'project-a';
    overlay.querySelector<HTMLButtonElement>('[data-role="ok"]')!.click();
    await opened;
    await settle();
    assert.deepEqual(h.calls.find(call => call.action === 'assign')!.args, ['mapping-a', 'project-a', 'project']);
    assert.deepEqual(h.calls.filter(call => ['navigate', 'load'].includes(call.action)), [
        { action: 'navigate', args: ['project-a', 'group-session'] },
        { action: 'load', args: [false] },
    ]);
    assert.equal(h.context.currentAgentId, 'project-a');
    assert.equal(h.context.currentSessionId, 'group-session');
    assert.equal(h.context.sessionAgentMap.get('group-session'), 'project-a');
    assert.equal(h.context.agentActiveSessionMap.get('project-a'), 'group-session');
    assert.equal(h.context.externalConversationIds.has('group-session'), true);
    assert.deepEqual(h.calls.find(call => call.action === 'collapse')!.args, ['project-a', false]);
    assert.equal(overlay.classList.contains('hidden'), true);
});

test('an already assigned response opens its authoritative Agent instead of the newly selected target', async t => {
    const h = assignmentHarness(t, async () => ({ sessionId: 'group-session', binding: { targetId: 'writer' } }));
    const opened = h.actions.openAssignmentDialog(card()) as Promise<void>;
    const overlay = h.dom.window.document.getElementById('assignment-dialog-overlay')!;
    overlay.querySelector<HTMLSelectElement>('#assignment-owner-select')!.value = 'project-a';
    overlay.querySelector<HTMLButtonElement>('[data-role="ok"]')!.click();
    await opened;
    await settle();
    assert.deepEqual(h.calls.find(call => call.action === 'navigate')!.args, ['writer', 'group-session']);
    assert.equal(h.context.currentAgentId, 'writer');
    assert.equal(h.context.sessionAgentMap.get('group-session'), 'writer');
});

test('assignment to the current owner closes its editor before navigating to the dedicated session', async t => {
    const h = assignmentHarness(t, async () => ({ sessionId: 'group-session', binding: { targetId: 'main' } }));
    const opened = h.actions.openAssignmentDialog(card()) as Promise<void>;
    const overlay = h.dom.window.document.getElementById('assignment-dialog-overlay')!;
    overlay.querySelector<HTMLButtonElement>('[data-role="ok"]')!.click();
    await opened;
    await settle();
    assert.deepEqual(h.calls.find(call => call.action === 'assign')!.args, ['mapping-a', 'main', 'agent']);
    assert.deepEqual(h.calls.filter(call => ['hide-editor', 'navigate', 'navigate-session', 'load'].includes(call.action)), [
        { action: 'hide-editor', args: [] },
        { action: 'navigate-session', args: ['group-session'] },
        { action: 'load', args: [false] },
    ]);
    assert.equal(h.context.currentAgentId, 'main');
    assert.equal(h.context.currentSessionId, 'group-session');
    assert.equal(h.context.agentActiveSessionMap.get('main'), 'group-session');
});

test('a rejected assignment keeps the real dialog open with its error and permits cancellation', async t => {
    const h = assignmentHarness(t, async () => { throw new Error('Router 未连接，暂时不能分配'); });
    const opened = h.actions.openAssignmentDialog(card()) as Promise<void>;
    const overlay = h.dom.window.document.getElementById('assignment-dialog-overlay')!;
    const ok = overlay.querySelector<HTMLButtonElement>('[data-role="ok"]')!;
    overlay.querySelector<HTMLSelectElement>('#assignment-owner-select')!.value = 'project-a';
    ok.click();
    await settle();
    assert.equal(overlay.classList.contains('hidden'), false);
    assert.equal(ok.disabled, false);
    assert.equal(ok.textContent, text('assignment.assign_and_start'));
    assert.equal(overlay.querySelector('.assignment-dialog-hint')!.textContent, 'Router 未连接，暂时不能分配');
    assert.equal(h.calls.some(call => ['navigate', 'load'].includes(call.action)), false);
    assert.equal(h.context.currentSessionId, 'local-empty');
    overlay.querySelector<HTMLButtonElement>('[data-role="cancel"]')!.click();
    await opened;
    assert.equal(overlay.classList.contains('hidden'), true);
});
