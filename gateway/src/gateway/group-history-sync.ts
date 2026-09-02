import type { GroupHistoryArchive, HistoryJob, HistoryKey, SummaryChunk } from './group-history-archive';
import { historyScope } from './group-history-archive';
import { normalizeFeishuHistory } from './group-history-messages';
import type { RouterGroupCollaboration } from './router-bridge';

interface Dependencies {
    archive: GroupHistoryArchive;
    connected(): boolean;
    groups(): Promise<RouterGroupCollaboration[]>;
    request(action: 'page' | 'request' | 'summary.poll' | 'summary.offer', payload: Record<string, unknown>): Promise<any>;
    ensureSession(group: RouterGroupCollaboration, projectId: string): string | undefined;
    changed(job: HistoryJob, imported: boolean): void;
    summarize(key: HistoryKey, messages: any[], signal: AbortSignal): Promise<Pick<SummaryChunk, 'summary' | 'ledger'> | undefined>;
    busy(): boolean;
}

/** Pages go directly to the local archive, never through the executable message queue. */
export class GroupHistorySync {
    private groups = new Map<string, RouterGroupCollaboration>();
    private epochs = new Map<string, number>();
    private running = false;
    private summarizing = false;
    private summaryController?: { scope: string; controller: AbortController };
    private closed = false;
    private refreshedAt = 0;
    private summaryAfter = new Map<string, number>();
    private summarySeen = new Map<string, string[]>();
    private relayAfter = new Map<string, number>();
    private summaryRetryAt = new Map<string, number>();
    private timers: ReturnType<typeof setInterval>[] = [];

    constructor(private readonly deps: Dependencies) {}

    start(): void {
        this.timers.push(setInterval(() => { void this.tick(); }, 1500), setInterval(() => { void this.summarizeTick(); }, 5000));
        for (const timer of this.timers) timer.unref();
    }
    close(): void { this.closed = true; this.summaryController?.controller.abort(); for (const timer of this.timers) clearInterval(timer); }

    reconcile(groups: RouterGroupCollaboration[]): void {
        const valid = new Set<string>();
        this.groups.clear();
        for (const group of groups) {
            const member = group.members.find(item => item.id === group.current_member_id);
            if (group.history_protocol !== 1 || group.status !== 'active' || !member || member.status !== 'active') continue;
            const sessionId = this.deps.ensureSession(group, member.project_id);
            if (!sessionId) continue;
            const key: HistoryKey = { projectId: member.project_id, platformId: group.platform_id,
                workspaceId: group.workspace_id, channelId: group.channel_id };
            const scope = historyScope(key);
            valid.add(scope);
            this.groups.set(scope, group);
            const previous = this.deps.archive.job(key);
            const granted = Boolean(group.history_policy?.enabled);
            const version = group.history_policy?.version;
            if (!previous) {
                this.save({ collaborationId: group.id, key, sessionId, status: granted ? 'pending' : 'waiting_authorization',
                    cursor: '', rootDone: false, threads: {}, finishedThreads: [], imported: 0, nextAttemptAt: 0, grantVersion: version });
            } else if (previous.grantVersion !== version || previous.status === 'inactive'
                || (granted && previous.status === 'waiting_authorization')) {
                this.bump(scope);
                this.save({ ...previous, collaborationId: group.id, grantVersion: version, cursor: '', rootDone: false,
                    threads: {}, finishedThreads: [], status: granted ? 'pending' : 'waiting_authorization',
                    nextAttemptAt: 0, error: undefined, code: undefined });
            } else if (!granted && previous.status !== 'waiting_authorization') {
                this.bump(scope);
                this.save({ ...previous, status: 'waiting_authorization', error: undefined, code: undefined });
            }
        }
        for (const job of this.deps.archive.jobs()) {
            const scope = historyScope(job.key);
            if (!valid.has(scope) && job.status !== 'inactive') {
                this.bump(scope);
                this.save({ ...job, status: 'inactive' });
            }
        }
        this.refreshedAt = Date.now();
    }

    status(sessionId: string): Record<string, unknown> | undefined {
        const job = this.deps.archive.jobs().find(item => item.sessionId === sessionId);
        return job ? { status: job.status, imported: this.deps.archive.count(job.key), error: job.error, code: job.code,
            summaryPaused: job.summaryPaused, summaryReady: this.deps.archive.summaryReady(job.key),
            summaryError: job.summaryError, snapshotMs: job.snapshotMs } : undefined;
    }

    async control(sessionId: string, action: string): Promise<void> {
        const job = this.deps.archive.jobs().find(item => item.sessionId === sessionId);
        if (!job) throw new Error('当前会话没有可同步的飞书群历史');
        if (action === 'authorize') {
            const result = await this.deps.request('request', { collaboration_id: job.collaborationId, project_id: job.key.projectId });
            if (!result.success) throw new Error(result.message || '请求历史共享确认失败');
            return;
        }
        if (!['pause', 'resume', 'retry', 'summary_pause', 'summary_resume'].includes(action)) throw new Error('不支持的历史同步操作');
        if (job.status === 'inactive') throw new Error('请先恢复群协作连接');
        this.bump(historyScope(job.key));
        if (action.startsWith('summary_')) job.summaryPaused = action === 'summary_pause';
        else if (action === 'pause') job.status = 'paused';
        else {
            job.status = 'pending'; job.nextAttemptAt = 0; job.error = undefined;
            // Explicit retry starts a fresh snapshot; stable message IDs avoid duplicate rows.
            if (action === 'retry') { job.cursor = ''; job.rootDone = false; job.threads = {}; job.finishedThreads = []; }
        }
        this.summaryRetryAt.delete(historyScope(job.key));
        this.save(job);
    }

    ready(key: HistoryKey): boolean {
        const job = this.deps.archive.job(key);
        // Legacy peers without the new capability retain their existing flow.
        return !job || (job.status === 'complete' && this.deps.archive.summaryReady(key));
    }

    async tick(): Promise<void> {
        if (this.closed || this.running || !this.deps.connected()) return;
        this.running = true;
        try {
            if (Date.now() - this.refreshedAt > 15_000) this.reconcile(await this.deps.groups());
            const job = this.deps.archive.jobs().filter(item => ['pending', 'syncing'].includes(item.status)
                && item.nextAttemptAt <= Date.now()).sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)[0];
            if (!job) return;
            const scope = historyScope(job.key), epoch = this.epochs.get(scope) || 0;
            const group = this.groups.get(scope);
            if (!group) return;
            const thread = job.rootDone ? Object.keys(job.threads)[0] : undefined;
            if (job.rootDone && !thread) { this.save({ ...job, status: 'complete' }); return; }
            job.status = 'syncing';
            this.save(job);
            const result = await this.deps.request('page', { collaboration_id: job.collaborationId,
                project_id: job.key.projectId, cursor: thread ? job.threads[thread] : job.cursor });
            if (this.closed || epoch !== (this.epochs.get(scope) || 0)) return;
            if (!result.success) {
                job.error = result.message || '历史同步暂时失败'; job.code = result.code;
                if (result.code === 'authorization_required') job.status = 'waiting_authorization';
                else if (['inactive', 'not_joined', 'member_not_in_group', 'bot_not_in_group'].includes(result.code)) job.status = 'inactive';
                else if (['cursor_expired', 'invalid_cursor'].includes(result.code)) {
                    job.cursor = ''; job.rootDone = false; job.threads = {}; job.finishedThreads = [];
                    job.status = 'pending'; job.nextAttemptAt = Date.now() + 10_000;
                } else if (result.retry_after) { job.status = 'pending'; job.nextAttemptAt = Date.now() + Math.max(1, result.retry_after) * 1000; }
                else job.status = 'error';
                this.save(job); return;
            }
            const events = result.items.map((item: any) => normalizeFeishuHistory(item, group, job.key.projectId, result.current_member_platform_id));
            if (thread) {
                if (result.cursor) job.threads[thread] = result.cursor;
                else { delete job.threads[thread]; job.finishedThreads.push(thread); }
            } else {
                job.cursor = result.cursor || ''; job.rootDone = !job.cursor;
                for (const [id, cursor] of Object.entries(result.thread_cursors || {})) {
                    if (!job.finishedThreads.includes(id) && !job.threads[id]) job.threads[id] = String(cursor);
                }
            }
            job.snapshotMs = result.snapshot_ms; job.grantVersion = result.grant_version;
            job.error = undefined; job.code = undefined; job.nextAttemptAt = Date.now() + 1000;
            job.status = job.rootDone && Object.keys(job.threads).length === 0 ? 'complete' : 'pending';
            const imported = this.deps.archive.importPage(events, job);
            this.deps.changed(job, imported > 0);
        } catch (error) {
            if (this.closed) return;
            // Network failures retain the persisted cursor. Do not log group text or credentials.
            this.refreshedAt = 0;
            for (const job of this.deps.archive.jobs().filter(item => item.status === 'syncing')) {
                const network = /连接|超时|timeout|network|fetch|econn/i.test(String(error));
                this.save({ ...job, status: network ? 'pending' : 'error', nextAttemptAt: Date.now() + 15_000,
                    error: network ? '连接暂时中断，稍后继续历史同步' : '历史消息保存失败，请检查本机磁盘空间后重试' });
            }
        } finally { this.running = false; }
    }

    async summarizeTick(): Promise<void> {
        if (this.closed || this.summarizing || this.deps.busy() || !this.deps.connected()) return;
        this.summarizing = true;
        let current: HistoryJob | undefined;
        try {
            for (const job of this.deps.archive.jobs()) {
                current = job;
                const scope = historyScope(job.key);
                if (job.status !== 'complete' || job.summaryPaused || (this.summaryRetryAt.get(scope) || 0) > Date.now()) continue;
                const epoch = this.epochs.get(scope) || 0;
                if ((this.relayAfter.get(scope) || 0) <= Date.now()) {
                    this.relayAfter.set(scope, Date.now() + 30_000);
                    try {
                        const own = this.deps.archive.chunks(job.key, this.summaryAfter.get(scope) || 0, 3);
                        this.summaryAfter.set(scope, own.at(-1)?.id || 0);
                        if (own.length) await this.deps.request('summary.offer', { collaboration_id: job.collaborationId,
                            project_id: job.key.projectId, chunks: own.map(({ summary, ledger, sources, updatedAt }) => ({ summary, ledger, sources, updatedAt })) });
                        if (this.closed || epoch !== (this.epochs.get(scope) || 0)) return;
                        if (!this.deps.archive.summaryReady(job.key)) {
                            const seen = this.summarySeen.get(scope) || [];
                            const shared = await this.deps.request('summary.poll', { collaboration_id: job.collaborationId, project_id: job.key.projectId, seen });
                            if (this.closed || epoch !== (this.epochs.get(scope) || 0)) return;
                            for (const chunk of shared.chunks || []) {
                                // Source hashes, not the donor's local row numbers, prove coverage.
                                this.deps.archive.saveChunk({ key: job.key, summary: chunk.summary, ledger: chunk.ledger,
                                    sources: chunk.sources, updatedAt: chunk.updatedAt });
                                seen.push(chunk.relay_id);
                            }
                            this.summarySeen.set(scope, seen.slice(-128));
                        }
                    } catch { /* Relay availability is optional; local summarization is the fallback. */ }
                    if (this.closed || epoch !== (this.epochs.get(scope) || 0)) return;
                }
                let messages = this.deps.archive.pendingSummary(job.key);
                if (!messages.length) { this.deps.changed(this.deps.archive.job(job.key)!, false); continue; }
                // Bound each call, but never discard the rest of the backlog.
                const selected: any[] = []; let length = 0;
                for (const message of messages) {
                    const size = String(message.text || '').length + 300;
                    if (selected.length && length + size > 32_000) break;
                    selected.push(message); length += size;
                }
                messages = selected;
                const controller = new AbortController();
                this.summaryController = { scope, controller };
                const summary = await this.deps.summarize(job.key, messages, controller.signal);
                if (this.closed || epoch !== (this.epochs.get(scope) || 0)) return;
                if (summary && this.deps.archive.saveChunk({ ...summary, key: job.key,
                    sources: messages.map(message => ({ messageId: message.message_id, revision: message.revision })), updatedAt: Date.now() })) {
                    const fresh = this.deps.archive.job(job.key)!;
                    fresh.summaryError = undefined;
                    this.save(fresh);
                } else {
                    this.summaryRetryAt.set(scope, Date.now() + 60_000);
                    this.save({ ...this.deps.archive.job(job.key)!, summaryError: '历史摘要暂时无法整理，请检查模型配置后重试；原文已保存在本机' });
                }
                break;
            }
        } catch {
            if (this.closed) return;
            if (this.summaryController?.controller.signal.aborted) return;
            if (current) {
                this.summaryRetryAt.set(historyScope(current.key), Date.now() + 60_000);
                const fresh = this.deps.archive.job(current.key);
                if (fresh) this.save({ ...fresh, summaryError: '历史摘要整理失败，请检查模型配置；完整原文仍在本机' });
            }
        } finally { this.summarizing = false; this.summaryController = undefined; }
    }

    private bump(scope: string): void {
        this.epochs.set(scope, (this.epochs.get(scope) || 0) + 1);
        if (this.summaryController?.scope === scope) this.summaryController.controller.abort();
    }
    private save(job: HistoryJob): void { this.deps.archive.saveJob(job); this.deps.changed(job, false); }
}
