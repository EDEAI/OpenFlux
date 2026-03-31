/**
 * OpenFlux 云端聊天桥接器
 * 将 OpenFlux 圆桌 WebSocket 聊天协议桥接为内部 AgentProgressEvent
 *
 * 协议格式：
 *   指令：--NEXUSAI-INSTRUCTION-[cmd, data]--  (也兼容 --OpenFlux-INSTRUCTION-)
 *   纯文本：AI 流式回复片段
 *
 * 聊天流程：ENTER(进入聊天室) → INPUT(发消息) → 收到 CHAT/REPLY/TEXT/ENDREPLY/ENDCHAT
 */

import WebSocket from 'ws';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { Logger } from '../utils/logger';

const log = new Logger('OpenFluxChatBridge');

// ========================
// 类型定义
// ========================

/** OpenFlux 连接配置 */
export interface OpenFluxCloudConfig {
    apiUrl: string;   // https://nexus-api.atyun.com (登录/user_info)
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

/**
 * 清理消息内容中的协议指令标记
 * 用于处理历史消息等已包含原始协议标记的内容
 */
function stripInstructionMarkers(content: string): string {
    return content
        .replace(/--(?:NEXUSAI|OpenFlux)-INSTRUCTION-\[.*?\]--/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

/** Atlas 为 OpenFlux 本地 Agent 下发的运行时配置 */
export interface AtlasOpenFluxRuntimeAbility {
    model_id: number;
    model_config_id: number;
    model_name: string;
    protocol: 'openai' | 'anthropic' | 'google';
    supplier_name: string;
    display_name: string;
}

export interface AtlasOpenFluxRuntime {
    chat: AtlasOpenFluxRuntimeAbility;
    embedding?: AtlasOpenFluxRuntimeAbility;
}

export class OpenFluxChatBridge {
    private config: OpenFluxCloudConfig;
    private token: string | null = null;
    private username: string | null = null;
    /** Atlas 下发的 OpenFlux 本地 Agent 运行时配置 */
    private atlasRuntime: AtlasOpenFluxRuntime | null = null;
    /** 按聊天室 ID 复用连接 */
    private connections = new Map<number, ChatroomConnection>();
    /** token 持久化文件路径 */
    private tokenFile: string | null = null;

    constructor(config: OpenFluxCloudConfig, tokenFile?: string) {
        this.config = config;
        this.tokenFile = tokenFile || null;
        // 尝试恢复持久化的登录态
        if (this.tokenFile) {
            this.restoreToken();
        }
    }

    // ========================
    // 认证
    // ========================

    /** 从文件恢复 token 和 atlas runtime */
    private restoreToken(): void {
        if (!this.tokenFile) return;
        try {
            if (existsSync(this.tokenFile)) {
                const saved = JSON.parse(readFileSync(this.tokenFile, 'utf-8'));
                if (saved.token && saved.username) {
                    this.token = saved.token;
                    this.username = saved.username;
                    if (saved.atlasRuntime) {
                        this.atlasRuntime = saved.atlasRuntime;
                        log.info('Restored atlas runtime config', { chat_protocol: saved.atlasRuntime.chat?.protocol });
                    }
                    log.info('Restored NexusAI login state', { username: saved.username });
                }
            }
        } catch {
            log.warn('Failed to restore NexusAI login state');
        }
    }

    /** 持久化 token 和 atlas runtime 到文件 */
    private saveToken(): void {
        if (!this.tokenFile || !this.token || !this.username) return;
        try {
            writeFileSync(this.tokenFile, JSON.stringify({
                token: this.token,
                username: this.username,
                atlasRuntime: this.atlasRuntime,
            }), 'utf-8');
        } catch { /* ignore */ }
    }

    /** 删除持久化文件 */
    private clearSavedToken(): void {
        if (!this.tokenFile) return;
        try {
            if (existsSync(this.tokenFile)) {
                unlinkSync(this.tokenFile);
            }
        } catch { /* ignore */ }
    }

    /** 登录 OpenFlux */
    async login(username: string, password: string): Promise<{ success: boolean; message?: string }> {
        try {
            const resp = await fetch(`${this.config.apiUrl}/v1/auth/login`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: new URLSearchParams({ username, password }),
            });

            if (!resp.ok) {
                const errText = await resp.text();
                log.error('Login failed', { status: resp.status, body: errText });
                return { success: false, message: `HTTP ${resp.status}: ${errText}` };
            }

            const data = await resp.json();
            this.token = data.access_token || data.token;
            this.username = username;

            if (!this.token) {
                return { success: false, message: '响应中无 token' };
            }

            // 登录成功后自动获取 user_info（含 atlas runtime 配置）
            await this.fetchUserInfo();

            // 持久化登录态（含 atlas runtime）
            this.saveToken();

            log.info('OpenFlux login successful', { username, hasAtlasRuntime: !!this.atlasRuntime });
            return { success: true };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            log.error('OpenFlux login error', { error: msg });
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
            log.info(`Closing chatroom connection: ${chatroomId}`);
        }
        this.connections.clear();
        this.token = null;
        this.username = null;
        // 清除持久化文件
        this.clearSavedToken();
        log.info('OpenFlux logged out');
    }

    /** 获取登录状态 */
    getStatus(): { loggedIn: boolean; username?: string } {
        return {
            loggedIn: !!this.token,
            username: this.username || undefined,
        };
    }

    /** 获取当前 access_token（atlas_managed 模式使用） */
    getToken(): string | null {
        return this.token;
    }

    /** 获取 Atlas 下发的 OpenFlux 运行时配置 */
    getAtlasRuntime(): AtlasOpenFluxRuntime | null {
        return this.atlasRuntime;
    }

    /**
     * 调用 GET /v1/auth/user_info 获取 atlas_openflux_runtime
     * V2 文档要求：登录后必须调用此接口
     */
    async fetchUserInfo(): Promise<void> {
        if (!this.token) return;
        try {
            const resp = await fetch(`${this.config.apiUrl}/v1/auth/user_info`, {
                method: 'GET',
                headers: this.getAuthHeaders(),
            });
            if (!resp.ok) {
                log.warn('fetchUserInfo failed', { status: resp.status });
                return;
            }
            const result = await resp.json() as any;
            const runtime = result?.data?.atlas_openflux_runtime;
            if (runtime?.chat) {
                this.atlasRuntime = runtime as AtlasOpenFluxRuntime;
                log.info('Fetched atlas_openflux_runtime', {
                    chat_protocol: runtime.chat.protocol,
                    chat_model: runtime.chat.model_name,
                    embedding_protocol: runtime.embedding?.protocol,
                });
                // 更新持久化文件
                this.saveToken();
            } else {
                log.info('user_info has no atlas_openflux_runtime (user may not have Atlas access)');
                this.atlasRuntime = null;
            }
        } catch (err) {
            log.warn('fetchUserInfo error', { error: err instanceof Error ? err.message : String(err) });
        }
    }

    /** 获取当前 token（内部使用） */
    private getAuthHeaders(): Record<string, string> {
        if (!this.token) throw new Error('Not logged in to OpenFlux');
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
            throw new Error(`Failed to get Agent list: HTTP ${resp.status}`);
        }

        const result = await resp.json();
        const list = result.data?.list || result.data || [];

        const mapped = list.map((item: any) => ({
            agentId: item.agent_id,
            appId: item.app_id,
            name: item.name || item.agent_name || `Agent ${item.agent_id}`,
            description: item.description || item.agent_description || '',
            chatroomId: item.agent_chatroom_id || 0,
            avatar: item.avatar || '',
        }));

        // 按 appId 去重（API 可能返回重复记录）
        const seen = new Set<number>();
        return mapped.filter((a: OpenFluxAgent) => {
            if (seen.has(a.appId)) return false;
            seen.add(a.appId);
            return true;
        });
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
            log.warn('Failed to get chat history', { chatroomId, status: resp.status });
            return [];
        }

        const result = await resp.json();
        const list = result.data?.list || result.data || [];

        return list.map((item: any) => ({
            role: item.role === 'agent' || item.role === 'assistant' ? 'assistant' as const : 'user' as const,
            content: stripInstructionMarkers(item.content || item.message || ''),
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
        if (!this.token) throw new Error('Not logged in to OpenFlux');

        return new Promise<string>((resolve, reject) => {
            const request = { message, onProgress, resolve, reject };

            let conn = this.connections.get(chatroomId);

            if (conn && conn.ws.readyState === WebSocket.OPEN) {
                if (conn.busy) {
                    // 同聊天室排队
                    conn.queue.push(request);
                    log.info(`Chatroom ${chatroomId} busy, queued (queue length: ${conn.queue.length})`);
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

        // 心跳保活：每 30 秒发送 ping，防止服务端因空闲关闭连接
        const pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                try { ws.ping(); } catch { /* ignore */ }
            }
        }, 30_000);

        ws.on('open', () => {
            log.info(`WebSocket connected: chatroom ${chatroomId}`);
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
            log.error(`WebSocket connection error: chatroom ${chatroomId}`, { error });
            clearInterval(pingInterval);
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
            log.info(`WebSocket connection closed: chatroom ${chatroomId}`);
            clearInterval(pingInterval);
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

        // 设置超时（15 分钟，云端 Agent 使用 MCP 工具可能需要较长时间）
        chatTimeout = setTimeout(() => {
            cleanup();
            reject(new Error('Chat timed out (15 minutes)'));
            this.processNextInQueue(conn);
        }, 15 * 60 * 1000);

        const cleanup = () => {
            conn.ws.removeListener('message', messageHandler);
            conn.currentRequest = null;
            if (chatTimeout) {
                clearTimeout(chatTimeout);
                chatTimeout = null;
            }
        };

        const messageHandler = (data: WebSocket.Data) => {
            const raw = data.toString();
            if (!raw.trim()) return;

            // 解析协议指令（兼容 NEXUSAI-INSTRUCTION 和 OpenFlux-INSTRUCTION）
            // 一条消息中可能包含多个指令和文本片段，需逐段解析
            const instructionRegex = /--(?:NEXUSAI|OpenFlux)-INSTRUCTION-(\[.*?\])--/g;
            let hasInstruction = false;
            let lastIndex = 0;
            let m: RegExpExecArray | null;

            while ((m = instructionRegex.exec(raw)) !== null) {
                hasInstruction = true;
                // 指令前面如果有文本，算作 AI 回复片段
                if (m.index > lastIndex) {
                    const textBefore = raw.slice(lastIndex, m.index);
                    if (textBefore.trim()) {
                        fullReply.push(textBefore);
                        onProgress({ type: 'token', token: textBefore });
                    }
                }
                lastIndex = m.index + m[0].length;

                try {
                    const instruction = JSON.parse(m[1]);
                    const cmd = instruction[0];
                    const cmdData = instruction.length > 1 ? instruction[1] : null;
                    log.info(`WS command: ${cmd}`, { chatroomId: conn.chatroomId });

                    this.handleInstruction(cmd, cmdData, onProgress, fullReply, () => {
                        // ENDCHAT 回调：聊天结束
                        log.info('ENDCHAT received, resolving Promise', {
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
                    log.warn('Failed to parse command', { raw: raw.slice(0, 200) });
                }
            }

            if (!hasInstruction) {
                // 纯文本流 — AI 回复片段（保留换行符以保持 Markdown 格式）
                fullReply.push(raw);
                onProgress({ type: 'token', token: raw });
            } else if (lastIndex < raw.length) {
                // 最后一段指令后面的文本
                const trailing = raw.slice(lastIndex);
                if (trailing.trim()) {
                    fullReply.push(trailing);
                    onProgress({ type: 'token', token: trailing });
                }
            }
        };

        conn.ws.on('message', messageHandler);

        // 发送消息
        log.info(`Sending message to chatroom ${conn.chatroomId}`, { message: message.slice(0, 100) });
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
            case 'OK':
                // ENTER/ISDESKTOP/MCPTOOLLIST/SETABILITY/FILELIST 的确认响应（忽略）
                break;

            case 'CHAT':
                // 用户消息确认（不需要推送给客户端）
                break;

            case 'WITHFILELIST':
                // 用户发送的文件详情列表（桌面端暂不处理文件展示）
                break;

            case 'WITHFILECONTENTLIST':
                // Agent 发送的文件/图片列表（桌面端暂不处理）
                if (data && Array.isArray(data) && data.length > 0) {
                    log.info('Agent sent files', { count: data.length });
                }
                break;

            case 'REPLY':
                // Agent 即将开始回复（data = Agent ID）
                onProgress({ type: 'iteration', description: `Agent ${data} 开始回复` });
                break;

            case 'ABILITY':
                // Agent 本次回复使用的能力（data = 能力 ID，桌面端忽略）
                break;

            case 'TEXT':
                // Agent 即将发送纯文本（桌面端新建文本气泡，文本通过纯文本流接收）
                break;

            case 'ENDREPLY':
                // Agent 回复结束（data = Agent ID）
                break;

            case 'ENDCHAT':
                // 本轮聊天完整结束
                onEndChat();
                break;

            case 'MCPTOOLUSE':
                // MCP 工具调用（含技能/工作流）
                onProgress({
                    type: 'tool_start',
                    tool: data?.name || 'mcp_tool',
                    args: data?.args || data,
                    description: `调用工具: ${data?.skill_or_workflow_name || data?.name || 'unknown'}`,
                });
                break;

            case 'WITHMCPTOOLFILES':
                // 用户补充文件确认（技能/工作流）
                break;

            case 'WITHWFSTATUS':
                // 工作流执行状态更新
                if (data?.status) {
                    log.info('Workflow status', { id: data.id, status: data.status.status });
                }
                break;

            case 'WITHMCPTOOLRESULT':
                // MCP 工具执行结果
                onProgress({
                    type: 'tool_result',
                    tool: `tool_${data?.id || 'unknown'}`,
                    result: data?.result || data,
                });
                break;

            case 'STOPPABLE':
                // 本轮聊天是否可停止（忽略）
                break;

            case 'TITLE':
                // 聊天室标题更新（桌面端可用于更新会话标题）
                if (data) {
                    log.info('Chat title received', { title: data });
                }
                break;

            case 'TRUNCATABLE':
                // 是否可清除聊天室记忆（忽略）
                break;

            case 'TRUNCATEOK':
                // 清除记忆成功确认（忽略）
                break;

            case 'THINKING':
                // 思考模式状态（忽略）
                break;

            case 'IMGGEN':
                // 图片生成模式状态（忽略）
                break;

            case 'ERROR':
                log.error('OpenFlux chat error', { data });
                onError();
                break;

            default:
                log.warn(`Unknown NexusAI command: ${cmd}`, { data });
                break;
        }
    }

    /** 处理队列中的下一个请求 */
    private processNextInQueue(conn: ChatroomConnection): void {
        conn.busy = false;

        if (conn.queue.length > 0) {
            const next = conn.queue.shift()!;
            log.info(`Processing next queued request (remaining: ${conn.queue.length})`);
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
