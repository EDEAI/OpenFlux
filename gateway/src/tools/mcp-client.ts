/**
 * MCP Client Manager
 * Connect to the external MCP Server, convert its tools into standard Tool interfaces and register them in ToolRegistry
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Tool, ToolResult, ToolParameter } from './types';
import { Logger } from '../utils/logger';

const log = new Logger('McpClient');

// ========================
// type definition
// ========================

/** MCP Server configuration (corresponding to McpServerConfigSchema in config/schema.ts) */
export interface McpServerConfig {
    /** Service name (unique identifier) */
    name: string;
    /** Execution location: server (Gateway side) or client (client local machine) */
    location?: 'server' | 'client';
    /** Transmission method */
    transport: 'stdio' | 'sse';
    /** stdio mode: start command */
    command?: string;
    /** stdio mode: command parameters */
    args?: string[];
    /** stdio mode: environment variables */
    env?: Record<string, string>;
    /** SSE mode: Server URL */
    url?: string;
    /** Whether to enable */
    enabled?: boolean;
    /** Connection timeout (seconds, default 30) */
    timeout?: number;
}

/** Connected MCP Server */
interface ConnectedServer {
    name: string;
    client: Client;
    transport: StdioClientTransport | SSEClientTransport;
    tools: Tool[];
}

// ========================
// Tool conversion
// ========================

/**
 * Convert the JSON Schema parameter of the MCP tool to ToolParameter format
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
 * Mapping JSON Schema type to ToolParameter type
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
     * Initialization: Connect all configured MCP Servers
     */
    async initialize(configs: McpServerConfig[]): Promise<void> {
        const enabledConfigs = configs.filter(c => c.enabled !== false);
        if (enabledConfigs.length === 0) {
            log.info('No enabled MCP Server config found');
            return;
        }

        log.info(`Connecting to ${enabledConfigs.length} MCP Servers...`);

        // Connect all servers in parallel (single failure does not affect others)
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
     * Connect to a single MCP Server
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

        // Connect (with timeout)
        const timeout = (config.timeout || 30) * 1000;
        const connectPromise = client.connect(transport);
        const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Connection timeout (${config.timeout || 30}s)`)), timeout)
        );

        await Promise.race([connectPromise, timeoutPromise]);
        log.info(`MCP Server "${config.name}" connected`);

        // Get a list of tools
        const toolsResult = await client.listTools();
        const mcpTools = toolsResult.tools || [];
        log.info(`MCP Server "${config.name}" provides ${mcpTools.length} tools`);

        // Convert to standard Tool interface
        const tools: Tool[] = mcpTools.map(mcpTool => {
            const toolName = `mcp_${config.name}_${mcpTool.name}`;
            const params = convertJsonSchemaToParams(mcpTool.inputSchema as Record<string, unknown>);

            return {
                name: toolName,
                priority: 60,
                description: `[MCP:${config.name}] ${mcpTool.description || mcpTool.name}`,
                parameters: params,
                // Keep the original MCP JSON Schema to avoid losing complex structures such as items/anyOf in ToolParameter conversion
                rawInputSchema: mcpTool.inputSchema as Record<string, unknown> | undefined,
                execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
                    try {
                        // Extract timeout (seconds) in tool parameters for long operations (such as pip install)
                        const toolTimeout = Math.min(
                            Number(args.timeout) || 60,
                            600 // Max 10 minutes
                        ) * 1000;

                        const result = await client.callTool({
                            name: mcpTool.name,
                            arguments: args,
                        }, undefined, {
                            timeout: toolTimeout,
                        });

                        // Parsing MCP tool results
                        const content = result.content;
                        if (Array.isArray(content) && content.length > 0) {
                            // Extract text content
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

                        // Enhanced common error prompts to help LLM automatically correct
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
     * Get all tools connected to MCP Server
     */
    getTools(): Tool[] {
        const allTools: Tool[] = [];
        for (const server of this.servers.values()) {
            allTools.push(...server.tools);
        }
        return allTools;
    }

    /**
     * Get connected MCP Server information
     */
    getServerInfo(): Array<{ name: string; toolCount: number }> {
        return Array.from(this.servers.values()).map(s => ({
            name: s.name,
            toolCount: s.tools.length,
        }));
    }

    /**
     * Close all connections and child processes
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
