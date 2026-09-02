import assert from 'node:assert/strict';
import test from 'node:test';
import { projectContextRefreshDecision } from './project-context-refresh';

test('new group context refreshes the Project session list and marks a background session unread', () => {
    assert.deepEqual(projectContextRefreshDecision({
        projectId: 'project-frontend',
        sessionId: 'project-thread-feishu-group',
    }, 'another-session'), {
        projectId: 'project-frontend',
        sessionId: 'project-thread-feishu-group',
        markUnread: true,
        refreshVisible: false,
    });
});

test('visible group context refreshes message history without creating an unread badge', () => {
    assert.deepEqual(projectContextRefreshDecision({
        projectId: 'project-backend',
        sessionId: 'project-thread-feishu-group',
    }, 'project-thread-feishu-group'), {
        projectId: 'project-backend',
        sessionId: 'project-thread-feishu-group',
        markUnread: false,
        refreshVisible: true,
    });
});

test('malformed project context broadcasts are ignored', () => {
    assert.equal(projectContextRefreshDecision({ projectId: 'project-only' }, null), null);
    assert.equal(projectContextRefreshDecision({ sessionId: 'session-only' }, null), null);
    assert.equal(projectContextRefreshDecision(undefined, null), null);
});
