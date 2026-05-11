/**
 * 日志工具
 * 支持全局日志广播（供 debug 面板使用）
 *
 * 使用 global 对象 + 字符串 key 存储广播处理器，
 * 这是 Node.js/Electron 中最简单可靠的跨模块共享方式。
 */
import winston from 'winston';
import { join } from 'path';
import { mkdirSync } from 'fs';

// 获取日志目录：优先 %APPDATA%/OpenFlux/logs，fallback 到用户目录
function getLogDir(): string {
    const appData = process.env.APPDATA || join(process.env.HOME || process.env.USERPROFILE || '.', 'AppData', 'Roaming');
    const logDir = join(appData, 'OpenFlux', 'logs');
    try { mkdirSync(logDir, { recursive: true }); } catch { /* ignore */ }
    return logDir;
}

// ========================
// 全局日志广播
// ========================

export interface LogEntry {
    timestamp: string;
    level: 'info' | 'warn' | 'error' | 'debug';
    module: string;
    message: string;
    meta?: Record<string, unknown>;
}

type LogBroadcastHandler = (entry: LogEntry) => void;

// 使用 global（Node.js 全局对象）确保跨 chunk 共享
const GLOBAL_KEY = '__openflux_log_handlers__';
const GLOBAL_LOGGERS_KEY = '__openflux_loggers__';      // 所有 Logger 实例注册表
const GLOBAL_DEBUG_COUNT_KEY = '__openflux_debug_count__'; // debug 订阅者计数

// 确保全局数组/对象存在
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
 * 订阅全局日志广播
 * @returns 取消订阅函数
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
 * 广播日志条目给所有订阅者
 */
function broadcastLog(entry: LogEntry): void {
    const handlers: LogBroadcastHandler[] = (global as any)[GLOBAL_KEY];
    if (!handlers || handlers.length === 0) return;
    for (const handler of handlers) {
        try {
            handler(entry);
        } catch {
            // 广播失败不影响日志本身
        }
    }
}

/**
 * 将所有已注册的 Logger 实例的 Winston level 切换到指定级别
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
 * debug.subscribe 时调用：订阅者 +1，第一个订阅者到来时把全局 log level 升到 debug
 */
export function incrementDebugSubscribers(): void {
    const prev: number = (global as any)[GLOBAL_DEBUG_COUNT_KEY];
    (global as any)[GLOBAL_DEBUG_COUNT_KEY] = prev + 1;
    if (prev === 0) {
        setGlobalLogLevel('debug');
    }
}

/**
 * debug.unsubscribe 时调用：订阅者 -1，最后一个离开时把 log level 降回 info
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
// 时间工具
// ========================

/** 获取本地时区的 ISO 格式时间戳（如 2026-03-25T22:31:41.870+08:00） */
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
// Logger 类
// ========================

/**
 * 将 args 序列化为可读字符串（类似 console 的行为）
 */
function argsToString(args: unknown[]): string {
    return args.map(a => {
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ');
}

/**
 * 拦截全局 console 方法，将所有输出同步广播给 debug 订阅者。
 * 只需在 Gateway 入口调用一次，之后 console.log / warn / error / debug
 * 都会出现在客户端 debug 面板。
 *
 * 注意：原始 console 方法仍然正常执行（不影响 terminal 输出）。
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
            original(...args);  // 保留原始输出
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

        // 初始 level：有 debug 订阅者时用 debug，否则用 info
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

        // 注册到全局 logger 注册表，以便 setGlobalLogLevel 能统一切换
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
