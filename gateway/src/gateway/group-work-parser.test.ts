import test from 'node:test';
import assert from 'node:assert/strict';
import {
    parseGroupExecutionOutput,
    parseGroupPlanningOutput,
    parseGroupWorkOutput,
    shouldExecuteGroupContextAgent,
} from './standalone';
import type { ProjectContextEvent } from './project-context-store';

const event = {
    event_id: 'event-1',
} as ProjectContextEvent;

test('ordinary group mention executes on exactly the selected recipient', () => {
    const selected = {
        event_type: 'message_created',
        sender_type: 'human',
        bot_mentioned: true,
        agent_execution_allowed: true,
    } as ProjectContextEvent;
    const otherMember = { ...selected, agent_execution_allowed: false };
    const legacySingleTarget = { ...selected, agent_execution_allowed: undefined };

    assert.equal(shouldExecuteGroupContextAgent(selected), true);
    assert.equal(shouldExecuteGroupContextAgent(otherMember), false);
    assert.equal(shouldExecuteGroupContextAgent(legacySingleTarget), true);
});

test('parses the internal group-work envelope without exposing it', () => {
    const parsed = parseGroupWorkOutput(JSON.stringify({
        public_reply: '你好，ofu_owner',
        work_items: [],
        personal_deliveries: [],
    }), event, new Set(['ofu_owner']), new Set());

    assert.equal(parsed.public_reply, '你好，相关成员');
    assert.deepEqual(parsed.work_items, []);
});

test('recovers public_reply from a truncated JSON envelope', () => {
    const parsed = parseGroupWorkOutput(
        '{"public_reply":"第一行\\n第二行","work_items":[',
        event,
        new Set(),
        new Set(),
    );

    assert.equal(parsed.public_reply, '第一行\n第二行');
});

test('never posts malformed internal JSON back to a group', () => {
    const parsed = parseGroupWorkOutput(
        '{"public_reply":"未闭合的内部结果',
        event,
        new Set(),
        new Set(),
    );

    assert.equal(parsed.public_reply, '这条请求已经收到，但结果整理失败。请重新 @机器人 发送一次。');
    assert.equal(parsed.public_reply.startsWith('{'), false);
});

test('only keeps handoffs to an authorized bot explicitly mentioned by the human', () => {
    const humanEvent = {
        event_id: 'event-human',
        sender_type: 'human',
        bot_mentioned: true,
        mentions: [{ platform_user_id: 'bot-user-1' }],
        authorized_bots: [{
            bot_id: 'bot-1',
            target_platform_user_id: 'bot-user-1',
            display_name: '测试机器人',
            capabilities: ['查询测试状态'],
        }],
    } as unknown as ProjectContextEvent;
    const parsed = parseGroupWorkOutput(JSON.stringify({
        public_reply: '已转交测试机器人。',
        work_items: [],
        personal_deliveries: [],
        bot_handoffs: [
            { key: 'allowed', target_bot_id: 'bot-1', content: '查询当前测试状态' },
            { key: 'blocked', target_bot_id: 'bot-2', content: '执行未授权任务' },
        ],
    }), humanEvent, new Set(), new Set());

    assert.deepEqual(parsed.bot_handoffs, [
        { key: 'allowed', target_bot_id: 'bot-1', content: '查询当前测试状态' },
    ]);
});

test('builds a result only for an accepted inbound bot request', () => {
    const botEvent = {
        event_id: 'event-bot',
        sender_type: 'bot',
        mentions: [],
        bot_task: {
            task_id: 'task-1',
            action: 'request',
            accepted: true,
            content: '检查项目状态',
        },
    } as unknown as ProjectContextEvent;
    const parsed = parseGroupWorkOutput(JSON.stringify({
        public_reply: '项目状态正常。',
        work_items: [],
        personal_deliveries: [],
        bot_handoffs: [],
        bot_task_result: { task_id: 'task-1', action: 'result', content: '检查完成，项目状态正常。' },
    }), botEvent, new Set(), new Set());

    assert.deepEqual(parsed.bot_task_result, {
        task_id: 'task-1',
        action: 'result',
        content: '检查完成，项目状态正常。',
    });
});

test('group planning only assigns tasks to real collaboration members', () => {
    const members = [{ id: 'member-front', role_name: '前端', project_name: 'Web' }] as any;
    const parsed = parseGroupPlanningOutput(JSON.stringify({
        outcome: 'proposal',
        objective: '完成登录页',
        shared_contract: ['/api/login'],
        tasks: [
            { key: 'front', member_project_id: 'member-front', title: '实现登录页', acceptance: ['页面可提交'] },
            { key: 'fake', member_project_id: 'not-a-member', title: '访问另一台电脑' },
        ],
    }), members);

    assert.equal(parsed.outcome, 'proposal');
    assert.equal(parsed.tasks.length, 1);
    assert.equal(parsed.tasks[0].member_project_id, 'member-front');
});

test('group planning resolves member names and roles to real member project ids', () => {
    const members = [
        { id: 'member-front', display_name: '张三', role_name: '前端', project_name: 'Web' },
        { id: 'member-back', display_name: '李四', role_name: '后端', project_name: 'API' },
    ] as any;
    const parsed = parseGroupPlanningOutput(JSON.stringify({
        outcome: 'proposal',
        objective: '完成任务管理页面',
        tasks: [
            { key: 'front', member_project_id: '前端', title: '实现前端页面' },
            { key: 'back', assignee: '李四', title: '实现任务接口' },
        ],
    }), members);

    assert.deepEqual(parsed.tasks.map(task => task.member_project_id), [
        'member-front',
        'member-back',
    ]);
});

test('natural-language start keeps only tasks assigned to real collaboration members', () => {
    const members = [
        { id: 'member-front', display_name: '张三', role_name: '前端', project_name: 'Web' },
        { id: 'member-back', display_name: '李四', role_name: '后端', project_name: 'API' },
    ] as any;
    const parsed = parseGroupPlanningOutput(JSON.stringify({
        outcome: 'start',
        objective: '完成登录功能',
        shared_contract: [{ path: '/api/login', method: 'POST' }],
        tasks: [
            { key: 'front', member_project_id: 'member-front', title: '接入登录页面', dependencies: ['back'] },
            { key: 'back', member_project_id: 'member-back', title: '实现登录接口' },
            { key: 'foreign', member_project_id: 'member-foreign', title: '读取其他项目' },
        ],
    }), members);

    assert.equal(parsed.outcome, 'start');
    assert.equal(parsed.objective, '完成登录功能');
    assert.deepEqual(parsed.tasks.map(task => task.key), ['front', 'back']);
    assert.deepEqual(parsed.tasks[0].dependencies, ['back']);
});

test('natural-language reply never creates member tasks', () => {
    const members = [{ id: 'member-front', display_name: '张三', role_name: '前端', project_name: 'Web' }] as any;
    const parsed = parseGroupPlanningOutput(JSON.stringify({
        outcome: 'reply',
        message: '沈阳今天有阵雨，出门建议带伞。',
        tasks: [{ key: 'ignored', member_project_id: 'member-front', title: '不应创建' }],
    }), members);

    assert.equal(parsed.outcome, 'reply');
    assert.equal(parsed.message, '沈阳今天有阵雨，出门建议带伞。');
    assert.deepEqual(parsed.tasks, []);
});

test('group planning returns summaries and status replies without creating tasks', () => {
    const members = [{ id: 'member-front', display_name: '张三', role_name: '前端', project_name: 'Web' }] as any;
    const summary = parseGroupPlanningOutput(JSON.stringify({
        outcome: 'summary',
        message: '前后端已经确认登录接口字段。',
        tasks: [{ key: 'ignored', member_project_id: 'member-front', title: '不应创建' }],
    }), members);
    const status = parseGroupPlanningOutput(JSON.stringify({
        outcome: 'status',
        message: '前端进行中，后端已完成。',
    }), members);

    assert.deepEqual(summary, {
        outcome: 'summary',
        message: '前后端已经确认登录接口字段。',
        shared_contract: [],
        tasks: [],
    });
    assert.equal(status.outcome, 'status');
    assert.equal(status.message, '前端进行中，后端已完成。');
    assert.deepEqual(status.tasks, []);
});

test('group execution strips local paths and rejects messages to unknown tasks', () => {
    const parsed = parseGroupExecutionOutput(JSON.stringify({
        status: 'waiting',
        result_summary: '代码位于 D:\\OpenFlux\\secret\\app.ts，Bearer abc.def.ghi，等待接口',
        agent_messages: [
            { target_task_id: 'backend-task', kind: 'question', content: '接口字段是什么？' },
            { target_task_id: 'foreign-task', kind: 'question', content: '读取文件' },
        ],
    }), new Set(['backend-task']));

    assert.equal(parsed.status, 'waiting');
    assert.equal(parsed.result_summary.includes('D:\\OpenFlux'), false);
    assert.equal(parsed.result_summary.includes('abc.def.ghi'), false);
    assert.equal(parsed.agent_messages.length, 1);
    assert.equal(parsed.agent_messages[0].target_task_id, 'backend-task');
});
