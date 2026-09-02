import assert from 'node:assert/strict';
import test from 'node:test';
import {
    groupAssistantContentForDisplay,
    groupSenderLabel,
    groupUserContentForDisplay,
    isCurrentGroupSender,
    isGroupRequestNotice,
} from './group-message-display';

test('legacy Feishu dispatch receipts are hidden by event identity', () => {
    assert.equal(isGroupRequestNotice({
        source: 'router_group', platform_type: 'feishu',
        collaboration_event: { type: 'intent.requested' },
    }), true);
});

test('answers, task updates and native Agent turns remain visible', () => {
    for (const type of ['public.answer', 'task.started', 'task.completed', 'intent.failed']) {
        assert.equal(isGroupRequestNotice({
            source: 'router_group', platform_type: 'feishu', collaboration_event: { type },
        }), false);
    }
    assert.equal(isGroupRequestNotice({ source: 'router_group_planning', platform_type: 'feishu' }), false);
    assert.equal(isGroupRequestNotice({ source: 'router_group', platform_type: 'feishu', sender_type: 'human' }), false);
    assert.equal(isGroupRequestNotice({
        source: 'router_group', platform_type: 'slack', collaboration_event: { type: 'intent.requested' },
    }), false);
    assert.equal(isGroupRequestNotice({
        source: 'router', platform_type: 'feishu', collaboration_event: { type: 'intent.requested' },
    }), false);
});

test('missing or malformed notice metadata never hides ordinary messages', () => {
    assert.equal(isGroupRequestNotice(), false);
    for (const event of [undefined, null, '', 'intent.requested', [], {}, { type: null }]) {
        assert.equal(isGroupRequestNotice({
            source: 'router_group', platform_type: 'feishu', collaboration_event: event,
        }), false);
    }
});

test('historical group users do not expose Feishu IDs or mention placeholders', () => {
    assert.equal(
        groupUserContentForDisplay(
            '成员 ou_f6e4854ead06399f801ec114d53796ec: @_user_1 你好',
            {
                source: 'router_group',
                platform_type: 'feishu',
                sender_type: 'human',
                sender_flux_user_id: 'ofu_user',
            },
        ),
        '@FluxBot 你好',
    );
});

test('historical placeholders use the resolved collaboration member name', () => {
    assert.equal(
        groupUserContentForDisplay(
            '已绑定成员: 前端已经完成页面',
            { source: 'router_group', platform_type: 'feishu', sender_platform_id: 'ou_member' },
            '张三（前端）',
        ),
        '前端已经完成页面',
    );
});

test('group sender identity is rendered as metadata instead of message body', () => {
    assert.equal(
        groupSenderLabel(
            { source: 'router_group', platform_type: 'feishu', sender_type: 'human' },
            '张三（前端）',
        ),
        '张三（前端） · 飞书',
    );
});

test('the current collaboration member is rendered as my own group message', () => {
    const metadata = {
        source: 'router_group',
        platform_type: 'feishu',
        sender_type: 'human',
        sender_is_current_member: true,
    };
    assert.equal(isCurrentGroupSender(metadata), true);
    assert.equal(groupSenderLabel(metadata, '张三（前端）'), '我 · 飞书');
});

test('legacy generated sender prefix is removed from group message content', () => {
    assert.equal(
        groupUserContentForDisplay(
            '张三 · 前端: 页面已完成',
            {
                source: 'router_group',
                sender_display_name: '张三',
                sender_role_name: '前端',
            },
        ),
        '页面已完成',
    );
});

test('non-group user messages remain unchanged', () => {
    assert.equal(groupUserContentForDisplay('成员 张三: 你好', { source: 'local' }), '成员 张三: 你好');
});

test('valid historical group envelope renders only the public reply', () => {
    assert.equal(
        groupAssistantContentForDisplay(JSON.stringify({ public_reply: '处理完成', work_items: [] })),
        '处理完成',
    );
});

test('malformed group envelope recovers a complete public reply', () => {
    assert.equal(
        groupAssistantContentForDisplay('{"public_reply":"第一行\\n第二行","work_items":['),
        '第一行\n第二行',
    );
});

test('ordinary malformed JSON output is displayed as ordinary agent content', () => {
    assert.equal(
        groupAssistantContentForDisplay('{"work_items":['),
        '{"work_items":[',
    );
});

test('ordinary valid JSON output is not mistaken for the internal group protocol', () => {
    const output = JSON.stringify({ city: '沈阳', temperature: 21 });
    assert.equal(groupAssistantContentForDisplay(output), output);
});

test('ordinary JSON may use a public_reply field without becoming an internal envelope', () => {
    const output = JSON.stringify({ public_reply: '这是用户要求的 JSON 字段' });
    assert.equal(groupAssistantContentForDisplay(output), output);
});
