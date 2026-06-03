/**
 * WebSocket client wrapper
 * Used by the renderer process to connect to the Gateway Server
 */

export interface ProgressEvent {
    type: 'iteration' | 'thinking' | 'tool_start' | 'tool_result' | 'token' | 'complete';
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
}

export interface Session {
    id: string;
    agentId: string;
    title?: string;
    createdAt: number;
    updatedAt: number;
    cloudChatroomId?: number;
    cloudAgentName?: string;
}

export interface GatewayMessage {
    type: string;
    id?: string;
    payload?: unknown;
}

type MessageHandler = (message: GatewayMessage) => void;
type ProgressHandler = (event: ProgressEvent) => void;
type ConnectionHandler = (status: 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'failed') => void;

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
    private messageHandlers: MessageHandler[] = [];
    private connectionHandlers: ConnectionHandler[] = [];
    private reconnectAttempts = 0;
    private maxReconnectAttempts = 10;
    private reconnectDelay = 1000;
    private shouldReconnect = true;

    // Tauri IPC bridge mode
    private bridgeMode = false;
    private bridgeUnlisten: (() => void)[] = [];

    constructor(url: string, token?: string) {
        this.url = url;
        this.token = token;
    }

    /**
     * Connect to the Gateway
     * Strategy: try native WebSocket first (3s timeout), then auto-switch to the Tauri IPC bridge on failure
     */
    async connect(): Promise<void> {
        // If already in bridge mode, reconnect via the bridge directly
        if (this.bridgeMode) {
            return this.connectViaBridge();
        }

        try {
            await this.connectNative();
        } catch (nativeErr) {
            console.warn('[GatewayClient] Native WS failed, trying Tauri IPC bridge...', nativeErr);
            this.bridgeMode = true;
            await this.connectViaBridge();
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
                clearTimeout(timer);
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
                                .then(() => {
                                    this.notifyConnectionChange('connected');
                                    settle(resolve);
                                })
                                .catch((e) => settle(() => reject(e)));
                        } else {
                            this.authenticated = true;
                            this.notifyConnectionChange('connected');
                            settle(resolve);
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
                    this.authenticated = false;
                    this.notifyConnectionChange('disconnected');
                    settle(() => reject(new Error('WebSocket closed before welcome')));
                    if (this.shouldReconnect && !this.bridgeMode) {
                        this.tryReconnect();
                    }
                };

                this.ws.onerror = (error) => {
                    console.error('[GatewayClient] Connection error:', error);
                    this.removeMessageHandler(welcomeHandler);
                    settle(() => reject(new Error('WebSocket connection error')));
                };

                // After a 3s timeout, let the caller try the bridge
                timer = setTimeout(() => {
                    this.removeMessageHandler(welcomeHandler);
                    console.warn('[GatewayClient] Native WS timeout (3s), will try bridge');
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
                            .then(() => {
                                this.notifyConnectionChange('connected');
                                resolve();
                            })
                            .catch(reject);
                    } else {
                        this.authenticated = true;
                        this.notifyConnectionChange('connected');
                        resolve();
                    }
                } else if ((msg as any).type === 'bridge_disconnected') {
                    // Rust bridge notified disconnect
                    this.authenticated = false;
                    this.notifyConnectionChange('disconnected');
                    if (this.shouldReconnect) {
                        this.tryReconnect();
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

    /**
     * Attempt to reconnect
     */
    private tryReconnect(): void {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('[GatewayClient] Max reconnect attempts reached');
            this.notifyConnectionChange('failed');
            return;
        }

        this.reconnectAttempts++;
        const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1), 30000);
        console.log(`[GatewayClient] Reconnecting in ${delay}ms (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

        this.notifyConnectionChange('reconnecting');

        setTimeout(() => {
            if (this.shouldReconnect) {
                this.connect().catch(console.error);
            }
        }, delay);
    }

    /**
     * Disconnect
     */
    disconnect(): void {
        this.shouldReconnect = false;
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
        if (this.bridgeMode) {
            // Bridge mode: send via Rust invoke
            import('@tauri-apps/api/core').then(({ invoke }) => {
                invoke('gw_bridge_send', { message: JSON.stringify(message) }).catch(
                    (e: unknown) => console.error('[GatewayClient] Bridge send failed:', e)
                );
            });
        } else if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
        }
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

            // Handle chat completion events
            if (message.type === 'chat.complete') {
                const payload = message.payload as { output?: string; sessionId?: string };
                const completeEvent: ProgressEvent = {
                    type: 'complete',
                    output: payload?.output,
                    sessionId: payload?.sessionId,
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
                message.type === 'chat.start' || message.type === 'chat.progress' || message.type === 'config.progress' || message.type === 'nexusai.auth-expired';

            if (message.id && this.pendingRequests.has(message.id) && !isIntermediateMessage) {
                console.log('[GatewayClient] Matched pending request (final):', message.id, message.type);
                const { resolve, reject } = this.pendingRequests.get(message.id)!;
                this.pendingRequests.delete(message.id);

                if (message.type.endsWith('.error')) {
                    const payload = message.payload as { message?: string };
                    reject(new Error(payload.message || '请求失败'));
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
            this.send({ type, id, payload });

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
        options?: { source?: 'local' | 'cloud'; chatroomId?: number; agentId?: string }
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
        const result = await this.request<{ output?: string }>('chat', payload, 0);
        console.log('[GatewayClient] Chat response:', result);
        return result?.output || '';
    }

    /**
     * Stop the running task
     */
    stopTask(sessionId: string): void {
        console.log('[GatewayClient] Stopping task:', sessionId);
        this.send({ type: 'chat.stop', payload: { sessionId } });
    }

    /**
     * Get the session list
     */
    async getSessions(): Promise<Session[]> {
        console.log('[GatewayClient] getSessions request');
        const result = await this.request<{ sessions: Session[] }>('sessions.list');
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

    /**
     * Create a session
     */
    async createSession(title?: string, cloudChatroomId?: number, cloudAgentName?: string): Promise<Session> {
        const result = await this.request<{ session: Session }>('sessions.create', { title, cloudChatroomId, cloudAgentName });
        return result.session;
    }

    /**
     * Delete a session
     */
    async deleteSession(sessionId: string): Promise<void> {
        await this.request<{ success: boolean }>('sessions.delete', { sessionId });
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
    async getAgents(): Promise<Array<{ id: string; name: string; description?: string; icon?: string; color?: string; default?: boolean; systemPrompt?: string; createdAt: number; updatedAt: number }>> {
        const result = await this.request<{ agents: Array<{ id: string; name: string; description?: string; icon?: string; color?: string; default?: boolean; systemPrompt?: string; createdAt: number; updatedAt: number }> }>('agents.list');
        return result.agents || [];
    }

    /** Create a new Agent */
    async createAgent(config: { id: string; name?: string; description?: string; icon?: string; color?: string; systemPrompt?: string }): Promise<Record<string, unknown>> {
        const result = await this.request<{ agent: Record<string, unknown> }>('agents.create', config);
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

    /** Switch Agent (returns Agent info + session history) */
    async switchAgent(agentId: string): Promise<{ agent: Record<string, unknown>; messages: unknown[] }> {
        return this.request<{ agent: Record<string, unknown>; messages: unknown[] }>('agents.switch', { agentId });
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
                handler(payload?.message || 'NexusAI access token 已过期，请重新登录');
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
    async routerConfigGet(): Promise<{ connected: boolean; config: RouterConfigView | null }> {
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
    onRouterStatus(handler: (status: { connected: boolean; status: string }) => void): () => void {
        const messageHandler = (msg: GatewayMessage) => {
            if (msg.type === 'router.status') {
                handler(msg.payload as { connected: boolean; status: string });
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
}

export interface SchedulerEventView {
    type: string;
    taskId: string;
    taskName?: string;
    runId?: string;
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
