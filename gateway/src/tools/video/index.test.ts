import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildFfmpegArgs, createVideoGenTool, resolveVideoDimensions, wrapTitle } from './index';

test('video dimensions map social aspect ratios deterministically', () => {
    assert.deepEqual(resolveVideoDimensions('9:16', '720p'), { width: 720, height: 1280 });
    assert.deepEqual(resolveVideoDimensions('16:9', '1080p'), { width: 1920, height: 1080 });
    assert.deepEqual(resolveVideoDimensions('1:1', '1080p'), { width: 1080, height: 1080 });
});

test('title wrapping preserves normal Latin words and caps visible lines', () => {
    assert.deepEqual(
        wrapTitle('OpenFlux local test video for Douyin and WeChat Channel', 9, 4),
        ['OpenFlux local', 'test video for', 'Douyin and', 'WeChat Channel'],
    );

    const truncated = wrapTitle('one two three four five six seven eight nine ten', 5, 3);
    assert.equal(truncated.length, 3);
    assert.match(truncated[2], /…$/);
    assert.ok(truncated.every(line => !/^\s|\s$/.test(line)));
});

test('title wrapping supports mixed Chinese and Latin text', () => {
    const lines = wrapTitle('OpenFlux 本地测试视频 for 抖音和视频号', 9, 4);
    assert.ok(lines.length <= 4);
    assert.ok(lines.every(Boolean));
    assert.equal(lines.join('').replace(/\s/g, '').startsWith('OpenFlux本地测试视频'), true);
});

test('ffmpeg arguments keep paths as argv entries and request platform-compatible codecs', () => {
    const args = buildFfmpegArgs({
        imagePath: 'D:\\素材 目录\\封面.png',
        audioPath: 'D:\\素材 目录\\声音.mp3',
        outputPath: 'D:\\输出 目录\\测试.mp4',
        durationSeconds: 6,
        dimensions: { width: 720, height: 1280 },
    });
    assert.ok(args.includes('D:\\素材 目录\\封面.png'));
    assert.ok(args.includes('D:\\素材 目录\\声音.mp3'));
    assert.equal(args.at(-1), 'D:\\输出 目录\\测试.mp4');
    assert.ok(args.includes('libx264'));
    assert.ok(args.includes('aac'));
    assert.ok(args.includes('yuv420p'));
    assert.ok(args.some(arg => arg.includes('zoompan=')));
});

test('compose mode returns a concrete MP4 artifact and refuses output-directory escape', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'openflux-video-unit-'));
    try {
        const tool = createVideoGenTool({
            getOutputPath: () => root,
            getFfmpegPath: () => 'fake-ffmpeg',
            runFfmpeg: async (_executable, args) => {
                await fs.writeFile(args.at(-1)!, Buffer.from('fake-mp4'));
            },
        });
        const result = await tool.execute({
            prompt: '测试视频',
            duration: 2,
            filename: '测试成片.mp4',
        });
        assert.equal(result.success, true);
        const data = result.data as { files: string[]; width: number; height: number; mimeType: string };
        assert.equal(data.mimeType, 'video/mp4');
        assert.equal(data.width, 720);
        assert.equal(data.height, 1280);
        assert.equal((await fs.stat(data.files[0])).size, 8);

        const escaped = await tool.execute({ output_dir: join(root, '..', 'outside') });
        assert.equal(escaped.success, false);
        assert.match(escaped.error || '', /inside the configured OpenFlux output directory/);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('provider mode fails explicitly instead of pretending to generate a video', async () => {
    const result = await createVideoGenTool().execute({ mode: 'provider' });
    assert.equal(result.success, false);
    assert.equal(result.code, 'provider_unavailable');
    assert.equal(result.retryable, false);
});

test('an already aborted turn never starts FFmpeg', async () => {
    const controller = new AbortController();
    controller.abort(new Error('user stopped'));
    let called = false;
    const tool = createVideoGenTool({
        runFfmpeg: async () => { called = true; },
    });
    await assert.rejects(
        () => tool.execute({}, { abortSignal: controller.signal }),
        (error: Error) => error.name === 'AbortError' && /user stopped/.test(error.message),
    );
    assert.equal(called, false);
});

test('cancellation removes a partially written MP4 before rejecting', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'openflux-video-abort-'));
    const controller = new AbortController();
    try {
        const tool = createVideoGenTool({
            getOutputPath: () => root,
            getFfmpegPath: () => 'fake-ffmpeg',
            runFfmpeg: async (_executable, args) => {
                await fs.writeFile(args.at(-1)!, Buffer.from('partial-mp4'));
                controller.abort(new Error('stop partial video'));
            },
        });
        await assert.rejects(
            () => tool.execute({ filename: 'partial.mp4' }, { abortSignal: controller.signal }),
            (error: Error) => error.name === 'AbortError' && /stop partial video/.test(error.message),
        );
        assert.deepEqual((await fs.readdir(root)).filter(name => name.endsWith('.mp4')), []);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { windowsHide: true, encoding: 'utf8' }).status === 0;
const hasFfprobe = spawnSync('ffprobe', ['-version'], { windowsHide: true, encoding: 'utf8' }).status === 0;

test('real FFmpeg integration produces playable H.264/AAC vertical MP4', {
    skip: !(hasFfmpeg && hasFfprobe),
    timeout: 45_000,
}, async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'openflux-video-integration-'));
    try {
        const result = await createVideoGenTool({
            getOutputPath: () => root,
            getFfmpegPath: () => 'ffmpeg',
        }).execute({
            prompt: 'OpenFlux 本地视频能力验证',
            duration: 1,
            aspect_ratio: '9:16',
            resolution: '720p',
            filename: 'integration.mp4',
        });
        assert.equal(result.success, true, result.error);
        const file = (result.data as { files: string[] }).files[0];
        const probe = spawnSync('ffprobe', [
            '-v', 'error', '-show_streams', '-show_format', '-of', 'json', file,
        ], { windowsHide: true, encoding: 'utf8' });
        assert.equal(probe.status, 0, probe.stderr);
        const metadata = JSON.parse(probe.stdout) as {
            streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number; pix_fmt?: string }>;
            format: { duration?: string };
        };
        const video = metadata.streams.find(stream => stream.codec_type === 'video');
        const audio = metadata.streams.find(stream => stream.codec_type === 'audio');
        assert.equal(video?.codec_name, 'h264');
        assert.equal(video?.width, 720);
        assert.equal(video?.height, 1280);
        assert.equal(video?.pix_fmt, 'yuv420p');
        assert.equal(audio?.codec_name, 'aac');
        const duration = Number(metadata.format.duration);
        assert.ok(duration >= 0.8 && duration <= 1.3, `unexpected duration: ${duration}`);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});
