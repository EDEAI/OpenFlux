/**
 * OpenFluxRouter bridge
 * Managing WebSocket connections to OpenFluxRouter in Gateway Server
 * Responsible for transparent message transmission: inbound messages are pushed to the client and outbound messages are forwarded to the Router
 */

// @ts-ignore - Runtime with ws module
import WebSocket from 'ws';
import { Logger } from '../utils/logger';

const log = new Logger('RouterBridge');

// ========================
// type definition
// ========================

/** Router connection configuration */
export interface RouterConfig {
    /** WebSocket address, such as ws://host:8080/ws/app */
    url: string;
    /** Application ID */
    appId: string;
    /** Application type: openflux/opencrawl */
    appType: string;
    /** API Key */
    apiKey: string;
    /** Application user ID (randomly generated instance ID) */
    appUserId: string;
    /** Whether to enable */
    enabled: boolean;
}

/** Inbound messaging (Enterprise IM -> AI application) */
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

/** Outbound messaging (AI applications -> Enterprise IM) */
export interface RouterOutboundMessage {
    platform_type: string;
    platform_id: string;
    platform_user_id: string;
    content_type: string;       // text / image
    content: string;
}

/** Encrypted provider credentials (WebSocket delivery format) */
interface EncryptedProvider {
    api_key_encrypted: string;
    iv: string;
    base_url?: string;
}

interface ManagedRuntimeRouting {
    modules?: Record<string, string>;
    providers?: Record<string, string>;
}

/** managed_runtime_config WebSocket message structure */
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

export interface RouterQRBindCodeMessage {
    action: 'qr_bind_code';
    status: string;
    code?: string;
    qr_data?: string;
    expires_in?: number;
    message?: string;
    [key: string]: unknown;
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

    /** Inbound message callback */
    onMessage: ((msg: RouterInboundMessage) => void) | null = null;
    /** Connection status change callback */
    onConnectionChange: ((status: 'connecting' | 'connected' | 'disconnected' | 'error') => void) | null = null;
    /** Binding result callback */
    onBindResult: ((result: { action: string; status: string; message?: string }) => void) | null = null;
    /** Connection status push callback (Router automatically pushes binding status after connecting) */
    onConnectStatus: ((status: { bound: boolean; platform_user_id?: string; platform_id?: string }) => void) | null = null;
    /** LLM configuration delivery callback (old protocol, compatible) */
    onLlmConfig: ((config: {
        provider: string;
        model: string;
        api_key_encrypted: string;
        iv: string;
        base_url?: string;
        quota?: { daily_limit: number; used_today: number };
    }) => void) | null = null;
    /** Team hosting run configuration callback (new protocol) */
    onManagedRuntimeConfig: ((config: ManagedRuntimeConfigMessage) => void) | null = null;
    /** QR binding code generation callback (desktop client receives QR data for rendering QR code) */
    onQRBindCode: ((data: RouterQRBindCodeMessage) => void) | null = null;
    /** QR binding successful callback (the desktop client receives a notification after the App scans the QR code) */
    onQRBindSuccess: ((data: { action: string; bound_device: string; platform_id: string; message: string }) => void) | null = null;

    /**
     * Connect to OpenFluxRouter
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
     * Update configuration and reconnect
     */
    updateConfig(config: RouterConfig): void {
        if (!config.enabled) {
            // User actively disabled: permanently disconnected and no longer reconnected
            this.permanentDisconnect();
            this.config = config;
            return;
        }

        // Configuration change reconnection: first disconnect the old connection (without destroying), then connect with the new configuration
        this.disconnect();
        this.config = config;
        this.destroyed = false;
        this.reconnectCount = 0;
        this.doConnect();
    }

    /**
     * Disconnect (internal call: do not prevent automatic reconnection)
     */
    disconnect(): void {
        this.clearTimers();

        if (this.ws) {
            const oldWs = this.ws;
            this.ws = null;
            oldWs.removeAllListeners();
            try {
                oldWs.close(1000, '断开重连');
            } catch { /* ignore */ }
        }

        if (this.connected) {
            this.connected = false;
            this.onConnectionChange?.('disconnected');
        }
    }

    /**
     * Permanent disconnection (called when the user actively disables/destroys: prevents automatic reconnection)
     */
    permanentDisconnect(): void {
        this.destroyed = true;
        this.disconnect();
    }

    /**
     * Send outbound messages to Router
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
     * Send binding command
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
     * Request to generate App binding QR code.
     * V2 account-level binding still uses the Router WebSocket command, with NexusAI token in the payload.
     */
    requestQRBind(nexusAiAccessToken: string): { success: boolean; message: string } {
        if (!nexusAiAccessToken) {
            const message = '请先登录 NexusAI 账号';
            this.onQRBindCode?.({ action: 'qr_bind_code', status: 'error', message });
            return { success: false, message };
        }

        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            const message = 'Router not connected';
            log.warn('Router not connected, cannot request QR bind');
            this.onQRBindCode?.({ action: 'qr_bind_code', status: 'error', message });
            return { success: false, message };
        }

        try {
            this.ws.send(JSON.stringify({
                action: 'generate_qr_bind',
                // Intentionally include the Bearer prefix per Router V2.1 protocol.
                nexusai_token: `Bearer ${nexusAiAccessToken}`,
            }));
            log.info('QR bind generation requested via WebSocket with NexusAI token');
            return { success: true, message: 'QR bind request sent' };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log.error('Request QR bind failed', { error: message });
            this.onQRBindCode?.({ action: 'qr_bind_code', status: 'error', message });
            return { success: false, message };
        }
    }

    /**
     * Get connection status
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
     * Get the original configuration (not desensitized, used for saving)
     */
    getRawConfig(): RouterConfig | null {
        return this.config;
    }

    /**
     * Test connection (uses temporary WebSocket, does not affect current connection status)
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
     * Destroy (called when closing)
     */
    destroy(): void {
        this.permanentDisconnect();
    }

    // ========================
    // internal method
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

        // Close the old connection and remove the event listener to prevent the old close event from triggering repeated reconnections
        if (this.ws) {
            const oldWs = this.ws;
            this.ws = null;
            oldWs.removeAllListeners();
            try { oldWs.close(); } catch { /* ignore */ }
        }

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
                        log.info('Received connection status push', { bound: msg.bound, platform_user_id: msg.platform_user_id, platform_id: msg.platform_id, raw: JSON.stringify(msg) });
                        this.bound = !!msg.bound;
                        this.onConnectStatus?.(msg);
                    } else if (msg.action === 'llm_config') {
                        log.info('Received LLM config push', { provider: msg.provider, model: msg.model });
                        this.onLlmConfig?.(msg);
                    } else if (msg.action === 'managed_runtime_config') {
                        log.info('Received managed runtime config push', { version: msg.version });
                        this.onManagedRuntimeConfig?.(msg as ManagedRuntimeConfigMessage);
                    } else if (msg.action === 'qr_bind_code') {
                        log.info('Received QR bind code', { status: msg.status, code: msg.code });
                        this.onQRBindCode?.(msg);
                    } else if (msg.action === 'qr_bind_success') {
                        log.info('Received QR bind success', { device: msg.bound_device });
                        this.onQRBindSuccess?.(msg);
                    } else if (Array.isArray(msg)) {
                        log.debug('Ignored internal command', { cmd: msg[0] });
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
                // The close event is usually triggered after the error event, and the reconnection logic is handled in close
            });

            this.ws.on('pong', () => {
                // Received pong, the connection is normal
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
        // Incremental reconnection interval: 5s -> 10s -> 30s -> 60s (capped)
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
     * Report LLM call usage to Router
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
