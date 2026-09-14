#!/usr/bin/env node
/**
 * Fake OpenFluxRouter for local end-to-end checks of the group flow
 * (P1 接收 → P2 待分配/分配 → P3 排队执行 → P4 结果回传) without touching
 * a real Router or IM platform.
 *
 * Usage:
 *   node scripts/fake-router.mjs [--port 8899] [--channel cidTEST] [--name 测试群]
 *
 * Then point the OpenFlux client at it (server-config.json → router):
 *   { "url": "ws://127.0.0.1:8899/ws/app", "appId": "app-test", "apiKey": "ofr_test", "appUserId": "<any>", "enabled": true }
 *
 * Interactive commands on stdin once a client is connected:
 *   mention <text>     deliver a group message (pending until assigned, then assigned)
 *   context <text>     deliver a plain group message (not @bot; context only)
 *   status             print what the fake Router believes
 *   quit
 *
 * What it checks and prints:
 *   - handshake headers (protocol version 2, capabilities incl. group_context_v1 and the assignment capability)
 *   - runtime.register (replays pending deliveries after it, like the real Router)
 *   - project_context.ack per delivery (marks delivery acked)
 *   - external_conversation.assign / dismiss (answers .result, flips mapping state)
 *   - group_message.send (notices) and group_work.publish (answers group_work.result, idempotent per trigger)
 */
import { WebSocketServer } from 'ws';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const port = Number(opt('port', '8899'));
const channelId = opt('channel', 'cidTEST');
const channelName = opt('name', '测试群');
const platformId = 'platform-fake';
const platformType = opt('platform', 'dingtalk');
const workspaceId = 'corp-fake';
const mappingId = `map-${channelId}`;

const state = {
    client: null,
    identity: null,
    mapping: { status: 'unmapped', targetId: '', targetKind: '', revision: 1, operationId: '' },
    deliveries: new Map(), // delivery_id -> { payload, acked }
    published: new Map(),  // trigger_event_id -> content
    seq: 0,
};

const log = (...parts) => console.log(new Date().toISOString().slice(11, 19), ...parts);
const send = (frame) => {
    if (!state.client || state.client.readyState !== 1) return false;
    state.client.send(JSON.stringify(frame));
    return true;
};

function buildDelivery(text, botMentioned) {
    state.seq += 1;
    const eventId = `evt-${state.seq}`;
    const externalEventId = `msg-${state.seq}`;
    const deliveryId = `dlv-${state.seq}`;
    const assigned = state.mapping.status === 'active';
    const payload = {
        action: 'project_context.append',
        delivery_id: deliveryId,
        event_id: eventId,
        external_event_id: externalEventId,
        event_type: 'message_created',
        mapping_id: mappingId,
        platform_id: platformId,
        platform_type: platformType,
        workspace_id: workspaceId,
        channel_id: channelId,
        channel_name: channelName,
        thread_id: '',
        message_id: externalEventId,
        project_id: assigned ? state.mapping.targetId : '',
        assignment_state: assigned ? 'assigned' : 'pending',
        sender_platform_id: 'staff-tester',
        sender_display_name: '测试成员',
        sender_type: 'human',
        sender_is_current_member: true,
        bot_mentioned: botMentioned,
        agent_execution_allowed: botMentioned,
        suppress_agent_execution: !botMentioned,
        history_import: false,
        text,
        mentions: botMentioned ? [{ platform_user_id: 'bot', display_name: '机器人', is_bot: true }] : [],
        attachments: [],
        created_at: Date.now(),
        document_references: [],
    };
    state.deliveries.set(deliveryId, { payload, acked: false });
    return payload;
}

function deliver(text, botMentioned) {
    if (state.mapping.status === 'unmapped' && botMentioned) {
        state.mapping.status = 'pending_assignment';
        log('mapping → pending_assignment (first real mention)');
    }
    if (state.mapping.status === 'assignment_dismissed') {
        log('group dismissed; event stored, nothing delivered');
        return;
    }
    const payload = buildDelivery(text, botMentioned);
    if (send(payload)) log(`→ project_context.append ${payload.delivery_id} (${payload.assignment_state})`);
    else log('client offline; delivery kept pending');
}

function replayPending() {
    for (const entry of state.deliveries.values()) {
        if (!entry.acked && send(entry.payload)) log(`→ replay ${entry.payload.delivery_id}`);
    }
}

function handle(msg) {
    const action = msg.action;
    if (msg.direction === 'outbound') {
        log(`← private outbound to ${msg.platform_user_id}: ${String(msg.content).slice(0, 80)}`);
        return;
    }
    switch (action) {
        case 'runtime.register':
            log(`← runtime.register projects=${(msg.projects || []).map(p => `${p.name}(${p.id})`).join(', ') || '(none)'}`);
            state.identity = { ...state.identity, projects: msg.projects || [] };
            setTimeout(replayPending, 200);
            return;
        case 'project_context.ack': {
            const entry = state.deliveries.get(msg.delivery_id);
            if (entry) entry.acked = true;
            log(`← ack ${msg.delivery_id} session=${msg.session_id || '-'} ${entry ? '' : '(unknown delivery)'}`);
            return;
        }
        case 'external_conversation.assign': {
            const reply = { action: 'external_conversation.assign.result', request_id: msg.request_id };
            if (msg.mapping_id !== mappingId) {
                send({ ...reply, success: false, message: '没有找到属于当前设备的待分配群' });
            } else if (state.mapping.status === 'active' && state.mapping.operationId === msg.operation_id) {
                send({ ...reply, success: true, data: { id: mappingId, outcome: 'replayed', target_kind: state.mapping.targetKind, project_id: state.mapping.targetId, assignment: { state: 'assigned', revision: state.mapping.revision } } });
            } else if (state.mapping.status === 'active') {
                send({ ...reply, success: false, message: '这个群已经分配给其他 Project 或 Agent' });
            } else if (msg.expected_revision != null && msg.expected_revision !== state.mapping.revision) {
                send({ ...reply, success: false, message: '待分配记录已被更新，请刷新后重试' });
            } else {
                state.mapping = { status: 'active', targetId: msg.target_id, targetKind: msg.target_kind, revision: state.mapping.revision + 1, operationId: msg.operation_id };
                for (const entry of state.deliveries.values()) {
                    if (!entry.payload.project_id) entry.payload.project_id = msg.target_id;
                }
                send({ ...reply, success: true, data: { id: mappingId, outcome: 'applied', target_kind: msg.target_kind, project_id: msg.target_id, project_name: msg.target_name, assignment: { state: 'assigned', revision: state.mapping.revision } } });
                log(`mapping → active (${msg.target_kind} ${msg.target_name})`);
            }
            return;
        }
        case 'external_conversation.dismiss': {
            const reply = { action: 'external_conversation.dismiss.result', request_id: msg.request_id };
            if (state.mapping.status !== 'pending_assignment') {
                send({ ...reply, success: false, message: '只有待分配的群可以忽略' });
            } else {
                state.mapping.status = 'assignment_dismissed';
                send({ ...reply, success: true, data: { id: mappingId, outcome: 'applied', status: 'assignment_dismissed' } });
                log('mapping → assignment_dismissed');
            }
            return;
        }
        case 'group_message.send':
            log(`← group_message.send [${msg.channel_id}] ${String(msg.content).slice(0, 120)}`);
            return;
        case 'group_work.publish': {
            const trigger = msg.trigger_event_id;
            const known = [...state.deliveries.values()].some(entry => entry.payload.external_event_id === trigger);
            if (!known) {
                send({ action: 'group_work.result', trigger_event_id: trigger, success: false, status: 'failed', errors: ['没有找到触发这次处理的群消息'] });
                log(`← group_work.publish unknown trigger ${trigger} → failed`);
                return;
            }
            const duplicate = state.published.has(trigger);
            state.published.set(trigger, msg.public_reply);
            send({ action: 'group_work.result', trigger_event_id: trigger, success: true, status: 'sent', sent_count: duplicate ? 0 : 1, pending_count: 0 });
            log(`← group_work.publish ${trigger}${duplicate ? ' (duplicate, idempotent)' : ''}: ${String(msg.public_reply).slice(0, 120)}`);
            return;
        }
        case 'bind':
        case 'generate_qr_bind':
            send({ action: 'connect_status', bound: true, platform_id: platformId, platform_user_id: 'staff-tester' });
            return;
        default:
            if (Array.isArray(msg)) return;
            log(`← ${action || '(no action)'} ${JSON.stringify(msg).slice(0, 160)}`);
    }
}

// Optional HTTP control port so scripts (or a second terminal) can drive the
// same commands without stdin: POST /mention?text=..., POST /context?text=..., GET /status
const controlPort = Number(opt('control-port', '0'));
if (controlPort > 0) {
    const { createServer } = await import('node:http');
    createServer((req, res) => {
        const url = new URL(req.url || '/', 'http://localhost');
        const text = url.searchParams.get('text') || '';
        if (url.pathname === '/mention') deliver(text || '帮我看下登录问题', true);
        else if (url.pathname === '/context') deliver(text || '大家注意一下发布时间', false);
        else if (url.pathname !== '/status') { res.statusCode = 404; res.end('unknown'); return; }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
            client: Boolean(state.client), identity: state.identity, mapping: state.mapping,
            deliveries: [...state.deliveries.values()].map(e => ({ id: e.payload.delivery_id, acked: e.acked, project_id: e.payload.project_id, text: e.payload.text })),
            published: Object.fromEntries(state.published),
        }));
    }).listen(controlPort, '127.0.0.1', () => log(`control endpoint on http://127.0.0.1:${controlPort}/{mention|context|status}`));
}

const wss = new WebSocketServer({ port, path: '/ws/app' });
wss.on('connection', (ws, req) => {
    const h = req.headers;
    const capabilities = String(h['x-openflux-capabilities'] || '').split(',').map(s => s.trim()).filter(Boolean);
    const protocol = String(h['x-openflux-protocol-version'] || '');
    const compatible = protocol === '2' && capabilities.length > 0;
    state.client = ws;
    state.identity = { appId: h['x-app-id'], appUserId: h['x-app-user-id'], clientVersion: h['x-openflux-client-version'], protocol, capabilities };
    log(`client connected app=${h['x-app-id']} device=${h['x-app-user-id']} protocol=${protocol || '(none)'} caps=${capabilities.join(',') || '(none)'}`);
    if (!capabilities.includes('group_context_v1')) log('!! group_context_v1 not declared: real Router would withhold group deliveries');
    if (!capabilities.includes('external_conversation_assignment_v1')) log('!! assignment capability not declared: real Router would not open pending cards');
    send({
        action: 'router_hello', server_version: 'fake-1', protocol_version: '2',
        capabilities: ['private_text_v1', 'group_context_v1', 'external_conversation_assignment_v1'],
        compatibility_state: compatible ? 'compatible' : 'upgrade_required', client_version: h['x-openflux-client-version'] || '',
    });
    send({ action: 'connect_status', bound: true, platform_id: platformId, platform_user_id: 'staff-tester' });
    ws.on('message', data => {
        try { handle(JSON.parse(data.toString())); } catch (error) { log('bad frame', String(error)); }
    });
    ws.on('close', () => { log('client disconnected'); if (state.client === ws) state.client = null; });
});
log(`fake Router listening on ws://127.0.0.1:${port}/ws/app  channel=${channelId} (${channelName}) platform=${platformType}`);
log('commands: mention <text> | context <text> | status | quit');

const rl = createInterface({ input: process.stdin });
rl.on('line', line => {
    const [cmd, ...rest] = line.trim().split(/\s+/);
    const text = rest.join(' ');
    if (cmd === 'mention') deliver(text || '帮我看下登录问题', true);
    else if (cmd === 'context') deliver(text || '大家注意一下发布时间', false);
    else if (cmd === 'status') {
        console.log(JSON.stringify({
            client: Boolean(state.client), identity: state.identity, mapping: state.mapping,
            deliveries: [...state.deliveries.values()].map(e => ({ id: e.payload.delivery_id, acked: e.acked, project_id: e.payload.project_id })),
            published: [...state.published.keys()],
        }, null, 2));
    } else if (cmd === 'quit') process.exit(0);
    else if (cmd) console.log('unknown command');
});
