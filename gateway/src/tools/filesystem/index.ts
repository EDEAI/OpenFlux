/**
 * 文件系统工具 - 工厂模式
 * 参考 Clawdbot 设计，合并读/写/列表/删除为单个多动作工具
 * 支持路径白名单/黑名单、文件扩展名黑名单、写入大小限制
 */

import { readFile, writeFile, readdir, stat, rm, mkdir, copyFile, rename } from 'fs/promises';
import * as fsSync from 'fs';
import { dirname, join, basename, isAbsolute, resolve, extname } from 'path';
import type { AnyTool, ToolResult } from '../types';
import {
    readStringParam,
    readBooleanParam,
    validateAction,
    jsonResult,
    errorResult,
    safeExecute,
} from '../common';

// 支持的动作
const FILESYSTEM_ACTIONS = [
    'read',      // 读取文件
    'write',     // 写入文件
    'list',      // 列出目录
    'delete',    // 删除文件/目录
    'copy',      // 复制文件
    'move',      // 移动/重命名
    'exists',    // 检查是否存在
    'info',      // 获取文件信息
    'watch',     // 文件监控
] as const;

type FileSystemAction = (typeof FILESYSTEM_ACTIONS)[number];

// 文件监控状态
interface WatchEvent {
    type: string;
    filename: string;
    timestamp: string;
}

interface WatcherState {
    watcher: fsSync.FSWatcher;
    events: WatchEvent[];
    path: string;
}

// 默认扩展黑名单路径
const DEFAULT_BLOCKED_PATHS = [
    'C:\\Windows',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    'C:\\ProgramData',
];

// 默认禁止写入的扩展名
const DEFAULT_BLOCKED_EXTENSIONS = [
    'exe', 'bat', 'cmd', 'ps1', 'vbs', 'vbe',
    'wsf', 'wsh', 'msi', 'msp', 'com', 'scr',
    'pif', 'reg', 'inf', 'hta', 'cpl',
];

export interface FileSystemToolOptions {
    /** 是否允许删除操作 */
    allowDelete?: boolean;
    /** 是否允许写入系统目录 */
    allowSystemPaths?: boolean;
    /** 白名单目录（读写均受限） */
    allowedPaths?: string[];
    /** 写入白名单（仅写入/删除/复制/移动时检查，读取不受限） */
    allowedWritePaths?: string[];
    /** 黑名单目录（禁止操作这些目录） */
    blockedPaths?: string[];
    /** 基础路径：相对路径将基于此解析（支持动态函数） */
    basePath?: string | (() => string);
    /** 禁止写入的文件扩展名（默认含 exe/bat/cmd/ps1 等） */
    blockedExtensions?: string[];
    /** 单文件最大写入大小（字节），默认 50MB */
    maxWriteSize?: number;
}

/**
 * 创建文件系统工具
 */
export function createFileSystemTool(opts: FileSystemToolOptions = {}): AnyTool {
    const {
        allowDelete = true,
        allowSystemPaths = false,
        allowedPaths,
        allowedWritePaths,
        blockedPaths = DEFAULT_BLOCKED_PATHS,
        basePath,
        blockedExtensions = DEFAULT_BLOCKED_EXTENSIONS,
        maxWriteSize = 50 * 1024 * 1024, // 50MB
    } = opts;

    /**
     * 解析路径：相对路径基于 basePath 解析，绝对路径不受影响
     */
    function resolvePath(inputPath: string): string {
        if (isAbsolute(inputPath)) return inputPath;
        const base = typeof basePath === 'function' ? basePath() : basePath;
        if (base) return resolve(base, inputPath);
        return inputPath;
    }

    // 路径安全检查
    function checkPath(path: string, isWrite: boolean = false): void {
        if (!allowSystemPaths) {
            for (const blocked of blockedPaths) {
                if (path.toLowerCase().startsWith(blocked.toLowerCase())) {
                    throw new Error(`禁止访问系统路径: ${path}`);
                }
            }
        }
        // 通用白名单（读写均受限）
        if (allowedPaths && allowedPaths.length > 0) {
            const allowed = allowedPaths.some((p) => {
                const resolved = resolvePath(p);
                return path.toLowerCase().startsWith(resolved.toLowerCase());
            });
            if (!allowed) {
                throw new Error(`路径不在白名单中: ${path}`);
            }
        }
        // 写入白名单（仅写入操作时检查）
        if (isWrite && allowedWritePaths && allowedWritePaths.length > 0) {
            const allowed = allowedWritePaths.some((p) => {
                const resolved = resolvePath(p);
                return path.toLowerCase().startsWith(resolved.toLowerCase());
            });
            if (!allowed) {
                const resolvedHints = allowedWritePaths.map(p => resolvePath(p));
                throw new Error(`写入路径不在允许范围内: ${path}\n允许的目录: ${resolvedHints.join(', ')}`);
            }
        }
    }

    /**
     * 检查文件扩展名是否被禁止写入
     */
    function checkExtension(filePath: string, action: string): void {
        if (action !== 'write' && action !== 'copy' && action !== 'move') return;

        const ext = extname(filePath).toLowerCase().replace('.', '');
        if (ext && blockedExtensions.includes(ext)) {
            throw new Error(`禁止写入 .${ext} 类型文件: ${filePath}`);
        }
    }

    // 活跃的文件监控器
    const activeWatchers = new Map<string, WatcherState>();

    return {
        name: 'filesystem',
        description: `文件系统操作工具。支持的动作: ${FILESYSTEM_ACTIONS.join(', ')}。watch 动作子操作: start(开始监控)/poll(获取变化)/stop(停止监控)`,
        parameters: {
            action: {
                type: 'string',
                description: `操作类型: ${FILESYSTEM_ACTIONS.join('/')}`,
                required: true,
                enum: [...FILESYSTEM_ACTIONS],
            },
            path: {
                type: 'string',
                description: '目标路径',
                required: true,
            },
            content: {
                type: 'string',
                description: '文件内容（write 动作需要）',
            },
            destination: {
                type: 'string',
                description: '目标路径（copy/move 动作需要）',
            },
            recursive: {
                type: 'boolean',
                description: '是否递归操作（delete/list 动作可用）',
                default: false,
            },
            encoding: {
                type: 'string',
                description: '文件编码（默认 utf-8）',
                default: 'utf-8',
            },
            subAction: {
                type: 'string',
                description: 'watch 子操作: start/poll/stop',
            },
        },

        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
            const action = validateAction(args, FILESYSTEM_ACTIONS);
            const rawPath = readStringParam(args, 'path', { required: true, label: 'path' });
            const path = resolvePath(rawPath);

            // 安全检查（写入操作在各分支中单独标记）
            const isWriteAction = ['write', 'delete', 'copy', 'move', 'mkdir'].includes(action);
            checkPath(path, isWriteAction);

            switch (action) {
                // 读取文件
                case 'read': {
                    return safeExecute(async () => {
                        const encoding = readStringParam(args, 'encoding') || 'utf-8';
                        const content = await readFile(path, { encoding: encoding as BufferEncoding });
                        return { path, content, size: content.length };
                    });
                }

                // 写入文件
                case 'write': {
                    const content = readStringParam(args, 'content', { required: true, label: 'content' });
                    // 扩展名检查
                    checkExtension(path, action);
                    // 大小检查
                    if (content.length > maxWriteSize) {
                        return errorResult(
                            `文件内容超过大小限制: ${(content.length / 1024 / 1024).toFixed(1)}MB > ${(maxWriteSize / 1024 / 1024).toFixed(1)}MB`
                        );
                    }
                    return safeExecute(async () => {
                        await mkdir(dirname(path), { recursive: true });
                        await writeFile(path, content, 'utf-8');
                        return { path, written: true, size: content.length };
                    });
                }

                // 列出目录
                case 'list': {
                    const recursive = readBooleanParam(args, 'recursive', false);
                    return safeExecute(async () => {
                        const entries = await readdir(path);
                        const results = await Promise.all(
                            entries.map(async (entry) => {
                                const fullPath = join(path, entry);
                                try {
                                    const stats = await stat(fullPath);
                                    return {
                                        name: entry,
                                        path: fullPath,
                                        isDirectory: stats.isDirectory(),
                                        size: stats.size,
                                        modified: stats.mtime.toISOString(),
                                    };
                                } catch {
                                    return { name: entry, path: fullPath, error: 'stat failed' };
                                }
                            })
                        );
                        return { path, count: results.length, entries: results };
                    });
                }

                // 删除文件/目录
                case 'delete': {
                    if (!allowDelete) {
                        return errorResult('删除操作已禁用');
                    }
                    const recursive = readBooleanParam(args, 'recursive', false);
                    return safeExecute(async () => {
                        await rm(path, { recursive, force: true });
                        return { path, deleted: true };
                    });
                }

                // 复制文件
                case 'copy': {
                    const destination = resolvePath(readStringParam(args, 'destination', { required: true, label: 'destination' }));
                    checkPath(destination, true);
                    checkExtension(destination, action);
                    return safeExecute(async () => {
                        await mkdir(dirname(destination), { recursive: true });
                        await copyFile(path, destination);
                        return { source: path, destination, copied: true };
                    });
                }

                // 移动/重命名
                case 'move': {
                    const destination = resolvePath(readStringParam(args, 'destination', { required: true, label: 'destination' }));
                    checkPath(destination, true);
                    checkExtension(destination, action);
                    return safeExecute(async () => {
                        await mkdir(dirname(destination), { recursive: true });
                        await rename(path, destination);
                        return { source: path, destination, moved: true };
                    });
                }

                // 检查是否存在
                case 'exists': {
                    return safeExecute(async () => {
                        try {
                            await stat(path);
                            return { path, exists: true };
                        } catch {
                            return { path, exists: false };
                        }
                    });
                }

                // 获取文件信息
                case 'info': {
                    return safeExecute(async () => {
                        const stats = await stat(path);
                        return {
                            path,
                            name: basename(path),
                            isDirectory: stats.isDirectory(),
                            isFile: stats.isFile(),
                            size: stats.size,
                            created: stats.birthtime.toISOString(),
                            modified: stats.mtime.toISOString(),
                            accessed: stats.atime.toISOString(),
                        };
                    });
                }

                // 文件监控
                case 'watch': {
                    const sub = readStringParam(args, 'subAction') || 'poll';

                    switch (sub) {
                        case 'start': {
                            if (activeWatchers.has(path)) {
                                return jsonResult({ path, message: '已在监控中', eventCount: activeWatchers.get(path)!.events.length });
                            }

                            try {
                                const events: WatchEvent[] = [];
                                const watcher = fsSync.watch(path, { recursive: true }, (eventType, filename) => {
                                    events.push({
                                        type: eventType,
                                        filename: filename || 'unknown',
                                        timestamp: new Date().toISOString(),
                                    });
                                    // 限制缓存事件数量
                                    if (events.length > 1000) events.splice(0, events.length - 500);
                                });

                                activeWatchers.set(path, { watcher, events, path });
                                return jsonResult({ path, watching: true, message: '已开始监控文件变化' });
                            } catch (error: any) {
                                return errorResult(`启动监控失败: ${error.message}`);
                            }
                        }

                        case 'poll': {
                            const state = activeWatchers.get(path);
                            if (!state) {
                                return errorResult(`未在监控: ${path}，请先使用 start 子操作`);
                            }

                            // 取出所有事件并清空缓冲
                            const events = [...state.events];
                            state.events.length = 0;

                            // 去重：相同文件的连续事件只保留最后一个
                            const deduped = new Map<string, WatchEvent>();
                            for (const e of events) {
                                deduped.set(e.filename, e);
                            }

                            return jsonResult({
                                path,
                                changes: Array.from(deduped.values()),
                                totalRawEvents: events.length,
                                uniqueFiles: deduped.size,
                            });
                        }

                        case 'stop': {
                            const state = activeWatchers.get(path);
                            if (!state) {
                                return jsonResult({ path, message: '未在监控' });
                            }
                            state.watcher.close();
                            activeWatchers.delete(path);
                            return jsonResult({ path, stopped: true, message: '已停止监控' });
                        }

                        default:
                            return errorResult(`未知 watch 子操作: ${sub}，支持: start/poll/stop`);
                    }
                }

                default:
                    return errorResult(`未知动作: ${action}`);
            }
        },
    };
}
