import assert from 'node:assert/strict';
import test from 'node:test';
import { ExternalTurnLifecycle } from './external-turn-lifecycle';
import { FollowUpController } from './follow-up-controller';

test('external stop then a new request has an independent identity; late events remain retired', () => {
    for (const sessionId of ['router-private', 'project-thread-group']) {
        const external = new ExternalTurnLifecycle();
        const native = new FollowUpController();
        const first = { sessionId, turnId: 'question-a', runId: 'run-a' };
        const next = { sessionId, turnId: 'question-b', runId: 'run-b' };
        assert.equal(external.start(first), true);
        native.observeTurnStarted(first);
        native.retireForStop(sessionId);
        external.finish(first, true);
        assert.equal(external.start(first), false);
        assert.equal(external.start(next), true);
        native.observeTurnStarted(next);
        external.finish(first);
        assert.equal(native.matchesActive(first), false);
        assert.equal(native.matchesActive(next), true);
        assert.equal(external.isRunning(next), true);
        external.finish(next);
        assert.equal(external.start(next), false);
    }
});

test('ordinary Assistant and display-only messages never enter external lifecycle', () => {
    const external = new ExternalTurnLifecycle();
    assert.equal(external.owns({ sessionId: 'assistant', turnId: 'normal', runId: 'native' }), false);
    assert.equal(external.start({ sessionId: 'group-history' }), false);
});
