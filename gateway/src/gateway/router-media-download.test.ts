import assert from 'node:assert/strict';
import test from 'node:test';

import {
    fetchRouterMediaWithRetry,
    isRetryableRouterMediaStatus,
    routerAttachmentFailureMessage,
    routerMediaFailureReason,
    shouldRunRouterAgentForAttachment,
} from './router-media-download';

test('Router media retries a temporary 502 and returns the later response', async () => {
    let attempts = 0;
    const result = await fetchRouterMediaWithRetry('https://router.example/media/token', {}, {
        fetcher: async () => {
            attempts += 1;
            return attempts === 1
                ? new Response('not ready', { status: 502 })
                : new Response('image', { status: 200 });
        },
        sleep: async () => undefined,
        retryDelaysMs: [1, 1],
    });

    assert.equal(result.ok, true);
    assert.equal(attempts, 2);
});

test('Router media does not retry a permanent authorization failure', async () => {
    let attempts = 0;
    const result = await fetchRouterMediaWithRetry('https://router.example/media/token', {}, {
        fetcher: async () => {
            attempts += 1;
            return new Response('denied', { status: 403 });
        },
        sleep: async () => undefined,
        retryDelaysMs: [1, 1],
    });

    assert.equal(result.ok, false);
    assert.equal(attempts, 1);
    assert.equal(result.reason, '附件访问鉴权失败');
});

test('Router media failure descriptions are platform-specific and user-facing', () => {
    assert.equal(isRetryableRouterMediaStatus(503), true);
    assert.equal(isRetryableRouterMediaStatus(410), false);
    assert.equal(routerMediaFailureReason(410), '附件链接已经过期');
    assert.equal(
        routerAttachmentFailureMessage('dingtalk', 'image', '平台附件暂未准备好'),
        '钉钉图片下载失败：平台附件暂未准备好。请稍后重新发送。',
    );
});

test('an attachment download failure is displayed without starting an Agent', () => {
    assert.equal(shouldRunRouterAgentForAttachment(true, 0), false);
    assert.equal(shouldRunRouterAgentForAttachment(true, 1), true);
    assert.equal(shouldRunRouterAgentForAttachment(false, 0), true);
});
