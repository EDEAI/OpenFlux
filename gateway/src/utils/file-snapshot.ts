/**
 * Directory snapshots and diff tools
 * Used to detect new files generated before and after process/opencode execution
 */

import { readdir, stat } from 'fs/promises';
import { statSync } from 'fs';
import { join, resolve } from 'path';

export interface FileEntry {
    /** Relative path */
    name: string;
    /** Absolute path */
    fullPath: string;
    /** File size */
    size: number;
    /** Modify timestamp */
    mtimeMs: number;
    /** Whether it is a directory */
    isDirectory: boolean;
}

/** Snapshot results */
export type DirectorySnapshot = Map<string, FileEntry>;

/** Excluded file/directory names */
const EXCLUDE_NAMES = new Set([
    '__pycache__',
    'node_modules',
    '.git',
    '.venv',
    'venv',
    '.env',
    '.DS_Store',
    'Thumbs.db',
]);

/** Excluded extensions */
const EXCLUDE_EXTENSIONS = new Set([
    '.tmp',
    '.temp',
    '.pyc',
    '.pyo',
    '.log',
]);

/**
 * Take a snapshot of the directory and record the path, size, and mtime of all files
 * @param dir directory path
 * @param maxDepth maximum recursion depth (default 2)
 */
export async function snapshotDirectory(dir: string, maxDepth: number = 2): Promise<DirectorySnapshot> {
    const snapshot: DirectorySnapshot = new Map();
    const absDir = resolve(dir);

    async function scan(currentDir: string, depth: number, prefix: string): Promise<void> {
        if (depth > maxDepth) return;

        let entries: string[];
        try {
            entries = await readdir(currentDir);
        } catch {
            return; // Directory does not exist or does not have access rights
        }

        for (const entry of entries) {
            if (EXCLUDE_NAMES.has(entry)) continue;

            const ext = entry.lastIndexOf('.') !== -1 ? entry.slice(entry.lastIndexOf('.')) : '';
            if (EXCLUDE_EXTENSIONS.has(ext.toLowerCase())) continue;

            const fullPath = join(currentDir, entry);
            const relativeName = prefix ? `${prefix}/${entry}` : entry;

            try {
                const stats = await stat(fullPath);

                if (stats.isDirectory()) {
                    // The record directory itself is not needed, subdirectories are scanned recursively
                    await scan(fullPath, depth + 1, relativeName);
                } else if (stats.isFile()) {
                    snapshot.set(relativeName, {
                        name: relativeName,
                        fullPath,
                        size: stats.size,
                        mtimeMs: stats.mtimeMs,
                        isDirectory: false,
                    });
                }
            } catch {
                // stat skipped on failure
            }
        }
    }

    await scan(absDir, 0, '');
    return snapshot;
}

export interface GeneratedFile {
    /** Relative path */
    path: string;
    /** Absolute path */
    fullPath: string;
    /** File size */
    size: number;
    /** Modify timestamp (ms)，便于前端按真实产出时间归档 */
    mtimeMs?: number;
}

/**
 * Compare two snapshots to find new or modified files
 */
export function diffSnapshots(before: DirectorySnapshot, after: DirectorySnapshot): GeneratedFile[] {
    const generated: GeneratedFile[] = [];

    for (const [name, afterEntry] of after) {
        const beforeEntry = before.get(name);

        if (!beforeEntry) {
            // Add new file
            generated.push({
                path: afterEntry.name,
                fullPath: afterEntry.fullPath,
                size: afterEntry.size,
                mtimeMs: afterEntry.mtimeMs,
            });
        } else if (afterEntry.mtimeMs > beforeEntry.mtimeMs || afterEntry.size !== beforeEntry.size) {
            // File modified
            generated.push({
                path: afterEntry.name,
                fullPath: afterEntry.fullPath,
                size: afterEntry.size,
                mtimeMs: afterEntry.mtimeMs,
            });
        }
    }

    return generated;
}

/** 可识别为成果物的文件扩展名（用于从 stdout 兜底检测） */
const ARTIFACT_PATH_REGEX = /(?:[A-Za-z]:[/\\]|\/)[^\s"'<>|*?\n]+\.(?:pptx?|docx?|xlsx?|pdf|png|jpe?g|gif|svg|webp|mp4|mp3|wav|zip|csv|html?|md|txt)(?=\s|$|["'])/gi;

/**
 * 从命令 stdout 中兜底识别"本次运行真正产出/修改"的文件。
 *
 * 关键：只纳入 mtime 不早于本次运行开始时间(sinceMs)的文件，
 * 从而避免把脚本里"被读取/引用的历史旧文件路径"误当成当日产出。
 *
 * @param stdout   命令输出
 * @param baseDir  相对路径解析基准目录（通常为工作目录）
 * @param sinceMs  本次运行开始时间（ms），早于该时间修改的文件一律忽略
 * @param exclude  已收集的绝对路径集合（去重）
 */
export function detectGeneratedFromStdout(
    stdout: string,
    baseDir: string,
    sinceMs: number,
    exclude?: Set<string>,
): GeneratedFile[] {
    const out: GeneratedFile[] = [];
    if (!stdout) return out;

    const matches = stdout.match(ARTIFACT_PATH_REGEX);
    if (!matches) return out;

    const seen = exclude || new Set<string>();
    // 容忍少量时钟/文件系统精度误差
    const threshold = sinceMs - 2000;

    for (const raw of [...new Set(matches)]) {
        const cleaned = raw.replace(/^["']|["']$/g, '').trim();
        let full: string;
        try {
            full = resolve(baseDir, cleaned);
        } catch {
            continue;
        }
        if (seen.has(full)) continue;
        try {
            const st = statSync(full);
            if (!st.isFile()) continue;
            // 只接受本次运行期间被写入/修改的文件，过滤历史旧文件
            if (st.mtimeMs < threshold) continue;
            seen.add(full);
            out.push({
                path: cleaned.split(/[/\\]/).pop() || cleaned,
                fullPath: full,
                size: st.size,
                mtimeMs: st.mtimeMs,
            });
        } catch {
            // 文件不存在或无法访问，忽略
        }
    }

    return out;
}
