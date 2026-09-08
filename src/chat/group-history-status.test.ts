import assert from 'node:assert/strict';
import test from 'node:test';
import { groupHistoryStatusView } from './group-history-status';

test('completed history disappears and in-flight history stays concise', () => {
    for (const state of ['completed', 'not_requested']) {
        assert.deepEqual(groupHistoryStatusView(state), { text: '', retry: false });
    }
    for (const state of ['pending', 'fetching', 'delivery_pending']) {
        assert.deepEqual(groupHistoryStatusView(state), { text: '正在同步历史消息…', retry: false });
    }
});

test('failures offer retry without exposing permissions, counts or backend errors', () => {
    for (const state of ['retry', 'failed', 'unavailable', 'awaiting_visibility_confirmation']) {
        assert.deepEqual(groupHistoryStatusView(state), { text: '历史消息暂未同步完成', retry: true });
    }
    assert.equal(groupHistoryStatusView('cancelled').retry, false);
});
