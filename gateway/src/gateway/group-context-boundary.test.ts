import assert from 'node:assert/strict';
import test from 'node:test';
import { groupContextBoundary } from './group-context-boundary';

test('an arithmetic request cannot relabel earlier development discussion as authorization', () => {
    const sources = new Set(['old-development', 'question-42']);
    assert.equal(groupContextBoundary('question-42', 'question-42', sources), '[当前请求]');
    assert.match(groupContextBoundary('old-development', 'question-42', sources), /不是本次执行授权/);
    assert.match(groupContextBoundary('old-start', undefined, sources), /不是本次执行授权/);
});
