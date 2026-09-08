#!/usr/bin/env node
// Opt-in live Gateway evaluation; it is never run by the app or the default test suite.
// Connects to the existing local Gateway and may consume its configured model quota.
// Creates UUID test conversations, never approves tool-permission requests, and
// cleans up only conversations and turns proven to belong to this invocation.
// YAML is read only for remote.token; reports redact it and do not include unrelated messages.
// Usage from gateway: node scripts/user-input-gateway-eval.mjs --root <project-root>
//   --configyaml <gateway-config.yaml> --out <report.json> [--case original|known|simple|delegate]
// All four cases run by default. The original case answers its own test question
// once, verifies continuation/idempotency, then removes that temporary conversation.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const flags = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
    const name = process.argv[index];
    const value = process.argv[index + 1];
    if (!['--root', '--configyaml', '--out', '--case'].includes(name) || !value || value.startsWith('--')) {
        throw new Error('Usage: --root <project> --configyaml <config> --out <report.json> [--case original|known|simple|delegate]');
    }
    if (flags.has(name)) throw new Error(`Duplicate argument: ${name}`);
    flags.set(name, value);
}
for (const name of ['--root', '--configyaml', '--out']) assert.ok(flags.has(name), `${name} is required`);
const root = path.resolve(flags.get('--root'));
const out = path.resolve(flags.get('--out'));
const chosenCase = flags.get('--case');
assert.ok(!chosenCase || ['original', 'known', 'simple', 'delegate'].includes(chosenCase), '--case must be original, known, simple or delegate');
const cases = [
    { id: 'original', input: '我现在要做一个电吉他训练的工具 你有什么好的建议', expected: 'clarify' },
    { id: 'known', input: '我要做一个电吉他训练工具，先给自己每天练琴，建议三个首版功能，不需要代码。', expected: 'answer' },
    { id: 'simple', input: '2+2 等于多少？只回复一个数字。', expected: 'answer' },
    { id: 'delegate', input: '我要做一个电吉他训练工具，先给自己每天练琴用，其他细节你自行决定。直接给我三个首版功能建议，不写代码。', expected: 'answer' },
].filter(item => !chosenCase || item.id === chosenCase);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invocationId = randomUUID();
const ownSessions = new Map();
const rpcHistory = new Map();
const pending = new Map();
const events = [];
const summaries = [];
const report = { invocationId, at: new Date().toISOString(), gateway: 'ws://127.0.0.1:18801', cases: [], passed: false };
let WebSocket;
let ws;
let token;
let stopRequested = false;
let cleanupMode = false;
let phase = 'initializing';
let phaseAt = Date.now();
let ready = false;
let authentication;

function redact(value) {
    let text = String(value ?? '');
    if (token) text = text.split(token).join('[REDACTED]');
    return text.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
        .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|authorization)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}
function errorText(error) { return redact(error instanceof Error ? error.message : error).slice(0, 2000); }
function progress(next) { phase = next; phaseAt = Date.now(); console.log(JSON.stringify({ phase: next })); }
async function saveReport() {
    await mkdir(path.dirname(out), { recursive: true });
    report.messageSummaries = summaries.slice(-2000);
    await writeFile(out, JSON.stringify(report, (_key, value) => typeof value === 'string' ? redact(value) : value, 2), 'utf8');
}
function check(result, name, condition) {
    result.checks.push({ name, passed: Boolean(condition) });
    console.log(JSON.stringify({ case: result.id, check: name, passed: Boolean(condition) }));
    assert.ok(condition, name);
}
function own(sessionId) {
    assert.ok(UUID.test(sessionId || '') && ownSessions.has(sessionId), 'Refusing an operation on a conversation not created by this invocation');
    return ownSessions.get(sessionId);
}
function summarize(message, sessionId) {
    const payload = message.payload || {};
    // Never serialize arbitrary payloads: the Gateway also broadcasts unrelated
    // session, config and tool messages to authenticated clients.
    return {
        at: new Date().toISOString(), type: message.type, id: message.id, sessionId,
        ...(typeof payload.status === 'string' ? { status: payload.status } : {}),
        ...(typeof payload.type === 'string' ? { eventType: payload.type } : {}),
        ...(typeof payload.tool === 'string' ? { tool: payload.tool } : {}),
        ...(payload.item?.tool ? { tool: payload.item.tool } : {}),
        ...(payload.turnId ? { turnId: payload.turnId } : {}),
        ...(payload.runId ? { runId: payload.runId } : {}),
        ...(payload.pendingUserInput ? { requestId: payload.pendingUserInput.id, questionCount: payload.pendingUserInput.questions?.length } : {}),
        ...(/error$/.test(message.type) ? { error: errorText(payload.message || payload.error || message.type) } : {}),
        ...(typeof payload.output === 'string' ? { outputLength: payload.output.length } : {}),
    };
}
function adoptCreatedSession(message) {
    const rpc = rpcHistory.get(message.id);
    const session = message.payload?.session;
    if (rpc?.type !== 'sessions.create' || !session || !UUID.test(session.id || '')) return;
    const attempt = rpc.attempt;
    if (!attempt || session.title !== attempt.title || session.agentId !== 'main') return;
    attempt.sessionId = session.id;
    ownSessions.set(session.id, attempt);
}
function onMessage(raw) {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    if (message.type === 'auth.success') authentication?.resolve();
    if (message.type === 'auth.failed') authentication?.reject(new Error('Gateway authentication failed'));
    adoptCreatedSession(message);
    const rpc = rpcHistory.get(message.id);
    const sessionId = message.payload?.sessionId || rpc?.sessionId;
    if (ownSessions.has(sessionId)) {
        const entry = summarize(message, sessionId);
        summaries.push(entry);
        if (summaries.length > 2500) summaries.shift();
        const testCase = ownSessions.get(sessionId).result;
        if (entry.tool || message.type === 'chat.progress' && ['tool_start', 'tool_result'].includes(message.payload?.type)) {
            testCase.toolEvents.push(entry);
            if (testCase.toolEvents.length > 1000) testCase.toolEvents.shift();
        }
        if (['chat.start', 'chat.complete', 'chat.error', 'chat.interrupted', 'work.state.updated', 'tool.approval.request'].includes(message.type)) {
            events.push({ ...message, sessionId });
            if (events.length > 1000) events.shift();
        }
    }
    const item = pending.get(message.id);
    if (item && !['chat.start', 'chat.progress', 'agent.event'].includes(message.type)) {
        clearTimeout(item.timer);
        pending.delete(message.id);
        if (message.type === 'error' || message.type.endsWith('.error') || message.payload?.error) {
            item.reject(new Error(errorText(message.payload?.message || message.payload?.error || message.type)));
        } else item.resolve({ id: message.id, type: message.type, payload: message.payload });
    }
}
async function connect() {
    if (ready && ws?.readyState === WebSocket.OPEN) return;
    progress(cleanupMode ? 'cleanup: reconnect' : 'connecting');
    ws = new WebSocket(report.gateway);
    const socket = ws;
    socket.on('message', onMessage);
    socket.on('error', () => {});
    socket.on('close', () => {
        if (ws !== socket) return;
        ready = false;
        for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Gateway disconnected')); }
        pending.clear();
    });
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.terminate(); reject(new Error('Gateway connection timed out')); }, 10000);
        socket.once('open', () => { clearTimeout(timer); resolve(); });
        socket.once('error', () => { clearTimeout(timer); reject(new Error('Gateway connection failed')); });
    });
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Gateway authentication timed out')), 10000);
        authentication = {
            resolve: () => { clearTimeout(timer); resolve(); },
            reject: error => { clearTimeout(timer); reject(error); },
        };
        socket.send(JSON.stringify({ type: 'auth', payload: { token } }));
    });
    authentication = undefined;
    ready = true;
    await call('client.register', { role: 'desktop', instanceId: `input-policy-${invocationId}` });
}
function call(type, payload, extra = {}) {
    assert.ok(ready && ws?.readyState === WebSocket.OPEN, 'Gateway is not connected');
    if (payload?.sessionId) own(payload.sessionId);
    const id = randomUUID();
    rpcHistory.set(id, { type, sessionId: payload?.sessionId, ...extra });
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${type} timed out`)); }, 20000);
        pending.set(id, { timer, resolve, reject });
        ws.send(JSON.stringify({ type, id, payload }));
    });
}
async function until(predicate, label, milliseconds = 180000) {
    progress(label);
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) {
        if (stopRequested && !cleanupMode) throw new Error('Regression interrupted; cleaning up owned sessions');
        if (!ready) throw new Error('Gateway disconnected while awaiting model output');
        const value = await predicate();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error(`Model wait exceeded ${milliseconds / 1000}s: ${label}`);
}
function terminal(sessionId, turnId) {
    const event = events.findLast(item => item.sessionId === sessionId && item.id === turnId
        && ['chat.complete', 'chat.error', 'chat.interrupted'].includes(item.type));
    if (event && event.type !== 'chat.complete') throw new Error(errorText(event.payload?.message || event.type));
    return event?.payload;
}
function pendingQuestion(sessionId) {
    return events.findLast(item => item.sessionId === sessionId && item.type === 'work.state.updated' && item.payload?.pendingUserInput)?.payload;
}
async function sendChat(sessionId, input) {
    const attempt = own(sessionId);
    const submissionId = randomUUID();
    // chat's message id, rather than its submissionId, is the turn id.
    const promise = call('chat', { sessionId, input, source: 'local', mode: 'normal', approvalMode: 'ask', submissionId });
    const rpcId = [...rpcHistory.keys()].at(-1);
    attempt.turnIds.add(rpcId);
    const accepted = await promise;
    assert.equal(accepted.type, 'chat.accepted');
    assert.ok(['started', 'queued'].includes(accepted.payload?.disposition), 'Temporary test chat was not accepted');
    return rpcId;
}
async function visibleMessages(sessionId) {
    own(sessionId);
    const { payload } = await call('sessions.messages', { sessionId });
    assert.ok(Array.isArray(payload?.messages), 'Gateway did not return conversation messages');
    return payload.messages;
}
async function runCase(definition, result, attempt) {
    const created = await call('sessions.create', { title: attempt.title, agentId: 'main', approvalMode: 'ask' }, { attempt });
    const session = created.payload?.session;
    assert.ok(session && UUID.test(session.id || '') && ownSessions.has(session.id), 'Create did not return an owned UUID conversation');
    const sessionId = session.id;
    result.sessionId = sessionId;
    const turnId = await sendChat(sessionId, definition.input);
    result.turnId = turnId;
    await saveReport();
    if (definition.expected === 'clarify') {
        const state = await until(() => {
            const finished = terminal(sessionId, turnId);
            if (finished && finished.status !== 'waiting_input') throw new Error('Original wording completed without the expected clarification');
            return pendingQuestion(sessionId);
        }, `${definition.id}: waiting for a question card`);
        const request = state.pendingUserInput;
        attempt.turnIds.add(request.continuationSubmissionId);
        result.requestId = request.id;
        result.questions = request.questions;
        check(result, 'Initial advice asks one high-impact question, not a questionnaire', request.questions?.length === 1);
        const questionText = request.questions.map(question => [question.prompt, ...question.options.map(option => option.label)].join(' ')).join(' ');
        check(result, 'Initial advice does not block on implementation platform or stack', !/(?:平台|技术栈|桌面软件|手机App|iOS|Android|Web\/小程序)/i.test(questionText));
        check(result, 'The question establishes audience or purpose', /(?:谁|用途|自用|自己|面向|目标|用户|教学|老师|人群)/.test(questionText));
        check(result, 'Normal mode exposes a renderable question card', state.mode === 'normal'
            && request.status === 'pending' && request.questions?.length >= 1 && request.questions.length <= 3
            && request.questions.every(question => typeof question.prompt === 'string' && question.prompt.trim()
                && question.options?.length >= 2 && question.options.length <= 3 && question.allowOther !== false));
        const waiting = await until(() => terminal(sessionId, turnId), `${definition.id}: waiting_input status`);
        check(result, 'The requesting turn explicitly settles as waiting_input', waiting.status === 'waiting_input');
        const questionMessages = await visibleMessages(sessionId);
        check(result, 'The card question persists exactly once', questionMessages.filter(message =>
            message.metadata?.kind === 'user_input_question' && message.metadata.requestId === request.id).length === 1);
        const hold = (await call('chat.queue.resume', { sessionId })).payload;
        check(result, 'A generic queue resume cannot bypass the unanswered question', hold.ok === false && hold.paused === true);
        // This is the only automatic user answer in the script, in this owned
        // temporary case only. Do not select/reinterpret the model's options.
        own(sessionId);
        const answers = request.questions.map(question => ({ questionId: question.id, optionIds: [], other: '先给自己练琴用' }));
        result.answer = '先给自己练琴用';
        const submissionId = randomUUID();
        const payload = { sessionId, requestId: request.id, submissionId, answers };
        const first = (await call('user.input.resolve', payload)).payload;
        const repeated = (await call('user.input.resolve', payload)).payload;
        check(result, 'Repeating the same submission is idempotent', first.duplicate === false && repeated.duplicate === true);
        const completed = await until(() => {
            const nextQuestion = events.findLast(item => item.sessionId === sessionId && item.type === 'work.state.updated'
                && item.payload?.pendingUserInput && item.payload.pendingUserInput.id !== request.id);
            if (nextQuestion) throw new Error('The answer triggered another clarification instead of continuing the task');
            return terminal(sessionId, request.continuationSubmissionId);
        }, `${definition.id}: continuation`, 180000);
        result.output = completed.output;
        check(result, 'The answer resumes and completes the same task', completed.status === 'completed' && String(completed.output || '').trim().length > 20);
        const restored = (await call('work.state.get', { sessionId })).payload;
        check(result, 'No further input is pending after continuation', !restored.pendingUserInput);
        check(result, 'Continuation identifies the question for duplicate-free UI rendering', events.some(item =>
            item.sessionId === sessionId && item.type === 'chat.start' && item.payload?.userInputRequestId === request.id));
        const messages = await visibleMessages(sessionId);
        result.transcript = messages.map(message => ({ id: message.id, role: message.role, content: message.content, kind: message.metadata?.kind, requestId: message.metadata?.requestId }));
        check(result, 'One question and one answer exist in conversation history', messages.filter(message => message.metadata?.kind === 'user_input_question').length === 1
            && messages.filter(message => message.metadata?.kind === 'user_input_answer' && message.metadata.requestId === request.id).length === 1);
        check(result, 'The continuation does not append a duplicate user answer', messages.filter(message => message.role === 'user').length === 2);
    } else {
        const completed = await until(() => {
            if (pendingQuestion(sessionId)) throw new Error('A sufficiently specified request produced an unnecessary question');
            return terminal(sessionId, turnId);
        }, `${definition.id}: direct answer`);
        result.output = completed.output;
        check(result, 'The specified request completes directly', completed.status === 'completed' && Boolean(String(completed.output || '').trim()));
        const state = (await call('work.state.get', { sessionId })).payload;
        const messages = await visibleMessages(sessionId);
        result.transcript = messages.map(message => ({ id: message.id, role: message.role, content: message.content, kind: message.metadata?.kind }));
        check(result, 'No question card or answer request is persisted', !state.pendingUserInput
            && !messages.some(message => message.metadata?.kind === 'user_input_question')
            && !result.toolEvents.some(event => event.tool === 'request_user_input'));
        if (definition.id === 'simple') check(result, '2+2 is answered as 4', /^4[。.!！]?$/.test(String(completed.output).trim()));
    }
    check(result, 'Internal decision markers are never shown in conversation history', !result.transcript?.some(message => /^\s*CONTINUE\s*[.!。]?\s*$/.test(message.content || '')));
    check(result, 'No tool permission was automatically requested for clarification', !events.some(item => item.sessionId === sessionId && item.type === 'tool.approval.request'));
}

async function recoverLostCreate(attempt) {
    if (attempt.sessionId) return;
    // A lost create ACK must not leak an orphan test conversation. Read only
    // list metadata, match this invocation's unique title, and never report the
    // rest of the list or read any other conversation's messages.
    const { payload } = await call('sessions.list', { agentId: 'main' });
    const matches = (payload?.sessions || []).filter(session => session.title === attempt.title
        && session.agentId === 'main' && UUID.test(session.id || '')
        && Number(session.createdAt) >= attempt.createdAt - 5000);
    if (matches.length > 1) throw new Error('Ambiguous ownership after lost create ACK; refusing deletion');
    if (matches.length === 1) {
        attempt.sessionId = matches[0].id;
        attempt.result.sessionId = matches[0].id;
        ownSessions.set(matches[0].id, attempt);
    }
}
async function cleanup(attempt) {
    const result = attempt.result;
    cleanupMode = true;
    result.cleanup = { passed: false, deleted: false };
    try {
        await connect();
        await recoverLostCreate(attempt);
        if (!attempt.sessionId) { result.cleanup = { passed: true, deleted: false, reason: 'No owned conversation was created' }; return; }
        const sessionId = attempt.sessionId;
        own(sessionId);
        progress(`${result.id}: cleanup owned conversation`);
        await call('chat.queue.pause', { sessionId });
        const state = (await call('work.state.get', { sessionId })).payload;
        if (state.pendingUserInput) {
            assert.ok(attempt.turnIds.has(state.pendingUserInput.turnId), 'Refusing to cancel an input request from an unowned turn');
            await call('user.input.cancel', { sessionId, requestId: state.pendingUserInput.id });
        }
        const runtime = (await call('chat.runtime.get', { sessionId })).payload;
        const active = runtime.activeTurn;
        if (active) {
            assert.ok(attempt.turnIds.has(active.turnId), 'Refusing to stop a turn not sent by this invocation');
            await call('chat.stop', { sessionId, turnId: active.turnId, runId: active.runId, submissionId: active.submissionId });
        }
        const afterStop = (await call('chat.runtime.get', { sessionId })).payload;
        assert.ok(!afterStop.activeTurn, 'Owned turn is still active; refusing session deletion');
        const queued = afterStop.queue?.items || afterStop.items || [];
        assert.ok(queued.every(item => attempt.turnIds.has(item.turnId)), 'Refusing to clear queue items from unowned turns');
        await call('chat.queue.clear', { sessionId });
        const finalState = (await call('work.state.get', { sessionId })).payload;
        assert.ok(!finalState.pendingUserInput, 'Owned question is still pending; refusing session deletion');
        const deleted = (await call('sessions.delete', { sessionId })).payload;
        assert.equal(deleted.success, true);
        result.cleanup = { passed: true, deleted: true, sessionId };
        ownSessions.delete(sessionId);
    } catch (error) {
        result.cleanup.error = errorText(error);
        result.cleanup.sessionId = attempt.sessionId;
        console.error(JSON.stringify({ case: result.id, cleanupError: errorText(error), sessionId: attempt.sessionId }));
    } finally { cleanupMode = false; }
}

process.on('SIGINT', () => { stopRequested = true; });
process.on('SIGTERM', () => { stopRequested = true; });
const heartbeat = setInterval(() => {
    console.log(JSON.stringify({ heartbeat: true, phase, elapsedSeconds: Math.round((Date.now() - phaseAt) / 1000), ownSessionCount: ownSessions.size }));
}, 20000);
try {
    const require = createRequire(path.join(root, 'gateway', 'package.json'));
    WebSocket = require('ws');
    try {
        const parsed = require('yaml').parse(await readFile(path.resolve(flags.get('--configyaml')), 'utf8'));
        token = parsed?.remote?.token;
        if (token !== undefined && typeof token !== 'string') throw new Error('invalid token configuration');
    } catch { throw new Error('Unable to read Gateway authentication token from the specified YAML; configuration contents are omitted'); }
    await connect();
    for (const definition of cases) {
        if (stopRequested) break;
        const result = { id: definition.id, input: definition.input, expected: definition.expected, checks: [], toolEvents: [], passed: false };
        report.cases.push(result);
        const attempt = { title: `交互策略回归测试:${randomUUID()}`, createdAt: Date.now(), turnIds: new Set(), result };
        result.title = attempt.title;
        try {
            await runCase(definition, result, attempt);
            result.passed = true;
        } catch (error) {
            result.error = errorText(error);
            // If possible, keep only this test's visible conversation for diagnosis.
            if (attempt.sessionId && ready) {
                try { result.transcript = (await visibleMessages(attempt.sessionId)).map(message => ({ id: message.id, role: message.role, content: message.content, kind: message.metadata?.kind })); }
                catch (captureError) { result.transcriptError = errorText(captureError); }
            }
            console.error(JSON.stringify({ case: result.id, error: result.error }));
        } finally {
            await cleanup(attempt);
            await saveReport();
        }
    }
    report.passed = !stopRequested && report.cases.length === cases.length
        && report.cases.every(result => result.passed && result.cleanup?.passed);
} catch (error) {
    report.error = errorText(error);
    console.error(JSON.stringify({ error: report.error }));
} finally {
    report.finishedAt = new Date().toISOString();
    report.remainingOwnedSessions = [...ownSessions.keys()];
    if (ownSessions.size) report.passed = false;
    try { await saveReport(); } catch (error) { report.passed = false; console.error(JSON.stringify({ reportWriteError: errorText(error) })); }
    clearInterval(heartbeat);
    for (const item of pending.values()) clearTimeout(item.timer);
    pending.clear();
    ws?.close();
    const socket = ws;
    setTimeout(() => socket?.terminate(), 1000).unref();
    token = undefined;
}
console.log(JSON.stringify({ passed: report.passed, cases: report.cases.map(item => ({ id: item.id, passed: item.passed, cleanup: item.cleanup?.passed })), report: out }));
if (!report.passed) process.exitCode = 1;
