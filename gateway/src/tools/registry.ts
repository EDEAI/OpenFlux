/**
 * 工具注册表 - 工厂模式重构版
 * 参考 Clawdbot 设计
 */

import type { AnyTool, Tool, ToolResult } from './types';
import type { LLMToolDefinition } from '../llm/provider';
import { createFileSystemTool, type FileSystemToolOptions } from './filesystem';
import { createProcessTool, type ProcessToolOptions } from './process';
import { createBrowserTool, type BrowserToolOptions } from './browser';
import { createOpenCodeTool, type OpenCodeToolOptions } from './opencode';
import { createWindowsTool, type WindowsToolOptions } from './windows';
import { createMacOSTool, type MacOSToolOptions } from './macos';
import { createWorkflowTool, type WorkflowToolOptions } from './workflow';
import { createSchedulerTool, type SchedulerToolOptions } from './scheduler';
import { createDesktopTool, type DesktopToolOptions } from './desktop';
import { createWebSearchTool, type WebSearchToolOptions } from './web-search';
import { createWebFetchTool, type WebFetchToolOptions } from './web-fetch';
import { createMemoryTool, type MemoryToolOptions } from './memory';
import { createOfficeTool, type OfficeToolOptions } from './office';
import { createEmailTool, type EmailToolOptions } from './email';
import type { AgentToolsConfig, SubAgentToolsConfig } from './policy';
import { resolveToolsForAgent } from './policy';
import { Logger } from '../utils/logger';

export interface ToolRegistryOptions {
    /** 文件系统工具配置 */
    filesystem?: FileSystemToolOptions;
    /** 进程工具配置 */
    process?: ProcessToolOptions;
    /** 浏览器工具配置 */
    browser?: BrowserToolOptions;
    /** OpenCode 工具配置 */
    opencode?: OpenCodeToolOptions;
    /** Windows 工具配置 */
    windows?: WindowsToolOptions;
    /** macOS 工具配置 */
    macos?: MacOSToolOptions;
    /** 工作流工具配置 */
    workflow?: WorkflowToolOptions;
    /** 调度器工具配置 */
    scheduler?: SchedulerToolOptions;
    /** 桌面控制工具配置 */
    desktop?: DesktopToolOptions;
    /** Web 搜索工具配置 */
    webSearch?: WebSearchToolOptions;
    /** Web 页面获取工具配置 */
    webFetch?: WebFetchToolOptions;
    /** 记忆工具配置 */
    memory?: MemoryToolOptions;
    /** Office 文档处理工具配置 */
    office?: OfficeToolOptions;
    /** 邮件工具配置 */
    email?: EmailToolOptions;
}

/**
 * 工具注册表
 */
export class ToolRegistry {
    private tools: Map<string, Tool> = new Map();
    private logger = new Logger('ToolRegistry');

    constructor() { }

    /**
     * 注册工具
     */
    register(tool: Tool): void {
        // 工具声明了 available: false 则跳过注册（前置条件不满足，如 API Key 缺失）
        if (tool.available === false) {
            this.logger.warn(`Tool skipped (prerequisite not met): ${tool.name}`);
            return;
        }
        if (this.tools.has(tool.name)) {
            this.logger.warn(`Tool already exists, will be overridden: ${tool.name}`);
        }
        this.tools.set(tool.name, tool);
        this.logger.debug(`Tool registered: ${tool.name}`);
    }

    /**
     * 移除工具（用于 MCP 热重载等场景）
     */
    unregister(name: string): boolean {
        const removed = this.tools.delete(name);
        if (removed) {
            this.logger.debug(`Tool removed: ${name}`);
        }
        return removed;
    }

    /**
     * 获取工具
     */
    getTool(name: string): Tool | undefined {
        return this.tools.get(name);
    }

    /**
     * 获取所有工具
     */
    getAllTools(): Tool[] {
        return Array.from(this.tools.values());
    }

    /**
     * 获取工具名称列表
     */
    getToolNames(): string[] {
        return Array.from(this.tools.keys());
    }

    /**
     * 执行工具
     */
    async executeTool(name: string, args: Record<string, unknown>, context?: import('./types').ToolExecutionContext): Promise<ToolResult> {
        const tool = this.getTool(name);
        if (!tool) {
            return { success: false, error: `Tool not found: ${name}` };
        }

        // 不在这里输出日志，由调用方（AgentLoop）负责日志

        try {
            const result = await tool.execute(args, context);
            this.logger.debug(`Tool execution complete: ${name}`, { success: result.success });
            return result;
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.logger.error(`Tool execution failed: ${name}`, { error: errorMsg });
            return { success: false, error: errorMsg };
        }
    }

    /**
     * 注册默认工具（使用工厂模式）
     */
    registerDefaults(options: ToolRegistryOptions = {}): void {
        // 文件系统工具
        this.register(createFileSystemTool(options.filesystem));

        // 进程工具
        this.register(createProcessTool(options.process));

        // 浏览器工具
        this.register(createBrowserTool(options.browser));

        // OpenCode 工具
        this.register(createOpenCodeTool(options.opencode));

        // 平台工具（互斥注册）
        if (process.platform === 'win32') {
            this.register(createWindowsTool(options.windows));
        } else if (process.platform === 'darwin') {
            this.register(createMacOSTool(options.macos));
        }

        // 工作流工具（需要 engine 实例，若未提供则跳过）
        if (options.workflow) {
            this.register(createWorkflowTool(options.workflow));
        }

        // 调度器工具（需要 scheduler 实例，若未提供则跳过）
        if (options.scheduler) {
            this.register(createSchedulerTool(options.scheduler));
        }

        // 桌面控制工具（Windows: keysender, macOS: AppleScript）
        if (process.platform === 'win32' || process.platform === 'darwin') {
            this.register(createDesktopTool(options.desktop));
        }

        // Web 搜索工具（工厂函数通过 available 属性声明是否可用）
        this.register(createWebSearchTool(options.webSearch));

        // Web 页面获取工具
        this.register(createWebFetchTool(options.webFetch));

        // 记忆工具
        if (options.memory) {
            this.register(createMemoryTool(options.memory));
        }

        // Office 文档处理工具
        this.register(createOfficeTool(options.office));

        // 邮件工具
        this.register(createEmailTool(options.email));

        this.logger.info(`Default tools registered, total ${this.tools.size} tools`);
    }

    /**
     * 按策略过滤，返回新的 ToolRegistry 实例（不修改原实例）
     *
     * @param agentTools Agent 工具配置（profile + allow/deny）
     * @param isSubAgent 是否为子 Agent
     * @param subAgentConfig 子 Agent 工具配置
     */
    filter(
        agentTools?: AgentToolsConfig,
        isSubAgent?: boolean,
        subAgentConfig?: SubAgentToolsConfig
    ): ToolRegistry {
        const allTools = this.getAllTools();
        const filtered = resolveToolsForAgent(allTools, agentTools, isSubAgent, subAgentConfig);

        const newRegistry = new ToolRegistry();
        for (const tool of filtered) {
            newRegistry.register(tool);
        }

        this.logger.info(
            `Tool filtering: ${allTools.length} → ${filtered.length}` +
            (agentTools?.profile ? ` (profile: ${agentTools.profile})` : '')
        );

        return newRegistry;
    }

    /**
     * 生成工具描述（用于 LLM）
     */
    generateToolDescriptions(): string {
        const descriptions: string[] = [];

        for (const tool of this.tools.values()) {
            const paramList = Object.entries(tool.parameters)
                .map(([key, param]) => {
                    const required = param.required ? '(required)' : '(optional)';
                    return `  - ${key}: ${param.description} ${required}`;
                })
                .join('\n');

            descriptions.push(`## ${tool.name}\n${tool.description}\nParameters:\n${paramList}`);
        }

        return descriptions.join('\n\n');
    }

    /**
     * 转换为统一的 LLM 工具定义格式
     * 各 Provider 内部再转换为自身 API 所需的具体格式
     */
    toLLMToolDefinitions(): LLMToolDefinition[] {
        return this.getAllTools().map(tool => {
            // MCP 工具：直接使用原始 JSON Schema，避免 ToolParameter 转换丢失 items/anyOf 等复杂结构
            if (tool.rawInputSchema) {
                return {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.rawInputSchema as LLMToolDefinition['parameters'],
                };
            }

            // 内置工具：从 ToolParameter 构建
            return {
                name: tool.name,
                description: tool.description,
                parameters: {
                    type: 'object' as const,
                    properties: Object.fromEntries(
                        Object.entries(tool.parameters).map(([key, param]) => [
                            key,
                            {
                                type: param.type,
                                description: param.description,
                                ...(param.enum ? { enum: param.enum } : {}),
                                ...(param.default !== undefined ? { default: param.default } : {}),
                                ...(param.items ? { items: param.items } : {}),
                            },
                        ])
                    ),
                    required: Object.entries(tool.parameters)
                        .filter(([, param]) => param.required)
                        .map(([key]) => key),
                },
            };
        });
    }

    /**
     * 转换为 OpenAI 工具格式（保留向后兼容）
     */
    toOpenAITools(): Array<{
        type: 'function';
        function: {
            name: string;
            description: string;
            parameters: {
                type: 'object';
                properties: Record<string, unknown>;
                required: string[];
            };
        };
    }> {
        return this.getAllTools().map((tool) => ({
            type: 'function' as const,
            function: {
                name: tool.name,
                description: tool.description,
                parameters: {
                    type: 'object' as const,
                    properties: Object.fromEntries(
                        Object.entries(tool.parameters).map(([key, param]) => [
                            key,
                            {
                                type: param.type,
                                description: param.description,
                                enum: param.enum,
                                default: param.default,
                            },
                        ])
                    ),
                    required: Object.entries(tool.parameters)
                        .filter(([, param]) => param.required)
                        .map(([key]) => key),
                },
            },
        }));
    }
}

// 导出工厂函数
export { createFileSystemTool } from './filesystem';
export { createProcessTool } from './process';
export { createBrowserTool } from './browser';
export { createOpenCodeTool } from './opencode';
export { createSpawnTool } from './spawn';
export { createWorkflowTool } from './workflow';
export { createSchedulerTool } from './scheduler';
export { createDesktopTool } from './desktop';
export { createWebSearchTool } from './web-search';
export { createWebFetchTool } from './web-fetch';

// 导出类型
export type { Tool, ToolResult, ToolParameter, AnyTool } from './types';
export type { FileSystemToolOptions } from './filesystem';
export type { ProcessToolOptions } from './process';
export type { BrowserToolOptions } from './browser';
export type { OpenCodeToolOptions } from './opencode';
export type { SpawnToolOptions, SpawnParams, SpawnResult } from './spawn';
export type { WorkflowToolOptions } from './workflow';
export type { SchedulerToolOptions } from './scheduler';
export type { DesktopToolOptions } from './desktop';
export type { WebSearchToolOptions } from './web-search';
export type { WebFetchToolOptions } from './web-fetch';
export type { MemoryToolOptions } from './memory';

