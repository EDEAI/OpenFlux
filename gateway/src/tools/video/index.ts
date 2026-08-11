/** Local short-video composition tool (generate_video). */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import sharp from 'sharp';
import type { Tool, ToolExecutionContext, ToolResult } from '../types';
import { readNumberParam, readStringParam } from '../common';
import { getEnvProbe } from '../../utils/env-probe';
import { Logger } from '../../utils/logger';

const log = new Logger('VideoGen');
const DEFAULT_DURATION_SECONDS = 6;
const MAX_DURATION_SECONDS = 60;
const DEFAULT_FPS = 30;

export type VideoAspectRatio = '9:16' | '16:9' | '1:1';
export type VideoResolution = '720p' | '1080p';
export type VideoGenerationMode = 'auto' | 'compose' | 'provider';

export interface VideoProcessOptions {
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
}

export interface VideoGenToolOptions {
    /** Base directory for generated deliverables. */
    getOutputPath?: () => string;
    /** Override executable discovery (primarily for packaged builds and tests). */
    getFfmpegPath?: () => string | undefined;
    /** Injectable process runner for deterministic tests. */
    runFfmpeg?: (executable: string, args: string[], options: VideoProcessOptions) => Promise<void>;
}

export interface VideoDimensions {
    width: number;
    height: number;
}

export function resolveVideoDimensions(
    aspectRatio: VideoAspectRatio,
    resolution: VideoResolution,
): VideoDimensions {
    const longEdge = resolution === '1080p' ? 1920 : 1280;
    const shortEdge = resolution === '1080p' ? 1080 : 720;
    if (aspectRatio === '9:16') return { width: shortEdge, height: longEdge };
    if (aspectRatio === '16:9') return { width: longEdge, height: shortEdge };
    return { width: shortEdge, height: shortEdge };
}

function isWithin(basePath: string, targetPath: string): boolean {
    const rel = relative(resolve(basePath), resolve(targetPath));
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function sanitizeFilename(value?: string): string {
    const fallback = `video_${new Date().toISOString().replace(/[:.]/g, '-')}.mp4`;
    if (!value) return fallback;
    const trimmed = value.trim();
    if (!trimmed || /[\\/]/.test(trimmed) || trimmed === '.' || trimmed === '..') {
        throw new Error('filename must be a plain file name without directory segments');
    }
    const safe = trimmed.replace(/[<>:"|?*\u0000-\u001f]/g, '_');
    return safe.toLowerCase().endsWith('.mp4') ? safe : `${safe}.mp4`;
}

async function chooseUniquePath(path: string): Promise<string> {
    try {
        await fs.access(path);
    } catch {
        return path;
    }
    const stem = path.slice(0, -4);
    for (let index = 2; index < 10_000; index++) {
        const candidate = `${stem}_${index}.mp4`;
        try {
            await fs.access(candidate);
        } catch {
            return candidate;
        }
    }
    throw new Error('Unable to allocate a unique output filename');
}

function escapeXml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function titleUnits(value: string): number {
    return Array.from(value).reduce(
        (total, char) => total + (/[\x00-\xff]/.test(char) ? 0.55 : 1),
        0,
    );
}

/**
 * Wrap a mixed Chinese/Latin title without splitting ordinary Latin words.
 * A single overlong token may still be split so it can never escape the card.
 */
export function wrapTitle(value: string, maxUnits = 18, maxLines = 4): string[] {
    const normalized = value.replace(/\s+/g, ' ').trim() || 'OpenFlux 测试视频';
    const tokens = normalized.match(
        /\s+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[A-Za-z0-9]+(?:['’._+\/-][A-Za-z0-9]+)*|./gu,
    ) || [];
    const wrapped: string[] = [];
    let current = '';
    let pendingSpace = false;

    const pushCurrent = () => {
        const line = current.trim();
        if (line) wrapped.push(line);
        current = '';
        pendingSpace = false;
    };

    for (const token of tokens) {
        if (/^\s+$/.test(token)) {
            pendingSpace = Boolean(current);
            continue;
        }

        const prefix = current && pendingSpace ? ' ' : '';
        const candidate = `${current}${prefix}${token}`;
        if (titleUnits(candidate) <= maxUnits) {
            current = candidate;
            pendingSpace = false;
            continue;
        }

        if (current) pushCurrent();

        if (titleUnits(token) <= maxUnits) {
            current = token;
            continue;
        }

        // Unavoidably split a URL/hash/identifier that is wider than the card.
        for (const char of Array.from(token)) {
            if (current && titleUnits(`${current}${char}`) > maxUnits) pushCurrent();
            current += char;
        }
    }
    pushCurrent();

    if (wrapped.length <= maxLines) return wrapped;

    const visible = wrapped.slice(0, maxLines);
    let last = visible[maxLines - 1];
    while (last && titleUnits(`${last}…`) > maxUnits) {
        last = Array.from(last).slice(0, -1).join('').trimEnd();
    }
    visible[maxLines - 1] = `${last}…`;
    return visible;
}

async function createTitleCard(path: string, title: string, dimensions: VideoDimensions): Promise<void> {
    const { width, height } = dimensions;
    const portrait = height > width;
    const fontSize = Math.round(Math.min(width * 0.09, height * 0.075));
    const lineHeight = Math.round(fontSize * 1.28);
    const maxLineUnits = Math.max(7, Math.floor((width * 0.82) / fontSize));
    const lines = wrapTitle(title, maxLineUnits);
    const firstY = Math.round(height * 0.46 - ((lines.length - 1) * lineHeight) / 2);
    const textNodes = lines.map((line, index) => (
        `<text x="50%" y="${firstY + index * lineHeight}" text-anchor="middle" ` +
        `font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-size="${fontSize}" ` +
        `font-weight="700" fill="#ffffff">${escapeXml(line)}</text>`
    )).join('');

    const svg = `
      <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#111827"/>
            <stop offset="0.48" stop-color="#312e81"/>
            <stop offset="1" stop-color="#7c3aed"/>
          </linearGradient>
          <radialGradient id="glow"><stop offset="0" stop-color="#60a5fa" stop-opacity=".8"/><stop offset="1" stop-color="#60a5fa" stop-opacity="0"/></radialGradient>
        </defs>
        <rect width="100%" height="100%" fill="url(#bg)"/>
        <circle cx="${Math.round(width * 0.15)}" cy="${Math.round(height * 0.18)}" r="${Math.round(width * 0.42)}" fill="url(#glow)" opacity=".45"/>
        <circle cx="${Math.round(width * 0.86)}" cy="${Math.round(height * 0.78)}" r="${Math.round(width * 0.5)}" fill="url(#glow)" opacity=".28"/>
        <rect x="${Math.round(width * 0.09)}" y="${Math.round(height * 0.08)}" width="${Math.round(width * 0.46)}" height="${Math.round(fontSize * 1.05)}" rx="${Math.round(fontSize * 0.52)}" fill="#ffffff" fill-opacity=".12" stroke="#ffffff" stroke-opacity=".22"/>
        <text x="${Math.round(width * 0.12)}" y="${Math.round(height * 0.08 + fontSize * 0.72)}" font-family="Arial, sans-serif" font-size="${Math.round(fontSize * 0.34)}" font-weight="700" letter-spacing="3" fill="#dbeafe">OPENFLUX · TEST VIDEO</text>
        ${textNodes}
        <text x="50%" y="${Math.round(height * 0.9)}" text-anchor="middle" font-family="Microsoft YaHei, sans-serif" font-size="${Math.round(fontSize * 0.32)}" fill="#e0e7ff">本地合成 · H.264 · AAC</text>
      </svg>`;
    await sharp(Buffer.from(svg)).png().toFile(path);
}

function abortError(signal?: AbortSignal): Error {
    const reason = signal?.reason;
    const error = new Error(reason instanceof Error ? reason.message : 'Video generation aborted');
    error.name = 'AbortError';
    return error;
}

class FfmpegUnavailableError extends Error {
    readonly code = 'FFMPEG_UNAVAILABLE';

    constructor(cause: Error) {
        super(`FFmpeg executable is unavailable: ${cause.message}`, { cause });
        this.name = 'FfmpegUnavailableError';
    }
}

async function runFfmpegProcess(
    executable: string,
    args: string[],
    options: VideoProcessOptions,
): Promise<void> {
    if (options.signal?.aborted) throw abortError(options.signal);
    await new Promise<void>((resolvePromise, rejectPromise) => {
        const child = spawn(executable, args, {
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        let settled = false;
        let lastProgressAt = 0;

        const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            options.signal?.removeEventListener('abort', onAbort);
            if (error) rejectPromise(error);
            else resolvePromise();
        };
        const onAbort = () => {
            child.kill('SIGKILL');
            finish(abortError(options.signal));
        };
        options.signal?.addEventListener('abort', onAbort, { once: true });

        child.stderr?.on('data', (chunk: Buffer) => {
            const text = chunk.toString('utf8');
            stderr = `${stderr}${text}`.slice(-12_000);
            const match = /time=(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/.exec(text);
            if (match && Date.now() - lastProgressAt >= 500) {
                lastProgressAt = Date.now();
                options.onProgress?.(`FFmpeg composing video (${match[1]})`);
            }
        });
        child.once('error', error => finish(
            (error as NodeJS.ErrnoException).code === 'ENOENT'
                ? new FfmpegUnavailableError(error)
                : error,
        ));
        child.once('close', code => {
            if (settled) return;
            if (code === 0) finish();
            else finish(new Error(`FFmpeg exited with code ${code}: ${stderr.trim().slice(-2_000)}`));
        });
    });
}

export function buildFfmpegArgs(input: {
    imagePath: string;
    audioPath?: string;
    outputPath: string;
    durationSeconds: number;
    dimensions: VideoDimensions;
    fps?: number;
}): string[] {
    const fps = input.fps || DEFAULT_FPS;
    const { width, height } = input.dimensions;
    const videoFilter = [
        `scale=${width}:${height}:force_original_aspect_ratio=increase`,
        `crop=${width}:${height}`,
        `zoompan=z='min(zoom+0.00035,1.08)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${width}x${height}:fps=${fps}`,
        'format=yuv420p',
    ].join(',');
    const duration = input.durationSeconds.toFixed(3);
    const args = ['-hide_banner', '-y', '-loop', '1', '-framerate', String(fps), '-i', input.imagePath];
    if (input.audioPath) {
        args.push('-stream_loop', '-1', '-i', input.audioPath);
    } else {
        args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
    }
    args.push(
        '-map', '0:v:0', '-map', '1:a:0',
        '-vf', videoFilter,
        '-t', duration,
        '-r', String(fps),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
        '-movflags', '+faststart', '-shortest', input.outputPath,
    );
    return args;
}

function structuredError(error: unknown, code: string): ToolResult {
    const message = error instanceof Error ? error.message : String(error);
    const causeCode = error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code || '') || undefined
        : undefined;
    return {
        success: false,
        error: message,
        code,
        retryable: false,
        route: 'local_ffmpeg',
        cause: {
            name: error instanceof Error ? error.name : undefined,
            message,
            code: causeCode,
        },
    };
}

export function createVideoGenTool(options: VideoGenToolOptions = {}): Tool {
    return {
        name: 'generate_video',
        priority: 23,
        description: 'Create a real MP4 short video locally with FFmpeg. Use for test videos, Douyin/WeChat Channels drafts, image-to-video, title cards, and simple social-video composition. It always produces H.264 video with an AAC audio track; no external video API is required. mode="provider" is reserved and returns a clear configuration error until a provider is configured.',
        parameters: {
            prompt: {
                type: 'string',
                description: 'Title or concept shown on the generated title card when reference_image is omitted.',
            },
            reference_image: {
                type: 'string',
                description: 'Optional local image path used as the video background (absolute or relative to the output base directory).',
            },
            audio_path: {
                type: 'string',
                description: 'Optional local audio path. It is looped or trimmed to the requested duration; otherwise a silent AAC track is generated.',
            },
            duration: {
                type: 'number',
                description: `Video length in seconds (${1}-${MAX_DURATION_SECONDS}, default ${DEFAULT_DURATION_SECONDS}).`,
                default: DEFAULT_DURATION_SECONDS,
            },
            aspect_ratio: {
                type: 'string',
                description: 'Output aspect ratio. Use 9:16 for Douyin and WeChat Channels.',
                enum: ['9:16', '16:9', '1:1'],
                default: '9:16',
            },
            resolution: {
                type: 'string',
                description: 'Output resolution preset.',
                enum: ['720p', '1080p'],
                default: '720p',
            },
            mode: {
                type: 'string',
                description: 'auto/compose uses reliable local FFmpeg composition; provider requires a separately configured remote video provider.',
                enum: ['auto', 'compose', 'provider'],
                default: 'auto',
            },
            output_dir: {
                type: 'string',
                description: 'Optional output subdirectory. It must remain inside the configured OpenFlux output directory.',
            },
            filename: {
                type: 'string',
                description: 'Optional plain MP4 filename, for example test-video.mp4.',
            },
        },

        async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
            const startedAt = Date.now();
            const mode = (readStringParam(args, 'mode') || 'auto') as VideoGenerationMode;
            if (!['auto', 'compose', 'provider'].includes(mode)) {
                return structuredError(new Error(`Unsupported video mode: ${mode}`), 'invalid_request');
            }
            if (mode === 'provider') {
                return {
                    success: false,
                    error: 'Remote video provider is not configured. Use mode="auto" or mode="compose" for local MP4 generation.',
                    code: 'provider_unavailable',
                    retryable: false,
                    route: 'provider',
                };
            }

            const signal = context?.abortSignal || context?.signal;
            if (signal?.aborted) throw abortError(signal);

            let tempDir: string | undefined;
            let outputPath: string | undefined;
            try {
                const durationRaw = readNumberParam(args, 'duration') ?? DEFAULT_DURATION_SECONDS;
                const durationSeconds = Math.max(1, Math.min(MAX_DURATION_SECONDS, durationRaw));
                const aspectRatio = (readStringParam(args, 'aspect_ratio') || '9:16') as VideoAspectRatio;
                const resolution = (readStringParam(args, 'resolution') || '720p') as VideoResolution;
                if (!['9:16', '16:9', '1:1'].includes(aspectRatio)) throw new Error(`Unsupported aspect_ratio: ${aspectRatio}`);
                if (!['720p', '1080p'].includes(resolution)) throw new Error(`Unsupported resolution: ${resolution}`);
                const dimensions = resolveVideoDimensions(aspectRatio, resolution);

                const baseOutput = resolve(options.getOutputPath?.() || process.cwd());
                const outputDirRaw = readStringParam(args, 'output_dir');
                const outputDir = resolve(outputDirRaw
                    ? (isAbsolute(outputDirRaw) ? outputDirRaw : join(baseOutput, outputDirRaw))
                    : baseOutput);
                if (!isWithin(baseOutput, outputDir)) {
                    throw new Error('output_dir must remain inside the configured OpenFlux output directory');
                }
                await fs.mkdir(outputDir, { recursive: true });
                if (signal?.aborted) throw abortError(signal);
                outputPath = await chooseUniquePath(join(outputDir, sanitizeFilename(readStringParam(args, 'filename'))));

                const resolveInput = (value: string) => resolve(isAbsolute(value) ? value : join(baseOutput, value));
                let imagePath: string;
                const referenceImage = readStringParam(args, 'reference_image');
                if (referenceImage) {
                    imagePath = resolveInput(referenceImage);
                    const stat = await fs.stat(imagePath);
                    if (!stat.isFile()) throw new Error(`reference_image is not a file: ${imagePath}`);
                } else {
                    tempDir = await fs.mkdtemp(join(outputDir, '.openflux-video-'));
                    imagePath = join(tempDir, `title-${randomUUID()}.png`);
                    context?.onProgress?.({ type: 'progress', message: 'Creating video title card' });
                    await createTitleCard(imagePath, readStringParam(args, 'prompt') || 'OpenFlux 测试视频', dimensions);
                    if (signal?.aborted) throw abortError(signal);
                }

                const audioRaw = readStringParam(args, 'audio_path');
                const audioPath = audioRaw ? resolveInput(audioRaw) : undefined;
                if (audioPath) {
                    const stat = await fs.stat(audioPath);
                    if (!stat.isFile()) throw new Error(`audio_path is not a file: ${audioPath}`);
                }

                const probed = getEnvProbe().tools.ffmpeg;
                const executable = options.getFfmpegPath?.() || (probed?.available ? probed.path || 'ffmpeg' : 'ffmpeg');
                const ffmpegArgs = buildFfmpegArgs({
                    imagePath,
                    audioPath,
                    outputPath,
                    durationSeconds,
                    dimensions,
                });
                if (signal?.aborted) throw abortError(signal);
                context?.onProgress?.({ type: 'progress', message: 'Composing H.264/AAC MP4 locally with FFmpeg' });
                await (options.runFfmpeg || runFfmpegProcess)(executable, ffmpegArgs, {
                    signal,
                    onProgress: message => context?.onProgress?.({ type: 'progress', message }),
                });

                if (signal?.aborted) throw abortError(signal);
                const outputStat = await fs.stat(outputPath);
                if (signal?.aborted) throw abortError(signal);
                if (!outputStat.isFile() || outputStat.size === 0) {
                    throw new Error('FFmpeg completed without producing a valid MP4 file');
                }
                const result = {
                    success: true,
                    data: {
                        provider: 'local_ffmpeg',
                        route: 'local_ffmpeg',
                        mode: 'compose',
                        files: [outputPath],
                        mimeType: 'video/mp4',
                        durationMs: Math.round(durationSeconds * 1000),
                        width: dimensions.width,
                        height: dimensions.height,
                        size: outputStat.size,
                        tookMs: Date.now() - startedAt,
                    },
                } satisfies ToolResult;
                log.info('Video generation completed', result.data);
                return result;
            } catch (error) {
                if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
                    if (outputPath) await fs.rm(outputPath, { force: true }).catch(() => undefined);
                    throw abortError(signal);
                }
                const code = error instanceof FfmpegUnavailableError
                    ? 'ffmpeg_unavailable'
                    : 'composition_failed';
                log.error('Video generation failed', { error: error instanceof Error ? error.message : String(error), code });
                return structuredError(error, code);
            } finally {
                if (tempDir) {
                    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
                }
            }
        },
    };
}
