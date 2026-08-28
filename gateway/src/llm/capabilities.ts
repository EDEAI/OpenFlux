import type { LLMConfig } from './provider';

export interface LLMCapabilities {
    vision: boolean;
    tools: boolean;
    structuredOutput: boolean;
}

/**
 * Runtime capability detection is deliberately conservative. Unknown/custom
 * models are treated as text-only unless the platform explicitly declares
 * their capabilities. This prevents image payloads from being sent to an API
 * that cannot consume them and, more importantly, prevents a text-only model
 * from claiming that it visually reviewed a rendered artifact.
 */
export function inferLLMCapabilities(config: LLMConfig): LLMCapabilities {
    const declared = config.capabilities;
    const model = config.model.toLowerCase();
    const provider = config.provider;

    let inferredVision = false;
    if (provider === 'google') {
        inferredVision = true;
    } else if (provider === 'anthropic') {
        inferredVision = /claude-(?:(?:3|4|5)(?:[-_.]|$)|(?:sonnet|opus|haiku)-(?:3|4|5)(?:[-_.]|$))/.test(model);
    } else if (provider === 'openai') {
        // `openai` is also used as the SDK/protocol adapter for Atlas and
        // OpenAI-compatible gateways, so the provider name alone is not proof
        // of image-input support.
        inferredVision = /(?:^|[-_.])(?:gpt-(?:4o|4\.[15]|4-turbo|4-vision|5)|o[1345]|chatgpt|gemini|kimi-k3|qwen[^ ]*(?:vl|vision)|claude-(?:(?:3|4|5)|(?:sonnet|opus|haiku)-(?:3|4|5)))(?:[-_.:]|$)/.test(model);
    } else if (provider === 'moonshot') {
        inferredVision = /^kimi-(?:k3|k2\.(?:6|7))(?:$|-)/.test(model);
    } else if (provider === 'dashscope') {
        inferredVision = /^qwen3\.(?:7|8)-/.test(model) || /(?:vl|vision)/.test(model);
    } else if (provider === 'zhipu') {
        inferredVision = /(?:^|[-_.])\d*v(?:[-_.]|$)|vision/.test(model);
    } else if (provider === 'ollama') {
        inferredVision = /^(?:qwen3\.5|gemma3|llama4)(?::|$)|(?:vision|vl)/.test(model);
    }

    return {
        vision: declared?.vision ?? inferredVision,
        tools: declared?.tools ?? provider !== 'local',
        structuredOutput: declared?.structuredOutput ?? provider !== 'local',
    };
}

export function supportsVision(config: LLMConfig): boolean {
    return inferLLMCapabilities(config).vision;
}
