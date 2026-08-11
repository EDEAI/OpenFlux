import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentRuntimeEvent } from '../runtime/events';
import { validateRuntimeReplay } from './replay';

function event(seq: number, type: AgentRuntimeEvent['type']): AgentRuntimeEvent {
    return {
        version: 1,
        eventId: `event-${seq}`,
        sessionId: 'session',
        turnId: 'turn',
        seq,
        timestamp: seq,
        type,
    };
}

test('accepts a valid replay and reports sequence and terminal violations', () => {
    assert.equal(validateRuntimeReplay([
        event(1, 'turn.started'),
        event(2, 'turn.completed'),
    ]).valid, true);

    const invalid = validateRuntimeReplay([
        event(1, 'turn.started'),
        event(3, 'turn.completed'),
        event(4, 'turn.failed'),
    ]);
    assert.equal(invalid.valid, false);
    assert.deepEqual(invalid.issues.map(issue => issue.code), ['sequence_gap', 'duplicate_terminal']);
});
