import { setTimeout as delay } from 'node:timers/promises';

import { configFromEnv, OpenFluxEnterpriseRuntimeWorker } from './enterprise-runtime';

async function main(): Promise<void> {
    const worker = new OpenFluxEnterpriseRuntimeWorker(configFromEnv());
    await worker.initialize();
    const once = ['1', 'true', 'yes'].includes(String(process.env.NEXUSAI_ENTERPRISE_RUN_ONCE || '').toLowerCase());
    const pollMs = Math.max(500, Number(process.env.NEXUSAI_ENTERPRISE_POLL_MS || 2000));
    do {
        try {
            const result = await worker.runOnce();
            process.stdout.write(`${JSON.stringify(result)}\n`);
        } catch (error) {
            const message = error instanceof Error ? error.stack || error.message : String(error);
            process.stderr.write(`${message}\n`);
        }
        if (!once) await delay(pollMs);
    } while (!once);
}

main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
});
