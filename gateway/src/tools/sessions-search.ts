/**
 * sessions_search tool - Full text search of conversation history
 *
 * Problem solved: when users mention "something discussed before...", the related content may exceed the current
 * 200 context windows. This tool directly scans JSONL files and matches them by keywords
 * Historical messages allow the Agent to retrieve conversation content at any time period.
 */

import type { Tool, ToolResult, ToolParameter } from './types';
import { jsonResult, errorResult, readStringParam, readNumberParam } from './common';
import type { SessionStore } from '../sessions/store';
import { getSessionFilePath } from '../sessions/transcript';
import { existsSync, openSync, fstatSync, readSync, closeSync, readFileSync } from 'fs';
import type { SessionEntry } from '../sessions/types';
import { Logger } from '../utils/logger';

const log = new Logger('SessionsSearch');

export interface SessionsSearchToolOptions {
    sessions: SessionStore;
}

/**
 * Search JSONL files for messages containing keywords
 * Supports scanning forward from the tail and can limit the number of returned items
 */
function searchSessionMessages(
    filePath: string,
    query: string,
    maxResults: number,
    contextLines: number,
): Array<{
    role: string;
    content: string;
    createdAt: number;
    snippet: string;
}> {
    if (!existsSync(filePath)) return [];

    const queryLower = query.toLowerCase();
    const results: Array<{ role: string; content: string; createdAt: number; snippet: string }> = [];

    // Read the entire file (full text reading cannot be avoided in search scenarios)
    let raw: string;
    try {
        raw = readFileSync(filePath, 'utf-8');
    } catch {
        return [];
    }

    const lines = raw.split(/\r?\n/).filter(l => l.trim());

    for (const line of lines) {
        if (results.length >= maxResults) break;
        try {
            const entry = JSON.parse(line) as SessionEntry;
            const msg = entry.message;
            if (!msg) continue;

            const contentStr =
                typeof msg.content === 'string'
                    ? msg.content
                    : (msg.content as any[])
                          .map((b: any) => b.text || b.result || '')
                          .join(' ');

            if (!contentStr.toLowerCase().includes(queryLower)) continue;

            // Extract the fragment containing the keyword (contextLines characters before and after)
            const idx = contentStr.toLowerCase().indexOf(queryLower);
            const start = Math.max(0, idx - contextLines);
            const end = Math.min(contentStr.length, idx + query.length + contextLines);
            const snippet =
                (start > 0 ? '...' : '') +
                contentStr.slice(start, end) +
                (end < contentStr.length ? '...' : '');

            results.push({
                role: msg.role,
                content: contentStr.length > 500 ? contentStr.slice(0, 500) + '...' : contentStr,
                createdAt: msg.createdAt,
                snippet,
            });
        } catch {
            // Skip corrupted rows
        }
    }

    return results;
}

/**
 * Create sessions_search tool
 */
export function createSessionsSearchTool(options: SessionsSearchToolOptions): Tool {
    const { sessions } = options;

    const parameters: Record<string, ToolParameter> = {
        query: {
            type: 'string',
            description: 'Keyword or phrase to search for in conversation history',
            required: true,
        },
        sessionId: {
            type: 'string',
            description:
                'Session ID to search in. Defaults to the current session (user-agent:main). ' +
                'Use sessions_send action=list to see all session IDs.',
            required: false,
        },
        maxResults: {
            type: 'number',
            description: 'Maximum number of matching messages to return (default: 20)',
            required: false,
            default: 20,
        },
        contextChars: {
            type: 'number',
            description: 'Characters of context around the match to include in snippet (default: 150)',
            required: false,
            default: 150,
        },
    };

    return {
        name: 'sessions_search',
        priority: 42,
        description: [
            'Search the full conversation history (JSONL) for a keyword or phrase.',
            'Use this when the user says "before / previously / earlier you found..." or asks about past conversations.',
            'Unlike memory_tool which uses vector similarity, this does exact keyword matching across ALL historical messages.',
            'Returns matching messages with surrounding context snippets.',
            '',
            'Example use cases:',
            '- User: "继续之前aitmed的合作" → sessions_search(query="aitmed")',
            '- User: "上次那份合同里..." → sessions_search(query="合同")',
            '- User: "你之前找到的那个链接" → sessions_search(query="http")',
        ].join('\n'),
        parameters,

        async execute(args: Record<string, unknown>): Promise<ToolResult> {
            try {
                const query = readStringParam(args, 'query', { required: true });
                const sessionId = readStringParam(args, 'sessionId') || 'user-agent:main';
                const maxResults = readNumberParam(args, 'maxResults') || 20;
                const contextChars = readNumberParam(args, 'contextChars') || 150;

                log.info('sessions_search', { query, sessionId, maxResults });

                // Get JSONL file path
                const storePath = (sessions as any).config?.storePath;
                const filePath = getSessionFilePath(sessionId, storePath);

                if (!existsSync(filePath)) {
                    return jsonResult({
                        found: 0,
                        message: `Session "${sessionId}" has no conversation history file.`,
                        results: [],
                    });
                }

                const matches = searchSessionMessages(filePath, query, maxResults, contextChars);

                if (matches.length === 0) {
                    return jsonResult({
                        found: 0,
                        message: `No messages containing "${query}" found in session "${sessionId}".`,
                        results: [],
                    });
                }

                // Sort by time (oldest first, easier for LLM to understand timing)
                matches.sort((a, b) => a.createdAt - b.createdAt);

                return jsonResult({
                    found: matches.length,
                    query,
                    sessionId,
                    results: matches.map(m => ({
                        role: m.role,
                        time: new Date(m.createdAt).toLocaleString('zh-CN', {
                            timeZone: 'Asia/Shanghai',
                            year: 'numeric',
                            month: '2-digit',
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                        }),
                        snippet: m.snippet,
                        fullContent: m.content,
                    })),
                });
            } catch (error) {
                return errorResult(error instanceof Error ? error.message : String(error));
            }
        },
    };
}
