import { Tool, ToolExecutionContext, ToolResult } from './types';
import { MemoryManager } from '../agent/memory/manager';
import { redactSecrets } from '../security/redaction';

export interface MemoryToolOptions {
    memoryManager: MemoryManager;
}

/**
 * Create a memory tool
 */
export function createMemoryTool(options: MemoryToolOptions): Tool {
    const { memoryManager } = options;

    return {
        name: 'memory_tool',
        priority: 25,
        description: 'Long-term memory for durable, non-sensitive user facts, preferences, plans and project constraints. Never save passwords, API keys, access tokens, cookies, private keys or other credentials; this memory is not a secrets vault. Use save only for safe durable information, search for relevant prior context, and list for a broad memory overview.',
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
        execute: async (args: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> => {
            const action = args.action as string;
            const content = args.content as string;

            try {
                context?.abortSignal?.throwIfAborted();
                if (action === 'save') {
                    if (!content) {
                        return { success: false, error: 'Missing content parameter' };
                    }
                    const inspected = redactSecrets(content);
                    if (inspected.findings.length > 0) {
                        return {
                            success: false,
                            error: 'Sensitive credentials cannot be stored in long-term memory. Remove passwords, tokens, API keys, cookies, and private keys before saving.',
                        };
                    }
                    const tags = args.tags ? (args.tags as string).split(',').map(t => t.trim()) : undefined;
                    await memoryManager.add(content, { tags });
                    context?.abortSignal?.throwIfAborted();
                    return { success: true, data: { saved: true } };
                } else if (action === 'search') {
                    if (!content) {
                        return { success: false, error: 'Missing content parameter for search' };
                    }
                    const results = await memoryManager.search(content, { limit: 5, includeSource: true });
                    context?.abortSignal?.throwIfAborted();

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

