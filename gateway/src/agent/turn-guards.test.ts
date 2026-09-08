import test from 'node:test';
import assert from 'node:assert/strict';
import { claimsActionPerformed, claimsLiveState, claimsToolEvidence, isMutatingToolCall, looksLikeActionRequest, looksLikeLiveStateQuestion, normalizeAnswer, readOnlyToolKey } from './turn-guards';

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
