import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileGroupTranscript } from './group-transcript';
import type { SessionMessage } from './types';

const base = { source: 'router_group', project_id: 'project-a', platform_id: 'platform', workspace_id: 'tenant', channel_id: 'group' };
function external(id: string, history: boolean, extra: Record<string, unknown> = {}): SessionMessage {
    return { id, role: 'assistant', content: '42', createdAt: 200,
        metadata: { ...base, external_message_id: 'om-answer', history_import: history,
            collaboration_event: { type: 'bot.public_reply' }, group_member_project_id: 'member-a', ...extra } };
}
const native: SessionMessage = { id: 'native', role: 'assistant', content: '42', createdAt: 100,
    metadata: { ...base, source: 'router_group_planning', turnId: 'group-plan:request', runId: 'run-original' } };
const ref = { result_id: 'result', executor_project_id: 'project-a', executor_member_id: 'member-a', turn_id: 'group-plan:request' };

test('executor keeps its native answer and Process identity in either arrival order', () => {
    const history = external('history', true, { public_reply_reference: ref });
    for (const items of [[native, history], [history, native]]) {
        const merged = reconcileGroupTranscript(items);
        assert.equal(merged.length, 1);
        assert.equal(merged[0].id, 'native');
        assert.equal(merged[0].createdAt, 100);
        assert.equal(merged[0].metadata?.runId, 'run-original');
        assert.deepEqual(merged[0].metadata?.public_platform_message_ids, ['om-answer']);
        assert.equal(reconcileGroupTranscript([...merged, external('again', true)]).length, 1);
    }
    const delayedReceipt = reconcileGroupTranscript([
        native, external('early-history', true), external('late-receipt', false, { public_reply_reference: ref }),
    ]);
    assert.equal(delayedReceipt.length, 1);
    assert.equal(delayedReceipt[0].id, 'native');
});

test('peers merge public/history copies; identical text with different IDs is retained', () => {
    for (const items of [[external('live', false), external('history', true)],
        [external('history', true), external('live', false)]]) {
        const merged = reconcileGroupTranscript(items);
        assert.equal(merged.length, 1);
        assert.equal(merged[0].metadata?.history_import, false);
    }
    assert.equal(reconcileGroupTranscript([external('one', true), external('two', true,
        { external_message_id: 'different-platform-id' })]).length, 2);
});

test('history cannot roll back live edits/deletions and can repair the source timestamp', () => {
    const live = { ...external('live', false, { event_type: 'message_deleted' }), content: '[deleted]', createdAt: 1 };
    const merged = reconcileGroupTranscript([live, external('history', true)]);
    assert.equal(merged[0].content, '[deleted]');
    assert.equal(merged[0].metadata?.event_type, 'message_deleted');
    assert.equal(merged[0].createdAt, 200);
});

test('native requests, other members and other groups are not merged by text or turn alone', () => {
    const user = { ...external('question', false), role: 'user' as const,
        metadata: { ...base, external_message_id: 'request' } };
    const legacy = { ...native, metadata: { ...base, turnId: 'request', external_message_id: 'request' } };
    assert.equal(reconcileGroupTranscript([user, legacy]).length, 2);
    assert.equal(reconcileGroupTranscript([native, external('peer', true,
        { public_reply_reference: ref, group_member_project_id: 'member-b' })]).length, 2);
    assert.equal(reconcileGroupTranscript([external('group-a', true), external('group-b', true, { channel_id: 'other' })]).length, 2);
    const ordinary = [{ ...native, metadata: {} }, { ...native, id: 'other', metadata: {} }];
    assert.equal(reconcileGroupTranscript(ordinary), ordinary);
});
