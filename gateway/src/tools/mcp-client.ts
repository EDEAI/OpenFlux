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
            log.info('No enabled MCP Server config found');
            return;
        }

        log.info(`Connecting to ${enabledConfigs.length} MCP Servers...`);

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
                log.error(`MCP Server "${config.name}" connection failed:`, { error: result.reason?.message || result.reason });
            }
        }

        log.info(`MCP Server connection complete: ${successCount}/${enabledConfigs.length} succeeded`);
    }

    /**
     * 连接单个 MCP Server
     */
    private async connectServer(config: McpServerConfig): Promise<void> {
        log.info(`Connecting MCP Server: ${config.name} (${config.transport})`);

        const client = new Client({
            name: `OpenFlux-${config.name}`,
            version: '1.0.0',
        });

        let transport: StdioClientTransport | SSEClientTransport;

        if (config.transport === 'stdio') {
            if (!config.command) {
                throw new Error(`MCP Server "${config.name}" stdio mode missing command configuration`);
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
                throw new Error(`MCP Server "${config.name}" SSE mode missing url configuration`);
            }
            transport = new SSEClientTransport(new URL(config.url));
        } else {
            throw new Error(`MCP Server "${config.name}" unsupported transport: ${config.transport}`);
        }

        // 连接（带超时）
        const timeout = (config.timeout || 30) * 1000;
        const connectPromise = client.connect(transport);
        const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Connection timeout (${config.timeout || 30}s)`)), timeout)
        );

        await Promise.race([connectPromise, timeoutPromise]);
        log.info(`MCP Server "${config.name}" connected`);

        // 获取工具列表
        const toolsResult = await client.listTools();
        const mcpTools = toolsResult.tools || [];
        log.info(`MCP Server "${config.name}" provides ${mcpTools.length} tools`);

        // 转换为标准 Tool 接口
        const tools: Tool[] = mcpTools.map(mcpTool => {
            const toolName = `mcp_${config.name}_${mcpTool.name}`;
            const params = convertJsonSchemaToParams(mcpTool.inputSchema as Record<string, unknown>);

            return {
                name: toolName,
                description: `[MCP:${config.name}] ${mcpTool.description || mcpTool.name}`,
                parameters: params,
                // 保留 MCP 原始 JSON Schema，避免 ToolParameter 转换丢失 items/anyOf 等复杂结构
                rawInputSchema: mcpTool.inputSchema as Record<string, unknown> | undefined,
                execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
                    try {
                        // 提取工具参数中的 timeout（秒），用于长时操作（如 pip install）
                        const toolTimeout = Math.min(
                            Number(args.timeout) || 60,
                            600 // 上限 10 分钟
                        ) * 1000;

                        const result = await client.callTool({
                            name: mcpTool.name,
                            arguments: args,
                        }, undefined, {
                            timeout: toolTimeout,
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
                        log.error(`MCP tool "${toolName}" execution failed:`, { error: errorMsg });

                        // 增强常见错误提示，帮助 LLM 自动纠正
                        let enhancedError = errorMsg;
                        if (errorMsg.includes('Either loc or label must be provided')) {
                            enhancedError = `${errorMsg}. You MUST provide either "loc" (e.g. [x, y] coordinates from a previous Snapshot) or "label" (UI element text) to specify WHERE to type/click. First use Snapshot to see the screen, then use the coordinates or element labels from the snapshot.`;
                        } else if (errorMsg.includes('loc') && errorMsg.includes('validation error')) {
                            enhancedError = `${errorMsg}. The "loc" parameter must be an array of two integers [x, y], e.g. [260, 50]. Get coordinates from a Snapshot first.`;
                        }

                        return { success: false, error: enhancedError };
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

        log.info(`MCP Server "${config.name}" tools converted: ${tools.map(t => t.name).join(', ')}`);
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
        log.info(`Closing ${this.servers.size} MCP Server connections...`);

        const shutdownPromises = Array.from(this.servers.values()).map(async (server) => {
            try {
                await server.client.close();
                log.info(`MCP Server "${server.name}" closed`);
            } catch (error) {
                log.warn(`MCP Server "${server.name}" error during close:`, { error });
            }
        });

        await Promise.allSettled(shutdownPromises);
        this.servers.clear();
        log.info('All MCP Server connections closed');
    }
}
