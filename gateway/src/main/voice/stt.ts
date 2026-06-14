/**
 * Sherpa-ONNX local speech recognition (STT) service
 * Use sherpa-onnx-node for offline speech-to-text
 */
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

// polyfill in ESM environment
const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// sherpa-onnx-node is a CommonJS module that uses dynamic require
let sherpaOnnx: any = null;

/** STT service configuration */
export interface STTConfig {
    /** Whether to enable */
    enabled: boolean;
    /** Model directory path (including model.onnx and tokens.txt) */
    modelDir?: string;
    /** Number of threads */
    numThreads?: number;
}

/** STT recognition results */
export interface STTResult {
    /** Recognized text */
    text: string;
    /** Time taken (milliseconds) */
    elapsed: number;
}

/**
 * STT Voice Recognition Service
 */
export class STTService {
    private recognizer: any = null;
    private config: STTConfig;
    private initialized = false;

    constructor(config: STTConfig) {
        this.config = config;
    }

    /**
     * Initialize the recognizer (load the model)
     */
    async initialize(): Promise<void> {
        if (!this.config.enabled) {
            console.log('[STT] Speech recognition disabled');
            return;
        }

        try {
            // Dynamically load sherpa-onnx-node
            sherpaOnnx = require('sherpa-onnx-node');
        } catch (error) {
            console.error('[STT] Failed to load sherpa-onnx-node:', error);
            throw new Error('sherpa-onnx-node failed to load, please verify it is installed correctly');
        }

        // Find model catalog
        const modelDir = this.resolveModelDir();
        if (!modelDir) {
            console.warn('[STT] Model files not found, speech recognition unavailable. Please download models to resources/models/sherpa-onnx/ directory');
            return;
        }

        // Detect model type and create recognizer
        const recognizerConfig = this.buildRecognizerConfig(modelDir);
        if (!recognizerConfig) {
            console.warn('[STT] Cannot build recognizer config, model files may be incomplete');
            return;
        }

        try {
            this.recognizer = new sherpaOnnx.OfflineRecognizer(recognizerConfig);
            this.initialized = true;
            console.log('[STT] Speech recognition initialized, model dir:', modelDir);
        } catch (error) {
            console.error('[STT] Recognizer initialization failed:', error);
            throw error;
        }
    }

    /**
     * Identify audio data
     * @param audioBuffer WAV format audio data (Buffer)
     * @returns recognition results
     */
    async transcribe(audioBuffer: Buffer): Promise<STTResult> {
        if (!this.initialized || !this.recognizer) {
            throw new Error('STT service not initialized, please download model files first');
        }

        const start = Date.now();

        try {
            // Parse the WAV header and extract the PCM data
            const { sampleRate, samples } = this.parseWavBuffer(audioBuffer);

            // Create recognition flow
            const stream = this.recognizer.createStream();
            stream.acceptWaveform({ sampleRate, samples });

            // Perform identification
            this.recognizer.decode(stream);
            const result = this.recognizer.getResult(stream);

            const elapsed = Date.now() - start;
            const text = (result.text || '').trim();

            console.log(`[STT] Recognition complete: "${text}" (${elapsed}ms)`);
            return { text, elapsed };
        } catch (error) {
            console.error('[STT] Recognition failed:', error);
            throw error;
        }
    }

    /**
     * Check if the service is available
     */
    isAvailable(): boolean {
        return this.initialized && this.recognizer !== null;
    }

    /**
     * Release resources
     */
    destroy(): void {
        this.recognizer = null;
        this.initialized = false;
    }

    // ========================
    // private method
    // ========================

    /**
     * Find model catalog
     */
    private resolveModelDir(): string | null {
        // User-configured paths take precedence
        if (this.config.modelDir && existsSync(this.config.modelDir)) {
            return this.config.modelDir;
        }

        const isPackaged = !(process as any).defaultApp && !!(process as any).resourcesPath;

        // Default search path
        const searchPaths = [
            // After packaging: model directory in extraResources
            ...(isPackaged ? [
                join((process as any).resourcesPath, 'models', 'sherpa-onnx'),
                join((process as any).resourcesPath, 'models'),
            ] : []),
            // Development mode: resources in the project directory
            join(process.cwd(), 'resources', 'models', 'sherpa-onnx'),
            join(process.cwd(), 'models', 'sherpa-onnx'),
            join(__dirname, '../../resources/models/sherpa-onnx'),
            join(__dirname, '../../../resources/models/sherpa-onnx'),
        ];

        for (const basePath of searchPaths) {
            if (!existsSync(basePath)) continue;

            // Find the subdirectory containing tokens.txt (i.e. the model directory)
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
                // It is also possible that tokens.txt is directly under basePath
                if (existsSync(join(basePath, 'tokens.txt'))) {
                    return basePath;
                }
            } catch {
                // Ignore read errors
            }
        }

        return null;
    }

    /**
     * Build recognizer configuration based on model directory contents
     */
    private buildRecognizerConfig(modelDir: string): any {
        const tokensPath = join(modelDir, 'tokens.txt');
        if (!existsSync(tokensPath)) return null;

        const numThreads = this.config.numThreads || 2;

        // Detecting Paraformer models
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

        // Detecting Whisper models
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

        // Detecting Zipformer/Transducer models
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

        console.warn('[STT] Unrecognized model format, dir:', modelDir);
        return null;
    }

    /**
     * Find the first existing file in a directory
     */
    private findFile(dir: string, candidates: string[]): string | null {
        for (const name of candidates) {
            const fullPath = join(dir, name);
            if (existsSync(fullPath)) return fullPath;
        }
        return null;
    }

    /**
     * Parse WAV Buffer into PCM Float32 sampled data
     * Supports 16-bit PCM WAV format
     */
    private parseWavBuffer(buffer: Buffer): { sampleRate: number; samples: Float32Array } {
        // WAV file header analysis
        const riff = buffer.toString('ascii', 0, 4);
        if (riff !== 'RIFF') {
            throw new Error('Not a valid WAV file');
        }

        const format = buffer.toString('ascii', 8, 12);
        if (format !== 'WAVE') {
            throw new Error('Not a valid WAVE format');
        }

        // Find fmt and data chunks
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
            throw new Error('Audio data not found in WAV file');
        }

        // Convert PCM data to Float32Array
        const bytesPerSample = bitsPerSample / 8;
        const totalSamples = dataSize / bytesPerSample / numChannels;
        const samples = new Float32Array(totalSamples);

        for (let i = 0; i < totalSamples; i++) {
            // Only take the first channel
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
