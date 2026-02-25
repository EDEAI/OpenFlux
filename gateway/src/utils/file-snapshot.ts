/**
 * 目录快照与 diff 工具
 * 用于检测 process/opencode 执行前后产生的新文件
 */

import { readdir, stat } from 'fs/promises';
import { join, resolve } from 'path';

export interface FileEntry {
    /** 相对路径 */
    name: string;
    /** 绝对路径 */
    fullPath: string;
    /** 文件大小 */
    size: number;
    /** 修改时间戳 */
    mtimeMs: number;
    /** 是否是目录 */
    isDirectory: boolean;
}

/** 快照结果 */
export type DirectorySnapshot = Map<string, FileEntry>;

/** 排除的文件/目录名 */
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

/** 排除的扩展名 */
const EXCLUDE_EXTENSIONS = new Set([
    '.tmp',
    '.temp',
    '.pyc',
    '.pyo',
    '.log',
]);

/**
 * 对目录进行快照，记录所有文件的路径、大小、mtime
 * @param dir 目录路径
 * @param maxDepth 最大递归深度（默认 2）
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
            return; // 目录不存在或无权访问
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
                    // 记录目录本身不需要，递归扫描子目录
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
                // stat 失败跳过
            }
        }
    }

    await scan(absDir, 0, '');
    return snapshot;
}

export interface GeneratedFile {
    /** 相对路径 */
    path: string;
    /** 绝对路径 */
    fullPath: string;
    /** 文件大小 */
    size: number;
}

/**
 * 对比两次快照，找出新增或修改的文件
 */
export function diffSnapshots(before: DirectorySnapshot, after: DirectorySnapshot): GeneratedFile[] {
    const generated: GeneratedFile[] = [];

    for (const [name, afterEntry] of after) {
        const beforeEntry = before.get(name);

        if (!beforeEntry) {
            // 新增文件
            generated.push({
                path: afterEntry.name,
                fullPath: afterEntry.fullPath,
                size: afterEntry.size,
            });
        } else if (afterEntry.mtimeMs > beforeEntry.mtimeMs || afterEntry.size !== beforeEntry.size) {
            // 文件被修改
            generated.push({
                path: afterEntry.name,
                fullPath: afterEntry.fullPath,
                size: afterEntry.size,
            });
        }
    }

    return generated;
}
