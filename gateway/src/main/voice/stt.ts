/**
 * Sherpa-ONNX 本地语音识别（STT）服务
 * 使用 sherpa-onnx-node 进行离线语音转文字
 */
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

// ESM 环境下 polyfill
const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// sherpa-onnx-node 是 CommonJS 模块，使用动态 require
let sherpaOnnx: any = null;

/** STT 服务配置 */
export interface STTConfig {
    /** 是否启用 */
    enabled: boolean;
    /** 模型目录路径（包含 model.onnx 和 tokens.txt） */
    modelDir?: string;
    /** 线程数 */
    numThreads?: number;
}

/** STT 识别结果 */
export interface STTResult {
    /** 识别的文本 */
    text: string;
    /** 耗时（毫秒） */
    elapsed: number;
}

/**
 * STT 语音识别服务
 */
export class STTService {
    private recognizer: any = null;
    private config: STTConfig;
    private initialized = false;

    constructor(config: STTConfig) {
        this.config = config;
    }

    /**
     * 初始化识别器（加载模型）
     */
    async initialize(): Promise<void> {
        if (!this.config.enabled) {
            console.log('[STT] 语音识别已禁用');
            return;
        }

        try {
            // 动态加载 sherpa-onnx-node
            sherpaOnnx = require('sherpa-onnx-node');
        } catch (error) {
            console.error('[STT] 加载 sherpa-onnx-node 失败:', error);
            throw new Error('sherpa-onnx-node 加载失败，请确认已正确安装');
        }

        // 查找模型目录
        const modelDir = this.resolveModelDir();
        if (!modelDir) {
            console.warn('[STT] 未找到模型文件，语音识别不可用。请下载模型到 resources/models/sherpa-onnx/ 目录');
            return;
        }

        // 检测模型类型并创建识别器
        const recognizerConfig = this.buildRecognizerConfig(modelDir);
        if (!recognizerConfig) {
            console.warn('[STT] 无法构建识别器配置，模型文件可能不完整');
            return;
        }

        try {
            this.recognizer = new sherpaOnnx.OfflineRecognizer(recognizerConfig);
            this.initialized = true;
            console.log('[STT] 语音识别初始化完成，模型目录:', modelDir);
        } catch (error) {
            console.error('[STT] 识别器初始化失败:', error);
            throw error;
        }
    }

    /**
     * 识别音频数据
     * @param audioBuffer WAV 格式的音频数据（Buffer）
     * @returns 识别结果
     */
    async transcribe(audioBuffer: Buffer): Promise<STTResult> {
        if (!this.initialized || !this.recognizer) {
            throw new Error('STT 服务未初始化，请先下载模型文件');
        }

        const start = Date.now();

        try {
            // 解析 WAV 头部，提取 PCM 数据
            const { sampleRate, samples } = this.parseWavBuffer(audioBuffer);

            // 创建识别流
            const stream = this.recognizer.createStream();
            stream.acceptWaveform({ sampleRate, samples });

            // 执行识别
            this.recognizer.decode(stream);
            const result = this.recognizer.getResult(stream);

            const elapsed = Date.now() - start;
            const text = (result.text || '').trim();

            console.log(`[STT] 识别完成: "${text}" (${elapsed}ms)`);
            return { text, elapsed };
        } catch (error) {
            console.error('[STT] 识别失败:', error);
            throw error;
        }
    }

    /**
     * 检查服务是否可用
     */
    isAvailable(): boolean {
        return this.initialized && this.recognizer !== null;
    }

    /**
     * 释放资源
     */
    destroy(): void {
        this.recognizer = null;
        this.initialized = false;
    }

    // ========================
    // 私有方法
    // ========================

    /**
     * 查找模型目录
     */
    private resolveModelDir(): string | null {
        // 用户配置的路径优先
        if (this.config.modelDir && existsSync(this.config.modelDir)) {
            return this.config.modelDir;
        }

        const isPackaged = !(process as any).defaultApp && !!(process as any).resourcesPath;

        // 默认搜索路径
        const searchPaths = [
            // 打包后: extraResources 中的模型目录
            ...(isPackaged ? [
                join((process as any).resourcesPath, 'models', 'sherpa-onnx'),
                join((process as any).resourcesPath, 'models'),
            ] : []),
            // 开发模式: 项目目录下的 resources
            join(process.cwd(), 'resources', 'models', 'sherpa-onnx'),
            join(process.cwd(), 'models', 'sherpa-onnx'),
            join(__dirname, '../../resources/models/sherpa-onnx'),
            join(__dirname, '../../../resources/models/sherpa-onnx'),
        ];

        for (const basePath of searchPaths) {
            if (!existsSync(basePath)) continue;

            // 查找包含 tokens.txt 的子目录（即模型目录）
            try {
                const { readdirSync } = require('fs');
                const entries = readdirSync(basePath, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        const candidatePath = join(basePath, entry.name);
                        if (existsSync(join(candidatePath, 'tokens.txt'))) {
                            return candidatePath;
                        }
                    }
                }
                // 也可能 tokens.txt 直接在 basePath 下
                if (existsSync(join(basePath, 'tokens.txt'))) {
                    return basePath;
                }
            } catch {
                // 忽略读取错误
            }
        }

        return null;
    }

    /**
     * 根据模型目录内容构建识别器配置
     */
    private buildRecognizerConfig(modelDir: string): any {
        const tokensPath = join(modelDir, 'tokens.txt');
        if (!existsSync(tokensPath)) return null;

        const numThreads = this.config.numThreads || 2;

        // 检测 Paraformer 模型
        const paraformerModel = this.findFile(modelDir, ['model.int8.onnx', 'model.onnx']);
        if (paraformerModel) {
            return {
                featConfig: { sampleRate: 16000, featureDim: 80 },
                modelConfig: {
                    paraformer: { model: paraformerModel },
                    tokens: tokensPath,
                    numThreads,
                    provider: 'cpu',
                    debug: 0,
                },
            };
        }

        // 检测 Whisper 模型
        const whisperEncoder = this.findFile(modelDir, ['encoder.int8.onnx', 'encoder.onnx']);
        const whisperDecoder = this.findFile(modelDir, ['decoder.int8.onnx', 'decoder.onnx']);
        if (whisperEncoder && whisperDecoder) {
            return {
                featConfig: { sampleRate: 16000, featureDim: 80 },
                modelConfig: {
                    whisper: { encoder: whisperEncoder, decoder: whisperDecoder },
                    tokens: tokensPath,
                    numThreads,
                    provider: 'cpu',
                    debug: 0,
                },
            };
        }

        // 检测 Zipformer/Transducer 模型
        const encoder = this.findFile(modelDir, ['encoder-epoch-99-avg-1.int8.onnx', 'encoder-epoch-99-avg-1.onnx', 'encoder.int8.onnx', 'encoder.onnx']);
        const decoder = this.findFile(modelDir, ['decoder-epoch-99-avg-1.int8.onnx', 'decoder-epoch-99-avg-1.onnx', 'decoder.int8.onnx', 'decoder.onnx']);
        const joiner = this.findFile(modelDir, ['joiner-epoch-99-avg-1.int8.onnx', 'joiner-epoch-99-avg-1.onnx', 'joiner.int8.onnx', 'joiner.onnx']);
        if (encoder && decoder && joiner) {
            return {
                featConfig: { sampleRate: 16000, featureDim: 80 },
                modelConfig: {
                    transducer: { encoder, decoder, joiner },
                    tokens: tokensPath,
                    numThreads,
                    provider: 'cpu',
                    debug: 0,
                },
            };
        }

        console.warn('[STT] 未识别的模型格式，目录:', modelDir);
        return null;
    }

    /**
     * 在目录中查找第一个存在的文件
     */
    private findFile(dir: string, candidates: string[]): string | null {
        for (const name of candidates) {
            const fullPath = join(dir, name);
            if (existsSync(fullPath)) return fullPath;
        }
        return null;
    }

    /**
     * 解析 WAV Buffer 为 PCM Float32 采样数据
     * 支持 16-bit PCM WAV 格式
     */
    private parseWavBuffer(buffer: Buffer): { sampleRate: number; samples: Float32Array } {
        // WAV 文件头解析
        const riff = buffer.toString('ascii', 0, 4);
        if (riff !== 'RIFF') {
            throw new Error('不是有效的 WAV 文件');
        }

        const format = buffer.toString('ascii', 8, 12);
        if (format !== 'WAVE') {
            throw new Error('不是有效的 WAVE 格式');
        }

        // 查找 fmt 和 data chunks
        let offset = 12;
        let sampleRate = 16000;
        let bitsPerSample = 16;
        let numChannels = 1;
        let dataOffset = 0;
        let dataSize = 0;

        while (offset < buffer.length - 8) {
            const chunkId = buffer.toString('ascii', offset, offset + 4);
            const chunkSize = buffer.readUInt32LE(offset + 4);

            if (chunkId === 'fmt ') {
                // const audioFormat = buffer.readUInt16LE(offset + 8);
                numChannels = buffer.readUInt16LE(offset + 10);
                sampleRate = buffer.readUInt32LE(offset + 12);
                bitsPerSample = buffer.readUInt16LE(offset + 22);
            } else if (chunkId === 'data') {
                dataOffset = offset + 8;
                dataSize = chunkSize;
                break;
            }

            offset += 8 + chunkSize;
        }

        if (dataOffset === 0 || dataSize === 0) {
            throw new Error('WAV 文件中未找到音频数据');
        }

        // 将 PCM 数据转换为 Float32Array
        const bytesPerSample = bitsPerSample / 8;
        const totalSamples = dataSize / bytesPerSample / numChannels;
        const samples = new Float32Array(totalSamples);

        for (let i = 0; i < totalSamples; i++) {
            // 只取第一个声道
            const sampleOffset = dataOffset + i * numChannels * bytesPerSample;

            if (bitsPerSample === 16) {
                const value = buffer.readInt16LE(sampleOffset);
                samples[i] = value / 32768.0;
            } else if (bitsPerSample === 32) {
                const value = buffer.readFloatLE(sampleOffset);
                samples[i] = value;
            }
        }

        return { sampleRate, samples };
    }
}
