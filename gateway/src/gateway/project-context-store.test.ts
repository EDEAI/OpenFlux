import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ProjectContextStore, type ProjectContextEvent } from './project-context-store';
import { GroupWorkStatusReporter } from './group-work-status';

test('work-order status retries survive a temporary API failure without reconnecting', async () => {
    const sent: string[] = [];
    let available = false;
    const reporter = new GroupWorkStatusReporter<{ work_order_id: string; status: string }>(async input => {
        sent.push(input.status);
        return available;
    });
    assert.equal(await reporter.report({ work_order_id: 'work-1', status: 'completed' }), false);
    available = true;
    reporter.retryPending();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(sent, ['completed', 'completed']);
    reporter.retryPending();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.length, 2, 'acknowledged updates must leave the retry queue');
});

test('work-order status reports are serialized and intermediate states are superseded', async () => {
    const sent: string[] = [];
    let completeFirst!: (accepted: boolean) => void;
    const first = new Promise<boolean>(resolve => { completeFirst = resolve; });
    const reporter = new GroupWorkStatusReporter<{ work_order_id: string; status: string }>(async input => {
        sent.push(input.status);
        return sent.length === 1 ? first : true;
    });
    const running = reporter.report({ work_order_id: 'work-1', status: 'running' });
    await new Promise(resolve => setImmediate(resolve));
    void reporter.report({ work_order_id: 'work-1', status: 'waiting' });
    const completed = reporter.report({ work_order_id: 'work-1', status: 'completed' });
    assert.deepEqual(sent, ['running']);
    completeFirst(false);
    assert.equal(await running, true);
    assert.equal(await completed, true);
    assert.deepEqual(sent, ['running', 'completed']);
});

test('status delivery failure in one work order does not block another', async () => {
    const sent: string[] = [];
    const reporter = new GroupWorkStatusReporter<{ work_order_id: string }>(async input => {
        sent.push(input.work_order_id);
        if (input.work_order_id === 'failed-order') throw new Error('temporary API error');
        return true;
    });
    assert.deepEqual(await Promise.all([
        reporter.report({ work_order_id: 'failed-order' }),
        reporter.report({ work_order_id: 'other-order' }),
    ]), [false, true]);
    reporter.retryPending();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(sent, ['failed-order', 'other-order', 'failed-order']);
});

test('attachment completion is scoped to its event and cannot overwrite an edit or delete', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flux-attachment-event-'));
    const store = new ProjectContextStore(dir);
    try {
        const original = event({ attachments: [{ type: 'image', download_status: 'pending' }] });
        store.append(original);
        assert.equal(store.updateAttachments(original, [{ type: 'image', local_path: '/test/image.png', download_status: 'available' }]), true);
        assert.equal(store.updateAttachments({ ...original, project_id: 'other-project' }, []), false);
        store.append(event({ delivery_id: 'edit-delivery', event_id: 'edit-event', event_type: 'message_edited', text: 'new text' }));
        assert.equal(store.updateAttachments(original, []), false);
        store.append(event({ delivery_id: 'delete-delivery', event_id: 'delete-event', event_type: 'message_deleted' }));
        assert.equal(store.updateAttachments(original, []), false);
    } finally {
        store.close();
        await rm(dir, { recursive: true, force: true });
    }
});

function event(overrides: Partial<ProjectContextEvent> = {}): ProjectContextEvent {
    return {
        action: 'project_context.append',
        delivery_id: 'delivery-1',
        event_id: 'event-1',
        external_event_id: 'external-1',
        event_type: 'message_created',
        platform_id: 'platform-1',
        platform_type: 'feishu',
        workspace_id: 'workspace-1',
        channel_id: 'channel-1',
        thread_id: 'thread-1',
        message_id: 'message-1',
        project_id: 'project-1',
        sender_platform_id: 'user-1',
        sender_display_name: '张三',
        sender_role_name: '前端',
        sender_type: 'human',
        text: 'first',
        mentions: [],
        attachments: [],
        created_at: 1000,
        ...overrides,
    };
}

test('late history cannot overwrite a live edit or resurrect a deletion', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openflux-history-order-'));
    const store = new ProjectContextStore(dir);
    try {
        store.append(event({ event_type: 'message_edited', text: 'latest edit', edited_at: 3000 }));
        assert.equal(store.append(event({ delivery_id: 'history-1', event_id: 'history-event',
            history_import: true, text: 'old text' })).duplicate, true);
        assert.equal(store.getMessageByExternalId('project-1', 'platform-1', 'workspace-1', 'channel-1', 'message-1')?.text, 'latest edit');
        store.append(event({ delivery_id: 'delete-1', event_id: 'delete-event', event_type: 'message_deleted' }));
        store.append(event({ delivery_id: 'history-2', event_id: 'history-event-2', history_import: true }));
        assert.equal(store.getMessageByExternalId('project-1', 'platform-1', 'workspace-1', 'channel-1', 'message-1')?.deleted, true);
        assert.equal(store.hasDelivery('history-2'), true, 'ignored old payload must still be acknowledged');
    } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('history pagination keeps equal timestamps and group/thread isolation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openflux-history-pages-'));
    const store = new ProjectContextStore(dir);
    try {
        for (let index = 0; index < 123; index++) store.append(event({
            delivery_id: `d-${index}`, event_id: `e-${index}`, message_id: `m-${index}`,
            thread_id: index % 2 ? 'thread-a' : 'thread-b', created_at: 1000,
        }));
        store.append(event({ delivery_id: 'other', message_id: 'private', channel_id: 'other-channel' }));
        const key = { projectId: 'project-1', platformId: 'platform-1', workspaceId: 'workspace-1', channelId: 'channel-1' };
        let next: { time: number; id: number } | undefined;
        const ids: unknown[] = [];
        do {
            const page = store.readHistoryPage(key, '', next);
            ids.push(...page.messages.map(item => item.message_id));
            next = page.next;
        } while (next);
        assert.equal(ids.length, 123);
        assert.equal(new Set(ids).size, 123);
        assert.equal(ids.includes('private'), false);
        assert.ok(store.readHistoryPage({ ...key, threadId: 'thread-a' }).messages.every(m => m.thread_id === 'thread-a'));
    } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('project context is idempotent and applies edit/delete to current state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openflux-project-context-'));
    const store = new ProjectContextStore(dir);
    try {
        const first = store.append(event());
        assert.equal(first.duplicate, false);
        assert.equal(store.append(event()).duplicate, true);

        store.append(event({
            delivery_id: 'delivery-2',
            event_id: 'event-2',
            external_event_id: 'external-2',
            event_type: 'message_edited',
            text: 'edited',
            edited_at: 2000,
        }));
        let messages = store.listThreadMessages('project-1', 'thread-1');
        assert.equal(messages.length, 1);
        assert.equal(messages[0].text, 'edited');
        assert.equal(messages[0].deleted, false);
        const current = store.getMessageByExternalId(
            'project-1', 'platform-1', 'workspace-1', 'channel-1', 'message-1',
        );
        assert.equal(current?.platform_type, 'feishu');
        assert.equal(current?.text, 'edited');
        assert.equal(current?.sender_display_name, '张三');
        assert.equal(current?.sender_role_name, '前端');

        store.append(event({
            delivery_id: 'delivery-3',
            event_id: 'event-3',
            external_event_id: 'external-3',
            event_type: 'message_deleted',
            text: '',
        }));
        messages = store.listThreadMessages('project-1', 'thread-1');
        assert.equal(messages.length, 1);
        assert.equal(messages[0].text, '');
        assert.equal(messages[0].deleted, true);
        assert.equal(first.sessionId, store.getOrCreateSessionId(event()));
    } finally {
        store.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test('collaboration timeline events remain visible but are marked as non-executable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openflux-collaboration-timeline-'));
    const store = new ProjectContextStore(dir);
    try {
        store.append(event({
            suppress_agent_execution: true,
            collaboration_event: {
                event_type: 'task.confirmed',
                actor_display_name: '李四',
            },
            text: '李四已确认后端任务。',
        }));
        const message = store.listThreadMessages('project-1', 'thread-1')[0];
        assert.equal(message.suppress_agent_execution, true);
        assert.deepEqual(message.collaboration_event, {
            event_type: 'task.confirmed',
            actor_display_name: '李四',
        });
        assert.equal(message.text, '李四已确认后端任务。');
    } finally {
        store.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test('group work retries are idempotent and approval receipts are written once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openflux-group-work-'));
    const store = new ProjectContextStore(dir);
    try {
        store.append(event({ sender_flux_user_id: 'flux-user-1' }));
        assert.deepEqual(store.listChannelMembers(event()), [{
            flux_user_id: 'flux-user-1',
            platform_member_id: 'user-1',
        }]);

        const payload = {
            trigger_event_id: 'event-1',
            project_id: 'project-1',
            public_reply: 'done',
        };
        store.saveGroupWork('event-1', 'project-1', payload);
        store.saveGroupWork('event-1', 'project-1', { ...payload, public_reply: 'duplicate' });
        let due = store.listDueGroupWork(Date.now() + 1);
        assert.equal(due.length, 1);
        assert.equal(due[0].payload.public_reply, 'done');

        store.markGroupWorkSubmitted('event-1');
        assert.equal(store.listDueGroupWork(Date.now()).length, 0);
        store.markGroupWorkResult('event-1', false, 'offline');
        due = store.listDueGroupWork(Date.now() + 61_000);
        assert.equal(due.length, 1);
        store.markGroupWorkResult('event-1', true);
        assert.equal(store.listDueGroupWork(Date.now() + 24 * 60 * 60_000).length, 0);

        assert.equal(store.hasApprovalReceipt('approval-1'), false);
        store.recordApprovalReceipt('approval-1', 'project-1', 'confirm');
        store.recordApprovalReceipt('approval-1', 'project-1', 'confirm');
        assert.equal(store.hasApprovalReceipt('approval-1'), true);
    } finally {
        store.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test('collaboration planning, work orders and agent messages are locally idempotent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openflux-group-collaboration-'));
    const store = new ProjectContextStore(dir);
    try {
        assert.equal(store.claimGroupPlanning('plan-1', 'collab-1', 'project-1'), true);
        assert.equal(store.claimGroupPlanning('plan-1', 'collab-1', 'project-1'), false);
        store.completeGroupPlanning('plan-1');
        assert.equal(store.claimGroupPlanning('plan-1', 'collab-1', 'project-1'), false);
        assert.equal(store.claimGroupPlanning('failed-input', 'collab-1', 'project-1'), true);
        store.failGroupPlanning('failed-input');
        assert.equal(store.hasFailedGroupPlanning('failed-input'), true);
        assert.equal(store.claimGroupPlanning('failed-input', 'collab-1', 'project-1'), false);
        assert.equal(store.claimGroupPlanning('next-input', 'collab-1', 'project-1'), true);

        const first = store.claimGroupWorkOrder({
            workOrderId: 'order-1',
            idempotencyKey: 'task-1:v1',
            projectId: 'project-1',
            sessionId: 'session-1',
            taskId: 'task-1',
            payload: { title: '前端任务' },
        });
        assert.equal(first.claimed, true);
        const duplicate = store.claimGroupWorkOrder({
            workOrderId: 'order-1',
            idempotencyKey: 'task-1:v1',
            projectId: 'project-1',
            sessionId: 'session-1',
            taskId: 'task-1',
            payload: { title: '不能重复执行' },
        });
        assert.equal(duplicate.claimed, false);
        store.updateGroupWorkOrderReceipt('order-1', 'waiting', '等待后端接口');
        assert.equal(store.getGroupWorkOrderByTask('task-1')?.status, 'waiting');
        store.updateGroupWorkOrderReceipt('order-1', 'paused', '成员手动暂停');
        assert.equal(store.getGroupWorkOrderByTask('task-1')?.status, 'paused');

        const message = {
            routerMessageId: 'router-message-1',
            externalMessageId: 'dependency-1',
            targetTaskId: 'task-1',
            kind: 'dependency_ready',
            content: '后端接口已经完成',
        };
        assert.equal(store.recordGroupAgentMessage(message), true);
        assert.equal(store.recordGroupAgentMessage(message), false);
        const contractMessage = {
            routerMessageId: 'router-message-contract',
            externalMessageId: 'contract-1',
            targetTaskId: 'task-1',
            kind: 'contract',
            content: '接口字段改为 data.items',
        };
        assert.equal(store.recordGroupAgentMessage(contractMessage), true);
        assert.equal(store.getGroupAgentMessageReceipt('router-message-contract')?.handled_at, null);
        assert.equal(store.markGroupAgentMessageHandled('router-message-contract'), true);
        assert.equal(store.markGroupAgentMessageHandled('router-message-contract'), false);
        assert.ok(store.getGroupAgentMessageReceipt('router-message-contract')?.handled_at);
    } finally {
        store.close();
        await rm(dir, { recursive: true, force: true });
    }
});
