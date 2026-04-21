/**
 * LLM Provider 接口定义
 * 支持原生 Tool Calling（Function Calling）
 */

// ========================
// 消息类型
// ========================

/** 多模态内容块：文本 */
export interface LLMTextPart {
    type: 'text';
    text: string;
}

/** 多模态内容块：图片（base64） */
export interface LLMImagePart {
    type: 'image';
    /** MIME 类型，如 image/png, image/jpeg */
    mimeType: string;
    /** base64 编码的图片数据 */
    data: string;
}

/** 多模态内容块 */
export type LLMContentPart = LLMTextPart | LLMImagePart;

export interface LLMMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    /** 多模态内容（优先于 content 字段，用于携带图片等非文本内容） */
    contentParts?: LLMContentPart[];
    /** assistant 消息中的工具调用列表 */
    toolCalls?: LLMToolCall[];
    /** tool 消息关联的工具调用 ID */
    toolCallId?: string;
    /** 推理内容（Kimi K2.5 等支持 thinking 模式的模型） */
    reasoningContent?: string;
}

// ========================
// 工具调用类型
// ========================

/** LLM 返回的工具调用 */
export interface LLMToolCall {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}

/** 传给 LLM 的工具定义（JSON Schema 格式） */
export interface LLMToolDefinition {
    name: string;
    description: string;
    parameters: {
        type: 'object';
        properties: Record<string, unknown>;
        required: string[];
    };
}

/** chatWithTools 的返回值 */
export interface ChatWithToolsResponse {
    /** 文本内容 */
    content: string;
    /** 工具调用列表（无工具调用时为空数组） */
    toolCalls: LLMToolCall[];
    /** 推理内容（Kimi K2.5 等支持 thinking 模式的模型） */
    reasoningContent?: string;
}

// ========================
// 配置
// ========================

export type LLMFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface LLMConfig {
    provider: 'anthropic' | 'openai' | 'google' | 'ollama' | 'minimax' | 'deepseek' | 'zhipu' | 'moonshot' | 'custom' | 'local';
    model: string;
    apiKey?: string;
    baseUrl?: string;
    temperature?: number;
    maxTokens?: number;
    embeddingModel?: string;
    /** 额外 HTTP 请求头（atlas_managed 模式注入 Authorization 等） */
    extraHeaders?: Record<string, string>;
    /** 可选自定义 fetch（用于 Atlas 网关错误归一化等场景） */
    fetch?: LLMFetch;
}

// ========================
// Provider 接口
// ========================

export interface LLMProvider {
    /**
     * 纯文本聊天（不带工具）
     */
    chat(messages: LLMMessage[]): Promise<string>;

    /**
     * 流式聊天（不带工具）
     */
    chatStream(
        messages: LLMMessage[],
        onChunk: (chunk: string) => void
    ): Promise<string>;

    /**
     * 带工具的聊天（原生 Function Calling）
     * 返回结构化的工具调用，不再依赖文本解析
     */
    chatWithTools(
        messages: LLMMessage[],
        tools: LLMToolDefinition[]
    ): Promise<ChatWithToolsResponse>;

    /**
     * 获取当前配置
     */
    getConfig(): LLMConfig;

    /**
     * 生成文本嵌入 (单个)
     */
    embed(text: string): Promise<number[]>;

    /**
     * 生成文本嵌入 (批量)
     */
    embedBatch(texts: string[]): Promise<number[][]>;
}
