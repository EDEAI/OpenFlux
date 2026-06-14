/**
 * Mail Tool - SMTP Send + IMAP Read
 * Using nodemailer (sending) and imapflow (reading, async native support)
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
// @ts-ignore mailparser does not ship bundled TypeScript declarations
import mailparser from 'mailparser';

// Supported actions
const EMAIL_ACTIONS = [
    'send',       // Send email
    'read',       // Read inbox
    'search',     // Search mail
    'config',     // View/set configuration
] as const;

type EmailAction = (typeof EMAIL_ACTIONS)[number];

interface EmailSearchCriteria {
    query?: string;
    from?: string;
    subject?: string;
    seen?: boolean;
}

interface FetchEmailsResult {
    total: number;
    emails: any[];
}

const DEFAULT_READ_COUNT = 10;
const DEFAULT_SEARCH_COUNT = 20;
const MAX_EMAIL_COUNT = 100;
const PREVIEW_SOURCE_BYTES = 16 * 1024;
const BODY_SEARCH_SOURCE_BYTES = 32 * 1024;
const TEXT_SEARCH_SAMPLE_SIZE = 10;
const BODY_SCAN_CHUNK_SIZE = 5;
const HEADER_SCAN_CHUNK_SIZE = 100;

export interface EmailToolOptions {
    /** SMTP host */
    smtpHost?: string;
    /** SMTP port */
    smtpPort?: number;
    /** IMAP host */
    imapHost?: string;
    /** IMAP port */
    imapPort?: number;
    /** Email address */
    user?: string;
    /** Email password/authorization code */
    password?: string;
    /** Whether to use TLS */
    tls?: boolean;
    /** Whether confirmation is required to send an email */
    requireConfirmation?: boolean;
}

/** Auxiliary function for parsing email headers */
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

function hasParam(params: Record<string, unknown>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(params, key);
}

function readSeenFilter(args: Record<string, unknown>): boolean | undefined {
    let seen: boolean | undefined;
    const status = readStringParam(args, 'status')?.toLowerCase();

    if (status) {
        if (['unread', 'unseen', '未读'].includes(status)) {
            seen = false;
        } else if (['read', 'seen', '已读'].includes(status)) {
            seen = true;
        }
    }

    if (hasParam(args, 'seen')) {
        seen = readBooleanParam(args, 'seen');
    }

    if (hasParam(args, 'unread') && readBooleanParam(args, 'unread')) {
        seen = false;
    }

    return seen;
}

function includesText(value: unknown, needle?: string): boolean {
    if (!needle) return true;
    return String(value || '').toLowerCase().includes(needle.toLowerCase());
}

function matchesClientCriteria(email: any, criteria?: EmailSearchCriteria): boolean {
    if (!criteria) return true;
    if (criteria.from && !includesText(email.from, criteria.from)) return false;
    if (criteria.subject && !includesText(email.subject, criteria.subject)) return false;
    if (criteria.query && !includesText(email._bodySearchText || email.bodyPreview, criteria.query)) return false;
    return true;
}

function readCount(args: Record<string, unknown>, fallback: number): number {
    const value = readNumberParam(args, 'count');
    if (!value || value <= 0) return fallback;
    return Math.min(Math.trunc(value), MAX_EMAIL_COUNT);
}

function extractBodyPreview(source: Buffer): string {
    const raw = source.toString('utf8');
    const bodyStart = raw.search(/\r?\n\r?\n/);
    if (bodyStart === -1) return '';

    return raw.slice(bodyStart)
        .replace(/=\r?\n/g, '') // Remove QP soft line breaks
        .replace(/\r?\n/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

async function extractBodyText(source: Buffer): Promise<string> {
    try {
        const simpleParser = (mailparser as any).simpleParser;
        if (typeof simpleParser === 'function') {
            const parsed = await simpleParser(source);
            const parsedText = parsed?.text || parsed?.html || '';
            if (parsedText) {
                return String(parsedText)
                    .replace(/<[^>]+>/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim();
            }
        }
    } catch {
        // Fall back to a lightweight raw extraction for partial or malformed messages.
    }

    return extractBodyPreview(source);
}

/**
 * Reading emails via ImapFlow
 */
async function fetchEmails(
    config: { imapHost: string; imapPort: number; user: string; password: string; tls: boolean },
    folder: string,
    count: number,
    searchCriteria?: EmailSearchCriteria,
): Promise<FetchEmailsResult> {
    const createClient = () => new ImapFlow({
        host: config.imapHost,
        port: config.imapPort,
        secure: config.tls,
        auth: {
            user: config.user,
            pass: config.password,
        },
        logger: false,
    });

    const client = createClient();

    try {
        await client.connect();
        const lock = await client.getMailboxLock(folder);

        try {
            const needsClientFilter = !!(searchCriteria?.from || searchCriteria?.subject || searchCriteria?.query);

            // Only read/unread are handed over to the server. The quality of the text SEARCH of each IMAP is inconsistent, and the text conditions require trust verification or local filtering.
            const searchQuery: any = {};
            if (searchCriteria?.seen !== undefined) searchQuery.seen = searchCriteria.seen;
            if (Object.keys(searchQuery).length === 0) searchQuery.all = true;

            // Search to get UID list
            const found = await client.search(searchQuery, { uid: true });
            const uids = Array.isArray(found) ? found : [];

            const fetchDetailsWithClient = async (
                activeClient: ImapFlow,
                targetUids: number[],
                includeSource: boolean,
                parseBodyForSearch = false,
            ): Promise<any[]> => {
                if (targetUids.length === 0) return [];

                const fetchQuery: any = { uid: true, flags: true, envelope: true };
                if (includeSource) {
                    fetchQuery.source = {
                        maxLength: parseBodyForSearch ? BODY_SEARCH_SOURCE_BYTES : PREVIEW_SOURCE_BYTES,
                    };
                }

                const emails: any[] = [];
                for await (const msg of activeClient.fetch(
                    { uid: targetUids.join(',') },
                    fetchQuery,
                )) {
                    const env = msg.envelope || {};
                    const flags = msg.flags ? Array.from(msg.flags) : [];
                    const seen = flags.some(flag => flag.toLowerCase() === '\\seen');
                    const bodyText = includeSource && msg.source
                        ? (parseBodyForSearch ? await extractBodyText(msg.source) : extractBodyPreview(msg.source))
                        : '';

                    const email = {
                        uid: msg.uid,
                        from: decodeHeaderValue(env.from),
                        to: decodeHeaderValue(env.to),
                        subject: env.subject || '(No Subject)',
                        date: env.date?.toISOString() || '',
                        messageId: env.messageId || '',
                        seen,
                        unread: !seen,
                        flags,
                        bodyPreview: bodyText.slice(0, 500),
                    };

                    if (bodyText) {
                        Object.defineProperty(email, '_bodySearchText', {
                            value: bodyText,
                            enumerable: false,
                        });
                    }

                    emails.push(email);
                }

                emails.sort((a, b) => b.uid - a.uid);
                return emails;
            };

            const fetchDetails = (
                targetUids: number[],
                includeSource: boolean,
                parseBodyForSearch = false,
            ) => fetchDetailsWithClient(client, targetUids, includeSource, parseBodyForSearch);

            const fetchDetailsFresh = async (
                targetUids: number[],
                includeSource: boolean,
                parseBodyForSearch = false,
            ): Promise<any[]> => {
                if (targetUids.length === 0) return [];

                const freshClient = createClient();
                try {
                    await freshClient.connect();
                    const freshLock = await freshClient.getMailboxLock(folder);
                    try {
                        return await fetchDetailsWithClient(freshClient, targetUids, includeSource, parseBodyForSearch);
                    } finally {
                        freshLock.release();
                    }
                } finally {
                    await freshClient.logout().catch(() => { });
                }
            };

            if (!needsClientFilter) {
                // Get the latest N letters
                const latestUids = uids.slice(-count);
                return {
                    total: uids.length,
                    emails: await fetchDetails(latestUids, true),
                };
            }

            const filterLocally = async (
                candidateUids: number[],
                criteria: EmailSearchCriteria,
                includeSource: boolean,
                collectUids = false,
            ): Promise<FetchEmailsResult & { matchedUids: number[] }> => {
                let total = 0;
                const emails: any[] = [];
                const matchedUids: number[] = [];
                const chunkSize = includeSource ? BODY_SCAN_CHUNK_SIZE : HEADER_SCAN_CHUNK_SIZE;
                const newestFirst = [...candidateUids].reverse();
                const iterations = [];

                for (let i = 0; i < newestFirst.length; i += chunkSize) {
                    const chunk = newestFirst.slice(i, i + chunkSize);
                    iterations.push(includeSource
                        ? await fetchDetailsFresh(chunk, true, true)
                        : await fetchDetails(chunk, false));
                }

                for (const chunkEmails of iterations) {
                    for (const email of chunkEmails) {
                        if (!matchesClientCriteria(email, criteria)) continue;
                        total += 1;
                        if (collectUids) matchedUids.push(email.uid);
                        if (emails.length < count) {
                            emails.push(email);
                        }
                    }
                }

                return { total, emails, matchedUids };
            };

            const hasHeaderFilter = !!(searchCriteria?.from || searchCriteria?.subject);
            const hasBodyFilter = !!searchCriteria?.query;

            if (hasHeaderFilter && hasBodyFilter) {
                const headerMatched = await filterLocally(
                    uids,
                    { from: searchCriteria.from, subject: searchCriteria.subject },
                    false,
                    true,
                );
                return filterLocally(headerMatched.matchedUids, { query: searchCriteria.query }, true);
            }

            let bodyCandidateUids = uids;
            let bodySearchTrusted = false;

            if (hasBodyFilter) {
                const bodySearchQuery: any = { body: searchCriteria.query };
                if (searchCriteria?.seen !== undefined) bodySearchQuery.seen = searchCriteria.seen;

                try {
                    const bodyFound = await client.search(bodySearchQuery, { uid: true });
                    const bodyUids = Array.isArray(bodyFound) ? bodyFound : [];
                    const suspiciousAll = bodyUids.length === uids.length && uids.length > TEXT_SEARCH_SAMPLE_SIZE;

                    if (bodyUids.length === 0) {
                        bodySearchTrusted = true;
                        bodyCandidateUids = [];
                    } else if (!suspiciousAll) {
                        const sampleUids = bodyUids.slice(-TEXT_SEARCH_SAMPLE_SIZE);
                        const sampleEmails = await fetchDetails(sampleUids, true, true);
                        bodySearchTrusted = sampleEmails.every(email => matchesClientCriteria(email, { query: searchCriteria.query }));
                        if (bodySearchTrusted) {
                            bodyCandidateUids = bodyUids;
                        }
                    }
                } catch {
                    bodySearchTrusted = false;
                    bodyCandidateUids = uids;
                }
            }

            if (hasBodyFilter && bodySearchTrusted && !hasHeaderFilter) {
                return {
                    total: bodyCandidateUids.length,
                    emails: await fetchDetails(bodyCandidateUids.slice(-count), true, true),
                };
            }

            if (hasBodyFilter && !bodySearchTrusted && hasHeaderFilter) {
                const headerMatched = await filterLocally(
                    uids,
                    { from: searchCriteria.from, subject: searchCriteria.subject },
                    false,
                    true,
                );
                return filterLocally(headerMatched.matchedUids, { query: searchCriteria.query }, true);
            }

            if (hasBodyFilter && !bodySearchTrusted) {
                return filterLocally(uids, { query: searchCriteria.query }, true);
            }

            if (hasHeaderFilter && !hasBodyFilter) {
                const headerSearchQuery: any = {
                    ...(searchCriteria?.from ? { from: searchCriteria.from } : {}),
                    ...(searchCriteria?.subject ? { subject: searchCriteria.subject } : {}),
                };
                if (searchCriteria?.seen !== undefined) headerSearchQuery.seen = searchCriteria.seen;

                const headerFound = await client.search(headerSearchQuery, { uid: true });
                const headerUids = Array.isArray(headerFound) ? headerFound : [];
                const suspiciousAll = headerUids.length === uids.length && uids.length > TEXT_SEARCH_SAMPLE_SIZE;

                if (headerUids.length === 0) {
                    return { total: 0, emails: [] };
                }

                if (!suspiciousAll) {
                    const sampleEmails = await fetchDetails(headerUids.slice(-TEXT_SEARCH_SAMPLE_SIZE), false);
                    const serverSearchTrusted = sampleEmails.every(email => matchesClientCriteria(email, {
                        from: searchCriteria.from,
                        subject: searchCriteria.subject,
                    }));

                    if (serverSearchTrusted) {
                        return {
                            total: headerUids.length,
                            emails: await fetchDetails(headerUids.slice(-count), true),
                        };
                    }
                }
            }

            const headerMatched = await filterLocally(
                bodyCandidateUids,
                { from: searchCriteria.from, subject: searchCriteria.subject },
                false,
                true,
            );

            return {
                total: headerMatched.total,
                emails: await fetchDetails(headerMatched.matchedUids.slice(0, count), true),
            };
        } finally {
            lock.release();
        }
    } finally {
        await client.logout().catch(() => { });
    }
}

/**
 * Create email tool
 */
export function createEmailTool(opts: EmailToolOptions = {}): AnyTool {
    const CONFIG_FILE = path.join(process.cwd(), 'email-config.json');

    // Load saved configuration from disk
    const loadSavedConfig = (): Record<string, any> => {
        try {
            const data = fs.readFileSync(CONFIG_FILE, 'utf-8');
            return JSON.parse(data);
        } catch {
            return {};
        }
    };

    // Save configuration to disk
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

    // Runtime configuration (priority: opts > saved > defaults)
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
        priority: 58,
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
                description: 'read/search action: Maximum number of emails to return (default read=10, search=20)',
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
            unread: {
                type: 'boolean',
                description: 'read/search action: Only return unread emails',
            },
            seen: {
                type: 'boolean',
                description: 'read/search action: true for read emails, false for unread emails',
            },
            status: {
                type: 'string',
                description: 'read/search action: read/seen/已读 or unread/unseen/未读',
            },
            // config parameters
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
                // View/set email configuration
                case 'config': {
                    const smtpHost = readStringParam(args, 'smtpHost');
                    const smtpPort = readNumberParam(args, 'smtpPort');
                    const imapHost = readStringParam(args, 'imapHost');
                    const imapPort = readNumberParam(args, 'imapPort');
                    const user = readStringParam(args, 'user');
                    const password = readStringParam(args, 'password');

                    // Update if parameters are passed in
                    let updated = false;
                    if (smtpHost) { config.smtpHost = smtpHost; updated = true; }
                    if (smtpPort) { config.smtpPort = smtpPort; updated = true; }
                    if (imapHost) { config.imapHost = imapHost; updated = true; }
                    if (imapPort) { config.imapPort = imapPort; updated = true; }
                    if (user) { config.user = user; updated = true; }
                    if (password) { config.password = password; updated = true; }

                    // Persistence to disk
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

                // Send mail (via nodemailer)
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

                        // Build attachment list
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
                            // Automatically fallback to 465 when port 587 fails
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

                // Read the inbox (via ImapFlow)
                case 'read': {
                    if (!config.imapHost || !config.user || !config.password) {
                        return errorResult('IMAP not configured. Please use config action to set imapHost, user, password first.');
                    }

                    const count = readCount(args, DEFAULT_READ_COUNT);
                    const folder = readStringParam(args, 'folder') || 'INBOX';
                    const seen = readSeenFilter(args);

                    try {
                        const result = await fetchEmails(config, folder, count, { seen });
                        return jsonResult({
                            folder,
                            total: result.total,
                            returned: result.emails.length,
                            hasMore: result.total > result.emails.length,
                            emails: result.emails,
                        });
                    } catch (error: any) {
                        console.error('[email] IMAP read failed:', error.message);
                        return errorResult(`Failed to read emails: ${error.message}`);
                    }
                }

                // Search mail
                case 'search': {
                    if (!config.imapHost || !config.user || !config.password) {
                        return errorResult('IMAP not configured. Please use config action to set imapHost, user, password first.');
                    }

                    const query = readStringParam(args, 'query');
                    const from = readStringParam(args, 'from');
                    const subject = readStringParam(args, 'subject');
                    const folder = readStringParam(args, 'folder') || 'INBOX';
                    const count = readCount(args, DEFAULT_SEARCH_COUNT);
                    const seen = readSeenFilter(args);

                    if (!query && !from && !subject && seen === undefined) {
                        return errorResult('Search requires at least one condition: query, from, subject, unread/seen, or status');
                    }

                    try {
                        const result = await fetchEmails(config, folder, count, { query, from, subject, seen });
                        return jsonResult({
                            folder,
                            searchCriteria: { query, from, subject, seen },
                            total: result.total,
                            returned: result.emails.length,
                            hasMore: result.total > result.emails.length,
                            emails: result.emails,
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
