/**
 * 录制持久化存储
 * 目录结构：{storePath}/{id}/recording.json
 * 内存维护活动录制缓存，事件追加即时落盘。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import type { Recording, RecordedStep, RecordingSummary } from './types';
import type { RecordingIntent } from './intent';
import { Logger } from '../utils/logger';

const log = new Logger('RecordingStore');

export class RecordingStore {
    private storePath: string;
    /** 活动录制内存缓存：id -> Recording，减少频繁读盘 */
    private active = new Map<string, Recording>();

    constructor(storePath: string) {
        this.storePath = storePath;
        this.ensureDir(this.storePath);
    }

    private ensureDir(dir: string): void {
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
    }

    private safeId(id: string): string {
        return String(id || '').replace(/[^a-zA-Z0-9\-_]/g, '_');
    }

    private dirOf(id: string): string {
        return join(this.storePath, this.safeId(id));
    }

    private fileOf(id: string): string {
        return join(this.dirOf(id), 'recording.json');
    }

    /** 开始一次录制（创建空记录并落盘） */
    start(meta: { id: string; title: string; startUrl?: string; createdAt?: number }): Recording {
        const now = Date.now();
        const recording: Recording = {
            id: meta.id,
            title: meta.title || `录制 ${new Date(now).toLocaleString()}`,
            startUrl: meta.startUrl,
            createdAt: meta.createdAt || now,
            updatedAt: now,
            steps: [],
        };
        this.active.set(recording.id, recording);
        this.persist(recording);
        log.info(`Recording started: ${recording.id} (${recording.title})`);
        return recording;
    }

    /** 追加一个步骤 */
    appendStep(id: string, step: RecordedStep): void {
        let recording = this.active.get(id) || this.load(id);
        if (!recording) {
            // 容错：未收到 start 时按事件自举创建
            recording = this.start({ id, title: '', startUrl: step.url });
        }
        recording.steps.push(step);
        recording.updatedAt = Date.now();
        this.active.set(id, recording);
        this.persist(recording);
    }

    /** 停止录制（刷新更新时间并从活动缓存移除） */
    stop(id: string, updatedAt?: number): Recording | null {
        const recording = this.active.get(id) || this.load(id);
        if (!recording) return null;
        recording.updatedAt = updatedAt || Date.now();
        this.persist(recording);
        this.active.delete(id);
        log.info(`Recording stopped: ${id} (${recording.steps.length} steps)`);
        return recording;
    }

    /** 读取单条录制 */
    load(id: string): Recording | null {
        const file = this.fileOf(id);
        if (!existsSync(file)) return null;
        try {
            return JSON.parse(readFileSync(file, 'utf-8')) as Recording;
        } catch (e) {
            log.warn(`Failed to parse recording: ${id}`, { error: e instanceof Error ? e.message : String(e) });
            return null;
        }
    }

    /** 列出所有录制摘要（按更新时间倒序） */
    list(): RecordingSummary[] {
        const summaries: RecordingSummary[] = [];
        if (!existsSync(this.storePath)) return summaries;
        for (const entry of readdirSync(this.storePath, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const file = join(this.storePath, entry.name, 'recording.json');
            if (!existsSync(file)) continue;
            try {
                const rec = JSON.parse(readFileSync(file, 'utf-8')) as Recording;
                summaries.push({
                    id: rec.id,
                    title: rec.title,
                    startUrl: rec.startUrl,
                    createdAt: rec.createdAt,
                    updatedAt: rec.updatedAt,
                    stepCount: rec.steps?.length || 0,
                });
            } catch {
                /* skip corrupt */
            }
        }
        summaries.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        return summaries;
    }

    /** 保存意图归纳结果（intent.json，与 recording.json 同目录） */
    saveIntent(id: string, intent: RecordingIntent): void {
        try {
            this.ensureDir(this.dirOf(id));
            writeFileSync(join(this.dirOf(id), 'intent.json'), JSON.stringify(intent, null, 2), 'utf-8');
        } catch (e) {
            log.error(`Failed to persist intent: ${id}`, { error: e instanceof Error ? e.message : String(e) });
        }
    }

    /** 读取意图归纳结果（不存在或损坏返回 null） */
    loadIntent(id: string): RecordingIntent | null {
        const file = join(this.dirOf(id), 'intent.json');
        if (!existsSync(file)) return null;
        try {
            return JSON.parse(readFileSync(file, 'utf-8')) as RecordingIntent;
        } catch {
            return null;
        }
    }

    /** 删除录制 */
    delete(id: string): boolean {
        const dir = this.dirOf(id);
        if (!existsSync(dir)) return false;
        try {
            rmSync(dir, { recursive: true, force: true });
            this.active.delete(id);
            log.info(`Recording deleted: ${id}`);
            return true;
        } catch (e) {
            log.error(`Failed to delete recording: ${id}`, { error: e instanceof Error ? e.message : String(e) });
            return false;
        }
    }

    private persist(recording: Recording): void {
        try {
            this.ensureDir(this.dirOf(recording.id));
            writeFileSync(this.fileOf(recording.id), JSON.stringify(recording, null, 2), 'utf-8');
        } catch (e) {
            log.error(`Failed to persist recording: ${recording.id}`, { error: e instanceof Error ? e.message : String(e) });
        }
    }
}
