import { configFromEnv, OpenFluxEnterpriseRuntimeWorker } from './enterprise-runtime';
import { describeError, runRuntimeLoop } from './enterprise-runtime-loop';

const truthy = (value: string | undefined) =>
    ['1', 'true', 'yes'].includes(String(value || '').toLowerCase());

const numberEnv = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

async function main(): Promise<number> {
    const worker = new OpenFluxEnterpriseRuntimeWorker(configFromEnv());
    const controller = new AbortController();

    // 第一次信号：停止拉取新任务，等当前任务结束；第二次：立即退出。
    let stopRequests = 0;
    const requestStop = (signal: string) => {
        stopRequests += 1;
        if (stopRequests > 1) {
            process.stderr.write(`再次收到 ${signal}，立即退出\n`);
            process.exit(130);
        }
        process.stderr.write(`收到 ${signal}，等待当前任务结束后退出（再次发送将立即退出）\n`);
        controller.abort();
    };
    for (const name of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
        process.on(name, () => requestStop(name));
    }

    const summary = await runRuntimeLoop(
        worker,
        {
            pollMs: numberEnv(process.env.NEXUSAI_ENTERPRISE_POLL_MS, 2_000),
            once: truthy(process.env.NEXUSAI_ENTERPRISE_RUN_ONCE),
            reconnectInitialMs: numberEnv(process.env.NEXUSAI_ENTERPRISE_RECONNECT_INITIAL_MS, 1_000),
            reconnectMaxMs: numberEnv(process.env.NEXUSAI_ENTERPRISE_RECONNECT_MAX_MS, 30_000),
        },
        controller.signal,
    );
    process.stderr.write(`Enterprise Runtime 结束：${JSON.stringify(summary)}\n`);
    return summary.stoppedBy === 'fatal' ? 1 : 0;
}

main()
    .then(code => {
        process.exitCode = code;
    })
    .catch(error => {
        process.stderr.write(`${describeError(error)}\n`);
        process.exitCode = 1;
    });
