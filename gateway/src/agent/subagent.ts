/**
 * SubAgent 执行器
 * 连接 spawn 工具和 Agent Loop
 * 支持工具限制：SubAgent 使用过滤后的工具注册表
 */

import type { SpawnParams, SpawnResult } from '../tools/spawn';
import { runAgentLoop } from './loop';
import { ToolRegistry } from '../tools/registry';
import type { LLMProvider, LLMToolCall } from '../llm/provider';
import { Logger } from '../utils/logger';

const log = new Logger('SubAgent');

/**
 * SubAgent 配置
 */
export interface SubAgentConfig {
    /** LLM Provider（可与主 Agent 不同，如使用更便宜的模型） */
    llm: LLMProvider;
    /** 工具注册表（应为过滤后的版本，限制 SubAgent 可用工具） */
    tools: ToolRegistry;
    /** 最大迭代次数（默认 30） */
    maxIterations?: number;
    /** 完成回调（用于汇报给主 Agent） */
    onComplete?: (result: SpawnResult) => void;
    /** 进度回调（用于将子Agent进度传给主会话） */
    onProgress?: (event: { type: string;[key: string]: unknown }) => void;
}

/**
 * SubAgent 系统提示
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

/** SubAgent 必须始终拥有的基线工具（不受 params.tools 限制） */
const BASELINE_TOOLS = ['filesystem', 'process'];

/** SubAgent 禁止使用的工具（防止嵌套 spawn） */
const DENIED_TOOLS = ['spawn'];

/**
 * 创建 SubAgent 执行函数
 * 用于 spawn 工具的 onExecute 回调
 *
 * 注意：config.tools 应为经过 SubAgent 策略过滤后的工具注册表，
 * 以限制子 Agent 不能使用 scheduler、workflow 等全局资源工具。
 */
export function createSubAgentExecutor(config: SubAgentConfig) {
    const availableTools = config.tools.getToolNames();
    log.info(`SubAgent available tools: [${availableTools.join(', ')}]`);

    return async (params: SpawnParams): Promise<SpawnResult> => {
        const startTime = Date.now();
        log.info(`SubAgent started: ${params.id}`, { task: params.task.slice(0, 100) });

        // AbortController 用于超时后真正终止 runAgentLoop
        const abortController = new AbortController();
        const parentSignal = params.parentAbortSignal;

        try {
            // 设置超时（通过 abort 终止 runAgentLoop，而不是仅靠 Promise.race 放弃等待）
            const timeoutMs = params.timeout * 1000;
            const timeoutTimer = setTimeout(() => {
                log.warn(`SubAgent ${params.id}: timeout reached (${params.timeout}s), aborting loop`);
                abortController.abort();
            }, timeoutMs);

            // 级联父 Agent 的 AbortSignal：父停止时子也停止
            let parentAbortHandler: (() => void) | undefined;
            if (parentSignal) {
                if (parentSignal.aborted) {
                    // 父已经 abort 了，直接中止
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

            // 根据 params.tools 过滤工具
            let subAgentTools = config.tools;
            if (params.tools && params.tools.length > 0) {
                // LLM 指定了工具列表 → 过滤，但始终保留基线工具
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

            // 移除禁止的工具（防止嵌套 spawn）
            for (const denied of DENIED_TOOLS) {
                if (subAgentTools.getTool(denied)) {
                    subAgentTools.unregister(denied);
                    log.info(`SubAgent ${params.id}: removed denied tool '${denied}'`);
                }
            }

            // 执行 Agent Loop（使用过滤后的工具注册表 + AbortController）
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

            // 执行完成，清理
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
            // 清理定时器和监听器
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
 * 格式化 SubAgent 结果用于汇报
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
