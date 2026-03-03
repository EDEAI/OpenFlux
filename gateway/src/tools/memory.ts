import { Tool, ToolResult } from './types';
import { MemoryManager } from '../agent/memory/manager';

export interface MemoryToolOptions {
    memoryManager: MemoryManager;
}

/**
 * 创建记忆工具
 */
export function createMemoryTool(options: MemoryToolOptions): Tool {
    const { memoryManager } = options;

    return {
        name: 'memory_tool',
        description: '[CRITICAL] Long-term memory tool. When the user provides **personal info, preferences, configurations, plans** or other important content, you **MUST immediately call** this tool to save (action="save"). When the user asks "I previously said..." or needs context, you **MUST call** this tool to search (action="search"). When the user asks "what do you know about me" or similar broad questions, use action="list" to show all saved memories. Do not just acknowledge in your reply, you MUST actually execute the save operation!',
        parameters: {
            action: {
                type: 'string',
                description: 'Action type: "save" (save memory), "search" (search memory), or "list" (list all memories)',
                enum: ['save', 'search', 'list'],
                required: true,
            },
            content: {
                type: 'string',
                description: 'For save: the memory content to save; for search: the search keyword; for list: not required',
                required: false,
            },
            tags: {
                type: 'string',
                description: 'For save: optional tag list (comma-separated), e.g., "user_profile,preference"',
                required: false,
            }
        },
        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
            const action = args.action as string;
            const content = args.content as string;

            try {
                if (action === 'save') {
                    if (!content) {
                        return { success: false, error: 'Missing content parameter' };
                    }
                    const tags = args.tags ? (args.tags as string).split(',').map(t => t.trim()) : undefined;
                    await memoryManager.add(content, { tags });
                    return { success: true, data: `Memory saved: "${content}"` };
                } else if (action === 'search') {
                    if (!content) {
                        return { success: false, error: 'Missing content parameter for search' };
                    }
                    const results = await memoryManager.search(content, { limit: 5, includeSource: true });

                    if (results.length === 0) {
                        return { success: true, data: 'No relevant memories found' };
                    }

                    const formatted = results.map((r, i) => {
                        const source = r.sourceFile ? `[source: ${r.sourceFile}]` : '';
                        const date = new Date(r.createdAt).toLocaleDateString();
                        return `${i + 1}. ${r.content} ${source} (date: ${date}, relevance: ${r.score.toFixed(2)})`;
                    }).join('\n');

                    return { success: true, data: `Found related memories:\n${formatted}` };
                } else if (action === 'list') {
                    const { items, total } = memoryManager.list(1, 20);

                    if (total === 0) {
                        return { success: true, data: 'No memories saved yet.' };
                    }

                    const formatted = items.map((item, i) => {
                        const tags = item.tags?.length ? ` [tags: ${item.tags.join(', ')}]` : '';
                        const date = new Date(item.createdAt).toLocaleDateString();
                        return `${i + 1}. ${item.content}${tags} (date: ${date})`;
                    }).join('\n');

                    return { success: true, data: `All saved memories (${total} total):\n${formatted}` };
                } else {
                    return { success: false, error: `Unsupported action: ${action}` };
                }
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                return { success: false, error: `Memory operation failed: ${msg}` };
            }
        },
    };
}

