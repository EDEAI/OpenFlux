/**
 * OpenAI Provider
 * Applicable to OpenAI / Kimi(Moonshot) / Deepseek / Zhipu / Ollama, etc. OpenAI is compatible with API
 */
import OpenAI from 'openai';
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
import { classifyOpenAIError } from './llm-error';
import { startLlmLog } from './llm-debug-log';

export class OpenAIProvider implements LLMProvider {
    private client: OpenAI;
    private config: LLMConfig;

    constructor(config: LLMConfig) {
        this.config = config;
        this.client = new OpenAI({
            apiKey: config.apiKey || process.env.OPENAI_API_KEY,
            baseURL: config.baseUrl,
            ...(config.extraHeaders ? { defaultHeaders: config.extraHeaders } : {}),
            ...(config.fetch ? { fetch: config.fetch } : {}),
        });
    }

    /** Detect whether it is a DeepSeek model */
    private get isDeepSeek(): boolean {
        return this.config.provider === 'deepseek' ||
            !!this.config.baseUrl?.includes('deepseek') ||
            !!this.config.model?.startsWith('deepseek');
    }

    /** Check whether max_completion_tokens needs to be used (OpenAI official API has deprecated max_tokens) */
    private get useMaxCompletionTokens(): boolean {
        // OpenAI native providers use max_completion_tokens uniformly
        // Third-party compatible API (DeepSeek/Kimi/Ollama, etc.) still use max_tokens
        return this.config.provider === 'openai' && !this.isDeepSeek;
    }

    /**
     * Convert Unified Messaging format to OpenAI format
     * Handle tool role and assistant toolCalls
     */
    private convertMessages(messages: LLMMessage[]): OpenAI.ChatCompletionMessageParam[] {
        return messages.map((m): OpenAI.ChatCompletionMessageParam => {
            // tool result messages
            if (m.role === 'tool') {
                return {
                    role: 'tool',
                    tool_call_id: m.toolCallId || '',
                    content: m.content,
                };
            }

            // Assistant message belt tool call
            if (m.role === 'assistant' && m.toolCalls?.length) {
                const msg: Record<string, unknown> = {
                    role: 'assistant',
                    content: m.content || null,
                    tool_calls: m.toolCalls.map(tc => ({
                        id: tc.id,
                        type: 'function' as const,
                        function: {
                            name: tc.name,
                            arguments: JSON.stringify(tc.arguments),
                        },
                    })),
                };
                // Models such as Kimi K2.5 require that the assistant tool call message in thinking mode must carry reasoning_content
                if (m.reasoningContent !== undefined) {
                    msg.reasoning_content = m.reasoningContent;
                }
                return msg as unknown as OpenAI.ChatCompletionMessageParam;
            }

            // Normal messages (system/user/assistant)
            // user messages may carry multi-modal content (pictures, etc.)
            if (m.role === 'user' && m.contentParts?.length) {
                const parts: Array<Record<string, unknown>> = [];
                for (const part of m.contentParts) {
                    if (part.type === 'text') {
                        parts.push({ type: 'text', text: part.text });
                    } else if (part.type === 'image') {
                        parts.push({
                            type: 'image_url',
                            image_url: {
                                url: `data:${part.mimeType};base64,${part.data}`,
                            },
                        });
                    }
                }
                return {
                    role: 'user',
                    content: parts,
                } as unknown as OpenAI.ChatCompletionMessageParam;
            }

            return {
                role: m.role as 'system' | 'user' | 'assistant',
                content: m.content,
            };
        });
    }

    /**
     * Build common request parameters
     */
    private buildBaseParams(messages: LLMMessage[]): Record<string, unknown> {
        // DeepSeek V3 default max_tokens = 8192 (officially supports maximum 8K output, thinking mode 64K)
        let maxTokens = this.config.maxTokens;
        if (this.isDeepSeek && (!maxTokens || maxTokens < 8192)) {
            maxTokens = 8192;
        }

        const params: Record<string, unknown> = {
            model: this.config.model,
            messages: this.convertMessages(messages),
        };

        // OpenAI new models (o1/o3/gpt-4o, etc.) require max_completion_tokens, and old models use max_tokens
        if (maxTokens) {
            if (this.useMaxCompletionTokens) {
                params.max_completion_tokens = maxTokens;
            } else {
                params.max_tokens = maxTokens;
            }
        }

        // DeepSeek thinking mode ignores temperature (official document: it will not take effect if set)
        if (this.config.temperature !== undefined && !this.isDeepSeek) {
            params.temperature = this.config.temperature;
        }

        return params;
    }

    /** 已脱敏的请求头（屏蔽密钥），用于调试日志 */
    private maskedHeaders(): Record<string, unknown> {
        return {
            'content-type': 'application/json',
            'authorization': `Bearer ${this.config.apiKey?.slice(0, 10)}...${this.config.apiKey?.slice(-6)}`,
            ...(this.config.extraHeaders || {}),
        };
    }

    async chat(messages: LLMMessage[], opts?: ChatOptions): Promise<string> {
        throwIfAborted(opts?.signal);
        // Filter out tool messages to maintain backward compatibility
        const filteredMessages = messages.filter(m => m.role !== 'tool');
        const params = this.buildBaseParams(filteredMessages);
        // 单次调用覆盖输出上限：思考型模型（kimi 等）的推理内容计入此额度，
        // 后台分析类调用（意图归纳等）默认 4096 会被思考耗尽、正文被截断
        if (opts?.maxTokens) {
            if (this.useMaxCompletionTokens) params.max_completion_tokens = opts.maxTokens;
            else params.max_tokens = opts.maxTokens;
        }

        const llmLog = startLlmLog({
            provider: this.config.provider,
            model: this.config.model,
            method: 'chat',
            url: `${this.config.baseUrl}/chat/completions`,
            headers: this.maskedHeaders(),
            request: params,
        });

        try {
            const response = await this.client.chat.completions.create(params as any, { signal: opts?.signal });
            llmLog.response({
                id: (response as any).id,
                model: (response as any).model,
                choices: (response as any).choices,
                usage: (response as any).usage,
            });
            return response.choices[0]?.message?.content || '';
        } catch (error: any) {
            llmLog.error(error);
            if (isAbortError(error, opts?.signal)) throw error;
            throw classifyOpenAIError(error, this.config.provider);
        }
    }

    async chatWithTools(
        messages: LLMMessage[],
        tools: LLMToolDefinition[],
        opts?: ChatOptions,
    ): Promise<ChatWithToolsResponse> {
        throwIfAborted(opts?.signal);
        const params = this.buildBaseParams(messages);

        // Add tool definition
        if (tools.length > 0) {
            (params as any).tools = tools.map(t => ({
                type: 'function',
                function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters,
                },
            }));
        }

        // DeepSeek thinking mode: automatically inject thinking parameters
        if (this.isDeepSeek) {
            (params as any).thinking = { type: 'enabled', budget_tokens: 4096 };
        }

        // ── 统一 LLM 调用日志（请求先落盘） ──
        const llmLog = startLlmLog({
            provider: this.config.provider,
            model: this.config.model,
            method: 'chatWithTools',
            url: `${this.config.baseUrl}/chat/completions`,
            headers: this.maskedHeaders(),
            request: params,
        });

        try {
            const response = await this.client.chat.completions.create(params as any, { signal: opts?.signal });

            llmLog.response({
                id: (response as any).id,
                model: (response as any).model,
                object: (response as any).object,
                choices: (response as any).choices,
                usage: (response as any).usage,
                raw_keys: Object.keys(response || {}),
            });

            // Safe parsing choices
            const choices = (response as any).choices;
            if (!choices || !choices[0]) {
                throw new Error(`Atlas responded without choices. Response keys: ${Object.keys(response || {}).join(', ')}`);
            }
            const message = choices[0].message;

            // Parsing tool call
            const toolCalls: LLMToolCall[] = (message?.tool_calls || []).map(tc => ({
                id: tc.id,
                name: tc.function.name,
                arguments: safeParseJson(tc.function.arguments),
            }));

            // Capturing reasoning_content (Kimi K2.5 thinking mode)
            const reasoningContent = (message as any)?.reasoning_content as string | undefined;

            return {
                content: message?.content || '',
                toolCalls,
                reasoningContent,
            };
        } catch (error: any) {
            llmLog.error(error);
            if (isAbortError(error, opts?.signal)) throw error;
            throw classifyOpenAIError(error, this.config.provider);
        }
    }

    async chatWithToolsStream(
        messages: LLMMessage[],
        tools: LLMToolDefinition[],
        callbacks: ChatWithToolsStreamCallbacks,
        opts?: ChatOptions,
    ): Promise<ChatWithToolsResponse> {
        throwIfAborted(opts?.signal);
        const params = this.buildBaseParams(messages);
        if (tools.length > 0) {
            (params as any).tools = tools.map(t => ({
                type: 'function',
                function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters,
                },
            }));
        }
        if (this.isDeepSeek) {
            (params as any).thinking = { type: 'enabled', budget_tokens: 4096 };
        }
        (params as any).stream = true;

        const llmLog = startLlmLog({
            provider: this.config.provider,
            model: this.config.model,
            method: 'chatWithTools',
            url: `${this.config.baseUrl}/chat/completions`,
            headers: this.maskedHeaders(),
            stream: true,
            request: params,
        });

        const startedAt = Date.now();
        let firstChunkAt: number | undefined;
        let chunkCount = 0;
        let content = '';
        let reasoningContent = '';
        const pendingToolCalls = new Map<number, {
            id: string;
            name: string;
            arguments: string;
        }>();

        const markFirstChunk = () => {
            if (firstChunkAt !== undefined) return;
            firstChunkAt = Date.now();
            callbacks.onFirstChunk?.();
        };

        try {
            const stream = await this.client.chat.completions.create(params as any, { signal: opts?.signal });
            for await (const chunk of stream as any) {
                throwIfAborted(opts?.signal);
                chunkCount++;
                markFirstChunk();
                const delta = chunk?.choices?.[0]?.delta || {};

                if (typeof delta.content === 'string' && delta.content) {
                    content += delta.content;
                    callbacks.onContentDelta?.(delta.content);
                }

                const reasoningDelta = typeof delta.reasoning_content === 'string'
                    ? delta.reasoning_content
                    : typeof delta.reasoning === 'string'
                        ? delta.reasoning
                        : '';
                if (reasoningDelta) {
                    reasoningContent += reasoningDelta;
                    callbacks.onReasoningDelta?.(reasoningDelta);
                }

                const toolDeltas = Array.isArray(delta.tool_calls)
                    ? delta.tool_calls
                    : delta.function_call
                        ? [{ index: 0, function: delta.function_call }]
                        : [];
                for (const rawToolDelta of toolDeltas) {
                    const index = Number.isInteger(rawToolDelta?.index) ? rawToolDelta.index : 0;
                    const current = pendingToolCalls.get(index) || { id: '', name: '', arguments: '' };
                    const idDelta = typeof rawToolDelta?.id === 'string' ? rawToolDelta.id : '';
                    const nameDelta = typeof rawToolDelta?.function?.name === 'string' ? rawToolDelta.function.name : '';
                    const argumentsDelta = typeof rawToolDelta?.function?.arguments === 'string' ? rawToolDelta.function.arguments : '';
                    current.id += idDelta;
                    current.name += nameDelta;
                    current.arguments += argumentsDelta;
                    pendingToolCalls.set(index, current);
                    callbacks.onToolCallDelta?.({
                        index,
                        id: idDelta || undefined,
                        name: nameDelta || undefined,
                        arguments: argumentsDelta || undefined,
                    });
                }
            }

            const toolCalls: LLMToolCall[] = [...pendingToolCalls.entries()]
                .sort(([left], [right]) => left - right)
                .map(([index, call]) => ({
                    id: call.id || `tool_call_${index}`,
                    name: call.name,
                    arguments: safeParseJson(call.arguments),
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
            throw classifyOpenAIError(error, this.config.provider);
        }
    }

    async chatStream(
        messages: LLMMessage[],
        onChunk: (chunk: string) => void,
        opts?: ChatOptions,
    ): Promise<string> {
        throwIfAborted(opts?.signal);
        const filteredMessages = messages.filter(m => m.role !== 'tool');
        const params = this.buildBaseParams(filteredMessages);
        (params as any).stream = true;

        const llmLog = startLlmLog({
            provider: this.config.provider,
            model: this.config.model,
            method: 'chatStream',
            url: `${this.config.baseUrl}/chat/completions`,
            headers: this.maskedHeaders(),
            stream: true,
            request: params,
        });

        try {
            const stream = await this.client.chat.completions.create(params as any, { signal: opts?.signal });

            let fullResponse = '';

            for await (const chunk of stream as any) {
                const content = chunk.choices[0]?.delta?.content || '';
                if (content) {
                    onChunk(content);
                    fullResponse += content;
                }
            }

            // 流式：输出完成后记录完整响应
            llmLog.response({ content: fullResponse, length: fullResponse.length });
            return fullResponse;
        } catch (error: any) {
            llmLog.error(error);
            if (isAbortError(error, opts?.signal)) throw error;
            throw classifyOpenAIError(error, this.config.provider);
        }
    }

    getConfig(): LLMConfig {
        return this.config;
    }

    async embed(text: string, opts?: ChatOptions): Promise<number[]> {
        throwIfAborted(opts?.signal);
        const response = await this.client.embeddings.create({
            model: this.config.embeddingModel || 'text-embedding-3-small',
            input: text,
            encoding_format: 'float',
        }, { signal: opts?.signal });
        return response.data[0].embedding;
    }

    async embedBatch(texts: string[], opts?: ChatOptions): Promise<number[][]> {
        throwIfAborted(opts?.signal);
        const response = await this.client.embeddings.create({
            model: this.config.embeddingModel || 'text-embedding-3-small',
            input: texts,
            encoding_format: 'float',
        }, { signal: opts?.signal });
        return response.data.map(d => d.embedding);
    }
}

/**
 * Safely parse JSON strings, returning an empty object on failure
 */
function safeParseJson(str: string): Record<string, unknown> {
    if (!str || str.trim() === '') {
        console.warn('[OpenAIProvider] Empty tool arguments from LLM, raw:', JSON.stringify(str));
        return { __parse_error: 'LLM returned empty tool arguments. Please retry the tool call with valid parameters.' };
    }
    try {
        return JSON.parse(str);
    } catch (e) {
        console.warn('[OpenAIProvider] Failed to parse tool arguments, raw:', str.slice(0, 200), e);
        return {
            __parse_error: `LLM output was truncated (JSON incomplete). The tool call arguments were cut off mid-stream. ` +
                `Please retry with shorter content — for large file writes, split into multiple smaller writes.`
        };
    }
}
