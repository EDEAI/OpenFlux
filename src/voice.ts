/**
 * Renderer-process voice control module
 * Handles recording management, audio playback management, and the TTS queue
 */

/** Injectable TTS synthesis callback (injected by main.ts via the Gateway WebSocket) */
export let voiceSynthesizeCallback: (text: string) => Promise<{ audio?: ArrayBuffer; error?: string }> = async () => ({ error: 'TTS 合成回调未初始化' });

/** Set the TTS synthesis callback */
export function setVoiceSynthesizeCallback(cb: typeof voiceSynthesizeCallback): void {
    voiceSynthesizeCallback = cb;
}

// ========================
// Recording management
// ========================

/** Recording state */
export type RecordingState = 'idle' | 'recording' | 'processing';

/** Recording state change callback */
export type RecordingStateCallback = (state: RecordingState, duration?: number) => void;

/** Recording options */
export interface RecordingOptions {
    /** Enable VAD (auto-stop on silence) */
    vad?: boolean;
    /** Silence duration that triggers auto-stop (ms, default 1500) */
    vadSilenceMs?: number;
    /** Volume threshold (0-255; below this counts as silence, default 12) */
    vadThreshold?: number;
    /** Minimum recording duration (ms; VAD is not triggered before this, default 800) */
    minDurationMs?: number;
}

/** Recording manager */
class AudioRecorder {
    private mediaRecorder: MediaRecorder | null = null;
    private audioChunks: Blob[] = [];
    private stream: MediaStream | null = null;
    private state: RecordingState = 'idle';
    private startTime = 0;
    private durationTimer: number | null = null;
    private onStateChange: RecordingStateCallback | null = null;

    // VAD-related
    private vadContext: AudioContext | null = null;
    private vadAnalyser: AnalyserNode | null = null;
    private vadRafId: number | null = null;
    private vadSilenceStart = 0;
    private onAutoStop: (() => void) | null = null;

    /**
     * Register a state change callback
     */
    setStateCallback(callback: RecordingStateCallback): void {
        this.onStateChange = callback;
    }

    /**
     * Register the VAD auto-stop callback (used by voice conversation mode)
     */
    setAutoStopCallback(callback: (() => void) | null): void {
        this.onAutoStop = callback;
    }

    /**
     * Get the current state
     */
    getState(): RecordingState {
        return this.state;
    }

    /**
     * Start recording
     * @param options optional: VAD auto-stop configuration
     */
    async start(options?: RecordingOptions): Promise<void> {
        if (this.state !== 'idle') {
            console.warn('[Voice] 已在录音中');
            return;
        }

        try {
            // Request microphone permission
            this.stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    sampleRate: 16000,
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                },
            });

            // Create the MediaRecorder (using a WAV-compatible format)
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

            this.mediaRecorder.start(100); // emit a data chunk every 100ms
            this.startTime = Date.now();
            this.setState('recording');

            // Continuously update the recording duration
            this.durationTimer = window.setInterval(() => {
                const duration = Math.floor((Date.now() - this.startTime) / 1000);
                this.onStateChange?.('recording', duration);
            }, 500);

            // Enable VAD auto-stop
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
     * Stop recording and return the audio data
     * @returns an ArrayBuffer in WAV format
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
                    // Convert WebM/Opus to WAV (16kHz mono 16-bit PCM)
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
     * Cancel recording
     */
    cancel(): void {
        this.stopVAD();
        if (this.mediaRecorder && this.state === 'recording') {
            this.mediaRecorder.stop();
        }
        this.cleanup();
    }

    // ========================
    // VAD (Voice Activity Detection)
    // ========================

    /**
     * Initialize VAD monitoring
     * Use AnalyserNode to analyze the audio spectrum in real time and detect silent segments
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

                // Compute the average spectral energy
                let sum = 0;
                for (let i = 0; i < bufferLength; i++) {
                    sum += dataArray[i];
                }
                const average = sum / bufferLength;
                const elapsed = Date.now() - this.startTime;

                if (average > silenceThreshold) {
                    // Sound detected
                    hadVoice = true;
                    this.vadSilenceStart = 0;
                } else if (hadVoice && elapsed > minDuration) {
                    // Silent segment after the user has spoken
                    if (this.vadSilenceStart === 0) {
                        this.vadSilenceStart = Date.now();
                    } else if (Date.now() - this.vadSilenceStart > silenceDuration) {
                        // Silence exceeds the threshold → auto-stop
                        console.log(`[VAD] 静音 ${silenceDuration}ms，自动停止录音`);
                        this.onAutoStop?.();
                        return; // stop the detection loop
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

    /** Stop VAD monitoring */
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
     * Convert an audio Blob to WAV format (16kHz, mono, 16-bit PCM)
     */
    private async convertToWav(blob: Blob): Promise<ArrayBuffer> {
        // Decode the audio with AudioContext
        const audioContext = new AudioContext({ sampleRate: 16000 });

        try {
            const arrayBuffer = await blob.arrayBuffer();
            const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

            // Get the mono channel data
            const channelData = audioBuffer.getChannelData(0);

            // Resample if the sample rate is not 16000
            let samples: Float32Array;
            if (audioBuffer.sampleRate !== 16000) {
                samples = this.resample(channelData, audioBuffer.sampleRate, 16000);
            } else {
                samples = channelData;
            }

            // Encode to WAV
            return this.encodeWav(samples, 16000);
        } finally {
            await audioContext.close();
        }
    }

    /**
     * Simple linear resampling
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
     * Encode Float32Array PCM data into a WAV Buffer
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

        // PCM data (Float32 -> Int16)
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
// Audio playback management
// ========================

/** Playback state */
export type PlaybackState = 'idle' | 'loading' | 'playing' | 'paused';

/** Playback state change callback */
export type PlaybackStateCallback = (state: PlaybackState, messageId?: string) => void;

/** Audio playback manager */
class AudioPlayer {
    private currentAudio: HTMLAudioElement | null = null;
    private currentMessageId: string | null = null;
    private onStateChange: PlaybackStateCallback | null = null;

    /**
     * Register a state change callback
     */
    setStateCallback(callback: PlaybackStateCallback): void {
        this.onStateChange = callback;
    }

    /**
     * Get the message ID currently playing
     */
    getCurrentMessageId(): string | null {
        return this.currentMessageId;
    }

    /**
     * Play audio
     * @param audioBuffer MP3 audio data
     * @param messageId the associated message ID
     */
    async play(audioBuffer: ArrayBuffer, messageId: string): Promise<void> {
        // Stop current playback
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
     * Pause / resume playback
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
     * Stop playback
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
     * Whether currently playing
     */
    isPlaying(): boolean {
        return this.currentAudio !== null && !this.currentAudio.paused;
    }
}

// ========================
// TTS playback management (manual click of the read-aloud button)
// ========================

/** TTS request */
interface TTSRequest {
    text: string;
    messageId: string;
}

/** TTS manager (manually play a whole message) */
class TTSManager {
    private queue: TTSRequest[] = [];
    private processing = false;
    private player: AudioPlayer;
    private abortController: AbortController | null = null;
    private generation = 0;
    private activeRequestMessageId: string | null = null;

    constructor(player: AudioPlayer) {
        this.player = player;
    }

    /**
     * Request TTS. Manual read-aloud is exclusive: clicking another message
     * immediately replaces the current/queued request.
     */
    async speak(text: string, messageId: string): Promise<void> {
        // Stop streaming TTS (mutually exclusive)
        streamingTtsManager.cancel();

        const activeMessageId = this.player.getCurrentMessageId() || this.activeRequestMessageId;
        const hasDifferentQueuedRequest = this.queue.some(r => r.messageId !== messageId);
        if ((activeMessageId && activeMessageId !== messageId) || hasDifferentQueuedRequest) {
            this.resetCurrentRun();
        }

        // Ignore if the same message is already being processed
        if (
            this.player.getCurrentMessageId() === messageId ||
            this.activeRequestMessageId === messageId ||
            this.queue.some(r => r.messageId === messageId)
        ) {
            return;
        }

        this.queue.push({ text, messageId });

        if (!this.processing) {
            await this.processQueue(this.generation);
        }
    }

    /**
     * Cancel all pending TTS
     */
    cancelAll(): void {
        this.generation++;
        this.queue = [];
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        this.activeRequestMessageId = null;
        this.player.stop();
        this.processing = false;
    }

    /**
     * Cancel TTS for a specific message
     */
    cancel(messageId: string): void {
        this.queue = this.queue.filter(r => r.messageId !== messageId);
        if (this.player.getCurrentMessageId() === messageId || this.activeRequestMessageId === messageId) {
            this.generation++;
            if (this.abortController) {
                this.abortController.abort();
                this.abortController = null;
            }
            this.activeRequestMessageId = null;
            this.player.stop();
            this.processing = false;
        }
    }

    private resetCurrentRun(): void {
        this.generation++;
        this.queue = [];
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        this.activeRequestMessageId = null;
        this.player.stop();
        this.processing = false;
    }

    private async processQueue(runGeneration: number): Promise<void> {
        if (this.processing || this.queue.length === 0) return;
        this.processing = true;

        try {
            while (this.queue.length > 0 && runGeneration === this.generation) {
                const request = this.queue.shift()!;
                this.activeRequestMessageId = request.messageId;
                this.abortController = new AbortController();

                try {
                    const result = await voiceSynthesizeCallback(request.text);
                    if (runGeneration !== this.generation) break;

                    if (result.error) {
                        console.error('[TTS] 合成失败:', result.error);
                        continue;
                    }
                    if (result.audio) {
                        await this.player.play(result.audio, request.messageId);
                        if (runGeneration !== this.generation) break;
                        // Wait for playback to finish
                        await this.waitForPlaybackEnd(request.messageId, runGeneration);
                    }
                } catch (error) {
                    if ((error as Error).name === 'AbortError' || runGeneration !== this.generation) break;
                    console.error('[TTS] 队列处理错误:', error);
                } finally {
                    if (runGeneration === this.generation && this.activeRequestMessageId === request.messageId) {
                        this.activeRequestMessageId = null;
                    }
                }
            }
        } finally {
            if (runGeneration === this.generation) {
                this.processing = false;
                this.abortController = null;
                this.activeRequestMessageId = null;
            }
        }
    }

    private waitForPlaybackEnd(messageId: string, runGeneration: number): Promise<void> {
        return new Promise<void>((resolve) => {
            const check = () => {
                if (runGeneration !== this.generation || this.player.getCurrentMessageId() !== messageId) {
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
// Streaming TTS management (synthesize the LLM stream sentence by sentence + pipelined playback)
// ========================

/** Streaming TTS state */
export type StreamingTTSState = 'idle' | 'buffering' | 'synthesizing' | 'playing' | 'paused';

/** Streaming TTS state callback */
export type StreamingTTSStateCallback = (state: StreamingTTSState, messageId?: string) => void;

/**
 * Streaming TTS manager
 *
 * How it works:
 *   LLM token → feedToken() → sentence splitting → per-sentence synthesis (IPC) → pipelined playback
 *   Synthesizing sentence N+1 runs in parallel with playing sentence N, greatly reducing first-utterance latency
 */
class StreamingTTSManager {
    private pendingText = '';               // raw text pending splitting
    private sentenceQueue: string[] = [];   // queue of sentences pending synthesis
    private audioQueue: ArrayBuffer[] = []; // queue of audio pending playback
    private isSynthesizing = false;
    private isPlaying = false;
    private cancelled = true;               // initially cancelled
    private messageId = '';
    private currentAudio: HTMLAudioElement | null = null;
    private pausedByUser = false;
    private onStateChange: StreamingTTSStateCallback | null = null;

    /** Minimum sentence length (in characters), to avoid fragmented synthesis */
    private readonly MIN_SENTENCE_LEN = 6;
    /** Buffer limit (in characters); force a split once exceeded */
    private readonly MAX_BUFFER_LEN = 150;

    setStateCallback(cb: StreamingTTSStateCallback | null): void {
        this.onStateChange = cb;
    }

    private emitState(state: StreamingTTSState): void {
        const visibleState = this.pausedByUser && state !== 'idle'
            ? 'paused'
            : this.isPlaying && state !== 'idle'
                ? 'playing'
                : state;
        this.onStateChange?.(visibleState, this.messageId || undefined);
    }

    /**
     * Start streaming TTS (called when a new message begins streaming)
     */
    startStreaming(messageId: string): void {
        this.cancel();
        this.messageId = messageId;
        this.cancelled = false;
        this.pausedByUser = false;
        this.pendingText = '';
        this.emitState('buffering');

        // Mutually exclusive: stop manual playback
        player.stop();
        ttsManager.cancelAll();
    }

    /**
     * Feed in an LLM streaming token
     */
    feedToken(token: string): void {
        if (this.cancelled) return;
        this.pendingText += token;
        this.extractAndEnqueue();
    }

    /**
     * Streaming output ended; flush the remaining text
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
     * Cancel all synthesis and playback
     */
    cancel(): void {
        if (this.cancelled) return;
        this.cancelled = true;
        this.pendingText = '';
        this.sentenceQueue = [];
        this.audioQueue = [];
        this.isSynthesizing = false;
        this.isPlaying = false;
        this.pausedByUser = false;
        if (this.currentAudio) {
            this.currentAudio.pause();
            this.currentAudio.src = '';
            this.currentAudio = null;
        }
        this.emitState('idle');
    }

    /**
     * Get the message ID controlled by the current streaming TTS session
     */
    getCurrentMessageId(): string | null {
        return this.messageId || null;
    }

    /**
     * Pause or resume the current streaming playback.
     * Returns false when there is no audio element yet (e.g. still synthesizing).
     */
    togglePause(): boolean {
        if (this.cancelled || !this.currentAudio) return false;

        if (this.currentAudio.paused) {
            this.pausedByUser = false;
            this.currentAudio.play()
                .then(() => this.emitState('playing'))
                .catch((error) => {
                    console.error('[StreamingTTS] 恢复播放失败:', error);
                    this.cancel();
                });
        } else {
            this.currentAudio.pause();
            this.pausedByUser = true;
            this.emitState('paused');
        }

        return true;
    }

    /**
     * Whether there are unfinished tasks
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

    // ---- Internal methods ----

    /** Extract complete sentences from the buffer */
    private extractAndEnqueue(): void {
        while (true) {
            let splitIdx = -1;

            // Chinese sentence-ending punctuation (period/exclamation/question/semicolon and newline)
            const cnIdx = this.pendingText.search(/[。！？；\n]/);
            if (cnIdx !== -1) {
                splitIdx = cnIdx + 1;
            }

            // English sentence-ending punctuation (. ! ? followed by a space)
            if (splitIdx === -1) {
                const enMatch = /[.!?]\s/.exec(this.pendingText);
                if (enMatch) {
                    splitIdx = enMatch.index + enMatch[0].length;
                }
            }

            // Buffer too long; force a split at a comma or space
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
                // Too short; put it back into the buffer
                this.pendingText = sentence + this.pendingText;
                break;
            }
        }

        this.kickSynthesis();
    }

    /** Start the synthesis loop (if not already running) */
    private kickSynthesis(): void {
        if (!this.isSynthesizing && this.sentenceQueue.length > 0 && !this.cancelled) {
            this.synthesizeLoop();
        }
    }

    /** Synthesis loop: take sentences one by one, synthesize audio, push to the audio queue */
    private async synthesizeLoop(): Promise<void> {
        this.isSynthesizing = true;

        while (this.sentenceQueue.length > 0 && !this.cancelled) {
            const sentence = this.sentenceQueue.shift()!;
            this.emitState('synthesizing');
            console.log(`[StreamingTTS] 合成: "${sentence.slice(0, 40)}${sentence.length > 40 ? '...' : ''}"`);

            try {
                const result = await voiceSynthesizeCallback(sentence);
                if (this.cancelled) break;

                if (result.audio) {
                    this.audioQueue.push(result.audio);
                    // If the playback loop is not running, start it
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

    /** Playback loop: take audio from the queue one by one and play it */
    private async playLoop(): Promise<void> {
        this.isPlaying = true;

        while (this.audioQueue.length > 0 && !this.cancelled) {
            const audioData = this.audioQueue.shift()!;
            this.emitState('playing');

            try {
                await this.playAudioBuffer(audioData);
            } catch (error) {
                console.error('[StreamingTTS] 播放异常:', error);
            }
        }

        this.isPlaying = false;
        this.checkDone();
    }

    /** Check whether everything is finished */
    private checkDone(): void {
        if (
            !this.cancelled &&
            !this.isSynthesizing &&
            !this.isPlaying &&
            this.sentenceQueue.length === 0 &&
            this.audioQueue.length === 0
        ) {
            this.emitState('idle');
        }
    }

    /** Play a single audio Buffer (returns a Promise that resolves when playback ends) */
    private playAudioBuffer(buffer: ArrayBuffer): Promise<void> {
        return new Promise((resolve) => {
            if (this.cancelled) { resolve(); return; }

            const blob = new Blob([buffer], { type: 'audio/mpeg' });
            const url = URL.createObjectURL(blob);
            this.currentAudio = new Audio(url);

            const cleanup = () => {
                URL.revokeObjectURL(url);
                this.pausedByUser = false;
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
// Ambient sound (background sound while thinking)
// ========================

/**
 * Procedurally generated meditation-style ambient sound
 *
 * Principle: use the Web Audio API to synthesize several low-frequency sine waves + slow LFO modulation,
 * producing an ethereal, breathing background atmosphere.
 */
class AmbientSound {
    private ctx: AudioContext | null = null;
    private masterGain: GainNode | null = null;
    private oscillators: OscillatorNode[] = [];
    private lfoGains: GainNode[] = [];
    private isPlaying = false;
    private fadeTimer: number | null = null;

    /** Volume (0-1) */
    private volume = 0.08;

    /**
     * Start playing the ambient sound (fade in)
     */
    start(): void {
        if (this.isPlaying) return;

        try {
            this.ctx = new AudioContext();
            this.masterGain = this.ctx.createGain();
            this.masterGain.gain.value = 0; // fade in from 0
            this.masterGain.connect(this.ctx.destination);

            // Define the chord layers
            // Bass layer: slow breathing (LFO < 0.1Hz) provides a stable foundation
            // Treble layer: fast shimmer (LFO 0.8-1.5Hz) creates an ethereal glow
            const layers = [
                { freq: 130.8, lfoRate: 0.05, lfoDepth: 0.3, gain: 0.30 },  // low C3 (slow breathing)
                { freq: 174, lfoRate: 0.08, lfoDepth: 0.3, gain: 0.25 },  // F3 (slow swell)
                { freq: 220, lfoRate: 0.8, lfoDepth: 0.7, gain: 0.10 },  // A3 — fast shimmer
                { freq: 261.6, lfoRate: 1.2, lfoDepth: 0.8, gain: 0.06 },  // C4 — faster shimmer
                { freq: 329.6, lfoRate: 1.5, lfoDepth: 0.9, gain: 0.03 },  // E4 — fastest glimmer
                { freq: 293.7, lfoRate: 0.9, lfoDepth: 0.75, gain: 0.04 },  // D4 — interleaved rhythm
            ];

            for (const layer of layers) {
                // Source oscillator
                const osc = this.ctx.createOscillator();
                osc.type = 'sine';
                osc.frequency.value = layer.freq;

                // Layer volume
                const layerGain = this.ctx.createGain();
                layerGain.gain.value = layer.gain;

                // LFO: slowly modulate the volume to create a breathing feel
                const lfo = this.ctx.createOscillator();
                lfo.type = 'sine';
                lfo.frequency.value = layer.lfoRate;

                const lfoGain = this.ctx.createGain();
                lfoGain.gain.value = layer.lfoDepth * layer.gain;

                // LFO → layerGain.gain (modulate volume)
                lfo.connect(lfoGain);
                lfoGain.connect(layerGain.gain);

                // Source → layerGain → masterGain
                osc.connect(layerGain);
                layerGain.connect(this.masterGain);

                osc.start();
                lfo.start();

                this.oscillators.push(osc, lfo);
                this.lfoGains.push(lfoGain);
            }

            // Fade in (2 seconds)
            this.masterGain.gain.setValueAtTime(0, this.ctx.currentTime);
            this.masterGain.gain.linearRampToValueAtTime(this.volume, this.ctx.currentTime + 2);

            this.isPlaying = true;
        } catch (error) {
            console.warn('[Ambient] 启动失败:', error);
            this.cleanup();
        }
    }

    /**
     * Stop playing the ambient sound (fade out)
     */
    stop(): void {
        if (!this.isPlaying || !this.ctx || !this.masterGain) return;

        try {
            // Fade out (1.5 seconds)
            const now = this.ctx.currentTime;
            this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
            this.masterGain.gain.linearRampToValueAtTime(0, now + 1.5);

            // Clean up after the fade-out ends
            this.fadeTimer = window.setTimeout(() => {
                this.cleanup();
            }, 1600);
        } catch {
            this.cleanup();
        }
    }

    /**
     * Stop immediately (no fade-out)
     */
    stopImmediate(): void {
        this.cleanup();
    }

    /**
     * Whether currently playing
     */
    getIsPlaying(): boolean {
        return this.isPlaying;
    }

    /**
     * Set the volume (0-1)
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
            try { osc.stop(); } catch { /* ignore */ }
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
// Voice barge-in detection
// ========================

/**
 * Voice barge-in detection
 *
 * Monitors the microphone in the background during TTS playback to detect whether the user starts speaking.
 *
 * Strategy: adaptive baseline + two-stage verification
 *   1. Calibration period (500ms): collect the ambient noise baseline (including TTS echo)
 *   2. Stage one (candidate): volume exceeds baseline×factor for 150ms → enter verification
 *   3. Stage two (verification): after waiting 120ms, check again whether the volume still exceeds the threshold
 *      - Still exceeds → treat as speech, trigger a barge-in
 *      - Already decayed → treat as a cough/noise, reset
 *
 * This way a cough (~200ms burst then rapid decay) does not falsely trigger,
 * while speech (sustained sound) is reliably detected within ~270ms.
 */
class BargeInDetector {
    private stream: MediaStream | null = null;
    private ctx: AudioContext | null = null;
    private analyser: AnalyserNode | null = null;
    private rafId: number | null = null;
    private active = false;
    private onBargeIn: (() => void) | null = null;

    // Adaptive parameters
    private baseline = 0;
    private readonly multiplier = 2.5;
    private readonly minThreshold = 10;
    private readonly calibrateMs = 500;

    // Two-stage detection parameters
    private readonly stage1Ms = 150;      // stage one: initial duration requirement
    private readonly stage2DelayMs = 120;  // stage two: verification wait time
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

                // ---- Calibration phase ----
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

                // ---- Stage one: listening ----
                if (this.stage === 'listen') {
                    if (avg > threshold) {
                        if (this.voiceStart === 0) {
                            this.voiceStart = Date.now();
                        } else if (Date.now() - this.voiceStart > this.stage1Ms) {
                            // Sustained over the threshold → enter candidate
                            this.stage = 'candidate';
                            this.voiceStart = 0;
                        }
                    } else {
                        this.voiceStart = 0;
                        // Slowly update the baseline while quiet
                        this.baseline = this.baseline * 0.98 + avg * 0.02;
                    }
                }

                // ---- Stage two first half: candidate (wait a bit before verifying) ----
                if (this.stage === 'candidate') {
                    // Enter the verification wait
                    this.stage = 'verify';
                    this.verifyStart = Date.now();
                }

                // ---- Stage two second half: verification ----
                if (this.stage === 'verify') {
                    if (Date.now() - this.verifyStart >= this.stage2DelayMs) {
                        // At verification time: is the volume still above the threshold?
                        if (avg > threshold) {
                            console.log(`[BargeIn] 触发打断 (音量=${avg.toFixed(1)}, 阈值=${threshold.toFixed(1)}, 基线=${this.baseline.toFixed(1)})`);
                            this.stop();
                            this.onBargeIn?.();
                            return;
                        } else {
                            // Already decayed → it's a cough/noise, reset
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
// Export the singleton
// ========================

export const recorder = new AudioRecorder();
export const player = new AudioPlayer();
export const ttsManager = new TTSManager(player);
export const streamingTtsManager = new StreamingTTSManager();
export const ambientSound = new AmbientSound();
export const bargeInDetector = new BargeInDetector();
