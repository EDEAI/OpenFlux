import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const sessionId = process.argv[2];
const input = process.argv.slice(3).join(' ').trim();
if (!sessionId || !input) throw new Error('Usage: send-gateway-steer.mjs <sessionId> <guidance>');
const socket = new WebSocket(process.env.OPENFLUX_GATEWAY_URL || 'ws://127.0.0.1:18801');
const requestId = randomUUID();
const timeout = setTimeout(() => {
    socket.close();
    throw new Error('Gateway steer timed out');
}, 15_000);
socket.on('message', raw => {
    const message = JSON.parse(String(raw));
    if (message.type === 'welcome') {
        socket.send(JSON.stringify({
            type: 'chat',
            id: requestId,
            payload: {
                input,
                sessionId,
                agentId: 'presentation',
                approvalMode: 'full_access',
                source: 'desktop',
                delivery: 'steer',
                submissionId: randomUUID(),
            },
        }));
        return;
    }
    if (message.id === requestId || message.type === 'chat.steer.accepted') {
        clearTimeout(timeout);
        process.stdout.write(JSON.stringify(message, null, 2));
        socket.close();
    }
});
