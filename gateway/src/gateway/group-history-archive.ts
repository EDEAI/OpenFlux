import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ProjectContextEvent } from './project-context-store';

export interface HistoryKey { projectId: string; platformId: string; workspaceId: string; channelId: string; threadId?: string }
export interface HistoryJob {
    collaborationId: string; key: HistoryKey; sessionId: string;
    status: 'pending' | 'syncing' | 'waiting_authorization' | 'paused' | 'error' | 'complete' | 'inactive';
    cursor: string; rootDone: boolean; threads: Record<string, string>; finishedThreads: string[];
    imported: number; snapshotMs?: number; grantVersion?: string; error?: string; code?: string; nextAttemptAt: number;
    summaryPaused?: boolean;
    summaryError?: string;
}
export interface SummaryChunk {
    id?: number; key: HistoryKey; summary: string; ledger: Record<string, string[]>;
    sources: Array<{ messageId: string; revision: string }>; updatedAt: number;
}

const scopeValues = (key: HistoryKey) => [key.projectId, key.platformId, key.workspaceId, key.channelId];
const scopeSQL = 'project_id = ? AND platform_id = ? AND workspace_id = ? AND channel_id = ?';
export const historyScope = (key: HistoryKey) => JSON.stringify(scopeValues(key));

export function historyRevision(event: Record<string, any>): string {
    // Local attachment paths and short-lived download URLs are not portable identities.
    const attachments = (event.attachments || []).map((item: any) => [item.id || '', item.type || '', item.name || '']);
    return createHash('sha256').update(JSON.stringify([
        event.message_id, event.thread_id || '', event.text || '', Boolean(event.deleted || event.event_type === 'message_deleted'),
        attachments,
    ])).digest('hex');
}

/** Additive storage: never change the legacy tables needed by older clients. */
export class GroupHistoryArchive {
    constructor(private readonly db: Database.Database) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS group_context_archive (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id TEXT NOT NULL, platform_id TEXT NOT NULL, workspace_id TEXT NOT NULL, channel_id TEXT NOT NULL,
                message_id TEXT NOT NULL, revision TEXT NOT NULL, version_at INTEGER NOT NULL, origin TEXT NOT NULL,
                data_json TEXT NOT NULL,
                UNIQUE(project_id, platform_id, workspace_id, channel_id, message_id)
            );
            CREATE INDEX IF NOT EXISTS ix_context_archive_scope ON group_context_archive(project_id, platform_id, workspace_id, channel_id);
            CREATE TABLE IF NOT EXISTS group_history_sync_jobs (scope TEXT PRIMARY KEY, data_json TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS group_context_summary_chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, thread_id TEXT NOT NULL,
                data_json TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS group_context_summary_coverage (
                scope TEXT NOT NULL, message_id TEXT NOT NULL, revision TEXT NOT NULL, chunk_id INTEGER NOT NULL,
                PRIMARY KEY(scope, message_id, revision)
            );
            CREATE VIEW IF NOT EXISTS group_history_messages AS SELECT
                id, project_id, platform_id, workspace_id, channel_id, message_id, revision,
                json_extract(data_json, '$.platform_type') AS platform_type,
                COALESCE(json_extract(data_json, '$.thread_id'), '') AS thread_id,
                json_extract(data_json, '$.channel_name') AS channel_name,
                json_extract(data_json, '$.event_id') AS last_event_id,
                json_extract(data_json, '$.event_type') AS event_type,
                json_extract(data_json, '$.sender_platform_id') AS sender_platform_id,
                json_extract(data_json, '$.sender_flux_user_id') AS sender_flux_user_id,
                json_extract(data_json, '$.sender_display_name') AS sender_display_name,
                json_extract(data_json, '$.sender_role_name') AS sender_role_name,
                json_extract(data_json, '$.sender_type') AS sender_type,
                COALESCE(json_extract(data_json, '$.suppress_agent_execution'), 1) AS suppress_agent_execution,
                json_extract(data_json, '$.collaboration_event') AS collaboration_event_json,
                COALESCE(json_extract(data_json, '$.text'), '') AS text,
                COALESCE(json_extract(data_json, '$.mentions'), '[]') AS mentions_json,
                COALESCE(json_extract(data_json, '$.attachments'), '[]') AS attachments_json,
                json_extract(data_json, '$.source_url') AS source_url,
                json_extract(data_json, '$.created_at') AS created_at,
                json_extract(data_json, '$.edited_at') AS edited_at,
                COALESCE(json_extract(data_json, '$.deleted'), 0) AS deleted,
                version_at AS updated_at
            FROM group_context_archive;
        `);
    }

    put(input: Record<string, any>, origin: 'live' | 'history'): boolean {
        const event: Record<string, any> = { ...input, event_id: input.event_id || input.last_event_id,
            deleted: Boolean(input.deleted || input.event_type === 'message_deleted') };
        const key = [event.project_id, event.platform_id, event.workspace_id, event.channel_id, event.message_id];
        const previous = this.db.prepare(`SELECT revision, version_at, origin, data_json FROM group_context_archive
            WHERE ${scopeSQL} AND message_id = ?`).get(...key) as any;
        let version = Number(event.edited_at || event.created_at || 0);
        if (origin === 'live' && event.deleted && !event.edited_at) version = Math.max(Date.now(), Number(previous?.version_at || 0) + 1);
        if (previous && (version < previous.version_at || (version === previous.version_at && origin === 'history' && previous.origin === 'live'))) return false;
        if (event.deleted) { event.text = ''; event.attachments = []; event.mentions = []; }
        const revision = historyRevision(event);
        if (previous?.revision === revision && previous.origin === origin) {
            // Preserve the latest event ID so current-request lookups remain resolvable.
            this.db.prepare(`UPDATE group_context_archive SET data_json = ?, version_at = ? WHERE ${scopeSQL} AND message_id = ?`)
                .run(JSON.stringify(event), version, ...key);
            return false;
        }
        const scope = JSON.stringify(key.slice(0, 4));
        if (previous && previous.revision !== revision) {
            this.db.prepare(`UPDATE group_context_summary_chunks SET active = 0 WHERE id IN
                (SELECT chunk_id FROM group_context_summary_coverage WHERE scope = ? AND message_id = ?)`).run(scope, event.message_id);
            this.db.prepare('DELETE FROM group_context_summary_coverage WHERE chunk_id IN (SELECT id FROM group_context_summary_chunks WHERE active = 0)').run();
            this.db.prepare(`DELETE FROM group_context_summaries WHERE ${scopeSQL}`).run(...key.slice(0, 4));
        }
        this.db.prepare(`INSERT INTO group_context_archive(project_id, platform_id, workspace_id, channel_id, message_id, revision, version_at, origin, data_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, platform_id, workspace_id, channel_id, message_id)
            DO UPDATE SET revision=excluded.revision, version_at=excluded.version_at, origin=excluded.origin, data_json=excluded.data_json`)
            .run(...key, revision, version, origin, JSON.stringify(event));
        return true;
    }

    seedLegacy(rows: Record<string, any>[]): void {
        this.db.transaction(() => { for (const row of rows) this.put(row, 'live'); })();
    }

    saveJob(job: HistoryJob): void {
        this.db.prepare('INSERT INTO group_history_sync_jobs(scope, data_json) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET data_json=excluded.data_json')
            .run(historyScope(job.key), JSON.stringify(job));
    }
    jobs(): HistoryJob[] {
        return (this.db.prepare('SELECT data_json FROM group_history_sync_jobs').all() as any[]).map(row => JSON.parse(row.data_json));
    }
    job(key: HistoryKey): HistoryJob | undefined {
        const row = this.db.prepare('SELECT data_json FROM group_history_sync_jobs WHERE scope=?').get(historyScope(key)) as any;
        return row ? JSON.parse(row.data_json) : undefined;
    }
    importPage(events: ProjectContextEvent[], job: HistoryJob): number {
        let added = 0;
        this.db.transaction(() => {
            for (const event of events) if (this.put({ ...event, suppress_agent_execution: true, agent_execution_allowed: false }, 'history')) added++;
            job.imported = this.count(job.key);
            this.saveJob(job);
        })();
        return added;
    }
    count(key: HistoryKey): number {
        return (this.db.prepare(`SELECT COUNT(*) AS count FROM group_context_archive WHERE ${scopeSQL}`)
            .get(...scopeValues(key)) as { count: number }).count;
    }
    events(key: HistoryKey): ProjectContextEvent[] {
        return (this.db.prepare(`SELECT data_json FROM group_context_archive WHERE ${scopeSQL}
            ORDER BY json_extract(data_json, '$.created_at'), message_id`).all(...scopeValues(key)) as any[])
            .map(row => JSON.parse(row.data_json));
    }
    scopes(): HistoryKey[] {
        return (this.db.prepare('SELECT DISTINCT project_id, platform_id, workspace_id, channel_id FROM group_context_archive').all() as any[])
            .map(row => ({ projectId: row.project_id, platformId: row.platform_id, workspaceId: row.workspace_id, channelId: row.channel_id }));
    }
    pendingSummary(key: HistoryKey, limit = 200): any[] {
        const recent = this.db.prepare(`SELECT message_id FROM group_history_messages WHERE ${scopeSQL} AND deleted=0
            ORDER BY created_at DESC, message_id DESC LIMIT 50`).all(...scopeValues(key)) as any[];
        const rows = this.db.prepare(`SELECT * FROM group_history_messages m WHERE ${scopeSQL} AND deleted=0
            AND NOT EXISTS (SELECT 1 FROM group_context_summary_coverage c WHERE c.scope=? AND c.message_id=m.message_id AND c.revision=m.revision)
            ORDER BY created_at, message_id LIMIT ?`).all(...scopeValues(key), historyScope(key), Math.max(1, limit) + 50) as any[];
        const recentIDs = new Set(recent.map(row => row.message_id));
        return rows.filter(row => !recentIDs.has(row.message_id)).slice(0, limit);
    }
    saveChunk(chunk: SummaryChunk): boolean {
        const scope = historyScope(chunk.key);
        // Never import a summary whose source versions cannot be verified locally.
        const valid = chunk.sources.length > 0 && chunk.sources.every(source => {
            const row = this.db.prepare(`SELECT revision FROM group_context_archive WHERE ${scopeSQL} AND message_id=?`)
                .get(...scopeValues(chunk.key), source.messageId) as any;
            return row?.revision === source.revision;
        });
        if (!valid) return false;
        const covered = chunk.sources.map(source => Boolean(this.db.prepare('SELECT 1 FROM group_context_summary_coverage WHERE scope=? AND message_id=? AND revision=?')
            .get(scope, source.messageId, source.revision)));
        if (covered.every(Boolean)) return true;
        // Keep one active chunk per source revision, so an edit invalidates all affected claims.
        if (covered.some(Boolean)) return false;
        this.db.transaction(() => {
            const result = this.db.prepare('INSERT INTO group_context_summary_chunks(scope, thread_id, data_json) VALUES (?, ?, ?)')
                .run(scope, chunk.key.threadId || '', JSON.stringify(chunk));
            const insert = this.db.prepare('INSERT OR REPLACE INTO group_context_summary_coverage(scope, message_id, revision, chunk_id) VALUES (?, ?, ?, ?)');
            for (const source of chunk.sources) insert.run(scope, source.messageId, source.revision, result.lastInsertRowid);
        })();
        return true;
    }
    chunks(key: HistoryKey, after = 0, limit = 20): SummaryChunk[] {
        return (this.db.prepare('SELECT id, data_json FROM group_context_summary_chunks WHERE scope=? AND active=1 AND id>? ORDER BY id LIMIT ?')
            .all(historyScope(key), after, limit) as any[]).map(row => ({ ...JSON.parse(row.data_json), id: row.id }));
    }
    summaryReady(key: HistoryKey): boolean { return this.pendingSummary(key, 1).length === 0; }

    search(key: HistoryKey, query: string, limit = 30): any[] {
        const value = query.trim().slice(0, 200).replace(/[\\%_]/g, char => `\\${char}`);
        return this.db.prepare(`SELECT * FROM group_history_messages WHERE ${scopeSQL} AND deleted=0
            AND text LIKE ? ESCAPE '\\' ORDER BY created_at DESC, id DESC LIMIT ?`)
            .all(...scopeValues(key), `%${value}%`, Math.max(1, Math.min(50, limit)));
    }

    recent(key: HistoryKey, limit = 50): any[] {
        return (this.db.prepare(`SELECT * FROM group_history_messages WHERE ${scopeSQL} AND deleted=0
            AND (? = '' OR thread_id = ?) ORDER BY created_at DESC, id DESC LIMIT ?`)
            .all(...scopeValues(key), key.threadId || '', key.threadId || '', limit) as any[]).reverse()
            .map(row => ({ ...row, attachments: JSON.parse(row.attachments_json || '[]') }));
    }

    message(key: HistoryKey, messageId: string): any {
        return this.db.prepare(`SELECT * FROM group_history_messages WHERE ${scopeSQL} AND message_id=? AND deleted=0`)
            .get(...scopeValues(key), messageId);
    }

    summaryContext(key: HistoryKey, terms: string[], budget = 18_000): string {
        const rows = (this.db.prepare('SELECT id, data_json FROM group_context_summary_chunks WHERE scope=? AND active=1 ORDER BY id DESC')
            .all(historyScope(key)) as any[]).map(row => ({ ...JSON.parse(row.data_json), id: row.id } as SummaryChunk));
        const score = (chunk: SummaryChunk) => terms.reduce((n, term) => n + (chunk.summary.toLowerCase().includes(term.toLowerCase()) ? 1 : 0), 0);
        rows.sort((a, b) => score(b) - score(a) || b.id! - a.id!);
        let text = `本地保留 ${rows.length} 段历史摘要；以下是相关和最近片段，不代表全部历史。可用 group_history 检索原文或分页查看其余摘要。\n`;
        for (const chunk of rows) {
            const line = `[历史片段 ${chunk.id}；来源 ${chunk.sources[0]?.messageId} 至 ${chunk.sources.at(-1)?.messageId}]\n${chunk.summary}\n账本：${JSON.stringify(chunk.ledger)}\n`;
            if (text.length + line.length <= budget) text += line;
        }
        return text;
    }
}
