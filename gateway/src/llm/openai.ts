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
} from './provider';
import { classifyOpenAIError } from './llm-error';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

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

    async chat(messages: LLMMessage[]): Promise<string> {
        // Filter out tool messages to maintain backward compatibility
        const filteredMessages = messages.filter(m => m.role !== 'tool');
        const params = this.buildBaseParams(filteredMessages);

        try {
            const response = await this.client.chat.completions.create(params as any);
            return response.choices[0]?.message?.content || '';
        } catch (error: any) {
            throw classifyOpenAIError(error, this.config.provider);
        }
    }

    async chatWithTools(
        messages: LLMMessage[],
        tools: LLMToolDefinition[]
    ): Promise<ChatWithToolsResponse> {
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

        // ── Save request details to JSON file ──
        const debugDir = join(process.cwd(), 'logs', 'llm-debug');
        if (!existsSync(debugDir)) mkdirSync(debugDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const reqFile = join(debugDir, `${ts}_request.json`);
        const fullUrl = `${this.config.baseUrl}/chat/completions`;

        const reqData = {
            timestamp: new Date().toISOString(),
            url: fullUrl,
            headers: {
                'content-type': 'application/json',
                'authorization': `Bearer ${this.config.apiKey?.slice(0, 10)}...${this.config.apiKey?.slice(-6)}`,
                ...(this.config.extraHeaders || {}),
            },
            body: params,
        };
        try { writeFileSync(reqFile, JSON.stringify(reqData, null, 2), 'utf-8'); } catch {}

        try {
            const response = await this.client.chat.completions.create(params as any);

            // Save the response to the JSON file (put before parsing to facilitate debugging)
            const resFile = join(debugDir, `${ts}_response.json`);
            try {
                writeFileSync(resFile, JSON.stringify({
                    timestamp: new Date().toISOString(),
                    id: (response as any).id,
                    model: (response as any).model,
                    object: (response as any).object,
                    choices: (response as any).choices,
                    usage: (response as any).usage,
                    raw_keys: Object.keys(response || {}),
                }, null, 2), 'utf-8');
            } catch {}

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
            // Save errors to JSON file
            const errFile = join(debugDir, `${ts}_error.json`);
            try {
                writeFileSync(errFile, JSON.stringify({
                    timestamp: new Date().toISOString(),
                    status: error?.status,
                    message: error?.message,
                    error_body: error?.error,
                    headers: error?.headers ? Object.fromEntries(error.headers.entries?.() || []) : undefined,
                    type: error?.type,
                    code: error?.code,
                }, null, 2), 'utf-8');
            } catch {}
            throw classifyOpenAIError(error, this.config.provider);
        }
    }

    async chatStream(
        messages: LLMMessage[],
        onChunk: (chunk: string) => void
    ): Promise<string> {
        const filteredMessages = messages.filter(m => m.role !== 'tool');
        const params = this.buildBaseParams(filteredMessages);
        (params as any).stream = true;

        try {
            const stream = await this.client.chat.completions.create(params as any);

            let fullResponse = '';

            for await (const chunk of stream as any) {
                const content = chunk.choices[0]?.delta?.content || '';
                if (content) {
                    onChunk(content);
                    fullResponse += content;
                }
            }

            return fullResponse;
        } catch (error: any) {
            throw classifyOpenAIError(error, this.config.provider);
        }
    }

    getConfig(): LLMConfig {
        return this.config;
    }

    async embed(text: string): Promise<number[]> {
        const response = await this.client.embeddings.create({
            model: this.config.embeddingModel || 'text-embedding-3-small',
            input: text,
            encoding_format: 'float',
        });
        return response.data[0].embedding;
    }

    async embedBatch(texts: string[]): Promise<number[][]> {
        const response = await this.client.embeddings.create({
            model: this.config.embeddingModel || 'text-embedding-3-small',
            input: texts,
            encoding_format: 'float',
        });
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
