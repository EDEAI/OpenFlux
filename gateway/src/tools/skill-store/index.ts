/**
 * Skill Store Tool
 * A skill market tool that can be called by Agent and connected to Tencent SkillHub
 * Support: search / install / list / uninstall
 */

import type { Tool, ToolResult } from '../types';
import type { EvolutionDataManager, InstalledSkillMeta } from '../../evolution/data-manager';
import { installedSkillMatches, normalizeSkillIdentifier, toSkillRuntimeId, toSkillStorageSlug } from '../../evolution/data-manager';
import { searchSkills, downloadSkillMd, getSkillInfo } from './skillhub-client';
import { parseSkillMd, checkDependencies, toOpenFluxSkill } from './parser';
import { Logger } from '../../utils/logger';

const log = new Logger('SkillStore');

export interface SkillStoreToolOptions {
    evolutionData: EvolutionDataManager;
    /** Callback after skill installation (for injection into Agent skills) */
    onSkillInstalled?: (skill: { id: string; title: string; content: string }) => void;
    /** Callback after skill uninstallation */
    onSkillUninstalled?: (skillId: string) => void;
}

/**
 * Create skill_store tool
 */
export function createSkillStoreTool(options: SkillStoreToolOptions): Tool {
    const { evolutionData, onSkillInstalled, onSkillUninstalled } = options;

    return {
        name: 'skill_store',
        description: '技能市场：从腾讯 SkillHub 搜索、安装、管理技能。安装后的技能会自动增强你的能力。',
        parameters: {
            action: {
                type: 'string',
                description: '操作类型',
                required: true,
                enum: ['search', 'install', 'list', 'uninstall', 'info'],
            },
            keyword: {
                type: 'string',
                description: '搜索关键词（action=search 时必填）',
            },
            slug: {
                type: 'string',
                description: '技能标识（action=install/uninstall/info 时必填）',
            },
        },
        execute: async (args): Promise<ToolResult> => {
            const action = args.action as string;

            switch (action) {
                case 'search':
                    return await handleSearch(args.keyword as string);
                case 'install':
                    return await handleInstall(args.slug as string, evolutionData, onSkillInstalled);
                case 'list':
                    return handleList(evolutionData);
                case 'uninstall':
                    return handleUninstall(args.slug as string, evolutionData, onSkillUninstalled);
                case 'info':
                    return await handleInfo(args.slug as string, evolutionData);
                default:
                    return { success: false, error: `未知操作: ${action}` };
            }
        },
    };
}

// ========================
// Action Handlers
// ========================

async function handleSearch(keyword: string): Promise<ToolResult> {
    if (!keyword) {
        return { success: false, error: '请提供搜索关键词' };
    }

    const results = await searchSkills(keyword);
    if (results.length === 0) {
        return { success: true, data: { message: `没有找到与"${keyword}"相关的技能`, results: [] } };
    }

    const formatted = results.map((r, i) => `${i + 1}. **${r.name}** (\`${r.slug}\`)\n   ${r.description}`).join('\n');

    return {
        success: true,
        data: {
            message: `找到 ${results.length} 个相关技能：\n${formatted}\n\n使用 skill_store(action="install", slug="技能标识") 安装`,
            results,
            count: results.length,
        },
    };
}

async function handleInstall(
    slug: string,
    evolutionData: EvolutionDataManager,
    onInstalled?: (skill: { id: string; title: string; content: string }) => void,
): Promise<ToolResult> {
    const remoteSlug = normalizeSkillIdentifier(slug);
    if (!remoteSlug) {
        return { success: false, error: '请提供技能标识 (slug)' };
    }

    // Check if it is installed (full ID, local security directory name, old short slug are all compatible)
    const storageSlug = toSkillStorageSlug(remoteSlug);
    const existing = evolutionData.listInstalledSkills();
    if (existing.some(s => installedSkillMatches(s, remoteSlug) || s.storageSlug === storageSlug)) {
        return { success: false, error: `技能 "${remoteSlug}" 已安装` };
    }

    // Download SKILL.md
    log.info(`Installing skill: ${remoteSlug}`);
    const content = await downloadSkillMd(remoteSlug);
    if (!content) {
        return { success: false, error: `无法下载技能 "${remoteSlug}"，请检查技能标识是否正确` };
    }

    // parse
    const parsed = parseSkillMd(content);

    // Check dependencies
    const deps = checkDependencies(parsed);
    if (!deps.satisfied) {
        const missingInfo = [];
        if (deps.missing.env.length) missingInfo.push(`环境变量: ${deps.missing.env.join(', ')}`);
        if (deps.missing.bins.length) missingInfo.push(`工具: ${deps.missing.bins.join(', ')}`);
        return {
            success: false,
            error: `技能 "${remoteSlug}" 依赖未满足:\n${missingInfo.join('\n')}\n请先配置后重试`,
        };
    }

    // save
    const { createHash } = await import('crypto');
    const hash = createHash('sha256').update(content).digest('hex').substring(0, 16);
    const runtimeSkillId = toSkillRuntimeId(storageSlug);

    evolutionData.saveInstalledSkill(storageSlug, content, {
        slug: remoteSlug,
        remoteSlug,
        storageSlug,
        runtimeSkillId,
        source: 'skillhub.cn',
        version: '1.0.0',
        installedAt: new Date().toISOString(),
        hash,
    });

    // Notification system injection skills
    const openFluxSkill = toOpenFluxSkill(parsed, runtimeSkillId);
    onInstalled?.(openFluxSkill);

    log.info(`Skill installed: ${remoteSlug} (${parsed.title})`);
    return {
        success: true,
        data: {
            message: `✅ Skill "${parsed.title}" installed and activated.\n` +
                `The skill instructions are now part of your system prompt under "Installed Skills".\n` +
                `To use this skill: follow the instructions in your system prompt directly — do NOT call tool_forge to execute it.`,
            skill: { id: openFluxSkill.id, title: openFluxSkill.title },
        },
    };
}

function handleList(evolutionData: EvolutionDataManager): ToolResult {
    const skills = evolutionData.listInstalledSkills();

    if (skills.length === 0) {
        return {
            success: true,
            data: { message: '尚未安装任何技能。使用 skill_store(action="search", keyword="关键词") 搜索技能。', skills: [] },
        };
    }

    const formatted = skills.map((s, i) =>
        `${i + 1}. **${getSkillDisplaySlug(s)}** — 来源: ${s.source}, 安装时间: ${s.installedAt}`
    ).join('\n');

    return {
        success: true,
        data: {
            message: `已安装 ${skills.length} 个技能：\n${formatted}`,
            skills,
            count: skills.length,
        },
    };
}

function handleUninstall(
    slug: string,
    evolutionData: EvolutionDataManager,
    onUninstalled?: (skillId: string) => void,
): ToolResult {
    const identifier = normalizeSkillIdentifier(slug);
    if (!identifier) {
        return { success: false, error: '请提供技能标识 (slug)' };
    }

    const localMeta = findInstalledSkill(evolutionData, identifier);
    const runtimeSkillId = getRuntimeSkillId(localMeta, identifier);
    const removed = evolutionData.removeInstalledSkill(identifier);
    if (!removed) {
        return { success: false, error: `技能 "${identifier}" 未安装` };
    }

    onUninstalled?.(runtimeSkillId);

    log.info(`Skill uninstalled: ${identifier}`);
    return {
        success: true,
        data: { message: `✅ 技能「${identifier}」已卸载` },
    };
}

async function handleInfo(slug: string, evolutionData: EvolutionDataManager): Promise<ToolResult> {
    const identifier = normalizeSkillIdentifier(slug);
    if (!identifier) {
        return { success: false, error: '请提供技能标识 (slug)' };
    }

    // Extract short slug (last paragraph) for back-to-back matching
    const shortSlug = identifier.includes('/') ? identifier.split('/').pop()! : identifier;

    // Check whether it has been installed locally (full ID, local security directory name, old short slug are all compatible)
    const localMeta = findInstalledSkill(evolutionData, identifier) || findInstalledSkill(evolutionData, shortSlug);
    const localContent = localMeta
        ? evolutionData.readSkillContent(localMeta.storageSlug || localMeta.slug)
        : evolutionData.readSkillContent(identifier) || evolutionData.readSkillContent(shortSlug);

    if (localContent) {
        const parsed = parseSkillMd(localContent);
        const displaySlug = localMeta ? getSkillDisplaySlug(localMeta) : identifier;
        return {
            success: true,
            data: {
                message: `技能「${parsed.title}」(${displaySlug})\n\n${parsed.content.substring(0, 500)}...`,
                installed: true,
                skill: parsed,
            },
        };
    }

    // Search from remote (does not trigger installation)
    const info = await getSkillInfo(shortSlug);
    if (!info) {
        return { success: false, error: `找不到技能 "${identifier}"` };
    }

    return {
        success: true,
        data: {
            message: `技能「${info.name}」(\`${info.slug}\`)\n${info.description}\n\n使用 skill_store(action="install", slug="${info.slug}") 安装`,
            installed: false,
            skill: info,
        },
    };
}

function findInstalledSkill(evolutionData: EvolutionDataManager, identifier: string): InstalledSkillMeta | null {
    return evolutionData.listInstalledSkills().find(skill => installedSkillMatches(skill, identifier)) || null;
}

function getSkillDisplaySlug(skill: InstalledSkillMeta): string {
    return skill.remoteSlug || skill.slug;
}

function getRuntimeSkillId(skill: InstalledSkillMeta | null, fallbackIdentifier: string): string {
    return skill?.runtimeSkillId
        || toSkillRuntimeId(skill?.storageSlug || skill?.remoteSlug || skill?.slug || fallbackIdentifier);
}
