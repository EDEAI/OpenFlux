/**
 * Tool Registry - Factory Pattern Refactored Version
 * Reference Clawdbot design
 */

import { randomUUID } from 'node:crypto';
import type { AnyTool, Tool, ToolExecutionContext, ToolResult } from './types';
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
import { createFileReaderTool, type FileReaderToolOptions } from './file-reader';
import { createCodingAgentTool, type CodingAgentToolOptions } from './coding-agent';
import { createImageGenTool, type ImageGenToolOptions } from './image';
import { createVideoGenTool, type VideoGenToolOptions } from './video';
import { createPresentationGenTool, createPresentationReferenceTool, type PresentationGenToolOptions } from './presentation';
import type { AgentToolsConfig, SubAgentToolsConfig } from './policy';
import { resolveToolsForAgent } from './policy';
import { Logger } from '../utils/logger';
import { PermissionChecker } from '../permissions/checker';
import { redactSensitiveValue } from '../security/redaction';
import { telemetry } from '../observability/telemetry';
import { assessPlanModeTool, isPlanModeToolVisible, type ExecutionWorkMode } from '../work/policy';

export interface ToolRegistryOptions {
    /** File system tool configuration */
    filesystem?: FileSystemToolOptions;
    /** Process tool configuration */
    process?: ProcessToolOptions;
    /** Browser tool configuration */
    browser?: BrowserToolOptions;
    /** OpenCode tool configuration */
    opencode?: OpenCodeToolOptions;
    /** Windows tool configuration */
    windows?: WindowsToolOptions;
    /** macOS tool configuration */
    macos?: MacOSToolOptions;
    /** Workflow tool configuration */
    workflow?: WorkflowToolOptions;
    /** Scheduler tool configuration */
    scheduler?: SchedulerToolOptions;
    /** Desktop control tool configuration */
    desktop?: DesktopToolOptions;
    /** Web search tool configuration */
    webSearch?: WebSearchToolOptions;
    /** Web page acquisition tool configuration */
    webFetch?: WebFetchToolOptions;
    /** Memory tool configuration */
    memory?: MemoryToolOptions;
    /** Office document processing tool configuration */
    office?: OfficeToolOptions;
    /** Email tool configuration */
    email?: EmailToolOptions;
    /** File reading tool configuration (markitdown) */
    fileReader?: FileReaderToolOptions;
    /** CLI AI Coding Agent tool configuration (agy/claude/codex/cursor) */
    codingAgent?: CodingAgentToolOptions;
    /** Image generation tool configuration (generate_image) */
    imageGen?: ImageGenToolOptions;
    /** Local short-video composition tool configuration (generate_video) */
    videoGen?: VideoGenToolOptions;
    /** Design-first local PowerPoint generation configuration (generate_presentation) */
    presentationGen?: PresentationGenToolOptions;
}

export interface ToolRegistryRuntimeOptions {
    permissionChecker?: PermissionChecker;
}

function abortError(signal?: AbortSignal): Error {
    const reason = signal?.reason;
    const error = new Error(
        reason instanceof Error ? reason.message : 'Tool execution aborted',
        reason instanceof Error ? { cause: reason } : undefined,
    );
    error.name = 'AbortError';
    return error;
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
}

async function waitForApproval<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) throw abortError(signal);

    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(abortError(signal));
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            value => {
                signal.removeEventListener('abort', onAbort);
                resolve(value);
            },
            error => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            },
        );
    });
}

/**
 * Tool registry
 */
export class ToolRegistry {
    private tools: Map<string, Tool> = new Map();
    private logger = new Logger('ToolRegistry');
    private permissionChecker: PermissionChecker;

    constructor(options: ToolRegistryRuntimeOptions = {}) {
        this.permissionChecker = options.permissionChecker || new PermissionChecker();
    }

    /**
     * Registration tool
     */
    register(tool: Tool): void {
        // If the tool declares available: false, registration will be skipped (preconditions are not met, such as API Key is missing)
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
     * Removal tool (for MCP hot reload and other scenarios)
     */
    unregister(name: string): boolean {
        const removed = this.tools.delete(name);
        if (removed) {
            this.logger.debug(`Tool removed: ${name}`);
        }
        return removed;
    }

    /**
     * Get tools
     */
    getTool(name: string): Tool | undefined {
        return this.tools.get(name);
    }

    /**
     * Get all the tools
     */
    getAllTools(): Tool[] {
        return Array.from(this.tools.values());
    }

    /**
     * Get a list of tool names
     */
    getToolNames(): string[] {
        return Array.from(this.tools.keys());
    }

    /**
     * Execution tool
     */
    async executeTool(name: string, args: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
        const tool = this.getTool(name);
        if (!tool) {
            return { success: false, error: `Tool not found: ${name}` };
        }

        const signal = context?.abortSignal || context?.signal;
        if (signal?.aborted) throw abortError(signal);

        const planPolicy = assessPlanModeTool(context?.workMode, name, args);
        if (!planPolicy.allowed) {
            return {
                success: false,
                code: 'PLAN_MODE_READ_ONLY',
                error: planPolicy.reason,
            };
        }

        const assessment = this.permissionChecker.assess(name, args);
        if (assessment.blocked) {
            return {
                success: false,
                error: `Blocked by immutable safety policy: ${assessment.reason}`,
            };
        }

        if (await this.permissionChecker.requiresConfirmation(name, args, context?.approvalMode)) {
            if (!context?.requestApproval) {
                return {
                    success: false,
                    error: `Permission denied: ${assessment.reason}. Interactive approval is required.`,
                };
            }

            const redactedArgs = redactSensitiveValue(args) as Record<string, unknown>;
            const decision = await waitForApproval(context.requestApproval({
                requestId: randomUUID(),
                toolName: name,
                args: redactedArgs,
                riskLevel: assessment.level,
                riskLabel: this.permissionChecker.getRiskDescription(assessment.level),
                reason: assessment.reason,
                sessionId: context.sessionId,
                turnId: context.turnId,
            }), signal);

            if (decision !== 'approved') {
                return { success: false, error: `Permission denied: ${assessment.reason}` };
            }
        }

        if (signal?.aborted) throw abortError(signal);

        try {
            const result = await telemetry.trace(
                'tool.call',
                { traceId: context?.traceId },
                {
                    sessionId: context?.sessionId,
                    turnId: context?.turnId,
                    runId: context?.runId,
                    tool: name,
                    riskLevel: assessment.level,
                },
                () => tool.execute(args, context),
            );
            if (signal?.aborted) throw abortError(signal);
            this.logger.debug(`Tool execution complete: ${name}`, { success: result.success });
            return result;
        } catch (error) {
            if (signal?.aborted || isAbortError(error)) throw abortError(signal);
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.logger.error(`Tool execution failed: ${name}`, { error: errorMsg });
            return { success: false, error: errorMsg };
        }
    }

    /**
     * Register default tools (using factory mode)
     */
    registerDefaults(options: ToolRegistryOptions = {}): void {
        // file system tools
        this.register(createFileSystemTool(options.filesystem));

        // process tools
        this.register(createProcessTool(options.process));

        // browser tools
        this.register(createBrowserTool(options.browser));

        // OpenCode tools
        this.register(createOpenCodeTool(options.opencode));

        // Platform tools (mutually exclusive registration)
        if (process.platform === 'win32') {
            this.register(createWindowsTool(options.windows));
        } else if (process.platform === 'darwin') {
            this.register(createMacOSTool(options.macos));
        }

        // Workflow tools (requires engine instance, skipped if not provided)
        if (options.workflow) {
            this.register(createWorkflowTool(options.workflow));
        }

        // Scheduler tool (requires scheduler instance, skipped if not provided)
        if (options.scheduler) {
            this.register(createSchedulerTool(options.scheduler));
        }

        // Desktop control tool (Windows: keysender, macOS: AppleScript)
        if (process.platform === 'win32' || process.platform === 'darwin') {
            this.register(createDesktopTool(options.desktop));
        }

        // Web search tool (factory function declares whether it is available through the available attribute)
        this.register(createWebSearchTool(options.webSearch));

        // Web page acquisition tool
        this.register(createWebFetchTool(options.webFetch));

        // memory tool
        if (options.memory) {
            this.register(createMemoryTool(options.memory));
        }

        // Office document processing tools
        this.register(createOfficeTool(options.office));

        // Email tool
        this.register(createEmailTool(options.email));

        // File reading tool (markitdown, supports docx/xlsx/pptx/pdf/csv/html/epub)
        this.register(createFileReaderTool(options.fileReader));

        // CLI AI Coding Agent tool (agy/claude/codex/cursor)
        this.register(createCodingAgentTool(options.codingAgent));

        // Image generation tool (text-to-image / image-to-image; backend follows work mode)
        this.register(createImageGenTool(options.imageGen));

        // Video generation tool (reliable local FFmpeg composition; provider extension point)
        this.register(createVideoGenTool(options.videoGen));

        // Presentation references -> model design direction -> editable PPTX -> native visual QA
        this.register(createPresentationReferenceTool(options.presentationGen));
        this.register(createPresentationGenTool(options.presentationGen));

        this.logger.info(`Default tools registered, total ${this.tools.size} tools`);
    }

    /**
     * Filter by policy and return a new ToolRegistry instance (the original instance is not modified)
     *
     * @param agentTools Agent tool configuration (profile + allow/deny)
     * @param isSubAgent Is it a sub-Agent?
     * @param subAgentConfig sub-Agent tool configuration
     */
    filter(
        agentTools?: AgentToolsConfig,
        isSubAgent?: boolean,
        subAgentConfig?: SubAgentToolsConfig
    ): ToolRegistry {
        const allTools = this.getAllTools();
        const filtered = resolveToolsForAgent(allTools, agentTools, isSubAgent, subAgentConfig);
        if (!isSubAgent) {
            const mandatoryPlanTools = new Set(['request_plan_input', 'publish_plan_document', 'project_search']);
            for (const tool of allTools) {
                if (mandatoryPlanTools.has(tool.name) && !filtered.some(item => item.name === tool.name)) {
                    filtered.push(tool);
                }
            }
        }

        const newRegistry = new ToolRegistry({ permissionChecker: this.permissionChecker });
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
     * Generate tool description (for LLM)
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
     * Convert to unified LLM tool definition format
     * Each Provider internally converts it into the specific format required by its own API
     */
    toLLMToolDefinitions(workMode?: ExecutionWorkMode): LLMToolDefinition[] {
        // Arranged in ascending order of priority (lower numbers first), LLM tends to select tools at the top of the list
        const sorted = this.getAllTools()
            .filter(tool => isPlanModeToolVisible(workMode, tool.name))
            .sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));

        return sorted.map(tool => {
            // MCP tool: Use the original JSON Schema directly to avoid losing complex structures such as items/anyOf in ToolParameter conversion
            if (tool.rawInputSchema) {
                return {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.rawInputSchema as LLMToolDefinition['parameters'],
                };
            }

            // Built-in tools: built from ToolParameter
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
     * Convert to OpenAI tool format (preserving backwards compatibility)
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

// Export factory function
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

// Export type
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
export type { CodingAgentToolOptions } from './coding-agent';
export { createImageGenTool } from './image';
export type { ImageGenToolOptions, ImageGenRuntimeConfig, ImageProviderId } from './image';
export { createPresentationGenTool, createPresentationReferenceTool } from './presentation';
export type { PresentationGenToolOptions } from './presentation';
