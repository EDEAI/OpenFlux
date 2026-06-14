/**
 * Directory snapshots and diff tools
 * Used to detect new files generated before and after process/opencode execution
 */

import { readdir, stat } from 'fs/promises';
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
            });
        } else if (afterEntry.mtimeMs > beforeEntry.mtimeMs || afterEntry.size !== beforeEntry.size) {
            // File modified
            generated.push({
                path: afterEntry.name,
                fullPath: afterEntry.fullPath,
                size: afterEntry.size,
            });
        }
    }

    return generated;
}
