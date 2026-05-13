/**
 * sessions_search 工具 - 全文搜索对话历史
 *
 * 解决的问题：用户提到"之前聊过的..."时，相关内容可能超出当前
 * 200 条上下文窗口。本工具直接扫描 JSONL 文件，按关键词匹配
 * 历史消息，让 Agent 可以找回任意时间段的对话内容。
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
 * 从 JSONL 文件中搜索包含关键词的消息
 * 支持从尾部向前扫描，并可限制返回条数
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

    // 读取整个文件（搜索场景无法避免全文读取）
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

            // 提取包含关键词的片段（前后各 contextLines 个字符）
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
            // 跳过损坏行
        }
    }

    return results;
}

/**
 * 创建 sessions_search 工具
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

                // 获取 JSONL 文件路径
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

                // 按时间排序（最早的先，便于 LLM 理解时序）
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
