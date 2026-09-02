import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectContextStore } from './project-context-store';
import { GroupHistorySync } from './group-history-sync';
import { historyRevision, type HistoryJob, type HistoryKey } from './group-history-archive';
import { normalizeFeishuHistory, historySessionMessage, mergeHistoryMessages } from './group-history-messages';
import type { RouterGroupCollaboration } from './router-bridge';

const key: HistoryKey = { projectId: 'project-c', platformId: 'platform', workspaceId: 'workspace', channelId: 'chat' };
const group: RouterGroupCollaboration = { id: 'collab', platform_id: 'platform', workspace_id: 'workspace', channel_id: 'chat',
    channel_name: 'Team', status: 'active', planning_state: 'idle', history_protocol: 1, history_policy: { enabled: true, version: 'v1' },
    current_member_id: 'member-c', members: [{ id: 'member-c', app_id: 'app', app_user_id: 'device-c', platform_member_id: 'open-c',
        project_id: key.projectId, project_name: 'C', display_name: 'C', role_name: 'QA', flux_user_id: 'c',
        status: 'active', member_kind: 'member', manager_dispatch_enabled: false }] };
const item = (i: number, extra = {}) => ({ message_id: `om_${i}`, chat_id: 'chat', msg_type: 'text', sender: { id: 'open-a', sender_type: 'user' },
    create_time: String(i + 1), body: { content: JSON.stringify({ text: `discussion ${i}` }) }, ...extra });
const event = (i: number, extra = {}) => normalizeFeishuHistory(item(i, extra), group, key.projectId, 'open-c');
const job = (): HistoryJob => ({ key, collaborationId: group.id, sessionId: 'project-thread-test', status: 'complete', cursor: '',
    rootDone: true, threads: {}, finishedThreads: [], imported: 0, nextAttemptAt: 0, grantVersion: 'v1' });

async function fixture(t: any) {
    const dir = await mkdtemp(join(tmpdir(), 'openflux-history-test-'));
    const store = new ProjectContextStore(dir);
    t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
    return store;
}

test('ten thousand messages are retained, isolated by Project, and summarized beyond 500', async t => {
    const store = await fixture(t), archive = store.history;
    const events = Array.from({ length: 10000 }, (_, i) => event(i));
    archive.importPage(events, job());
    archive.importPage(events, job());
    assert.equal(archive.events(key).length, 10000);
    archive.importPage([{ ...event(1), project_id: 'another-project' }], { ...job(), key: { ...key, projectId: 'another-project' } });
    assert.equal(archive.events({ ...key, projectId: 'another-project' }).length, 1);
    let covered = 0;
    for (;;) {
        const rows = archive.pendingSummary(key);
        if (!rows.length) break;
        assert.ok(rows.length <= 200);
        assert.ok(archive.saveChunk({ key, summary: 'test summary', ledger: {}, updatedAt: Date.now(),
            sources: rows.map(row => ({ messageId: row.message_id, revision: row.revision })) }));
        covered += rows.length;
    }
    assert.equal(covered, 9950);
    assert.equal(archive.summaryReady(key), true);
    assert.equal(archive.events(key).length, 10000);
});

test('edit and recall invalidate summaries; old history cannot resurrect a recalled message', async t => {
    const { history: archive } = await fixture(t);
    archive.importPage(Array.from({ length: 60 }, (_, i) => event(i)), job());
    const rows = archive.pendingSummary(key);
    archive.saveChunk({ key, summary: 'old decision', ledger: {}, sources: rows.map(row => ({ messageId: row.message_id, revision: row.revision })), updatedAt: 1 });
    archive.put({ ...event(0), text: 'new decision', edited_at: 1000 }, 'live');
    assert.equal(archive.chunks(key).length, 0);
    assert.equal(archive.summaryReady(key), false);
    archive.put({ ...event(0), event_type: 'message_deleted', edited_at: 2000 }, 'live');
    archive.put(event(0), 'history');
    assert.equal(archive.events(key)[0].text, '');
    assert.equal(archive.events(key)[0].event_type, 'message_deleted');
});

test('summary reuse validates original message revisions, not local IDs or URLs', async t => {
    const { history: archive } = await fixture(t);
    archive.importPage([event(1)], job());
    const chunk = { key, summary: 'known fact', ledger: {}, sources: [{ messageId: 'om_1', revision: historyRevision(event(1)) }], updatedAt: 1 };
    assert.equal(archive.saveChunk({ ...chunk, sources: [{ messageId: 'other', revision: 'bad' }] }), false);
    assert.equal(archive.saveChunk(chunk), true);
    assert.equal(archive.saveChunk(chunk), true);
    assert.equal(archive.chunks(key).length, 1);
    assert.equal(historyRevision({ ...event(1), attachments: [{ id: 'file', type: 'image', url: 'https://old' }] }),
        historyRevision({ ...event(1), attachments: [{ id: 'file', type: 'image', url: 'https://new', local_path: 'D:/local' }] }));
});

test('history normalizer preserves rich text, sender identity and attachment references without executing', () => {
    const normalized = event(1, { sender: { id: 'open-c', sender_type: 'user' }, body: { content: JSON.stringify({ zh_cn: { title: 'Note', content: [
        [{ tag: 'text', text: 'hello ' }, { tag: 'text', text: 'world' }], [{ tag: 'img', image_key: 'img-key' }],
    ] } }) } });
    assert.equal(normalized.text, 'Note\nhello world\n[图片]');
    assert.equal(normalized.sender_is_current_member, true);
    assert.equal(normalized.sender_display_name, 'C');
    assert.equal(normalized.suppress_agent_execution, true);
    assert.equal(normalized.bot_mentioned, false);
    assert.equal(normalized.agent_execution_allowed, false);
    assert.equal(normalized.attachments[0].url, undefined);
    assert.equal(normalized.attachments[0].local_path, undefined);
    assert.throws(() => event(1, { chat_id: 'another-group' }));
});

test('history overlay retains native execution metadata and does not duplicate external message IDs', () => {
    const history = historySessionMessage(event(1));
    const native = { ...history, id: 'native', content: 'old', metadata: { ...history.metadata, turnId: 'turn-1', activity: ['tool'] } };
    const merged = mergeHistoryMessages([native], [history, history]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].id, 'native');
    assert.equal(merged[0].metadata?.turnId, 'turn-1');
    assert.equal(merged[0].content, history.content);
    const recalled = historySessionMessage({ ...event(1), event_type: 'message_deleted', text: '' });
    assert.equal(mergeHistoryMessages([{ ...native, attachments: [{ path: 'local.png', name: 'image', size: 1, ext: '.png' }] }], [recalled])[0].attachments, undefined);
});

function sync(store: ProjectContextStore, request: (action: string, payload: any) => Promise<any>, options: any = {}) {
    return new GroupHistorySync({ archive: store.history, connected: () => true, groups: async () => [group], request,
        ensureSession: () => 'project-thread-test', changed: () => {}, busy: () => false,
        summarize: async () => ({ summary: 'summary', ledger: {} }), ...options });
}

test('root and thread pages checkpoint atomically and restart without replaying old commands', async t => {
    const store = await fixture(t);
    const cursors: string[] = [];
    const request = async (_action: string, payload: any) => {
        cursors.push(payload.cursor);
        if (!payload.cursor) return { success: true, items: [item(1)], cursor: 'page2', thread_cursors: { thread: 'thread1' }, grant_version: 'v1' };
        if (payload.cursor === 'page2') return { success: true, items: [item(2)], cursor: '', grant_version: 'v1' };
        return { success: true, items: [item(3, { thread_id: 'thread' })], cursor: '', grant_version: 'v1' };
    };
    let worker = sync(store, request);
    worker.reconcile([group]); await worker.tick(); worker.close();
    assert.equal(store.history.job(key)?.cursor, 'page2');
    worker = sync(store, request); worker.reconcile([group]);
    for (let i = 0; i < 2; i++) {
        const current = store.history.job(key)!; current.nextAttemptAt = 0; store.history.saveJob(current); await worker.tick();
    }
    worker.close();
    assert.deepEqual(cursors, ['', 'page2', 'thread1']);
    assert.equal(store.history.job(key)?.status, 'complete');
    assert.equal(store.history.events(key).length, 3);
    assert.equal(store.history.events(key)[2].thread_id, 'thread');
    assert.equal(store.hasDelivery('history:om_1:2'), false);
});

test('pausing while a page is in flight discards the late response', async t => {
    const store = await fixture(t);
    let finish!: (response: any) => void;
    const worker = sync(store, async () => new Promise(resolve => { finish = resolve; }));
    worker.reconcile([group]); const pending = worker.tick();
    await worker.control('project-thread-test', 'pause');
    finish({ success: true, items: [item(1)], cursor: '', grant_version: 'v1' });
    await pending; worker.close();
    assert.equal(store.history.events(key).length, 0);
    assert.equal(store.history.job(key)?.status, 'paused');
});

test('no grant, old Router, and departed members cannot pull group history', async t => {
    const store = await fixture(t);
    let calls = 0;
    const worker = sync(store, async () => { calls++; throw new Error('must not fetch'); });
    worker.reconcile([{ ...group, history_policy: {} }]); await worker.tick();
    assert.equal(store.history.job(key)?.status, 'waiting_authorization');
    assert.equal(worker.ready(key), false);
    worker.reconcile([{ ...group, history_protocol: undefined }]); await worker.tick();
    assert.equal(store.history.job(key)?.status, 'inactive');
    assert.equal(calls, 0);
    worker.close();
});

test('permanent API errors are visible; throttling retains the cursor for automatic retry', async t => {
    const store = await fixture(t);
    let result: any = { success: false, code: 'rate_limited', retry_after: 10, message: 'wait' };
    const worker = sync(store, async () => result);
    worker.reconcile([group]); await worker.tick();
    assert.equal(store.history.job(key)?.status, 'pending');
    assert.ok(store.history.job(key)!.nextAttemptAt > Date.now());
    await worker.control('project-thread-test', 'retry');
    result = { success: false, code: 'permission_denied', message: 'permission missing' };
    await worker.tick(); worker.close();
    assert.equal(store.history.job(key)?.status, 'error');
    assert.equal(store.history.job(key)?.error, 'permission missing');
});

test('summary worker drains all chunks and reuses verified peer summaries without a model call', async t => {
    const store = await fixture(t);
    store.history.importPage(Array.from({ length: 700 }, (_, i) => event(i)), job());
    let modelCalls = 0;
    let modelMessages = 0;
    const rows = store.history.pendingSummary(key);
    const peer = { summary: 'peer facts', ledger: {}, updatedAt: 1, relay_id: 'relay',
        sources: rows.map(row => ({ messageId: row.message_id, revision: row.revision })) };
    const worker = sync(store, async (action: string) => action === 'summary.poll' ? { success: true, chunks: [peer] } : { success: true },
        { summarize: async (_key: unknown, messages: any[]) => { modelCalls++; modelMessages += messages.length; return { summary: 'own facts', ledger: {} }; } });
    worker.reconcile([group]);
    for (let i = 0; i < 5; i++) await worker.summarizeTick();
    worker.close();
    assert.equal(store.history.summaryReady(key), true);
    assert.equal(modelMessages, 450);
    assert.ok(modelCalls <= 5);
});

test('pausing summary work aborts the active model call and does not save partial coverage', async t => {
    const store = await fixture(t);
    store.history.importPage(Array.from({ length: 60 }, (_, i) => event(i)), job());
    let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const worker = sync(store, async () => ({ success: true, chunks: [] }), {
        summarize: async (_key: unknown, _messages: any[], signal: AbortSignal) => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); began();
        }),
    });
    worker.reconcile([group]);
    const pending = worker.summarizeTick();
    await started;
    await worker.control('project-thread-test', 'summary_pause');
    await pending; worker.close();
    assert.equal(store.history.chunks(key).length, 0);
    assert.equal(store.history.job(key)?.summaryPaused, true);
    assert.equal(store.history.job(key)?.summaryError, undefined);
});

test('archive and cursor survive a real SQLite close and reopen', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'openflux-history-reopen-'));
    let store = new ProjectContextStore(dir);
    t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
    const progress = { ...job(), status: 'pending' as const, cursor: 'page-next', rootDone: false };
    store.history.importPage([event(1), event(2)], progress);
    store.close();
    store = new ProjectContextStore(dir);
    assert.equal(store.history.events(key).length, 2);
    assert.equal(store.history.job(key)?.cursor, 'page-next');
    assert.equal(store.history.job(key)?.imported, 2);
    assert.equal(store.history.importPage([event(1), event(2)], progress), 0);
});
