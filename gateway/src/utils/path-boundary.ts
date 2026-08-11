import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Resolve the existing portion of a path through symlinks/junctions while
 * preserving a not-yet-created suffix. This keeps boundary checks effective
 * for both reads and writes.
 */
export function canonicalizeBoundaryPath(input: string): string {
    let cursor = resolve(input);
    const suffix: string[] = [];

    while (!existsSync(cursor)) {
        const parent = dirname(cursor);
        if (parent === cursor) break;
        suffix.unshift(basename(cursor));
        cursor = parent;
    }

    const canonicalBase = existsSync(cursor)
        ? (realpathSync.native?.(cursor) ?? realpathSync(cursor))
        : cursor;
    return resolve(canonicalBase, ...suffix);
}

/** Exact descendant check; unlike startsWith, sibling prefixes do not match. */
export function isPathWithinBoundary(target: string, boundary: string): boolean {
    const canonicalTarget = canonicalizeBoundaryPath(target);
    const canonicalBoundary = canonicalizeBoundaryPath(boundary);
    const comparableTarget = process.platform === 'win32' ? canonicalTarget.toLowerCase() : canonicalTarget;
    const comparableBoundary = process.platform === 'win32' ? canonicalBoundary.toLowerCase() : canonicalBoundary;
    const rel = relative(comparableBoundary, comparableTarget);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
