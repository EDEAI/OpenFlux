/**
 * Edge TTS speech synthesis service
 * Convert text to speech using msedge-tts
 */
import { join } from 'path';
import { tmpdir } from 'os';
import { readFile, rm, mkdir } from 'fs/promises';
import { randomUUID } from 'crypto';

/** TTS service configuration */
export interface TTSConfig {
    /** Whether to enable */
    enabled: boolean;
    /** Voice character name */
    voice?: string;
    /** Speech speed adjustment, such as "+0%", "+20%", "-10%" */
    rate?: string;
    /** Volume adjustment, such as "+0%", "+50%", "-20%" */
    volume?: string;
    /** Whether to automatically play assistant replies */
    autoPlay?: boolean;
}

/** Voice message */
export interface VoiceInfo {
    name: string;
    locale: string;
    gender: string;
    shortName: string;
}

/**
 * TTS speech synthesis service
 */
export class TTSService {
    private config: TTSConfig;
    private initialized = false;
    private MsEdgeTTS: any = null;
    private OUTPUT_FORMAT: any = null;
    private voicesCache: VoiceInfo[] | null = null;

    constructor(config: TTSConfig) {
        this.config = config;
    }

    /**
     * Initialize TTS service
     */
    async initialize(): Promise<void> {
        if (!this.config.enabled) {
            console.log('[TTS] Voice synthesis disabled');
            return;
        }

        try {
            const module = await import('msedge-tts');
            this.MsEdgeTTS = module.MsEdgeTTS;
            this.OUTPUT_FORMAT = module.OUTPUT_FORMAT;

            // No pre-created instances, new ones are created each time they are synthesized (to avoid WebSocket connection reuse issues)
            this.initialized = true;
            console.log('[TTS] Voice synthesis initialized, voice:', this.config.voice || 'zh-CN-XiaoxiaoNeural');
        } catch (error) {
            console.error('[TTS] Initialization failed:', error);
            throw error;
        }
    }

    /**
     * Synthesize text into audio Buffer (MP3 format)
     * @param text Text to synthesize
     * @returns MP3 Audio Buffer
     */
    async synthesize(text: string): Promise<Buffer> {
        if (!this.initialized) {
            throw new Error('TTS service not initialized');
        }

        if (!text.trim()) {
            throw new Error('Synthesis text cannot be empty');
        }

        // Clean Markdown format, keep only plain text
        const cleanText = this.stripMarkdown(text);
        if (!cleanText.trim()) {
            throw new Error('Text is empty after cleanup');
        }

        // Truncate text that is too long
        const maxLen = 3000;
        const finalText = cleanText.length > maxLen
            ? cleanText.slice(0, maxLen) + '……'
            : cleanText;

        console.log(`[TTS] Starting synthesis (${finalText.length} chars)...`);
        const start = Date.now();

        // toFile() treats the path as a directory and generates audio.mp3 in it
        const tmpDir = join(tmpdir(), `openflux-tts-${randomUUID()}`);
        const outputFile = join(tmpDir, 'audio.mp3');

        try {
            await mkdir(tmpDir, { recursive: true });

            const ttsInstance = new this.MsEdgeTTS();
            await ttsInstance.setMetadata(
                this.config.voice || 'zh-CN-XiaoxiaoNeural',
                this.OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3,
            );

            // Use Promise.race to add timeout protection
            await Promise.race([
                ttsInstance.toFile(tmpDir, finalText),
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('TTS 合成超时 (30s)')), 30000)
                ),
            ]);

            const audioBuffer = await readFile(outputFile);
            const elapsed = Date.now() - start;
            console.log(`[TTS] Synthesis complete (${elapsed}ms, ${(audioBuffer.length / 1024).toFixed(1)}KB)`);
            return audioBuffer;
        } catch (error) {
            console.error('[TTS] Synthesis failed:', error);
            throw error;
        } finally {
            // Clean up temporary directory
            rm(tmpDir, { recursive: true, force: true }).catch(() => { /* neglect */ });
        }
    }

    /**
     * Switch voice roles
     */
    async setVoice(voiceName: string): Promise<void> {
        if (!this.initialized) {
            throw new Error('TTS service not initialized');
        }

        this.config.voice = voiceName;
        console.log('[TTS] Voice switched:', voiceName);
    }

    /**
     * Get a list of available voices
     */
    async getVoices(): Promise<VoiceInfo[]> {
        if (this.voicesCache) return this.voicesCache;

        try {
            if (!this.MsEdgeTTS) {
                const module = await import('msedge-tts');
                this.MsEdgeTTS = module.MsEdgeTTS;
            }
            const voices = await this.MsEdgeTTS.getVoices();

            // Filter Chinese and English voices and format the returns
            this.voicesCache = voices
                .filter((v: any) => v.Locale?.startsWith('zh-') || v.Locale?.startsWith('en-'))
                .map((v: any) => ({
                    name: v.FriendlyName || v.Name,
                    locale: v.Locale,
                    gender: v.Gender,
                    shortName: v.ShortName,
                }));

            return this.voicesCache;
        } catch (error) {
            console.error('[TTS] Failed to get voice list:', error);
            return [];
        }
    }

    /**
     * Check if the service is available
     */
    isAvailable(): boolean {
        return this.initialized;
    }

    /**
     * Get current configuration
     */
    getConfig(): TTSConfig {
        return { ...this.config };
    }

    /**
     * Release resources
     */
    destroy(): void {
        this.initialized = false;
    }

    // ========================
    // private method
    // ========================

    /**
     * Clean the Markdown format to plain text and remove content that should not be read aloud
     */
    private stripMarkdown(text: string): string {
        return text
            // Remove code block (with language annotation)
            .replace(/```[\s\S]*?```/g, '')
            // Remove inline code
            .replace(/`[^`]+`/g, '')
            // Remove title tag
            .replace(/^#{1,6}\s+/gm, '')
            // Remove bold/italic markup, keep text
            .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
            .replace(/_{1,3}([^_]+)_{1,3}/g, '$1')
            .replace(/~~([^~]+)~~/g, '$1')
            // Remove link, keep text
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            // Remove plain URL
            .replace(/https?:\/\/\S+/g, '')
            // Remove image
            .replace(/!\[([^\]]*)\]\([^)]+\)/g, '')
            // Remove HTML tag
            .replace(/<[^>]+>/g, '')
            // Remove list mark
            .replace(/^[\s]*[-*+]\s+/gm, '')
            .replace(/^[\s]*\d+\.\s+/gm, '')
            // Remove reference mark
            .replace(/^>\s+/gm, '')
            // Remove dividing line
            .replace(/^[-*_]{3,}$/gm, '')
            // Remove table separator rows (e.g. |---|---|)
            .replace(/^\|[-:\s|]+\|$/gm, '')
            // Remove table pipe character, keep content
            .replace(/\|/g, '，')
            // Remove Emoji
            .replace(/[\u{1F600}-\u{1F64F}]/gu, '')   // expression
            .replace(/[\u{1F300}-\u{1F5FF}]/gu, '')   // Miscellaneous symbols
            .replace(/[\u{1F680}-\u{1F6FF}]/gu, '')   // Transportation and maps
            .replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '')   // banner
            .replace(/[\u{2600}-\u{26FF}]/gu, '')     // Miscellaneous symbols
            .replace(/[\u{2700}-\u{27BF}]/gu, '')     // decorative symbols
            .replace(/[\u{FE00}-\u{FE0F}]/gu, '')     // variant selector
            .replace(/[\u{1F900}-\u{1F9FF}]/gu, '')   // Supplementary symbols
            .replace(/[\u{1FA00}-\u{1FA6F}]/gu, '')   // Extended A notation
            .replace(/[\u{1FA70}-\u{1FAFF}]/gu, '')   // Extended B notation
            .replace(/[\u{200D}]/gu, '')              // zero-width connector
            .replace(/[\u{20E3}]/gu, '')              // Combination closed keycaps
            // Remove common decorative symbols
            .replace(/[★☆●○◆◇■□▲△▼▽►◄→←↑↓↔↕⇒⇐⇑⇓✓✗✔✘✚✛✜✝✞✟❀❁❂❃❄❅❆❇❈❉❊❋]/g, '')
            // Remove Markdown special character residue
            .replace(/[~^`]/g, '')
            // Compress continuous punctuation
            .replace(/[，。！？、；：]{2,}/g, (m) => m[0])
            // Compress consecutive spaces and newlines
            .replace(/[ \t]+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }
}
