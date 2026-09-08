/**
 * Enterprise Runtime 常驻循环。
 *
 * Worker 只负责"登记一次 / 处理一个任务"；这里负责让它在企业主机上持续运行：
 * OS 未就绪时指数退避重试登记，连接中断或 Runtime 被 OS 清理后自动重新登记，
 * 单个任务失败不影响后续拉取，收到停止信号后等当前任务结束再退出。
 * 进程级的开机自启和崩溃拉起由 scripts/enterprise-runtime 下的计划任务或 systemd 负责。
 */

export interface RuntimeLoopWorker {
    initialize(): Promise<void>;
    runOnce(): Promise<Record<string, any>>;
}

export interface RuntimeLoopOptions {
    /** 空闲时两次拉取之间的间隔 */
    pollMs: number;
    /** 只处理一轮就退出（沿用 NEXUSAI_ENTERPRISE_RUN_ONCE 语义） */
    once?: boolean;
    reconnectInitialMs?: number;
    reconnectMaxMs?: number;
    log?: (message: string) => void;
    logError?: (message: string) => void;
    /** 可注入的等待实现，测试时用它记录退避序列 */
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface RuntimeLoopSummary {
    iterations: number;
    completed: number;
    idle: number;
    taskFailures: number;
    reconnects: number;
    stoppedBy: 'signal' | 'once' | 'fatal';
    lastError?: string;
}

const CONNECTIVITY_MESSAGE =
    /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|socket hang up|UND_ERR|^HTTP 50[234]\b/i;
const CONNECTIVITY_CODE = /^(ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|UND_ERR)/;

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function describeError(error: unknown): string {
    return error instanceof Error ? error.stack || error.message : String(error);
}

/** OS 不可达、网关层 502/503/504、DNS 或超时——都不是任务本身的问题。 */
export function isConnectivityError(error: unknown): boolean {
    if (CONNECTIVITY_MESSAGE.test(messageOf(error))) return true;
    const cause = error instanceof Error ? (error as Error & { cause?: any }).cause : undefined;
    const code = cause?.code ?? (error as any)?.code;
    return typeof code === 'string' && CONNECTIVITY_CODE.test(code);
}

/**
 * 连接中断后 OS 可能已重启并丢失登记；OS 明确返回 404 说明 Runtime 记录不存在。
 * 两种情况都要走重新登记，而不是一直对着一个不存在的 Runtime 发心跳。
 */
export function needsReregistration(error: unknown): boolean {
    return isConnectivityError(error) || /^HTTP 404\b/.test(messageOf(error));
}

export async function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted || ms <= 0) return;
    await new Promise<void>(resolve => {
        const onAbort = () => {
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

export async function runRuntimeLoop(
    worker: RuntimeLoopWorker,
    options: RuntimeLoopOptions,
    signal: AbortSignal,
): Promise<RuntimeLoopSummary> {
    const log = options.log || (message => process.stdout.write(`${message}\n`));
    const logError = options.logError || (message => process.stderr.write(`${message}\n`));
    const sleep = options.sleep || abortableSleep;
    const pollMs = Math.max(100, options.pollMs);
    const initialBackoff = Math.max(100, options.reconnectInitialMs ?? 1_000);
    const maxBackoff = Math.max(initialBackoff, options.reconnectMaxMs ?? 30_000);

    const summary: RuntimeLoopSummary = {
        iterations: 0,
        completed: 0,
        idle: 0,
        taskFailures: 0,
        reconnects: 0,
        stoppedBy: 'signal',
    };
    let registered = false;
    let disconnected = false;
    let idling = false;
    let backoff = initialBackoff;

    const seconds = (ms: number) => (ms / 1000).toFixed(1);
    const backoffAndGrow = async () => {
        await sleep(backoff, signal);
        backoff = Math.min(maxBackoff, backoff * 2);
    };

    while (!signal.aborted) {
        if (!registered) {
            try {
                await worker.initialize();
                registered = true;
                // 退避只在 runOnce 成功后归零：登记成功不代表心跳/拉取已经恢复，
                // 否则"登记通、心跳挂"时会以初始间隔持续抖动。
                if (disconnected) {
                    summary.reconnects += 1;
                    disconnected = false;
                }
                log('Enterprise Runtime 已登记到 NexusAI OS，开始拉取任务');
            } catch (error) {
                summary.lastError = describeError(error);
                disconnected = true;
                if (options.once) {
                    summary.stoppedBy = 'fatal';
                    logError(`无法登记到 NexusAI OS：${describeError(error)}`);
                    return summary;
                }
                logError(
                    `NexusAI OS 暂时不可用，${seconds(backoff)} 秒后重新登记：${messageOf(error)}`,
                );
                await backoffAndGrow();
                continue;
            }
        }

        summary.iterations += 1;
        try {
            const result = await worker.runOnce();
            backoff = initialBackoff;
            const idle = result?.status === 'idle';
            if (idle) {
                summary.idle += 1;
                if (!idling) log('没有待执行任务，Runtime 进入空闲轮询');
                idling = true;
            } else {
                summary.completed += 1;
                idling = false;
                log(JSON.stringify(result));
            }
            if (options.once) {
                if (idle) log(JSON.stringify(result));
                summary.stoppedBy = 'once';
                return summary;
            }
            if (idle) await sleep(pollMs, signal);
        } catch (error) {
            summary.lastError = describeError(error);
            idling = false;
            if (needsReregistration(error)) {
                registered = false;
                disconnected = true;
                if (options.once) {
                    summary.stoppedBy = 'fatal';
                    logError(`与 NexusAI OS 的连接中断：${describeError(error)}`);
                    return summary;
                }
                logError(
                    `与 NexusAI OS 的连接中断，${seconds(backoff)} 秒后重新登记：${messageOf(error)}`,
                );
                await backoffAndGrow();
                continue;
            }
            // 任务本身失败：Worker 已经向 OS 回报 fail，这里只记录并继续拉取下一个。
            summary.taskFailures += 1;
            logError(describeError(error));
            if (options.once) {
                summary.stoppedBy = 'fatal';
                return summary;
            }
            await sleep(pollMs, signal);
        }
    }

    summary.stoppedBy = 'signal';
    log('Enterprise Runtime 已收到停止信号，当前任务已结束，进程退出');
    return summary;
}
