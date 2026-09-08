import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentRuntimeEvent } from '../runtime/events';
import type { SessionMessage } from '../sessions/types';
import { buildAgentHistory } from './history';

function message(
    id: string,
    role: SessionMessage['role'],
    content: string,
    metadata?: Record<string, unknown>,
): SessionMessage {
    return { id, role, content, metadata, createdAt: Number(id.replace(/\D/g, '')) || 1 };
}

function terminal(turnId: string, type: AgentRuntimeEvent['type']): AgentRuntimeEvent {
    return {
        version: 1,
        eventId: `${turnId}-${type}`,
        sessionId: 'session',
        turnId,
        seq: 1,
        timestamp: 1,
        type,
    };
}

test('failed and interrupted turns remain visible but do not enter model history', () => {
    const result = buildAgentHistory([
        message('1', 'user', '17+25', { turnId: 'failed-turn' }),
        message('2', 'user', '你好', { turnId: 'current-turn' }),
    ], [terminal('failed-turn', 'turn.failed')]);

    assert.deepEqual(result, [{ role: 'user', content: '你好' }]);
});

test('only the latest platform edit is used and deleted messages are omitted', () => {
    const base = {
        source: 'router_group',
        external_message_id: 'platform-message',
        sender_display_name: '张三',
        sender_role_name: '前端',
    };
    const edited = buildAgentHistory([
        message('1', 'user', '旧要求', { ...base, event_type: 'message_created' }),
        message('2', 'user', '新要求', { ...base, event_type: 'message_edited' }),
    ], []);
    assert.deepEqual(edited, [{ role: 'user', content: '[群消息 · 张三（前端）] 新要求' }]);

    const deleted = buildAgentHistory([
        message('1', 'user', '旧要求', { ...base, event_type: 'message_created' }),
        message('2', 'user', '[消息已删除]', { ...base, event_type: 'message_deleted' }),
    ], []);
    assert.deepEqual(deleted, []);
});

test('an input persisted before preparation cannot include itself or a queued future request as history', () => {
    const result = buildAgentHistory([
        message('1', 'user', 'earlier question', { turnId: 'old' }),
        message('2', 'user', 'current question', { turnId: 'current' }),
        message('3', 'user', 'future question', { turnId: 'future' }),
        message('4', 'assistant', 'earlier answer', { turnId: 'old' }),
    ], [terminal('old', 'turn.completed')], 'current');
    assert.deepEqual(result.map(item => item.content), ['earlier question', 'earlier answer']);
});

test('display-only collaboration events and failed attachments cannot drive later work', () => {
    const result = buildAgentHistory([
        message('1', 'assistant', '旧任务暂停', { display_only: true }),
        message('2', 'user', '附件下载失败', { attachment_download_failed: true }),
        message('3', 'user', '新的正常问题'),
    ], []);
    assert.deepEqual(result, [{ role: 'user', content: '新的正常问题' }]);
});
