/**
 * 蒸馏调度器
 * 类似人类睡眠系统 — 在配置的非忙时段自动执行记忆蒸馏
 * 
 * 特性:
 * - 可配置开关 (enabled)
 * - 可配置执行时段 (startTime ~ endTime)
 * - 自动检测是否在蒸馏窗口内
 * - 防止重复执行 (当日只蒸馏一次)
 * - 与原有 MemoryManager 完全独立
 */
import { EventEmitter } from 'events';
import { Logger } from '../../utils/logger';
import { DistillationConfig } from './types';
import { CardUpgrader } from './card-upgrader';

export class DistillationScheduler extends EventEmitter {
    private logger = new Logger('DistillationScheduler');
    private checkInterval: ReturnType<typeof setInterval> | null = null;
    private lastRunDate: string | null = null; // YYYY-MM-DD
    private isRunning = false;

    constructor(
        private upgrader: CardUpgrader,
        private config: DistillationConfig
    ) {
        super();
    }

    /**
     * 启动调度器
     */
    start() {
        if (!this.config.enabled) {
            this.logger.info('蒸馏系统未启用');
            return;
        }

        if (this.checkInterval) return;

        // 每 5 分钟检查一次是否在蒸馏窗口
        this.checkInterval = setInterval(() => this.tick(), 5 * 60 * 1000);

        // 启动时立即检查一次
        this.tick();

        this.logger.info(`🌙 蒸馏调度器已启动，时段: ${this.config.startTime} - ${this.config.endTime}`);
    }

    /**
     * 停止调度器
     */
    stop() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
        this.logger.info('蒸馏调度器已停止');
    }

    /**
     * 更新配置
     */
    updateConfig(config: Partial<DistillationConfig>) {
        const wasEnabled = this.config.enabled;
        this.config = { ...this.config, ...config };
        this.upgrader.updateConfig(this.config);

        if (wasEnabled && !this.config.enabled) {
            this.stop();
        } else if (!wasEnabled && this.config.enabled) {
            this.start();
        }

        this.logger.info('蒸馏配置已更新', config);
    }

    /**
     * 手动触发蒸馏 (不受时段限制)
     */
    async triggerManual(): Promise<void> {
        if (this.isRunning) {
            this.logger.warn('蒸馏正在进行中，跳过');
            return;
        }
        await this.executeDistillation();
    }

    /**
     * 获取调度器状态
     */
    getStatus(): {
        enabled: boolean;
        isRunning: boolean;
        lastRunDate: string | null;
        nextWindow: string;
        isInWindow: boolean;
    } {
        return {
            enabled: this.config.enabled,
            isRunning: this.isRunning,
            lastRunDate: this.lastRunDate,
            nextWindow: `${this.config.startTime} - ${this.config.endTime}`,
            isInWindow: this.isInDistillationWindow(),
        };
    }

    // ========================
    // 内部方法
    // ========================

    /**
     * 定时检查
     */
    private async tick() {
        if (!this.config.enabled || this.isRunning) return;

        // 检查是否在蒸馏窗口
        if (!this.isInDistillationWindow()) return;

        // 检查今天是否已执行
        const today = new Date().toISOString().split('T')[0];
        if (this.lastRunDate === today) return;

        this.logger.info('🌙 进入蒸馏窗口，开始执行...');
        await this.executeDistillation();
    }

    /**
     * 执行蒸馏
     */
    private async executeDistillation() {
        this.isRunning = true;
        this.emit('distillationStarted');

        try {
            const result = await this.upgrader.runDistillation();
            this.lastRunDate = new Date().toISOString().split('T')[0];

            this.logger.info('🌙 蒸馏完成', result);
            this.emit('distillationCompleted', result);

        } catch (error) {
            this.logger.error('蒸馏执行失败', { error: String(error) });
            this.emit('distillationFailed', error);

        } finally {
            this.isRunning = false;
        }
    }

    /**
     * 判断当前时间是否在蒸馏窗口内
     */
    private isInDistillationWindow(): boolean {
        const now = new Date();
        const currentMinutes = now.getHours() * 60 + now.getMinutes();

        const [startH, startM] = this.config.startTime.split(':').map(Number);
        const [endH, endM] = this.config.endTime.split(':').map(Number);

        const startMinutes = startH * 60 + startM;
        const endMinutes = endH * 60 + endM;

        // 处理跨午夜的情况 (如 23:00 - 05:00)
        if (startMinutes <= endMinutes) {
            return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
        } else {
            return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
        }
    }
}
