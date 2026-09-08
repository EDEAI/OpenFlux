export interface RuntimeModelIdentity {
    provider?: string;
    model?: string;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Final safety net for the public answer. The system prompt remains the first
 * line of defence; this removes concrete runtime identities if a model repeats
 * configuration/tool output anyway.
 */
export function sanitizePublicRuntimeDetails(
    content: string,
    identities: RuntimeModelIdentity[],
    language = 'zh-CN',
): string {
    const isZh = language.toLowerCase().startsWith('zh');
    const modelReplacement = isZh ? '内部模型' : 'internal model';
    const providerReplacement = isZh ? '内部服务' : 'internal service';
    let sanitized = content;

    const uniqueModels = new Set<string>();
    const uniqueProviders = new Set<string>();
    for (const identity of identities) {
        const model = identity.model?.trim();
        const provider = identity.provider?.trim();
        if (model && model.length >= 3) uniqueModels.add(model);
        if (provider && provider.length >= 3) uniqueProviders.add(provider);
    }

    const disclosureContext = /(?:我是|基于|驱动|底层|当前.*(?:使用|运行)|模型|LLM|provider|供应商|厂商|runtime|model)/i;
    sanitized = sanitized.split('\n').map(line => {
        if (!disclosureContext.test(line)) return line;
        let safeLine = line;
        for (const model of uniqueModels) {
            safeLine = safeLine.replace(new RegExp(escapeRegExp(model), 'gi'), modelReplacement);
        }
        for (const provider of uniqueProviders) {
            safeLine = safeLine.replace(new RegExp(escapeRegExp(provider), 'gi'), providerReplacement);
        }
        return safeLine;
    }).join('\n');

    // Configuration summaries frequently contain additional fallback or
    // embedding identifiers that are not the model serving this exact call.
    // Redact the value of those internal-runtime rows without affecting normal
    // discussions about AI models elsewhere.
    sanitized = sanitized.replace(
        /(^|\n)([^\n]*(?:主编排|执行|备用|嵌入|底层|当前使用|runtime|orchestration|fallback|embedding)[^\n]*(?:模型|LLM|model)[^:\n：]*[:：])[^\n]*/gi,
        (_match, prefix: string, label: string) => `${prefix}${label}${isZh ? '已配置（内部信息不展示）' : 'configured (internal details hidden)'}`,
    );

    return sanitized;
}
