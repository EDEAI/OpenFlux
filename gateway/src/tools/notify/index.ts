/**
 * Message notification tool
 * Proactively notify users through Router (Feishu and other enterprise IM)
 */

import type { Tool, ToolResult } from '../types';
import { readStringParam, jsonResult, errorResult } from '../common';
import { Logger } from '../../utils/logger';

const log = new Logger('NotifyTool');

/**
 * Where a notification from the current turn must go. Resolved per turn by the
 * Gateway from the task that started it, never from "whoever wrote last".
 */
export type NotifyReplyTarget =
    | { kind: 'private'; platform_type: string; platform_id: string; platform_user_id: string }
    | {
        kind: 'group';
        platform_id: string;
        workspace_id: string;
        channel_id: string;
        thread_id?: string;
        project_id: string;
        label?: string;
    }
    /** The turn is remote but its reply context is missing: refuse rather than guess. */
    | { kind: 'refuse'; reason: string }
    /** A local or scheduled turn with no task-level target: legacy fallback allowed. */
    | { kind: 'none' };

export interface NotifyToolOptions {
    /** RouterBridge instance reference */
    getRouterBridge: () => {
        send: (msg: any) => boolean;
        sendRaw?: (payload: Record<string, unknown>) => boolean;
        getStatus: () => { connected: boolean; bound: boolean };
    };
    /** Get recent inbound user information (legacy fallback for local / scheduled turns). */
    getLastUser: () => { platform_type: string; platform_id: string; platform_user_id: string } | null;
    /** Task-level reply target of the turn currently executing this tool. */
    resolveReplyTarget?: () => NotifyReplyTarget;
    /**
     * Called as soon as a notification is accepted for a Router target (before
     * the debounce window), so the Gateway knows this turn answered the platform
     * itself and must not forward the chat body a second time.
     */
    onDispatch?: (target: NotifyReplyTarget) => void;
}

/**
 * Notification debounce manager
 * When the same user calls notify_user multiple times in a short period of time, only the last message will be pushed.
 * Usage scenario: In a scheduled task, LLM calls notify_user multiple times in stages, causing Feishu to receive multiple messages.
 */
interface PendingNotify {
    timer: ReturnType<typeof setTimeout>;
    message: string;
    target: NotifyReplyTarget;
    bridge: { send: (msg: any) => boolean; sendRaw?: (payload: Record<string, unknown>) => boolean };
    resolve: (result: ToolResult) => void;
}

function notifyTargetKey(target: NotifyReplyTarget): string {
    if (target.kind === 'group') return `group:${target.platform_id}:${target.channel_id}:${target.thread_id || ''}`;
    if (target.kind === 'private') return `private:${target.platform_id}:${target.platform_user_id}`;
    return target.kind;
}

function sendToTarget(
    bridge: { send: (msg: any) => boolean; sendRaw?: (payload: Record<string, unknown>) => boolean },
    target: NotifyReplyTarget,
    message: string,
): boolean {
    if (target.kind === 'group') {
        if (!bridge.sendRaw) return false;
        return bridge.sendRaw({
            action: 'group_message.send',
            platform_id: target.platform_id,
            workspace_id: target.workspace_id,
            channel_id: target.channel_id,
            thread_id: target.thread_id || '',
            project_id: target.project_id,
            content: message,
        });
    }
    if (target.kind === 'private') {
        return bridge.send({
            platform_type: target.platform_type,
            platform_id: target.platform_id,
            platform_user_id: target.platform_user_id,
            content_type: 'text',
            content: message,
        });
    }
    return false;
}

const DEBOUNCE_MS = 8_000; // 8 second debounce window
const pendingNotifies = new Map<string, PendingNotify>();

function flushNotify(targetKey: string): ToolResult {
    const pending = pendingNotifies.get(targetKey);
    if (!pending) return jsonResult({ success: false, message: 'No pending notification' });

    clearTimeout(pending.timer);
    pendingNotifies.delete(targetKey);

    const sent = sendToTarget(pending.bridge, pending.target, pending.message);
    if (sent) {
        log.info('Notification sent (debounced)', { target: targetKey, messageLength: pending.message.length });
        return jsonResult({
            success: true,
            message: 'Notification sent',
            target: pending.target.kind,
            ...(pending.target.kind === 'private' ? { platform: pending.target.platform_type, userId: pending.target.platform_user_id } : {}),
            ...(pending.target.kind === 'group' ? { channelId: pending.target.channel_id } : {}),
        });
    }
    return errorResult('Message sending failed, Router may have disconnected.');
}

/**
 * Create a message notification tool
 */
export function createNotifyTool(opts: NotifyToolOptions): Tool {
    return {
        name: 'notify_user',
        description: 'Send a message to the person or group that reached you through enterprise IM (Feishu/Lark, DingTalk). When the request came from an IM private chat or group, this tool is the ONLY way your answer reaches them: the chat body is NOT forwarded automatically. Call it exactly ONCE at the end with the complete final answer. Do NOT call it for intermediate progress, and do not call it when the request came from the local desktop.',
        parameters: {
            message: {
                type: 'string',
                description: 'Notification content to send (plain text supported)',
                required: true,
            },
        },
        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
            try {
                const message = readStringParam(args, 'message', { required: true, label: 'message' });

                // Check Router connection status
                const bridge = opts.getRouterBridge();
                const status = bridge.getStatus();
                if (!status.connected) {
                    return errorResult('Router not connected, cannot send notifications. Please configure and connect Router in settings first.');
                }
                if (!status.bound) {
                    return errorResult('Router not bound, cannot send notifications. Please complete Router binding first.');
                }

                // Task-level reply target first; the legacy "last inbound user"
                // only serves local or scheduled turns that have no task context.
                let target: NotifyReplyTarget = opts.resolveReplyTarget?.() ?? { kind: 'none' };
                if (target.kind === 'refuse') {
                    return errorResult(`Cannot notify: ${target.reason}`);
                }
                if (target.kind === 'none') {
                    const lastUser = opts.getLastUser();
                    if (!lastUser) {
                        return errorResult(
                            'No user to notify. At least one inbound message from Feishu/Lark is required to determine the notification recipient.'
                        );
                    }
                    target = { kind: 'private', ...lastUser };
                }
                if (target.kind === 'group' && !bridge.sendRaw) {
                    return errorResult('This Router bridge cannot send group messages.');
                }
                opts.onDispatch?.(target);

                const targetKey = notifyTargetKey(target);

                // Debounce logic: If there is a pending notification within a short period of time, replace and reset the timer
                const existing = pendingNotifies.get(targetKey);
                if (existing) {
                    clearTimeout(existing.timer);
                    // Resolve the previous pending notification as "merged".
                    existing.resolve(jsonResult({
                        success: true,
                        message: 'Notification merged with next call (debounced)',
                        target: target.kind,
                    }));
                    log.info('Notification debounced (replaced by newer message)', { target: targetKey });
                }

                // Create new debounce pending
                return new Promise<ToolResult>((resolve) => {
                    const timer = setTimeout(() => {
                        const result = flushNotify(targetKey);
                        resolve(result);
                    }, DEBOUNCE_MS);

                    pendingNotifies.set(targetKey, {
                        timer,
                        message,
                        target,
                        bridge,
                        resolve,
                    });
                });
            } catch (err: any) {
                log.error('Notification send failed', { error: err.message });
                return errorResult(`Notification sending failed: ${err.message}`);
            }
        },
    };
}
