/**
 * File System Tools - Factory Mode
 * Refer to Clawdbot design and combine read/write/list/delete into a single multi-action tool
 * Supports path whitelist/blacklist, file extension blacklist, write size limit
 */

import { readFile, writeFile, appendFile, readdir, stat, rm, mkdir, copyFile, rename } from 'fs/promises';
import * as fsSync from 'fs';
import { dirname, join, basename, isAbsolute, resolve, extname, normalize } from 'path';
import type { AnyTool, ToolResult } from '../types';
import {
    readStringParam,
    readBooleanParam,
    validateAction,
    jsonResult,
    errorResult,
    safeExecute,
} from '../common';
import { isPathWithinBoundary } from '../../utils/path-boundary';

// Supported actions
const FILESYSTEM_ACTIONS = [
    'read',      // read file
    'write',     // write file
    'list',      // list directory
    'delete',    // Delete files/directories
    'copy',      // Copy files
    'move',      // Move/Rename
    'exists',    // Check if exists
    'info',      // Get file information
    'watch',     // File monitoring
] as const;

type FileSystemAction = (typeof FILESYSTEM_ACTIONS)[number];

// File monitoring status
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

// Default extension blacklist path
const DEFAULT_BLOCKED_PATHS = [
    'C:\\Windows',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    'C:\\ProgramData',
];

// Extensions that are prohibited from writing by default
const DEFAULT_BLOCKED_EXTENSIONS = [
    'exe', 'bat', 'cmd', 'ps1', 'vbs', 'vbe',
    'wsf', 'wsh', 'msi', 'msp', 'com', 'scr',
    'pif', 'reg', 'inf', 'hta', 'cpl',
];

export interface FileSystemToolOptions {
    /** Whether to allow deletion operations */
    allowDelete?: boolean;
    /** Whether to allow writing to system directories */
    allowSystemPaths?: boolean;
    /** Whitelist directory (reading and writing are restricted) */
    allowedPaths?: string[] | (() => string[]);
    /** Write whitelist (only checked when writing/deleting/copying/moving, reading is not restricted) */
    allowedWritePaths?: string[] | (() => string[]);
    /** Blacklist directories (operating on these directories is prohibited) */
    blockedPaths?: string[];
    /** Base path: relative paths will be resolved based on this (supports dynamic functions) */
    basePath?: string | (() => string);
    /** File extensions that are prohibited from writing (default includes exe/bat/cmd/ps1, etc.) */
    blockedExtensions?: string[];
    /** Maximum write size of a single file (bytes), default 50MB */
    maxWriteSize?: number;
}

/**
 * Create file system tools
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
     * Parsing paths: relative paths are parsed based on basePath, absolute paths are not affected
     */
    function resolvePath(inputPath: string): string {
        if (isAbsolute(inputPath)) return normalize(inputPath);
        const base = typeof basePath === 'function' ? basePath() : basePath;
        if (base) return resolve(base, inputPath);
        return inputPath;
    }

    // Path security check
    function checkPath(path: string, isWrite: boolean = false): void {
        if (!allowSystemPaths) {
            for (const blocked of blockedPaths) {
                if (isPathWithinBoundary(path, resolvePath(blocked))) {
                    throw new Error(`Access to system path is forbidden: ${path}`);
                }
            }
        }
        // Universal whitelist (reading and writing are restricted)
        const currentAllowedPaths = typeof allowedPaths === 'function' ? allowedPaths() : allowedPaths;
        if (currentAllowedPaths && currentAllowedPaths.length > 0) {
            const allowed = currentAllowedPaths.some(p => isPathWithinBoundary(path, resolvePath(p)));
            if (!allowed) {
                throw new Error(`Path is not in the whitelist: ${path}`);
            }
        }
        // Write whitelist (only checked during write operations)
        const currentAllowedWritePaths = typeof allowedWritePaths === 'function'
            ? allowedWritePaths()
            : allowedWritePaths;
        if (isWrite && currentAllowedWritePaths && currentAllowedWritePaths.length > 0) {
            const allowed = currentAllowedWritePaths.some(p => isPathWithinBoundary(path, resolvePath(p)));
            if (!allowed) {
                const resolvedHints = currentAllowedWritePaths.map(p => resolvePath(p));
                throw new Error(`Write path is not in the allowed range: ${path}\nAllowed directories: ${resolvedHints.join(', ')}`);
            }
        }
    }

    /**
     * Check if file extension is prohibited from writing
     */
    function checkExtension(filePath: string, action: string): void {
        if (action !== 'write' && action !== 'copy' && action !== 'move') return;

        const ext = extname(filePath).toLowerCase().replace('.', '');
        if (ext && blockedExtensions.includes(ext)) {
            throw new Error(`Writing .${ext} file type is forbidden: ${filePath}`);
        }
    }

    // Active file monitor
    const activeWatchers = new Map<string, WatcherState>();

    return {
        name: 'filesystem',
        priority: 30,
        description: `File system operation tool. Supported actions: ${FILESYSTEM_ACTIONS.join(', ')}. watch sub-actions: start/poll/stop`,
        parameters: {
            action: {
                type: 'string',
                description: `Action type: ${FILESYSTEM_ACTIONS.join('/')}`,
                required: true,
                enum: [...FILESYSTEM_ACTIONS],
            },
            path: {
                type: 'string',
                description: 'Target path',
                required: true,
            },
            content: {
                type: 'string',
                description: 'File content (required for write action). IMPORTANT: Keep content under 80 lines per call. For larger files, use append=true for subsequent chunks.',
            },
            append: {
                type: 'boolean',
                description: 'If true, append content to file instead of overwriting. Use this for writing large files in chunks.',
                default: false,
            },
            destination: {
                type: 'string',
                description: 'Destination path (required for copy/move action)',
            },
            recursive: {
                type: 'boolean',
                description: 'Whether to operate recursively (available for delete/list actions)',
                default: false,
            },
            encoding: {
                type: 'string',
                description: 'File encoding (default: utf-8)',
                default: 'utf-8',
            },
            subAction: {
                type: 'string',
                description: 'watch sub-action: start/poll/stop',
            },
        },

        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
            const action = validateAction(args, FILESYSTEM_ACTIONS);
            const rawPath = readStringParam(args, 'path', { required: true, label: 'path' });
            const path = resolvePath(rawPath);

            // Safety checks (write operations are marked individually in each branch)
            const isWriteAction = ['write', 'delete', 'copy', 'move', 'mkdir'].includes(action);
            checkPath(path, isWriteAction);

            switch (action) {
                // read file
                case 'read': {
                    return safeExecute(async () => {
                        const encoding = readStringParam(args, 'encoding') || 'utf-8';
                        const content = await readFile(path, { encoding: encoding as BufferEncoding });
                        return { path, content, size: content.length };
                    });
                }

                // write file
                case 'write': {
                    const content = readStringParam(args, 'content', { required: true, label: 'content' });
                    const appendMode = readBooleanParam(args, 'append', false);
                    // Extension check
                    checkExtension(path, action);
                    // Size check
                    if (content.length > maxWriteSize) {
                        return errorResult(
                            `File content exceeds size limit: ${(content.length / 1024 / 1024).toFixed(1)}MB > ${(maxWriteSize / 1024 / 1024).toFixed(1)}MB`
                        );
                    }
                    return safeExecute(async () => {
                        await mkdir(dirname(path), { recursive: true });
                        if (appendMode) {
                            await appendFile(path, content, 'utf-8');
                            return { path, appended: true, size: content.length };
                        } else {
                            await writeFile(path, content, 'utf-8');
                            return { path, written: true, size: content.length };
                        }
                    });
                }

                // list directory
                case 'list': {
                    const recursive = readBooleanParam(args, 'recursive', false);
                    return safeExecute(async () => {
                        let entries: string[];
                        try {
                            entries = await readdir(path);
                        } catch (error) {
                            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                                return { path, exists: false, count: 0, entries: [] };
                            }
                            throw error;
                        }
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
                        return { path, exists: true, count: results.length, entries: results };
                    });
                }

                // Delete files/directories
                case 'delete': {
                    if (!allowDelete) {
                        return errorResult('Delete operation is disabled');
                    }
                    const recursive = readBooleanParam(args, 'recursive', false);
                    return safeExecute(async () => {
                        await rm(path, { recursive, force: true });
                        return { path, deleted: true };
                    });
                }

                // Copy files
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

                // Move/Rename
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

                // Check if exists
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

                // Get file information
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

                // File monitoring
                case 'watch': {
                    const sub = readStringParam(args, 'subAction') || 'poll';

                    switch (sub) {
                        case 'start': {
                            if (activeWatchers.has(path)) {
                                return jsonResult({ path, message: 'Already watching', eventCount: activeWatchers.get(path)!.events.length });
                            }

                            try {
                                const events: WatchEvent[] = [];
                                const watcher = fsSync.watch(path, { recursive: true }, (eventType, filename) => {
                                    events.push({
                                        type: eventType,
                                        filename: filename || 'unknown',
                                        timestamp: new Date().toISOString(),
                                    });
                                    // Limit the number of cached events
                                    if (events.length > 1000) events.splice(0, events.length - 500);
                                });

                                activeWatchers.set(path, { watcher, events, path });
                                return jsonResult({ path, watching: true, message: 'Started watching for file changes' });
                            } catch (error: any) {
                                return errorResult(`Failed to start watching: ${error.message}`);
                            }
                        }

                        case 'poll': {
                            const state = activeWatchers.get(path);
                            if (!state) {
                                return errorResult(`Not watching: ${path}, please use the start sub-action first`);
                            }

                            // Get all events and clear the buffer
                            const events = [...state.events];
                            state.events.length = 0;

                            // Deduplication: Only the last one of consecutive events in the same file is retained
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
                                return jsonResult({ path, message: 'Not watching' });
                            }
                            state.watcher.close();
                            activeWatchers.delete(path);
                            return jsonResult({ path, stopped: true, message: 'Stopped watching' });
                        }

                        default:
                            return errorResult(`Unknown watch sub-action: ${sub}, supported: start/poll/stop`);
                    }
                }

                default:
                    return errorResult(`Unknown action: ${action}`);
            }
        },
    };
}
