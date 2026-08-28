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

test('activity rows keep their natural height inside the bounded scroll viewport', () => {
    const stylesheet = readFileSync(
        new URL('../../src/styles/main.css', import.meta.url),
        'utf8',
    );
    const itemRule = stylesheet.match(/\.agent-activity-item\s*\{([^}]*)\}/)?.[1] ?? '';

    assert.match(itemRule, /flex:\s*0\s+0\s+auto\s*;/);
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
    const running = [turnStarted('running-turn', 500)];

    assert.equal(shouldRenderUnanchoredTurn(oldTerminal, 2_000), false);
    assert.equal(shouldRenderUnanchoredTurn(currentTerminal, 2_000), true);
    assert.equal(shouldRenderUnanchoredTurn(running, 2_000), true);
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

test('restores a completed background designer turn as soon as its session becomes active', () => {
    const harness = createHarness();
    const turnId = 'background-turn';

    try {
        const events = [
            turnStarted(turnId, 1_000),
            itemStarted(turnId, 1_050),
            itemCompleted(turnId, 1_200),
            turnCompleted(turnId, 1_250),
        ];
        for (const event of events) harness.view.applyEvent(event, 'other-session');

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
    } finally {
        harness.cleanup();
    }
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
            '.agent-activity-items > .agent-activity-item',
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
            '.agent-activity-items > .agent-activity-item',
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

        harness.container.replaceChildren();
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
    } finally {
        harness.cleanup();
    }
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

test('shows only the latest ten live steps, then lazily reveals full terminal history', () => {
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
        assert.deepEqual(liveIds, Array.from({ length: 10 }, (_, index) => `step-${index + 3}`));
        assert.ok(harness.container.querySelector('.agent-activity')?.classList.contains('live-window'));

        harness.view.applyEvent({
            ...turnCompleted(turnId, 2_000),
            eventId: 'windowed-complete',
            seq: 99,
        }, DESIGNER_SESSION_ID);
        assert.equal(harness.container.querySelector('.agent-activity-item'), null);
        assert.ok(harness.container.querySelector('.agent-activity')?.classList.contains('collapsed'));

        harness.container.querySelector<HTMLButtonElement>('.agent-activity-header')?.click();
        assert.equal(harness.container.querySelectorAll('.agent-activity-item').length, 12);
        assert.ok(harness.container.querySelector('.agent-activity')?.classList.contains('history-view'));
    } finally {
        harness.cleanup();
    }
});

test('keeps an older pending approval visible outside the ten-step live window', () => {
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
        assert.equal(harness.container.querySelectorAll('.agent-activity-item').length, 11);
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
