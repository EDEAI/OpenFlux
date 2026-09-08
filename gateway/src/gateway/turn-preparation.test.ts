import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareTurnInput } from './turn-preparation';

test('stopping during preparation terminates promptly and late completion cannot replace the next input', async () => {
    const controller = new AbortController();
    let finish!: (value: string) => void;
    const old = prepareTurnInput(() => new Promise<string>(resolve => { finish = resolve; }), controller.signal);
    controller.abort();
    await assert.rejects(old, { name: 'AbortError' });
    assert.equal(await prepareTurnInput(async () => 'hello', new AbortController().signal), 'hello');
    finish('42');
    await assert.rejects(old, { name: 'AbortError' });
});

test('an already stopped turn never starts preparation', async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    await assert.rejects(prepareTurnInput(async () => { called = true; }, controller.signal));
    assert.equal(called, false);
});
