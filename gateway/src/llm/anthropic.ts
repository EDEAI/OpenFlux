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
} from './provider';
import { classifyAnthropicError } from './llm-error';
import { startLlmLog } from './llm-debug-log';

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

    async chat(messages: LLMMessage[]): Promise<string> {
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
            max_tokens: this.config.maxTokens || 4096,
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
            const response = await this.client.messages.create(requestParams);

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
            throw classifyAnthropicError(error, this.config.provider);
        }
    }

    async chatWithTools(
        messages: LLMMessage[],
        tools: LLMToolDefinition[]
    ): Promise<ChatWithToolsResponse> {
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
            max_tokens: this.config.maxTokens || 4096,
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
            const response = await this.client.messages.create(requestParams);

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
            throw classifyAnthropicError(error, this.config.provider);
        }
    }

    async chatStream(
        messages: LLMMessage[],
        onChunk: (chunk: string) => void
    ): Promise<string> {
        const filteredMessages = messages.filter(m => m.role !== 'tool' && !(m.role === 'assistant' && m.toolCalls?.length));
        const chatMessages = filteredMessages
            .filter(m => m.role !== 'system')
            .map(m => ({
                role: m.role as 'user' | 'assistant',
                content: m.content,
            }));

        const streamParams = {
            model: this.config.model,
            max_tokens: this.config.maxTokens || 4096,
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
            const stream = await this.client.messages.stream(streamParams);

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
            throw classifyAnthropicError(error, this.config.provider);
        }
    }

    getConfig(): LLMConfig {
        return this.config;
    }

    async embed(text: string): Promise<number[]> {
        throw new Error('Anthropic Provider does not support embeddings. Please use OpenAI Provider (or Minimax in OpenAI mode).');
    }

    async embedBatch(texts: string[]): Promise<number[][]> {
        throw new Error('Anthropic Provider does not support embeddings. Please use OpenAI Provider (or Minimax in OpenAI mode).');
    }
}
