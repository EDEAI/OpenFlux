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

export class OpenAIProvider implements LLMProvider {
    private client: OpenAI;
    private config: LLMConfig;

    constructor(config: LLMConfig) {
        this.config = config;
        this.client = new OpenAI({
            apiKey: config.apiKey || process.env.OPENAI_API_KEY,
            baseURL: config.baseUrl,
        });
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
        const params: Record<string, unknown> = {
            model: this.config.model,
            messages: this.convertMessages(messages),
            max_tokens: this.config.maxTokens,
        };

        if (this.config.temperature !== undefined) {
            params.temperature = this.config.temperature;
        }

        return params;
    }

    async chat(messages: LLMMessage[]): Promise<string> {
        // 过滤掉 tool 消息，保持向后兼容
        const filteredMessages = messages.filter(m => m.role !== 'tool');
        const params = this.buildBaseParams(filteredMessages);

        const response = await this.client.chat.completions.create(params as any);
        return response.choices[0]?.message?.content || '';
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

        const response = await this.client.chat.completions.create(params as any);
        const message = response.choices[0]?.message;

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
    }

    async chatStream(
        messages: LLMMessage[],
        onChunk: (chunk: string) => void
    ): Promise<string> {
        const filteredMessages = messages.filter(m => m.role !== 'tool');
        const params = this.buildBaseParams(filteredMessages);
        (params as any).stream = true;

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
    try {
        return JSON.parse(str || '{}');
    } catch {
        return {};
    }
}
