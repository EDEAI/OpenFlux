/**
 * Anthropic (Claude) Provider
 * 适用于 Anthropic / MiniMax(Anthropic 兼容模式) 等
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

export class AnthropicProvider implements LLMProvider {
    private client: Anthropic;
    private config: LLMConfig;

    constructor(config: LLMConfig) {
        this.config = config;
        this.client = new Anthropic({
            apiKey: config.apiKey || process.env.ANTHROPIC_API_KEY,
            baseURL: config.baseUrl,
        });
    }

    /**
     * 将统一消息格式转为 Anthropic 格式
     * Anthropic 要求 user/assistant 交替，tool_result 放在 user 消息中
     */
    private convertMessages(messages: LLMMessage[]): Anthropic.MessageParam[] {
        const result: Anthropic.MessageParam[] = [];
        const nonSystemMessages = messages.filter(m => m.role !== 'system');

        let i = 0;
        while (i < nonSystemMessages.length) {
            const msg = nonSystemMessages[i];

            if (msg.role === 'user') {
                // user 消息可能携带多模态内容（图片等）
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
                    // assistant 消息带工具调用 → 混合 content blocks
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
                // 收集连续的 tool 消息，合并为一条 user 消息（Anthropic 要求）
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
     * 获取 system 消息
     */
    private getSystemContent(messages: LLMMessage[]): string | undefined {
        return messages.find(m => m.role === 'system')?.content;
    }

    async chat(messages: LLMMessage[]): Promise<string> {
        // 过滤掉 tool 消息，保持向后兼容
        const filteredMessages = messages.filter(m => m.role !== 'tool' && !(m.role === 'assistant' && m.toolCalls?.length));
        const chatMessages = filteredMessages
            .filter(m => m.role !== 'system')
            .map(m => ({
                role: m.role as 'user' | 'assistant',
                content: m.content,
            }));

        const response = await this.client.messages.create({
            model: this.config.model,
            max_tokens: this.config.maxTokens || 4096,
            system: this.getSystemContent(messages),
            messages: chatMessages,
        });

        const textBlock = response.content.find(c => c.type === 'text');
        return textBlock?.text || '';
    }

    async chatWithTools(
        messages: LLMMessage[],
        tools: LLMToolDefinition[]
    ): Promise<ChatWithToolsResponse> {
        const anthropicMessages = this.convertMessages(messages);

        // 转换工具定义为 Anthropic 格式
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

        // 只在有工具时传递 tools 参数
        if (anthropicTools.length > 0) {
            requestParams.tools = anthropicTools;
        }

        const response = await this.client.messages.create(requestParams);

        // 解析响应 content blocks
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

        let fullResponse = '';

        const stream = await this.client.messages.stream({
            model: this.config.model,
            max_tokens: this.config.maxTokens || 4096,
            system: this.getSystemContent(messages),
            messages: chatMessages,
        });

        for await (const event of stream) {
            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                onChunk(event.delta.text);
                fullResponse += event.delta.text;
            }
        }

        return fullResponse;
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
