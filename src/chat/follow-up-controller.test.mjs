import assert from 'node:assert/strict';
import test from 'node:test';
import {
    FollowUpController,
    eventMatchesTurn,
    reduceQueueState,
    shouldDisplayFollowUpQueue,
} from './follow-up-controller.ts';

test('an empty queue stays hidden even when its persisted pause flag is set', () => {
    assert.equal(shouldDisplayFollowUpQueue(undefined), false);
    assert.equal(shouldDisplayFollowUpQueue({
        sessionId: 's1',
        items: [],
        paused: true,
        revision: 1,
    }), false);
    assert.equal(shouldDisplayFollowUpQueue({
        sessionId: 's1',
        items: [{
            id: 'q1', input: 'next', position: 0, status: 'paused', createdAt: 1,
        }],
        paused: true,
        revision: 2,
    }), true);
});

test('late terminal from a retired turn cannot match the new active turn', () => {
    const controller = new FollowUpController();
    controller.beginOptimistic('s1', 'submit-a');
    controller.applyAccepted({
        sessionId: 's1', submissionId: 'submit-a', disposition: 'started', turnId: 'turn-a', runId: 'run-a',
    });
    controller.retireForStop('s1');
    controller.beginOptimistic('s1', 'submit-b');
    controller.applyAccepted({
        sessionId: 's1', submissionId: 'submit-b', disposition: 'started', turnId: 'turn-b', runId: 'run-b',
    });

    assert.equal(controller.matchesActive({ sessionId: 's1', turnId: 'turn-a', runId: 'run-a' }), false);
    assert.equal(controller.matchesActive({ sessionId: 's1', turnId: 'turn-b', runId: 'run-b' }), true);
});

test('late started and accepted events cannot replace an optimistic new turn', () => {
    const controller = new FollowUpController();
    controller.beginOptimistic('s1', 'submit-a');
    controller.applyAccepted({
        sessionId: 's1', submissionId: 'submit-a', disposition: 'started', turnId: 'turn-a', runId: 'run-a',
    });
    controller.retireForStop('s1');
    controller.beginOptimistic('s1', 'submit-b');

    controller.observeTurnStarted({ sessionId: 's1', turnId: 'turn-a', runId: 'run-a' });
    assert.equal(controller.activeTurnBySession.get('s1').submissionId, 'submit-b');
    assert.equal(controller.applyAccepted({
        sessionId: 's1', submissionId: 'submit-a', disposition: 'started', turnId: 'turn-a', runId: 'run-a',
    }), false);
    assert.equal(controller.activeTurnBySession.get('s1').submissionId, 'submit-b');
});

test('identity-less progress cannot mutate a server-identified active turn', () => {
    assert.equal(eventMatchesTurn(
        { sessionId: 's1', turnId: 'turn-a', startedAt: 1 },
        { sessionId: 's1' },
    ), false);
});

test('an older queue snapshot cannot rewind a newer revision', () => {
    const newer = reduceQueueState(undefined, 's1', {
        revision: 4,
        paused: true,
        items: [{ id: 'q2', input: 'second', position: 0, createdAt: 2 }],
    });
    const delayed = reduceQueueState(newer, 's1', {
        revision: 3,
        paused: false,
        items: [{ id: 'q1', input: 'first', position: 0, createdAt: 1 }],
    });

    assert.equal(delayed, newer);
    assert.equal(delayed.items[0].id, 'q2');
    assert.equal(delayed.paused, true);
});
