/**
 * MCP 客户端管理器
 * 连接外部 MCP Server，将其工具转换为标准 Tool 接口注册到 ToolRegistry
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Tool, ToolResult, ToolParameter } from './types';
import { Logger } from '../utils/logger';

const log = new Logger('McpClient');

// ========================
// 类型定义
// ========================

/** MCP Server 配置（与 config/schema.ts 中的 McpServerConfigSchema 对应） */
export interface McpServerConfig {
    /** 服务名称（唯一标识） */
    name: string;
    /** 执行位置: server（Gateway 端）或 client（客户端本机） */
    location?: 'server' | 'client';
    /** 传输方式 */
    transport: 'stdio' | 'sse';
    /** stdio 模式：启动命令 */
    command?: string;
    /** stdio 模式：命令参数 */
    args?: string[];
    /** stdio 模式：环境变量 */
    env?: Record<string, string>;
    /** SSE 模式：服务器 URL */
    url?: string;
    /** 是否启用 */
    enabled?: boolean;
    /** 连接超时（秒，默认 30） */
    timeout?: number;
}

/** 已连接的 MCP Server */
interface ConnectedServer {
    name: string;
    client: Client;
    transport: StdioClientTransport | SSEClientTransport;
    tools: Tool[];
}

// ========================
// 工具转换
// ========================

/**
 * 将 MCP 工具的 JSON Schema 参数转换为 ToolParameter 格式
 */
function convertJsonSchemaToParams(
    inputSchema: Record<string, unknown> | undefined
): Record<string, ToolParameter> {
    const params: Record<string, ToolParameter> = {};
    if (!inputSchema) return params;

    const properties = (inputSchema.properties || {}) as Record<string, Record<string, unknown>>;
    const required = (inputSchema.required || []) as string[];

    for (const [key, prop] of Object.entries(properties)) {
        const type = (prop.type as string) || 'string';
        params[key] = {
            type: mapJsonSchemaType(type),
            description: (prop.description as string) || key,
            required: required.includes(key),
        };

        if (prop.enum) {
            params[key].enum = prop.enum as string[];
        }
        if (prop.default !== undefined) {
            params[key].default = prop.default;
        }
    }

    return params;
}

/**
 * 映射 JSON Schema 类型到 ToolParameter 类型
 */
function mapJsonSchemaType(type: string): ToolParameter['type'] {
    switch (type) {
        case 'integer':
            return 'number';
        case 'boolean':
            return 'boolean';
        case 'array':
            return 'array';
        case 'object':
            return 'object';
        default:
            return 'string';
    }
}

// ========================
// McpClientManager
// ========================

export class McpClientManager {
    private servers: Map<string, ConnectedServer> = new Map();

    /**
     * 初始化：连接所有配置的 MCP Server
     */
    async initialize(configs: McpServerConfig[]): Promise<void> {
        const enabledConfigs = configs.filter(c => c.enabled !== false);
        if (enabledConfigs.length === 0) {
            log.info('无已启用的 MCP Server 配置');
            return;
        }

        log.info(`准备连接 ${enabledConfigs.length} 个 MCP Server...`);

        // 并行连接所有 Server（单个失败不影响其他）
        const results = await Promise.allSettled(
            enabledConfigs.map(config => this.connectServer(config))
        );

        let successCount = 0;
        for (let i = 0; i < results.length; i++) {
            const result = results[i];
            const config = enabledConfigs[i];
            if (result.status === 'fulfilled') {
                successCount++;
            } else {
                log.error(`MCP Server "${config.name}" 连接失败:`, { error: result.reason?.message || result.reason });
            }
        }

        log.info(`MCP Server 连接完成: ${successCount}/${enabledConfigs.length} 成功`);
    }

    /**
     * 连接单个 MCP Server
     */
    private async connectServer(config: McpServerConfig): Promise<void> {
        log.info(`连接 MCP Server: ${config.name} (${config.transport})`);

        const client = new Client({
            name: `OpenFlux-${config.name}`,
            version: '1.0.0',
        });

        let transport: StdioClientTransport | SSEClientTransport;

        if (config.transport === 'stdio') {
            if (!config.command) {
                throw new Error(`MCP Server "${config.name}" stdio 模式缺少 command 配置`);
            }
            transport = new StdioClientTransport({
                command: config.command,
                args: config.args || [],
                env: {
                    ...process.env as Record<string, string>,
                    ...(config.env || {}),
                },
            });
        } else if (config.transport === 'sse') {
            if (!config.url) {
                throw new Error(`MCP Server "${config.name}" SSE 模式缺少 url 配置`);
            }
            transport = new SSEClientTransport(new URL(config.url));
        } else {
            throw new Error(`MCP Server "${config.name}" 不支持的传输方式: ${config.transport}`);
        }

        // 连接（带超时）
        const timeout = (config.timeout || 30) * 1000;
        const connectPromise = client.connect(transport);
        const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`连接超时 (${config.timeout || 30}s)`)), timeout)
        );

        await Promise.race([connectPromise, timeoutPromise]);
        log.info(`MCP Server "${config.name}" 已连接`);

        // 获取工具列表
        const toolsResult = await client.listTools();
        const mcpTools = toolsResult.tools || [];
        log.info(`MCP Server "${config.name}" 提供 ${mcpTools.length} 个工具`);

        // 转换为标准 Tool 接口
        const tools: Tool[] = mcpTools.map(mcpTool => {
            const toolName = `mcp_${config.name}_${mcpTool.name}`;
            const params = convertJsonSchemaToParams(mcpTool.inputSchema as Record<string, unknown>);

            return {
                name: toolName,
                description: `[MCP:${config.name}] ${mcpTool.description || mcpTool.name}`,
                parameters: params,
                execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
                    try {
                        const result = await client.callTool({
                            name: mcpTool.name,
                            arguments: args,
                        });

                        // 解析 MCP 工具结果
                        const content = result.content;
                        if (Array.isArray(content) && content.length > 0) {
                            // 提取文本内容
                            const textParts = content
                                .filter((c: any) => c.type === 'text')
                                .map((c: any) => c.text);
                            const data = textParts.join('\n');

                            return {
                                success: !result.isError,
                                data: data || JSON.stringify(content),
                                ...(result.isError ? { error: data } : {}),
                            };
                        }

                        return {
                            success: !result.isError,
                            data: JSON.stringify(content),
                        };
                    } catch (error) {
                        const errorMsg = error instanceof Error ? error.message : String(error);
                        log.error(`MCP 工具 "${toolName}" 执行失败:`, { error: errorMsg });
                        return { success: false, error: errorMsg };
                    }
                },
            };
        });

        this.servers.set(config.name, {
            name: config.name,
            client,
            transport,
            tools,
        });

        log.info(`MCP Server "${config.name}" 工具已转换: ${tools.map(t => t.name).join(', ')}`);
    }

    /**
     * 获取所有已连接 MCP Server 的工具
     */
    getTools(): Tool[] {
        const allTools: Tool[] = [];
        for (const server of this.servers.values()) {
            allTools.push(...server.tools);
        }
        return allTools;
    }

    /**
     * 获取已连接的 MCP Server 信息
     */
    getServerInfo(): Array<{ name: string; toolCount: number }> {
        return Array.from(this.servers.values()).map(s => ({
            name: s.name,
            toolCount: s.tools.length,
        }));
    }

    /**
     * 关闭所有连接和子进程
     */
    async shutdown(): Promise<void> {
        log.info(`关闭 ${this.servers.size} 个 MCP Server 连接...`);

        const shutdownPromises = Array.from(this.servers.values()).map(async (server) => {
            try {
                await server.client.close();
                log.info(`MCP Server "${server.name}" 已关闭`);
            } catch (error) {
                log.warn(`MCP Server "${server.name}" 关闭时出错:`, { error });
            }
        });

        await Promise.allSettled(shutdownPromises);
        this.servers.clear();
        log.info('所有 MCP Server 连接已关闭');
    }
}
