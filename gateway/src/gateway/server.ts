/**
 * Gateway Server - 极简版
 * 只负责 WebSocket 连接和消息路由
 * 支持多 Agent 模式（agentId 路由）
 */

// @ts-ignore - 运行时有 ws 模块
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'node:crypto';
import { SessionStore } from '../sessions';
import type { AgentManager } from '../agent/manager';
import { Logger, onLogBroadcast, type LogEntry } from '../utils/logger';

const log = new Logger('Gateway');

/**
 * Gateway 配置
 */
export interface GatewayConfig {
    /** WebSocket 端口 */
    port?: number;
    /** 认证 Token */
    token?: string;
    /** 会话存储路径 */
    sessionStorePath?: string;
    /** Agent 执行回调（支持进度推送、agentId 路由和文件附件） */
    onAgentExecute?: (
        input: string,
        sessionId?: string,
        onProgress?: (event: AgentProgressEvent) => void,
        agentId?: string,
        attachments?: Array<{ path: string; name: string; size: number; ext: string }>
    ) => Promise<string>;
    /** Agent 管理器（用于获取 Agent 列表等） */
    agentManager?: AgentManager;
}

/**
 * Agent 进度事件
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
    /** LLM 原始描述文字（仅 tool_start 事件，来自 LLM 的 content） */
    llmDescription?: string;
}

/**
 * 客户端连接
 */
interface GatewayClient {
    id: string;
    ws: WebSocket;
    authenticated: boolean;
    /** 是否订阅了 debug 日志 */
    debugSubscribed?: boolean;
}

/**
 * 消息类型
 */
interface GatewayMessage {
    type: string;
    id?: string;
    payload?: unknown;
}

/**
 * 创建 Gateway Server
 */
export function createGatewayServer(config: GatewayConfig) {
    const port = config.port || 18801;
    const clients = new Map<string, GatewayClient>();
    const sessionStore = new SessionStore({ storePath: config.sessionStorePath });
    let wss: WebSocketServer | null = null;

    // 注册全局日志广播：将日志推送到所有已订阅 debug 的客户端
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
                    // 发送失败不影响其他客户端
                }
            }
        }
    });

    /**
     * 处理连接
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
        log.info(`客户端连接: ${clientId}`);

        send(client, {
            type: 'welcome',
            payload: { requireAuth: !!config.token },
        });

        ws.on('message', (data: Buffer) => handleMessage(client, data.toString()));
        ws.on('close', () => {
            clients.delete(clientId);
            log.info(`客户端断开: ${clientId}`);
        });
        ws.on('error', (error: Error) => log.error(`客户端错误: ${clientId}`, { error }));
    }

    /**
     * 处理消息
     */
    async function handleMessage(client: GatewayClient, data: string): Promise<void> {
        try {
            const message: GatewayMessage = JSON.parse(data);

            if (!client.authenticated && message.type !== 'auth') {
                send(client, { type: 'error', payload: { message: '未认证' } });
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
                    log.info(`客户端 ${client.id} 订阅 debug 日志`);
                    break;
                case 'debug.unsubscribe':
                    client.debugSubscribed = false;
                    log.info(`客户端 ${client.id} 取消订阅 debug 日志`);
                    break;
                default:
                    send(client, { type: 'error', payload: { message: `未知类型: ${message.type}` } });
            }
        } catch (error) {
            log.error('消息处理失败', { error });
            send(client, { type: 'error', payload: { message: '处理失败' } });
        }
    }

    /**
     * 认证
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
     * 聊天（核心）
     * 支持 agentId 路由：客户端可指定 agentId，不指定则自动路由
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
            send(client, { type: 'error', payload: { message: '缺少 input' } });
            return;
        }

        send(client, { type: 'chat.start', id: messageId });

        try {
            // 调用 Agent 执行，传入进度回调、agentId 和附件
            let output = '';
            if (config.onAgentExecute) {
                output = await config.onAgentExecute(
                    payload.input || '',
                    payload.sessionId,
                    (event) => {
                        // 推送进度事件给客户端
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
     * 会话列表
     */
    function handleSessionsList(client: GatewayClient, message: GatewayMessage): void {
        const sessions = sessionStore.list();
        send(client, { type: 'sessions.list', id: message.id, payload: { sessions } });
    }

    /**
     * 获取会话
     */
    function handleSessionsGet(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { sessionId: string };
        if (!payload?.sessionId) {
            send(client, { type: 'error', payload: { message: '缺少 sessionId' } });
            return;
        }

        const messages = sessionStore.getMessages(payload.sessionId);
        const metadata = sessionStore.get(payload.sessionId);
        send(client, { type: 'sessions.get', id: message.id, payload: { metadata, messages } });
    }

    /**
     * 创建会话
     */
    function handleSessionsCreate(client: GatewayClient, message: GatewayMessage): void {
        const payload = message.payload as { title?: string; agentId?: string };
        const agentId = payload?.agentId || 'default';
        const session = sessionStore.create(agentId, payload?.title);
        send(client, { type: 'sessions.create', id: message.id, payload: { session } });
    }

    /**
     * Agent 列表
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
            // 单 Agent 模式
            send(client, {
                type: 'agents.list',
                id: message.id,
                payload: {
                    agents: [{ id: 'default', name: '通用助手', description: '', default: true, profile: 'full' }],
                },
            });
        }
    }

    /**
     * 发送消息
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
                    log.info(`Gateway 启动: ws://localhost:${port}`);
                    resolve();
                });
            });
        },

        stop(): Promise<void> {
            return new Promise((resolve) => {
                if (wss) {
                    wss.close(() => {
                        log.info('Gateway 停止');
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
