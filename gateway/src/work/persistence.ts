import { randomUUID } from 'node:crypto';
import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

/** Small durable-JSON helpers shared by the plan and goal stores. */

export function safeId(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function ensureDirectory(path: string): void {
    if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

/** Write through a temp file, keeping the previous content as `<path>.bak`. */
export function atomicWrite(path: string, content: string): void {
    ensureDirectory(dirname(path));
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const backupPath = `${path}.bak`;
    writeFileSync(temporaryPath, content, 'utf8');
    if (existsSync(path)) {
        const previous = readFileSync(path);
        const backupTemporaryPath = `${backupPath}.${process.pid}.${randomUUID()}.tmp`;
        writeFileSync(backupTemporaryPath, previous);
        try {
            renameSync(backupTemporaryPath, backupPath);
        } catch {
            if (existsSync(backupPath)) unlinkSync(backupPath);
            renameSync(backupTemporaryPath, backupPath);
        }
    }
    try {
        renameSync(temporaryPath, path);
    } catch {
        // Windows does not consistently replace an existing destination.
        if (existsSync(path)) unlinkSync(path);
        renameSync(temporaryPath, path);
    }
}

/** Read `<path>`, falling back to `<path>.bak` when the primary is unreadable. */
export function readJsonWithBackup<T>(path: string): T | undefined {
    for (const candidate of [path, `${path}.bak`]) {
        if (!existsSync(candidate)) continue;
        try {
            return JSON.parse(readFileSync(candidate, 'utf8')) as T;
        } catch {
            // An interrupted write must not hide the last valid snapshot.
        }
    }
    return undefined;
}
