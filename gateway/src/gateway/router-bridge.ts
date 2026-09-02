/**
 * OpenFluxRouter bridge
 * Managing WebSocket connections to OpenFluxRouter in Gateway Server
 * Responsible for transparent message transmission: inbound messages are pushed to the client and outbound messages are forwarded to the Router
 */

// @ts-ignore - Runtime with ws module
import WebSocket from 'ws';
import { Logger } from '../utils/logger';
import type { ProjectContextEvent } from './project-context-store';

const log = new Logger('RouterBridge');

export const OPENFLUX_CLIENT_VERSION = '1.0.0-beta.2';
export const OPENFLUX_ROUTER_PROTOCOL_VERSION = '2';
export const OPENFLUX_ROUTER_CAPABILITIES = [
    'private_text_v1',
    'private_media_legacy_v1',
    'media_stream_v2',
    'external_binding_v1',
    'group_context_v1',
    'group_history_sync_v1',
    'group_plan_v1',
    'group_natural_language_v1',
    'group_work_order_v1',
    'group_agent_message_v1',
    'managed_runtime_v1',
] as const;

export interface RouterServerHello {
    action: 'router_hello';
    server_version: string;
    protocol_version: string;
    capabilities: string[];
    compatibility_state: 'compatible' | 'legacy_previous' | 'upgrade_required';
    client_version?: string;
}

export type RouterCompatibilityState = 'negotiating' | 'compatible' | 'legacy_router' | 'upgrade_required';

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

export interface RouterProjectRegistration {
    id: string;
    name: string;
}

export interface RouterExternalPlatform {
    platform_id: string;
    type: 'feishu' | 'dingtalk' | 'wecom' | 'slack';
    name: string;
    available: boolean;
    bound: boolean;
    binding?: {
        mapping_id: string;
        account_label: string;
        bound_at: string;
    } | null;
}

export interface RouterGroupProjectMapping {
    id: string;
    platform_id: string;
    platform_type?: 'feishu' | 'slack';
    workspace_id: string;
    channel_id: string;
    channel_name?: string;
    project_id: string;
    project_name: string;
    status: 'active' | 'paused';
    sync_enabled: boolean;
    last_event_at?: string;
}

export interface RouterGroupProjectOptions {
    platforms: Array<{
        platform_id: string;
        type: 'feishu' | 'slack';
        name: string;
        personal_bound: boolean;
    }>;
    channels: Array<{
        platform_id: string;
        workspace_id: string;
        channel_id: string;
        channel_name: string;
        last_event_at: string;
    }>;
    mappings: RouterGroupProjectMapping[];
    bots: RouterGroupBot[];
    runtime: { online: boolean; projects: RouterProjectRegistration[] };
}

export interface RouterGroupBot {
    mapping_id: string;
    bot_identity_id: string;
    platform_bot_id: string;
    target_platform_user_id: string;
    display_name: string;
    authorized: boolean;
    capabilities: string[];
    last_seen_at: string;
}

/** Outbound messaging (AI applications -> Enterprise IM) */
export interface RouterOutboundMessage {
    platform_type: string;
    platform_id: string;
    platform_user_id: string;
    content_type: string;       // text / image
    content: string;
}

export interface RouterGroupOutboundMessage {
    platform_id: string;
    workspace_id: string;
    channel_id: string;
    thread_id?: string;
    project_id: string;
    content: string;
}

export interface RouterGroupWorkItem {
    key: string;
    kind: 'task' | 'decision' | 'risk' | 'question';
    title: string;
    detail?: string;
    assignee_flux_user_id?: string;
    assignee_platform_member_id?: string;
    due_at?: string;
    source_event_ids: string[];
}

export interface RouterGroupPersonalDelivery {
    key: string;
    flux_user_id: string;
    content: string;
    work_item_keys: string[];
}

export interface RouterGroupWorkPublish {
    trigger_event_id: string;
    platform_id: string;
    workspace_id: string;
    channel_id: string;
    thread_id?: string;
    project_id: string;
    public_reply?: string;
    work_items: RouterGroupWorkItem[];
    personal_deliveries: RouterGroupPersonalDelivery[];
    bot_handoffs?: Array<{
        key: string;
        target_bot_id: string;
        content: string;
    }>;
    bot_task_result?: {
        task_id: string;
        action: 'result' | 'error';
        content: string;
    };
}

export interface RouterGroupWorkResult {
    action: 'group_work.result';
    trigger_event_id: string;
    success: boolean;
    status: 'completed' | 'retry' | 'failed';
    sent_count: number;
    pending_count: number;
    skipped_recipients: number;
    errors?: string[];
}

export interface RouterGroupApprovalDecision {
    action: 'group_approval.decided';
    approval_id: string;
    work_item_id?: string;
    mapping_id: string;
    project_id: string;
    platform_id: string;
    workspace_id: string;
    channel_id: string;
    thread_id: string;
    flux_user_id: string;
    decision: 'confirm' | 'modify' | 'ignore';
    status: string;
    title: string;
    content: string;
    decided_at: string;
}

export interface RouterGroupCollaborationMember {
    id: string;
    platform_member_id: string;
    flux_user_id: string;
    app_id: string;
    app_user_id: string;
    project_id: string;
    project_name: string;
    display_name: string;
    role_name: string;
    manager_dispatch_enabled: boolean;
    member_kind: 'owner' | 'member';
    status: 'active' | 'paused' | 'left';
    online?: boolean;
    natural_language_supported?: boolean;
}

export interface RouterGroupCollaboration {
    id: string;
    platform_id: string;
    workspace_id: string;
    channel_id: string;
    channel_name: string;
    thread_id?: string;
    status: string;
    planning_state: string;
    quiet_until?: string | null;
    current_member_id?: string | null;
    members: RouterGroupCollaborationMember[];
    history_protocol?: number;
    history_policy?: { enabled?: boolean; version?: string };
}

export interface RouterGroupMemberTask {
    id: string;
    batch_id: string;
    batch_version: number;
    collaboration_id: string;
    member_project_id: string;
    project_id: string;
    project_name: string;
    role_name: string;
    external_key: string;
    title: string;
    detail: string;
    dependencies: string[];
    acceptance: string[];
    task_version: number;
    status: string;
    decision_note?: string;
    objective: string;
    shared_contract: unknown[];
    source_event_ids: string[];
}

export interface RouterGroupCollaborationList {
    requests: Array<{
        id: string;
        action: 'enable' | 'enable_history' | 'join';
        platform_id: string;
        workspace_id: string;
        channel_id: string;
        channel_name: string;
        expires_at: string;
    }>;
    collaborations: RouterGroupCollaboration[];
    tasks: RouterGroupMemberTask[];
    team_tasks: Array<{
        id: string;
        batch_id: string;
        collaboration_id: string;
        member_project_id: string;
        external_key: string;
        title: string;
        dependencies: string[];
        status: string;
        role_name: string;
        project_name: string;
    }>;
    agent_messages: Array<{
        id: string;
        collaboration_id: string;
        batch_id: string;
        source_task_id: string;
        target_task_id: string;
        kind: RouterGroupAgentMessage['kind'];
        depth: number;
        content: string;
        status: string;
        created_at: string;
    }>;
    runtime: { projects: RouterProjectRegistration[] };
}

export interface RouterGroupPlanningRequest {
    action: 'group_collaboration.plan.generate';
    collaboration_id: string;
    planning_token: string;
    platform_id: string;
    workspace_id: string;
    channel_id: string;
    channel_name: string;
    project_id: string;
    request_text: string;
    requester_display_name: string;
    thread_id?: string;
    source_event_ids: string[];
    members: RouterGroupCollaborationMember[];
}

export interface RouterGroupWorkOrder {
    action: 'group_work_order.start';
    work_order_id: string;
    idempotency_key: string;
    collaboration_id: string;
    batch_id: string;
    batch_version: number;
    task_id: string;
    task_version: number;
    project_id: string;
    project_name: string;
    role_name: string;
    title: string;
    detail: string;
    dependencies: string[];
    acceptance: string[];
    objective: string;
    shared_contract: unknown[];
    platform_id: string;
    workspace_id: string;
    channel_id: string;
    channel_name: string;
    thread_id?: string;
    peer_tasks: Array<{
        task_id: string;
        member_project_id: string;
        project_name: string;
        role_name: string;
        title: string;
        status: string;
    }>;
}

export interface RouterGroupWorkOrderControl {
    action: 'group_work_order.pause' | 'group_work_order.cancel';
    work_order_id: string;
    task_id: string;
    project_id: string;
    reason: string;
}

export interface RouterGroupAgentMessage {
    action: 'group_agent_message.receive';
    id: string;
    message_id: string;
    correlation_id: string;
    collaboration_id: string;
    batch_id: string;
    source_task_id: string;
    target_task_id: string;
    kind: 'contract' | 'question' | 'answer' | 'dependency_ready' | 'blocker' | 'status' | 'result';
    depth: number;
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
    private helloTimer: ReturnType<typeof setTimeout> | null = null;
    private serverHello: RouterServerHello | null = null;
    private compatibilityState: RouterCompatibilityState = 'negotiating';
    private pendingControls = new Map<string, {
        resolve: (value: any) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    }>();

    /** Inbound message callback */
    onMessage: ((msg: RouterInboundMessage) => void) | null = null;
    /** Group context for a specific Project; it never enters the legacy Router direct-message session. */
    onProjectContext: ((event: ProjectContextEvent) => Promise<void> | void) | null = null;
    /** Final delivery state for public and private results produced by an @Bot task. */
    onGroupWorkResult: ((result: RouterGroupWorkResult) => Promise<void> | void) | null = null;
    /** Approval written back to the local Project after a member acts in Feishu or Slack. */
    onGroupApprovalDecision: ((event: RouterGroupApprovalDecision) => Promise<void> | void) | null = null;
    /** Request that asks the member to select a local Project after clicking a platform card. */
    onGroupCollaborationSetup: ((event: Record<string, unknown>) => Promise<void> | void) | null = null;
    /** Planning request created after an explicit member click or command in the group. */
    onGroupPlanningRequest: ((event: RouterGroupPlanningRequest) => Promise<void> | void) | null = null;
    /** Proposed task generated by Router for the current member. */
    onGroupTaskProposed: ((event: { action: string; task: RouterGroupMemberTask }) => Promise<void> | void) | null = null;
    /** Local work order created after the current member confirms a task. */
    onGroupWorkOrder: ((event: RouterGroupWorkOrder) => Promise<void> | void) | null = null;
    /** Pause or cancel a work order after a validated natural-language request. */
    onGroupWorkOrderControl: ((event: RouterGroupWorkOrderControl) => Promise<void> | void) | null = null;
    /** Controlled collaboration message from another member's OpenFlux Agent. */
    onGroupAgentMessage: ((event: RouterGroupAgentMessage) => Promise<void> | void) | null = null;
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
    /** Router protocol and capability negotiation result. */
    onServerHello: ((hello: RouterServerHello | null, state: RouterCompatibilityState) => void) | null = null;
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
        this.rejectPendingControls(new Error('Router 连接已断开'));

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

    registerRuntime(input: {
        fluxUserId?: string;
        deviceName?: string;
        projects: RouterProjectRegistration[];
    }): boolean {
        return this.sendControl({
            action: 'runtime.register',
            flux_user_id: input.fluxUserId,
            device_name: input.deviceName,
            client_version: OPENFLUX_CLIENT_VERSION,
            protocol_version: OPENFLUX_ROUTER_PROTOCOL_VERSION,
            capabilities: [...OPENFLUX_ROUTER_CAPABILITIES],
            projects: input.projects,
        });
    }

    ackProjectContext(deliveryId: string, sessionId?: string): boolean {
        return this.sendControl({ action: 'project_context.ack', delivery_id: deliveryId, session_id: sessionId });
    }

    sendGroupMessage(message: RouterGroupOutboundMessage): boolean {
        return this.sendControl({ action: 'group_message.send', ...message });
    }

    publishGroupWork(message: RouterGroupWorkPublish): boolean {
        return this.sendControl({ action: 'group_work.publish', ...message });
    }

    listExternalPlatforms(): Promise<{ platforms: RouterExternalPlatform[] }> {
        return this.requestControl('external_platforms.list');
    }

    requestExternalPlatformBindCode(platformId: string): Promise<{ code: string; expires_in: number }> {
        return this.requestControl('external_platform.bind_code', { platform_id: platformId });
    }

    unbindExternalPlatform(mappingId: string): Promise<{ success: boolean }> {
        return this.requestControl('external_platform.unbind', { mapping_id: mappingId });
    }

    getGroupProjectOptions(): Promise<RouterGroupProjectOptions> {
        return this.requestControl('group_projects.options');
    }

    getGroupCollaborations(): Promise<RouterGroupCollaborationList> {
        return this.requestControl('group_collaborations.list');
    }

    historyRequest(action: 'page' | 'request' | 'summary.poll' | 'summary.offer', payload: Record<string, unknown>): Promise<any> {
        if (!this.serverHello?.capabilities?.includes('group_history_sync_v1')) {
            return Promise.resolve({ success: false, code: 'upgrade_required', message: '当前 Router 尚不支持历史同步，请同步更新 Go 和 Python 服务。现有聊天不受影响。' });
        }
        return this.requestControl(`group_context.history.${action}`, payload, 60_000);
    }

    activateGroupCollaboration(input: {
        request_id: string;
        project_id: string;
        project_name: string;
        display_name: string;
        role_name: string;
        manager_dispatch_enabled: boolean;
    }): Promise<{ success: boolean; collaboration: RouterGroupCollaboration }> {
        return this.requestControl('group_collaboration.activate', input);
    }

    updateGroupCollaborationMember(
        collaborationId: string,
        status: 'active' | 'paused' | 'left',
        profile?: {
            display_name?: string;
            role_name?: string;
            manager_dispatch_enabled?: boolean;
        },
    ): Promise<{ success: boolean; status: string }> {
        return this.requestControl('group_collaboration.member.update', {
            collaboration_id: collaborationId,
            status,
            ...profile,
        });
    }

    publishGroupPlan(input: {
        collaboration_id: string;
        planning_token: string;
        outcome: 'proposal' | 'start' | 'reply' | 'summary' | 'status' | 'no_action' | 'no_change';
        message?: string;
        objective?: string;
        shared_contract?: unknown[];
        source_event_ids?: string[];
        thread_id?: string;
        tasks?: Array<{
            key: string;
            member_project_id: string;
            title: string;
            detail?: string;
            dependencies?: string[];
            acceptance?: string[];
        }>;
    }): Promise<Record<string, unknown>> {
        return this.requestControl('group_collaboration.plan.publish', input);
    }

    controlGroupTasks(input: {
        collaboration_id: string;
        action: 'pause' | 'cancel';
        task_ids: string[];
        reason?: string;
    }): Promise<Record<string, unknown>> {
        return this.requestControl('group_collaboration.tasks.control', input);
    }

    failGroupPlan(input: {
        collaboration_id: string;
        planning_token: string;
        thread_id?: string;
        error_code?: string;
    }): Promise<Record<string, unknown>> {
        return this.requestControl('group_collaboration.plan.fail', input);
    }

    updateGroupWorkOrderStatus(input: {
        work_order_id: string;
        status: 'acked' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
        execution_id?: string;
        result_summary?: string;
        error?: string;
    }): boolean {
        return this.sendControl({ action: 'group_work_order.status', ...input });
    }

    sendGroupAgentMessage(input: {
        source_task_id: string;
        target_task_id: string;
        message_id: string;
        correlation_id: string;
        kind: RouterGroupAgentMessage['kind'];
        depth: number;
        content: string;
    }): boolean {
        return this.sendControl({ action: 'group_agent_message.send', ...input });
    }

    ackGroupAgentMessage(messageId: string): boolean {
        return this.sendControl({ action: 'group_agent_message.ack', message_id: messageId });
    }

    bindGroupProject(input: {
        platform_id: string;
        workspace_id: string;
        channel_id: string;
        channel_name?: string;
        project_id: string;
        project_name: string;
    }): Promise<RouterGroupProjectMapping> {
        return this.requestControl('group_project.bind', input);
    }

    updateGroupProject(mappingId: string, status: 'active' | 'paused'): Promise<RouterGroupProjectMapping> {
        return this.requestControl('group_project.update', {
            mapping_id: mappingId,
            status,
            sync_enabled: status === 'active',
        });
    }

    removeGroupProject(mappingId: string): Promise<{ success: boolean }> {
        return this.requestControl('group_project.remove', { mapping_id: mappingId });
    }

    authorizeGroupBot(mappingId: string, botIdentityId: string, capabilities: string[]): Promise<{ success: boolean }> {
        return this.requestControl('group_bot.authorize', {
            mapping_id: mappingId,
            bot_identity_id: botIdentityId,
            capabilities,
        });
    }

    revokeGroupBot(mappingId: string, botIdentityId: string): Promise<{ success: boolean }> {
        return this.requestControl('group_bot.revoke', {
            mapping_id: mappingId,
            bot_identity_id: botIdentityId,
        });
    }

    private requestControl<T>(action: string, payload: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return Promise.reject(new Error('Router 当前未连接'));
        }
        const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingControls.delete(requestId);
                reject(new Error('Router 请求超时，请稍后重试'));
            }, timeoutMs);
            this.pendingControls.set(requestId, { resolve, reject, timer });
            if (!this.sendControl({ action, request_id: requestId, ...payload })) {
                clearTimeout(timer);
                this.pendingControls.delete(requestId);
                reject(new Error('Router 当前未连接'));
            }
        });
    }

    private sendControl(payload: Record<string, unknown>): boolean {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            log.warn('Router not connected, cannot send control message');
            return false;
        }
        try {
            this.ws.send(JSON.stringify(payload));
            return true;
        } catch (error) {
            log.error('Router control message failed', { error });
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
    getStatus(): {
        connected: boolean;
        bound: boolean;
        compatibility: typeof this.compatibilityState;
        routerProtocol: RouterServerHello | null;
        config: Omit<RouterConfig, 'apiKey'> & { apiKey: string } | null;
    } {
        if (!this.config) {
            return {
                connected: false,
                bound: false,
                compatibility: this.compatibilityState,
                routerProtocol: this.serverHello,
                config: null,
            };
        }
        return {
            connected: this.connected,
            bound: this.bound,
            compatibility: this.compatibilityState,
            routerProtocol: this.serverHello,
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
        const appUserId = config.appUserId || this.config?.appUserId;

        if (!url || !appId || !apiKey || !appUserId) {
            return { success: false, message: '配置不完整：需要 URL、App ID、API Key 和设备编号' };
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
                        'X-App-User-ID': appUserId,
                        'X-OpenFlux-Client-Version': OPENFLUX_CLIENT_VERSION,
                        'X-OpenFlux-Protocol-Version': OPENFLUX_ROUTER_PROTOCOL_VERSION,
                        'X-OpenFlux-Capabilities': OPENFLUX_ROUTER_CAPABILITIES.join(','),
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
            this.serverHello = null;
            this.compatibilityState = 'negotiating';
            this.ws = new WebSocket(url, {
                headers: {
                    'X-App-ID': appId,
                    'X-App-Type': appType,
                    'X-App-User-ID': this.config.appUserId || '',
                    'X-OpenFlux-Client-Version': OPENFLUX_CLIENT_VERSION,
                    'X-OpenFlux-Protocol-Version': OPENFLUX_ROUTER_PROTOCOL_VERSION,
                    'X-OpenFlux-Capabilities': OPENFLUX_ROUTER_CAPABILITIES.join(','),
                    'Authorization': `Bearer ${apiKey}`,
                },
            });

            this.ws.on('open', () => {
                this.connected = true;
                this.reconnectCount = 0;
                log.info('Connected to OpenFluxRouter');
                this.onConnectionChange?.('connected');
                this.startPing();
                if (this.helloTimer) clearTimeout(this.helloTimer);
                this.helloTimer = setTimeout(() => {
                    if (!this.serverHello && this.connected) {
                        this.compatibilityState = 'legacy_router';
                        this.onServerHello?.(null, this.compatibilityState);
                    }
                }, 2500);
            });

            this.ws.on('message', (data: WebSocket.Data) => {
                try {
                    const raw = data.toString();
                    const msg = JSON.parse(raw);

                    const pending = typeof msg.request_id === 'string'
                        ? this.pendingControls.get(msg.request_id)
                        : undefined;
                    if (pending) {
                        clearTimeout(pending.timer);
                        this.pendingControls.delete(msg.request_id);
                        if (msg.success === false) {
                            pending.reject(new Error(msg.message || 'Router 请求失败'));
                        } else {
                            pending.resolve(msg.data);
                        }
                    } else if (msg.action === 'router_hello') {
                        if (this.helloTimer) {
                            clearTimeout(this.helloTimer);
                            this.helloTimer = null;
                        }
                        this.serverHello = msg as RouterServerHello;
                        this.compatibilityState = msg.compatibility_state === 'upgrade_required'
                            ? 'upgrade_required'
                            : 'compatible';
                        this.onServerHello?.(this.serverHello, this.compatibilityState);
                    } else if (msg.action === 'project_context.append' && this.onProjectContext) {
                        Promise.resolve(this.onProjectContext(msg as ProjectContextEvent)).catch(error => {
                            log.error('Failed to persist Project group context', { error });
                        });
                    } else if (msg.action === 'group_work.result' && this.onGroupWorkResult) {
                        Promise.resolve(this.onGroupWorkResult(msg as RouterGroupWorkResult)).catch(error => {
                            log.error('Failed to process group task delivery result', { error });
                        });
                    } else if (msg.action === 'group_approval.decided' && this.onGroupApprovalDecision) {
                        Promise.resolve(this.onGroupApprovalDecision(msg as RouterGroupApprovalDecision)).catch(error => {
                            log.error('Failed to write group approval back to Project', { error });
                        });
                    } else if (msg.action === 'group_collaboration.setup_required' && this.onGroupCollaborationSetup) {
                        Promise.resolve(this.onGroupCollaborationSetup(msg)).catch(error => {
                            log.error('Failed to process group collaboration setup request', { error });
                        });
                    } else if (msg.action === 'group_collaboration.plan.generate' && this.onGroupPlanningRequest) {
                        Promise.resolve(this.onGroupPlanningRequest(msg as RouterGroupPlanningRequest)).catch(error => {
                            log.error('Failed to generate group collaboration plan', { error });
                        });
                    } else if (msg.action === 'group_collaboration.task.proposed' && this.onGroupTaskProposed) {
                        Promise.resolve(this.onGroupTaskProposed(msg as { action: string; task: RouterGroupMemberTask })).catch(error => {
                            log.error('Failed to process proposed group task', { error });
                        });
                    } else if (msg.action === 'group_work_order.start' && this.onGroupWorkOrder) {
                        Promise.resolve(this.onGroupWorkOrder(msg as RouterGroupWorkOrder)).catch(error => {
                            log.error('Failed to start group work order', { error });
                        });
                    } else if (
                        (msg.action === 'group_work_order.pause' || msg.action === 'group_work_order.cancel')
                        && this.onGroupWorkOrderControl
                    ) {
                        Promise.resolve(this.onGroupWorkOrderControl(msg as RouterGroupWorkOrderControl)).catch(error => {
                            log.error('Failed to control group work order', { error });
                        });
                    } else if (msg.action === 'group_agent_message.receive' && this.onGroupAgentMessage) {
                        Promise.resolve(this.onGroupAgentMessage(msg as RouterGroupAgentMessage)).catch(error => {
                            log.error('Failed to process group Agent message', { error });
                        });
                    } else if (msg.direction === 'inbound' && this.onMessage) {
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
                if (this.helloTimer) {
                    clearTimeout(this.helloTimer);
                    this.helloTimer = null;
                }
                this.serverHello = null;
                this.compatibilityState = 'negotiating';
                this.stopPing();
                this.rejectPendingControls(new Error('Router 连接已断开'));
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

    private rejectPendingControls(error: Error): void {
        for (const pending of this.pendingControls.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pendingControls.clear();
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
        if (this.helloTimer) {
            clearTimeout(this.helloTimer);
            this.helloTimer = null;
        }
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
