/**
 * SubAgent executor
 * Connect spawn tools and Agent Loop
 * Support tool restrictions: SubAgent uses a filtered tool registry
 */

import type { SpawnParams, SpawnResult } from '../tools/spawn';
import { runAgentLoop } from './loop';
import { ToolRegistry } from '../tools/registry';
import type { LLMProvider, LLMToolCall } from '../llm/provider';
import { Logger } from '../utils/logger';

const log = new Logger('SubAgent');

/**
 * SubAgent configuration
 */
export interface SubAgentConfig {
    /** LLM Provider (can be different from the main Agent, such as using a cheaper model) */
    llm: LLMProvider;
    /** Tool registry (should be a filtered version to limit the tools available to SubAgent) */
    tools: ToolRegistry;
    /** Maximum number of iterations (default 30) */
    maxIterations?: number;
    /** Completion callback (used to report to the main Agent) */
    onComplete?: (result: SpawnResult) => void;
    /** Progress callback (used to pass the sub-Agent progress to the main session) */
    onProgress?: (event: { type: string;[key: string]: unknown }) => void;
}

/**
 * SubAgent system prompts
 */
const SUBAGENT_SYSTEM_PROMPT = `You are a SubAgent created to execute a specific task assigned by the main Agent.

## Your Role
- You were spawned by the main Agent to handle a specific task
- Focus solely on completing the assigned task
- Your output will be automatically reported back to the main Agent

## Tool Usage Rules (CRITICAL - Read Carefully)

### File Operations (MUST use filesystem tool)
- **Writing files**: ALWAYS use \`filesystem\` tool with action="write". NEVER use PowerShell/cmd to write files.
- **Reading files**: ALWAYS use \`filesystem\` tool with action="read"
- **Listing directories**: Use \`filesystem\` tool with action="list"
- **Chinese/Unicode content**: The \`filesystem\` tool handles UTF-8 encoding correctly. PowerShell has known encoding issues with non-ASCII characters. ALWAYS prefer filesystem.

### Other Tools
- **Search for information**: MUST use web_search tool. Do NOT use process to run Python/curl for searching
- **Fetch web content**: MUST use web_fetch tool. Do NOT use process to run urllib/requests/curl for fetching
- **Execute commands/programs**: Use the process tool (only for scenarios that truly require running local programs)
- **Windows automation**: Use the windows tool for GUI automation, keyboard/mouse simulation

### ★ Anti-Script Rule (CRITICAL — Most Common Mistake)
When you have built-in tools (browser, web_search, web_fetch), you MUST NOT write scripts to replicate them:
- ❌ Do NOT pip install playwright/selenium/requests → write scraper → run with process
- ❌ Do NOT write Python BeautifulSoup/requests scripts for web scraping
- ❌ Do NOT create "simulated" or "estimated" data when real scraping fails
- ✅ DO use browser tool directly for web page interaction
- ✅ DO use web_search for internet information queries
- ✅ DO use web_fetch to read page content from URLs
- Process tool is ONLY for: generating output files (PDF, Excel), running computation, system commands

### Anti-Pattern Warnings
- ❌ Do NOT use PowerShell to write files (encoding issues with Chinese/Unicode)
- ❌ Do NOT use cmd echo/pipe to build files line by line
- ❌ Do NOT use byte arrays to workaround encoding
- ❌ Do NOT spawn nested SubAgents - you cannot use the spawn tool
- ❌ Do NOT fabricate data — if tools fail, report honestly
- ✅ DO use filesystem tool for ALL file read/write operations

## Rules
1. Only do the task assigned to you, nothing extra
2. Keep your output concise and clear
3. If the task cannot be completed, clearly explain why
4. Do not try to communicate directly with the user
5. If a tool call fails 3+ times, try a different approach instead of retrying the same method`;

/** Baseline tools that SubAgent must always have (not limited by params.tools) */
const BASELINE_TOOLS = ['filesystem', 'process'];

/** Tools prohibited by SubAgent (prevent nested spawns) */
const DENIED_TOOLS = ['spawn'];

/**
 * Create SubAgent execution function
 * onExecute callback for spawn tools
 *
 * Note: config.tools should be the tool registry filtered by SubAgent policy.
 * To restrict sub-Agents from using global resource tools such as scheduler and workflow.
 */
export function createSubAgentExecutor(config: SubAgentConfig) {
    const availableTools = config.tools.getToolNames();
    log.info(`SubAgent available tools: [${availableTools.join(', ')}]`);

    return async (params: SpawnParams): Promise<SpawnResult> => {
        const startTime = Date.now();
        log.info(`SubAgent started: ${params.id}`, { task: params.task.slice(0, 100) });

        // AbortController is used to actually terminate runAgentLoop after timeout
        const abortController = new AbortController();
        const parentSignal = params.parentAbortSignal;

        try {
            // Set timeout (terminate runAgentLoop via abort instead of just giving up waiting with Promise.race)
            const timeoutMs = params.timeout * 1000;
            const timeoutTimer = setTimeout(() => {
                log.warn(`SubAgent ${params.id}: timeout reached (${params.timeout}s), aborting loop`);
                abortController.abort();
            }, timeoutMs);

            // Cascading parent Agent's AbortSignal: the child stops when the parent stops
            let parentAbortHandler: (() => void) | undefined;
            if (parentSignal) {
                if (parentSignal.aborted) {
                    // The parent has already aborted, so abort directly.
                    clearTimeout(timeoutTimer);
                    abortController.abort();
                    throw new Error('Parent agent was already aborted');
                }
                parentAbortHandler = () => {
                    log.info(`SubAgent ${params.id}: parent aborted, cascading abort`);
                    abortController.abort();
                };
                parentSignal.addEventListener('abort', parentAbortHandler, { once: true });
            }

            // Filter tools based on params.tools
            let subAgentTools = config.tools;
            if (params.tools && params.tools.length > 0) {
                // LLM Toollist -> Filter specified, but baseline tools always retained
                const allowedSet = new Set([...params.tools, ...BASELINE_TOOLS]);
                const filteredRegistry = new ToolRegistry();
                for (const tool of config.tools.getAllTools()) {
                    if (allowedSet.has(tool.name)) {
                        filteredRegistry.register(tool);
                    }
                }
                subAgentTools = filteredRegistry;
                log.info(`SubAgent ${params.id} tool filtering: ${availableTools.length} → ${filteredRegistry.getToolNames().length}`, {
                    requested: params.tools,
                    baseline: BASELINE_TOOLS,
                    final: filteredRegistry.getToolNames(),
                });
            }

            // Remove forbidden tools (prevent nested spawns)
            for (const denied of DENIED_TOOLS) {
                if (subAgentTools.getTool(denied)) {
                    subAgentTools.unregister(denied);
                    log.info(`SubAgent ${params.id}: removed denied tool '${denied}'`);
                }
            }

            // Execute Agent Loop (using filtered tool registry + AbortController)
            const maxIter = config.maxIterations || 30;
            const result = await runAgentLoop(params.task, {
                llm: config.llm,
                tools: subAgentTools,
                systemPrompt: SUBAGENT_SYSTEM_PROMPT,
                maxIterations: maxIter,
                abortSignal: abortController.signal,
                onIteration: (iteration: number) => {
                    log.info(`SubAgent ${params.id} iteration ${iteration}`);
                    config.onProgress?.({
                        type: 'iteration',
                        iteration,
                        subAgentId: params.id,
                    });
                },
                onToolCall: (toolCall: LLMToolCall, result: unknown) => {
                    const args = toolCall.arguments || {};
                    log.info(`SubAgent ${params.id} tool call: ${toolCall.name}`, {
                        action: args.action,
                    });
                    config.onProgress?.({
                        type: 'tool_result',
                        tool: toolCall.name,
                        args,
                        result,
                        subAgentId: params.id,
                    });
                },
                onToolStart: (description: string, toolCalls: LLMToolCall[], llmContent?: string) => {
                    config.onProgress?.({
                        type: 'tool_start',
                        description: `[SubAgent] ${description}`,
                        subAgentId: params.id,
                    });
                },
            });

            // Execution completed, clean up
            clearTimeout(timeoutTimer);
            if (parentAbortHandler && parentSignal) {
                parentSignal.removeEventListener('abort', parentAbortHandler);
            }

            const duration = Date.now() - startTime;
            log.info(`SubAgent completed: ${params.id}`, { duration, iterations: result.iterations });

            const spawnResult: SpawnResult = {
                id: params.id,
                status: 'completed',
                output: result.output,
                duration,
            };

            config.onComplete?.(spawnResult);
            return spawnResult;

        } catch (error) {
            // Clean up timers and listeners
            const duration = Date.now() - startTime;
            const errorMsg = error instanceof Error ? error.message : String(error);
            const isParentAborted = parentSignal?.aborted ?? false;
            const isTimeout = abortController.signal.aborted && !isParentAborted;

            log.error(`SubAgent ${isParentAborted ? 'parent-aborted' : isTimeout ? 'timed out' : 'failed'}: ${params.id}`, { error: errorMsg });

            const spawnResult: SpawnResult = {
                id: params.id,
                status: isTimeout ? 'timeout' : 'failed',
                error: isTimeout ? 'Execution timed out' : errorMsg,
                duration,
            };

            config.onComplete?.(spawnResult);
            return spawnResult;
        }
    };
}

/**
 * Format SubAgent results for reporting
 */
export function formatSubAgentReport(result: SpawnResult): string {
    const statusText = {
        completed: '✅ 完成',
        failed: '❌ 失败',
        timeout: '⏰ 超时',
    }[result.status];

    const durationText = result.duration
        ? `${(result.duration / 1000).toFixed(1)}s`
        : 'N/A';

    let report = `子任务 ${result.id} ${statusText} (耗时 ${durationText})`;

    if (result.output) {
        report += `\n\n结果:\n${result.output}`;
    }

    if (result.error) {
        report += `\n\n错误: ${result.error}`;
    }

    return report;
}
