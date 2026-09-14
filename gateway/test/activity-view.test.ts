import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { ActivityViewController } from '../../src/chat/activity-view';
import {
    isSteerMessageRepresentedInActivity,
    shouldRenderUnanchoredTurn,
    type AgentEventV1,
} from '../../src/chat/activity-state';

const DESIGNER_SESSION_ID = 'designer-session';

test('activity steps use the conversation flow instead of an independent scroll viewport', () => {
    const stylesheet = readFileSync(
        new URL('../../src/styles/main.css', import.meta.url),
        'utf8',
    );
    const itemsRule = stylesheet.match(/\.agent-activity-items\s*\{([^}]*)\}/)?.[1] ?? '';
    const itemRule = stylesheet.match(/\.agent-activity-item\s*\{([^}]*)\}/)?.[1] ?? '';
    const maxHeight = itemsRule.match(/max-height\s*:\s*([^;]+)/)?.[1]?.trim();

    assert.ok(!maxHeight || maxHeight === 'none');
    assert.doesNotMatch(itemsRule, /overflow-y\s*:\s*(?:auto|scroll)/);
    assert.match(itemRule, /flex:\s*0\s+0\s+auto\s*;/);
});

test('chat completion commits output before collapsing activity in foreground and background sessions', () => {
    const mainSource = readFileSync(new URL('../../src/main.ts', import.meta.url), 'utf8');
    const currentBranchStart = mainSource.indexOf("} else if (progressEvent.type === 'complete') {");
    assert.ok(currentBranchStart >= 0, 'foreground completion branch must exist');
    const currentBranchEnd = mainSource.indexOf('\n    }\n}\n', currentBranchStart);
    const currentBranch = mainSource.slice(currentBranchStart, currentBranchEnd);
    const finalRender = currentBranch.lastIndexOf('finishStreamingMessage');
    const legacyCollapse = currentBranch.indexOf('finishProgressCard()', finalRender);
    const activityCollapse = currentBranch.indexOf('activityView.collapseAfterOutput', legacyCollapse);
    const bottomFollow = currentBranch.indexOf('scrollToBottom()', activityCollapse);
    assert.ok(finalRender >= 0, 'final assistant Markdown must be committed');
    assert.ok(legacyCollapse > finalRender, 'legacy activity collapses after final output');
    assert.ok(activityCollapse > legacyCollapse, 'structured activity collapses after final output');
    assert.ok(bottomFollow > activityCollapse, 'conversation follows the final answer after height shrinks');

    const backgroundStart = mainSource.indexOf('if (event.sessionId && event.sessionId !== currentSessionId)');
    const backgroundBranch = mainSource.slice(backgroundStart, currentBranchStart);
    assert.match(
        backgroundBranch,
        /if \(event\.type === 'complete'\)[\s\S]*activityView\.collapseAfterOutput\(event\.sessionId, event\.turnId\)/,
    );

    const clientSource = readFileSync(new URL('../../src/gateway-client.ts', import.meta.url), 'utf8');
    assert.match(clientSource, /turnId:\s*payload\?\.turnId\s*\?\?\s*message\.id/);

    const failureStart = mainSource.indexOf('if (stillInSameSession) {');
    const failureEnd = mainSource.indexOf('pendingFollowUpSubmissions.delete', failureStart);
    const failureBranch = mainSource.slice(failureStart, failureEnd);
    assert.ok(failureBranch.indexOf('addMessage({') < failureBranch.indexOf('finishProgressCard()'));
    assert.ok(failureBranch.indexOf('finishProgressCard()') < failureBranch.indexOf('activityView.collapseAfterOutput'));

    const stopStart = mainSource.indexOf('function stopCurrentTask(): void');
    const stopEnd = mainSource.indexOf('void gatewayClient.stopTask', stopStart);
    const stopBranch = mainSource.slice(stopStart, stopEnd);
    assert.ok(stopBranch.indexOf('addMessage({') < stopBranch.indexOf('finishProgressCard()'));
    assert.ok(stopBranch.indexOf('finishProgressCard()') < stopBranch.indexOf('activityView.collapseAfterOutput'));
});

test('scheduled output keeps the execution turn identity and restores its process card before the collapsed reply', () => {
    const mainSource = readFileSync(new URL('../../src/main.ts', import.meta.url), 'utf8');
    const renderStart = mainSource.indexOf('function renderMessagesWithActivity(');
    const renderEnd = mainSource.indexOf('// Render messages with durable', renderStart + 1);
    const historyRender = mainSource.slice(renderStart, renderEnd > renderStart ? renderEnd : undefined);
    assert.match(historyRender, /scheduler_run_trigger[\s\S]*trigger\.after\(activity\)/);
    assert.match(historyRender, /scheduler_run_result[\s\S]*reply\.before\(activity\)/);

    const gatewaySource = readFileSync(new URL('../src/gateway/standalone.ts', import.meta.url), 'utf8');
    const scheduledStart = gatewaySource.indexOf('async function executeScheduledAgent(');
    const scheduledEnd = gatewaySource.indexOf('function extractAndSaveScheduledArtifacts(', scheduledStart);
    assert.ok(scheduledStart >= 0 && scheduledEnd > scheduledStart, 'scheduled execution block must exist');
    const scheduledExecution = gatewaySource.slice(scheduledStart, scheduledEnd);

    for (const kind of ['scheduler_run_trigger', 'scheduler_run_result', 'scheduler_run_error']) {
        assert.match(
            scheduledExecution,
            new RegExp(`kind:\\s*'${kind}'[\\s\\S]{0,240}?turnId:\\s*msgId`),
            `${kind} must point at the TurnTracker turn`,
        );
    }
    assert.match(
        scheduledExecution,
        /sessions\.addLog\(sessionId,\s*\{[\s\S]{0,500}?turnId:\s*msgId,[\s\S]{0,120}?runId:\s*execution\.runId/,
        'scheduled tool logs must retain both turn and execution identities',
    );

    const harness = createHarness();
    const turnId = 'scheduled-turn';
    try {
        for (const event of [
            turnStarted(turnId, 1_000),
            itemStarted(turnId, 1_010),
            itemCompleted(turnId, 1_020),
            turnCompleted(turnId, 1_030),
        ]) harness.view.cacheEvent(event, true);

        const trigger = harness.container.ownerDocument.createElement('div');
        trigger.className = 'message assistant';
        trigger.dataset.turnId = turnId;
        trigger.textContent = 'Scheduled task triggered';
        harness.container.append(trigger);

        const reply = harness.container.ownerDocument.createElement('div');
        reply.className = 'message assistant';
        reply.dataset.turnId = turnId;
        reply.textContent = 'Service status report';
        harness.container.append(reply);

        const activity = harness.view.restoreTurn(DESIGNER_SESSION_ID, turnId);
        assert.ok(activity);
        assert.equal(trigger.nextElementSibling, activity, 'the process card follows the scheduled trigger');
        assert.equal(activity.nextElementSibling, reply, 'the process card stays attached to its final output');
        assert.ok(activity.classList.contains('collapsed'), 'committed scheduled output collapses its process card');
        assert.equal(activity.querySelector('.agent-activity-item'), null);
    } finally {
        harness.cleanup();
    }
});

test('running and completed activity render no step counter or preparing placeholder', () => {
    const harness = createHarness();
    const turnId = 'minimal-activity';
    const assertMinimal = () => {
        assert.equal(harness.container.querySelector('.agent-activity-count'), null);
        assert.equal(harness.container.querySelector('.agent-activity-empty, .agent-activity-empty-marker, .agent-activity-empty-text'), null);
        assert.doesNotMatch(harness.container.querySelector('.agent-activity-header')?.textContent || '', /\d+\s*(?:steps?|步骤)/i);
    };
    try {
        harness.view.applyEvent(turnStarted(turnId, 1_000), DESIGNER_SESSION_ID);
        assertMinimal();
        assert.equal(harness.container.querySelector('.agent-activity-items')?.childElementCount, 0);
        harness.view.applyEvent(itemStarted(turnId, 1_010), DESIGNER_SESSION_ID);
        assertMinimal();
        harness.view.applyEvent(itemCompleted(turnId, 1_020), DESIGNER_SESSION_ID);
        harness.view.applyEvent(turnCompleted(turnId, 1_030), DESIGNER_SESSION_ID);
        assertMinimal();
        assert.equal(harness.container.querySelectorAll('.agent-activity-item').length, 1);
        assert.equal(harness.container.querySelector('.agent-activity')?.classList.contains('collapsed'), false);
        assert.equal(harness.view.collapseAfterOutput(DESIGNER_SESSION_ID, turnId), true);
        assert.equal(harness.container.querySelector('.agent-activity')?.classList.contains('collapsed'), true);
        assert.equal(harness.container.querySelectorAll('.agent-activity-item').length, 0);
        harness.container.querySelector<HTMLButtonElement>('.agent-activity-header')!.click();
        assertMinimal();
        assert.equal(harness.container.querySelectorAll('.agent-activity-item').length, 1);
    } finally { harness.cleanup(); }
});

test('terminal activity stays expanded until the final assistant output is committed', () => {
    const harness = createHarness();
    const turnId = 'terminal-before-output';
    try {
        harness.view.applyEvent(turnStarted(turnId, 1_000), DESIGNER_SESSION_ID);
        harness.view.applyEvent(itemStarted(turnId, 1_010), DESIGNER_SESSION_ID);
        harness.view.applyEvent(itemCompleted(turnId, 1_020), DESIGNER_SESSION_ID);
        harness.view.applyEvent(turnCompleted(turnId, 1_030), DESIGNER_SESSION_ID);

        const activity = harness.container.querySelector<HTMLElement>('.agent-activity')!;
        assert.equal(activity.classList.contains('collapsed'), false);
        assert.equal(activity.querySelectorAll('.agent-activity-item').length, 1);

        assert.equal(harness.view.collapseAfterOutput(DESIGNER_SESSION_ID, turnId), true);
        assert.ok(activity.classList.contains('collapsed'));
        assert.equal(activity.querySelector('.agent-activity-item'), null);

        activity.querySelector<HTMLButtonElement>('.agent-activity-header')!.click();
        assert.equal(activity.classList.contains('collapsed'), false);
        assert.equal(harness.view.collapseAfterOutput(DESIGNER_SESSION_ID, turnId), false);
        harness.view.restoreTurn(DESIGNER_SESSION_ID, turnId);
        assert.equal(activity.classList.contains('collapsed'), false, 'manual expansion remains open');
    } finally { harness.cleanup(); }
});

test('final output arriving before the terminal event collapses when that event lands', () => {
    const harness = createHarness();
    const turnId = 'output-before-terminal';
    try {
        harness.view.applyEvent(turnStarted(turnId, 1_000), DESIGNER_SESSION_ID);
        harness.view.applyEvent(itemStarted(turnId, 1_010), DESIGNER_SESSION_ID);

        assert.equal(harness.view.collapseAfterOutput(DESIGNER_SESSION_ID, turnId), false);
        assert.equal(harness.container.querySelector('.agent-activity')?.classList.contains('collapsed'), false);

        harness.view.applyEvent(itemCompleted(turnId, 1_020), DESIGNER_SESSION_ID);
        harness.view.applyEvent(turnCompleted(turnId, 1_030), DESIGNER_SESSION_ID);
        const activity = harness.container.querySelector<HTMLElement>('.agent-activity')!;
        assert.ok(activity.classList.contains('collapsed'));
        assert.equal(activity.querySelector('.agent-activity-item'), null);

        activity.querySelector<HTMLButtonElement>('.agent-activity-header')!.click();
        assert.equal(activity.classList.contains('collapsed'), false);
        assert.equal(activity.querySelectorAll('.agent-activity-item').length, 1);
    } finally { harness.cleanup(); }
});

test('an output notice without a turn id never arms an unrelated running turn', () => {
    const harness = createHarness();
    const turnId = 'identity-required-for-pending-collapse';
    try {
        harness.view.applyEvent(turnStarted(turnId, 1_000), DESIGNER_SESSION_ID);
        harness.view.applyEvent(itemStarted(turnId, 1_010), DESIGNER_SESSION_ID);
        assert.equal(harness.view.collapseAfterOutput(DESIGNER_SESSION_ID), false);

        harness.view.applyEvent(itemCompleted(turnId, 1_020), DESIGNER_SESSION_ID);
        harness.view.applyEvent(turnCompleted(turnId, 1_030), DESIGNER_SESSION_ID);
        const activity = harness.container.querySelector<HTMLElement>('.agent-activity')!;
        assert.equal(activity.classList.contains('collapsed'), false);
        assert.equal(activity.querySelectorAll('.agent-activity-item').length, 1);

        assert.equal(harness.view.collapseAfterOutput(DESIGNER_SESSION_ID), true);
        assert.ok(activity.classList.contains('collapsed'));
    } finally { harness.cleanup(); }
});

test('each visible execution category has its own static solid SVG marker', () => {
    const harness = createHarness();
    const turnId = 'solid-category-icons';
    const cases: Array<{ category: string; kind: NonNullable<AgentEventV1['item']>['kind']; tool?: string }> = [
        { category: 'commentary', kind: 'commentary' }, { category: 'guidance', kind: 'guidance' },
        { category: 'goal_update', kind: 'goal_update' }, { category: 'cli', kind: 'action', tool: 'process' },
        { category: 'tool', kind: 'action', tool: 'web_fetch' }, { category: 'subagent', kind: 'subagent' },
        { category: 'approval', kind: 'approval' }, { category: 'checkpoint', kind: 'checkpoint' },
    ];
    try {
        harness.view.applyEvent(turnStarted(turnId, 1_000), DESIGNER_SESSION_ID);
        cases.forEach((item, index) => harness.view.applyEvent({
            version: 1, eventId: `icon-${item.category}`, sessionId: DESIGNER_SESSION_ID, turnId,
            seq: index + 1, timestamp: 1_001 + index, type: 'item.started',
            item: { id: item.category, kind: item.kind, tool: item.tool, status: 'running', title: `Visible ${item.category}` },
        }, DESIGNER_SESSION_ID));
        const geometry = new Set<string>();
        for (const { category } of cases) {
            const row = harness.container.querySelector(`[data-item-id="${category}"]`)!;
            assert.ok(row.classList.contains(`category-${category}`));
            const marker = row.querySelector<HTMLElement>('.agent-activity-item-marker')!;
            assert.equal(marker.dataset.icon, category);
            const svg = marker.querySelector('svg')!;
            assert.ok(svg, `${category} must use a vector icon`);
            assert.equal(svg.getAttribute('fill'), 'currentColor');
            assert.equal(svg.getAttribute('viewBox'), '0 0 24 24');
            assert.equal(svg.querySelector('[stroke], script, image, use, foreignObject'), null);
            assert.equal(marker.textContent, '');
            geometry.add(svg.innerHTML);
        }
        assert.equal(geometry.size, cases.length, 'execution types need distinguishable icons');
        const marker = harness.container.querySelector('[data-item-id="tool"] .agent-activity-item-marker')!;
        const svg = marker.firstElementChild;
        harness.view.applyEvent({
            version: 1, eventId: 'icon-tool-completed', sessionId: DESIGNER_SESSION_ID, turnId,
            seq: 20, timestamp: 1_020, type: 'item.completed',
            item: { id: 'tool', kind: 'action', tool: 'web_fetch', status: 'completed', title: 'Read webpage' },
        }, DESIGNER_SESSION_ID);
        assert.equal(marker.firstElementChild, svg, 'same-category status updates preserve the marker node');
    } finally { harness.cleanup(); }
});

test('command text is complete, inert and separately patched without replacing its row or result detail', () => {
    const harness = createHarness();
    const turnId = 'command-text';
    const original = `Get-Content "C:\\项目\\文档.txt"\n${'Write-Output "<img src=x onerror=alert(1)> & 测试"; '.repeat(30)}`;
    let sequence = 0;
    const update = (patch: Partial<NonNullable<AgentEventV1['item']>>) => harness.view.applyEvent({
        version: 1, eventId: `command-${++sequence}`, sessionId: DESIGNER_SESSION_ID, turnId,
        seq: sequence, timestamp: 1_000 + sequence, type: 'item.updated',
        item: { id: 'command', kind: 'action', status: 'running', title: '执行命令', tool: 'windows', ...patch },
    }, DESIGNER_SESSION_ID);
    try {
        harness.view.applyEvent(turnStarted(turnId, 1_000), DESIGNER_SESSION_ID);
        update({ command: original, detail: '正在读取文件' });
        const row = harness.container.querySelector<HTMLElement>('[data-item-id="command"]')!;
        const code = row.querySelector<HTMLElement>('code.agent-activity-item-command')!;
        const detail = row.querySelector('.agent-activity-item-detail');
        assert.equal(code.textContent, original);
        assert.equal(row.querySelector('img, script'), null);
        assert.equal(detail?.textContent, '正在读取文件');
        assert.ok(row.classList.contains('category-cli'));
        const revised = 'Get-Date -Format "yyyy-MM-dd"';
        update({ command: revised, detail: '已读取 1280 个字符', status: 'completed' });
        assert.equal(harness.container.querySelector('[data-item-id="command"]'), row);
        assert.equal(row.querySelector('code.agent-activity-item-command'), code);
        assert.equal(code.textContent, revised);
        assert.equal(row.querySelector('.agent-activity-item-detail'), detail);
        assert.equal(detail?.textContent, '已读取 1280 个字符');
        update({ detail: '已完成读取', status: 'completed' });
        assert.equal(code.textContent, revised, 'an incremental update that omits command preserves it');
        update({ command: '', title: '检查窗口', detail: '已找到窗口', status: 'completed' });
        assert.equal(harness.container.querySelector('[data-item-id="command"]'), row);
        assert.equal(row.querySelector('.agent-activity-item-command'), null);
        assert.equal(row.querySelector('.agent-activity-item-detail')?.textContent, '已找到窗口');
        assert.ok(row.classList.contains('category-tool'));
    } finally { harness.cleanup(); }
});

test('Windows command aliases classify as CLI while non-command Windows actions remain tools', () => {
    const harness = createHarness();
    const turnId = 'windows-categories';
    const cases = [
        { tool: 'windows', title: '执行 PowerShell', expected: 'cli' },
        { tool: 'windows', title: '运行系统命令', expected: 'cli' },
        { tool: 'windows.system', title: '运行任务', expected: 'cli' },
        { tool: 'mcp.windows.powershell', title: '运行任务', expected: 'cli' },
        { tool: 'mcp__windows__system', title: '运行任务', expected: 'cli' },
        { tool: 'windows', title: '查看系统信息', expected: 'tool' },
        { tool: 'windows', title: '点击窗口', expected: 'tool' },
        { tool: 'custom_tool', title: '运行任务', command: 'echo ready', expected: 'cli' },
    ];
    try {
        harness.view.applyEvent(turnStarted(turnId, 1_000), DESIGNER_SESSION_ID);
        cases.forEach((item, index) => harness.view.applyEvent({
            version: 1, eventId: `windows-${index}`, sessionId: DESIGNER_SESSION_ID, turnId,
            seq: index + 1, timestamp: 1_001 + index, type: 'item.started',
            item: { id: `windows-${index}`, kind: 'action', status: 'running', tool: item.tool, title: item.title, command: item.command },
        }, DESIGNER_SESSION_ID));
        cases.forEach((item, index) => {
            const row = harness.container.querySelector(`[data-item-id="windows-${index}"]`)!;
            assert.ok(row.classList.contains(`category-${item.expected}`), `${item.tool}: ${item.title}`);
            assert.equal(row.querySelector<HTMLElement>('.agent-activity-item-marker')!.dataset.icon, item.expected);
        });
    } finally { harness.cleanup(); }
});

test('terminal activity outside the loaded message window stays hidden', () => {
    const oldTerminal = [
        turnStarted('old-turn', 1_000),
        turnCompleted('old-turn', 1_500),
    ];
    const currentTerminal = [
        turnStarted('current-turn', 2_500),
        turnCompleted('current-turn', 3_000),
    ];
    const orphanInsideLoadedHistory = [
        turnStarted('orphan-turn', 2_100),
        turnCompleted('orphan-turn', 2_200),
    ];
    const running = [turnStarted('running-turn', 500)];

    assert.equal(shouldRenderUnanchoredTurn(oldTerminal, 2_000, 2_400), false);
    assert.equal(shouldRenderUnanchoredTurn(currentTerminal, 2_000, 2_400), true);
    assert.equal(shouldRenderUnanchoredTurn(orphanInsideLoadedHistory, 2_000, 2_400), false);
    assert.equal(shouldRenderUnanchoredTurn(running, 2_000, 2_400), true);
    assert.equal(shouldRenderUnanchoredTurn(oldTerminal, undefined), true);
});

function turnStarted(turnId: string, timestamp: number): AgentEventV1 {
    return {
        version: 1,
        eventId: `${turnId}-turn-started`,
        sessionId: DESIGNER_SESSION_ID,
        turnId,
        seq: 0,
        timestamp,
        type: 'turn.started',
    };
}

function itemStarted(turnId: string, timestamp: number): AgentEventV1 {
    return {
        version: 1,
        eventId: `${turnId}-item-started`,
        sessionId: DESIGNER_SESSION_ID,
        turnId,
        seq: 1,
        timestamp,
        type: 'item.started',
        item: {
            id: `${turnId}-commentary`,
            kind: 'commentary',
            status: 'running',
            title: '正在生成标注设计',
        },
    };
}

function itemCompleted(turnId: string, timestamp: number): AgentEventV1 {
    return {
        version: 1,
        eventId: `${turnId}-item-completed`,
        sessionId: DESIGNER_SESSION_ID,
        turnId,
        seq: 2,
        timestamp,
        type: 'item.completed',
        item: {
            id: `${turnId}-commentary`,
            kind: 'commentary',
            status: 'completed',
            title: '正在生成标注设计',
        },
    };
}

function turnCompleted(turnId: string, timestamp: number): AgentEventV1 {
    return {
        version: 1,
        eventId: `${turnId}-turn-completed`,
        sessionId: DESIGNER_SESSION_ID,
        turnId,
        seq: 3,
        timestamp,
        type: 'turn.completed',
        durationMs: 250,
        summary: '设计生成完成',
    };
}

interface ActivityHarness {
    container: HTMLElement;
    view: ActivityViewController;
    cleanup: () => void;
}

function createHarness(): ActivityHarness {
    const dom = new JSDOM('<!doctype html><div id="messages"></div>', {
        pretendToBeVisual: true,
        url: 'http://localhost/',
    });
    const previousGlobals = new Map<string, { exists: boolean; value: unknown }>();
    const globals = {
        window: dom.window,
        document: dom.window.document,
        HTMLElement: dom.window.HTMLElement,
        requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
        cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    };

    for (const [key, value] of Object.entries(globals)) {
        previousGlobals.set(key, {
            exists: Object.prototype.hasOwnProperty.call(globalThis, key),
            value: (globalThis as Record<string, unknown>)[key],
        });
        Object.defineProperty(globalThis, key, {
            configurable: true,
            writable: true,
            value,
        });
    }

    const container = dom.window.document.getElementById('messages') as HTMLElement;
    const view = new ActivityViewController(container);

    return {
        container,
        view,
        cleanup: () => {
            view.destroy();
            dom.window.close();
            for (const [key, previous] of previousGlobals.entries()) {
                if (previous.exists) {
                    Object.defineProperty(globalThis, key, {
                        configurable: true,
                        writable: true,
                        value: previous.value,
                    });
                } else {
                    delete (globalThis as Record<string, unknown>)[key];
                }
            }
        },
    };
}

test('restores durable completed history collapsed as soon as its session becomes active', () => {
    const harness = createHarness();
    const turnId = 'background-turn';

    try {
        const events = [
            turnStarted(turnId, 1_000),
            itemStarted(turnId, 1_050),
            itemCompleted(turnId, 1_200),
            turnCompleted(turnId, 1_250),
        ];
        for (const event of events) harness.view.cacheEvent(event, true);

        assert.equal(harness.container.querySelector('.agent-activity'), null);

        assert.equal(harness.view.restoreSession(DESIGNER_SESSION_ID), true);

        const activity = harness.container.querySelector<HTMLElement>(
            `.agent-activity[data-turn-id="${turnId}"]`,
        );
        assert.ok(activity, 'activating the session should synchronously render its cached Processed card');
        assert.equal(activity.dataset.sessionId, DESIGNER_SESSION_ID);
        assert.ok(activity.classList.contains('status-completed'));
        assert.ok(activity.classList.contains('collapsed'));
        assert.equal(activity.querySelector('.agent-activity-item'), null);
        activity.querySelector<HTMLButtonElement>('.agent-activity-header')?.click();
        assert.equal(
            activity.querySelector('.agent-activity-item-title')?.textContent,
            '正在生成标注设计',
        );
        assert.equal(
            activity.querySelector('.agent-activity-header')?.getAttribute('aria-expanded'),
            'true',
        );

        for (const event of events) harness.view.cacheEvent(event, true);
        harness.container.replaceChildren();
        harness.view.restoreSession(DESIGNER_SESSION_ID);
        assert.equal(
            harness.container.querySelector('.agent-activity')?.classList.contains('collapsed'),
            false,
            'rehydrating duplicate history must preserve the user expansion',
        );
    } finally {
        harness.cleanup();
    }
});

test('history terminal stays expanded when its assistant output is absent from the loaded snapshot', () => {
    const harness = createHarness();
    const turnId = 'history-output-race';
    try {
        for (const event of [
            turnStarted(turnId, 1_000),
            itemStarted(turnId, 1_010),
            itemCompleted(turnId, 1_020),
            turnCompleted(turnId, 1_030),
        ]) harness.view.cacheEvent(event, false);

        harness.view.restoreTurn(DESIGNER_SESSION_ID, turnId);
        const activity = harness.container.querySelector<HTMLElement>('.agent-activity')!;
        assert.equal(activity.classList.contains('collapsed'), false);
        assert.equal(activity.querySelectorAll('.agent-activity-item').length, 1);

        // A later history refresh that includes the matching reply may now
        // consume the automatic collapse without reducing a new event.
        harness.view.cacheEvent(turnCompleted(turnId, 1_030), true);
        harness.view.restoreTurn(DESIGNER_SESSION_ID, turnId);
        assert.equal(activity.classList.contains('collapsed'), true);
    } finally { harness.cleanup(); }
});

test('omits legacy model telemetry from the user activity timeline', () => {
    const harness = createHarness();
    const turnId = 'legacy-model-turn';

    try {
        harness.view.applyEvent(turnStarted(turnId, 1_000), DESIGNER_SESSION_ID);
        harness.view.applyEvent({
            version: 1,
            eventId: `${turnId}-model-completed`,
            sessionId: DESIGNER_SESSION_ID,
            turnId,
            seq: 1,
            timestamp: 1_200,
            type: 'item.completed',
            item: {
                id: `${turnId}-model`,
                kind: 'model',
                status: 'completed',
                title: 'Model response received',
                detail: 'moonshot/kimi-k3 · first chunk 820ms · total 2.4s',
            },
        }, DESIGNER_SESSION_ID);

        assert.equal(harness.container.querySelector('.agent-activity-item'), null);
        assert.doesNotMatch(harness.container.textContent || '', /model response|moonshot|kimi-k3|first chunk|total 2\.4s/i);
    } finally {
        harness.cleanup();
    }
});

test('keeps rationale and tool calls inline in chronological order', () => {
    const harness = createHarness();
    const turnId = 'purpose-first-turn';

    try {
        harness.view.applyEvent(turnStarted(turnId, 1_000), DESIGNER_SESSION_ID);
        harness.view.applyEvent({
            version: 1,
            eventId: `${turnId}-commentary`,
            sessionId: DESIGNER_SESSION_ID,
            turnId,
            seq: 1,
            timestamp: 1_010,
            type: 'item.completed',
            item: {
                id: 'why-this-step',
                kind: 'commentary',
                status: 'completed',
                title: '为了确认新闻事实，我会核对公开来源和原文。',
            },
        }, DESIGNER_SESSION_ID);
        harness.view.applyEvent({
            version: 1,
            eventId: `${turnId}-tool`,
            sessionId: DESIGNER_SESSION_ID,
            turnId,
            seq: 2,
            timestamp: 1_020,
            type: 'item.completed',
            item: {
                id: 'fetch-tool',
                kind: 'action',
                status: 'completed',
                title: '调用 web_fetch',
                tool: 'web_fetch',
            },
        }, DESIGNER_SESSION_ID);
        harness.view.applyEvent({
            version: 1,
            eventId: `${turnId}-checkpoint`,
            sessionId: DESIGNER_SESSION_ID,
            turnId,
            seq: 3,
            timestamp: 1_030,
            type: 'item.completed',
            item: {
                id: 'raw-tool-checkpoint',
                kind: 'checkpoint',
                status: 'completed',
                title: '阶段 1 已完成：web_fetch',
            },
        }, DESIGNER_SESSION_ID);

        const mainItems = harness.container.querySelectorAll(
            '.agent-activity-items .agent-activity-item',
        );
        assert.equal(mainItems.length, 2);
        assert.match(mainItems[0]?.textContent || '', /为了确认新闻事实/);
        assert.match(mainItems[1]?.textContent || '', /web_fetch/);
        assert.equal(harness.container.querySelector('.agent-activity-technical'), null);
        assert.equal(harness.container.querySelector('[data-item-id="raw-tool-checkpoint"]'), null);
    } finally {
        harness.cleanup();
    }
});

test('places accepted guidance inline between the surrounding execution steps', () => {
    const harness = createHarness();
    const turnId = 'guided-turn';

    try {
        harness.view.applyEvent(turnStarted(turnId, 1_000), DESIGNER_SESSION_ID);
        const items: AgentEventV1[] = [
            {
                version: 1,
                eventId: 'before-guidance',
                sessionId: DESIGNER_SESSION_ID,
                turnId,
                seq: 1,
                timestamp: 1_010,
                type: 'item.completed',
                item: {
                    id: 'before',
                    kind: 'commentary',
                    status: 'completed',
                    title: 'Checking the original report.',
                },
            },
            {
                version: 1,
                eventId: 'accepted-guidance',
                sessionId: DESIGNER_SESSION_ID,
                turnId,
                seq: 2,
                timestamp: 1_020,
                type: 'item.completed',
                item: {
                    id: 'guidance-steer-42',
                    kind: 'guidance',
                    status: 'completed',
                    title: 'Make the angle more controversial.',
                },
            },
            {
                version: 1,
                eventId: 'after-guidance',
                sessionId: DESIGNER_SESSION_ID,
                turnId,
                seq: 3,
                timestamp: 1_030,
                type: 'item.completed',
                item: {
                    id: 'after',
                    kind: 'action',
                    status: 'completed',
                    title: 'Search for public reactions',
                    tool: 'web_search',
                },
            },
        ];
        for (const event of items) harness.view.applyEvent(event, DESIGNER_SESSION_ID);

        const rendered = [...harness.container.querySelectorAll<HTMLElement>(
            '.agent-activity-items .agent-activity-item',
        )];
        assert.deepEqual(rendered.map(item => item.dataset.itemId), [
            'before',
            'guidance-steer-42',
            'after',
        ]);
        assert.ok(rendered[1].classList.contains('category-guidance'));
        assert.match(rendered[1].textContent || '', /Make the angle more controversial\./);
        assert.ok(rendered[1].querySelector('.agent-activity-item-status'));
    } finally {
        harness.cleanup();
    }
});

test('renders goal reconciliation as one updating Process item', () => {
    const harness = createHarness();
    const turnId = 'goal-revision-turn';
    try {
        harness.view.applyEvent(turnStarted(turnId, 1_000), DESIGNER_SESSION_ID);
        harness.view.applyEvent({
            version: 1,
            eventId: 'goal-revision-started',
            sessionId: DESIGNER_SESSION_ID,
            turnId,
            seq: 1,
            timestamp: 1_050,
            type: 'item.started',
            item: {
                id: 'goal-update-steer-1',
                kind: 'goal_update',
                status: 'running',
                title: '正在根据新引导修订任务目标…',
            },
        }, DESIGNER_SESSION_ID);

        let row = harness.container.querySelector<HTMLElement>('.category-goal_update');
        assert.ok(row);
        assert.match(row.textContent || '', /正在根据新引导修订任务目标/);

        harness.view.applyEvent({
            version: 1,
            eventId: 'goal-revision-completed',
            sessionId: DESIGNER_SESSION_ID,
            turnId,
            seq: 2,
            timestamp: 1_150,
            type: 'item.completed',
            item: {
                id: 'goal-update-steer-1',
                kind: 'goal_update',
                status: 'completed',
                title: '任务目标已修订',
                detail: '新增：输出 CSV\n保留：校验数据',
            },
        }, DESIGNER_SESSION_ID);

        const rows = harness.container.querySelectorAll<HTMLElement>('.category-goal_update');
        assert.equal(rows.length, 1);
        row = rows[0];
        assert.match(row.textContent || '', /任务目标已修订/);
        assert.match(row.textContent || '', /新增：输出 CSV/);
    } finally {
        harness.cleanup();
    }
});

test('upgrades legacy guidance commentary without showing its transport prefix', () => {
    const harness = createHarness();
    const turnId = 'legacy-guidance-turn';

    try {
        harness.view.applyEvent(turnStarted(turnId, 1_000), DESIGNER_SESSION_ID);
        harness.view.applyEvent({
            version: 1,
            eventId: 'legacy-guidance',
            sessionId: DESIGNER_SESSION_ID,
            turnId,
            seq: 1,
            timestamp: 1_010,
            type: 'item.completed',
            item: {
                id: 'legacy-commentary',
                kind: 'commentary',
                status: 'completed',
                title: 'New user guidance received; it will be applied after the current step: Add a sharper conclusion.',
            },
        }, DESIGNER_SESSION_ID);

        const guidance = harness.container.querySelector<HTMLElement>('.category-guidance');
        assert.ok(guidance);
        assert.equal(
            guidance.querySelector('.agent-activity-item-title')?.textContent,
            'Add a sharper conclusion.',
        );
        assert.doesNotMatch(guidance.textContent || '', /New user guidance received/);
    } finally {
        harness.cleanup();
    }
});

test('suppresses only steer bubbles that have a durable guidance event', () => {
    const turnsWithGuidance = new Set(['guided-turn']);
    assert.equal(isSteerMessageRepresentedInActivity({
        role: 'user',
        metadata: { kind: 'steer', turnId: 'guided-turn' },
    }, turnsWithGuidance), true);
    assert.equal(isSteerMessageRepresentedInActivity({
        role: 'user',
        metadata: { kind: 'steer', turnId: 'missing-guidance-turn' },
    }, turnsWithGuidance), false);
    assert.equal(isSteerMessageRepresentedInActivity({
        role: 'user',
        metadata: { kind: 'steer' },
    }, turnsWithGuidance), false);
});

test('keeps failed tools visible in the main timeline', () => {
    const harness = createHarness();
    const turnId = 'failed-tool-turn';
    try {
        harness.view.applyEvent(turnStarted(turnId, 1_000), DESIGNER_SESSION_ID);
        harness.view.applyEvent({
            version: 1,
            eventId: `${turnId}-failed`,
            sessionId: DESIGNER_SESSION_ID,
            turnId,
            seq: 1,
            timestamp: 1_010,
            type: 'item.failed',
            item: {
                id: 'failed-fetch',
                kind: 'action',
                status: 'failed',
                title: '获取新闻原文失败',
                tool: 'web_fetch',
            },
        }, DESIGNER_SESSION_ID);

        assert.match(
            harness.container.querySelector('.agent-activity-items')?.textContent || '',
            /获取新闻原文失败/,
        );
    } finally {
        harness.cleanup();
    }
});

test('reveals a matching approval prompt and exposes explicit allow and deny actions', () => {
    const harness = createHarness();
    const turnId = 'approval-turn';
    const requestId = 'approval-request';
    try {
        harness.view.applyEvent(turnStarted(turnId, 1_000), DESIGNER_SESSION_ID);
        harness.view.applyEvent({
            version: 1,
            eventId: `${turnId}-approval`,
            sessionId: DESIGNER_SESSION_ID,
            turnId,
            seq: 1,
            timestamp: 1_010,
            type: 'item.started',
            item: {
                id: `approval-${requestId}`,
                kind: 'approval',
                status: 'waiting',
                title: 'Waiting for approval: process',
            },
        }, DESIGNER_SESSION_ID);
        harness.container.querySelector<HTMLButtonElement>('.agent-activity-header')?.click();
        assert.ok(harness.container.querySelector('.agent-activity')?.classList.contains('collapsed'));

        let decision: boolean | undefined;
        harness.view.presentApproval({
            requestId,
            sessionId: DESIGNER_SESSION_ID,
            turnId,
            toolName: 'process',
            risk: 'medium',
            reason: 'Executing a local process',
            argsPreview: '{"action":"run"}',
        }, approved => {
            decision = approved;
        });

        const activity = harness.container.querySelector('.agent-activity');
        assert.equal(activity?.classList.contains('collapsed'), false);
        const prompt = harness.container.querySelector<HTMLElement>(
            `[data-approval-request-id="${requestId}"]`,
        );
        assert.ok(prompt);
        const buttons = prompt.querySelectorAll<HTMLButtonElement>('.agent-activity-approval-button');
        assert.equal(buttons.length, 2);
        prompt.querySelector<HTMLButtonElement>('.agent-activity-approval-button.allow')?.click();
        assert.equal(decision, true);
    } finally {
        harness.cleanup();
    }
});

test('rebuilds both running and terminal activity cards after the messages DOM is redrawn', () => {
    const harness = createHarness();
    const runningTurnId = 'running-turn';
    const completedTurnId = 'completed-turn';

    try {
        harness.view.applyEvent(turnStarted(runningTurnId, 2_000), DESIGNER_SESSION_ID);
        harness.view.applyEvent(itemStarted(runningTurnId, 2_050), DESIGNER_SESSION_ID);

        harness.view.applyEvent(turnStarted(completedTurnId, 3_000), DESIGNER_SESSION_ID);
        harness.view.applyEvent(itemStarted(completedTurnId, 3_050), DESIGNER_SESSION_ID);
        harness.view.applyEvent(itemCompleted(completedTurnId, 3_200), DESIGNER_SESSION_ID);
        harness.view.applyEvent(turnCompleted(completedTurnId, 3_250), DESIGNER_SESSION_ID);

        assert.equal(harness.container.querySelectorAll('.agent-activity').length, 2);

        const assistant = harness.container.ownerDocument.createElement('div');
        assistant.className = 'message assistant';
        assistant.dataset.turnId = completedTurnId;
        harness.container.replaceChildren(assistant);
        assert.equal(harness.container.querySelectorAll('.agent-activity').length, 0);

        assert.equal(harness.view.restoreSession(DESIGNER_SESSION_ID), true);

        const running = harness.container.querySelector<HTMLElement>(
            `.agent-activity[data-turn-id="${runningTurnId}"]`,
        );
        const completed = harness.container.querySelector<HTMLElement>(
            `.agent-activity[data-turn-id="${completedTurnId}"]`,
        );
        assert.ok(running, 'the running card should be reattached after the redraw');
        assert.ok(completed, 'the terminal card should be reattached after the redraw');
        assert.ok(running.classList.contains('status-running'));
        assert.ok(completed.classList.contains('status-completed'));
        assert.equal(completed.nextElementSibling, assistant, 'restored activity stays before its final reply');
    } finally {
        harness.cleanup();
    }
});

test('manually expanding a long completed process keeps the current scroll position', async () => {
    const harness = createHarness();
    const turnId = 'manual-expand-position';
    try {
        Object.defineProperties(harness.container, {
            scrollHeight: { configurable: true, get: () => 1_200 },
            clientHeight: { configurable: true, get: () => 400 },
        });
        harness.view.applyEvent(turnStarted(turnId, 1_000), DESIGNER_SESSION_ID);
        harness.view.applyEvent(itemStarted(turnId, 1_010), DESIGNER_SESSION_ID);
        harness.view.applyEvent(itemCompleted(turnId, 1_020), DESIGNER_SESSION_ID);
        harness.view.applyEvent(turnCompleted(turnId, 1_030), DESIGNER_SESSION_ID);
        harness.view.collapseAfterOutput(DESIGNER_SESSION_ID, turnId);
        await new Promise(resolve => setTimeout(resolve, 30));

        harness.container.scrollTop = 800;
        harness.container.querySelector<HTMLButtonElement>('.agent-activity-header')!.click();
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(harness.container.scrollTop, 800);
        assert.equal(harness.container.querySelectorAll('.agent-activity-item').length, 1);
    } finally { harness.cleanup(); }
});

test('patches an existing activity row in place without replacing its DOM node', () => {
    const harness = createHarness();
    const turnId = 'stable-row-turn';
    try {
        harness.view.applyEvent(turnStarted(turnId, 1_000), DESIGNER_SESSION_ID);
        harness.view.applyEvent({
            version: 1,
            eventId: 'stable-row-start',
            sessionId: DESIGNER_SESSION_ID,
            turnId,
            seq: 1,
            timestamp: 1_010,
            type: 'item.started',
            item: {
                id: 'stable-action',
                kind: 'action',
                status: 'running',
                title: '读取配置文件',
                tool: 'filesystem',
            },
        }, DESIGNER_SESSION_ID);
        const before = harness.container.querySelector<HTMLElement>('[data-item-id="stable-action"]');
        assert.ok(before);

        harness.view.applyEvent({
            version: 1,
            eventId: 'stable-row-complete',
            sessionId: DESIGNER_SESSION_ID,
            turnId,
            seq: 2,
            timestamp: 1_020,
            type: 'item.completed',
            item: {
                id: 'stable-action',
                kind: 'action',
                status: 'completed',
                title: '读取配置文件',
                detail: '已读取 1280 个字符',
                tool: 'filesystem',
            },
        }, DESIGNER_SESSION_ID);

        const after = harness.container.querySelector<HTMLElement>('[data-item-id="stable-action"]');
        assert.equal(after, before);
        assert.ok(after?.classList.contains('status-completed'));
        assert.match(after?.textContent || '', /1280/);
    } finally {
        harness.cleanup();
    }
});

test('hides redundant completed copy but keeps meaningful action results', () => {
    const harness = createHarness();
    const turnId = 'concise-completion-turn';
    try {
        harness.view.applyEvent(turnStarted(turnId, 1_000), DESIGNER_SESSION_ID);
        harness.view.applyEvent({
            version: 1,
            eventId: 'generic-completion',
            sessionId: DESIGNER_SESSION_ID,
            turnId,
            seq: 1,
            timestamp: 1_010,
            type: 'item.completed',
            item: {
                id: 'generic-filesystem-result',
                kind: 'action',
                status: 'completed',
                title: '读取文件',
                detail: '已完成 filesystem',
                tool: 'filesystem',
            },
        }, DESIGNER_SESSION_ID);
        harness.view.applyEvent({
            version: 1,
            eventId: 'meaningful-completion',
            sessionId: DESIGNER_SESSION_ID,
            turnId,
            seq: 2,
            timestamp: 1_020,
            type: 'item.completed',
            item: {
                id: 'meaningful-filesystem-result',
                kind: 'action',
                status: 'completed',
                title: '写入文件',
                detail: '已写入 1280 字节',
                tool: 'filesystem',
            },
        }, DESIGNER_SESSION_ID);

        const generic = harness.container.querySelector<HTMLElement>('[data-item-id="generic-filesystem-result"]');
        const meaningful = harness.container.querySelector<HTMLElement>('[data-item-id="meaningful-filesystem-result"]');
        assert.equal(generic?.querySelector('.agent-activity-item-detail'), null);
        assert.equal(generic?.querySelector<HTMLElement>('.agent-activity-item-status')?.hidden, true);
        assert.match(meaningful?.querySelector('.agent-activity-item-detail')?.textContent || '', /1280/);
    } finally {
        harness.cleanup();
    }
});

test('keeps every live step in conversation flow and collapses only after final output', () => {
    const harness = createHarness();
    const turnId = 'windowed-turn';
    try {
        harness.view.applyEvent(turnStarted(turnId, 1_000), DESIGNER_SESSION_ID);
        for (let index = 1; index <= 12; index += 1) {
            harness.view.applyEvent({
                version: 1,
                eventId: `windowed-item-${index}`,
                sessionId: DESIGNER_SESSION_ID,
                turnId,
                seq: index,
                timestamp: 1_000 + index,
                type: 'item.completed',
                item: {
                    id: `step-${index}`,
                    kind: 'commentary',
                    status: 'completed',
                    title: `完成步骤 ${index}`,
                },
            }, DESIGNER_SESSION_ID);
        }

        const liveIds = [...harness.container.querySelectorAll<HTMLElement>('.agent-activity-item')]
            .map(item => item.dataset.itemId);
        assert.deepEqual(liveIds, Array.from({ length: 12 }, (_, index) => `step-${index + 1}`));
        assert.equal(harness.container.querySelector('.agent-activity')?.classList.contains('live-window'), false);

        harness.view.applyEvent({
            ...turnCompleted(turnId, 2_000),
            eventId: 'windowed-complete',
            seq: 99,
        }, DESIGNER_SESSION_ID);
        assert.equal(harness.container.querySelectorAll('.agent-activity-item').length, 12);
        assert.equal(harness.container.querySelector('.agent-activity')?.classList.contains('collapsed'), false);

        assert.equal(harness.view.collapseAfterOutput(DESIGNER_SESSION_ID, turnId), true);
        assert.equal(harness.container.querySelector('.agent-activity-item'), null);
        assert.ok(harness.container.querySelector('.agent-activity')?.classList.contains('collapsed'));

        harness.container.querySelector<HTMLButtonElement>('.agent-activity-header')?.click();
        assert.equal(harness.container.querySelectorAll('.agent-activity-item').length, 12);
        assert.ok(harness.container.querySelector('.agent-activity')?.classList.contains('history-view'));
    } finally {
        harness.cleanup();
    }
});

test('keeps an older pending approval alongside every later live step', () => {
    const harness = createHarness();
    const turnId = 'pinned-approval-turn';
    try {
        harness.view.applyEvent(turnStarted(turnId, 1_000), DESIGNER_SESSION_ID);
        harness.view.applyEvent({
            version: 1,
            eventId: 'old-approval',
            sessionId: DESIGNER_SESSION_ID,
            turnId,
            seq: 1,
            timestamp: 1_001,
            type: 'item.started',
            item: {
                id: 'approval-old',
                kind: 'approval',
                status: 'waiting',
                title: '等待确认',
            },
        }, DESIGNER_SESSION_ID);
        for (let index = 2; index <= 12; index += 1) {
            harness.view.applyEvent({
                version: 1,
                eventId: `post-approval-${index}`,
                sessionId: DESIGNER_SESSION_ID,
                turnId,
                seq: index,
                timestamp: 1_000 + index,
                type: 'item.completed',
                item: {
                    id: `later-${index}`,
                    kind: 'action',
                    status: 'completed',
                    title: `动作 ${index}`,
                },
            }, DESIGNER_SESSION_ID);
        }

        assert.ok(harness.container.querySelector('[data-item-id="approval-old"]'));
        assert.equal(harness.container.querySelectorAll('.agent-activity-item').length, 12);
    } finally {
        harness.cleanup();
    }
});

test('omits the exact repetitive commentary emitted by legacy Gateway fallbacks', () => {
    const harness = createHarness();
    const turnId = 'legacy-boilerplate-turn';
    try {
        harness.view.applyEvent(turnStarted(turnId, 1_000), DESIGNER_SESSION_ID);
        harness.view.applyEvent({
            version: 1,
            eventId: 'legacy-boilerplate',
            sessionId: DESIGNER_SESSION_ID,
            turnId,
            seq: 1,
            timestamp: 1_010,
            type: 'item.completed',
            item: {
                id: 'legacy-boilerplate-item',
                kind: 'commentary',
                status: 'completed',
                title: '为完成“生成两篇模块文档”，我会先检查相关文件和当前运行状态，确认可修改范围后再执行。',
            },
        }, DESIGNER_SESSION_ID);

        assert.equal(harness.container.querySelector('.agent-activity-item'), null);
        assert.doesNotMatch(harness.container.textContent || '', /为完成/);
    } finally {
        harness.cleanup();
    }
});

test('actions fold under the narrative row that states their purpose; the summary opens them', () => {
    const harness = createHarness();
    const turnId = 'purpose-groups';
    const event = (seq: number, type: AgentEventV1['type'], item: AgentEventV1['item']): AgentEventV1 => ({
        version: 1, eventId: `${turnId}-${seq}`, sessionId: DESIGNER_SESSION_ID, turnId, seq, timestamp: 1_000 + seq, type, item,
    });
    try {
        harness.view.applyEvent(turnStarted(turnId, 1_000), DESIGNER_SESSION_ID);
        harness.view.applyEvent(event(1, 'item.completed', { id: 'c1', kind: 'commentary', status: 'completed', title: '先调研付款相关代码' }), DESIGNER_SESSION_ID);
        harness.view.applyEvent(event(2, 'item.completed', { id: 'a1', kind: 'action', status: 'completed', title: '读取文件：PaymentList.vue', tool: 'filesystem', phaseId: 'c1' }), DESIGNER_SESSION_ID);
        harness.view.applyEvent(event(3, 'item.completed', { id: 'a2', kind: 'action', status: 'completed', title: '读取文件：PaymentController.php', tool: 'filesystem', phaseId: 'c1' }), DESIGNER_SESSION_ID);
        harness.view.applyEvent(event(4, 'item.completed', { id: 'a3', kind: 'action', status: 'completed', title: '执行命令', tool: 'process', command: 'npm test', phaseId: 'c1' }), DESIGNER_SESSION_ID);
        harness.view.applyEvent(event(5, 'item.completed', { id: 'c2', kind: 'commentary', status: 'completed', title: '调研完成，开始实现' }), DESIGNER_SESSION_ID);

        const groups = harness.container.querySelectorAll('.agent-activity-group');
        assert.equal(groups.length, 2, 'one group per narrative row');
        const first = groups[0] as HTMLElement;
        assert.ok(first.classList.contains('has-members'));
        const buckets = first.querySelectorAll<HTMLElement>('.agent-activity-bucket');
        assert.equal(buckets.length, 2, 'reads and commands fold separately');
        const readSummary = buckets[0].querySelector<HTMLButtonElement>('.agent-activity-group-summary')!;
        assert.match(readSummary.textContent || '', /(读取文件|Read files|activity\.group_read)/);
        assert.match(buckets[1].querySelector('.agent-activity-group-summary')?.textContent || '', /(运行命令|Ran commands|activity\.group_command)/);
        const readBody = buckets[0].querySelector<HTMLElement>('.agent-activity-group-body')!;
        assert.equal(readBody.hidden, true, 'steps stay folded by default');
        assert.equal(readBody.querySelectorAll('.agent-activity-item').length, 2);
        assert.equal(buckets[0].classList.contains('expanded'), false);
        readSummary.click();
        assert.equal(readBody.hidden, false, 'clicking the summary reveals the steps');
        assert.equal(buckets[0].classList.contains('expanded'), true, 'open state turns the chevron down');
        assert.equal(groups[1].querySelector('.agent-activity-group-summary'), null, 'a narrative row with no actions has no summary');
    } finally {
        harness.cleanup();
    }
});

function activeStepSubjects(container: HTMLElement): string[] {
    return [...container.querySelectorAll<HTMLElement>('.agent-activity-group-summary.is-active')]
        .map(summary => summary.querySelector('.agent-activity-group-current')?.textContent || '');
}

test('late updates to earlier completed steps do not move the active summary backwards', () => {
    const harness = createHarness();
    const turnId = 'stable-step-focus';
    let seq = 0;
    const emit = (type: AgentEventV1['type'], item: AgentEventV1['item']) => harness.view.applyEvent({
        version: 1, eventId: `${turnId}-${++seq}`, sessionId: DESIGNER_SESSION_ID, turnId, seq,
        timestamp: 1_000 + seq, type, item,
    }, DESIGNER_SESSION_ID);
    const first = { id: 'first', kind: 'action' as const, tool: 'filesystem', title: '读取文件：first.ts' };
    const second = { id: 'second', kind: 'action' as const, tool: 'filesystem', title: '读取文件：second.ts' };
    try {
        harness.view.applyEvent(turnStarted(turnId, 1_000), DESIGNER_SESSION_ID);
        emit('item.started', { ...first, status: 'running' });
        assert.deepEqual(activeStepSubjects(harness.container), ['first.ts']);
        emit('item.completed', { ...first, status: 'completed' });
        emit('item.started', { ...second, status: 'running' });
        assert.deepEqual(activeStepSubjects(harness.container), ['second.ts']);
        emit('item.completed', { ...second, status: 'completed' });
        const secondRow = harness.container.querySelector('[data-item-id="second"]');
        emit('item.updated', { ...first, status: 'completed', detail: 'late supplemental result' });
        assert.deepEqual(activeStepSubjects(harness.container), ['second.ts']);
        assert.equal(harness.container.querySelector('[data-item-id="second"]'), secondRow);
        assert.match(harness.container.querySelector('[data-item-id="first"]')?.textContent || '', /late supplemental result/);
        emit('item.completed', { ...first, status: 'completed', detail: 'replayed completion' });
        assert.deepEqual(activeStepSubjects(harness.container), ['second.ts']);
        emit('turn.completed', undefined);
        assert.deepEqual(activeStepSubjects(harness.container), []);
    } finally { harness.cleanup(); }
});

test('older parallel progress cannot steal the current subject but unfinished work remains active', () => {
    const harness = createHarness();
    const turnId = 'parallel-step-focus';
    let seq = 0;
    const emit = (type: AgentEventV1['type'], item: AgentEventV1['item']) => harness.view.applyEvent({
        version: 1, eventId: `${turnId}-${++seq}`, sessionId: DESIGNER_SESSION_ID, turnId, seq,
        timestamp: 1_000 + seq, type, item,
    }, DESIGNER_SESSION_ID);
    const first = { id: 'parallel-first', kind: 'action' as const, tool: 'filesystem', title: '读取文件：first.ts' };
    const second = { id: 'parallel-second', kind: 'action' as const, tool: 'filesystem', title: '读取文件：second.ts' };
    try {
        harness.view.applyEvent(turnStarted(turnId, 1_000), DESIGNER_SESSION_ID);
        emit('item.started', { ...first, status: 'running' });
        emit('item.started', { ...second, status: 'running' });
        assert.deepEqual(activeStepSubjects(harness.container), ['second.ts']);
        emit('item.updated', { ...first, status: 'running', detail: 'first is still running' });
        assert.deepEqual(activeStepSubjects(harness.container), ['second.ts']);
        emit('item.completed', { ...second, status: 'completed' });
        assert.deepEqual(activeStepSubjects(harness.container), ['first.ts'], 'the earlier step is actually still executing');
        emit('item.completed', { ...first, status: 'completed' });
        assert.deepEqual(activeStepSubjects(harness.container), ['second.ts'], 'the thinking gap retains the last started step');
    } finally { harness.cleanup(); }
});

test('new phase commentary clears completed old-phase effects while preserving real parallel work', () => {
    const harness = createHarness();
    const turnId = 'phase-step-focus';
    let seq = 0;
    const emit = (type: AgentEventV1['type'], item: AgentEventV1['item']) => harness.view.applyEvent({
        version: 1, eventId: `${turnId}-${++seq}`, sessionId: DESIGNER_SESSION_ID, turnId, seq,
        timestamp: 1_000 + seq, type, item,
    }, DESIGNER_SESSION_ID);
    const first = { id: 'phase-first', kind: 'action' as const, tool: 'filesystem', title: '读取文件：first.ts', phaseId: 'phase-one' };
    try {
        harness.view.applyEvent(turnStarted(turnId, 1_000), DESIGNER_SESSION_ID);
        emit('item.completed', { id: 'phase-one', kind: 'commentary', status: 'completed', title: 'Inspect the source files' });
        emit('item.started', { ...first, status: 'running' });
        emit('item.completed', { id: 'phase-two', kind: 'commentary', status: 'completed', title: 'Prepare the report' });
        assert.deepEqual(activeStepSubjects(harness.container), ['first.ts'], 'a phase change does not stop an executing step');
        emit('item.completed', { ...first, status: 'completed' });
        assert.deepEqual(activeStepSubjects(harness.container), [], 'completed work does not impersonate the new phase');
        emit('item.updated', { ...first, status: 'completed', detail: 'late report metadata' });
        assert.deepEqual(activeStepSubjects(harness.container), []);
        emit('item.started', { id: 'report', kind: 'action', tool: 'process', status: 'running', title: '执行命令', command: 'build-report', phaseId: 'phase-two' });
        assert.deepEqual(activeStepSubjects(harness.container), ['build-report']);
    } finally { harness.cleanup(); }
});

test('concurrent buckets keep their own execution effects and terminal turns clear them', () => {
    const harness = createHarness();
    const turnId = 'parallel-bucket-focus';
    let seq = 0;
    const emit = (type: AgentEventV1['type'], item: AgentEventV1['item']) => harness.view.applyEvent({
        version: 1, eventId: `${turnId}-${++seq}`, sessionId: DESIGNER_SESSION_ID, turnId, seq,
        timestamp: 1_000 + seq, type, item,
    }, DESIGNER_SESSION_ID);
    try {
        harness.view.applyEvent(turnStarted(turnId, 1_000), DESIGNER_SESSION_ID);
        emit('item.started', { id: 'read', kind: 'action', tool: 'filesystem', status: 'running', title: '读取文件：source.ts' });
        emit('item.started', { id: 'child', kind: 'subagent', tool: 'spawn', status: 'running', title: '助手任务：Review source' });
        assert.deepEqual(activeStepSubjects(harness.container), ['source.ts', 'Review source']);
        emit('item.completed', { id: 'read', kind: 'action', tool: 'filesystem', status: 'completed', title: '读取文件：source.ts' });
        assert.deepEqual(activeStepSubjects(harness.container), ['Review source']);
        emit('turn.interrupted', undefined);
        assert.deepEqual(activeStepSubjects(harness.container), []);
    } finally { harness.cleanup(); }
});

test('replayed late starts and running progress cannot revive a settled old-phase action', () => {
    const harness = createHarness();
    const turnId = 'settled-step-replay';
    let seq = 0;
    const emit = (type: AgentEventV1['type'], item: AgentEventV1['item']) => harness.view.applyEvent({
        version: 1, eventId: `${turnId}-${++seq}`, sessionId: DESIGNER_SESSION_ID, turnId, seq,
        timestamp: 1_000 + seq, type, item,
    }, DESIGNER_SESSION_ID);
    try {
        harness.view.applyEvent(turnStarted(turnId, 1_000), DESIGNER_SESSION_ID);
        emit('item.completed', { id: 'old-phase', kind: 'commentary', status: 'completed', title: 'Old phase' });
        const old = { id: 'old', kind: 'action' as const, tool: 'process', title: '执行命令', command: 'old-command', phaseId: 'old-phase' };
        emit('item.started', { ...old, status: 'running' });
        emit('item.completed', { ...old, status: 'completed' });
        emit('item.completed', { id: 'new-phase', kind: 'commentary', status: 'completed', title: 'New phase' });
        emit('item.completed', { id: 'new', kind: 'action', tool: 'process', status: 'completed', title: '执行命令', command: 'new-command', phaseId: 'new-phase' });
        for (const type of ['item.started', 'item.updated'] as const) {
            const state = emit(type, { ...old, status: 'running', phaseId: 'new-phase', startedAt: 9_000 });
            const saved = state.items.find(item => item.id === 'old');
            assert.equal(saved?.status, 'completed');
            assert.equal(saved?.phaseId, 'old-phase');
            assert.equal(saved?.startedAt, 1_002);
            assert.deepEqual(activeStepSubjects(harness.container), ['new-command']);
        }
    } finally { harness.cleanup(); }
});
