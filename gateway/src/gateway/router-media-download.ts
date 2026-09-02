export type RouterMediaFetchResult =
    | { ok: true; response: Response }
    | { ok: false; reason: string; status?: number };

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type Sleep = (delayMs: number) => Promise<void>;

const RETRY_DELAYS_MS = [500, 1_000, 2_000];

export function isRetryableRouterMediaStatus(status: number): boolean {
    return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function routerMediaFailureReason(status: number): string {
    switch (status) {
        case 401:
        case 403:
            return '附件访问鉴权失败';
        case 404:
            return '附件链接不存在';
        case 410:
            return '附件链接已经过期';
        case 413:
            return '附件超过 50MB 限制';
        case 429:
            return '平台请求过于频繁';
        case 502:
            return '平台附件暂未准备好';
        case 503:
            return 'Router 附件服务暂时繁忙';
        case 504:
            return '平台附件读取超时';
        default:
            return `下载服务返回 HTTP ${status}`;
    }
}

export async function fetchRouterMediaWithRetry(
    url: string,
    headers: Record<string, string>,
    options: {
        fetcher?: FetchLike;
        sleep?: Sleep;
        retryDelaysMs?: number[];
    } = {},
): Promise<RouterMediaFetchResult> {
    const fetcher = options.fetcher || fetch;
    const sleep = options.sleep || (delayMs => new Promise(resolve => setTimeout(resolve, delayMs)));
    const retryDelays = options.retryDelaysMs || RETRY_DELAYS_MS;
    let lastNetworkError = '';

    for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
        try {
            const response = await fetcher(url, { headers });
            if (response.ok && response.body) {
                return { ok: true, response };
            }

            const status = response.status;
            const retryable = isRetryableRouterMediaStatus(status);
            if (retryable && attempt < retryDelays.length) {
                try { await response.body?.cancel(); } catch { /* ignore cleanup failure */ }
                await sleep(retryDelays[attempt]);
                continue;
            }
            try { await response.body?.cancel(); } catch { /* ignore cleanup failure */ }
            if (response.ok) {
                return { ok: false, status, reason: '附件响应内容为空' };
            }
            return { ok: false, status, reason: routerMediaFailureReason(status) };
        } catch (error) {
            lastNetworkError = error instanceof Error ? error.message : String(error);
            if (attempt < retryDelays.length) {
                await sleep(retryDelays[attempt]);
                continue;
            }
        }
    }

    return {
        ok: false,
        reason: lastNetworkError ? `网络请求失败：${lastNetworkError}` : '网络请求失败',
    };
}

export function shouldRunRouterAgentForAttachment(isMedia: boolean, attachmentCount: number): boolean {
    return !isMedia || attachmentCount > 0;
}

export function routerAttachmentFailureMessage(
    platformType: string,
    contentType: string,
    reason: string,
): string {
    const platformNames: Record<string, string> = {
        feishu: '飞书',
        dingtalk: '钉钉',
        wecom: '企业微信',
        slack: 'Slack',
    };
    const contentNames: Record<string, string> = {
        image: '图片',
        file: '文件',
        audio: '语音',
        voice: '语音',
        video: '视频',
    };
    const platform = platformNames[platformType] || platformType || '外部平台';
    const attachment = contentNames[contentType] || '附件';
    return `${platform}${attachment}下载失败：${reason}。请稍后重新发送。`;
}
