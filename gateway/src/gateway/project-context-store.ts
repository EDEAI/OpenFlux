import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

export interface ProjectContextAttachment {
    id?: string;
    type: string;
    name?: string;
    mime_type?: string;
    size?: number;
    url?: string;
    local_path?: string;
}

export interface ProjectContextEvent {
    action: 'project_context.append';
    mapping_id?: string;
    delivery_id: string;
    event_id: string;
    external_event_id: string;
    event_type: 'message_created' | 'message_edited' | 'message_deleted' | string;
    platform_id: string;
    platform_type: 'feishu' | 'slack' | string;
    workspace_id: string;
    channel_id: string;
    channel_name?: string;
    thread_id: string;
    message_id: string;
    project_id: string;
    sender_platform_id: string;
    sender_flux_user_id?: string;
    sender_is_current_member?: boolean;
    agent_execution_allowed?: boolean;
    sender_display_name?: string;
    sender_role_name?: string;
    sender_type: 'human' | 'bot' | 'app' | 'unknown' | string;
    suppress_agent_execution?: boolean;
    collaboration_event?: Record<string, unknown> | null;
    bot_mentioned?: boolean;
    text: string;
    mentions: Array<Record<string, unknown>>;
    attachments: ProjectContextAttachment[];
    source_url?: string;
    created_at: number;
    edited_at?: number | null;
    bot_task?: {
        schema?: string;
        task_id?: string;
        parent_task_id?: string | null;
        action?: 'request' | 'result' | 'error' | string;
        depth?: number;
        source_bot_id?: string;
        target_bot_id?: string;
        content?: string;
        deadline_at?: string;
        trace?: string[];
        accepted?: boolean;
        reason?: string;
        origin_trigger_event_id?: string;
    } | null;
    authorized_bots?: Array<{
        bot_id: string;
        target_platform_user_id: string;
        display_name: string;
        capabilities: string[];
    }>;
}

export interface ProjectContextAppendResult {
    duplicate: boolean;
    sessionId: string;
}

export interface ProjectChannelMember {
    flux_user_id: string;
    platform_member_id: string;
}

export interface PendingGroupWork {
    trigger_event_id: string;
    payload: Record<string, unknown>;
    attempt_count: number;
}

export interface GroupWorkOrderReceipt {
    work_order_id: string;
    idempotency_key: string;
    project_id: string;
    session_id: string;
    task_id?: string;
    status: string;
    result_summary?: string;
    payload_json?: string;
}

export interface GroupAgentMessageReceipt {
    router_message_id: string;
    external_message_id: string;
    target_task_id: string;
    kind: string;
    content: string;
    saved_at: number;
    handled_at?: number | null;
}

type ConversationKey = {
    projectId: string;
    platformId: string;
    workspaceId: string;
    channelId: string;
    threadId?: string;
};

/**
 * Local current-state store for external group messages.
 *
 * The Router database owns reliable delivery. This SQLite store gives each
 * local Project a queryable, editable and deletable group context. Both sides
 * use delivery_id for idempotency so reconnect replay cannot duplicate data.
 */
export class ProjectContextStore {
    private readonly db: Database.Database;

    constructor(dataDir: string) {
        const dbPath = join(dataDir, 'group-project-context.sqlite');
        if (!existsSync(dirname(dbPath))) mkdirSync(dirname(dbPath), { recursive: true });
        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS external_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id TEXT NOT NULL,
                platform_id TEXT NOT NULL,
                platform_type TEXT NOT NULL DEFAULT '',
                workspace_id TEXT NOT NULL,
                channel_id TEXT NOT NULL,
                channel_name TEXT,
                thread_id TEXT NOT NULL DEFAULT '',
                message_id TEXT NOT NULL,
                last_event_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                sender_platform_id TEXT NOT NULL,
                sender_flux_user_id TEXT,
                sender_display_name TEXT,
                sender_role_name TEXT,
                sender_type TEXT NOT NULL,
                suppress_agent_execution INTEGER NOT NULL DEFAULT 0,
                collaboration_event_json TEXT,
                text TEXT NOT NULL DEFAULT '',
                mentions_json TEXT NOT NULL DEFAULT '[]',
                attachments_json TEXT NOT NULL DEFAULT '[]',
                source_url TEXT,
                created_at INTEGER NOT NULL,
                edited_at INTEGER,
                deleted INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL,
                UNIQUE(platform_id, workspace_id, channel_id, message_id)
            );
            CREATE INDEX IF NOT EXISTS ix_external_messages_project_thread
                ON external_messages(project_id, thread_id, created_at);

            CREATE TABLE IF NOT EXISTS external_thread_sessions (
                project_id TEXT NOT NULL,
                platform_id TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                channel_id TEXT NOT NULL,
                thread_id TEXT NOT NULL DEFAULT '',
                session_id TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY(project_id, platform_id, workspace_id, channel_id, thread_id),
                UNIQUE(session_id)
            );

            CREATE TABLE IF NOT EXISTS external_delivery_receipts (
                delivery_id TEXT PRIMARY KEY,
                event_id TEXT NOT NULL,
                project_id TEXT NOT NULL,
                saved_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS group_work_runs (
                trigger_event_id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                attempt_count INTEGER NOT NULL DEFAULT 0,
                next_attempt_at INTEGER NOT NULL,
                last_error TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS ix_group_work_runs_retry
                ON group_work_runs(status, next_attempt_at);

            CREATE TABLE IF NOT EXISTS group_approval_receipts (
                approval_id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                decision TEXT NOT NULL,
                saved_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS group_planning_runs (
                planning_token TEXT PRIMARY KEY,
                collaboration_id TEXT NOT NULL,
                project_id TEXT NOT NULL,
                status TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS group_work_order_receipts (
                work_order_id TEXT PRIMARY KEY,
                idempotency_key TEXT NOT NULL UNIQUE,
                project_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                task_id TEXT,
                status TEXT NOT NULL,
                result_summary TEXT,
                payload_json TEXT,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS ix_group_work_order_project
                ON group_work_order_receipts(project_id, updated_at);

            CREATE TABLE IF NOT EXISTS group_agent_message_receipts (
                router_message_id TEXT PRIMARY KEY,
                external_message_id TEXT NOT NULL,
                target_task_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                content TEXT NOT NULL,
                saved_at INTEGER NOT NULL,
                handled_at INTEGER
            );

        `);
        this.ensureColumn('external_messages', 'platform_type', "TEXT NOT NULL DEFAULT ''");
        this.ensureColumn('external_messages', 'channel_name', 'TEXT');
        this.ensureColumn('external_messages', 'sender_display_name', 'TEXT');
        this.ensureColumn('external_messages', 'sender_role_name', 'TEXT');
        this.ensureColumn('external_messages', 'suppress_agent_execution', 'INTEGER NOT NULL DEFAULT 0');
        this.ensureColumn('external_messages', 'collaboration_event_json', 'TEXT');
        this.ensureColumn('group_work_order_receipts', 'task_id', 'TEXT');
        this.ensureColumn('group_work_order_receipts', 'payload_json', 'TEXT');
        this.ensureColumn('group_agent_message_receipts', 'handled_at', 'INTEGER');
    }

    private ensureColumn(table: string, column: string, definition: string): void {
        const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
        if (!columns.some(item => item.name === column)) {
            this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        }
    }

    append(event: ProjectContextEvent): ProjectContextAppendResult {
        const existingReceipt = this.db.prepare(
            'SELECT delivery_id FROM external_delivery_receipts WHERE delivery_id = ?',
        ).get(event.delivery_id);
        const sessionId = this.getOrCreateSessionId(event);
        if (existingReceipt) return { duplicate: true, sessionId };

        const now = Date.now();
        const transaction = this.db.transaction(() => {
            const deleted = event.event_type === 'message_deleted' ? 1 : 0;
            const text = deleted ? '' : (event.text || '');
            const attachments = deleted ? [] : (event.attachments || []);
            this.db.prepare(`
                INSERT INTO external_messages (
                    project_id, platform_id, platform_type, workspace_id, channel_id, channel_name, thread_id,
                    message_id, last_event_id, event_type, sender_platform_id,
                    sender_flux_user_id, sender_display_name, sender_role_name, sender_type,
                    suppress_agent_execution, collaboration_event_json, text, mentions_json,
                    attachments_json, source_url, created_at, edited_at, deleted, updated_at
                ) VALUES (
                    @project_id, @platform_id, @platform_type, @workspace_id, @channel_id, @channel_name, @thread_id,
                    @message_id, @event_id, @event_type, @sender_platform_id,
                    @sender_flux_user_id, @sender_display_name, @sender_role_name, @sender_type,
                    @suppress_agent_execution, @collaboration_event_json, @text, @mentions_json,
                    @attachments_json, @source_url, @created_at, @edited_at, @deleted, @updated_at
                )
                ON CONFLICT(platform_id, workspace_id, channel_id, message_id) DO UPDATE SET
                    project_id = excluded.project_id,
                    platform_type = excluded.platform_type,
                    channel_name = excluded.channel_name,
                    thread_id = excluded.thread_id,
                    last_event_id = excluded.last_event_id,
                    event_type = excluded.event_type,
                    sender_platform_id = excluded.sender_platform_id,
                    sender_flux_user_id = excluded.sender_flux_user_id,
                    sender_display_name = excluded.sender_display_name,
                    sender_role_name = excluded.sender_role_name,
                    sender_type = excluded.sender_type,
                    suppress_agent_execution = excluded.suppress_agent_execution,
                    collaboration_event_json = excluded.collaboration_event_json,
                    text = excluded.text,
                    mentions_json = excluded.mentions_json,
                    attachments_json = excluded.attachments_json,
                    source_url = excluded.source_url,
                    edited_at = excluded.edited_at,
                    deleted = excluded.deleted,
                    updated_at = excluded.updated_at
            `).run({
                ...event,
                sender_flux_user_id: event.sender_flux_user_id || null,
                sender_display_name: event.sender_display_name || null,
                sender_role_name: event.sender_role_name || null,
                channel_name: event.channel_name || null,
                suppress_agent_execution: event.suppress_agent_execution ? 1 : 0,
                collaboration_event_json: event.collaboration_event
                    ? JSON.stringify(event.collaboration_event)
                    : null,
                text,
                mentions_json: JSON.stringify(event.mentions || []),
                attachments_json: JSON.stringify(attachments),
                source_url: event.source_url || null,
                created_at: event.created_at || now,
                edited_at: event.edited_at || null,
                deleted,
                updated_at: now,
            });
            this.db.prepare(`
                INSERT INTO external_delivery_receipts(delivery_id, event_id, project_id, saved_at)
                VALUES (?, ?, ?, ?)
            `).run(event.delivery_id, event.event_id, event.project_id, now);
        });
        transaction();
        return { duplicate: false, sessionId };
    }

    hasDelivery(deliveryId: string): boolean {
        return Boolean(this.db.prepare(
            'SELECT 1 AS found FROM external_delivery_receipts WHERE delivery_id = ?',
        ).get(deliveryId));
    }

    getOrCreateSessionId(event: Pick<ProjectContextEvent,
        'project_id' | 'platform_id' | 'workspace_id' | 'channel_id' | 'thread_id'
    >): string {
        // A bound external group is one OpenFlux conversation. Platform
        // threads remain queryable in external_messages, but no longer create
        // separate child conversations in the Project sidebar.
        const key = [event.project_id, event.platform_id, event.workspace_id, event.channel_id, ''];
        const existing = this.db.prepare(`
            SELECT session_id FROM external_thread_sessions
            WHERE project_id = ? AND platform_id = ? AND workspace_id = ? AND channel_id = ? AND thread_id = ?
        `).get(...key) as { session_id: string } | undefined;
        if (existing) return existing.session_id;

        const digest = createHash('sha256').update(key.join('\u0000')).digest('hex').slice(0, 20);
        const sessionId = `project-thread-${digest}`;
        const now = Date.now();
        this.db.prepare(`
            INSERT OR IGNORE INTO external_thread_sessions(
                project_id, platform_id, workspace_id, channel_id, thread_id,
                session_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(...key, sessionId, now, now);
        return sessionId;
    }

    listThreadMessages(projectId: string, threadId = ''): Array<Record<string, unknown>> {
        const rows = this.db.prepare(`
            SELECT * FROM external_messages
            WHERE project_id = ? AND thread_id = ?
            ORDER BY created_at ASC
        `).all(projectId, threadId) as Array<Record<string, unknown>>;
        return rows.map(row => this.decodeMessageRow(row));
    }

    listConversationMessages(input: {
        projectId: string;
        platformId: string;
        workspaceId: string;
        channelId: string;
        threadId?: string;
        limit?: number;
    }): Array<Record<string, unknown>> {
        const limit = Math.max(1, Math.min(input.limit || 500, 1000));
        const rows = this.db.prepare(`
            SELECT * FROM (
                SELECT * FROM external_messages
                WHERE project_id = ? AND platform_id = ? AND workspace_id = ?
                  AND channel_id = ? AND thread_id = ?
                ORDER BY created_at DESC
                LIMIT ?
            ) recent
            ORDER BY created_at ASC
        `).all(
            input.projectId,
            input.platformId,
            input.workspaceId,
            input.channelId,
            input.threadId || '',
            limit,
        ) as Array<Record<string, unknown>>;
        return rows.map(row => this.decodeMessageRow(row));
    }

    listConversationMessagesByEventIds(input: ConversationKey & { eventIds: string[] }): Array<Record<string, unknown>> {
        const eventIds = [...new Set(input.eventIds.map(String).filter(Boolean))];
        if (eventIds.length === 0) return [];
        const rows: Array<Record<string, unknown>> = [];
        // Keep well below SQLite's host-parameter limit even for very active
        // groups. Removing the former 500-message product cap must not replace
        // it with a database-variable failure.
        for (let offset = 0; offset < eventIds.length; offset += 400) {
            const batch = eventIds.slice(offset, offset + 400);
            const placeholders = batch.map(() => '?').join(',');
            rows.push(...this.db.prepare(`
                SELECT * FROM external_messages
                WHERE project_id = ? AND platform_id = ? AND workspace_id = ?
                  AND channel_id = ? AND thread_id = ? AND last_event_id IN (${placeholders})
            `).all(
                input.projectId,
                input.platformId,
                input.workspaceId,
                input.channelId,
                input.threadId || '',
                ...batch,
            ) as Array<Record<string, unknown>>);
        }
        rows.sort((first, second) =>
            Number(first.created_at || 0) - Number(second.created_at || 0)
            || Number(first.id || 0) - Number(second.id || 0));
        return rows.map(row => this.decodeMessageRow(row));
    }

    searchConversationMessages(input: ConversationKey & { terms: string[]; limit?: number }): Array<Record<string, unknown>> {
        const terms = [...new Set(input.terms
            .map(term => term.trim())
            .filter(term => term.length >= 2)
            .slice(0, 8))];
        if (terms.length === 0) return [];
        const limit = Math.max(1, Math.min(input.limit || 30, 100));
        const predicates = terms.map(() => "text LIKE ? ESCAPE '\\'").join(' OR ');
        const rows = this.db.prepare(`
            SELECT * FROM (
                SELECT * FROM external_messages
                WHERE project_id = ? AND platform_id = ? AND workspace_id = ?
                  AND channel_id = ? AND thread_id = ? AND deleted = 0
                  AND (${predicates})
                ORDER BY created_at DESC, id DESC
                LIMIT ?
            ) matched
            ORDER BY created_at ASC, id ASC
        `).all(
            input.projectId,
            input.platformId,
            input.workspaceId,
            input.channelId,
            input.threadId || '',
            ...terms.map(term => `%${term.replace(/[\\%_]/g, value => `\\${value}`)}%`),
            limit,
        ) as Array<Record<string, unknown>>;
        return rows.map(row => this.decodeMessageRow(row));
    }

    getMessageByExternalId(
        projectId: string,
        platformId: string,
        workspaceId: string,
        channelId: string,
        messageId: string,
    ): Record<string, unknown> | undefined {
        const row = this.db.prepare(`
            SELECT * FROM external_messages
            WHERE project_id = ? AND platform_id = ? AND workspace_id = ?
              AND channel_id = ? AND message_id = ?
        `).get(projectId, platformId, workspaceId, channelId, messageId) as Record<string, unknown> | undefined;
        return row ? this.decodeMessageRow(row) : undefined;
    }

    listChannelMembers(event: Pick<ProjectContextEvent,
        'project_id' | 'platform_id' | 'workspace_id' | 'channel_id'
    >): ProjectChannelMember[] {
        return this.db.prepare(`
            SELECT sender_flux_user_id AS flux_user_id,
                   MAX(sender_platform_id) AS platform_member_id
            FROM external_messages
            WHERE project_id = ? AND platform_id = ? AND workspace_id = ? AND channel_id = ?
              AND sender_flux_user_id IS NOT NULL AND sender_flux_user_id != ''
              AND sender_type = 'human'
            GROUP BY sender_flux_user_id
            ORDER BY MAX(updated_at) DESC
        `).all(
            event.project_id,
            event.platform_id,
            event.workspace_id,
            event.channel_id,
        ) as ProjectChannelMember[];
    }

    saveGroupWork(triggerEventId: string, projectId: string, payload: Record<string, unknown>): void {
        const now = Date.now();
        this.db.prepare(`
            INSERT OR IGNORE INTO group_work_runs(
                trigger_event_id, project_id, payload_json, status,
                attempt_count, next_attempt_at, created_at, updated_at
            ) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)
        `).run(triggerEventId, projectId, JSON.stringify(payload), now, now, now);
    }

    hasGroupWork(triggerEventId: string): boolean {
        return Boolean(this.db.prepare(
            'SELECT 1 AS found FROM group_work_runs WHERE trigger_event_id = ?',
        ).get(triggerEventId));
    }

    listDueGroupWork(now = Date.now(), limit = 20): PendingGroupWork[] {
        const rows = this.db.prepare(`
            SELECT trigger_event_id, payload_json, attempt_count
            FROM group_work_runs
            WHERE status IN ('pending', 'retry', 'submitted') AND next_attempt_at <= ?
            ORDER BY created_at ASC
            LIMIT ?
        `).all(now, Math.max(1, Math.min(limit, 100))) as Array<{
            trigger_event_id: string;
            payload_json: string;
            attempt_count: number;
        }>;
        return rows.map(row => ({
            trigger_event_id: row.trigger_event_id,
            payload: JSON.parse(row.payload_json || '{}') as Record<string, unknown>,
            attempt_count: row.attempt_count,
        }));
    }

    markGroupWorkSubmitted(triggerEventId: string): void {
        const now = Date.now();
        this.db.prepare(`
            UPDATE group_work_runs
            SET status = 'submitted', attempt_count = attempt_count + 1,
                next_attempt_at = ?, last_error = NULL, updated_at = ?
            WHERE trigger_event_id = ? AND status != 'completed'
        `).run(now + 60_000, now, triggerEventId);
    }

    markGroupWorkResult(triggerEventId: string, success: boolean, error?: string): void {
        const row = this.db.prepare(`
            SELECT attempt_count FROM group_work_runs WHERE trigger_event_id = ?
        `).get(triggerEventId) as { attempt_count: number } | undefined;
        if (!row) return;
        const now = Date.now();
        if (success) {
            this.db.prepare(`
                UPDATE group_work_runs
                SET status = 'completed', next_attempt_at = ?, last_error = NULL, updated_at = ?
                WHERE trigger_event_id = ?
            `).run(now, now, triggerEventId);
            return;
        }
        const delays = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
        const delay = delays[Math.min(Math.max(row.attempt_count - 1, 0), delays.length - 1)];
        this.db.prepare(`
            UPDATE group_work_runs
            SET status = 'retry', next_attempt_at = ?, last_error = ?, updated_at = ?
            WHERE trigger_event_id = ? AND status != 'completed'
        `).run(now + delay, (error || 'Router 投递失败').slice(0, 2000), now, triggerEventId);
    }

    hasApprovalReceipt(approvalId: string): boolean {
        return Boolean(this.db.prepare(
            'SELECT 1 AS found FROM group_approval_receipts WHERE approval_id = ?',
        ).get(approvalId));
    }

    recordApprovalReceipt(approvalId: string, projectId: string, decision: string): void {
        this.db.prepare(`
            INSERT OR IGNORE INTO group_approval_receipts(approval_id, project_id, decision, saved_at)
            VALUES (?, ?, ?, ?)
        `).run(approvalId, projectId, decision, Date.now());
    }

    claimGroupPlanning(planningToken: string, collaborationId: string, projectId: string): boolean {
        const now = Date.now();
        const existing = this.db.prepare(`
            SELECT status, updated_at FROM group_planning_runs WHERE planning_token = ?
        `).get(planningToken) as { status: string; updated_at: number } | undefined;
        if (existing && (existing.status === 'completed' || now - existing.updated_at < 10 * 60_000)) {
            return false;
        }
        this.db.prepare(`
            INSERT INTO group_planning_runs(planning_token, collaboration_id, project_id, status, updated_at)
            VALUES (?, ?, ?, 'running', ?)
            ON CONFLICT(planning_token) DO UPDATE SET
                collaboration_id = excluded.collaboration_id,
                project_id = excluded.project_id,
                status = 'running',
                updated_at = excluded.updated_at
        `).run(planningToken, collaborationId, projectId, now);
        return true;
    }

    completeGroupPlanning(planningToken: string): void {
        this.db.prepare(`
            UPDATE group_planning_runs SET status = 'completed', updated_at = ? WHERE planning_token = ?
        `).run(Date.now(), planningToken);
    }

    releaseGroupPlanning(planningToken: string): void {
        this.db.prepare(`
            DELETE FROM group_planning_runs WHERE planning_token = ? AND status = 'running'
        `).run(planningToken);
    }

    claimGroupWorkOrder(input: {
        workOrderId: string;
        idempotencyKey: string;
        projectId: string;
        sessionId: string;
        taskId: string;
        payload: Record<string, unknown>;
    }): { claimed: boolean; receipt?: GroupWorkOrderReceipt } {
        const existing = this.db.prepare(`
            SELECT work_order_id, idempotency_key, project_id, session_id, task_id,
                   status, result_summary, payload_json
            FROM group_work_order_receipts
            WHERE work_order_id = ? OR idempotency_key = ?
        `).get(input.workOrderId, input.idempotencyKey) as GroupWorkOrderReceipt | undefined;
        if (existing) return { claimed: false, receipt: existing };
        this.db.prepare(`
            INSERT INTO group_work_order_receipts(
                work_order_id, idempotency_key, project_id, session_id, task_id,
                status, payload_json, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'received', ?, ?)
        `).run(
            input.workOrderId,
            input.idempotencyKey,
            input.projectId,
            input.sessionId,
            input.taskId,
            JSON.stringify(input.payload),
            Date.now(),
        );
        return { claimed: true };
    }

    updateGroupWorkOrderReceipt(workOrderId: string, status: string, resultSummary?: string): void {
        this.db.prepare(`
            UPDATE group_work_order_receipts
            SET status = ?, result_summary = COALESCE(?, result_summary), updated_at = ?
            WHERE work_order_id = ?
        `).run(status, resultSummary ?? null, Date.now(), workOrderId);
    }

    getGroupWorkOrderReceipt(workOrderId: string): GroupWorkOrderReceipt | undefined {
        return this.db.prepare(`
            SELECT work_order_id, idempotency_key, project_id, session_id, task_id,
                   status, result_summary, payload_json
            FROM group_work_order_receipts WHERE work_order_id = ?
        `).get(workOrderId) as GroupWorkOrderReceipt | undefined;
    }

    listGroupWorkOrderReceipts(limit = 500): GroupWorkOrderReceipt[] {
        return this.db.prepare(`
            SELECT work_order_id, idempotency_key, project_id, session_id, task_id,
                   status, result_summary, payload_json
            FROM group_work_order_receipts
            ORDER BY updated_at ASC
            LIMIT ?
        `).all(Math.max(1, Math.min(limit, 2000))) as GroupWorkOrderReceipt[];
    }

    getGroupWorkOrderByTask(taskId: string): GroupWorkOrderReceipt | undefined {
        return this.db.prepare(`
            SELECT work_order_id, idempotency_key, project_id, session_id, task_id,
                   status, result_summary, payload_json
            FROM group_work_order_receipts WHERE task_id = ?
            ORDER BY updated_at DESC LIMIT 1
        `).get(taskId) as GroupWorkOrderReceipt | undefined;
    }

    recordGroupAgentMessage(input: {
        routerMessageId: string;
        externalMessageId: string;
        targetTaskId: string;
        kind: string;
        content: string;
    }): boolean {
        const result = this.db.prepare(`
            INSERT OR IGNORE INTO group_agent_message_receipts(
                router_message_id, external_message_id, target_task_id, kind, content, saved_at
            ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
            input.routerMessageId,
            input.externalMessageId,
            input.targetTaskId,
            input.kind,
            input.content,
            Date.now(),
        );
        return result.changes > 0;
    }

    claimGroupAgentMessageHandling(routerMessageId: string): {
        claimed: boolean;
        receipt?: GroupAgentMessageReceipt;
    } {
        const receipt = this.getGroupAgentMessageReceipt(routerMessageId);
        if (!receipt || receipt.handled_at) return { claimed: false, receipt };
        const result = this.db.prepare(`
            UPDATE group_agent_message_receipts
            SET handled_at = ?
            WHERE router_message_id = ? AND handled_at IS NULL
        `).run(Date.now(), routerMessageId);
        return { claimed: result.changes > 0, receipt };
    }

    getGroupAgentMessageReceipt(routerMessageId: string): GroupAgentMessageReceipt | undefined {
        return this.db.prepare(`
            SELECT router_message_id, external_message_id, target_task_id,
                   kind, content, saved_at, handled_at
            FROM group_agent_message_receipts
            WHERE router_message_id = ?
        `).get(routerMessageId) as GroupAgentMessageReceipt | undefined;
    }

    private decodeMessageRow(row: Record<string, unknown>): Record<string, unknown> {
        return {
            ...row,
            deleted: Boolean(row.deleted),
            suppress_agent_execution: Boolean(row.suppress_agent_execution),
            mentions: JSON.parse(String(row.mentions_json || '[]')),
            attachments: JSON.parse(String(row.attachments_json || '[]')),
            collaboration_event: row.collaboration_event_json
                ? JSON.parse(String(row.collaboration_event_json))
                : null,
        };
    }

    close(): void {
        this.db.close();
    }
}
