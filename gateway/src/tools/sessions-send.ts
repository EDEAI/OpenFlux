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

const ACTIONS = ['send', 'list', 'status', 'read', 'waitAll'] as const;

/**
 * 创建 sessions_send 工具
 */
export function createSessionsSendTool(options: SessionsSendToolOptions): Tool {
    const collab = options.collaborationManager;

    const parameters: Record<string, ToolParameter> = {
        action: {
            type: 'string',
            description: '操作类型：send=发送消息 | list=列出协作会话 | status=查询状态 | read=读取消息 | waitAll=等待多个会话完成并汇总结果',
            required: true,
            enum: [...ACTIONS],
        },
        targetSession: {
            type: 'string',
            description: '目标协作会话 ID（send/status/read 时必填）',
            required: false,
        },
        message: {
            type: 'string',
            description: '要发送的消息内容（send 时必填）',
            required: false,
        },
        sessionIds: {
            type: 'array',
            description: '协作会话 ID 列表（waitAll 时必填）',
            required: false,
            items: { type: 'string' },
        },
        timeout: {
            type: 'number',
            description: '等待超时秒数（waitAll 时可选，默认 300）',
            required: false,
            default: 300,
        },
    };

    return {
        name: 'sessions_send',
        description: [
            'Agent 间通信工具，管理协作会话。',
            '操作说明：',
            '- send: 向协作会话发送消息（追加指令、提供补充信息）',
            '- list: 列出所有协作会话及其状态',
            '- status: 查询指定协作会话的详细状态和结果',
            '- read: 读取指定协作会话中的消息记录',
            '- waitAll: 等待多个协作会话全部完成，返回汇总结果',
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
                    default:
                        return errorResult(`未知操作: ${action}。支持: ${ACTIONS.join(', ')}`);
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
        return textResult('当前没有协作会话。');
    }

    const sessions = all.map(s => ({
        sessionId: s.id,
        agentId: s.agentId,
        task: s.task.length > 80 ? s.task.slice(0, 77) + '...' : s.task,
        status: s.status,
        duration: s.endTime
            ? `${((s.endTime - s.startTime) / 1000).toFixed(1)}s`
            : `${((Date.now() - s.startTime) / 1000).toFixed(1)}s (运行中)`,
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
        return errorResult(`协作会话不存在: ${targetSession}`);
    }

    const statusText: Record<string, string> = {
        running: '⏳ 运行中',
        completed: '✅ 已完成',
        failed: '❌ 失败',
        timeout: '⏰ 超时',
    };

    const result: Record<string, unknown> = {
        sessionId: session.id,
        agentId: session.agentId,
        task: session.task,
        status: statusText[session.status] || session.status,
        startTime: new Date(session.startTime).toISOString(),
        duration: session.endTime
            ? `${((session.endTime - session.startTime) / 1000).toFixed(1)}s`
            : `${((Date.now() - session.startTime) / 1000).toFixed(1)}s (运行中)`,
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
            return errorResult(`协作会话不存在: ${targetSession}`);
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

        return textResult(`协作会话 ${targetSession} 暂无消息，Agent "${session.agentId}" 正在执行中...`);
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
        return errorResult('waitAll 需要 sessionIds 参数（协作会话 ID 数组）');
    }

    const sessionIds = sessionIdsRaw.map(String);
    const timeout = readNumberParam(args, 'timeout') || 300;

    log.info(`waitAll: ${sessionIds.length} 个会话, timeout=${timeout}s`);

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
