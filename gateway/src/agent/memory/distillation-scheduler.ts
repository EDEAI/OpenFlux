/**
 * distillation scheduler
 * Similar to human sleep system - automatically performs memory distillation during configured off-busy periods
 * 
 * characteristic:
 * - Configurable switch (enabled)
 * - Configurable execution period (startTime ~ endTime)
 * - Automatically detect if within distillation window
 * - Prevent repeated execution (only distill once that day)
 * - Completely independent from the original MemoryManager
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
     * Start scheduler
     */
    start() {
        if (!this.config.enabled) {
            this.logger.info('Distillation system not enabled');
            return;
        }

        if (this.checkInterval) return;

        // Check every 5 minutes to see if you are in the distillation window
        this.checkInterval = setInterval(() => this.tick(), 5 * 60 * 1000);

        // Check once immediately on startup
        this.tick();

        this.logger.info(`🌙 Distillation scheduler started, period: ${this.config.startTime} - ${this.config.endTime}`);
    }

    /**
     * Stop scheduler
     */
    stop() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
        this.logger.info('Distillation scheduler stopped');
    }

    /**
     * Update configuration
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

        this.logger.info('Distillation config updated', config);
    }

    /**
     * Manually trigger distillation (without time limit)
     */
    async triggerManual(): Promise<void> {
        if (this.isRunning) {
            this.logger.warn('Distillation in progress, skipping');
            return;
        }
        await this.executeDistillation();
    }

    /**
     * Get scheduler status
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
    // internal method
    // ========================

    /**
     * Check regularly
     */
    private async tick() {
        if (!this.config.enabled || this.isRunning) return;

        // Check if in distillation window
        if (!this.isInDistillationWindow()) return;

        // Check if it has been executed today
        const today = new Date().toISOString().split('T')[0];
        if (this.lastRunDate === today) return;

        this.logger.info('🌙 Entering distillation window, starting execution...');
        await this.executeDistillation();
    }

    /**
     * Perform distillation
     */
    private async executeDistillation() {
        this.isRunning = true;
        this.emit('distillationStarted');

        try {
            const result = await this.upgrader.runDistillation();
            this.lastRunDate = new Date().toISOString().split('T')[0];

            this.logger.info('🌙 Distillation completed', result);
            this.emit('distillationCompleted', result);

        } catch (error) {
            this.logger.error('Distillation execution failed', { error: String(error) });
            this.emit('distillationFailed', error);

        } finally {
            this.isRunning = false;
        }
    }

    /**
     * Determine whether the current time is within the distillation window
     */
    private isInDistillationWindow(): boolean {
        const now = new Date();
        const currentMinutes = now.getHours() * 60 + now.getMinutes();

        const [startH, startM] = this.config.startTime.split(':').map(Number);
        const [endH, endM] = this.config.endTime.split(':').map(Number);

        const startMinutes = startH * 60 + startM;
        const endMinutes = endH * 60 + endM;

        // Handle situations that cross midnight (e.g. 23:00 - 05:00)
        if (startMinutes <= endMinutes) {
            return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
        } else {
            return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
        }
    }
}
