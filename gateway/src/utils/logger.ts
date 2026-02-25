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

// 确保全局数组存在
if (!(global as any)[GLOBAL_KEY]) {
    (global as any)[GLOBAL_KEY] = [];
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

// ========================
// Logger 类
// ========================

export class Logger {
    private logger: winston.Logger;
    private module: string;

    constructor(module: string) {
        this.module = module;

        this.logger = winston.createLogger({
            level: process.env.LOG_LEVEL || 'info',
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.printf(({ timestamp, level, message, ...meta }) => {
                    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
                    return `${timestamp} [${level.toUpperCase()}] [${this.module}] ${message}${metaStr}`;
                })
            ),
            transports: [
                new winston.transports.Console({
                    format: winston.format.combine(
                        winston.format.colorize(),
                        winston.format.simple()
                    ),
                }),
                new winston.transports.File({
                    filename: join(getLogDir(), 'OpenFlux.log'),
                    maxsize: 10 * 1024 * 1024, // 10MB
                    maxFiles: 5,
                }),
            ],
        });
    }

    info(message: string, meta?: Record<string, unknown>): void {
        this.logger.info(message, meta);
        broadcastLog({ timestamp: new Date().toISOString(), level: 'info', module: this.module, message, meta });
    }

    warn(message: string, meta?: Record<string, unknown>): void {
        this.logger.warn(message, meta);
        broadcastLog({ timestamp: new Date().toISOString(), level: 'warn', module: this.module, message, meta });
    }

    error(message: string, error?: unknown): void {
        const meta = error instanceof Error
            ? { error: error.message, stack: error.stack }
            : error != null ? { error } : undefined;
        this.logger.error(message, meta);
        broadcastLog({ timestamp: new Date().toISOString(), level: 'error', module: this.module, message, meta: meta as Record<string, unknown> | undefined });
    }

    debug(message: string, meta?: Record<string, unknown>): void {
        this.logger.debug(message, meta);
        broadcastLog({ timestamp: new Date().toISOString(), level: 'debug', module: this.module, message, meta });
    }
}
