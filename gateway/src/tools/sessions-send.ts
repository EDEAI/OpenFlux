/**
 * sessions_send tool - Inter-Agent communication
 * Supports querying collaboration session status, sending messages, reading replies, and waiting for multi-session completion
 */

import type { Tool, ToolResult, ToolParameter } from './types';
import { jsonResult, errorResult, readStringParam, readNumberParam, textResult } from './common';
import type { CollaborationManager } from '../agent/collaboration';
import { Logger } from '../utils/logger';
import { PRESENTATION_AGENT_ID } from '../agent/presentation-agent';

const log = new Logger('SessionsSend');

/** sessions_send tool option */
export interface SessionsSendToolOptions {
    /** CollaborationManager instance */
    collaborationManager: CollaborationManager;
}

const ACTIONS = ['send', 'list', 'status', 'read', 'wait', 'waitAll', 'resume', 'interrupt'] as const;

/**
 * Create sessions_send tool
 */
export function createSessionsSendTool(options: SessionsSendToolOptions): Tool {
    const collab = options.collaborationManager;

    const parameters: Record<string, ToolParameter> = {
        action: {
            type: 'string',
            description: 'Action type: send | list | status | read | wait | waitAll | resume | interrupt',
            required: true,
            enum: [...ACTIONS],
        },
        targetSession: {
            type: 'string',
            description: 'Target collaborative session ID (required for send/status/read/wait/resume/interrupt)',
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
            '- wait: Wait for one session to reach a terminal or idle state',
            '- waitAll: Wait for multiple sessions to complete and return aggregated results',
            '- resume: Send a follow-up message to a persistent session (mode="session"), triggering the agent to respond with context',
            '- interrupt: Cooperatively cancel a running child agent',
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
                    case 'wait':
                        return await handleWait(collab, args);
                    case 'waitAll':
                        return await handleWaitAll(collab, args);
                    case 'resume':
                        return await handleResume(collab, args);
                    case 'interrupt':
                        return handleInterrupt(collab, args);
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
 * Send message
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
 * List collaboration sessions
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
 * Query session status
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
        state: session.status,
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

async function handleWait(collab: CollaborationManager, args: Record<string, unknown>): Promise<ToolResult> {
    const targetSession = readStringParam(args, 'targetSession', { required: true });
    const timeout = readNumberParam(args, 'timeout') || 300;
    const result = await collab.wait(targetSession, timeout);
    return jsonResult({
        status: result.status,
        sessionId: result.sessionId,
        output: result.output,
        error: result.error,
        duration: result.duration ? `${(result.duration / 1000).toFixed(1)}s` : undefined,
    });
}

function handleInterrupt(collab: CollaborationManager, args: Record<string, unknown>): ToolResult {
    const targetSession = readStringParam(args, 'targetSession', { required: true });
    const interrupted = collab.interrupt(targetSession);
    if (!interrupted) {
        return errorResult(`Collaborative session is not running: ${targetSession}`);
    }
    return jsonResult({ status: 'interrupting', sessionId: targetSession });
}

/**
 * read message
 */
function handleRead(collab: CollaborationManager, args: Record<string, unknown>): ToolResult {
    const targetSession = readStringParam(args, 'targetSession', { required: true });
    const messages = collab.getMessages(targetSession, true); // Mark as read

    if (messages.length === 0) {
        const session = collab.getSession(targetSession);
        if (!session) {
            return errorResult(`Collaborative session not found: ${targetSession}`);
        }

        // No message but session completed, return result
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
 * Wait for multiple collaboration sessions to complete
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
            output: r.output?.slice(0, 500), // Truncate to avoid being too long
            error: r.error,
            duration: r.duration ? `${(r.duration / 1000).toFixed(1)}s` : undefined,
        })),
    });
}

/**
 * Resume persistent session (multiple rounds of follow-up)
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

    if (result.status === 'failed' || result.status === 'timeout') {
        const agentId = collab.getSession(targetSession)?.agentId;
        const presentation = agentId === PRESENTATION_AGENT_ID;
        return {
            success: false,
            code: presentation ? 'presentation_agent_requires_attention' : 'collaboration_agent_failed',
            retryable: false,
            error: result.error || (presentation
                ? 'The Presentation Agent did not complete the durable presentation workflow.'
                : 'The collaborative Agent did not complete the resumed task.'),
            data: {
                status: result.status,
                sessionId: result.sessionId,
                agentId,
                output: result.output,
                nextAction: presentation
                    ? 'resume_this_presentation_session_or_report_needs_attention'
                    : 'report_delegation_failure',
            },
        };
    }

    return jsonResult({
        status: result.status,
        sessionId: result.sessionId,
        output: result.output,
        error: result.error,
        duration: result.duration ? `${(result.duration / 1000).toFixed(1)}s` : undefined,
    });
}
