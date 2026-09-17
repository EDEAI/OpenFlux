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
/** Router WebSocket protocol version this client speaks (Router: routerProtocolVersion). */
export const ROUTER_PROTOCOL_VERSION = '2';
/** Default client version reported to Router; overridable per RouterConfig. */
export const ROUTER_CLIENT_VERSION = process.env.OPENFLUX_CLIENT_VERSION || '1.5.1';
/**
 * Capabilities this client really implements. Router only sends group
 * deliveries (`project_context.append`) to a device that declared
 * `group_context_v1`; an empty or mismatched declaration downgrades the
 * connection to private-chat only.
 */
export const ROUTER_CLIENT_CAPABILITIES = [
    'private_text_v1',
    'private_media_legacy_v1',
    'group_context_v1',
    'external_conversation_assignment_v1',
] as const;

/** Result frame for a control request (`<action>.result`). */
export interface RouterControlResult<T = unknown> {
    action: string;
    request_id: string;
    success: boolean;
    message?: string;
    data?: T;
}

export class RouterControlError extends Error {
    constructor(readonly action: string, message: string, readonly result?: RouterControlResult) {
        super(message);
        this.name = 'RouterControlError';
    }
}

/** Headers for every Router WebSocket handshake (formal and test connections must match). */
export function buildRouterHeaders(input: {
    appId: string;
    appType: string;
    appUserId?: string;
    apiKey: string;
    clientVersion?: string;
}): Record<string, string> {
    return {
        'X-App-ID': input.appId,
        'X-App-Type': input.appType,
        'X-App-User-ID': input.appUserId || '',
        'Authorization': `Bearer ${input.apiKey}`,
        'X-OpenFlux-Client-Version': input.clientVersion || ROUTER_CLIENT_VERSION,
        'X-OpenFlux-Protocol-Version': ROUTER_PROTOCOL_VERSION,
        'X-OpenFlux-Capabilities': ROUTER_CLIENT_CAPABILITIES.join(','),
    };
}

/** Router's greeting after the handshake; tells us how it classified this client. */
export interface RouterHello {
    action: 'router_hello';
    server_version?: string;
    protocol_version?: string;
    capabilities?: string[];
    compatibility_state?: 'compatible' | 'upgrade_required' | 'legacy_previous' | string;
    client_version?: string;
}

/**
 * Group message delivery (Router -> OpenFlux, action `project_context.append`).
 * Field names follow the Router wire format; see router-integration-guide.md section 5.
 */
export interface RouterGroupDelivery {
    action: 'project_context.append';
    delivery_id: string;
    event_id: string;
    external_event_id: string;
    event_type: string;           // message_created / message_edited / message_deleted
    mapping_id?: string | null;
    collaboration_id?: string | null;
    group_member_project_id?: string | null;
    platform_id: string;
    platform_type: string;        // feishu / slack / dingtalk
    workspace_id: string;
    channel_id: string;
    channel_name?: string | null;
    thread_id: string;
    message_id: string;
    project_id: string;
    /** `pending` when the group has no Project/Agent yet (P2 assignment flow). */
    assignment_state?: 'pending' | 'assigned';
    sender_platform_id: string;
    sender_flux_user_id?: string | null;
    sender_is_current_member: boolean;
    agent_execution_allowed: boolean;
    sender_display_name?: string | null;
    sender_role_name?: string | null;
    sender_type: string;          // human / bot / app / unknown
    bot_mentioned: boolean;
    suppress_agent_execution: boolean;
    history_import?: boolean;
    text: string;
    mentions: unknown[];
    attachments: unknown[];
    source_url?: string | null;
    created_at: number;
    edited_at?: number | null;
    bot_task?: Record<string, unknown> | null;
    collaboration_event?: Record<string, unknown> | null;
    public_reply_reference?: Record<string, unknown> | null;
    document_references?: unknown[];
    authorized_bots?: unknown[];
}

/** `group_work.publish` payload (subset used by OpenFlux). */
export interface RouterGroupWorkPublish {
    trigger_event_id: string;
    platform_id: string;
    workspace_id: string;
    channel_id: string;
    thread_id?: string;
    project_id: string;
    public_reply: string;
    work_items?: unknown[];
    personal_deliveries?: unknown[];
    bot_handoffs?: unknown[];
}

/** Router receipt for a published group result. */
export interface RouterGroupWorkResult {
    action: 'group_work.result';
    trigger_event_id: string;
    success: boolean;
    /** Router: sent / pending / partial / failed; client-side: transport_failed / superseded */
    status: string;
    sent_count?: number;
    pending_count?: number;
    skipped_recipients?: number;
    errors?: string[];
}

export interface RouterRuntimeRegistration {
    fluxUserId?: string;
    deviceName?: string;
    projects: Array<{ id: string; name: string }>;
}

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
    /** Client version reported to Router; defaults to ROUTER_CLIENT_VERSION. */
    clientVersion?: string;
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
        /** Audit model for completion / claim-consistency checks; absent = audits follow orchestration */
        verification?: { provider: string; model: string };
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
    image?: {
        provider: string;
        api_key_encrypted?: string;
        iv?: string;
        model?: string;
        base_url?: string;
        size?: string;
        timeout_seconds?: number;
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

    private hello: RouterHello | null = null;

    /** Inbound message callback */
    onMessage: ((msg: RouterInboundMessage) => void) | null = null;
    /** Group delivery callback (`project_context.append`). The handler owns persistence and ack. */
    onGroupDelivery: ((delivery: RouterGroupDelivery) => void) | null = null;
    /** Publish results are matched by trigger_event_id (Router sends no request_id for them). */
    private readonly pendingGroupWork = new Map<string, {
        resolve: (result: RouterGroupWorkResult) => void;
        timer: ReturnType<typeof setTimeout>;
    }>();
    private readonly pendingControl = new Map<string, {
        action: string;
        resolve: (result: RouterControlResult) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    }>();
    /** Router greeting callback; carries the negotiated compatibility state. */
    onHello: ((hello: RouterHello) => void) | null = null;
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
    onQRBindCode: ((data: { action: string; status: string; code?: string; qr_data?: string; expires_in?: number; message?: string }) => void) | null = null;
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
     * Whether the Router WebSocket is currently connected
     */
    isConnected(): boolean {
        return this.connected;
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
     * Request to generate App binding QR code
     */
    requestQRBind(): boolean {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            log.warn('Router not connected, cannot request QR bind');
            return false;
        }
        try {
            this.ws.send(JSON.stringify({ action: 'generate_qr_bind' }));
            log.info('QR bind generation requested');
            return true;
        } catch (err) {
            log.error('Request QR bind failed', { error: err });
            return false;
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
                // Router rejects a handshake without a device id (400) and expects the
                // test connection to carry the same identity as the real one, so fall
                // back to the configured device id when the settings form omits it.
                testWs = new WebSocket(url, {
                    headers: buildRouterHeaders({
                        appId, appType, apiKey,
                        appUserId: config.appUserId || this.config?.appUserId,
                        clientVersion: config.clientVersion || this.config?.clientVersion,
                    }),
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

    /**
     * Dispatch one raw Router frame. Exposed for tests; the socket handler calls it.
     */
    handleIncoming(raw: string): void {
        let msg: any;
        try {
            msg = JSON.parse(raw);
        } catch (err) {
            log.error('Failed to parse Router message', { error: err });
            return;
        }
        try {
            if (msg.action === 'group_work.result' && typeof msg.trigger_event_id === 'string') {
                const waiting = this.pendingGroupWork.get(msg.trigger_event_id);
                if (waiting) {
                    this.pendingGroupWork.delete(msg.trigger_event_id);
                    clearTimeout(waiting.timer);
                    waiting.resolve(msg as RouterGroupWorkResult);
                } else {
                    log.info('Unmatched group_work.result', { triggerEventId: msg.trigger_event_id, status: msg.status });
                }
                return;
            }
            if (typeof msg.request_id === 'string' && this.pendingControl.has(msg.request_id)) {
                const pending = this.pendingControl.get(msg.request_id)!;
                this.pendingControl.delete(msg.request_id);
                clearTimeout(pending.timer);
                pending.resolve(msg as RouterControlResult);
                return;
            }
            if (msg.direction === 'inbound' && this.onMessage) {
                log.info('Received inbound message', {
                    platform: msg.platform_type,
                    userId: msg.platform_user_id,
                    contentType: msg.content_type,
                });
                this.onMessage(msg as RouterInboundMessage);
            } else if (msg.action === 'project_context.append') {
                if (!this.onGroupDelivery) {
                    // Never ack implicitly: Router keeps retrying until a handler stores it.
                    log.warn('Group delivery received without a handler; leaving it pending on Router', {
                        deliveryId: msg.delivery_id,
                    });
                    return;
                }
                log.info('Received group delivery', {
                    deliveryId: msg.delivery_id,
                    platform: msg.platform_type,
                    channelId: msg.channel_id,
                    eventType: msg.event_type,
                    botMentioned: msg.bot_mentioned,
                });
                this.onGroupDelivery(msg as RouterGroupDelivery);
            } else if (msg.action === 'router_hello') {
                this.hello = msg as RouterHello;
                log.info('Received Router hello', {
                    serverVersion: msg.server_version,
                    protocolVersion: msg.protocol_version,
                    compatibilityState: msg.compatibility_state,
                });
                if (msg.compatibility_state && msg.compatibility_state !== 'compatible') {
                    log.warn('Router classified this client as not fully compatible; group deliveries will be withheld', {
                        compatibilityState: msg.compatibility_state,
                        expectedProtocol: msg.protocol_version,
                        ourProtocol: ROUTER_PROTOCOL_VERSION,
                    });
                }
                this.onHello?.(this.hello);
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
            log.error('Failed to handle Router message', { error: err, action: msg?.action });
        }
    }

    /** Send any control frame. Returns false when the socket is not open. */
    sendRaw(payload: Record<string, unknown>): boolean {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            log.warn('Router not connected, cannot send control frame', { action: payload.action });
            return false;
        }
        try {
            this.ws.send(JSON.stringify(payload));
            return true;
        } catch (err) {
            log.error('Send control frame failed', { error: err, action: payload.action });
            return false;
        }
    }

    /**
     * Send a control request and wait for its `<action>.result` frame, matched
     * by request_id. Rejects with RouterControlError when Router reports
     * failure, and on timeout or disconnect.
     */
    request<T = unknown>(action: string, payload: Record<string, unknown>, timeoutMs = 15_000): Promise<RouterControlResult<T>> {
        const requestId = `${action}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
        return new Promise<RouterControlResult<T>>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingControl.delete(requestId);
                reject(new RouterControlError(action, `Router 在 ${Math.round(timeoutMs / 1000)} 秒内没有回应 ${action}`));
            }, timeoutMs);
            this.pendingControl.set(requestId, {
                action,
                resolve: result => {
                    if (result.success) resolve(result as RouterControlResult<T>);
                    else reject(new RouterControlError(action, result.message || `${action} 失败`, result));
                },
                reject,
                timer,
            });
            if (!this.sendRaw({ ...payload, action, request_id: requestId })) {
                this.pendingControl.delete(requestId);
                clearTimeout(timer);
                reject(new RouterControlError(action, 'Router 未连接'));
            }
        });
    }

    private rejectPendingControl(reason: string): void {
        for (const [id, pending] of this.pendingControl) {
            clearTimeout(pending.timer);
            pending.reject(new RouterControlError(pending.action, reason));
            this.pendingControl.delete(id);
        }
        for (const [id, pending] of this.pendingGroupWork) {
            clearTimeout(pending.timer);
            pending.resolve({ action: 'group_work.result', trigger_event_id: id, success: false, status: 'transport_failed', errors: [reason] });
            this.pendingGroupWork.delete(id);
        }
    }

    /**
     * Publish a group result through Router's reliable delivery path and wait
     * for its receipt. Resolves with `status: 'transport_failed'` when the
     * frame could not be sent or no receipt arrived in time; the caller keeps
     * the result durable and retries later.
     */
    publishGroupWork(payload: RouterGroupWorkPublish, timeoutMs = 20_000): Promise<RouterGroupWorkResult> {
        const triggerEventId = payload.trigger_event_id;
        return new Promise<RouterGroupWorkResult>(resolve => {
            const settle = (result: RouterGroupWorkResult) => {
                this.pendingGroupWork.delete(triggerEventId);
                resolve(result);
            };
            const previous = this.pendingGroupWork.get(triggerEventId);
            if (previous) {
                clearTimeout(previous.timer);
                previous.resolve({ action: 'group_work.result', trigger_event_id: triggerEventId, success: false, status: 'superseded' });
            }
            const timer = setTimeout(() => settle({
                action: 'group_work.result', trigger_event_id: triggerEventId,
                success: false, status: 'transport_failed', errors: ['no receipt from Router'],
            }), timeoutMs);
            this.pendingGroupWork.set(triggerEventId, { resolve: settle, timer });
            if (!this.sendRaw({ ...payload, action: 'group_work.publish' })) {
                clearTimeout(timer);
                settle({ action: 'group_work.result', trigger_event_id: triggerEventId, success: false, status: 'transport_failed', errors: ['Router 未连接'] });
            }
        });
    }

    /**
     * Confirm a group delivery after it is durably stored locally. Router keeps
     * the delivery pending (and replays it on reconnect) until this arrives.
     */
    ackGroupDelivery(deliveryId: string, sessionId?: string): boolean {
        if (!deliveryId) return false;
        const frame: Record<string, unknown> = { action: 'project_context.ack', delivery_id: deliveryId };
        if (sessionId) frame.session_id = sessionId;
        return this.sendRaw(frame);
    }

    /**
     * Register this runtime and its Projects. Router replays pending group
     * deliveries right after a successful registration, so call it once per
     * connection and again whenever the Project list changes.
     */
    registerRuntime(registration: RouterRuntimeRegistration): boolean {
        const projects = registration.projects
            .map(item => ({ id: String(item.id || '').trim(), name: String(item.name || '').trim() }))
            .filter(item => item.id && item.name);
        const frame: Record<string, unknown> = { action: 'runtime.register', projects };
        if (registration.fluxUserId) frame.flux_user_id = registration.fluxUserId;
        if (registration.deviceName) frame.device_name = registration.deviceName;
        const sent = this.sendRaw(frame);
        if (sent) log.info('Runtime registered with Router', { projects: projects.length });
        return sent;
    }

    /** Last Router greeting for this connection, if any. */
    getHello(): RouterHello | null {
        return this.hello;
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
                headers: buildRouterHeaders({
                    appId, appType, apiKey,
                    appUserId: this.config.appUserId,
                    clientVersion: this.config.clientVersion,
                }),
            });

            this.ws.on('open', () => {
                this.hello = null;
                this.connected = true;
                this.reconnectCount = 0;
                log.info('Connected to OpenFluxRouter');
                this.onConnectionChange?.('connected');
                this.startPing();
            });

            this.ws.on('message', (data: WebSocket.Data) => {
                this.handleIncoming(data.toString());
            });

            this.ws.on('close', (code: number, reason: Buffer) => {
                this.rejectPendingControl('Router 连接已断开');
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
