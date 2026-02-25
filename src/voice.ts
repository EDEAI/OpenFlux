/**
 * 渲染进程语音控制模块
 * 负责录音管理、音频播放管理和 TTS 队列
 */

/** 可注入的 TTS 合成回调（由 main.ts 通过 Gateway WebSocket 注入） */
export let voiceSynthesizeCallback: (text: string) => Promise<{ audio?: ArrayBuffer; error?: string }> = async () => ({ error: 'TTS 合成回调未初始化' });

/** 设置 TTS 合成回调 */
export function setVoiceSynthesizeCallback(cb: typeof voiceSynthesizeCallback): void {
    voiceSynthesizeCallback = cb;
}

// ========================
// 录音管理
// ========================

/** 录音状态 */
export type RecordingState = 'idle' | 'recording' | 'processing';

/** 录音状态变化回调 */
export type RecordingStateCallback = (state: RecordingState, duration?: number) => void;

/** 录音选项 */
export interface RecordingOptions {
    /** 启用 VAD（静音自动停止） */
    vad?: boolean;
    /** 触发自动停止的静音时长（毫秒，默认 1500） */
    vadSilenceMs?: number;
    /** 音量阈值（0-255，低于此值视为静音，默认 12） */
    vadThreshold?: number;
    /** 最短录音时长（毫秒，在此之前不触发 VAD，默认 800） */
    minDurationMs?: number;
}

/** 录音管理器 */
class AudioRecorder {
    private mediaRecorder: MediaRecorder | null = null;
    private audioChunks: Blob[] = [];
    private stream: MediaStream | null = null;
    private state: RecordingState = 'idle';
    private startTime = 0;
    private durationTimer: number | null = null;
    private onStateChange: RecordingStateCallback | null = null;

    // VAD 相关
    private vadContext: AudioContext | null = null;
    private vadAnalyser: AnalyserNode | null = null;
    private vadRafId: number | null = null;
    private vadSilenceStart = 0;
    private onAutoStop: (() => void) | null = null;

    /**
     * 注册状态变化回调
     */
    setStateCallback(callback: RecordingStateCallback): void {
        this.onStateChange = callback;
    }

    /**
     * 注册 VAD 自动停止回调（语音对话模式使用）
     */
    setAutoStopCallback(callback: (() => void) | null): void {
        this.onAutoStop = callback;
    }

    /**
     * 获取当前状态
     */
    getState(): RecordingState {
        return this.state;
    }

    /**
     * 开始录音
     * @param options 可选：VAD 自动停止配置
     */
    async start(options?: RecordingOptions): Promise<void> {
        if (this.state !== 'idle') {
            console.warn('[Voice] 已在录音中');
            return;
        }

        try {
            // 请求麦克风权限
            this.stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    sampleRate: 16000,
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                },
            });

            // 创建 MediaRecorder（使用 WAV-compatible 格式）
            const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
                ? 'audio/webm;codecs=opus'
                : 'audio/webm';

            this.mediaRecorder = new MediaRecorder(this.stream, { mimeType });
            this.audioChunks = [];

            this.mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    this.audioChunks.push(event.data);
                }
            };

            this.mediaRecorder.start(100); // 每 100ms 产生一个数据块
            this.startTime = Date.now();
            this.setState('recording');

            // 持续更新录音时长
            this.durationTimer = window.setInterval(() => {
                const duration = Math.floor((Date.now() - this.startTime) / 1000);
                this.onStateChange?.('recording', duration);
            }, 500);

            // 启用 VAD 自动停止
            if (options?.vad) {
                this.setupVAD(options);
            }
        } catch (error) {
            console.error('[Voice] 录音启动失败:', error);
            this.cleanup();
            throw error;
        }
    }

    /**
     * 停止录音并返回音频数据
     * @returns WAV 格式的 ArrayBuffer
     */
    async stop(): Promise<ArrayBuffer> {
        if (this.state !== 'recording' || !this.mediaRecorder) {
            throw new Error('当前未在录音');
        }

        this.stopVAD();
        this.setState('processing');

        return new Promise<ArrayBuffer>((resolve, reject) => {
            if (!this.mediaRecorder) {
                reject(new Error('MediaRecorder 不存在'));
                return;
            }

            this.mediaRecorder.onstop = async () => {
                try {
                    const blob = new Blob(this.audioChunks, { type: this.mediaRecorder?.mimeType || 'audio/webm' });
                    // 将 WebM/Opus 转换为 WAV（16kHz mono 16-bit PCM）
                    const wavBuffer = await this.convertToWav(blob);
                    this.cleanup();
                    resolve(wavBuffer);
                } catch (error) {
                    this.cleanup();
                    reject(error);
                }
            };

            this.mediaRecorder.stop();
        });
    }

    /**
     * 取消录音
     */
    cancel(): void {
        this.stopVAD();
        if (this.mediaRecorder && this.state === 'recording') {
            this.mediaRecorder.stop();
        }
        this.cleanup();
    }

    // ========================
    // VAD（语音活动检测）
    // ========================

    /**
     * 初始化 VAD 监控
     * 使用 AnalyserNode 实时分析音频频谱，检测静音段
     */
    private setupVAD(options: RecordingOptions): void {
        if (!this.stream) return;

        const silenceThreshold = options.vadThreshold ?? 12;
        const silenceDuration = options.vadSilenceMs ?? 1500;
        const minDuration = options.minDurationMs ?? 800;

        try {
            this.vadContext = new AudioContext();
            const source = this.vadContext.createMediaStreamSource(this.stream);
            this.vadAnalyser = this.vadContext.createAnalyser();
            this.vadAnalyser.fftSize = 512;
            this.vadAnalyser.smoothingTimeConstant = 0.3;
            source.connect(this.vadAnalyser);

            const bufferLength = this.vadAnalyser.frequencyBinCount;
            const dataArray = new Uint8Array(bufferLength);
            let hadVoice = false;
            this.vadSilenceStart = 0;

            const checkVAD = () => {
                if (this.state !== 'recording' || !this.vadAnalyser) return;

                this.vadAnalyser.getByteFrequencyData(dataArray);

                // 计算频谱平均能量
                let sum = 0;
                for (let i = 0; i < bufferLength; i++) {
                    sum += dataArray[i];
                }
                const average = sum / bufferLength;
                const elapsed = Date.now() - this.startTime;

                if (average > silenceThreshold) {
                    // 有声音
                    hadVoice = true;
                    this.vadSilenceStart = 0;
                } else if (hadVoice && elapsed > minDuration) {
                    // 说过话之后的静音段
                    if (this.vadSilenceStart === 0) {
                        this.vadSilenceStart = Date.now();
                    } else if (Date.now() - this.vadSilenceStart > silenceDuration) {
                        // 静音超过阈值 → 自动停止
                        console.log(`[VAD] 静音 ${silenceDuration}ms，自动停止录音`);
                        this.onAutoStop?.();
                        return; // 停止检测循环
                    }
                }

                this.vadRafId = requestAnimationFrame(checkVAD);
            };

            this.vadRafId = requestAnimationFrame(checkVAD);
            console.log(`[VAD] 已启用（阈值=${silenceThreshold}, 静音=${silenceDuration}ms, 最短=${minDuration}ms）`);
        } catch (error) {
            console.warn('[VAD] 初始化失败:', error);
        }
    }

    /** 停止 VAD 监控 */
    private stopVAD(): void {
        if (this.vadRafId !== null) {
            cancelAnimationFrame(this.vadRafId);
            this.vadRafId = null;
        }
        if (this.vadContext) {
            this.vadContext.close().catch(() => { });
            this.vadContext = null;
        }
        this.vadAnalyser = null;
        this.vadSilenceStart = 0;
    }

    /**
     * 将音频 Blob 转换为 WAV 格式（16kHz, mono, 16-bit PCM）
     */
    private async convertToWav(blob: Blob): Promise<ArrayBuffer> {
        // 使用 AudioContext 解码音频
        const audioContext = new AudioContext({ sampleRate: 16000 });

        try {
            const arrayBuffer = await blob.arrayBuffer();
            const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

            // 获取单声道数据
            const channelData = audioBuffer.getChannelData(0);

            // 如果采样率不是 16000，进行重采样
            let samples: Float32Array;
            if (audioBuffer.sampleRate !== 16000) {
                samples = this.resample(channelData, audioBuffer.sampleRate, 16000);
            } else {
                samples = channelData;
            }

            // 编码为 WAV
            return this.encodeWav(samples, 16000);
        } finally {
            await audioContext.close();
        }
    }

    /**
     * 简单线性重采样
     */
    private resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
        const ratio = fromRate / toRate;
        const outputLength = Math.round(input.length / ratio);
        const output = new Float32Array(outputLength);

        for (let i = 0; i < outputLength; i++) {
            const srcIndex = i * ratio;
            const left = Math.floor(srcIndex);
            const right = Math.min(left + 1, input.length - 1);
            const fraction = srcIndex - left;
            output[i] = input[left] * (1 - fraction) + input[right] * fraction;
        }

        return output;
    }

    /**
     * 将 Float32Array PCM 数据编码为 WAV Buffer
     */
    private encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
        const numChannels = 1;
        const bitsPerSample = 16;
        const bytesPerSample = bitsPerSample / 8;
        const dataLength = samples.length * bytesPerSample;
        const headerLength = 44;
        const totalLength = headerLength + dataLength;

        const buffer = new ArrayBuffer(totalLength);
        const view = new DataView(buffer);

        // RIFF header
        this.writeString(view, 0, 'RIFF');
        view.setUint32(4, totalLength - 8, true);
        this.writeString(view, 8, 'WAVE');

        // fmt chunk
        this.writeString(view, 12, 'fmt ');
        view.setUint32(16, 16, true); // chunk size
        view.setUint16(20, 1, true); // PCM format
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
        view.setUint16(32, numChannels * bytesPerSample, true);
        view.setUint16(34, bitsPerSample, true);

        // data chunk
        this.writeString(view, 36, 'data');
        view.setUint32(40, dataLength, true);

        // PCM 数据（Float32 -> Int16）
        let offset = headerLength;
        for (let i = 0; i < samples.length; i++) {
            const sample = Math.max(-1, Math.min(1, samples[i]));
            const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
            view.setInt16(offset, intSample, true);
            offset += 2;
        }

        return buffer;
    }

    private writeString(view: DataView, offset: number, str: string): void {
        for (let i = 0; i < str.length; i++) {
            view.setUint8(offset + i, str.charCodeAt(i));
        }
    }

    private setState(state: RecordingState): void {
        this.state = state;
        const duration = state === 'recording' ? Math.floor((Date.now() - this.startTime) / 1000) : undefined;
        this.onStateChange?.(state, duration);
    }

    private cleanup(): void {
        this.stopVAD();
        if (this.durationTimer !== null) {
            clearInterval(this.durationTimer);
            this.durationTimer = null;
        }
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
        }
        this.mediaRecorder = null;
        this.audioChunks = [];
        this.setState('idle');
    }
}

// ========================
// 音频播放管理
// ========================

/** 播放状态 */
export type PlaybackState = 'idle' | 'loading' | 'playing' | 'paused';

/** 播放状态变化回调 */
export type PlaybackStateCallback = (state: PlaybackState, messageId?: string) => void;

/** 音频播放管理器 */
class AudioPlayer {
    private currentAudio: HTMLAudioElement | null = null;
    private currentMessageId: string | null = null;
    private onStateChange: PlaybackStateCallback | null = null;

    /**
     * 注册状态变化回调
     */
    setStateCallback(callback: PlaybackStateCallback): void {
        this.onStateChange = callback;
    }

    /**
     * 获取当前播放的消息 ID
     */
    getCurrentMessageId(): string | null {
        return this.currentMessageId;
    }

    /**
     * 播放音频
     * @param audioBuffer MP3 音频数据
     * @param messageId 关联的消息 ID
     */
    async play(audioBuffer: ArrayBuffer, messageId: string): Promise<void> {
        // 停止当前播放
        this.stop();

        this.currentMessageId = messageId;
        this.onStateChange?.('loading', messageId);

        try {
            const blob = new Blob([audioBuffer], { type: 'audio/mpeg' });
            const url = URL.createObjectURL(blob);

            this.currentAudio = new Audio(url);

            this.currentAudio.onplay = () => {
                this.onStateChange?.('playing', messageId);
            };

            this.currentAudio.onended = () => {
                URL.revokeObjectURL(url);
                this.currentAudio = null;
                this.currentMessageId = null;
                this.onStateChange?.('idle', messageId);
            };

            this.currentAudio.onerror = () => {
                URL.revokeObjectURL(url);
                this.currentAudio = null;
                this.currentMessageId = null;
                this.onStateChange?.('idle', messageId);
            };

            await this.currentAudio.play();
        } catch (error) {
            console.error('[Voice] 播放失败:', error);
            this.currentAudio = null;
            this.currentMessageId = null;
            this.onStateChange?.('idle', messageId);
        }
    }

    /**
     * 暂停/恢复播放
     */
    togglePause(): void {
        if (!this.currentAudio) return;

        if (this.currentAudio.paused) {
            this.currentAudio.play();
            this.onStateChange?.('playing', this.currentMessageId!);
        } else {
            this.currentAudio.pause();
            this.onStateChange?.('paused', this.currentMessageId!);
        }
    }

    /**
     * 停止播放
     */
    stop(): void {
        if (this.currentAudio) {
            this.currentAudio.pause();
            this.currentAudio.src = '';
            this.currentAudio = null;
        }
        const prevId = this.currentMessageId;
        this.currentMessageId = null;
        if (prevId) {
            this.onStateChange?.('idle', prevId);
        }
    }

    /**
     * 是否正在播放
     */
    isPlaying(): boolean {
        return this.currentAudio !== null && !this.currentAudio.paused;
    }
}

// ========================
// TTS 队列管理（手动点击朗读按钮）
// ========================

/** TTS 请求 */
interface TTSRequest {
    text: string;
    messageId: string;
}

/** TTS 管理器（手动播放整段消息） */
class TTSManager {
    private queue: TTSRequest[] = [];
    private processing = false;
    private player: AudioPlayer;
    private abortController: AbortController | null = null;

    constructor(player: AudioPlayer) {
        this.player = player;
    }

    /**
     * 请求 TTS（加入队列）
     */
    async speak(text: string, messageId: string): Promise<void> {
        // 如果正在处理同一条消息，忽略
        if (this.queue.some(r => r.messageId === messageId)) return;

        // 停止流式 TTS（互斥）
        streamingTtsManager.cancel();

        this.queue.push({ text, messageId });

        if (!this.processing) {
            await this.processQueue();
        }
    }

    /**
     * 取消所有待处理的 TTS
     */
    cancelAll(): void {
        this.queue = [];
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        this.player.stop();
        this.processing = false;
    }

    /**
     * 取消特定消息的 TTS
     */
    cancel(messageId: string): void {
        this.queue = this.queue.filter(r => r.messageId !== messageId);
        if (this.player.getCurrentMessageId() === messageId) {
            this.player.stop();
        }
    }

    private async processQueue(): Promise<void> {
        if (this.processing || this.queue.length === 0) return;
        this.processing = true;

        while (this.queue.length > 0) {
            const request = this.queue.shift()!;
            this.abortController = new AbortController();

            try {
                const result = await voiceSynthesizeCallback(request.text);
                if (result.error) {
                    console.error('[TTS] 合成失败:', result.error);
                    continue;
                }
                if (result.audio) {
                    await this.player.play(result.audio, request.messageId);
                    // 等待播放完成
                    await this.waitForPlaybackEnd();
                }
            } catch (error) {
                if ((error as Error).name === 'AbortError') break;
                console.error('[TTS] 队列处理错误:', error);
            }
        }

        this.processing = false;
        this.abortController = null;
    }

    private waitForPlaybackEnd(): Promise<void> {
        return new Promise<void>((resolve) => {
            const check = () => {
                if (!this.player.isPlaying()) {
                    resolve();
                } else {
                    setTimeout(check, 200);
                }
            };
            check();
        });
    }
}

// ========================
// 流式 TTS 管理（LLM 流式输出逐句合成 + 流水线播放）
// ========================

/** 流式 TTS 状态 */
export type StreamingTTSState = 'idle' | 'buffering' | 'synthesizing' | 'playing';

/** 流式 TTS 状态回调 */
export type StreamingTTSStateCallback = (state: StreamingTTSState) => void;

/**
 * 流式 TTS 管理器
 *
 * 工作原理：
 *   LLM token → feedToken() → 句子切分 → 逐句合成（IPC） → 流水线播放
 *   合成句子 N+1 与播放句子 N 并行，大幅降低首次发声延迟
 */
class StreamingTTSManager {
    private pendingText = '';               // 待切分的原始文本
    private sentenceQueue: string[] = [];   // 待合成的句子队列
    private audioQueue: ArrayBuffer[] = []; // 待播放的音频队列
    private isSynthesizing = false;
    private isPlaying = false;
    private cancelled = true;               // 初始为 cancelled
    private messageId = '';
    private currentAudio: HTMLAudioElement | null = null;
    private onStateChange: StreamingTTSStateCallback | null = null;

    /** 最短句子长度（字符数），避免碎片化合成 */
    private readonly MIN_SENTENCE_LEN = 6;
    /** 缓冲区上限（字符数），超过后强制切分 */
    private readonly MAX_BUFFER_LEN = 150;

    setStateCallback(cb: StreamingTTSStateCallback | null): void {
        this.onStateChange = cb;
    }

    /**
     * 开始流式 TTS（新消息开始流式输出时调用）
     */
    startStreaming(messageId: string): void {
        this.cancel();
        this.messageId = messageId;
        this.cancelled = false;
        this.pendingText = '';
        this.onStateChange?.('buffering');

        // 互斥：停止手动播放
        player.stop();
        ttsManager.cancelAll();
    }

    /**
     * 喂入 LLM 流式 token
     */
    feedToken(token: string): void {
        if (this.cancelled) return;
        this.pendingText += token;
        this.extractAndEnqueue();
    }

    /**
     * 流式输出结束，刷出剩余文本
     */
    finishStreaming(): void {
        if (this.cancelled) return;
        const remaining = this.pendingText.trim();
        if (remaining) {
            this.sentenceQueue.push(remaining);
            this.pendingText = '';
            this.kickSynthesis();
        }
    }

    /**
     * 取消所有合成和播放
     */
    cancel(): void {
        if (this.cancelled) return;
        this.cancelled = true;
        this.pendingText = '';
        this.sentenceQueue = [];
        this.audioQueue = [];
        this.isSynthesizing = false;
        this.isPlaying = false;
        if (this.currentAudio) {
            this.currentAudio.pause();
            this.currentAudio.src = '';
            this.currentAudio = null;
        }
        this.onStateChange?.('idle');
    }

    /**
     * 是否有未完成的任务
     */
    isActive(): boolean {
        return !this.cancelled && (
            this.pendingText.length > 0 ||
            this.sentenceQueue.length > 0 ||
            this.audioQueue.length > 0 ||
            this.isSynthesizing ||
            this.isPlaying
        );
    }

    // ---- 内部方法 ----

    /** 从缓冲区提取完整句子 */
    private extractAndEnqueue(): void {
        while (true) {
            let splitIdx = -1;

            // 中文句末标点（。！？；及换行）
            const cnIdx = this.pendingText.search(/[。！？；\n]/);
            if (cnIdx !== -1) {
                splitIdx = cnIdx + 1;
            }

            // 英文句末标点（. ! ? 后跟空格）
            if (splitIdx === -1) {
                const enMatch = /[.!?]\s/.exec(this.pendingText);
                if (enMatch) {
                    splitIdx = enMatch.index + enMatch[0].length;
                }
            }

            // 缓冲区过长，强制在逗号或空格处切分
            if (splitIdx === -1 && this.pendingText.length > this.MAX_BUFFER_LEN) {
                const lastComma = this.pendingText.lastIndexOf('，', this.MAX_BUFFER_LEN);
                const lastSpace = this.pendingText.lastIndexOf(' ', this.MAX_BUFFER_LEN);
                splitIdx = Math.max(lastComma, lastSpace);
                if (splitIdx <= 0) splitIdx = this.MAX_BUFFER_LEN;
                else splitIdx += 1;
            }

            if (splitIdx === -1) break;

            const sentence = this.pendingText.slice(0, splitIdx).trim();
            this.pendingText = this.pendingText.slice(splitIdx);

            if (sentence.length >= this.MIN_SENTENCE_LEN) {
                this.sentenceQueue.push(sentence);
            } else if (sentence) {
                // 太短，放回缓冲区
                this.pendingText = sentence + this.pendingText;
                break;
            }
        }

        this.kickSynthesis();
    }

    /** 启动合成循环（如果尚未运行） */
    private kickSynthesis(): void {
        if (!this.isSynthesizing && this.sentenceQueue.length > 0 && !this.cancelled) {
            this.synthesizeLoop();
        }
    }

    /** 合成循环：依次取出句子合成音频，推入音频队列 */
    private async synthesizeLoop(): Promise<void> {
        this.isSynthesizing = true;

        while (this.sentenceQueue.length > 0 && !this.cancelled) {
            const sentence = this.sentenceQueue.shift()!;
            this.onStateChange?.('synthesizing');
            console.log(`[StreamingTTS] 合成: "${sentence.slice(0, 40)}${sentence.length > 40 ? '...' : ''}"`);

            try {
                const result = await voiceSynthesizeCallback(sentence);
                if (this.cancelled) break;

                if (result.audio) {
                    this.audioQueue.push(result.audio);
                    // 如果播放循环未运行，启动它
                    if (!this.isPlaying) {
                        this.playLoop();
                    }
                } else if (result.error) {
                    console.warn('[StreamingTTS] 合成失败:', result.error);
                }
            } catch (error) {
                console.error('[StreamingTTS] 合成异常:', error);
            }
        }

        this.isSynthesizing = false;
        this.checkDone();
    }

    /** 播放循环：依次从音频队列取出播放 */
    private async playLoop(): Promise<void> {
        this.isPlaying = true;

        while (this.audioQueue.length > 0 && !this.cancelled) {
            const audioData = this.audioQueue.shift()!;
            this.onStateChange?.('playing');

            try {
                await this.playAudioBuffer(audioData);
            } catch (error) {
                console.error('[StreamingTTS] 播放异常:', error);
            }
        }

        this.isPlaying = false;
        this.checkDone();
    }

    /** 检查是否全部完成 */
    private checkDone(): void {
        if (
            !this.cancelled &&
            !this.isSynthesizing &&
            !this.isPlaying &&
            this.sentenceQueue.length === 0 &&
            this.audioQueue.length === 0
        ) {
            this.onStateChange?.('idle');
        }
    }

    /** 播放单个音频 Buffer（返回 Promise，播放完毕后 resolve） */
    private playAudioBuffer(buffer: ArrayBuffer): Promise<void> {
        return new Promise((resolve) => {
            if (this.cancelled) { resolve(); return; }

            const blob = new Blob([buffer], { type: 'audio/mpeg' });
            const url = URL.createObjectURL(blob);
            this.currentAudio = new Audio(url);

            const cleanup = () => {
                URL.revokeObjectURL(url);
                if (this.currentAudio) {
                    this.currentAudio.onended = null;
                    this.currentAudio.onerror = null;
                    this.currentAudio = null;
                }
                resolve();
            };

            this.currentAudio.onended = cleanup;
            this.currentAudio.onerror = cleanup;
            this.currentAudio.play().catch(cleanup);
        });
    }
}

// ========================
// 环境音（思考中背景音）
// ========================

/**
 * 程序化生成的冥想风格环境音
 *
 * 原理：使用 Web Audio API 合成多个低频正弦波 + 缓慢 LFO 调制，
 * 产生空灵、呼吸感的背景氛围音。
 */
class AmbientSound {
    private ctx: AudioContext | null = null;
    private masterGain: GainNode | null = null;
    private oscillators: OscillatorNode[] = [];
    private lfoGains: GainNode[] = [];
    private isPlaying = false;
    private fadeTimer: number | null = null;

    /** 音量（0-1） */
    private volume = 0.08;

    /**
     * 开始播放环境音（渐入）
     */
    start(): void {
        if (this.isPlaying) return;

        try {
            this.ctx = new AudioContext();
            this.masterGain = this.ctx.createGain();
            this.masterGain.gain.value = 0; // 从 0 渐入
            this.masterGain.connect(this.ctx.destination);

            // 定义和弦音层
            // 低音层：缓慢呼吸（LFO < 0.1Hz）提供稳定基底
            // 高音层：快速闪烁（LFO 0.8-1.5Hz）产生空灵微光感
            const layers = [
                { freq: 130.8, lfoRate: 0.05, lfoDepth: 0.3, gain: 0.30 },  // 低 C3（慢呼吸）
                { freq: 174, lfoRate: 0.08, lfoDepth: 0.3, gain: 0.25 },  // F3（缓慢起伏）
                { freq: 220, lfoRate: 0.8, lfoDepth: 0.7, gain: 0.10 },  // A3 — 快速闪烁
                { freq: 261.6, lfoRate: 1.2, lfoDepth: 0.8, gain: 0.06 },  // C4 — 更快闪烁
                { freq: 329.6, lfoRate: 1.5, lfoDepth: 0.9, gain: 0.03 },  // E4 — 最快微光
                { freq: 293.7, lfoRate: 0.9, lfoDepth: 0.75, gain: 0.04 },  // D4 — 交错节奏
            ];

            for (const layer of layers) {
                // 音源振荡器
                const osc = this.ctx.createOscillator();
                osc.type = 'sine';
                osc.frequency.value = layer.freq;

                // 层音量
                const layerGain = this.ctx.createGain();
                layerGain.gain.value = layer.gain;

                // LFO：缓慢调制音量，产生呼吸感
                const lfo = this.ctx.createOscillator();
                lfo.type = 'sine';
                lfo.frequency.value = layer.lfoRate;

                const lfoGain = this.ctx.createGain();
                lfoGain.gain.value = layer.lfoDepth * layer.gain;

                // LFO → layerGain.gain（调制音量）
                lfo.connect(lfoGain);
                lfoGain.connect(layerGain.gain);

                // 音源 → layerGain → masterGain
                osc.connect(layerGain);
                layerGain.connect(this.masterGain);

                osc.start();
                lfo.start();

                this.oscillators.push(osc, lfo);
                this.lfoGains.push(lfoGain);
            }

            // 渐入（2 秒）
            this.masterGain.gain.setValueAtTime(0, this.ctx.currentTime);
            this.masterGain.gain.linearRampToValueAtTime(this.volume, this.ctx.currentTime + 2);

            this.isPlaying = true;
        } catch (error) {
            console.warn('[Ambient] 启动失败:', error);
            this.cleanup();
        }
    }

    /**
     * 停止播放环境音（渐出）
     */
    stop(): void {
        if (!this.isPlaying || !this.ctx || !this.masterGain) return;

        try {
            // 渐出（1.5 秒）
            const now = this.ctx.currentTime;
            this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
            this.masterGain.gain.linearRampToValueAtTime(0, now + 1.5);

            // 渐出结束后清理
            this.fadeTimer = window.setTimeout(() => {
                this.cleanup();
            }, 1600);
        } catch {
            this.cleanup();
        }
    }

    /**
     * 立即停止（无渐出）
     */
    stopImmediate(): void {
        this.cleanup();
    }

    /**
     * 是否正在播放
     */
    getIsPlaying(): boolean {
        return this.isPlaying;
    }

    /**
     * 设置音量（0-1）
     */
    setVolume(vol: number): void {
        this.volume = Math.max(0, Math.min(1, vol));
        if (this.masterGain && this.ctx && this.isPlaying) {
            this.masterGain.gain.setValueAtTime(this.volume, this.ctx.currentTime);
        }
    }

    private cleanup(): void {
        if (this.fadeTimer !== null) {
            clearTimeout(this.fadeTimer);
            this.fadeTimer = null;
        }
        for (const osc of this.oscillators) {
            try { osc.stop(); } catch { /* 忽略 */ }
        }
        this.oscillators = [];
        this.lfoGains = [];
        if (this.ctx) {
            this.ctx.close().catch(() => { });
            this.ctx = null;
        }
        this.masterGain = null;
        this.isPlaying = false;
    }
}

// ========================
// 语音打断检测（Barge-In）
// ========================

/**
 * 语音打断检测（Barge-In）
 *
 * 在 TTS 播放期间后台监听麦克风，检测用户是否开口说话。
 *
 * 策略：自适应基线 + 两阶段验证
 *   1. 校准期（500ms）：采集环境噪音基线（含 TTS 回声）
 *   2. 阶段一（候选）：音量超过 基线×倍率 且持续 150ms → 进入验证
 *   3. 阶段二（验证）：等待 120ms 后再次检查音量是否仍超过阈值
 *      - 仍超过 → 判定为说话，触发打断
 *      - 已衰减 → 判定为咳嗽/杂音，重置
 *
 * 这样咳嗽（~200ms 爆发后快速衰减）不会误触发，
 * 而说话（持续发声）能在 ~270ms 内可靠检测到。
 */
class BargeInDetector {
    private stream: MediaStream | null = null;
    private ctx: AudioContext | null = null;
    private analyser: AnalyserNode | null = null;
    private rafId: number | null = null;
    private active = false;
    private onBargeIn: (() => void) | null = null;

    // 自适应参数
    private baseline = 0;
    private readonly multiplier = 2.5;
    private readonly minThreshold = 10;
    private readonly calibrateMs = 500;

    // 两阶段检测参数
    private readonly stage1Ms = 150;      // 阶段一：初始持续要求
    private readonly stage2DelayMs = 120;  // 阶段二：验证等待时间
    private stage: 'calibrate' | 'listen' | 'candidate' | 'verify' = 'calibrate';

    private startTime = 0;
    private voiceStart = 0;
    private verifyStart = 0;
    private calibrateSamples: number[] = [];

    setCallback(cb: (() => void) | null): void {
        this.onBargeIn = cb;
    }

    async start(): Promise<void> {
        if (this.active) return;

        try {
            this.stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true },
            });

            this.ctx = new AudioContext();
            const source = this.ctx.createMediaStreamSource(this.stream);
            this.analyser = this.ctx.createAnalyser();
            this.analyser.fftSize = 256;
            this.analyser.smoothingTimeConstant = 0.3;
            source.connect(this.analyser);

            const bufferLength = this.analyser.frequencyBinCount;
            const dataArray = new Uint8Array(bufferLength);

            this.startTime = Date.now();
            this.voiceStart = 0;
            this.verifyStart = 0;
            this.baseline = 0;
            this.calibrateSamples = [];
            this.stage = 'calibrate';
            this.active = true;

            const check = () => {
                if (!this.active || !this.analyser) return;

                this.analyser.getByteFrequencyData(dataArray);
                let sum = 0;
                for (let i = 0; i < bufferLength; i++) sum += dataArray[i];
                const avg = sum / bufferLength;

                const elapsed = Date.now() - this.startTime;

                // ---- 校准阶段 ----
                if (this.stage === 'calibrate') {
                    this.calibrateSamples.push(avg);
                    if (elapsed >= this.calibrateMs) {
                        const total = this.calibrateSamples.reduce((a, b) => a + b, 0);
                        this.baseline = total / this.calibrateSamples.length;
                        this.calibrateSamples = [];
                        this.stage = 'listen';
                        const thr = Math.max(this.baseline * this.multiplier, this.minThreshold);
                        console.log(`[BargeIn] 校准完成: 基线=${this.baseline.toFixed(1)}, 阈值=${thr.toFixed(1)}`);
                    }
                    this.rafId = requestAnimationFrame(check);
                    return;
                }

                const threshold = Math.max(this.baseline * this.multiplier, this.minThreshold);

                // ---- 阶段一：监听 ----
                if (this.stage === 'listen') {
                    if (avg > threshold) {
                        if (this.voiceStart === 0) {
                            this.voiceStart = Date.now();
                        } else if (Date.now() - this.voiceStart > this.stage1Ms) {
                            // 持续超过阈值 → 进入候选
                            this.stage = 'candidate';
                            this.voiceStart = 0;
                        }
                    } else {
                        this.voiceStart = 0;
                        // 安静时缓慢更新基线
                        this.baseline = this.baseline * 0.98 + avg * 0.02;
                    }
                }

                // ---- 阶段二前半：候选（等待一小段再验证） ----
                if (this.stage === 'candidate') {
                    // 进入验证等待
                    this.stage = 'verify';
                    this.verifyStart = Date.now();
                }

                // ---- 阶段二后半：验证 ----
                if (this.stage === 'verify') {
                    if (Date.now() - this.verifyStart >= this.stage2DelayMs) {
                        // 验证时刻：音量是否仍然超过阈值
                        if (avg > threshold) {
                            console.log(`[BargeIn] 触发打断 (音量=${avg.toFixed(1)}, 阈值=${threshold.toFixed(1)}, 基线=${this.baseline.toFixed(1)})`);
                            this.stop();
                            this.onBargeIn?.();
                            return;
                        } else {
                            // 已衰减 → 是咳嗽/杂音，重置
                            console.log(`[BargeIn] 瞬态噪音已过滤 (音量=${avg.toFixed(1)}, 阈值=${threshold.toFixed(1)})`);
                            this.stage = 'listen';
                            this.voiceStart = 0;
                        }
                    }
                }

                this.rafId = requestAnimationFrame(check);
            };

            this.rafId = requestAnimationFrame(check);
        } catch (error) {
            console.warn('[BargeIn] 启动失败:', error);
            this.stop();
        }
    }

    stop(): void {
        this.active = false;
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
        if (this.stream) {
            this.stream.getTracks().forEach(t => t.stop());
            this.stream = null;
        }
        if (this.ctx) {
            this.ctx.close().catch(() => { });
            this.ctx = null;
        }
        this.analyser = null;
        this.voiceStart = 0;
        this.verifyStart = 0;
        this.stage = 'calibrate';
        this.calibrateSamples = [];
    }

    isActive(): boolean {
        return this.active;
    }
}

// ========================
// 导出单例
// ========================

export const recorder = new AudioRecorder();
export const player = new AudioPlayer();
export const ttsManager = new TTSManager(player);
export const streamingTtsManager = new StreamingTTSManager();
export const ambientSound = new AmbientSound();
export const bargeInDetector = new BargeInDetector();