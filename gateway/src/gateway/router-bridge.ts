/**
 * OpenFluxRouter 桥接器
 * 在 Gateway Server 中管理与 OpenFluxRouter 的 WebSocket 连接
 * 负责消息透传：入站消息推送给客户端，出站消息转发到 Router
 */

// @ts-ignore - 运行时有 ws 模块
import WebSocket from 'ws';
import { Logger } from '../utils/logger';

const log = new Logger('RouterBridge');

// ========================
// 类型定义
// ========================

/** Router 连接配置 */
export interface RouterConfig {
    /** WebSocket 地址，如 ws://host:8080/ws/app */
    url: string;
    /** 应用 ID */
    appId: string;
    /** 应用类型：openflux / opencrawl */
    appType: string;
    /** API Key */
    apiKey: string;
    /** 应用用户 ID（随机生成的实例标识） */
    appUserId: string;
    /** 是否启用 */
    enabled: boolean;
}

/** 入站消息（企业 IM → AI 应用） */
export interface RouterInboundMessage {
    id: string;
    platform_type: string;      // feishu / dingtalk / wecom
    platform_id: string;
    platform_user_id: string;
    app_type: string;
    app_id: string;
    app_user_id?: string;
    direction: 'inbound';
    content_type: string;       // text / image / file
    content: string;
    metadata?: Record<string, unknown>;
    timestamp: number;
}

/** 出站消息（AI 应用 → 企业 IM） */
export interface RouterOutboundMessage {
    platform_type: string;
    platform_id: string;
    platform_user_id: string;
    content_type: string;       // text / image
    content: string;
}

/** 加密的 provider 凭据（WebSocket 下发格式） */
interface EncryptedProvider {
    api_key_encrypted: string;
    iv: string;
    base_url?: string;
}

interface ManagedRuntimeRouting {
    modules?: Record<string, string>;
    providers?: Record<string, string>;
}

/** managed_runtime_config WebSocket 消息结构 */
export interface ManagedRuntimeConfigMessage {
    action: 'managed_runtime_config';
    version: number;
    quota?: { daily_limit: number; used_today: number };
    profiles: {
        orchestration: { provider: string; model: string };
        router?: { provider: string; model: string };
        subagent?: { provider: string; model: string };
    };
    providers: Record<string, EncryptedProvider>;
    web?: {
        search?: {
            provider: string;
            api_key_encrypted?: string;
            iv?: string;
            max_results?: number;
            timeout_seconds?: number;
            cache_ttl_minutes?: number;
            perplexity?: {
                api_key_encrypted?: string;
                iv?: string;
                base_url?: string;
                model?: string;
            };
        };
    };
    routing?: ManagedRuntimeRouting;
}

// ========================
// RouterBridge
// ========================

export class RouterBridge {
    private ws: WebSocket | null = null;
    private config: RouterConfig | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectCount = 0;
    private reconnectInterval = 5000;
    private pingTimer: ReturnType<typeof setInterval> | null = null;
    private connected = false;
    private destroyed = false;
    private bound = false;

    /** 入站消息回调 */
    onMessage: ((msg: RouterInboundMessage) => void) | null = null;
    /** 连接状态变化回调 */
    onConnectionChange: ((status: 'connecting' | 'connected' | 'disconnected' | 'error') => void) | null = null;
    /** 绑定结果回调 */
    onBindResult: ((result: { action: string; status: string; message?: string }) => void) | null = null;
    /** 连接状态推送回调（Router 连接后自动推送绑定状态） */
    onConnectStatus: ((status: { bound: boolean; platform_user_id?: string; platform_id?: string }) => void) | null = null;
    /** LLM 配置下发回调（旧协议，兼容） */
    onLlmConfig: ((config: {
        provider: string;
        model: string;
        api_key_encrypted: string;
        iv: string;
        base_url?: string;
        quota?: { daily_limit: number; used_today: number };
    }) => void) | null = null;
    /** 团队托管运行配置回调（新协议） */
    onManagedRuntimeConfig: ((config: ManagedRuntimeConfigMessage) => void) | null = null;

    /**
     * 连接到 OpenFluxRouter
     */
    connect(config: RouterConfig): void {
        this.config = config;
        this.destroyed = false;
        this.reconnectCount = 0;

        if (!config.enabled) {
            log.info('Router not enabled, skipping connection');
            return;
        }

        this.doConnect();
    }

    /**
     * 更新配置并重连
     */
    updateConfig(config: RouterConfig): void {
        const wasConnected = this.connected;
        this.disconnect();
        this.config = config;

        if (config.enabled) {
            this.destroyed = false;
            this.reconnectCount = 0;
            this.doConnect();
        }
    }

    /**
     * 断开连接
     */
    disconnect(): void {
        this.destroyed = true;
        this.clearTimers();

        if (this.ws) {
            try {
                this.ws.close(1000, '手动断开');
            } catch { /* ignore */ }
            this.ws = null;
        }

        if (this.connected) {
            this.connected = false;
            this.onConnectionChange?.('disconnected');
        }
    }

    /**
     * 发送出站消息到 Router
     */
    send(msg: RouterOutboundMessage): boolean {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            log.warn('Router not connected, cannot send message');
            return false;
        }

        try {
            this.ws.send(JSON.stringify(msg));
            log.info('Outbound message sent', {
                platform: msg.platform_type,
                userId: msg.platform_user_id,
            });
            return true;
        } catch (err) {
            log.error('Send message failed', { error: err });
            return false;
        }
    }

    /**
     * 发送绑定命令
     */
    bind(code: string): boolean {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            log.warn('Router not connected, cannot send bind command');
            return false;
        }
        try {
            this.ws.send(JSON.stringify({ action: 'bind', code }));
            log.info('Bind command sent', { code });
            return true;
        } catch (err) {
            log.error('Send bind command failed', { error: err });
            return false;
        }
    }

    /**
     * 获取连接状态
     */
    getStatus(): { connected: boolean; bound: boolean; config: Omit<RouterConfig, 'apiKey'> & { apiKey: string } | null } {
        if (!this.config) {
            return { connected: false, bound: false, config: null };
        }
        return {
            connected: this.connected,
            bound: this.bound,
            config: {
                ...this.config,
                apiKey: this.maskKey(this.config.apiKey),
            },
        };
    }

    /**
     * 获取原始配置（不脱敏，用于保存）
     */
    getRawConfig(): RouterConfig | null {
        return this.config;
    }

    /**
     * 测试连接（使用临时 WebSocket，不影响当前连接状态）
     */
    async testConnection(config: Partial<RouterConfig>): Promise<{ success: boolean; message: string; latencyMs?: number }> {
        const url = config.url;
        const appId = config.appId;
        const appType = config.appType || 'openflux';
        const apiKey = config.apiKey || this.config?.apiKey;

        if (!url || !appId || !apiKey) {
            return { success: false, message: '配置不完整：需要 URL、App ID 和 API Key' };
        }

        const startTime = Date.now();

        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                try { testWs.close(); } catch { /* ignore */ }
                resolve({ success: false, message: '连接超时（5秒）' });
            }, 5000);

            let testWs: WebSocket;
            try {
                testWs = new WebSocket(url, {
                    headers: {
                        'X-App-ID': appId,
                        'X-App-Type': appType,
                        'X-App-User-ID': config.appUserId || '',
                        'Authorization': `Bearer ${apiKey}`,
                    },
                });
            } catch (err) {
                clearTimeout(timeout);
                resolve({ success: false, message: `创建连接失败: ${(err as Error).message}` });
                return;
            }

            testWs.on('open', () => {
                clearTimeout(timeout);
                const latencyMs = Date.now() - startTime;
                try { testWs.close(1000, 'test'); } catch { /* ignore */ }
                resolve({ success: true, message: `连接成功 (${latencyMs}ms)`, latencyMs });
            });

            testWs.on('error', (err: Error) => {
                clearTimeout(timeout);
                try { testWs.close(); } catch { /* ignore */ }
                resolve({ success: false, message: `连接失败: ${err.message}` });
            });
        });
    }

    /**
     * 销毁（关闭时调用）
     */
    destroy(): void {
        this.disconnect();
    }

    // ========================
    // 内部方法
    // ========================

    private doConnect(): void {
        if (!this.config || this.destroyed) return;

        const { url, appId, appType, apiKey } = this.config;

        if (!url || !appId || !apiKey) {
            log.warn('Router config incomplete, skipping connection');
            return;
        }

        this.onConnectionChange?.('connecting');
        log.info('Connecting to OpenFluxRouter...', { url, appId, appType });

        try {
            this.ws = new WebSocket(url, {
                headers: {
                    'X-App-ID': appId,
                    'X-App-Type': appType,
                    'X-App-User-ID': this.config.appUserId || '',
                    'Authorization': `Bearer ${apiKey}`,
                },
            });

            this.ws.on('open', () => {
                this.connected = true;
                this.reconnectCount = 0;
                log.info('Connected to OpenFluxRouter');
                this.onConnectionChange?.('connected');
                this.startPing();
            });

            this.ws.on('message', (data: WebSocket.Data) => {
                try {
                    const raw = data.toString();
                    const msg = JSON.parse(raw);

                    if (msg.direction === 'inbound' && this.onMessage) {
                        log.info('Received inbound message', {
                            platform: msg.platform_type,
                            userId: msg.platform_user_id,
                            contentType: msg.content_type,
                        });
                        this.onMessage(msg as RouterInboundMessage);
                    } else if (msg.action === 'bind_result') {
                        log.info('Received bind result', { status: msg.status });
                        if (msg.status === 'matched') this.bound = true;
                        this.onBindResult?.(msg);
                    } else if (msg.action === 'connect_status') {
                        log.info('Received connection status push', { bound: msg.bound });
                        this.bound = !!msg.bound;
                        this.onConnectStatus?.(msg);
                    } else if (msg.action === 'llm_config') {
                        log.info('Received LLM config push', { provider: msg.provider, model: msg.model });
                        this.onLlmConfig?.(msg);
                    } else if (msg.action === 'managed_runtime_config') {
                        log.info('Received managed runtime config push', { version: msg.version });
                        this.onManagedRuntimeConfig?.(msg as ManagedRuntimeConfigMessage);
                    }
                } catch (err) {
                    log.error('Failed to parse Router message', { error: err });
                }
            });

            this.ws.on('close', (code: number, reason: Buffer) => {
                const wasConnected = this.connected;
                this.connected = false;
                this.stopPing();
                log.info(`Router connection closed: code=${code} reason=${reason?.toString() || ''}`);

                if (wasConnected) {
                    this.onConnectionChange?.('disconnected');
                }

                if (!this.destroyed) {
                    this.tryReconnect();
                }
            });

            this.ws.on('error', (err: Error) => {
                log.error('Router connection error', { message: err.message });
                // error 事件后通常会触发 close 事件，重连逻辑在 close 中处理
            });

            this.ws.on('pong', () => {
                // 收到 pong，连接正常
            });

        } catch (err) {
            log.error('Failed to create Router connection', { error: err });
            this.onConnectionChange?.('error');
            if (!this.destroyed) {
                this.tryReconnect();
            }
        }
    }

    private tryReconnect(): void {
        if (this.destroyed || this.reconnectTimer) return;

        this.reconnectCount++;
        // 递增重连间隔：5s → 10s → 30s → 60s（封顶）
        const delay = Math.min(this.reconnectInterval * Math.pow(1.5, Math.min(this.reconnectCount - 1, 6)), 60000);
        log.info(`Router will reconnect in ${(delay / 1000).toFixed(0)}s (attempt #${this.reconnectCount})`);

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.doConnect();
        }, delay);
    }

    private startPing(): void {
        this.stopPing();
        this.pingTimer = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.ping();
            }
        }, 30000);
    }

    private stopPing(): void {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
    }

    private clearTimers(): void {
        this.stopPing();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    private maskKey(key?: string): string {
        if (!key) return '';
        if (key.length <= 12) return '****';
        return key.slice(0, 8) + '****' + key.slice(-4);
    }

    /**
     * 上报 LLM 调用用量到 Router
     */
    reportUsage(tokensIn: number, tokensOut: number): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        try {
            this.ws.send(JSON.stringify({
                action: 'llm_usage',
                tokens_in: tokensIn,
                tokens_out: tokensOut,
                timestamp: Date.now(),
            }));
        } catch { /* ignore */ }
    }
}
