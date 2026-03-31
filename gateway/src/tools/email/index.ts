/**
 * 邮件工具 - SMTP 发送 + IMAP 读取
 * 使用 nodemailer（发送）和 imapflow（读取，异步原生支持）
 */

import type { AnyTool, ToolResult } from '../types';
import {
    readStringParam,
    readNumberParam,
    readBooleanParam,
    validateAction,
    jsonResult,
    errorResult,
} from '../common';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import * as path from 'path';
import * as fs from 'fs';

// 支持的动作
const EMAIL_ACTIONS = [
    'send',       // 发送邮件
    'read',       // 读取收件箱
    'search',     // 搜索邮件
    'config',     // 查看/设置配置
] as const;

type EmailAction = (typeof EMAIL_ACTIONS)[number];

export interface EmailToolOptions {
    /** SMTP 主机 */
    smtpHost?: string;
    /** SMTP 端口 */
    smtpPort?: number;
    /** IMAP 主机 */
    imapHost?: string;
    /** IMAP 端口 */
    imapPort?: number;
    /** 邮箱地址 */
    user?: string;
    /** 邮箱密码/授权码 */
    password?: string;
    /** 是否使用 TLS */
    tls?: boolean;
    /** 发送邮件是否需要确认 */
    requireConfirmation?: boolean;
}

/** 解析邮件头的辅助函数 */
function decodeHeaderValue(value: any): string {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (value.text) return value.text;
    if (Array.isArray(value)) {
        return value.map(v => v.name ? `${v.name} <${v.address}>` : v.address || '').join(', ');
    }
    if (value.name && value.address) return `${value.name} <${value.address}>`;
    if (value.address) return value.address;
    return String(value);
}

/**
 * 通过 ImapFlow 读取邮件
 */
async function fetchEmails(
    config: { imapHost: string; imapPort: number; user: string; password: string; tls: boolean },
    folder: string,
    count: number,
    searchCriteria?: { query?: string; from?: string; subject?: string },
): Promise<any[]> {
    const client = new ImapFlow({
        host: config.imapHost,
        port: config.imapPort,
        secure: config.tls,
        auth: {
            user: config.user,
            pass: config.password,
        },
        logger: false,
    });

    try {
        await client.connect();
        const lock = await client.getMailboxLock(folder);

        try {
            // 构建搜索条件
            let searchQuery: any;
            if (searchCriteria && (searchCriteria.query || searchCriteria.from || searchCriteria.subject)) {
                const criteria: any = {};
                if (searchCriteria.from) criteria.from = searchCriteria.from;
                if (searchCriteria.subject) criteria.subject = searchCriteria.subject;
                if (searchCriteria.query) criteria.body = searchCriteria.query;
                searchQuery = criteria;
            } else {
                searchQuery = { all: true };
            }

            // 搜索获取 UID 列表
            const uids: number[] = [];
            for await (const msg of client.fetch(searchQuery, { uid: true, envelope: true, source: false })) {
                uids.push(msg.uid);
            }

            // 取最新 N 封
            const latestUids = uids.slice(-count);
            if (latestUids.length === 0) return [];

            // 获取邮件详情（只取 envelope 元数据 + 部分正文）
            const emails: any[] = [];
            for await (const msg of client.fetch(
                { uid: latestUids.join(',') },
                { uid: true, envelope: true, bodyStructure: true, source: { maxLength: 8192 } },
            )) {
                const env = msg.envelope;
                let bodyPreview = '';

                // 尝试从 source 提取正文预览
                if (msg.source) {
                    const raw = msg.source.toString('utf8');
                    // 简单提取纯文本正文（取 \r\n\r\n 后面的内容）
                    const bodyStart = raw.indexOf('\r\n\r\n');
                    if (bodyStart > -1) {
                        bodyPreview = raw.slice(bodyStart + 4, bodyStart + 504)
                            .replace(/=\r?\n/g, '') // 去掉 QP 软换行
                            .replace(/\r?\n/g, ' ')
                            .trim();
                    }
                }

                emails.push({
                    uid: msg.uid,
                    from: decodeHeaderValue(env.from),
                    to: decodeHeaderValue(env.to),
                    subject: env.subject || '(No Subject)',
                    date: env.date?.toISOString() || '',
                    messageId: env.messageId || '',
                    bodyPreview: bodyPreview.slice(0, 500),
                });
            }

            // 按 UID 降序（最新在前）
            emails.sort((a, b) => b.uid - a.uid);
            return emails;
        } finally {
            lock.release();
        }
    } finally {
        await client.logout().catch(() => { });
    }
}

/**
 * 创建邮件工具
 */
export function createEmailTool(opts: EmailToolOptions = {}): AnyTool {
    const CONFIG_FILE = path.join(process.cwd(), 'email-config.json');

    // 从磁盘加载已保存的配置
    const loadSavedConfig = (): Record<string, any> => {
        try {
            const data = fs.readFileSync(CONFIG_FILE, 'utf-8');
            return JSON.parse(data);
        } catch {
            return {};
        }
    };

    // 保存配置到磁盘
    const saveConfig = () => {
        try {
            fs.writeFileSync(CONFIG_FILE, JSON.stringify({
                smtpHost: config.smtpHost,
                smtpPort: config.smtpPort,
                imapHost: config.imapHost,
                imapPort: config.imapPort,
                user: config.user,
                password: config.password,
                tls: config.tls,
            }, null, 2), 'utf-8');
        } catch (e: any) {
            console.error('[email] Failed to save config:', e.message);
        }
    };

    const saved = loadSavedConfig();

    // 运行时配置（优先级: opts > saved > defaults）
    let config = {
        smtpHost: opts.smtpHost || saved.smtpHost || '',
        smtpPort: opts.smtpPort || saved.smtpPort || 465,
        imapHost: opts.imapHost || saved.imapHost || '',
        imapPort: opts.imapPort || saved.imapPort || 993,
        user: opts.user || saved.user || '',
        password: opts.password || saved.password || '',
        tls: opts.tls !== false,
        requireConfirmation: opts.requireConfirmation !== false,
    };

    return {
        name: 'email',
        description: `Email tool with built-in send/receive capability. Supported actions: ${EMAIL_ACTIONS.join(', ')}. Email configuration is automatically persisted - once configured, it will be remembered across sessions. Use config action (without parameters) to check if already configured before reconfiguring.`,
        parameters: {
            action: {
                type: 'string',
                description: `Action type: ${EMAIL_ACTIONS.join('/')}`,
                required: true,
                enum: [...EMAIL_ACTIONS],
            },
            to: {
                type: 'string',
                description: 'send action: Recipient address (multiple separated by commas)',
            },
            cc: {
                type: 'string',
                description: 'send action: CC address',
            },
            subject: {
                type: 'string',
                description: 'send/search action: Email subject',
            },
            body: {
                type: 'string',
                description: 'send action: Email body',
            },
            html: {
                type: 'boolean',
                description: 'send action: Whether body is HTML format',
                default: false,
            },
            attachments: {
                type: 'string',
                description: 'send action: Attachment file paths (multiple separated by commas)',
            },
            count: {
                type: 'number',
                description: 'read action: Number of emails to read (default 10)',
            },
            folder: {
                type: 'string',
                description: 'read/search action: Email folder (default INBOX)',
            },
            query: {
                type: 'string',
                description: 'search action: Search keyword (searches email body)',
            },
            from: {
                type: 'string',
                description: 'search action: Sender filter',
            },
            // config 参数
            smtpHost: { type: 'string', description: 'config action: SMTP host' },
            smtpPort: { type: 'number', description: 'config action: SMTP port' },
            imapHost: { type: 'string', description: 'config action: IMAP host' },
            imapPort: { type: 'number', description: 'config action: IMAP port' },
            user: { type: 'string', description: 'config action: Email address' },
            password: { type: 'string', description: 'config action: Password/auth code' },
        },

        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
            const action = validateAction(args, EMAIL_ACTIONS);

            switch (action) {
                // 查看/设置邮箱配置
                case 'config': {
                    const smtpHost = readStringParam(args, 'smtpHost');
                    const smtpPort = readNumberParam(args, 'smtpPort');
                    const imapHost = readStringParam(args, 'imapHost');
                    const imapPort = readNumberParam(args, 'imapPort');
                    const user = readStringParam(args, 'user');
                    const password = readStringParam(args, 'password');

                    // 如果传入了参数则更新
                    let updated = false;
                    if (smtpHost) { config.smtpHost = smtpHost; updated = true; }
                    if (smtpPort) { config.smtpPort = smtpPort; updated = true; }
                    if (imapHost) { config.imapHost = imapHost; updated = true; }
                    if (imapPort) { config.imapPort = imapPort; updated = true; }
                    if (user) { config.user = user; updated = true; }
                    if (password) { config.password = password; updated = true; }

                    // 持久化到磁盘
                    if (updated) saveConfig();

                    return jsonResult({
                        updated,
                        config: {
                            smtpHost: config.smtpHost || '(not set)',
                            smtpPort: config.smtpPort,
                            imapHost: config.imapHost || '(not set)',
                            imapPort: config.imapPort,
                            user: config.user || '(not set)',
                            password: config.password ? '******' : '(not set)',
                            tls: config.tls,
                        },
                    });
                }

                // 发送邮件（通过 nodemailer）
                case 'send': {
                    if (!config.smtpHost || !config.user || !config.password) {
                        return errorResult('Email not configured. Please use config action to set smtpHost, user, password first.');
                    }

                    const to = readStringParam(args, 'to');
                    const subject = readStringParam(args, 'subject') || '(No Subject)';
                    const body = readStringParam(args, 'body') || '';
                    const cc = readStringParam(args, 'cc');
                    const isHtml = readBooleanParam(args, 'html') || false;
                    const attachmentPaths = readStringParam(args, 'attachments');

                    if (!to) {
                        return errorResult('Missing recipient address (to parameter)');
                    }

                    try {
                        const sendWithPort = async (port: number) => {
                            const isSecure = port === 465;
                            const transporter = nodemailer.createTransport({
                                host: config.smtpHost,
                                port,
                                secure: isSecure,
                                auth: {
                                    user: config.user,
                                    pass: config.password,
                                },
                                tls: {
                                    rejectUnauthorized: false,
                                    minVersion: 'TLSv1.2',
                                },
                                connectionTimeout: 15000,
                                greetingTimeout: 10000,
                                socketTimeout: 30000,
                            });
                            return transporter.sendMail(mailOpts);
                        };

                        // 构建附件列表
                        const attachments: Array<{ filename: string; path: string }> = [];
                        if (attachmentPaths) {
                            const paths = attachmentPaths.split(',').map(p => p.trim());
                            for (const p of paths) {
                                attachments.push({
                                    filename: path.basename(p),
                                    path: p,
                                });
                            }
                        }

                        const mailOpts: Record<string, unknown> = {
                            from: config.user,
                            to,
                            subject,
                            attachments,
                        };

                        if (cc) mailOpts.cc = cc;
                        if (isHtml) {
                            mailOpts.html = body;
                        } else {
                            mailOpts.text = body;
                        }

                        let info: any;
                        try {
                            info = await sendWithPort(config.smtpPort);
                        } catch (firstErr: any) {
                            // 端口 587 失败时自动回退到 465
                            if (config.smtpPort === 587) {
                                console.warn(`[email] Port 587 failed (${firstErr.message}), falling back to 465`);
                                info = await sendWithPort(465);
                            } else {
                                throw firstErr;
                            }
                        }

                        return jsonResult({
                            sent: true,
                            messageId: info.messageId,
                            to,
                            subject,
                            attachmentCount: attachments.length,
                        });
                    } catch (error: any) {
                        console.error(`[email] Send failed:`, error.message);
                        return errorResult(`Failed to send email: ${error.message}`);
                    }
                }

                // 读取收件箱（通过 ImapFlow）
                case 'read': {
                    if (!config.imapHost || !config.user || !config.password) {
                        return errorResult('IMAP not configured. Please use config action to set imapHost, user, password first.');
                    }

                    const count = readNumberParam(args, 'count') || 10;
                    const folder = readStringParam(args, 'folder') || 'INBOX';

                    try {
                        const emails = await fetchEmails(config, folder, count);
                        return jsonResult({
                            folder,
                            total: emails.length,
                            emails,
                        });
                    } catch (error: any) {
                        console.error('[email] IMAP read failed:', error.message);
                        return errorResult(`Failed to read emails: ${error.message}`);
                    }
                }

                // 搜索邮件
                case 'search': {
                    if (!config.imapHost || !config.user || !config.password) {
                        return errorResult('IMAP not configured. Please use config action to set imapHost, user, password first.');
                    }

                    const query = readStringParam(args, 'query');
                    const from = readStringParam(args, 'from');
                    const subject = readStringParam(args, 'subject');
                    const folder = readStringParam(args, 'folder') || 'INBOX';
                    const count = readNumberParam(args, 'count') || 20;

                    if (!query && !from && !subject) {
                        return errorResult('Search requires at least one condition: query, from, or subject');
                    }

                    try {
                        const emails = await fetchEmails(config, folder, count, { query, from, subject });
                        return jsonResult({
                            folder,
                            searchCriteria: { query, from, subject },
                            total: emails.length,
                            emails,
                        });
                    } catch (error: any) {
                        console.error('[email] IMAP search failed:', error.message);
                        return errorResult(`Failed to search emails: ${error.message}`);
                    }
                }

                default:
                    return errorResult(`Unknown action: ${action}`);
            }
        },
    };
}
