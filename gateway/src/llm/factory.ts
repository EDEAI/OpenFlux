/**
 * LLM Provider 工厂
 */
import { LLMConfig, LLMProvider } from './provider';
import { AnthropicProvider } from './anthropic';
import { OpenAIProvider } from './openai';
import { LocalEmbeddingProvider } from './local-embedding';

export function createLLMProvider(config: LLMConfig): LLMProvider {
    switch (config.provider) {
        case 'local':
            return new LocalEmbeddingProvider(config);
        case 'anthropic':
            return new AnthropicProvider(config);
        case 'openai':
            return new OpenAIProvider(config);
        // OpenAI 兼容接口的 provider（使用 OpenAIProvider + 自定义 baseUrl）
        case 'minimax':
            // Minimax 推荐使用 OpenAI 兼容接口用于 Embedding
            // 如果 baseUrl 包含 'anthropic'，则使用 AnthropicProvider (Chat)
            // 否则默认使用 OpenAIProvider (Embedding / Chat)
            if (config.baseUrl?.includes('anthropic')) {
                return new AnthropicProvider({
                    ...config,
                    baseUrl: config.baseUrl || 'https://api.minimaxi.com/anthropic',
                });
            } else {
                return new OpenAIProvider({
                    ...config,
                    baseUrl: config.baseUrl || 'https://api.minimax.chat/v1',
                });
            }
        case 'deepseek':
            return new OpenAIProvider({
                ...config,
                baseUrl: config.baseUrl || 'https://api.deepseek.com/v1',
            });
        case 'zhipu':
            return new OpenAIProvider({
                ...config,
                baseUrl: config.baseUrl || 'https://open.bigmodel.cn/api/paas/v4',
            });
        case 'moonshot':
            return new OpenAIProvider({
                ...config,
                baseUrl: config.baseUrl || 'https://api.moonshot.cn/v1',
            });
        case 'ollama':
            return new OpenAIProvider({
                ...config,
                baseUrl: config.baseUrl || 'http://localhost:11434/v1',
            });
        case 'custom':
            // 自定义 provider，使用 OpenAI 兼容接口
            if (!config.baseUrl) {
                throw new Error('Custom provider requires baseUrl');
            }
            return new OpenAIProvider(config);
        case 'google':
            // Google Gemini 使用 OpenAI 兼容接口
            return new OpenAIProvider({
                ...config,
                baseUrl: config.baseUrl || 'https://generativelanguage.googleapis.com/v1beta/openai/',
            });
        default:
            throw new Error(`Unknown provider: ${config.provider}`);
    }
}
