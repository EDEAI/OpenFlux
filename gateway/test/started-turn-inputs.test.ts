import test from 'node:test';
import assert from 'node:assert/strict';
import { StartedTurnInputStore } from '../../src/chat/started-turn-inputs';
import { HistoryLoadOrder } from '../../src/chat/history-load-order';

interface Message {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    createdAt: number;
    metadata: Record<string, unknown>;
}

function input(id: string, createdAt = 100): Message {
    return {
        id: `live-${id}`, role: 'user', content: id, createdAt,
        metadata: { turnId: `turn-${id}`, submissionId: `external:${id}` },
    };
}

test('started group inputs survive empty history and stay isolated by session', () => {
    const store = new StartedTurnInputStore<Message>();
    const first = store.remember('group-a', input('first'));
    store.remember('group-b', input('other'));
    assert.deepEqual(store.merge('group-a', []), [first]);
    assert.deepEqual(store.merge('group-a', []), [first], 'an empty snapshot is not an acknowledgment');
    assert.deepEqual(store.merge('unrelated', []), []);
    assert.equal(store.has('group-a'), true);
});

test('replayed start preserves the original input and timestamp without duplicating it', () => {
    const store = new StartedTurnInputStore<Message>();
    const first = store.remember('group-a', input('first'));
    const replay = store.remember('group-a', { ...input('first', 200), content: 'replayed' });
    assert.equal(replay, first);
    assert.deepEqual(store.merge('group-a', []), [first]);
});

test('persisted submission or turn identity replaces its live input, preserving other requests', () => {
    for (const identity of ['submissionId', 'turnId']) {
        const store = new StartedTurnInputStore<Message>();
        const first = store.remember('group-a', input('first'));
        const second = store.remember('group-a', input('second', 200));
        const persisted: Message = { ...first, id: 'server-first', content: 'server content', metadata: { [identity]: first.metadata[identity] } };
        assert.deepEqual(store.merge('group-a', [persisted]), [persisted, second]);
        assert.deepEqual(store.merge('group-a', []), [second], 'only the persisted request is acknowledged');
    }
});

test('an answer snapshot cannot put the missing live input after its answer', () => {
    const store = new StartedTurnInputStore<Message>();
    const first = store.remember('group-a', input('first'));
    const second = store.remember('group-a', input('second', 200));
    const answer: Message = { ...first, id: 'answer', role: 'assistant', content: 'result' };
    assert.deepEqual(store.merge('group-a', [answer]), [first, answer, second]);
    assert.equal(store.has('group-a'), true, 'an assistant message does not acknowledge the user input');
});

test('input retention is bounded across groups and retains the most recent requests', () => {
    const store = new StartedTurnInputStore<Message>(2);
    store.remember('old-group', input('old'));
    const first = store.remember('group-a', input('first'));
    const second = store.remember('group-a', input('second'));
    assert.equal(store.has('old-group'), false);
    assert.deepEqual(store.merge('group-a', []), [first, second]);
});

test('an older empty history cannot commit after a newer persisted snapshot', () => {
    const order = new HistoryLoadOrder();
    const old = order.begin();
    const newer = order.begin();
    assert.equal(order.commit('group-a', newer), true);
    assert.equal(order.commit('group-a', old), false);
    assert.equal(order.canCommit('group-a', old), false);
    assert.equal(order.commit('group-b', old), true, 'other sessions have independent committed views');
});

test('a pending or failed newer load does not block an older successful history', () => {
    const order = new HistoryLoadOrder();
    const old = order.begin();
    const pending = order.begin();
    assert.equal(order.commit('group-a', old), true);
    assert.equal(order.canCommit('group-a', pending), true);
    assert.equal(order.commit('group-a', pending), true);
});
