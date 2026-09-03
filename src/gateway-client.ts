/**
 * WebSocket client wrapper
 * Used by the renderer process to connect to the Gateway Server
 */

import { t, tServerCopy } from './i18n/index';
import { isAgentEventV1, type AgentEventV1 } from './chat/activity-state';
import type { ApprovalMode } from './chat/approval-mode';
import type { ChatDelivery, RuntimeSnapshotPayload } from './chat/follow-up-controller';

export type {
    ChatAcceptedPayload,
    ChatDelivery,
    FollowUpQueueItem,
    FollowUpQueueState,
    RuntimeSnapshotPayload,
} from './chat/follow-up-controller';

export type { ApprovalMode } from './chat/approval-mode';

export type { AgentEventV1 } from './chat/activity-state';

export interface ProgressEvent {
    type: 'iteration' | 'thinking' | 'tool_start' | 'tool_result' | 'token' | 'stream_reset' | 'complete';
    iteration?: number;
    tool?: string;
    args?: Record<string, unknown>;
    result?: unknown;
    thinking?: string;
    token?: string;
    output?: string;
    description?: string;
    /** Raw LLM description text (tool_start event only, from the LLM content) */
    llmDescription?: string;
    /** Associated session ID (for cross-session isolation, carried on Router message broadcast) */
    sessionId?: string;
    /** Stable execution identity used to fence late events from retired turns. */
    turnId?: string;
    runId?: string;
    submissionId?: string;
    reason?: string;
    provisional?: boolean;
}

export interface ChatOptions {
    source?: 'local' | 'cloud';
    chatroomId?: number;
    agentId?: string;
    approvalMode?: ApprovalMode;
    delivery?: ChatDelivery;
    targetTurnId?: string;
    targetRunId?: string;
    submissionId?: string;
    fallback?: 'queue';
}

export interface Session {
    id: string;
    agentId: string;
    title?: string;
    createdAt: number;
    updatedAt: number;
    messageCount?: number;
    lastMessagePreview?: string;
    cloudChatroomId?: number;
    cloudAgentName?: string;
    approvalMode: ApprovalMode;
}

export interface LocalEntityView {
    id: string;
    kind?: 'agent' | 'project';
    name: string;
    description?: string;
    icon?: string;
    color?: string;
    default?: boolean;
    locked?: boolean;
    systemPrompt?: string;
    workspace?: string;
    defaultRules?: string;
    codeFirst?: boolean;
    createdAt: number;
    updatedAt: number;
}

export interface GatewayMessage {
    type: string;
    id?: string;
    payload?: unknown;
}

type MessageHandler = (message: GatewayMessage) => void;
type ProgressHandler = (event: ProgressEvent) => void;
type AgentEventHandler = (event: AgentEventV1) => void;
type ConnectionHandler = (status: 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'failed') => void;

export interface GatewayClientOptions {
    role?: 'desktop';
    instanceId?: string;
}

function gatewayError(error: unknown, fallback = 'Gateway request failed'): Error {
    if (error instanceof Error) return error;
    if (typeof error === 'string' && error.trim()) return new Error(error.trim());
    if (error && typeof error === 'object') {
        const record = error as Record<string, unknown>;
        for (const key of ['message', 'error', 'reason']) {
            if (typeof record[key] === 'string' && record[key].trim()) {
                return new Error(record[key].trim());
            }
        }
        try {
            const serialized = JSON.stringify(error);
            if (serialized && serialized !== '{}') return new Error(serialized);
        } catch { /* fall through */ }
    }
    return new Error(fallback);
}

/**
 * Gateway WebSocket client
 * Supports two connection modes:
 *   1. Native WebSocket (ws://127.0.0.1:18801)
 *   2. Tauri IPC bridge (Rust proxies the WebSocket, bypassing WebView2 network restrictions)
 */
export class GatewayClient {
    private ws: WebSocket | null = null;
    private url: string;
    private token?: string;
    private authenticated = false;
    private pendingRequests = new Map<string, {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
    }>();
    private progressHandlers: ProgressHandler[] = [];
    private agentEventHandlers: AgentEventHandler[] = [];
    private messageHandlers: MessageHandler[] = [];
    private connectionHandlers: ConnectionHandler[] = [];
    private reconnectAttempts = 0;
    private maxReconnectAttempts = 10;
    private reconnectDelay = 1000;
    private shouldReconnect = true;
    private connectInFlight: Promise<void> | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly options?: GatewayClientOptions;

    // Tauri IPC bridge mode
    private bridgeMode = false;
    private bridgeUnlisten: (() => void)[] = [];

    constructor(url: string, token?: string, options?: GatewayClientOptions) {
        this.url = url;
        this.token = token;
        this.options = options;
    }

    /**
     * Connect to the Gateway
     * Strategy: try native WebSocket first (3s timeout), then auto-switch to the Tauri IPC bridge on failure
     */
    async connect(): Promise<void> {
        this.shouldReconnect = true;
        if (this.isConnected()) return;
        if (this.connectInFlight) return this.connectInFlight;

        const operation = (async () => {
            // If already in bridge mode, reconnect via the bridge directly.
            if (this.bridgeMode) {
                await this.connectViaBridge();
                return;
            }

            try {
                await this.connectNative();
                // A previous page instance may have fallen back to the Rust
                // bridge and then disappeared during HMR/reload. Once native
                // WebSocket succeeds, retire that stale transport so Gateway
                // events are delivered exactly once.
                void this.disconnectBridgeTransport().catch(error => {
                    console.debug('[GatewayClient] Stale bridge cleanup skipped:', error);
                });
            } catch (nativeErr) {
                console.warn('[GatewayClient] Native WS failed, trying Tauri IPC bridge...', nativeErr);
                this.bridgeMode = true;
                await this.connectViaBridge();
            }
        })();
        this.connectInFlight = operation;

        try {
            await operation;
            if (!this.isConnected()) {
                throw new Error('Gateway disconnected during connection handshake');
            }
            this.reconnectAttempts = 0;
            this.clearReconnectTimer();
        } finally {
            if (this.connectInFlight === operation) this.connectInFlight = null;
        }
    }

    /**
     * Native WebSocket connection (3s timeout)
     */
    private connectNative(): Promise<void> {
        return new Promise((resolve, reject) => {
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const settle = (fn: () => void) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                fn();
            };

            try {
                this.notifyConnectionChange('connecting');

                // Register welcomeHandler before connecting, to eliminate the race where the welcome message arrives before the handler is registered
                const welcomeHandler = (msg: GatewayMessage) => {
                    if (msg.type === 'welcome') {
                        this.removeMessageHandler(welcomeHandler);
                        const payload = msg.payload as { requireAuth?: boolean; setupRequired?: boolean };

                        // Save the first-run flag
                        if (payload.setupRequired) {
                            (this as any)._setupRequired = true;
                        }

                        if (payload.requireAuth && this.token) {
                            this.authenticate()
                                .then(() => this.registerClientIdentity())
                                .then(() => {
                                    this.notifyConnectionChange('connected');
                                    settle(resolve);
                                })
                                .catch((e) => settle(() => reject(e)));
                        } else {
                            this.authenticated = true;
                            this.registerClientIdentity()
                                .then(() => {
                                    this.notifyConnectionChange('connected');
                                    settle(resolve);
                                })
                                .catch((e) => settle(() => reject(e)));
                        }
                    }
                };
                this.addMessageHandler(welcomeHandler);

                this.ws = new WebSocket(this.url);

                this.ws.onopen = () => {
                    console.log('[GatewayClient] Native WS connected');
                    this.reconnectAttempts = 0;
                };

                this.ws.onmessage = (event) => {
                    this.handleMessage(event.data);
                };

                this.ws.onclose = () => {
                    console.log('[GatewayClient] Connection closed');
                    const wasAuthenticated = this.authenticated;
                    this.authenticated = false;
                    this.notifyConnectionChange('disconnected');
                    settle(() => reject(new Error('WebSocket closed before welcome')));
                    if (wasAuthenticated && this.shouldReconnect && !this.bridgeMode) {
                        this.tryReconnect();
                    }
                };

                this.ws.onerror = (error) => {
                    console.error('[GatewayClient] Connection error:', error);
                    this.removeMessageHandler(welcomeHandler);
                    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) this.ws.close();
                    settle(() => reject(new Error('WebSocket connection error')));
                };

                // After a 3s timeout, let the caller try the bridge
                timer = setTimeout(() => {
                    this.removeMessageHandler(welcomeHandler);
                    console.warn('[GatewayClient] Native WS timeout (3s), will try bridge');
                    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) this.ws.close();
                    settle(() => reject(new Error('Native WS timeout')));
                }, 3000);

            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * Tauri IPC bridge connection
     * Use Tauri v2 Channel<T> to receive Gateway messages (the officially recommended streaming API)
     * Fully replaces emit/listen, no event-name format restrictions, more reliable
     */
    private async connectViaBridge(): Promise<void> {
        const { invoke, Channel } = await import('@tauri-apps/api/core');

        this.notifyConnectionChange('connecting');

        // Clean up the old unlisten (no longer needed with Channel, but kept for backward compatibility)
        for (const unlisten of this.bridgeUnlisten) unlisten();
        this.bridgeUnlisten = [];

        return new Promise<void>((resolve, reject) => {
            // Safety-net timer: Rust-side already enforces a 10-second timeout for the
            // welcome frame, but we keep a slightly longer JS-side guard in case the
            // invoke itself hangs (e.g. Rust async runtime stall).
            const timer = setTimeout(() => {
                this.removeMessageHandler(welcomeHandler);
                reject(new Error('Bridge: JS timeout (15s) waiting for connection'));
            }, 15000);

            const welcomeHandler = (msg: GatewayMessage) => {
                if (msg.type === 'welcome') {
                    clearTimeout(timer);
                    this.removeMessageHandler(welcomeHandler);
                    const payload = msg.payload as { requireAuth?: boolean; setupRequired?: boolean };
                    if (payload?.setupRequired) (this as any)._setupRequired = true;

                    if (payload?.requireAuth && this.token) {
                        this.authenticate()
                            .then(() => this.registerClientIdentity())
                            .then(() => {
                                this.notifyConnectionChange('connected');
                                resolve();
                            })
                            .catch(reject);
                    } else {
                        this.authenticated = true;
                        this.registerClientIdentity()
                            .then(() => {
                                this.notifyConnectionChange('connected');
                                resolve();
                            })
                            .catch(reject);
                    }
                }
            };
            this.addMessageHandler(welcomeHandler);

            // Create a Channel<string> for the Rust bridge to push Gateway messages into.
            // NOTE: Rust's gw_bridge_connect now waits for the first Gateway message (welcome)
            // and forwards it via on_event.send() BEFORE returning Ok(()). This means
            // channel.onmessage fires (and welcomeHandler resolves this Promise) *before*
            // the invoke() Promise below resolves — so there is no race condition.
            const channel = new Channel<string>();
            channel.onmessage = (data: string) => {
                console.log('[GatewayClient] Bridge received:', data.slice(0, 100));
                try {
                    if ((JSON.parse(data) as GatewayMessage).type === 'bridge_disconnected') {
                        this.handleBridgeDisconnected();
                        return;
                    }
                } catch {
                    // Let handleMessage report malformed protocol messages.
                }
                this.handleMessage(data);
            };

            // Call the Rust command to establish the WebSocket connection and bind the Channel
            console.log('[GatewayClient] Invoking gw_bridge_connect...');
            invoke('gw_bridge_connect', { onEvent: channel })
                .then(() => {
                    // At this point the welcome has already been forwarded via the channel
                    // and welcomeHandler has already resolved this Promise (or is about to).
                    console.log('[GatewayClient] gw_bridge_connect returned OK');
                })
                .catch((err: unknown) => {
                    // Rust returned Err — e.g. gateway not up yet, timed out waiting for welcome.
                    console.error('[GatewayClient] gw_bridge_connect failed:', err);
                    clearTimeout(timer);
                    this.removeMessageHandler(welcomeHandler);
                    reject(err);
                });
        });
    }

    /**
     * Authenticate
     */
    private async authenticate(): Promise<void> {
        return new Promise((resolve, reject) => {
            const authHandler = (msg: GatewayMessage) => {
                if (msg.type === 'auth.success') {
                    this.removeMessageHandler(authHandler);
                    this.authenticated = true;
                    resolve();
                } else if (msg.type === 'auth.failed') {
                    this.removeMessageHandler(authHandler);
                    reject(new Error('认证失败'));
                }
            };
            this.addMessageHandler(authHandler);
            this.send({ type: 'auth', payload: { token: this.token } });
        });
    }

    private async registerClientIdentity(): Promise<void> {
        const role = this.options?.role;
        const instanceId = this.options?.instanceId;
        if (!role || !instanceId) return;
        await this.request('client.register', { role, instanceId }, 10_000);
    }

    /**
     * Attempt to reconnect
     */
    private tryReconnect(): void {
        if (!this.shouldReconnect || this.isConnected() || this.connectInFlight || this.reconnectTimer) return;

        const nextAttempt = Math.min(this.reconnectAttempts + 1, this.maxReconnectAttempts);
        this.reconnectAttempts = nextAttempt;
        const delay = Math.min(this.reconnectDelay * Math.pow(2, nextAttempt - 1), 30000);
        console.log(`[GatewayClient] Reconnecting in ${delay}ms (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

        // The local Gateway may be restarted or upgraded at any time. Keep the
        // UI in a recovering state even after the backoff reaches its cap.
        this.notifyConnectionChange('reconnecting');

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.shouldReconnect || this.isConnected()) return;
            this.connect().catch(error => {
                console.error('[GatewayClient] Reconnect attempt failed:', error);
                this.tryReconnect();
            });
        }, delay);
    }

    private handleBridgeDisconnected(): void {
        if (!this.bridgeMode) return;
        const wasAuthenticated = this.authenticated;
        this.authenticated = false;
        if (wasAuthenticated) this.notifyConnectionChange('disconnected');
        this.tryReconnect();
    }

    private clearReconnectTimer(): void {
        if (!this.reconnectTimer) return;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
    }

    private async disconnectBridgeTransport(): Promise<void> {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('gw_bridge_disconnect');
    }

    private async ensureConnected(): Promise<void> {
        if (this.isConnected()) return;
        // Explicit user activity should not wait behind a long background
        // backoff. Wake the connection immediately and coalesce with any
        // connection attempt already in flight.
        this.clearReconnectTimer();
        this.reconnectAttempts = 0;
        await this.connect();
        if (!this.isConnected()) throw new Error('Gateway is not connected');
    }

    private async reconnectAfterTransportFailure(): Promise<void> {
        this.authenticated = false;
        this.clearReconnectTimer();
        if (this.bridgeMode) {
            await this.disconnectBridgeTransport().catch(() => undefined);
        } else if (this.ws) {
            try { this.ws.close(); } catch { /* ignore */ }
            this.ws = null;
        }
        await this.connect();
    }

    /**
     * Disconnect
     */
    disconnect(): void {
        this.shouldReconnect = false;
        this.clearReconnectTimer();
        if (this.bridgeMode) {
            void this.disconnectBridgeTransport()
                .catch(error => console.debug('[GatewayClient] Bridge disconnect cleanup failed:', error));
        }
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }

    /**
     * Notify connection status change
     */
    private notifyConnectionChange(status: 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'failed'): void {
        this.connectionHandlers.forEach(handler => handler(status));
    }

    /**
     * Listen for connection status changes
     */
    onConnectionChange(handler: ConnectionHandler): () => void {
        this.connectionHandlers.push(handler);
        return () => {
            const index = this.connectionHandlers.indexOf(handler);
            if (index !== -1) {
                this.connectionHandlers.splice(index, 1);
            }
        };
    }

    /**
     * Whether connected
     */
    isConnected(): boolean {
        if (this.bridgeMode) {
            return this.authenticated;
        }
        return this.ws?.readyState === WebSocket.OPEN && this.authenticated;
    }

    /**
     * Send a message
     */
    private send(message: GatewayMessage): void {
        void this.sendAsync(message).catch(error => {
            console.error('[GatewayClient] Send failed:', error);
        });
    }

    private async sendAsync(message: GatewayMessage): Promise<void> {
        if (this.bridgeMode) {
            const { invoke } = await import('@tauri-apps/api/core');
            await invoke('gw_bridge_send', { message: JSON.stringify(message) });
            return;
        }
        if (this.ws?.readyState !== WebSocket.OPEN) {
            throw new Error('Gateway WebSocket is not open');
        }
        this.ws.send(JSON.stringify(message));
    }

    /**
     * Handle a received message
     */
    private handleMessage(data: string): void {
        try {
            const message: GatewayMessage = JSON.parse(data);
            console.log('[GatewayClient] Message received:', message.type, message.id, message);

            // Notify all message handlers
            this.messageHandlers.forEach(handler => handler(message));

            // Handle progress events
            if (message.type === 'chat.progress') {
                const event = message.payload as ProgressEvent;
                this.progressHandlers.forEach(handler => handler(event));
            }

            // Versioned Agent runtime activity events. Keep them separate from the
            // legacy chat.progress channel so clients can migrate incrementally.
            const agentEventPayload = message.payload;
            if (message.type === 'agent.event' && isAgentEventV1(agentEventPayload)) {
                this.agentEventHandlers.forEach(handler => handler(agentEventPayload));
            }

            // Handle chat completion events
            if (message.type === 'chat.complete') {
                const payload = message.payload as {
                    output?: string;
                    sessionId?: string;
                    turnId?: string;
                    runId?: string;
                    submissionId?: string;
                };
                const completeEvent: ProgressEvent = {
                    type: 'complete',
                    output: payload?.output,
                    sessionId: payload?.sessionId,
                    turnId: payload?.turnId,
                    runId: payload?.runId,
                    submissionId: payload?.submissionId,
                };
                this.progressHandlers.forEach(handler => handler(completeEvent));
            }

            // Handle client-side MCP tool call requests
            if (message.type === 'mcp.client.call' && message.id) {
                this.handleClientMcpCall(message);
                return; // skip the pendingRequests logic
            }

            // Handle responses — only resolve/reject on "final" messages
            // chat.start / chat.progress / config.progress are intermediate messages and should not trigger resolve
            const isIntermediateMessage =
                message.type === 'chat.start'
                || message.type === 'chat.progress'
                || message.type === 'chat.accepted'
                || message.type === 'chat.queue.updated'
                || message.type === 'agent.event'
                || message.type === 'tool.approval.request'
                || message.type === 'tool.approval.closed'
                || message.type === 'config.progress'
                || message.type === 'nexusai.auth-expired';

            if (message.id && this.pendingRequests.has(message.id) && !isIntermediateMessage) {
                console.log('[GatewayClient] Matched pending request (final):', message.id, message.type);
                const { resolve, reject } = this.pendingRequests.get(message.id)!;
                this.pendingRequests.delete(message.id);

                if (message.type.endsWith('.error')) {
                    const payload = message.payload as { message?: string };
                    // 服务端错误话术仅中文：已知固定文案本地翻译，未知的原样透传
                    reject(new Error(payload.message ? tServerCopy(payload.message) : t('server.request_failed')));
                } else {
                    resolve(message.payload);
                }
            }
        } catch (error) {
            console.error('[GatewayClient] Failed to parse message:', error);
        }
    }

    /**
     * Add a message handler
     */
    addMessageHandler(handler: MessageHandler): void {
        this.messageHandlers.push(handler);
    }

    /**
     * Send a fire-and-forget message to the Gateway (no response awaited).
     * Used e.g. by the canvas window to register its role and reply to commands.
     */
    public sendMessage(message: GatewayMessage): void {
        this.send(message);
    }

    /**
     * Remove a message handler
     */
    removeMessageHandler(handler: MessageHandler): void {
        const index = this.messageHandlers.indexOf(handler);
        if (index !== -1) {
            this.messageHandlers.splice(index, 1);
        }
    }

    /**
     * Handle a client-side MCP tool call request sent by the Gateway
     */
    private async handleClientMcpCall(message: GatewayMessage): Promise<void> {
        const { tool, args } = message.payload as { tool: string; args: Record<string, unknown> };
        console.log('[GatewayClient] Client MCP tool invocation received:', tool);

        try {
            const response = await this.request<{ success: boolean; result?: unknown; error?: string }>('mcp.tool.call', { tool, args });
            this.send({
                type: 'mcp.client.result',
                id: message.id,
                payload: response.success
                    ? { success: true, result: response.result }
                    : { success: false, error: response.error },
            });
        } catch (err: any) {
            this.send({
                type: 'mcp.client.result',
                id: message.id,
                payload: { success: false, error: err.message || '客户端工具调用失败' },
            });
        }
    }

    /**
     * Register the client's local MCP tools with the Gateway
     */
    registerClientMcpTools(tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>): void {
        if (!this.isConnected()) {
            console.warn('[GatewayClient] Not connected, cannot register client MCP tools');
            return;
        }
        console.log(`[GatewayClient] Registering client MCP tools: ${tools.length}`);
        this.send({
            type: 'mcp.client.register',
            payload: { tools },
        });
    }

    /**
     * Notify the Gateway to remove the client's MCP tools
     */
    unregisterClientMcpTools(): void {
        if (!this.isConnected()) return;
        console.log('[GatewayClient] Removing client MCP tools');
        this.send({
            type: 'mcp.client.unregister',
        });
    }

    /**
     * Listen for progress events
     */
    onProgress(handler: ProgressHandler): () => void {
        this.progressHandlers.push(handler);
        return () => {
            const index = this.progressHandlers.indexOf(handler);
            if (index !== -1) {
                this.progressHandlers.splice(index, 1);
            }
        };
    }

    /** Listen for versioned Agent runtime activity events. */
    onAgentEvent(handler: AgentEventHandler): () => void {
        this.agentEventHandlers.push(handler);
        return () => {
            const index = this.agentEventHandlers.indexOf(handler);
            if (index !== -1) this.agentEventHandlers.splice(index, 1);
        };
    }

    /**
     * Send a request and wait for the response
     * @param timeout timeout in milliseconds; 0 means no timeout (default 120 seconds)
     */
    public request<T>(type: string, payload?: unknown, timeout: number = 120000): Promise<T> {
        return new Promise((resolve, reject) => {
            const id = crypto.randomUUID();
            this.pendingRequests.set(id, {
                resolve: resolve as (value: unknown) => void,
                reject
            });
            void this.sendAsync({ type, id, payload }).catch(error => {
                if (!this.pendingRequests.has(id)) return;
                this.pendingRequests.delete(id);
                reject(gatewayError(error));
            });

            // Timeout (0 means no limit, suitable for long-running scenarios like chat)
            if (timeout > 0) {
                setTimeout(() => {
                    if (this.pendingRequests.has(id)) {
                        this.pendingRequests.delete(id);
                        reject(new Error('请求超时'));
                    }
                }, timeout);
            }
        });
    }

    /**
     * Send a chat message (supports attachments and cloud Agents)
     * No timeout: multi-step Agent execution can take a long time; progress is pushed in real time via chat.progress
     */
    async chat(
        input: string,
        sessionId?: string,
        attachments?: Array<{ path: string; name: string; size: number; ext: string }>,
        options?: ChatOptions,
    ): Promise<string> {
        const payload: Record<string, unknown> = { input, sessionId };
        if (attachments?.length) {
            payload.attachments = attachments;
        }
        if (options?.source) {
            payload.source = options.source;
        }
        if (options?.chatroomId) {
            payload.chatroomId = options.chatroomId;
        }
        if (options?.agentId) {
            payload.agentId = options.agentId;
        }
        if (options?.approvalMode) {
            payload.approvalMode = options.approvalMode;
        }
        if (options?.delivery) {
            payload.delivery = options.delivery;
        }
        if (options?.targetTurnId) {
            payload.targetTurnId = options.targetTurnId;
        }
        if (options?.targetRunId) {
            payload.targetRunId = options.targetRunId;
        }
        if (options?.submissionId) {
            payload.submissionId = options.submissionId;
        }
        if (options?.fallback) {
            payload.fallback = options.fallback;
        }
        const result = await this.request<{ output?: string }>('chat', payload, 0);
        console.log('[GatewayClient] Chat response:', result);
        return result?.output || '';
    }

    /**
     * Submit a coordinated Turn without retaining a request Promise. Lifecycle
     * is delivered through chat.accepted/chat.start/progress/terminal pushes.
     */
    async submitChat(
        input: string,
        sessionId: string,
        attachments: Array<{ path: string; name: string; size: number; ext: string }> | undefined,
        options: ChatOptions,
    ): Promise<void> {
        const payload: Record<string, unknown> = { input, sessionId };
        if (attachments?.length) payload.attachments = attachments;
        if (options.source) payload.source = options.source;
        if (options.chatroomId) payload.chatroomId = options.chatroomId;
        if (options.agentId) payload.agentId = options.agentId;
        if (options.approvalMode) payload.approvalMode = options.approvalMode;
        if (options.delivery) payload.delivery = options.delivery;
        if (options.targetTurnId) payload.targetTurnId = options.targetTurnId;
        if (options.targetRunId) payload.targetRunId = options.targetRunId;
        if (options.submissionId) payload.submissionId = options.submissionId;
        if (options.fallback) payload.fallback = options.fallback;
        const message = { type: 'chat', id: options.submissionId ?? crypto.randomUUID(), payload };
        await this.ensureConnected();
        try {
            await this.sendAsync(message);
        } catch (error) {
            // Chat submission is idempotent by submissionId. A bridge can die
            // between the connection check and the send, so reconnect once and
            // safely resend the same identity instead of surfacing a false local
            // failure while the first copy may already be durable.
            console.warn('[GatewayClient] Chat transport failed; reconnecting once:', gatewayError(error).message);
            await this.reconnectAfterTransportFailure();
            await this.sendAsync(message).catch(retryError => {
                throw gatewayError(retryError, gatewayError(error).message);
            });
        }
    }

    /**
     * Stop the running task
     */
    async stopTask(
        sessionId: string,
        turnId?: string,
        runId?: string,
        submissionId?: string,
    ): Promise<{ matched?: boolean; queuePaused?: boolean }> {
        console.log('[GatewayClient] Stopping task:', sessionId, turnId, runId, submissionId);
        const payload = { sessionId, turnId, runId, submissionId };
        await this.ensureConnected();
        try {
            return await this.request<{ matched?: boolean; queuePaused?: boolean }>('chat.stop', payload, 10_000);
        } catch (error) {
            console.warn('[GatewayClient] Stop was not acknowledged; reconnecting once:', gatewayError(error).message);
            await this.reconnectAfterTransportFailure();
            return this.request<{ matched?: boolean; queuePaused?: boolean }>('chat.stop', payload, 10_000);
        }
    }

    async getChatRuntime(sessionId: string): Promise<RuntimeSnapshotPayload> {
        return this.request<RuntimeSnapshotPayload>('chat.runtime.get', { sessionId });
    }

    async updateQueueItem(sessionId: string, itemId: string, input: string): Promise<void> {
        await this.request('chat.queue.update', { sessionId, queueItemId: itemId, input });
    }

    async reorderQueue(sessionId: string, itemIds: string[]): Promise<void> {
        await this.request('chat.queue.reorder', { sessionId, orderedIds: itemIds });
    }

    async deleteQueueItem(sessionId: string, itemId: string): Promise<void> {
        await this.request('chat.queue.delete', { sessionId, queueItemId: itemId });
    }

    async sendQueueItemNow(
        sessionId: string,
        itemId: string,
    ): Promise<{ ok: boolean; disposition?: 'steer_pending' | 'started' | 'queued_first' | 'missing' }> {
        return this.request('chat.queue.send-now', { sessionId, queueItemId: itemId });
    }

    async resumeQueue(sessionId: string): Promise<void> {
        await this.request('chat.queue.resume', { sessionId });
    }

    async clearQueue(sessionId: string): Promise<void> {
        await this.request('chat.queue.clear', { sessionId });
    }

    /**
     * Get the session list (optionally filtered to one agent's sessions)
     */
    async getSessions(agentId?: string): Promise<Session[]> {
        console.log('[GatewayClient] getSessions request', agentId ? `(agent: ${agentId})` : '');
        const result = await this.request<{ sessions: Session[] }>('sessions.list', agentId ? { agentId } : undefined);
        console.log('[GatewayClient] getSessions response:', result);
        return result.sessions;
    }

    /**
     * Get session messages (supports pagination)
     * Omit limit → all; pass limit → returns { messages, total, hasMore }
     */
    async getMessages(sessionId: string): Promise<unknown[]>;
    async getMessages(sessionId: string, limit: number, offset?: number): Promise<{ messages: unknown[]; total: number; hasMore: boolean }>;
    async getMessages(sessionId: string, limit?: number, offset?: number): Promise<unknown[] | { messages: unknown[]; total: number; hasMore: boolean }> {
        if (limit !== undefined) {
            const result = await this.request<{ messages: unknown[]; total: number; hasMore: boolean }>(
                'sessions.messages', { sessionId, limit, offset: offset ?? 0 }
            );
            return result;
        }
        const result = await this.request<{ messages: unknown[] }>('sessions.messages', { sessionId });
        return result.messages;
    }

    /**
     * Get session logs
     */
    async getLogs(sessionId: string): Promise<unknown[]> {
        const result = await this.request<{ logs: unknown[] }>('sessions.logs', { sessionId });
        return result.logs;
    }

    /** Load the durable activity stream used to reconstruct Turn/Item cards after restart. */
    async getAgentEvents(sessionId: string, limit: number = 500): Promise<AgentEventV1[]> {
        const result = await this.request<{ events: unknown[] }>('sessions.events', { sessionId, limit });
        return (result.events || []).filter(isAgentEventV1);
    }

    /**
     * Create a session (agentId binds the session to a user Agent for multi-session grouping)
     */
    async createSession(
        title?: string,
        cloudChatroomId?: number,
        cloudAgentName?: string,
        agentId?: string,
        approvalMode?: ApprovalMode,
    ): Promise<Session> {
        const result = await this.request<{ session: Session }>('sessions.create', {
            title,
            cloudChatroomId,
            cloudAgentName,
            agentId,
            approvalMode,
        });
        return result.session;
    }

    async setSessionApprovalMode(sessionId: string, approvalMode: ApprovalMode): Promise<ApprovalMode> {
        const result = await this.request<{ success: boolean; approvalMode: ApprovalMode }>(
            'sessions.approval-mode.update',
            { sessionId, approvalMode },
        );
        return result.approvalMode;
    }

    /**
     * Delete a session
     */
    async deleteSession(sessionId: string): Promise<void> {
        await this.request<{ success: boolean }>('sessions.delete', { sessionId });
    }

    /**
     * Rename a session
     */
    async renameSession(sessionId: string, title: string): Promise<void> {
        await this.request<{ success: boolean }>('sessions.rename', { sessionId, title });
    }

    /**
     * Get session artifacts
     */
    async getArtifacts(sessionId: string): Promise<SessionArtifactView[]> {
        const result = await this.request<{ artifacts: SessionArtifactView[] }>('sessions.artifacts', { sessionId });
        return result.artifacts;
    }

    /**
     * Save session artifacts
     */
    async saveArtifact(sessionId: string, artifact: Omit<SessionArtifactView, 'id'>): Promise<SessionArtifactView> {
        const result = await this.request<{ artifact: SessionArtifactView }>('sessions.artifacts.save', { sessionId, artifact });
        return result.artifact;
    }

    // ========================
    // Agent management API
    // ========================

    /** Get the list of all user Agents */
    async getAgents(): Promise<LocalEntityView[]> {
        const result = await this.request<{ agents: LocalEntityView[] }>('agents.list');
        return result.agents || [];
    }

    /** Create a new Agent */
    async createAgent(config: {
        id: string;
        kind?: 'agent' | 'project';
        name?: string;
        description?: string;
        icon?: string;
        color?: string;
        systemPrompt?: string;
        workspace?: string;
        defaultRules?: string;
    }): Promise<LocalEntityView> {
        const result = await this.request<{ agent: LocalEntityView }>('agents.create', config);
        return result.agent;
    }

    /** Update Agent configuration */
    async updateAgent(agentId: string, updates: Record<string, unknown>): Promise<Record<string, unknown>> {
        const result = await this.request<{ agent: Record<string, unknown> }>('agents.update', { agentId, updates });
        return result.agent;
    }

    /** Delete an Agent */
    async deleteAgent(agentId: string): Promise<boolean> {
        const result = await this.request<{ success: boolean }>('agents.delete', { agentId });
        return result.success;
    }

    /** Switch Agent (returns Agent info + its session list + active session history); sessionId 可指定要激活的会话 */
    async switchAgent(agentId: string, sessionId?: string): Promise<{
        agent: Record<string, unknown>;
        sessions?: Session[];
        messages: unknown[];
        total?: number;
        hasMore?: boolean;
    }> {
        return this.request('agents.switch', { agentId, sessionId });
    }

    /** Clear an Agent's message history */
    async clearAgentHistory(agentId: string): Promise<boolean> {
        const result = await this.request<{ success: boolean }>('agents.history.clear', { agentId });
        return result.success;
    }

    // ========================
    // Scheduler API
    // ========================

    /**
     * Get the scheduled task list
     */
    async getSchedulerTasks(): Promise<ScheduledTaskView[]> {
        const result = await this.request<{ tasks: ScheduledTaskView[] }>('scheduler.list');
        return result.tasks;
    }

    /**
     * Get execution records
     */
    async getSchedulerRuns(taskId?: string, limit?: number): Promise<TaskRunView[]> {
        const result = await this.request<{ runs: TaskRunView[] }>('scheduler.runs', { taskId, limit });
        return result.runs;
    }

    /**
     * Pause a task
     */
    async pauseSchedulerTask(taskId: string): Promise<boolean> {
        const result = await this.request<{ success: boolean }>('scheduler.pause', { taskId });
        return result.success;
    }

    /**
     * Resume a task
     */
    async resumeSchedulerTask(taskId: string): Promise<boolean> {
        const result = await this.request<{ success: boolean }>('scheduler.resume', { taskId });
        return result.success;
    }

    /**
     * Delete a task
     */
    async deleteSchedulerTask(taskId: string): Promise<boolean> {
        const result = await this.request<{ success: boolean }>('scheduler.delete', { taskId });
        return result.success;
    }

    /**
     * Manually trigger a task
     */
    async triggerSchedulerTask(taskId: string): Promise<unknown> {
        const result = await this.request<{ run: unknown }>('scheduler.trigger', { taskId });
        return result.run;
    }

    /**
     * Listen for NexusAI auth-expired events (triggered when the Atlas-mode token expires)
     */
    onAuthExpired(handler: (message: string) => void): () => void {
        const messageHandler = (msg: GatewayMessage) => {
            if (msg.type === 'nexusai.auth-expired') {
                const payload = msg.payload as { message?: string };
                // 服务端话术仅中文：已知文案（已过期/已失效两个变体）映射为界面语言
                handler(payload?.message ? tServerCopy(payload.message) : t('server.auth_expired'));
            }
        };
        this.addMessageHandler(messageHandler);
        return () => this.removeMessageHandler(messageHandler);
    }

    /**
     * Listen for scheduler events
     */
    onSchedulerEvent(handler: (event: SchedulerEventView) => void): () => void {
        const messageHandler = (msg: GatewayMessage) => {
            if (msg.type === 'scheduler.event') {
                handler(msg.payload as SchedulerEventView);
            }
        };
        this.addMessageHandler(messageHandler);
        return () => this.removeMessageHandler(messageHandler);
    }

    /**
     * Listen for session update events (triggered when scheduled-task results are collected into a session)
     */
    onSessionUpdated(handler: (sessionId: string) => void): () => void {
        const messageHandler = (msg: GatewayMessage) => {
            if (msg.type === 'session.updated') {
                const payload = msg.payload as { sessionId: string };
                handler(payload.sessionId);
            }
        };
        this.addMessageHandler(messageHandler);
        return () => this.removeMessageHandler(messageHandler);
    }

    /**
     * Listen for collaboration-complete events (notification of inter-Agent collaboration results)
     */
    onCollaborationResult(handler: (event: {
        sessionId: string;
        parentSessionId?: string;
        agentId: string;
        agentType: string;
        task: string;
        status: string;
        mode: string;
        output?: string;
        error?: string;
        duration?: number;
    }) => void): () => void {
        const messageHandler = (msg: GatewayMessage) => {
            if (msg.type === 'collaboration_result') {
                handler(msg as any);
            }
        };
        this.addMessageHandler(messageHandler);
        return () => this.removeMessageHandler(messageHandler);
    }

    // ========================
    // Memory API
    // ========================

    /**
     * Get memory statistics
     */
    async memoryStats(): Promise<{ enabled: boolean; totalCount?: number; dbSizeBytes?: number; vectorDim?: number; embeddingModel?: string }> {
        return this.request('memory.stats');
    }

    /**
     * List memories with pagination
     */
    async memoryList(page: number = 1, pageSize: number = 20): Promise<{ items: any[]; total: number; page: number; pageSize: number }> {
        return this.request('memory.list', { page, pageSize });
    }

    /**
     * Search memories
     */
    async memorySearch(query: string, limit: number = 10): Promise<{ items: any[] }> {
        return this.request('memory.search', { query, limit });
    }

    /**
     * Delete a single memory
     */
    async memoryDelete(id: string): Promise<boolean> {
        const result = await this.request<{ success: boolean }>('memory.delete', { id });
        return result.success;
    }

    /**
     * Clear all memories
     */
    async memoryClear(): Promise<boolean> {
        const result = await this.request<{ success: boolean }>('memory.clear');
        return result.success;
    }

    // ========================
    // Distillation API
    // ========================

    /**
     * Get distillation statistics
     */
    async distillationStats(): Promise<any> {
        return this.request('distillation.stats');
    }

    /**
     * Get card relationship graph data
     */
    async distillationGraph(): Promise<{ cards: any[]; relations: any[]; topics: any[] }> {
        return this.request('distillation.graph');
    }

    /**
     * Update distillation configuration
     */
    async distillationUpdateConfig(config: Record<string, any>): Promise<{ success: boolean; message?: string }> {
        return this.request('distillation.config.update', config);
    }

    /**
     * Manually trigger distillation
     */
    async distillationTrigger(): Promise<{ success: boolean; message?: string }> {
        return this.request('distillation.trigger');
    }

    /**
     * Get the card list (supports hierarchical filtering and pagination)
     */
    async distillationCards(layer?: string, limit = 100, offset = 0): Promise<{ cards: any[]; total: number }> {
        return this.request('distillation.cards', { layer, limit, offset });
    }

    /**
     * Delete a specific card
     */
    async distillationDeleteCard(cardId: string): Promise<{ success: boolean; message?: string }> {
        return this.request('distillation.card.delete', { cardId });
    }

    // ========================
    // Settings API
    // ========================

    /**
     * Get current settings
     */
    async getSettings(): Promise<{ outputPath: string; defaultOutputPath: string }> {
        return this.request('settings.get');
    }

    /**
     * Update settings (pass null to reset to defaults)
     */
    async updateSettings(settings: { outputPath?: string | null }): Promise<{ outputPath: string }> {
        return this.request('settings.update', settings);
    }

    // ========================
    // Server Config API
    // ========================

    /**
     * Get server configuration
     */
    async getServerConfig(): Promise<ServerConfigView> {
        return this.request('config.get');
    }

    /**
     * Update server configuration
     */
    /**
     * Whether first-time setup is required
     */
    isSetupRequired(): boolean {
        return !!(this as any)._setupRequired;
    }

    /**
     * Submit first-launch settings
     */
    async setupComplete(config: {
        provider: string;
        apiKey: string;
        baseUrl?: string;
        model?: string;
        agentName?: string;
        agentPrompt?: string;
        router?: {
            enabled: boolean;
            url?: string;
            appId?: string;
            appSecret?: string;
        };
    }): Promise<{ success: boolean; message?: string }> {
        const result = await this.request<{ message?: string }>('setup.complete', config);
        (this as any)._setupRequired = false;
        return { success: true, message: result?.message };
    }

    async updateServerConfig(updates: ServerConfigUpdate): Promise<{ success: boolean; message?: string }> {
        return this.request('config.update', updates);
    }

    // ========================
    // Browser API
    // ========================

    /** Launch the debug-mode browser */
    async launchBrowser(): Promise<{ success: boolean; message: string }> {
        return this.request('browser.launch');
    }

    // ========================
    // Debug API
    // ========================

    /**
     * Subscribe to debug logs
     */
    subscribeDebugLog(): void {
        this.send({ type: 'debug.subscribe' });
    }

    /**
     * Unsubscribe from debug logs
     */
    unsubscribeDebugLog(): void {
        this.send({ type: 'debug.unsubscribe' });
    }

    /**
     * Listen for debug log events
     */
    onDebugLog(handler: (entry: DebugLogEntry) => void): () => void {
        const messageHandler = (msg: GatewayMessage) => {
            if (msg.type === 'debug.log') {
                handler(msg.payload as DebugLogEntry);
            }
        };
        this.addMessageHandler(messageHandler);
        return () => this.removeMessageHandler(messageHandler);
    }

    /**
     * Listen for memory index rebuild progress
     */
    onRebuildProgress(handler: (progress: number) => void): () => void {
        const messageHandler = (msg: GatewayMessage) => {
            if (msg.type === 'config.rebuildProgress') {
                const payload = msg.payload as { progress: number };
                handler(payload.progress);
            }
        };
        this.addMessageHandler(messageHandler);
        return () => this.removeMessageHandler(messageHandler);
    }
    // ========================
    // Evolution API (self-evolution)
    // ========================

    /**
     * Listen for tool-creation confirm requests
     * Pushed by the Gateway when an Agent creates a new tool; the frontend shows a confirm dialog
     */
    onEvolutionConfirm(handler: (request: EvolutionConfirmRequest) => void): () => void {
        const messageHandler = (msg: GatewayMessage) => {
            if (msg.type === 'evolution.confirm') {
                handler(msg.payload as EvolutionConfirmRequest);
            }
        };
        this.addMessageHandler(messageHandler);
        return () => this.removeMessageHandler(messageHandler);
    }

    /**
     * Respond to a tool confirm request
     */
    respondEvolutionConfirm(requestId: string, approved: boolean): void {
        this.send({
            type: 'evolution.confirm.response',
            payload: { requestId, approved },
        });
    }

    /**
     * Get evolution data statistics
     */
    async getEvolutionStats(): Promise<{
        schemaVersion: number;
        stats: { installedSkills: number; customTools: number; forgedSkills: number; spawnedAgents: number; mcpConnections: number };
    }> {
        return this.request('evolution.stats');
    }

    /**
     * Get the installed skills list
     */
    async getInstalledSkills(): Promise<{ skills: Array<{ slug: string; source: string; installedAt: string }> }> {
        return this.request('evolution.skills.list');
    }

    /**
     * Uninstall a skill
     */
    async uninstallSkill(slug: string): Promise<{ success: boolean }> {
        return this.request('evolution.skills.uninstall', { slug });
    }

    /**
     * Get the custom tools list
     */
    async getCustomTools(): Promise<{ tools: Array<{ name: string; description: string; scriptType: string; confirmed: boolean; validatorResult: string; createdAt: string }> }> {
        return this.request('evolution.tools.list');
    }

    /**
     * Delete a custom tool
     */
    async deleteCustomTool(name: string): Promise<{ success: boolean }> {
        return this.request('evolution.tools.delete', { name });
    }

    /**
     * Accept a forge suggestion
     */
    async acceptForgeSuggestion(suggestion: { id: string; title: string; content: string; category: string; reasoning: string }): Promise<{ success: boolean }> {
        return this.request('evolution.forge.accept', suggestion);
    }

    /**
     * Dismiss a forge suggestion
     */
    async dismissForgeSuggestion(): Promise<{ success: boolean }> {
        return this.request('evolution.forge.dismiss');
    }

    /**
     * Get the forged skills list
     */
    async getForgedSkills(): Promise<{ skills: Array<{ id: string; title: string; category: string; reasoning: string; createdAt: string; updatedAt?: string; upgradeCount?: number; enabled: boolean }> }> {
        return this.request('evolution.forged.list');
    }

    /**
     * Toggle a forged skill
     */
    async toggleForgedSkill(id: string, enabled: boolean): Promise<{ success: boolean; enabled: boolean }> {
        return this.request('evolution.forged.toggle', { id, enabled });
    }

    /**
     * Delete a forged skill
     */
    async deleteForgedSkill(id: string): Promise<{ success: boolean }> {
        return this.request('evolution.forged.delete', { id });
    }

    /**
     * Listen for forge suggestion events
     */
    onForgeSuggestion(callback: (suggestion: { id: string; title: string; content: string; category: string; reasoning: string }) => void): void {
        this.addMessageHandler((msg: GatewayMessage) => {
            if (msg.type === 'evolution.forge.suggest' && msg.payload) {
                callback(msg.payload as any);
            }
        });
    }

    /**
     * Listen for the silent skill-forge-complete event (notified after auto-save, no Toast)
     */
    onForgeSaved(callback: (info: { title: string; category: string }) => void): void {
        this.addMessageHandler((msg: GatewayMessage) => {
            if (msg.type === 'evolution.forge.saved' && msg.payload) {
                callback(msg.payload as { title: string; category: string });
            }
        });
    }

    /**
     * Listen for skill list change events (auto-broadcast on install/uninstall)
     */
    onSkillsUpdated(callback: () => void): void {
        this.addMessageHandler((msg: GatewayMessage) => {
            if (msg.type === 'evolution.skills.updated') {
                callback();
            }
        });
    }

    // ========================
    // OpenFlux cloud API
    // ========================

    /** Log in to OpenFlux cloud */
    async openfluxLogin(username: string, password: string): Promise<{ success: boolean; message?: string }> {
        return this.request<{ success: boolean; message?: string }>('openflux.login', { username, password });
    }

    /** Log out of OpenFlux cloud */
    async openfluxLogout(): Promise<void> {
        await this.request('openflux.logout');
    }

    /** Get OpenFlux login status */
    async openfluxStatus(): Promise<{ loggedIn: boolean; username?: string }> {
        return this.request<{ loggedIn: boolean; username?: string }>('openflux.status');
    }

    /** Get the cloud Agent list */
    async openfluxAgents(): Promise<OpenFluxAgentInfo[]> {
        const result = await this.request<{ agents: OpenFluxAgentInfo[] }>('openflux.agents');
        return result.agents || [];
    }

    /** Get a single Agent's info */
    async openfluxAgentInfo(appId: number): Promise<OpenFluxAgentInfo | null> {
        const result = await this.request<{ agent: OpenFluxAgentInfo | null }>('openflux.agent-info', { appId });
        return result.agent;
    }

    /** Get cloud chat history */
    async openfluxChatHistory(chatroomId: number, page?: number, pageSize?: number): Promise<OpenFluxChatMessage[]> {
        const result = await this.request<{ messages: OpenFluxChatMessage[] }>('openflux.chat-history', { chatroomId, page, pageSize });
        return result.messages || [];
    }

    // ========================
    // OpenFluxRouter API
    // ========================

    /** Get Router configuration and connection status */
    async routerConfigGet(): Promise<RouterStatusView> {
        return this.request('router.config.get');
    }

    /** Update Router configuration */
    async routerConfigUpdate(config: Partial<RouterConfigView & { apiKey: string }>): Promise<{ success: boolean; message?: string }> {
        return this.request('router.config.update', config);
    }

    /** Send a message to the Router (outbound) */
    async routerSend(msg: RouterOutboundView): Promise<{ success: boolean; message?: string }> {
        return this.request('router.send', msg);
    }

    /** Test the Router connection */
    async routerTest(config: Partial<RouterConfigView & { apiKey: string }>): Promise<{ success: boolean; message: string; latencyMs?: number }> {
        return this.request('router.test', config);
    }

    /** Listen for Router inbound messages (user messages) */
    onRouterMessage(handler: (msg: RouterInboundView & { sessionId?: string; label?: string }) => void): () => void {
        const messageHandler = (msg: GatewayMessage) => {
            if (msg.type === 'router.user_message') {
                handler(msg.payload as RouterInboundView & { sessionId?: string; label?: string });
            }
        };
        this.addMessageHandler(messageHandler);
        return () => this.removeMessageHandler(messageHandler);
    }

    /** Listen for Router connection status changes */
    onRouterStatus(handler: (status: RouterStatusView & { status: string }) => void): () => void {
        const messageHandler = (msg: GatewayMessage) => {
            if (msg.type === 'router.status') {
                handler(msg.payload as RouterStatusView & { status: string });
            }
        };
        this.addMessageHandler(messageHandler);
        return () => this.removeMessageHandler(messageHandler);
    }

    /** Send a Router bind command */
    async routerBind(code: string): Promise<{ success: boolean; message: string }> {
        return this.request('router.bind', { code });
    }

    /** Request generating an App QR bind code */
    async routerQRBind(): Promise<{ success: boolean; message: string }> {
        return this.request('router.qr-bind');
    }

    async routerExternalPlatforms(): Promise<{ platforms: RouterExternalPlatformView[] }> {
        const result = await this.request<{ platforms: RouterExternalPlatformView[]; error?: string }>('router.external-platforms');
        if (result.error) throw new Error(result.error);
        return { platforms: result.platforms || [] };
    }

    async routerExternalPlatformBindCode(platformId: string): Promise<{ code: string; expires_in: number }> {
        const result = await this.request<{ success: boolean; code?: string; expires_in?: number; message?: string }>(
            'router.external-platform-bind-code', { platformId },
        );
        if (!result.success || !result.code) throw new Error(result.message || '生成绑定码失败');
        return { code: result.code, expires_in: result.expires_in || 300 };
    }

    async routerExternalPlatformUnbind(mappingId: string): Promise<void> {
        const result = await this.request<{ success: boolean; message?: string }>(
            'router.external-platform-unbind', { mappingId },
        );
        if (!result.success) throw new Error(result.message || '解除连接失败');
    }

    async routerGroupProjectOptions(): Promise<RouterGroupProjectOptionsView> {
        const result = await this.request<RouterGroupProjectOptionsView & { success: boolean; message?: string }>(
            'router.group-project-options',
        );
        if (!result.success) throw new Error(result.message || '读取群聊列表失败');
        return result;
    }

    async routerGroupCollaborations(): Promise<RouterGroupCollaborationListView> {
        const result = await this.request<RouterGroupCollaborationListView & { success: boolean; message?: string }>(
            'router.group-collaborations',
        );
        if (!result.success) throw new Error(result.message || '读取群协作失败');
        return result;
    }

    async routerGroupCollaborationActivate(input: {
        requestId: string;
        projectId: string;
        projectName: string;
        displayName: string;
        roleName: string;
        managerDispatchEnabled: boolean;
    }): Promise<{ collaboration: RouterGroupCollaborationView; sessionId?: string }> {
        const result = await this.request<{
            success: boolean;
            message?: string;
            collaboration?: RouterGroupCollaborationView;
            sessionId?: string;
        }>(
            'router.group-collaboration-activate', input,
        );
        if (!result.success) throw new Error(result.message || '加入群协作失败');
        if (!result.collaboration) throw new Error('加入成功，但 Router 没有返回群协作信息');
        return { collaboration: result.collaboration, sessionId: result.sessionId };
    }

    async routerGroupCollaborationMemberUpdate(
        collaborationId: string,
        status: 'active' | 'paused' | 'left',
        profile?: {
            displayName?: string;
            roleName?: string;
            managerDispatchEnabled?: boolean;
        },
    ): Promise<void> {
        const result = await this.request<{ success: boolean; message?: string }>(
            'router.group-collaboration-member-update', { collaborationId, status, ...profile },
        );
        if (!result.success) throw new Error(result.message || '更新群协作状态失败');
    }

    async routerGroupAgentMessageAccept(messageId: string): Promise<{ duplicate: boolean }> {
        const result = await this.request<{ success: boolean; duplicate?: boolean; message?: string }>(
            'router.group-agent-message-accept', { messageId },
        );
        if (!result.success) throw new Error(result.message || '接受接口变更失败');
        return { duplicate: Boolean(result.duplicate) };
    }

    async routerGroupProjectBind(input: {
        platformId: string;
        workspaceId: string;
        channelId: string;
        channelName?: string;
        projectId: string;
        projectName: string;
    }): Promise<RouterGroupProjectMappingView> {
        const result = await this.request<{ success: boolean; mapping?: RouterGroupProjectMappingView; message?: string }>(
            'router.group-project-bind', input,
        );
        if (!result.success || !result.mapping) throw new Error(result.message || '关联群聊失败');
        return result.mapping;
    }

    async routerGroupProjectUpdate(mappingId: string, status: 'active' | 'paused'): Promise<void> {
        const result = await this.request<{ success: boolean; message?: string }>(
            'router.group-project-update', { mappingId, status },
        );
        if (!result.success) throw new Error(result.message || '更新群聊关联失败');
    }

    async routerGroupProjectRemove(mappingId: string): Promise<void> {
        const result = await this.request<{ success: boolean; message?: string }>(
            'router.group-project-remove', { mappingId },
        );
        if (!result.success) throw new Error(result.message || '解除群聊关联失败');
    }

    async routerGroupBotAuthorize(mappingId: string, botIdentityId: string, capabilities: string[]): Promise<void> {
        const result = await this.request<{ success: boolean; message?: string }>(
            'router.group-bot-authorize', { mappingId, botIdentityId, capabilities },
        );
        if (!result.success) throw new Error(result.message || '允许机器人协作失败');
    }

    async routerGroupBotRevoke(mappingId: string, botIdentityId: string): Promise<void> {
        const result = await this.request<{ success: boolean; message?: string }>(
            'router.group-bot-revoke', { mappingId, botIdentityId },
        );
        if (!result.success) throw new Error(result.message || '取消机器人协作失败');
    }

    /** Listen for QR bind code responses (Gateway pushes QR data) */
    onRouterQRBindCode(handler: (data: { status: string; qr_data?: string; code?: string; api_base?: string; expires_in?: number; message?: string }) => void): () => void {
        const messageHandler = (msg: GatewayMessage) => {
            if (msg.type === 'router.qr_bind_code') {
                handler(msg.payload as any);
            }
        };
        this.addMessageHandler(messageHandler);
        return () => this.removeMessageHandler(messageHandler);
    }

    /** Listen for QR bind success (App finished scanning) */
    onRouterQRBindSuccess(handler: (data: { app_user_id?: string; platform_user_id?: string }) => void): () => void {
        const messageHandler = (msg: GatewayMessage) => {
            if (msg.type === 'router.qr_bind_success') {
                handler(msg.payload as any);
            }
        };
        this.addMessageHandler(messageHandler);
        return () => this.removeMessageHandler(messageHandler);
    }

    /** Listen for Router bind results */
    onRouterBindResult(handler: (result: { action: string; status: string; message?: string }) => void): () => void {
        const messageHandler = (msg: GatewayMessage) => {
            if (msg.type === 'router.bind_result') {
                handler(msg.payload as { action: string; status: string; message?: string });
            }
        };
        this.addMessageHandler(messageHandler);
        return () => this.removeMessageHandler(messageHandler);
    }

    // ========================
    // WeChat iLink API
    // ========================

    /** Get WeChat iLink configuration and status */
    async weixinConfigGet(): Promise<any> {
        return this.request('weixin.config.get');
    }

    /** Update WeChat iLink configuration */
    async weixinConfigUpdate(config: Record<string, any>): Promise<{ success: boolean; message?: string }> {
        return this.request('weixin.config.update', config);
    }

    /** Get WeChat connection status */
    async weixinStatus(): Promise<{ connected: boolean; enabled: boolean; accountId: string }> {
        return this.request('weixin.status');
    }

    /** Start WeChat QR-code login */
    async weixinQRLogin(): Promise<{ success: boolean; message?: string }> {
        return this.request('weixin.qr-login');
    }

    /** Disconnect WeChat */
    async weixinDisconnect(): Promise<{ success: boolean }> {
        return this.request('weixin.disconnect');
    }

    /** Test the WeChat connection */
    async weixinTest(): Promise<{ configured: boolean; enabled: boolean; connected: boolean }> {
        return this.request('weixin.test');
    }

    /** Listen for WeChat connection status changes */
    onWeixinStatus(handler: (status: { connected: boolean; status: string }) => void): () => void {
        const messageHandler = (msg: GatewayMessage) => {
            if (msg.type === 'weixin.status') {
                handler(msg.payload as { connected: boolean; status: string });
            }
        };
        this.addMessageHandler(messageHandler);
        return () => this.removeMessageHandler(messageHandler);
    }

    /** Listen for WeChat QR code pushes */
    onWeixinQRCode(handler: (data: { qrUrl: string; qrImgContent?: string; expire: number }) => void): () => void {
        const messageHandler = (msg: GatewayMessage) => {
            if (msg.type === 'weixin.qr_code') {
                handler(msg.payload as any);
            }
        };
        this.addMessageHandler(messageHandler);
        return () => this.removeMessageHandler(messageHandler);
    }

    /** Listen for WeChat QR scan status */
    onWeixinQRStatus(handler: (data: { status: string; message: string }) => void): () => void {
        const messageHandler = (msg: GatewayMessage) => {
            if (msg.type === 'weixin.qr_status') {
                handler(msg.payload as any);
            }
        };
        this.addMessageHandler(messageHandler);
        return () => this.removeMessageHandler(messageHandler);
    }

    /** Listen for WeChat login success */
    onWeixinLoginSuccess(handler: (data: { accountId: string; token: string; baseUrl: string }) => void): () => void {
        const messageHandler = (msg: GatewayMessage) => {
            if (msg.type === 'weixin.login_success') {
                handler(msg.payload as any);
            }
        };
        this.addMessageHandler(messageHandler);
        return () => this.removeMessageHandler(messageHandler);
    }

    /** Listen for WeChat inbound user messages */
    onWeixinMessage(handler: (msg: any) => void): () => void {
        const messageHandler = (msg: GatewayMessage) => {
            if (msg.type === 'weixin.user_message') {
                handler(msg.payload);
            }
        };
        this.addMessageHandler(messageHandler);
        return () => this.removeMessageHandler(messageHandler);
    }

    // ========================
    // Managed LLM config API
    // ========================


    /** Set the LLM config source */
    async setLlmSource(source: 'local' | 'managed' | 'atlas_managed'): Promise<{ source: string; error?: string }> {
        return this.request('config.set-llm-source', { source });
    }

    /** Get the LLM config source */
    async getLlmSource(): Promise<{
        source: 'local' | 'managed' | 'atlas_managed';
        managed?: {
            available: boolean;
            provider?: string;
            model?: string;
            quota?: { daily_limit: number; used_today: number };
        };
    }> {
        return this.request('config.get-llm-source');
    }

    /** Listen for Router managed-LLM config pushes */
    onManagedLlmConfig(handler: (config: {
        available: boolean;
        provider?: string;
        model?: string;
        quota?: { daily_limit: number; used_today: number };
        currentSource?: 'local' | 'managed';
    }) => void): () => void {
        const messageHandler = (msg: GatewayMessage) => {
            if (msg.type === 'managed-llm-config') {
                handler(msg.payload as any);
            }
        };
        this.addMessageHandler(messageHandler);
        return () => this.removeMessageHandler(messageHandler);
    }

    // ========================
    // Coding Agent API
    // ========================

    /**
     * List the status of all CLI Coding Agent drivers
     * Implemented via tool_call coding_agent{action:"list_drivers"}
     */
    async listCodingAgentDrivers(): Promise<CodingAgentDriverInfo[]> {
        const result = await this.request<{
            success: boolean;
            data: { drivers: CodingAgentDriverInfo[] };
        }>('tool.call', {
            tool: 'coding_agent',
            args: { driver: 'agy', action: 'list_drivers' },  // the driver field has no effect on list_drivers; the gateway ignores it
        });
        return result?.data?.drivers ?? [];
    }

    /**
     * Reset the session context of a Coding Agent
     */
    async resetCodingAgentSession(driver: string, nexusaiSession = 'default'): Promise<void> {
        await this.request('tool.call', {
            tool: 'coding_agent',
            args: { driver, action: 'reset', nexusai_session: nexusaiSession },
        });
    }
}


// ========================
// Scheduler view types
// ========================

export interface ScheduledTaskView {
    id: string;
    name: string;
    trigger: {
        type: 'cron' | 'interval' | 'once';
        expression?: string;
        intervalMs?: number;
        runAt?: string | number;
    };
    target: {
        type: 'agent' | 'workflow';
        prompt?: string;
        workflowId?: string;
    };
    status: 'active' | 'paused' | 'completed' | 'error';
    createdAt: number;
    lastRunAt?: number;
    nextRunAt?: number;
    runCount: number;
    failCount: number;
    sessionId?: string;
}

export interface TaskRunView {
    id: string;
    taskId: string;
    taskName: string;
    status: 'running' | 'completed' | 'failed';
    startedAt: number;
    completedAt?: number;
    duration?: number;
    output?: string;
    error?: string;
    sessionId?: string;
}

export interface SchedulerEventView {
    type: string;
    taskId: string;
    taskName?: string;
    runId?: string;
    sessionId?: string;
    error?: string;
    timestamp: number;
}

// ========================
// Artifact view types
// ========================

export interface SessionArtifactView {
    id: string;
    type: 'file' | 'code' | 'output';
    path?: string;
    filename?: string;
    content?: string;
    language?: string;
    size?: number;
    timestamp: number;
}

// ========================
// Server config types
// ========================

/** MCP Server view info */
export interface McpServerView {
    name: string;
    /** Execution location: server (Gateway side) or client (the client's machine) */
    location?: 'server' | 'client';
    transport: 'stdio' | 'sse';
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
    enabled?: boolean;
    /** Number of registered tools (read-only, returned by the Gateway) */
    toolCount?: number;
    /** Connection status (read-only) */
    status?: 'connected' | 'disconnected' | 'error';
}

export interface ServerConfigView {
    /** Provider config (name → API Key / BaseUrl) */
    providers: Record<string, { apiKey?: string; baseUrl?: string }>;
    /** LLM model config */
    llm: {
        orchestration: { provider: string; model: string };
        execution: { provider: string; model: string };
        embedding?: { provider: string; model: string };
        fallback?: { provider: string; model: string };
    };
    /** Web search and fetch config */
    web?: {
        search?: { provider?: string; apiKey?: string; maxResults?: number };
        fetch?: { readability?: boolean; maxChars?: number };
    };
    /** MCP external tools config */
    mcp?: {
        servers?: McpServerView[];
    };
    /** Gateway work mode */
    gatewayMode: 'embedded' | 'remote';
    /** Gateway port */
    gatewayPort: number;
    /** Agent config */
    agents?: {
        globalAgentName?: string;
        globalSystemPrompt?: string;
        skills?: Array<{ id: string; title: string; content: string; enabled: boolean }>;
        list?: Array<{ id: string; name: string; description: string; model?: { provider: string; model: string } }>;
    };
    /** Sandbox isolation config */
    sandbox?: {
        mode?: string;
        docker?: {
            image?: string;
            memoryLimit?: string;
            cpuLimit?: string;
            networkMode?: string;
        };
        blockedExtensions?: string[];
    };
    /** Preset model list (provider → array of models) */
    presetModels?: Record<string, { value: string; label: string; multimodal?: boolean }[]>;
}

export interface ServerConfigUpdate {
    /** Update provider keys */
    providers?: Record<string, { apiKey?: string; baseUrl?: string }>;
    /** Update the orchestration model */
    orchestration?: { provider?: string; model?: string };
    /** Update the execution model */
    execution?: { provider?: string; model?: string };
    /** Update the embedding model */
    embedding?: { provider?: string; model?: string };
    /** Update web search and fetch config */
    web?: {
        search?: { provider?: string; apiKey?: string; maxResults?: number };
        fetch?: { readability?: boolean; maxChars?: number };
    };
    /** Update MCP Server config */
    mcp?: {
        servers?: Array<{
            name: string;
            location?: 'server' | 'client';
            transport: 'stdio' | 'sse';
            command?: string;
            args?: string[];
            url?: string;
            env?: Record<string, string>;
            enabled?: boolean;
        }>;
    };
    /** Update the global role/persona */
    agents?: {
        globalAgentName?: string;
        globalSystemPrompt?: string;
        skills?: Array<{ id: string; title: string; content: string; enabled: boolean }>;
        list?: Array<{ id: string; model?: { provider: string; model: string } | null }>;
    };
    /** Update sandbox isolation config */
    sandbox?: {
        mode?: string;
        docker?: {
            image?: string;
            memoryLimit?: string;
            cpuLimit?: string;
            networkMode?: string;
        };
        blockedExtensions?: string[];
    };
}

// ========================
// Debug log types
// ========================

export interface DebugLogEntry {
    timestamp: string;
    level: 'info' | 'warn' | 'error' | 'debug';
    module: string;
    message: string;
    meta?: Record<string, unknown>;
}

// ========================
// OpenFlux cloud types
// ========================

export interface OpenFluxAgentInfo {
    agentId: number;
    appId: number;
    name: string;
    description?: string;
    chatroomId: number;
    avatar?: string;
}

export interface OpenFluxChatMessage {
    role: 'user' | 'assistant';
    content: string;
    createdAt: number;
    agentName?: string;
}

// ========================
// OpenFluxRouter types
// ========================

export interface RouterConfigView {
    url: string;
    appId: string;
    appType: string;
    apiKey: string;  // masked
    appUserId: string;
    enabled: boolean;
}

export type RouterCompatibilityStateView = 'negotiating' | 'compatible' | 'legacy_router' | 'upgrade_required';

export interface RouterStatusView {
    connected: boolean;
    bound: boolean;
    compatibility: RouterCompatibilityStateView;
    routerProtocol: {
        server_version: string;
        protocol_version: string;
        capabilities: string[];
        compatibility_state: 'compatible' | 'legacy_previous' | 'upgrade_required';
    } | null;
    config: RouterConfigView | null;
}

export interface RouterInboundView {
    id: string;
    platform_type: string;
    platform_id: string;
    platform_user_id: string;
    app_type: string;
    app_id: string;
    app_user_id?: string;
    direction: 'inbound';
    content_type: string;
    content: string;
    metadata?: Record<string, unknown>;
    timestamp: number;
}

export interface RouterOutboundView {
    platform_type: string;
    platform_id: string;
    platform_user_id: string;
    content_type: string;
    content: string;
}

export interface RouterExternalPlatformView {
    platform_id: string;
    type: 'feishu' | 'dingtalk' | 'wecom' | 'slack';
    name: string;
    available: boolean;
    bound: boolean;
    binding?: {
        mapping_id: string;
        account_label: string;
        bound_at: string;
    } | null;
}

export interface RouterGroupProjectMappingView {
    id: string;
    platform_id: string;
    platform_type?: 'feishu' | 'slack';
    workspace_id: string;
    channel_id: string;
    channel_name?: string;
    project_id: string;
    project_name: string;
    status: 'active' | 'paused';
    sync_enabled: boolean;
    last_event_at?: string;
}

export interface RouterGroupCollaborationMemberView {
    id: string;
    platform_member_id: string;
    flux_user_id: string;
    app_user_id: string;
    project_id: string;
    project_name: string;
    display_name: string;
    role_name: string;
    manager_dispatch_enabled: boolean;
    member_kind: 'owner' | 'member';
    status: 'active' | 'paused' | 'left';
    online?: boolean;
    natural_language_supported?: boolean;
}

export interface RouterGroupCollaborationView {
    id: string;
    platform_id: string;
    workspace_id: string;
    channel_id: string;
    channel_name: string;
    status: string;
    planning_state: string;
    quiet_until?: string | null;
    current_member_id?: string | null;
    members: RouterGroupCollaborationMemberView[];
}

export interface RouterGroupMemberTaskView {
    id: string;
    batch_id: string;
    batch_version: number;
    collaboration_id: string;
    member_project_id: string;
    project_id: string;
    project_name: string;
    role_name: string;
    external_key: string;
    title: string;
    detail: string;
    dependencies: string[];
    acceptance: string[];
    status: string;
    objective: string;
    shared_contract: unknown[];
    decision_note?: string;
}

export interface RouterGroupCollaborationListView {
    requests: Array<{
        id: string;
        action: 'enable' | 'join';
        platform_id: string;
        workspace_id: string;
        channel_id: string;
        channel_name: string;
        expires_at: string;
    }>;
    collaborations: RouterGroupCollaborationView[];
    tasks: RouterGroupMemberTaskView[];
    team_tasks: Array<{
        id: string;
        batch_id: string;
        collaboration_id: string;
        member_project_id: string;
        external_key: string;
        title: string;
        dependencies: string[];
        status: string;
        role_name: string;
        project_name: string;
    }>;
    agent_messages: Array<{
        id: string;
        collaboration_id: string;
        batch_id: string;
        source_task_id: string;
        target_task_id: string;
        kind: 'contract' | 'question' | 'answer' | 'dependency_ready' | 'blocker' | 'status' | 'result';
        depth: number;
        content: string;
        status: string;
        created_at: string;
    }>;
    runtime?: { projects: Array<{ id: string; name: string; workspace?: string }> };
}

export interface RouterGroupProjectOptionsView {
    platforms: Array<{
        platform_id: string;
        type: 'feishu' | 'slack';
        name: string;
        personal_bound: boolean;
    }>;
    channels: Array<{
        platform_id: string;
        workspace_id: string;
        channel_id: string;
        channel_name: string;
        last_event_at: string;
    }>;
    mappings: RouterGroupProjectMappingView[];
    bots: Array<{
        mapping_id: string;
        bot_identity_id: string;
        platform_bot_id: string;
        target_platform_user_id: string;
        display_name: string;
        authorized: boolean;
        capabilities: string[];
        last_seen_at: string;
    }>;
    runtime?: { online: boolean; projects: Array<{ id: string; name: string; workspace?: string }> };
}

// ========================
// Evolution API (self-evolution)
// ========================

/** Coding Agent driver info */
export interface CodingAgentDriverInfo {
    id: string;
    displayName: string;
    installed: boolean;
    authenticated: boolean;
    supportsResume: boolean;
}

/** Evolution confirm request */

export interface EvolutionConfirmRequest {
    requestId: string;
    toolName: string;
    description: string;
    confirmMessage: string;
    validationStatus: 'PASS' | 'WARN' | 'BLOCK';
}


// Global client instance
let gatewayClient: GatewayClient | null = null;

/**
 * Get or create the Gateway client
 */
export function getGatewayClient(): GatewayClient | null {
    return gatewayClient;
}

/**
 * Initialize the Gateway client
 */
export async function initGatewayClient(url: string, token?: string): Promise<GatewayClient> {
    if (gatewayClient) {
        gatewayClient.disconnect();
    }
    gatewayClient = new GatewayClient(url, token);
    await gatewayClient.connect();
    return gatewayClient;
}
