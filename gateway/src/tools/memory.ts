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
        description: '【CRITICAL】长期记忆工具。当用户提供**个人信息、偏好、配置、计划**等重要内容时，**必须立即调用**此工具保存(action="save")。当用户询问"我以前说过..."或需要上下文时，**必须调用**此工具搜索(action="search")。不要只在回复中确认，必须实际执行保存操作！',
        parameters: {
            action: {
                type: 'string',
                description: '操作类型: "save" (保存记忆) 或 "search" (搜索记忆)',
                enum: ['save', 'search'],
                required: true,
            },
            content: {
                type: 'string',
                description: '对于 save 操作，为要保存的记忆内容；对于 search 操作，为搜索关键词',
                required: true,
            },
            tags: {
                type: 'string',
                description: '对于 save 操作，可选的标签列表（逗号分隔），如 "user_profile,preference"',
                required: false,
            }
        },
        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
            const action = args.action as string;
            const content = args.content as string;

            if (!content) {
                return { success: false, error: '缺少内容 (content)' };
            }

            try {
                if (action === 'save') {
                    const tags = args.tags ? (args.tags as string).split(',').map(t => t.trim()) : undefined;
                    await memoryManager.add(content, { tags });
                    return { success: true, data: `已保存记忆: "${content}"` };
                } else if (action === 'search') {
                    const results = await memoryManager.search(content, { limit: 5, includeSource: true });

                    if (results.length === 0) {
                        return { success: true, data: '未找到相关记忆' };
                    }

                    const formatted = results.map((r, i) => {
                        const source = r.sourceFile ? `[来源: ${r.sourceFile}]` : '';
                        const date = new Date(r.createdAt).toLocaleDateString();
                        return `${i + 1}. ${r.content} ${source} (时间: ${date}, 相关度: ${r.score.toFixed(2)})`;
                    }).join('\n');

                    return { success: true, data: `找到以下相关记忆:\n${formatted}` };
                } else {
                    return { success: false, error: `不支持的操作: ${action}` };
                }
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                return { success: false, error: `记忆操作失败: ${msg}` };
            }
        },
    };
}
