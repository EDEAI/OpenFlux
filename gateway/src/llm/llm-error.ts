/**
 * LLM 统一错误类型
 * 各 Provider 将原始 API 错误映射为此类型，Agent Loop 据此决定 fallback 策略
 */

import { extractAtlasUpstreamStatus, splitAtlasDetail } from './atlas-transport';

export type LLMErrorCategory =
    | 'CONTENT_FILTERED'     // 内容审核拒绝 → 切 fallback
    | 'RATE_LIMITED'         // 速率限制 → 退避重试 → fallback
    | 'CONTEXT_TOO_LONG'     // 上下文超限 → 压缩消息重试
    | 'SERVICE_UNAVAILABLE'  // 服务不可用 → 切 fallback
    | 'AUTH_ERROR'           // 认证失败 → 报错不重试
    | 'UNKNOWN';             // 其他 → 报错

export type LLMRecoveryAction =
    | 'reauth'
    | 'fix_request'
    | 'contact_admin'
    | 'retry_later'
    | 'none';

interface LLMErrorOptions {
    statusCode?: number;
    cause?: Error;
    retryable?: boolean;
    atlasCode?: string;
    atlasDetail?: string;
    recoveryAction?: LLMRecoveryAction;
    allowModelFallback?: boolean;
}

export class LLMError extends Error {
    category: LLMErrorCategory;
    statusCode?: number;
    provider: string;
    retryable: boolean;
    atlasCode?: string;
    atlasDetail?: string;
    recoveryAction: LLMRecoveryAction;
    allowModelFallback: boolean;

    constructor(
        message: string,
        category: LLMErrorCategory,
        provider: string,
        options?: LLMErrorOptions,
    ) {
        super(message);
        this.name = 'LLMError';
        this.category = category;
        this.provider = provider;
        this.statusCode = options?.statusCode;
        this.cause = options?.cause;
        this.atlasCode = options?.atlasCode;
        this.atlasDetail = options?.atlasDetail;
        this.recoveryAction = options?.recoveryAction || 'none';

        // 可重试的错误类别
        this.retryable = options?.retryable ?? ['CONTENT_FILTERED', 'RATE_LIMITED', 'SERVICE_UNAVAILABLE'].includes(category);
        this.allowModelFallback = options?.allowModelFallback ?? this.retryable;
    }
}

interface AtlasErrorContext {
    status: number;
    detail: string;
    atlasCode: string;
    atlasMessage: string;
    upstreamStatus?: number;
}

function toLowerString(value: unknown): string {
    return typeof value === 'string' ? value.toLowerCase() : '';
}

function createLLMError(
    message: string,
    category: LLMErrorCategory,
    provider: string,
    options?: LLMErrorOptions,
): LLMError {
    return new LLMError(message, category, provider, options);
}

function classifyGenericProviderError(
    status: number,
    message: string,
    provider: string,
    options?: {
        cause?: Error;
        errorCode?: string;
        recoveryAction?: LLMRecoveryAction;
        allowModelFallback?: boolean;
        atlasCode?: string;
        atlasDetail?: string;
    },
): LLMError {
    const fullMsg = message.toLowerCase();
    const errorCode = (options?.errorCode || '').toLowerCase();
    const sharedOptions: LLMErrorOptions = {
        statusCode: status,
        cause: options?.cause,
        recoveryAction: options?.recoveryAction,
        allowModelFallback: options?.allowModelFallback,
        atlasCode: options?.atlasCode,
        atlasDetail: options?.atlasDetail,
    };

    if (status === 401 || status === 403) {
        return createLLMError(message, 'AUTH_ERROR', provider, sharedOptions);
    }

    if (status === 429) {
        return createLLMError(message, 'RATE_LIMITED', provider, sharedOptions);
    }

    if (status === 400) {
        if (fullMsg.includes('high risk') ||
            fullMsg.includes('content_filter') ||
            fullMsg.includes('content_policy') ||
            fullMsg.includes('content moderation') ||
            fullMsg.includes('safety') ||
            fullMsg.includes('sensitive') ||
            fullMsg.includes('违规') ||
            fullMsg.includes('审核')) {
            return createLLMError(message, 'CONTENT_FILTERED', provider, sharedOptions);
        }

        if (errorCode === 'context_length_exceeded' ||
            fullMsg.includes('context_length') ||
            fullMsg.includes('maximum context') ||
            fullMsg.includes('too long') ||
            fullMsg.includes('token limit') ||
            fullMsg.includes('tokens exceed') ||
            fullMsg.includes('reduce the length') ||
            fullMsg.includes('too many tokens') ||
            (fullMsg.includes('max_tokens') && fullMsg.includes('exceed'))) {
            return createLLMError(message, 'CONTEXT_TOO_LONG', provider, sharedOptions);
        }
    }

    if (status >= 500 || status === 529) {
        return createLLMError(message, 'SERVICE_UNAVAILABLE', provider, sharedOptions);
    }

    return createLLMError(message, 'UNKNOWN', provider, sharedOptions);
}

function extractAtlasErrorContext(error: any): AtlasErrorContext | null {
    const body = error?.error;
    const detail = body?.atlas_detail || body?.detail;
    const atlasCode = body?.atlas_code || body?.code;
    const atlasMessage = body?.atlas_message;
    const bodyType = body?.type;

    if (bodyType !== 'atlas_gateway' && !detail && !atlasCode) {
        return null;
    }

    const detailText = typeof detail === 'string'
        ? detail
        : typeof error?.message === 'string'
            ? error.message
            : '';

    if (!detailText) {
        return null;
    }

    const detailParts = atlasCode && atlasMessage
        ? { atlasCode: String(atlasCode).toLowerCase(), atlasMessage: String(atlasMessage) }
        : splitAtlasDetail(detailText);

    const upstreamStatus = body?.atlas_upstream_status || extractAtlasUpstreamStatus(detailText);

    return {
        status: error?.status || error?.statusCode || 0,
        detail: detailText,
        atlasCode: detailParts.atlasCode,
        atlasMessage: detailParts.atlasMessage,
        upstreamStatus: typeof upstreamStatus === 'number' ? upstreamStatus : undefined,
    };
}

function classifyAtlasGatewayError(error: any, provider: string, atlas: AtlasErrorContext): LLMError {
    const sharedOptions: LLMErrorOptions = {
        statusCode: atlas.status,
        cause: error,
        atlasCode: atlas.atlasCode,
        atlasDetail: atlas.detail,
        allowModelFallback: false,
    };

    if (atlas.atlasCode === 'upstream_http_error') {
        const upstreamMessage = atlas.atlasMessage || atlas.detail;
        if (atlas.upstreamStatus) {
            const upstreamError = classifyGenericProviderError(
                atlas.upstreamStatus,
                upstreamMessage,
                provider,
                {
                    cause: error,
                    recoveryAction: 'none',
                    atlasCode: atlas.atlasCode,
                    atlasDetail: atlas.detail,
                },
            );
            upstreamError.atlasCode = atlas.atlasCode;
            upstreamError.atlasDetail = atlas.detail;
            upstreamError.recoveryAction = 'none';
            return upstreamError;
        }
        return createLLMError(
            `上游模型服务异常：${upstreamMessage || '请求失败'}`,
            'SERVICE_UNAVAILABLE',
            provider,
            {
                ...sharedOptions,
                recoveryAction: 'none',
                allowModelFallback: true,
            },
        );
    }

    switch (`${atlas.status}:${atlas.atlasCode}`) {
        case '401:invalid_token':
            return createLLMError(
                'NexusAI 登录状态已失效，请重新登录',
                'AUTH_ERROR',
                provider,
                {
                    ...sharedOptions,
                    recoveryAction: 'reauth',
                },
            );
        case '400:invalid_request_body':
            return createLLMError(
                '请求参数无效，请检查当前请求内容',
                'UNKNOWN',
                provider,
                {
                    ...sharedOptions,
                    recoveryAction: 'fix_request',
                },
            );
        case '404:invalid_request_path':
            return createLLMError(
                '模型网关接线路径无效，请检查 Atlas 网关配置',
                'UNKNOWN',
                provider,
                {
                    ...sharedOptions,
                    recoveryAction: 'fix_request',
                },
            );
        case '403:no_org_context':
            return createLLMError(
                '当前账号没有可用的 Atlas 组织上下文，请联系管理员检查组织权限',
                'UNKNOWN',
                provider,
                {
                    ...sharedOptions,
                    recoveryAction: 'contact_admin',
                },
            );
        case '503:no_available_model':
            return createLLMError(
                '当前组织未配置 OpenFlux 默认模型，请联系管理员完成模型配置',
                'UNKNOWN',
                provider,
                {
                    ...sharedOptions,
                    recoveryAction: 'contact_admin',
                },
            );
        case '403:quota_blocked':
            return createLLMError(
                '当前配额不足，请稍后再试或联系管理员扩容',
                'RATE_LIMITED',
                provider,
                {
                    ...sharedOptions,
                    recoveryAction: 'retry_later',
                },
            );
        case '403:content_blocked':
            return createLLMError(
                '请求被内容安全策略拦截，请调整内容后重试',
                'CONTENT_FILTERED',
                provider,
                {
                    ...sharedOptions,
                    recoveryAction: 'none',
                },
            );
        case '502:rewrite_request_failed':
        case '502:build_request_failed':
        case '502:read_response_failed':
            return createLLMError(
                '模型网关内部处理失败，请稍后重试',
                'SERVICE_UNAVAILABLE',
                provider,
                {
                    ...sharedOptions,
                    recoveryAction: 'none',
                },
            );
        case '502:upstream_request_failed':
            return createLLMError(
                '上游模型服务请求失败，请稍后重试',
                'SERVICE_UNAVAILABLE',
                provider,
                {
                    ...sharedOptions,
                    recoveryAction: 'none',
                },
            );
        default:
            return classifyGenericProviderError(
                atlas.status,
                atlas.detail,
                provider,
                {
                    cause: error,
                    recoveryAction: 'none',
                    allowModelFallback: false,
                    atlasCode: atlas.atlasCode,
                    atlasDetail: atlas.detail,
                },
            );
    }
}

/**
 * 从 OpenAI 兼容 API 的错误中推断错误类别
 * 适用于 OpenAI / Moonshot / DeepSeek / Zhipu / Ollama 等
 */
export function classifyOpenAIError(error: any, provider: string): LLMError {
    const atlasContext = extractAtlasErrorContext(error);
    if (atlasContext) {
        return classifyAtlasGatewayError(error, provider, atlasContext);
    }

    const status = error?.status || error?.statusCode || 0;
    const message = error?.message || String(error);
    const errorBody = error?.error?.message || error?.error?.detail || '';
    const mergedMessage = `${message} ${errorBody}`.trim();
    const errorCode = toLowerString(error?.code || error?.error?.code);

    return classifyGenericProviderError(status, mergedMessage || message, provider, {
        cause: error,
        errorCode,
    });
}

/**
 * 从 Anthropic API 的错误中推断错误类别
 */
export function classifyAnthropicError(error: any, provider: string): LLMError {
    const atlasContext = extractAtlasErrorContext(error);
    if (atlasContext) {
        return classifyAtlasGatewayError(error, provider, atlasContext);
    }

    const status = error?.status || error?.statusCode || 0;
    const message = error?.message || String(error);
    const errorCode = toLowerString(error?.error?.code || error?.code);

    return classifyGenericProviderError(status, message, provider, {
        cause: error,
        errorCode,
    });
}
