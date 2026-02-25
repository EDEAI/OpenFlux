/**
 * 邮件工具 - SMTP 发送 + IMAP 读取
 * 使用 nodemailer（发送）和 imap-simple（读取）
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

/**
 * 创建邮件工具
 */
export function createEmailTool(opts: EmailToolOptions = {}): AnyTool {
    // 运行时配置（可通过 config action 修改）
    let config = {
        smtpHost: opts.smtpHost || '',
        smtpPort: opts.smtpPort || 465,
        imapHost: opts.imapHost || '',
        imapPort: opts.imapPort || 993,
        user: opts.user || '',
        password: opts.password || '',
        tls: opts.tls !== false,
        requireConfirmation: opts.requireConfirmation !== false,
    };

    return {
        name: 'email',
        description: `邮件工具。支持的动作: ${EMAIL_ACTIONS.join(', ')}。使用前需通过 config 动作设置 SMTP/IMAP 连接信息。`,
        parameters: {
            action: {
                type: 'string',
                description: `操作类型: ${EMAIL_ACTIONS.join('/')}`,
                required: true,
                enum: [...EMAIL_ACTIONS],
            },
            to: {
                type: 'string',
                description: 'send 动作：收件人地址（多个用逗号分隔）',
            },
            cc: {
                type: 'string',
                description: 'send 动作：抄送地址',
            },
            subject: {
                type: 'string',
                description: 'send 动作/search 动作：邮件主题',
            },
            body: {
                type: 'string',
                description: 'send 动作：邮件正文',
            },
            html: {
                type: 'boolean',
                description: 'send 动作：正文是否为 HTML 格式',
                default: false,
            },
            attachments: {
                type: 'string',
                description: 'send 动作：附件文件路径（多个用逗号分隔）',
            },
            count: {
                type: 'number',
                description: 'read 动作：读取邮件数量（默认 10）',
            },
            folder: {
                type: 'string',
                description: 'read/search 动作：邮件文件夹（默认 INBOX）',
            },
            query: {
                type: 'string',
                description: 'search 动作：搜索关键词',
            },
            from: {
                type: 'string',
                description: 'search 动作：发件人过滤',
            },
            // config 参数
            smtpHost: { type: 'string', description: 'config 动作：SMTP 主机' },
            smtpPort: { type: 'number', description: 'config 动作：SMTP 端口' },
            imapHost: { type: 'string', description: 'config 动作：IMAP 主机' },
            imapPort: { type: 'number', description: 'config 动作：IMAP 端口' },
            user: { type: 'string', description: 'config 动作：邮箱地址' },
            password: { type: 'string', description: 'config 动作：密码/授权码' },
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

                    return jsonResult({
                        updated,
                        config: {
                            smtpHost: config.smtpHost || '(未设置)',
                            smtpPort: config.smtpPort,
                            imapHost: config.imapHost || '(未设置)',
                            imapPort: config.imapPort,
                            user: config.user || '(未设置)',
                            password: config.password ? '******' : '(未设置)',
                            tls: config.tls,
                        },
                    });
                }

                // 发送邮件（通过 nodemailer）
                case 'send': {
                    if (!config.smtpHost || !config.user || !config.password) {
                        return errorResult('邮箱未配置，请先使用 config 动作设置 smtpHost、user、password');
                    }

                    const to = readStringParam(args, 'to');
                    const subject = readStringParam(args, 'subject') || '(无主题)';
                    const body = readStringParam(args, 'body') || '';
                    const cc = readStringParam(args, 'cc');
                    const isHtml = readBooleanParam(args, 'html') || false;
                    const attachmentPaths = readStringParam(args, 'attachments');

                    if (!to) {
                        return errorResult('缺少收件人地址（to 参数）');
                    }

                    try {
                        const nodemailer = require('nodemailer');

                        const transporter = nodemailer.createTransport({
                            host: config.smtpHost,
                            port: config.smtpPort,
                            secure: config.tls,
                            auth: {
                                user: config.user,
                                pass: config.password,
                            },
                        });

                        // 构建附件列表
                        const attachments: Array<{ filename: string; path: string }> = [];
                        if (attachmentPaths) {
                            const paths = attachmentPaths.split(',').map(p => p.trim());
                            const pathModule = require('path');
                            for (const p of paths) {
                                attachments.push({
                                    filename: pathModule.basename(p),
                                    path: p,
                                });
                            }
                        }

                        const mailOptions: Record<string, unknown> = {
                            from: config.user,
                            to,
                            subject,
                            attachments,
                        };

                        if (cc) mailOptions.cc = cc;
                        if (isHtml) {
                            mailOptions.html = body;
                        } else {
                            mailOptions.text = body;
                        }

                        const info = await transporter.sendMail(mailOptions);

                        return jsonResult({
                            sent: true,
                            messageId: info.messageId,
                            to,
                            subject,
                            attachmentCount: attachments.length,
                        });
                    } catch (error: any) {
                        return errorResult(`发送邮件失败: ${error.message}`);
                    }
                }

                // 读取收件箱（通过 IMAP）
                case 'read': {
                    if (!config.imapHost || !config.user || !config.password) {
                        return errorResult('IMAP 未配置，请先使用 config 动作设置 imapHost、user、password');
                    }

                    const count = readNumberParam(args, 'count') || 10;
                    const folder = readStringParam(args, 'folder') || 'INBOX';

                    try {
                        const Imap = require('imap');
                        const { simpleParser } = require('mailparser');

                        const imap = new Imap({
                            user: config.user,
                            password: config.password,
                            host: config.imapHost,
                            port: config.imapPort,
                            tls: config.tls,
                            tlsOptions: { rejectUnauthorized: false },
                        });

                        const emails = await new Promise<any[]>((resolve, reject) => {
                            const results: any[] = [];

                            imap.once('ready', () => {
                                imap.openBox(folder, true, (err: any) => {
                                    if (err) { reject(err); return; }

                                    // 获取最新的 N 封邮件
                                    imap.search(['ALL'], (searchErr: any, uids: number[]) => {
                                        if (searchErr) { reject(searchErr); return; }

                                        const latest = uids.slice(-count);
                                        if (latest.length === 0) {
                                            imap.end();
                                            resolve([]);
                                            return;
                                        }

                                        const fetch = imap.fetch(latest, {
                                            bodies: '',
                                            struct: true,
                                        });

                                        fetch.on('message', (msg: any) => {
                                            msg.on('body', (stream: any) => {
                                                let buffer = '';
                                                stream.on('data', (chunk: any) => { buffer += chunk.toString('utf8'); });
                                                stream.once('end', async () => {
                                                    try {
                                                        const parsed = await simpleParser(buffer);
                                                        results.push({
                                                            from: parsed.from?.text || '',
                                                            to: parsed.to?.text || '',
                                                            subject: parsed.subject || '',
                                                            date: parsed.date?.toISOString() || '',
                                                            text: (parsed.text || '').slice(0, 500),
                                                            hasAttachments: (parsed.attachments?.length || 0) > 0,
                                                            attachmentCount: parsed.attachments?.length || 0,
                                                        });
                                                    } catch {
                                                        // 解析失败忽略
                                                    }
                                                });
                                            });
                                        });

                                        fetch.once('end', () => {
                                            imap.end();
                                            // 延迟一点确保所有解析完成
                                            setTimeout(() => resolve(results), 500);
                                        });

                                        fetch.once('error', reject);
                                    });
                                });
                            });

                            imap.once('error', reject);
                            imap.connect();
                        });

                        return jsonResult({
                            folder,
                            count: emails.length,
                            emails: emails.reverse(), // 最新的在前
                        });
                    } catch (error: any) {
                        return errorResult(`读取邮件失败: ${error.message}`);
                    }
                }

                // 搜索邮件
                case 'search': {
                    if (!config.imapHost || !config.user || !config.password) {
                        return errorResult('IMAP 未配置，请先使用 config 动作设置 imapHost、user、password');
                    }

                    const query = readStringParam(args, 'query');
                    const from = readStringParam(args, 'from');
                    const subject = readStringParam(args, 'subject');
                    const folder = readStringParam(args, 'folder') || 'INBOX';
                    const count = readNumberParam(args, 'count') || 20;

                    if (!query && !from && !subject) {
                        return errorResult('搜索需要至少一个条件：query、from 或 subject');
                    }

                    try {
                        const Imap = require('imap');
                        const { simpleParser } = require('mailparser');

                        const imap = new Imap({
                            user: config.user,
                            password: config.password,
                            host: config.imapHost,
                            port: config.imapPort,
                            tls: config.tls,
                            tlsOptions: { rejectUnauthorized: false },
                        });

                        const emails = await new Promise<any[]>((resolve, reject) => {
                            const results: any[] = [];

                            imap.once('ready', () => {
                                imap.openBox(folder, true, (err: any) => {
                                    if (err) { reject(err); return; }

                                    // 构建 IMAP 搜索条件
                                    const criteria: any[] = [];
                                    if (subject) criteria.push(['SUBJECT', subject]);
                                    if (from) criteria.push(['FROM', from]);
                                    if (query) criteria.push(['TEXT', query]);

                                    imap.search(criteria, (searchErr: any, uids: number[]) => {
                                        if (searchErr) { reject(searchErr); return; }

                                        const latest = uids.slice(-count);
                                        if (latest.length === 0) {
                                            imap.end();
                                            resolve([]);
                                            return;
                                        }

                                        const fetch = imap.fetch(latest, {
                                            bodies: '',
                                            struct: true,
                                        });

                                        fetch.on('message', (msg: any) => {
                                            msg.on('body', (stream: any) => {
                                                let buffer = '';
                                                stream.on('data', (chunk: any) => { buffer += chunk.toString('utf8'); });
                                                stream.once('end', async () => {
                                                    try {
                                                        const parsed = await simpleParser(buffer);
                                                        results.push({
                                                            from: parsed.from?.text || '',
                                                            to: parsed.to?.text || '',
                                                            subject: parsed.subject || '',
                                                            date: parsed.date?.toISOString() || '',
                                                            text: (parsed.text || '').slice(0, 300),
                                                        });
                                                    } catch {
                                                        // 忽略
                                                    }
                                                });
                                            });
                                        });

                                        fetch.once('end', () => {
                                            imap.end();
                                            setTimeout(() => resolve(results), 500);
                                        });

                                        fetch.once('error', reject);
                                    });
                                });
                            });

                            imap.once('error', reject);
                            imap.connect();
                        });

                        return jsonResult({
                            folder,
                            query: { query, from, subject },
                            count: emails.length,
                            emails: emails.reverse(),
                        });
                    } catch (error: any) {
                        return errorResult(`搜索邮件失败: ${error.message}`);
                    }
                }

                default:
                    return errorResult(`未知动作: ${action}`);
            }
        },
    };
}
