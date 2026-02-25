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
    /** 任务描述 */
    task: string;
    /** 会话状态 */
    status: 'running' | 'completed' | 'failed' | 'timeout';
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

/** Agent 执行函数签名（由 AgentManager 提供） */
export type AgentExecutor = (agentId: string, task: string, sessionId?: string) => Promise<{
    output: string;
    agentId: string;
}>;

// ========================
// CollaborationManager
// ========================

export class CollaborationManager {
    /** 所有协作会话 */
    private sessions = new Map<string, CollaborationSession>();
    /** Agent 执行函数（由 AgentManager 注入） */
    private executor: AgentExecutor | null = null;
    /** 可用的 Agent ID 列表查询 */
    private getAvailableAgents: (() => string[]) | null = null;
    /** 最大并发协作会话 */
    private maxConcurrent: number;

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
     * 注入可用 Agent 查询函数
     */
    setAgentProvider(fn: () => string[]): void {
        this.getAvailableAgents = fn;
    }

    /**
     * 创建协作会话（sessions_spawn）
     */
    async spawn(params: CollabSpawnParams): Promise<CollabSpawnResult> {
        if (!this.executor) {
            throw new Error('Agent 执行器未初始化');
        }

        // 验证目标 Agent 是否存在
        if (this.getAvailableAgents) {
            const available = this.getAvailableAgents();
            if (!available.includes(params.agentId)) {
                throw new Error(
                    `Agent "${params.agentId}" 不存在。可用 Agent: ${available.join(', ')}`
                );
            }
        }

        // 检查并发限制
        const runningCount = this.getRunningCount();
        if (runningCount >= this.maxConcurrent) {
            throw new Error(`已达到最大并发协作会话数 (${this.maxConcurrent})`);
        }

        const sessionId = `collab-${randomUUID().slice(0, 8)}`;
        const timeout = params.timeout || 300;

        // 创建协作会话
        const session: CollaborationSession = {
            id: sessionId,
            parentSessionId: params.parentSessionId,
            agentId: params.agentId,
            task: params.task,
            status: 'running',
            startTime: Date.now(),
            messages: [],
        };
        this.sessions.set(sessionId, session);

        log.info(`创建协作会话: ${sessionId}`, {
            agentId: params.agentId,
            task: params.task.slice(0, 100),
            waitForResult: params.waitForResult,
        });

        // 构建执行 Promise
        const executePromise = this.executeWithTimeout(sessionId, params.agentId, params.task, timeout);

        if (params.waitForResult) {
            // 同步模式：等待完成
            const result = await executePromise;
            return result;
        }

        // 异步模式：后台执行，立即返回
        executePromise.catch((err) => {
            log.error(`协作会话异步执行失败: ${sessionId}`, { error: err });
        });

        return {
            sessionId,
            status: 'spawned',
        };
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
            throw new Error(`协作会话不存在: ${params.targetSessionId}`);
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
        log.info(`消息发送: ${params.fromAgentId || 'main'} -> ${session.agentId}`, {
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
            throw new Error('Agent 执行器未初始化');
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

        log.info(`批量创建协作会话: ${sessionIds.length} 个`, {
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

        log.info(`等待 ${sessionIds.length} 个协作会话完成`, { sessionIds });

        // 轮询等待
        while (true) {
            const allDone = sessionIds.every(id => {
                const session = this.sessions.get(id);
                return session && session.status !== 'running';
            });

            if (allDone) break;

            // 超时检查
            if (Date.now() - startTime > timeoutMs) {
                log.warn('waitAll 超时，部分会话未完成');
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

        log.info('waitAll 完成', summary);

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
    ): Promise<CollabSpawnResult> {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return { sessionId, status: 'failed', error: '会话不存在' };
        }

        try {
            const timeoutMs = timeoutSec * 1000;
            const timeoutPromise = new Promise<never>((_, reject) => {
                setTimeout(() => reject(new Error('执行超时')), timeoutMs);
            });

            const executePromise = this.executor!(agentId, task, sessionId);

            const result = await Promise.race([executePromise, timeoutPromise]);
            const duration = Date.now() - session.startTime;

            // 更新会话状态
            session.status = 'completed';
            session.endTime = Date.now();
            session.output = result.output;

            log.info(`协作会话完成: ${sessionId}`, { agentId, duration });

            return {
                sessionId,
                status: 'completed',
                output: result.output,
                duration,
            };
        } catch (error) {
            const duration = Date.now() - session.startTime;
            const errorMsg = error instanceof Error ? error.message : String(error);
            const isTimeout = errorMsg === '执行超时';

            session.status = isTimeout ? 'timeout' : 'failed';
            session.endTime = Date.now();
            session.error = errorMsg;

            log.error(`协作会话${isTimeout ? '超时' : '失败'}: ${sessionId}`, { error: errorMsg });

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
