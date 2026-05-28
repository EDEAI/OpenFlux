/**
 * Evolution Data Manager
 * 统一管理所有进化数据的持久化，保障版本升级延续性
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, cpSync } from 'fs';
import { dirname, join, relative } from 'path';
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
    /** 用户可见的技能标识，通常是 SkillHub 原始 ID */
    slug: string;
    /** SkillHub 原始完整 ID，例如 anthropics/skills/pdf */
    remoteSlug?: string;
    /** 本地安全目录名，不能包含路径分隔符 */
    storageSlug?: string;
    /** AgentManager 内部技能 ID，用于避免同名 SkillHub 技能互相覆盖 */
    runtimeSkillId?: string;
    source: string;
    version: string;
    installedAt: string;
    hash: string;
    description?: string;
}

interface InstalledSkillEntry {
    dir: string;
    relativeSlug: string;
    meta: InstalledSkillMeta;
}

const WINDOWS_RESERVED_FILE_NAMES = new Set([
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

const MAX_SKILL_STORAGE_SLUG_LENGTH = 120;

/** 规范化外部技能标识，统一使用 / 表示层级，仅用于比较和展示 */
export function normalizeSkillIdentifier(identifier: string): string {
    return String(identifier || '')
        .trim()
        .replace(/\\/g, '/')
        .replace(/\/+/g, '/')
        .replace(/^\/+|\/+$/g, '');
}

function hashSkillIdentifier(identifier: string): string {
    return createHash('sha256').update(identifier).digest('hex').substring(0, 8);
}

function sanitizeStorageSegment(segment: string): string {
    let safe = segment.normalize('NFKC')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
        .replace(/[. ]+$/g, '')
        .trim();

    if (!safe) safe = 'skill';
    if (WINDOWS_RESERVED_FILE_NAMES.has(safe.toUpperCase())) safe = `_${safe}`;
    return safe;
}

/**
 * 将 SkillHub ID 转成跨平台安全的单层目录名。
 * 目录名以技能名最后一段为主体，追加短 hash 避免不同来源的同名技能互相覆盖。
 */
export function toSkillStorageSlug(identifier: string): string {
    const normalized = normalizeSkillIdentifier(identifier);
    const source = normalized || 'skill';
    const segments = source.split('/').filter(Boolean);
    const rawName = segments[segments.length - 1] || source;
    const safe = sanitizeStorageSegment(rawName);

    const needsDisambiguation = segments.length > 1 || safe !== rawName || safe !== source;
    const hash = hashSkillIdentifier(source);
    const suffix = needsDisambiguation ? `--${hash}` : '';
    const maxBaseLength = MAX_SKILL_STORAGE_SLUG_LENGTH - suffix.length;
    const base = safe.length > maxBaseLength
        ? safe.substring(0, Math.max(1, maxBaseLength)).replace(/[. ]+$/g, '')
        : safe;

    return `${base}${suffix}`;
}

/** 生成 AgentManager 内部使用的稳定技能 ID */
export function toSkillRuntimeId(identifier: string): string {
    return `skillhub:${toSkillStorageSlug(identifier)}`;
}

/** 判断用户输入是否指向某个已安装技能 */
export function installedSkillMatches(meta: InstalledSkillMeta, identifier: string): boolean {
    const normalizedInput = normalizeSkillIdentifier(identifier);
    if (!normalizedInput) return false;

    const storageInput = toSkillStorageSlug(normalizedInput);
    const candidates = [
        meta.slug,
        meta.remoteSlug,
        meta.storageSlug,
    ].filter((value): value is string => Boolean(value));

    return candidates.some(candidate => {
        const normalizedCandidate = normalizeSkillIdentifier(candidate);
        return normalizedCandidate === normalizedInput
            || normalizedCandidate === storageInput
            || toSkillStorageSlug(normalizedCandidate) === storageInput;
    });
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
    /** 最近一次内容升级时间 */
    updatedAt?: string;
    /** 被升级次数（默认 0） */
    upgradeCount?: number;
    sourceSession?: string;
    hash: string;
    /** 用户是否已启用该技能（默认 false，需手动开启） */
    enabled: boolean;
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
            installedSkills: this.listInstalledSkills().length,
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
        const storageSlug = toSkillStorageSlug(meta.storageSlug || slug);
        const normalizedMeta: InstalledSkillMeta = {
            ...meta,
            slug: meta.slug || slug,
            storageSlug,
            runtimeSkillId: meta.runtimeSkillId || toSkillRuntimeId(storageSlug),
        };
        if (!normalizedMeta.remoteSlug && normalizeSkillIdentifier(normalizedMeta.slug) !== storageSlug) {
            normalizedMeta.remoteSlug = normalizeSkillIdentifier(normalizedMeta.slug);
        }

        const dir = join(this.installedSkillsPath, storageSlug);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'SKILL.md'), skillContent, 'utf-8');
        writeFileSync(join(dir, 'meta.json'), JSON.stringify(normalizedMeta, null, 2), 'utf-8');
        this.refreshStats();
    }

    /** 获取已安装技能列表 */
    listInstalledSkills(): InstalledSkillMeta[] {
        const results: InstalledSkillMeta[] = [];
        const seen = new Set<string>();

        for (const entry of this.listInstalledSkillEntries()) {
            const key = normalizeSkillIdentifier(entry.meta.remoteSlug || entry.meta.slug || entry.relativeSlug);
            if (seen.has(key)) continue;
            seen.add(key);

            const meta = { ...entry.meta };
            if (!meta.storageSlug) meta.storageSlug = entry.relativeSlug.includes('/')
                ? toSkillStorageSlug(meta.remoteSlug || meta.slug || entry.relativeSlug)
                : entry.relativeSlug;

            // 从 SKILL.md frontmatter 提取 description
            if (!meta.description) {
                const skillPath = join(entry.dir, 'SKILL.md');
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
        return results;
    }

    /** 读取已安装技能的 SKILL.md 内容 */
    readSkillContent(slug: string): string | null {
        const dir = this.resolveInstalledSkillDir(slug);
        if (!dir) return null;
        const filePath = join(dir, 'SKILL.md');
        return existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null;
    }

    /** 删除已安装技能 */
    removeInstalledSkill(slug: string): boolean {
        const dir = this.resolveInstalledSkillDir(slug);
        if (!dir || !existsSync(dir)) return false;
        rmSync(dir, { recursive: true, force: true });
        this.removeEmptyInstalledSkillParents(dir);
        this.refreshStats();
        return true;
    }

    private listInstalledSkillEntries(): InstalledSkillEntry[] {
        if (!existsSync(this.installedSkillsPath)) return [];

        const entries: InstalledSkillEntry[] = [];
        const walk = (dir: string, depth: number): void => {
            if (depth > 8) return;

            const metaPath = join(dir, 'meta.json');
            if (existsSync(metaPath)) {
                try {
                    const meta: InstalledSkillMeta = JSON.parse(readFileSync(metaPath, 'utf-8'));
                    const relativeSlug = normalizeSkillIdentifier(relative(this.installedSkillsPath, dir));
                    entries.push({ dir, relativeSlug, meta });
                } catch (err) {
                    log.warn(`Invalid installed skill metadata: ${metaPath}`, { error: err instanceof Error ? err.message : String(err) });
                }
                return;
            }

            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                if (!entry.isDirectory()) continue;
                walk(join(dir, entry.name), depth + 1);
            }
        };

        walk(this.installedSkillsPath, 0);
        return entries;
    }

    private resolveInstalledSkillDir(identifier: string): string | null {
        const normalized = normalizeSkillIdentifier(identifier);
        if (!normalized || !existsSync(this.installedSkillsPath)) return null;

        const storageSlug = toSkillStorageSlug(normalized);
        const directDir = join(this.installedSkillsPath, storageSlug);
        if (existsSync(join(directDir, 'meta.json')) || existsSync(join(directDir, 'SKILL.md'))) {
            return directDir;
        }

        const entries = this.listInstalledSkillEntries();
        const match = entries.find(entry => {
            const relativeSlug = normalizeSkillIdentifier(entry.relativeSlug);
            return installedSkillMatches(entry.meta, normalized)
                || relativeSlug === normalized
                || relativeSlug === storageSlug
                || toSkillStorageSlug(relativeSlug) === storageSlug;
        });

        return match?.dir || null;
    }

    private removeEmptyInstalledSkillParents(removedDir: string): void {
        let current = dirname(removedDir);

        while (current !== this.installedSkillsPath) {
            const rel = relative(this.installedSkillsPath, current);
            if (!rel || rel.startsWith('..')) break;
            if (readdirSync(current).length > 0) break;

            rmSync(current, { recursive: true, force: true });
            current = dirname(current);
        }
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

    /** 升级已有锻造技能的内容 */
    upgradeForgedSkillContent(id: string, newContent: string, newReasoning?: string): boolean {
        const dir = join(this.forgedSkillsPath, id);
        const metaPath = join(dir, 'meta.json');
        if (!existsSync(metaPath)) return false;
        try {
            const meta: ForgedSkillMeta = JSON.parse(readFileSync(metaPath, 'utf-8'));
            // 更新内容
            const newHash = this.computeHash(newContent);
            writeFileSync(join(dir, 'content.md'), newContent, 'utf-8');
            meta.hash = newHash;
            meta.updatedAt = new Date().toISOString();
            meta.upgradeCount = (meta.upgradeCount ?? 0) + 1;
            if (newReasoning) meta.reasoning = newReasoning;
            writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
            return true;
        } catch {
            return false;
        }
    }

    /** 更新锻造技能元信息（如 enabled 开关） */
    updateForgedSkill(id: string, updates: Partial<Pick<ForgedSkillMeta, 'enabled'>>): boolean {
        const dir = join(this.forgedSkillsPath, id);
        const metaPath = join(dir, 'meta.json');
        if (!existsSync(metaPath)) return false;
        try {
            const meta: ForgedSkillMeta = JSON.parse(readFileSync(metaPath, 'utf-8'));
            Object.assign(meta, updates);
            writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
            return true;
        } catch {
            return false;
        }
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
