/**
 * Evolution Data Manager
 * 统一管理所有进化数据的持久化，保障版本升级延续性
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, cpSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { Logger } from '../utils/logger';

const log = new Logger('EvolutionData');

/** 进化数据清单 */
export interface EvolutionManifest {
    /** 数据格式版本号 */
    schemaVersion: number;
    /** 最后更新时间 */
    lastUpdated: string;
    /** 各模块数据统计 */
    stats: {
        installedSkills: number;
        customTools: number;
        forgedSkills: number;
        spawnedAgents: number;
        mcpConnections: number;
    };
}

/** 已安装技能元信息 */
export interface InstalledSkillMeta {
    slug: string;
    source: string;
    version: string;
    installedAt: string;
    hash: string;
    description?: string;
}

/** 自定义工具元信息 */
export interface CustomToolMeta {
    name: string;
    description: string;
    scriptType: 'python' | 'node' | 'shell';
    createdAt: string;
    updatedAt: string;
    hash: string;
    confirmed: boolean;
    validatorResult: 'PASS' | 'WARN' | 'BLOCK';
}

/** 锻造技能元信息 */
export interface ForgedSkillMeta {
    id: string;
    title: string;
    category: string;
    reasoning: string;
    createdAt: string;
    sourceSession?: string;
    hash: string;
}

/** 当前 schema 版本 */
const CURRENT_SCHEMA_VERSION = 1;

/**
 * 进化数据管理器
 */
export class EvolutionDataManager {
    private basePath: string;

    constructor(workspacePath: string) {
        this.basePath = join(workspacePath, 'data', 'evolution');
    }

    /** 进化数据根目录 */
    get rootPath(): string {
        return this.basePath;
    }

    /** 已安装技能目录 */
    get installedSkillsPath(): string {
        return join(this.basePath, 'installed-skills');
    }

    /** 自定义工具目录 */
    get customToolsPath(): string {
        return join(this.basePath, 'custom-tools');
    }

    /** 锻造技能目录 */
    get forgedSkillsPath(): string {
        return join(this.basePath, 'forged-skills');
    }

    /** 分裂 Agent 目录 */
    get spawnedAgentsPath(): string {
        return join(this.basePath, 'spawned-agents');
    }

    /** MCP 连接目录 */
    get mcpConnectionsPath(): string {
        return join(this.basePath, 'mcp-connections');
    }

    /** manifest 路径 */
    get manifestPath(): string {
        return join(this.basePath, 'manifest.json');
    }

    /**
     * 初始化进化数据目录结构
     */
    async initialize(): Promise<void> {
        const dirs = [
            this.basePath,
            this.installedSkillsPath,
            this.customToolsPath,
            this.forgedSkillsPath,
            this.spawnedAgentsPath,
            this.mcpConnectionsPath,
        ];

        for (const dir of dirs) {
            if (!existsSync(dir)) {
                mkdirSync(dir, { recursive: true });
                log.info(`Created directory: ${dir}`);
            }
        }

        // 初始化 manifest
        if (!existsSync(this.manifestPath)) {
            const manifest: EvolutionManifest = {
                schemaVersion: CURRENT_SCHEMA_VERSION,
                lastUpdated: new Date().toISOString(),
                stats: {
                    installedSkills: 0,
                    customTools: 0,
                    forgedSkills: 0,
                    spawnedAgents: 0,
                    mcpConnections: 0,
                },
            };
            this.writeManifest(manifest);
            log.info('Evolution manifest initialized');
        }

        log.info(`Evolution data layer ready at: ${this.basePath}`);
    }

    /**
     * 读取 manifest
     */
    readManifest(): EvolutionManifest {
        if (!existsSync(this.manifestPath)) {
            return {
                schemaVersion: CURRENT_SCHEMA_VERSION,
                lastUpdated: new Date().toISOString(),
                stats: { installedSkills: 0, customTools: 0, forgedSkills: 0, spawnedAgents: 0, mcpConnections: 0 },
            };
        }
        return JSON.parse(readFileSync(this.manifestPath, 'utf-8'));
    }

    /**
     * 写入 manifest
     */
    writeManifest(manifest: EvolutionManifest): void {
        manifest.lastUpdated = new Date().toISOString();
        writeFileSync(this.manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    }

    /**
     * 更新 manifest 统计信息（扫描实际目录）
     */
    refreshStats(): EvolutionManifest {
        const manifest = this.readManifest();
        manifest.stats = {
            installedSkills: this.countSubDirs(this.installedSkillsPath),
            customTools: this.countSubDirs(this.customToolsPath),
            forgedSkills: this.countSubDirs(this.forgedSkillsPath),
            spawnedAgents: this.countFiles(this.spawnedAgentsPath, '.json'),
            mcpConnections: this.countFiles(this.mcpConnectionsPath, '.json'),
        };
        this.writeManifest(manifest);
        return manifest;
    }

    // ========================
    // Installed Skills
    // ========================

    /** 保存已安装技能 */
    saveInstalledSkill(slug: string, skillContent: string, meta: InstalledSkillMeta): void {
        const dir = join(this.installedSkillsPath, slug);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'SKILL.md'), skillContent, 'utf-8');
        writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
        this.refreshStats();
    }

    /** 获取已安装技能列表 */
    listInstalledSkills(): InstalledSkillMeta[] {
        if (!existsSync(this.installedSkillsPath)) return [];
        const dirs = readdirSync(this.installedSkillsPath, { withFileTypes: true })
            .filter(d => d.isDirectory());
        const results: InstalledSkillMeta[] = [];
        for (const dir of dirs) {
            const metaPath = join(this.installedSkillsPath, dir.name, 'meta.json');
            if (existsSync(metaPath)) {
                const meta: InstalledSkillMeta = JSON.parse(readFileSync(metaPath, 'utf-8'));
                // 从 SKILL.md frontmatter 提取 description
                if (!meta.description) {
                    const skillPath = join(this.installedSkillsPath, dir.name, 'SKILL.md');
                    if (existsSync(skillPath)) {
                        const content = readFileSync(skillPath, 'utf-8');
                        const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
                        if (fmMatch) {
                            const descMatch = fmMatch[1].match(/^description:\s*(.+)$/m);
                            if (descMatch) meta.description = descMatch[1].trim().replace(/^['"]|['"]$/g, '');
                        }
                    }
                }
                results.push(meta);
            }
        }
        return results;
    }

    /** 读取已安装技能的 SKILL.md 内容 */
    readSkillContent(slug: string): string | null {
        const filePath = join(this.installedSkillsPath, slug, 'SKILL.md');
        return existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null;
    }

    /** 删除已安装技能 */
    removeInstalledSkill(slug: string): boolean {
        const dir = join(this.installedSkillsPath, slug);
        if (!existsSync(dir)) return false;
        rmSync(dir, { recursive: true, force: true });
        this.refreshStats();
        return true;
    }

    // ========================
    // Custom Tools
    // ========================

    /** 保存自定义工具 */
    saveCustomTool(name: string, script: string, meta: CustomToolMeta): void {
        const dir = join(this.customToolsPath, name);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const ext = meta.scriptType === 'python' ? '.py' : meta.scriptType === 'node' ? '.js' : '.sh';
        writeFileSync(join(dir, `script${ext}`), script, 'utf-8');
        meta.hash = this.computeHash(script);
        writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
        this.refreshStats();
    }

    /** 获取自定义工具列表 */
    listCustomTools(): CustomToolMeta[] {
        if (!existsSync(this.customToolsPath)) return [];
        const dirs = readdirSync(this.customToolsPath, { withFileTypes: true })
            .filter(d => d.isDirectory());
        const results: CustomToolMeta[] = [];
        for (const dir of dirs) {
            const metaPath = join(this.customToolsPath, dir.name, 'meta.json');
            if (existsSync(metaPath)) {
                results.push(JSON.parse(readFileSync(metaPath, 'utf-8')));
            }
        }
        return results;
    }

    /** 读取自定义工具脚本 */
    readToolScript(name: string): { script: string; meta: CustomToolMeta } | null {
        const dir = join(this.customToolsPath, name);
        if (!existsSync(dir)) return null;
        const metaPath = join(dir, 'meta.json');
        if (!existsSync(metaPath)) return null;
        const meta: CustomToolMeta = JSON.parse(readFileSync(metaPath, 'utf-8'));
        const ext = meta.scriptType === 'python' ? '.py' : meta.scriptType === 'node' ? '.js' : '.sh';
        const scriptPath = join(dir, `script${ext}`);
        if (!existsSync(scriptPath)) return null;
        return { script: readFileSync(scriptPath, 'utf-8'), meta };
    }

    /** 验证工具脚本完整性 */
    verifyToolIntegrity(name: string): boolean {
        const tool = this.readToolScript(name);
        if (!tool) return false;
        return this.computeHash(tool.script) === tool.meta.hash;
    }

    /** 删除自定义工具 */
    removeCustomTool(name: string): boolean {
        const dir = join(this.customToolsPath, name);
        if (!existsSync(dir)) return false;
        rmSync(dir, { recursive: true, force: true });
        this.refreshStats();
        return true;
    }

    // ========================
    // Forged Skills
    // ========================

    /** 保存锻造技能 */
    saveForgedSkill(id: string, content: string, meta: ForgedSkillMeta): void {
        const dir = join(this.forgedSkillsPath, id);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'content.md'), content, 'utf-8');
        meta.hash = this.computeHash(content);
        writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
        this.refreshStats();
    }

    /** 获取锻造技能列表 */
    listForgedSkills(): ForgedSkillMeta[] {
        if (!existsSync(this.forgedSkillsPath)) return [];
        const dirs = readdirSync(this.forgedSkillsPath, { withFileTypes: true })
            .filter(d => d.isDirectory());
        const results: ForgedSkillMeta[] = [];
        for (const dir of dirs) {
            const metaPath = join(this.forgedSkillsPath, dir.name, 'meta.json');
            if (existsSync(metaPath)) {
                results.push(JSON.parse(readFileSync(metaPath, 'utf-8')));
            }
        }
        return results;
    }

    /** 读取锻造技能内容 */
    readForgedSkillContent(id: string): string | null {
        const filePath = join(this.forgedSkillsPath, id, 'content.md');
        return existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null;
    }

    /** 删除锻造技能 */
    removeForgedSkill(id: string): boolean {
        const dir = join(this.forgedSkillsPath, id);
        if (!existsSync(dir)) return false;
        rmSync(dir, { recursive: true, force: true });
        this.refreshStats();
        return true;
    }

    // ========================
    // Backup & Migration
    // ========================

    /** 创建备份 */
    createBackup(version: number): string {
        const backupPath = join(this.basePath, '..', `evolution-backup-v${version}`);
        if (existsSync(backupPath)) {
            rmSync(backupPath, { recursive: true, force: true });
        }
        cpSync(this.basePath, backupPath, { recursive: true });
        log.info(`Backup created: ${backupPath}`);
        return backupPath;
    }

    /** 从备份恢复 */
    restoreFromBackup(version: number): boolean {
        const backupPath = join(this.basePath, '..', `evolution-backup-v${version}`);
        if (!existsSync(backupPath)) {
            log.error(`Backup not found: ${backupPath}`);
            return false;
        }
        rmSync(this.basePath, { recursive: true, force: true });
        cpSync(backupPath, this.basePath, { recursive: true });
        log.info(`Restored from backup: ${backupPath}`);
        return true;
    }

    // ========================
    // Helpers
    // ========================

    private countSubDirs(dirPath: string): number {
        if (!existsSync(dirPath)) return 0;
        return readdirSync(dirPath, { withFileTypes: true }).filter(d => d.isDirectory()).length;
    }

    private countFiles(dirPath: string, ext: string): number {
        if (!existsSync(dirPath)) return 0;
        return readdirSync(dirPath).filter(f => f.endsWith(ext)).length;
    }

    private computeHash(content: string): string {
        return createHash('sha256').update(content).digest('hex').substring(0, 16);
    }
}
