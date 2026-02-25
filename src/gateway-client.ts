/**
 * WebSocket 客户端封装
 * 用于渲染进程连接 Gateway Server
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
    /** LLM 原始描述文字（仅 tool_start 事件，来自 LLM 的 content） */
    llmDescription?: string;
    /** 关联的会话 ID（用于跨会话隔离，Router 消息广播时携带） */
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
 * Gateway WebSocket 客户端
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

    constructor(url: string, token?: string) {
        this.url = url;
        this.token = token;
    }

    /**
     * 连接到 Gateway
     */
    async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                this.notifyConnectionChange('connecting');
                this.ws = new WebSocket(this.url);

                this.ws.onopen = () => {
                    console.log('[GatewayClient] 已连接');
                    this.reconnectAttempts = 0;
                };

                this.ws.onmessage = (event) => {
                    this.handleMessage(event.data);
                };

                this.ws.onclose = () => {
                    console.log('[GatewayClient] 连接已关闭');
                    this.authenticated = false;
                    this.notifyConnectionChange('disconnected');
                    if (this.shouldReconnect) {
                        this.tryReconnect();
                    }
                };

                this.ws.onerror = (error) => {
                    console.error('[GatewayClient] 连接错误:', error);
                    if (this.reconnectAttempts === 0) {
                        // 首次连接失败才 reject
                        reject(new Error('WebSocket 连接失败'));
                    }
                };

                // 等待 welcome 消息
                const welcomeHandler = (msg: GatewayMessage) => {
                    if (msg.type === 'welcome') {
                        this.removeMessageHandler(welcomeHandler);
                        const payload = msg.payload as { requireAuth?: boolean; setupRequired?: boolean };

                        // 保存首次运行标志
                        if (payload.setupRequired) {
                            (this as any)._setupRequired = true;
                        }

                        if (payload.requireAuth && this.token) {
                            this.authenticate().then(() => {
                                this.notifyConnectionChange('connected');
                                resolve();
                            }).catch(reject);
                        } else {
                            this.authenticated = true;
                            this.notifyConnectionChange('connected');
                            resolve();
                        }
                    }
                };
                this.addMessageHandler(welcomeHandler);

            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * 认证
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
     * 尝试重连
     */
    private tryReconnect(): void {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('[GatewayClient] 重连次数已达上限');
            this.notifyConnectionChange('failed');
            return;
        }

        this.reconnectAttempts++;
        const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1), 30000);
        console.log(`[GatewayClient] ${delay}ms 后尝试重连 (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

        this.notifyConnectionChange('reconnecting');

        setTimeout(() => {
            if (this.shouldReconnect) {
                this.connect().catch(console.error);
            }
        }, delay);
    }

    /**
     * 断开连接
     */
    disconnect(): void {
        this.shouldReconnect = false;
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }

    /**
     * 通知连接状态变化
     */
    private notifyConnectionChange(status: 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'failed'): void {
        this.connectionHandlers.forEach(handler => handler(status));
    }

    /**
     * 监听连接状态变化
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
     * 是否已连接
     */
    isConnected(): boolean {
        return this.ws?.readyState === WebSocket.OPEN && this.authenticated;
    }

    /**
     * 发送消息
     */
    private send(message: GatewayMessage): void {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
        }
    }

    /**
     * 处理收到的消息
     */
    private handleMessage(data: string): void {
        try {
            const message: GatewayMessage = JSON.parse(data);
            console.log('[GatewayClient] 收到消息:', message.type, message.id, message);

            // 通知所有消息处理器
            this.messageHandlers.forEach(handler => handler(message));

            // 处理进度事件
            if (message.type === 'chat.progress') {
                const event = message.payload as ProgressEvent;
                this.progressHandlers.forEach(handler => handler(event));
            }

            // 处理聊天完成事件
            if (message.type === 'chat.complete') {
                const payload = message.payload as { output?: string; sessionId?: string };
                const completeEvent: ProgressEvent = {
                    type: 'complete',
                    output: payload?.output,
                    sessionId: payload?.sessionId,
                };
                this.progressHandlers.forEach(handler => handler(completeEvent));
            }

            // 处理客户端 MCP 工具调用请求
            if (message.type === 'mcp.client.call' && message.id) {
                this.handleClientMcpCall(message);
                return; // 不走 pendingRequests 逻辑
            }

            // 处理响应 —— 只对「最终」消息 resolve/reject
            // chat.start 和 chat.progress 是中间状态消息，不应触发 resolve
            const isIntermediateMessage =
                message.type === 'chat.start' || message.type === 'chat.progress';

            if (message.id && this.pendingRequests.has(message.id) && !isIntermediateMessage) {
                console.log('[GatewayClient] 匹配到 pending 请求 (final):', message.id, message.type);
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
            console.error('[GatewayClient] 解析消息失败:', error);
        }
    }

    /**
     * 添加消息处理器
     */
    addMessageHandler(handler: MessageHandler): void {
        this.messageHandlers.push(handler);
    }

    /**
     * 移除消息处理器
     */
    removeMessageHandler(handler: MessageHandler): void {
        const index = this.messageHandlers.indexOf(handler);
        if (index !== -1) {
            this.messageHandlers.splice(index, 1);
        }
    }

    /**
     * 处理 Gateway 发来的客户端 MCP 工具调用请求
     */
    private async handleClientMcpCall(message: GatewayMessage): Promise<void> {
        const { tool, args } = message.payload as { tool: string; args: Record<string, unknown> };
        console.log('[GatewayClient] 收到客户端 MCP 工具调用:', tool);

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
     * 将客户端本机 MCP 工具注册到 Gateway
     */
    registerClientMcpTools(tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>): void {
        if (!this.isConnected()) {
            console.warn('[GatewayClient] 未连接，无法注册客户端 MCP 工具');
            return;
        }
        console.log(`[GatewayClient] 注册客户端 MCP 工具: ${tools.length} 个`);
        this.send({
            type: 'mcp.client.register',
            payload: { tools },
        });
    }

    /**
     * 通知 Gateway 移除客户端 MCP 工具
     */
    unregisterClientMcpTools(): void {
        if (!this.isConnected()) return;
        console.log('[GatewayClient] 移除客户端 MCP 工具');
        this.send({
            type: 'mcp.client.unregister',
        });
    }

    /**
     * 监听进度事件
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
     * 发起请求并等待响应
     * @param timeout 超时毫秒数，0 表示不超时（默认 120 秒）
     */
    public request<T>(type: string, payload?: unknown, timeout: number = 120000): Promise<T> {
        return new Promise((resolve, reject) => {
            const id = crypto.randomUUID();
            this.pendingRequests.set(id, {
                resolve: resolve as (value: unknown) => void,
                reject
            });
            this.send({ type, id, payload });

            // 超时（0 表示不限时，适用于 chat 等长时间执行场景）
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
     * 发送聊天消息（支持附件、云端 Agent）
     * 不设超时：Agent 多步执行可能耗时很长，进度通过 chat.progress 实时推送
     */
    async chat(
        input: string,
        sessionId?: string,
        attachments?: Array<{ path: string; name: string; size: number; ext: string }>,
        options?: { source?: 'local' | 'cloud'; chatroomId?: number }
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
        const result = await this.request<{ output?: string }>('chat', payload, 0);
        console.log('[GatewayClient] chat 响应:', result);
        return result?.output || '';
    }

    /**
     * 获取会话列表
     */
    async getSessions(): Promise<Session[]> {
        console.log('[GatewayClient] getSessions 请求');
        const result = await this.request<{ sessions: Session[] }>('sessions.list');
        console.log('[GatewayClient] getSessions 响应:', result);
        return result.sessions;
    }

    /**
     * 获取会话消息
     */
    async getMessages(sessionId: string): Promise<unknown[]> {
        console.log('[GatewayClient] getMessages 请求:', sessionId);
        const result = await this.request<{ messages: unknown[] }>('sessions.messages', { sessionId });
        console.log('[GatewayClient] getMessages 响应:', result);
        return result.messages;
    }

    /**
     * 获取会话日志
     */
    async getLogs(sessionId: string): Promise<unknown[]> {
        const result = await this.request<{ logs: unknown[] }>('sessions.logs', { sessionId });
        return result.logs;
    }

    /**
     * 创建会话
     */
    async createSession(title?: string, cloudChatroomId?: number, cloudAgentName?: string): Promise<Session> {
        const result = await this.request<{ session: Session }>('sessions.create', { title, cloudChatroomId, cloudAgentName });
        return result.session;
    }

    /**
     * 删除会话
     */
    async deleteSession(sessionId: string): Promise<void> {
        await this.request<{ success: boolean }>('sessions.delete', { sessionId });
    }

    /**
     * 获取会话成果物
     */
    async getArtifacts(sessionId: string): Promise<SessionArtifactView[]> {
        const result = await this.request<{ artifacts: SessionArtifactView[] }>('sessions.artifacts', { sessionId });
        return result.artifacts;
    }

    /**
     * 保存会话成果物
     */
    async saveArtifact(sessionId: string, artifact: Omit<SessionArtifactView, 'id'>): Promise<SessionArtifactView> {
        const result = await this.request<{ artifact: SessionArtifactView }>('sessions.artifacts.save', { sessionId, artifact });
        return result.artifact;
    }

    // ========================
    // Scheduler API
    // ========================

    /**
     * 获取定时任务列表
     */
    async getSchedulerTasks(): Promise<ScheduledTaskView[]> {
        const result = await this.request<{ tasks: ScheduledTaskView[] }>('scheduler.list');
        return result.tasks;
    }

    /**
     * 获取执行记录
     */
    async getSchedulerRuns(taskId?: string, limit?: number): Promise<TaskRunView[]> {
        const result = await this.request<{ runs: TaskRunView[] }>('scheduler.runs', { taskId, limit });
        return result.runs;
    }

    /**
     * 暂停任务
     */
    async pauseSchedulerTask(taskId: string): Promise<boolean> {
        const result = await this.request<{ success: boolean }>('scheduler.pause', { taskId });
        return result.success;
    }

    /**
     * 恢复任务
     */
    async resumeSchedulerTask(taskId: string): Promise<boolean> {
        const result = await this.request<{ success: boolean }>('scheduler.resume', { taskId });
        return result.success;
    }

    /**
     * 删除任务
     */
    async deleteSchedulerTask(taskId: string): Promise<boolean> {
        const result = await this.request<{ success: boolean }>('scheduler.delete', { taskId });
        return result.success;
    }

    /**
     * 手动触发任务
     */
    async triggerSchedulerTask(taskId: string): Promise<unknown> {
        const result = await this.request<{ run: unknown }>('scheduler.trigger', { taskId });
        return result.run;
    }

    /**
     * 监听调度器事件
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
     * 监听会话更新事件（定时任务执行结果归集到会话时触发）
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

    // ========================
    // Memory API
    // ========================

    /**
     * 获取记忆统计信息
     */
    async memoryStats(): Promise<{ enabled: boolean; totalCount?: number; dbSizeBytes?: number; vectorDim?: number; embeddingModel?: string }> {
        return this.request('memory.stats');
    }

    /**
     * 分页列出记忆
     */
    async memoryList(page: number = 1, pageSize: number = 20): Promise<{ items: any[]; total: number; page: number; pageSize: number }> {
        return this.request('memory.list', { page, pageSize });
    }

    /**
     * 搜索记忆
     */
    async memorySearch(query: string, limit: number = 10): Promise<{ items: any[] }> {
        return this.request('memory.search', { query, limit });
    }

    /**
     * 删除单条记忆
     */
    async memoryDelete(id: string): Promise<boolean> {
        const result = await this.request<{ success: boolean }>('memory.delete', { id });
        return result.success;
    }

    /**
     * 清空所有记忆
     */
    async memoryClear(): Promise<boolean> {
        const result = await this.request<{ success: boolean }>('memory.clear');
        return result.success;
    }

    // ========================
    // Distillation API
    // ========================

    /**
     * 获取蒸馏统计信息
     */
    async distillationStats(): Promise<any> {
        return this.request('distillation.stats');
    }

    /**
     * 获取卡片关系图数据
     */
    async distillationGraph(): Promise<{ cards: any[]; relations: any[]; topics: any[] }> {
        return this.request('distillation.graph');
    }

    /**
     * 更新蒸馏配置
     */
    async distillationUpdateConfig(config: Record<string, any>): Promise<{ success: boolean; message?: string }> {
        return this.request('distillation.config.update', config);
    }

    /**
     * 手动触发蒸馏
     */
    async distillationTrigger(): Promise<{ success: boolean; message?: string }> {
        return this.request('distillation.trigger');
    }

    /**
     * 获取卡片列表（支持层级筛选和分页）
     */
    async distillationCards(layer?: string, limit = 100, offset = 0): Promise<{ cards: any[]; total: number }> {
        return this.request('distillation.cards', { layer, limit, offset });
    }

    /**
     * 删除指定卡片
     */
    async distillationDeleteCard(cardId: string): Promise<{ success: boolean; message?: string }> {
        return this.request('distillation.card.delete', { cardId });
    }

    // ========================
    // Settings API
    // ========================

    /**
     * 获取当前设置
     */
    async getSettings(): Promise<{ outputPath: string; defaultOutputPath: string }> {
        return this.request('settings.get');
    }

    /**
     * 更新设置（传 null 重置为默认值）
     */
    async updateSettings(settings: { outputPath?: string | null }): Promise<{ outputPath: string }> {
        return this.request('settings.update', settings);
    }

    // ========================
    // Server Config API
    // ========================

    /**
     * 获取服务端配置
     */
    async getServerConfig(): Promise<ServerConfigView> {
        return this.request('config.get');
    }

    /**
     * 更新服务端配置
     */
    /**
     * 是否需要首次设置
     */
    isSetupRequired(): boolean {
        return !!(this as any)._setupRequired;
    }

    /**
     * 提交首次启动设置
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
    // Debug API
    // ========================

    /**
     * 订阅 debug 日志
     */
    subscribeDebugLog(): void {
        this.send({ type: 'debug.subscribe' });
    }

    /**
     * 取消订阅 debug 日志
     */
    unsubscribeDebugLog(): void {
        this.send({ type: 'debug.unsubscribe' });
    }

    /**
     * 监听 debug 日志事件
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
     * 监听记忆索引重建进度
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
    // OpenFlux 云端 API
    // ========================

    /** 登录 OpenFlux 云端 */
    async openfluxLogin(username: string, password: string): Promise<{ success: boolean; message?: string }> {
        return this.request<{ success: boolean; message?: string }>('openflux.login', { username, password });
    }

    /** 登出 OpenFlux 云端 */
    async openfluxLogout(): Promise<void> {
        await this.request('openflux.logout');
    }

    /** 获取 OpenFlux 登录状态 */
    async openfluxStatus(): Promise<{ loggedIn: boolean; username?: string }> {
        return this.request<{ loggedIn: boolean; username?: string }>('openflux.status');
    }

    /** 获取云端 Agent 列表 */
    async openfluxAgents(): Promise<OpenFluxAgentInfo[]> {
        const result = await this.request<{ agents: OpenFluxAgentInfo[] }>('openflux.agents');
        return result.agents || [];
    }

    /** 获取单个 Agent 信息 */
    async openfluxAgentInfo(appId: number): Promise<OpenFluxAgentInfo | null> {
        const result = await this.request<{ agent: OpenFluxAgentInfo | null }>('openflux.agent-info', { appId });
        return result.agent;
    }

    /** 获取云端聊天历史 */
    async openfluxChatHistory(chatroomId: number, page?: number, pageSize?: number): Promise<OpenFluxChatMessage[]> {
        const result = await this.request<{ messages: OpenFluxChatMessage[] }>('openflux.chat-history', { chatroomId, page, pageSize });
        return result.messages || [];
    }

    // ========================
    // OpenFluxRouter API
    // ========================

    /** 获取 Router 配置和连接状态 */
    async routerConfigGet(): Promise<{ connected: boolean; config: RouterConfigView | null }> {
        return this.request('router.config.get');
    }

    /** 更新 Router 配置 */
    async routerConfigUpdate(config: Partial<RouterConfigView & { apiKey: string }>): Promise<{ success: boolean; message?: string }> {
        return this.request('router.config.update', config);
    }

    /** 发送消息到 Router（出站） */
    async routerSend(msg: RouterOutboundView): Promise<{ success: boolean; message?: string }> {
        return this.request('router.send', msg);
    }

    /** 测试 Router 连接 */
    async routerTest(config: Partial<RouterConfigView & { apiKey: string }>): Promise<{ success: boolean; message: string; latencyMs?: number }> {
        return this.request('router.test', config);
    }

    /** 监听 Router 入站消息（用户消息） */
    onRouterMessage(handler: (msg: RouterInboundView & { sessionId?: string; label?: string }) => void): () => void {
        const messageHandler = (msg: GatewayMessage) => {
            if (msg.type === 'router.user_message') {
                handler(msg.payload as RouterInboundView & { sessionId?: string; label?: string });
            }
        };
        this.addMessageHandler(messageHandler);
        return () => this.removeMessageHandler(messageHandler);
    }

    /** 监听 Router 连接状态变化 */
    onRouterStatus(handler: (status: { connected: boolean; status: string }) => void): () => void {
        const messageHandler = (msg: GatewayMessage) => {
            if (msg.type === 'router.status') {
                handler(msg.payload as { connected: boolean; status: string });
            }
        };
        this.addMessageHandler(messageHandler);
        return () => this.removeMessageHandler(messageHandler);
    }

    /** 发送 Router 绑定命令 */
    async routerBind(code: string): Promise<{ success: boolean; message: string }> {
        return this.request('router.bind', { code });
    }

    /** 监听 Router 绑定结果 */
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
    // 托管 LLM 配置 API
    // ========================

    /** 设置 LLM 配置来源 */
    async setLlmSource(source: 'local' | 'managed'): Promise<{ source: string }> {
        return this.request('config.set-llm-source', { source });
    }

    /** 获取 LLM 配置来源 */
    async getLlmSource(): Promise<{
        source: 'local' | 'managed';
        managed?: {
            available: boolean;
            provider?: string;
            model?: string;
            quota?: { daily_limit: number; used_today: number };
        };
    }> {
        return this.request('config.get-llm-source');
    }

    /** 监听 Router 托管 LLM 配置推送 */
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
}

// ========================
// Scheduler 视图类型
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
// 成果物视图类型
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
// 服务端配置类型
// ========================

/** MCP Server 视图信息 */
export interface McpServerView {
    name: string;
    /** 执行位置: server（Gateway 端）或 client（客户端本机） */
    location?: 'server' | 'client';
    transport: 'stdio' | 'sse';
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
    enabled?: boolean;
    /** 已注册的工具数量（只读，由 Gateway 返回） */
    toolCount?: number;
    /** 连接状态（只读） */
    status?: 'connected' | 'disconnected' | 'error';
}

export interface ServerConfigView {
    /** 供应商配置（名称 → API Key / BaseUrl） */
    providers: Record<string, { apiKey?: string; baseUrl?: string }>;
    /** LLM 模型配置 */
    llm: {
        orchestration: { provider: string; model: string };
        execution: { provider: string; model: string };
        embedding?: { provider: string; model: string };
        fallback?: { provider: string; model: string };
    };
    /** Web 搜索与获取配置 */
    web?: {
        search?: { provider?: string; apiKey?: string; maxResults?: number };
        fetch?: { readability?: boolean; maxChars?: number };
    };
    /** MCP 外部工具配置 */
    mcp?: {
        servers?: McpServerView[];
    };
    /** Gateway 工作模式 */
    gatewayMode: 'embedded' | 'remote';
    /** Gateway 端口 */
    gatewayPort: number;
    /** 智能体配置 */
    agents?: {
        globalAgentName?: string;
        globalSystemPrompt?: string;
        skills?: Array<{ id: string; title: string; content: string; enabled: boolean }>;
        list?: Array<{ id: string; name: string; description: string; model?: { provider: string; model: string } }>;
    };
    /** 沙盒隔离配置 */
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
    /** 预置模型列表（供应商 → 模型数组） */
    presetModels?: Record<string, { value: string; label: string; multimodal?: boolean }[]>;
}

export interface ServerConfigUpdate {
    /** 更新供应商密钥 */
    providers?: Record<string, { apiKey?: string; baseUrl?: string }>;
    /** 更新编排模型 */
    orchestration?: { provider?: string; model?: string };
    /** 更新执行模型 */
    execution?: { provider?: string; model?: string };
    /** 更新嵌入模型 */
    embedding?: { provider?: string; model?: string };
    /** 更新 Web 搜索与获取配置 */
    web?: {
        search?: { provider?: string; apiKey?: string; maxResults?: number };
        fetch?: { readability?: boolean; maxChars?: number };
    };
    /** 更新 MCP Server 配置 */
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
    /** 更新全局角色设定 */
    agents?: {
        globalAgentName?: string;
        globalSystemPrompt?: string;
        skills?: Array<{ id: string; title: string; content: string; enabled: boolean }>;
        list?: Array<{ id: string; model?: { provider: string; model: string } | null }>;
    };
    /** 更新沙盒隔离配置 */
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
// Debug 日志类型
// ========================

export interface DebugLogEntry {
    timestamp: string;
    level: 'info' | 'warn' | 'error' | 'debug';
    module: string;
    message: string;
    meta?: Record<string, unknown>;
}

// ========================
// OpenFlux 云端类型
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
// OpenFluxRouter 类型
// ========================

export interface RouterConfigView {
    url: string;
    appId: string;
    appType: string;
    apiKey: string;  // 脱敏后的
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

// 全局客户端实例
let gatewayClient: GatewayClient | null = null;

/**
 * 获取或创建 Gateway 客户端
 */
export function getGatewayClient(): GatewayClient | null {
    return gatewayClient;
}

/**
 * 初始化 Gateway 客户端
 */
export async function initGatewayClient(url: string, token?: string): Promise<GatewayClient> {
    if (gatewayClient) {
        gatewayClient.disconnect();
    }
    gatewayClient = new GatewayClient(url, token);
    await gatewayClient.connect();
    return gatewayClient;
}
