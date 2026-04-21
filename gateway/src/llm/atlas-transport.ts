import { Logger } from '../utils/logger';
import type { LLMFetch } from './provider';

const log = new Logger('AtlasTransport');

export type AtlasGatewayProtocol = 'openai' | 'anthropic' | 'google';
export type AtlasGatewaySdkFamily = 'openai' | 'anthropic';

interface AtlasGatewayFetchOptions {
    protocol: AtlasGatewayProtocol;
    sdkFamily: AtlasGatewaySdkFamily;
}

interface AtlasGatewayErrorBody {
    code?: number;
    detail?: string;
}

interface AtlasGatewayDetailParts {
    atlasCode: string;
    atlasMessage: string;
}

export function splitAtlasDetail(detail: string): AtlasGatewayDetailParts {
    const trimmed = (detail || '').trim();
    const separatorIndex = trimmed.indexOf(':');
    if (separatorIndex === -1) {
        return {
            atlasCode: trimmed.toLowerCase(),
            atlasMessage: trimmed,
        };
    }
    return {
        atlasCode: trimmed.slice(0, separatorIndex).trim().toLowerCase(),
        atlasMessage: trimmed.slice(separatorIndex + 1).trim(),
    };
}

export function extractAtlasUpstreamStatus(detail: string): number | undefined {
    const patterns = [
        /\bupstream_status\s*[=:]\s*(\d{3})\b/i,
        /\bstatus(?:\s+code)?\s*[=:]?\s*(\d{3})\b/i,
        /\bhttp\s*(\d{3})\b/i,
    ];
    for (const pattern of patterns) {
        const match = detail.match(pattern);
        if (!match) continue;
        const status = Number(match[1]);
        if (Number.isFinite(status)) return status;
    }
    return undefined;
}

function detectStreamRequest(init?: RequestInit): boolean {
    if (!init?.body || typeof init.body !== 'string') return false;
    try {
        const body = JSON.parse(init.body);
        return body?.stream === true;
    } catch {
        return false;
    }
}

function buildOpenAICompatibleErrorBody(
    status: number,
    detail: string,
    detailParts: AtlasGatewayDetailParts,
    protocol: AtlasGatewayProtocol,
    url: string,
    stream: boolean,
    upstreamStatus?: number,
) {
    return {
        error: {
            message: detail,
            code: detailParts.atlasCode,
            type: 'atlas_gateway',
            detail,
            atlas_status: status,
            atlas_code: detailParts.atlasCode,
            atlas_detail: detail,
            atlas_message: detailParts.atlasMessage,
            atlas_protocol: protocol,
            atlas_url: url,
            atlas_stream: stream,
            ...(upstreamStatus ? { atlas_upstream_status: upstreamStatus } : {}),
        },
    };
}

function buildAnthropicCompatibleErrorBody(
    status: number,
    detail: string,
    detailParts: AtlasGatewayDetailParts,
    protocol: AtlasGatewayProtocol,
    url: string,
    stream: boolean,
    upstreamStatus?: number,
) {
    return {
        message: detail,
        type: 'atlas_gateway',
        code: detailParts.atlasCode,
        detail,
        atlas_status: status,
        atlas_code: detailParts.atlasCode,
        atlas_detail: detail,
        atlas_message: detailParts.atlasMessage,
        atlas_protocol: protocol,
        atlas_url: url,
        atlas_stream: stream,
        ...(upstreamStatus ? { atlas_upstream_status: upstreamStatus } : {}),
    };
}

export function createAtlasGatewayFetch(options: AtlasGatewayFetchOptions): LLMFetch {
    return async (input, init) => {
        const response = await fetch(input, init);
        if (response.ok) return response;

        const responseText = await response.text();
        const headers = new Headers(response.headers);
        const contentType = headers.get('content-type') || '';
        const url = typeof input === 'string'
            ? input
            : input instanceof URL
                ? input.toString()
                : input.url;
        const stream = detectStreamRequest(init);

        if (!contentType.includes('application/json') || !responseText) {
            return new Response(responseText, {
                status: response.status,
                statusText: response.statusText,
                headers,
            });
        }

        let parsed: AtlasGatewayErrorBody | undefined;
        try {
            parsed = JSON.parse(responseText) as AtlasGatewayErrorBody;
        } catch {
            return new Response(responseText, {
                status: response.status,
                statusText: response.statusText,
                headers,
            });
        }

        if (typeof parsed?.detail !== 'string') {
            return new Response(responseText, {
                status: response.status,
                statusText: response.statusText,
                headers,
            });
        }

        const detail = parsed.detail;
        const detailParts = splitAtlasDetail(detail);
        const upstreamStatus = detailParts.atlasCode === 'upstream_http_error'
            ? extractAtlasUpstreamStatus(detail)
            : undefined;

        log.warn('Normalized Atlas gateway error', {
            httpStatus: response.status,
            detail,
            atlasCode: detailParts.atlasCode,
            atlasMessage: detailParts.atlasMessage,
            protocol: options.protocol,
            url,
            stream,
            upstreamStatus,
        });

        const normalizedBody = options.sdkFamily === 'anthropic'
            ? buildAnthropicCompatibleErrorBody(
                response.status,
                detail,
                detailParts,
                options.protocol,
                url,
                stream,
                upstreamStatus,
            )
            : buildOpenAICompatibleErrorBody(
                response.status,
                detail,
                detailParts,
                options.protocol,
                url,
                stream,
                upstreamStatus,
            );

        return new Response(JSON.stringify(normalizedBody), {
            status: response.status,
            statusText: response.statusText,
            headers,
        });
    };
}
