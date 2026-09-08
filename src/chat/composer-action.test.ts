import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveComposerPrimaryAction, shouldSubmitComposerOnKeydown } from './composer-action';

test('empty active composer exposes the stop action', () => {
    assert.equal(resolveComposerPrimaryAction({ running: true, hasPayload: false }), 'stop');
});

test('active composer with input sends to the queue', () => {
    assert.equal(resolveComposerPrimaryAction({ running: true, hasPayload: true }), 'queue');
});

test('idle composer sends only when it has a payload', () => {
    assert.equal(resolveComposerPrimaryAction({ running: false, hasPayload: true }), 'send');
    assert.equal(resolveComposerPrimaryAction({ running: false, hasPayload: false }), 'disabled');
});

test('send restrictions do not hide the stop action', () => {
    assert.equal(resolveComposerPrimaryAction({ running: true, hasPayload: false, sendBlocked: true }), 'stop');
    assert.equal(resolveComposerPrimaryAction({ running: true, hasPayload: true, sendBlocked: true }), 'disabled');
});

test('Enter submits while Shift+Enter keeps a newline', () => {
    assert.equal(shouldSubmitComposerOnKeydown({ key: 'Enter', shiftKey: false }), true);
    assert.equal(shouldSubmitComposerOnKeydown({ key: 'Enter', shiftKey: true }), false);
    assert.equal(shouldSubmitComposerOnKeydown({ key: 'a', shiftKey: false }), false);
});

test('IME confirmation does not submit the composer', () => {
    assert.equal(shouldSubmitComposerOnKeydown({ key: 'Enter', shiftKey: false, isComposing: true }), false);
    assert.equal(shouldSubmitComposerOnKeydown({ key: 'Enter', shiftKey: false, keyCode: 229 }), false);
});
