/**
 * Message notification tool
 * Proactively notify users through Router (Feishu and other enterprise IM)
 */

import type { Tool, ToolResult } from '../types';
import { readStringParam, jsonResult, errorResult } from '../common';
import { Logger } from '../../utils/logger';

const log = new Logger('NotifyTool');

export interface NotifyToolOptions {
    /** RouterBridge instance reference */
    getRouterBridge: () => { send: (msg: any) => boolean; getStatus: () => { connected: boolean; bound: boolean } };
    /** Get recent inbound user information */
    getLastUser: () => { platform_type: string; platform_id: string; platform_user_id: string } | null;
}

/**
 * Notification debounce manager
 * When the same user calls notify_user multiple times in a short period of time, only the last message will be pushed.
 * Usage scenario: In a scheduled task, LLM calls notify_user multiple times in stages, causing Feishu to receive multiple messages.
 */
interface PendingNotify {
    timer: ReturnType<typeof setTimeout>;
    message: string;
    user: { platform_type: string; platform_id: string; platform_user_id: string };
    bridge: { send: (msg: any) => boolean };
    resolve: (result: ToolResult) => void;
}

const DEBOUNCE_MS = 8_000; // 8 second debounce window
const pendingNotifies = new Map<string, PendingNotify>();

function flushNotify(userId: string): ToolResult {
    const pending = pendingNotifies.get(userId);
    if (!pending) return jsonResult({ success: false, message: 'No pending notification' });

    clearTimeout(pending.timer);
    pendingNotifies.delete(userId);

    const sent = pending.bridge.send({
        platform_type: pending.user.platform_type,
        platform_id: pending.user.platform_id,
        platform_user_id: pending.user.platform_user_id,
        content_type: 'text',
        content: pending.message,
    });

    if (sent) {
        log.info('Notification sent (debounced)', {
            platform: pending.user.platform_type,
            userId: pending.user.platform_user_id,
            messageLength: pending.message.length,
        });
        return jsonResult({
            success: true,
            message: 'Notification sent',
            platform: pending.user.platform_type,
            userId: pending.user.platform_user_id,
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
        description: 'Send notification messages to users via enterprise IM (e.g., Feishu/Lark). Suitable for task completion notifications, progress reports, and alerts. Note: Router must be connected with inbound message history. IMPORTANT: Only call this ONCE at the end of your task with the final summary. Do NOT call multiple times during task execution.',
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

                // Get the most recent inbound user
                const lastUser = opts.getLastUser();
                if (!lastUser) {
                    return errorResult(
                        'No user to notify. At least one inbound message from Feishu/Lark is required to determine the notification recipient.'
                    );
                }

                const userId = lastUser.platform_user_id;

                // Debounce logic: If there is a pending notification within a short period of time, replace and reset the timer
                const existing = pendingNotifies.get(userId);
                if (existing) {
                    clearTimeout(existing.timer);
                    // Resolve the previous pending notification as "merged".
                    existing.resolve(jsonResult({
                        success: true,
                        message: 'Notification merged with next call (debounced)',
                        platform: lastUser.platform_type,
                        userId,
                    }));
                    log.info('Notification debounced (replaced by newer message)', { userId });
                }

                // Create new debounce pending
                return new Promise<ToolResult>((resolve) => {
                    const timer = setTimeout(() => {
                        const result = flushNotify(userId);
                        resolve(result);
                    }, DEBOUNCE_MS);

                    pendingNotifies.set(userId, {
                        timer,
                        message,
                        user: lastUser,
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
