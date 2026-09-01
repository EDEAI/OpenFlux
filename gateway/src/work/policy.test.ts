import assert from 'node:assert/strict';
import test from 'node:test';
import { assessPlanModeTool, isPlanModeToolVisible } from './policy';

test('plan mode allows research and plan control tools', () => {
    assert.equal(assessPlanModeTool('plan', 'filesystem', { action: 'read' }).allowed, true);
    assert.equal(assessPlanModeTool('plan', 'web_search', { query: 'x' }).allowed, true);
    assert.equal(assessPlanModeTool('plan', 'memory_tool', { action: 'search' }).allowed, true);
    assert.equal(assessPlanModeTool('plan', 'request_plan_input', {}).allowed, true);
});

test('plan mode blocks writes and all general side-effect tools', () => {
    for (const [name, args] of [
        ['filesystem', { action: 'write' }],
        ['memory_tool', { action: 'save' }],
        ['process', { action: 'run' }],
        ['browser', { action: 'click' }],
        ['scheduler', { action: 'create' }],
        ['email', { action: 'send' }],
    ] as const) {
        assert.equal(assessPlanModeTool('plan', name, args).allowed, false, name);
    }
    assert.equal(assessPlanModeTool('normal', 'process', { action: 'run' }).allowed, true);
    assert.equal(assessPlanModeTool('plan_execution', 'filesystem', { action: 'write' }).allowed, true);
});

test('plan controls are only advertised during plan turns', () => {
    assert.equal(isPlanModeToolVisible('normal', 'request_plan_input'), false);
    assert.equal(isPlanModeToolVisible('plan_execution', 'publish_plan_document'), false);
    assert.equal(isPlanModeToolVisible('plan', 'request_plan_input'), true);
    assert.equal(isPlanModeToolVisible('plan', 'process'), false);
});
