import assert from 'node:assert/strict';
import test from 'node:test';
import { externalPlatformPresentation } from './external-platform-state';

test('a platform is not reported as disabled while Router status is still loading', () => {
    assert.deepEqual(externalPlatformPresentation({
        loadState: 'loading',
        routerConnected: true,
        supportsNewFeatures: true,
        available: false,
        bound: false,
    }), {
        label: '正在读取…',
        canBind: false,
        unavailable: true,
    });
});

test('Router disconnection is reported before platform availability', () => {
    assert.equal(externalPlatformPresentation({
        loadState: 'router_disconnected',
        routerConnected: false,
        supportsNewFeatures: false,
        available: false,
        bound: false,
    }).label, 'Router 未连接');
});

test('only a completed platform response can report administrator disabled', () => {
    assert.equal(externalPlatformPresentation({
        loadState: 'ready',
        routerConnected: true,
        supportsNewFeatures: true,
        available: false,
        bound: false,
    }).label, '管理员尚未开通');
});

test('available platforms distinguish connected and unconnected accounts', () => {
    assert.deepEqual(externalPlatformPresentation({
        loadState: 'ready',
        routerConnected: true,
        supportsNewFeatures: true,
        available: true,
        bound: false,
    }), {
        label: '尚未连接',
        canBind: true,
        unavailable: false,
    });
    assert.equal(externalPlatformPresentation({
        loadState: 'ready',
        routerConnected: true,
        supportsNewFeatures: true,
        available: true,
        bound: true,
    }).label, '已连接当前账号');
});
