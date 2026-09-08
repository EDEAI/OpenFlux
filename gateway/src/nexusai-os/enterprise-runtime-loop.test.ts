import assert from 'node:assert/strict';
import test from 'node:test';

import {
    isConnectivityError,
    needsReregistration,
    runRuntimeLoop,
    type RuntimeLoopSummary,
    type RuntimeLoopWorker,
} from './enterprise-runtime-loop';

type Step = () => Promise<Record<string, any>>;

interface Harness {
    worker: RuntimeLoopWorker;
    initializeCalls: number;
    runOnceCalls: number;
    sleeps: number[];
    logs: string[];
    errors: string[];
    controller: AbortController;
    run(options?: { once?: boolean; abortAfterSleeps?: number }): Promise<RuntimeLoopSummary>;
}

const connectivity = () => Promise.reject(new TypeError('fetch failed'));
const idle = () => Promise.resolve({ status: 'idle' });
const completed = () => Promise.resolve({ status: 'completed', task_id: 'TASK-1' });

function harness(initialize: Array<() => Promise<void>>, runOnce: Step[]): Harness {
    const controller = new AbortController();
    const state: Harness = {
        initializeCalls: 0,
        runOnceCalls: 0,
        sleeps: [],
        logs: [],
        errors: [],
        controller,
        worker: {
            async initialize() {
                state.initializeCalls += 1;
                const step = initialize.shift();
                if (step) await step();
            },
            async runOnce() {
                state.runOnceCalls += 1;
                const step = runOnce.shift();
                if (!step) {
                    // 脚本耗尽：停止循环，避免测试挂住
                    controller.abort();
                    return { status: 'idle' };
                }
                return step();
            },
        },
        run: (options = {}) =>
            runRuntimeLoop(
                state.worker,
                {
                    pollMs: 500,
                    reconnectInitialMs: 1_000,
                    reconnectMaxMs: 4_000,
                    once: options.once,
                    log: line => state.logs.push(line),
                    logError: line => state.errors.push(line),
                    sleep: async ms => {
                        state.sleeps.push(ms);
                        if (options.abortAfterSleeps && state.sleeps.length >= options.abortAfterSleeps) {
                            controller.abort();
                        }
                    },
                },
                controller.signal,
            ),
    };
    return state;
}

test('retries registration with exponential backoff until OS becomes available', async () => {
    const h = harness([connectivity, connectivity, connectivity], [idle, idle]);
    const summary = await h.run({ abortAfterSleeps: 5 });

    assert.equal(h.initializeCalls, 4);
    assert.deepEqual(h.sleeps.slice(0, 3), [1_000, 2_000, 4_000]);
    assert.equal(h.sleeps[3], 500, 'idle polling uses pollMs after a successful registration');
    assert.equal(summary.reconnects, 1);
    assert.equal(summary.stoppedBy, 'signal');
    assert.ok(h.errors[0].includes('1.0 秒后重新登记'));
});

test('re-registers when OS reports the runtime as unknown', async () => {
    const h = harness(
        [],
        [idle, () => Promise.reject(new Error('HTTP 404: Runtime 不存在')), completed],
    );
    const summary = await h.run({ abortAfterSleeps: 3 });

    assert.equal(h.initializeCalls, 2);
    assert.equal(summary.reconnects, 1);
    assert.equal(summary.completed, 1);
    assert.equal(summary.taskFailures, 0);
});

test('a task failure does not trigger re-registration and keeps polling', async () => {
    const h = harness(
        [],
        [
            () => Promise.reject(new Error('Enterprise Runtime 超过最大模型迭代次数')),
            completed,
        ],
    );
    const summary = await h.run({ abortAfterSleeps: 2 });

    assert.equal(h.initializeCalls, 1);
    assert.equal(summary.taskFailures, 1);
    assert.equal(summary.completed, 1);
    assert.equal(h.sleeps[0], 500, 'task failure waits one poll interval, not a reconnect backoff');
    assert.equal(summary.reconnects, 0);
});

test('backoff resets after a successful iteration', async () => {
    const h = harness(
        [],
        [connectivity, connectivity, idle, connectivity, idle],
    );
    await h.run({ abortAfterSleeps: 5 });

    // 两次中断：1000 → 2000；成功一轮后回到 1000
    assert.deepEqual(h.sleeps.slice(0, 4), [1_000, 2_000, 500, 1_000]);
});

test('once mode processes a single round and reports the outcome', async () => {
    const h = harness([], [completed]);
    const summary = await h.run({ once: true });

    assert.equal(summary.stoppedBy, 'once');
    assert.equal(summary.completed, 1);
    assert.equal(h.sleeps.length, 0);
    assert.ok(h.logs.some(line => line.includes('"task_id":"TASK-1"')));
});

test('once mode fails fast when registration is impossible', async () => {
    const h = harness([connectivity], []);
    const summary = await h.run({ once: true });

    assert.equal(summary.stoppedBy, 'fatal');
    assert.equal(h.runOnceCalls, 0);
    assert.match(summary.lastError || '', /fetch failed/);
});

test('stop signal waits for the in-flight task and then exits', async () => {
    let finishTask: (() => void) | undefined;
    const inflight = () =>
        new Promise<Record<string, any>>(resolve => {
            finishTask = () => resolve({ status: 'completed', task_id: 'TASK-LONG' });
        });
    const h = harness([], [inflight, completed, completed]);

    const running = h.run();
    // 等 runOnce 真正进入执行
    while (!finishTask) await new Promise(resolve => setImmediate(resolve));
    h.controller.abort();
    finishTask!();
    const summary = await running;

    assert.equal(summary.stoppedBy, 'signal');
    assert.equal(summary.completed, 1);
    assert.equal(h.runOnceCalls, 1, 'no new task is leased after the stop signal');
    assert.ok(h.logs.at(-1)?.includes('停止信号'));
});

test('classifies connectivity failures separately from task failures', () => {
    const cases: Array<[unknown, boolean, boolean]> = [
        [new TypeError('fetch failed'), true, true],
        [Object.assign(new Error('request failed'), { cause: { code: 'ECONNREFUSED' } }), true, true],
        [new Error('HTTP 503: Service Unavailable'), true, true],
        [new Error('HTTP 404: Runtime 不存在'), false, true],
        [new Error('HTTP 401: Runtime 登记令牌无效'), false, false],
        [new Error('Enterprise Runtime 超过最大模型迭代次数'), false, false],
        [new Error('动作要求代码变更集，但隔离工作区没有产生文件差异'), false, false],
    ];
    for (const [error, connectivityExpected, reregisterExpected] of cases) {
        assert.equal(isConnectivityError(error), connectivityExpected, String(error));
        assert.equal(needsReregistration(error), reregisterExpected, String(error));
    }
});
