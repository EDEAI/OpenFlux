export type ExternalPlatformLoadState =
    | 'idle'
    | 'loading'
    | 'ready'
    | 'router_disconnected'
    | 'incompatible'
    | 'error';

export interface ExternalPlatformPresentationInput {
    loadState: ExternalPlatformLoadState;
    routerConnected: boolean;
    supportsNewFeatures: boolean;
    compatibilityMessage?: string;
    available: boolean;
    bound: boolean;
}

export interface ExternalPlatformPresentation {
    label: string;
    canBind: boolean;
    unavailable: boolean;
}

/** Keep unknown/loading states distinct from a platform that is genuinely disabled by an administrator. */
export function externalPlatformPresentation(
    input: ExternalPlatformPresentationInput,
): ExternalPlatformPresentation {
    if (!input.routerConnected || input.loadState === 'router_disconnected') {
        return { label: input.bound ? '已绑定 · Router 未连接' : 'Router 未连接', canBind: false, unavailable: true };
    }
    if (!input.supportsNewFeatures || input.loadState === 'incompatible') {
        return {
            label: input.compatibilityMessage || '当前 Router 暂不支持账号连接',
            canBind: false,
            unavailable: true,
        };
    }
    if (input.loadState === 'error') {
        return { label: input.bound ? '此前已绑定 · 状态刷新失败' : '状态读取失败', canBind: false, unavailable: true };
    }
    if (input.loadState === 'idle' || input.loadState === 'loading') {
        return { label: input.bound ? '此前已绑定 · 正在刷新…' : '正在读取…', canBind: false, unavailable: true };
    }
    if (!input.available) {
        return { label: '管理员尚未开通', canBind: false, unavailable: true };
    }
    if (input.bound) {
        return { label: '已连接当前账号', canBind: false, unavailable: false };
    }
    return { label: '尚未连接', canBind: true, unavailable: false };
}
