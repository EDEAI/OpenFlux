/**
 * 工作流模板持久化存储
 * 将用户自定义的 WorkflowTemplate 存储为 JSON 文件
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { WorkflowTemplate } from './types';
import { Logger } from '../utils/logger';

const log = new Logger('WorkflowStore');

export class WorkflowStore {
    private storePath: string;

    /**
     * @param storePath 存储目录路径（如 {workspace}/.workflows）
     */
    constructor(storePath: string) {
        this.storePath = storePath;
        this.ensureDir();
    }

    /**
     * 确保存储目录存在
     */
    private ensureDir(): void {
        if (!existsSync(this.storePath)) {
            mkdirSync(this.storePath, { recursive: true });
            log.info(`创建工作流存储目录: ${this.storePath}`);
        }
    }

    /**
     * 获取模板文件路径
     */
    private getFilePath(id: string): string {
        // 安全处理 id，防止路径穿越
        const safeId = id.replace(/[^a-zA-Z0-9\-_]/g, '_');
        return join(this.storePath, `${safeId}.json`);
    }

    /**
     * 保存模板
     */
    save(template: WorkflowTemplate): void {
        const filePath = this.getFilePath(template.id);
        try {
            writeFileSync(filePath, JSON.stringify(template, null, 2), 'utf-8');
            log.info(`工作流模板已保存: ${template.id} (${template.name})`);
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            log.error(`保存工作流模板失败: ${template.id}`, { error: msg });
            throw new Error(`保存工作流模板失败: ${msg}`);
        }
    }

    /**
     * 加载单个模板
     */
    load(id: string): WorkflowTemplate | null {
        const filePath = this.getFilePath(id);
        if (!existsSync(filePath)) return null;

        try {
            const content = readFileSync(filePath, 'utf-8');
            return JSON.parse(content) as WorkflowTemplate;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            log.error(`加载工作流模板失败: ${id}`, { error: msg });
            return null;
        }
    }

    /**
     * 加载所有模板
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
                        log.warn(`跳过无效的工作流模板文件: ${file}`);
                    }
                } catch {
                    log.warn(`解析工作流模板文件失败: ${file}`);
                }
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            log.error('加载工作流模板列表失败', { error: msg });
        }

        log.info(`加载了 ${templates.length} 个自定义工作流模板`);
        return templates;
    }

    /**
     * 删除模板
     */
    delete(id: string): boolean {
        const filePath = this.getFilePath(id);
        if (!existsSync(filePath)) return false;

        try {
            unlinkSync(filePath);
            log.info(`工作流模板已删除: ${id}`);
            return true;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            log.error(`删除工作流模板失败: ${id}`, { error: msg });
            return false;
        }
    }

    /**
     * 检查模板是否存在
     */
    exists(id: string): boolean {
        return existsSync(this.getFilePath(id));
    }
}
