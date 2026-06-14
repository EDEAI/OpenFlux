/**
 * Logging tool
 * Support global log broadcast (for use by debug panel)
 *
 * Use global object + string key to store broadcast processor,
 * This is the simplest and most reliable way of sharing across modules in Node.js/Electron.
 */
import winston from 'winston';
import { join } from 'path';
import { mkdirSync } from 'fs';

// Get the log directory: priority %APPDATA%/OpenFlux/logs, fallback to the user directory
function getLogDir(): string {
    const appData = process.env.APPDATA || join(process.env.HOME || process.env.USERPROFILE || '.', 'AppData', 'Roaming');
    const logDir = join(appData, 'OpenFlux', 'logs');
    try { mkdirSync(logDir, { recursive: true }); } catch { /* ignore */ }
    return logDir;
}

// ========================
// Global log broadcast
// ========================

export interface LogEntry {
    timestamp: string;
    level: 'info' | 'warn' | 'error' | 'debug';
    module: string;
    message: string;
    meta?: Record<string, unknown>;
}

type LogBroadcastHandler = (entry: LogEntry) => void;

// Use global (Node.js global object) to ensure sharing across chunks
const GLOBAL_KEY = '__openflux_log_handlers__';
const GLOBAL_LOGGERS_KEY = '__openflux_loggers__';      // All Logger instance registries
const GLOBAL_DEBUG_COUNT_KEY = '__openflux_debug_count__'; // debug subscriber count

// Make sure the global array/object exists
if (!(global as any)[GLOBAL_KEY]) {
    (global as any)[GLOBAL_KEY] = [];
}
if (!(global as any)[GLOBAL_LOGGERS_KEY]) {
    (global as any)[GLOBAL_LOGGERS_KEY] = new Set();
}
if ((global as any)[GLOBAL_DEBUG_COUNT_KEY] === undefined) {
    (global as any)[GLOBAL_DEBUG_COUNT_KEY] = 0;
}

/**
 * Subscribe to global log broadcast
 * @returns unsubscribe function
 */
export function onLogBroadcast(handler: LogBroadcastHandler): () => void {
    const handlers: LogBroadcastHandler[] = (global as any)[GLOBAL_KEY];
    handlers.push(handler);
    return () => {
        const idx = handlers.indexOf(handler);
        if (idx !== -1) handlers.splice(idx, 1);
    };
}

/**
 * Broadcast log entries to all subscribers
 */
function broadcastLog(entry: LogEntry): void {
    const handlers: LogBroadcastHandler[] = (global as any)[GLOBAL_KEY];
    if (!handlers || handlers.length === 0) return;
    for (const handler of handlers) {
        try {
            handler(entry);
        } catch {
            // Broadcast failure does not affect the log itself
        }
    }
}

/**
 * Switch the Winston level of all registered Logger instances to the specified level
 */
function setGlobalLogLevel(level: 'info' | 'debug'): void {
    const loggers: Set<winston.Logger> = (global as any)[GLOBAL_LOGGERS_KEY];
    for (const wLogger of loggers) {
        wLogger.level = level;
        for (const transport of wLogger.transports) {
            transport.level = level;
        }
    }
}

/**
 * Called when debug.subscribe: Subscriber +1, when the first subscriber arrives, raise the global log level to debug
 */
export function incrementDebugSubscribers(): void {
    const prev: number = (global as any)[GLOBAL_DEBUG_COUNT_KEY];
    (global as any)[GLOBAL_DEBUG_COUNT_KEY] = prev + 1;
    if (prev === 0) {
        setGlobalLogLevel('debug');
    }
}

/**
 * Called when debug.unsubscribe: Subscriber -1, when the last one leaves, the log level is lowered back to info
 */
export function decrementDebugSubscribers(): void {
    const prev: number = (global as any)[GLOBAL_DEBUG_COUNT_KEY];
    const next = Math.max(0, prev - 1);
    (global as any)[GLOBAL_DEBUG_COUNT_KEY] = next;
    if (next === 0) {
        setGlobalLogLevel('info');
    }
}

// ========================
// time tool
// ========================

/** Get the ISO format timestamp in the local time zone (such as 2026-03-25T22:31:41.870+08:00) */
function getLocalTimestamp(): string {
    const now = new Date();
    const offset = -now.getTimezoneOffset();
    const sign = offset >= 0 ? '+' : '-';
    const pad = (n: number) => String(Math.abs(n)).padStart(2, '0');
    const hours = Math.floor(offset / 60);
    const minutes = offset % 60;
    const yyyy = now.getFullYear();
    const MM = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const ms = String(now.getMilliseconds()).padStart(3, '0');
    return `${yyyy}-${MM}-${dd}T${hh}:${mm}:${ss}.${ms}${sign}${pad(hours)}:${pad(minutes)}`;
}

// ========================
// Logger class
// ========================

/**
 * Serialize args into a readable string (console-like behavior)
 */
function argsToString(args: unknown[]): string {
    return args.map(a => {
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ');
}

/**
 * Intercept the global console method and broadcast all output to debug subscribers synchronously.
 * Just call it once at the Gateway entry, then console.log / warn / error / debug
 * will appear in the client debug panel.
 *
 * Note: The original console method still executes normally (does not affect terminal output).
 */
export function installConsoleCapture(): void {
    const LEVEL_MAP: Record<string, LogEntry['level']> = {
        log: 'info',
        info: 'info',
        warn: 'warn',
        error: 'error',
        debug: 'debug',
    };

    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
        const original = (console as any)[method].bind(console);
        (console as any)[method] = (...args: unknown[]) => {
            original(...args);  // Keep original output
            broadcastLog({
                timestamp: getLocalTimestamp(),
                level: LEVEL_MAP[method],
                module: 'console',
                message: argsToString(args),
            });
        };
    }
}

export class Logger {
    private logger: winston.Logger;
    private module: string;

    constructor(module: string) {
        this.module = module;

        // Initial level: Use debug when there are debug subscribers, otherwise use info
        const currentCount: number = (global as any)[GLOBAL_DEBUG_COUNT_KEY] ?? 0;
        const initialLevel = (process.env.LOG_LEVEL || (currentCount > 0 ? 'debug' : 'info')) as string;

        this.logger = winston.createLogger({
            level: initialLevel,
            format: winston.format.combine(
                winston.format.timestamp({ format: () => getLocalTimestamp() }),
                winston.format.printf(({ timestamp, level, message, ...meta }) => {
                    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
                    return `${timestamp} [${level.toUpperCase()}] [${this.module}] ${message}${metaStr}`;
                })
            ),
            transports: [
                new winston.transports.Console({
                    level: initialLevel,
                    format: winston.format.combine(
                        winston.format.colorize(),
                        winston.format.simple()
                    ),
                }),
                new winston.transports.File({
                    filename: join(getLogDir(), 'OpenFlux.log'),
                    level: initialLevel,
                    maxsize: 10 * 1024 * 1024, // 10MB
                    maxFiles: 5,
                }),
            ],
        });

        // Register to the global logger registry so that setGlobalLogLevel can switch uniformly
        const loggers: Set<winston.Logger> = (global as any)[GLOBAL_LOGGERS_KEY];
        loggers.add(this.logger);
    }

    info(message: string, meta?: Record<string, unknown>): void {
        this.logger.info(message, meta);
        broadcastLog({ timestamp: getLocalTimestamp(), level: 'info', module: this.module, message, meta });
    }

    warn(message: string, meta?: Record<string, unknown>): void {
        this.logger.warn(message, meta);
        broadcastLog({ timestamp: getLocalTimestamp(), level: 'warn', module: this.module, message, meta });
    }

    error(message: string, error?: unknown): void {
        const meta = error instanceof Error
            ? { error: error.message, stack: error.stack }
            : error != null ? { error } : undefined;
        this.logger.error(message, meta);
        broadcastLog({ timestamp: getLocalTimestamp(), level: 'error', module: this.module, message, meta: meta as Record<string, unknown> | undefined });
    }

    debug(message: string, meta?: Record<string, unknown>): void {
        this.logger.debug(message, meta);
        broadcastLog({ timestamp: getLocalTimestamp(), level: 'debug', module: this.module, message, meta });
    }
}
