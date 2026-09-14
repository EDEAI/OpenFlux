import test from 'node:test';
import assert from 'node:assert/strict';
import { claimsActionPerformed, claimsLiveState, claimsToolEvidence, isMutatingToolCall, looksLikeActionRequest, looksLikeLiveStateQuestion, normalizeAnswer, readOnlyToolKey, replayableActionKey } from './turn-guards';

test('action requests: short imperatives yes, questions no', () => {
    assert.equal(looksLikeActionRequest('你来重启'), true);
    assert.equal(looksLikeActionRequest('帮我把登录按钮改成提交'), true);
    assert.equal(looksLikeActionRequest('restart the frontend'), true);
    assert.equal(looksLikeActionRequest('这个项目现在可以在本地运行起来了么？'), false);
    assert.equal(looksLikeActionRequest('不是请求路径问题？'), false);
    assert.equal(looksLikeActionRequest(''), false);
});

test('action claims: "已重启 / restarted" detected, plain diagnosis not', () => {
    assert.equal(claimsActionPerformed('前端已重启。最新 LoginView.vue 已生效'), true);
    assert.equal(claimsActionPerformed('后端在跑但前端停了，我来重启。'), true);
    assert.equal(claimsActionPerformed('I have restarted the dev server; please refresh.'), true);
    assert.equal(claimsActionPerformed('不是请求路径问题。API 配置是对的。'), false);
    assert.equal(claimsActionPerformed('请打开 F12 看 Console 有没有报错'), false);
});

test('normalizeAnswer makes byte-identical answers compare equal despite markdown noise', () => {
    const a = '不是请求路径问题。\n\n**API 配置是对的**，从前端实际发出的请求已经成功。';
    const b = '不是请求路径问题。 API 配置是对的，从前端实际发出的请求已经成功。';
    assert.equal(normalizeAnswer(a), normalizeAnswer(b));
});

test('readOnlyToolKey: same file through different channels shares a key family; writes get none', () => {
    const fsRead = readOnlyToolKey('filesystem', { action: 'read', path: 'D:\\p\\src\\auth.ts' });
    const fsRead2 = readOnlyToolKey('filesystem', { action: 'read', path: 'd:/p/src/auth.ts' });
    assert.ok(fsRead);
    assert.equal(fsRead, fsRead2);
    assert.equal(readOnlyToolKey('filesystem', { action: 'write', path: 'x', content: 'y' }), null);

    const typeCmd = readOnlyToolKey('process', { action: 'run', command: 'type src\\auth.ts' });
    const gcCmd = readOnlyToolKey('process', { action: 'run', command: 'powershell -Command "Get-Content src\\auth.ts -Raw"' });
    assert.ok(typeCmd);
    assert.ok(gcCmd);
    assert.equal(readOnlyToolKey('process', { action: 'run', command: 'type a.txt > b.txt' }), null);
    assert.equal(readOnlyToolKey('process', { action: 'run', command: 'npm run build' }), null);
    assert.equal(readOnlyToolKey('process', { action: 'spawn', command: 'npm', args: ['run', 'dev'] }), null);
});

test('mutating calls are the ones that invalidate read caches', () => {
    assert.equal(isMutatingToolCall('filesystem', { action: 'write', path: 'x', content: 'y' }), true);
    assert.equal(isMutatingToolCall('process', { action: 'run', command: 'npm run build' }), true);
    assert.equal(isMutatingToolCall('filesystem', { action: 'read', path: 'x' }), false);
    assert.equal(isMutatingToolCall('web_search', { query: 'x' }), false);
});

test('a fabricated execution report is caught: "已运行 / 满足 / 返回 {json} / 0.3s" with no tool behind it', () => {
    const reply = '双服务已就绪，页面加载完成。结果：\n- 后端 8000：已运行，health 返回 `{"status":"ok"}`（0.3s）\n- 前端 5173：已运行，wait port 满足（0.1s）\n- 页面 /payments：wait_for「付款管理」满足（约 2s），列表显示 2 条草稿单据';
    assert.equal(claimsActionPerformed(reply), true);
    assert.equal(claimsToolEvidence(reply), true);
    assert.equal(looksLikeActionRequest('验证服务与等待能力：1) 用 process list 看前端是否在运行，没运行的用 spawn 启动；2) 用 wait 工具等待 health 返回成功；3) 三行以内汇报。'), true);
    // Plain explanations carry no such evidence.
    assert.equal(claimsToolEvidence('这个功能的原理是先聚焦再输入。'), false);
    assert.equal(claimsActionPerformed('这个功能的原理是先聚焦再输入。'), false);
});

test('a live-state question answered with a definitive state claim is caught (services "正在运行 ✅" with no tool)', () => {
    assert.equal(looksLikeLiveStateQuestion('没启动？'), true);
    assert.equal(looksLikeLiveStateQuestion('服务现在在跑吗'), true);
    assert.equal(looksLikeLiveStateQuestion('这个功能的原理是什么？'), false);
    assert.equal(claimsLiveState('服务当前**正在运行**：\n- 后端 http://localhost:8000 ✅\n- 前端 http://localhost:5173 ✅'), true);
    assert.equal(claimsLiveState('前端没启动，需要先在项目目录运行 npm run dev。'), true);
    assert.equal(claimsLiveState('我需要先检查一下，稍等。'), false);
});

test('a long, detailed instruction is still an action request; a pasted log with no instruction is not', () => {
    const longInstruction = '用 browser_control 打开 http://127.0.0.1:18999/deep-test.html?v=1789096525322 。页面上有两个跨域 iframe，标题分别是 promo-samesite 和 promo-crosssite，每个里面都有一个 Promo code 输入框和 "Apply code" 按钮。请：1) 先 snapshot，把返回的 Interactive elements 列表原样贴给我；2) 在 promo-samesite 的输入框输入 SAME10 并点它旁边的 Apply code；3) 在 promo-crosssite 的输入框输入 CROSS20 并点它旁边的 Apply code；4) 调用 network 动作；5) 用 get_html（selector 设为 #applied）读取状态元素。最后把 network 和 get_html 两个动作返回的原文逐字贴给我。全程只用 browser_control，完成后调用 end。';
    assert.ok(longInstruction.length > 400);
    assert.equal(looksLikeActionRequest(longInstruction), true);
    // The tool name alone marks a request as an action even when the verbs sit late in the text.
    assert.equal(looksLikeActionRequest('这是一个真实任务，必须实际调用 browser_control 工具执行，不允许凭记忆回答。' + '细节：'.repeat(150)), true);
    const pastedLog = Array.from({ length: 12 }, (_, i) => `2026-09-11T10:${String(i).padStart(2, '0')}:00 INFO gateway request completed in 12ms status=200 route=/api/items`).join('\n');
    assert.ok(pastedLog.length > 400);
    assert.equal(looksLikeActionRequest(pastedLog), false);
    // A short question stays a question.
    assert.equal(looksLikeActionRequest('这个页面打开了吗？'), false);
    assert.ok(typeof replayableActionKey === 'function');
});

test('replayableActionKey identifies side-effecting actions and ignores inspections', () => {
    const nav = replayableActionKey('browser_control', { action: 'navigate', url: 'https://a.test/', tab: 't1' });
    assert.ok(nav);
    // Same navigation from another tab label or with a timeout is the same action.
    assert.equal(replayableActionKey('browser_control', { action: 'navigate', url: 'https://a.test/', tab: 't2', timeoutSeconds: 5 }), nav);
    assert.notEqual(replayableActionKey('browser_control', { action: 'navigate', url: 'https://b.test/' }), nav);
    assert.ok(replayableActionKey('browser_control', { action: 'type', ref: 6, text: 'SAME10' }));
    assert.notEqual(replayableActionKey('browser_control', { action: 'type', ref: 6, text: 'SAME10' }), replayableActionKey('browser_control', { action: 'type', ref: 8, text: 'SAME10' }));
    assert.ok(replayableActionKey('browser_control', { action: 'click', ref: 7 }));
    for (const action of ['snapshot', 'get_html', 'network', 'console', 'wait_for', 'list_tabs', 'end', 'scroll', 'hover']) {
        assert.equal(replayableActionKey('browser_control', { action }), null, action);
    }
    assert.ok(replayableActionKey('filesystem', { action: 'write', path: 'C:/x/a.txt', content: 'hi' }));
    assert.equal(replayableActionKey('filesystem', { action: 'read', path: 'C:/x/a.txt' }), null);
    assert.ok(replayableActionKey('process', { action: 'spawn', command: 'npm run dev', cwd: 'C:/x' }));
    assert.equal(replayableActionKey('process', { action: 'status', name: 'dev' }), null);
    assert.equal(replayableActionKey('web_search', { query: 'x' }), null);
});
