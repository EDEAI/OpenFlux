/**
 * CollaborationManager - Multi-Agent collaboration manager
 * Manage the lifecycle and inter-agent communication of collaboration sessions
 */

import { randomUUID } from 'crypto';
import { Logger } from '../utils/logger';

const log = new Logger('Collaboration');

// ========================
// type definition
// ========================

/** Messages in collaborative sessions */
export interface CollabMessage {
    id: string;
    /** Sender identification (Agent ID or session ID) */
    from: string;
    /** Receiver ID */
    to: string;
    /** Message content */
    content: string;
    timestamp: number;
    /** Whether it has been read */
    read: boolean;
}

/** Collaboration sessions */
export interface CollaborationSession {
    /** Collaboration session ID */
    id: string;
    /** Parent session ID (initiator's session) */
    parentSessionId?: string;
    /** Agent ID that performs this task */
    agentId: string;
    /** Agent type */
    agentType?: 'builtin' | 'user';
    /** Task description */
    task: string;
    /** Session mode: run=one-time session=persistent (multiple rounds) */
    mode: 'run' | 'session';
    /** Session state */
    status: 'running' | 'completed' | 'failed' | 'timeout' | 'idle';
    /** Start time */
    startTime: number;
    /** end time */
    endTime?: number;
    /** Output results */
    output?: string;
    /** error message */
    error?: string;
    /** Inter-Agent message queue */
    messages: CollabMessage[];
}

/** spawn parameter */
export interface CollabSpawnParams {
    /** Target Agent ID */
    agentId: string;
    /** Task description */
    task: string;
    /** Timeout seconds (default 300) */
    timeout?: number;
    /** Parent session ID */
    parentSessionId?: string;
    /** Whether to wait for the result (default false, asynchronous) */
    waitForResult?: boolean;
    /** Session mode: run=one-time session=persistent multiple rounds (default run) */
    mode?: 'run' | 'session';
}

/** spawn result */
export interface CollabSpawnResult {
    /** Collaboration session ID */
    sessionId: string;
    /** If waiting synchronously, contains the execution result */
    status: 'spawned' | 'completed' | 'failed' | 'timeout';
    output?: string;
    error?: string;
    duration?: number;
}

/** Single task of batch spawning */
export interface CollabBatchTask {
    /** Target Agent ID */
    agentId: string;
    /** Task description */
    task: string;
    /** Task label (used for identification when summarizing results) */
    label?: string;
}

/** Batch spawn parameters */
export interface CollabBatchParams {
    /** Task list */
    tasks: CollabBatchTask[];
    /** Timeout seconds */
    timeout?: number;
    /** Whether to wait for all completions (default false, asynchronous) */
    waitForAll?: boolean;
}

/** Batch spawn results */
export interface CollabBatchResult {
    /** All collaboration session IDs */
    sessionIds: string[];
    /** If waiting synchronously, include the results of each task */
    results?: CollabSpawnResult[];
    /** Summary */
    summary?: {
        total: number;
        completed: number;
        failed: number;
        timeout: number;
    };
}

/** waitAll result */
export interface CollabWaitAllResult {
    /** Results of each session */
    results: Array<{
        sessionId: string;
        agentId: string;
        label?: string;
        status: string;
        output?: string;
        error?: string;
        duration?: number;
    }>;
    /** Summary */
    summary: {
        total: number;
        completed: number;
        failed: number;
        timeout: number;
        totalDuration: number;
    };
}

/** Unified Agent information (built-in + user-defined) */
export interface CollabAgentInfo {
    id: string;
    name: string;
    type: 'builtin' | 'user';
    description?: string;
}

/** Agent execution function signature (provided by AgentManager) */
export type AgentExecutor = (agentId: string, task: string, sessionId?: string, agentType?: 'builtin' | 'user') => Promise<{
    output: string;
    agentId: string;
}>;

/** Collaboration session completion callback */
export type CollabSessionCompleteCallback = (session: CollaborationSession) => void;

// ========================
// CollaborationManager
// ========================

export class CollaborationManager {
    /** All collaboration sessions */
    private sessions = new Map<string, CollaborationSession>();
    /** Agent execution function (injected by AgentManager) */
    private executor: AgentExecutor | null = null;
    /** Available Agent information query (built-in + user) */
    private getAvailableAgentInfos: (() => CollabAgentInfo[]) | null = null;
    /** Maximum concurrent collaboration sessions */
    private maxConcurrent: number;
    /** Session completion callback (announce) */
    private onCompleteCallback: CollabSessionCompleteCallback | null = null;

    constructor(options?: { maxConcurrent?: number }) {
        this.maxConcurrent = options?.maxConcurrent || 10;
    }

    /**
     * Inject Agent executor
     * Called after AgentManager is initialized
     */
    setExecutor(executor: AgentExecutor): void {
        this.executor = executor;
    }

    /**
     * Inject available Agent query function (supports built-in + user Agent)
     */
    setAgentProvider(fn: () => CollabAgentInfo[]): void {
        this.getAvailableAgentInfos = fn;
    }

    /**
     * Register session completion callback (announce mechanism)
     */
    setOnComplete(fn: CollabSessionCompleteCallback): void {
        this.onCompleteCallback = fn;
    }

    /**
     * Get all available Agent information (for system prompt injection)
     */
    getAgentInfos(): CollabAgentInfo[] {
        return this.getAvailableAgentInfos?.() || [];
    }

    /**
     * Create collaboration sessions (sessions_spawn)
     */
    async spawn(params: CollabSpawnParams): Promise<CollabSpawnResult> {
        if (!this.executor) {
            throw new Error('Agent executor not initialized');
        }

        // Verify whether the target Agent exists (check both built-in and user Agents)
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

        // Check concurrency limits
        const runningCount = this.getRunningCount();
        if (runningCount >= this.maxConcurrent) {
            throw new Error(`Maximum concurrent collaboration sessions reached (${this.maxConcurrent})`);
        }

        const sessionId = `collab-${randomUUID().slice(0, 8)}`;
        const timeout = params.timeout || 300;
        const mode = params.mode || 'run';

        // Create a collaboration session
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

        // Build execution Promise
        const executePromise = this.executeWithTimeout(sessionId, params.agentId, params.task, timeout, agentType);

        if (params.waitForResult) {
            // Synchronous mode: wait for completion
            const result = await executePromise;
            return result;
        }

        // Asynchronous mode: background execution, return immediately
        executePromise.catch((err) => {
            log.error(`Collaboration session async execution failed: ${sessionId}`, { error: err });
        });

        return {
            sessionId,
            status: 'spawned',
        };
    }

    /**
     * Resume persistent session (multiple rounds of follow-up)
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

        // Append message to history
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
     * Send a message to a collaboration session
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
     * Get a collaboration session
     */
    getSession(sessionId: string): CollaborationSession | undefined {
        return this.sessions.get(sessionId);
    }

    /**
     * List all active collaboration sessions
     */
    listActive(): CollaborationSession[] {
        return Array.from(this.sessions.values()).filter(s => s.status === 'running');
    }

    /**
     * List all collaboration sessions (including completed ones)
     */
    listAll(): CollaborationSession[] {
        return Array.from(this.sessions.values());
    }

    /**
     * Get messages from a collaboration session
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
     * Get the number of running sessions
     */
    getRunningCount(): number {
        return Array.from(this.sessions.values()).filter(s => s.status === 'running').length;
    }

    /**
     * Create collaboration sessions in batches (sessions_spawn batch mode)
     */
    async spawnBatch(params: CollabBatchParams): Promise<CollabBatchResult> {
        if (!this.executor) {
            throw new Error('Agent executor not initialized');
        }

        const timeout = params.timeout || 300;
        const sessionIds: string[] = [];
        const spawnPromises: Promise<CollabSpawnResult>[] = [];

        // Create all collaboration sessions in parallel
        for (const task of params.tasks) {
            const result = this.spawn({
                agentId: task.agentId,
                task: task.task,
                timeout,
                waitForResult: false, // Start all asynchronously first
            });
            spawnPromises.push(result);
        }

        const spawnResults = await Promise.all(spawnPromises);
        for (const r of spawnResults) {
            sessionIds.push(r.sessionId);
            // Store label in session metadata
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

        // Wait for all to complete
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
     * Wait for multiple collaboration sessions to complete
     */
    async waitAll(sessionIds: string[], timeoutSec: number = 300): Promise<CollabWaitAllResult> {
        const startTime = Date.now();
        const timeoutMs = timeoutSec * 1000;

        log.info(`Waiting for ${sessionIds.length} collaboration sessions to complete`, { sessionIds });

        // poll wait
        while (true) {
            const allDone = sessionIds.every(id => {
                const session = this.sessions.get(id);
                return session && session.status !== 'running';
            });

            if (allDone) break;

            // timeout check
            if (Date.now() - startTime > timeoutMs) {
                log.warn('waitAll timed out, some sessions incomplete');
                break;
            }

            // Wait 500ms and check again
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        // Collect results
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
     * Clean up completed sessions (more than specified time)
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
    // internal method
    // ========================

    /**
     * Execution with timeout
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

            // Update session status: session mode -> idle, run mode -> completed
            session.status = session.mode === 'session' ? 'idle' : 'completed';
            session.endTime = Date.now();
            session.output = result.output;

            // Append results to message history
            session.messages.push({
                id: randomUUID().slice(0, 8),
                from: agentId,
                to: 'requester',
                content: result.output,
                timestamp: Date.now(),
                read: false,
            });

            log.info(`Collaboration session completed: ${sessionId}`, { agentId, duration, mode: session.mode });

            // Trigger announce callback
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

            // Failure also triggers the announce callback
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

// Default singleton
let defaultCollabManager: CollaborationManager | null = null;

export function getCollaborationManager(): CollaborationManager {
    if (!defaultCollabManager) {
        defaultCollabManager = new CollaborationManager();
    }
    return defaultCollabManager;
}
