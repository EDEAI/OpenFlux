/**
 * OpenAI Provider
 * 适用于 OpenAI / Kimi(Moonshot) / Deepseek / Zhipu / Ollama 等 OpenAI 兼容 API
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

    /** 检测是否为 DeepSeek 模型 */
    private get isDeepSeek(): boolean {
        return this.config.provider === 'deepseek' ||
            !!this.config.baseUrl?.includes('deepseek') ||
            !!this.config.model?.startsWith('deepseek');
    }

    /** 检测是否需要使用 max_completion_tokens（OpenAI 官方 API 已弃用 max_tokens） */
    private get useMaxCompletionTokens(): boolean {
        // OpenAI 原生 provider 统一使用 max_completion_tokens
        // 第三方兼容 API（DeepSeek/Kimi/Ollama 等）仍用 max_tokens
        return this.config.provider === 'openai' && !this.isDeepSeek;
    }

    /**
     * 将统一消息格式转为 OpenAI 格式
     * 处理 tool 角色和 assistant 的 toolCalls
     */
    private convertMessages(messages: LLMMessage[]): OpenAI.ChatCompletionMessageParam[] {
        return messages.map((m): OpenAI.ChatCompletionMessageParam => {
            // 工具结果消息
            if (m.role === 'tool') {
                return {
                    role: 'tool',
                    tool_call_id: m.toolCallId || '',
                    content: m.content,
                };
            }

            // assistant 消息带工具调用
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
                // Kimi K2.5 等模型要求 thinking 模式下 assistant tool call 消息必须携带 reasoning_content
                if (m.reasoningContent !== undefined) {
                    msg.reasoning_content = m.reasoningContent;
                }
                return msg as unknown as OpenAI.ChatCompletionMessageParam;
            }

            // 普通消息（system / user / assistant）
            // user 消息可能携带多模态内容（图片等）
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
     * 构建通用请求参数
     */
    private buildBaseParams(messages: LLMMessage[]): Record<string, unknown> {
        // DeepSeek V3 默认 max_tokens = 8192（官方支持最大 8K 输出，思考模式 64K）
        let maxTokens = this.config.maxTokens;
        if (this.isDeepSeek && (!maxTokens || maxTokens < 8192)) {
            maxTokens = 8192;
        }

        const params: Record<string, unknown> = {
            model: this.config.model,
            messages: this.convertMessages(messages),
        };

        // OpenAI 新模型（o1/o3/gpt-4o 等）要求 max_completion_tokens，老模型用 max_tokens
        if (maxTokens) {
            if (this.useMaxCompletionTokens) {
                params.max_completion_tokens = maxTokens;
            } else {
                params.max_tokens = maxTokens;
            }
        }

        // DeepSeek 思考模式忽略 temperature（官方文档：设置了不会生效）
        if (this.config.temperature !== undefined && !this.isDeepSeek) {
            params.temperature = this.config.temperature;
        }

        return params;
    }

    async chat(messages: LLMMessage[]): Promise<string> {
        // 过滤掉 tool 消息，保持向后兼容
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

        // 添加工具定义
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

        // DeepSeek 思考模式：自动注入 thinking 参数
        if (this.isDeepSeek) {
            (params as any).thinking = { type: 'enabled', budget_tokens: 4096 };
        }

        // ── 将请求详情保存到 JSON 文件 ──
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

            // 保存响应到 JSON 文件（放在解析之前，方便调试）
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

            // 安全解析 choices
            const choices = (response as any).choices;
            if (!choices || !choices[0]) {
                throw new Error(`Atlas responded without choices. Response keys: ${Object.keys(response || {}).join(', ')}`);
            }
            const message = choices[0].message;

            // 解析工具调用
            const toolCalls: LLMToolCall[] = (message?.tool_calls || []).map(tc => ({
                id: tc.id,
                name: tc.function.name,
                arguments: safeParseJson(tc.function.arguments),
            }));

            // 捕获 reasoning_content（Kimi K2.5 thinking 模式）
            const reasoningContent = (message as any)?.reasoning_content as string | undefined;

            return {
                content: message?.content || '',
                toolCalls,
                reasoningContent,
            };
        } catch (error: any) {
            // 保存错误到 JSON 文件
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
 * 安全解析 JSON 字符串，失败时返回空对象
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
