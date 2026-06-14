/**
 * Gateway Server - Minimalist Edition
 * Only responsible for WebSocket connection and message routing
 * Support multi-Agent mode (agentId routing)
 */

// @ts-ignore - Runtime with ws module
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'node:crypto';
import { SessionStore } from '../sessions';
import type { AgentManager } from '../agent/manager';
import { Logger, onLogBroadcast, type LogEntry } from '../utils/logger';

const log = new Logger('Gateway');

/**
 * Gateway configuration
 */
export interface GatewayConfig {
    /** WebSocket port */
    port?: number;
    /** Authentication Token */
    token?: string;
    /** Session storage path */
    sessionStorePath?: string;
    /** Agent execution callback (supports progress push, agentId routing and file attachment) */
    onAgentExecute?: (
        input: string,
        sessionId?: string,
        onProgress?: (event: AgentProgressEvent) => void,
        agentId?: string,
        attachments?: Array<{ path: string; name: string; size: number; ext: string }>
    ) => Promise<string>;
    /** Agent manager (used to obtain Agent list, etc.) */
    agentManager?: AgentManager;
}

/**
 * Agent progress event
 */
export interface AgentProgressEvent {
    type: 'iteration' | 'tool_start' | 'tool_result' | 'thinking' | 'token';
    iteration?: number;
    tool?: string;
    args?: Record<string, unknown>;
    result?: unknown;
    message?: string;
    thinking?: string;
    token?: string;
    description?: string;
    /** LLM original description text (tool_start event only, content from LLM) */
    llmDescription?: string;
}

/**
 * client connection
 */
interface GatewayClient {
    id: string;
    ws: WebSocket;
    authenticated: boolean;
    /** Whether to subscribe to the debug log */
    debugSubscribed?: boolean;
}

/**
 * Message type
 */
interface GatewayMessage {
    type: string;
    id?: string;
    payload?: unknown;
}

/**
 * Create Gateway Server
 */
export function createGatewayServer(config: GatewayConfig) {
    const port = config.port || 18801;
    const clients = new Map<string, GatewayClient>();
    const sessionStore = new SessionStore({ storePath: config.sessionStorePath });
    let wss: WebSocketServer | null = null;

    // Register global log broadcast: push logs to all clients subscribed to debug
    onLogBroadcast((entry: LogEntry) => {
        const debugMsg = JSON.stringify({
            type: 'debug.log',
            payload: entry,
        });
        for (const client of clients.values()) {
            if (client.debugSubscribed && client.ws.readyState === 1) {
                try {
                    client.ws.send(debugMsg);
                } catch {
                    // Failure to send does not affect other clients
                }
            }
        }
    });

    /**
     * handle connections
     */
    function handleConnection(ws: WebSocket): void {
        const clientId = crypto.randomUUID();
        const client: GatewayClient = {
            id: clientId,
            ws,
            authenticated: !config.token,
            debugSubscribed: false,
        };

        clients.set(clientId, client);
        log.info(`Client connected: ${clientId}`);

        send(client, {
            type: 'welcome',
            payload: { requireAuth: !!config.token },
        });

        ws.on('message', (data: Buffer) => handleMessage(client, data.toString()));
        ws.on('close', () => {
            clients.delete(clientId);
            log.info(`Client disconnected: ${clientId}`);
        });
        ws.on('error', (error: Error) => log.error(`Client error: ${clientId}`, { error }));
    }

    /**
     * Process messages
     */
    async function handleMessage(client: GatewayClient, data: string): Promise<void> {
        try {
            const message: GatewayMessage = JSON.parse(data);

            if (!client.authenticated && message.type !== 'auth') {
                send(client, { type: 'error', payload: { message: 'Not authenticated' } });
                return;
            }

            switch (message.type) {
                case 'auth':
                    handleAuth(client, message);
                    break;
                case 'chat':
                    await handleChat(client, message);
                    break;
                case 'sessions.list':
                    handleSessionsList(client, message);
                    break;
                case 'sessions.get':
                    handleSessionsGet(client, message);
                    break;
                case 'sessions.create':
                    handleSessionsCreate(client, message);
                    break;
                case 'agents.list':
                    handleAgentsList(client, message);
                    break;
                case 'debug.subscribe':
                    client.debugSubscribed = true;
                    log.info(`Client ${client.id} subscribed to debug logs`);
                    break;
                case 'debug.unsubscribe':
                    client.debugSubscribed = false;
                    log.info(`Client ${client.id} unsubscribed from debug logs`);
                    break;
                default:
                    send(client, { type: 'error', payload: { message: `Unknown type: ${message.type}` } });
            }
        } catch (error) {
            log.error('Message processing failed', { error });
            send(client, { type: 'error', payload: { message: 'Processing failed' } });
        }
    }

    /**
     * Certification
     */
    function handleAuth(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { token?: string } | undefined;
        if (payload?.token === config.token) {
            client.authenticated = true;
            send(client, { type: 'auth.success' });
        } else {
            send(client, { type: 'auth.failed' });
        }
    }

    /**
     * Chat (core)
     * Supports agentId routing: the client can specify the agentId, or it will be automatically routed if not specified.
     */
    async function handleChat(client: GatewayClient, message: GatewayMessage): Promise<void> {
        const payload = message.payload as {
            input: string;
            sessionId?: string;
            agentId?: string;
            attachments?: Array<{ path: string; name: string; size: number; ext: string }>;
        };
        const messageId = message.id || crypto.randomUUID();

        if (!payload?.input && !payload?.attachments?.length) {
            send(client, { type: 'error', payload: { message: 'Missing input' } });
            return;
        }

        send(client, { type: 'chat.start', id: messageId });

        try {
            // Call Agent to execute, passing in progress callback, agentId and attachments
            let output = '';
            if (config.onAgentExecute) {
                output = await config.onAgentExecute(
                    payload.input || '',
                    payload.sessionId,
                    (event) => {
                        // Push progress events to the client
                        send(client, {
                            type: 'chat.progress',
                            id: messageId,
                            payload: event,
                        });
                    },
                    payload.agentId,
                    payload.attachments
                );
            }

            send(client, {
                type: 'chat.complete',
                id: messageId,
                payload: { output },
            });
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            send(client, {
                type: 'chat.error',
                id: messageId,
                payload: { message: errorMsg },
            });
        }
    }

    /**
     * Conversation list
     */
    function handleSessionsList(client: GatewayClient, message: GatewayMessage): void {
        const sessions = sessionStore.list();
        send(client, { type: 'sessions.list', id: message.id, payload: { sessions } });
    }

    /**
     * Get session
     */
    function handleSessionsGet(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { sessionId: string };
        if (!payload?.sessionId) {
            send(client, { type: 'error', payload: { message: 'Missing sessionId' } });
            return;
        }

        const messages = sessionStore.getMessages(payload.sessionId);
        const metadata = sessionStore.get(payload.sessionId);
        send(client, { type: 'sessions.get', id: message.id, payload: { metadata, messages } });
    }

    /**
     * Create session
     */
    function handleSessionsCreate(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { title?: string; agentId?: string };
        const agentId = payload?.agentId || 'default';
        const session = sessionStore.create(agentId, payload?.title);
        send(client, { type: 'sessions.create', id: message.id, payload: { session } });
    }

    /**
     * Agent list
     */
    function handleAgentsList(client: GatewayClient, message: GatewayMessage): void {
        if (config.agentManager) {
            const agents = config.agentManager.getAgents().map(a => ({
                id: a.id,
                name: a.name || a.id,
                description: a.description || '',
                default: a.default || false,
                profile: a.tools?.profile || 'full',
            }));
            send(client, { type: 'agents.list', id: message.id, payload: { agents } });
        } else {
            // Single Agent mode
            send(client, {
                type: 'agents.list',
                id: message.id,
                payload: {
                    agents: [{ id: 'default', name: 'General Assistant', description: '', default: true, profile: 'full' }],
                },
            });
        }
    }

    /**
     * Send message
     */
    function send(client: GatewayClient, message: GatewayMessage): void {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify(message));
        }
    }

    return {
        start(): Promise<void> {
            return new Promise((resolve) => {
                wss = new WebSocketServer({ port });
                wss.on('connection', handleConnection);
                wss.on('listening', () => {
                    log.info(`Gateway started: ws://localhost:${port}`);
                    resolve();
                });
            });
        },

        stop(): Promise<void> {
            return new Promise((resolve) => {
                if (wss) {
                    wss.close(() => {
                        log.info('Gateway stopped');
                        resolve();
                    });
                } else {
                    resolve();
                }
            });
        },

        getSessionStore: () => sessionStore,
    };
}
