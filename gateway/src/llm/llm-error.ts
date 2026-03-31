/**
 * LLM 统一错误类型
 * 各 Provider 将原始 API 错误映射为此类型，Agent Loop 据此决定 fallback 策略
 */

export type LLMErrorCategory =
    | 'CONTENT_FILTERED'     // 内容审核拒绝 → 切 fallback
    | 'RATE_LIMITED'         // 速率限制 → 退避重试 → fallback
    | 'CONTEXT_TOO_LONG'    // 上下文超限 → 压缩消息重试
    | 'SERVICE_UNAVAILABLE' // 服务不可用 → 切 fallback
    | 'AUTH_ERROR'          // 认证失败 → 报错不重试
    | 'UNKNOWN';            // 其他 → 报错

export class LLMError extends Error {
    category: LLMErrorCategory;
    statusCode?: number;
    provider: string;
    retryable: boolean;

    constructor(
        message: string,
        category: LLMErrorCategory,
        provider: string,
        options?: { statusCode?: number; cause?: Error }
    ) {
        super(message);
        this.name = 'LLMError';
        this.category = category;
        this.provider = provider;
        this.statusCode = options?.statusCode;
        this.cause = options?.cause;

        // 可重试的错误类别
        this.retryable = ['CONTENT_FILTERED', 'RATE_LIMITED', 'SERVICE_UNAVAILABLE'].includes(category);
    }
}

/**
 * 从 OpenAI 兼容 API 的错误中推断错误类别
 * 适用于 OpenAI / Moonshot / DeepSeek / Zhipu / Ollama 等
 */
export function classifyOpenAIError(error: any, provider: string): LLMError {
    const status = error?.status || error?.statusCode || 0;
    const message = error?.message || String(error);
    const errorBody = error?.error?.message || error?.error?.detail || '';
    const fullMsg = `${message} ${errorBody}`.toLowerCase();

    // Debug: dump raw error for diagnosis
    console.error('[LLMError] Raw error dump', {
        status,
        message,
        errorBody,
        errorType: error?.type,
        errorCode: error?.code || error?.error?.code,
        responseBody: error?.response?.body ? JSON.stringify(error.response.body).slice(0, 500) : undefined,
        rawError: error?.error ? JSON.stringify(error.error).slice(0, 500) : undefined,
    });

    // ── Atlas 网关特定错误码（V2 文档 §10） ──
    if (fullMsg.includes('invalid_token')) {
        return new LLMError('Atlas: access token 无效或过期，请重新登录', 'AUTH_ERROR', provider, { statusCode: status, cause: error });
    }
    if (fullMsg.includes('quota_blocked')) {
        return new LLMError('Atlas: 用户配额已耗尽', 'RATE_LIMITED', provider, { statusCode: status, cause: error });
    }
    if (fullMsg.includes('content_blocked')) {
        return new LLMError('Atlas: 请求被内容安全策略拦截', 'CONTENT_FILTERED', provider, { statusCode: status, cause: error });
    }
    if (fullMsg.includes('no_available_model')) {
        return new LLMError('Atlas: 当前组织未配置 OpenFlux 默认模型', 'AUTH_ERROR', provider, { statusCode: status, cause: error });
    }
    if (fullMsg.includes('no_org_context')) {
        return new LLMError('Atlas: 当前账号无 Atlas 组织上下文', 'AUTH_ERROR', provider, { statusCode: status, cause: error });
    }
    if (fullMsg.includes('upstream_request_failed') || fullMsg.includes('upstream_http_error')) {
        return new LLMError('Atlas: 上游模型服务异常', 'SERVICE_UNAVAILABLE', provider, { statusCode: status, cause: error });
    }

    // 401/403: 认证错误
    if (status === 401 || status === 403) {
        return new LLMError(message, 'AUTH_ERROR', provider, { statusCode: status, cause: error });
    }

    // 429: 限流
    if (status === 429) {
        return new LLMError(message, 'RATE_LIMITED', provider, { statusCode: status, cause: error });
    }

    // 400: 需要细分
    if (status === 400) {
        // 内容审核
        if (fullMsg.includes('high risk') ||
            fullMsg.includes('content_filter') ||
            fullMsg.includes('content_policy') ||
            fullMsg.includes('content moderation') ||
            fullMsg.includes('safety') ||
            fullMsg.includes('sensitive') ||
            fullMsg.includes('违规') ||
            fullMsg.includes('审核')) {
            return new LLMError(message, 'CONTENT_FILTERED', provider, { statusCode: status, cause: error });
        }
        // 上下文超限
        const errorCode = (error?.code || error?.error?.code || '').toLowerCase();
        if (errorCode === 'context_length_exceeded' ||
            fullMsg.includes('context_length') ||
            fullMsg.includes('maximum context') ||
            fullMsg.includes('too long') ||
            fullMsg.includes('token limit') ||
            fullMsg.includes('tokens exceed') ||
            fullMsg.includes('reduce the length') ||
            fullMsg.includes('too many tokens') ||
            (fullMsg.includes('max_tokens') && fullMsg.includes('exceed'))) {
            return new LLMError(message, 'CONTEXT_TOO_LONG', provider, { statusCode: status, cause: error });
        }
    }

    // 5xx: 服务不可用
    if (status >= 500) {
        return new LLMError(message, 'SERVICE_UNAVAILABLE', provider, { statusCode: status, cause: error });
    }

    return new LLMError(message, 'UNKNOWN', provider, { statusCode: status, cause: error });
}

/**
 * 从 Anthropic API 的错误中推断错误类别
 */
export function classifyAnthropicError(error: any, provider: string): LLMError {
    const status = error?.status || error?.statusCode || 0;
    const message = error?.message || String(error);
    const fullMsg = message.toLowerCase();

    if (status === 401 || status === 403) {
        return new LLMError(message, 'AUTH_ERROR', provider, { statusCode: status, cause: error });
    }

    if (status === 429) {
        return new LLMError(message, 'RATE_LIMITED', provider, { statusCode: status, cause: error });
    }

    if (status === 400) {
        if (fullMsg.includes('content moderation') || fullMsg.includes('safety') || fullMsg.includes('harmful')) {
            return new LLMError(message, 'CONTENT_FILTERED', provider, { statusCode: status, cause: error });
        }
        if (fullMsg.includes('too many tokens') || fullMsg.includes('context window') || fullMsg.includes('max_tokens')) {
            return new LLMError(message, 'CONTEXT_TOO_LONG', provider, { statusCode: status, cause: error });
        }
    }

    if (status >= 500 || status === 529) {
        return new LLMError(message, 'SERVICE_UNAVAILABLE', provider, { statusCode: status, cause: error });
    }

    return new LLMError(message, 'UNKNOWN', provider, { statusCode: status, cause: error });
}
