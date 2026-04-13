/**
 * 微信 iLink Bot API 适配器
 *
 * 通过腾讯官方 iLink Bot API 连接微信个人号。
 * - Long-poll `getupdates` 接收消息
 * - `sendmessage` 发送回复
 * - CDN + AES-128-ECB 处理媒体文件
 * - QR 扫码登录流程
 *
 * 完全独立于 router-bridge.ts，不影响 Router 模式。
 */

import crypto from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { Logger } from '../utils/logger';
import QRCode from 'qrcode';

const log = new Logger('WeixinBridge');

// ── iLink API 常量 ──────────────────────────────────────
const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com';
const WEIXIN_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
const ILINK_APP_ID = 'bot';
const CHANNEL_VERSION = '2.2.0';
const ILINK_APP_CLIENT_VERSION = (2 << 16) | (2 << 8) | 0;

// 端点
const EP_GET_UPDATES = 'ilink/bot/getupdates';
const EP_SEND_MESSAGE = 'ilink/bot/sendmessage';
const EP_SEND_TYPING = 'ilink/bot/sendtyping';
const EP_GET_CONFIG = 'ilink/bot/getconfig';
const EP_GET_UPLOAD_URL = 'ilink/bot/getuploadurl';
const EP_GET_BOT_QR = 'ilink/bot/get_bot_qrcode';
const EP_GET_QR_STATUS = 'ilink/bot/get_qrcode_status';

// 轮询参数
const LONG_POLL_TIMEOUT_MS = 35_000;
const API_TIMEOUT_MS = 15_000;
const CONFIG_TIMEOUT_MS = 10_000;
const QR_TIMEOUT_MS = 35_000;

const MAX_CONSECUTIVE_FAILURES = 3;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
const SESSION_EXPIRED_ERRCODE = -14;
const MESSAGE_DEDUP_TTL_MS = 300_000;
const MAX_MESSAGE_LENGTH = 4000;

// 消息类型常量
const MSG_TYPE_BOT = 2;
const MSG_STATE_FINISH = 2;
const ITEM_TEXT = 1;
const ITEM_IMAGE = 2;
const ITEM_VOICE = 3;
const ITEM_FILE = 4;
const ITEM_VIDEO = 5;
const TYPING_START = 1;
const TYPING_STOP = 2;

// ── 配置与消息类型 ──────────────────────────────────────
export interface WeixinConfig {
    enabled: boolean;
    accountId: string;
    token: string;
    baseUrl: string;
    cdnBaseUrl: string;
    dmPolicy: 'open' | 'allowlist' | 'disabled';
    allowedUsers: string[];
}

export interface WeixinInboundMessage {
    id: string;
    from_user_id: string;
    content: string;
    content_type: 'text' | 'image' | 'voice' | 'file' | 'video';
    context_token?: string;
    media?: {
        aes_key?: string;
        encrypted_query_param?: string;
        full_url?: string;
        file_name?: string;
    };
}

// ── 工具函数 ────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function randomWechatUin(): string {
    const buf = crypto.randomBytes(4);
    const value = buf.readUInt32BE(0);
    return Buffer.from(String(value), 'utf-8').toString('base64');
}

function jsonDumps(payload: Record<string, unknown>): string {
    return JSON.stringify(payload);
}

function buildHeaders(token: string | null, bodyLen: number): Record<string, string> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'AuthorizationType': 'ilink_bot_token',
        'Content-Length': String(bodyLen),
        'X-WECHAT-UIN': randomWechatUin(),
        'iLink-App-Id': ILINK_APP_ID,
        'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
    };
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
}

/** AES-128-ECB PKCS7 解密 */
function aes128EcbDecrypt(ciphertext: Buffer, key: Buffer): Buffer {
    const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** AES-128-ECB PKCS7 加密 */
function aes128EcbEncrypt(plaintext: Buffer, key: Buffer): Buffer {
    const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
    return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/** 解析 base64 编码的 AES key */
function parseAesKey(aesKeyB64: string): Buffer {
    const decoded = Buffer.from(aesKeyB64, 'base64');
    if (decoded.length === 16) return decoded;
    if (decoded.length === 32) {
        const text = decoded.toString('ascii');
        if (/^[0-9a-fA-F]+$/.test(text)) {
            return Buffer.from(text, 'hex');
        }
    }
    throw new Error(`unexpected aes_key format (${decoded.length} decoded bytes)`);
}

/** 计算加密后的文件大小 */
function aesPaddedSize(size: number): number {
    return Math.ceil((size + 1) / 16) * 16;
}

function safeId(value: string | undefined, keep = 8): string {
    const raw = (value || '').trim();
    if (!raw) return '?';
    return raw.length <= keep ? raw : raw.slice(0, keep);
}

// ── Markdown → 微信格式转换 ──────────────────────────────

const HEADER_RE = /^(#{1,6})\s+(.+?)\s*$/;
const TABLE_RULE_RE = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/;
const FENCE_RE = /^```([^\n`]*)\s*$/;

function rewriteHeaderForWeixin(line: string): string {
    const match = line.match(HEADER_RE);
    if (!match) return line.trimEnd();
    const level = match[1].length;
    const title = match[2].trim();
    return level === 1 ? `【${title}】` : `**${title}**`;
}

function splitTableRow(line: string): string[] {
    let row = line.trim();
    if (row.startsWith('|')) row = row.slice(1);
    if (row.endsWith('|')) row = row.slice(0, -1);
    return row.split('|').map(cell => cell.trim());
}

function rewriteTableBlockForWeixin(lines: string[]): string {
    if (lines.length < 2) return lines.join('\n');
    const headers = splitTableRow(lines[0]);
    const bodyRows = lines.slice(2).filter(l => l.trim()).map(splitTableRow);
    if (!headers.length || !bodyRows.length) return lines.join('\n');

    const formatted: string[] = [];
    for (const row of bodyRows) {
        const pairs: [string, string][] = [];
        for (let i = 0; i < headers.length && i < row.length; i++) {
            const label = headers[i] || `Column ${i + 1}`;
            const value = row[i].trim();
            if (value) pairs.push([label, value]);
        }
        if (!pairs.length) continue;
        if (pairs.length <= 2) {
            formatted.push(`- ${pairs[0][0]}: ${pairs[0][1]}`);
            if (pairs.length === 2) formatted.push(`  ${pairs[1][0]}: ${pairs[1][1]}`);
        } else {
            formatted.push(`- ${pairs.map(([l, v]) => `${l}: ${v}`).join(' | ')}`);
        }
    }
    return formatted.length ? formatted.join('\n') : lines.join('\n');
}

function normalizeMarkdownForWeixin(content: string): string {
    const lines = content.split('\n');
    const result: string[] = [];
    let i = 0;
    let inCodeBlock = false;

    while (i < lines.length) {
        const line = lines[i].trimEnd();
        if (FENCE_RE.test(line.trim())) {
            inCodeBlock = !inCodeBlock;
            result.push(line);
            i++;
            continue;
        }
        if (inCodeBlock) {
            result.push(line);
            i++;
            continue;
        }
        // 检测表格
        if (i + 1 < lines.length && line.includes('|') && TABLE_RULE_RE.test(lines[i + 1].trimEnd())) {
            const tableLines = [line, lines[i + 1].trimEnd()];
            i += 2;
            while (i < lines.length && lines[i].includes('|')) {
                tableLines.push(lines[i].trimEnd());
                i++;
            }
            result.push(rewriteTableBlockForWeixin(tableLines));
            continue;
        }
        result.push(rewriteHeaderForWeixin(line));
        i++;
    }

    let normalized = result.map(l => l.trimEnd()).join('\n');
    normalized = normalized.replace(/\n{3,}/g, '\n\n');
    return normalized.trim();
}

/** 将长消息分割为微信友好的块 */
function splitTextForWeixin(content: string, maxLen = MAX_MESSAGE_LENGTH): string[] {
    if (content.length <= maxLen && !content.includes('\n')) return [content];

    const chunks: string[] = [];
    // 按双换行（段落）分割
    const blocks = content.split(/\n\n+/);
    let current = '';

    for (const block of blocks) {
        const candidate = current ? `${current}\n\n${block}` : block;
        if (candidate.length <= maxLen) {
            current = candidate;
            continue;
        }
        if (current) {
            chunks.push(current);
            current = '';
        }
        if (block.length <= maxLen) {
            current = block;
            continue;
        }
        // 超长块按行分割
        const lines = block.split('\n');
        for (const line of lines) {
            const lineCand = current ? `${current}\n${line}` : line;
            if (lineCand.length <= maxLen) {
                current = lineCand;
            } else {
                if (current) chunks.push(current);
                // 超长单行硬切
                if (line.length > maxLen) {
                    for (let j = 0; j < line.length; j += maxLen) {
                        chunks.push(line.slice(j, j + maxLen));
                    }
                    current = '';
                } else {
                    current = line;
                }
            }
        }
    }
    if (current) chunks.push(current);
    return chunks.length ? chunks : [content];
}

// ── HTTP 请求封装 ────────────────────────────────────────

async function apiPost(
    baseUrl: string,
    endpoint: string,
    payload: Record<string, unknown>,
    token: string | null,
    timeoutMs: number,
): Promise<Record<string, any>> {
    const body = jsonDumps({ ...payload, base_info: { channel_version: CHANNEL_VERSION } });
    const url = `${baseUrl.replace(/\/$/, '')}/${endpoint}`;
    const bodyBuf = Buffer.from(body, 'utf-8');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: buildHeaders(token, bodyBuf.length),
            body,
            signal: controller.signal,
        });
        const text = await response.text();
        if (!response.ok) {
            throw new Error(`iLink POST ${endpoint} HTTP ${response.status}: ${text.slice(0, 200)}`);
        }
        return JSON.parse(text);
    } finally {
        clearTimeout(timer);
    }
}

async function apiGet(
    baseUrl: string,
    endpoint: string,
    timeoutMs: number,
): Promise<Record<string, any>> {
    const url = `${baseUrl.replace(/\/$/, '')}/${endpoint}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'iLink-App-Id': ILINK_APP_ID,
                'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
            },
            signal: controller.signal,
        });
        const text = await response.text();
        if (!response.ok) {
            throw new Error(`iLink GET ${endpoint} HTTP ${response.status}: ${text.slice(0, 200)}`);
        }
        return JSON.parse(text);
    } finally {
        clearTimeout(timer);
    }
}

// ── Context Token 持久化 ─────────────────────────────────

class ContextTokenStore {
    private cache = new Map<string, string>();
    private dir: string;

    constructor(workspace: string) {
        this.dir = join(workspace, 'weixin-accounts');
        if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    }

    private path(accountId: string): string {
        return join(this.dir, `${accountId}.context-tokens.json`);
    }

    restore(accountId: string): void {
        const p = this.path(accountId);
        if (!existsSync(p)) return;
        try {
            const data = JSON.parse(readFileSync(p, 'utf-8'));
            let restored = 0;
            for (const [userId, token] of Object.entries(data)) {
                if (typeof token === 'string' && token) {
                    this.cache.set(`${accountId}:${userId}`, token);
                    restored++;
                }
            }
            if (restored) log.info(`Restored ${restored} context token(s)`);
        } catch (err) {
            log.warn('Failed to restore context tokens', { error: String(err) });
        }
    }

    get(accountId: string, userId: string): string | undefined {
        return this.cache.get(`${accountId}:${userId}`);
    }

    set(accountId: string, userId: string, token: string): void {
        this.cache.set(`${accountId}:${userId}`, token);
        this.persist(accountId);
    }

    private persist(accountId: string): void {
        const prefix = `${accountId}:`;
        const payload: Record<string, string> = {};
        for (const [key, value] of this.cache) {
            if (key.startsWith(prefix)) {
                payload[key.slice(prefix.length)] = value;
            }
        }
        try {
            writeFileSync(this.path(accountId), JSON.stringify(payload), 'utf-8');
        } catch (err) {
            log.warn('Failed to persist context tokens', { error: String(err) });
        }
    }
}

// ── Typing Ticket 缓存 ───────────────────────────────────

class TypingTicketCache {
    private cache = new Map<string, { ticket: string; at: number }>();
    private ttl: number;

    constructor(ttlMs = 600_000) {
        this.ttl = ttlMs;
    }

    get(userId: string): string | null {
        const entry = this.cache.get(userId);
        if (!entry) return null;
        if (Date.now() - entry.at >= this.ttl) {
            this.cache.delete(userId);
            return null;
        }
        return entry.ticket;
    }

    set(userId: string, ticket: string): void {
        this.cache.set(userId, { ticket, at: Date.now() });
    }
}

// ── Sync Buf 持久化 ──────────────────────────────────────

function loadSyncBuf(workspace: string, accountId: string): string {
    const p = join(workspace, 'weixin-accounts', `${accountId}.sync.json`);
    if (!existsSync(p)) return '';
    try {
        return JSON.parse(readFileSync(p, 'utf-8')).get_updates_buf || '';
    } catch {
        return '';
    }
}

function saveSyncBuf(workspace: string, accountId: string, syncBuf: string): void {
    const dir = join(workspace, 'weixin-accounts');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    try {
        writeFileSync(join(dir, `${accountId}.sync.json`), JSON.stringify({ get_updates_buf: syncBuf }), 'utf-8');
    } catch { /* ignore */ }
}

// ── 消息内容提取 ──────────────────────────────────────────

function extractText(itemList: any[]): string {
    for (const item of itemList) {
        if (item.type === ITEM_TEXT) {
            const text = String(item.text_item?.text || '');
            const ref = item.ref_msg || {};
            const refItem = ref.message_item || {};
            const refType = refItem.type;
            if ([ITEM_IMAGE, ITEM_VIDEO, ITEM_FILE, ITEM_VOICE].includes(refType)) {
                const title = ref.title || '';
                const prefix = title ? `[引用媒体: ${title}]\n` : '[引用媒体]\n';
                return `${prefix}${text}`.trim();
            }
            if (refItem.type) {
                const parts: string[] = [];
                if (ref.title) parts.push(String(ref.title));
                const refText = extractText([refItem]);
                if (refText) parts.push(refText);
                if (parts.length) return `[引用: ${parts.join(' | ')}]\n${text}`.trim();
            }
            return text;
        }
    }
    // 语音转文字
    for (const item of itemList) {
        if (item.type === ITEM_VOICE) {
            const voiceText = String(item.voice_item?.text || '');
            if (voiceText) return voiceText;
        }
    }
    return '';
}

function getMediaFromItem(item: any): { type: string; media: any; fileName?: string } | null {
    if (item.type === ITEM_IMAGE) {
        const media = item.image_item?.media || {};
        return { type: 'image', media };
    }
    if (item.type === ITEM_VIDEO) {
        const media = item.video_item?.media || {};
        return { type: 'video', media };
    }
    if (item.type === ITEM_FILE) {
        const fileItem = item.file_item || {};
        return { type: 'file', media: fileItem.media || {}, fileName: fileItem.file_name };
    }
    if (item.type === ITEM_VOICE) {
        if (item.voice_item?.text) return null; // 有文字转写，跳过二进制
        return { type: 'voice', media: item.voice_item?.media || {} };
    }
    return null;
}

function guessChatType(message: any, accountId: string): { chatType: string; chatId: string } {
    const roomId = String(message.room_id || message.chat_room_id || '').trim();
    const toUserId = String(message.to_user_id || '').trim();
    const isGroup = !!roomId || (toUserId && accountId && toUserId !== accountId && message.msg_type === 1);
    if (isGroup) {
        return { chatType: 'group', chatId: roomId || toUserId || String(message.from_user_id || '') };
    }
    return { chatType: 'dm', chatId: String(message.from_user_id || '') };
}

// ══════════════════════════════════════════════════════════
// WeixinBridge 主类
// ══════════════════════════════════════════════════════════

export class WeixinBridge {
    // ── 外部回调 ──
    onMessage: ((msg: WeixinInboundMessage) => Promise<void>) | null = null;
    onConnectionChange: ((status: 'connected' | 'disconnected' | 'expired') => void) | null = null;
    onQRCode: ((data: { qrUrl: string; qrImgContent?: string; expire: number }) => void) | null = null;
    onQRStatus: ((data: { status: string; message: string }) => void) | null = null;
    onLoginSuccess: ((data: { accountId: string; token: string; baseUrl: string }) => void) | null = null;

    // ── 内部状态 ──
    private running = false;
    private _connected = false;
    private config: WeixinConfig;
    private workspace: string;
    private tokenStore: ContextTokenStore;
    private typingCache = new TypingTicketCache();
    private seenMessages = new Map<string, number>();
    private syncBuf = '';

    constructor(config: WeixinConfig, workspace: string) {
        this.config = { ...config };
        if (!this.config.baseUrl) this.config.baseUrl = ILINK_BASE_URL;
        if (!this.config.cdnBaseUrl) this.config.cdnBaseUrl = WEIXIN_CDN_BASE_URL;
        this.workspace = workspace;
        this.tokenStore = new ContextTokenStore(workspace);
    }

    get connected(): boolean {
        return this._connected;
    }

    getStatus(): { connected: boolean; enabled: boolean; accountId: string } {
        return {
            connected: this._connected,
            enabled: this.config.enabled,
            accountId: this.config.accountId || '',
        };
    }

    getRawConfig(): WeixinConfig {
        return { ...this.config };
    }

    updateConfig(newConfig: Partial<WeixinConfig>): void {
        Object.assign(this.config, newConfig);
    }

    // ── 启动/停止 ────────────────────────────────────────

    async start(): Promise<void> {
        if (!this.config.token) {
            log.warn('Cannot start: token not configured');
            return;
        }
        if (!this.config.accountId) {
            log.warn('Cannot start: accountId not configured');
            return;
        }

        this.running = true;
        this.tokenStore.restore(this.config.accountId);
        this.syncBuf = loadSyncBuf(this.workspace, this.config.accountId);

        log.info('Starting Long-poll loop', {
            account: safeId(this.config.accountId),
            base: this.config.baseUrl,
        });

        this._connected = true;
        this.onConnectionChange?.('connected');

        // 非阻塞启动轮询
        this.pollLoop().catch(err => {
            log.error('Poll loop fatal error', { error: String(err) });
            this._connected = false;
            this.onConnectionChange?.('disconnected');
        });
    }

    stop(): void {
        this.running = false;
        this._connected = false;
        this.onConnectionChange?.('disconnected');
        log.info('Stopped');
    }

    // ── Long-Poll 循环 ───────────────────────────────────

    private async pollLoop(): Promise<void> {
        let consecutiveFailures = 0;
        let timeoutMs = LONG_POLL_TIMEOUT_MS;

        while (this.running) {
            try {
                const response = await apiPost(
                    this.config.baseUrl,
                    EP_GET_UPDATES,
                    { get_updates_buf: this.syncBuf },
                    this.config.token,
                    timeoutMs + 5000, // HTTP timeout 略大于 long-poll timeout
                );

                // 调整服务器建议的超时
                const suggestedTimeout = response.longpolling_timeout_ms;
                if (typeof suggestedTimeout === 'number' && suggestedTimeout > 0) {
                    timeoutMs = suggestedTimeout;
                }

                const ret = response.ret ?? 0;
                const errcode = response.errcode ?? 0;

                // 错误处理
                if (ret !== 0 && ret !== null || errcode !== 0 && errcode !== null) {
                    // Session 过期
                    if (ret === SESSION_EXPIRED_ERRCODE || errcode === SESSION_EXPIRED_ERRCODE) {
                        log.error('Session expired, stopping');
                        this._connected = false;
                        this.onConnectionChange?.('expired');
                        this.running = false;
                        return;
                    }
                    consecutiveFailures++;
                    log.warn('getUpdates failed', {
                        ret, errcode,
                        errmsg: response.errmsg || '',
                        failures: `${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}`,
                    });
                    await sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS);
                    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0;
                    continue;
                }

                // 成功
                consecutiveFailures = 0;
                const newSyncBuf = String(response.get_updates_buf || '');
                if (newSyncBuf) {
                    this.syncBuf = newSyncBuf;
                    saveSyncBuf(this.workspace, this.config.accountId, this.syncBuf);
                }

                // 处理每条消息
                const msgs = response.msgs || [];
                for (const msg of msgs) {
                    this.processMessageSafe(msg);
                }
            } catch (err: any) {
                // Abort (timeout) 不是真错误
                if (err?.name === 'AbortError') {
                    continue;
                }
                consecutiveFailures++;
                log.error('Poll error', {
                    error: String(err),
                    failures: `${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}`,
                });
                await sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS);
                if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0;
            }
        }
    }

    // ── 消息处理 ──────────────────────────────────────────

    private processMessageSafe(raw: any): void {
        this.processMessage(raw).catch(err => {
            log.error('Unhandled inbound error', {
                from: safeId(raw?.from_user_id),
                error: String(err),
            });
        });
    }

    private async processMessage(message: any): Promise<void> {
        const senderId = String(message.from_user_id || '').trim();
        if (!senderId) return;
        // 跳过自己发的消息
        if (senderId === this.config.accountId) return;

        // 消息去重
        const messageId = String(message.message_id || '').trim();
        if (messageId) {
            const now = Date.now();
            // 清理过期
            for (const [key, ts] of this.seenMessages) {
                if (now - ts >= MESSAGE_DEDUP_TTL_MS) this.seenMessages.delete(key);
            }
            if (this.seenMessages.has(messageId)) return;
            this.seenMessages.set(messageId, now);
        }

        // 群聊/DM 策略过滤
        const { chatType } = guessChatType(message, this.config.accountId);
        if (chatType === 'group') {
            // 群消息默认禁用
            return;
        }
        if (!this.isDmAllowed(senderId)) return;

        // 保存 context_token
        const contextToken = String(message.context_token || '').trim();
        if (contextToken) {
            this.tokenStore.set(this.config.accountId, senderId, contextToken);
        }

        // 异步获取 typing ticket（不阻塞消息处理）
        this.fetchTypingTicket(senderId, contextToken || undefined).catch(() => { });

        // 提取文本和媒体
        const itemList = message.item_list || [];
        const text = extractText(itemList);

        // 检查是否有媒体
        let firstMedia: { type: string; media: any; fileName?: string } | null = null;
        for (const item of itemList) {
            const m = getMediaFromItem(item);
            if (m) { firstMedia = m; break; }
        }

        if (!text && !firstMedia) return;

        // 构建入站消息
        const contentType: WeixinInboundMessage['content_type'] =
            firstMedia?.type === 'image' ? 'image' :
            firstMedia?.type === 'video' ? 'video' :
            firstMedia?.type === 'voice' ? 'voice' :
            firstMedia?.type === 'file' ? 'file' : 'text';

        const inbound: WeixinInboundMessage = {
            id: messageId || crypto.randomUUID(),
            from_user_id: senderId,
            content: text,
            content_type: contentType,
            context_token: contextToken || undefined,
        };

        if (firstMedia && firstMedia.media) {
            inbound.media = {
                encrypted_query_param: firstMedia.media.encrypt_query_param,
                aes_key: firstMedia.media.aes_key,
                full_url: firstMedia.media.full_url,
                file_name: firstMedia.fileName,
            };
        }

        log.info('Inbound message', {
            from: safeId(senderId),
            type: contentType,
            hasMedia: !!firstMedia,
            textLen: text.length,
        });

        // 分发给回调
        if (this.onMessage) {
            await this.onMessage(inbound);
        }
    }

    private isDmAllowed(senderId: string): boolean {
        if (this.config.dmPolicy === 'disabled') return false;
        if (this.config.dmPolicy === 'allowlist') {
            return this.config.allowedUsers.includes(senderId);
        }
        return true; // open
    }

    // ── 发送消息 ──────────────────────────────────────────

    async sendText(to: string, content: string): Promise<boolean> {
        if (!this.config.token) return false;

        const formatted = normalizeMarkdownForWeixin(content);
        const chunks = splitTextForWeixin(formatted);
        const contextToken = this.tokenStore.get(this.config.accountId, to);

        try {
            for (const chunk of chunks) {
                const clientId = `openflux-wx-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
                const msg: Record<string, any> = {
                    from_user_id: '',
                    to_user_id: to,
                    client_id: clientId,
                    message_type: MSG_TYPE_BOT,
                    message_state: MSG_STATE_FINISH,
                    item_list: [{ type: ITEM_TEXT, text_item: { text: chunk } }],
                };
                if (contextToken) msg.context_token = contextToken;

                await apiPost(
                    this.config.baseUrl,
                    EP_SEND_MESSAGE,
                    { msg },
                    this.config.token,
                    API_TIMEOUT_MS,
                );

                // 多条消息间短暂延迟，避免发送过快
                if (chunks.length > 1) await sleep(300);
            }
            return true;
        } catch (err) {
            log.error('Send failed', { to: safeId(to), error: String(err) });
            return false;
        }
    }

    // ── 打字状态 ──────────────────────────────────────────

    async sendTyping(to: string, start: boolean): Promise<void> {
        if (!this.config.token) return;
        const ticket = this.typingCache.get(to);
        if (!ticket) return;

        try {
            await apiPost(
                this.config.baseUrl,
                EP_SEND_TYPING,
                {
                    ilink_user_id: to,
                    typing_ticket: ticket,
                    status: start ? TYPING_START : TYPING_STOP,
                },
                this.config.token,
                CONFIG_TIMEOUT_MS,
            );
        } catch (err) {
            log.debug(`Typing ${start ? 'start' : 'stop'} failed`, { to: safeId(to), error: String(err) });
        }
    }

    private async fetchTypingTicket(userId: string, contextToken?: string): Promise<void> {
        if (!this.config.token) return;
        if (this.typingCache.get(userId)) return;

        try {
            const payload: Record<string, any> = { ilink_user_id: userId };
            if (contextToken) payload.context_token = contextToken;

            const response = await apiPost(
                this.config.baseUrl,
                EP_GET_CONFIG,
                payload,
                this.config.token,
                CONFIG_TIMEOUT_MS,
            );
            const ticket = String(response.typing_ticket || '');
            if (ticket) this.typingCache.set(userId, ticket);
        } catch (err) {
            log.debug('getConfig failed', { userId: safeId(userId), error: String(err) });
        }
    }

    // ── 媒体下载 ──────────────────────────────────────────

    async downloadMedia(msg: WeixinInboundMessage): Promise<{
        localPath: string; size: number; fileName: string; ext: string;
    } | null> {
        if (!msg.media) return null;

        const { encrypted_query_param, aes_key, full_url, file_name } = msg.media;
        let downloadUrl: string;

        if (encrypted_query_param) {
            downloadUrl = `${this.config.cdnBaseUrl.replace(/\/$/, '')}/download?encrypted_query_param=${encodeURIComponent(encrypted_query_param)}`;
        } else if (full_url) {
            downloadUrl = full_url;
        } else {
            log.warn('Media item has no download source');
            return null;
        }

        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 60_000);
            const response = await fetch(downloadUrl, { signal: controller.signal });
            clearTimeout(timer);

            if (!response.ok) throw new Error(`CDN download HTTP ${response.status}`);
            let data: Buffer = Buffer.from(await response.arrayBuffer());

            // AES 解密
            if (aes_key) {
                data = Buffer.from(aes128EcbDecrypt(data, parseAesKey(aes_key)));
            }

            // 确定文件名和扩展名
            const extMap: Record<string, string> = {
                image: '.jpg', video: '.mp4', voice: '.silk', file: '.dat',
            };
            const ext = file_name
                ? `.${file_name.split('.').pop() || 'dat'}`
                : (extMap[msg.content_type] || '.dat');
            const safeName = `wx_${msg.id.slice(0, 8)}_${file_name || `media${ext}`}`;

            // 保存到 workspace 临时目录
            const mediaDir = join(this.workspace, 'weixin-media');
            if (!existsSync(mediaDir)) mkdirSync(mediaDir, { recursive: true });
            const localPath = join(mediaDir, safeName);
            writeFileSync(localPath, data);

            log.info('Media downloaded', { size: data.length, file: safeName });
            return { localPath, size: data.length, fileName: file_name || safeName, ext };
        } catch (err) {
            log.error('Media download failed', { error: String(err) });
            return null;
        }
    }

    // ── QR 扫码登录 ──────────────────────────────────────

    async startQRLogin(): Promise<void> {
        log.info('Starting QR login flow');

        try {
            log.info('Fetching QR code from iLink API...');
            const qrResp = await apiGet(
                ILINK_BASE_URL,
                `${EP_GET_BOT_QR}?bot_type=3`,
                QR_TIMEOUT_MS,
            );

            log.info('QR API response received', { keys: Object.keys(qrResp), hasQrcode: !!qrResp.qrcode, hasImg: !!qrResp.qrcode_img_content });

            const qrcodeValue = String(qrResp.qrcode || '');
            const qrcodeImgContent = String(qrResp.qrcode_img_content || '');
            if (!qrcodeValue) {
                log.error('QR response missing qrcode', { resp: JSON.stringify(qrResp).slice(0, 500) });
                this.onQRStatus?.({ status: 'error', message: 'QR 码获取失败' });
                return;
            }

            // 用 qrcode 库生成 QR 码 data URL（qrcode_img_content 是网页 URL，非图片）
            const qrContent = qrcodeImgContent || qrcodeValue;
            let qrDataUrl: string;
            try {
                qrDataUrl = await QRCode.toDataURL(qrContent, { width: 300, margin: 2 });
                log.info('QR code generated as data URL', { dataLen: qrContent.length });
            } catch (qrErr) {
                log.error('Failed to generate QR code image', { error: String(qrErr) });
                this.onQRStatus?.({ status: 'error', message: 'QR 码图片生成失败' });
                return;
            }

            // 推送 QR 给前端
            this.onQRCode?.({
                qrUrl: qrcodeValue,
                qrImgContent: qrDataUrl,
                expire: 300,
            });

            // 轮询扫码状态
            let currentBaseUrl = ILINK_BASE_URL;
            let refreshCount = 0;
            const deadline = Date.now() + 480_000; // 8 分钟超时
            log.info('Entering QR poll loop', { qrcodeValue: qrcodeValue.slice(0, 8), deadline: new Date(deadline).toISOString() });

            let qrCancelled = false;
            while (Date.now() < deadline && !qrCancelled) {
                try {
                    log.info('QR poll: sending status request...');
                    const statusResp = await apiGet(
                        currentBaseUrl,
                        `${EP_GET_QR_STATUS}?qrcode=${qrcodeValue}`,
                        QR_TIMEOUT_MS,
                    );

                    const status = String(statusResp.status || 'wait');
                    log.info('QR poll status', { status, keys: Object.keys(statusResp), raw: JSON.stringify(statusResp).slice(0, 300) });

                    if (status === 'wait') {
                        // 等待扫描
                    } else if (status === 'scaned') {
                        this.onQRStatus?.({ status: 'scanned', message: '已扫码，请在微信中确认' });
                    } else if (status === 'scaned_but_redirect') {
                        const redirectHost = String(statusResp.redirect_host || '');
                        if (redirectHost) currentBaseUrl = `https://${redirectHost}`;
                    } else if (status === 'expired') {
                        refreshCount++;
                        if (refreshCount > 3) {
                            this.onQRStatus?.({ status: 'error', message: 'QR 码多次过期，请重试' });
                            return;
                        }
                        this.onQRStatus?.({ status: 'expired', message: `QR 码已过期，正在刷新 (${refreshCount}/3)` });
                        // 刷新 QR
                        const newQr = await apiGet(ILINK_BASE_URL, `${EP_GET_BOT_QR}?bot_type=3`, QR_TIMEOUT_MS);
                        const newVal = String(newQr.qrcode || '');
                        const newImgUrl = String(newQr.qrcode_img_content || '');
                        if (newVal) {
                            try {
                                const newDataUrl = await QRCode.toDataURL(newImgUrl || newVal, { width: 300, margin: 2 });
                                this.onQRCode?.({ qrUrl: newVal, qrImgContent: newDataUrl, expire: 300 });
                            } catch { /* ignore */ }
                        }
                    } else if (status === 'confirmed') {
                        const accountId = String(statusResp.ilink_bot_id || '');
                        const token = String(statusResp.bot_token || '');
                        const baseUrl = String(statusResp.baseurl || ILINK_BASE_URL);

                        if (!accountId || !token) {
                            log.error('QR confirmed but credentials incomplete');
                            this.onQRStatus?.({ status: 'error', message: '登录凭据不完整' });
                            return;
                        }

                        // 更新自身配置
                        this.config.accountId = accountId;
                        this.config.token = token;
                        this.config.baseUrl = baseUrl;
                        this.config.enabled = true;

                        log.info('QR login successful', { account: safeId(accountId) });
                        this.onQRStatus?.({ status: 'confirmed', message: '微信连接成功' });
                        this.onLoginSuccess?.({ accountId, token, baseUrl });

                        // 自动启动轮询
                        this.start().catch(err => log.error('Auto-start after QR login failed', { error: String(err) }));
                        return;
                    }
                } catch (err: any) {
                    log.warn('QR poll error', { name: err?.name, error: String(err) });
                }

                await sleep(1500);
            }

            this.onQRStatus?.({ status: 'timeout', message: '登录超时，请重试' });
        } catch (err) {
            log.error('QR login failed', { error: String(err) });
            this.onQRStatus?.({ status: 'error', message: String(err) });
        }
    }
}
