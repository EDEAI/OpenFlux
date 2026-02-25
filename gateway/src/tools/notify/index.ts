/**
 * 消息通知工具
 * 通过 Router (飞书等企业 IM) 主动通知用户
 */

import type { Tool, ToolResult } from '../types';
import { readStringParam, jsonResult, errorResult } from '../common';
import { Logger } from '../../utils/logger';

const log = new Logger('NotifyTool');

export interface NotifyToolOptions {
    /** RouterBridge 实例引用 */
    getRouterBridge: () => { send: (msg: any) => boolean; getStatus: () => { connected: boolean; bound: boolean } };
    /** 获取最近的入站用户信息 */
    getLastUser: () => { platform_type: string; platform_id: string; platform_user_id: string } | null;
}

/**
 * 创建消息通知工具
 */
export function createNotifyTool(opts: NotifyToolOptions): Tool {
    return {
        name: 'notify_user',
        description: '通过企业 IM（飞书等）向用户发送通知消息。适用于任务完成通知、进度汇报、异常提醒等场景。注意：需要 Router 已连接且有过入站消息记录。',
        parameters: {
            message: {
                type: 'string',
                description: '要发送的通知内容（支持纯文本）',
                required: true,
            },
        },
        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
            try {
                const message = readStringParam(args, 'message', { required: true, label: 'message' });

                // 检查 Router 连接状态
                const bridge = opts.getRouterBridge();
                const status = bridge.getStatus();
                if (!status.connected) {
                    return errorResult('Router 未连接，无法发送通知。请先在设置中配置并连接 Router。');
                }
                if (!status.bound) {
                    return errorResult('Router 未绑定，无法发送通知。请先完成 Router 绑定。');
                }

                // 获取最近的入站用户
                const lastUser = opts.getLastUser();
                if (!lastUser) {
                    return errorResult(
                        '没有可通知的用户。需要至少有一次来自飞书的入站消息，才能知道通知发送给谁。'
                    );
                }

                // 发送通知
                const sent = bridge.send({
                    platform_type: lastUser.platform_type,
                    platform_id: lastUser.platform_id,
                    platform_user_id: lastUser.platform_user_id,
                    content_type: 'text',
                    content: message,
                });

                if (sent) {
                    log.info('通知已发送', {
                        platform: lastUser.platform_type,
                        userId: lastUser.platform_user_id,
                        messageLength: message.length,
                    });
                    return jsonResult({
                        success: true,
                        message: '通知已发送',
                        platform: lastUser.platform_type,
                        userId: lastUser.platform_user_id,
                    });
                } else {
                    return errorResult('消息发送失败，Router 可能已断开连接。');
                }
            } catch (err: any) {
                log.error('通知发送失败', { error: err.message });
                return errorResult(`通知发送失败: ${err.message}`);
            }
        },
    };
}
