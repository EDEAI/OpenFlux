/**
 * LLM Provider interface definition
 * Support native Tool Calling (Function Calling)
 */

// ========================
// Message type
// ========================

/** Multimodal content block: text */
export interface LLMTextPart {
    type: 'text';
    text: string;
}

/** Multimodal content block: image (base64) */
export interface LLMImagePart {
    type: 'image';
    /** MIME type, such as image/png, image/jpeg */
    mimeType: string;
    /** base64 encoded image data */
    data: string;
}

/** Multimodal content blocks */
export type LLMContentPart = LLMTextPart | LLMImagePart;

export interface LLMMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    /** Multimodal content (priority to the content field, used to carry non-text content such as images) */
    contentParts?: LLMContentPart[];
    /** List of tool calls in assistant messages */
    toolCalls?: LLMToolCall[];
    /** tool call ID associated with the tool message */
    toolCallId?: string;
    /** Reasoning content (Kimi K2.5 and other models that support thinking mode) */
    reasoningContent?: string;
}

// ========================
// Tool call type
// ========================

/** Tool call returned by LLM */
export interface LLMToolCall {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}

/** Tool definition passed to LLM (JSON Schema format) */
export interface LLMToolDefinition {
    name: string;
    description: string;
    parameters: {
        type: 'object';
        properties: Record<string, unknown>;
        required: string[];
    };
}

/** The return value of chatWithTools */
export interface ChatWithToolsResponse {
    /** Text content */
    content: string;
    /** Tool call list (empty array when no tool is called) */
    toolCalls: LLMToolCall[];
    /** Reasoning content (Kimi K2.5 and other models that support thinking mode) */
    reasoningContent?: string;
}

/** Incremental fragments emitted by a tool-capable streaming response. */
export interface LLMToolCallDelta {
    index: number;
    id?: string;
    name?: string;
    arguments?: string;
}

/**
 * Provider-neutral callbacks for streaming responses that may contain tool calls.
 * Reasoning deltas are deliberately kept separate from public text deltas so the
 * Agent runtime can withhold private model reasoning from clients.
 */
export interface ChatWithToolsStreamCallbacks {
    onFirstChunk?: () => void;
    onContentDelta?: (delta: string) => void;
    onReasoningDelta?: (delta: string) => void;
    onToolCallDelta?: (delta: LLMToolCallDelta) => void;
}

// ========================
// Configuration
// ========================

export type LLMFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type LLMProtocol = 'openai' | 'anthropic' | 'google';

export interface LLMPolicyRetry {
    retryable: boolean;
    reason: string;
    stage: string;
    current_protocol?: LLMProtocol;
    target_protocol: LLMProtocol;
    target_model_id: number | string;
    target_model_name?: string;
    target_model_config_id?: number | string;
    current_model_config_id?: number | string;
    source_request_id?: string;
    max_retry?: number;
}

export interface LLMConfig {
    provider: 'anthropic' | 'openai' | 'google' | 'ollama' | 'minimax' | 'deepseek' | 'zhipu' | 'moonshot' | 'custom' | 'local';
    model: string;
    apiKey?: string;
    baseUrl?: string;
    temperature?: number;
    maxTokens?: number;
    embeddingModel?: string;
    /** Additional HTTP request header (atlas_managed mode injection Authorization, etc.) */
    extraHeaders?: Record<string, string>;
    /** Optional custom fetch (used for Atlas gateway error normalization and other scenarios) */
    fetch?: LLMFetch;
}

// ========================
// Provider interface
// ========================

/** chat() 的单次调用选项 */
export interface ChatOptions {
    /** 覆盖本次调用的输出 token 上限。
     *  思考型模型（kimi/deepseek-r1 等）的推理内容也计入该额度，
     *  意图归纳这类"先想后写"的后台调用需要比默认值大得多的预算。 */
    maxTokens?: number;
    /** Cooperative cancellation for this provider request. */
    signal?: AbortSignal;
}

export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
    return signal?.aborted === true
        || (error instanceof Error && (error.name === 'AbortError' || error.name === 'APIUserAbortError'));
}

export function throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted();
    const error = new Error('Operation aborted');
    error.name = 'AbortError';
    throw error;
}

export interface LLMProvider {
    /**
     * Plain text chat (without tools)
     */
    chat(messages: LLMMessage[], opts?: ChatOptions): Promise<string>;

    /**
     * Streaming chat (without tools)
     */
    chatStream(
        messages: LLMMessage[],
        onChunk: (chunk: string) => void,
        opts?: ChatOptions,
    ): Promise<string>;

    /**
     * Chat with tools (native Function Calling)
     * Return structured tool calls, no longer relying on text parsing
     */
    chatWithTools(
        messages: LLMMessage[],
        tools: LLMToolDefinition[],
        opts?: ChatOptions,
    ): Promise<ChatWithToolsResponse>;

    /**
     * Streaming tool-capable chat. Optional for compatibility with custom and
     * test providers; callers must fall back to chatWithTools when unavailable.
     */
    chatWithToolsStream?(
        messages: LLMMessage[],
        tools: LLMToolDefinition[],
        callbacks: ChatWithToolsStreamCallbacks,
        opts?: ChatOptions,
    ): Promise<ChatWithToolsResponse>;

    /**
     * Get current configuration
     */
    getConfig(): LLMConfig;

    /**
     * Generate text embedding (single)
     */
    embed(text: string, opts?: ChatOptions): Promise<number[]>;

    /**
     * Generate text embeddings (batch)
     */
    embedBatch(texts: string[], opts?: ChatOptions): Promise<number[][]>;
}
