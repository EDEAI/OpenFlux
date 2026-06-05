// Dynamically import @huggingface/transformers (v3), the native ONNX inference engine
import { LLMConfig, LLMProvider, LLMMessage, LLMToolDefinition, ChatWithToolsResponse } from './provider';
import path from 'path';
import fs from 'fs-extra';
import { Logger } from '../utils/logger';

const log = new Logger('LocalEmbedding');

let transformersModule: any = null;

async function getTransformers() {
    if (!transformersModule) {
        transformersModule = await import('@huggingface/transformers');

        // Model directory parsing priority:
        // 1. OPENFLUX_RESOURCE_DIR (injected by Rust at startup, most reliable)
        // 2. gateway decompression directory (prod packaging)
        // 3. cwd/resources（fallback）
        const envResourceDir = process.env.OPENFLUX_RESOURCE_DIR;
        const envModelDir = envResourceDir ? path.join(envResourceDir, 'models', 'transformers') : null;
        const gatewayModelDir = path.join(process.cwd(), 'gateway', 'resources', 'models', 'transformers');
        const cwdModelDir = path.join(process.cwd(), 'resources', 'models', 'transformers');

        const modelDir =
            (envModelDir && fs.existsSync(envModelDir)) ? envModelDir :
            fs.existsSync(gatewayModelDir) ? gatewayModelDir :
            cwdModelDir;
        transformersModule.env.localModelPath = modelDir;
        transformersModule.env.cacheDir = modelDir;
        transformersModule.env.useFSCache = true;
        // The model has been packaged with the installation package and does not require remote downloading.
        transformersModule.env.allowRemoteModels = false;
        transformersModule.env.allowLocalModels = true;
        log.info(`Model directory: ${modelDir}`);
    }
    return transformersModule;
}

export class LocalEmbeddingProvider implements LLMProvider {
    private config: LLMConfig;
    private extractor: any = null;
    private modelName: string;

    constructor(config: LLMConfig) {
        this.config = config;
        this.modelName = config.model || 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
    }

    private async ensureInitialized() {
        if (this.extractor) return;

        log.info(`Initializing local embedding model: ${this.modelName}...`);
        try {
            const { pipeline, env } = await getTransformers();

            // Make sure the model directory exists
            fs.ensureDirSync(env.localModelPath);

            // feature-extraction pipeline
            // v3 API: dtype: 'q8' corresponding to load model_quantized.onnx
            this.extractor = await pipeline('feature-extraction', this.modelName, {
                dtype: 'q8',
            });

            log.info('Local embedding model initialized successfully.');
        } catch (error: any) {
            log.error('Failed to initialize local embedding model', {
                message: error?.message || String(error),
                stack: error?.stack,
                code: error?.code,
            });
            throw error;
        }
    }

    async embed(text: string): Promise<number[]> {
        await this.ensureInitialized();

        // pooling: 'mean' is the default strategy for most sentence-transformers
        // normalize: true outputs a normalized vector for cosine similarity
        const output = await this.extractor(text, { pooling: 'mean', normalize: true });

        // output.data is a Float32Array
        return Array.from(output.data);
    }

    async embedBatch(texts: string[]): Promise<number[][]> {
        await this.ensureInitialized();

        const output = await this.extractor(texts, { pooling: 'mean', normalize: true });

        // output is a list of Tensors? Or Tensor (batch_size, hidden_size)
        // The pipeline for @xenova/transformers typically returns a list of Tensors or stacked Tensors for array inputs
        // For the sake of simplicity, we will deal with it one by one (the pipeline itself has batch optimization, but the JS side interface needs to be confirmed)
        // In fact, when pipeline('feature-extraction') passes in an array, it returns a list of Tensor

        const embeddings: number[][] = [];
        // output may be an Array (if input is an Array)
        if (Array.isArray(output)) {
            for (const tensor of output) {
                embeddings.push(Array.from(tensor.data));
            }
        } else {
            // single result
            embeddings.push(Array.from(output.data));
        }

        return embeddings;
    }

    // --- Methods that do not need to be implemented (Local Embedding is only used for vector generation) ---

    getConfig(): LLMConfig {
        return this.config;
    }

    async chat(messages: LLMMessage[]): Promise<string> {
        throw new Error('LocalEmbeddingProvider does not support chat.');
    }

    async chatWithTools(messages: LLMMessage[], tools: LLMToolDefinition[]): Promise<ChatWithToolsResponse> {
        throw new Error('LocalEmbeddingProvider does not support tools.');
    }

    async chatStream(messages: LLMMessage[], onChunk: (chunk: string) => void): Promise<string> {
        throw new Error('LocalEmbeddingProvider does not support streaming.');
    }
}
