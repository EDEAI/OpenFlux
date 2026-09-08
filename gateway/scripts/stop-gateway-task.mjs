import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const [sessionId, turnId, runId] = process.argv.slice(2);
if (!sessionId || !turnId || !runId) throw new Error('Usage: stop-gateway-task.mjs <sessionId> <turnId> <runId>');
const socket = new WebSocket(process.env.OPENFLUX_GATEWAY_URL || 'ws://127.0.0.1:18801');
const requestId = randomUUID();
const timeout = setTimeout(() => {
    socket.close();
    throw new Error('Gateway stop timed out');
}, 15_000);
socket.on('message', raw => {
    const message = JSON.parse(String(raw));
    if (message.type === 'welcome') {
        socket.send(JSON.stringify({
            type: 'chat.stop',
            id: requestId,
            payload: { sessionId, turnId, runId },
        }));
        return;
    }
    if (message.id === requestId) {
        clearTimeout(timeout);
        process.stdout.write(JSON.stringify(message, null, 2));
        socket.close();
    }
});
