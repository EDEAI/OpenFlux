/**
 * sessions_send 工具 - Agent 间通信
 * 支持查询协作会话状态、发送消息、读取回复、等待多会话完成
 */

import type { Tool, ToolResult, ToolParameter } from './types';
import { jsonResult, errorResult, readStringParam, readNumberParam, textResult } from './common';
import type { CollaborationManager } from '../agent/collaboration';
import { Logger } from '../utils/logger';

const log = new Logger('SessionsSend');

/** sessions_send 工具选项 */
export interface SessionsSendToolOptions {
    /** CollaborationManager 实例 */
    collaborationManager: CollaborationManager;
}

const ACTIONS = ['send', 'list', 'status', 'read', 'waitAll', 'resume'] as const;

/**
 * 创建 sessions_send 工具
 */
export function createSessionsSendTool(options: SessionsSendToolOptions): Tool {
    const collab = options.collaborationManager;

    const parameters: Record<string, ToolParameter> = {
        action: {
            type: 'string',
            description: 'Action type: send | list | status | read | waitAll | resume (resume a persistent session for follow-up)',
            required: true,
            enum: [...ACTIONS],
        },
        targetSession: {
            type: 'string',
            description: 'Target collaborative session ID (required for send/status/read)',
            required: false,
        },
        message: {
            type: 'string',
            description: 'Message content to send (required for send)',
            required: false,
        },
        sessionIds: {
            type: 'array',
            description: 'Collaborative session ID list (required for waitAll)',
            required: false,
            items: { type: 'string' },
        },
        timeout: {
            type: 'number',
            description: 'Wait timeout in seconds (optional for waitAll, default 300)',
            required: false,
            default: 300,
        },
    };

    return {
        name: 'sessions_send',
        priority: 45,
        description: [
            'Inter-Agent communication tool for managing collaborative sessions.',
            'Action descriptions:',
            '- send: Send a message to a collaborative session',
            '- list: List all collaborative sessions and their statuses',
            '- status: Query detailed status and results of a specific session',
            '- read: Read message history from a specific session',
            '- waitAll: Wait for multiple sessions to complete and return aggregated results',
            '- resume: Send a follow-up message to a persistent session (mode="session"), triggering the agent to respond with context',
        ].join('\n'),
        parameters,

        async execute(args: Record<string, unknown>): Promise<ToolResult> {
            try {
                const action = readStringParam(args, 'action', { required: true });

                switch (action) {
                    case 'send':
                        return handleSend(collab, args);
                    case 'list':
                        return handleList(collab);
                    case 'status':
                        return handleStatus(collab, args);
                    case 'read':
                        return handleRead(collab, args);
                    case 'waitAll':
                        return await handleWaitAll(collab, args);
                    case 'resume':
                        return await handleResume(collab, args);
                    default:
                        return errorResult(`Unknown action: ${action}. Supported: ${ACTIONS.join(', ')}`);
                }
            } catch (error) {
                return errorResult(error instanceof Error ? error.message : String(error));
            }
        },
    };
}

/**
 * 发送消息
 */
function handleSend(collab: CollaborationManager, args: Record<string, unknown>): ToolResult {
    const targetSession = readStringParam(args, 'targetSession', { required: true });
    const message = readStringParam(args, 'message', { required: true });

    const msg = collab.send({
        targetSessionId: targetSession,
        message,
    });

    return jsonResult({
        status: 'sent',
        messageId: msg.id,
        to: msg.to,
        timestamp: new Date(msg.timestamp).toISOString(),
    });
}

/**
 * 列出协作会话
 */
function handleList(collab: CollaborationManager): ToolResult {
    const all = collab.listAll();

    if (all.length === 0) {
        return textResult('No collaborative sessions currently.');
    }

    const sessions = all.map(s => ({
        sessionId: s.id,
        agentId: s.agentId,
        task: s.task.length > 80 ? s.task.slice(0, 77) + '...' : s.task,
        status: s.status,
        duration: s.endTime
            ? `${((s.endTime - s.startTime) / 1000).toFixed(1)}s`
            : `${((Date.now() - s.startTime) / 1000).toFixed(1)}s (running)`,
        messageCount: s.messages.length,
    }));

    return jsonResult({
        total: all.length,
        running: all.filter(s => s.status === 'running').length,
        sessions,
    });
}

/**
 * 查询会话状态
 */
function handleStatus(collab: CollaborationManager, args: Record<string, unknown>): ToolResult {
    const targetSession = readStringParam(args, 'targetSession', { required: true });
    const session = collab.getSession(targetSession);

    if (!session) {
        return errorResult(`Collaborative session not found: ${targetSession}`);
    }

    const statusText: Record<string, string> = {
        running: '⏳ Running',
        completed: '✅ Completed',
        failed: '❌ Failed',
        timeout: '⏰ Timeout',
        idle: '🟢 Idle (awaiting follow-up)',
    };

    const result: Record<string, unknown> = {
        sessionId: session.id,
        agentId: session.agentId,
        task: session.task,
        status: statusText[session.status] || session.status,
        startTime: new Date(session.startTime).toISOString(),
        duration: session.endTime
            ? `${((session.endTime - session.startTime) / 1000).toFixed(1)}s`
            : `${((Date.now() - session.startTime) / 1000).toFixed(1)}s (running)`,
        messageCount: session.messages.length,
        unreadCount: session.messages.filter(m => !m.read).length,
    };

    if (session.output) {
        result.output = session.output;
    }
    if (session.error) {
        result.error = session.error;
    }

    return jsonResult(result);
}

/**
 * 读取消息
 */
function handleRead(collab: CollaborationManager, args: Record<string, unknown>): ToolResult {
    const targetSession = readStringParam(args, 'targetSession', { required: true });
    const messages = collab.getMessages(targetSession, true); // 标记已读

    if (messages.length === 0) {
        const session = collab.getSession(targetSession);
        if (!session) {
            return errorResult(`Collaborative session not found: ${targetSession}`);
        }

        // 没有消息但会话已完成，返回结果
        if (session.status !== 'running') {
            return jsonResult({
                sessionId: targetSession,
                status: session.status,
                output: session.output,
                error: session.error,
                messages: [],
            });
        }

        return textResult(`Collaborative session ${targetSession} has no messages yet, Agent "${session.agentId}" is executing...`);
    }

    return jsonResult({
        sessionId: targetSession,
        messages: messages.map(m => ({
            id: m.id,
            from: m.from,
            to: m.to,
            content: m.content,
            time: new Date(m.timestamp).toISOString(),
        })),
    });
}

/**
 * 等待多个协作会话全部完成
 */
async function handleWaitAll(collab: CollaborationManager, args: Record<string, unknown>): Promise<ToolResult> {
    const sessionIdsRaw = args.sessionIds;
    if (!sessionIdsRaw || !Array.isArray(sessionIdsRaw) || sessionIdsRaw.length === 0) {
        return errorResult('waitAll requires sessionIds parameter (collaborative session ID array)');
    }

    const sessionIds = sessionIdsRaw.map(String);
    const timeout = readNumberParam(args, 'timeout') || 300;

    log.info(`waitAll: ${sessionIds.length} sessions, timeout=${timeout}s`);

    const result = await collab.waitAll(sessionIds, timeout);

    return jsonResult({
        summary: {
            total: result.summary.total,
            completed: `${result.summary.completed}/${result.summary.total}`,
            failed: result.summary.failed,
            timeout: result.summary.timeout,
            totalDuration: `${(result.summary.totalDuration / 1000).toFixed(1)}s`,
        },
        results: result.results.map(r => ({
            sessionId: r.sessionId,
            agentId: r.agentId,
            label: r.label,
            status: r.status,
            output: r.output?.slice(0, 500), // 截断避免过长
            error: r.error,
            duration: r.duration ? `${(r.duration / 1000).toFixed(1)}s` : undefined,
        })),
    });
}

/**
 * 恢复持久会话（多轮 follow-up）
 */
async function handleResume(collab: CollaborationManager, args: Record<string, unknown>): Promise<ToolResult> {
    const targetSession = readStringParam(args, 'targetSession', { required: true });
    const message = readStringParam(args, 'message', { required: true });
    const timeout = readNumberParam(args, 'timeout') || 300;

    log.info(`resume: session=${targetSession}`);

    const result = await collab.resume({
        sessionId: targetSession,
        message,
        timeout,
    });

    return jsonResult({
        status: result.status,
        sessionId: result.sessionId,
        output: result.output,
        error: result.error,
        duration: result.duration ? `${(result.duration / 1000).toFixed(1)}s` : undefined,
    });
}
