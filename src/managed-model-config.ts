/** Public model metadata only. Router credentials must never reach the renderer. */
export interface ManagedModelInfo {
    available: boolean;
    provider?: string;
    model?: string;
    quota?: { daily_limit: number; used_today: number };
    currentSource?: 'local' | 'managed' | 'atlas_managed';
    profiles?: { orchestration?: { provider?: string; model?: string } };
}

/** Present legacy and multi-provider Router configurations through the same UI. */
export function normalizeManagedModelInfo(info: ManagedModelInfo): ManagedModelInfo {
    return {
        available: info.available,
        provider: info.profiles?.orchestration?.provider ?? info.provider,
        model: info.profiles?.orchestration?.model ?? info.model,
        quota: info.quota,
        currentSource: info.currentSource,
    };
}
