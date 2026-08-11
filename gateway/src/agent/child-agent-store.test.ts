import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SessionStore } from '../sessions/store';
import { getAgentExecutionContext, runWithAgentExecutionContext } from '../runtime/execution-context';
import { ChildAgentStore } from './child-agent-store';
import { CollaborationManager } from './collaboration';
import { createSpawnTool } from '../tools/spawn';
import { createSessionsSpawnTool } from '../tools/sessions-spawn';

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'openflux-child-agent-'));
    const sessions = new SessionStore({ storePath: root });
    sessions.create('default', 'Parent', undefined, undefined, 'parent-session');
    const children = new ChildAgentStore(sessions);
    return {
        root,
        sessions,
        children,
        cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
}

function registerWorker(manager: CollaborationManager): void {
    manager.setAgentProvider(() => [{ id: 'worker', name: 'Worker', type: 'builtin' }]);
}

test('child records survive restart and stay hidden from normal session lists', () => {
    const f = fixture();
    try {
        f.children.create({
            id: 'collab-durable',
            source: 'collaboration',
            parentSessionId: 'parent-session',
            parentTurnId: 'turn-parent',
            agentId: 'worker',
            task: 'persist me',
            mode: 'run',
        });
        f.children.update('collab-durable', {
            status: 'completed',
            endTime: Date.now(),
            output: 'durable result',
        });

        const reopenedSessions = new SessionStore({ storePath: f.root });
        const reopened = new ChildAgentStore(reopenedSessions);
        const record = reopened.get('collab-durable');
        assert.equal(record?.output, 'durable result');
        assert.equal(record?.parentTurnId, 'turn-parent');
        assert.equal(record?.rootSessionId, 'parent-session');
        assert.deepEqual(reopenedSessions.list().map((item) => item.id), ['parent-session']);
        assert.deepEqual(
            reopenedSessions.list(undefined, { includeHidden: true }).map((item) => item.id).sort(),
            ['collab-durable', 'parent-session'],
        );
        const childMeta = reopenedSessions.get('collab-durable');
        assert.equal(childMeta?.kind, 'child');
        assert.equal(childMeta?.visibility, 'hidden');
    } finally {
        f.cleanup();
    }
});

test('persistent collaboration can be read and resumed after manager restart', async () => {
    const f = fixture();
    try {
        const first = new CollaborationManager({ childStore: f.children });
        registerWorker(first);
        first.setExecutor(async () => ({ output: 'first answer', agentId: 'worker' }));
        const spawned = await runWithAgentExecutionContext({
            sessionId: 'parent-session',
            turnId: 'turn-parent',
        }, () => first.spawn({
            agentId: 'worker',
            task: 'first question',
            mode: 'session',
            waitForResult: true,
        }));
        assert.equal(spawned.status, 'completed');

        const reopenedSessions = new SessionStore({ storePath: f.root });
        const second = new CollaborationManager({
            childStore: new ChildAgentStore(reopenedSessions),
        });
        registerWorker(second);
        second.setExecutor(async () => ({ output: 'second answer', agentId: 'worker' }));
        assert.equal(second.getSession(spawned.sessionId)?.status, 'idle');
        assert.equal(second.getSession(spawned.sessionId)?.output, 'first answer');

        const resumed = await second.resume({
            sessionId: spawned.sessionId,
            message: 'second question',
            timeout: 1,
        });
        assert.equal(resumed.output, 'second answer');
        assert.equal(second.getMessages(spawned.sessionId).length, 4);
        assert.deepEqual(
            reopenedSessions.getMessages(spawned.sessionId).map((message) => message.content),
            ['first question', 'first answer', 'second question', 'second answer'],
        );
    } finally {
        f.cleanup();
    }
});

test('parent cancellation reaches the child AbortSignal and persists interruption', async () => {
    const f = fixture();
    try {
        const manager = new CollaborationManager({ childStore: f.children });
        registerWorker(manager);
        const parent = new AbortController();
        let childSessionId = '';
        let childParentTurnId: string | undefined;
        let childWorkspaceRoot: string | undefined;
        let childGrantedReadPaths: string[] | undefined;
        let observedAbort = false;
        let startedResolve!: () => void;
        const started = new Promise<void>((resolve) => { startedResolve = resolve; });

        manager.setExecutor(async (_agentId, _task, sessionId) => {
            childSessionId = sessionId || '';
            const context = getAgentExecutionContext();
            childParentTurnId = context?.parentTurnId;
            childWorkspaceRoot = context?.workspaceRoot;
            childGrantedReadPaths = context?.userGrantedReadPaths;
            const signal = context?.abortSignal;
            assert.ok(signal);
            startedResolve();
            return new Promise((resolve, reject) => {
                signal.addEventListener('abort', () => {
                    observedAbort = true;
                    reject(signal.reason || new Error('aborted'));
                }, { once: true });
            });
        });

        const pending = runWithAgentExecutionContext({
            sessionId: 'parent-session',
            turnId: 'turn-parent',
            abortSignal: parent.signal,
            workspaceRoot: 'C:\\project',
            userGrantedReadPaths: ['C:\\input\\attached.txt'],
        }, () => manager.spawn({
            agentId: 'worker',
            task: 'long task',
            waitForResult: true,
            timeout: 10,
        }));
        await started;
        parent.abort(new Error('stop parent'));
        const result = await pending;

        assert.equal(result.status, 'failed');
        assert.equal(observedAbort, true);
        assert.equal(childParentTurnId, 'turn-parent');
        assert.equal(childWorkspaceRoot, 'C:\\project');
        assert.deepEqual(childGrantedReadPaths, ['C:\\input\\attached.txt']);
        assert.equal(f.children.get(childSessionId)?.status, 'interrupted');
        assert.equal(f.children.get(childSessionId)?.parentSessionId, 'parent-session');
    } finally {
        f.cleanup();
    }
});

test('timeout aborts the executor instead of only abandoning its promise', async () => {
    const f = fixture();
    try {
        const manager = new CollaborationManager({ childStore: f.children });
        registerWorker(manager);
        let childSessionId = '';
        let observedAbort = false;
        manager.setExecutor(async (_agentId, _task, sessionId) => {
            childSessionId = sessionId || '';
            const signal = getAgentExecutionContext()?.abortSignal;
            assert.ok(signal);
            return new Promise((resolve, reject) => {
                signal.addEventListener('abort', () => {
                    observedAbort = true;
                    reject(signal.reason || new Error('aborted'));
                }, { once: true });
            });
        });

        const result = await manager.spawn({
            agentId: 'worker',
            task: 'timeout task',
            waitForResult: true,
            timeout: 0.02,
        });
        assert.equal(result.status, 'timeout');
        assert.equal(observedAbort, true);
        assert.equal(f.children.get(childSessionId)?.status, 'timeout');
    } finally {
        f.cleanup();
    }
});

test('sessions_spawn forwards explicit tool parent context into hidden child metadata', async () => {
    const f = fixture();
    try {
        const manager = new CollaborationManager({ childStore: f.children });
        registerWorker(manager);
        manager.setExecutor(async () => ({ output: 'done', agentId: 'worker' }));
        const tool = createSessionsSpawnTool({ collaborationManager: manager });
        const result = await tool.execute({
            agentId: 'worker',
            task: 'context task',
            waitForResult: true,
        }, {
            sessionId: 'parent-session',
            turnId: 'tool-turn',
        });
        assert.equal(result.success, true);
        const sessionId = (result.data as { sessionId: string }).sessionId;
        assert.equal(f.children.get(sessionId)?.parentSessionId, 'parent-session');
        assert.equal(f.children.get(sessionId)?.parentTurnId, 'tool-turn');
    } finally {
        f.cleanup();
    }
});

test('spawn timeout aborts its execution callback and persists timeout state', async () => {
    const f = fixture();
    try {
        let observedAbort = false;
        let spawnedId = '';
        const tool = createSpawnTool({
            onExecute: async (params) => {
                spawnedId = params.id;
                const signal = params.parentAbortSignal;
                assert.ok(signal);
                return new Promise((resolve, reject) => {
                    signal.addEventListener('abort', () => {
                        observedAbort = true;
                        reject(signal.reason || new Error('aborted'));
                    }, { once: true });
                });
            },
        });
        const result = await tool.execute({ task: 'worker timeout', timeout: 0.02 }, {
            sessionId: 'parent-session',
            turnId: 'spawn-turn',
        });
        assert.equal((result.data as { status: string }).status, 'timeout');
        assert.equal(observedAbort, true);
        assert.equal(f.children.get(spawnedId)?.status, 'timeout');
        assert.equal(f.children.get(spawnedId)?.parentTurnId, 'spawn-turn');
    } finally {
        f.cleanup();
    }
});
