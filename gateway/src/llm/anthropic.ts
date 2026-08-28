/**
 * Anthropic (Claude) Provider
 * Suitable for Anthropic / MiniMax (Anthropic compatibility mode), etc.
 */
import Anthropic from '@anthropic-ai/sdk';
import {
    LLMConfig,
    LLMMessage,
    LLMProvider,
    LLMToolCall,
    LLMToolDefinition,
    ChatWithToolsResponse,
    ChatWithToolsStreamCallbacks,
    ChatOptions,
    isAbortError,
    throwIfAborted,
} from './provider';
import { classifyAnthropicError } from './llm-error';
import { startLlmLog } from './llm-debug-log';

/**
 * Anthropic-compatible Messages APIs require max_tokens on every request.
 * Use each supported model's published maximum so an omitted OpenFlux setting
 * does not introduce a smaller application-side output cap.
 */
const MODEL_MAX_OUTPUT_TOKENS: Record<string, number> = {
    'claude-fable-5': 128_000,
    'claude-opus-5': 128_000,
    'claude-sonnet-5': 128_000,
    'claude-haiku-4-5': 64_000,
    'claude-haiku-4-5-20251001': 64_000,
    'claude-opus-4-6': 128_000,
    'claude-opus-4-5-20251101': 64_000,
    'claude-sonnet-4-5-20250929': 64_000,
    'MiniMax-M2.7': 204_800,
    'MiniMax-M2.7-highspeed': 204_800,
    'MiniMax-M2.5': 204_800,
    'MiniMax-M2.5-highspeed': 204_800,
};

export function resolveAnthropicMaxTokens(
    config: Pick<LLMConfig, 'provider' | 'model' | 'maxTokens'>,
    requestOverride?: number,
): number {
    if (requestOverride !== undefined) return requestOverride;
    if (config.maxTokens !== undefined) return config.maxTokens;
    const publishedMaximum = MODEL_MAX_OUTPUT_TOKENS[config.model];
    if (publishedMaximum !== undefined) return publishedMaximum;
    // Unknown models cannot omit max_tokens. Favor the current provider family's
    // largest common limit; users can still set maxTokens for a custom/legacy ID.
    return config.provider === 'minimax' ? 204_800 : 128_000;
}

export class AnthropicProvider implements LLMProvider {
    private client: Anthropic;
    private config: LLMConfig;

    constructor(config: LLMConfig) {
        this.config = config;
        this.client = new Anthropic({
            apiKey: config.apiKey || process.env.ANTHROPIC_API_KEY,
            baseURL: config.baseUrl,
            ...(config.extraHeaders ? { defaultHeaders: config.extraHeaders } : {}),
            ...(config.fetch ? { fetch: config.fetch } : {}),
        });
    }

    /**
     * Convert Unified Messaging format to Anthropic format
     * Anthropic requires user/assistant alternation, tool_result is placed in the user message
     */
    private convertMessages(messages: LLMMessage[]): Anthropic.MessageParam[] {
        const result: Anthropic.MessageParam[] = [];
        const nonSystemMessages = messages.filter(m => m.role !== 'system');

        let i = 0;
        while (i < nonSystemMessages.length) {
            const msg = nonSystemMessages[i];

            if (msg.role === 'user') {
                // user messages may carry multi-modal content (pictures, etc.)
                if (msg.contentParts?.length) {
                    const blocks: Array<Anthropic.ImageBlockParam | Anthropic.TextBlockParam> = [];
                    for (const part of msg.contentParts) {
                        if (part.type === 'text') {
                            blocks.push({ type: 'text', text: part.text });
                        } else if (part.type === 'image') {
                            blocks.push({
                                type: 'image',
                                source: {
                                    type: 'base64',
                                    media_type: part.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                                    data: part.data,
                                },
                            });
                        }
                    }
                    result.push({ role: 'user', content: blocks });
                } else {
                    result.push({
                        role: 'user',
                        content: msg.content,
                    });
                }
                i++;
            } else if (msg.role === 'assistant') {
                if (msg.toolCalls?.length) {
                    // assistant message with tool call -> mixed content blocks
                    const content: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam> = [];
                    if (msg.content) {
                        content.push({ type: 'text', text: msg.content });
                    }
                    for (const tc of msg.toolCalls) {
                        content.push({
                            type: 'tool_use',
                            id: tc.id,
                            name: tc.name,
                            input: tc.arguments,
                        });
                    }
                    result.push({ role: 'assistant', content });
                } else {
                    result.push({
                        role: 'assistant',
                        content: msg.content,
                    });
                }
                i++;
            } else if (msg.role === 'tool') {
                // Collect consecutive tool messages and merge them into one user message (Anthropic requirement)
                const toolResults: Anthropic.ToolResultBlockParam[] = [];
                while (i < nonSystemMessages.length && nonSystemMessages[i].role === 'tool') {
                    const toolMsg = nonSystemMessages[i];
                    toolResults.push({
                        type: 'tool_result',
                        tool_use_id: toolMsg.toolCallId || '',
                        content: toolMsg.content,
                    });
                    i++;
                }
                result.push({ role: 'user', content: toolResults });
            } else {
                i++;
            }
        }

        return result;
    }

    /**
     * Get system messages
     */
    private getSystemContent(messages: LLMMessage[]): string | undefined {
        return messages.find(m => m.role === 'system')?.content;
    }

    /** 已脱敏的请求头（屏蔽密钥），用于调试日志 */
    private maskedHeaders(): Record<string, unknown> {
        return {
            'authorization': `Bearer ${this.config.apiKey?.slice(0, 10)}...${this.config.apiKey?.slice(-6)}`,
            ...(this.config.extraHeaders || {}),
        };
    }

    async chat(messages: LLMMessage[], opts?: ChatOptions): Promise<string> {
        throwIfAborted(opts?.signal);
        // Filter out tool messages to maintain backward compatibility
        const filteredMessages = messages.filter(m => m.role !== 'tool' && !(m.role === 'assistant' && m.toolCalls?.length));
        const chatMessages = filteredMessages
            .filter(m => m.role !== 'system')
            .map(m => ({
                role: m.role as 'user' | 'assistant',
                content: m.content,
            }));

        const requestParams = {
            model: this.config.model,
            max_tokens: resolveAnthropicMaxTokens(this.config, opts?.maxTokens),
            system: this.getSystemContent(messages),
            messages: chatMessages,
        };
        const llmLog = startLlmLog({
            provider: this.config.provider,
            model: this.config.model,
            method: 'chat',
            url: `${this.config.baseUrl || 'https://api.anthropic.com'}/v1/messages`,
            headers: this.maskedHeaders(),
            request: requestParams,
        });

        try {
            const response = await this.client.messages.create(requestParams, { signal: opts?.signal });

            llmLog.response({
                id: (response as any).id,
                model: (response as any).model,
                content: response.content,
                usage: (response as any).usage,
                stop_reason: (response as any).stop_reason,
            });

            const textBlock = response.content.find(c => c.type === 'text');
            return textBlock?.text || '';
        } catch (error: any) {
            llmLog.error(error);
            if (isAbortError(error, opts?.signal)) throw error;
            throw classifyAnthropicError(error, this.config.provider);
        }
    }

    async chatWithTools(
        messages: LLMMessage[],
        tools: LLMToolDefinition[],
        opts?: ChatOptions,
    ): Promise<ChatWithToolsResponse> {
        throwIfAborted(opts?.signal);
        const anthropicMessages = this.convertMessages(messages);

        // Conversion tool defined to Anthropic format
        const anthropicTools: Anthropic.Tool[] = tools.map(t => ({
            name: t.name,
            description: t.description,
            input_schema: {
                type: 'object' as const,
                properties: t.parameters.properties,
                required: t.parameters.required,
            },
        }));

        const requestParams: Anthropic.MessageCreateParams = {
            model: this.config.model,
            max_tokens: resolveAnthropicMaxTokens(this.config, opts?.maxTokens),
            system: this.getSystemContent(messages),
            messages: anthropicMessages,
        };

        // Only pass the tools argument if there are tools
        if (anthropicTools.length > 0) {
            requestParams.tools = anthropicTools;
        }

        const llmLog = startLlmLog({
            provider: this.config.provider,
            model: this.config.model,
            method: 'chatWithTools',
            url: `${this.config.baseUrl || 'https://api.anthropic.com'}/v1/messages`,
            headers: this.maskedHeaders(),
            request: requestParams,
        });

        try {
            const response = await this.client.messages.create(requestParams, { signal: opts?.signal });

            llmLog.response({
                id: (response as any).id,
                model: (response as any).model,
                content: response.content,
                usage: (response as any).usage,
                stop_reason: (response as any).stop_reason,
            });

            // Parse response content blocks
            let content = '';
            const toolCalls: LLMToolCall[] = [];

            for (const block of response.content) {
                if (block.type === 'text') {
                    content += block.text;
                } else if (block.type === 'tool_use') {
                    toolCalls.push({
                        id: block.id,
                        name: block.name,
                        arguments: (block.input || {}) as Record<string, unknown>,
                    });
                }
            }

            return { content, toolCalls };
        } catch (error: any) {
            llmLog.error(error);
            if (isAbortError(error, opts?.signal)) throw error;
            throw classifyAnthropicError(error, this.config.provider);
        }
    }

    async chatWithToolsStream(
        messages: LLMMessage[],
        tools: LLMToolDefinition[],
        callbacks: ChatWithToolsStreamCallbacks,
        opts?: ChatOptions,
    ): Promise<ChatWithToolsResponse> {
        throwIfAborted(opts?.signal);
        const anthropicMessages = this.convertMessages(messages);
        const anthropicTools: Anthropic.Tool[] = tools.map(t => ({
            name: t.name,
            description: t.description,
            input_schema: {
                type: 'object' as const,
                properties: t.parameters.properties,
                required: t.parameters.required,
            },
        }));
        const streamParams: Anthropic.MessageStreamParams = {
            model: this.config.model,
            max_tokens: resolveAnthropicMaxTokens(this.config, opts?.maxTokens),
            system: this.getSystemContent(messages),
            messages: anthropicMessages,
            ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
        };
        const llmLog = startLlmLog({
            provider: this.config.provider,
            model: this.config.model,
            method: 'chatWithTools',
            url: `${this.config.baseUrl || 'https://api.anthropic.com'}/v1/messages`,
            headers: this.maskedHeaders(),
            stream: true,
            request: streamParams,
        });

        const startedAt = Date.now();
        let firstChunkAt: number | undefined;
        let chunkCount = 0;
        let content = '';
        let reasoningContent = '';
        const pendingToolCalls = new Map<number, {
            id: string;
            name: string;
            initialInput?: Record<string, unknown>;
            inputJson: string;
        }>();
        const markFirstChunk = () => {
            if (firstChunkAt !== undefined) return;
            firstChunkAt = Date.now();
            callbacks.onFirstChunk?.();
        };

        try {
            const stream = this.client.messages.stream(streamParams, { signal: opts?.signal });
            for await (const rawEvent of stream) {
                throwIfAborted(opts?.signal);
                const event = rawEvent as any;
                chunkCount++;
                markFirstChunk();

                if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
                    const index = Number.isInteger(event.index) ? event.index : pendingToolCalls.size;
                    const initialInput = event.content_block.input && typeof event.content_block.input === 'object'
                        ? event.content_block.input as Record<string, unknown>
                        : undefined;
                    pendingToolCalls.set(index, {
                        id: event.content_block.id || `tool_call_${index}`,
                        name: event.content_block.name || '',
                        initialInput,
                        inputJson: '',
                    });
                    callbacks.onToolCallDelta?.({
                        index,
                        id: event.content_block.id,
                        name: event.content_block.name,
                    });
                    continue;
                }

                if (event.type !== 'content_block_delta') continue;
                if (event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
                    content += event.delta.text;
                    callbacks.onContentDelta?.(event.delta.text);
                } else if (event.delta?.type === 'thinking_delta' && typeof event.delta.thinking === 'string') {
                    reasoningContent += event.delta.thinking;
                    callbacks.onReasoningDelta?.(event.delta.thinking);
                } else if (event.delta?.type === 'input_json_delta') {
                    const index = Number.isInteger(event.index) ? event.index : 0;
                    const current = pendingToolCalls.get(index) || {
                        id: `tool_call_${index}`,
                        name: '',
                        inputJson: '',
                    };
                    const partialJson = typeof event.delta.partial_json === 'string' ? event.delta.partial_json : '';
                    current.inputJson += partialJson;
                    pendingToolCalls.set(index, current);
                    callbacks.onToolCallDelta?.({ index, arguments: partialJson || undefined });
                }
            }

            const toolCalls: LLMToolCall[] = [...pendingToolCalls.entries()]
                .sort(([left], [right]) => left - right)
                .map(([, call]) => ({
                    id: call.id,
                    name: call.name,
                    arguments: call.inputJson ? safeParseJson(call.inputJson) : (call.initialInput || {}),
                }));
            const durationMs = Date.now() - startedAt;
            llmLog.response({
                content,
                toolCalls,
                reasoningLength: reasoningContent.length,
                chunkCount,
                firstChunkMs: firstChunkAt === undefined ? undefined : firstChunkAt - startedAt,
                durationMs,
            });
            return {
                content,
                toolCalls,
                reasoningContent: reasoningContent || undefined,
            };
        } catch (error: any) {
            llmLog.error(error);
            if (isAbortError(error, opts?.signal)) throw error;
            throw classifyAnthropicError(error, this.config.provider);
        }
    }

    async chatStream(
        messages: LLMMessage[],
        onChunk: (chunk: string) => void,
        opts?: ChatOptions,
    ): Promise<string> {
        throwIfAborted(opts?.signal);
        const filteredMessages = messages.filter(m => m.role !== 'tool' && !(m.role === 'assistant' && m.toolCalls?.length));
        const chatMessages = filteredMessages
            .filter(m => m.role !== 'system')
            .map(m => ({
                role: m.role as 'user' | 'assistant',
                content: m.content,
            }));

        const streamParams = {
            model: this.config.model,
            max_tokens: resolveAnthropicMaxTokens(this.config, opts?.maxTokens),
            system: this.getSystemContent(messages),
            messages: chatMessages,
        };
        const llmLog = startLlmLog({
            provider: this.config.provider,
            model: this.config.model,
            method: 'chatStream',
            url: `${this.config.baseUrl || 'https://api.anthropic.com'}/v1/messages`,
            headers: this.maskedHeaders(),
            stream: true,
            request: streamParams,
        });

        let fullResponse = '';
        try {
            const stream = this.client.messages.stream(streamParams, { signal: opts?.signal });

            for await (const event of stream) {
                if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                    onChunk(event.delta.text);
                    fullResponse += event.delta.text;
                }
            }

            // 流式：输出完成后记录完整响应
            llmLog.response({ content: fullResponse, length: fullResponse.length });
            return fullResponse;
        } catch (error: any) {
            llmLog.error(error);
            if (isAbortError(error, opts?.signal)) throw error;
            throw classifyAnthropicError(error, this.config.provider);
        }
    }

    getConfig(): LLMConfig {
        return this.config;
    }

    async embed(text: string, opts?: ChatOptions): Promise<number[]> {
        throwIfAborted(opts?.signal);
        throw new Error('Anthropic Provider does not support embeddings. Please use OpenAI Provider (or Minimax in OpenAI mode).');
    }

    async embedBatch(texts: string[], opts?: ChatOptions): Promise<number[][]> {
        throwIfAborted(opts?.signal);
        throw new Error('Anthropic Provider does not support embeddings. Please use OpenAI Provider (or Minimax in OpenAI mode).');
    }
}

function safeParseJson(value: string): Record<string, unknown> {
    if (!value.trim()) return {};
    try {
        return JSON.parse(value) as Record<string, unknown>;
    } catch {
        return {
            __parse_error: 'LLM returned incomplete tool arguments. Retry the tool call with valid JSON parameters.',
        };
    }
}
