// 动态导入 @huggingface/transformers (v3)，本地 ONNX 推理引擎
import { LLMConfig, LLMProvider, LLMMessage, LLMToolDefinition, ChatWithToolsResponse } from './provider';
import path from 'path';
import fs from 'fs-extra';
import { Logger } from '../utils/logger';

const log = new Logger('LocalEmbedding');

let transformersModule: any = null;

async function getTransformers() {
    if (!transformersModule) {
        transformersModule = await import('@huggingface/transformers');

        // 模型搜索路径: 优先 gateway 解压目录（prod 打包），其次 cwd/resources
        const gatewayModelDir = path.join(process.cwd(), 'gateway', 'resources', 'models', 'transformers');
        const cwdModelDir = path.join(process.cwd(), 'resources', 'models', 'transformers');
        const modelDir = fs.existsSync(gatewayModelDir) ? gatewayModelDir : cwdModelDir;
        transformersModule.env.localModelPath = modelDir;
        transformersModule.env.cacheDir = modelDir;
        transformersModule.env.useFSCache = true;
        // 模型已随安装包打包，无需远程下载
        transformersModule.env.allowRemoteModels = false;
        transformersModule.env.allowLocalModels = true;
        log.info(`模型目录: ${modelDir}`);
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

            // 确保模型目录存在
            fs.ensureDirSync(env.localModelPath);

            // feature-extraction pipeline
            // v3 API: dtype: 'q8' 对应加载 model_quantized.onnx
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

        // pooling: 'mean' 是大多数 sentence-transformers 的默认策略
        // normalize: true 输出归一化向量，用于余弦相似度
        const output = await this.extractor(text, { pooling: 'mean', normalize: true });

        // output.data 是 Float32Array
        return Array.from(output.data);
    }

    async embedBatch(texts: string[]): Promise<number[][]> {
        await this.ensureInitialized();

        const output = await this.extractor(texts, { pooling: 'mean', normalize: true });

        // output 是 Tensor 列表? 或者是 Tensor (batch_size, hidden_size)
        // @xenova/transformers 的 pipeline 对于数组输入，通常返回 Tensor 列表或堆叠 Tensor
        // 简单起见，我们逐个处理（pipeline 本身有 batch 优化，但 JS 端接口需要确认）
        // 实际上, pipeline('feature-extraction') 传入数组时，返回的是 list of Tensor

        const embeddings: number[][] = [];
        // output 可能是 Array (如果 input 是 Array)
        if (Array.isArray(output)) {
            for (const tensor of output) {
                embeddings.push(Array.from(tensor.data));
            }
        } else {
            // 单个结果
            embeddings.push(Array.from(output.data));
        }

        return embeddings;
    }

    // --- 不需要实现的方法 (Local Embedding 仅用于向量生成) ---

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
