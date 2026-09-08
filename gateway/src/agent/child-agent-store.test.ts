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

test('presentation dispatch is persistent, reports failed runs, and reuses one owned child session', async () => {
    const f = fixture();
    try {
        const manager = new CollaborationManager({ childStore: f.children });
        manager.setAgentProvider(() => [
            { id: 'presentation', name: 'Presentation', type: 'builtin' },
            { id: 'coder', name: 'Coder', type: 'builtin' },
        ]);
        const observedSessionIds: string[] = [];
        let executions = 0;
        manager.setExecutor(async (agentId, _task, sessionId) => {
            executions++;
            observedSessionIds.push(sessionId || '');
            if (executions === 1) {
                return {
                    output: 'quality gate still has text_overflow',
                    agentId,
                    status: 'failed',
                };
            }
            return { output: 'durable deck completed', agentId, status: 'completed' };
        });
        const tool = createSessionsSpawnTool({ collaborationManager: manager });

        const first = await runWithAgentExecutionContext({
            sessionId: 'parent-session',
            turnId: 'presentation-turn',
        }, () => tool.execute({
            agentId: 'presentation',
            task: '生成一份立项汇报 PPTX',
            mode: 'run',
            waitForResult: true,
        }));
        assert.equal(first.success, false);
        assert.equal(first.code, 'presentation_agent_requires_attention');
        const firstData = first.data as { sessionId: string; mode: string; output: string };
        assert.equal(firstData.mode, 'session');
        assert.match(firstData.output, /text_overflow/);
        assert.equal(f.children.get(firstData.sessionId)?.mode, 'session');
        assert.equal(f.children.get(firstData.sessionId)?.status, 'idle');

        const second = await runWithAgentExecutionContext({
            sessionId: 'parent-session',
            turnId: 'presentation-turn',
        }, () => tool.execute({
            agentId: 'presentation',
            task: '复用原 designId，继续修复并完成 PPTX',
            waitForResult: true,
        }));
        assert.equal(second.success, true);
        const secondData = second.data as { sessionId: string; reused: boolean; output: string };
        assert.equal(secondData.sessionId, firstData.sessionId);
        assert.equal(secondData.reused, true);
        assert.equal(secondData.output, 'durable deck completed');
        assert.equal(executions, 2);
        assert.deepEqual(observedSessionIds, [firstData.sessionId, firstData.sessionId]);
        assert.deepEqual(
            f.sessions.getMessages(firstData.sessionId).map(message => message.content),
            [
                '生成一份立项汇报 PPTX',
                'quality gate still has text_overflow',
                '复用原 designId，继续修复并完成 PPTX',
                'durable deck completed',
            ],
        );
    } finally {
        f.cleanup();
    }
});

test('legacy one-shot presentation child is upgraded and resumed instead of replaced', async () => {
    const f = fixture();
    try {
        f.children.create({
            id: 'collab-legacy-presentation',
            source: 'collaboration',
            parentSessionId: 'parent-session',
            parentTurnId: 'presentation-turn',
            agentId: 'presentation',
            task: 'initial deck attempt',
            mode: 'run',
        });
        f.children.appendConversationTurn(
            'collab-legacy-presentation',
            'initial deck attempt',
            'failed checkpoint designId=deck-123',
        );
        f.children.update('collab-legacy-presentation', {
            status: 'completed',
            endTime: Date.now(),
            output: 'failed checkpoint designId=deck-123',
        });

        const manager = new CollaborationManager({ childStore: f.children });
        manager.setAgentProvider(() => [
            { id: 'presentation', name: 'Presentation', type: 'builtin' },
        ]);
        let observedSessionId = '';
        manager.setExecutor(async (agentId, _task, sessionId) => {
            observedSessionId = sessionId || '';
            return { output: 'resumed deck', agentId, status: 'completed' };
        });

        const result = await runWithAgentExecutionContext({
            sessionId: 'parent-session',
            turnId: 'presentation-turn',
        }, () => manager.spawn({
            agentId: 'presentation',
            task: 'continue deck-123',
            waitForResult: true,
        }));
        assert.equal(result.status, 'completed');
        assert.equal(result.reused, true);
        assert.equal(result.sessionId, 'collab-legacy-presentation');
        assert.equal(observedSessionId, 'collab-legacy-presentation');
        assert.equal(f.children.get('collab-legacy-presentation')?.mode, 'session');
        assert.equal(f.children.list('collaboration').length, 1);
    } finally {
        f.cleanup();
    }
});

test('sessions_spawn blocks coder from replacing standalone PPTX delivery', async () => {
    const f = fixture();
    try {
        const manager = new CollaborationManager({ childStore: f.children });
        manager.setAgentProvider(() => [
            { id: 'presentation', name: 'Presentation', type: 'builtin' },
            { id: 'coder', name: 'Coder', type: 'builtin' },
        ]);
        let executions = 0;
        manager.setExecutor(async (agentId) => {
            executions++;
            return { output: 'unexpected', agentId, status: 'completed' };
        });
        const tool = createSessionsSpawnTool({ collaborationManager: manager });

        const result = await tool.execute({
            agentId: 'coder',
            task: '用 python-pptx 生成18页立项汇报 PPTX',
            waitForResult: true,
        });
        assert.equal(result.success, false);
        assert.equal(result.code, 'presentation_agent_required');
        assert.equal((result.data as { requiredAgentId: string }).requiredAgentId, 'presentation');
        assert.equal(executions, 0);
        assert.equal(f.children.list('collaboration').length, 0);

        const implementation = await tool.execute({
            agentId: 'coder',
            task: '修复 PPT 生成工作流的状态机实现',
            waitForResult: true,
        });
        assert.equal(implementation.success, true);
        assert.equal(executions, 1);
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
        let observedApprovalMode: string | undefined;
        manager.setExecutor(async () => {
            observedApprovalMode = getAgentExecutionContext()?.approvalMode;
            return { output: 'done', agentId: 'worker' };
        });
        const tool = createSessionsSpawnTool({ collaborationManager: manager });
        const result = await runWithAgentExecutionContext({
            sessionId: 'parent-session',
            turnId: 'tool-turn',
            approvalMode: 'full_access',
        }, () => tool.execute({
            agentId: 'worker',
            task: 'context task',
            waitForResult: true,
        }));
        assert.equal(result.success, true);
        const sessionId = (result.data as { sessionId: string }).sessionId;
        assert.equal(f.children.get(sessionId)?.parentSessionId, 'parent-session');
        assert.equal(f.children.get(sessionId)?.parentTurnId, 'tool-turn');
        assert.equal(f.sessions.get(sessionId)?.approvalMode, 'full_access');
        assert.equal(observedApprovalMode, 'full_access');
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
            approvalMode: 'full_access',
        });
        assert.equal((result.data as { status: string }).status, 'timeout');
        assert.equal(observedAbort, true);
        assert.equal(f.children.get(spawnedId)?.status, 'timeout');
        assert.equal(f.children.get(spawnedId)?.parentTurnId, 'spawn-turn');
        assert.equal(f.sessions.get(spawnedId)?.approvalMode, 'full_access');
    } finally {
        f.cleanup();
    }
});
