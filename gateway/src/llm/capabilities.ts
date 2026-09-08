import type { LLMConfig } from './provider';

export interface LLMCapabilities {
    vision: boolean;
    tools: boolean;
    structuredOutput: boolean;
}

/**
 * Capability declarations are authoritative when the platform supplies them.
 * Otherwise vision is attempted optimistically and the provider response is
 * treated as the source of truth. Model-name allowlists age badly, especially
 * behind OpenAI-compatible gateways whose aliases do not describe capability.
 */
export function inferLLMCapabilities(config: LLMConfig): LLMCapabilities {
    const declared = config.capabilities;
    const provider = config.provider;

    return {
        vision: declared?.vision ?? true,
        tools: declared?.tools ?? provider !== 'local',
        structuredOutput: declared?.structuredOutput ?? provider !== 'local',
    };
}

export function supportsVision(config: LLMConfig): boolean {
    return inferLLMCapabilities(config).vision;
}
