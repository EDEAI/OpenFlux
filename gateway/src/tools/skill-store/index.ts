/**
 * Skill Store Tool
 * Agent 可调用的技能市场工具，对接腾讯 SkillHub
 * 支持: search / install / list / uninstall
 */

import type { Tool, ToolResult } from '../types';
import type { EvolutionDataManager } from '../../evolution/data-manager';
import { searchSkills, downloadSkillMd, getSkillInfo } from './skillhub-client';
import { parseSkillMd, checkDependencies, toOpenFluxSkill } from './parser';
import { Logger } from '../../utils/logger';

const log = new Logger('SkillStore');

export interface SkillStoreToolOptions {
    evolutionData: EvolutionDataManager;
    /** 技能安装后的回调（用于注入到 Agent skills） */
    onSkillInstalled?: (skill: { id: string; title: string; content: string }) => void;
    /** 技能卸载后的回调 */
    onSkillUninstalled?: (skillId: string) => void;
}

/**
 * 创建 skill_store 工具
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
    if (!slug) {
        return { success: false, error: '请提供技能标识 (slug)' };
    }

    // 检查是否已安装（完整 slug 或短 slug 匹配）
    const shortSlug = slug.includes('/') ? slug.split('/').pop()! : slug;
    const existing = evolutionData.listInstalledSkills();
    if (existing.some(s => s.slug === slug || s.slug === shortSlug)) {
        return { success: false, error: `技能 "${slug}" 已安装` };
    }

    // 下载 SKILL.md
    log.info(`Installing skill: ${slug}`);
    const content = await downloadSkillMd(slug);
    if (!content) {
        return { success: false, error: `无法下载技能 "${slug}"，请检查技能标识是否正确` };
    }

    // 解析
    const parsed = parseSkillMd(content);

    // 检查依赖
    const deps = checkDependencies(parsed);
    if (!deps.satisfied) {
        const missingInfo = [];
        if (deps.missing.env.length) missingInfo.push(`环境变量: ${deps.missing.env.join(', ')}`);
        if (deps.missing.bins.length) missingInfo.push(`工具: ${deps.missing.bins.join(', ')}`);
        return {
            success: false,
            error: `技能 "${slug}" 依赖未满足:\n${missingInfo.join('\n')}\n请先配置后重试`,
        };
    }

    // 保存
    const { createHash } = await import('crypto');
    const hash = createHash('sha256').update(content).digest('hex').substring(0, 16);

    evolutionData.saveInstalledSkill(slug, content, {
        slug,
        source: 'skillhub.tencent.com',
        version: '1.0.0',
        installedAt: new Date().toISOString(),
        hash,
    });

    // 通知系统注入技能
    const openFluxSkill = toOpenFluxSkill(parsed);
    onInstalled?.(openFluxSkill);

    log.info(`Skill installed: ${slug} (${parsed.title})`);
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
        `${i + 1}. **${s.slug}** — 来源: ${s.source}, 安装时间: ${s.installedAt}`
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
    if (!slug) {
        return { success: false, error: '请提供技能标识 (slug)' };
    }

    const removed = evolutionData.removeInstalledSkill(slug);
    if (!removed) {
        return { success: false, error: `技能 "${slug}" 未安装` };
    }

    onUninstalled?.(`skillhub:${slug}`);

    log.info(`Skill uninstalled: ${slug}`);
    return {
        success: true,
        data: { message: `✅ 技能「${slug}」已卸载` },
    };
}

async function handleInfo(slug: string, evolutionData: EvolutionDataManager): Promise<ToolResult> {
    if (!slug) {
        return { success: false, error: '请提供技能标识 (slug)' };
    }

    // 提取短 slug（最后一段），用于兜底匹配
    const shortSlug = slug.includes('/') ? slug.split('/').pop()! : slug;

    // 检查本地是否已安装（完整 slug 或短 slug 匹配）
    let localContent = evolutionData.readSkillContent(slug);
    if (!localContent && shortSlug !== slug) {
        localContent = evolutionData.readSkillContent(shortSlug);
    }

    if (localContent) {
        const parsed = parseSkillMd(localContent);
        return {
            success: true,
            data: {
                message: `技能「${parsed.title}」(${slug})\n\n${parsed.content.substring(0, 500)}...`,
                installed: true,
                skill: parsed,
            },
        };
    }

    // 从远程搜索（不触发安装）
    const info = await getSkillInfo(shortSlug);
    if (!info) {
        return { success: false, error: `找不到技能 "${slug}"` };
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
