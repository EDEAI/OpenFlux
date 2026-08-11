import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const gatewayUrl = process.env.OPENFLUX_GATEWAY_URL || 'ws://127.0.0.1:18801';
const timeoutMs = Number(process.env.OPENFLUX_SMOKE_TIMEOUT_MS || 20_000);
const messages = [];
const waiters = new Set();
const ws = new WebSocket(gatewayUrl);

function acceptMessage(message) {
    messages.push(message);
    for (const waiter of [...waiters]) {
        if (waiter.predicate(message)) {
            waiters.delete(waiter);
            clearTimeout(waiter.timer);
            waiter.resolve(message);
        }
    }
}

ws.on('message', data => {
    try {
        acceptMessage(JSON.parse(data.toString()));
    } catch {
        // Ignore non-protocol diagnostics.
    }
});

function waitFor(predicate, label, startIndex = messages.length, customTimeoutMs = timeoutMs) {
    const existing = messages.slice(startIndex).find(predicate);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
        const waiter = {
            predicate,
            resolve,
            timer: setTimeout(() => {
                waiters.delete(waiter);
                const recent = messages.slice(-12).map(item => ({ type: item.type, id: item.id, payload: item.payload }));
                reject(new Error(`Timed out waiting for ${label}. Recent messages: ${JSON.stringify(recent)}`));
            }, customTimeoutMs),
        };
        waiters.add(waiter);
    });
}

async function sendAndWait(type, payload, responseType) {
    const id = randomUUID();
    const startIndex = messages.length;
    ws.send(JSON.stringify({ type, id, payload }));
    return waitFor(
        message => message.id === id && message.type === responseType,
        `${responseType} (${type})`,
        startIndex,
    );
}

async function sendChat(payload) {
    const id = randomUUID();
    const startIndex = messages.length;
    ws.send(JSON.stringify({ type: 'chat', id, payload }));
    const accepted = await waitFor(
        message => message.id === id && message.type === 'chat.accepted',
        `chat.accepted (${payload.submissionId})`,
        startIndex,
    );
    return { id, accepted };
}

async function stopTurn(sessionId, identity) {
    return sendAndWait('chat.stop', { sessionId, ...identity }, 'chat.stop.ack');
}

await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
});

let sessionId;
let activeIdentity;

try {
    const welcome = await waitFor(message => message.type === 'welcome', 'welcome', 0);
    assert.equal(welcome.payload?.requireAuth, false, 'live smoke test expects the local unauthenticated dev gateway');

    const registration = await sendAndWait(
        'client.register',
        { role: 'desktop', instanceId: `follow-up-smoke:${randomUUID()}` },
        'client.register.result',
    );
    assert.equal(registration.payload?.ok, true);

    const created = await sendAndWait(
        'sessions.create',
        { title: `Follow-up smoke ${new Date().toISOString()}`, approvalMode: 'full_access' },
        'sessions.create',
    );
    sessionId = created.payload?.session?.id;
    assert.ok(sessionId, 'temporary smoke-test session should be created');

    const submissionA = `smoke-a-${randomUUID()}`;
    const turnA = await sendChat({
        sessionId,
        submissionId: submissionA,
        delivery: 'new',
        approvalMode: 'full_access',
        input: '这是本地竞态测试 A。请先调用 process 执行 PowerShell Start-Sleep -Seconds 30，再只回复 A_DONE。',
    });
    assert.equal(turnA.accepted.payload?.disposition, 'started');

    const stoppedA = await stopTurn(sessionId, { submissionId: submissionA });
    assert.equal(stoppedA.payload?.matched, true, 'the exact active A turn must stop');
    assert.equal(stoppedA.payload?.queuePaused, true);

    const submissionB = `smoke-b-${randomUUID()}`;
    const turnB = await sendChat({
        sessionId,
        submissionId: submissionB,
        delivery: 'new',
        approvalMode: 'full_access',
        input: '这是本地竞态测试 B。请先调用 process 执行 PowerShell Start-Sleep -Seconds 30，再只回复 B_DONE。',
    });
    assert.equal(turnB.accepted.payload?.disposition, 'started', 'a fresh message must resume after Stop');
    activeIdentity = {
        submissionId: submissionB,
        turnId: turnB.accepted.payload?.turnId,
        runId: turnB.accepted.payload?.runId,
    };

    const staleStop = await stopTurn(sessionId, { submissionId: submissionA });
    assert.equal(staleStop.payload?.matched, false, 'a late stop for A must not abort B');

    const submissionC = `smoke-c-${randomUUID()}`;
    const turnC = await sendChat({
        sessionId,
        submissionId: submissionC,
        delivery: 'queue',
        approvalMode: 'full_access',
        input: 'QUEUE_ORIGINAL',
    });
    assert.equal(turnC.accepted.payload?.disposition, 'queued');
    const queueRunId = turnC.accepted.payload?.runId;
    assert.ok(queueRunId);

    const runtimeBefore = await sendAndWait('chat.runtime.get', { sessionId }, 'chat.runtime');
    assert.equal(runtimeBefore.payload?.activeTurn?.submissionId, submissionB, 'B must remain the active turn');
    assert.ok(runtimeBefore.payload?.queue?.items?.some(item => item.submissionId === submissionC));

    const updated = await sendAndWait(
        'chat.queue.update',
        { sessionId, runId: queueRunId, content: 'QUEUE_EDITED' },
        'chat.queue.update.result',
    );
    assert.equal(updated.payload?.ok, true);
    assert.equal(updated.payload?.item?.content, 'QUEUE_EDITED');

    const steerSubmissionId = `smoke-steer-${randomUUID()}`;
    const steered = await sendChat({
        sessionId,
        submissionId: steerSubmissionId,
        delivery: 'steer',
        fallback: 'queue',
        targetTurnId: activeIdentity.turnId,
        targetRunId: activeIdentity.runId,
        input: '这是引导消息：在安全边界停止等待，并只回复 STEER_OK。',
    });
    assert.equal(steered.accepted.payload?.disposition, 'steer_pending');
    assert.equal(steered.accepted.payload?.targetRunId, activeIdentity.runId);
    const guidanceActivity = await waitFor(
        message => message.type === 'agent.event'
            && message.payload?.sessionId === sessionId
            && message.payload?.turnId === activeIdentity.turnId
            && message.payload?.item?.kind === 'commentary'
            && message.payload?.item?.title?.includes('这是引导消息'),
        'visible guidance activity',
        0,
        5_000,
    );
    assert.match(guidanceActivity.payload.item.title, /已收到新的用户引导|New user guidance received/);

    const stoppedB = await stopTurn(sessionId, activeIdentity);
    assert.equal(stoppedB.payload?.matched, true, 'B must still be stoppable by its exact identity');

    await waitFor(
        message => message.type === 'chat.interrupted'
            && message.payload?.sessionId === sessionId
            && message.payload?.submissionId === submissionB,
        'chat.interrupted for B',
        0,
        5_000,
    );

    const runtimePaused = await sendAndWait('chat.runtime.get', { sessionId }, 'chat.runtime');
    assert.equal(runtimePaused.payload?.queue?.paused, true);
    assert.ok(runtimePaused.payload?.queue?.items?.some(item => item.runId === queueRunId));

    const deleted = await sendAndWait(
        'chat.queue.delete',
        { sessionId, runId: queueRunId },
        'chat.queue.delete.result',
    );
    assert.equal(deleted.payload?.ok, true);

    const runtimeAfter = await sendAndWait('chat.runtime.get', { sessionId }, 'chat.runtime');
    assert.equal(runtimeAfter.payload?.activeTurn, null);
    assert.equal(runtimeAfter.payload?.queue?.items?.length, 0);

    console.log(JSON.stringify({
        ok: true,
        sessionId,
        checks: [
            'exact-stop',
            'fresh-turn-after-stop',
            'stale-stop-isolation',
            'durable-queue',
            'queue-edit',
            'steer-targeting',
            'visible-guidance-activity',
            'queue-pause-after-stop',
            'queue-delete',
        ],
    }, null, 2));
} finally {
    if (sessionId) {
        try {
            if (activeIdentity) await stopTurn(sessionId, activeIdentity);
        } catch {
            // Best-effort cleanup after an assertion failure.
        }
        try {
            await sendAndWait('chat.queue.clear', { sessionId }, 'chat.queue.clear.result');
        } catch {
            // Best-effort cleanup after an assertion failure.
        }
        try {
            await sendAndWait('sessions.delete', { sessionId }, 'sessions.delete');
        } catch {
            // Best-effort cleanup after an assertion failure.
        }
    }
    ws.close();
}
