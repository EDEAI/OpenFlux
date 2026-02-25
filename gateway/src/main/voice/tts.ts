/**
 * Edge TTS 语音合成服务
 * 使用 msedge-tts 将文字转为语音
 */
import { join } from 'path';
import { tmpdir } from 'os';
import { readFile, rm, mkdir } from 'fs/promises';
import { randomUUID } from 'crypto';

/** TTS 服务配置 */
export interface TTSConfig {
    /** 是否启用 */
    enabled: boolean;
    /** 语音角色名称 */
    voice?: string;
    /** 语速调节，如 "+0%", "+20%", "-10%" */
    rate?: string;
    /** 音量调节，如 "+0%", "+50%", "-20%" */
    volume?: string;
    /** 是否自动播放助手回复 */
    autoPlay?: boolean;
}

/** 语音信息 */
export interface VoiceInfo {
    name: string;
    locale: string;
    gender: string;
    shortName: string;
}

/**
 * TTS 语音合成服务
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
     * 初始化 TTS 服务
     */
    async initialize(): Promise<void> {
        if (!this.config.enabled) {
            console.log('[TTS] 语音合成已禁用');
            return;
        }

        try {
            const module = await import('msedge-tts');
            this.MsEdgeTTS = module.MsEdgeTTS;
            this.OUTPUT_FORMAT = module.OUTPUT_FORMAT;

            // 不预创建实例，每次合成时新建（避免 WebSocket 连接复用问题）
            this.initialized = true;
            console.log('[TTS] 语音合成初始化完成，语音:', this.config.voice || 'zh-CN-XiaoxiaoNeural');
        } catch (error) {
            console.error('[TTS] 初始化失败:', error);
            throw error;
        }
    }

    /**
     * 将文本合成为音频 Buffer（MP3 格式）
     * @param text 要合成的文本
     * @returns MP3 音频 Buffer
     */
    async synthesize(text: string): Promise<Buffer> {
        if (!this.initialized) {
            throw new Error('TTS 服务未初始化');
        }

        if (!text.trim()) {
            throw new Error('合成文本不能为空');
        }

        // 清理 Markdown 格式，只保留纯文本
        const cleanText = this.stripMarkdown(text);
        if (!cleanText.trim()) {
            throw new Error('清理后的文本为空');
        }

        // 截断过长文本
        const maxLen = 3000;
        const finalText = cleanText.length > maxLen
            ? cleanText.slice(0, maxLen) + '……'
            : cleanText;

        console.log(`[TTS] 开始合成 (${finalText.length} 字符)...`);
        const start = Date.now();

        // toFile() 将路径当作目录，在里面生成 audio.mp3
        const tmpDir = join(tmpdir(), `openflux-tts-${randomUUID()}`);
        const outputFile = join(tmpDir, 'audio.mp3');

        try {
            await mkdir(tmpDir, { recursive: true });

            const ttsInstance = new this.MsEdgeTTS();
            await ttsInstance.setMetadata(
                this.config.voice || 'zh-CN-XiaoxiaoNeural',
                this.OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3,
            );

            // 用 Promise.race 加超时保护
            await Promise.race([
                ttsInstance.toFile(tmpDir, finalText),
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('TTS 合成超时 (30s)')), 30000)
                ),
            ]);

            const audioBuffer = await readFile(outputFile);
            const elapsed = Date.now() - start;
            console.log(`[TTS] 合成完成 (${elapsed}ms, ${(audioBuffer.length / 1024).toFixed(1)}KB)`);
            return audioBuffer;
        } catch (error) {
            console.error('[TTS] 合成失败:', error);
            throw error;
        } finally {
            // 清理临时目录
            rm(tmpDir, { recursive: true, force: true }).catch(() => { /* 忽略 */ });
        }
    }

    /**
     * 切换语音角色
     */
    async setVoice(voiceName: string): Promise<void> {
        if (!this.initialized) {
            throw new Error('TTS 服务未初始化');
        }

        this.config.voice = voiceName;
        console.log('[TTS] 语音已切换:', voiceName);
    }

    /**
     * 获取可用语音列表
     */
    async getVoices(): Promise<VoiceInfo[]> {
        if (this.voicesCache) return this.voicesCache;

        try {
            if (!this.MsEdgeTTS) {
                const module = await import('msedge-tts');
                this.MsEdgeTTS = module.MsEdgeTTS;
            }
            const voices = await this.MsEdgeTTS.getVoices();

            // 筛选中英文语音，格式化返回
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
            console.error('[TTS] 获取语音列表失败:', error);
            return [];
        }
    }

    /**
     * 检查服务是否可用
     */
    isAvailable(): boolean {
        return this.initialized;
    }

    /**
     * 获取当前配置
     */
    getConfig(): TTSConfig {
        return { ...this.config };
    }

    /**
     * 释放资源
     */
    destroy(): void {
        this.initialized = false;
    }

    // ========================
    // 私有方法
    // ========================

    /**
     * 清理 Markdown 格式为纯文本，去除不应朗读的内容
     */
    private stripMarkdown(text: string): string {
        return text
            // 移除代码块（含语言标注）
            .replace(/```[\s\S]*?```/g, '')
            // 移除行内代码
            .replace(/`[^`]+`/g, '')
            // 移除标题标记
            .replace(/^#{1,6}\s+/gm, '')
            // 移除加粗/斜体标记，保留文字
            .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
            .replace(/_{1,3}([^_]+)_{1,3}/g, '$1')
            .replace(/~~([^~]+)~~/g, '$1')
            // 移除链接，保留文字
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            // 移除纯 URL
            .replace(/https?:\/\/\S+/g, '')
            // 移除图片
            .replace(/!\[([^\]]*)\]\([^)]+\)/g, '')
            // 移除 HTML 标签
            .replace(/<[^>]+>/g, '')
            // 移除列表标记
            .replace(/^[\s]*[-*+]\s+/gm, '')
            .replace(/^[\s]*\d+\.\s+/gm, '')
            // 移除引用标记
            .replace(/^>\s+/gm, '')
            // 移除分割线
            .replace(/^[-*_]{3,}$/gm, '')
            // 移除表格分隔行（如 |---|---|）
            .replace(/^\|[-:\s|]+\|$/gm, '')
            // 移除表格管道符，保留内容
            .replace(/\|/g, '，')
            // 移除 Emoji 表情符号
            .replace(/[\u{1F600}-\u{1F64F}]/gu, '')   // 表情
            .replace(/[\u{1F300}-\u{1F5FF}]/gu, '')   // 杂项符号
            .replace(/[\u{1F680}-\u{1F6FF}]/gu, '')   // 交通和地图
            .replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '')   // 旗帜
            .replace(/[\u{2600}-\u{26FF}]/gu, '')     // 杂项符号
            .replace(/[\u{2700}-\u{27BF}]/gu, '')     // 装饰符号
            .replace(/[\u{FE00}-\u{FE0F}]/gu, '')     // 变体选择符
            .replace(/[\u{1F900}-\u{1F9FF}]/gu, '')   // 补充符号
            .replace(/[\u{1FA00}-\u{1FA6F}]/gu, '')   // 扩展A符号
            .replace(/[\u{1FA70}-\u{1FAFF}]/gu, '')   // 扩展B符号
            .replace(/[\u{200D}]/gu, '')              // 零宽连接符
            .replace(/[\u{20E3}]/gu, '')              // 组合封闭键帽
            // 移除常见装饰性符号
            .replace(/[★☆●○◆◇■□▲△▼▽►◄→←↑↓↔↕⇒⇐⇑⇓✓✗✔✘✚✛✜✝✞✟❀❁❂❃❄❅❆❇❈❉❊❋]/g, '')
            // 移除 Markdown 特殊字符残留
            .replace(/[~^`]/g, '')
            // 压缩连续标点
            .replace(/[，。！？、；：]{2,}/g, (m) => m[0])
            // 压缩连续空格和换行
            .replace(/[ \t]+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }
}
