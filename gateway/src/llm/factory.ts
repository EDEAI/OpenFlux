/**
 * LLM Provider Factory
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
        // OpenAI compatible interface provider (using OpenAIProvider + custom baseUrl)
        case 'minimax':
            // Minimax recommends using OpenAI compatible interfaces for Embedding
            // If baseUrl contains 'anthropic', use AnthropicProvider (Chat)
            // Otherwise the default is to use OpenAIProvider (Embedding / Chat)
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
            // Custom provider, using OpenAI compatible interface
            if (!config.baseUrl) {
                throw new Error('Custom provider requires baseUrl');
            }
            return new OpenAIProvider(config);
        case 'google':
            // Google Gemini uses OpenAI compatible interface
            return new OpenAIProvider({
                ...config,
                baseUrl: config.baseUrl || 'https://generativelanguage.googleapis.com/v1beta/openai/',
            });
        default:
            throw new Error(`Unknown provider: ${config.provider}`);
    }
}
