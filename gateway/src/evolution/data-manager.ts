/**
 * Evolution Data Manager
 * Unified management of the persistence of all evolutionary data to ensure continuity of version upgrades
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, cpSync } from 'fs';
import { dirname, join, relative } from 'path';
import { createHash } from 'crypto';
import { Logger } from '../utils/logger';

const log = new Logger('EvolutionData');

/** List of evolutionary data */
export interface EvolutionManifest {
    /** Data format version number */
    schemaVersion: number;
    /** Last updated */
    lastUpdated: string;
    /** Data statistics of each module */
    stats: {
        installedSkills: number;
        customTools: number;
        forgedSkills: number;
        spawnedAgents: number;
        mcpConnections: number;
    };
}

/** Installed skill meta information */
export interface InstalledSkillMeta {
    /** User-visible skill ID, usually the SkillHub original ID */
    slug: string;
    /** SkillHub original full ID, e.g. anthropotics/skills/pdf */
    remoteSlug?: string;
    /** Local security directory name, cannot contain path separators */
    storageSlug?: string;
    /** AgentManager internal skill ID, used to prevent SkillHub skills with the same name from overwriting each other */
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

/** Standardize external skill identifiers, use / to represent levels uniformly, only for comparison and display */
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
 * Convert SkillHub ID into a cross-platform secure single-layer directory name.
 * The directory name is based on the last paragraph of the skill name, and a short hash is appended to prevent skills with the same name from different sources from overwriting each other.
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

/** Generate stable skill IDs used internally by AgentManager */
export function toSkillRuntimeId(identifier: string): string {
    return `skillhub:${toSkillStorageSlug(identifier)}`;
}

/** Determine whether user input points to an installed skill */
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

/** Custom tool meta information */
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

/** Forging skill meta information */
export interface ForgedSkillMeta {
    id: string;
    title: string;
    category: string;
    reasoning: string;
    createdAt: string;
    /** Last content upgrade time */
    updatedAt?: string;
    /** Number of upgrades (default 0) */
    upgradeCount?: number;
    sourceSession?: string;
    hash: string;
    /** Whether the user has enabled this skill (default false, needs to be enabled manually) */
    enabled: boolean;
}

/** Current schema version */
const CURRENT_SCHEMA_VERSION = 1;

/**
 * Evolutionary Data Manager
 */
export class EvolutionDataManager {
    private basePath: string;

    constructor(workspacePath: string) {
        this.basePath = join(workspacePath, 'data', 'evolution');
    }

    /** Evolution data root directory */
    get rootPath(): string {
        return this.basePath;
    }

    /** Installed skills directory */
    get installedSkillsPath(): string {
        return join(this.basePath, 'installed-skills');
    }

    /** Custom tool directory */
    get customToolsPath(): string {
        return join(this.basePath, 'custom-tools');
    }

    /** Forging skill catalog */
    get forgedSkillsPath(): string {
        return join(this.basePath, 'forged-skills');
    }

    /** Split Agent directory */
    get spawnedAgentsPath(): string {
        return join(this.basePath, 'spawned-agents');
    }

    /** MCP connection directory */
    get mcpConnectionsPath(): string {
        return join(this.basePath, 'mcp-connections');
    }

    /** manifest path */
    get manifestPath(): string {
        return join(this.basePath, 'manifest.json');
    }

    /**
     * Initialize the evolutionary data directory structure
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

        // initialize manifest
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
     * Read manifest
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
     * Write manifest
     */
    writeManifest(manifest: EvolutionManifest): void {
        manifest.lastUpdated = new Date().toISOString();
        writeFileSync(this.manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    }

    /**
     * Update manifest statistics (scan the actual directory)
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

    /** Save installed skills */
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

    /** Get the list of installed skills */
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

            // Extract description from SKILL.md frontmatter
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

    /** Read the SKILL.md content of installed skills */
    readSkillContent(slug: string): string | null {
        const dir = this.resolveInstalledSkillDir(slug);
        if (!dir) return null;
        const filePath = join(dir, 'SKILL.md');
        return existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null;
    }

    /** Delete installed skills */
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

    /** Save custom tools */
    saveCustomTool(name: string, script: string, meta: CustomToolMeta): void {
        const dir = join(this.customToolsPath, name);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const ext = meta.scriptType === 'python' ? '.py' : meta.scriptType === 'node' ? '.js' : '.sh';
        writeFileSync(join(dir, `script${ext}`), script, 'utf-8');
        meta.hash = this.computeHash(script);
        writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
        this.refreshStats();
    }

    /** Get a list of custom tools */
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

    /** Read custom tool scripts */
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

    /** Verify tool script integrity */
    verifyToolIntegrity(name: string): boolean {
        const tool = this.readToolScript(name);
        if (!tool) return false;
        return this.computeHash(tool.script) === tool.meta.hash;
    }

    /** Remove custom tools */
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

    /** Save forging skills */
    saveForgedSkill(id: string, content: string, meta: ForgedSkillMeta): void {
        const dir = join(this.forgedSkillsPath, id);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'content.md'), content, 'utf-8');
        meta.hash = this.computeHash(content);
        writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
        this.refreshStats();
    }

    /** Get the list of forging skills */
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

    /** Read the content of forging skills */
    readForgedSkillContent(id: string): string | null {
        const filePath = join(this.forgedSkillsPath, id, 'content.md');
        return existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null;
    }

    /** Upgrade the content of existing forging skills */
    upgradeForgedSkillContent(id: string, newContent: string, newReasoning?: string): boolean {
        const dir = join(this.forgedSkillsPath, id);
        const metaPath = join(dir, 'meta.json');
        if (!existsSync(metaPath)) return false;
        try {
            const meta: ForgedSkillMeta = JSON.parse(readFileSync(metaPath, 'utf-8'));
            // Update content
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

    /** Update forging skill meta information (such as enabled switch) */
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

    /** Delete forging skills */
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

    /** Create backup */
    createBackup(version: number): string {
        const backupPath = join(this.basePath, '..', `evolution-backup-v${version}`);
        if (existsSync(backupPath)) {
            rmSync(backupPath, { recursive: true, force: true });
        }
        cpSync(this.basePath, backupPath, { recursive: true });
        log.info(`Backup created: ${backupPath}`);
        return backupPath;
    }

    /** Restore from backup */
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
