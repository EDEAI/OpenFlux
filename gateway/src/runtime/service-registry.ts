/**
 * Managed services: long-running processes an agent starts for a project
 * (dev servers, API servers, watchers).
 *
 * Why this exists: an agent that starts `npm run dev` through a one-shot
 * shell gets a child that dies with the shell, then later "restarts" a server
 * that is already gone and never learns the difference. Every server an agent
 * starts is registered here with its owner (session/agent/project), pid,
 * port, and a log file, persisted across gateway restarts, so the agent —
 * and the desktop — can list, inspect, stop and restart what is running
 * instead of guessing.
 */

import { spawn } from 'child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, statSync } from 'fs';
import { join, basename } from 'path';
import { createConnection } from 'net';
import { randomUUID } from 'crypto';
import { Logger } from '../utils/logger';

const log = new Logger('ServiceRegistry');

export type ManagedServiceStatus = 'running' | 'exited' | 'killed' | 'unknown';

export interface ManagedService {
    /** Stable id, e.g. `svc-3f9a1c`. */
    id: string;
    /** Short human name: given by the agent, else derived from the command. */
    name: string;
    command: string;
    args: string[];
    cwd: string;
    pid: number;
    /** Declared by the agent, or detected from the first seconds of output. */
    port?: number;
    /** `http://localhost:<port>` once a port is known. */
    url?: string;
    /** Owner: the conversation and agent that started it, and the project root. */
    sessionId?: string;
    agentId?: string;
    workspaceRoot?: string;
    status: ManagedServiceStatus;
    startedAt: number;
    exitedAt?: number;
    exitCode?: number | null;
    /** Combined stdout+stderr of the process. */
    logPath: string;
    restartCount: number;
    /**
     * Survive gateway shutdown and restarts. Default false: a service dies
     * with the app that started it, and one found still running when the
     * gateway comes back is reaped as an orphan.
     */
    keepAlive?: boolean;
}

export interface StartServiceInput {
    command: string;
    args?: string[];
    cwd: string;
    name?: string;
    port?: number;
    env?: NodeJS.ProcessEnv;
    sessionId?: string;
    agentId?: string;
    workspaceRoot?: string;
    keepAlive?: boolean;
}

export interface ServiceFilter {
    sessionId?: string;
    agentId?: string;
    workspaceRoot?: string;
    /** Only services whose process is alive (default false: include exited). */
    runningOnly?: boolean;
}

interface PersistedState {
    version: 1;
    services: ManagedService[];
}

/** `user-agent:project-834df02c` → `project-834df02c`; `agent_x_main` → `x`. */
export function agentIdFromSessionId(sessionId?: string): string | undefined {
    if (!sessionId) return undefined;
    const m = /^user-agent:(.+)$/.exec(sessionId) || /^agent_([^_]+)_/.exec(sessionId);
    return m?.[1];
}

function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function probeHost(host: string, port: number, timeoutMs: number): Promise<boolean> {
    return new Promise(resolve => {
        const socket = createConnection({ host, port });
        const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
        socket.setTimeout(timeoutMs, () => done(false));
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
    });
}

/**
 * A server bound to "localhost" may listen on ::1 only (vite without --host
 * does on machines where localhost resolves to IPv6 first); probe both
 * loopbacks so such a service is not reported as down.
 */
async function probePort(port: number, timeoutMs = 800): Promise<boolean> {
    if (await probeHost('127.0.0.1', port, timeoutMs)) return true;
    return probeHost('::1', port, timeoutMs);
}

/** Servers print their address in a handful of shapes; pick the first port seen. */
function detectPort(text: string): number | undefined {
    const patterns = [
        /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])?:(\d{2,5})/i,
        /\bport\s*[:=]?\s*(\d{2,5})\b/i,
        /listening on[^\d]*(\d{2,5})/i,
    ];
    for (const re of patterns) {
        const m = re.exec(text);
        if (m) {
            const port = Number(m[1]);
            if (port > 0 && port < 65536) return port;
        }
    }
    return undefined;
}

function deriveName(command: string, args: string[], cwd: string): string {
    const joined = [basename(command), ...args].join(' ');
    if (/\b(vite|next|nuxt|webpack|dev)\b/i.test(joined)) return `${basename(cwd)}-dev`;
    if (/\b(serve|server|artisan|uvicorn|gunicorn|flask|http\.server)\b/i.test(joined)) return `${basename(cwd)}-server`;
    return basename(cwd) || basename(command);
}

export class ServiceRegistry {
    private readonly services = new Map<string, ManagedService>();
    private readonly storePath: string;
    private readonly logDir: string;

    constructor(storeDir: string) {
        this.storePath = join(storeDir, 'services.json');
        this.logDir = join(storeDir, 'logs');
        if (!existsSync(this.logDir)) mkdirSync(this.logDir, { recursive: true });
        this.load();
    }

    // ---- persistence -------------------------------------------------

    private load(): void {
        if (!existsSync(this.storePath)) return;
        try {
            const parsed = JSON.parse(readFileSync(this.storePath, 'utf-8')) as PersistedState;
            for (const svc of parsed.services || []) {
                // A record that survived a gateway restart: the process may be
                // gone. Re-check rather than trust the stored status.
                if (svc.status === 'running' && !processAlive(svc.pid)) {
                    svc.status = 'unknown';
                    svc.exitedAt = svc.exitedAt ?? Date.now();
                }
                this.services.set(svc.id, svc);
            }
        } catch (error) {
            log.warn('Could not read services.json; starting empty', { error: String(error) });
        }
    }

    private save(): void {
        try {
            const state: PersistedState = { version: 1, services: [...this.services.values()] };
            writeFileSync(this.storePath, JSON.stringify(state, null, 2), 'utf-8');
        } catch (error) {
            log.warn('Could not persist services.json', { error: String(error) });
        }
    }

    // ---- lifecycle ---------------------------------------------------

    async start(input: StartServiceInput): Promise<ManagedService> {
        const args = input.args ?? [];
        const id = `svc-${randomUUID().slice(0, 6)}`;
        const logPath = join(this.logDir, `${id}.log`);
        const fd = openSync(logPath, 'a');
        const header = `# ${new Date().toISOString()} ${input.command} ${args.join(' ')}\n# cwd: ${input.cwd}\n`;
        writeFileSync(fd, header);

        // A bare `npm` / `vite` on Windows is a .cmd shim that only a shell can
        // run; a path to a real executable must not go through the shell, which
        // would split "C:\Program Files\...". With a shell, quote for it.
        const useShell = process.platform === 'win32' && !/[\\/]/.test(input.command) && !/\.exe$/i.test(input.command);
        const quote = (value: string) => (/[\s"&|<>^]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value);
        // Not `detached`: on Windows a detached child gets no console and its
        // own children (npm → vite) then write nowhere, leaving the log empty.
        // Lifetime does not depend on it — the Job Object and stopAll() own
        // that — and unref() below still lets the gateway exit.
        const child = spawn(useShell ? quote(input.command) : input.command, useShell ? args.map(quote) : args, {
            cwd: input.cwd,
            detached: false,
            stdio: ['ignore', fd, fd],
            windowsHide: true,
            env: input.env ?? process.env,
            shell: useShell,
        });

        const service: ManagedService = {
            id,
            name: input.name?.trim() || deriveName(input.command, args, input.cwd),
            command: input.command,
            args,
            cwd: input.cwd,
            pid: child.pid ?? -1,
            port: input.port,
            url: input.port ? `http://localhost:${input.port}` : undefined,
            sessionId: input.sessionId,
            agentId: input.agentId ?? agentIdFromSessionId(input.sessionId),
            workspaceRoot: input.workspaceRoot,
            status: 'running',
            startedAt: Date.now(),
            logPath,
            restartCount: 0,
            keepAlive: input.keepAlive === true,
        };

        const startup = await new Promise<Error | null>(resolve => {
            let settled = false;
            child.once('error', err => { if (!settled) { settled = true; resolve(err); } });
            child.once('exit', code => {
                // Died within the grace window: report it as a failed start.
                if (!settled) { settled = true; resolve(new Error(`exited immediately with code ${code}`)); }
            });
            setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, 600);
        });
        closeSync(fd);
        if (startup) {
            service.status = 'exited';
            service.exitedAt = Date.now();
            this.services.set(id, service);
            this.save();
            throw new Error(`${startup.message}\nLog: ${logPath}\n${this.tailLog(service, 30)}`);
        }

        child.on('exit', (code) => {
            const current = this.services.get(id);
            if (current && current.status === 'running') {
                current.status = 'exited';
                current.exitCode = code;
                current.exitedAt = Date.now();
                this.save();
            }
        });
        child.unref();

        this.services.set(id, service);
        this.save();
        log.info('Service started', { id, name: service.name, pid: service.pid, cwd: service.cwd });

        // Let the server announce its port, then remember it.
        if (!service.port) {
            await new Promise(r => setTimeout(r, 2500));
            const port = detectPort(this.tailLog(service, 60));
            if (port) {
                service.port = port;
                service.url = `http://localhost:${port}`;
                this.save();
            }
        }
        return service;
    }

    async stop(ref: string | number): Promise<ManagedService> {
        const service = this.resolve(ref);
        if (!service) throw new Error(`No managed service matches "${ref}"`);
        if (processAlive(service.pid)) {
            if (process.platform === 'win32') {
                await new Promise<void>(resolve => {
                    const killer = spawn('taskkill', ['/PID', String(service.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
                    killer.once('exit', () => resolve());
                    killer.once('error', () => resolve());
                });
            } else {
                try { process.kill(service.pid, 'SIGTERM'); } catch { /* gone */ }
            }
        }
        service.status = 'killed';
        service.exitedAt = Date.now();
        this.save();
        log.info('Service stopped', { id: service.id, name: service.name, pid: service.pid });
        return service;
    }

    async restart(ref: string | number): Promise<ManagedService> {
        const old = this.resolve(ref);
        if (!old) throw new Error(`No managed service matches "${ref}"`);
        await this.stop(old.id).catch(() => undefined);
        const fresh = await this.start({
            command: old.command,
            args: old.args,
            cwd: old.cwd,
            name: old.name,
            port: old.port,
            sessionId: old.sessionId,
            agentId: old.agentId,
            workspaceRoot: old.workspaceRoot,
            keepAlive: old.keepAlive,
        });
        fresh.restartCount = old.restartCount + 1;
        // The restarted service replaces its predecessor's record.
        this.services.delete(old.id);
        this.save();
        return fresh;
    }

    /**
     * Stop every running service that is not marked keepAlive. Used on
     * gateway shutdown so servers never outlive the app deliberately.
     */
    async stopAll(reason: string): Promise<ManagedService[]> {
        const stopped: ManagedService[] = [];
        for (const svc of this.list({ runningOnly: true })) {
            if (svc.keepAlive) continue;
            try {
                stopped.push(await this.stop(svc.id));
            } catch (error) {
                log.warn('Could not stop service on shutdown', { id: svc.id, name: svc.name, error: String(error) });
            }
        }
        if (stopped.length) log.info('Stopped managed services', { reason, count: stopped.length, names: stopped.map(s => s.name) });
        return stopped;
    }

    /**
     * Services still alive from a previous gateway run (the app crashed or was
     * force-killed) are orphans: nothing controls them and they hold ports.
     * Kill them unless keepAlive was requested. Call once right after load.
     */
    async reapOrphans(): Promise<ManagedService[]> {
        const orphans = [...this.services.values()].filter(svc => svc.status === 'running' && processAlive(svc.pid) && !svc.keepAlive);
        const reaped: ManagedService[] = [];
        for (const svc of orphans) {
            try {
                reaped.push(await this.stop(svc.id));
            } catch (error) {
                log.warn('Could not reap orphan service', { id: svc.id, name: svc.name, error: String(error) });
            }
        }
        if (reaped.length) log.info('Reaped orphan services from a previous run', { count: reaped.length, names: reaped.map(s => s.name) });
        return reaped;
    }

    /**
     * Block until a service is ready — its port accepts connections, its log
     * matches a pattern, or it exits — with a hard timeout. Returns what was
     * observed either way so the caller can report honestly.
     */
    async waitFor(
        ref: string | number,
        options: { until?: 'port' | 'log' | 'exit'; pattern?: RegExp; timeoutMs?: number; intervalMs?: number } = {},
    ): Promise<{ service: ManagedService; satisfied: boolean; condition: 'port' | 'log' | 'exit'; elapsedMs: number; matchedLine?: string; alive: boolean; portOpen?: boolean; reason?: string }> {
        const service = this.resolve(ref);
        if (!service) throw new Error(`No managed service matches "${ref}"`);
        const condition: 'port' | 'log' | 'exit' = options.until ?? (options.pattern ? 'log' : 'port');
        const timeoutMs = Math.max(1000, options.timeoutMs ?? 60_000);
        const intervalMs = Math.max(200, options.intervalMs ?? 500);
        const started = Date.now();
        let portOpen: boolean | undefined;
        while (Date.now() - started < timeoutMs) {
            const alive = processAlive(service.pid);
            if (condition === 'exit') {
                if (!alive) {
                    this.refreshStatuses();
                    return { service, satisfied: true, condition, elapsedMs: Date.now() - started, alive };
                }
            } else if (!alive) {
                this.refreshStatuses();
                return { service, satisfied: false, condition, elapsedMs: Date.now() - started, alive, reason: 'process exited before the condition was met', matchedLine: this.tailLog(service, 5) };
            }
            if (condition === 'log' && options.pattern) {
                const line = this.tailLog(service, 200).split(/\r?\n/).find(l => options.pattern!.test(l));
                if (line) return { service, satisfied: true, condition, elapsedMs: Date.now() - started, matchedLine: line, alive };
            }
            if (condition === 'port') {
                if (!service.port) {
                    const detected = detectPort(this.tailLog(service, 60));
                    if (detected) { service.port = detected; service.url = `http://localhost:${detected}`; this.save(); }
                }
                if (service.port) {
                    portOpen = await probePort(service.port);
                    if (portOpen) return { service, satisfied: true, condition, elapsedMs: Date.now() - started, alive, portOpen };
                }
            }
            await new Promise(resolve => setTimeout(resolve, intervalMs));
        }
        return {
            service,
            satisfied: false,
            condition,
            elapsedMs: Date.now() - started,
            alive: processAlive(service.pid),
            portOpen,
            reason: condition === 'port' && !service.port ? 'no port declared or detected yet' : `timed out after ${Math.round(timeoutMs / 1000)}s`,
            matchedLine: this.tailLog(service, 5),
        };
    }

    // ---- queries -----------------------------------------------------

    /** Find by id, name, pid, or port. */
    resolve(ref: string | number): ManagedService | undefined {
        const all = [...this.services.values()];
        if (typeof ref === 'number') {
            return all.find(s => s.pid === ref) ?? all.find(s => s.port === ref && s.status === 'running');
        }
        const key = ref.trim();
        if (/^\d+$/.test(key)) return this.resolve(Number(key));
        return all.find(s => s.id === key)
            ?? all.filter(s => s.name === key).sort((a, b) => b.startedAt - a.startedAt)[0];
    }

    list(filter: ServiceFilter = {}): ManagedService[] {
        this.refreshStatuses();
        return [...this.services.values()]
            .filter(s => !filter.sessionId || s.sessionId === filter.sessionId)
            .filter(s => !filter.agentId || s.agentId === filter.agentId)
            .filter(s => !filter.workspaceRoot || s.workspaceRoot === filter.workspaceRoot)
            .filter(s => !filter.runningOnly || s.status === 'running')
            .sort((a, b) => b.startedAt - a.startedAt);
    }

    /** Re-check liveness of every "running" record (cheap signal-0 probe). */
    refreshStatuses(): void {
        let changed = false;
        for (const s of this.services.values()) {
            if (s.status === 'running' && !processAlive(s.pid)) {
                s.status = 'exited';
                s.exitedAt = Date.now();
                changed = true;
            }
        }
        if (changed) this.save();
    }

    /** Liveness plus a real TCP probe of the port, for "is it actually serving?". */
    async status(ref: string | number): Promise<{ service: ManagedService; alive: boolean; portOpen?: boolean }> {
        const service = this.resolve(ref);
        if (!service) throw new Error(`No managed service matches "${ref}"`);
        const alive = processAlive(service.pid);
        if (!alive && service.status === 'running') {
            service.status = 'exited';
            service.exitedAt = Date.now();
            this.save();
        }
        const portOpen = service.port ? await probePort(service.port) : undefined;
        return { service, alive, portOpen };
    }

    tailLog(ref: string | number | ManagedService, lines = 60): string {
        const service = typeof ref === 'object' ? ref : this.resolve(ref);
        if (!service) throw new Error(`No managed service matches "${String(ref)}"`);
        try {
            if (!existsSync(service.logPath)) return '';
            const size = statSync(service.logPath).size;
            // Tail without reading a runaway log whole.
            const text = readFileSync(service.logPath, 'utf-8').slice(Math.max(0, size - 64 * 1024));
            return text.split(/\r?\n/).slice(-lines).join('\n');
        } catch {
            return '';
        }
    }

    /** Drop finished records older than `maxAgeMs` so the file does not grow forever. */
    prune(maxAgeMs = 7 * 24 * 3600 * 1000): void {
        const cutoff = Date.now() - maxAgeMs;
        let changed = false;
        for (const [id, s] of this.services) {
            if (s.status !== 'running' && (s.exitedAt ?? s.startedAt) < cutoff) {
                this.services.delete(id);
                changed = true;
            }
        }
        if (changed) this.save();
    }
}

// A single registry per gateway process; created lazily with the store dir
// the gateway passes in, so tools created before the workspace is known can
// still reach it.
let shared: ServiceRegistry | null = null;

export function initServiceRegistry(storeDir: string): ServiceRegistry {
    if (!shared) {
        shared = new ServiceRegistry(storeDir);
        shared.prune();
        // Leftovers from a run that did not shut down cleanly.
        void shared.reapOrphans();
    }
    return shared;
}

export function getServiceRegistry(): ServiceRegistry | null {
    return shared;
}

/** Commands that are servers/watchers: they must go through `spawn`, never a one-shot run. */
export const LONG_RUNNING_COMMAND = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview|watch)\b|\bnpx\s+(?:vite|next|nuxt|serve|http-server|webpack(?:-dev-server)?)\b|\b(?:vite|next|nuxt|astro|remix)\s+(?:dev|start|preview)\b|\bartisan\s+serve\b|\bphp\s+-S\b|\bpython3?\s+-m\s+http\.server\b|\b(?:uvicorn|gunicorn|hypercorn|daphne)\b|\bflask\s+run\b|\brails\s+s(?:erver)?\b|\bng\s+serve\b|\bdotnet\s+(?:run|watch)\b|\bcargo\s+(?:run|watch)\b|\bstart\s+\/b\b|\bnohup\b|\bwebpack-dev-server\b|\bnodemon\b|\bts-node-dev\b/i;

export function looksLongRunning(command: string): boolean {
    return LONG_RUNNING_COMMAND.test(command);
}
