import test from 'node:test';
import assert from 'node:assert/strict';
import { TurnTracker } from './turn-tracker';
import { toPublicAgentRuntimeEvent, type AgentRuntimeEvent } from './events';
import { describeToolAction } from './activity-descriptor';

test('projects legacy progress into stable Turn/Item lifecycle events', () => {
    const events: ReturnType<TurnTracker['start']>[] = [];
    const tracker = new TurnTracker({
        sessionId: 'session-1',
        turnId: 'turn-1',
        emit: event => events.push(event),
    });

    tracker.start();
    tracker.handleLegacyProgress({ type: 'iteration', iteration: 1 });
    tracker.handleLegacyProgress({
        type: 'tool_start',
        description: '查看项目文件',
        llmDescription: '<think>private plan</think>我先确认项目结构',
        toolCalls: [{ id: 'call-1', name: 'filesystem' }],
    });
    tracker.handleLegacyProgress({
        type: 'tool_result',
        tool: 'filesystem',
        toolCallId: 'call-1',
        description: '已查看 12 个文件',
    });
    tracker.complete('实现完成');

    assert.deepEqual(events.map(event => event.seq), [1, 2, 3, 4, 5]);
    assert.deepEqual(events.map(event => event.type), [
        'turn.started',
        'item.completed',
        'item.started',
        'item.completed',
        'turn.completed',
    ]);
    assert.equal(events[1].item?.kind, 'commentary');
    assert.equal(events[1].item?.title, '我先确认项目结构');
    assert.equal(events[2].item?.toolCallId, 'call-1');
    assert.equal(events[3].item?.status, 'completed');
    assert.equal(events.at(-1)?.type, 'turn.completed');
    assert.equal(events.some(event => JSON.stringify(event).includes('private plan')), false);
});

test('deduplicates repeated fallback commentary and does not generate tool-name checkpoints', () => {
    const events: ReturnType<TurnTracker['start']>[] = [];
    const tracker = new TurnTracker({ sessionId: 's', turnId: 't', emit: event => events.push(event) });
    const rationale = '为了确认新闻事实，我会核对公开来源和原文。';

    tracker.start();
    tracker.handleLegacyProgress({ type: 'iteration', iteration: 1 });
    tracker.handleLegacyProgress({ type: 'commentary', commentary: rationale });
    tracker.handleLegacyProgress({
        type: 'tool_start',
        description: 'web_fetch',
        toolCalls: [{ id: 'fetch-1', name: 'web_fetch' }],
    });
    tracker.handleLegacyProgress({ type: 'tool_result', tool: 'web_fetch', toolCallId: 'fetch-1' });
    tracker.handleLegacyProgress({ type: 'iteration', iteration: 2 });
    tracker.handleLegacyProgress({ type: 'commentary', commentary: rationale });
    tracker.complete('完成');

    assert.equal(events.filter(event => event.item?.kind === 'commentary').length, 1);
    assert.equal(events.some(event => event.item?.kind === 'checkpoint'), false);
});

test('publishes user guidance as a distinct, ordered activity item', () => {
    const events: ReturnType<TurnTracker['start']>[] = [];
    const tracker = new TurnTracker({ sessionId: 's', turnId: 't', emit: event => events.push(event) });

    tracker.start();
    tracker.commentary('Checking the available sources first.');
    tracker.guidance('Make the angle more controversial.', 'steer-42');
    tracker.startAction({ toolCallId: 'search-1', tool: 'web_search', title: 'Search for reactions' });

    assert.deepEqual(events.map(event => event.item?.kind).filter(Boolean), [
        'commentary',
        'guidance',
        'action',
    ]);
    assert.equal(events[2].item?.id, 'guidance-steer-42');
    assert.equal(events[2].item?.title, 'Make the angle more controversial.');
});

test('ignores raw thinking callbacks and retains failure as a terminal event', () => {
    const events: ReturnType<TurnTracker['start']>[] = [];
    const tracker = new TurnTracker({ sessionId: 's', turnId: 't', emit: event => events.push(event) });
    tracker.start();
    tracker.handleLegacyProgress({ type: 'thinking', thinking: 'never expose this' });
    tracker.fail('provider failed');
    assert.equal(events.length, 2);
    assert.equal(events[1].type, 'turn.failed');
});

test('keeps public commentary separate from compact tool action titles', () => {
    const events: ReturnType<TurnTracker['start']>[] = [];
    const tracker = new TurnTracker({ sessionId: 's', turnId: 't', emit: event => events.push(event) });
    const prose = '我会先检查当前环境和可用工具，再根据结果选择安全的执行方案。'.repeat(8);

    tracker.start();
    tracker.handleLegacyProgress({
        type: 'tool_start',
        description: prose,
        llmDescription: prose,
        toolCalls: [{ id: 'call-1', name: 'process' }],
    });

    assert.equal(events[1].item?.kind, 'commentary');
    assert.match(events[1].item?.title || '', /^我会先检查当前环境/);
    assert.equal(events[2].item?.kind, 'action');
    assert.equal(events[2].item?.title, '调用 process');
});

test('publishes at most one terminal event', () => {
    const events: ReturnType<TurnTracker['start']>[] = [];
    const tracker = new TurnTracker({ sessionId: 's', turnId: 't', emit: event => events.push(event) });

    tracker.start();
    const interrupted = tracker.interrupt();
    assert.equal(tracker.complete('late completion').eventId, interrupted.eventId);
    assert.equal(tracker.fail('late failure').eventId, interrupted.eventId);
    assert.deepEqual(events.map(event => event.type), ['turn.started', 'turn.interrupted']);
});

test('keeps model request telemetry out of the public Turn/Item timeline', () => {
    const events: ReturnType<TurnTracker['start']>[] = [];
    const tracker = new TurnTracker({ sessionId: 's', turnId: 't', emit: event => events.push(event) });

    tracker.start();
    tracker.handleLegacyProgress({
        type: 'model_start',
        modelCallId: 'call-1',
        iteration: 1,
        provider: 'moonshot',
        model: 'kimi-k3',
        streamed: true,
        elapsedMs: 820,
        firstChunkMs: 820,
    } as unknown as Parameters<TurnTracker['handleLegacyProgress']>[0]);

    assert.deepEqual(events.map(event => event.type), ['turn.started']);
});

test('sanitizes model identifiers from legacy event replay payloads', () => {
    const event: AgentRuntimeEvent = {
        version: 1,
        eventId: 'legacy-model-event',
        sessionId: 's',
        turnId: 't',
        seq: 2,
        timestamp: 1_000,
        type: 'item.completed',
        item: {
            id: 'model-call-1',
            kind: 'model',
            status: 'completed',
            title: 'Model response received',
            detail: 'moonshot/kimi-k3 · first chunk 820ms · total 2.4s',
        },
    };

    const sanitized = toPublicAgentRuntimeEvent(event);
    assert.equal(sanitized.item?.detail, undefined);
    assert.doesNotMatch(JSON.stringify(sanitized), /moonshot|kimi-k3/i);
});

test('namespaces identical child tool-call ids so parallel agents cannot overwrite each other', () => {
    const events: ReturnType<TurnTracker['start']>[] = [];
    const tracker = new TurnTracker({ sessionId: 's', turnId: 't', emit: event => events.push(event) });
    tracker.start();
    tracker.handleLegacyProgress({
        type: 'tool_start',
        sourceId: 'child-a',
        sourceAgentId: 'coder',
        toolCalls: [{ id: 'filesystem_0', name: 'filesystem', title: '读取 A.php' }],
    });
    tracker.handleLegacyProgress({
        type: 'tool_start',
        sourceId: 'child-b',
        sourceAgentId: 'coder',
        toolCalls: [{ id: 'filesystem_0', name: 'filesystem', title: '读取 B.php' }],
    });
    tracker.handleLegacyProgress({
        type: 'tool_result',
        sourceId: 'child-a',
        tool: 'filesystem',
        toolCallId: 'filesystem_0',
    });

    const actions = events.filter(event => event.item?.kind === 'action');
    assert.deepEqual(actions.slice(0, 2).map(event => event.item?.id), [
        'action-child-a:filesystem_0',
        'action-child-b:filesystem_0',
    ]);
    assert.equal(actions[2].item?.id, 'action-child-a:filesystem_0');
    assert.equal(actions[2].item?.status, 'completed');
});

test('deduplicates non-adjacent commentary across the whole turn', () => {
    const events: ReturnType<TurnTracker['start']>[] = [];
    const tracker = new TurnTracker({ sessionId: 's', turnId: 't', emit: event => events.push(event) });
    tracker.start();
    tracker.handleLegacyProgress({ type: 'commentary', commentary: '已读取控制器 120–260 行。' });
    tracker.handleLegacyProgress({ type: 'commentary', commentary: '发现状态值包含 0、2、5。' });
    tracker.handleLegacyProgress({ type: 'commentary', commentary: '已读取控制器 120-260 行' });

    assert.deepEqual(
        events.filter(event => event.item?.kind === 'commentary').map(event => event.item?.title),
        ['已读取控制器 120–260 行。', '发现状态值包含 0、2、5。'],
    );
});

test('builds concrete public action labels without exposing credential values', () => {
    assert.equal(
        describeToolAction('filesystem', { action: 'read', path: 'D:\\project\\InvoiceController.php' }, 'zh'),
        '读取文件：InvoiceController.php',
    );
    assert.match(
        describeToolAction('process', { action: 'run', command: 'curl https://example.test -H token=super-secret' }, 'zh'),
        /token=\[REDACTED\]/,
    );
});
