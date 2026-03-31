/**
 * CollaborationManager - 多 Agent 协作管理器
 * 管理协作会话的生命周期和 Agent 间通信
 */

import { randomUUID } from 'crypto';
import { Logger } from '../utils/logger';

const log = new Logger('Collaboration');

// ========================
// 类型定义
// ========================

/** 协作会话中的消息 */
export interface CollabMessage {
    id: string;
    /** 发送方标识（Agent ID 或 session ID） */
    from: string;
    /** 接收方标识 */
    to: string;
    /** 消息内容 */
    content: string;
    timestamp: number;
    /** 是否已读 */
    read: boolean;
}

/** 协作会话 */
export interface CollaborationSession {
    /** 协作会话 ID */
    id: string;
    /** 父会话 ID（发起方的会话） */
    parentSessionId?: string;
    /** 执行该任务的 Agent ID */
    agentId: string;
    /** Agent 类型 */
    agentType?: 'builtin' | 'user';
    /** 任务描述 */
    task: string;
    /** 会话模式：run=一次性  session=持久（多轮） */
    mode: 'run' | 'session';
    /** 会话状态 */
    status: 'running' | 'completed' | 'failed' | 'timeout' | 'idle';
    /** 开始时间 */
    startTime: number;
    /** 结束时间 */
    endTime?: number;
    /** 输出结果 */
    output?: string;
    /** 错误信息 */
    error?: string;
    /** Agent 间消息队列 */
    messages: CollabMessage[];
}

/** spawn 参数 */
export interface CollabSpawnParams {
    /** 目标 Agent ID */
    agentId: string;
    /** 任务描述 */
    task: string;
    /** 超时秒数（默认 300） */
    timeout?: number;
    /** 父会话 ID */
    parentSessionId?: string;
    /** 是否等待结果（默认 false，异步） */
    waitForResult?: boolean;
    /** 会话模式：run=一次性  session=持久多轮（默认 run） */
    mode?: 'run' | 'session';
}

/** spawn 结果 */
export interface CollabSpawnResult {
    /** 协作会话 ID */
    sessionId: string;
    /** 如果同步等待，则包含执行结果 */
    status: 'spawned' | 'completed' | 'failed' | 'timeout';
    output?: string;
    error?: string;
    duration?: number;
}

/** 批量 spawn 的单个任务 */
export interface CollabBatchTask {
    /** 目标 Agent ID */
    agentId: string;
    /** 任务描述 */
    task: string;
    /** 任务标签（用于结果汇总时标识） */
    label?: string;
}

/** 批量 spawn 参数 */
export interface CollabBatchParams {
    /** 任务列表 */
    tasks: CollabBatchTask[];
    /** 超时秒数 */
    timeout?: number;
    /** 是否等待全部完成（默认 false，异步） */
    waitForAll?: boolean;
}

/** 批量 spawn 结果 */
export interface CollabBatchResult {
    /** 所有协作会话 ID */
    sessionIds: string[];
    /** 如果同步等待，则包含各任务结果 */
    results?: CollabSpawnResult[];
    /** 汇总 */
    summary?: {
        total: number;
        completed: number;
        failed: number;
        timeout: number;
    };
}

/** waitAll 结果 */
export interface CollabWaitAllResult {
    /** 各会话结果 */
    results: Array<{
        sessionId: string;
        agentId: string;
        label?: string;
        status: string;
        output?: string;
        error?: string;
        duration?: number;
    }>;
    /** 汇总 */
    summary: {
        total: number;
        completed: number;
        failed: number;
        timeout: number;
        totalDuration: number;
    };
}

/** 统一 Agent 信息（内置 + 用户自定义） */
export interface CollabAgentInfo {
    id: string;
    name: string;
    type: 'builtin' | 'user';
    description?: string;
}

/** Agent 执行函数签名（由 AgentManager 提供） */
export type AgentExecutor = (agentId: string, task: string, sessionId?: string, agentType?: 'builtin' | 'user') => Promise<{
    output: string;
    agentId: string;
}>;

/** 协作会话完成回调 */
export type CollabSessionCompleteCallback = (session: CollaborationSession) => void;

// ========================
// CollaborationManager
// ========================

export class CollaborationManager {
    /** 所有协作会话 */
    private sessions = new Map<string, CollaborationSession>();
    /** Agent 执行函数（由 AgentManager 注入） */
    private executor: AgentExecutor | null = null;
    /** 可用的 Agent 信息查询（内置 + 用户） */
    private getAvailableAgentInfos: (() => CollabAgentInfo[]) | null = null;
    /** 最大并发协作会话 */
    private maxConcurrent: number;
    /** 会话完成回调（announce） */
    private onCompleteCallback: CollabSessionCompleteCallback | null = null;

    constructor(options?: { maxConcurrent?: number }) {
        this.maxConcurrent = options?.maxConcurrent || 10;
    }

    /**
     * 注入 Agent 执行器
     * 在 AgentManager 初始化后调用
     */
    setExecutor(executor: AgentExecutor): void {
        this.executor = executor;
    }

    /**
     * 注入可用 Agent 查询函数（支持内置 + 用户 Agent）
     */
    setAgentProvider(fn: () => CollabAgentInfo[]): void {
        this.getAvailableAgentInfos = fn;
    }

    /**
     * 注册会话完成回调（announce 机制）
     */
    setOnComplete(fn: CollabSessionCompleteCallback): void {
        this.onCompleteCallback = fn;
    }

    /**
     * 获取所有可用 Agent 信息（供系统提示注入）
     */
    getAgentInfos(): CollabAgentInfo[] {
        return this.getAvailableAgentInfos?.() || [];
    }

    /**
     * 创建协作会话（sessions_spawn）
     */
    async spawn(params: CollabSpawnParams): Promise<CollabSpawnResult> {
        if (!this.executor) {
            throw new Error('Agent executor not initialized');
        }

        // 验证目标 Agent 是否存在（同时查内置和用户 Agent）
        let agentType: 'builtin' | 'user' = 'builtin';
        if (this.getAvailableAgentInfos) {
            const available = this.getAvailableAgentInfos();
            const found = available.find(a => a.id === params.agentId);
            if (!found) {
                const ids = available.map(a => `${a.id}(${a.type})`).join(', ');
                throw new Error(
                    `Agent "${params.agentId}" does not exist. Available agents: ${ids}`
                );
            }
            agentType = found.type;
        }

        // 检查并发限制
        const runningCount = this.getRunningCount();
        if (runningCount >= this.maxConcurrent) {
            throw new Error(`Maximum concurrent collaboration sessions reached (${this.maxConcurrent})`);
        }

        const sessionId = `collab-${randomUUID().slice(0, 8)}`;
        const timeout = params.timeout || 300;
        const mode = params.mode || 'run';

        // 创建协作会话
        const session: CollaborationSession = {
            id: sessionId,
            parentSessionId: params.parentSessionId,
            agentId: params.agentId,
            agentType,
            task: params.task,
            mode,
            status: 'running',
            startTime: Date.now(),
            messages: [],
        };
        this.sessions.set(sessionId, session);

        log.info(`Creating collaboration session: ${sessionId}`, {
            agentId: params.agentId,
            agentType,
            mode,
            task: params.task.slice(0, 100),
            waitForResult: params.waitForResult,
        });

        // 构建执行 Promise
        const executePromise = this.executeWithTimeout(sessionId, params.agentId, params.task, timeout, agentType);

        if (params.waitForResult) {
            // 同步模式：等待完成
            const result = await executePromise;
            return result;
        }

        // 异步模式：后台执行，立即返回
        executePromise.catch((err) => {
            log.error(`Collaboration session async execution failed: ${sessionId}`, { error: err });
        });

        return {
            sessionId,
            status: 'spawned',
        };
    }

    /**
     * 恢复持久会话（多轮 follow-up）
     */
    async resume(params: {
        sessionId: string;
        message: string;
        timeout?: number;
    }): Promise<CollabSpawnResult> {
        if (!this.executor) {
            throw new Error('Agent executor not initialized');
        }

        const session = this.sessions.get(params.sessionId);
        if (!session) {
            throw new Error(`Collaboration session does not exist: ${params.sessionId}`);
        }
        if (session.mode !== 'session') {
            throw new Error(`Session ${params.sessionId} is not a persistent session (mode=${session.mode})`);
        }
        if (session.status === 'running') {
            throw new Error(`Session ${params.sessionId} is still running`);
        }
        if (session.status !== 'idle' && session.status !== 'completed') {
            throw new Error(`Session ${params.sessionId} cannot be resumed (status=${session.status})`);
        }

        // 追加消息到历史
        session.messages.push({
            id: randomUUID().slice(0, 8),
            from: 'requester',
            to: session.agentId,
            content: params.message,
            timestamp: Date.now(),
            read: false,
        });

        session.status = 'running';
        session.output = undefined;
        session.error = undefined;
        session.endTime = undefined;

        const timeout = params.timeout || 300;
        log.info(`Resuming collaboration session: ${params.sessionId}`, {
            agentId: session.agentId,
            message: params.message.slice(0, 100),
        });

        return this.executeWithTimeout(
            params.sessionId, session.agentId, params.message, timeout, session.agentType,
        );
    }

    /**
     * 发送消息到协作会话
     */
    send(params: {
        targetSessionId: string;
        message: string;
        fromAgentId?: string;
    }): CollabMessage {
        const session = this.sessions.get(params.targetSessionId);
        if (!session) {
            throw new Error(`Collaboration session does not exist: ${params.targetSessionId}`);
        }

        const msg: CollabMessage = {
            id: randomUUID().slice(0, 8),
            from: params.fromAgentId || 'main',
            to: session.agentId,
            content: params.message,
            timestamp: Date.now(),
            read: false,
        };

        session.messages.push(msg);
        log.info(`Message sent: ${params.fromAgentId || 'main'} -> ${session.agentId}`, {
            sessionId: params.targetSessionId,
        });

        return msg;
    }

    /**
     * 获取协作会话
     */
    getSession(sessionId: string): CollaborationSession | undefined {
        return this.sessions.get(sessionId);
    }

    /**
     * 列出所有活跃协作会话
     */
    listActive(): CollaborationSession[] {
        return Array.from(this.sessions.values()).filter(s => s.status === 'running');
    }

    /**
     * 列出所有协作会话（含已完成）
     */
    listAll(): CollaborationSession[] {
        return Array.from(this.sessions.values());
    }

    /**
     * 获取协作会话的消息
     */
    getMessages(sessionId: string, markAsRead = false): CollabMessage[] {
        const session = this.sessions.get(sessionId);
        if (!session) return [];

        if (markAsRead) {
            for (const msg of session.messages) {
                msg.read = true;
            }
        }

        return [...session.messages];
    }

    /**
     * 获取运行中的会话数量
     */
    getRunningCount(): number {
        return Array.from(this.sessions.values()).filter(s => s.status === 'running').length;
    }

    /**
     * 批量创建协作会话（sessions_spawn batch 模式）
     */
    async spawnBatch(params: CollabBatchParams): Promise<CollabBatchResult> {
        if (!this.executor) {
            throw new Error('Agent executor not initialized');
        }

        const timeout = params.timeout || 300;
        const sessionIds: string[] = [];
        const spawnPromises: Promise<CollabSpawnResult>[] = [];

        // 并行创建所有协作会话
        for (const task of params.tasks) {
            const result = this.spawn({
                agentId: task.agentId,
                task: task.task,
                timeout,
                waitForResult: false, // 先全部异步启动
            });
            spawnPromises.push(result);
        }

        const spawnResults = await Promise.all(spawnPromises);
        for (const r of spawnResults) {
            sessionIds.push(r.sessionId);
            // 将 label 存储到会话 metadata 中
            const idx = spawnResults.indexOf(r);
            const session = this.sessions.get(r.sessionId);
            if (session && params.tasks[idx]?.label) {
                (session as unknown as Record<string, unknown>)._label = params.tasks[idx].label;
            }
        }

        log.info(`Batch creating collaboration sessions: ${sessionIds.length}`, {
            agents: params.tasks.map(t => t.agentId),
        });

        if (!params.waitForAll) {
            return { sessionIds };
        }

        // 等待全部完成
        const waitResult = await this.waitAll(sessionIds, timeout);
        return {
            sessionIds,
            results: waitResult.results.map(r => ({
                sessionId: r.sessionId,
                status: r.status as CollabSpawnResult['status'],
                output: r.output,
                error: r.error,
                duration: r.duration,
            })),
            summary: waitResult.summary,
        };
    }

    /**
     * 等待多个协作会话全部完成
     */
    async waitAll(sessionIds: string[], timeoutSec: number = 300): Promise<CollabWaitAllResult> {
        const startTime = Date.now();
        const timeoutMs = timeoutSec * 1000;

        log.info(`Waiting for ${sessionIds.length} collaboration sessions to complete`, { sessionIds });

        // 轮询等待
        while (true) {
            const allDone = sessionIds.every(id => {
                const session = this.sessions.get(id);
                return session && session.status !== 'running';
            });

            if (allDone) break;

            // 超时检查
            if (Date.now() - startTime > timeoutMs) {
                log.warn('waitAll timed out, some sessions incomplete');
                break;
            }

            // 等待 500ms 再检查
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        // 收集结果
        const results = sessionIds.map(id => {
            const session = this.sessions.get(id);
            if (!session) {
                return {
                    sessionId: id,
                    agentId: 'unknown',
                    status: 'failed' as const,
                    error: '会话不存在',
                };
            }
            return {
                sessionId: id,
                agentId: session.agentId,
                label: (session as unknown as Record<string, unknown>)._label as string | undefined,
                status: session.status,
                output: session.output,
                error: session.error,
                duration: session.endTime ? session.endTime - session.startTime : Date.now() - session.startTime,
            };
        });

        const summary = {
            total: results.length,
            completed: results.filter(r => r.status === 'completed').length,
            failed: results.filter(r => r.status === 'failed').length,
            timeout: results.filter(r => r.status === 'timeout' || r.status === 'running').length,
            totalDuration: Date.now() - startTime,
        };

        log.info('waitAll completed', summary);

        return { results, summary };
    }

    /**
     * 清理已完成的会话（超过指定时间）
     */
    cleanup(maxAgeMs: number = 3600000): void {
        const now = Date.now();
        for (const [id, session] of this.sessions.entries()) {
            if (session.status !== 'running' && session.endTime && now - session.endTime > maxAgeMs) {
                this.sessions.delete(id);
            }
        }
    }

    // ========================
    // 内部方法
    // ========================

    /**
     * 带超时的执行
     */
    private async executeWithTimeout(
        sessionId: string,
        agentId: string,
        task: string,
        timeoutSec: number,
        agentType?: 'builtin' | 'user',
    ): Promise<CollabSpawnResult> {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return { sessionId, status: 'failed', error: 'Session does not exist' };
        }

        try {
            const timeoutMs = timeoutSec * 1000;
            const timeoutPromise = new Promise<never>((_, reject) => {
                setTimeout(() => reject(new Error('Execution timed out')), timeoutMs);
            });

            const executePromise = this.executor!(agentId, task, sessionId, agentType);

            const result = await Promise.race([executePromise, timeoutPromise]);
            const duration = Date.now() - session.startTime;

            // 更新会话状态：session 模式 → idle，run 模式 → completed
            session.status = session.mode === 'session' ? 'idle' : 'completed';
            session.endTime = Date.now();
            session.output = result.output;

            // 将结果追加到消息历史
            session.messages.push({
                id: randomUUID().slice(0, 8),
                from: agentId,
                to: 'requester',
                content: result.output,
                timestamp: Date.now(),
                read: false,
            });

            log.info(`Collaboration session completed: ${sessionId}`, { agentId, duration, mode: session.mode });

            // 触发 announce 回调
            if (this.onCompleteCallback) {
                try {
                    this.onCompleteCallback(session);
                } catch (err) {
                    log.error('onComplete callback error', { error: err });
                }
            }

            return {
                sessionId,
                status: 'completed',
                output: result.output,
                duration,
            };
        } catch (error) {
            const duration = Date.now() - session.startTime;
            const errorMsg = error instanceof Error ? error.message : String(error);
            const isTimeout = errorMsg === 'Execution timed out';

            session.status = isTimeout ? 'timeout' : 'failed';
            session.endTime = Date.now();
            session.error = errorMsg;

            log.error(`Collaboration session ${isTimeout ? 'timed out' : 'failed'}: ${sessionId}`, { error: errorMsg });

            // 失败也触发 announce 回调
            if (this.onCompleteCallback) {
                try {
                    this.onCompleteCallback(session);
                } catch (err) {
                    log.error('onComplete callback error', { error: err });
                }
            }

            return {
                sessionId,
                status: isTimeout ? 'timeout' : 'failed',
                error: errorMsg,
                duration,
            };
        }
    }
}

// 默认单例
let defaultCollabManager: CollaborationManager | null = null;

export function getCollaborationManager(): CollaborationManager {
    if (!defaultCollabManager) {
        defaultCollabManager = new CollaborationManager();
    }
    return defaultCollabManager;
}
