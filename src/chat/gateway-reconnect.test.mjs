import assert from 'node:assert/strict';
import test from 'node:test';
import { GatewayClient } from '../gateway-client.ts';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('concurrent connect calls share one bridge connection attempt', async () => {
    const client = new GatewayClient('ws://127.0.0.1:18801');
    client.bridgeMode = true;
    let attempts = 0;
    let release;
    client.connectViaBridge = async () => {
        attempts += 1;
        await new Promise(resolve => { release = resolve; });
        client.authenticated = true;
    };

    const first = client.connect();
    const second = client.connect();
    await wait(0);
    assert.equal(attempts, 1);
    release();
    await Promise.all([first, second]);
    assert.equal(client.isConnected(), true);
});

test('automatic reconnect continues after a failed attempt instead of becoming permanently disconnected', async () => {
    const client = new GatewayClient('ws://127.0.0.1:18801');
    let connected = false;
    let attempts = 0;
    client.reconnectDelay = 1;
    client.maxReconnectAttempts = 2;
    client.isConnected = () => connected;
    client.connect = async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('gateway still starting');
        connected = true;
    };

    client.tryReconnect();
    for (let i = 0; i < 20 && !connected; i += 1) await wait(5);

    assert.equal(connected, true);
    assert.equal(attempts, 3);
});

test('submitting chat wakes a disconnected client and waits for reconnection before sending', async () => {
    const client = new GatewayClient('ws://127.0.0.1:18801');
    let connected = false;
    let sent;
    client.isConnected = () => connected;
    client.connect = async () => { connected = true; };
    client.sendAsync = async message => { sent = message; };

    await client.submitChat('recover me', 'session-a', undefined, {
        delivery: 'new',
        submissionId: 'submission-a',
    });

    assert.equal(sent.type, 'chat');
    assert.equal(sent.id, 'submission-a');
    assert.equal(sent.payload.sessionId, 'session-a');
    assert.equal(sent.payload.input, 'recover me');
});
