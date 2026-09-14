import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import type { Tool, ToolExecutionContext, ToolResult } from './types';
import { isPathWithinBoundary } from '../utils/path-boundary';

export interface ProjectSearchToolOptions {
    basePath: string | (() => string);
    /** Additional project directories searched after the primary one. */
    extraRoots?: string[] | (() => string[]);
}
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'build', 'target', '.next', '.cache']);
const TEXT_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.jsonl', '.md', '.txt', '.css', '.scss',
    '.html', '.xml', '.yaml', '.yml', '.toml', '.rs', '.py', '.go', '.java', '.kt', '.swift', '.c', '.h',
    '.cpp', '.hpp', '.cs', '.sh', '.ps1', '.sql', '.graphql', '.vue', '.svelte', '',
]);

function wildcard(pattern: string): RegExp {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`, 'i');
}

export function createProjectSearchTool(options: ProjectSearchToolOptions): Tool {
    return {
        name: 'project_search',
        priority: 27,
        description: 'Read-only project search. Find files by wildcard name or search text inside project files without running a process.',
        parameters: {
            action: { type: 'string', description: 'Search file names or file contents.', required: true, enum: ['files', 'content'] },
            query: { type: 'string', description: 'Wildcard for files (for example *.ts) or plain text for content search.', required: true },
            path: { type: 'string', description: 'Optional directory under the active workspace (primary or an additional project directory).' },
            maxResults: { type: 'number', description: 'Maximum matches, default 100.' },
        },
        async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
            const action = String(args.action || '');
            const query = String(args.query || '').trim();
            const base = typeof options.basePath === 'function' ? options.basePath() : options.basePath;
            const primaryRoot = resolve(base);
            const extraRootsRaw = typeof options.extraRoots === 'function' ? options.extraRoots() : options.extraRoots;
            const allRoots = [primaryRoot, ...(extraRootsRaw || []).map(dir => resolve(dir))];
            const requested = String(args.path || '').trim();
            const maxResults = Math.min(500, Math.max(1, Number(args.maxResults) || 100));
            if (!query) return { success: false, error: 'query is required' };
            if (action !== 'files' && action !== 'content') return { success: false, error: 'action must be files or content' };
            // A relative path is resolved against the primary root; an absolute path
            // may point into any project directory. Without a path every root is walked.
            let searchRoots: Array<{ root: string; dir: string }>;
            if (requested) {
                const candidate = resolve(isAbsolute(requested) ? requested : resolve(primaryRoot, requested));
                const owner = allRoots.find(dir => isPathWithinBoundary(candidate, dir));
                if (!owner) return { success: false, error: 'Search path is outside the active workspace.' };
                searchRoots = [{ root: owner, dir: candidate }];
            } else {
                searchRoots = allRoots.map(dir => ({ root: dir, dir }));
            }

            const results: Array<Record<string, unknown>> = [];
            let visited = 0;
            const namePattern = action === 'files' ? wildcard(query) : undefined;
            const lowerQuery = query.toLocaleLowerCase();

            let root = primaryRoot;
            const walk = async (directory: string): Promise<void> => {
                if (results.length >= maxResults || visited >= 5000) return;
                context?.abortSignal?.throwIfAborted();
                const entries = await readdir(directory, { withFileTypes: true });
                for (const entry of entries) {
                    if (results.length >= maxResults || visited >= 5000) break;
                    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
                    const fullPath = resolve(directory, entry.name);
                    if (entry.isDirectory()) {
                        await walk(fullPath);
                        continue;
                    }
                    if (!entry.isFile()) continue;
                    visited++;
                    // Files outside the primary root are reported with an absolute
                    // path so the agent can address them without guessing the root.
                    const relativePath = root === primaryRoot
                        ? relative(root, fullPath).replace(/\\/g, '/')
                        : fullPath;
                    if (action === 'files') {
                        if (namePattern!.test(entry.name) || namePattern!.test(relativePath)) results.push({ path: relativePath });
                        continue;
                    }
                    if (!TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
                    const info = await stat(fullPath);
                    if (info.size > 1024 * 1024) continue;
                    const content = await readFile(fullPath, 'utf8');
                    const lines = content.split(/\r?\n/);
                    for (let index = 0; index < lines.length && results.length < maxResults; index++) {
                        if (!lines[index].toLocaleLowerCase().includes(lowerQuery)) continue;
                        results.push({ path: relativePath, line: index + 1, text: lines[index].trim().slice(0, 500) });
                    }
                }
            };

            try {
                for (const target of searchRoots) {
                    root = target.root;
                    await walk(target.dir);
                }
                return {
                    success: true,
                    data: {
                        root: primaryRoot,
                        ...(allRoots.length > 1 ? { extraRoots: allRoots.slice(1) } : {}),
                        query,
                        results,
                        truncated: results.length >= maxResults || visited >= 5000,
                    },
                };
            } catch (error) {
                return { success: false, error: error instanceof Error ? error.message : String(error) };
            }
        },
    };
}
