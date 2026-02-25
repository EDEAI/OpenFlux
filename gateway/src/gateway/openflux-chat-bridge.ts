/**
 * OpenFlux 云端聊天桥接器
 * 将 OpenFlux 圆桌 WebSocket 聊天协议桥接为内部 AgentProgressEvent
 *
 * 协议格式：
 *   指令：--OpenFlux-INSTRUCTION-[cmd, data]--
 *   纯文本：AI 流式回复片段
 *
 * 聊天流程：ENTER(进入聊天室) → INPUT(发消息) → 收到 CHAT/REPLY/TEXT/ENDREPLY/ENDCHAT
 */

import WebSocket from 'ws';
import { Logger } from '../utils/logger';

const log = new Logger('OpenFluxChatBridge');

// ========================
// 类型定义
// ========================

/** OpenFlux 连接配置 */
export interface OpenFluxCloudConfig {
    apiUrl: string;   // https://nexus-api.atyun.com
    wsUrl: string;    // wss://nexus-chat.atyun.com
}

/** OpenFlux Agent 信息 */
export interface OpenFluxAgent {
    agentId: number;
    appId: number;
    name: string;
    description?: string;
    chatroomId: number;
    avatar?: string;
}

/** OpenFlux 聊天历史消息 */
export interface OpenFluxChatHistoryMessage {
    role: 'user' | 'assistant';
    content: string;
    createdAt: number;
    agentName?: string;
}

/** 聊天进度事件（桥接到 Gateway 的事件格式） */
export interface OpenFluxChatProgressEvent {
    type: 'iteration' | 'tool_start' | 'tool_result' | 'thinking' | 'token';
    tool?: string;
    args?: Record<string, unknown>;
    result?: unknown;
    token?: string;
    description?: string;
}

/** 聊天室内 WebSocket 连接 */
interface ChatroomRequest {
    message: string;
    onProgress: (event: OpenFluxChatProgressEvent) => void;
    resolve: (output: string) => void;
    reject: (error: Error) => void;
}

interface ChatroomConnection {
    ws: WebSocket;
    chatroomId: number;
    ready: boolean;
    /** 当前是否正在进行聊天（防止同聊天室并发） */
    busy: boolean;
    /** 当前正在执行的请求（用于 close 时 reject） */
    currentRequest: ChatroomRequest | null;
    /** 排队请求 */
    queue: ChatroomRequest[];
}

// ========================
// OpenFluxChatBridge
// ========================

export class OpenFluxChatBridge {
    private config: OpenFluxCloudConfig;
    private token: string | null = null;
    private username: string | null = null;
    /** 按聊天室 ID 复用连接 */
    private connections = new Map<number, ChatroomConnection>();

    constructor(config: OpenFluxCloudConfig) {
        this.config = config;
    }

    // ========================
    // 认证
    // ========================

    /** 登录 OpenFlux */
    async login(username: string, password: string): Promise<{ success: boolean; message?: string }> {
        try {
            const resp = await fetch(`${this.config.apiUrl}/v1/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ username, password }),
            });

            if (!resp.ok) {
                const errText = await resp.text();
                log.error('登录失败', { status: resp.status, body: errText });
                return { success: false, message: `HTTP ${resp.status}: ${errText}` };
            }

            const data = await resp.json();
            this.token = data.access_token || data.token;
            this.username = username;

            if (!this.token) {
                return { success: false, message: '响应中无 token' };
            }

            log.info('OpenFlux 登录成功', { username });
            return { success: true };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            log.error('OpenFlux 登录异常', { error: msg });
            return { success: false, message: msg };
        }
    }

    /** 登出（清理所有连接） */
    async logout(): Promise<void> {
        // 关闭所有 WebSocket 连接
        for (const [chatroomId, conn] of this.connections) {
            try {
                conn.ws.close();
            } catch { /* ignore */ }
            log.info(`关闭聊天室连接: ${chatroomId}`);
        }
        this.connections.clear();
        this.token = null;
        this.username = null;
        log.info('OpenFlux 已登出');
    }

    /** 获取登录状态 */
    getStatus(): { loggedIn: boolean; username?: string } {
        return {
            loggedIn: !!this.token,
            username: this.username || undefined,
        };
    }

    /** 获取当前 token（内部使用） */
    private getAuthHeaders(): Record<string, string> {
        if (!this.token) throw new Error('未登录 OpenFlux');
        return { 'Authorization': `Bearer ${this.token}` };
    }

    // ========================
    // Agent 信息
    // ========================

    /** 获取 Agent 列表 */
    async getAgentList(): Promise<OpenFluxAgent[]> {
        const headers = this.getAuthHeaders();
        const resp = await fetch(
            `${this.config.apiUrl}/v1/agent/agent_list?page=1&page_size=50&agent_search_type=1`,
            { headers }
        );

        if (!resp.ok) {
            throw new Error(`获取 Agent 列表失败: HTTP ${resp.status}`);
        }

        const result = await resp.json();
        const list = result.data?.list || result.data || [];

        return list.map((item: any) => ({
            agentId: item.agent_id,
            appId: item.app_id,
            name: item.name || item.agent_name || `Agent ${item.agent_id}`,
            description: item.description || item.agent_description || '',
            chatroomId: item.agent_chatroom_id || 0,
            avatar: item.avatar || '',
        }));
    }

    /** 获取单个 Agent 信息（包含 chatroom_id） */
    async getAgentInfo(appId: number): Promise<OpenFluxAgent | null> {
        const headers = this.getAuthHeaders();
        const resp = await fetch(
            `${this.config.apiUrl}/v1/agent/agent_info/${appId}?publish_status=1`,
            { headers }
        );

        if (!resp.ok) return null;

        const result = await resp.json();
        const data = result.data;
        if (!data) return null;

        const agent = data.agent || {};
        const app = data.app || {};

        return {
            agentId: agent.agent_id || 0,
            appId: app.app_id || appId,
            name: app.name || `Agent ${appId}`,
            description: app.description || '',
            chatroomId: data.agent_chatroom_id || 0,
            avatar: app.avatar || '',
        };
    }

    // ========================
    // 聊天历史
    // ========================

    /** 获取聊天室历史消息 */
    async getChatHistory(chatroomId: number, page: number = 1, pageSize: number = 20): Promise<OpenFluxChatHistoryMessage[]> {
        const headers = this.getAuthHeaders();
        const resp = await fetch(
            `${this.config.apiUrl}/v1/chat/chat_message_list?chatroom_id=${chatroomId}&page=${page}&page_size=${pageSize}`,
            { headers }
        );

        if (!resp.ok) {
            log.warn('获取聊天历史失败', { chatroomId, status: resp.status });
            return [];
        }

        const result = await resp.json();
        const list = result.data?.list || result.data || [];

        return list.map((item: any) => ({
            role: item.role === 'agent' || item.role === 'assistant' ? 'assistant' as const : 'user' as const,
            content: item.content || item.message || '',
            createdAt: item.created_at ? new Date(item.created_at).getTime() : Date.now(),
            agentName: item.agent_name || item.nickname || undefined,
        }));
    }

    // ========================
    // WebSocket 聊天
    // ========================

    /**
     * 发送聊天消息
     * 如果聊天室连接已存在且空闲，复用连接；否则创建新连接。
     * 同一聊天室的请求会排队串行执行。
     */
    async chat(
        chatroomId: number,
        message: string,
        onProgress: (event: OpenFluxChatProgressEvent) => void,
    ): Promise<string> {
        if (!this.token) throw new Error('未登录 OpenFlux');

        return new Promise<string>((resolve, reject) => {
            const request = { message, onProgress, resolve, reject };

            let conn = this.connections.get(chatroomId);

            if (conn && conn.ws.readyState === WebSocket.OPEN) {
                if (conn.busy) {
                    // 同聊天室排队
                    conn.queue.push(request);
                    log.info(`聊天室 ${chatroomId} 繁忙，排队等待 (队列长度: ${conn.queue.length})`);
                } else {
                    // 直接执行
                    this.executeChat(conn, request);
                }
            } else {
                // 需要新连接
                if (conn) {
                    try { conn.ws.close(); } catch { /* ignore */ }
                    this.connections.delete(chatroomId);
                }
                this.createConnection(chatroomId, request);
            }
        });
    }

    /** 创建 WebSocket 连接并进入聊天室 */
    private createConnection(
        chatroomId: number,
        firstRequest: ChatroomConnection['queue'][0],
    ): void {
        const wsUrl = `${this.config.wsUrl}/?token=${this.token}`;
        const ws = new WebSocket(wsUrl);

        const conn: ChatroomConnection = {
            ws,
            chatroomId,
            ready: false,
            busy: false,
            currentRequest: null,
            queue: [],
        };

        this.connections.set(chatroomId, conn);

        ws.on('open', () => {
            log.info(`WebSocket 连接成功: 聊天室 ${chatroomId}`);
            // 进入聊天室
            ws.send(JSON.stringify(['ENTER', chatroomId]));
            // 设置桌面模式
            ws.send(JSON.stringify(['ISDESKTOP', true]));

            // 短暂等待 ENTER 确认后开始首个请求
            setTimeout(() => {
                conn.ready = true;
                this.executeChat(conn, firstRequest);
            }, 500);
        });

        ws.on('error', (error) => {
            log.error(`WebSocket 连接错误: 聊天室 ${chatroomId}`, { error });
            // reject 当前活跃请求
            if (conn.currentRequest) {
                conn.currentRequest.reject(new Error(`WebSocket 连接失败: ${error.message}`));
                conn.currentRequest = null;
            } else {
                firstRequest.reject(new Error(`WebSocket 连接失败: ${error.message}`));
            }
            this.connections.delete(chatroomId);
        });

        ws.on('close', () => {
            log.info(`WebSocket 连接关闭: 聊天室 ${chatroomId}`);
            // reject 当前活跃请求（关键修复：之前只处理队列，漏掉了正在执行的请求）
            if (conn.currentRequest) {
                conn.currentRequest.reject(new Error('WebSocket 连接已关闭'));
                conn.currentRequest = null;
            }
            // 拒绝所有排队请求
            for (const req of conn.queue) {
                req.reject(new Error('WebSocket 连接已关闭'));
            }
            conn.queue = [];
            conn.busy = false;
            this.connections.delete(chatroomId);
        });
    }

    /** 在已有连接上执行聊天 */
    private executeChat(
        conn: ChatroomConnection,
        request: ChatroomConnection['queue'][0],
    ): void {
        conn.busy = true;
        conn.currentRequest = request;
        const { message, onProgress, resolve, reject } = request;
        const fullReply: string[] = [];
        let chatTimeout: ReturnType<typeof setTimeout> | null = null;

        // 设置超时（5 分钟）
        chatTimeout = setTimeout(() => {
            cleanup();
            reject(new Error('聊天超时（5 分钟）'));
            this.processNextInQueue(conn);
        }, 5 * 60 * 1000);

        const cleanup = () => {
            conn.ws.removeListener('message', messageHandler);
            conn.currentRequest = null;
            if (chatTimeout) {
                clearTimeout(chatTimeout);
                chatTimeout = null;
            }
        };

        const messageHandler = (data: WebSocket.Data) => {
            // trim 防止末尾换行符导致正则匹配失败
            const raw = data.toString().trim();
            if (!raw) return;

            // 解析 OpenFlux 指令
            const match = raw.match(/^--OpenFlux-INSTRUCTION-(.+)--$/);
            if (match) {
                try {
                    const instruction = JSON.parse(match[1]);
                    const cmd = instruction[0];
                    const cmdData = instruction.length > 1 ? instruction[1] : null;
                    log.info(`WS 指令: ${cmd}`, { chatroomId: conn.chatroomId });

                    this.handleInstruction(cmd, cmdData, onProgress, fullReply, () => {
                        // ENDCHAT 回调：聊天结束
                        log.info('ENDCHAT 收到，resolve Promise', {
                            chatroomId: conn.chatroomId,
                            replyLength: fullReply.join('').length,
                        });
                        cleanup();
                        const output = fullReply.join('');
                        resolve(output);
                        this.processNextInQueue(conn);
                    }, () => {
                        // ERROR 回调
                        cleanup();
                        reject(new Error(`OpenFlux 错误: ${JSON.stringify(cmdData)}`));
                        this.processNextInQueue(conn);
                    });
                } catch (e) {
                    log.warn('解析指令失败', { raw: raw.slice(0, 200) });
                }
            } else {
                // 纯文本流 — AI 回复片段
                fullReply.push(raw);
                onProgress({ type: 'token', token: raw });
            }
        };

        conn.ws.on('message', messageHandler);

        // 发送消息
        log.info(`发送消息到聊天室 ${conn.chatroomId}`, { message: message.slice(0, 100) });
        conn.ws.send(JSON.stringify(['INPUT', message]));
    }

    /** 处理 OpenFlux 指令 */
    private handleInstruction(
        cmd: string,
        data: any,
        onProgress: (event: OpenFluxChatProgressEvent) => void,
        _fullReply: string[],
        onEndChat: () => void,
        onError: () => void,
    ): void {
        switch (cmd) {
            case 'CHAT':
                // 用户消息确认（不需要推送给客户端）
                break;

            case 'REPLY':
                // Agent 开始回复
                onProgress({ type: 'iteration', description: `Agent ${data} 开始回复` });
                break;

            case 'TEXT':
                // Agent 开始发送文本（不需要特殊处理，文本通过纯文本流接收）
                break;

            case 'ENDREPLY':
                // Agent 回复结束（单个 Agent 的回复结束，多 Agent 圆桌可能有多个）
                break;

            case 'ENDCHAT':
                // 本轮聊天完整结束
                onEndChat();
                break;

            case 'MCPTOOLUSE':
                // MCP 工具调用
                onProgress({
                    type: 'tool_start',
                    tool: data?.tool_name || data?.name || 'mcp_tool',
                    args: data?.arguments || data,
                    description: `调用工具: ${data?.tool_name || data?.name || 'unknown'}`,
                });
                break;

            case 'WITHMCPTOOLRESULT':
                // MCP 工具结果
                onProgress({
                    type: 'tool_result',
                    tool: data?.tool_name || data?.name || 'mcp_tool',
                    result: data?.result || data,
                });
                break;

            case 'STOPPABLE':
                // 可中断标记（忽略）
                break;

            case 'TITLE':
                // 聊天室标题更新（忽略）
                break;

            case 'ERROR':
                log.error('OpenFlux 聊天错误', { data });
                onError();
                break;

            case 'TRUNCATABLE':
                // 历史消息截断标记（忽略）
                break;

            default:
                log.warn(`未知 OpenFlux 指令: ${cmd}`, { data });
                break;
        }
    }

    /** 处理队列中的下一个请求 */
    private processNextInQueue(conn: ChatroomConnection): void {
        conn.busy = false;

        if (conn.queue.length > 0) {
            const next = conn.queue.shift()!;
            log.info(`处理队列中的下一个请求 (剩余: ${conn.queue.length})`);
            this.executeChat(conn, next);
        }
    }

    /** 销毁所有连接（关闭时调用） */
    destroy(): void {
        for (const [chatroomId, conn] of this.connections) {
            try { conn.ws.close(); } catch { /* ignore */ }
        }
        this.connections.clear();
    }
}
