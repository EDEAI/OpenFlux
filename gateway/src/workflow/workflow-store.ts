/**
 * Workflow template persistent storage
 * Store user-defined WorkflowTemplate as JSON file
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { WorkflowTemplate } from './types';
import { Logger } from '../utils/logger';

const log = new Logger('WorkflowStore');

export class WorkflowStore {
    private storePath: string;

    /**
     * @param storePath storage directory path (such as {workspace}/.workflows)
     */
    constructor(storePath: string) {
        this.storePath = storePath;
        this.ensureDir();
    }

    /**
     * Make sure the storage directory exists
     */
    private ensureDir(): void {
        if (!existsSync(this.storePath)) {
            mkdirSync(this.storePath, { recursive: true });
            log.info(`Created workflow store directory: ${this.storePath}`);
        }
    }

    /**
     * Get template file path
     */
    private getFilePath(id: string): string {
        // Handle ids securely to prevent path traversal
        const safeId = id.replace(/[^a-zA-Z0-9\-_]/g, '_');
        return join(this.storePath, `${safeId}.json`);
    }

    /**
     * Save template
     */
    save(template: WorkflowTemplate): void {
        const filePath = this.getFilePath(template.id);
        try {
            writeFileSync(filePath, JSON.stringify(template, null, 2), 'utf-8');
            log.info(`Workflow template saved: ${template.id} (${template.name})`);
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            log.error(`Failed to save workflow template: ${template.id}`, { error: msg });
            throw new Error(`Failed to save workflow template: ${msg}`);
        }
    }

    /**
     * Load a single template
     */
    load(id: string): WorkflowTemplate | null {
        const filePath = this.getFilePath(id);
        if (!existsSync(filePath)) return null;

        try {
            const content = readFileSync(filePath, 'utf-8');
            return JSON.parse(content) as WorkflowTemplate;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            log.error(`Failed to load workflow template: ${id}`, { error: msg });
            return null;
        }
    }

    /**
     * Load all templates
     */
    loadAll(): WorkflowTemplate[] {
        const templates: WorkflowTemplate[] = [];

        try {
            const files = readdirSync(this.storePath).filter(f => f.endsWith('.json'));
            for (const file of files) {
                try {
                    const content = readFileSync(join(this.storePath, file), 'utf-8');
                    const template = JSON.parse(content) as WorkflowTemplate;
                    if (template.id && template.name && template.steps) {
                        templates.push(template);
                    } else {
                        log.warn(`Skipped invalid workflow template file: ${file}`);
                    }
                } catch {
                    log.warn(`Failed to parse workflow template file: ${file}`);
                }
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            log.error('Failed to load workflow template list', { error: msg });
        }

        log.info(`Loaded ${templates.length} custom workflow templates`);
        return templates;
    }

    /**
     * Delete template
     */
    delete(id: string): boolean {
        const filePath = this.getFilePath(id);
        if (!existsSync(filePath)) return false;

        try {
            unlinkSync(filePath);
            log.info(`Workflow template deleted: ${id}`);
            return true;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            log.error(`Failed to delete workflow template: ${id}`, { error: msg });
            return false;
        }
    }

    /**
     * Check if template exists
     */
    exists(id: string): boolean {
        return existsSync(this.getFilePath(id));
    }
}
