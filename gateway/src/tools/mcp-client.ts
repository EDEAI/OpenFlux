/**
 * MCP Client Manager
 * Connect to the external MCP Server, convert its tools into standard Tool interfaces and register them in ToolRegistry
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { createServer, type Server as HttpServer } from 'http';
import { join } from 'path';
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
    /** Transmission method: stdio (child process), sse (legacy remote), http (Streamable HTTP remote) */
    transport: 'stdio' | 'sse' | 'http';
    /** stdio mode: start command */
    command?: string;
    /** stdio mode: command parameters */
    args?: string[];
    /** stdio mode: environment variables */
    env?: Record<string, string>;
    /** stdio mode: working directory (plugin-bundled servers run from their plugin root) */
    cwd?: string;
    /** SSE / http mode: Server URL */
    url?: string;
    /** http mode: extra request headers */
    headers?: Record<string, string>;
    /** http mode: env var holding a bearer token (Authorization: Bearer …), e.g. GITHUB_PAT_TOKEN */
    bearerTokenEnvVar?: string;
    /** http mode: OAuth resource indicator the server declares (RFC 8707); passed through to the auth flow */
    oauthResource?: string;
    /** http mode: 'auto' (default) starts an OAuth flow on 401, 'off' never does */
    oauth?: 'auto' | 'off';
    /** Whether to enable */
    enabled?: boolean;
    /** Connection timeout (seconds, default 30) */
    timeout?: number;
}

export type McpServerStatus = 'connecting' | 'connected' | 'needs_auth' | 'error' | 'disconnected';

export interface McpServerState {
    name: string;
    status: McpServerStatus;
    toolCount: number;
    error?: string;
}

/** Thrown when a remote server wants OAuth and the caller did not allow an interactive flow. */
export class McpNeedsAuthError extends Error {
    constructor(public readonly serverName: string) {
        super(`MCP server "${serverName}" requires authorization`);
        this.name = 'McpNeedsAuthError';
    }
}

/** Port of the one-shot loopback listener that receives the OAuth redirect. */
export const MCP_OAUTH_CALLBACK_PORT = 18809;
export const MCP_OAUTH_REDIRECT_URL = `http://127.0.0.1:${MCP_OAUTH_CALLBACK_PORT}/oauth/callback`;
const OAUTH_WAIT_MS = 5 * 60 * 1000;

/**
 * OAuth client state for one remote server, kept as a JSON file so logins
 * survive restarts: dynamically registered client info, tokens, PKCE verifier.
 */
class FileOAuthProvider implements OAuthClientProvider {
    private data: { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; verifier?: string } = {};
    private readonly file: string;

    constructor(
        private readonly serverName: string,
        dir: string,
        private readonly onRedirect: (url: URL) => void,
    ) {
        mkdirSync(dir, { recursive: true });
        this.file = join(dir, `${serverName.replace(/[^\w.-]+/g, '_')}.oauth.json`);
        if (existsSync(this.file)) {
            try { this.data = JSON.parse(readFileSync(this.file, 'utf-8')); } catch { this.data = {}; }
        }
    }

    private persist(): void {
        try { writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf-8'); } catch (e) { log.warn(`Cannot persist OAuth state for ${this.serverName}`, e); }
    }

    get redirectUrl(): string { return MCP_OAUTH_REDIRECT_URL; }

    get clientMetadata(): OAuthClientMetadata {
        return {
            client_name: 'OpenFlux',
            redirect_uris: [MCP_OAUTH_REDIRECT_URL],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
        };
    }

    clientInformation(): OAuthClientInformationMixed | undefined { return this.data.client; }
    saveClientInformation(info: OAuthClientInformationMixed): void { this.data.client = info; this.persist(); }
    tokens(): OAuthTokens | undefined { return this.data.tokens; }
    saveTokens(tokens: OAuthTokens): void { this.data.tokens = tokens; this.persist(); }
    redirectToAuthorization(url: URL): void { this.onRedirect(url); }
    saveCodeVerifier(v: string): void { this.data.verifier = v; this.persist(); }
    codeVerifier(): string {
        if (!this.data.verifier) throw new Error('OAuth code verifier missing; restart the authorization');
        return this.data.verifier;
    }
    invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
        if (scope === 'all') this.data = {};
        else if (scope === 'client') delete this.data.client;
        else if (scope === 'tokens') delete this.data.tokens;
        else if (scope === 'verifier') delete this.data.verifier;
        this.persist();
    }
    hasTokens(): boolean { return !!this.data.tokens?.access_token; }
    forget(): void { this.data = {}; try { rmSync(this.file, { force: true }); } catch { /* ignore */ } }
}

/** Open a URL in the user's default browser (the OAuth consent page). */
function openInSystemBrowser(url: string): void {
    try {
        if (process.platform === 'win32') {
            // `start` treats the first quoted argument as a window title.
            spawn('cmd', ['/c', 'start', '', url.replace(/&/g, '^&')], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        } else if (process.platform === 'darwin') {
            spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
        } else {
            spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
        }
    } catch (e) {
        log.warn('Cannot open the system browser for OAuth', e);
    }
}

/**
 * Wait once for the OAuth redirect on the loopback port. Only one flow runs at
 * a time; the listener closes as soon as a code (or an error) arrives.
 */
let oauthListener: HttpServer | null = null;
function waitForOAuthCode(expectedState: string | undefined, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
        if (oauthListener) {
            try { oauthListener.close(); } catch { /* ignore */ }
            oauthListener = null;
        }
        const server = createServer((req, res) => {
            const url = new URL(req.url || '/', MCP_OAUTH_REDIRECT_URL);
            if (url.pathname !== '/oauth/callback') { res.statusCode = 404; res.end(); return; }
            const code = url.searchParams.get('code');
            const err = url.searchParams.get('error');
            const state = url.searchParams.get('state');
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            if (err || !code) {
                res.end(`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px"><h2>授权失败</h2><p>${(err || 'missing code').replace(/</g, '&lt;')}</p><p>You can close this window.</p>`);
                finish(new Error(`OAuth authorization failed: ${err || 'missing code'}`));
                return;
            }
            if (expectedState && state && state !== expectedState) {
                res.end('<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px"><h2>授权失败</h2><p>state mismatch</p>');
                finish(new Error('OAuth state mismatch'));
                return;
            }
            res.end('<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px"><h2>授权完成 ✓</h2><p>OpenFlux 已收到授权，可以关闭此页面回到应用。<br/>Authorization received — you can close this window.</p>');
            finish(null, code);
        });
        const timer = setTimeout(() => finish(new Error(`OAuth authorization timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
        const finish = (error: Error | null, code?: string): void => {
            clearTimeout(timer);
            if (oauthListener === server) oauthListener = null;
            server.close();
            if (error) reject(error); else resolve(code as string);
        };
        server.on('error', e => finish(e as Error));
        server.listen(MCP_OAUTH_CALLBACK_PORT, '127.0.0.1');
        oauthListener = server;
    });
}

/** Connected MCP Server */
interface ConnectedServer {
    name: string;
    client: Client;
    transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport;
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
    /** Last known state per server name, including ones that failed or need auth. */
    private states: Map<string, McpServerState> = new Map();
    /** Where OAuth client/token files live (set by the gateway; null = OAuth unavailable). */
    private oauthDir: string | null = null;
    private providers: Map<string, FileOAuthProvider> = new Map();
    /** Told whenever a server needs the user to visit an authorization URL. */
    onAuthorizationUrl?: (serverName: string, url: string) => void;

    setOAuthDir(dir: string): void {
        this.oauthDir = dir;
    }

    private setState(name: string, status: McpServerStatus, error?: string): void {
        const toolCount = this.servers.get(name)?.tools.length ?? 0;
        this.states.set(name, { name, status, toolCount, ...(error ? { error } : {}) });
    }

    getServerState(name: string): McpServerState | undefined {
        return this.states.get(name);
    }

    getServerTools(name: string): Tool[] {
        return this.servers.get(name)?.tools ?? [];
    }

    /**
     * Connect one server on demand (plugin install, user-triggered retry). With
     * `interactive` a remote server that answers 401 gets a browser OAuth flow;
     * without it the server is left in `needs_auth` and McpNeedsAuthError is thrown.
     */
    async connectOne(config: McpServerConfig, options: { interactive?: boolean } = {}): Promise<Tool[]> {
        if (this.servers.has(config.name)) await this.disconnect(config.name);
        await this.connectServer(config, options.interactive === true);
        return this.getServerTools(config.name);
    }

    async disconnect(name: string): Promise<void> {
        const server = this.servers.get(name);
        if (!server) return;
        this.servers.delete(name);
        try { await server.client.close(); } catch (error) { log.warn(`MCP Server "${name}" error during close:`, { error }); }
        this.setState(name, 'disconnected');
    }

    /** Forget a server's OAuth login (next connect will ask again). */
    forgetAuthorization(name: string): void {
        this.providers.get(name)?.forget();
        this.providers.delete(name);
    }

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
    private async connectServer(config: McpServerConfig, interactive = false): Promise<void> {
        log.info(`Connecting MCP Server: ${config.name} (${config.transport})`);
        this.setState(config.name, 'connecting');
        try {
            await this.connectServerInner(config, interactive);
            this.setState(config.name, 'connected');
        } catch (error) {
            if (error instanceof McpNeedsAuthError) {
                this.setState(config.name, 'needs_auth', 'authorization required');
            } else {
                this.setState(config.name, 'error', error instanceof Error ? error.message : String(error));
            }
            throw error;
        }
    }

    /** Build the transport for a config; http transports get an OAuth provider unless disabled. */
    private buildTransport(config: McpServerConfig, onRedirect: (url: URL) => void): StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport {
        if (config.transport === 'stdio') {
            if (!config.command) throw new Error(`MCP Server "${config.name}" stdio mode missing command configuration`);
            return new StdioClientTransport({
                command: config.command,
                args: config.args || [],
                ...(config.cwd ? { cwd: config.cwd } : {}),
                env: { ...process.env as Record<string, string>, ...(config.env || {}) },
            });
        }
        if (!config.url) throw new Error(`MCP Server "${config.name}" ${config.transport} mode missing url configuration`);
        if (config.transport === 'sse') return new SSEClientTransport(new URL(config.url));
        if (config.transport !== 'http') throw new Error(`MCP Server "${config.name}" unsupported transport: ${String(config.transport)}`);
        const headers: Record<string, string> = { ...(config.headers || {}) };
        const bearer = config.bearerTokenEnvVar ? process.env[config.bearerTokenEnvVar] : undefined;
        if (bearer) headers.Authorization = `Bearer ${bearer}`;
        let authProvider: OAuthClientProvider | undefined;
        if (!bearer && config.oauth !== 'off' && this.oauthDir) {
            let provider = this.providers.get(config.name);
            if (!provider) {
                provider = new FileOAuthProvider(config.name, this.oauthDir, onRedirect);
                this.providers.set(config.name, provider);
            }
            authProvider = provider;
        }
        return new StreamableHTTPClientTransport(new URL(config.url), {
            ...(authProvider ? { authProvider } : {}),
            ...(Object.keys(headers).length ? { requestInit: { headers } } : {}),
        });
    }

    private async connectServerInner(config: McpServerConfig, interactive: boolean): Promise<void> {
        let pendingAuthUrl: URL | null = null;
        const onRedirect = (url: URL): void => { pendingAuthUrl = url; };

        let client = new Client({ name: `OpenFlux-${config.name}`, version: '1.0.0' });
        let transport = this.buildTransport(config, onRedirect);
        const timeoutSec = config.timeout || 30;
        const withTimeout = <T,>(p: Promise<T>): Promise<T> => Promise.race([
            p,
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Connection timeout (${timeoutSec}s)`)), timeoutSec * 1000)),
        ]);

        try {
            await withTimeout(client.connect(transport));
        } catch (error) {
            if (!(error instanceof UnauthorizedError) || config.transport !== 'http') throw error;
            const authUrl = pendingAuthUrl as URL | null;
            if (!interactive || !authUrl) {
                try { await client.close(); } catch { /* ignore */ }
                throw new McpNeedsAuthError(config.name);
            }
            // Interactive OAuth: send the user to the consent page, wait for the loopback redirect, finish, reconnect.
            log.info(`MCP Server "${config.name}" needs authorization; opening ${authUrl.origin}`);
            this.onAuthorizationUrl?.(config.name, authUrl.toString());
            openInSystemBrowser(authUrl.toString());
            const expectedState = authUrl.searchParams.get('state') || undefined;
            const code = await waitForOAuthCode(expectedState, OAUTH_WAIT_MS);
            await (transport as StreamableHTTPClientTransport).finishAuth(code);
            try { await client.close(); } catch { /* ignore */ }
            client = new Client({ name: `OpenFlux-${config.name}`, version: '1.0.0' });
            transport = this.buildTransport(config, onRedirect);
            await withTimeout(client.connect(transport));
        }

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
